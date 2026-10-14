-- 0087_bank_statements_reconciliation — Banques : comptes, relevés idempotents, rapprochements, exceptions, coordonnées fournisseur
--  et lot de transmission à double contrôle (P062)
-- Existant conservé : ordres de paiement préparés / approuvés / exécutés (0033, 0034, inchangés), règlements fournisseur
-- (supplier_payments, 0022), encaissements client (invoice_payments, 0012), caisses (cash_accounts, 0022, inchangées).
-- Rien n'est remplacé ; payment_order_execute reste inchangé (voir « Limites » dans PROJECT_STATE).
--
-- Règles :
--  * Aucune coordonnée complète n'est stockée : libellé de banque, 4 derniers caractères et empreinte de l'IBAN normalisé.
--    Un changement de coordonnées fournisseur n'est actif qu'après validation par une autre personne (FIN-08).
--  * Relevé : importé une seule fois (même référence ou même contenu = refus BANK_STATEMENT_DUPLICATE) ; chaque ligne a une clé
--    unique par compte (BANK_LINE_DUPLICATE) ; solde d'ouverture + lignes = solde de clôture (BANK_BALANCE_MISMATCH) ; dates dans la période.
--  * Rapprochement : une ligne ↔ un règlement (client ou fournisseur) de même montant exact, sens correct, même devise de base,
--    une seule fois de part et d'autre. Les propositions sont calculées ; la confirmation revalide tout au moment de l'écriture.
--  * Exception : motif obligatoire ; clôture par une autre personne que l'ouvreur ; la ligne reste non rapprochée.
--  * Lot de transmission : constitué par une personne (bank.transmit) à partir d'ordres APPROUVÉS, avec coordonnées validées ;
--    le transmetteur ne peut être ni le préparateur ni l'approbateur d'un ordre. Accusé bancaire (bank.acknowledge) par une autre
--    personne que le transmetteur → statut « accepté ». « Exécuté » n'est PAS un statut enregistré : il est déduit seulement lorsqu'un
--    règlement de l'ordre est rapproché à une ligne de relevé.
--  * Aucune transmission réelle : pas de connecteur bancaire et aucun format de fichier confirmé ; le lot est une trace interne.
-- Erreurs : BANK_STATEMENT_DUPLICATE, BANK_LINE_DUPLICATE, BANK_BALANCE_MISMATCH, BANK_LINE_OUT_OF_PERIOD, BANK_BAD_AMOUNT, BANK_BAD_KIND,
-- BANK_NOT_FOUND, BANK_BAD_STATUS, BANK_CURRENCY_MISMATCH, BANK_TARGET_MISMATCH, BANK_TARGET_ALREADY_MATCHED, BANK_REASON_REQUIRED,
-- BANK_IBAN_INVALID, BANK_DETAIL_NOT_VALIDATED, BANK_ORDER_NOT_APPROVED, BANK_ALREADY_TRANSMITTED, BANK_EMPTY, BANK_ACK_REQUIRED,
-- BANK_IMMUTABLE, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits distincts
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('bank.manage', 'finance', 'Gérer les comptes bancaires et importer les relevés', 'Création de comptes et import de relevés (une seule fois)'),
  ('bank.reconcile', 'finance', 'Rapprocher les lignes bancaires', 'Confirmer un rapprochement ou ouvrir une exception'),
  ('bank.details', 'finance', 'Saisir les coordonnées bancaires fournisseur', 'Saisie d’une coordonnée à valider (non active avant validation)'),
  ('bank.details_validate', 'finance', 'Valider les coordonnées bancaires fournisseur', 'Validation distincte de la saisie'),
  ('bank.transmit', 'finance', 'Constituer un lot de paiements transmis à la banque', 'Lot interne sur ordres approuvés (aucun envoi réel)'),
  ('bank.acknowledge', 'finance', 'Enregistrer l’acceptation bancaire d’un lot', 'Accusé distinct du transmetteur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code like 'bank.%'
where r.is_system and r.code in ('admin', 'finance') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Comptes bancaires (société, devise, identification minimale)
-- ---------------------------------------------------------------------------
create table public.bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  name         text not null check (length(btrim(name)) between 2 and 80),
  bank_label   text not null check (length(btrim(bank_label)) between 2 and 80),
  currency     char(3) not null check (currency ~ '^[A-Z]{3}$'),
  account_last4 text not null check (account_last4 ~ '^[0-9A-Za-z]{4}$'),
  active       boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (company_id, name)
);
alter table public.bank_accounts enable row level security;
create policy bank_accounts_select on public.bank_accounts for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.bank_accounts from anon, authenticated;
grant select on public.bank_accounts to authenticated;
grant all on public.bank_accounts to service_role;

create function public.bank_account_create(p_name text, p_bank_label text, p_currency text, p_last4 text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('bank.manage');
  insert into public.bank_accounts (id, company_id, name, bank_label, currency, account_last4)
  values (v_id, v_co, btrim(p_name), btrim(p_bank_label), upper(p_currency), p_last4);
  perform private.write_audit(v_co, 'bank.account_create', 'bank_account', v_id::text, btrim(p_name), null,
    jsonb_build_object('currency', upper(p_currency), 'last4', p_last4), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Relevés (idempotents) et lignes
-- ---------------------------------------------------------------------------
create table public.bank_statements (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),
  statement_ref text not null check (length(btrim(statement_ref)) between 1 and 80),
  period_from  date not null,
  period_to    date not null,
  currency     char(3) not null,
  opening_balance numeric(15,2) not null,
  closing_balance numeric(15,2) not null,
  line_count   int not null check (line_count >= 0),
  content_hash text not null,
  imported_by  uuid default auth.uid(),
  imported_at  timestamptz not null default now(),
  check (period_to >= period_from),
  unique (company_id, bank_account_id, statement_ref),
  unique (company_id, bank_account_id, content_hash)
);
alter table public.bank_statements enable row level security;
create policy bank_statements_select on public.bank_statements for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.bank_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),
  statement_id  uuid not null references public.bank_statements(id),
  pos           int not null check (pos > 0),
  value_date    date not null,
  amount        numeric(15,2) not null check (amount <> 0),
  label         text not null default '',
  bank_ref      text not null default '',
  line_key      text not null,
  status        text not null default 'open' check (status in ('open', 'matched', 'excepted', 'closed')),
  unique (company_id, bank_account_id, line_key),
  unique (statement_id, pos)
);
alter table public.bank_lines enable row level security;
create policy bank_lines_select on public.bank_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

-- Relevé et ligne : jamais modifiés ni supprimés, sauf le statut d'une ligne (open → matched / excepted / closed)
create function private.bank_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'BANK_IMMUTABLE' using errcode = '55000'; end if;
  if tg_table_name = 'bank_lines' and old.status <> new.status and (new.id, new.company_id, new.bank_account_id, new.statement_id, new.pos,
       new.value_date, new.amount, new.label, new.bank_ref, new.line_key)
     is not distinct from (old.id, old.company_id, old.bank_account_id, old.statement_id, old.pos, old.value_date, old.amount, old.label, old.bank_ref, old.line_key)
     and ((old.status = 'open' and new.status in ('matched', 'excepted', 'closed')) or (old.status = 'excepted' and new.status in ('matched', 'closed'))) then
    return new;
  end if;
  raise exception 'BANK_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.bank_immutable() from public, anon, authenticated;
create trigger bank_statements_immutable before update or delete on public.bank_statements for each row execute function private.bank_immutable();
create trigger bank_lines_immutable before update or delete on public.bank_lines for each row execute function private.bank_immutable();

-- Import : toutes les vérifications avant écriture ; un seul appel réussit ou échoue entièrement.
create function public.bank_statement_import(p_account uuid, p_ref text, p_from date, p_to date, p_opening numeric, p_closing numeric, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.bank_accounts%rowtype; v_id uuid := gen_random_uuid(); v_ref text := btrim(coalesce(p_ref, ''));
  v_hash text; v_sum numeric := 0; v_count int := 0; r record; v_base text; v_n int; v_key text; v_occ jsonb := '{}'::jsonb; v_existing uuid;
begin
  perform private.require_perm('bank.manage');
  select * into a from public.bank_accounts where id = p_account and company_id = v_co and active;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.currency <> private.base_currency() then raise exception 'BANK_CURRENCY_MISMATCH' using errcode = '22023'; end if;
  if length(v_ref) < 1 or p_from is null or p_to is null or p_to < p_from or p_opening is null or p_closing is null then
    raise exception 'BANK_BAD_AMOUNT' using errcode = '22023', detail = 'period';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'BANK_EMPTY' using errcode = '22023'; end if;

  v_hash := md5(p_lines::text || '|' || p_opening::text || '|' || p_closing::text || '|' || p_from::text || '|' || p_to::text);
  select s.id into v_existing from public.bank_statements s
   where s.company_id = v_co and s.bank_account_id = a.id and (s.statement_ref = v_ref or s.content_hash = v_hash) limit 1;
  if found then raise exception 'BANK_STATEMENT_DUPLICATE' using errcode = '23505', detail = v_existing::text; end if;

  -- Contrôle des lignes et clés (occurrences identiques numérotées dans le relevé)
  for r in select (e->>'value_date')::date as vd, (e->>'amount')::numeric as amt, coalesce(e->>'label', '') as lbl,
               coalesce(e->>'bank_ref', '') as ref, x.ord
             from jsonb_array_elements(p_lines) with ordinality as x(e, ord) order by x.ord loop
    if r.amt is null or r.amt = 0 then raise exception 'BANK_BAD_AMOUNT' using errcode = '22023', detail = r.ord::text; end if;
    if r.vd < p_from or r.vd > p_to then raise exception 'BANK_LINE_OUT_OF_PERIOD' using errcode = '22023', detail = r.ord::text; end if;
    v_base := a.id::text || '|' || r.vd::text || '|' || r.amt::text || '|' || r.lbl || '|' || r.ref;
    v_n := coalesce((v_occ ->> v_base)::int, 0) + 1;
    v_occ := jsonb_set(v_occ, array[v_base], to_jsonb(v_n));
    v_key := md5(v_base || '|' || v_n::text);
    if exists (select 1 from public.bank_lines l where l.company_id = v_co and l.bank_account_id = a.id and l.line_key = v_key) then
      raise exception 'BANK_LINE_DUPLICATE' using errcode = '23505', detail = r.ord::text;
    end if;
    v_sum := v_sum + r.amt;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'BANK_EMPTY' using errcode = '22023'; end if;
  if p_opening + v_sum <> p_closing then
    raise exception 'BANK_BALANCE_MISMATCH' using errcode = '22023', detail = (p_opening + v_sum)::text || ' / ' || p_closing::text;
  end if;

  insert into public.bank_statements (id, company_id, bank_account_id, statement_ref, period_from, period_to, currency,
    opening_balance, closing_balance, line_count, content_hash)
  values (v_id, v_co, a.id, v_ref, p_from, p_to, a.currency, p_opening, p_closing, v_count, v_hash);

  v_occ := '{}'::jsonb;
  for r in select (e->>'value_date')::date as vd, (e->>'amount')::numeric as amt, coalesce(e->>'label', '') as lbl,
               coalesce(e->>'bank_ref', '') as ref, x.ord
             from jsonb_array_elements(p_lines) with ordinality as x(e, ord) order by x.ord loop
    v_base := a.id::text || '|' || r.vd::text || '|' || r.amt::text || '|' || r.lbl || '|' || r.ref;
    v_n := coalesce((v_occ ->> v_base)::int, 0) + 1;
    v_occ := jsonb_set(v_occ, array[v_base], to_jsonb(v_n));
    insert into public.bank_lines (company_id, bank_account_id, statement_id, pos, value_date, amount, label, bank_ref, line_key)
    values (v_co, a.id, v_id, r.ord::int, r.vd, r.amt, r.lbl, r.ref, md5(v_base || '|' || v_n::text));
  end loop;

  perform private.write_audit(v_co, 'bank.statement_import', 'bank_statement', v_id::text, v_ref, null,
    jsonb_build_object('account', a.name, 'lines', v_count, 'closing', p_closing), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Rapprochements et exceptions
-- ---------------------------------------------------------------------------
create table public.bank_matches (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  bank_line_id        uuid not null unique references public.bank_lines(id),
  target_kind         text not null check (target_kind in ('supplier_payment', 'client_payment')),
  supplier_payment_id uuid references public.supplier_payments(id),
  client_payment_id   uuid references public.invoice_payments(id),
  amount              numeric(15,2) not null check (amount > 0),
  matched_by          uuid default auth.uid(),
  matched_at          timestamptz not null default now(),
  check ((target_kind = 'supplier_payment') = (supplier_payment_id is not null)),
  check ((target_kind = 'client_payment') = (client_payment_id is not null))
);
create unique index bank_matches_supplier_uq on public.bank_matches (supplier_payment_id) where supplier_payment_id is not null;
create unique index bank_matches_client_uq on public.bank_matches (client_payment_id) where client_payment_id is not null;
alter table public.bank_matches enable row level security;
create policy bank_matches_select on public.bank_matches for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
create trigger bank_matches_immutable before update or delete on public.bank_matches for each row execute function private.bank_immutable();

create table public.bank_exceptions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  bank_line_id uuid not null references public.bank_lines(id),
  reason_code  text not null check (reason_code in ('no_match', 'amount_mismatch', 'duplicate_candidate', 'unknown_counterparty', 'other')),
  note         text not null check (length(btrim(note)) between 5 and 300),
  raised_by    uuid default auth.uid(),
  raised_at    timestamptz not null default now(),
  resolution   text check (resolution is null or length(btrim(resolution)) between 5 and 300),
  resolved_by  uuid,
  resolved_at  timestamptz,
  check ((resolved_at is null) = (resolution is null)),
  check (resolved_by is null or resolved_by is distinct from raised_by)
);
create unique index bank_exceptions_open_uq on public.bank_exceptions (bank_line_id) where resolved_at is null;
alter table public.bank_exceptions enable row level security;
create policy bank_exceptions_select on public.bank_exceptions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.bank_exceptions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.resolved_at is not null
     or (new.id, new.company_id, new.bank_line_id, new.reason_code, new.note, new.raised_by, new.raised_at)
        is distinct from (old.id, old.company_id, old.bank_line_id, old.reason_code, old.note, old.raised_by, old.raised_at) then
    raise exception 'BANK_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.bank_exceptions_guard() from public, anon, authenticated;
create trigger bank_exceptions_guard_bud before update or delete on public.bank_exceptions for each row execute function private.bank_exceptions_guard();

-- Propositions : lignes ouvertes ↔ règlements non rapprochés, même montant exact, sens correct, date à 5 jours près.
create function public.bank_match_suggest(p_account uuid)
returns table (line_id uuid, value_date date, amount numeric, label text, target_kind text, target_id uuid, target_ref text, score text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('finance.read');
  return query
  select l.id, l.value_date, l.amount, l.label, 'client_payment'::text, p.id, i.code::text,
         case when position(i.code in l.label) > 0 then 'reference' else 'montant_date' end::text
    from public.bank_lines l
    join public.invoice_payments p on p.company_id = v_co and p.amount = l.amount and abs(p.paid_on - l.value_date) <= 5
    join public.invoices i on i.id = p.invoice_id
   where l.company_id = v_co and l.bank_account_id = p_account and l.status = 'open' and l.amount > 0
     and not exists (select 1 from public.bank_matches m where m.client_payment_id = p.id)
  union all
  select l.id, l.value_date, l.amount, l.label, 'supplier_payment'::text, sp.id, sp.number::text,
         case when position(sp.number in l.label) > 0 then 'reference' else 'montant_date' end::text
    from public.bank_lines l
    join public.supplier_payments sp on sp.company_id = v_co and sp.amount = -l.amount and abs(sp.paid_on - l.value_date) <= 5
   where l.company_id = v_co and l.bank_account_id = p_account and l.status = 'open' and l.amount < 0
     and not exists (select 1 from public.bank_matches m where m.supplier_payment_id = sp.id);
end $$;

create function public.bank_match_confirm(p_line uuid, p_kind text, p_target uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.bank_lines%rowtype; a public.bank_accounts%rowtype; v_amount numeric; v_id uuid := gen_random_uuid();
  v_sp uuid; v_cp uuid; v_paid date;
begin
  perform private.require_perm('bank.reconcile');
  select * into l from public.bank_lines where id = p_line and company_id = v_co for update;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.status <> 'open' then raise exception 'BANK_BAD_STATUS' using errcode = '55000'; end if;
  select * into a from public.bank_accounts where id = l.bank_account_id;
  if a.currency <> private.base_currency() then raise exception 'BANK_CURRENCY_MISMATCH' using errcode = '22023'; end if;
  if p_kind = 'supplier_payment' then
    select sp.amount, sp.id, sp.paid_on into v_amount, v_sp, v_paid from public.supplier_payments sp where sp.id = p_target and sp.company_id = v_co;
    if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
    if l.amount <> -v_amount then raise exception 'BANK_TARGET_MISMATCH' using errcode = '22023', detail = l.amount::text || ' / ' || v_amount::text; end if;
    if exists (select 1 from public.bank_matches m where m.supplier_payment_id = v_sp) then raise exception 'BANK_TARGET_ALREADY_MATCHED' using errcode = '55000'; end if;
  elsif p_kind = 'client_payment' then
    select p.amount, p.id into v_amount, v_cp from public.invoice_payments p where p.id = p_target and p.company_id = v_co;
    if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
    if l.amount <> v_amount then raise exception 'BANK_TARGET_MISMATCH' using errcode = '22023', detail = l.amount::text || ' / ' || v_amount::text; end if;
    if exists (select 1 from public.bank_matches m where m.client_payment_id = v_cp) then raise exception 'BANK_TARGET_ALREADY_MATCHED' using errcode = '55000'; end if;
  else
    raise exception 'BANK_BAD_KIND' using errcode = '22023';
  end if;
  insert into public.bank_matches (id, company_id, bank_line_id, target_kind, supplier_payment_id, client_payment_id, amount)
  values (v_id, v_co, l.id, p_kind, v_sp, v_cp, abs(l.amount));
  update public.bank_lines set status = 'matched' where id = l.id;
  perform private.write_audit(v_co, 'bank.match_confirm', 'bank_line', l.id::text, null, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'matched', 'kind', p_kind, 'target', p_target), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.bank_exception_raise(p_line uuid, p_reason_code text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.bank_lines%rowtype; v_id uuid := gen_random_uuid(); v_note text := btrim(coalesce(p_note, ''));
begin
  perform private.require_perm('bank.reconcile');
  select * into l from public.bank_lines where id = p_line and company_id = v_co for update;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.status <> 'open' then raise exception 'BANK_BAD_STATUS' using errcode = '55000'; end if;
  if length(v_note) < 5 then raise exception 'BANK_REASON_REQUIRED' using errcode = '22023'; end if;
  insert into public.bank_exceptions (id, company_id, bank_line_id, reason_code, note) values (v_id, v_co, l.id, p_reason_code, v_note);
  update public.bank_lines set status = 'excepted' where id = l.id;
  perform private.write_audit(v_co, 'bank.exception_raise', 'bank_line', l.id::text, null, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'excepted', 'reason', p_reason_code), jsonb_build_object('note', v_note), 'rpc');
  return v_id;
end $$;

-- Clôture d'exception : la personne qui clôt n'est pas celle qui a ouvert ; la ligne passe en « closed » (décision documentée)
create function public.bank_exception_close(p_exception uuid, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e public.bank_exceptions%rowtype; v_text text := btrim(coalesce(p_resolution, ''));
begin
  perform private.require_perm('bank.reconcile');
  select * into e from public.bank_exceptions where id = p_exception and company_id = v_co for update;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.resolved_at is not null then raise exception 'BANK_BAD_STATUS' using errcode = '55000'; end if;
  if e.raised_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'bank_exception'; end if;
  if length(v_text) < 5 then raise exception 'BANK_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.bank_exceptions set resolution = v_text, resolved_by = auth.uid(), resolved_at = now() where id = e.id;
  update public.bank_lines set status = 'closed' where id = e.bank_line_id and status = 'excepted';
  perform private.write_audit(v_co, 'bank.exception_close', 'bank_exception', e.id::text, null, jsonb_build_object('resolved', false),
    jsonb_build_object('resolved', true), jsonb_build_object('resolution', v_text), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Coordonnées bancaires fournisseur : saisie, validation distincte, aucune coordonnée complète stockée
-- ---------------------------------------------------------------------------
create table public.supplier_bank_details (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  supplier_id     uuid not null references public.suppliers(id),
  bank_label      text not null check (length(btrim(bank_label)) between 2 and 80),
  iban_last4      text not null check (iban_last4 ~ '^[A-Z0-9]{4}$'),
  iban_fingerprint text not null,
  status          text not null default 'a_valider' check (status in ('a_valider', 'valide', 'remplacee', 'rejetee')),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  validated_by    uuid,
  validated_at    timestamptz,
  check ((status in ('valide', 'remplacee')) = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by)
);
create unique index supplier_bank_details_valid_uq on public.supplier_bank_details (supplier_id) where status = 'valide';
alter table public.supplier_bank_details enable row level security;
create policy supplier_bank_details_select on public.supplier_bank_details for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.supplier_bank_details_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'BANK_IMMUTABLE' using errcode = '55000'; end if;
  if (new.id, new.company_id, new.supplier_id, new.bank_label, new.iban_last4, new.iban_fingerprint, new.created_by, new.created_at)
     is distinct from (old.id, old.company_id, old.supplier_id, old.bank_label, old.iban_last4, old.iban_fingerprint, old.created_by, old.created_at) then
    raise exception 'BANK_IMMUTABLE' using errcode = '55000';
  end if;
  if not ((old.status = 'a_valider' and new.status in ('valide', 'rejetee')) or (old.status = 'valide' and new.status = 'remplacee')) then
    raise exception 'BANK_BAD_STATUS' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.supplier_bank_details_guard() from public, anon, authenticated;
create trigger supplier_bank_details_guard_bud before update or delete on public.supplier_bank_details
  for each row execute function private.supplier_bank_details_guard();

create function public.supplier_bank_detail_set(p_supplier uuid, p_bank_label text, p_iban text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_iban text := upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('bank.details');
  if not exists (select 1 from public.suppliers s where s.id = p_supplier and s.company_id = v_co) then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then raise exception 'BANK_IBAN_INVALID' using errcode = '22023'; end if;
  insert into public.supplier_bank_details (id, company_id, supplier_id, bank_label, iban_last4, iban_fingerprint)
  values (v_id, v_co, p_supplier, btrim(p_bank_label), right(v_iban, 4), md5(v_iban));
  perform private.write_audit(v_co, 'bank.supplier_detail_set', 'supplier', p_supplier::text, null, null,
    jsonb_build_object('detail', v_id, 'status', 'a_valider', 'last4', right(v_iban, 4)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.supplier_bank_detail_validate(p_detail uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.supplier_bank_details%rowtype;
begin
  perform private.require_perm('bank.details_validate');
  select * into d from public.supplier_bank_details where id = p_detail and company_id = v_co for update;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if d.status <> 'a_valider' then raise exception 'BANK_BAD_STATUS' using errcode = '55000'; end if;
  if d.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'bank_detail'; end if;
  if p_validate then
    update public.supplier_bank_details set status = 'remplacee' where supplier_id = d.supplier_id and status = 'valide';
    update public.supplier_bank_details set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = d.id;
  else
    update public.supplier_bank_details set status = 'rejetee' where id = d.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'bank.supplier_detail_validate' else 'bank.supplier_detail_reject' end,
    'supplier', d.supplier_id::text, null, jsonb_build_object('status', 'a_valider'), jsonb_build_object('status', case when p_validate then 'valide' else 'rejetee' end),
    jsonb_build_object('detail', d.id), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Lot de transmission (double contrôle) : transmis → accepté ; « exécuté » déduit du rapprochement
-- ---------------------------------------------------------------------------
create table public.payment_transmissions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number           text not null check (number ~ '^TRA-[0-9]{6}$'),
  status           text not null default 'transmitted' check (status in ('transmitted', 'accepted')),
  line_count       int not null check (line_count > 0),
  total_amount     numeric(15,2) not null check (total_amount > 0),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  bank_ack_ref     text check (bank_ack_ref is null or length(btrim(bank_ack_ref)) between 3 and 80),
  check ((status = 'accepted') = (acknowledged_by is not null and acknowledged_at is not null and bank_ack_ref is not null)),
  check (acknowledged_by is null or acknowledged_by is distinct from created_by),
  unique (company_id, number)
);
create unique index payment_transmissions_ack_uq on public.payment_transmissions (company_id, bank_ack_ref) where bank_ack_ref is not null;
alter table public.payment_transmissions enable row level security;
create policy payment_transmissions_select on public.payment_transmissions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create table public.payment_transmission_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  transmission_id  uuid not null references public.payment_transmissions(id),
  payment_order_id uuid not null unique references public.payment_orders(id),
  supplier_id      uuid not null references public.suppliers(id),
  bank_detail_id   uuid not null references public.supplier_bank_details(id),
  iban_fingerprint text not null,
  amount           numeric(15,2) not null check (amount > 0)
);
alter table public.payment_transmission_lines enable row level security;
create policy payment_transmission_lines_select on public.payment_transmission_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));

create function private.payment_transmission_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'BANK_IMMUTABLE' using errcode = '55000'; end if;
  if tg_table_name = 'payment_transmissions' and tg_op = 'UPDATE' and old.status = 'transmitted' and new.status = 'accepted'
     and (new.id, new.company_id, new.number, new.line_count, new.total_amount, new.created_by, new.created_at)
         is not distinct from (old.id, old.company_id, old.number, old.line_count, old.total_amount, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'BANK_IMMUTABLE' using errcode = '55000';
end $$;
revoke execute on function private.payment_transmission_guard() from public, anon, authenticated;
create trigger payment_transmissions_guard_bud before update or delete on public.payment_transmissions
  for each row execute function private.payment_transmission_guard();
create trigger payment_transmission_lines_immutable before update or delete on public.payment_transmission_lines
  for each row execute function private.payment_transmission_guard();

create function public.payment_transmission_create(p_orders uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.payment_orders%rowtype; d public.supplier_bank_details%rowtype; v_id uuid := gen_random_uuid();
  v_number text; v_total numeric := 0; v_count int := 0; x uuid;
begin
  perform private.require_perm('bank.transmit');
  if p_orders is null or cardinality(p_orders) = 0 then raise exception 'BANK_EMPTY' using errcode = '22023'; end if;
  -- Contrôles complets avant écriture
  foreach x in array p_orders loop
    select * into o from public.payment_orders where id = x and company_id = v_co;
    if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
    if o.status <> 'approved' then raise exception 'BANK_ORDER_NOT_APPROVED' using errcode = '55000'; end if;
    if o.prepared_by = auth.uid() or o.decided_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'transmission'; end if;
    if exists (select 1 from public.payment_transmission_lines l where l.payment_order_id = o.id) then raise exception 'BANK_ALREADY_TRANSMITTED' using errcode = '55000'; end if;
    select * into d from public.supplier_bank_details where supplier_id = o.supplier_id and status = 'valide';
    if not found then raise exception 'BANK_DETAIL_NOT_VALIDATED' using errcode = '55000', detail = o.number; end if;
    v_total := v_total + o.amount;
    v_count := v_count + 1;
  end loop;

  v_number := 'TRA-' || lpad(private.next_seq(v_co, 'payment_transmission')::text, 6, '0');
  insert into public.payment_transmissions (id, company_id, number, line_count, total_amount)
  values (v_id, v_co, v_number, v_count, v_total);
  foreach x in array p_orders loop
    select * into o from public.payment_orders where id = x;
    select * into d from public.supplier_bank_details where supplier_id = o.supplier_id and status = 'valide';
    insert into public.payment_transmission_lines (company_id, transmission_id, payment_order_id, supplier_id, bank_detail_id, iban_fingerprint, amount)
    values (v_co, v_id, o.id, o.supplier_id, d.id, d.iban_fingerprint, o.amount);
  end loop;
  perform private.write_audit(v_co, 'bank.transmission_create', 'payment_transmission', v_id::text, v_number, null,
    jsonb_build_object('lines', v_count, 'total', v_total), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.payment_transmission_acknowledge(p_transmission uuid, p_bank_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.payment_transmissions%rowtype; v_ref text := btrim(coalesce(p_bank_ref, ''));
begin
  perform private.require_perm('bank.acknowledge');
  select * into t from public.payment_transmissions where id = p_transmission and company_id = v_co for update;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if t.status <> 'transmitted' then raise exception 'BANK_BAD_STATUS' using errcode = '55000'; end if;
  if t.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'acknowledgement'; end if;
  if length(v_ref) < 3 then raise exception 'BANK_ACK_REQUIRED' using errcode = '22023'; end if;
  update public.payment_transmissions set status = 'accepted', acknowledged_by = auth.uid(), acknowledged_at = now(), bank_ack_ref = v_ref where id = t.id;
  perform private.write_audit(v_co, 'bank.transmission_acknowledge', 'payment_transmission', t.id::text, t.number, jsonb_build_object('status', 'transmitted'),
    jsonb_build_object('status', 'accepted', 'bank_ack_ref', v_ref), '{}'::jsonb, 'rpc');
end $$;

-- État par ligne : « exécuté » seulement si l'ordre est exécuté ET son règlement est rapproché à une ligne de relevé.
create function public.payment_transmission_status(p_transmission uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.payment_transmissions%rowtype; v_exec int; v_lines int;
begin
  perform private.require_perm('finance.read');
  select * into t from public.payment_transmissions where id = p_transmission and company_id = v_co;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  select count(*)::int into v_lines from public.payment_transmission_lines l where l.transmission_id = t.id;
  select count(*)::int into v_exec from public.payment_transmission_lines l
    join public.payment_orders o on o.id = l.payment_order_id and o.status = 'executed'
   where l.transmission_id = t.id
     and exists (select 1 from public.bank_matches m where m.supplier_payment_id = o.supplier_payment_id);
  return jsonb_build_object('number', t.number, 'status', t.status, 'bank_ack_ref', t.bank_ack_ref, 'lines', v_lines,
    'executed', v_exec, 'pending', v_lines - v_exec);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privilèges
-- ---------------------------------------------------------------------------
revoke execute on function public.bank_account_create(text, text, text, text), public.bank_statement_import(uuid, text, date, date, numeric, numeric, jsonb),
  public.bank_match_suggest(uuid), public.bank_match_confirm(uuid, text, uuid), public.bank_exception_raise(uuid, text, text),
  public.bank_exception_close(uuid, text), public.supplier_bank_detail_set(uuid, text, text), public.supplier_bank_detail_validate(uuid, boolean),
  public.payment_transmission_create(uuid[]), public.payment_transmission_acknowledge(uuid, text), public.payment_transmission_status(uuid)
  from public, anon;
grant execute on function public.bank_account_create(text, text, text, text), public.bank_statement_import(uuid, text, date, date, numeric, numeric, jsonb),
  public.bank_match_suggest(uuid), public.bank_match_confirm(uuid, text, uuid), public.bank_exception_raise(uuid, text, text),
  public.bank_exception_close(uuid, text), public.supplier_bank_detail_set(uuid, text, text), public.supplier_bank_detail_validate(uuid, boolean),
  public.payment_transmission_create(uuid[]), public.payment_transmission_acknowledge(uuid, text), public.payment_transmission_status(uuid)
  to authenticated, service_role;

-- Lecture seule pour les utilisateurs (RLS par société et droit finance.read) ; écritures uniquement par les fonctions ci-dessus
revoke all on public.bank_statements, public.bank_lines, public.bank_matches, public.bank_exceptions, public.supplier_bank_details,
  public.payment_transmissions, public.payment_transmission_lines from anon, authenticated;
grant select on public.bank_statements, public.bank_lines, public.bank_matches, public.bank_exceptions, public.supplier_bank_details,
  public.payment_transmissions, public.payment_transmission_lines to authenticated;
grant all on public.bank_statements, public.bank_lines, public.bank_matches, public.bank_exceptions, public.supplier_bank_details,
  public.payment_transmissions, public.payment_transmission_lines to service_role;
