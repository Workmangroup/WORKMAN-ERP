-- =====================================================================
-- 0005_ged — Gestion électronique des documents (GED)
--  * espace documentaire automatique par client : 9 dossiers système
--  * documents, versions immuables, commentaires, validation, corbeille
--  * historique complet (audit_logs), Storage privé (bucket `ged`)
--  * remplace client_documents (données migrées dans la GED)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('documents.validate', 'ged', 'Valider les documents',        'Valider ou rejeter un document soumis'),
  ('documents.delete',   'ged', 'Supprimer définitivement',     'Vider la corbeille, supprimer un document validé')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

update public.permissions set label = 'Voir les documents',   description = 'Consulter, prévisualiser, télécharger, commenter' where code = 'documents.read';
update public.permissions set label = 'Gérer les documents',  description = 'Déposer, versionner, modifier, déplacer, mettre à la corbeille' where code = 'documents.write';

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
     (r.code = 'admin'      and p.code in ('documents.validate', 'documents.delete'))
  or (r.code = 'direction'  and p.code = 'documents.validate')
  or (r.code = 'qualite'    and p.code = 'documents.validate')
  or (r.code = 'commercial' and p.code = 'documents.write')
  or (r.code = 'finance'    and p.code in ('documents.read', 'documents.write'))
where r.is_system
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.ged_folders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
  parent_id   uuid references public.ged_folders(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 80 and name !~ '[/\\]'),
  system_key  text check (system_key in ('contracts','orders','invoices','bat','patterns','certifications','logos','correspondence','quality')),
  sort_order  int not null default 100,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create unique index ged_folders_system_uq on public.ged_folders (client_id, system_key) where system_key is not null;
create unique index ged_folders_name_uq on public.ged_folders
  (client_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
create index ged_folders_client_idx on public.ged_folders (client_id, parent_id);

create table public.ged_documents (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id),
  client_id            uuid not null references public.clients(id) on delete cascade,
  folder_id            uuid not null references public.ged_folders(id) on delete cascade,
  title                text not null check (length(btrim(title)) between 2 and 160),
  description          text,
  tags                 text[] not null default '{}',
  valid_until          date,
  status               text not null default 'draft' check (status in ('draft','pending_review','validated','rejected')),
  validated_by         uuid,
  validated_at         timestamptz,
  validated_version_id uuid,
  validation_comment   text,
  current_version_id   uuid,
  version_count        int not null default 0,
  file_name            text,            -- copie de la version courante (listes, recherche)
  mime_type            text,
  size_bytes           bigint,
  sha256               text,
  deleted_at           timestamptz,
  deleted_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid
);
create index ged_documents_client_idx  on public.ged_documents (client_id, folder_id) where deleted_at is null;
create index ged_documents_trash_idx   on public.ged_documents (client_id, deleted_at) where deleted_at is not null;
create index ged_documents_status_idx  on public.ged_documents (company_id, status) where deleted_at is null;
create index ged_documents_expiry_idx  on public.ged_documents (company_id, valid_until) where deleted_at is null;
create index ged_documents_tags_idx    on public.ged_documents using gin (tags);
create index ged_documents_sha_idx     on public.ged_documents (client_id, sha256) where sha256 is not null;

create table public.ged_document_versions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  client_id      uuid not null references public.clients(id) on delete cascade,
  document_id    uuid not null references public.ged_documents(id) on delete cascade,
  version_no     int  not null check (version_no >= 1),
  storage_bucket text not null default 'ged' check (storage_bucket in ('ged','client-docs')),
  storage_path   text not null,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),
  sha256         text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  change_note    text,
  uploaded_by    uuid,
  created_at     timestamptz not null default now(),
  unique (document_id, version_no)
);
create index ged_versions_doc_idx on public.ged_document_versions (document_id, version_no desc);

alter table public.ged_documents
  add constraint ged_documents_current_version_fk foreign key (current_version_id)
  references public.ged_document_versions(id) deferrable initially deferred;

create table public.ged_comments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
  document_id uuid not null references public.ged_documents(id) on delete cascade,
  author_id   uuid not null,
  body        text not null check (length(btrim(body)) between 1 and 2000),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid
);
create index ged_comments_doc_idx on public.ged_comments (document_id, created_at);

-- ---------------------------------------------------------------------
-- 3. Dossiers système : créés automatiquement avec chaque client
-- ---------------------------------------------------------------------
create function private.ged_seed_folders(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.clients where id = p_client;
  perform set_config('ged.seed', 'on', true);
  insert into public.ged_folders (company_id, client_id, name, system_key, sort_order)
  select v_company, p_client, v.name, v.key, v.ord
  from (values
    ('Contrats',        'contracts',       10),
    ('Commandes',       'orders',          20),
    ('Factures',        'invoices',        30),
    ('BAT',             'bat',             40),
    ('Patronages',      'patterns',        50),
    ('Certifications',  'certifications',  60),
    ('Logos',           'logos',           70),
    ('Correspondances', 'correspondence',  80),
    ('Qualité',         'quality',         90)) v(name, key, ord)
  on conflict do nothing;
  perform set_config('ged.seed', 'off', true);
end $$;
revoke execute on function private.ged_seed_folders(uuid) from public, anon, authenticated;

create function private.clients_seed_ged() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.ged_seed_folders(new.id);
  return new;
end $$;
create trigger clients_seed_ged_i after insert on public.clients
  for each row execute function private.clients_seed_ged();

-- Clients existants
do $$
declare r record;
begin
  for r in select id from public.clients loop perform private.ged_seed_folders(r.id); end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Migration de client_documents vers la GED (les fichiers restent dans le bucket client-docs)
-- ---------------------------------------------------------------------
do $$
declare r record; v_folder uuid; v_doc uuid; v_ver uuid;
begin
  for r in select * from public.client_documents order by created_at loop
    select f.id into v_folder from public.ged_folders f
    where f.client_id = r.client_id and f.system_key = case r.doc_type
      when 'certificate' then 'certifications' when 'quality_agreement' then 'quality'
      when 'contract' then 'contracts' when 'nda' then 'contracts' when 'specification' then 'contracts'
      else 'correspondence' end;
    v_doc := gen_random_uuid(); v_ver := gen_random_uuid();
    insert into public.ged_documents (id, company_id, client_id, folder_id, title, description, valid_until, status,
                                      version_count, file_name, mime_type, size_bytes, created_at, updated_at, created_by, updated_by)
    values (v_doc, r.company_id, r.client_id, v_folder, r.title, r.notes, r.valid_until, 'draft',
            1, r.file_name, r.mime_type, r.size_bytes, r.created_at, r.updated_at, r.uploaded_by, r.uploaded_by);
    insert into public.ged_document_versions (id, company_id, client_id, document_id, version_no, storage_bucket, storage_path,
                                              file_name, mime_type, size_bytes, change_note, uploaded_by, created_at)
    values (v_ver, r.company_id, r.client_id, v_doc, 1, 'client-docs', r.storage_path,
            r.file_name, r.mime_type, r.size_bytes, 'Importé depuis la fiche client', r.uploaded_by, r.created_at);
    update public.ged_documents set current_version_id = v_ver where id = v_doc;
  end loop;
end $$;

drop table public.client_documents cascade;
drop function if exists private.client_documents_before();

-- Vérifie qu'un dossier de stockage correspond à un client de la société de l'appelant,
-- indépendamment des droits « clients.* » de l'appelant (les politiques Storage ne doivent pas en dépendre).
create function private.storage_client_ok(p_client text, p_require_open boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.clients c
    where c.id::text = p_client and c.company_id = private.current_company()
      and (not p_require_open or c.archived_at is null))
$$;
grant execute on function private.storage_client_ok(text, boolean) to authenticated, service_role;

-- Les fichiers hérités (bucket client-docs) restent lisibles avec documents.read
drop policy if exists client_docs_select on storage.objects;
create policy client_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'client-docs' and (private.has_perm('clients.read') or private.has_perm('documents.read'))
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2]));

-- ---------------------------------------------------------------------
-- 5. Garde-fous (triggers BEFORE)
-- ---------------------------------------------------------------------
create function private.ged_assert_client_open(p_client uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v public.clients%rowtype;
begin
  select * into v from public.clients where id = p_client;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
end $$;
revoke execute on function private.ged_assert_client_open(uuid) from public, anon, authenticated;

create function private.ged_folders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_parent public.ged_folders%rowtype; v_depth int := 1; v_cur uuid;
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' and tg_op = 'DELETE' then return old; end if;

  if tg_op = 'DELETE' then
    if old.system_key is not null then raise exception 'GED_SYSTEM_FOLDER' using errcode = '42501'; end if;
    if exists (select 1 from public.ged_folders where parent_id = old.id) or exists (select 1 from public.ged_documents where folder_id = old.id) then
      raise exception 'GED_FOLDER_NOT_EMPTY' using errcode = '23503';
    end if;
    perform private.ged_assert_client_open(old.client_id);
    return old;
  end if;

  perform private.ged_assert_client_open(new.client_id);
  select company_id into new.company_id from public.clients where id = new.client_id;
  new.name := btrim(new.name);

  if new.parent_id is not null then
    select * into v_parent from public.ged_folders where id = new.parent_id;
    if not found or v_parent.client_id <> new.client_id then raise exception 'GED_BAD_PARENT' using errcode = '22023'; end if;
    v_cur := new.parent_id;
    while v_cur is not null loop
      v_depth := v_depth + 1;
      select parent_id into v_cur from public.ged_folders where id = v_cur;
      exit when v_depth > 6;
    end loop;
    if v_depth > 3 then raise exception 'GED_TOO_DEEP' using errcode = '22023'; end if;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if new.system_key is not null and coalesce(current_setting('ged.seed', true), 'off') <> 'on' then
      raise exception 'GED_SYSTEM_FOLDER' using errcode = '42501';   -- seuls les triggers système créent les dossiers système
    end if;
  else
    if old.system_key is not null and (new.name is distinct from old.name or new.parent_id is distinct from old.parent_id
                                       or new.system_key is distinct from old.system_key) then
      raise exception 'GED_SYSTEM_FOLDER' using errcode = '42501';
    end if;
    if new.client_id is distinct from old.client_id or new.parent_id is distinct from old.parent_id then
      raise exception 'GED_BAD_PARENT' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger ged_folders_before_iud before insert or update or delete on public.ged_folders
  for each row execute function private.ged_folders_before();

create function private.ged_documents_before() returns trigger
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
    -- un client archivé verrouille sa GED (sauf nettoyage système)
    if coalesce(current_setting('clients.rpc', true), 'off') <> 'on' then
      perform private.ged_assert_client_open(new.client_id);
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  select * into v_folder from public.ged_folders where id = new.folder_id;
  if not found or v_folder.client_id <> new.client_id then raise exception 'GED_BAD_FOLDER' using errcode = '22023'; end if;
  new.title := btrim(new.title);
  new.tags := coalesce((select array_agg(distinct t) from (select lower(btrim(x)) t from unnest(new.tags) x) s where t <> '' and length(t) <= 30), '{}');
  if cardinality(new.tags) > 10 then raise exception 'GED_TOO_MANY_TAGS' using errcode = '22023'; end if;
  return new;
end $$;
create trigger ged_documents_before_iu before insert or update on public.ged_documents
  for each row execute function private.ged_documents_before();

create function private.ged_versions_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype;
begin
  if tg_op = 'UPDATE' then raise exception 'GED_VERSION_IMMUTABLE' using errcode = '42501'; end if;
  select * into v from public.ged_documents where id = new.document_id;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := v.company_id; new.client_id := v.client_id;
  if new.storage_bucket = 'ged' and new.storage_path not like v.company_id::text || '/' || v.client_id::text || '/' || v.id::text || '/%' then
    raise exception 'GED_INVALID_PATH' using errcode = '22023';
  end if;
  new.uploaded_by := coalesce(new.uploaded_by, auth.uid());
  return new;
end $$;
create trigger ged_versions_before_iu before insert or update on public.ged_document_versions
  for each row execute function private.ged_versions_before();

create function private.ged_comments_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into v from public.ged_documents where id = new.document_id;
    if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
    perform private.ged_assert_client_open(v.client_id);
    if v.deleted_at is not null then raise exception 'GED_TRASHED' using errcode = '55000'; end if;
    new.company_id := v.company_id; new.client_id := v.client_id;
    new.author_id := coalesce(auth.uid(), new.author_id);
    new.body := btrim(new.body);
  else
    -- seul le soft-delete est possible
    if (to_jsonb(new) - 'deleted_at' - 'deleted_by') is distinct from (to_jsonb(old) - 'deleted_at' - 'deleted_by') then
      raise exception 'GED_VERSION_IMMUTABLE' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger ged_comments_before_iu before insert or update on public.ged_comments
  for each row execute function private.ged_comments_before();

-- ---------------------------------------------------------------------
-- 6. Historique (audit_logs : entity_type = 'document' | 'folder')
-- ---------------------------------------------------------------------
create function private.ged_meta(p_client uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('client_id', p_client, 'client_name', (select name from public.clients where id = p_client)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.ged_meta(uuid, jsonb) from public, anon, authenticated;

create function private.audit_ged_documents() returns trigger
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

  -- changements d'état (un seul événement principal par mise à jour)
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

  -- déplacement : événement dédié (dossier avant / après)
  if old.folder_id is distinct from new.folder_id then
    perform private.write_audit(new.company_id, 'ged.move', 'document', new.id::text, new.title,
      jsonb_build_object('folder', (select name from public.ged_folders where id = old.folder_id)),
      jsonb_build_object('folder', (select name from public.ged_folders where id = new.folder_id)),
      private.ged_meta(new.client_id));
  end if;

  -- autres métadonnées : titre, description, tags, validité
  v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where not (k = any (c_track))) || array['folder_id']);
  if v_chg -> 'after' <> '{}'::jsonb then
    perform private.write_audit(new.company_id, 'ged.update', 'document', new.id::text, new.title,
      v_chg -> 'before', v_chg -> 'after', private.ged_meta(new.client_id));
  end if;
  return new;
end $$;

create trigger audit_ged_documents_iu after insert or update on public.ged_documents
  for each row execute function private.audit_ged_documents();

create function private.audit_ged_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.version_no > 1 and coalesce(current_setting('clients.rpc', true), 'off') <> 'on' then
    perform private.write_audit(new.company_id, 'ged.version_add', 'document', new.document_id::text,
      (select title from public.ged_documents where id = new.document_id), null, null,
      private.ged_meta(new.client_id, jsonb_build_object('version', new.version_no, 'file_name', new.file_name, 'size_bytes', new.size_bytes, 'note', new.change_note)));
  end if;
  return new;
end $$;
create trigger audit_ged_versions_i after insert on public.ged_document_versions
  for each row execute function private.audit_ged_versions();

create function private.audit_ged_comments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'ged.comment_add', 'document', new.document_id::text,
      (select title from public.ged_documents where id = new.document_id), null, null,
      private.ged_meta(new.client_id, jsonb_build_object('comment', left(new.body, 200))));
  elsif old.deleted_at is null and new.deleted_at is not null then
    perform private.write_audit(new.company_id, 'ged.comment_delete', 'document', new.document_id::text,
      (select title from public.ged_documents where id = new.document_id), null, null,
      private.ged_meta(new.client_id, jsonb_build_object('comment', left(new.body, 200))));
  end if;
  return new;
end $$;
create trigger audit_ged_comments_iu after insert or update on public.ged_comments
  for each row execute function private.audit_ged_comments();

create function private.audit_ged_folders() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row public.ged_folders%rowtype;
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  v_row := case when tg_op = 'DELETE' then old else new end;
  if v_row.system_key is not null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(v_row.company_id, 'ged.folder_create', 'folder', v_row.id::text, v_row.name, null, null, private.ged_meta(v_row.client_id));
  elsif tg_op = 'UPDATE' and old.name is distinct from new.name then
    perform private.write_audit(v_row.company_id, 'ged.folder_rename', 'folder', v_row.id::text, new.name,
      jsonb_build_object('name', old.name), jsonb_build_object('name', new.name), private.ged_meta(v_row.client_id));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(v_row.company_id, 'ged.folder_delete', 'folder', v_row.id::text, v_row.name, null, null, private.ged_meta(v_row.client_id));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_ged_folders_iud after insert or update or delete on public.ged_folders
  for each row execute function private.audit_ged_folders();

create policy audit_logs_select_ged on public.audit_logs for select to authenticated
  using (entity_type in ('document', 'folder') and company_id = private.current_company() and private.has_perm('documents.read'));

-- ---------------------------------------------------------------------
-- 7. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.ged_folders           enable row level security;
alter table public.ged_documents         enable row level security;
alter table public.ged_document_versions enable row level security;
alter table public.ged_comments          enable row level security;

revoke all on public.ged_folders, public.ged_documents, public.ged_document_versions, public.ged_comments from anon, authenticated;
grant all on public.ged_folders, public.ged_documents, public.ged_document_versions, public.ged_comments to service_role;
grant select on public.ged_folders, public.ged_documents, public.ged_document_versions, public.ged_comments to authenticated;
grant insert (client_id, parent_id, name) on public.ged_folders to authenticated;
grant update (name) on public.ged_folders to authenticated;
grant delete on public.ged_folders to authenticated;
grant update (title, description, tags, valid_until, folder_id) on public.ged_documents to authenticated;
grant insert (document_id, body) on public.ged_comments to authenticated;

create policy ged_folders_select on public.ged_folders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.read'));
create policy ged_folders_insert on public.ged_folders for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('documents.write'));
create policy ged_folders_update on public.ged_folders for update to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.write'))
  with check (company_id = private.current_company() and private.has_perm('documents.write'));
create policy ged_folders_delete on public.ged_folders for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.write'));

create policy ged_documents_select on public.ged_documents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.read'));
create policy ged_documents_update on public.ged_documents for update to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.write') and deleted_at is null)
  with check (company_id = private.current_company() and private.has_perm('documents.write'));

create policy ged_versions_select on public.ged_document_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.read'));

create policy ged_comments_select on public.ged_comments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.read'));
create policy ged_comments_insert on public.ged_comments for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('documents.read'));

-- ---------------------------------------------------------------------
-- 8. RPC métier (atomiques, contrôle des droits dans la base)
-- ---------------------------------------------------------------------
create function public.ged_create_document(
  p_document uuid, p_folder uuid, p_title text, p_description text, p_tags text[], p_valid_until date,
  p_version uuid, p_path text, p_file_name text, p_mime text, p_size bigint, p_sha256 text, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_folder public.ged_folders%rowtype;
begin
  perform private.require_perm('documents.write');
  select * into v_folder from public.ged_folders where id = p_folder and company_id = private.current_company();
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v_folder.client_id);

  insert into public.ged_documents (id, company_id, client_id, folder_id, title, description, tags, valid_until)
  values (p_document, v_folder.company_id, v_folder.client_id, p_folder, p_title, nullif(btrim(coalesce(p_description, '')), ''),
          coalesce(p_tags, '{}'), p_valid_until);

  insert into public.ged_document_versions (id, company_id, client_id, document_id, version_no, storage_bucket, storage_path,
                                            file_name, mime_type, size_bytes, sha256, change_note)
  values (p_version, v_folder.company_id, v_folder.client_id, p_document, 1, 'ged', p_path, p_file_name, p_mime, p_size,
          nullif(p_sha256, ''), nullif(btrim(coalesce(p_note, '')), ''));

  update public.ged_documents set current_version_id = p_version, version_count = 1,
         file_name = p_file_name, mime_type = p_mime, size_bytes = p_size, sha256 = nullif(p_sha256, '')
  where id = p_document;
  return p_document;
end $$;

create function public.ged_add_version(
  p_document uuid, p_version uuid, p_path text, p_file_name text, p_mime text, p_size bigint, p_sha256 text, p_note text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype; v_no int;
begin
  perform private.require_perm('documents.write');
  select * into v from public.ged_documents where id = p_document and company_id = private.current_company() for update;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.deleted_at is not null then raise exception 'GED_TRASHED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(v.client_id);
  v_no := v.version_count + 1;

  insert into public.ged_document_versions (id, company_id, client_id, document_id, version_no, storage_bucket, storage_path,
                                            file_name, mime_type, size_bytes, sha256, change_note)
  values (p_version, v.company_id, v.client_id, p_document, v_no, 'ged', p_path, p_file_name, p_mime, p_size,
          nullif(p_sha256, ''), nullif(btrim(coalesce(p_note, '')), ''));

  -- une nouvelle version annule la validation précédente
  update public.ged_documents set current_version_id = p_version, version_count = v_no,
         file_name = p_file_name, mime_type = p_mime, size_bytes = p_size, sha256 = nullif(p_sha256, ''),
         status = 'draft', validated_by = null, validated_at = null, validated_version_id = null, validation_comment = null
  where id = p_document;
  return v_no;
end $$;

create function public.ged_submit(p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype;
begin
  perform private.require_perm('documents.write');
  select * into v from public.ged_documents where id = p_document and company_id = private.current_company() for update;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.deleted_at is not null then raise exception 'GED_TRASHED' using errcode = '55000'; end if;
  if v.status not in ('draft', 'rejected') then raise exception 'GED_BAD_STATUS' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(v.client_id);
  update public.ged_documents set status = 'pending_review', validated_by = null, validated_at = null, validated_version_id = null, validation_comment = null
  where id = p_document;
end $$;

create function public.ged_review(p_document uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  perform private.require_perm('documents.validate');
  select * into v from public.ged_documents where id = p_document and company_id = private.current_company() for update;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.deleted_at is not null then raise exception 'GED_TRASHED' using errcode = '55000'; end if;
  if v.status <> 'pending_review' then raise exception 'GED_BAD_STATUS' using errcode = '55000'; end if;
  if not p_approve and (v_comment is null or length(v_comment) < 3) then raise exception 'GED_COMMENT_REQUIRED' using errcode = '22023'; end if;
  perform private.ged_assert_client_open(v.client_id);
  update public.ged_documents set status = case when p_approve then 'validated' else 'rejected' end,
         validated_by = auth.uid(), validated_at = now(), validated_version_id = v.current_version_id, validation_comment = v_comment
  where id = p_document;
end $$;

create function public.ged_trash(p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype;
begin
  perform private.require_perm('documents.write');
  select * into v from public.ged_documents where id = p_document and company_id = private.current_company() for update;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.deleted_at is not null then raise exception 'GED_TRASHED' using errcode = '55000'; end if;
  if v.status = 'validated' then perform private.require_perm('documents.delete'); end if;   -- un document validé est protégé
  perform private.ged_assert_client_open(v.client_id);
  update public.ged_documents set deleted_at = now(), deleted_by = auth.uid() where id = p_document;
end $$;

create function public.ged_restore(p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype;
begin
  perform private.require_perm('documents.write');
  select * into v from public.ged_documents where id = p_document and company_id = private.current_company() for update;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.deleted_at is null then raise exception 'GED_NOT_TRASHED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(v.client_id);
  update public.ged_documents set deleted_at = null, deleted_by = null where id = p_document;
end $$;

-- Suppression définitive : renvoie les fichiers à effacer du Storage (fait ensuite par l'application)
create function private.ged_purge_one(p_doc public.ged_documents, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_files jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('bucket', storage_bucket, 'path', storage_path)), '[]'::jsonb) into v_files
  from public.ged_document_versions where document_id = p_doc.id;
  perform private.write_audit(p_doc.company_id, 'ged.purge', 'document', p_doc.id::text, p_doc.title,
    jsonb_build_object('title', p_doc.title, 'status', p_doc.status, 'file_name', p_doc.file_name),
    null, private.ged_meta(p_doc.client_id, jsonb_build_object('versions', p_doc.version_count, 'reason', p_reason)), 'rpc');
  perform set_config('clients.rpc', 'on', true);
  delete from public.ged_documents where id = p_doc.id;
  perform set_config('clients.rpc', 'off', true);
  return v_files;
end $$;
revoke execute on function private.ged_purge_one(public.ged_documents, text) from public, anon, authenticated;

create function public.ged_purge(p_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype;
begin
  perform private.require_perm('documents.delete');
  select * into v from public.ged_documents where id = p_document and company_id = private.current_company() for update;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.deleted_at is null then raise exception 'GED_NOT_TRASHED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(v.client_id);
  return private.ged_purge_one(v, 'manual');
end $$;

create function public.ged_empty_trash(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype; v_files jsonb := '[]'::jsonb;
begin
  perform private.require_perm('documents.delete');
  perform private.ged_assert_client_open(p_client);
  for v in select * from public.ged_documents where client_id = p_client and company_id = private.current_company() and deleted_at is not null for update loop
    v_files := v_files || private.ged_purge_one(v, 'empty_trash');
  end loop;
  return v_files;
end $$;

-- Purge automatique de la corbeille (à planifier : pg_cron / Edge Function, rôle service_role)
create function public.ged_purge_expired(p_days int default 30) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.ged_documents%rowtype; v_files jsonb := '[]'::jsonb;
begin
  for v in select * from public.ged_documents where deleted_at is not null and deleted_at < now() - make_interval(days => p_days) for update loop
    v_files := v_files || private.ged_purge_one(v, 'retention');
  end loop;
  return v_files;
end $$;

create function public.ged_delete_comment(p_comment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ged_comments%rowtype;
begin
  perform private.require_perm('documents.read');
  select * into v from public.ged_comments where id = p_comment and company_id = private.current_company();
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.author_id <> auth.uid() and not private.has_perm('documents.delete') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if v.deleted_at is not null then return; end if;
  update public.ged_comments set deleted_at = now(), deleted_by = auth.uid() where id = p_comment;
end $$;

create function public.ged_client_stats() returns table (client_id uuid, documents bigint, pending bigint, expiring bigint, trashed bigint, size_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('documents.read');
  return query
    select d.client_id,
           count(*) filter (where d.deleted_at is null),
           count(*) filter (where d.deleted_at is null and d.status = 'pending_review'),
           count(*) filter (where d.deleted_at is null and d.valid_until is not null and d.valid_until <= current_date + 60),
           count(*) filter (where d.deleted_at is not null),
           coalesce(sum(d.size_bytes) filter (where d.deleted_at is null), 0)::bigint
    from public.ged_documents d
    where d.company_id = private.current_company()
    group by d.client_id;
end $$;

create function public.ged_find_duplicate(p_client uuid, p_sha256 text) returns table (id uuid, title text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('documents.read');
  return query
    select d.id, d.title from public.ged_documents d
    where d.client_id = p_client and d.company_id = private.current_company() and d.deleted_at is null and d.sha256 = p_sha256
    limit 1;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'ged_create_document(uuid,uuid,text,text,text[],date,uuid,text,text,text,bigint,text,text)',
    'ged_add_version(uuid,uuid,text,text,text,bigint,text,text)', 'ged_submit(uuid)', 'ged_review(uuid,boolean,text)',
    'ged_trash(uuid)', 'ged_restore(uuid)', 'ged_purge(uuid)', 'ged_empty_trash(uuid)', 'ged_delete_comment(uuid)',
    'ged_client_stats()', 'ged_find_duplicate(uuid,text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.ged_purge_expired(int) from public, anon, authenticated;
grant  execute on function public.ged_purge_expired(int) to service_role;

-- La suppression définitive d'un client compte aussi les documents GED
create or replace function public.client_delete(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype; v_contacts int; v_addresses int; v_documents int;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'CLIENT_NOT_ARCHIVED' using errcode = '55000'; end if;
  if exists (select 1 from public.profiles where client_id = p_client) then
    raise exception 'CLIENT_IN_USE' using errcode = '23503';
  end if;
  select count(*) into v_contacts  from public.client_contacts  where client_id = p_client;
  select count(*) into v_addresses from public.client_addresses where client_id = p_client;
  select count(*) into v_documents from public.ged_documents    where client_id = p_client;

  perform set_config('clients.rpc', 'on', true);
  begin
    delete from public.clients where id = p_client;
  exception when foreign_key_violation then
    perform set_config('clients.rpc', 'off', true);
    raise exception 'CLIENT_IN_USE' using errcode = '23503';
  end;
  perform set_config('clients.rpc', 'off', true);

  perform private.write_audit(v.company_id, 'client.delete', 'client', v.id::text, v.name,
    to_jsonb(v) - array['company_id','created_at','updated_at','created_by','updated_by'], null,
    jsonb_build_object('contacts', v_contacts, 'addresses', v_addresses, 'documents', v_documents), 'rpc');
  return jsonb_build_object('contacts', v_contacts, 'addresses', v_addresses, 'documents', v_documents);
end $$;

-- ---------------------------------------------------------------------
-- 9. Storage : bucket privé `ged` (25 Mo). Téléversement direct par URL signée.
--    chemin : <company_id>/<client_id>/<document_id>/<version_id>-<fichier>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ged', 'ged', false, 26214400, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = null;

create policy ged_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'ged' and private.has_perm('documents.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2]));

create policy ged_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ged' and private.has_perm('documents.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_client_ok((storage.foldername(objects.name))[2], true));
-- Pas de politique DELETE : la suppression des fichiers passe par l'application (service_role) après ged_purge*.
