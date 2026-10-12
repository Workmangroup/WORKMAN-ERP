-- MB Confection ERP AI : base mbconfecdperp
-- Script complet, à exécuter dans l'ordre (prérequis puis 0001 à 0027). Généré le 2026-10-08.
-- Sauvegarder la base avant toute exécution.

-- 00_prerequis : schémas et rôles Supabase (auth, storage, rôles anon/authenticated/service_role).
-- Nécessaire sur une base Postgres qui ne vient pas de Supabase. Ne pas exécuter sur une base Supabase existante.
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role supabase_auth_admin nologin;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}');
    create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade,
       created_at timestamptz default now(), updated_at timestamptz default now(), user_agent text, ip inet, not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    grant usage on schema auth to authenticated, service_role, supabase_auth_admin;
    grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;
    -- Stub minimal de Supabase Storage
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:greatest(cardinality(string_to_array(name, '/')) - 1, 0)] $$;
    grant usage on schema storage to authenticated, service_role;
    grant select, insert, delete on storage.objects to authenticated;
  


-- ===== 0001_auth_core.sql =====
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


-- ===== 0002_auth_seed.sql =====
-- =====================================================================
-- 0002_auth_seed — Société, rôles et permissions de base (idempotent)
-- =====================================================================

insert into public.companies (name, country)
select 'MB Confection', 'TN'
where not exists (select 1 from public.companies);

insert into public.permissions (code, module, description) values
  ('users.read',     'auth',  'Voir les utilisateurs'),
  ('users.write',    'auth',  'Créer / modifier les utilisateurs'),
  ('roles.read',     'auth',  'Voir les rôles'),
  ('roles.write',    'auth',  'Gérer les rôles et permissions'),
  ('audit.read',     'auth',  'Consulter le journal d''authentification'),
  ('sessions.manage','auth',  'Gérer les sessions des autres utilisateurs')
on conflict (code) do nothing;

insert into public.roles (company_id, code, label)
select c.id, r.code, r.label
from public.companies c
cross join (values
  ('admin',        'Administrateur'),
  ('direction',    'Direction'),
  ('commercial',   'Commercial / Export'),
  ('methodes',     'Bureau des méthodes'),
  ('prod_manager', 'Responsable production'),
  ('chef_atelier', 'Chef d''atelier'),
  ('magasinier',   'Magasinier'),
  ('achats',       'Acheteur'),
  ('qualite',      'Responsable qualité'),
  ('ged_manager',  'Gestionnaire documentaire'),
  ('rh',           'Ressources humaines'),
  ('comptable',    'Comptable'),
  ('operateur',    'Opérateur'),
  ('client_portal','Utilisateur client')
) as r(code, label)
on conflict (company_id, code) do nothing;

-- L'administrateur reçoit toutes les permissions
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.code = 'admin'
on conflict do nothing;

-- La direction peut lire utilisateurs, rôles et audit
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r join public.permissions p on p.code in ('users.read','roles.read','audit.read')
where r.code = 'direction'
on conflict do nothing;


-- ===== 0003_rbac_audit.sql =====
-- =====================================================================
-- 0003_rbac_audit — Module RBAC + journal d'audit
--  * 8 rôles système : admin, direction, commercial, achat, production,
--    qualite, magasin, finance (+ rôles personnalisés)
--  * catalogue de permissions + matrice par défaut
--  * RPC de gestion (contrôle de permission, anti-escalade, dernier admin)
--  * audit_logs append-only alimenté par triggers + RPC
--  * claim JWT app_permissions
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Colonnes complémentaires
-- ---------------------------------------------------------------------
alter table public.roles
  add column description text,
  add column is_system   boolean not null default false,
  add column created_at  timestamptz not null default now(),
  add column updated_at  timestamptz not null default now();

alter table public.roles
  add constraint roles_code_format check (code ~ '^[a-z][a-z0-9_]{1,31}$');

create trigger roles_set_updated_at before update on public.roles
  for each row execute function private.set_updated_at();

alter table public.permissions add column label text;

-- ---------------------------------------------------------------------
-- 2. Normalisation des rôles existants (0002) vers les 8 rôles métier
-- ---------------------------------------------------------------------
update public.roles r set code = 'achat'      where code = 'achats'       and not exists (select 1 from public.roles x where x.company_id = r.company_id and x.code = 'achat');
update public.roles r set code = 'production' where code = 'prod_manager' and not exists (select 1 from public.roles x where x.company_id = r.company_id and x.code = 'production');
update public.roles r set code = 'magasin'    where code = 'magasinier'   and not exists (select 1 from public.roles x where x.company_id = r.company_id and x.code = 'magasin');
update public.roles r set code = 'finance'    where code = 'comptable'    and not exists (select 1 from public.roles x where x.company_id = r.company_id and x.code = 'finance');

-- Anciens rôles de départ non affectés : supprimés. Affectés : conservés comme rôles personnalisés.
delete from public.roles r
where r.code in ('methodes','chef_atelier','ged_manager','rh','operateur','client_portal')
  and not exists (select 1 from public.user_roles ur where ur.role_id = r.id);

insert into public.roles (company_id, code, label)
select c.id, v.code, v.label
from public.companies c
cross join (values ('admin','Administrateur'),('direction','Direction'),('commercial','Commercial'),
                   ('achat','Achat'),('production','Production'),('qualite','Qualité'),
                   ('magasin','Magasin'),('finance','Finance')) v(code, label)
on conflict (company_id, code) do nothing;

update public.roles r set
  label = v.label, description = v.description, is_system = true
from (values
  ('admin',      'Administrateur', 'Accès complet : utilisateurs, rôles, permissions et journal d''audit.'),
  ('direction',  'Direction',      'Vision globale en lecture, validations et approbations.'),
  ('commercial', 'Commercial',     'Clients, commandes et expéditions.'),
  ('achat',      'Achat',          'Fournisseurs et approvisionnements.'),
  ('production', 'Production',     'Ordres de fabrication, planification et suivi atelier.'),
  ('qualite',    'Qualité',        'Contrôles, non-conformités et certifications.'),
  ('magasin',    'Magasin',        'Stock matières, réceptions et expéditions.'),
  ('finance',    'Finance',        'Facturation, paiements et coûts.')
) v(code, label, description)
where r.code = v.code;

-- ---------------------------------------------------------------------
-- 3. Catalogue de permissions (code = module.action)
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('users.read',        'admin',      'Voir les utilisateurs',           'Consulter la liste et le détail des utilisateurs'),
  ('users.write',       'admin',      'Gérer les utilisateurs',          'Activer / désactiver des comptes'),
  ('roles.read',        'admin',      'Voir les rôles',                  'Consulter les rôles et la matrice de permissions'),
  ('roles.write',       'admin',      'Gérer les rôles',                 'Créer, modifier, supprimer des rôles et leurs permissions'),
  ('roles.assign',      'admin',      'Affecter les rôles',              'Attribuer ou retirer des rôles aux utilisateurs'),
  ('audit.read',        'admin',      'Consulter l''audit',              'Journal d''audit et journal d''authentification'),
  ('sessions.manage',   'admin',      'Gérer les sessions',              'Forcer la déconnexion d''un utilisateur'),
  ('dashboard.read',    'dashboard',  'Voir le tableau de bord',         null),
  ('clients.read',      'clients',    'Voir les clients',                null),
  ('clients.write',     'clients',    'Gérer les clients',               null),
  ('clients.delete',    'clients',    'Archiver les clients',            null),
  ('articles.read',     'articles',   'Voir les articles',               'Articles, nomenclatures, fiches techniques, patronages'),
  ('articles.write',    'articles',   'Gérer les articles',              null),
  ('articles.validate', 'articles',   'Valider les versions',            'Valider fiche technique / BOM / patronage'),
  ('documents.read',    'ged',        'Voir les documents',              null),
  ('documents.write',   'ged',        'Gérer les documents',             null),
  ('certifications.read',  'ged',     'Voir les certifications',         null),
  ('certifications.write', 'ged',     'Gérer les certifications',        null),
  ('orders.read',       'orders',     'Voir les commandes',              null),
  ('orders.write',      'orders',     'Gérer les commandes',             null),
  ('orders.confirm',    'orders',     'Confirmer les commandes',         null),
  ('suppliers.read',    'purchases',  'Voir les fournisseurs',           null),
  ('suppliers.write',   'purchases',  'Gérer les fournisseurs',          null),
  ('purchases.read',    'purchases',  'Voir les achats',                 null),
  ('purchases.write',   'purchases',  'Gérer les achats',                null),
  ('purchases.approve', 'purchases',  'Approuver les achats',            null),
  ('stock.read',        'stock',      'Voir le stock',                   null),
  ('stock.write',       'stock',      'Mouvements de stock',             'Réceptions, sorties, transferts'),
  ('stock.adjust',      'stock',      'Ajuster le stock',                'Ajustements d''inventaire'),
  ('production.read',   'production', 'Voir la production',              null),
  ('production.write',  'production', 'Saisir la production',            null),
  ('production.plan',   'production', 'Planifier la production',         'Créer et lancer les ordres de fabrication'),
  ('quality.read',      'quality',    'Voir la qualité',                 null),
  ('quality.write',     'quality',    'Saisir les contrôles',            null),
  ('quality.approve',   'quality',    'Libérer / bloquer les lots',      null),
  ('shipments.read',    'shipping',   'Voir les expéditions',            null),
  ('shipments.write',   'shipping',   'Gérer les expéditions',           null),
  ('invoices.read',     'finance',    'Voir les factures',               null),
  ('invoices.write',    'finance',    'Gérer les factures',              null),
  ('payments.read',     'finance',    'Voir les paiements',              null),
  ('payments.write',    'finance',    'Gérer les paiements',             null),
  ('costs.read',        'finance',    'Voir les coûts et marges',        null),
  ('reports.read',      'reports',    'Voir les rapports',               null)
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

-- ---------------------------------------------------------------------
-- 4. Matrice par défaut des rôles système
-- ---------------------------------------------------------------------
create temporary table _default_matrix (role_code text, perm text);

insert into _default_matrix select 'admin', code from public.permissions;

insert into _default_matrix select 'direction', code from public.permissions
  where code like '%.read' or code in ('orders.confirm','purchases.approve','quality.approve','articles.validate','stock.adjust');

insert into _default_matrix values
  ('commercial','dashboard.read'),('commercial','clients.read'),('commercial','clients.write'),('commercial','articles.read'),
  ('commercial','documents.read'),('commercial','certifications.read'),('commercial','orders.read'),('commercial','orders.write'),
  ('commercial','orders.confirm'),('commercial','shipments.read'),('commercial','shipments.write'),('commercial','invoices.read'),
  ('commercial','production.read'),('commercial','reports.read'),
  ('achat','dashboard.read'),('achat','suppliers.read'),('achat','suppliers.write'),('achat','purchases.read'),('achat','purchases.write'),
  ('achat','stock.read'),('achat','articles.read'),('achat','orders.read'),('achat','documents.read'),('achat','reports.read'),
  ('production','dashboard.read'),('production','articles.read'),('production','documents.read'),('production','orders.read'),
  ('production','production.read'),('production','production.write'),('production','production.plan'),('production','stock.read'),
  ('production','quality.read'),('production','shipments.read'),('production','reports.read'),
  ('qualite','dashboard.read'),('qualite','articles.read'),('qualite','documents.read'),('qualite','documents.write'),
  ('qualite','certifications.read'),('qualite','certifications.write'),('qualite','quality.read'),('qualite','quality.write'),
  ('qualite','quality.approve'),('qualite','production.read'),('qualite','orders.read'),('qualite','shipments.read'),('qualite','reports.read'),
  ('magasin','dashboard.read'),('magasin','stock.read'),('magasin','stock.write'),('magasin','purchases.read'),('magasin','suppliers.read'),
  ('magasin','production.read'),('magasin','shipments.read'),('magasin','shipments.write'),('magasin','articles.read'),('magasin','orders.read'),
  ('finance','dashboard.read'),('finance','clients.read'),('finance','orders.read'),('finance','invoices.read'),('finance','invoices.write'),
  ('finance','payments.read'),('finance','payments.write'),('finance','costs.read'),('finance','purchases.read'),('finance','suppliers.read'),
  ('finance','shipments.read'),('finance','reports.read');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from _default_matrix m
join public.roles r on r.code = m.role_code and r.is_system
join public.permissions p on p.code = m.perm
on conflict do nothing;

drop table _default_matrix;

-- ---------------------------------------------------------------------
-- 5. Journal d'audit (append-only)
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id            bigint generated always as identity primary key,
  company_id    uuid,
  actor_id      uuid,
  actor_email   text,
  action        text not null,                 -- ex: role.create, user.roles_update, access.denied
  entity_type   text not null,                 -- role | user | permission | access | ...
  entity_id     text,
  entity_label  text,
  before_data   jsonb,
  after_data    jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  source        text not null default 'trigger' check (source in ('trigger','rpc','app')),
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index audit_logs_company_idx on public.audit_logs (company_id, created_at desc);
create index audit_logs_entity_idx  on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx   on public.audit_logs (actor_id, created_at desc);
create index audit_logs_action_idx  on public.audit_logs (action, created_at desc);

create function private.audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AUDIT_IMMUTABLE: audit_logs est en ajout seul' using errcode = '42501';
end $$;

create trigger audit_logs_no_update_delete before update or delete on public.audit_logs
  for each row execute function private.audit_immutable();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.audit_immutable();

alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert on public.audit_logs to service_role;
grant usage, select on sequence public.audit_logs_id_seq to service_role;

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('audit.read'));

-- Écriture d'une entrée (jamais appelable directement par un client)
create function private.write_audit(
  p_company uuid, p_action text, p_entity_type text, p_entity_id text, p_entity_label text,
  p_before jsonb, p_after jsonb, p_metadata jsonb default '{}'::jsonb, p_source text default 'trigger')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_headers jsonb;
  v_actor   uuid := auth.uid();
  v_email   text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  if v_actor is not null then
    select email into v_email from public.profiles where id = v_actor;
  end if;
  insert into public.audit_logs (company_id, actor_id, actor_email, action, entity_type, entity_id, entity_label,
                                 before_data, after_data, metadata, source, ip, user_agent)
  values (p_company, v_actor, v_email, p_action, p_entity_type, p_entity_id, p_entity_label,
          p_before, p_after, coalesce(p_metadata, '{}'::jsonb), p_source,
          nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
          v_headers ->> 'user-agent');
end $$;

revoke execute on function private.write_audit(uuid,text,text,text,text,jsonb,jsonb,jsonb,text) from public, anon, authenticated;
grant  execute on function private.write_audit(uuid,text,text,text,text,jsonb,jsonb,jsonb,text) to service_role;

-- ---------------------------------------------------------------------
-- 6. Triggers d'audit (capturent AUSSI les écritures service_role / SQL)
--    Les fonctions RPC posent rbac.rpc = on pour écrire une entrée agrégée
--    au lieu d'une ligne par permission / rôle.
-- ---------------------------------------------------------------------
create function private.audit_roles_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'role.create', 'role', new.id::text, new.label, null, to_jsonb(new));
  elsif (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    perform private.write_audit(new.company_id, 'role.update', 'role', new.id::text, new.label, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;

create function private.audit_roles_before_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(old.company_id, 'role.delete', 'role', old.id::text, old.label, to_jsonb(old), null,
    jsonb_build_object('permissions', coalesce((
      select jsonb_agg(p.code order by p.code) from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id where rp.role_id = old.id), '[]'::jsonb)));
  return old;
end $$;

create trigger audit_roles_aiu after insert or update on public.roles
  for each row execute function private.audit_roles_after();
create trigger audit_roles_bd before delete on public.roles
  for each row execute function private.audit_roles_before_delete();

create function private.audit_role_permissions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_role public.roles%rowtype; v_perm text; v_row public.role_permissions%rowtype;
begin
  if coalesce(current_setting('rbac.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  v_row := case when tg_op = 'DELETE' then old else new end;
  select * into v_role from public.roles where id = v_row.role_id;
  if not found then return coalesce(new, old); end if;   -- suppression en cascade du rôle
  select code into v_perm from public.permissions where id = v_row.permission_id;
  perform private.write_audit(v_role.company_id,
    case when tg_op = 'DELETE' then 'role.permission_revoke' else 'role.permission_grant' end,
    'role', v_role.id::text, v_role.label, null, null, jsonb_build_object('permission', v_perm));
  return coalesce(new, old);
end $$;

create trigger audit_role_permissions_iud after insert or delete on public.role_permissions
  for each row execute function private.audit_role_permissions();

create function private.audit_user_roles() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prof public.profiles%rowtype; v_role public.roles%rowtype; v_row public.user_roles%rowtype;
begin
  if coalesce(current_setting('rbac.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  v_row := case when tg_op = 'DELETE' then old else new end;
  select * into v_prof from public.profiles where id = v_row.user_id;
  if not found then return coalesce(new, old); end if;   -- suppression en cascade de l'utilisateur
  select * into v_role from public.roles where id = v_row.role_id;
  if not found then return coalesce(new, old); end if;
  perform private.write_audit(v_prof.company_id,
    case when tg_op = 'DELETE' then 'user.role_revoke' else 'user.role_assign' end,
    'user', v_prof.id::text, v_prof.email, null, null, jsonb_build_object('role', v_role.code));
  return coalesce(new, old);
end $$;

create trigger audit_user_roles_iud after insert or delete on public.user_roles
  for each row execute function private.audit_user_roles();

create function private.audit_profiles() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_b jsonb; v_a jsonb;
  f constant text[] := array['is_active','user_type','client_id','company_id','must_change_password','full_name'];
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'user.create', 'user', new.id::text, new.email, null,
      jsonb_build_object('email', new.email, 'full_name', new.full_name, 'user_type', new.user_type, 'is_active', new.is_active));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(old.company_id, 'user.delete', 'user', old.id::text, old.email,
      jsonb_build_object('email', old.email, 'full_name', old.full_name), null);
  else
    select jsonb_object_agg(k, to_jsonb(old) -> k), jsonb_object_agg(k, to_jsonb(new) -> k) into v_b, v_a
    from unnest(f) k where (to_jsonb(old) -> k) is distinct from (to_jsonb(new) -> k);
    if v_a is not null then
      perform private.write_audit(new.company_id,
        case when old.is_active and not new.is_active then 'user.deactivate'
             when not old.is_active and new.is_active then 'user.activate'
             else 'user.update' end,
        'user', new.id::text, new.email, v_b, v_a);
    end if;
  end if;
  return coalesce(new, old);
end $$;

create trigger audit_profiles_iud after insert or update or delete on public.profiles
  for each row execute function private.audit_profiles();

-- ---------------------------------------------------------------------
-- 7. Helpers RBAC
-- ---------------------------------------------------------------------
create function private.require_perm(p text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_perm(p) then
    raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = p;
  end if;
end $$;

create function private.active_admin_count(p_company uuid, p_excluding uuid default null) returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct ur.user_id)::int
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id and r.code = 'admin' and r.company_id = p_company
  join public.profiles p on p.id = ur.user_id and p.is_active
  where p.id is distinct from p_excluding
$$;

revoke execute on function private.require_perm(text)                from public, anon;
revoke execute on function private.active_admin_count(uuid, uuid)    from public, anon, authenticated;
grant  execute on function private.require_perm(text)                to authenticated, service_role;
grant  execute on function private.active_admin_count(uuid, uuid)    to service_role;

-- ---------------------------------------------------------------------
-- 8. RPC de gestion (exécutées avec les droits de l'appelant vérifiés en base)
-- ---------------------------------------------------------------------
create function public.rbac_create_role(p_code text, p_label text, p_description text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_perm('roles.write');
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{1,31}$' then
    raise exception 'RBAC_INVALID_CODE' using errcode = '22023';
  end if;
  if nullif(btrim(p_label), '') is null then
    raise exception 'RBAC_INVALID_LABEL' using errcode = '22023';
  end if;
  begin
    insert into public.roles (company_id, code, label, description, is_system)
    values (private.current_company(), p_code, btrim(p_label), nullif(btrim(coalesce(p_description, '')), ''), false)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'RBAC_DUPLICATE' using errcode = '23505';
  end;
  return v_id;
end $$;

create function public.rbac_update_role(p_role uuid, p_label text, p_description text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role public.roles%rowtype;
begin
  perform private.require_perm('roles.write');
  select * into v_role from public.roles where id = p_role and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;
  if nullif(btrim(p_label), '') is null then raise exception 'RBAC_INVALID_LABEL' using errcode = '22023'; end if;
  update public.roles set
    label = case when v_role.is_system then v_role.label else btrim(p_label) end,
    description = nullif(btrim(coalesce(p_description, '')), '')
  where id = p_role;
end $$;

create function public.rbac_delete_role(p_role uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role public.roles%rowtype;
begin
  perform private.require_perm('roles.write');
  select * into v_role from public.roles where id = p_role and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_role.is_system then raise exception 'RBAC_SYSTEM_ROLE' using errcode = '42501'; end if;
  if exists (select 1 from public.user_roles where role_id = p_role) then
    raise exception 'RBAC_ROLE_IN_USE' using errcode = '23503';
  end if;
  perform set_config('rbac.rpc', 'on', true);
  delete from public.roles where id = p_role;
  perform set_config('rbac.rpc', 'off', true);
end $$;

create function public.rbac_set_role_permissions(p_role uuid, p_codes text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role    public.roles%rowtype;
  v_codes   text[] := coalesce((select array_agg(distinct c) from unnest(p_codes) c), '{}');
  v_current text[];
  v_added   text[];
  v_removed text[];
  v_bad     text;
  v_missing text;
  c_protected constant text[] := array['roles.read','roles.write','roles.assign','users.read','audit.read'];
begin
  perform private.require_perm('roles.write');
  select * into v_role from public.roles where id = p_role and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;

  select c into v_bad from unnest(v_codes) c where not exists (select 1 from public.permissions where code = c) limit 1;
  if v_bad is not null then raise exception 'RBAC_UNKNOWN_PERMISSION' using errcode = '22023', detail = v_bad; end if;

  -- Le rôle admin garde toujours de quoi administrer le système (anti-verrouillage)
  if v_role.code = 'admin' then
    select c into v_missing from unnest(c_protected) c where not (c = any (v_codes)) limit 1;
    if v_missing is not null then raise exception 'RBAC_ADMIN_PROTECTED' using errcode = '42501', detail = v_missing; end if;
  end if;

  select coalesce(array_agg(p.code order by p.code), '{}') into v_current
  from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = p_role;

  select coalesce(array_agg(c order by c), '{}') into v_added   from unnest(v_codes)   c where not (c = any (v_current));
  select coalesce(array_agg(c order by c), '{}') into v_removed from unnest(v_current) c where not (c = any (v_codes));

  -- Anti-escalade : on ne peut accorder que des permissions que l'on détient soi-même
  select c into v_bad from unnest(v_added) c where not private.has_perm(c) limit 1;
  if v_bad is not null then raise exception 'RBAC_ESCALATION' using errcode = '42501', detail = v_bad; end if;

  perform set_config('rbac.rpc', 'on', true);
  delete from public.role_permissions rp using public.permissions p
    where rp.role_id = p_role and p.id = rp.permission_id and p.code = any (v_removed);
  insert into public.role_permissions (role_id, permission_id)
    select p_role, p.id from public.permissions p where p.code = any (v_added);
  perform set_config('rbac.rpc', 'off', true);

  if cardinality(v_added) > 0 or cardinality(v_removed) > 0 then
    perform private.write_audit(v_role.company_id, 'role.permissions_update', 'role', v_role.id::text, v_role.label,
      jsonb_build_object('permissions', to_jsonb(v_current)),
      jsonb_build_object('permissions', to_jsonb(v_codes)),
      jsonb_build_object('added', to_jsonb(v_added), 'removed', to_jsonb(v_removed)), 'rpc');
  end if;
  return jsonb_build_object('added', to_jsonb(v_added), 'removed', to_jsonb(v_removed));
end $$;

create function public.rbac_set_user_roles(p_user uuid, p_role_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_target  public.profiles%rowtype;
  v_ids     uuid[] := coalesce((select array_agg(distinct i) from unnest(p_role_ids) i), '{}');
  v_cur_ids uuid[];
  v_add     uuid[];
  v_rem     uuid[];
  v_before  text[];
  v_after   text[];
  v_bad     text;
  v_admin   uuid;
begin
  perform private.require_perm('roles.assign');
  select * into v_target from public.profiles where id = p_user and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;

  if exists (select 1 from unnest(v_ids) i where not exists (
        select 1 from public.roles r where r.id = i and r.company_id = v_target.company_id)) then
    raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(role_id), '{}') into v_cur_ids from public.user_roles where user_id = p_user;
  select coalesce(array_agg(i), '{}') into v_add from unnest(v_ids)     i where not (i = any (v_cur_ids));
  select coalesce(array_agg(i), '{}') into v_rem from unnest(v_cur_ids) i where not (i = any (v_ids));

  -- Anti-escalade : chaque permission des rôles ajoutés doit être détenue par l'appelant
  select p.code into v_bad
  from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
  where rp.role_id = any (v_add) and not private.has_perm(p.code) limit 1;
  if v_bad is not null then raise exception 'RBAC_ESCALATION' using errcode = '42501', detail = v_bad; end if;

  -- Dernier administrateur actif : on ne peut pas lui retirer le rôle admin
  select id into v_admin from public.roles where company_id = v_target.company_id and code = 'admin';
  if v_admin = any (v_rem) and v_target.is_active and private.active_admin_count(v_target.company_id, p_user) = 0 then
    raise exception 'RBAC_LAST_ADMIN' using errcode = '42501';
  end if;

  select coalesce(array_agg(r.code order by r.code), '{}') into v_before from public.roles r where r.id = any (v_cur_ids);
  select coalesce(array_agg(r.code order by r.code), '{}') into v_after  from public.roles r where r.id = any (v_ids);

  perform set_config('rbac.rpc', 'on', true);
  delete from public.user_roles where user_id = p_user and role_id = any (v_rem);
  insert into public.user_roles (user_id, role_id) select p_user, i from unnest(v_add) i;
  perform set_config('rbac.rpc', 'off', true);

  if cardinality(v_add) > 0 or cardinality(v_rem) > 0 then
    perform private.write_audit(v_target.company_id, 'user.roles_update', 'user', v_target.id::text, v_target.email,
      jsonb_build_object('roles', to_jsonb(v_before)), jsonb_build_object('roles', to_jsonb(v_after)),
      jsonb_build_object(
        'added',   (select coalesce(jsonb_agg(r.code order by r.code), '[]') from public.roles r where r.id = any (v_add)),
        'removed', (select coalesce(jsonb_agg(r.code order by r.code), '[]') from public.roles r where r.id = any (v_rem))), 'rpc');
  end if;
  return jsonb_build_object('roles', to_jsonb(v_after));
end $$;

create function public.rbac_set_user_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_target public.profiles%rowtype; v_n int := 0;
begin
  perform private.require_perm('users.write');
  select * into v_target from public.profiles where id = p_user and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_user = auth.uid() and not p_active then raise exception 'RBAC_SELF' using errcode = '42501'; end if;

  if not p_active and v_target.is_active
     and exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id and r.code = 'admin'
                 where ur.user_id = p_user)
     and private.active_admin_count(v_target.company_id, p_user) = 0 then
    raise exception 'RBAC_LAST_ADMIN' using errcode = '42501';
  end if;

  update public.profiles set is_active = p_active where id = p_user;   -- trigger d'audit : user.activate / user.deactivate

  if not p_active then
    delete from auth.sessions where user_id = p_user;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      perform private.write_audit(v_target.company_id, 'user.sessions_revoked', 'user', p_user::text, v_target.email,
        null, null, jsonb_build_object('count', v_n, 'reason', 'deactivation'), 'rpc');
    end if;
  end if;
end $$;

create function public.rbac_revoke_user_sessions(p_user uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_target public.profiles%rowtype; v_n int;
begin
  perform private.require_perm('sessions.manage');
  select * into v_target from public.profiles where id = p_user and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;
  delete from auth.sessions where user_id = p_user;
  get diagnostics v_n = row_count;
  perform private.write_audit(v_target.company_id, 'user.sessions_revoked', 'user', p_user::text, v_target.email,
    null, null, jsonb_build_object('count', v_n, 'reason', 'manual'), 'rpc');
  return v_n;
end $$;

revoke execute on function public.rbac_create_role(text,text,text)        from public, anon;
revoke execute on function public.rbac_update_role(uuid,text,text)        from public, anon;
revoke execute on function public.rbac_delete_role(uuid)                  from public, anon;
revoke execute on function public.rbac_set_role_permissions(uuid,text[])  from public, anon;
revoke execute on function public.rbac_set_user_roles(uuid,uuid[])        from public, anon;
revoke execute on function public.rbac_set_user_active(uuid,boolean)      from public, anon;
revoke execute on function public.rbac_revoke_user_sessions(uuid)         from public, anon;
grant  execute on function public.rbac_create_role(text,text,text)        to authenticated;
grant  execute on function public.rbac_update_role(uuid,text,text)        to authenticated;
grant  execute on function public.rbac_delete_role(uuid)                  to authenticated;
grant  execute on function public.rbac_set_role_permissions(uuid,text[])  to authenticated;
grant  execute on function public.rbac_set_user_roles(uuid,uuid[])        to authenticated;
grant  execute on function public.rbac_set_user_active(uuid,boolean)      to authenticated;
grant  execute on function public.rbac_revoke_user_sessions(uuid)         to authenticated;

-- ---------------------------------------------------------------------
-- 9. JWT : ajoute app_permissions (contrôle d'accès des routes dans le middleware)
--    Les changements de droits sont pris en compte au prochain renouvellement du
--    jeton ; les guards serveur lisent toujours la base (source de vérité).
-- ---------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := event -> 'claims';
  v_uid    uuid  := (event ->> 'user_id')::uuid;
  v_prof   public.profiles%rowtype;
  v_roles  jsonb;
  v_perms  jsonb;
begin
  select * into v_prof from public.profiles where id = v_uid;
  if not found then
    return event;
  end if;

  select coalesce(jsonb_agg(r.code order by r.code), '[]'::jsonb) into v_roles
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.user_id = v_uid;

  select coalesce(jsonb_agg(distinct pe.code), '[]'::jsonb) into v_perms
  from public.user_roles ur
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions pe on pe.id = rp.permission_id
  where ur.user_id = v_uid;

  v_claims := v_claims
    || jsonb_build_object(
         'company_id',           v_prof.company_id,
         'user_type',            v_prof.user_type,
         'client_id',            v_prof.client_id,
         'app_roles',            v_roles,
         'app_permissions',      v_perms,
         'must_change_password', v_prof.must_change_password,
         'is_active',            v_prof.is_active);

  return jsonb_set(event, '{claims}', v_claims);
end $$;


-- ===== 0004_clients.sql =====
-- =====================================================================
-- 0004_clients — Module Clients
--  clients, contacts, adresses, documents (Storage), conditions de paiement,
--  commercial affecté, archivage, historique (audit_logs), RLS.
--  Permissions : clients.read / clients.write / clients.delete (archiver, restaurer, supprimer)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Séquences de numérotation par société
-- ---------------------------------------------------------------------
create table public.company_sequences (
  company_id uuid not null references public.companies(id) on delete cascade,
  key        text not null,
  last_value int  not null default 0,
  primary key (company_id, key)
);
alter table public.company_sequences enable row level security;   -- aucune politique : accès via fonctions uniquement
revoke all on public.company_sequences from anon, authenticated;

create function private.next_seq(p_company uuid, p_key text) returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  insert into public.company_sequences (company_id, key, last_value) values (p_company, p_key, 1)
  on conflict (company_id, key) do update set last_value = public.company_sequences.last_value + 1
  returning last_value into v;
  return v;
end $$;
revoke execute on function private.next_seq(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Conditions de paiement (catalogue par société)
-- ---------------------------------------------------------------------
create table public.payment_terms (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  code         text not null,
  label        text not null,
  days         int  not null default 0 check (days between 0 and 365),
  end_of_month boolean not null default false,
  is_active    boolean not null default true,
  sort_order   int  not null default 0,
  unique (company_id, code)
);
alter table public.payment_terms enable row level security;
revoke all on public.payment_terms from anon, authenticated;
grant select on public.payment_terms to authenticated;
grant all on public.payment_terms to service_role;
create policy payment_terms_select on public.payment_terms for select to authenticated
  using (company_id = private.current_company());

insert into public.payment_terms (company_id, code, label, days, end_of_month, sort_order)
select c.id, v.code, v.label, v.days, v.eom, v.ord
from public.companies c
cross join (values
  ('COMPTANT', 'Comptant', 0, false, 1),
  ('30J',      '30 jours', 30, false, 2),
  ('45J',      '45 jours', 45, false, 3),
  ('60J',      '60 jours', 60, false, 4),
  ('90J',      '90 jours', 90, false, 5),
  ('30FDM',    '30 jours fin de mois', 30, true, 6),
  ('45FDM',    '45 jours fin de mois', 45, true, 7),
  ('60FDM',    '60 jours fin de mois', 60, true, 8)
) v(code, label, days, eom, ord)
on conflict (company_id, code) do nothing;

-- ---------------------------------------------------------------------
-- 3. Clients
-- ---------------------------------------------------------------------
create table public.clients (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id),
  code                    text not null,
  name                    text not null check (length(btrim(name)) between 2 and 120),
  legal_name              text,
  tax_id                  text,                                   -- identifiant fiscal / n° TVA
  registration_no         text,                                   -- registre du commerce
  website                 text,
  email                   text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                   text,
  country                 char(2) not null check (country ~ '^[A-Z]{2}$'),
  currency                char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  language                text not null default 'fr' check (language in ('fr','en','de','es','it','nl')),
  payment_terms_id        uuid references public.payment_terms(id),
  payment_method          text check (payment_method in ('transfer','cheque','lc','cash','other')),
  credit_limit            numeric(15,3) check (credit_limit is null or credit_limit >= 0),
  incoterm                text check (incoterm is null or incoterm in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  vat_exempt              boolean not null default false,
  delivery_tolerance_pct  numeric(5,2) not null default 5 check (delivery_tolerance_pct between 0 and 50),
  aql_level               text,
  sales_rep_id            uuid references public.profiles(id) on delete set null,
  notes                   text,
  archived_at             timestamptz,
  archived_by             uuid,
  archive_reason          text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid,
  updated_by              uuid,
  unique (company_id, code)
);
create unique index clients_tax_id_uq on public.clients (company_id, lower(btrim(tax_id))) where tax_id is not null and btrim(tax_id) <> '';
create unique index clients_name_active_uq on public.clients (company_id, lower(btrim(name))) where archived_at is null;
create index clients_company_idx   on public.clients (company_id, archived_at);
create index clients_sales_rep_idx on public.clients (sales_rep_id);
create index clients_country_idx   on public.clients (company_id, country);

alter table public.profiles
  add constraint profiles_client_fk foreign key (client_id) references public.clients(id);

create table public.client_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) >= 2),
  job_title   text,
  email       text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone       text,
  mobile      text,
  language    text check (language is null or language in ('fr','en','de','es','it','nl')),
  is_primary  boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);
create index client_contacts_client_idx on public.client_contacts (client_id);
create unique index client_contacts_primary_uq on public.client_contacts (client_id) where is_primary;

create table public.client_addresses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
  type        text not null check (type in ('head_office','billing','delivery','other')),
  label       text,
  line1       text not null check (length(btrim(line1)) >= 2),
  line2       text,
  postal_code text,
  city        text not null check (length(btrim(city)) >= 1),
  region      text,
  country     char(2) not null check (country ~ '^[A-Z]{2}$'),
  is_default  boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);
create index client_addresses_client_idx on public.client_addresses (client_id);
create unique index client_addresses_default_uq on public.client_addresses (client_id, type) where is_default;

create table public.client_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  client_id    uuid not null references public.clients(id) on delete cascade,
  title        text not null check (length(btrim(title)) >= 2),
  doc_type     text not null check (doc_type in ('contract','nda','quality_agreement','certificate','specification','tax','identification','other')),
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0 and size_bytes <= 10485760),
  storage_path text not null unique,
  valid_until  date,
  notes        text,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index client_documents_client_idx on public.client_documents (client_id);
create index client_documents_expiry_idx on public.client_documents (company_id, valid_until);

-- ---------------------------------------------------------------------
-- 4. Triggers de cohérence (code auto, normalisation, règles métier)
-- ---------------------------------------------------------------------
create function private.clients_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if new.company_id is null then raise exception 'CLIENT_NO_COMPANY' using errcode = '22023'; end if;
    if nullif(btrim(coalesce(new.code, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'client');
      new.code := 'CLI-' || lpad(v_n::text, 4, '0');
    else
      new.code := upper(btrim(new.code));
    end if;
    if new.code !~ '^[A-Z0-9][A-Z0-9_-]{1,19}$' then raise exception 'CLIENT_INVALID_CODE' using errcode = '22023'; end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;   -- jamais créé archivé
  else
    if new.code is distinct from old.code then raise exception 'CLIENT_CODE_LOCKED' using errcode = '42501'; end if;
    if new.company_id is distinct from old.company_id then raise exception 'CLIENT_CODE_LOCKED' using errcode = '42501'; end if;
    -- un client archivé n'est plus modifiable : il faut d'abord le restaurer
    if old.archived_at is not null and new.archived_at is not null then
      raise exception 'CLIENT_ARCHIVED' using errcode = '55000';
    end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;

  new.name     := btrim(new.name);
  new.country  := upper(new.country);
  new.currency := upper(new.currency);
  new.email    := nullif(btrim(coalesce(new.email, '')), '');

  if new.sales_rep_id is not null and (tg_op = 'INSERT' or new.sales_rep_id is distinct from old.sales_rep_id) then
    if not exists (select 1 from public.profiles p where p.id = new.sales_rep_id and p.company_id = new.company_id and p.is_active) then
      raise exception 'CLIENT_INVALID_REP' using errcode = '22023';
    end if;
  end if;
  if new.payment_terms_id is not null and (tg_op = 'INSERT' or new.payment_terms_id is distinct from old.payment_terms_id) then
    if not exists (select 1 from public.payment_terms t where t.id = new.payment_terms_id and t.company_id = new.company_id and t.is_active) then
      raise exception 'CLIENT_INVALID_TERMS' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

create trigger clients_before_iu before insert or update on public.clients
  for each row execute function private.clients_before();

create function private.client_contacts_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = new.client_id;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_client.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := v_client.company_id;
  new.full_name := btrim(new.full_name);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    -- le premier contact devient principal
    if not exists (select 1 from public.client_contacts where client_id = new.client_id) then new.is_primary := true; end if;
  else
    new.updated_at := now();
  end if;
  new.updated_by := auth.uid();
  if new.is_primary then
    update public.client_contacts set is_primary = false where client_id = new.client_id and id is distinct from new.id and is_primary;
  end if;
  return new;
end $$;

create trigger client_contacts_before_iu before insert or update on public.client_contacts
  for each row execute function private.client_contacts_before();

create function private.client_addresses_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = new.client_id;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_client.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := v_client.company_id;
  new.country := upper(new.country);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.client_addresses where client_id = new.client_id and type = new.type) then new.is_default := true; end if;
  else
    new.updated_at := now();
  end if;
  new.updated_by := auth.uid();
  if new.is_default then
    update public.client_addresses set is_default = false
    where client_id = new.client_id and type = new.type and id is distinct from new.id and is_default;
  end if;
  return new;
end $$;

create trigger client_addresses_before_iu before insert or update on public.client_addresses
  for each row execute function private.client_addresses_before();

create function private.client_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = new.client_id;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_client.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  new.company_id := v_client.company_id;
  if tg_op = 'INSERT' then
    -- le fichier doit être rangé sous <société>/<client>/ (empêche de référencer le fichier d'un autre client)
    if new.storage_path not like new.company_id::text || '/' || new.client_id::text || '/%' then
      raise exception 'CLIENT_INVALID_PATH' using errcode = '22023';
    end if;
    new.uploaded_by := auth.uid();
  else
    if new.storage_path is distinct from old.storage_path or new.client_id is distinct from old.client_id then
      raise exception 'CLIENT_INVALID_PATH' using errcode = '22023';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger client_documents_before_iu before insert or update on public.client_documents
  for each row execute function private.client_documents_before();

-- ---------------------------------------------------------------------
-- 5. Historique des modifications (audit_logs, entity_type = 'client')
-- ---------------------------------------------------------------------
create function private.jsonb_changes(p_old jsonb, p_new jsonb, p_ignore text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'before', coalesce(jsonb_object_agg(k, p_old -> k), '{}'::jsonb),
    'after',  coalesce(jsonb_object_agg(k, p_new -> k), '{}'::jsonb))
  from (select k from jsonb_object_keys(p_new) k
        where not (k = any (p_ignore)) and (p_old -> k) is distinct from (p_new -> k)) s
$$;

create function private.audit_clients() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','archived_at','archived_by','archive_reason'];
  v_chg jsonb;
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' and tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'client.create', 'client', new.id::text, new.name, null, to_jsonb(new) - c_noise);
  elsif tg_op = 'UPDATE' then
    if old.archived_at is null and new.archived_at is not null then
      perform private.write_audit(new.company_id, 'client.archive', 'client', new.id::text, new.name, null, null,
        jsonb_build_object('reason', new.archive_reason));
    elsif old.archived_at is not null and new.archived_at is null then
      perform private.write_audit(new.company_id, 'client.restore', 'client', new.id::text, new.name, null, null);
    else
      v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
      if v_chg -> 'after' <> '{}'::jsonb then
        perform private.write_audit(new.company_id, 'client.update', 'client', new.id::text, new.name, v_chg -> 'before', v_chg -> 'after');
      end if;
    end if;
  else
    perform private.write_audit(old.company_id, 'client.delete', 'client', old.id::text, old.name, to_jsonb(old) - c_noise, null);
  end if;
  return coalesce(new, old);
end $$;

create trigger audit_clients_iud after insert or update or delete on public.clients
  for each row execute function private.audit_clients();

-- Contacts / adresses / documents : entrée dans l'historique du client
create function private.audit_client_child() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','uploaded_by','storage_path'];
  v_kind  text := tg_argv[0];
  v_label text := tg_argv[1];
  v_j     jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_client uuid := (v_j ->> 'client_id')::uuid;
  v_name  text;
  v_chg   jsonb;
  v_act   text := 'client.' || v_kind || '_' || case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  v_meta  jsonb := jsonb_build_object(v_kind, v_j ->> v_label);
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  select name into v_name from public.clients where id = v_client;
  if tg_op = 'INSERT' then
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'client', v_client::text, v_name, null, v_j - c_noise, v_meta);
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'client', v_client::text, v_name, v_chg -> 'before', v_chg -> 'after', v_meta);
    end if;
  else
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'client', v_client::text, v_name, v_j - c_noise, null, v_meta);
  end if;
  return coalesce(new, old);
end $$;

create trigger audit_client_contacts_iud  after insert or update or delete on public.client_contacts
  for each row execute function private.audit_client_child('contact', 'full_name');
create trigger audit_client_addresses_iud after insert or update or delete on public.client_addresses
  for each row execute function private.audit_client_child('address', 'city');
create trigger audit_client_documents_iud after insert or update or delete on public.client_documents
  for each row execute function private.audit_client_child('document', 'title');

-- L'historique d'un client est lisible avec clients.read (sans exiger audit.read)
create policy audit_logs_select_clients on public.audit_logs for select to authenticated
  using (entity_type = 'client' and company_id = private.current_company() and private.has_perm('clients.read'));

-- ---------------------------------------------------------------------
-- 6. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.clients          enable row level security;
alter table public.client_contacts  enable row level security;
alter table public.client_addresses enable row level security;
alter table public.client_documents enable row level security;

revoke all on public.clients, public.client_contacts, public.client_addresses, public.client_documents from anon, authenticated;
grant all on public.clients, public.client_contacts, public.client_addresses, public.client_documents to service_role;

grant select on public.clients, public.client_contacts, public.client_addresses, public.client_documents to authenticated;
-- clients : pas de DELETE direct, ni d'écriture des colonnes d'archivage / code (après création) / audit
grant insert (code, name, legal_name, tax_id, registration_no, website, email, phone, country, currency, language,
              payment_terms_id, payment_method, credit_limit, incoterm, vat_exempt, delivery_tolerance_pct, aql_level,
              sales_rep_id, notes) on public.clients to authenticated;
grant update (name, legal_name, tax_id, registration_no, website, email, phone, country, currency, language,
              payment_terms_id, payment_method, credit_limit, incoterm, vat_exempt, delivery_tolerance_pct, aql_level,
              sales_rep_id, notes) on public.clients to authenticated;
grant insert (client_id, full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.client_contacts to authenticated;
grant update (full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.client_contacts to authenticated;
grant delete on public.client_contacts to authenticated;
grant insert (client_id, type, label, line1, line2, postal_code, city, region, country, is_default, notes) on public.client_addresses to authenticated;
grant update (type, label, line1, line2, postal_code, city, region, country, is_default, notes) on public.client_addresses to authenticated;
grant delete on public.client_addresses to authenticated;
grant insert (client_id, title, doc_type, file_name, mime_type, size_bytes, storage_path, valid_until, notes) on public.client_documents to authenticated;
grant update (title, doc_type, valid_until, notes) on public.client_documents to authenticated;
grant delete on public.client_documents to authenticated;

create policy clients_select on public.clients for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy clients_insert on public.clients for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('clients.write'));
create policy clients_update on public.clients for update to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.write'))
  with check (company_id = private.current_company() and private.has_perm('clients.write'));

do $$
declare t text;
begin
  foreach t in array array['client_contacts','client_addresses','client_documents'] loop
    execute format($f$create policy %1$s_select on public.%1$s for select to authenticated
      using (company_id = private.current_company() and private.has_perm('clients.read'))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (company_id = private.current_company() and private.has_perm('clients.write'))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$s for update to authenticated
      using (company_id = private.current_company() and private.has_perm('clients.write'))
      with check (company_id = private.current_company() and private.has_perm('clients.write'))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$s for delete to authenticated
      using (company_id = private.current_company() and private.has_perm('clients.write'))$f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Annuaire minimal de la société (nom du commercial affecté, etc.)
--    Vue définie par le propriétaire, filtrée sur la société de l'appelant.
-- ---------------------------------------------------------------------
create view public.company_directory as
  select p.id, p.full_name, p.email, p.is_active
  from public.profiles p
  where p.company_id = private.current_company();
revoke all on public.company_directory from anon, authenticated;
grant select on public.company_directory to authenticated;

-- ---------------------------------------------------------------------
-- 8. RPC : commerciaux affectables, archivage, restauration, suppression
-- ---------------------------------------------------------------------
create function public.client_sales_reps() returns table (id uuid, full_name text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('clients.read');
  return query
    select distinct p.id, p.full_name, p.email
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id and pe.code = 'clients.write'
    where p.company_id = private.current_company() and p.is_active
    order by p.full_name;
end $$;

create function public.client_archive(p_client uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  update public.clients set archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_client;
end $$;

create function public.client_restore(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'CLIENT_NOT_ARCHIVED' using errcode = '55000'; end if;
  update public.clients set archived_at = null, archived_by = null, archive_reason = null where id = p_client;
end $$;

-- Suppression définitive : uniquement un client archivé, sans utilisateur portail rattaché
create function public.client_delete(p_client uuid) returns jsonb
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
  select count(*) into v_documents from public.client_documents where client_id = p_client;

  perform set_config('clients.rpc', 'on', true);
  begin
    delete from public.clients where id = p_client;     -- FK d'autres modules (commandes…) : RESTRICT => CLIENT_IN_USE
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

revoke execute on function public.client_sales_reps()            from public, anon;
revoke execute on function public.client_archive(uuid, text)     from public, anon;
revoke execute on function public.client_restore(uuid)           from public, anon;
revoke execute on function public.client_delete(uuid)            from public, anon;
grant  execute on function public.client_sales_reps()            to authenticated;
grant  execute on function public.client_archive(uuid, text)     to authenticated;
grant  execute on function public.client_restore(uuid)           to authenticated;
grant  execute on function public.client_delete(uuid)            to authenticated;

-- La Direction peut archiver / restaurer (validation) ; le reste de la matrice est inchangé
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'clients.delete'
where r.code = 'direction' on conflict do nothing;

-- ---------------------------------------------------------------------
-- 9. Stockage des documents clients (bucket privé)
--    chemin : <company_id>/<client_id>/<uuid>-<fichier>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-docs', 'client-docs', false, 10485760, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- NB : `objects.name` est qualifié, sinon `name` serait résolu vers clients.name dans la sous-requête.
create policy client_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'client-docs' and private.has_perm('clients.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and exists (select 1 from public.clients c where c.id::text = (storage.foldername(objects.name))[2] and c.company_id = private.current_company()));

create policy client_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'client-docs' and private.has_perm('clients.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and exists (select 1 from public.clients c where c.id::text = (storage.foldername(objects.name))[2] and c.company_id = private.current_company()));

create policy client_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'client-docs' and private.has_perm('clients.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and exists (select 1 from public.clients c where c.id::text = (storage.foldername(objects.name))[2] and c.company_id = private.current_company()));


-- ===== 0005_ged.sql =====
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


-- ===== 0006_suppliers.sql =====
-- =====================================================================
-- 0006_suppliers — Module Fournisseurs
--  fiche fournisseur (paiement, délai, incoterm, acheteur référent), contacts,
--  documents (Storage), commandes d'achat minimales (historique + statistiques),
--  archivage, historique (audit_logs, entity_type = 'supplier').
--  Permissions : suppliers.read / suppliers.write / suppliers.delete (nouveau)
--  Le module Achats (à venir) enrichira purchase_orders (lignes, réceptions…).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission d'archivage / suppression
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('suppliers.delete', 'purchases', 'Archiver les fournisseurs', 'Archiver, restaurer, supprimer définitivement un fournisseur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'suppliers.delete'
where r.is_system and r.code in ('admin', 'direction')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.suppliers (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  code                text not null,
  name                text not null check (length(btrim(name)) between 2 and 120),
  legal_name          text,
  category            text not null default 'other' check (category in ('fabric','accessories','packaging','subcontracting','services','other')),
  qualification       text not null default 'pending' check (qualification in ('pending','approved','blocked')),
  rating              smallint check (rating is null or rating between 1 and 5),
  tax_id              text,
  registration_no     text,
  website             text,
  email               text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone               text,
  address_line1       text,
  address_line2       text,
  postal_code         text,
  city                text,
  region              text,
  country             char(2) not null check (country ~ '^[A-Z]{2}$'),
  currency            char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  language            text not null default 'fr' check (language in ('fr','en','de','es','it','nl')),
  payment_terms_id    uuid references public.payment_terms(id),
  payment_method      text check (payment_method in ('transfer','cheque','lc','cash','other')),
  lead_time_days      int check (lead_time_days is null or lead_time_days between 0 and 365),
  min_order_amount    numeric(15,3) check (min_order_amount is null or min_order_amount >= 0),
  incoterm            text check (incoterm is null or incoterm in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  incoterm_place      text,
  buyer_id            uuid references public.profiles(id) on delete set null,
  notes               text,
  archived_at         timestamptz,
  archived_by         uuid,
  archive_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  unique (company_id, code)
);
create unique index suppliers_tax_id_uq on public.suppliers (company_id, lower(btrim(tax_id))) where tax_id is not null and btrim(tax_id) <> '';
create unique index suppliers_name_active_uq on public.suppliers (company_id, lower(btrim(name))) where archived_at is null;
create index suppliers_company_idx on public.suppliers (company_id, archived_at);
create index suppliers_buyer_idx   on public.suppliers (buyer_id);

create table public.supplier_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) >= 2),
  job_title   text,
  email       text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone       text,
  mobile      text,
  language    text check (language is null or language in ('fr','en','de','es','it','nl')),
  is_primary  boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);
create index supplier_contacts_idx on public.supplier_contacts (supplier_id);
create unique index supplier_contacts_primary_uq on public.supplier_contacts (supplier_id) where is_primary;

create table public.supplier_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  supplier_id  uuid not null references public.suppliers(id) on delete cascade,
  title        text not null check (length(btrim(title)) >= 2),
  doc_type     text not null check (doc_type in ('contract','price_list','certificate','quality_agreement','nda','tax','identification','other')),
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0 and size_bytes <= 10485760),
  storage_path text not null unique,
  valid_until  date,
  notes        text,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index supplier_documents_idx on public.supplier_documents (supplier_id);

-- Commandes d'achat : version minimale (en-tête). Le module Achats ajoutera lignes, réceptions, workflow.
create table public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  supplier_id   uuid not null references public.suppliers(id),     -- RESTRICT : un fournisseur commandé ne peut être supprimé
  po_no         text not null,
  status        text not null default 'draft' check (status in ('draft','sent','partial','received','cancelled')),
  order_date    date not null default current_date,
  expected_date date,
  received_date date,
  currency      char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  total_amount  numeric(15,3) not null default 0 check (total_amount >= 0),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  unique (company_id, po_no)
);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id, order_date desc);

-- ---------------------------------------------------------------------
-- 3. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.suppliers_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if new.company_id is null then raise exception 'SUPPLIER_NO_COMPANY' using errcode = '22023'; end if;
    if nullif(btrim(coalesce(new.code, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'supplier');
      new.code := 'FOU-' || lpad(v_n::text, 4, '0');
    else
      new.code := upper(btrim(new.code));
    end if;
    if new.code !~ '^[A-Z0-9][A-Z0-9_-]{1,19}$' then raise exception 'SUPPLIER_INVALID_CODE' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;
  else
    if new.code is distinct from old.code or new.company_id is distinct from old.company_id then
      raise exception 'SUPPLIER_CODE_LOCKED' using errcode = '42501';
    end if;
    if old.archived_at is not null and new.archived_at is not null then
      raise exception 'SUPPLIER_ARCHIVED' using errcode = '55000';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.name := btrim(new.name); new.country := upper(new.country); new.currency := upper(new.currency);
  new.email := nullif(btrim(coalesce(new.email, '')), '');

  if new.buyer_id is not null and (tg_op = 'INSERT' or new.buyer_id is distinct from old.buyer_id) then
    if not exists (select 1 from public.profiles p where p.id = new.buyer_id and p.company_id = new.company_id and p.is_active) then
      raise exception 'SUPPLIER_INVALID_BUYER' using errcode = '22023';
    end if;
  end if;
  if new.payment_terms_id is not null and (tg_op = 'INSERT' or new.payment_terms_id is distinct from old.payment_terms_id) then
    if not exists (select 1 from public.payment_terms t where t.id = new.payment_terms_id and t.company_id = new.company_id and t.is_active) then
      raise exception 'SUPPLIER_INVALID_TERMS' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger suppliers_before_iu before insert or update on public.suppliers
  for each row execute function private.suppliers_before();

create function private.supplier_assert_open(p_supplier uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v public.suppliers%rowtype;
begin
  select * into v from public.suppliers where id = p_supplier;
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'SUPPLIER_ARCHIVED' using errcode = '55000'; end if;
end $$;
revoke execute on function private.supplier_assert_open(uuid) from public, anon, authenticated;

create function private.supplier_contacts_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.supplier_assert_open(new.supplier_id);
  select company_id into new.company_id from public.suppliers where id = new.supplier_id;
  if tg_op = 'UPDATE' and new.supplier_id is distinct from old.supplier_id then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  new.full_name := btrim(new.full_name);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.supplier_contacts where supplier_id = new.supplier_id) then new.is_primary := true; end if;
  else
    new.updated_at := now();
  end if;
  new.updated_by := auth.uid();
  if new.is_primary then
    update public.supplier_contacts set is_primary = false where supplier_id = new.supplier_id and id is distinct from new.id and is_primary;
  end if;
  return new;
end $$;
create trigger supplier_contacts_before_iu before insert or update on public.supplier_contacts
  for each row execute function private.supplier_contacts_before();

create function private.supplier_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.supplier_assert_open(new.supplier_id);
  select company_id into new.company_id from public.suppliers where id = new.supplier_id;
  if tg_op = 'INSERT' then
    if new.storage_path not like new.company_id::text || '/' || new.supplier_id::text || '/%' then
      raise exception 'SUPPLIER_INVALID_PATH' using errcode = '22023';
    end if;
    new.uploaded_by := auth.uid();
  else
    if new.storage_path is distinct from old.storage_path or new.supplier_id is distinct from old.supplier_id then
      raise exception 'SUPPLIER_INVALID_PATH' using errcode = '22023';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger supplier_documents_before_iu before insert or update on public.supplier_documents
  for each row execute function private.supplier_documents_before();

create function private.purchase_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    perform private.supplier_assert_open(new.supplier_id);
    select company_id into new.company_id from public.suppliers where id = new.supplier_id;
    if nullif(btrim(coalesce(new.po_no, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'po-' || extract(year from current_date)::text);
      new.po_no := 'PO-' || extract(year from current_date)::text || '-' || lpad(v_n::text, 5, '0');
    end if;
    new.created_by := auth.uid();
  else
    if new.supplier_id is distinct from old.supplier_id or new.company_id is distinct from old.company_id then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
    end if;
    new.updated_at := now();
  end if;
  if new.status = 'received' and new.received_date is null then new.received_date := current_date; end if;
  return new;
end $$;
create trigger purchase_orders_before_iu before insert or update on public.purchase_orders
  for each row execute function private.purchase_orders_before();

-- ---------------------------------------------------------------------
-- 4. Historique (audit_logs, entity_type = 'supplier')
-- ---------------------------------------------------------------------
create function private.audit_suppliers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','archived_at','archived_by','archive_reason'];
  v_chg jsonb;
begin
  if coalesce(current_setting('suppliers.rpc', true), 'off') = 'on' and tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'supplier.create', 'supplier', new.id::text, new.name, null, to_jsonb(new) - c_noise);
  elsif tg_op = 'UPDATE' then
    if old.archived_at is null and new.archived_at is not null then
      perform private.write_audit(new.company_id, 'supplier.archive', 'supplier', new.id::text, new.name, null, null, jsonb_build_object('reason', new.archive_reason));
    elsif old.archived_at is not null and new.archived_at is null then
      perform private.write_audit(new.company_id, 'supplier.restore', 'supplier', new.id::text, new.name, null, null);
    else
      v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
      if v_chg -> 'after' <> '{}'::jsonb then
        perform private.write_audit(new.company_id, 'supplier.update', 'supplier', new.id::text, new.name, v_chg -> 'before', v_chg -> 'after');
      end if;
    end if;
  else
    perform private.write_audit(old.company_id, 'supplier.delete', 'supplier', old.id::text, old.name, to_jsonb(old) - c_noise, null);
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_suppliers_iud after insert or update or delete on public.suppliers
  for each row execute function private.audit_suppliers();

create function private.audit_supplier_child() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','uploaded_by','storage_path'];
  v_kind  text := tg_argv[0];
  v_label text := tg_argv[1];
  v_j     jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_sup   uuid := (v_j ->> 'supplier_id')::uuid;
  v_name  text;
  v_chg   jsonb;
  v_act   text := 'supplier.' || v_kind || '_' || case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  v_meta  jsonb := jsonb_build_object(v_kind, v_j ->> v_label);
begin
  if coalesce(current_setting('suppliers.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  select name into v_name from public.suppliers where id = v_sup;
  if tg_op = 'INSERT' then
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'supplier', v_sup::text, v_name, null, v_j - c_noise, v_meta);
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'supplier', v_sup::text, v_name, v_chg -> 'before', v_chg -> 'after', v_meta);
    end if;
  else
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'supplier', v_sup::text, v_name, v_j - c_noise, null, v_meta);
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_supplier_contacts_iud  after insert or update or delete on public.supplier_contacts
  for each row execute function private.audit_supplier_child('contact', 'full_name');
create trigger audit_supplier_documents_iud after insert or update or delete on public.supplier_documents
  for each row execute function private.audit_supplier_child('document', 'title');

create policy audit_logs_select_suppliers on public.audit_logs for select to authenticated
  using (entity_type = 'supplier' and company_id = private.current_company() and private.has_perm('suppliers.read'));

-- ---------------------------------------------------------------------
-- 5. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.suppliers          enable row level security;
alter table public.supplier_contacts  enable row level security;
alter table public.supplier_documents enable row level security;
alter table public.purchase_orders    enable row level security;

revoke all on public.suppliers, public.supplier_contacts, public.supplier_documents, public.purchase_orders from anon, authenticated;
grant all on public.suppliers, public.supplier_contacts, public.supplier_documents, public.purchase_orders to service_role;
grant select on public.suppliers, public.supplier_contacts, public.supplier_documents, public.purchase_orders to authenticated;

grant insert (code, name, legal_name, category, qualification, rating, tax_id, registration_no, website, email, phone,
              address_line1, address_line2, postal_code, city, region, country, currency, language, payment_terms_id,
              payment_method, lead_time_days, min_order_amount, incoterm, incoterm_place, buyer_id, notes) on public.suppliers to authenticated;
grant update (name, legal_name, category, qualification, rating, tax_id, registration_no, website, email, phone,
              address_line1, address_line2, postal_code, city, region, country, currency, language, payment_terms_id,
              payment_method, lead_time_days, min_order_amount, incoterm, incoterm_place, buyer_id, notes) on public.suppliers to authenticated;
grant insert (supplier_id, full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.supplier_contacts to authenticated;
grant update (full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.supplier_contacts to authenticated;
grant delete on public.supplier_contacts to authenticated;
grant insert (supplier_id, title, doc_type, file_name, mime_type, size_bytes, storage_path, valid_until, notes) on public.supplier_documents to authenticated;
grant update (title, doc_type, valid_until, notes) on public.supplier_documents to authenticated;
grant delete on public.supplier_documents to authenticated;
grant insert (supplier_id, po_no, status, order_date, expected_date, received_date, currency, total_amount, notes) on public.purchase_orders to authenticated;
grant update (status, order_date, expected_date, received_date, currency, total_amount, notes) on public.purchase_orders to authenticated;

create policy suppliers_select on public.suppliers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('suppliers.read'));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('suppliers.write'));
create policy suppliers_update on public.suppliers for update to authenticated
  using (company_id = private.current_company() and private.has_perm('suppliers.write'))
  with check (company_id = private.current_company() and private.has_perm('suppliers.write'));

do $$
declare t text;
begin
  foreach t in array array['supplier_contacts','supplier_documents'] loop
    execute format($f$create policy %1$s_select on public.%1$s for select to authenticated
      using (company_id = private.current_company() and private.has_perm('suppliers.read'))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (company_id = private.current_company() and private.has_perm('suppliers.write'))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$s for update to authenticated
      using (company_id = private.current_company() and private.has_perm('suppliers.write'))
      with check (company_id = private.current_company() and private.has_perm('suppliers.write'))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$s for delete to authenticated
      using (company_id = private.current_company() and private.has_perm('suppliers.write'))$f$, t);
  end loop;
end $$;

-- Commandes d'achat : lecture avec purchases.read, écriture avec purchases.write (le module Achats les pilotera)
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy purchase_orders_insert on public.purchase_orders for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('purchases.write'));
create policy purchase_orders_update on public.purchase_orders for update to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.write'))
  with check (company_id = private.current_company() and private.has_perm('purchases.write'));

-- ---------------------------------------------------------------------
-- 6. RPC : acheteurs affectables, archivage, restauration, suppression, statistiques
-- ---------------------------------------------------------------------
create function public.supplier_buyers() returns table (id uuid, full_name text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('suppliers.read');
  return query
    select distinct p.id, p.full_name, p.email
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id and pe.code = 'suppliers.write'
    where p.company_id = private.current_company() and p.is_active
    order by p.full_name;
end $$;

create function public.supplier_archive(p_supplier uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.suppliers%rowtype;
begin
  perform private.require_perm('suppliers.delete');
  select * into v from public.suppliers where id = p_supplier and company_id = private.current_company();
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'SUPPLIER_ARCHIVED' using errcode = '55000'; end if;
  update public.suppliers set archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_supplier;
end $$;

create function public.supplier_restore(p_supplier uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.suppliers%rowtype;
begin
  perform private.require_perm('suppliers.delete');
  select * into v from public.suppliers where id = p_supplier and company_id = private.current_company();
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'SUPPLIER_NOT_ARCHIVED' using errcode = '55000'; end if;
  update public.suppliers set archived_at = null, archived_by = null, archive_reason = null where id = p_supplier;
end $$;

-- Suppression définitive : fournisseur archivé et jamais commandé. Renvoie les fichiers à effacer du Storage.
create function public.supplier_delete(p_supplier uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.suppliers%rowtype; v_contacts int; v_files jsonb;
begin
  perform private.require_perm('suppliers.delete');
  select * into v from public.suppliers where id = p_supplier and company_id = private.current_company();
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'SUPPLIER_NOT_ARCHIVED' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_orders where supplier_id = p_supplier) then
    raise exception 'SUPPLIER_IN_USE' using errcode = '23503';
  end if;
  select count(*) into v_contacts from public.supplier_contacts where supplier_id = p_supplier;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', 'supplier-docs', 'path', storage_path)), '[]'::jsonb) into v_files
  from public.supplier_documents where supplier_id = p_supplier;

  perform set_config('suppliers.rpc', 'on', true);
  delete from public.suppliers where id = p_supplier;
  perform set_config('suppliers.rpc', 'off', true);

  perform private.write_audit(v.company_id, 'supplier.delete', 'supplier', v.id::text, v.name,
    to_jsonb(v) - array['company_id','created_at','updated_at','created_by','updated_by'], null,
    jsonb_build_object('contacts', v_contacts, 'documents', jsonb_array_length(v_files)), 'rpc');
  return v_files;
end $$;

-- Statistiques d'achats (montants dans la devise de chaque commande ; commandes annulées exclues)
create function public.supplier_purchase_stats(p_supplier uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform private.require_perm('purchases.read');
  if not exists (select 1 from public.suppliers where id = p_supplier and company_id = private.current_company()) then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'orders_count',  count(*) filter (where status <> 'cancelled'),
    'open_orders',   count(*) filter (where status in ('draft','sent','partial')),
    'cancelled',     count(*) filter (where status = 'cancelled'),
    'total_amount',  coalesce(sum(total_amount) filter (where status <> 'cancelled'), 0),
    'avg_order',     coalesce(round(avg(total_amount) filter (where status <> 'cancelled'), 3), 0),
    'last_order',    max(order_date) filter (where status <> 'cancelled'),
    'received_count', count(*) filter (where status = 'received'),
    'on_time_rate',  case when count(*) filter (where status = 'received' and expected_date is not null) = 0 then null
                     else round(100.0 * count(*) filter (where status = 'received' and expected_date is not null and received_date <= expected_date)
                                / count(*) filter (where status = 'received' and expected_date is not null), 1) end,
    'avg_lead_days', round(avg(received_date - order_date) filter (where status = 'received' and received_date is not null), 1),
    'late_open',     count(*) filter (where status in ('sent','partial') and expected_date is not null and expected_date < current_date),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'amount', coalesce(x.amount, 0), 'count', coalesce(x.n, 0)) order by m.month)
      from (select to_char(date_trunc('month', current_date) - (g || ' month')::interval, 'YYYY-MM') as month from generate_series(0, 11) g) m
      left join (select to_char(date_trunc('month', order_date), 'YYYY-MM') as month, sum(total_amount) as amount, count(*) as n
                 from public.purchase_orders where supplier_id = p_supplier and status <> 'cancelled' group by 1) x on x.month = m.month
    ), '[]'::jsonb)
  ) into v_result
  from public.purchase_orders where supplier_id = p_supplier;
  return v_result;
end $$;

do $$
declare f text;
begin
  foreach f in array array['supplier_buyers()', 'supplier_archive(uuid,text)', 'supplier_restore(uuid)', 'supplier_delete(uuid)', 'supplier_purchase_stats(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Stockage : bucket privé `supplier-docs` (10 Mo) — chemin <company>/<supplier>/<uuid>-<fichier>
-- ---------------------------------------------------------------------
create function private.storage_supplier_ok(p_supplier text, p_require_open boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.suppliers s
    where s.id::text = p_supplier and s.company_id = private.current_company()
      and (not p_require_open or s.archived_at is null))
$$;
grant execute on function private.storage_supplier_ok(text, boolean) to authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-docs', 'supplier-docs', false, 10485760, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy supplier_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'supplier-docs' and private.has_perm('suppliers.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_supplier_ok((storage.foldername(objects.name))[2]));
create policy supplier_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'supplier-docs' and private.has_perm('suppliers.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_supplier_ok((storage.foldername(objects.name))[2], true));
create policy supplier_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'supplier-docs' and private.has_perm('suppliers.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_supplier_ok((storage.foldername(objects.name))[2]));


-- ===== 0007_articles.sql =====
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


-- ===== 0008_bom.sql =====
-- =====================================================================
-- 0008_bom — Module BOM (nomenclatures produit)
--  Composants (matières, mercerie…) + prix, nomenclatures versionnées (brouillon → validée → obsolète),
--  multi-niveaux (sous-ensembles), opérations de main-d'œuvre, duplication, archivage,
--  calcul du coût matière / main-d'œuvre / revient, vue arbre, historique (audit_logs, entity_type 'bom' | 'material').
--
--  Visibilité des coûts : la structure d'une nomenclature se lit avec `bom.read` ; les PRIX (composants),
--  le taux horaire, les frais généraux et tous les montants exigent en plus `costs.read` (tables séparées,
--  RLS dédiée, fonctions de calcul filtrées). Monnaie de calcul unique : EUR.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('bom.read',     'bom', 'Voir les nomenclatures', 'Nomenclatures, composants, vue arbre (les coûts exigent aussi « Voir les coûts et marges »)'),
  ('bom.write',    'bom', 'Gérer les nomenclatures', 'Créer / modifier / dupliquer / archiver les nomenclatures et le catalogue de composants'),
  ('bom.validate', 'bom', 'Valider les versions de nomenclature', 'Valider un brouillon de nomenclature (calcul et gel du coût de revient)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('bom.read', 'bom.write', 'bom.validate'))
  or (r.code = 'direction'  and p.code in ('bom.read', 'bom.validate'))
  or (r.code = 'commercial' and p.code = 'bom.read')
  or (r.code = 'achat'      and p.code in ('bom.read', 'bom.write', 'costs.read'))   -- l'achat tient le catalogue et les prix
  or (r.code = 'production' and p.code in ('bom.read', 'bom.write'))
  or (r.code = 'qualite'    and p.code in ('bom.read', 'bom.validate'))
  or (r.code = 'magasin'    and p.code = 'bom.read')
  or (r.code = 'finance'    and p.code = 'bom.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Catalogue de composants et prix
-- ---------------------------------------------------------------------
create table public.bom_materials (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null,                                              -- MAT-0001 (généré, immuable)
  name        text not null check (length(btrim(name)) between 2 and 160),
  category    text not null default 'other' check (category in ('fabric','lining','zip','button','thread','label','reflective','trim','packaging','other')),
  unit        text not null default 'pc' check (unit in ('m','m2','pc','kg','cm')),
  color       text check (color is null or length(color) <= 60),
  supplier_id uuid references public.suppliers(id) on delete set null,
  description text check (description is null or length(description) <= 500),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code)
);
create index bom_materials_idx on public.bom_materials (company_id, category, name);

create table public.bom_material_prices (
  material_id uuid primary key references public.bom_materials(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  unit_cost   numeric(14,4) not null check (unit_cost >= 0 and unit_cost < 1000000000),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- ---------------------------------------------------------------------
-- 3. Nomenclatures, versions, lignes, opérations
-- ---------------------------------------------------------------------
create table public.boms (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  code               text not null,                                       -- BOM-0001 (généré, immuable)
  name               text not null check (length(btrim(name)) between 2 and 160),
  kind               text not null default 'product' check (kind in ('product','subassembly')),
  article_id         uuid references public.articles(id),                 -- RESTRICT : un article avec nomenclature ne se supprime pas
  description        text check (description is null or length(description) <= 2000),
  current_version_id uuid,
  active_version_id  uuid,
  archived_at        timestamptz,
  archived_by        uuid,
  archive_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  unique (company_id, code),
  constraint boms_subassembly_no_article check (kind = 'product' or article_id is null)
);
create unique index boms_article_uq on public.boms (article_id) where article_id is not null and archived_at is null;
create index boms_idx on public.boms (company_id, kind, archived_at);

create table public.bom_versions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  bom_id             uuid not null references public.boms(id) on delete cascade,
  version_no         int  not null check (version_no >= 1),
  status             text not null default 'draft' check (status in ('draft','validated','obsolete')),
  change_note        text check (change_note is null or length(change_note) <= 500),
  validated_by       uuid,
  validated_at       timestamptz,
  validation_comment text,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (bom_id, version_no)
);
create unique index bom_versions_one_draft_uq on public.bom_versions (bom_id) where status = 'draft';

alter table public.boms
  add constraint boms_current_version_fk foreign key (current_version_id) references public.bom_versions(id) deferrable initially deferred,
  add constraint boms_active_version_fk  foreign key (active_version_id)  references public.bom_versions(id) deferrable initially deferred;

-- Paramètres de coût d'une version + coût figé à la validation (confidentiels : costs.read)
create table public.bom_version_costs (
  version_id    uuid primary key references public.bom_versions(id) on delete cascade,
  company_id    uuid not null references public.companies(id),
  hourly_rate   numeric(10,4) not null default 0 check (hourly_rate >= 0 and hourly_rate <= 1000),
  overhead_pct  numeric(6,2)  not null default 0 check (overhead_pct >= 0 and overhead_pct <= 300),
  snap_material numeric(14,4),
  snap_labor    numeric(14,4),
  snap_overhead numeric(14,4),
  snap_total    numeric(14,4),
  frozen_at     timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table public.bom_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  bom_id       uuid not null references public.boms(id) on delete cascade,
  version_id   uuid not null references public.bom_versions(id) on delete cascade,
  pos          int  not null default 0,
  line_type    text not null check (line_type in ('material','bom')),
  material_id  uuid references public.bom_materials(id),
  child_bom_id uuid references public.boms(id),
  quantity     numeric(14,4) not null check (quantity > 0 and quantity <= 1000000),
  waste_pct    numeric(6,2)  not null default 0 check (waste_pct >= 0 and waste_pct <= 100),
  note         text check (note is null or length(note) <= 300),
  created_at   timestamptz not null default now(),
  constraint bom_lines_kind_ck check (
    (line_type = 'material' and material_id is not null and child_bom_id is null)
    or (line_type = 'bom' and child_bom_id is not null and material_id is null and waste_pct = 0))
);
create index bom_lines_version_idx  on public.bom_lines (version_id, pos);
create index bom_lines_child_idx    on public.bom_lines (child_bom_id) where child_bom_id is not null;
create index bom_lines_material_idx on public.bom_lines (material_id) where material_id is not null;

create table public.bom_operations (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  bom_id     uuid not null references public.boms(id) on delete cascade,
  version_id uuid not null references public.bom_versions(id) on delete cascade,
  pos        int  not null default 0,
  name       text not null check (length(btrim(name)) between 2 and 120),
  minutes    numeric(8,2) not null check (minutes > 0 and minutes <= 600),
  note       text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now()
);
create index bom_operations_version_idx on public.bom_operations (version_id, pos);

-- ---------------------------------------------------------------------
-- 4. Garde-fous communs
-- ---------------------------------------------------------------------
create function private.bom_rpc() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('bom.rpc', true), 'off') = 'on' $$;

-- Une nomenclature est modifiable si elle n'est pas archivée et si le client de son article n'est pas archivé
create function private.bom_assert_writable(p_bom uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  select * into b from public.boms where id = p_bom;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.archived_at is not null then raise exception 'BOM_ARCHIVED' using errcode = '55000'; end if;
  if b.article_id is not null then
    perform private.ged_assert_client_open((select client_id from public.articles where id = b.article_id));
  end if;
end $$;

-- Le BOM « p_from » contient-il « p_target » parmi ses descendants (toutes versions confondues) ?
create function private.bom_reaches(p_from uuid, p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive d(id) as (
    select child_bom_id from public.bom_lines where bom_id = p_from and line_type = 'bom'
    union
    select l.child_bom_id from public.bom_lines l join d on l.bom_id = d.id where l.line_type = 'bom')
  select exists (select 1 from d where id = p_target) $$;

-- Recalcule dernière version / version validée d'une nomenclature
create function private.bom_refresh(p_bom uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cur uuid; v_act uuid; v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  select id into v_cur from public.bom_versions where bom_id = p_bom order by version_no desc limit 1;
  select id into v_act from public.bom_versions where bom_id = p_bom and status = 'validated' limit 1;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set current_version_id = v_cur, active_version_id = v_act where id = p_bom;
  perform set_config('bom.rpc', v_prev, true);
end $$;

-- ---------------------------------------------------------------------
-- 5. Triggers : composants et prix
-- ---------------------------------------------------------------------
create function private.bom_materials_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'MAT-' || lpad(private.next_seq(new.company_id, 'material')::text, 4, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid(); new.archived_at := null;
  else
    if new.unit is distinct from old.unit and exists (select 1 from public.bom_lines where material_id = old.id) then
      raise exception 'BOM_MATERIAL_UNIT_LOCKED' using errcode = '55000';   -- l'unité d'un composant utilisé ne change plus
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.name := btrim(new.name);
  new.color := nullif(btrim(coalesce(new.color, '')), '');
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  if new.supplier_id is not null and not exists (select 1 from public.suppliers s where s.id = new.supplier_id and s.company_id = new.company_id) then
    raise exception 'BOM_BAD_SUPPLIER' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger bom_materials_before_iu before insert or update on public.bom_materials
  for each row execute function private.bom_materials_before();

create function private.bom_prices_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select company_id into new.company_id from public.bom_materials where id = new.material_id;
  if new.company_id is null then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
create trigger bom_prices_before_iu before insert or update on public.bom_material_prices
  for each row execute function private.bom_prices_before();

-- ---------------------------------------------------------------------
-- 6. Triggers : nomenclatures, versions, lignes, opérations
-- ---------------------------------------------------------------------
create function private.boms_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_art public.articles%rowtype;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'BOM-' || lpad(private.next_seq(new.company_id, 'bom')::text, 4, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.current_version_id := null; new.active_version_id := null; new.archived_at := null; new.archived_by := null; new.archive_reason := null;
  elsif not private.bom_rpc() then
    if old.archived_at is not null then raise exception 'BOM_ARCHIVED' using errcode = '55000'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  if new.article_id is not null and (tg_op = 'INSERT' or new.article_id is distinct from old.article_id) then
    select * into v_art from public.articles where id = new.article_id;
    if not found or v_art.company_id <> new.company_id then raise exception 'BOM_BAD_ARTICLE' using errcode = '22023'; end if;
    perform private.ged_assert_client_open(v_art.client_id);
  end if;
  new.name := btrim(new.name);
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  return new;
end $$;
create trigger boms_before_iu before insert or update on public.boms
  for each row execute function private.boms_before();

-- Chaque nomenclature reçoit sa version 1 (brouillon) et ses paramètres de coût
create function private.boms_seed_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  perform set_config('bom.rpc', 'on', true);
  insert into public.bom_versions (company_id, bom_id, version_no, change_note) values (new.company_id, new.id, 1, 'Création de la nomenclature');
  perform set_config('bom.rpc', v_prev, true);
  perform private.bom_refresh(new.id);
  return new;
end $$;
create trigger boms_seed_version_i after insert on public.boms
  for each row execute function private.boms_seed_version();

create function private.bom_versions_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into b from public.boms where id = new.bom_id;
    if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := b.company_id; new.status := 'draft'; new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.validated_by := null; new.validated_at := null; new.validation_comment := null;
  else
    if not private.bom_rpc() then
      perform private.bom_assert_writable(new.bom_id);
      if new.bom_id is distinct from old.bom_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at then
        raise exception 'BOM_VERSION_LOCKED' using errcode = '42501';
      end if;
      if old.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger bom_versions_before_iu before insert or update on public.bom_versions
  for each row execute function private.bom_versions_before();

create function private.bom_versions_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.bom_version_costs (version_id, company_id) values (new.id, new.company_id) on conflict do nothing;
  end if;
  perform private.bom_refresh(coalesce(new.bom_id, old.bom_id));
  return coalesce(new, old);
end $$;
create trigger bom_versions_after_iud after insert or update of status or delete on public.bom_versions
  for each row execute function private.bom_versions_after();

create function private.bom_costs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype;
begin
  select * into v from public.bom_versions where id = new.version_id;
  new.company_id := v.company_id;
  if not private.bom_rpc() then
    perform private.bom_assert_writable(v.bom_id);
    if v.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
    new.snap_material := old.snap_material; new.snap_labor := old.snap_labor; new.snap_overhead := old.snap_overhead;
    new.snap_total := old.snap_total; new.frozen_at := old.frozen_at;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
create trigger bom_costs_before_u before update on public.bom_version_costs
  for each row execute function private.bom_costs_before();

-- Lignes
create function private.bom_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; m public.bom_materials%rowtype; c public.boms%rowtype; v_ver uuid := coalesce(new.version_id, old.version_id);
begin
  select * into v from public.bom_versions where id = v_ver;
  if not private.bom_rpc() and found then
    perform private.bom_assert_writable(v.bom_id);
    if v.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'INSERT' then
    if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := v.company_id; new.bom_id := v.bom_id;
    if new.pos is null or new.pos <= 0 then
      new.pos := coalesce((select max(pos) from public.bom_lines where version_id = new.version_id), 0) + 1;
    end if;
    if not private.bom_rpc() then
      if new.line_type = 'material' then
        select * into m from public.bom_materials where id = new.material_id;
        if not found or m.company_id <> v.company_id then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
        if m.archived_at is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
      else
        select * into c from public.boms where id = new.child_bom_id;
        if not found or c.company_id <> v.company_id then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
        if c.archived_at is not null then raise exception 'BOM_CHILD_ARCHIVED' using errcode = '55000'; end if;
        if c.id = v.bom_id or private.bom_reaches(c.id, v.bom_id) then raise exception 'BOM_CYCLE' using errcode = '23514'; end if;
      end if;
    end if;
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger bom_lines_before_iud before insert or update or delete on public.bom_lines
  for each row execute function private.bom_lines_before();

-- Opérations
create function private.bom_operations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; v_ver uuid := coalesce(new.version_id, old.version_id);
begin
  select * into v from public.bom_versions where id = v_ver;
  if not private.bom_rpc() and found then
    perform private.bom_assert_writable(v.bom_id);
    if v.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := v.company_id; new.bom_id := v.bom_id;
    if new.pos is null or new.pos <= 0 then
      new.pos := coalesce((select max(pos) from public.bom_operations where version_id = new.version_id), 0) + 1;
    end if;
  end if;
  new.name := btrim(new.name);
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger bom_operations_before_iud before insert or update or delete on public.bom_operations
  for each row execute function private.bom_operations_before();

-- « Modifié le » de la nomenclature suit ses lignes / opérations
create function private.bom_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_bom uuid := coalesce(new.bom_id, old.bom_id); v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  if v_prev = 'on' then return coalesce(new, old); end if;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set updated_at = now(), updated_by = auth.uid() where id = v_bom;
  perform set_config('bom.rpc', v_prev, true);
  return coalesce(new, old);
end $$;
create trigger bom_lines_touch_iud after insert or update or delete on public.bom_lines for each row execute function private.bom_touch();
create trigger bom_operations_touch_iud after insert or update or delete on public.bom_operations for each row execute function private.bom_touch();

-- ---------------------------------------------------------------------
-- 7. Calcul des coûts
--    matière  = Σ quantité × (1 + perte %) × prix unitaire  (+ quantité × matière du sous-ensemble)
--    main-d'œuvre = Σ minutes / 60 × taux horaire           (+ quantité × main-d'œuvre du sous-ensemble)
--    frais généraux = (matière + main-d'œuvre) × %          (appliqués au niveau du produit fini uniquement)
--    coût de revient = matière + main-d'œuvre + frais généraux
--    Un sous-ensemble est valorisé avec sa version VALIDÉE.
-- ---------------------------------------------------------------------
create function private.bom_calc(p_version uuid, p_depth int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  vc public.bom_version_costs%rowtype; r record; sub jsonb; v_child uuid;
  v_mat numeric := 0; v_lab numeric := 0; v_ov numeric; v_min numeric; v_missing jsonb := '[]'::jsonb;
begin
  if p_depth > 8 then raise exception 'BOM_TOO_DEEP' using errcode = '54001'; end if;
  select * into vc from public.bom_version_costs where version_id = p_version;
  for r in
    select l.line_type, l.quantity, l.waste_pct, l.child_bom_id, m.code m_code, pr.unit_cost, cb.code c_code, cb.active_version_id c_active
    from public.bom_lines l
    left join public.bom_materials m on m.id = l.material_id
    left join public.bom_material_prices pr on pr.material_id = l.material_id
    left join public.boms cb on cb.id = l.child_bom_id
    where l.version_id = p_version
  loop
    if r.line_type = 'material' then
      if r.unit_cost is null then v_missing := v_missing || to_jsonb(r.m_code);
      else v_mat := v_mat + r.quantity * (1 + r.waste_pct / 100) * r.unit_cost; end if;
    else
      if r.c_active is null then v_missing := v_missing || to_jsonb(r.c_code);
      else
        sub := private.bom_calc(r.c_active, p_depth + 1);
        v_mat := v_mat + r.quantity * (sub ->> 'material')::numeric;
        v_lab := v_lab + r.quantity * (sub ->> 'labor')::numeric;
        v_missing := v_missing || coalesce(sub -> 'missing', '[]'::jsonb);
      end if;
    end if;
  end loop;
  select coalesce(sum(minutes), 0) into v_min from public.bom_operations where version_id = p_version;
  v_lab := v_lab + v_min / 60 * coalesce(vc.hourly_rate, 0);
  v_ov := (v_mat + v_lab) * coalesce(vc.overhead_pct, 0) / 100;
  return jsonb_build_object('material', round(v_mat, 4), 'labor', round(v_lab, 4), 'overhead', round(v_ov, 4),
                            'total', round(v_mat + v_lab + v_ov, 4), 'minutes', v_min,
                            'missing', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(v_missing) x));
end $$;
revoke execute on function private.bom_calc(uuid, int) from public, anon, authenticated;

-- Nœud de l'arbre (nomenclature + lignes + opérations, sous-ensembles dépliés récursivement)
create function private.bom_node(p_version uuid, p_mult numeric, p_depth int, p_costs boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.bom_versions%rowtype; b public.boms%rowtype; vc public.bom_version_costs%rowtype;
  r record; o record; v_lines jsonb := '[]'::jsonb; v_ops jsonb := '[]'::jsonb; v_child jsonb; v_sub jsonb; v_cost numeric; v_tq numeric;
begin
  if p_depth > 8 then raise exception 'BOM_TOO_DEEP' using errcode = '54001'; end if;
  select * into v from public.bom_versions where id = p_version;
  select * into b from public.boms where id = v.bom_id;
  select * into vc from public.bom_version_costs where version_id = p_version;

  for r in
    select l.id, l.pos, l.line_type, l.quantity, l.waste_pct, l.note, l.child_bom_id,
           m.id m_id, m.code m_code, m.name m_name, m.category m_cat, m.unit m_unit, m.color m_color, m.archived_at m_arch, pr.unit_cost
    from public.bom_lines l
    left join public.bom_materials m on m.id = l.material_id
    left join public.bom_material_prices pr on pr.material_id = l.material_id
    where l.version_id = p_version order by l.pos, l.id
  loop
    if r.line_type = 'material' then
      v_tq := r.quantity * (1 + r.waste_pct / 100) * p_mult;
      v_cost := case when p_costs and r.unit_cost is not null then round(r.quantity * (1 + r.waste_pct / 100) * r.unit_cost, 4) end;
      v_lines := v_lines || (jsonb_build_object('id', r.id, 'type', 'material', 'pos', r.pos, 'qty', r.quantity, 'waste_pct', r.waste_pct,
          'note', r.note, 'total_qty', round(v_tq, 4), 'unit', r.m_unit,
          'material', jsonb_build_object('id', r.m_id, 'code', r.m_code, 'name', r.m_name, 'category', r.m_cat, 'unit', r.m_unit, 'color', r.m_color, 'archived', r.m_arch is not null))
        || case when p_costs then jsonb_build_object('unit_cost', r.unit_cost, 'cost', v_cost) else '{}'::jsonb end);
    else
      select * into b from public.boms where id = r.child_bom_id;   -- (b est réutilisé puis restauré ci-dessous)
      v_child := null; v_sub := null; v_cost := null;
      if b.active_version_id is not null then
        v_child := private.bom_node(b.active_version_id, p_mult * r.quantity, p_depth + 1, p_costs);
        if p_costs then
          v_sub := private.bom_calc(b.active_version_id, p_depth + 1);
          v_cost := round(r.quantity * ((v_sub ->> 'material')::numeric + (v_sub ->> 'labor')::numeric), 4);
        end if;
      end if;
      v_lines := v_lines || (jsonb_build_object('id', r.id, 'type', 'bom', 'pos', r.pos, 'qty', r.quantity, 'waste_pct', 0, 'note', r.note,
          'total_qty', round(p_mult * r.quantity, 4), 'unit', 'pc',
          'child', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'archived', b.archived_at is not null, 'validated', b.active_version_id is not null),
          'node', v_child)
        || case when p_costs then jsonb_build_object('cost', v_cost) else '{}'::jsonb end);
      select * into b from public.boms where id = v.bom_id;
    end if;
  end loop;

  for o in select id, pos, name, minutes, note from public.bom_operations where version_id = p_version order by pos, id loop
    v_ops := v_ops || (jsonb_build_object('id', o.id, 'pos', o.pos, 'name', o.name, 'minutes', o.minutes, 'note', o.note, 'total_minutes', round(o.minutes * p_mult, 2))
      || case when p_costs then jsonb_build_object('cost', round(o.minutes / 60 * coalesce(vc.hourly_rate, 0), 4)) else '{}'::jsonb end);
  end loop;

  return jsonb_build_object(
    'bom', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'kind', b.kind, 'archived', b.archived_at is not null),
    'version', jsonb_build_object('id', v.id, 'no', v.version_no, 'status', v.status),
    'lines', v_lines, 'operations', v_ops)
    || case when p_costs then jsonb_build_object('hourly_rate', vc.hourly_rate, 'overhead_pct', vc.overhead_pct, 'totals', private.bom_calc(p_version, p_depth)) else '{}'::jsonb end;
end $$;
revoke execute on function private.bom_node(uuid, numeric, int, boolean) from public, anon, authenticated;

create function public.bom_tree(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('bom.read');
  if not exists (select 1 from public.bom_versions where id = p_version and company_id = private.current_company()) then
    raise exception 'BOM_NOT_FOUND' using errcode = 'P0002';
  end if;
  return private.bom_node(p_version, 1, 0, private.has_perm('costs.read'));
end $$;

-- Coût recalculé aux prix actuels + coût figé à la validation (si la version est validée)
create function public.bom_cost(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare vc public.bom_version_costs%rowtype;
begin
  perform private.require_perm('bom.read');
  perform private.require_perm('costs.read');
  select * into vc from public.bom_version_costs where version_id = p_version and company_id = private.current_company();
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('live', private.bom_calc(p_version),
    'frozen', case when vc.frozen_at is null then null else jsonb_build_object('material', vc.snap_material, 'labor', vc.snap_labor,
      'overhead', vc.snap_overhead, 'total', vc.snap_total, 'frozen_at', vc.frozen_at) end);
end $$;

-- ---------------------------------------------------------------------
-- 8. Historique
-- ---------------------------------------------------------------------
create function private.audit_bom_materials() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.bom_rpc() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'material.create', 'material', new.id::text, new.code,
      null, jsonb_build_object('code', new.code, 'name', new.name, 'category', new.category, 'unit', new.unit));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
             where k not in ('name','category','unit','color','supplier_id','description')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'material.update', 'material', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after');
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_bom_materials_iu after insert or update on public.bom_materials
  for each row execute function private.audit_bom_materials();

create function private.audit_bom_prices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  select code into v_code from public.bom_materials where id = new.material_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'material.price_set', 'material', new.material_id::text, v_code,
      null, jsonb_build_object('unit_cost', new.unit_cost));
  elsif new.unit_cost is distinct from old.unit_cost then
    perform private.write_audit(new.company_id, 'material.price_update', 'material', new.material_id::text, v_code,
      jsonb_build_object('unit_cost', old.unit_cost), jsonb_build_object('unit_cost', new.unit_cost));
  end if;
  return new;
end $$;
create trigger audit_bom_prices_iu after insert or update on public.bom_material_prices
  for each row execute function private.audit_bom_prices();

create function private.audit_boms() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.bom_rpc() then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'bom.create', 'bom', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'kind', new.kind,
                         'article', (select internal_ref from public.articles where id = new.article_id)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','description','article_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'bom.update', 'bom', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after');
    end if;
  end if;
  return new;
end $$;
create trigger audit_boms_iu after insert or update on public.boms
  for each row execute function private.audit_boms();

create function private.audit_bom_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  select code into v_code from public.boms where id = new.bom_id;
  if tg_op = 'INSERT' and new.version_no > 1 then
    perform private.write_audit(new.company_id, 'bom.version_new', 'bom', new.bom_id::text, v_code, null, null,
      jsonb_build_object('version', new.version_no, 'note', new.change_note));
  elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'validated' then
    perform private.write_audit(new.company_id, 'bom.version_validate', 'bom', new.bom_id::text, v_code, null, null,
      jsonb_build_object('version', new.version_no, 'comment', new.validation_comment));
  end if;
  return new;
end $$;
create trigger audit_bom_versions_iu after insert or update on public.bom_versions
  for each row execute function private.audit_bom_versions();

create function private.audit_bom_costs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; v_code text;
begin
  if private.bom_rpc() then return new; end if;
  if new.hourly_rate is distinct from old.hourly_rate or new.overhead_pct is distinct from old.overhead_pct then
    select * into v from public.bom_versions where id = new.version_id;
    select code into v_code from public.boms where id = v.bom_id;
    perform private.write_audit(new.company_id, 'bom.costing_update', 'bom', v.bom_id::text, v_code,
      jsonb_build_object('hourly_rate', old.hourly_rate, 'overhead_pct', old.overhead_pct),
      jsonb_build_object('hourly_rate', new.hourly_rate, 'overhead_pct', new.overhead_pct), jsonb_build_object('version', v.version_no));
  end if;
  return new;
end $$;
create trigger audit_bom_costs_u after update on public.bom_version_costs
  for each row execute function private.audit_bom_costs();

create function private.audit_bom_lines() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.bom_lines%rowtype; v_code text; v_no int; v_what jsonb; v_before jsonb; v_after jsonb;
begin
  if private.bom_rpc() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.boms where id = r.bom_id;
  select version_no into v_no from public.bom_versions where id = r.version_id;
  v_what := jsonb_build_object('component', coalesce((select code || ' — ' || name from public.bom_materials where id = r.material_id),
                                                       (select code || ' — ' || name from public.boms where id = r.child_bom_id)),
                               'type', r.line_type);
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'bom.line_add', 'bom', r.bom_id::text, v_code, null,
      jsonb_build_object('quantity', r.quantity, 'waste_pct', r.waste_pct), v_what || jsonb_build_object('version', v_no));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'bom.line_delete', 'bom', r.bom_id::text, v_code,
      jsonb_build_object('quantity', r.quantity, 'waste_pct', r.waste_pct), null, v_what || jsonb_build_object('version', v_no));
  elsif old.quantity is distinct from new.quantity or old.waste_pct is distinct from new.waste_pct or old.note is distinct from new.note then
    v_before := jsonb_build_object('quantity', old.quantity, 'waste_pct', old.waste_pct);
    v_after  := jsonb_build_object('quantity', new.quantity, 'waste_pct', new.waste_pct);
    perform private.write_audit(r.company_id, 'bom.line_update', 'bom', r.bom_id::text, v_code, v_before, v_after, v_what || jsonb_build_object('version', v_no));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_bom_lines_iud after insert or update or delete on public.bom_lines
  for each row execute function private.audit_bom_lines();

create function private.audit_bom_operations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.bom_operations%rowtype; v_code text; v_no int;
begin
  if private.bom_rpc() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.boms where id = r.bom_id;
  select version_no into v_no from public.bom_versions where id = r.version_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'bom.op_add', 'bom', r.bom_id::text, v_code, null,
      jsonb_build_object('name', r.name, 'minutes', r.minutes), jsonb_build_object('version', v_no));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'bom.op_delete', 'bom', r.bom_id::text, v_code,
      jsonb_build_object('name', r.name, 'minutes', r.minutes), null, jsonb_build_object('version', v_no));
  elsif old.name is distinct from new.name or old.minutes is distinct from new.minutes then
    perform private.write_audit(r.company_id, 'bom.op_update', 'bom', r.bom_id::text, v_code,
      jsonb_build_object('name', old.name, 'minutes', old.minutes), jsonb_build_object('name', new.name, 'minutes', new.minutes), jsonb_build_object('version', v_no));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_bom_operations_iud after insert or update or delete on public.bom_operations
  for each row execute function private.audit_bom_operations();

-- Les actions de coût ne sont visibles qu'avec costs.read
create policy audit_logs_select_bom on public.audit_logs for select to authenticated
  using (entity_type in ('bom', 'material') and company_id = private.current_company() and private.has_perm('bom.read')
         and (action not in ('bom.costing_update', 'material.price_set', 'material.price_update') or private.has_perm('costs.read')));

-- ---------------------------------------------------------------------
-- 9. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.bom_materials      enable row level security;
alter table public.bom_material_prices enable row level security;
alter table public.boms               enable row level security;
alter table public.bom_versions       enable row level security;
alter table public.bom_version_costs  enable row level security;
alter table public.bom_lines          enable row level security;
alter table public.bom_operations     enable row level security;

revoke all on public.bom_materials, public.bom_material_prices, public.boms, public.bom_versions, public.bom_version_costs,
              public.bom_lines, public.bom_operations from anon, authenticated;
grant all on public.bom_materials, public.bom_material_prices, public.boms, public.bom_versions, public.bom_version_costs,
             public.bom_lines, public.bom_operations to service_role;
grant select on public.bom_materials, public.bom_material_prices, public.boms, public.bom_versions, public.bom_version_costs,
                public.bom_lines, public.bom_operations to authenticated;

grant insert (name, category, unit, color, supplier_id, description) on public.bom_materials to authenticated;
grant update (name, category, unit, color, supplier_id, description) on public.bom_materials to authenticated;
grant insert (material_id, unit_cost) on public.bom_material_prices to authenticated;
grant update (unit_cost) on public.bom_material_prices to authenticated;
grant insert (name, kind, article_id, description) on public.boms to authenticated;
grant update (name, description, article_id) on public.boms to authenticated;
grant update (change_note) on public.bom_versions to authenticated;
grant update (hourly_rate, overhead_pct) on public.bom_version_costs to authenticated;
grant insert (version_id, line_type, material_id, child_bom_id, quantity, waste_pct, note) on public.bom_lines to authenticated;
grant update (pos, quantity, waste_pct, note) on public.bom_lines to authenticated;
grant delete on public.bom_lines to authenticated;
grant insert (version_id, name, minutes, note) on public.bom_operations to authenticated;
grant update (pos, name, minutes, note) on public.bom_operations to authenticated;
grant delete on public.bom_operations to authenticated;

create policy bom_materials_select on public.bom_materials for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_materials_insert on public.bom_materials for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_materials_update on public.bom_materials for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_prices_select on public.bom_material_prices for select to authenticated
  using (company_id = private.current_company() and private.has_perm('costs.read'));
create policy bom_prices_insert on public.bom_material_prices for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'));
create policy bom_prices_update on public.bom_material_prices for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'))
  with check (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'));

create policy boms_select on public.boms for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy boms_insert on public.boms for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy boms_update on public.boms for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_versions_select on public.bom_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_versions_update on public.bom_versions for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_costs_select on public.bom_version_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('costs.read'));
create policy bom_costs_update on public.bom_version_costs for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'))
  with check (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'));

create policy bom_lines_select on public.bom_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_lines_insert on public.bom_lines for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_lines_update on public.bom_lines for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_lines_delete on public.bom_lines for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_operations_select on public.bom_operations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_operations_insert on public.bom_operations for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_operations_update on public.bom_operations for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_operations_delete on public.bom_operations for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'));

-- ---------------------------------------------------------------------
-- 10. RPC : versions, duplication, archivage, suppression
-- ---------------------------------------------------------------------
-- Copie lignes, opérations et paramètres de coût d'une version vers une autre (sans audit ligne à ligne)
create function private.bom_copy_content(p_from uuid, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  perform set_config('bom.rpc', 'on', true);
  insert into public.bom_lines (company_id, bom_id, version_id, pos, line_type, material_id, child_bom_id, quantity, waste_pct, note)
  select l.company_id, (select bom_id from public.bom_versions where id = p_to), p_to, l.pos, l.line_type, l.material_id, l.child_bom_id, l.quantity, l.waste_pct, l.note
  from public.bom_lines l where l.version_id = p_from;
  insert into public.bom_operations (company_id, bom_id, version_id, pos, name, minutes, note)
  select o.company_id, (select bom_id from public.bom_versions where id = p_to), p_to, o.pos, o.name, o.minutes, o.note
  from public.bom_operations o where o.version_id = p_from;
  update public.bom_version_costs t set hourly_rate = s.hourly_rate, overhead_pct = s.overhead_pct
  from public.bom_version_costs s where s.version_id = p_from and t.version_id = p_to;
  perform set_config('bom.rpc', v_prev, true);
end $$;
revoke execute on function private.bom_copy_content(uuid, uuid) from public, anon, authenticated;

create function public.bom_new_version(p_bom uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype; v_last public.bom_versions%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.bom_assert_writable(p_bom);
  if exists (select 1 from public.bom_versions where bom_id = p_bom and status = 'draft') then
    raise exception 'BOM_DRAFT_EXISTS' using errcode = '55000';
  end if;
  select * into v_last from public.bom_versions where bom_id = p_bom order by version_no desc limit 1;
  insert into public.bom_versions (id, company_id, bom_id, version_no, change_note)
  values (v_id, b.company_id, p_bom, v_last.version_no + 1, nullif(btrim(coalesce(p_note, '')), ''));
  perform private.bom_copy_content(v_last.id, v_id);
  return v_id;
end $$;

create function public.bom_validate_version(p_version uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; b public.boms%rowtype; v_calc jsonb; v_bad text;
begin
  perform private.require_perm('bom.validate');
  select * into v from public.bom_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into b from public.boms where id = v.bom_id for update;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.bom_lines where version_id = p_version) then raise exception 'BOM_EMPTY' using errcode = '55000'; end if;

  select string_agg(m.code, ', ') into v_bad from public.bom_lines l join public.bom_materials m on m.id = l.material_id
   where l.version_id = p_version and m.archived_at is not null;
  if v_bad is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000', detail = v_bad; end if;
  select string_agg(c.code, ', ') into v_bad from public.bom_lines l join public.boms c on c.id = l.child_bom_id
   where l.version_id = p_version and (c.archived_at is not null or c.active_version_id is null);
  if v_bad is not null then raise exception 'BOM_CHILD_NOT_VALIDATED' using errcode = '55000', detail = v_bad; end if;

  v_calc := private.bom_calc(p_version);
  if jsonb_array_length(v_calc -> 'missing') > 0 then
    raise exception 'BOM_PRICE_MISSING' using errcode = '55000', detail = (select string_agg(x, ', ') from jsonb_array_elements_text(v_calc -> 'missing') x);
  end if;

  perform set_config('bom.rpc', 'on', true);
  update public.bom_versions set status = 'obsolete' where bom_id = v.bom_id and status = 'validated';
  update public.bom_versions set status = 'validated', validated_by = auth.uid(), validated_at = now(),
         validation_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_version;
  update public.bom_version_costs set snap_material = (v_calc ->> 'material')::numeric, snap_labor = (v_calc ->> 'labor')::numeric,
         snap_overhead = (v_calc ->> 'overhead')::numeric, snap_total = (v_calc ->> 'total')::numeric, frozen_at = now() where version_id = p_version;
  perform set_config('bom.rpc', 'off', true);
  perform private.bom_refresh(v.bom_id);   -- (la validation est tracée par le trigger d'audit des versions)
end $$;

create function public.bom_discard_draft(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; b public.boms%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into v from public.bom_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into b from public.boms where id = v.bom_id;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  if v.version_no = 1 then raise exception 'BOM_FIRST_VERSION' using errcode = '55000'; end if;
  perform set_config('bom.rpc', 'on', true);
  delete from public.bom_versions where id = p_version;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'bom.version_discard', 'bom', b.id::text, b.code, null, null, jsonb_build_object('version', v.version_no), 'rpc');
end $$;

-- Duplication : nouvelle nomenclature (même type) dont la version 1 reprend la version source
create function public.bom_duplicate(p_bom uuid, p_name text, p_article uuid default null, p_version uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare src public.boms%rowtype; v_src uuid; v_new uuid := gen_random_uuid(); v_v1 uuid; v_code text;
begin
  perform private.require_perm('bom.write');
  select * into src from public.boms where id = p_bom and company_id = private.current_company();
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'BOM_INVALID_NAME' using errcode = '22023'; end if;
  if p_version is not null then
    select id into v_src from public.bom_versions where id = p_version and bom_id = p_bom;
    if v_src is null then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  else
    v_src := coalesce(src.active_version_id, src.current_version_id);
  end if;
  if src.kind = 'subassembly' and p_article is not null then raise exception 'BOM_BAD_ARTICLE' using errcode = '22023'; end if;

  perform set_config('bom.rpc', 'on', true);       -- pas d'audit « création » : seule la duplication est tracée
  insert into public.boms (id, company_id, name, kind, article_id, description)
  values (v_new, src.company_id, btrim(p_name), src.kind, p_article, src.description);
  perform set_config('bom.rpc', 'off', true);
  select id into v_v1 from public.bom_versions where bom_id = v_new and version_no = 1;
  perform private.bom_copy_content(v_src, v_v1);
  select code into v_code from public.boms where id = v_new;
  perform private.write_audit(src.company_id, 'bom.duplicate', 'bom', v_new::text, v_code, null,
    jsonb_build_object('code', v_code, 'name', btrim(p_name)), jsonb_build_object('source_id', src.id, 'source_code', src.code,
      'source_version', (select version_no from public.bom_versions where id = v_src)), 'rpc');
  return v_new;
end $$;

create function public.bom_archive(p_bom uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype; v_used text;
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.archived_at is not null then raise exception 'BOM_ARCHIVED' using errcode = '55000'; end if;
  -- un sous-ensemble utilisé par une nomenclature active ne s'archive pas
  select string_agg(distinct p.code, ', ') into v_used
  from public.bom_lines l join public.boms p on p.id = l.bom_id
  where l.child_bom_id = p_bom and p.archived_at is null
    and l.version_id in (p.current_version_id, p.active_version_id);
  if v_used is not null then raise exception 'BOM_USED_AS_CHILD' using errcode = '23503', detail = v_used; end if;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_bom;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(b.company_id, 'bom.archive', 'bom', b.id::text, b.code, null, null, jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

create function public.bom_restore(p_bom uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.archived_at is null then raise exception 'BOM_NOT_ARCHIVED' using errcode = '55000'; end if;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set archived_at = null, archived_by = null, archive_reason = null where id = p_bom;   -- (l'index unique d'article empêche une double nomenclature active)
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(b.company_id, 'bom.restore', 'bom', b.id::text, b.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- Suppression : nomenclature jamais validée et jamais utilisée comme sous-ensemble
create function public.bom_delete(p_bom uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.bom_assert_writable(p_bom);
  if exists (select 1 from public.bom_versions where bom_id = p_bom and status in ('validated','obsolete'))
     or exists (select 1 from public.bom_lines where child_bom_id = p_bom) then
    raise exception 'BOM_IN_USE' using errcode = '23503';
  end if;
  perform set_config('bom.rpc', 'on', true);
  delete from public.boms where id = p_bom;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(b.company_id, 'bom.delete', 'bom', b.id::text, b.code, jsonb_build_object('code', b.code, 'name', b.name), null, '{}'::jsonb, 'rpc');
end $$;

-- Composants : archivage / restauration / suppression (jamais utilisé)
create function public.bom_material_archive(p_material uuid, p_archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.bom_materials%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into m from public.bom_materials where id = p_material and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_archive and m.archived_at is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
  if not p_archive and m.archived_at is null then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('bom.rpc', 'on', true);
  update public.bom_materials set archived_at = case when p_archive then now() end, updated_at = now(), updated_by = auth.uid() where id = p_material;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(m.company_id, case when p_archive then 'material.archive' else 'material.restore' end, 'material', m.id::text, m.code, null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.bom_material_delete(p_material uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.bom_materials%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into m from public.bom_materials where id = p_material and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.bom_lines where material_id = p_material) then raise exception 'BOM_MATERIAL_IN_USE' using errcode = '23503'; end if;
  perform set_config('bom.rpc', 'on', true);
  delete from public.bom_materials where id = p_material;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(m.company_id, 'material.delete', 'material', m.id::text, m.code, jsonb_build_object('code', m.code, 'name', m.name), null, '{}'::jsonb, 'rpc');
end $$;

do $$
declare f text;
begin
  foreach f in array array['bom_tree(uuid)', 'bom_cost(uuid)', 'bom_new_version(uuid,text)', 'bom_validate_version(uuid,text)', 'bom_discard_draft(uuid)',
                           'bom_duplicate(uuid,text,uuid,uuid)', 'bom_archive(uuid,text)', 'bom_restore(uuid)', 'bom_delete(uuid)',
                           'bom_material_archive(uuid,boolean)', 'bom_material_delete(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ===== 0009_stock.sql =====
-- =====================================================================
-- 0009_stock — Module Stock
--  Entrepôts, emplacements, stock par lot (couches FIFO), stocks disponibles / réservés / de sécurité,
--  mouvements (entrée, sortie, transfert, ajustement, inventaire) et historique complet immuable.
--  Les articles stockés sont les composants du catalogue BOM (bom_materials).
--  Permissions existantes : stock.read / stock.write (entrées, sorties, transferts, réservations, comptages)
--                           stock.adjust (ajustements, validation d'inventaire)
--  Valeurs (coûts des lots, valorisation) : tables séparées, lisibles avec costs.read uniquement.
--  Toute écriture sur les lots / mouvements passe par des fonctions security definer : aucun accès direct.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null,                                              -- WH-01 (généré, immuable)
  name        text not null check (length(btrim(name)) between 2 and 120),
  city        text check (city is null or length(city) <= 80),
  address     text check (address is null or length(address) <= 200),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code)
);
create unique index warehouses_name_uq on public.warehouses (company_id, lower(btrim(name)));

create table public.stock_locations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  warehouse_id uuid not null references public.warehouses(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),
  name         text check (name is null or length(name) <= 80),
  kind         text not null default 'storage' check (kind in ('storage','receiving','shipping','quarantine')),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  unique (warehouse_id, code)
);

-- Lots = couches FIFO. quantité restante décroissante, date de réception conservée lors des transferts.
create table public.stock_lots (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  material_id      uuid not null references public.bom_materials(id),
  warehouse_id     uuid not null references public.warehouses(id),
  location_id      uuid not null references public.stock_locations(id),
  qty_in           numeric(14,4) not null check (qty_in > 0),
  qty_remaining    numeric(14,4) not null check (qty_remaining >= 0),
  received_at      timestamptz not null default clock_timestamp(),
  reference        text check (reference is null or length(reference) <= 120),
  source_movement  uuid,
  created_at       timestamptz not null default now(),
  constraint stock_lots_remaining_ck check (qty_remaining <= qty_in)
);
create index stock_lots_fifo_idx on public.stock_lots (material_id, warehouse_id, received_at, id) where qty_remaining > 0;
create index stock_lots_loc_idx  on public.stock_lots (location_id) where qty_remaining > 0;

create table public.stock_lot_costs (
  lot_id     uuid primary key references public.stock_lots(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  unit_cost  numeric(14,4) not null check (unit_cost >= 0)
);

create table public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity,
  company_id      uuid not null references public.companies(id),
  type            text not null check (type in ('in','out','transfer','adjustment','inventory')),
  direction       text not null check (direction in ('in','out','move')),
  material_id     uuid not null references public.bom_materials(id),
  qty             numeric(14,4) not null check (qty > 0),
  warehouse_id    uuid not null references public.warehouses(id),
  location_id     uuid references public.stock_locations(id),
  to_warehouse_id uuid references public.warehouses(id),
  to_location_id  uuid references public.stock_locations(id),
  reference       text check (reference is null or length(reference) <= 120),
  reason          text check (reason is null or length(reason) <= 300),
  reservation_id  uuid,
  inventory_id    uuid,
  created_at      timestamptz not null default clock_timestamp(),
  created_by      uuid
);
create index stock_movements_idx on public.stock_movements (company_id, created_at desc, seq desc);
create index stock_movements_mat_idx on public.stock_movements (material_id, created_at desc);

-- Détail FIFO : quels lots ont été créés / consommés / déplacés par un mouvement
create table public.stock_movement_allocations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  movement_id uuid not null references public.stock_movements(id),
  lot_id      uuid not null references public.stock_lots(id),
  to_lot_id   uuid references public.stock_lots(id),
  qty         numeric(14,4) not null check (qty > 0)
);
create index stock_alloc_mov_idx on public.stock_movement_allocations (movement_id);
create index stock_alloc_lot_idx on public.stock_movement_allocations (lot_id);

create table public.stock_movement_costs (
  movement_id uuid primary key references public.stock_movements(id),
  company_id  uuid not null references public.companies(id),
  total_cost  numeric(16,4) not null check (total_cost >= 0)
);

create table public.stock_reservations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id),
  warehouse_id uuid not null references public.warehouses(id),
  qty          numeric(14,4) not null check (qty > 0),
  qty_consumed numeric(14,4) not null default 0 check (qty_consumed >= 0 and qty_consumed <= qty),
  status       text not null default 'active' check (status in ('active','released','consumed')),
  reference    text not null check (length(btrim(reference)) between 1 and 120),   -- ex. ordre de fabrication, commande
  note         text check (note is null or length(note) <= 300),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  closed_at    timestamptz
);
create index stock_res_active_idx on public.stock_reservations (material_id, warehouse_id) where status = 'active';

create table public.stock_thresholds (
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  safety_qty   numeric(14,4) not null check (safety_qty >= 0),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  primary key (material_id, warehouse_id)
);

create table public.stock_inventories (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  code         text not null,                                              -- INV-0001
  warehouse_id uuid not null references public.warehouses(id),
  location_id  uuid references public.stock_locations(id),                 -- périmètre (null = tout l'entrepôt)
  status       text not null default 'draft' check (status in ('draft','validated','cancelled')),
  note         text check (note is null or length(note) <= 300),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  closed_at    timestamptz,
  closed_by    uuid,
  unique (company_id, code)
);

create table public.stock_inventory_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  inventory_id  uuid not null references public.stock_inventories(id) on delete cascade,
  material_id   uuid not null references public.bom_materials(id),
  location_id   uuid not null references public.stock_locations(id),
  system_qty    numeric(14,4) not null default 0,                          -- stock théorique à l'ouverture
  counted_qty   numeric(14,4) check (counted_qty is null or counted_qty >= 0),
  applied_delta numeric(14,4),                                             -- écart appliqué à la validation
  unique (inventory_id, material_id, location_id)
);

-- ---------------------------------------------------------------------
-- 2. Vue d'ensemble : disponible = en stock − réservé ; alerte sous le stock de sécurité
-- ---------------------------------------------------------------------
create view public.stock_overview with (security_invoker = true) as
with keys as (
  select company_id, material_id, warehouse_id from public.stock_lots where qty_remaining > 0
  union select company_id, material_id, warehouse_id from public.stock_reservations where status = 'active'
  union select company_id, material_id, warehouse_id from public.stock_thresholds
), oh as (
  select material_id, warehouse_id, sum(qty_remaining) q from public.stock_lots group by 1, 2
), rs as (
  select material_id, warehouse_id, sum(qty - qty_consumed) q from public.stock_reservations where status = 'active' group by 1, 2
)
select k.company_id, k.material_id, k.warehouse_id,
       coalesce(oh.q, 0) as on_hand,
       coalesce(rs.q, 0) as reserved,
       coalesce(oh.q, 0) - coalesce(rs.q, 0) as available,
       coalesce(th.safety_qty, 0) as safety_qty,
       (coalesce(oh.q, 0) - coalesce(rs.q, 0)) < coalesce(th.safety_qty, 0) as below_safety
from keys k
left join oh on oh.material_id = k.material_id and oh.warehouse_id = k.warehouse_id
left join rs on rs.material_id = k.material_id and rs.warehouse_id = k.warehouse_id
left join public.stock_thresholds th on th.material_id = k.material_id and th.warehouse_id = k.warehouse_id;

-- ---------------------------------------------------------------------
-- 3. Triggers : entrepôts, emplacements, immuabilité de l'historique
-- ---------------------------------------------------------------------
create function private.warehouses_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'WH-' || lpad(private.next_seq(new.company_id, 'warehouse')::text, 2, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid(); new.archived_at := null;
  elsif coalesce(current_setting('stock.rpc', true), 'off') <> 'on' then
    if old.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.name := btrim(new.name);
  new.city := nullif(btrim(coalesce(new.city, '')), '');
  new.address := nullif(btrim(coalesce(new.address, '')), '');
  return new;
end $$;
create trigger warehouses_before_iu before insert or update on public.warehouses
  for each row execute function private.warehouses_before();

-- chaque entrepôt reçoit un emplacement général
create function private.warehouses_seed_location() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_locations (company_id, warehouse_id, code, name) values (new.company_id, new.id, 'GEN', 'Emplacement général');
  return new;
end $$;
create trigger warehouses_seed_location_i after insert on public.warehouses
  for each row execute function private.warehouses_seed_location();

create function private.stock_locations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype;
begin
  select * into w from public.warehouses where id = new.warehouse_id;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if tg_op = 'INSERT' then
    if w.archived_at is not null and coalesce(current_setting('stock.rpc', true), 'off') <> 'on' then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
    new.company_id := w.company_id; new.created_by := coalesce(auth.uid(), new.created_by); new.archived_at := null;
  elsif coalesce(current_setting('stock.rpc', true), 'off') <> 'on' and old.archived_at is not null then
    raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000';
  end if;
  new.code := upper(btrim(new.code));
  new.name := nullif(btrim(coalesce(new.name, '')), '');
  return new;
end $$;
create trigger stock_locations_before_iu before insert or update on public.stock_locations
  for each row execute function private.stock_locations_before();

create function private.stock_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'STOCK_IMMUTABLE' using errcode = '42501';
end $$;
create trigger stock_movements_immutable before update or delete on public.stock_movements for each row execute function private.stock_immutable();
create trigger stock_alloc_immutable before update or delete on public.stock_movement_allocations for each row execute function private.stock_immutable();
create trigger stock_mcosts_immutable before update or delete on public.stock_movement_costs for each row execute function private.stock_immutable();

-- Lignes d'inventaire : comptage seulement tant que l'inventaire est ouvert
create function private.stock_inv_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  select * into i from public.stock_inventories where id = coalesce(new.inventory_id, old.inventory_id);
  if coalesce(current_setting('stock.rpc', true), 'off') <> 'on' then
    if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
    if tg_op = 'UPDATE' then new.system_qty := old.system_qty; new.applied_delta := old.applied_delta; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger stock_inv_lines_before_iu before update on public.stock_inventory_lines
  for each row execute function private.stock_inv_lines_before();

-- ---------------------------------------------------------------------
-- 4. Moteur de mouvements (FIFO)
-- ---------------------------------------------------------------------
create function private.stock_on_hand(p_material uuid, p_wh uuid, p_loc uuid default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty_remaining), 0) from public.stock_lots
  where material_id = p_material and warehouse_id = p_wh and (p_loc is null or location_id = p_loc) $$;

create function private.stock_reserved(p_material uuid, p_wh uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty - qty_consumed), 0) from public.stock_reservations
  where material_id = p_material and warehouse_id = p_wh and status = 'active' $$;

-- Consomme p_qty en FIFO (lot le plus ancien d'abord). Si p_dest_loc est donné, recrée les quantités dans l'emplacement
-- de destination en conservant date de réception, référence et coût (le transfert ne rajeunit pas le stock).
create function private.stock_consume(p_company uuid, p_movement uuid, p_material uuid, p_wh uuid, p_loc uuid, p_qty numeric,
                                      p_dest_wh uuid, p_dest_loc uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare r record; v_need numeric := p_qty; v_take numeric; v_new uuid; v_cost numeric; v_total numeric := 0;
begin
  for r in
    select * from public.stock_lots
    where material_id = p_material and warehouse_id = p_wh and qty_remaining > 0 and (p_loc is null or location_id = p_loc) and company_id = p_company
    order by received_at, id for update
  loop
    exit when v_need <= 0;
    v_take := least(r.qty_remaining, v_need);
    select unit_cost into v_cost from public.stock_lot_costs where lot_id = r.id;
    update public.stock_lots set qty_remaining = qty_remaining - v_take where id = r.id;
    v_new := null;
    if p_dest_loc is not null then
      v_new := gen_random_uuid();
      insert into public.stock_lots (id, company_id, material_id, warehouse_id, location_id, qty_in, qty_remaining, received_at, reference, source_movement)
      values (v_new, p_company, p_material, p_dest_wh, p_dest_loc, v_take, v_take, r.received_at, r.reference, p_movement);
      if v_cost is not null then insert into public.stock_lot_costs (lot_id, company_id, unit_cost) values (v_new, p_company, v_cost); end if;
    end if;
    insert into public.stock_movement_allocations (company_id, movement_id, lot_id, to_lot_id, qty) values (p_company, p_movement, r.id, v_new, v_take);
    v_total := v_total + v_take * coalesce(v_cost, 0);
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
  return v_total;
end $$;
revoke execute on function private.stock_consume(uuid, uuid, uuid, uuid, uuid, numeric, uuid, uuid) from public, anon, authenticated;

create function private.stock_apply(p_type text, p_dir text, p_material uuid, p_qty numeric, p_wh uuid, p_loc uuid, p_to_loc uuid,
                                    p_ref text, p_reason text, p_cost numeric, p_res uuid, p_inv uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company();
  m public.bom_materials%rowtype; w public.warehouses%rowtype; l public.stock_locations%rowtype; tl public.stock_locations%rowtype;
  r public.stock_reservations%rowtype; v_id uuid := gen_random_uuid(); v_lot uuid; v_cost numeric; v_total numeric := 0;
  v_oh numeric; v_rs numeric; v_to_wh uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into w from public.warehouses where id = p_wh and company_id = v_co;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if w.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  if p_loc is not null then
    select * into l from public.stock_locations where id = p_loc and warehouse_id = p_wh;
    if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  p_ref := nullif(btrim(coalesce(p_ref, '')), ''); p_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if p_dir = 'in' then
    if p_loc is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
    if l.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if p_type = 'in' and m.archived_at is not null then raise exception 'STOCK_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
  elsif p_dir = 'move' then
    select * into tl from public.stock_locations where id = p_to_loc and company_id = v_co;
    if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
    if tl.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if p_loc is not null and p_loc = p_to_loc then raise exception 'STOCK_SAME_LOCATION' using errcode = '22023'; end if;
    v_to_wh := tl.warehouse_id;
    if exists (select 1 from public.warehouses where id = v_to_wh and archived_at is not null) then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  end if;

  -- disponibilité : les sorties et transferts respectent les réservations (sauf la réservation consommée)
  if p_type in ('out', 'transfer') then
    v_oh := private.stock_on_hand(p_material, p_wh); v_rs := private.stock_reserved(p_material, p_wh);
    if p_res is not null then
      select * into r from public.stock_reservations where id = p_res and company_id = v_co for update;
      if not found or r.status <> 'active' or r.material_id <> p_material or r.warehouse_id <> p_wh or p_qty > r.qty - r.qty_consumed then
        raise exception 'STOCK_BAD_RESERVATION' using errcode = '22023';
      end if;
      v_rs := v_rs - (r.qty - r.qty_consumed);
    end if;
    if v_oh < p_qty then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    if v_oh - v_rs < p_qty then raise exception 'STOCK_RESERVED' using errcode = '55000'; end if;
  end if;

  insert into public.stock_movements (id, company_id, type, direction, material_id, qty, warehouse_id, location_id, to_warehouse_id, to_location_id,
                                      reference, reason, reservation_id, inventory_id, created_by)
  values (v_id, v_co, p_type, p_dir, p_material, p_qty, p_wh, p_loc, v_to_wh, case when p_dir = 'move' then p_to_loc end, p_ref, p_reason, p_res, p_inv, auth.uid());

  if p_dir = 'in' then
    -- coût : saisi (costs.read) sinon prix courant du catalogue BOM, sinon 0
    v_cost := case when p_cost is not null and private.has_perm('costs.read') then p_cost end;
    if v_cost is null then select unit_cost into v_cost from public.bom_material_prices where material_id = p_material; end if;
    v_cost := coalesce(v_cost, 0);
    v_lot := gen_random_uuid();
    insert into public.stock_lots (id, company_id, material_id, warehouse_id, location_id, qty_in, qty_remaining, reference, source_movement)
    values (v_lot, v_co, p_material, p_wh, p_loc, p_qty, p_qty, p_ref, v_id);
    insert into public.stock_lot_costs (lot_id, company_id, unit_cost) values (v_lot, v_co, v_cost);
    insert into public.stock_movement_allocations (company_id, movement_id, lot_id, qty) values (v_co, v_id, v_lot, p_qty);
    v_total := p_qty * v_cost;
  else
    v_total := private.stock_consume(v_co, v_id, p_material, p_wh, p_loc, p_qty, v_to_wh, case when p_dir = 'move' then p_to_loc end);
  end if;
  insert into public.stock_movement_costs (movement_id, company_id, total_cost) values (v_id, v_co, v_total);

  if p_res is not null and p_type = 'out' then
    update public.stock_reservations set qty_consumed = qty_consumed + p_qty,
      status = case when qty_consumed + p_qty >= qty then 'consumed' else 'active' end,
      closed_at = case when qty_consumed + p_qty >= qty then now() end
    where id = p_res;
  end if;
  return v_id;
end $$;
revoke execute on function private.stock_apply(text, text, uuid, numeric, uuid, uuid, uuid, text, text, numeric, uuid, uuid) from public, anon, authenticated;

-- Point d'entrée unique : entrée / sortie / transfert / ajustement
create function public.stock_move(p_type text, p_material uuid, p_qty numeric, p_warehouse uuid, p_location uuid default null,
                                  p_to_location uuid default null, p_reference text default null, p_reason text default null,
                                  p_unit_cost numeric default null, p_reservation uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_dir text;
begin
  if p_type not in ('in', 'out', 'transfer', 'adjustment') then raise exception 'STOCK_BAD_TYPE' using errcode = '22023'; end if;
  perform private.require_perm(case when p_type = 'adjustment' then 'stock.adjust' else 'stock.write' end);
  if p_type = 'adjustment' then
    if p_qty is null or p_qty = 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023'; end if;
    v_dir := case when p_qty > 0 then 'in' else 'out' end;
    return private.stock_apply('adjustment', v_dir, p_material, abs(p_qty), p_warehouse, p_location, null, p_reference, p_reason, null, null, null);
  end if;
  v_dir := case p_type when 'in' then 'in' when 'out' then 'out' else 'move' end;
  return private.stock_apply(p_type, v_dir, p_material, p_qty, p_warehouse, p_location, p_to_location, p_reference, p_reason, p_unit_cost, p_reservation, null);
end $$;

-- ---------------------------------------------------------------------
-- 5. Réservations et stock de sécurité
-- ---------------------------------------------------------------------
create function public.stock_reserve(p_material uuid, p_warehouse uuid, p_qty numeric, p_reference text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); m public.bom_materials%rowtype;
begin
  perform private.require_perm('stock.write');
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reference, ''))) < 1 then raise exception 'STOCK_REFERENCE_REQUIRED' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.bom_materials where id = p_material for update;     -- sérialise les réservations d'un même composant
  if private.stock_on_hand(p_material, p_warehouse) - private.stock_reserved(p_material, p_warehouse) < p_qty then
    raise exception 'STOCK_INSUFFICIENT_AVAILABLE' using errcode = '55000';
  end if;
  insert into public.stock_reservations (id, company_id, material_id, warehouse_id, qty, reference, note, created_by)
  values (v_id, v_co, p_material, p_warehouse, p_qty, btrim(p_reference), nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  perform private.write_audit(v_co, 'stock.reserve', 'stock', p_material::text, m.code, null, jsonb_build_object('qty', p_qty),
    jsonb_build_object('reference', btrim(p_reference), 'warehouse_id', p_warehouse, 'material', m.name), 'rpc');
  return v_id;
end $$;

create function public.stock_release(p_reservation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stock_reservations%rowtype; m public.bom_materials%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into r from public.stock_reservations where id = p_reservation and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_RESERVATION' using errcode = 'P0002'; end if;
  if r.status <> 'active' then raise exception 'STOCK_BAD_RESERVATION' using errcode = '55000'; end if;
  select * into m from public.bom_materials where id = r.material_id;
  update public.stock_reservations set status = 'released', closed_at = now() where id = p_reservation;
  perform private.write_audit(r.company_id, 'stock.release', 'stock', r.material_id::text, m.code, null, null,
    jsonb_build_object('reference', r.reference, 'qty', r.qty - r.qty_consumed, 'material', m.name), 'rpc');
end $$;

create function public.stock_set_safety(p_material uuid, p_warehouse uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); m public.bom_materials%rowtype; v_old numeric;
begin
  perform private.require_perm('stock.write');
  if p_qty is null or p_qty < 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select safety_qty into v_old from public.stock_thresholds where material_id = p_material and warehouse_id = p_warehouse;
  insert into public.stock_thresholds (company_id, material_id, warehouse_id, safety_qty, updated_by) values (v_co, p_material, p_warehouse, p_qty, auth.uid())
  on conflict (material_id, warehouse_id) do update set safety_qty = excluded.safety_qty, updated_at = now(), updated_by = auth.uid();
  if v_old is distinct from p_qty then
    perform private.write_audit(v_co, 'stock.safety_set', 'stock', p_material::text, m.code, jsonb_build_object('safety_qty', v_old), jsonb_build_object('safety_qty', p_qty),
      jsonb_build_object('warehouse_id', p_warehouse, 'material', m.name), 'rpc');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Inventaire : comptage puis validation (écarts appliqués en mouvements « inventaire »)
-- ---------------------------------------------------------------------
create function public.stock_inventory_create(p_warehouse uuid, p_location uuid default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('stock.write');
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_location is not null and not exists (select 1 from public.stock_locations where id = p_location and warehouse_id = p_warehouse) then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.stock_inventories where warehouse_id = p_warehouse and status = 'draft'
             and (location_id is null or p_location is null or location_id = p_location)) then
    raise exception 'STOCK_INVENTORY_OPEN' using errcode = '55000';       -- un seul inventaire ouvert par périmètre
  end if;
  v_code := 'INV-' || lpad(private.next_seq(v_co, 'inventory')::text, 4, '0');
  insert into public.stock_inventories (id, company_id, code, warehouse_id, location_id, note, created_by)
  values (v_id, v_co, v_code, p_warehouse, p_location, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  perform set_config('stock.rpc', 'on', true);
  insert into public.stock_inventory_lines (company_id, inventory_id, material_id, location_id, system_qty)
  select v_co, v_id, material_id, location_id, sum(qty_remaining) from public.stock_lots
  where warehouse_id = p_warehouse and qty_remaining > 0 and (p_location is null or location_id = p_location) group by material_id, location_id;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(v_co, 'inventory.create', 'inventory', v_id::text, v_code, null, jsonb_build_object('warehouse_id', p_warehouse, 'location_id', p_location), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.stock_inventory_add_line(p_inventory uuid, p_material uuid, p_location uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company();
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  if not exists (select 1 from public.stock_locations where id = p_location and warehouse_id = i.warehouse_id and (i.location_id is null or id = i.location_id)) then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.bom_materials where id = p_material and company_id = i.company_id) then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('stock.rpc', 'on', true);
  insert into public.stock_inventory_lines (company_id, inventory_id, material_id, location_id, system_qty)
  values (i.company_id, p_inventory, p_material, p_location, private.stock_on_hand(p_material, i.warehouse_id, p_location))
  on conflict (inventory_id, material_id, location_id) do nothing;
  perform set_config('stock.rpc', 'off', true);
end $$;

create function public.stock_inventory_validate(p_inventory uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype; r record; v_cur numeric; v_delta numeric; v_n int := 0; v_adj int := 0;
begin
  perform private.require_perm('stock.adjust');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  if not exists (select 1 from public.stock_inventory_lines where inventory_id = p_inventory and counted_qty is not null) then raise exception 'STOCK_INVENTORY_EMPTY' using errcode = '55000'; end if;
  perform set_config('stock.rpc', 'on', true);
  for r in select * from public.stock_inventory_lines where inventory_id = p_inventory and counted_qty is not null order by id loop
    v_n := v_n + 1;
    v_cur := private.stock_on_hand(r.material_id, i.warehouse_id, r.location_id);
    v_delta := r.counted_qty - v_cur;
    if v_delta <> 0 then
      perform private.stock_apply('inventory', case when v_delta > 0 then 'in' else 'out' end, r.material_id, abs(v_delta), i.warehouse_id, r.location_id, null,
                                  i.code, 'Inventaire ' || i.code, null, null, p_inventory);
      v_adj := v_adj + 1;
    end if;
    update public.stock_inventory_lines set applied_delta = v_delta where id = r.id;
  end loop;
  update public.stock_inventories set status = 'validated', closed_at = now(), closed_by = auth.uid() where id = p_inventory;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'inventory.validate', 'inventory', i.id::text, i.code, null, null, jsonb_build_object('lines', v_n, 'adjusted', v_adj), 'rpc');
  return v_adj;
end $$;

create function public.stock_inventory_cancel(p_inventory uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  update public.stock_inventories set status = 'cancelled', closed_at = now(), closed_by = auth.uid() where id = p_inventory;
  perform private.write_audit(i.company_id, 'inventory.cancel', 'inventory', i.id::text, i.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Archivage des entrepôts et emplacements (uniquement vides)
-- ---------------------------------------------------------------------
create function public.stock_warehouse_archive(p_warehouse uuid, p_archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into w from public.warehouses where id = p_warehouse and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_archive then
    if w.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
    if exists (select 1 from public.stock_lots where warehouse_id = p_warehouse and qty_remaining > 0)
       or exists (select 1 from public.stock_reservations where warehouse_id = p_warehouse and status = 'active')
       or exists (select 1 from public.stock_inventories where warehouse_id = p_warehouse and status = 'draft') then
      raise exception 'STOCK_NOT_EMPTY' using errcode = '55000';
    end if;
  elsif w.archived_at is null then raise exception 'STOCK_BAD_STATUS' using errcode = '55000';
  end if;
  perform set_config('stock.rpc', 'on', true);
  update public.warehouses set archived_at = case when p_archive then now() end, updated_at = now(), updated_by = auth.uid() where id = p_warehouse;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(w.company_id, case when p_archive then 'warehouse.archive' else 'warehouse.restore' end, 'warehouse', w.id::text, w.code, null, null, jsonb_build_object('name', w.name), 'rpc');
end $$;

create function public.stock_location_archive(p_location uuid, p_archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.stock_locations%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into l from public.stock_locations where id = p_location and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_archive then
    if l.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if exists (select 1 from public.stock_lots where location_id = p_location and qty_remaining > 0) then raise exception 'STOCK_NOT_EMPTY' using errcode = '55000'; end if;
    if (select count(*) from public.stock_locations where warehouse_id = l.warehouse_id and archived_at is null) <= 1 then raise exception 'STOCK_LAST_LOCATION' using errcode = '55000'; end if;
  else
    if l.archived_at is null then raise exception 'STOCK_BAD_STATUS' using errcode = '55000'; end if;
    if exists (select 1 from public.warehouses where id = l.warehouse_id and archived_at is not null) then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  end if;
  perform set_config('stock.rpc', 'on', true);
  update public.stock_locations set archived_at = case when p_archive then now() end where id = p_location;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(l.company_id, case when p_archive then 'location.archive' else 'location.restore' end, 'location', l.id::text, l.code, null, null,
    jsonb_build_object('warehouse_id', l.warehouse_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Historique (entrepôts, emplacements) : lisible avec stock.read
-- ---------------------------------------------------------------------
create function private.audit_warehouses() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if coalesce(current_setting('stock.rpc', true), 'off') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'warehouse.create', 'warehouse', new.id::text, new.code, null, jsonb_build_object('code', new.code, 'name', new.name, 'city', new.city));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','city','address')));
    if v_chg -> 'after' <> '{}'::jsonb then perform private.write_audit(new.company_id, 'warehouse.update', 'warehouse', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after'); end if;
  end if;
  return new;
end $$;
create trigger audit_warehouses_iu after insert or update on public.warehouses for each row execute function private.audit_warehouses();

create function private.audit_stock_locations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb; v_wh text;
begin
  if coalesce(current_setting('stock.rpc', true), 'off') = 'on' then return new; end if;
  select code into v_wh from public.warehouses where id = new.warehouse_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'location.create', 'location', new.id::text, new.code, null, jsonb_build_object('code', new.code, 'name', new.name, 'kind', new.kind), jsonb_build_object('warehouse', v_wh, 'warehouse_id', new.warehouse_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','kind','code')));
    if v_chg -> 'after' <> '{}'::jsonb then perform private.write_audit(new.company_id, 'location.update', 'location', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('warehouse', v_wh, 'warehouse_id', new.warehouse_id)); end if;
  end if;
  return new;
end $$;
create trigger audit_stock_locations_iu after insert or update on public.stock_locations for each row execute function private.audit_stock_locations();

create policy audit_logs_select_stock on public.audit_logs for select to authenticated
  using (entity_type in ('warehouse', 'location', 'inventory', 'stock') and company_id = private.current_company() and private.has_perm('stock.read'));

-- ---------------------------------------------------------------------
-- 9. RLS + privilèges
-- ---------------------------------------------------------------------
alter table public.warehouses                enable row level security;
alter table public.stock_locations           enable row level security;
alter table public.stock_lots                enable row level security;
alter table public.stock_lot_costs           enable row level security;
alter table public.stock_movements           enable row level security;
alter table public.stock_movement_allocations enable row level security;
alter table public.stock_movement_costs      enable row level security;
alter table public.stock_reservations        enable row level security;
alter table public.stock_thresholds          enable row level security;
alter table public.stock_inventories         enable row level security;
alter table public.stock_inventory_lines     enable row level security;

revoke all on public.warehouses, public.stock_locations, public.stock_lots, public.stock_lot_costs, public.stock_movements,
              public.stock_movement_allocations, public.stock_movement_costs, public.stock_reservations, public.stock_thresholds,
              public.stock_inventories, public.stock_inventory_lines, public.stock_overview from anon, authenticated;
grant all on public.warehouses, public.stock_locations, public.stock_lots, public.stock_lot_costs, public.stock_movements,
             public.stock_movement_allocations, public.stock_movement_costs, public.stock_reservations, public.stock_thresholds,
             public.stock_inventories, public.stock_inventory_lines, public.stock_overview to service_role;
grant select on public.warehouses, public.stock_locations, public.stock_lots, public.stock_lot_costs, public.stock_movements,
                public.stock_movement_allocations, public.stock_movement_costs, public.stock_reservations, public.stock_thresholds,
                public.stock_inventories, public.stock_inventory_lines, public.stock_overview to authenticated;
grant insert (name, city, address) on public.warehouses to authenticated;
grant update (name, city, address) on public.warehouses to authenticated;
grant insert (warehouse_id, code, name, kind) on public.stock_locations to authenticated;
grant update (name, kind) on public.stock_locations to authenticated;
grant update (counted_qty) on public.stock_inventory_lines to authenticated;

do $$
declare t text;
begin
  foreach t in array array['warehouses','stock_locations','stock_lots','stock_movements','stock_movement_allocations','stock_reservations','stock_thresholds','stock_inventories','stock_inventory_lines'] loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm('stock.read'))$f$, t || '_select', t);
  end loop;
end $$;
create policy stock_lot_costs_select on public.stock_lot_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.has_perm('costs.read'));
create policy stock_movement_costs_select on public.stock_movement_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.has_perm('costs.read'));

create policy warehouses_insert on public.warehouses for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy warehouses_update on public.warehouses for update to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.write')) with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy stock_locations_insert on public.stock_locations for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy stock_locations_update on public.stock_locations for update to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.write')) with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy stock_inv_lines_update on public.stock_inventory_lines for update to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.write')) with check (company_id = private.current_company() and private.has_perm('stock.write'));

do $$
declare f text;
begin
  foreach f in array array['stock_move(text,uuid,numeric,uuid,uuid,uuid,text,text,numeric,uuid)', 'stock_reserve(uuid,uuid,numeric,text,text)', 'stock_release(uuid)',
      'stock_set_safety(uuid,uuid,numeric)', 'stock_inventory_create(uuid,uuid,text)', 'stock_inventory_add_line(uuid,uuid,uuid)', 'stock_inventory_validate(uuid)',
      'stock_inventory_cancel(uuid)', 'stock_warehouse_archive(uuid,boolean)', 'stock_location_archive(uuid,boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ===== 0010_mrp.sql =====
-- =====================================================================
-- 0010_mrp — Moteur MRP
--  Sources : commandes client (socle minimal ci-dessous), prévisions, BOM validées, stock (lots, réservations,
--  stock de sécurité), réceptions planifiées.
--  Calculs : besoin brut (explosion multi-niveaux des BOM validées), besoin net (projection datée),
--  prise en compte du stock de sécurité, MOQ / multiple de commande, délai d'approvisionnement.
--  Sorties : simulations figées (mrp_runs), besoins par composant, suggestions d'achat, alertes de rupture.
--  Permissions nouvelles : mrp.read / mrp.write. Commandes : orders.read / orders.write / orders.confirm (existantes).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('mrp.read',  'mrp', 'Voir le MRP', 'Simulations, besoins, suggestions d''achat, alertes de rupture, prévisions'),
  ('mrp.write', 'mrp', 'Gérer le MRP', 'Lancer des simulations, saisir prévisions, paramètres d''approvisionnement et réceptions planifiées, décider des suggestions')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('mrp.read', 'mrp.write'))
  or (r.code = 'direction'  and p.code = 'mrp.read')
  or (r.code = 'commercial' and p.code = 'mrp.read')
  or (r.code = 'achat'      and p.code in ('mrp.read', 'mrp.write'))
  or (r.code = 'production' and p.code in ('mrp.read', 'mrp.write'))
  or (r.code = 'magasin'    and p.code = 'mrp.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Commandes client (socle minimal : source de la demande du MRP ; le module Commandes l'enrichira)
-- ---------------------------------------------------------------------
create table public.sales_orders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  code         text not null,                                              -- CMD-0001 (généré)
  client_id    uuid not null references public.clients(id),
  client_ref   text check (client_ref is null or length(client_ref) <= 60),  -- n° de commande du client
  status       text not null default 'draft' check (status in ('draft','confirmed','delivered','cancelled')),
  order_date   date not null default current_date,
  notes        text check (notes is null or length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  confirmed_at timestamptz,
  confirmed_by uuid,
  unique (company_id, code)
);
create index sales_orders_idx on public.sales_orders (company_id, status);

create table public.sales_order_lines (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  order_id   uuid not null references public.sales_orders(id) on delete cascade,
  article_id uuid not null references public.articles(id),
  qty        numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  due_date   date not null,                                                -- date de livraison demandée
  note       text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now()
);
create index sales_order_lines_idx on public.sales_order_lines (order_id);
create index sales_order_lines_art_idx on public.sales_order_lines (article_id);

create function private.sales_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'CMD-' || lpad(private.next_seq(new.company_id, 'sales_order')::text, 4, '0');
    perform private.ged_assert_client_open(new.client_id);
    if not exists (select 1 from public.clients where id = new.client_id and company_id = new.company_id) then raise exception 'ORDER_BAD_CLIENT' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.status := 'draft'; new.confirmed_at := null; new.confirmed_by := null;
  elsif coalesce(current_setting('orders.rpc', true), 'off') <> 'on' then
    if old.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'ORDER_LOCKED' using errcode = '42501'; end if;
  end if;
  new.client_ref := nullif(btrim(coalesce(new.client_ref, '')), '');
  return new;
end $$;
create trigger sales_orders_before_iu before insert or update on public.sales_orders
  for each row execute function private.sales_orders_before();

create function private.sales_order_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; a public.articles%rowtype; v_order uuid := coalesce(new.order_id, old.order_id);
begin
  select * into o from public.sales_orders where id = v_order;
  if coalesce(current_setting('orders.rpc', true), 'off') <> 'on' and found and o.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := o.company_id;
    select * into a from public.articles where id = new.article_id;
    if not found or a.client_id <> o.client_id then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;   -- l'article doit appartenir au client de la commande
    if a.status = 'discontinued' then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger sales_order_lines_before_iud before insert or update or delete on public.sales_order_lines
  for each row execute function private.sales_order_lines_before();

create function public.sales_order_confirm(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype;
begin
  perform private.require_perm('orders.confirm');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.sales_order_lines where order_id = p_order) then raise exception 'ORDER_EMPTY' using errcode = '55000'; end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid() where id = p_order;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'order.confirm', 'order', o.id::text, o.code, null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.sales_order_set_status(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype;
begin
  perform private.require_perm('orders.write');
  if p_status not in ('cancelled', 'delivered') then raise exception 'ORDER_BAD_STATUS' using errcode = '22023'; end if;
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if (p_status = 'cancelled' and o.status not in ('draft', 'confirmed')) or (p_status = 'delivered' and o.status <> 'confirmed') then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set status = p_status where id = p_order;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, case p_status when 'cancelled' then 'order.cancel' else 'order.deliver' end, 'order', o.id::text, o.code, jsonb_build_object('status', o.status), jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

create function private.audit_sales_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(new.company_id, 'order.create', 'order', new.id::text, new.code, null,
    jsonb_build_object('code', new.code, 'client', (select name from public.clients where id = new.client_id), 'client_ref', new.client_ref));
  return new;
end $$;
create trigger audit_sales_orders_i after insert on public.sales_orders for each row execute function private.audit_sales_orders();

-- ---------------------------------------------------------------------
-- 3. Prévisions, paramètres d'approvisionnement, réceptions planifiées
-- ---------------------------------------------------------------------
create table public.mrp_forecasts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  article_id    uuid not null references public.articles(id),
  forecast_date date not null,
  qty           numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index mrp_forecasts_idx on public.mrp_forecasts (company_id, forecast_date);

create table public.mrp_params (
  material_id     uuid primary key references public.bom_materials(id) on delete cascade,
  company_id      uuid not null references public.companies(id),
  lead_time_days  int check (lead_time_days is null or lead_time_days between 0 and 365),   -- null = délai du fournisseur
  moq             numeric(14,4) not null default 0 check (moq >= 0),                          -- quantité minimale de commande
  order_multiple  numeric(14,4) not null default 0 check (order_multiple >= 0),               -- 0 = pas de multiple
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);

create table public.mrp_scheduled_receipts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  material_id uuid not null references public.bom_materials(id) on delete cascade,
  qty         numeric(14,4) not null check (qty > 0),
  due_date    date not null,
  reference   text check (reference is null or length(reference) <= 120),                      -- ex. n° de commande d'achat
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index mrp_receipts_idx on public.mrp_scheduled_receipts (material_id, due_date);

create function private.mrp_inputs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if tg_argv[0] = 'article' then
      if not exists (select 1 from public.articles where id = new.article_id and company_id = new.company_id) then raise exception 'MRP_BAD_ARTICLE' using errcode = '22023'; end if;
    else
      if not exists (select 1 from public.bom_materials where id = new.material_id and company_id = new.company_id) then raise exception 'MRP_BAD_MATERIAL' using errcode = '22023'; end if;
    end if;
    if tg_table_name <> 'mrp_params' then new.created_by := auth.uid(); end if;
  end if;
  if tg_table_name = 'mrp_params' then new.updated_at := now(); new.updated_by := auth.uid(); end if;
  return new;
end $$;
create trigger mrp_forecasts_before_i before insert on public.mrp_forecasts for each row execute function private.mrp_inputs_before('article');
create trigger mrp_receipts_before_i before insert on public.mrp_scheduled_receipts for each row execute function private.mrp_inputs_before('material');
create trigger mrp_params_before_iu before insert or update on public.mrp_params for each row execute function private.mrp_inputs_before('material');

-- ---------------------------------------------------------------------
-- 4. Résultats des simulations (figés)
-- ---------------------------------------------------------------------
create table public.mrp_runs (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null,                                               -- MRP-0001
  name       text not null check (length(btrim(name)) between 2 and 160),
  as_of      date not null,
  params     jsonb not null default '{}'::jsonb,
  summary    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (company_id, code)
);

create table public.mrp_run_materials (
  run_id          uuid not null references public.mrp_runs(id) on delete cascade,
  material_id     uuid not null references public.bom_materials(id) on delete cascade,
  company_id      uuid not null references public.companies(id),
  gross           numeric(16,4) not null default 0,       -- besoin brut total sur l'horizon
  on_hand         numeric(16,4) not null default 0,
  reserved        numeric(16,4) not null default 0,
  safety          numeric(16,4) not null default 0,
  receipts        numeric(16,4) not null default 0,       -- réceptions planifiées
  net             numeric(16,4) not null default 0,       -- besoin net (avant arrondi MOQ / multiple)
  suggested       numeric(16,4) not null default 0,       -- quantité à commander (après arrondi)
  lead_time_days  int not null default 0,
  moq             numeric(14,4) not null default 0,
  order_multiple  numeric(14,4) not null default 0,
  supplier_id     uuid references public.suppliers(id) on delete set null,
  first_need_date date,
  shortage_date   date,                                   -- premier jour où le stock projeté (sans achat) devient négatif
  alert           text check (alert in ('critical', 'high', 'low')),
  timeline        jsonb not null default '[]'::jsonb,
  primary key (run_id, material_id)
);
create index mrp_run_materials_alert_idx on public.mrp_run_materials (run_id, alert);

create table public.mrp_run_pegging (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.mrp_runs(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  material_id uuid not null references public.bom_materials(id) on delete cascade,
  need_date   date not null,
  source_type text not null check (source_type in ('order', 'forecast')),
  source_id   uuid not null,
  article_id  uuid not null references public.articles(id) on delete cascade,
  demand_qty  numeric(14,2) not null,
  qty         numeric(16,4) not null
);
create index mrp_run_pegging_idx on public.mrp_run_pegging (run_id, material_id, need_date);

create table public.mrp_run_suggestions (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.mrp_runs(id) on delete cascade,
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id) on delete cascade,
  supplier_id  uuid references public.suppliers(id) on delete set null,
  qty          numeric(16,4) not null check (qty > 0),
  need_date    date not null,
  release_date date not null,                              -- date limite de commande = besoin − délai
  late         boolean not null default false,             -- date de commande déjà dépassée : la livraison arrivera trop tard
  status       text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  note         text check (note is null or length(note) <= 300),
  decided_by   uuid,
  decided_at   timestamptz
);
create index mrp_run_suggestions_idx on public.mrp_run_suggestions (run_id, supplier_id, release_date);

-- ---------------------------------------------------------------------
-- 5. Explosion des BOM validées (multi-niveaux) : besoin en composants pour UNE pièce d'un article
-- ---------------------------------------------------------------------
create function private.mrp_unit_requirements(p_article uuid)
returns table (material_id uuid, qty numeric)
language sql stable security definer set search_path = '' as $$
  with recursive t(version_id, mult, depth) as (
    select b.active_version_id, 1::numeric, 0
    from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
    union all
    select cb.active_version_id, t.mult * l.quantity, t.depth + 1
    from t
    join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null
    where t.depth < 8
  )
  select l.material_id, sum(t.mult * l.quantity * (1 + l.waste_pct / 100))
  from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'material'
  group by l.material_id
$$;
revoke execute on function private.mrp_unit_requirements(uuid) from public, anon, authenticated;

-- Problème de nomenclature d'un article : 'no_bom' (aucune BOM validée) ou 'incomplete' (sous-ensemble non validé / archivé)
create function private.mrp_article_issue(p_article uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null) then return 'no_bom'; end if;
  if exists (
    with recursive t(version_id, depth) as (
      select b.active_version_id, 0 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
      union all
      select cb.active_version_id, t.depth + 1 from t
      join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
      join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null where t.depth < 8)
    select 1 from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id where cb.archived_at is not null or cb.active_version_id is null
  ) then return 'incomplete'; end if;
  return null;
end $$;
revoke execute on function private.mrp_article_issue(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Le moteur : simulation MRP
--    p_params : horizon_days (90), offset_days (7 : délai de production avant la livraison), include_forecasts (true),
--               include_draft_orders (false), use_safety (true), default_lead_days (14)
-- ---------------------------------------------------------------------
create function public.mrp_run(p_name text default null, p_params jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_run uuid := gen_random_uuid();
  v_horizon int := least(greatest(coalesce((p_params ->> 'horizon_days')::int, 90), 7), 365);
  v_offset int := least(greatest(coalesce((p_params ->> 'offset_days')::int, 7), 0), 120);
  v_fc boolean := coalesce((p_params ->> 'include_forecasts')::boolean, true);
  v_draft boolean := coalesce((p_params ->> 'include_draft_orders')::boolean, false);
  v_safety boolean := coalesce((p_params ->> 'use_safety')::boolean, true);
  v_deflead int := least(greatest(coalesce((p_params ->> 'default_lead_days')::int, 14), 0), 365);
  v_asof date := current_date; v_end date; v_code text; v_name text;
  m record; ev record; prm public.mrp_params%rowtype;
  v_onhand numeric; v_res numeric; v_safe numeric; v_lead int; v_moq numeric; v_mult numeric; v_sup uuid;
  v_gross numeric; v_rec numeric; v_net numeric; v_sugg numeric; v_first date; v_short date;
  v_proj numeric; v_raw numeric; v_g numeric; v_r numeric; v_plan numeric; v_need numeric; v_tl jsonb; v_alert text; v_late int := 0; v_nsug int := 0;
  v_crit int := 0; v_high int := 0; v_low int := 0; v_warn jsonb; v_n_orders int; v_n_fc int;
begin
  perform private.require_perm('mrp.write');
  v_end := v_asof + v_horizon;
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Simulation du ' || to_char(now(), 'DD/MM/YYYY HH24:MI'));
  if length(v_name) > 160 then v_name := left(v_name, 160); end if;
  v_code := 'MRP-' || lpad(private.next_seq(v_co, 'mrp_run')::text, 4, '0');

  drop table if exists _mrp_d; drop table if exists _mrp_u;
  create temp table _mrp_d (source_type text, source_id uuid, article_id uuid, qty numeric, need date) on commit drop;
  -- demande : commandes client confirmées (+ brouillons si demandé) puis prévisions
  insert into _mrp_d
  select 'order', l.id, l.article_id, l.qty, greatest(l.due_date - v_offset, v_asof)
  from public.sales_order_lines l join public.sales_orders o on o.id = l.order_id
  where o.company_id = v_co and (o.status = 'confirmed' or (v_draft and o.status = 'draft')) and l.due_date - v_offset <= v_end;
  get diagnostics v_n_orders = row_count;
  if v_fc then
    insert into _mrp_d select 'forecast', f.id, f.article_id, f.qty, greatest(f.forecast_date - v_offset, v_asof)
    from public.mrp_forecasts f where f.company_id = v_co and f.forecast_date - v_offset <= v_end;
    get diagnostics v_n_fc = row_count;
  else v_n_fc := 0; end if;

  create temp table _mrp_u (article_id uuid, material_id uuid, qty numeric) on commit drop;
  insert into _mrp_u select a.article_id, u.material_id, u.qty from (select distinct article_id from _mrp_d) a, lateral private.mrp_unit_requirements(a.article_id) u;

  -- articles de la demande sans nomenclature exploitable
  select coalesce(jsonb_agg(jsonb_build_object('article_id', x.article_id, 'ref', a.internal_ref, 'name', a.name, 'issue', x.issue, 'qty', x.qty) order by a.internal_ref), '[]'::jsonb) into v_warn
  from (select article_id, private.mrp_article_issue(article_id) issue, sum(qty) qty from _mrp_d group by article_id) x
  join public.articles a on a.id = x.article_id where x.issue is not null;

  insert into public.mrp_runs (id, company_id, code, name, as_of, params, created_by)
  values (v_run, v_co, v_code, v_name, v_asof, jsonb_build_object('horizon_days', v_horizon, 'offset_days', v_offset, 'include_forecasts', v_fc,
         'include_draft_orders', v_draft, 'use_safety', v_safety, 'default_lead_days', v_deflead), auth.uid());

  insert into public.mrp_run_pegging (run_id, company_id, material_id, need_date, source_type, source_id, article_id, demand_qty, qty)
  select v_run, v_co, u.material_id, d.need, d.source_type, d.source_id, d.article_id, d.qty, d.qty * u.qty
  from _mrp_d d join _mrp_u u on u.article_id = d.article_id;

  for m in
    select material_id from public.mrp_run_pegging where run_id = v_run
    union select t.material_id from public.stock_thresholds t where v_safety and t.company_id = v_co and t.safety_qty > 0
  loop
    select coalesce(sum(qty_remaining), 0) into v_onhand from public.stock_lots where material_id = m.material_id and company_id = v_co;
    select coalesce(sum(qty - qty_consumed), 0) into v_res from public.stock_reservations where material_id = m.material_id and company_id = v_co and status = 'active';
    select case when v_safety then coalesce(sum(safety_qty), 0) else 0 end into v_safe from public.stock_thresholds where material_id = m.material_id and company_id = v_co;
    select * into prm from public.mrp_params where material_id = m.material_id;
    select supplier_id into v_sup from public.bom_materials where id = m.material_id;
    v_lead := coalesce(prm.lead_time_days, (select lead_time_days from public.suppliers where id = v_sup), v_deflead);
    v_moq := coalesce(prm.moq, 0); v_mult := coalesce(prm.order_multiple, 0);

    v_gross := 0; v_rec := 0; v_net := 0; v_sugg := 0; v_first := null; v_short := null; v_tl := '[]'::jsonb;
    v_proj := v_onhand - v_res; v_raw := v_proj;

    for ev in
      select dt from (
        select v_asof dt
        union select need_date from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id and need_date <= v_end
        union select greatest(due_date, v_asof) from public.mrp_scheduled_receipts where material_id = m.material_id and company_id = v_co and greatest(due_date, v_asof) <= v_end
      ) x order by dt
    loop
      select coalesce(sum(qty), 0) into v_g from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id and need_date = ev.dt;
      select coalesce(sum(qty), 0) into v_r from public.mrp_scheduled_receipts where material_id = m.material_id and company_id = v_co and greatest(due_date, v_asof) = ev.dt;
      v_gross := v_gross + v_g; v_rec := v_rec + v_r;
      if v_g > 0 and v_first is null then v_first := ev.dt; end if;
      v_proj := v_proj + v_r - v_g; v_raw := v_raw + v_r - v_g;
      if v_raw < 0 and v_short is null then v_short := ev.dt; end if;
      v_plan := 0;
      if v_proj < v_safe then
        v_need := v_safe - v_proj; v_net := v_net + v_need; v_plan := v_need;
        if v_moq > 0 then v_plan := greatest(v_plan, v_moq); end if;
        if v_mult > 0 then v_plan := ceil(v_plan / v_mult) * v_mult; end if;
        v_proj := v_proj + v_plan; v_sugg := v_sugg + v_plan;
        insert into public.mrp_run_suggestions (run_id, company_id, material_id, supplier_id, qty, need_date, release_date, late)
        values (v_run, v_co, m.material_id, v_sup, v_plan, ev.dt, ev.dt - v_lead, ev.dt - v_lead < v_asof);
        v_nsug := v_nsug + 1; if ev.dt - v_lead < v_asof then v_late := v_late + 1; end if;
      end if;
      v_tl := v_tl || jsonb_build_object('date', ev.dt, 'gross', v_g, 'receipts', v_r, 'planned', v_plan, 'projected', v_proj);
    end loop;

    v_alert := case when v_short is not null and v_short - v_lead < v_asof then 'critical' when v_short is not null then 'high' when v_sugg > 0 then 'low' end;
    if v_alert = 'critical' then v_crit := v_crit + 1; elsif v_alert = 'high' then v_high := v_high + 1; elsif v_alert = 'low' then v_low := v_low + 1; end if;
    insert into public.mrp_run_materials (run_id, material_id, company_id, gross, on_hand, reserved, safety, receipts, net, suggested, lead_time_days, moq, order_multiple,
                                          supplier_id, first_need_date, shortage_date, alert, timeline)
    values (v_run, m.material_id, v_co, v_gross, v_onhand, v_res, v_safe, v_rec, v_net, v_sugg, v_lead, v_moq, v_mult, v_sup, v_first, v_short, v_alert, v_tl);
  end loop;

  update public.mrp_runs set summary = jsonb_build_object(
      'materials', (select count(*) from public.mrp_run_materials where run_id = v_run),
      'critical', v_crit, 'high', v_high, 'low', v_low, 'suggestions', v_nsug, 'late_suggestions', v_late,
      'orders_lines', v_n_orders, 'forecast_lines', v_n_fc, 'warnings', v_warn)
  where id = v_run;
  perform private.write_audit(v_co, 'mrp.run', 'mrp', v_run::text, v_code, null, null,
    jsonb_build_object('name', v_name, 'critical', v_crit, 'high', v_high, 'suggestions', v_nsug), 'rpc');
  return v_run;
end $$;

create function public.mrp_suggestion_decide(p_suggestion uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.mrp_run_suggestions%rowtype; v_code text;
begin
  perform private.require_perm('mrp.write');
  if p_status not in ('proposed', 'accepted', 'rejected') then raise exception 'MRP_BAD_STATUS' using errcode = '22023'; end if;
  select * into s from public.mrp_run_suggestions where id = p_suggestion and company_id = private.current_company() for update;
  if not found then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.mrp_run_suggestions set status = p_status, note = nullif(btrim(coalesce(p_note, '')), ''),
         decided_by = case when p_status = 'proposed' then null else auth.uid() end, decided_at = case when p_status = 'proposed' then null else now() end
  where id = p_suggestion;
  select code into v_code from public.mrp_runs where id = s.run_id;
  perform private.write_audit(s.company_id, 'mrp.decide', 'mrp', s.run_id::text, v_code, jsonb_build_object('status', s.status), jsonb_build_object('status', p_status),
    jsonb_build_object('material_id', s.material_id, 'qty', s.qty, 'note', p_note), 'rpc');
end $$;

create function public.mrp_run_delete(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.mrp_runs%rowtype;
begin
  perform private.require_perm('mrp.write');
  select * into r from public.mrp_runs where id = p_run and company_id = private.current_company() for update;
  if not found then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
  delete from public.mrp_runs where id = p_run;
  perform private.write_audit(r.company_id, 'mrp.delete', 'mrp', r.id::text, r.code, null, null, jsonb_build_object('name', r.name), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Historique, RLS, privilèges
-- ---------------------------------------------------------------------
create policy audit_logs_select_mrp on public.audit_logs for select to authenticated
  using (((entity_type = 'mrp' and private.has_perm('mrp.read')) or (entity_type = 'order' and private.has_perm('orders.read'))) and company_id = private.current_company());

alter table public.sales_orders enable row level security;
alter table public.sales_order_lines enable row level security;
alter table public.mrp_forecasts enable row level security;
alter table public.mrp_params enable row level security;
alter table public.mrp_scheduled_receipts enable row level security;
alter table public.mrp_runs enable row level security;
alter table public.mrp_run_materials enable row level security;
alter table public.mrp_run_pegging enable row level security;
alter table public.mrp_run_suggestions enable row level security;

revoke all on public.sales_orders, public.sales_order_lines, public.mrp_forecasts, public.mrp_params, public.mrp_scheduled_receipts,
              public.mrp_runs, public.mrp_run_materials, public.mrp_run_pegging, public.mrp_run_suggestions from anon, authenticated;
grant all on public.sales_orders, public.sales_order_lines, public.mrp_forecasts, public.mrp_params, public.mrp_scheduled_receipts,
             public.mrp_runs, public.mrp_run_materials, public.mrp_run_pegging, public.mrp_run_suggestions to service_role;
grant select on public.sales_orders, public.sales_order_lines, public.mrp_forecasts, public.mrp_params, public.mrp_scheduled_receipts,
                public.mrp_runs, public.mrp_run_materials, public.mrp_run_pegging, public.mrp_run_suggestions to authenticated;

grant insert (client_id, client_ref, order_date, notes) on public.sales_orders to authenticated;
grant update (client_ref, order_date, notes) on public.sales_orders to authenticated;
grant insert (order_id, article_id, qty, due_date, note) on public.sales_order_lines to authenticated;
grant update (qty, due_date, note) on public.sales_order_lines to authenticated;
grant delete on public.sales_order_lines to authenticated;
grant insert (article_id, forecast_date, qty, note) on public.mrp_forecasts to authenticated;
grant update (forecast_date, qty, note) on public.mrp_forecasts to authenticated;
grant delete on public.mrp_forecasts to authenticated;
grant insert (material_id, lead_time_days, moq, order_multiple) on public.mrp_params to authenticated;
grant update (lead_time_days, moq, order_multiple) on public.mrp_params to authenticated;
grant insert (material_id, qty, due_date, reference) on public.mrp_scheduled_receipts to authenticated;
grant update (qty, due_date, reference) on public.mrp_scheduled_receipts to authenticated;
grant delete on public.mrp_scheduled_receipts to authenticated;

create policy sales_orders_select on public.sales_orders for select to authenticated using (company_id = private.current_company() and private.has_perm('orders.read'));
create policy sales_orders_insert on public.sales_orders for insert to authenticated with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_orders_update on public.sales_orders for update to authenticated using (company_id = private.current_company() and private.has_perm('orders.write')) with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_order_lines_select on public.sales_order_lines for select to authenticated using (company_id = private.current_company() and private.has_perm('orders.read'));
create policy sales_order_lines_insert on public.sales_order_lines for insert to authenticated with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_order_lines_update on public.sales_order_lines for update to authenticated using (company_id = private.current_company() and private.has_perm('orders.write')) with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_order_lines_delete on public.sales_order_lines for delete to authenticated using (company_id = private.current_company() and private.has_perm('orders.write'));

do $$
declare t text;
begin
  foreach t in array array['mrp_forecasts', 'mrp_params', 'mrp_scheduled_receipts', 'mrp_runs', 'mrp_run_materials', 'mrp_run_pegging', 'mrp_run_suggestions'] loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm('mrp.read'))$f$, t || '_select', t);
  end loop;
  foreach t in array array['mrp_forecasts', 'mrp_params', 'mrp_scheduled_receipts'] loop
    execute format($f$create policy %I on public.%I for insert to authenticated with check (company_id = private.current_company() and private.has_perm('mrp.write'))$f$, t || '_insert', t);
    execute format($f$create policy %I on public.%I for update to authenticated using (company_id = private.current_company() and private.has_perm('mrp.write')) with check (company_id = private.current_company() and private.has_perm('mrp.write'))$f$, t || '_update', t);
  end loop;
  foreach t in array array['mrp_forecasts', 'mrp_scheduled_receipts'] loop
    execute format($f$create policy %I on public.%I for delete to authenticated using (company_id = private.current_company() and private.has_perm('mrp.write'))$f$, t || '_delete', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['sales_order_confirm(uuid)', 'sales_order_set_status(uuid,text)', 'mrp_run(text,jsonb)', 'mrp_suggestion_decide(uuid,text,text)', 'mrp_run_delete(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ===== 0011_purchases.sql =====
-- =====================================================================
-- 0011_purchases — Module Achats
--  Workflow : Demande d'achat (DA) → validation → Bon de commande fournisseur (BC) → Réception → (Retour fournisseur)
--  Réception et retour alimentent le stock automatiquement (lots FIFO au prix de la commande).
--  Statistiques d'achat. Les commandes d'achat réutilisent `purchase_orders` (module Fournisseurs) : mêmes statuts
--  (draft / sent / partial / received / cancelled), donc l'historique et les statistiques fournisseur restent valables.
--  Permissions : purchases.read / purchases.write / purchases.approve (existantes)
--                purchases.request (demander), purchases.receive (réceptionner, retourner) — nouvelles.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('purchases.request', 'purchases', 'Créer des demandes d''achat', 'Saisir et soumettre ses demandes d''achat'),
  ('purchases.receive', 'purchases', 'Réceptionner et retourner', 'Réceptions de commandes fournisseur (entrée en stock) et retours fournisseur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('purchases.request', 'purchases.receive'))
  or (r.code = 'achat'      and p.code in ('purchases.request', 'purchases.receive'))
  or (r.code = 'production' and p.code = 'purchases.request')
  or (r.code = 'magasin'    and p.code in ('purchases.request', 'purchases.receive')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Entrée de stock « de confiance » : le coût du lot reçu est le prix de la commande, quel que soit le droit de l'utilisateur
--    (même fonction que 0009, une seule ligne modifiée : GUC stock.trusted_cost)
-- ---------------------------------------------------------------------
create or replace function private.stock_apply(p_type text, p_dir text, p_material uuid, p_qty numeric, p_wh uuid, p_loc uuid, p_to_loc uuid,
                                    p_ref text, p_reason text, p_cost numeric, p_res uuid, p_inv uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company();
  m public.bom_materials%rowtype; w public.warehouses%rowtype; l public.stock_locations%rowtype; tl public.stock_locations%rowtype;
  r public.stock_reservations%rowtype; v_id uuid := gen_random_uuid(); v_lot uuid; v_cost numeric; v_total numeric := 0;
  v_oh numeric; v_rs numeric; v_to_wh uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into w from public.warehouses where id = p_wh and company_id = v_co;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if w.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  if p_loc is not null then
    select * into l from public.stock_locations where id = p_loc and warehouse_id = p_wh;
    if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  p_ref := nullif(btrim(coalesce(p_ref, '')), ''); p_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if p_dir = 'in' then
    if p_loc is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
    if l.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if p_type = 'in' and m.archived_at is not null then raise exception 'STOCK_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
  elsif p_dir = 'move' then
    select * into tl from public.stock_locations where id = p_to_loc and company_id = v_co;
    if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
    if tl.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if p_loc is not null and p_loc = p_to_loc then raise exception 'STOCK_SAME_LOCATION' using errcode = '22023'; end if;
    v_to_wh := tl.warehouse_id;
    if exists (select 1 from public.warehouses where id = v_to_wh and archived_at is not null) then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  end if;

  -- disponibilité : les sorties et transferts respectent les réservations (sauf la réservation consommée)
  if p_type in ('out', 'transfer') then
    v_oh := private.stock_on_hand(p_material, p_wh); v_rs := private.stock_reserved(p_material, p_wh);
    if p_res is not null then
      select * into r from public.stock_reservations where id = p_res and company_id = v_co for update;
      if not found or r.status <> 'active' or r.material_id <> p_material or r.warehouse_id <> p_wh or p_qty > r.qty - r.qty_consumed then
        raise exception 'STOCK_BAD_RESERVATION' using errcode = '22023';
      end if;
      v_rs := v_rs - (r.qty - r.qty_consumed);
    end if;
    if v_oh < p_qty then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    if v_oh - v_rs < p_qty then raise exception 'STOCK_RESERVED' using errcode = '55000'; end if;
  end if;

  insert into public.stock_movements (id, company_id, type, direction, material_id, qty, warehouse_id, location_id, to_warehouse_id, to_location_id,
                                      reference, reason, reservation_id, inventory_id, created_by)
  values (v_id, v_co, p_type, p_dir, p_material, p_qty, p_wh, p_loc, v_to_wh, case when p_dir = 'move' then p_to_loc end, p_ref, p_reason, p_res, p_inv, auth.uid());

  if p_dir = 'in' then
    -- coût : saisi (costs.read) sinon prix courant du catalogue BOM, sinon 0
    v_cost := case when p_cost is not null and (private.has_perm('costs.read') or coalesce(current_setting('stock.trusted_cost', true), 'off') = 'on') then p_cost end;
    if v_cost is null then select unit_cost into v_cost from public.bom_material_prices where material_id = p_material; end if;
    v_cost := coalesce(v_cost, 0);
    v_lot := gen_random_uuid();
    insert into public.stock_lots (id, company_id, material_id, warehouse_id, location_id, qty_in, qty_remaining, reference, source_movement)
    values (v_lot, v_co, p_material, p_wh, p_loc, p_qty, p_qty, p_ref, v_id);
    insert into public.stock_lot_costs (lot_id, company_id, unit_cost) values (v_lot, v_co, v_cost);
    insert into public.stock_movement_allocations (company_id, movement_id, lot_id, qty) values (v_co, v_id, v_lot, p_qty);
    v_total := p_qty * v_cost;
  else
    v_total := private.stock_consume(v_co, v_id, p_material, p_wh, p_loc, p_qty, v_to_wh, case when p_dir = 'move' then p_to_loc end);
  end if;
  insert into public.stock_movement_costs (movement_id, company_id, total_cost) values (v_id, v_co, v_total);

  if p_res is not null and p_type = 'out' then
    update public.stock_reservations set qty_consumed = qty_consumed + p_qty,
      status = case when qty_consumed + p_qty >= qty then 'consumed' else 'active' end,
      closed_at = case when qty_consumed + p_qty >= qty then now() end
    where id = p_res;
  end if;
  return v_id;
end $$;
revoke execute on function private.stock_apply(text, text, uuid, numeric, uuid, uuid, uuid, text, text, numeric, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Demandes d'achat
-- ---------------------------------------------------------------------
create table public.purchase_requests (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  code             text not null,                                           -- DA-0001
  status           text not null default 'draft' check (status in ('draft','submitted','approved','rejected','ordered','cancelled')),
  needed_date      date,
  reason           text check (reason is null or length(reason) <= 500),
  source           text not null default 'manual' check (source in ('manual','mrp')),
  mrp_run_id       uuid references public.mrp_runs(id) on delete set null,
  requested_by     uuid,
  submitted_at     timestamptz,
  decided_by       uuid,
  decided_at       timestamptz,
  decision_comment text check (decision_comment is null or length(decision_comment) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, code)
);
create index purchase_requests_idx on public.purchase_requests (company_id, status, created_at desc);

create table public.purchase_request_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  request_id   uuid not null references public.purchase_requests(id) on delete cascade,
  material_id  uuid not null references public.bom_materials(id),
  qty          numeric(14,4) not null check (qty > 0 and qty <= 100000000),
  supplier_id  uuid references public.suppliers(id) on delete set null,     -- fournisseur souhaité (sinon celui du composant)
  needed_date  date,
  note         text check (note is null or length(note) <= 300),
  po_line_id   uuid,                                                        -- renseigné à la transformation en commande
  created_at   timestamptz not null default now()
);
create index purchase_request_lines_idx on public.purchase_request_lines (request_id);

alter table public.mrp_run_suggestions add column request_id uuid references public.purchase_requests(id) on delete set null;

-- ---------------------------------------------------------------------
-- 4. Commandes fournisseur : colonnes supplémentaires + lignes
-- ---------------------------------------------------------------------
alter table public.purchase_orders
  add column request_id uuid references public.purchase_requests(id) on delete set null,
  add column sent_at timestamptz,
  add column sent_by uuid;

create table public.purchase_order_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  po_id         uuid not null references public.purchase_orders(id) on delete cascade,
  material_id   uuid not null references public.bom_materials(id),
  qty_ordered   numeric(14,4) not null check (qty_ordered > 0 and qty_ordered <= 100000000),
  unit_price    numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  expected_date date,
  qty_received  numeric(14,4) not null default 0 check (qty_received >= 0),
  qty_returned  numeric(14,4) not null default 0 check (qty_returned >= 0),
  note          text check (note is null or length(note) <= 300),
  request_line_id uuid,
  created_at    timestamptz not null default now(),
  constraint purchase_order_lines_returned_ck check (qty_returned <= qty_received)
);
create index purchase_order_lines_idx on public.purchase_order_lines (po_id);
create index purchase_order_lines_mat_idx on public.purchase_order_lines (material_id);

-- ---------------------------------------------------------------------
-- 5. Réceptions et retours (immuables : écrits uniquement par les fonctions ci-dessous)
-- ---------------------------------------------------------------------
create table public.purchase_receipts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  code          text not null,                                              -- REC-0001
  po_id         uuid not null references public.purchase_orders(id),
  supplier_id   uuid not null references public.suppliers(id),
  warehouse_id  uuid not null references public.warehouses(id),
  delivery_note text check (delivery_note is null or length(delivery_note) <= 80),   -- n° de bon de livraison du fournisseur
  notes         text check (notes is null or length(notes) <= 300),
  received_at   timestamptz not null default now(),
  received_by   uuid,
  unique (company_id, code)
);
create index purchase_receipts_idx on public.purchase_receipts (po_id, received_at desc);

create table public.purchase_receipt_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  receipt_id    uuid not null references public.purchase_receipts(id) on delete cascade,
  po_line_id    uuid not null references public.purchase_order_lines(id),
  material_id   uuid not null references public.bom_materials(id),
  location_id   uuid not null references public.stock_locations(id),
  qty           numeric(14,4) not null check (qty > 0),
  qty_returned  numeric(14,4) not null default 0 check (qty_returned >= 0 and qty_returned <= qty),
  unit_price    numeric(14,4) not null,
  movement_id   uuid references public.stock_movements(id)
);
create index purchase_receipt_lines_idx on public.purchase_receipt_lines (receipt_id);

create table public.purchase_returns (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  code         text not null,                                               -- RET-0001
  receipt_id   uuid not null references public.purchase_receipts(id),
  po_id        uuid not null references public.purchase_orders(id),
  supplier_id  uuid not null references public.suppliers(id),
  warehouse_id uuid not null references public.warehouses(id),
  reason       text not null check (length(btrim(reason)) between 3 and 300),
  returned_at  timestamptz not null default now(),
  returned_by  uuid,
  unique (company_id, code)
);

create table public.purchase_return_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  return_id       uuid not null references public.purchase_returns(id) on delete cascade,
  receipt_line_id uuid not null references public.purchase_receipt_lines(id),
  material_id     uuid not null references public.bom_materials(id),
  qty             numeric(14,4) not null check (qty > 0),
  unit_price      numeric(14,4) not null,
  movement_id     uuid references public.stock_movements(id)
);
create index purchase_return_lines_idx on public.purchase_return_lines (return_id);

-- ---------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------
create function private.purchase_rpc() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('purchases.rpc', true), 'off') = 'on' $$;

create function private.purchase_requests_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'DA-' || lpad(private.next_seq(new.company_id, 'purchase_request')::text, 4, '0');
    new.requested_by := coalesce(auth.uid(), new.requested_by); new.status := 'draft';
    new.submitted_at := null; new.decided_by := null; new.decided_at := null; new.decision_comment := null;
    if new.source = 'mrp' and not private.purchase_rpc() then raise exception 'PURCHASE_BAD_SOURCE' using errcode = '42501'; end if;
  elsif not private.purchase_rpc() then
    if old.status <> 'draft' then raise exception 'PURCHASE_LOCKED' using errcode = '55000'; end if;
    new.updated_at := now();
  end if;
  new.reason := nullif(btrim(coalesce(new.reason, '')), '');
  return new;
end $$;
create trigger purchase_requests_before_iu before insert or update on public.purchase_requests
  for each row execute function private.purchase_requests_before();

create function private.purchase_request_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype; m public.bom_materials%rowtype; v_req uuid := coalesce(new.request_id, old.request_id);
begin
  select * into r from public.purchase_requests where id = v_req;
  if not private.purchase_rpc() and found and r.status <> 'draft' then raise exception 'PURCHASE_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := r.company_id;
    select * into m from public.bom_materials where id = new.material_id and company_id = r.company_id;
    if not found then raise exception 'PURCHASE_BAD_MATERIAL' using errcode = '22023'; end if;
    if m.archived_at is not null and not private.purchase_rpc() then raise exception 'PURCHASE_BAD_MATERIAL' using errcode = '22023'; end if;
    new.po_line_id := null;
  end if;
  if new.supplier_id is not null and not exists (select 1 from public.suppliers where id = new.supplier_id and company_id = new.company_id and archived_at is null) then
    raise exception 'PURCHASE_BAD_SUPPLIER' using errcode = '22023';
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger purchase_request_lines_before_iud before insert or update or delete on public.purchase_request_lines
  for each row execute function private.purchase_request_lines_before();

-- Protection des commandes : création en brouillon, modifications limitées au brouillon (le reste passe par les fonctions)
create function private.purchase_orders_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purchase_rpc() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.total_amount := 0; new.received_date := null; new.sent_at := null; new.sent_by := null; new.request_id := null;
  elsif old.status <> 'draft' then
    raise exception 'PURCHASE_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger purchase_orders_guard_iu before insert or update on public.purchase_orders
  for each row execute function private.purchase_orders_guard();

create function private.purchase_recalc(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('purchases.rpc', true), 'off');
begin
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set total_amount = coalesce((select sum(qty_ordered * unit_price) from public.purchase_order_lines where po_id = p_po), 0), updated_at = now() where id = p_po;
  perform set_config('purchases.rpc', v_prev, true);
end $$;
revoke execute on function private.purchase_recalc(uuid) from public, anon, authenticated;

create function private.purchase_order_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; m public.bom_materials%rowtype; v_po uuid := coalesce(new.po_id, old.po_id);
begin
  select * into o from public.purchase_orders where id = v_po;
  if not private.purchase_rpc() and found and o.status <> 'draft' then raise exception 'PURCHASE_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := o.company_id;
    select * into m from public.bom_materials where id = new.material_id and company_id = o.company_id;
    if not found or (m.archived_at is not null and not private.purchase_rpc()) then raise exception 'PURCHASE_BAD_MATERIAL' using errcode = '22023'; end if;
    if not private.purchase_rpc() then new.qty_received := 0; new.qty_returned := 0; new.request_line_id := null; end if;
  elsif not private.purchase_rpc() then
    new.qty_received := old.qty_received; new.qty_returned := old.qty_returned;
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger purchase_order_lines_before_iud before insert or update or delete on public.purchase_order_lines
  for each row execute function private.purchase_order_lines_before();

create function private.purchase_order_lines_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.qty_ordered = old.qty_ordered and new.unit_price = old.unit_price then return new; end if;
  perform private.purchase_recalc(coalesce(new.po_id, old.po_id));
  return coalesce(new, old);
end $$;
create trigger purchase_order_lines_after_iud after insert or update or delete on public.purchase_order_lines
  for each row execute function private.purchase_order_lines_after();

create function private.audit_purchase_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purchase_rpc() then return new; end if;
  perform private.write_audit(new.company_id, 'purchase.request_create', 'purchase', new.id::text, new.code, null, jsonb_build_object('code', new.code, 'reason', new.reason));
  return new;
end $$;
create trigger audit_purchase_requests_i after insert on public.purchase_requests for each row execute function private.audit_purchase_requests();

create function private.audit_purchase_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purchase_rpc() then return new; end if;
  perform private.write_audit(new.company_id, 'purchase.po_create', 'purchase', new.id::text, new.po_no, null,
    jsonb_build_object('po_no', new.po_no, 'supplier', (select name from public.suppliers where id = new.supplier_id)));
  return new;
end $$;
create trigger audit_purchase_orders_i after insert on public.purchase_orders for each row execute function private.audit_purchase_orders();

-- ---------------------------------------------------------------------
-- 7. Fonctions : demandes d'achat
-- ---------------------------------------------------------------------
create function private.can_edit_request(p_requested_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_perm('purchases.write') or (private.has_perm('purchases.request') and p_requested_by = auth.uid()) $$;
revoke execute on function private.can_edit_request(uuid) from public, anon;
grant execute on function private.can_edit_request(uuid) to authenticated;

create function public.purchase_request_submit(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can_edit_request(r.requested_by) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if r.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_request_lines where request_id = p_request) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = 'submitted', submitted_at = now() where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_submit', 'purchase', r.id::text, r.code, null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.purchase_request_decide(p_request uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  perform private.require_perm('purchases.approve');
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'submitted' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'PURCHASE_SELF_APPROVAL' using errcode = '42501'; end if;     -- séparation des tâches
  if not p_approve and length(btrim(coalesce(p_comment, ''))) < 3 then raise exception 'PURCHASE_COMMENT_REQUIRED' using errcode = '22023'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(),
         decision_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, case when p_approve then 'purchase.request_approve' else 'purchase.request_reject' end, 'purchase', r.id::text, r.code, null, null,
    jsonb_build_object('comment', nullif(btrim(coalesce(p_comment, '')), '')), 'rpc');
end $$;

create function public.purchase_request_cancel(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can_edit_request(r.requested_by) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if r.status not in ('draft', 'submitted', 'approved') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_request_lines where request_id = p_request and po_line_id is not null) then raise exception 'PURCHASE_ALREADY_ORDERED' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = 'cancelled' where id = p_request;
  update public.mrp_run_suggestions set request_id = null where request_id = p_request;      -- les suggestions MRP redeviennent disponibles
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_cancel', 'purchase', r.id::text, r.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- Demande approuvée → un bon de commande (brouillon) par fournisseur
create function public.purchase_request_to_orders(p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.purchase_requests%rowtype; g record; ln record; v_po uuid; v_pol uuid; v_ids jsonb := '[]'::jsonb; v_missing text; v_price numeric; v_lead int; v_exp date;
begin
  perform private.require_perm('purchases.write');
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'approved' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  select string_agg(distinct m.code, ', ') into v_missing
  from public.purchase_request_lines l join public.bom_materials m on m.id = l.material_id
  where l.request_id = p_request and l.po_line_id is null and coalesce(l.supplier_id, m.supplier_id) is null;
  if v_missing is not null then raise exception 'PURCHASE_NO_SUPPLIER' using errcode = '22023', detail = v_missing; end if;

  perform set_config('purchases.rpc', 'on', true);
  for g in
    select coalesce(l.supplier_id, m.supplier_id) as supplier_id
    from public.purchase_request_lines l join public.bom_materials m on m.id = l.material_id
    where l.request_id = p_request and l.po_line_id is null group by 1 order by 1
  loop
    select coalesce(lead_time_days, 14) into v_lead from public.suppliers where id = g.supplier_id;
    insert into public.purchase_orders (id, supplier_id, status, request_id, notes, created_by)
    values (gen_random_uuid(), g.supplier_id, 'draft', p_request, 'Issu de la demande ' || r.code, auth.uid()) returning id into v_po;
    for ln in
      select l.*, m.supplier_id as m_supplier from public.purchase_request_lines l join public.bom_materials m on m.id = l.material_id
      where l.request_id = p_request and l.po_line_id is null and coalesce(l.supplier_id, m.supplier_id) = g.supplier_id order by l.created_at, l.id
    loop
      select unit_cost into v_price from public.bom_material_prices where material_id = ln.material_id;
      v_exp := coalesce(ln.needed_date, r.needed_date, current_date + v_lead);
      v_pol := gen_random_uuid();
      insert into public.purchase_order_lines (id, po_id, material_id, qty_ordered, unit_price, expected_date, note, request_line_id)
      values (v_pol, v_po, ln.material_id, ln.qty, coalesce(v_price, 0), v_exp, ln.note, ln.id);
      update public.purchase_request_lines set po_line_id = v_pol where id = ln.id;
    end loop;
    update public.purchase_orders set expected_date = (select max(expected_date) from public.purchase_order_lines where po_id = v_po) where id = v_po;
    v_ids := v_ids || to_jsonb(v_po);
    perform private.write_audit(r.company_id, 'purchase.po_create', 'purchase', v_po::text, (select po_no from public.purchase_orders where id = v_po), null, null,
      jsonb_build_object('request', r.code, 'supplier', (select name from public.suppliers where id = g.supplier_id)), 'rpc');
  end loop;
  update public.purchase_requests set status = 'ordered' where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_convert', 'purchase', r.id::text, r.code, null, null, jsonb_build_object('orders', jsonb_array_length(v_ids)), 'rpc');
  return v_ids;
end $$;

-- Suggestions MRP acceptées → demande d'achat (brouillon, source « mrp »)
create function public.purchase_request_from_mrp(p_run uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_run public.mrp_runs%rowtype; v_n int;
begin
  perform private.require_perm('mrp.read');
  if not (private.has_perm('purchases.request') or private.has_perm('purchases.write')) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select * into v_run from public.mrp_runs where id = p_run and company_id = v_co;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.mrp_run_suggestions where run_id = p_run and status = 'accepted' and request_id is null) then raise exception 'PURCHASE_NO_SUGGESTION' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_requests (id, company_id, source, mrp_run_id, reason, needed_date)
  values (v_id, v_co, 'mrp', p_run, 'Suggestions acceptées de la simulation ' || v_run.code,
          (select min(need_date) from public.mrp_run_suggestions where run_id = p_run and status = 'accepted' and request_id is null));
  insert into public.purchase_request_lines (company_id, request_id, material_id, qty, supplier_id, needed_date, note)
  select v_co, v_id, s.material_id, sum(s.qty), s.supplier_id, min(s.need_date), 'MRP ' || v_run.code
  from public.mrp_run_suggestions s where s.run_id = p_run and s.status = 'accepted' and s.request_id is null group by s.material_id, s.supplier_id;
  get diagnostics v_n = row_count;
  update public.mrp_run_suggestions set request_id = v_id where run_id = p_run and status = 'accepted' and request_id is null;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'purchase.request_create', 'purchase', v_id::text, (select code from public.purchase_requests where id = v_id), null,
    jsonb_build_object('source', 'mrp'), jsonb_build_object('run', v_run.code, 'lines', v_n), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 8. Fonctions : commandes fournisseur, réception, retour
-- ---------------------------------------------------------------------
create function public.purchase_order_send(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v_lead int; v_exp date;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_order_lines where po_id = p_po) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform private.supplier_assert_open(o.supplier_id);
  select coalesce(lead_time_days, 14) into v_lead from public.suppliers where id = o.supplier_id;
  v_exp := coalesce(o.expected_date, (select max(expected_date) from public.purchase_order_lines where po_id = p_po), current_date + v_lead);
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set status = 'sent', sent_at = now(), sent_by = auth.uid(), order_date = current_date, expected_date = v_exp where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_send', 'purchase', o.id::text, o.po_no, null, null, jsonb_build_object('total', o.total_amount), 'rpc');
end $$;

create function public.purchase_order_cancel(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('draft', 'sent') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_receipts where po_id = p_po) then raise exception 'PURCHASE_HAS_RECEIPTS' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_request_lines set po_line_id = null where po_line_id in (select id from public.purchase_order_lines where po_id = p_po);
  update public.purchase_requests set status = 'approved' where id = o.request_id and status = 'ordered';
  update public.purchase_orders set status = 'cancelled' where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_cancel', 'purchase', o.id::text, o.po_no, jsonb_build_object('status', o.status), null, '{}'::jsonb, 'rpc');
end $$;

-- Recalcule le statut d'une commande d'après les quantités nettes reçues (reçu − retourné)
create function private.purchase_refresh_status(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_all boolean; v_any boolean; v_status text; v_prev text := coalesce(current_setting('purchases.rpc', true), 'off');
begin
  select bool_and(qty_received - qty_returned >= qty_ordered), bool_or(qty_received - qty_returned > 0) into v_all, v_any from public.purchase_order_lines where po_id = p_po;
  v_status := case when v_all then 'received' when v_any then 'partial' else 'sent' end;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set status = v_status, received_date = case when v_status = 'received' then coalesce(received_date, current_date) else null end where id = p_po;
  perform set_config('purchases.rpc', v_prev, true);
end $$;
revoke execute on function private.purchase_refresh_status(uuid) from public, anon, authenticated;

-- Réception : p_lines = [{ "line_id": uuid, "qty": n, "location_id": uuid? }]. Chaque ligne crée un lot FIFO au prix de la commande.
create function public.purchase_receive(p_po uuid, p_warehouse uuid, p_location uuid, p_lines jsonb, p_delivery_note text default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  o public.purchase_orders%rowtype; v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text; j jsonb; pl public.purchase_order_lines%rowtype;
  v_qty numeric; v_loc uuid; v_mov uuid; v_n int := 0; v_ref text;
begin
  perform private.require_perm('purchases.receive');
  select * into o from public.purchase_orders where id = p_po and company_id = v_co for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('sent', 'partial') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  v_code := 'REC-' || lpad(private.next_seq(v_co, 'purchase_receipt')::text, 4, '0');
  v_ref := left(v_code || coalesce(' / BL ' || nullif(btrim(coalesce(p_delivery_note, '')), ''), ''), 120);
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_receipts (id, company_id, code, po_id, supplier_id, warehouse_id, delivery_note, notes, received_by)
  values (v_id, v_co, v_code, p_po, o.supplier_id, p_warehouse, nullif(btrim(coalesce(p_delivery_note, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid());
  perform set_config('stock.trusted_cost', 'on', true);
  for j in select * from jsonb_array_elements(p_lines) loop
    v_qty := nullif(j ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select * into pl from public.purchase_order_lines where id = (j ->> 'line_id')::uuid and po_id = p_po for update;
    if not found then raise exception 'PURCHASE_BAD_LINE' using errcode = '22023'; end if;
    if v_qty > pl.qty_ordered - (pl.qty_received - pl.qty_returned) then raise exception 'PURCHASE_OVER_RECEIPT' using errcode = '22023', detail = (select code from public.bom_materials where id = pl.material_id); end if;
    v_loc := coalesce(nullif(j ->> 'location_id', '')::uuid, p_location);
    if v_loc is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
    v_mov := private.stock_apply('in', 'in', pl.material_id, v_qty, p_warehouse, v_loc, null, v_ref, 'Réception ' || o.po_no, pl.unit_price, null, null);
    insert into public.purchase_receipt_lines (company_id, receipt_id, po_line_id, material_id, location_id, qty, unit_price, movement_id)
    values (v_co, v_id, pl.id, pl.material_id, v_loc, v_qty, pl.unit_price, v_mov);
    update public.purchase_order_lines set qty_received = qty_received + v_qty where id = pl.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('stock.trusted_cost', 'off', true);
  if v_n = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform private.purchase_refresh_status(p_po);
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'purchase.receive', 'purchase', v_id::text, v_code, null, null,
    jsonb_build_object('po', o.po_no, 'lines', v_n, 'delivery_note', p_delivery_note), 'rpc');
  return v_id;
end $$;

-- Retour fournisseur : p_lines = [{ "receipt_line_id": uuid, "qty": n }] ; sortie de stock (FIFO sur l'emplacement de réception)
create function public.purchase_return(p_receipt uuid, p_lines jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  rc public.purchase_receipts%rowtype; v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text; j jsonb;
  rl public.purchase_receipt_lines%rowtype; v_qty numeric; v_mov uuid; v_n int := 0; v_po public.purchase_orders%rowtype;
begin
  perform private.require_perm('purchases.receive');
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PURCHASE_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into rc from public.purchase_receipts where id = p_receipt and company_id = v_co;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_po from public.purchase_orders where id = rc.po_id for update;
  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  v_code := 'RET-' || lpad(private.next_seq(v_co, 'purchase_return')::text, 4, '0');
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_returns (id, company_id, code, receipt_id, po_id, supplier_id, warehouse_id, reason, returned_by)
  values (v_id, v_co, v_code, p_receipt, rc.po_id, rc.supplier_id, rc.warehouse_id, btrim(p_reason), auth.uid());
  for j in select * from jsonb_array_elements(p_lines) loop
    v_qty := nullif(j ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select * into rl from public.purchase_receipt_lines where id = (j ->> 'receipt_line_id')::uuid and receipt_id = p_receipt for update;
    if not found then raise exception 'PURCHASE_BAD_LINE' using errcode = '22023'; end if;
    if v_qty > rl.qty - rl.qty_returned then raise exception 'PURCHASE_OVER_RETURN' using errcode = '22023'; end if;
    v_mov := private.stock_apply('out', 'out', rl.material_id, v_qty, rc.warehouse_id, rl.location_id, null, v_code, 'Retour fournisseur : ' || left(btrim(p_reason), 200), null, null, null);
    insert into public.purchase_return_lines (company_id, return_id, receipt_line_id, material_id, qty, unit_price, movement_id) values (v_co, v_id, rl.id, rl.material_id, v_qty, rl.unit_price, v_mov);
    update public.purchase_receipt_lines set qty_returned = qty_returned + v_qty where id = rl.id;
    update public.purchase_order_lines set qty_returned = qty_returned + v_qty where id = rl.po_line_id;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  if v_po.status in ('partial', 'received') then perform private.purchase_refresh_status(rc.po_id); end if;      -- un retour rouvre le besoin
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'purchase.return', 'purchase', v_id::text, v_code, null, null, jsonb_build_object('receipt', rc.code, 'po', v_po.po_no, 'reason', btrim(p_reason), 'lines', v_n), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 9. Statistiques d'achat
-- ---------------------------------------------------------------------
create function public.purchase_stats(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_from date := coalesce(p_from, current_date - 365); v_to date := coalesce(p_to, current_date); v_res jsonb;
begin
  perform private.require_perm('purchases.read');
  with po as (
    select * from public.purchase_orders where company_id = v_co and status in ('sent', 'partial', 'received') and order_date between v_from and v_to
  ), rcv as (
    select rl.qty * rl.unit_price as amount, coalesce(rl.qty_returned, 0) * rl.unit_price as returned
    from public.purchase_receipt_lines rl join public.purchase_receipts r on r.id = rl.receipt_id
    where r.company_id = v_co and r.received_at::date between v_from and v_to
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'orders', (select count(*) from po),
    'amount', (select coalesce(sum(total_amount), 0) from po),
    'avg_order', (select coalesce(round(avg(total_amount), 2), 0) from po),
    'open_count', (select count(*) from po where status in ('sent', 'partial')),
    'open_amount', (select coalesce(sum(total_amount), 0) from po where status in ('sent', 'partial')),
    'late_open', (select count(*) from po where status in ('sent', 'partial') and expected_date is not null and expected_date < current_date),
    'received_count', (select count(*) from po where status = 'received'),
    'on_time_rate', (select case when count(*) filter (where status = 'received' and expected_date is not null) = 0 then null
        else round(100.0 * count(*) filter (where status = 'received' and expected_date is not null and received_date <= expected_date) / count(*) filter (where status = 'received' and expected_date is not null), 1) end from po),
    'avg_delay_days', (select round(avg(received_date - expected_date) filter (where status = 'received' and expected_date is not null and received_date is not null), 1) from po),
    'avg_lead_days', (select round(avg(received_date - order_date) filter (where status = 'received' and received_date is not null), 1) from po),
    'received_amount', (select coalesce(sum(amount), 0) from rcv),
    'returned_amount', (select coalesce(sum(returned), 0) from rcv),
    'return_rate', (select case when coalesce(sum(amount), 0) = 0 then null else round(100.0 * sum(returned) / sum(amount), 1) end from rcv),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'amount', coalesce(x.amount, 0), 'count', coalesce(x.n, 0)) order by m.month)
      from (select to_char(date_trunc('month', v_to) - (g || ' month')::interval, 'YYYY-MM') as month from generate_series(0, 11) g) m
      left join (select to_char(date_trunc('month', order_date), 'YYYY-MM') as month, sum(total_amount) as amount, count(*) as n from public.purchase_orders
                 where company_id = v_co and status in ('sent', 'partial', 'received') group by 1) x on x.month = m.month), '[]'::jsonb),
    'by_supplier', coalesce((
      select jsonb_agg(t order by (t ->> 'amount')::numeric desc) from (
        select jsonb_build_object('supplier_id', s.id, 'name', s.name, 'orders', count(*), 'amount', sum(po.total_amount),
          'on_time_rate', case when count(*) filter (where po.status = 'received' and po.expected_date is not null) = 0 then null
             else round(100.0 * count(*) filter (where po.status = 'received' and po.expected_date is not null and po.received_date <= po.expected_date) / count(*) filter (where po.status = 'received' and po.expected_date is not null), 1) end,
          'avg_lead_days', round(avg(po.received_date - po.order_date) filter (where po.status = 'received' and po.received_date is not null), 1)) as t
        from po join public.suppliers s on s.id = po.supplier_id group by s.id, s.name order by sum(po.total_amount) desc limit 10) q), '[]'::jsonb),
    'top_materials', coalesce((
      select jsonb_agg(t) from (
        select jsonb_build_object('material_id', m.id, 'code', m.code, 'name', m.name, 'unit', m.unit, 'qty', sum(l.qty_ordered), 'amount', sum(l.qty_ordered * l.unit_price)) as t
        from public.purchase_order_lines l join po on po.id = l.po_id join public.bom_materials m on m.id = l.material_id
        group by m.id, m.code, m.name, m.unit order by sum(l.qty_ordered * l.unit_price) desc limit 10) q), '[]'::jsonb),
    'requests', jsonb_build_object(
      'draft', (select count(*) from public.purchase_requests where company_id = v_co and status = 'draft'),
      'submitted', (select count(*) from public.purchase_requests where company_id = v_co and status = 'submitted'),
      'approved', (select count(*) from public.purchase_requests where company_id = v_co and status = 'approved'),
      'rejected', (select count(*) from public.purchase_requests where company_id = v_co and status = 'rejected' and created_at::date between v_from and v_to),
      'ordered', (select count(*) from public.purchase_requests where company_id = v_co and status = 'ordered' and created_at::date between v_from and v_to),
      'avg_approval_hours', (select round((avg(extract(epoch from decided_at - submitted_at)) / 3600)::numeric, 1) from public.purchase_requests
                              where company_id = v_co and decided_at is not null and submitted_at is not null and created_at::date between v_from and v_to))
  ) into v_res;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 10. Historique, RLS, privilèges
-- ---------------------------------------------------------------------
create policy audit_logs_select_purchase on public.audit_logs for select to authenticated
  using (entity_type = 'purchase' and company_id = private.current_company() and private.has_perm('purchases.read'));

alter table public.purchase_requests enable row level security;
alter table public.purchase_request_lines enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_lines enable row level security;
alter table public.purchase_returns enable row level security;
alter table public.purchase_return_lines enable row level security;

revoke all on public.purchase_requests, public.purchase_request_lines, public.purchase_order_lines, public.purchase_receipts, public.purchase_receipt_lines,
              public.purchase_returns, public.purchase_return_lines from anon, authenticated;
grant all on public.purchase_requests, public.purchase_request_lines, public.purchase_order_lines, public.purchase_receipts, public.purchase_receipt_lines,
             public.purchase_returns, public.purchase_return_lines to service_role;
grant select on public.purchase_requests, public.purchase_request_lines, public.purchase_order_lines, public.purchase_receipts, public.purchase_receipt_lines,
                public.purchase_returns, public.purchase_return_lines to authenticated;

-- commandes : plus d'écriture directe du statut, des montants ni des dates (fonctions uniquement)
revoke insert, update on public.purchase_orders from authenticated;
grant insert (supplier_id, expected_date, currency, notes) on public.purchase_orders to authenticated;
grant update (expected_date, notes) on public.purchase_orders to authenticated;

grant insert (needed_date, reason) on public.purchase_requests to authenticated;
grant update (needed_date, reason) on public.purchase_requests to authenticated;
grant insert (request_id, material_id, qty, supplier_id, needed_date, note) on public.purchase_request_lines to authenticated;
grant update (qty, supplier_id, needed_date, note) on public.purchase_request_lines to authenticated;
grant delete on public.purchase_request_lines to authenticated;
grant insert (po_id, material_id, qty_ordered, unit_price, expected_date, note) on public.purchase_order_lines to authenticated;
grant update (qty_ordered, unit_price, expected_date, note) on public.purchase_order_lines to authenticated;
grant delete on public.purchase_order_lines to authenticated;

create policy purchase_requests_select on public.purchase_requests for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('purchases.read') or (private.has_perm('purchases.request') and requested_by = auth.uid())));
create policy purchase_requests_insert on public.purchase_requests for insert to authenticated
  with check (company_id = private.current_company() and (private.has_perm('purchases.request') or private.has_perm('purchases.write')));
create policy purchase_requests_update on public.purchase_requests for update to authenticated
  using (company_id = private.current_company() and private.can_edit_request(requested_by)) with check (company_id = private.current_company() and private.can_edit_request(requested_by));

create policy purchase_request_lines_select on public.purchase_request_lines for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id));
create policy purchase_request_lines_insert on public.purchase_request_lines for insert to authenticated
  with check (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id and private.can_edit_request(r.requested_by)));
create policy purchase_request_lines_update on public.purchase_request_lines for update to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id and private.can_edit_request(r.requested_by)))
  with check (company_id = private.current_company());
create policy purchase_request_lines_delete on public.purchase_request_lines for delete to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id and private.can_edit_request(r.requested_by)));

do $$
declare t text;
begin
  foreach t in array array['purchase_order_lines', 'purchase_receipts', 'purchase_receipt_lines', 'purchase_returns', 'purchase_return_lines'] loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'))$f$, t || '_select', t);
  end loop;
end $$;
create policy purchase_order_lines_insert on public.purchase_order_lines for insert to authenticated with check (company_id = private.current_company() and private.has_perm('purchases.write'));
create policy purchase_order_lines_update on public.purchase_order_lines for update to authenticated using (company_id = private.current_company() and private.has_perm('purchases.write')) with check (company_id = private.current_company() and private.has_perm('purchases.write'));
create policy purchase_order_lines_delete on public.purchase_order_lines for delete to authenticated using (company_id = private.current_company() and private.has_perm('purchases.write'));

do $$
declare f text;
begin
  foreach f in array array['purchase_request_submit(uuid)', 'purchase_request_decide(uuid,boolean,text)', 'purchase_request_cancel(uuid)', 'purchase_request_to_orders(uuid)',
      'purchase_request_from_mrp(uuid)', 'purchase_order_send(uuid)', 'purchase_order_cancel(uuid)', 'purchase_receive(uuid,uuid,uuid,jsonb,text,text)',
      'purchase_return(uuid,jsonb,text)', 'purchase_stats(date,date)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ===== 0012_commercial.sql =====
-- =====================================================================
-- 0012_commercial — Module Commercial
--  Prospects (pipeline, conversion en client), devis, commandes client (extension du socle 0010), factures,
--  avoirs, encaissements, tableau de bord commercial.
--  Workflow : Prospect → Devis → (acceptation) → Commande → Facture (→ Avoir).
--  Numérotation légale sans trou : une facture ou un avoir ne reçoit son numéro qu'à l'émission (dans la même transaction).
--  Les clients restent gérés par le module Clients (0004) ; la conversion d'un prospect crée la fiche client.
--  Permissions nouvelles : prospects.read / prospects.write / quotes.read / quotes.write.
--  Réutilisées : clients.*, orders.read|write|confirm, invoices.read|write (factures, avoirs), payments.read|write (encaissements).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('prospects.read',  'clients', 'Voir les prospects',  'Prospects, pipeline commercial'),
  ('prospects.write', 'clients', 'Gérer les prospects', 'Créer, qualifier, faire avancer et convertir les prospects'),
  ('quotes.read',     'orders',  'Voir les devis',      null),
  ('quotes.write',    'orders',  'Gérer les devis',     'Créer, envoyer, enregistrer la réponse du client, transformer en commande')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('prospects.read', 'prospects.write', 'quotes.read', 'quotes.write'))
  or (r.code = 'commercial' and p.code in ('prospects.read', 'prospects.write', 'quotes.read', 'quotes.write'))
  or (r.code = 'direction'  and p.code in ('prospects.read', 'quotes.read'))
  or (r.code = 'finance'    and p.code = 'quotes.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Prospects
-- ---------------------------------------------------------------------
create table public.prospects (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  code                text not null,                                          -- PRO-0001
  company_name        text not null check (length(btrim(company_name)) between 2 and 120),
  contact_name        text check (contact_name is null or length(contact_name) <= 120),
  email               text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone               text check (phone is null or length(phone) <= 40),
  country             char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  city                text check (city is null or length(city) <= 80),
  source              text not null default 'other' check (source in ('website','trade_show','referral','cold_call','social','other')),
  stage               text not null default 'new' check (stage in ('new','contacted','qualified','proposal','negotiation','won','lost')),
  est_value           numeric(15,2) not null default 0 check (est_value >= 0),
  expected_close      date,
  owner_id            uuid references public.profiles(id) on delete set null,
  next_action         text check (next_action is null or length(next_action) <= 200),
  next_action_date    date,
  notes               text check (notes is null or length(notes) <= 2000),
  lost_reason         text check (lost_reason is null or length(lost_reason) <= 300),
  converted_client_id uuid references public.clients(id) on delete set null,
  stage_changed_at    timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  unique (company_id, code)
);
create index prospects_idx on public.prospects (company_id, stage);

create table public.prospect_activities (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  prospect_id uuid not null references public.prospects(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('call','email','meeting','note')),
  summary     text not null check (length(btrim(summary)) between 2 and 500),
  happened_at timestamptz not null default now(),
  created_by  uuid
);
create index prospect_activities_idx on public.prospect_activities (prospect_id, happened_at desc);

-- ---------------------------------------------------------------------
-- 3. Devis
-- ---------------------------------------------------------------------
create table public.quotes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text not null,                                               -- DEV-2026-0001
  client_id      uuid references public.clients(id),
  prospect_id    uuid references public.prospects(id),
  status         text not null default 'draft' check (status in ('draft','sent','accepted','rejected','converted','cancelled')),
  quote_date     date not null default current_date,
  valid_until    date not null default (current_date + 30),
  currency       char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  tax_rate       numeric(5,2) not null default 19 check (tax_rate between 0 and 100),
  payment_terms  text check (payment_terms is null or length(payment_terms) <= 120),
  lead_days      int not null default 30 check (lead_days between 0 and 365),   -- délai de livraison annoncé
  notes          text check (notes is null or length(notes) <= 2000),
  subtotal       numeric(15,2) not null default 0,
  tax_amount     numeric(15,2) not null default 0,
  total          numeric(15,2) not null default 0,
  order_id       uuid,
  sent_at        timestamptz,
  decided_at     timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) <= 300),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  unique (company_id, code),
  constraint quotes_one_party check ((client_id is not null) <> (prospect_id is not null))
);
create index quotes_idx on public.quotes (company_id, status, quote_date desc);

create table public.quote_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  pos          int not null default 0,
  article_id   uuid references public.articles(id),
  description  text not null check (length(btrim(description)) between 1 and 300),
  qty          numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  unit_price   numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  created_at   timestamptz not null default now()
);
create index quote_lines_idx on public.quote_lines (quote_id, pos);

-- ---------------------------------------------------------------------
-- 4. Commandes client : extension du socle (0010) — prix, totaux, lien avec le devis, avancement de facturation
-- ---------------------------------------------------------------------
alter table public.sales_orders
  add column quote_id       uuid references public.quotes(id) on delete set null,
  add column currency       char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  add column tax_rate       numeric(5,2) check (tax_rate is null or tax_rate between 0 and 100),
  add column payment_terms  text check (payment_terms is null or length(payment_terms) <= 120),
  add column subtotal       numeric(15,2) not null default 0,
  add column tax_amount     numeric(15,2) not null default 0,
  add column total          numeric(15,2) not null default 0,
  add column invoice_status text not null default 'none' check (invoice_status in ('none','partial','full'));
alter table public.quotes add constraint quotes_order_fk foreign key (order_id) references public.sales_orders(id) on delete set null;

alter table public.sales_order_lines
  alter column article_id drop not null,
  add column description  text check (description is null or length(description) <= 300),
  add column unit_price   numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  add column discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  add column qty_invoiced numeric(12,2) not null default 0 check (qty_invoiced >= 0);
alter table public.sales_order_lines add constraint sales_order_lines_invoiced_ck check (qty_invoiced <= qty);

-- ---------------------------------------------------------------------
-- 5. Factures, encaissements, avoirs
-- ---------------------------------------------------------------------
create table public.invoices (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text,                                                        -- FAC-2026-0001 : attribué à l'émission
  client_id      uuid not null references public.clients(id),
  order_id       uuid references public.sales_orders(id),
  status         text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','credited','cancelled')),
  issue_date     date,
  due_date       date,
  currency       char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  tax_rate       numeric(5,2) not null default 19 check (tax_rate between 0 and 100),
  payment_terms  text check (payment_terms is null or length(payment_terms) <= 120),
  notes          text check (notes is null or length(notes) <= 2000),
  subtotal       numeric(15,2) not null default 0,
  tax_amount     numeric(15,2) not null default 0,
  total          numeric(15,2) not null default 0,
  paid_amount    numeric(15,2) not null default 0 check (paid_amount >= 0),
  credited_amount numeric(15,2) not null default 0 check (credited_amount >= 0),
  created_at     timestamptz not null default now(),
  created_by     uuid,
  issued_at      timestamptz,
  issued_by      uuid,
  updated_at     timestamptz not null default now(),
  constraint invoices_code_ck check ((status in ('draft', 'cancelled')) or code is not null)
);
create unique index invoices_code_uq on public.invoices (company_id, code) where code is not null;
create index invoices_idx on public.invoices (company_id, status, issue_date desc);
create index invoices_order_idx on public.invoices (order_id);

create table public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  order_line_id uuid references public.sales_order_lines(id),
  pos           int not null default 0,
  description   text not null check (length(btrim(description)) between 1 and 300),
  qty           numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  unit_price    numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  discount_pct  numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  qty_credited  numeric(12,2) not null default 0 check (qty_credited >= 0),
  created_at    timestamptz not null default now(),
  constraint invoice_lines_credited_ck check (qty_credited <= qty)
);
create index invoice_lines_idx on public.invoice_lines (invoice_id, pos);

create table public.invoice_payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  invoice_id  uuid not null references public.invoices(id),
  amount      numeric(15,2) not null check (amount > 0),
  paid_on     date not null default current_date,
  method      text not null default 'transfer' check (method in ('transfer','cheque','lc','cash','card','other')),
  reference   text check (reference is null or length(reference) <= 120),
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index invoice_payments_idx on public.invoice_payments (invoice_id, paid_on);

create table public.credit_notes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text,                                                        -- AV-2026-0001 : attribué à l'émission
  invoice_id     uuid not null references public.invoices(id),
  client_id      uuid not null references public.clients(id),
  status         text not null default 'draft' check (status in ('draft','issued','cancelled')),
  reason         text not null check (length(btrim(reason)) between 3 and 300),
  issue_date     date,
  currency       char(3) not null default 'EUR',
  tax_rate       numeric(5,2) not null default 19,
  reopen_order   boolean not null default false,
  subtotal       numeric(15,2) not null default 0,
  tax_amount     numeric(15,2) not null default 0,
  total          numeric(15,2) not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  issued_at      timestamptz,
  issued_by      uuid,
  constraint credit_notes_code_ck check (status <> 'issued' or code is not null)
);
create unique index credit_notes_code_uq on public.credit_notes (company_id, code) where code is not null;
create index credit_notes_idx on public.credit_notes (company_id, status, issue_date desc);

create table public.credit_note_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  credit_note_id  uuid not null references public.credit_notes(id) on delete cascade,
  invoice_line_id uuid not null references public.invoice_lines(id),
  pos             int not null default 0,
  description     text not null,
  qty             numeric(12,2) not null check (qty > 0),
  unit_price      numeric(14,4) not null,
  discount_pct    numeric(5,2) not null default 0
);
create index credit_note_lines_idx on public.credit_note_lines (credit_note_id, pos);

-- ---------------------------------------------------------------------
-- 6. Totaux (HT, TVA, TTC) recalculés par trigger pour les quatre types de documents
-- ---------------------------------------------------------------------
create function private.doc_recalc() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  v_id := case when tg_op = 'DELETE' then (to_jsonb(old) ->> tg_argv[2])::uuid else (to_jsonb(new) ->> tg_argv[2])::uuid end;
  perform set_config('commercial.rpc', 'on', true);
  execute format($f$update public.%I h set subtotal = s.sub, tax_amount = round(s.sub * h.tax_rate / 100, 2), total = s.sub + round(s.sub * h.tax_rate / 100, 2)
                    from (select coalesce(sum(round(qty * unit_price * (1 - discount_pct / 100), 2)), 0) as sub from public.%I where %I = $1) s where h.id = $1$f$,
                 tg_argv[0], tg_argv[1], tg_argv[3]) using v_id;
  perform set_config('commercial.rpc', v_prev, true);
  return null;
end $$;
revoke execute on function private.doc_recalc() from public, anon, authenticated;

create trigger quote_lines_recalc after insert or update or delete on public.quote_lines for each row execute function private.doc_recalc('quotes', 'quote_lines', 'quote_id', 'quote_id');
create trigger sales_order_lines_recalc after insert or update of qty, unit_price, discount_pct or delete on public.sales_order_lines for each row execute function private.doc_recalc('sales_orders', 'sales_order_lines', 'order_id', 'order_id');
create trigger invoice_lines_recalc after insert or update or delete on public.invoice_lines for each row execute function private.doc_recalc('invoices', 'invoice_lines', 'invoice_id', 'invoice_id');
create trigger credit_note_lines_recalc after insert or update or delete on public.credit_note_lines for each row execute function private.doc_recalc('credit_notes', 'credit_note_lines', 'credit_note_id', 'credit_note_id');
-- (4e argument = colonne de la table de lignes ; 3e = colonne portée par la ligne pour retrouver l'en-tête)
create trigger quotes_recalc_rate after update of tax_rate on public.quotes for each row execute function private.doc_recalc('quotes', 'quote_lines', 'id', 'quote_id');
create trigger sales_orders_recalc_rate after update of tax_rate on public.sales_orders for each row execute function private.doc_recalc('sales_orders', 'sales_order_lines', 'id', 'order_id');
create trigger invoices_recalc_rate after update of tax_rate on public.invoices for each row execute function private.doc_recalc('invoices', 'invoice_lines', 'id', 'invoice_id');

-- ---------------------------------------------------------------------
-- 7. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.commercial_rpc() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('commercial.rpc', true), 'off') = 'on' $$;

-- TVA par défaut d'un client : 0 si exonéré, 19 sinon
create function private.client_tax_rate(p_client uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when vat_exempt then 0 else 19 end from public.clients where id = p_client $$;
revoke execute on function private.client_tax_rate(uuid) from public, anon, authenticated;

create function private.prospects_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'PRO-' || lpad(private.next_seq(new.company_id, 'prospect')::text, 4, '0');
    new.created_by := auth.uid(); new.stage := 'new'; new.converted_client_id := null; new.lost_reason := null; new.stage_changed_at := now();
  elsif not private.commercial_rpc() then
    new.stage := old.stage; new.converted_client_id := old.converted_client_id; new.lost_reason := old.lost_reason; new.stage_changed_at := old.stage_changed_at;
    if old.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
    new.updated_at := now();
  end if;
  new.company_name := btrim(new.company_name);
  new.country := upper(new.country);
  new.email := nullif(btrim(coalesce(new.email, '')), '');
  if new.owner_id is not null and not exists (select 1 from public.profiles where id = new.owner_id and company_id = new.company_id and is_active) then raise exception 'PROSPECT_BAD_OWNER' using errcode = '22023'; end if;
  return new;
end $$;
create trigger prospects_before_iu before insert or update on public.prospects for each row execute function private.prospects_before();

create function private.prospect_activities_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  select * into p from public.prospects where id = new.prospect_id;
  if not found then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := p.company_id; new.created_by := auth.uid(); new.happened_at := coalesce(new.happened_at, now());
  new.summary := btrim(new.summary);
  return new;
end $$;
create trigger prospect_activities_before_i before insert on public.prospect_activities for each row execute function private.prospect_activities_before();

create function private.quotes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.clients%rowtype;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'DEV-' || extract(year from current_date)::text || '-' || lpad(private.next_seq(new.company_id, 'quote-' || extract(year from current_date)::text)::text, 4, '0');
    new.created_by := auth.uid(); new.status := 'draft'; new.order_id := null; new.sent_at := null; new.decided_at := null; new.decision_reason := null;
    new.subtotal := 0; new.tax_amount := 0; new.total := 0;
    if new.client_id is not null then
      select * into c from public.clients where id = new.client_id and company_id = new.company_id;
      if not found then raise exception 'COMMERCIAL_BAD_CLIENT' using errcode = '22023'; end if;
      perform private.ged_assert_client_open(new.client_id);
      new.currency := coalesce(nullif(c.currency, ''), new.currency);
    elsif not exists (select 1 from public.prospects where id = new.prospect_id and company_id = new.company_id and stage not in ('won', 'lost')) then
      raise exception 'COMMERCIAL_BAD_PROSPECT' using errcode = '22023';
    end if;
  elsif not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id or new.prospect_id is distinct from old.prospect_id then raise exception 'COMMERCIAL_LOCKED' using errcode = '42501'; end if;
    new.updated_at := now();
  end if;
  if new.valid_until < new.quote_date and not private.commercial_rpc() then raise exception 'QUOTE_BAD_VALIDITY' using errcode = '22023'; end if;
  new.payment_terms := nullif(btrim(coalesce(new.payment_terms, '')), '');
  return new;
end $$;
create trigger quotes_before_iu before insert or update on public.quotes for each row execute function private.quotes_before();

create function private.quote_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; a public.articles%rowtype; v_q uuid := coalesce(new.quote_id, old.quote_id);
begin
  select * into q from public.quotes where id = v_q;
  if not private.commercial_rpc() and found and q.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := q.company_id;
    new.pos := coalesce(nullif(new.pos, 0), (select coalesce(max(pos), 0) + 1 from public.quote_lines where quote_id = new.quote_id));
    if new.article_id is not null then
      select * into a from public.articles where id = new.article_id and company_id = q.company_id;
      if not found or q.client_id is null or a.client_id <> q.client_id or a.status = 'discontinued' then raise exception 'COMMERCIAL_BAD_ARTICLE' using errcode = '22023'; end if;
      if nullif(btrim(coalesce(new.description, '')), '') is null then new.description := a.name; end if;
    end if;
  end if;
  new.description := btrim(coalesce(new.description, ''));
  return new;
end $$;
create trigger quote_lines_before_iud before insert or update or delete on public.quote_lines for each row execute function private.quote_lines_before();

-- Commandes : même logique qu'en 0010, étendue (prix, article facultatif, TVA par défaut, verrous de facturation)
create or replace function private.sales_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'CMD-' || lpad(private.next_seq(new.company_id, 'sales_order')::text, 4, '0');
    perform private.ged_assert_client_open(new.client_id);
    if not exists (select 1 from public.clients where id = new.client_id and company_id = new.company_id) then raise exception 'ORDER_BAD_CLIENT' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.status := 'draft'; new.confirmed_at := null; new.confirmed_by := null;
    if not private.commercial_rpc() then new.quote_id := null; end if;
    new.invoice_status := 'none'; new.subtotal := 0; new.tax_amount := 0; new.total := 0;
    new.tax_rate := coalesce(new.tax_rate, private.client_tax_rate(new.client_id));
  elsif coalesce(current_setting('orders.rpc', true), 'off') <> 'on' and not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'ORDER_LOCKED' using errcode = '42501'; end if;
  end if;
  new.client_ref := nullif(btrim(coalesce(new.client_ref, '')), '');
  new.payment_terms := nullif(btrim(coalesce(new.payment_terms, '')), '');
  return new;
end $$;

create or replace function private.sales_order_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; a public.articles%rowtype; v_order uuid := coalesce(new.order_id, old.order_id);
begin
  select * into o from public.sales_orders where id = v_order;
  if coalesce(current_setting('orders.rpc', true), 'off') <> 'on' and not private.commercial_rpc() and found and o.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := o.company_id;
    if not private.commercial_rpc() then new.qty_invoiced := 0; end if;
    if new.article_id is not null then
      select * into a from public.articles where id = new.article_id;
      if not found or a.client_id <> o.client_id then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;   -- l'article doit appartenir au client de la commande
      if a.status = 'discontinued' then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;
      if nullif(btrim(coalesce(new.description, '')), '') is null then new.description := a.name; end if;
    elsif nullif(btrim(coalesce(new.description, '')), '') is null then
      raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023';                                                           -- ligne libre : description obligatoire
    end if;
  elsif not private.commercial_rpc() then
    new.qty_invoiced := old.qty_invoiced;
  end if;
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;

create function private.invoices_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if not private.commercial_rpc() then
      new.status := 'draft'; new.code := null; new.order_id := null; new.issue_date := null; new.due_date := null; new.paid_amount := 0; new.credited_amount := 0;
      new.issued_at := null; new.issued_by := null;
    end if;
    perform private.ged_assert_client_open(new.client_id);
    if not exists (select 1 from public.clients where id = new.client_id and company_id = new.company_id) then raise exception 'COMMERCIAL_BAD_CLIENT' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.subtotal := 0; new.tax_amount := 0; new.total := 0;
  elsif not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'COMMERCIAL_LOCKED' using errcode = '42501'; end if;
    new.updated_at := now();
  end if;
  new.payment_terms := nullif(btrim(coalesce(new.payment_terms, '')), '');
  return new;
end $$;
create trigger invoices_before_iu before insert or update on public.invoices for each row execute function private.invoices_before();

create function private.invoice_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_inv uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  select * into i from public.invoices where id = v_inv;
  if not private.commercial_rpc() and found and i.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := i.company_id;
    new.pos := coalesce(nullif(new.pos, 0), (select coalesce(max(pos), 0) + 1 from public.invoice_lines where invoice_id = new.invoice_id));
    if not private.commercial_rpc() then new.order_line_id := null; new.qty_credited := 0; end if;     -- les lignes liées à une commande ne viennent que de invoice_from_order
  elsif not private.commercial_rpc() then
    new.qty_credited := old.qty_credited;
  end if;
  new.description := btrim(coalesce(new.description, ''));
  return new;
end $$;
create trigger invoice_lines_before_iud before insert or update or delete on public.invoice_lines for each row execute function private.invoice_lines_before();

create function private.credit_notes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.created_by := auth.uid();
  elsif not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  end if;
  new.reason := btrim(new.reason);
  return new;
end $$;
create trigger credit_notes_before_iu before insert or update on public.credit_notes for each row execute function private.credit_notes_before();

create function private.credit_note_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n public.credit_notes%rowtype; v_cn uuid := coalesce(new.credit_note_id, old.credit_note_id);
begin
  select * into n from public.credit_notes where id = v_cn;
  if not private.commercial_rpc() and found and n.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if not private.commercial_rpc() then
    new.credit_note_id := old.credit_note_id; new.invoice_line_id := old.invoice_line_id; new.description := old.description; new.unit_price := old.unit_price; new.discount_pct := old.discount_pct;
  end if;
  return new;
end $$;
create trigger credit_note_lines_before_ud before update or delete on public.credit_note_lines for each row execute function private.credit_note_lines_before();

-- ---------------------------------------------------------------------
-- 8. Prospects : étape, conversion en client
-- ---------------------------------------------------------------------
create function public.prospect_set_stage(p_prospect uuid, p_stage text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  perform private.require_perm('prospects.write');
  if p_stage not in ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost') then raise exception 'PROSPECT_BAD_STAGE' using errcode = '22023'; end if;
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p_stage = 'won' then raise exception 'PROSPECT_USE_CONVERT' using errcode = '22023'; end if;            -- « gagné » = conversion en client
  if p_stage = 'lost' and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PROSPECT_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_stage = p.stage then return; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.prospects set stage = p_stage, stage_changed_at = now(), lost_reason = case when p_stage = 'lost' then btrim(p_reason) end where id = p_prospect;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.stage', 'prospect', p.id::text, p.code, jsonb_build_object('stage', p.stage), jsonb_build_object('stage', p_stage),
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

-- Conversion : crée la fiche client (module Clients), rattache les devis du prospect, passe le prospect en « gagné »
create function public.prospect_convert(p_prospect uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype; v_client uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('prospects.write');
  perform private.require_perm('clients.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p.country is null then raise exception 'PROSPECT_COUNTRY_REQUIRED' using errcode = '22023'; end if;   -- champ obligatoire de la fiche client
  insert into public.clients (id, company_id, name, email, phone, country, sales_rep_id, notes)
  values (v_client, p.company_id, p.company_name, p.email, p.phone, p.country, p.owner_id, 'Converti depuis le prospect ' || p.code || coalesce(E'\n' || p.notes, ''));
  select code into v_code from public.clients where id = v_client;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set client_id = v_client, prospect_id = null where prospect_id = p_prospect;
  update public.prospects set stage = 'won', stage_changed_at = now(), converted_client_id = v_client where id = p_prospect;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.convert', 'prospect', p.id::text, p.code, null, jsonb_build_object('client_id', v_client),
    jsonb_build_object('client_code', v_code), 'rpc');
  return v_client;
end $$;

-- ---------------------------------------------------------------------
-- 9. Devis : envoi, réponse du client, duplication, transformation en commande
-- ---------------------------------------------------------------------
create function public.quote_send(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.quote_lines where quote_id = p_quote) then raise exception 'COMMERCIAL_EMPTY' using errcode = '55000'; end if;
  if q.valid_until < current_date then raise exception 'QUOTE_EXPIRED' using errcode = '55000'; end if;
  if q.client_id is not null then perform private.ged_assert_client_open(q.client_id); end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = 'sent', sent_at = now() where id = p_quote;
  -- un prospect avec un devis envoyé passe automatiquement à l'étape « proposition »
  if q.prospect_id is not null then
    update public.prospects set stage = 'proposal', stage_changed_at = now() where id = q.prospect_id and stage in ('new', 'contacted', 'qualified');
  end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.send', 'quote', q.id::text, q.code, null, null, jsonb_build_object('total', q.total), 'rpc');
end $$;

create function public.quote_decide(p_quote uuid, p_accept boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'sent' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if p_accept and q.valid_until < current_date then raise exception 'QUOTE_EXPIRED' using errcode = '55000'; end if;
  if not p_accept and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'QUOTE_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = case when p_accept then 'accepted' else 'rejected' end, decided_at = now(), decision_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_quote;
  if p_accept and q.prospect_id is not null then
    update public.prospects set stage = 'negotiation', stage_changed_at = now() where id = q.prospect_id and stage in ('new', 'contacted', 'qualified', 'proposal');
  end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, case when p_accept then 'quote.accept' else 'quote.reject' end, 'quote', q.id::text, q.code, null, null,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

create function public.quote_cancel(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status not in ('draft', 'sent', 'accepted') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = 'cancelled' where id = p_quote;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.cancel', 'quote', q.id::text, q.code, jsonb_build_object('status', q.status), null, '{}'::jsonb, 'rpc');
end $$;

-- Révision / copie : nouveau devis brouillon avec les mêmes lignes
create function public.quote_duplicate(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company();
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.quotes (id, company_id, client_id, prospect_id, currency, tax_rate, payment_terms, lead_days, notes)
  values (v_id, q.company_id, q.client_id, q.prospect_id, q.currency, q.tax_rate, q.payment_terms, q.lead_days, q.notes);
  insert into public.quote_lines (company_id, quote_id, pos, article_id, description, qty, unit_price, discount_pct)
  select company_id, v_id, pos, article_id, description, qty, unit_price, discount_pct from public.quote_lines where quote_id = p_quote order by pos;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.create', 'quote', v_id::text, (select code from public.quotes where id = v_id), null,
    jsonb_build_object('copy_of', q.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Devis accepté → commande (brouillon, à confirmer) ; prix, remises, TVA et délai repris
create function public.quote_to_order(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_order uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('quotes.write');
  perform private.require_perm('orders.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'accepted' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if q.client_id is null then raise exception 'QUOTE_PROSPECT_NOT_CONVERTED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(q.client_id);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.sales_orders (id, company_id, client_id, client_ref, quote_id, currency, tax_rate, payment_terms, notes)
  values (v_order, q.company_id, q.client_id, null, q.id, q.currency, q.tax_rate, q.payment_terms, 'Issue du devis ' || q.code || coalesce(E'\n' || q.notes, ''));
  insert into public.sales_order_lines (company_id, order_id, article_id, description, qty, unit_price, discount_pct, due_date)
  select company_id, v_order, article_id, description, qty, unit_price, discount_pct, current_date + q.lead_days from public.quote_lines where quote_id = p_quote order by pos;
  update public.quotes set status = 'converted', order_id = v_order where id = p_quote;
  perform set_config('commercial.rpc', 'off', true);
  select code into v_code from public.sales_orders where id = v_order;
  perform private.write_audit(q.company_id, 'quote.convert', 'quote', q.id::text, q.code, null, null, jsonb_build_object('order', v_code), 'rpc');
  return v_order;
end $$;

-- ---------------------------------------------------------------------
-- 10. Factures : création depuis une commande, émission (numéro sans trou), encaissements
-- ---------------------------------------------------------------------
-- p_lines (facultatif) : [{ "order_line_id": uuid, "qty": n }] ; sans argument : tout le reste à facturer
create function public.invoice_from_order(p_order uuid, p_lines jsonb default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_id uuid := gen_random_uuid(); l record; v_qty numeric; v_n int := 0; v_req jsonb;
begin
  perform private.require_perm('invoices.write');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('confirmed', 'delivered') then raise exception 'INVOICE_ORDER_NOT_CONFIRMED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(o.client_id);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoices (id, company_id, client_id, order_id, currency, tax_rate, payment_terms)
  values (v_id, o.company_id, o.client_id, p_order, o.currency, coalesce(o.tax_rate, private.client_tax_rate(o.client_id)), o.payment_terms);
  for l in select * from public.sales_order_lines where order_id = p_order and qty - qty_invoiced > 0 order by due_date, created_at, id loop
    v_qty := l.qty - l.qty_invoiced;
    if p_lines is not null then
      select e into v_req from jsonb_array_elements(p_lines) e where (e ->> 'order_line_id')::uuid = l.id limit 1;
      if v_req is null then continue; end if;
      v_qty := (v_req ->> 'qty')::numeric;
      if v_qty is null or v_qty <= 0 then continue; end if;
      if v_qty > l.qty - l.qty_invoiced then raise exception 'INVOICE_OVER_INVOICED' using errcode = '22023'; end if;
    end if;
    insert into public.invoice_lines (company_id, invoice_id, order_line_id, description, qty, unit_price, discount_pct)
    values (o.company_id, v_id, l.id, coalesce(l.description, 'Article'), v_qty, l.unit_price, l.discount_pct);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'INVOICE_NOTHING_TO_INVOICE' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'invoice.create', 'invoice', v_id::text, 'Brouillon', null, jsonb_build_object('order', o.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function private.invoice_recalc_status(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_status text; v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  select * into i from public.invoices where id = p_invoice;
  if i.status in ('draft', 'cancelled') then return; end if;
  v_status := case when i.credited_amount >= i.total then 'credited'
                   when i.total - i.credited_amount - i.paid_amount <= 0 then 'paid'
                   when i.paid_amount > 0 then 'partially_paid' else 'issued' end;
  perform set_config('commercial.rpc', 'on', true);
  update public.invoices set status = v_status, updated_at = now() where id = p_invoice;
  perform set_config('commercial.rpc', v_prev, true);
end $$;
revoke execute on function private.invoice_recalc_status(uuid) from public, anon, authenticated;

create function private.order_refresh_invoice_status(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_all boolean; v_any boolean; v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  select bool_and(qty_invoiced >= qty), bool_or(qty_invoiced > 0) into v_all, v_any from public.sales_order_lines where order_id = p_order;
  perform set_config('commercial.rpc', 'on', true);
  update public.sales_orders set invoice_status = case when v_all then 'full' when v_any then 'partial' else 'none' end where id = p_order;
  perform set_config('commercial.rpc', v_prev, true);
end $$;
revoke execute on function private.order_refresh_invoice_status(uuid) from public, anon, authenticated;

create function public.invoice_issue(p_invoice uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; l record; v_days int; v_code text; v_year text := extract(year from current_date)::text;
begin
  perform private.require_perm('invoices.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.invoice_lines where invoice_id = p_invoice) then raise exception 'COMMERCIAL_EMPTY' using errcode = '55000'; end if;
  if i.total <= 0 then raise exception 'INVOICE_ZERO_TOTAL' using errcode = '55000'; end if;
  for l in select il.*, ol.qty as o_qty, ol.qty_invoiced as o_inv from public.invoice_lines il left join public.sales_order_lines ol on ol.id = il.order_line_id where il.invoice_id = p_invoice for update of il loop
    if l.order_line_id is not null and l.qty > l.o_qty - l.o_inv then raise exception 'INVOICE_OVER_INVOICED' using errcode = '22023'; end if;
  end loop;
  select coalesce(t.days, 30) into v_days from public.clients c left join public.payment_terms t on t.id = c.payment_terms_id where c.id = i.client_id;
  v_code := 'FAC-' || v_year || '-' || lpad(private.next_seq(i.company_id, 'invoice-' || v_year)::text, 4, '0');
  perform set_config('commercial.rpc', 'on', true);
  update public.sales_order_lines ol set qty_invoiced = ol.qty_invoiced + il.qty from public.invoice_lines il where il.invoice_id = p_invoice and il.order_line_id = ol.id;
  update public.invoices set status = 'issued', code = v_code, issue_date = current_date, due_date = current_date + coalesce(v_days, 30), issued_at = now(), issued_by = auth.uid() where id = p_invoice;
  if i.order_id is not null then perform private.order_refresh_invoice_status(i.order_id); end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'invoice.issue', 'invoice', i.id::text, v_code, null, null, jsonb_build_object('total', i.total, 'client_id', i.client_id), 'rpc');
  return v_code;
end $$;

create function public.invoice_cancel(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype;
begin
  perform private.require_perm('invoices.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'INVOICE_CANCEL_ISSUED' using errcode = '55000'; end if;      -- une facture émise se corrige par un avoir
  perform set_config('commercial.rpc', 'on', true);
  update public.invoices set status = 'cancelled' where id = p_invoice;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'invoice.cancel', 'invoice', i.id::text, 'Brouillon', null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.invoice_record_payment(p_invoice uuid, p_amount numeric, p_paid_on date default null, p_method text default 'transfer', p_reference text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_balance numeric;
begin
  perform private.require_perm('payments.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('issued', 'partially_paid') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVOICE_BAD_AMOUNT' using errcode = '22023'; end if;
  v_balance := i.total - i.credited_amount - i.paid_amount;
  if p_amount > v_balance then raise exception 'INVOICE_OVERPAYMENT' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoice_payments (company_id, invoice_id, amount, paid_on, method, reference, created_by)
  values (i.company_id, p_invoice, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'transfer'), nullif(btrim(coalesce(p_reference, '')), ''), auth.uid());
  update public.invoices set paid_amount = paid_amount + p_amount where id = p_invoice;
  perform private.invoice_recalc_status(p_invoice);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'invoice.payment', 'invoice', i.id::text, i.code, null, jsonb_build_object('amount', p_amount), jsonb_build_object('method', p_method, 'reference', p_reference), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 11. Avoirs
-- ---------------------------------------------------------------------
create function public.credit_note_create(p_invoice uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_id uuid := gen_random_uuid(); v_n int;
begin
  perform private.require_perm('invoices.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('issued', 'partially_paid', 'paid') then raise exception 'CREDIT_BAD_INVOICE' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'CREDIT_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.credit_notes (id, company_id, invoice_id, client_id, reason, currency, tax_rate) values (v_id, i.company_id, p_invoice, i.client_id, btrim(p_reason), i.currency, i.tax_rate);
  insert into public.credit_note_lines (company_id, credit_note_id, invoice_line_id, pos, description, qty, unit_price, discount_pct)
  select company_id, v_id, id, pos, description, qty - qty_credited, unit_price, discount_pct from public.invoice_lines where invoice_id = p_invoice and qty - qty_credited > 0 order by pos;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'CREDIT_NOTHING_TO_CREDIT' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'credit_note.create', 'credit_note', v_id::text, 'Brouillon', null, jsonb_build_object('invoice', i.code), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

create function public.credit_note_issue(p_credit_note uuid, p_reopen boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare n public.credit_notes%rowtype; i public.invoices%rowtype; l record; v_code text; v_year text := extract(year from current_date)::text; v_new_credit numeric;
begin
  perform private.require_perm('invoices.write');
  select * into n from public.credit_notes where id = p_credit_note and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  select * into i from public.invoices where id = n.invoice_id for update;
  if not exists (select 1 from public.credit_note_lines where credit_note_id = p_credit_note) then raise exception 'COMMERCIAL_EMPTY' using errcode = 'P0002'; end if;
  if n.total <= 0 then raise exception 'INVOICE_ZERO_TOTAL' using errcode = '55000'; end if;
  for l in select cl.*, il.qty as i_qty, il.qty_credited as i_cred from public.credit_note_lines cl join public.invoice_lines il on il.id = cl.invoice_line_id where cl.credit_note_id = p_credit_note loop
    if l.qty > l.i_qty - l.i_cred then raise exception 'CREDIT_OVER_CREDIT' using errcode = '22023'; end if;
  end loop;
  v_code := 'AV-' || v_year || '-' || lpad(private.next_seq(n.company_id, 'credit-' || v_year)::text, 4, '0');
  perform set_config('commercial.rpc', 'on', true);
  update public.invoice_lines il set qty_credited = il.qty_credited + cl.qty from public.credit_note_lines cl where cl.credit_note_id = p_credit_note and cl.invoice_line_id = il.id;
  if p_reopen then
    update public.sales_order_lines ol set qty_invoiced = greatest(0, ol.qty_invoiced - cl.qty)
    from public.credit_note_lines cl join public.invoice_lines il on il.id = cl.invoice_line_id
    where cl.credit_note_id = p_credit_note and il.order_line_id = ol.id;
    if i.order_id is not null then perform private.order_refresh_invoice_status(i.order_id); end if;
  end if;
  update public.credit_notes set status = 'issued', code = v_code, issue_date = current_date, issued_at = now(), issued_by = auth.uid(), reopen_order = p_reopen where id = p_credit_note;
  v_new_credit := n.total;
  update public.invoices set credited_amount = credited_amount + v_new_credit where id = i.id;
  perform private.invoice_recalc_status(i.id);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(n.company_id, 'credit_note.issue', 'credit_note', n.id::text, v_code, null, null,
    jsonb_build_object('invoice', i.code, 'total', n.total, 'reopen_order', p_reopen), 'rpc');
  return v_code;
end $$;

create function public.credit_note_cancel(p_credit_note uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.credit_notes%rowtype;
begin
  perform private.require_perm('invoices.write');
  select * into n from public.credit_notes where id = p_credit_note and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.credit_notes set status = 'cancelled' where id = p_credit_note;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(n.company_id, 'credit_note.cancel', 'credit_note', n.id::text, 'Brouillon', null, null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 12. Tableau de bord commercial (chaque bloc n'est renvoyé qu'avec le droit de lecture correspondant)
-- ---------------------------------------------------------------------
create function public.commercial_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_res jsonb := '{}'::jsonb; v_any boolean := false;
begin
  if private.has_perm('prospects.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('prospects', jsonb_build_object(
      'open_count', (select count(*) from public.prospects where company_id = v_co and stage not in ('won', 'lost')),
      'open_value', (select coalesce(sum(est_value), 0) from public.prospects where company_id = v_co and stage not in ('won', 'lost')),
      'weighted_value', (select coalesce(round(sum(est_value * case stage when 'new' then 0.1 when 'contacted' then 0.2 when 'qualified' then 0.4 when 'proposal' then 0.6 when 'negotiation' then 0.8 else 0 end), 2), 0)
                         from public.prospects where company_id = v_co and stage not in ('won', 'lost')),
      'overdue_actions', (select count(*) from public.prospects where company_id = v_co and stage not in ('won', 'lost') and next_action_date is not null and next_action_date < current_date),
      'won_90d', (select count(*) from public.prospects where company_id = v_co and stage = 'won' and stage_changed_at > now() - interval '90 days'),
      'lost_90d', (select count(*) from public.prospects where company_id = v_co and stage = 'lost' and stage_changed_at > now() - interval '90 days'),
      'by_stage', coalesce((select jsonb_agg(jsonb_build_object('stage', s.stage, 'count', coalesce(x.n, 0), 'value', coalesce(x.v, 0)) order by s.ord)
                  from (values ('new', 1), ('contacted', 2), ('qualified', 3), ('proposal', 4), ('negotiation', 5)) s(stage, ord)
                  left join (select stage, count(*) n, sum(est_value) v from public.prospects where company_id = v_co group by stage) x on x.stage = s.stage), '[]'::jsonb)));
  end if;
  if private.has_perm('quotes.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('quotes', jsonb_build_object(
      'draft_count', (select count(*) from public.quotes where company_id = v_co and status = 'draft'),
      'sent_count', (select count(*) from public.quotes where company_id = v_co and status = 'sent'),
      'sent_value', (select coalesce(sum(subtotal), 0) from public.quotes where company_id = v_co and status = 'sent'),
      'expiring_7d', (select count(*) from public.quotes where company_id = v_co and status = 'sent' and valid_until between current_date and current_date + 7),
      'expired', (select count(*) from public.quotes where company_id = v_co and status = 'sent' and valid_until < current_date),
      'won_90d_value', (select coalesce(sum(subtotal), 0) from public.quotes where company_id = v_co and status in ('accepted', 'converted') and decided_at > now() - interval '90 days'),
      'conversion_rate', (select case when count(*) filter (where status in ('accepted', 'converted', 'rejected')) = 0 then null
                           else round(100.0 * count(*) filter (where status in ('accepted', 'converted')) / count(*) filter (where status in ('accepted', 'converted', 'rejected')), 1) end
                          from public.quotes where company_id = v_co and decided_at > now() - interval '90 days')));
  end if;
  if private.has_perm('orders.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('orders', jsonb_build_object(
      'to_confirm', (select count(*) from public.sales_orders where company_id = v_co and status = 'draft'),
      'open_count', (select count(*) from public.sales_orders where company_id = v_co and status = 'confirmed'),
      'to_invoice_count', (select count(*) from public.sales_orders where company_id = v_co and status in ('confirmed', 'delivered') and invoice_status <> 'full'),
      'to_invoice_value', (select coalesce(sum(round(l.qty_rem * l.unit_price * (1 - l.discount_pct / 100), 2)), 0)
                           from (select ol.*, (ol.qty - ol.qty_invoiced) as qty_rem from public.sales_order_lines ol join public.sales_orders so on so.id = ol.order_id
                                 where so.company_id = v_co and so.status in ('confirmed', 'delivered')) l)));
  end if;
  if private.has_perm('invoices.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('invoices', jsonb_build_object(
      'invoiced_month', (select coalesce(sum(subtotal), 0) from public.invoices where company_id = v_co and issue_date >= date_trunc('month', current_date) and status not in ('draft', 'cancelled'))
                        - (select coalesce(sum(subtotal), 0) from public.credit_notes where company_id = v_co and status = 'issued' and issue_date >= date_trunc('month', current_date)),
      'invoiced_year', (select coalesce(sum(subtotal), 0) from public.invoices where company_id = v_co and issue_date >= date_trunc('year', current_date) and status not in ('draft', 'cancelled'))
                        - (select coalesce(sum(subtotal), 0) from public.credit_notes where company_id = v_co and status = 'issued' and issue_date >= date_trunc('year', current_date)),
      'collected_month', (select coalesce(sum(amount), 0) from public.invoice_payments where company_id = v_co and paid_on >= date_trunc('month', current_date)),
      'outstanding', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid')),
      'overdue_count', (select count(*) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid') and due_date < current_date),
      'overdue_amount', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid') and due_date < current_date),
      'drafts', (select count(*) from public.invoices where company_id = v_co and status = 'draft'),
      'credit_notes_year', (select coalesce(sum(total), 0) from public.credit_notes where company_id = v_co and status = 'issued' and issue_date >= date_trunc('year', current_date)),
      'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m.month, 'amount', coalesce(x.a, 0)) order by m.month)
                  from (select to_char(date_trunc('month', current_date) - (g || ' month')::interval, 'YYYY-MM') as month from generate_series(0, 11) g) m
                  left join (select to_char(date_trunc('month', issue_date), 'YYYY-MM') as month, sum(subtotal) a from public.invoices
                             where company_id = v_co and status not in ('draft', 'cancelled') group by 1) x on x.month = m.month), '[]'::jsonb),
      'top_clients', coalesce((select jsonb_agg(t) from (select jsonb_build_object('client_id', c.id, 'name', c.name, 'amount', sum(i.subtotal)) t
                  from public.invoices i join public.clients c on c.id = i.client_id
                  where i.company_id = v_co and i.status not in ('draft', 'cancelled') and i.issue_date >= date_trunc('year', current_date) group by c.id, c.name order by sum(i.subtotal) desc limit 5) q), '[]'::jsonb)));
  end if;
  if not v_any then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 13. Historique, RLS, privilèges
-- ---------------------------------------------------------------------
create function private.audit_commercial_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.commercial_rpc() then return new; end if;
  if tg_table_name = 'prospects' then
    perform private.write_audit(new.company_id, 'prospect.create', 'prospect', new.id::text, new.code, null, jsonb_build_object('company_name', new.company_name, 'est_value', new.est_value));
  elsif tg_table_name = 'quotes' then
    perform private.write_audit(new.company_id, 'quote.create', 'quote', new.id::text, new.code, null, jsonb_build_object('code', new.code));
  elsif tg_table_name = 'invoices' then
    perform private.write_audit(new.company_id, 'invoice.create', 'invoice', new.id::text, 'Brouillon', null, jsonb_build_object('client_id', new.client_id));
  end if;
  return new;
end $$;
create trigger audit_prospects_i after insert on public.prospects for each row execute function private.audit_commercial_insert();
create trigger audit_quotes_i after insert on public.quotes for each row execute function private.audit_commercial_insert();
create trigger audit_invoices_i after insert on public.invoices for each row execute function private.audit_commercial_insert();

create policy audit_logs_select_commercial on public.audit_logs for select to authenticated
  using (company_id = private.current_company() and (
       (entity_type = 'prospect' and private.has_perm('prospects.read'))
    or (entity_type = 'quote' and private.has_perm('quotes.read'))
    or (entity_type in ('invoice', 'credit_note') and private.has_perm('invoices.read'))));

alter table public.prospects enable row level security;
alter table public.prospect_activities enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_lines enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_payments enable row level security;
alter table public.credit_notes enable row level security;
alter table public.credit_note_lines enable row level security;

revoke all on public.prospects, public.prospect_activities, public.quotes, public.quote_lines, public.invoices, public.invoice_lines,
              public.invoice_payments, public.credit_notes, public.credit_note_lines from anon, authenticated;
grant all on public.prospects, public.prospect_activities, public.quotes, public.quote_lines, public.invoices, public.invoice_lines,
             public.invoice_payments, public.credit_notes, public.credit_note_lines to service_role;
grant select on public.prospects, public.prospect_activities, public.quotes, public.quote_lines, public.invoices, public.invoice_lines,
                public.invoice_payments, public.credit_notes, public.credit_note_lines to authenticated;

grant insert (company_name, contact_name, email, phone, country, city, source, est_value, expected_close, owner_id, next_action, next_action_date, notes) on public.prospects to authenticated;
grant update (company_name, contact_name, email, phone, country, city, source, est_value, expected_close, owner_id, next_action, next_action_date, notes) on public.prospects to authenticated;
grant insert (prospect_id, kind, summary, happened_at) on public.prospect_activities to authenticated;
grant insert (client_id, prospect_id, valid_until, currency, tax_rate, payment_terms, lead_days, notes) on public.quotes to authenticated;
grant update (valid_until, currency, tax_rate, payment_terms, lead_days, notes) on public.quotes to authenticated;
grant insert (quote_id, article_id, description, qty, unit_price, discount_pct) on public.quote_lines to authenticated;
grant update (description, qty, unit_price, discount_pct) on public.quote_lines to authenticated;
grant delete on public.quote_lines to authenticated;

-- commandes : on étend les colonnes écrivables (prix, TVA, conditions) ; le reste (statut, totaux, facturation) reste réservé aux fonctions
grant insert (currency, tax_rate, payment_terms) on public.sales_orders to authenticated;
grant update (tax_rate, payment_terms) on public.sales_orders to authenticated;
grant insert (description, unit_price, discount_pct) on public.sales_order_lines to authenticated;
grant update (description, unit_price, discount_pct) on public.sales_order_lines to authenticated;

grant insert (client_id, tax_rate, payment_terms, notes) on public.invoices to authenticated;
grant update (tax_rate, payment_terms, notes) on public.invoices to authenticated;
grant insert (invoice_id, description, qty, unit_price, discount_pct) on public.invoice_lines to authenticated;
grant update (description, qty, unit_price, discount_pct) on public.invoice_lines to authenticated;
grant delete on public.invoice_lines to authenticated;
grant update (qty) on public.credit_note_lines to authenticated;
grant delete on public.credit_note_lines to authenticated;

do $$
declare t text; rd text;
begin
  for t, rd in select * from (values ('prospects', 'prospects.read'), ('prospect_activities', 'prospects.read'), ('quotes', 'quotes.read'), ('quote_lines', 'quotes.read'),
      ('invoices', 'invoices.read'), ('invoice_lines', 'invoices.read'), ('credit_notes', 'invoices.read'), ('credit_note_lines', 'invoices.read'), ('invoice_payments', 'payments.read')) v(a, b) loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_select', t, rd);
  end loop;
  for t, rd in select * from (values ('prospects', 'prospects.write'), ('quotes', 'quotes.write'), ('quote_lines', 'quotes.write'), ('invoices', 'invoices.write'), ('invoice_lines', 'invoices.write')) v(a, b) loop
    execute format($f$create policy %I on public.%I for insert to authenticated with check (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_insert', t, rd);
    execute format($f$create policy %I on public.%I for update to authenticated using (company_id = private.current_company() and private.has_perm(%L)) with check (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_update', t, rd, rd);
  end loop;
  for t, rd in select * from (values ('quote_lines', 'quotes.write'), ('invoice_lines', 'invoices.write'), ('credit_note_lines', 'invoices.write')) v(a, b) loop
    execute format($f$create policy %I on public.%I for delete to authenticated using (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_delete', t, rd);
  end loop;
end $$;
create policy prospect_activities_insert on public.prospect_activities for insert to authenticated with check (company_id = private.current_company() and private.has_perm('prospects.write'));
create policy credit_note_lines_update on public.credit_note_lines for update to authenticated
  using (company_id = private.current_company() and private.has_perm('invoices.write')) with check (company_id = private.current_company() and private.has_perm('invoices.write'));

do $$
declare f text;
begin
  foreach f in array array['prospect_set_stage(uuid,text,text)', 'prospect_convert(uuid)', 'quote_send(uuid)', 'quote_decide(uuid,boolean,text)', 'quote_cancel(uuid)',
      'quote_duplicate(uuid)', 'quote_to_order(uuid)', 'invoice_from_order(uuid,jsonb)', 'invoice_issue(uuid)', 'invoice_cancel(uuid)',
      'invoice_record_payment(uuid,numeric,date,text,text)', 'credit_note_create(uuid,text)', 'credit_note_issue(uuid,boolean)', 'credit_note_cancel(uuid)', 'commercial_dashboard()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ===== 0013_pdm.sql =====
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


-- ===== 0014_development.sql =====
-- =====================================================================
-- 0014_development — Module Développement Produit
--  Workflow : Demande client → Projet → Prototype → Échantillon → BAT → Validation client → Industrialisation → Production série.
--  Tables : development_projects, prototypes, prototype_costs, samples, customer_validations, industrialization,
--           development_exchanges (historique des échanges, append-only), development_documents (pièces jointes GED).
--  Règles : l'étape n'avance que d'un cran et sous conditions (prototype approuvé, échantillon approuvé, BAT soumis puis approuvé,
--           industrialisation prête) ; tout retour en arrière exige un motif. Versions numérotées par projet (prototypes, échantillons, BAT).
--  Coûts de prototype : réservés à `development.costs` / `costs.read` (jamais dans l'historique, jamais dans les listes).
--  Alertes de validation : retards, échéances proches, validations sans réponse (RPC development_alerts).
--  Permissions nouvelles : development.read / development.write / development.costs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('development.read',  'articles', 'Voir le développement produit', 'Projets, Kanban, prototypes, échantillons, validations, tableau de bord et alertes'),
  ('development.write', 'articles', 'Gérer le développement produit', 'Créer et faire avancer les projets, prototypes, échantillons, validations client, échanges'),
  ('development.costs', 'articles', 'Saisir et voir les coûts de prototype', 'Coûts matière, main-d''œuvre, sous-traitance des prototypes')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('development.read', 'development.write', 'development.costs'))
  or (r.code = 'direction'  and p.code = 'development.read')
  or (r.code = 'commercial' and p.code in ('development.read', 'development.write'))
  or (r.code = 'production' and p.code in ('development.read', 'development.write', 'development.costs'))
  or (r.code = 'qualite'    and p.code = 'development.read')
  or (r.code = 'achat'      and p.code = 'development.read')
  or (r.code = 'finance'    and p.code = 'development.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.development_projects (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  client_id        uuid not null references public.clients(id),
  code             text not null,                                           -- DEV-0001
  name             text not null check (length(btrim(name)) between 2 and 160),
  family           text not null default 'other' check (family in ('jacket','trousers','coverall','polo','tshirt','vest','parka','shirt','apron','accessory','other')),
  description      text check (description is null or length(description) <= 4000),   -- demande du client
  stage            text not null default 'request' check (stage in ('request','project','prototype','sample','bat','validation','industrialization','production')),
  status           text not null default 'active' check (status in ('active','on_hold','cancelled','completed')),
  priority         text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  owner_id         uuid references public.profiles(id) on delete set null,
  requested_on     date not null default current_date,
  due_date         date,
  target_qty       int check (target_qty is null or target_qty > 0),         -- quantité de la série visée
  product_id       uuid references public.product_master(id) on delete set null,   -- fiche produit (PDM) liée
  stage_changed_at timestamptz not null default now(),
  hold_reason      text check (hold_reason is null or length(hold_reason) <= 300),
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  unique (company_id, code),
  constraint dev_dates_ck check (due_date is null or due_date >= requested_on)
);
create index dev_projects_idx on public.development_projects (company_id, status, stage);
create index dev_projects_client_idx on public.development_projects (client_id);

create table public.prototypes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  project_id   uuid not null references public.development_projects(id) on delete cascade,
  version_no   int not null check (version_no >= 1),
  name         text check (name is null or length(name) <= 160),
  description  text check (description is null or length(description) <= 2000),
  status       text not null default 'planned' check (status in ('planned','in_progress','ready','approved','rejected')),
  owner_id     uuid references public.profiles(id) on delete set null,
  due_date     date,
  started_on   date,
  completed_on date,
  feedback     text check (feedback is null or length(feedback) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  unique (project_id, version_no)
);

create table public.prototype_costs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  project_id   uuid not null references public.development_projects(id) on delete cascade,
  prototype_id uuid not null references public.prototypes(id) on delete cascade,
  kind         text not null default 'material' check (kind in ('material','labor','subcontract','shipping','other')),
  description  text not null check (length(btrim(description)) between 1 and 200),
  quantity     numeric(12,3) not null default 1 check (quantity > 0 and quantity < 100000000),
  unit_cost    numeric(14,4) not null default 0 check (unit_cost >= 0 and unit_cost < 1000000000),
  amount       numeric(16,2) generated always as (round(quantity * unit_cost, 2)) stored,
  incurred_on  date not null default current_date,
  created_at   timestamptz not null default now(),
  created_by   uuid
);
create index prototype_costs_idx on public.prototype_costs (prototype_id);

create table public.samples (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  project_id   uuid not null references public.development_projects(id) on delete cascade,
  version_no   int not null check (version_no >= 1),
  prototype_id uuid references public.prototypes(id) on delete set null,
  status       text not null default 'planned' check (status in ('planned','in_progress','sent','approved','rejected','revision')),
  qty          int not null default 1 check (qty > 0 and qty <= 10000),
  size_label   text check (size_label is null or length(size_label) <= 12),
  color        text check (color is null or length(color) <= 60),
  due_date     date,
  sent_on      date,
  tracking     text check (tracking is null or length(tracking) <= 80),
  notes        text check (notes is null or length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  unique (project_id, version_no)
);

create table public.customer_validations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  project_id       uuid not null references public.development_projects(id) on delete cascade,
  kind             text not null check (kind in ('sample','bat')),
  sample_id        uuid references public.samples(id) on delete cascade,
  version_no       int not null check (version_no >= 1),                    -- numéro par projet et par type (BAT v1, v2…)
  status           text not null default 'pending' check (status in ('pending','approved','rejected','changes_requested')),
  submitted_on     date not null default current_date,
  due_date         date,                                                    -- réponse attendue avant
  decided_on       date,
  decided_by_name  text check (decided_by_name is null or length(decided_by_name) <= 120),
  comment          text check (comment is null or length(comment) <= 1000),
  reminder_count   int not null default 0,
  last_reminder_on date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  unique (project_id, kind, version_no),
  constraint cv_sample_ck check ((kind = 'sample') = (sample_id is not null)),
  constraint cv_dates_ck check (due_date is null or due_date >= submitted_on)
);
create unique index cv_one_pending_uq on public.customer_validations (project_id, kind, coalesce(sample_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'pending';
create index cv_pending_idx on public.customer_validations (company_id, status, due_date);

create table public.industrialization (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  project_id     uuid not null unique references public.development_projects(id) on delete cascade,
  status         text not null default 'not_started' check (status in ('not_started','in_progress','ready','released')),
  checklist      jsonb not null default '[]'::jsonb,
  target_date    date,
  pilot_qty      int check (pilot_qty is null or pilot_qty > 0),
  lead_time_days int check (lead_time_days is null or lead_time_days between 0 and 1000),
  bom_id         uuid references public.boms(id) on delete set null,
  notes          text check (notes is null or length(notes) <= 2000),
  ready_at       timestamptz,
  released_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);

create table public.development_exchanges (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  project_id    uuid not null references public.development_projects(id) on delete cascade,
  direction     text not null check (direction in ('inbound','outbound','internal')),
  channel       text not null default 'email' check (channel in ('email','phone','meeting','portal','message','other')),
  subject       text not null check (length(btrim(subject)) between 1 and 160),
  body          text check (body is null or length(body) <= 4000),
  contact_name  text check (contact_name is null or length(contact_name) <= 120),
  exchanged_on  date not null default current_date,
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index dev_exchanges_idx on public.development_exchanges (project_id, exchanged_on desc, created_at desc);

create table public.development_documents (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  project_id      uuid not null references public.development_projects(id) on delete cascade,
  ged_document_id uuid not null references public.ged_documents(id) on delete cascade,
  kind            text not null default 'other' check (kind in ('request','tech_pack','photo','bat','sample_report','approval','other')),
  note            text check (note is null or length(note) <= 300),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  unique (project_id, ged_document_id)
);

-- ---------------------------------------------------------------------
-- 3. Outils internes
-- ---------------------------------------------------------------------
create function private.dev_flag() returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting('dev.rpc', true), 'off') = 'on' $$;

create function private.dev_meta(p_client uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('client_id', p_client, 'client_name', (select name from public.clients where id = p_client)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.dev_meta(uuid, jsonb) from public, anon, authenticated;

-- Projet modifiable : trouvé, client ouvert, projet ni annulé ni terminé (sauf p_allow_closed)
create function private.dev_assert_open(p_project uuid, p_allow_closed boolean default false) returns public.development_projects
language plpgsql stable security definer set search_path = '' as $$
declare v public.development_projects%rowtype;
begin
  select * into v from public.development_projects where id = p_project;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v.client_id);
  if v.status in ('cancelled', 'completed') and not p_allow_closed and not private.dev_flag() then raise exception 'DEV_PROJECT_CLOSED' using errcode = '55000'; end if;
  return v;
end $$;
revoke execute on function private.dev_assert_open(uuid, boolean) from public, anon, authenticated;

create function private.dev_default_checklist() returns jsonb
language sql immutable set search_path = '' as $$
  select '[{"key":"pattern","label":"Patronage gradué validé","done":false},{"key":"bom","label":"Nomenclature (BOM) validée","done":false},
           {"key":"routing","label":"Gamme opératoire et temps validés","done":false},{"key":"sourcing","label":"Approvisionnement des matières confirmé","done":false},
           {"key":"marker","label":"Plan de coupe / marqueur validé","done":false},{"key":"pilot","label":"Série pilote réalisée","done":false},
           {"key":"quality","label":"Plan de contrôle qualité défini","done":false},{"key":"packaging","label":"Packaging et étiquetage prêts","done":false}]'::jsonb
$$;

create function private.dev_checklist_valid(c jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare e jsonb;
begin
  if coalesce(jsonb_typeof(c), '') <> 'array' or jsonb_array_length(c) > 30 then return false; end if;
  for e in select * from jsonb_array_elements(c) loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'key', '')), '') is null or length(e ->> 'key') > 40
       or nullif(btrim(coalesce(e ->> 'label', '')), '') is null or length(e ->> 'label') > 160 or jsonb_typeof(e -> 'done') <> 'boolean' then return false; end if;
  end loop;
  return (select count(distinct x ->> 'key') from jsonb_array_elements(c) x) = jsonb_array_length(c);
end $$;
alter table public.industrialization add constraint industrialization_checklist_ck check (private.dev_checklist_valid(checklist));

-- ---------------------------------------------------------------------
-- 4. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.dev_projects_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    perform private.ged_assert_client_open(new.client_id);
    select company_id into new.company_id from public.clients where id = new.client_id;
    v_n := private.next_seq(new.company_id, 'dev');
    new.code := 'DEV-' || lpad(v_n::text, 4, '0');
    new.stage := 'request'; new.status := 'active'; new.stage_changed_at := now(); new.closed_at := null; new.hold_reason := null;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
  elsif not private.dev_flag() then
    if new.client_id is distinct from old.client_id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
       or new.stage is distinct from old.stage or new.status is distinct from old.status or new.stage_changed_at is distinct from old.stage_changed_at
       or new.closed_at is distinct from old.closed_at or new.hold_reason is distinct from old.hold_reason then
      raise exception 'DEV_REF_LOCKED' using errcode = '42501';
    end if;
    perform private.ged_assert_client_open(new.client_id);
    if old.status in ('cancelled', 'completed') then raise exception 'DEV_PROJECT_CLOSED' using errcode = '55000'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  if new.product_id is not null and (tg_op = 'INSERT' or new.product_id is distinct from old.product_id) then
    if not exists (select 1 from public.product_master p where p.id = new.product_id and p.client_id = new.client_id) then
      raise exception 'DEV_BAD_PRODUCT' using errcode = '22023';       -- la fiche produit doit appartenir au même client
    end if;
  end if;
  new.name := btrim(new.name);
  return new;
end $$;
create trigger dev_projects_before_iu before insert or update on public.development_projects
  for each row execute function private.dev_projects_before();

create function private.dev_projects_seed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('dev.rpc', true), 'off');
begin
  perform set_config('dev.rpc', 'on', true);
  insert into public.industrialization (company_id, project_id, checklist) values (new.company_id, new.id, private.dev_default_checklist());
  perform set_config('dev.rpc', v_prev, true);
  return new;
end $$;
create trigger dev_projects_seed_i after insert on public.development_projects
  for each row execute function private.dev_projects_seed();

create function private.dev_prototypes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'INSERT' then
    p := private.dev_assert_open(new.project_id);
    perform pg_advisory_xact_lock(hashtext(new.project_id::text));
    new.company_id := p.company_id;
    new.version_no := coalesce((select max(version_no) from public.prototypes where project_id = new.project_id), 0) + 1;
    new.status := 'planned'; new.started_on := null; new.completed_on := null; new.feedback := null; new.created_by := auth.uid();
  else
    if not private.dev_flag() then
      perform private.dev_assert_open(new.project_id);
      if new.project_id is distinct from old.project_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.completed_on is distinct from old.completed_on or new.feedback is distinct from old.feedback then
        raise exception 'DEV_REF_LOCKED' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger dev_prototypes_before_iu before insert or update on public.prototypes
  for each row execute function private.dev_prototypes_before();

create function private.dev_costs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype; proto public.prototypes%rowtype;
begin
  if tg_op = 'DELETE' then
    if not private.dev_flag() then perform private.dev_assert_open(old.project_id); end if;
    return old;
  end if;
  select * into proto from public.prototypes where id = new.prototype_id;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(proto.project_id);
  new.company_id := p.company_id; new.project_id := proto.project_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid();
  elsif new.prototype_id is distinct from old.prototype_id then raise exception 'DEV_REF_LOCKED' using errcode = '42501'; end if;
  return new;
end $$;
create trigger dev_costs_before_iud before insert or update or delete on public.prototype_costs
  for each row execute function private.dev_costs_before();

create function private.dev_samples_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'INSERT' then
    p := private.dev_assert_open(new.project_id);
    perform pg_advisory_xact_lock(hashtext(new.project_id::text));
    new.company_id := p.company_id;
    new.version_no := coalesce((select max(version_no) from public.samples where project_id = new.project_id), 0) + 1;
    new.status := 'planned'; new.sent_on := null; new.created_by := auth.uid();
  else
    if not private.dev_flag() then
      perform private.dev_assert_open(new.project_id);
      if new.project_id is distinct from old.project_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.sent_on is distinct from old.sent_on or new.tracking is distinct from old.tracking then
        raise exception 'DEV_REF_LOCKED' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
  end if;
  if new.prototype_id is not null and (tg_op = 'INSERT' or new.prototype_id is distinct from old.prototype_id) then
    if not exists (select 1 from public.prototypes x where x.id = new.prototype_id and x.project_id = new.project_id) then
      raise exception 'DEV_BAD_PROTOTYPE' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger dev_samples_before_iu before insert or update on public.samples
  for each row execute function private.dev_samples_before();

create function private.dev_validations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype; s public.samples%rowtype;
begin
  if tg_op = 'INSERT' then
    p := private.dev_assert_open(new.project_id);
    perform pg_advisory_xact_lock(hashtext(new.project_id::text));
    new.company_id := p.company_id;
    if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
    if new.kind = 'sample' then
      select * into s from public.samples where id = new.sample_id and project_id = new.project_id;
      if not found then raise exception 'DEV_BAD_SAMPLE' using errcode = '22023'; end if;
      if s.status not in ('in_progress', 'sent') then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
    elsif p.stage not in ('bat', 'validation') then
      raise exception 'DEV_BAD_STAGE' using errcode = '55000';          -- un BAT se soumet aux étapes BAT / Validation client
    end if;
    new.version_no := coalesce((select max(version_no) from public.customer_validations where project_id = new.project_id and kind = new.kind), 0) + 1;
    new.status := 'pending'; new.decided_on := null; new.decided_by_name := null; new.reminder_count := 0; new.last_reminder_on := null; new.created_by := auth.uid();
  else
    if not private.dev_flag() then
      perform private.dev_assert_open(new.project_id);
      if new.project_id is distinct from old.project_id or new.kind is distinct from old.kind or new.sample_id is distinct from old.sample_id or new.version_no is distinct from old.version_no
         or new.status is distinct from old.status or new.decided_on is distinct from old.decided_on or new.decided_by_name is distinct from old.decided_by_name
         or new.submitted_on is distinct from old.submitted_on or new.reminder_count is distinct from old.reminder_count or new.last_reminder_on is distinct from old.last_reminder_on then
        raise exception 'DEV_REF_LOCKED' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger dev_validations_before_iu before insert or update on public.customer_validations
  for each row execute function private.dev_validations_before();

-- Soumettre un échantillon au client = il est « envoyé »
create function private.dev_validations_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('dev.rpc', true), 'off');
begin
  if new.kind = 'sample' then
    perform set_config('dev.rpc', 'on', true);
    update public.samples set status = 'sent', sent_on = coalesce(sent_on, new.submitted_on) where id = new.sample_id and status <> 'sent';
    perform set_config('dev.rpc', v_prev, true);
  end if;
  return new;
end $$;
create trigger dev_validations_after_i after insert on public.customer_validations
  for each row execute function private.dev_validations_after();

create function private.dev_industrialization_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'UPDATE' and not private.dev_flag() then
    p := private.dev_assert_open(new.project_id);
    if new.project_id is distinct from old.project_id or new.status is distinct from old.status or new.ready_at is distinct from old.ready_at or new.released_at is distinct from old.released_at then
      raise exception 'DEV_REF_LOCKED' using errcode = '42501';
    end if;
    if new.bom_id is not null and new.bom_id is distinct from old.bom_id and not exists (
        select 1 from public.boms b join public.articles a on a.id = b.article_id where b.id = new.bom_id and a.client_id = p.client_id) then
      raise exception 'DEV_BAD_BOM' using errcode = '22023';          -- nomenclature d'un article du même client
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger dev_industrialization_before_u before update on public.industrialization
  for each row execute function private.dev_industrialization_before();

create function private.dev_exchanges_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  p := private.dev_assert_open(new.project_id, true);       -- les échanges restent saisissables après clôture
  new.company_id := p.company_id; new.created_by := auth.uid();
  return new;
end $$;
create trigger dev_exchanges_before_i before insert on public.development_exchanges
  for each row execute function private.dev_exchanges_before();

create function private.dev_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'DELETE' then return old; end if;
  p := private.dev_assert_open(new.project_id, true);
  new.company_id := p.company_id;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.ged_documents g where g.id = new.ged_document_id and g.client_id = p.client_id and g.deleted_at is null) then
      raise exception 'DEV_BAD_DOCUMENT' using errcode = '22023';
    end if;
  elsif new.project_id is distinct from old.project_id or new.ged_document_id is distinct from old.ged_document_id then
    raise exception 'DEV_REF_LOCKED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger dev_documents_before_iud before insert or update or delete on public.development_documents
  for each row execute function private.dev_documents_before();

-- ---------------------------------------------------------------------
-- 5. Historique (audit_logs, entity_type = 'dev_project') — aucun montant de coût dans l'historique
-- ---------------------------------------------------------------------
create function private.audit_dev_projects() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.dev_flag() then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.create', 'dev_project', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'priority', new.priority, 'due_date', new.due_date), private.dev_meta(new.client_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name','family','description','priority','owner_id','due_date','target_qty','product_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'dev.update', 'dev_project', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', private.dev_meta(new.client_id));
    end if;
  end if;
  return new;
end $$;
create trigger audit_dev_projects_iu after insert or update on public.development_projects
  for each row execute function private.audit_dev_projects();

create function private.audit_dev_prototypes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid; v_chg jsonb;
begin
  if private.dev_flag() then return new; end if;
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.prototype_add', 'dev_project', new.project_id::text, v_code, null, null, private.dev_meta(v_client, jsonb_build_object('version', new.version_no, 'name', new.name)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','description','owner_id','due_date','started_on')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'dev.prototype_update', 'dev_project', new.project_id::text, v_code, v_chg -> 'before', v_chg -> 'after', private.dev_meta(v_client, jsonb_build_object('version', new.version_no)));
    end if;
  end if;
  return new;
end $$;
create trigger audit_dev_prototypes_iu after insert or update on public.prototypes
  for each row execute function private.audit_dev_prototypes();

create function private.audit_dev_costs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.prototype_costs%rowtype; v_code text; v_client uuid; v_ver int;
begin
  if private.dev_flag() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code, client_id into v_code, v_client from public.development_projects where id = r.project_id;
  select version_no into v_ver from public.prototypes where id = r.prototype_id;
  perform private.write_audit(r.company_id, case tg_op when 'INSERT' then 'dev.cost_add' when 'UPDATE' then 'dev.cost_update' else 'dev.cost_delete' end,
    'dev_project', r.project_id::text, v_code, null, null,
    private.dev_meta(v_client, jsonb_build_object('prototype', v_ver, 'kind', r.kind, 'description', r.description)));   -- volontairement sans montant
  return coalesce(new, old);
end $$;
create trigger audit_dev_costs_iud after insert or update or delete on public.prototype_costs
  for each row execute function private.audit_dev_costs();

create function private.audit_dev_samples() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid; v_chg jsonb;
begin
  if private.dev_flag() then return new; end if;
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.sample_add', 'dev_project', new.project_id::text, v_code, null, null, private.dev_meta(v_client, jsonb_build_object('version', new.version_no, 'qty', new.qty)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('qty','size_label','color','due_date','notes','prototype_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'dev.sample_update', 'dev_project', new.project_id::text, v_code, v_chg -> 'before', v_chg -> 'after', private.dev_meta(v_client, jsonb_build_object('version', new.version_no)));
    end if;
  end if;
  return new;
end $$;
create trigger audit_dev_samples_iu after insert or update on public.samples
  for each row execute function private.audit_dev_samples();

create function private.audit_dev_validations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid;
begin
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.validation_submit', 'dev_project', new.project_id::text, v_code, null, null,
      private.dev_meta(v_client, jsonb_build_object('kind', new.kind, 'version', new.version_no, 'due_date', new.due_date)));
  elsif not private.dev_flag() and new.due_date is distinct from old.due_date then
    perform private.write_audit(new.company_id, 'dev.validation_update', 'dev_project', new.project_id::text, v_code,
      jsonb_build_object('due_date', old.due_date), jsonb_build_object('due_date', new.due_date), private.dev_meta(v_client, jsonb_build_object('kind', new.kind, 'version', new.version_no)));
  end if;
  return new;
end $$;
create trigger audit_dev_validations_iu after insert or update on public.customer_validations
  for each row execute function private.audit_dev_validations();

create function private.audit_dev_exchanges() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid;
begin
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  perform private.write_audit(new.company_id, 'dev.exchange_add', 'dev_project', new.project_id::text, v_code, null, null,
    private.dev_meta(v_client, jsonb_build_object('subject', new.subject, 'direction', new.direction, 'channel', new.channel)));
  return new;
end $$;
create trigger audit_dev_exchanges_i after insert on public.development_exchanges
  for each row execute function private.audit_dev_exchanges();

create function private.audit_dev_documents() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.development_documents%rowtype; v_code text; v_client uuid; v_title text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select code, client_id into v_code, v_client from public.development_projects where id = r.project_id;
  if v_code is null then return coalesce(new, old); end if;           -- suppression en cascade du projet
  select title into v_title from public.ged_documents where id = r.ged_document_id;
  perform private.write_audit(r.company_id, case tg_op when 'INSERT' then 'dev.document_link' else 'dev.document_unlink' end, 'dev_project', r.project_id::text, v_code, null, null,
    private.dev_meta(v_client, jsonb_build_object('document', v_title, 'kind', r.kind, 'document_id', r.ged_document_id)));
  return coalesce(new, old);
end $$;
create trigger audit_dev_documents_id after insert or delete on public.development_documents
  for each row execute function private.audit_dev_documents();

create function private.audit_dev_industrialization() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid; v_toggled jsonb;
begin
  if private.dev_flag() then return new; end if;
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  select coalesce(jsonb_agg(jsonb_build_object('label', n ->> 'label', 'done', (n -> 'done')::boolean)), '[]'::jsonb) into v_toggled
  from jsonb_array_elements(new.checklist) n
  where coalesce((select (o -> 'done')::boolean from jsonb_array_elements(old.checklist) o where o ->> 'key' = n ->> 'key'), false) <> (n -> 'done')::boolean;
  if jsonb_array_length(v_toggled) > 0 or new.target_date is distinct from old.target_date or new.pilot_qty is distinct from old.pilot_qty
     or new.lead_time_days is distinct from old.lead_time_days or new.bom_id is distinct from old.bom_id or new.notes is distinct from old.notes then
    perform private.write_audit(new.company_id, 'dev.industrialization_update', 'dev_project', new.project_id::text, v_code,
      jsonb_build_object('target_date', old.target_date, 'pilot_qty', old.pilot_qty, 'lead_time_days', old.lead_time_days),
      jsonb_build_object('target_date', new.target_date, 'pilot_qty', new.pilot_qty, 'lead_time_days', new.lead_time_days),
      private.dev_meta(v_client, jsonb_build_object('toggled', v_toggled,
        'done', (select count(*) from jsonb_array_elements(new.checklist) x where (x -> 'done')::boolean), 'total', jsonb_array_length(new.checklist))));
  end if;
  return new;
end $$;
create trigger audit_dev_industrialization_u after update on public.industrialization
  for each row execute function private.audit_dev_industrialization();

create policy audit_logs_select_dev on public.audit_logs for select to authenticated
  using (entity_type = 'dev_project' and company_id = private.current_company() and private.has_perm('development.read'));

-- ---------------------------------------------------------------------
-- 6. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.development_projects  enable row level security;
alter table public.prototypes            enable row level security;
alter table public.prototype_costs       enable row level security;
alter table public.samples               enable row level security;
alter table public.customer_validations  enable row level security;
alter table public.industrialization     enable row level security;
alter table public.development_exchanges enable row level security;
alter table public.development_documents enable row level security;

revoke all on public.development_projects, public.prototypes, public.prototype_costs, public.samples, public.customer_validations,
              public.industrialization, public.development_exchanges, public.development_documents from anon, authenticated;
grant all on public.development_projects, public.prototypes, public.prototype_costs, public.samples, public.customer_validations,
             public.industrialization, public.development_exchanges, public.development_documents to service_role;
grant select on public.development_projects, public.prototypes, public.prototype_costs, public.samples, public.customer_validations,
                public.industrialization, public.development_exchanges, public.development_documents to authenticated;
grant insert (client_id, name, family, description, priority, owner_id, requested_on, due_date, target_qty, product_id) on public.development_projects to authenticated;
grant update (name, family, description, priority, owner_id, due_date, target_qty, product_id) on public.development_projects to authenticated;
grant insert (project_id, name, description, owner_id, due_date) on public.prototypes to authenticated;
grant update (name, description, owner_id, due_date, started_on) on public.prototypes to authenticated;
grant insert (prototype_id, kind, description, quantity, unit_cost, incurred_on) on public.prototype_costs to authenticated;
grant update (kind, description, quantity, unit_cost, incurred_on) on public.prototype_costs to authenticated;
grant delete on public.prototype_costs to authenticated;
grant insert (project_id, prototype_id, qty, size_label, color, due_date, notes) on public.samples to authenticated;
grant update (prototype_id, qty, size_label, color, due_date, notes) on public.samples to authenticated;
grant insert (project_id, kind, sample_id, due_date, comment) on public.customer_validations to authenticated;
grant update (due_date) on public.customer_validations to authenticated;
grant update (checklist, target_date, pilot_qty, lead_time_days, bom_id, notes) on public.industrialization to authenticated;
grant insert (project_id, direction, channel, subject, body, contact_name, exchanged_on) on public.development_exchanges to authenticated;
grant insert (project_id, ged_document_id, kind, note) on public.development_documents to authenticated;
grant update (kind, note) on public.development_documents to authenticated;
grant delete on public.development_documents to authenticated;

create policy dev_projects_select on public.development_projects for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_projects_insert on public.development_projects for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_projects_update on public.development_projects for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_prototypes_select on public.prototypes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_prototypes_insert on public.prototypes for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_prototypes_update on public.prototypes for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

-- Coûts : lecture costs.read (finance…) ou development.costs ; écriture development.costs uniquement
create policy dev_costs_select on public.prototype_costs for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('development.costs') or private.has_perm('costs.read')));
create policy dev_costs_insert on public.prototype_costs for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.costs'));
create policy dev_costs_update on public.prototype_costs for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.costs'))
  with check (company_id = private.current_company() and private.has_perm('development.costs'));
create policy dev_costs_delete on public.prototype_costs for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('development.costs'));

create policy dev_samples_select on public.samples for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_samples_insert on public.samples for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_samples_update on public.samples for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_validations_select on public.customer_validations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_validations_insert on public.customer_validations for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_validations_update on public.customer_validations for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write') and status = 'pending')
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_ind_select on public.industrialization for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_ind_update on public.industrialization for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_exchanges_select on public.development_exchanges for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_exchanges_insert on public.development_exchanges for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_documents_select on public.development_documents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_documents_insert on public.development_documents for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write')
              and exists (select 1 from public.ged_documents g where g.id = ged_document_id));
create policy dev_documents_update on public.development_documents for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_documents_delete on public.development_documents for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'));

-- ---------------------------------------------------------------------
-- 7. RPC : avancement du projet, statut, prototypes, échantillons, validations, industrialisation
-- ---------------------------------------------------------------------
create function public.dev_project_advance(p_project uuid, p_to text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.development_projects%rowtype; ind public.industrialization%rowtype; v_prod public.product_master%rowtype;
  v_seq constant text[] := array['request','project','prototype','sample','bat','validation','industrialization','production'];
  v_from int; v_to int; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('development.write');
  select * into p from public.development_projects where id = p_project and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(p.client_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  v_from := array_position(v_seq, p.stage); v_to := array_position(v_seq, p_to);
  if v_to is null or v_to = v_from then raise exception 'DEV_BAD_STAGE' using errcode = '22023'; end if;
  select * into ind from public.industrialization where project_id = p_project for update;

  if v_to < v_from then
    if v_reason is null or length(v_reason) < 3 then raise exception 'DEV_REASON_REQUIRED' using errcode = '22023'; end if;
  elsif v_to > v_from + 1 then
    raise exception 'DEV_STAGE_SKIP' using errcode = '55000';
  else
    case p.stage
      when 'prototype' then
        if not exists (select 1 from public.prototypes where project_id = p_project and status = 'approved') then raise exception 'DEV_GATE_PROTOTYPE' using errcode = '55000'; end if;
      when 'sample' then
        if not exists (select 1 from public.samples where project_id = p_project and status = 'approved') then raise exception 'DEV_GATE_SAMPLE' using errcode = '55000'; end if;
      when 'bat' then
        if not exists (select 1 from public.customer_validations where project_id = p_project and kind = 'bat') then raise exception 'DEV_GATE_BAT' using errcode = '55000'; end if;
      when 'validation' then
        if coalesce((select status from public.customer_validations where project_id = p_project and kind = 'bat' order by version_no desc limit 1), '') <> 'approved' then
          raise exception 'DEV_GATE_VALIDATION' using errcode = '55000';
        end if;
      when 'industrialization' then
        if ind.status <> 'ready' then raise exception 'DEV_GATE_INDUSTRIALIZATION' using errcode = '55000'; end if;
        if p.product_id is not null then
          select * into v_prod from public.product_master where id = p.product_id;
          if v_prod.active_version_id is null then raise exception 'DEV_PRODUCT_NOT_VALIDATED' using errcode = '55000'; end if;
        end if;
      else null;
    end case;
  end if;

  perform set_config('dev.rpc', 'on', true);
  update public.development_projects set stage = p_to, stage_changed_at = now() where id = p_project;
  if p_to = 'industrialization' and ind.status = 'not_started' then
    update public.industrialization set status = 'in_progress' where project_id = p_project;
  elsif p_to = 'production' then
    update public.industrialization set status = 'released', released_at = now() where project_id = p_project;
  elsif v_from = 8 and ind.status = 'released' then
    update public.industrialization set status = 'ready', released_at = null where project_id = p_project;
  end if;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'dev.stage', 'dev_project', p.id::text, p.code, jsonb_build_object('stage', p.stage), jsonb_build_object('stage', p_to),
    private.dev_meta(p.client_id, jsonb_build_object('reason', v_reason, 'backward', v_to < v_from)), 'rpc');
end $$;

create function public.dev_project_set_status(p_project uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('development.write');
  select * into p from public.development_projects where id = p_project and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(p.client_id);
  if p.status in ('cancelled', 'completed') then raise exception 'DEV_PROJECT_CLOSED' using errcode = '55000'; end if;
  if p_status not in ('active', 'on_hold', 'cancelled', 'completed') or p_status = p.status then raise exception 'DEV_BAD_STATUS' using errcode = '22023'; end if;
  if p_status = 'cancelled' and (v_reason is null or length(v_reason) < 3) then raise exception 'DEV_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_status = 'completed' and p.stage <> 'production' then raise exception 'DEV_GATE_COMPLETE' using errcode = '55000'; end if;
  perform set_config('dev.rpc', 'on', true);
  update public.development_projects set status = p_status, hold_reason = case when p_status in ('on_hold', 'cancelled') then v_reason else null end,
         closed_at = case when p_status in ('cancelled', 'completed') then now() else null end where id = p_project;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'dev.status', 'dev_project', p.id::text, p.code, jsonb_build_object('status', p.status), jsonb_build_object('status', p_status),
    private.dev_meta(p.client_id, jsonb_build_object('reason', v_reason)), 'rpc');
end $$;

create function public.dev_prototype_set_status(p_prototype uuid, p_status text, p_feedback text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.prototypes%rowtype; p public.development_projects%rowtype; v_fb text := nullif(btrim(coalesce(p_feedback, '')), '');
begin
  perform private.require_perm('development.write');
  select * into x from public.prototypes where id = p_prototype and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(x.project_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  if not ((x.status = 'planned' and p_status in ('in_progress', 'rejected')) or (x.status = 'in_progress' and p_status in ('ready', 'rejected'))
          or (x.status = 'ready' and p_status in ('approved', 'rejected', 'in_progress'))) then
    raise exception 'DEV_BAD_STATUS' using errcode = '55000';
  end if;
  perform set_config('dev.rpc', 'on', true);
  update public.prototypes set status = p_status, feedback = coalesce(v_fb, feedback),
         started_on = case when p_status = 'in_progress' then coalesce(started_on, current_date) else started_on end,
         completed_on = case when p_status in ('ready', 'approved', 'rejected') then current_date when p_status = 'in_progress' then null else completed_on end
  where id = p_prototype;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(x.company_id, 'dev.prototype_status', 'dev_project', x.project_id::text, p.code, jsonb_build_object('status', x.status), jsonb_build_object('status', p_status),
    private.dev_meta(p.client_id, jsonb_build_object('version', x.version_no, 'feedback', v_fb)), 'rpc');
end $$;

create function public.dev_sample_set_status(p_sample uuid, p_status text, p_tracking text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.samples%rowtype; p public.development_projects%rowtype; v_trk text := nullif(btrim(coalesce(p_tracking, '')), '');
begin
  perform private.require_perm('development.write');
  select * into x from public.samples where id = p_sample and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(x.project_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  if not ((x.status in ('planned', 'revision', 'rejected') and p_status = 'in_progress') or (x.status = 'in_progress' and p_status = 'sent')) then
    raise exception 'DEV_BAD_STATUS' using errcode = '55000';
  end if;
  perform set_config('dev.rpc', 'on', true);
  update public.samples set status = p_status, tracking = case when p_status = 'sent' then coalesce(v_trk, tracking) else tracking end,
         sent_on = case when p_status = 'sent' then coalesce(sent_on, current_date) else sent_on end where id = p_sample;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(x.company_id, 'dev.sample_status', 'dev_project', x.project_id::text, p.code, jsonb_build_object('status', x.status), jsonb_build_object('status', p_status),
    private.dev_meta(p.client_id, jsonb_build_object('version', x.version_no, 'tracking', v_trk)), 'rpc');
end $$;

-- Décision du client (échantillon ou BAT)
create function public.dev_validation_decide(p_validation uuid, p_decision text, p_comment text default null, p_contact text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.customer_validations%rowtype; p public.development_projects%rowtype; s public.samples%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), ''); v_sample_status text;
begin
  perform private.require_perm('development.write');
  select * into v from public.customer_validations where id = p_validation and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(v.project_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  if v.status <> 'pending' then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
  if p_decision not in ('approved', 'rejected', 'changes_requested') then raise exception 'DEV_BAD_STATUS' using errcode = '22023'; end if;
  if p_decision <> 'approved' and v_comment is null then raise exception 'DEV_COMMENT_REQUIRED' using errcode = '22023'; end if;
  perform set_config('dev.rpc', 'on', true);
  update public.customer_validations set status = p_decision, decided_on = current_date, comment = coalesce(v_comment, comment),
         decided_by_name = nullif(btrim(coalesce(p_contact, '')), '') where id = p_validation;
  if v.kind = 'sample' then
    v_sample_status := case p_decision when 'approved' then 'approved' when 'rejected' then 'rejected' else 'revision' end;
    update public.samples set status = v_sample_status where id = v.sample_id;
  end if;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'dev.validation_decide', 'dev_project', v.project_id::text, p.code, jsonb_build_object('status', 'pending'), jsonb_build_object('status', p_decision),
    private.dev_meta(p.client_id, jsonb_build_object('kind', v.kind, 'version', v.version_no, 'comment', v_comment, 'contact', nullif(btrim(coalesce(p_contact, '')), ''))), 'rpc');
end $$;

-- Relance du client (trace + compteur)
create function public.dev_validation_remind(p_validation uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.customer_validations%rowtype; p public.development_projects%rowtype;
begin
  perform private.require_perm('development.write');
  select * into v from public.customer_validations where id = p_validation and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(v.project_id);
  if v.status <> 'pending' then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('dev.rpc', 'on', true);
  update public.customer_validations set reminder_count = reminder_count + 1, last_reminder_on = current_date where id = p_validation;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'dev.validation_remind', 'dev_project', v.project_id::text, p.code, null, null,
    private.dev_meta(p.client_id, jsonb_build_object('kind', v.kind, 'version', v.version_no, 'reminder', v.reminder_count + 1, 'note', nullif(btrim(coalesce(p_note, '')), ''))), 'rpc');
end $$;

create function public.dev_industrialization_set_status(p_project uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare ind public.industrialization%rowtype; p public.development_projects%rowtype;
begin
  perform private.require_perm('development.write');
  select * into ind from public.industrialization where project_id = p_project and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(p_project);
  if ind.status = 'released' or p_status not in ('not_started', 'in_progress', 'ready') or p_status = ind.status then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
  if p_status = 'ready' and (jsonb_array_length(ind.checklist) = 0 or exists (select 1 from jsonb_array_elements(ind.checklist) x where not (x -> 'done')::boolean)) then
    raise exception 'DEV_CHECKLIST_INCOMPLETE' using errcode = '55000';
  end if;
  perform set_config('dev.rpc', 'on', true);
  update public.industrialization set status = p_status, ready_at = case when p_status = 'ready' then now() else null end where project_id = p_project;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(ind.company_id, 'dev.industrialization_status', 'dev_project', p_project::text, p.code, jsonb_build_object('status', ind.status), jsonb_build_object('status', p_status), private.dev_meta(p.client_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Alertes de validation et tableau de bord
-- ---------------------------------------------------------------------
create function public.development_alerts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_out jsonb;
begin
  perform private.require_perm('development.read');
  with a as (
    -- validations client en retard / proche / sans réponse
    select case when v.due_date < current_date then 'validation_overdue' when v.due_date <= current_date + 3 then 'validation_due_soon' else 'validation_stale' end as type,
           case when v.due_date < current_date then 'high' else 'medium' end as severity,
           p.id as project_id, p.code, p.name, c.name as client_name, v.id as ref_id,
           (case v.kind when 'bat' then 'BAT v' else 'Échantillon (validation) v' end || v.version_no) as ref,
           v.due_date as due_date, v.submitted_on as since,
           (current_date - coalesce(v.due_date, v.submitted_on))::int as days, v.reminder_count as reminders
    from public.customer_validations v join public.development_projects p on p.id = v.project_id join public.clients c on c.id = p.client_id
    where v.company_id = v_co and v.status = 'pending' and p.status = 'active'
      and (v.due_date <= current_date + 3 or (v.due_date is null and v.submitted_on <= current_date - 7))
    union all
    select 'project_overdue', 'high', p.id, p.code, p.name, c.name, null, ('Échéance du projet (' || p.stage || ')'), p.due_date, null, (current_date - p.due_date)::int, 0
    from public.development_projects p join public.clients c on c.id = p.client_id
    where p.company_id = v_co and p.status = 'active' and p.stage <> 'production' and p.due_date < current_date
    union all
    select 'prototype_overdue', 'medium', p.id, p.code, p.name, c.name, x.id, 'Prototype v' || x.version_no, x.due_date, null, (current_date - x.due_date)::int, 0
    from public.prototypes x join public.development_projects p on p.id = x.project_id join public.clients c on c.id = p.client_id
    where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress') and x.due_date < current_date
    union all
    select 'sample_overdue', 'medium', p.id, p.code, p.name, c.name, x.id, 'Échantillon v' || x.version_no, x.due_date, null, (current_date - x.due_date)::int, 0
    from public.samples x join public.development_projects p on p.id = x.project_id join public.clients c on c.id = p.client_id
    where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress') and x.due_date < current_date
    union all
    select 'stage_stuck', 'low', p.id, p.code, p.name, c.name, null, ('Étape « ' || p.stage || ' » depuis ' || (current_date - p.stage_changed_at::date) || ' j'), null, p.stage_changed_at::date, (current_date - p.stage_changed_at::date)::int, 0
    from public.development_projects p join public.clients c on c.id = p.client_id
    where p.company_id = v_co and p.status = 'active' and p.stage not in ('production') and p.stage_changed_at < now() - interval '21 days'
  )
  select coalesce(jsonb_agg(to_jsonb(a) order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, days desc, code), '[]'::jsonb) into v_out from a;
  return v_out;
end $$;

create function public.development_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_out jsonb; v_costs boolean := private.has_perm('development.costs') or private.has_perm('costs.read');
begin
  perform private.require_perm('development.read');
  v_out := jsonb_build_object(
    'by_stage', (select coalesce(jsonb_agg(jsonb_build_object('stage', s, 'count', (select count(*) from public.development_projects p where p.company_id = v_co and p.stage = s and p.status in ('active', 'on_hold')))
                  order by o), '[]'::jsonb)
                 from unnest(array['request','project','prototype','sample','bat','validation','industrialization','production']) with ordinality as t(s, o)),
    'projects', jsonb_build_object(
      'active',    (select count(*) from public.development_projects where company_id = v_co and status = 'active'),
      'on_hold',   (select count(*) from public.development_projects where company_id = v_co and status = 'on_hold'),
      'completed', (select count(*) from public.development_projects where company_id = v_co and status = 'completed'),
      'cancelled', (select count(*) from public.development_projects where company_id = v_co and status = 'cancelled'),
      'overdue',   (select count(*) from public.development_projects where company_id = v_co and status = 'active' and stage <> 'production' and due_date < current_date),
      'in_production', (select count(*) from public.development_projects where company_id = v_co and stage = 'production' and status in ('active', 'completed')),
      'avg_cycle_days', (select round(avg(extract(epoch from (stage_changed_at - created_at)) / 86400)::numeric, 1) from public.development_projects where company_id = v_co and stage = 'production' and status in ('active', 'completed')),
      'success_rate', (select case when count(*) filter (where status <> 'active' or stage = 'production') = 0 then null
                         else round(100.0 * count(*) filter (where stage = 'production' and status <> 'cancelled') / nullif(count(*) filter (where stage = 'production' or status = 'cancelled'), 0), 1) end
                       from public.development_projects where company_id = v_co)),
    'validations', jsonb_build_object(
      'pending',  (select count(*) from public.customer_validations v join public.development_projects p on p.id = v.project_id where v.company_id = v_co and v.status = 'pending' and p.status = 'active'),
      'overdue',  (select count(*) from public.customer_validations v join public.development_projects p on p.id = v.project_id where v.company_id = v_co and v.status = 'pending' and p.status = 'active' and v.due_date < current_date),
      'approved_90d', (select count(*) from public.customer_validations where company_id = v_co and status = 'approved' and decided_on >= current_date - 90),
      'refused_90d',  (select count(*) from public.customer_validations where company_id = v_co and status in ('rejected', 'changes_requested') and decided_on >= current_date - 90),
      'avg_response_days', (select round(avg(decided_on - submitted_on)::numeric, 1) from public.customer_validations where company_id = v_co and status <> 'pending' and decided_on >= current_date - 180)),
    'work', jsonb_build_object(
      'prototypes_open', (select count(*) from public.prototypes x join public.development_projects p on p.id = x.project_id where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress', 'ready')),
      'samples_open',    (select count(*) from public.samples x join public.development_projects p on p.id = x.project_id where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress')),
      'samples_at_client', (select count(*) from public.samples x join public.development_projects p on p.id = x.project_id where x.company_id = v_co and p.status = 'active' and x.status = 'sent')),
    'by_priority', (select coalesce(jsonb_object_agg(priority, n), '{}'::jsonb) from (select priority, count(*) n from public.development_projects where company_id = v_co and status = 'active' group by priority) x),
    'by_client', (select coalesce(jsonb_agg(jsonb_build_object('client', name, 'count', n) order by n desc), '[]'::jsonb)
                  from (select c.name, count(*) n from public.development_projects p join public.clients c on c.id = p.client_id where p.company_id = v_co and p.status in ('active', 'on_hold') group by c.name order by n desc limit 5) x),
    'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'count', (select count(*) from public.development_projects p where p.company_id = v_co and date_trunc('month', p.created_at) = m)) order by m), '[]'::jsonb)
                 from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m));
  if v_costs then
    v_out := v_out || jsonb_build_object('costs', jsonb_build_object(
      'total',   (select coalesce(sum(c.amount), 0) from public.prototype_costs c join public.development_projects p on p.id = c.project_id where c.company_id = v_co and p.status <> 'cancelled'),
      'last_30d', (select coalesce(sum(amount), 0) from public.prototype_costs where company_id = v_co and incurred_on >= current_date - 30),
      'by_project', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', amt) order by amt desc), '[]'::jsonb)
                     from (select p.code, p.name, sum(c.amount) amt from public.prototype_costs c join public.development_projects p on p.id = c.project_id where c.company_id = v_co group by p.code, p.name order by amt desc limit 5) x)));
  end if;
  return v_out;
end $$;

do $$
declare f text;
begin
  foreach f in array array['dev_project_advance(uuid,text,text)', 'dev_project_set_status(uuid,text,text)', 'dev_prototype_set_status(uuid,text,text)', 'dev_sample_set_status(uuid,text,text)',
                           'dev_validation_decide(uuid,text,text,text)', 'dev_validation_remind(uuid,text)', 'dev_industrialization_set_status(uuid,text)',
                           'development_alerts()', 'development_dashboard()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.dev_flag(), private.dev_default_checklist() from public, anon, authenticated;


-- ===== 0015_variants.sql =====
-- =====================================================================
-- 0015_variants — Module Variantes Textile
--  Déclinaisons taille × couleur d'un produit (PDM) : catalogues de tailles et de couleurs, variantes (SKU, code-barres GTIN,
--  prix, nomenclature propre à la variante), stock fini par variante et par entrepôt avec mouvements (append-only),
--  matrice taille/couleur (RPC variant_matrix), génération de la matrice, import depuis la fiche technique du PDM.
--  Tables : sizes, colors, product_variants, variant_stock (+ variant_stock_moves).
--  Permissions nouvelles : variants.read / variants.write / variants.stock.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('variants.read',  'articles', 'Voir les variantes textile', 'Matrice taille/couleur, prix, codes-barres, stock par variante'),
  ('variants.write', 'articles', 'Gérer les variantes',        'Catalogues tailles/couleurs, génération de la matrice, prix, codes-barres, nomenclature par variante'),
  ('variants.stock', 'articles', 'Mouvements de stock des variantes', 'Entrées, sorties, ajustements, inventaires, transferts, réservations, stock de sécurité')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('variants.read', 'variants.write', 'variants.stock'))
  or (r.code = 'commercial' and p.code in ('variants.read', 'variants.write'))
  or (r.code = 'production' and p.code in ('variants.read', 'variants.write', 'variants.stock'))
  or (r.code = 'magasin'    and p.code in ('variants.read', 'variants.stock'))
  or (r.code in ('direction', 'qualite', 'achat', 'finance') and p.code = 'variants.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Outils : GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) et drapeaux
-- ---------------------------------------------------------------------
create function private.gtin_valid(g text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare n int; i int; s int := 0; d int;
begin
  if g is null or g !~ '^[0-9]+$' or length(g) not in (8, 12, 13, 14) then return false; end if;
  n := length(g);
  for i in 1 .. n - 1 loop
    d := substr(g, n - i, 1)::int;                       -- chiffres de droite à gauche, hors clé
    s := s + d * case when i % 2 = 1 then 3 else 1 end;
  end loop;
  return (10 - s % 10) % 10 = substr(g, n, 1)::int;
end $$;

create function private.variants_flag(p_name text) returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting(p_name, true), 'off') = 'on' $$;

-- ---------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------
create table public.sizes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,11}$'),         -- S, M, XXL, 42…
  label      text not null check (length(btrim(label)) between 1 and 30),
  size_group text not null default 'letters' check (size_group in ('letters', 'numeric', 'other')),
  sort_order int  not null default 100 check (sort_order between 0 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create unique index sizes_code_uq on public.sizes (company_id, upper(code));

create table public.colors (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null check (code ~ '^[A-Z0-9]{1,10}$'),                          -- JAU, MAR…
  name       text not null check (length(btrim(name)) between 1 and 60),
  hex        text check (hex is null or hex ~ '^#[0-9a-fA-F]{6}$'),
  pantone    text check (pantone is null or length(pantone) <= 30),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create unique index colors_code_uq on public.colors (company_id, code);
create unique index colors_name_uq on public.colors (company_id, lower(btrim(name)));

create table public.product_variants (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  product_id uuid not null references public.product_master(id) on delete cascade,
  color_id   uuid not null references public.colors(id),
  size_id    uuid not null references public.sizes(id),
  sku        text not null check (length(btrim(sku)) between 3 and 40),
  barcode    text check (barcode is null or private.gtin_valid(barcode)),
  price      numeric(14,2) check (price is null or (price >= 0 and price < 1000000000)),    -- prix de vente HT
  currency   char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  bom_id     uuid references public.boms(id) on delete set null,        -- nomenclature propre à la variante (sinon celle de l'article du produit)
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (product_id, color_id, size_id)
);
create unique index product_variants_sku_uq on public.product_variants (company_id, upper(sku));
create unique index product_variants_barcode_uq on public.product_variants (company_id, barcode) where barcode is not null;
create index product_variants_idx on public.product_variants (product_id, active);

create table public.variant_stock (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  variant_id   uuid not null references public.product_variants(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  qty_on_hand  int not null default 0 check (qty_on_hand >= 0),
  qty_reserved int not null default 0 check (qty_reserved >= 0),
  safety_qty   int not null default 0 check (safety_qty >= 0),
  updated_at   timestamptz not null default now(),
  unique (variant_id, warehouse_id),
  constraint variant_stock_reserved_ck check (qty_reserved <= qty_on_hand)
);

create table public.variant_stock_moves (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  variant_id     uuid not null references public.product_variants(id),
  warehouse_id   uuid not null references public.warehouses(id),
  move_type      text not null check (move_type in ('receipt', 'issue', 'adjustment', 'inventory', 'transfer_in', 'transfer_out')),
  qty_delta      int not null check (qty_delta <> 0),
  balance_after  int not null check (balance_after >= 0),
  reason         text check (reason is null or length(reason) <= 200),
  reference      text check (reference is null or length(reference) <= 80),
  transfer_group uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid
);
create index variant_moves_idx on public.variant_stock_moves (variant_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Catalogues par défaut
-- ---------------------------------------------------------------------
create function private.variants_seed(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sizes (company_id, code, label, size_group, sort_order)
  select p_company, c, c, 'letters', o from (values ('XS', 10), ('S', 20), ('M', 30), ('L', 40), ('XL', 50), ('XXL', 60), ('3XL', 70), ('4XL', 80)) v(c, o)
  on conflict do nothing;
  insert into public.sizes (company_id, code, label, size_group, sort_order)
  select p_company, n::text, n::text, 'numeric', 200 + n from generate_series(36, 60, 2) n
  on conflict do nothing;
  insert into public.colors (company_id, code, name, hex)
  select p_company, c, n, h from (values ('JAU', 'Jaune HV', '#e6e600'), ('ORA', 'Orange HV', '#ff6600'), ('MAR', 'Marine', '#1f3a5f'), ('NOI', 'Noir', '#111111'),
    ('GRI', 'Gris', '#808080'), ('VER', 'Vert bouteille', '#1e5631'), ('ROU', 'Rouge', '#c00000'), ('BLE', 'Bleu roi', '#1b4fa3'), ('BLA', 'Blanc', '#ffffff'), ('BEI', 'Beige', '#d8c3a5')) v(c, n, h)
  on conflict do nothing;
end $$;
revoke execute on function private.variants_seed(uuid) from public, anon, authenticated;
select private.variants_seed(id) from public.companies;

-- ---------------------------------------------------------------------
-- 5. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.sizes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(private.current_company(), new.company_id); new.created_by := auth.uid();
  elsif new.company_id is distinct from old.company_id then raise exception 'VARIANT_REF_LOCKED' using errcode = '42501';
  else new.updated_at := now(); end if;
  new.code := upper(btrim(new.code)); new.label := btrim(new.label);
  return new;
end $$;
create trigger sizes_before_iu before insert or update on public.sizes for each row execute function private.sizes_before();

create function private.colors_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(private.current_company(), new.company_id); new.created_by := auth.uid();
  elsif new.company_id is distinct from old.company_id then raise exception 'VARIANT_REF_LOCKED' using errcode = '42501';
  else new.updated_at := now(); end if;
  new.code := upper(btrim(new.code)); new.name := btrim(new.name);
  return new;
end $$;
create trigger colors_before_iu before insert or update on public.colors for each row execute function private.colors_before();

create function private.variants_before() returns trigger
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
    if new.product_id is distinct from old.product_id or new.color_id is distinct from old.color_id or new.size_id is distinct from old.size_id or new.sku is distinct from old.sku then
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
create trigger variants_before_iu before insert or update on public.product_variants for each row execute function private.variants_before();

-- ---------------------------------------------------------------------
-- 6. Historique (entity_type 'variant' → id du produit ; 'variant_catalog')
-- ---------------------------------------------------------------------
create function private.audit_variants() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_chg jsonb; v_sku text;
begin
  if private.variants_flag('variants.bulk') or private.variants_flag('variants.rpc') then return coalesce(new, old); end if;
  select code into v_code from public.product_master where id = coalesce(new.product_id, old.product_id);
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'variant.add', 'variant', new.product_id::text, v_code, null, jsonb_build_object('sku', new.sku, 'price', new.price), jsonb_build_object('sku', new.sku));
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('price','currency','barcode','bom_id','active')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'variant.update', 'variant', new.product_id::text, v_code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('sku', new.sku));
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_variants_iu after insert or update on public.product_variants for each row execute function private.audit_variants();

create function private.audit_variant_catalog() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text := case tg_table_name when 'sizes' then 'size' else 'color' end; v_chg jsonb; v_label text;
begin
  v_label := case when tg_table_name = 'sizes' then new.code else new.code end;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'variant.' || v_kind || '_add', 'variant_catalog', new.id::text, v_label, null, to_jsonb(new) - 'id' - 'company_id' - 'created_at' - 'updated_at' - 'created_by', '{}');
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k in ('id','company_id','created_at','updated_at','created_by')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'variant.' || v_kind || '_update', 'variant_catalog', new.id::text, v_label, v_chg -> 'before', v_chg -> 'after', '{}');
    end if;
  end if;
  return new;
end $$;
create trigger audit_sizes_iu after insert or update on public.sizes for each row execute function private.audit_variant_catalog();
create trigger audit_colors_iu after insert or update on public.colors for each row execute function private.audit_variant_catalog();

create policy audit_logs_select_variants on public.audit_logs for select to authenticated
  using (entity_type in ('variant', 'variant_catalog') and company_id = private.current_company() and private.has_perm('variants.read'));

-- ---------------------------------------------------------------------
-- 7. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.sizes               enable row level security;
alter table public.colors              enable row level security;
alter table public.product_variants    enable row level security;
alter table public.variant_stock       enable row level security;
alter table public.variant_stock_moves enable row level security;

revoke all on public.sizes, public.colors, public.product_variants, public.variant_stock, public.variant_stock_moves from anon, authenticated;
grant all on public.sizes, public.colors, public.product_variants, public.variant_stock, public.variant_stock_moves to service_role;
grant select on public.sizes, public.colors, public.product_variants, public.variant_stock, public.variant_stock_moves to authenticated;
grant insert (code, label, size_group, sort_order, active) on public.sizes to authenticated;
grant update (label, size_group, sort_order, active) on public.sizes to authenticated;
grant delete on public.sizes to authenticated;
grant insert (code, name, hex, pantone, active) on public.colors to authenticated;
grant update (name, hex, pantone, active) on public.colors to authenticated;
grant delete on public.colors to authenticated;
grant insert (product_id, color_id, size_id, sku, barcode, price, currency, bom_id, active) on public.product_variants to authenticated;
grant update (barcode, price, currency, bom_id, active) on public.product_variants to authenticated;

create policy sizes_select on public.sizes for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy sizes_insert on public.sizes for insert to authenticated with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy sizes_update on public.sizes for update to authenticated using (company_id = private.current_company() and private.has_perm('variants.write')) with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy sizes_delete on public.sizes for delete to authenticated using (company_id = private.current_company() and private.has_perm('variants.write'));
create policy colors_select on public.colors for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy colors_insert on public.colors for insert to authenticated with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy colors_update on public.colors for update to authenticated using (company_id = private.current_company() and private.has_perm('variants.write')) with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy colors_delete on public.colors for delete to authenticated using (company_id = private.current_company() and private.has_perm('variants.write'));
create policy variants_select on public.product_variants for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy variants_insert on public.product_variants for insert to authenticated with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy variants_update on public.product_variants for update to authenticated using (company_id = private.current_company() and private.has_perm('variants.write')) with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy variant_stock_select on public.variant_stock for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy variant_moves_select on public.variant_stock_moves for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));

-- ---------------------------------------------------------------------
-- 8. RPC : catalogues, matrice, import de la fiche technique, mise à jour groupée, codes-barres, suppression
-- ---------------------------------------------------------------------
create function public.variants_seed_defaults() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('variants.write');
  perform private.variants_seed(private.current_company());
end $$;

create function private.variant_product(p_product uuid, p_allow_archived boolean default false) returns public.product_master
language plpgsql stable security definer set search_path = '' as $$
declare p public.product_master%rowtype;
begin
  select * into p from public.product_master where id = p_product and company_id = private.current_company();
  if not found then raise exception 'VARIANT_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status = 'archived' and not p_allow_archived then raise exception 'VARIANT_PRODUCT_ARCHIVED' using errcode = '55000'; end if;
  return p;
end $$;
revoke execute on function private.variant_product(uuid, boolean) from public, anon, authenticated;

-- Génère les combinaisons manquantes couleurs × tailles (idempotent)
create function public.variant_generate(p_product uuid, p_colors uuid[], p_sizes uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; v_n int := 0; r record;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  if coalesce(cardinality(p_colors), 0) = 0 or coalesce(cardinality(p_sizes), 0) = 0 then raise exception 'VARIANT_EMPTY_SELECTION' using errcode = '22023'; end if;
  if cardinality(p_colors) * cardinality(p_sizes) > 400 then raise exception 'VARIANT_TOO_MANY' using errcode = '22023'; end if;
  perform set_config('variants.bulk', 'on', true);
  for r in select c.id cid, s.id sid from public.colors c cross join public.sizes s
           where c.id = any (p_colors) and s.id = any (p_sizes) and c.company_id = p.company_id and s.company_id = p.company_id and c.active and s.active
           order by c.name, s.sort_order loop
    if not exists (select 1 from public.product_variants where product_id = p_product and color_id = r.cid and size_id = r.sid) then
      insert into public.product_variants (product_id, color_id, size_id) values (p_product, r.cid, r.sid);
      v_n := v_n + 1;
    end if;
  end loop;
  perform set_config('variants.bulk', 'off', true);
  if v_n > 0 then
    perform private.write_audit(p.company_id, 'variant.generate', 'variant', p.id::text, p.code, null, null, jsonb_build_object('created', v_n, 'colors', cardinality(p_colors), 'sizes', cardinality(p_sizes)), 'rpc');
  end if;
  return v_n;
end $$;

-- Importe couleurs, tailles et variantes depuis la fiche technique (version de référence du PDM)
create function public.variant_sync_from_spec(p_product uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; v_spec jsonb; e jsonb; rr record; v_cid uuid; v_sid uuid; v_code text; v_i int;
  n_colors int := 0; n_sizes int := 0; n_variants int := 0; v_bar text; v_sku text;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  select spec into v_spec from public.product_versions where id = coalesce(p.active_version_id, p.current_version_id);
  if v_spec is null then raise exception 'VARIANT_NO_SPEC' using errcode = '55000'; end if;
  perform set_config('variants.bulk', 'on', true);
  for e in select * from jsonb_array_elements(v_spec -> 'colors') loop
    if not exists (select 1 from public.colors where company_id = p.company_id and lower(btrim(name)) = lower(btrim(e ->> 'name'))) then
      v_code := coalesce(nullif(upper(left(regexp_replace(e ->> 'name', '[^A-Za-z0-9]', '', 'g'), 3)), ''), 'X'); v_i := 1;
      while exists (select 1 from public.colors where company_id = p.company_id and code = v_code) loop v_i := v_i + 1; v_code := upper(left(regexp_replace(e ->> 'name', '[^A-Za-z0-9]', '', 'g'), 3)) || v_i; end loop;
      insert into public.colors (code, name, hex, pantone) values (v_code, btrim(e ->> 'name'), nullif(e ->> 'hex', ''), nullif(e ->> 'pantone', ''));
      n_colors := n_colors + 1;
    end if;
  end loop;
  for e in select * from jsonb_array_elements(v_spec -> 'sizes') loop
    if not exists (select 1 from public.sizes where company_id = p.company_id and upper(code) = upper(btrim(e ->> 'label'))) then
      begin
        insert into public.sizes (code, label, size_group, sort_order) values (upper(btrim(e ->> 'label')), btrim(e ->> 'label'), 'other', 500);
        n_sizes := n_sizes + 1;
      exception when check_violation then null;       -- libellé de taille inutilisable comme code : ignoré
      end;
    end if;
  end loop;
  if jsonb_array_length(coalesce(v_spec -> 'variants', '[]'::jsonb)) > 0 then
    for e in select * from jsonb_array_elements(v_spec -> 'variants') loop
      continue when coalesce((e ->> 'active')::boolean, true) is false;
      select id into v_cid from public.colors where company_id = p.company_id and lower(btrim(name)) = lower(btrim(e ->> 'color'));
      select id into v_sid from public.sizes where company_id = p.company_id and upper(code) = upper(btrim(e ->> 'size'));
      continue when v_cid is null or v_sid is null;
      continue when exists (select 1 from public.product_variants where product_id = p_product and color_id = v_cid and size_id = v_sid);
      v_sku := upper(btrim(e ->> 'sku'));
      if exists (select 1 from public.product_variants where company_id = p.company_id and upper(sku) = v_sku) then v_sku := null; end if;
      v_bar := nullif(e ->> 'barcode', '');
      if v_bar is not null and (not private.gtin_valid(v_bar) or exists (select 1 from public.product_variants where company_id = p.company_id and barcode = v_bar)) then v_bar := null; end if;
      insert into public.product_variants (product_id, color_id, size_id, sku, barcode) values (p_product, v_cid, v_sid, v_sku, v_bar);
      n_variants := n_variants + 1;
    end loop;
  else
    for rr in select c.id cid, s.id sid from public.colors c cross join public.sizes s
             where lower(btrim(c.name)) in (select lower(btrim(x ->> 'name')) from jsonb_array_elements(v_spec -> 'colors') x)
               and upper(s.code) in (select upper(btrim(x ->> 'label')) from jsonb_array_elements(v_spec -> 'sizes') x) and c.company_id = p.company_id and s.company_id = p.company_id loop
      continue when exists (select 1 from public.product_variants where product_id = p_product and color_id = rr.cid and size_id = rr.sid);
      insert into public.product_variants (product_id, color_id, size_id) values (p_product, rr.cid, rr.sid);
      n_variants := n_variants + 1;
    end loop;
  end if;
  perform set_config('variants.bulk', 'off', true);
  perform private.write_audit(p.company_id, 'variant.sync_spec', 'variant', p.id::text, p.code, null, null,
    jsonb_build_object('colors_created', n_colors, 'sizes_created', n_sizes, 'variants_created', n_variants), 'rpc');
  return jsonb_build_object('colors_created', n_colors, 'sizes_created', n_sizes, 'variants_created', n_variants);
end $$;

-- Mise à jour groupée depuis la matrice : [{id, price?, barcode?, active?, bom_id?}] ; seules les clés présentes sont appliquées
create function public.variant_bulk_update(p_product uuid, p_changes jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; e jsonb; v public.product_variants%rowtype; n int := 0; v_log jsonb := '[]'::jsonb; v_new numeric; v_bar text; v_bom uuid; v_act boolean; changed boolean;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 800 then raise exception 'VARIANT_BAD_INPUT' using errcode = '22023'; end if;
  perform set_config('variants.bulk', 'on', true);
  for e in select * from jsonb_array_elements(p_changes) loop
    select * into v from public.product_variants where id = (e ->> 'id')::uuid and product_id = p_product for update;
    if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
    changed := false;
    if e ? 'price' then
      v_new := case when jsonb_typeof(e -> 'price') = 'null' then null else (e ->> 'price')::numeric end;
      if v_new is distinct from v.price then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'price', 'from', v.price, 'to', v_new); update public.product_variants set price = v_new where id = v.id; changed := true;
      end if;
    end if;
    if e ? 'barcode' then
      v_bar := nullif(btrim(coalesce(e ->> 'barcode', '')), '');
      if v_bar is distinct from v.barcode then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'barcode', 'from', v.barcode, 'to', v_bar); update public.product_variants set barcode = v_bar where id = v.id; changed := true;
      end if;
    end if;
    if e ? 'active' then
      v_act := (e ->> 'active')::boolean;
      if v_act is distinct from v.active then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'active', 'from', v.active, 'to', v_act); update public.product_variants set active = v_act where id = v.id; changed := true;
      end if;
    end if;
    if e ? 'bom_id' then
      v_bom := case when jsonb_typeof(e -> 'bom_id') = 'null' then null else (e ->> 'bom_id')::uuid end;
      if v_bom is distinct from v.bom_id then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'bom_id', 'from', (select code from public.boms where id = v.bom_id), 'to', (select code from public.boms where id = v_bom));
        update public.product_variants set bom_id = v_bom where id = v.id; changed := true;
      end if;
    end if;
    if changed then n := n + 1; end if;
  end loop;
  perform set_config('variants.bulk', 'off', true);
  if n > 0 then
    perform private.write_audit(p.company_id, 'variant.bulk_update', 'variant', p.id::text, p.code, null, null,
      jsonb_build_object('count', n, 'changes', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_log) x limit 100) s)), 'rpc');
  end if;
  return n;
end $$;

-- Codes-barres EAN-13 internes (préfixe 29, diffusion restreinte) pour les variantes actives qui n'en ont pas
create function public.variant_assign_barcodes(p_product uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; r record; v_base text; v_sum int; v_i int; v_n int := 0;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  perform set_config('variants.bulk', 'on', true);
  for r in select id from public.product_variants where product_id = p_product and active and barcode is null order by sku loop
    v_base := '29' || lpad(private.next_seq(p.company_id, 'barcode')::text, 10, '0');
    v_sum := 0;
    for v_i in 1 .. 12 loop v_sum := v_sum + substr(v_base, v_i, 1)::int * case when v_i % 2 = 1 then 1 else 3 end; end loop;
    update public.product_variants set barcode = v_base || ((10 - v_sum % 10) % 10)::text where id = r.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('variants.bulk', 'off', true);
  if v_n > 0 then perform private.write_audit(p.company_id, 'variant.barcodes', 'variant', p.id::text, p.code, null, null, jsonb_build_object('assigned', v_n), 'rpc'); end if;
  return v_n;
end $$;

create function public.variant_delete(p_variant uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype;
begin
  perform private.require_perm('variants.write');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company() for update;
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.variant_product(v.product_id);
  if exists (select 1 from public.variant_stock_moves where variant_id = p_variant) or exists (select 1 from public.variant_stock where variant_id = p_variant and (qty_on_hand > 0 or qty_reserved > 0)) then
    raise exception 'VARIANT_HAS_STOCK' using errcode = '23503';      -- une variante avec historique de stock se désactive, elle ne se supprime pas
  end if;
  perform set_config('variants.rpc', 'on', true);
  delete from public.product_variants where id = p_variant;
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.delete', 'variant', p.id::text, p.code, jsonb_build_object('sku', v.sku, 'barcode', v.barcode, 'price', v.price), null, jsonb_build_object('sku', v.sku), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 9. RPC : stock par variante
-- ---------------------------------------------------------------------
create function public.variant_stock_move(p_variant uuid, p_type text, p_warehouse uuid, p_qty int, p_to_warehouse uuid default null, p_reason text default null, p_reference text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype; w public.warehouses%rowtype; w2 public.warehouses%rowtype; s public.variant_stock%rowtype; s2 public.variant_stock%rowtype;
  v_new int; v_delta int; v_group uuid := gen_random_uuid(); v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  perform private.require_perm('variants.stock');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company();
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.product_master where id = v.product_id;
  select * into w from public.warehouses where id = p_warehouse and company_id = v.company_id;
  if not found or w.archived_at is not null then raise exception 'VARIANT_BAD_WAREHOUSE' using errcode = '22023'; end if;
  if p_type not in ('receipt', 'issue', 'adjustment', 'inventory', 'transfer') or p_qty is null then raise exception 'VARIANT_BAD_INPUT' using errcode = '22023'; end if;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, w.id) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = v.id and warehouse_id = w.id for update;
  perform set_config('variants.rpc', 'on', true);

  if p_type = 'receipt' then
    if p_qty <= 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    v_delta := p_qty;
  elsif p_type = 'issue' then
    if p_qty <= 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if p_qty > s.qty_on_hand - s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    v_delta := -p_qty;
  elsif p_type = 'adjustment' then
    if p_qty = 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if v_reason is null then raise exception 'VARIANT_REASON_REQUIRED' using errcode = '22023'; end if;
    if s.qty_on_hand + p_qty < s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    v_delta := p_qty;
  elsif p_type = 'inventory' then
    if p_qty < 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if p_qty < s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    v_delta := p_qty - s.qty_on_hand;
    if v_delta = 0 then raise exception 'VARIANT_NO_CHANGE' using errcode = '22023'; end if;
    v_reason := coalesce(v_reason, 'Inventaire');
  else   -- transfer
    select * into w2 from public.warehouses where id = p_to_warehouse and company_id = v.company_id;
    if not found or w2.archived_at is not null or w2.id = w.id then raise exception 'VARIANT_BAD_WAREHOUSE' using errcode = '22023'; end if;
    if p_qty <= 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if p_qty > s.qty_on_hand - s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, w2.id) on conflict (variant_id, warehouse_id) do nothing;
    select * into s2 from public.variant_stock where variant_id = v.id and warehouse_id = w2.id for update;
    update public.variant_stock set qty_on_hand = qty_on_hand - p_qty, updated_at = now() where id = s.id;
    update public.variant_stock set qty_on_hand = qty_on_hand + p_qty, updated_at = now() where id = s2.id;
    insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, transfer_group, created_by)
      values (v.company_id, v.id, w.id, 'transfer_out', -p_qty, s.qty_on_hand - p_qty, v_reason, v_ref, v_group, auth.uid()),
             (v.company_id, v.id, w2.id, 'transfer_in', p_qty, s2.qty_on_hand + p_qty, v_reason, v_ref, v_group, auth.uid());
    perform set_config('variants.rpc', 'off', true);
    perform private.write_audit(v.company_id, 'variant.stock_move', 'variant', p.id::text, p.code, null, null,
      jsonb_build_object('sku', v.sku, 'type', 'transfer', 'qty', p_qty, 'from', w.name, 'to', w2.name, 'reason', v_reason, 'reference', v_ref), 'rpc');
    return jsonb_build_object('on_hand', s.qty_on_hand - p_qty, 'reserved', s.qty_reserved, 'available', s.qty_on_hand - p_qty - s.qty_reserved);
  end if;

  v_new := s.qty_on_hand + v_delta;
  update public.variant_stock set qty_on_hand = v_new, updated_at = now() where id = s.id;
  insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, created_by)
    values (v.company_id, v.id, w.id, p_type, v_delta, v_new, v_reason, v_ref, auth.uid());
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.stock_move', 'variant', p.id::text, p.code, null, null,
    jsonb_build_object('sku', v.sku, 'type', p_type, 'qty', v_delta, 'warehouse', w.name, 'balance', v_new, 'reason', v_reason, 'reference', v_ref), 'rpc');
  return jsonb_build_object('on_hand', v_new, 'reserved', s.qty_reserved, 'available', v_new - s.qty_reserved);
end $$;

create function public.variant_stock_reserve(p_variant uuid, p_warehouse uuid, p_delta int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype; s public.variant_stock%rowtype; v_new int;
begin
  perform private.require_perm('variants.stock');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company();
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.product_master where id = v.product_id;
  select * into s from public.variant_stock where variant_id = p_variant and warehouse_id = p_warehouse for update;
  if not found or p_delta is null or p_delta = 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
  v_new := s.qty_reserved + p_delta;
  if v_new < 0 or v_new > s.qty_on_hand then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
  perform set_config('variants.rpc', 'on', true);
  update public.variant_stock set qty_reserved = v_new, updated_at = now() where id = s.id;
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.stock_reserve', 'variant', p.id::text, p.code, null, null, jsonb_build_object('sku', v.sku, 'delta', p_delta, 'reserved', v_new), 'rpc');
  return jsonb_build_object('on_hand', s.qty_on_hand, 'reserved', v_new, 'available', s.qty_on_hand - v_new);
end $$;

create function public.variant_stock_set_safety(p_variant uuid, p_warehouse uuid, p_qty int) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype; w public.warehouses%rowtype; s public.variant_stock%rowtype;
begin
  perform private.require_perm('variants.stock');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company();
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.product_master where id = v.product_id;
  select * into w from public.warehouses where id = p_warehouse and company_id = v.company_id;
  if not found or w.archived_at is not null then raise exception 'VARIANT_BAD_WAREHOUSE' using errcode = '22023'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 10000000 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, w.id) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = v.id and warehouse_id = w.id for update;
  perform set_config('variants.rpc', 'on', true);
  update public.variant_stock set safety_qty = p_qty, updated_at = now() where id = s.id;
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.stock_safety', 'variant', p.id::text, p.code, jsonb_build_object('safety', s.safety_qty), jsonb_build_object('safety', p_qty), jsonb_build_object('sku', v.sku, 'warehouse', w.name), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 10. Matrice et vue d'ensemble
-- ---------------------------------------------------------------------
create function public.variant_matrix(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.product_master%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('variants.read');
  select * into p from public.product_master where id = p_product and company_id = v_co;
  if not found then raise exception 'VARIANT_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'product', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'status', p.status, 'client_id', p.client_id, 'article_id', p.article_id),
    'product_bom', (select jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'active_version_id', b.active_version_id)
                    from public.boms b where p.article_id is not null and b.article_id = p.article_id and b.archived_at is null limit 1),
    'warehouses', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name) order by w.name), '[]'::jsonb) from public.warehouses w where w.company_id = v_co and w.archived_at is null),
    'variants', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'color_id', x.color_id, 'size_id', x.size_id, 'sku', x.sku, 'barcode', x.barcode, 'price', x.price, 'currency', x.currency, 'bom_id', x.bom_id, 'active', x.active,
        'bom_code', (select code from public.boms where id = x.bom_id),
        'on_hand', coalesce((select sum(qty_on_hand) from public.variant_stock where variant_id = x.id), 0),
        'reserved', coalesce((select sum(qty_reserved) from public.variant_stock where variant_id = x.id), 0),
        'low', coalesce((select bool_or(safety_qty > 0 and qty_on_hand - qty_reserved <= safety_qty) from public.variant_stock where variant_id = x.id), false),
        'stock', (select coalesce(jsonb_agg(jsonb_build_object('warehouse_id', st.warehouse_id, 'on_hand', st.qty_on_hand, 'reserved', st.qty_reserved, 'safety', st.safety_qty)), '[]'::jsonb) from public.variant_stock st where st.variant_id = x.id)
      ) order by x.sku), '[]'::jsonb) from public.product_variants x where x.product_id = p.id));
end $$;

create function public.variant_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('variants.read');
  return (select coalesce(jsonb_agg(r order by r ->> 'code'), '[]'::jsonb) from (
    select jsonb_build_object('product_id', p.id, 'code', p.code, 'name', p.name, 'status', p.status, 'client_name', c.name,
      'variants', count(v.id), 'active', count(v.id) filter (where v.active),
      'colors', count(distinct v.color_id), 'sizes', count(distinct v.size_id),
      'on_hand', coalesce(sum((select sum(qty_on_hand) from public.variant_stock where variant_id = v.id)), 0),
      'reserved', coalesce(sum((select sum(qty_reserved) from public.variant_stock where variant_id = v.id)), 0),
      'out_of_stock', count(v.id) filter (where v.active and coalesce((select sum(qty_on_hand) from public.variant_stock where variant_id = v.id), 0) = 0),
      'low', count(v.id) filter (where v.active and coalesce((select bool_or(safety_qty > 0 and qty_on_hand - qty_reserved <= safety_qty) from public.variant_stock where variant_id = v.id), false)),
      'missing_barcode', count(v.id) filter (where v.active and v.barcode is null),
      'missing_price', count(v.id) filter (where v.active and v.price is null)) as r
    from public.product_master p join public.clients c on c.id = p.client_id left join public.product_variants v on v.product_id = p.id
    where p.company_id = v_co and p.status <> 'archived' group by p.id, c.name order by p.code limit 500) x);
end $$;

do $$
declare f text;
begin
  foreach f in array array['variants_seed_defaults()', 'variant_generate(uuid,uuid[],uuid[])', 'variant_sync_from_spec(uuid)', 'variant_bulk_update(uuid,jsonb)', 'variant_assign_barcodes(uuid)', 'variant_delete(uuid)',
                           'variant_stock_move(uuid,text,uuid,int,uuid,text,text)', 'variant_stock_reserve(uuid,uuid,int)', 'variant_stock_set_safety(uuid,uuid,int)', 'variant_matrix(uuid)', 'variant_overview()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.variants_flag(text) from public, anon, authenticated;


-- ===== 0016_subcontracting.sql =====
-- =====================================================================
-- 0016_subcontracting — Sous-traitance (broderie, sérigraphie, impression, lavage, finition…)
--  Workflow : Production → Envoi sous-traitant → Réception sous-traitant → Contrôle qualité → Stock.
--  Tables : subcontractors, subcontract_orders, subcontract_shipments (envois), subcontract_receipts (retours),
--           subcontract_costs (coûts : prestation, transport, autres).
--  Règles : les envois et réceptions ne se saisissent que par RPC (quantités cumulées contrôlées : reçu ≤ envoyé ≤ commandé) ;
--           le contrôle qualité ventile chaque retour en accepté / rejeté ; seul l'accepté entre en stock (variant_stock_move) ;
--           une commande ne se clôt qu'après contrôle et entrée en stock de tous les retours acceptés.
--  Coûts : réservés à subcontract.costs ou costs.read (jamais dans l'historique ni les listes).
--  Permissions nouvelles : subcontract.read / subcontract.write / subcontract.qc / subcontract.costs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('subcontract.read',  'suppliers', 'Voir la sous-traitance',                'Sous-traitants, envois, retours, performance, tableau de bord'),
  ('subcontract.write', 'suppliers', 'Gérer la sous-traitance',               'Sous-traitants, commandes, envois, réceptions'),
  ('subcontract.qc',    'suppliers', 'Contrôler les retours sous-traitant',   'Contrôle qualité des réceptions et entrée en stock'),
  ('subcontract.costs', 'suppliers', 'Voir et saisir les coûts de sous-traitance', 'Prix des prestations et frais de transport')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code like 'subcontract.%')
  or (r.code = 'production' and p.code in ('subcontract.read', 'subcontract.write', 'subcontract.qc'))
  or (r.code = 'qualite'    and p.code in ('subcontract.read', 'subcontract.qc'))
  or (r.code = 'achat'      and p.code in ('subcontract.read', 'subcontract.write', 'subcontract.costs'))
  or (r.code = 'finance'    and p.code in ('subcontract.read', 'subcontract.costs'))
  or (r.code = 'direction'  and p.code in ('subcontract.read', 'subcontract.costs'))
  or (r.code = 'magasin'    and p.code = 'subcontract.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.subcontractors (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  code             text not null,                                            -- SST-0001
  name             text not null check (length(btrim(name)) between 2 and 120),
  services         text[] not null check (cardinality(services) between 1 and 6
                     and services <@ array['embroidery','screen_printing','printing','washing','finishing','other']::text[]),
  country          char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  city             text check (city is null or length(city) <= 80),
  contact_name     text check (contact_name is null or length(contact_name) <= 120),
  email            text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text check (phone is null or length(phone) <= 40),
  default_lead_days int not null default 14 check (default_lead_days between 0 and 365),
  active           boolean not null default true,
  notes            text check (notes is null or length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  unique (company_id, code)
);
create unique index subcontractors_name_uq on public.subcontractors (company_id, lower(btrim(name)));

create table public.subcontract_orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  code             text not null,                                            -- SC-0001
  subcontractor_id uuid not null references public.subcontractors(id) on delete restrict,
  service          text not null check (service in ('embroidery','screen_printing','printing','washing','finishing','other')),
  product_id       uuid references public.product_master(id) on delete set null,
  description      text not null check (length(btrim(description)) between 2 and 300),
  qty              int not null check (qty > 0 and qty <= 1000000),
  qty_shipped      int not null default 0 check (qty_shipped >= 0),
  qty_received     int not null default 0 check (qty_received >= 0),
  qty_accepted     int not null default 0 check (qty_accepted >= 0),
  qty_rejected     int not null default 0 check (qty_rejected >= 0),
  status           text not null default 'draft' check (status in ('draft','sent','partially_received','received','closed','cancelled')),
  requested_on     date not null default current_date,
  sent_on          date,
  due_date         date,
  closed_at        timestamptz,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 300),
  notes            text check (notes is null or length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  unique (company_id, code),
  constraint sc_orders_due_ck check (due_date is null or due_date >= requested_on),
  constraint sc_orders_shipped_ck check (qty_shipped <= qty),
  constraint sc_orders_received_ck check (qty_received <= qty_shipped),
  constraint sc_orders_qc_ck check (qty_accepted + qty_rejected <= qty_received)
);
create index sc_orders_idx on public.subcontract_orders (company_id, status, due_date);
create index sc_orders_sub_idx on public.subcontract_orders (subcontractor_id, status);

create table public.subcontract_shipments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  order_id    uuid not null references public.subcontract_orders(id) on delete cascade,
  number      int not null check (number >= 1),
  qty         int not null check (qty > 0),
  shipped_on  date not null,
  carrier     text check (carrier is null or length(carrier) <= 80),
  tracking    text check (tracking is null or length(tracking) <= 80),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  unique (order_id, number)
);

create table public.subcontract_receipts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  order_id     uuid not null references public.subcontract_orders(id) on delete cascade,
  shipment_id  uuid references public.subcontract_shipments(id) on delete set null,
  number       int not null check (number >= 1),
  qty_received int not null check (qty_received > 0),
  received_on  date not null,
  qc_status    text not null default 'pending' check (qc_status in ('pending','accepted','partial','rejected')),
  qty_accepted int not null default 0 check (qty_accepted >= 0),
  qty_rejected int not null default 0 check (qty_rejected >= 0),
  qc_notes     text check (qc_notes is null or length(qc_notes) <= 500),
  qc_by        uuid,
  qc_at        timestamptz,
  variant_id   uuid references public.product_variants(id) on delete set null,
  warehouse_id uuid references public.warehouses(id) on delete set null,
  stock_posted boolean not null default false,
  stock_posted_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  unique (order_id, number),
  constraint sc_receipts_qc_ck check (
    (qc_status = 'pending' and qty_accepted = 0 and qty_rejected = 0 and qc_at is null)
    or (qc_status <> 'pending' and qty_accepted + qty_rejected = qty_received and qc_at is not null)),
  constraint sc_receipts_stock_ck check (not stock_posted or (qc_status <> 'pending' and variant_id is not null and warehouse_id is not null))
);
create index sc_receipts_order_idx on public.subcontract_receipts (order_id, received_on);

create table public.subcontract_costs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  order_id    uuid not null references public.subcontract_orders(id) on delete cascade,
  shipment_id uuid references public.subcontract_shipments(id) on delete cascade,
  kind        text not null default 'service' check (kind in ('service','shipping','other')),
  description text not null check (length(btrim(description)) between 1 and 200),
  quantity    numeric(12,3) not null default 1 check (quantity > 0 and quantity < 100000000),
  unit_cost   numeric(14,4) not null default 0 check (unit_cost >= 0 and unit_cost < 1000000000),
  amount      numeric(16,2) generated always as (round(quantity * unit_cost, 2)) stored,
  incurred_on date not null default current_date,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
-- une seule prestation facturée par commande (les frais de transport et autres sont libres)
create unique index sc_costs_one_service_uq on public.subcontract_costs (order_id) where kind = 'service';
create index sc_costs_order_idx on public.subcontract_costs (order_id);

-- ---------------------------------------------------------------------
-- 3. Outils internes
-- ---------------------------------------------------------------------
create function private.sc_flag() returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting('subcontract.rpc', true), 'off') = 'on' $$;
revoke execute on function private.sc_flag() from public, anon, authenticated;

create function private.sc_meta(p_company uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('company', (select name from public.companies where id = p_company)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.sc_meta(uuid, jsonb) from public, anon, authenticated;

-- Métriques par commande (fonction interne : les appelants contrôlent les droits ; les coûts ne sortent que si subcontract.costs)
create function private.sc_metrics(p_company uuid) returns table (
  order_id uuid, subcontractor_id uuid, service text, status text, product_id uuid, qty int, qty_received int, qty_accepted int, qty_rejected int,
  requested_on date, due_date date, sent_on date, closed_at timestamptz, last_received date, pending_qc int, unposted int,
  cost_service numeric, cost_shipping numeric, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.subcontractor_id, o.service, o.status, o.product_id, o.qty, o.qty_received, o.qty_accepted, o.qty_rejected,
    o.requested_on, o.due_date, o.sent_on, o.closed_at,
    (select max(r.received_on) from public.subcontract_receipts r where r.order_id = o.id),
    (select count(*)::int from public.subcontract_receipts r where r.order_id = o.id and r.qc_status = 'pending'),
    (select count(*)::int from public.subcontract_receipts r where r.order_id = o.id and r.qty_accepted > 0 and not r.stock_posted),
    coalesce((select sum(c.amount) from public.subcontract_costs c where c.order_id = o.id and c.kind = 'service'), 0)::numeric,
    coalesce((select sum(c.amount) from public.subcontract_costs c where c.order_id = o.id and c.kind <> 'service'), 0)::numeric,
    o.created_at
  from public.subcontract_orders o where o.company_id = p_company
$$;
revoke execute on function private.sc_metrics(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.subcontractors_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_co uuid;
begin
  if tg_op = 'INSERT' then
    v_co := private.current_company();
    if v_co is null then raise exception 'SC_NO_COMPANY' using errcode = '42501'; end if;
    new.company_id := v_co;
    new.code := 'SST-' || lpad(private.next_seq(v_co, 'subcontractor')::text, 4, '0');
    new.created_by := auth.uid();
  else
    if new.company_id is distinct from old.company_id or new.code is distinct from old.code then raise exception 'SC_REF_LOCKED' using errcode = '42501'; end if;
    if new.services is distinct from old.services and exists (
         select 1 from public.subcontract_orders o where o.subcontractor_id = new.id and o.status in ('draft','sent','partially_received','received')
           and not (o.service = any (new.services))) then
      raise exception 'SC_SERVICE_IN_USE' using errcode = '55000';         -- une prestation encore utilisée ne se retire pas
    end if;
    new.updated_at := now();
  end if;
  new.name := btrim(new.name);
  return new;
end $$;
create trigger subcontractors_before_iu before insert or update on public.subcontractors
  for each row execute function private.subcontractors_before();

create function private.subcontract_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s public.subcontractors%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into s from public.subcontractors where id = new.subcontractor_id;
    if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
    if not s.active then raise exception 'SC_SUBCONTRACTOR_INACTIVE' using errcode = '55000'; end if;
    if not (new.service = any (s.services)) then raise exception 'SC_SERVICE_NOT_OFFERED' using errcode = '22023'; end if;
    if new.product_id is not null and not exists (select 1 from public.product_master p where p.id = new.product_id and p.company_id = s.company_id) then
      raise exception 'SC_BAD_PRODUCT' using errcode = '22023';
    end if;
    if new.due_date is not null and new.due_date < new.requested_on then raise exception 'SC_DATE_ORDER' using errcode = '22023'; end if;
    new.company_id := s.company_id;
    new.code := 'SC-' || lpad(private.next_seq(s.company_id, 'subcontract')::text, 4, '0');
    new.status := 'draft'; new.qty_shipped := 0; new.qty_received := 0; new.qty_accepted := 0; new.qty_rejected := 0;
    new.sent_on := null; new.closed_at := null; new.cancel_reason := null;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
  else
    if not private.sc_flag() then
      if new.company_id is distinct from old.company_id or new.code is distinct from old.code or new.status is distinct from old.status
         or new.sent_on is distinct from old.sent_on or new.closed_at is distinct from old.closed_at or new.cancel_reason is distinct from old.cancel_reason
         or new.qty_shipped is distinct from old.qty_shipped or new.qty_received is distinct from old.qty_received
         or new.qty_accepted is distinct from old.qty_accepted or new.qty_rejected is distinct from old.qty_rejected then
        raise exception 'SC_REF_LOCKED' using errcode = '42501';
      end if;
      if old.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
      if old.status <> 'draft' and (new.subcontractor_id is distinct from old.subcontractor_id or new.service is distinct from old.service
           or new.product_id is distinct from old.product_id or new.qty is distinct from old.qty) then
        raise exception 'SC_ORDER_LOCKED' using errcode = '55000';          -- après envoi : seuls l'échéance et les notes bougent
      end if;
      if new.subcontractor_id is distinct from old.subcontractor_id then
        select * into s from public.subcontractors where id = new.subcontractor_id;
        if not found or not s.active or not (new.service = any (s.services)) then raise exception 'SC_SERVICE_NOT_OFFERED' using errcode = '22023'; end if;
      end if;
      if new.product_id is not null and new.product_id is distinct from old.product_id
         and not exists (select 1 from public.product_master p where p.id = new.product_id and p.company_id = old.company_id) then
        raise exception 'SC_BAD_PRODUCT' using errcode = '22023';
      end if;
      if new.due_date is not null and new.due_date < new.requested_on then raise exception 'SC_DATE_ORDER' using errcode = '22023'; end if;
      new.updated_at := now(); new.updated_by := auth.uid();
    else
      new.updated_at := now();
    end if;
  end if;
  new.description := btrim(new.description);
  return new;
end $$;
create trigger subcontract_orders_before_iu before insert or update on public.subcontract_orders
  for each row execute function private.subcontract_orders_before();

-- Envois et retours : uniquement via RPC (aucun droit d'écriture direct), la RPC pose le drapeau
create function private.subcontract_moves_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.sc_flag() then raise exception 'SC_RPC_ONLY' using errcode = '42501'; end if;
  return coalesce(new, old);
end $$;
create trigger subcontract_shipments_guard before insert or update or delete on public.subcontract_shipments
  for each row execute function private.subcontract_moves_guard();
create trigger subcontract_receipts_guard before insert or update or delete on public.subcontract_receipts
  for each row execute function private.subcontract_moves_guard();

create function private.subcontract_costs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into o from public.subcontract_orders where id = old.order_id;
    if o.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
    return old;
  end if;
  select * into o from public.subcontract_orders where id = new.order_id;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
  if new.shipment_id is not null and not exists (select 1 from public.subcontract_shipments s where s.id = new.shipment_id and s.order_id = new.order_id) then
    raise exception 'SC_BAD_SHIPMENT' using errcode = '22023';
  end if;
  new.company_id := o.company_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  return new;
end $$;
create trigger subcontract_costs_before_iud before insert or update or delete on public.subcontract_costs
  for each row execute function private.subcontract_costs_before();

-- ---------------------------------------------------------------------
-- 5. Historique (audit_logs : 'subcontractor' et 'subcontract' ; aucun montant dans l'historique)
-- ---------------------------------------------------------------------
create function private.audit_subcontractors() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'subcontractor.create', 'subcontractor', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'services', new.services), private.sc_meta(new.company_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name','services','country','city','contact_name','email','phone','default_lead_days','active','notes')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, case when v_chg -> 'after' ? 'active' then 'subcontractor.status' else 'subcontractor.update' end,
        'subcontractor', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', private.sc_meta(new.company_id));
    end if;
  end if;
  return new;
end $$;
create trigger audit_subcontractors_iu after insert or update on public.subcontractors
  for each row execute function private.audit_subcontractors();

create function private.audit_subcontract_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.sc_flag() then return new; end if;                  -- les RPC tracent elles-mêmes
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'subcontract.create', 'subcontract', new.id::text, new.code, null,
      jsonb_build_object('service', new.service, 'qty', new.qty, 'due_date', new.due_date), private.sc_meta(new.company_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('subcontractor_id','service','product_id','qty','description','requested_on','due_date','notes')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'subcontract.update', 'subcontract', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', private.sc_meta(new.company_id));
    end if;
  end if;
  return new;
end $$;
create trigger audit_subcontract_orders_iu after insert or update on public.subcontract_orders
  for each row execute function private.audit_subcontract_orders();

create function private.audit_subcontract_costs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.subcontract_costs%rowtype; v_code text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.subcontract_orders where id = r.order_id;
  perform private.write_audit(r.company_id, case tg_op when 'INSERT' then 'subcontract.cost_add' when 'UPDATE' then 'subcontract.cost_update' else 'subcontract.cost_delete' end,
    'subcontract', r.order_id::text, v_code, null, null, private.sc_meta(r.company_id, jsonb_build_object('kind', r.kind, 'description', r.description)));   -- sans montant
  return coalesce(new, old);
end $$;
create trigger audit_subcontract_costs_iud after insert or update or delete on public.subcontract_costs
  for each row execute function private.audit_subcontract_costs();

create policy audit_logs_select_subcontract on public.audit_logs for select to authenticated
  using (entity_type in ('subcontractor', 'subcontract') and company_id = private.current_company() and private.has_perm('subcontract.read'));

-- ---------------------------------------------------------------------
-- 6. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.subcontractors         enable row level security;
alter table public.subcontract_orders     enable row level security;
alter table public.subcontract_shipments  enable row level security;
alter table public.subcontract_receipts   enable row level security;
alter table public.subcontract_costs      enable row level security;

revoke all on public.subcontractors, public.subcontract_orders, public.subcontract_shipments, public.subcontract_receipts, public.subcontract_costs from anon, authenticated;
grant all on public.subcontractors, public.subcontract_orders, public.subcontract_shipments, public.subcontract_receipts, public.subcontract_costs to service_role;
grant select on public.subcontractors, public.subcontract_orders, public.subcontract_shipments, public.subcontract_receipts, public.subcontract_costs to authenticated;
grant insert (name, services, country, city, contact_name, email, phone, default_lead_days, active, notes) on public.subcontractors to authenticated;
grant update (name, services, country, city, contact_name, email, phone, default_lead_days, active, notes) on public.subcontractors to authenticated;
grant insert (subcontractor_id, service, product_id, description, qty, requested_on, due_date, notes) on public.subcontract_orders to authenticated;
grant update (subcontractor_id, service, product_id, description, qty, requested_on, due_date, notes) on public.subcontract_orders to authenticated;
grant insert (order_id, shipment_id, kind, description, quantity, unit_cost, incurred_on) on public.subcontract_costs to authenticated;
grant update (shipment_id, kind, description, quantity, unit_cost, incurred_on) on public.subcontract_costs to authenticated;
grant delete on public.subcontract_costs to authenticated;

create policy subcontractors_select on public.subcontractors for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
create policy subcontractors_insert on public.subcontractors for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));
create policy subcontractors_update on public.subcontractors for update to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.write'))
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));

create policy sc_orders_select on public.subcontract_orders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
create policy sc_orders_insert on public.subcontract_orders for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));
create policy sc_orders_update on public.subcontract_orders for update to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.write'))
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));

create policy sc_shipments_select on public.subcontract_shipments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
create policy sc_receipts_select on public.subcontract_receipts for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));

create policy sc_costs_select on public.subcontract_costs for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('subcontract.costs') or private.has_perm('costs.read')));
create policy sc_costs_insert on public.subcontract_costs for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('subcontract.costs'));
create policy sc_costs_update on public.subcontract_costs for update to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.costs'))
  with check (company_id = private.current_company() and private.has_perm('subcontract.costs'));
create policy sc_costs_delete on public.subcontract_costs for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.costs'));

-- ---------------------------------------------------------------------
-- 7. RPC : cycle de vie d'une commande, envois, réceptions, contrôle qualité, stock, clôture
-- ---------------------------------------------------------------------
create function private.sc_order_for_update(p_order uuid) returns public.subcontract_orders
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype;
begin
  select * into o from public.subcontract_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  return o;
end $$;
revoke execute on function private.sc_order_for_update(uuid) from public, anon, authenticated;

create function public.sc_order_send(p_order uuid, p_due date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status <> 'draft' then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if coalesce(p_due, o.due_date) is null then raise exception 'SC_DUE_REQUIRED' using errcode = '22023'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set status = 'sent', sent_on = current_date, due_date = coalesce(p_due, due_date), updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.send', 'subcontract', o.id::text, o.code, jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'sent'),
    private.sc_meta(o.company_id, jsonb_build_object('due_date', coalesce(p_due, o.due_date))), 'rpc');
end $$;

create function public.sc_order_cancel(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off'); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status not in ('draft', 'sent') or o.qty_shipped > 0 then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if v_reason is null or length(v_reason) < 3 then raise exception 'SC_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set status = 'cancelled', cancel_reason = v_reason, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.cancel', 'subcontract', o.id::text, o.code, jsonb_build_object('status', o.status), jsonb_build_object('status', 'cancelled'),
    private.sc_meta(o.company_id, jsonb_build_object('reason', v_reason)), 'rpc');
end $$;

create function public.sc_shipment_add(p_order uuid, p_qty int, p_shipped_on date, p_carrier text default null, p_tracking text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_id uuid := gen_random_uuid(); v_no int; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status not in ('sent', 'partially_received') then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SC_BAD_QTY' using errcode = '22023'; end if;
  if o.qty_shipped + p_qty > o.qty then raise exception 'SC_OVER_QTY' using errcode = '22023'; end if;
  select coalesce(max(number), 0) + 1 into v_no from public.subcontract_shipments where order_id = o.id;
  perform set_config('subcontract.rpc', 'on', true);
  insert into public.subcontract_shipments (id, company_id, order_id, number, qty, shipped_on, carrier, tracking, created_by)
    values (v_id, o.company_id, o.id, v_no, p_qty, coalesce(p_shipped_on, current_date), nullif(btrim(coalesce(p_carrier, '')), ''), nullif(btrim(coalesce(p_tracking, '')), ''), auth.uid());
  update public.subcontract_orders set qty_shipped = qty_shipped + p_qty, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.shipment', 'subcontract', o.id::text, o.code, null, jsonb_build_object('qty', p_qty, 'number', v_no),
    private.sc_meta(o.company_id, jsonb_build_object('shipment', v_no, 'tracking', nullif(btrim(coalesce(p_tracking, '')), ''))), 'rpc');
  return v_id;
end $$;

create function public.sc_receipt_add(p_order uuid, p_qty int, p_received_on date, p_shipment uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_id uuid := gen_random_uuid(); v_no int; v_new_status text; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status not in ('sent', 'partially_received') then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SC_BAD_QTY' using errcode = '22023'; end if;
  if p_shipment is not null and not exists (select 1 from public.subcontract_shipments s where s.id = p_shipment and s.order_id = o.id) then
    raise exception 'SC_BAD_SHIPMENT' using errcode = '22023';
  end if;
  if o.qty_received + p_qty > o.qty_shipped then raise exception 'SC_RECEIPT_EXCEEDS_SHIPMENT' using errcode = '22023'; end if;
  select coalesce(max(number), 0) + 1 into v_no from public.subcontract_receipts where order_id = o.id;
  v_new_status := case when o.qty_received + p_qty >= o.qty then 'received' else 'partially_received' end;
  perform set_config('subcontract.rpc', 'on', true);
  insert into public.subcontract_receipts (id, company_id, order_id, shipment_id, number, qty_received, received_on, created_by)
    values (v_id, o.company_id, o.id, p_shipment, v_no, p_qty, coalesce(p_received_on, current_date), auth.uid());
  update public.subcontract_orders set qty_received = qty_received + p_qty, status = v_new_status, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.receipt', 'subcontract', o.id::text, o.code, jsonb_build_object('status', o.status), jsonb_build_object('status', v_new_status),
    private.sc_meta(o.company_id, jsonb_build_object('receipt', v_no, 'qty', p_qty)), 'rpc');
  return v_id;
end $$;

create function public.sc_receipt_qc(p_receipt uuid, p_accepted int, p_rejected int, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.subcontract_receipts%rowtype; o public.subcontract_orders%rowtype; v_status text; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.qc');
  select * into r from public.subcontract_receipts where id = p_receipt and company_id = private.current_company() for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  o := private.sc_order_for_update(r.order_id);
  if r.qc_status <> 'pending' then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if p_accepted is null or p_rejected is null or p_accepted < 0 or p_rejected < 0 then raise exception 'SC_BAD_QTY' using errcode = '22023'; end if;
  if p_accepted + p_rejected <> r.qty_received then raise exception 'SC_QC_SUM' using errcode = '22023'; end if;
  v_status := case when p_rejected = 0 then 'accepted' when p_accepted = 0 then 'rejected' else 'partial' end;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_receipts set qc_status = v_status, qty_accepted = p_accepted, qty_rejected = p_rejected,
    qc_notes = nullif(btrim(coalesce(p_notes, '')), ''), qc_by = auth.uid(), qc_at = now() where id = r.id;
  update public.subcontract_orders set qty_accepted = qty_accepted + p_accepted, qty_rejected = qty_rejected + p_rejected, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.qc', 'subcontract', o.id::text, o.code, null, jsonb_build_object('accepted', p_accepted, 'rejected', p_rejected),
    private.sc_meta(o.company_id, jsonb_build_object('receipt', r.number, 'result', v_status, 'notes', nullif(btrim(coalesce(p_notes, '')), ''))), 'rpc');
end $$;

-- Entrée en stock de la part acceptée d'un retour (stock fini par variante, via le module Variantes)
create function public.sc_receipt_stock(p_receipt uuid, p_variant uuid, p_warehouse uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.subcontract_receipts%rowtype; o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.qc');
  select * into r from public.subcontract_receipts where id = p_receipt and company_id = private.current_company() for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  o := private.sc_order_for_update(r.order_id);
  if r.qc_status = 'pending' or r.qty_accepted = 0 or r.stock_posted then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.product_variants v where v.id = p_variant and v.product_id = o.product_id) then
    raise exception 'SC_BAD_VARIANT' using errcode = '22023';
  end if;
  perform public.variant_stock_move(p_variant, 'receipt', p_warehouse, r.qty_accepted, null, 'Retour sous-traitance ' || o.code, o.code || ' R' || r.number);
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_receipts set stock_posted = true, stock_posted_at = now(), variant_id = p_variant, warehouse_id = p_warehouse where id = r.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.stock', 'subcontract', o.id::text, o.code, null, jsonb_build_object('qty', r.qty_accepted),
    private.sc_meta(o.company_id, jsonb_build_object('receipt', r.number, 'variant', p_variant)), 'rpc');
end $$;

create function public.sc_order_close(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status <> 'received' then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.subcontract_receipts r where r.order_id = o.id and r.qc_status = 'pending') then raise exception 'SC_QC_PENDING' using errcode = '55000'; end if;
  if exists (select 1 from public.subcontract_receipts r where r.order_id = o.id and r.qty_accepted > 0 and not r.stock_posted) then raise exception 'SC_STOCK_PENDING' using errcode = '55000'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set status = 'closed', closed_at = now(), updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.close', 'subcontract', o.id::text, o.code, jsonb_build_object('status', 'received'), jsonb_build_object('status', 'closed'),
    private.sc_meta(o.company_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Tableau de bord et performance des sous-traitants
-- ---------------------------------------------------------------------
create function public.subcontract_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('subcontract.costs') or private.has_perm('costs.read'); v jsonb; v_kpi jsonb;
begin
  perform private.require_perm('subcontract.read');
  select jsonb_build_object(
    'orders', count(*) filter (where status <> 'cancelled'),
    'open', count(*) filter (where status in ('sent', 'partially_received', 'received')),
    'overdue', count(*) filter (where status in ('sent', 'partially_received') and due_date < current_date),
    'pending_qc', coalesce(sum(pending_qc), 0),
    'unposted', coalesce(sum(unposted), 0),
    'qty_in_progress', coalesce(sum(qty - qty_received) filter (where status in ('sent', 'partially_received')), 0),
    'on_time_rate', round(100.0 * count(*) filter (where status in ('received', 'closed') and last_received <= due_date)
                    / nullif(count(*) filter (where status in ('received', 'closed') and last_received is not null), 0), 1),
    'avg_lead_days', round(avg(coalesce(closed_at::date, last_received) - sent_on) filter (where sent_on is not null and last_received is not null and status in ('received', 'closed')), 1),
    'rejection_rate', round(100.0 * sum(qty_rejected) / nullif(sum(qty_accepted + qty_rejected), 0), 1),
    'qty_received', coalesce(sum(qty_received), 0),
    'qty_accepted', coalesce(sum(qty_accepted), 0),
    'cost_total', coalesce(sum(cost_service + cost_shipping), 0),
    'cost_per_piece', round((sum(cost_service + cost_shipping)) / nullif(sum(qty_accepted), 0), 3)
  ) into v_kpi from private.sc_metrics(v_co);
  if not v_costs then v_kpi := v_kpi - 'cost_total' - 'cost_per_piece'; end if;
  v := jsonb_build_object(
    'kpi', v_kpi,
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.subcontract_orders where company_id = v_co group by status) x),
    'by_service', (select coalesce(jsonb_agg(jsonb_build_object('service', x.svc, 'orders', x.orders, 'received', x.received) order by x.svc), '[]'::jsonb) from (
                    select sv.svc,
                      (select count(*) from public.subcontract_orders o where o.company_id = v_co and o.service = sv.svc and o.status <> 'cancelled') as orders,
                      (select coalesce(sum(o.qty_received), 0) from public.subcontract_orders o where o.company_id = v_co and o.service = sv.svc) as received
                    from unnest(array['embroidery','screen_printing','printing','washing','finishing','other']::text[]) as sv(svc)) x),
    'overdue', (select coalesce(jsonb_agg(x order by x ->> 'due_date'), '[]'::jsonb) from (
                  select jsonb_build_object('id', o.id, 'code', o.code, 'subcontractor', s.name, 'service', o.service, 'due_date', o.due_date,
                    'days', (current_date - o.due_date), 'qty', o.qty, 'received', o.qty_received) x
                  from public.subcontract_orders o join public.subcontractors s on s.id = o.subcontractor_id
                  where o.company_id = v_co and o.status in ('sent', 'partially_received') and o.due_date < current_date limit 10) y),
    'pending_qc', (select coalesce(jsonb_agg(x order by x ->> 'received_on'), '[]'::jsonb) from (
                  select jsonb_build_object('id', r.id, 'order_id', o.id, 'code', o.code, 'receipt', r.number, 'qty', r.qty_received, 'received_on', r.received_on) x
                  from public.subcontract_receipts r join public.subcontract_orders o on o.id = r.order_id
                  where r.company_id = v_co and r.qc_status = 'pending' limit 10) y),
    'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'orders', (select count(*) from public.subcontract_orders o where o.company_id = v_co and date_trunc('month', o.created_at) = m and o.status <> 'cancelled')) order by m), '[]'::jsonb)
                 from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m)
  );
  if v_costs then
    v := v || jsonb_build_object(
      'costs_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'amount', (select coalesce(sum(c.amount), 0) from public.subcontract_costs c where c.company_id = v_co and date_trunc('month', c.incurred_on::timestamp) = m)) order by m), '[]'::jsonb)
                         from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m),
      'top_subcontractors', (select coalesce(jsonb_agg(x order by (x ->> 'amount')::numeric desc), '[]'::jsonb) from (
                  select jsonb_build_object('name', s.name, 'amount', sum(m.cost_service + m.cost_shipping)) x
                  from private.sc_metrics(v_co) m join public.subcontractors s on s.id = m.subcontractor_id
                  group by s.name order by sum(m.cost_service + m.cost_shipping) desc limit 5) y));
  end if;
  return v;
end $$;

create function public.subcontractor_performance() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('subcontract.costs') or private.has_perm('costs.read'); v jsonb;
begin
  perform private.require_perm('subcontract.read');
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.name), '[]'::jsonb) into v from (
    select s.id, s.code, s.name, s.services, s.default_lead_days, s.active,
      count(m.order_id) filter (where m.status not in ('draft', 'cancelled')) as orders,
      coalesce(sum(m.qty_received), 0) as qty_received,
      count(*) filter (where m.status in ('received', 'closed') and m.last_received is not null and m.last_received <= m.due_date) as on_time,
      count(*) filter (where m.status in ('received', 'closed') and m.last_received is not null) as delivered,
      round(avg(coalesce(m.closed_at::date, m.last_received) - m.sent_on) filter (where m.sent_on is not null and m.last_received is not null and m.status in ('received', 'closed')), 1) as avg_lead_days,
      round(avg(greatest(m.last_received - m.due_date, 0)) filter (where m.due_date is not null and m.last_received is not null and m.status in ('received', 'closed')), 1) as avg_delay_days,
      round(100.0 * coalesce(sum(m.qty_rejected), 0) / nullif(coalesce(sum(m.qty_accepted + m.qty_rejected), 0), 0), 1) as rejection_rate,
      case when v_costs then round(coalesce(sum(m.cost_service + m.cost_shipping), 0), 2) end as cost_total,
      case when v_costs then round(sum(m.cost_service + m.cost_shipping) / nullif(sum(m.qty_accepted), 0), 3) end as cost_per_piece
    from public.subcontractors s
    left join private.sc_metrics(v_co) m on m.subcontractor_id = s.id
    where s.company_id = v_co
    group by s.id, s.code, s.name, s.services, s.default_lead_days, s.active
  ) x;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 9. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['sc_order_send(uuid,date)', 'sc_order_cancel(uuid,text)', 'sc_shipment_add(uuid,int,date,text,text)', 'sc_receipt_add(uuid,int,date,uuid)',
                           'sc_receipt_qc(uuid,int,int,text)', 'sc_receipt_stock(uuid,uuid,uuid)', 'sc_order_close(uuid)', 'subcontract_dashboard()', 'subcontractor_performance()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;


-- ===== 0017_warehouses.sql =====
-- =====================================================================
-- 0017_warehouses — Multi-entrepôts : entrepôts, zones, emplacements, responsables et accès par entrepôt
--  Étend l'existant (0009_stock) au lieu de le dupliquer :
--    warehouses           : + type d'entrepôt (tissus, fournitures, produits finis…)
--    warehouse_locations  : zones d'un entrepôt (zone de coupe, zone accessoires, quarantaine…)
--    stock_locations      : emplacements (allées, racks) ; chacun peut être rattaché à une zone (zone_id)
--    user_warehouses      : accès utilisateur par entrepôt, avec rôle viewer / operator / manager (responsable)
--  Règle d'accès (appliquée en base, quelle que soit l'interface) :
--    - lecture : entrepôts affectés (ou warehouses.all / warehouses.manage) — politiques RESTRICTIVES sur toutes les tables
--      portant un entrepôt (elles s'ajoutent aux politiques existantes : aucune fuite possible) ;
--    - écriture stock : rôle operator ou manager sur l'entrepôt — déclencheurs (y compris pour les RPC) ;
--    - emplacements et zones : rôle manager (ou warehouses.manage) ;
--    - entrepôts (création, suppression, modification) : warehouses.manage, ou manager de l'entrepôt pour la modification.
--  Accès refusé : erreur WAREHOUSE_FORBIDDEN (SQLSTATE 42501), tracée côté application.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('warehouses.manage', 'stock', 'Gérer les entrepôts et les accès', 'Créer et modifier les entrepôts, zones, emplacements et affectations de tous les entrepôts'),
  ('warehouses.all',    'stock', 'Voir tous les entrepôts',          'Lecture de tous les entrepôts de la société, sans affectation')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('warehouses.manage', 'warehouses.all'))
  or (r.code = 'direction' and p.code = 'warehouses.all'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Colonnes ajoutées
-- ---------------------------------------------------------------------
alter table public.warehouses add column kind text not null default 'mixed'
  check (kind in ('fabric', 'supplies', 'finished_goods', 'mixed', 'other'));
alter table public.stock_locations add column zone_id uuid;     -- clé étrangère ajoutée après la création de warehouse_locations

-- ---------------------------------------------------------------------
-- 3. Tables nouvelles : zones et accès utilisateurs
-- ---------------------------------------------------------------------
create table public.warehouse_locations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  warehouse_id uuid not null references public.warehouses(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name         text not null check (length(btrim(name)) between 2 and 80),
  zone_type    text not null default 'storage' check (zone_type in ('storage', 'reception', 'cutting', 'workshop', 'quarantine', 'shipping', 'other')),
  notes        text check (notes is null or length(notes) <= 300),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  updated_by   uuid,
  unique (warehouse_id, code)
);
alter table public.stock_locations add constraint stock_locations_zone_fk foreign key (zone_id) references public.warehouse_locations(id) on delete set null;

create table public.user_warehouses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  role         text not null default 'viewer' check (role in ('viewer', 'operator', 'manager')),
  active       boolean not null default true,
  granted_by   uuid,
  granted_at   timestamptz not null default now(),
  revoked_by   uuid,
  revoked_at   timestamptz,
  unique (user_id, warehouse_id),
  constraint user_warehouses_revoked_ck check (active or revoked_at is not null)
);
create index user_warehouses_wh_idx on public.user_warehouses (warehouse_id, active);

-- ---------------------------------------------------------------------
-- 4. Fonctions d'accès
-- ---------------------------------------------------------------------
-- viewer : entrepôt affecté (ou warehouses.all / warehouses.manage) ; operator : écriture stock ; manager : responsable
create function private.wh_can(p_wh uuid, p_level text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- La société est filtrée par les politiques de base (company_id = private.current_company()) : pas de test ici,
  -- sinon la ligne qui vient d'être insérée dans la même instruction ne serait pas visible.
  select p_wh is not null and (
          (p_level = 'viewer' and (private.has_perm('warehouses.all') or private.has_perm('warehouses.manage')
               or exists (select 1 from public.user_warehouses uw where uw.warehouse_id = p_wh and uw.user_id = auth.uid() and uw.active)))
       or (p_level = 'operator' and (private.has_perm('warehouses.manage')
               or exists (select 1 from public.user_warehouses uw where uw.warehouse_id = p_wh and uw.user_id = auth.uid() and uw.active and uw.role in ('operator', 'manager'))))
       or (p_level = 'manager' and (private.has_perm('warehouses.manage')
               or exists (select 1 from public.user_warehouses uw where uw.warehouse_id = p_wh and uw.user_id = auth.uid() and uw.active and uw.role = 'manager')))
     )
$$;
revoke execute on function private.wh_can(uuid, text) from public, anon;
grant execute on function private.wh_can(uuid, text) to authenticated, service_role;

-- Déclencheur générique : TG_ARGV[0] = colonne d'entrepôt, TG_ARGV[1] = niveau requis. Ignoré hors session utilisateur (traitements système).
create function private.wh_write_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_col text := TG_ARGV[0]; v_level text := coalesce(TG_ARGV[1], 'operator'); v_wh uuid;
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_wh := nullif(to_jsonb(old) ->> v_col, '')::uuid;
    if v_wh is not null and not private.wh_can(v_wh, v_level) then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_wh := nullif(to_jsonb(new) ->> v_col, '')::uuid;
    if v_wh is not null and not private.wh_can(v_wh, v_level) then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;

-- Entrepôts : création = warehouses.manage ; modification / suppression = warehouses.manage ou responsable de l'entrepôt
create function private.warehouses_access_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if not private.has_perm('warehouses.manage') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  elsif tg_op = 'UPDATE' then
    if not private.wh_can(old.id, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  else
    if not private.has_perm('warehouses.manage') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger warehouses_access_guard_iud before insert or update or delete on public.warehouses
  for each row execute function private.warehouses_access_guard();

-- Le créateur d'un entrepôt en devient responsable (déclenché avant la création de l'emplacement général, ordre alphabétique)
create function private.warehouses_access_i() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    insert into public.user_warehouses (company_id, user_id, warehouse_id, role, granted_by) values (new.company_id, auth.uid(), new.id, 'manager', auth.uid());
  end if;
  return new;
end $$;
create trigger warehouses_access_i after insert on public.warehouses
  for each row execute function private.warehouses_access_i();

-- Garde-fous sur les zones et emplacements
create function private.warehouse_locations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into w from public.warehouses where id = new.warehouse_id;
    if not found then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := w.company_id; new.created_by := auth.uid(); new.updated_by := auth.uid();
    if w.archived_at is not null then raise exception 'WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  else
    if new.warehouse_id is distinct from old.warehouse_id or new.company_id is distinct from old.company_id or new.code is distinct from old.code then
      raise exception 'WAREHOUSE_REF_LOCKED' using errcode = '42501';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.code := upper(btrim(new.code)); new.name := btrim(new.name);
  return new;
end $$;
create trigger warehouse_locations_before_iu before insert or update on public.warehouse_locations
  for each row execute function private.warehouse_locations_before();

create function private.stock_locations_zone_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.zone_id is not null and not exists (select 1 from public.warehouse_locations z where z.id = new.zone_id and z.warehouse_id = new.warehouse_id) then
    raise exception 'WAREHOUSE_ZONE_MISMATCH' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger stock_locations_zone_check_iu before insert or update on public.stock_locations
  for each row execute function private.stock_locations_zone_check();

-- ---------------------------------------------------------------------
-- 5. Traçabilité (audit_logs, entity_type = 'warehouse', id = entrepôt)
-- ---------------------------------------------------------------------
create function private.audit_warehouse_locations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb; v_wh_code text;
begin
  select code into v_wh_code from public.warehouses where id = new.warehouse_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'warehouse.zone_add', 'warehouse', new.warehouse_id::text, v_wh_code, null,
      jsonb_build_object('zone', new.code, 'name', new.name, 'type', new.zone_type));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name', 'zone_type', 'notes', 'archived_at')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, case when new.archived_at is not null and old.archived_at is null then 'warehouse.zone_archive' else 'warehouse.zone_update' end,
        'warehouse', new.warehouse_id::text, v_wh_code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('zone', new.code));
    end if;
  end if;
  return new;
end $$;
create trigger audit_warehouse_locations_iu after insert or update on public.warehouse_locations
  for each row execute function private.audit_warehouse_locations();

create function private.audit_stock_locations_wh() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb; v_wh_code text;
begin
  select code into v_wh_code from public.warehouses where id = new.warehouse_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'warehouse.location_add', 'warehouse', new.warehouse_id::text, v_wh_code, null,
      jsonb_build_object('location', new.code, 'name', new.name, 'kind', new.kind, 'zone_id', new.zone_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name', 'kind', 'zone_id', 'archived_at')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'warehouse.location_update', 'warehouse', new.warehouse_id::text, v_wh_code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('location', new.code));
    end if;
  end if;
  return new;
end $$;
create trigger audit_stock_locations_wh_iu after insert or update on public.stock_locations
  for each row execute function private.audit_stock_locations_wh();

-- ---------------------------------------------------------------------
-- 6. Garde d'écriture et lecture filtrée sur les tables portant un entrepôt.
--    Chaque table n'est traitée que si elle existe (les modules achats, variantes et sous-traitance
--    peuvent être absents d'une base de test partielle).
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
      ('stock_lots', 'warehouse_id', 'operator'), ('stock_reservations', 'warehouse_id', 'operator'), ('stock_thresholds', 'warehouse_id', 'operator'),
      ('stock_inventories', 'warehouse_id', 'operator'), ('stock_movements', 'warehouse_id', 'operator'), ('stock_movements', 'to_warehouse_id', 'operator'),
      ('stock_locations', 'warehouse_id', 'manager'), ('warehouse_locations', 'warehouse_id', 'manager'),
      ('purchase_receipts', 'warehouse_id', 'operator'), ('variant_stock', 'warehouse_id', 'operator'),
      ('variant_stock_moves', 'warehouse_id', 'operator'), ('subcontract_receipts', 'warehouse_id', 'operator')) v(t, c, l)
  loop
    if to_regclass('public.' || r.t) is not null then
      execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.wh_write_guard(%L, %L)',
        r.t || '_wh_guard_' || r.c, r.t, r.c, r.l);
    end if;
  end loop;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
      ('warehouses', 'private.wh_can(id, ''viewer'')'),
      ('warehouse_locations', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_locations', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_lots', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_reservations', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_thresholds', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_inventories', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_movements', 'private.wh_can(warehouse_id, ''viewer'') or (to_warehouse_id is not null and private.wh_can(to_warehouse_id, ''viewer''))'),
      ('purchase_receipts', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('variant_stock', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('variant_stock_moves', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('subcontract_receipts', 'warehouse_id is null or private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_inventory_lines', 'exists (select 1 from public.stock_inventories i where i.id = inventory_id and private.wh_can(i.warehouse_id, ''viewer''))'),
      ('stock_movement_allocations', 'exists (select 1 from public.stock_movements m where m.id = movement_id and (private.wh_can(m.warehouse_id, ''viewer'') or (m.to_warehouse_id is not null and private.wh_can(m.to_warehouse_id, ''viewer''))))'),
      ('stock_movement_costs', 'exists (select 1 from public.stock_movements m where m.id = movement_id and (private.wh_can(m.warehouse_id, ''viewer'') or (m.to_warehouse_id is not null and private.wh_can(m.to_warehouse_id, ''viewer''))))'),
      ('stock_lot_costs', 'exists (select 1 from public.stock_lots l where l.id = lot_id and private.wh_can(l.warehouse_id, ''viewer''))'),
      ('purchase_receipt_lines', 'exists (select 1 from public.purchase_receipts r where r.id = receipt_id and private.wh_can(r.warehouse_id, ''viewer''))')
    ) v(t, e)
  loop
    if to_regclass('public.' || r.t) is not null then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (%s)', r.t || '_wh_scope', r.t, r.e);
    end if;
  end loop;
end $$;

create policy user_warehouses_scope on public.user_warehouses as restrictive for select to authenticated
  using (user_id = auth.uid() or private.wh_can(warehouse_id, 'manager') or private.has_perm('warehouses.manage'));

-- Zones : écriture par responsable de l'entrepôt
alter table public.warehouse_locations enable row level security;
alter table public.user_warehouses enable row level security;
grant select, insert, update on public.warehouse_locations to authenticated;
grant select on public.user_warehouses to authenticated;
grant all on public.warehouse_locations, public.user_warehouses to service_role;
grant insert (warehouse_id, code, name, zone_type, notes) on public.warehouse_locations to authenticated;
grant update (name, zone_type, notes, archived_at) on public.warehouse_locations to authenticated;
grant insert (name, city, address, kind) on public.warehouses to authenticated;
grant update (name, city, address, kind) on public.warehouses to authenticated;
grant insert (warehouse_id, code, name, kind, zone_id) on public.stock_locations to authenticated;
grant update (name, kind, zone_id) on public.stock_locations to authenticated;

create policy warehouse_locations_select on public.warehouse_locations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
create policy warehouse_locations_insert on public.warehouse_locations for insert to authenticated
  with check (company_id = private.current_company() and private.wh_can(warehouse_id, 'manager'));
create policy warehouse_locations_update on public.warehouse_locations for update to authenticated
  using (company_id = private.current_company() and private.wh_can(warehouse_id, 'manager'))
  with check (company_id = private.current_company() and private.wh_can(warehouse_id, 'manager'));
create policy user_warehouses_select on public.user_warehouses for select to authenticated
  using (company_id = private.current_company());

-- ---------------------------------------------------------------------
-- 8. RPC : affectation et retrait des utilisateurs, accès de l'utilisateur courant
-- ---------------------------------------------------------------------
create function public.wh_assign_user(p_user uuid, p_warehouse uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype; v_co uuid := private.current_company(); v_target public.profiles%rowtype; v_email text;
begin
  if p_role not in ('viewer', 'operator', 'manager') then raise exception 'WAREHOUSE_BAD_ROLE' using errcode = '22023'; end if;
  if not private.wh_can(p_warehouse, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select * into w from public.warehouses where id = p_warehouse and company_id = v_co;
  if not found then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_target from public.profiles where id = p_user and company_id = v_co;
  if not found then raise exception 'WAREHOUSE_USER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.user_warehouses (company_id, user_id, warehouse_id, role, active, granted_by, granted_at, revoked_by, revoked_at)
    values (v_co, p_user, p_warehouse, p_role, true, auth.uid(), now(), null, null)
  on conflict (user_id, warehouse_id) do update set role = excluded.role, active = true, granted_by = auth.uid(), granted_at = now(), revoked_by = null, revoked_at = null;
  perform private.write_audit(v_co, 'warehouse.access_grant', 'warehouse', w.id::text, w.code, null,
    jsonb_build_object('user', v_target.full_name, 'email', v_target.email, 'role', p_role), jsonb_build_object('warehouse', w.name), 'rpc');
end $$;

create function public.wh_revoke_user(p_user uuid, p_warehouse uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype; uw public.user_warehouses%rowtype; v_co uuid := private.current_company(); v_target public.profiles%rowtype;
begin
  if not private.wh_can(p_warehouse, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select * into w from public.warehouses where id = p_warehouse and company_id = v_co;
  if not found then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into uw from public.user_warehouses where user_id = p_user and warehouse_id = p_warehouse and company_id = v_co and active for update;
  if not found then raise exception 'WAREHOUSE_ACCESS_NOT_FOUND' using errcode = 'P0002'; end if;
  if uw.role = 'manager' and not private.has_perm('warehouses.manage') and (select count(*) from public.user_warehouses x where x.warehouse_id = p_warehouse and x.active and x.role = 'manager') <= 1 then
    raise exception 'WAREHOUSE_LAST_MANAGER' using errcode = '55000';          -- un entrepôt garde au moins un responsable
  end if;
  update public.user_warehouses set active = false, revoked_by = auth.uid(), revoked_at = now() where id = uw.id;
  select * into v_target from public.profiles where id = p_user;
  perform private.write_audit(v_co, 'warehouse.access_revoke', 'warehouse', w.id::text, w.code, jsonb_build_object('user', v_target.full_name, 'role', uw.role), null,
    jsonb_build_object('email', v_target.email), 'rpc');
end $$;

create function public.wh_my_access() returns table (warehouse_id uuid, code text, name text, kind text, role text)
language sql stable security definer set search_path = '' as $$
  select w.id, w.code, w.name, w.kind,
         coalesce((select uw.role from public.user_warehouses uw where uw.warehouse_id = w.id and uw.user_id = auth.uid() and uw.active),
                  case when private.has_perm('warehouses.manage') then 'manager' else 'viewer' end)
  from public.warehouses w
  where w.company_id = private.current_company() and private.wh_can(w.id, 'viewer')
  order by w.name
$$;

do $$
declare f text;
begin
  foreach f in array array['wh_assign_user(uuid,uuid,text)', 'wh_revoke_user(uuid,uuid)', 'wh_my_access()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Reprise de l'existant : chaque utilisateur déjà habilité sur le stock reçoit les entrepôts de la société
--    (responsable pour le magasinier, opérateur pour qui écrit, lecteur pour qui lit)
-- ---------------------------------------------------------------------
insert into public.user_warehouses (company_id, user_id, warehouse_id, role, granted_at)
select distinct p.company_id, p.id, w.id,
  case when exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p.id and r.code = 'magasin') then 'manager'
       when exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id join public.permissions pm on pm.id = rp.permission_id
                    where ur.user_id = p.id and pm.code = 'stock.write') then 'operator'
       else 'viewer' end,
  now()
from public.profiles p join public.warehouses w on w.company_id = p.company_id
where exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id join public.permissions pm on pm.id = rp.permission_id
              where ur.user_id = p.id and pm.code in ('stock.read', 'stock.write'))
on conflict (user_id, warehouse_id) do nothing;


-- ===== 0018_stock_movements.sql =====
-- =====================================================================
-- 0018_stock_movements — Mouvements de stock : types métier, numérotation, journal, annulation contrôlée, validation hiérarchique
--  Étend l'existant (0009_stock) au lieu de le dupliquer :
--    stock_movements      : + numéro automatique (MVT-AAAA-000001), type métier (kind), lien vers la demande,
--                           réversion (reversal_of), demandeur et validateur. Reste IMMUABLE (journal).
--    stock_reservations   : + numéro automatique (RES-000001).
--    stock_movement_requests (nouvelle) : demande de mouvement en attente de validation. Un mouvement n'atteint le stock
--                           qu'au moment de sa validation finale ; c'est elle qui produit la ligne de journal.
--    stock_movement_policies (nouvelle) : seuils et règles de validation par type de mouvement.
--  Types métier : entree_achat, sortie_production, retour_production, ajustement, transfert,
--                 retour_fournisseur, rebut, sous_traitance, annulation.
--  Moteur : private.stock_apply (0009) ; aucune écriture de stock hors de ce moteur.
--  Validation hiérarchique :
--    - niveau 0 : pas de validation (mouvement courant sous seuil) → posté immédiatement ;
--    - niveau 1 : validation par stock.approve ;
--    - niveau 2 : validation en second par stock.approve_high (la personne doit être distincte du niveau 1) ;
--    - le demandeur ne valide jamais sa propre demande (STOCK_SELF_APPROVAL).
--  Annulation : une réversion est une demande de type « annulation » (motif obligatoire) ; elle suit la même validation.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('stock.approve',      'stock', 'Valider les mouvements de stock (niveau 1)',   'Valider ou refuser une demande de mouvement, premier niveau'),
  ('stock.approve_high', 'stock', 'Valider les mouvements sensibles (niveau 2)',  'Valider en second niveau les mouvements au-dessus du seuil de valeur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('stock.approve', 'stock.approve_high'))
  or (r.code = 'direction' and p.code in ('stock.approve', 'stock.approve_high'))
  or (r.code = 'magasin'   and p.code = 'stock.approve'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Numérotation : séquences et numéros sur les mouvements et réservations
-- ---------------------------------------------------------------------
-- Les numéros des mouvements existants sont attribués une fois (le journal est immuable : déclencheur désactivé
-- uniquement le temps de cette reprise, exécutée par le propriétaire du schéma).
alter table public.stock_movements add column number text,
  add column kind text,
  add column request_id uuid,
  add column reversal_of uuid references public.stock_movements(id),
  add column requested_by uuid,
  add column approved_by uuid;

alter table public.stock_movements disable trigger stock_movements_immutable;
insert into public.company_sequences (company_id, key, last_value)
select company_id, 'stock_movement', count(*) from public.stock_movements group by company_id
on conflict (company_id, key) do update set last_value = excluded.last_value;
update public.stock_movements m
   set number = 'MVT-' || to_char(m.created_at, 'YYYY') || '-' || lpad(n.rn::text, 6, '0'),
       kind = case m.type when 'in' then 'entree_achat' when 'out' then 'sortie_production' when 'transfer' then 'transfert'
                          when 'adjustment' then 'ajustement' when 'inventory' then 'inventaire' end
  from (select id, row_number() over (partition by company_id order by created_at, seq) rn from public.stock_movements) n
 where n.id = m.id and m.number is null;
alter table public.stock_movements enable trigger stock_movements_immutable;

alter table public.stock_movements
  add constraint stock_movements_kind_check check (kind in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement',
    'transfert', 'retour_fournisseur', 'rebut', 'sous_traitance', 'annulation', 'inventaire'));
create unique index stock_movements_number_uidx on public.stock_movements (company_id, number);
create index stock_movements_reversal_idx on public.stock_movements (reversal_of) where reversal_of is not null;
create index stock_movements_request_idx on public.stock_movements (request_id) where request_id is not null;

create function private.stock_movement_meta() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ctx jsonb := coalesce(nullif(current_setting('stock.movement_ctx', true), '')::jsonb, '{}'::jsonb);
begin
  -- le contexte (type métier, demande, réversion, validateur) est posé par les fonctions de validation, pour la seule transaction
  new.kind := coalesce(new.kind, nullif(v_ctx->>'kind', ''), case new.type when 'in' then 'entree_achat' when 'out' then 'sortie_production'
    when 'transfer' then 'transfert' when 'adjustment' then 'ajustement' when 'inventory' then 'inventaire' end);
  new.request_id := coalesce(new.request_id, nullif(v_ctx->>'request_id', '')::uuid);
  new.reversal_of := coalesce(new.reversal_of, nullif(v_ctx->>'reversal_of', '')::uuid);
  new.requested_by := coalesce(new.requested_by, nullif(v_ctx->>'requested_by', '')::uuid);
  new.approved_by := coalesce(new.approved_by, nullif(v_ctx->>'approved_by', '')::uuid);
  if new.number is null then
    new.number := 'MVT-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, 'stock_movement')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.stock_movement_meta() from public, anon, authenticated;
create trigger stock_movements_meta_i before insert on public.stock_movements for each row execute function private.stock_movement_meta();

alter table public.stock_reservations add column number text;
insert into public.company_sequences (company_id, key, last_value)
select company_id, 'stock_reservation', count(*) from public.stock_reservations group by company_id
on conflict (company_id, key) do update set last_value = excluded.last_value;
update public.stock_reservations r set number = 'RES-' || lpad(n.rn::text, 6, '0')
  from (select id, row_number() over (partition by company_id order by created_at) rn from public.stock_reservations) n
 where n.id = r.id and r.number is null;
create unique index stock_reservations_number_uidx on public.stock_reservations (company_id, number);

create function private.stock_reservation_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := 'RES-' || lpad(private.next_seq(new.company_id, 'stock_reservation')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.stock_reservation_number() from public, anon, authenticated;
create trigger stock_reservations_number_i before insert on public.stock_reservations for each row execute function private.stock_reservation_number();

-- ---------------------------------------------------------------------
-- 3. Règles de validation par type de mouvement
-- ---------------------------------------------------------------------
create table public.stock_movement_policies (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  kind              text not null check (kind in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement', 'transfert',
                      'retour_fournisseur', 'rebut', 'sous_traitance', 'annulation')),
  requires_approval boolean not null default false,
  level1_threshold  numeric(14,2) check (level1_threshold is null or level1_threshold >= 0),
  level2_threshold  numeric(14,2) check (level2_threshold is null or level2_threshold >= 0),
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  unique (company_id, kind),
  check (level1_threshold is null or level2_threshold is null or level2_threshold >= level1_threshold)
);
alter table public.stock_movement_policies enable row level security;
create policy stock_movement_policies_select on public.stock_movement_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
revoke all on public.stock_movement_policies from anon, authenticated;
grant select on public.stock_movement_policies to authenticated;

-- Niveau requis : 0 = aucun, 1 = validation simple, 2 = validation en second niveau.
-- Par défaut : ajustement, rebut, retour fournisseur et annulation exigent une validation ; tout mouvement
-- dont la valeur atteint 1 000 exige une validation de niveau 1 ; 10 000 exige le niveau 2.
create function private.stock_approval_level(p_kind text, p_value numeric) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.stock_movement_policies%rowtype;
  v_req boolean; v_l1 numeric; v_l2 numeric;
begin
  select * into p from public.stock_movement_policies where company_id = v_co and kind = p_kind;
  v_req := case when found then p.requires_approval else p_kind in ('ajustement', 'rebut', 'retour_fournisseur', 'annulation') end;
  v_l1 := case when found then p.level1_threshold else 1000 end;
  v_l2 := case when found then p.level2_threshold else 10000 end;
  if not v_req and (v_l1 is null or p_value < v_l1) then return 0; end if;
  if v_l2 is not null and p_value >= v_l2 then return 2; end if;
  return 1;
end $$;
revoke execute on function private.stock_approval_level(text, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Demandes de mouvement (validation hiérarchique)
-- ---------------------------------------------------------------------
create table public.stock_movement_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  number          text not null,
  kind            text not null check (kind in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement', 'transfert',
                    'retour_fournisseur', 'rebut', 'sous_traitance', 'annulation')),
  status          text not null default 'pending' check (status in ('pending', 'posted', 'rejected', 'cancelled')),
  engine_type     text not null check (engine_type in ('in', 'out', 'transfer', 'adjustment')),
  engine_dir      text not null check (engine_dir in ('in', 'out', 'move')),
  material_id     uuid not null references public.bom_materials(id),
  qty             numeric(14,4) not null check (qty > 0),
  warehouse_id    uuid not null references public.warehouses(id),
  location_id     uuid references public.stock_locations(id),
  to_warehouse_id uuid references public.warehouses(id),
  to_location_id  uuid references public.stock_locations(id),
  unit_cost       numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  value           numeric(14,2) not null default 0 check (value >= 0),
  reference       text check (reference is null or length(reference) <= 120),
  reason          text check (reason is null or length(reason) <= 300),
  reversal_of     uuid references public.stock_movements(id),
  approval_level  int not null check (approval_level in (0, 1, 2)),
  requested_by    uuid not null default auth.uid(),
  requested_at    timestamptz not null default clock_timestamp(),
  level1_by       uuid,
  level1_at       timestamptz,
  level2_by       uuid,
  level2_at       timestamptz,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(decision_note) <= 300),
  movement_id     uuid references public.stock_movements(id),
  unique (company_id, number),
  check ((kind = 'annulation') = (reversal_of is not null)),
  check (kind = 'ajustement' or engine_type <> 'adjustment'),
  check (kind <> 'transfert' or (to_warehouse_id is not null and to_location_id is not null)),
  check (status <> 'posted' or movement_id is not null),
  check (approval_level > 0 or status in ('posted', 'pending'))
);
-- une annulation active ou appliquée par mouvement : pas de double réversion
create unique index stock_requests_reversal_uidx on public.stock_movement_requests (reversal_of)
  where reversal_of is not null and status in ('pending', 'posted');
create index stock_requests_status_idx on public.stock_movement_requests (company_id, status, requested_at desc);

alter table public.stock_movement_requests enable row level security;
create policy stock_movement_requests_select on public.stock_movement_requests for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
-- lecture restreinte aux entrepôts accessibles (0017)
create policy stock_movement_requests_wh_scope on public.stock_movement_requests as restrictive for select to authenticated
  using (private.wh_can(warehouse_id, 'viewer'));
revoke all on public.stock_movement_requests from anon, authenticated;
grant select on public.stock_movement_requests to authenticated;
-- écriture uniquement par les fonctions ci-dessous (contrôles de droits, d'entrepôt et de hiérarchie)
create trigger stock_requests_wh_guard_w before insert or update or delete on public.stock_movement_requests
  for each row execute function private.wh_write_guard('warehouse_id', 'operator');
create trigger stock_requests_wh_guard_t before insert or update or delete on public.stock_movement_requests
  for each row execute function private.wh_write_guard('to_warehouse_id', 'operator');

-- Journal : vue des mouvements avec leur numéro, leur type métier et leurs références.
create view public.stock_journal with (security_invoker = true) as
select m.id, m.number, m.created_at, m.kind, m.type, m.direction, m.qty, m.material_id,
       b.code as material_code, b.name as material_name,
       m.warehouse_id, w.code as warehouse_code, m.location_id,
       m.to_warehouse_id, m.to_location_id, m.reference, m.reason,
       m.reversal_of, m.request_id, m.requested_by, m.approved_by, m.created_by
  from public.stock_movements m
  join public.bom_materials b on b.id = m.material_id
  join public.warehouses w on w.id = m.warehouse_id;
grant select on public.stock_journal to authenticated;

-- ---------------------------------------------------------------------
-- 5. Posting d'une demande (moteur stock_apply) — interne
-- ---------------------------------------------------------------------
create function private.stock_request_post(p_req uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype; v_mov uuid;
begin
  select * into r from public.stock_movement_requests where id = p_req for update;
  perform set_config('stock.movement_ctx', jsonb_build_object(
    'kind', r.kind, 'request_id', r.id, 'reversal_of', r.reversal_of, 'requested_by', r.requested_by,
    'approved_by', coalesce(r.level2_by, r.level1_by))::text, true);
  v_mov := private.stock_apply(r.engine_type, r.engine_dir, r.material_id, r.qty, r.warehouse_id, r.location_id,
    case when r.engine_dir = 'move' then r.to_location_id end, r.reference, r.reason, r.unit_cost, null, null);
  perform set_config('stock.movement_ctx', '', true);
  update public.stock_movement_requests set status = 'posted', movement_id = v_mov, decided_by = coalesce(auth.uid(), r.requested_by),
    decided_at = now() where id = p_req;
  return v_mov;
end $$;
revoke execute on function private.stock_request_post(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Fonctions publiques
-- ---------------------------------------------------------------------
-- Demande de mouvement. Posté immédiatement si la règle ne demande aucune validation.
create function public.stock_request_create(p_kind text, p_material uuid, p_qty numeric, p_warehouse uuid, p_location uuid default null,
  p_to_warehouse uuid default null, p_to_location uuid default null, p_unit_cost numeric default null,
  p_reference text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_num text; v_etype text; v_edir text;
  v_qty numeric := abs(p_qty); v_value numeric; v_level int; v_mov uuid; v_status text;
begin
  if p_kind not in ('entree_achat', 'sortie_production', 'retour_production', 'ajustement', 'transfert', 'retour_fournisseur', 'rebut', 'sous_traitance') then
    raise exception 'STOCK_BAD_KIND' using errcode = '22023';
  end if;
  if p_kind = 'ajustement' then perform private.require_perm('stock.adjust'); else perform private.require_perm('stock.write'); end if;
  if p_qty is null or p_qty = 0 or (p_kind <> 'ajustement' and p_qty < 0) then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  p_reason := nullif(btrim(coalesce(p_reason, '')), ''); p_reference := nullif(btrim(coalesce(p_reference, '')), '');
  if p_kind in ('ajustement', 'rebut', 'retour_fournisseur') and length(coalesce(p_reason, '')) < 3 then
    raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_kind = 'transfert' and (p_to_warehouse is null or p_to_location is null) then
    raise exception 'STOCK_DESTINATION_REQUIRED' using errcode = '22023';
  end if;
  if p_kind = 'transfert' and p_location is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
  if p_kind in ('entree_achat', 'retour_production') and p_location is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;

  if p_kind in ('entree_achat', 'retour_production') then v_etype := 'in'; v_edir := 'in';
  elsif p_kind = 'transfert' then v_etype := 'transfer'; v_edir := 'move';
  elsif p_kind = 'ajustement' then v_etype := 'adjustment'; v_edir := case when p_qty > 0 then 'in' else 'out' end;
  else v_etype := 'out'; v_edir := 'out';
  end if;
  v_value := v_qty * coalesce(p_unit_cost, 0);
  v_level := private.stock_approval_level(p_kind, v_value);
  v_num := 'DEM-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'stock_request')::text, 6, '0');

  insert into public.stock_movement_requests (id, company_id, number, kind, status, engine_type, engine_dir, material_id, qty, warehouse_id,
    location_id, to_warehouse_id, to_location_id, unit_cost, value, reference, reason, approval_level, requested_by)
  values (v_id, v_co, v_num, p_kind, 'pending', v_etype, v_edir, p_material, v_qty, p_warehouse,
    p_location, case when p_kind = 'transfert' then p_to_warehouse end, case when p_kind = 'transfert' then p_to_location end,
    p_unit_cost, v_value, p_reference, p_reason, v_level, auth.uid());
  perform private.write_audit(v_co, 'stock.request_create', 'stock_request', v_id::text, v_num, null,
    jsonb_build_object('kind', p_kind, 'qty', p_qty, 'value', v_value, 'approval_level', v_level), '{}'::jsonb, 'rpc');

  if v_level = 0 then v_mov := private.stock_request_post(v_id); v_status := 'posted';
  else v_status := 'pending';
  end if;
  return jsonb_build_object('id', v_id, 'number', v_num, 'status', v_status, 'movement_id', v_mov, 'approval_level', v_level);
end $$;

-- Validation : niveau 1 (stock.approve) puis niveau 2 (stock.approve_high) si requis. Le demandeur ne valide jamais.
create function public.stock_request_approve(p_request uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype; v_mov uuid; v_step int;
begin
  select * into r from public.stock_movement_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_REQUEST' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'STOCK_REQUEST_CLOSED' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'STOCK_SELF_APPROVAL' using errcode = '42501'; end if;

  if r.level1_at is null then
    perform private.require_perm('stock.approve');
    v_step := 1;
    update public.stock_movement_requests set level1_by = auth.uid(), level1_at = now() where id = p_request;
  else
    perform private.require_perm('stock.approve_high');
    if r.level1_by = auth.uid() then raise exception 'STOCK_HIERARCHY' using errcode = '42501'; end if;
    v_step := 2;
    update public.stock_movement_requests set level2_by = auth.uid(), level2_at = now() where id = p_request;
  end if;

  if v_step = r.approval_level or v_step = 2 then
    v_mov := private.stock_request_post(p_request);
  end if;
  perform private.write_audit(r.company_id, 'stock.request_approve', 'stock_request', r.id::text, r.number, null,
    jsonb_build_object('step', v_step, 'posted', v_mov is not null, 'movement_id', v_mov), jsonb_build_object('note', p_note), 'rpc');
  return jsonb_build_object('step', v_step, 'status', case when v_mov is not null then 'posted' else 'pending' end, 'movement_id', v_mov);
end $$;

create function public.stock_request_reject(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if length(v_reason) < 3 then raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into r from public.stock_movement_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_REQUEST' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'STOCK_REQUEST_CLOSED' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'STOCK_SELF_APPROVAL' using errcode = '42501'; end if;
  if r.level1_at is null then perform private.require_perm('stock.approve'); else perform private.require_perm('stock.approve_high'); end if;
  update public.stock_movement_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = v_reason where id = p_request;
  perform private.write_audit(r.company_id, 'stock.request_reject', 'stock_request', r.id::text, r.number, null,
    jsonb_build_object('reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

-- Retrait d'une demande en attente : par son auteur, ou par un validateur de niveau 2.
create function public.stock_request_cancel(p_request uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stock_movement_requests%rowtype;
begin
  select * into r from public.stock_movement_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_REQUEST' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'STOCK_REQUEST_CLOSED' using errcode = '55000'; end if;
  if r.requested_by is distinct from auth.uid() then perform private.require_perm('stock.approve_high'); end if;
  update public.stock_movement_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
    decision_note = nullif(btrim(coalesce(p_reason, '')), '') where id = p_request;
  perform private.write_audit(r.company_id, 'stock.request_cancel', 'stock_request', r.id::text, r.number, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Annulation contrôlée : crée une réversion (demande « annulation ») du mouvement d'origine.
create function public.stock_cancel_movement(p_movement uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.stock_movements%rowtype; v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
  v_num text; v_etype text; v_edir text; v_wh uuid; v_loc uuid; v_twh uuid; v_tloc uuid; v_qty numeric; v_unit numeric; v_total numeric;
  v_value numeric; v_level int; v_mov uuid; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('stock.write');
  if length(v_reason) < 5 then raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into m from public.stock_movements where id = p_movement and company_id = v_co;
  if not found then raise exception 'STOCK_BAD_MOVEMENT' using errcode = 'P0002'; end if;
  if m.inventory_id is not null or m.kind in ('annulation', 'inventaire') or m.reversal_of is not null then
    raise exception 'STOCK_CANCEL_FORBIDDEN' using errcode = '42501';
  end if;
  if exists (select 1 from public.stock_movement_requests where reversal_of = m.id and status in ('pending', 'posted')) then
    raise exception 'STOCK_ALREADY_CANCELLED' using errcode = '55000';
  end if;

  v_qty := m.qty;
  select total_cost into v_total from public.stock_movement_costs where movement_id = m.id;
  v_unit := case when m.qty > 0 then v_total / m.qty end;
  case m.type
    when 'in' then
      v_etype := 'out'; v_edir := 'out'; v_wh := m.warehouse_id; v_loc := m.location_id;
    when 'out' then
      if m.location_id is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
      v_etype := 'in'; v_edir := 'in'; v_wh := m.warehouse_id; v_loc := m.location_id;
    when 'transfer' then
      if m.location_id is null or m.to_location_id is null then raise exception 'STOCK_CANCEL_FORBIDDEN' using errcode = '42501'; end if;
      v_etype := 'transfer'; v_edir := 'move'; v_wh := m.to_warehouse_id; v_loc := m.to_location_id;
      v_twh := m.warehouse_id; v_tloc := m.location_id;
    when 'adjustment' then
      v_etype := 'adjustment'; v_edir := case when m.direction = 'in' then 'out' else 'in' end; v_wh := m.warehouse_id; v_loc := m.location_id;
    else raise exception 'STOCK_CANCEL_FORBIDDEN' using errcode = '42501';
  end case;

  v_value := v_qty * coalesce(v_unit, 0);
  v_level := private.stock_approval_level('annulation', v_value);
  v_num := 'DEM-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'stock_request')::text, 6, '0');
  insert into public.stock_movement_requests (id, company_id, number, kind, status, engine_type, engine_dir, material_id, qty, warehouse_id,
    location_id, to_warehouse_id, to_location_id, unit_cost, value, reference, reason, reversal_of, approval_level, requested_by)
  values (v_id, v_co, v_num, 'annulation', 'pending', v_etype, v_edir, m.material_id, v_qty, v_wh,
    v_loc, v_twh, v_tloc, v_unit, v_value, m.number, v_reason, m.id, v_level, auth.uid());
  perform private.write_audit(v_co, 'stock.movement_cancel_request', 'stock_movement', m.id::text, m.number, null,
    jsonb_build_object('request', v_num, 'approval_level', v_level), jsonb_build_object('reason', v_reason), 'rpc');

  if v_level = 0 then v_mov := private.stock_request_post(v_id); end if;
  return jsonb_build_object('id', v_id, 'number', v_num, 'status', case when v_level = 0 then 'posted' else 'pending' end,
    'movement_id', v_mov, 'approval_level', v_level);
end $$;

-- Règles de validation (niveau 2 requis pour les modifier).
create function public.stock_policy_set(p_kind text, p_requires_approval boolean, p_level1 numeric, p_level2 numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('stock.approve_high');
  insert into public.stock_movement_policies (company_id, kind, requires_approval, level1_threshold, level2_threshold, updated_by)
  values (v_co, p_kind, coalesce(p_requires_approval, false), p_level1, p_level2, auth.uid())
  on conflict (company_id, kind) do update set requires_approval = excluded.requires_approval, level1_threshold = excluded.level1_threshold,
    level2_threshold = excluded.level2_threshold, updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'stock.policy_set', 'stock_policy', p_kind, p_kind, null,
    jsonb_build_object('requires_approval', p_requires_approval, 'level1', p_level1, 'level2', p_level2), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Droits d'exécution
-- ---------------------------------------------------------------------
revoke execute on function public.stock_request_create(text, uuid, numeric, uuid, uuid, uuid, uuid, numeric, text, text) from public, anon;
revoke execute on function public.stock_request_approve(uuid, text) from public, anon;
revoke execute on function public.stock_request_reject(uuid, text) from public, anon;
revoke execute on function public.stock_request_cancel(uuid, text) from public, anon;
revoke execute on function public.stock_cancel_movement(uuid, text) from public, anon;
revoke execute on function public.stock_policy_set(text, boolean, numeric, numeric) from public, anon;
grant execute on function public.stock_request_create(text, uuid, numeric, uuid, uuid, uuid, uuid, numeric, text, text) to authenticated;
grant execute on function public.stock_request_approve(uuid, text) to authenticated;
grant execute on function public.stock_request_reject(uuid, text) to authenticated;
grant execute on function public.stock_request_cancel(uuid, text) to authenticated;
grant execute on function public.stock_cancel_movement(uuid, text) to authenticated;
grant execute on function public.stock_policy_set(text, boolean, numeric, numeric) to authenticated;


-- ===== 0019_production.sql =====
-- =====================================================================
-- 0019_production — Production : ordres de fabrication, planification, lancement, suivi, clôture
--  Tables :
--    work_centers       : postes de travail (couture, coupe, finition…) : heures par jour, rendement de référence
--    production_orders  : ordres de fabrication (article, quantité, temps standard, poste, dates, statut)
--    production_logs    : saisies de suivi (date, heures, quantité bonne, rebut) — journal IMMUABLE
--  Statuts : planned (Planifié), launched (Lancé), in_progress (En cours), suspended (Suspendu), done (Terminé).
--  Clôture : closed_at (ordre terminé et verrouillé, plus de saisie).
--  Calculs (vue production_order_metrics et fonction production_dashboard) :
--    charge atelier : heures planifiées ouvertes ÷ (heures par jour × rendement du poste) = jours de charge ;
--    rendement      : quantité bonne ÷ (bonne + rebut) ;
--    productivité   : quantité bonne par heure travaillée ;
--    retards        : ordre ouvert dont la date de fin est dépassée, ou terminé après sa date de fin.
--  Écritures : uniquement par les fonctions ci-dessous (droits production.read / write / plan).
--  Hors périmètre : consommation de matières par stock (les flux de stock restent ceux du module Stock).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (les codes existent en 0003 ; attribution par rôle)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('production.read', 'production.write', 'production.plan'))
  or (r.code = 'direction'  and p.code = 'production.read')
  or (r.code = 'production' and p.code in ('production.read', 'production.write', 'production.plan')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Postes de travail
-- ---------------------------------------------------------------------
create table public.work_centers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name            text not null check (length(btrim(name)) between 2 and 120),
  kind            text not null default 'other' check (kind in ('coupe', 'couture', 'finition', 'repassage', 'controle', 'other')),
  hours_per_day   numeric(5,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  efficiency_pct  numeric(5,2) not null default 85 check (efficiency_pct > 0 and efficiency_pct <= 150),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  unique (company_id, code)
);
alter table public.work_centers enable row level security;
create policy work_centers_select on public.work_centers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy work_centers_write on public.work_centers for all to authenticated
  using (company_id = private.current_company() and private.has_perm('production.plan'))
  with check (company_id = private.current_company() and private.has_perm('production.plan'));
revoke all on public.work_centers from anon, authenticated;
grant select, insert, update on public.work_centers to authenticated;

-- ---------------------------------------------------------------------
-- 3. Ordres de fabrication
-- ---------------------------------------------------------------------
create table public.production_orders (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  number             text not null,
  article_id         uuid not null references public.articles(id),
  sales_order_id     uuid references public.sales_orders(id),
  work_center_id     uuid references public.work_centers(id),
  qty_planned        numeric(12,2) not null check (qty_planned > 0),
  std_minutes_per_unit numeric(10,2) not null check (std_minutes_per_unit > 0),
  planned_start      date not null,
  planned_end        date not null,
  status             text not null default 'planned' check (status in ('planned', 'launched', 'in_progress', 'suspended', 'done')),
  notes              text check (notes is null or length(notes) <= 1000),
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid(),
  launched_at        timestamptz,
  launched_by        uuid,
  suspended_at       timestamptz,
  suspend_reason     text check (suspend_reason is null or length(suspend_reason) <= 300),
  finished_at        timestamptz,
  finished_by        uuid,
  closed_at          timestamptz,
  closed_by          uuid,
  unique (company_id, number),
  check (planned_end >= planned_start),
  check (status = 'planned' or (launched_at is not null and work_center_id is not null)),
  check (status <> 'done' or finished_at is not null),
  check (closed_at is null or (status = 'done' and finished_at is not null))
);
create index production_orders_status_idx on public.production_orders (company_id, status, planned_end);

alter table public.production_orders enable row level security;
create policy production_orders_select on public.production_orders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
revoke all on public.production_orders from anon, authenticated;
grant select on public.production_orders to authenticated;

-- ---------------------------------------------------------------------
-- 4. Suivi de production (journal immuable)
-- ---------------------------------------------------------------------
create table public.production_logs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  order_id      uuid not null references public.production_orders(id),
  work_center_id uuid not null references public.work_centers(id),
  log_date      date not null,
  hours         numeric(6,2) not null check (hours > 0 and hours <= 24),
  qty_good      numeric(12,2) not null default 0 check (qty_good >= 0),
  qty_scrap     numeric(12,2) not null default 0 check (qty_scrap >= 0),
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (qty_good + qty_scrap > 0)
);
create index production_logs_order_idx on public.production_logs (order_id, log_date);

create function private.production_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'PRODUCTION_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.production_immutable() from public, anon, authenticated;
create trigger production_logs_immutable before update or delete on public.production_logs
  for each row execute function private.production_immutable();

alter table public.production_logs enable row level security;
create policy production_logs_select on public.production_logs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
revoke all on public.production_logs from anon, authenticated;
grant select on public.production_logs to authenticated;

-- ---------------------------------------------------------------------
-- 5. Numérotation et garde-fous des données
-- ---------------------------------------------------------------------
create function private.production_order_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := 'OF-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, 'production_order')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.production_order_number() from public, anon, authenticated;
create trigger production_orders_number_i before insert on public.production_orders
  for each row execute function private.production_order_number();

-- L'article doit appartenir à la société et l'ordre rattaché à une commande client de la même société.
create function private.production_orders_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.articles a where a.id = new.article_id and a.company_id = new.company_id) then
    raise exception 'PRODUCTION_ARTICLE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.work_center_id is not null and not exists (select 1 from public.work_centers w where w.id = new.work_center_id and w.company_id = new.company_id and w.active) then
    raise exception 'PRODUCTION_WORK_CENTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.production_orders_check() from public, anon, authenticated;
create trigger production_orders_check_i before insert or update on public.production_orders
  for each row execute function private.production_orders_check();

-- ---------------------------------------------------------------------
-- 6. Calculs par ordre (vue)
-- ---------------------------------------------------------------------
create view public.production_order_metrics with (security_invoker = true) as
with logs as (
  select order_id, sum(hours) hours, sum(qty_good) good, sum(qty_scrap) scrap, max(log_date) last_log
  from public.production_logs group by order_id
)
select o.id, o.company_id, o.number, o.status, o.article_id, a.internal_ref as article_ref, a.name as article_name,
       o.work_center_id, w.code as work_center_code, w.name as work_center_name, w.hours_per_day, w.efficiency_pct,
       o.qty_planned, o.std_minutes_per_unit, o.planned_start, o.planned_end, o.launched_at, o.finished_at, o.closed_at, o.sales_order_id,
       round(o.qty_planned * o.std_minutes_per_unit / 60, 2) as planned_hours,
       coalesce(l.hours, 0) as hours_worked,
       coalesce(l.good, 0) as qty_good,
       coalesce(l.scrap, 0) as qty_scrap,
       case when coalesce(l.good, 0) + coalesce(l.scrap, 0) = 0 then null
            else round(100 * l.good / (l.good + l.scrap), 1) end as yield_pct,
       case when coalesce(l.hours, 0) = 0 then null else round(l.good / l.hours, 2) end as productivity,
       case
         when o.status <> 'done' and o.planned_end < current_date then current_date - o.planned_end
         when o.status = 'done' and o.finished_at::date > o.planned_end then o.finished_at::date - o.planned_end
         else 0 end as late_days
  from public.production_orders o
  join public.articles a on a.id = o.article_id
  left join public.work_centers w on w.id = o.work_center_id
  left join logs l on l.order_id = o.id;
grant select on public.production_order_metrics to authenticated;

-- ---------------------------------------------------------------------
-- 7. Fonctions de planification et de suivi
-- ---------------------------------------------------------------------
create function private.production_audit(p_order public.production_orders, p_action text, p_after jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(p_order.company_id, p_action, 'production_order', p_order.id::text, p_order.number, null, p_after, '{}'::jsonb, 'rpc');
end $$;
revoke execute on function private.production_audit(public.production_orders, text, jsonb) from public, anon, authenticated;

create function private.production_lock(p_order uuid) returns public.production_orders
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  select * into o from public.production_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  return o;
end $$;
revoke execute on function private.production_lock(uuid) from public, anon, authenticated;

-- Créer un ordre (Planifié).
create function public.production_order_create(p_article uuid, p_qty numeric, p_std_minutes numeric, p_work_center uuid,
  p_start date, p_end date, p_sales_order uuid default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  insert into public.production_orders (id, company_id, article_id, sales_order_id, work_center_id, qty_planned, std_minutes_per_unit,
    planned_start, planned_end, notes)
  values (v_id, private.current_company(), p_article, p_sales_order, p_work_center, p_qty, p_std_minutes, p_start, p_end,
    nullif(btrim(coalesce(p_notes, '')), ''))
  returning * into o;
  perform private.production_audit(o, 'production.order_create', jsonb_build_object('qty', p_qty, 'start', p_start, 'end', p_end));
  return v_id;
end $$;

-- Replanifier (uniquement avant lancement).
create function public.production_order_reschedule(p_order uuid, p_work_center uuid, p_start date, p_end date, p_qty numeric, p_std_minutes numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  o := private.production_lock(p_order);
  if o.status <> 'planned' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set work_center_id = p_work_center, planned_start = p_start, planned_end = p_end,
    qty_planned = p_qty, std_minutes_per_unit = p_std_minutes where id = p_order;
  perform private.production_audit(o, 'production.order_reschedule', jsonb_build_object('start', p_start, 'end', p_end, 'qty', p_qty, 'work_center', p_work_center));
end $$;

-- Lancer : planifié → lancé (poste et dates requis).
create function public.production_order_launch(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  o := private.production_lock(p_order);
  if o.status <> 'planned' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  if o.work_center_id is null then raise exception 'PRODUCTION_WORK_CENTER_REQUIRED' using errcode = '22023'; end if;
  update public.production_orders set status = 'launched', launched_at = now(), launched_by = auth.uid() where id = p_order;
  perform private.production_audit(o, 'production.order_launch', jsonb_build_object('status', 'launched'));
end $$;

-- Saisie de suivi : bascule automatiquement lancé → en cours. Refusée si suspendu, terminé ou clôturé.
create function public.production_order_log(p_order uuid, p_date date, p_hours numeric, p_good numeric, p_scrap numeric, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_done numeric;
begin
  perform private.require_perm('production.write');
  o := private.production_lock(p_order);
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  if p_date < o.planned_start - 30 or p_date > current_date then raise exception 'PRODUCTION_BAD_DATE' using errcode = '22023'; end if;
  if coalesce(p_good, 0) + coalesce(p_scrap, 0) <= 0 then raise exception 'PRODUCTION_BAD_QTY' using errcode = '22023'; end if;
  select coalesce(sum(qty_good + qty_scrap), 0) into v_done from public.production_logs where order_id = p_order;
  if v_done + p_good + p_scrap > o.qty_planned then raise exception 'PRODUCTION_QTY_EXCEEDED' using errcode = '22023'; end if;
  insert into public.production_logs (company_id, order_id, work_center_id, log_date, hours, qty_good, qty_scrap, note)
  values (o.company_id, p_order, o.work_center_id, p_date, p_hours, p_good, p_scrap, nullif(btrim(coalesce(p_note, '')), ''));
  if o.status = 'launched' then update public.production_orders set status = 'in_progress' where id = p_order; end if;
end $$;

-- Suspendre (motif obligatoire) puis reprendre.
create function public.production_order_suspend(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('production.write');
  if length(v_reason) < 3 then raise exception 'PRODUCTION_REASON_REQUIRED' using errcode = '22023'; end if;
  o := private.production_lock(p_order);
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set status = 'suspended', suspended_at = now(), suspend_reason = v_reason where id = p_order;
  perform private.production_audit(o, 'production.order_suspend', jsonb_build_object('reason', v_reason));
end $$;

create function public.production_order_resume(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_logs int;
begin
  perform private.require_perm('production.write');
  o := private.production_lock(p_order);
  if o.status <> 'suspended' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_logs from public.production_logs where order_id = p_order;
  update public.production_orders set status = case when v_logs > 0 then 'in_progress' else 'launched' end where id = p_order;
  perform private.production_audit(o, 'production.order_resume', '{}'::jsonb);
end $$;

-- Terminer : au moins une saisie de suivi requise.
create function public.production_order_finish(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_logs int;
begin
  perform private.require_perm('production.write');
  o := private.production_lock(p_order);
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_logs from public.production_logs where order_id = p_order;
  if v_logs = 0 then raise exception 'PRODUCTION_NO_LOG' using errcode = '55000'; end if;
  update public.production_orders set status = 'done', finished_at = now(), finished_by = auth.uid() where id = p_order;
  perform private.production_audit(o, 'production.order_finish', jsonb_build_object('status', 'done'));
end $$;

-- Clôturer : ordre terminé, verrouillé (plus de saisie ni de replanification).
create function public.production_order_close(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  o := private.production_lock(p_order);
  if o.status <> 'done' or o.closed_at is not null then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set closed_at = now(), closed_by = auth.uid() where id = p_order;
  perform private.production_audit(o, 'production.order_close', jsonb_build_object('closed', true));
end $$;

-- Saisie interdite après clôture (contrôle en plus de la vérification de statut).
revoke execute on function public.production_order_create(uuid, numeric, numeric, uuid, date, date, uuid, text) from public, anon;
revoke execute on function public.production_order_reschedule(uuid, uuid, date, date, numeric, numeric) from public, anon;
revoke execute on function public.production_order_launch(uuid) from public, anon;
revoke execute on function public.production_order_log(uuid, date, numeric, numeric, numeric, text) from public, anon;
revoke execute on function public.production_order_suspend(uuid, text) from public, anon;
revoke execute on function public.production_order_resume(uuid) from public, anon;
revoke execute on function public.production_order_finish(uuid) from public, anon;
revoke execute on function public.production_order_close(uuid) from public, anon;
grant execute on function public.production_order_create(uuid, numeric, numeric, uuid, date, date, uuid, text) to authenticated;
grant execute on function public.production_order_reschedule(uuid, uuid, date, date, numeric, numeric) to authenticated;
grant execute on function public.production_order_launch(uuid) to authenticated;
grant execute on function public.production_order_log(uuid, date, numeric, numeric, numeric, text) to authenticated;
grant execute on function public.production_order_suspend(uuid, text) to authenticated;
grant execute on function public.production_order_resume(uuid) to authenticated;
grant execute on function public.production_order_finish(uuid) to authenticated;
grant execute on function public.production_order_close(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Tableau de bord : statuts, charge atelier, rendement, productivité, retards
-- ---------------------------------------------------------------------
create function public.production_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  perform private.require_perm('production.read');
  with m as (select * from public.production_order_metrics where company_id = v_co),
  wc as (
    select w.id, w.code, w.name, w.hours_per_day, w.efficiency_pct,
      coalesce(sum(m.planned_hours) filter (where m.status <> 'done' and m.closed_at is null), 0) as open_hours,
      coalesce(sum(m.hours_worked), 0) as hours_worked,
      coalesce(sum(m.qty_good), 0) as good, coalesce(sum(m.qty_scrap), 0) as scrap
    from public.work_centers w left join m on m.work_center_id = w.id
    where w.company_id = v_co and w.active
    group by w.id
  )
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(s, c), '{}'::jsonb) from (
        select status s, count(*) c from m where closed_at is null group by status) x),
    'open', (select count(*) from m where closed_at is null and status <> 'done'),
    'closed', (select count(*) from m where closed_at is not null),
    'late', (select count(*) from m where closed_at is null and late_days > 0),
    'yield_pct', (select case when sum(qty_good + qty_scrap) = 0 then null else round(100 * sum(qty_good) / sum(qty_good + qty_scrap), 1) end from m),
    'productivity', (select case when sum(hours_worked) = 0 then null else round(sum(qty_good) / sum(hours_worked), 2) end from m),
    'workload', (select coalesce(jsonb_agg(jsonb_build_object(
        'work_center_id', id, 'code', code, 'name', name, 'open_hours', round(open_hours, 2),
        'capacity_hours_per_day', round(hours_per_day * efficiency_pct / 100, 2),
        'load_days', round(open_hours / nullif(hours_per_day * efficiency_pct / 100, 0), 1),
        'overloaded', open_hours / nullif(hours_per_day * efficiency_pct / 100, 0) > 20,
        'yield_pct', case when good + scrap = 0 then null else round(100 * good / (good + scrap), 1) end,
        'productivity', case when hours_worked = 0 then null else round(good / hours_worked, 2) end
      ) order by code), '[]'::jsonb) from wc),
    'late_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'article', article_name,
        'planned_end', planned_end, 'late_days', late_days, 'status', status, 'work_center', work_center_code)
        order by late_days desc), '[]'::jsonb)
        from (select * from m where closed_at is null and late_days > 0 order by late_days desc limit 20) l)
  ) into r;
  return r;
end $$;
revoke execute on function public.production_dashboard() from public, anon;
grant execute on function public.production_dashboard() to authenticated;


-- ===== 0020_quality.sql =====
-- =====================================================================
-- 0020_quality — Qualité : contrôles réception / production / final, défauts, non-conformités,
--                  actions correctives, plans d'actions, indicateurs et historique des défauts
--  Tables :
--    quality_defect_codes        : référentiel des défauts (code, libellé, famille, gravité par défaut)
--    quality_inspections         : contrôles (réception, production, final) : échantillon, décision, quantités
--    quality_defects             : défauts constatés par contrôle — IMMUABLE (historique)
--    quality_nonconformities     : non-conformités (ouvertes automatiquement sur un contrôle rejeté, ou à la main)
--    quality_action_plans        : plans d'actions regroupant des actions correctives
--    quality_corrective_actions  : actions correctives et préventives, avec vérification d'efficacité
--  Règles de décision (quality_inspection_decide) :
--    - un défaut critique impose le rejet ;
--    - un défaut majeur interdit l'acceptation pleine (acceptation conditionnelle ou rejet) ;
--    - rejet : toute la quantité échantillonnée est rebutée, et une non-conformité est ouverte ;
--    - acceptation conditionnelle : rebut estimé = nombre de défauts, plafonné à l'échantillon.
--  Clôture d'une non-conformité : contenue, toutes ses actions vérifiées efficaces (ou annulées),
--    et au moins une action vérifiée, sinon une justification écrite de 10 caractères minimum.
--  Droits : quality.read (voir), quality.write (saisir, ouvrir, constater, proposer), quality.approve (décider, clôturer, vérifier).
--  Hors périmètre : blocage automatique des lots de stock et des réceptions (le module Stock reste inchangé).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (codes existants en 0003)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('quality.read', 'quality.write', 'quality.approve'))
  or (r.code = 'qualite'   and p.code in ('quality.read', 'quality.write', 'quality.approve'))
  or (r.code = 'direction' and p.code = 'quality.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Référentiel des défauts
-- ---------------------------------------------------------------------
create table public.quality_defect_codes (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code             text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  label            text not null check (length(btrim(label)) between 2 and 120),
  category         text not null default 'autre' check (category in ('matiere', 'coupe', 'couture', 'finition', 'dimension', 'etiquetage', 'autre')),
  default_severity text not null default 'minor' check (default_severity in ('minor', 'major', 'critical')),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (company_id, code)
);
alter table public.quality_defect_codes enable row level security;
create policy quality_defect_codes_select on public.quality_defect_codes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_defect_codes from anon, authenticated;
grant select on public.quality_defect_codes to authenticated;

-- ---------------------------------------------------------------------
-- 3. Contrôles
-- ---------------------------------------------------------------------
create table public.quality_inspections (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number              text not null,
  kind                text not null check (kind in ('reception', 'production', 'final')),
  status              text not null default 'open' check (status in ('open', 'closed')),
  decision            text check (decision is null or decision in ('accepted', 'conditional', 'rejected')),
  material_id         uuid references public.bom_materials(id),
  article_id          uuid references public.articles(id),
  production_order_id uuid references public.production_orders(id),
  purchase_receipt_id uuid references public.purchase_receipts(id),
  receipt_ref         text check (receipt_ref is null or length(receipt_ref) <= 60),
  sample_size         numeric(12,2) not null check (sample_size > 0),
  qty_accepted        numeric(12,2) not null default 0 check (qty_accepted >= 0),
  qty_rejected        numeric(12,2) not null default 0 check (qty_rejected >= 0),
  note                text check (note is null or length(note) <= 500),
  opened_at           timestamptz not null default now(),
  opened_by           uuid default auth.uid(),
  closed_at           timestamptz,
  closed_by           uuid,
  unique (company_id, number),
  check (kind <> 'reception' or material_id is not null),
  check (kind <> 'production' or production_order_id is not null),
  check (kind <> 'final' or article_id is not null or production_order_id is not null),
  check ((status = 'open' and decision is null and closed_at is null)
      or (status = 'closed' and decision is not null and closed_at is not null)),
  check (qty_accepted + qty_rejected <= sample_size)
);
create index quality_inspections_status_idx on public.quality_inspections (company_id, status, opened_at desc);

-- Les sources référencées doivent appartenir à la même société.
create function private.quality_inspections_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.material_id is not null and not exists (select 1 from public.bom_materials m where m.id = new.material_id and m.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.article_id is not null and not exists (select 1 from public.articles a where a.id = new.article_id and a.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.production_order_id is not null and not exists (select 1 from public.production_orders o where o.id = new.production_order_id and o.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.purchase_receipt_id is not null and not exists (select 1 from public.purchase_receipts r where r.id = new.purchase_receipt_id and r.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.quality_inspections_check() from public, anon, authenticated;
create trigger quality_inspections_check_iu before insert or update on public.quality_inspections
  for each row execute function private.quality_inspections_check();

alter table public.quality_inspections enable row level security;
create policy quality_inspections_select on public.quality_inspections for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_inspections from anon, authenticated;
grant select on public.quality_inspections to authenticated;

-- ---------------------------------------------------------------------
-- 4. Défauts constatés (historique immuable)
-- ---------------------------------------------------------------------
create table public.quality_defects (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  inspection_id uuid not null references public.quality_inspections(id),
  defect_code   text not null,
  category      text not null,
  severity      text not null check (severity in ('minor', 'major', 'critical')),
  qty           numeric(12,2) not null check (qty > 0),
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index quality_defects_inspection_idx on public.quality_defects (inspection_id);
create index quality_defects_code_idx on public.quality_defects (company_id, defect_code);

create function private.quality_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'QUALITY_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.quality_immutable() from public, anon, authenticated;
create trigger quality_defects_immutable before update or delete on public.quality_defects
  for each row execute function private.quality_immutable();

alter table public.quality_defects enable row level security;
create policy quality_defects_select on public.quality_defects for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_defects from anon, authenticated;
grant select on public.quality_defects to authenticated;

-- ---------------------------------------------------------------------
-- 5. Plans d'actions, non-conformités, actions correctives
-- ---------------------------------------------------------------------
create table public.quality_action_plans (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number      text not null,
  title       text not null check (length(btrim(title)) between 3 and 160),
  objective   text check (objective is null or length(objective) <= 500),
  owner_id    uuid,
  start_date  date not null,
  target_date date not null,
  status      text not null default 'draft' check (status in ('draft', 'active', 'closed')),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  closed_at   timestamptz,
  unique (company_id, number),
  check (target_date >= start_date),
  check ((status = 'closed') = (closed_at is not null))
);
alter table public.quality_action_plans enable row level security;
create policy quality_action_plans_select on public.quality_action_plans for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_action_plans from anon, authenticated;
grant select on public.quality_action_plans to authenticated;

create table public.quality_nonconformities (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  title         text not null check (length(btrim(title)) between 3 and 160),
  description   text check (description is null or length(description) <= 1000),
  severity      text not null check (severity in ('minor', 'major', 'critical')),
  status        text not null default 'open' check (status in ('open', 'contained', 'closed')),
  inspection_id uuid references public.quality_inspections(id),
  containment   text check (containment is null or length(containment) <= 500),
  root_cause    text check (root_cause is null or length(root_cause) <= 500),
  owner_id      uuid,
  due_date      date,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  closed_at     timestamptz,
  closed_by     uuid,
  close_note    text check (close_note is null or length(close_note) <= 500),
  unique (company_id, number),
  check ((status = 'closed') = (closed_at is not null)),
  check (status = 'open' or containment is not null)
);
create index quality_nc_status_idx on public.quality_nonconformities (company_id, status);
alter table public.quality_nonconformities enable row level security;
create policy quality_nonconformities_select on public.quality_nonconformities for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_nonconformities from anon, authenticated;
grant select on public.quality_nonconformities to authenticated;

create table public.quality_corrective_actions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  nc_id         uuid not null references public.quality_nonconformities(id),
  plan_id       uuid references public.quality_action_plans(id),
  kind          text not null default 'corrective' check (kind in ('corrective', 'preventive')),
  action        text not null check (length(btrim(action)) between 3 and 500),
  owner_id      uuid,
  due_date      date not null,
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'verified', 'cancelled')),
  done_at       timestamptz,
  verified_at   timestamptz,
  verified_by   uuid,
  effective     boolean,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (company_id, number),
  check (status <> 'done' or done_at is not null),
  check (status <> 'verified' or (effective is not null and verified_at is not null)),
  check (status <> 'cancelled' or cancel_reason is not null)
);
create index quality_ca_nc_idx on public.quality_corrective_actions (nc_id);
alter table public.quality_corrective_actions enable row level security;
create policy quality_corrective_actions_select on public.quality_corrective_actions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_corrective_actions from anon, authenticated;
grant select on public.quality_corrective_actions to authenticated;

-- Numérotation par société (préfixe et clé de séquence passés en argument du déclencheur).
create function private.quality_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := TG_ARGV[0] || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, TG_ARGV[1])::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.quality_number() from public, anon, authenticated;
create trigger quality_inspections_number_i before insert on public.quality_inspections for each row execute function private.quality_number('QC-', 'quality_inspection');
create trigger quality_nc_number_i before insert on public.quality_nonconformities for each row execute function private.quality_number('NC-', 'quality_nc');
create trigger quality_plans_number_i before insert on public.quality_action_plans for each row execute function private.quality_number('PA-', 'quality_plan');
create trigger quality_ca_number_i before insert on public.quality_corrective_actions for each row execute function private.quality_number('CA-', 'quality_ca');

-- ---------------------------------------------------------------------
-- 6. Historique des défauts (vue)
-- ---------------------------------------------------------------------
create view public.quality_defect_history with (security_invoker = true) as
select d.id, d.created_at as occurred_at, d.company_id, i.number as inspection_number, i.kind, i.decision,
       d.defect_code, c.label as defect_label, d.category, d.severity, d.qty, d.note,
       i.id as inspection_id, i.material_id, i.article_id, i.production_order_id, d.created_by
  from public.quality_defects d
  join public.quality_inspections i on i.id = d.inspection_id
  left join public.quality_defect_codes c on c.company_id = d.company_id and c.code = d.defect_code;
grant select on public.quality_defect_history to authenticated;

-- ---------------------------------------------------------------------
-- 7. Fonctions : référentiel, contrôles, décision
-- ---------------------------------------------------------------------
create function private.quality_lock_inspection(p_id uuid) returns public.quality_inspections
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype;
begin
  select * into i from public.quality_inspections where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  return i;
end $$;
revoke execute on function private.quality_lock_inspection(uuid) from public, anon, authenticated;

create function public.quality_defect_code_save(p_code text, p_label text, p_category text, p_severity text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_defect_codes (code, label, category, default_severity)
  values (upper(btrim(p_code)), btrim(p_label), p_category, p_severity)
  on conflict (company_id, code) do update set label = excluded.label, category = excluded.category,
    default_severity = excluded.default_severity, active = true
  returning id into v_id;
  perform private.write_audit(private.current_company(), 'quality.defect_code_save', 'quality_defect_code', v_id::text, upper(btrim(p_code)), null,
    jsonb_build_object('label', p_label, 'category', p_category, 'severity', p_severity), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Ouvrir un contrôle (réception, production ou final).
create function public.quality_inspection_open(p_kind text, p_material uuid, p_article uuid, p_production_order uuid, p_purchase_receipt uuid,
  p_receipt_ref text, p_sample numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_inspections (id, kind, material_id, article_id, production_order_id, purchase_receipt_id, receipt_ref, sample_size, note)
  values (v_id, p_kind, p_material, p_article, p_production_order, p_purchase_receipt, nullif(btrim(coalesce(p_receipt_ref, '')), ''), p_sample,
    nullif(btrim(coalesce(p_note, '')), ''))
  returning number into v_number;
  perform private.write_audit(private.current_company(), 'quality.inspection_open', 'quality_inspection', v_id::text, v_number, null,
    jsonb_build_object('kind', p_kind, 'sample', p_sample), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Constater un défaut sur un contrôle ouvert. La gravité par défaut vient du référentiel.
create function public.quality_defect_add(p_inspection uuid, p_code text, p_qty numeric, p_severity text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype; c public.quality_defect_codes%rowtype; v_id uuid := gen_random_uuid(); v_sev text;
begin
  perform private.require_perm('quality.write');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'QUALITY_BAD_QTY' using errcode = '22023'; end if;
  select * into c from public.quality_defect_codes where company_id = i.company_id and code = upper(btrim(p_code)) and active;
  if not found then raise exception 'QUALITY_DEFECT_CODE_NOT_FOUND' using errcode = 'P0002'; end if;
  v_sev := coalesce(p_severity, c.default_severity);
  if v_sev not in ('minor', 'major', 'critical') then raise exception 'QUALITY_BAD_SEVERITY' using errcode = '22023'; end if;
  insert into public.quality_defects (id, inspection_id, defect_code, category, severity, qty, note)
  values (v_id, i.id, c.code, c.category, v_sev, p_qty, nullif(btrim(coalesce(p_note, '')), ''));
  return v_id;
end $$;

-- Décision sur un contrôle. Un rejet ouvre automatiquement une non-conformité.
create function public.quality_inspection_decide(p_inspection uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype; v_total numeric; v_crit int; v_major int; v_worst text; v_rej numeric; v_nc uuid; v_nc_number text;
begin
  perform private.require_perm('quality.approve');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_decision not in ('accepted', 'conditional', 'rejected') then raise exception 'QUALITY_BAD_DECISION' using errcode = '22023'; end if;
  select coalesce(sum(qty), 0), count(*) filter (where severity = 'critical'), count(*) filter (where severity = 'major'),
         (array_agg(severity order by case severity when 'critical' then 1 when 'major' then 2 else 3 end))[1]
    into v_total, v_crit, v_major, v_worst
    from public.quality_defects where inspection_id = i.id;
  if v_crit > 0 and p_decision <> 'rejected' then raise exception 'QUALITY_CRITICAL_DEFECT' using errcode = '22023'; end if;
  if v_major > 0 and p_decision = 'accepted' then raise exception 'QUALITY_DECISION_NOT_ALLOWED' using errcode = '22023'; end if;

  v_rej := case p_decision when 'rejected' then i.sample_size when 'conditional' then least(i.sample_size, v_total) else 0 end;
  update public.quality_inspections set status = 'closed', decision = p_decision, qty_rejected = v_rej, qty_accepted = i.sample_size - v_rej,
    note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note), closed_at = now(), closed_by = auth.uid()
    where id = i.id;

  if p_decision = 'rejected' then
    v_nc := gen_random_uuid();
    insert into public.quality_nonconformities (id, number, title, description, severity, inspection_id)
    values (v_nc, null, 'Non-conformité ' || i.number, 'Contrôle rejeté : voir les défauts constatés sur le contrôle ' || i.number,
      coalesce(v_worst, 'major'), i.id)
    returning number into v_nc_number;
    perform private.write_audit(i.company_id, 'quality.nc_open', 'quality_nonconformity', v_nc::text, v_nc_number, null,
      jsonb_build_object('inspection', i.number, 'severity', v_worst), '{}'::jsonb, 'rpc');
  end if;
  perform private.write_audit(i.company_id, 'quality.inspection_decide', 'quality_inspection', i.id::text, i.number, null,
    jsonb_build_object('decision', p_decision, 'defects', v_total, 'rejected', v_rej), '{}'::jsonb, 'rpc');
  return jsonb_build_object('decision', p_decision, 'qty_rejected', v_rej, 'nc_id', v_nc, 'nc_number', v_nc_number);
end $$;

-- ---------------------------------------------------------------------
-- 8. Non-conformités et actions
-- ---------------------------------------------------------------------
create function public.quality_nc_open(p_title text, p_description text, p_severity text, p_due date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_nonconformities (id, number, title, description, severity, due_date)
  values (v_id, null, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_severity, p_due)
  returning number into v_number;
  perform private.write_audit(private.current_company(), 'quality.nc_open', 'quality_nonconformity', v_id::text, v_number, null,
    jsonb_build_object('severity', p_severity), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function private.quality_lock_nc(p_id uuid) returns public.quality_nonconformities
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype;
begin
  select * into n from public.quality_nonconformities where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  return n;
end $$;
revoke execute on function private.quality_lock_nc(uuid) from public, anon, authenticated;

-- Contenir : action immédiate et cause probable.
create function public.quality_nc_contain(p_nc uuid, p_containment text, p_root_cause text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_c text := btrim(coalesce(p_containment, ''));
begin
  perform private.require_perm('quality.write');
  if length(v_c) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  n := private.quality_lock_nc(p_nc);
  if n.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_nonconformities set status = 'contained', containment = v_c,
    root_cause = coalesce(nullif(btrim(coalesce(p_root_cause, '')), ''), root_cause) where id = p_nc;
  perform private.write_audit(n.company_id, 'quality.nc_contain', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('containment', v_c), '{}'::jsonb, 'rpc');
end $$;

-- Plans d'actions
create function public.quality_plan_create(p_title text, p_objective text, p_owner uuid, p_start date, p_target date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_action_plans (id, number, title, objective, owner_id, start_date, target_date)
  values (v_id, null, btrim(p_title), nullif(btrim(coalesce(p_objective, '')), ''), p_owner, p_start, p_target)
  returning number into v_number;
  perform private.write_audit(private.current_company(), 'quality.plan_create', 'quality_action_plan', v_id::text, v_number, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.quality_plan_activate(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text;
begin
  perform private.require_perm('quality.write');
  select status into v_status from public.quality_action_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'draft' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_action_plans set status = 'active' where id = p_plan;
  perform private.write_audit(v_co, 'quality.plan_activate', 'quality_action_plan', p_plan::text, null, null, '{"status":"active"}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Clôture d'un plan : toutes ses actions vérifiées ou annulées.
create function public.quality_plan_close(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text; v_open int;
begin
  perform private.require_perm('quality.approve');
  select status into v_status from public.quality_action_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'active' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_open from public.quality_corrective_actions where plan_id = p_plan and status not in ('verified', 'cancelled');
  if v_open > 0 then raise exception 'QUALITY_ACTIONS_OPEN' using errcode = '55000'; end if;
  update public.quality_action_plans set status = 'closed', closed_at = now() where id = p_plan;
  perform private.write_audit(v_co, 'quality.plan_close', 'quality_action_plan', p_plan::text, null, null, '{"status":"closed"}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Action corrective ou préventive sur une non-conformité ouverte.
create function public.quality_ca_add(p_nc uuid, p_kind text, p_action text, p_owner uuid, p_due date, p_plan uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  n := private.quality_lock_nc(p_nc);
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_plan is not null and not exists (select 1 from public.quality_action_plans where id = p_plan and company_id = n.company_id and status = 'active') then
    raise exception 'QUALITY_PLAN_NOT_ACTIVE' using errcode = '55000';
  end if;
  insert into public.quality_corrective_actions (id, number, nc_id, plan_id, kind, action, owner_id, due_date)
  values (v_id, null, n.id, p_plan, p_kind, btrim(p_action), p_owner, p_due)
  returning number into v_number;
  perform private.write_audit(n.company_id, 'quality.ca_add', 'quality_corrective_action', v_id::text, v_number, null,
    jsonb_build_object('nc', n.number, 'kind', p_kind), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function private.quality_lock_ca(p_id uuid) returns public.quality_corrective_actions
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype;
begin
  select * into a from public.quality_corrective_actions where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  return a;
end $$;
revoke execute on function private.quality_lock_ca(uuid) from public, anon, authenticated;

-- Avancement : à faire → en cours → fait (les étapes peuvent être sautées vers « fait »).
create function public.quality_ca_progress(p_ca uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype;
begin
  perform private.require_perm('quality.write');
  a := private.quality_lock_ca(p_ca);
  if p_status = 'in_progress' and a.status = 'todo' then
    update public.quality_corrective_actions set status = 'in_progress' where id = p_ca;
  elsif p_status = 'done' and a.status in ('todo', 'in_progress') then
    update public.quality_corrective_actions set status = 'done', done_at = now() where id = p_ca;
  else
    raise exception 'QUALITY_BAD_STATUS' using errcode = '55000';
  end if;
  perform private.write_audit(a.company_id, 'quality.ca_progress', 'quality_corrective_action', a.id::text, a.number, null,
    jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

-- Vérification d'efficacité par un responsable qualité (action faite → vérifiée).
create function public.quality_ca_verify(p_ca uuid, p_effective boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype;
begin
  perform private.require_perm('quality.approve');
  a := private.quality_lock_ca(p_ca);
  if a.status <> 'done' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_corrective_actions set status = 'verified', verified_at = now(), verified_by = auth.uid(), effective = p_effective
    where id = p_ca;
  perform private.write_audit(a.company_id, 'quality.ca_verify', 'quality_corrective_action', a.id::text, a.number, null,
    jsonb_build_object('effective', p_effective), '{}'::jsonb, 'rpc');
end $$;

create function public.quality_ca_cancel(p_ca uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('quality.approve');
  if length(v_reason) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  a := private.quality_lock_ca(p_ca);
  if a.status in ('verified', 'cancelled') then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_corrective_actions set status = 'cancelled', cancel_reason = v_reason where id = p_ca;
  perform private.write_audit(a.company_id, 'quality.ca_cancel', 'quality_corrective_action', a.id::text, a.number, null,
    jsonb_build_object('reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

-- Clôture d'une non-conformité : contenue ; actions vérifiées efficaces ; sinon justification écrite.
create function public.quality_nc_close(p_nc uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_open int; v_verified int; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform private.require_perm('quality.approve');
  n := private.quality_lock_nc(p_nc);
  if n.status <> 'contained' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) filter (where status not in ('verified', 'cancelled') or (status = 'verified' and effective is not true)),
         count(*) filter (where status = 'verified' and effective)
    into v_open, v_verified
    from public.quality_corrective_actions where nc_id = n.id;
  if v_open > 0 then raise exception 'QUALITY_ACTIONS_OPEN' using errcode = '55000'; end if;
  if v_verified = 0 and (v_note is null or length(v_note) < 10) then raise exception 'QUALITY_JUSTIFICATION_REQUIRED' using errcode = '22023'; end if;
  update public.quality_nonconformities set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_note = v_note where id = n.id;
  perform private.write_audit(n.company_id, 'quality.nc_close', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('verified_actions', v_verified), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 9. Indicateurs qualité
-- ---------------------------------------------------------------------
create function public.quality_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  perform private.require_perm('quality.read');
  select jsonb_build_object(
    'controls', (select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'closed', k.closed_n, 'accepted', k.accepted_n,
        'conditional', k.conditional_n, 'rejected', k.rejected_n,
        'first_pass_pct', case when k.closed_n = 0 then null else round(100.0 * k.accepted_n / k.closed_n, 1) end,
        'defects_per_unit', case when k.sampled = 0 then null else round(k.defects / k.sampled, 2) end) order by k.kind), '[]'::jsonb)
      from (select i.kind, count(*) filter (where i.status = 'closed') closed_n,
              count(*) filter (where i.decision = 'accepted') accepted_n, count(*) filter (where i.decision = 'conditional') conditional_n,
              count(*) filter (where i.decision = 'rejected') rejected_n,
              coalesce(sum(i.sample_size) filter (where i.status = 'closed'), 0) sampled,
              coalesce((select sum(d.qty) from public.quality_defects d join public.quality_inspections j on j.id = d.inspection_id
                        where j.company_id = v_co and j.kind = i.kind and j.status = 'closed'), 0) defects
            from public.quality_inspections i where i.company_id = v_co group by i.kind) k),
    'pareto', (select coalesce(jsonb_agg(jsonb_build_object('code', p.defect_code, 'label', p.label, 'category', p.category, 'qty', p.qty) order by p.qty desc), '[]'::jsonb)
      from (select d.defect_code, c.label, d.category, sum(d.qty) qty from public.quality_defects d
              left join public.quality_defect_codes c on c.company_id = d.company_id and c.code = d.defect_code
             where d.company_id = v_co group by d.defect_code, c.label, d.category order by sum(d.qty) desc limit 10) p),
    'open_inspections', (select count(*) from public.quality_inspections where company_id = v_co and status = 'open'),
    'nc_open', (select count(*) from public.quality_nonconformities where company_id = v_co and status <> 'closed'),
    'nc_by_severity', (select coalesce(jsonb_object_agg(s.severity, s.c), '{}'::jsonb) from (
        select severity, count(*) c from public.quality_nonconformities where company_id = v_co and status <> 'closed' group by severity) s),
    'actions_overdue', (select count(*) from public.quality_corrective_actions where company_id = v_co
        and status in ('todo', 'in_progress', 'done') and due_date < current_date),
    'action_effectiveness_pct', (select case when count(*) filter (where status = 'verified') = 0 then null
        else round(100.0 * count(*) filter (where status = 'verified' and effective) / count(*) filter (where status = 'verified'), 1) end
        from public.quality_corrective_actions where company_id = v_co),
    'plans', (select coalesce(jsonb_object_agg(s.status, s.c), '{}'::jsonb) from (
        select status, count(*) c from public.quality_action_plans where company_id = v_co group by status) s)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 10. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.quality_defect_code_save(text, text, text, text)',
    'public.quality_inspection_open(text, uuid, uuid, uuid, uuid, text, numeric, text)',
    'public.quality_defect_add(uuid, text, numeric, text, text)',
    'public.quality_inspection_decide(uuid, text, text)',
    'public.quality_nc_open(text, text, text, date)',
    'public.quality_nc_contain(uuid, text, text)',
    'public.quality_plan_create(text, text, uuid, date, date)',
    'public.quality_plan_activate(uuid)',
    'public.quality_plan_close(uuid)',
    'public.quality_ca_add(uuid, text, text, uuid, date, uuid)',
    'public.quality_ca_progress(uuid, text)',
    'public.quality_ca_verify(uuid, boolean)',
    'public.quality_ca_cancel(uuid, text)',
    'public.quality_nc_close(uuid, text)',
    'public.quality_dashboard()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ===== 0021_shipping.sql =====
-- =====================================================================
-- 0021_shipping — Expédition : préparation de commandes, picking, colisage, bon de livraison,
--                 packing list, facture export, suivi et indicateurs logistiques
--  Tables :
--    shipments        : expéditions (une commande confirmée peut en avoir plusieurs), statut, transport, documents
--    shipment_lines   : lignes par variante (taille × couleur) : demandé, prélevé, expédié, prix unitaire figé
--    shipment_events  : journal de suivi IMMUABLE (picking, colisage, expédition, transit, incident, livraison)
--  Flux : préparer (commande confirmée, quantité ≤ commandée par article) → picker (réservation du stock)
--         → colisser (toutes les lignes prélevées) → expédier (sortie de stock, bon de livraison)
--         → livrer. Une expédition peut être annulée tant qu'elle n'est pas expédiée (réservations libérées).
--  Facture export : émise sur une expédition expédiée, avec incoterm et pays de destination renseignés.
--  Stock : réservation = variant_stock.qty_reserved ; expédition = sortie de qty_on_hand, journalisée dans variant_stock_moves.
--  Droits : shipments.read (voir), shipments.write (tout le flux).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (codes existants en 0003)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('shipments.read', 'shipments.write'))
  or (r.code = 'magasin'   and p.code in ('shipments.read', 'shipments.write'))
  or (r.code = 'commercial' and p.code = 'shipments.read')
  or (r.code = 'direction' and p.code = 'shipments.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.shipments (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number              text not null,
  sales_order_id      uuid not null references public.sales_orders(id),
  client_id           uuid not null references public.clients(id),
  warehouse_id        uuid not null references public.warehouses(id),
  status              text not null default 'preparing' check (status in ('preparing', 'picking', 'packed', 'shipped', 'delivered', 'cancelled')),
  incoterm            text check (incoterm is null or incoterm in ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  destination_country char(2) check (destination_country is null or destination_country ~ '^[A-Z]{2}$'),
  currency            char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  carrier             text check (carrier is null or length(carrier) <= 80),
  tracking_number     text check (tracking_number is null or length(tracking_number) <= 80),
  packages            int check (packages is null or packages >= 0),
  gross_weight_kg     numeric(10,2) check (gross_weight_kg is null or gross_weight_kg >= 0),
  net_weight_kg       numeric(10,2) check (net_weight_kg is null or net_weight_kg >= 0),
  bl_number           text,
  bl_issued_at        timestamptz,
  export_invoice_number text,
  export_invoice_at   timestamptz,
  export_total        numeric(14,2),
  cancel_reason       text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  packed_at           timestamptz,
  shipped_at          timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  unique (company_id, number),
  unique (company_id, bl_number),
  unique (company_id, export_invoice_number),
  check ((status = 'shipped' and bl_number is not null and shipped_at is not null) or status <> 'shipped'),
  check (status <> 'delivered' or delivered_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null),
  check (export_invoice_number is null or status in ('shipped', 'delivered'))
);
create index shipments_status_idx on public.shipments (company_id, status, created_at desc);
create index shipments_order_idx on public.shipments (sales_order_id);

create table public.shipment_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id   uuid not null references public.shipments(id) on delete cascade,
  variant_id    uuid not null references public.product_variants(id),
  qty_requested int not null check (qty_requested > 0 and qty_requested <= 1000000),
  qty_picked    int not null default 0 check (qty_picked >= 0),
  qty_shipped   int not null default 0 check (qty_shipped >= 0),
  unit_price    numeric(14,2) not null default 0 check (unit_price >= 0),
  created_at    timestamptz not null default now(),
  unique (shipment_id, variant_id),
  check (qty_picked <= qty_requested),
  check (qty_shipped <= qty_picked)
);
create index shipment_lines_shipment_idx on public.shipment_lines (shipment_id);

create table public.shipment_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id uuid not null references public.shipments(id),
  event_type  text not null check (event_type in ('created', 'picked', 'packed', 'shipped', 'in_transit', 'exception', 'delivered', 'cancelled')),
  location    text check (location is null or length(location) <= 120),
  note        text check (note is null or length(note) <= 300),
  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index shipment_events_idx on public.shipment_events (shipment_id, occurred_at);

-- ---------------------------------------------------------------------
-- 3. Garde-fous : numérotation, immuabilité du suivi, cohérence société
-- ---------------------------------------------------------------------
create function private.doc_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := TG_ARGV[0] || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, TG_ARGV[1])::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.doc_number() from public, anon, authenticated;
create trigger shipments_number_i before insert on public.shipments for each row execute function private.doc_number('SHP-', 'shipment');

create function private.shipping_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'SHIPPING_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.shipping_immutable() from public, anon, authenticated;
create trigger shipment_events_immutable before update or delete on public.shipment_events
  for each row execute function private.shipping_immutable();

-- Commande, client, entrepôt et variante : même société ; entrepôt actif.
create function private.shipments_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sales_orders o where o.id = new.sales_order_id and o.company_id = new.company_id and o.client_id = new.client_id) then
    raise exception 'SHIPPING_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.warehouses w where w.id = new.warehouse_id and w.company_id = new.company_id and w.archived_at is null) then
    raise exception 'SHIPPING_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.shipments_check() from public, anon, authenticated;
create trigger shipments_check_i before insert on public.shipments for each row execute function private.shipments_check();

-- ---------------------------------------------------------------------
-- 4. Sécurité des lignes (lecture par droit et entrepôt affecté)
-- ---------------------------------------------------------------------
alter table public.shipments enable row level security;
alter table public.shipment_lines enable row level security;
alter table public.shipment_events enable row level security;
create policy shipments_select on public.shipments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy shipments_wh_scope on public.shipments as restrictive for select to authenticated
  using (private.wh_can(warehouse_id, 'viewer'));
create policy shipment_lines_select on public.shipment_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy shipment_events_select on public.shipment_events for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create trigger shipments_wh_guard before insert or update or delete on public.shipments
  for each row execute function private.wh_write_guard('warehouse_id', 'operator');
revoke all on public.shipments, public.shipment_lines, public.shipment_events from anon, authenticated;
grant select on public.shipments, public.shipment_lines, public.shipment_events to authenticated;

-- ---------------------------------------------------------------------
-- 5. Fonctions internes
-- ---------------------------------------------------------------------
create function private.shipment_lock(p_id uuid) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  select * into s from public.shipments where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  return s;
end $$;
revoke execute on function private.shipment_lock(uuid) from public, anon, authenticated;

create function private.shipment_event(p_shipment uuid, p_type text, p_location text default null, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.shipment_events (shipment_id, event_type, location, note)
  values (p_shipment, p_type, nullif(btrim(coalesce(p_location, '')), ''), nullif(btrim(coalesce(p_note, '')), ''));
end $$;
revoke execute on function private.shipment_event(uuid, text, text, text) from public, anon, authenticated;

-- Variante du stock : réservation et sortie, journalisées comme les autres mouvements de variante (0015).
create function private.shipping_stock(p_variant uuid, p_warehouse uuid, p_op text, p_qty int, p_reference text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.variant_stock%rowtype; v public.product_variants%rowtype;
begin
  select * into v from public.product_variants where id = p_variant;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, p_warehouse) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = p_variant and warehouse_id = p_warehouse for update;
  perform set_config('variants.rpc', 'on', true);
  if p_op = 'reserve' then
    if p_qty > s.qty_on_hand - s.qty_reserved then raise exception 'SHIPPING_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    update public.variant_stock set qty_reserved = qty_reserved + p_qty, updated_at = now() where id = s.id;
  elsif p_op = 'release' then
    update public.variant_stock set qty_reserved = qty_reserved - p_qty, updated_at = now() where id = s.id;
  elsif p_op = 'issue' then
    if p_qty > s.qty_on_hand then raise exception 'SHIPPING_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    update public.variant_stock set qty_on_hand = qty_on_hand - p_qty, qty_reserved = qty_reserved - p_qty, updated_at = now() where id = s.id;
    insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, created_by)
      values (v.company_id, v.id, p_warehouse, 'issue', -p_qty, s.qty_on_hand - p_qty, 'Expédition', p_reference, auth.uid());
  end if;
  perform set_config('variants.rpc', 'off', true);
end $$;
revoke execute on function private.shipping_stock(uuid, uuid, text, int, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Flux : préparation, picking, colisage, expédition, livraison, annulation, suivi
-- ---------------------------------------------------------------------
-- Préparer une expédition depuis une commande confirmée.
create function public.shipment_create(p_order uuid, p_warehouse uuid, p_incoterm text default null, p_country text default null,
  p_currency text default 'EUR') returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('shipments.write');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company();
  if not found then raise exception 'SHIPPING_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'confirmed' then raise exception 'SHIPPING_ORDER_NOT_CONFIRMED' using errcode = '55000'; end if;
  insert into public.shipments (id, sales_order_id, client_id, warehouse_id, incoterm, destination_country, currency)
  values (v_id, o.id, o.client_id, p_warehouse, nullif(p_incoterm, ''), nullif(upper(p_country), ''), upper(coalesce(p_currency, 'EUR')))
  returning number into v_number;
  perform private.shipment_event(v_id, 'created', null, 'Expédition ' || v_number);
  perform private.write_audit(o.company_id, 'shipping.create', 'shipment', v_id::text, v_number, null,
    jsonb_build_object('order', o.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Ajouter une variante : son article doit figurer dans la commande, et la quantité ne dépasse pas la commande pour cet article.
create function public.shipment_add_line(p_shipment uuid, p_variant uuid, p_qty int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v public.product_variants%rowtype; v_article uuid; v_ordered numeric; v_allocated numeric; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status not in ('preparing', 'picking') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  select * into v from public.product_variants where id = p_variant and company_id = s.company_id;
  if not found then raise exception 'SHIPPING_VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select pm.article_id into v_article from public.product_master pm where pm.id = v.product_id;
  if v_article is null or not exists (select 1 from public.sales_order_lines l where l.order_id = s.sales_order_id and l.article_id = v_article) then
    raise exception 'SHIPPING_ARTICLE_NOT_IN_ORDER' using errcode = '22023';
  end if;
  select coalesce(sum(qty), 0) into v_ordered from public.sales_order_lines where order_id = s.sales_order_id and article_id = v_article;
  select coalesce(sum(sl.qty_requested), 0) into v_allocated
    from public.shipment_lines sl
    join public.shipments sh on sh.id = sl.shipment_id
    join public.product_variants pv on pv.id = sl.variant_id
    join public.product_master pm on pm.id = pv.product_id
    where sh.sales_order_id = s.sales_order_id and sh.status <> 'cancelled' and pm.article_id = v_article;
  if v_allocated + p_qty > v_ordered then raise exception 'SHIPPING_QTY_EXCEEDS_ORDER' using errcode = '22023'; end if;
  insert into public.shipment_lines (id, shipment_id, variant_id, qty_requested, unit_price)
  values (v_id, s.id, v.id, p_qty, coalesce(v.price, 0));
  return v_id;
end $$;

-- Picking : réserve le stock disponible pour une ligne.
create function public.shipment_pick(p_line uuid, p_qty int) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.shipment_lines%rowtype; s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  select * into l from public.shipment_lines where id = p_line for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  s := private.shipment_lock(l.shipment_id);
  if s.status not in ('preparing', 'picking') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  if l.qty_picked + p_qty > l.qty_requested then raise exception 'SHIPPING_QTY_EXCEEDS_LINE' using errcode = '22023'; end if;
  perform private.shipping_stock(l.variant_id, s.warehouse_id, 'reserve', p_qty, s.number);
  update public.shipment_lines set qty_picked = qty_picked + p_qty where id = p_line;
  update public.shipments set status = 'picking' where id = s.id and status = 'preparing';
  perform private.shipment_event(s.id, 'picked', null, 'Prélèvement de ' || p_qty || ' pièce(s)');
end $$;

-- Colisage : toutes les lignes entièrement prélevées.
create function public.shipment_pack(p_shipment uuid, p_packages int, p_gross numeric, p_net numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_open int;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'picking' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_open from public.shipment_lines where shipment_id = s.id and qty_picked < qty_requested;
  if v_open > 0 then raise exception 'SHIPPING_NOT_PICKED' using errcode = '55000'; end if;
  if p_packages is null or p_packages <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  if p_net is not null and p_gross is not null and p_net > p_gross then raise exception 'SHIPPING_BAD_WEIGHT' using errcode = '22023'; end if;
  update public.shipments set status = 'packed', packed_at = now(), packages = p_packages, gross_weight_kg = p_gross, net_weight_kg = p_net where id = s.id;
  perform private.shipment_event(s.id, 'packed', null, p_packages || ' colis');
end $$;

-- Expédition : sortie de stock, numéro de bon de livraison.
create function public.shipment_ship(p_shipment uuid, p_carrier text, p_tracking text) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; l record; v_bl text;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'packed' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  for l in select * from public.shipment_lines where shipment_id = s.id loop
    perform private.shipping_stock(l.variant_id, s.warehouse_id, 'issue', l.qty_picked, s.number);
    update public.shipment_lines set qty_shipped = l.qty_picked where id = l.id;
  end loop;
  v_bl := 'BL-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(s.company_id, 'delivery_note')::text, 6, '0');
  update public.shipments set status = 'shipped', shipped_at = now(), bl_number = v_bl, bl_issued_at = now(),
    carrier = nullif(btrim(coalesce(p_carrier, '')), ''), tracking_number = nullif(btrim(coalesce(p_tracking, '')), '') where id = s.id;
  perform private.shipment_event(s.id, 'shipped', null, 'Bon de livraison ' || v_bl);
  perform private.write_audit(s.company_id, 'shipping.ship', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('bl', v_bl), '{}'::jsonb, 'rpc');
  return v_bl;
end $$;

create function public.shipment_deliver(p_shipment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'shipped' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  update public.shipments set status = 'delivered', delivered_at = now() where id = s.id;
  perform private.shipment_event(s.id, 'delivered', null, null);
end $$;

-- Annulation avant expédition : réservations libérées.
create function public.shipment_cancel(p_shipment uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; l record; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('shipments.write');
  if length(v_reason) < 5 then raise exception 'SHIPPING_REASON_REQUIRED' using errcode = '22023'; end if;
  s := private.shipment_lock(p_shipment);
  if s.status not in ('preparing', 'picking', 'packed') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  for l in select * from public.shipment_lines where shipment_id = s.id and qty_picked > 0 loop
    perform private.shipping_stock(l.variant_id, s.warehouse_id, 'release', l.qty_picked, s.number);
  end loop;
  update public.shipments set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason where id = s.id;
  perform private.shipment_event(s.id, 'cancelled', null, v_reason);
end $$;

-- Suivi transport : transit ou incident.
create function public.shipment_track(p_shipment uuid, p_event text, p_location text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  if p_event not in ('in_transit', 'exception') then raise exception 'SHIPPING_BAD_EVENT' using errcode = '22023'; end if;
  s := private.shipment_lock(p_shipment);
  if s.status not in ('shipped', 'delivered') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  perform private.shipment_event(s.id, p_event, p_location, p_note);
end $$;

-- Facture export : expédition expédiée, incoterm et pays de destination renseignés.
create function public.shipment_export_invoice(p_shipment uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_no text; v_total numeric;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status not in ('shipped', 'delivered') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  if s.export_invoice_number is not null then raise exception 'SHIPPING_ALREADY_INVOICED' using errcode = '55000'; end if;
  if s.incoterm is null or s.destination_country is null then raise exception 'SHIPPING_EXPORT_DATA_MISSING' using errcode = '22023'; end if;
  select coalesce(sum(qty_shipped * unit_price), 0) into v_total from public.shipment_lines where shipment_id = s.id;
  v_no := 'EXP-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(s.company_id, 'export_invoice')::text, 6, '0');
  update public.shipments set export_invoice_number = v_no, export_invoice_at = now(), export_total = v_total where id = s.id;
  perform private.write_audit(s.company_id, 'shipping.export_invoice', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('invoice', v_no, 'total', v_total), '{}'::jsonb, 'rpc');
  return v_no;
end $$;

-- ---------------------------------------------------------------------
-- 7. Indicateurs logistiques
-- ---------------------------------------------------------------------
create function public.shipping_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  perform private.require_perm('shipments.read');
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(s, c), '{}'::jsonb) from (select status s, count(*) c from public.shipments where company_id = v_co group by status) x),
    'open', (select count(*) from public.shipments where company_id = v_co and status in ('preparing', 'picking', 'packed')),
    'late_open', (select count(*) from public.shipments sh where sh.company_id = v_co and sh.status in ('preparing', 'picking', 'packed')
        and (select min(l.due_date) from public.sales_order_lines l where l.order_id = sh.sales_order_id) < current_date),
    'on_time_pct', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where sh.shipped_at::date <= (select min(l.due_date) from public.sales_order_lines l where l.order_id = sh.sales_order_id))
        / count(*), 1) end from public.shipments sh where sh.company_id = v_co and sh.shipped_at is not null),
    'avg_lead_time_days', (select round(avg(extract(epoch from (shipped_at - created_at)) / 86400)::numeric, 1) from public.shipments
        where company_id = v_co and shipped_at is not null),
    'fill_rate_pct', (select case when ordered = 0 then null else round(100.0 * shipped / ordered, 1) end from (
        select (select coalesce(sum(qty_shipped), 0) from public.shipment_lines sl join public.shipments s2 on s2.id = sl.shipment_id where s2.company_id = v_co) shipped,
               (select coalesce(sum(l.qty), 0) from public.sales_order_lines l where l.company_id = v_co
                  and l.order_id in (select distinct sales_order_id from public.shipments where company_id = v_co and status in ('shipped', 'delivered'))) ordered) f),
    'packages_total', (select coalesce(sum(packages), 0) from public.shipments where company_id = v_co and status in ('shipped', 'delivered')),
    'avg_gross_kg_per_shipment', (select round(avg(gross_weight_kg), 2) from public.shipments where company_id = v_co and gross_weight_kg is not null),
    'exports_invoiced', (select count(*) from public.shipments where company_id = v_co and export_invoice_number is not null),
    'export_total', (select coalesce(sum(export_total), 0) from public.shipments where company_id = v_co and export_invoice_number is not null),
    'exceptions_open', (select count(distinct e.shipment_id) from public.shipment_events e where e.company_id = v_co and e.event_type = 'exception'
        and not exists (select 1 from public.shipment_events d where d.shipment_id = e.shipment_id and d.event_type = 'delivered' and d.occurred_at > e.occurred_at))
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 8. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.shipment_create(uuid, uuid, text, text, text)',
    'public.shipment_add_line(uuid, uuid, int)',
    'public.shipment_pick(uuid, int)',
    'public.shipment_pack(uuid, int, numeric, numeric)',
    'public.shipment_ship(uuid, text, text)',
    'public.shipment_deliver(uuid)',
    'public.shipment_cancel(uuid, text)',
    'public.shipment_track(uuid, text, text, text)',
    'public.shipment_export_invoice(uuid)',
    'public.shipping_dashboard()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ===== 0022_finance.sql =====
-- =====================================================================
-- 0022_finance — Finance : encaissements, factures et règlements fournisseurs, balances âgées clients et fournisseurs,
--                 relances automatiques, trésorerie, prévisions de trésorerie, tableau de bord
--  Tables :
--    supplier_invoices               : factures fournisseurs (numéro interne FF-, numéro du fournisseur, échéance, solde)
--    supplier_payments               : règlements fournisseurs (numéro RG-)
--    supplier_payment_allocations    : affectation d'un règlement à des factures — IMMUABLE
--    cash_accounts                   : comptes de trésorerie avec solde d'ouverture
--    cash_movements                  : mouvements de trésorerie hors clients/fournisseurs (frais, virements internes) — IMMUABLE
--    finance_reminders               : relances clients, une par niveau et par facture
--  Encaissements clients : invoice_record_payment (0012) ; l'encaissement global est affecté aux factures les plus anciennes.
--  Règlements fournisseurs : affectation FIFO aux factures échues en premier ; litige = facture non payable.
--  Balances âgées : tranches à partir de l'échéance (à échoir, 1-30, 31-60, 61-90, plus de 90 jours).
--  Relances : niveau 1 (1-30 jours de retard), 2 (31-60), 3 (plus de 60) ; une seule relance par niveau et par facture.
--    La relance n'est pas envoyée par ce module : elle est marquée « envoyée » une fois transmise.
--  Trésorerie : soldes d'ouverture + encaissements clients − règlements fournisseurs ± mouvements manuels.
--    Les encaissements ne sont pas rattachés à un compte bancaire (trésorerie consolidée).
--  Droits : finance.read (voir), finance.write (saisir, affecter, relancer) ; les encaissements exigent aussi payments.write.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('finance.read',  'finance', 'Voir la finance',   'Balances âgées, trésorerie, prévisions, tableau de bord financier'),
  ('finance.write', 'finance', 'Gérer la finance',  'Factures et règlements fournisseurs, relances, mouvements de trésorerie')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'   and p.code in ('finance.read', 'finance.write'))
  or (r.code = 'finance' and p.code in ('finance.read', 'finance.write'))
  or (r.code = 'direction' and p.code = 'finance.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.supplier_invoices (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  supplier_id   uuid not null references public.suppliers(id),
  supplier_ref  text not null check (length(btrim(supplier_ref)) between 1 and 60),
  purchase_order_id uuid references public.purchase_orders(id),
  invoice_date  date not null,
  due_date      date not null,
  currency      char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  total         numeric(15,2) not null check (total > 0),
  paid_amount   numeric(15,2) not null default 0 check (paid_amount >= 0),
  status        text not null default 'open' check (status in ('open', 'partially_paid', 'paid', 'disputed')),
  dispute_reason text check (dispute_reason is null or length(dispute_reason) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (company_id, number),
  unique (company_id, supplier_id, supplier_ref),
  check (due_date >= invoice_date),
  check (paid_amount <= total),
  check ((status = 'paid') = (paid_amount = total)),
  check (status <> 'partially_paid' or (paid_amount > 0 and paid_amount < total))
);
create index supplier_invoices_open_idx on public.supplier_invoices (company_id, status, due_date);

create table public.supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number      text not null,
  supplier_id uuid not null references public.suppliers(id),
  amount      numeric(15,2) not null check (amount > 0),
  paid_on     date not null,
  method      text not null default 'transfer' check (method in ('transfer', 'cheque', 'lc', 'cash', 'card', 'other')),
  reference   text check (reference is null or length(reference) <= 120),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, number)
);

create table public.supplier_payment_allocations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  payment_id          uuid not null references public.supplier_payments(id),
  supplier_invoice_id uuid not null references public.supplier_invoices(id),
  amount              numeric(15,2) not null check (amount > 0),
  created_at          timestamptz not null default now()
);

create table public.cash_accounts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 2 and 80),
  opening_balance  numeric(15,2) not null default 0,
  opening_date     date not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (company_id, name)
);

create table public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  account_id  uuid not null references public.cash_accounts(id),
  direction   text not null check (direction in ('in', 'out')),
  amount      numeric(15,2) not null check (amount > 0),
  moved_on    date not null,
  label       text not null check (length(btrim(label)) between 2 and 160),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

create table public.finance_reminders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id),
  level       int not null check (level in (1, 2, 3)),
  days_late   int not null check (days_late > 0),
  balance     numeric(15,2) not null check (balance > 0),
  status      text not null default 'pending' check (status in ('pending', 'sent')),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  sent_by     uuid,
  unique (company_id, invoice_id, level),
  check ((status = 'sent') = (sent_at is not null))
);

-- ---------------------------------------------------------------------
-- 3. Garde-fous : numérotation, immuabilité, sécurité des lignes
-- ---------------------------------------------------------------------
create or replace function private.doc_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := TG_ARGV[0] || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, TG_ARGV[1])::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.doc_number() from public, anon, authenticated;
create trigger supplier_invoices_number_i before insert on public.supplier_invoices for each row execute function private.doc_number('FF-', 'supplier_invoice');
create trigger supplier_payments_number_i before insert on public.supplier_payments for each row execute function private.doc_number('RGF-', 'supplier_payment');

create function private.finance_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'FINANCE_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.finance_immutable() from public, anon, authenticated;
create trigger supplier_payment_allocations_immutable before update or delete on public.supplier_payment_allocations
  for each row execute function private.finance_immutable();
create trigger cash_movements_immutable before update or delete on public.cash_movements
  for each row execute function private.finance_immutable();

-- Lignes accessibles par droit de lecture (finance.read) et société.
do $$
declare t text;
begin
  foreach t in array array['supplier_invoices', 'supplier_payments', 'supplier_payment_allocations', 'cash_accounts', 'cash_movements', 'finance_reminders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(%L))',
      t || '_select', t, 'finance.read');
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Encaissements clients : journal des encaissements (paiements de factures) avec le client et le numéro de facture.
create view public.finance_receipts with (security_invoker = true) as
select p.id, p.company_id, p.paid_on, p.amount, p.method, p.reference, i.id as invoice_id, i.code as invoice_code, i.client_id,
       c.name as client_name, p.created_at
  from public.invoice_payments p
  join public.invoices i on i.id = p.invoice_id
  join public.clients c on c.id = i.client_id;
grant select on public.finance_receipts to authenticated;

-- ---------------------------------------------------------------------
-- 4. Factures et règlements fournisseurs
-- ---------------------------------------------------------------------
create function public.supplier_invoice_record(p_supplier uuid, p_ref text, p_invoice_date date, p_due_date date, p_total numeric,
  p_currency text default 'EUR', p_purchase_order uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text; v_co uuid := private.current_company();
begin
  perform private.require_perm('finance.write');
  if not exists (select 1 from public.suppliers s where s.id = p_supplier and s.company_id = v_co) then raise exception 'FINANCE_SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.supplier_invoices (id, supplier_id, supplier_ref, purchase_order_id, invoice_date, due_date, currency, total)
  values (v_id, p_supplier, btrim(p_ref), p_purchase_order, p_invoice_date, p_due_date, upper(coalesce(p_currency, 'EUR')), p_total)
  returning number into v_number;
  perform private.write_audit(v_co, 'finance.supplier_invoice', 'supplier_invoice', v_id::text, v_number, null,
    jsonb_build_object('ref', p_ref, 'total', p_total), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Litige : la facture n'est plus payable tant qu'il n'est pas résolu.
create function public.supplier_invoice_dispute(p_invoice uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.supplier_invoices%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('finance.write');
  if length(v_reason) < 5 then raise exception 'FINANCE_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into i from public.supplier_invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('open', 'partially_paid') then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  update public.supplier_invoices set status = 'disputed', dispute_reason = v_reason where id = p_invoice;
  perform private.write_audit(i.company_id, 'finance.supplier_dispute', 'supplier_invoice', i.id::text, i.number, null,
    jsonb_build_object('reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

create function public.supplier_invoice_resolve(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.supplier_invoices%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into i from public.supplier_invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'disputed' then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  update public.supplier_invoices set status = case when paid_amount = 0 then 'open' else 'partially_paid' end,
    dispute_reason = null where id = p_invoice;
  perform private.write_audit(i.company_id, 'finance.supplier_resolve', 'supplier_invoice', i.id::text, i.number, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Règlement fournisseur : affecté aux factures échues les plus anciennes (hors litiges). Pas d'avance.
create function public.supplier_payment_record(p_supplier uuid, p_amount numeric, p_paid_on date, p_method text default 'transfer', p_reference text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pay uuid := gen_random_uuid(); v_number text; v_left numeric := p_amount; v_open numeric; r record; v_take numeric; v_alloc int := 0;
begin
  perform private.require_perm('finance.write');
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(total - paid_amount), 0) into v_open from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid');
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  insert into public.supplier_payments (id, supplier_id, amount, paid_on, method, reference)
  values (v_pay, p_supplier, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'transfer'), nullif(btrim(coalesce(p_reference, '')), ''))
  returning number into v_number;
  for r in select id, total, paid_amount from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid')
    order by due_date, invoice_date, number for update loop
    exit when v_left <= 0;
    v_take := least(v_left, r.total - r.paid_amount);
    insert into public.supplier_payment_allocations (company_id, payment_id, supplier_invoice_id, amount) values (v_co, v_pay, r.id, v_take);
    update public.supplier_invoices set paid_amount = paid_amount + v_take,
      status = case when paid_amount + v_take = total then 'paid' else 'partially_paid' end where id = r.id;
    v_left := v_left - v_take;
    v_alloc := v_alloc + 1;
  end loop;
  perform private.write_audit(v_co, 'finance.supplier_payment', 'supplier_payment', v_pay::text, v_number, null,
    jsonb_build_object('amount', p_amount, 'invoices', v_alloc), '{}'::jsonb, 'rpc');
  return jsonb_build_object('id', v_pay, 'number', v_number, 'allocated_invoices', v_alloc);
end $$;

-- ---------------------------------------------------------------------
-- 5. Encaissements clients : affectation aux factures les plus anciennes (via invoice_record_payment)
-- ---------------------------------------------------------------------
create function public.customer_receipt_record(p_client uuid, p_amount numeric, p_paid_on date, p_method text default 'transfer', p_reference text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_left numeric := p_amount; v_take numeric; v_alloc int := 0; r record; v_open numeric;
begin
  perform private.require_perm('finance.write');
  perform private.require_perm('payments.write');
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(total - credited_amount - paid_amount), 0) into v_open from public.invoices
    where company_id = v_co and client_id = p_client and status in ('issued', 'partially_paid');
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  for r in select id, total, credited_amount, paid_amount from public.invoices
    where company_id = v_co and client_id = p_client and status in ('issued', 'partially_paid')
    order by due_date nulls last, issue_date, code for update loop
    exit when v_left <= 0;
    v_take := least(v_left, r.total - r.credited_amount - r.paid_amount);
    if v_take > 0 then
      perform public.invoice_record_payment(r.id, v_take, p_paid_on, p_method, p_reference);
      v_left := v_left - v_take;
      v_alloc := v_alloc + 1;
    end if;
  end loop;
  return jsonb_build_object('allocated_invoices', v_alloc, 'unallocated', v_left);
end $$;

-- ---------------------------------------------------------------------
-- 6. Trésorerie : comptes et mouvements manuels
-- ---------------------------------------------------------------------
create function public.cash_account_create(p_name text, p_opening numeric, p_opening_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('finance.write');
  insert into public.cash_accounts (id, name, opening_balance, opening_date) values (v_id, btrim(p_name), coalesce(p_opening, 0), p_opening_date);
  perform private.write_audit(private.current_company(), 'finance.cash_account', 'cash_account', v_id::text, btrim(p_name), null,
    jsonb_build_object('opening', p_opening), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.cash_movement_add(p_account uuid, p_direction text, p_amount numeric, p_moved_on date, p_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); a public.cash_accounts%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into a from public.cash_accounts where id = p_account and company_id = private.current_company();
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not a.active then raise exception 'FINANCE_ACCOUNT_INACTIVE' using errcode = '55000'; end if;
  if p_moved_on < a.opening_date then raise exception 'FINANCE_BEFORE_OPENING' using errcode = '22023'; end if;
  insert into public.cash_movements (id, account_id, direction, amount, moved_on, label)
  values (v_id, a.id, p_direction, p_amount, p_moved_on, btrim(p_label));
  perform private.write_audit(a.company_id, 'finance.cash_movement', 'cash_account', a.id::text, a.name, null,
    jsonb_build_object('direction', p_direction, 'amount', p_amount, 'label', p_label), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 7. Relances automatiques
-- ---------------------------------------------------------------------
-- Crée les relances manquantes pour les factures échues. Idempotent : une relance par niveau et par facture.
create function public.finance_generate_reminders(p_as_of date default current_date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r record; v_late int; v_level int; v_n int := 0; v_bal numeric;
begin
  perform private.require_perm('finance.write');
  for r in select i.id, i.code, i.client_id, i.total, i.credited_amount, i.paid_amount, coalesce(i.due_date, i.issue_date) as due
    from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid') loop
    v_late := p_as_of - r.due;
    v_bal := r.total - r.credited_amount - r.paid_amount;
    if v_late >= 1 and v_bal > 0 then
      v_level := case when v_late <= 30 then 1 when v_late <= 60 then 2 else 3 end;
      insert into public.finance_reminders (company_id, invoice_id, level, days_late, balance)
      values (v_co, r.id, v_level, v_late, v_bal)
      on conflict (company_id, invoice_id, level) do nothing;
      if found then v_n := v_n + 1; end if;
    end if;
  end loop;
  perform private.write_audit(v_co, 'finance.reminders_generate', 'company', v_co::text, null, null,
    jsonb_build_object('created', v_n, 'as_of', p_as_of), '{}'::jsonb, 'rpc');
  return v_n;
end $$;

create function public.finance_reminder_mark_sent(p_reminder uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text;
begin
  perform private.require_perm('finance.write');
  select status into v_status from public.finance_reminders where id = p_reminder and company_id = v_co for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'pending' then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  update public.finance_reminders set status = 'sent', sent_at = now(), sent_by = auth.uid() where id = p_reminder;
  perform private.write_audit(v_co, 'finance.reminder_sent', 'finance_reminder', p_reminder::text, null, null, '{"status":"sent"}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Balances âgées
-- ---------------------------------------------------------------------
create function public.finance_aging_clients(p_as_of date default current_date)
returns table (cli_id uuid, cli_name text, cur numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, total numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
    select c.id, c.name,
      coalesce(sum(b.bal) filter (where b.late <= 0), 0),
      coalesce(sum(b.bal) filter (where b.late between 1 and 30), 0),
      coalesce(sum(b.bal) filter (where b.late between 31 and 60), 0),
      coalesce(sum(b.bal) filter (where b.late between 61 and 90), 0),
      coalesce(sum(b.bal) filter (where b.late > 90), 0),
      coalesce(sum(b.bal), 0)
    from (select i.client_id, (i.total - i.credited_amount - i.paid_amount) bal, p_as_of - coalesce(i.due_date, i.issue_date) late
            from public.invoices i where i.company_id = private.current_company() and i.status in ('issued', 'partially_paid')) b
    join public.clients c on c.id = b.client_id
    group by c.id, c.name
    having sum(b.bal) > 0
    order by sum(b.bal) desc;
end $$;

create function public.finance_aging_suppliers(p_as_of date default current_date)
returns table (sup_id uuid, sup_name text, cur numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, total numeric, disputed numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
    select s.id, s.name,
      coalesce(sum(b.bal) filter (where b.late <= 0 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late between 1 and 30 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late between 31 and 60 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late between 61 and 90 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late > 90 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal), 0),
      coalesce(sum(b.bal) filter (where b.st = 'disputed'), 0)
    from (select f.supplier_id, f.status st, (f.total - f.paid_amount) bal, p_as_of - f.due_date late
            from public.supplier_invoices f where f.company_id = private.current_company() and f.status in ('open', 'partially_paid', 'disputed')) b
    join public.suppliers s on s.id = b.supplier_id
    group by s.id, s.name
    having sum(b.bal) > 0
    order by sum(b.bal) desc;
end $$;

-- ---------------------------------------------------------------------
-- 9. Trésorerie et prévisions
-- ---------------------------------------------------------------------
-- Position de trésorerie consolidée à une date (soldes d'ouverture + flux jusqu'à cette date).
create function public.treasury_position(p_as_of date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_start date; v_open numeric; v_rec numeric; v_pay numeric; v_in numeric; v_out numeric;
begin
  perform private.require_perm('finance.read');
  select min(opening_date), coalesce(sum(opening_balance), 0) into v_start, v_open
    from public.cash_accounts where company_id = v_co and opening_date <= p_as_of;
  if v_start is null then return jsonb_build_object('as_of', p_as_of, 'opening', 0, 'receipts', 0, 'payments', 0, 'manual_in', 0, 'manual_out', 0, 'balance', 0); end if;
  select coalesce(sum(amount), 0) into v_rec from public.invoice_payments where company_id = v_co and paid_on between v_start and p_as_of;
  select coalesce(sum(amount), 0) into v_pay from public.supplier_payments where company_id = v_co and paid_on between v_start and p_as_of;
  select coalesce(sum(m.amount) filter (where m.direction = 'in'), 0), coalesce(sum(m.amount) filter (where m.direction = 'out'), 0)
    into v_in, v_out from public.cash_movements m join public.cash_accounts a on a.id = m.account_id
    where m.company_id = v_co and m.moved_on between v_start and p_as_of;
  return jsonb_build_object('as_of', p_as_of, 'opening', v_open, 'receipts', v_rec, 'payments', v_pay,
    'manual_in', v_in, 'manual_out', v_out, 'balance', v_open + v_rec + v_in - v_pay - v_out);
end $$;

-- Prévisions hebdomadaires : encaissements attendus (soldes clients à échoir, retards dans la 1re semaine,
-- taux d'encaissement appliqué) et décaissements (factures fournisseurs non litigieuses).
create function public.treasury_forecast(p_from date default current_date, p_weeks int default 13, p_collection_pct numeric default 100)
returns table (week_no int, week_start date, receipts numeric, payments numeric, net numeric, projected_balance numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pos numeric; w int;
begin
  perform private.require_perm('finance.read');
  if p_weeks < 1 or p_weeks > 53 then raise exception 'FINANCE_BAD_HORIZON' using errcode = '22023'; end if;
  if p_collection_pct is null or p_collection_pct < 0 or p_collection_pct > 100 then raise exception 'FINANCE_BAD_PCT' using errcode = '22023'; end if;
  v_pos := (public.treasury_position(p_from) ->> 'balance')::numeric;
  for w in 0..p_weeks - 1 loop
    week_no := w + 1;
    week_start := p_from + (w * 7);
    receipts := (select coalesce(sum(bal), 0) * p_collection_pct / 100 from (
        select (i.total - i.credited_amount - i.paid_amount) bal, coalesce(i.due_date, i.issue_date) due
          from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid')) x
      where (w = 0 and x.due <= p_from + 6) or (w > 0 and x.due >= week_start and x.due < week_start + 7));
    payments := (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices
      where company_id = v_co and status in ('open', 'partially_paid')
        and ((w = 0 and due_date <= p_from + 6) or (w > 0 and due_date >= week_start and due_date < week_start + 7)));
    net := receipts - payments;
    v_pos := v_pos + net;
    projected_balance := v_pos;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 10. Tableau de bord financier
-- ---------------------------------------------------------------------
create function public.finance_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb; v_recv numeric; v_sales90 numeric;
begin
  perform private.require_perm('finance.read');
  select coalesce(sum(total - credited_amount - paid_amount), 0) into v_recv from public.invoices
    where company_id = v_co and status in ('issued', 'partially_paid');
  select coalesce(sum(total), 0) into v_sales90 from public.invoices
    where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= current_date - 90;
  select jsonb_build_object(
    'treasury', public.treasury_position(current_date),
    'receivables', v_recv,
    'receivables_overdue', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices
        where company_id = v_co and status in ('issued', 'partially_paid') and coalesce(due_date, issue_date) < current_date),
    'dso_days', case when v_sales90 = 0 then null else round(v_recv / (v_sales90 / 90), 1) end,
    'payables', (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices where company_id = v_co and status in ('open', 'partially_paid', 'disputed')),
    'payables_due_14d', (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices
        where company_id = v_co and status in ('open', 'partially_paid') and due_date <= current_date + 14),
    'payables_disputed', (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices where company_id = v_co and status = 'disputed'),
    'forecast_4w_net', (select coalesce(sum(net), 0) from public.treasury_forecast(current_date, 4, 100)),
    'reminders_pending', (select count(*) from public.finance_reminders where company_id = v_co and status = 'pending'),
    'top_overdue_clients', (select coalesce(jsonb_agg(jsonb_build_object('client', x.cli_name, 'overdue', x.total - x.cur) order by x.total - x.cur desc), '[]'::jsonb)
        from (select * from public.finance_aging_clients(current_date) where total - cur > 0 limit 5) x)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 11. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.supplier_invoice_record(uuid, text, date, date, numeric, text, uuid)',
    'public.supplier_invoice_dispute(uuid, text)',
    'public.supplier_invoice_resolve(uuid)',
    'public.supplier_payment_record(uuid, numeric, date, text, text)',
    'public.customer_receipt_record(uuid, numeric, date, text, text)',
    'public.cash_account_create(text, numeric, date)',
    'public.cash_movement_add(uuid, text, numeric, date, text)',
    'public.finance_generate_reminders(date)',
    'public.finance_reminder_mark_sent(uuid)',
    'public.finance_aging_clients(date)',
    'public.finance_aging_suppliers(date)',
    'public.treasury_position(date)',
    'public.treasury_forecast(date, int, numeric)',
    'public.finance_dashboard()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ===== 0023_executive.sql =====
-- =====================================================================
-- 0023_executive — Dashboards exécutifs (DG) : CA, marge, stocks, production, achats, MRP, finance, qualité, expéditions
--  Une seule fonction (executive_dashboard) assemble les indicateurs ; les blocs des modules existants réutilisent
--  leur fonction de tableau de bord (production_dashboard, quality_dashboard, shipping_dashboard, finance_dashboard).
--  Droits :
--    dashboard.executive : accès à la vue DG (admin, direction) ;
--    chaque bloc n'est renvoyé que si l'utilisateur détient aussi le droit de lecture du module (sinon null) :
--    invoices.read (CA), costs.read + invoices.read (marge), stock.read, production.read, purchases.read,
--    mrp.read, finance.read, quality.read, shipments.read.
--  Alertes stratégiques : calculées dans la même fonction (règles documentées dans le corps).
--  Temps réel : la page interroge la fonction toutes les 30 secondes (pas d'abonnement temps réel en base).
--  Marge : estimation (CA − factures fournisseurs du même mois) ; le coût de revient par article n'est pas encore suivi.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('dashboard.executive', 'dashboard', 'Voir le tableau de bord DG', 'Vue exécutive multi-modules, indicateurs et alertes stratégiques')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin' and p.code = 'dashboard.executive')
  or (r.code = 'direction' and p.code = 'dashboard.executive'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Vue DG
-- ---------------------------------------------------------------------
create function public.executive_dashboard(p_months int default 12) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company();
  v_from date := (date_trunc('month', current_date) - make_interval(months => coalesce(p_months, 12) - 1))::date;
  v_month date := date_trunc('month', current_date)::date;
  v_prev date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_access jsonb := '{}'::jsonb;
  v_ca jsonb := null; v_marge jsonb := null; v_stocks jsonb := null; v_prod jsonb := null; v_achats jsonb := null;
  v_mrp jsonb := null; v_fin jsonb := null; v_qual jsonb := null; v_exp jsonb := null;
  v_cur numeric; v_prev_ca numeric; v_alerts jsonb := '[]'::jsonb;
  v_has_inv boolean := private.has_perm('invoices.read');
  v_has_cost boolean := private.has_perm('costs.read') and private.has_perm('invoices.read');
begin
  perform private.require_perm('dashboard.executive');
  if coalesce(p_months, 12) not between 3 and 24 then raise exception 'EXEC_BAD_PERIOD' using errcode = '22023'; end if;

  -- CA et marge (mois, tendance)
  if v_has_inv then
    select coalesce(sum(total) filter (where issue_date >= v_month), 0), coalesce(sum(total) filter (where issue_date >= v_prev and issue_date < v_month), 0)
      into v_cur, v_prev_ca
      from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid');
    v_ca := jsonb_build_object(
      'current_month', v_cur, 'previous_month', v_prev_ca,
      'ytd', (select coalesce(sum(total), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid')
              and issue_date >= date_trunc('year', current_date)::date),
      'open_balance', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid')),
      'series', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.mo, 'YYYY-MM'), 'amount', coalesce(r.amt, 0)) order by m.mo), '[]'::jsonb)
                 from generate_series(v_from::timestamp, v_month::timestamp, interval '1 month') m(mo)
                 left join (select date_trunc('month', issue_date)::timestamp mo, sum(total) amt from public.invoices
                            where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_from group by 1) r on r.mo = m.mo));
  end if;

  if v_has_cost then
    v_marge := jsonb_build_object(
      'estimate', 'CA − factures fournisseurs du même mois',
      'series', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.mo, 'YYYY-MM'), 'revenue', coalesce(r.amt, 0), 'cost', coalesce(c.amt, 0),
                   'margin', coalesce(r.amt, 0) - coalesce(c.amt, 0),
                   'rate_pct', case when coalesce(r.amt, 0) = 0 then null else round(100 * (coalesce(r.amt, 0) - coalesce(c.amt, 0)) / r.amt, 1) end) order by m.mo), '[]'::jsonb)
                 from generate_series(v_from::timestamp, v_month::timestamp, interval '1 month') m(mo)
                 left join (select date_trunc('month', issue_date)::timestamp mo, sum(total) amt from public.invoices
                            where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_from group by 1) r on r.mo = m.mo
                 left join (select date_trunc('month', invoice_date)::timestamp mo, sum(total) amt from public.supplier_invoices
                            where company_id = v_co and status <> 'cancelled' and invoice_date >= v_from group by 1) c on c.mo = m.mo),
      'current_month_rate_pct', (select case when coalesce(sum(total), 0) = 0 then null else round(100 * (
                 (select coalesce(sum(total), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_month)
                 - (select coalesce(sum(total), 0) from public.supplier_invoices where company_id = v_co and status <> 'cancelled' and invoice_date >= v_month))
                 / sum(total), 1) end from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_month));
  end if;

  -- Stocks
  if private.has_perm('stock.read') then
    v_stocks := jsonb_build_object(
      'finished_units', (select coalesce(sum(qty_on_hand), 0) from public.variant_stock where company_id = v_co),
      'finished_reserved', (select coalesce(sum(qty_reserved), 0) from public.variant_stock where company_id = v_co),
      'finished_value', (select coalesce(sum(vs.qty_on_hand * coalesce(pv.price, 0)), 0) from public.variant_stock vs
                          join public.product_variants pv on pv.id = vs.variant_id where vs.company_id = v_co),
      'raw_materials_in_stock', (select count(distinct material_id) from public.stock_lots where company_id = v_co and qty_remaining > 0),
      'raw_lots_open', (select count(*) from public.stock_lots where company_id = v_co and qty_remaining > 0));
  end if;

  -- Production (réutilise production_dashboard)
  if private.has_perm('production.read') then
    v_prod := public.production_dashboard();
  end if;

  -- Achats
  if private.has_perm('purchases.read') then
    v_achats := jsonb_build_object(
      'open_orders', (select count(*) from public.purchase_orders where company_id = v_co and status in ('sent', 'partial')),
      'open_value', (select coalesce(sum(total_amount), 0) from public.purchase_orders where company_id = v_co and status in ('sent', 'partial')),
      'late_orders', (select count(*) from public.purchase_orders where company_id = v_co and status in ('sent', 'partial') and expected_date < current_date),
      'received_this_month', (select coalesce(sum(total_amount), 0) from public.purchase_orders where company_id = v_co and status = 'received' and received_date >= v_month));
  end if;

  -- MRP (dernier calcul)
  if private.has_perm('mrp.read') then
    v_mrp := (select jsonb_build_object('run', r.name, 'as_of', r.as_of, 'proposed', count(s.id) filter (where s.status = 'proposed'),
                 'late', count(s.id) filter (where s.status = 'proposed' and s.late))
              from (select * from public.mrp_runs where company_id = v_co order by created_at desc limit 1) r
              left join public.mrp_run_suggestions s on s.run_id = r.id
              group by r.id, r.name, r.as_of);
  end if;

  -- Finance, qualité, expéditions (réutilisent leurs fonctions)
  if private.has_perm('finance.read') then
    v_fin := public.finance_dashboard() || jsonb_build_object('forecast', (
      select coalesce(jsonb_agg(jsonb_build_object('week', week_no, 'start', week_start, 'balance', projected_balance, 'net', net) order by week_no), '[]'::jsonb)
      from public.treasury_forecast(current_date, 13, 100)));
  end if;
  if private.has_perm('quality.read') then v_qual := public.quality_dashboard(); end if;
  if private.has_perm('shipments.read') then v_exp := public.shipping_dashboard(); end if;

  v_access := jsonb_build_object('ca', v_has_inv, 'marge', v_has_cost, 'stocks', private.has_perm('stock.read'),
    'production', private.has_perm('production.read'), 'achats', private.has_perm('purchases.read'), 'mrp', private.has_perm('mrp.read'),
    'finance', private.has_perm('finance.read'), 'qualite', private.has_perm('quality.read'), 'expeditions', private.has_perm('shipments.read'));

  -- Alertes stratégiques (règles)
  if v_fin is not null then
    if coalesce((v_fin->'treasury'->>'balance')::numeric, 0) < 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'finance', 'title', 'Trésorerie négative',
        'detail', 'Le solde de trésorerie consolidé est négatif.', 'link', '/finance/tresorerie'));
    end if;
    if exists (select 1 from jsonb_array_elements(v_fin->'forecast') f where (f->>'balance')::numeric < 0) then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'finance', 'title', 'Point bas prévisionnel négatif',
        'detail', 'La prévision à 13 semaines passe sous zéro : anticiper un encaissement ou différer un règlement.', 'link', '/finance/previsions'));
    end if;
    if coalesce((v_fin->>'receivables')::numeric, 0) > 0 and coalesce((v_fin->>'receivables_overdue')::numeric, 0) / (v_fin->>'receivables')::numeric > 0.3 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'finance', 'title', 'Créances échues élevées',
        'detail', 'Plus de 30 % des créances clients sont échues.', 'link', '/finance/balances'));
    end if;
    if coalesce((v_fin->>'payables_disputed')::numeric, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'info', 'module', 'finance', 'title', 'Factures fournisseurs en litige',
        'detail', 'Des factures fournisseurs sont bloquées pour litige.', 'link', '/finance/fournisseurs'));
    end if;
  end if;
  if v_ca is not null and extract(day from current_date) >= 15 and v_prev_ca > 0 and v_cur < 0.6 * v_prev_ca then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'ca', 'title', 'CA en retard sur le mois précédent',
      'detail', 'Le CA du mois est inférieur à 60 % du mois précédent à mi-parcours.', 'link', '/commercial'));
  end if;
  if v_marge is not null and v_marge->>'current_month_rate_pct' is not null and (v_marge->>'current_month_rate_pct')::numeric < 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'marge', 'title', 'Marge négative ce mois-ci',
      'detail', 'Les achats fournisseurs du mois dépassent le CA facturé (estimation).', 'link', '/finance/fournisseurs'));
  end if;
  if v_prod is not null then
    if coalesce((v_prod->>'late')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'production', 'title', 'Ordres de fabrication en retard',
        'detail', (v_prod->>'late') || ' ordre(s) dépassent leur date de fin.', 'link', '/production/ordres'));
    end if;
    if exists (select 1 from jsonb_array_elements(v_prod->'workload') w where (w->>'overloaded')::boolean) then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'production', 'title', 'Poste de travail surchargé',
        'detail', 'Au moins un poste dépasse 20 jours de charge.', 'link', '/production/postes'));
    end if;
  end if;
  if v_qual is not null then
    if coalesce((v_qual->'nc_by_severity'->>'critical')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'qualite', 'title', 'Non-conformité critique ouverte',
        'detail', 'Une non-conformité critique attend son confinement ou sa clôture.', 'link', '/quality/non-conformites'));
    end if;
    if coalesce((v_qual->>'actions_overdue')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'qualite', 'title', 'Actions correctives en retard',
        'detail', (v_qual->>'actions_overdue') || ' action(s) ont dépassé leur échéance.', 'link', '/quality/plans'));
    end if;
  end if;
  if v_exp is not null then
    if coalesce((v_exp->>'late_open')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'expeditions', 'title', 'Expéditions en retard',
        'detail', (v_exp->>'late_open') || ' expédition(s) ouvertes dépassent la date due.', 'link', '/shipments'));
    end if;
    if coalesce((v_exp->>'exceptions_open')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'expeditions', 'title', 'Incidents de transport non résolus',
        'detail', (v_exp->>'exceptions_open') || ' expédition(s) signalées en incident.', 'link', '/shipments'));
    end if;
  end if;
  if v_mrp is not null and coalesce((v_mrp->>'late')::int, 0) > 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'mrp', 'title', 'Commandes d’approvisionnement en retard',
      'detail', (v_mrp->>'late') || ' besoin(s) arrivent trop tard : la date de commande est dépassée.', 'link', '/mrp/runs'));
  end if;
  if v_stocks is not null and coalesce((v_stocks->>'finished_units')::numeric, 0) = 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'info', 'module', 'stocks', 'title', 'Aucun produit fini en stock',
      'detail', 'Le stock de produits finis est vide.', 'link', '/variants/catalog'));
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'period_months', coalesce(p_months, 12),
    'access', v_access,
    'ca', v_ca, 'marge', v_marge, 'stocks', v_stocks, 'production', v_prod, 'achats', v_achats,
    'mrp', v_mrp, 'finance', v_fin, 'qualite', v_qual, 'expeditions', v_exp,
    'alerts', v_alerts);
end $$;

revoke execute on function public.executive_dashboard(int) from public, anon;
grant execute on function public.executive_dashboard(int) to authenticated;


-- ===== 0024_copilot.sql =====
-- =====================================================================
-- 0024_copilot — MB Confection AI Copilot : historique des conversations et analyses ERP
--  Tables :
--    copilot_conversations : conversations d'un utilisateur (titre, dates) — visibles par leur auteur seul
--    copilot_messages      : messages (question, réponse) avec leur charge structurée (payload) — auteur seul
--  Analyses (fonctions, droits contrôlés par module) :
--    copilot_client_profit    : rentabilité client (CA TTC facturé, avoirs, encours, marge estimée, taux de couverture des coûts)
--    copilot_product_profit   : rentabilité article (quantité, CA HT, coût standard BOM, marge estimée)
--    copilot_purchase_suggestions   : achats à lancer (besoins MRP non commandés + sous stock de sécurité)
--    copilot_production_suggestions : ordres à lancer (demande client confirmée non couverte par les ordres et le stock fini)
--  L'interprétation des questions et la mise en forme des réponses sont faites côté application (moteur à règles, sans LLM).
--  Marge : estimation (coût standard BOM figé de la version validée ; sans coût figé, la ligne n'est pas valorisée et la couverture baisse).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission et rôles
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('copilot.use', 'copilot', 'Utiliser le copilote IA', 'Questions en langage naturel, analyses et historique personnel des conversations')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'copilot.use'
 where r.code in ('admin', 'direction', 'finance', 'production', 'qualite', 'commercial', 'achat', 'magasin')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Historique des conversations
-- ---------------------------------------------------------------------
create table public.copilot_conversations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  user_id     uuid not null default auth.uid(),
  title       text not null check (length(btrim(title)) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index copilot_conversations_user_idx on public.copilot_conversations (company_id, user_id, updated_at desc);

create table public.copilot_messages (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  conversation_id uuid not null references public.copilot_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (length(content) between 1 and 8000),
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index copilot_messages_conv_idx on public.copilot_messages (conversation_id, created_at);

alter table public.copilot_conversations enable row level security;
alter table public.copilot_messages enable row level security;
create policy copilot_conversations_own on public.copilot_conversations for all to authenticated
  using (company_id = private.current_company() and user_id = auth.uid() and private.has_perm('copilot.use'))
  with check (company_id = private.current_company() and user_id = auth.uid() and private.has_perm('copilot.use'));
create policy copilot_messages_own on public.copilot_messages for all to authenticated
  using (company_id = private.current_company() and private.has_perm('copilot.use')
         and exists (select 1 from public.copilot_conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  with check (company_id = private.current_company() and private.has_perm('copilot.use')
         and exists (select 1 from public.copilot_conversations c where c.id = conversation_id and c.user_id = auth.uid()));
revoke all on public.copilot_conversations, public.copilot_messages from anon;
grant select, insert, update, delete on public.copilot_conversations, public.copilot_messages to authenticated;

-- ---------------------------------------------------------------------
-- 3. Rentabilité client
-- ---------------------------------------------------------------------
create function public.copilot_client_profit(p_months int default 12)
returns table (client_id uuid, client_name text, invoiced numeric, credited numeric, net_revenue numeric, open_balance numeric,
               overdue_balance numeric, margin numeric, margin_pct numeric, cost_coverage_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
  v_from date := (date_trunc('month', current_date) - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))::date;
  v_cost boolean;
begin
  perform private.require_perm('invoices.read');
  v_cost := private.has_perm('costs.read');
  return query
  with inv as (
    select i.id, i.client_id, i.total, i.credited_amount from public.invoices i
     where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid') and i.issue_date >= v_from),
  acost as (
    select a.id as article_id, bc.snap_total as cost from public.articles a
      join public.bom_version_costs bc on bc.version_id = a.active_version_id where a.company_id = v_co),
  ln as (
    select inv.client_id,
           il.qty * il.unit_price * (1 - il.discount_pct / 100) as rev,
           il.qty * ac.cost as cst,
           (ac.cost is not null) as known
      from inv join public.invoice_lines il on il.invoice_id = inv.id
      left join public.sales_order_lines sl on sl.id = il.order_line_id
      left join acost ac on ac.article_id = sl.article_id),
  lagg as (
    select ln.client_id as cid, sum(ln.rev) as ra, sum(ln.rev) filter (where ln.known) as rk, sum(ln.cst) filter (where ln.known) as ck
      from ln group by ln.client_id),
  iagg as (
    select inv.client_id as cid, sum(inv.total) as invoiced, sum(inv.credited_amount) as credited from inv group by inv.client_id),
  bagg as (
    select i.client_id as cid, sum(i.total - i.credited_amount - i.paid_amount) as open_bal,
           sum(i.total - i.credited_amount - i.paid_amount) filter (where coalesce(i.due_date, i.issue_date) < current_date) as overdue_bal
      from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid') group by i.client_id)
  select c.id, c.name,
         coalesce(ia.invoiced, 0),
         coalesce(ia.credited, 0),
         coalesce(ia.invoiced, 0) - coalesce(ia.credited, 0),
         coalesce(ba.open_bal, 0),
         coalesce(ba.overdue_bal, 0),
         case when v_cost then coalesce(la.rk, 0) - coalesce(la.ck, 0) end,
         case when v_cost and coalesce(la.rk, 0) > 0 then round(100 * (la.rk - la.ck) / la.rk, 1) end,
         case when coalesce(la.ra, 0) > 0 then round(100 * coalesce(la.rk, 0) / la.ra, 1) end
    from public.clients c
    left join iagg ia on ia.cid = c.id
    left join lagg la on la.cid = c.id
    left join bagg ba on ba.cid = c.id
   where c.company_id = v_co and ia.cid is not null
   order by coalesce(ia.invoiced, 0) desc;
end $$;

-- ---------------------------------------------------------------------
-- 4. Rentabilité article
-- ---------------------------------------------------------------------
create function public.copilot_product_profit(p_months int default 12)
returns table (article_id uuid, article_ref text, article_name text, qty_sold numeric, revenue numeric, unit_cost numeric,
               margin numeric, margin_pct numeric, cost_coverage_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
  v_from date := (date_trunc('month', current_date) - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))::date;
  v_cost boolean;
begin
  perform private.require_perm('invoices.read');
  v_cost := private.has_perm('costs.read');
  return query
  with inv as (select i.id from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid') and i.issue_date >= v_from),
  acost as (
    select a.id as aid, bc.snap_total as cost from public.articles a
      join public.bom_version_costs bc on bc.version_id = a.active_version_id where a.company_id = v_co),
  ln as (
    select sl.article_id as aid, il.qty as q, il.qty * il.unit_price * (1 - il.discount_pct / 100) as rev,
           il.qty * ac.cost as cst, (ac.cost is not null) as known
      from inv join public.invoice_lines il on il.invoice_id = inv.id
      join public.sales_order_lines sl on sl.id = il.order_line_id
      left join acost ac on ac.aid = sl.article_id)
  select a.id, a.internal_ref, a.name,
         coalesce(sum(ln.q), 0),
         coalesce(sum(ln.rev), 0),
         case when v_cost and sum(ln.q) filter (where ln.known) > 0 then round(sum(ln.cst) filter (where ln.known) / sum(ln.q) filter (where ln.known), 2) end,
         case when v_cost then coalesce(sum(ln.rev) filter (where ln.known), 0) - coalesce(sum(ln.cst) filter (where ln.known), 0) end,
         case when v_cost and coalesce(sum(ln.rev) filter (where ln.known), 0) > 0 then
           round(100 * (sum(ln.rev) filter (where ln.known) - sum(ln.cst) filter (where ln.known)) / sum(ln.rev) filter (where ln.known), 1) end,
         case when coalesce(sum(ln.rev), 0) > 0 then round(100 * coalesce(sum(ln.rev) filter (where ln.known), 0) / sum(ln.rev), 1) end
    from ln
    join public.articles a on a.id = ln.aid
   group by a.id, a.internal_ref, a.name
   order by coalesce(sum(ln.rev), 0) desc;
end $$;

-- ---------------------------------------------------------------------
-- 5. Suggestions d'achat
-- ---------------------------------------------------------------------
create function public.copilot_purchase_suggestions()
returns table (kind text, material_id uuid, material_code text, material_name text, qty numeric, due_date date, reason text, severity text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_run uuid;
begin
  perform private.require_perm('purchases.read');
  select r.id into v_run from public.mrp_runs r where r.company_id = v_co order by r.created_at desc limit 1;
  return query
  select 'mrp'::text, s.material_id, m.code, m.name, s.qty, s.release_date,
         case when s.late then 'Besoin MRP : date de commande dépassée' else 'Besoin MRP à commander avant le ' || s.release_date end,
         case when s.late then 'critical' else 'warning' end
    from public.mrp_run_suggestions s
    join public.bom_materials m on m.id = s.material_id
   where v_run is not null and s.run_id = v_run and s.status = 'proposed' and private.has_perm('mrp.read');
  if private.has_perm('stock.read') then
    return query
    select 'safety'::text, t.material_id, m.code, m.name, sum(greatest(t.safety_qty - coalesce(oh.q, 0), 0)), null::date,
           'Stock sous le seuil de sécurité', 'warning'
      from public.stock_thresholds t
      join public.bom_materials m on m.id = t.material_id
      left join (select l.material_id, l.warehouse_id, sum(l.qty_remaining) q from public.stock_lots l
                  where l.company_id = v_co group by l.material_id, l.warehouse_id) oh
        on oh.material_id = t.material_id and oh.warehouse_id = t.warehouse_id
     where t.company_id = v_co
     group by t.material_id, m.code, m.name
    having sum(greatest(t.safety_qty - coalesce(oh.q, 0), 0)) > 0;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Suggestions de production
-- ---------------------------------------------------------------------
create function public.copilot_production_suggestions()
returns table (article_id uuid, article_ref text, article_name text, demand numeric, planned numeric, finished_stock numeric, gap numeric,
               earliest_due date, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('production.read');
  return query
  with dem as (
    select sl.article_id as aid, sum(sl.qty) as q, min(sl.due_date) as due
      from public.sales_order_lines sl join public.sales_orders so on so.id = sl.order_id
     where sl.company_id = v_co and so.status = 'confirmed' group by sl.article_id),
  pla as (
    select po.article_id as aid, sum(po.qty_planned) as q from public.production_orders po
     where po.company_id = v_co and po.status in ('planned', 'launched', 'in_progress', 'suspended') group by po.article_id),
  stk as (
    select pm.article_id as aid, sum(vs.qty_on_hand - vs.qty_reserved)::numeric as q
      from public.product_master pm
      join public.product_variants pv on pv.product_id = pm.id
      join public.variant_stock vs on vs.variant_id = pv.id
     where pm.company_id = v_co and pm.article_id is not null group by pm.article_id)
  select a.id, a.internal_ref, a.name, d.q, coalesce(p.q, 0), coalesce(s.q, 0),
         d.q - coalesce(p.q, 0) - coalesce(s.q, 0), d.due,
         'Demande client confirmée non couverte par les ordres ni par le stock fini'
    from dem d
    join public.articles a on a.id = d.aid
    left join pla p on p.aid = d.aid
    left join stk s on s.aid = d.aid
   where d.q - coalesce(p.q, 0) - coalesce(s.q, 0) > 0
   order by d.due;
end $$;

-- ---------------------------------------------------------------------
-- 7. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.copilot_client_profit(int)',
    'public.copilot_product_profit(int)',
    'public.copilot_purchase_suggestions()',
    'public.copilot_production_suggestions()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ===== 0025_table_meta.sql =====
-- =====================================================================
-- 0025_table_meta — Données de tableau : responsable (auteur) exposé sur la vue des ordres de fabrication.
--  Ajout en fin de liste de colonnes : la vue existante reste compatible (create or replace).
-- =====================================================================
create or replace view public.production_order_metrics with (security_invoker = true) as
with logs as (
  select order_id, sum(hours) hours, sum(qty_good) good, sum(qty_scrap) scrap, max(log_date) last_log
  from public.production_logs group by order_id
)
select o.id, o.company_id, o.number, o.status, o.article_id, a.internal_ref as article_ref, a.name as article_name,
       o.work_center_id, w.code as work_center_code, w.name as work_center_name, w.hours_per_day, w.efficiency_pct,
       o.qty_planned, o.std_minutes_per_unit, o.planned_start, o.planned_end, o.launched_at, o.finished_at, o.closed_at, o.sales_order_id,
       round(o.qty_planned * o.std_minutes_per_unit / 60, 2) as planned_hours,
       coalesce(l.hours, 0) as hours_worked,
       coalesce(l.good, 0) as qty_good,
       coalesce(l.scrap, 0) as qty_scrap,
       case when coalesce(l.good, 0) + coalesce(l.scrap, 0) = 0 then null
            else round(100 * l.good / (l.good + l.scrap), 1) end as yield_pct,
       case when coalesce(l.hours, 0) = 0 then null else round(l.good / l.hours, 2) end as productivity,
       case
         when o.status <> 'done' and o.planned_end < current_date then current_date - o.planned_end
         when o.status = 'done' and o.finished_at::date > o.planned_end then o.finished_at::date - o.planned_end
         else 0 end as late_days,
       o.created_by,
       o.launched_by
  from public.production_orders o
  join public.articles a on a.id = o.article_id
  left join public.work_centers w on w.id = o.work_center_id
  left join logs l on l.order_id = o.id;
grant select on public.production_order_metrics to authenticated;


-- ===== 0026_client_complaints.sql =====
-- =====================================================================
-- 0026_client_complaints — Réclamations clients (fiche Client 360°)
--  Table client_complaints : réclamation d'un client, éventuellement liée à une commande.
--  Cycle : ouverte → en cours → résolue (solution écrite, 10 caractères minimum) → close.
--  Droits : clients.read (voir), clients.write (ouvrir et traiter) — mêmes droits que la fiche client.
-- =====================================================================

create table public.client_complaints (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  client_id     uuid not null references public.clients(id) on delete restrict,
  order_id      uuid references public.sales_orders(id) on delete set null,
  subject       text not null check (length(btrim(subject)) between 3 and 160),
  description   text check (description is null or length(description) <= 2000),
  severity      text not null default 'minor' check (severity in ('minor', 'major', 'critical')),
  status        text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  resolution    text check (resolution is null or length(resolution) <= 2000),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  resolved_at   timestamptz,
  closed_at     timestamptz,
  unique (company_id, number),
  check (status <> 'resolved' or (resolution is not null and resolved_at is not null)),
  check (status <> 'closed' or closed_at is not null)
);
create index client_complaints_client_idx on public.client_complaints (client_id, created_at desc);

create function private.complaint_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := 'REC-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, 'client_complaint')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.complaint_number() from public, anon, authenticated;
create trigger client_complaints_number_i before insert on public.client_complaints for each row execute function private.complaint_number();

-- La réclamation doit concerner un client, et une commande, de la même société.
create function private.client_complaints_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.clients c where c.id = new.client_id and c.company_id = new.company_id) then
    raise exception 'COMPLAINT_CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.order_id is not null and not exists (select 1 from public.sales_orders o where o.id = new.order_id and o.company_id = new.company_id and o.client_id = new.client_id) then
    raise exception 'COMPLAINT_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.client_complaints_check() from public, anon, authenticated;
create trigger client_complaints_check_i before insert or update on public.client_complaints for each row execute function private.client_complaints_check();

alter table public.client_complaints enable row level security;
create policy client_complaints_select on public.client_complaints for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
revoke all on public.client_complaints from anon, authenticated;
grant select on public.client_complaints to authenticated;

create function public.complaint_open(p_client uuid, p_order uuid, p_subject text, p_description text, p_severity text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text; v_co uuid := private.current_company();
begin
  perform private.require_perm('clients.write');
  insert into public.client_complaints (id, client_id, order_id, subject, description, severity)
  values (v_id, p_client, p_order, btrim(p_subject), nullif(btrim(coalesce(p_description, '')), ''), p_severity)
  returning number into v_number;
  perform private.write_audit(v_co, 'client.complaint_open', 'client', p_client::text, v_number, null,
    jsonb_build_object('subject', p_subject, 'severity', p_severity), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Avancement : en cours (depuis ouverte), résolue (solution obligatoire), close (depuis résolue).
create function public.complaint_update(p_complaint uuid, p_status text, p_resolution text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_res text := nullif(btrim(coalesce(p_resolution, '')), '');
begin
  perform private.require_perm('clients.write');
  select * into c from public.client_complaints where id = p_complaint and company_id = private.current_company() for update;
  if not found then raise exception 'COMPLAINT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status = 'in_progress' and c.status = 'open' then
    update public.client_complaints set status = 'in_progress' where id = c.id;
  elsif p_status = 'resolved' and c.status in ('open', 'in_progress') then
    if v_res is null or length(v_res) < 10 then raise exception 'COMPLAINT_RESOLUTION_REQUIRED' using errcode = '22023'; end if;
    update public.client_complaints set status = 'resolved', resolution = v_res, resolved_at = now() where id = c.id;
  elsif p_status = 'closed' and c.status = 'resolved' then
    update public.client_complaints set status = 'closed', closed_at = now() where id = c.id;
  else
    raise exception 'COMPLAINT_BAD_STATUS' using errcode = '55000';
  end if;
  perform private.write_audit(c.company_id, 'client.complaint_update', 'client', c.client_id::text, c.number, null,
    jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

revoke execute on function public.complaint_open(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.complaint_update(uuid, text, text) from public, anon;
grant execute on function public.complaint_open(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.complaint_update(uuid, text, text) to authenticated;


-- ===== 0027_multicurrency.sql =====
-- =====================================================================
-- 0027_multicurrency — Devises, taux de change, TVA, export, écarts de change, reporting multi-devise
--  Convention : un taux = combien vaut 1 unité de la devise en devise de base (EUR par défaut).
--  Chaque facture client et facture fournisseur fige son taux à l'émission (base_total = équivalent base).
--  Les écarts réalisés (au règlement) et latents (sur le solde ouvert) se calculent à partir de ce taux figé.
--  Limites : les règlements fournisseur n'ont pas de devise propre (imputés à la devise de la facture) ;
--  les montants fournisseur restent à 2 décimales (colonnes existantes) : le TND, à 3 décimales, y est arrondi.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Référentiels : devises et taux de TVA (données réglementaires partagées)
-- ---------------------------------------------------------------------
create table public.currencies (
  code        char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name        text not null,
  minor_units int not null check (minor_units between 0 and 4),
  symbol      text not null
);
insert into public.currencies (code, name, minor_units, symbol) values
  ('EUR', 'Euro', 2, '€'),
  ('TND', 'Dinar tunisien', 3, 'DT'),
  ('USD', 'Dollar américain', 2, '$'),
  ('GBP', 'Livre sterling', 2, '£');
alter table public.currencies enable row level security;
create policy currencies_select on public.currencies for select to authenticated using (true);
revoke all on public.currencies from anon, authenticated;
grant select on public.currencies to authenticated;

create table public.vat_rates (
  code     text primary key,
  label    text not null,
  rate     numeric(5,2) not null check (rate >= 0 and rate <= 100),
  kind     text not null check (kind in ('standard', 'reduced', 'export', 'exempt')),
  country  char(2) not null default 'TN' check (country ~ '^[A-Z]{2}$')
);
insert into public.vat_rates (code, label, rate, kind, country) values
  ('TN_STD_19', 'TVA normale 19 %', 19, 'standard', 'TN'),
  ('TN_RED_13', 'TVA réduite 13 %', 13, 'reduced', 'TN'),
  ('TN_RED_7', 'TVA réduite 7 %', 7, 'reduced', 'TN'),
  ('EXPORT_0', 'Exportation (sans TVA)', 0, 'export', 'TN'),
  ('EXEMPT_0', 'Opération exonérée', 0, 'exempt', 'TN');
alter table public.vat_rates enable row level security;
create policy vat_rates_select on public.vat_rates for select to authenticated using (true);
revoke all on public.vat_rates from anon, authenticated;
grant select on public.vat_rates to authenticated;

-- ---------------------------------------------------------------------
-- 2. Réglages et taux par société
-- ---------------------------------------------------------------------
create table public.finance_settings (
  company_id    uuid primary key default private.current_company() references public.companies(id) on delete cascade,
  base_currency char(3) not null default 'EUR' references public.currencies(code),
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);
alter table public.finance_settings enable row level security;
create policy finance_settings_select on public.finance_settings for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.finance_settings from anon, authenticated;
grant select on public.finance_settings to authenticated;

create table public.exchange_rates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null default private.current_company() references public.companies(id) on delete cascade,
  rate_date  date not null,
  currency   char(3) not null references public.currencies(code),
  rate       numeric(18,8) not null check (rate > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (company_id, rate_date, currency)
);
create index exchange_rates_lookup_idx on public.exchange_rates (company_id, currency, rate_date desc);
alter table public.exchange_rates enable row level security;
create policy exchange_rates_select on public.exchange_rates for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.exchange_rates from anon, authenticated;
grant select on public.exchange_rates to authenticated;

-- Devise de base : EUR si rien n'est configuré.
create function private.base_currency() returns char(3)
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.base_currency from public.finance_settings s where s.company_id = private.current_company()), 'EUR')::char(3)
$$;
revoke execute on function private.base_currency() from public, anon;
grant execute on function private.base_currency() to authenticated;

-- Taux applicable à une date : le plus récent publié à cette date ou avant. Devise de base = 1.
create function public.fx_rate(p_currency text, p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_cur char(3) := upper(btrim(coalesce(p_currency, ''))); v_rate numeric;
begin
  if v_cur = private.base_currency() then return 1; end if;
  select r.rate into v_rate from public.exchange_rates r
   where r.company_id = private.current_company() and r.currency = v_cur and r.rate_date <= p_date
   order by r.rate_date desc limit 1;
  if v_rate is null then
    raise exception 'FX_RATE_MISSING' using errcode = 'P0002', detail = v_cur || ' ' || p_date::text;
  end if;
  return v_rate;
end $$;

-- Conversion d'un montant en devise de base, arrondie aux décimales de la devise de base.
create function public.fx_convert(p_amount numeric, p_currency text, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(p_amount * public.fx_rate(p_currency, p_date), (select c.minor_units from public.currencies c where c.code = private.base_currency()))
$$;

-- Saisie ou correction d'un taux (une seule valeur par jour et par devise).
create function public.fx_rate_set(p_date date, p_currency text, p_rate numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_cur char(3) := upper(btrim(coalesce(p_currency, ''))); v_id uuid;
begin
  perform private.require_perm('finance.write');
  if p_date is null or p_date > current_date + 1 then raise exception 'FX_DATE_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.currencies c where c.code = v_cur) then raise exception 'FX_CURRENCY_UNKNOWN' using errcode = '22023'; end if;
  if v_cur = private.base_currency() then raise exception 'FX_CURRENCY_IS_BASE' using errcode = '22023'; end if;
  if p_rate is null or p_rate <= 0 or p_rate > 1000000 then raise exception 'FX_RATE_INVALID' using errcode = '22023'; end if;
  insert into public.exchange_rates (company_id, rate_date, currency, rate, created_by)
  values (v_co, p_date, v_cur, p_rate, auth.uid())
  on conflict (company_id, rate_date, currency) do update set rate = excluded.rate, created_by = excluded.created_by, created_at = now()
  returning id into v_id;
  perform private.write_audit(v_co, 'finance.fx_rate', 'exchange_rate', v_id::text, v_cur, null,
    jsonb_build_object('date', p_date, 'rate', p_rate), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Changement de devise de base : refusé dès qu'une facture porte un taux figé (le passé ne se réécrit pas).
create function public.finance_set_base_currency(p_currency text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_cur char(3) := upper(btrim(coalesce(p_currency, '')));
begin
  perform private.require_perm('finance.write');
  if not exists (select 1 from public.currencies c where c.code = v_cur) then raise exception 'FX_CURRENCY_UNKNOWN' using errcode = '22023'; end if;
  if exists (select 1 from public.invoices i where i.company_id = v_co and i.fx_rate is not null)
     or exists (select 1 from public.supplier_invoices s where s.company_id = v_co and s.fx_rate is not null) then
    raise exception 'FX_BASE_LOCKED' using errcode = '55000';
  end if;
  insert into public.finance_settings (company_id, base_currency, updated_at, updated_by)
  values (v_co, v_cur, now(), auth.uid())
  on conflict (company_id) do update set base_currency = excluded.base_currency, updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'finance.base_currency', 'company', v_co::text, v_cur, null,
    jsonb_build_object('base_currency', v_cur), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 3. Figement des taux sur les documents
-- ---------------------------------------------------------------------
alter table public.invoices add column fx_rate numeric(18,8);
alter table public.invoices add column base_total numeric(15,2);
alter table public.supplier_invoices add column fx_rate numeric(18,8);
alter table public.supplier_invoices add column base_total numeric(15,2);

-- Documents déjà en EUR : la devise de base est EUR, taux 1.
update public.invoices set fx_rate = 1, base_total = total where fx_rate is null and currency = 'EUR' and status not in ('draft', 'cancelled');
update public.supplier_invoices set fx_rate = 1, base_total = total where fx_rate is null and currency = 'EUR';

-- À l'émission d'une facture client, le taux du jour d'émission est figé (refus si le taux manque).
create function private.invoices_fx_snapshot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_minor int;
begin
  if old.status = 'draft' and new.status in ('issued', 'partially_paid', 'paid', 'credited') and new.fx_rate is null then
    new.fx_rate := public.fx_rate(new.currency, coalesce(new.issue_date, current_date));
    select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
    new.base_total := round(new.total * new.fx_rate, v_minor);
  end if;
  return new;
end $$;
revoke execute on function private.invoices_fx_snapshot() from public, anon, authenticated;
create trigger invoices_fx_snapshot_u before update on public.invoices for each row execute function private.invoices_fx_snapshot();

-- À l'enregistrement d'une facture fournisseur, le taux du jour de la facture est figé.
create function private.supplier_invoices_fx() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_minor int;
begin
  if new.fx_rate is null then
    new.fx_rate := public.fx_rate(new.currency, new.invoice_date);
    select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
    new.base_total := round(new.total * new.fx_rate, v_minor);
  end if;
  return new;
end $$;
revoke execute on function private.supplier_invoices_fx() from public, anon, authenticated;
create trigger supplier_invoices_fx_i before insert on public.supplier_invoices for each row execute function private.supplier_invoices_fx();

-- ---------------------------------------------------------------------
-- 4. Fiscalité export
-- ---------------------------------------------------------------------
-- Domestique si le client est dans le pays de la société, export sinon.
create function public.fiscal_treatment(p_client uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when cl.country = co.country then 'domestic' else 'export' end
    from public.clients cl join public.companies co on co.id = cl.company_id
   where cl.id = p_client and cl.company_id = private.current_company()
$$;

-- Contrôles des factures d'export émises sur la période : TVA facturée à tort, preuve d'expédition absente.
create function public.export_controls(p_from date, p_to date) returns table (
  invoice_id uuid, code text, client_name text, country char(2), currency char(3), base_total numeric, tax_amount numeric,
  has_proof boolean, issues text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  select i.id, i.code, cl.name, cl.country, i.currency, i.base_total, i.tax_amount,
         exists (select 1 from public.shipments s where s.sales_order_id = i.order_id and s.bl_issued_at is not null),
         array_remove(array[
           case when i.tax_amount > 0 then 'TVA facturée sur une exportation' end,
           case when not exists (select 1 from public.shipments s where s.sales_order_id = i.order_id and s.bl_issued_at is not null)
                then 'Preuve d’exportation manquante (aucun BL émis pour la commande)' end
         ], null)
    from public.invoices i
    join public.clients cl on cl.id = i.client_id
    join public.companies co on co.id = i.company_id
   where i.company_id = private.current_company()
     and i.status in ('issued', 'partially_paid', 'paid', 'credited')
     and i.issue_date between p_from and p_to
     and cl.country <> co.country
   order by i.code;
end $$;

-- ---------------------------------------------------------------------
-- 5. TVA : base et TVA collectées par taux, en devise de base
-- ---------------------------------------------------------------------
-- Les avoirs ne sont pas encore déduits (à rapprocher avant déclaration).
create function public.vat_summary(p_from date, p_to date) returns table (
  tax_rate numeric, label text, invoices_count bigint, base_ht numeric, base_tva numeric, base_ttc numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int;
begin
  perform private.require_perm('finance.read');
  select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
  return query
  select i.tax_rate,
         (select v.label from public.vat_rates v where v.rate = i.tax_rate order by v.kind limit 1),
         count(*)::bigint,
         sum(round(i.subtotal * i.fx_rate, v_minor)),
         sum(round(i.tax_amount * i.fx_rate, v_minor)),
         sum(i.base_total)
    from public.invoices i
   where i.company_id = private.current_company()
     and i.status in ('issued', 'partially_paid', 'paid', 'credited')
     and i.issue_date between p_from and p_to
     and i.fx_rate is not null
   group by i.tax_rate
   order by i.tax_rate;
end $$;

-- ---------------------------------------------------------------------
-- 6. Écarts de change
-- ---------------------------------------------------------------------
-- Latents : soldes ouverts en devise étrangère, réévalués au taux de la date demandée.
-- Gain positif = créance qui vaut plus, ou dette qui vaut moins, en devise de base.
create function public.fx_open_positions(p_as_of date) returns table (
  kind text, document_id uuid, number text, counterparty text, currency char(3), open_amount numeric,
  rate_booked numeric, base_booked numeric, rate_today numeric, base_today numeric, unrealized numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int;
begin
  perform private.require_perm('finance.read');
  select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
  return query
  with docs as (
    select 'receivable'::text as k, i.id as did, i.code as dn, cl.name as cp, i.currency as cur,
           (i.total - i.paid_amount - i.credited_amount) as oa, i.fx_rate as rb
      from public.invoices i join public.clients cl on cl.id = i.client_id
     where i.company_id = private.current_company() and i.currency <> private.base_currency()
       and i.status in ('issued', 'partially_paid') and i.fx_rate is not null
    union all
    select 'payable', s.id, s.number, sp.name, s.currency, (s.total - s.paid_amount), s.fx_rate
      from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id
     where s.company_id = private.current_company() and s.currency <> private.base_currency()
       and s.status in ('open', 'partially_paid', 'disputed') and s.fx_rate is not null
  ), priced as (
    select d.*, public.fx_rate(d.cur, p_as_of) as rt from docs d
  )
  select p.k, p.did, p.dn, p.cp, p.cur, p.oa, p.rb,
         round(p.oa * p.rb, v_minor), p.rt, round(p.oa * p.rt, v_minor),
         case when p.k = 'receivable' then round(p.oa * p.rt, v_minor) - round(p.oa * p.rb, v_minor)
              else round(p.oa * p.rb, v_minor) - round(p.oa * p.rt, v_minor) end
    from priced p
   order by p.k, p.dn;
end $$;

-- Réalisés : écart constaté au règlement, entre le taux figé et le taux du jour du paiement.
create function public.fx_realized_gains(p_from date, p_to date) returns table (
  kind text, document_id uuid, number text, currency char(3), amount numeric, rate_booked numeric, rate_settled numeric, realized numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int;
begin
  perform private.require_perm('finance.read');
  select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
  return query
  select 'receivable'::text, i.id, i.code, i.currency, p.amount, i.fx_rate, public.fx_rate(i.currency, p.paid_on),
         round(p.amount * public.fx_rate(i.currency, p.paid_on), v_minor) - round(p.amount * i.fx_rate, v_minor)
    from public.invoice_payments p join public.invoices i on i.id = p.invoice_id
   where p.company_id = private.current_company() and i.currency <> private.base_currency()
     and i.fx_rate is not null and p.paid_on between p_from and p_to
  union all
  select 'payable', s.id, s.number, s.currency, a.amount, s.fx_rate, public.fx_rate(s.currency, pay.paid_on),
         round(a.amount * s.fx_rate, v_minor) - round(a.amount * public.fx_rate(s.currency, pay.paid_on), v_minor)
    from public.supplier_payment_allocations a
    join public.supplier_payments pay on pay.id = a.payment_id
    join public.supplier_invoices s on s.id = a.supplier_invoice_id
   where a.company_id = private.current_company() and s.currency <> private.base_currency()
     and s.fx_rate is not null and pay.paid_on between p_from and p_to;
end $$;

-- ---------------------------------------------------------------------
-- 7. Reporting financier multi-devise, par devise
-- ---------------------------------------------------------------------
create function public.multicurrency_report(p_from date, p_to date, p_as_of date) returns table (
  currency char(3), invoiced_foreign numeric, invoiced_base numeric, receivable_open_foreign numeric, receivable_open_base numeric,
  payable_open_foreign numeric, payable_open_base numeric, realized_gain numeric, unrealized_gain numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  with codes as (
    select i.currency as cc from public.invoices i where i.company_id = private.current_company()
    union
    select s.currency from public.supplier_invoices s where s.company_id = private.current_company()
  ), inv as (
    select i.currency as cc, sum(i.total) as f, sum(i.base_total) as b
      from public.invoices i
     where i.company_id = private.current_company() and i.status in ('issued', 'partially_paid', 'paid', 'credited')
       and i.issue_date between p_from and p_to
     group by i.currency
  ), pos as (
    select q.currency as cc,
           sum(q.open_amount) filter (where q.kind = 'receivable') as rf,
           sum(q.base_today) filter (where q.kind = 'receivable') as rb,
           sum(q.open_amount) filter (where q.kind = 'payable') as pf,
           sum(q.base_today) filter (where q.kind = 'payable') as pb,
           sum(q.unrealized) as u
      from public.fx_open_positions(p_as_of) q
     group by q.currency
  ), rea as (
    select g.currency as cc, sum(g.realized) as r from public.fx_realized_gains(p_from, p_to) g group by g.currency
  )
  select k.cc::char(3), inv.f, inv.b, pos.rf, pos.rb, pos.pf, pos.pb, rea.r, pos.u
    from codes k
    left join inv on inv.cc = k.cc
    left join pos on pos.cc = k.cc
    left join rea on rea.cc = k.cc
   order by k.cc;
end $$;

-- ---------------------------------------------------------------------
-- 8. Droits d'exécution
-- ---------------------------------------------------------------------
revoke execute on function public.fx_rate(text, date), public.fx_convert(numeric, text, date), public.fx_rate_set(date, text, numeric),
  public.finance_set_base_currency(text), public.fiscal_treatment(uuid), public.export_controls(date, date),
  public.vat_summary(date, date), public.fx_open_positions(date), public.fx_realized_gains(date, date),
  public.multicurrency_report(date, date, date) from public, anon;
grant execute on function public.fx_rate(text, date), public.fx_convert(numeric, text, date), public.fx_rate_set(date, text, numeric),
  public.finance_set_base_currency(text), public.fiscal_treatment(uuid), public.export_controls(date, date),
  public.vat_summary(date, date), public.fx_open_positions(date), public.fx_realized_gains(date, date),
  public.multicurrency_report(date, date, date) to authenticated;

