-- 0086_tiers_lettering_disputes — Clients et fournisseurs : lettrage partiel, litiges, échéances, soldes (P061)
-- Existant conservé : factures et avoirs (0012), encaissements client par facture (invoice_record_payment, 0012), paiements
-- fournisseur affectés (supplier_payment_record, 0022, inchangé), litige fournisseur (supplier_invoice_dispute, 0022), soldes
-- (client_balance, 0048), parties (0038), journal général (0031). Rien n'est remplacé ; aucune écriture existante n'est modifiée.
--
-- Règles :
--  * Montants en devise d'origine (invoices.currency / supplier_invoices.currency) ; équivalent en devise de base figé au taux de la pièce
--    (fx_rate). Une pièce en devise étrangère sans taux figé est refusée (LETTERING_FX_MISSING), jamais convertie au hasard.
--  * Lettrage : un règlement (montant, date, mode, référence) est réparti sur des pièces d'un SEUL tiers, dans UNE devise ; la somme
--    des affectations égale le montant du règlement ; chaque affectation est bornée par le solde de la pièce. Atomique.
--  * Le lettrage s'appuie sur les chemins existants : client → invoice_record_payment (pièce par pièce, écritures BQ inchangées) ;
--    fournisseur → paiement, affectations et statut recalculés comme supplier_payment_record. Le lettrage est immuable (pas d'annulation).
--  * Litige client : montant contesté sur une pièce (un seul litige ouvert par pièce, borné par le solde) ; il réduit l'exigible
--    (échéancier) sans modifier le solde. Résolution par une autre personne que l'ouvreur.
--  * Solde d'un tiers : calculé à la demande (invoices / supplier_invoices), par devise, sans compensation client/fournisseur.
--  * Groupe de tiers (party) : seules les fiches de la société courante sont comptées ; encours client et fournisseur séparés ;
--    jamais de somme entre devises ni entre sociétés.
-- Erreurs : LETTERING_BAD_AMOUNT, LETTERING_EMPTY, LETTERING_NOT_FOUND, LETTERING_TIER_MISMATCH, LETTERING_BAD_STATUS,
-- LETTERING_CURRENCY_MISMATCH, LETTERING_DUPLICATE_LINE, LETTERING_UNBALANCED, LETTERING_FX_MISSING, LETTERING_OVERPAYMENT,
-- LETTERING_IMMUTABLE, DISPUTE_BAD_AMOUNT, DISPUTE_ALREADY_OPEN, DISPUTE_NOT_FOUND, DISPUTE_BAD_STATUS, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Lettrage : règlement réparti sur des pièces d'un même tiers
-- ---------------------------------------------------------------------------
create table public.tier_letterings (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code         text not null check (code ~ '^LET-[0-9]{6}$'),
  side         text not null check (side in ('client', 'supplier')),
  client_id    uuid references public.clients(id),
  supplier_id  uuid references public.suppliers(id),
  currency     char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount       numeric(15,2) not null check (amount > 0),
  paid_on      date not null,
  method       text not null check (method in ('transfer', 'cheque', 'lc', 'cash', 'card', 'other')),
  reference    text check (reference is null or length(reference) <= 120),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  check ((side = 'client') = (client_id is not null)),
  check ((side = 'supplier') = (supplier_id is not null)),
  unique (company_id, code)
);
alter table public.tier_letterings enable row level security;
create policy tier_letterings_select on public.tier_letterings for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.tier_lettering_lines (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  lettering_id        uuid not null references public.tier_letterings(id),
  invoice_id          uuid references public.invoices(id),
  supplier_invoice_id uuid references public.supplier_invoices(id),
  client_payment_id   uuid references public.invoice_payments(id),
  supplier_payment_id uuid references public.supplier_payments(id),
  amount              numeric(15,2) not null check (amount > 0),
  fx_rate             numeric(18,8),
  amount_base         numeric(15,2) not null check (amount_base >= 0),
  created_at          timestamptz not null default now(),
  check ((invoice_id is null) <> (supplier_invoice_id is null)),
  check ((client_payment_id is null) <> (supplier_payment_id is null)),
  check ((invoice_id is not null) = (client_payment_id is not null)),
  check ((supplier_invoice_id is not null) = (supplier_payment_id is not null))
);
alter table public.tier_lettering_lines enable row level security;
create policy tier_lettering_lines_select on public.tier_lettering_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.tier_lettering_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'LETTERING_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.tier_lettering_immutable() from public, anon, authenticated;
create trigger tier_letterings_immutable before update or delete on public.tier_letterings
  for each row execute function private.tier_lettering_immutable();
create trigger tier_lettering_lines_immutable before update or delete on public.tier_lettering_lines
  for each row execute function private.tier_lettering_immutable();

-- Taux figé d'une pièce pour l'équivalent en devise de base (devise de base : 1 par définition)
create function private.lettering_fx(p_currency char(3), p_fx numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_currency = private.base_currency() then return 1; end if;
  if p_fx is null then raise exception 'LETTERING_FX_MISSING' using errcode = '55000', detail = p_currency; end if;
  return p_fx;
end $$;
revoke execute on function private.lettering_fx(char, numeric) from public, anon, authenticated;

create function public.client_lettering_apply(p_client uuid, p_amount numeric, p_paid_on date, p_method text, p_reference text, p_allocations jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); v_minor int; v_cur char(3); v_sum numeric := 0;
  a jsonb; v_inv public.invoices%rowtype; v_amt numeric; v_fx numeric; v_seen uuid[] := '{}'; v_let uuid := gen_random_uuid();
  v_code text; v_pay uuid; v_n int := 0; v_method text := coalesce(p_method, 'transfer');
begin
  perform private.require_perm('payments.write');
  if p_amount is null or p_amount <= 0 then raise exception 'LETTERING_BAD_AMOUNT' using errcode = '22023'; end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'LETTERING_EMPTY' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then
    raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002';
  end if;
  select c.minor_units into v_minor from public.currencies c where c.code = v_base;

  -- Contrôles complets avant toute écriture
  for a in select * from jsonb_array_elements(p_allocations) loop
    v_amt := (a->>'amount')::numeric;
    select * into v_inv from public.invoices where id = (a->>'invoice_id')::uuid and company_id = v_co;
    if not found then raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_inv.client_id <> p_client then raise exception 'LETTERING_TIER_MISMATCH' using errcode = '42501'; end if;
    if v_inv.status not in ('issued', 'partially_paid') then raise exception 'LETTERING_BAD_STATUS' using errcode = '55000'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'LETTERING_BAD_AMOUNT' using errcode = '22023'; end if;
    if v_amt > v_inv.total - v_inv.paid_amount - v_inv.credited_amount then raise exception 'LETTERING_OVERPAYMENT' using errcode = '22023'; end if;
    if v_cur is null then v_cur := v_inv.currency; elsif v_cur <> v_inv.currency then raise exception 'LETTERING_CURRENCY_MISMATCH' using errcode = '22023'; end if;
    if v_inv.id = any(v_seen) then raise exception 'LETTERING_DUPLICATE_LINE' using errcode = '22023'; end if;
    perform private.lettering_fx(v_inv.currency, v_inv.fx_rate);
    v_seen := v_seen || v_inv.id;
    v_sum := v_sum + v_amt;
  end loop;
  if v_sum <> p_amount then
    raise exception 'LETTERING_UNBALANCED' using errcode = '22023', detail = v_sum::text || ' / ' || p_amount::text;
  end if;

  v_code := 'LET-' || lpad(private.next_seq(v_co, 'tier_lettering')::text, 6, '0');
  insert into public.tier_letterings (id, company_id, code, side, client_id, currency, amount, paid_on, method, reference)
  values (v_let, v_co, v_code, 'client', p_client, v_cur, p_amount, coalesce(p_paid_on, current_date), v_method, nullif(btrim(coalesce(p_reference, '')), ''));

  for a in select * from jsonb_array_elements(p_allocations) loop
    v_amt := (a->>'amount')::numeric;
    select * into v_inv from public.invoices where id = (a->>'invoice_id')::uuid and company_id = v_co;
    perform public.invoice_record_payment(v_inv.id, v_amt, coalesce(p_paid_on, current_date), v_method, p_reference);
    select p.id into v_pay from public.invoice_payments p where p.invoice_id = v_inv.id order by p.created_at desc, p.id desc limit 1;
    v_fx := private.lettering_fx(v_inv.currency, v_inv.fx_rate);
    insert into public.tier_lettering_lines (company_id, lettering_id, invoice_id, client_payment_id, amount, fx_rate, amount_base)
    values (v_co, v_let, v_inv.id, v_pay, v_amt, v_fx, round(v_amt * v_fx, v_minor));
    v_n := v_n + 1;
  end loop;

  perform private.write_audit(v_co, 'tier.lettering_apply', 'tier_lettering', v_let::text, v_code, null,
    jsonb_build_object('client', p_client, 'amount', p_amount, 'currency', v_cur, 'lines', v_n), '{}'::jsonb, 'rpc');
  return v_code;
end $$;

create function public.supplier_lettering_apply(p_supplier uuid, p_amount numeric, p_paid_on date, p_method text, p_reference text, p_allocations jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); v_minor int; v_cur char(3); v_sum numeric := 0;
  a jsonb; s public.supplier_invoices%rowtype; v_amt numeric; v_fx numeric; v_seen uuid[] := '{}'; v_let uuid := gen_random_uuid();
  v_code text; v_pay uuid := gen_random_uuid(); v_number text; v_n int := 0; v_method text := coalesce(p_method, 'transfer');
begin
  perform private.require_perm('finance.write');
  if p_amount is null or p_amount <= 0 then raise exception 'LETTERING_BAD_AMOUNT' using errcode = '22023'; end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'LETTERING_EMPTY' using errcode = '22023';
  end if;
  if not exists (select 1 from public.suppliers f where f.id = p_supplier and f.company_id = v_co) then
    raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002';
  end if;
  select c.minor_units into v_minor from public.currencies c where c.code = v_base;

  for a in select * from jsonb_array_elements(p_allocations) loop
    v_amt := (a->>'amount')::numeric;
    select * into s from public.supplier_invoices where id = (a->>'supplier_invoice_id')::uuid and company_id = v_co for update;
    if not found then raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002'; end if;
    if s.supplier_id <> p_supplier then raise exception 'LETTERING_TIER_MISMATCH' using errcode = '42501'; end if;
    if s.status not in ('open', 'partially_paid') then raise exception 'LETTERING_BAD_STATUS' using errcode = '55000'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'LETTERING_BAD_AMOUNT' using errcode = '22023'; end if;
    if v_amt > s.total - s.paid_amount then raise exception 'LETTERING_OVERPAYMENT' using errcode = '22023'; end if;
    if v_cur is null then v_cur := s.currency; elsif v_cur <> s.currency then raise exception 'LETTERING_CURRENCY_MISMATCH' using errcode = '22023'; end if;
    if s.id = any(v_seen) then raise exception 'LETTERING_DUPLICATE_LINE' using errcode = '22023'; end if;
    perform private.lettering_fx(s.currency, s.fx_rate);
    v_seen := v_seen || s.id;
    v_sum := v_sum + v_amt;
  end loop;
  if v_sum <> p_amount then
    raise exception 'LETTERING_UNBALANCED' using errcode = '22023', detail = v_sum::text || ' / ' || p_amount::text;
  end if;

  v_code := 'LET-' || lpad(private.next_seq(v_co, 'tier_lettering')::text, 6, '0');
  insert into public.supplier_payments (id, supplier_id, amount, paid_on, method, reference)
  values (v_pay, p_supplier, p_amount, coalesce(p_paid_on, current_date), v_method, nullif(btrim(coalesce(p_reference, '')), ''))
  returning number into v_number;
  insert into public.tier_letterings (id, company_id, code, side, supplier_id, currency, amount, paid_on, method, reference)
  values (v_let, v_co, v_code, 'supplier', p_supplier, v_cur, p_amount, coalesce(p_paid_on, current_date), v_method, nullif(btrim(coalesce(p_reference, '')), ''));

  for a in select * from jsonb_array_elements(p_allocations) loop
    v_amt := (a->>'amount')::numeric;
    select * into s from public.supplier_invoices where id = (a->>'supplier_invoice_id')::uuid and company_id = v_co for update;
    insert into public.supplier_payment_allocations (company_id, payment_id, supplier_invoice_id, amount) values (v_co, v_pay, s.id, v_amt);
    update public.supplier_invoices set paid_amount = paid_amount + v_amt,
      status = case when paid_amount + v_amt = total then 'paid' else 'partially_paid' end where id = s.id;
    v_fx := private.lettering_fx(s.currency, s.fx_rate);
    insert into public.tier_lettering_lines (company_id, lettering_id, supplier_invoice_id, supplier_payment_id, amount, fx_rate, amount_base)
    values (v_co, v_let, s.id, v_pay, v_amt, v_fx, round(v_amt * v_fx, v_minor));
    v_n := v_n + 1;
  end loop;

  perform private.write_audit(v_co, 'tier.lettering_apply', 'tier_lettering', v_let::text, v_code, null,
    jsonb_build_object('supplier', p_supplier, 'amount', p_amount, 'currency', v_cur, 'lines', v_n), '{}'::jsonb, 'rpc');
  return v_code;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Litiges clients : montant contesté sur une pièce (réduit l'exigible, ne change pas le solde)
-- ---------------------------------------------------------------------------
create table public.client_invoice_disputes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  invoice_id   uuid not null references public.invoices(id),
  amount       numeric(15,2) not null check (amount > 0),
  reason       text not null check (length(btrim(reason)) between 5 and 300),
  status       text not null default 'open' check (status in ('open', 'resolved')),
  opened_by    uuid default auth.uid(),
  opened_at    timestamptz not null default now(),
  resolution   text check (resolution is null or length(btrim(resolution)) between 5 and 300),
  resolved_by  uuid,
  resolved_at  timestamptz,
  check ((status = 'resolved') = (resolved_at is not null and resolution is not null)),
  check (resolved_by is null or resolved_by is distinct from opened_by)
);
create unique index client_invoice_disputes_open_uq on public.client_invoice_disputes (invoice_id) where status = 'open';
alter table public.client_invoice_disputes enable row level security;
create policy client_invoice_disputes_select on public.client_invoice_disputes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

-- Seule la résolution (open → resolved) modifie un litige ; jamais de suppression
create function private.client_dispute_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'DISPUTE_BAD_STATUS' using errcode = '55000'; end if;
  if old.status = 'resolved' or (new.id, new.company_id, new.invoice_id, new.amount, new.reason, new.opened_by, new.opened_at)
     is distinct from (old.id, old.company_id, old.invoice_id, old.amount, old.reason, old.opened_by, old.opened_at) then
    raise exception 'DISPUTE_BAD_STATUS' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.client_dispute_guard() from public, anon, authenticated;
create trigger client_invoice_disputes_guard_bud before update or delete on public.client_invoice_disputes
  for each row execute function private.client_dispute_guard();

create function public.client_dispute_open(p_invoice uuid, p_amount numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.invoices%rowtype; v_id uuid := gen_random_uuid(); v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('finance.write');
  select * into i from public.invoices where id = p_invoice and company_id = v_co for update;
  if not found then raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('issued', 'partially_paid') then raise exception 'LETTERING_BAD_STATUS' using errcode = '55000'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > i.total - i.paid_amount - i.credited_amount then
    raise exception 'DISPUTE_BAD_AMOUNT' using errcode = '22023';
  end if;
  if length(v_reason) < 5 then raise exception 'DISPUTE_BAD_AMOUNT' using errcode = '22023', detail = 'reason'; end if;
  if exists (select 1 from public.client_invoice_disputes d where d.invoice_id = i.id and d.status = 'open') then
    raise exception 'DISPUTE_ALREADY_OPEN' using errcode = '55000';
  end if;
  insert into public.client_invoice_disputes (id, company_id, invoice_id, amount, reason) values (v_id, v_co, i.id, p_amount, v_reason);
  perform private.write_audit(v_co, 'tier.dispute_open', 'invoice', i.id::text, i.code, null,
    jsonb_build_object('amount', p_amount, 'currency', i.currency), jsonb_build_object('reason', v_reason), 'rpc');
  return v_id;
end $$;

create function public.client_dispute_resolve(p_dispute uuid, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.client_invoice_disputes%rowtype; v_text text := btrim(coalesce(p_resolution, ''));
begin
  perform private.require_perm('finance.write');
  select * into d from public.client_invoice_disputes where id = p_dispute and company_id = v_co for update;
  if not found then raise exception 'DISPUTE_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'open' then raise exception 'DISPUTE_BAD_STATUS' using errcode = '55000'; end if;
  if d.opened_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'dispute'; end if;
  if length(v_text) < 5 then raise exception 'DISPUTE_BAD_AMOUNT' using errcode = '22023', detail = 'resolution'; end if;
  update public.client_invoice_disputes set status = 'resolved', resolution = v_text, resolved_by = auth.uid(), resolved_at = now() where id = d.id;
  perform private.write_audit(v_co, 'tier.dispute_resolve', 'client_invoice_dispute', d.id::text, null, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'resolved'), jsonb_build_object('resolution', v_text), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Solde et échéancier d'un tiers (devise d'origine + équivalent figé), sans compensation AR/AP
-- ---------------------------------------------------------------------------
create function private.aging_bucket(p_due date, p_as_of date) returns text
language sql immutable as $$
  select case when p_due >= p_as_of then 'non_echu'
              when p_as_of - p_due <= 30 then '1_30'
              when p_as_of - p_due <= 60 then '31_60'
              when p_as_of - p_due <= 90 then '61_90'
              else 'plus_90' end
$$;

create function public.client_statement(p_client uuid, p_as_of date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); v_minor int; v jsonb;
begin
  perform private.require_perm('finance.read');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002'; end if;
  select c.minor_units into v_minor from public.currencies c where c.code = v_base;
  if exists (select 1 from public.invoices i where i.company_id = v_co and i.client_id = p_client and i.status in ('issued', 'partially_paid')
             and i.total - i.paid_amount - i.credited_amount > 0 and i.currency <> v_base and i.fx_rate is null) then
    raise exception 'LETTERING_FX_MISSING' using errcode = '55000';
  end if;
  with items as (
    select i.id, i.code, i.currency, i.due_date, i.total, i.paid_amount, i.credited_amount,
           i.total - i.paid_amount - i.credited_amount as balance,
           case when i.currency = v_base then 1 else i.fx_rate end as fx,
           coalesce((select sum(d.amount) from public.client_invoice_disputes d where d.invoice_id = i.id and d.status = 'open'), 0) as disputed,
           (select coalesce(array_agg(distinct l.code order by l.code), '{}') from public.tier_lettering_lines ll
              join public.tier_letterings l on l.id = ll.lettering_id where ll.invoice_id = i.id) as letters
      from public.invoices i
     where i.company_id = v_co and i.client_id = p_client and i.status in ('issued', 'partially_paid', 'paid', 'credited')
  ), open_items as (
    select it.*, round(it.balance * it.fx, v_minor) as balance_base, private.aging_bucket(it.due_date, p_as_of) as bucket
      from items it where it.balance > 0
  )
  select jsonb_build_object(
    'side', 'client', 'tier', p_client, 'as_of', p_as_of, 'base_currency', v_base,
    'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'balance', x.bal, 'balance_base', x.base,
                      'disputed', x.disp, 'not_due', x.non_echu, 'overdue_1_30', x.b1, 'overdue_31_60', x.b2, 'overdue_61_90', x.b3, 'overdue_plus_90', x.b4)
                      order by x.currency)
             from (select o.currency, sum(o.balance) bal, sum(o.balance_base) base, sum(o.disputed) disp,
                          sum(case when o.bucket = 'non_echu' then o.balance - o.disputed else 0 end) non_echu,
                          sum(case when o.bucket = '1_30' then o.balance - o.disputed else 0 end) b1,
                          sum(case when o.bucket = '31_60' then o.balance - o.disputed else 0 end) b2,
                          sum(case when o.bucket = '61_90' then o.balance - o.disputed else 0 end) b3,
                          sum(case when o.bucket = 'plus_90' then o.balance - o.disputed else 0 end) b4
                     from open_items o group by o.currency) x), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('invoice', o.id, 'code', o.code, 'currency', o.currency, 'due_date', o.due_date,
                      'total', o.total, 'paid', o.paid_amount, 'credited', o.credited_amount, 'balance', o.balance, 'balance_base', o.balance_base,
                      'disputed', o.disputed, 'bucket', o.bucket, 'letters', o.letters) order by o.due_date, o.code)
                 from open_items o), '[]'::jsonb),
    'settled_items', (select count(*)::int from items it where it.balance <= 0)
  ) into v;
  return v;
end $$;

create function public.supplier_statement(p_supplier uuid, p_as_of date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); v_minor int; v jsonb;
begin
  perform private.require_perm('finance.read');
  if not exists (select 1 from public.suppliers f where f.id = p_supplier and f.company_id = v_co) then raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002'; end if;
  select c.minor_units into v_minor from public.currencies c where c.code = v_base;
  if exists (select 1 from public.supplier_invoices s where s.company_id = v_co and s.supplier_id = p_supplier
             and s.status in ('open', 'partially_paid', 'disputed') and s.currency <> v_base and s.fx_rate is null) then
    raise exception 'LETTERING_FX_MISSING' using errcode = '55000';
  end if;
  with items as (
    select s.id, s.number, s.currency, s.due_date, s.total, s.paid_amount, s.total - s.paid_amount as balance, s.status,
           case when s.currency = v_base then 1 else s.fx_rate end as fx,
           (select coalesce(array_agg(distinct l.code order by l.code), '{}') from public.tier_lettering_lines ll
              join public.tier_letterings l on l.id = ll.lettering_id where ll.supplier_invoice_id = s.id) as letters
      from public.supplier_invoices s
     where s.company_id = v_co and s.supplier_id = p_supplier
  ), open_items as (
    select it.*, round(it.balance * it.fx, v_minor) as balance_base, private.aging_bucket(it.due_date, p_as_of) as bucket
      from items it where it.balance > 0
  )
  select jsonb_build_object(
    'side', 'supplier', 'tier', p_supplier, 'as_of', p_as_of, 'base_currency', v_base,
    'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'balance', x.bal, 'balance_base', x.base,
                      'disputed', x.disp, 'not_due', x.non_echu, 'overdue_1_30', x.b1, 'overdue_31_60', x.b2, 'overdue_61_90', x.b3, 'overdue_plus_90', x.b4)
                      order by x.currency)
             from (select o.currency, sum(o.balance) bal, sum(o.balance_base) base,
                          sum(case when o.status = 'disputed' then o.balance else 0 end) disp,
                          sum(case when o.status <> 'disputed' and o.bucket = 'non_echu' then o.balance else 0 end) non_echu,
                          sum(case when o.status <> 'disputed' and o.bucket = '1_30' then o.balance else 0 end) b1,
                          sum(case when o.status <> 'disputed' and o.bucket = '31_60' then o.balance else 0 end) b2,
                          sum(case when o.status <> 'disputed' and o.bucket = '61_90' then o.balance else 0 end) b3,
                          sum(case when o.status <> 'disputed' and o.bucket = 'plus_90' then o.balance else 0 end) b4
                     from open_items o group by o.currency) x), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('supplier_invoice', o.id, 'number', o.number, 'currency', o.currency, 'due_date', o.due_date,
                      'total', o.total, 'paid', o.paid_amount, 'balance', o.balance, 'balance_base', o.balance_base, 'status', o.status,
                      'bucket', o.bucket, 'letters', o.letters) order by o.due_date, o.number)
                 from open_items o), '[]'::jsonb),
    'settled_items', (select count(*)::int from items it where it.balance <= 0)
  ) into v;
  return v;
end $$;

-- Groupe de tiers (party) : fiches client et fournisseur de la société courante uniquement ; encours séparés par côté et devise
create function public.party_balance(p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); v_minor int; v jsonb;
begin
  perform private.require_perm('finance.read');
  if not exists (select 1 from public.parties p where p.id = p_party) then raise exception 'LETTERING_NOT_FOUND' using errcode = 'P0002'; end if;
  select c.minor_units into v_minor from public.currencies c where c.code = v_base;
  select jsonb_build_object(
    'party', p_party, 'base_currency', v_base,
    'clients', (select count(*)::int from public.clients c where c.party_id = p_party and c.company_id = v_co),
    'suppliers', (select count(*)::int from public.suppliers f where f.party_id = p_party and f.company_id = v_co),
    'receivables', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'balance', x.bal, 'balance_base', x.base) order by x.currency)
        from (select i.currency, sum(i.total - i.paid_amount - i.credited_amount) bal,
                     sum(round((i.total - i.paid_amount - i.credited_amount) * case when i.currency = v_base then 1 else i.fx_rate end, v_minor)) base
                from public.invoices i join public.clients c on c.id = i.client_id
               where i.company_id = v_co and c.company_id = v_co and c.party_id = p_party
                 and i.status in ('issued', 'partially_paid') and i.total - i.paid_amount - i.credited_amount > 0
               group by i.currency) x), '[]'::jsonb),
    'payables', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'balance', x.bal, 'balance_base', x.base) order by x.currency)
        from (select s.currency, sum(s.total - s.paid_amount) bal,
                     sum(round((s.total - s.paid_amount) * case when s.currency = v_base then 1 else s.fx_rate end, v_minor)) base
                from public.supplier_invoices s join public.suppliers f on f.id = s.supplier_id
               where s.company_id = v_co and f.company_id = v_co and f.party_id = p_party
                 and s.status in ('open', 'partially_paid', 'disputed') and s.total - s.paid_amount > 0
               group by s.currency) x), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Privilèges
-- ---------------------------------------------------------------------------
grant select on public.tier_letterings, public.tier_lettering_lines, public.client_invoice_disputes to authenticated;
grant all on public.tier_letterings, public.tier_lettering_lines, public.client_invoice_disputes to service_role;
revoke all on public.tier_letterings, public.tier_lettering_lines, public.client_invoice_disputes from anon;

revoke execute on function public.client_lettering_apply(uuid, numeric, date, text, text, jsonb), public.supplier_lettering_apply(uuid, numeric, date, text, text, jsonb),
  public.client_dispute_open(uuid, numeric, text), public.client_dispute_resolve(uuid, text), public.client_statement(uuid, date),
  public.supplier_statement(uuid, date), public.party_balance(uuid)
  from public, anon;
grant execute on function public.client_lettering_apply(uuid, numeric, date, text, text, jsonb), public.supplier_lettering_apply(uuid, numeric, date, text, text, jsonb),
  public.client_dispute_open(uuid, numeric, text), public.client_dispute_resolve(uuid, text), public.client_statement(uuid, date),
  public.supplier_statement(uuid, date), public.party_balance(uuid)
  to authenticated, service_role;
