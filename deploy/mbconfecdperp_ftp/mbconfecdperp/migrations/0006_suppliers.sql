-- =====================================================================
-- 0006_suppliers — Module Fournisseurs
--  fiche fournisseur (paiement, délai, incoterm, acheteur référent), contacts,
--  documents (Storage), commandes d'achat minimales (historique + statistiques),
--  archivage, historique (audit_logs, entity_type = 'supplier').
--  Permissions : suppliers.read / suppliers.write / suppliers.delete (nouveau)
--  Le module Achats (à venir) enrichira purchase_orders (lignes, réceptions…).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission d'archivage / suppression
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('suppliers.delete', 'purchases', 'Archiver les fournisseurs', 'Archiver, restaurer, supprimer définitivement un fournisseur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'suppliers.delete'
where r.is_system and r.code in ('admin', 'direction')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.suppliers (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  code                text not null,
  name                text not null check (length(btrim(name)) between 2 and 120),
  legal_name          text,
  category            text not null default 'other' check (category in ('fabric','accessories','packaging','subcontracting','services','other')),
  qualification       text not null default 'pending' check (qualification in ('pending','approved','blocked')),
  rating              smallint check (rating is null or rating between 1 and 5),
  tax_id              text,
  registration_no     text,
  website             text,
  email               text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone               text,
  address_line1       text,
  address_line2       text,
  postal_code         text,
  city                text,
  region              text,
  country             char(2) not null check (country ~ '^[A-Z]{2}$'),
  currency            char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  language            text not null default 'fr' check (language in ('fr','en','de','es','it','nl')),
  payment_terms_id    uuid references public.payment_terms(id),
  payment_method      text check (payment_method in ('transfer','cheque','lc','cash','other')),
  lead_time_days      int check (lead_time_days is null or lead_time_days between 0 and 365),
  min_order_amount    numeric(15,3) check (min_order_amount is null or min_order_amount >= 0),
  incoterm            text check (incoterm is null or incoterm in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  incoterm_place      text,
  buyer_id            uuid references public.profiles(id) on delete set null,
  notes               text,
  archived_at         timestamptz,
  archived_by         uuid,
  archive_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  unique (company_id, code)
);
create unique index suppliers_tax_id_uq on public.suppliers (company_id, lower(btrim(tax_id))) where tax_id is not null and btrim(tax_id) <> '';
create unique index suppliers_name_active_uq on public.suppliers (company_id, lower(btrim(name))) where archived_at is null;
create index suppliers_company_idx on public.suppliers (company_id, archived_at);
create index suppliers_buyer_idx   on public.suppliers (buyer_id);

create table public.supplier_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) >= 2),
  job_title   text,
  email       text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone       text,
  mobile      text,
  language    text check (language is null or language in ('fr','en','de','es','it','nl')),
  is_primary  boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);
create index supplier_contacts_idx on public.supplier_contacts (supplier_id);
create unique index supplier_contacts_primary_uq on public.supplier_contacts (supplier_id) where is_primary;

create table public.supplier_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  supplier_id  uuid not null references public.suppliers(id) on delete cascade,
  title        text not null check (length(btrim(title)) >= 2),
  doc_type     text not null check (doc_type in ('contract','price_list','certificate','quality_agreement','nda','tax','identification','other')),
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0 and size_bytes <= 10485760),
  storage_path text not null unique,
  valid_until  date,
  notes        text,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index supplier_documents_idx on public.supplier_documents (supplier_id);

-- Commandes d'achat : version minimale (en-tête). Le module Achats ajoutera lignes, réceptions, workflow.
create table public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  supplier_id   uuid not null references public.suppliers(id),     -- RESTRICT : un fournisseur commandé ne peut être supprimé
  po_no         text not null,
  status        text not null default 'draft' check (status in ('draft','sent','partial','received','cancelled')),
  order_date    date not null default current_date,
  expected_date date,
  received_date date,
  currency      char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  total_amount  numeric(15,3) not null default 0 check (total_amount >= 0),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  unique (company_id, po_no)
);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id, order_date desc);

-- ---------------------------------------------------------------------
-- 3. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.suppliers_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if new.company_id is null then raise exception 'SUPPLIER_NO_COMPANY' using errcode = '22023'; end if;
    if nullif(btrim(coalesce(new.code, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'supplier');
      new.code := 'FOU-' || lpad(v_n::text, 4, '0');
    else
      new.code := upper(btrim(new.code));
    end if;
    if new.code !~ '^[A-Z0-9][A-Z0-9_-]{1,19}$' then raise exception 'SUPPLIER_INVALID_CODE' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;
  else
    if new.code is distinct from old.code or new.company_id is distinct from old.company_id then
      raise exception 'SUPPLIER_CODE_LOCKED' using errcode = '42501';
    end if;
    if old.archived_at is not null and new.archived_at is not null then
      raise exception 'SUPPLIER_ARCHIVED' using errcode = '55000';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.name := btrim(new.name); new.country := upper(new.country); new.currency := upper(new.currency);
  new.email := nullif(btrim(coalesce(new.email, '')), '');

  if new.buyer_id is not null and (tg_op = 'INSERT' or new.buyer_id is distinct from old.buyer_id) then
    if not exists (select 1 from public.profiles p where p.id = new.buyer_id and p.company_id = new.company_id and p.is_active) then
      raise exception 'SUPPLIER_INVALID_BUYER' using errcode = '22023';
    end if;
  end if;
  if new.payment_terms_id is not null and (tg_op = 'INSERT' or new.payment_terms_id is distinct from old.payment_terms_id) then
    if not exists (select 1 from public.payment_terms t where t.id = new.payment_terms_id and t.company_id = new.company_id and t.is_active) then
      raise exception 'SUPPLIER_INVALID_TERMS' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger suppliers_before_iu before insert or update on public.suppliers
  for each row execute function private.suppliers_before();

create function private.supplier_assert_open(p_supplier uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v public.suppliers%rowtype;
begin
  select * into v from public.suppliers where id = p_supplier;
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'SUPPLIER_ARCHIVED' using errcode = '55000'; end if;
end $$;
revoke execute on function private.supplier_assert_open(uuid) from public, anon, authenticated;

create function private.supplier_contacts_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.supplier_assert_open(new.supplier_id);
  select company_id into new.company_id from public.suppliers where id = new.supplier_id;
  if tg_op = 'UPDATE' and new.supplier_id is distinct from old.supplier_id then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  new.full_name := btrim(new.full_name);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.supplier_contacts where supplier_id = new.supplier_id) then new.is_primary := true; end if;
  else
    new.updated_at := now();
  end if;
  new.updated_by := auth.uid();
  if new.is_primary then
    update public.supplier_contacts set is_primary = false where supplier_id = new.supplier_id and id is distinct from new.id and is_primary;
  end if;
  return new;
end $$;
create trigger supplier_contacts_before_iu before insert or update on public.supplier_contacts
  for each row execute function private.supplier_contacts_before();

create function private.supplier_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.supplier_assert_open(new.supplier_id);
  select company_id into new.company_id from public.suppliers where id = new.supplier_id;
  if tg_op = 'INSERT' then
    if new.storage_path not like new.company_id::text || '/' || new.supplier_id::text || '/%' then
      raise exception 'SUPPLIER_INVALID_PATH' using errcode = '22023';
    end if;
    new.uploaded_by := auth.uid();
  else
    if new.storage_path is distinct from old.storage_path or new.supplier_id is distinct from old.supplier_id then
      raise exception 'SUPPLIER_INVALID_PATH' using errcode = '22023';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger supplier_documents_before_iu before insert or update on public.supplier_documents
  for each row execute function private.supplier_documents_before();

create function private.purchase_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    perform private.supplier_assert_open(new.supplier_id);
    select company_id into new.company_id from public.suppliers where id = new.supplier_id;
    if nullif(btrim(coalesce(new.po_no, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'po-' || extract(year from current_date)::text);
      new.po_no := 'PO-' || extract(year from current_date)::text || '-' || lpad(v_n::text, 5, '0');
    end if;
    new.created_by := auth.uid();
  else
    if new.supplier_id is distinct from old.supplier_id or new.company_id is distinct from old.company_id then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
    end if;
    new.updated_at := now();
  end if;
  if new.status = 'received' and new.received_date is null then new.received_date := current_date; end if;
  return new;
end $$;
create trigger purchase_orders_before_iu before insert or update on public.purchase_orders
  for each row execute function private.purchase_orders_before();

-- ---------------------------------------------------------------------
-- 4. Historique (audit_logs, entity_type = 'supplier')
-- ---------------------------------------------------------------------
create function private.audit_suppliers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','archived_at','archived_by','archive_reason'];
  v_chg jsonb;
begin
  if coalesce(current_setting('suppliers.rpc', true), 'off') = 'on' and tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'supplier.create', 'supplier', new.id::text, new.name, null, to_jsonb(new) - c_noise);
  elsif tg_op = 'UPDATE' then
    if old.archived_at is null and new.archived_at is not null then
      perform private.write_audit(new.company_id, 'supplier.archive', 'supplier', new.id::text, new.name, null, null, jsonb_build_object('reason', new.archive_reason));
    elsif old.archived_at is not null and new.archived_at is null then
      perform private.write_audit(new.company_id, 'supplier.restore', 'supplier', new.id::text, new.name, null, null);
    else
      v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
      if v_chg -> 'after' <> '{}'::jsonb then
        perform private.write_audit(new.company_id, 'supplier.update', 'supplier', new.id::text, new.name, v_chg -> 'before', v_chg -> 'after');
      end if;
    end if;
  else
    perform private.write_audit(old.company_id, 'supplier.delete', 'supplier', old.id::text, old.name, to_jsonb(old) - c_noise, null);
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_suppliers_iud after insert or update or delete on public.suppliers
  for each row execute function private.audit_suppliers();

create function private.audit_supplier_child() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','uploaded_by','storage_path'];
  v_kind  text := tg_argv[0];
  v_label text := tg_argv[1];
  v_j     jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_sup   uuid := (v_j ->> 'supplier_id')::uuid;
  v_name  text;
  v_chg   jsonb;
  v_act   text := 'supplier.' || v_kind || '_' || case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  v_meta  jsonb := jsonb_build_object(v_kind, v_j ->> v_label);
begin
  if coalesce(current_setting('suppliers.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  select name into v_name from public.suppliers where id = v_sup;
  if tg_op = 'INSERT' then
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'supplier', v_sup::text, v_name, null, v_j - c_noise, v_meta);
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'supplier', v_sup::text, v_name, v_chg -> 'before', v_chg -> 'after', v_meta);
    end if;
  else
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'supplier', v_sup::text, v_name, v_j - c_noise, null, v_meta);
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_supplier_contacts_iud  after insert or update or delete on public.supplier_contacts
  for each row execute function private.audit_supplier_child('contact', 'full_name');
create trigger audit_supplier_documents_iud after insert or update or delete on public.supplier_documents
  for each row execute function private.audit_supplier_child('document', 'title');

create policy audit_logs_select_suppliers on public.audit_logs for select to authenticated
  using (entity_type = 'supplier' and company_id = private.current_company() and private.has_perm('suppliers.read'));

-- ---------------------------------------------------------------------
-- 5. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.suppliers          enable row level security;
alter table public.supplier_contacts  enable row level security;
alter table public.supplier_documents enable row level security;
alter table public.purchase_orders    enable row level security;

revoke all on public.suppliers, public.supplier_contacts, public.supplier_documents, public.purchase_orders from anon, authenticated;
grant all on public.suppliers, public.supplier_contacts, public.supplier_documents, public.purchase_orders to service_role;
grant select on public.suppliers, public.supplier_contacts, public.supplier_documents, public.purchase_orders to authenticated;

grant insert (code, name, legal_name, category, qualification, rating, tax_id, registration_no, website, email, phone,
              address_line1, address_line2, postal_code, city, region, country, currency, language, payment_terms_id,
              payment_method, lead_time_days, min_order_amount, incoterm, incoterm_place, buyer_id, notes) on public.suppliers to authenticated;
grant update (name, legal_name, category, qualification, rating, tax_id, registration_no, website, email, phone,
              address_line1, address_line2, postal_code, city, region, country, currency, language, payment_terms_id,
              payment_method, lead_time_days, min_order_amount, incoterm, incoterm_place, buyer_id, notes) on public.suppliers to authenticated;
grant insert (supplier_id, full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.supplier_contacts to authenticated;
grant update (full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.supplier_contacts to authenticated;
grant delete on public.supplier_contacts to authenticated;
grant insert (supplier_id, title, doc_type, file_name, mime_type, size_bytes, storage_path, valid_until, notes) on public.supplier_documents to authenticated;
grant update (title, doc_type, valid_until, notes) on public.supplier_documents to authenticated;
grant delete on public.supplier_documents to authenticated;
grant insert (supplier_id, po_no, status, order_date, expected_date, received_date, currency, total_amount, notes) on public.purchase_orders to authenticated;
grant update (status, order_date, expected_date, received_date, currency, total_amount, notes) on public.purchase_orders to authenticated;

create policy suppliers_select on public.suppliers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('suppliers.read'));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('suppliers.write'));
create policy suppliers_update on public.suppliers for update to authenticated
  using (company_id = private.current_company() and private.has_perm('suppliers.write'))
  with check (company_id = private.current_company() and private.has_perm('suppliers.write'));

do $$
declare t text;
begin
  foreach t in array array['supplier_contacts','supplier_documents'] loop
    execute format($f$create policy %1$s_select on public.%1$s for select to authenticated
      using (company_id = private.current_company() and private.has_perm('suppliers.read'))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (company_id = private.current_company() and private.has_perm('suppliers.write'))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$s for update to authenticated
      using (company_id = private.current_company() and private.has_perm('suppliers.write'))
      with check (company_id = private.current_company() and private.has_perm('suppliers.write'))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$s for delete to authenticated
      using (company_id = private.current_company() and private.has_perm('suppliers.write'))$f$, t);
  end loop;
end $$;

-- Commandes d'achat : lecture avec purchases.read, écriture avec purchases.write (le module Achats les pilotera)
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy purchase_orders_insert on public.purchase_orders for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('purchases.write'));
create policy purchase_orders_update on public.purchase_orders for update to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.write'))
  with check (company_id = private.current_company() and private.has_perm('purchases.write'));

-- ---------------------------------------------------------------------
-- 6. RPC : acheteurs affectables, archivage, restauration, suppression, statistiques
-- ---------------------------------------------------------------------
create function public.supplier_buyers() returns table (id uuid, full_name text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('suppliers.read');
  return query
    select distinct p.id, p.full_name, p.email
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id and pe.code = 'suppliers.write'
    where p.company_id = private.current_company() and p.is_active
    order by p.full_name;
end $$;

create function public.supplier_archive(p_supplier uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.suppliers%rowtype;
begin
  perform private.require_perm('suppliers.delete');
  select * into v from public.suppliers where id = p_supplier and company_id = private.current_company();
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'SUPPLIER_ARCHIVED' using errcode = '55000'; end if;
  update public.suppliers set archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_supplier;
end $$;

create function public.supplier_restore(p_supplier uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.suppliers%rowtype;
begin
  perform private.require_perm('suppliers.delete');
  select * into v from public.suppliers where id = p_supplier and company_id = private.current_company();
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'SUPPLIER_NOT_ARCHIVED' using errcode = '55000'; end if;
  update public.suppliers set archived_at = null, archived_by = null, archive_reason = null where id = p_supplier;
end $$;

-- Suppression définitive : fournisseur archivé et jamais commandé. Renvoie les fichiers à effacer du Storage.
create function public.supplier_delete(p_supplier uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.suppliers%rowtype; v_contacts int; v_files jsonb;
begin
  perform private.require_perm('suppliers.delete');
  select * into v from public.suppliers where id = p_supplier and company_id = private.current_company();
  if not found then raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'SUPPLIER_NOT_ARCHIVED' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_orders where supplier_id = p_supplier) then
    raise exception 'SUPPLIER_IN_USE' using errcode = '23503';
  end if;
  select count(*) into v_contacts from public.supplier_contacts where supplier_id = p_supplier;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', 'supplier-docs', 'path', storage_path)), '[]'::jsonb) into v_files
  from public.supplier_documents where supplier_id = p_supplier;

  perform set_config('suppliers.rpc', 'on', true);
  delete from public.suppliers where id = p_supplier;
  perform set_config('suppliers.rpc', 'off', true);

  perform private.write_audit(v.company_id, 'supplier.delete', 'supplier', v.id::text, v.name,
    to_jsonb(v) - array['company_id','created_at','updated_at','created_by','updated_by'], null,
    jsonb_build_object('contacts', v_contacts, 'documents', jsonb_array_length(v_files)), 'rpc');
  return v_files;
end $$;

-- Statistiques d'achats (montants dans la devise de chaque commande ; commandes annulées exclues)
create function public.supplier_purchase_stats(p_supplier uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform private.require_perm('purchases.read');
  if not exists (select 1 from public.suppliers where id = p_supplier and company_id = private.current_company()) then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'orders_count',  count(*) filter (where status <> 'cancelled'),
    'open_orders',   count(*) filter (where status in ('draft','sent','partial')),
    'cancelled',     count(*) filter (where status = 'cancelled'),
    'total_amount',  coalesce(sum(total_amount) filter (where status <> 'cancelled'), 0),
    'avg_order',     coalesce(round(avg(total_amount) filter (where status <> 'cancelled'), 3), 0),
    'last_order',    max(order_date) filter (where status <> 'cancelled'),
    'received_count', count(*) filter (where status = 'received'),
    'on_time_rate',  case when count(*) filter (where status = 'received' and expected_date is not null) = 0 then null
                     else round(100.0 * count(*) filter (where status = 'received' and expected_date is not null and received_date <= expected_date)
                                / count(*) filter (where status = 'received' and expected_date is not null), 1) end,
    'avg_lead_days', round(avg(received_date - order_date) filter (where status = 'received' and received_date is not null), 1),
    'late_open',     count(*) filter (where status in ('sent','partial') and expected_date is not null and expected_date < current_date),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'amount', coalesce(x.amount, 0), 'count', coalesce(x.n, 0)) order by m.month)
      from (select to_char(date_trunc('month', current_date) - (g || ' month')::interval, 'YYYY-MM') as month from generate_series(0, 11) g) m
      left join (select to_char(date_trunc('month', order_date), 'YYYY-MM') as month, sum(total_amount) as amount, count(*) as n
                 from public.purchase_orders where supplier_id = p_supplier and status <> 'cancelled' group by 1) x on x.month = m.month
    ), '[]'::jsonb)
  ) into v_result
  from public.purchase_orders where supplier_id = p_supplier;
  return v_result;
end $$;

do $$
declare f text;
begin
  foreach f in array array['supplier_buyers()', 'supplier_archive(uuid,text)', 'supplier_restore(uuid)', 'supplier_delete(uuid)', 'supplier_purchase_stats(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Stockage : bucket privé `supplier-docs` (10 Mo) — chemin <company>/<supplier>/<uuid>-<fichier>
-- ---------------------------------------------------------------------
create function private.storage_supplier_ok(p_supplier text, p_require_open boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.suppliers s
    where s.id::text = p_supplier and s.company_id = private.current_company()
      and (not p_require_open or s.archived_at is null))
$$;
grant execute on function private.storage_supplier_ok(text, boolean) to authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-docs', 'supplier-docs', false, 10485760, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy supplier_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'supplier-docs' and private.has_perm('suppliers.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_supplier_ok((storage.foldername(objects.name))[2]));
create policy supplier_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'supplier-docs' and private.has_perm('suppliers.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_supplier_ok((storage.foldername(objects.name))[2], true));
create policy supplier_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'supplier-docs' and private.has_perm('suppliers.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and private.storage_supplier_ok((storage.foldername(objects.name))[2]));
