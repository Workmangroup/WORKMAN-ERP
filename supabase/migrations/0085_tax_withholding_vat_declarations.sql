-- 0085_tax_withholding_vat_declarations — TVA retenues et déclarations (P060)
-- Existant conservé : vat_rates versionnés et validés à deux (0030, 0040), vat_summary (0027), factures et avoirs (0012, 0022, 0027),
-- grand livre (0031). Aucune règle n'est codée ni supposée : les retenues et taux sont saisis, datés et signés par une autre personne.
--
-- Règles :
--  * Retenues à la source : règle versionnée par date d'effet ; « a_valider » jusqu'à la validation par une autre personne (tax.validate).
--    Une version validée n'est plus modifiable, sauf sa date de fin (fermeture) tant qu'aucune retenue ne la postdate.
--    Une retenue ne peut être enregistrée que sous une règle validée à la date de la facture fournisseur.
--  * TVA déductible : saisie par facture fournisseur, par taux validé, base saisie ; TVA calculée côté serveur ; base + TVA = total de la facture.
--  * Déclaration (par société et mois) : brouillon (recalculable) → validée (figée, autre personne que le préparateur) → exportée
--    (empreinte) → déposée (accusé de réception saisi, distinct du validateur). Annulation possible avant dépôt, jamais après.
--  * Absence de faux dépôt : aucun statut « déposée » sans référence d'accusé unique par société ; aucun envoi à l'administration n'existe
--    dans ce lot (rien n'est transmis, la référence est une donnée saisie et non vérifiée).
--  * Une période avec déclaration validée/exportée/déposée est verrouillée : TVA déductible, retenues et modification de règle postdatée refusées.
--  * Contrôle de cohérence : vat_declaration_drift compare la déclaration figée au calcul actuel (une pièce ajoutée après validation est signalée).
-- Erreurs : VAT_RATE_MISSING, VAT_RATE_NOT_VALIDATED, VAT_FX_MISSING, VAT_PERIOD_INVALID, VAT_DECLARATION_LOCKED, VAT_DECLARATION_IMMUTABLE,
-- VAT_BAD_STATUS, VAT_RECEIPT_REQUIRED, VAT_CANNOT_CANCEL_DEPOSITED, VAT_LINE_DUPLICATE, SUPPLIER_VAT_MISMATCH, VAT_CURRENCY_UNSUPPORTED,
-- WITHHOLDING_NOT_CONFIGURED, WITHHOLDING_NOT_VALIDATED, WITHHOLDING_OVERLAP, WITHHOLDING_IN_USE, WITHHOLDING_IMMUTABLE, WITHHOLDING_BAD_AMOUNT,
-- SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits distincts
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('tax.validate', 'finance', 'Valider les paramètres fiscaux et les déclarations TVA', 'Validation des retenues et des déclarations ; distincte de l’auteur'),
  ('tax.file', 'finance', 'Enregistrer le dépôt d’une déclaration TVA', 'Dépôt seulement avec référence d’accusé ; distinct du validateur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('tax.validate', 'tax.file')
where r.is_system and r.code in ('admin', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Retenues à la source : règles versionnées
-- ---------------------------------------------------------------------------
create table public.withholding_rules (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code           text not null check (code ~ '^[A-Z0-9_]{3,40}$'),
  label          text not null check (length(btrim(label)) between 3 and 200),
  rate_pct       numeric(6,3) not null check (rate_pct >= 0 and rate_pct <= 100),
  effective_from date not null,
  effective_to   date,
  status         text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  validated_by   uuid,
  validated_at   timestamptz,
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, code, effective_from)
);
alter table public.withholding_rules enable row level security;
create policy withholding_rules_select on public.withholding_rules for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.withholding_rules from anon, authenticated;
grant select on public.withholding_rules to authenticated;
grant all on public.withholding_rules to service_role;

-- Pas de chevauchement de deux versions d'une même règle
create function private.withholding_rules_overlap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.withholding_rules o
              where o.company_id = new.company_id and o.code = new.code and o.id <> new.id
                and o.effective_from <= coalesce(new.effective_to, date '9999-12-31')
                and coalesce(o.effective_to, date '9999-12-31') >= new.effective_from) then
    raise exception 'WITHHOLDING_OVERLAP' using errcode = '23P01';
  end if;
  return new;
end $$;
revoke execute on function private.withholding_rules_overlap() from public, anon, authenticated;
create trigger withholding_rules_overlap_biu before insert or update on public.withholding_rules
  for each row execute function private.withholding_rules_overlap();

-- Version validée : seule la date de fin (absente → renseignée) peut changer ; suppression interdite
create function private.withholding_rules_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'valide' or exists (select 1 from public.supplier_invoice_withholdings w where w.rule_id = old.id) then
      raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000';
    end if;
    return old;
  end if;
  if old.status = 'valide' then
    if (new.id, new.company_id, new.code, new.label, new.rate_pct, new.effective_from, new.status, new.created_by, new.created_at, new.validated_by, new.validated_at)
       is distinct from (old.id, old.company_id, old.code, old.label, old.rate_pct, old.effective_from, old.status, old.created_by, old.created_at, old.validated_by, old.validated_at) then
      raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000';
    end if;
    if old.effective_to is not null and new.effective_to is distinct from old.effective_to then
      raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000';
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.withholding_rules_guard() from public, anon, authenticated;
create trigger withholding_rules_guard_bud before update or delete on public.withholding_rules
  for each row execute function private.withholding_rules_guard();

-- Règle applicable à une date : version validée seulement ; sinon erreur explicite (jamais de taux par défaut)
create function private.withholding_rule_at(p_company uuid, p_code text, p_date date) returns public.withholding_rules
language plpgsql stable security definer set search_path = '' as $$
declare r public.withholding_rules%rowtype;
begin
  select * into r from public.withholding_rules w
   where w.company_id = p_company and w.code = p_code and w.status = 'valide'
     and p_date between w.effective_from and coalesce(w.effective_to, date '9999-12-31')
   order by w.effective_from desc limit 1;
  if found then return r; end if;
  if exists (select 1 from public.withholding_rules w where w.company_id = p_company and w.code = p_code
             and p_date between w.effective_from and coalesce(w.effective_to, date '9999-12-31')) then
    raise exception 'WITHHOLDING_NOT_VALIDATED' using errcode = '55000', detail = p_code;
  end if;
  raise exception 'WITHHOLDING_NOT_CONFIGURED' using errcode = 'P0002', detail = p_code || ' ' || p_date::text;
end $$;
revoke execute on function private.withholding_rule_at(uuid, text, date) from public, anon, authenticated;

create function public.withholding_rule_create(p_code text, p_label text, p_rate numeric, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('finance.write');
  insert into public.withholding_rules (id, company_id, code, label, rate_pct, effective_from, effective_to, status)
  values (v_id, v_co, p_code, btrim(p_label), p_rate, p_from, p_to, 'a_valider');
  perform private.write_audit(v_co, 'tax.withholding_rule_create', 'withholding_rule', v_id::text, p_code, null,
    jsonb_build_object('rate_pct', p_rate, 'effective_from', p_from, 'effective_to', p_to, 'status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Validation par une autre personne ; refus = suppression de la version non validée
create function public.withholding_rule_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.withholding_rules%rowtype;
begin
  perform private.require_perm('tax.validate');
  select * into r from public.withholding_rules where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'withholding'; end if;
  if p_validate then
    update public.withholding_rules set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    delete from public.withholding_rules where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'tax.withholding_rule_validate' else 'tax.withholding_rule_reject' end,
    'withholding_rule', r.id::text, r.code, jsonb_build_object('status', 'a_valider'),
    jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- Fermeture d'une version validée : impossible si une retenue enregistrée est postérieure à la date de fin
create function public.withholding_rule_close(p_id uuid, p_to date) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.withholding_rules%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into r from public.withholding_rules where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'valide' or r.effective_to is not null then raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000'; end if;
  if p_to < r.effective_from then raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '22023'; end if;
  if exists (select 1 from public.supplier_invoice_withholdings w where w.rule_id = r.id and w.invoice_date > p_to) then
    raise exception 'WITHHOLDING_IN_USE' using errcode = '55000';
  end if;
  update public.withholding_rules set effective_to = p_to where id = r.id;
  perform private.write_audit(v_co, 'tax.withholding_rule_close', 'withholding_rule', r.id::text, r.code, jsonb_build_object('effective_to', null),
    jsonb_build_object('effective_to', p_to), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. TVA déductible : détail par taux saisi sur la facture fournisseur
-- ---------------------------------------------------------------------------
create table public.supplier_invoice_vat_lines (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default private.current_company() references public.companies(id) on delete cascade,
  supplier_invoice_id  uuid not null references public.supplier_invoices(id) on delete cascade,
  rate_code            text not null,
  rate_pct             numeric(5,2) not null check (rate_pct >= 0 and rate_pct <= 100),
  base_amount          numeric(15,2) not null check (base_amount >= 0),
  tax_amount           numeric(15,2) not null check (tax_amount >= 0),
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  check (tax_amount = round(base_amount * rate_pct / 100, 2)),
  unique (supplier_invoice_id, rate_code)
);
alter table public.supplier_invoice_vat_lines enable row level security;
create policy supplier_invoice_vat_lines_select on public.supplier_invoice_vat_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.supplier_invoice_vat_lines from anon, authenticated;
grant select on public.supplier_invoice_vat_lines to authenticated;
grant all on public.supplier_invoice_vat_lines to service_role;

-- Période verrouillée par une déclaration validée, exportée ou déposée
create function private.vat_period_locked(p_company uuid, p_date date) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (select 1 from public.vat_declarations d
                  where d.company_id = p_company and d.year = extract(year from p_date)::int and d.month = extract(month from p_date)::int
                    and d.status in ('validee', 'exportee', 'deposee'));
end $$;
revoke execute on function private.vat_period_locked(uuid, date) from public, anon, authenticated;

create function public.supplier_invoice_vat_set(p_invoice uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.supplier_invoices%rowtype; l jsonb; v_rate numeric; v_base numeric;
  v_sum numeric := 0; v_count int := 0; v_currency char(3) := private.base_currency();
begin
  perform private.require_perm('finance.write');
  select * into s from public.supplier_invoices where id = p_invoice and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if s.currency <> v_currency then raise exception 'VAT_CURRENCY_UNSUPPORTED' using errcode = '22023'; end if;
  if private.vat_period_locked(v_co, s.invoice_date) then raise exception 'VAT_DECLARATION_LOCKED' using errcode = '55000'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'VAT_BAD_STATUS' using errcode = '22023', detail = 'lines';
  end if;
  delete from public.supplier_invoice_vat_lines where supplier_invoice_id = s.id;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_base := (l->>'base')::numeric;
    select v.rate into v_rate from public.vat_rates v
     where v.code = l->>'rate_code' and v.status = 'valide'
       and s.invoice_date between v.effective_from and coalesce(v.effective_to, date '9999-12-31')
     order by v.effective_from desc limit 1;
    if v_rate is null then
      if exists (select 1 from public.vat_rates v where v.code = l->>'rate_code'
                 and s.invoice_date between v.effective_from and coalesce(v.effective_to, date '9999-12-31')) then
        raise exception 'VAT_RATE_NOT_VALIDATED' using errcode = '55000', detail = l->>'rate_code';
      end if;
      raise exception 'VAT_RATE_MISSING' using errcode = 'P0002', detail = coalesce(l->>'rate_code', '');
    end if;
    insert into public.supplier_invoice_vat_lines (company_id, supplier_invoice_id, rate_code, rate_pct, base_amount, tax_amount)
    values (v_co, s.id, l->>'rate_code', v_rate, v_base, round(v_base * v_rate / 100, 2));
    v_sum := v_sum + v_base + round(v_base * v_rate / 100, 2);
    v_count := v_count + 1;
  end loop;
  if v_sum <> s.total then
    raise exception 'SUPPLIER_VAT_MISMATCH' using errcode = '22023', detail = v_sum::text || ' / ' || s.total::text;
  end if;
  perform private.write_audit(v_co, 'tax.supplier_vat_set', 'supplier_invoice', s.id::text, s.number, null,
    jsonb_build_object('lines', v_count, 'total', s.total), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Retenues enregistrées sur une facture fournisseur
-- ---------------------------------------------------------------------------
create table public.supplier_invoice_withholdings (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default private.current_company() references public.companies(id) on delete cascade,
  supplier_invoice_id  uuid not null references public.supplier_invoices(id),
  rule_id              uuid not null references public.withholding_rules(id),
  rule_code            text not null,
  rate_pct             numeric(6,3) not null,
  invoice_date         date not null,
  base_amount          numeric(15,2) not null check (base_amount > 0),
  amount               numeric(15,2) not null check (amount >= 0),
  status               text not null default 'active' check (status in ('active', 'cancelled')),
  recorded_by          uuid default auth.uid(),
  recorded_at          timestamptz not null default now(),
  cancelled_by         uuid,
  cancelled_at         timestamptz,
  cancel_reason        text check (cancel_reason is null or length(btrim(cancel_reason)) between 5 and 300),
  check (amount = round(base_amount * rate_pct / 100, 2)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
alter table public.supplier_invoice_withholdings enable row level security;
create policy supplier_invoice_withholdings_select on public.supplier_invoice_withholdings for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.supplier_invoice_withholdings from anon, authenticated;
grant select on public.supplier_invoice_withholdings to authenticated;
grant all on public.supplier_invoice_withholdings to service_role;

-- Seules l'annulation (avec motif, période non verrouillée) modifie une retenue ; jamais de suppression
create function private.withholding_records_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000'; end if;
  if (new.id, new.company_id, new.supplier_invoice_id, new.rule_id, new.rule_code, new.rate_pct, new.invoice_date, new.base_amount, new.amount, new.recorded_by, new.recorded_at)
     is distinct from (old.id, old.company_id, old.supplier_invoice_id, old.rule_id, old.rule_code, old.rate_pct, old.invoice_date, old.base_amount, old.amount, old.recorded_by, old.recorded_at) then
    raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.withholding_records_guard() from public, anon, authenticated;
create trigger supplier_invoice_withholdings_guard_bud before update or delete on public.supplier_invoice_withholdings
  for each row execute function private.withholding_records_guard();

create function public.supplier_withholding_record(p_invoice uuid, p_rule_code text, p_base numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.supplier_invoices%rowtype; r public.withholding_rules%rowtype; v_id uuid := gen_random_uuid(); v_amount numeric;
begin
  perform private.require_perm('finance.write');
  select * into s from public.supplier_invoices where id = p_invoice and company_id = v_co;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_base is null or p_base <= 0 or p_base > s.total then raise exception 'WITHHOLDING_BAD_AMOUNT' using errcode = '22023'; end if;
  if private.vat_period_locked(v_co, s.invoice_date) then raise exception 'VAT_DECLARATION_LOCKED' using errcode = '55000'; end if;
  r := private.withholding_rule_at(v_co, p_rule_code, s.invoice_date);
  v_amount := round(p_base * r.rate_pct / 100, 2);
  insert into public.supplier_invoice_withholdings (id, company_id, supplier_invoice_id, rule_id, rule_code, rate_pct, invoice_date, base_amount, amount)
  values (v_id, v_co, s.id, r.id, r.code, r.rate_pct, s.invoice_date, p_base, v_amount);
  perform private.write_audit(v_co, 'tax.withholding_record', 'supplier_invoice', s.id::text, s.number, null,
    jsonb_build_object('rule', r.code, 'rate_pct', r.rate_pct, 'base', p_base, 'amount', v_amount), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.supplier_withholding_cancel(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); w public.supplier_invoice_withholdings%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into w from public.supplier_invoice_withholdings where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if w.status <> 'active' then raise exception 'WITHHOLDING_IMMUTABLE' using errcode = '55000'; end if;
  if private.vat_period_locked(v_co, w.invoice_date) then raise exception 'VAT_DECLARATION_LOCKED' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'VAT_BAD_STATUS' using errcode = '22023', detail = 'reason'; end if;
  update public.supplier_invoice_withholdings set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason)
   where id = w.id;
  perform private.write_audit(v_co, 'tax.withholding_cancel', 'supplier_invoice', w.supplier_invoice_id::text, w.rule_code, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'cancelled'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Déclarations de TVA : calcul, brouillon, validation, export, dépôt, annulation
-- ---------------------------------------------------------------------------
create table public.vat_declarations (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default private.current_company() references public.companies(id) on delete cascade,
  year              int not null check (year between 2000 and 2100),
  month             int not null check (month between 1 and 12),
  status            text not null default 'brouillon' check (status in ('brouillon', 'validee', 'exportee', 'deposee', 'annulee')),
  collected_tax     numeric(15,2) not null default 0,
  deductible_tax    numeric(15,2) not null default 0,
  vat_due           numeric(15,2) not null default 0,
  withholding_total numeric(15,2) not null default 0,
  prepared_by       uuid,
  prepared_at       timestamptz not null default now(),
  validated_by      uuid,
  validated_at      timestamptz,
  export_hash       text,
  exported_by       uuid,
  exported_at       timestamptz,
  receipt_ref       text check (receipt_ref is null or length(btrim(receipt_ref)) between 3 and 80),
  receipt_date      date,
  filed_by          uuid,
  filed_at          timestamptz,
  cancelled_by      uuid,
  cancelled_at      timestamptz,
  cancel_reason     text check (cancel_reason is null or length(btrim(cancel_reason)) between 5 and 300),
  check (vat_due = collected_tax - deductible_tax),
  check ((status in ('validee', 'exportee', 'deposee')) = (validated_by is not null and validated_at is not null) or status = 'annulee' or (status = 'brouillon' and validated_by is null)),
  check (validated_by is null or validated_by is distinct from prepared_by),
  check ((status in ('exportee', 'deposee')) = (export_hash is not null) or status = 'annulee' or (status = 'validee' and export_hash is null) or (status = 'brouillon' and export_hash is null)),
  check (status <> 'deposee' or (receipt_ref is not null and receipt_date is not null and filed_by is not null and filed_at is not null)),
  check (receipt_ref is null or filed_by is not null),
  check (filed_by is null or filed_by is distinct from validated_by),
  check (status <> 'annulee' or (cancelled_at is not null and cancel_reason is not null)),
  check (year * 100 + month > 0)
);
create unique index vat_declarations_period_uq on public.vat_declarations (company_id, year, month) where status <> 'annulee';
create unique index vat_declarations_receipt_uq on public.vat_declarations (company_id, receipt_ref) where receipt_ref is not null;
alter table public.vat_declarations enable row level security;
create policy vat_declarations_select on public.vat_declarations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.vat_declarations from anon, authenticated;
grant select on public.vat_declarations to authenticated;
grant all on public.vat_declarations to service_role;

create table public.vat_declaration_lines (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id) on delete cascade,
  declaration_id uuid not null references public.vat_declarations(id),
  section        text not null check (section in ('collected', 'deductible', 'withholding')),
  pos            int not null,
  label          text not null,
  rate_pct       numeric(6,3),
  base_amount    numeric(15,2) not null,
  tax_amount     numeric(15,2) not null,
  source_count   int not null default 0 check (source_count >= 0),
  unique (declaration_id, section, pos)
);
alter table public.vat_declaration_lines enable row level security;
create policy vat_declaration_lines_select on public.vat_declaration_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.vat_declaration_lines from anon, authenticated;
grant select on public.vat_declaration_lines to authenticated;
grant all on public.vat_declaration_lines to service_role;

-- Déclaration : seul le brouillon est recalculable ; une fois validée, seules les étapes export / dépôt / annulation changent
create function private.vat_declarations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000'; end if;
  if tg_op = 'INSERT' then return new; end if;
  if old.status = 'brouillon' then
    if (new.id, new.company_id, new.year, new.month) is distinct from (old.id, old.company_id, old.year, old.month) then
      raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000';
    end if;
    if new.status not in ('brouillon', 'validee', 'annulee') then raise exception 'VAT_BAD_STATUS' using errcode = '55000'; end if;
    return new;
  end if;
  if old.status = 'annulee' then raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000'; end if;
  if (new.id, new.company_id, new.year, new.month, new.collected_tax, new.deductible_tax, new.vat_due, new.withholding_total,
      new.prepared_by, new.prepared_at, new.validated_by, new.validated_at)
     is distinct from (old.id, old.company_id, old.year, old.month, old.collected_tax, old.deductible_tax, old.vat_due, old.withholding_total,
      old.prepared_by, old.prepared_at, old.validated_by, old.validated_at) then
    raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000';
  end if;
  if old.export_hash is not null and new.export_hash is distinct from old.export_hash then
    raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000';
  end if;
  if old.receipt_ref is not null and (new.receipt_ref, new.receipt_date, new.filed_by, new.filed_at)
     is distinct from (old.receipt_ref, old.receipt_date, old.filed_by, old.filed_at) then
    raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000';
  end if;
  if new.status <> old.status and not (
       (old.status, new.status) in (('validee', 'exportee'), ('validee', 'annulee'), ('exportee', 'deposee'), ('exportee', 'annulee'))) then
    raise exception 'VAT_BAD_STATUS' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.vat_declarations_guard() from public, anon, authenticated;
create trigger vat_declarations_guard_biud before insert or update or delete on public.vat_declarations
  for each row execute function private.vat_declarations_guard();

create function private.vat_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' then raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000'; end if;
  select d.status into v_status from public.vat_declarations d where d.id = coalesce(new.declaration_id, old.declaration_id);
  if v_status is distinct from 'brouillon' then raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000'; end if;
  return coalesce(new, old);
end $$;
revoke execute on function private.vat_lines_guard() from public, anon, authenticated;
create trigger vat_declaration_lines_guard_biud before insert or update or delete on public.vat_declaration_lines
  for each row execute function private.vat_lines_guard();

-- Calcul de la période : TVA collectée (factures émises moins avoirs émis), TVA déductible (saisie fournisseur), retenues actives.
-- Montants en devise de base ; une facture sans taux de change est refusée par l'appelant (VAT_FX_MISSING).
create function private.vat_compute(p_company uuid, p_year int, p_month int)
returns table (section text, pos int, label text, rate_pct numeric, base_amount numeric, tax_amount numeric, source_count int)
language plpgsql stable security definer set search_path = '' as $$
declare v_from date := make_date(p_year, p_month, 1); v_to date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_minor int := (select c.minor_units from public.currencies c where c.code = coalesce((select s.base_currency from public.finance_settings s where s.company_id = p_company), 'EUR'));
begin
  return query
  with docs as (
    select i.tax_rate::numeric as rate, round(i.subtotal * i.fx_rate, v_minor) as base, round(i.tax_amount * i.fx_rate, v_minor) as tax, 1 as sign
      from public.invoices i
     where i.company_id = p_company and i.status in ('issued', 'partially_paid', 'paid', 'credited')
       and i.issue_date between v_from and v_to and i.fx_rate is not null
    union all
    select i.tax_rate::numeric, round(cn.subtotal * i.fx_rate, v_minor), round(cn.tax_amount * i.fx_rate, v_minor), -1
      from public.credit_notes cn join public.invoices i on i.id = cn.invoice_id
     where cn.company_id = p_company and cn.status = 'issued' and cn.issue_date between v_from and v_to and i.fx_rate is not null
  ), collected as (
    select d.rate, sum(d.sign * d.base) as base, sum(d.sign * d.tax) as tax, count(*)::int as n from docs d group by d.rate
  )
  select 'collected'::text, (row_number() over (order by c.rate))::int, ('TVA collectée ' || c.rate::text || ' %')::text, c.rate::numeric, c.base::numeric, c.tax::numeric, c.n
    from collected c;

  return query
  select 'deductible'::text, (row_number() over (order by l.rate_pct))::int, ('TVA déductible ' || l.rate_pct::text || ' %')::text,
         l.rate_pct::numeric, sum(l.base_amount)::numeric, sum(l.tax_amount)::numeric, count(*)::int
    from public.supplier_invoice_vat_lines l join public.supplier_invoices s on s.id = l.supplier_invoice_id
   where l.company_id = p_company and s.invoice_date between v_from and v_to
   group by l.rate_pct;

  return query
  select 'withholding'::text, (row_number() over (order by w.rule_code, w.rate_pct))::int, ('Retenue ' || w.rule_code)::text,
         w.rate_pct::numeric, sum(w.base_amount)::numeric, sum(w.amount)::numeric, count(*)::int
    from public.supplier_invoice_withholdings w
   where w.company_id = p_company and w.status = 'active' and w.invoice_date between v_from and v_to
   group by w.rule_code, w.rate_pct;
end $$;
revoke execute on function private.vat_compute(uuid, int, int) from public, anon, authenticated;

create function public.vat_declaration_prepare(p_year int, p_month int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.vat_declarations%rowtype; v_id uuid; v_from date := make_date(p_year, p_month, 1);
  v_to date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_collected numeric := 0; v_deductible numeric := 0; v_withholding numeric := 0; x record;
begin
  perform private.require_perm('finance.write');
  if p_year not between 2000 and 2100 or p_month not between 1 and 12 then raise exception 'VAT_PERIOD_INVALID' using errcode = '22023'; end if;
  select * into d from public.vat_declarations where company_id = v_co and year = p_year and month = p_month and status <> 'annulee' for update;
  if found and d.status <> 'brouillon' then raise exception 'VAT_DECLARATION_LOCKED' using errcode = '55000'; end if;
  if exists (select 1 from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid', 'credited')
             and i.issue_date between v_from and v_to and i.fx_rate is null) then
    raise exception 'VAT_FX_MISSING' using errcode = '55000';
  end if;
  if exists (select 1 from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid', 'credited')
             and i.issue_date between v_from and v_to
             and not exists (select 1 from public.vat_rates v where v.rate = i.tax_rate and v.status = 'valide')) then
    raise exception 'VAT_RATE_NOT_VALIDATED' using errcode = '55000';
  end if;
  if found then v_id := d.id;
    update public.vat_declarations set prepared_by = auth.uid(), prepared_at = now() where id = v_id;
    delete from public.vat_declaration_lines where declaration_id = v_id;
  else
    v_id := gen_random_uuid();
    insert into public.vat_declarations (id, company_id, year, month, prepared_by) values (v_id, v_co, p_year, p_month, auth.uid());
  end if;
  for x in select * from private.vat_compute(v_co, p_year, p_month) loop
    insert into public.vat_declaration_lines (company_id, declaration_id, section, pos, label, rate_pct, base_amount, tax_amount, source_count)
    values (v_co, v_id, x.section, x.pos, x.label, x.rate_pct, x.base_amount, x.tax_amount, x.source_count);
    if x.section = 'collected' then v_collected := v_collected + x.tax_amount;
    elsif x.section = 'deductible' then v_deductible := v_deductible + x.tax_amount;
    else v_withholding := v_withholding + x.tax_amount; end if;
  end loop;
  update public.vat_declarations set collected_tax = v_collected, deductible_tax = v_deductible, vat_due = v_collected - v_deductible,
         withholding_total = v_withholding where id = v_id;
  perform private.write_audit(v_co, 'tax.vat_declaration_prepare', 'vat_declaration', v_id::text, to_char(v_from, 'YYYY-MM'), null,
    jsonb_build_object('collected', v_collected, 'deductible', v_deductible, 'vat_due', v_collected - v_deductible, 'withholding', v_withholding), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.vat_declaration_validate(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.vat_declarations%rowtype;
begin
  perform private.require_perm('tax.validate');
  select * into d from public.vat_declarations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'brouillon' then raise exception 'VAT_BAD_STATUS' using errcode = '55000'; end if;
  if d.prepared_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'vat'; end if;
  update public.vat_declarations set status = 'validee', validated_by = auth.uid(), validated_at = now() where id = d.id;
  perform private.write_audit(v_co, 'tax.vat_declaration_validate', 'vat_declaration', d.id::text, to_char(make_date(d.year, d.month, 1), 'YYYY-MM'),
    jsonb_build_object('status', 'brouillon'), jsonb_build_object('status', 'validee', 'vat_due', d.vat_due), '{}'::jsonb, 'rpc');
end $$;

-- Export : contenu figé (totaux et lignes) ; empreinte md5 ; ré-export identique seulement si le contenu n'a pas changé.
-- Le format de l'administration n'est pas fourni : l'export est un état interne (à confirmer par l'expert).
create function public.vat_declaration_export(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.vat_declarations%rowtype; v_payload jsonb; v_hash text;
begin
  perform private.require_perm('finance.write');
  select * into d from public.vat_declarations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status not in ('validee', 'exportee') then raise exception 'VAT_BAD_STATUS' using errcode = '55000'; end if;
  select jsonb_build_object('year', d.year, 'month', d.month, 'collected_tax', d.collected_tax, 'deductible_tax', d.deductible_tax,
           'vat_due', d.vat_due, 'withholding_total', d.withholding_total,
           'lines', coalesce(jsonb_agg(jsonb_build_object('section', l.section, 'pos', l.pos, 'label', l.label, 'rate_pct', l.rate_pct,
                     'base', l.base_amount, 'tax', l.tax_amount, 'count', l.source_count) order by l.section, l.pos), '[]'::jsonb))
    into v_payload from public.vat_declaration_lines l where l.declaration_id = d.id;
  v_hash := md5(v_payload::text);
  if d.status = 'validee' then
    update public.vat_declarations set status = 'exportee', export_hash = v_hash, exported_by = auth.uid(), exported_at = now() where id = d.id;
    perform private.write_audit(v_co, 'tax.vat_declaration_export', 'vat_declaration', d.id::text, to_char(make_date(d.year, d.month, 1), 'YYYY-MM'),
      jsonb_build_object('status', 'validee'), jsonb_build_object('status', 'exportee', 'export_hash', v_hash), '{}'::jsonb, 'rpc');
  elsif d.export_hash is distinct from v_hash then
    raise exception 'VAT_DECLARATION_IMMUTABLE' using errcode = '55000', detail = 'export_hash';
  end if;
  return v_payload || jsonb_build_object('export_hash', v_hash, 'format', 'interne : format de l’administration non fourni');
end $$;

-- Dépôt : seulement après export, avec une référence d'accusé réelle et unique ; distinct du validateur. Aucune transmission ici.
create function public.vat_declaration_file(p_id uuid, p_receipt_ref text, p_receipt_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.vat_declarations%rowtype; v_ref text := btrim(coalesce(p_receipt_ref, ''));
begin
  perform private.require_perm('tax.file');
  select * into d from public.vat_declarations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'exportee' then raise exception 'VAT_BAD_STATUS' using errcode = '55000'; end if;
  if length(v_ref) < 3 or p_receipt_date is null then raise exception 'VAT_RECEIPT_REQUIRED' using errcode = '22023'; end if;
  if p_receipt_date < make_date(d.year, d.month, 1) then raise exception 'VAT_RECEIPT_REQUIRED' using errcode = '22023', detail = 'date'; end if;
  if d.validated_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'vat_file'; end if;
  update public.vat_declarations set status = 'deposee', receipt_ref = v_ref, receipt_date = p_receipt_date, filed_by = auth.uid(), filed_at = now()
   where id = d.id;
  perform private.write_audit(v_co, 'tax.vat_declaration_file', 'vat_declaration', d.id::text, to_char(make_date(d.year, d.month, 1), 'YYYY-MM'),
    jsonb_build_object('status', 'exportee'), jsonb_build_object('status', 'deposee', 'receipt_ref', v_ref, 'receipt_date', p_receipt_date), '{}'::jsonb, 'rpc');
end $$;

create function public.vat_declaration_cancel(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.vat_declarations%rowtype;
begin
  perform private.require_perm('tax.validate');
  select * into d from public.vat_declarations where id = p_id and company_id = v_co for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status = 'deposee' then raise exception 'VAT_CANNOT_CANCEL_DEPOSITED' using errcode = '55000'; end if;
  if d.status = 'annulee' then raise exception 'VAT_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'VAT_BAD_STATUS' using errcode = '22023', detail = 'reason'; end if;
  update public.vat_declarations set status = 'annulee', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason) where id = d.id;
  perform private.write_audit(v_co, 'tax.vat_declaration_cancel', 'vat_declaration', d.id::text, to_char(make_date(d.year, d.month, 1), 'YYYY-MM'),
    jsonb_build_object('status', d.status), jsonb_build_object('status', 'annulee'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;

-- Cohérence : la déclaration figée contre le calcul actuel (une pièce ajoutée ou avoir émis après validation apparaît ici)
create function public.vat_declaration_drift(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.vat_declarations%rowtype; v_diff int;
begin
  perform private.require_perm('finance.read');
  select * into d from public.vat_declarations where id = p_id and company_id = v_co;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select count(*)::int into v_diff from (
    select c.section, c.label, c.base_amount, c.tax_amount from private.vat_compute(v_co, d.year, d.month) c
    except
    select l.section, l.label, l.base_amount, l.tax_amount from public.vat_declaration_lines l where l.declaration_id = d.id
  ) x;
  return jsonb_build_object('consistent', v_diff = 0, 'differences', v_diff);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Privilèges
-- ---------------------------------------------------------------------------
revoke execute on function public.withholding_rule_create(text, text, numeric, date, date), public.withholding_rule_validate(uuid, boolean),
  public.withholding_rule_close(uuid, date), public.supplier_invoice_vat_set(uuid, jsonb), public.supplier_withholding_record(uuid, text, numeric),
  public.supplier_withholding_cancel(uuid, text), public.vat_declaration_prepare(int, int), public.vat_declaration_validate(uuid),
  public.vat_declaration_export(uuid), public.vat_declaration_file(uuid, text, date), public.vat_declaration_cancel(uuid, text),
  public.vat_declaration_drift(uuid)
  from public, anon;
grant execute on function public.withholding_rule_create(text, text, numeric, date, date), public.withholding_rule_validate(uuid, boolean),
  public.withholding_rule_close(uuid, date), public.supplier_invoice_vat_set(uuid, jsonb), public.supplier_withholding_record(uuid, text, numeric),
  public.supplier_withholding_cancel(uuid, text), public.vat_declaration_prepare(int, int), public.vat_declaration_validate(uuid),
  public.vat_declaration_export(uuid), public.vat_declaration_file(uuid, text, date), public.vat_declaration_cancel(uuid, text),
  public.vat_declaration_drift(uuid)
  to authenticated, service_role;
