-- 0066_inventory_blind_count_approval — Inventaire : comptage aveugle, recomptage, gel ciblé, accord distinct, écarts expliqués, valorisation.
--
-- Principes :
--  * Comptage aveugle : le compteur ne voit ni le théorique (system_qty) ni les quantités des autres compteurs.
--    La table des lignes n'est plus lisible directement (colonnes théorique, comptée et écart retirées aux rôles applicatifs) ;
--    le compteur passe par inventory_lines_for_count (sans quantité) et inventory_count_submit (sa seule saisie).
--  * Recomptage : une ligne dont le comptage 1 ne correspond pas au théorique attendu passe en recomptage (2e passage,
--    par un autre compteur, toujours aveugle). Pas de tolérance paramétrée : tout écart non expliqué déclenche le recomptage.
--  * Gel ciblé (option par inventaire) : pendant le comptage, les mouvements sur les lignes gelées (matière + emplacement)
--    sont refusés (STOCK_COUNT_FROZEN). Sans gel, les mouvements simultanés sont acceptés et expliqués (voir ci-dessous).
--  * Écarts expliqués : théorique attendu = théorique au comptage + mouvements survenus après le relevé de la ligne.
--    L'écart non expliqué = comptage final − théorique attendu. Seul l'écart non expliqué déclenche un recomptage.
--  * Accord distinct : demande par un utilisateur ; décision par un utilisateur avec stock.adjust qui n'est ni le demandeur,
--    ni un compteur de cet inventaire (SOD_SELF_APPROVAL, SOD_COUNTER_APPROVAL). Motif obligatoire à la décision.
--  * Ajustement : appliqué à la décision, à l'écart entre le comptage final et le stock réel à ce moment (mouvements simultanés
--    pris en compte). Mouvements 'inventory' en ajout seul : le journal historique n'est jamais réécrit.
--  * Valorisation : la méthode n'est pas décidée dans le dépôt. Seule la méthode actuelle (coût du lot, lot_cost) est acceptée ;
--    la valeur reste « à confirmer » tant que la finance n'a pas confirmé (stock_valuation_settings). Aucune méthode n'est inventée.
--  * Rapprochement : quantités (journal = lots) et valeurs (journal valorisé = valeur des lots) contrôlées par matière.
--  * Additif : colonnes nouvelles, tables nouvelles, fonctions nouvelles. La validation directe de 0009 est désactivée
--    (décision à valider par le propriétaire, voir PROJECT_STATE) ; aucune donnée n'est supprimée.
--  Erreurs : INVENTORY_BAD_PHASE, INVENTORY_LINES_NOT_COUNTED, COUNT_ALREADY_SUBMITTED, COUNT_SAME_COUNTER, COUNT_NOT_REQUIRED,
--  INVENTORY_REASON_REQUIRED, INVENTORY_APPROVAL_REQUIRED, INVENTORY_FREEZE_LOCKED, SOD_SELF_APPROVAL, SOD_COUNTER_APPROVAL,
--  STOCK_COUNT_FROZEN, STOCK_VALUATION_METHOD_UNSUPPORTED, STOCK_BAD_QTY, WAREHOUSE_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Colonnes additives
-- ---------------------------------------------------------------------------
alter table public.stock_inventories
  add column if not exists targeted_freeze boolean not null default false,
  add column if not exists phase text not null default 'counting'
    check (phase in ('counting', 'recounting', 'reconciling', 'pending_approval', 'validated', 'cancelled')),
  add column if not exists approval_requested_by uuid,
  add column if not exists approval_requested_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists approved_at timestamptz,
  add column if not exists decision_reason text check (decision_reason is null or length(decision_reason) <= 500);
update public.stock_inventories set phase = case status when 'validated' then 'validated' when 'cancelled' then 'cancelled' else 'counting' end
  where phase = 'counting' and status <> 'draft';

alter table public.stock_inventory_lines
  add column if not exists recount_needed boolean not null default false,
  add column if not exists snapshot_at timestamptz not null default clock_timestamp();
update public.stock_inventory_lines l set snapshot_at = i.created_at from public.stock_inventories i where i.id = l.inventory_id;

-- ---------------------------------------------------------------------------
-- 2. Comptage aveugle : lecture et écriture directes retirées aux rôles applicatifs
-- ---------------------------------------------------------------------------
revoke update (counted_qty) on public.stock_inventory_lines from authenticated;
revoke select on public.stock_inventory_lines from authenticated;
grant select (id, company_id, inventory_id, material_id, location_id, recount_needed) on public.stock_inventory_lines to authenticated;

-- Saisies de comptage : une ligne par passage (1 ou 2) et par ligne ; ajout seul ; lecture par RPC seulement.
create table public.stock_inventory_count_entries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  inventory_id uuid not null references public.stock_inventories(id) on delete restrict,
  line_id     uuid not null references public.stock_inventory_lines(id) on delete restrict,
  round       int not null check (round in (1, 2)),
  counted_qty numeric(14,4) not null check (counted_qty >= 0),
  counted_by  uuid not null default auth.uid(),
  counted_at  timestamptz not null default clock_timestamp(),
  unique (line_id, round)
);
create trigger stock_inv_entries_immutable before update or delete on public.stock_inventory_count_entries
  for each row execute function private.stock_immutable();
alter table public.stock_inventory_count_entries enable row level security;
revoke all on public.stock_inventory_count_entries from public, anon, authenticated;

-- Réglage de valorisation par société : méthode et confirmation par la finance.
create table public.stock_valuation_settings (
  company_id    uuid primary key references public.companies(id) on delete cascade,
  method        text not null default 'lot_cost' check (method in ('lot_cost')),
  confirmed     boolean not null default false,
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.stock_valuation_settings enable row level security;
revoke all on public.stock_valuation_settings from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Gel ciblé : mouvements refusés sur les lignes gelées pendant le comptage
-- ---------------------------------------------------------------------------
create function private.stock_count_freeze_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type = 'inventory' then return new; end if;
  if exists (select 1 from public.stock_inventories i join public.stock_inventory_lines l on l.inventory_id = i.id
             where i.company_id = new.company_id and i.targeted_freeze and i.phase in ('counting', 'recounting', 'reconciling', 'pending_approval')
               and i.warehouse_id = new.warehouse_id and l.material_id = new.material_id
               and (l.location_id = new.location_id or (new.to_location_id is not null and l.location_id = new.to_location_id)))
  then raise exception 'STOCK_COUNT_FROZEN' using errcode = '55000'; end if;
  return new;
end $$;
create trigger stock_movements_count_freeze before insert on public.stock_movements
  for each row execute function private.stock_count_freeze_guard();

-- ---------------------------------------------------------------------------
-- 4. Théorique attendu : mouvements survenus après le relevé de la ligne (hors ajustements de cet inventaire)
-- ---------------------------------------------------------------------------
-- Moment du comptage final de la ligne (passage 2 s'il existe, sinon passage 1) ; infini tant que la ligne n'est pas comptée.
create function private.inv_count_time(p_line uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce((select counted_at from public.stock_inventory_count_entries where line_id = p_line and round = 2),
                  (select counted_at from public.stock_inventory_count_entries where line_id = p_line and round = 1),
                  'infinity'::timestamptz) $$;
revoke execute on function private.inv_count_time(uuid) from public, anon, authenticated;

-- Effet net des mouvements sur la ligne : entre le relevé de la ligne et le comptage final (expliqué) ou après le comptage final.
create function private.inv_movements_window(p_line uuid, p_after boolean) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case
      when m.direction = 'in' and m.location_id = l.location_id then m.qty
      when m.direction = 'out' and m.location_id = l.location_id then -m.qty
      when m.direction = 'move' and m.location_id = l.location_id then -m.qty
      when m.direction = 'move' and m.to_location_id = l.location_id then m.qty
      else 0 end), 0)
  from public.stock_inventory_lines l
  join public.stock_inventories i on i.id = l.inventory_id
  join public.stock_movements m on m.material_id = l.material_id and m.created_at > l.snapshot_at
       and (m.inventory_id is distinct from i.id)
  where l.id = p_line
    and (case when p_after then m.created_at > private.inv_count_time(l.id) else m.created_at <= private.inv_count_time(l.id) end) $$;
revoke execute on function private.inv_movements_window(uuid, boolean) from public, anon, authenticated;

create function private.inv_movements_since(p_line uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select private.inv_movements_window(p_line, false) $$;
revoke execute on function private.inv_movements_since(uuid) from public, anon, authenticated;

create function private.inv_entry(p_line uuid, p_round int) returns numeric
language sql stable security definer set search_path = '' as $$
  select counted_qty from public.stock_inventory_count_entries where line_id = p_line and round = p_round $$;
revoke execute on function private.inv_entry(uuid, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Comptage (aveugle) : liste sans quantités, saisie, clôture des passages
-- ---------------------------------------------------------------------------
create function public.stock_inventory_freeze_set(p_inventory uuid, p_freeze boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if i.phase <> 'counting' then raise exception 'INVENTORY_BAD_PHASE' using errcode = '55000'; end if;
  if exists (select 1 from public.stock_inventory_count_entries where inventory_id = i.id) then raise exception 'INVENTORY_FREEZE_LOCKED' using errcode = '55000'; end if;
  update public.stock_inventories set targeted_freeze = coalesce(p_freeze, false) where id = i.id;
  perform private.write_audit(v_co, 'inventory.freeze', 'inventory', i.id::text, i.code, jsonb_build_object('freeze', i.targeted_freeze),
    jsonb_build_object('freeze', coalesce(p_freeze, false)), '{}'::jsonb, 'rpc');
end $$;

-- Liste pour le compteur : aucune quantité (ni théorique, ni comptée, ni écart).
create function public.stock_inventory_lines_for_count(p_inventory uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype; v jsonb;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'material_id', l.material_id, 'location_id', l.location_id,
           'recount_needed', l.recount_needed, 'my_rounds', coalesce((select jsonb_agg(e.round order by e.round) from public.stock_inventory_count_entries e
             where e.line_id = l.id and e.counted_by = auth.uid()), '[]'::jsonb)) order by l.material_id, l.location_id), '[]'::jsonb)
    into v from public.stock_inventory_lines l where l.inventory_id = i.id;
  return jsonb_build_object('inventory_id', i.id, 'code', i.code, 'phase', i.phase, 'lines', v);
end $$;

create function public.stock_inventory_count_submit(p_line uuid, p_qty numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype; l public.stock_inventory_lines%rowtype; v_round int;
begin
  perform private.require_perm('stock.write');
  select * into l from public.stock_inventory_lines where id = p_line and company_id = v_co for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into i from public.stock_inventories where id = l.inventory_id for share;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  v_round := case i.phase when 'counting' then 1 when 'recounting' then 2 else null end;
  if v_round is null then raise exception 'INVENTORY_BAD_PHASE' using errcode = '55000'; end if;
  if v_round = 2 and not l.recount_needed then raise exception 'COUNT_NOT_REQUIRED' using errcode = '55000'; end if;
  if exists (select 1 from public.stock_inventory_count_entries where line_id = l.id and round = v_round) then
    raise exception 'COUNT_ALREADY_SUBMITTED' using errcode = '55000';
  end if;
  if v_round = 2 and exists (select 1 from public.stock_inventory_count_entries where line_id = l.id and round = 1 and counted_by = auth.uid()) then
    raise exception 'COUNT_SAME_COUNTER' using errcode = '55000';
  end if;
  insert into public.stock_inventory_count_entries (company_id, inventory_id, line_id, round, counted_qty, counted_by)
  values (v_co, i.id, l.id, v_round, p_qty, auth.uid());
  perform private.write_audit(v_co, 'inventory.count', 'inventory', i.id::text, i.code, null,
    jsonb_build_object('line', l.id, 'round', v_round), '{}'::jsonb, 'rpc');
  return jsonb_build_object('ok', true, 'round', v_round);
end $$;

-- Clôture du passage 1 : calcule l'écart non expliqué ; tout écart non expliqué déclenche un recomptage.
create function public.stock_inventory_close_count(p_inventory uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype; ln record; v_c1 numeric; v_exp numeric; v_recount int := 0; v_missing int;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if i.phase <> 'counting' then raise exception 'INVENTORY_BAD_PHASE' using errcode = '55000'; end if;
  select count(*) into v_missing from public.stock_inventory_lines l where l.inventory_id = i.id
    and not exists (select 1 from public.stock_inventory_count_entries e where e.line_id = l.id and e.round = 1);
  if v_missing > 0 then raise exception 'INVENTORY_LINES_NOT_COUNTED' using errcode = '55000'; end if;
  perform set_config('stock.rpc', 'on', true);
  for ln in select * from public.stock_inventory_lines where inventory_id = i.id order by id loop
    v_c1 := private.inv_entry(ln.id, 1);
    v_exp := ln.system_qty + private.inv_movements_since(ln.id);
    update public.stock_inventory_lines set counted_qty = v_c1, recount_needed = (v_c1 <> v_exp) where id = ln.id;
    if v_c1 <> v_exp then v_recount := v_recount + 1; end if;
  end loop;
  perform set_config('stock.rpc', 'off', true);
  update public.stock_inventories set phase = case when v_recount > 0 then 'recounting' else 'reconciling' end where id = i.id;
  perform private.write_audit(v_co, 'inventory.close_count', 'inventory', i.id::text, i.code, null,
    jsonb_build_object('recount_lines', v_recount), '{}'::jsonb, 'rpc');
  return jsonb_build_object('phase', case when v_recount > 0 then 'recounting' else 'reconciling' end, 'recount_lines', v_recount);
end $$;

-- Clôture du recomptage : chaque ligne à recompter doit avoir son passage 2.
create function public.stock_inventory_close_recount(p_inventory uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype; ln record; v_missing int; v_n int := 0;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if i.phase <> 'recounting' then raise exception 'INVENTORY_BAD_PHASE' using errcode = '55000'; end if;
  select count(*) into v_missing from public.stock_inventory_lines l where l.inventory_id = i.id and l.recount_needed
    and not exists (select 1 from public.stock_inventory_count_entries e where e.line_id = l.id and e.round = 2);
  if v_missing > 0 then raise exception 'INVENTORY_LINES_NOT_COUNTED' using errcode = '55000'; end if;
  perform set_config('stock.rpc', 'on', true);
  for ln in select * from public.stock_inventory_lines where inventory_id = i.id and recount_needed order by id loop
    update public.stock_inventory_lines set counted_qty = private.inv_entry(ln.id, 2) where id = ln.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('stock.rpc', 'off', true);
  update public.stock_inventories set phase = 'reconciling' where id = i.id;
  perform private.write_audit(v_co, 'inventory.close_recount', 'inventory', i.id::text, i.code, null,
    jsonb_build_object('recounted_lines', v_n), '{}'::jsonb, 'rpc');
  return jsonb_build_object('phase', 'reconciling', 'recounted_lines', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Demande d'accord et décision (distincte du compteur et du demandeur)
-- ---------------------------------------------------------------------------
create function public.stock_inventory_request_approval(p_inventory uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if i.phase <> 'reconciling' then raise exception 'INVENTORY_BAD_PHASE' using errcode = '55000'; end if;
  update public.stock_inventories set phase = 'pending_approval', approval_requested_by = auth.uid(), approval_requested_at = now() where id = i.id;
  perform private.write_audit(v_co, 'inventory.request_approval', 'inventory', i.id::text, i.code, null, jsonb_build_object('phase', 'pending_approval'), '{}'::jsonb, 'rpc');
end $$;

create function public.stock_inventory_decide(p_inventory uuid, p_approve boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype; l record; v_cur numeric; v_delta numeric; v_mov uuid; v_adj int := 0; v_qty_sum numeric := 0;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('stock.adjust');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if i.phase <> 'pending_approval' then raise exception 'INVENTORY_BAD_PHASE' using errcode = '55000'; end if;
  if length(v_reason) < 5 then raise exception 'INVENTORY_REASON_REQUIRED' using errcode = '22023'; end if;
  if i.approval_requested_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  if exists (select 1 from public.stock_inventory_count_entries where inventory_id = i.id and counted_by = auth.uid()) then
    raise exception 'SOD_COUNTER_APPROVAL' using errcode = '42501';
  end if;
  if not p_approve then
    update public.stock_inventories set phase = 'reconciling', decision_reason = v_reason where id = i.id;
    perform private.write_audit(v_co, 'inventory.refuse', 'inventory', i.id::text, i.code, jsonb_build_object('phase', 'pending_approval'),
      jsonb_build_object('phase', 'reconciling'), jsonb_build_object('reason', v_reason), 'rpc');
    return jsonb_build_object('status', 'refused');
  end if;
  perform set_config('stock.rpc', 'on', true);
  for l in select * from public.stock_inventory_lines where inventory_id = i.id order by id loop
    v_cur := private.stock_on_hand(l.material_id, i.warehouse_id, l.location_id);
    v_delta := coalesce(l.counted_qty, 0) - v_cur;
    if v_delta <> 0 then
      v_mov := private.stock_apply('inventory', case when v_delta > 0 then 'in' else 'out' end, l.material_id, abs(v_delta), i.warehouse_id, l.location_id,
                                   null, i.code, 'Inventaire ' || i.code || ' : ' || v_reason, null, null, i.id);
      v_adj := v_adj + 1; v_qty_sum := v_qty_sum + v_delta;
    end if;
    update public.stock_inventory_lines set applied_delta = v_delta where id = l.id;
  end loop;
  perform set_config('stock.rpc', 'off', true);
  update public.stock_inventories set phase = 'validated', status = 'validated', closed_at = now(), closed_by = auth.uid(),
    approved_by = auth.uid(), approved_at = now(), decision_reason = v_reason where id = i.id;
  perform private.write_audit(v_co, 'inventory.validate', 'inventory', i.id::text, i.code, null,
    jsonb_build_object('adjusted', v_adj, 'qty_delta', v_qty_sum), jsonb_build_object('reason', v_reason), 'rpc');
  return jsonb_build_object('status', 'validated', 'adjusted', v_adj, 'qty_delta', v_qty_sum);
end $$;

-- Validation directe de 0009 : désactivée. La validation passe par l'accord distinct ci-dessus.
create or replace function public.stock_inventory_validate(p_inventory uuid) returns int
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'INVENTORY_APPROVAL_REQUIRED' using errcode = '55000';
end $$;

-- Annulation : même règle que 0009, plus la phase.
create or replace function public.stock_inventory_cancel(p_inventory uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  update public.stock_inventories set status = 'cancelled', phase = 'cancelled', closed_at = now(), closed_by = auth.uid() where id = p_inventory;
  perform private.write_audit(i.company_id, 'inventory.cancel', 'inventory', i.id::text, i.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Valorisation : méthode et confirmation par la finance
-- ---------------------------------------------------------------------------
create function public.stock_valuation_set(p_method text, p_confirmed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_before record;
begin
  perform private.require_perm('costs.read');
  if p_method is null or p_method <> 'lot_cost' then raise exception 'STOCK_VALUATION_METHOD_UNSUPPORTED' using errcode = '22023'; end if;
  select method, confirmed into v_before from public.stock_valuation_settings where company_id = v_co;
  insert into public.stock_valuation_settings (company_id, method, confirmed, confirmed_by, confirmed_at)
  values (v_co, p_method, coalesce(p_confirmed, false), case when coalesce(p_confirmed, false) then auth.uid() end, case when coalesce(p_confirmed, false) then now() end)
  on conflict (company_id) do update set method = excluded.method, confirmed = excluded.confirmed,
    confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at, updated_at = now();
  perform private.write_audit(v_co, 'stock.valuation_set', 'company', v_co::text, 'valorisation', jsonb_build_object('method', v_before.method, 'confirmed', v_before.confirmed),
    jsonb_build_object('method', p_method, 'confirmed', coalesce(p_confirmed, false)), '{}'::jsonb, 'rpc');
  return jsonb_build_object('method', p_method, 'confirmed', coalesce(p_confirmed, false));
end $$;

-- ---------------------------------------------------------------------------
-- 8. Rapprochement : quantités et valeurs, écarts expliqués, par ligne et par matière
-- ---------------------------------------------------------------------------
create function public.stock_inventory_reconcile(p_inventory uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.stock_inventories%rowtype; v_lines jsonb; v_mats jsonb; v_set public.stock_valuation_settings%rowtype;
  v_adj_qty numeric; v_adj_value numeric; v_mov_qty numeric; v_mov_value numeric;
begin
  perform private.require_perm('stock.adjust');
  select * into i from public.stock_inventories where id = p_inventory and company_id = v_co;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(i.warehouse_id, 'viewer') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select * into v_set from public.stock_valuation_settings where company_id = v_co;
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'material_id', l.material_id, 'location_id', l.location_id,
           'system_qty', l.system_qty, 'movements_since', private.inv_movements_since(l.id),
           'expected_qty', l.system_qty + private.inv_movements_since(l.id), 'movements_after_count', private.inv_movements_window(l.id, true),
           'round1', private.inv_entry(l.id, 1), 'round2', private.inv_entry(l.id, 2),
           'final_qty', l.counted_qty, 'recount_needed', l.recount_needed,
           'unexplained', case when l.counted_qty is null then null else l.counted_qty - (l.system_qty + private.inv_movements_since(l.id)) end,
           'on_hand_now', private.stock_on_hand(l.material_id, i.warehouse_id, l.location_id),
           'applied_delta', l.applied_delta) order by l.material_id, l.location_id), '[]'::jsonb)
    into v_lines from public.stock_inventory_lines l where l.inventory_id = i.id;
  -- Ajustements de cet inventaire : quantité et valeur (coût des mouvements)
  select coalesce(sum(case when m.direction = 'in' then m.qty else -m.qty end), 0),
         coalesce(sum(case when m.direction = 'in' then c.total_cost else -c.total_cost end), 0)
    into v_mov_qty, v_mov_value
    from public.stock_movements m left join public.stock_movement_costs c on c.movement_id = m.id
    where m.inventory_id = i.id and m.type = 'inventory';
  select coalesce(sum(l.applied_delta), 0) into v_adj_qty from public.stock_inventory_lines l where l.inventory_id = i.id;
  -- Journal valorisé contre valeur des lots, par matière (société entière)
  select coalesce(jsonb_agg(jsonb_build_object('material_id', x.material_id,
           'journal_qty', x.jq, 'lot_qty', x.lq, 'qty_difference', x.jq - x.lq,
           'journal_value', x.jv, 'lot_value', x.lv, 'value_difference', x.jv - x.lv) order by x.material_id), '[]'::jsonb)
    into v_mats
    from (
      select mat.material_id,
        coalesce((select sum(case m.direction when 'in' then m.qty when 'out' then -m.qty else 0 end) from public.stock_movements m
                  where m.company_id = v_co and m.material_id = mat.material_id), 0) as jq,
        coalesce((select sum(sl.qty_remaining) from public.stock_lots sl where sl.company_id = v_co and sl.material_id = mat.material_id), 0) as lq,
        coalesce((select sum(case m.direction when 'in' then c.total_cost when 'out' then -c.total_cost else 0 end) from public.stock_movements m
                  join public.stock_movement_costs c on c.movement_id = m.id where m.company_id = v_co and m.material_id = mat.material_id), 0) as jv,
        coalesce((select sum(sl.qty_remaining * lc.unit_cost) from public.stock_lots sl join public.stock_lot_costs lc on lc.lot_id = sl.id
                  where sl.company_id = v_co and sl.material_id = mat.material_id), 0) as lv
      from (select distinct l.material_id from public.stock_inventory_lines l where l.inventory_id = i.id) mat
    ) x;
  return jsonb_build_object('inventory_id', i.id, 'code', i.code, 'phase', i.phase, 'freeze', i.targeted_freeze,
    'lines', v_lines,
    'adjustments', jsonb_build_object('applied_qty', v_adj_qty, 'movement_qty', v_mov_qty, 'applied_value', v_mov_value,
      'qty_matches', v_adj_qty = v_mov_qty),
    'materials', v_mats,
    'valuation', jsonb_build_object('method', coalesce(v_set.method, 'lot_cost'), 'confirmed', coalesce(v_set.confirmed, false),
      'status', case when coalesce(v_set.confirmed, false) then 'confirmed' else 'to_confirm' end));
end $$;

-- ---------------------------------------------------------------------------
-- 9. Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.stock_inventory_freeze_set(uuid, boolean), public.stock_inventory_lines_for_count(uuid),
  public.stock_inventory_count_submit(uuid, numeric), public.stock_inventory_close_count(uuid), public.stock_inventory_close_recount(uuid),
  public.stock_inventory_request_approval(uuid), public.stock_inventory_decide(uuid, boolean, text), public.stock_valuation_set(text, boolean),
  public.stock_inventory_reconcile(uuid) from public, anon;
grant execute on function public.stock_inventory_freeze_set(uuid, boolean), public.stock_inventory_lines_for_count(uuid),
  public.stock_inventory_count_submit(uuid, numeric), public.stock_inventory_close_count(uuid), public.stock_inventory_close_recount(uuid),
  public.stock_inventory_request_approval(uuid), public.stock_inventory_decide(uuid, boolean, text), public.stock_valuation_set(text, boolean),
  public.stock_inventory_reconcile(uuid) to authenticated;
