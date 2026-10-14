-- 0090_analytics_budgets_margins — Analytique, clés d'allocation, budgets versionnés, engagé, marges et décomposition des écarts (P065)
-- Existant conservé et réutilisé : centres de coûts (cost_centers, 0042, inchangés), budgets d'achat (purchase_budgets, 0057, inchangés),
-- rentabilité client et article (copilot_client_profit / copilot_product_profit, 0024 : marge = revenu − coût figé sur les lignes à coût connu),
-- coût figé des articles (bom_version_costs.snap_total, 0008), lignes de facture (invoice_lines, 0012), lignes de commande (sales_order_lines),
-- grand livre (gl_entry_lines, 0031), permissions costs.read (marges, coûts) et finance.read.
--
-- Définitions :
--  * Marge (base de devise, par ligne facturée) = (quantité nette × prix net) − (quantité nette × coût figé de l'article).
--    Lignes sans article ou sans coût figé : hors marge, comptées à part (couverture en %). Aucun coût n'est supposé.
--  * Réalisé = écritures comptabilisées (grand livre) rattachées à un centre par analytique (tags) ; engagé = engagements ouverts saisis ;
--    prévision = version de prévision validée ; budget = version initiale ou révisée validée. Quatre notions séparées, jamais additionnées.
--  * Clé d'allocation : pourcentages signés (total = 100,00 %), versionnés par date d'effet ; la version en vigueur à la date de l'écriture
--    s'applique ; chaque allocation garde sa formule (clé, version, pourcentages, règle d'arrondi) : elle est explicable.
--  * Budget : versions initiale (1 par année), révisées (motif obligatoire, après une initiale validée) et prévision ; une version validée
--    est figée ; les anciennes restent consultables. Aucune réécriture d'un budget validé.
--  * Décomposition des écarts marge réelle − marge budget : volume, mix, prix, coût/rendement. Identité exacte au total (sans double comptage) :
--    volume = (Qr − Qb) × m̄b ; mix = Σ qr (mb − m̄b) ; prix = Σ qr (pr − pb) ; coût/rendement = −Σ qr (cr − cb), où q=quantité, p=prix unitaire,
--    c=coût unitaire, m=p−c, m̄b=marge unitaire moyenne du budget. Un produit absent du budget a pb=pr, cb=cr (écart prix et coût nuls).
-- Erreurs : ANALYTIC_NOT_FOUND, ANALYTIC_BAD_STATUS, ANALYTIC_BAD_AMOUNT, ANALYTIC_BAD_LINE, ANALYTIC_ALREADY_ALLOCATED,
-- ANALYTIC_KEY_NOT_VALIDATED, ANALYTIC_KEY_MISSING, ANALYTIC_WEIGHTS_NOT_100, ANALYTIC_OVER_TAGGED, ANALYTIC_IMMUTABLE,
-- ANALYTIC_REASON_REQUIRED, ANALYTIC_EMPTY, ANALYTIC_BAD_MEMBER, ANALYTIC_NO_BUDGET, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('analytic.write', 'finance', 'Saisir l’analytique, les allocations et les budgets', 'Rattachements, allocations, versions de budget, engagements'),
  ('analytic.validate', 'finance', 'Valider les clés d’allocation et les budgets', 'Signature distincte de la saisie')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('analytic.write', 'analytic.validate')
where r.is_system and r.code in ('admin', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Membres analytiques : centres (coût ou profit), produits, commandes, ateliers, canaux
-- ---------------------------------------------------------------------------
create table public.analytic_members (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  axis        text not null check (axis in ('center', 'product', 'order', 'workshop', 'channel')),
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),
  label       text not null check (length(btrim(label)) between 2 and 120),
  kind        text check (kind is null or kind in ('cost', 'profit')),
  article_id  uuid references public.articles(id),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  check ((axis = 'center') = (kind is not null)),
  check (article_id is null or axis = 'product'),
  unique (company_id, axis, code)
);
alter table public.analytic_members enable row level security;
create policy analytic_members_select on public.analytic_members for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function public.analytic_member_create(p_axis text, p_code text, p_label text, p_kind text, p_article uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('analytic.write');
  if p_article is not null and not exists (select 1 from public.articles a where a.id = p_article and a.company_id = v_co) then
    raise exception 'ANALYTIC_BAD_MEMBER' using errcode = '22023';
  end if;
  insert into public.analytic_members (id, company_id, axis, code, label, kind, article_id) values (v_id, v_co, p_axis, p_code, btrim(p_label), p_kind, p_article);
  perform private.write_audit(v_co, 'analytic.member_create', 'analytic_member', v_id::text, p_code, null,
    jsonb_build_object('axis', p_axis, 'kind', p_kind), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Clés d'allocation versionnées et signées ; allocations explicables
-- ---------------------------------------------------------------------------
create table public.analytic_allocation_keys (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9_]{2,30}$'),
  label       text not null check (length(btrim(label)) between 2 and 120),
  unique (company_id, code)
);
alter table public.analytic_allocation_keys enable row level security;
create policy analytic_allocation_keys_select on public.analytic_allocation_keys for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.analytic_allocation_key_versions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  key_id        uuid not null references public.analytic_allocation_keys(id),
  version       int not null check (version >= 1),
  effective_from date not null,
  status        text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  validated_by  uuid,
  validated_at  timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (key_id, version)
);
alter table public.analytic_allocation_key_versions enable row level security;
create policy analytic_allocation_key_versions_select on public.analytic_allocation_key_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.analytic_allocation_key_weights (
  version_id  uuid not null references public.analytic_allocation_key_versions(id),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  member_id   uuid not null references public.analytic_members(id),
  weight_pct  numeric(7,4) not null check (weight_pct > 0 and weight_pct <= 100),
  primary key (version_id, member_id)
);
alter table public.analytic_allocation_key_weights enable row level security;
create policy analytic_allocation_key_weights_select on public.analytic_allocation_key_weights for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.analytic_allocation_runs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  gl_line_id    uuid not null unique references public.gl_entry_lines(id),
  key_version_id uuid not null references public.analytic_allocation_key_versions(id),
  amount        numeric(15,2) not null check (amount > 0),
  formula       jsonb not null,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
alter table public.analytic_allocation_runs enable row level security;
create policy analytic_allocation_runs_select on public.analytic_allocation_runs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

-- Rattachements : une ligne comptable peut être répartie sur plusieurs membres, jamais au-delà de son montant
create table public.analytic_line_tags (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  gl_line_id  uuid not null references public.gl_entry_lines(id),
  member_id   uuid not null references public.analytic_members(id),
  run_id      uuid references public.analytic_allocation_runs(id),
  amount      numeric(15,2) not null check (amount > 0),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (gl_line_id, member_id)
);
alter table public.analytic_line_tags enable row level security;
create policy analytic_line_tags_select on public.analytic_line_tags for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.analytic_tags_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_amount numeric; v_tagged numeric;
begin
  select abs(l.debit - l.credit) into v_amount from public.gl_entry_lines l where l.id = new.gl_line_id;
  select coalesce(sum(t.amount), 0) into v_tagged from public.analytic_line_tags t where t.gl_line_id = new.gl_line_id;
  if v_tagged > v_amount then raise exception 'ANALYTIC_OVER_TAGGED' using errcode = '22023', detail = v_tagged::text || ' / ' || v_amount::text; end if;
  return new;
end $$;
revoke execute on function private.analytic_tags_check() from public, anon, authenticated;
create trigger analytic_line_tags_check_ai after insert on public.analytic_line_tags
  for each row execute function private.analytic_tags_check();

-- Immuabilité : versions et poids figés après signature ; rattachements et allocations jamais modifiés
create function private.analytic_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'analytic_allocation_key_versions' then
    if tg_op = 'DELETE' and old.status = 'a_valider' then return old; end if;
    if tg_op = 'UPDATE' and old.status = 'a_valider' and new.status = 'valide'
       and (new.id, new.company_id, new.key_id, new.version, new.effective_from, new.created_by, new.created_at)
           is not distinct from (old.id, old.company_id, old.key_id, old.version, old.effective_from, old.created_by, old.created_at) then
      return new;
    end if;
  elsif tg_table_name = 'analytic_allocation_key_weights' then
    if tg_op = 'DELETE' and exists (select 1 from public.analytic_allocation_key_versions v where v.id = old.version_id and v.status = 'a_valider') then
      return old;
    end if;
  elsif tg_table_name = 'analytic_commitments' then
    if tg_op = 'UPDATE' and old.status = 'open' and new.status = 'closed'
       and (new.id, new.company_id, new.member_id, new.amount, new.reference, new.commitment_date, new.created_by, new.created_at)
           is not distinct from (old.id, old.company_id, old.member_id, old.amount, old.reference, old.commitment_date, old.created_by, old.created_at) then
      return new;
    end if;
  end if;
  raise exception 'ANALYTIC_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.analytic_immutable() from public, anon, authenticated;
create trigger analytic_key_versions_immutable_bud before update or delete on public.analytic_allocation_key_versions
  for each row execute function private.analytic_immutable();
create trigger analytic_key_weights_immutable_bud before update or delete on public.analytic_allocation_key_weights
  for each row execute function private.analytic_immutable();
create trigger analytic_allocation_runs_immutable before update or delete on public.analytic_allocation_runs
  for each row execute function private.analytic_immutable();
create trigger analytic_line_tags_immutable before update or delete on public.analytic_line_tags
  for each row execute function private.analytic_immutable();

create function public.analytic_key_create(p_code text, p_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('analytic.write');
  insert into public.analytic_allocation_keys (id, company_id, code, label) values (v_id, v_co, p_code, btrim(p_label));
  perform private.write_audit(v_co, 'analytic.key_create', 'analytic_key', v_id::text, p_code, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Version de clé : pourcentages par membre (total exact 100,00 à la signature)
create function public.analytic_key_version_create(p_key uuid, p_effective_from date, p_weights jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_ver int; v_id uuid := gen_random_uuid(); w jsonb;
begin
  perform private.require_perm('analytic.write');
  if not exists (select 1 from public.analytic_allocation_keys k where k.id = p_key and k.company_id = v_co) then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_weights is null or jsonb_typeof(p_weights) <> 'array' or jsonb_array_length(p_weights) = 0 then raise exception 'ANALYTIC_EMPTY' using errcode = '22023'; end if;
  select coalesce(max(v.version), 0) + 1 into v_ver from public.analytic_allocation_key_versions v where v.key_id = p_key;
  insert into public.analytic_allocation_key_versions (id, company_id, key_id, version, effective_from) values (v_id, v_co, p_key, v_ver, p_effective_from);
  for w in select * from jsonb_array_elements(p_weights) loop
    if not exists (select 1 from public.analytic_members m where m.id = (w->>'member')::uuid and m.company_id = v_co) then
      raise exception 'ANALYTIC_BAD_MEMBER' using errcode = '22023';
    end if;
    insert into public.analytic_allocation_key_weights (version_id, company_id, member_id, weight_pct) values (v_id, v_co, (w->>'member')::uuid, (w->>'pct')::numeric);
  end loop;
  perform private.write_audit(v_co, 'analytic.key_version_create', 'analytic_key', p_key::text, null, null,
    jsonb_build_object('version', v_ver, 'effective_from', p_effective_from), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.analytic_key_version_validate(p_version uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v public.analytic_allocation_key_versions%rowtype; v_sum numeric; v_n int;
begin
  perform private.require_perm('analytic.validate');
  select * into v from public.analytic_allocation_key_versions x where x.id = p_version and x.company_id = v_co for update;
  if not found then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.status <> 'a_valider' then raise exception 'ANALYTIC_BAD_STATUS' using errcode = '55000'; end if;
  if v.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'analytic_key'; end if;
  if p_validate then
    select coalesce(sum(w.weight_pct), 0), count(*) into v_sum, v_n from public.analytic_allocation_key_weights w where w.version_id = v.id;
    if v_sum <> 100 then raise exception 'ANALYTIC_WEIGHTS_NOT_100' using errcode = '22023', detail = v_sum::text; end if;
    update public.analytic_allocation_key_versions set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = v.id;
  else
    delete from public.analytic_allocation_key_weights where version_id = v.id;
    delete from public.analytic_allocation_key_versions where id = v.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'analytic.key_validate' else 'analytic.key_reject' end, 'analytic_key_version', v.id::text, null,
    jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- Version en vigueur à une date pour une clé
create function private.analytic_key_version_at(p_company uuid, p_key uuid, p_date date) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  select v.id into v_id from public.analytic_allocation_key_versions v
   where v.company_id = p_company and v.key_id = p_key and v.status = 'valide' and v.effective_from <= p_date
   order by v.effective_from desc, v.version desc limit 1;
  if v_id is null then
    if exists (select 1 from public.analytic_allocation_key_versions v where v.company_id = p_company and v.key_id = p_key and v.effective_from <= p_date) then
      raise exception 'ANALYTIC_KEY_NOT_VALIDATED' using errcode = '55000';
    end if;
    raise exception 'ANALYTIC_KEY_MISSING' using errcode = 'P0002';
  end if;
  return v_id;
end $$;
revoke execute on function private.analytic_key_version_at(uuid, uuid, date) from public, anon, authenticated;

-- Allocation d'une ligne comptable (charge ou produit) : parts arrondies au centime, le dernier membre porte le reste.
create function public.analytic_allocate_line(p_line uuid, p_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_line record; v_amount numeric; v_version uuid; v_run uuid := gen_random_uuid();
  m record; v_share numeric; v_left numeric; v_formula jsonb := '[]'::jsonb; v_idx int := 0; v_n int; v_count int := 0; v_ver int; v_key_code text;
begin
  perform private.require_perm('analytic.write');
  select l.debit, l.credit, e.entry_date, a.code as acc_code, a.account_class as cls, e.status into v_line
    from public.gl_entry_lines l join public.gl_entries e on e.id = l.entry_id join public.gl_accounts a on a.id = l.account_id
   where l.id = p_line and e.company_id = v_co;
  if not found then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.status <> 'posted' or v_line.cls not in (6, 7) then raise exception 'ANALYTIC_BAD_LINE' using errcode = '22023'; end if;
  if exists (select 1 from public.analytic_allocation_runs r where r.gl_line_id = p_line) then raise exception 'ANALYTIC_ALREADY_ALLOCATED' using errcode = '55000'; end if;
  v_amount := abs(v_line.debit - v_line.credit);
  if v_amount <= 0 then raise exception 'ANALYTIC_BAD_LINE' using errcode = '22023'; end if;
  v_version := private.analytic_key_version_at(v_co, p_key, v_line.entry_date);
  select v.version, k.code into v_ver, v_key_code from public.analytic_allocation_key_versions v join public.analytic_allocation_keys k on k.id = v.key_id where v.id = v_version;
  select count(*) into v_n from public.analytic_allocation_key_weights w where w.version_id = v_version;
  v_left := v_amount;
  for m in select w.member_id, w.weight_pct, mb.code from public.analytic_allocation_key_weights w join public.analytic_members mb on mb.id = w.member_id
           where w.version_id = v_version order by mb.code loop
    v_idx := v_idx + 1;
    v_share := case when v_idx = v_n then v_left else round(v_amount * m.weight_pct / 100, 2) end;
    v_left := v_left - v_share;
    v_formula := v_formula || jsonb_build_object('member', m.code, 'member_id', m.member_id, 'pct', m.weight_pct, 'amount', v_share);
    v_count := v_count + 1;
  end loop;
  insert into public.analytic_allocation_runs (id, company_id, gl_line_id, key_version_id, amount, formula)
  values (v_run, v_co, p_line, v_version, v_amount, jsonb_build_object('key', v_key_code, 'version', v_ver, 'rule', 'centime, dernier membre porte le reste', 'shares', v_formula));
  for v_idx in 0 .. jsonb_array_length(v_formula) - 1 loop
    insert into public.analytic_line_tags (company_id, gl_line_id, member_id, run_id, amount)
    values (v_co, p_line, (v_formula -> v_idx ->> 'member_id')::uuid, v_run, (v_formula -> v_idx ->> 'amount')::numeric);
  end loop;
  perform private.write_audit(v_co, 'analytic.allocate', 'gl_entry_line', p_line::text, v_key_code, null,
    jsonb_build_object('amount', v_amount, 'version', v_ver, 'members', v_count), '{}'::jsonb, 'rpc');
  return v_run;
end $$;

-- Rattachement direct (sans clé) : un membre, un montant ne dépassant pas la ligne
create function public.analytic_tag_line(p_line uuid, p_member uuid, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_line record; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('analytic.write');
  select l.debit, l.credit, a.account_class as cls, e.status into v_line
    from public.gl_entry_lines l join public.gl_entries e on e.id = l.entry_id join public.gl_accounts a on a.id = l.account_id
   where l.id = p_line and e.company_id = v_co;
  if not found then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.status <> 'posted' or v_line.cls not in (6, 7) then raise exception 'ANALYTIC_BAD_LINE' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'ANALYTIC_BAD_AMOUNT' using errcode = '22023'; end if;
  insert into public.analytic_line_tags (id, company_id, gl_line_id, member_id, amount) values (v_id, v_co, p_line, p_member, p_amount);
  perform private.write_audit(v_co, 'analytic.tag', 'gl_entry_line', p_line::text, null, null, jsonb_build_object('amount', p_amount), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Budgets versionnés : initial (une par année), révisés (motif), prévision ; figés après validation
-- ---------------------------------------------------------------------------
create table public.analytic_budget_versions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  budget_kind   text not null check (budget_kind in ('initial', 'revised', 'forecast')),
  fiscal_year   int not null check (fiscal_year between 2000 and 2100),
  version       int not null check (version >= 1),
  reason        text check (reason is null or length(btrim(reason)) between 5 and 300),
  status        text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  validated_by  uuid,
  validated_at  timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  check (budget_kind = 'initial' or reason is not null or version = 1),
  unique (company_id, budget_kind, fiscal_year, version)
);
alter table public.analytic_budget_versions enable row level security;
create policy analytic_budget_versions_select on public.analytic_budget_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.analytic_budget_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  version_id   uuid not null references public.analytic_budget_versions(id),
  line_kind    text not null check (line_kind in ('product', 'center_expense')),
  member_id    uuid not null references public.analytic_members(id),
  month        int not null check (month between 1 and 12),
  qty          numeric(14,2),
  unit_price   numeric(14,4),
  unit_cost    numeric(14,4),
  amount       numeric(15,2),
  check (line_kind = 'center_expense' or (qty >= 0 and unit_price >= 0 and unit_cost >= 0 and amount is null)),
  check (line_kind = 'product' or (amount >= 0 and qty is null and unit_price is null and unit_cost is null)),
  unique (version_id, line_kind, member_id, month)
);
alter table public.analytic_budget_lines enable row level security;
create policy analytic_budget_lines_select on public.analytic_budget_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.analytic_budget_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'analytic_budget_versions' then
    if tg_op = 'DELETE' and old.status = 'a_valider' then return old; end if;
    if tg_op = 'UPDATE' and old.status = 'a_valider' and new.status = 'valide'
       and (new.id, new.company_id, new.budget_kind, new.fiscal_year, new.version, new.reason, new.created_by, new.created_at)
           is not distinct from (old.id, old.company_id, old.budget_kind, old.fiscal_year, old.version, old.reason, old.created_by, old.created_at) then
      return new;
    end if;
  elsif tg_table_name = 'analytic_budget_lines' then
    if tg_op = 'INSERT' and exists (select 1 from public.analytic_budget_versions v where v.id = new.version_id and v.status = 'a_valider') then
      return new;
    end if;
    if tg_op = 'DELETE' and exists (select 1 from public.analytic_budget_versions v where v.id = old.version_id and v.status = 'a_valider') then
      return old;
    end if;
  end if;
  raise exception 'ANALYTIC_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.analytic_budget_guard() from public, anon, authenticated;
create trigger analytic_budget_versions_guard_bud before update or delete on public.analytic_budget_versions
  for each row execute function private.analytic_budget_guard();
create trigger analytic_budget_lines_guard_biud before insert or update or delete on public.analytic_budget_lines
  for each row execute function private.analytic_budget_guard();

create function public.analytic_budget_version_create(p_kind text, p_year int, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_ver int; v_id uuid := gen_random_uuid(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('analytic.write');
  if p_kind = 'initial' and exists (select 1 from public.analytic_budget_versions b where b.company_id = v_co and b.budget_kind = 'initial' and b.fiscal_year = p_year) then
    raise exception 'ANALYTIC_BAD_STATUS' using errcode = '55000', detail = 'initial exists';
  end if;
  if p_kind = 'revised' then
    if not exists (select 1 from public.analytic_budget_versions b where b.company_id = v_co and b.budget_kind = 'initial' and b.fiscal_year = p_year and b.status = 'valide') then
      raise exception 'ANALYTIC_NO_BUDGET' using errcode = '55000';
    end if;
    if v_reason is null or length(v_reason) < 5 then raise exception 'ANALYTIC_REASON_REQUIRED' using errcode = '22023'; end if;
  end if;
  select coalesce(max(b.version), 0) + 1 into v_ver from public.analytic_budget_versions b where b.company_id = v_co and b.budget_kind = p_kind and b.fiscal_year = p_year;
  insert into public.analytic_budget_versions (id, company_id, budget_kind, fiscal_year, version, reason) values (v_id, v_co, p_kind, p_year, v_ver, v_reason);
  perform private.write_audit(v_co, 'analytic.budget_version_create', 'analytic_budget', v_id::text, p_kind || ' ' || p_year || ' v' || v_ver, null,
    jsonb_build_object('kind', p_kind, 'version', v_ver), jsonb_build_object('reason', v_reason), 'rpc');
  return v_id;
end $$;

-- Lignes d'une version non validée : produit (quantité, prix, coût unitaires) ou dépense de centre (montant), par mois
create function public.analytic_budget_lines_set(p_version uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v public.analytic_budget_versions%rowtype; l jsonb;
begin
  perform private.require_perm('analytic.write');
  select * into v from public.analytic_budget_versions x where x.id = p_version and x.company_id = v_co for update;
  if not found then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.status <> 'a_valider' then raise exception 'ANALYTIC_BAD_STATUS' using errcode = '55000'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'ANALYTIC_EMPTY' using errcode = '22023'; end if;
  delete from public.analytic_budget_lines where version_id = v.id;
  for l in select * from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from public.analytic_members m where m.id = (l->>'member')::uuid and m.company_id = v_co
                   and ((l->>'kind' = 'center_expense' and m.axis = 'center') or (l->>'kind' = 'product' and m.article_id is not null))) then
      raise exception 'ANALYTIC_BAD_MEMBER' using errcode = '22023';
    end if;
    insert into public.analytic_budget_lines (company_id, version_id, line_kind, member_id, month, qty, unit_price, unit_cost, amount)
    values (v_co, v.id, l->>'kind', (l->>'member')::uuid, (l->>'month')::int,
            (l->>'qty')::numeric, (l->>'unit_price')::numeric, (l->>'unit_cost')::numeric, (l->>'amount')::numeric);
  end loop;
  perform private.write_audit(v_co, 'analytic.budget_lines_set', 'analytic_budget', v.id::text, null, null,
    jsonb_build_object('lines', jsonb_array_length(p_lines)), '{}'::jsonb, 'rpc');
end $$;

create function public.analytic_budget_version_validate(p_version uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v public.analytic_budget_versions%rowtype;
begin
  perform private.require_perm('analytic.validate');
  select * into v from public.analytic_budget_versions x where x.id = p_version and x.company_id = v_co for update;
  if not found then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.status <> 'a_valider' then raise exception 'ANALYTIC_BAD_STATUS' using errcode = '55000'; end if;
  if v.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'budget'; end if;
  if not exists (select 1 from public.analytic_budget_lines bl where bl.version_id = v.id) then raise exception 'ANALYTIC_EMPTY' using errcode = '22023'; end if;
  if p_validate then
    update public.analytic_budget_versions set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = v.id;
  else
    delete from public.analytic_budget_lines where version_id = v.id;
    delete from public.analytic_budget_versions where id = v.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'analytic.budget_validate' else 'analytic.budget_reject' end, 'analytic_budget', v.id::text, null,
    jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- Engagements ouverts par centre (saisis, clôturés avec motif)
create table public.analytic_commitments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  member_id    uuid not null references public.analytic_members(id),
  amount       numeric(15,2) not null check (amount > 0),
  reference    text not null check (length(btrim(reference)) between 3 and 80),
  commitment_date date not null,
  status       text not null default 'open' check (status in ('open', 'closed')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  closed_by    uuid,
  closed_at    timestamptz,
  close_reason text check (close_reason is null or length(btrim(close_reason)) between 5 and 300),
  check ((status = 'closed') = (closed_at is not null and close_reason is not null))
);
alter table public.analytic_commitments enable row level security;
create policy analytic_commitments_select on public.analytic_commitments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
create trigger analytic_commitments_immutable_bud before update or delete on public.analytic_commitments
  for each row execute function private.analytic_immutable();

create function public.analytic_commitment_add(p_member uuid, p_amount numeric, p_reference text, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('analytic.write');
  if not exists (select 1 from public.analytic_members m where m.id = p_member and m.company_id = v_co and m.axis = 'center') then
    raise exception 'ANALYTIC_BAD_MEMBER' using errcode = '22023';
  end if;
  insert into public.analytic_commitments (id, company_id, member_id, amount, reference, commitment_date) values (v_id, v_co, p_member, p_amount, btrim(p_reference), p_date);
  perform private.write_audit(v_co, 'analytic.commitment_add', 'analytic_commitment', v_id::text, btrim(p_reference), null,
    jsonb_build_object('amount', p_amount), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Clôture d'un engagement : les écritures ouvertes deviennent réalisées, la clôture est motivée et tracée
create function public.analytic_commitment_close(p_commitment uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.analytic_commitments%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('analytic.write');
  if length(v_reason) < 5 then raise exception 'ANALYTIC_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into c from public.analytic_commitments where id = p_commitment and company_id = v_co;
  if not found then raise exception 'ANALYTIC_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'open' then raise exception 'ANALYTIC_BAD_STATUS' using errcode = '55000'; end if;
  update public.analytic_commitments set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_reason = v_reason where id = c.id;
  perform private.write_audit(v_co, 'analytic.commitment_close', 'analytic_commitment', c.id::text, c.reference, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'closed'), jsonb_build_object('reason', v_reason), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Marges réelles par article (base de devise), rapprochées du grand livre
-- ---------------------------------------------------------------------------
-- Lignes facturées de la période : quantité nette, revenu net en devise de base, coût figé (si connu)
-- Coût figé : nomenclature active de l'article (boms.article_id → boms.active_version_id → bom_version_costs.snap_total).
-- Note : articles.active_version_id référence des versions d'article, pas des nomenclatures ; le rapport de copilot (0024) lit ce champ et n'obtient jamais de coût.
create function private.analytic_article_actuals(p_company uuid, p_from date, p_to date)
returns table (article_id uuid, qty numeric, revenue numeric, revenue_known numeric, cost_known numeric, unit_cost_known boolean, lines int)
language plpgsql stable security definer set search_path = '' as $$
declare v_base char(3) := private.base_currency(); v_minor int := (select c.minor_units from public.currencies c where c.code = private.base_currency());
begin
  return query
  with ln as (
    select sl.article_id as art, (il.qty - il.qty_credited) as q,
           round((il.qty - il.qty_credited) * il.unit_price * (1 - il.discount_pct / 100) * i.fx_rate, v_minor) as rev,
           bc.snap_total as uc
      from public.invoices i
      join public.invoice_lines il on il.invoice_id = i.id
      left join public.sales_order_lines sl on sl.id = il.order_line_id
      left join public.boms b on b.article_id = sl.article_id and b.archived_at is null
      left join public.bom_version_costs bc on bc.version_id = b.active_version_id
     where i.company_id = p_company and i.status in ('issued', 'partially_paid', 'paid', 'credited')
       and i.issue_date between p_from and p_to and i.fx_rate is not null
  )
  select ln.art, sum(ln.q), sum(ln.rev),
         sum(ln.rev) filter (where ln.uc is not null),
         sum(ln.q * ln.uc) filter (where ln.uc is not null),
         null::boolean,
         count(*)::int
    from ln group by ln.art;
end $$;
revoke execute on function private.analytic_article_actuals(uuid, date, date) from public, anon, authenticated;

-- Rapport de marge par article : marge = revenu à coût connu − coût ; couverture = part du revenu à coût connu
create function public.analytic_margin_report(p_from date, p_to date) returns table (
  article_id uuid, article_code text, qty numeric, revenue numeric, margin numeric, margin_pct numeric, cost_coverage_pct numeric, lines int)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('invoices.read');
  perform private.require_perm('costs.read');
  return query
  select x.article_id, a.client_ref::text, x.qty, x.revenue,
         (x.revenue_known - x.cost_known),
         case when x.revenue_known > 0 then round(100 * (x.revenue_known - x.cost_known) / x.revenue_known, 2) end,
         case when x.revenue > 0 then round(100 * x.revenue_known / x.revenue, 2) end,
         x.lines
    from private.analytic_article_actuals(v_co, p_from, p_to) x
    left join public.articles a on a.id = x.article_id
   order by x.revenue desc nulls last;
end $$;

-- Rapprochement : revenu facturé (lignes) contre compte de ventes 701 du grand livre sur la même période
create function public.analytic_margin_reconcile(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_rev numeric; v_gl numeric; v_unpriced numeric;
begin
  perform private.require_perm('invoices.read');
  perform private.require_perm('costs.read');
  select coalesce(sum(x.revenue), 0) into v_rev from private.analytic_article_actuals(v_co, p_from, p_to) x;
  select coalesce(sum(l.credit - l.debit), 0) into v_gl
    from public.gl_entry_lines l join public.gl_entries e on e.id = l.entry_id join public.gl_accounts a on a.id = l.account_id
   where e.company_id = v_co and e.status = 'posted' and a.code = '701' and e.entry_date between p_from and p_to;
  select coalesce(sum(x.revenue), 0) into v_unpriced from private.analytic_article_actuals(v_co, p_from, p_to) x where x.article_id is null;
  return jsonb_build_object('revenue_lines', v_rev, 'ledger_701', v_gl, 'difference', v_rev - v_gl, 'revenue_without_article', v_unpriced,
    'reconciled', v_rev = v_gl);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Décomposition des écarts de marge (budget versus réel), sans double comptage
-- ---------------------------------------------------------------------------
-- Lignes de comparaison par article : quantités, prix et coûts unitaires du budget (repli sur le réel si absent du budget) et du réel
create function private.analytic_variance_rows(p_company uuid, p_bver uuid, p_m1 int, p_m2 int, p_from date, p_to date)
returns table (art uuid, qb numeric, qa numeric, pb numeric, cb numeric, pa numeric, ca numeric)
language sql stable security definer set search_path = '' as $$
  with bud as (
    select mb.article_id as art, sum(bl.qty) as q, sum(bl.qty * bl.unit_price) as rev, sum(bl.qty * bl.unit_cost) as cst
      from public.analytic_budget_lines bl join public.analytic_members mb on mb.id = bl.member_id
     where bl.version_id = p_bver and bl.line_kind = 'product' and bl.month between p_m1 and p_m2 and mb.article_id is not null
     group by mb.article_id
  ), act as (
    select x.article_id as art, x.qty as q, x.revenue_known as rev, x.cost_known as cst
      from private.analytic_article_actuals(p_company, p_from, p_to) x
     where x.article_id is not null and x.revenue_known is not null and x.qty > 0
  ), j as (
    select coalesce(a.art, b.art) as art, coalesce(b.q, 0) as qb, coalesce(a.q, 0) as qa,
           case when coalesce(b.q, 0) > 0 then b.rev / b.q else a.rev / nullif(a.q, 0) end as pb,
           case when coalesce(b.q, 0) > 0 then b.cst / b.q else a.cst / nullif(a.q, 0) end as cb,
           a.rev / nullif(a.q, 0) as pa,
           a.cst / nullif(a.q, 0) as ca
      from act a full join bud b on b.art = a.art
  )
  select j.art, j.qb, j.qa, j.pb, j.cb, j.pa, j.ca from j where j.qb > 0 or j.qa > 0
$$;
revoke execute on function private.analytic_variance_rows(uuid, uuid, int, int, date, date) from public, anon, authenticated;

-- Décomposition : volume = (qa − qb) × m̄b ; mix = qa × (mb − m̄b) ; prix = qa × (pa − pb) ; coût/rendement = −qa × (ca − cb)
-- Total de ligne = somme des quatre composantes ; total général = variation de marge (réel − budget) : identité exacte.
create function public.analytic_variance_decompose(p_year int, p_month_from int, p_month_to int, p_budget_kind text)
returns table (article_id uuid, article_code text, qty_budget numeric, qty_actual numeric, volume numeric, mix numeric, price numeric, cost_yield numeric, total numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_bver uuid; v_from date := make_date(p_year, p_month_from, 1);
  v_to date := (make_date(p_year, p_month_to, 1) + interval '1 month - 1 day')::date;
begin
  perform private.require_perm('costs.read');
  perform private.require_perm('finance.read');
  select v.id into v_bver from public.analytic_budget_versions v
   where v.company_id = v_co and v.budget_kind = p_budget_kind and v.fiscal_year = p_year and v.status = 'valide'
   order by v.version desc limit 1;
  if v_bver is null then raise exception 'ANALYTIC_NO_BUDGET' using errcode = 'P0002'; end if;
  return query
  with r0 as (select * from private.analytic_variance_rows(v_co, v_bver, p_month_from, p_month_to, v_from, v_to)),
  r as (select r0.art, r0.qb, r0.qa, r0.pb, r0.cb, r0.pa, r0.ca, (r0.pb - r0.cb) as mb from r0),
  tot as (select coalesce(sum(r.qb), 0) as qbt, coalesce(sum(r.qb * r.mb) filter (where r.qb > 0), 0) as mbt from r),
  dec as (
    select r.art, r.qb, r.qa,
           (r.qa - r.qb) * (case when tot.qbt > 0 then tot.mbt / tot.qbt else 0 end) as vol,
           r.qa * (r.mb - (case when tot.qbt > 0 then tot.mbt / tot.qbt else 0 end)) as mix,
           case when r.qa > 0 then r.qa * (r.pa - r.pb) else 0 end as prc,
           case when r.qa > 0 then -r.qa * (r.ca - r.cb) else 0 end as cy
      from r cross join tot
  )
  select d.art, am.client_ref::text, d.qb, d.qa, d.vol, d.mix, d.prc, d.cy, d.vol + d.mix + d.prc + d.cy
    from dec d left join public.articles am on am.id = d.art
   order by am.client_ref;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Position par centre : budgets, réalisé, engagé, prévision (quatre notions séparées)
-- ---------------------------------------------------------------------------
create function public.analytic_center_position(p_year int, p_month int) returns table (
  member_id uuid, center_code text, budget_initial numeric, budget_revised numeric, forecast numeric, actual numeric, committed_open numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_init uuid; v_rev uuid; v_fc uuid;
begin
  perform private.require_perm('finance.read');
  select v.id into v_init from public.analytic_budget_versions v where v.company_id = v_co and v.budget_kind = 'initial' and v.fiscal_year = p_year and v.status = 'valide' order by v.version desc limit 1;
  select v.id into v_rev from public.analytic_budget_versions v where v.company_id = v_co and v.budget_kind = 'revised' and v.fiscal_year = p_year and v.status = 'valide' order by v.version desc limit 1;
  select v.id into v_fc from public.analytic_budget_versions v where v.company_id = v_co and v.budget_kind = 'forecast' and v.fiscal_year = p_year and v.status = 'valide' order by v.version desc limit 1;
  return query
  select m.id, m.code,
         (select sum(bl.amount) from public.analytic_budget_lines bl where bl.version_id = v_init and bl.member_id = m.id and bl.line_kind = 'center_expense' and bl.month <= p_month),
         (select sum(bl.amount) from public.analytic_budget_lines bl where bl.version_id = v_rev and bl.member_id = m.id and bl.line_kind = 'center_expense' and bl.month <= p_month),
         (select sum(bl.amount) from public.analytic_budget_lines bl where bl.version_id = v_fc and bl.member_id = m.id and bl.line_kind = 'center_expense' and bl.month <= p_month),
         (select sum(t.amount) from public.analytic_line_tags t join public.gl_entry_lines l on l.id = t.gl_line_id join public.gl_entries e on e.id = l.entry_id
           where t.member_id = m.id and e.status = 'posted' and extract(year from e.entry_date)::int = p_year and extract(month from e.entry_date)::int <= p_month),
         (select sum(c.amount) from public.analytic_commitments c where c.member_id = m.id and c.status = 'open')
    from public.analytic_members m
   where m.company_id = v_co and m.axis = 'center'
   order by m.code;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Privilèges
-- ---------------------------------------------------------------------------
revoke all on public.analytic_members, public.analytic_allocation_keys, public.analytic_allocation_key_versions,
  public.analytic_allocation_key_weights, public.analytic_allocation_runs, public.analytic_line_tags,
  public.analytic_budget_versions, public.analytic_budget_lines, public.analytic_commitments from anon, authenticated;
grant select on public.analytic_members, public.analytic_allocation_keys, public.analytic_allocation_key_versions,
  public.analytic_allocation_key_weights, public.analytic_allocation_runs, public.analytic_line_tags,
  public.analytic_budget_versions, public.analytic_budget_lines, public.analytic_commitments to authenticated;
grant all on public.analytic_members, public.analytic_allocation_keys, public.analytic_allocation_key_versions,
  public.analytic_allocation_key_weights, public.analytic_allocation_runs, public.analytic_line_tags,
  public.analytic_budget_versions, public.analytic_budget_lines, public.analytic_commitments to service_role;

revoke execute on function public.analytic_member_create(text, text, text, text, uuid), public.analytic_key_create(text, text),
  public.analytic_key_version_create(uuid, date, jsonb), public.analytic_key_version_validate(uuid, boolean),
  public.analytic_allocate_line(uuid, uuid), public.analytic_tag_line(uuid, uuid, numeric),
  public.analytic_budget_version_create(text, int, text), public.analytic_budget_lines_set(uuid, jsonb),
  public.analytic_budget_version_validate(uuid, boolean), public.analytic_commitment_add(uuid, numeric, text, date),
  public.analytic_commitment_close(uuid, text), public.analytic_margin_report(date, date), public.analytic_margin_reconcile(date, date),
  public.analytic_variance_decompose(int, int, int, text), public.analytic_center_position(int, int) from public, anon;
grant execute on function public.analytic_member_create(text, text, text, text, uuid), public.analytic_key_create(text, text),
  public.analytic_key_version_create(uuid, date, jsonb), public.analytic_key_version_validate(uuid, boolean),
  public.analytic_allocate_line(uuid, uuid), public.analytic_tag_line(uuid, uuid, numeric),
  public.analytic_budget_version_create(text, int, text), public.analytic_budget_lines_set(uuid, jsonb),
  public.analytic_budget_version_validate(uuid, boolean), public.analytic_commitment_add(uuid, numeric, text, date),
  public.analytic_commitment_close(uuid, text), public.analytic_margin_report(date, date), public.analytic_margin_reconcile(date, date),
  public.analytic_variance_decompose(int, int, int, text), public.analytic_center_position(int, int) to authenticated, service_role;
