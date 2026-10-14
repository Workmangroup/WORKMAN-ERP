-- ===========================================================================
-- 0091 — Recouvrement et trésorerie prévisionnelle (P067), additif
--
-- Ajoute : politique de recouvrement versionnée et signée (fréquence de contact,
-- seuils de relance et de suspension, litige et engagement suspendant la relance,
-- autorisation d'envoi externe) ; promesses de paiement suivies sur pièce ;
-- plans de paiement suivis sur encaissements réels ; brouillons de relance
-- (jamais envoyés sans autorisation) ; escalades ; scores clients révisables par
-- modèle signé ; hypothèses de trésorerie signées ; prévision 13 semaines figée
-- par exécution, chaque ligne sourcée (pièce ou promesse) ; balance âgée qui
-- exclut les montants en litige.
--
-- Aucune valeur de politique, de pondération ou d'hypothèse n'est fournie par
-- défaut : tant qu'une version n'est pas créée et signée, les fonctions refusent.
-- Les anciennes fonctions (finance_generate_reminders, treasury_forecast,
-- finance_aging_clients) sont conservées sans modification.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('collections.write', 'finance', 'Gérer promesses, plans, relances et escalades',
   'Saisie et suivi des promesses et des plans, brouillons de relance, escalades, scores et prévisions'),
  ('collections.validate', 'finance', 'Valider la politique de recouvrement et autoriser l’envoi',
   'Signature des politiques, des modèles de score et des hypothèses ; validation des plans et des brouillons ; autorisation d’envoi externe')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('collections.write', 'collections.validate')
where r.is_system and r.code in ('admin', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Gardes génériques
-- ---------------------------------------------------------------------------
-- Versions signées : figées dès la validation ; une version non validée se supprime seulement en rejet.
create function private.collections_versioned_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'valide' then raise exception 'COLLECTION_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Historique en ajout seul (exécutions de prévision, scores).
create function private.collections_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'COLLECTION_APPEND_ONLY' using errcode = '55000';
end $$;

create function private.collection_promises_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'COLLECTION_APPEND_ONLY' using errcode = '55000'; end if;
  if old.status <> 'open' then raise exception 'COLLECTION_LOCKED' using errcode = '55000'; end if;
  if new.amount <> old.amount or new.promised_on <> old.promised_on or new.invoice_id <> old.invoice_id or new.client_id <> old.client_id then
    raise exception 'COLLECTION_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;

create function private.payment_plans_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'COLLECTION_APPEND_ONLY' using errcode = '55000'; end if;
  if old.status in ('solde', 'rompu', 'rejete') then raise exception 'COLLECTION_LOCKED' using errcode = '55000'; end if;
  if new.client_id <> old.client_id or new.total_base <> old.total_base then raise exception 'COLLECTION_LOCKED' using errcode = '55000'; end if;
  if old.status = 'a_valider' and new.status not in ('a_valider', 'valide', 'rejete') then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if old.status = 'valide' and new.status not in ('valide', 'solde', 'rompu') then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if old.status = 'valide' and (new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at) then
    raise exception 'COLLECTION_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;

create function private.payment_plan_lines_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'COLLECTION_APPEND_ONLY' using errcode = '55000'; end if;
  if new.plan_id <> old.plan_id or new.seq <> old.seq or new.due_on <> old.due_on or new.amount <> old.amount then
    raise exception 'COLLECTION_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;

create function private.collection_drafts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'COLLECTION_APPEND_ONLY' using errcode = '55000'; end if;
  if old.status in ('envoi_autorise', 'annule') then raise exception 'COLLECTION_LOCKED' using errcode = '55000'; end if;
  if new.client_id <> old.client_id or new.invoice_id <> old.invoice_id or new.level <> old.level
     or new.days_late <> old.days_late or new.exigible_base <> old.exigible_base or new.body <> old.body then
    raise exception 'COLLECTION_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;

create function private.collection_escalations_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'COLLECTION_APPEND_ONLY' using errcode = '55000'; end if;
  if old.status <> 'open' then raise exception 'COLLECTION_LOCKED' using errcode = '55000'; end if;
  if new.client_id <> old.client_id or new.reason <> old.reason or new.invoice_id is distinct from old.invoice_id
     or new.promise_id is distinct from old.promise_id or new.plan_id is distinct from old.plan_id then
    raise exception 'COLLECTION_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;

revoke execute on function private.collections_versioned_guard(), private.collections_append_only(), private.collection_promises_guard(),
  private.payment_plans_guard(), private.payment_plan_lines_guard(), private.collection_drafts_guard(), private.collection_escalations_guard()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table public.collection_policies (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code                       text not null check (code ~ '^[A-Z0-9_]{3,40}$'),
  effective_from             date not null,
  contact_frequency_days     int not null check (contact_frequency_days between 1 and 365),
  level2_from_days           int not null check (level2_from_days >= 2),
  level3_from_days           int not null check (level3_from_days > level2_from_days),
  suspension_from_days       int not null check (suspension_from_days >= level3_from_days),
  suspend_on_dispute         boolean not null,
  suspend_during_commitment  boolean not null,
  external_send_authorized   boolean not null,
  status                     text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by                 uuid default auth.uid(),
  created_at                 timestamptz not null default now(),
  validated_by               uuid,
  validated_at               timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, code, effective_from)
);

create table public.collection_score_models (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code                     text not null check (code ~ '^[A-Z0-9_]{3,40}$'),
  effective_from           date not null,
  weight_days_late         numeric(8,4) not null check (weight_days_late >= 0),
  weight_broken_promises   numeric(8,4) not null check (weight_broken_promises >= 0),
  weight_open_disputes     numeric(8,4) not null check (weight_open_disputes >= 0),
  weight_broken_plans      numeric(8,4) not null check (weight_broken_plans >= 0),
  band_high_from           numeric(12,2) not null check (band_high_from >= 0),
  status                   text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by               uuid default auth.uid(),
  created_at               timestamptz not null default now(),
  validated_by             uuid,
  validated_at             timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, code, effective_from)
);

create table public.cash_forecast_hypotheses (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code                     text not null check (code ~ '^[A-Z0-9_]{3,40}$'),
  effective_from           date not null,
  collect_pct_not_due      numeric(5,2) not null check (collect_pct_not_due between 0 and 100),
  collect_pct_overdue      numeric(5,2) not null check (collect_pct_overdue between 0 and 100),
  delay_days               int not null check (delay_days between 0 and 365),
  promise_pct              numeric(5,2) not null check (promise_pct between 0 and 100),
  supplier_pay_pct         numeric(5,2) not null check (supplier_pay_pct between 0 and 100),
  supplier_disputed_pct    numeric(5,2) not null check (supplier_disputed_pct between 0 and 100),
  status                   text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by               uuid default auth.uid(),
  created_at               timestamptz not null default now(),
  validated_by             uuid,
  validated_at             timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, code, effective_from)
);

create table public.collection_promises (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  client_id     uuid not null references public.clients(id),
  invoice_id    uuid not null references public.invoices(id),
  amount        numeric(15,2) not null check (amount > 0),
  promised_on   date not null,
  note          text check (note is null or length(btrim(note)) <= 300),
  status        text not null default 'open' check (status in ('open', 'kept', 'broken', 'cancelled')),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  closed_reason text,
  check ((status = 'open') = (closed_at is null)),
  check (status = 'open' or closed_reason is not null)
);
create unique index collection_promises_one_open on public.collection_promises (invoice_id) where status = 'open';

create table public.payment_plans (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  client_id     uuid not null references public.clients(id),
  total_base    numeric(15,2) not null check (total_base > 0),
  status        text not null default 'a_valider' check (status in ('a_valider', 'valide', 'solde', 'rompu', 'rejete')),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  validated_by  uuid,
  validated_at  timestamptz,
  check ((status in ('valide', 'solde', 'rompu')) = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by)
);

create table public.payment_plan_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  plan_id     uuid not null references public.payment_plans(id),
  seq         int not null check (seq >= 1),
  due_on      date not null,
  amount      numeric(15,2) not null check (amount > 0),
  status      text not null default 'pending' check (status in ('pending', 'paid', 'late')),
  unique (plan_id, seq)
);

create table public.collection_reminder_drafts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  client_id       uuid not null references public.clients(id),
  invoice_id      uuid not null references public.invoices(id),
  level           int not null check (level in (1, 2, 3)),
  days_late       int not null check (days_late > 0),
  exigible_base   numeric(15,2) not null check (exigible_base > 0),
  body            text not null check (length(btrim(body)) between 10 and 2000),
  status          text not null default 'brouillon' check (status in ('brouillon', 'approuve', 'envoi_autorise', 'annule')),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  approved_by     uuid,
  approved_at     timestamptz,
  sent_by         uuid,
  sent_at         timestamptz,
  check ((status in ('approuve', 'envoi_autorise')) = (approved_by is not null and approved_at is not null)),
  check ((status = 'envoi_autorise') = (sent_by is not null and sent_at is not null)),
  check (approved_by is null or approved_by is distinct from created_by),
  check (sent_by is null or sent_by is distinct from created_by)
);
create unique index collection_drafts_one_live on public.collection_reminder_drafts (invoice_id, level) where status <> 'annule';

create table public.collection_escalations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  client_id    uuid not null references public.clients(id),
  invoice_id   uuid references public.invoices(id),
  promise_id   uuid references public.collection_promises(id),
  plan_id      uuid references public.payment_plans(id),
  reason       text not null check (reason in ('retard_seuil', 'promesse_rompue', 'plan_rompu')),
  status       text not null default 'open' check (status in ('open', 'closed')),
  opened_at    timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  closed_by    uuid,
  closed_at    timestamptz,
  resolution   text,
  check ((status = 'closed') = (closed_at is not null and resolution is not null)),
  check (num_nonnulls(invoice_id, promise_id, plan_id) >= 1)
);

create table public.collection_scores (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  client_id   uuid not null references public.clients(id),
  model_id    uuid not null references public.collection_score_models(id),
  as_of       date not null,
  features    jsonb not null,
  score       numeric(14,4) not null,
  band        text not null check (band in ('eleve', 'standard')),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, client_id, model_id, as_of)
);

create table public.cash_forecast_runs (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null default private.current_company() references public.companies(id) on delete cascade,
  hypothesis_id             uuid not null references public.cash_forecast_hypotheses(id),
  as_of                     date not null,
  weeks                     int not null check (weeks between 1 and 53),
  opening_balance           numeric(15,2) not null,
  receipts_total            numeric(15,2) not null check (receipts_total >= 0),
  payments_total            numeric(15,2) not null check (payments_total >= 0),
  excluded_fx_missing       int not null check (excluded_fx_missing >= 0),
  excluded_beyond_horizon   int not null check (excluded_beyond_horizon >= 0),
  created_at                timestamptz not null default now(),
  created_by                uuid default auth.uid()
);

create table public.cash_forecast_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  run_id       uuid not null references public.cash_forecast_runs(id) on delete cascade,
  week_no      int not null check (week_no between 1 and 53),
  direction    text not null check (direction in ('receipt', 'payment')),
  source_type  text not null check (source_type in ('invoice', 'promise', 'supplier_invoice')),
  source_id    uuid not null,
  source_ref   text not null,
  amount       numeric(15,2) not null check (amount > 0),
  expected_on  date not null,
  basis        text not null
);

-- Gardes et historiques
create trigger collection_policies_guard before update or delete on public.collection_policies
  for each row execute function private.collections_versioned_guard();
create trigger collection_score_models_guard before update or delete on public.collection_score_models
  for each row execute function private.collections_versioned_guard();
create trigger cash_forecast_hypotheses_guard before update or delete on public.cash_forecast_hypotheses
  for each row execute function private.collections_versioned_guard();
create trigger collection_promises_guard before update or delete on public.collection_promises
  for each row execute function private.collection_promises_guard();
create trigger payment_plans_guard before update or delete on public.payment_plans
  for each row execute function private.payment_plans_guard();
create trigger payment_plan_lines_guard before update or delete on public.payment_plan_lines
  for each row execute function private.payment_plan_lines_guard();
create trigger collection_drafts_guard before update or delete on public.collection_reminder_drafts
  for each row execute function private.collection_drafts_guard();
create trigger collection_escalations_guard before update or delete on public.collection_escalations
  for each row execute function private.collection_escalations_guard();
create trigger collection_scores_append before update or delete on public.collection_scores
  for each row execute function private.collections_append_only();
create trigger cash_forecast_runs_append before update or delete on public.cash_forecast_runs
  for each row execute function private.collections_append_only();
create trigger cash_forecast_lines_append before update or delete on public.cash_forecast_lines
  for each row execute function private.collections_append_only();

-- Sécurité de ligne : lecture par finance.read ; aucune écriture directe
do $$
declare t text;
begin
  foreach t in array array['collection_policies', 'collection_score_models', 'cash_forecast_hypotheses', 'collection_promises',
    'payment_plans', 'payment_plan_lines', 'collection_reminder_drafts', 'collection_escalations', 'collection_scores',
    'cash_forecast_runs', 'cash_forecast_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(''finance.read''))',
      t || '_select', t);
  end loop;
end $$;

revoke all on public.collection_policies, public.collection_score_models, public.cash_forecast_hypotheses, public.collection_promises,
  public.payment_plans, public.payment_plan_lines, public.collection_reminder_drafts, public.collection_escalations, public.collection_scores,
  public.cash_forecast_runs, public.cash_forecast_lines from anon, authenticated;
grant select on public.collection_policies, public.collection_score_models, public.cash_forecast_hypotheses, public.collection_promises,
  public.payment_plans, public.payment_plan_lines, public.collection_reminder_drafts, public.collection_escalations, public.collection_scores,
  public.cash_forecast_runs, public.cash_forecast_lines to authenticated;
grant all on public.collection_policies, public.collection_score_models, public.cash_forecast_hypotheses, public.collection_promises,
  public.payment_plans, public.payment_plan_lines, public.collection_reminder_drafts, public.collection_escalations, public.collection_scores,
  public.cash_forecast_runs, public.cash_forecast_lines to service_role;

-- ---------------------------------------------------------------------------
-- 4. Calculs internes (exigible, litige, conversion en devise de base)
-- ---------------------------------------------------------------------------
-- Une ligne par pièce ouverte de la société. Montants en devise de base ; une pièce sans
-- taux applicable est signalée (fx_missing) et ne compte pas. Le litige réduit l'exigible
-- (même règle que client_statement, 0086) sans toucher au solde.
create function private.collection_balances(p_as_of date) returns table (
  invoice_id uuid, client_id uuid, code text, due date, currency char(3), fx numeric,
  open_doc numeric, disp_doc numeric, exig_base numeric, disp_base numeric, fx_missing boolean)
language sql stable security definer set search_path = '' as $$
  with base as (
    select i.id, i.client_id, i.code, coalesce(i.due_date, i.issue_date) as due, i.currency,
      case when i.currency = private.base_currency() then 1::numeric else i.fx_rate end as fx,
      i.total - i.credited_amount - i.paid_amount as open_doc,
      least(greatest(i.total - i.credited_amount - i.paid_amount, 0),
        coalesce((select sum(d.amount) from public.client_invoice_disputes d where d.invoice_id = i.id and d.status = 'open'), 0)) as disp_doc
    from public.invoices i
    where i.company_id = private.current_company() and i.status in ('issued', 'partially_paid')
      and i.total - i.credited_amount - i.paid_amount > 0
  )
  select b.id, b.client_id, b.code, b.due, b.currency, b.fx, b.open_doc, b.disp_doc,
    case when b.fx is null then 0 else round((b.open_doc - b.disp_doc) * b.fx, 2) end,
    case when b.fx is null then 0 else round(b.disp_doc * b.fx, 2) end,
    b.fx is null
  from base b
$$;
revoke execute on function private.collection_balances(date) from public, anon, authenticated;

-- Politique applicable à une date : la version validée la plus récente (sinon refus)
create function private.collection_policy_at(p_as_of date) returns public.collection_policies
language plpgsql stable security definer set search_path = '' as $$
declare r public.collection_policies%rowtype;
begin
  select * into r from public.collection_policies
    where company_id = private.current_company() and status = 'valide' and effective_from <= p_as_of
    order by effective_from desc, validated_at desc limit 1;
  if not found then raise exception 'COLLECTION_NO_POLICY' using errcode = '55000'; end if;
  return r;
end $$;
revoke execute on function private.collection_policy_at(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Politique, modèle de score, hypothèses : création et signature
-- ---------------------------------------------------------------------------
create function public.collection_policy_create(p_code text, p_effective_from date, p_contact_days int, p_level2_days int, p_level3_days int,
  p_suspension_days int, p_suspend_dispute boolean, p_suspend_commitment boolean, p_external_send boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('collections.write');
  insert into public.collection_policies (id, company_id, code, effective_from, contact_frequency_days, level2_from_days, level3_from_days,
    suspension_from_days, suspend_on_dispute, suspend_during_commitment, external_send_authorized)
  values (v_id, v_co, p_code, p_effective_from, p_contact_days, p_level2_days, p_level3_days, p_suspension_days,
    p_suspend_dispute, p_suspend_commitment, p_external_send);
  perform private.write_audit(v_co, 'collections.policy_create', 'collection_policy', v_id::text, p_code, null,
    jsonb_build_object('status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.collection_policy_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.collection_policies%rowtype;
begin
  perform private.require_perm('collections.validate');
  select * into r from public.collection_policies where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'collection_policy'; end if;
  if p_validate then
    update public.collection_policies set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    delete from public.collection_policies where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'collections.policy_validate' else 'collections.policy_reject' end, 'collection_policy',
    r.id::text, r.code, jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

create function public.collection_score_model_create(p_code text, p_effective_from date, p_w_days numeric, p_w_broken_promises numeric,
  p_w_open_disputes numeric, p_w_broken_plans numeric, p_band_high_from numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('collections.write');
  insert into public.collection_score_models (id, company_id, code, effective_from, weight_days_late, weight_broken_promises,
    weight_open_disputes, weight_broken_plans, band_high_from)
  values (v_id, v_co, p_code, p_effective_from, p_w_days, p_w_broken_promises, p_w_open_disputes, p_w_broken_plans, p_band_high_from);
  perform private.write_audit(v_co, 'collections.score_model_create', 'collection_score_model', v_id::text, p_code, null,
    jsonb_build_object('status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.collection_score_model_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.collection_score_models%rowtype;
begin
  perform private.require_perm('collections.validate');
  select * into r from public.collection_score_models where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'collection_score_model'; end if;
  if p_validate then
    update public.collection_score_models set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    delete from public.collection_score_models where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'collections.score_model_validate' else 'collections.score_model_reject' end,
    'collection_score_model', r.id::text, r.code, jsonb_build_object('status', 'a_valider'),
    jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

create function public.cash_forecast_hypothesis_create(p_code text, p_effective_from date, p_pct_not_due numeric, p_pct_overdue numeric,
  p_delay_days int, p_promise_pct numeric, p_supplier_pay_pct numeric, p_supplier_disputed_pct numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('collections.write');
  insert into public.cash_forecast_hypotheses (id, company_id, code, effective_from, collect_pct_not_due, collect_pct_overdue, delay_days,
    promise_pct, supplier_pay_pct, supplier_disputed_pct)
  values (v_id, v_co, p_code, p_effective_from, p_pct_not_due, p_pct_overdue, p_delay_days, p_promise_pct, p_supplier_pay_pct, p_supplier_disputed_pct);
  perform private.write_audit(v_co, 'forecast.hypothesis_create', 'cash_forecast_hypothesis', v_id::text, p_code, null,
    jsonb_build_object('status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.cash_forecast_hypothesis_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.cash_forecast_hypotheses%rowtype;
begin
  perform private.require_perm('collections.validate');
  select * into r from public.cash_forecast_hypotheses where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'cash_forecast_hypothesis'; end if;
  if p_validate then
    update public.cash_forecast_hypotheses set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    delete from public.cash_forecast_hypotheses where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'forecast.hypothesis_validate' else 'forecast.hypothesis_reject' end,
    'cash_forecast_hypothesis', r.id::text, r.code, jsonb_build_object('status', 'a_valider'),
    jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Promesses de paiement (sur pièce)
-- ---------------------------------------------------------------------------
create function public.collection_promise_create(p_invoice uuid, p_amount numeric, p_promised_on date, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_inv public.invoices%rowtype; v_exig numeric; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('collections.write');
  select * into v_inv from public.invoices where id = p_invoice and company_id = v_co;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_inv.status not in ('issued', 'partially_paid') then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  -- Montant plafonné à l'exigible de la pièce (hors litige), en devise de la pièce
  select b.open_doc - b.disp_doc into v_exig from private.collection_balances(current_date) b where b.invoice_id = p_invoice;
  if p_amount is null or p_amount <= 0 or coalesce(v_exig, 0) <= 0 or p_amount > v_exig then
    raise exception 'COLLECTION_PROMISE_AMOUNT' using errcode = '22023';
  end if;
  if p_promised_on is null or p_promised_on < current_date then raise exception 'COLLECTION_BAD_DATE' using errcode = '22023'; end if;
  if exists (select 1 from public.collection_promises where invoice_id = p_invoice and status = 'open') then
    raise exception 'COLLECTION_PROMISE_EXISTS' using errcode = '23505';
  end if;
  insert into public.collection_promises (id, company_id, client_id, invoice_id, amount, promised_on, note)
  values (v_id, v_co, v_inv.client_id, p_invoice, p_amount, p_promised_on, nullif(btrim(p_note), ''));
  perform private.write_audit(v_co, 'collections.promise_create', 'collection_promise', v_id::text, v_inv.code, null,
    jsonb_build_object('amount', p_amount, 'promised_on', p_promised_on, 'status', 'open'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Suivi : tenue si les encaissements de la pièce depuis la création couvrent le montant
-- à l'échéance ; rompue si l'échéance est dépassée sans couverture.
create function public.collection_promise_follow_up(p_as_of date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p record; v_rec numeric; v_kept int := 0; v_broken int := 0;
begin
  perform private.require_perm('collections.write');
  for p in select * from public.collection_promises where company_id = v_co and status = 'open' order by promised_on, id for update loop
    select coalesce(sum(pay.amount), 0) into v_rec from public.invoice_payments pay
      where pay.invoice_id = p.invoice_id and pay.paid_on >= p.created_at::date and pay.paid_on <= p.promised_on;
    if v_rec >= p.amount then
      update public.collection_promises set status = 'kept', closed_at = now(), closed_reason = 'encaissements suffisants à l’échéance' where id = p.id;
      perform private.write_audit(v_co, 'collections.promise_kept', 'collection_promise', p.id::text, null, null, '{"status":"kept"}'::jsonb, '{}'::jsonb, 'rpc');
      v_kept := v_kept + 1;
    elsif p.promised_on < p_as_of then
      update public.collection_promises set status = 'broken', closed_at = now(), closed_reason = 'échéance dépassée sans encaissement suffisant' where id = p.id;
      perform private.write_audit(v_co, 'collections.promise_broken', 'collection_promise', p.id::text, null, null, '{"status":"broken"}'::jsonb, '{}'::jsonb, 'rpc');
      v_broken := v_broken + 1;
    end if;
  end loop;
  return jsonb_build_object('kept', v_kept, 'broken', v_broken,
    'still_open', (select count(*) from public.collection_promises where company_id = v_co and status = 'open'));
end $$;

create function public.collection_promise_cancel(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text;
begin
  perform private.require_perm('collections.write');
  if p_reason is null or length(btrim(p_reason)) < 5 or length(btrim(p_reason)) > 300 then raise exception 'COLLECTION_REASON_REQUIRED' using errcode = '22023'; end if;
  select status into v_status from public.collection_promises where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'open' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.collection_promises set status = 'cancelled', closed_at = now(), closed_reason = btrim(p_reason) where id = p_id;
  perform private.write_audit(v_co, 'collections.promise_cancel', 'collection_promise', p_id::text, null, null,
    jsonb_build_object('status', 'cancelled'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Plans de paiement (sur le retard exigible du client)
-- ---------------------------------------------------------------------------
create function public.payment_plan_create(p_client uuid, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); l jsonb; v_seq int := 0; v_total numeric := 0;
  v_prev date := current_date; v_due date; v_amt numeric; v_overdue numeric;
begin
  perform private.require_perm('collections.write');
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'COLLECTION_EMPTY' using errcode = '22023'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_due := (l->>'due_on')::date; v_amt := (l->>'amount')::numeric;
    if v_amt is null or v_amt <= 0 then raise exception 'COLLECTION_BAD_SCHEDULE' using errcode = '22023'; end if;
    if v_due is null or v_due <= current_date or (v_seq > 0 and v_due <= v_prev) then raise exception 'COLLECTION_BAD_SCHEDULE' using errcode = '22023'; end if;
    v_seq := v_seq + 1; v_total := v_total + v_amt; v_prev := v_due;
  end loop;
  select coalesce(sum(b.exig_base), 0) into v_overdue from private.collection_balances(current_date) b
    where b.client_id = p_client and b.due < current_date;
  if v_overdue <= 0 or v_total > v_overdue then raise exception 'COLLECTION_PLAN_EXCEEDS_OVERDUE' using errcode = '22023', detail = v_overdue::text; end if;
  insert into public.payment_plans (id, company_id, client_id, total_base) values (v_id, v_co, p_client, v_total);
  v_seq := 0;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_seq := v_seq + 1;
    insert into public.payment_plan_lines (company_id, plan_id, seq, due_on, amount)
      values (v_co, v_id, v_seq, (l->>'due_on')::date, (l->>'amount')::numeric);
  end loop;
  perform private.write_audit(v_co, 'collections.plan_create', 'payment_plan', v_id::text, null, null,
    jsonb_build_object('total_base', v_total, 'lines', v_seq, 'status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.payment_plan_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.payment_plans%rowtype; v_overdue numeric;
begin
  perform private.require_perm('collections.validate');
  select * into r from public.payment_plans where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'payment_plan'; end if;
  if p_validate then
    -- Revalidation au moment de la signature : le retard peut avoir été réglé entre-temps
    select coalesce(sum(b.exig_base), 0) into v_overdue from private.collection_balances(current_date) b
      where b.client_id = r.client_id and b.due < current_date;
    if v_overdue < r.total_base then raise exception 'COLLECTION_PLAN_EXCEEDS_OVERDUE' using errcode = '22023', detail = v_overdue::text; end if;
    update public.payment_plans set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    update public.payment_plans set status = 'rejete' where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'collections.plan_validate' else 'collections.plan_reject' end, 'payment_plan', r.id::text, null,
    jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'rejete' end), '{}'::jsonb, 'rpc');
end $$;

-- Suivi sur encaissements réels du client depuis la validation (converti en devise de base).
-- Une échéance est couverte quand le cumul encaissé atteint le cumul dû ; sinon « late »
-- une fois l'échéance dépassée. Un retard rompt le plan ; un plan couvert entièrement est soldé.
create function public.payment_plan_follow_up(p_as_of date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p record; ln record; v_rec numeric; v_cum numeric; v_status text;
  v_late boolean; v_open boolean; v_solde int := 0; v_rompu int := 0;
begin
  perform private.require_perm('collections.write');
  for p in select * from public.payment_plans where company_id = v_co and status = 'valide' order by created_at, id for update loop
    select coalesce(sum(pay.amount * case when i.currency = private.base_currency() then 1::numeric else i.fx_rate end), 0) into v_rec
      from public.invoice_payments pay join public.invoices i on i.id = pay.invoice_id
      where i.client_id = p.client_id and pay.paid_on >= p.validated_at::date;
    v_cum := 0; v_late := false; v_open := false;
    for ln in select * from public.payment_plan_lines where plan_id = p.id order by seq for update loop
      v_cum := v_cum + ln.amount;
      if v_rec >= v_cum then v_status := 'paid';
      elsif ln.due_on < p_as_of then v_status := 'late'; v_late := true;
      else v_status := 'pending'; v_open := true;
      end if;
      if v_status <> ln.status then update public.payment_plan_lines set status = v_status where id = ln.id; end if;
    end loop;
    if v_late then
      update public.payment_plans set status = 'rompu' where id = p.id;
      perform private.write_audit(v_co, 'collections.plan_broken', 'payment_plan', p.id::text, null, null, '{"status":"rompu"}'::jsonb, '{}'::jsonb, 'rpc');
      v_rompu := v_rompu + 1;
    elsif not v_open then
      update public.payment_plans set status = 'solde' where id = p.id;
      perform private.write_audit(v_co, 'collections.plan_settled', 'payment_plan', p.id::text, null, null, '{"status":"solde"}'::jsonb, '{}'::jsonb, 'rpc');
      v_solde := v_solde + 1;
    end if;
  end loop;
  return jsonb_build_object('settled', v_solde, 'broken', v_rompu,
    'still_valid', (select count(*) from public.payment_plans where company_id = v_co and status = 'valide'));
end $$;

-- ---------------------------------------------------------------------------
-- 8. Relances : brouillons seulement, politique appliquée, envoi conditionné
-- ---------------------------------------------------------------------------
-- Ne crée que des brouillons. Pour chaque pièce échue : litige (si la politique le suspend),
-- engagement en cours (promesse ouverte ou plan valide, si la politique le suspend), fréquence de
-- contact par client, et doublon par niveau sont vérifiés. Le niveau dépend des seuils de la politique.
create function public.collection_reminders_generate(p_as_of date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pol public.collection_policies%rowtype; b record; v_days int; v_level int;
  v_n int := 0; v_dispute int := 0; v_commit int := 0; v_freq int := 0; v_exists int := 0; v_body text;
begin
  perform private.require_perm('collections.write');
  pol := private.collection_policy_at(p_as_of);
  for b in select * from private.collection_balances(p_as_of) where due < p_as_of and not fx_missing and exig_base > 0 order by due, code loop
    v_days := p_as_of - b.due;
    if pol.suspend_on_dispute and b.disp_base > 0 then v_dispute := v_dispute + 1; continue; end if;
    if pol.suspend_during_commitment and (
         exists (select 1 from public.collection_promises pr where pr.invoice_id = b.invoice_id and pr.status = 'open' and pr.promised_on >= p_as_of)
         or exists (select 1 from public.payment_plans pl where pl.client_id = b.client_id and pl.status = 'valide')) then
      v_commit := v_commit + 1; continue;
    end if;
    if exists (select 1 from public.collection_reminder_drafts d where d.client_id = b.client_id and d.status <> 'annule'
        and d.created_at::date > p_as_of - pol.contact_frequency_days) then
      v_freq := v_freq + 1; continue;
    end if;
    v_level := case when v_days >= pol.level3_from_days then 3 when v_days >= pol.level2_from_days then 2 else 1 end;
    if exists (select 1 from public.collection_reminder_drafts d where d.invoice_id = b.invoice_id and d.level = v_level and d.status <> 'annule') then
      v_exists := v_exists + 1; continue;
    end if;
    v_body := format('Rappel niveau %s : facture %s échue depuis %s jour(s), montant exigible %s (devise de base). Message à valider avant tout envoi.',
      v_level, b.code, v_days, b.exig_base);
    insert into public.collection_reminder_drafts (company_id, client_id, invoice_id, level, days_late, exigible_base, body)
      values (v_co, b.client_id, b.invoice_id, v_level, v_days, b.exig_base, v_body);
    v_n := v_n + 1;
  end loop;
  perform private.write_audit(v_co, 'collections.reminders_generate', 'company', v_co::text, null, null,
    jsonb_build_object('created', v_n, 'as_of', p_as_of, 'policy', pol.code), '{}'::jsonb, 'rpc');
  return jsonb_build_object('created', v_n, 'skipped_dispute', v_dispute, 'skipped_commitment', v_commit,
    'skipped_frequency', v_freq, 'skipped_existing', v_exists, 'policy', pol.code);
end $$;

-- Validation du contenu d'un brouillon, par une autre personne que son auteur
create function public.collection_draft_approve(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.collection_reminder_drafts%rowtype;
begin
  perform private.require_perm('collections.validate');
  select * into r from public.collection_reminder_drafts where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'brouillon' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'collection_draft'; end if;
  if p_approve then
    update public.collection_reminder_drafts set status = 'approuve', approved_by = auth.uid(), approved_at = now() where id = r.id;
  else
    update public.collection_reminder_drafts set status = 'annule' where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_approve then 'collections.draft_approve' else 'collections.draft_reject' end, 'collection_draft', r.id::text, null,
    jsonb_build_object('status', 'brouillon'), jsonb_build_object('status', case when p_approve then 'approuve' else 'annule' end), '{}'::jsonb, 'rpc');
end $$;

-- Autorisation d'envoi : exige la politique d'envoi externe et une personne distincte de l'auteur.
-- Aucun connecteur d'envoi n'existe dans ce lot : l'envoi réel se fait hors de l'application.
create function public.collection_draft_authorize_send(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pol public.collection_policies%rowtype; r public.collection_reminder_drafts%rowtype;
begin
  perform private.require_perm('collections.validate');
  pol := private.collection_policy_at(current_date);
  if not pol.external_send_authorized then raise exception 'COLLECTION_SEND_NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from public.collection_reminder_drafts where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'approuve' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'collection_draft'; end if;
  update public.collection_reminder_drafts set status = 'envoi_autorise', sent_by = auth.uid(), sent_at = now() where id = r.id;
  perform private.write_audit(v_co, 'collections.draft_send_authorized', 'collection_draft', r.id::text, null,
    jsonb_build_object('status', 'approuve'), jsonb_build_object('status', 'envoi_autorise'), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 9. Escalades
-- ---------------------------------------------------------------------------
create function public.collection_escalations_run(p_as_of date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pol public.collection_policies%rowtype; b record; pr record; pl record; v_n int := 0;
begin
  perform private.require_perm('collections.write');
  pol := private.collection_policy_at(p_as_of);
  for b in select * from private.collection_balances(p_as_of) where due < p_as_of and not fx_missing and exig_base > 0
      and p_as_of - due >= pol.suspension_from_days loop
    if not exists (select 1 from public.collection_escalations e where e.invoice_id = b.invoice_id and e.reason = 'retard_seuil' and e.status = 'open') then
      insert into public.collection_escalations (company_id, client_id, invoice_id, reason) values (v_co, b.client_id, b.invoice_id, 'retard_seuil');
      v_n := v_n + 1;
    end if;
  end loop;
  for pr in select * from public.collection_promises where company_id = v_co and status = 'broken' loop
    if not exists (select 1 from public.collection_escalations e where e.promise_id = pr.id and e.status = 'open') then
      insert into public.collection_escalations (company_id, client_id, invoice_id, promise_id, reason) values (v_co, pr.client_id, pr.invoice_id, pr.id, 'promesse_rompue');
      v_n := v_n + 1;
    end if;
  end loop;
  for pl in select * from public.payment_plans where company_id = v_co and status = 'rompu' loop
    if not exists (select 1 from public.collection_escalations e where e.plan_id = pl.id and e.status = 'open') then
      insert into public.collection_escalations (company_id, client_id, plan_id, reason) values (v_co, pl.client_id, pl.id, 'plan_rompu');
      v_n := v_n + 1;
    end if;
  end loop;
  perform private.write_audit(v_co, 'collections.escalations_run', 'company', v_co::text, null, null,
    jsonb_build_object('opened', v_n, 'as_of', p_as_of), '{}'::jsonb, 'rpc');
  return jsonb_build_object('opened', v_n, 'policy', pol.code);
end $$;

create function public.collection_escalation_close(p_id uuid, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text;
begin
  perform private.require_perm('collections.write');
  if p_resolution is null or length(btrim(p_resolution)) < 5 or length(btrim(p_resolution)) > 300 then raise exception 'COLLECTION_REASON_REQUIRED' using errcode = '22023'; end if;
  select status into v_status from public.collection_escalations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'open' then raise exception 'COLLECTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.collection_escalations set status = 'closed', closed_by = auth.uid(), closed_at = now(), resolution = btrim(p_resolution) where id = p_id;
  perform private.write_audit(v_co, 'collections.escalation_close', 'collection_escalation', p_id::text, null, null,
    jsonb_build_object('status', 'closed'), jsonb_build_object('resolution', btrim(p_resolution)), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 10. Balance âgée (litige exclu de l'exigible) et score client
-- ---------------------------------------------------------------------------
create function public.collection_aging(p_as_of date default current_date) returns table (
  client_id uuid, client_code text, client_name text, not_due numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric,
  d90_plus numeric, disputed numeric, total numeric, fx_missing int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  select c.id, c.code::text, c.name::text,
    coalesce(sum(b.exig_base) filter (where b.due >= p_as_of), 0),
    coalesce(sum(b.exig_base) filter (where p_as_of - b.due between 1 and 30), 0),
    coalesce(sum(b.exig_base) filter (where p_as_of - b.due between 31 and 60), 0),
    coalesce(sum(b.exig_base) filter (where p_as_of - b.due between 61 and 90), 0),
    coalesce(sum(b.exig_base) filter (where p_as_of - b.due > 90), 0),
    coalesce(sum(b.disp_base), 0),
    coalesce(sum(b.exig_base + b.disp_base), 0),
    (count(*) filter (where b.fx_missing))::int
  from public.clients c join private.collection_balances(p_as_of) b on b.client_id = c.id
  where c.company_id = private.current_company()
  group by c.id, c.code, c.name
  order by c.code;
end $$;

-- Score par modèle nommé (révisable : un nouveau modèle donne de nouvelles lignes, l'historique reste)
create function public.collection_scores_run(p_model uuid, p_as_of date default current_date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); m public.collection_score_models%rowtype; c record; v_days numeric; v_broken int;
  v_disp int; v_plans int; v_score numeric; v_n int := 0; v_features jsonb;
begin
  perform private.require_perm('collections.write');
  select * into m from public.collection_score_models where id = p_model and company_id = v_co;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if m.status <> 'valide' or m.effective_from > p_as_of then raise exception 'COLLECTION_NO_SCORE_MODEL' using errcode = '55000'; end if;
  for c in select id from public.clients where company_id = v_co loop
    select coalesce(avg(p_as_of - b.due), 0) into v_days from private.collection_balances(p_as_of) b
      where b.client_id = c.id and b.due < p_as_of and b.exig_base > 0;
    select count(*) into v_broken from public.collection_promises pr
      where pr.client_id = c.id and pr.status = 'broken' and pr.closed_at::date >= p_as_of - 365;
    select count(*) into v_disp from public.client_invoice_disputes d join public.invoices i on i.id = d.invoice_id
      where i.client_id = c.id and d.status = 'open';
    select count(*) into v_plans from public.payment_plans pl where pl.client_id = c.id and pl.status = 'rompu';
    -- Aucun historique : client non scoré
    if v_days = 0 and v_broken = 0 and v_disp = 0 and v_plans = 0 and not exists (select 1 from public.invoices where client_id = c.id) then
      continue;
    end if;
    v_score := m.weight_days_late * v_days + m.weight_broken_promises * v_broken
      + m.weight_open_disputes * v_disp + m.weight_broken_plans * v_plans;
    v_features := jsonb_build_object('days_late_avg', round(v_days, 2), 'broken_promises_365d', v_broken,
      'open_disputes', v_disp, 'broken_plans', v_plans);
    insert into public.collection_scores (company_id, client_id, model_id, as_of, features, score, band)
      values (v_co, c.id, m.id, p_as_of, v_features, round(v_score, 4), case when v_score >= m.band_high_from then 'eleve' else 'standard' end)
      on conflict (company_id, client_id, model_id, as_of) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  perform private.write_audit(v_co, 'collections.scores_run', 'collection_score_model', m.id::text, m.code, null,
    jsonb_build_object('scored', v_n, 'as_of', p_as_of), '{}'::jsonb, 'rpc');
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Trésorerie prévisionnelle : exécutions figées, lignes sourcées
-- ---------------------------------------------------------------------------
-- Encaissements : solde exigible par pièce (hors litige) à la date d'échéance + délai de l'hypothèse,
-- au taux de recouvrement « échu » ou « non échu » ; une promesse ouverte place la part promise
-- (promise_pct) à sa date ; le reste suit la règle standard. Décaissements : échéances fournisseurs
-- (litige fournisseur au taux dédié). Une échéance dépassée tombe en semaine 1. Au-delà de l'horizon : compté, non inclus.
create function public.cash_forecast_run(p_as_of date, p_hypothesis uuid, p_weeks int default 13) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); h public.cash_forecast_hypotheses%rowtype; v_id uuid := gen_random_uuid();
  v_open numeric; v_lines jsonb; v_rec numeric := 0; v_pay numeric := 0; v_fxmiss int; v_beyond int;
begin
  perform private.require_perm('finance.read');
  perform private.require_perm('collections.write');
  if p_weeks is null or p_weeks < 1 or p_weeks > 53 then raise exception 'COLLECTION_BAD_HORIZON' using errcode = '22023'; end if;
  select * into h from public.cash_forecast_hypotheses where id = p_hypothesis and company_id = v_co;
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if h.status <> 'valide' or h.effective_from > p_as_of then raise exception 'COLLECTION_HYPOTHESIS_NOT_VALID' using errcode = '55000'; end if;
  v_open := (public.treasury_position(p_as_of) ->> 'balance')::numeric;

  with bal as (
    select b.*, pr.id as promise_id, pr.promised_on, pr.amount as promise_doc
    from private.collection_balances(p_as_of) b
    left join lateral (select x.id, x.promised_on, x.amount from public.collection_promises x
      where x.invoice_id = b.invoice_id and x.status = 'open' and x.promised_on >= p_as_of
      order by x.promised_on, x.id limit 1) pr on true
    where not b.fx_missing
  ),
  bal2 as (
    select bal.*, case when bal.promise_id is null then 0
      else round(least(round(bal.promise_doc * bal.fx, 2), bal.exig_base) * h.promise_pct / 100, 2) end as promise_amt
    from bal
  ),
  lines as (
    select 'receipt'::text as dir, 'promise'::text as st, b.invoice_id as sid, b.code as sref, b.promise_amt as amt,
      b.promised_on as exp, 'promesse de paiement suivie'::text as basis
    from bal2 b where b.promise_id is not null
    union all
    select 'receipt', 'invoice', b.invoice_id, b.code,
      round((b.exig_base - b.promise_amt) * (case when b.due < p_as_of then h.collect_pct_overdue else h.collect_pct_not_due end) / 100, 2),
      b.due + h.delay_days, 'solde de pièce (hypothèse de recouvrement)'
    from bal2 b
    union all
    select 'payment', 'supplier_invoice', s.id, s.number,
      round(round((s.total - s.paid_amount) * s.fx, 2) * (case when s.status = 'disputed' then h.supplier_disputed_pct else h.supplier_pay_pct end) / 100, 2),
      s.due_date, 'échéance fournisseur (hypothèse de paiement)'
    from (select x.id, x.number, x.total, x.paid_amount, x.status, x.due_date,
        case when x.currency = private.base_currency() then 1::numeric else x.fx_rate end as fx
      from public.supplier_invoices x
      where x.company_id = v_co and x.status in ('open', 'partially_paid', 'disputed') and x.total > x.paid_amount) s
  ),
  wk as (
    select l.*, case when l.exp < p_as_of then 1 else (l.exp - p_as_of) / 7 + 1 end as week_no
    from lines l where l.amt > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('direction', wk.dir, 'source_type', wk.st, 'source_id', wk.sid, 'source_ref', wk.sref,
      'amount', wk.amt, 'expected_on', wk.exp, 'basis', wk.basis, 'week_no', wk.week_no)) filter (where wk.week_no <= p_weeks), '[]'::jsonb),
    count(*) filter (where wk.week_no > p_weeks)::int
  into v_lines, v_beyond
  from wk;

  select coalesce(sum((l->>'amount')::numeric) filter (where l->>'direction' = 'receipt'), 0),
         coalesce(sum((l->>'amount')::numeric) filter (where l->>'direction' = 'payment'), 0)
    into v_rec, v_pay from jsonb_array_elements(v_lines) l;

  v_fxmiss := (select count(*) from private.collection_balances(p_as_of) b where b.fx_missing)::int
    + (select count(*) from public.supplier_invoices x where x.company_id = v_co and x.status in ('open', 'partially_paid', 'disputed')
        and x.total > x.paid_amount and x.currency <> private.base_currency() and x.fx_rate is null)::int;

  insert into public.cash_forecast_runs (id, company_id, hypothesis_id, as_of, weeks, opening_balance, receipts_total, payments_total,
    excluded_fx_missing, excluded_beyond_horizon)
  values (v_id, v_co, h.id, p_as_of, p_weeks, v_open, v_rec, v_pay, v_fxmiss, v_beyond);
  insert into public.cash_forecast_lines (company_id, run_id, week_no, direction, source_type, source_id, source_ref, amount, expected_on, basis)
  select v_co, v_id, (l->>'week_no')::int, l->>'direction', l->>'source_type', (l->>'source_id')::uuid, l->>'source_ref',
    (l->>'amount')::numeric, (l->>'expected_on')::date, l->>'basis'
  from jsonb_array_elements(v_lines) l;

  perform private.write_audit(v_co, 'forecast.run', 'cash_forecast_run', v_id::text, h.code, null,
    jsonb_build_object('receipts', v_rec, 'payments', v_pay, 'weeks', p_weeks, 'excluded_fx_missing', v_fxmiss, 'excluded_beyond_horizon', v_beyond),
    '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Semaines d'une exécution : entrées, sorties, net, solde projeté (à partir du solde réel d'ouverture)
create function public.cash_forecast_weeks(p_run uuid) returns table (week_no int, week_start date, receipts numeric, payments numeric, net numeric, projected_balance numeric)
language plpgsql stable security definer set search_path = '' as $$
declare r public.cash_forecast_runs%rowtype; v_bal numeric; w int;
begin
  perform private.require_perm('finance.read');
  select * into r from public.cash_forecast_runs where id = p_run and company_id = private.current_company();
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  v_bal := r.opening_balance;
  for w in 1..r.weeks loop
    week_no := w;
    week_start := r.as_of + (w - 1) * 7;
    receipts := (select coalesce(sum(l.amount), 0) from public.cash_forecast_lines l where l.run_id = r.id and l.week_no = w and l.direction = 'receipt');
    payments := (select coalesce(sum(l.amount), 0) from public.cash_forecast_lines l where l.run_id = r.id and l.week_no = w and l.direction = 'payment');
    net := receipts - payments;
    v_bal := v_bal + net;
    projected_balance := v_bal;
    return next;
  end loop;
end $$;

-- Contrôle d'une exécution : les lignes égalent les totaux figés et chaque ligne pointe une pièce existante
create function public.cash_forecast_check(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.cash_forecast_runs%rowtype; v_rec numeric; v_pay numeric; v_orphans int;
begin
  perform private.require_perm('finance.read');
  select * into r from public.cash_forecast_runs where id = p_run and company_id = private.current_company();
  if not found then raise exception 'COLLECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(sum(amount) filter (where direction = 'receipt'), 0), coalesce(sum(amount) filter (where direction = 'payment'), 0)
    into v_rec, v_pay from public.cash_forecast_lines where run_id = r.id;
  select count(*)::int into v_orphans from public.cash_forecast_lines l
    where l.run_id = r.id and not (
      (l.source_type in ('invoice', 'promise') and exists (select 1 from public.invoices i where i.id = l.source_id))
      or (l.source_type = 'supplier_invoice' and exists (select 1 from public.supplier_invoices s where s.id = l.source_id)));
  return jsonb_build_object('ok', v_rec = r.receipts_total and v_pay = r.payments_total and v_orphans = 0,
    'receipts_lines', v_rec, 'receipts_total', r.receipts_total, 'payments_lines', v_pay, 'payments_total', r.payments_total,
    'unsourced_lines', v_orphans);
end $$;
