-- 0088_fx_versions_revaluation — Taux de change versionnés, politique de réévaluation signée, réévaluation des postes ouverts et reprise (P063)
-- Existant conservé et réutilisé :
--  * devises (currencies, 0027), taux exchange_rates avec source et signature (0040 : exchange_rate_set, exchange_rate_validate,
--    fx_rate_at lu par la tarification), taux figés sur factures (invoices.fx_rate / base_total, 0027), positions latentes et réalisées
--    (fx_open_positions, fx_realized_gains, 0027), écarts réalisés au règlement (0031), grand livre (gl_post, 0031 ; comptes 411, 401, 666, 766).
-- Corrections :
--  * Un taux n'est jamais écrasé : la saisie d'une même date et d'une même devise crée une version (version = n + 1, attribuée par déclencheur).
--    La version la plus récente fait foi pour fx_rate (facturation, positions) ; les anciennes restent consultables (fx_rate_history).
--    Avant ce lot, fx_rate_set écrasait la valeur du jour (on conflict do update).
--  * Une version n'est modifiable qu'une fois : sa signature (a_valider → valide, 0040). Elle n'est jamais supprimée.
--
-- Réévaluation :
--  * La politique (méthode de reprise, arrondi) est saisie puis signée par une autre personne (finance.write, séparation des tâches).
--    Aucune valeur par défaut : sans politique validée, aucune réévaluation (FX_POLICY_MISSING / FX_POLICY_NOT_VALIDATED).
--  * Arrondi : par document, aux décimales de la devise de base (règle existante ; seule valeur admise par la politique).
--  * Réévaluation d'une date : une seule par société et par date ; une seule non reprise à la fois (FX_REVAL_OPEN_RUN, car les positions
--    se mesurent au taux de transaction) ; taux du jour signé requis (FX_RATE_NOT_VALIDATED) ; écriture OD équilibrée par document ;
--    détail figé (fx_revaluation_lines).
--  * Reprise : seulement si la politique de la réévaluation prévoit « reversal_next_period » ; écriture inverse datée après la
--    date de réévaluation ; une seule reprise. Réévaluations, détails et reprises ne sont jamais modifiés.
-- Erreurs : FX_IMMUTABLE, FX_POLICY_MISSING, FX_POLICY_NOT_VALIDATED, FX_POLICY_IMMUTABLE, FX_REVAL_ALREADY_RUN, FX_REVAL_OPEN_RUN,
-- FX_RATE_NOT_VALIDATED, FX_REVAL_NOT_FOUND, FX_REVAL_ALREADY_REVERSED, FX_REVAL_NO_REVERSAL, FX_REVAL_NO_ENTRY, FX_REVAL_REVERSAL_DATE,
-- FX_DATE_INVALID, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Taux : versions append-only (déclencheur d'attribution, pas d'écrasement)
-- ---------------------------------------------------------------------------
alter table public.exchange_rates add column version int check (version >= 1);
update public.exchange_rates set version = 1 where version is null;
alter table public.exchange_rates alter column version set not null;
alter table public.exchange_rates drop constraint if exists exchange_rates_company_id_rate_date_currency_key;
alter table public.exchange_rates add constraint exchange_rates_version_uq unique (company_id, rate_date, currency, version);

create function private.exchange_rates_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.version is null then
    select coalesce(max(r.version), 0) + 1 into new.version from public.exchange_rates r
     where r.company_id = new.company_id and r.rate_date = new.rate_date and r.currency = new.currency;
  end if;
  return new;
end $$;
revoke execute on function private.exchange_rates_version() from public, anon, authenticated;
create trigger exchange_rates_version_bi before insert on public.exchange_rates
  for each row execute function private.exchange_rates_version();

-- Une version ne change qu'une fois : sa signature (a_valider → valide, 0040). Jamais supprimée.
create function private.exchange_rates_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'FX_IMMUTABLE' using errcode = '55000'; end if;
  if old.status = 'a_valider' and new.status = 'valide'
     and (new.id, new.company_id, new.rate_date, new.currency, new.rate, new.version, new.source, new.created_by, new.created_at)
         is not distinct from (old.id, old.company_id, old.rate_date, old.currency, old.rate, old.version, old.source, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'FX_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.exchange_rates_guard() from public, anon, authenticated;
create trigger exchange_rates_guard_bud before update or delete on public.exchange_rates
  for each row execute function private.exchange_rates_guard();

-- Saisie (historique conservé) : la version est attribuée à l'insertion
create or replace function public.fx_rate_set(p_date date, p_currency text, p_rate numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_cur char(3) := upper(btrim(coalesce(p_currency, ''))); v_id uuid := gen_random_uuid(); v_ver int;
begin
  perform private.require_perm('finance.write');
  if p_date is null or p_date > current_date + 1 then raise exception 'FX_DATE_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.currencies c where c.code = v_cur) then raise exception 'FX_CURRENCY_UNKNOWN' using errcode = '22023'; end if;
  if v_cur = private.base_currency() then raise exception 'FX_CURRENCY_IS_BASE' using errcode = '22023'; end if;
  if p_rate is null or p_rate <= 0 or p_rate > 1000000 then raise exception 'FX_RATE_INVALID' using errcode = '22023'; end if;
  insert into public.exchange_rates (id, company_id, rate_date, currency, rate, created_by)
  values (v_id, v_co, p_date, v_cur, p_rate, auth.uid())
  returning version into v_ver;
  perform private.write_audit(v_co, 'finance.fx_rate', 'exchange_rate', v_id::text, v_cur, null,
    jsonb_build_object('date', p_date, 'rate', p_rate, 'version', v_ver, 'status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Taux applicable pour la facturation et les positions : la version la plus récente à la date ou avant (signée ou non)
create or replace function public.fx_rate(p_currency text, p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_cur char(3) := upper(btrim(coalesce(p_currency, ''))); v_rate numeric;
begin
  if v_cur = private.base_currency() then return 1; end if;
  select r.rate into v_rate from public.exchange_rates r
   where r.company_id = private.current_company() and r.currency = v_cur and r.rate_date <= p_date
   order by r.rate_date desc, r.version desc limit 1;
  if v_rate is null then
    raise exception 'FX_RATE_MISSING' using errcode = 'P0002', detail = v_cur || ' ' || p_date::text;
  end if;
  return v_rate;
end $$;

-- Même règle dans la comptabilisation des écarts (0031)
create or replace function private.gl_fx(p_company uuid, p_currency char(3), p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_base char(3); v_rate numeric;
begin
  v_base := coalesce((select s.base_currency from public.finance_settings s where s.company_id = p_company), 'EUR')::char(3);
  if p_currency = v_base then return 1; end if;
  select r.rate into v_rate from public.exchange_rates r
   where r.company_id = p_company and r.currency = p_currency and r.rate_date <= p_date
   order by r.rate_date desc, r.version desc limit 1;
  if v_rate is null then raise exception 'FX_RATE_MISSING' using errcode = 'P0002', detail = p_currency || ' ' || p_date::text; end if;
  return v_rate;
end $$;

-- Historique complet d'une devise : toutes les versions, avec leur signature
create function public.fx_rate_history(p_currency text) returns table (
  rate_date date, version int, rate numeric, status text, source text, created_at timestamptz, validated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  select r.rate_date, r.version, r.rate, r.status, r.source, r.created_at, r.validated_at
    from public.exchange_rates r
   where r.company_id = private.current_company() and r.currency = upper(btrim(p_currency))
   order by r.rate_date desc, r.version desc;
end $$;

-- La version en vigueur à une date est-elle signée ? (même règle de version que fx_rate)
create function private.fx_rate_validated(p_company uuid, p_currency char(3), p_date date) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_status text;
begin
  select r.status into v_status from public.exchange_rates r
   where r.company_id = p_company and r.currency = p_currency and r.rate_date <= p_date
   order by r.rate_date desc, r.version desc limit 1;
  return v_status = 'valide';
end $$;
revoke execute on function private.fx_rate_validated(uuid, char, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Politique de réévaluation : méthode de reprise et arrondi, signés par une autre personne
-- ---------------------------------------------------------------------------
create table public.fx_policies (
  company_id   uuid primary key default private.current_company() references public.companies(id) on delete cascade,
  reval_method text not null check (reval_method in ('reversal_next_period', 'no_reversal')),
  rounding     text not null check (rounding in ('per_document_base_minor')),
  status       text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  set_by       uuid default auth.uid(),
  set_at       timestamptz not null default now(),
  validated_by uuid,
  validated_at timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from set_by)
);
alter table public.fx_policies enable row level security;
create policy fx_policies_select on public.fx_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.fx_policies from anon, authenticated;
grant select on public.fx_policies to authenticated;
grant all on public.fx_policies to service_role;

create function public.fx_policy_set(p_method text, p_rounding text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.fx_policies%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into p from public.fx_policies where company_id = v_co for update;
  if found and p.status = 'valide' then raise exception 'FX_POLICY_IMMUTABLE' using errcode = '55000'; end if;
  insert into public.fx_policies (company_id, reval_method, rounding, status, set_by, set_at)
  values (v_co, p_method, p_rounding, 'a_valider', auth.uid(), now())
  on conflict (company_id) do update set reval_method = excluded.reval_method, rounding = excluded.rounding,
    status = 'a_valider', set_by = excluded.set_by, set_at = excluded.set_at;
  perform private.write_audit(v_co, 'fx.policy_set', 'fx_policy', v_co::text, null, null,
    jsonb_build_object('method', p_method, 'rounding', p_rounding, 'status', 'a_valider'), '{}'::jsonb, 'rpc');
end $$;

create function public.fx_policy_validate(p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.fx_policies%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into p from public.fx_policies where company_id = v_co for update;
  if not found then raise exception 'FX_POLICY_MISSING' using errcode = 'P0002'; end if;
  if p.status <> 'a_valider' then raise exception 'FX_POLICY_IMMUTABLE' using errcode = '55000'; end if;
  if p.set_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'fx_policy'; end if;
  if p_validate then
    update public.fx_policies set status = 'valide', validated_by = auth.uid(), validated_at = now() where company_id = v_co;
  else
    delete from public.fx_policies where company_id = v_co;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'fx.policy_validate' else 'fx.policy_reject' end, 'fx_policy', v_co::text, null,
    jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Réévaluations et reprises (append-only)
-- ---------------------------------------------------------------------------
create table public.fx_revaluation_runs (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  as_of              date not null,
  reval_method       text not null check (reval_method in ('reversal_next_period', 'no_reversal')),
  rounding           text not null check (rounding in ('per_document_base_minor')),
  gain_total         numeric(15,2) not null check (gain_total >= 0),
  loss_total         numeric(15,2) not null check (loss_total >= 0),
  net_total          numeric(15,2) not null,
  entry_id           uuid references public.gl_entries(id),
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  reversal_entry_id  uuid references public.gl_entries(id),
  reversal_date      date,
  reversed_by        uuid,
  reversed_at        timestamptz,
  unique (company_id, as_of),
  check (net_total = gain_total - loss_total),
  check ((reversal_entry_id is null) = (reversed_at is null) and (reversal_entry_id is null) = (reversal_date is null)),
  check (reversal_entry_id is null or reval_method = 'reversal_next_period'),
  check (reversal_date is null or reversal_date > as_of)
);
alter table public.fx_revaluation_runs enable row level security;
create policy fx_revaluation_runs_select on public.fx_revaluation_runs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.fx_revaluation_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  run_id        uuid not null references public.fx_revaluation_runs(id),
  kind          text not null check (kind in ('receivable', 'payable')),
  document_id   uuid not null,
  number        text not null,
  currency      char(3) not null,
  open_amount   numeric(15,2) not null check (open_amount > 0),
  rate_booked   numeric(18,8) not null,
  rate_today    numeric(18,8) not null,
  base_booked   numeric(15,2) not null,
  base_today    numeric(15,2) not null,
  unrealized    numeric(15,2) not null check (unrealized <> 0),
  unique (run_id, kind, document_id),
  check (unrealized = case when kind = 'receivable' then base_today - base_booked else base_booked - base_today end)
);
alter table public.fx_revaluation_lines enable row level security;
create policy fx_revaluation_lines_select on public.fx_revaluation_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

-- Seule la reprise (une fois) modifie une réévaluation ; ses détails ne changent jamais ; rien n'est supprimé
create function private.fx_revaluation_runs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'FX_IMMUTABLE' using errcode = '55000'; end if;
  if old.reversed_at is null and new.reversed_at is not null
     and (new.id, new.company_id, new.as_of, new.reval_method, new.rounding, new.gain_total, new.loss_total, new.net_total, new.entry_id, new.created_by, new.created_at)
         is not distinct from (old.id, old.company_id, old.as_of, old.reval_method, old.rounding, old.gain_total, old.loss_total, old.net_total, old.entry_id, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'FX_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.fx_revaluation_runs_guard() from public, anon, authenticated;
create trigger fx_revaluation_runs_guard_bud before update or delete on public.fx_revaluation_runs
  for each row execute function private.fx_revaluation_runs_guard();

create function private.fx_revaluation_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'FX_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.fx_revaluation_lines_guard() from public, anon, authenticated;
create trigger fx_revaluation_lines_guard_bud before update or delete on public.fx_revaluation_lines
  for each row execute function private.fx_revaluation_lines_guard();

-- Réévaluation des postes ouverts à une date : écriture OD unique, équilibrée, par document
create function public.fx_revaluation_run(p_as_of date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pol public.fx_policies%rowtype;
  v_run uuid := gen_random_uuid(); v_lines jsonb := '[]'::jsonb; x record; v_gain numeric := 0; v_loss numeric := 0; v_entry uuid; v_main text; v_label text;
begin
  perform private.require_perm('finance.write');
  if p_as_of is null or p_as_of > current_date then raise exception 'FX_DATE_INVALID' using errcode = '22023'; end if;
  select * into pol from public.fx_policies where company_id = v_co;
  if not found then raise exception 'FX_POLICY_MISSING' using errcode = 'P0002'; end if;
  if pol.status <> 'valide' then raise exception 'FX_POLICY_NOT_VALIDATED' using errcode = '55000'; end if;
  if exists (select 1 from public.fx_revaluation_runs r where r.company_id = v_co and r.as_of = p_as_of) then
    raise exception 'FX_REVAL_ALREADY_RUN' using errcode = '55000';
  end if;
  -- Les positions se mesurent au taux de transaction : une réévaluation précédente doit être reprise avant la suivante (pas de double compte)
  if exists (select 1 from public.fx_revaluation_runs r where r.company_id = v_co and r.reversed_at is null) then
    raise exception 'FX_REVAL_OPEN_RUN' using errcode = '55000';
  end if;
  for x in select distinct p.currency as c from public.fx_open_positions(p_as_of) p loop
    if not private.fx_rate_validated(v_co, x.c, p_as_of) then raise exception 'FX_RATE_NOT_VALIDATED' using errcode = '55000', detail = x.c; end if;
  end loop;

  for x in select * from public.fx_open_positions(p_as_of) p where p.unrealized <> 0 order by p.kind, p.number loop
    v_main := case when x.kind = 'receivable' then '411' else '401' end;
    v_label := 'Réévaluation ' || x.number || ' ' || x.currency || ' au ' || p_as_of::text;
    if x.unrealized > 0 then
      v_lines := v_lines || private.gl_line(v_main, x.unrealized, 0, v_label) || private.gl_line('766', 0, x.unrealized, v_label);
      v_gain := v_gain + x.unrealized;
    else
      v_lines := v_lines || private.gl_line('666', -x.unrealized, 0, v_label) || private.gl_line(v_main, 0, -x.unrealized, v_label);
      v_loss := v_loss - x.unrealized;
    end if;
  end loop;

  if jsonb_array_length(v_lines) > 0 then
    v_entry := private.gl_post(v_co, 'OD', p_as_of, 'Réévaluation des postes ouverts au ' || p_as_of::text, 'fx_revaluation', v_run, v_lines);
  end if;
  insert into public.fx_revaluation_runs (id, company_id, as_of, reval_method, rounding, gain_total, loss_total, net_total, entry_id)
  values (v_run, v_co, p_as_of, pol.reval_method, pol.rounding, v_gain, v_loss, v_gain - v_loss, v_entry);
  insert into public.fx_revaluation_lines (company_id, run_id, kind, document_id, number, currency, open_amount, rate_booked, rate_today,
    base_booked, base_today, unrealized)
  select v_co, v_run, p.kind, p.document_id, p.number, p.currency, p.open_amount, p.rate_booked, p.rate_today, p.base_booked, p.base_today, p.unrealized
    from public.fx_open_positions(p_as_of) p where p.unrealized <> 0;
  perform private.write_audit(v_co, 'fx.revaluation_run', 'fx_revaluation', v_run::text, p_as_of::text, null,
    jsonb_build_object('gain', v_gain, 'loss', v_loss, 'net', v_gain - v_loss, 'method', pol.reval_method), '{}'::jsonb, 'rpc');
  return v_run;
end $$;

-- Reprise : écriture inverse, datée après la réévaluation, une seule fois, seulement si la méthode validée le prévoit
create function public.fx_revaluation_reverse(p_run uuid, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.fx_revaluation_runs%rowtype; v_lines jsonb; v_rev uuid;
begin
  perform private.require_perm('finance.write');
  select * into r from public.fx_revaluation_runs where id = p_run and company_id = v_co for update;
  if not found then raise exception 'FX_REVAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.reversed_at is not null then raise exception 'FX_REVAL_ALREADY_REVERSED' using errcode = '55000'; end if;
  if r.reval_method <> 'reversal_next_period' then raise exception 'FX_REVAL_NO_REVERSAL' using errcode = '55000'; end if;
  if r.entry_id is null then raise exception 'FX_REVAL_NO_ENTRY' using errcode = '55000'; end if;
  if p_date is null or p_date <= r.as_of then raise exception 'FX_REVAL_REVERSAL_DATE' using errcode = '22023'; end if;
  select jsonb_agg(jsonb_build_object('account', a.code, 'debit', l.credit, 'credit', l.debit, 'label', 'Reprise réévaluation au ' || r.as_of::text)
                   order by l.pos)
    into v_lines from public.gl_entry_lines l join public.gl_accounts a on a.id = l.account_id where l.entry_id = r.entry_id;
  v_rev := private.gl_post(v_co, 'OD', p_date, 'Reprise de la réévaluation au ' || r.as_of::text, 'fx_reversal', r.id, v_lines);
  update public.fx_revaluation_runs set reversal_entry_id = v_rev, reversal_date = p_date, reversed_by = auth.uid(), reversed_at = now() where id = r.id;
  perform private.write_audit(v_co, 'fx.revaluation_reverse', 'fx_revaluation', r.id::text, r.as_of::text, jsonb_build_object('reversed', false),
    jsonb_build_object('reversed', true, 'date', p_date), '{}'::jsonb, 'rpc');
  return v_rev;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Privilèges
-- ---------------------------------------------------------------------------
revoke all on public.fx_revaluation_runs, public.fx_revaluation_lines from anon, authenticated;
grant select on public.fx_revaluation_runs, public.fx_revaluation_lines to authenticated;
grant all on public.fx_revaluation_runs, public.fx_revaluation_lines to service_role;

revoke execute on function public.fx_rate_history(text), public.fx_policy_set(text, text), public.fx_policy_validate(boolean),
  public.fx_revaluation_run(date), public.fx_revaluation_reverse(uuid, date) from public, anon;
grant execute on function public.fx_rate_history(text), public.fx_policy_set(text, text), public.fx_policy_validate(boolean),
  public.fx_revaluation_run(date), public.fx_revaluation_reverse(uuid, date) to authenticated, service_role;
