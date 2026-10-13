-- 0057 — Demandes d'achat et budget (P032) : budget par centre de coût, engagé / réalisé, contrôle à la soumission,
-- workflow de seuils par le moteur d'approbation existant (0043), séparation des tâches et délégation bornée.
-- Additive. Réutilise : demandes et lignes d'achat (0011), centres de coût (0042), moteur d'approbation (0043),
-- prix matière (0008 bom_material_prices), réceptions et commandes (0011).
-- Remplace (même capacité, corps étendu, comportement inchangé sans centre de coût ni politique) :
--   purchase_request_submit, purchase_request_decide, purchase_request_cancel.
-- Engagé = demandes soumises ou approuvées non encore converties + reste à recevoir des commandes ouvertes.
-- Réalisé = quantités reçues valorisées au prix de commande, nettes des retours fournisseur.
-- Limite : une commande fournisseur saisie sans demande d'achat n'est rattachée à aucun centre de coût : elle n'est pas budgétée.

-- ---------------------------------------------------------------------
-- 1. Colonnes et droits d'écriture additifs
-- ---------------------------------------------------------------------
alter table public.purchase_requests add column if not exists cost_center_id uuid;
alter table public.purchase_requests add constraint purchase_requests_cost_center_fk
  foreign key (company_id, cost_center_id) references public.cost_centers(company_id, id);
alter table public.purchase_request_lines add column if not exists est_unit_cost numeric(14,4)
  check (est_unit_cost is null or (est_unit_cost >= 0 and est_unit_cost < 1000000000));

grant insert (cost_center_id) on public.purchase_requests to authenticated;
grant update (cost_center_id) on public.purchase_requests to authenticated;
grant insert (est_unit_cost) on public.purchase_request_lines to authenticated;
grant update (est_unit_cost) on public.purchase_request_lines to authenticated;

-- ---------------------------------------------------------------------
-- 2. Budgets par centre de coût et par période
-- ---------------------------------------------------------------------
create table public.purchase_budgets (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id) on delete cascade,
  cost_center_id uuid not null,
  period_start   date not null,
  period_end     date not null,
  amount         numeric(14,2) not null check (amount >= 0 and amount < 1000000000000),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  foreign key (company_id, cost_center_id) references public.cost_centers(company_id, id),
  check (period_end >= period_start)
);
create index purchase_budgets_cc_idx on public.purchase_budgets (company_id, cost_center_id, period_start);
alter table public.purchase_budgets enable row level security;
create policy purchase_budgets_select on public.purchase_budgets for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
grant select on public.purchase_budgets to authenticated;
revoke all on public.purchase_budgets from public, anon;

-- ---------------------------------------------------------------------
-- 3. État budgétaire d'un centre à une date : budget, engagé, réalisé, disponible (calcul seul, sans effet)
-- ---------------------------------------------------------------------
create function private.purchase_budget_state(p_company uuid, p_cc uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.purchase_budgets%rowtype; v_eng_pr numeric; v_eng_po numeric; v_real numeric;
begin
  select * into b from public.purchase_budgets
   where company_id = p_company and cost_center_id = p_cc and p_date between period_start and period_end limit 1;
  if not found then return null; end if;
  select coalesce(sum(l.qty * coalesce(l.est_unit_cost, 0)), 0) into v_eng_pr
    from public.purchase_request_lines l join public.purchase_requests p on p.id = l.request_id
   where p.company_id = p_company and p.cost_center_id = p_cc and p.status in ('submitted', 'approved') and l.po_line_id is null
     and coalesce(p.needed_date, p.created_at::date) between b.period_start and b.period_end;
  select coalesce(sum((pl.qty_ordered - pl.qty_received) * pl.unit_price), 0) into v_eng_po
    from public.purchase_order_lines pl join public.purchase_orders po on po.id = pl.po_id join public.purchase_requests p on p.id = po.request_id
   where po.company_id = p_company and p.cost_center_id = p_cc and po.status in ('draft', 'sent', 'partial')
     and po.order_date between b.period_start and b.period_end;
  select coalesce(sum((rl.qty - rl.qty_returned) * rl.unit_price), 0) into v_real
    from public.purchase_receipt_lines rl join public.purchase_receipts rc on rc.id = rl.receipt_id
    join public.purchase_order_lines pl on pl.id = rl.po_line_id join public.purchase_orders po on po.id = pl.po_id
    join public.purchase_requests p on p.id = po.request_id
   where rl.company_id = p_company and p.cost_center_id = p_cc and rc.received_at::date between b.period_start and b.period_end;
  return jsonb_build_object('budget_id', b.id, 'period_start', b.period_start, 'period_end', b.period_end, 'amount', b.amount,
    'engaged', v_eng_pr + v_eng_po, 'realised', v_real, 'available', b.amount - v_eng_pr - v_eng_po - v_real);
end $$;
revoke execute on function private.purchase_budget_state(uuid, uuid, date) from public, anon, authenticated;

-- Lecture : état d'un centre à une date (achat et finance)
create function public.purchase_budget_summary(p_cost_center uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_perm('purchases.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.cost_centers where id = p_cost_center and company_id = private.current_company()) then
    raise exception 'BUDGET_BAD_COST_CENTER' using errcode = '22023';
  end if;
  return private.purchase_budget_state(private.current_company(), p_cost_center, coalesce(p_date, current_date));
end $$;
grant execute on function public.purchase_budget_summary(uuid, date) to authenticated, service_role;

-- Définition ou révision du montant. Période fixe une fois créée. Un montant ne peut pas descendre sous l'engagé + le réalisé.
create function public.purchase_budget_set(p_budget uuid, p_cost_center uuid, p_start date, p_end date, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.purchase_budgets%rowtype; v_id uuid; v_state jsonb; v_committed numeric;
begin
  perform private.require_perm('finance.write');
  if p_amount is null or p_amount < 0 then raise exception 'BUDGET_BAD_AMOUNT' using errcode = '22023'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'BUDGET_BAD_PERIOD' using errcode = '22023'; end if;
  if not exists (select 1 from public.cost_centers where id = p_cost_center and company_id = v_co and archived_at is null) then
    raise exception 'BUDGET_BAD_COST_CENTER' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_cost_center::text, 0));
  if exists (select 1 from public.purchase_budgets where company_id = v_co and cost_center_id = p_cost_center
             and (p_budget is null or id <> p_budget) and daterange(period_start, period_end, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'BUDGET_OVERLAP' using errcode = '22023';
  end if;
  if p_budget is null then
    insert into public.purchase_budgets (company_id, cost_center_id, period_start, period_end, amount, updated_by)
    values (v_co, p_cost_center, p_start, p_end, p_amount, auth.uid()) returning id into v_id;
    perform private.write_audit(v_co, 'purchase.budget_create', 'purchase_budget', v_id::text, p_start || ' → ' || p_end, null,
      jsonb_build_object('amount', p_amount), '{}'::jsonb, 'rpc');
  else
    select * into b from public.purchase_budgets where id = p_budget and company_id = v_co for update;
    if not found then raise exception 'BUDGET_NOT_FOUND' using errcode = 'P0002'; end if;
    if b.cost_center_id <> p_cost_center or b.period_start <> p_start or b.period_end <> p_end then
      raise exception 'BUDGET_PERIOD_FIXED' using errcode = '22023';
    end if;
    update public.purchase_budgets set amount = p_amount, updated_by = auth.uid(), updated_at = now() where id = p_budget;
    v_id := p_budget;
    perform private.write_audit(v_co, 'purchase.budget_update', 'purchase_budget', v_id::text, b.period_start || ' → ' || b.period_end, null,
      jsonb_build_object('amount', b.amount), jsonb_build_object('amount', p_amount), 'rpc');
  end if;
  v_state := private.purchase_budget_state(v_co, p_cost_center, p_start);
  v_committed := (v_state ->> 'engaged')::numeric + (v_state ->> 'realised')::numeric;
  if p_amount < v_committed then raise exception 'BUDGET_BELOW_COMMITTED' using errcode = '22023', detail = v_committed::text; end if;
  return v_id;
end $$;
revoke execute on function public.purchase_budget_set(uuid, uuid, date, date, numeric) from public, anon;
grant execute on function public.purchase_budget_set(uuid, uuid, date, date, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Workflow : demande d'approbation ouverte pour une demande d'achat (politique 'purchase_request' de 0043)
-- ---------------------------------------------------------------------
create function private.purchase_open_approval(r public.purchase_requests, p_amount numeric, p_snapshot jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.approval_policies%rowtype; v_id uuid; v_ver int; v_hash text := private.approval_hash(p_snapshot);
begin
  select * into p from public.approval_policies where company_id = r.company_id and object_type = 'purchase_request';
  if not found then raise exception 'APPROVAL_NO_POLICY' using errcode = '55000', detail = 'purchase_request'; end if;
  select coalesce(max(object_version), 0) + 1 into v_ver from public.approval_requests
   where company_id = r.company_id and object_type = 'purchase_request' and object_id = r.id;
  insert into public.approval_requests (company_id, object_type, object_id, object_version, object_hash, snapshot, amount, state, levels,
    level2_threshold, level1_permission, level2_permission, escalation_permission, deadline_hours, requested_by, deadline_at)
  values (r.company_id, 'purchase_request', r.id, v_ver, v_hash, p_snapshot, p_amount, 'pending_l1', p.levels,
    p.level2_threshold, p.level1_permission, p.level2_permission, p.escalation_permission, p.deadline_hours, auth.uid(),
    now() + make_interval(hours => p.deadline_hours))
  returning id into v_id;
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, object_hash)
  values (v_id, r.company_id, 0, 'request', null, 'pending_l1', v_hash);
  perform private.write_audit(r.company_id, 'approval.request', 'approval', v_id::text, 'purchase_request ' || r.code || ' v' || v_ver, null,
    jsonb_build_object('state', 'pending_l1', 'amount', p_amount), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function private.purchase_open_approval(public.purchase_requests, numeric, jsonb) from public, anon, authenticated;

-- Retour d'approbation vers la demande d'achat : approuvée, refusée (motif visible), ou revenue en brouillon
create function private.purchase_request_approval_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('purchases.rpc', true), 'off');
begin
  if new.object_type <> 'purchase_request' or new.state = old.state then return new; end if;
  perform set_config('purchases.rpc', 'on', true);
  if new.state = 'approved' then
    update public.purchase_requests set status = 'approved', decided_by = new.decided_by, decided_at = new.decided_at, decision_comment = null
     where id = new.object_id and company_id = new.company_id;
  elsif new.state = 'refused' then
    update public.purchase_requests set status = 'rejected', decided_by = new.decided_by, decided_at = new.decided_at, decision_comment = new.refusal_reason
     where id = new.object_id and company_id = new.company_id;
  elsif new.state in ('cancelled', 'invalidated') then
    update public.purchase_requests set status = 'draft', submitted_at = null
     where id = new.object_id and company_id = new.company_id and status = 'submitted';
  end if;
  perform set_config('purchases.rpc', v_prev, true);
  return new;
end $$;
revoke execute on function private.purchase_request_approval_sync() from public, anon, authenticated;
create trigger approval_requests_purchase_sync_au after update of state on public.approval_requests
  for each row execute function private.purchase_request_approval_sync();

create function private.purchase_open_approval_exists(p_company uuid, p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.approval_requests where company_id = p_company and object_type = 'purchase_request'
                 and object_id = p_request and state in ('pending_l1', 'pending_l2'))
$$;
revoke execute on function private.purchase_open_approval_exists(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Soumission : estimation des lignes, contrôle budgétaire, workflow si une politique existe
-- ---------------------------------------------------------------------
create or replace function public.purchase_request_submit(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype; v_total numeric := 0; v_state jsonb; v_snap jsonb; v_bad int; v_lines int;
begin
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can_edit_request(r.requested_by) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if r.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_request_lines where request_id = p_request) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  -- estimation : saisie du demandeur, sinon dernier prix matière connu (aucune valeur inventée)
  update public.purchase_request_lines l set est_unit_cost = (select p.unit_cost from public.bom_material_prices p where p.material_id = l.material_id)
   where l.request_id = p_request and l.est_unit_cost is null;
  select count(*), coalesce(sum(qty * coalesce(est_unit_cost, 0)), 0) into v_lines, v_total from public.purchase_request_lines where request_id = p_request;
  if r.cost_center_id is not null then
    if length(btrim(coalesce(r.reason, ''))) < 5 then raise exception 'PURCHASE_REASON_REQUIRED' using errcode = '22023'; end if;
    select count(*) into v_bad from public.purchase_request_lines where request_id = p_request and coalesce(est_unit_cost, 0) <= 0;
    if v_bad > 0 then raise exception 'PURCHASE_ESTIMATE_REQUIRED' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended(r.cost_center_id::text, 0));
    v_state := private.purchase_budget_state(r.company_id, r.cost_center_id, coalesce(r.needed_date, current_date));
    if v_state is null then raise exception 'BUDGET_NOT_DEFINED' using errcode = '55000'; end if;
    if v_total > (v_state ->> 'available')::numeric then
      raise exception 'BUDGET_EXCEEDED' using errcode = '55000', detail = v_state::text;
    end if;
  end if;
  v_snap := jsonb_build_object('code', r.code, 'cost_center_id', r.cost_center_id, 'amount', v_total, 'lines', v_lines);
  update public.purchase_requests set status = 'submitted', submitted_at = now() where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  if exists (select 1 from public.approval_policies where company_id = r.company_id and object_type = 'purchase_request') then
    perform private.purchase_open_approval(r, v_total, v_snap);
  end if;
  perform private.write_audit(r.company_id, 'purchase.request_submit', 'purchase', r.id::text, r.code, null,
    jsonb_build_object('amount', v_total), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 6. Décision directe (sans politique) : refusée quand une demande d'approbation est ouverte
-- ---------------------------------------------------------------------
create or replace function public.purchase_request_decide(p_request uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  perform private.require_perm('purchases.approve');
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'submitted' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if private.purchase_open_approval_exists(r.company_id, r.id) then raise exception 'PURCHASE_USE_APPROVAL' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'PURCHASE_SELF_APPROVAL' using errcode = '42501'; end if;     -- séparation des tâches
  if not p_approve and length(btrim(coalesce(p_comment, ''))) < 3 then raise exception 'PURCHASE_COMMENT_REQUIRED' using errcode = '22023'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(),
         decision_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, case when p_approve then 'purchase.request_approve' else 'purchase.request_reject' end, 'purchase', r.id::text, r.code, null, null,
    jsonb_build_object('comment', nullif(btrim(coalesce(p_comment, '')), '')), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Annulation : ferme aussi la demande d'approbation ouverte (journalisée) ; libère l'engagé
-- ---------------------------------------------------------------------
create or replace function public.purchase_request_cancel(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can_edit_request(r.requested_by) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if r.status not in ('draft', 'submitted', 'approved') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_request_lines where request_id = p_request and po_line_id is not null) then raise exception 'PURCHASE_ALREADY_ORDERED' using errcode = '55000'; end if;
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, reason, object_hash)
  select id, company_id, 0, 'cancel', state, 'cancelled', 'annulation de la demande d’achat', object_hash
    from public.approval_requests where company_id = r.company_id and object_type = 'purchase_request' and object_id = r.id and state in ('pending_l1', 'pending_l2');
  -- annulation : pas une décision (decided_by reste vide, le demandeur ne peut pas être décideur) ; l'acteur est dans le journal
  update public.approval_requests set state = 'cancelled'
   where company_id = r.company_id and object_type = 'purchase_request' and object_id = r.id and state in ('pending_l1', 'pending_l2');
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = 'cancelled' where id = p_request;
  update public.mrp_run_suggestions set request_id = null where request_id = p_request;      -- les suggestions MRP redeviennent disponibles
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_cancel', 'purchase', r.id::text, r.code, null, null, '{}'::jsonb, 'rpc');
end $$;
