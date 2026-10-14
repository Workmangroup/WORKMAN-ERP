-- 0068_collections_dossiers_approval — Collections, cycle de statuts des dossiers techniques, approbation distincte, preuves, cohérence des SKU.
--
-- Existant conservé (0013, 0015) : fiche produit (product_master), versions (product_versions, spec JSON : tech, couleurs, tailles,
-- variantes, mesures, entretien, conditionnement), visuels (product_photos), documents de patronage / fiche / essai (product_documents),
-- certifications, instantané à la validation, comparaison, duplication, archivage, historique d'audit.
-- Bibliothèques tissus et accessoires : les composants existants (bom_materials, familles fabric / accessory / …, 0008 et 0062) ;
-- aucune nouvelle bibliothèque n'est créée.
--
-- Statuts de version : brouillon (draft) → prototype → revue (review) → approuvé (validated) → obsolète (obsolete).
--  * Contenu verrouillé hors brouillon (trigger 0013, inchangé) : prototype, revue et approuvé sont figés.
--  * Retour en brouillon possible depuis la revue (rejet motivé), pour corriger.
--  * Approbation : seul le passage revue → approuvé est possible ; approbateur distinct du rédacteur et du demandeur de revue.
--  * Preuves exigées à l'approbation : au moins une mesure ; chaque mesure avec sa tolérance ; au moins un visuel ou un document.
--  * Cohérence SKU exigée à l'approbation : un SKU catalogue qui diffère du SKU de la spécification bloque l'approbation.
--    Le renommage n'est possible qu'avec un mapping enregistré (product_sku_map_apply), jamais par écrasement silencieux.
-- Collections : regroupement commercial (saison, année) d'un ou plusieurs produits du même client ; attribution seulement à une collection active.
--
-- Rupture assumée (décision à valider) : validation directe depuis le brouillon supprimée ; une version doit passer par la revue.
-- Erreurs : PRODUCT_BAD_STATUS, SOD_SELF_APPROVAL, PRODUCT_EVIDENCE_REQUIRED, PRODUCT_TOLERANCE_MISSING, PRODUCT_SKU_INCOHERENT,
-- PRODUCT_REVIEW_REASON_REQUIRED, SKU_NOT_FOUND, SKU_DUPLICATE, SKU_NOT_IN_SPEC, COLLECTION_NAME_REQUIRED, COLLECTION_YEAR_INVALID,
-- COLLECTION_CLIENT_MISMATCH, COLLECTION_NOT_ACTIVE.

-- ---------------------------------------------------------------------------
-- 1. Statuts de version et colonnes de revue (additifs)
-- ---------------------------------------------------------------------------
alter table public.product_versions drop constraint if exists product_versions_status_check;
alter table public.product_versions add constraint product_versions_status_check
  check (status in ('draft', 'prototype', 'review', 'validated', 'obsolete'));
alter table public.product_versions
  add column if not exists review_requested_by uuid,
  add column if not exists review_requested_at timestamptz,
  add column if not exists review_note text check (review_note is null or length(review_note) <= 500),
  add column if not exists review_feedback text check (review_feedback is null or length(review_feedback) <= 500),
  add column if not exists review_decided_at timestamptz;

-- Une version en prototype ou en revue ouvre le dossier : pas de nouvelle version en parallèle.
create or replace function public.product_new_version(p_product uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.product_master%rowtype; v_last public.product_versions%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('products.write');
  select * into v from public.product_master where id = p_product and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(p_product);
  if exists (select 1 from public.product_versions where product_id = p_product and status in ('draft', 'prototype', 'review')) then
    raise exception 'PRODUCT_DRAFT_EXISTS' using errcode = '55000';
  end if;
  select * into v_last from public.product_versions where product_id = p_product order by version_no desc limit 1;
  insert into public.product_versions (id, company_id, client_id, product_id, version_no, spec, change_note)
  values (v_id, v.company_id, v.client_id, p_product, v_last.version_no + 1, v_last.spec, nullif(btrim(coalesce(p_note, '')), ''));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Collections
-- ---------------------------------------------------------------------------
create table public.product_collections (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete restrict,
  code        text not null,                                              -- COL-0001 (généré, immuable)
  name        text not null check (length(btrim(name)) between 2 and 120),
  season      text check (season is null or length(btrim(season)) between 1 and 40),
  year        int not null check (year between 2000 and 2100),
  status      text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (company_id, code)
);
create unique index product_collections_name_uq on public.product_collections (company_id, client_id, lower(btrim(name)), year);
alter table public.product_collections enable row level security;
create policy product_collections_select on public.product_collections for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
revoke all on public.product_collections from public, anon, authenticated;
grant select on public.product_collections to authenticated;

alter table public.product_master add column if not exists collection_id uuid references public.product_collections(id) on delete set null;
create index if not exists product_master_collection_idx on public.product_master (company_id, collection_id);

create function public.product_collection_create(p_client uuid, p_name text, p_season text, p_year int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('products.write');
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(p_client);
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'COLLECTION_NAME_REQUIRED' using errcode = '22023'; end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then raise exception 'COLLECTION_YEAR_INVALID' using errcode = '22023'; end if;
  v_code := 'COL-' || lpad(private.next_seq(v_co, 'product_collection')::text, 4, '0');
  insert into public.product_collections (id, company_id, client_id, code, name, season, year, created_by, updated_by)
  values (v_id, v_co, p_client, v_code, btrim(p_name), nullif(btrim(coalesce(p_season, '')), ''), p_year, auth.uid(), auth.uid());
  perform private.write_audit(v_co, 'product.collection_create', 'collection', v_id::text, v_code, null,
    jsonb_build_object('name', btrim(p_name), 'year', p_year), private.product_meta(p_client), 'rpc');
  return v_id;
end $$;

create function public.product_collection_set_status(p_collection uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.product_collections%rowtype;
begin
  perform private.require_perm('products.write');
  select * into c from public.product_collections where id = p_collection and company_id = v_co for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status not in ('draft', 'active', 'archived') then raise exception 'PRODUCT_BAD_STATUS' using errcode = '22023'; end if;
  update public.product_collections set status = p_status, updated_at = now(), updated_by = auth.uid() where id = c.id;
  perform private.write_audit(v_co, 'product.collection_status', 'collection', c.id::text, c.code, jsonb_build_object('status', c.status),
    jsonb_build_object('status', p_status), private.product_meta(c.client_id), 'rpc');
end $$;

create function public.product_collection_assign(p_product uuid, p_collection uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_p public.product_master%rowtype; c public.product_collections%rowtype;
begin
  perform private.require_perm('products.write');
  select * into v_p from public.product_master where id = p_product and company_id = v_co for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(p_product);
  if p_collection is not null then
    select * into c from public.product_collections where id = p_collection and company_id = v_co;
    if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
    if c.client_id <> v_p.client_id then raise exception 'COLLECTION_CLIENT_MISMATCH' using errcode = '22023'; end if;
    if c.status <> 'active' then raise exception 'COLLECTION_NOT_ACTIVE' using errcode = '55000'; end if;
  end if;
  perform set_config('product.rpc', 'on', true);
  update public.product_master set collection_id = p_collection, updated_at = now(), updated_by = auth.uid() where id = v_p.id;
  perform set_config('product.rpc', 'off', true);
  perform private.write_audit(v_co, 'product.collection_assign', 'product', v_p.id::text, v_p.code, jsonb_build_object('collection_id', v_p.collection_id),
    jsonb_build_object('collection_id', p_collection), private.product_meta(v_p.client_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Cohérence des SKU (spécification ↔ catalogue des variantes)
-- ---------------------------------------------------------------------------
create function private.sku_issues(p_version uuid, p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_spec jsonb; e jsonb; v_cid uuid; v_sid uuid; cur record; v_out jsonb := '[]'::jsonb;
begin
  select spec into v_spec from public.product_versions where id = p_version and company_id = v_co;
  for e in select j.value from jsonb_array_elements(coalesce(v_spec -> 'variants', '[]'::jsonb)) j loop
    continue when coalesce((e ->> 'active')::boolean, true) is false;
    select c.id into v_cid from public.colors c where c.company_id = v_co and lower(btrim(c.name)) = lower(btrim(e ->> 'color'));
    select s.id into v_sid from public.sizes s where s.company_id = v_co and upper(s.code) = upper(btrim(e ->> 'size'));
    if v_cid is null or v_sid is null then
      v_out := v_out || jsonb_build_object('type', 'unknown_color_or_size', 'blocking', false, 'spec_sku', e ->> 'sku', 'color', e ->> 'color', 'size', e ->> 'size');
      continue;
    end if;
    select pv.sku into cur from public.product_variants pv where pv.product_id = p_product and pv.color_id = v_cid and pv.size_id = v_sid;
    if not found then
      v_out := v_out || jsonb_build_object('type', 'not_generated', 'blocking', false, 'spec_sku', e ->> 'sku', 'color', e ->> 'color', 'size', e ->> 'size');
    elsif upper(cur.sku) <> upper(btrim(e ->> 'sku')) then
      v_out := v_out || jsonb_build_object('type', 'sku_differs', 'blocking', true, 'catalog_sku', cur.sku, 'spec_sku', e ->> 'sku',
        'color', e ->> 'color', 'size', e ->> 'size');
    end if;
  end loop;
  return v_out;
end $$;
revoke execute on function private.sku_issues(uuid, uuid) from public, anon, authenticated;

create function public.product_sku_check(p_product uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_p public.product_master%rowtype; v_issues jsonb;
begin
  perform private.require_perm('products.read');
  select * into v_p from public.product_master where id = p_product and company_id = v_co;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  v_issues := private.sku_issues(v_p.current_version_id, p_product);
  return jsonb_build_object('product', v_p.code, 'issues', v_issues,
    'blocking', exists (select 1 from jsonb_array_elements(v_issues) i where (i.value ->> 'blocking')::boolean));
end $$;

-- Renommage d'un SKU catalogue : seulement vers le SKU de la spécification, avec un motif, et une trace permanente.
create table public.product_sku_mappings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  product_id  uuid not null references public.product_master(id) on delete restrict,
  variant_id  uuid not null references public.product_variants(id) on delete restrict,
  from_sku    text not null,
  to_sku      text not null,
  reason      text not null check (length(btrim(reason)) between 5 and 500),
  decided_by  uuid default auth.uid(),
  decided_at  timestamptz not null default clock_timestamp()
);
create trigger product_sku_mappings_immutable before update or delete on public.product_sku_mappings
  for each row execute function private.stock_immutable();
alter table public.product_sku_mappings enable row level security;
create policy product_sku_mappings_select on public.product_sku_mappings for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
revoke all on public.product_sku_mappings from public, anon, authenticated;
grant select on public.product_sku_mappings to authenticated;

create function public.product_sku_map_apply(p_product uuid, p_from text, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_p public.product_master%rowtype; v_var record; v_spec_sku text; v_from text := upper(btrim(coalesce(p_from, ''))); v_to text := upper(btrim(coalesce(p_to, '')));
begin
  perform private.require_perm('products.validate');
  select * into v_p from public.product_master where id = p_product and company_id = v_co for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(p_product);
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'PRODUCT_REVIEW_REASON_REQUIRED' using errcode = '22023'; end if;
  if v_from = '' or v_to = '' or v_from = v_to then raise exception 'SKU_NOT_FOUND' using errcode = '22023'; end if;
  select pv.* into v_var from public.product_variants pv where pv.product_id = p_product and upper(pv.sku) = v_from;
  if not found then raise exception 'SKU_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.product_variants where company_id = v_co and upper(sku) = v_to) then raise exception 'SKU_DUPLICATE' using errcode = '23505'; end if;
  -- Le nouveau SKU doit être celui de la spécification courante pour la même couleur et la même taille.
  select e.value ->> 'sku' into v_spec_sku
    from public.product_versions pvs, jsonb_array_elements(coalesce(pvs.spec -> 'variants', '[]'::jsonb)) e
    where pvs.id = v_p.current_version_id
      and lower(btrim(e.value ->> 'color')) = (select lower(btrim(c.name)) from public.colors c where c.id = v_var.color_id)
      and upper(btrim(e.value ->> 'size')) = (select upper(s.code) from public.sizes s where s.id = v_var.size_id)
    limit 1;
  if v_spec_sku is null or upper(btrim(v_spec_sku)) <> v_to then raise exception 'SKU_NOT_IN_SPEC' using errcode = '22023'; end if;
  perform set_config('variants.bulk', 'on', true);
  perform set_config('variants.sku_map', 'on', true);
  update public.product_variants set sku = v_to where id = v_var.id;
  perform set_config('variants.sku_map', 'off', true);
  perform set_config('variants.bulk', 'off', true);
  insert into public.product_sku_mappings (company_id, product_id, variant_id, from_sku, to_sku, reason)
  values (v_co, p_product, v_var.id, v_var.sku, v_to, btrim(p_reason));
  perform private.write_audit(v_co, 'product.sku_map', 'product', p_product::text, v_p.code, jsonb_build_object('sku', v_var.sku),
    jsonb_build_object('sku', v_to), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Cycle de la version : prototype, revue, rejet, approbation distincte
-- ---------------------------------------------------------------------------
create function private.version_set_status(p_version uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('product.rpc', 'on', true);
  update public.product_versions set status = p_status where id = p_version;
  perform set_config('product.rpc', 'off', true);
end $$;
revoke execute on function private.version_set_status(uuid, text) from public, anon, authenticated;

create function public.product_version_prototype(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_versions%rowtype; v_p public.product_master%rowtype;
begin
  perform private.require_perm('products.write');
  select * into v from public.product_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(v.product_id);
  if v.status <> 'draft' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  if jsonb_array_length(v.spec -> 'colors') = 0 or jsonb_array_length(v.spec -> 'sizes') = 0 then raise exception 'PRODUCT_SPEC_INCOMPLETE' using errcode = '55000'; end if;
  perform private.version_set_status(p_version, 'prototype');
  select * into v_p from public.product_master where id = v.product_id;
  perform private.write_audit(v.company_id, 'product.version_prototype', 'product', v.product_id::text, v_p.code, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'prototype', 'version_no', v.version_no), private.product_meta(v.client_id), 'rpc');
end $$;

create function public.product_version_submit_review(p_version uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_versions%rowtype; v_p public.product_master%rowtype;
begin
  perform private.require_perm('products.write');
  select * into v from public.product_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(v.product_id);
  if v.status not in ('draft', 'prototype') then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  if jsonb_array_length(v.spec -> 'colors') = 0 or jsonb_array_length(v.spec -> 'sizes') = 0 then raise exception 'PRODUCT_SPEC_INCOMPLETE' using errcode = '55000'; end if;
  perform set_config('product.rpc', 'on', true);
  update public.product_versions set status = 'review', review_requested_by = auth.uid(), review_requested_at = now(),
    review_note = nullif(btrim(coalesce(p_note, '')), ''), review_feedback = null, review_decided_at = null where id = p_version;
  perform set_config('product.rpc', 'off', true);
  select * into v_p from public.product_master where id = v.product_id;
  perform private.write_audit(v.company_id, 'product.version_review', 'product', v.product_id::text, v_p.code, jsonb_build_object('status', v.status),
    jsonb_build_object('status', 'review', 'version_no', v.version_no), private.product_meta(v.client_id), 'rpc');
end $$;

create function public.product_version_reject(p_version uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_versions%rowtype; v_p public.product_master%rowtype;
begin
  perform private.require_perm('products.validate');
  select * into v from public.product_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(v.product_id);
  if v.status <> 'review' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'PRODUCT_REVIEW_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('product.rpc', 'on', true);
  update public.product_versions set status = 'draft', review_feedback = btrim(p_reason), review_decided_at = now() where id = p_version;
  perform set_config('product.rpc', 'off', true);
  select * into v_p from public.product_master where id = v.product_id;
  perform private.write_audit(v.company_id, 'product.version_reject', 'product', v.product_id::text, v_p.code, jsonb_build_object('status', 'review'),
    jsonb_build_object('status', 'draft', 'version_no', v.version_no), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- Approbation : revue → approuvé. Approbateur distinct du rédacteur et du demandeur de revue ; preuves et SKU cohérents.
create or replace function public.product_validate_version(p_version uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_versions%rowtype; v_p public.product_master%rowtype; e jsonb; v_n int;
begin
  perform private.require_perm('products.validate');
  select * into v from public.product_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_p from public.product_master where id = v.product_id for update;
  perform private.product_assert_open(v.product_id);
  if v.status <> 'review' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  if auth.uid() is null or auth.uid() = v.created_by or auth.uid() = v.review_requested_by then
    raise exception 'SOD_SELF_APPROVAL' using errcode = '42501';
  end if;
  if jsonb_array_length(v.spec -> 'colors') = 0 or jsonb_array_length(v.spec -> 'sizes') = 0 then
    raise exception 'PRODUCT_SPEC_INCOMPLETE' using errcode = '55000';
  end if;
  -- Preuves : mesures avec tolérance, et au moins un visuel ou un document
  if jsonb_array_length(coalesce(v.spec -> 'measurements', '[]'::jsonb)) = 0 then raise exception 'PRODUCT_EVIDENCE_REQUIRED' using errcode = '55000'; end if;
  for e in select j.value from jsonb_array_elements(v.spec -> 'measurements') j loop
    if nullif(btrim(coalesce(e ->> 'tolerance', '')), '') is null then raise exception 'PRODUCT_TOLERANCE_MISSING' using errcode = '55000'; end if;
  end loop;
  if not exists (select 1 from public.product_photos where product_id = v.product_id)
     and not exists (select 1 from public.product_documents where product_id = v.product_id) then
    raise exception 'PRODUCT_EVIDENCE_REQUIRED' using errcode = '55000';
  end if;
  -- Cohérence des SKU : tout SKU catalogue différent de la spécification bloque
  select count(*) into v_n from jsonb_array_elements(private.sku_issues(v.id, v.product_id)) i where (i.value ->> 'blocking')::boolean;
  if v_n > 0 then raise exception 'PRODUCT_SKU_INCOHERENT' using errcode = '55000'; end if;

  perform set_config('product.rpc', 'on', true);
  update public.product_versions set status = 'obsolete' where product_id = v.product_id and status = 'validated';
  update public.product_versions set status = 'validated', validated_by = auth.uid(), validated_at = now(), review_decided_at = now(),
         validation_comment = nullif(btrim(coalesce(p_comment, '')), ''), snapshot = private.product_snapshot(v.product_id) where id = p_version;
  perform set_config('product.rpc', 'off', true);
  perform private.product_refresh(v.product_id);
  if v_p.status = 'draft' then
    perform set_config('product.rpc', 'on', true);
    update public.product_master set status = 'active' where id = v.product_id;
    perform set_config('product.rpc', 'off', true);
    perform private.write_audit(v.company_id, 'product.update', 'product', v.product_id::text, v_p.code,
      jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'active'), private.product_meta(v.client_id), 'rpc');
  end if;
end $$;

-- Garde-fou des variantes (0015) : identique, sauf que le SKU ne change que par le mapping de renommage (variants.sku_map).
create or replace function private.variants_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; c public.colors%rowtype; s public.sizes%rowtype; b public.boms%rowtype;
begin
  select * into p from public.product_master where id = new.product_id;
  if not found then raise exception 'VARIANT_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status = 'archived' and not private.variants_flag('variants.bulk') and not private.variants_flag('variants.rpc') then raise exception 'VARIANT_PRODUCT_ARCHIVED' using errcode = '55000'; end if;
  new.company_id := p.company_id;
  if tg_op = 'INSERT' then
    select * into c from public.colors where id = new.color_id and company_id = p.company_id;
    select * into s from public.sizes  where id = new.size_id  and company_id = p.company_id;
    if c.id is null or s.id is null then raise exception 'VARIANT_BAD_ATTRIBUTE' using errcode = '22023'; end if;
    if not c.active or not s.active then raise exception 'VARIANT_ATTRIBUTE_INACTIVE' using errcode = '55000'; end if;
    if nullif(btrim(coalesce(new.sku, '')), '') is null then
      new.sku := upper(regexp_replace(p.code || '-' || c.code || '-' || s.code, '[^A-Za-z0-9-]', '', 'g'));
    end if;
    new.sku := upper(btrim(new.sku)); new.created_by := auth.uid(); new.updated_by := auth.uid();
  else
    if new.product_id is distinct from old.product_id or new.color_id is distinct from old.color_id or new.size_id is distinct from old.size_id or (new.sku is distinct from old.sku and coalesce(current_setting('variants.sku_map', true), 'off') <> 'on') then
      raise exception 'VARIANT_REF_LOCKED' using errcode = '42501';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  if new.bom_id is not null and (tg_op = 'INSERT' or new.bom_id is distinct from old.bom_id) then
    select * into b from public.boms where id = new.bom_id and company_id = p.company_id;
    if b.id is null or b.kind <> 'product' or b.archived_at is not null
       or (b.article_id is not null and not exists (select 1 from public.articles a where a.id = b.article_id and a.client_id = p.client_id)) then
      raise exception 'VARIANT_BAD_BOM' using errcode = '22023';       -- nomenclature produit, non archivée, du même client (ou sans article)
    end if;
  end if;
  new.currency := upper(new.currency);
  return new;
end $$;

-- Garde-fou SKU (0039) : identique, sauf le renommage par mapping (variants.sku_map) qui inscrit le nouveau SKU à l'historique.
create or replace function private.variant_sku_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.sku := upper(btrim(new.sku));
    if exists (select 1 from public.sku_history h where h.company_id = new.company_id and h.sku_key = new.sku) then
      raise exception 'SKU_HISTORICAL' using errcode = '23505', detail = new.sku;
    end if;
    insert into public.sku_history (company_id, sku_key, variant_id) values (new.company_id, new.sku, new.id);
  elsif tg_op = 'UPDATE' then
    if new.sku is distinct from old.sku then
      if coalesce(current_setting('variants.sku_map', true), 'off') <> 'on' then raise exception 'SKU_IMMUTABLE' using errcode = '42501'; end if;
      -- Renommage par mapping : le nouveau SKU doit être inédit, il est inscrit à l'historique (l'ancien y reste).
      if exists (select 1 from public.sku_history h where h.company_id = new.company_id and h.sku_key = upper(btrim(new.sku))) then
        raise exception 'SKU_HISTORICAL' using errcode = '23505', detail = new.sku;
      end if;
      new.sku := upper(btrim(new.sku));
      insert into public.sku_history (company_id, sku_key, variant_id) values (new.company_id, new.sku, new.id);
    end if;
  end if;
  return new;
end $$;

-- Journal des versions (0013) : identique ; l'approbation vient de la revue (0068), qui est elle aussi tracée.
create or replace function private.audit_product_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_chg jsonb;
begin
  select code into v_code from public.product_master where id = new.product_id;
  if tg_op = 'UPDATE' and old.status = new.status and new.spec is distinct from old.spec then
    if coalesce(current_setting('product.dup', true), 'off') = 'on' then return new; end if;
    v_chg := private.jsonb_changes(old.spec, new.spec, '{}');
    perform private.write_audit(new.company_id, 'product.spec_update', 'product', new.product_id::text, v_code, v_chg -> 'before', v_chg -> 'after',
      private.product_meta(new.client_id, jsonb_build_object('version', new.version_no)));
  elsif tg_op = 'UPDATE' and old.status in ('draft', 'review') and new.status = 'validated' then
    perform private.write_audit(new.company_id, 'product.version_validate', 'product', new.product_id::text, v_code, null, null,
      private.product_meta(new.client_id, jsonb_build_object('version', new.version_no, 'comment', new.validation_comment)));
  elsif tg_op = 'INSERT' and new.version_no > 1 then
    perform private.write_audit(new.company_id, 'product.version_new', 'product', new.product_id::text, v_code, null, null,
      private.product_meta(new.client_id, jsonb_build_object('version', new.version_no, 'note', new.change_note)));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.product_collection_create(uuid, text, text, int), public.product_collection_set_status(uuid, text),
  public.product_collection_assign(uuid, uuid), public.product_sku_check(uuid), public.product_sku_map_apply(uuid, text, text, text),
  public.product_version_prototype(uuid), public.product_version_submit_review(uuid, text), public.product_version_reject(uuid, text)
  from public, anon;
grant execute on function public.product_collection_create(uuid, text, text, int), public.product_collection_set_status(uuid, text),
  public.product_collection_assign(uuid, uuid), public.product_sku_check(uuid), public.product_sku_map_apply(uuid, text, text, text),
  public.product_version_prototype(uuid), public.product_version_submit_review(uuid, text), public.product_version_reject(uuid, text)
  to authenticated;
