-- =====================================================================
-- 0032_sites_company_scope — Structure préparatoire du lot L1 (sociétés et sites)
--  Additive uniquement : aucune table ou colonne existante n'est supprimée ni modifiée.
--  - sites                    : ateliers, boutiques, entrepôts et bureaux par société (ORG-002).
--                               Table vide : les données viennent de OPEN-02 (non fournies).
--  - user_roles.company_id    : société du rattachement rôle/utilisateur (nullable ici,
--                               renseigné par reprise depuis profiles.company_id).
--  Accès (refus par défaut) :
--    - lecture de sites : membres de la société active uniquement (private.current_company()) ;
--    - aucune politique d'écriture pour les rôles authenticated : les écritures passent par l'API (clé service_role).
--  Rollback (transaction nouvelle, à exécuter manuellement si nécessaire) :
--    drop policy if exists sites_select on public.sites;
--    drop table if exists public.sites;
--    alter table public.user_roles drop column if exists company_id;
--  Statut : NON APPLIQUÉE. Non testée sur base locale (Docker indisponible dans cette session).
-- =====================================================================

create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  name        text not null,
  kind        text not null check (kind in ('atelier','boutique','entrepot','bureau')),
  status      text not null default 'actif' check (status in ('actif','inactif')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, code)
);
create index sites_company_status_idx on public.sites (company_id, status);

create trigger sites_set_updated_at before update on public.sites
  for each row execute function private.set_updated_at();

alter table public.sites enable row level security;

create policy sites_select on public.sites for select to authenticated
  using (company_id = private.current_company());

alter table public.user_roles add column if not exists company_id uuid references public.companies(id);

-- Reprise : chaque rattachement existant reçoit la société de son profil.
update public.user_roles ur
   set company_id = p.company_id
  from public.profiles p
 where p.id = ur.user_id
   and ur.company_id is null;

create index if not exists user_roles_company_idx on public.user_roles (company_id);
