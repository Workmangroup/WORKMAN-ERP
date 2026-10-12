-- =====================================================================
-- 0004_clients — Module Clients
--  clients, contacts, adresses, documents (Storage), conditions de paiement,
--  commercial affecté, archivage, historique (audit_logs), RLS.
--  Permissions : clients.read / clients.write / clients.delete (archiver, restaurer, supprimer)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Séquences de numérotation par société
-- ---------------------------------------------------------------------
create table public.company_sequences (
  company_id uuid not null references public.companies(id) on delete cascade,
  key        text not null,
  last_value int  not null default 0,
  primary key (company_id, key)
);
alter table public.company_sequences enable row level security;   -- aucune politique : accès via fonctions uniquement
revoke all on public.company_sequences from anon, authenticated;

create function private.next_seq(p_company uuid, p_key text) returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  insert into public.company_sequences (company_id, key, last_value) values (p_company, p_key, 1)
  on conflict (company_id, key) do update set last_value = public.company_sequences.last_value + 1
  returning last_value into v;
  return v;
end $$;
revoke execute on function private.next_seq(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Conditions de paiement (catalogue par société)
-- ---------------------------------------------------------------------
create table public.payment_terms (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  code         text not null,
  label        text not null,
  days         int  not null default 0 check (days between 0 and 365),
  end_of_month boolean not null default false,
  is_active    boolean not null default true,
  sort_order   int  not null default 0,
  unique (company_id, code)
);
alter table public.payment_terms enable row level security;
revoke all on public.payment_terms from anon, authenticated;
grant select on public.payment_terms to authenticated;
grant all on public.payment_terms to service_role;
create policy payment_terms_select on public.payment_terms for select to authenticated
  using (company_id = private.current_company());

insert into public.payment_terms (company_id, code, label, days, end_of_month, sort_order)
select c.id, v.code, v.label, v.days, v.eom, v.ord
from public.companies c
cross join (values
  ('COMPTANT', 'Comptant', 0, false, 1),
  ('30J',      '30 jours', 30, false, 2),
  ('45J',      '45 jours', 45, false, 3),
  ('60J',      '60 jours', 60, false, 4),
  ('90J',      '90 jours', 90, false, 5),
  ('30FDM',    '30 jours fin de mois', 30, true, 6),
  ('45FDM',    '45 jours fin de mois', 45, true, 7),
  ('60FDM',    '60 jours fin de mois', 60, true, 8)
) v(code, label, days, eom, ord)
on conflict (company_id, code) do nothing;

-- ---------------------------------------------------------------------
-- 3. Clients
-- ---------------------------------------------------------------------
create table public.clients (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id),
  code                    text not null,
  name                    text not null check (length(btrim(name)) between 2 and 120),
  legal_name              text,
  tax_id                  text,                                   -- identifiant fiscal / n° TVA
  registration_no         text,                                   -- registre du commerce
  website                 text,
  email                   text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                   text,
  country                 char(2) not null check (country ~ '^[A-Z]{2}$'),
  currency                char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  language                text not null default 'fr' check (language in ('fr','en','de','es','it','nl')),
  payment_terms_id        uuid references public.payment_terms(id),
  payment_method          text check (payment_method in ('transfer','cheque','lc','cash','other')),
  credit_limit            numeric(15,3) check (credit_limit is null or credit_limit >= 0),
  incoterm                text check (incoterm is null or incoterm in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  vat_exempt              boolean not null default false,
  delivery_tolerance_pct  numeric(5,2) not null default 5 check (delivery_tolerance_pct between 0 and 50),
  aql_level               text,
  sales_rep_id            uuid references public.profiles(id) on delete set null,
  notes                   text,
  archived_at             timestamptz,
  archived_by             uuid,
  archive_reason          text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid,
  updated_by              uuid,
  unique (company_id, code)
);
create unique index clients_tax_id_uq on public.clients (company_id, lower(btrim(tax_id))) where tax_id is not null and btrim(tax_id) <> '';
create unique index clients_name_active_uq on public.clients (company_id, lower(btrim(name))) where archived_at is null;
create index clients_company_idx   on public.clients (company_id, archived_at);
create index clients_sales_rep_idx on public.clients (sales_rep_id);
create index clients_country_idx   on public.clients (company_id, country);

alter table public.profiles
  add constraint profiles_client_fk foreign key (client_id) references public.clients(id);

create table public.client_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
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
create index client_contacts_client_idx on public.client_contacts (client_id);
create unique index client_contacts_primary_uq on public.client_contacts (client_id) where is_primary;

create table public.client_addresses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id) on delete cascade,
  type        text not null check (type in ('head_office','billing','delivery','other')),
  label       text,
  line1       text not null check (length(btrim(line1)) >= 2),
  line2       text,
  postal_code text,
  city        text not null check (length(btrim(city)) >= 1),
  region      text,
  country     char(2) not null check (country ~ '^[A-Z]{2}$'),
  is_default  boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);
create index client_addresses_client_idx on public.client_addresses (client_id);
create unique index client_addresses_default_uq on public.client_addresses (client_id, type) where is_default;

create table public.client_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  client_id    uuid not null references public.clients(id) on delete cascade,
  title        text not null check (length(btrim(title)) >= 2),
  doc_type     text not null check (doc_type in ('contract','nda','quality_agreement','certificate','specification','tax','identification','other')),
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
create index client_documents_client_idx on public.client_documents (client_id);
create index client_documents_expiry_idx on public.client_documents (company_id, valid_until);

-- ---------------------------------------------------------------------
-- 4. Triggers de cohérence (code auto, normalisation, règles métier)
-- ---------------------------------------------------------------------
create function private.clients_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if new.company_id is null then raise exception 'CLIENT_NO_COMPANY' using errcode = '22023'; end if;
    if nullif(btrim(coalesce(new.code, '')), '') is null then
      v_n := private.next_seq(new.company_id, 'client');
      new.code := 'CLI-' || lpad(v_n::text, 4, '0');
    else
      new.code := upper(btrim(new.code));
    end if;
    if new.code !~ '^[A-Z0-9][A-Z0-9_-]{1,19}$' then raise exception 'CLIENT_INVALID_CODE' using errcode = '22023'; end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;   -- jamais créé archivé
  else
    if new.code is distinct from old.code then raise exception 'CLIENT_CODE_LOCKED' using errcode = '42501'; end if;
    if new.company_id is distinct from old.company_id then raise exception 'CLIENT_CODE_LOCKED' using errcode = '42501'; end if;
    -- un client archivé n'est plus modifiable : il faut d'abord le restaurer
    if old.archived_at is not null and new.archived_at is not null then
      raise exception 'CLIENT_ARCHIVED' using errcode = '55000';
    end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;

  new.name     := btrim(new.name);
  new.country  := upper(new.country);
  new.currency := upper(new.currency);
  new.email    := nullif(btrim(coalesce(new.email, '')), '');

  if new.sales_rep_id is not null and (tg_op = 'INSERT' or new.sales_rep_id is distinct from old.sales_rep_id) then
    if not exists (select 1 from public.profiles p where p.id = new.sales_rep_id and p.company_id = new.company_id and p.is_active) then
      raise exception 'CLIENT_INVALID_REP' using errcode = '22023';
    end if;
  end if;
  if new.payment_terms_id is not null and (tg_op = 'INSERT' or new.payment_terms_id is distinct from old.payment_terms_id) then
    if not exists (select 1 from public.payment_terms t where t.id = new.payment_terms_id and t.company_id = new.company_id and t.is_active) then
      raise exception 'CLIENT_INVALID_TERMS' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

create trigger clients_before_iu before insert or update on public.clients
  for each row execute function private.clients_before();

create function private.client_contacts_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = new.client_id;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_client.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := v_client.company_id;
  new.full_name := btrim(new.full_name);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    -- le premier contact devient principal
    if not exists (select 1 from public.client_contacts where client_id = new.client_id) then new.is_primary := true; end if;
  else
    new.updated_at := now();
  end if;
  new.updated_by := auth.uid();
  if new.is_primary then
    update public.client_contacts set is_primary = false where client_id = new.client_id and id is distinct from new.id and is_primary;
  end if;
  return new;
end $$;

create trigger client_contacts_before_iu before insert or update on public.client_contacts
  for each row execute function private.client_contacts_before();

create function private.client_addresses_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = new.client_id;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_client.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  new.company_id := v_client.company_id;
  new.country := upper(new.country);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.client_addresses where client_id = new.client_id and type = new.type) then new.is_default := true; end if;
  else
    new.updated_at := now();
  end if;
  new.updated_by := auth.uid();
  if new.is_default then
    update public.client_addresses set is_default = false
    where client_id = new.client_id and type = new.type and id is distinct from new.id and is_default;
  end if;
  return new;
end $$;

create trigger client_addresses_before_iu before insert or update on public.client_addresses
  for each row execute function private.client_addresses_before();

create function private.client_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = new.client_id;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_client.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  new.company_id := v_client.company_id;
  if tg_op = 'INSERT' then
    -- le fichier doit être rangé sous <société>/<client>/ (empêche de référencer le fichier d'un autre client)
    if new.storage_path not like new.company_id::text || '/' || new.client_id::text || '/%' then
      raise exception 'CLIENT_INVALID_PATH' using errcode = '22023';
    end if;
    new.uploaded_by := auth.uid();
  else
    if new.storage_path is distinct from old.storage_path or new.client_id is distinct from old.client_id then
      raise exception 'CLIENT_INVALID_PATH' using errcode = '22023';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger client_documents_before_iu before insert or update on public.client_documents
  for each row execute function private.client_documents_before();

-- ---------------------------------------------------------------------
-- 5. Historique des modifications (audit_logs, entity_type = 'client')
-- ---------------------------------------------------------------------
create function private.jsonb_changes(p_old jsonb, p_new jsonb, p_ignore text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'before', coalesce(jsonb_object_agg(k, p_old -> k), '{}'::jsonb),
    'after',  coalesce(jsonb_object_agg(k, p_new -> k), '{}'::jsonb))
  from (select k from jsonb_object_keys(p_new) k
        where not (k = any (p_ignore)) and (p_old -> k) is distinct from (p_new -> k)) s
$$;

create function private.audit_clients() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','archived_at','archived_by','archive_reason'];
  v_chg jsonb;
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' and tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'client.create', 'client', new.id::text, new.name, null, to_jsonb(new) - c_noise);
  elsif tg_op = 'UPDATE' then
    if old.archived_at is null and new.archived_at is not null then
      perform private.write_audit(new.company_id, 'client.archive', 'client', new.id::text, new.name, null, null,
        jsonb_build_object('reason', new.archive_reason));
    elsif old.archived_at is not null and new.archived_at is null then
      perform private.write_audit(new.company_id, 'client.restore', 'client', new.id::text, new.name, null, null);
    else
      v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
      if v_chg -> 'after' <> '{}'::jsonb then
        perform private.write_audit(new.company_id, 'client.update', 'client', new.id::text, new.name, v_chg -> 'before', v_chg -> 'after');
      end if;
    end if;
  else
    perform private.write_audit(old.company_id, 'client.delete', 'client', old.id::text, old.name, to_jsonb(old) - c_noise, null);
  end if;
  return coalesce(new, old);
end $$;

create trigger audit_clients_iud after insert or update or delete on public.clients
  for each row execute function private.audit_clients();

-- Contacts / adresses / documents : entrée dans l'historique du client
create function private.audit_client_child() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_noise constant text[] := array['company_id','created_at','updated_at','created_by','updated_by','uploaded_by','storage_path'];
  v_kind  text := tg_argv[0];
  v_label text := tg_argv[1];
  v_j     jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_client uuid := (v_j ->> 'client_id')::uuid;
  v_name  text;
  v_chg   jsonb;
  v_act   text := 'client.' || v_kind || '_' || case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  v_meta  jsonb := jsonb_build_object(v_kind, v_j ->> v_label);
begin
  if coalesce(current_setting('clients.rpc', true), 'off') = 'on' then return coalesce(new, old); end if;
  select name into v_name from public.clients where id = v_client;
  if tg_op = 'INSERT' then
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'client', v_client::text, v_name, null, v_j - c_noise, v_meta);
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), c_noise);
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'client', v_client::text, v_name, v_chg -> 'before', v_chg -> 'after', v_meta);
    end if;
  else
    perform private.write_audit((v_j ->> 'company_id')::uuid, v_act, 'client', v_client::text, v_name, v_j - c_noise, null, v_meta);
  end if;
  return coalesce(new, old);
end $$;

create trigger audit_client_contacts_iud  after insert or update or delete on public.client_contacts
  for each row execute function private.audit_client_child('contact', 'full_name');
create trigger audit_client_addresses_iud after insert or update or delete on public.client_addresses
  for each row execute function private.audit_client_child('address', 'city');
create trigger audit_client_documents_iud after insert or update or delete on public.client_documents
  for each row execute function private.audit_client_child('document', 'title');

-- L'historique d'un client est lisible avec clients.read (sans exiger audit.read)
create policy audit_logs_select_clients on public.audit_logs for select to authenticated
  using (entity_type = 'client' and company_id = private.current_company() and private.has_perm('clients.read'));

-- ---------------------------------------------------------------------
-- 6. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.clients          enable row level security;
alter table public.client_contacts  enable row level security;
alter table public.client_addresses enable row level security;
alter table public.client_documents enable row level security;

revoke all on public.clients, public.client_contacts, public.client_addresses, public.client_documents from anon, authenticated;
grant all on public.clients, public.client_contacts, public.client_addresses, public.client_documents to service_role;

grant select on public.clients, public.client_contacts, public.client_addresses, public.client_documents to authenticated;
-- clients : pas de DELETE direct, ni d'écriture des colonnes d'archivage / code (après création) / audit
grant insert (code, name, legal_name, tax_id, registration_no, website, email, phone, country, currency, language,
              payment_terms_id, payment_method, credit_limit, incoterm, vat_exempt, delivery_tolerance_pct, aql_level,
              sales_rep_id, notes) on public.clients to authenticated;
grant update (name, legal_name, tax_id, registration_no, website, email, phone, country, currency, language,
              payment_terms_id, payment_method, credit_limit, incoterm, vat_exempt, delivery_tolerance_pct, aql_level,
              sales_rep_id, notes) on public.clients to authenticated;
grant insert (client_id, full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.client_contacts to authenticated;
grant update (full_name, job_title, email, phone, mobile, language, is_primary, notes) on public.client_contacts to authenticated;
grant delete on public.client_contacts to authenticated;
grant insert (client_id, type, label, line1, line2, postal_code, city, region, country, is_default, notes) on public.client_addresses to authenticated;
grant update (type, label, line1, line2, postal_code, city, region, country, is_default, notes) on public.client_addresses to authenticated;
grant delete on public.client_addresses to authenticated;
grant insert (client_id, title, doc_type, file_name, mime_type, size_bytes, storage_path, valid_until, notes) on public.client_documents to authenticated;
grant update (title, doc_type, valid_until, notes) on public.client_documents to authenticated;
grant delete on public.client_documents to authenticated;

create policy clients_select on public.clients for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy clients_insert on public.clients for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('clients.write'));
create policy clients_update on public.clients for update to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.write'))
  with check (company_id = private.current_company() and private.has_perm('clients.write'));

do $$
declare t text;
begin
  foreach t in array array['client_contacts','client_addresses','client_documents'] loop
    execute format($f$create policy %1$s_select on public.%1$s for select to authenticated
      using (company_id = private.current_company() and private.has_perm('clients.read'))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (company_id = private.current_company() and private.has_perm('clients.write'))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$s for update to authenticated
      using (company_id = private.current_company() and private.has_perm('clients.write'))
      with check (company_id = private.current_company() and private.has_perm('clients.write'))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$s for delete to authenticated
      using (company_id = private.current_company() and private.has_perm('clients.write'))$f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Annuaire minimal de la société (nom du commercial affecté, etc.)
--    Vue définie par le propriétaire, filtrée sur la société de l'appelant.
-- ---------------------------------------------------------------------
create view public.company_directory as
  select p.id, p.full_name, p.email, p.is_active
  from public.profiles p
  where p.company_id = private.current_company();
revoke all on public.company_directory from anon, authenticated;
grant select on public.company_directory to authenticated;

-- ---------------------------------------------------------------------
-- 8. RPC : commerciaux affectables, archivage, restauration, suppression
-- ---------------------------------------------------------------------
create function public.client_sales_reps() returns table (id uuid, full_name text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('clients.read');
  return query
    select distinct p.id, p.full_name, p.email
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id and pe.code = 'clients.write'
    where p.company_id = private.current_company() and p.is_active
    order by p.full_name;
end $$;

create function public.client_archive(p_client uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is not null then raise exception 'CLIENT_ARCHIVED' using errcode = '55000'; end if;
  update public.clients set archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_client;
end $$;

create function public.client_restore(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'CLIENT_NOT_ARCHIVED' using errcode = '55000'; end if;
  update public.clients set archived_at = null, archived_by = null, archive_reason = null where id = p_client;
end $$;

-- Suppression définitive : uniquement un client archivé, sans utilisateur portail rattaché
create function public.client_delete(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype; v_contacts int; v_addresses int; v_documents int;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'CLIENT_NOT_ARCHIVED' using errcode = '55000'; end if;
  if exists (select 1 from public.profiles where client_id = p_client) then
    raise exception 'CLIENT_IN_USE' using errcode = '23503';
  end if;
  select count(*) into v_contacts  from public.client_contacts  where client_id = p_client;
  select count(*) into v_addresses from public.client_addresses where client_id = p_client;
  select count(*) into v_documents from public.client_documents where client_id = p_client;

  perform set_config('clients.rpc', 'on', true);
  begin
    delete from public.clients where id = p_client;     -- FK d'autres modules (commandes…) : RESTRICT => CLIENT_IN_USE
  exception when foreign_key_violation then
    perform set_config('clients.rpc', 'off', true);
    raise exception 'CLIENT_IN_USE' using errcode = '23503';
  end;
  perform set_config('clients.rpc', 'off', true);

  perform private.write_audit(v.company_id, 'client.delete', 'client', v.id::text, v.name,
    to_jsonb(v) - array['company_id','created_at','updated_at','created_by','updated_by'], null,
    jsonb_build_object('contacts', v_contacts, 'addresses', v_addresses, 'documents', v_documents), 'rpc');
  return jsonb_build_object('contacts', v_contacts, 'addresses', v_addresses, 'documents', v_documents);
end $$;

revoke execute on function public.client_sales_reps()            from public, anon;
revoke execute on function public.client_archive(uuid, text)     from public, anon;
revoke execute on function public.client_restore(uuid)           from public, anon;
revoke execute on function public.client_delete(uuid)            from public, anon;
grant  execute on function public.client_sales_reps()            to authenticated;
grant  execute on function public.client_archive(uuid, text)     to authenticated;
grant  execute on function public.client_restore(uuid)           to authenticated;
grant  execute on function public.client_delete(uuid)            to authenticated;

-- La Direction peut archiver / restaurer (validation) ; le reste de la matrice est inchangé
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'clients.delete'
where r.code = 'direction' on conflict do nothing;

-- ---------------------------------------------------------------------
-- 9. Stockage des documents clients (bucket privé)
--    chemin : <company_id>/<client_id>/<uuid>-<fichier>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-docs', 'client-docs', false, 10485760, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- NB : `objects.name` est qualifié, sinon `name` serait résolu vers clients.name dans la sous-requête.
create policy client_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'client-docs' and private.has_perm('clients.read')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and exists (select 1 from public.clients c where c.id::text = (storage.foldername(objects.name))[2] and c.company_id = private.current_company()));

create policy client_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'client-docs' and private.has_perm('clients.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and exists (select 1 from public.clients c where c.id::text = (storage.foldername(objects.name))[2] and c.company_id = private.current_company()));

create policy client_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'client-docs' and private.has_perm('clients.write')
         and (storage.foldername(objects.name))[1] = private.current_company()::text
         and exists (select 1 from public.clients c where c.id::text = (storage.foldername(objects.name))[2] and c.company_id = private.current_company()));
