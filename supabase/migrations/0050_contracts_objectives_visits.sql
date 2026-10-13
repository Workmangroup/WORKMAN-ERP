-- 0050 — Contrats datés, objectifs commerciaux comparables au CA, visites (agenda, GPS encadré, compte rendu relu)
-- Additive : aucune table existante n'est modifiée, aucune donnée n'est créée (pas de conditions, objectif ni visite par défaut).
-- Écritures uniquement par fonctions : les tables ne reçoivent aucun droit d'écriture direct.

-- ---------------------------------------------------------------------
-- 1. Droits (catalogue : web/src/lib/rbac/permissions.ts)
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('contracts.read',   'clients',    'Voir les contrats',       'Contrats datés, conditions valides à date et pièces signées'),
  ('contracts.write',  'clients',    'Gérer les contrats',      'Créer, signer, renouveler et résilier un contrat'),
  ('objectives.read',  'commercial', 'Voir les objectifs',      'Objectifs commerciaux et CA de même périmètre'),
  ('objectives.write', 'commercial', 'Gérer les objectifs',     'Créer des objectifs datés'),
  ('visits.read',      'clients',    'Voir les visites',        'Agenda et comptes rendus de visites de la société'),
  ('visits.write',     'clients',    'Gérer ses visites',       'Planifier, pointer et rédiger ses propres visites')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in
  ('contracts.read','contracts.write','objectives.read','objectives.write','visits.read','visits.write')
where r.code = 'admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in
  ('contracts.read','contracts.write','objectives.read','objectives.write','visits.read')
where r.code = 'direction'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in
  ('contracts.read','objectives.read','visits.read','visits.write')
where r.code = 'commercial'
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Contrats datés
--    draft → signed (pièce signée de la GED du même client) → renewed | terminated
--    Une fois signé, seules les transitions de statut sont permises ; le contenu est figé.
-- ---------------------------------------------------------------------
create table public.client_contracts (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id),
  client_id           uuid not null references public.clients(id),
  code                text not null,
  kind                text not null check (kind in ('framework', 'price_agreement', 'service', 'other')),
  status              text not null default 'draft' check (status in ('draft', 'signed', 'renewed', 'terminated')),
  start_on            date not null,
  end_on              date not null,
  auto_renew          boolean not null default false,
  renew_notice_days   int not null default 30 check (renew_notice_days between 0 and 365),
  currency            char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  payment_terms       text check (payment_terms is null or length(payment_terms) <= 120),
  discount_pct        numeric(5,2) check (discount_pct is null or discount_pct between 0 and 100),
  price_conditions    text check (price_conditions is null or length(price_conditions) <= 1000),
  renews_contract_id  uuid references public.client_contracts(id),
  signed_document_id  uuid references public.ged_documents(id),
  signed_at           timestamptz,
  signed_by_name      text check (signed_by_name is null or length(btrim(signed_by_name)) between 2 and 120),
  terminated_on       date,
  terminated_reason   text check (terminated_reason is null or length(btrim(terminated_reason)) between 3 and 300),
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  unique (company_id, code),
  constraint client_contracts_dates_chk check (end_on > start_on),
  constraint client_contracts_signed_chk check (status = 'draft' or (signed_document_id is not null and signed_at is not null
    and signed_by_name is not null and currency is not null and (payment_terms is not null or discount_pct is not null or price_conditions is not null))),
  constraint client_contracts_terminated_chk check (status <> 'terminated' or (terminated_on is not null and terminated_reason is not null)),
  constraint client_contracts_terminated_on_chk check (terminated_on is null or (terminated_on >= start_on and terminated_on <= end_on))
);
create index client_contracts_client_idx on public.client_contracts (company_id, client_id, start_on);

-- Fin effective : une résiliation coupe le contrat à la veille de la date de résiliation
create function private.contract_effective_end(p_status text, p_end date, p_terminated date) returns date
language sql immutable set search_path = '' as $$
  select case when p_status = 'terminated' and p_terminated is not null then least(p_end, p_terminated - 1) else p_end end
$$;

create function private.contract_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'CONTRACT_LOCKED' using errcode = '55000'; end if;
    return old;
  end if;
  if old.status = 'draft' then
    if new.status not in ('draft', 'signed') then raise exception 'CONTRACT_BAD_STATUS' using errcode = '55000'; end if;
    return new;
  end if;
  if new.status = old.status then
    if new is distinct from old then raise exception 'CONTRACT_LOCKED' using errcode = '55000'; end if;
    return new;
  end if;
  if old.status = 'signed' and new.status in ('terminated', 'renewed')
     and (new.company_id, new.client_id, new.code, new.kind, new.start_on, new.end_on, new.auto_renew, new.renew_notice_days,
          new.currency, new.payment_terms, new.discount_pct, new.price_conditions, new.renews_contract_id,
          new.signed_document_id, new.signed_at, new.signed_by_name)
       is not distinct from
         (old.company_id, old.client_id, old.code, old.kind, old.start_on, old.end_on, old.auto_renew, old.renew_notice_days,
          old.currency, old.payment_terms, old.discount_pct, old.price_conditions, old.renews_contract_id,
          old.signed_document_id, old.signed_at, old.signed_by_name) then
    return new;
  end if;
  raise exception 'CONTRACT_BAD_STATUS' using errcode = '55000';
end $$;
create trigger client_contracts_guard before update or delete on public.client_contracts
  for each row execute function private.contract_guard();

alter table public.client_contracts enable row level security;
create policy client_contracts_select on public.client_contracts for select to authenticated
  using (company_id = private.current_company() and private.has_perm('contracts.read'));
grant select on public.client_contracts to authenticated;

create function public.contract_create(p_client uuid, p_kind text, p_start date, p_end date, p_auto_renew boolean default false,
  p_notice_days int default 30, p_currency char(3) default null, p_payment_terms text default null,
  p_discount_pct numeric default null, p_price_conditions text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_code text := 'CTR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
begin
  perform private.require_perm('contracts.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_end <= p_start then raise exception 'CONTRACT_BAD_DATES' using errcode = '22023'; end if;
  insert into public.client_contracts (company_id, client_id, code, kind, start_on, end_on, auto_renew, renew_notice_days,
    currency, payment_terms, discount_pct, price_conditions)
  values (v_co, p_client, v_code, p_kind, p_start, p_end, coalesce(p_auto_renew, false), coalesce(p_notice_days, 30),
    p_currency, nullif(btrim(p_payment_terms), ''), p_discount_pct, nullif(btrim(p_price_conditions), ''))
  returning id into v_id;
  perform private.write_audit(v_co, 'contract.create', 'contract', v_id::text, v_code, null,
    jsonb_build_object('client_id', p_client, 'kind', p_kind, 'start_on', p_start, 'end_on', p_end), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.contract_create(uuid, text, date, date, boolean, int, char, text, numeric, text) to authenticated, service_role;

-- Signature : pièce signée du même client, conditions présentes, pas de chevauchement avec un autre contrat signé.
-- Un renouvellement doit commencer après la fin effective du contrat qu'il remplace, qui passe alors en « renewed ».
create function public.contract_sign(p_contract uuid, p_document uuid, p_signed_by text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.client_contracts%rowtype; v_prev public.client_contracts%rowtype; v_doc uuid;
begin
  perform private.require_perm('contracts.write');
  select * into c from public.client_contracts where id = p_contract and company_id = v_co for update;
  if not found then raise exception 'CONTRACT_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'draft' then raise exception 'CONTRACT_BAD_STATUS' using errcode = '55000'; end if;
  if c.currency is null then raise exception 'CONTRACT_CONDITIONS_REQUIRED' using errcode = '22023', detail = 'devise'; end if;
  if c.payment_terms is null and c.discount_pct is null and c.price_conditions is null then
    raise exception 'CONTRACT_CONDITIONS_REQUIRED' using errcode = '22023', detail = 'conditions';
  end if;
  if p_signed_by is null or length(btrim(p_signed_by)) < 2 then raise exception 'CONTRACT_SIGNATURE_REQUIRED' using errcode = '22023'; end if;
  select d.id into v_doc from public.ged_documents d where d.id = p_document and d.company_id = v_co and d.client_id = c.client_id;
  if v_doc is null then raise exception 'CONTRACT_DOCUMENT_INVALID' using errcode = '22023'; end if;

  if c.renews_contract_id is not null then
    select * into v_prev from public.client_contracts where id = c.renews_contract_id for update;
    if v_prev.status <> 'signed' then raise exception 'CONTRACT_BAD_STATUS' using errcode = '55000', detail = 'contrat remplacé'; end if;
    if c.start_on <= private.contract_effective_end(v_prev.status, v_prev.end_on, v_prev.terminated_on) then
      raise exception 'CONTRACT_RENEWAL_DATES' using errcode = '22023';
    end if;
  end if;

  if exists (select 1 from public.client_contracts x
              where x.company_id = v_co and x.client_id = c.client_id and x.id <> c.id
                and x.status = 'signed' and x.id is distinct from c.renews_contract_id
                and x.start_on <= c.end_on and x.end_on >= c.start_on) then
    raise exception 'CONTRACT_OVERLAP' using errcode = '23P01';
  end if;

  update public.client_contracts set status = 'signed', signed_document_id = v_doc, signed_at = now(),
         signed_by_name = btrim(p_signed_by) where id = c.id;
  if c.renews_contract_id is not null then
    update public.client_contracts set status = 'renewed' where id = c.renews_contract_id;
  end if;
  perform private.write_audit(v_co, 'contract.sign', 'contract', c.id::text, c.code, null,
    jsonb_build_object('status', 'signed', 'start_on', c.start_on, 'end_on', c.end_on, 'document_id', v_doc), null, 'rpc');
  return c.id;
end $$;
grant execute on function public.contract_sign(uuid, uuid, text) to authenticated, service_role;

-- Renouvellement : nouveau brouillon lié au contrat signé ; un seul renouvellement par contrat
create function public.contract_renew(p_contract uuid, p_start date, p_end date, p_currency char(3), p_payment_terms text default null,
  p_discount_pct numeric default null, p_price_conditions text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_prev public.client_contracts%rowtype; v_id uuid; v_code text := 'CTR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
begin
  perform private.require_perm('contracts.write');
  select * into v_prev from public.client_contracts where id = p_contract and company_id = v_co;
  if not found then raise exception 'CONTRACT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_prev.status <> 'signed' then raise exception 'CONTRACT_BAD_STATUS' using errcode = '55000'; end if;
  if p_end <= p_start then raise exception 'CONTRACT_BAD_DATES' using errcode = '22023'; end if;
  if p_start <= private.contract_effective_end(v_prev.status, v_prev.end_on, v_prev.terminated_on) then
    raise exception 'CONTRACT_RENEWAL_DATES' using errcode = '22023';
  end if;
  if exists (select 1 from public.client_contracts where renews_contract_id = v_prev.id) then
    raise exception 'CONTRACT_ALREADY_RENEWED' using errcode = '55000';
  end if;
  insert into public.client_contracts (company_id, client_id, code, kind, start_on, end_on, auto_renew, renew_notice_days,
    currency, payment_terms, discount_pct, price_conditions, renews_contract_id)
  values (v_co, v_prev.client_id, v_code, v_prev.kind, p_start, p_end, v_prev.auto_renew, v_prev.renew_notice_days,
    p_currency, nullif(btrim(p_payment_terms), ''), p_discount_pct, nullif(btrim(p_price_conditions), ''), v_prev.id)
  returning id into v_id;
  perform private.write_audit(v_co, 'contract.renew', 'contract', v_id::text, v_code, null,
    jsonb_build_object('renews', v_prev.id, 'start_on', p_start, 'end_on', p_end), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.contract_renew(uuid, date, date, char, text, numeric, text) to authenticated, service_role;

create function public.contract_terminate(p_contract uuid, p_on date, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.client_contracts%rowtype;
begin
  perform private.require_perm('contracts.write');
  select * into c from public.client_contracts where id = p_contract and company_id = v_co for update;
  if not found then raise exception 'CONTRACT_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'signed' then raise exception 'CONTRACT_BAD_STATUS' using errcode = '55000'; end if;
  if p_on is null or p_on < c.start_on or p_on > c.end_on then raise exception 'CONTRACT_BAD_DATES' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'CONTRACT_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.client_contracts set status = 'terminated', terminated_on = p_on, terminated_reason = btrim(p_reason) where id = c.id;
  perform private.write_audit(v_co, 'contract.terminate', 'contract', c.id::text, c.code, null,
    jsonb_build_object('terminated_on', p_on), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
grant execute on function public.contract_terminate(uuid, date, text) to authenticated, service_role;

-- Conditions valides à une date : le contrat signé (ou renouvelé / résilié) qui couvre cette date pour ce client.
-- Aucun contrat couvrant la date : null (aucune condition n'est supposée).
create function public.contract_conditions_at(p_client uuid, p_on date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.client_contracts%rowtype; v_end date;
begin
  perform private.require_perm('contracts.read');
  for c in select * from public.client_contracts
            where company_id = v_co and client_id = p_client and status in ('signed', 'renewed', 'terminated')
            order by start_on desc loop
    v_end := private.contract_effective_end(c.status, c.end_on, c.terminated_on);
    if c.start_on <= p_on and v_end >= p_on then
      return jsonb_build_object('contract_id', c.id, 'code', c.code, 'status', c.status, 'start_on', c.start_on, 'effective_end', v_end,
        'currency', c.currency, 'payment_terms', c.payment_terms, 'discount_pct', c.discount_pct, 'price_conditions', c.price_conditions,
        'signed_document_id', c.signed_document_id, 'signed_by_name', c.signed_by_name, 'signed_at', c.signed_at);
    end if;
  end loop;
  return null;
end $$;
grant execute on function public.contract_conditions_at(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Objectives commerciaux datés, comparables au CA
--    Périmètre « société » ou « client » ; devise = devise de base de la société au moment de la saisie.
--    Le CA suit la même règle que le pipeline (P022) : factures émises moins avoirs émis, converties au taux validé.
-- ---------------------------------------------------------------------
create table public.sales_objectives (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id),
  scope          text not null check (scope in ('company', 'client')),
  client_id      uuid references public.clients(id),
  label          text not null check (length(btrim(label)) between 2 and 120),
  period_start   date not null,
  period_end     date not null check (period_end >= period_start),
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  target_amount  numeric(14,2) not null check (target_amount > 0),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  constraint sales_objectives_scope_chk check ((scope = 'client') = (client_id is not null))
);
create unique index sales_objectives_uq on public.sales_objectives (company_id, scope,
  coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, period_end);
create trigger sales_objectives_no_change before update or delete on public.sales_objectives
  for each row execute function private.append_only_guard();

alter table public.sales_objectives enable row level security;
create policy sales_objectives_select on public.sales_objectives for select to authenticated
  using (company_id = private.current_company() and private.has_perm('objectives.read'));
grant select on public.sales_objectives to authenticated;

create function public.objective_create(p_scope text, p_client uuid, p_label text, p_start date, p_end date, p_target numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_base char(3) := private.base_currency();
begin
  perform private.require_perm('objectives.write');
  if p_scope = 'client' then
    if p_client is null then raise exception 'OBJECTIVE_BAD_SCOPE' using errcode = '22023'; end if;
    if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then
      raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
    end if;
  elsif p_scope = 'company' then
    if p_client is not null then raise exception 'OBJECTIVE_BAD_SCOPE' using errcode = '22023'; end if;
  else
    raise exception 'OBJECTIVE_BAD_SCOPE' using errcode = '22023';
  end if;
  if p_end < p_start then raise exception 'CONTRACT_BAD_DATES' using errcode = '22023'; end if;
  if p_target is null or p_target <= 0 then raise exception 'OBJECTIVE_TARGET_INVALID' using errcode = '22023'; end if;
  if v_base is null then raise exception 'OBJECTIVE_NO_BASE_CURRENCY' using errcode = '55000'; end if;
  insert into public.sales_objectives (company_id, scope, client_id, label, period_start, period_end, currency, target_amount)
  values (v_co, p_scope, case when p_scope = 'client' then p_client end, btrim(p_label), p_start, p_end, v_base, p_target)
  returning id into v_id;
  perform private.write_audit(v_co, 'objective.create', 'objective', v_id::text, btrim(p_label), null,
    jsonb_build_object('scope', p_scope, 'client_id', p_client, 'period_start', p_start, 'period_end', p_end, 'target', p_target, 'currency', v_base), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.objective_create(text, uuid, text, date, date, numeric) to authenticated, service_role;

-- Progression : même périmètre et même période pour l'objectif et pour le CA.
-- Le CA exige invoices.read ; sans ce droit, seul l'objectif est renvoyé (CA absent, pas nul).
create function public.objective_progress(p_objective uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.sales_objectives%rowtype; r record; v_fx numeric; v_minor int;
  v_ca numeric := 0; v_n int := 0; v_no_rate int := 0; v_name text;
begin
  perform private.require_perm('objectives.read');
  select * into o from public.sales_objectives where id = p_objective and company_id = v_co;
  if not found then raise exception 'OBJECTIVE_NOT_FOUND' using errcode = 'P0002'; end if;
  select minor_units into v_minor from public.currencies where code = o.currency;
  v_minor := coalesce(v_minor, 2);
  if o.client_id is not null then select c.name into v_name from public.clients c where c.id = o.client_id; end if;

  if private.has_perm('invoices.read') then
    for r in select i.subtotal, i.currency, i.issue_date from public.invoices i
              where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid', 'credited')
                and i.issue_date between o.period_start and o.period_end
                and (o.scope = 'company' or i.client_id = o.client_id) loop
      v_fx := private.fx_or_null(r.currency, r.issue_date, o.currency);
      if v_fx is null then v_no_rate := v_no_rate + 1; continue; end if;
      v_ca := v_ca + round(r.subtotal * v_fx, v_minor); v_n := v_n + 1;
    end loop;
    for r in select c.subtotal, c.currency, c.issue_date from public.credit_notes c
              where c.company_id = v_co and c.status = 'issued'
                and c.issue_date between o.period_start and o.period_end
                and (o.scope = 'company' or c.client_id = o.client_id) loop
      v_fx := private.fx_or_null(r.currency, r.issue_date, o.currency);
      if v_fx is null then v_no_rate := v_no_rate + 1; continue; end if;
      v_ca := v_ca - round(r.subtotal * v_fx, v_minor);
    end loop;
  end if;

  return jsonb_build_object(
    'objective_id', o.id, 'label', o.label, 'scope', o.scope, 'client_id', o.client_id, 'client_name', v_name,
    'period_start', o.period_start, 'period_end', o.period_end, 'currency', o.currency, 'target', o.target_amount,
    'realised_net_ht', case when private.has_perm('invoices.read') then v_ca end,
    'percent', case when private.has_perm('invoices.read') then round(v_ca / o.target_amount * 100, 1) end,
    'invoices_counted', case when private.has_perm('invoices.read') then v_n end,
    'excluded_no_rate', case when private.has_perm('invoices.read') then v_no_rate end);
end $$;
grant execute on function public.objective_progress(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Visites : agenda (plan), pointage GPS encadré, photos, compte rendu avec dictée relue
--    Seul le responsable de la visite la planifie, la pointe et la rédige. Lecture : visits.read.
-- ---------------------------------------------------------------------
create table public.visit_plans (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  client_id    uuid not null references public.clients(id),
  contact_id   uuid references public.client_contacts(id),
  owner_id     uuid not null default auth.uid(),
  planned_at   timestamptz not null,
  duration_min int not null default 30 check (duration_min between 5 and 480),
  purpose      text not null check (length(btrim(purpose)) between 2 and 300),
  status       text not null default 'planned' check (status in ('planned', 'done', 'cancelled')),
  created_at   timestamptz not null default now()
);
create index visit_plans_agenda_idx on public.visit_plans (company_id, planned_at);

create function private.visit_plan_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if new.status = old.status then
    if new is distinct from old then raise exception 'VISIT_LOCKED' using errcode = '55000'; end if;
    return new;
  end if;
  if old.status = 'planned' and new.status in ('done', 'cancelled')
     and (new.company_id, new.client_id, new.contact_id, new.owner_id, new.planned_at, new.duration_min, new.purpose, new.created_at)
       is not distinct from (old.company_id, old.client_id, old.contact_id, old.owner_id, old.planned_at, old.duration_min, old.purpose, old.created_at) then
    return new;
  end if;
  raise exception 'VISIT_BAD_STATUS' using errcode = '55000';
end $$;
create trigger visit_plans_guard before update or delete on public.visit_plans
  for each row execute function private.visit_plan_guard();

-- Pointage : une seule fois par visite, dans une fenêtre de ±24 h autour de l'heure prévue.
-- « captured » exige une position et une précision ; « unavailable » ou « denied » exigent un motif et ne contiennent AUCUNE coordonnée.
create table public.visit_checkins (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  plan_id      uuid not null unique references public.visit_plans(id),
  recorded_by  uuid default auth.uid(),
  recorded_at  timestamptz not null default now(),
  gps_status   text not null check (gps_status in ('captured', 'unavailable', 'denied')),
  latitude     numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude    numeric(9,6) check (longitude is null or longitude between -180 and 180),
  accuracy_m   numeric(8,1) check (accuracy_m is null or accuracy_m > 0),
  reason       text check (reason is null or length(btrim(reason)) between 3 and 200),
  constraint visit_checkins_gps_chk check (
    (gps_status = 'captured' and latitude is not null and longitude is not null and accuracy_m is not null and reason is null)
    or (gps_status <> 'captured' and latitude is null and longitude is null and accuracy_m is null and reason is not null))
);
create trigger visit_checkins_no_change before update or delete on public.visit_checkins
  for each row execute function private.append_only_guard();

create table public.visit_photos (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  plan_id      uuid not null references public.visit_plans(id),
  document_id  uuid not null references public.ged_documents(id),
  caption      text check (caption is null or length(btrim(caption)) <= 200),
  recorded_by  uuid default auth.uid(),
  recorded_at  timestamptz not null default now(),
  unique (plan_id, document_id)
);
create trigger visit_photos_no_change before update or delete on public.visit_photos
  for each row execute function private.append_only_guard();

-- Compte rendu : une seule version finale. Si une dictée est fournie, elle doit être relue (dictation_reviewed) avant enregistrement.
create table public.visit_reports (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id),
  plan_id            uuid not null unique references public.visit_plans(id),
  dictation_text     text check (dictation_text is null or length(dictation_text) <= 8000),
  report_text        text not null check (length(btrim(report_text)) between 5 and 8000),
  dictation_reviewed boolean not null default false,
  recorded_by        uuid default auth.uid(),
  recorded_at        timestamptz not null default now(),
  constraint visit_reports_review_chk check (dictation_text is null or dictation_reviewed = true)
);
create trigger visit_reports_no_change before update or delete on public.visit_reports
  for each row execute function private.append_only_guard();

alter table public.visit_plans enable row level security;
alter table public.visit_checkins enable row level security;
alter table public.visit_photos enable row level security;
alter table public.visit_reports enable row level security;
create policy visit_plans_select on public.visit_plans for select to authenticated
  using (company_id = private.current_company() and private.has_perm('visits.read'));
create policy visit_checkins_select on public.visit_checkins for select to authenticated
  using (company_id = private.current_company() and private.has_perm('visits.read'));
create policy visit_photos_select on public.visit_photos for select to authenticated
  using (company_id = private.current_company() and private.has_perm('visits.read'));
create policy visit_reports_select on public.visit_reports for select to authenticated
  using (company_id = private.current_company() and private.has_perm('visits.read'));
grant select on public.visit_plans, public.visit_checkins, public.visit_photos, public.visit_reports to authenticated;

create function private.visit_owned(p_plan uuid) returns public.visit_plans
language plpgsql stable security definer set search_path = '' as $$
declare v public.visit_plans%rowtype;
begin
  select * into v from public.visit_plans where id = p_plan and company_id = private.current_company();
  if not found then raise exception 'VISIT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.owner_id is distinct from auth.uid() then raise exception 'VISIT_NOT_OWNER' using errcode = '42501'; end if;
  return v;
end $$;
revoke execute on function private.visit_owned(uuid) from public, anon;
grant execute on function private.visit_owned(uuid) to authenticated;

create function public.visit_plan_create(p_client uuid, p_contact uuid, p_planned_at timestamptz, p_duration int, p_purpose text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('visits.write');
  if auth.uid() is null then raise exception 'VISIT_NOT_OWNER' using errcode = '42501'; end if;
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_contact is not null and not exists (select 1 from public.client_contacts k where k.id = p_contact and k.client_id = p_client) then
    raise exception 'CLIENT_LINK_INVALID' using errcode = '22023', detail = 'contact';
  end if;
  if p_planned_at is null then raise exception 'VISIT_BAD_DATE' using errcode = '22023'; end if;
  insert into public.visit_plans (company_id, client_id, contact_id, owner_id, planned_at, duration_min, purpose)
  values (v_co, p_client, p_contact, auth.uid(), p_planned_at, coalesce(p_duration, 30), btrim(p_purpose))
  returning id into v_id;
  perform private.write_audit(v_co, 'visit.plan', 'visit', v_id::text, btrim(p_purpose), null,
    jsonb_build_object('client_id', p_client, 'planned_at', p_planned_at), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.visit_plan_create(uuid, uuid, timestamptz, int, text) to authenticated, service_role;

create function public.visit_plan_cancel(p_plan uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.visit_plans%rowtype;
begin
  perform private.require_perm('visits.write');
  v := private.visit_owned(p_plan);
  if v.status <> 'planned' then raise exception 'VISIT_BAD_STATUS' using errcode = '55000'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'VISIT_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.visit_plans set status = 'cancelled' where id = v.id;
  perform private.write_audit(v.company_id, 'visit.cancel', 'visit', v.id::text, v.purpose, null, null, jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
grant execute on function public.visit_plan_cancel(uuid, text) to authenticated, service_role;

create function public.visit_checkin(p_plan uuid, p_gps_status text, p_latitude numeric, p_longitude numeric, p_accuracy_m numeric, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.visit_plans%rowtype; v_id uuid;
begin
  perform private.require_perm('visits.write');
  v := private.visit_owned(p_plan);
  if v.status <> 'planned' then raise exception 'VISIT_BAD_STATUS' using errcode = '55000'; end if;
  if abs(extract(epoch from (now() - v.planned_at))) > 86400 then raise exception 'VISIT_OUT_OF_WINDOW' using errcode = '55000'; end if;
  if exists (select 1 from public.visit_checkins where plan_id = v.id) then raise exception 'VISIT_ALREADY_CHECKED_IN' using errcode = '55000'; end if;
  if p_gps_status = 'captured' then
    if p_latitude is null or p_longitude is null or p_accuracy_m is null then raise exception 'VISIT_GPS_INVALID' using errcode = '22023'; end if;
    -- Précision trop faible : la position n'est pas enregistrée comme preuve ; le pointage doit être refait ou déclaré indisponible
    if p_accuracy_m > 500 then raise exception 'VISIT_GPS_IMPRECISE' using errcode = '22023'; end if;
    insert into public.visit_checkins (company_id, plan_id, gps_status, latitude, longitude, accuracy_m)
    values (v.company_id, v.id, 'captured', p_latitude, p_longitude, p_accuracy_m) returning id into v_id;
  elsif p_gps_status in ('unavailable', 'denied') then
    if p_latitude is not null or p_longitude is not null or p_accuracy_m is not null then raise exception 'VISIT_GPS_INVALID' using errcode = '22023'; end if;
    if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'VISIT_REASON_REQUIRED' using errcode = '22023'; end if;
    insert into public.visit_checkins (company_id, plan_id, gps_status, reason) values (v.company_id, v.id, p_gps_status, btrim(p_reason)) returning id into v_id;
  else
    raise exception 'VISIT_GPS_INVALID' using errcode = '22023';
  end if;
  perform private.write_audit(v.company_id, 'visit.checkin', 'visit', v.id::text, v.purpose, null,
    jsonb_build_object('gps_status', p_gps_status), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.visit_checkin(uuid, text, numeric, numeric, numeric, text) to authenticated, service_role;

create function public.visit_photo_add(p_plan uuid, p_document uuid, p_caption text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.visit_plans%rowtype; v_id uuid;
begin
  perform private.require_perm('visits.write');
  v := private.visit_owned(p_plan);
  if v.status <> 'planned' then raise exception 'VISIT_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.ged_documents d where d.id = p_document and d.company_id = v.company_id and d.client_id = v.client_id) then
    raise exception 'VISIT_PHOTO_INVALID' using errcode = '22023';
  end if;
  insert into public.visit_photos (company_id, plan_id, document_id, caption)
  values (v.company_id, v.id, p_document, nullif(btrim(p_caption), '')) returning id into v_id;
  return v_id;
end $$;
grant execute on function public.visit_photo_add(uuid, uuid, text) to authenticated, service_role;

create function public.visit_report_finalize(p_plan uuid, p_report text, p_dictation text default null, p_reviewed boolean default false)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.visit_plans%rowtype; v_id uuid;
begin
  perform private.require_perm('visits.write');
  v := private.visit_owned(p_plan);
  if v.status <> 'planned' then raise exception 'VISIT_BAD_STATUS' using errcode = '55000'; end if;
  if p_dictation is not null and not coalesce(p_reviewed, false) then raise exception 'VISIT_DICTATION_NOT_REVIEWED' using errcode = '22023'; end if;
  if exists (select 1 from public.visit_reports where plan_id = v.id) then raise exception 'VISIT_ALREADY_REPORTED' using errcode = '55000'; end if;
  insert into public.visit_reports (company_id, plan_id, dictation_text, report_text, dictation_reviewed)
  values (v.company_id, v.id, nullif(btrim(p_dictation), ''), btrim(p_report), coalesce(p_reviewed, false)) returning id into v_id;
  update public.visit_plans set status = 'done' where id = v.id;
  perform private.write_audit(v.company_id, 'visit.report', 'visit', v.id::text, v.purpose, null,
    jsonb_build_object('reviewed', coalesce(p_reviewed, false), 'dictated', p_dictation is not null), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.visit_report_finalize(uuid, text, text, boolean) to authenticated, service_role;

-- Verrouillage : tables de journal et de fonctions uniquement
revoke all on public.client_contracts, public.sales_objectives, public.visit_plans, public.visit_checkins,
  public.visit_photos, public.visit_reports from anon;
revoke insert, update, delete, truncate on public.client_contracts, public.sales_objectives, public.visit_plans, public.visit_checkins,
  public.visit_photos, public.visit_reports from authenticated;
