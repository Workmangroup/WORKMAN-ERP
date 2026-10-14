-- 0079_nc_capa_disposition — Non-conformités et CAPA (P053) : cause structurée, périmètre aval (lots impactés), retouche et rebut
-- terminal, coûts, responsable et échéance, clôture conditionnée à la cause racine, aux dispositions et à l'efficacité.
--
-- Existant conservé et réutilisé (0020) : quality_nonconformities (gravité, confinement, cause racine texte, responsable,
-- échéance), quality_corrective_actions (correctives / préventives, vérification d'efficacité), quality_action_plans,
-- numérotation NC- / CA-, quality_nc_open, quality_nc_contain, quality_ca_*, quality_dashboard.
-- Lots et stock : 0077 (statuts de lot, libération SOD, rejet terminal), 0063 / 0064 (garde-fous de stock), 0073 (traçabilité),
-- 0015 (variant_stock_move, droit variants.stock).
--
-- Règles :
--  * Retouche : le lot impacté passe en « bloqué » ; la retouche est terminée lorsque le lot est libéré par lot_quality_release
--    (0077), donc par une autre personne que celle qui a bloqué. Un lot retouché n'est pas automatiquement vendable.
--  * Rebut terminal : le lot passe en « rejeté » (définitif) et sa quantité sort du stock par un mouvement tracé. Un lot rebuté
--    ne peut plus être libéré, retouché ni réintroduit (réception de même code refusée). Droits : quality.approve + stock.write
--    (matière) ou variants.stock (produit fini) — aucun droit implicite.
--  * Coûts : droit distinct quality.cost (admin, direction, finance). Montant, devise (code ISO 3 lettres) et libellé saisis ;
--    aucune valeur n'est déduite ni supposée.
--  * Clôture : statut contenu ; cause et cause racine ; responsable et échéance ; périmètre évalué (lots impactés ou motif) ;
--    chaque lot impacté a une disposition terminée ; aucune action ouverte ; aucune action inefficace non suivie d'une action
--    efficace ; sinon justification écrite (≥ 10 caractères, comme 0020).
--  * Journaux (impacts, dispositions, coûts) en ajout seul.
-- Erreurs : NC_CAUSE_INVALID, NC_OWNER_INVALID, NC_DUE_REQUIRED, NC_SCOPE_HAS_IMPACTS, NC_REASON_REQUIRED, NC_IMPACT_NOT_FOUND, NC_QTY_INVALID, NC_QTY_EXCEEDS_LOT,
-- NC_ALREADY_DISPOSITIONED, NC_SCRAPPED_TERMINAL, NC_BAD_DISPOSITION, NC_APPEND_ONLY, NC_SCRAP_REINTRODUCTION,
-- NC_CURRENCY_INVALID, NC_COST_KIND_INVALID, NC_CLOSE_<code> (un code par règle de clôture), RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Colonnes additives sur les non-conformités
-- ---------------------------------------------------------------------------
alter table public.quality_nonconformities
  add column cause_category text check (cause_category is null or cause_category in
    ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other')),
  add column no_impact_reason text check (no_impact_reason is null or length(btrim(no_impact_reason)) between 10 and 500);

-- ---------------------------------------------------------------------------
-- 2. Droit des coûts de non-qualité
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('quality.cost', 'quality', 'Voir et saisir les coûts de non-qualité', 'Coûts de retouche, de rebut et autres coûts liés aux non-conformités')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'quality.cost'
where r.is_system and r.code in ('admin', 'direction', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Périmètre aval, dispositions et coûts (journaux)
-- ---------------------------------------------------------------------------
create table public.quality_nc_impacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  nc_id       uuid not null references public.quality_nonconformities(id) on delete restrict,
  lot_kind    text not null check (lot_kind in ('material', 'finished')),
  lot_id      uuid not null,
  qty         numeric(14,4) not null check (qty > 0),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (nc_id, lot_kind, lot_id)
);

create table public.quality_nc_dispositions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  nc_id        uuid not null references public.quality_nonconformities(id) on delete restrict,
  impact_id    uuid not null unique references public.quality_nc_impacts(id) on delete restrict,
  kind         text not null check (kind in ('rework', 'scrap')),
  qty          numeric(14,4) not null check (qty > 0),
  reason       text not null check (length(btrim(reason)) between 5 and 500),
  decided_by   uuid,
  decided_at   timestamptz not null default now(),
  completed_by uuid,
  completed_at timestamptz,
  check ((completed_at is null) = (completed_by is null)),
  check (kind <> 'scrap' or completed_at is not null)
);

create table public.quality_nc_costs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  nc_id       uuid not null references public.quality_nonconformities(id) on delete restrict,
  kind        text not null check (kind in ('rework', 'scrap', 'other')),
  amount      numeric(14,2) not null check (amount >= 0),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  label       text not null check (length(btrim(label)) between 3 and 200),
  recorded_by uuid default auth.uid(),
  recorded_at timestamptz not null default now()
);

create function private.nc_ledger_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'NC_APPEND_ONLY' using errcode = '42501'; end if;
  -- seule la complétion d'une retouche change une disposition
  if tg_table_name = 'quality_nc_dispositions' then
    if old.completed_at is null and new.completed_at is not null
       and (new.id, new.company_id, new.nc_id, new.impact_id, new.kind, new.qty, new.reason, new.decided_by, new.decided_at)
           is not distinct from (old.id, old.company_id, old.nc_id, old.impact_id, old.kind, old.qty, old.reason, old.decided_by, old.decided_at) then
      return new;
    end if;
  end if;
  raise exception 'NC_APPEND_ONLY' using errcode = '42501';
end $$;
revoke execute on function private.nc_ledger_guard() from public, anon, authenticated;
create trigger quality_nc_impacts_guard_bud before update or delete on public.quality_nc_impacts for each row execute function private.nc_ledger_guard();
create trigger quality_nc_dispositions_guard_bud before update or delete on public.quality_nc_dispositions for each row execute function private.nc_ledger_guard();
create trigger quality_nc_costs_guard_bud before update or delete on public.quality_nc_costs for each row execute function private.nc_ledger_guard();

-- Un lot rebuté (statut rejeté) ne peut pas être réintroduit par réception sous le même code et la même matière
-- Réception : le lot est créé sans code puis reçoit son code (stock_receive_lot) : le contrôle porte donc aussi sur la mise à jour du code.
create function private.stock_lot_scrap_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.lot_code is not distinct from old.lot_code and new.material_id is not distinct from old.material_id then
    return new;
  end if;
  if new.lot_code is not null and exists (select 1 from public.lot_quality_states s join public.stock_lots sl on sl.id = s.lot_id
             where s.lot_kind = 'material' and s.status = 'rejected' and sl.company_id = new.company_id
               and sl.material_id = new.material_id and sl.lot_code = new.lot_code) then
    raise exception 'NC_SCRAP_REINTRODUCTION' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.stock_lot_scrap_guard() from public, anon, authenticated;
create trigger stock_lots_scrap_guard_biu before insert or update of lot_code, material_id on public.stock_lots
  for each row execute function private.stock_lot_scrap_guard();

-- ---------------------------------------------------------------------------
-- 4. Gardes de stock : passage explicite réservé au rebut (drapeau local à la transaction)
-- ---------------------------------------------------------------------------
-- Copie de 0063 (private.stock_quality_guard) avec le seul passage ajouté pour le rebut
create or replace function private.stock_quality_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_oh numeric; v_q numeric; v_rs numeric; v_ret boolean := false;
begin
  if coalesce(current_setting('quality.scrap_rpc', true), '') = 'on' then return new; end if;
  if new.direction <> 'out' then return new; end if;
  if new.location_id is not null then
    select kind into v_kind from public.stock_locations where id = new.location_id;
    v_ret := v_kind = 'quarantine' and new.type = 'out' and new.reference like 'RET-%' and coalesce(current_setting('purchases.rpc', true), '') = 'on';
    if v_kind = 'quarantine' and not v_ret then
      raise exception 'STOCK_QUALITY_BLOCKED' using errcode = '55000';
    end if;
  end if;
  if (new.type = 'out' or new.type = 'adjustment') and not v_ret then
    v_oh := private.stock_on_hand(new.material_id, new.warehouse_id);
    v_q := private.stock_quality_blocked(new.material_id, new.warehouse_id);
    if v_q > 0 and v_oh >= new.qty and v_oh - v_q < new.qty then raise exception 'STOCK_QUALITY_BLOCKED' using errcode = '55000'; end if;
  end if;
  if new.type = 'adjustment' then
    v_rs := private.stock_reserved(new.material_id, new.warehouse_id);
    v_oh := private.stock_on_hand(new.material_id, new.warehouse_id);
    v_q := private.stock_quality_blocked(new.material_id, new.warehouse_id);
    if v_oh - v_q >= new.qty and v_oh - v_q - v_rs < new.qty then raise exception 'STOCK_RESERVED' using errcode = '55000'; end if;
  end if;
  return new;
end $$;

-- Copie de 0077 (private.stock_lot_status_guard) avec le seul passage ajouté pour le rebut
create or replace function private.stock_lot_status_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('quality.scrap_rpc', true), '') = 'on' then return new; end if;
  if (new.qty_remaining < old.qty_remaining or new.location_id is distinct from old.location_id)
     and private.lot_status_blocks('material', old.id) then
    raise exception 'LOT_BLOCKED' using errcode = '55000';
  end if;
  return new;
end $$;

-- Sortie de rebut d'un lot matière (interne aux fonctions NC) : mouvement tracé et coût, sans passer par la consommation
create function private.nc_stock_scrap(p_co uuid, p_lot uuid, p_qty numeric, p_ref text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_lot public.stock_lots%rowtype; v_id uuid := gen_random_uuid(); v_cost numeric;
begin
  perform set_config('quality.scrap_rpc', 'on', true);
  select * into v_lot from public.stock_lots where id = p_lot and company_id = p_co for update;
  if not found then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_lot.qty_remaining < p_qty then raise exception 'NC_QTY_EXCEEDS_LOT' using errcode = '22023'; end if;
  select coalesce(unit_cost, 0) into v_cost from public.stock_lot_costs where lot_id = p_lot;
  insert into public.stock_movements (id, company_id, type, direction, material_id, qty, warehouse_id, location_id, reference, reason, created_by)
  values (v_id, p_co, 'out', 'out', v_lot.material_id, p_qty, v_lot.warehouse_id, v_lot.location_id, p_ref, 'Rebut non-conformité ' || p_ref, auth.uid());
  update public.stock_lots set qty_remaining = qty_remaining - p_qty where id = p_lot;
  insert into public.stock_movement_allocations (company_id, movement_id, lot_id, qty) values (p_co, v_id, p_lot, p_qty);
  insert into public.stock_movement_costs (movement_id, company_id, total_cost) values (v_id, p_co, p_qty * coalesce(v_cost, 0));
  return v_id;
end $$;
revoke execute on function private.nc_stock_scrap(uuid, uuid, numeric, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Impacts (périmètre aval) et déclaration de périmètre
-- ---------------------------------------------------------------------------
create function public.quality_nc_impact_add(p_nc uuid, p_kind text, p_lot uuid, p_qty numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); n public.quality_nonconformities%rowtype; v_qty_in numeric; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quality.write');
  if p_kind not in ('material', 'finished') then raise exception 'NC_IMPACT_NOT_FOUND' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'NC_QTY_INVALID' using errcode = '22023'; end if;
  select * into n from public.quality_nonconformities where id = p_nc and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_kind = 'material' then
    select qty_in into v_qty_in from public.stock_lots where id = p_lot and company_id = v_co;
  else
    select qty_in into v_qty_in from public.finished_lots where id = p_lot and company_id = v_co;
  end if;
  if v_qty_in is null then raise exception 'NC_IMPACT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_qty > v_qty_in then raise exception 'NC_QTY_EXCEEDS_LOT' using errcode = '22023'; end if;
  insert into public.quality_nc_impacts (id, company_id, nc_id, lot_kind, lot_id, qty) values (v_id, v_co, n.id, p_kind, p_lot, p_qty);
  perform private.write_audit(v_co, 'quality.nc_impact', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('lot_kind', p_kind, 'lot_id', p_lot, 'qty', p_qty), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.quality_nc_scope_declare(p_nc uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); n public.quality_nonconformities%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('quality.write');
  if length(v_reason) < 10 then raise exception 'NC_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into n from public.quality_nonconformities where id = p_nc and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.quality_nc_impacts where nc_id = p_nc) then raise exception 'NC_SCOPE_HAS_IMPACTS' using errcode = '22023'; end if;
  update public.quality_nonconformities set no_impact_reason = v_reason where id = p_nc;
  perform private.write_audit(v_co, 'quality.nc_scope_declare', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('no_impact_reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

-- Lots impactés et leur aval : statut du lot, disposition, expéditions (lot produit ; lot matière via ses OF)
create function public.quality_nc_scope(p_nc uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_items jsonb;
begin
  perform private.require_perm('quality.read');
  if not exists (select 1 from public.quality_nonconformities where id = p_nc and company_id = v_co) then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(x order by x->>'lot_code', x->>'impact_id'), '[]'::jsonb) into v_items from (
    select jsonb_build_object(
      'impact_id', i.id, 'lot_kind', i.lot_kind, 'lot_id', i.lot_id, 'qty', i.qty,
      'lot_code', coalesce(sl.lot_code, fl.lot_code),
      'lot_status', coalesce(ls.status, 'released'),
      'disposition', case when d.id is null then null else jsonb_build_object('kind', d.kind, 'qty', d.qty, 'completed', d.completed_at is not null) end,
      'shipments', (select coalesce(jsonb_agg(distinct s.number), '[]'::jsonb)
          from public.shipments s join public.shipment_lines sl2 on sl2.shipment_id = s.id
          join public.shipment_line_lots sll on sll.shipment_line_id = sl2.id
          where (i.lot_kind = 'finished' and sll.lot_id = i.lot_id)
             or (i.lot_kind = 'material' and sll.lot_id in (select f.id from public.finished_lots f where f.production_order_id in (
                   select c.production_order_id from public.production_cut_plans c join public.stock_movement_allocations a on a.movement_id = c.movement_id
                   where a.lot_id = i.lot_id)))),
      'finished_lots', (select coalesce(jsonb_agg(f.lot_code order by f.lot_code), '[]'::jsonb) from public.finished_lots f
          where i.lot_kind = 'material' and f.production_order_id in (
            select c.production_order_id from public.production_cut_plans c join public.stock_movement_allocations a on a.movement_id = c.movement_id
            where a.lot_id = i.lot_id))
    ) as x
    from public.quality_nc_impacts i
    left join public.stock_lots sl on i.lot_kind = 'material' and sl.id = i.lot_id
    left join public.finished_lots fl on i.lot_kind = 'finished' and fl.id = i.lot_id
    left join public.lot_quality_states ls on ls.lot_kind = i.lot_kind and ls.lot_id = i.lot_id
    left join public.quality_nc_dispositions d on d.impact_id = i.id
    where i.nc_id = p_nc
  ) q;
  return jsonb_build_object('nc_id', p_nc, 'impacts', v_items);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Retouche et rebut terminal
-- ---------------------------------------------------------------------------
-- Retouche : le lot impacté est bloqué (sauf déjà bloqué) ; la disposition reste ouverte jusqu'à la libération du lot.
create function public.quality_nc_rework(p_impact uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.quality_nc_impacts%rowtype; n public.quality_nonconformities%rowtype;
  v_status text; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quality.write');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'NC_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into i from public.quality_nc_impacts where id = p_impact and company_id = v_co;
  if not found then raise exception 'NC_IMPACT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into n from public.quality_nonconformities where id = i.nc_id for update;
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.quality_nc_dispositions where impact_id = p_impact) then raise exception 'NC_ALREADY_DISPOSITIONED' using errcode = '55000'; end if;
  select coalesce(status, 'released') into v_status from public.lot_quality_states where lot_kind = i.lot_kind and lot_id = i.lot_id;
  v_status := coalesce(v_status, 'released');  -- sans ligne de statut, le lot est libéré (SELECT INTO sans ligne met NULL)
  if v_status = 'rejected' then raise exception 'NC_SCRAPPED_TERMINAL' using errcode = '55000'; end if;
  if v_status = 'released' then
    perform public.lot_quality_hold(i.lot_kind, i.lot_id, 'blocked', 'Retouche non-conformité ' || n.number || ' : ' || btrim(p_reason), false);
  end if;
  insert into public.quality_nc_dispositions (id, company_id, nc_id, impact_id, kind, qty, reason, decided_by)
  values (v_id, v_co, n.id, i.id, 'rework', i.qty, btrim(p_reason), auth.uid());
  perform private.write_audit(v_co, 'quality.nc_rework', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('lot_kind', i.lot_kind, 'lot_id', i.lot_id, 'qty', i.qty), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

-- Fin de retouche : libération du lot par la qualité (distincte de celui qui a bloqué, 0077).
create function public.quality_nc_rework_complete(p_disposition uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.quality_nc_dispositions%rowtype; i public.quality_nc_impacts%rowtype;
begin
  select * into d from public.quality_nc_dispositions where id = p_disposition and company_id = v_co for update;
  if not found then raise exception 'NC_BAD_DISPOSITION' using errcode = 'P0002'; end if;
  if d.kind <> 'rework' or d.completed_at is not null then raise exception 'NC_BAD_DISPOSITION' using errcode = '55000'; end if;
  select * into i from public.quality_nc_impacts where id = d.impact_id;
  perform public.lot_quality_release(i.lot_kind, i.lot_id, p_reason);
  update public.quality_nc_dispositions set completed_by = auth.uid(), completed_at = now() where id = p_disposition;
  perform private.write_audit(v_co, 'quality.nc_rework_complete', 'quality_nc_disposition', d.id::text, null, null,
    jsonb_build_object('lot_kind', i.lot_kind, 'lot_id', i.lot_id), jsonb_build_object('reason', btrim(coalesce(p_reason, ''))), 'rpc');
end $$;

-- Rebut terminal : lot rejeté (définitif), quantité sortie du stock par un mouvement tracé (matière) ou une sortie de variante (produit fini).
create function public.quality_nc_scrap(p_impact uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.quality_nc_impacts%rowtype; n public.quality_nonconformities%rowtype;
  v_status text; v_id uuid := gen_random_uuid(); v_sl public.stock_lots%rowtype; v_fl public.finished_lots%rowtype;
begin
  perform private.require_perm('quality.approve');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'NC_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into i from public.quality_nc_impacts where id = p_impact and company_id = v_co;
  if not found then raise exception 'NC_IMPACT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into n from public.quality_nonconformities where id = i.nc_id for update;
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.quality_nc_dispositions where impact_id = p_impact) then raise exception 'NC_ALREADY_DISPOSITIONED' using errcode = '55000'; end if;
  select coalesce(status, 'released') into v_status from public.lot_quality_states where lot_kind = i.lot_kind and lot_id = i.lot_id;
  v_status := coalesce(v_status, 'released');  -- sans ligne de statut, le lot est libéré (SELECT INTO sans ligne met NULL)
  if v_status = 'rejected' then raise exception 'NC_SCRAPPED_TERMINAL' using errcode = '55000'; end if;
  if i.lot_kind = 'material' then
    perform private.require_perm('stock.write');
    select * into v_sl from public.stock_lots where id = i.lot_id and company_id = v_co for update;
    if not found then raise exception 'NC_IMPACT_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_sl.qty_remaining < i.qty then raise exception 'NC_QTY_EXCEEDS_LOT' using errcode = '22023'; end if;
    perform public.lot_quality_reject('material', i.lot_id, btrim(p_reason));
    perform private.nc_stock_scrap(v_co, i.lot_id, i.qty, n.number);
  else
    perform private.require_perm('variants.stock');
    select * into v_fl from public.finished_lots where id = i.lot_id and company_id = v_co;
    if not found then raise exception 'NC_IMPACT_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_fl.qty_in - v_fl.qty_out < i.qty then raise exception 'NC_QTY_EXCEEDS_LOT' using errcode = '22023'; end if;
    if i.qty <> trunc(i.qty) then raise exception 'NC_QTY_INVALID' using errcode = '22023'; end if;
    perform public.lot_quality_reject('finished', i.lot_id, btrim(p_reason));
    perform public.variant_stock_move(v_fl.variant_id, 'issue', v_fl.warehouse_id, i.qty::int, null, 'Rebut non-conformité ' || n.number, n.number);
  end if;
  insert into public.quality_nc_dispositions (id, company_id, nc_id, impact_id, kind, qty, reason, decided_by, completed_by, completed_at)
  values (v_id, v_co, n.id, i.id, 'scrap', i.qty, btrim(p_reason), auth.uid(), auth.uid(), now());
  perform private.write_audit(v_co, 'quality.nc_scrap', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('lot_kind', i.lot_kind, 'lot_id', i.lot_id, 'qty', i.qty), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Causes, responsable, échéance
-- ---------------------------------------------------------------------------
create function public.quality_nc_set_cause(p_nc uuid, p_category text, p_root_cause text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); n public.quality_nonconformities%rowtype; v_root text := btrim(coalesce(p_root_cause, ''));
begin
  perform private.require_perm('quality.write');
  if p_category not in ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other') then
    raise exception 'NC_CAUSE_INVALID' using errcode = '22023';
  end if;
  if length(v_root) < 5 then raise exception 'NC_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into n from public.quality_nonconformities where id = p_nc and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_nonconformities set cause_category = p_category, root_cause = v_root where id = p_nc;
  perform private.write_audit(v_co, 'quality.nc_cause', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('cause_category', p_category), jsonb_build_object('root_cause', v_root), 'rpc');
end $$;

create function public.quality_nc_assign(p_nc uuid, p_owner uuid, p_due date) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); n public.quality_nonconformities%rowtype;
begin
  perform private.require_perm('quality.write');
  if p_owner is null or not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = p_owner and r.company_id = v_co) then
    raise exception 'NC_OWNER_INVALID' using errcode = '22023';
  end if;
  if p_due is null then raise exception 'NC_DUE_REQUIRED' using errcode = '22023'; end if;
  select * into n from public.quality_nonconformities where id = p_nc and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_nonconformities set owner_id = p_owner, due_date = p_due where id = p_nc;
  perform private.write_audit(v_co, 'quality.nc_assign', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('owner_id', p_owner, 'due_date', p_due), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 8. Coûts de non-qualité (droit distinct)
-- ---------------------------------------------------------------------------
create function public.quality_nc_cost_add(p_nc uuid, p_kind text, p_amount numeric, p_currency text, p_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); n public.quality_nonconformities%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quality.cost');
  if p_kind not in ('rework', 'scrap', 'other') then raise exception 'NC_COST_KIND_INVALID' using errcode = '22023'; end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'NC_CURRENCY_INVALID' using errcode = '22023'; end if;
  select * into n from public.quality_nonconformities where id = p_nc and company_id = v_co;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.quality_nc_costs (id, company_id, nc_id, kind, amount, currency, label)
  values (v_id, v_co, n.id, p_kind, p_amount, p_currency, btrim(p_label));
  perform private.write_audit(v_co, 'quality.nc_cost', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('kind', p_kind, 'amount', p_amount, 'currency', p_currency), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.quality_nc_costs(p_nc uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_rows jsonb; v_totals jsonb;
begin
  perform private.require_perm('quality.cost');
  if not exists (select 1 from public.quality_nonconformities where id = p_nc and company_id = v_co) then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', c.kind, 'amount', c.amount, 'currency', c.currency, 'label', c.label) order by c.recorded_at), '[]'::jsonb)
    into v_rows from public.quality_nc_costs c where c.nc_id = p_nc;
  select coalesce(jsonb_object_agg(t.currency, t.total), '{}'::jsonb) into v_totals
    from (select c.currency, sum(c.amount) total from public.quality_nc_costs c where c.nc_id = p_nc group by c.currency) t;
  return jsonb_build_object('nc_id', p_nc, 'costs', v_rows, 'totals_by_currency', v_totals);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Clôture : règles bloquantes, codes distincts
-- ---------------------------------------------------------------------------
-- Liste des règles non satisfaites, dans l'ordre de contrôle. Ne vérifie aucun droit (appelée par les fonctions autorisées).
create function private.nc_closure_blockers(p_nc uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_b text[] := '{}'; v_impacts int; v_undisp int; v_rework int;
  v_open int; v_last_eff timestamptz; v_last_ineff timestamptz; v_eff int;
begin
  select * into n from public.quality_nonconformities where id = p_nc;
  if n.cause_category is null then v_b := array_append(v_b, 'CAUSE_MISSING'); end if;
  if n.root_cause is null then v_b := array_append(v_b, 'ROOT_CAUSE_MISSING'); end if;
  if n.owner_id is null then v_b := array_append(v_b, 'OWNER_MISSING'); end if;
  if n.due_date is null then v_b := array_append(v_b, 'DUE_MISSING'); end if;
  select count(*) into v_impacts from public.quality_nc_impacts where nc_id = p_nc;
  if v_impacts = 0 and n.no_impact_reason is null then v_b := array_append(v_b, 'SCOPE_NOT_ASSESSED'); end if;
  select count(*) filter (where d.id is null), count(*) filter (where d.kind = 'rework' and d.completed_at is null)
    into v_undisp, v_rework
    from public.quality_nc_impacts i left join public.quality_nc_dispositions d on d.impact_id = i.id where i.nc_id = p_nc;
  if v_undisp > 0 then v_b := array_append(v_b, 'IMPACT_NOT_DISPOSITIONED'); end if;
  if v_rework > 0 then v_b := array_append(v_b, 'REWORK_PENDING'); end if;
  select count(*) filter (where status in ('todo', 'in_progress', 'done')),
         count(*) filter (where status = 'verified' and effective),
         max(verified_at) filter (where status = 'verified' and effective),
         max(verified_at) filter (where status = 'verified' and effective is not true)
    into v_open, v_eff, v_last_eff, v_last_ineff
    from public.quality_corrective_actions where nc_id = p_nc;
  if v_open > 0 then v_b := array_append(v_b, 'ACTIONS_OPEN'); end if;
  -- une action inefficace bloque tant qu'une action efficace ultérieure ne la remplace pas
  if v_last_ineff is not null and (v_last_eff is null or v_last_eff < v_last_ineff) then v_b := array_append(v_b, 'ACTION_INEFFECTIVE'); end if;
  if v_eff = 0 then v_b := array_append(v_b, 'EFFECTIVENESS_NOT_VERIFIED'); end if;
  return v_b;
end $$;
revoke execute on function private.nc_closure_blockers(uuid) from public, anon, authenticated;

create function public.quality_nc_closure(p_nc uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); n public.quality_nonconformities%rowtype; v_b text[];
begin
  perform private.require_perm('quality.read');
  select * into n from public.quality_nonconformities where id = p_nc and company_id = v_co;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  v_b := private.nc_closure_blockers(p_nc);
  return jsonb_build_object('nc_id', p_nc, 'status', n.status, 'closable', n.status = 'contained' and cardinality(v_b) = 0,
    'blockers', to_jsonb(v_b));
end $$;

-- Clôture : redéfinie (même signature que 0020). Chaque règle non satisfaite lève son propre code NC_CLOSE_<code>.
-- Sans efficacité vérifiée, la justification écrite (≥ 10 caractères) reste possible, comme avant.
create or replace function public.quality_nc_close(p_nc uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_b text[]; v_first text;
begin
  perform private.require_perm('quality.approve');
  n := private.quality_lock_nc(p_nc);
  if n.status <> 'contained' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  v_b := private.nc_closure_blockers(p_nc);
  if v_note is not null and length(v_note) >= 10 then v_b := array_remove(v_b, 'EFFECTIVENESS_NOT_VERIFIED'); end if;
  if cardinality(v_b) > 0 then
    v_first := v_b[1];
    if v_first = 'EFFECTIVENESS_NOT_VERIFIED' then raise exception 'QUALITY_JUSTIFICATION_REQUIRED' using errcode = '22023'; end if;
    raise exception 'NC_CLOSE_%', v_first using errcode = '55000';
  end if;
  update public.quality_nonconformities set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_note = v_note where id = n.id;
  perform private.write_audit(n.company_id, 'quality.nc_close', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('blockers_checked', true, 'justified', v_note is not null), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 10. Surveillance CAPA : retards et inefficacités non clôturées
-- ---------------------------------------------------------------------------
create function public.quality_capa_watch() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_late jsonb; v_nc_late jsonb; v_ineff jsonb;
begin
  perform private.require_perm('quality.read');
  select coalesce(jsonb_agg(jsonb_build_object('action', a.number, 'nc', n.number, 'due_date', a.due_date, 'status', a.status) order by a.due_date), '[]'::jsonb)
    into v_late from public.quality_corrective_actions a join public.quality_nonconformities n on n.id = a.nc_id
    where a.company_id = v_co and a.status in ('todo', 'in_progress', 'done') and a.due_date < current_date;
  select coalesce(jsonb_agg(jsonb_build_object('nc', n.number, 'due_date', n.due_date, 'status', n.status) order by n.due_date), '[]'::jsonb)
    into v_nc_late from public.quality_nonconformities n
    where n.company_id = v_co and n.status <> 'closed' and n.due_date < current_date;
  select coalesce(jsonb_agg(jsonb_build_object('nc', n.number, 'action', a.number, 'verified_at', a.verified_at) order by n.number), '[]'::jsonb)
    into v_ineff from public.quality_nonconformities n join public.quality_corrective_actions a on a.nc_id = n.id
    where n.company_id = v_co and n.status <> 'closed' and a.status = 'verified' and a.effective is not true
      and not exists (select 1 from public.quality_corrective_actions b where b.nc_id = n.id and b.status = 'verified' and b.effective
                      and b.verified_at > a.verified_at);
  return jsonb_build_object('overdue_actions', v_late, 'overdue_nonconformities', v_nc_late, 'ineffective_open', v_ineff);
end $$;

-- ---------------------------------------------------------------------------
-- 11. Privilèges
-- ---------------------------------------------------------------------------
alter table public.quality_nc_impacts enable row level security;
alter table public.quality_nc_dispositions enable row level security;
alter table public.quality_nc_costs enable row level security;
create policy quality_nc_impacts_select on public.quality_nc_impacts for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy quality_nc_dispositions_select on public.quality_nc_dispositions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy quality_nc_costs_select on public.quality_nc_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.cost'));
revoke all on public.quality_nc_impacts, public.quality_nc_dispositions, public.quality_nc_costs from anon, authenticated;
grant select on public.quality_nc_impacts, public.quality_nc_dispositions, public.quality_nc_costs to authenticated;
grant all on public.quality_nc_impacts, public.quality_nc_dispositions, public.quality_nc_costs to service_role;

revoke execute on function public.quality_nc_impact_add(uuid, text, uuid, numeric), public.quality_nc_scope_declare(uuid, text),
  public.quality_nc_scope(uuid), public.quality_nc_rework(uuid, text), public.quality_nc_rework_complete(uuid, text),
  public.quality_nc_scrap(uuid, text), public.quality_nc_set_cause(uuid, text, text), public.quality_nc_assign(uuid, uuid, date),
  public.quality_nc_cost_add(uuid, text, numeric, text, text), public.quality_nc_costs(uuid), public.quality_nc_closure(uuid),
  public.quality_capa_watch() from public, anon;
grant execute on function public.quality_nc_impact_add(uuid, text, uuid, numeric), public.quality_nc_scope_declare(uuid, text),
  public.quality_nc_scope(uuid), public.quality_nc_rework(uuid, text), public.quality_nc_rework_complete(uuid, text),
  public.quality_nc_scrap(uuid, text), public.quality_nc_set_cause(uuid, text, text), public.quality_nc_assign(uuid, uuid, date),
  public.quality_nc_cost_add(uuid, text, numeric, text, text), public.quality_nc_costs(uuid), public.quality_nc_closure(uuid),
  public.quality_capa_watch() to authenticated, service_role;
