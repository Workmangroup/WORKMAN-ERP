-- 0056 — Facturation commerciale P031 : acomptes, facturation par BL, avoirs bornés, idempotence
-- Additive. Aucune fonction existante de facturation n'est supprimée : invoice_from_order, invoice_issue, invoice_cancel,
-- invoice_record_payment, credit_note_* (0012) restent en place. Seul ajout de comportement sur un existant : un déclencheur
-- de borne sur l'émission d'un avoir (credit_notes), qui ne fait que refuser ce que les bornes par quantité refusaient déjà
-- ou un avoir sur acompte qui dépasserait le solde non encore imputé.
-- Règles de montants : inchangées (0012, doc_recalc) — arrondi par ligne à 2 décimales, TVA sur le HT du document.
-- Aucune règle d'arrondi « validée finance » n'est présente dans le dépôt : elle n'est pas introduite ici (point ouvert).
-- Droits : aucun nouveau. Création et émission : invoices.write ; imputation d'un acompte : invoices.write ET payments.write ;
-- lecture : invoices.read ou shipments.read.

-- ---------------------------------------------------------------------
-- 1. Colonnes additives
-- ---------------------------------------------------------------------
alter table public.invoices add column if not exists kind text not null default 'standard' check (kind in ('standard', 'deposit'));
alter table public.invoice_lines add column if not exists shipment_line_id uuid references public.shipment_lines(id);
create index if not exists invoice_lines_shipment_line_idx on public.invoice_lines (shipment_line_id) where shipment_line_id is not null;

-- ---------------------------------------------------------------------
-- 2. Idempotence des créations (reprise après coupure : même clé = même document, jamais de doublon)
-- ---------------------------------------------------------------------
create table if not exists public.commercial_idempotency (
  company_id  uuid not null references public.companies(id) on delete cascade,
  scope       text not null check (scope in ('invoice-deposit', 'invoice-shipment')),
  idem_key    text not null check (length(idem_key) between 8 and 120),
  request     text not null check (length(request) <= 300),
  invoice_id  uuid not null references public.invoices(id),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  primary key (company_id, scope, idem_key)
);
alter table public.commercial_idempotency enable row level security;
create policy commercial_idempotency_select on public.commercial_idempotency for select to authenticated
  using (company_id = private.current_company() and private.has_perm('invoices.read'));
grant select on public.commercial_idempotency to authenticated;
revoke all on public.commercial_idempotency from public, anon;

-- ---------------------------------------------------------------------
-- 3. Imputation d'acomptes sur factures (traçable, bornée par le solde de l'acompte et celui de la facture)
-- ---------------------------------------------------------------------
create table if not exists public.invoice_deposit_applications (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  deposit_invoice_id  uuid not null references public.invoices(id),
  final_invoice_id    uuid not null references public.invoices(id),
  amount              numeric(15,2) not null check (amount > 0),
  applied_at          timestamptz not null default now(),
  applied_by          uuid default auth.uid(),
  check (deposit_invoice_id <> final_invoice_id)
);
create index if not exists invoice_deposit_applications_dep_idx on public.invoice_deposit_applications (deposit_invoice_id);
create index if not exists invoice_deposit_applications_fin_idx on public.invoice_deposit_applications (final_invoice_id);
alter table public.invoice_deposit_applications enable row level security;
create policy invoice_deposit_applications_select on public.invoice_deposit_applications for select to authenticated
  using (company_id = private.current_company() and private.has_perm('invoices.read'));
grant select on public.invoice_deposit_applications to authenticated;
revoke all on public.invoice_deposit_applications from public, anon;

-- ---------------------------------------------------------------------
-- 4. Acompte : facture de type « deposit », une ligne hors commande (ne consomme pas la quantité commandée)
-- ---------------------------------------------------------------------
create function public.invoice_deposit_create(p_order uuid, p_amount numeric, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_id uuid := gen_random_uuid(); v_existing uuid; v_stored text; v_done numeric;
        v_req text := p_order::text || '|' || coalesce(p_amount::text, 'null');
begin
  perform private.require_perm('invoices.write');
  if length(btrim(coalesce(p_key, ''))) < 8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023'; end if;
  select invoice_id, request into v_existing, v_stored from public.commercial_idempotency
    where company_id = private.current_company() and scope = 'invoice-deposit' and idem_key = btrim(p_key);
  if found then
    if v_stored <> v_req then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023'; end if;
    return v_existing;
  end if;
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('confirmed', 'delivered') then raise exception 'INVOICE_ORDER_NOT_CONFIRMED' using errcode = '55000'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVOICE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(i.subtotal), 0) into v_done from public.invoices i
    where i.order_id = p_order and i.kind = 'deposit' and i.status not in ('cancelled', 'credited');
  if v_done + p_amount > o.subtotal then raise exception 'DEPOSIT_OVER_ORDER' using errcode = '22023'; end if;
  perform private.ged_assert_client_open(o.client_id);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoices (id, company_id, client_id, order_id, kind, currency, tax_rate, payment_terms)
  values (v_id, o.company_id, o.client_id, p_order, 'deposit', o.currency, coalesce(o.tax_rate, private.client_tax_rate(o.client_id)), o.payment_terms);
  insert into public.invoice_lines (company_id, invoice_id, order_line_id, description, qty, unit_price, discount_pct)
  values (o.company_id, v_id, null, 'Acompte sur commande ' || coalesce(o.code, ''), 1, p_amount, 0);
  insert into public.commercial_idempotency (company_id, scope, idem_key, request, invoice_id)
  values (o.company_id, 'invoice-deposit', btrim(p_key), v_req, v_id);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'invoice.deposit_create', 'invoice', v_id::text, 'Brouillon', null,
    jsonb_build_object('order', o.code), jsonb_build_object('amount_ht', p_amount), 'rpc');
  return v_id;
end $$;
revoke execute on function public.invoice_deposit_create(uuid, numeric, text) from public, anon;
grant execute on function public.invoice_deposit_create(uuid, numeric, text) to authenticated, service_role;

-- Imputation : montant TTC (unité des totaux de facture), borné par le solde de l'acompte ET le solde de la facture finale.
create function public.invoice_deposit_apply(p_invoice uuid, p_deposit uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.invoices%rowtype; d public.invoices%rowtype;
begin
  perform private.require_perm('invoices.write');
  perform private.require_perm('payments.write');
  if p_invoice = p_deposit then raise exception 'DEPOSIT_SAME_INVOICE' using errcode = '22023'; end if;
  select * into f from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into d from public.invoices where id = p_deposit and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.kind <> 'deposit' then raise exception 'DEPOSIT_NOT_A_DEPOSIT' using errcode = '22023'; end if;
  if f.kind <> 'standard' then raise exception 'DEPOSIT_TARGET_INVALID' using errcode = '22023'; end if;
  if f.status not in ('issued', 'partially_paid') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if d.status not in ('issued', 'partially_paid', 'paid') then raise exception 'DEPOSIT_BAD_STATUS' using errcode = '55000'; end if;
  if f.client_id <> d.client_id then raise exception 'DEPOSIT_CLIENT_MISMATCH' using errcode = '22023'; end if;
  if f.order_id is distinct from d.order_id then raise exception 'DEPOSIT_ORDER_MISMATCH' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVOICE_BAD_AMOUNT' using errcode = '22023'; end if;
  if p_amount > d.total - d.credited_amount - d.paid_amount then raise exception 'DEPOSIT_EXCEEDS_BALANCE' using errcode = '22023'; end if;
  if p_amount > f.total - f.credited_amount - f.paid_amount then raise exception 'INVOICE_OVERPAYMENT' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoice_deposit_applications (company_id, deposit_invoice_id, final_invoice_id, amount)
  values (f.company_id, d.id, f.id, p_amount);
  update public.invoices set paid_amount = paid_amount + p_amount where id in (f.id, d.id);
  perform private.invoice_recalc_status(f.id);
  perform private.invoice_recalc_status(d.id);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(f.company_id, 'invoice.deposit_apply', 'invoice', f.id::text, f.code, null,
    jsonb_build_object('deposit', d.code), jsonb_build_object('amount', p_amount), 'rpc');
  perform private.write_audit(f.company_id, 'invoice.deposit_apply', 'invoice', d.id::text, d.code, null,
    jsonb_build_object('final', f.code), jsonb_build_object('amount', p_amount), 'rpc');
end $$;
revoke execute on function public.invoice_deposit_apply(uuid, uuid, numeric) from public, anon;
grant execute on function public.invoice_deposit_apply(uuid, uuid, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Facturation par BL : quantités expédiées, non encore facturées (ni en brouillon ni émises nettes d'avoirs)
-- ---------------------------------------------------------------------
create function private.shipment_billable_qty(p_shipment_line uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select (select qty_shipped from public.shipment_lines where id = p_shipment_line)
       - coalesce((select sum(il.qty - il.qty_credited) from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
                   where il.shipment_line_id = p_shipment_line and i.status not in ('draft', 'cancelled')), 0)
       - coalesce((select sum(il.qty) from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
                   where il.shipment_line_id = p_shipment_line and i.status = 'draft'), 0)
$$;
revoke execute on function private.shipment_billable_qty(uuid) from public, anon, authenticated;

create function public.invoice_from_shipment(p_shipment uuid, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; o public.sales_orders%rowtype; sl record; ol public.sales_order_lines%rowtype;
        v_id uuid := gen_random_uuid(); v_existing uuid; v_stored text; v_req text := p_shipment::text; v_bill numeric; v_ord_pending numeric; v_cnt int; v_n int := 0;
begin
  perform private.require_perm('invoices.write');
  if length(btrim(coalesce(p_key, ''))) < 8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023'; end if;
  select invoice_id, request into v_existing, v_stored from public.commercial_idempotency
    where company_id = private.current_company() and scope = 'invoice-shipment' and idem_key = btrim(p_key);
  if found then
    if v_stored <> v_req then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023'; end if;
    return v_existing;
  end if;
  select * into s from public.shipments where id = p_shipment and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status not in ('shipped', 'delivered') then raise exception 'INVOICE_SHIPMENT_NOT_SHIPPED' using errcode = '55000'; end if;
  select * into o from public.sales_orders where id = s.sales_order_id for update;
  perform private.ged_assert_client_open(s.client_id);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoices (id, company_id, client_id, order_id, currency, tax_rate, payment_terms)
  values (v_id, s.company_id, s.client_id, s.sales_order_id, o.currency, coalesce(o.tax_rate, private.client_tax_rate(s.client_id)), o.payment_terms);
  for sl in select * from public.shipment_lines where shipment_id = p_shipment and qty_shipped > 0 order by created_at, id loop
    select count(*) into v_cnt from public.sales_order_lines where order_id = s.sales_order_id and variant_id = sl.variant_id;
    if v_cnt = 0 then raise exception 'INVOICE_LINE_NOT_IN_ORDER' using errcode = '22023'; end if;
    if v_cnt > 1 then raise exception 'INVOICE_LINE_AMBIGUOUS' using errcode = '22023'; end if;
    select * into ol from public.sales_order_lines where order_id = s.sales_order_id and variant_id = sl.variant_id;
    v_bill := private.shipment_billable_qty(sl.id);
    if v_bill <= 0 then continue; end if;
    select coalesce(sum(il.qty), 0) into v_ord_pending from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
      where il.order_line_id = ol.id and i.status = 'draft';
    if v_bill > ol.qty - ol.qty_invoiced - v_ord_pending then raise exception 'INVOICE_OVER_INVOICED' using errcode = '22023'; end if;
    insert into public.invoice_lines (company_id, invoice_id, order_line_id, shipment_line_id, pos, description, qty, unit_price, discount_pct)
    values (s.company_id, v_id, ol.id, sl.id, v_n + 1, coalesce(ol.description, 'Article'), v_bill, ol.unit_price, ol.discount_pct);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'INVOICE_NOTHING_TO_INVOICE' using errcode = '55000'; end if;
  insert into public.commercial_idempotency (company_id, scope, idem_key, request, invoice_id)
  values (s.company_id, 'invoice-shipment', btrim(p_key), v_req, v_id);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(s.company_id, 'invoice.create', 'invoice', v_id::text, 'Brouillon', null,
    jsonb_build_object('shipment', s.number), jsonb_build_object('lines', v_n), 'rpc');
  return v_id;
end $$;
revoke execute on function public.invoice_from_shipment(uuid, text) from public, anon;
grant execute on function public.invoice_from_shipment(uuid, text) to authenticated, service_role;

-- Rapprochement BL / facture : par ligne d'expédition, quantités expédiées, facturées nettes, en brouillon.
create function public.shipment_billing_status(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if not (private.has_perm('invoices.read') or private.has_perm('shipments.read')) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'shipment_line_id', sl.id, 'variant_id', sl.variant_id, 'qty_shipped', sl.qty_shipped,
    'billed', (select coalesce(sum(il.qty - il.qty_credited), 0) from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
               where il.shipment_line_id = sl.id and i.status not in ('draft', 'cancelled')),
    'draft', (select coalesce(sum(il.qty), 0) from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
              where il.shipment_line_id = sl.id and i.status = 'draft')
  ) order by sl.created_at, sl.id), '[]'::jsonb) into v_out
  from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
  where sl.shipment_id = p_shipment and s.company_id = private.current_company();
  return v_out;
end $$;
revoke execute on function public.shipment_billing_status(uuid) from public, anon;
grant execute on function public.shipment_billing_status(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Avoir borné : total de l'avoir ≤ solde non avoir de la facture ; pour un acompte, moins ce qui est imputé sur des factures
-- ---------------------------------------------------------------------
create function private.credit_note_bound() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_applied numeric := 0;
begin
  if new.status = 'issued' and old.status is distinct from 'issued' then
    select * into i from public.invoices where id = new.invoice_id;
    if i.kind = 'deposit' then
      select coalesce(sum(amount), 0) into v_applied from public.invoice_deposit_applications where deposit_invoice_id = i.id;
    end if;
    if new.total > i.total - i.credited_amount - v_applied then raise exception 'CREDIT_OVER_BALANCE' using errcode = '22023'; end if;
  end if;
  return new;
end $$;
revoke execute on function private.credit_note_bound() from public, anon, authenticated;
create trigger credit_notes_bound_bu before update of status on public.credit_notes for each row execute function private.credit_note_bound();

-- ---------------------------------------------------------------------
-- 7. Journal : les nouvelles tables ne sont écrites que par les fonctions ci-dessus (aucun droit d'écriture direct)
-- ---------------------------------------------------------------------
