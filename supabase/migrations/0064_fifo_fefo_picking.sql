-- 0064_fifo_fefo_picking — Lots à date d'expiration, règle de sortie FIFO/FEFO, proposition de lots,
-- liste de prélèvement avec scan de lot, substitution de lot soumise à accord, sortie du lot exact.
--
-- Principes :
--  * La RÈGLE DE SORTIE (FIFO ou FEFO) choisit quel lot proposer. Elle ne change pas la VALORISATION :
--    la méthode de valorisation reste le coût du lot (stock_lot_costs, existant). Les deux sont stockées séparément.
--  * Additif : colonnes nullables sur stock_lots ; aucune table existante n'est supprimée ni recréée.
--  * Lot échu ou en quarantaine : exclu de la proposition, refusé à la substitution et à la confirmation.
--  * Un scan erroné est ENREGISTRÉ (compteur, audit) sans annuler la transaction : la fonction retourne ok=false.
--  * Substitution de lot : demandeur ≠ approbateur (SOD_SELF_APPROVAL) ; la ligne reste bloquée tant qu'elle n'est pas tranchée.
--  * Confirmation atomique : tous les lots de la liste sont sortis ou aucun.
--  * Scope : écritures exigent private.wh_can(entrepôt, 'operator') ; lecture exige 'viewer'.
--  * Sortie de lot : passe par des mouvements 'out' liés à la liste (journal immuable, 0018/0063) ; réservations respectées.
--  Erreurs : STOCK_EXIT_RULE_INVALID, LOT_CODE_REQUIRED, LOT_EXPIRED_AT_RECEIPT, LOT_EXPIRY_MISMATCH, PICK_BAD_QTY,
--  PICK_SHORT, PICK_BAD_STATUS, PICK_NOT_SCANNED, PICK_SUBSTITUTION_PENDING, PICK_NO_SUBSTITUTION, PICK_REASON_REQUIRED,
--  PICK_SUBSTITUTE_INVALID, PICK_LINE_NOT_FOUND, PICK_LOT_NOT_FOUND, PICK_LOT_MISMATCH, LOT_EXPIRED, LOT_BLOCKED,
--  STOCK_INSUFFICIENT, STOCK_RESERVED, WAREHOUSE_FORBIDDEN, SOD_SELF_APPROVAL.

-- ---------------------------------------------------------------------------
-- 1. Règle de sortie et méthode de valorisation (par société)
-- ---------------------------------------------------------------------------
create table public.stock_exit_policies (
  company_id       uuid primary key references public.companies(id) on delete cascade,
  exit_rule        text not null default 'fifo' check (exit_rule in ('fifo', 'fefo')),
  valuation_method text not null default 'lot_cost' check (valuation_method = 'lot_cost'),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid()
);
alter table public.stock_exit_policies enable row level security;
create policy stock_exit_policies_select on public.stock_exit_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
revoke all on public.stock_exit_policies from public, anon, authenticated;
grant select on public.stock_exit_policies to authenticated;

create function private.stock_exit_rule(p_company uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select exit_rule from public.stock_exit_policies where company_id = p_company), 'fifo') $$;
revoke execute on function private.stock_exit_rule(uuid) from public, anon, authenticated;

create function public.stock_exit_policy_get() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('stock.read');
  return jsonb_build_object('exit_rule', private.stock_exit_rule(private.current_company()), 'valuation_method', 'lot_cost');
end $$;

create function public.stock_exit_policy_set(p_rule text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_before text;
begin
  perform private.require_perm('stock.adjust');
  if p_rule is null or p_rule not in ('fifo', 'fefo') then raise exception 'STOCK_EXIT_RULE_INVALID' using errcode = '22023'; end if;
  v_before := private.stock_exit_rule(v_co);
  insert into public.stock_exit_policies (company_id, exit_rule) values (v_co, p_rule)
  on conflict (company_id) do update set exit_rule = excluded.exit_rule, updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'stock.exit_policy', 'company', v_co::text, 'règle de sortie', jsonb_build_object('exit_rule', v_before),
    jsonb_build_object('exit_rule', p_rule), jsonb_build_object('valuation_method', 'lot_cost'), 'rpc');
  return p_rule;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Lots : code et date d'expiration (additifs)
-- ---------------------------------------------------------------------------
alter table public.stock_lots
  add column lot_code    text check (lot_code is null or length(btrim(lot_code)) between 2 and 40),
  add column expiry_date date;
create index stock_lots_fefo_idx on public.stock_lots (material_id, warehouse_id, expiry_date, received_at, id) where qty_remaining > 0;

-- Entrée avec lot : refuse une date déjà échue ; même code = même date d'expiration.
create function public.stock_receive_lot(p_material uuid, p_warehouse uuid, p_location uuid, p_qty numeric, p_lot_code text,
                                         p_expiry date, p_reference text, p_reason text, p_unit_cost numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_code text := nullif(btrim(coalesce(p_lot_code, '')), ''); v_mov uuid; v_prev record;
begin
  perform private.require_perm('stock.write');
  if not private.wh_can(p_warehouse, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if v_code is null or length(v_code) < 2 then raise exception 'LOT_CODE_REQUIRED' using errcode = '22023'; end if;
  if p_expiry is not null and p_expiry < current_date then raise exception 'LOT_EXPIRED_AT_RECEIPT' using errcode = '22023'; end if;
  select expiry_date into v_prev from public.stock_lots where company_id = v_co and material_id = p_material and lot_code = v_code limit 1;
  if found and v_prev.expiry_date is distinct from p_expiry then raise exception 'LOT_EXPIRY_MISMATCH' using errcode = '22023'; end if;
  v_mov := public.stock_move('in', p_material, p_qty, p_warehouse, p_location, null, p_reference, p_reason, p_unit_cost, null);
  update public.stock_lots set lot_code = v_code, expiry_date = p_expiry where source_movement = v_mov;
  perform private.write_audit(v_co, 'stock.receive_lot', 'stock', p_material::text, v_code, null,
    jsonb_build_object('qty', p_qty, 'expiry_date', p_expiry), jsonb_build_object('movement', v_mov), 'rpc');
  return v_mov;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Proposition de lots (FIFO ou FEFO) — jamais de lot échu ni en quarantaine
-- ---------------------------------------------------------------------------
-- Quantité libre par lot = stock du lot − quantités des listes de prélèvement ouvertes sur ce lot.
create function private.stock_pick_plan(p_material uuid, p_wh uuid, p_qty numeric, p_rule text)
returns table (seq int, lot_id uuid, lot_code text, location_id uuid, qty numeric, expiry_date date, received_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare r record; v_need numeric := p_qty; v_take numeric; v_n int := 0;
begin
  for r in
    select sl.id as lid, sl.lot_code as lcode, sl.location_id as lloc, free.q as fq, sl.expiry_date as lexp, sl.received_at as lrec
    from public.stock_lots sl
    join public.stock_locations loc on loc.id = sl.location_id
    cross join lateral (select sl.qty_remaining - coalesce((select sum(pl.qty) from public.stock_pick_lines pl
                          join public.stock_pick_lists pk on pk.id = pl.pick_id
                          where pl.lot_id = sl.id and pk.status = 'open'), 0) as q) free
    where sl.company_id = private.current_company() and sl.material_id = p_material and sl.warehouse_id = p_wh
      and loc.kind <> 'quarantine' and (sl.expiry_date is null or sl.expiry_date >= current_date) and free.q > 0
    order by case when p_rule = 'fefo' then sl.expiry_date end asc nulls last, sl.received_at, sl.id
  loop
    exit when v_need <= 0;
    v_take := least(r.fq, v_need);
    v_n := v_n + 1;
    seq := v_n; lot_id := r.lid; lot_code := r.lcode; location_id := r.lloc; qty := v_take; expiry_date := r.lexp; received_at := r.lrec;
    return next;
    v_need := v_need - v_take;
  end loop;
end $$;
revoke execute on function private.stock_pick_plan(uuid, uuid, numeric, text) from public, anon, authenticated;

-- Disponible = quantité libre des lots éligibles − réservations actives de la matière dans l'entrepôt.
create function private.stock_pick_available(p_material uuid, p_wh uuid, p_rule text) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(coalesce((select sum(p.qty) from private.stock_pick_plan(p_material, p_wh, 999999999999, p_rule) p), 0)
                  - private.stock_reserved(p_material, p_wh), 0) $$;
revoke execute on function private.stock_pick_available(uuid, uuid, text) from public, anon, authenticated;

create function public.stock_pick_proposal(p_material uuid, p_warehouse uuid, p_qty numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_rule text; v_avail numeric; v_lines jsonb; v_proposed numeric; v_excl jsonb;
begin
  perform private.require_perm('stock.read');
  if not private.wh_can(p_warehouse, 'viewer') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'PICK_BAD_QTY' using errcode = '22023'; end if;
  v_rule := private.stock_exit_rule(v_co);
  v_avail := private.stock_pick_available(p_material, p_warehouse, v_rule);
  select coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'lot_id', lot_id, 'lot_code', lot_code, 'location_id', location_id,
           'qty', qty, 'expiry_date', expiry_date, 'received_at', received_at) order by seq), '[]'::jsonb),
         coalesce(sum(qty), 0)
    into v_lines, v_proposed
    from private.stock_pick_plan(p_material, p_warehouse, least(p_qty, v_avail), v_rule);
  select coalesce(jsonb_agg(jsonb_build_object('lot_id', sl.id, 'lot_code', sl.lot_code, 'location_id', sl.location_id,
           'qty', sl.qty_remaining, 'reason', case when loc.kind = 'quarantine' then 'BLOCKED' else 'EXPIRED' end) order by sl.received_at), '[]'::jsonb)
    into v_excl
    from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
    where sl.company_id = v_co and sl.material_id = p_material and sl.warehouse_id = p_warehouse and sl.qty_remaining > 0
      and (loc.kind = 'quarantine' or (sl.expiry_date is not null and sl.expiry_date < current_date));
  return jsonb_build_object('rule', v_rule, 'valuation_method', 'lot_cost', 'requested', p_qty, 'available', v_avail,
    'proposed', v_proposed, 'short', greatest(p_qty - v_avail, 0), 'lines', v_lines, 'excluded', v_excl);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Liste de prélèvement
-- ---------------------------------------------------------------------------
create table public.stock_pick_lists (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  warehouse_id  uuid not null references public.warehouses(id),
  material_id   uuid not null references public.bom_materials(id),
  qty_requested numeric(14,4) not null check (qty_requested > 0),
  exit_rule     text not null check (exit_rule in ('fifo', 'fefo')),
  status        text not null default 'open' check (status in ('open', 'confirmed', 'cancelled')),
  note          text check (note is null or length(note) <= 500),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  confirmed_at  timestamptz,
  confirmed_by  uuid,
  cancelled_at  timestamptz,
  unique (company_id, number)
);
create table public.stock_pick_lines (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null default private.current_company() references public.companies(id) on delete cascade,
  pick_id                  uuid not null references public.stock_pick_lists(id) on delete restrict,
  seq                      int not null check (seq > 0),
  lot_id                   uuid not null references public.stock_lots(id),
  lot_code                 text,
  location_id              uuid not null references public.stock_locations(id),
  qty                      numeric(14,4) not null check (qty > 0),
  proposed_lot_id          uuid not null references public.stock_lots(id),
  scanned                  boolean not null default false,
  scan_errors              int not null default 0 check (scan_errors >= 0),
  substitute_lot_id        uuid references public.stock_lots(id),
  substitution_status      text not null default 'none' check (substitution_status in ('none', 'pending', 'approved', 'refused')),
  substitution_reason      text check (substitution_reason is null or length(substitution_reason) between 5 and 500),
  substitution_requested_by uuid,
  substitution_decided_by  uuid,
  substitution_decided_at  timestamptz,
  movement_id              uuid references public.stock_movements(id),
  unique (pick_id, seq)
);
alter table public.stock_pick_lists enable row level security;
alter table public.stock_pick_lines enable row level security;
create policy stock_pick_lists_select on public.stock_pick_lists for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.wh_can(warehouse_id, 'viewer'));
create policy stock_pick_lines_select on public.stock_pick_lines for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.stock_pick_lists pk
          where pk.id = pick_id and private.has_perm('stock.read') and private.wh_can(pk.warehouse_id, 'viewer')));
revoke all on public.stock_pick_lists, public.stock_pick_lines from public, anon, authenticated;
grant select on public.stock_pick_lists, public.stock_pick_lines to authenticated;

-- Contrôle d'un lot de substitution (ou d'un lot à sortir) : matière, entrepôt, quarantaine, échéance, quantité libre.
create function private.stock_pick_check_lot(p_co uuid, p_material uuid, p_wh uuid, p_lot uuid, p_qty numeric, p_exclude_line uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_lot public.stock_lots%rowtype; v_kind text; v_committed numeric;
begin
  select * into v_lot from public.stock_lots where id = p_lot and company_id = p_co;
  if not found then raise exception 'PICK_LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_lot.material_id <> p_material or v_lot.warehouse_id <> p_wh then raise exception 'PICK_LOT_MISMATCH' using errcode = '22023'; end if;
  select kind into v_kind from public.stock_locations where id = v_lot.location_id;
  if v_kind = 'quarantine' then raise exception 'LOT_BLOCKED' using errcode = '55000'; end if;
  if v_lot.expiry_date is not null and v_lot.expiry_date < current_date then raise exception 'LOT_EXPIRED' using errcode = '55000'; end if;
  select coalesce(sum(pl.qty), 0) into v_committed from public.stock_pick_lines pl join public.stock_pick_lists pk on pk.id = pl.pick_id
    where pl.lot_id = p_lot and pk.status = 'open' and pl.id is distinct from p_exclude_line;
  if v_lot.qty_remaining - v_committed < p_qty then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
end $$;
revoke execute on function private.stock_pick_check_lot(uuid, uuid, uuid, uuid, numeric, uuid) from public, anon, authenticated;

-- Sortie d'un lot précis (revalide échéance, quarantaine, quantité et réservations au moment de l'exécution).
create function private.stock_take_lot(p_co uuid, p_material uuid, p_wh uuid, p_lot uuid, p_qty numeric, p_ref text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_lot public.stock_lots%rowtype; v_kind text; v_id uuid := gen_random_uuid(); v_cost numeric; v_oh numeric; v_q numeric; v_rs numeric;
begin
  select * into v_lot from public.stock_lots where id = p_lot and company_id = p_co for update;
  if not found then raise exception 'PICK_LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_lot.material_id <> p_material or v_lot.warehouse_id <> p_wh then raise exception 'PICK_LOT_MISMATCH' using errcode = '22023'; end if;
  select kind into v_kind from public.stock_locations where id = v_lot.location_id;
  if v_kind = 'quarantine' then raise exception 'LOT_BLOCKED' using errcode = '55000'; end if;
  if v_lot.expiry_date is not null and v_lot.expiry_date < current_date then raise exception 'LOT_EXPIRED' using errcode = '55000'; end if;
  if v_lot.qty_remaining < p_qty then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
  v_oh := private.stock_on_hand(p_material, p_wh); v_q := private.stock_quality_blocked(p_material, p_wh); v_rs := private.stock_reserved(p_material, p_wh);
  if v_oh - v_q - v_rs < p_qty then raise exception 'STOCK_RESERVED' using errcode = '55000'; end if;
  select coalesce(unit_cost, 0) into v_cost from public.stock_lot_costs where lot_id = p_lot;
  insert into public.stock_movements (id, company_id, type, direction, material_id, qty, warehouse_id, location_id, reference, reason, created_by)
  values (v_id, p_co, 'out', 'out', p_material, p_qty, p_wh, v_lot.location_id, p_ref, 'Préparation ' || p_ref, auth.uid());
  update public.stock_lots set qty_remaining = qty_remaining - p_qty where id = p_lot;
  insert into public.stock_movement_allocations (company_id, movement_id, lot_id, qty) values (p_co, v_id, p_lot, p_qty);
  insert into public.stock_movement_costs (movement_id, company_id, total_cost) values (v_id, p_co, p_qty * coalesce(v_cost, 0));
  return v_id;
end $$;
revoke execute on function private.stock_take_lot(uuid, uuid, uuid, uuid, numeric, text) from public, anon, authenticated;

-- Création : lignes proposées par la règle de sortie ; refuse si le disponible ne couvre pas la quantité.
create function public.stock_pick_create(p_material uuid, p_warehouse uuid, p_qty numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_rule text; v_avail numeric; r record; v_no text;
begin
  perform private.require_perm('stock.write');
  if not private.wh_can(p_warehouse, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'PICK_BAD_QTY' using errcode = '22023'; end if;
  if not exists (select 1 from public.bom_materials where id = p_material and company_id = v_co) then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  v_rule := private.stock_exit_rule(v_co);
  v_avail := private.stock_pick_available(p_material, p_warehouse, v_rule);
  if v_avail < p_qty then raise exception 'PICK_SHORT' using errcode = '55000'; end if;
  v_no := 'PRL-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'stock_pick')::text, 6, '0');
  insert into public.stock_pick_lists (id, company_id, number, warehouse_id, material_id, qty_requested, exit_rule, note, created_by)
  values (v_id, v_co, v_no, p_warehouse, p_material, p_qty, v_rule, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  for r in select * from private.stock_pick_plan(p_material, p_warehouse, p_qty, v_rule) loop
    insert into public.stock_pick_lines (company_id, pick_id, seq, lot_id, lot_code, location_id, qty, proposed_lot_id)
    values (v_co, v_id, r.seq, r.lot_id, r.lot_code, r.location_id, r.qty, r.lot_id);
  end loop;
  perform private.write_audit(v_co, 'stock.pick_create', 'pick', v_id::text, v_no, null,
    jsonb_build_object('qty', p_qty, 'rule', v_rule), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Scan du code lot. Un code erroné est enregistré (compteur, audit) et retourne ok=false sans annuler la transaction.
create function public.stock_pick_scan(p_line uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_l record; v_code text := btrim(coalesce(p_code, ''));
begin
  perform private.require_perm('stock.write');
  select pl.*, pk.warehouse_id as pk_wh, pk.status as pk_status, pk.number as pk_no into v_l
    from public.stock_pick_lines pl join public.stock_pick_lists pk on pk.id = pl.pick_id
    where pl.id = p_line and pl.company_id = v_co for update of pl;
  if not found then raise exception 'PICK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(v_l.pk_wh, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if v_l.pk_status <> 'open' then raise exception 'PICK_BAD_STATUS' using errcode = '55000'; end if;
  if v_l.substitution_status = 'pending' then raise exception 'PICK_SUBSTITUTION_PENDING' using errcode = '55000'; end if;
  if v_code <> '' and v_code = coalesce(v_l.lot_code, '') then
    update public.stock_pick_lines set scanned = true where id = p_line;
    return jsonb_build_object('ok', true, 'lot_code', v_l.lot_code);
  end if;
  update public.stock_pick_lines set scanned = false, scan_errors = scan_errors + 1 where id = p_line;
  perform private.write_audit(v_co, 'stock.pick_scan_error', 'pick', v_l.pick_id::text, v_l.pk_no, null,
    jsonb_build_object('line', v_l.seq, 'expected', v_l.lot_code, 'scanned', v_code), '{}'::jsonb, 'rpc');
  return jsonb_build_object('ok', false, 'error', 'PICK_SCAN_MISMATCH', 'expected', v_l.lot_code, 'scanned', v_code);
end $$;

-- Demande de substitution : le lot de remplacement doit être valide maintenant ; la ligne attend l'accord.
create function public.stock_pick_request_substitution(p_line uuid, p_lot uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_l record;
begin
  perform private.require_perm('stock.write');
  select pl.*, pk.warehouse_id as pk_wh, pk.status as pk_status, pk.material_id as pk_mat, pk.number as pk_no into v_l
    from public.stock_pick_lines pl join public.stock_pick_lists pk on pk.id = pl.pick_id
    where pl.id = p_line and pl.company_id = v_co for update of pl;
  if not found then raise exception 'PICK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(v_l.pk_wh, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if v_l.pk_status <> 'open' then raise exception 'PICK_BAD_STATUS' using errcode = '55000'; end if;
  if v_l.substitution_status = 'pending' then raise exception 'PICK_SUBSTITUTION_PENDING' using errcode = '55000'; end if;
  if p_lot = v_l.lot_id then raise exception 'PICK_SUBSTITUTE_INVALID' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'PICK_REASON_REQUIRED' using errcode = '22023'; end if;
  perform private.stock_pick_check_lot(v_co, v_l.pk_mat, v_l.pk_wh, p_lot, v_l.qty, p_line);
  update public.stock_pick_lines set substitute_lot_id = p_lot, substitution_status = 'pending', substitution_reason = btrim(p_reason),
    substitution_requested_by = auth.uid(), substitution_decided_by = null, substitution_decided_at = null
    where id = p_line;
  perform private.write_audit(v_co, 'stock.pick_substitution_request', 'pick', v_l.pick_id::text, v_l.pk_no, null,
    jsonb_build_object('line', v_l.seq, 'from_lot', v_l.lot_id, 'to_lot', p_lot), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- Décision d'accord : approbateur ≠ demandeur ; l'approbation revalide le lot ; le lot devient le lot à sortir.
create function public.stock_pick_decide_substitution(p_line uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_l record;
begin
  perform private.require_perm('stock.adjust');
  select pl.*, pk.warehouse_id as pk_wh, pk.status as pk_status, pk.material_id as pk_mat, pk.number as pk_no into v_l
    from public.stock_pick_lines pl join public.stock_pick_lists pk on pk.id = pl.pick_id
    where pl.id = p_line and pl.company_id = v_co for update of pl;
  if not found then raise exception 'PICK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(v_l.pk_wh, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if v_l.pk_status <> 'open' then raise exception 'PICK_BAD_STATUS' using errcode = '55000'; end if;
  if v_l.substitution_status <> 'pending' then raise exception 'PICK_NO_SUBSTITUTION' using errcode = '55000'; end if;
  if v_l.substitution_requested_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  if p_approve then
    perform private.stock_pick_check_lot(v_co, v_l.pk_mat, v_l.pk_wh, v_l.substitute_lot_id, v_l.qty, p_line);
    update public.stock_pick_lines set lot_id = substitute_lot_id, lot_code = (select lot_code from public.stock_lots where id = substitute_lot_id),
      location_id = (select location_id from public.stock_lots where id = substitute_lot_id),
      substitution_status = 'approved', substitution_decided_by = auth.uid(), substitution_decided_at = now(), scanned = false
      where id = p_line;
  else
    update public.stock_pick_lines set substitution_status = 'refused', substitution_decided_by = auth.uid(), substitution_decided_at = now()
      where id = p_line;
  end if;
  perform private.write_audit(v_co, 'stock.pick_substitution_decide', 'pick', v_l.pick_id::text, v_l.pk_no, null,
    jsonb_build_object('line', v_l.seq, 'approved', p_approve, 'lot', v_l.substitute_lot_id), '{}'::jsonb, 'rpc');
end $$;

-- Confirmation : tous les lignes scannées (ou substitution approuvée et rescannée), puis sortie du lot exact ; atomique.
create function public.stock_pick_confirm(p_pick uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pk public.stock_pick_lists%rowtype; l record; v_mov uuid; v_n int := 0; v_qty numeric := 0; v_pending int; v_unscanned int;
begin
  perform private.require_perm('stock.write');
  select * into pk from public.stock_pick_lists where id = p_pick and company_id = v_co for update;
  if not found then raise exception 'PICK_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(pk.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if pk.status <> 'open' then raise exception 'PICK_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_pending from public.stock_pick_lines where pick_id = pk.id and substitution_status = 'pending';
  if v_pending > 0 then raise exception 'PICK_SUBSTITUTION_PENDING' using errcode = '55000'; end if;
  select count(*) into v_unscanned from public.stock_pick_lines where pick_id = pk.id and not scanned;
  if v_unscanned > 0 then raise exception 'PICK_NOT_SCANNED' using errcode = '55000'; end if;
  for l in select * from public.stock_pick_lines where pick_id = pk.id order by seq loop
    v_mov := private.stock_take_lot(v_co, pk.material_id, pk.warehouse_id, l.lot_id, l.qty, pk.number);
    update public.stock_pick_lines set movement_id = v_mov where id = l.id;
    v_n := v_n + 1; v_qty := v_qty + l.qty;
  end loop;
  update public.stock_pick_lists set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid() where id = pk.id;
  perform private.write_audit(v_co, 'stock.pick_confirm', 'pick', pk.id::text, pk.number, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'confirmed', 'lines', v_n, 'qty', v_qty), '{}'::jsonb, 'rpc');
  return jsonb_build_object('pick', pk.number, 'lines', v_n, 'qty', v_qty);
end $$;

create function public.stock_pick_cancel(p_pick uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pk public.stock_pick_lists%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into pk from public.stock_pick_lists where id = p_pick and company_id = v_co for update;
  if not found then raise exception 'PICK_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(pk.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if pk.status <> 'open' then raise exception 'PICK_BAD_STATUS' using errcode = '55000'; end if;
  update public.stock_pick_lists set status = 'cancelled', cancelled_at = now() where id = pk.id;
  perform private.write_audit(v_co, 'stock.pick_cancel', 'pick', pk.id::text, pk.number, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'cancelled'), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.stock_exit_policy_get(), public.stock_exit_policy_set(text), public.stock_receive_lot(uuid, uuid, uuid, numeric, text, date, text, text, numeric),
  public.stock_pick_proposal(uuid, uuid, numeric), public.stock_pick_create(uuid, uuid, numeric, text), public.stock_pick_scan(uuid, text),
  public.stock_pick_request_substitution(uuid, uuid, text), public.stock_pick_decide_substitution(uuid, boolean),
  public.stock_pick_confirm(uuid), public.stock_pick_cancel(uuid) from public, anon;
grant execute on function public.stock_exit_policy_get(), public.stock_exit_policy_set(text), public.stock_receive_lot(uuid, uuid, uuid, numeric, text, date, text, text, numeric),
  public.stock_pick_proposal(uuid, uuid, numeric), public.stock_pick_create(uuid, uuid, numeric, text), public.stock_pick_scan(uuid, text),
  public.stock_pick_request_substitution(uuid, uuid, text), public.stock_pick_decide_substitution(uuid, boolean),
  public.stock_pick_confirm(uuid), public.stock_pick_cancel(uuid) to authenticated;
