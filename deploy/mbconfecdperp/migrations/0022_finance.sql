-- =====================================================================
-- 0022_finance — Finance : encaissements, factures et règlements fournisseurs, balances âgées clients et fournisseurs,
--                 relances automatiques, trésorerie, prévisions de trésorerie, tableau de bord
--  Tables :
--    supplier_invoices               : factures fournisseurs (numéro interne FF-, numéro du fournisseur, échéance, solde)
--    supplier_payments               : règlements fournisseurs (numéro RG-)
--    supplier_payment_allocations    : affectation d'un règlement à des factures — IMMUABLE
--    cash_accounts                   : comptes de trésorerie avec solde d'ouverture
--    cash_movements                  : mouvements de trésorerie hors clients/fournisseurs (frais, virements internes) — IMMUABLE
--    finance_reminders               : relances clients, une par niveau et par facture
--  Encaissements clients : invoice_record_payment (0012) ; l'encaissement global est affecté aux factures les plus anciennes.
--  Règlements fournisseurs : affectation FIFO aux factures échues en premier ; litige = facture non payable.
--  Balances âgées : tranches à partir de l'échéance (à échoir, 1-30, 31-60, 61-90, plus de 90 jours).
--  Relances : niveau 1 (1-30 jours de retard), 2 (31-60), 3 (plus de 60) ; une seule relance par niveau et par facture.
--    La relance n'est pas envoyée par ce module : elle est marquée « envoyée » une fois transmise.
--  Trésorerie : soldes d'ouverture + encaissements clients − règlements fournisseurs ± mouvements manuels.
--    Les encaissements ne sont pas rattachés à un compte bancaire (trésorerie consolidée).
--  Droits : finance.read (voir), finance.write (saisir, affecter, relancer) ; les encaissements exigent aussi payments.write.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('finance.read',  'finance', 'Voir la finance',   'Balances âgées, trésorerie, prévisions, tableau de bord financier'),
  ('finance.write', 'finance', 'Gérer la finance',  'Factures et règlements fournisseurs, relances, mouvements de trésorerie')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'   and p.code in ('finance.read', 'finance.write'))
  or (r.code = 'finance' and p.code in ('finance.read', 'finance.write'))
  or (r.code = 'direction' and p.code = 'finance.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.supplier_invoices (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  supplier_id   uuid not null references public.suppliers(id),
  supplier_ref  text not null check (length(btrim(supplier_ref)) between 1 and 60),
  purchase_order_id uuid references public.purchase_orders(id),
  invoice_date  date not null,
  due_date      date not null,
  currency      char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  total         numeric(15,2) not null check (total > 0),
  paid_amount   numeric(15,2) not null default 0 check (paid_amount >= 0),
  status        text not null default 'open' check (status in ('open', 'partially_paid', 'paid', 'disputed')),
  dispute_reason text check (dispute_reason is null or length(dispute_reason) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (company_id, number),
  unique (company_id, supplier_id, supplier_ref),
  check (due_date >= invoice_date),
  check (paid_amount <= total),
  check ((status = 'paid') = (paid_amount = total)),
  check (status <> 'partially_paid' or (paid_amount > 0 and paid_amount < total))
);
create index supplier_invoices_open_idx on public.supplier_invoices (company_id, status, due_date);

create table public.supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number      text not null,
  supplier_id uuid not null references public.suppliers(id),
  amount      numeric(15,2) not null check (amount > 0),
  paid_on     date not null,
  method      text not null default 'transfer' check (method in ('transfer', 'cheque', 'lc', 'cash', 'card', 'other')),
  reference   text check (reference is null or length(reference) <= 120),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, number)
);

create table public.supplier_payment_allocations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  payment_id          uuid not null references public.supplier_payments(id),
  supplier_invoice_id uuid not null references public.supplier_invoices(id),
  amount              numeric(15,2) not null check (amount > 0),
  created_at          timestamptz not null default now()
);

create table public.cash_accounts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 2 and 80),
  opening_balance  numeric(15,2) not null default 0,
  opening_date     date not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (company_id, name)
);

create table public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  account_id  uuid not null references public.cash_accounts(id),
  direction   text not null check (direction in ('in', 'out')),
  amount      numeric(15,2) not null check (amount > 0),
  moved_on    date not null,
  label       text not null check (length(btrim(label)) between 2 and 160),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

create table public.finance_reminders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id),
  level       int not null check (level in (1, 2, 3)),
  days_late   int not null check (days_late > 0),
  balance     numeric(15,2) not null check (balance > 0),
  status      text not null default 'pending' check (status in ('pending', 'sent')),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  sent_by     uuid,
  unique (company_id, invoice_id, level),
  check ((status = 'sent') = (sent_at is not null))
);

-- ---------------------------------------------------------------------
-- 3. Garde-fous : numérotation, immuabilité, sécurité des lignes
-- ---------------------------------------------------------------------
create or replace function private.doc_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := TG_ARGV[0] || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, TG_ARGV[1])::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.doc_number() from public, anon, authenticated;
create trigger supplier_invoices_number_i before insert on public.supplier_invoices for each row execute function private.doc_number('FF-', 'supplier_invoice');
create trigger supplier_payments_number_i before insert on public.supplier_payments for each row execute function private.doc_number('RGF-', 'supplier_payment');

create function private.finance_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'FINANCE_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.finance_immutable() from public, anon, authenticated;
create trigger supplier_payment_allocations_immutable before update or delete on public.supplier_payment_allocations
  for each row execute function private.finance_immutable();
create trigger cash_movements_immutable before update or delete on public.cash_movements
  for each row execute function private.finance_immutable();

-- Lignes accessibles par droit de lecture (finance.read) et société.
do $$
declare t text;
begin
  foreach t in array array['supplier_invoices', 'supplier_payments', 'supplier_payment_allocations', 'cash_accounts', 'cash_movements', 'finance_reminders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(%L))',
      t || '_select', t, 'finance.read');
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Encaissements clients : journal des encaissements (paiements de factures) avec le client et le numéro de facture.
create view public.finance_receipts with (security_invoker = true) as
select p.id, p.company_id, p.paid_on, p.amount, p.method, p.reference, i.id as invoice_id, i.code as invoice_code, i.client_id,
       c.name as client_name, p.created_at
  from public.invoice_payments p
  join public.invoices i on i.id = p.invoice_id
  join public.clients c on c.id = i.client_id;
grant select on public.finance_receipts to authenticated;

-- ---------------------------------------------------------------------
-- 4. Factures et règlements fournisseurs
-- ---------------------------------------------------------------------
create function public.supplier_invoice_record(p_supplier uuid, p_ref text, p_invoice_date date, p_due_date date, p_total numeric,
  p_currency text default 'EUR', p_purchase_order uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text; v_co uuid := private.current_company();
begin
  perform private.require_perm('finance.write');
  if not exists (select 1 from public.suppliers s where s.id = p_supplier and s.company_id = v_co) then raise exception 'FINANCE_SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.supplier_invoices (id, supplier_id, supplier_ref, purchase_order_id, invoice_date, due_date, currency, total)
  values (v_id, p_supplier, btrim(p_ref), p_purchase_order, p_invoice_date, p_due_date, upper(coalesce(p_currency, 'EUR')), p_total)
  returning number into v_number;
  perform private.write_audit(v_co, 'finance.supplier_invoice', 'supplier_invoice', v_id::text, v_number, null,
    jsonb_build_object('ref', p_ref, 'total', p_total), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Litige : la facture n'est plus payable tant qu'il n'est pas résolu.
create function public.supplier_invoice_dispute(p_invoice uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.supplier_invoices%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('finance.write');
  if length(v_reason) < 5 then raise exception 'FINANCE_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into i from public.supplier_invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('open', 'partially_paid') then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  update public.supplier_invoices set status = 'disputed', dispute_reason = v_reason where id = p_invoice;
  perform private.write_audit(i.company_id, 'finance.supplier_dispute', 'supplier_invoice', i.id::text, i.number, null,
    jsonb_build_object('reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

create function public.supplier_invoice_resolve(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.supplier_invoices%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into i from public.supplier_invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'disputed' then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  update public.supplier_invoices set status = case when paid_amount = 0 then 'open' else 'partially_paid' end,
    dispute_reason = null where id = p_invoice;
  perform private.write_audit(i.company_id, 'finance.supplier_resolve', 'supplier_invoice', i.id::text, i.number, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Règlement fournisseur : affecté aux factures échues les plus anciennes (hors litiges). Pas d'avance.
create function public.supplier_payment_record(p_supplier uuid, p_amount numeric, p_paid_on date, p_method text default 'transfer', p_reference text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pay uuid := gen_random_uuid(); v_number text; v_left numeric := p_amount; v_open numeric; r record; v_take numeric; v_alloc int := 0;
begin
  perform private.require_perm('finance.write');
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(total - paid_amount), 0) into v_open from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid');
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  insert into public.supplier_payments (id, supplier_id, amount, paid_on, method, reference)
  values (v_pay, p_supplier, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'transfer'), nullif(btrim(coalesce(p_reference, '')), ''))
  returning number into v_number;
  for r in select id, total, paid_amount from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid')
    order by due_date, invoice_date, number for update loop
    exit when v_left <= 0;
    v_take := least(v_left, r.total - r.paid_amount);
    insert into public.supplier_payment_allocations (company_id, payment_id, supplier_invoice_id, amount) values (v_co, v_pay, r.id, v_take);
    update public.supplier_invoices set paid_amount = paid_amount + v_take,
      status = case when paid_amount + v_take = total then 'paid' else 'partially_paid' end where id = r.id;
    v_left := v_left - v_take;
    v_alloc := v_alloc + 1;
  end loop;
  perform private.write_audit(v_co, 'finance.supplier_payment', 'supplier_payment', v_pay::text, v_number, null,
    jsonb_build_object('amount', p_amount, 'invoices', v_alloc), '{}'::jsonb, 'rpc');
  return jsonb_build_object('id', v_pay, 'number', v_number, 'allocated_invoices', v_alloc);
end $$;

-- ---------------------------------------------------------------------
-- 5. Encaissements clients : affectation aux factures les plus anciennes (via invoice_record_payment)
-- ---------------------------------------------------------------------
create function public.customer_receipt_record(p_client uuid, p_amount numeric, p_paid_on date, p_method text default 'transfer', p_reference text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_left numeric := p_amount; v_take numeric; v_alloc int := 0; r record; v_open numeric;
begin
  perform private.require_perm('finance.write');
  perform private.require_perm('payments.write');
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(total - credited_amount - paid_amount), 0) into v_open from public.invoices
    where company_id = v_co and client_id = p_client and status in ('issued', 'partially_paid');
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  for r in select id, total, credited_amount, paid_amount from public.invoices
    where company_id = v_co and client_id = p_client and status in ('issued', 'partially_paid')
    order by due_date nulls last, issue_date, code for update loop
    exit when v_left <= 0;
    v_take := least(v_left, r.total - r.credited_amount - r.paid_amount);
    if v_take > 0 then
      perform public.invoice_record_payment(r.id, v_take, p_paid_on, p_method, p_reference);
      v_left := v_left - v_take;
      v_alloc := v_alloc + 1;
    end if;
  end loop;
  return jsonb_build_object('allocated_invoices', v_alloc, 'unallocated', v_left);
end $$;

-- ---------------------------------------------------------------------
-- 6. Trésorerie : comptes et mouvements manuels
-- ---------------------------------------------------------------------
create function public.cash_account_create(p_name text, p_opening numeric, p_opening_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('finance.write');
  insert into public.cash_accounts (id, name, opening_balance, opening_date) values (v_id, btrim(p_name), coalesce(p_opening, 0), p_opening_date);
  perform private.write_audit(private.current_company(), 'finance.cash_account', 'cash_account', v_id::text, btrim(p_name), null,
    jsonb_build_object('opening', p_opening), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.cash_movement_add(p_account uuid, p_direction text, p_amount numeric, p_moved_on date, p_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); a public.cash_accounts%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into a from public.cash_accounts where id = p_account and company_id = private.current_company();
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not a.active then raise exception 'FINANCE_ACCOUNT_INACTIVE' using errcode = '55000'; end if;
  if p_moved_on < a.opening_date then raise exception 'FINANCE_BEFORE_OPENING' using errcode = '22023'; end if;
  insert into public.cash_movements (id, account_id, direction, amount, moved_on, label)
  values (v_id, a.id, p_direction, p_amount, p_moved_on, btrim(p_label));
  perform private.write_audit(a.company_id, 'finance.cash_movement', 'cash_account', a.id::text, a.name, null,
    jsonb_build_object('direction', p_direction, 'amount', p_amount, 'label', p_label), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 7. Relances automatiques
-- ---------------------------------------------------------------------
-- Crée les relances manquantes pour les factures échues. Idempotent : une relance par niveau et par facture.
create function public.finance_generate_reminders(p_as_of date default current_date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r record; v_late int; v_level int; v_n int := 0; v_bal numeric;
begin
  perform private.require_perm('finance.write');
  for r in select i.id, i.code, i.client_id, i.total, i.credited_amount, i.paid_amount, coalesce(i.due_date, i.issue_date) as due
    from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid') loop
    v_late := p_as_of - r.due;
    v_bal := r.total - r.credited_amount - r.paid_amount;
    if v_late >= 1 and v_bal > 0 then
      v_level := case when v_late <= 30 then 1 when v_late <= 60 then 2 else 3 end;
      insert into public.finance_reminders (company_id, invoice_id, level, days_late, balance)
      values (v_co, r.id, v_level, v_late, v_bal)
      on conflict (company_id, invoice_id, level) do nothing;
      if found then v_n := v_n + 1; end if;
    end if;
  end loop;
  perform private.write_audit(v_co, 'finance.reminders_generate', 'company', v_co::text, null, null,
    jsonb_build_object('created', v_n, 'as_of', p_as_of), '{}'::jsonb, 'rpc');
  return v_n;
end $$;

create function public.finance_reminder_mark_sent(p_reminder uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text;
begin
  perform private.require_perm('finance.write');
  select status into v_status from public.finance_reminders where id = p_reminder and company_id = v_co for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'pending' then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  update public.finance_reminders set status = 'sent', sent_at = now(), sent_by = auth.uid() where id = p_reminder;
  perform private.write_audit(v_co, 'finance.reminder_sent', 'finance_reminder', p_reminder::text, null, null, '{"status":"sent"}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Balances âgées
-- ---------------------------------------------------------------------
create function public.finance_aging_clients(p_as_of date default current_date)
returns table (cli_id uuid, cli_name text, cur numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, total numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
    select c.id, c.name,
      coalesce(sum(b.bal) filter (where b.late <= 0), 0),
      coalesce(sum(b.bal) filter (where b.late between 1 and 30), 0),
      coalesce(sum(b.bal) filter (where b.late between 31 and 60), 0),
      coalesce(sum(b.bal) filter (where b.late between 61 and 90), 0),
      coalesce(sum(b.bal) filter (where b.late > 90), 0),
      coalesce(sum(b.bal), 0)
    from (select i.client_id, (i.total - i.credited_amount - i.paid_amount) bal, p_as_of - coalesce(i.due_date, i.issue_date) late
            from public.invoices i where i.company_id = private.current_company() and i.status in ('issued', 'partially_paid')) b
    join public.clients c on c.id = b.client_id
    group by c.id, c.name
    having sum(b.bal) > 0
    order by sum(b.bal) desc;
end $$;

create function public.finance_aging_suppliers(p_as_of date default current_date)
returns table (sup_id uuid, sup_name text, cur numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, total numeric, disputed numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
    select s.id, s.name,
      coalesce(sum(b.bal) filter (where b.late <= 0 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late between 1 and 30 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late between 31 and 60 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late between 61 and 90 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal) filter (where b.late > 90 and b.st <> 'disputed'), 0),
      coalesce(sum(b.bal), 0),
      coalesce(sum(b.bal) filter (where b.st = 'disputed'), 0)
    from (select f.supplier_id, f.status st, (f.total - f.paid_amount) bal, p_as_of - f.due_date late
            from public.supplier_invoices f where f.company_id = private.current_company() and f.status in ('open', 'partially_paid', 'disputed')) b
    join public.suppliers s on s.id = b.supplier_id
    group by s.id, s.name
    having sum(b.bal) > 0
    order by sum(b.bal) desc;
end $$;

-- ---------------------------------------------------------------------
-- 9. Trésorerie et prévisions
-- ---------------------------------------------------------------------
-- Position de trésorerie consolidée à une date (soldes d'ouverture + flux jusqu'à cette date).
create function public.treasury_position(p_as_of date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_start date; v_open numeric; v_rec numeric; v_pay numeric; v_in numeric; v_out numeric;
begin
  perform private.require_perm('finance.read');
  select min(opening_date), coalesce(sum(opening_balance), 0) into v_start, v_open
    from public.cash_accounts where company_id = v_co and opening_date <= p_as_of;
  if v_start is null then return jsonb_build_object('as_of', p_as_of, 'opening', 0, 'receipts', 0, 'payments', 0, 'manual_in', 0, 'manual_out', 0, 'balance', 0); end if;
  select coalesce(sum(amount), 0) into v_rec from public.invoice_payments where company_id = v_co and paid_on between v_start and p_as_of;
  select coalesce(sum(amount), 0) into v_pay from public.supplier_payments where company_id = v_co and paid_on between v_start and p_as_of;
  select coalesce(sum(m.amount) filter (where m.direction = 'in'), 0), coalesce(sum(m.amount) filter (where m.direction = 'out'), 0)
    into v_in, v_out from public.cash_movements m join public.cash_accounts a on a.id = m.account_id
    where m.company_id = v_co and m.moved_on between v_start and p_as_of;
  return jsonb_build_object('as_of', p_as_of, 'opening', v_open, 'receipts', v_rec, 'payments', v_pay,
    'manual_in', v_in, 'manual_out', v_out, 'balance', v_open + v_rec + v_in - v_pay - v_out);
end $$;

-- Prévisions hebdomadaires : encaissements attendus (soldes clients à échoir, retards dans la 1re semaine,
-- taux d'encaissement appliqué) et décaissements (factures fournisseurs non litigieuses).
create function public.treasury_forecast(p_from date default current_date, p_weeks int default 13, p_collection_pct numeric default 100)
returns table (week_no int, week_start date, receipts numeric, payments numeric, net numeric, projected_balance numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pos numeric; w int;
begin
  perform private.require_perm('finance.read');
  if p_weeks < 1 or p_weeks > 53 then raise exception 'FINANCE_BAD_HORIZON' using errcode = '22023'; end if;
  if p_collection_pct is null or p_collection_pct < 0 or p_collection_pct > 100 then raise exception 'FINANCE_BAD_PCT' using errcode = '22023'; end if;
  v_pos := (public.treasury_position(p_from) ->> 'balance')::numeric;
  for w in 0..p_weeks - 1 loop
    week_no := w + 1;
    week_start := p_from + (w * 7);
    receipts := (select coalesce(sum(bal), 0) * p_collection_pct / 100 from (
        select (i.total - i.credited_amount - i.paid_amount) bal, coalesce(i.due_date, i.issue_date) due
          from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid')) x
      where (w = 0 and x.due <= p_from + 6) or (w > 0 and x.due >= week_start and x.due < week_start + 7));
    payments := (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices
      where company_id = v_co and status in ('open', 'partially_paid')
        and ((w = 0 and due_date <= p_from + 6) or (w > 0 and due_date >= week_start and due_date < week_start + 7)));
    net := receipts - payments;
    v_pos := v_pos + net;
    projected_balance := v_pos;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 10. Tableau de bord financier
-- ---------------------------------------------------------------------
create function public.finance_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb; v_recv numeric; v_sales90 numeric;
begin
  perform private.require_perm('finance.read');
  select coalesce(sum(total - credited_amount - paid_amount), 0) into v_recv from public.invoices
    where company_id = v_co and status in ('issued', 'partially_paid');
  select coalesce(sum(total), 0) into v_sales90 from public.invoices
    where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= current_date - 90;
  select jsonb_build_object(
    'treasury', public.treasury_position(current_date),
    'receivables', v_recv,
    'receivables_overdue', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices
        where company_id = v_co and status in ('issued', 'partially_paid') and coalesce(due_date, issue_date) < current_date),
    'dso_days', case when v_sales90 = 0 then null else round(v_recv / (v_sales90 / 90), 1) end,
    'payables', (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices where company_id = v_co and status in ('open', 'partially_paid', 'disputed')),
    'payables_due_14d', (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices
        where company_id = v_co and status in ('open', 'partially_paid') and due_date <= current_date + 14),
    'payables_disputed', (select coalesce(sum(total - paid_amount), 0) from public.supplier_invoices where company_id = v_co and status = 'disputed'),
    'forecast_4w_net', (select coalesce(sum(net), 0) from public.treasury_forecast(current_date, 4, 100)),
    'reminders_pending', (select count(*) from public.finance_reminders where company_id = v_co and status = 'pending'),
    'top_overdue_clients', (select coalesce(jsonb_agg(jsonb_build_object('client', x.cli_name, 'overdue', x.total - x.cur) order by x.total - x.cur desc), '[]'::jsonb)
        from (select * from public.finance_aging_clients(current_date) where total - cur > 0 limit 5) x)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 11. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.supplier_invoice_record(uuid, text, date, date, numeric, text, uuid)',
    'public.supplier_invoice_dispute(uuid, text)',
    'public.supplier_invoice_resolve(uuid)',
    'public.supplier_payment_record(uuid, numeric, date, text, text)',
    'public.customer_receipt_record(uuid, numeric, date, text, text)',
    'public.cash_account_create(text, numeric, date)',
    'public.cash_movement_add(uuid, text, numeric, date, text)',
    'public.finance_generate_reminders(date)',
    'public.finance_reminder_mark_sent(uuid)',
    'public.finance_aging_clients(date)',
    'public.finance_aging_suppliers(date)',
    'public.treasury_position(date)',
    'public.treasury_forecast(date, int, numeric)',
    'public.finance_dashboard()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
