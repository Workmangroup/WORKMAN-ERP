-- 0058 — Consultations et comparatifs fournisseurs (P033)
-- Additive. Aucune fonction existante n'est modifiée.
-- Réutilise : fournisseurs (0006 : qualification, notation 1-5, archivage), composants (0008), demandes d'achat (0011),
-- devises et taux figés (0027 : fx_rate, fx_convert — erreur FX_RATE_MISSING si aucun taux, aucun taux deviné),
-- moteur d'approbation (0043 : politique 'sourcing_award', séparation des tâches, journal), empreinte (approval_hash),
-- numérotation (next_seq).
-- Règles :
--  * Même base : chaque offre porte sur les mêmes lignes et quantités de la consultation, est convertie en devise de base
--    au même taux (taux du jour d'ouverture de la consultation). Une offre incomplète est refusée.
--  * Offres originales : chaque version garde devise, prix unitaires, transport, droits, incoterm, délai, référence et
--    empreinte SHA-256 du document reçu. Une version n'est jamais modifiée ; une révision crée une version suivante.
--  * Coût rendu = prix unitaires × quantités + transport + droits, converti en devise de base.
--  * Scoring transparent : prix (100 × min / coût), délai (normalisé min-max), qualité (notation × 20) ; pondérations saisies
--    à l'ouverture (somme 100, aucune valeur par défaut inventée). Le détail de chaque calcul est renvoyé.
--  * Un classement n'attribue rien. L'attribution passe par une demande d'approbation (politique 'sourcing_award') : le
--    demandeur ne peut pas approuver, le motif est obligatoire, et la version retenue est figée dans la demande.
--  * Aucune commande fournisseur n'est générée par l'attribution (limite documentée).

-- ---------------------------------------------------------------------
-- 1. Consultations
-- ---------------------------------------------------------------------
create table public.sourcing_events (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code                 text not null check (code ~ '^CON-[0-9]{4,}$'),
  title                text not null check (length(btrim(title)) between 3 and 160),
  status               text not null default 'draft' check (status in ('draft', 'open', 'closed', 'awarded')),
  needed_date          date,
  purchase_request_id  uuid,
  weight_price         int check (weight_price is null or weight_price between 0 and 100),
  weight_lead          int check (weight_lead is null or weight_lead between 0 and 100),
  weight_quality       int check (weight_quality is null or weight_quality between 0 and 100),
  opened_at            timestamptz,
  opened_by            uuid,
  closed_at            timestamptz,
  closed_by            uuid,
  awarding_request_id  uuid,
  awarded_version_id   uuid,
  awarded_at           timestamptz,
  awarded_by           uuid,
  award_rationale      text check (award_rationale is null or length(btrim(award_rationale)) >= 20),
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  unique (company_id, code),
  unique (company_id, id),
  check (status = 'draft' or (weight_price is not null and weight_lead is not null and weight_quality is not null
                              and weight_price + weight_lead + weight_quality = 100)),
  check (status <> 'awarded' or (awarded_version_id is not null and award_rationale is not null and awarded_by is not null and awarded_at is not null)),
  check (status not in ('closed', 'awarded') or closed_at is not null)
);
create index sourcing_events_status_idx on public.sourcing_events (company_id, status, created_at desc);

create table public.sourcing_event_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  event_id    uuid not null references public.sourcing_events(id) on delete cascade,
  material_id uuid not null references public.bom_materials(id),
  qty         numeric(14,4) not null check (qty > 0 and qty <= 100000000),
  created_at  timestamptz not null default now(),
  unique (event_id, material_id)
);
create index sourcing_event_lines_event_idx on public.sourcing_event_lines (event_id);

-- ---------------------------------------------------------------------
-- 2. Offres : une offre par fournisseur et par consultation ; versions immuables
-- ---------------------------------------------------------------------
create table public.sourcing_offers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  event_id    uuid not null references public.sourcing_events(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  created_at  timestamptz not null default now(),
  unique (event_id, supplier_id),
  unique (company_id, id)
);

create table public.sourcing_offer_versions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  offer_id         uuid not null references public.sourcing_offers(id) on delete cascade,
  event_id         uuid not null references public.sourcing_events(id) on delete cascade,
  version          int not null check (version >= 1),
  currency         char(3) not null check (currency ~ '^[A-Z]{3}$'),
  incoterm         text check (incoterm is null or incoterm in ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  lead_time_days   int not null check (lead_time_days between 0 and 365),
  transport_amount numeric(14,2) not null default 0 check (transport_amount >= 0 and transport_amount < 1000000000000),
  duties_amount    numeric(14,2) not null default 0 check (duties_amount >= 0 and duties_amount < 1000000000000),
  valid_until      date,
  source_reference text not null check (length(btrim(source_reference)) between 3 and 160),
  source_sha256    text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  received_on      date not null default current_date,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  unique (offer_id, version)
);
create index sourcing_offer_versions_event_idx on public.sourcing_offer_versions (event_id, offer_id, version desc);

create table public.sourcing_offer_version_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  version_id    uuid not null references public.sourcing_offer_versions(id) on delete cascade,
  event_line_id uuid not null references public.sourcing_event_lines(id) on delete cascade,
  unit_price    numeric(14,4) not null check (unit_price >= 0 and unit_price < 1000000000),
  unique (version_id, event_line_id)
);

-- ---------------------------------------------------------------------
-- 3. Droits : lecture purchases.read ; aucune écriture directe (fonctions seulement)
-- ---------------------------------------------------------------------
alter table public.sourcing_events enable row level security;
alter table public.sourcing_event_lines enable row level security;
alter table public.sourcing_offers enable row level security;
alter table public.sourcing_offer_versions enable row level security;
alter table public.sourcing_offer_version_lines enable row level security;
create policy sourcing_events_select on public.sourcing_events for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy sourcing_event_lines_select on public.sourcing_event_lines for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy sourcing_offers_select on public.sourcing_offers for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy sourcing_offer_versions_select on public.sourcing_offer_versions for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy sourcing_offer_version_lines_select on public.sourcing_offer_version_lines for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.sourcing_events, public.sourcing_event_lines, public.sourcing_offers, public.sourcing_offer_versions, public.sourcing_offer_version_lines from public, anon, authenticated;
grant select on public.sourcing_events, public.sourcing_event_lines, public.sourcing_offers, public.sourcing_offer_versions, public.sourcing_offer_version_lines to authenticated;

-- ---------------------------------------------------------------------
-- 4. Création, ouverture (pondérations), offres, clôture
-- ---------------------------------------------------------------------
create function public.sourcing_event_create(p_title text, p_needed date, p_request uuid, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_code text; l jsonb;
begin
  perform private.require_perm('purchases.write');
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'SOURCING_EMPTY' using errcode = '55000'; end if;
  if p_request is not null and not exists (select 1 from public.purchase_requests where id = p_request and company_id = v_co) then
    raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_code := 'CON-' || lpad(private.next_seq(v_co, 'sourcing_event')::text, 4, '0');
  insert into public.sourcing_events (company_id, code, title, needed_date, purchase_request_id, created_by)
  values (v_co, v_code, btrim(p_title), p_needed, p_request, auth.uid()) returning id into v_id;
  for l in select value from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from public.bom_materials where id = (l ->> 'material_id')::uuid and company_id = v_co and archived_at is null) then
      raise exception 'SOURCING_BAD_MATERIAL' using errcode = '22023';
    end if;
    insert into public.sourcing_event_lines (company_id, event_id, material_id, qty)
    values (v_co, v_id, (l ->> 'material_id')::uuid, (l ->> 'qty')::numeric);
  end loop;
  perform private.write_audit(v_co, 'sourcing.event_create', 'sourcing_event', v_id::text, v_code, null,
    jsonb_build_object('lines', jsonb_array_length(p_lines)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function public.sourcing_event_create(text, date, uuid, jsonb) from public, anon;
grant execute on function public.sourcing_event_create(text, date, uuid, jsonb) to authenticated, service_role;

create function public.sourcing_event_open(p_event uuid, p_wp int, p_wl int, p_wq int) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.sourcing_events%rowtype;
begin
  perform private.require_perm('purchases.write');
  select * into e from public.sourcing_events where id = p_event and company_id = private.current_company() for update;
  if not found then raise exception 'SOURCING_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'draft' then raise exception 'SOURCING_BAD_STATUS' using errcode = '55000'; end if;
  if p_wp is null or p_wl is null or p_wq is null or p_wp < 0 or p_wl < 0 or p_wq < 0 or p_wp + p_wl + p_wq <> 100 then
    raise exception 'SOURCING_WEIGHTS_INVALID' using errcode = '22023';
  end if;
  update public.sourcing_events set status = 'open', weight_price = p_wp, weight_lead = p_wl, weight_quality = p_wq,
         opened_at = now(), opened_by = auth.uid() where id = p_event;
  perform private.write_audit(e.company_id, 'sourcing.event_open', 'sourcing_event', e.id::text, e.code, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'open', 'weights', jsonb_build_array(p_wp, p_wl, p_wq)), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.sourcing_event_open(uuid, int, int, int) from public, anon;
grant execute on function public.sourcing_event_open(uuid, int, int, int) to authenticated, service_role;

-- Offre : toutes les lignes de la consultation, une fois chacune, prix ≥ 0. Une révision crée la version suivante.
create function public.sourcing_offer_submit(p_event uuid, p_supplier uuid, p_currency text, p_incoterm text, p_lead int,
                                             p_transport numeric, p_duties numeric, p_valid_until date, p_reference text,
                                             p_sha256 text, p_lines jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare e public.sourcing_events%rowtype; s public.suppliers%rowtype; v_cur char(3) := upper(btrim(coalesce(p_currency, '')));
        v_offer uuid; v_ver int; v_vid uuid; v_missing int; x jsonb;
begin
  perform private.require_perm('purchases.write');
  select * into e from public.sourcing_events where id = p_event and company_id = private.current_company() for update;
  if not found then raise exception 'SOURCING_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'open' then raise exception 'SOURCING_BAD_STATUS' using errcode = '55000'; end if;
  select * into s from public.suppliers where id = p_supplier and company_id = e.company_id;
  if not found then raise exception 'PURCHASE_BAD_SUPPLIER' using errcode = '22023'; end if;
  if s.qualification <> 'approved' or s.archived_at is not null then raise exception 'SOURCING_SUPPLIER_NOT_APPROVED' using errcode = '22023'; end if;
  if not exists (select 1 from public.currencies where code = v_cur) then raise exception 'SOURCING_CURRENCY_UNKNOWN' using errcode = '22023'; end if;
  perform public.fx_rate(v_cur, coalesce(e.opened_at::date, current_date));           -- FX_RATE_MISSING si aucun taux : pas de devinette
  if p_incoterm is not null and p_incoterm not in ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP') then raise exception 'SOURCING_BAD_INCOTERM' using errcode = '22023'; end if;
  if p_lead is null or p_lead < 0 or p_lead > 365 then raise exception 'SOURCING_BAD_LEAD' using errcode = '22023'; end if;
  if coalesce(p_transport, 0) < 0 or coalesce(p_duties, 0) < 0 then raise exception 'SOURCING_BAD_AMOUNT' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reference, ''))) < 3 then raise exception 'SOURCING_REFERENCE_REQUIRED' using errcode = '22023'; end if;
  if p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'SOURCING_BAD_SHA' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'SOURCING_INCOMPLETE' using errcode = '22023'; end if;
  if jsonb_array_length(p_lines) <> (select count(*) from public.sourcing_event_lines where event_id = p_event) then
    raise exception 'SOURCING_INCOMPLETE' using errcode = '22023';
  end if;
  select count(*) into v_missing from public.sourcing_event_lines el
   where el.event_id = p_event and not exists (select 1 from jsonb_array_elements(p_lines) y where (y.value ->> 'event_line_id')::uuid = el.id);
  if v_missing > 0 then raise exception 'SOURCING_INCOMPLETE' using errcode = '22023'; end if;

  insert into public.sourcing_offers (company_id, event_id, supplier_id) values (e.company_id, p_event, p_supplier) on conflict (event_id, supplier_id) do nothing;
  select id into v_offer from public.sourcing_offers where event_id = p_event and supplier_id = p_supplier;
  select coalesce(max(version), 0) + 1 into v_ver from public.sourcing_offer_versions where offer_id = v_offer;
  insert into public.sourcing_offer_versions (company_id, offer_id, event_id, version, currency, incoterm, lead_time_days, transport_amount, duties_amount,
    valid_until, source_reference, source_sha256, created_by)
  values (e.company_id, v_offer, p_event, v_ver, v_cur, p_incoterm, p_lead, coalesce(p_transport, 0), coalesce(p_duties, 0), p_valid_until,
          btrim(p_reference), p_sha256, auth.uid()) returning id into v_vid;
  for x in select value from jsonb_array_elements(p_lines) loop
    insert into public.sourcing_offer_version_lines (company_id, version_id, event_line_id, unit_price)
    values (e.company_id, v_vid, (x ->> 'event_line_id')::uuid, (x ->> 'unit_price')::numeric);
  end loop;
  perform private.write_audit(e.company_id, 'sourcing.offer_submit', 'sourcing_offer', v_offer::text, e.code || ' ' || s.name || ' v' || v_ver, null,
    jsonb_build_object('currency', v_cur, 'version', v_ver, 'source_reference', btrim(p_reference), 'source_sha256', p_sha256), '{}'::jsonb, 'rpc');
  return v_ver;
end $$;
revoke execute on function public.sourcing_offer_submit(uuid, uuid, text, text, int, numeric, numeric, date, text, text, jsonb) from public, anon;
grant execute on function public.sourcing_offer_submit(uuid, uuid, text, text, int, numeric, numeric, date, text, text, jsonb) to authenticated, service_role;

create function public.sourcing_event_close(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.sourcing_events%rowtype;
begin
  perform private.require_perm('purchases.write');
  select * into e from public.sourcing_events where id = p_event and company_id = private.current_company() for update;
  if not found then raise exception 'SOURCING_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'open' then raise exception 'SOURCING_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.sourcing_offers where event_id = p_event) then raise exception 'SOURCING_NO_OFFER' using errcode = '55000'; end if;
  update public.sourcing_events set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = p_event;
  perform private.write_audit(e.company_id, 'sourcing.event_close', 'sourcing_event', e.id::text, e.code, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'closed'), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.sourcing_event_close(uuid) from public, anon;
grant execute on function public.sourcing_event_close(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Comparatif : calcul transparent, même base, version courante de chaque offre (fonction de calcul sans contrôle de droit)
-- ---------------------------------------------------------------------
create function private.sourcing_compare_core(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e public.sourcing_events%rowtype; o record; v_base char(3) := private.base_currency(); v_rate_date date;
        v_offers jsonb := '[]'::jsonb; v_scored jsonb := '[]'::jsonb; v_out jsonb; v_lines jsonb; v_lines_amt numeric; v_landed numeric;
        v_min_landed numeric; v_min_lead numeric; v_max_lead numeric; v_no_rating text; v_wp numeric; v_wl numeric; v_wq numeric;
        x jsonb; v_ps numeric; v_ls numeric; v_qs numeric; v_tot numeric;
begin
  select * into e from public.sourcing_events where id = p_event and company_id = private.current_company();
  if not found then raise exception 'SOURCING_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status not in ('closed', 'awarded') then raise exception 'SOURCING_NOT_CLOSED' using errcode = '55000'; end if;
  v_rate_date := e.opened_at::date;
  v_wp := e.weight_price; v_wl := e.weight_lead; v_wq := e.weight_quality;
  select coalesce(jsonb_agg(jsonb_build_object('event_line_id', el.id, 'material_code', m.code, 'material_name', m.name, 'unit', m.unit, 'qty', el.qty) order by m.code), '[]'::jsonb)
    into v_lines from public.sourcing_event_lines el join public.bom_materials m on m.id = el.material_id where el.event_id = p_event;

  for o in
    select of.id as offer_id, of.supplier_id, s.name as supplier_name, s.rating, v.id as version_id, v.version, v.currency, v.incoterm,
           v.lead_time_days, v.transport_amount, v.duties_amount, v.valid_until, v.source_reference, v.source_sha256, v.received_on
      from public.sourcing_offers of
      join public.suppliers s on s.id = of.supplier_id
      join lateral (select * from public.sourcing_offer_versions y where y.offer_id = of.id order by y.version desc limit 1) v on true
     where of.event_id = p_event
     order by s.name
  loop
    if o.rating is null then
      v_no_rating := coalesce(v_no_rating || ', ', '') || o.supplier_name;
      continue;
    end if;
    select coalesce(sum(l.unit_price * el.qty), 0) into v_lines_amt
      from public.sourcing_offer_version_lines l join public.sourcing_event_lines el on el.id = l.event_line_id where l.version_id = o.version_id;
    v_landed := public.fx_convert(v_lines_amt + o.transport_amount + o.duties_amount, o.currency, v_rate_date);
    v_offers := v_offers || jsonb_build_object('offer_id', o.offer_id, 'supplier_id', o.supplier_id, 'supplier_name', o.supplier_name,
      'version_id', o.version_id, 'version', o.version, 'currency', o.currency, 'incoterm', o.incoterm, 'lead_time_days', o.lead_time_days,
      'lines_amount_offer', v_lines_amt, 'transport_offer', o.transport_amount, 'duties_offer', o.duties_amount,
      'landed_base', v_landed, 'quality_rating', o.rating, 'valid_until', o.valid_until,
      'source', jsonb_build_object('reference', o.source_reference, 'sha256', o.source_sha256, 'received_on', o.received_on,
                                   'rate_date', v_rate_date, 'rate', public.fx_rate(o.currency, v_rate_date)));
  end loop;
  if v_no_rating is not null then
    raise exception 'SOURCING_QUALITY_MISSING' using errcode = '22023', detail = v_no_rating;
  end if;
  if jsonb_array_length(v_offers) = 0 then raise exception 'SOURCING_NO_OFFER' using errcode = '55000'; end if;
  if exists (select 1 from jsonb_array_elements(v_offers) z where (z.value ->> 'landed_base')::numeric <= 0) then
    raise exception 'SOURCING_ZERO_PRICE' using errcode = '22023';
  end if;
  select min((z.value ->> 'landed_base')::numeric), min((z.value ->> 'lead_time_days')::numeric), max((z.value ->> 'lead_time_days')::numeric)
    into v_min_landed, v_min_lead, v_max_lead from jsonb_array_elements(v_offers) z;

  -- Scores : prix 100 × min / coût ; délai min-max (100 si tous égaux) ; qualité 20 × notation
  for x in select value from jsonb_array_elements(v_offers) loop
    v_ps := round(100 * v_min_landed / (x ->> 'landed_base')::numeric, 2);
    v_ls := round(case when v_max_lead = v_min_lead then 100
                       else 100 * (v_max_lead - (x ->> 'lead_time_days')::numeric) / (v_max_lead - v_min_lead) end, 2);
    v_qs := round(20 * (x ->> 'quality_rating')::numeric, 2);
    v_tot := round((v_wp * v_ps + v_wl * v_ls + v_wq * v_qs) / 100, 2);
    v_scored := v_scored || (x || jsonb_build_object('price_score', v_ps, 'lead_score', v_ls, 'quality_score', v_qs, 'total_score', v_tot));
  end loop;

  select coalesce(jsonb_agg(q.z || jsonb_build_object('rank', q.rn) order by q.rn), '[]'::jsonb) into v_out from (
    select z, row_number() over (order by (z ->> 'total_score')::numeric desc, z ->> 'supplier_name') as rn
      from (select value as z from jsonb_array_elements(v_scored)) s
  ) q;

  return jsonb_build_object('event', e.code, 'status', e.status, 'base_currency', v_base, 'rate_date', v_rate_date,
    'weights', jsonb_build_object('price', v_wp, 'lead', v_wl, 'quality', v_wq),
    'formula', jsonb_build_object('price', '100 × min(coût rendu) / coût rendu',
                                  'lead', '100 × (max − délai) / (max − min), 100 si tous égaux',
                                  'quality', '20 × notation fournisseur (1 à 5)',
                                  'total', '(poids prix × score prix + poids délai × score délai + poids qualité × score qualité) / 100'),
    'basis', jsonb_build_object('lines', v_lines),
    'offers', v_out);
end $$;
revoke execute on function private.sourcing_compare_core(uuid) from public, anon, authenticated;

create function public.sourcing_compare(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_perm('purchases.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  return private.sourcing_compare_core(p_event);
end $$;
grant execute on function public.sourcing_compare(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Attribution : demande d'approbation humaine (politique 'sourcing_award'), version figée dans la demande
-- ---------------------------------------------------------------------
create function public.sourcing_award_request(p_event uuid, p_version uuid, p_rationale text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e public.sourcing_events%rowtype; p public.approval_policies%rowtype; v_cmp jsonb; v_chosen jsonb; v_id uuid; v_ver int;
        v_snap jsonb; v_rat text := btrim(coalesce(p_rationale, ''));
begin
  perform private.require_perm('purchases.write');
  select * into e from public.sourcing_events where id = p_event and company_id = private.current_company() for update;
  if not found then raise exception 'SOURCING_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'closed' then raise exception 'SOURCING_BAD_STATUS' using errcode = '55000'; end if;
  if e.awarding_request_id is not null then raise exception 'SOURCING_AWARD_PENDING' using errcode = '55000'; end if;
  if length(v_rat) < 20 then raise exception 'SOURCING_RATIONALE_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.sourcing_offer_versions where id = p_version and event_id = p_event) then
    raise exception 'SOURCING_BAD_VERSION' using errcode = '22023';
  end if;
  if exists (select 1 from public.sourcing_offer_versions v join public.sourcing_offer_versions n on n.offer_id = v.offer_id
             where v.id = p_version and n.version > v.version) then
    raise exception 'SOURCING_STALE_VERSION' using errcode = '55000';
  end if;
  select * into p from public.approval_policies where company_id = e.company_id and object_type = 'sourcing_award';
  if not found then raise exception 'APPROVAL_NO_POLICY' using errcode = '55000', detail = 'sourcing_award'; end if;
  v_cmp := private.sourcing_compare_core(p_event);
  select x.value into v_chosen from jsonb_array_elements(v_cmp -> 'offers') x where (x.value ->> 'version_id')::uuid = p_version;
  if v_chosen is null then raise exception 'SOURCING_BAD_VERSION' using errcode = '22023'; end if;
  v_snap := jsonb_build_object('event', e.code, 'version_id', p_version, 'rationale', v_rat, 'chosen', v_chosen, 'compare', v_cmp);
  select coalesce(max(object_version), 0) + 1 into v_ver from public.approval_requests
   where company_id = e.company_id and object_type = 'sourcing_award' and object_id = e.id;
  insert into public.approval_requests (company_id, object_type, object_id, object_version, object_hash, snapshot, amount, state, levels,
    level2_threshold, level1_permission, level2_permission, escalation_permission, deadline_hours, requested_by, deadline_at)
  values (e.company_id, 'sourcing_award', e.id, v_ver, private.approval_hash(v_snap), v_snap, (v_chosen ->> 'landed_base')::numeric, 'pending_l1', p.levels,
    p.level2_threshold, p.level1_permission, p.level2_permission, p.escalation_permission, p.deadline_hours, auth.uid(),
    now() + make_interval(hours => p.deadline_hours))
  returning id into v_id;
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, object_hash)
  values (v_id, e.company_id, 0, 'request', null, 'pending_l1', private.approval_hash(v_snap));
  update public.sourcing_events set awarding_request_id = v_id where id = p_event;
  perform private.write_audit(e.company_id, 'sourcing.award_request', 'sourcing_event', e.id::text, e.code, null,
    jsonb_build_object('version_id', p_version, 'landed_base', v_chosen ->> 'landed_base', 'approval', v_id), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function public.sourcing_award_request(uuid, uuid, text) from public, anon;
grant execute on function public.sourcing_award_request(uuid, uuid, text) to authenticated, service_role;

-- Décision humaine (moteur 0043) : approuvée = attribution figée ; refusée ou annulée = consultation de nouveau attribuable.
create function private.sourcing_award_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.object_type <> 'sourcing_award' or new.state = old.state then return new; end if;
  if new.state = 'approved' then
    update public.sourcing_events set status = 'awarded', awarded_version_id = (new.snapshot ->> 'version_id')::uuid, awarded_at = now(),
           awarded_by = new.decided_by, award_rationale = new.snapshot ->> 'rationale', awarding_request_id = null
     where id = new.object_id and company_id = new.company_id;
  elsif new.state in ('refused', 'cancelled', 'invalidated') then
    update public.sourcing_events set awarding_request_id = null where id = new.object_id and company_id = new.company_id and awarding_request_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function private.sourcing_award_sync() from public, anon, authenticated;
create trigger approval_requests_sourcing_sync_au after update of state on public.approval_requests
  for each row execute function private.sourcing_award_sync();
