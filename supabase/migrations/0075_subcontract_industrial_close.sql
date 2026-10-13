-- 0075_subcontract_industrial_close — Sous-traitance et clôture industrielle : commandes de sous-traitance rattachées à un OF,
-- prix convenu, matières externes suivies (propres confiées ou propriétaires du client), réconciliation coûts standard / réel
-- de l'OF, revue des écarts significatifs, clôture refusée si incohérente.
--
-- Existant conservé et réutilisé :
--   * Sous-traitance (0016) : sous-traitants, commandes (SC-), envois, réceptions, contrôle qualité (accepté / rejeté),
--     entrée en stock des pièces acceptées, coûts de prestation (subcontract_costs), clôture de commande. Inchangés.
--   * OF (0019, 0073, 0074) : production_orders, journal, totaux par opération (production_order_totals), produits finis
--     (finished_lots origine « receipt » liés à l'OF, 0073), matelas consommés (production_cut_plans, 0073).
--   * Nomenclature figée (0069 : production_order_bom, lignes avec prix matière bom_material_prices) et taux horaire
--     (bom_version_costs.hourly_rate, 0008).
--   * Lots matière avec coût (stock_lot_costs, 0009) et allocations (stock_movement_allocations) ; sorties / entrées de stock
--     par private.stock_apply (0011) avec ses gardes (quarantaine, entrepôt, réservations).
--
-- Règles :
--  * Une commande de sous-traitance peut être rattachée à un OF (production_order_id) et porter un prix convenu (unit_price).
--  * Matières externes : un registre en ajout seul par commande de sous-traitance et par matière, avec propriétaire
--    (la société, ou un client pour une matière propriétaire). Envoi : une matière de la société sort du stock (sortie
--    standard) ; une matière du client ne fait l'objet d'aucun mouvement de stock de la société. Retour : une matière de la société
--    rentre en stock au coût moyen d'envoi. Consommation / rebut : le solde ne peut jamais être négatif (SC_MATERIAL_INSUFFICIENT).
--  * Coût standard de l'OF : matière = Σ(quantité OF × multiplicateur × quantité × conversion × (1 + perte) × prix unitaire),
--    main-d'œuvre = quantité × temps standard / 60 × taux horaire, sous-traitance = Σ(quantité commandée × prix convenu).
--  * Coût réel : matière = matelas consommés (coût des lots) + matières de la société consommées chez le sous-traitant
--    (au coût moyen d'envoi) ; main-d'œuvre = minutes déclarées (productif + retouche) / 60 × taux horaire ;
--    sous-traitance = coûts de prestation saisis. Chaque composant renvoie sa formule et ses éléments.
--  * Écart significatif : |réel − standard| > seuil (% du standard), ou standard nul et réel non nul. Le seuil est fourni
--    par l'utilisateur à chaque réconciliation (aucun seuil n'est inventé) ; sans seuil, la réconciliation est refusée.
--  * Revue : chaque écart significatif reste « en attente » jusqu'à approbation par un autre utilisateur (production.approve_log)
--    avec motif. Une modification du montant standard ou réel remet l'écart en attente.
--  * Clôture : seulement pour un OF terminé, non clôturé, dont toutes les vérifications passent et dont tous les écarts
--    significatifs sont approuvés pour les montants actuels. Sinon : CLOSE_INCONSISTENT ou CLOSE_VARIANCE_REVIEW_PENDING.
--    L'ancienne fonction production_order_close (0019) n'accepte plus de clôture simple : elle renvoie CLOSE_USE_INDUSTRIAL.
-- Erreurs : CLOSE_THRESHOLD_REQUIRED, CLOSE_INCONSISTENT, CLOSE_VARIANCE_REVIEW_PENDING, CLOSE_USE_INDUSTRIAL,
-- VARIANCE_NOT_FOUND, VARIANCE_BAD_STATUS, VARIANCE_REASON_REQUIRED, SC_MATERIAL_INSUFFICIENT, SC_MATERIAL_OWNER_INVALID,
-- SC_MATERIAL_BAD_QTY, SC_ORDER_NOT_LINKABLE, SC_PRICE_INVALID, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Colonnes : rattachement à un OF et prix convenu
-- ---------------------------------------------------------------------------
alter table public.subcontract_orders
  add column if not exists production_order_id uuid references public.production_orders(id),
  add column if not exists unit_price numeric(14,4) check (unit_price is null or (unit_price >= 0 and unit_price < 1000000000));
create index if not exists subcontract_orders_production_idx on public.subcontract_orders (production_order_id) where production_order_id is not null;

-- Rattachement d'une commande de sous-traitance à un OF (commande ouverte ; OF non terminé)
create function public.sc_order_link_production(p_sc uuid, p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.subcontract_orders%rowtype; o public.production_orders%rowtype;
begin
  perform private.require_perm('subcontract.write');
  perform private.require_perm('production.plan');
  select * into s from public.subcontract_orders where id = p_sc and company_id = v_co for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
  select * into o from public.production_orders where id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('done') or o.closed_at is not null then raise exception 'SC_ORDER_NOT_LINKABLE' using errcode = '55000'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set production_order_id = p_order where id = p_sc;
  perform set_config('subcontract.rpc', 'off', true);
  perform private.write_audit(v_co, 'subcontract.link_production', 'subcontract_order', s.id::text, s.code, null,
    jsonb_build_object('production_order_id', p_order, 'order', o.number), '{}'::jsonb, 'rpc');
end $$;

-- Prix convenu par pièce (coût : droit subcontract.costs)
create function public.sc_order_set_price(p_sc uuid, p_unit_price numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.subcontract_orders%rowtype;
begin
  perform private.require_perm('subcontract.costs');
  if p_unit_price is null or p_unit_price < 0 or p_unit_price >= 1000000000 then raise exception 'SC_PRICE_INVALID' using errcode = '22023'; end if;
  select * into s from public.subcontract_orders where id = p_sc and company_id = v_co for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set unit_price = p_unit_price where id = p_sc;
  perform set_config('subcontract.rpc', 'off', true);
  perform private.write_audit(v_co, 'subcontract.set_price', 'subcontract_order', s.id::text, s.code, jsonb_build_object('unit_price', s.unit_price),
    jsonb_build_object('unit_price', p_unit_price), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Matières externes : registre en ajout seul, par commande, matière et propriétaire
-- ---------------------------------------------------------------------------
create table public.sc_material_ledger (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  sc_order_id     uuid not null references public.subcontract_orders(id),
  material_id     uuid not null references public.bom_materials(id),
  owner_client_id uuid references public.clients(id),
  kind            text not null check (kind in ('send', 'consume', 'scrap', 'return')),
  qty             numeric(14,4) not null check (qty > 0),
  unit_cost       numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  movement_id     uuid,
  warehouse_id    uuid references public.warehouses(id),
  location_id     uuid references public.stock_locations(id),
  reference       text check (reference is null or length(reference) <= 120),
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  check (kind <> 'send' or (owner_client_id is null and unit_cost is not null) or (owner_client_id is not null and unit_cost is null))
);
create index sc_material_ledger_idx on public.sc_material_ledger (sc_order_id, material_id, owner_client_id);

-- Solde d'une matière confiée (propriétaire de la société si owner null)
create function private.sc_material_balance(p_sc uuid, p_material uuid, p_owner uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when kind = 'send' then qty when kind = 'return' then -qty else -qty end), 0)
  from public.sc_material_ledger
  where sc_order_id = p_sc and material_id = p_material and owner_client_id is not distinct from p_owner
$$;
revoke execute on function private.sc_material_balance(uuid, uuid, uuid) from public, anon, authenticated;

-- Coût moyen d'envoi d'une matière de la société chez une commande
create function private.sc_material_avg_cost(p_sc uuid, p_material uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty * unit_cost) / nullif(sum(qty), 0), 0)
  from public.sc_material_ledger where sc_order_id = p_sc and material_id = p_material and kind = 'send' and owner_client_id is null
$$;
revoke execute on function private.sc_material_avg_cost(uuid, uuid) from public, anon, authenticated;

-- Garde : solde jamais négatif ; propriétaire de la société de l'entreprise
create function private.sc_material_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_bal numeric;
begin
  if tg_op <> 'INSERT' then raise exception 'SC_MATERIAL_APPEND_ONLY' using errcode = '42501'; end if;
  if new.owner_client_id is not null and not exists (select 1 from public.clients c where c.id = new.owner_client_id and c.company_id = new.company_id) then
    raise exception 'SC_MATERIAL_OWNER_INVALID' using errcode = '22023';
  end if;
  if new.kind in ('consume', 'scrap', 'return') then
    v_bal := private.sc_material_balance(new.sc_order_id, new.material_id, new.owner_client_id);
    if new.qty > v_bal then raise exception 'SC_MATERIAL_INSUFFICIENT' using errcode = '55000'; end if;
  end if;
  return new;
end $$;
revoke execute on function private.sc_material_guard() from public, anon, authenticated;
create trigger sc_material_ledger_guard_biud before insert or update or delete on public.sc_material_ledger
  for each row execute function private.sc_material_guard();

alter table public.sc_material_ledger enable row level security;
create policy sc_material_ledger_select on public.sc_material_ledger for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
revoke all on public.sc_material_ledger from anon, authenticated;
grant select on public.sc_material_ledger to authenticated;
grant all on public.sc_material_ledger to service_role;

-- Envoi d'une matière : de la société (sortie de stock au coût des lots) ou du client (registre seul)
create function public.sc_material_send(p_sc uuid, p_material uuid, p_qty numeric, p_owner_client uuid, p_warehouse uuid,
  p_location uuid, p_reference text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.subcontract_orders%rowtype; m public.bom_materials%rowtype; v_sub text;
  v_mov uuid; v_cost numeric; v_id uuid := gen_random_uuid(); v_ref text;
begin
  perform private.require_perm('subcontract.write');
  if p_qty is null or p_qty <= 0 then raise exception 'SC_MATERIAL_BAD_QTY' using errcode = '22023'; end if;
  select * into s from public.subcontract_orders where id = p_sc and company_id = v_co for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status not in ('sent', 'partially_received') then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  v_ref := coalesce(nullif(btrim(coalesce(p_reference, '')), ''), s.code);
  select name into v_sub from public.subcontractors where id = s.subcontractor_id;
  if p_owner_client is null then
    perform private.require_perm('stock.write');
    v_mov := private.stock_apply('out', 'out', p_material, p_qty, p_warehouse, p_location, null, 'Envoi sous-traitant ' || s.code || ' ' || v_ref,
      'Matière confiée à ' || v_sub, null, null, null);
    select coalesce(sum(a.qty * coalesce(c.unit_cost, 0)) / p_qty, 0) into v_cost
      from public.stock_movement_allocations a left join public.stock_lot_costs c on c.lot_id = a.lot_id where a.movement_id = v_mov;
    insert into public.sc_material_ledger (id, company_id, sc_order_id, material_id, owner_client_id, kind, qty, unit_cost, movement_id, warehouse_id, location_id, reference)
      values (v_id, v_co, p_sc, p_material, null, 'send', p_qty, v_cost, v_mov, p_warehouse, p_location, v_ref);
  else
    insert into public.sc_material_ledger (id, company_id, sc_order_id, material_id, owner_client_id, kind, qty, reference)
      values (v_id, v_co, p_sc, p_material, p_owner_client, 'send', p_qty, v_ref);
    v_cost := null;
  end if;
  perform private.write_audit(v_co, 'subcontract.material_send', 'subcontract_order', s.id::text, s.code, null,
    jsonb_build_object('material', m.name, 'qty', p_qty, 'owner_client', p_owner_client, 'unit_cost', v_cost), '{}'::jsonb, 'rpc');
  return jsonb_build_object('ledger_id', v_id, 'movement_id', v_mov, 'unit_cost', v_cost);
end $$;

-- Consommation ou rebut chez le sous-traitant (solde vérifié ; coût moyen d'envoi pour la matière de la société)
create function public.sc_material_consume(p_sc uuid, p_material uuid, p_owner_client uuid, p_qty numeric, p_kind text, p_reference text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.subcontract_orders%rowtype; m public.bom_materials%rowtype; v_id uuid := gen_random_uuid(); v_cost numeric;
begin
  perform private.require_perm('subcontract.write');
  if p_kind not in ('consume', 'scrap') then raise exception 'SC_MATERIAL_BAD_QTY' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SC_MATERIAL_BAD_QTY' using errcode = '22023'; end if;
  select * into s from public.subcontract_orders where id = p_sc and company_id = v_co;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  v_cost := case when p_owner_client is null then private.sc_material_avg_cost(p_sc, p_material) end;
  insert into public.sc_material_ledger (id, company_id, sc_order_id, material_id, owner_client_id, kind, qty, unit_cost, reference)
    values (v_id, v_co, p_sc, p_material, p_owner_client, p_kind, p_qty, v_cost, nullif(btrim(coalesce(p_reference, '')), ''));
  perform private.write_audit(v_co, 'subcontract.material_' || p_kind, 'subcontract_order', s.id::text, s.code, null,
    jsonb_build_object('material', m.name, 'qty', p_qty, 'owner_client', p_owner_client, 'unit_cost', v_cost), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Retour d'une matière de la société (entrée en stock au coût moyen d'envoi) ; matière du client : registre seul
create function public.sc_material_return(p_sc uuid, p_material uuid, p_qty numeric, p_owner_client uuid, p_warehouse uuid,
  p_location uuid, p_reference text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.subcontract_orders%rowtype; m public.bom_materials%rowtype; v_id uuid := gen_random_uuid();
  v_cost numeric; v_mov uuid;
begin
  perform private.require_perm('subcontract.write');
  if p_qty is null or p_qty <= 0 then raise exception 'SC_MATERIAL_BAD_QTY' using errcode = '22023'; end if;
  select * into s from public.subcontract_orders where id = p_sc and company_id = v_co;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_owner_client is null then
    perform private.require_perm('stock.write');
    v_cost := private.sc_material_avg_cost(p_sc, p_material);
    v_mov := private.stock_apply('in', 'in', p_material, p_qty, p_warehouse, p_location, null,
      'Retour sous-traitant ' || s.code || ' ' || coalesce(nullif(btrim(coalesce(p_reference, '')), ''), ''), 'Retour de matière confiée', v_cost, null, null);
    insert into public.sc_material_ledger (id, company_id, sc_order_id, material_id, owner_client_id, kind, qty, unit_cost, movement_id, warehouse_id, location_id, reference)
      values (v_id, v_co, p_sc, p_material, null, 'return', p_qty, v_cost, v_mov, p_warehouse, p_location, nullif(btrim(coalesce(p_reference, '')), ''));
  else
    insert into public.sc_material_ledger (id, company_id, sc_order_id, material_id, owner_client_id, kind, qty, reference)
      values (v_id, v_co, p_sc, p_material, p_owner_client, 'return', p_qty, nullif(btrim(coalesce(p_reference, '')), ''));
    v_cost := null; v_mov := null;
  end if;
  perform private.write_audit(v_co, 'subcontract.material_return', 'subcontract_order', s.id::text, s.code, null,
    jsonb_build_object('material', m.name, 'qty', p_qty, 'owner_client', p_owner_client), '{}'::jsonb, 'rpc');
  return jsonb_build_object('ledger_id', v_id, 'movement_id', v_mov);
end $$;

-- Soldes et coûts des matières confiées d'une commande
create function public.sc_material_summary(p_sc uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v jsonb;
begin
  perform private.require_perm('subcontract.read');
  if not exists (select 1 from public.subcontract_orders where id = p_sc and company_id = v_co) then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('material', m.name, 'owner_client_id', x.owner_client_id,
      'owner', case when x.owner_client_id is null then 'company' else 'client' end,
      'sent', x.sent, 'consumed', x.consumed, 'returned', x.returned, 'balance', x.sent - x.consumed - x.returned,
      'consumed_cost', x.consumed_cost) order by m.name, x.owner_client_id nulls first), '[]'::jsonb)
  into v
  from (
    select l.material_id, l.owner_client_id,
      sum(case when l.kind = 'send' then l.qty else 0 end) sent,
      sum(case when l.kind in ('consume', 'scrap') then l.qty else 0 end) consumed,
      sum(case when l.kind = 'return' then l.qty else 0 end) returned,
      sum(case when l.kind in ('consume', 'scrap') then l.qty * coalesce(l.unit_cost, 0) else 0 end) consumed_cost
    from public.sc_material_ledger l where l.sc_order_id = p_sc group by l.material_id, l.owner_client_id
  ) x join public.bom_materials m on m.id = x.material_id;
  return jsonb_build_object('sc_order', p_sc, 'materials', v);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Réconciliation de l'OF : vérifications, coûts standard / réel expliqués, écarts (aucune écriture)
-- ---------------------------------------------------------------------------
create table public.production_order_variances (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  order_id        uuid not null references public.production_orders(id),
  component       text not null check (component in ('material', 'labour', 'subcontract')),
  threshold_pct   numeric(6,2) not null check (threshold_pct >= 0 and threshold_pct <= 100),
  standard_amount numeric(16,4) not null,
  real_amount     numeric(16,4) not null,
  variance_amount numeric(16,4) not null,
  significant     boolean not null,
  status          text not null check (status in ('ok', 'pending', 'approved', 'rejected')),
  detail          jsonb not null default '{}'::jsonb,
  requested_by    uuid,
  requested_at    timestamptz not null default now(),
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(btrim(decision_note)) <= 500),
  unique (order_id, component)
);

create function private.production_reconcile_calc(p_order uuid, p_threshold numeric) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; t jsonb; s public.production_order_bom%rowtype; v_snap boolean;
  v_rate numeric; v_final numeric; v_scrap numeric; v_rework numeric; v_labour_min numeric; v_pending int; v_output numeric;
  v_cut_consumed numeric; v_cut_open int; v_sc_open int; v_sc_unpriced int; v_sc_n int; v_sc_qty_cost numeric; v_sc_real numeric;
  v_factor_missing int; v_price_missing int; v_std_mat numeric; v_real_mat numeric; v_ext_mat numeric; v_std_lab numeric; v_real_lab numeric;
  v_std_sub numeric; v_checks jsonb; v_comps jsonb; v_all boolean; v_sig int; v_cut_n int;
begin
  select * into o from public.production_orders where id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  t := public.production_order_totals(p_order);
  select coalesce(sum((x->>'scrap')::numeric), 0), coalesce(sum((x->>'rework')::numeric), 0),
         coalesce(sum((x->>'productive_min')::numeric + (x->>'rework_min')::numeric), 0)
    into v_scrap, v_rework, v_labour_min from jsonb_array_elements(t->'operations') x;
  v_final := (t->>'good_pieces')::numeric; v_pending := (t->>'pending_corrections')::int;

  select * into s from public.production_order_bom where order_id = p_order and company_id = v_co;
  v_snap := found;
  if v_snap and s.version_id is not null then
    select c.hourly_rate into v_rate from public.bom_version_costs c where c.version_id = s.version_id;
  end if;

  select coalesce(sum(f.qty_in), 0) into v_output from public.finished_lots f where f.production_order_id = p_order and f.company_id = v_co and f.origin = 'receipt';
  select coalesce(sum(p.layers * p.pieces_per_layer) filter (where p.status = 'consumed'), 0), count(*) filter (where p.status = 'planned'),
         count(*) filter (where p.status = 'consumed')
    into v_cut_consumed, v_cut_open, v_cut_n from public.production_cut_plans p where p.production_order_id = p_order;

  -- Matière standard : lignes de la nomenclature figée (restreintes exclues, comme pour les besoins)
  v_std_mat := 0; v_factor_missing := 0; v_price_missing := 0;
  if v_snap and s.status = 'frozen' then
    select coalesce(sum(o.qty_planned * x.mult * x.quantity * x.factor * (1 + x.waste_pct / 100) * coalesce(pr.unit_cost, 0)), 0),
           count(*) filter (where x.factor is null), count(*) filter (where pr.unit_cost is null)
      into v_std_mat, v_factor_missing, v_price_missing
    from jsonb_to_recordset(s.lines) as x(material_id uuid, mult numeric, quantity numeric, waste_pct numeric, factor numeric, size_code text, color_name text)
    left join public.bom_material_prices pr on pr.material_id = x.material_id
    where x.size_code is null and x.color_name is null;
  end if;
  -- Matière réelle : matelas consommés (coût des lots) + matières de la société consommées chez les sous-traitants de l'OF
  select coalesce(sum(a.qty * coalesce(c.unit_cost, 0)), 0) into v_real_mat
    from public.stock_movement_allocations a join public.production_cut_plans p on p.movement_id = a.movement_id
    left join public.stock_lot_costs c on c.lot_id = a.lot_id where p.production_order_id = p_order and p.status = 'consumed';
  select coalesce(sum(l.qty * coalesce(l.unit_cost, 0)), 0) into v_ext_mat
    from public.sc_material_ledger l join public.subcontract_orders so on so.id = l.sc_order_id
    where so.production_order_id = p_order and so.status <> 'cancelled' and l.kind in ('consume', 'scrap') and l.owner_client_id is null;
  v_real_mat := v_real_mat + v_ext_mat;

  v_std_lab := o.qty_planned * o.std_minutes_per_unit / 60 * coalesce(v_rate, 0);
  v_real_lab := v_labour_min / 60 * coalesce(v_rate, 0);

  select coalesce(sum(so.qty * coalesce(so.unit_price, 0)), 0), count(*) filter (where so.unit_price is null),
         count(*) filter (where so.status not in ('closed', 'cancelled')), count(*)
    into v_std_sub, v_sc_unpriced, v_sc_open, v_sc_n
    from public.subcontract_orders so where so.production_order_id = p_order and so.status <> 'cancelled';
  select coalesce(sum(c.amount), 0) into v_sc_real from public.subcontract_costs c join public.subcontract_orders so on so.id = c.order_id
    where so.production_order_id = p_order and so.status <> 'cancelled';

  v_checks := jsonb_build_array(
    jsonb_build_object('code', 'STATUS_DONE', 'ok', o.status = 'done', 'detail', o.status),
    jsonb_build_object('code', 'SNAPSHOT_PRESENT', 'ok', v_snap, 'detail', coalesce(s.status, 'absent')),
    jsonb_build_object('code', 'NO_OPEN_CORRECTIONS', 'ok', v_pending = 0, 'detail', v_pending),
    jsonb_build_object('code', 'PIECES_ACCOUNTED', 'ok', v_final + v_scrap + v_rework <= o.qty_planned,
      'detail', jsonb_build_object('good', v_final, 'scrap', v_scrap, 'rework', v_rework, 'planned', o.qty_planned)),
    jsonb_build_object('code', 'OUTPUT_RECONCILED', 'ok', v_output = v_final, 'detail', jsonb_build_object('good_pieces', v_final, 'finished_lots', v_output)),
    jsonb_build_object('code', 'CUT_NONE_PLANNED', 'ok', v_cut_open = 0, 'detail', v_cut_open),
    jsonb_build_object('code', 'CUT_RECONCILED', 'ok', v_cut_n = 0 or v_cut_consumed >= v_final + v_scrap,
      'detail', jsonb_build_object('cut_pieces', v_cut_consumed, 'good_and_scrap', v_final + v_scrap)),
    jsonb_build_object('code', 'SUBCONTRACT_CLOSED', 'ok', v_sc_open = 0, 'detail', v_sc_open),
    jsonb_build_object('code', 'SUBCONTRACT_PRICED', 'ok', v_sc_unpriced = 0, 'detail', v_sc_unpriced),
    jsonb_build_object('code', 'HOURLY_RATE_PRESENT', 'ok', v_rate is not null or (v_labour_min = 0 and o.std_minutes_per_unit = 0), 'detail', v_rate),
    jsonb_build_object('code', 'MATERIAL_PRICED', 'ok', v_price_missing = 0, 'detail', v_price_missing),
    jsonb_build_object('code', 'UNIT_FACTOR_PRESENT', 'ok', v_factor_missing = 0, 'detail', v_factor_missing)
  );
  v_all := not exists (select 1 from jsonb_array_elements(v_checks) c where (c->>'ok')::boolean = false);

  v_comps := jsonb_build_array(
    jsonb_build_object('component', 'material', 'standard', round(v_std_mat, 4), 'real', round(v_real_mat, 4),
      'formula_standard', 'Σ(quantité OF × multiplicateur × quantité × conversion × (1 + perte) × prix unitaire) sur la nomenclature figée',
      'formula_real', 'Σ(matelas consommés : quantité × coût du lot) + Σ(matières de la société consommées chez le sous-traitant : quantité × coût moyen d''envoi)',
      'drivers', jsonb_build_object('cut_plans_consumed', v_cut_n, 'external_material', v_ext_mat)),
    jsonb_build_object('component', 'labour', 'standard', round(v_std_lab, 4), 'real', round(v_real_lab, 4),
      'formula_standard', 'quantité OF × temps standard par pièce / 60 × taux horaire de la nomenclature',
      'formula_real', 'minutes déclarées (productif + retouche) / 60 × taux horaire',
      'drivers', jsonb_build_object('hourly_rate', v_rate, 'standard_minutes_per_piece', o.std_minutes_per_unit, 'declared_minutes', v_labour_min)),
    jsonb_build_object('component', 'subcontract', 'standard', round(v_std_sub, 4), 'real', round(v_sc_real, 4),
      'formula_standard', 'Σ(quantité commandée au sous-traitant × prix convenu)',
      'formula_real', 'Σ(coûts de prestation saisis sur les commandes de l''OF)',
      'drivers', jsonb_build_object('orders', v_sc_n, 'open_orders', v_sc_open))
  );
  -- écart significatif : au-delà du seuil (% du standard) ; sans standard, tout réel non nul est significatif
  select count(*) into v_sig from jsonb_array_elements(v_comps) x
    where case when (x->>'standard')::numeric = 0 then (x->>'real')::numeric <> 0
               else abs((x->>'real')::numeric - (x->>'standard')::numeric) > (x->>'standard')::numeric * p_threshold / 100 end;
  return jsonb_build_object('order', o.number, 'status', o.status, 'threshold_pct', p_threshold,
    'checks', v_checks, 'all_checks_ok', v_all, 'components', v_comps, 'significant_components', v_sig);
end $$;
revoke execute on function private.production_reconcile_calc(uuid, numeric) from public, anon, authenticated;

-- Réconciliation : écrit l'état des écarts (en attente / ok) et renvoie l'analyse
create function public.production_order_reconcile(p_order uuid, p_threshold_pct numeric) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c jsonb; comp jsonb; r public.production_order_variances%rowtype; v_sig boolean; v_std numeric; v_real numeric;
  v_status text; v_new_pending boolean; v_out jsonb := '[]'::jsonb;
begin
  perform private.require_perm('production.read');
  perform private.require_perm('production.plan');
  if p_threshold_pct is null or p_threshold_pct < 0 or p_threshold_pct > 100 then raise exception 'CLOSE_THRESHOLD_REQUIRED' using errcode = '22023'; end if;
  c := private.production_reconcile_calc(p_order, p_threshold_pct);
  for comp in select * from jsonb_array_elements(c->'components') loop
    v_std := (comp->>'standard')::numeric; v_real := (comp->>'real')::numeric;
    v_sig := case when v_std = 0 then v_real <> 0 else abs(v_real - v_std) > v_std * p_threshold_pct / 100 end;
    select * into r from public.production_order_variances where order_id = p_order and component = comp->>'component';
    if not found then
      v_status := case when v_sig then 'pending' else 'ok' end;
      insert into public.production_order_variances (company_id, order_id, component, threshold_pct, standard_amount, real_amount, variance_amount,
        significant, status, detail, requested_by)
      values (v_co, p_order, comp->>'component', p_threshold_pct, v_std, v_real, v_real - v_std, v_sig, v_status, comp, auth.uid());
    else
      -- montants ou seuil modifiés : revue à refaire ; montants inchangés : décision conservée
      v_new_pending := v_sig and (r.standard_amount is distinct from v_std or r.real_amount is distinct from v_real or r.threshold_pct is distinct from p_threshold_pct);
      v_status := case when not v_sig then 'ok'
                       when v_new_pending then 'pending'
                       when r.status = 'ok' then 'pending'
                       else r.status end;
      update public.production_order_variances set threshold_pct = p_threshold_pct, standard_amount = v_std, real_amount = v_real,
        variance_amount = v_real - v_std, significant = v_sig, status = v_status, detail = comp,
        requested_by = case when v_status = 'pending' and (v_new_pending or r.status = 'ok') then auth.uid() else r.requested_by end,
        requested_at = case when v_status = 'pending' and (v_new_pending or r.status = 'ok') then now() else r.requested_at end,
        decided_by = case when v_status in ('pending', 'ok') then null else r.decided_by end,
        decided_at = case when v_status in ('pending', 'ok') then null else r.decided_at end,
        decision_note = case when v_status in ('pending', 'ok') then null else r.decision_note end
      where id = r.id;
    end if;
  end loop;
  perform private.write_audit(v_co, 'production.reconcile', 'production_order', p_order::text, c->>'order', null,
    jsonb_build_object('all_checks_ok', c->'all_checks_ok', 'significant', c->'significant_components', 'threshold_pct', p_threshold_pct), '{}'::jsonb, 'rpc');
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'component', v.component, 'status', v.status, 'significant', v.significant,
      'standard', v.standard_amount, 'real', v.real_amount, 'variance', v.variance_amount) order by v.component), '[]'::jsonb)
  into v_out from public.production_order_variances v where v.order_id = p_order;
  return c || jsonb_build_object('variances', v_out);
end $$;

-- Décision sur un écart significatif (approbation distincte du demandeur de la revue)
create function public.production_variance_decide(p_variance uuid, p_approve boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.production_order_variances%rowtype; v_code text;
begin
  perform private.require_perm('production.approve_log');
  select * into r from public.production_order_variances where id = p_variance and company_id = v_co for update;
  if not found then raise exception 'VARIANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'VARIANCE_BAD_STATUS' using errcode = '55000'; end if;
  if r.requested_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'VARIANCE_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.production_order_variances set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_note) where id = p_variance;
  select number into v_code from public.production_orders where id = r.order_id;
  perform private.write_audit(v_co, case when p_approve then 'production.variance_approve' else 'production.variance_reject' end,
    'production_order', r.order_id::text, v_code, jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'component', r.component),
    jsonb_build_object('standard', r.standard_amount, 'real', r.real_amount, 'note', btrim(p_note)), 'rpc');
end $$;

-- Clôture industrielle : refusée si incohérente ou si un écart significatif n'est pas approuvé pour les montants actuels
create function public.production_order_close_industrial(p_order uuid, p_threshold_pct numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; c jsonb; comp jsonb; v_fail text; v_pending text; v_sig boolean;
begin
  perform private.require_perm('production.read');
  perform private.require_perm('production.plan');
  if p_threshold_pct is null or p_threshold_pct < 0 or p_threshold_pct > 100 then raise exception 'CLOSE_THRESHOLD_REQUIRED' using errcode = '22023'; end if;
  select * into o from public.production_orders where id = p_order and company_id = v_co for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'done' or o.closed_at is not null then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  c := private.production_reconcile_calc(p_order, p_threshold_pct);
  if not (c->>'all_checks_ok')::boolean then
    select string_agg(x->>'code', ', ') into v_fail from jsonb_array_elements(c->'checks') x where (x->>'ok')::boolean = false;
    raise exception 'CLOSE_INCONSISTENT' using errcode = '55000', detail = v_fail;
  end if;
  for comp in select * from jsonb_array_elements(c->'components') loop
    v_sig := case when (comp->>'standard')::numeric = 0 then (comp->>'real')::numeric <> 0
                  else abs((comp->>'real')::numeric - (comp->>'standard')::numeric) > (comp->>'standard')::numeric * p_threshold_pct / 100 end;
    if v_sig then
      if not exists (select 1 from public.production_order_variances v where v.order_id = p_order and v.component = comp->>'component'
                     and v.status = 'approved' and v.standard_amount = (comp->>'standard')::numeric and v.real_amount = (comp->>'real')::numeric) then
        v_pending := coalesce(v_pending || ', ', '') || (comp->>'component');
      end if;
    end if;
  end loop;
  if v_pending is not null then raise exception 'CLOSE_VARIANCE_REVIEW_PENDING' using errcode = '55000', detail = v_pending; end if;
  update public.production_orders set closed_at = now(), closed_by = auth.uid() where id = p_order;
  perform private.write_audit(v_co, 'production.order_close_industrial', 'production_order', o.id::text, o.number, null,
    jsonb_build_object('closed', true, 'components', c->'components'), jsonb_build_object('threshold_pct', p_threshold_pct), 'rpc');
  return jsonb_build_object('closed', true, 'order', o.number, 'components', c->'components');
end $$;

-- L'ancienne clôture simple n'est plus acceptée : la clôture passe par la réconciliation
create or replace function public.production_order_close(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('production.plan');
  raise exception 'CLOSE_USE_INDUSTRIAL' using errcode = '55000', detail = 'Utiliser production_order_close_industrial(OF, seuil %)';
end $$;

-- ---------------------------------------------------------------------------
-- 4. Privilèges d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.sc_order_link_production(uuid, uuid), public.sc_order_set_price(uuid, numeric),
  public.sc_material_send(uuid, uuid, numeric, uuid, uuid, uuid, text), public.sc_material_consume(uuid, uuid, uuid, numeric, text, text),
  public.sc_material_return(uuid, uuid, numeric, uuid, uuid, uuid, text), public.sc_material_summary(uuid),
  public.production_order_reconcile(uuid, numeric), public.production_variance_decide(uuid, boolean, text),
  public.production_order_close_industrial(uuid, numeric) from public, anon;
grant execute on function public.sc_order_link_production(uuid, uuid), public.sc_order_set_price(uuid, numeric),
  public.sc_material_send(uuid, uuid, numeric, uuid, uuid, uuid, text), public.sc_material_consume(uuid, uuid, uuid, numeric, text, text),
  public.sc_material_return(uuid, uuid, numeric, uuid, uuid, uuid, text), public.sc_material_summary(uuid),
  public.production_order_reconcile(uuid, numeric), public.production_variance_decide(uuid, boolean, text),
  public.production_order_close_industrial(uuid, numeric) to authenticated, service_role;

alter table public.production_order_variances enable row level security;
create policy production_order_variances_select on public.production_order_variances for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
revoke all on public.production_order_variances from anon, authenticated;
grant select on public.production_order_variances to authenticated;
grant all on public.production_order_variances to service_role;
