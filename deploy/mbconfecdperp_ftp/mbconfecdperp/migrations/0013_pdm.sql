-- =====================================================================
-- 0013_pdm — Product Master Management (PDM textile)
--  Référentiel technique unique d'un produit : fiche technique versionnée (matière, couleurs, tailles, variantes,
--  tableau de mesures, entretien, packaging), photos (Storage), nomenclature (lien vers l'article → BOM),
--  patronages et documents (GED), certifications, historique complet (audit_logs, entity_type = 'product').
--  Tables : product_master, product_versions, product_photos, product_documents, product_certifications.
--  Cycle de vie : version 1 brouillon → validation (figée, instantané des certifications/documents) → active ;
--  nouvelle version = copie de la précédente ; archivage = lecture seule (restauration possible).
--  Permissions nouvelles : products.read / products.write / products.validate / products.archive.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('products.read',     'articles', 'Voir les fiches produit (PDM)', 'Fiche 360°, versions, comparaison, historique'),
  ('products.write',    'articles', 'Gérer les fiches produit',      'Créer, dupliquer, modifier le brouillon, photos, documents, certifications'),
  ('products.validate', 'articles', 'Valider les versions produit',  'Valider une version de la fiche technique'),
  ('products.archive',  'articles', 'Archiver les produits',         'Archiver et restaurer un produit')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('products.read', 'products.write', 'products.validate', 'products.archive'))
  or (r.code in ('direction', 'achat', 'magasin', 'finance') and p.code = 'products.read')
  or (r.code = 'commercial' and p.code in ('products.read', 'products.write'))
  or (r.code = 'production' and p.code in ('products.read', 'products.write', 'products.archive'))
  or (r.code = 'qualite'    and p.code in ('products.read', 'products.write', 'products.validate')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Structure de la fiche (spec JSON)
--    { tech:{composition,fabric,weight_gsm,season,gender,construction,finishing,notes},
--      colors:[{name,hex?,pantone?,client_code?}], sizes:[{label,client_code?}],
--      variants:[{sku,color,size,barcode?,active?}], measurements:[{point,tolerance?,values:{<taille>:nombre}}],
--      care:{wash,bleach,tumble,iron,dry_clean,instructions}, packaging:{…} }
-- ---------------------------------------------------------------------
create function private.product_spec_valid(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare e jsonb; v record;
begin
  if coalesce(jsonb_typeof(s), '') <> 'object' then return false; end if;
  if coalesce(jsonb_typeof(s -> 'tech'), '') <> 'object' or coalesce(jsonb_typeof(s -> 'care'), '') <> 'object' or coalesce(jsonb_typeof(s -> 'packaging'), '') <> 'object' then return false; end if;
  if coalesce(jsonb_typeof(s -> 'colors'), '') <> 'array' or jsonb_array_length(s -> 'colors') > 60 then return false; end if;
  if coalesce(jsonb_typeof(s -> 'sizes'), '') <> 'array' or jsonb_array_length(s -> 'sizes') > 40 then return false; end if;
  if coalesce(jsonb_typeof(s -> 'variants'), '') <> 'array' or jsonb_array_length(s -> 'variants') > 800 then return false; end if;
  if coalesce(jsonb_typeof(s -> 'measurements'), '') <> 'array' or jsonb_array_length(s -> 'measurements') > 60 then return false; end if;

  if nullif(s -> 'tech' ->> 'weight_gsm', '') is not null and (jsonb_typeof(s -> 'tech' -> 'weight_gsm') <> 'number' or (s -> 'tech' ->> 'weight_gsm')::numeric < 0 or (s -> 'tech' ->> 'weight_gsm')::numeric > 5000) then return false; end if;
  if length(coalesce(s -> 'tech' ->> 'composition', '')) > 300 or length(coalesce(s -> 'tech' ->> 'notes', '')) > 2000 then return false; end if;

  for e in select * from jsonb_array_elements(s -> 'colors') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'name', '')), '') is null or length(e ->> 'name') > 60 then return false; end if;
    if nullif(e ->> 'hex', '') is not null and (e ->> 'hex') !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
  end loop;
  if (select count(distinct lower(btrim(x ->> 'name'))) from jsonb_array_elements(s -> 'colors') x) <> jsonb_array_length(s -> 'colors') then return false; end if;
  for e in select * from jsonb_array_elements(s -> 'sizes') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'label', '')), '') is null or length(e ->> 'label') > 12 then return false; end if;
  end loop;
  if (select count(distinct btrim(x ->> 'label')) from jsonb_array_elements(s -> 'sizes') x) <> jsonb_array_length(s -> 'sizes') then return false; end if;
  for e in select * from jsonb_array_elements(s -> 'variants') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'sku', '')), '') is null or length(e ->> 'sku') > 40 then return false; end if;
    if length(coalesce(e ->> 'color', '')) > 60 or length(coalesce(e ->> 'size', '')) > 12 or length(coalesce(e ->> 'barcode', '')) > 20 then return false; end if;
  end loop;
  if (select count(distinct upper(btrim(x ->> 'sku'))) from jsonb_array_elements(s -> 'variants') x) <> jsonb_array_length(s -> 'variants') then return false; end if;
  for e in select * from jsonb_array_elements(s -> 'measurements') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'point', '')), '') is null or length(e ->> 'point') > 80 then return false; end if;
    if e ? 'values' then
      if jsonb_typeof(e -> 'values') <> 'object' then return false; end if;
      for v in select * from jsonb_each(e -> 'values') loop
        if jsonb_typeof(v.value) <> 'number' then return false; end if;
      end loop;
    end if;
  end loop;
  if (select count(distinct lower(btrim(x ->> 'point'))) from jsonb_array_elements(s -> 'measurements') x) <> jsonb_array_length(s -> 'measurements') then return false; end if;

  if nullif(s -> 'care' ->> 'wash', '') is not null and (s -> 'care' ->> 'wash') not in ('30','40','60','95','hand','no') then return false; end if;
  if nullif(s -> 'care' ->> 'tumble', '') is not null and (s -> 'care' ->> 'tumble') not in ('no','low','normal') then return false; end if;
  if nullif(s -> 'care' ->> 'iron', '') is not null and (s -> 'care' ->> 'iron') not in ('no','110','150','200') then return false; end if;
  if nullif(s -> 'care' ->> 'bleach', '') is not null and (s -> 'care' ->> 'bleach') not in ('none','allowed') then return false; end if;
  if nullif(s -> 'care' ->> 'dry_clean', '') is not null and (s -> 'care' ->> 'dry_clean') not in ('no','yes') then return false; end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------
create table public.product_master (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  client_id          uuid not null references public.clients(id),         -- RESTRICT : un client avec produits ne se supprime pas
  code               text not null,                                       -- PRD-0001 (généré, immuable)
  name               text not null check (length(btrim(name)) between 2 and 160),
  family             text not null default 'other' check (family in ('jacket','trousers','coverall','polo','tshirt','vest','parka','shirt','apron','accessory','other')),
  article_id         uuid references public.articles(id) on delete set null,   -- article client lié → nomenclatures (BOM)
  description        text check (description is null or length(description) <= 2000),
  status             text not null default 'draft' check (status in ('draft','active','archived')),
  current_version_id uuid,
  active_version_id  uuid,
  main_photo_id      uuid,
  duplicated_from    uuid references public.product_master(id) on delete set null,
  archived_at        timestamptz,
  archived_by        uuid,
  archive_reason     text check (archive_reason is null or length(archive_reason) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  unique (company_id, code),
  constraint product_archived_ck check ((status = 'archived') = (archived_at is not null))
);
create unique index product_master_article_uq on public.product_master (article_id) where article_id is not null;
create index product_master_idx on public.product_master (company_id, status, client_id);

create table public.product_versions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  client_id          uuid not null references public.clients(id) on delete cascade,
  product_id         uuid not null references public.product_master(id) on delete cascade,
  version_no         int  not null check (version_no >= 1),
  status             text not null default 'draft' check (status in ('draft','validated','obsolete')),
  spec               jsonb not null default '{"tech":{},"colors":[],"sizes":[],"variants":[],"measurements":[],"care":{},"packaging":{}}'::jsonb,
  change_note        text check (change_note is null or length(change_note) <= 500),
  snapshot           jsonb,        -- instantané figé à la validation : entête, certifications, documents
  validated_by       uuid,
  validated_at       timestamptz,
  validation_comment text check (validation_comment is null or length(validation_comment) <= 500),
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (product_id, version_no),
  constraint product_versions_spec_ck check (private.product_spec_valid(spec))
);
create unique index product_versions_one_draft_uq on public.product_versions (product_id) where status = 'draft';

alter table public.product_master
  add constraint product_current_version_fk foreign key (current_version_id) references public.product_versions(id) deferrable initially deferred,
  add constraint product_active_version_fk  foreign key (active_version_id)  references public.product_versions(id) deferrable initially deferred;

create table public.product_photos (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  client_id    uuid not null references public.clients(id) on delete cascade,
  product_id   uuid not null references public.product_master(id) on delete cascade,
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  size_bytes   bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  view         text not null default 'front' check (view in ('front','back','side','detail','label','packaging','other')),
  color        text check (color is null or length(color) <= 60),          -- coloris représenté (facultatif)
  caption      text check (caption is null or length(caption) <= 200),
  is_main      boolean not null default false,
  uploaded_by  uuid,
  created_at   timestamptz not null default now()
);
create index product_photos_idx on public.product_photos (product_id, created_at);
create unique index product_photos_main_uq on public.product_photos (product_id) where is_main;

create table public.product_documents (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  client_id       uuid not null references public.clients(id) on delete cascade,
  product_id      uuid not null references public.product_master(id) on delete cascade,
  ged_document_id uuid not null references public.ged_documents(id) on delete cascade,
  kind            text not null default 'other' check (kind in ('tech_sheet','pattern','marker','grading','sample_approval','test_report','label','packaging','other')),
  revision        text check (revision is null or length(revision) <= 30),     -- ex. « Rév. C »
  note            text check (note is null or length(note) <= 300),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (product_id, ged_document_id)
);
create index product_documents_idx on public.product_documents (product_id, kind);

create table public.product_certifications (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  client_id       uuid not null references public.clients(id) on delete cascade,
  product_id      uuid not null references public.product_master(id) on delete cascade,
  standard_code   text not null check (length(btrim(standard_code)) between 2 and 60),     -- ex. EN ISO 20471
  label           text check (label is null or length(label) <= 160),
  cert_type       text not null default 'product' check (cert_type in ('product','material','process','other')),
  class_level     text check (class_level is null or length(class_level) <= 30),
  certificate_no  text check (certificate_no is null or length(certificate_no) <= 80),
  issuer          text check (issuer is null or length(issuer) <= 120),
  issued_on       date,
  valid_until     date,
  status          text not null default 'valid' check (status in ('valid','suspended','revoked')),   -- l'expiration se calcule sur valid_until
  ged_document_id uuid references public.ged_documents(id) on delete set null,                      -- scan du certificat
  notes           text check (notes is null or length(notes) <= 500),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  constraint product_cert_dates_ck check (issued_on is null or valid_until is null or valid_until >= issued_on)
);
create index product_certifications_idx on public.product_certifications (product_id, valid_until);

-- ---------------------------------------------------------------------
-- 4. Outils internes
-- ---------------------------------------------------------------------
create function private.product_flag() returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting('product.rpc', true), 'off') = 'on' $$;

-- Un produit archivé est en lecture seule (sauf RPC) ; le client doit être ouvert
create function private.product_assert_open(p_product uuid) returns public.product_master
language plpgsql stable security definer set search_path = '' as $$
declare v public.product_master%rowtype;
begin
  select * into v from public.product_master where id = p_product;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v.client_id);
  if v.status = 'archived' and not private.product_flag() then raise exception 'PRODUCT_ARCHIVED' using errcode = '55000'; end if;
  return v;
end $$;
revoke execute on function private.product_assert_open(uuid) from public, anon, authenticated;

create function private.product_meta(p_client uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('client_id', p_client, 'client_name', (select name from public.clients where id = p_client)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.product_meta(uuid, jsonb) from public, anon, authenticated;

-- Dernière version, version active, photo principale
create function private.product_refresh(p_product uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cur uuid; v_active uuid; v_prev text := coalesce(current_setting('product.rpc', true), 'off');
begin
  select id into v_cur from public.product_versions where product_id = p_product order by version_no desc limit 1;
  select id into v_active from public.product_versions where product_id = p_product and status = 'validated' limit 1;
  perform set_config('product.rpc', 'on', true);
  update public.product_master set current_version_id = v_cur, active_version_id = v_active where id = p_product;
  perform set_config('product.rpc', v_prev, true);          -- restaure (un RPC appelant garde son drapeau)
end $$;
revoke execute on function private.product_refresh(uuid) from public, anon, authenticated;

-- Instantané des données liées à la version (figé à la validation ; calculé en direct pour un brouillon)
create function private.product_snapshot(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.product_master%rowtype; v_bom text;
begin
  select * into v from public.product_master where id = p_product;
  select b.code || coalesce(' v' || (select bv.version_no::text from public.bom_versions bv where bv.id = b.active_version_id), ' (aucune version validée)') into v_bom
  from public.boms b where b.article_id = v.article_id and b.archived_at is null and v.article_id is not null limit 1;
  return jsonb_build_object(
    'header', jsonb_build_object('name', v.name, 'family', v.family,
      'article', (select internal_ref from public.articles where id = v.article_id),
      'bom', v_bom,
      'photos', (select count(*) from public.product_photos where product_id = p_product)),
    'certifications', coalesce((select jsonb_agg(jsonb_build_object(
        'key', c.standard_code || coalesce(' · ' || c.certificate_no, ''), 'class_level', c.class_level, 'issuer', c.issuer,
        'valid_until', c.valid_until, 'status', c.status) order by c.standard_code, c.certificate_no)
      from public.product_certifications c where c.product_id = p_product), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('key', d.kind || ' : ' || g.title, 'revision', d.revision) order by d.kind, g.title)
      from public.product_documents d join public.ged_documents g on g.id = d.ged_document_id where d.product_id = p_product), '[]'::jsonb));
end $$;
revoke execute on function private.product_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.product_master_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    perform private.ged_assert_client_open(new.client_id);
    select company_id into new.company_id from public.clients where id = new.client_id;
    v_n := private.next_seq(new.company_id, 'product');
    new.code := 'PRD-' || lpad(v_n::text, 4, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.status := 'draft'; new.current_version_id := null; new.active_version_id := null; new.main_photo_id := null;
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;
  else
    if not private.product_flag() then
      if new.client_id is distinct from old.client_id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
         or new.status is distinct from old.status then
        raise exception 'PRODUCT_REF_LOCKED' using errcode = '42501';
      end if;
      perform private.ged_assert_client_open(new.client_id);
      if old.status = 'archived' then raise exception 'PRODUCT_ARCHIVED' using errcode = '55000'; end if;
      new.updated_at := now(); new.updated_by := auth.uid();
    end if;
  end if;
  if new.article_id is not null and (tg_op = 'INSERT' or new.article_id is distinct from old.article_id) then
    if not exists (select 1 from public.articles a where a.id = new.article_id and a.client_id = new.client_id) then
      raise exception 'PRODUCT_BAD_ARTICLE' using errcode = '22023';       -- l'article doit appartenir au même client
    end if;
  end if;
  new.name := btrim(new.name);
  return new;
end $$;
create trigger product_master_before_iu before insert or update on public.product_master
  for each row execute function private.product_master_before();

create function private.product_seed_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('product.rpc', true), 'off');
begin
  perform set_config('product.rpc', 'on', true);
  insert into public.product_versions (company_id, client_id, product_id, version_no, change_note)
  values (new.company_id, new.client_id, new.id, 1, 'Création du produit');
  perform set_config('product.rpc', v_prev, true);
  perform private.product_refresh(new.id);
  return new;
end $$;
create trigger product_seed_version_i after insert on public.product_master
  for each row execute function private.product_seed_version();

create function private.product_versions_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_p public.product_master%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into v_p from public.product_master where id = new.product_id;
    if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := v_p.company_id; new.client_id := v_p.client_id;
    new.status := 'draft'; new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.validated_by := null; new.validated_at := null; new.validation_comment := null; new.snapshot := null;
  else
    if not private.product_flag() then
      perform private.product_assert_open(new.product_id);
      if new.product_id is distinct from old.product_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at or new.snapshot is distinct from old.snapshot then
        raise exception 'PRODUCT_VERSION_LOCKED' using errcode = '42501';
      end if;
      if old.status <> 'draft' and (new.spec is distinct from old.spec or new.change_note is distinct from old.change_note) then
        raise exception 'PRODUCT_VERSION_LOCKED' using errcode = '55000';       -- version validée ou obsolète : figée
      end if;
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger product_versions_before_iu before insert or update on public.product_versions
  for each row execute function private.product_versions_before();

create function private.product_versions_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.product_refresh(coalesce(new.product_id, old.product_id));
  return coalesce(new, old);
end $$;
create trigger product_versions_after_iud after insert or update of status or delete on public.product_versions
  for each row execute function private.product_versions_after();

create function private.product_photos_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_p public.product_master%rowtype;
begin
  v_p := private.product_assert_open(new.product_id);
  new.company_id := v_p.company_id; new.client_id := v_p.client_id;
  if tg_op = 'INSERT' then
    if new.storage_path not like v_p.company_id::text || '/' || v_p.client_id::text || '/' || v_p.id::text || '/%' then
      raise exception 'PRODUCT_INVALID_PATH' using errcode = '22023';
    end if;
    if (select count(*) from public.product_photos where product_id = new.product_id) >= 30 then raise exception 'PRODUCT_TOO_MANY_PHOTOS' using errcode = '22023'; end if;
    new.uploaded_by := auth.uid();
    if not exists (select 1 from public.product_photos where product_id = new.product_id) then new.is_main := true; end if;
  elsif new.storage_path is distinct from old.storage_path or new.product_id is distinct from old.product_id then
    raise exception 'PRODUCT_INVALID_PATH' using errcode = '22023';
  end if;
  if new.is_main then
    update public.product_photos set is_main = false where product_id = new.product_id and id is distinct from new.id and is_main;
  end if;
  return new;
end $$;
create trigger product_photos_before_iu before insert or update on public.product_photos
  for each row execute function private.product_photos_before();

create function private.product_photos_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_p uuid := coalesce(new.product_id, old.product_id); v_prev text := coalesce(current_setting('product.rpc', true), 'off');
begin
  if tg_op = 'DELETE' and old.is_main and not private.product_flag() then
    update public.product_photos set is_main = true
    where id = (select id from public.product_photos where product_id = v_p order by created_at limit 1);
  end if;
  perform set_config('product.rpc', 'on', true);
  update public.product_master set main_photo_id = (select id from public.product_photos where product_id = v_p and is_main limit 1) where id = v_p;
  perform set_config('product.rpc', v_prev, true);
  return coalesce(new, old);
end $$;
create trigger product_photos_after_iud after insert or update of is_main or delete on public.product_photos
  for each row execute function private.product_photos_after();

create function private.product_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_p public.product_master%rowtype;
begin
  if tg_op = 'DELETE' then return old; end if;     -- l'archivage est contrôlé par la politique RLS ; les suppressions en cascade (GED, produit) restent possibles
  v_p := private.product_assert_open(new.product_id);
  new.company_id := v_p.company_id; new.client_id := v_p.client_id;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.ged_documents g where g.id = new.ged_document_id and g.client_id = v_p.client_id and g.deleted_at is null) then
      raise exception 'PRODUCT_BAD_DOCUMENT' using errcode = '22023';       -- le document doit appartenir au même client (hors corbeille)
    end if;
  elsif new.product_id is distinct from old.product_id or new.ged_document_id is distinct from old.ged_document_id then
    raise exception 'PRODUCT_REF_LOCKED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger product_documents_before_iud before insert or update or delete on public.product_documents
  for each row execute function private.product_documents_before();

create function private.product_certs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_p public.product_master%rowtype;
begin
  if tg_op = 'DELETE' then return old; end if;
  v_p := private.product_assert_open(new.product_id);
  new.company_id := v_p.company_id; new.client_id := v_p.client_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.updated_by := auth.uid();
  else
    if new.product_id is distinct from old.product_id then raise exception 'PRODUCT_REF_LOCKED' using errcode = '42501'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.standard_code := btrim(new.standard_code);
  if new.ged_document_id is not null and not exists (select 1 from public.ged_documents g where g.id = new.ged_document_id and g.client_id = v_p.client_id and g.deleted_at is null) then
    raise exception 'PRODUCT_BAD_DOCUMENT' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger product_certs_before_iud before insert or update or delete on public.product_certifications
  for each row execute function private.product_certs_before();

-- ---------------------------------------------------------------------
-- 6. Historique (audit_logs, entity_type = 'product')
-- ---------------------------------------------------------------------
create function private.audit_product_master() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.product_flag() then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'product.create', 'product', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'family', new.family), private.product_meta(new.client_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','family','description','article_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'product.update', 'product', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after',
        private.product_meta(new.client_id, jsonb_build_object(
          'article_from', (select internal_ref from public.articles where id = old.article_id), 'article_to', (select internal_ref from public.articles where id = new.article_id))));
    end if;
  end if;
  return new;
end $$;
create trigger audit_product_master_iu after insert or update on public.product_master
  for each row execute function private.audit_product_master();

create function private.audit_product_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_chg jsonb;
begin
  select code into v_code from public.product_master where id = new.product_id;
  if tg_op = 'UPDATE' and old.status = new.status and new.spec is distinct from old.spec then
    if coalesce(current_setting('product.dup', true), 'off') = 'on' then return new; end if;
    v_chg := private.jsonb_changes(old.spec, new.spec, '{}');
    perform private.write_audit(new.company_id, 'product.spec_update', 'product', new.product_id::text, v_code, v_chg -> 'before', v_chg -> 'after',
      private.product_meta(new.client_id, jsonb_build_object('version', new.version_no)));
  elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'validated' then
    perform private.write_audit(new.company_id, 'product.version_validate', 'product', new.product_id::text, v_code, null, null,
      private.product_meta(new.client_id, jsonb_build_object('version', new.version_no, 'comment', new.validation_comment)));
  elsif tg_op = 'INSERT' and new.version_no > 1 then
    perform private.write_audit(new.company_id, 'product.version_new', 'product', new.product_id::text, v_code, null, null,
      private.product_meta(new.client_id, jsonb_build_object('version', new.version_no, 'note', new.change_note)));
  end if;
  return new;
end $$;
create trigger audit_product_versions_iu after insert or update on public.product_versions
  for each row execute function private.audit_product_versions();

create function private.audit_product_photos() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.product_photos%rowtype; v_code text;
begin
  if private.product_flag() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.product_master where id = r.product_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'product.photo_add', 'product', r.product_id::text, v_code, null, null, private.product_meta(r.client_id, jsonb_build_object('file_name', r.file_name, 'view', r.view)));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'product.photo_delete', 'product', r.product_id::text, v_code, null, null, private.product_meta(r.client_id, jsonb_build_object('file_name', r.file_name)));
  elsif old.is_main = false and new.is_main = true then
    perform private.write_audit(r.company_id, 'product.photo_main', 'product', r.product_id::text, v_code, null, null, private.product_meta(r.client_id, jsonb_build_object('file_name', r.file_name)));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_product_photos_iud after insert or update or delete on public.product_photos
  for each row execute function private.audit_product_photos();

create function private.audit_product_documents() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.product_documents%rowtype; v_code text; v_title text; v_chg jsonb;
begin
  if private.product_flag() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.product_master where id = r.product_id;
  select title into v_title from public.ged_documents where id = r.ged_document_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'product.document_link', 'product', r.product_id::text, v_code, null, null, private.product_meta(r.client_id, jsonb_build_object('document', v_title, 'kind', r.kind, 'document_id', r.ged_document_id)));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'product.document_unlink', 'product', r.product_id::text, v_code, null, null, private.product_meta(r.client_id, jsonb_build_object('document', v_title, 'kind', r.kind, 'document_id', r.ged_document_id)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('kind','revision','note')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(r.company_id, 'product.document_update', 'product', r.product_id::text, v_code, v_chg -> 'before', v_chg -> 'after', private.product_meta(r.client_id, jsonb_build_object('document', v_title)));
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_product_documents_iud after insert or update or delete on public.product_documents
  for each row execute function private.audit_product_documents();

create function private.audit_product_certs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.product_certifications%rowtype; v_code text; v_chg jsonb;
begin
  if private.product_flag() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.product_master where id = r.product_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'product.cert_add', 'product', r.product_id::text, v_code, null,
      jsonb_build_object('standard_code', r.standard_code, 'class_level', r.class_level, 'certificate_no', r.certificate_no, 'valid_until', r.valid_until),
      private.product_meta(r.client_id, jsonb_build_object('standard', r.standard_code)));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'product.cert_delete', 'product', r.product_id::text, v_code,
      jsonb_build_object('standard_code', r.standard_code, 'class_level', r.class_level, 'certificate_no', r.certificate_no, 'valid_until', r.valid_until, 'status', r.status), null,
      private.product_meta(r.client_id, jsonb_build_object('standard', r.standard_code)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('standard_code','label','cert_type','class_level','certificate_no','issuer','issued_on','valid_until','status','ged_document_id','notes')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(r.company_id, 'product.cert_update', 'product', r.product_id::text, v_code, v_chg -> 'before', v_chg -> 'after',
        private.product_meta(r.client_id, jsonb_build_object('standard', new.standard_code)));
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_product_certs_iud after insert or update or delete on public.product_certifications
  for each row execute function private.audit_product_certs();

create policy audit_logs_select_products on public.audit_logs for select to authenticated
  using (entity_type = 'product' and company_id = private.current_company() and private.has_perm('products.read'));

-- ---------------------------------------------------------------------
-- 7. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.product_master         enable row level security;
alter table public.product_versions       enable row level security;
alter table public.product_photos         enable row level security;
alter table public.product_documents      enable row level security;
alter table public.product_certifications enable row level security;

revoke all on public.product_master, public.product_versions, public.product_photos, public.product_documents, public.product_certifications from anon, authenticated;
grant all on public.product_master, public.product_versions, public.product_photos, public.product_documents, public.product_certifications to service_role;
grant select on public.product_master, public.product_versions, public.product_photos, public.product_documents, public.product_certifications to authenticated;
grant insert (client_id, name, family, article_id, description) on public.product_master to authenticated;
grant update (name, family, article_id, description) on public.product_master to authenticated;
grant update (spec, change_note) on public.product_versions to authenticated;
grant insert (product_id, storage_path, file_name, mime_type, size_bytes, view, color, caption, is_main) on public.product_photos to authenticated;
grant update (view, color, caption, is_main) on public.product_photos to authenticated;
grant delete on public.product_photos to authenticated;
grant insert (product_id, ged_document_id, kind, revision, note) on public.product_documents to authenticated;
grant update (kind, revision, note) on public.product_documents to authenticated;
grant delete on public.product_documents to authenticated;
grant insert (product_id, standard_code, label, cert_type, class_level, certificate_no, issuer, issued_on, valid_until, status, ged_document_id, notes) on public.product_certifications to authenticated;
grant update (standard_code, label, cert_type, class_level, certificate_no, issuer, issued_on, valid_until, status, ged_document_id, notes) on public.product_certifications to authenticated;
grant delete on public.product_certifications to authenticated;

create policy product_master_select on public.product_master for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
create policy product_master_insert on public.product_master for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('products.write'));
create policy product_master_update on public.product_master for update to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write'))
  with check (company_id = private.current_company() and private.has_perm('products.write'));

create policy product_versions_select on public.product_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
create policy product_versions_update on public.product_versions for update to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write') and status = 'draft')
  with check (company_id = private.current_company() and private.has_perm('products.write'));

create policy product_photos_select on public.product_photos for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
create policy product_photos_insert on public.product_photos for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('products.write'));
create policy product_photos_update on public.product_photos for update to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write'))
  with check (company_id = private.current_company() and private.has_perm('products.write'));
create policy product_photos_delete on public.product_photos for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write')
         and exists (select 1 from public.product_master p where p.id = product_id and p.status <> 'archived'));

create policy product_documents_select on public.product_documents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
create policy product_documents_insert on public.product_documents for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('products.write')
              and exists (select 1 from public.ged_documents g where g.id = ged_document_id));      -- le document doit être visible (documents.read)
create policy product_documents_update on public.product_documents for update to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write'))
  with check (company_id = private.current_company() and private.has_perm('products.write'));
create policy product_documents_delete on public.product_documents for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write')
         and exists (select 1 from public.product_master p where p.id = product_id and p.status <> 'archived'));

create policy product_certs_select on public.product_certifications for select to authenticated
  using (company_id = private.current_company() and private.has_perm('products.read'));
create policy product_certs_insert on public.product_certifications for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('products.write')
              and (ged_document_id is null or exists (select 1 from public.ged_documents g where g.id = ged_document_id)));
create policy product_certs_update on public.product_certifications for update to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write'))
  with check (company_id = private.current_company() and private.has_perm('products.write')
              and (ged_document_id is null or exists (select 1 from public.ged_documents g where g.id = ged_document_id)));
create policy product_certs_delete on public.product_certifications for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('products.write')
         and exists (select 1 from public.product_master p where p.id = product_id and p.status <> 'archived'));

-- ---------------------------------------------------------------------
-- 8. RPC : versions, archivage, duplication, suppression, comparaison
-- ---------------------------------------------------------------------
create function public.product_new_version(p_product uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.product_master%rowtype; v_last public.product_versions%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('products.write');
  select * into v from public.product_master where id = p_product and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(p_product);
  if exists (select 1 from public.product_versions where product_id = p_product and status = 'draft') then
    raise exception 'PRODUCT_DRAFT_EXISTS' using errcode = '55000';
  end if;
  select * into v_last from public.product_versions where product_id = p_product order by version_no desc limit 1;
  insert into public.product_versions (id, company_id, client_id, product_id, version_no, spec, change_note)
  values (v_id, v.company_id, v.client_id, p_product, v_last.version_no + 1, v_last.spec, nullif(btrim(coalesce(p_note, '')), ''));
  return v_id;
end $$;

create function public.product_validate_version(p_version uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_versions%rowtype; v_p public.product_master%rowtype;
begin
  perform private.require_perm('products.validate');
  select * into v from public.product_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_p from public.product_master where id = v.product_id for update;
  perform private.product_assert_open(v.product_id);
  if v.status <> 'draft' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  if jsonb_array_length(v.spec -> 'colors') = 0 or jsonb_array_length(v.spec -> 'sizes') = 0 then
    raise exception 'PRODUCT_SPEC_INCOMPLETE' using errcode = '55000';
  end if;
  perform set_config('product.rpc', 'on', true);
  update public.product_versions set status = 'obsolete' where product_id = v.product_id and status = 'validated';
  update public.product_versions set status = 'validated', validated_by = auth.uid(), validated_at = now(),
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

create function public.product_discard_draft(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_versions%rowtype; v_p public.product_master%rowtype;
begin
  perform private.require_perm('products.write');
  select * into v from public.product_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_p from public.product_master where id = v.product_id;
  perform private.product_assert_open(v.product_id);
  if v.status <> 'draft' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  if v.version_no = 1 then raise exception 'PRODUCT_FIRST_VERSION' using errcode = '55000'; end if;
  delete from public.product_versions where id = p_version;
  perform private.write_audit(v.company_id, 'product.version_discard', 'product', v.product_id::text, v_p.code, null, null,
    private.product_meta(v.client_id, jsonb_build_object('version', v.version_no)), 'rpc');
end $$;

create function public.product_archive(p_product uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_master%rowtype;
begin
  perform private.require_perm('products.archive');
  select * into v from public.product_master where id = p_product and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.status = 'archived' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('product.rpc', 'on', true);
  update public.product_master set status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_product;
  perform set_config('product.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'product.archive', 'product', v.id::text, v.code,
    jsonb_build_object('status', v.status), jsonb_build_object('status', 'archived'), private.product_meta(v.client_id, jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), ''))), 'rpc');
end $$;

create function public.product_restore(p_product uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_master%rowtype; v_to text;
begin
  perform private.require_perm('products.archive');
  select * into v from public.product_master where id = p_product and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.status <> 'archived' then raise exception 'PRODUCT_BAD_STATUS' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(v.client_id);
  v_to := case when v.active_version_id is not null then 'active' else 'draft' end;
  perform set_config('product.rpc', 'on', true);
  update public.product_master set status = v_to, archived_at = null, archived_by = null, archive_reason = null where id = p_product;
  perform set_config('product.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'product.restore', 'product', v.id::text, v.code,
    jsonb_build_object('status', 'archived'), jsonb_build_object('status', v_to), private.product_meta(v.client_id), 'rpc');
end $$;

-- Duplication : nouveau produit (nouveau code), version 1 = copie de la dernière version, SKU re-préfixés.
-- Ne copie ni photos, ni documents, ni certifications (propres à chaque produit), ni le lien article.
create function public.product_duplicate(p_product uuid, p_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.product_master%rowtype; v_ver public.product_versions%rowtype; v_new public.product_master%rowtype; v_spec jsonb;
begin
  perform private.require_perm('products.write');
  select * into v from public.product_master where id = p_product and company_id = private.current_company();
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v.client_id);
  select * into v_ver from public.product_versions where id = v.current_version_id;
  insert into public.product_master (client_id, name, family, description)
  values (v.client_id, coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Copie de ' || v.name), v.family, v.description)
  returning * into v_new;
  v_spec := jsonb_set(v_ver.spec, '{variants}', coalesce((
    select jsonb_agg(jsonb_set(x, '{sku}', to_jsonb(replace(upper(x ->> 'sku'), v.code, v_new.code))))
    from jsonb_array_elements(v_ver.spec -> 'variants') x), '[]'::jsonb));
  perform set_config('product.rpc', 'on', true); perform set_config('product.dup', 'on', true);
  update public.product_master set duplicated_from = v.id where id = v_new.id;
  update public.product_versions set spec = v_spec, change_note = 'Copie de ' || v.code || ' v' || v_ver.version_no where product_id = v_new.id and version_no = 1;
  perform set_config('product.rpc', 'off', true); perform set_config('product.dup', 'off', true);
  perform private.write_audit(v.company_id, 'product.duplicate', 'product', v.id::text, v.code, null, null,
    private.product_meta(v.client_id, jsonb_build_object('new_code', v_new.code, 'new_id', v_new.id, 'from_version', v_ver.version_no)), 'rpc');
  perform private.write_audit(v.company_id, 'product.duplicated_from', 'product', v_new.id::text, v_new.code, null, null,
    private.product_meta(v.client_id, jsonb_build_object('source_code', v.code, 'source_id', v.id, 'from_version', v_ver.version_no)), 'rpc');
  return v_new.id;
end $$;

-- Suppression : produit jamais validé uniquement. Renvoie les photos à effacer du Storage.
create function public.product_delete(p_product uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.product_master%rowtype; v_files jsonb;
begin
  perform private.require_perm('products.write');
  select * into v from public.product_master where id = p_product and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.product_assert_open(p_product);
  if v.status <> 'draft' or exists (select 1 from public.product_versions where product_id = p_product and status in ('validated','obsolete')) then
    raise exception 'PRODUCT_IN_USE' using errcode = '23503';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', 'product-photos', 'path', storage_path)), '[]'::jsonb) into v_files from public.product_photos where product_id = p_product;
  perform set_config('product.rpc', 'on', true);
  update public.product_master set current_version_id = null, active_version_id = null, main_photo_id = null where id = p_product;
  delete from public.product_master where id = p_product;
  perform set_config('product.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'product.delete', 'product', v.id::text, v.code,
    jsonb_build_object('code', v.code, 'name', v.name), null, private.product_meta(v.client_id), 'rpc');
  return v_files;
end $$;

-- ---- Comparaison de versions ---------------------------------------
create function private.product_flatten_obj(p_prefix text, o jsonb) returns table (path text, val jsonb)
language plpgsql immutable set search_path = '' as $$
declare f record;
begin
  for f in select key, value from jsonb_each(coalesce(o, '{}'::jsonb)) loop
    if jsonb_typeof(f.value) = 'object' then
      return query select * from private.product_flatten_obj(p_prefix || '.' || f.key, f.value);
    elsif jsonb_typeof(f.value) = 'null' or f.value = '""'::jsonb then
      null;                                           -- vide = absent : pas de bruit dans la comparaison
    else
      return query select p_prefix || '.' || f.key, f.value;
    end if;
  end loop;
end $$;

create function private.product_flatten(p jsonb) returns table (path text, val jsonb)
language plpgsql immutable set search_path = '' as $$
declare s text; k record; e jsonb; f record; ident text;
begin
  foreach s in array array['header', 'tech', 'care', 'packaging'] loop
    return query select * from private.product_flatten_obj(s, p -> s);
  end loop;
  for k in select * from (values ('colors','name'), ('sizes','label'), ('variants','sku'), ('measurements','point'), ('certifications','key'), ('documents','key')) v(list, idf) loop
    for e in select * from jsonb_array_elements(coalesce(p -> k.list, '[]'::jsonb)) loop
      ident := e ->> k.idf;
      return query select k.list || '[' || ident || ']', 'true'::jsonb;
      for f in select key, value from jsonb_each(e) where key <> k.idf loop
        if jsonb_typeof(f.value) = 'object' then
          return query select * from private.product_flatten_obj(k.list || '[' || ident || '].' || f.key, f.value);
        elsif jsonb_typeof(f.value) <> 'null' and f.value <> '""'::jsonb then
          return query select k.list || '[' || ident || '].' || f.key, f.value;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

create function public.product_compare_versions(p_a uuid, p_b uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare va public.product_versions%rowtype; vb public.product_versions%rowtype; sa jsonb; sb jsonb; v_changes jsonb;
  v_order constant text[] := array['header','tech','colors','sizes','variants','measurements','care','packaging','certifications','documents'];
begin
  perform private.require_perm('products.read');
  select * into va from public.product_versions where id = p_a and company_id = private.current_company();
  select * into vb from public.product_versions where id = p_b and company_id = private.current_company();
  if va.id is null or vb.id is null then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if va.product_id <> vb.product_id then raise exception 'PRODUCT_COMPARE_MISMATCH' using errcode = '22023'; end if;
  sa := coalesce(va.snapshot, case when va.status = 'draft' then private.product_snapshot(va.product_id) else '{}'::jsonb end);
  sb := coalesce(vb.snapshot, case when vb.status = 'draft' then private.product_snapshot(vb.product_id) else '{}'::jsonb end);
  sa := va.spec || jsonb_build_object('header', sa -> 'header', 'certifications', sa -> 'certifications', 'documents', sa -> 'documents');
  sb := vb.spec || jsonb_build_object('header', sb -> 'header', 'certifications', sb -> 'certifications', 'documents', sb -> 'documents');

  with fa as (select * from private.product_flatten(sa)), fb as (select * from private.product_flatten(sb)),
  d as (
    select coalesce(fa.path, fb.path) as path, fa.val as a, fb.val as b,
           case when fa.path is null then 'added' when fb.path is null then 'removed' else 'changed' end as change
    from fa full join fb on fa.path = fb.path
    where fa.val is distinct from fb.val
  ), f as (
    select d.*, regexp_replace(d.path, '[.\[].*$', '') as section, substring(d.path from '^[^\]]*\]') as elem from d
  )
  select coalesce(jsonb_agg(jsonb_build_object('section', f.section, 'path', f.path, 'a', f.a, 'b', f.b, 'change', f.change)
         order by array_position(v_order, f.section), f.path), '[]'::jsonb) into v_changes
  from f
  where f.elem is null or f.path = f.elem
     or (exists (select 1 from fa where fa.path = f.elem) and exists (select 1 from fb where fb.path = f.elem));

  return jsonb_build_object(
    'a', jsonb_build_object('id', va.id, 'version_no', va.version_no, 'status', va.status, 'validated_at', va.validated_at, 'change_note', va.change_note),
    'b', jsonb_build_object('id', vb.id, 'version_no', vb.version_no, 'status', vb.status, 'validated_at', vb.validated_at, 'change_note', vb.change_note),
    'changes', v_changes,
    'summary', jsonb_build_object(
      'added',   (select count(*) from jsonb_array_elements(v_changes) x where x ->> 'change' = 'added'),
      'removed', (select count(*) from jsonb_array_elements(v_changes) x where x ->> 'change' = 'removed'),
      'changed', (select count(*) from jsonb_array_elements(v_changes) x where x ->> 'change' = 'changed')));
end $$;

do $$
declare f text;
begin
  foreach f in array array['product_new_version(uuid,text)', 'product_validate_version(uuid,text)', 'product_discard_draft(uuid)', 'product_archive(uuid,text)',
                           'product_restore(uuid)', 'product_duplicate(uuid,text)', 'product_delete(uuid)', 'product_compare_versions(uuid,uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.product_flatten_obj(text, jsonb), private.product_flatten(jsonb), private.product_flag() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 9. Storage : bucket privé `product-photos` (8 Mo, images)   chemin : <company>/<client>/<produit>/<uuid>-<fichier>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy product_photos_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'product-photos' and private.has_perm('products.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2]));
create policy product_photos_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-photos' and private.has_perm('products.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2], true));
-- Pas de politique DELETE : suppression via l'application (service_role) après autorisation en base.
