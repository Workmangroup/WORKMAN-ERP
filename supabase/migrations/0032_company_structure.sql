-- =====================================================================
-- 0032_company_structure — L1 : structure sociétés, sites et rattachement utilisateur par société
--  Additive uniquement : aucune donnée réelle n'est créée (OPEN-01, OPEN-02 non fournis).
--  Ajouts :
--    companies            : + currency (devise fonctionnelle, vide tant que OPEN-04 n'est pas fourni)
--    sites                : sites, ateliers, boutiques et entrepôts par société (types à confirmer, OPEN-02)
--    user_companies       : sociétés accessibles à un utilisateur ; une société par défaut
--    warehouses           : + site_id (nullable), lié à un site de la même société (clé composite)
--    permissions          : sites.read, sites.manage (rôle admin)
--  Non modifié : private.current_company(), profiles.company_id, politiques existantes.
--  Le passage à la sélection de société active (ORG-001) est un lot ultérieur de L1.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Société : devise fonctionnelle (vide tant que non fournie)
-- ---------------------------------------------------------------------
alter table public.companies add column currency char(3)
  check (currency is null or currency ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------
-- 2. Sites
-- ---------------------------------------------------------------------
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name        text not null check (length(btrim(name)) between 2 and 120),
  city        text check (city is null or length(city) <= 80),
  address     text check (address is null or length(address) <= 200),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code),
  unique (id, company_id)                              -- cible de la clé composite de warehouses
);
create index sites_company_idx on public.sites (company_id);

create trigger sites_set_updated_at before update on public.sites
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Rattachement utilisateur ↔ sociétés
-- ---------------------------------------------------------------------
create table public.user_companies (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (user_id, company_id)
);
create unique index user_companies_default_uq on public.user_companies (user_id) where is_default;
create index user_companies_company_idx on public.user_companies (company_id);

-- Reprise de l'existant : chaque profil reçoit sa société actuelle comme société par défaut.
insert into public.user_companies (user_id, company_id, is_default)
select p.id, p.company_id, true from public.profiles p
on conflict (user_id, company_id) do nothing;

-- Maintien de la cohérence : toute société actuelle d'un profil est rattachée par défaut.
create function private.sync_user_company() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.user_companies set is_default = false
   where user_id = new.id and company_id <> new.company_id and is_default;
  insert into public.user_companies (user_id, company_id, is_default, active)
  values (new.id, new.company_id, true, true)
  on conflict (user_id, company_id) do update set is_default = true, active = true;
  return new;
end $$;

create trigger profiles_sync_user_company after insert or update of company_id on public.profiles
  for each row execute function private.sync_user_company();

-- ---------------------------------------------------------------------
-- 4. Entrepôt rattaché à un site (nullable ; même société obligatoire)
-- ---------------------------------------------------------------------
alter table public.warehouses add column site_id uuid;
alter table public.warehouses add constraint warehouses_site_same_company_fk
  foreign key (site_id, company_id) references public.sites (id, company_id);
create index warehouses_site_idx on public.warehouses (site_id);

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, description) values
  ('sites.read',   'auth', 'Voir les sites de la société'),
  ('sites.manage', 'auth', 'Créer et modifier les sites de la société')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('sites.read', 'sites.manage'))
  or (r.code = 'direction' and p.code = 'sites.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 6. Journal d'audit des sites
-- ---------------------------------------------------------------------
create function private.audit_sites() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'site.create', 'site', new.id::text, new.name, null, to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    perform private.write_audit(new.company_id, 'site.update', 'site', new.id::text, new.name, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;

create trigger sites_audit after insert or update on public.sites
  for each row execute function private.audit_sites();

-- ---------------------------------------------------------------------
-- 7. Sécurité (RLS) : refus par défaut, cloisonnement par société
-- ---------------------------------------------------------------------
alter table public.sites         enable row level security;
alter table public.user_companies enable row level security;

create policy sites_select on public.sites for select to authenticated
  using (company_id = private.current_company() and private.has_perm('sites.read'));
create policy sites_insert on public.sites for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('sites.manage'));
create policy sites_update on public.sites for update to authenticated
  using (company_id = private.current_company() and private.has_perm('sites.manage'))
  with check (company_id = private.current_company() and private.has_perm('sites.manage'));
-- Pas de DELETE : un site se désactive par archived_at.

-- Un utilisateur voit ses propres rattachements ; les administrateurs de la société voient ceux de leur société.
create policy user_companies_select on public.user_companies for select to authenticated
  using (user_id = auth.uid() or (company_id = private.current_company() and private.has_perm('users.read')));
-- Aucune politique d'écriture pour authenticated : écrit par le trigger de profil et le service.

grant select, insert, update on public.sites to authenticated;
grant select on public.user_companies to authenticated;
grant all on public.sites, public.user_companies to service_role;
