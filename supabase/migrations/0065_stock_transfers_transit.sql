-- 0065_stock_transfers_transit — Transferts inter-entrepôts (même société) avec stock en transit.
--
-- Cycle : brouillon → préparé → expédié (stock en transit) → partiellement reçu → reçu ; annulation avant expédition.
--  * Expédition : sortie du stock source vers l'emplacement TRANSIT (entrepôt « transit » de la société) — mouvement 'transfer'.
--  * Réception : sortie du TRANSIT vers l'emplacement de destination, par ligne, partielle possible. Quantité reçue ≤ en transit.
--  * Quantité en transit d'une ligne = expédié − reçu − écart approuvé. Le rapprochement compare le stock du TRANSIT
--    à la somme des quantités en transit de toutes les lignes (public.stock_transit_reconcile).
--  * Double réception : clé d'idempotence par réception (refus TRANSFER_DUPLICATE_RECEIPT), verrou sur le transfert,
--    et contrainte SQL reçu + écart ≤ expédié sur chaque ligne.
--  * Écart : déclaré en attente (motif obligatoire) ; sortie du transit seulement après accord d'un autre utilisateur
--    (SOD_SELF_APPROVAL). Un écart refusé reste en transit.
--  * Preuve : référence du document de transport obligatoire à chaque réception (TRANSFER_PROOF_REQUIRED).
--  * Propriété : seul le stock société voyage. Les unités de propriété client (0062) n'entrent pas dans le stock société
--    et ne peuvent donc pas être expédiées par ce flux.
--  * Intersociétés : NON implémenté. Les documents réciproques (juridiques et financiers) relèvent de OPEN-04 (V2) :
--    un entrepôt d'une autre société est traité comme introuvable (STOCK_WAREHOUSE_NOT_FOUND). Aucune écriture comptable.
--  * Additif : nouveau kind d'entrepôt 'transit' (contrainte élargie), nouvelles tables, nouvelles fonctions. Aucune suppression.
--  Erreurs : TRANSFER_SAME_WAREHOUSE, TRANSFER_TRANSIT_RESERVED, TRANSFER_SOURCE_BLOCKED, TRANSFER_EMPTY, TRANSFER_BAD_QTY,
--  TRANSFER_NOT_FOUND, TRANSFER_LINE_NOT_FOUND, TRANSFER_BAD_STATUS, TRANSFER_NOTHING_PREPARED, TRANSFER_KEY_REQUIRED,
--  TRANSFER_PROOF_REQUIRED, TRANSFER_DUPLICATE_RECEIPT, TRANSFER_OVER_RECEIPT, TRANSFER_REASON_REQUIRED,
--  TRANSFER_NO_LOSS_PENDING, SOD_SELF_APPROVAL, WAREHOUSE_FORBIDDEN, STOCK_INSUFFICIENT, STOCK_RESERVED.

-- ---------------------------------------------------------------------------
-- 1. Entrepôt « transit » (kind additif)
-- ---------------------------------------------------------------------------
alter table public.warehouses drop constraint if exists warehouses_kind_check;
alter table public.warehouses add constraint warehouses_kind_check
  check (kind in ('fabric', 'supplies', 'finished_goods', 'mixed', 'other', 'shop', 'transit'));

-- Passage contrôlé vers l'entrepôt transit uniquement. Le réglage est local à la transaction et posé par les seules RPC de transfert
-- (après contrôle du périmètre source et destination). Aucun autre entrepôt n'est concerné.
create function private.transit_bypass(p_wh uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(current_setting('stock.transfer_rpc', true), '') = 'on'
     and exists (select 1 from public.warehouses w where w.id = p_wh and w.kind = 'transit') $$;
revoke execute on function private.transit_bypass(uuid) from public, anon, authenticated;

-- Gardes d'écriture 0017 : même corps, plus le passage transit.
create or replace function private.wh_write_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_col text := TG_ARGV[0]; v_level text := coalesce(TG_ARGV[1], 'operator'); v_wh uuid;
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_wh := nullif(to_jsonb(old) ->> v_col, '')::uuid;
    if v_wh is not null and not private.wh_can(v_wh, v_level) and not private.transit_bypass(v_wh) then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_wh := nullif(to_jsonb(new) ->> v_col, '')::uuid;
    if v_wh is not null and not private.wh_can(v_wh, v_level) and not private.transit_bypass(v_wh) then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;

create or replace function private.warehouses_access_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.kind = 'transit' and coalesce(current_setting('stock.transfer_rpc', true), '') = 'on' then return new; end if;
    if not private.has_perm('warehouses.manage') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  elsif tg_op = 'UPDATE' then
    if not private.wh_can(old.id, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  else
    if not private.has_perm('warehouses.manage') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;

-- Emplacement TRANSIT de la société (créé à la demande). Aucun utilisateur n'y est affecté : accès par les fonctions seulement.
create function private.transit_location(p_company uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_wh uuid; v_loc uuid;
begin
  perform set_config('stock.transfer_rpc', 'on', true);
  select id into v_wh from public.warehouses where company_id = p_company and kind = 'transit' order by created_at limit 1;
  if v_wh is null then
    insert into public.warehouses (company_id, name, kind) values (p_company, 'Transit (stock en route)', 'transit') returning id into v_wh;
  end if;
  select id into v_loc from public.stock_locations where warehouse_id = v_wh and code = 'TRANSIT';
  if v_loc is null then
    insert into public.stock_locations (company_id, warehouse_id, code, name, kind)
    values (p_company, v_wh, 'TRANSIT', 'En route', 'shipping') returning id into v_loc;
  end if;
  return v_loc;
end $$;
revoke execute on function private.transit_location(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.stock_transfers (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number             text not null,
  status             text not null default 'draft' check (status in ('draft', 'prepared', 'shipped', 'partially_received', 'received', 'cancelled')),
  from_warehouse_id  uuid not null references public.warehouses(id),
  from_location_id   uuid not null references public.stock_locations(id),
  to_warehouse_id    uuid not null references public.warehouses(id),
  to_location_id     uuid not null references public.stock_locations(id),
  note               text check (note is null or length(note) <= 500),
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid(),
  shipped_at         timestamptz,
  shipped_by         uuid,
  received_at        timestamptz,
  cancelled_at       timestamptz,
  unique (company_id, number),
  check (from_warehouse_id <> to_warehouse_id)
);
create table public.stock_transfer_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  transfer_id   uuid not null references public.stock_transfers(id) on delete restrict,
  seq           int not null check (seq > 0),
  material_id   uuid not null references public.bom_materials(id),
  qty_requested numeric(14,4) not null check (qty_requested > 0),
  qty_prepared  numeric(14,4) not null default 0 check (qty_prepared >= 0),
  qty_shipped   numeric(14,4) not null default 0 check (qty_shipped >= 0),
  qty_received  numeric(14,4) not null default 0 check (qty_received >= 0),
  qty_lost      numeric(14,4) not null default 0 check (qty_lost >= 0),
  unique (transfer_id, seq),
  check (qty_prepared <= qty_requested),
  check (qty_shipped <= qty_prepared),
  check (qty_received + qty_lost <= qty_shipped)            -- pas de double réception : jamais plus que expédié
);
-- Historique en ajout seul
create table public.stock_transfer_events (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  transfer_id  uuid not null references public.stock_transfers(id) on delete restrict,
  line_id      uuid references public.stock_transfer_lines(id) on delete restrict,
  event        text not null check (event in ('prepared', 'shipped', 'received', 'loss_declared', 'loss_approved', 'loss_refused', 'cancelled')),
  qty          numeric(14,4),
  movement_id  uuid references public.stock_movements(id),
  note         text check (note is null or length(note) <= 500),
  actor        uuid default auth.uid(),
  at           timestamptz not null default now()
);
-- Réceptions : une ligne par ligne reçue ; la clé d'idempotence regroupe une soumission
create table public.stock_transfer_receipts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  transfer_id     uuid not null references public.stock_transfers(id) on delete restrict,
  line_id         uuid not null references public.stock_transfer_lines(id) on delete restrict,
  qty             numeric(14,4) not null check (qty > 0),
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  proof_ref       text not null check (length(btrim(proof_ref)) between 3 and 120),
  movement_id     uuid not null references public.stock_movements(id),
  received_by     uuid default auth.uid(),
  received_at     timestamptz not null default now(),
  unique (company_id, transfer_id, idempotency_key, line_id)
);
-- Écarts de transit : en attente puis approuvé ou refusé ; le demandeur ne peut pas être l'approbateur
create table public.stock_transfer_losses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  transfer_id  uuid not null references public.stock_transfers(id) on delete restrict,
  line_id      uuid not null references public.stock_transfer_lines(id) on delete restrict,
  qty          numeric(14,4) not null check (qty > 0),
  reason       text not null check (length(btrim(reason)) between 5 and 500),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'refused')),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  decided_by   uuid,
  decided_at   timestamptz,
  movement_id  uuid references public.stock_movements(id),
  check (status = 'pending' or decided_by is distinct from requested_by)
);

create trigger stock_transfer_events_immutable before update or delete on public.stock_transfer_events for each row execute function private.stock_immutable();
create trigger stock_transfer_receipts_immutable before update or delete on public.stock_transfer_receipts for each row execute function private.stock_immutable();

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_lines enable row level security;
alter table public.stock_transfer_events enable row level security;
alter table public.stock_transfer_receipts enable row level security;
alter table public.stock_transfer_losses enable row level security;
create policy stock_transfers_select on public.stock_transfers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read')
    and (private.wh_can(from_warehouse_id, 'viewer') or private.wh_can(to_warehouse_id, 'viewer')));
create policy stock_transfer_lines_select on public.stock_transfer_lines for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.stock_transfers t where t.id = transfer_id
    and private.has_perm('stock.read') and (private.wh_can(t.from_warehouse_id, 'viewer') or private.wh_can(t.to_warehouse_id, 'viewer'))));
create policy stock_transfer_events_select on public.stock_transfer_events for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.stock_transfers t where t.id = transfer_id
    and private.has_perm('stock.read') and (private.wh_can(t.from_warehouse_id, 'viewer') or private.wh_can(t.to_warehouse_id, 'viewer'))));
create policy stock_transfer_receipts_select on public.stock_transfer_receipts for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.stock_transfers t where t.id = transfer_id
    and private.has_perm('stock.read') and (private.wh_can(t.from_warehouse_id, 'viewer') or private.wh_can(t.to_warehouse_id, 'viewer'))));
create policy stock_transfer_losses_select on public.stock_transfer_losses for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.stock_transfers t where t.id = transfer_id
    and private.has_perm('stock.read') and (private.wh_can(t.from_warehouse_id, 'viewer') or private.wh_can(t.to_warehouse_id, 'viewer'))));
revoke all on public.stock_transfers, public.stock_transfer_lines, public.stock_transfer_events, public.stock_transfer_receipts, public.stock_transfer_losses from public, anon, authenticated;
grant select on public.stock_transfers, public.stock_transfer_lines, public.stock_transfer_events, public.stock_transfer_receipts, public.stock_transfer_losses to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Statut recalculé à partir des quantités (une seule source de vérité)
-- ---------------------------------------------------------------------------
create function private.transfer_refresh(p_transfer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.stock_transfers%rowtype; v_open boolean; v_recv numeric;
begin
  select * into t from public.stock_transfers where id = p_transfer for update;
  if t.status not in ('shipped', 'partially_received', 'received') then return; end if;
  select exists (select 1 from public.stock_transfer_lines where transfer_id = p_transfer and qty_shipped - qty_received - qty_lost > 0),
         coalesce(sum(qty_received), 0)
    into v_open, v_recv from public.stock_transfer_lines where transfer_id = p_transfer;
  if v_open then
    update public.stock_transfers set status = case when v_recv > 0 then 'partially_received' else 'shipped' end where id = p_transfer;
  else
    update public.stock_transfers set status = 'received', received_at = coalesce(received_at, now()) where id = p_transfer;
  end if;
end $$;
revoke execute on function private.transfer_refresh(uuid) from public, anon, authenticated;

-- Quantité encore reçue possible = expédié − reçu − écart approuvé − écart en attente
create function private.transfer_line_left(p_line uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select l.qty_shipped - l.qty_received - l.qty_lost
         - coalesce((select sum(s.qty) from public.stock_transfer_losses s where s.line_id = l.id and s.status = 'pending'), 0)
  from public.stock_transfer_lines l where l.id = p_line $$;
revoke execute on function private.transfer_line_left(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Création, préparation, expédition
-- ---------------------------------------------------------------------------
create function public.stock_transfer_create(p_from_wh uuid, p_from_loc uuid, p_to_wh uuid, p_to_loc uuid, p_note text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_no text; v_fw public.warehouses%rowtype; v_tw public.warehouses%rowtype;
  v_fl public.stock_locations%rowtype; v_tl public.stock_locations%rowtype; e jsonb; v_seq int := 0; v_mat uuid; v_qty numeric;
begin
  perform private.require_perm('stock.write');
  if not private.wh_can(p_from_wh, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if p_from_wh = p_to_wh then raise exception 'TRANSFER_SAME_WAREHOUSE' using errcode = '22023'; end if;
  select * into v_fw from public.warehouses where id = p_from_wh and company_id = v_co;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_tw from public.warehouses where id = p_to_wh and company_id = v_co;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_fw.kind = 'transit' or v_tw.kind = 'transit' then raise exception 'TRANSFER_TRANSIT_RESERVED' using errcode = '22023'; end if;
  if v_fw.archived_at is not null or v_tw.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  select * into v_fl from public.stock_locations where id = p_from_loc and warehouse_id = p_from_wh and company_id = v_co;
  if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_fl.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
  if v_fl.kind = 'quarantine' then raise exception 'TRANSFER_SOURCE_BLOCKED' using errcode = '55000'; end if;
  select * into v_tl from public.stock_locations where id = p_to_loc and warehouse_id = p_to_wh and company_id = v_co;
  if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_tl.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'TRANSFER_EMPTY' using errcode = '22023'; end if;
  v_no := 'TRF-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'stock_transfer')::text, 6, '0');
  insert into public.stock_transfers (id, company_id, number, from_warehouse_id, from_location_id, to_warehouse_id, to_location_id, note, created_by)
  values (v_id, v_co, v_no, p_from_wh, p_from_loc, p_to_wh, p_to_loc, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  for e in select j.value from jsonb_array_elements(p_lines) j loop
    v_qty := nullif(e ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
    v_mat := (e ->> 'material_id')::uuid;
    if not exists (select 1 from public.bom_materials where id = v_mat and company_id = v_co) then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
    v_seq := v_seq + 1;
    insert into public.stock_transfer_lines (company_id, transfer_id, seq, material_id, qty_requested) values (v_co, v_id, v_seq, v_mat, v_qty);
  end loop;
  perform private.write_audit(v_co, 'stock.transfer_create', 'transfer', v_id::text, v_no, null,
    jsonb_build_object('from_wh', p_from_wh, 'to_wh', p_to_wh, 'lines', v_seq), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.stock_transfer_prepare(p_transfer uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.stock_transfers%rowtype; e jsonb; l public.stock_transfer_lines%rowtype; v_qty numeric; v_total numeric := 0;
begin
  perform private.require_perm('stock.write');
  select * into t from public.stock_transfers where id = p_transfer and company_id = v_co for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(t.from_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if t.status not in ('draft', 'prepared') then raise exception 'TRANSFER_BAD_STATUS' using errcode = '55000'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
  for e in select j.value from jsonb_array_elements(p_lines) j loop
    v_qty := nullif(e ->> 'qty', '')::numeric;
    if v_qty is null or v_qty < 0 then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
    select * into l from public.stock_transfer_lines where id = (e ->> 'line_id')::uuid and transfer_id = t.id for update;
    if not found then raise exception 'TRANSFER_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_qty > l.qty_requested then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
    update public.stock_transfer_lines set qty_prepared = v_qty where id = l.id;
    v_total := v_total + v_qty;
  end loop;
  if exists (select 1 from public.stock_transfer_lines where transfer_id = t.id and qty_prepared > 0) then
    update public.stock_transfers set status = 'prepared' where id = t.id;
  end if;
  insert into public.stock_transfer_events (company_id, transfer_id, event, qty) values (v_co, t.id, 'prepared', v_total);
  perform private.write_audit(v_co, 'stock.transfer_prepare', 'transfer', t.id::text, t.number, null, jsonb_build_object('qty_prepared', v_total), '{}'::jsonb, 'rpc');
end $$;

create function public.stock_transfer_ship(p_transfer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.stock_transfers%rowtype; l record; v_transit uuid; v_mov uuid; v_n int := 0; v_total numeric := 0;
begin
  perform private.require_perm('stock.write');
  select * into t from public.stock_transfers where id = p_transfer and company_id = v_co for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(t.from_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if t.status <> 'prepared' then raise exception 'TRANSFER_BAD_STATUS' using errcode = '55000'; end if;
  v_transit := private.transit_location(v_co);
  for l in select * from public.stock_transfer_lines where transfer_id = t.id and qty_prepared > qty_shipped order by seq for update loop
    v_mov := public.stock_move('transfer', l.material_id, l.qty_prepared - l.qty_shipped, t.from_warehouse_id, t.from_location_id, v_transit, t.number, 'Expédition ' || t.number, null, null);
    update public.stock_transfer_lines set qty_shipped = qty_prepared where id = l.id;
    insert into public.stock_transfer_events (company_id, transfer_id, line_id, event, qty, movement_id)
      values (v_co, t.id, l.id, 'shipped', l.qty_prepared - l.qty_shipped, v_mov);
    v_n := v_n + 1; v_total := v_total + (l.qty_prepared - l.qty_shipped);
  end loop;
  if v_n = 0 then raise exception 'TRANSFER_NOTHING_PREPARED' using errcode = '55000'; end if;
  update public.stock_transfers set status = 'shipped', shipped_at = now(), shipped_by = auth.uid() where id = t.id;
  perform private.write_audit(v_co, 'stock.transfer_ship', 'transfer', t.id::text, t.number, null, jsonb_build_object('lines', v_n, 'qty', v_total), '{}'::jsonb, 'rpc');
  return jsonb_build_object('number', t.number, 'lines', v_n, 'qty', v_total);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Réception partielle (preuve et clé d'idempotence), écarts
-- ---------------------------------------------------------------------------
create function public.stock_transfer_receive(p_transfer uuid, p_key text, p_proof text, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.stock_transfers%rowtype; e jsonb; l public.stock_transfer_lines%rowtype;
  v_key text := btrim(coalesce(p_key, '')); v_proof text := btrim(coalesce(p_proof, '')); v_transit uuid; v_mov uuid; v_qty numeric; v_n int := 0; v_total numeric := 0;
begin
  perform private.require_perm('stock.write');
  select * into t from public.stock_transfers where id = p_transfer and company_id = v_co for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(t.to_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if t.status not in ('shipped', 'partially_received') then raise exception 'TRANSFER_BAD_STATUS' using errcode = '55000'; end if;
  if length(v_key) < 8 then raise exception 'TRANSFER_KEY_REQUIRED' using errcode = '22023'; end if;
  if length(v_proof) < 3 then raise exception 'TRANSFER_PROOF_REQUIRED' using errcode = '22023'; end if;
  if exists (select 1 from public.stock_transfer_receipts where transfer_id = t.id and company_id = v_co and idempotency_key = v_key) then
    raise exception 'TRANSFER_DUPLICATE_RECEIPT' using errcode = '23505';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
  if not exists (select 1 from public.stock_locations where id = t.to_location_id and archived_at is null) then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
  v_transit := private.transit_location(v_co);
  for e in select j.value from jsonb_array_elements(p_lines) j loop
    v_qty := nullif(e ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
    select * into l from public.stock_transfer_lines where id = (e ->> 'line_id')::uuid and transfer_id = t.id for update;
    if not found then raise exception 'TRANSFER_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_qty > private.transfer_line_left(l.id) then raise exception 'TRANSFER_OVER_RECEIPT' using errcode = '22023'; end if;
    v_mov := public.stock_move('transfer', l.material_id, v_qty, (select warehouse_id from public.stock_locations where id = v_transit), v_transit,
                               t.to_location_id, t.number, 'Réception ' || t.number, null, null);
    update public.stock_transfer_lines set qty_received = qty_received + v_qty where id = l.id;
    insert into public.stock_transfer_receipts (company_id, transfer_id, line_id, qty, idempotency_key, proof_ref, movement_id)
      values (v_co, t.id, l.id, v_qty, v_key, v_proof, v_mov);
    insert into public.stock_transfer_events (company_id, transfer_id, line_id, event, qty, movement_id, note)
      values (v_co, t.id, l.id, 'received', v_qty, v_mov, v_proof);
    v_n := v_n + 1; v_total := v_total + v_qty;
  end loop;
  perform private.transfer_refresh(t.id);
  perform private.write_audit(v_co, 'stock.transfer_receive', 'transfer', t.id::text, t.number, null,
    jsonb_build_object('lines', v_n, 'qty', v_total, 'proof', v_proof), '{}'::jsonb, 'rpc');
  return jsonb_build_object('number', t.number, 'lines', v_n, 'qty', v_total,
    'status', (select status from public.stock_transfers where id = t.id));
end $$;

create function public.stock_transfer_declare_loss(p_transfer uuid, p_line uuid, p_qty numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.stock_transfers%rowtype; l public.stock_transfer_lines%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('stock.write');
  select * into t from public.stock_transfers where id = p_transfer and company_id = v_co for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(t.to_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if t.status not in ('shipped', 'partially_received') then raise exception 'TRANSFER_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'TRANSFER_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'TRANSFER_BAD_QTY' using errcode = '22023'; end if;
  select * into l from public.stock_transfer_lines where id = p_line and transfer_id = t.id for update;
  if not found then raise exception 'TRANSFER_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_qty > private.transfer_line_left(l.id) then raise exception 'TRANSFER_OVER_RECEIPT' using errcode = '22023'; end if;
  insert into public.stock_transfer_losses (id, company_id, transfer_id, line_id, qty, reason, requested_by)
  values (v_id, v_co, t.id, l.id, p_qty, btrim(p_reason), auth.uid());
  insert into public.stock_transfer_events (company_id, transfer_id, line_id, event, qty, note)
    values (v_co, t.id, l.id, 'loss_declared', p_qty, btrim(p_reason));
  perform private.write_audit(v_co, 'stock.transfer_loss_declare', 'transfer', t.id::text, t.number, null,
    jsonb_build_object('loss', v_id, 'qty', p_qty), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.stock_transfer_decide_loss(p_loss uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.stock_transfer_losses%rowtype; t public.stock_transfers%rowtype; l public.stock_transfer_lines%rowtype; v_transit uuid; v_mov uuid;
begin
  perform private.require_perm('stock.adjust');
  select * into s from public.stock_transfer_losses where id = p_loss and company_id = v_co for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into t from public.stock_transfers where id = s.transfer_id for update;
  if not private.wh_can(t.to_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if s.status <> 'pending' then raise exception 'TRANSFER_NO_LOSS_PENDING' using errcode = '55000'; end if;
  if s.requested_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  if p_approve then
    select * into l from public.stock_transfer_lines where id = s.line_id for update;
    v_transit := private.transit_location(v_co);
    v_mov := public.stock_move('out', l.material_id, s.qty, (select warehouse_id from public.stock_locations where id = v_transit), v_transit,
                               null, t.number, 'Écart de transit approuvé : ' || s.reason, null, null);
    update public.stock_transfer_lines set qty_lost = qty_lost + s.qty where id = l.id;
    update public.stock_transfer_losses set status = 'approved', decided_by = auth.uid(), decided_at = now(), movement_id = v_mov where id = s.id;
    insert into public.stock_transfer_events (company_id, transfer_id, line_id, event, qty, movement_id, note)
      values (v_co, t.id, l.id, 'loss_approved', s.qty, v_mov, s.reason);
  else
    update public.stock_transfer_losses set status = 'refused', decided_by = auth.uid(), decided_at = now() where id = s.id;
    insert into public.stock_transfer_events (company_id, transfer_id, line_id, event, qty, note)
      values (v_co, t.id, s.line_id, 'loss_refused', s.qty, s.reason);
  end if;
  perform private.transfer_refresh(t.id);
  perform private.write_audit(v_co, 'stock.transfer_loss_decide', 'transfer', t.id::text, t.number, jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'refused' end, 'qty', s.qty), '{}'::jsonb, 'rpc');
end $$;

create function public.stock_transfer_cancel(p_transfer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.stock_transfers%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into t from public.stock_transfers where id = p_transfer and company_id = v_co for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(t.from_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if t.status not in ('draft', 'prepared') then raise exception 'TRANSFER_BAD_STATUS' using errcode = '55000'; end if;
  update public.stock_transfers set status = 'cancelled', cancelled_at = now() where id = t.id;
  insert into public.stock_transfer_events (company_id, transfer_id, event) values (v_co, t.id, 'cancelled');
  perform private.write_audit(v_co, 'stock.transfer_cancel', 'transfer', t.id::text, t.number, jsonb_build_object('status', t.status),
    jsonb_build_object('status', 'cancelled'), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Lecture : détail avec quantités exactes par ligne, et rapprochement du transit
-- ---------------------------------------------------------------------------
create function public.stock_transfer_detail(p_transfer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.stock_transfers%rowtype; v_lines jsonb; v_rec jsonb; v_loss jsonb; v_ev jsonb;
begin
  perform private.require_perm('stock.read');
  select * into t from public.stock_transfers where id = p_transfer and company_id = v_co;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not (private.wh_can(t.from_warehouse_id, 'viewer') or private.wh_can(t.to_warehouse_id, 'viewer')) then
    raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_id', id, 'seq', seq, 'material_id', material_id, 'qty_requested', qty_requested,
           'qty_prepared', qty_prepared, 'qty_shipped', qty_shipped, 'qty_received', qty_received, 'qty_lost', qty_lost,
           'qty_pending_loss', coalesce((select sum(s.qty) from public.stock_transfer_losses s where s.line_id = l.id and s.status = 'pending'), 0),
           'in_transit', qty_shipped - qty_received - qty_lost) order by seq), '[]'::jsonb)
    into v_lines from public.stock_transfer_lines l where l.transfer_id = t.id;
  select coalesce(jsonb_agg(jsonb_build_object('receipt_id', r.id, 'line_id', r.line_id, 'qty', r.qty, 'proof_ref', r.proof_ref,
           'idempotency_key', r.idempotency_key, 'received_at', r.received_at) order by r.received_at), '[]'::jsonb)
    into v_rec from public.stock_transfer_receipts r where r.transfer_id = t.id;
  select coalesce(jsonb_agg(jsonb_build_object('loss_id', s.id, 'line_id', s.line_id, 'qty', s.qty, 'reason', s.reason, 'status', s.status,
           'requested_at', s.requested_at, 'decided_at', s.decided_at) order by s.requested_at), '[]'::jsonb)
    into v_loss from public.stock_transfer_losses s where s.transfer_id = t.id;
  select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'qty', e.qty, 'at', e.at, 'movement_id', e.movement_id) order by e.at), '[]'::jsonb)
    into v_ev from public.stock_transfer_events e where e.transfer_id = t.id;
  return jsonb_build_object('id', t.id, 'number', t.number, 'status', t.status, 'from_warehouse_id', t.from_warehouse_id,
    'to_warehouse_id', t.to_warehouse_id, 'to_location_id', t.to_location_id, 'lines', v_lines, 'receipts', v_rec, 'losses', v_loss, 'events', v_ev);
end $$;

-- Rapprochement : stock du TRANSIT (lots) = somme des quantités en transit de toutes les lignes, par matière.
create function public.stock_transit_reconcile(p_material uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_wh uuid; v_on_hand numeric; v_open numeric;
begin
  perform private.require_perm('stock.adjust');
  select warehouse_id into v_wh from public.stock_locations where id = private.transit_location(v_co);
  select coalesce(sum(qty_remaining), 0) into v_on_hand from public.stock_lots where company_id = v_co and material_id = p_material and warehouse_id = v_wh;
  select coalesce(sum(l.qty_shipped - l.qty_received - l.qty_lost), 0) into v_open
    from public.stock_transfer_lines l where l.company_id = v_co and l.material_id = p_material;
  return jsonb_build_object('material_id', p_material, 'transit_on_hand', v_on_hand, 'open_in_transit', v_open, 'difference', v_on_hand - v_open);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.stock_transfer_create(uuid, uuid, uuid, uuid, text, jsonb), public.stock_transfer_prepare(uuid, jsonb),
  public.stock_transfer_ship(uuid), public.stock_transfer_receive(uuid, text, text, jsonb), public.stock_transfer_declare_loss(uuid, uuid, numeric, text),
  public.stock_transfer_decide_loss(uuid, boolean), public.stock_transfer_cancel(uuid), public.stock_transfer_detail(uuid), public.stock_transit_reconcile(uuid)
  from public, anon;
grant execute on function public.stock_transfer_create(uuid, uuid, uuid, uuid, text, jsonb), public.stock_transfer_prepare(uuid, jsonb),
  public.stock_transfer_ship(uuid), public.stock_transfer_receive(uuid, text, text, jsonb), public.stock_transfer_declare_loss(uuid, uuid, numeric, text),
  public.stock_transfer_decide_loss(uuid, boolean), public.stock_transfer_cancel(uuid), public.stock_transfer_detail(uuid), public.stock_transit_reconcile(uuid)
  to authenticated;
