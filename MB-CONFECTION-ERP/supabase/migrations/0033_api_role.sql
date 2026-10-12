-- ---------------------------------------------------------------------
-- 0033_api_role — Lot L2 : compte de connexion à privilèges minimaux pour l'API Laravel.
-- Architecture (ADR-001) : l'API se connecte avec ce compte, puis prend le rôle « authenticated »
-- dans chaque transaction (App\Support\Tenant). Les droits viennent de la RLS, pas du compte.
--
-- Propriétés :
--  - pas de superutilisateur, pas de création de rôles ni de bases, pas de contournement de la RLS ;
--  - noinherit : le compte n'hérite d'aucun droit de table ; il ne l'obtient qu'après « set role authenticated » ;
--  - aucun mot de passe dans ce fichier : il est défini hors dépôt (voir docs/erp360/PROJECT_STATE.md, L2).
--
-- Retour arrière (manuel, non exécuté par cette migration) :
--   revoke authenticated from workman_api;  revoke connect on database <base> from workman_api;
--   drop role if exists workman_api;
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'workman_api') then
    create role workman_api login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

grant authenticated to workman_api;

do $$
begin
  execute format('grant connect on database %I to workman_api', current_database());
end $$;
