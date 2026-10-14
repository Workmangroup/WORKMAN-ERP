-- 0060 — Réception et rapprochement trois voies (P035) : reçu / accepté / rejeté, quarantaine, retours, tolérances, litige
-- Additive. Aucune fonction existante n'est supprimée ; deux sont remplacées avec le même contrat :
--   private.supplier_payment_apply (0034) : n'impute un paiement qu'aux factures dont le dernier rapprochement est « matched »
--   (les factures sans commande gardent le comportement antérieur).
-- Réutilise : réceptions et retours (0011 : purchase_receive, purchase_return), emplacements de type « quarantine » (0009),
-- transferts de stock (public.stock_move), factures et litiges fournisseur (0022), ordres de paiement approuvés (0033/0034).
-- Règles :
--  * Reçu = quantité réceptionnée ; une ligne reçue est contrôlée une seule fois : accepté + rejeté = reçu.
--  * Le rejet est un retour fournisseur réel (sortie de stock, RET-nnnn) ; l'accepté est libéré de la quarantaine vers un emplacement de stockage.
--  * Décision par le contrôle qualité, distincte de celui qui a réceptionné (séparation des tâches).
--  * Rapprochement : montant facturé comparé au montant accepté (valorisé au prix de commande), avec tolérance paramétrée.
--    Écart au-delà de la tolérance, réception non contrôlée, ou facture au-delà de la commande : rapprochement bloquant,
--    facture mise en litige (statut « disputed » de 0022). Résolution automatique quand le rapprochement redevient conforme.
--  * Paiement distinct : régler un fournisseur reste un ordre de paiement approuvé (0033/0034) ; il n'impute que les factures
--    rapprochées (ou sans commande).
--  * Tolérances : aucune valeur n'est inventée. Sans paramétrage, la tolérance est nulle (égalité exacte).

-- ---------------------------------------------------------------------
-- 1. Tolérances (une ligne par société, saisie par finance.write ; absente = tolérance nulle)
-- ---------------------------------------------------------------------
create table public.purchase_match_tolerances (
  company_id  uuid primary key default private.current_company() references public.companies(id) on delete cascade,
  amount_abs  numeric(15,2) check (amount_abs is null or amount_abs >= 0),
  amount_pct  numeric(5,2) check (amount_pct is null or amount_pct between 0 and 100),
  set_by      uuid default auth.uid(),
  set_at      timestamptz not null default now()
);
alter table public.purchase_match_tolerances enable row level security;
create policy purchase_match_tolerances_select on public.purchase_match_tolerances for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.purchase_match_tolerances from public, anon, authenticated;
grant select on public.purchase_match_tolerances to authenticated;

create function public.purchase_tolerance_set(p_amount_abs numeric, p_amount_pct numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old record;
begin
  perform private.require_perm('finance.write');
  if p_amount_abs is not null and p_amount_abs < 0 then raise exception 'MATCH_TOLERANCE_INVALID' using errcode = '22023'; end if;
  if p_amount_pct is not null and (p_amount_pct < 0 or p_amount_pct > 100) then raise exception 'MATCH_TOLERANCE_INVALID' using errcode = '22023'; end if;
  select amount_abs, amount_pct into v_old from public.purchase_match_tolerances where company_id = v_co;
  insert into public.purchase_match_tolerances (company_id, amount_abs, amount_pct, set_by, set_at)
  values (v_co, p_amount_abs, p_amount_pct, auth.uid(), now())
  on conflict (company_id) do update set amount_abs = excluded.amount_abs, amount_pct = excluded.amount_pct, set_by = excluded.set_by, set_at = now();
  perform private.write_audit(v_co, 'match.tolerance_set', 'company', v_co::text, 'tolérances de rapprochement', jsonb_build_object('abs', v_old.amount_abs, 'pct', v_old.amount_pct),
    jsonb_build_object('abs', p_amount_abs, 'pct', p_amount_pct), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.purchase_tolerance_set(numeric, numeric) from public, anon;
grant execute on function public.purchase_tolerance_set(numeric, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Contrôle à la réception : une décision par ligne reçue (accepté + rejeté = reçu)
-- ---------------------------------------------------------------------
create table public.purchase_receipt_inspections (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  receipt_id       uuid not null references public.purchase_receipts(id),
  receipt_line_id  uuid not null unique references public.purchase_receipt_lines(id),
  qty_received     numeric(14,4) not null check (qty_received > 0),
  qty_accepted     numeric(14,4) not null check (qty_accepted >= 0),
  qty_rejected     numeric(14,4) not null check (qty_rejected >= 0),
  reason           text check (reason is null or length(btrim(reason)) between 5 and 300),
  return_id        uuid,
  decided_by       uuid default auth.uid(),
  decided_at       timestamptz not null default now(),
  check (qty_accepted + qty_rejected = qty_received),
  check (qty_rejected = 0 or reason is not null)
);
alter table public.purchase_receipt_inspections enable row level security;
create policy purchase_receipt_inspections_select on public.purchase_receipt_inspections for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.purchase_receipt_inspections from public, anon, authenticated;
grant select on public.purchase_receipt_inspections to authenticated;

-- Décision : rejet = retour fournisseur réel ; accepté = libéré de la quarantaine vers l'emplacement choisi.
-- Droits : quality.write (décision), purchases.receive (retour), stock.write (transfert). Le réceptionnaire ne décide pas.
create function public.purchase_receipt_line_decide(p_receipt_line uuid, p_accept numeric, p_reject numeric, p_reason text, p_target uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rl public.purchase_receipt_lines%rowtype; rc public.purchase_receipts%rowtype; loc public.stock_locations%rowtype; tgt public.stock_locations%rowtype;
        v_rat text := btrim(coalesce(p_reason, '')); v_ret uuid := null; v_id uuid;
begin
  perform private.require_perm('quality.write');
  perform private.require_perm('purchases.receive');
  perform private.require_perm('stock.write');
  select * into rl from public.purchase_receipt_lines where id = p_receipt_line and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_BAD_LINE' using errcode = '22023'; end if;
  select * into rc from public.purchase_receipts where id = rl.receipt_id;
  if rc.received_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'receipt_inspection'; end if;
  if exists (select 1 from public.purchase_receipt_inspections where receipt_line_id = rl.id) then raise exception 'RECEIPT_ALREADY_INSPECTED' using errcode = '55000'; end if;
  if p_accept is null or p_reject is null or p_accept < 0 or p_reject < 0 then raise exception 'RECEIPT_QTY_INVALID' using errcode = '22023'; end if;
  if p_accept + p_reject <> rl.qty - rl.qty_returned then raise exception 'RECEIPT_QTY_MISMATCH' using errcode = '22023', detail = (rl.qty - rl.qty_returned)::text; end if;
  if p_reject > 0 and length(v_rat) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into loc from public.stock_locations where id = rl.location_id;
  if p_accept > 0 and loc.kind = 'quarantine' then
    if p_target is null then raise exception 'RECEIPT_TARGET_REQUIRED' using errcode = '22023'; end if;
    select * into tgt from public.stock_locations where id = p_target and company_id = private.current_company();
    if not found or tgt.warehouse_id <> loc.warehouse_id or tgt.kind <> 'storage' or tgt.archived_at is not null then
      raise exception 'RECEIPT_TARGET_INVALID' using errcode = '22023';
    end if;
  end if;
  insert into public.purchase_receipt_inspections (company_id, receipt_id, receipt_line_id, qty_received, qty_accepted, qty_rejected, reason, decided_by)
  values (rl.company_id, rc.id, rl.id, rl.qty - rl.qty_returned, p_accept, p_reject, nullif(v_rat, ''), auth.uid())
  returning id into v_id;
  if p_reject > 0 then
    v_ret := public.purchase_return(rc.id, jsonb_build_array(jsonb_build_object('receipt_line_id', rl.id, 'qty', p_reject)),
                                    'Rejet au contrôle de réception : ' || left(v_rat, 200));
    update public.purchase_receipt_inspections set return_id = v_ret where id = v_id;
  end if;
  if p_accept > 0 and loc.kind = 'quarantine' then
    perform public.stock_move('transfer', rl.material_id, p_accept, rc.warehouse_id, rl.location_id, p_target, 'Libération contrôle ' || rc.code, 'Libération de quarantaine après contrôle', null, null);
  end if;
  perform private.write_audit(rc.company_id, 'purchase.receipt_inspect', 'purchase', rc.id::text, rc.code, null,
    jsonb_build_object('accepted', p_accept, 'rejected', p_reject, 'return', v_ret), jsonb_build_object('reason', nullif(v_rat, '')), 'rpc');
  return jsonb_build_object('inspection_id', v_id, 'accepted', p_accept, 'rejected', p_reject, 'return_id', v_ret);
end $$;
revoke execute on function public.purchase_receipt_line_decide(uuid, numeric, numeric, text, uuid) from public, anon;
grant execute on function public.purchase_receipt_line_decide(uuid, numeric, numeric, text, uuid) to authenticated, service_role;

-- Synthèse par ligne de commande : commandé, reçu, rejeté, accepté, non contrôlé, facturable (= accepté)
create function public.purchase_order_acceptance(p_po uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if not private.has_perm('purchases.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'po_line_id', pl.id, 'qty_ordered', pl.qty_ordered, 'unit_price', pl.unit_price,
      'qty_received', coalesce(r.recv, 0), 'qty_rejected', coalesce(r.rej, 0),
      'qty_accepted', coalesce(a.acc, 0), 'qty_uncontrolled', coalesce(u.unc, 0),
      'qty_billable', coalesce(a.acc, 0)) order by pl.id), '[]'::jsonb) into v_out
    from public.purchase_order_lines pl
    join public.purchase_orders po on po.id = pl.po_id and po.company_id = private.current_company()
    left join lateral (select sum(rl.qty) recv, sum(rl.qty_returned) rej from public.purchase_receipt_lines rl where rl.po_line_id = pl.id) r on true
    left join lateral (select sum(ins.qty_accepted) acc from public.purchase_receipt_inspections ins join public.purchase_receipt_lines rl2 on rl2.id = ins.receipt_line_id where rl2.po_line_id = pl.id) a on true
    left join lateral (select sum(rl3.qty - rl3.qty_returned) unc from public.purchase_receipt_lines rl3
                        where rl3.po_line_id = pl.id and not exists (select 1 from public.purchase_receipt_inspections x where x.receipt_line_id = rl3.id)) u on true
   where pl.po_id = p_po;
  return v_out;
end $$;
grant execute on function public.purchase_order_acceptance(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Rapprochement trois voies : commande, réception accepté, facture
-- ---------------------------------------------------------------------
create table public.purchase_invoice_matches (
  seq            bigint generated always as identity primary key,
  id             uuid not null unique default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id) on delete cascade,
  invoice_id     uuid not null references public.supplier_invoices(id),
  po_id          uuid references public.purchase_orders(id),
  status         text not null check (status in ('matched', 'blocked', 'no_order', 'currency_mismatch')),
  reason         text,
  ordered_value  numeric(15,2) not null,
  received_value numeric(15,2) not null,
  rejected_value numeric(15,2) not null,
  accepted_value numeric(15,2) not null,
  uncontrolled_value numeric(15,2) not null,
  invoice_total  numeric(15,2) not null,
  tolerance      numeric(15,2) not null,
  gap            numeric(15,2) not null,
  computed_by    uuid default auth.uid(),
  computed_at    timestamptz not null default now()
);
create index purchase_invoice_matches_inv_idx on public.purchase_invoice_matches (invoice_id, seq desc);
alter table public.purchase_invoice_matches enable row level security;
create policy purchase_invoice_matches_select on public.purchase_invoice_matches for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.purchase_invoice_matches from public, anon, authenticated;
grant select on public.purchase_invoice_matches to authenticated;

-- Calcul et enregistrement : historique append-only ; litige posé ou levé selon le résultat
create function public.supplier_invoice_match(p_invoice uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.supplier_invoices%rowtype; po public.purchase_orders%rowtype; t public.purchase_match_tolerances%rowtype;
        v_ord numeric := 0; v_rec numeric := 0; v_rej numeric := 0; v_acc numeric := 0; v_unc numeric := 0; v_tol numeric := 0; v_gap numeric;
        v_status text; v_reason text; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('finance.write');
  select * into i from public.supplier_invoices where id = p_invoice and company_id = private.current_company() for update;
  if not found then raise exception 'FINANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status = 'paid' then raise exception 'FINANCE_BAD_STATUS' using errcode = '55000'; end if;
  if i.purchase_order_id is null then
    v_status := 'no_order'; v_reason := 'Facture sans commande : rapprochement trois voies non applicable';
  else
    select * into po from public.purchase_orders where id = i.purchase_order_id;
    select * into t from public.purchase_match_tolerances where company_id = i.company_id;
    select coalesce(sum(qty_ordered * unit_price), 0) into v_ord from public.purchase_order_lines where po_id = po.id;
    select coalesce(sum(rl.qty * rl.unit_price), 0), coalesce(sum(rl.qty_returned * rl.unit_price), 0),
           coalesce(sum((rl.qty - rl.qty_returned) * rl.unit_price) filter (where not exists (select 1 from public.purchase_receipt_inspections x where x.receipt_line_id = rl.id)), 0)
      into v_rec, v_rej, v_unc
      from public.purchase_receipt_lines rl join public.purchase_receipts rc on rc.id = rl.receipt_id where rc.po_id = po.id;
    select coalesce(sum(ins.qty_accepted * rl.unit_price), 0) into v_acc
      from public.purchase_receipt_inspections ins join public.purchase_receipt_lines rl on rl.id = ins.receipt_line_id
      join public.purchase_receipts rc on rc.id = rl.receipt_id where rc.po_id = po.id;
    v_tol := greatest(coalesce(t.amount_abs, 0), coalesce(t.amount_pct, 0) * v_acc / 100);
    v_gap := i.total - v_acc;
    if po.currency <> i.currency then
      v_status := 'currency_mismatch'; v_reason := 'Devise de la facture différente de celle de la commande';
    elsif i.total > v_ord + v_tol then
      v_status := 'blocked'; v_reason := 'Facture supérieure au montant commandé';
    elsif v_unc > 0 then
      v_status := 'blocked'; v_reason := 'Réception non contrôlée : décision qualité requise avant rapprochement';
    elsif abs(v_gap) > v_tol then
      v_status := 'blocked'; v_reason := case when v_gap > 0 then 'Écart : facture supérieure au montant accepté' else 'Écart : facture inférieure au montant accepté' end;
    else
      v_status := 'matched'; v_reason := 'Facture conforme au montant accepté';
    end if;
  end if;
  insert into public.purchase_invoice_matches (id, company_id, invoice_id, po_id, status, reason, ordered_value, received_value, rejected_value,
    accepted_value, uncontrolled_value, invoice_total, tolerance, gap, computed_by)
  values (v_id, i.company_id, i.id, i.purchase_order_id, v_status, v_reason, v_ord, v_rec, v_rej, v_acc, v_unc, i.total, v_tol, coalesce(v_gap, i.total), auth.uid());
  if v_status = 'blocked' or v_status = 'currency_mismatch' then
    if i.status in ('open', 'partially_paid') or (i.status = 'disputed' and i.dispute_reason like 'Rapprochement :%') then
      update public.supplier_invoices set status = 'disputed', dispute_reason = left('Rapprochement : ' || v_reason, 300) where id = i.id;
    end if;
  elsif v_status = 'matched' and i.status = 'disputed' and i.dispute_reason like 'Rapprochement :%' then
    update public.supplier_invoices set status = case when i.paid_amount = 0 then 'open' else 'partially_paid' end, dispute_reason = null where id = i.id;
  end if;
  perform private.write_audit(i.company_id, 'match.compute', 'supplier_invoice', i.id::text, i.number, null,
    jsonb_build_object('status', v_status, 'gap', coalesce(v_gap, 0), 'accepted', v_acc), jsonb_build_object('reason', v_reason), 'rpc');
  return jsonb_build_object('match_id', v_id, 'status', v_status, 'reason', v_reason, 'ordered', v_ord, 'received', v_rec, 'rejected', v_rej,
    'accepted', v_acc, 'uncontrolled', v_unc, 'invoice_total', i.total, 'tolerance', v_tol, 'gap', coalesce(v_gap, i.total));
end $$;
revoke execute on function public.supplier_invoice_match(uuid) from public, anon;
grant execute on function public.supplier_invoice_match(uuid) to authenticated, service_role;

-- Une facture avec commande n'est payable que si son dernier rapprochement est conforme ; sans commande : inchangé.
create function private.invoice_match_ok(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when i.purchase_order_id is null then true
              else coalesce((select m.status = 'matched' from public.purchase_invoice_matches m where m.invoice_id = i.id order by m.seq desc limit 1), false) end
    from public.supplier_invoices i where i.id = p_invoice
$$;
revoke execute on function private.invoice_match_ok(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Paiement : imputation seulement aux factures rapprochées (ou sans commande). Le reste inchangé (0034).
-- ---------------------------------------------------------------------
create or replace function private.supplier_payment_apply(p_supplier uuid, p_amount numeric, p_paid_on date, p_method text, p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pay uuid := gen_random_uuid(); v_number text; v_left numeric := p_amount; v_open numeric; r record; v_take numeric; v_alloc int := 0;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(total - paid_amount), 0) into v_open from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid') and private.invoice_match_ok(id);
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  insert into public.supplier_payments (id, supplier_id, amount, paid_on, method, reference)
  values (v_pay, p_supplier, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'transfer'), nullif(btrim(coalesce(p_reference, '')), ''))
  returning number into v_number;
  for r in select id, total, paid_amount from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid') and private.invoice_match_ok(id)
    order by due_date, invoice_date, number for update loop
    exit when v_left <= 0;
    v_take := least(v_left, r.total - r.paid_amount);
    insert into public.supplier_payment_allocations (company_id, payment_id, supplier_invoice_id, amount) values (v_co, v_pay, r.id, v_take);
    update public.supplier_invoices set paid_amount = paid_amount + v_take,
      status = case when paid_amount + v_take = total then 'paid' else 'partially_paid' end where id = r.id;
    v_left := v_left - v_take;
    v_alloc := v_alloc + 1;
  end loop;
  perform private.write_audit(v_co, 'finance.supplier_payment', 'supplier_payment', v_pay::text, v_number, null,
    jsonb_build_object('amount', p_amount, 'invoices', v_alloc), '{}'::jsonb, 'rpc');
  return jsonb_build_object('id', v_pay, 'number', v_number, 'allocated_invoices', v_alloc);
end $$;
revoke execute on function private.supplier_payment_apply(uuid, numeric, date, text, text) from public, anon, authenticated;
