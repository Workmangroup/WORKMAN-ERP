-- =====================================================================
-- 0033_delegations_sod — Délégations datées et bornées (SEC-03) et séparation des tâches (P011)
--  Réutilise le socle existant : private.has_perm / require_perm, private.write_audit, private.doc_number,
--  les contrôles qualité (0020) et les paiements fournisseurs (0022).
--  Ajouts :
--    delegations        : délégation d'un pouvoir d'approbation, datée (90 jours au plus), bornée par objet
--                         et/ou montant ; révocable ; jamais sur paie, marge ou prix.
--    payment_orders     : ordre de paiement fournisseur préparé, approuvé par une autre personne (préparateur ≠ approbateur).
--    derogations        : dérogation (demande → approbation → second contrôle indépendant).
--    quality_inspections.critical : lot critique ; sa libération ne peut pas être faite par son contrôleur.
--  Séparation des tâches appliquée en base (CHECK) ET dans les fonctions :
--    payment_orders : decided_by <> prepared_by
--    derogations    : approved_by <> requested_by ; control_by <> requested_by ; control_by <> approved_by
--  Erreurs : DELEGATION_EXPIRED, DELEGATION_INACTIVE, DELEGATION_AMOUNT_EXCEEDED (42501) ; SOD_SELF_APPROVAL,
--  SOD_NOT_INDEPENDENT, QUALITY_SELF_RELEASE (42501) ; RBAC_FORBIDDEN pour une permission absente.
--  Limite : les refus lèvent une erreur, donc ne peuvent pas être écrits dans audit_logs (la transaction est annulée).
--  Les décisions acceptées et les demandes sont auditées.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('delegations.read',     'admin',   'Voir les délégations',            'Consulter les délégations de la société'),
  ('delegations.grant',    'admin',   'Accorder une délégation',         'Déléguer à un tiers une permission d''approbation détenue directement'),
  ('delegations.manage',   'admin',   'Révoquer toute délégation',      'Révoquer une délégation accordée par un autre utilisateur'),
  ('payments.prepare',     'finance', 'Préparer un ordre de paiement',  'Saisir un ordre de paiement fournisseur (sans l''approuver)'),
  ('payments.approve',     'finance', 'Approuver un ordre de paiement', 'Approuver ou refuser un ordre de paiement préparé par une autre personne'),
  ('derogations.request',  'quality', 'Demander une dérogation',        'Ouvrir une demande de dérogation'),
  ('derogations.approve',  'quality', 'Approuver une dérogation',       'Premier niveau : approuver ou refuser une dérogation demandée par une autre personne'),
  ('derogations.control',  'quality', 'Contrôler une dérogation',       'Second contrôle indépendant : demandeur et approbateur exclus')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code like 'delegations.%' or r.code = 'admin' and p.code like 'payments.%' or r.code = 'admin' and p.code like 'derogations.%')
  or (r.code = 'direction'  and p.code in ('delegations.read', 'delegations.grant', 'payments.approve', 'derogations.request', 'derogations.approve'))
  or (r.code = 'finance'    and p.code in ('payments.prepare', 'derogations.request'))
  or (r.code = 'qualite'    and p.code in ('derogations.request', 'derogations.control'))
  or (r.code = 'commercial' and p.code = 'derogations.request'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Délégations
-- ---------------------------------------------------------------------
create table public.delegations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id),
  delegator_id  uuid not null default auth.uid() references public.profiles(id),
  delegate_id   uuid not null references public.profiles(id),
  permission    text not null check (permission in ('payments.approve', 'derogations.approve', 'derogations.control', 'quality.approve')),
  object_type   text not null check (object_type in ('payment_order', 'derogation', 'quality_inspection')),
  object_id     uuid,                                   -- objet précis ; nul = tous les objets du type, dans la limite du montant
  amount_limit  numeric(14,2) check (amount_limit is null or amount_limit > 0),
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null,
  reason        text not null check (length(btrim(reason)) between 5 and 300),
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  check (ends_at > starts_at and ends_at <= starts_at + interval '90 days'),
  check (delegator_id <> delegate_id),
  check (amount_limit is not null or object_id is not null),       -- bornée : par montant ou par objet
  check ((permission = 'payments.approve' and object_type = 'payment_order')
      or (permission in ('derogations.approve', 'derogations.control') and object_type = 'derogation')
      or (permission = 'quality.approve' and object_type = 'quality_inspection')),
  check ((revoked_at is null) = (revoked_by is null))
);
create index delegations_delegate_idx on public.delegations (company_id, delegate_id, permission);
alter table public.delegations enable row level security;
create policy delegations_select on public.delegations for select to authenticated
  using (company_id = private.current_company()
         and (delegator_id = auth.uid() or delegate_id = auth.uid() or private.has_perm('delegations.read')));
revoke all on public.delegations from anon, authenticated;
grant select on public.delegations to authenticated;
grant all on public.delegations to service_role;

-- Le pouvoir effectif : permission directe, ou délégation active (date, objet, montant).
-- Une délégation qui existe mais est hors période lève DELEGATION_EXPIRED / DELEGATION_INACTIVE (refus explicite).
create function private.approval_allowed(p_perm text, p_obj_type text, p_obj_id uuid, p_amount numeric) returns void
language plpgsql stable security definer set search_path = '' as $$
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
    else return;
    end if;
  end loop;
  if v_expired then raise exception 'DELEGATION_EXPIRED' using errcode = '42501', detail = p_perm; end if;
  if v_inactive then raise exception 'DELEGATION_INACTIVE' using errcode = '42501', detail = p_perm; end if;
  if v_limit then raise exception 'DELEGATION_AMOUNT_EXCEEDED' using errcode = '42501', detail = p_perm; end if;
  raise exception 'RBAC_FORBIDDEN' using errcode = '42501', detail = p_perm;
end $$;
revoke execute on function private.approval_allowed(text, text, uuid, numeric) from public, anon, authenticated;

-- Accorder : le délégant détient la permission directement (pas de sous-délégation), le délégué est actif dans la société.
create function public.delegation_grant(p_delegate uuid, p_permission text, p_object_type text, p_object_id uuid, p_amount_limit numeric,
  p_ends_at timestamptz, p_reason text, p_starts_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_start timestamptz := coalesce(p_starts_at, now()); v_ok boolean;
begin
  perform private.require_perm('delegations.grant');
  if not private.has_perm(p_permission) then raise exception 'DELEGATION_NOT_HELD' using errcode = '42501', detail = p_permission; end if;
  if p_delegate = auth.uid() then raise exception 'DELEGATION_SELF' using errcode = '42501'; end if;
  if p_ends_at <= now() or p_ends_at <= v_start or p_ends_at > v_start + interval '90 days' then
    raise exception 'DELEGATION_WINDOW' using errcode = '22023';
  end if;
  select exists (select 1 from public.profiles where id = p_delegate and company_id = v_co and is_active) into v_ok;
  if not v_ok then raise exception 'DELEGATION_BAD_DELEGATE' using errcode = '22023'; end if;
  if p_object_id is not null then
    v_ok := case p_object_type
      when 'payment_order' then exists (select 1 from public.payment_orders where id = p_object_id and company_id = v_co)
      when 'derogation' then exists (select 1 from public.derogations where id = p_object_id and company_id = v_co)
      when 'quality_inspection' then exists (select 1 from public.quality_inspections where id = p_object_id and company_id = v_co)
      else false end;
    if not coalesce(v_ok, false) then raise exception 'DELEGATION_BAD_OBJECT' using errcode = '22023'; end if;
  end if;
  insert into public.delegations (id, company_id, delegator_id, delegate_id, permission, object_type, object_id, amount_limit, starts_at, ends_at, reason)
  values (v_id, v_co, auth.uid(), p_delegate, p_permission, p_object_type, p_object_id, p_amount_limit, v_start, p_ends_at, btrim(p_reason));
  perform private.write_audit(v_co, 'delegation.grant', 'delegation', v_id::text, p_permission, null,
    jsonb_build_object('delegate', p_delegate, 'permission', p_permission, 'object_type', p_object_type, 'object_id', p_object_id,
      'amount_limit', p_amount_limit, 'starts_at', v_start, 'ends_at', p_ends_at), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

-- Révoquer : le délégant, ou un détenteur de delegations.manage.
create function public.delegation_revoke(p_delegation uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.delegations%rowtype;
begin
  select * into d from public.delegations where id = p_delegation and company_id = private.current_company() for update;
  if not found then raise exception 'DELEGATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.delegator_id is distinct from auth.uid() then perform private.require_perm('delegations.manage'); end if;
  if d.revoked_at is not null then raise exception 'DELEGATION_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'DELEGATION_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.delegations set revoked_at = now(), revoked_by = auth.uid() where id = d.id;
  perform private.write_audit(d.company_id, 'delegation.revoke', 'delegation', d.id::text, d.permission, null,
    jsonb_build_object('revoked', true), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 3. Ordres de paiement fournisseur : préparateur ≠ approbateur
-- ---------------------------------------------------------------------
create table public.payment_orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  number           text not null,                                  -- généré par le déclencheur (PAY-AAAA-nnnnnn)
  supplier_id      uuid not null references public.suppliers(id),
  amount           numeric(14,2) not null check (amount > 0),
  reason           text not null check (length(btrim(reason)) between 5 and 300),
  status           text not null default 'prepared' check (status in ('prepared', 'approved', 'rejected')),
  prepared_by      uuid not null default auth.uid() references public.profiles(id),
  prepared_at      timestamptz not null default now(),
  decided_by       uuid references public.profiles(id),
  decided_at       timestamptz,
  decision_comment text check (decision_comment is null or length(decision_comment) <= 300),
  unique (company_id, number),
  check (decided_by is distinct from prepared_by),                                  -- séparation des tâches, en base
  check ((status = 'prepared' and decided_by is null and decided_at is null)
      or (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null))
);
create trigger payment_orders_number_i before insert on public.payment_orders for each row execute function private.doc_number('PAY-', 'payment_order');
alter table public.payment_orders enable row level security;
create policy payment_orders_select on public.payment_orders for select to authenticated
  using (company_id = private.current_company() and (prepared_by = auth.uid() or private.has_perm('payments.read') or private.has_perm('payments.approve')));
revoke all on public.payment_orders from anon, authenticated;
grant select on public.payment_orders to authenticated;
grant all on public.payment_orders to service_role;

-- Préparer : montant ≤ solde ouvert du fournisseur (même règle que supplier_payment_record).
create function public.payment_order_prepare(p_supplier uuid, p_amount numeric, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_open numeric; v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('payments.prepare');
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  if not exists (select 1 from public.suppliers where id = p_supplier and company_id = v_co) then raise exception 'PAYMENT_ORDER_BAD_SUPPLIER' using errcode = '22023'; end if;
  select coalesce(sum(total - paid_amount), 0) into v_open from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid');
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  insert into public.payment_orders (id, company_id, supplier_id, amount, reason)
  values (v_id, v_co, p_supplier, p_amount, btrim(p_reason))
  returning number into v_number;
  perform private.write_audit(v_co, 'payment_order.prepare', 'payment_order', v_id::text, v_number, null,
    jsonb_build_object('supplier', p_supplier, 'amount', p_amount), '{}'::jsonb, 'rpc');
  return jsonb_build_object('id', v_id, 'number', v_number);
end $$;

-- Décider : l'approbateur ne peut pas être le préparateur ; la permission ou une délégation bornée est requise.
create function public.payment_order_decide(p_order uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.payment_orders%rowtype; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  select * into o from public.payment_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'prepared' then raise exception 'PAYMENT_ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if o.prepared_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'payment_order'; end if;
  perform private.approval_allowed('payments.approve', 'payment_order', o.id, o.amount);
  if not p_approve and length(coalesce(v_comment, '')) < 3 then raise exception 'PAYMENT_ORDER_COMMENT_REQUIRED' using errcode = '22023'; end if;
  update public.payment_orders set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_comment = v_comment where id = o.id;
  perform private.write_audit(o.company_id, case when p_approve then 'payment_order.approve' else 'payment_order.reject' end,
    'payment_order', o.id::text, o.number, jsonb_build_object('status', o.status), jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end),
    jsonb_build_object('amount', o.amount, 'comment', v_comment, 'prepared_by', o.prepared_by), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 4. Dérogations : demande → approbation (niveau 1) → second contrôle indépendant
-- ---------------------------------------------------------------------
create table public.derogations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id),
  number        text not null,
  kind          text not null check (kind in ('credit_limit', 'discount', 'price', 'shipping_certification', 'other')),
  object_type   text not null check (length(btrim(object_type)) between 2 and 40),
  object_id     uuid,
  motive        text not null check (length(btrim(motive)) between 10 and 500),
  valid_until   date not null,
  status        text not null default 'requested' check (status in ('requested', 'approved', 'controlled', 'rejected')),
  requested_by  uuid not null default auth.uid() references public.profiles(id),
  requested_at  timestamptz not null default now(),
  approved_by   uuid references public.profiles(id),
  approved_at   timestamptz,
  control_by    uuid references public.profiles(id),
  control_at    timestamptz,
  decision_comment text check (decision_comment is null or length(decision_comment) <= 300),
  unique (company_id, number),
  check (approved_by is distinct from requested_by),                                -- séparation des tâches, en base
  check (control_by is distinct from requested_by),
  check (control_by is null or control_by is distinct from approved_by),
  check ((status = 'requested' and approved_by is null and control_by is null)
      or (status = 'approved' and approved_by is not null and control_by is null)
      or (status = 'controlled' and approved_by is not null and control_by is not null)
      or (status = 'rejected' and (approved_by is not null or control_by is not null)))
);
create trigger derogations_number_i before insert on public.derogations for each row execute function private.doc_number('DER-', 'derogation');
alter table public.derogations enable row level security;
create policy derogations_select on public.derogations for select to authenticated
  using (company_id = private.current_company() and (requested_by = auth.uid()
         or private.has_perm('derogations.approve') or private.has_perm('derogations.control') or private.has_perm('derogations.request')));
revoke all on public.derogations from anon, authenticated;
grant select on public.derogations to authenticated;
grant all on public.derogations to service_role;

create function public.derogation_request(p_kind text, p_object_type text, p_object_id uuid, p_motive text, p_valid_until date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('derogations.request');
  if p_valid_until is null or p_valid_until <= current_date or p_valid_until > current_date + 90 then raise exception 'DEROGATION_WINDOW' using errcode = '22023'; end if;
  insert into public.derogations (id, company_id, kind, object_type, object_id, motive, valid_until)
  values (v_id, v_co, p_kind, p_object_type, p_object_id, btrim(p_motive), p_valid_until)
  returning number into v_number;
  perform private.write_audit(v_co, 'derogation.request', 'derogation', v_id::text, v_number, null,
    jsonb_build_object('kind', p_kind, 'object_type', p_object_type, 'object_id', p_object_id, 'valid_until', p_valid_until), '{}'::jsonb, 'rpc');
  return jsonb_build_object('id', v_id, 'number', v_number);
end $$;

create function public.derogation_approve(p_derogation uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.derogations%rowtype; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  select * into d from public.derogations where id = p_derogation and company_id = private.current_company() for update;
  if not found then raise exception 'DEROGATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'requested' then raise exception 'DEROGATION_BAD_STATUS' using errcode = '55000'; end if;
  if d.requested_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'derogation'; end if;
  perform private.approval_allowed('derogations.approve', 'derogation', d.id, null);
  if not p_approve and length(coalesce(v_comment, '')) < 3 then raise exception 'DEROGATION_COMMENT_REQUIRED' using errcode = '22023'; end if;
  update public.derogations set status = case when p_approve then 'approved' else 'rejected' end,
    approved_by = auth.uid(), approved_at = now(), decision_comment = v_comment where id = d.id;
  perform private.write_audit(d.company_id, case when p_approve then 'derogation.approve' else 'derogation.reject' end,
    'derogation', d.id::text, d.number, jsonb_build_object('status', d.status), jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end),
    jsonb_build_object('comment', v_comment, 'requested_by', d.requested_by), 'rpc');
end $$;

-- Second contrôle : indépendant du demandeur ET du premier approbateur. Refus ou validation, tous deux tracés.
create function public.derogation_control(p_derogation uuid, p_ok boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.derogations%rowtype; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  select * into d from public.derogations where id = p_derogation and company_id = private.current_company() for update;
  if not found then raise exception 'DEROGATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'approved' then raise exception 'DEROGATION_BAD_STATUS' using errcode = '55000'; end if;
  if auth.uid() in (d.requested_by, d.approved_by) then raise exception 'SOD_NOT_INDEPENDENT' using errcode = '42501', detail = 'derogation'; end if;
  perform private.approval_allowed('derogations.control', 'derogation', d.id, null);
  if not p_ok and length(coalesce(v_comment, '')) < 3 then raise exception 'DEROGATION_COMMENT_REQUIRED' using errcode = '22023'; end if;
  update public.derogations set status = case when p_ok then 'controlled' else 'rejected' end,
    control_by = auth.uid(), control_at = now(), decision_comment = coalesce(v_comment, decision_comment) where id = d.id;
  perform private.write_audit(d.company_id, case when p_ok then 'derogation.control' else 'derogation.control_reject' end,
    'derogation', d.id::text, d.number, jsonb_build_object('status', d.status), jsonb_build_object('status', case when p_ok then 'controlled' else 'rejected' end),
    jsonb_build_object('comment', v_comment, 'requested_by', d.requested_by, 'approved_by', d.approved_by), 'rpc');
end $$;

-- Dérogation effective : contrôlée et dans sa période de validité (à consommer par les modules bloquants).
create function public.derogation_is_effective(p_derogation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.derogations where id = p_derogation and company_id = private.current_company()
    and status = 'controlled' and valid_until >= current_date)
$$;

-- ---------------------------------------------------------------------
-- 5. Lots qualité critiques : le contrôleur ne libère pas son propre lot
-- ---------------------------------------------------------------------
alter table public.quality_inspections add column critical boolean not null default false;

create function public.quality_inspection_mark_critical(p_inspection uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype;
begin
  perform private.require_perm('quality.write');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.quality_inspections set critical = true where id = i.id;
  perform private.write_audit(i.company_id, 'quality.mark_critical', 'quality_inspection', i.id::text, i.number, jsonb_build_object('critical', false),
    jsonb_build_object('critical', true), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- Décision qualité : même logique que 0020, plus (a) pouvoir par délégation bornée à l'objet, (b) auto-libération interdite
-- sur un lot critique (ouvert ou défauts saisis par la même personne).
create or replace function public.quality_inspection_decide(p_inspection uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype; v_total numeric; v_crit int; v_major int; v_worst text; v_rej numeric; v_nc uuid; v_nc_number text;
begin
  perform private.approval_allowed('quality.approve', 'quality_inspection', p_inspection, null);
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_decision not in ('accepted', 'conditional', 'rejected') then raise exception 'QUALITY_BAD_DECISION' using errcode = '22023'; end if;
  select coalesce(sum(qty), 0), count(*) filter (where severity = 'critical'), count(*) filter (where severity = 'major'),
         (array_agg(severity order by case severity when 'critical' then 1 when 'major' then 2 else 3 end))[1]
    into v_total, v_crit, v_major, v_worst
    from public.quality_defects where inspection_id = i.id;
  if (i.critical or v_crit > 0) and p_decision <> 'rejected'
     and (i.opened_by = auth.uid() or exists (select 1 from public.quality_defects where inspection_id = i.id and created_by = auth.uid())) then
    raise exception 'QUALITY_SELF_RELEASE' using errcode = '42501', detail = i.number;
  end if;
  if v_crit > 0 and p_decision <> 'rejected' then raise exception 'QUALITY_CRITICAL_DEFECT' using errcode = '22023'; end if;
  if v_major > 0 and p_decision = 'accepted' then raise exception 'QUALITY_DECISION_NOT_ALLOWED' using errcode = '22023'; end if;

  v_rej := case p_decision when 'rejected' then i.sample_size when 'conditional' then least(i.sample_size, v_total) else 0 end;
  update public.quality_inspections set status = 'closed', decision = p_decision, qty_rejected = v_rej, qty_accepted = i.sample_size - v_rej,
    note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note), closed_at = now(), closed_by = auth.uid()
    where id = i.id;

  if p_decision = 'rejected' then
    v_nc := gen_random_uuid();
    insert into public.quality_nonconformities (id, number, title, description, severity, inspection_id)
    values (v_nc, null, 'Non-conformité ' || i.number, 'Contrôle rejeté : voir les défauts constatés sur le contrôle ' || i.number,
      coalesce(v_worst, 'major'), i.id)
    returning number into v_nc_number;
    perform private.write_audit(i.company_id, 'quality.nc_open', 'quality_nonconformity', v_nc::text, v_nc_number, null,
      jsonb_build_object('inspection', i.number, 'severity', v_worst), '{}'::jsonb, 'rpc');
  end if;
  perform private.write_audit(i.company_id, 'quality.inspection_decide', 'quality_inspection', i.id::text, i.number, null,
    jsonb_build_object('decision', p_decision, 'defects', v_total, 'rejected', v_rej, 'critical', i.critical), '{}'::jsonb, 'rpc');
  return jsonb_build_object('decision', p_decision, 'qty_rejected', v_rej, 'nc_id', v_nc, 'nc_number', v_nc_number);
end $$;

-- Exécution : les fonctions ci-dessus sont accordées aux seuls utilisateurs authentifiés (les contrôles restent dans la fonction).
grant execute on function public.delegation_grant(uuid, text, text, uuid, numeric, timestamptz, text, timestamptz) to authenticated, service_role;
grant execute on function public.delegation_revoke(uuid, text) to authenticated, service_role;
grant execute on function public.payment_order_prepare(uuid, numeric, text) to authenticated, service_role;
grant execute on function public.payment_order_decide(uuid, boolean, text) to authenticated, service_role;
grant execute on function public.derogation_request(text, text, uuid, text, date) to authenticated, service_role;
grant execute on function public.derogation_approve(uuid, boolean, text) to authenticated, service_role;
grant execute on function public.derogation_control(uuid, boolean, text) to authenticated, service_role;
grant execute on function public.derogation_is_effective(uuid) to authenticated, service_role;
grant execute on function public.quality_inspection_mark_critical(uuid, text) to authenticated, service_role;

-- Annuaire minimal pour les écrans : identifiant et nom des utilisateurs actifs de la société (sans e-mail ni droits).
create function public.company_people() returns table (id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name from public.profiles p
  where p.company_id = private.current_company() and p.is_active and p.user_type = 'internal'
  order by p.full_name
$$;
grant execute on function public.company_people() to authenticated, service_role;
