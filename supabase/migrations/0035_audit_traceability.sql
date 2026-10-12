-- =====================================================================
-- 0035_audit_traceability — Journal d'audit : traçabilité des décisions, minimisation, export auditeur (P012)
--  Socle conservé : audit_logs en ajout seul (0003), write_audit (signature inchangée : 254 appels existants),
--  audit.read et RLS par société, versions figées (0007 et suivants), journal d'authentification.
--  Ajouts (colonnes additives) :
--    correlation_id   : relie toutes les lignes d'une même transaction / d'une même action (en-tête x-correlation-id accepté)
--    actor_kind       : user (acteur réel) | delegate (agi par délégation) | system (sans session)
--    delegation_id    : délégation utilisée, et on_behalf_of = délégant (acteur réel = actor_id)
--    entity_version   : rang de la ligne pour l'entité (1, 2, 3…), verrouillé par entité
--    significant      : décision ou changement sensible (approbation, règlement, droit, export…)
--    reason           : motif structuré (metadata.reason / comment / motive)
--    scope            : périmètre (company par défaut)
--  Minimisation :
--    - écriture : secrets et données bancaires / paie masqués ([masqué]) avant stockage ;
--    - lecture : prix et coûts masqués pour qui n'a pas costs.read ;
--    - IP et navigateur : visibles seulement dans l'export auditeur (audit.export).
--  Accès : authenticated ne lit plus la table directement (privilèges de colonnes) ; lecture par audit_search,
--  export par audit_export (qui s'inscrit lui-même au journal).
--  Refus : les refus (RLS, droits, délégation) lèvent une erreur : la transaction est annulée, donc non journalisés.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Colonnes additives
-- ---------------------------------------------------------------------
alter table public.audit_logs
  add column correlation_id uuid,
  add column actor_kind text check (actor_kind in ('user', 'delegate', 'system')),
  add column delegation_id uuid references public.delegations(id),
  add column on_behalf_of uuid references public.profiles(id),
  add column entity_version int check (entity_version is null or entity_version >= 1),
  add column significant boolean not null default false,
  add column reason text check (reason is null or length(reason) <= 500),
  add column scope text not null default 'company' check (length(scope) <= 60);
create index audit_logs_correlation_idx on public.audit_logs (correlation_id);
create index audit_logs_significant_idx on public.audit_logs (company_id, significant, created_at desc);

-- ---------------------------------------------------------------------
-- 2. Permission d'export auditeur
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('audit.export', 'auth', 'Exporter le journal d’audit (auditeur)', 'Exporter le journal avec IP et navigateur ; l’export est lui-même journalisé')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'audit.export'
  and r.code in ('admin', 'direction')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. Fonctions de masquage et de classement
-- ---------------------------------------------------------------------
-- Secrets, données bancaires et paie : masqués à l'écriture (jamais stockés en clair).
create function private.audit_redact(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when j is null or jsonb_typeof(j) <> 'object' then j else coalesce((
    select jsonb_object_agg(e.k, case when e.k ~* '(password|passwd|secret|token|api[_-]?key|iban|\mrib\M|\mbic\M|swift|card|cvv|salary|salaire|payroll|paie|bank|bancaire)'
      then to_jsonb('[masqué]'::text) else e.v end)
    from jsonb_each(j) as e(k, v)), '{}'::jsonb) end
$$;

-- Prix et coûts : masqués à la lecture pour qui n'a pas costs.read.
create function private.audit_mask_costs(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when j is null or jsonb_typeof(j) <> 'object' then j else coalesce((
    select jsonb_object_agg(e.k, case when e.k ~* '(price|prix|cost|coût|cout|margin|marge|tarif|unit_cost)'
      then to_jsonb('[masqué]'::text) else e.v end)
    from jsonb_each(j) as e(k, v)), '{}'::jsonb) end
$$;

-- Actions à caractère sensible : décision, règlement, droit, export, contrôle, dérogation, refus d'accès.
create function private.audit_is_significant(p_action text) returns boolean
language sql immutable set search_path = '' as $$
  select p_action ~ '(approve|reject|execute|grant|revoke|control|mark_critical|archive|delete|export|payment|role|permission|decide|release|reverse|denied|derogation|delegation)'
$$;

-- ---------------------------------------------------------------------
-- 4. Écriture : même signature qu'avant ; ajoute acteur réel, délégué, corrélation, version, significatif, motif
-- ---------------------------------------------------------------------
create or replace function private.write_audit(
  p_company uuid, p_action text, p_entity_type text, p_entity_id text, p_entity_label text,
  p_before jsonb, p_after jsonb, p_metadata jsonb default '{}'::jsonb, p_source text default 'trigger')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_headers jsonb;
  v_actor   uuid := auth.uid();
  v_email   text;
  v_corr    uuid;
  v_hdr     text;
  v_del     uuid := nullif(current_setting('audit.delegation_id', true), '')::uuid;
  v_del_by  uuid;
  v_kind    text;
  v_meta    jsonb := private.audit_redact(coalesce(p_metadata, '{}'::jsonb));
  v_reason  text;
  v_ver     int;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  v_hdr := v_headers ->> 'x-correlation-id';
  v_corr := nullif(current_setting('audit.correlation_id', true), '')::uuid;
  if v_corr is null then
    v_corr := case when v_hdr ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_hdr::uuid else gen_random_uuid() end;
    perform set_config('audit.correlation_id', v_corr::text, true);
  end if;
  if v_del is not null then
    select delegator_id into v_del_by from public.delegations where id = v_del;
  end if;
  v_kind := case when v_del is not null then 'delegate' when v_actor is not null then 'user' else 'system' end;
  v_reason := coalesce(nullif(btrim(v_meta ->> 'reason'), ''), nullif(btrim(v_meta ->> 'comment'), ''), nullif(btrim(v_meta ->> 'motive'), ''));
  if v_actor is not null then
    select email into v_email from public.profiles where id = v_actor;
  end if;
  -- version : rang de la ligne pour cette entité, verrouillé pour éviter deux rangs identiques
  perform pg_advisory_xact_lock(hashtext(p_entity_type || ':' || coalesce(p_entity_id, '')));
  select count(*)::int + 1 into v_ver from public.audit_logs where entity_type = p_entity_type and entity_id = p_entity_id;

  insert into public.audit_logs (company_id, actor_id, actor_email, action, entity_type, entity_id, entity_label,
                                 before_data, after_data, metadata, source, ip, user_agent,
                                 correlation_id, actor_kind, delegation_id, on_behalf_of, entity_version, significant, reason)
  values (p_company, v_actor, v_email, p_action, p_entity_type, p_entity_id, p_entity_label,
          private.audit_redact(p_before), private.audit_redact(p_after), v_meta, p_source,
          nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
          v_headers ->> 'user-agent',
          v_corr, v_kind, v_del, v_del_by, v_ver, private.audit_is_significant(p_action), left(v_reason, 500));
end $$;

-- L'approbation par délégation est tracée : l'entrée porte la délégation et le délégant.
create or replace function private.approval_allowed(p_perm text, p_obj_type text, p_obj_id uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_me uuid := auth.uid(); d public.delegations%rowtype;
  v_expired boolean := false; v_inactive boolean := false; v_limit boolean := false;
begin
  if v_me is null then raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = p_perm; end if;
  if private.has_perm(p_perm) then return; end if;
  for d in select * from public.delegations
     where company_id = v_co and delegate_id = v_me and permission = p_perm and object_type = p_obj_type
       and (object_id is null or object_id = p_obj_id) and revoked_at is null loop
    if now() < d.starts_at then v_inactive := true;
    elsif now() > d.ends_at then v_expired := true;
    elsif d.amount_limit is not null and (p_amount is null or p_amount > d.amount_limit) then v_limit := true;
    else
      perform set_config('audit.delegation_id', d.id::text, true);
      return;
    end if;
  end loop;
  if v_expired then raise exception 'DELEGATION_EXPIRED' using errcode = '42501', detail = p_perm; end if;
  if v_inactive then raise exception 'DELEGATION_INACTIVE' using errcode = '42501', detail = p_perm; end if;
  if v_limit then raise exception 'DELEGATION_AMOUNT_EXCEEDED' using errcode = '42501', detail = p_perm; end if;
  raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = p_perm;
end $$;

-- ---------------------------------------------------------------------
-- 5. Accès direct : les historiques par module (politiques RLS existantes) sont conservés.
--    Restriction ajoutée : les actions de prix et de coût ne sont visibles qu'avec costs.read, quelle que soit la politique
--    (politique RESTRICTIVE, combinée en ET avec toutes les politiques permissives). IP et navigateur sortent de la lecture directe.
-- ---------------------------------------------------------------------
create function private.audit_is_cost_action(p_action text) returns boolean
language sql immutable set search_path = '' as $$
  select p_action ~ '(price|cost|costing)'
$$;

create policy audit_logs_costs_restrictive on public.audit_logs as restrictive for select to authenticated
  using (not private.audit_is_cost_action(action) or private.has_perm('costs.read'));

revoke select on public.audit_logs from authenticated;
grant select (id, company_id, actor_id, actor_email, action, entity_type, entity_id, entity_label, before_data, after_data, metadata, source, created_at,
              correlation_id, actor_kind, delegation_id, on_behalf_of, entity_version, significant, reason, scope)
  on public.audit_logs to authenticated;

create function public.audit_search(p_scope text default null, p_actor text default null, p_from date default null, p_to date default null,
  p_entity_type text default null, p_entity_id text default null, p_significant boolean default null, p_limit int default 50, p_offset int default 0)
returns table (id bigint, actor_id uuid, actor_email text, action text, entity_type text, entity_id text, entity_label text,
  before_data jsonb, after_data jsonb, metadata jsonb, source text, created_at timestamptz,
  correlation_id uuid, actor_kind text, delegation_id uuid, on_behalf_of uuid, entity_version int, significant boolean, reason text, scope text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('costs.read');
  v_actor text := nullif(btrim(coalesce(p_actor, '')), '');
begin
  perform private.require_perm('audit.read');
  return query
    select l.id, l.actor_id, l.actor_email, l.action, l.entity_type, l.entity_id, l.entity_label,
      case when v_costs then l.before_data else private.audit_mask_costs(l.before_data) end,
      case when v_costs then l.after_data else private.audit_mask_costs(l.after_data) end,
      case when v_costs then l.metadata else private.audit_mask_costs(l.metadata) end,
      l.source, l.created_at, l.correlation_id, l.actor_kind, l.delegation_id, l.on_behalf_of, l.entity_version, l.significant, l.reason, l.scope
    from public.audit_logs l
    where l.company_id = v_co
      and (p_scope is null or (case when right(p_scope, 1) = '.' then left(l.action, length(p_scope)) = p_scope else l.action = p_scope end))
      and (v_actor is null or l.actor_email ilike '%' || v_actor || '%' or l.entity_label ilike '%' || v_actor || '%')
      and (p_from is null or l.created_at >= p_from::timestamptz)
      and (p_to is null or l.created_at < (p_to + 1)::timestamptz)
      and (p_entity_type is null or l.entity_type = p_entity_type)
      and (p_entity_id is null or l.entity_id = p_entity_id)
      and (p_significant is null or l.significant = p_significant)
      and (v_costs or not private.audit_is_cost_action(l.action))
    order by l.created_at desc, l.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 5000) offset greatest(coalesce(p_offset, 0), 0);
end $$;
grant execute on function public.audit_search(text, text, date, date, text, text, boolean, int, int) to authenticated, service_role;

-- Export auditeur : IP et navigateur inclus, prix masqués sans costs.read, export journalisé avec son périmètre (pas son contenu).
create function public.audit_export(p_scope text default null, p_from date default null, p_to date default null, p_limit int default 5000)
returns table (id bigint, created_at timestamptz, actor_email text, actor_kind text, on_behalf_of uuid, action text, entity_type text,
  entity_id text, entity_label text, before_data jsonb, after_data jsonb, metadata jsonb, reason text, significant boolean,
  correlation_id uuid, entity_version int, source text, ip text, user_agent text, scope text)
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('costs.read'); v_n int; v_cap int := least(greatest(coalesce(p_limit, 5000), 1), 5000);
begin
  perform private.require_perm('audit.export');
  select count(*)::int into v_n from public.audit_logs l
    where l.company_id = v_co
      and (p_scope is null or (case when right(p_scope, 1) = '.' then left(l.action, length(p_scope)) = p_scope else l.action = p_scope end))
      and (p_from is null or l.created_at >= p_from::timestamptz) and (p_to is null or l.created_at < (p_to + 1)::timestamptz);
  perform private.write_audit(v_co, 'audit.export', 'audit', null, 'Export du journal', null, null,
    jsonb_build_object('lignes', least(v_n, v_cap), 'scope', p_scope, 'from', p_from, 'to', p_to), 'rpc');
  return query
    select l.id, l.created_at, l.actor_email, l.actor_kind, l.on_behalf_of, l.action, l.entity_type, l.entity_id, l.entity_label,
      case when v_costs then l.before_data else private.audit_mask_costs(l.before_data) end,
      case when v_costs then l.after_data else private.audit_mask_costs(l.after_data) end,
      case when v_costs then l.metadata else private.audit_mask_costs(l.metadata) end,
      l.reason, l.significant, l.correlation_id, l.entity_version, l.source, l.ip, l.user_agent, l.scope
    from public.audit_logs l
    where l.company_id = v_co
      and (p_scope is null or (case when right(p_scope, 1) = '.' then left(l.action, length(p_scope)) = p_scope else l.action = p_scope end))
      and (p_from is null or l.created_at >= p_from::timestamptz) and (p_to is null or l.created_at < (p_to + 1)::timestamptz)
      and (v_costs or not private.audit_is_cost_action(l.action))
    order by l.created_at desc, l.id desc
    limit v_cap;
end $$;
grant execute on function public.audit_export(text, date, date, int) to authenticated, service_role;

-- Nombre de lignes pour la pagination de l'écran (mêmes filtres et mêmes règles que audit_search)
create function public.audit_count(p_scope text default null, p_actor text default null, p_from date default null, p_to date default null,
  p_entity_type text default null, p_entity_id text default null, p_significant boolean default null)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('costs.read');
  v_actor text := nullif(btrim(coalesce(p_actor, '')), ''); v_n bigint;
begin
  perform private.require_perm('audit.read');
  select count(*) into v_n from public.audit_logs l
    where l.company_id = v_co
      and (p_scope is null or (case when right(p_scope, 1) = '.' then left(l.action, length(p_scope)) = p_scope else l.action = p_scope end))
      and (v_actor is null or l.actor_email ilike '%' || v_actor || '%' or l.entity_label ilike '%' || v_actor || '%')
      and (p_from is null or l.created_at >= p_from::timestamptz)
      and (p_to is null or l.created_at < (p_to + 1)::timestamptz)
      and (p_entity_type is null or l.entity_type = p_entity_type)
      and (p_entity_id is null or l.entity_id = p_entity_id)
      and (p_significant is null or l.significant = p_significant)
      and (v_costs or not private.audit_is_cost_action(l.action));
  return v_n;
end $$;
grant execute on function public.audit_count(text, text, date, date, text, text, boolean) to authenticated, service_role;
