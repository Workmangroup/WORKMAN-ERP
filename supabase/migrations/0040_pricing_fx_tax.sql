-- =====================================================================
-- 0040_pricing_fx_tax — Tarifs datés, remises encadrées, taux de TVA et de change signés par la finance (P017)
--  Socle conservé : currencies (minor_units, 0027), vat_rates versionnés par date (0027, 0030), finance_settings
--  (devise de base par société, 0027), exchange_rates (0027), client_tax_rate (0030), product_variants.price (0015,
--  conservé comme donnée saisie, n'est plus utilisé pour la valorisation : aucun tarif n'est supposé).
--  Corrections :
--    - vat_rate_at ne lit que les taux VALIDÉS par la finance (avant : tout taux saisi, y compris « à valider »).
--    - exchange_rates : source obligatoire et validation par une autre personne que la saisie (SOD).
--  Ajouts :
--    price_lists / price_list_items : tarifs par canal, datés, en devise de la liste, validés par la finance.
--    client_price_assignments       : rattachement d'un client à une liste, sur une période (pas de liste par défaut).
--    client_discount_rules          : remise maximale autorisée pour un client, datée, validée par la finance.
--    price_resolve                  : calcul exact (montant devise, TVA, montant fonctionnel) ; refus si rien n'est signé.
--    price_snapshots                : trace immuable des calculs (montants devise et fonctionnel, taux, sources).
--  Arrondis : au nombre de décimales de la devise (currencies.minor_units), demi vers l'extérieur (round de PostgreSQL).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('pricing.read',   'orders', 'Voir les tarifs',       'Consulter les tarifs, remises et calculs de prix'),
  ('pricing.manage', 'orders', 'Gérer les tarifs',      'Saisir tarifs, rattachements et remises (validation par la finance)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code in ('admin', 'direction') and p.code in ('pricing.read', 'pricing.manage'))
  or (r.code = 'commercial' and p.code in ('pricing.read', 'pricing.manage'))
  or (r.code = 'finance' and p.code = 'pricing.read'))
on conflict do nothing;
-- La finance signe les paramètres : droit d'écriture finance (déjà attribué aux administrateurs)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and r.code = 'finance' and p.code = 'finance.write'
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. TVA : seuls les taux validés par la finance servent au calcul
-- ---------------------------------------------------------------------
alter table public.vat_rates
  add column created_by uuid default auth.uid(),
  add column validated_by uuid,
  add column validated_at timestamptz,
  add constraint vat_rates_validation_ck check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  add constraint vat_rates_sod_ck check (validated_by is null or validated_by is distinct from created_by);

create or replace function private.vat_rate_at(p_kind text, p_country char(2), p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_rate numeric;
begin
  select v.rate into v_rate
    from public.vat_rates v
   where v.kind = p_kind and v.country = p_country and v.status = 'valide'
     and p_date >= v.effective_from and (v.effective_to is null or p_date <= v.effective_to)
   order by v.effective_from desc
   limit 1;
  if v_rate is null then
    if exists (select 1 from public.vat_rates v where v.kind = p_kind and v.country = p_country
               and p_date >= v.effective_from and (v.effective_to is null or p_date <= v.effective_to)) then
      raise exception 'VAT_RATE_NOT_VALIDATED' using errcode = '55000', detail = p_kind || ' ' || p_country || ' ' || p_date::text;
    end if;
    raise exception 'VAT_RATE_MISSING' using errcode = 'P0002', detail = p_kind || ' ' || p_country || ' ' || p_date::text;
  end if;
  return v_rate;
end $$;

-- Taux de TVA : saisie (à valider), puis validation par une autre personne que l'auteur.
create function public.vat_rate_create(p_code text, p_label text, p_rate numeric, p_kind text, p_country char(2), p_from date, p_to date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('finance.write');
  if p_rate is null or p_rate < 0 or p_rate > 100 then raise exception 'VAT_BAD_RATE' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_label, ''))) < 3 then raise exception 'VAT_LABEL_REQUIRED' using errcode = '22023'; end if;
  insert into public.vat_rates (code, label, rate, kind, country, effective_from, effective_to, status)
  values (p_code, btrim(p_label), p_rate, p_kind, p_country, p_from, p_to, 'a_valider');
  perform private.write_audit(private.current_company(), 'finance.vat_create', 'vat_rate', p_code, p_label, null,
    jsonb_build_object('rate', p_rate, 'kind', p_kind, 'country', p_country, 'from', p_from, 'to', p_to), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.vat_rate_create(text, text, numeric, text, char, date, date) to authenticated, service_role;

create function public.vat_rate_validate(p_code text, p_from date, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.vat_rates%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into r from public.vat_rates where code = p_code and effective_from = p_from for update;
  if not found then raise exception 'VAT_RATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status = 'valide' then raise exception 'VAT_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'vat_rate'; end if;
  if p_validate then
    update public.vat_rates set status = 'valide', validated_by = auth.uid(), validated_at = now() where code = r.code and effective_from = r.effective_from;
  end if;
  perform private.write_audit(private.current_company(), case when p_validate then 'finance.vat_approve' else 'finance.vat_reject' end,
    'vat_rate', p_code, r.label, jsonb_build_object('status', r.status), jsonb_build_object('status', case when p_validate then 'valide' else 'a_valider' end),
    '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.vat_rate_validate(text, date, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Taux de change : source obligatoire, validation par une autre personne
-- ---------------------------------------------------------------------
alter table public.exchange_rates
  add column source text check (source is null or length(btrim(source)) between 5 and 200),
  add column status text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  add column validated_by uuid,
  add column validated_at timestamptz,
  add constraint exchange_rates_validation_ck check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  add constraint exchange_rates_sod_ck check (validated_by is null or validated_by is distinct from created_by);

create function public.exchange_rate_set(p_date date, p_currency char(3), p_rate numeric, p_source text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_base char(3);
begin
  perform private.require_perm('finance.write');
  select base_currency into v_base from public.finance_settings where company_id = v_co;
  if v_base is null then raise exception 'FINANCE_BASE_MISSING' using errcode = '55000'; end if;
  if p_currency = v_base then raise exception 'FX_BASE_CURRENCY' using errcode = '22023'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'FX_BAD_RATE' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_source, ''))) < 5 then raise exception 'FX_SOURCE_REQUIRED' using errcode = '22023'; end if;
  insert into public.exchange_rates (id, company_id, rate_date, currency, rate, source, status)
  values (v_id, v_co, p_date, p_currency, p_rate, btrim(p_source), 'a_valider');
  perform private.write_audit(v_co, 'finance.fx_create', 'exchange_rate', v_id::text, p_currency || ' ' || p_date::text, null,
    jsonb_build_object('rate', p_rate, 'source', btrim(p_source)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.exchange_rate_set(date, char, numeric, text) to authenticated, service_role;

create function public.exchange_rate_validate(p_rate uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.exchange_rates%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into r from public.exchange_rates where id = p_rate and company_id = private.current_company() for update;
  if not found then raise exception 'FX_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status = 'valide' then raise exception 'FX_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'exchange_rate'; end if;
  if p_validate then
    update public.exchange_rates set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  end if;
  perform private.write_audit(r.company_id, case when p_validate then 'finance.fx_approve' else 'finance.fx_reject' end, 'exchange_rate', r.id::text,
    r.currency || ' ' || r.rate_date::text, null, jsonb_build_object('rate', r.rate, 'source', r.source), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.exchange_rate_validate(uuid, boolean) to authenticated, service_role;

-- Taux applicable à une date : dernier taux validé à cette date ou avant. Devise de base : taux 1, sans saisie.
create function public.fx_rate_at(p_currency char(3), p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3); v_rate numeric;
begin
  select base_currency into v_base from public.finance_settings where company_id = v_co;
  if v_base is null then raise exception 'FINANCE_BASE_MISSING' using errcode = '55000'; end if;
  if p_currency = v_base then return 1; end if;
  select e.rate into v_rate from public.exchange_rates e
   where e.company_id = v_co and e.currency = p_currency and e.status = 'valide' and e.rate_date <= p_date
   order by e.rate_date desc limit 1;
  if v_rate is null then raise exception 'FX_RATE_MISSING' using errcode = 'P0002', detail = p_currency || ' ' || p_date::text; end if;
  return v_rate;
end $$;
grant execute on function public.fx_rate_at(char, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Tarifs datés par canal, rattachements clients, remises
-- ---------------------------------------------------------------------
create table public.price_lists (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  name         text not null check (length(btrim(name)) between 2 and 120),
  currency     char(3) not null references public.currencies(code),
  channel      text not null check (channel in ('direct', 'distributor', 'export', 'other')),
  status       text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  validated_by uuid,
  validated_at timestamptz,
  unique (company_id, code),
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by)
);
alter table public.price_lists enable row level security;
create policy price_lists_select on public.price_lists for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('pricing.read') or private.has_perm('finance.read')));
revoke all on public.price_lists from anon, authenticated;
grant select on public.price_lists to authenticated;
grant all on public.price_lists to service_role;

create table public.price_list_items (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  price_list_id uuid not null references public.price_lists(id),
  variant_id   uuid not null references public.product_variants(id),
  unit_price   numeric(14,4) not null check (unit_price >= 0 and unit_price < 1000000000),
  effective_from date not null,
  effective_to date,
  status       text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  validated_by uuid,
  validated_at timestamptz,
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by)
);
create index price_list_items_lookup_idx on public.price_list_items (price_list_id, variant_id, effective_from);
alter table public.price_list_items enable row level security;
create policy price_list_items_select on public.price_list_items for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('pricing.read') or private.has_perm('finance.read')));
revoke all on public.price_list_items from anon, authenticated;
grant select on public.price_list_items to authenticated;
grant all on public.price_list_items to service_role;

create table public.client_price_assignments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id),
  client_id     uuid not null references public.clients(id),
  price_list_id uuid not null references public.price_lists(id),
  effective_from date not null,
  effective_to  date,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
alter table public.client_price_assignments enable row level security;
create policy client_price_assignments_select on public.client_price_assignments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('pricing.read'));
revoke all on public.client_price_assignments from anon, authenticated;
grant select on public.client_price_assignments to authenticated;
grant all on public.client_price_assignments to service_role;

create table public.client_discount_rules (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  client_id    uuid not null references public.clients(id),
  max_discount_pct numeric(5,2) not null check (max_discount_pct >= 0 and max_discount_pct <= 100),
  effective_from date not null,
  effective_to date,
  status       text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  validated_by uuid,
  validated_at timestamptz,
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by)
);
alter table public.client_discount_rules enable row level security;
create policy client_discount_rules_select on public.client_discount_rules for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('pricing.read') or private.has_perm('finance.read')));
revoke all on public.client_discount_rules from anon, authenticated;
grant select on public.client_discount_rules to authenticated;
grant all on public.client_discount_rules to service_role;

-- Pas de chevauchement de périodes sur un même tarif, un même rattachement client, une même remise
create function private.price_period_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'price_list_items' then
    if exists (select 1 from public.price_list_items o where o.id <> new.id and o.price_list_id = new.price_list_id and o.variant_id = new.variant_id
               and o.effective_from <= coalesce(new.effective_to, date '9999-12-31') and new.effective_from <= coalesce(o.effective_to, date '9999-12-31')) then
      raise exception 'PRICE_PERIOD_OVERLAP' using errcode = '23P01';
    end if;
  elsif tg_table_name = 'client_price_assignments' then
    if exists (select 1 from public.client_price_assignments o where o.id <> new.id and o.client_id = new.client_id
               and o.effective_from <= coalesce(new.effective_to, date '9999-12-31') and new.effective_from <= coalesce(o.effective_to, date '9999-12-31')) then
      raise exception 'PRICE_PERIOD_OVERLAP' using errcode = '23P01';
    end if;
  else
    if exists (select 1 from public.client_discount_rules o where o.id <> new.id and o.client_id = new.client_id
               and o.effective_from <= coalesce(new.effective_to, date '9999-12-31') and new.effective_from <= coalesce(o.effective_to, date '9999-12-31')) then
      raise exception 'PRICE_PERIOD_OVERLAP' using errcode = '23P01';
    end if;
  end if;
  return new;
end $$;
create trigger price_list_items_period_iu before insert or update on public.price_list_items for each row execute function private.price_period_guard();
create trigger client_price_assignments_period_iu before insert or update on public.client_price_assignments for each row execute function private.price_period_guard();
create trigger client_discount_rules_period_iu before insert or update on public.client_discount_rules for each row execute function private.price_period_guard();

-- Saisie (pricing.manage) : tout reste « à valider » jusqu'à la signature de la finance
create function public.price_list_create(p_code text, p_name text, p_currency char(3), p_channel text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('pricing.manage');
  insert into public.price_lists (id, code, name, currency, channel) values (v_id, upper(btrim(p_code)), btrim(p_name), p_currency, p_channel);
  perform private.write_audit(private.current_company(), 'pricing.list_create', 'price_list', v_id::text, upper(btrim(p_code)), null,
    jsonb_build_object('currency', p_currency, 'channel', p_channel), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.price_list_create(text, text, char, text) to authenticated, service_role;

create function public.price_item_set(p_list uuid, p_variant uuid, p_unit_price numeric, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_co uuid := private.current_company();
begin
  perform private.require_perm('pricing.manage');
  if not exists (select 1 from public.price_lists where id = p_list and company_id = v_co) then raise exception 'PRICE_LIST_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.product_variants where id = p_variant and company_id = v_co) then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception 'PRICE_BAD_AMOUNT' using errcode = '22023'; end if;
  if p_from is null then raise exception 'PRICE_DATE_REQUIRED' using errcode = '22023'; end if;
  insert into public.price_list_items (id, company_id, price_list_id, variant_id, unit_price, effective_from, effective_to)
  values (v_id, v_co, p_list, p_variant, p_unit_price, p_from, p_to);
  perform private.write_audit(v_co, 'pricing.item_set', 'price_list', p_list::text, 'Article ' || p_variant::text, null,
    jsonb_build_object('unit_price', p_unit_price, 'from', p_from, 'to', p_to), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.price_item_set(uuid, uuid, numeric, date, date) to authenticated, service_role;

create function public.client_price_assign(p_client uuid, p_list uuid, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_co uuid := private.current_company();
begin
  perform private.require_perm('pricing.manage');
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.price_lists where id = p_list and company_id = v_co) then raise exception 'PRICE_LIST_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.client_price_assignments (id, company_id, client_id, price_list_id, effective_from, effective_to)
  values (v_id, v_co, p_client, p_list, p_from, p_to);
  perform private.write_audit(v_co, 'pricing.assign', 'client', p_client::text, p_list::text, null,
    jsonb_build_object('from', p_from, 'to', p_to), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.client_price_assign(uuid, uuid, date, date) to authenticated, service_role;

create function public.client_discount_set(p_client uuid, p_max_pct numeric, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_co uuid := private.current_company();
begin
  perform private.require_perm('pricing.manage');
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_max_pct is null or p_max_pct < 0 or p_max_pct > 100 then raise exception 'DISCOUNT_BAD_PCT' using errcode = '22023'; end if;
  insert into public.client_discount_rules (id, company_id, client_id, max_discount_pct, effective_from, effective_to)
  values (v_id, v_co, p_client, p_max_pct, p_from, p_to);
  perform private.write_audit(v_co, 'pricing.discount_set', 'client', p_client::text, 'Remise maximale ' || p_max_pct::text || ' %', null,
    jsonb_build_object('max_pct', p_max_pct, 'from', p_from, 'to', p_to), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.client_discount_set(uuid, numeric, date, date) to authenticated, service_role;

-- Validation par la finance (finance.write), auteur exclu par la base (CHECK) et par la fonction
create function public.price_validate(p_kind text, p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text; v_by uuid; v_label text;
begin
  perform private.require_perm('finance.write');
  if p_kind = 'list' then
    select status, created_by, code into v_status, v_by, v_label from public.price_lists where id = p_id and company_id = v_co for update;
    if not found then raise exception 'PRICE_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_status = 'valide' then raise exception 'PRICE_BAD_STATUS' using errcode = '55000'; end if;
    if v_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'price_list'; end if;
    if p_validate then update public.price_lists set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = p_id; end if;
  elsif p_kind = 'item' then
    select status, created_by, unit_price::text into v_status, v_by, v_label from public.price_list_items where id = p_id and company_id = v_co for update;
    if not found then raise exception 'PRICE_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_status = 'valide' then raise exception 'PRICE_BAD_STATUS' using errcode = '55000'; end if;
    if v_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'price_item'; end if;
    if p_validate then update public.price_list_items set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = p_id; end if;
  elsif p_kind = 'discount' then
    select status, created_by, max_discount_pct::text into v_status, v_by, v_label from public.client_discount_rules where id = p_id and company_id = v_co for update;
    if not found then raise exception 'PRICE_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_status = 'valide' then raise exception 'PRICE_BAD_STATUS' using errcode = '55000'; end if;
    if v_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'discount'; end if;
    if p_validate then update public.client_discount_rules set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = p_id; end if;
  else
    raise exception 'PRICE_BAD_KIND' using errcode = '22023';
  end if;
  perform private.write_audit(v_co, case when p_validate then 'finance.price_approve' else 'finance.price_reject' end, p_kind, p_id::text, v_label, null,
    jsonb_build_object('validated', p_validate), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.price_validate(text, uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Calcul de prix : refus si un élément n'est pas signé ; montants devise et fonctionnel ; TVA lue dans vat_rates
-- ---------------------------------------------------------------------
create table public.price_snapshots (
  id                 bigint generated always as identity primary key,
  company_id         uuid not null references public.companies(id),
  client_id          uuid not null references public.clients(id),
  variant_id         uuid not null references public.product_variants(id),
  on_date            date not null,
  qty                numeric(14,4) not null check (qty > 0),
  price_list_id      uuid not null references public.price_lists(id),
  price_item_id      uuid not null references public.price_list_items(id),
  unit_price         numeric(14,4) not null,
  discount_pct       numeric(5,2) not null check (discount_pct >= 0 and discount_pct <= 100),
  currency           char(3) not null,
  line_amount        numeric(18,4) not null,           -- montant HT en devise de la liste
  vat_rate           numeric(5,2) not null,
  tax_amount         numeric(18,4) not null,
  total_amount       numeric(18,4) not null,           -- TTC en devise de la liste
  functional_currency char(3) not null,
  fx_rate            numeric(18,8) not null,
  functional_amount  numeric(18,4) not null,           -- HT en devise fonctionnelle
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid()
);
create function private.price_snapshots_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'PRICE_SNAPSHOT_IMMUTABLE' using errcode = '42501'; end $$;
create trigger price_snapshots_no_change before update or delete on public.price_snapshots
  for each row execute function private.price_snapshots_immutable();
alter table public.price_snapshots enable row level security;
create policy price_snapshots_select on public.price_snapshots for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('pricing.read') or private.has_perm('finance.read')));
revoke all on public.price_snapshots from anon, authenticated;
grant select on public.price_snapshots to authenticated;
grant all on public.price_snapshots to service_role;

create function public.price_resolve(p_client uuid, p_variant uuid, p_qty numeric, p_on date, p_discount_pct numeric default 0, p_snapshot boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_list public.price_lists%rowtype; v_item public.price_list_items%rowtype;
  v_base char(3); v_base_minor int; v_list_minor int; v_max numeric; v_rate numeric; v_vat numeric; v_fx numeric;
  v_unit_net numeric; v_line numeric; v_tax numeric; v_func numeric; v_disc numeric := coalesce(p_discount_pct, 0); v_snap bigint;
begin
  perform private.require_perm('pricing.read');
  if p_qty is null or p_qty <= 0 then raise exception 'PRICE_BAD_QTY' using errcode = '22023'; end if;
  if p_on is null then raise exception 'PRICE_DATE_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;

  -- liste : rattachement client à la date, liste signée
  select l.* into v_list from public.client_price_assignments a join public.price_lists l on l.id = a.price_list_id
   where a.client_id = p_client and a.company_id = v_co and p_on >= a.effective_from and (a.effective_to is null or p_on <= a.effective_to)
   order by a.effective_from desc limit 1;
  if not found then raise exception 'PRICE_NO_LIST' using errcode = 'P0002', detail = p_client::text; end if;
  if v_list.status <> 'valide' then raise exception 'PRICE_LIST_NOT_VALIDATED' using errcode = '55000', detail = v_list.code; end if;

  -- tarif : article et date, signé
  select i.* into v_item from public.price_list_items i
   where i.price_list_id = v_list.id and i.variant_id = p_variant and p_on >= i.effective_from and (i.effective_to is null or p_on <= i.effective_to)
   order by i.effective_from desc limit 1;
  if not found then raise exception 'PRICE_NOT_FOUND' using errcode = 'P0002', detail = p_variant::text; end if;
  if v_item.status <> 'valide' then raise exception 'PRICE_NOT_VALIDATED' using errcode = '55000', detail = v_item.id::text; end if;

  -- remise : autorisée seulement dans la limite signée du client
  select r.max_discount_pct into v_max from public.client_discount_rules r
   where r.client_id = p_client and r.company_id = v_co and r.status = 'valide' and p_on >= r.effective_from and (r.effective_to is null or p_on <= r.effective_to)
   order by r.effective_from desc limit 1;
  if v_disc > 0 and v_max is null then raise exception 'DISCOUNT_NOT_ALLOWED' using errcode = '42501'; end if;
  if v_disc > coalesce(v_max, 0) then raise exception 'DISCOUNT_ABOVE_LIMIT' using errcode = '42501', detail = v_max::text; end if;

  -- montants : arrondis à la décimale de la devise, aucune constante fiscale ni de change
  select base_currency into v_base from public.finance_settings where company_id = v_co;
  if v_base is null then raise exception 'FINANCE_BASE_MISSING' using errcode = '55000'; end if;
  select minor_units into v_list_minor from public.currencies where code = v_list.currency;
  select minor_units into v_base_minor from public.currencies where code = v_base;
  v_unit_net := round(v_item.unit_price * (1 - v_disc / 100), 4);
  v_line := round(p_qty * v_unit_net, v_list_minor);
  v_vat := private.client_tax_rate(p_client);                 -- TVA validée (vat_rate_at), jamais codée en dur
  v_tax := round(v_line * v_vat / 100, v_list_minor);
  v_fx := public.fx_rate_at(v_list.currency, p_on);            -- taux validé à la date
  v_func := round(v_line * v_fx, v_base_minor);

  if p_snapshot then
    insert into public.price_snapshots (company_id, client_id, variant_id, on_date, qty, price_list_id, price_item_id, unit_price, discount_pct,
      currency, line_amount, vat_rate, tax_amount, total_amount, functional_currency, fx_rate, functional_amount)
    values (v_co, p_client, p_variant, p_on, p_qty, v_list.id, v_item.id, v_item.unit_price, v_disc,
      v_list.currency, v_line, v_vat, v_tax, v_line + v_tax, v_base, v_fx, v_func)
    returning id into v_snap;
    perform private.write_audit(v_co, 'pricing.snapshot', 'client', p_client::text, 'Calcul de prix', null,
      jsonb_build_object('snapshot', v_snap, 'line_amount', v_line, 'currency', v_list.currency, 'functional_amount', v_func), '{}'::jsonb, 'rpc');
  end if;

  return jsonb_build_object(
    'price_list', v_list.code, 'price_item', v_item.id, 'unit_price', v_item.unit_price, 'discount_pct', v_disc, 'unit_net', v_unit_net,
    'currency', v_list.currency, 'line_amount', v_line, 'vat_rate', v_vat, 'tax_amount', v_tax, 'total_amount', v_line + v_tax,
    'functional_currency', v_base, 'fx_rate', v_fx, 'functional_amount', v_func, 'snapshot', v_snap);
end $$;
grant execute on function public.price_resolve(uuid, uuid, numeric, date, numeric, boolean) to authenticated, service_role;
