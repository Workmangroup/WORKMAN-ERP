-- =====================================================================
-- 0031_general_ledger — Comptabilité générale (exigence FIN-01, socle v1)
--  - Plan comptable PROVISOIRE (statut « a_valider ») : à faire valider par l'expert-comptable tunisien.
--  - Journaux (VT ventes, AC achats, BQ banque, CA caisse, OD opérations diverses), périodes mensuelles.
--  - Écritures générées automatiquement par les événements métier, en devise de base :
--      facture client émise (VT), facture fournisseur (AC), encaissement client (BQ),
--      règlement fournisseur affecté (BQ), avoir émis (VT, contrepassation).
--  - Une écriture validée est équilibrée (débit = crédit), liée à sa source, et immuable.
--    Une correction se fait par contrepassation. Une période clôturée refuse toute écriture.
--  Limites v1 : pas d'écritures manuelles (OD) ; pas de rapprochement bancaire ; TVA déductible
--  non comptabilisée (les factures fournisseur ne portent pas de taxe) ; amortissements et
--  stocks non comptabilisés ; le compte 607 reçoit le montant HT des factures fournisseur.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Référentiels par société
-- ---------------------------------------------------------------------
create table public.gl_accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  code          text not null check (code ~ '^[0-9]{3,8}$'),
  label         text not null check (length(btrim(label)) between 2 and 120),
  account_class int not null check (account_class between 1 and 8),
  kind          text not null check (kind in ('asset', 'liability', 'equity', 'income', 'expense')),
  status        text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  active        boolean not null default true,
  unique (company_id, code)
);

create table public.gl_journals (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code       text not null check (code in ('VT', 'AC', 'BQ', 'CA', 'OD')),
  label      text not null,
  unique (company_id, code)
);

create table public.gl_periods (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  year       int not null check (year between 2000 and 2100),
  month      int not null check (month between 1 and 12),
  status     text not null default 'open' check (status in ('open', 'closed')),
  closed_at  timestamptz,
  closed_by  uuid,
  unique (company_id, year, month)
);

-- ---------------------------------------------------------------------
-- 2. Écritures : en-tête et lignes (immuables une fois validées)
-- ---------------------------------------------------------------------
create table public.gl_entries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  journal_id  uuid not null references public.gl_journals(id),
  period_id   uuid not null references public.gl_periods(id),
  number      text not null,
  entry_date  date not null,
  label       text not null check (length(btrim(label)) between 1 and 200),
  status      text not null default 'draft' check (status in ('draft', 'posted')),
  source_type text,
  source_id   uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, number)
);
-- Un document ne produit qu'une écriture de chaque type (anti-doublon).
create unique index gl_entries_source_uq on public.gl_entries (company_id, source_type, source_id) where source_id is not null;

create table public.gl_entry_lines (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  entry_id   uuid not null references public.gl_entries(id) on delete restrict,
  pos        int not null,
  account_id uuid not null references public.gl_accounts(id),
  debit      numeric(15,2) not null default 0 check (debit >= 0),
  credit     numeric(15,2) not null default 0 check (credit >= 0),
  label      text,
  check ((debit > 0) <> (credit > 0))
);
create index gl_entry_lines_account_idx on public.gl_entry_lines (company_id, account_id);

-- Immutabilité : une écriture validée et ses lignes ne se modifient ni ne se suppriment.
-- En-tête : seule la validation d'un brouillon est permise, et la suppression d'un brouillon.
create function private.gl_entries_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'posted'
     and new.number = old.number and new.entry_date = old.entry_date and new.label = old.label then
    return new;
  end if;
  if tg_op = 'DELETE' and old.status = 'draft' then
    return old;
  end if;
  raise exception 'GL_IMMUTABLE' using errcode = '55000';
end $$;
create trigger gl_entries_immutable before update or delete on public.gl_entries for each row execute function private.gl_entries_guard();

-- Lignes : jamais modifiées ; supprimées seulement tant que l'écriture est en brouillon.
create function private.gl_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and exists (select 1 from public.gl_entries e where e.id = old.entry_id and e.status = 'draft') then
    return old;
  end if;
  raise exception 'GL_IMMUTABLE' using errcode = '55000';
end $$;
create trigger gl_entry_lines_immutable before update or delete on public.gl_entry_lines for each row execute function private.gl_lines_guard();

-- Une ligne ne s'ajoute qu'à une écriture encore en brouillon.
create function private.gl_line_insert_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.gl_entries e where e.id = new.entry_id and e.status = 'draft') then
    raise exception 'GL_ENTRY_NOT_DRAFT' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger gl_entry_lines_draft_i before insert on public.gl_entry_lines for each row execute function private.gl_line_insert_check();

alter table public.gl_accounts enable row level security;
alter table public.gl_journals enable row level security;
alter table public.gl_periods enable row level security;
alter table public.gl_entries enable row level security;
alter table public.gl_entry_lines enable row level security;
create policy gl_accounts_select on public.gl_accounts for select to authenticated using (company_id = private.current_company() and private.has_perm('finance.read'));
create policy gl_journals_select on public.gl_journals for select to authenticated using (company_id = private.current_company() and private.has_perm('finance.read'));
create policy gl_periods_select on public.gl_periods for select to authenticated using (company_id = private.current_company() and private.has_perm('finance.read'));
create policy gl_entries_select on public.gl_entries for select to authenticated using (company_id = private.current_company() and private.has_perm('finance.read'));
create policy gl_entry_lines_select on public.gl_entry_lines for select to authenticated using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.gl_accounts, public.gl_journals, public.gl_periods, public.gl_entries, public.gl_entry_lines from anon, authenticated;
grant select on public.gl_accounts, public.gl_journals, public.gl_periods, public.gl_entries, public.gl_entry_lines to authenticated;

-- ---------------------------------------------------------------------
-- 3. Plan comptable et journaux provisoires d'une société (idempotent)
-- ---------------------------------------------------------------------
create function private.gl_setup_company(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.gl_accounts (company_id, code, label, account_class, kind) values
    (p_company, '411', 'Clients', 4, 'asset'),
    (p_company, '401', 'Fournisseurs', 4, 'liability'),
    (p_company, '445', 'État, TVA collectée', 4, 'liability'),
    (p_company, '521', 'Banque', 5, 'asset'),
    (p_company, '531', 'Caisse', 5, 'asset'),
    (p_company, '607', 'Achats de marchandises et matières', 6, 'expense'),
    (p_company, '666', 'Pertes de change', 6, 'expense'),
    (p_company, '701', 'Ventes de produits finis', 7, 'income'),
    (p_company, '766', 'Gains de change', 7, 'income')
  on conflict (company_id, code) do nothing;
  insert into public.gl_journals (company_id, code, label) values
    (p_company, 'VT', 'Ventes'), (p_company, 'AC', 'Achats'), (p_company, 'BQ', 'Banque'),
    (p_company, 'CA', 'Caisse'), (p_company, 'OD', 'Opérations diverses')
  on conflict (company_id, code) do nothing;
end $$;

-- Sociétés existantes et futures.
select private.gl_setup_company(id) from public.companies;
create function private.companies_gl_setup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.gl_setup_company(new.id);
  return new;
end $$;
create trigger companies_gl_setup_i after insert on public.companies for each row execute function private.companies_gl_setup();

-- ---------------------------------------------------------------------
-- 4. Taux de change explicite par société (les déclencheurs n'ont pas de session utilisateur)
-- ---------------------------------------------------------------------
create function private.gl_fx(p_company uuid, p_currency char(3), p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_base char(3); v_rate numeric;
begin
  v_base := coalesce((select s.base_currency from public.finance_settings s where s.company_id = p_company), 'EUR')::char(3);
  if p_currency = v_base then return 1; end if;
  select r.rate into v_rate from public.exchange_rates r
   where r.company_id = p_company and r.currency = p_currency and r.rate_date <= p_date
   order by r.rate_date desc limit 1;
  if v_rate is null then raise exception 'FX_RATE_MISSING' using errcode = 'P0002', detail = p_currency || ' ' || p_date::text; end if;
  return v_rate;
end $$;

-- ---------------------------------------------------------------------
-- 5. Périodes et numérotation
-- ---------------------------------------------------------------------
create function private.gl_period(p_company uuid, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.gl_periods (company_id, year, month) values (p_company, extract(year from p_date)::int, extract(month from p_date)::int)
  on conflict (company_id, year, month) do nothing;
  select id into v_id from public.gl_periods where company_id = p_company and year = extract(year from p_date)::int and month = extract(month from p_date)::int;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 6. Validation d'une écriture : équilibre, comptes, période ouverte, anti-doublon
-- ---------------------------------------------------------------------
create function private.gl_post(p_company uuid, p_journal text, p_date date, p_label text,
  p_source_type text, p_source_id uuid, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_journal uuid; v_period uuid; v_status text; v_entry uuid; v_number text; v_seq bigint;
  v_debit numeric := 0; v_credit numeric := 0; v_count int := 0; l jsonb; v_account uuid; v_pos int := 0;
begin
  select id into v_journal from public.gl_journals where company_id = p_company and code = p_journal;
  if v_journal is null then raise exception 'GL_JOURNAL_MISSING' using errcode = 'P0002'; end if;

  -- Anti-doublon : un document déjà comptabilisé ne l'est pas deux fois.
  if p_source_id is not null then
    select id into v_entry from public.gl_entries where company_id = p_company and source_type = p_source_type and source_id = p_source_id;
    if v_entry is not null then return v_entry; end if;
  end if;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_count := v_count + 1;
    v_debit := v_debit + coalesce((l->>'debit')::numeric, 0);
    v_credit := v_credit + coalesce((l->>'credit')::numeric, 0);
    if not exists (select 1 from public.gl_accounts a where a.company_id = p_company and a.code = l->>'account' and a.active) then
      raise exception 'GL_ACCOUNT_MISSING' using errcode = 'P0002', detail = l->>'account';
    end if;
  end loop;
  if v_count < 2 then raise exception 'GL_TOO_FEW_LINES' using errcode = '22023'; end if;
  if v_debit <> v_credit then raise exception 'GL_UNBALANCED' using errcode = '22023', detail = v_debit || ' / ' || v_credit; end if;
  if v_debit = 0 then raise exception 'GL_EMPTY' using errcode = '22023'; end if;

  v_period := private.gl_period(p_company, p_date);
  select status into v_status from public.gl_periods where id = v_period;
  if v_status <> 'open' then raise exception 'GL_PERIOD_CLOSED' using errcode = '55000', detail = to_char(p_date, 'YYYY-MM'); end if;

  v_seq := private.next_seq(p_company, 'gl_' || p_journal);
  v_number := p_journal || '-' || extract(year from p_date)::text || '-' || lpad(v_seq::text, 6, '0');
  insert into public.gl_entries (company_id, journal_id, period_id, number, entry_date, label, status, source_type, source_id)
  values (p_company, v_journal, v_period, v_number, p_date, btrim(p_label), 'draft', p_source_type, p_source_id)
  returning id into v_entry;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_pos := v_pos + 1;
    select id into v_account from public.gl_accounts where company_id = p_company and code = l->>'account';
    insert into public.gl_entry_lines (company_id, entry_id, pos, account_id, debit, credit, label)
    values (p_company, v_entry, v_pos, v_account, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0), l->>'label');
  end loop;

  update public.gl_entries set status = 'posted' where id = v_entry;
  return v_entry;
end $$;

-- Ligne utilitaire : n'ajoute la ligne que si son montant est non nul.
-- Renvoie un tableau d'une ligne : la concaténation de tableaux ajoute les lignes (un objet, lui, se fusionnerait).
create function private.gl_line(p_account text, p_debit numeric, p_credit numeric, p_label text) returns jsonb
language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('account', p_account, 'debit', p_debit, 'credit', p_credit, 'label', p_label))
$$;

-- ---------------------------------------------------------------------
-- 7. Règles de comptabilisation : une fonction « book » par type de document.
--    Les déclencheurs et la reprise de l'existant (fin de ce fichier) utilisent les mêmes fonctions.
-- ---------------------------------------------------------------------
-- Facture client : 411 TTC / 701 HT / 445 TVA (en devise de base, au taux figé).
create function private.gl_book_invoice(r public.invoices) returns void
language plpgsql security definer set search_path = '' as $$
declare v_fx numeric; v_total numeric; v_ht numeric; v_tva numeric; v_minor int; v_lines jsonb := '[]'::jsonb;
begin
  if r.status not in ('issued', 'partially_paid', 'paid', 'credited') then return; end if;
  perform private.gl_setup_company(r.company_id);
  v_fx := coalesce(r.fx_rate, private.gl_fx(r.company_id, r.currency, coalesce(r.issue_date, current_date)));
  select minor_units into v_minor from public.currencies where code = coalesce((select s.base_currency from public.finance_settings s where s.company_id = r.company_id), 'EUR');
  v_minor := coalesce(v_minor, 2);
  v_total := round(r.total * v_fx, v_minor);
  v_ht := round(r.subtotal * v_fx, v_minor);
  v_tva := v_total - v_ht;
  v_lines := v_lines || private.gl_line('411', v_total, 0, 'Client ' || r.code) || private.gl_line('701', 0, v_ht, 'Vente ' || r.code);
  if v_tva > 0 then v_lines := v_lines || private.gl_line('445', 0, v_tva, 'TVA ' || r.code); end if;
  perform private.gl_post(r.company_id, 'VT', coalesce(r.issue_date, current_date), 'Facture ' || r.code, 'invoice', r.id, v_lines);
end $$;

create function private.gl_invoice_issued() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'draft' then perform private.gl_book_invoice(new); end if;
  return new;
end $$;
create trigger invoices_gl_issue_u after update on public.invoices for each row execute function private.gl_invoice_issued();

-- Facture fournisseur : 607 HT (= total, faute de taxe saisie) / 401.
create function private.gl_book_supplier_invoice(r public.supplier_invoices) returns void
language plpgsql security definer set search_path = '' as $$
declare v_minor int; v_base numeric;
begin
  perform private.gl_setup_company(r.company_id);
  select minor_units into v_minor from public.currencies where code = coalesce((select s.base_currency from public.finance_settings s where s.company_id = r.company_id), 'EUR');
  v_base := coalesce(r.base_total, round(r.total * private.gl_fx(r.company_id, r.currency, r.invoice_date), coalesce(v_minor, 2)));
  perform private.gl_post(r.company_id, 'AC', r.invoice_date, 'Facture fournisseur ' || r.number, 'supplier_invoice', r.id,
    private.gl_line('607', v_base, 0, 'Achat ' || r.supplier_ref) || private.gl_line('401', 0, v_base, 'Fournisseur ' || r.number));
end $$;

create function private.gl_supplier_invoice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.gl_book_supplier_invoice(new);
  return new;
end $$;
create trigger supplier_invoices_gl_i after insert on public.supplier_invoices for each row execute function private.gl_supplier_invoice();

-- Encaissement client : 521 au taux du jour du règlement, 411 au taux figé, écart en 766 / 666.
create function private.gl_book_customer_payment(r public.invoice_payments) returns void
language plpgsql security definer set search_path = '' as $$
declare v_inv public.invoices%rowtype; v_minor int; v_booked numeric; v_settled numeric; v_diff numeric; v_lines jsonb;
begin
  select * into v_inv from public.invoices where id = r.invoice_id;
  if v_inv.currency is null or v_inv.fx_rate is null then return; end if;
  perform private.gl_setup_company(r.company_id);
  select minor_units into v_minor from public.currencies where code = coalesce((select s.base_currency from public.finance_settings s where s.company_id = r.company_id), 'EUR');
  v_minor := coalesce(v_minor, 2);
  v_booked := round(r.amount * v_inv.fx_rate, v_minor);
  v_settled := round(r.amount * private.gl_fx(r.company_id, v_inv.currency, r.paid_on), v_minor);
  v_diff := v_settled - v_booked;
  v_lines := private.gl_line('521', v_settled, 0, 'Encaissement ' || v_inv.code) || private.gl_line('411', 0, v_booked, 'Règlement ' || v_inv.code);
  if v_diff > 0 then v_lines := v_lines || private.gl_line('766', 0, v_diff, 'Gain de change ' || v_inv.code);
  elsif v_diff < 0 then v_lines := v_lines || private.gl_line('666', -v_diff, 0, 'Perte de change ' || v_inv.code); end if;
  perform private.gl_post(r.company_id, 'BQ', r.paid_on, 'Encaissement ' || v_inv.code, 'invoice_payment', r.id, v_lines);
end $$;

create function private.gl_customer_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.gl_book_customer_payment(new);
  return new;
end $$;
create trigger invoice_payments_gl_i after insert on public.invoice_payments for each row execute function private.gl_customer_payment();

-- Règlement fournisseur affecté : 401 au taux figé, 521 au taux du jour du paiement, écart en 766 / 666.
create function private.gl_book_supplier_allocation(r public.supplier_payment_allocations) returns void
language plpgsql security definer set search_path = '' as $$
declare v_inv public.supplier_invoices%rowtype; v_paid date; v_minor int; v_booked numeric; v_settled numeric; v_diff numeric; v_lines jsonb;
begin
  select * into v_inv from public.supplier_invoices where id = r.supplier_invoice_id;
  select paid_on into v_paid from public.supplier_payments where id = r.payment_id;
  perform private.gl_setup_company(r.company_id);
  select minor_units into v_minor from public.currencies where code = coalesce((select s.base_currency from public.finance_settings s where s.company_id = r.company_id), 'EUR');
  v_minor := coalesce(v_minor, 2);
  v_booked := round(r.amount * coalesce(v_inv.fx_rate, 1), v_minor);
  v_settled := round(r.amount * private.gl_fx(r.company_id, v_inv.currency, v_paid), v_minor);
  v_diff := v_booked - v_settled;
  v_lines := private.gl_line('401', v_booked, 0, 'Règlement ' || v_inv.number) || private.gl_line('521', 0, v_settled, 'Paiement ' || v_inv.number);
  if v_diff > 0 then v_lines := v_lines || private.gl_line('766', 0, v_diff, 'Gain de change ' || v_inv.number);
  elsif v_diff < 0 then v_lines := v_lines || private.gl_line('666', -v_diff, 0, 'Perte de change ' || v_inv.number); end if;
  perform private.gl_post(r.company_id, 'BQ', v_paid, 'Règlement ' || v_inv.number, 'supplier_allocation', r.id, v_lines);
end $$;

create function private.gl_supplier_allocation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.gl_book_supplier_allocation(new);
  return new;
end $$;
create trigger supplier_allocations_gl_i after insert on public.supplier_payment_allocations for each row execute function private.gl_supplier_allocation();

-- Avoir émis : contrepassation de la vente (701 et 445 au débit, 411 au crédit), au taux figé de la facture.
create function private.gl_book_credit_note(r public.credit_notes) returns void
language plpgsql security definer set search_path = '' as $$
declare v_inv public.invoices%rowtype; v_minor int; v_total numeric; v_ht numeric; v_tva numeric; v_lines jsonb := '[]'::jsonb;
begin
  if r.status <> 'issued' then return; end if;
  select * into v_inv from public.invoices where id = r.invoice_id;
  perform private.gl_setup_company(r.company_id);
  select minor_units into v_minor from public.currencies where code = coalesce((select s.base_currency from public.finance_settings s where s.company_id = r.company_id), 'EUR');
  v_minor := coalesce(v_minor, 2);
  v_total := round(r.total * coalesce(v_inv.fx_rate, 1), v_minor);
  v_ht := round(r.subtotal * coalesce(v_inv.fx_rate, 1), v_minor);
  v_tva := v_total - v_ht;
  v_lines := private.gl_line('701', v_ht, 0, 'Avoir ' || r.code) || private.gl_line('411', 0, v_total, 'Avoir ' || r.code);
  if v_tva > 0 then v_lines := v_lines || private.gl_line('445', v_tva, 0, 'TVA avoir ' || r.code); end if;
  perform private.gl_post(r.company_id, 'VT', coalesce(r.issue_date, current_date), 'Avoir ' || r.code, 'credit_note', r.id, v_lines);
end $$;

create function private.gl_credit_note_issued() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'draft' then perform private.gl_book_credit_note(new); end if;
  return new;
end $$;
create trigger credit_notes_gl_u after update on public.credit_notes for each row execute function private.gl_credit_note_issued();

-- Reprise de l'existant : chaque document déjà émis reçoit son écriture (anti-doublon : relancer est sans effet).
do $$
declare ri public.invoices%rowtype; si public.supplier_invoices%rowtype; pi public.invoice_payments%rowtype; ai public.supplier_payment_allocations%rowtype; ci public.credit_notes%rowtype;
begin
  for ri in select * from public.invoices where status in ('issued', 'partially_paid', 'paid', 'credited') order by issue_date, code loop
    perform private.gl_book_invoice(ri);
  end loop;
  for si in select * from public.supplier_invoices order by invoice_date, number loop
    perform private.gl_book_supplier_invoice(si);
  end loop;
  for pi in select * from public.invoice_payments order by paid_on loop
    perform private.gl_book_customer_payment(pi);
  end loop;
  for ai in select * from public.supplier_payment_allocations loop
    perform private.gl_book_supplier_allocation(ai);
  end loop;
  for ci in select * from public.credit_notes where status = 'issued' order by issue_date, code loop
    perform private.gl_book_credit_note(ci);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 8. Clôture de période
-- ---------------------------------------------------------------------
create function public.gl_close_period(p_year int, p_month int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_period uuid;
begin
  perform private.require_perm('finance.write');
  select id into v_period from public.gl_periods where company_id = v_co and year = p_year and month = p_month;
  if v_period is null then
    insert into public.gl_periods (company_id, year, month) values (v_co, p_year, p_month) returning id into v_period;
  end if;
  if exists (select 1 from public.gl_entries e where e.period_id = v_period and e.status = 'draft') then
    raise exception 'GL_DRAFT_ENTRIES' using errcode = '55000';
  end if;
  update public.gl_periods set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = v_period and status = 'open';
end $$;

-- ---------------------------------------------------------------------
-- 9. États : grand livre et balance
-- ---------------------------------------------------------------------
create function public.gl_trial_balance(p_from date, p_to date) returns table (
  account_code text, account_label text, total_debit numeric, total_credit numeric, balance numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  select a.code, a.label, coalesce(sum(x.debit), 0), coalesce(sum(x.credit), 0), coalesce(sum(x.debit), 0) - coalesce(sum(x.credit), 0)
    from public.gl_accounts a
    left join (
      select l.account_id, l.debit, l.credit
        from public.gl_entry_lines l
        join public.gl_entries e on e.id = l.entry_id
       where e.status = 'posted' and e.entry_date between p_from and p_to
    ) x on x.account_id = a.id
   where a.company_id = private.current_company()
   group by a.code, a.label
   having coalesce(sum(x.debit), 0) <> 0 or coalesce(sum(x.credit), 0) <> 0
   order by a.code;
end $$;

create function public.gl_ledger(p_account text, p_from date, p_to date) returns table (
  entry_date date, number text, label text, debit numeric, credit numeric, running_balance numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  select e.entry_date, e.number, coalesce(l.label, e.label), l.debit, l.credit,
         sum(l.debit - l.credit) over (order by e.entry_date, e.number, l.pos)
    from public.gl_entry_lines l
    join public.gl_entries e on e.id = l.entry_id and e.status = 'posted'
    join public.gl_accounts a on a.id = l.account_id
   where a.company_id = private.current_company() and a.code = p_account and e.entry_date between p_from and p_to
   order by e.entry_date, e.number, l.pos;
end $$;

revoke execute on function public.gl_close_period(int, int), public.gl_trial_balance(date, date), public.gl_ledger(text, date, date) from public, anon;
grant execute on function public.gl_close_period(int, int), public.gl_trial_balance(date, date), public.gl_ledger(text, date, date) to authenticated;
