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
