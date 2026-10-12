-- =====================================================================
-- 0007_articles — Module Articles Client
--  Article d'un client : référence client (ex. LAF-HV-JKT-2027) + référence interne (ex. JKT001),
--  versions de la fiche (couleurs, tailles, normes, packaging, lavage) avec validation,
--  photos (Storage), relation avec la GED, historique (audit_logs, entity_type = 'article').
--  Permissions existantes : articles.read / articles.write / articles.validate
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Droits par défaut : commercial et production saisissent, qualité valide
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
     (r.code in ('commercial', 'production') and p.code = 'articles.write')
  or (r.code = 'qualite' and p.code = 'articles.validate')
where r.is_system
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Validation de la structure d'une fiche (spec JSON)
--    { colors:[{name,code?,hex?,pantone?,client_code?}], sizes:[{label,client_code?}],
--      norms:[{code,label?,class?,certificate_ref?,valid_until?}], packaging:{…}, care:{…} }
-- ---------------------------------------------------------------------
create function private.article_spec_valid(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare e jsonb;
begin
  if coalesce(jsonb_typeof(s), '') <> 'object' then return false; end if;
  if coalesce(jsonb_typeof(s -> 'colors'), '') <> 'array' or jsonb_array_length(s -> 'colors') > 60 then return false; end if;
  if coalesce(jsonb_typeof(s -> 'sizes'), '') <> 'array' or jsonb_array_length(s -> 'sizes') > 40 then return false; end if;
  if coalesce(jsonb_typeof(s -> 'norms'), '') <> 'array' or jsonb_array_length(s -> 'norms') > 30 then return false; end if;
  if coalesce(jsonb_typeof(s -> 'packaging'), '') <> 'object' or coalesce(jsonb_typeof(s -> 'care'), '') <> 'object' then return false; end if;

  for e in select * from jsonb_array_elements(s -> 'colors') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'name', '')), '') is null or length(e ->> 'name') > 60 then return false; end if;
    if nullif(e ->> 'hex', '') is not null and (e ->> 'hex') !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
  end loop;
  for e in select * from jsonb_array_elements(s -> 'sizes') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'label', '')), '') is null or length(e ->> 'label') > 12 then return false; end if;
  end loop;
  for e in select * from jsonb_array_elements(s -> 'norms') loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'code', '')), '') is null or length(e ->> 'code') > 60 then return false; end if;
  end loop;
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
create table public.articles (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  client_id          uuid not null references public.clients(id),      -- RESTRICT : un client avec articles ne se supprime pas
  internal_ref       text not null,                                    -- ex. JKT001
  client_ref         text not null check (length(btrim(client_ref)) between 1 and 60),   -- ex. LAF-HV-JKT-2027
  name               text not null check (length(btrim(name)) between 2 and 160),
  family             text not null default 'other' check (family in ('jacket','trousers','coverall','polo','tshirt','vest','parka','shirt','apron','accessory','other')),
  description        text,
  status             text not null default 'draft' check (status in ('draft','active','discontinued')),
  current_version_id uuid,       -- dernière version (brouillon ou validée)
  active_version_id  uuid,       -- dernière version VALIDÉE (celle utilisée en production)
  norm_codes         text[] not null default '{}',     -- copie des normes de la dernière version (filtres)
  main_photo_id      uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  unique (company_id, internal_ref)
);
create unique index articles_client_ref_uq on public.articles (client_id, lower(btrim(client_ref)));
create index articles_client_idx on public.articles (client_id, status);
create index articles_norms_idx  on public.articles using gin (norm_codes);

create table public.article_versions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  client_id          uuid not null references public.clients(id) on delete cascade,
  article_id         uuid not null references public.articles(id) on delete cascade,
  version_no         int  not null check (version_no >= 1),
  status             text not null default 'draft' check (status in ('draft','validated','obsolete')),
  spec               jsonb not null default '{"colors":[],"sizes":[],"norms":[],"packaging":{},"care":{}}'::jsonb,
  change_note        text,
  validated_by       uuid,
  validated_at       timestamptz,
  validation_comment text,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (article_id, version_no),
  constraint article_versions_spec_ck check (private.article_spec_valid(spec))
);
create unique index article_versions_one_draft_uq on public.article_versions (article_id) where status = 'draft';

alter table public.articles
  add constraint articles_current_version_fk foreign key (current_version_id) references public.article_versions(id) deferrable initially deferred,
  add constraint articles_active_version_fk  foreign key (active_version_id)  references public.article_versions(id) deferrable initially deferred;

create table public.article_photos (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  client_id    uuid not null references public.clients(id) on delete cascade,
  article_id   uuid not null references public.articles(id) on delete cascade,
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  size_bytes   bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  view         text not null default 'front' check (view in ('front','back','side','detail','label','packaging','other')),
  caption      text check (caption is null or length(caption) <= 200),
  is_main      boolean not null default false,
  uploaded_by  uuid,
  created_at   timestamptz not null default now()
);
create index article_photos_idx on public.article_photos (article_id, created_at);
create unique index article_photos_main_uq on public.article_photos (article_id) where is_main;

-- ---------------------------------------------------------------------
-- 4. Relation avec la GED : un document peut être rattaché à un article du même client
-- ---------------------------------------------------------------------
alter table public.ged_documents add column article_id uuid references public.articles(id) on delete set null;
create index ged_documents_article_idx on public.ged_documents (article_id) where article_id is not null;
grant update (article_id) on public.ged_documents to authenticated;

create or replace function private.ged_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_folder public.ged_folders%rowtype;
begin
  if tg_op = 'INSERT' then
    perform private.ged_assert_client_open(new.client_id);
    select company_id into new.company_id from public.clients where id = new.client_id;
    new.created_by := coalesce(new.created_by, auth.uid()); new.updated_by := new.created_by;
  else
    if new.client_id is distinct from old.client_id or new.company_id is distinct from old.company_id then
      raise exception 'GED_BAD_PARENT' using errcode = '22023';
    end if;
    if coalesce(current_setting('clients.rpc', true), 'off') <> 'on' then
      perform private.ged_assert_client_open(new.client_id);
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  select * into v_folder from public.ged_folders where id = new.folder_id;
  if not found or v_folder.client_id <> new.client_id then raise exception 'GED_BAD_FOLDER' using errcode = '22023'; end if;
  if new.article_id is not null and (tg_op = 'INSERT' or new.article_id is distinct from old.article_id) then
    if not exists (select 1 from public.articles a where a.id = new.article_id and a.client_id = new.client_id) then
      raise exception 'GED_BAD_ARTICLE' using errcode = '22023';     -- l'article doit appartenir au même client
    end if;
  end if;
  new.title := btrim(new.title);
  new.tags := coalesce((select array_agg(distinct t) from (select lower(btrim(x)) t from unnest(new.tags) x) s where t <> '' and length(t) <= 30), '{}');
  if cardinality(new.tags) > 10 then raise exception 'GED_TOO_MANY_TAGS' using errcode = '22023'; end if;
  return new;
end $$;

create or replace function private.audit_ged_documents() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_track constant text[] := array['title','description','tags','valid_until','folder_id'];
  v_action text; v_chg jsonb; v_extra jsonb := '{}'::jsonb;
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'ged.create', 'document', new.id::text, new.title, null, null,
      private.ged_meta(new.client_id, jsonb_build_object('folder', (select name from public.ged_folders where id = new.folder_id))));
    return new;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then v_action := 'ged.trash';
  elsif old.deleted_at is not null and new.deleted_at is null then v_action := 'ged.restore';
  elsif old.status is distinct from new.status then
    v_action := case
      when new.status = 'pending_review' then 'ged.submit'
      when new.status = 'validated' then 'ged.validate'
      when new.status = 'rejected' then 'ged.reject'
      when old.status = 'validated' and new.status = 'draft' then 'ged.invalidate'
      else 'ged.status' end;
    if new.status in ('validated','rejected') then v_extra := jsonb_build_object('comment', new.validation_comment, 'version', (select version_no from public.ged_document_versions where id = new.validated_version_id)); end if;
  end if;
  if v_action is not null then
    perform private.write_audit(new.company_id, v_action, 'document', new.id::text, new.title, null, null, private.ged_meta(new.client_id, v_extra));
  end if;

  if old.folder_id is distinct from new.folder_id then
    perform private.write_audit(new.company_id, 'ged.move', 'document', new.id::text, new.title,
      jsonb_build_object('folder', (select name from public.ged_folders where id = old.folder_id)),
      jsonb_build_object('folder', (select name from public.ged_folders where id = new.folder_id)),
      private.ged_meta(new.client_id));
  end if;

  -- rattachement à un article : tracé côté document ET côté article
  if old.article_id is distinct from new.article_id then
    perform private.write_audit(new.company_id, 'ged.link_article', 'document', new.id::text, new.title, null, null,
      private.ged_meta(new.client_id, jsonb_build_object(
        'article_from', (select internal_ref from public.articles where id = old.article_id),
        'article_to',   (select internal_ref from public.articles where id = new.article_id))));
    if new.article_id is not null then
      perform private.write_audit(new.company_id, 'article.document_link', 'article', new.article_id::text,
        (select internal_ref from public.articles where id = new.article_id), null, null,
        private.ged_meta(new.client_id, jsonb_build_object('document', new.title, 'document_id', new.id)));
    end if;
    if old.article_id is not null then
      perform private.write_audit(new.company_id, 'article.document_unlink', 'article', old.article_id::text,
        (select internal_ref from public.articles where id = old.article_id), null, null,
        private.ged_meta(new.client_id, jsonb_build_object('document', new.title, 'document_id', new.id)));
    end if;
  end if;

  v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where not (k = any (c_track))) || array['folder_id']);
  if v_chg -> 'after' <> '{}'::jsonb then
    perform private.write_audit(new.company_id, 'ged.update', 'document', new.id::text, new.title,
      v_chg -> 'before', v_chg -> 'after', private.ged_meta(new.client_id));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 5. Triggers de cohérence
-- ---------------------------------------------------------------------
-- Recalcule dernière version + normes de l'article
create function private.article_refresh(p_article uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ver public.article_versions%rowtype; v_active uuid;
begin
  select * into v_ver from public.article_versions where article_id = p_article order by version_no desc limit 1;
  select id into v_active from public.article_versions where article_id = p_article and status = 'validated' limit 1;
  perform set_config('articles.rpc', 'on', true);
  update public.articles set
    current_version_id = v_ver.id,
    active_version_id  = v_active,
    norm_codes = coalesce((select array_agg(distinct upper(btrim(n ->> 'code'))) from jsonb_array_elements(coalesce(v_ver.spec -> 'norms', '[]'::jsonb)) n), '{}')
  where id = p_article;
  perform set_config('articles.rpc', 'off', true);
end $$;
revoke execute on function private.article_refresh(uuid) from public, anon, authenticated;

create function private.articles_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    perform private.ged_assert_client_open(new.client_id);
    select company_id into new.company_id from public.clients where id = new.client_id;
    if nullif(btrim(coalesce(new.internal_ref, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'article');
      new.internal_ref := 'ART' || lpad(v_n::text, 4, '0');
    else
      new.internal_ref := upper(btrim(new.internal_ref));
    end if;
    if new.internal_ref !~ '^[A-Z0-9][A-Z0-9_-]{1,29}$' then raise exception 'ARTICLE_INVALID_REF' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.status := 'draft'; new.current_version_id := null; new.active_version_id := null; new.norm_codes := '{}'; new.main_photo_id := null;
  else
    if coalesce(current_setting('articles.rpc', true), 'off') <> 'on' then
      if new.client_id is distinct from old.client_id or new.company_id is distinct from old.company_id or new.internal_ref is distinct from old.internal_ref then
        raise exception 'ARTICLE_REF_LOCKED' using errcode = '42501';
      end if;
      perform private.ged_assert_client_open(new.client_id);
      new.updated_at := now(); new.updated_by := auth.uid();
    end if;
    if new.status = 'active' and old.status <> 'active' and new.active_version_id is null then
      raise exception 'ARTICLE_NO_VALIDATED_VERSION' using errcode = '55000';
    end if;
  end if;
  new.client_ref := btrim(new.client_ref);
  new.name := btrim(new.name);
  return new;
end $$;
create trigger articles_before_iu before insert or update on public.articles
  for each row execute function private.articles_before();

-- Chaque article reçoit sa version 1 (brouillon)
create function private.articles_seed_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  perform set_config('articles.rpc', 'on', true);
  insert into public.article_versions (id, company_id, client_id, article_id, version_no, change_note)
  values (v_id, new.company_id, new.client_id, new.id, 1, 'Création de l''article');
  perform set_config('articles.rpc', 'off', true);
  perform private.article_refresh(new.id);
  return new;
end $$;
create trigger articles_seed_version_i after insert on public.articles
  for each row execute function private.articles_seed_version();

create function private.article_versions_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_art public.articles%rowtype; v_rpc boolean := coalesce(current_setting('articles.rpc', true), 'off') = 'on';
begin
  if tg_op = 'INSERT' then
    select * into v_art from public.articles where id = new.article_id;
    if not found then raise exception 'ARTICLE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := v_art.company_id; new.client_id := v_art.client_id;
    new.status := 'draft'; new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.validated_by := null; new.validated_at := null; new.validation_comment := null;
  else
    if not v_rpc then
      perform private.ged_assert_client_open(new.client_id);
      if new.article_id is distinct from old.article_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at then
        raise exception 'ARTICLE_VERSION_LOCKED' using errcode = '42501';
      end if;
      -- une version validée (ou obsolète) est figée
      if old.status <> 'draft' and (new.spec is distinct from old.spec or new.change_note is distinct from old.change_note) then
        raise exception 'ARTICLE_VERSION_LOCKED' using errcode = '55000';
      end if;
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger article_versions_before_iu before insert or update on public.article_versions
  for each row execute function private.article_versions_before();

create function private.article_versions_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.article_refresh(coalesce(new.article_id, old.article_id));
  return coalesce(new, old);
end $$;
create trigger article_versions_after_iud after insert or update of spec, status or delete on public.article_versions
  for each row execute function private.article_versions_after();

create function private.article_photos_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_art public.articles%rowtype;
begin
  select * into v_art from public.articles where id = new.article_id;
  if not found then raise exception 'ARTICLE_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v_art.client_id);
  new.company_id := v_art.company_id; new.client_id := v_art.client_id;
  if tg_op = 'INSERT' then
    if new.storage_path not like v_art.company_id::text || '/' || v_art.client_id::text || '/' || v_art.id::text || '/%' then
      raise exception 'ARTICLE_INVALID_PATH' using errcode = '22023';
    end if;
    if (select count(*) from public.article_photos where article_id = new.article_id) >= 20 then
      raise exception 'ARTICLE_TOO_MANY_PHOTOS' using errcode = '22023';
    end if;
    new.uploaded_by := auth.uid();
    if not exists (select 1 from public.article_photos where article_id = new.article_id) then new.is_main := true; end if;
  else
    if new.storage_path is distinct from old.storage_path or new.article_id is distinct from old.article_id then
      raise exception 'ARTICLE_INVALID_PATH' using errcode = '22023';
    end if;
  end if;
  if new.is_main then
    update public.article_photos set is_main = false where article_id = new.article_id and id is distinct from new.id and is_main;
  end if;
  return new;
end $$;
create trigger article_photos_before_iu before insert or update on public.article_photos
  for each row execute function private.article_photos_before();

create function private.article_photos_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_article uuid := coalesce(new.article_id, old.article_id);
begin
  if tg_op = 'DELETE' and old.is_main and coalesce(current_setting('articles.rpc', true), 'off') <> 'on' then
    update public.article_photos set is_main = true
    where id = (select id from public.article_photos where article_id = v_article order by created_at limit 1);   -- promeut la plus ancienne
  end if;
  perform set_config('articles.rpc', 'on', true);
  update public.articles set main_photo_id = (select id from public.article_photos where article_id = v_article and is_main limit 1) where id = v_article;
  perform set_config('articles.rpc', 'off', true);
  return coalesce(new, old);
end $$;
create trigger article_photos_after_iud after insert or update of is_main or delete on public.article_photos
  for each row execute function private.article_photos_after();

-- ---------------------------------------------------------------------
-- 6. Historique
-- ---------------------------------------------------------------------
create function private.article_meta(p_client uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('client_id', p_client, 'client_name', (select name from public.clients where id = p_client)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.article_meta(uuid, jsonb) from public, anon, authenticated;

create function private.audit_articles() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_track constant text[] := array['client_ref','name','family','description','status'];
  v_chg jsonb;
begin
  if coalesce(current_setting('articles.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'article.create', 'article', new.id::text, new.internal_ref, null,
      jsonb_build_object('internal_ref', new.internal_ref, 'client_ref', new.client_ref, 'name', new.name, 'family', new.family),
      private.article_meta(new.client_id));
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where not (k = any (c_track))));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'article.update', 'article', new.id::text, new.internal_ref, v_chg -> 'before', v_chg -> 'after', private.article_meta(new.client_id));
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_articles_iu after insert or update on public.articles
  for each row execute function private.audit_articles();

create function private.audit_article_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref text; v_chg jsonb;
begin
  select internal_ref into v_ref from public.articles where id = new.article_id;
  if tg_op = 'UPDATE' and old.status = new.status and new.spec is distinct from old.spec then
    v_chg := private.jsonb_changes(old.spec, new.spec, '{}');
    perform private.write_audit(new.company_id, 'article.spec_update', 'article', new.article_id::text, v_ref, v_chg -> 'before', v_chg -> 'after',
      private.article_meta(new.client_id, jsonb_build_object('version', new.version_no)));
  elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'validated' then
    perform private.write_audit(new.company_id, 'article.version_validate', 'article', new.article_id::text, v_ref, null, null,
      private.article_meta(new.client_id, jsonb_build_object('version', new.version_no, 'comment', new.validation_comment)));
  elsif tg_op = 'INSERT' and new.version_no > 1 then
    perform private.write_audit(new.company_id, 'article.version_new', 'article', new.article_id::text, v_ref, null, null,
      private.article_meta(new.client_id, jsonb_build_object('version', new.version_no, 'note', new.change_note)));
  end if;
  return new;
end $$;
create trigger audit_article_versions_iu after insert or update on public.article_versions
  for each row execute function private.audit_article_versions();

create function private.audit_article_photos() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row public.article_photos%rowtype; v_ref text;
begin
  if coalesce(current_setting('articles.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  v_row := case when tg_op = 'DELETE' then old else new end;
  select internal_ref into v_ref from public.articles where id = v_row.article_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(v_row.company_id, 'article.photo_add', 'article', v_row.article_id::text, v_ref, null, null,
      private.article_meta(v_row.client_id, jsonb_build_object('file_name', v_row.file_name, 'view', v_row.view)));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(v_row.company_id, 'article.photo_delete', 'article', v_row.article_id::text, v_ref, null, null,
      private.article_meta(v_row.client_id, jsonb_build_object('file_name', v_row.file_name)));
  elsif old.is_main = false and new.is_main = true then
    perform private.write_audit(v_row.company_id, 'article.photo_main', 'article', v_row.article_id::text, v_ref, null, null,
      private.article_meta(v_row.client_id, jsonb_build_object('file_name', v_row.file_name)));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_article_photos_iud after insert or update or delete on public.article_photos
  for each row execute function private.audit_article_photos();

create policy audit_logs_select_articles on public.audit_logs for select to authenticated
  using (entity_type = 'article' and company_id = private.current_company() and private.has_perm('articles.read'));

-- ---------------------------------------------------------------------
-- 7. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.articles         enable row level security;
alter table public.article_versions enable row level security;
alter table public.article_photos   enable row level security;

revoke all on public.articles, public.article_versions, public.article_photos from anon, authenticated;
grant all on public.articles, public.article_versions, public.article_photos to service_role;
grant select on public.articles, public.article_versions, public.article_photos to authenticated;
grant insert (client_id, internal_ref, client_ref, name, family, description) on public.articles to authenticated;
grant update (client_ref, name, family, description, status) on public.articles to authenticated;
grant update (spec, change_note) on public.article_versions to authenticated;
grant insert (article_id, storage_path, file_name, mime_type, size_bytes, view, caption, is_main) on public.article_photos to authenticated;
grant update (view, caption, is_main) on public.article_photos to authenticated;
grant delete on public.article_photos to authenticated;

create policy articles_select on public.articles for select to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.read'));
create policy articles_insert on public.articles for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('articles.write'));
create policy articles_update on public.articles for update to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.write'))
  with check (company_id = private.current_company() and private.has_perm('articles.write'));

create policy article_versions_select on public.article_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.read'));
create policy article_versions_update on public.article_versions for update to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.write') and status = 'draft')
  with check (company_id = private.current_company() and private.has_perm('articles.write'));

create policy article_photos_select on public.article_photos for select to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.read'));
create policy article_photos_insert on public.article_photos for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('articles.write'));
create policy article_photos_update on public.article_photos for update to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.write'))
  with check (company_id = private.current_company() and private.has_perm('articles.write'));
create policy article_photos_delete on public.article_photos for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('articles.write'));

-- ---------------------------------------------------------------------
-- 8. RPC : nouvelle version, validation, abandon du brouillon, suppression
-- ---------------------------------------------------------------------
create function public.article_new_version(p_article uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_art public.articles%rowtype; v_last public.article_versions%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('articles.write');
  select * into v_art from public.articles where id = p_article and company_id = private.current_company() for update;
  if not found then raise exception 'ARTICLE_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v_art.client_id);
  if exists (select 1 from public.article_versions where article_id = p_article and status = 'draft') then
    raise exception 'ARTICLE_DRAFT_EXISTS' using errcode = '55000';
  end if;
  select * into v_last from public.article_versions where article_id = p_article order by version_no desc limit 1;
  insert into public.article_versions (id, company_id, client_id, article_id, version_no, spec, change_note)
  values (v_id, v_art.company_id, v_art.client_id, p_article, v_last.version_no + 1, v_last.spec, nullif(btrim(coalesce(p_note, '')), ''));
  return v_id;
end $$;

create function public.article_validate_version(p_version uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.article_versions%rowtype; v_art public.articles%rowtype;
begin
  perform private.require_perm('articles.validate');
  select * into v from public.article_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'ARTICLE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_art from public.articles where id = v.article_id for update;
  perform private.ged_assert_client_open(v.client_id);
  if v.status <> 'draft' then raise exception 'ARTICLE_BAD_STATUS' using errcode = '55000'; end if;
  if jsonb_array_length(v.spec -> 'colors') = 0 or jsonb_array_length(v.spec -> 'sizes') = 0 then
    raise exception 'ARTICLE_SPEC_INCOMPLETE' using errcode = '55000';     -- au moins une couleur et une taille
  end if;

  perform set_config('articles.rpc', 'on', true);
  update public.article_versions set status = 'obsolete' where article_id = v.article_id and status = 'validated';
  perform set_config('articles.rpc', 'off', true);
  perform set_config('articles.rpc', 'on', true);
  update public.article_versions set status = 'validated', validated_by = auth.uid(), validated_at = now(),
         validation_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_version;
  perform set_config('articles.rpc', 'off', true);
  perform private.article_refresh(v.article_id);   -- (la validation est tracée par le trigger d'audit des versions)
  if v_art.status = 'draft' then
    perform set_config('articles.rpc', 'on', true);
    update public.articles set status = 'active' where id = v.article_id;      -- première validation : l'article devient actif
    perform set_config('articles.rpc', 'off', true);
    perform private.write_audit(v.company_id, 'article.update', 'article', v.article_id::text, v_art.internal_ref,
      jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'active'), private.article_meta(v.client_id), 'rpc');
  end if;
end $$;

create function public.article_discard_draft(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.article_versions%rowtype; v_art public.articles%rowtype;
begin
  perform private.require_perm('articles.write');
  select * into v from public.article_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'ARTICLE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_art from public.articles where id = v.article_id;
  perform private.ged_assert_client_open(v.client_id);
  if v.status <> 'draft' then raise exception 'ARTICLE_BAD_STATUS' using errcode = '55000'; end if;
  if v.version_no = 1 then raise exception 'ARTICLE_FIRST_VERSION' using errcode = '55000'; end if;
  delete from public.article_versions where id = p_version;
  perform private.write_audit(v.company_id, 'article.version_discard', 'article', v.article_id::text, v_art.internal_ref, null, null,
    private.article_meta(v.client_id, jsonb_build_object('version', v.version_no)), 'rpc');
end $$;

-- Suppression : article jamais validé (aucune version utilisée en production). Renvoie les photos à effacer du Storage.
create function public.article_delete(p_article uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.articles%rowtype; v_files jsonb;
begin
  perform private.require_perm('articles.write');
  select * into v from public.articles where id = p_article and company_id = private.current_company() for update;
  if not found then raise exception 'ARTICLE_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v.client_id);
  if v.status <> 'draft' or exists (select 1 from public.article_versions where article_id = p_article and status in ('validated','obsolete')) then
    raise exception 'ARTICLE_IN_USE' using errcode = '23503';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', 'article-photos', 'path', storage_path)), '[]'::jsonb) into v_files
  from public.article_photos where article_id = p_article;
  perform set_config('articles.rpc', 'on', true);
  delete from public.articles where id = p_article;
  perform set_config('articles.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'article.delete', 'article', v.id::text, v.internal_ref,
    jsonb_build_object('internal_ref', v.internal_ref, 'client_ref', v.client_ref, 'name', v.name), null, private.article_meta(v.client_id), 'rpc');
  return v_files;
end $$;

do $$
declare f text;
begin
  foreach f in array array['article_new_version(uuid,text)', 'article_validate_version(uuid,text)', 'article_discard_draft(uuid)', 'article_delete(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Storage : bucket privé `article-photos` (8 Mo, images)
--    chemin : <company>/<client>/<article>/<uuid>-<fichier>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('article-photos', 'article-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy article_photos_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'article-photos' and private.has_perm('articles.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2]));
create policy article_photos_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'article-photos' and private.has_perm('articles.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2], true));
-- Pas de politique DELETE : suppression via l'application (service_role) après autorisation en base.
