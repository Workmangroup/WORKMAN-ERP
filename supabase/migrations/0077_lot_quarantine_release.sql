-- 0077_lot_quarantine_release — Quarantaine et libération qualité : statut par lot (quarantaine, bloqué, libéré, rejeté),
-- blocage effectif en consommation, picking, prise de lot et expédition ; libération formelle et auditée ; lot critique
-- libérable seulement par le rôle dédié ; retour physique entré en quarantaine (jamais vendable automatiquement).
--
-- Existant conservé et réutilisé :
--   * Quarantaine par emplacement (0009, 0063) : les lots d'un emplacement de type « quarantine » restent bloqués.
--     Sortie de quarantaine : mouvement explicite, inchangé. Libérer un lot ne le sort pas physiquement de la quarantaine.
--   * Garde-fous de stock (0063 : stock_quality_blocked, stock_quality_guard ; 0064 : pick_plan, pick_check_lot, take_lot).
--   * Lots produits (0055) : finished_lots (origine réception ou retour), finished_lot_mark_nc (non-conformité, inchangée),
--     affectation aux expéditions (shipment_line_lots, 0055).
--   * Lot critique (0033) : quality_inspections.critical ; auto-libération interdite (QUALITY_SELF_RELEASE) sur le contrôle.
--   * Droits quality.read / write / approve (0020), délégations (0033 : approval_allowed pour les décisions de contrôle).
--
-- Règles :
--  * Statuts d'un lot (matière ou produit) : quarantine (mis de côté en attente de contrôle), blocked (bloqué pour défaut ou
--    décision), released (libéré), rejected (rejeté, définitif). Un lot sans statut enregistré est libéré : c'est le régime
--    existant (aucune donnée n'est inventée pour les lots antérieurs).
--  * Blocage effectif : un lot quarantine / blocked / rejected ne peut être ni consommé (FIFO), ni proposé au picking, ni pris
--    par une préparation, ni décrémenté par une écriture directe, ni déplacé ; un lot produit bloqué ne peut pas être
--    affecté à une expédition.
--  * Libération : statut → released. Un lot critique exige la permission quality.release_critical (rôle dédié : admin et
--    direction). Un lot non critique exige quality.approve. Le lot ne peut pas être libéré par la personne qui l'a bloqué
--    (LOT_SELF_RELEASE). Libération et blocage sont auditées avec un motif.
--  * Rejet : statut rejected, définitif (LOT_BAD_STATUS pour toute transition ensuite).
--  * Retour physique : tout lot produit d'origine « retour » entre automatiquement en quarantaine, critique selon le motif
--    du blocage ; il ne peut pas être affecté à une expédition tant qu'il n'est pas libéré. Recevoir des pièces ne vaut pas
--    libération.
--  * Le journal des statuts (lot_quality_events) est en ajout seul.
-- Erreurs : LOT_NOT_FOUND, LOT_BAD_STATUS, LOT_BLOCKED, LOT_SELF_RELEASE, LOT_REASON_REQUIRED, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droit de libération des lots critiques (rôle dédié)
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('quality.release_critical', 'quality', 'Libérer un lot critique', 'Seul droit qui libère un lot marqué critique (distinct du droit d’approbation qualité)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'quality.release_critical'
  and r.code in ('admin', 'direction') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Statut courant et journal
-- ---------------------------------------------------------------------------
create table public.lot_quality_states (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  lot_kind    text not null check (lot_kind in ('material', 'finished')),
  lot_id      uuid not null,
  status      text not null check (status in ('quarantine', 'blocked', 'released', 'rejected')),
  critical    boolean not null default false,
  reason      text not null check (length(btrim(reason)) between 5 and 500),
  set_by      uuid,
  set_at      timestamptz not null default now(),
  unique (lot_kind, lot_id)
);

create table public.lot_quality_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  lot_kind    text not null check (lot_kind in ('material', 'finished')),
  lot_id      uuid not null,
  from_status text check (from_status is null or from_status in ('quarantine', 'blocked', 'released', 'rejected')),
  to_status   text not null check (to_status in ('quarantine', 'blocked', 'released', 'rejected')),
  critical    boolean not null,
  reason      text not null,
  actor       uuid,
  at          timestamptz not null default now()
);
create index lot_quality_events_lot_idx on public.lot_quality_events (lot_kind, lot_id, at);

create function private.lot_quality_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'LOT_EVENTS_APPEND_ONLY' using errcode = '42501';
end $$;
revoke execute on function private.lot_quality_append_only() from public, anon, authenticated;
create trigger lot_quality_events_append_only before update or delete on public.lot_quality_events
  for each row execute function private.lot_quality_append_only();

-- Lot bloqué au sens de la qualité (statut enregistré hors « libéré »)
create function private.lot_status_blocks(p_kind text, p_lot uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lot_quality_states s
                 where s.lot_kind = p_kind and s.lot_id = p_lot and s.status in ('quarantine', 'blocked', 'rejected'))
$$;
revoke execute on function private.lot_status_blocks(text, uuid) from public, anon, authenticated;

-- Lot matière inutilisable : statut bloquant, ou emplacement de quarantaine (règle existante)
create function private.lot_material_unusable(p_lot uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lot_status_blocks('material', p_lot)
      or exists (select 1 from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
                 where sl.id = p_lot and loc.kind = 'quarantine')
$$;
revoke execute on function private.lot_material_unusable(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Transitions : blocage, libération, rejet (toutes auditées, motif obligatoire)
-- ---------------------------------------------------------------------------
create function private.lot_target(p_kind text, p_lot uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v uuid;
begin
  if p_kind = 'material' then
    select id into v from public.stock_lots where id = p_lot and company_id = v_co;
  elsif p_kind = 'finished' then
    select id into v from public.finished_lots where id = p_lot and company_id = v_co;
  end if;
  if v is null then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  return v;
end $$;
revoke execute on function private.lot_target(text, uuid) from public, anon, authenticated;

create function public.lot_quality_hold(p_kind text, p_lot uuid, p_status text, p_reason text, p_critical boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old public.lot_quality_states%rowtype; v_from text; v_crit boolean;
begin
  perform private.require_perm('quality.write');
  perform private.lot_target(p_kind, p_lot);
  if p_status not in ('quarantine', 'blocked') then raise exception 'LOT_BAD_STATUS' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'LOT_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into v_old from public.lot_quality_states where lot_kind = p_kind and lot_id = p_lot for update;
  if found and v_old.status in ('quarantine', 'blocked', 'rejected') then raise exception 'LOT_BAD_STATUS' using errcode = '55000'; end if;
  v_from := case when found then v_old.status else null end;
  v_crit := coalesce(p_critical, false) or coalesce(v_old.critical, false);
  insert into public.lot_quality_states (company_id, lot_kind, lot_id, status, critical, reason, set_by, set_at)
  values (v_co, p_kind, p_lot, p_status, v_crit, btrim(p_reason), auth.uid(), now())
  on conflict (lot_kind, lot_id) do update set status = excluded.status, critical = excluded.critical, reason = excluded.reason,
    set_by = excluded.set_by, set_at = excluded.set_at;
  insert into public.lot_quality_events (company_id, lot_kind, lot_id, from_status, to_status, critical, reason, actor)
  values (v_co, p_kind, p_lot, v_from, p_status, v_crit, btrim(p_reason), auth.uid());
  perform private.write_audit(v_co, 'lot.hold', p_kind || '_lot', p_lot::text, null, jsonb_build_object('status', v_from),
    jsonb_build_object('status', p_status, 'critical', v_crit), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- Libération : critique = droit dédié ; non critique = approbation qualité ; jamais par la personne qui a bloqué
create function public.lot_quality_release(p_kind text, p_lot uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old public.lot_quality_states%rowtype;
begin
  perform private.lot_target(p_kind, p_lot);
  select * into v_old from public.lot_quality_states where lot_kind = p_kind and lot_id = p_lot for update;
  if not found or v_old.status not in ('quarantine', 'blocked') then raise exception 'LOT_BAD_STATUS' using errcode = '55000'; end if;
  if v_old.critical then perform private.require_perm('quality.release_critical');
  else perform private.require_perm('quality.approve'); end if;
  if v_old.set_by is not distinct from auth.uid() then raise exception 'LOT_SELF_RELEASE' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'LOT_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.lot_quality_states set status = 'released', set_by = auth.uid(), set_at = now(),
    reason = btrim(p_reason) where lot_kind = p_kind and lot_id = p_lot;
  insert into public.lot_quality_events (company_id, lot_kind, lot_id, from_status, to_status, critical, reason, actor)
  values (v_co, p_kind, p_lot, v_old.status, 'released', v_old.critical, btrim(p_reason), auth.uid());
  perform private.write_audit(v_co, 'lot.release', p_kind || '_lot', p_lot::text, null, jsonb_build_object('status', v_old.status),
    jsonb_build_object('status', 'released', 'critical', v_old.critical), jsonb_build_object('reason', btrim(p_reason), 'held_by', v_old.set_by), 'rpc');
end $$;

-- Rejet définitif (approbation qualité) : pas de retour possible
create function public.lot_quality_reject(p_kind text, p_lot uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old public.lot_quality_states%rowtype; v_from text; v_crit boolean := false;
begin
  perform private.require_perm('quality.approve');
  perform private.lot_target(p_kind, p_lot);
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'LOT_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into v_old from public.lot_quality_states where lot_kind = p_kind and lot_id = p_lot for update;
  if found and v_old.status = 'rejected' then raise exception 'LOT_BAD_STATUS' using errcode = '55000'; end if;
  v_from := case when found then v_old.status else null end;
  v_crit := coalesce(v_old.critical, false);
  insert into public.lot_quality_states (company_id, lot_kind, lot_id, status, critical, reason, set_by, set_at)
  values (v_co, p_kind, p_lot, 'rejected', v_crit, btrim(p_reason), auth.uid(), now())
  on conflict (lot_kind, lot_id) do update set status = 'rejected', reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at;
  insert into public.lot_quality_events (company_id, lot_kind, lot_id, from_status, to_status, critical, reason, actor)
  values (v_co, p_kind, p_lot, v_from, 'rejected', v_crit, btrim(p_reason), auth.uid());
  perform private.write_audit(v_co, 'lot.reject', p_kind || '_lot', p_lot::text, null, jsonb_build_object('status', v_from),
    jsonb_build_object('status', 'rejected'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

create function public.lot_quality_status_get(p_kind text, p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_s public.lot_quality_states%rowtype; v_hist jsonb; v_found boolean;
begin
  perform private.require_perm('quality.read');
  perform private.lot_target(p_kind, p_lot);
  select * into v_s from public.lot_quality_states where lot_kind = p_kind and lot_id = p_lot;
  v_found := found;  -- à capturer avant la requête suivante, qui réinitialise found
  select coalesce(jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'critical', e.critical, 'reason', e.reason,
      'actor', e.actor, 'at', e.at) order by e.at), '[]'::jsonb)
  into v_hist from public.lot_quality_events e where e.company_id = v_co and e.lot_kind = p_kind and e.lot_id = p_lot;
  return jsonb_build_object('status', coalesce(v_s.status, 'released'), 'recorded', v_found, 'critical', coalesce(v_s.critical, false),
    'reason', v_s.reason, 'set_by', v_s.set_by, 'history', v_hist);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Retour physique : entrée en quarantaine automatique
-- ---------------------------------------------------------------------------
create function private.finished_return_quarantine() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Seul un retour accepté (lot released) entre en quarantaine ; un retour non conforme (nc) est déjà exclu de la vente
  if new.origin = 'return' and new.status = 'released' then
    insert into public.lot_quality_states (company_id, lot_kind, lot_id, status, critical, reason, set_by, set_at)
    values (new.company_id, 'finished', new.id, 'quarantine', false,
      'Retour physique : non vendable avant contrôle et libération', auth.uid(), now())
    on conflict (lot_kind, lot_id) do nothing;
    insert into public.lot_quality_events (company_id, lot_kind, lot_id, from_status, to_status, critical, reason, actor)
    values (new.company_id, 'finished', new.id, null, 'quarantine', false, 'Retour physique : non vendable avant contrôle et libération', auth.uid());
  end if;
  return new;
end $$;
revoke execute on function private.finished_return_quarantine() from public, anon, authenticated;
create trigger finished_lots_return_quarantine_ai after insert on public.finished_lots
  for each row execute function private.finished_return_quarantine();

-- ---------------------------------------------------------------------------
-- 5. Blocage effectif : garde-fous existants redéfinis (comportement inchangé sans statut)
-- ---------------------------------------------------------------------------
-- Quantité bloquée d'une matière dans un entrepôt : emplacement de quarantaine ou statut bloquant
create or replace function private.stock_quality_blocked(p_material uuid, p_wh uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(sl.qty_remaining), 0) from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
   where sl.material_id = p_material and sl.warehouse_id = p_wh
     and (loc.kind = 'quarantine' or private.lot_status_blocks('material', sl.id))
$$;

-- Sortie FIFO : les lots bloqués par statut ne sont jamais prélevés
create or replace function private.stock_consume(p_company uuid, p_movement uuid, p_material uuid, p_wh uuid, p_loc uuid, p_qty numeric,
                                                 p_dest_wh uuid, p_dest_loc uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare r record; v_need numeric := p_qty; v_take numeric; v_new uuid; v_cost numeric; v_total numeric := 0; v_kind text;
begin
  if p_dest_loc is null and p_loc is not null then
    select kind into v_kind from public.stock_locations where id = p_loc;
    if v_kind = 'quarantine' and coalesce(current_setting('purchases.rpc', true), '') <> 'on' then
      raise exception 'STOCK_QUALITY_BLOCKED' using errcode = '55000';
    end if;
  end if;
  for r in
    select sl.* from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
    where sl.material_id = p_material and sl.warehouse_id = p_wh and sl.qty_remaining > 0
      and (p_loc is null or sl.location_id = p_loc) and sl.company_id = p_company
      and (p_dest_loc is not null or loc.kind <> 'quarantine' or (p_loc is not null and coalesce(current_setting('purchases.rpc', true), '') = 'on'))
      and not private.lot_status_blocks('material', sl.id)
    order by sl.received_at, sl.id for update of sl
  loop
    exit when v_need <= 0;
    v_take := least(r.qty_remaining, v_need);
    select unit_cost into v_cost from public.stock_lot_costs where lot_id = r.id;
    update public.stock_lots set qty_remaining = qty_remaining - v_take where id = r.id;
    v_new := null;
    if p_dest_loc is not null then
      v_new := gen_random_uuid();
      insert into public.stock_lots (id, company_id, material_id, warehouse_id, location_id, qty_in, qty_remaining, received_at, reference, source_movement)
      values (v_new, p_company, p_material, p_dest_wh, p_dest_loc, v_take, v_take, r.received_at, r.reference, p_movement);
      if v_cost is not null then insert into public.stock_lot_costs (lot_id, company_id, unit_cost) values (v_new, p_company, v_cost); end if;
    end if;
    insert into public.stock_movement_allocations (company_id, movement_id, lot_id, to_lot_id, qty) values (p_company, p_movement, r.id, v_new, v_take);
    v_total := v_total + v_take * coalesce(v_cost, 0);
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
  return v_total;
end $$;

-- Proposition de picking : lots bloqués par statut exclus
create or replace function private.stock_pick_plan(p_material uuid, p_wh uuid, p_qty numeric, p_rule text)
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
      and not private.lot_status_blocks('material', sl.id)
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

-- Lot de picking précis : refusé s'il est bloqué par statut (vérifié aussi à l'exécution)
create or replace function private.stock_pick_check_lot(p_co uuid, p_material uuid, p_wh uuid, p_lot uuid, p_qty numeric, p_exclude_line uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_lot public.stock_lots%rowtype; v_kind text; v_committed numeric;
begin
  select * into v_lot from public.stock_lots where id = p_lot and company_id = p_co;
  if not found then raise exception 'PICK_LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_lot.material_id <> p_material or v_lot.warehouse_id <> p_wh then raise exception 'PICK_LOT_MISMATCH' using errcode = '22023'; end if;
  select kind into v_kind from public.stock_locations where id = v_lot.location_id;
  if v_kind = 'quarantine' or private.lot_status_blocks('material', p_lot) then raise exception 'LOT_BLOCKED' using errcode = '55000'; end if;
  if v_lot.expiry_date is not null and v_lot.expiry_date < current_date then raise exception 'LOT_EXPIRED' using errcode = '55000'; end if;
  select coalesce(sum(pl.qty), 0) into v_committed from public.stock_pick_lines pl join public.stock_pick_lists pk on pk.id = pl.pick_id
    where pl.lot_id = p_lot and pk.status = 'open' and pl.id is distinct from p_exclude_line;
  if v_lot.qty_remaining - v_committed < p_qty then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
end $$;

-- Sortie d'un lot précis (préparation) : refusée si bloqué par statut
create or replace function private.stock_take_lot(p_co uuid, p_material uuid, p_wh uuid, p_lot uuid, p_qty numeric, p_ref text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_lot public.stock_lots%rowtype; v_kind text; v_id uuid := gen_random_uuid(); v_cost numeric; v_oh numeric; v_q numeric; v_rs numeric;
begin
  select * into v_lot from public.stock_lots where id = p_lot and company_id = p_co for update;
  if not found then raise exception 'PICK_LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_lot.material_id <> p_material or v_lot.warehouse_id <> p_wh then raise exception 'PICK_LOT_MISMATCH' using errcode = '22023'; end if;
  select kind into v_kind from public.stock_locations where id = v_lot.location_id;
  if v_kind = 'quarantine' or private.lot_status_blocks('material', p_lot) then raise exception 'LOT_BLOCKED' using errcode = '55000'; end if;
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

-- Garde ultime : aucune décrémentation ni déplacement d'un lot matière bloqué par statut (quel que soit le chemin)
create function private.stock_lot_status_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.qty_remaining < old.qty_remaining or new.location_id is distinct from old.location_id)
     and private.lot_status_blocks('material', old.id) then
    raise exception 'LOT_BLOCKED' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.stock_lot_status_guard() from public, anon, authenticated;
create trigger stock_lots_status_guard_bu before update on public.stock_lots
  for each row execute function private.stock_lot_status_guard();

-- Affectation d'un lot produit à une expédition : refusée si le lot est bloqué (quarantaine, retour, blocage, rejet)
create function private.shipment_lot_status_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.lot_status_blocks('finished', new.lot_id) then raise exception 'LOT_BLOCKED' using errcode = '55000'; end if;
  return new;
end $$;
revoke execute on function private.shipment_lot_status_guard() from public, anon, authenticated;
create trigger shipment_line_lots_status_guard_bi before insert on public.shipment_line_lots
  for each row execute function private.shipment_lot_status_guard();

-- ---------------------------------------------------------------------------
-- 6. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.lot_quality_states enable row level security;
alter table public.lot_quality_events enable row level security;
create policy lot_quality_states_select on public.lot_quality_states for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy lot_quality_events_select on public.lot_quality_events for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.lot_quality_states, public.lot_quality_events from anon, authenticated;
grant select on public.lot_quality_states, public.lot_quality_events to authenticated;
grant all on public.lot_quality_states, public.lot_quality_events to service_role;

revoke execute on function public.lot_quality_hold(text, uuid, text, text, boolean), public.lot_quality_release(text, uuid, text),
  public.lot_quality_reject(text, uuid, text), public.lot_quality_status_get(text, uuid) from public, anon;
grant execute on function public.lot_quality_hold(text, uuid, text, text, boolean), public.lot_quality_release(text, uuid, text),
  public.lot_quality_reject(text, uuid, text), public.lot_quality_status_get(text, uuid) to authenticated, service_role;
