-- 0080_picking_packing_export — Picking, colisage et export (P055) : scan commande / SKU / lot / emplacement, colis individualisés
-- (poids, dimensions, étiquette, contenu), rapprochement colis ↔ lignes ↔ BL, liste de colisage versionnée, preuve export,
-- déclaration douanière dont l'acceptation exige un retour officiel.
--
-- Existant conservé (0021, 0055, 0056, 0067) : expéditions, lignes, réservation et sortie de stock, BL unique (BL-), facture
-- export (EXP-), suivi, BL réimprimable, scan générique (scan_resolve), idempotence de scan (scan_events, pour le stock).
-- shipment_pack (0021) reste la voie sans colis individualisés : elle est refusée dès qu'une expédition a des colis (redéfinie ici).
--
-- Règles :
--  * Scan SKU : un SKU d'une autre taille ou d'un autre coloris de la même pièce est refusé (SHIP_WRONG_SIZE / SHIP_WRONG_COLOR) ;
--    une quantité scannée ne dépasse jamais la quantité prélevée. Chaque scan est journalisé, et rejouer la même clé ne compte pas deux fois.
--  * Colis : seules les unités scannées et non emballées entrent dans un colis. Poids brut ≥ poids net > 0, dimensions > 0.
--    Pas de limite de dimension ni de poids inventée. Un colis clos est figé.
--  * Rapprochement BL : le colisage n'est validé que si, pour chaque ligne, unités scannées = prélevées = emballées ; l'expédition
--    (BL) reste la seule sortie de stock. Un colis reçoit le numéro de BL de son expédition.
--  * Liste de colisage : version numérotée, contenu figé, empreinte SHA-256 du contenu (preuve). Aucune pièce n'est déclarée conforme.
--  * Déclaration douanière : seulement pour une expédition hors du pays de la société ; soumission avec référence ; acceptation
--    ou rejet UNIQUEMENT avec un retour officiel (référence, date, document GED). Aucun régime ni code douanier n'est inventé (OPEN-03).
--  * Documents hors périmètre : EUR.1 / origine (BR-EXP-002 [À CONFIRMER]) — non générés.
-- Erreurs : SHIP_SCAN_KIND_INVALID, SHIP_BAD_STATUS, SHIP_WRONG_ORDER, SHIP_SKU_UNKNOWN, SHIP_WRONG_SIZE, SHIP_WRONG_COLOR,
-- SHIP_SKU_NOT_IN_SHIPMENT, SHIP_SCAN_EXCEEDS_PICKED, SHIP_WRONG_LOT, SHIP_WRONG_LOCATION, SHIP_PACKAGE_CLOSED, SHIP_NOT_SCANNED,
-- SHIP_PACK_EXCEEDS_SCANNED, SHIP_PACKAGE_EMPTY, SHIP_BAD_WEIGHT, SHIP_BAD_DIMENSION, SHIP_PACKAGE_OPEN, SHIP_NO_PACKAGE,
-- SHIP_NOT_RECONCILED, SHIPPING_PACKAGES_EXIST, CUSTOMS_NOT_EXPORT, CUSTOMS_ALREADY_OPEN, CUSTOMS_PACKING_LIST_REQUIRED,
-- CUSTOMS_REF_REQUIRED, CUSTOMS_OUTCOME_INVALID, CUSTOMS_DATE_INVALID, CUSTOMS_RESPONSE_DOCUMENT_REQUIRED, SCAN_KEY_REQUIRED,
-- SCAN_KEY_REUSED, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droit douanier et colonnes additives sur les lignes d'expédition
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('shipments.customs', 'shipping', 'Gérer les déclarations douanières', 'Ouvrir, soumettre et enregistrer le retour officiel d''une déclaration douanière')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'shipments.customs'
where r.is_system and r.code in ('admin', 'direction', 'commercial') on conflict do nothing;

alter table public.shipment_lines
  add column qty_scanned int not null default 0 check (qty_scanned >= 0),
  add column qty_packed  int not null default 0 check (qty_packed >= 0);

-- ---------------------------------------------------------------------------
-- 2. Tables : colis, contenu des colis, journal de scan, documents, déclarations douanières
-- ---------------------------------------------------------------------------
create table public.shipment_packages (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id  uuid not null references public.shipments(id) on delete restrict,
  package_no   int not null check (package_no > 0),
  label_code   text not null check (length(label_code) between 8 and 80),
  status       text not null default 'open' check (status in ('open', 'closed')),
  gross_kg     numeric(10,2) check (gross_kg is null or gross_kg > 0),
  net_kg       numeric(10,2) check (net_kg is null or net_kg > 0),
  length_cm    numeric(7,1) check (length_cm is null or length_cm > 0),
  width_cm     numeric(7,1) check (width_cm is null or width_cm > 0),
  height_cm    numeric(7,1) check (height_cm is null or height_cm > 0),
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  closed_at    timestamptz,
  closed_by    uuid,
  unique (shipment_id, package_no),
  unique (company_id, label_code),
  check ((status = 'closed') = (closed_at is not null)),
  check (status = 'open' or (gross_kg is not null and net_kg is not null and length_cm is not null and width_cm is not null and height_cm is not null)),
  check (gross_kg is null or net_kg is null or gross_kg >= net_kg)
);

create table public.shipment_package_lines (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default private.current_company() references public.companies(id) on delete cascade,
  package_id        uuid not null references public.shipment_packages(id) on delete restrict,
  shipment_line_id  uuid not null references public.shipment_lines(id) on delete restrict,
  variant_id        uuid not null references public.product_variants(id),
  qty               int not null check (qty > 0),
  unique (package_id, shipment_line_id)
);

create table public.shipment_scan_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null default auth.uid(),
  scan_key    text not null check (length(scan_key) between 8 and 80),
  kind        text not null check (kind in ('order', 'sku', 'lot', 'location')),
  outcome     text not null check (outcome in ('ok', 'refused')),
  error_code  text,
  result      jsonb not null,
  created_at  timestamptz not null default clock_timestamp(),
  unique (company_id, user_id, scan_key)
);

create table public.shipment_documents (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id    uuid not null references public.shipments(id) on delete restrict,
  kind           text not null check (kind in ('packing_list')),
  version_no     int not null check (version_no > 0),
  number         text not null,
  content        jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at   timestamptz not null default now(),
  generated_by   uuid default auth.uid(),
  unique (shipment_id, kind, version_no)
);

create table public.customs_declarations (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id          uuid not null unique references public.shipments(id) on delete restrict,
  status               text not null default 'draft' check (status in ('draft', 'submitted', 'accepted', 'rejected')),
  regime_note          text check (regime_note is null or length(btrim(regime_note)) between 3 and 200),
  submission_ref       text check (submission_ref is null or length(btrim(submission_ref)) between 3 and 80),
  submitted_at         timestamptz,
  submitted_by         uuid,
  response_ref         text check (response_ref is null or length(btrim(response_ref)) between 3 and 80),
  response_at          date,
  response_document_id uuid references public.ged_documents(id) on delete restrict,
  responded_at         timestamptz,
  responded_by         uuid,
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  -- pas d'acceptation ni de rejet sans retour officiel ; pas de soumission sans référence
  check (status = 'draft' or submission_ref is not null),
  check (status not in ('accepted', 'rejected') or (response_ref is not null and response_at is not null
         and response_document_id is not null and responded_at is not null))
);

-- Journaux immuables : colis (après clôture), documents, scans
create function private.ship_ledger_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'SHIP_APPEND_ONLY' using errcode = '42501';
end $$;
revoke execute on function private.ship_ledger_guard() from public, anon, authenticated;
create trigger shipment_documents_immutable_bud before update or delete on public.shipment_documents
  for each row execute function private.ship_ledger_guard();
create trigger shipment_scan_events_immutable_bud before update or delete on public.shipment_scan_events
  for each row execute function private.ship_ledger_guard();

-- Contenu d'un colis : la ligne doit appartenir à l'expédition du colis, et la variante être celle de la ligne
create function private.ship_package_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pkg_ship uuid; v_pkg_status text; v_line_ship uuid; v_line_variant uuid;
begin
  select p.shipment_id, p.status into v_pkg_ship, v_pkg_status from public.shipment_packages p where p.id = new.package_id;
  select sl.shipment_id, sl.variant_id into v_line_ship, v_line_variant from public.shipment_lines sl where sl.id = new.shipment_line_id;
  if v_pkg_ship is distinct from v_line_ship or v_line_variant is distinct from new.variant_id then
    raise exception 'SHIP_WRONG_SIZE' using errcode = '22023';
  end if;
  if v_pkg_status <> 'open' then raise exception 'SHIP_PACKAGE_CLOSED' using errcode = '55000'; end if;
  return new;
end $$;
revoke execute on function private.ship_package_line_guard() from public, anon, authenticated;
create trigger shipment_package_lines_guard_bi before insert on public.shipment_package_lines
  for each row execute function private.ship_package_line_guard();

-- ---------------------------------------------------------------------------
-- 3. Scan : commande, SKU, lot, emplacement (résultat explicite, idempotent)
-- ---------------------------------------------------------------------------
-- Pièce présente dans l'expédition sous une autre couleur ou une autre taille : la couleur d'abord, puis la taille.
create function private.ship_mismatch_code(p_shipment uuid, p_variant public.product_variants) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.shipment_lines l join public.product_variants pv on pv.id = l.variant_id
             where l.shipment_id = p_shipment and pv.product_id = p_variant.product_id and pv.color_id = p_variant.color_id
               and pv.size_id <> p_variant.size_id) then
    return 'SHIP_WRONG_SIZE';
  end if;
  if exists (select 1 from public.shipment_lines l join public.product_variants pv on pv.id = l.variant_id
             where l.shipment_id = p_shipment and pv.product_id = p_variant.product_id and pv.size_id = p_variant.size_id
               and pv.color_id <> p_variant.color_id) then
    return 'SHIP_WRONG_COLOR';
  end if;
  return 'SHIP_SKU_NOT_IN_SHIPMENT';
end $$;
revoke execute on function private.ship_mismatch_code(uuid, public.product_variants) from public, anon, authenticated;

-- Colis ouvert vide : supprimé (un colis oublié bloquerait le colisage). Un colis avec contenu ne se supprime pas.
create function public.shipment_package_discard(p_package uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pk public.shipment_packages%rowtype; v_n int;
begin
  perform private.require_perm('shipments.write');
  select * into pk from public.shipment_packages where id = p_package and company_id = v_co for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if pk.status <> 'open' then raise exception 'SHIP_PACKAGE_CLOSED' using errcode = '55000'; end if;
  select count(*) into v_n from public.shipment_package_lines where package_id = pk.id;
  if v_n > 0 then raise exception 'SHIP_PACKAGE_NOT_EMPTY' using errcode = '55000'; end if;
  delete from public.shipment_packages where id = pk.id;
end $$;

create function public.shipment_scan(p_shipment uuid, p_kind text, p_code text, p_scan_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; v_key text := btrim(coalesce(p_scan_key, ''));
  v_code text := upper(btrim(coalesce(p_code, ''))); v_rep jsonb; v_kind text; v_err text; v_res jsonb;
  v_v public.product_variants%rowtype; v_line public.shipment_lines%rowtype; v_other public.shipment_lines%rowtype;
  v_line_id uuid; v_order_code text;
begin
  perform private.require_perm('shipments.write');
  if length(v_key) < 8 then raise exception 'SCAN_KEY_REQUIRED' using errcode = '22023'; end if;
  if p_kind not in ('order', 'sku', 'lot', 'location') then raise exception 'SHIP_SCAN_KIND_INVALID' using errcode = '22023'; end if;
  -- rejeu : même clé et même nature de scan → résultat déjà enregistré, sans nouvel effet
  select e.kind, e.result into v_kind, v_rep from public.shipment_scan_events e
    where e.company_id = v_co and e.user_id = auth.uid() and e.scan_key = v_key;
  if found then
    if v_kind <> p_kind then return jsonb_build_object('ok', false, 'code', 'SCAN_KEY_REUSED', 'replayed', true); end if;
    return v_rep || jsonb_build_object('replayed', true);
  end if;

  s := private.shipment_lock(p_shipment);
  if p_kind <> 'order' and s.status <> 'picking' then v_err := 'SHIP_BAD_STATUS';
  elsif p_kind = 'order' then
    select code into v_order_code from public.sales_orders where id = s.sales_order_id;
    if v_code not in (upper(s.number), upper(coalesce(s.bl_number, '')), upper(coalesce(v_order_code, ''))) then v_err := 'SHIP_WRONG_ORDER'; end if;
  elsif p_kind = 'sku' then
    select * into v_v from public.product_variants where company_id = v_co and (upper(sku) = v_code or upper(coalesce(barcode, '')) = v_code);
    if not found then
      v_err := 'SHIP_SKU_UNKNOWN';
    else
      select * into v_line from public.shipment_lines where shipment_id = s.id and variant_id = v_v.id;
      if found then
        if v_line.qty_scanned >= v_line.qty_picked then v_err := 'SHIP_SCAN_EXCEEDS_PICKED';
        else
          update public.shipment_lines set qty_scanned = qty_scanned + 1 where id = v_line.id;
          v_line_id := v_line.id;
        end if;
      else
        -- même pièce, autre taille ou autre coloris dans l'expédition : refus explicite
        v_err := private.ship_mismatch_code(s.id, v_v);
      end if;
    end if;
  elsif p_kind = 'lot' then
    if not exists (select 1 from public.shipment_line_lots sll join public.shipment_lines sl on sl.id = sll.shipment_line_id
                   join public.finished_lots f on f.id = sll.lot_id where sl.shipment_id = s.id and upper(f.lot_code) = v_code) then
      v_err := 'SHIP_WRONG_LOT';
    end if;
  else
    -- Les lots produits n'ont pas d'emplacement modélisé : l'emplacement scanné doit appartenir à l'entrepôt de l'expédition.
    if not exists (select 1 from public.stock_locations where warehouse_id = s.warehouse_id and upper(code) = v_code and archived_at is null) then
      v_err := 'SHIP_WRONG_LOCATION';
    end if;
  end if;

  v_res := jsonb_build_object('ok', v_err is null, 'code', v_err, 'kind', p_kind, 'shipment', s.number, 'line_id', v_line_id, 'replayed', false);
  insert into public.shipment_scan_events (company_id, scan_key, kind, outcome, error_code, result)
  values (v_co, v_key, p_kind, case when v_err is null then 'ok' else 'refused' end, v_err, v_res);
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Colisage : colis individualisés, contenu scanné uniquement
-- ---------------------------------------------------------------------------
create function public.shipment_package_open(p_shipment uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_no int; v_id uuid := gen_random_uuid(); v_label text;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'picking' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  select coalesce(max(package_no), 0) + 1 into v_no from public.shipment_packages where shipment_id = s.id;
  v_label := 'PKG-' || s.number || '-' || lpad(v_no::text, 3, '0');
  insert into public.shipment_packages (id, company_id, shipment_id, package_no, label_code)
  values (v_id, s.company_id, s.id, v_no, v_label);
  perform private.write_audit(s.company_id, 'shipping.package_open', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('package', v_label), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Ajoute des unités scannées à un colis ouvert (un SKU, quantité ≤ unités scannées et non encore emballées)
create function public.shipment_package_add(p_package uuid, p_code text, p_qty int default 1) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pk public.shipment_packages%rowtype; s public.shipments%rowtype;
  v_v public.product_variants%rowtype; v_line public.shipment_lines%rowtype; v_other public.shipment_lines%rowtype; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform private.require_perm('shipments.write');
  if p_qty is null or p_qty <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  select * into pk from public.shipment_packages where id = p_package and company_id = v_co;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if pk.status <> 'open' then raise exception 'SHIP_PACKAGE_CLOSED' using errcode = '55000'; end if;
  s := private.shipment_lock(pk.shipment_id);
  if s.status <> 'picking' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  select * into v_v from public.product_variants where company_id = v_co and (upper(sku) = v_code or upper(coalesce(barcode, '')) = v_code);
  if not found then raise exception 'SHIP_SKU_UNKNOWN' using errcode = '22023'; end if;
  select * into v_line from public.shipment_lines where shipment_id = s.id and variant_id = v_v.id for update;
  if not found then
    raise exception '%', private.ship_mismatch_code(s.id, v_v) using errcode = '22023';
  end if;
  if v_line.qty_scanned - v_line.qty_packed < p_qty then
    if v_line.qty_scanned - v_line.qty_packed <= 0 then raise exception 'SHIP_NOT_SCANNED' using errcode = '55000'; end if;
    raise exception 'SHIP_PACK_EXCEEDS_SCANNED' using errcode = '22023';
  end if;
  insert into public.shipment_package_lines (company_id, package_id, shipment_line_id, variant_id, qty)
  values (v_co, pk.id, v_line.id, v_v.id, p_qty)
  on conflict (package_id, shipment_line_id) do update set qty = public.shipment_package_lines.qty + excluded.qty;
  update public.shipment_lines set qty_packed = qty_packed + p_qty where id = v_line.id;
end $$;

-- Fermeture d'un colis : contenu requis, poids brut ≥ poids net > 0, dimensions > 0.
create function public.shipment_package_close(p_package uuid, p_gross_kg numeric, p_net_kg numeric,
                                              p_length_cm numeric, p_width_cm numeric, p_height_cm numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pk public.shipment_packages%rowtype; v_n int;
begin
  perform private.require_perm('shipments.write');
  select * into pk from public.shipment_packages where id = p_package and company_id = v_co for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if pk.status <> 'open' then raise exception 'SHIP_PACKAGE_CLOSED' using errcode = '55000'; end if;
  select count(*) into v_n from public.shipment_package_lines where package_id = pk.id;
  if v_n = 0 then raise exception 'SHIP_PACKAGE_EMPTY' using errcode = '55000'; end if;
  if p_gross_kg is null or p_net_kg is null or p_gross_kg <= 0 or p_net_kg <= 0 or p_gross_kg < p_net_kg then
    raise exception 'SHIP_BAD_WEIGHT' using errcode = '22023';
  end if;
  if p_length_cm is null or p_width_cm is null or p_height_cm is null or p_length_cm <= 0 or p_width_cm <= 0 or p_height_cm <= 0 then
    raise exception 'SHIP_BAD_DIMENSION' using errcode = '22023';
  end if;
  update public.shipment_packages set status = 'closed', gross_kg = p_gross_kg, net_kg = p_net_kg, length_cm = p_length_cm,
    width_cm = p_width_cm, height_cm = p_height_cm, closed_at = now(), closed_by = auth.uid() where id = pk.id;
  perform private.write_audit(v_co, 'shipping.package_close', 'shipment_package', pk.id::text, pk.label_code, null,
    jsonb_build_object('gross_kg', p_gross_kg, 'net_kg', p_net_kg), '{}'::jsonb, 'rpc');
end $$;

-- Rapprochement : par ligne, unités prélevées = scannées = emballées. Renvoie les écarts sans rien modifier.
create function private.ship_reconcile_lines(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_lines jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'sku', pv.sku, 'picked', l.qty_picked, 'scanned', l.qty_scanned,
           'packed', l.qty_packed, 'ok', l.qty_picked = l.qty_scanned and l.qty_picked = l.qty_packed) order by pv.sku), '[]'::jsonb)
    into v_lines from public.shipment_lines l join public.product_variants pv on pv.id = l.variant_id where l.shipment_id = p_shipment;
  return v_lines;
end $$;
revoke execute on function private.ship_reconcile_lines(uuid) from public, anon, authenticated;

create function public.shipment_reconcile(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_lines jsonb;
begin
  perform private.require_perm('shipments.read');
  if not exists (select 1 from public.shipments where id = p_shipment and company_id = v_co) then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  v_lines := private.ship_reconcile_lines(p_shipment);
  return jsonb_build_object('shipment_id', p_shipment, 'lines', v_lines,
    'open_packages', (select count(*) from public.shipment_packages where shipment_id = p_shipment and status = 'open'),
    'packages', (select count(*) from public.shipment_packages where shipment_id = p_shipment),
    'reconciled', (select bool_and(x->>'ok' = 'true') from jsonb_array_elements(v_lines) x) is true);
end $$;

-- Fin de colisage : colis tous fermés, lignes rapprochées ; l'expédition passe à « emballée » (BL émis ensuite par shipment_ship).
create function public.shipment_packing_complete(p_shipment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_open int; v_pk int; v_gross numeric; v_net numeric; v_lines jsonb; v_bad int;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'picking' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) filter (where status = 'open'), count(*), sum(gross_kg), sum(net_kg)
    into v_open, v_pk, v_gross, v_net from public.shipment_packages where shipment_id = s.id;
  if v_pk = 0 then raise exception 'SHIP_NO_PACKAGE' using errcode = '55000'; end if;
  if v_open > 0 then raise exception 'SHIP_PACKAGE_OPEN' using errcode = '55000'; end if;
  v_lines := private.ship_reconcile_lines(s.id);
  select count(*) into v_bad from jsonb_array_elements(v_lines) x where x->>'ok' <> 'true';
  if v_bad > 0 then raise exception 'SHIP_NOT_RECONCILED' using errcode = '55000'; end if;
  update public.shipments set status = 'packed', packed_at = now(), packages = v_pk, gross_weight_kg = v_gross, net_weight_kg = v_net
    where id = s.id;
  perform private.shipment_event(s.id, 'packed', null, v_pk || ' colis rapprochés');
  perform private.write_audit(s.company_id, 'shipping.packing_complete', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('packages', v_pk, 'gross_kg', v_gross, 'net_kg', v_net), '{}'::jsonb, 'rpc');
  return jsonb_build_object('shipment_id', s.id, 'packages', v_pk, 'gross_kg', v_gross, 'net_kg', v_net);
end $$;

-- Colisage sans colis individualisés : refusé dès qu'une expédition a des colis (même contrôle que le BL).
create or replace function public.shipment_pack(p_shipment uuid, p_packages int, p_gross numeric, p_net numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_open int;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if exists (select 1 from public.shipment_packages where shipment_id = s.id) then raise exception 'SHIPPING_PACKAGES_EXIST' using errcode = '55000'; end if;
  if s.status <> 'picking' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_open from public.shipment_lines where shipment_id = s.id and qty_picked < qty_requested;
  if v_open > 0 then raise exception 'SHIPPING_NOT_PICKED' using errcode = '55000'; end if;
  if p_packages is null or p_packages <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  if p_net is not null and p_gross is not null and p_net > p_gross then raise exception 'SHIPPING_BAD_WEIGHT' using errcode = '22023'; end if;
  update public.shipments set status = 'packed', packed_at = now(), packages = p_packages, gross_weight_kg = p_gross, net_weight_kg = p_net where id = s.id;
  perform private.shipment_event(s.id, 'packed', null, p_packages || ' colis');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Documents export : liste de colisage versionnée, preuve par empreinte
-- ---------------------------------------------------------------------------
create function public.shipment_document_generate(p_shipment uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; v_content jsonb; v_no int; v_number text; v_sha text; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('shipments.write');
  if p_kind <> 'packing_list' then raise exception 'SHIP_DOCUMENT_KIND_INVALID' using errcode = '22023'; end if;
  s := private.shipment_lock(p_shipment);
  if s.status not in ('packed', 'shipped', 'delivered') then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  select jsonb_build_object(
    'shipment', s.number, 'bl', s.bl_number, 'client', (select c.name from public.clients c where c.id = s.client_id),
    'incoterm', s.incoterm, 'destination_country', s.destination_country, 'currency', s.currency,
    'packages', coalesce((select jsonb_agg(jsonb_build_object('package_no', p.package_no, 'label', p.label_code, 'gross_kg', p.gross_kg,
        'net_kg', p.net_kg, 'length_cm', p.length_cm, 'width_cm', p.width_cm, 'height_cm', p.height_cm,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('sku', pv.sku, 'qty', pl.qty) order by pv.sku)
                           from public.shipment_package_lines pl join public.product_variants pv on pv.id = pl.variant_id
                           where pl.package_id = p.id), '[]'::jsonb)) order by p.package_no)
        from public.shipment_packages p where p.shipment_id = s.id), '[]'::jsonb),
    'totals', jsonb_build_object('packages', (select count(*) from public.shipment_packages where shipment_id = s.id),
        'pieces', (select coalesce(sum(qty_picked), 0) from public.shipment_lines where shipment_id = s.id),
        'gross_kg', s.gross_weight_kg, 'net_kg', s.net_weight_kg))
    into v_content;
  if jsonb_array_length(v_content -> 'packages') = 0 then raise exception 'SHIP_NO_PACKAGE' using errcode = '55000'; end if;
  select coalesce(max(version_no), 0) + 1 into v_no from public.shipment_documents where shipment_id = s.id and kind = p_kind;
  v_number := 'PL-' || s.number || '-' || v_no;
  v_sha := encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex');
  insert into public.shipment_documents (id, company_id, shipment_id, kind, version_no, number, content, content_sha256)
  values (v_id, v_co, s.id, p_kind, v_no, v_number, v_content, v_sha);
  perform private.write_audit(v_co, 'shipping.document', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('number', v_number, 'sha256', v_sha), '{}'::jsonb, 'rpc');
  return jsonb_build_object('id', v_id, 'number', v_number, 'version_no', v_no, 'sha256', v_sha);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Déclaration douanière : acceptation seulement sur retour officiel
-- ---------------------------------------------------------------------------
create function public.customs_declaration_open(p_shipment uuid, p_regime_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; v_country char(2); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('shipments.customs');
  s := private.shipment_lock(p_shipment);
  if s.status not in ('packed', 'shipped', 'delivered') then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  select country into v_country from public.companies where id = v_co;
  if s.destination_country is null or s.destination_country = v_country then raise exception 'CUSTOMS_NOT_EXPORT' using errcode = '22023'; end if;
  if exists (select 1 from public.customs_declarations where shipment_id = s.id) then raise exception 'CUSTOMS_ALREADY_OPEN' using errcode = '55000'; end if;
  insert into public.customs_declarations (id, company_id, shipment_id, regime_note)
  values (v_id, v_co, s.id, nullif(btrim(coalesce(p_regime_note, '')), ''));
  perform private.write_audit(v_co, 'customs.open', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('destination_country', s.destination_country), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.customs_declaration_submit(p_declaration uuid, p_submission_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.customs_declarations%rowtype; v_ref text := btrim(coalesce(p_submission_ref, ''));
begin
  perform private.require_perm('shipments.customs');
  select * into d from public.customs_declarations where id = p_declaration and company_id = v_co for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'draft' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  if length(v_ref) < 3 then raise exception 'CUSTOMS_REF_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.shipment_documents where shipment_id = d.shipment_id and kind = 'packing_list') then
    raise exception 'CUSTOMS_PACKING_LIST_REQUIRED' using errcode = '55000';
  end if;
  update public.customs_declarations set status = 'submitted', submission_ref = v_ref, submitted_at = now(), submitted_by = auth.uid() where id = d.id;
  perform private.write_audit(v_co, 'customs.submit', 'customs_declaration', d.id::text, v_ref, null,
    jsonb_build_object('status', 'submitted'), '{}'::jsonb, 'rpc');
end $$;

-- Retour officiel : seule voie vers « accepted » ou « rejected » (référence, date, document GED de la société).
create function public.customs_declaration_respond(p_declaration uuid, p_outcome text, p_response_ref text, p_response_at date,
                                                   p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.customs_declarations%rowtype; v_ref text := btrim(coalesce(p_response_ref, ''));
begin
  perform private.require_perm('shipments.customs');
  select * into d from public.customs_declarations where id = p_declaration and company_id = v_co for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'submitted' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  if p_outcome not in ('accepted', 'rejected') then raise exception 'CUSTOMS_OUTCOME_INVALID' using errcode = '22023'; end if;
  if length(v_ref) < 3 then raise exception 'CUSTOMS_REF_REQUIRED' using errcode = '22023'; end if;
  if p_response_at is null or p_response_at > current_date then raise exception 'CUSTOMS_DATE_INVALID' using errcode = '22023'; end if;
  if p_document is null or not exists (select 1 from public.ged_documents where id = p_document and company_id = v_co and deleted_at is null) then
    raise exception 'CUSTOMS_RESPONSE_DOCUMENT_REQUIRED' using errcode = '22023';
  end if;
  update public.customs_declarations set status = p_outcome, response_ref = v_ref, response_at = p_response_at,
    response_document_id = p_document, responded_at = now(), responded_by = auth.uid() where id = d.id;
  perform private.write_audit(v_co, 'customs.response', 'customs_declaration', d.id::text, d.submission_ref, null,
    jsonb_build_object('status', p_outcome), jsonb_build_object('response_ref', v_ref), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Preuve export : BL, colis, listes, facture, douane — sans déclarer accepté ce qui ne l'est pas
-- ---------------------------------------------------------------------------
create function public.shipment_export_proof(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; v_pk jsonb; v_pl jsonb; v_cu jsonb;
begin
  perform private.require_perm('shipments.read');
  select * into s from public.shipments where id = p_shipment and company_id = v_co;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('package_no', p.package_no, 'label', p.label_code, 'status', p.status,
      'gross_kg', p.gross_kg, 'net_kg', p.net_kg, 'bl_number', s.bl_number) order by p.package_no), '[]'::jsonb)
    into v_pk from public.shipment_packages p where p.shipment_id = s.id;
  select coalesce(jsonb_agg(jsonb_build_object('number', d.number, 'version_no', d.version_no, 'sha256', d.content_sha256) order by d.version_no), '[]'::jsonb)
    into v_pl from public.shipment_documents d where d.shipment_id = s.id and d.kind = 'packing_list';
  select jsonb_build_object('status', c.status, 'submission_ref', c.submission_ref, 'response_ref', c.response_ref,
      'response_at', c.response_at, 'official_return', c.status in ('accepted', 'rejected'))
    into v_cu from public.customs_declarations c where c.shipment_id = s.id;
  return jsonb_build_object('shipment', s.number, 'bl_number', s.bl_number, 'status', s.status,
    'packages', v_pk, 'packing_lists', v_pl,
    'commercial_invoice', s.export_invoice_number,
    'customs', coalesce(v_cu, jsonb_build_object('status', 'not_opened')),
    'customs_accepted', coalesce(v_cu ->> 'status' = 'accepted', false),
    'note', 'Aucune déclaration douanière n''est acceptée sans retour officiel enregistré (référence, date, document).');
end $$;

-- ---------------------------------------------------------------------------
-- 8. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.shipment_packages enable row level security;
alter table public.shipment_package_lines enable row level security;
alter table public.shipment_scan_events enable row level security;
alter table public.shipment_documents enable row level security;
alter table public.customs_declarations enable row level security;
create policy shipment_packages_select on public.shipment_packages for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy shipment_package_lines_select on public.shipment_package_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy shipment_documents_select on public.shipment_documents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy customs_declarations_select on public.customs_declarations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.customs'));
revoke all on public.shipment_packages, public.shipment_package_lines, public.shipment_scan_events, public.shipment_documents,
  public.customs_declarations from anon, authenticated;
grant select on public.shipment_packages, public.shipment_package_lines, public.shipment_documents, public.customs_declarations to authenticated;
grant all on public.shipment_packages, public.shipment_package_lines, public.shipment_scan_events, public.shipment_documents,
  public.customs_declarations to service_role;

revoke execute on function public.shipment_scan(uuid, text, text, text), public.shipment_package_open(uuid),
  public.shipment_package_add(uuid, text, int), public.shipment_package_close(uuid, numeric, numeric, numeric, numeric, numeric),
  public.shipment_reconcile(uuid), public.shipment_packing_complete(uuid), public.shipment_document_generate(uuid, text),
  public.customs_declaration_open(uuid, text), public.customs_declaration_submit(uuid, text),
  public.customs_declaration_respond(uuid, text, text, date, uuid), public.shipment_export_proof(uuid) from public, anon;
grant execute on function public.shipment_scan(uuid, text, text, text), public.shipment_package_open(uuid),
  public.shipment_package_add(uuid, text, int), public.shipment_package_close(uuid, numeric, numeric, numeric, numeric, numeric),
  public.shipment_reconcile(uuid), public.shipment_packing_complete(uuid), public.shipment_document_generate(uuid, text),
  public.customs_declaration_open(uuid, text), public.customs_declaration_submit(uuid, text),
  public.customs_declaration_respond(uuid, text, text, date, uuid), public.shipment_export_proof(uuid) to authenticated, service_role;
revoke execute on function public.shipment_package_discard(uuid) from public, anon;
grant execute on function public.shipment_package_discard(uuid) to authenticated, service_role;
