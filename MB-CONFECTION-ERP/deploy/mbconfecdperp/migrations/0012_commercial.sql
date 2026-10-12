-- =====================================================================
-- 0012_commercial — Module Commercial
--  Prospects (pipeline, conversion en client), devis, commandes client (extension du socle 0010), factures,
--  avoirs, encaissements, tableau de bord commercial.
--  Workflow : Prospect → Devis → (acceptation) → Commande → Facture (→ Avoir).
--  Numérotation légale sans trou : une facture ou un avoir ne reçoit son numéro qu'à l'émission (dans la même transaction).
--  Les clients restent gérés par le module Clients (0004) ; la conversion d'un prospect crée la fiche client.
--  Permissions nouvelles : prospects.read / prospects.write / quotes.read / quotes.write.
--  Réutilisées : clients.*, orders.read|write|confirm, invoices.read|write (factures, avoirs), payments.read|write (encaissements).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('prospects.read',  'clients', 'Voir les prospects',  'Prospects, pipeline commercial'),
  ('prospects.write', 'clients', 'Gérer les prospects', 'Créer, qualifier, faire avancer et convertir les prospects'),
  ('quotes.read',     'orders',  'Voir les devis',      null),
  ('quotes.write',    'orders',  'Gérer les devis',     'Créer, envoyer, enregistrer la réponse du client, transformer en commande')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('prospects.read', 'prospects.write', 'quotes.read', 'quotes.write'))
  or (r.code = 'commercial' and p.code in ('prospects.read', 'prospects.write', 'quotes.read', 'quotes.write'))
  or (r.code = 'direction'  and p.code in ('prospects.read', 'quotes.read'))
  or (r.code = 'finance'    and p.code = 'quotes.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Prospects
-- ---------------------------------------------------------------------
create table public.prospects (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  code                text not null,                                          -- PRO-0001
  company_name        text not null check (length(btrim(company_name)) between 2 and 120),
  contact_name        text check (contact_name is null or length(contact_name) <= 120),
  email               text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone               text check (phone is null or length(phone) <= 40),
  country             char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  city                text check (city is null or length(city) <= 80),
  source              text not null default 'other' check (source in ('website','trade_show','referral','cold_call','social','other')),
  stage               text not null default 'new' check (stage in ('new','contacted','qualified','proposal','negotiation','won','lost')),
  est_value           numeric(15,2) not null default 0 check (est_value >= 0),
  expected_close      date,
  owner_id            uuid references public.profiles(id) on delete set null,
  next_action         text check (next_action is null or length(next_action) <= 200),
  next_action_date    date,
  notes               text check (notes is null or length(notes) <= 2000),
  lost_reason         text check (lost_reason is null or length(lost_reason) <= 300),
  converted_client_id uuid references public.clients(id) on delete set null,
  stage_changed_at    timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  unique (company_id, code)
);
create index prospects_idx on public.prospects (company_id, stage);

create table public.prospect_activities (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  prospect_id uuid not null references public.prospects(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('call','email','meeting','note')),
  summary     text not null check (length(btrim(summary)) between 2 and 500),
  happened_at timestamptz not null default now(),
  created_by  uuid
);
create index prospect_activities_idx on public.prospect_activities (prospect_id, happened_at desc);

-- ---------------------------------------------------------------------
-- 3. Devis
-- ---------------------------------------------------------------------
create table public.quotes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text not null,                                               -- DEV-2026-0001
  client_id      uuid references public.clients(id),
  prospect_id    uuid references public.prospects(id),
  status         text not null default 'draft' check (status in ('draft','sent','accepted','rejected','converted','cancelled')),
  quote_date     date not null default current_date,
  valid_until    date not null default (current_date + 30),
  currency       char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  tax_rate       numeric(5,2) not null default 19 check (tax_rate between 0 and 100),
  payment_terms  text check (payment_terms is null or length(payment_terms) <= 120),
  lead_days      int not null default 30 check (lead_days between 0 and 365),   -- délai de livraison annoncé
  notes          text check (notes is null or length(notes) <= 2000),
  subtotal       numeric(15,2) not null default 0,
  tax_amount     numeric(15,2) not null default 0,
  total          numeric(15,2) not null default 0,
  order_id       uuid,
  sent_at        timestamptz,
  decided_at     timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) <= 300),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  unique (company_id, code),
  constraint quotes_one_party check ((client_id is not null) <> (prospect_id is not null))
);
create index quotes_idx on public.quotes (company_id, status, quote_date desc);

create table public.quote_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  pos          int not null default 0,
  article_id   uuid references public.articles(id),
  description  text not null check (length(btrim(description)) between 1 and 300),
  qty          numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  unit_price   numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  created_at   timestamptz not null default now()
);
create index quote_lines_idx on public.quote_lines (quote_id, pos);

-- ---------------------------------------------------------------------
-- 4. Commandes client : extension du socle (0010) — prix, totaux, lien avec le devis, avancement de facturation
-- ---------------------------------------------------------------------
alter table public.sales_orders
  add column quote_id       uuid references public.quotes(id) on delete set null,
  add column currency       char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  add column tax_rate       numeric(5,2) check (tax_rate is null or tax_rate between 0 and 100),
  add column payment_terms  text check (payment_terms is null or length(payment_terms) <= 120),
  add column subtotal       numeric(15,2) not null default 0,
  add column tax_amount     numeric(15,2) not null default 0,
  add column total          numeric(15,2) not null default 0,
  add column invoice_status text not null default 'none' check (invoice_status in ('none','partial','full'));
alter table public.quotes add constraint quotes_order_fk foreign key (order_id) references public.sales_orders(id) on delete set null;

alter table public.sales_order_lines
  alter column article_id drop not null,
  add column description  text check (description is null or length(description) <= 300),
  add column unit_price   numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  add column discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  add column qty_invoiced numeric(12,2) not null default 0 check (qty_invoiced >= 0);
alter table public.sales_order_lines add constraint sales_order_lines_invoiced_ck check (qty_invoiced <= qty);

-- ---------------------------------------------------------------------
-- 5. Factures, encaissements, avoirs
-- ---------------------------------------------------------------------
create table public.invoices (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text,                                                        -- FAC-2026-0001 : attribué à l'émission
  client_id      uuid not null references public.clients(id),
  order_id       uuid references public.sales_orders(id),
  status         text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','credited','cancelled')),
  issue_date     date,
  due_date       date,
  currency       char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  tax_rate       numeric(5,2) not null default 19 check (tax_rate between 0 and 100),
  payment_terms  text check (payment_terms is null or length(payment_terms) <= 120),
  notes          text check (notes is null or length(notes) <= 2000),
  subtotal       numeric(15,2) not null default 0,
  tax_amount     numeric(15,2) not null default 0,
  total          numeric(15,2) not null default 0,
  paid_amount    numeric(15,2) not null default 0 check (paid_amount >= 0),
  credited_amount numeric(15,2) not null default 0 check (credited_amount >= 0),
  created_at     timestamptz not null default now(),
  created_by     uuid,
  issued_at      timestamptz,
  issued_by      uuid,
  updated_at     timestamptz not null default now(),
  constraint invoices_code_ck check ((status in ('draft', 'cancelled')) or code is not null)
);
create unique index invoices_code_uq on public.invoices (company_id, code) where code is not null;
create index invoices_idx on public.invoices (company_id, status, issue_date desc);
create index invoices_order_idx on public.invoices (order_id);

create table public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  order_line_id uuid references public.sales_order_lines(id),
  pos           int not null default 0,
  description   text not null check (length(btrim(description)) between 1 and 300),
  qty           numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  unit_price    numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  discount_pct  numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  qty_credited  numeric(12,2) not null default 0 check (qty_credited >= 0),
  created_at    timestamptz not null default now(),
  constraint invoice_lines_credited_ck check (qty_credited <= qty)
);
create index invoice_lines_idx on public.invoice_lines (invoice_id, pos);

create table public.invoice_payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  invoice_id  uuid not null references public.invoices(id),
  amount      numeric(15,2) not null check (amount > 0),
  paid_on     date not null default current_date,
  method      text not null default 'transfer' check (method in ('transfer','cheque','lc','cash','card','other')),
  reference   text check (reference is null or length(reference) <= 120),
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index invoice_payments_idx on public.invoice_payments (invoice_id, paid_on);

create table public.credit_notes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text,                                                        -- AV-2026-0001 : attribué à l'émission
  invoice_id     uuid not null references public.invoices(id),
  client_id      uuid not null references public.clients(id),
  status         text not null default 'draft' check (status in ('draft','issued','cancelled')),
  reason         text not null check (length(btrim(reason)) between 3 and 300),
  issue_date     date,
  currency       char(3) not null default 'EUR',
  tax_rate       numeric(5,2) not null default 19,
  reopen_order   boolean not null default false,
  subtotal       numeric(15,2) not null default 0,
  tax_amount     numeric(15,2) not null default 0,
  total          numeric(15,2) not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  issued_at      timestamptz,
  issued_by      uuid,
  constraint credit_notes_code_ck check (status <> 'issued' or code is not null)
);
create unique index credit_notes_code_uq on public.credit_notes (company_id, code) where code is not null;
create index credit_notes_idx on public.credit_notes (company_id, status, issue_date desc);

create table public.credit_note_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  credit_note_id  uuid not null references public.credit_notes(id) on delete cascade,
  invoice_line_id uuid not null references public.invoice_lines(id),
  pos             int not null default 0,
  description     text not null,
  qty             numeric(12,2) not null check (qty > 0),
  unit_price      numeric(14,4) not null,
  discount_pct    numeric(5,2) not null default 0
);
create index credit_note_lines_idx on public.credit_note_lines (credit_note_id, pos);

-- ---------------------------------------------------------------------
-- 6. Totaux (HT, TVA, TTC) recalculés par trigger pour les quatre types de documents
-- ---------------------------------------------------------------------
create function private.doc_recalc() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  v_id := case when tg_op = 'DELETE' then (to_jsonb(old) ->> tg_argv[2])::uuid else (to_jsonb(new) ->> tg_argv[2])::uuid end;
  perform set_config('commercial.rpc', 'on', true);
  execute format($f$update public.%I h set subtotal = s.sub, tax_amount = round(s.sub * h.tax_rate / 100, 2), total = s.sub + round(s.sub * h.tax_rate / 100, 2)
                    from (select coalesce(sum(round(qty * unit_price * (1 - discount_pct / 100), 2)), 0) as sub from public.%I where %I = $1) s where h.id = $1$f$,
                 tg_argv[0], tg_argv[1], tg_argv[3]) using v_id;
  perform set_config('commercial.rpc', v_prev, true);
  return null;
end $$;
revoke execute on function private.doc_recalc() from public, anon, authenticated;

create trigger quote_lines_recalc after insert or update or delete on public.quote_lines for each row execute function private.doc_recalc('quotes', 'quote_lines', 'quote_id', 'quote_id');
create trigger sales_order_lines_recalc after insert or update of qty, unit_price, discount_pct or delete on public.sales_order_lines for each row execute function private.doc_recalc('sales_orders', 'sales_order_lines', 'order_id', 'order_id');
create trigger invoice_lines_recalc after insert or update or delete on public.invoice_lines for each row execute function private.doc_recalc('invoices', 'invoice_lines', 'invoice_id', 'invoice_id');
create trigger credit_note_lines_recalc after insert or update or delete on public.credit_note_lines for each row execute function private.doc_recalc('credit_notes', 'credit_note_lines', 'credit_note_id', 'credit_note_id');
-- (4e argument = colonne de la table de lignes ; 3e = colonne portée par la ligne pour retrouver l'en-tête)
create trigger quotes_recalc_rate after update of tax_rate on public.quotes for each row execute function private.doc_recalc('quotes', 'quote_lines', 'id', 'quote_id');
create trigger sales_orders_recalc_rate after update of tax_rate on public.sales_orders for each row execute function private.doc_recalc('sales_orders', 'sales_order_lines', 'id', 'order_id');
create trigger invoices_recalc_rate after update of tax_rate on public.invoices for each row execute function private.doc_recalc('invoices', 'invoice_lines', 'id', 'invoice_id');

-- ---------------------------------------------------------------------
-- 7. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.commercial_rpc() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('commercial.rpc', true), 'off') = 'on' $$;

-- TVA par défaut d'un client : 0 si exonéré, 19 sinon
create function private.client_tax_rate(p_client uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when vat_exempt then 0 else 19 end from public.clients where id = p_client $$;
revoke execute on function private.client_tax_rate(uuid) from public, anon, authenticated;

create function private.prospects_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'PRO-' || lpad(private.next_seq(new.company_id, 'prospect')::text, 4, '0');
    new.created_by := auth.uid(); new.stage := 'new'; new.converted_client_id := null; new.lost_reason := null; new.stage_changed_at := now();
  elsif not private.commercial_rpc() then
    new.stage := old.stage; new.converted_client_id := old.converted_client_id; new.lost_reason := old.lost_reason; new.stage_changed_at := old.stage_changed_at;
    if old.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
    new.updated_at := now();
  end if;
  new.company_name := btrim(new.company_name);
  new.country := upper(new.country);
  new.email := nullif(btrim(coalesce(new.email, '')), '');
  if new.owner_id is not null and not exists (select 1 from public.profiles where id = new.owner_id and company_id = new.company_id and is_active) then raise exception 'PROSPECT_BAD_OWNER' using errcode = '22023'; end if;
  return new;
end $$;
create trigger prospects_before_iu before insert or update on public.prospects for each row execute function private.prospects_before();

create function private.prospect_activities_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  select * into p from public.prospects where id = new.prospect_id;
  if not found then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := p.company_id; new.created_by := auth.uid(); new.happened_at := coalesce(new.happened_at, now());
  new.summary := btrim(new.summary);
  return new;
end $$;
create trigger prospect_activities_before_i before insert on public.prospect_activities for each row execute function private.prospect_activities_before();

create function private.quotes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.clients%rowtype;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'DEV-' || extract(year from current_date)::text || '-' || lpad(private.next_seq(new.company_id, 'quote-' || extract(year from current_date)::text)::text, 4, '0');
    new.created_by := auth.uid(); new.status := 'draft'; new.order_id := null; new.sent_at := null; new.decided_at := null; new.decision_reason := null;
    new.subtotal := 0; new.tax_amount := 0; new.total := 0;
    if new.client_id is not null then
      select * into c from public.clients where id = new.client_id and company_id = new.company_id;
      if not found then raise exception 'COMMERCIAL_BAD_CLIENT' using errcode = '22023'; end if;
      perform private.ged_assert_client_open(new.client_id);
      new.currency := coalesce(nullif(c.currency, ''), new.currency);
    elsif not exists (select 1 from public.prospects where id = new.prospect_id and company_id = new.company_id and stage not in ('won', 'lost')) then
      raise exception 'COMMERCIAL_BAD_PROSPECT' using errcode = '22023';
    end if;
  elsif not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id or new.prospect_id is distinct from old.prospect_id then raise exception 'COMMERCIAL_LOCKED' using errcode = '42501'; end if;
    new.updated_at := now();
  end if;
  if new.valid_until < new.quote_date and not private.commercial_rpc() then raise exception 'QUOTE_BAD_VALIDITY' using errcode = '22023'; end if;
  new.payment_terms := nullif(btrim(coalesce(new.payment_terms, '')), '');
  return new;
end $$;
create trigger quotes_before_iu before insert or update on public.quotes for each row execute function private.quotes_before();

create function private.quote_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; a public.articles%rowtype; v_q uuid := coalesce(new.quote_id, old.quote_id);
begin
  select * into q from public.quotes where id = v_q;
  if not private.commercial_rpc() and found and q.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := q.company_id;
    new.pos := coalesce(nullif(new.pos, 0), (select coalesce(max(pos), 0) + 1 from public.quote_lines where quote_id = new.quote_id));
    if new.article_id is not null then
      select * into a from public.articles where id = new.article_id and company_id = q.company_id;
      if not found or q.client_id is null or a.client_id <> q.client_id or a.status = 'discontinued' then raise exception 'COMMERCIAL_BAD_ARTICLE' using errcode = '22023'; end if;
      if nullif(btrim(coalesce(new.description, '')), '') is null then new.description := a.name; end if;
    end if;
  end if;
  new.description := btrim(coalesce(new.description, ''));
  return new;
end $$;
create trigger quote_lines_before_iud before insert or update or delete on public.quote_lines for each row execute function private.quote_lines_before();

-- Commandes : même logique qu'en 0010, étendue (prix, article facultatif, TVA par défaut, verrous de facturation)
create or replace function private.sales_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'CMD-' || lpad(private.next_seq(new.company_id, 'sales_order')::text, 4, '0');
    perform private.ged_assert_client_open(new.client_id);
    if not exists (select 1 from public.clients where id = new.client_id and company_id = new.company_id) then raise exception 'ORDER_BAD_CLIENT' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.status := 'draft'; new.confirmed_at := null; new.confirmed_by := null;
    if not private.commercial_rpc() then new.quote_id := null; end if;
    new.invoice_status := 'none'; new.subtotal := 0; new.tax_amount := 0; new.total := 0;
    new.tax_rate := coalesce(new.tax_rate, private.client_tax_rate(new.client_id));
  elsif coalesce(current_setting('orders.rpc', true), 'off') <> 'on' and not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'ORDER_LOCKED' using errcode = '42501'; end if;
  end if;
  new.client_ref := nullif(btrim(coalesce(new.client_ref, '')), '');
  new.payment_terms := nullif(btrim(coalesce(new.payment_terms, '')), '');
  return new;
end $$;

create or replace function private.sales_order_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; a public.articles%rowtype; v_order uuid := coalesce(new.order_id, old.order_id);
begin
  select * into o from public.sales_orders where id = v_order;
  if coalesce(current_setting('orders.rpc', true), 'off') <> 'on' and not private.commercial_rpc() and found and o.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := o.company_id;
    if not private.commercial_rpc() then new.qty_invoiced := 0; end if;
    if new.article_id is not null then
      select * into a from public.articles where id = new.article_id;
      if not found or a.client_id <> o.client_id then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;   -- l'article doit appartenir au client de la commande
      if a.status = 'discontinued' then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;
      if nullif(btrim(coalesce(new.description, '')), '') is null then new.description := a.name; end if;
    elsif nullif(btrim(coalesce(new.description, '')), '') is null then
      raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023';                                                           -- ligne libre : description obligatoire
    end if;
  elsif not private.commercial_rpc() then
    new.qty_invoiced := old.qty_invoiced;
  end if;
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;

create function private.invoices_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if not private.commercial_rpc() then
      new.status := 'draft'; new.code := null; new.order_id := null; new.issue_date := null; new.due_date := null; new.paid_amount := 0; new.credited_amount := 0;
      new.issued_at := null; new.issued_by := null;
    end if;
    perform private.ged_assert_client_open(new.client_id);
    if not exists (select 1 from public.clients where id = new.client_id and company_id = new.company_id) then raise exception 'COMMERCIAL_BAD_CLIENT' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.subtotal := 0; new.tax_amount := 0; new.total := 0;
  elsif not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'COMMERCIAL_LOCKED' using errcode = '42501'; end if;
    new.updated_at := now();
  end if;
  new.payment_terms := nullif(btrim(coalesce(new.payment_terms, '')), '');
  return new;
end $$;
create trigger invoices_before_iu before insert or update on public.invoices for each row execute function private.invoices_before();

create function private.invoice_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_inv uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  select * into i from public.invoices where id = v_inv;
  if not private.commercial_rpc() and found and i.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := i.company_id;
    new.pos := coalesce(nullif(new.pos, 0), (select coalesce(max(pos), 0) + 1 from public.invoice_lines where invoice_id = new.invoice_id));
    if not private.commercial_rpc() then new.order_line_id := null; new.qty_credited := 0; end if;     -- les lignes liées à une commande ne viennent que de invoice_from_order
  elsif not private.commercial_rpc() then
    new.qty_credited := old.qty_credited;
  end if;
  new.description := btrim(coalesce(new.description, ''));
  return new;
end $$;
create trigger invoice_lines_before_iud before insert or update or delete on public.invoice_lines for each row execute function private.invoice_lines_before();

create function private.credit_notes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.created_by := auth.uid();
  elsif not private.commercial_rpc() then
    if old.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  end if;
  new.reason := btrim(new.reason);
  return new;
end $$;
create trigger credit_notes_before_iu before insert or update on public.credit_notes for each row execute function private.credit_notes_before();

create function private.credit_note_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n public.credit_notes%rowtype; v_cn uuid := coalesce(new.credit_note_id, old.credit_note_id);
begin
  select * into n from public.credit_notes where id = v_cn;
  if not private.commercial_rpc() and found and n.status <> 'draft' then raise exception 'COMMERCIAL_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if not private.commercial_rpc() then
    new.credit_note_id := old.credit_note_id; new.invoice_line_id := old.invoice_line_id; new.description := old.description; new.unit_price := old.unit_price; new.discount_pct := old.discount_pct;
  end if;
  return new;
end $$;
create trigger credit_note_lines_before_ud before update or delete on public.credit_note_lines for each row execute function private.credit_note_lines_before();

-- ---------------------------------------------------------------------
-- 8. Prospects : étape, conversion en client
-- ---------------------------------------------------------------------
create function public.prospect_set_stage(p_prospect uuid, p_stage text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  perform private.require_perm('prospects.write');
  if p_stage not in ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost') then raise exception 'PROSPECT_BAD_STAGE' using errcode = '22023'; end if;
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p_stage = 'won' then raise exception 'PROSPECT_USE_CONVERT' using errcode = '22023'; end if;            -- « gagné » = conversion en client
  if p_stage = 'lost' and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PROSPECT_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_stage = p.stage then return; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.prospects set stage = p_stage, stage_changed_at = now(), lost_reason = case when p_stage = 'lost' then btrim(p_reason) end where id = p_prospect;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.stage', 'prospect', p.id::text, p.code, jsonb_build_object('stage', p.stage), jsonb_build_object('stage', p_stage),
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

-- Conversion : crée la fiche client (module Clients), rattache les devis du prospect, passe le prospect en « gagné »
create function public.prospect_convert(p_prospect uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype; v_client uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('prospects.write');
  perform private.require_perm('clients.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p.country is null then raise exception 'PROSPECT_COUNTRY_REQUIRED' using errcode = '22023'; end if;   -- champ obligatoire de la fiche client
  insert into public.clients (id, company_id, name, email, phone, country, sales_rep_id, notes)
  values (v_client, p.company_id, p.company_name, p.email, p.phone, p.country, p.owner_id, 'Converti depuis le prospect ' || p.code || coalesce(E'\n' || p.notes, ''));
  select code into v_code from public.clients where id = v_client;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set client_id = v_client, prospect_id = null where prospect_id = p_prospect;
  update public.prospects set stage = 'won', stage_changed_at = now(), converted_client_id = v_client where id = p_prospect;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.convert', 'prospect', p.id::text, p.code, null, jsonb_build_object('client_id', v_client),
    jsonb_build_object('client_code', v_code), 'rpc');
  return v_client;
end $$;

-- ---------------------------------------------------------------------
-- 9. Devis : envoi, réponse du client, duplication, transformation en commande
-- ---------------------------------------------------------------------
create function public.quote_send(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.quote_lines where quote_id = p_quote) then raise exception 'COMMERCIAL_EMPTY' using errcode = '55000'; end if;
  if q.valid_until < current_date then raise exception 'QUOTE_EXPIRED' using errcode = '55000'; end if;
  if q.client_id is not null then perform private.ged_assert_client_open(q.client_id); end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = 'sent', sent_at = now() where id = p_quote;
  -- un prospect avec un devis envoyé passe automatiquement à l'étape « proposition »
  if q.prospect_id is not null then
    update public.prospects set stage = 'proposal', stage_changed_at = now() where id = q.prospect_id and stage in ('new', 'contacted', 'qualified');
  end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.send', 'quote', q.id::text, q.code, null, null, jsonb_build_object('total', q.total), 'rpc');
end $$;

create function public.quote_decide(p_quote uuid, p_accept boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'sent' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if p_accept and q.valid_until < current_date then raise exception 'QUOTE_EXPIRED' using errcode = '55000'; end if;
  if not p_accept and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'QUOTE_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = case when p_accept then 'accepted' else 'rejected' end, decided_at = now(), decision_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_quote;
  if p_accept and q.prospect_id is not null then
    update public.prospects set stage = 'negotiation', stage_changed_at = now() where id = q.prospect_id and stage in ('new', 'contacted', 'qualified', 'proposal');
  end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, case when p_accept then 'quote.accept' else 'quote.reject' end, 'quote', q.id::text, q.code, null, null,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

create function public.quote_cancel(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status not in ('draft', 'sent', 'accepted') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = 'cancelled' where id = p_quote;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.cancel', 'quote', q.id::text, q.code, jsonb_build_object('status', q.status), null, '{}'::jsonb, 'rpc');
end $$;

-- Révision / copie : nouveau devis brouillon avec les mêmes lignes
create function public.quote_duplicate(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company();
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.quotes (id, company_id, client_id, prospect_id, currency, tax_rate, payment_terms, lead_days, notes)
  values (v_id, q.company_id, q.client_id, q.prospect_id, q.currency, q.tax_rate, q.payment_terms, q.lead_days, q.notes);
  insert into public.quote_lines (company_id, quote_id, pos, article_id, description, qty, unit_price, discount_pct)
  select company_id, v_id, pos, article_id, description, qty, unit_price, discount_pct from public.quote_lines where quote_id = p_quote order by pos;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.create', 'quote', v_id::text, (select code from public.quotes where id = v_id), null,
    jsonb_build_object('copy_of', q.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Devis accepté → commande (brouillon, à confirmer) ; prix, remises, TVA et délai repris
create function public.quote_to_order(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_order uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('quotes.write');
  perform private.require_perm('orders.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'accepted' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if q.client_id is null then raise exception 'QUOTE_PROSPECT_NOT_CONVERTED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(q.client_id);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.sales_orders (id, company_id, client_id, client_ref, quote_id, currency, tax_rate, payment_terms, notes)
  values (v_order, q.company_id, q.client_id, null, q.id, q.currency, q.tax_rate, q.payment_terms, 'Issue du devis ' || q.code || coalesce(E'\n' || q.notes, ''));
  insert into public.sales_order_lines (company_id, order_id, article_id, description, qty, unit_price, discount_pct, due_date)
  select company_id, v_order, article_id, description, qty, unit_price, discount_pct, current_date + q.lead_days from public.quote_lines where quote_id = p_quote order by pos;
  update public.quotes set status = 'converted', order_id = v_order where id = p_quote;
  perform set_config('commercial.rpc', 'off', true);
  select code into v_code from public.sales_orders where id = v_order;
  perform private.write_audit(q.company_id, 'quote.convert', 'quote', q.id::text, q.code, null, null, jsonb_build_object('order', v_code), 'rpc');
  return v_order;
end $$;

-- ---------------------------------------------------------------------
-- 10. Factures : création depuis une commande, émission (numéro sans trou), encaissements
-- ---------------------------------------------------------------------
-- p_lines (facultatif) : [{ "order_line_id": uuid, "qty": n }] ; sans argument : tout le reste à facturer
create function public.invoice_from_order(p_order uuid, p_lines jsonb default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_id uuid := gen_random_uuid(); l record; v_qty numeric; v_n int := 0; v_req jsonb;
begin
  perform private.require_perm('invoices.write');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('confirmed', 'delivered') then raise exception 'INVOICE_ORDER_NOT_CONFIRMED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(o.client_id);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoices (id, company_id, client_id, order_id, currency, tax_rate, payment_terms)
  values (v_id, o.company_id, o.client_id, p_order, o.currency, coalesce(o.tax_rate, private.client_tax_rate(o.client_id)), o.payment_terms);
  for l in select * from public.sales_order_lines where order_id = p_order and qty - qty_invoiced > 0 order by due_date, created_at, id loop
    v_qty := l.qty - l.qty_invoiced;
    if p_lines is not null then
      select e into v_req from jsonb_array_elements(p_lines) e where (e ->> 'order_line_id')::uuid = l.id limit 1;
      if v_req is null then continue; end if;
      v_qty := (v_req ->> 'qty')::numeric;
      if v_qty is null or v_qty <= 0 then continue; end if;
      if v_qty > l.qty - l.qty_invoiced then raise exception 'INVOICE_OVER_INVOICED' using errcode = '22023'; end if;
    end if;
    insert into public.invoice_lines (company_id, invoice_id, order_line_id, description, qty, unit_price, discount_pct)
    values (o.company_id, v_id, l.id, coalesce(l.description, 'Article'), v_qty, l.unit_price, l.discount_pct);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'INVOICE_NOTHING_TO_INVOICE' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'invoice.create', 'invoice', v_id::text, 'Brouillon', null, jsonb_build_object('order', o.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function private.invoice_recalc_status(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_status text; v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  select * into i from public.invoices where id = p_invoice;
  if i.status in ('draft', 'cancelled') then return; end if;
  v_status := case when i.credited_amount >= i.total then 'credited'
                   when i.total - i.credited_amount - i.paid_amount <= 0 then 'paid'
                   when i.paid_amount > 0 then 'partially_paid' else 'issued' end;
  perform set_config('commercial.rpc', 'on', true);
  update public.invoices set status = v_status, updated_at = now() where id = p_invoice;
  perform set_config('commercial.rpc', v_prev, true);
end $$;
revoke execute on function private.invoice_recalc_status(uuid) from public, anon, authenticated;

create function private.order_refresh_invoice_status(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_all boolean; v_any boolean; v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  select bool_and(qty_invoiced >= qty), bool_or(qty_invoiced > 0) into v_all, v_any from public.sales_order_lines where order_id = p_order;
  perform set_config('commercial.rpc', 'on', true);
  update public.sales_orders set invoice_status = case when v_all then 'full' when v_any then 'partial' else 'none' end where id = p_order;
  perform set_config('commercial.rpc', v_prev, true);
end $$;
revoke execute on function private.order_refresh_invoice_status(uuid) from public, anon, authenticated;

create function public.invoice_issue(p_invoice uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; l record; v_days int; v_code text; v_year text := extract(year from current_date)::text;
begin
  perform private.require_perm('invoices.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.invoice_lines where invoice_id = p_invoice) then raise exception 'COMMERCIAL_EMPTY' using errcode = '55000'; end if;
  if i.total <= 0 then raise exception 'INVOICE_ZERO_TOTAL' using errcode = '55000'; end if;
  for l in select il.*, ol.qty as o_qty, ol.qty_invoiced as o_inv from public.invoice_lines il left join public.sales_order_lines ol on ol.id = il.order_line_id where il.invoice_id = p_invoice for update of il loop
    if l.order_line_id is not null and l.qty > l.o_qty - l.o_inv then raise exception 'INVOICE_OVER_INVOICED' using errcode = '22023'; end if;
  end loop;
  select coalesce(t.days, 30) into v_days from public.clients c left join public.payment_terms t on t.id = c.payment_terms_id where c.id = i.client_id;
  v_code := 'FAC-' || v_year || '-' || lpad(private.next_seq(i.company_id, 'invoice-' || v_year)::text, 4, '0');
  perform set_config('commercial.rpc', 'on', true);
  update public.sales_order_lines ol set qty_invoiced = ol.qty_invoiced + il.qty from public.invoice_lines il where il.invoice_id = p_invoice and il.order_line_id = ol.id;
  update public.invoices set status = 'issued', code = v_code, issue_date = current_date, due_date = current_date + coalesce(v_days, 30), issued_at = now(), issued_by = auth.uid() where id = p_invoice;
  if i.order_id is not null then perform private.order_refresh_invoice_status(i.order_id); end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'invoice.issue', 'invoice', i.id::text, v_code, null, null, jsonb_build_object('total', i.total, 'client_id', i.client_id), 'rpc');
  return v_code;
end $$;

create function public.invoice_cancel(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype;
begin
  perform private.require_perm('invoices.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'INVOICE_CANCEL_ISSUED' using errcode = '55000'; end if;      -- une facture émise se corrige par un avoir
  perform set_config('commercial.rpc', 'on', true);
  update public.invoices set status = 'cancelled' where id = p_invoice;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'invoice.cancel', 'invoice', i.id::text, 'Brouillon', null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.invoice_record_payment(p_invoice uuid, p_amount numeric, p_paid_on date default null, p_method text default 'transfer', p_reference text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_balance numeric;
begin
  perform private.require_perm('payments.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('issued', 'partially_paid') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVOICE_BAD_AMOUNT' using errcode = '22023'; end if;
  v_balance := i.total - i.credited_amount - i.paid_amount;
  if p_amount > v_balance then raise exception 'INVOICE_OVERPAYMENT' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.invoice_payments (company_id, invoice_id, amount, paid_on, method, reference, created_by)
  values (i.company_id, p_invoice, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'transfer'), nullif(btrim(coalesce(p_reference, '')), ''), auth.uid());
  update public.invoices set paid_amount = paid_amount + p_amount where id = p_invoice;
  perform private.invoice_recalc_status(p_invoice);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'invoice.payment', 'invoice', i.id::text, i.code, null, jsonb_build_object('amount', p_amount), jsonb_build_object('method', p_method, 'reference', p_reference), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 11. Avoirs
-- ---------------------------------------------------------------------
create function public.credit_note_create(p_invoice uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.invoices%rowtype; v_id uuid := gen_random_uuid(); v_n int;
begin
  perform private.require_perm('invoices.write');
  select * into i from public.invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status not in ('issued', 'partially_paid', 'paid') then raise exception 'CREDIT_BAD_INVOICE' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'CREDIT_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.credit_notes (id, company_id, invoice_id, client_id, reason, currency, tax_rate) values (v_id, i.company_id, p_invoice, i.client_id, btrim(p_reason), i.currency, i.tax_rate);
  insert into public.credit_note_lines (company_id, credit_note_id, invoice_line_id, pos, description, qty, unit_price, discount_pct)
  select company_id, v_id, id, pos, description, qty - qty_credited, unit_price, discount_pct from public.invoice_lines where invoice_id = p_invoice and qty - qty_credited > 0 order by pos;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'CREDIT_NOTHING_TO_CREDIT' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'credit_note.create', 'credit_note', v_id::text, 'Brouillon', null, jsonb_build_object('invoice', i.code), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

create function public.credit_note_issue(p_credit_note uuid, p_reopen boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare n public.credit_notes%rowtype; i public.invoices%rowtype; l record; v_code text; v_year text := extract(year from current_date)::text; v_new_credit numeric;
begin
  perform private.require_perm('invoices.write');
  select * into n from public.credit_notes where id = p_credit_note and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  select * into i from public.invoices where id = n.invoice_id for update;
  if not exists (select 1 from public.credit_note_lines where credit_note_id = p_credit_note) then raise exception 'COMMERCIAL_EMPTY' using errcode = 'P0002'; end if;
  if n.total <= 0 then raise exception 'INVOICE_ZERO_TOTAL' using errcode = '55000'; end if;
  for l in select cl.*, il.qty as i_qty, il.qty_credited as i_cred from public.credit_note_lines cl join public.invoice_lines il on il.id = cl.invoice_line_id where cl.credit_note_id = p_credit_note loop
    if l.qty > l.i_qty - l.i_cred then raise exception 'CREDIT_OVER_CREDIT' using errcode = '22023'; end if;
  end loop;
  v_code := 'AV-' || v_year || '-' || lpad(private.next_seq(n.company_id, 'credit-' || v_year)::text, 4, '0');
  perform set_config('commercial.rpc', 'on', true);
  update public.invoice_lines il set qty_credited = il.qty_credited + cl.qty from public.credit_note_lines cl where cl.credit_note_id = p_credit_note and cl.invoice_line_id = il.id;
  if p_reopen then
    update public.sales_order_lines ol set qty_invoiced = greatest(0, ol.qty_invoiced - cl.qty)
    from public.credit_note_lines cl join public.invoice_lines il on il.id = cl.invoice_line_id
    where cl.credit_note_id = p_credit_note and il.order_line_id = ol.id;
    if i.order_id is not null then perform private.order_refresh_invoice_status(i.order_id); end if;
  end if;
  update public.credit_notes set status = 'issued', code = v_code, issue_date = current_date, issued_at = now(), issued_by = auth.uid(), reopen_order = p_reopen where id = p_credit_note;
  v_new_credit := n.total;
  update public.invoices set credited_amount = credited_amount + v_new_credit where id = i.id;
  perform private.invoice_recalc_status(i.id);
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(n.company_id, 'credit_note.issue', 'credit_note', n.id::text, v_code, null, null,
    jsonb_build_object('invoice', i.code, 'total', n.total, 'reopen_order', p_reopen), 'rpc');
  return v_code;
end $$;

create function public.credit_note_cancel(p_credit_note uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.credit_notes%rowtype;
begin
  perform private.require_perm('invoices.write');
  select * into n from public.credit_notes where id = p_credit_note and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if n.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.credit_notes set status = 'cancelled' where id = p_credit_note;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(n.company_id, 'credit_note.cancel', 'credit_note', n.id::text, 'Brouillon', null, null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 12. Tableau de bord commercial (chaque bloc n'est renvoyé qu'avec le droit de lecture correspondant)
-- ---------------------------------------------------------------------
create function public.commercial_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_res jsonb := '{}'::jsonb; v_any boolean := false;
begin
  if private.has_perm('prospects.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('prospects', jsonb_build_object(
      'open_count', (select count(*) from public.prospects where company_id = v_co and stage not in ('won', 'lost')),
      'open_value', (select coalesce(sum(est_value), 0) from public.prospects where company_id = v_co and stage not in ('won', 'lost')),
      'weighted_value', (select coalesce(round(sum(est_value * case stage when 'new' then 0.1 when 'contacted' then 0.2 when 'qualified' then 0.4 when 'proposal' then 0.6 when 'negotiation' then 0.8 else 0 end), 2), 0)
                         from public.prospects where company_id = v_co and stage not in ('won', 'lost')),
      'overdue_actions', (select count(*) from public.prospects where company_id = v_co and stage not in ('won', 'lost') and next_action_date is not null and next_action_date < current_date),
      'won_90d', (select count(*) from public.prospects where company_id = v_co and stage = 'won' and stage_changed_at > now() - interval '90 days'),
      'lost_90d', (select count(*) from public.prospects where company_id = v_co and stage = 'lost' and stage_changed_at > now() - interval '90 days'),
      'by_stage', coalesce((select jsonb_agg(jsonb_build_object('stage', s.stage, 'count', coalesce(x.n, 0), 'value', coalesce(x.v, 0)) order by s.ord)
                  from (values ('new', 1), ('contacted', 2), ('qualified', 3), ('proposal', 4), ('negotiation', 5)) s(stage, ord)
                  left join (select stage, count(*) n, sum(est_value) v from public.prospects where company_id = v_co group by stage) x on x.stage = s.stage), '[]'::jsonb)));
  end if;
  if private.has_perm('quotes.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('quotes', jsonb_build_object(
      'draft_count', (select count(*) from public.quotes where company_id = v_co and status = 'draft'),
      'sent_count', (select count(*) from public.quotes where company_id = v_co and status = 'sent'),
      'sent_value', (select coalesce(sum(subtotal), 0) from public.quotes where company_id = v_co and status = 'sent'),
      'expiring_7d', (select count(*) from public.quotes where company_id = v_co and status = 'sent' and valid_until between current_date and current_date + 7),
      'expired', (select count(*) from public.quotes where company_id = v_co and status = 'sent' and valid_until < current_date),
      'won_90d_value', (select coalesce(sum(subtotal), 0) from public.quotes where company_id = v_co and status in ('accepted', 'converted') and decided_at > now() - interval '90 days'),
      'conversion_rate', (select case when count(*) filter (where status in ('accepted', 'converted', 'rejected')) = 0 then null
                           else round(100.0 * count(*) filter (where status in ('accepted', 'converted')) / count(*) filter (where status in ('accepted', 'converted', 'rejected')), 1) end
                          from public.quotes where company_id = v_co and decided_at > now() - interval '90 days')));
  end if;
  if private.has_perm('orders.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('orders', jsonb_build_object(
      'to_confirm', (select count(*) from public.sales_orders where company_id = v_co and status = 'draft'),
      'open_count', (select count(*) from public.sales_orders where company_id = v_co and status = 'confirmed'),
      'to_invoice_count', (select count(*) from public.sales_orders where company_id = v_co and status in ('confirmed', 'delivered') and invoice_status <> 'full'),
      'to_invoice_value', (select coalesce(sum(round(l.qty_rem * l.unit_price * (1 - l.discount_pct / 100), 2)), 0)
                           from (select ol.*, (ol.qty - ol.qty_invoiced) as qty_rem from public.sales_order_lines ol join public.sales_orders so on so.id = ol.order_id
                                 where so.company_id = v_co and so.status in ('confirmed', 'delivered')) l)));
  end if;
  if private.has_perm('invoices.read') then
    v_any := true;
    v_res := v_res || jsonb_build_object('invoices', jsonb_build_object(
      'invoiced_month', (select coalesce(sum(subtotal), 0) from public.invoices where company_id = v_co and issue_date >= date_trunc('month', current_date) and status not in ('draft', 'cancelled'))
                        - (select coalesce(sum(subtotal), 0) from public.credit_notes where company_id = v_co and status = 'issued' and issue_date >= date_trunc('month', current_date)),
      'invoiced_year', (select coalesce(sum(subtotal), 0) from public.invoices where company_id = v_co and issue_date >= date_trunc('year', current_date) and status not in ('draft', 'cancelled'))
                        - (select coalesce(sum(subtotal), 0) from public.credit_notes where company_id = v_co and status = 'issued' and issue_date >= date_trunc('year', current_date)),
      'collected_month', (select coalesce(sum(amount), 0) from public.invoice_payments where company_id = v_co and paid_on >= date_trunc('month', current_date)),
      'outstanding', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid')),
      'overdue_count', (select count(*) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid') and due_date < current_date),
      'overdue_amount', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid') and due_date < current_date),
      'drafts', (select count(*) from public.invoices where company_id = v_co and status = 'draft'),
      'credit_notes_year', (select coalesce(sum(total), 0) from public.credit_notes where company_id = v_co and status = 'issued' and issue_date >= date_trunc('year', current_date)),
      'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m.month, 'amount', coalesce(x.a, 0)) order by m.month)
                  from (select to_char(date_trunc('month', current_date) - (g || ' month')::interval, 'YYYY-MM') as month from generate_series(0, 11) g) m
                  left join (select to_char(date_trunc('month', issue_date), 'YYYY-MM') as month, sum(subtotal) a from public.invoices
                             where company_id = v_co and status not in ('draft', 'cancelled') group by 1) x on x.month = m.month), '[]'::jsonb),
      'top_clients', coalesce((select jsonb_agg(t) from (select jsonb_build_object('client_id', c.id, 'name', c.name, 'amount', sum(i.subtotal)) t
                  from public.invoices i join public.clients c on c.id = i.client_id
                  where i.company_id = v_co and i.status not in ('draft', 'cancelled') and i.issue_date >= date_trunc('year', current_date) group by c.id, c.name order by sum(i.subtotal) desc limit 5) q), '[]'::jsonb)));
  end if;
  if not v_any then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 13. Historique, RLS, privilèges
-- ---------------------------------------------------------------------
create function private.audit_commercial_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.commercial_rpc() then return new; end if;
  if tg_table_name = 'prospects' then
    perform private.write_audit(new.company_id, 'prospect.create', 'prospect', new.id::text, new.code, null, jsonb_build_object('company_name', new.company_name, 'est_value', new.est_value));
  elsif tg_table_name = 'quotes' then
    perform private.write_audit(new.company_id, 'quote.create', 'quote', new.id::text, new.code, null, jsonb_build_object('code', new.code));
  elsif tg_table_name = 'invoices' then
    perform private.write_audit(new.company_id, 'invoice.create', 'invoice', new.id::text, 'Brouillon', null, jsonb_build_object('client_id', new.client_id));
  end if;
  return new;
end $$;
create trigger audit_prospects_i after insert on public.prospects for each row execute function private.audit_commercial_insert();
create trigger audit_quotes_i after insert on public.quotes for each row execute function private.audit_commercial_insert();
create trigger audit_invoices_i after insert on public.invoices for each row execute function private.audit_commercial_insert();

create policy audit_logs_select_commercial on public.audit_logs for select to authenticated
  using (company_id = private.current_company() and (
       (entity_type = 'prospect' and private.has_perm('prospects.read'))
    or (entity_type = 'quote' and private.has_perm('quotes.read'))
    or (entity_type in ('invoice', 'credit_note') and private.has_perm('invoices.read'))));

alter table public.prospects enable row level security;
alter table public.prospect_activities enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_lines enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_payments enable row level security;
alter table public.credit_notes enable row level security;
alter table public.credit_note_lines enable row level security;

revoke all on public.prospects, public.prospect_activities, public.quotes, public.quote_lines, public.invoices, public.invoice_lines,
              public.invoice_payments, public.credit_notes, public.credit_note_lines from anon, authenticated;
grant all on public.prospects, public.prospect_activities, public.quotes, public.quote_lines, public.invoices, public.invoice_lines,
             public.invoice_payments, public.credit_notes, public.credit_note_lines to service_role;
grant select on public.prospects, public.prospect_activities, public.quotes, public.quote_lines, public.invoices, public.invoice_lines,
                public.invoice_payments, public.credit_notes, public.credit_note_lines to authenticated;

grant insert (company_name, contact_name, email, phone, country, city, source, est_value, expected_close, owner_id, next_action, next_action_date, notes) on public.prospects to authenticated;
grant update (company_name, contact_name, email, phone, country, city, source, est_value, expected_close, owner_id, next_action, next_action_date, notes) on public.prospects to authenticated;
grant insert (prospect_id, kind, summary, happened_at) on public.prospect_activities to authenticated;
grant insert (client_id, prospect_id, valid_until, currency, tax_rate, payment_terms, lead_days, notes) on public.quotes to authenticated;
grant update (valid_until, currency, tax_rate, payment_terms, lead_days, notes) on public.quotes to authenticated;
grant insert (quote_id, article_id, description, qty, unit_price, discount_pct) on public.quote_lines to authenticated;
grant update (description, qty, unit_price, discount_pct) on public.quote_lines to authenticated;
grant delete on public.quote_lines to authenticated;

-- commandes : on étend les colonnes écrivables (prix, TVA, conditions) ; le reste (statut, totaux, facturation) reste réservé aux fonctions
grant insert (currency, tax_rate, payment_terms) on public.sales_orders to authenticated;
grant update (tax_rate, payment_terms) on public.sales_orders to authenticated;
grant insert (description, unit_price, discount_pct) on public.sales_order_lines to authenticated;
grant update (description, unit_price, discount_pct) on public.sales_order_lines to authenticated;

grant insert (client_id, tax_rate, payment_terms, notes) on public.invoices to authenticated;
grant update (tax_rate, payment_terms, notes) on public.invoices to authenticated;
grant insert (invoice_id, description, qty, unit_price, discount_pct) on public.invoice_lines to authenticated;
grant update (description, qty, unit_price, discount_pct) on public.invoice_lines to authenticated;
grant delete on public.invoice_lines to authenticated;
grant update (qty) on public.credit_note_lines to authenticated;
grant delete on public.credit_note_lines to authenticated;

do $$
declare t text; rd text;
begin
  for t, rd in select * from (values ('prospects', 'prospects.read'), ('prospect_activities', 'prospects.read'), ('quotes', 'quotes.read'), ('quote_lines', 'quotes.read'),
      ('invoices', 'invoices.read'), ('invoice_lines', 'invoices.read'), ('credit_notes', 'invoices.read'), ('credit_note_lines', 'invoices.read'), ('invoice_payments', 'payments.read')) v(a, b) loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_select', t, rd);
  end loop;
  for t, rd in select * from (values ('prospects', 'prospects.write'), ('quotes', 'quotes.write'), ('quote_lines', 'quotes.write'), ('invoices', 'invoices.write'), ('invoice_lines', 'invoices.write')) v(a, b) loop
    execute format($f$create policy %I on public.%I for insert to authenticated with check (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_insert', t, rd);
    execute format($f$create policy %I on public.%I for update to authenticated using (company_id = private.current_company() and private.has_perm(%L)) with check (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_update', t, rd, rd);
  end loop;
  for t, rd in select * from (values ('quote_lines', 'quotes.write'), ('invoice_lines', 'invoices.write'), ('credit_note_lines', 'invoices.write')) v(a, b) loop
    execute format($f$create policy %I on public.%I for delete to authenticated using (company_id = private.current_company() and private.has_perm(%L))$f$, t || '_delete', t, rd);
  end loop;
end $$;
create policy prospect_activities_insert on public.prospect_activities for insert to authenticated with check (company_id = private.current_company() and private.has_perm('prospects.write'));
create policy credit_note_lines_update on public.credit_note_lines for update to authenticated
  using (company_id = private.current_company() and private.has_perm('invoices.write')) with check (company_id = private.current_company() and private.has_perm('invoices.write'));

do $$
declare f text;
begin
  foreach f in array array['prospect_set_stage(uuid,text,text)', 'prospect_convert(uuid)', 'quote_send(uuid)', 'quote_decide(uuid,boolean,text)', 'quote_cancel(uuid)',
      'quote_duplicate(uuid)', 'quote_to_order(uuid)', 'invoice_from_order(uuid,jsonb)', 'invoice_issue(uuid)', 'invoice_cancel(uuid)',
      'invoice_record_payment(uuid,numeric,date,text,text)', 'credit_note_create(uuid,text)', 'credit_note_issue(uuid,boolean)', 'credit_note_cancel(uuid)', 'commercial_dashboard()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
