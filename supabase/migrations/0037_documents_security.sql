-- =====================================================================
-- 0037_documents_security — Fichiers et documents : analyse, quarantaine, liens temporaires, rétention (P014)
--  Socle conservé : GED (0005) — dossiers, documents, versions, bucket privé `ged`, politiques de stockage,
--  journal d'accès, purge de corbeille, contrôle des signatures de fichiers (côté application).
--  Ajouts :
--    1. Types de fichiers : liste blanche MIME au niveau du bucket. Le SVG est exclu (contenu actif).
--    2. Analyse antivirus : chaque version nouvelle est « pending » (quarantaine explicite). Seul un service
--       d'analyse (service_role, ged_record_scan) peut la passer à « clean ». Sans moteur, rien n'est publié.
--       Les versions antérieures à cette migration sont « legacy_unscanned » : publiées, mais signalées comme non analysées.
--    3. Téléchargement : ged_download_check revérifie à chaque appel les droits sur le document parent et l'état de publication.
--    4. Liens temporaires : jeton aléatoire, seule son empreinte est stockée ; 1 à 168 heures ; révocable ;
--       chaque ouverture revérifie les droits de la personne qui ouvre (pas seulement ceux du créateur).
--    5. Rétention par catégorie : durée validée par le propriétaire uniquement. Sans durée validée, aucun calcul d'échéance
--       n'est exposé comme exécutoire ; aucune suppression automatique n'est faite par cette migration.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Types de fichiers au niveau du bucket (même liste que lib/ged/constants.ts, SVG exclu)
-- ---------------------------------------------------------------------
update storage.buckets set allowed_mime_types = array[
  'application/acad', 'application/dxf', 'application/msword', 'application/pdf', 'application/postscript',
  'application/vnd.hp-hpgl', 'application/vnd.ms-excel', 'application/vnd.ms-outlook', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip', 'image/jpeg', 'image/png', 'image/webp', 'message/rfc822', 'text/csv', 'text/plain']
where id = 'ged';

-- ---------------------------------------------------------------------
-- 2. Analyse des versions : table séparée (les versions restent immuables, voir 0005)
-- ---------------------------------------------------------------------
create table public.ged_version_scans (
  version_id      uuid primary key references public.ged_document_versions(id) on delete cascade,
  company_id      uuid not null references public.companies(id),
  scan_status     text not null check (scan_status in ('pending', 'clean', 'infected', 'error', 'legacy_unscanned')),
  scan_engine     text check (scan_engine is null or length(scan_engine) between 2 and 60),
  scanned_at      timestamptz,
  scan_details    text check (scan_details is null or length(scan_details) <= 300),
  sha256_verified boolean not null default false,
  updated_at      timestamptz not null default now(),
  check ((scan_status in ('clean', 'infected', 'error') and scanned_at is not null and scan_engine is not null)
      or scan_status in ('pending', 'legacy_unscanned'))
);
create index ged_version_scans_status_idx on public.ged_version_scans (company_id, scan_status);
alter table public.ged_version_scans enable row level security;
create policy ged_version_scans_select on public.ged_version_scans for select to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.read'));
revoke all on public.ged_version_scans from anon, authenticated;
grant select on public.ged_version_scans to authenticated;
grant all on public.ged_version_scans to service_role;

-- Historique : chaque version reçoit « pending » à sa création (quarantaine explicite)
create function private.ged_version_scan_init() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ged_version_scans (version_id, company_id, scan_status) values (new.id, new.company_id, 'pending');
  return new;
end $$;
create trigger ged_version_scan_init_ai after insert on public.ged_document_versions
  for each row execute function private.ged_version_scan_init();

-- Versions déjà présentes avant cette migration : publiées, mais signalées comme non analysées
insert into public.ged_version_scans (version_id, company_id, scan_status)
select v.id, v.company_id, 'legacy_unscanned' from public.ged_document_versions v
on conflict (version_id) do nothing;

-- Publiable : analysé sans menace, ou historique signalé comme non analysé
create function private.ged_version_publishable(p_status text) returns boolean
language sql immutable set search_path = '' as $$ select p_status in ('clean', 'legacy_unscanned') $$;

-- Résultat d'analyse : appelé par le service d'analyse uniquement (service_role).
create function public.ged_record_scan(p_version uuid, p_result text, p_engine text, p_details text default null, p_sha256 text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.ged_document_versions%rowtype; d public.ged_documents%rowtype; v_status text; v_details text := nullif(btrim(coalesce(p_details, '')), '');
begin
  if p_result not in ('clean', 'infected', 'error') then raise exception 'GED_BAD_SCAN_RESULT' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_engine, ''))) < 2 or length(p_engine) > 60 then raise exception 'GED_BAD_SCAN_ENGINE' using errcode = '22023'; end if;
  if p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'GED_BAD_HASH' using errcode = '22023'; end if;
  select * into v from public.ged_document_versions where id = p_version;
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  -- une empreinte annoncée qui ne correspond pas à celle calculée sur l'objet : refus, pas de publication
  v_status := p_result;
  if p_result = 'clean' and v.sha256 is not null and p_sha256 is not null and p_sha256 <> v.sha256 then
    v_status := 'error'; v_details := 'Empreinte annoncée différente de celle calculée sur le fichier';
  end if;
  update public.ged_version_scans set scan_status = v_status, scan_engine = p_engine, scanned_at = now(), scan_details = v_details,
    sha256_verified = (v_status = 'clean' and p_sha256 is not null and p_sha256 = v.sha256), updated_at = now()
    where version_id = v.id;
  select * into d from public.ged_documents where id = v.document_id;
  perform private.write_audit(v.company_id, 'ged.scan_' || v_status, 'ged_version', v.id::text, d.title || ' v' || v.version_no, null,
    jsonb_build_object('result', v_status, 'engine', p_engine, 'details', v_details), jsonb_build_object('document', v.document_id), 'rpc');
  return jsonb_build_object('version', v.id, 'scan_status', v_status);
end $$;
revoke execute on function public.ged_record_scan(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ged_record_scan(uuid, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 3. Téléchargement : droits du document parent revérifiés à chaque appel
-- ---------------------------------------------------------------------
create function public.ged_download_check(p_version uuid)
returns table (storage_bucket text, storage_path text, file_name text, mime_type text, size_bytes bigint, version_no int, document_id uuid, title text)
language plpgsql stable security definer set search_path = '' as $$
declare v public.ged_document_versions%rowtype; d public.ged_documents%rowtype; v_status text;
begin
  perform private.require_perm('documents.read');
  select * into v from public.ged_document_versions where id = p_version and company_id = private.current_company();
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into d from public.ged_documents where id = v.document_id;
  if not found or d.deleted_at is not null then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(d.client_id);
  select coalesce(sc.scan_status, 'pending') into v_status from public.ged_version_scans sc where sc.version_id = v.id;
  if not private.ged_version_publishable(v_status) then
    raise exception 'GED_NOT_PUBLISHED' using errcode = '42501', detail = v_status;
  end if;
  return query select v.storage_bucket, v.storage_path, v.file_name, v.mime_type, v.size_bytes, v.version_no, d.id, d.title;
end $$;
grant execute on function public.ged_download_check(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Liens temporaires (jeton non stocké en clair)
-- ---------------------------------------------------------------------
create table public.ged_share_links (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id),
  version_id    uuid not null references public.ged_document_versions(id) on delete cascade,
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoked_by    uuid,
  use_count     int not null default 0,
  last_used_at  timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '168 hours'),
  check ((revoked_at is null) = (revoked_by is null))
);
create index ged_share_links_version_idx on public.ged_share_links (version_id);
alter table public.ged_share_links enable row level security;
create policy ged_share_links_select on public.ged_share_links for select to authenticated
  using (company_id = private.current_company() and created_by = auth.uid());
revoke all on public.ged_share_links from anon, authenticated;
grant select on public.ged_share_links to authenticated;
grant all on public.ged_share_links to service_role;

create function public.ged_link_create(p_version uuid, p_hours int default 24)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.ged_document_versions%rowtype; d public.ged_documents%rowtype; v_token text; v_exp timestamptz; v_status text;
begin
  perform private.require_perm('documents.read');
  if p_hours is null or p_hours < 1 or p_hours > 168 then raise exception 'GED_LINK_WINDOW' using errcode = '22023'; end if;
  select * into v from public.ged_document_versions where id = p_version and company_id = private.current_company();
  if not found then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into d from public.ged_documents where id = v.document_id;
  if d.deleted_at is not null then raise exception 'GED_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(d.client_id);
  select coalesce(sc.scan_status, 'pending') into v_status from public.ged_version_scans sc where sc.version_id = v.id;
  if not private.ged_version_publishable(v_status) then raise exception 'GED_NOT_PUBLISHED' using errcode = '42501', detail = v_status; end if;
  -- jeton de 128 caractères hexadécimaux issus de deux UUID aléatoires ; seule son empreinte SHA-256 est stockée
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp := now() + make_interval(hours => p_hours);
  insert into public.ged_share_links (company_id, version_id, token_hash, expires_at)
  values (v.company_id, v.id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_exp);
  perform private.write_audit(v.company_id, 'ged.link_create', 'ged_version', v.id::text, d.title || ' v' || v.version_no, null,
    jsonb_build_object('expires_at', v_exp, 'hours', p_hours), jsonb_build_object('document', d.id), 'rpc');
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end $$;
grant execute on function public.ged_link_create(uuid, int) to authenticated, service_role;

-- Ouverture d'un lien : état du lien, puis droits de la personne qui ouvre sur le document parent.
create function public.ged_link_resolve(p_token text)
returns table (storage_bucket text, storage_path text, file_name text, mime_type text, size_bytes bigint, version_no int, document_id uuid, title text)
language plpgsql security definer set search_path = '' as $$
declare l public.ged_share_links%rowtype; r record;
begin
  if auth.uid() is null then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select * into l from public.ged_share_links where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if not found then raise exception 'GED_LINK_INVALID' using errcode = 'P0002'; end if;
  if l.revoked_at is not null then raise exception 'GED_LINK_REVOKED' using errcode = '42501'; end if;
  if l.expires_at <= now() then raise exception 'GED_LINK_EXPIRED' using errcode = '42501'; end if;
  -- droits de la personne qui ouvre, et publication actuelle de la version
  select * into r from public.ged_download_check(l.version_id);
  update public.ged_share_links set use_count = use_count + 1, last_used_at = now() where id = l.id;
  perform private.write_audit(l.company_id, 'ged.link_open', 'ged_version', l.version_id::text, r.title || ' v' || r.version_no, null,
    jsonb_build_object('link', l.id), '{}'::jsonb, 'rpc');
  return query select r.storage_bucket, r.storage_path, r.file_name, r.mime_type, r.size_bytes, r.version_no, r.document_id, r.title;
end $$;
grant execute on function public.ged_link_resolve(text) to authenticated, service_role;

create function public.ged_link_revoke(p_link uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.ged_share_links%rowtype;
begin
  select * into l from public.ged_share_links where id = p_link and company_id = private.current_company() for update;
  if not found then raise exception 'GED_LINK_INVALID' using errcode = 'P0002'; end if;
  if l.created_by is distinct from auth.uid() then perform private.require_perm('documents.write'); end if;
  if l.revoked_at is not null then raise exception 'GED_LINK_REVOKED' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'GED_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.ged_share_links set revoked_at = now(), revoked_by = auth.uid() where id = l.id;
  perform private.write_audit(l.company_id, 'ged.link_revoke', 'ged_version', l.version_id::text, 'Lien révoqué', null,
    jsonb_build_object('link', l.id), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
grant execute on function public.ged_link_revoke(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Quarantaine : versions non publiées, visibles pour l'équipe documentaire
-- ---------------------------------------------------------------------
create function public.ged_quarantine_list()
returns table (version_id uuid, document_id uuid, title text, version_no int, file_name text, scan_status text, scan_details text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('documents.read');
  return query
    select v.id, d.id, d.title::text, v.version_no, v.file_name, sc.scan_status, sc.scan_details, v.created_at
    from public.ged_document_versions v
      join public.ged_documents d on d.id = v.document_id
      join public.ged_version_scans sc on sc.version_id = v.id
    where v.company_id = private.current_company() and sc.scan_status in ('pending', 'infected', 'error') and d.deleted_at is null
    order by v.created_at desc limit 200;
end $$;
grant execute on function public.ged_quarantine_list() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Rétention par catégorie : durée validée par le propriétaire, sinon « à confirmer »
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('documents.retention', 'ged', 'Définir la rétention des documents', 'Valider la durée de conservation par catégorie (après validation du propriétaire)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'documents.retention'
  and r.code in ('admin', 'direction')
on conflict do nothing;

create table public.ged_retention_rules (
  company_id    uuid not null default private.current_company() references public.companies(id),
  category      text not null check (category ~ '^[a-z_]{3,40}$'),
  retention_months int check (retention_months is null or retention_months between 1 and 1200),
  legal_basis   text check (legal_basis is null or length(btrim(legal_basis)) between 5 and 300),
  status        text not null default 'a_confirmer' check (status in ('a_confirmer', 'validee')),
  validated_by  uuid,
  validated_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (company_id, category),
  check ((status = 'validee' and retention_months is not null and validated_by is not null and validated_at is not null)
      or (status = 'a_confirmer'))
);
alter table public.ged_retention_rules enable row level security;
create policy ged_retention_rules_select on public.ged_retention_rules for select to authenticated
  using (company_id = private.current_company() and private.has_perm('documents.read'));
revoke all on public.ged_retention_rules from anon, authenticated;
grant select on public.ged_retention_rules to authenticated;
grant all on public.ged_retention_rules to service_role;

alter table public.ged_documents add column retention_category text;
create index ged_documents_retention_idx on public.ged_documents (company_id, retention_category);

-- Définir ou valider une durée : réservé à documents.retention, durée entre 1 et 1 200 mois, base légale obligatoire.
create function public.ged_retention_set(p_category text, p_months int, p_legal_basis text, p_validate boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('documents.retention');
  if length(btrim(coalesce(p_legal_basis, ''))) < 5 then raise exception 'GED_RETENTION_BASIS_REQUIRED' using errcode = '22023'; end if;
  if p_validate then
    if p_months is null then raise exception 'GED_RETENTION_MONTHS_REQUIRED' using errcode = '22023'; end if;
    insert into public.ged_retention_rules (company_id, category, retention_months, legal_basis, status, validated_by, validated_at, updated_at)
    values (v_co, p_category, p_months, btrim(p_legal_basis), 'validee', auth.uid(), now(), now())
    on conflict (company_id, category) do update set retention_months = excluded.retention_months, legal_basis = excluded.legal_basis,
      status = 'validee', validated_by = excluded.validated_by, validated_at = excluded.validated_at, updated_at = now();
  else
    insert into public.ged_retention_rules (company_id, category, retention_months, legal_basis, status, updated_at)
    values (v_co, p_category, null, btrim(p_legal_basis), 'a_confirmer', now())
    on conflict (company_id, category) do update set legal_basis = excluded.legal_basis, updated_at = now();
  end if;
  perform private.write_audit(v_co, 'ged.retention_set', 'ged_retention', p_category, p_category, null,
    jsonb_build_object('months', p_months, 'status', case when p_validate then 'validee' else 'a_confirmer' end), jsonb_build_object('reason', btrim(p_legal_basis)), 'rpc');
end $$;
grant execute on function public.ged_retention_set(text, int, text, boolean) to authenticated, service_role;

-- Échéances : seulement pour les catégories validées. Lecture seule : aucune suppression ici.
create function public.ged_retention_due(p_as_of date default current_date)
returns table (category text, retention_status text, due_documents bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('documents.read');
  return query
    select r.category, r.status, count(d.id)
    from public.ged_retention_rules r
      left join public.ged_documents d on d.company_id = r.company_id and d.retention_category = r.category and d.deleted_at is null
        and r.status = 'validee' and d.created_at::date + make_interval(months => r.retention_months) <= p_as_of
    where r.company_id = private.current_company()
    group by r.category, r.status
    order by r.category;
end $$;
grant execute on function public.ged_retention_due(date) to authenticated, service_role;
