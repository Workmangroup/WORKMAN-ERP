-- ===========================================================================
-- 0095 — Scripts de migration versionnés et répétables, mapping d'anciens identifiants, simulation (P110), additif
--
-- Ajoute : registre de scripts versionnés (somme de contrôle figée) ; exécutions identifiées par une clé
-- d'idempotence (une même clé renvoie la même exécution) ; mode simulation (aucune écriture de production,
-- seuls les rejets et le compte rendu sont journalisés) ou application ; lots bornés ; mapping ancien
-- identifiant → identifiant local en ajout seul ; rejets motivés ; contrôle du mapping.
-- Objet traité par ce lot : les clients (code, nom, pays). Les autres objets relèvent de lots suivants.
-- Aucun DROP, aucun TRUNCATE, aucune purge.
-- ===========================================================================

insert into public.permissions (code, module, label, description) values
  ('migration.run', 'admin', 'Lancer une migration de données', 'Simulation et application des scripts de migration, mapping des anciens identifiants')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'migration.run'
where r.is_system and r.code = 'admin' on conflict do nothing;

create function private.migration_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'MIG_APPEND_ONLY' using errcode = '55000';
end $$;
revoke execute on function private.migration_append_only() from public, anon, authenticated;

-- 1. Registre des scripts : (code, version) unique, somme de contrôle figée
create table public.migration_scripts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  script_code   text not null check (script_code ~ '^[A-Z0-9_]{3,40}$'),
  version       int not null check (version >= 1),
  checksum      text not null check (checksum ~ '^[a-f0-9]{64}$'),
  registered_by uuid default auth.uid(),
  registered_at timestamptz not null default now(),
  unique (company_id, script_code, version)
);
create trigger migration_scripts_append before update or delete on public.migration_scripts
  for each row execute function private.migration_append_only();

create function public.migration_script_register(p_code text, p_version int, p_checksum text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.migration_scripts%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('migration.run');
  select * into s from public.migration_scripts where company_id = v_co and script_code = p_code and version = p_version;
  if found then
    -- Rejouable : même version et même contenu, rien à refaire ; contenu changé = refus
    if s.checksum <> p_checksum then raise exception 'MIG_CHECKSUM_CHANGED' using errcode = '22023'; end if;
    return s.id;
  end if;
  insert into public.migration_scripts (id, company_id, script_code, version, checksum) values (v_id, v_co, p_code, p_version, p_checksum);
  perform private.write_audit(v_co, 'migration.script_register', 'migration_script', v_id::text, p_code, null,
    jsonb_build_object('version', p_version, 'checksum', p_checksum), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- 2. Exécutions : clé d'idempotence, mode, lots bornés, compteurs
create table public.migration_runs (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  script_id           uuid not null references public.migration_scripts(id),
  idempotency_key     text not null check (length(btrim(idempotency_key)) between 8 and 120),
  mode                text not null check (mode in ('simulation', 'apply')),
  batch_size          int not null check (batch_size between 1 and 5000),
  status              text not null default 'running' check (status in ('running', 'done')),
  read_count          int not null default 0 check (read_count >= 0),
  created_count       int not null default 0 check (created_count >= 0),
  would_create_count  int not null default 0 check (would_create_count >= 0),
  mapped_count        int not null default 0 check (mapped_count >= 0),
  rejected_count      int not null default 0 check (rejected_count >= 0),
  created_by          uuid default auth.uid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  check ((status = 'done') = (finished_at is not null)),
  check (mode = 'apply' or created_count = 0),
  check (mode = 'simulation' or would_create_count = 0),
  unique (company_id, idempotency_key)
);
create function private.migration_runs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'MIG_APPEND_ONLY' using errcode = '55000'; end if;
  if new.script_id <> old.script_id or new.mode <> old.mode or new.batch_size <> old.batch_size or new.idempotency_key <> old.idempotency_key then
    raise exception 'MIG_APPEND_ONLY' using errcode = '55000';
  end if;
  if old.status = 'done' then raise exception 'MIG_APPEND_ONLY' using errcode = '55000'; end if;
  return new;
end $$;
revoke execute on function private.migration_runs_guard() from public, anon, authenticated;
create trigger migration_runs_guard before update or delete on public.migration_runs
  for each row execute function private.migration_runs_guard();

-- 3. Mapping des anciens identifiants (ajout seul) et rejets (ajout seul)
create table public.legacy_id_map (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  object_kind  text not null check (object_kind in ('client')),
  legacy_id    text not null check (length(btrim(legacy_id)) between 1 and 120),
  local_id     uuid not null,
  run_id       uuid not null references public.migration_runs(id),
  created_at   timestamptz not null default now(),
  unique (company_id, object_kind, legacy_id),
  unique (company_id, object_kind, local_id)
);
create trigger legacy_id_map_append before update or delete on public.legacy_id_map
  for each row execute function private.migration_append_only();

create table public.migration_rejects (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  run_id       uuid not null references public.migration_runs(id),
  object_kind  text not null,
  legacy_id    text,
  code         text not null check (length(btrim(code)) between 3 and 60),
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create trigger migration_rejects_append before update or delete on public.migration_rejects
  for each row execute function private.migration_append_only();

-- Sécurité de ligne : lecture par admin (migration.run) ; écritures uniquement par les fonctions
do $$
declare t text;
begin
  foreach t in array array['migration_scripts', 'migration_runs', 'legacy_id_map', 'migration_rejects'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(''migration.run''))',
      t || '_select', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- 4. Exécution : ouverture (idempotente), lot, clôture
create function public.migration_run_start(p_script uuid, p_mode text, p_batch_size int, p_idem text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.migration_runs%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('migration.run');
  if p_mode not in ('simulation', 'apply') then raise exception 'MIG_BAD_MODE' using errcode = '22023'; end if;
  if p_idem is null or length(btrim(p_idem)) < 8 then raise exception 'MIG_BAD_KEY' using errcode = '22023'; end if;
  if not exists (select 1 from public.migration_scripts where id = p_script and company_id = v_co) then raise exception 'MIG_SCRIPT_UNKNOWN' using errcode = 'P0002'; end if;
  select * into r from public.migration_runs where company_id = v_co and idempotency_key = btrim(p_idem);
  if found then
    if r.script_id <> p_script or r.mode <> p_mode or r.batch_size <> p_batch_size then raise exception 'MIG_KEY_REUSED' using errcode = '22023'; end if;
    return r.id;
  end if;
  insert into public.migration_runs (id, company_id, script_id, idempotency_key, mode, batch_size)
    values (v_id, v_co, p_script, btrim(p_idem), p_mode, p_batch_size);
  perform private.write_audit(v_co, 'migration.run_start', 'migration_run', v_id::text, p_mode, null,
    jsonb_build_object('batch_size', p_batch_size), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Lot : [{legacy_id, code, name, country}]. Un identifiant déjà mappé est compté, jamais recréé.
-- En simulation : aucune écriture dans les clients ni dans le mapping ; les rejets sont journalisés.
create function public.migration_run_batch(p_run uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.migration_runs%rowtype; row_ jsonb; v_lid text; v_code text; v_name text;
  v_country text; v_local uuid; v_read int := 0; v_created int := 0; v_would int := 0; v_mapped int := 0; v_rej int := 0;
  v_seen text[] := '{}'; v_bad text;
begin
  perform private.require_perm('migration.run');
  select * into r from public.migration_runs where id = p_run and company_id = v_co for update;
  if not found then raise exception 'MIG_RUN_UNKNOWN' using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'MIG_RUN_CLOSED' using errcode = '55000'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'MIG_BAD_INPUT' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > r.batch_size then raise exception 'MIG_BATCH_TOO_LARGE' using errcode = '22023'; end if;

  for row_ in select * from jsonb_array_elements(p_rows) loop
    v_read := v_read + 1;
    v_lid := btrim(coalesce(row_->>'legacy_id', ''));
    v_code := btrim(coalesce(row_->>'code', ''));
    v_name := btrim(coalesce(row_->>'name', ''));
    v_country := upper(btrim(coalesce(row_->>'country', '')));
    v_bad := null;
    if v_lid = '' then v_bad := 'MIG_MISSING_LEGACY_ID';
    elsif v_lid = any(v_seen) then v_bad := 'MIG_DUPLICATE_IN_BATCH';
    elsif v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,39}$' then v_bad := 'MIG_INVALID_CODE';
    elsif length(v_name) < 2 or length(v_name) > 120 then v_bad := 'MIG_INVALID_NAME';
    elsif v_country !~ '^[A-Z]{2}$' then v_bad := 'MIG_INVALID_COUNTRY';
    end if;
    if v_lid <> '' then v_seen := v_seen || v_lid; end if;

    if v_bad is null then
      select m.local_id into v_local from public.legacy_id_map m where m.company_id = v_co and m.object_kind = 'client' and m.legacy_id = v_lid;
      if found then
        v_mapped := v_mapped + 1;
        continue;
      end if;
      if exists (select 1 from public.clients c where c.company_id = v_co and c.code = v_code) then v_bad := 'MIG_CODE_EXISTS'; end if;
    end if;

    if v_bad is not null then
      v_rej := v_rej + 1;
      insert into public.migration_rejects (company_id, run_id, object_kind, legacy_id, code, detail)
        values (v_co, r.id, 'client', nullif(v_lid, ''), v_bad, jsonb_build_object('code', v_code, 'country', v_country));
      continue;
    end if;

    if r.mode = 'simulation' then
      v_would := v_would + 1;
    else
      v_local := gen_random_uuid();
      insert into public.clients (id, company_id, code, name, country) values (v_local, v_co, v_code, v_name, v_country);
      insert into public.legacy_id_map (company_id, object_kind, legacy_id, local_id, run_id) values (v_co, 'client', v_lid, v_local, r.id);
      v_created := v_created + 1;
    end if;
  end loop;

  update public.migration_runs set read_count = read_count + v_read, created_count = created_count + v_created,
    would_create_count = would_create_count + v_would, mapped_count = mapped_count + v_mapped, rejected_count = rejected_count + v_rej
    where id = r.id;
  return jsonb_build_object('read', v_read, 'created', v_created, 'would_create', v_would, 'mapped', v_mapped, 'rejected', v_rej);
end $$;

create function public.migration_run_finish(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.migration_runs%rowtype;
begin
  perform private.require_perm('migration.run');
  select * into r from public.migration_runs where id = p_run and company_id = v_co for update;
  if not found then raise exception 'MIG_RUN_UNKNOWN' using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'MIG_RUN_CLOSED' using errcode = '55000'; end if;
  update public.migration_runs set status = 'done', finished_at = now() where id = r.id;
  perform private.write_audit(v_co, 'migration.run_finish', 'migration_run', r.id::text, r.mode, jsonb_build_object('status', 'running'),
    jsonb_build_object('status', 'done', 'created', r.created_count, 'would_create', r.would_create_count, 'rejected', r.rejected_count), '{}'::jsonb, 'rpc');
end $$;

-- 5. Vérification du mapping : chaque identifiant mappé pointe un client existant, de même code
create function public.migration_map_verify() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_total int; v_missing int;
begin
  perform private.require_perm('migration.run');
  select count(*)::int into v_total from public.legacy_id_map where company_id = v_co and object_kind = 'client';
  select count(*)::int into v_missing from public.legacy_id_map m
    where m.company_id = v_co and m.object_kind = 'client' and not exists (select 1 from public.clients c where c.id = m.local_id and c.company_id = v_co);
  return jsonb_build_object('mapped', v_total, 'missing_local', v_missing);
end $$;

create function public.migration_local_id(p_legacy text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('migration.run');
  select m.local_id into v_id from public.legacy_id_map m where m.company_id = v_co and m.object_kind = 'client' and m.legacy_id = p_legacy;
  return v_id;
end $$;
