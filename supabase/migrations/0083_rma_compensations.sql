-- 0083_rma_compensations — Retours (RMA), réparation / remplacement / avoir / remboursement (P058).
--
-- Existant conservé : retours clients (0055 : return_request, return_receive, return_open_inspection, return_settle — réception,
-- inspection qualité, règlement en stock vendable ou lot non conforme), avoirs bornés par ligne de facture (0012 : credit_note_create,
-- credit_note_issue, CREDIT_OVER_CREDIT), factures (0012, 0056), encaissements (0022). Aucune de ces fonctions n'est remplacée.
--
-- Règles :
--  * Un dossier RMA par retour, lié à la facture de la commande livrée (même commande, même client). Ce lien est figé.
--  * Décision indépendante du retour physique : une compensation peut être décidée avant réception.
--  * Exécution exigeant un retour contrôlé : le retour doit être réglé (accepté ou non conforme). Un retour rejeté par la qualité
--    reste traité : son lot est non conforme, la compensation se décide sur ce constat.
--  * Bornes : réparation, remplacement et avoir (quantités) : la somme des quantités non annulées ne dépasse pas la quantité retournée.
--    Remboursement (montant) : la somme des remboursements non annulés ne dépasse pas le total de l'avoir exécuté pour ce dossier.
--  * Double compensation refusée : même quantité deux fois, ou même avoir remboursé au-delà de son total.
--  * Séparation des tâches : celui qui décide n'exécute pas et n'approuve pas la même compensation ; le remboursement exige une
--    approbation distincte (rma.approve_refund) avant exécution.
--  * Pas d'avoir automatique : seule une personne habilitée décide (source « human », imposée par contrainte) puis exécute.
--    Aucune fonction n'accepte une source automatique ; un résumé IA ne peut donc pas déclencher de compensation.
--  * Remboursement : enregistré comme exécuté dans l'ERP ; le virement lui-même reste hors de l'ERP (aucun connecteur bancaire).
-- Erreurs : RMA_NOT_FOUND, RMA_EXISTS, RMA_CLOSED, RMA_INVOICE_NOT_RELATED, RMA_INVOICE_REQUIRED, RMA_INVOICE_LOCKED, RMA_KIND_INVALID,
-- RMA_QTY_INVALID, RMA_QTY_EXCEEDED, RMA_AMOUNT_INVALID, RMA_AMOUNT_NOT_APPLICABLE, RMA_AMOUNT_EXCEEDED, RMA_CREDIT_NOTE_NOT_LINKED,
-- RMA_NOT_INSPECTED, RMA_BAD_STATUS, RMA_REFUND_NOT_APPROVED, RMA_SELF_EXECUTE, RMA_SELF_APPROVE, RMA_KEY_REQUIRED, RMA_KEY_REUSED,
-- RMA_REASON_REQUIRED, RMA_INVOICE_LINES_INSUFFICIENT, RMA_HAS_EXECUTED, RMA_LEDGER_APPEND_ONLY, RETURN_NOT_FOUND, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('rma.write', 'shipping', 'Gérer les retours RMA et décider des compensations', 'Ouvrir un dossier RMA, décider, annuler une compensation'),
  ('rma.approve_refund', 'finance', 'Approuver un remboursement RMA', 'Approbation distincte de celui qui décide le remboursement')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (p.code = 'rma.write' and r.code in ('admin', 'direction', 'commercial'))
  or (p.code = 'rma.approve_refund' and r.code in ('admin', 'direction', 'finance')))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.rma_cases (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number      text not null,
  return_id   uuid not null unique references public.customer_returns(id) on delete restrict,
  client_id   uuid not null references public.clients(id) on delete restrict,
  invoice_id  uuid references public.invoices(id) on delete restrict,
  status      text not null default 'open' check (status in ('open', 'cancelled')),
  opened_at   timestamptz not null default now(),
  opened_by   uuid default auth.uid(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 5 and 300),
  unique (company_id, number),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

create table public.rma_compensations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  rma_id          uuid not null references public.rma_cases(id) on delete restrict,
  kind            text not null check (kind in ('repair', 'replacement', 'credit_note', 'refund')),
  qty             int check (qty is null or qty > 0),
  amount          numeric(14,2) check (amount is null or amount > 0),
  credit_note_id  uuid references public.credit_notes(id) on delete restrict,
  status          text not null default 'decided' check (status in ('decided', 'executed', 'cancelled')),
  reason          text not null check (length(btrim(reason)) between 5 and 300),
  source          text not null default 'human' check (source = 'human'),
  idem_key        text not null check (length(btrim(idem_key)) between 8 and 80),
  decided_by      uuid default auth.uid(),
  decided_at      timestamptz not null default now(),
  approved_by     uuid,
  approved_at     timestamptz,
  executed_by     uuid,
  executed_at     timestamptz,
  cancelled_at    timestamptz,
  unique (company_id, idem_key),
  check ((kind = 'refund') = (amount is not null)),
  check ((kind = 'refund') = (credit_note_id is not null) or kind <> 'refund'),
  check (kind = 'refund' or qty is not null),
  check (kind <> 'refund' or qty is null),
  check ((approved_by is null) = (approved_at is null)),
  check ((status = 'executed') = (executed_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index rma_compensations_rma_idx on public.rma_compensations (rma_id, status);
create index rma_compensations_cn_idx on public.rma_compensations (credit_note_id) where credit_note_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Garde-fous
-- ---------------------------------------------------------------------------
-- Lien facture figé ; le client du dossier est celui de la facture
create function private.rma_case_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client uuid;
begin
  if tg_op = 'DELETE' then raise exception 'RMA_LEDGER_APPEND_ONLY' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    raise exception 'RMA_INVOICE_LOCKED' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and (new.number, new.return_id, new.client_id, new.opened_at, new.opened_by)
     is distinct from (old.number, old.return_id, old.client_id, old.opened_at, old.opened_by) then
    raise exception 'RMA_LEDGER_APPEND_ONLY' using errcode = '42501';
  end if;
  if new.invoice_id is not null then
    select client_id into v_client from public.invoices where id = new.invoice_id;
    if v_client is distinct from new.client_id then raise exception 'RMA_INVOICE_NOT_RELATED' using errcode = '22023'; end if;
  end if;
  return new;
end $$;
revoke execute on function private.rma_case_guard() from public, anon, authenticated;
create trigger rma_cases_guard_biud before insert or update or delete on public.rma_cases
  for each row execute function private.rma_case_guard();

-- Compensations : identité figée ; seules les transitions de statut (décidée → exécutée ou annulée) et les approbations sont permises
create function private.rma_comp_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'RMA_LEDGER_APPEND_ONLY' using errcode = '42501'; end if;
  if (new.company_id, new.rma_id, new.kind, new.qty, new.amount, new.reason, new.source, new.idem_key, new.decided_by, new.decided_at)
     is distinct from (old.company_id, old.rma_id, old.kind, old.qty, old.amount, old.reason, old.source, old.idem_key, old.decided_by, old.decided_at) then
    raise exception 'RMA_LEDGER_APPEND_ONLY' using errcode = '42501';
  end if;
  if old.status <> 'decided' and new.status is distinct from old.status then raise exception 'RMA_BAD_STATUS' using errcode = '55000'; end if;
  if old.credit_note_id is not null and new.credit_note_id is distinct from old.credit_note_id then
    raise exception 'RMA_LEDGER_APPEND_ONLY' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function private.rma_comp_guard() from public, anon, authenticated;
create trigger rma_compensations_guard_biud before update or delete on public.rma_compensations
  for each row execute function private.rma_comp_guard();

-- ---------------------------------------------------------------------------
-- 4. Dossier RMA
-- ---------------------------------------------------------------------------
create function public.rma_open(p_return uuid, p_invoice uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); ret public.customer_returns%rowtype; ln public.shipment_lines%rowtype;
  s public.shipments%rowtype; inv public.invoices%rowtype; v_id uuid := gen_random_uuid(); v_no text;
begin
  perform private.require_perm('rma.write');
  select * into ret from public.customer_returns where id = p_return and company_id = v_co;
  if not found then raise exception 'RETURN_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.rma_cases where return_id = ret.id) then raise exception 'RMA_EXISTS' using errcode = '23505'; end if;
  select * into ln from public.shipment_lines where id = ret.shipment_line_id;
  select * into s from public.shipments where id = ln.shipment_id;
  if p_invoice is not null then
    select * into inv from public.invoices where id = p_invoice and company_id = v_co;
    if not found or inv.status not in ('issued', 'partially_paid', 'paid', 'credited')
       or inv.order_id is distinct from s.sales_order_id or inv.client_id is distinct from s.client_id then
      raise exception 'RMA_INVOICE_NOT_RELATED' using errcode = '22023';
    end if;
  end if;
  v_no := 'RMA-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(v_co, 'rma')::text, 6, '0');
  insert into public.rma_cases (id, company_id, number, return_id, client_id, invoice_id)
  values (v_id, v_co, v_no, ret.id, s.client_id, p_invoice);
  perform private.write_audit(v_co, 'rma.open', 'customer_return', ret.id::text, v_no, null,
    jsonb_build_object('invoice_linked', p_invoice is not null), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.rma_cancel(p_rma uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.rma_cases%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('rma.write');
  if length(v_reason) < 5 then raise exception 'RMA_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into r from public.rma_cases where id = p_rma and company_id = v_co for update;
  if not found then raise exception 'RMA_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'open' then raise exception 'RMA_CLOSED' using errcode = '55000'; end if;
  if exists (select 1 from public.rma_compensations where rma_id = r.id and status = 'executed') then raise exception 'RMA_HAS_EXECUTED' using errcode = '55000'; end if;
  update public.rma_cases set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason where id = r.id;
  update public.rma_compensations set status = 'cancelled', cancelled_at = now() where rma_id = r.id and status = 'decided';
  perform private.write_audit(v_co, 'rma.cancel', 'rma_case', r.id::text, r.number, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'cancelled'), jsonb_build_object('reason', v_reason), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Décision de compensation (indépendante du retour physique) — bornée et idempotente
-- ---------------------------------------------------------------------------
create function public.rma_compensation_decide(p_rma uuid, p_kind text, p_qty int, p_amount numeric, p_credit_note uuid,
  p_reason text, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.rma_cases%rowtype; ret public.customer_returns%rowtype;
  k public.rma_compensations%rowtype; cn public.credit_notes%rowtype; v_id uuid := gen_random_uuid(); v_used int; v_refunded numeric;
  v_key text := btrim(coalesce(p_key, '')); v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('rma.write');
  if length(v_key) < 8 then raise exception 'RMA_KEY_REQUIRED' using errcode = '22023'; end if;
  -- rejeu : même clé, même dossier et même nature → décision existante ; sinon refus
  select * into k from public.rma_compensations where company_id = v_co and idem_key = v_key;
  if found then
    if k.rma_id <> p_rma or k.kind <> p_kind then raise exception 'RMA_KEY_REUSED' using errcode = '22023'; end if;
    return k.id;
  end if;
  if length(v_reason) < 5 then raise exception 'RMA_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_kind not in ('repair', 'replacement', 'credit_note', 'refund') then raise exception 'RMA_KIND_INVALID' using errcode = '22023'; end if;
  select * into r from public.rma_cases where id = p_rma and company_id = v_co for update;
  if not found then raise exception 'RMA_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'open' then raise exception 'RMA_CLOSED' using errcode = '55000'; end if;
  select * into ret from public.customer_returns where id = r.return_id;

  if p_kind in ('repair', 'replacement', 'credit_note') then
    if p_amount is not null then raise exception 'RMA_AMOUNT_NOT_APPLICABLE' using errcode = '22023'; end if;
    if p_qty is null or p_qty <= 0 then raise exception 'RMA_QTY_INVALID' using errcode = '22023'; end if;
    select coalesce(sum(qty), 0) into v_used from public.rma_compensations
      where rma_id = r.id and status <> 'cancelled' and kind in ('repair', 'replacement', 'credit_note');
    if v_used + p_qty > ret.qty then raise exception 'RMA_QTY_EXCEEDED' using errcode = '22023'; end if;
    if p_kind = 'credit_note' and r.invoice_id is null then raise exception 'RMA_INVOICE_REQUIRED' using errcode = '55000'; end if;
    insert into public.rma_compensations (id, company_id, rma_id, kind, qty, reason, idem_key, decided_by)
    values (v_id, v_co, r.id, p_kind, p_qty, v_reason, v_key, auth.uid());
  else
    if p_amount is null or p_amount <= 0 then raise exception 'RMA_AMOUNT_INVALID' using errcode = '22023'; end if;
    if p_qty is not null then raise exception 'RMA_AMOUNT_NOT_APPLICABLE' using errcode = '22023'; end if;
    if p_credit_note is null then raise exception 'RMA_CREDIT_NOTE_NOT_LINKED' using errcode = '22023'; end if;
    select * into cn from public.credit_notes where id = p_credit_note and company_id = v_co;
    if not found or cn.status <> 'issued' or cn.invoice_id is distinct from r.invoice_id
       or not exists (select 1 from public.rma_compensations c where c.rma_id = r.id and c.kind = 'credit_note'
                      and c.status = 'executed' and c.credit_note_id = cn.id) then
      raise exception 'RMA_CREDIT_NOTE_NOT_LINKED' using errcode = '22023';
    end if;
    select coalesce(sum(amount), 0) into v_refunded from public.rma_compensations
      where kind = 'refund' and credit_note_id = cn.id and status <> 'cancelled';
    if v_refunded + p_amount > cn.total then raise exception 'RMA_AMOUNT_EXCEEDED' using errcode = '22023'; end if;
    insert into public.rma_compensations (id, company_id, rma_id, kind, amount, credit_note_id, reason, idem_key, decided_by)
    values (v_id, v_co, r.id, 'refund', p_amount, cn.id, v_reason, v_key, auth.uid());
  end if;
  perform private.write_audit(v_co, 'rma.compensation_decide', 'rma_case', r.id::text, r.number, null,
    jsonb_build_object('kind', p_kind, 'qty', p_qty, 'amount', p_amount), jsonb_build_object('reason', v_reason), 'rpc');
  return v_id;
end $$;

create function public.rma_compensation_cancel(p_comp uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); k public.rma_compensations%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('rma.write');
  if length(v_reason) < 5 then raise exception 'RMA_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into k from public.rma_compensations where id = p_comp and company_id = v_co for update;
  if not found then raise exception 'RMA_NOT_FOUND' using errcode = 'P0002'; end if;
  if k.status <> 'decided' then raise exception 'RMA_BAD_STATUS' using errcode = '55000'; end if;
  update public.rma_compensations set status = 'cancelled', cancelled_at = now() where id = k.id;
  perform private.write_audit(v_co, 'rma.compensation_cancel', 'rma_case', k.rma_id::text, null, jsonb_build_object('kind', k.kind),
    jsonb_build_object('status', 'cancelled'), jsonb_build_object('reason', v_reason), 'rpc');
end $$;

-- Approbation distincte d'un remboursement
create function public.rma_refund_approve(p_comp uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); k public.rma_compensations%rowtype;
begin
  perform private.require_perm('rma.approve_refund');
  select * into k from public.rma_compensations where id = p_comp and company_id = v_co for update;
  if not found then raise exception 'RMA_NOT_FOUND' using errcode = 'P0002'; end if;
  if k.kind <> 'refund' or k.status <> 'decided' or k.approved_at is not null then raise exception 'RMA_BAD_STATUS' using errcode = '55000'; end if;
  if k.decided_by is not distinct from auth.uid() then raise exception 'RMA_SELF_APPROVE' using errcode = '42501'; end if;
  update public.rma_compensations set approved_by = auth.uid(), approved_at = now() where id = k.id;
  perform private.write_audit(v_co, 'rma.refund_approve', 'rma_case', k.rma_id::text, null, null,
    jsonb_build_object('amount', k.amount), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Exécution : retour contrôlé requis ; avoir créé et émis par le module existant ; remboursement approuvé
-- ---------------------------------------------------------------------------
create function public.rma_compensation_execute(p_comp uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); k public.rma_compensations%rowtype; r public.rma_cases%rowtype;
  ret public.customer_returns%rowtype; inv public.invoices%rowtype; cn_id uuid := gen_random_uuid(); l record; v_left int; v_take int;
  v_code text; v_result jsonb;
begin
  select * into k from public.rma_compensations where id = p_comp and company_id = v_co for update;
  if not found then raise exception 'RMA_NOT_FOUND' using errcode = 'P0002'; end if;
  if k.status <> 'decided' then raise exception 'RMA_BAD_STATUS' using errcode = '55000'; end if;
  select * into r from public.rma_cases where id = k.rma_id;
  if r.status <> 'open' then raise exception 'RMA_CLOSED' using errcode = '55000'; end if;
  select * into ret from public.customer_returns where id = r.return_id;
  if ret.status not in ('accepted', 'rejected') then raise exception 'RMA_NOT_INSPECTED' using errcode = '55000'; end if;
  if k.decided_by is not distinct from auth.uid() then raise exception 'RMA_SELF_EXECUTE' using errcode = '42501'; end if;

  if k.kind in ('repair', 'replacement') then
    perform private.require_perm('shipments.write');
    update public.rma_compensations set status = 'executed', executed_by = auth.uid(), executed_at = now() where id = k.id;
    v_result := jsonb_build_object('kind', k.kind, 'qty', k.qty);

  elsif k.kind = 'credit_note' then
    perform private.require_perm('invoices.write');
    select * into inv from public.invoices where id = r.invoice_id;
    -- lignes de facture de la variante retournée, dans la limite de la quantité décidée et du non-avoir déjà émis
    perform set_config('commercial.rpc', 'on', true);
    insert into public.credit_notes (id, company_id, invoice_id, client_id, reason, currency, tax_rate)
    values (cn_id, v_co, inv.id, inv.client_id, 'Compensation ' || r.number, inv.currency, inv.tax_rate);
    v_left := k.qty;
    for l in select il.id as line_id, il.pos, il.description, il.unit_price, il.discount_pct, il.qty - il.qty_credited as free
             from public.invoice_lines il join public.sales_order_lines ol on ol.id = il.order_line_id
             where il.invoice_id = inv.id and ol.variant_id = ret.variant_id and il.qty - il.qty_credited > 0
             order by il.pos loop
      exit when v_left <= 0;
      v_take := least(l.free, v_left);
      insert into public.credit_note_lines (company_id, credit_note_id, invoice_line_id, pos, description, qty, unit_price, discount_pct)
      values (v_co, cn_id, l.line_id, l.pos, l.description, v_take, l.unit_price, l.discount_pct);
      v_left := v_left - v_take;
    end loop;
    perform set_config('commercial.rpc', 'off', true);
    if v_left > 0 then raise exception 'RMA_INVOICE_LINES_INSUFFICIENT' using errcode = '55000'; end if;
    v_code := public.credit_note_issue(cn_id, false);
    update public.rma_compensations set status = 'executed', credit_note_id = cn_id, executed_by = auth.uid(), executed_at = now() where id = k.id;
    v_result := jsonb_build_object('kind', 'credit_note', 'qty', k.qty, 'credit_note', v_code);

  else  -- refund
    perform private.require_perm('payments.write');
    if k.approved_at is null then raise exception 'RMA_REFUND_NOT_APPROVED' using errcode = '55000'; end if;
    update public.rma_compensations set status = 'executed', executed_by = auth.uid(), executed_at = now() where id = k.id;
    v_result := jsonb_build_object('kind', 'refund', 'amount', k.amount, 'note', 'Virement hors ERP');
  end if;

  perform private.write_audit(v_co, 'rma.compensation_execute', 'rma_case', r.id::text, r.number, jsonb_build_object('status', 'decided'),
    jsonb_build_object('status', 'executed', 'kind', k.kind), '{}'::jsonb, 'rpc');
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Lecture : état du dossier, quantités restantes, remboursable par avoir
-- ---------------------------------------------------------------------------
create function public.rma_status_get(p_rma uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.rma_cases%rowtype; ret public.customer_returns%rowtype; v_inv text;
  v_used int; v_items jsonb; v_cn jsonb;
begin
  perform private.require_perm('shipments.read');
  select * into r from public.rma_cases where id = p_rma and company_id = v_co;
  if not found then raise exception 'RMA_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into ret from public.customer_returns where id = r.return_id;
  select code into v_inv from public.invoices where id = r.invoice_id;
  select coalesce(sum(qty), 0) into v_used from public.rma_compensations where rma_id = r.id and status <> 'cancelled' and kind in ('repair', 'replacement', 'credit_note');
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'qty', c.qty, 'amount', c.amount, 'status', c.status,
      'approved', c.approved_at is not null, 'credit_note_id', c.credit_note_id) order by c.decided_at), '[]'::jsonb)
    into v_items from public.rma_compensations c where c.rma_id = r.id;
  select coalesce(jsonb_agg(jsonb_build_object('credit_note_id', n.id, 'code', n.code, 'total', n.total,
      'refunded', coalesce((select sum(x.amount) from public.rma_compensations x where x.kind = 'refund' and x.credit_note_id = n.id and x.status <> 'cancelled'), 0),
      'refundable', n.total - coalesce((select sum(x.amount) from public.rma_compensations x where x.kind = 'refund' and x.credit_note_id = n.id and x.status <> 'cancelled'), 0)
    )), '[]'::jsonb)
    into v_cn from public.credit_notes n where n.id in (select c.credit_note_id from public.rma_compensations c where c.rma_id = r.id and c.kind = 'credit_note' and c.status = 'executed');
  return jsonb_build_object('rma', r.number, 'status', r.status, 'return_status', ret.status,
    'settled', ret.status in ('accepted', 'rejected'), 'invoice', v_inv, 'qty_returned', ret.qty,
    'qty_compensated', v_used, 'qty_remaining', ret.qty - v_used, 'compensations', v_items, 'credit_notes', v_cn);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.rma_cases enable row level security;
alter table public.rma_compensations enable row level security;
create policy rma_cases_select on public.rma_cases for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy rma_compensations_select on public.rma_compensations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
revoke all on public.rma_cases, public.rma_compensations from anon, authenticated;
grant select on public.rma_cases, public.rma_compensations to authenticated;
grant all on public.rma_cases, public.rma_compensations to service_role;

revoke execute on function public.rma_open(uuid, uuid), public.rma_cancel(uuid, text), public.rma_compensation_decide(uuid, text, int, numeric, uuid, text, text),
  public.rma_compensation_cancel(uuid, text), public.rma_refund_approve(uuid), public.rma_compensation_execute(uuid), public.rma_status_get(uuid)
  from public, anon;
grant execute on function public.rma_open(uuid, uuid), public.rma_cancel(uuid, text), public.rma_compensation_decide(uuid, text, int, numeric, uuid, text, text),
  public.rma_compensation_cancel(uuid, text), public.rma_refund_approve(uuid), public.rma_compensation_execute(uuid), public.rma_status_get(uuid)
  to authenticated, service_role;
