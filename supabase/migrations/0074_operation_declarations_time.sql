-- 0074_operation_declarations_time — Confection, personnalisation et temps réels : déclaration par opération de gamme,
-- temps productif / arrêt / retouche, bonnes pièces / rebuts / retouches, personnalisation bloquée sans BAT applicable,
-- corrections tardives motivées et approuvées, tâches visibles seulement aux postes affectés.
--
-- Existant conservé et réutilisé :
--   * Journal de production (0019 : production_logs, immuable, déclaration par jour) : conservé tel quel. Il reste la
--     source des indicateurs existants (production_order_metrics, production_dashboard). Les déclarations par opération
--     sont un détail ajouté ; elles n'alimentent pas automatiquement production_logs (décision, voir le registre).
--   * Gamme figée (0070 : production_order_routing, opérations avec poste et temps standard), OF (0019, 0073 : variante, gel).
--   * Personnalisation (0054) : personalization_specs (statut current), bat_proofs (statut approved), personalization_operations
--     (démarrage exigeant un BAT approuvé), droits personalization.* et règles des droits du logo (logo_rights_valid).
--   * Droits production.read / write / plan (0019), personalization.operate (0054).
--
-- Règles :
--  * Déclaration : un opérateur déclare une opération de la gamme figée d'un OF lancé ou en cours. Il doit être affecté au
--    poste de cette opération (production_operator_assignments) ; sinon OPERATION_NOT_AUTHORIZED.
--  * Personnalisation : la déclaration d'une opération « personnalisation » exige un spec courant de l'OF (ligne de commande
--    de l'OF) avec une opération de personnalisation démarrée sur un BAT approuvé, et des droits sur le logo valides.
--    Sans cela : PERSO_NO_VALID_BAT (aucune pièce n'est déclarable).
--  * Pièces : bonnes pièces (good), rebuts (scrap) et retouches (rework) sont séparés. Seules les bonnes pièces comptent
--    comme bonnes. Un rebut ni une retouche ne sont jamais comptés bons. Par opération : bon + rebut + retouche ≤ quantité de l'OF.
--  * Temps : productif, arrêt (motif obligatoire) et retouche, en minutes. Une déclaration porte au moins un temps ou une pièce.
--  * Corrections : écrites comme demandes (production_entry_adjustments, ajout seul) avec un motif (≥ 10 caractères). Une correction
--    dont la date est antérieure de plus de 2 jours est « tardive ». Une correction n'agit qu'après approbation par un autre
--    utilisateur (SOD_SELF_APPROVAL), droit production.approve_log. Le total de l'opération reste ≥ 0 et ≤ quantité de l'OF.
--  * Tâches : un opérateur ne voit que les opérations (gamme figée des OF lancés ou en cours) des postes qui lui sont affectés.
-- Erreurs : OPERATION_NOT_AUTHORIZED, OPERATION_NOT_FOUND, PERSO_SPEC_REQUIRED, PERSO_NO_VALID_BAT, LOGO_RIGHTS_INVALID,
-- OPERATION_QTY_EXCEEDED, OPERATION_TIME_REQUIRED, OPERATION_STOP_REASON_REQUIRED, OPERATION_DATE_INVALID,
-- CORRECTION_REASON_REQUIRED, CORRECTION_NEGATIVE, CORRECTION_BAD_STATUS, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('production.operate',     'production', 'Déclarer les opérations (opérateur)', 'Déclarer temps, bonnes pièces et rebuts sur les postes affectés ; demander une correction'),
  ('production.approve_log', 'production', 'Approuver les corrections de déclarations', 'Approuver ou refuser une correction tardive (distinct du demandeur)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('production.operate', 'production.approve_log'))
  or (r.code = 'direction'  and p.code = 'production.approve_log')
  or (r.code = 'production' and p.code = 'production.operate'))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Affectations des opérateurs aux postes
-- ---------------------------------------------------------------------------
create table public.production_operator_assignments (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  work_center_id uuid not null references public.work_centers(id),
  active         boolean not null default true,
  assigned_by    uuid default auth.uid(),
  assigned_at    timestamptz not null default now(),
  unique (user_id, work_center_id)
);

-- ---------------------------------------------------------------------------
-- 3. Déclarations par opération (ajout seul) et corrections (ajout seul, approbation distincte)
-- ---------------------------------------------------------------------------
create table public.production_operation_entries (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  order_id                 uuid not null references public.production_orders(id),
  op_pos                   int not null check (op_pos >= 1),
  work_center_id           uuid not null references public.work_centers(id),
  op_kind                  text not null check (op_kind in ('coupe', 'confection', 'personnalisation', 'controle', 'pack')),
  entry_date               date not null,
  productive_min           numeric(10,2) not null default 0 check (productive_min >= 0 and productive_min <= 1440),
  stop_min                 numeric(10,2) not null default 0 check (stop_min >= 0 and stop_min <= 1440),
  rework_min               numeric(10,2) not null default 0 check (rework_min >= 0 and rework_min <= 1440),
  good_qty                 numeric(12,2) not null default 0 check (good_qty >= 0),
  scrap_qty                numeric(12,2) not null default 0 check (scrap_qty >= 0),
  rework_qty               numeric(12,2) not null default 0 check (rework_qty >= 0),
  stop_reason              text check (stop_reason is null or length(btrim(stop_reason)) between 3 and 200),
  spec_id                  uuid references public.personalization_specs(id),
  personalization_op_id    uuid references public.personalization_operations(id),
  note                     text check (note is null or length(note) <= 300),
  operator_id              uuid not null default auth.uid(),
  created_at               timestamptz not null default now(),
  check (productive_min + stop_min + rework_min > 0 or good_qty + scrap_qty + rework_qty > 0),
  check (stop_min = 0 or stop_reason is not null),
  check (op_kind <> 'personnalisation' or personalization_op_id is not null)
);
create index production_operation_entries_idx on public.production_operation_entries (order_id, op_pos);

create table public.production_entry_adjustments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  entry_id        uuid not null references public.production_operation_entries(id),
  d_productive_min numeric(10,2) not null default 0,
  d_stop_min      numeric(10,2) not null default 0,
  d_rework_min    numeric(10,2) not null default 0,
  d_good_qty      numeric(12,2) not null default 0,
  d_scrap_qty     numeric(12,2) not null default 0,
  d_rework_qty    numeric(12,2) not null default 0,
  reason          text not null check (length(btrim(reason)) >= 10 and length(reason) <= 500),
  late            boolean not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by    uuid not null default auth.uid(),
  requested_at    timestamptz not null default now(),
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(decision_note) <= 300),
  check (d_productive_min <> 0 or d_stop_min <> 0 or d_rework_min <> 0 or d_good_qty <> 0 or d_scrap_qty <> 0 or d_rework_qty <> 0),
  check (decided_by is null or decided_by <> requested_by)
);
create index production_entry_adjustments_entry_idx on public.production_entry_adjustments (entry_id, status);

create function private.operation_log_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'OPERATION_APPEND_ONLY' using errcode = '42501'; end if;
  if tg_table_name = 'production_operation_entries' then
    raise exception 'OPERATION_APPEND_ONLY' using errcode = '42501';
  end if;
  -- ajustements : seule la décision (pending → approved / rejected) peut modifier une ligne
  if old.status <> 'pending' or new.status = 'pending'
     or (new.company_id, new.entry_id, new.d_productive_min, new.d_stop_min, new.d_rework_min, new.d_good_qty, new.d_scrap_qty,
         new.d_rework_qty, new.reason, new.late, new.requested_by, new.requested_at)
        is distinct from
        (old.company_id, old.entry_id, old.d_productive_min, old.d_stop_min, old.d_rework_min, old.d_good_qty, old.d_scrap_qty,
         old.d_rework_qty, old.reason, old.late, old.requested_by, old.requested_at) then
    raise exception 'OPERATION_APPEND_ONLY' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger production_operation_entries_guard before update or delete on public.production_operation_entries
  for each row execute function private.operation_log_guard();
create trigger production_entry_adjustments_guard before update or delete on public.production_entry_adjustments
  for each row execute function private.operation_log_guard();

-- ---------------------------------------------------------------------------
-- 4. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.production_operator_assignments enable row level security;
alter table public.production_operation_entries enable row level security;
alter table public.production_entry_adjustments enable row level security;

create policy production_operator_assignments_select on public.production_operator_assignments for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('production.read') or user_id = auth.uid()));
create policy production_operation_entries_select on public.production_operation_entries for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy production_entry_adjustments_select on public.production_entry_adjustments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));

revoke all on public.production_operator_assignments, public.production_operation_entries, public.production_entry_adjustments from anon, authenticated;
grant select on public.production_operator_assignments, public.production_operation_entries, public.production_entry_adjustments to authenticated;
grant all on public.production_operator_assignments, public.production_operation_entries, public.production_entry_adjustments to service_role;

-- ---------------------------------------------------------------------------
-- 5. Fonctions
-- ---------------------------------------------------------------------------
-- Affectation d'un opérateur à un poste (planificateur)
create function public.production_operator_assign(p_user uuid, p_work_center uuid, p_active boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('production.plan');
  if not exists (select 1 from public.profiles where id = p_user and company_id = v_co) then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.work_centers where id = p_work_center and company_id = v_co) then raise exception 'PRODUCTION_WORK_CENTER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.production_operator_assignments (company_id, user_id, work_center_id, active)
    values (v_co, p_user, p_work_center, coalesce(p_active, true))
  on conflict (user_id, work_center_id) do update set active = excluded.active, assigned_by = auth.uid(), assigned_at = now();
  perform private.write_audit(v_co, case when coalesce(p_active, true) then 'production.operator_assign' else 'production.operator_unassign' end,
    'profile', p_user::text, null, null, jsonb_build_object('work_center_id', p_work_center, 'active', coalesce(p_active, true)), '{}'::jsonb, 'rpc');
end $$;

-- Mes tâches : opérations de la gamme figée des OF lancés ou en cours, aux seuls postes qui me sont affectés
create function public.production_my_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_rows jsonb;
begin
  perform private.require_perm('production.operate');
  select coalesce(jsonb_agg(jsonb_build_object(
      'order_id', o.id, 'order', o.number, 'order_status', o.status, 'qty_planned', o.qty_planned,
      'op_pos', x.pos, 'op_kind', x.kind, 'op_name', x.name, 'work_center_id', x.work_center_id, 'work_center', x.work_center,
      'standard_minutes', x.minutes_with_allowance, 'instructions', x.instructions,
      'needs_personalization', x.kind = 'personnalisation')
    order by o.number, x.pos), '[]'::jsonb)
  into v_rows
  from public.production_orders o
  join public.production_order_routing r on r.order_id = o.id and r.status = 'frozen'
  cross join lateral jsonb_to_recordset(r.operations) as x(pos int, kind text, name text, work_center_id uuid, work_center text,
      minutes_with_allowance numeric, instructions text)
  where o.company_id = v_co and o.status in ('launched', 'in_progress')
    and x.work_center_id in (select a.work_center_id from public.production_operator_assignments a
                             where a.user_id = auth.uid() and a.company_id = v_co and a.active);
  return v_rows;
end $$;

-- Déclaration d'une opération : temps (minutes), pièces bonnes / rebutées / retouchées
create function public.production_operation_declare(p_order uuid, p_pos int, p_date date, p_productive_min numeric, p_stop_min numeric,
  p_rework_min numeric, p_good numeric, p_scrap numeric, p_rework_qty numeric, p_spec uuid default null,
  p_stop_reason text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; op jsonb; v_kind text; v_wc uuid;
  v_done numeric; v_pb uuid; v_spec public.personalization_specs%rowtype; v_id uuid := gen_random_uuid(); v_bat uuid;
begin
  perform private.require_perm('production.operate');
  select * into o from public.production_orders where id = p_order and company_id = v_co for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select x.value into op from public.production_order_routing r, jsonb_array_elements(r.operations) x
    where r.order_id = p_order and r.status = 'frozen' and (x.value ->> 'pos')::int = p_pos;
  if op is null then raise exception 'OPERATION_NOT_FOUND' using errcode = 'P0002'; end if;
  v_kind := op ->> 'kind'; v_wc := (op ->> 'work_center_id')::uuid;
  if not exists (select 1 from public.production_operator_assignments a
                 where a.user_id = auth.uid() and a.work_center_id = v_wc and a.active and a.company_id = v_co) then
    raise exception 'OPERATION_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_date is null or p_date > current_date or p_date < o.planned_start - 30 then raise exception 'OPERATION_DATE_INVALID' using errcode = '22023'; end if;
  if coalesce(p_productive_min, 0) + coalesce(p_stop_min, 0) + coalesce(p_rework_min, 0) + coalesce(p_good, 0) + coalesce(p_scrap, 0) + coalesce(p_rework_qty, 0) <= 0 then
    raise exception 'OPERATION_TIME_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(p_stop_min, 0) > 0 and length(btrim(coalesce(p_stop_reason, ''))) < 3 then raise exception 'OPERATION_STOP_REASON_REQUIRED' using errcode = '22023'; end if;
  -- personnalisation : BAT approuvé et spec courant de la ligne de commande de l'OF
  if v_kind = 'personnalisation' then
    if p_spec is null then raise exception 'PERSO_SPEC_REQUIRED' using errcode = '22023'; end if;
    select s.* into v_spec from public.personalization_specs s
      join public.sales_order_lines l on l.id = s.order_line_id
      where s.id = p_spec and s.company_id = v_co and s.status = 'current' and l.order_id = o.sales_order_id;
    if not found then raise exception 'PERSO_NO_VALID_BAT' using errcode = '55000'; end if;
    select po.id, po.bat_id into v_pb, v_bat from public.personalization_operations po
      join public.bat_proofs b on b.id = po.bat_id
      where po.spec_id = v_spec.id and b.status = 'approved';
    if v_pb is null then raise exception 'PERSO_NO_VALID_BAT' using errcode = '55000'; end if;
    if not private.logo_rights_valid(v_spec.logo_id, current_date) then raise exception 'LOGO_RIGHTS_INVALID' using errcode = '55000'; end if;
  end if;
  -- quantités : bon + rebut + retouche par opération ≤ quantité de l'OF
  select coalesce(sum(good_qty + scrap_qty + rework_qty), 0) into v_done from public.production_operation_entries
    where order_id = p_order and op_pos = p_pos;
  if v_done + coalesce(p_good, 0) + coalesce(p_scrap, 0) + coalesce(p_rework_qty, 0) > o.qty_planned then
    raise exception 'OPERATION_QTY_EXCEEDED' using errcode = '22023';
  end if;
  insert into public.production_operation_entries (id, company_id, order_id, op_pos, work_center_id, op_kind, entry_date,
    productive_min, stop_min, rework_min, good_qty, scrap_qty, rework_qty, stop_reason, spec_id, personalization_op_id, note, operator_id)
  values (v_id, v_co, p_order, p_pos, v_wc, v_kind, p_date, coalesce(p_productive_min, 0), coalesce(p_stop_min, 0), coalesce(p_rework_min, 0),
    coalesce(p_good, 0), coalesce(p_scrap, 0), coalesce(p_rework_qty, 0), nullif(btrim(coalesce(p_stop_reason, '')), ''),
    case when v_kind = 'personnalisation' then v_spec.id end, case when v_kind = 'personnalisation' then v_pb end,
    nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  if o.status = 'launched' then update public.production_orders set status = 'in_progress' where id = p_order; end if;
  perform private.write_audit(v_co, 'production.operation_declare', 'production_order', o.id::text, o.number, null,
    jsonb_build_object('entry_id', v_id, 'op_pos', p_pos, 'op_kind', v_kind, 'good', p_good, 'scrap', p_scrap, 'rework', p_rework_qty,
      'productive_min', p_productive_min, 'stop_min', p_stop_min, 'rework_min', p_rework_min, 'bat', v_bat),
    '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Demande de correction d'une déclaration (motif obligatoire ; tardive si la date a plus de 2 jours)
create function public.production_entry_request_correction(p_entry uuid, p_d_productive_min numeric, p_d_stop_min numeric, p_d_rework_min numeric,
  p_d_good numeric, p_d_scrap numeric, p_d_rework_qty numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e public.production_operation_entries%rowtype; v_id uuid := gen_random_uuid();
  v_late boolean; v_pending int;
begin
  perform private.require_perm('production.operate');
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'CORRECTION_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into e from public.production_operation_entries where id = p_entry and company_id = v_co;
  if not found then raise exception 'OPERATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.production_operator_assignments a where a.user_id = auth.uid() and a.work_center_id = e.work_center_id and a.active)
     and not private.has_perm('production.approve_log') then
    raise exception 'OPERATION_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  v_late := e.entry_date < current_date - 2;
  insert into public.production_entry_adjustments (id, company_id, entry_id, d_productive_min, d_stop_min, d_rework_min, d_good_qty, d_scrap_qty,
    d_rework_qty, reason, late)
  values (v_id, v_co, p_entry, coalesce(p_d_productive_min, 0), coalesce(p_d_stop_min, 0), coalesce(p_d_rework_min, 0), coalesce(p_d_good, 0),
    coalesce(p_d_scrap, 0), coalesce(p_d_rework_qty, 0), btrim(p_reason), v_late);
  perform private.write_audit(v_co, 'production.correction_request', 'production_order', e.order_id::text, null, null,
    jsonb_build_object('adjustment_id', v_id, 'entry_id', p_entry, 'late', v_late, 'reason', btrim(p_reason)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Décision sur une correction : approbation distincte, totaux de l'opération toujours cohérents
create function public.production_entry_decide_correction(p_adjustment uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.production_entry_adjustments%rowtype; e public.production_operation_entries%rowtype;
  o public.production_orders%rowtype; v_prod numeric; v_stop numeric; v_rw numeric; v_good numeric; v_scrap numeric; v_rwq numeric;
  v_done numeric; v_op_approved numeric;
begin
  perform private.require_perm('production.approve_log');
  select * into a from public.production_entry_adjustments where id = p_adjustment and company_id = v_co for update;
  if not found then raise exception 'CORRECTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status <> 'pending' then raise exception 'CORRECTION_BAD_STATUS' using errcode = '55000'; end if;
  if a.requested_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  select * into e from public.production_operation_entries where id = a.entry_id;
  select * into o from public.production_orders where id = e.order_id;
  if p_approve then
    -- totaux après approbation : jamais négatifs, bon + rebut + retouche par opération ≤ quantité de l'OF
    select coalesce(sum(d_productive_min), 0), coalesce(sum(d_stop_min), 0), coalesce(sum(d_rework_min), 0), coalesce(sum(d_good_qty), 0),
           coalesce(sum(d_scrap_qty), 0), coalesce(sum(d_rework_qty), 0)
      into v_prod, v_stop, v_rw, v_good, v_scrap, v_rwq
      from public.production_entry_adjustments where entry_id = e.id and status = 'approved';
    v_prod := v_prod + a.d_productive_min; v_stop := v_stop + a.d_stop_min; v_rw := v_rw + a.d_rework_min;
    v_good := v_good + a.d_good_qty; v_scrap := v_scrap + a.d_scrap_qty; v_rwq := v_rwq + a.d_rework_qty;
    if e.productive_min + v_prod < 0 or e.stop_min + v_stop < 0 or e.rework_min + v_rw < 0
       or e.good_qty + v_good < 0 or e.scrap_qty + v_scrap < 0 or e.rework_qty + v_rwq < 0 then
      raise exception 'CORRECTION_NEGATIVE' using errcode = '22023';
    end if;
    -- pièces de l'opération : déclarations + corrections déjà approuvées + cette correction ≤ quantité de l'OF
    select coalesce(sum(x.good_qty + x.scrap_qty + x.rework_qty), 0) into v_done from public.production_operation_entries x
      where x.order_id = e.order_id and x.op_pos = e.op_pos;
    select coalesce(sum(x.d_good_qty + x.d_scrap_qty + x.d_rework_qty), 0) into v_op_approved from public.production_entry_adjustments x
      join public.production_operation_entries pe on pe.id = x.entry_id
      where pe.order_id = e.order_id and pe.op_pos = e.op_pos and x.status = 'approved';
    if v_done + v_op_approved + (a.d_good_qty + a.d_scrap_qty + a.d_rework_qty) > o.qty_planned then
      raise exception 'OPERATION_QTY_EXCEEDED' using errcode = '22023';
    end if;
  end if;
  update public.production_entry_adjustments set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_adjustment;
  perform private.write_audit(v_co, case when p_approve then 'production.correction_approve' else 'production.correction_reject' end,
    'production_order', e.order_id::text, o.number, jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'late', a.late),
    jsonb_build_object('adjustment_id', p_adjustment, 'entry_id', e.id, 'reason', a.reason, 'note', p_note), 'rpc');
end $$;

-- Totaux d'un OF par opération (approbations incluses) ; bonnes pièces = bon du dernier poste
create function public.production_order_totals(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; v_ops jsonb; v_final numeric; v_pending int;
begin
  perform private.require_perm('production.read');
  select * into o from public.production_orders where id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  with e as (
    select pe.op_pos, pe.id,
      pe.productive_min + coalesce(sum(a.d_productive_min) filter (where a.status = 'approved'), 0) as productive,
      pe.stop_min + coalesce(sum(a.d_stop_min) filter (where a.status = 'approved'), 0) as stop_m,
      pe.rework_min + coalesce(sum(a.d_rework_min) filter (where a.status = 'approved'), 0) as rework_m,
      pe.good_qty + coalesce(sum(a.d_good_qty) filter (where a.status = 'approved'), 0) as good,
      pe.scrap_qty + coalesce(sum(a.d_scrap_qty) filter (where a.status = 'approved'), 0) as scrap,
      pe.rework_qty + coalesce(sum(a.d_rework_qty) filter (where a.status = 'approved'), 0) as rework
    from public.production_operation_entries pe left join public.production_entry_adjustments a on a.entry_id = pe.id
    where pe.order_id = p_order group by pe.op_pos, pe.id, pe.productive_min, pe.stop_min, pe.rework_min, pe.good_qty, pe.scrap_qty, pe.rework_qty
  ),
  per_op as (
    select op_pos, sum(productive) productive_min, sum(stop_m) stop_min, sum(rework_m) rework_min,
           sum(good) good, sum(scrap) scrap, sum(rework) rework
    from e group by op_pos
  )
  select coalesce(jsonb_agg(jsonb_build_object('op_pos', op_pos, 'productive_min', productive_min, 'stop_min', stop_min,
           'rework_min', rework_min, 'good', good, 'scrap', scrap, 'rework', rework) order by op_pos), '[]'::jsonb),
         coalesce((select good from per_op order by op_pos desc limit 1), 0)
  into v_ops, v_final from per_op;
  select count(*) into v_pending from public.production_entry_adjustments a join public.production_operation_entries pe on pe.id = a.entry_id
    where pe.order_id = p_order and a.status = 'pending';
  return jsonb_build_object('order', o.number, 'qty_planned', o.qty_planned, 'operations', v_ops,
    'good_pieces', v_final, 'pending_corrections', v_pending);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Privilèges d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.production_operator_assign(uuid, uuid, boolean), public.production_my_tasks(),
  public.production_operation_declare(uuid, int, date, numeric, numeric, numeric, numeric, numeric, numeric, uuid, text, text),
  public.production_entry_request_correction(uuid, numeric, numeric, numeric, numeric, numeric, numeric, text),
  public.production_entry_decide_correction(uuid, boolean, text), public.production_order_totals(uuid) from public, anon;
grant execute on function public.production_operator_assign(uuid, uuid, boolean), public.production_my_tasks(),
  public.production_operation_declare(uuid, int, date, numeric, numeric, numeric, numeric, numeric, numeric, uuid, text, text),
  public.production_entry_request_correction(uuid, numeric, numeric, numeric, numeric, numeric, numeric, text),
  public.production_entry_decide_correction(uuid, boolean, text), public.production_order_totals(uuid) to authenticated, service_role;
