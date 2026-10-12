-- ---------------------------------------------------------------------
-- 0034_company_scope — Lot P007 (partie indépendante) : accès multi-sociétés et verrou de société.
-- CDC : ORG-001 (chaque transaction porte sa société), ORG-002 (société active visible, pas de bascule silencieuse).
--
-- Décisions et limites :
--  - Aucune société n'est créée ici : WORKMAN, STID EXPORT et SOMICO exigent un pays (obligatoire) et un
--    identifiant légal, non fournis (OPEN-01). Aucun site n'est créé (OPEN-02).
--  - Aucune donnée ancienne n'est rattachée à une société supposée : chaque ligne garde sa société actuelle
--    (colonne company_id NOT NULL dans les 13 tables de documents contrôlées).
--  - user_company_access est remplie uniquement à partir de profiles.company_id existant (rattachement actuel).
--  - Écriture des accès : service_role seulement (futur écran d'administration, décision D-P007-02).
--  - Verrou : company_id d'un document ne peut plus changer après création (erreur COMPANY_CHANGE_FORBIDDEN).
--
-- Retour arrière (manuel, non exécuté par cette migration) :
--   drop trigger if exists <table>_company_lock on public.<table>;   -- pour les 13 tables
--   drop function if exists private.forbid_company_change();
--   drop function if exists private.has_company_access(uuid);
--   drop table if exists public.user_company_access;
-- ---------------------------------------------------------------------

create table public.user_company_access (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  active      boolean not null default true,
  granted_by  uuid,
  granted_at  timestamptz not null default now(),
  revoked_by  uuid,
  revoked_at  timestamptz,
  constraint user_company_access_uq unique (user_id, company_id),
  constraint user_company_access_revoked_ck check (active or revoked_at is not null)
);

create index user_company_access_company_idx on public.user_company_access (company_id, active);

-- Reprise : uniquement le rattachement actuel de chaque utilisateur (aucune supposition).
insert into public.user_company_access (user_id, company_id, granted_by)
select p.id, p.company_id, null
from public.profiles p
where p.company_id is not null
on conflict (user_id, company_id) do nothing;

create function private.has_company_access(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_company_access uca
    where uca.user_id = auth.uid() and uca.company_id = p_company and uca.active
  )
$$;

alter table public.user_company_access enable row level security;
revoke all on public.user_company_access from public, anon;
grant all on public.user_company_access to service_role;
grant select on public.user_company_access to authenticated;

create policy user_company_access_select on public.user_company_access for select to authenticated
  using (user_id = auth.uid());

-- Verrou : une fois créé, un document ne change plus de société.
create function private.forbid_company_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'COMPANY_CHANGE_FORBIDDEN' using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'sales_orders', 'invoices', 'quotes', 'purchase_orders', 'purchase_receipts', 'supplier_invoices',
    'production_orders', 'shipments', 'credit_notes', 'purchase_requests', 'subcontract_orders',
    'quality_inspections', 'quality_nonconformities'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_company_lock', t);
    execute format(
      'create trigger %I before update of company_id on public.%I for each row execute function private.forbid_company_change()',
      t || '_company_lock', t);
  end loop;
end $$;
