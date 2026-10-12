-- =====================================================================
-- 0027_multicurrency — Devises, taux de change, TVA, export, écarts de change, reporting multi-devise
--  Convention : un taux = combien vaut 1 unité de la devise en devise de base (EUR par défaut).
--  Chaque facture client et facture fournisseur fige son taux à l'émission (base_total = équivalent base).
--  Les écarts réalisés (au règlement) et latents (sur le solde ouvert) se calculent à partir de ce taux figé.
--  Limites : les règlements fournisseur n'ont pas de devise propre (imputés à la devise de la facture) ;
--  les montants fournisseur restent à 2 décimales (colonnes existantes) : le TND, à 3 décimales, y est arrondi.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Référentiels : devises et taux de TVA (données réglementaires partagées)
-- ---------------------------------------------------------------------
create table public.currencies (
  code        char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name        text not null,
  minor_units int not null check (minor_units between 0 and 4),
  symbol      text not null
);
insert into public.currencies (code, name, minor_units, symbol) values
  ('EUR', 'Euro', 2, '€'),
  ('TND', 'Dinar tunisien', 3, 'DT'),
  ('USD', 'Dollar américain', 2, '$'),
  ('GBP', 'Livre sterling', 2, '£');
alter table public.currencies enable row level security;
create policy currencies_select on public.currencies for select to authenticated using (true);
revoke all on public.currencies from anon, authenticated;
grant select on public.currencies to authenticated;

create table public.vat_rates (
  code     text primary key,
  label    text not null,
  rate     numeric(5,2) not null check (rate >= 0 and rate <= 100),
  kind     text not null check (kind in ('standard', 'reduced', 'export', 'exempt')),
  country  char(2) not null default 'TN' check (country ~ '^[A-Z]{2}$')
);
insert into public.vat_rates (code, label, rate, kind, country) values
  ('TN_STD_19', 'TVA normale 19 %', 19, 'standard', 'TN'),
  ('TN_RED_13', 'TVA réduite 13 %', 13, 'reduced', 'TN'),
  ('TN_RED_7', 'TVA réduite 7 %', 7, 'reduced', 'TN'),
  ('EXPORT_0', 'Exportation (sans TVA)', 0, 'export', 'TN'),
  ('EXEMPT_0', 'Opération exonérée', 0, 'exempt', 'TN');
alter table public.vat_rates enable row level security;
create policy vat_rates_select on public.vat_rates for select to authenticated using (true);
revoke all on public.vat_rates from anon, authenticated;
grant select on public.vat_rates to authenticated;

-- ---------------------------------------------------------------------
-- 2. Réglages et taux par société
-- ---------------------------------------------------------------------
create table public.finance_settings (
  company_id    uuid primary key default private.current_company() references public.companies(id) on delete cascade,
  base_currency char(3) not null default 'EUR' references public.currencies(code),
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);
alter table public.finance_settings enable row level security;
create policy finance_settings_select on public.finance_settings for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.finance_settings from anon, authenticated;
grant select on public.finance_settings to authenticated;

create table public.exchange_rates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null default private.current_company() references public.companies(id) on delete cascade,
  rate_date  date not null,
  currency   char(3) not null references public.currencies(code),
  rate       numeric(18,8) not null check (rate > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (company_id, rate_date, currency)
);
create index exchange_rates_lookup_idx on public.exchange_rates (company_id, currency, rate_date desc);
alter table public.exchange_rates enable row level security;
create policy exchange_rates_select on public.exchange_rates for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.exchange_rates from anon, authenticated;
grant select on public.exchange_rates to authenticated;

-- Devise de base : EUR si rien n'est configuré.
create function private.base_currency() returns char(3)
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.base_currency from public.finance_settings s where s.company_id = private.current_company()), 'EUR')::char(3)
$$;
revoke execute on function private.base_currency() from public, anon;
grant execute on function private.base_currency() to authenticated;

-- Taux applicable à une date : le plus récent publié à cette date ou avant. Devise de base = 1.
create function public.fx_rate(p_currency text, p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_cur char(3) := upper(btrim(coalesce(p_currency, ''))); v_rate numeric;
begin
  if v_cur = private.base_currency() then return 1; end if;
  select r.rate into v_rate from public.exchange_rates r
   where r.company_id = private.current_company() and r.currency = v_cur and r.rate_date <= p_date
   order by r.rate_date desc limit 1;
  if v_rate is null then
    raise exception 'FX_RATE_MISSING' using errcode = 'P0002', detail = v_cur || ' ' || p_date::text;
  end if;
  return v_rate;
end $$;

-- Conversion d'un montant en devise de base, arrondie aux décimales de la devise de base.
create function public.fx_convert(p_amount numeric, p_currency text, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(p_amount * public.fx_rate(p_currency, p_date), (select c.minor_units from public.currencies c where c.code = private.base_currency()))
$$;

-- Saisie ou correction d'un taux (une seule valeur par jour et par devise).
create function public.fx_rate_set(p_date date, p_currency text, p_rate numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_cur char(3) := upper(btrim(coalesce(p_currency, ''))); v_id uuid;
begin
  perform private.require_perm('finance.write');
  if p_date is null or p_date > current_date + 1 then raise exception 'FX_DATE_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.currencies c where c.code = v_cur) then raise exception 'FX_CURRENCY_UNKNOWN' using errcode = '22023'; end if;
  if v_cur = private.base_currency() then raise exception 'FX_CURRENCY_IS_BASE' using errcode = '22023'; end if;
  if p_rate is null or p_rate <= 0 or p_rate > 1000000 then raise exception 'FX_RATE_INVALID' using errcode = '22023'; end if;
  insert into public.exchange_rates (company_id, rate_date, currency, rate, created_by)
  values (v_co, p_date, v_cur, p_rate, auth.uid())
  on conflict (company_id, rate_date, currency) do update set rate = excluded.rate, created_by = excluded.created_by, created_at = now()
  returning id into v_id;
  perform private.write_audit(v_co, 'finance.fx_rate', 'exchange_rate', v_id::text, v_cur, null,
    jsonb_build_object('date', p_date, 'rate', p_rate), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Changement de devise de base : refusé dès qu'une facture porte un taux figé (le passé ne se réécrit pas).
create function public.finance_set_base_currency(p_currency text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_cur char(3) := upper(btrim(coalesce(p_currency, '')));
begin
  perform private.require_perm('finance.write');
  if not exists (select 1 from public.currencies c where c.code = v_cur) then raise exception 'FX_CURRENCY_UNKNOWN' using errcode = '22023'; end if;
  if exists (select 1 from public.invoices i where i.company_id = v_co and i.fx_rate is not null)
     or exists (select 1 from public.supplier_invoices s where s.company_id = v_co and s.fx_rate is not null) then
    raise exception 'FX_BASE_LOCKED' using errcode = '55000';
  end if;
  insert into public.finance_settings (company_id, base_currency, updated_at, updated_by)
  values (v_co, v_cur, now(), auth.uid())
  on conflict (company_id) do update set base_currency = excluded.base_currency, updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'finance.base_currency', 'company', v_co::text, v_cur, null,
    jsonb_build_object('base_currency', v_cur), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 3. Figement des taux sur les documents
-- ---------------------------------------------------------------------
alter table public.invoices add column fx_rate numeric(18,8);
alter table public.invoices add column base_total numeric(15,2);
alter table public.supplier_invoices add column fx_rate numeric(18,8);
alter table public.supplier_invoices add column base_total numeric(15,2);

-- Documents déjà en EUR : la devise de base est EUR, taux 1.
update public.invoices set fx_rate = 1, base_total = total where fx_rate is null and currency = 'EUR' and status not in ('draft', 'cancelled');
update public.supplier_invoices set fx_rate = 1, base_total = total where fx_rate is null and currency = 'EUR';

-- À l'émission d'une facture client, le taux du jour d'émission est figé (refus si le taux manque).
create function private.invoices_fx_snapshot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_minor int;
begin
  if old.status = 'draft' and new.status in ('issued', 'partially_paid', 'paid', 'credited') and new.fx_rate is null then
    new.fx_rate := public.fx_rate(new.currency, coalesce(new.issue_date, current_date));
    select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
    new.base_total := round(new.total * new.fx_rate, v_minor);
  end if;
  return new;
end $$;
revoke execute on function private.invoices_fx_snapshot() from public, anon, authenticated;
create trigger invoices_fx_snapshot_u before update on public.invoices for each row execute function private.invoices_fx_snapshot();

-- À l'enregistrement d'une facture fournisseur, le taux du jour de la facture est figé.
create function private.supplier_invoices_fx() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_minor int;
begin
  if new.fx_rate is null then
    new.fx_rate := public.fx_rate(new.currency, new.invoice_date);
    select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
    new.base_total := round(new.total * new.fx_rate, v_minor);
  end if;
  return new;
end $$;
revoke execute on function private.supplier_invoices_fx() from public, anon, authenticated;
create trigger supplier_invoices_fx_i before insert on public.supplier_invoices for each row execute function private.supplier_invoices_fx();

-- ---------------------------------------------------------------------
-- 4. Fiscalité export
-- ---------------------------------------------------------------------
-- Domestique si le client est dans le pays de la société, export sinon.
create function public.fiscal_treatment(p_client uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when cl.country = co.country then 'domestic' else 'export' end
    from public.clients cl join public.companies co on co.id = cl.company_id
   where cl.id = p_client and cl.company_id = private.current_company()
$$;

-- Contrôles des factures d'export émises sur la période : TVA facturée à tort, preuve d'expédition absente.
create function public.export_controls(p_from date, p_to date) returns table (
  invoice_id uuid, code text, client_name text, country char(2), currency char(3), base_total numeric, tax_amount numeric,
  has_proof boolean, issues text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  select i.id, i.code, cl.name, cl.country, i.currency, i.base_total, i.tax_amount,
         exists (select 1 from public.shipments s where s.sales_order_id = i.order_id and s.bl_issued_at is not null),
         array_remove(array[
           case when i.tax_amount > 0 then 'TVA facturée sur une exportation' end,
           case when not exists (select 1 from public.shipments s where s.sales_order_id = i.order_id and s.bl_issued_at is not null)
                then 'Preuve d’exportation manquante (aucun BL émis pour la commande)' end
         ], null)
    from public.invoices i
    join public.clients cl on cl.id = i.client_id
    join public.companies co on co.id = i.company_id
   where i.company_id = private.current_company()
     and i.status in ('issued', 'partially_paid', 'paid', 'credited')
     and i.issue_date between p_from and p_to
     and cl.country <> co.country
   order by i.code;
end $$;

-- ---------------------------------------------------------------------
-- 5. TVA : base et TVA collectées par taux, en devise de base
-- ---------------------------------------------------------------------
-- Les avoirs ne sont pas encore déduits (à rapprocher avant déclaration).
create function public.vat_summary(p_from date, p_to date) returns table (
  tax_rate numeric, label text, invoices_count bigint, base_ht numeric, base_tva numeric, base_ttc numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int;
begin
  perform private.require_perm('finance.read');
  select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
  return query
  select i.tax_rate,
         (select v.label from public.vat_rates v where v.rate = i.tax_rate order by v.kind limit 1),
         count(*)::bigint,
         sum(round(i.subtotal * i.fx_rate, v_minor)),
         sum(round(i.tax_amount * i.fx_rate, v_minor)),
         sum(i.base_total)
    from public.invoices i
   where i.company_id = private.current_company()
     and i.status in ('issued', 'partially_paid', 'paid', 'credited')
     and i.issue_date between p_from and p_to
     and i.fx_rate is not null
   group by i.tax_rate
   order by i.tax_rate;
end $$;

-- ---------------------------------------------------------------------
-- 6. Écarts de change
-- ---------------------------------------------------------------------
-- Latents : soldes ouverts en devise étrangère, réévalués au taux de la date demandée.
-- Gain positif = créance qui vaut plus, ou dette qui vaut moins, en devise de base.
create function public.fx_open_positions(p_as_of date) returns table (
  kind text, document_id uuid, number text, counterparty text, currency char(3), open_amount numeric,
  rate_booked numeric, base_booked numeric, rate_today numeric, base_today numeric, unrealized numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int;
begin
  perform private.require_perm('finance.read');
  select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
  return query
  with docs as (
    select 'receivable'::text as k, i.id as did, i.code as dn, cl.name as cp, i.currency as cur,
           (i.total - i.paid_amount - i.credited_amount) as oa, i.fx_rate as rb
      from public.invoices i join public.clients cl on cl.id = i.client_id
     where i.company_id = private.current_company() and i.currency <> private.base_currency()
       and i.status in ('issued', 'partially_paid') and i.fx_rate is not null
    union all
    select 'payable', s.id, s.number, sp.name, s.currency, (s.total - s.paid_amount), s.fx_rate
      from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id
     where s.company_id = private.current_company() and s.currency <> private.base_currency()
       and s.status in ('open', 'partially_paid', 'disputed') and s.fx_rate is not null
  ), priced as (
    select d.*, public.fx_rate(d.cur, p_as_of) as rt from docs d
  )
  select p.k, p.did, p.dn, p.cp, p.cur, p.oa, p.rb,
         round(p.oa * p.rb, v_minor), p.rt, round(p.oa * p.rt, v_minor),
         case when p.k = 'receivable' then round(p.oa * p.rt, v_minor) - round(p.oa * p.rb, v_minor)
              else round(p.oa * p.rb, v_minor) - round(p.oa * p.rt, v_minor) end
    from priced p
   order by p.k, p.dn;
end $$;

-- Réalisés : écart constaté au règlement, entre le taux figé et le taux du jour du paiement.
create function public.fx_realized_gains(p_from date, p_to date) returns table (
  kind text, document_id uuid, number text, currency char(3), amount numeric, rate_booked numeric, rate_settled numeric, realized numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int;
begin
  perform private.require_perm('finance.read');
  select c.minor_units into v_minor from public.currencies c where c.code = private.base_currency();
  return query
  select 'receivable'::text, i.id, i.code, i.currency, p.amount, i.fx_rate, public.fx_rate(i.currency, p.paid_on),
         round(p.amount * public.fx_rate(i.currency, p.paid_on), v_minor) - round(p.amount * i.fx_rate, v_minor)
    from public.invoice_payments p join public.invoices i on i.id = p.invoice_id
   where p.company_id = private.current_company() and i.currency <> private.base_currency()
     and i.fx_rate is not null and p.paid_on between p_from and p_to
  union all
  select 'payable', s.id, s.number, s.currency, a.amount, s.fx_rate, public.fx_rate(s.currency, pay.paid_on),
         round(a.amount * s.fx_rate, v_minor) - round(a.amount * public.fx_rate(s.currency, pay.paid_on), v_minor)
    from public.supplier_payment_allocations a
    join public.supplier_payments pay on pay.id = a.payment_id
    join public.supplier_invoices s on s.id = a.supplier_invoice_id
   where a.company_id = private.current_company() and s.currency <> private.base_currency()
     and s.fx_rate is not null and pay.paid_on between p_from and p_to;
end $$;

-- ---------------------------------------------------------------------
-- 7. Reporting financier multi-devise, par devise
-- ---------------------------------------------------------------------
create function public.multicurrency_report(p_from date, p_to date, p_as_of date) returns table (
  currency char(3), invoiced_foreign numeric, invoiced_base numeric, receivable_open_foreign numeric, receivable_open_base numeric,
  payable_open_foreign numeric, payable_open_base numeric, realized_gain numeric, unrealized_gain numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.read');
  return query
  with codes as (
    select i.currency as cc from public.invoices i where i.company_id = private.current_company()
    union
    select s.currency from public.supplier_invoices s where s.company_id = private.current_company()
  ), inv as (
    select i.currency as cc, sum(i.total) as f, sum(i.base_total) as b
      from public.invoices i
     where i.company_id = private.current_company() and i.status in ('issued', 'partially_paid', 'paid', 'credited')
       and i.issue_date between p_from and p_to
     group by i.currency
  ), pos as (
    select q.currency as cc,
           sum(q.open_amount) filter (where q.kind = 'receivable') as rf,
           sum(q.base_today) filter (where q.kind = 'receivable') as rb,
           sum(q.open_amount) filter (where q.kind = 'payable') as pf,
           sum(q.base_today) filter (where q.kind = 'payable') as pb,
           sum(q.unrealized) as u
      from public.fx_open_positions(p_as_of) q
     group by q.currency
  ), rea as (
    select g.currency as cc, sum(g.realized) as r from public.fx_realized_gains(p_from, p_to) g group by g.currency
  )
  select k.cc::char(3), inv.f, inv.b, pos.rf, pos.rb, pos.pf, pos.pb, rea.r, pos.u
    from codes k
    left join inv on inv.cc = k.cc
    left join pos on pos.cc = k.cc
    left join rea on rea.cc = k.cc
   order by k.cc;
end $$;

-- ---------------------------------------------------------------------
-- 8. Droits d'exécution
-- ---------------------------------------------------------------------
revoke execute on function public.fx_rate(text, date), public.fx_convert(numeric, text, date), public.fx_rate_set(date, text, numeric),
  public.finance_set_base_currency(text), public.fiscal_treatment(uuid), public.export_controls(date, date),
  public.vat_summary(date, date), public.fx_open_positions(date), public.fx_realized_gains(date, date),
  public.multicurrency_report(date, date, date) from public, anon;
grant execute on function public.fx_rate(text, date), public.fx_convert(numeric, text, date), public.fx_rate_set(date, text, numeric),
  public.finance_set_base_currency(text), public.fiscal_treatment(uuid), public.export_controls(date, date),
  public.vat_summary(date, date), public.fx_open_positions(date), public.fx_realized_gains(date, date),
  public.multicurrency_report(date, date, date) to authenticated;
