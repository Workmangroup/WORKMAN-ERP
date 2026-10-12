-- =====================================================================
-- 0043_approvals_engine — Moteur d'états, seuils, délégations, délais, escalades, refus motivé, accords liés au hash (P019)
--  Existant conservé tel quel (non réécrit, historique préservé) : achats à un niveau (0011, purchase_request_decide),
--  mouvements de stock à deux niveaux (0018, stock_approval_level), paiements / dérogations / contrôles qualité (0033).
--  Ce moteur est une couche générique et additive. Il ne contient AUCUNE politique par défaut : seuils, délais et
--  niveaux sont des décisions d'entreprise, saisies par une personne habilitée (approvals.manage).
--  Modèle :
--    approval_policies     : par type d'objet : 1 ou 2 niveaux, seuil du second niveau, permissions, délai, permission d'escalade.
--                            Une modification ne touche que les demandes NOUVELLES (les valeurs sont figées dans la demande).
--    approval_requests     : une demande par version d'objet. Porte la version, le hash SHA-256 du contenu approuvé et l'état.
--    approval_decisions    : journal append-only de chaque événement (demande, approbation, refus, tentative refusée,
--                            escalade, annulation, invalidation), avec acteur, délégant éventuel, états avant/après.
--    approval_delegations  : délégation datée (90 jours au plus), bornée par type d'objet et par montant, révocable.
--  États : pending_l1 → (pending_l2) → approved ; pending_* → refused (motif obligatoire) ; pending_* → cancelled ;
--          approved | pending_* → invalidated (changement substantiel de l'objet : le hash ne correspond plus).
--  Règles en base (CHECK) ET dans les fonctions :
--    - demandeur ≠ décideur ; second niveau ≠ premier niveau (SOD_NOT_INDEPENDENT) ;
--    - refus motivé (10 caractères minimum) ; transition interdite = refus + tentative journalisée (APPROVAL_BAD_TRANSITION) ;
--    - un accord n'existe que pour le hash du contenu courant : private/assert_current lève APPROVAL_STALE si le contenu a changé.
--  Limite : les refus d'accès (RBAC_FORBIDDEN) et les erreurs de saisie lèvent une erreur : la transaction est annulée et
--  ne sont pas écrits dans audit_logs (journal d'accès refusé côté application). Les tentatives de transition ou de
--  séparation des tâches, elles, retournent un résultat et sont journalisées.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (aucune politique n'est créée ici)
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, description) values
  ('approvals.read',        'admin', 'Voir les demandes d''approbation, leurs décisions et les politiques'),
  ('approvals.request',     'admin', 'Soumettre un objet à approbation'),
  ('approvals.decide',      'admin', 'Approuver ou refuser une demande (premier niveau)'),
  ('approvals.decide_high', 'admin', 'Approuver ou refuser une demande au second niveau'),
  ('approvals.escalate',    'admin', 'Escalader une demande en retard et décider à sa place après délai'),
  ('approvals.manage',      'admin', 'Définir les politiques d''approbation (seuils, niveaux, délais)')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code like 'approvals.%')
  or (r.code = 'direction'  and p.code in ('approvals.read', 'approvals.request', 'approvals.decide', 'approvals.decide_high', 'approvals.escalate'))
  or (r.code = 'finance'    and p.code in ('approvals.read', 'approvals.request'))
  or (r.code = 'commercial' and p.code in ('approvals.request')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Politiques (versionnées par la demande : une modification ne rétroagit pas)
-- ---------------------------------------------------------------------
create table public.approval_policies (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null default private.current_company() references public.companies(id),
  object_type           text not null check (object_type ~ '^[a-z_]{2,40}$'),
  levels                int not null check (levels in (1, 2)),
  level2_threshold      numeric(14,2) check (level2_threshold is null or level2_threshold >= 0),
  level1_permission     text not null references public.permissions(code),
  level2_permission     text references public.permissions(code),
  escalation_permission text not null references public.permissions(code),
  deadline_hours        int not null check (deadline_hours between 1 and 720),
  updated_by            uuid default auth.uid(),
  updated_at            timestamptz not null default now(),
  unique (company_id, object_type),
  check (levels = 1 or (level2_threshold is not null and level2_permission is not null)),
  check (levels = 2 or level2_permission is null)
);

-- ---------------------------------------------------------------------
-- 3. Délégations d'approbation (datées, bornées, révocables)
-- ---------------------------------------------------------------------
create table public.approval_delegations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  delegator_id uuid not null default auth.uid() references public.profiles(id),
  delegate_id  uuid not null references public.profiles(id),
  object_type  text not null check (object_type ~ '^[a-z_]{2,40}$'),
  permission   text not null references public.permissions(code),
  amount_limit numeric(14,2) check (amount_limit is null or amount_limit > 0),
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz not null,
  reason       text not null check (length(btrim(reason)) between 5 and 300),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  revoked_by   uuid,
  check (ends_at > starts_at and ends_at <= starts_at + interval '90 days'),
  check (delegator_id <> delegate_id),
  check ((revoked_at is null) = (revoked_by is null))
);
create index approval_delegations_delegate_idx on public.approval_delegations (company_id, delegate_id, object_type, permission);

-- ---------------------------------------------------------------------
-- 4. Demandes d'approbation (une par version d'objet ; une seule ouverte à la fois)
-- ---------------------------------------------------------------------
create table public.approval_requests (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null default private.current_company() references public.companies(id),
  object_type           text not null check (object_type ~ '^[a-z_]{2,40}$'),
  object_id             uuid not null,
  object_version        int not null check (object_version > 0),
  object_hash           text not null check (object_hash ~ '^[a-f0-9]{64}$'),
  snapshot              jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  amount                numeric(14,2) check (amount is null or amount >= 0),
  state                 text not null check (state in ('pending_l1', 'pending_l2', 'approved', 'refused', 'cancelled', 'invalidated')),
  levels                int not null check (levels in (1, 2)),
  level2_threshold      numeric(14,2),
  level1_permission     text not null references public.permissions(code),
  level2_permission     text references public.permissions(code),
  escalation_permission text not null references public.permissions(code),
  deadline_hours        int not null check (deadline_hours between 1 and 720),
  requested_by          uuid not null default auth.uid() references public.profiles(id),
  requested_at          timestamptz not null default now(),
  deadline_at           timestamptz not null,
  escalated_at          timestamptz,
  level1_by             uuid references public.profiles(id),
  decided_by            uuid references public.profiles(id),
  decided_at            timestamptz,
  refusal_reason        text check (refusal_reason is null or length(btrim(refusal_reason)) >= 10),
  invalidated_at        timestamptz,
  invalidated_by        uuid,
  unique (company_id, object_type, object_id, object_version),
  check (state <> 'refused' or refusal_reason is not null),
  check (state <> 'approved' or (decided_by is not null and decided_at is not null)),
  check (state <> 'approved' or levels = 1 or decided_by is distinct from level1_by),
  check (state <> 'pending_l2' or level1_by is not null),
  check (state <> 'invalidated' or invalidated_at is not null),
  check (decided_by is null or decided_by <> requested_by),
  check (levels = 2 or level1_by is null)
);
create unique index approval_requests_open_uq on public.approval_requests (company_id, object_type, object_id)
  where state in ('pending_l1', 'pending_l2');

-- ---------------------------------------------------------------------
-- 5. Journal des décisions : ajout seul
-- ---------------------------------------------------------------------
create table public.approval_decisions (
  id          bigint generated always as identity primary key,
  request_id  uuid not null references public.approval_requests(id),
  company_id  uuid not null,
  level       int not null check (level in (0, 1, 2)),
  action      text not null check (action in ('request', 'approve', 'refuse', 'attempt_refused', 'escalate', 'cancel', 'invalidate')),
  actor_id    uuid not null default auth.uid(),
  on_behalf_of uuid,
  from_state  text,
  to_state    text,
  reason      text,
  object_hash text,
  created_at  timestamptz not null default now()
);
create index approval_decisions_request_idx on public.approval_decisions (request_id, id);

create function private.approval_decisions_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'APPROVAL_JOURNAL_APPEND_ONLY' using errcode = '42501';
end $$;
create trigger approval_decisions_no_change before update or delete on public.approval_decisions
  for each row execute function private.approval_decisions_append_only();

-- ---------------------------------------------------------------------
-- 6. Sécurité des tables
-- ---------------------------------------------------------------------
alter table public.approval_policies enable row level security;
create policy approval_policies_select on public.approval_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('approvals.read'));
alter table public.approval_delegations enable row level security;
create policy approval_delegations_select on public.approval_delegations for select to authenticated
  using (company_id = private.current_company()
         and (delegator_id = auth.uid() or delegate_id = auth.uid() or private.has_perm('approvals.manage')));
alter table public.approval_requests enable row level security;
create policy approval_requests_select on public.approval_requests for select to authenticated
  using (company_id = private.current_company() and private.has_perm('approvals.read'));
alter table public.approval_decisions enable row level security;
create policy approval_decisions_select on public.approval_decisions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('approvals.read'));

revoke all on public.approval_policies, public.approval_delegations, public.approval_requests, public.approval_decisions from anon, authenticated;
grant select on public.approval_policies, public.approval_delegations, public.approval_requests, public.approval_decisions to authenticated;
grant all on public.approval_policies, public.approval_delegations, public.approval_requests, public.approval_decisions to service_role;
grant usage on sequence public.approval_decisions_id_seq to service_role;

-- ---------------------------------------------------------------------
-- 7. Fonctions privées
-- ---------------------------------------------------------------------
-- Empreinte du contenu : sha256 de la forme canonique jsonb (clés triées par PostgreSQL)
create function private.approval_hash(p_snapshot jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex')
$$;

-- Délégant dont la délégation couvre ce pouvoir maintenant, pour ce montant ; nul sinon
create function private.approval_delegator(p_company uuid, p_object_type text, p_amount numeric, p_permission text) returns uuid
language sql stable security definer set search_path = '' as $$
  select d.delegator_id from public.approval_delegations d
   where d.company_id = p_company and d.delegate_id = auth.uid() and d.object_type = p_object_type and d.permission = p_permission
     and d.revoked_at is null and now() between d.starts_at and d.ends_at
     and (d.amount_limit is null or coalesce(p_amount, 0) <= d.amount_limit)
   order by d.ends_at desc limit 1
$$;
revoke execute on function private.approval_delegator(uuid, text, numeric, text) from public, anon, authenticated;

-- Refus d'une tentative (transition interdite, auto-approbation, indépendance) : résultat + journal, aucune modification d'état
create function private.approval_attempt_refused(r public.approval_requests, p_code text, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, reason, object_hash)
  values (r.id, r.company_id, 0, 'attempt_refused', r.state, r.state, p_code || ' (' || p_action || ')', r.object_hash);
  perform private.write_audit(r.company_id, 'approval.attempt_refused', 'approval', r.id::text,
    r.object_type || ' v' || r.object_version, null, jsonb_build_object('state', r.state), jsonb_build_object('code', p_code, 'action', p_action), 'rpc');
  return jsonb_build_object('ok', false, 'code', p_code, 'state', r.state);
end $$;
revoke execute on function private.approval_attempt_refused(public.approval_requests, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Politiques
-- ---------------------------------------------------------------------
create function public.approval_policy_set(p_object_type text, p_levels int, p_threshold numeric, p_level1 text, p_level2 text,
                                           p_escalation text, p_deadline_hours int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('approvals.manage');
  insert into public.approval_policies (company_id, object_type, levels, level2_threshold, level1_permission, level2_permission, escalation_permission, deadline_hours, updated_by, updated_at)
  values (v_co, p_object_type, p_levels, p_threshold, p_level1, p_level2, p_escalation, p_deadline_hours, auth.uid(), now())
  on conflict (company_id, object_type) do update set levels = excluded.levels, level2_threshold = excluded.level2_threshold,
     level1_permission = excluded.level1_permission, level2_permission = excluded.level2_permission,
     escalation_permission = excluded.escalation_permission, deadline_hours = excluded.deadline_hours,
     updated_by = excluded.updated_by, updated_at = now()
  returning id into v_id;
  perform private.write_audit(v_co, 'approval.policy_set', 'approval_policy', v_id::text, p_object_type, null,
    jsonb_build_object('levels', p_levels, 'threshold', p_threshold, 'level1', p_level1, 'level2', p_level2, 'escalation', p_escalation, 'deadline_hours', p_deadline_hours), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.approval_policy_set(text, int, numeric, text, text, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 9. Soumission : version suivante, hash du contenu, politique figée dans la demande
-- ---------------------------------------------------------------------
create function public.approval_request_create(p_object_type text, p_object_id uuid, p_snapshot jsonb, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.approval_policies%rowtype; v_id uuid; v_ver int; v_state text;
begin
  perform private.require_perm('approvals.request');
  select * into p from public.approval_policies where company_id = v_co and object_type = p_object_type;
  if not found then raise exception 'APPROVAL_NO_POLICY' using errcode = '55000', detail = p_object_type; end if;
  if jsonb_typeof(p_snapshot) <> 'object' then raise exception 'APPROVAL_SNAPSHOT_INVALID' using errcode = '22023'; end if;
  if exists (select 1 from public.approval_requests where company_id = v_co and object_type = p_object_type and object_id = p_object_id
             and state in ('pending_l1', 'pending_l2')) then
    raise exception 'APPROVAL_ALREADY_OPEN' using errcode = '55000';
  end if;
  select coalesce(max(object_version), 0) + 1 into v_ver from public.approval_requests
   where company_id = v_co and object_type = p_object_type and object_id = p_object_id;
  insert into public.approval_requests (company_id, object_type, object_id, object_version, object_hash, snapshot, amount, state, levels,
    level2_threshold, level1_permission, level2_permission, escalation_permission, deadline_hours, requested_by, deadline_at)
  values (v_co, p_object_type, p_object_id, v_ver, private.approval_hash(p_snapshot), p_snapshot, p_amount, 'pending_l1', p.levels,
    p.level2_threshold, p.level1_permission, p.level2_permission, p.escalation_permission, p.deadline_hours, auth.uid(),
    now() + make_interval(hours => p.deadline_hours))
  returning id, state into v_id, v_state;
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, object_hash)
  values (v_id, v_co, 0, 'request', null, 'pending_l1', private.approval_hash(p_snapshot));
  perform private.write_audit(v_co, 'approval.request', 'approval', v_id::text, p_object_type || ' v' || v_ver, null,
    jsonb_build_object('state', 'pending_l1', 'version', v_ver, 'hash', private.approval_hash(p_snapshot), 'amount', p_amount), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.approval_request_create(text, uuid, jsonb, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10. Décision : approuver ou refuser (une transition valide, ou refus journalisé)
-- ---------------------------------------------------------------------
create function public.approval_decide(p_request uuid, p_action text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_actor uuid := auth.uid(); r public.approval_requests%rowtype;
  v_level int; v_perm text; v_via uuid := null; v_overdue boolean; v_new text; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_action not in ('approve', 'refuse') then raise exception 'APPROVAL_BAD_ACTION' using errcode = '22023'; end if;
  select * into r from public.approval_requests where id = p_request and company_id = v_co for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.state not in ('pending_l1', 'pending_l2') then
    return private.approval_attempt_refused(r, 'APPROVAL_BAD_TRANSITION', p_action);
  end if;
  if v_actor = r.requested_by then return private.approval_attempt_refused(r, 'SOD_SELF_APPROVAL', p_action); end if;

  v_level := case when r.state = 'pending_l1' then 1 else 2 end;
  v_perm := case when v_level = 1 then r.level1_permission else r.level2_permission end;
  if v_level = 2 and v_actor = r.level1_by then return private.approval_attempt_refused(r, 'SOD_NOT_INDEPENDENT', p_action); end if;

  -- Pouvoir : permission directe, délégation active, ou (après délai / escalade) permission d'escalade
  v_overdue := r.escalated_at is not null or now() > r.deadline_at;
  if private.has_perm(v_perm) then
    v_via := null;
  else
    v_via := private.approval_delegator(v_co, r.object_type, r.amount, v_perm);
    if v_via is null and v_overdue then
      if private.has_perm(r.escalation_permission) then v_via := null;
      else v_via := private.approval_delegator(v_co, r.object_type, r.amount, r.escalation_permission); end if;
      if v_via is null and not private.has_perm(r.escalation_permission) then
        raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = v_perm;
      end if;
    elsif v_via is null then
      raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = v_perm;
    end if;
  end if;

  if p_action = 'refuse' then
    if length(v_reason) < 10 then raise exception 'APPROVAL_REASON_REQUIRED' using errcode = '22023'; end if;
    v_new := 'refused';
  else
    v_new := case when v_level = 1 and r.levels = 2 and coalesce(r.amount, 0) > r.level2_threshold then 'pending_l2' else 'approved' end;
  end if;

  update public.approval_requests set state = v_new, decided_by = v_actor, decided_at = now(),
         level1_by = case when v_level = 1 and v_new = 'pending_l2' then v_actor else level1_by end,
         refusal_reason = case when p_action = 'refuse' then v_reason else refusal_reason end
   where id = r.id;
  insert into public.approval_decisions (request_id, company_id, level, action, actor_id, on_behalf_of, from_state, to_state, reason, object_hash)
  values (r.id, v_co, v_level, case when p_action = 'refuse' then 'refuse' else 'approve' end, v_actor, v_via, r.state, v_new,
          nullif(v_reason, ''), r.object_hash);
  perform private.write_audit(v_co, 'approval.' || case when p_action = 'refuse' then 'refuse' else 'approve' end, 'approval', r.id::text,
    r.object_type || ' v' || r.object_version, jsonb_build_object('state', r.state), jsonb_build_object('state', v_new),
    jsonb_build_object('level', v_level, 'hash', r.object_hash, 'on_behalf_of', v_via, 'reason', nullif(v_reason, '')), 'rpc');
  return jsonb_build_object('ok', true, 'state', v_new, 'level', v_level);
end $$;
grant execute on function public.approval_decide(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 11. Escalade d'une demande en retard (délai dépassé uniquement)
-- ---------------------------------------------------------------------
create function public.approval_escalate(p_request uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_actor uuid := auth.uid(); r public.approval_requests%rowtype; v_via uuid;
begin
  select * into r from public.approval_requests where id = p_request and company_id = v_co for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'APPROVAL_REASON_REQUIRED' using errcode = '22023'; end if;
  if not private.has_perm('approvals.escalate') and private.approval_delegator(v_co, r.object_type, r.amount, 'approvals.escalate') is null then
    raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = 'approvals.escalate';
  end if;
  if r.state not in ('pending_l1', 'pending_l2') then return private.approval_attempt_refused(r, 'APPROVAL_BAD_TRANSITION', 'escalate'); end if;
  if now() <= r.deadline_at then return private.approval_attempt_refused(r, 'APPROVAL_NOT_OVERDUE', 'escalate'); end if;

  update public.approval_requests set escalated_at = now(), deadline_at = now() + make_interval(hours => r.deadline_hours) where id = r.id;
  insert into public.approval_decisions (request_id, company_id, level, action, actor_id, from_state, to_state, reason, object_hash)
  values (r.id, v_co, case when r.state = 'pending_l1' then 1 else 2 end, 'escalate', v_actor, r.state, r.state, btrim(p_reason), r.object_hash);
  perform private.write_audit(v_co, 'approval.escalate', 'approval', r.id::text, r.object_type || ' v' || r.object_version,
    jsonb_build_object('deadline_at', r.deadline_at), jsonb_build_object('escalated', true), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return jsonb_build_object('ok', true, 'state', r.state);
end $$;
grant execute on function public.approval_escalate(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 12. Annulation par le demandeur
-- ---------------------------------------------------------------------
create function public.approval_cancel(p_request uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.approval_requests%rowtype;
begin
  select * into r from public.approval_requests where id = p_request and company_id = v_co for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.requested_by is distinct from auth.uid() then raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = 'requester'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'APPROVAL_REASON_REQUIRED' using errcode = '22023'; end if;
  if r.state not in ('pending_l1', 'pending_l2') then return private.approval_attempt_refused(r, 'APPROVAL_BAD_TRANSITION', 'cancel'); end if;
  update public.approval_requests set state = 'cancelled' where id = r.id;
  insert into public.approval_decisions (request_id, company_id, level, action, actor_id, from_state, to_state, reason, object_hash)
  values (r.id, v_co, 0, 'cancel', auth.uid(), r.state, 'cancelled', btrim(p_reason), r.object_hash);
  perform private.write_audit(v_co, 'approval.cancel', 'approval', r.id::text, r.object_type || ' v' || r.object_version,
    jsonb_build_object('state', r.state), jsonb_build_object('state', 'cancelled'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return jsonb_build_object('ok', true, 'state', 'cancelled');
end $$;
grant execute on function public.approval_cancel(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 13. Changement substantiel : les accords et demandes ouvertes liés à un autre hash sont invalidés
-- ---------------------------------------------------------------------
create function public.approval_object_changed(p_object_type text, p_object_id uuid, p_snapshot jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_hash text := private.approval_hash(p_snapshot); r record; v_n int := 0;
begin
  perform private.require_perm('approvals.request');
  if jsonb_typeof(p_snapshot) <> 'object' then raise exception 'APPROVAL_SNAPSHOT_INVALID' using errcode = '22023'; end if;
  for r in
    select * from public.approval_requests
     where company_id = v_co and object_type = p_object_type and object_id = p_object_id
       and state in ('approved', 'pending_l1', 'pending_l2') and object_hash <> v_hash
     for update
  loop
    update public.approval_requests set state = 'invalidated', invalidated_at = now(), invalidated_by = auth.uid() where id = r.id;
    insert into public.approval_decisions (request_id, company_id, level, action, actor_id, from_state, to_state, reason, object_hash)
    values (r.id, v_co, 0, 'invalidate', auth.uid(), r.state, 'invalidated', 'changement substantiel', r.object_hash);
    perform private.write_audit(v_co, 'approval.invalidate', 'approval', r.id::text, r.object_type || ' v' || r.object_version,
      jsonb_build_object('state', r.state, 'hash', r.object_hash), jsonb_build_object('state', 'invalidated', 'new_hash', v_hash), '{}'::jsonb, 'rpc');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
grant execute on function public.approval_object_changed(text, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 14. Garde d'accord : à appeler avant toute action qui dépend de l'approbation
--     Lève APPROVAL_NOT_APPROVED (pas d'accord pour ce contenu) ou APPROVAL_STALE (accord pour un contenu antérieur).
-- ---------------------------------------------------------------------
create function public.approval_assert_current(p_object_type text, p_object_id uuid, p_snapshot jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.approval_requests%rowtype; v_hash text := private.approval_hash(p_snapshot);
begin
  select * into r from public.approval_requests
   where company_id = v_co and object_type = p_object_type and object_id = p_object_id
   order by object_version desc limit 1;
  if not found then raise exception 'APPROVAL_NOT_APPROVED' using errcode = '55000', detail = 'aucune demande'; end if;
  if r.state = 'approved' and r.object_hash = v_hash then return; end if;
  if r.state in ('approved', 'invalidated') and r.object_hash <> v_hash then
    raise exception 'APPROVAL_STALE' using errcode = '55000', detail = 'accord pour une autre version du contenu';
  end if;
  raise exception 'APPROVAL_NOT_APPROVED' using errcode = '55000', detail = r.state;
end $$;
grant execute on function public.approval_assert_current(text, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 15. Délégations : accordées par une personne qui détient la permission elle-même ; révocables
-- ---------------------------------------------------------------------
create function public.approval_delegation_grant(p_delegate uuid, p_object_type text, p_permission text, p_amount_limit numeric,
                                                  p_ends_at timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  if not private.has_perm(p_permission) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = p_permission; end if;
  insert into public.approval_delegations (company_id, delegator_id, delegate_id, object_type, permission, amount_limit, ends_at, reason)
  values (v_co, auth.uid(), p_delegate, p_object_type, p_permission, p_amount_limit, p_ends_at, btrim(p_reason))
  returning id into v_id;
  perform private.write_audit(v_co, 'approval.delegation_grant', 'approval_delegation', v_id::text, p_object_type || ' ' || p_permission, null,
    jsonb_build_object('delegate', p_delegate, 'amount_limit', p_amount_limit, 'ends_at', p_ends_at), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.approval_delegation_grant(uuid, text, text, numeric, timestamptz, text) to authenticated, service_role;

create function public.approval_delegation_revoke(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.approval_delegations%rowtype;
begin
  select * into d from public.approval_delegations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.delegator_id <> auth.uid() and not private.has_perm('approvals.manage') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if d.revoked_at is not null then raise exception 'APPROVAL_BAD_TRANSITION' using errcode = '55000'; end if;
  update public.approval_delegations set revoked_at = now(), revoked_by = auth.uid() where id = p_id;
  perform private.write_audit(v_co, 'approval.delegation_revoke', 'approval_delegation', p_id::text, d.object_type || ' ' || d.permission, null,
    jsonb_build_object('reason', btrim(coalesce(p_reason, ''))), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.approval_delegation_revoke(uuid, text) to authenticated, service_role;
