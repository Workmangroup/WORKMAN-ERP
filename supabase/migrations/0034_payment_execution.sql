-- =====================================================================
-- 0034_payment_execution — Exécution des paiements fournisseurs à partir d'un ordre approuvé (P011, suite)
--  Décisions confirmées :
--    1. Plus aucun paiement fournisseur direct : supplier_payment_record refuse (PAYMENT_REQUIRES_APPROVED_ORDER).
--       Le paiement se fait par payment_order_execute, sur un ordre approuvé, par une personne ≠ préparateur
--       (droit payments.execute). Le solde et la règle de surpaiement sont revérifiés à l'exécution.
--    2. Visibilité : un délégué voit les ordres et dérogations qui lui sont déléguées (RLS), et accède à l'écran
--       « Délégations et contrôles » seulement s'il a un droit de gouvernance ou une délégation active.
--    3. Lot critique : seul le responsable qualité (quality.approve) marque un contrôle comme critique.
--  Migration additive pour les tables ; le corps de supplier_payment_record est déplacé dans
--  private.supplier_payment_apply (même logique qu'en 0022), la fonction publique devient un refus explicite.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission d'exécution
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('payments.execute', 'finance', 'Exécuter un paiement approuvé', 'Enregistrer le règlement d''un ordre de paiement approuvé (préparateur exclu)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'payments.execute'
  and r.code in ('admin', 'finance')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Ordres de paiement : état « executed » et traçabilité du règlement
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.payment_orders'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%status%' loop
    execute format('alter table public.payment_orders drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.payment_orders
  add column executed_by uuid references public.profiles(id),
  add column executed_at timestamptz,
  add column supplier_payment_id uuid references public.supplier_payments(id),
  add constraint payment_orders_status_chk check (status in ('prepared', 'approved', 'rejected', 'executed')),
  add constraint payment_orders_decision_chk check (
       (status = 'prepared' and decided_by is null and decided_at is null)
    or (status in ('approved', 'rejected', 'executed') and decided_by is not null and decided_at is not null)),
  add constraint payment_orders_execution_chk check (
       (status = 'executed' and executed_by is not null and executed_at is not null and supplier_payment_id is not null)
    or (status <> 'executed' and executed_by is null and executed_at is null and supplier_payment_id is null)),
  add constraint payment_orders_execution_sod_chk check (executed_by is distinct from prepared_by);

-- ---------------------------------------------------------------------
-- 3. Visibilité par délégation (RLS) et accès à l'écran
-- ---------------------------------------------------------------------
-- Vrai si l'utilisateur a une délégation active sur cet objet (ou sur tous les objets de ce type).
create function private.delegation_visible(p_obj_type text, p_obj_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.delegations d
    where d.company_id = private.current_company() and d.delegate_id = auth.uid() and d.object_type = p_obj_type
      and (d.object_id is null or d.object_id = p_obj_id) and d.revoked_at is null and now() between d.starts_at and d.ends_at)
$$;

drop policy payment_orders_select on public.payment_orders;
create policy payment_orders_select on public.payment_orders for select to authenticated
  using (company_id = private.current_company() and (prepared_by = auth.uid()
    or private.has_perm('payments.read') or private.has_perm('payments.approve') or private.has_perm('payments.execute')
    or private.delegation_visible('payment_order', id)));

drop policy derogations_select on public.derogations;
create policy derogations_select on public.derogations for select to authenticated
  using (company_id = private.current_company() and (requested_by = auth.uid()
    or private.has_perm('derogations.approve') or private.has_perm('derogations.control') or private.has_perm('derogations.request')
    or private.delegation_visible('derogation', id)));

-- Accès à l'écran : droit de gouvernance, ou délégation active (accordée ou reçue).
create function public.governance_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_perm('delegations.read') or private.has_perm('delegations.grant') or private.has_perm('payments.prepare')
      or private.has_perm('payments.approve') or private.has_perm('payments.execute') or private.has_perm('derogations.request')
      or private.has_perm('derogations.approve') or private.has_perm('derogations.control') or private.has_perm('quality.approve')
      or exists (select 1 from public.delegations d
           where (d.delegate_id = auth.uid() or d.delegator_id = auth.uid()) and d.revoked_at is null and now() <= d.ends_at)
$$;
grant execute on function public.governance_access() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Paiement : corps déplacé dans une fonction interne, appelée seulement à l'exécution d'un ordre approuvé
-- ---------------------------------------------------------------------
create function private.supplier_payment_apply(p_supplier uuid, p_amount numeric, p_paid_on date, p_method text, p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pay uuid := gen_random_uuid(); v_number text; v_left numeric := p_amount; v_open numeric; r record; v_take numeric; v_alloc int := 0;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'FINANCE_BAD_AMOUNT' using errcode = '22023'; end if;
  select coalesce(sum(total - paid_amount), 0) into v_open from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid');
  if p_amount > v_open then raise exception 'FINANCE_OVERPAYMENT' using errcode = '22023'; end if;
  insert into public.supplier_payments (id, supplier_id, amount, paid_on, method, reference)
  values (v_pay, p_supplier, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'transfer'), nullif(btrim(coalesce(p_reference, '')), ''))
  returning number into v_number;
  for r in select id, total, paid_amount from public.supplier_invoices
    where company_id = v_co and supplier_id = p_supplier and status in ('open', 'partially_paid')
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

-- Le paiement direct n'est plus possible : seul un ordre approuvé peut régler un fournisseur.
create or replace function public.supplier_payment_record(p_supplier uuid, p_amount numeric, p_paid_on date, p_method text default 'transfer', p_reference text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'PAYMENT_REQUIRES_APPROVED_ORDER' using errcode = '42501', detail = 'Un règlement fournisseur passe par un ordre de paiement approuvé.';
end $$;

-- Exécution : droit payments.execute, ordre approuvé, exécutant ≠ préparateur ; solde revérifié.
create function public.payment_order_execute(p_order uuid, p_paid_on date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.payment_orders%rowtype; v_pay jsonb;
begin
  perform private.require_perm('payments.execute');
  select * into o from public.payment_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'approved' then raise exception 'PAYMENT_ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if o.prepared_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'payment_order'; end if;
  v_pay := private.supplier_payment_apply(o.supplier_id, o.amount, coalesce(p_paid_on, current_date), 'transfer', o.number);
  update public.payment_orders set status = 'executed', executed_by = auth.uid(), executed_at = now(),
    supplier_payment_id = (v_pay ->> 'id')::uuid where id = o.id;
  perform private.write_audit(o.company_id, 'payment_order.execute', 'payment_order', o.id::text, o.number,
    jsonb_build_object('status', 'approved'), jsonb_build_object('status', 'executed', 'supplier_payment', v_pay ->> 'number'),
    jsonb_build_object('amount', o.amount, 'prepared_by', o.prepared_by), 'rpc');
  return v_pay;
end $$;
grant execute on function public.payment_order_execute(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Lot critique : marquage réservé au responsable qualité (quality.approve)
-- ---------------------------------------------------------------------
create or replace function public.quality_inspection_mark_critical(p_inspection uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype;
begin
  perform private.require_perm('quality.approve');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.quality_inspections set critical = true where id = i.id;
  perform private.write_audit(i.company_id, 'quality.mark_critical', 'quality_inspection', i.id::text, i.number, jsonb_build_object('critical', false),
    jsonb_build_object('critical', true), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
