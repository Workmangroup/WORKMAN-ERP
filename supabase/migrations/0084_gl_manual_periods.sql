-- 0084_gl_manual_periods — Plan comptable, journaux, périodes et pièces (P059) : pièces manuelles en brouillon puis validées,
-- contrepassation, réouverture de période par visa finance, ajout de comptes sans suppression.
--
-- Existant conservé (0031) : plan comptable provisoire par société, journaux VT/AC/BQ/CA/OD, périodes mensuelles, écritures
-- automatiques (événements métier, anti-doublon par document), immutabilité (GL_IMMUTABLE), numérotation par journal, clôture
-- (gl_close_period), balance (gl_trial_balance), grand livre (gl_ledger). Aucune de ces fonctions n'est remplacée, et aucune
-- écriture existante n'est modifiée : la migration n'ajoute que des objets et des contrôles.
--
-- Vocabulaire :
--  * Pièce = écriture. Statut « brouillon » (gl_entries.status = draft) puis « validé » (posted). « Clôturé » = validé dont la
--    période est close. Un brouillon peut être déséquilibré ; sa validation exige l'équilibre.
--  * Exercice = année civile (12 périodes mensuelles). Aucun exercice décalé n'est supposé (à confirmer).
-- Règles :
--  * Écriture équilibrée : débit total = crédit total à la validation ; au moins deux lignes ; comptes actifs du plan.
--  * Référence unique par société (numéro de pièce, contrainte existante) ; une contrepassation par pièce (index unique).
--  * Aucune suppression après validation ; un brouillon se supprime seulement s'il n'est pas validé.
--  * Période close protégée : aucune pièce ne peut être créée, validée ou insérée dans une période close, y compris par écriture directe.
--  * Réouverture : demande (finance.write) → visa d'une autre personne (finance.visa) → réouverture (finance.write). Aucune réouverture sans visa.
-- Erreurs : GL_LABEL_REQUIRED, GL_TOO_FEW_LINES, GL_JOURNAL_MISSING, GL_PERIOD_CLOSED, GL_BAD_STATUS, GL_UNBALANCED, GL_EMPTY,
-- GL_ACCOUNT_MISSING, GL_ALREADY_REVERSED, GL_REASON_REQUIRED, GL_PERIOD_NOT_CLOSED, GL_REOPEN_PENDING, GL_REOPEN_NOT_VISAED,
-- GL_VISA_SELF, GL_NOT_FOUND, GL_ACCOUNT_CODE_INVALID, GL_IMMUTABLE, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droit de visa de réouverture
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('finance.visa', 'finance', 'Viser la réouverture d’une période comptable', 'Visa finance requis pour rouvrir une période close (distinct du demandeur)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'finance.visa'
where r.is_system and r.code in ('admin', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Garde-fou : aucune pièce validée dans une période close (même par écriture directe)
-- ---------------------------------------------------------------------------
create function private.gl_entry_period_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'INSERT' or new.status = 'posted' then
    select status into v_status from public.gl_periods where id = new.period_id;
    if v_status is distinct from 'open' then raise exception 'GL_PERIOD_CLOSED' using errcode = '55000'; end if;
  end if;
  return new;
end $$;
revoke execute on function private.gl_entry_period_guard() from public, anon, authenticated;
create trigger gl_entries_period_guard_biu before insert or update on public.gl_entries
  for each row execute function private.gl_entry_period_guard();

-- ---------------------------------------------------------------------------
-- 3. Réouvertures de période : demande, visa, exécution
-- ---------------------------------------------------------------------------
create table public.gl_period_reopenings (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  period_id    uuid not null references public.gl_periods(id) on delete restrict,
  reason       text not null check (length(btrim(reason)) between 10 and 500),
  status       text not null default 'pending' check (status in ('pending', 'visaed', 'executed')),
  requested_by uuid default auth.uid(),
  requested_at timestamptz not null default now(),
  visa_by      uuid,
  visa_at      timestamptz,
  executed_by  uuid,
  executed_at  timestamptz,
  check (visa_by is null or visa_by <> requested_by),
  check ((status = 'pending') = (visa_by is null)),
  check ((status = 'executed') = (executed_at is not null))
);
-- Une seule demande ouverte par période
create unique index gl_period_reopenings_open_uq on public.gl_period_reopenings (period_id) where status <> 'executed';

create function private.gl_reopen_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'GL_IMMUTABLE' using errcode = '55000'; end if;
  if (new.id, new.company_id, new.period_id, new.reason, new.requested_by, new.requested_at)
     is distinct from (old.id, old.company_id, old.period_id, old.reason, old.requested_by, old.requested_at) then
    raise exception 'GL_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.gl_reopen_guard() from public, anon, authenticated;
create trigger gl_period_reopenings_guard_bud before update or delete on public.gl_period_reopenings
  for each row execute function private.gl_reopen_guard();

create function public.gl_period_reopen_request(p_year int, p_month int, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_period public.gl_periods%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('finance.write');
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'GL_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into v_period from public.gl_periods where company_id = v_co and year = p_year and month = p_month;
  if not found or v_period.status <> 'closed' then raise exception 'GL_PERIOD_NOT_CLOSED' using errcode = '55000'; end if;
  insert into public.gl_period_reopenings (id, company_id, period_id, reason) values (v_id, v_co, v_period.id, btrim(p_reason));
  perform private.write_audit(v_co, 'gl.period_reopen_request', 'gl_period', v_period.id::text, to_char(make_date(p_year, p_month, 1), 'YYYY-MM'),
    null, jsonb_build_object('status', 'pending'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

-- Visa : une autre personne que le demandeur, détentrice de finance.visa
create function public.gl_period_reopen_visa(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.gl_period_reopenings%rowtype;
begin
  perform private.require_perm('finance.visa');
  select * into r from public.gl_period_reopenings where id = p_request and company_id = v_co for update;
  if not found then raise exception 'GL_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'GL_BAD_STATUS' using errcode = '55000'; end if;
  if r.requested_by is not distinct from auth.uid() then raise exception 'GL_VISA_SELF' using errcode = '42501'; end if;
  update public.gl_period_reopenings set status = 'visaed', visa_by = auth.uid(), visa_at = now() where id = r.id;
  perform private.write_audit(v_co, 'gl.period_reopen_visa', 'gl_period', r.period_id::text, null, jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'visaed'), '{}'::jsonb, 'rpc');
end $$;

-- Exécution : seulement après visa. La période redevient ouverte ; les pièces restent telles quelles.
create function public.gl_period_reopen_execute(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.gl_period_reopenings%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into r from public.gl_period_reopenings where id = p_request and company_id = v_co for update;
  if not found then raise exception 'GL_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status = 'pending' then raise exception 'GL_REOPEN_NOT_VISAED' using errcode = '55000'; end if;
  if r.status <> 'visaed' then raise exception 'GL_BAD_STATUS' using errcode = '55000'; end if;
  update public.gl_periods set status = 'open' where id = r.period_id and status = 'closed';
  update public.gl_period_reopenings set status = 'executed', executed_by = auth.uid(), executed_at = now() where id = r.id;
  perform private.write_audit(v_co, 'gl.period_reopen_execute', 'gl_period', r.period_id::text, null, jsonb_build_object('status', 'closed'),
    jsonb_build_object('status', 'open'), jsonb_build_object('visa_by', r.visa_by), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Plan comptable : ajout et désactivation (jamais de suppression)
-- ---------------------------------------------------------------------------
create function public.gl_account_add(p_code text, p_label text, p_class int, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('finance.write');
  if p_code is null or p_code !~ '^[0-9]{3,8}$' then raise exception 'GL_ACCOUNT_CODE_INVALID' using errcode = '22023'; end if;
  insert into public.gl_accounts (company_id, code, label, account_class, kind) values (v_co, p_code, btrim(p_label), p_class, p_kind);
  perform private.write_audit(v_co, 'gl.account_add', 'gl_account', p_code, p_code, null,
    jsonb_build_object('label', btrim(p_label), 'kind', p_kind), '{}'::jsonb, 'rpc');
end $$;

create function public.gl_account_deactivate(p_code text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.gl_accounts%rowtype;
begin
  perform private.require_perm('finance.write');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'GL_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into a from public.gl_accounts where company_id = v_co and code = p_code for update;
  if not found then raise exception 'GL_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.gl_accounts set active = false where id = a.id;
  perform private.write_audit(v_co, 'gl.account_deactivate', 'gl_account', p_code, p_code, jsonb_build_object('active', true),
    jsonb_build_object('active', false), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Pièces manuelles : brouillon, validation, suppression de brouillon, contrepassation
-- ---------------------------------------------------------------------------
create function public.gl_manual_entry_create(p_journal text, p_date date, p_label text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_journal uuid; v_period uuid; v_status text; v_id uuid := gen_random_uuid();
  v_seq bigint; v_number text; l jsonb; v_pos int := 0; v_account uuid; v_label text := btrim(coalesce(p_label, ''));
begin
  perform private.require_perm('finance.write');
  if length(v_label) < 3 then raise exception 'GL_LABEL_REQUIRED' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then raise exception 'GL_TOO_FEW_LINES' using errcode = '22023'; end if;
  select id into v_journal from public.gl_journals where company_id = v_co and code = p_journal;
  if v_journal is null then raise exception 'GL_JOURNAL_MISSING' using errcode = 'P0002'; end if;
  v_period := private.gl_period(v_co, p_date);
  select status into v_status from public.gl_periods where id = v_period;
  if v_status <> 'open' then raise exception 'GL_PERIOD_CLOSED' using errcode = '55000'; end if;
  v_seq := private.next_seq(v_co, 'gl_' || p_journal);
  v_number := p_journal || '-' || extract(year from p_date)::text || '-' || lpad(v_seq::text, 6, '0');
  insert into public.gl_entries (id, company_id, journal_id, period_id, number, entry_date, label, status, source_type, source_id)
  values (v_id, v_co, v_journal, v_period, v_number, p_date, v_label, 'draft', 'manual', null);
  for l in select * from jsonb_array_elements(p_lines) loop
    v_pos := v_pos + 1;
    select id into v_account from public.gl_accounts where company_id = v_co and code = l->>'account' and active;
    if v_account is null then raise exception 'GL_ACCOUNT_MISSING' using errcode = 'P0002', detail = coalesce(l->>'account', ''); end if;
    insert into public.gl_entry_lines (company_id, entry_id, pos, account_id, debit, credit, label)
    values (v_co, v_id, v_pos, v_account, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0), l->>'label');
  end loop;
  perform private.write_audit(v_co, 'gl.entry_create', 'gl_entry', v_id::text, v_number, null,
    jsonb_build_object('lines', v_pos, 'period', to_char(p_date, 'YYYY-MM')), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Validation : équilibre, au moins deux lignes, période ouverte. Après validation, la pièce est immuable.
create function public.gl_entry_validate(p_entry uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e public.gl_entries%rowtype; v_status text; v_lines int; v_debit numeric; v_credit numeric;
begin
  perform private.require_perm('finance.write');
  select * into e from public.gl_entries where id = p_entry and company_id = v_co for update;
  if not found then raise exception 'GL_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'draft' then raise exception 'GL_BAD_STATUS' using errcode = '55000'; end if;
  select status into v_status from public.gl_periods where id = e.period_id;
  if v_status <> 'open' then raise exception 'GL_PERIOD_CLOSED' using errcode = '55000'; end if;
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_lines, v_debit, v_credit
    from public.gl_entry_lines where entry_id = e.id;
  if v_lines < 2 then raise exception 'GL_TOO_FEW_LINES' using errcode = '22023'; end if;
  if v_debit = 0 then raise exception 'GL_EMPTY' using errcode = '22023'; end if;
  if v_debit <> v_credit then raise exception 'GL_UNBALANCED' using errcode = '22023', detail = v_debit || ' / ' || v_credit; end if;
  update public.gl_entries set status = 'posted' where id = e.id;
  perform private.write_audit(v_co, 'gl.entry_validate', 'gl_entry', e.id::text, e.number, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'posted', 'debit', v_debit, 'credit', v_credit), '{}'::jsonb, 'rpc');
end $$;

-- Suppression : brouillon seulement (la garde de 0031 refuse toute pièce validée)
create function public.gl_entry_discard(p_entry uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e public.gl_entries%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into e from public.gl_entries where id = p_entry and company_id = v_co for update;
  if not found then raise exception 'GL_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'draft' then raise exception 'GL_IMMUTABLE' using errcode = '55000'; end if;
  delete from public.gl_entry_lines where entry_id = e.id;
  delete from public.gl_entries where id = e.id;
  perform private.write_audit(v_co, 'gl.entry_discard', 'gl_entry', e.id::text, e.number, jsonb_build_object('status', 'draft'), null, '{}'::jsonb, 'rpc');
end $$;

-- Contrepassation : une seule par pièce, dans une période ouverte, par le journal OD ; la pièce d'origine reste intacte.
create function public.gl_entry_reverse(p_entry uuid, p_date date, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e public.gl_entries%rowtype; v_lines jsonb; v_id uuid;
begin
  perform private.require_perm('finance.write');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'GL_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into e from public.gl_entries where id = p_entry and company_id = v_co;
  if not found then raise exception 'GL_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.status <> 'posted' then raise exception 'GL_BAD_STATUS' using errcode = '55000'; end if;
  if e.source_type = 'reversal' then raise exception 'GL_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.gl_entries where company_id = v_co and source_type = 'reversal' and source_id = e.id) then
    raise exception 'GL_ALREADY_REVERSED' using errcode = '55000';
  end if;
  select jsonb_agg(jsonb_build_object('account', a.code, 'debit', l.credit, 'credit', l.debit, 'label', 'Contrepassation ' || e.number) order by l.pos)
    into v_lines from public.gl_entry_lines l join public.gl_accounts a on a.id = l.account_id where l.entry_id = e.id;
  v_id := private.gl_post(v_co, 'OD', p_date, 'Contrepassation ' || e.number || ' : ' || btrim(p_reason), 'reversal', e.id, v_lines);
  perform private.write_audit(v_co, 'gl.entry_reverse', 'gl_entry', e.id::text, e.number, null,
    jsonb_build_object('reversal', v_id), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Lecture : statut de la pièce (brouillon, validé, clôturé) et équilibre de la période
-- ---------------------------------------------------------------------------
create function public.gl_period_summary(p_year int, p_month int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_period public.gl_periods%rowtype; v_draft int; v_posted int; v_debit numeric; v_credit numeric;
begin
  perform private.require_perm('finance.read');
  select * into v_period from public.gl_periods where company_id = v_co and year = p_year and month = p_month;
  if not found then return jsonb_build_object('status', 'not_started', 'entries', 0); end if;
  select count(*) filter (where e.status = 'draft'), count(*) filter (where e.status = 'posted')
    into v_draft, v_posted from public.gl_entries e where e.period_id = v_period.id;
  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_debit, v_credit
    from public.gl_entry_lines l join public.gl_entries e on e.id = l.entry_id where e.period_id = v_period.id and e.status = 'posted';
  return jsonb_build_object('status', v_period.status, 'draft_entries', v_draft, 'posted_entries', v_posted,
    'debit', v_debit, 'credit', v_credit, 'balanced', v_debit = v_credit);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privilèges
-- ---------------------------------------------------------------------------
alter table public.gl_period_reopenings enable row level security;
create policy gl_period_reopenings_select on public.gl_period_reopenings for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.gl_period_reopenings from anon, authenticated;
grant select on public.gl_period_reopenings to authenticated;
grant all on public.gl_period_reopenings to service_role;

revoke execute on function public.gl_period_reopen_request(int, int, text), public.gl_period_reopen_visa(uuid), public.gl_period_reopen_execute(uuid),
  public.gl_account_add(text, text, int, text), public.gl_account_deactivate(text, text), public.gl_manual_entry_create(text, date, text, jsonb),
  public.gl_entry_validate(uuid), public.gl_entry_discard(uuid), public.gl_entry_reverse(uuid, date, text), public.gl_period_summary(int, int)
  from public, anon;
grant execute on function public.gl_period_reopen_request(int, int, text), public.gl_period_reopen_visa(uuid), public.gl_period_reopen_execute(uuid),
  public.gl_account_add(text, text, int, text), public.gl_account_deactivate(text, text), public.gl_manual_entry_create(text, date, text, jsonb),
  public.gl_entry_validate(uuid), public.gl_entry_discard(uuid), public.gl_entry_reverse(uuid, date, text), public.gl_period_summary(int, int)
  to authenticated, service_role;
