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
