-- 0067_barcode_mobile_tasks — Codes-barres retenus, résolution sécurisée des scans, tâches mobiles (réception, picking, comptage).
--
-- Codes retenus (existants, réutilisés, sans nouveau format) :
--  * SKU et GTIN des variantes (product_variants.sku, barcode ; 0015) ;
--  * code matière (bom_materials.code, généré ; 0008) ;
--  * code emplacement (stock_locations.code, unique par entrepôt ; 0009) ;
--  * code de lot (stock_lots.lot_code ; 0064) ;
--  * unité physique (material_units.unit_code, UN-nnnnnn ; 0062) ;
--  * numéros de document : PRL- (préparation, 0064), TRF- (transfert, 0065), INV- (inventaire, 0009).
-- La génération de ces codes reste celle des migrations d'origine (GTIN : variant_assign_barcodes ; numéros : next_seq).
--
-- Règles :
--  * Résolution : scan_resolve renvoie un seul élément, ou SCAN_UNKNOWN / SCAN_AMBIGUOUS ; seuls les entrepôts visibles de l'utilisateur comptent.
--  * Mauvais article, mauvais lot ou mauvais emplacement : refusé avec un code exploitable (ok=false), journalisé, aucun effet de stock.
--  * Anti-scan répété : chaque action porte une clé de scan (par utilisateur). Rejouer la même clé renvoie le résultat déjà enregistré
--    (replayed=true) sans nouvel effet. Un scan déjà confirmé est ignoré (duplicate=true).
--  * Droits : refus de droit (stock.write / stock.read) et périmètre entrepôt (WAREHOUSE_FORBIDDEN) lèvent une erreur ; les refus métier
--    ne lèvent pas, pour que la réponse et son journal soient conservés.
--  * Retour visuel et sonore : chaque réponse porte sound = 'ok' | 'error' et un message en français.
--  * RFID : étude seulement, aucun code (voir PROJECT_STATE).
--  Erreurs levées : SCAN_KEY_REQUIRED, SCAN_KEY_REUSED (refus), WAREHOUSE_FORBIDDEN, RBAC_FORBIDDEN, PICK_LINE_NOT_FOUND, TRANSFER_NOT_FOUND, COUNT...

-- ---------------------------------------------------------------------------
-- 1. Messages exploitables (une seule source)
-- ---------------------------------------------------------------------------
create function private.scan_message(p_code text) returns text
language sql immutable set search_path = '' as $$
  select case p_code
    when 'SCAN_UNKNOWN' then 'Code inconnu : vérifiez l’étiquette.'
    when 'SCAN_AMBIGUOUS' then 'Code ambigu : plusieurs éléments ont ce code dans votre périmètre.'
    when 'SCAN_WRONG_SKU' then 'Mauvais article pour cette ligne.'
    when 'SCAN_WRONG_LOT' then 'Mauvais lot pour cette ligne.'
    when 'SCAN_WRONG_LOCATION' then 'Mauvais emplacement pour cette ligne.'
    when 'SCAN_KEY_REUSED' then 'Cette clé de scan a déjà servi à une autre tâche.'
    when 'PICK_BAD_STATUS' then 'Cette liste n’est plus ouverte.'
    when 'PICK_SUBSTITUTION_PENDING' then 'Une substitution attend un accord : scan impossible.'
    when 'TRANSFER_DUPLICATE_RECEIPT' then 'Cette réception a déjà été enregistrée.'
    when 'TRANSFER_OVER_RECEIPT' then 'Quantité supérieure à ce qui reste en transit.'
    when 'COUNT_ALREADY_SUBMITTED' then 'Ce passage est déjà compté pour cette ligne.'
    when 'COUNT_SAME_COUNTER' then 'Le recomptage doit être fait par un autre compteur.'
    when 'COUNT_NOT_REQUIRED' then 'Cette ligne n’a pas besoin de recomptage.'
    when 'INVENTORY_BAD_PHASE' then 'Cet inventaire n’est pas en comptage.'
    else 'Refusé : ' || coalesce(p_code, 'erreur')
  end $$;
revoke execute on function private.scan_message(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Journal des scans : clé unique par utilisateur, ajout seul
-- ---------------------------------------------------------------------------
create table public.scan_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null default auth.uid(),
  scan_key    text not null check (length(scan_key) between 8 and 80),
  task        text not null check (task in ('pick', 'receive', 'count')),
  outcome     text not null check (outcome in ('ok', 'refused')),
  error_code  text,
  result      jsonb not null,
  created_at  timestamptz not null default clock_timestamp(),
  unique (company_id, user_id, scan_key)
);
create trigger scan_events_immutable before update or delete on public.scan_events
  for each row execute function private.stock_immutable();
alter table public.scan_events enable row level security;
revoke all on public.scan_events from public, anon, authenticated;

-- Rejeu : même clé, même tâche → résultat déjà enregistré ; autre tâche → refus.
create function private.scan_replay(p_key text, p_task text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select task, result into r from public.scan_events
    where company_id = private.current_company() and user_id = auth.uid() and scan_key = p_key;
  if not found then return null; end if;
  if r.task <> p_task then
    return jsonb_build_object('ok', false, 'code', 'SCAN_KEY_REUSED', 'message', private.scan_message('SCAN_KEY_REUSED'), 'sound', 'error',
      'duplicate', false, 'replayed', true);
  end if;
  return r.result || jsonb_build_object('replayed', true);
end $$;
revoke execute on function private.scan_replay(text, text) from public, anon, authenticated;

create function private.scan_finish(p_key text, p_task text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_outcome text := case when (p_result ->> 'ok')::boolean then 'ok' else 'refused' end;
begin
  insert into public.scan_events (company_id, scan_key, task, outcome, error_code, result)
  values (private.current_company(), p_key, p_task, v_outcome, p_result ->> 'code', p_result);
  return p_result || jsonb_build_object('replayed', false);
end $$;
revoke execute on function private.scan_finish(text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Résolution d'un code scanné (un seul résultat, sinon erreur explicite)
-- ---------------------------------------------------------------------------
create function public.scan_resolve(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_c text := upper(btrim(coalesce(p_code, ''))); v_hits jsonb; v_n int;
begin
  perform private.require_perm('stock.read');
  if v_c = '' then
    return jsonb_build_object('ok', false, 'code', 'SCAN_UNKNOWN', 'message', private.scan_message('SCAN_UNKNOWN'), 'sound', 'error');
  end if;
  select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hits from (
    select jsonb_build_object('kind', 'material', 'id', m.id, 'label', m.code || ' ' || m.name) as h
      from public.bom_materials m where m.company_id = v_co and upper(m.code) = v_c
    union all
    select jsonb_build_object('kind', 'variant', 'id', v.id, 'label', 'SKU ' || v.sku)
      from public.product_variants v where v.company_id = v_co and (upper(v.sku) = v_c or v.barcode = v_c)
    union all
    select jsonb_build_object('kind', 'location', 'id', sl.id, 'label', sl.code || ' · ' || w.code)
      from public.stock_locations sl join public.warehouses w on w.id = sl.warehouse_id
      where sl.company_id = v_co and upper(sl.code) = v_c and sl.archived_at is null and private.wh_can(sl.warehouse_id, 'viewer')
    union all
    select distinct on (sl.material_id) jsonb_build_object('kind', 'lot', 'id', sl.material_id, 'label', 'Lot ' || sl.lot_code)
      from public.stock_lots sl
      where sl.company_id = v_co and upper(sl.lot_code) = v_c and private.wh_can(sl.warehouse_id, 'viewer')
    union all
    select jsonb_build_object('kind', 'unit', 'id', u.id, 'label', 'Unité ' || u.unit_code)
      from public.material_units u where u.company_id = v_co and upper(u.unit_code) = v_c and private.wh_can(u.warehouse_id, 'viewer')
    union all
    select jsonb_build_object('kind', 'pick', 'id', pk.id, 'label', 'Préparation ' || pk.number)
      from public.stock_pick_lists pk where pk.company_id = v_co and upper(pk.number) = v_c and private.wh_can(pk.warehouse_id, 'viewer')
    union all
    select jsonb_build_object('kind', 'transfer', 'id', t.id, 'label', 'Transfert ' || t.number)
      from public.stock_transfers t where t.company_id = v_co and upper(t.number) = v_c
        and (private.wh_can(t.from_warehouse_id, 'viewer') or private.wh_can(t.to_warehouse_id, 'viewer'))
    union all
    select jsonb_build_object('kind', 'inventory', 'id', i.id, 'label', 'Inventaire ' || i.code)
      from public.stock_inventories i where i.company_id = v_co and upper(i.code) = v_c and private.wh_can(i.warehouse_id, 'viewer')
  ) x;
  v_n := jsonb_array_length(v_hits);
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'SCAN_UNKNOWN', 'message', private.scan_message('SCAN_UNKNOWN'), 'sound', 'error');
  elsif v_n > 1 then
    return jsonb_build_object('ok', false, 'code', 'SCAN_AMBIGUOUS', 'message', private.scan_message('SCAN_AMBIGUOUS'), 'sound', 'error');
  end if;
  return jsonb_build_object('ok', true, 'code', null, 'sound', 'ok', 'hit', v_hits -> 0);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Tâches mobiles : picking (lot + emplacement), réception (article + emplacement), comptage (article + emplacement)
-- ---------------------------------------------------------------------------
create function public.mob_pick_scan(p_line uuid, p_lot_code text, p_location_code text, p_scan_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_key text := btrim(coalesce(p_scan_key, '')); v_rep jsonb; v_l record;
  v_lot text := btrim(coalesce(p_lot_code, '')); v_loc text := btrim(coalesce(p_location_code, '')); v_err text; v_res jsonb;
begin
  perform private.require_perm('stock.write');
  if length(v_key) < 8 then raise exception 'SCAN_KEY_REQUIRED' using errcode = '22023'; end if;
  v_rep := private.scan_replay(v_key, 'pick');
  if v_rep is not null then return v_rep; end if;
  select pl.scanned, pl.lot_code as exp_lot, sl.code as exp_loc, pk.warehouse_id as wh, pk.status as st, pl.substitution_status as sub
    into v_l from public.stock_pick_lines pl join public.stock_pick_lists pk on pk.id = pl.pick_id
    join public.stock_locations sl on sl.id = pl.location_id
    where pl.id = p_line and pl.company_id = v_co;
  if not found then raise exception 'PICK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(v_l.wh, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if v_l.st <> 'open' then v_err := 'PICK_BAD_STATUS';
  elsif v_l.sub = 'pending' then v_err := 'PICK_SUBSTITUTION_PENDING';
  elsif v_loc <> v_l.exp_loc then v_err := 'SCAN_WRONG_LOCATION';
  elsif v_lot <> coalesce(v_l.exp_lot, '') then v_err := 'SCAN_WRONG_LOT';
  end if;
  if v_err is null and v_l.scanned then
    v_res := jsonb_build_object('ok', true, 'code', null, 'message', 'Lot déjà confirmé : scan ignoré.', 'sound', 'ok', 'duplicate', true);
  elsif v_err is null then
    begin
      perform public.stock_pick_scan(p_line, v_lot);
      v_res := jsonb_build_object('ok', true, 'code', null, 'message', 'Lot confirmé.', 'sound', 'ok', 'duplicate', false, 'lot_code', v_lot);
    exception when others then
      v_err := sqlerrm;
    end;
  end if;
  if v_err is not null then
    v_res := jsonb_build_object('ok', false, 'code', v_err, 'message', private.scan_message(v_err), 'sound', 'error', 'duplicate', false,
      'expected', case when v_err = 'SCAN_WRONG_LOCATION' then v_l.exp_loc when v_err = 'SCAN_WRONG_LOT' then v_l.exp_lot end);
  end if;
  return private.scan_finish(v_key, 'pick', v_res);
end $$;

-- Réception : article et emplacement de destination scannés ; la clé de scan sert de clé d'idempotence à la réception (0065).
create function public.mob_transfer_receive_scan(p_transfer uuid, p_material_code text, p_location_code text, p_qty numeric, p_proof text, p_scan_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_key text := btrim(coalesce(p_scan_key, '')); v_rep jsonb; v_t public.stock_transfers%rowtype;
  v_mat text := upper(btrim(coalesce(p_material_code, ''))); v_loc text := btrim(coalesce(p_location_code, '')); v_n int; v_line uuid; v_exp_loc text; v_err text; v_res jsonb;
begin
  perform private.require_perm('stock.write');
  if length(v_key) < 8 then raise exception 'SCAN_KEY_REQUIRED' using errcode = '22023'; end if;
  v_rep := private.scan_replay(v_key, 'receive');
  if v_rep is not null then return v_rep; end if;
  select * into v_t from public.stock_transfers where id = p_transfer and company_id = v_co;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(v_t.to_warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select count(*) into v_n from public.stock_transfer_lines l join public.bom_materials m on m.id = l.material_id
    where l.transfer_id = v_t.id and upper(m.code) = v_mat;
  select l.id into v_line from public.stock_transfer_lines l join public.bom_materials m on m.id = l.material_id
    where l.transfer_id = v_t.id and upper(m.code) = v_mat limit 1;
  select code into v_exp_loc from public.stock_locations where id = v_t.to_location_id;
  if v_n = 0 then v_err := 'SCAN_WRONG_SKU';
  elsif v_n > 1 then v_err := 'SCAN_AMBIGUOUS';
  elsif v_loc <> v_exp_loc then v_err := 'SCAN_WRONG_LOCATION';
  end if;
  if v_err is null then
    begin
      v_res := public.stock_transfer_receive(v_t.id, v_key, coalesce(nullif(btrim(coalesce(p_proof, '')), ''), 'Réception mobile ' || left(v_key, 8)),
        jsonb_build_array(jsonb_build_object('line_id', v_line, 'qty', p_qty)));
      v_res := jsonb_build_object('ok', true, 'code', null, 'message', 'Réception enregistrée.', 'sound', 'ok', 'duplicate', false, 'detail', v_res);
    exception when others then
      if sqlerrm = 'TRANSFER_DUPLICATE_RECEIPT' then
        v_res := jsonb_build_object('ok', true, 'code', null, 'message', private.scan_message('TRANSFER_DUPLICATE_RECEIPT'), 'sound', 'ok', 'duplicate', true);
      else
        v_err := sqlerrm;
      end if;
    end;
  end if;
  if v_err is not null then
    v_res := jsonb_build_object('ok', false, 'code', v_err, 'message', private.scan_message(v_err), 'sound', 'error', 'duplicate', false,
      'expected', case when v_err = 'SCAN_WRONG_LOCATION' then v_exp_loc end);
  end if;
  return private.scan_finish(v_key, 'receive', v_res);
end $$;

-- Comptage : article et emplacement de la ligne scannés, puis saisie aveugle (0066).
create function public.mob_count_scan(p_line uuid, p_material_code text, p_location_code text, p_qty numeric, p_scan_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_key text := btrim(coalesce(p_scan_key, '')); v_rep jsonb; v_l record;
  v_mat text := upper(btrim(coalesce(p_material_code, ''))); v_loc text := btrim(coalesce(p_location_code, '')); v_err text; v_res jsonb;
begin
  perform private.require_perm('stock.write');
  if length(v_key) < 8 then raise exception 'SCAN_KEY_REQUIRED' using errcode = '22023'; end if;
  v_rep := private.scan_replay(v_key, 'count');
  if v_rep is not null then return v_rep; end if;
  select upper(m.code) as exp_mat, sl.code as exp_loc, i.warehouse_id as wh
    into v_l from public.stock_inventory_lines l join public.stock_inventories i on i.id = l.inventory_id
    join public.bom_materials m on m.id = l.material_id join public.stock_locations sl on sl.id = l.location_id
    where l.id = p_line and l.company_id = v_co;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(v_l.wh, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if v_mat <> v_l.exp_mat then v_err := 'SCAN_WRONG_SKU';
  elsif v_loc <> v_l.exp_loc then v_err := 'SCAN_WRONG_LOCATION';
  end if;
  if v_err is null then
    begin
      perform public.stock_inventory_count_submit(p_line, p_qty);
      v_res := jsonb_build_object('ok', true, 'code', null, 'message', 'Comptage enregistré.', 'sound', 'ok', 'duplicate', false);
    exception when others then
      v_err := sqlerrm;
    end;
  end if;
  if v_err is not null then
    v_res := jsonb_build_object('ok', false, 'code', v_err, 'message', private.scan_message(v_err), 'sound', 'error', 'duplicate', false,
      'expected', case when v_err = 'SCAN_WRONG_LOCATION' then v_l.exp_loc end);
  end if;
  return private.scan_finish(v_key, 'count', v_res);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.scan_resolve(text), public.mob_pick_scan(uuid, text, text, text),
  public.mob_transfer_receive_scan(uuid, text, text, numeric, text, text), public.mob_count_scan(uuid, text, text, numeric, text)
  from public, anon;
grant execute on function public.scan_resolve(text), public.mob_pick_scan(uuid, text, text, text),
  public.mob_transfer_receive_scan(uuid, text, text, numeric, text, text), public.mob_count_scan(uuid, text, text, numeric, text)
  to authenticated;
