-- =====================================================================
-- 0032_sites — Sites par société (préparation du lot L1, ORG-001 / ORG-002)
--  Additif uniquement : aucune donnée n'est créée. Les sites réels (OPEN-02) et les sociétés (OPEN-01)
--  restent à fournir par le propriétaire ; rien n'est deviné ici.
--    sites                : site, atelier ou boutique d'une société (code SIT-nn généré, immuable)
--    warehouses.site_id   : rattachement optionnel d'un entrepôt à un site de la MÊME société
--  Règles (appliquées en base) :
--    - lecture : société active + sites.read ; écriture : société active + sites.manage ;
--    - le site rattaché à un entrepôt doit appartenir à la société de l'entrepôt (clé composite) ;
--    - toute création, modification et archivage est tracée dans audit_logs (entity_type = 'site').
--  Aucune suppression physique : archived_at uniquement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('sites.read',   'admin', 'Voir les sites',    'Lecture des sites et ateliers de la société'),
  ('sites.manage', 'admin', 'Gérer les sites',   'Créer, modifier et archiver les sites et ateliers de la société')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('sites.read', 'sites.manage'))
  or (r.code = 'direction' and p.code = 'sites.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Table des sites
-- ---------------------------------------------------------------------
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null,                                              -- SIT-01 (généré, immuable)
  name        text not null check (length(btrim(name)) between 2 and 120),
  kind        text not null default 'site' check (kind in ('site', 'workshop', 'shop')),
  city        text check (city is null or length(city) <= 80),
  address     text check (address is null or length(address) <= 200),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code),
  unique (company_id, id)                                                 -- cible de la clé composite de warehouses
);
create unique index sites_name_uq on public.sites (company_id, lower(btrim(name)));
create trigger sites_set_updated_at before update on public.sites
  for each row execute function private.set_updated_at();

-- Code généré : SIT-01, SIT-02… par société (même principe que WH-nn)
create function private.sites_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    if new.code is null or new.code = '' then
      select count(*) + 1 into v_n from public.sites where company_id = new.company_id;
      new.code := 'SIT-' || lpad(v_n::text, 2, '0');
    end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  else
    if new.code is distinct from old.code then raise exception 'SITE_CODE_IMMUTABLE' using errcode = '22023'; end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger sites_fill_bi before insert or update on public.sites
  for each row execute function private.sites_fill();

-- Garde-fou d'écriture : société active et permission sites.manage (refus par défaut)
create function private.sites_access_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if new is not null and new.company_id is distinct from private.current_company() then
    raise exception 'SITE_FORBIDDEN' using errcode = '42501';
  end if;
  if not private.has_perm('sites.manage') then raise exception 'SITE_FORBIDDEN' using errcode = '42501'; end if;
  return coalesce(new, old);
end $$;
create trigger sites_access_guard_iud before insert or update or delete on public.sites
  for each row execute function private.sites_access_guard();

-- Traçabilité : création, modification, archivage
create function private.audit_sites() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'site.create', 'site', new.id::text, new.code, null, to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    perform private.write_audit(new.company_id,
      case when new.archived_at is not null and old.archived_at is null then 'site.archive'
           when new.archived_at is null and old.archived_at is not null then 'site.restore'
           else 'site.update' end,
      'site', new.id::text, new.code, to_jsonb(old), to_jsonb(new));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_sites_iu after insert or update on public.sites
  for each row execute function private.audit_sites();

alter table public.sites enable row level security;
create policy sites_select on public.sites for select to authenticated
  using (company_id = private.current_company() and private.has_perm('sites.read'));
create policy sites_insert on public.sites for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('sites.manage'));
create policy sites_update on public.sites for update to authenticated
  using (company_id = private.current_company() and private.has_perm('sites.manage'))
  with check (company_id = private.current_company() and private.has_perm('sites.manage'));
-- Pas de politique DELETE : aucune suppression physique.
-- Privilèges par colonne, comme pour les entrepôts : le code n'est jamais écrit par le client.
grant select on public.sites to authenticated;
grant insert (company_id, name, kind, city, address) on public.sites to authenticated;
grant update (name, kind, city, address, archived_at) on public.sites to authenticated;
grant all on public.sites to service_role;

-- ---------------------------------------------------------------------
-- 3. Rattachement optionnel d'un entrepôt à un site de la même société
-- ---------------------------------------------------------------------
alter table public.warehouses add column site_id uuid;
alter table public.warehouses add constraint warehouses_site_fk
  foreign key (company_id, site_id) references public.sites (company_id, id);
create index warehouses_site_idx on public.warehouses (company_id, site_id);
grant update (site_id) on public.warehouses to authenticated;
