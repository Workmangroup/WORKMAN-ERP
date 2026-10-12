-- =====================================================================
-- 0042_imports_reference — Imports simulables, reprise sans doublon, référentiels avec responsables (P018)
--  Socle réutilisé : sites (0032), emplacements d'entrepôt warehouse_locations (0017, garde wh_can), profils (0001).
--  Ajouts :
--    cost_centers        : centres analytiques, code immuable, responsable obligatoire (profil actif de la même société)
--    calendars           : calendriers de travail, jours ouvrés ISO (1 = lundi … 7 = dimanche), site optionnel, responsable obligatoire
--    import_batches      : lot d'import (type, fichier, empreinte SHA-256, clé d'idempotence unique par société)
--    import_rows         : ligne d'import, erreurs explicites, clé naturelle, décision de simulation et résultat
--    import_* (fonctions): création (reprise par la clé), chargement, simulation SANS MUTATION, validation, export des rejets
--    reference_integrity_report : doublons et orphelins en LECTURE SEULE (aucun nettoyage automatique)
--  Règles :
--    - les tables d'import ne sont jamais écrites directement : seules les fonctions écrivent ;
--    - la simulation ne touche aucune table métier (testé) ;
--    - la validation est faite par une personne différente de celle qui a chargé le lot (séparation des tâches) ;
--    - une validation qui échoue annule tout le lot (transaction) : jamais de lot partiellement appliqué ;
--    - un lot validé est figé ; relancer la même clé renvoie le même lot, sans nouvelle insertion.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('imports.read',         'admin', 'Voir les imports',              'Lire les lots d''import, leurs rejets et leur résultat'),
  ('imports.write',        'admin', 'Préparer les imports',          'Créer, charger et simuler un lot d''import (sans écriture métier)'),
  ('imports.commit',       'admin', 'Valider les imports',           'Valider un lot simulé : écrit les référentiels (personne différente du chargeur)'),
  ('referentials.read',    'admin', 'Voir les référentiels',         'Lire les centres analytiques, calendriers et rapport d''intégrité'),
  ('referentials.manage',  'admin', 'Gérer les référentiels',        'Créer et modifier les centres analytiques et calendriers')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('imports.read', 'imports.write', 'imports.commit', 'referentials.read', 'referentials.manage'))
  or (r.code = 'direction' and p.code in ('imports.read', 'referentials.read')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Centres analytiques
-- ---------------------------------------------------------------------
create table public.cost_centers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  label       text not null check (length(btrim(label)) between 2 and 120),
  owner_id    uuid not null references public.profiles(id),                -- responsable : profil de la même société
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code),
  unique (company_id, id)
);

-- ---------------------------------------------------------------------
-- 3. Calendriers de travail
-- ---------------------------------------------------------------------
create table public.calendars (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name         text not null check (length(btrim(name)) between 2 and 120),
  site_id      uuid,
  owner_id     uuid not null references public.profiles(id),
  working_days smallint[] not null check (cardinality(working_days) between 1 and 7 and working_days <@ array[1,2,3,4,5,6,7]::smallint[]),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  updated_by   uuid,
  unique (company_id, code),
  unique (company_id, id),
  foreign key (company_id, site_id) references public.sites (company_id, id)
);

-- Fonctions partagées par les deux référentiels : code immuable, responsable valide, traçabilité
create function private.referentials_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := upper(btrim(new.code));
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  else
    if new.code is distinct from old.code or new.company_id is distinct from old.company_id then
      raise exception 'REFERENTIAL_CODE_IMMUTABLE' using errcode = '42501';
    end if;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  -- responsable : contrôlé à la création et à chaque changement de responsable (un responsable désactivé reste visible par le rapport d'intégrité)
  if tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id then
    if not exists (select 1 from public.profiles p where p.id = new.owner_id and p.company_id = new.company_id and p.is_active) then
      raise exception 'OWNER_INVALID' using errcode = '22023';
    end if;
  end if;
  if tg_table_name = 'calendars' then
    new.working_days := array(select distinct d from unnest(new.working_days) d order by d);
  end if;
  return new;
end $$;
create trigger cost_centers_guard_biu before insert or update on public.cost_centers
  for each row execute function private.referentials_guard();
create trigger calendars_guard_biu before insert or update on public.calendars
  for each row execute function private.referentials_guard();

create function private.audit_referentials() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, tg_argv[0] || '.create', tg_argv[0], new.id::text, new.code, null, to_jsonb(new));
  else
    perform private.write_audit(new.company_id,
      case when new.archived_at is not null and old.archived_at is null then tg_argv[0] || '.archive'
           when new.archived_at is null and old.archived_at is not null then tg_argv[0] || '.restore'
           else tg_argv[0] || '.update' end,
      tg_argv[0], new.id::text, new.code, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;
create trigger cost_centers_audit_iu after insert or update on public.cost_centers
  for each row execute function private.audit_referentials('cost_center');
create trigger calendars_audit_iu after insert or update on public.calendars
  for each row execute function private.audit_referentials('calendar');

alter table public.cost_centers enable row level security;
create policy cost_centers_select on public.cost_centers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('referentials.read'));
create policy cost_centers_insert on public.cost_centers for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('referentials.manage'));
create policy cost_centers_update on public.cost_centers for update to authenticated
  using (company_id = private.current_company() and private.has_perm('referentials.manage'))
  with check (company_id = private.current_company() and private.has_perm('referentials.manage'));
grant select on public.cost_centers to authenticated;
grant insert (company_id, code, label, owner_id) on public.cost_centers to authenticated;
grant update (label, owner_id, archived_at) on public.cost_centers to authenticated;
grant all on public.cost_centers to service_role;

alter table public.calendars enable row level security;
create policy calendars_select on public.calendars for select to authenticated
  using (company_id = private.current_company() and private.has_perm('referentials.read'));
create policy calendars_insert on public.calendars for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('referentials.manage'));
create policy calendars_update on public.calendars for update to authenticated
  using (company_id = private.current_company() and private.has_perm('referentials.manage'))
  with check (company_id = private.current_company() and private.has_perm('referentials.manage'));
grant select on public.calendars to authenticated;
grant insert (company_id, code, name, site_id, owner_id, working_days) on public.calendars to authenticated;
grant update (name, site_id, owner_id, working_days, archived_at) on public.calendars to authenticated;
grant all on public.calendars to service_role;

-- ---------------------------------------------------------------------
-- 4. Lots d'import et lignes
-- ---------------------------------------------------------------------
create table public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id),
  kind            text not null check (kind in ('sites', 'warehouse_locations', 'cost_centers', 'calendars')),
  file_name       text not null check (length(btrim(file_name)) between 1 and 200),
  file_sha256     text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 120),
  status          text not null default 'staged' check (status in ('staged', 'simulated', 'committed')),
  total_rows      int not null default 0,
  valid_rows      int not null default 0,
  rejected_rows   int not null default 0,
  to_create       int not null default 0,
  already_exist   int not null default 0,
  created_count   int not null default 0,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  simulated_at    timestamptz,
  committed_by    uuid,
  committed_at    timestamptz,
  unique (company_id, idempotency_key),
  unique (company_id, id)
);

create table public.import_rows (
  id          bigint generated always as identity primary key,
  batch_id    uuid not null,
  company_id  uuid not null,
  line_no     int not null check (line_no > 0),
  raw         jsonb not null check (jsonb_typeof(raw) = 'object'),
  errors      jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  natural_key text,
  status      text not null default 'loaded' check (status in ('loaded', 'rejected', 'to_create', 'exists', 'created')),
  entity_id   uuid,
  unique (batch_id, line_no),
  foreign key (company_id, batch_id) references public.import_batches (company_id, id)
);

alter table public.import_batches enable row level security;
create policy import_batches_select on public.import_batches for select to authenticated
  using (company_id = private.current_company() and private.has_perm('imports.read'));
alter table public.import_rows enable row level security;
create policy import_rows_select on public.import_rows for select to authenticated
  using (company_id = private.current_company() and private.has_perm('imports.read'));
revoke all on public.import_batches, public.import_rows from anon, authenticated;
grant select on public.import_batches, public.import_rows to authenticated;
grant all on public.import_batches, public.import_rows to service_role;

-- ---------------------------------------------------------------------
-- 5. Règles de validation et clés (privées)
-- ---------------------------------------------------------------------
create function private.import_parse_days(p text) returns smallint[]
language sql immutable set search_path = '' as $$
  select case when p ~ '^[1-7](,[1-7])*$'
    then array(select distinct x from (select unnest(string_to_array(p, ','))::smallint x) s order by x) end
$$;

-- Clé naturelle : identifie une ligne dans la société (sert aux doublons et à la simulation)
create function private.import_key(p_kind text, p_raw jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'sites' then lower(btrim(coalesce(p_raw ->> 'name', '')))
    when 'warehouse_locations' then upper(btrim(coalesce(p_raw ->> 'warehouse_code', ''))) || '|' || upper(btrim(coalesce(p_raw ->> 'code', '')))
    else upper(btrim(coalesce(p_raw ->> 'code', '')))
  end
$$;

-- Erreurs d'une ligne : tableau { code, field }. Vide = ligne valide. Rien n'est écrit.
create function private.import_check(p_kind text, p_raw jsonb, p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e jsonb := '[]'::jsonb; v text;
begin
  if p_kind = 'sites' then
    if length(btrim(coalesce(p_raw ->> 'name', ''))) not between 2 and 120 then
      e := e || jsonb_build_array(jsonb_build_object('code', 'SITE_NAME_INVALID', 'field', 'name')); end if;
    if coalesce(p_raw ->> 'kind', '') not in ('site', 'workshop', 'shop') then
      e := e || jsonb_build_array(jsonb_build_object('code', 'SITE_KIND_INVALID', 'field', 'kind')); end if;
  elsif p_kind = 'warehouse_locations' then
    v := upper(btrim(coalesce(p_raw ->> 'warehouse_code', '')));
    if not exists (select 1 from public.warehouses w where w.company_id = p_company and upper(w.code) = v and w.archived_at is null) then
      e := e || jsonb_build_array(jsonb_build_object('code', 'WAREHOUSE_NOT_FOUND', 'field', 'warehouse_code')); end if;
    if upper(btrim(coalesce(p_raw ->> 'code', ''))) !~ '^[A-Z0-9][A-Z0-9._-]{0,19}$' then
      e := e || jsonb_build_array(jsonb_build_object('code', 'ZONE_CODE_INVALID', 'field', 'code')); end if;
    if length(btrim(coalesce(p_raw ->> 'name', ''))) not between 2 and 80 then
      e := e || jsonb_build_array(jsonb_build_object('code', 'ZONE_NAME_INVALID', 'field', 'name')); end if;
    if coalesce(p_raw ->> 'zone_type', '') not in ('storage', 'reception', 'cutting', 'workshop', 'quarantine', 'shipping', 'other') then
      e := e || jsonb_build_array(jsonb_build_object('code', 'ZONE_TYPE_INVALID', 'field', 'zone_type')); end if;
  elsif p_kind = 'cost_centers' then
    if upper(btrim(coalesce(p_raw ->> 'code', ''))) !~ '^[A-Z0-9][A-Z0-9._-]{0,19}$' then
      e := e || jsonb_build_array(jsonb_build_object('code', 'CC_CODE_INVALID', 'field', 'code')); end if;
    if length(btrim(coalesce(p_raw ->> 'label', ''))) not between 2 and 120 then
      e := e || jsonb_build_array(jsonb_build_object('code', 'CC_LABEL_INVALID', 'field', 'label')); end if;
    if not exists (select 1 from public.profiles p where p.company_id = p_company and p.is_active and lower(p.email) = lower(btrim(coalesce(p_raw ->> 'owner_email', '')))) then
      e := e || jsonb_build_array(jsonb_build_object('code', 'OWNER_NOT_FOUND', 'field', 'owner_email')); end if;
  elsif p_kind = 'calendars' then
    if upper(btrim(coalesce(p_raw ->> 'code', ''))) !~ '^[A-Z0-9][A-Z0-9._-]{0,19}$' then
      e := e || jsonb_build_array(jsonb_build_object('code', 'CAL_CODE_INVALID', 'field', 'code')); end if;
    if length(btrim(coalesce(p_raw ->> 'name', ''))) not between 2 and 120 then
      e := e || jsonb_build_array(jsonb_build_object('code', 'CAL_NAME_INVALID', 'field', 'name')); end if;
    if not exists (select 1 from public.profiles p where p.company_id = p_company and p.is_active and lower(p.email) = lower(btrim(coalesce(p_raw ->> 'owner_email', '')))) then
      e := e || jsonb_build_array(jsonb_build_object('code', 'OWNER_NOT_FOUND', 'field', 'owner_email')); end if;
    if nullif(btrim(coalesce(p_raw ->> 'site_code', '')), '') is not null and not exists (
         select 1 from public.sites s where s.company_id = p_company and upper(s.code) = upper(btrim(p_raw ->> 'site_code')) and s.archived_at is null) then
      e := e || jsonb_build_array(jsonb_build_object('code', 'SITE_NOT_FOUND', 'field', 'site_code')); end if;
    if private.import_parse_days(btrim(coalesce(p_raw ->> 'working_days', ''))) is null then
      e := e || jsonb_build_array(jsonb_build_object('code', 'WORKING_DAYS_INVALID', 'field', 'working_days')); end if;
  else
    e := e || jsonb_build_array(jsonb_build_object('code', 'KIND_UNKNOWN', 'field', 'kind'));
  end if;
  return e;
end $$;
revoke execute on function private.import_check(text, jsonb, uuid) from public, anon, authenticated;

-- Élément déjà présent dans la cible (même clé naturelle) : identifiant de l'existant, sinon nul
create function private.import_existing(p_kind text, p_company uuid, p_key text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  if p_kind = 'sites' then
    select s.id into v from public.sites s where s.company_id = p_company and lower(btrim(s.name)) = p_key;
  elsif p_kind = 'warehouse_locations' then
    select z.id into v from public.warehouse_locations z join public.warehouses w on w.id = z.warehouse_id
     where w.company_id = p_company and upper(w.code) || '|' || upper(z.code) = p_key;
  elsif p_kind = 'cost_centers' then
    select c.id into v from public.cost_centers c where c.company_id = p_company and c.code = p_key;
  elsif p_kind = 'calendars' then
    select c.id into v from public.calendars c where c.company_id = p_company and c.code = p_key;
  end if;
  return v;
end $$;
revoke execute on function private.import_existing(text, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Fonctions de l'import (écriture contrôlée, uniquement par ces fonctions)
-- ---------------------------------------------------------------------
-- Création ou reprise : la même clé renvoie le même lot (aucun doublon). Clé réutilisée avec un autre fichier : refus.
create function public.import_batch_create(p_kind text, p_file_name text, p_sha256 text, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.import_batches%rowtype; v_id uuid; v_key text := btrim(coalesce(p_key, ''));
begin
  perform private.require_perm('imports.write');
  if p_kind not in ('sites', 'warehouse_locations', 'cost_centers', 'calendars') then raise exception 'IMPORT_KIND_INVALID' using errcode = '22023'; end if;
  if coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' then raise exception 'IMPORT_HASH_INVALID' using errcode = '22023'; end if;
  if length(v_key) < 8 then raise exception 'IMPORT_KEY_REQUIRED' using errcode = '22023'; end if;
  select * into b from public.import_batches where company_id = v_co and idempotency_key = v_key;
  if found then
    if b.created_by is distinct from auth.uid() then raise exception 'IMPORT_NOT_OWNER' using errcode = '42501'; end if;
    if b.kind <> p_kind or b.file_sha256 <> p_sha256 then raise exception 'IMPORT_KEY_CONFLICT' using errcode = '23505'; end if;
    return b.id;                                                  -- reprise : même lot, rien de nouveau
  end if;
  insert into public.import_batches (company_id, kind, file_name, file_sha256, idempotency_key)
  values (v_co, p_kind, btrim(p_file_name), p_sha256, v_key) returning id into v_id;
  perform private.write_audit(v_co, 'import.create', 'import_batch', v_id::text, btrim(p_file_name), null,
    jsonb_build_object('kind', p_kind, 'sha256', p_sha256), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.import_batch_create(text, text, text, text) to authenticated, service_role;

-- Chargement : une seule fois par lot, par son auteur. Les lignes en erreur sont gardées avec leurs motifs.
create function public.import_rows_load(p_batch uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.import_batches%rowtype; v_total int; v_rej int;
begin
  perform private.require_perm('imports.write');
  select * into b from public.import_batches where id = p_batch and company_id = v_co for update;
  if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.created_by is distinct from auth.uid() then raise exception 'IMPORT_NOT_OWNER' using errcode = '42501'; end if;
  if b.status <> 'staged' then raise exception 'IMPORT_BAD_STATUS' using errcode = '55000', detail = b.status; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'IMPORT_EMPTY' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'IMPORT_TOO_MANY_ROWS' using errcode = '22023'; end if;
  if exists (select 1 from public.import_rows where batch_id = p_batch) then raise exception 'IMPORT_ALREADY_LOADED' using errcode = '55000'; end if;

  insert into public.import_rows (batch_id, company_id, line_no, raw, errors, natural_key, status)
  select p_batch, v_co, t.ord::int, t.elem, c.errs, private.import_key(b.kind, t.elem),
         case when jsonb_array_length(c.errs) = 0 then 'loaded' else 'rejected' end
    from jsonb_array_elements(p_rows) with ordinality as t(elem, ord)
    cross join lateral (select private.import_check(b.kind, t.elem, v_co) as errs) c;

  select count(*), count(*) filter (where status = 'rejected') into v_total, v_rej from public.import_rows where batch_id = p_batch;
  update public.import_batches set total_rows = v_total, rejected_rows = v_rej where id = p_batch;
  return jsonb_build_object('total', v_total, 'loaded', v_total - v_rej, 'rejected', v_rej);
end $$;
grant execute on function public.import_rows_load(uuid, jsonb) to authenticated, service_role;

-- Simulation : décide créer / déjà présent / rejet (doublon dans le fichier). AUCUNE écriture métier.
create function public.import_simulate(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.import_batches%rowtype; v_create int; v_exist int; v_rej int;
begin
  perform private.require_perm('imports.write');
  select * into b from public.import_batches where id = p_batch and company_id = v_co for update;
  if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.created_by is distinct from auth.uid() then raise exception 'IMPORT_NOT_OWNER' using errcode = '42501'; end if;
  if b.status <> 'staged' then raise exception 'IMPORT_BAD_STATUS' using errcode = '55000', detail = b.status; end if;

  update public.import_rows set entity_id = private.import_existing(b.kind, v_co, natural_key)
   where batch_id = p_batch and status = 'loaded';
  update public.import_rows set status = case when entity_id is null then 'to_create' else 'exists' end
   where batch_id = p_batch and status = 'loaded';
  -- même clé deux fois dans le fichier : les deux lignes sont rejetées, aucune ne choisit à la place de l'autre
  update public.import_rows set status = 'rejected', entity_id = null,
         errors = errors || jsonb_build_array(jsonb_build_object('code', 'IMPORT_DUPLICATE_IN_FILE', 'field', 'natural_key'))
   where batch_id = p_batch and status in ('to_create', 'exists') and natural_key in (
     select natural_key from public.import_rows where batch_id = p_batch and status in ('to_create', 'exists')
      group by natural_key having count(*) > 1);

  select count(*) filter (where status = 'to_create'), count(*) filter (where status = 'exists'), count(*) filter (where status = 'rejected')
    into v_create, v_exist, v_rej from public.import_rows where batch_id = p_batch;
  update public.import_batches set status = 'simulated', simulated_at = now(), to_create = v_create, already_exist = v_exist,
         rejected_rows = v_rej, valid_rows = v_create + v_exist where id = p_batch;
  perform private.write_audit(v_co, 'import.simulate', 'import_batch', p_batch::text, b.file_name, null,
    jsonb_build_object('to_create', v_create, 'already_exist', v_exist, 'rejected', v_rej), '{}'::jsonb, 'rpc');
  return jsonb_build_object('to_create', v_create, 'already_exist', v_exist, 'rejected', v_rej);
end $$;
grant execute on function public.import_simulate(uuid) to authenticated, service_role;

-- Validation : personne différente du chargeur ; permissions propres à chaque référentiel ; tout ou rien.
-- Relancer un lot déjà validé renvoie son résumé sans rien écrire (reprise sans doublon).
create function public.import_commit(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.import_batches%rowtype; r record; v_id uuid; v_created int := 0;
begin
  perform private.require_perm('imports.commit');
  select * into b from public.import_batches where id = p_batch and company_id = v_co for update;
  if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status = 'committed' then
    return jsonb_build_object('created', b.created_count, 'already_exist', b.already_exist, 'rejected', b.rejected_rows, 'already_committed', true);
  end if;
  if b.status <> 'simulated' then raise exception 'IMPORT_BAD_STATUS' using errcode = '55000', detail = b.status; end if;
  if b.created_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'import'; end if;
  if b.kind = 'sites' then perform private.require_perm('sites.manage');
  else perform private.require_perm('referentials.manage'); end if;

  for r in select * from public.import_rows where batch_id = p_batch and status = 'to_create' order by line_no loop
    if b.kind = 'sites' then
      insert into public.sites (company_id, name, kind, city, address)
      values (v_co, btrim(r.raw ->> 'name'), r.raw ->> 'kind', nullif(btrim(coalesce(r.raw ->> 'city', '')), ''), nullif(btrim(coalesce(r.raw ->> 'address', '')), ''))
      returning id into v_id;
    elsif b.kind = 'warehouse_locations' then
      insert into public.warehouse_locations (warehouse_id, code, name, zone_type, notes)
      values ((select w.id from public.warehouses w where w.company_id = v_co and upper(w.code) = upper(btrim(r.raw ->> 'warehouse_code')) and w.archived_at is null),
              upper(btrim(r.raw ->> 'code')), btrim(r.raw ->> 'name'), r.raw ->> 'zone_type', nullif(btrim(coalesce(r.raw ->> 'notes', '')), ''))
      returning id into v_id;
    elsif b.kind = 'cost_centers' then
      insert into public.cost_centers (company_id, code, label, owner_id)
      values (v_co, upper(btrim(r.raw ->> 'code')), btrim(r.raw ->> 'label'),
              (select p.id from public.profiles p where p.company_id = v_co and p.is_active and lower(p.email) = lower(btrim(r.raw ->> 'owner_email'))))
      returning id into v_id;
    else
      insert into public.calendars (company_id, code, name, site_id, owner_id, working_days)
      values (v_co, upper(btrim(r.raw ->> 'code')), btrim(r.raw ->> 'name'),
              (select s.id from public.sites s where s.company_id = v_co and upper(s.code) = upper(nullif(btrim(coalesce(r.raw ->> 'site_code', '')), '')) and s.archived_at is null),
              (select p.id from public.profiles p where p.company_id = v_co and p.is_active and lower(p.email) = lower(btrim(r.raw ->> 'owner_email'))),
              private.import_parse_days(btrim(r.raw ->> 'working_days')))
      returning id into v_id;
    end if;
    update public.import_rows set status = 'created', entity_id = v_id where batch_id = p_batch and line_no = r.line_no;
    v_created := v_created + 1;
  end loop;

  update public.import_batches set status = 'committed', committed_by = auth.uid(), committed_at = now(), created_count = v_created
   where id = p_batch;
  perform private.write_audit(v_co, 'import.commit', 'import_batch', p_batch::text, b.file_name, jsonb_build_object('status', b.status),
    jsonb_build_object('status', 'committed', 'created', v_created, 'already_exist', b.already_exist, 'rejected', b.rejected_rows), '{}'::jsonb, 'rpc');
  return jsonb_build_object('created', v_created, 'already_exist', b.already_exist, 'rejected', b.rejected_rows, 'already_committed', false);
end $$;
grant execute on function public.import_commit(uuid) to authenticated, service_role;

-- Export des rejets : numéro de ligne, données brutes et motifs (la mise en CSV se fait côté application)
create function public.import_rejects_export(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v jsonb;
begin
  perform private.require_perm('imports.read');
  if not exists (select 1 from public.import_batches where id = p_batch and company_id = v_co) then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_no', line_no, 'raw', raw, 'errors', errors) order by line_no), '[]'::jsonb)
    into v from public.import_rows where batch_id = p_batch and status = 'rejected';
  return v;
end $$;
grant execute on function public.import_rejects_export(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Rapport d'intégrité des référentiels : lecture seule, aucun nettoyage automatique
-- ---------------------------------------------------------------------
create function public.reference_integrity_report()
returns table (ref_kind text, ref_code text, issue text, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('referentials.read');
  return query
    select 'cost_centers'::text, c.code, 'DUPLICATE_LABEL'::text, 'libellé identique à un autre centre actif'::text
      from public.cost_centers c
     where c.company_id = v_co and c.archived_at is null
       and exists (select 1 from public.cost_centers o where o.company_id = v_co and o.id <> c.id and o.archived_at is null and lower(btrim(o.label)) = lower(btrim(c.label)))
    union all
    select 'warehouse_locations', z.code, 'DUPLICATE_ZONE_NAME', 'nom identique à une autre zone active du même entrepôt'
      from public.warehouse_locations z
     where z.company_id = v_co and z.archived_at is null
       and exists (select 1 from public.warehouse_locations o where o.warehouse_id = z.warehouse_id and o.id <> z.id and o.archived_at is null and lower(btrim(o.name)) = lower(btrim(z.name)))
    union all
    select 'cost_centers', c.code, 'OWNER_INACTIVE', 'responsable désactivé'
      from public.cost_centers c join public.profiles p on p.id = c.owner_id
     where c.company_id = v_co and c.archived_at is null and not p.is_active
    union all
    select 'calendars', c.code, 'OWNER_INACTIVE', 'responsable désactivé'
      from public.calendars c join public.profiles p on p.id = c.owner_id
     where c.company_id = v_co and c.archived_at is null and not p.is_active
    union all
    select 'calendars', c.code, 'SITE_ARCHIVED', 'site rattaché archivé'
      from public.calendars c join public.sites s on s.company_id = c.company_id and s.id = c.site_id
     where c.company_id = v_co and c.archived_at is null and s.archived_at is not null
    union all
    select 'warehouse_locations', z.code, 'WAREHOUSE_ARCHIVED', 'entrepôt archivé, zone encore active'
      from public.warehouse_locations z join public.warehouses w on w.id = z.warehouse_id
     where z.company_id = v_co and z.archived_at is null and w.archived_at is not null
    order by 1, 2, 3;
end $$;
grant execute on function public.reference_integrity_report() to authenticated, service_role;
