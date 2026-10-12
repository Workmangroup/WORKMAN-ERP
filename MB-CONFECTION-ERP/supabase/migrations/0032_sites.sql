-- ---------------------------------------------------------------------
-- 0032_sites — Lot L1 (préparation additive) : sites rattachés à une société.
-- CDC : ORG-001 (chaque transaction porte sa société), §1.2 (sites, entrepôts rattachés à une société).
--
-- Décisions :
--  - Aucune donnée de site n'est créée ni reprise : les sites réels relèvent de OPEN-02.
--  - warehouses.site_id est nullable, sans valeur par défaut : les entrepôts existants restent inchangés.
--  - Un entrepôt ne peut être rattaché qu'à un site de sa propre société (contrôle en base).
--  - Droits : lecture avec stock.read ; écriture avec warehouses.manage (droit existant, aucun nouveau droit inventé).
--  - Journal d'audit des sites : à ajouter avec l'écran du lot L1 (non traité ici).
--
-- Retour arrière (manuel, non exécuté par cette migration) :
--   drop trigger if exists warehouses_site_check_iu on public.warehouses;
--   drop function if exists private.warehouses_site_check();
--   drop function if exists private.sites_before();
--   alter table public.warehouses drop column if exists site_id;
--   drop table if exists public.sites;
-- Seules les nouvelles structures sont retirées ; aucune donnée existante n'est touchée.
-- ---------------------------------------------------------------------

create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null,
  name        text not null,
  city        text,
  address     text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  constraint sites_company_code_uq unique (company_id, code),
  constraint sites_code_check check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  constraint sites_name_check check (length(btrim(name)) between 2 and 120),
  constraint sites_city_check check (city is null or length(city) <= 80),
  constraint sites_address_check check (address is null or length(address) <= 200)
);

create index sites_company_idx on public.sites (company_id, archived_at);

-- Normalisation et métadonnées ; la société par défaut est celle de la session.
create function private.sites_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.archived_at := null;
  else
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);
  new.city := nullif(btrim(coalesce(new.city, '')), '');
  new.address := nullif(btrim(coalesce(new.address, '')), '');
  return new;
end $$;

create trigger sites_before_iu before insert or update on public.sites
  for each row execute function private.sites_before();

-- Entrepôt : le site, s'il est renseigné, doit appartenir à la même société.
create function private.warehouses_site_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.site_id is not null and not exists (
    select 1 from public.sites s
    where s.id = new.site_id and s.company_id = new.company_id
  ) then
    raise exception 'SITE_COMPANY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end $$;

alter table public.warehouses add column site_id uuid references public.sites(id);
create index warehouses_site_idx on public.warehouses (site_id);

-- Nommé après warehouses_before_iu pour s'exécuter après la fixation de company_id.
create trigger warehouses_site_check_iu before insert or update of site_id, company_id on public.warehouses
  for each row execute function private.warehouses_site_check();

-- ---------------------------------------------------------------------
-- Sécurité : refus par défaut, droits côté base.
-- ---------------------------------------------------------------------
alter table public.sites enable row level security;

revoke all on public.sites from public, anon;
grant all on public.sites to service_role;
grant select on public.sites to authenticated;
grant insert (code, name, city, address) on public.sites to authenticated;
grant update (name, city, address) on public.sites to authenticated;

create policy sites_select on public.sites for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
create policy sites_insert on public.sites for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('warehouses.manage'));
create policy sites_update on public.sites for update to authenticated
  using (company_id = private.current_company() and private.has_perm('warehouses.manage'))
  with check (company_id = private.current_company() and private.has_perm('warehouses.manage'));
