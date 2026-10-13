-- 0071_mrp_reconciliation — MRP et planification des besoins : stock utilisable, réservations rattachées aux commandes,
-- conversions d'unité et lignes restreintes, réconciliation des besoins, explication des calculs, propositions d'OF.
--
-- Existant conservé (0010, 0009, 0063, 0069, 0070) :
--   * Moteur mrp_run (0010) : besoins depuis commandes confirmées et prévisions, stock de sécurité, réceptions planifiées,
--     MOQ, multiple de commande, délai (matière, fournisseur, défaut), suggestions d'achat, décisions, simulations figées,
--     suppression, audit, droits mrp.read / mrp.write. Ses appelants et ses colonnes restent inchangés.
--   * Explosion des nomenclatures (private.mrp_unit_requirements, private.mrp_article_issue) : redéfinie avec la conversion
--     d'unité de P044 (bom_line_attributes, bom_unit_conversions) et l'exclusion explicite des lignes restreintes.
--   * Quarantaine (0063 : emplacements de type « quarantine ») et réservations (0009 : stock_reservations).
--   * Gamme (0070) et figure des OF (0069) : non utilisées ici ; le MRP ne lance rien.
--
-- Règles :
--  * Stock utilisable = lots hors emplacement de quarantaine et non périmés (expiry_date >= date de calcul).
--    Le stock bloqué et périmé est affiché séparément (quarantine_excluded, expired_excluded) : il n'est jamais compté.
--  * Liaison réservation ↔ ligne : action de stock (droit stock.write et rôle sur l'entrepôt de la réservation, garde 0017).
--  * Réservations : une réservation non rattachée à une ligne de commande réduit le disponible (comme avant).
--    Une réservation rattachée à une ligne de commande confirmée (stock_reservations.sales_order_line_id) couvre ce besoin :
--    elle est comptée une seule fois (covered_qty) au lieu de réduire le disponible deux fois.
--  * Réconciliation : pour chaque composant, le besoin brut égale la somme des besoins datés ; les suggestions égalent la
--    somme des propositions ; lots = utilisable + quarantaine + périmé ; solde final = utilisable − réservé + couvert
--    + réceptions − besoin brut + proposé. Le résultat est stocké dans le résumé de la simulation (summary.reconciled).
--  * Explication : chaque proposition d'achat (mrp_run_suggestions.explanation) et chaque composant donne les éléments du calcul.
--  * Propositions d'OF : une par article demandé et par date de besoin (mrp_run_production_suggestions), seulement pour un
--    article à nomenclature exploitable. Le stock de produits finis n'est pas modélisé dans le dépôt : il n'est pas déduit
--    (explanation.finished_stock_netted = false).
--  * Aucune commande : une simulation et une décision ne créent ni commande d'achat, ni ordre de fabrication.
--  * Lignes restreintes (taille ou coloris) : non comptées dans le besoin de la simulation (aucune taille ni coloris n'est
--    fourni au MRP) ; l'article est signalé avec l'issue « restricted_lines ».
--  * Conversion absente : la ligne est comptée pour 0 et l'article est signalé « unit_conversion_missing » (aucune conversion inventée).
-- Erreurs : MRP_NOT_FOUND, MRP_RESERVATION_NOT_ACTIVE, MRP_LINE_NOT_CONFIRMED, MRP_MATERIAL_NOT_IN_LINE, MRP_BAD_STATUS.

-- ---------------------------------------------------------------------------
-- 1. Colonnes et tables additives
-- ---------------------------------------------------------------------------
alter table public.stock_reservations
  add column if not exists sales_order_line_id uuid references public.sales_order_lines(id) on delete set null;
create index if not exists stock_reservations_line_idx on public.stock_reservations (sales_order_line_id) where sales_order_line_id is not null;

alter table public.mrp_run_materials
  add column if not exists total_lots          numeric(16,4) not null default 0,
  add column if not exists quarantine_excluded numeric(16,4) not null default 0,
  add column if not exists expired_excluded    numeric(16,4) not null default 0,
  add column if not exists covered_qty         numeric(16,4) not null default 0,
  add column if not exists projected_end       numeric(16,4) not null default 0;

alter table public.mrp_run_pegging
  add column if not exists covered_qty numeric(16,4) not null default 0;

alter table public.mrp_run_suggestions
  add column if not exists explanation jsonb not null default '{}'::jsonb;

create table public.mrp_run_production_suggestions (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.mrp_runs(id) on delete cascade,
  company_id   uuid not null references public.companies(id),
  article_id   uuid not null references public.articles(id) on delete cascade,
  qty          numeric(16,2) not null check (qty > 0),
  need_date    date not null,
  release_date date not null,
  explanation  jsonb not null default '{}'::jsonb,
  status       text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  note         text check (note is null or length(note) <= 300),
  decided_by   uuid,
  decided_at   timestamptz
);
create index mrp_run_production_suggestions_idx on public.mrp_run_production_suggestions (run_id, need_date);

alter table public.mrp_run_production_suggestions enable row level security;
create policy mrp_run_production_suggestions_select on public.mrp_run_production_suggestions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('mrp.read'));
revoke all on public.mrp_run_production_suggestions from anon, authenticated;
grant select on public.mrp_run_production_suggestions to authenticated;
grant all on public.mrp_run_production_suggestions to service_role;

-- ---------------------------------------------------------------------------
-- 2. Explosion des nomenclatures : conversion d'unité, lignes restreintes exclues, issues signalées
-- ---------------------------------------------------------------------------
create or replace function private.mrp_unit_requirements(p_article uuid)
returns table (material_id uuid, qty numeric)
language sql stable security definer set search_path = '' as $$
  with recursive t(version_id, mult, depth) as (
    select b.active_version_id, 1::numeric, 0
    from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
    union all
    select cb.active_version_id, t.mult * l.quantity, t.depth + 1
    from t
    join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null
    where t.depth < 8
  )
  select l.material_id,
         sum(t.mult * l.quantity * (1 + l.waste_pct / 100) * coalesce(private.bom_unit_factor(l.material_id, coalesce(a.unit, m.unit)), 0))
  from t
  join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'material'
  join public.bom_materials m on m.id = l.material_id
  left join public.bom_line_attributes a on a.line_id = l.id
  where a.size_code is null and a.color_name is null
  group by l.material_id
$$;
revoke execute on function private.mrp_unit_requirements(uuid) from public, anon, authenticated;

create or replace function private.mrp_article_issue(p_article uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null) then return 'no_bom'; end if;
  if exists (
    with recursive t(version_id, depth) as (
      select b.active_version_id, 0 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
      union all
      select cb.active_version_id, t.depth + 1 from t
      join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
      join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null where t.depth < 8)
    select 1 from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id where cb.archived_at is not null or cb.active_version_id is null
  ) then return 'incomplete'; end if;
  if exists (
    with recursive t(version_id, depth) as (
      select b.active_version_id, 0 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
      union all
      select cb.active_version_id, t.depth + 1 from t
      join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
      join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null where t.depth < 8)
    select 1 from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'material'
    join public.bom_line_attributes a on a.line_id = l.id
    where a.unit is not null and private.bom_unit_factor(l.material_id, a.unit) is null
  ) then return 'unit_conversion_missing'; end if;
  if exists (
    with recursive t(version_id, depth) as (
      select b.active_version_id, 0 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
      union all
      select cb.active_version_id, t.depth + 1 from t
      join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
      join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null where t.depth < 8)
    select 1 from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'material'
    join public.bom_line_attributes a on a.line_id = l.id
    where a.size_code is not null or a.color_name is not null
  ) then return 'restricted_lines'; end if;
  return null;
end $$;
revoke execute on function private.mrp_article_issue(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Réconciliation d'une simulation (retourne les écarts ; tableau vide = réconcilié)
-- ---------------------------------------------------------------------------
create function private.mrp_reconcile(p_run uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('material_id', x.material_id, 'issue', x.issue) order by x.material_id), '[]'::jsonb)
  from (
    select mm.material_id,
      case
        when mm.gross is distinct from coalesce(pg.gross, 0) then 'GROSS_NOT_RECONCILED'
        when mm.suggested is distinct from coalesce(sg.qty, 0) then 'SUGGESTED_NOT_RECONCILED'
        when mm.total_lots is distinct from mm.on_hand + mm.quarantine_excluded + mm.expired_excluded then 'STOCK_NOT_RECONCILED'
        when abs(mm.projected_end - (mm.on_hand - mm.reserved + mm.covered_qty + mm.receipts - mm.gross + mm.suggested)) > 0.0005 then 'BALANCE_NOT_RECONCILED'
        when mm.suggested < mm.net then 'SUGGESTION_BELOW_NET'
      end as issue
    from public.mrp_run_materials mm
    left join (select material_id, sum(qty) gross from public.mrp_run_pegging where run_id = p_run group by material_id) pg on pg.material_id = mm.material_id
    left join (select material_id, sum(qty) qty from public.mrp_run_suggestions where run_id = p_run group by material_id) sg on sg.material_id = mm.material_id
    where mm.run_id = p_run
  ) x
  where x.issue is not null
$$;
revoke execute on function private.mrp_reconcile(uuid) from public, anon, authenticated;

create function public.mrp_run_reconcile(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_issues jsonb;
begin
  perform private.require_perm('mrp.read');
  if not exists (select 1 from public.mrp_runs where id = p_run and company_id = v_co) then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
  v_issues := private.mrp_reconcile(p_run);
  return jsonb_build_object('run', p_run, 'ok', jsonb_array_length(v_issues) = 0, 'issues', v_issues);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Liaison d'une réservation à une ligne de commande confirmée
-- ---------------------------------------------------------------------------
create function public.stock_reservation_link_order_line(p_reservation uuid, p_line uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.stock_reservations%rowtype; v_article uuid; v_status text;
begin
  perform private.require_perm('stock.write');
  select * into r from public.stock_reservations where id = p_reservation and company_id = v_co for update;
  if not found then raise exception 'STOCK_RESERVATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'active' then raise exception 'MRP_RESERVATION_NOT_ACTIVE' using errcode = '55000'; end if;
  if p_line is not null then
    select l.article_id, o.status into v_article, v_status
      from public.sales_order_lines l join public.sales_orders o on o.id = l.order_id
      where l.id = p_line and l.company_id = v_co;
    if not found then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_status <> 'confirmed' then raise exception 'MRP_LINE_NOT_CONFIRMED' using errcode = '55000'; end if;
    if not exists (select 1 from private.mrp_unit_requirements(v_article) u where u.material_id = r.material_id and u.qty > 0) then
      raise exception 'MRP_MATERIAL_NOT_IN_LINE' using errcode = '22023';
    end if;
  end if;
  update public.stock_reservations set sales_order_line_id = p_line where id = p_reservation;
  perform private.write_audit(v_co, case when p_line is null then 'mrp.reservation_unlink' else 'mrp.reservation_link' end,
    'stock_reservation', p_reservation::text, r.reference, jsonb_build_object('sales_order_line_id', r.sales_order_line_id),
    jsonb_build_object('sales_order_line_id', p_line), jsonb_build_object('material_id', r.material_id, 'qty', r.qty), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Décision sur une proposition d'OF (aucun ordre de fabrication n'est créé)
-- ---------------------------------------------------------------------------
create function public.mrp_production_suggestion_decide(p_suggestion uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.mrp_run_production_suggestions%rowtype; v_code text;
begin
  perform private.require_perm('mrp.write');
  if p_status not in ('proposed', 'accepted', 'rejected') then raise exception 'MRP_BAD_STATUS' using errcode = '22023'; end if;
  select * into s from public.mrp_run_production_suggestions where id = p_suggestion and company_id = private.current_company() for update;
  if not found then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.mrp_run_production_suggestions set status = p_status, note = nullif(btrim(coalesce(p_note, '')), ''),
         decided_by = case when p_status = 'proposed' then null else auth.uid() end,
         decided_at = case when p_status = 'proposed' then null else now() end
  where id = p_suggestion;
  select code into v_code from public.mrp_runs where id = s.run_id;
  perform private.write_audit(s.company_id, 'mrp.decide_production', 'mrp', s.run_id::text, v_code, jsonb_build_object('status', s.status),
    jsonb_build_object('status', p_status), jsonb_build_object('article_id', s.article_id, 'qty', s.qty, 'note', p_note), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Moteur MRP (redéfini) : mêmes paramètres, mêmes sorties, stock utilisable, réservations couvertes, explications
-- ---------------------------------------------------------------------------
create or replace function public.mrp_run(p_name text default null, p_params jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_run uuid := gen_random_uuid();
  v_horizon int := least(greatest(coalesce((p_params ->> 'horizon_days')::int, 90), 7), 365);
  v_offset int := least(greatest(coalesce((p_params ->> 'offset_days')::int, 7), 0), 120);
  v_fc boolean := coalesce((p_params ->> 'include_forecasts')::boolean, true);
  v_draft boolean := coalesce((p_params ->> 'include_draft_orders')::boolean, false);
  v_safety boolean := coalesce((p_params ->> 'use_safety')::boolean, true);
  v_deflead int := least(greatest(coalesce((p_params ->> 'default_lead_days')::int, 14), 0), 365);
  v_asof date := current_date; v_end date; v_code text; v_name text;
  m record; ev record; prm public.mrp_params%rowtype;
  v_onhand numeric; v_qblock numeric; v_expired numeric; v_lots numeric; v_res numeric; v_cov numeric; v_safe numeric;
  v_lead int; v_moq numeric; v_mult numeric; v_sup uuid;
  v_gross numeric; v_rec numeric; v_net numeric; v_sugg numeric; v_first date; v_short date;
  v_proj numeric; v_before numeric; v_raw numeric; v_g numeric; v_r numeric; v_plan numeric; v_need numeric; v_tl jsonb; v_alert text; v_late int := 0; v_nsug int := 0;
  v_crit int := 0; v_high int := 0; v_low int := 0; v_warn jsonb; v_n_orders int; v_n_fc int; v_nprod int := 0; v_issues jsonb;
begin
  perform private.require_perm('mrp.write');
  v_end := v_asof + v_horizon;
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Simulation du ' || to_char(now(), 'DD/MM/YYYY HH24:MI'));
  if length(v_name) > 160 then v_name := left(v_name, 160); end if;
  v_code := 'MRP-' || lpad(private.next_seq(v_co, 'mrp_run')::text, 4, '0');

  drop table if exists _mrp_d; drop table if exists _mrp_u;
  create temp table _mrp_d (source_type text, source_id uuid, article_id uuid, qty numeric, need date) on commit drop;
  -- demande : commandes client confirmées (+ brouillons si demandé) puis prévisions
  insert into _mrp_d
  select 'order', l.id, l.article_id, l.qty, greatest(l.due_date - v_offset, v_asof)
  from public.sales_order_lines l join public.sales_orders o on o.id = l.order_id
  where o.company_id = v_co and (o.status = 'confirmed' or (v_draft and o.status = 'draft')) and l.due_date - v_offset <= v_end;
  get diagnostics v_n_orders = row_count;
  if v_fc then
    insert into _mrp_d select 'forecast', f.id, f.article_id, f.qty, greatest(f.forecast_date - v_offset, v_asof)
    from public.mrp_forecasts f where f.company_id = v_co and f.forecast_date - v_offset <= v_end;
    get diagnostics v_n_fc = row_count;
  else v_n_fc := 0; end if;

  create temp table _mrp_u (article_id uuid, material_id uuid, qty numeric) on commit drop;
  insert into _mrp_u select a.article_id, u.material_id, u.qty from (select distinct article_id from _mrp_d) a, lateral private.mrp_unit_requirements(a.article_id) u;

  -- articles de la demande sans nomenclature exploitable (ou à signaler : conversion absente, lignes restreintes)
  select coalesce(jsonb_agg(jsonb_build_object('article_id', x.article_id, 'ref', a.internal_ref, 'name', a.name, 'issue', x.issue, 'qty', x.qty) order by a.internal_ref), '[]'::jsonb) into v_warn
  from (select article_id, private.mrp_article_issue(article_id) issue, sum(qty) qty from _mrp_d group by article_id) x
  join public.articles a on a.id = x.article_id where x.issue is not null;

  insert into public.mrp_runs (id, company_id, code, name, as_of, params, created_by)
  values (v_run, v_co, v_code, v_name, v_asof, jsonb_build_object('horizon_days', v_horizon, 'offset_days', v_offset, 'include_forecasts', v_fc,
         'include_draft_orders', v_draft, 'use_safety', v_safety, 'default_lead_days', v_deflead), auth.uid());

  -- besoins datés par composant ; une réservation rattachée à la ligne couvre au plus le besoin de cette ligne
  insert into public.mrp_run_pegging (run_id, company_id, material_id, need_date, source_type, source_id, article_id, demand_qty, qty, covered_qty)
  select v_run, v_co, u.material_id, d.need, d.source_type, d.source_id, d.article_id, d.qty, d.qty * u.qty,
    case when d.source_type = 'order' then least(d.qty * u.qty, coalesce((
           select sum(r.qty - r.qty_consumed) from public.stock_reservations r
           where r.sales_order_line_id = d.source_id and r.material_id = u.material_id and r.company_id = v_co and r.status = 'active'), 0))
         else 0 end
  from _mrp_d d join _mrp_u u on u.article_id = d.article_id;

  for m in
    select material_id from public.mrp_run_pegging where run_id = v_run
    union select t.material_id from public.stock_thresholds t where v_safety and t.company_id = v_co and t.safety_qty > 0
  loop
    -- stock : lots hors quarantaine et non périmés = utilisable ; le reste est affiché à part
    select coalesce(sum(sl.qty_remaining) filter (where loc.kind <> 'quarantine' and (sl.expiry_date is null or sl.expiry_date >= v_asof)), 0),
           coalesce(sum(sl.qty_remaining) filter (where loc.kind = 'quarantine'), 0),
           coalesce(sum(sl.qty_remaining) filter (where loc.kind <> 'quarantine' and sl.expiry_date < v_asof), 0),
           coalesce(sum(sl.qty_remaining), 0)
      into v_onhand, v_qblock, v_expired, v_lots
      from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
      where sl.material_id = m.material_id and sl.company_id = v_co;
    select coalesce(sum(qty - qty_consumed), 0) into v_res from public.stock_reservations where material_id = m.material_id and company_id = v_co and status = 'active';
    select coalesce(sum(covered_qty), 0) into v_cov from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id;
    select case when v_safety then coalesce(sum(safety_qty), 0) else 0 end into v_safe from public.stock_thresholds where material_id = m.material_id and company_id = v_co;
    select * into prm from public.mrp_params where material_id = m.material_id;
    select supplier_id into v_sup from public.bom_materials where id = m.material_id;
    v_lead := coalesce(prm.lead_time_days, (select lead_time_days from public.suppliers where id = v_sup), v_deflead);
    v_moq := coalesce(prm.moq, 0); v_mult := coalesce(prm.order_multiple, 0);

    v_gross := 0; v_rec := 0; v_net := 0; v_sugg := 0; v_first := null; v_short := null; v_tl := '[]'::jsonb;
    -- départ : utilisable − réservé + couvert par les réservations rattachées (la demande couverte reste au besoin brut)
    v_proj := v_onhand - v_res + v_cov; v_raw := v_proj;

    for ev in
      select dt from (
        select v_asof dt
        union select need_date from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id and need_date <= v_end
        union select greatest(due_date, v_asof) from public.mrp_scheduled_receipts where material_id = m.material_id and company_id = v_co and greatest(due_date, v_asof) <= v_end
      ) x order by dt
    loop
      select coalesce(sum(qty), 0) into v_g from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id and need_date = ev.dt;
      select coalesce(sum(qty), 0) into v_r from public.mrp_scheduled_receipts where material_id = m.material_id and company_id = v_co and greatest(due_date, v_asof) = ev.dt;
      v_gross := v_gross + v_g; v_rec := v_rec + v_r;
      if v_g > 0 and v_first is null then v_first := ev.dt; end if;
      v_proj := v_proj + v_r - v_g; v_raw := v_raw + v_r - v_g;
      if v_raw < 0 and v_short is null then v_short := ev.dt; end if;
      v_plan := 0;
      if v_proj < v_safe then
        v_before := v_proj;
        v_need := v_safe - v_proj; v_net := v_net + v_need; v_plan := v_need;
        if v_moq > 0 then v_plan := greatest(v_plan, v_moq); end if;
        if v_mult > 0 then v_plan := ceil(v_plan / v_mult) * v_mult; end if;
        v_proj := v_proj + v_plan; v_sugg := v_sugg + v_plan;
        insert into public.mrp_run_suggestions (run_id, company_id, material_id, supplier_id, qty, need_date, release_date, late, explanation)
        values (v_run, v_co, m.material_id, v_sup, v_plan, ev.dt, ev.dt - v_lead, ev.dt - v_lead < v_asof,
          jsonb_build_object(
            'stock_usable', v_onhand, 'reserved_active', v_res, 'covered_by_order_lines', v_cov,
            'quarantine_excluded', v_qblock, 'expired_excluded', v_expired,
            'receipts_to_date', v_rec, 'demand_to_date', v_gross, 'projected_before_order', v_before,
            'safety_stock', v_safe, 'shortfall', v_need, 'moq', v_moq, 'order_multiple', v_mult,
            'proposed_qty', v_plan, 'lead_days', v_lead, 'need_date', ev.dt, 'release_date', ev.dt - v_lead,
            'basis', 'Proposition uniquement : aucune commande d''achat n''est créée'));
        v_nsug := v_nsug + 1; if ev.dt - v_lead < v_asof then v_late := v_late + 1; end if;
      end if;
      v_tl := v_tl || jsonb_build_object('date', ev.dt, 'gross', v_g, 'receipts', v_r, 'planned', v_plan, 'projected', v_proj);
    end loop;

    v_alert := case when v_short is not null and v_short - v_lead < v_asof then 'critical' when v_short is not null then 'high' when v_sugg > 0 then 'low' end;
    if v_alert = 'critical' then v_crit := v_crit + 1; elsif v_alert = 'high' then v_high := v_high + 1; elsif v_alert = 'low' then v_low := v_low + 1; end if;
    insert into public.mrp_run_materials (run_id, material_id, company_id, gross, on_hand, reserved, safety, receipts, net, suggested, lead_time_days, moq, order_multiple,
                                          supplier_id, first_need_date, shortage_date, alert, timeline, total_lots, quarantine_excluded, expired_excluded, covered_qty, projected_end)
    values (v_run, m.material_id, v_co, v_gross, v_onhand, v_res, v_safe, v_rec, v_net, v_sugg, v_lead, v_moq, v_mult, v_sup, v_first, v_short, v_alert, v_tl,
            v_lots, v_qblock, v_expired, v_cov, v_proj);
  end loop;

  -- propositions d'OF : une par article et par date de besoin, pour un article à nomenclature exploitable
  insert into public.mrp_run_production_suggestions (run_id, company_id, article_id, qty, need_date, release_date, explanation)
  select v_run, v_co, x.article_id, x.qty, x.need, x.need,
    jsonb_build_object('order_lines', x.n_orders, 'forecast_lines', x.n_fc, 'demand_qty', x.qty,
      'finished_stock_netted', false, 'offset_days', v_offset,
      'basis', 'Proposition uniquement : aucun ordre de fabrication n''est lancé ; stock de produits finis non déduit (non modélisé)')
  from (
    select d.article_id, d.need, sum(d.qty) qty, count(*) filter (where d.source_type = 'order') n_orders, count(*) filter (where d.source_type = 'forecast') n_fc
    from _mrp_d d where private.mrp_article_issue(d.article_id) is null
    group by d.article_id, d.need
  ) x;
  get diagnostics v_nprod = row_count;

  v_issues := private.mrp_reconcile(v_run);
  update public.mrp_runs set summary = jsonb_build_object(
      'materials', (select count(*) from public.mrp_run_materials where run_id = v_run),
      'critical', v_crit, 'high', v_high, 'low', v_low, 'suggestions', v_nsug, 'late_suggestions', v_late,
      'production_suggestions', v_nprod,
      'orders_lines', v_n_orders, 'forecast_lines', v_n_fc, 'warnings', v_warn,
      'reconciled', jsonb_array_length(v_issues) = 0, 'reconciliation_issues', v_issues)
  where id = v_run;
  perform private.write_audit(v_co, 'mrp.run', 'mrp', v_run::text, v_code, null, null,
    jsonb_build_object('name', v_name, 'critical', v_crit, 'high', v_high, 'suggestions', v_nsug, 'production_suggestions', v_nprod,
      'reconciled', jsonb_array_length(v_issues) = 0), 'rpc');
  return v_run;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privilèges
-- ---------------------------------------------------------------------------
revoke execute on function public.mrp_run_reconcile(uuid), public.stock_reservation_link_order_line(uuid, uuid),
  public.mrp_production_suggestion_decide(uuid, text, text) from public, anon;
grant execute on function public.mrp_run_reconcile(uuid), public.stock_reservation_link_order_line(uuid, uuid),
  public.mrp_production_suggestion_decide(uuid, text, text) to authenticated, service_role;
