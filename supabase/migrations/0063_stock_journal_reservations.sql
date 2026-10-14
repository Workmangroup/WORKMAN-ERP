-- 0063 — Journal des mouvements et réservations (P038) : blocage qualité, réservations sans dépassement, réconciliation du journal
-- Additive. Réutilise : mouvements immuables (0009 : stock_movements_immutable), lots FIFO (stock_lots), réservations (0009 : stock_reserve, stock_release),
-- emplacements de type « quarantine » (0009) pour le stock non conforme, politique d'approbation des mouvements (0018).
-- Remplace (même capacité, règle renforcée) : private.stock_consume (exclut la quarantaine des sorties), public.stock_reserve (réserve le seul disponible).
-- Règles :
--  * Stock négatif : refusé. Aucune politique de stock négatif n'existe dans le dépôt : le refus est donc le seul comportement (aucune politique n'est inventée).
--  * Lot qualité bloqué : le stock d'un emplacement de quarantaine ne peut ni être sorti, ni consommé, ni réservé. Seul un transfert explicite
--    de la quarantaine vers un autre emplacement (libération après contrôle, P035) le sort.
--  * Ajustement négatif : même garde que la sortie (disponible hors quarantaine, réservations respectées).
--  * Journal : immuable ; la réconciliation compare le solde reconstitué du journal au solde des lots, par composant et entrepôt.

-- ---------------------------------------------------------------------
-- 1. Stock bloqué (quarantaine) et garde-fou à l'écriture du journal
-- ---------------------------------------------------------------------
create function private.stock_quality_blocked(p_material uuid, p_wh uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(sl.qty_remaining), 0) from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
   where sl.material_id = p_material and sl.warehouse_id = p_wh and loc.kind = 'quarantine'
$$;
revoke execute on function private.stock_quality_blocked(uuid, uuid) from public, anon, authenticated;

create function private.stock_quality_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_oh numeric; v_q numeric; v_rs numeric; v_ret boolean := false;
begin
  if new.direction <> 'out' then return new; end if;
  if new.location_id is not null then
    select kind into v_kind from public.stock_locations where id = new.location_id;
    -- Seul le retour fournisseur d'un lot rejeté (RPC achats, réf. RET-, sortie de quarantaine) peut sortir de la quarantaine.
    v_ret := v_kind = 'quarantine' and new.type = 'out' and new.reference like 'RET-%' and coalesce(current_setting('purchases.rpc', true), '') = 'on';
    if v_kind = 'quarantine' and not v_ret then
      raise exception 'STOCK_QUALITY_BLOCKED' using errcode = '55000';
    end if;
  end if;
  if (new.type = 'out' or new.type = 'adjustment') and not v_ret then
    -- Ne se substitue pas aux contrôles existants : seul le stock bloqué (quarantaine) qui fait échouer la sortie est signalé ici.
    v_oh := private.stock_on_hand(new.material_id, new.warehouse_id);
    v_q := private.stock_quality_blocked(new.material_id, new.warehouse_id);
    if v_q > 0 and v_oh >= new.qty and v_oh - v_q < new.qty then raise exception 'STOCK_QUALITY_BLOCKED' using errcode = '55000'; end if;
  end if;
  if new.type = 'adjustment' then
    -- Un ajustement négatif ne consomme pas le stock réservé ni le stock bloqué.
    v_rs := private.stock_reserved(new.material_id, new.warehouse_id);
    v_oh := private.stock_on_hand(new.material_id, new.warehouse_id);
    v_q := private.stock_quality_blocked(new.material_id, new.warehouse_id);
    if v_oh - v_q >= new.qty and v_oh - v_q - v_rs < new.qty then raise exception 'STOCK_RESERVED' using errcode = '55000'; end if;
  end if;
  return new;
end $$;
revoke execute on function private.stock_quality_guard() from public, anon, authenticated;
create trigger stock_movements_quality_guard_i before insert on public.stock_movements
  for each row execute function private.stock_quality_guard();

-- ---------------------------------------------------------------------
-- 2. Consommation FIFO : la quarantaine n'alimente jamais une sortie ; elle ne sort que par un transfert explicite (libération)
-- ---------------------------------------------------------------------
create or replace function private.stock_consume(p_company uuid, p_movement uuid, p_material uuid, p_wh uuid, p_loc uuid, p_qty numeric,
                                                 p_dest_wh uuid, p_dest_loc uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare r record; v_need numeric := p_qty; v_take numeric; v_new uuid; v_cost numeric; v_total numeric := 0; v_kind text;
begin
  if p_dest_loc is null and p_loc is not null then
    select kind into v_kind from public.stock_locations where id = p_loc;
    -- Sortie de quarantaine sans destination : seul le retour fournisseur (RPC achats, purchases.rpc) y est autorisé.
    if v_kind = 'quarantine' and coalesce(current_setting('purchases.rpc', true), '') <> 'on' then
      raise exception 'STOCK_QUALITY_BLOCKED' using errcode = '55000';
    end if;
  end if;
  for r in
    select sl.* from public.stock_lots sl join public.stock_locations loc on loc.id = sl.location_id
    where sl.material_id = p_material and sl.warehouse_id = p_wh and sl.qty_remaining > 0
      and (p_loc is null or sl.location_id = p_loc) and sl.company_id = p_company
      and (p_dest_loc is not null or loc.kind <> 'quarantine' or (p_loc is not null and coalesce(current_setting('purchases.rpc', true), '') = 'on'))
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
revoke execute on function private.stock_consume(uuid, uuid, uuid, uuid, uuid, numeric, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Réservation atomique : verrou par composant, disponible = sur hand − réservé − quarantaine
-- ---------------------------------------------------------------------
create or replace function public.stock_reserve(p_material uuid, p_warehouse uuid, p_qty numeric, p_reference text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); m public.bom_materials%rowtype;
begin
  perform private.require_perm('stock.write');
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reference, ''))) < 1 then raise exception 'STOCK_REFERENCE_REQUIRED' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.bom_materials where id = p_material for update;     -- sérialise les réservations d'un même composant
  if private.stock_on_hand(p_material, p_warehouse) - private.stock_reserved(p_material, p_warehouse)
     - private.stock_quality_blocked(p_material, p_warehouse) < p_qty then
    raise exception 'STOCK_INSUFFICIENT_AVAILABLE' using errcode = '55000';
  end if;
  insert into public.stock_reservations (id, company_id, material_id, warehouse_id, qty, reference, note, created_by)
  values (v_id, v_co, p_material, p_warehouse, p_qty, btrim(p_reference), nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  perform private.write_audit(v_co, 'stock.reserve', 'stock', p_material::text, m.code, null, jsonb_build_object('qty', p_qty),
    jsonb_build_object('reference', btrim(p_reference), 'warehouse_id', p_warehouse, 'material', m.name), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 4. Journal : lecture filtrée par entrepôt (portée) et classement (entrée, sortie, consommation, retour, transfert, ajustement)
-- ---------------------------------------------------------------------
create function public.stock_journal_list(p_warehouse uuid default null, p_material uuid default null, p_limit int default 200)
returns table (seq bigint, at timestamptz, class text, type text, direction text, material_id uuid, qty numeric, warehouse_id uuid,
               to_warehouse_id uuid, reference text, reason text, reservation_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.seq, m.created_at, case
           when m.reference like 'RET-%' then 'retour'
           when m.reservation_id is not null or m.reason like 'Consommation%' then 'consommation'
           when m.type = 'in' then 'entree'
           when m.type = 'out' then 'sortie'
           when m.type = 'transfer' then 'transfert'
           when m.type = 'adjustment' then 'ajustement'
           else 'inventaire' end,
         m.type, m.direction, m.material_id, m.qty, m.warehouse_id, m.to_warehouse_id, m.reference, m.reason, m.reservation_id
    from public.stock_movements m
   where m.company_id = private.current_company() and private.has_perm('stock.read')
     and private.wh_can(m.warehouse_id, 'viewer')
     and (p_warehouse is null or m.warehouse_id = p_warehouse)
     and (p_material is null or m.material_id = p_material)
   order by m.seq desc
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;
grant execute on function public.stock_journal_list(uuid, uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Réconciliation : solde reconstitué du journal = solde des lots (par composant et entrepôt)
-- ---------------------------------------------------------------------
create function public.stock_journal_reconcile(p_material uuid default null)
returns table (material_id uuid, warehouse_id uuid, journal_balance numeric, lot_balance numeric, reserved numeric, quality_blocked numeric, difference numeric)
language sql stable security definer set search_path = '' as $$
  with j as (
    select mv.material_id, mv.warehouse_id as wh, sum(case when mv.direction = 'in' then mv.qty when mv.direction = 'out' then -mv.qty else 0 end) as bal
      from public.stock_movements mv where mv.company_id = private.current_company() and (p_material is null or mv.material_id = p_material)
       and private.wh_can(mv.warehouse_id, 'viewer') group by 1, 2
    union all
    select mv.material_id, mv.to_warehouse_id, sum(mv.qty)
      from public.stock_movements mv where mv.company_id = private.current_company() and mv.direction = 'move' and mv.to_warehouse_id <> mv.warehouse_id
       and (p_material is null or mv.material_id = p_material) and private.wh_can(mv.to_warehouse_id, 'viewer') group by 1, 2
    union all
    select mv.material_id, mv.warehouse_id, -sum(mv.qty)
      from public.stock_movements mv where mv.company_id = private.current_company() and mv.direction = 'move' and mv.to_warehouse_id <> mv.warehouse_id
       and (p_material is null or mv.material_id = p_material) and private.wh_can(mv.warehouse_id, 'viewer') group by 1, 2
  ), jb as (select j.material_id, j.wh, sum(j.bal) as bal from j group by 1, 2),
  lb as (select sl.material_id, sl.warehouse_id as wh, sum(sl.qty_remaining) as bal from public.stock_lots sl
          where sl.company_id = private.current_company() and (p_material is null or sl.material_id = p_material) and private.wh_can(sl.warehouse_id, 'viewer') group by 1, 2),
  keys as (select material_id, wh from jb union select material_id, wh from lb)
  select k.material_id, k.wh, coalesce(jb.bal, 0), coalesce(lb.bal, 0),
         private.stock_reserved(k.material_id, k.wh), private.stock_quality_blocked(k.material_id, k.wh),
         coalesce(jb.bal, 0) - coalesce(lb.bal, 0)
    from keys k left join jb on jb.material_id = k.material_id and jb.wh = k.wh left join lb on lb.material_id = k.material_id and lb.wh = k.wh
$$;
grant execute on function public.stock_journal_reconcile(uuid) to authenticated, service_role;
