-- =====================================================================
-- 0018_stock_movements — Mouvements de stock : types métier, numérotation, journal, annulation contrôlée, validation hiérarchique
--  Étend l'existant (0009_stock) au lieu de le dupliquer :
--    stock_movements      : + numéro automatique (MVT-AAAA-000001), type métier (kind), lien vers la demande,
--                           réversion (reversal_of), demandeur et validateur. Reste IMMUABLE (journal).
--    stock_reservations   : + numéro automatique (RES-000001).
--    stock_movement_requests (nouvelle) : demande de mouvement en attente de validation. Un mouvement n'atteint le stock
--                           qu'au moment de sa validation finale ; c'est elle qui produit la ligne de journal.
--    stock_movement_policies (nouvelle) : seuils et règles de validation par type de mouvement.
--  Types métier : entree_achat, sortie_production, retour_production, ajustement, transfert,
--                 retour_fournisseur, rebut, sous_traitance, annulation.
--  Moteur : private.stock_apply (0009) ; aucune écriture de stock hors de ce moteur.
--  Validation hiérarchique :
--    - niveau 0 : pas de validation (mouvement courant sous seuil) → posté immédiatement ;
--    - niveau 1 : validation par stock.approve ;
--    - niveau 2 : validation en second par stock.approve_high (la personne doit être distincte du niveau 1) ;
--    - le demandeur ne valide jamais sa propre demande (STOCK_SELF_APPROVAL).
--  Annulation : une réversion est une demande de type « annulation » (motif obligatoire) ; elle suit la même validation.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('stock.approve',      'stock', 'Valider les mouvements de stock (niveau 1)',   'Valider ou refuser une demande de mouvement, premier niveau'),
  ('stock.approve_high', 'stock', 'Valider les mouvements sensibles (niveau 2)',  'Valider en second niveau les mouvements au-dessus du seuil de valeur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('stock.approve', 'stock.approve_high'))
  or (r.code = 'direction' and p.code in ('stock.approve', 'stock.approve_high'))
  or (r.code = 'magasin'   and p.code = 'stock.approve'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Numérotation : séquences et numéros sur les mouvements et réservations
-- ---------------------------------------------------------------------
-- Les numéros des mouvements existants sont attribués une fois (le journal est immuable : déclencheur désactivé
-- uniquement le temps de cette reprise, exécutée par le propriétaire du schéma).
alter table public.stock_movements add column number text,
  add column kind text,
  add column request_id uuid,
  add column reversal_of uuid references public.stock_movements(id),
  add column requested_by uuid,
  add column approved_by uuid;

alter table public.stock_movements disable trigger stock_movements_immutable;
insert into public.company_sequences (company_id, key, last_value)
select company_id, 'stock_movement', count(*) from public.stock_movements group by company_id
on conflict (company_id, key) do update set last_value = excluded.last_value;
update public.stock_movements m
   set number = 'MVT-' || to_char(m.created_at, 'YYYY') || '-' || lpad(n.rn::text, 6, '0'),
       kind = case m.type when 'in' then 'entree_achat' when 'out' then 'sortie_production' when 'transfer' then 'transfert'
                          when 'adjustment' then 'ajustement' when 'inventory' then 'inventaire' end
  from (select id, row_number() over (partition by company_id order by created_at, seq) rn from public.stock_movements) n
 where n.id = m.id and m.number is null;
alter table public.stock_movements enable trigger stock_movements_immutable;

alter table public.stock_movements
  add constraint stock_movements_kind_check check (kind in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement',
    'transfert', 'retour_fournisseur', 'rebut', 'sous_traitance', 'annulation', 'inventaire'));
create unique index stock_movements_number_uidx on public.stock_movements (company_id, number);
create index stock_movements_reversal_idx on public.stock_movements (reversal_of) where reversal_of is not null;
create index stock_movements_request_idx on public.stock_movements (request_id) where request_id is not null;

create function private.stock_movement_meta() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ctx jsonb := coalesce(nullif(current_setting('stock.movement_ctx', true), '')::jsonb, '{}'::jsonb);
begin
  -- le contexte (type métier, demande, réversion, validateur) est posé par les fonctions de validation, pour la seule transaction
  new.kind := coalesce(new.kind, nullif(v_ctx->>'kind', ''), case new.type when 'in' then 'entree_achat' when 'out' then 'sortie_production'
    when 'transfer' then 'transfert' when 'adjustment' then 'ajustement' when 'inventory' then 'inventaire' end);
  new.request_id := coalesce(new.request_id, nullif(v_ctx->>'request_id', '')::uuid);
  new.reversal_of := coalesce(new.reversal_of, nullif(v_ctx->>'reversal_of', '')::uuid);
  new.requested_by := coalesce(new.requested_by, nullif(v_ctx->>'requested_by', '')::uuid);
  new.approved_by := coalesce(new.approved_by, nullif(v_ctx->>'approved_by', '')::uuid);
  if new.number is null then
    new.number := 'MVT-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, 'stock_movement')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.stock_movement_meta() from public, anon, authenticated;
create trigger stock_movements_meta_i before insert on public.stock_movements for each row execute function private.stock_movement_meta();

alter table public.stock_reservations add column number text;
insert into public.company_sequences (company_id, key, last_value)
select company_id, 'stock_reservation', count(*) from public.stock_reservations group by company_id
on conflict (company_id, key) do update set last_value = excluded.last_value;
update public.stock_reservations r set number = 'RES-' || lpad(n.rn::text, 6, '0')
  from (select id, row_number() over (partition by company_id order by created_at) rn from public.stock_reservations) n
 where n.id = r.id and r.number is null;
create unique index stock_reservations_number_uidx on public.stock_reservations (company_id, number);

create function private.stock_reservation_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := 'RES-' || lpad(private.next_seq(new.company_id, 'stock_reservation')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.stock_reservation_number() from public, anon, authenticated;
create trigger stock_reservations_number_i before insert on public.stock_reservations for each row execute function private.stock_reservation_number();

-- ---------------------------------------------------------------------
-- 3. Règles de validation par type de mouvement
-- ---------------------------------------------------------------------
create table public.stock_movement_policies (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  kind              text not null check (kind in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement', 'transfert',
                      'retour_fournisseur', 'rebut', 'sous_traitance', 'annulation')),
  requires_approval boolean not null default false,
  level1_threshold  numeric(14,2) check (level1_threshold is null or level1_threshold >= 0),
  level2_threshold  numeric(14,2) check (level2_threshold is null or level2_threshold >= 0),
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  unique (company_id, kind),
  check (level1_threshold is null or level2_threshold is null or level2_threshold >= level1_threshold)
);
alter table public.stock_movement_policies enable row level security;
create policy stock_movement_policies_select on public.stock_movement_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
revoke all on public.stock_movement_policies from anon, authenticated;
grant select on public.stock_movement_policies to authenticated;

-- Niveau requis : 0 = aucun, 1 = validation simple, 2 = validation en second niveau.
-- Par défaut : ajustement, rebut, retour fournisseur et annulation exigent une validation ; tout mouvement
-- dont la valeur atteint 1 000 exige une validation de niveau 1 ; 10 000 exige le niveau 2.
create function private.stock_approval_level(p_kind text, p_value numeric) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.stock_movement_policies%rowtype;
  v_req boolean; v_l1 numeric; v_l2 numeric;
begin
  select * into p from public.stock_movement_policies where company_id = v_co and kind = p_kind;
  v_req := case when found then p.requires_approval else p_kind in ('ajustement', 'rebut', 'retour_fournisseur', 'annulation') end;
  v_l1 := case when found then p.level1_threshold else 1000 end;
  v_l2 := case when found then p.level2_threshold else 10000 end;
  if not v_req and (v_l1 is null or p_value < v_l1) then return 0; end if;
  if v_l2 is not null and p_value >= v_l2 then return 2; end if;
  return 1;
end $$;
revoke execute on function private.stock_approval_level(text, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Demandes de mouvement (validation hiérarchique)
-- ---------------------------------------------------------------------
create table public.stock_movement_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  number          text not null,
  kind            text not null check (kind in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement', 'transfert',
                    'retour_fournisseur', 'rebut', 'sous_traitance', 'annulation')),
  status          text not null default 'pending' check (status in ('pending', 'posted', 'rejected', 'cancelled')),
  engine_type     text not null check (engine_type in ('in', 'out', 'transfer', 'adjustment')),
  engine_dir      text not null check (engine_dir in ('in', 'out', 'move')),
  material_id     uuid not null references public.bom_materials(id),
  qty             numeric(14,4) not null check (qty > 0),
  warehouse_id    uuid not null references public.warehouses(id),
  location_id     uuid references public.stock_locations(id),
  to_warehouse_id uuid references public.warehouses(id),
  to_location_id  uuid references public.stock_locations(id),
  unit_cost       numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  value           numeric(14,2) not null default 0 check (value >= 0),
  reference       text check (reference is null or length(reference) <= 120),
  reason          text check (reason is null or length(reason) <= 300),
  reversal_of     uuid references public.stock_movements(id),
  approval_level  int not null check (approval_level in (0, 1, 2)),
  requested_by    uuid not null default auth.uid(),
  requested_at    timestamptz not null default clock_timestamp(),
  level1_by       uuid,
  level1_at       timestamptz,
  level2_by       uuid,
  level2_at       timestamptz,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(decision_note) <= 300),
  movement_id     uuid references public.stock_movements(id),
  unique (company_id, number),
  check ((kind = 'annulation') = (reversal_of is not null)),
  check (kind = 'ajustement' or engine_type <> 'adjustment'),
  check (kind <> 'transfert' or (to_warehouse_id is not null and to_location_id is not null)),
  check (status <> 'posted' or movement_id is not null),
  check (approval_level > 0 or status in ('posted', 'pending'))
);
-- une annulation active ou appliquée par mouvement : pas de double réversion
create unique index stock_requests_reversal_uidx on public.stock_movement_requests (reversal_of)
  where reversal_of is not null and status in ('pending', 'posted');
create index stock_requests_status_idx on public.stock_movement_requests (company_id, status, requested_at desc);

alter table public.stock_movement_requests enable row level security;
create policy stock_movement_requests_select on public.stock_movement_requests for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
-- lecture restreinte aux entrepôts accessibles (0017)
create policy stock_movement_requests_wh_scope on public.stock_movement_requests as restrictive for select to authenticated
  using (private.wh_can(warehouse_id, 'viewer'));
revoke all on public.stock_movement_requests from anon, authenticated;
grant select on public.stock_movement_requests to authenticated;
-- écriture uniquement par les fonctions ci-dessous (contrôles de droits, d'entrepôt et de hiérarchie)
create trigger stock_requests_wh_guard_w before insert or update or delete on public.stock_movement_requests
  for each row execute function private.wh_write_guard('warehouse_id', 'operator');
create trigger stock_requests_wh_guard_t before insert or update or delete on public.stock_movement_requests
  for each row execute function private.wh_write_guard('to_warehouse_id', 'operator');

-- Journal : vue des mouvements avec leur numéro, leur type métier et leurs références.
create view public.stock_journal with (security_invoker = true) as
select m.id, m.number, m.created_at, m.kind, m.type, m.direction, m.qty, m.material_id,
       b.code as material_code, b.name as material_name,
       m.warehouse_id, w.code as warehouse_code, m.location_id,
       m.to_warehouse_id, m.to_location_id, m.reference, m.reason,
       m.reversal_of, m.request_id, m.requested_by, m.approved_by, m.created_by
  from public.stock_movements m
  join public.bom_materials b on b.id = m.material_id
  join public.warehouses w on w.id = m.warehouse_id;
grant select on public.stock_journal to authenticated;

-- ---------------------------------------------------------------------
-- 5. Posting d'une demande (moteur stock_apply) — interne
-- ---------------------------------------------------------------------
create function private.stock_request_post(p_req uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype; v_mov uuid;
begin
  select * into r from public.stock_movement_requests where id = p_req for update;
  perform set_config('stock.movement_ctx', jsonb_build_object(
    'kind', r.kind, 'request_id', r.id, 'reversal_of', r.reversal_of, 'requested_by', r.requested_by,
    'approved_by', coalesce(r.level2_by, r.level1_by))::text, true);
  v_mov := private.stock_apply(r.engine_type, r.engine_dir, r.material_id, r.qty, r.warehouse_id, r.location_id,
    case when r.engine_dir = 'move' then r.to_location_id end, r.reference, r.reason, r.unit_cost, null, null);
  perform set_config('stock.movement_ctx', '', true);
  update public.stock_movement_requests set status = 'posted', movement_id = v_mov, decided_by = coalesce(auth.uid(), r.requested_by),
    decided_at = now() where id = p_req;
  return v_mov;
end $$;
revoke execute on function private.stock_request_post(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Fonctions publiques
-- ---------------------------------------------------------------------
-- Demande de mouvement. Posté immédiatement si la règle ne demande aucune validation.
create function public.stock_request_create(p_kind text, p_material uuid, p_qty numeric, p_warehouse uuid, p_location uuid default null,
  p_to_warehouse uuid default null, p_to_location uuid default null, p_unit_cost numeric default null,
  p_reference text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_num text; v_etype text; v_edir text;
  v_qty numeric := abs(p_qty); v_value numeric; v_level int; v_mov uuid; v_status text;
begin
  if p_kind not in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement', 'transfert', 'retour_fournisseur', 'rebut', 'sous_traitance') then
    raise exception 'STOCK_BAD_KIND' using errcode = '22023';
  end if;
  if p_kind = 'ajustement' then perform private.require_perm('stock.adjust'); else perform private.require_perm('stock.write'); end if;
  if p_qty is null or p_qty = 0 or (p_kind <> 'ajustement' and p_qty < 0) then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  p_reason := nullif(btrim(coalesce(p_reason, '')), ''); p_reference := nullif(btrim(coalesce(p_reference, '')), '');
  if p_kind in ('ajustement', 'rebut', 'retour_fournisseur') and length(coalesce(p_reason, '')) < 3 then
    raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_kind = 'transfert' and (p_to_warehouse is null or p_to_location is null) then
    raise exception 'STOCK_DESTINATION_REQUIRED' using errcode = '22023';
  end if;
  if p_kind = 'transfert' and p_location is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
  if p_kind in ('entree_achat', 'retour_production') and p_location is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;

  if p_kind in ('entree_achat', 'retour_production') then v_etype := 'in'; v_edir := 'in';
  elsif p_kind = 'transfert' then v_etype := 'transfer'; v_edir := 'move';
  elsif p_kind = 'ajustement' then v_etype := 'adjustment'; v_edir := case when p_qty > 0 then 'in' else 'out' end;
  else v_etype := 'out'; v_edir := 'out';
  end if;
  v_value := v_qty * coalesce(p_unit_cost, 0);
  v_level := private.stock_approval_level(p_kind, v_value);
  v_num := 'DEM-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'stock_request')::text, 6, '0');

  insert into public.stock_movement_requests (id, company_id, number, kind, status, engine_type, engine_dir, material_id, qty, warehouse_id,
    location_id, to_warehouse_id, to_location_id, unit_cost, value, reference, reason, approval_level, requested_by)
  values (v_id, v_co, v_num, p_kind, 'pending', v_etype, v_edir, p_material, v_qty, p_warehouse,
    p_location, case when p_kind = 'transfert' then p_to_warehouse end, case when p_kind = 'transfert' then p_to_location end,
    p_unit_cost, v_value, p_reference, p_reason, v_level, auth.uid());
  perform private.write_audit(v_co, 'stock.request_create', 'stock_request', v_id::text, v_num, null,
    jsonb_build_object('kind', p_kind, 'qty', p_qty, 'value', v_value, 'approval_level', v_level), '{}'::jsonb, 'rpc');

  if v_level = 0 then v_mov := private.stock_request_post(v_id); v_status := 'posted';
  else v_status := 'pending';
  end if;
  return jsonb_build_object('id', v_id, 'number', v_num, 'status', v_status, 'movement_id', v_mov, 'approval_level', v_level);
end $$;

-- Validation : niveau 1 (stock.approve) puis niveau 2 (stock.approve_high) si requis. Le demandeur ne valide jamais.
create function public.stock_request_approve(p_request uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype; v_mov uuid; v_step int;
begin
  select * into r from public.stock_movement_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_REQUEST' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'STOCK_REQUEST_CLOSED' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'STOCK_SELF_APPROVAL' using errcode = '42501'; end if;

  if r.level1_at is null then
    perform private.require_perm('stock.approve');
    v_step := 1;
    update public.stock_movement_requests set level1_by = auth.uid(), level1_at = now() where id = p_request;
  else
    perform private.require_perm('stock.approve_high');
    if r.level1_by = auth.uid() then raise exception 'STOCK_HIERARCHY' using errcode = '42501'; end if;
    v_step := 2;
    update public.stock_movement_requests set level2_by = auth.uid(), level2_at = now() where id = p_request;
  end if;

  if v_step = r.approval_level or v_step = 2 then
    v_mov := private.stock_request_post(p_request);
  end if;
  perform private.write_audit(r.company_id, 'stock.request_approve', 'stock_request', r.id::text, r.number, null,
    jsonb_build_object('step', v_step, 'posted', v_mov is not null, 'movement_id', v_mov), jsonb_build_object('note', p_note), 'rpc');
  return jsonb_build_object('step', v_step, 'status', case when v_mov is not null then 'posted' else 'pending' end, 'movement_id', v_mov);
end $$;

create function public.stock_request_reject(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if length(v_reason) < 3 then raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into r from public.stock_movement_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_REQUEST' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'STOCK_REQUEST_CLOSED' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'STOCK_SELF_APPROVAL' using errcode = '42501'; end if;
  if r.level1_at is null then perform private.require_perm('stock.approve'); else perform private.require_perm('stock.approve_high'); end if;
  update public.stock_movement_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = v_reason where id = p_request;
  perform private.write_audit(r.company_id, 'stock.request_reject', 'stock_request', r.id::text, r.number, null,
    jsonb_build_object('reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

-- Retrait d'une demande en attente : par son auteur, ou par un validateur de niveau 2.
create function public.stock_request_cancel(p_request uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype;
begin
  select * into r from public.stock_movement_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_REQUEST' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'STOCK_REQUEST_CLOSED' using errcode = '55000'; end if;
  if r.requested_by is distinct from auth.uid() then perform private.require_perm('stock.approve_high'); end if;
  update public.stock_movement_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
    decision_note = nullif(btrim(coalesce(p_reason, '')), '') where id = p_request;
  perform private.write_audit(r.company_id, 'stock.request_cancel', 'stock_request', r.id::text, r.number, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Annulation contrôlée : crée une réversion (demande « annulation ») du mouvement d'origine.
create function public.stock_cancel_movement(p_movement uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.stock_movements%rowtype; v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
  v_num text; v_etype text; v_edir text; v_wh uuid; v_loc uuid; v_twh uuid; v_tloc uuid; v_qty numeric; v_unit numeric; v_total numeric;
  v_value numeric; v_level int; v_mov uuid; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('stock.write');
  if length(v_reason) < 5 then raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into m from public.stock_movements where id = p_movement and company_id = v_co;
  if not found then raise exception 'STOCK_BAD_MOVEMENT' using errcode = 'P0002'; end if;
  if m.inventory_id is not null or m.kind in ('annulation', 'inventaire') or m.reversal_of is not null then
    raise exception 'STOCK_CANCEL_FORBIDDEN' using errcode = '42501';
  end if;
  if exists (select 1 from public.stock_movement_requests where reversal_of = m.id and status in ('pending', 'posted')) then
    raise exception 'STOCK_ALREADY_CANCELLED' using errcode = '55000';
  end if;

  v_qty := m.qty;
  select total_cost into v_total from public.stock_movement_costs where movement_id = m.id;
  v_unit := case when m.qty > 0 then v_total / m.qty end;
  case m.type
    when 'in' then
      v_etype := 'out'; v_edir := 'out'; v_wh := m.warehouse_id; v_loc := m.location_id;
    when 'out' then
      if m.location_id is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
      v_etype := 'in'; v_edir := 'in'; v_wh := m.warehouse_id; v_loc := m.location_id;
    when 'transfer' then
      if m.location_id is null or m.to_location_id is null then raise exception 'STOCK_CANCEL_FORBIDDEN' using errcode = '42501'; end if;
      v_etype := 'transfer'; v_edir := 'move'; v_wh := m.to_warehouse_id; v_loc := m.to_location_id;
      v_twh := m.warehouse_id; v_tloc := m.location_id;
    when 'adjustment' then
      v_etype := 'adjustment'; v_edir := case when m.direction = 'in' then 'out' else 'in' end; v_wh := m.warehouse_id; v_loc := m.location_id;
    else raise exception 'STOCK_CANCEL_FORBIDDEN' using errcode = '42501';
  end case;

  v_value := v_qty * coalesce(v_unit, 0);
  v_level := private.stock_approval_level('annulation', v_value);
  v_num := 'DEM-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'stock_request')::text, 6, '0');
  insert into public.stock_movement_requests (id, company_id, number, kind, status, engine_type, engine_dir, material_id, qty, warehouse_id,
    location_id, to_warehouse_id, to_location_id, unit_cost, value, reference, reason, reversal_of, approval_level, requested_by)
  values (v_id, v_co, v_num, 'annulation', 'pending', v_etype, v_edir, m.material_id, v_qty, v_wh,
    v_loc, v_twh, v_tloc, v_unit, v_value, m.number, v_reason, m.id, v_level, auth.uid());
  perform private.write_audit(v_co, 'stock.movement_cancel_request', 'stock_movement', m.id::text, m.number, null,
    jsonb_build_object('request', v_num, 'approval_level', v_level), jsonb_build_object('reason', v_reason), 'rpc');

  if v_level = 0 then v_mov := private.stock_request_post(v_id); end if;
  return jsonb_build_object('id', v_id, 'number', v_num, 'status', case when v_level = 0 then 'posted' else 'pending' end,
    'movement_id', v_mov, 'approval_level', v_level);
end $$;

-- Règles de validation (niveau 2 requis pour les modifier).
create function public.stock_policy_set(p_kind text, p_requires_approval boolean, p_level1 numeric, p_level2 numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('stock.approve_high');
  insert into public.stock_movement_policies (company_id, kind, requires_approval, level1_threshold, level2_threshold, updated_by)
  values (v_co, p_kind, coalesce(p_requires_approval, false), p_level1, p_level2, auth.uid())
  on conflict (company_id, kind) do update set requires_approval = excluded.requires_approval, level1_threshold = excluded.level1_threshold,
    level2_threshold = excluded.level2_threshold, updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'stock.policy_set', 'stock_policy', p_kind, p_kind, null,
    jsonb_build_object('requires_approval', p_requires_approval, 'level1', p_level1, 'level2', p_level2), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Droits d'exécution
-- ---------------------------------------------------------------------
revoke execute on function public.stock_request_create(text, uuid, numeric, uuid, uuid, uuid, uuid, numeric, text, text) from public, anon;
revoke execute on function public.stock_request_approve(uuid, text) from public, anon;
revoke execute on function public.stock_request_reject(uuid, text) from public, anon;
revoke execute on function public.stock_request_cancel(uuid, text) from public, anon;
revoke execute on function public.stock_cancel_movement(uuid, text) from public, anon;
revoke execute on function public.stock_policy_set(text, boolean, numeric, numeric) from public, anon;
grant execute on function public.stock_request_create(text, uuid, numeric, uuid, uuid, uuid, uuid, numeric, text, text) to authenticated;
grant execute on function public.stock_request_approve(uuid, text) to authenticated;
grant execute on function public.stock_request_reject(uuid, text) to authenticated;
grant execute on function public.stock_request_cancel(uuid, text) to authenticated;
grant execute on function public.stock_cancel_movement(uuid, text) to authenticated;
grant execute on function public.stock_policy_set(text, boolean, numeric, numeric) to authenticated;
