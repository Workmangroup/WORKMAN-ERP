-- 0089_fixed_assets_depreciation — Immobilisations : acquisition, mise en service, amortissement linéaire, cession, inventaire (P064)
-- Existant conservé : grand livre et service comptable (gl_post, gl_period, clôture, 0031 ; gl_account_add, 0084), comptes existants
-- (411, 401, 521, 666, 766…), périodes, audit (0003), GED non utilisée ici (justificatifs saisis par référence).
--
-- Règles :
--  * Aucune écriture comptable directe : toutes les écritures passent par le service comptable (gl_post), donc par les périodes et
--    la clôture existantes.
--  * Règles comptables et règles fiscales sont deux jeux distincts (kind = accounting / tax), chacun versionné par date d'effet,
--    saisi à valider et signé par une autre personne. Aucune valeur par défaut : durée et méthode viennent de la règle signée.
--  * Méthode admise : linéaire, mois de mise en service compté en entier (convention à valider par l'expert). Le reste du
--    montant amortissable est porté par le dernier mois ; l'arrondi suit la devise de base.
--  * Catégorie : comptes d'immobilisation, d'amortissement cumulé, de dotation, de plus-value et de moins-value, saisis puis signés.
--  * Acquisition : écriture de l'immobilisation au coût, au compte de contrepartie choisi par l'utilisateur.
--  * Mise en service : justificatif fournisseur obligatoire, règles validées à la date, durée figée sur l'immobilisation.
--  * Dotation : le calcul est reproductible (fonction pure des montants, de la durée et de la date de mise en service) ; une période
--    se comptabilise une seule fois (idempotent), par catégorie, dans une écriture OD unique.
--  * Cession : toutes les dotations jusqu'au mois de cession doivent être comptabilisées ; l'écriture solde le coût, l'amortissement
--    cumulé, le produit de cession et la plus ou moins-value. La cession est contrôlée par fixed_asset_disposal_check.
--  * Inventaire : fixed_asset_reconcile compare le registre des immobilisations aux soldes du grand livre (coût et amortissement cumulé).
-- Limites explicites : devise de base uniquement ; méthode linéaire uniquement ; pas de dégressif ; pas de réévaluation ; pas de
-- comptabilisation de la fiscalité (dotation fiscale calculée, non postée) ; justificatifs par référence seulement.
-- Erreurs : FIXED_ASSET_BAD_AMOUNT, FIXED_ASSET_CATEGORY_NOT_VALIDATED, FIXED_ASSET_NOT_FOUND, FIXED_ASSET_BAD_STATUS,
-- FIXED_ASSET_DOCUMENT_REQUIRED, FIXED_ASSET_BAD_DATE, FIXED_ASSET_LIFE_TOO_SHORT, FIXED_ASSET_DEPRECIATION_PENDING,
-- FIXED_ASSET_PERIOD_INVALID, FIXED_ASSET_RULE_MISSING, FIXED_ASSET_RULE_NOT_VALIDATED, FIXED_ASSET_IMMUTABLE,
-- FIXED_ASSET_REASON_REQUIRED, FIXED_ASSET_CATEGORY_ACCOUNT_MISSING, SOD_SELF_APPROVAL, RBAC_FORBIDDEN, GL_PERIOD_CLOSED.

-- ---------------------------------------------------------------------------
-- 1. Droits distincts
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('assets.write', 'finance', 'Gérer les immobilisations', 'Acquisition, mise en service, dotations, cessions et justificatifs'),
  ('assets.validate', 'finance', 'Valider les règles et catégories d’immobilisations', 'Signature distincte de la saisie (règles comptables et fiscales, catégories)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('assets.write', 'assets.validate')
where r.is_system and r.code in ('admin', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Règles d'amortissement (comptable ou fiscale), versionnées et signées
-- ---------------------------------------------------------------------------
create table public.asset_rule_sets (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  kind            text not null check (kind in ('accounting', 'tax')),
  code            text not null check (code ~ '^[A-Z0-9_]{3,40}$'),
  method          text not null check (method = 'linear'),
  useful_life_months int not null check (useful_life_months between 1 and 600),
  convention      text not null check (convention = 'full_month_in_service'),
  effective_from  date not null,
  status          text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  validated_by    uuid,
  validated_at    timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, kind, code, effective_from)
);
alter table public.asset_rule_sets enable row level security;
create policy asset_rule_sets_select on public.asset_rule_sets for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

-- Une règle validée est figée ; une règle non validée se supprime seulement par son auteur (retrait)
create function private.asset_rule_sets_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'valide' then raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000'; end if;
    return old;
  end if;
  if old.status = 'valide' then raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000'; end if;
  if old.status = 'a_valider' and new.status = 'valide'
     and (new.id, new.company_id, new.kind, new.code, new.method, new.useful_life_months, new.convention, new.effective_from, new.created_by, new.created_at)
         is not distinct from (old.id, old.company_id, old.kind, old.code, old.method, old.useful_life_months, old.convention, old.effective_from, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.asset_rule_sets_guard() from public, anon, authenticated;
create trigger asset_rule_sets_guard_bud before update or delete on public.asset_rule_sets
  for each row execute function private.asset_rule_sets_guard();

create function public.asset_rule_create(p_kind text, p_code text, p_life_months int, p_effective_from date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('assets.write');
  insert into public.asset_rule_sets (id, company_id, kind, code, method, useful_life_months, convention, effective_from, created_by)
  values (v_id, v_co, p_kind, p_code, 'linear', p_life_months, 'full_month_in_service', p_effective_from, auth.uid());
  perform private.write_audit(v_co, 'assets.rule_create', 'asset_rule', v_id::text, p_code, null,
    jsonb_build_object('kind', p_kind, 'life_months', p_life_months, 'effective_from', p_effective_from, 'status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.asset_rule_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.asset_rule_sets%rowtype;
begin
  perform private.require_perm('assets.validate');
  select * into r from public.asset_rule_sets where id = p_id and company_id = v_co for update;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'FIXED_ASSET_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'asset_rule'; end if;
  if p_validate then
    update public.asset_rule_sets set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    delete from public.asset_rule_sets where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'assets.rule_validate' else 'assets.rule_reject' end, 'asset_rule', r.id::text, r.code,
    jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- Règle en vigueur à une date : la plus récente validée dont la date d'effet est atteinte
create function private.asset_rule_at(p_company uuid, p_kind text, p_code text, p_date date) returns public.asset_rule_sets
language plpgsql stable security definer set search_path = '' as $$
declare r public.asset_rule_sets%rowtype;
begin
  select * into r from public.asset_rule_sets s
   where s.company_id = p_company and s.kind = p_kind and s.code = p_code and s.status = 'valide' and s.effective_from <= p_date
   order by s.effective_from desc limit 1;
  if found then return r; end if;
  if exists (select 1 from public.asset_rule_sets s where s.company_id = p_company and s.kind = p_kind and s.code = p_code and s.effective_from <= p_date) then
    raise exception 'FIXED_ASSET_RULE_NOT_VALIDATED' using errcode = '55000', detail = p_code;
  end if;
  raise exception 'FIXED_ASSET_RULE_MISSING' using errcode = 'P0002', detail = p_code;
end $$;
revoke execute on function private.asset_rule_at(uuid, text, text, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Catégories : comptes utilisés, saisis puis signés
-- ---------------------------------------------------------------------------
create table public.fixed_asset_categories (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code                   text not null check (code ~ '^[A-Z0-9_]{2,20}$'),
  label                  text not null check (length(btrim(label)) between 2 and 120),
  asset_account          text not null check (asset_account ~ '^[0-9]{3,8}$'),
  depreciation_account   text not null check (depreciation_account ~ '^[0-9]{3,8}$'),
  expense_account        text not null check (expense_account ~ '^[0-9]{3,8}$'),
  disposal_gain_account  text not null check (disposal_gain_account ~ '^[0-9]{3,8}$'),
  disposal_loss_account  text not null check (disposal_loss_account ~ '^[0-9]{3,8}$'),
  status                 text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by             uuid default auth.uid(),
  created_at             timestamptz not null default now(),
  validated_by           uuid,
  validated_at           timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, code)
);
alter table public.fixed_asset_categories enable row level security;
create policy fixed_asset_categories_select on public.fixed_asset_categories for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.fixed_asset_categories_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000'; end if;
  if old.status = 'a_valider' and new.status = 'valide'
     and (new.id, new.company_id, new.code, new.label, new.asset_account, new.depreciation_account, new.expense_account,
          new.disposal_gain_account, new.disposal_loss_account, new.created_by, new.created_at)
         is not distinct from (old.id, old.company_id, old.code, old.label, old.asset_account, old.depreciation_account, old.expense_account,
          old.disposal_gain_account, old.disposal_loss_account, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.fixed_asset_categories_guard() from public, anon, authenticated;
create trigger fixed_asset_categories_guard_bud before update or delete on public.fixed_asset_categories
  for each row execute function private.fixed_asset_categories_guard();

create function public.fixed_asset_category_create(p_code text, p_label text, p_asset_account text, p_depreciation_account text,
  p_expense_account text, p_gain_account text, p_loss_account text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); x text;
begin
  perform private.require_perm('assets.write');
  foreach x in array array[p_asset_account, p_depreciation_account, p_expense_account, p_gain_account, p_loss_account] loop
    if not exists (select 1 from public.gl_accounts a where a.company_id = v_co and a.code = x and a.active) then
      raise exception 'FIXED_ASSET_CATEGORY_ACCOUNT_MISSING' using errcode = 'P0002', detail = x;
    end if;
  end loop;
  insert into public.fixed_asset_categories (id, company_id, code, label, asset_account, depreciation_account, expense_account,
    disposal_gain_account, disposal_loss_account, created_by)
  values (v_id, v_co, p_code, btrim(p_label), p_asset_account, p_depreciation_account, p_expense_account, p_gain_account, p_loss_account, auth.uid());
  perform private.write_audit(v_co, 'assets.category_create', 'fixed_asset_category', v_id::text, p_code, null,
    jsonb_build_object('asset', p_asset_account, 'depreciation', p_depreciation_account, 'status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.fixed_asset_category_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.fixed_asset_categories%rowtype;
begin
  perform private.require_perm('assets.validate');
  select * into c from public.fixed_asset_categories where id = p_id and company_id = v_co for update;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'a_valider' then raise exception 'FIXED_ASSET_BAD_STATUS' using errcode = '55000'; end if;
  if c.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'asset_category'; end if;
  if p_validate then
    update public.fixed_asset_categories set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = c.id;
  else
    delete from public.fixed_asset_categories where id = c.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'assets.category_validate' else 'assets.category_reject' end, 'fixed_asset_category', c.id::text, c.code,
    jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Immobilisations, justificatifs, dotations comptabilisées, cessions
-- ---------------------------------------------------------------------------
create table public.fixed_assets (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code                 text not null check (code ~ '^FIX-[0-9]{6}$'),
  label                text not null check (length(btrim(label)) between 3 and 160),
  category_id          uuid not null references public.fixed_asset_categories(id),
  acquisition_date     date not null,
  acquisition_cost     numeric(15,2) not null check (acquisition_cost > 0),
  residual_value       numeric(15,2) not null check (residual_value >= 0),
  credit_account       text not null check (credit_account ~ '^[0-9]{3,8}$'),
  acquisition_entry_id uuid references public.gl_entries(id),
  status               text not null default 'draft' check (status in ('draft', 'in_service', 'disposed')),
  in_service_date      date,
  acc_rule_code        text,
  acc_life_months      int check (acc_life_months is null or acc_life_months between 1 and 600),
  tax_rule_code        text,
  tax_life_months      int check (tax_life_months is null or tax_life_months between 1 and 600),
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  unique (company_id, code),
  check (residual_value < acquisition_cost),
  check ((status = 'draft') = (in_service_date is null and acc_life_months is null and tax_life_months is null)),
  check (status = 'draft' or (in_service_date is not null and in_service_date >= acquisition_date and acc_rule_code is not null and tax_rule_code is not null
                              and acc_life_months is not null and tax_life_months is not null)),
  check (status = 'draft' or acquisition_entry_id is not null)
);
alter table public.fixed_assets enable row level security;
create policy fixed_assets_select on public.fixed_assets for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.fixed_asset_documents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  asset_id      uuid not null references public.fixed_assets(id),
  kind          text not null check (kind in ('supplier_invoice', 'delivery_note', 'commissioning_report', 'disposal_proof')),
  reference     text not null check (length(btrim(reference)) between 3 and 80),
  document_date date not null,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
alter table public.fixed_asset_documents enable row level security;
create policy fixed_asset_documents_select on public.fixed_asset_documents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.fixed_asset_depreciation_posted (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  asset_id      uuid not null references public.fixed_assets(id),
  period_year   int not null,
  period_month  int not null check (period_month between 1 and 12),
  amount        numeric(15,2) not null check (amount > 0),
  entry_id      uuid not null references public.gl_entries(id),
  posted_by     uuid default auth.uid(),
  posted_at     timestamptz not null default now(),
  unique (asset_id, period_year, period_month)
);
alter table public.fixed_asset_depreciation_posted enable row level security;
create policy fixed_asset_depreciation_posted_select on public.fixed_asset_depreciation_posted for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.fixed_asset_disposals (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default private.current_company() references public.companies(id) on delete cascade,
  asset_id          uuid not null unique references public.fixed_assets(id),
  disposal_date     date not null,
  proceeds          numeric(15,2) not null check (proceeds >= 0),
  proceeds_account  text check (proceeds_account is null or proceeds_account ~ '^[0-9]{3,8}$'),
  cost              numeric(15,2) not null check (cost > 0),
  accumulated       numeric(15,2) not null check (accumulated >= 0),
  net_book_value    numeric(15,2) not null check (net_book_value >= 0),
  gain              numeric(15,2) not null check (gain >= 0),
  loss              numeric(15,2) not null check (loss >= 0),
  entry_id          uuid not null references public.gl_entries(id),
  reason            text not null check (length(btrim(reason)) between 5 and 300),
  disposed_by       uuid default auth.uid(),
  disposed_at       timestamptz not null default now(),
  check (proceeds = 0 or proceeds_account is not null),
  check (net_book_value = cost - accumulated),
  check (gain = 0 or loss = 0)
);
alter table public.fixed_asset_disposals enable row level security;
create policy fixed_asset_disposals_select on public.fixed_asset_disposals for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

-- Justificatifs, dotations et cessions : jamais modifiés ni supprimés
create function private.fixed_asset_history_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.fixed_asset_history_guard() from public, anon, authenticated;
create trigger fixed_asset_documents_guard_bud before update or delete on public.fixed_asset_documents
  for each row execute function private.fixed_asset_history_guard();
create trigger fixed_asset_depreciation_posted_guard_bud before update or delete on public.fixed_asset_depreciation_posted
  for each row execute function private.fixed_asset_history_guard();
create trigger fixed_asset_disposals_guard_bud before update or delete on public.fixed_asset_disposals
  for each row execute function private.fixed_asset_history_guard();

-- Immobilisation : seules la mise en service (draft → in_service) et la cession (in_service → disposed) changent son statut
create function private.fixed_assets_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000'; end if;
  if (new.id, new.company_id, new.code, new.label, new.category_id, new.acquisition_date, new.acquisition_cost, new.residual_value,
      new.credit_account, new.acquisition_entry_id, new.created_by, new.created_at)
     is distinct from (old.id, old.company_id, old.code, old.label, old.category_id, old.acquisition_date, old.acquisition_cost, old.residual_value,
      old.credit_account, old.acquisition_entry_id, old.created_by, old.created_at) then
    raise exception 'FIXED_ASSET_IMMUTABLE' using errcode = '55000';
  end if;
  if not ((old.status = 'draft' and new.status = 'in_service') or (old.status = 'in_service' and new.status = 'disposed')) then
    raise exception 'FIXED_ASSET_BAD_STATUS' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.fixed_assets_guard() from public, anon, authenticated;
create trigger fixed_assets_guard_bud before update or delete on public.fixed_assets
  for each row execute function private.fixed_assets_guard();

-- Échéancier linéaire : pure fonction des montants, de la durée et de la date de mise en service (reproductible)
create function private.asset_schedule(p_cost numeric, p_residual numeric, p_life int, p_in_service date)
returns table (period_year int, period_month int, amount numeric, cumulative numeric, net_book_value numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_minor int := (select c.minor_units from public.currencies c where c.code = private.base_currency());
  v_base numeric := p_cost - p_residual; v_monthly numeric := round((p_cost - p_residual) / p_life, (select c.minor_units from public.currencies c where c.code = private.base_currency()));
begin
  return query
  select s.y, s.m, s.amt, sum(s.amt) over (order by s.i)::numeric, (p_cost - sum(s.amt) over (order by s.i))::numeric
    from (
      select g.i, extract(year from x.d)::int as y, extract(month from x.d)::int as m,
             case when g.i < p_life then v_monthly else v_base - v_monthly * (p_life - 1) end as amt
        from generate_series(1, p_life) as g(i)
        cross join lateral (select (date_trunc('month', p_in_service) + make_interval(months => g.i - 1))::date as d) x
    ) s
   order by s.i;
end $$;
revoke execute on function private.asset_schedule(numeric, numeric, int, date) from public, anon, authenticated;

create function public.fixed_asset_acquire(p_category uuid, p_label text, p_date date, p_cost numeric, p_residual numeric, p_credit_account text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.fixed_asset_categories%rowtype; v_id uuid := gen_random_uuid(); v_code text; v_entry uuid;
begin
  perform private.require_perm('assets.write');
  select * into c from public.fixed_asset_categories where id = p_category and company_id = v_co;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'valide' then raise exception 'FIXED_ASSET_CATEGORY_NOT_VALIDATED' using errcode = '55000'; end if;
  if p_cost is null or p_cost <= 0 or p_residual is null or p_residual < 0 or p_residual >= p_cost then
    raise exception 'FIXED_ASSET_BAD_AMOUNT' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_label, ''))) < 3 then raise exception 'FIXED_ASSET_BAD_AMOUNT' using errcode = '22023', detail = 'label'; end if;
  v_code := 'FIX-' || lpad(private.next_seq(v_co, 'fixed_asset')::text, 6, '0');
  -- Écriture d'abord (le grand livre refuse une période close) ; l'immobilisation est créée avec son écriture
  v_entry := private.gl_post(v_co, 'OD', p_date, 'Acquisition ' || v_code || ' ' || btrim(p_label), 'asset_acquisition', v_id,
    private.gl_line(c.asset_account, p_cost, 0, v_code) || private.gl_line(p_credit_account, 0, p_cost, v_code));
  insert into public.fixed_assets (id, company_id, code, label, category_id, acquisition_date, acquisition_cost, residual_value, credit_account, acquisition_entry_id)
  values (v_id, v_co, v_code, btrim(p_label), c.id, p_date, p_cost, p_residual, p_credit_account, v_entry);
  perform private.write_audit(v_co, 'assets.acquire', 'fixed_asset', v_id::text, v_code, null,
    jsonb_build_object('cost', p_cost, 'residual', p_residual, 'entry', v_entry), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.fixed_asset_document_add(p_asset uuid, p_kind text, p_reference text, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.fixed_assets%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('assets.write');
  select * into a from public.fixed_assets where id = p_asset and company_id = v_co;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status = 'disposed' then raise exception 'FIXED_ASSET_BAD_STATUS' using errcode = '55000'; end if;
  insert into public.fixed_asset_documents (id, company_id, asset_id, kind, reference, document_date)
  values (v_id, v_co, a.id, p_kind, btrim(p_reference), p_date);
  perform private.write_audit(v_co, 'assets.document_add', 'fixed_asset', a.id::text, a.code, null,
    jsonb_build_object('kind', p_kind, 'reference', btrim(p_reference)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Mise en service : justificatif fournisseur, règles validées à la date, durée figée
create function public.fixed_asset_commission(p_asset uuid, p_in_service date, p_acc_rule text, p_tax_rule text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.fixed_assets%rowtype; ra public.asset_rule_sets%rowtype; rt public.asset_rule_sets%rowtype;
  v_minor int := (select c.minor_units from public.currencies c where c.code = private.base_currency());
begin
  perform private.require_perm('assets.write');
  select * into a from public.fixed_assets where id = p_asset and company_id = v_co for update;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status <> 'draft' then raise exception 'FIXED_ASSET_BAD_STATUS' using errcode = '55000'; end if;
  if p_in_service is null or p_in_service < a.acquisition_date then raise exception 'FIXED_ASSET_BAD_DATE' using errcode = '22023'; end if;
  if not exists (select 1 from public.fixed_asset_documents d where d.asset_id = a.id and d.kind = 'supplier_invoice') then
    raise exception 'FIXED_ASSET_DOCUMENT_REQUIRED' using errcode = '55000';
  end if;
  ra := private.asset_rule_at(v_co, 'accounting', p_acc_rule, p_in_service);
  rt := private.asset_rule_at(v_co, 'tax', p_tax_rule, p_in_service);
  if (a.acquisition_cost - a.residual_value) < ra.useful_life_months * power(10, -v_minor) then
    raise exception 'FIXED_ASSET_LIFE_TOO_SHORT' using errcode = '22023';
  end if;
  update public.fixed_assets set status = 'in_service', in_service_date = p_in_service,
    acc_rule_code = ra.code, acc_life_months = ra.useful_life_months, tax_rule_code = rt.code, tax_life_months = rt.useful_life_months
   where id = a.id;
  perform private.write_audit(v_co, 'assets.commission', 'fixed_asset', a.id::text, a.code, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'in_service', 'acc_life', ra.useful_life_months, 'tax_life', rt.useful_life_months), '{}'::jsonb, 'rpc');
end $$;

-- Dotation d'un mois : une écriture OD par mois et par société, idempotente, par catégorie ; la période close est refusée par le grand livre
create function public.fixed_asset_depreciation_post(p_year int, p_month int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_src uuid; v_entry uuid; v_lines jsonb := '[]'::jsonb; c record; v_day date;
begin
  perform private.require_perm('assets.write');
  if p_year is null or p_year not between 2000 and 2100 or p_month is null or p_month not between 1 and 12 then
    raise exception 'FIXED_ASSET_PERIOD_INVALID' using errcode = '22023';
  end if;
  if exists (select 1 from public.fixed_asset_depreciation_posted p where p.company_id = v_co and p.period_year = p_year and p.period_month = p_month) then
    return (select p.entry_id from public.fixed_asset_depreciation_posted p where p.company_id = v_co and p.period_year = p_year and p.period_month = p_month limit 1);
  end if;
  v_day := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_src := md5(v_co::text || '|dep|' || p_year::text || '|' || p_month::text)::uuid;
  for c in
    select cat.depreciation_account as dep, cat.expense_account as exp, sum(s.amount) as amt
      from public.fixed_assets a
      join public.fixed_asset_categories cat on cat.id = a.category_id
      join lateral private.asset_schedule(a.acquisition_cost, a.residual_value, a.acc_life_months, a.in_service_date) s
        on s.period_year = p_year and s.period_month = p_month
     where a.company_id = v_co and a.status = 'in_service'
     group by cat.depreciation_account, cat.expense_account
     order by cat.expense_account
  loop
    v_lines := v_lines || private.gl_line(c.exp, c.amt, 0, 'Dotation ' || p_year || '-' || lpad(p_month::text, 2, '0'))
                       || private.gl_line(c.dep, 0, c.amt, 'Dotation ' || p_year || '-' || lpad(p_month::text, 2, '0'));
  end loop;
  if jsonb_array_length(v_lines) = 0 then return null; end if;
  v_entry := private.gl_post(v_co, 'OD', v_day, 'Dotations aux amortissements ' || p_year || '-' || lpad(p_month::text, 2, '0'),
    'asset_depreciation', v_src, v_lines);
  insert into public.fixed_asset_depreciation_posted (company_id, asset_id, period_year, period_month, amount, entry_id)
  select v_co, a.id, p_year, p_month, s.amount, v_entry
    from public.fixed_assets a
    join lateral private.asset_schedule(a.acquisition_cost, a.residual_value, a.acc_life_months, a.in_service_date) s
      on s.period_year = p_year and s.period_month = p_month
   where a.company_id = v_co and a.status = 'in_service';
  perform private.write_audit(v_co, 'assets.depreciation_post', 'fixed_asset_period', v_entry::text, p_year || '-' || p_month, null,
    jsonb_build_object('entry', v_entry), '{}'::jsonb, 'rpc');
  return v_entry;
end $$;

-- Cession : toutes les dotations jusqu'au mois de cession comptabilisées ; écriture équilibrée ; plus ou moins-value
create function public.fixed_asset_dispose(p_asset uuid, p_date date, p_proceeds numeric, p_proceeds_account text, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.fixed_assets%rowtype; cat public.fixed_asset_categories%rowtype;
  v_acc numeric; v_nbv numeric; v_gain numeric := 0; v_loss numeric := 0; v_pending int; v_lines jsonb := '[]'::jsonb; v_entry uuid; v_id uuid := gen_random_uuid();
  v_reason text := btrim(coalesce(p_reason, '')); v_label text;
begin
  perform private.require_perm('assets.write');
  select * into a from public.fixed_assets where id = p_asset and company_id = v_co for update;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status <> 'in_service' then raise exception 'FIXED_ASSET_BAD_STATUS' using errcode = '55000'; end if;
  if p_date is null or p_date < a.in_service_date then raise exception 'FIXED_ASSET_BAD_DATE' using errcode = '22023'; end if;
  if p_proceeds is null or p_proceeds < 0 then raise exception 'FIXED_ASSET_BAD_AMOUNT' using errcode = '22023'; end if;
  if p_proceeds > 0 and p_proceeds_account is null then raise exception 'FIXED_ASSET_BAD_AMOUNT' using errcode = '22023', detail = 'account'; end if;
  if length(v_reason) < 5 then raise exception 'FIXED_ASSET_REASON_REQUIRED' using errcode = '22023'; end if;
  select count(*) into v_pending from private.asset_schedule(a.acquisition_cost, a.residual_value, a.acc_life_months, a.in_service_date) s
   where (s.period_year, s.period_month) <= (extract(year from p_date)::int, extract(month from p_date)::int)
     and not exists (select 1 from public.fixed_asset_depreciation_posted p where p.asset_id = a.id and p.period_year = s.period_year and p.period_month = s.period_month);
  if v_pending > 0 then raise exception 'FIXED_ASSET_DEPRECIATION_PENDING' using errcode = '55000', detail = v_pending::text; end if;
  select * into cat from public.fixed_asset_categories where id = a.category_id;
  select coalesce(sum(p.amount), 0) into v_acc from public.fixed_asset_depreciation_posted p where p.asset_id = a.id;
  v_nbv := a.acquisition_cost - v_acc;
  v_gain := greatest(p_proceeds - v_nbv, 0);
  v_loss := greatest(v_nbv - p_proceeds, 0);
  v_label := 'Cession ' || a.code;
  if v_acc > 0 then v_lines := v_lines || private.gl_line(cat.depreciation_account, v_acc, 0, v_label); end if;
  if p_proceeds > 0 then v_lines := v_lines || private.gl_line(p_proceeds_account, p_proceeds, 0, v_label); end if;
  if v_loss > 0 then v_lines := v_lines || private.gl_line(cat.disposal_loss_account, v_loss, 0, v_label); end if;
  v_lines := v_lines || private.gl_line(cat.asset_account, 0, a.acquisition_cost, v_label);
  if v_gain > 0 then v_lines := v_lines || private.gl_line(cat.disposal_gain_account, 0, v_gain, v_label); end if;
  v_entry := private.gl_post(v_co, 'OD', p_date, 'Cession ' || a.code || ' : ' || v_reason, 'asset_disposal', a.id, v_lines);
  insert into public.fixed_asset_disposals (id, company_id, asset_id, disposal_date, proceeds, proceeds_account, cost, accumulated,
    net_book_value, gain, loss, entry_id, reason)
  values (v_id, v_co, a.id, p_date, p_proceeds, case when p_proceeds > 0 then p_proceeds_account end, a.acquisition_cost, v_acc, v_nbv, v_gain, v_loss, v_entry, v_reason);
  update public.fixed_assets set status = 'disposed' where id = a.id;
  perform private.write_audit(v_co, 'assets.dispose', 'fixed_asset', a.id::text, a.code, jsonb_build_object('status', 'in_service'),
    jsonb_build_object('status', 'disposed', 'proceeds', p_proceeds, 'gain', v_gain, 'loss', v_loss), jsonb_build_object('reason', v_reason), 'rpc');
  return v_id;
end $$;

-- Contrôle de cession : l'écriture équilibre, retire le coût et l'amortissement cumulé, et constate produit, plus ou moins-value
create function public.fixed_asset_disposal_check(p_disposal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.fixed_asset_disposals%rowtype; cat public.fixed_asset_categories%rowtype; a public.fixed_assets%rowtype;
  v_dr numeric; v_cr numeric; v_proceeds numeric; v_cost numeric; v_acc numeric; v_gain numeric; v_loss numeric;
begin
  perform private.require_perm('finance.read');
  select * into d from public.fixed_asset_disposals where id = p_disposal and company_id = v_co;
  if not found then raise exception 'FIXED_ASSET_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into a from public.fixed_assets where id = d.asset_id;
  select * into cat from public.fixed_asset_categories where id = a.category_id;
  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_dr, v_cr from public.gl_entry_lines l where l.entry_id = d.entry_id;
  select coalesce(sum(l.debit), 0) into v_proceeds from public.gl_entry_lines l join public.gl_accounts ac on ac.id = l.account_id
   where l.entry_id = d.entry_id and ac.code = coalesce(d.proceeds_account, '');
  select coalesce(sum(l.credit), 0) into v_cost from public.gl_entry_lines l join public.gl_accounts ac on ac.id = l.account_id
   where l.entry_id = d.entry_id and ac.code = cat.asset_account;
  select coalesce(sum(l.debit), 0) into v_acc from public.gl_entry_lines l join public.gl_accounts ac on ac.id = l.account_id
   where l.entry_id = d.entry_id and ac.code = cat.depreciation_account;
  select coalesce(sum(l.credit), 0) into v_gain from public.gl_entry_lines l join public.gl_accounts ac on ac.id = l.account_id
   where l.entry_id = d.entry_id and ac.code = cat.disposal_gain_account;
  select coalesce(sum(l.debit), 0) into v_loss from public.gl_entry_lines l join public.gl_accounts ac on ac.id = l.account_id
   where l.entry_id = d.entry_id and ac.code = cat.disposal_loss_account;
  return jsonb_build_object(
    'balanced', v_dr = v_cr,
    'proceeds_ok', v_proceeds = d.proceeds,
    'cost_removed_ok', v_cost = d.cost,
    'accumulated_removed_ok', v_acc = d.accumulated,
    'gain_loss_ok', v_gain = d.gain and v_loss = d.loss,
    'register_matches_ledger', v_dr = v_cr and v_proceeds = d.proceeds and v_cost = d.cost and v_acc = d.accumulated and v_gain = d.gain and v_loss = d.loss);
end $$;

-- Inventaire : registre des immobilisations contre soldes du grand livre (coût et amortissement cumulé), à une date
create function public.fixed_asset_reconcile(p_as_of date) returns table (account text, kind text, register numeric, ledger numeric, difference numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('finance.read');
  return query
  with cost_reg as (
    select cat.asset_account as acc, sum(a.acquisition_cost) as amt
      from public.fixed_assets a join public.fixed_asset_categories cat on cat.id = a.category_id
     where a.company_id = v_co and a.acquisition_date <= p_as_of
       and not exists (select 1 from public.fixed_asset_disposals d where d.asset_id = a.id and d.disposal_date <= p_as_of)
     group by cat.asset_account
  ), acc_reg as (
    select cat.depreciation_account as acc, sum(p.amount) as amt
      from public.fixed_asset_depreciation_posted p join public.fixed_assets a on a.id = p.asset_id join public.fixed_asset_categories cat on cat.id = a.category_id
     where p.company_id = v_co and (p.period_year, p.period_month) <= (extract(year from p_as_of)::int, extract(month from p_as_of)::int)
       and not exists (select 1 from public.fixed_asset_disposals d where d.asset_id = a.id and d.disposal_date <= p_as_of)
     group by cat.depreciation_account
  ), accounts as (
    select c.asset_account as acc, 'cost'::text as k from public.fixed_asset_categories c where c.company_id = v_co
    union
    select c.depreciation_account, 'accumulated' from public.fixed_asset_categories c where c.company_id = v_co
  ), joined as (
    select ac.acc, ac.k,
           case when ac.k = 'cost' then coalesce((select r.amt from cost_reg r where r.acc = ac.acc), 0)
                else coalesce((select r.amt from acc_reg r where r.acc = ac.acc), 0) end as reg,
           case when ac.k = 'cost'
                then coalesce((select sum(l.debit - l.credit) from public.gl_entry_lines l join public.gl_entries e on e.id = l.entry_id
                               join public.gl_accounts g on g.id = l.account_id
                              where g.company_id = v_co and g.code = ac.acc and e.status = 'posted' and e.entry_date <= p_as_of), 0)
                else coalesce((select sum(l.credit - l.debit) from public.gl_entry_lines l join public.gl_entries e on e.id = l.entry_id
                               join public.gl_accounts g on g.id = l.account_id
                              where g.company_id = v_co and g.code = ac.acc and e.status = 'posted' and e.entry_date <= p_as_of), 0)
           end as led
      from accounts ac
  )
  select j.acc, j.k, j.reg::numeric, j.led::numeric, (j.reg - j.led)::numeric from joined j order by j.k, j.acc;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Privilèges
-- ---------------------------------------------------------------------------
revoke all on public.asset_rule_sets, public.fixed_asset_categories, public.fixed_assets, public.fixed_asset_documents,
  public.fixed_asset_depreciation_posted, public.fixed_asset_disposals from anon, authenticated;
grant select on public.asset_rule_sets, public.fixed_asset_categories, public.fixed_assets, public.fixed_asset_documents,
  public.fixed_asset_depreciation_posted, public.fixed_asset_disposals to authenticated;
grant all on public.asset_rule_sets, public.fixed_asset_categories, public.fixed_assets, public.fixed_asset_documents,
  public.fixed_asset_depreciation_posted, public.fixed_asset_disposals to service_role;

revoke execute on function public.asset_rule_create(text, text, int, date), public.asset_rule_validate(uuid, boolean),
  public.fixed_asset_category_create(text, text, text, text, text, text, text), public.fixed_asset_category_validate(uuid, boolean),
  public.fixed_asset_acquire(uuid, text, date, numeric, numeric, text), public.fixed_asset_document_add(uuid, text, text, date),
  public.fixed_asset_commission(uuid, date, text, text), public.fixed_asset_depreciation_post(int, int),
  public.fixed_asset_dispose(uuid, date, numeric, text, text), public.fixed_asset_disposal_check(uuid),
  public.fixed_asset_reconcile(date) from public, anon;
grant execute on function public.asset_rule_create(text, text, int, date), public.asset_rule_validate(uuid, boolean),
  public.fixed_asset_category_create(text, text, text, text, text, text, text), public.fixed_asset_category_validate(uuid, boolean),
  public.fixed_asset_acquire(uuid, text, date, numeric, numeric, text), public.fixed_asset_document_add(uuid, text, text, date),
  public.fixed_asset_commission(uuid, date, text, text), public.fixed_asset_depreciation_post(int, int),
  public.fixed_asset_dispose(uuid, date, numeric, text, text), public.fixed_asset_disposal_check(uuid),
  public.fixed_asset_reconcile(date) to authenticated, service_role;
