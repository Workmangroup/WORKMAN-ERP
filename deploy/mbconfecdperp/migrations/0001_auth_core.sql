-- =====================================================================
-- 0001_auth_core — Module Authentification
-- Tables : companies, profiles, roles, permissions, role_permissions,
--          user_roles, auth_events
-- Fonctions : trigger de création de profil, hook JWT, my_access(),
--             gestion des sessions (list / revoke)
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  legal_id    text,
  country     char(2) not null default 'TN',
  created_at  timestamptz not null default now()
);

create table public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  company_id            uuid not null references public.companies(id),
  email                 text not null,
  full_name             text not null,
  phone                 text,
  locale                text not null default 'fr' check (locale in ('fr','en')),
  user_type             text not null default 'internal' check (user_type in ('internal','client')),
  client_id             uuid,                       -- FK vers clients ajoutée avec le module Clients
  is_active             boolean not null default true,
  must_change_password  boolean not null default false,
  password_changed_at   timestamptz,
  last_sign_in_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint profiles_client_scope check ((user_type = 'client') = (client_id is not null))
);
create index profiles_company_idx on public.profiles(company_id);
create unique index profiles_email_uq on public.profiles(lower(email));

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null,
  label       text not null,
  unique (company_id, code)
);

create table public.permissions (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,               -- ex: users.read
  module       text not null,
  description  text
);

create table public.role_permissions (
  role_id        uuid not null references public.roles(id) on delete cascade,
  permission_id  uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table public.user_roles (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  role_id  uuid not null references public.roles(id) on delete cascade,
  primary key (user_id, role_id)
);
create index user_roles_role_idx on public.user_roles(role_id);

-- Journal des événements d'authentification (écrit par le serveur, clé service_role)
create table public.auth_events (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  user_id     uuid,
  email       text,
  event_type  text not null check (event_type in (
    'login_success','login_failed','login_locked','logout','logout_all',
    'password_reset_requested','password_reset_completed',
    'password_changed','password_change_failed',
    'session_revoked','sessions_revoked_others','session_idle_timeout')),
  success     boolean not null default true,
  ip          text,
  user_agent  text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index auth_events_email_idx on public.auth_events (lower(email), event_type, created_at desc);
create index auth_events_user_idx  on public.auth_events (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Helpers de sécurité (schéma private)
-- ---------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create function private.current_company() returns uuid
language sql stable security definer set search_path = '' as $$
  select company_id from public.profiles where id = auth.uid() and is_active
$$;

create function private.has_perm(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id
    join public.profiles pr on pr.id = ur.user_id
    where ur.user_id = auth.uid() and pr.is_active and pe.code = p
  )
$$;

grant execute on function private.current_company() to authenticated, service_role;
grant execute on function private.has_perm(text)    to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Création automatique du profil à la création d'un utilisateur Auth.
-- IMPORTANT : on lit raw_app_meta_data (modifiable uniquement côté serveur),
-- jamais raw_user_meta_data (modifiable par l'utilisateur).
-- ---------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_type    text;
  v_client  uuid;
begin
  v_company := nullif(new.raw_app_meta_data ->> 'company_id', '')::uuid;
  if v_company is null then
    select id into v_company from public.companies order by created_at limit 1;
  end if;
  if v_company is null then
    raise exception 'Aucune société configurée : créez une ligne dans public.companies';
  end if;

  v_type   := coalesce(nullif(new.raw_app_meta_data ->> 'user_type', ''), 'internal');
  v_client := nullif(new.raw_app_meta_data ->> 'client_id', '')::uuid;

  insert into public.profiles (id, company_id, email, full_name, user_type, client_id, must_change_password)
  values (
    new.id, v_company, new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    v_type, v_client,
    coalesce((new.raw_app_meta_data ->> 'must_change_password')::boolean, false)
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Synchronise l'email du profil si l'email Auth change
create function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;

create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- ---------------------------------------------------------------------
-- Hook « Custom Access Token » : ajoute des claims au JWT
--   company_id, user_type, client_id, app_roles[], must_change_password
-- Le claim réservé "role" (= authenticated) n'est jamais modifié.
-- À activer : config.toml [auth.hook.custom_access_token] ou Dashboard.
-- ---------------------------------------------------------------------
create function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := event -> 'claims';
  v_uid    uuid  := (event ->> 'user_id')::uuid;
  v_prof   public.profiles%rowtype;
  v_roles  jsonb;
begin
  select * into v_prof from public.profiles where id = v_uid;
  if not found then
    return event;
  end if;

  select coalesce(jsonb_agg(r.code order by r.code), '[]'::jsonb) into v_roles
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.user_id = v_uid;

  v_claims := v_claims
    || jsonb_build_object(
         'company_id',           v_prof.company_id,
         'user_type',            v_prof.user_type,
         'client_id',            v_prof.client_id,
         'app_roles',            v_roles,
         'must_change_password', v_prof.must_change_password,
         'is_active',            v_prof.is_active);

  return jsonb_set(event, '{claims}', v_claims);
end $$;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- ---------------------------------------------------------------------
-- Rôles + permissions de l'utilisateur courant
-- ---------------------------------------------------------------------
create function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('code', r.code, 'label', r.label) order by r.code)
      from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = auth.uid()), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(distinct pe.code)
      from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions pe on pe.id = rp.permission_id
      where ur.user_id = auth.uid()), '[]'::jsonb))
$$;

revoke execute on function public.my_access() from public, anon;
grant  execute on function public.my_access() to authenticated;

-- ---------------------------------------------------------------------
-- Gestion des sessions (table auth.sessions gérée par Supabase)
-- ---------------------------------------------------------------------
create function public.list_my_sessions()
returns table (
  id uuid, created_at timestamptz, updated_at timestamptz,
  user_agent text, ip text, not_after timestamptz, is_current boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_at, s.updated_at, s.user_agent, s.ip::text, s.not_after,
         s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
  from auth.sessions s
  where s.user_id = auth.uid()
  order by s.updated_at desc nulls last
$$;

create function public.revoke_session(p_session_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  delete from auth.sessions where id = p_session_id and user_id = auth.uid();
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

create function public.revoke_other_sessions() returns int
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  delete from auth.sessions
  where user_id = auth.uid()
    and id is distinct from nullif(auth.jwt() ->> 'session_id', '')::uuid;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.list_my_sessions()        from public, anon;
revoke execute on function public.revoke_session(uuid)      from public, anon;
revoke execute on function public.revoke_other_sessions()   from public, anon;
grant  execute on function public.list_my_sessions()        to authenticated;
grant  execute on function public.revoke_session(uuid)     to authenticated;
grant  execute on function public.revoke_other_sessions()  to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.companies        enable row level security;
alter table public.profiles         enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles       enable row level security;
alter table public.auth_events      enable row level security;

create policy companies_select on public.companies for select to authenticated
  using (id = private.current_company());

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (company_id = private.current_company() and private.has_perm('users.read')));

-- Un utilisateur ne peut modifier que ses propres données de profil (colonnes limitées ci-dessous)
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

revoke update on public.profiles from authenticated;
grant  update (full_name, phone, locale) on public.profiles to authenticated;

create policy roles_select on public.roles for select to authenticated
  using (company_id = private.current_company());

create policy permissions_select on public.permissions for select to authenticated using (true);

create policy role_permissions_select on public.role_permissions for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id and r.company_id = private.current_company()));

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid()
         or (private.has_perm('users.read')
             and exists (select 1 from public.profiles p where p.id = user_id and p.company_id = private.current_company())));

create policy auth_events_select on public.auth_events for select to authenticated
  using (user_id = auth.uid()
         or (private.has_perm('audit.read') and company_id = private.current_company()));

-- Écritures sur roles/permissions/user_roles/auth_events : uniquement via service_role
-- (module Administration à venir) ; aucune politique INSERT/UPDATE/DELETE pour authenticated.
grant select on public.companies, public.profiles, public.roles, public.permissions,
               public.role_permissions, public.user_roles, public.auth_events to authenticated;
grant all on public.companies, public.profiles, public.roles, public.permissions,
             public.role_permissions, public.user_roles, public.auth_events to service_role;
grant usage, select on sequence public.auth_events_id_seq to service_role;
