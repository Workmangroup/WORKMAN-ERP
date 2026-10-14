-- 0076_control_plans_results — Plans de contrôle et résultats : plans versionnés (réception, en cours, final), méthode, échantillon,
-- tolérance, instrument ; résultats mesurés avec unité, valeur brute, instrument et preuve d'étalonnage ; décision distincte de la
-- saisie des résultats ; contrôle lié au lot matière, au lot produit, à l'OF ou à la réception ; contrôle rejouable sur le plan
-- en vigueur à la date du contrôle initial.
--
-- Existant conservé et réutilisé (0020, 0055, 0016, 0019, 0009, 0021) :
--   * quality_inspections (0020) : contrôles réception / production / final, échantillon, décision, quantités. Inchangé pour les
--     contrôles existants (sans plan) : quality_inspection_open et quality_defect_add restent tels quels.
--   * quality_defects (0020, immuable) : défauts constatés ; quality_inspection_decide (0020) redéfinie avec les seules
--     vérifications supplémentaires des contrôles planifiés (résultats complets, tolérances, décideur distinct du saisissant).
--   * quality_nonconformities (0020) : ouverture automatique sur rejet, inchangée.
--   * Lots matière (stock_lots, 0009), lots produits (finished_lots, 0055), OF (production_orders, 0019), réceptions achats
--     (purchase_receipts) : liés par des colonnes ajoutées à quality_inspections.
--   * Droits quality.read / write / approve (0020).
--
-- Règles :
--  * Plan : versionné par code. Une version est brouillon, active ou retirée. Une version active n'est plus modifiable.
--    Une seule version active couvre une date donnée pour un même périmètre (matière ou article) et une même étape.
--    Activer une version retire la précédente du même code (fin de validité la veille) ; un chevauchement avec un autre
--    plan actif du même périmètre est refusé (QPLAN_OVERLAP). Activation par un autre utilisateur que le rédacteur (QPLAN_SOD).
--  * Caractéristique : mesure (unité, bornes de tolérance min ≤ max, instrument obligatoire) ou attribut (ok / ko).
--    Méthode et taille d'échantillon (1 à 500) obligatoires.
--  * Contrôle planifié : ouvert sur le plan actif à la date d'ouverture ; les caractéristiques sont copiées dans le contrôle
--    (snapshot) avec leur version de plan. Modifier ou retirer le plan ensuite ne change pas le contrôle.
--  * Résultat : une mesure par caractéristique et par numéro d'échantillon ; unité saisie = unité de la caractéristique
--    (aucune conversion inventée) ; valeur brute conservée ; hors tolérance calculé ; instrument et date d'étalonnage au moment
--    de la mesure conservés. Un instrument dont l'étalonnage est échu ne peut pas servir (QUALITY_INSTRUMENT_NOT_CALIBRATED).
--    Les résultats sont en ajout seul.
--  * Décision : quality.approve. Une décision « acceptée » exige tous les résultats (échantillon complet) et aucune valeur hors
--    tolérance ni attribut « ko ». Le décideur ne peut pas être l'un des saisissants du contrôle (QUALITY_DECIDER_IS_RECORDER).
--  * Rejeu : un contrôle rejoué reprend le plan et les caractéristiques de la version d'origine (même si une version plus
--    récente est active), reçoit son propre numéro et renvoie à l'original (replay_of_id) ; un motif est obligatoire.
--  * Traçabilité : un contrôle se retrouve par lot matière, lot produit, OF ou réception.
-- Erreurs : QPLAN_NOT_FOUND, QPLAN_BAD_STATUS, QPLAN_SCOPE_MISMATCH, QPLAN_OVERLAP, QPLAN_SOD, QPLAN_NO_CHARACTERISTIC,
-- QPLAN_CHARACTERISTIC_INVALID, QPLAN_MISSING, QUALITY_PLAN_MISSING, QUALITY_UNIT_MISMATCH, QUALITY_SAMPLE_OUT_OF_RANGE,
-- QUALITY_MEASUREMENT_EXISTS, QUALITY_VALUE_REQUIRED, QUALITY_RESULT_INVALID, QUALITY_INSTRUMENT_MISMATCH,
-- QUALITY_INSTRUMENT_NOT_CALIBRATED, QUALITY_RESULTS_INCOMPLETE, QUALITY_OUT_OF_TOLERANCE, QUALITY_DECIDER_IS_RECORDER,
-- QUALITY_REPLAY_REASON_REQUIRED, QUALITY_SOURCE_NOT_FOUND, QUALITY_APPEND_ONLY, QUALITY_BAD_STATUS.

-- ---------------------------------------------------------------------------
-- 1. Instruments de mesure (étalonnage tenu par la société, aucune date inventée)
-- ---------------------------------------------------------------------------
create table public.quality_instruments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name            text not null check (length(btrim(name)) between 2 and 120),
  calibration_due date not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, code)
);

-- ---------------------------------------------------------------------------
-- 2. Plans de contrôle versionnés et caractéristiques
-- ---------------------------------------------------------------------------
create table public.quality_control_plans (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),
  version_no      int not null check (version_no >= 1),
  title           text not null check (length(btrim(title)) between 2 and 160),
  stage           text not null check (stage in ('reception', 'in_process', 'final')),
  material_id     uuid references public.bom_materials(id),
  article_id      uuid references public.articles(id),
  status          text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  valid_from      date,
  valid_to        date,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  activated_by    uuid,
  activated_at    timestamptz,
  retired_at      timestamptz,
  unique (company_id, code, version_no),
  check ((material_id is null) <> (article_id is null)),
  check (stage <> 'reception' or material_id is not null),
  check (stage = 'reception' or article_id is not null),
  check (status = 'draft' or valid_from is not null),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (status <> 'draft' or (activated_by is null and valid_from is null))
);
create index quality_control_plans_scope_idx on public.quality_control_plans (company_id, stage, material_id, article_id, status);

create table public.quality_plan_characteristics (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  plan_id     uuid not null references public.quality_control_plans(id) on delete cascade,
  pos         int not null check (pos >= 1),
  name        text not null check (length(btrim(name)) between 2 and 120),
  method      text not null check (length(btrim(method)) between 3 and 300),
  kind        text not null check (kind in ('measure', 'attribute')),
  sample_size int not null check (sample_size between 1 and 500),
  unit        text check (unit is null or length(btrim(unit)) between 1 and 12),
  tol_min     numeric(14,4),
  tol_max     numeric(14,4),
  instrument_id uuid references public.quality_instruments(id),
  unique (plan_id, pos),
  check ((kind = 'measure' and unit is not null and tol_min is not null and tol_max is not null and tol_min <= tol_max and instrument_id is not null)
      or (kind = 'attribute' and unit is null and tol_min is null and tol_max is null and instrument_id is null))
);

-- Plan actif ou retiré : caractéristiques figées
create function private.quality_control_plan_draft_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_plan uuid; v_status text;
begin
  v_plan := case when tg_op = 'DELETE' then old.plan_id else new.plan_id end;
  select status into v_status from public.quality_control_plans where id = v_plan;
  if v_status is distinct from 'draft' then raise exception 'QPLAN_BAD_STATUS' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function private.quality_control_plan_draft_guard() from public, anon, authenticated;
create trigger quality_plan_characteristics_draft_guard before insert or update or delete on public.quality_plan_characteristics
  for each row execute function private.quality_control_plan_draft_guard();

-- ---------------------------------------------------------------------------
-- 3. Contrôles : liens, snapshot des caractéristiques, résultats (ajout seul)
-- ---------------------------------------------------------------------------
alter table public.quality_inspections
  add column if not exists plan_id          uuid references public.quality_control_plans(id),
  add column if not exists plan_version_no  int,
  add column if not exists replay_of_id     uuid references public.quality_inspections(id),
  add column if not exists finished_lot_id  uuid references public.finished_lots(id),
  add column if not exists material_lot_id  uuid references public.stock_lots(id);
create index if not exists quality_inspections_plan_idx on public.quality_inspections (plan_id) where plan_id is not null;
create index if not exists quality_inspections_material_lot_idx on public.quality_inspections (material_lot_id) where material_lot_id is not null;
create index if not exists quality_inspections_finished_lot_idx on public.quality_inspections (finished_lot_id) where finished_lot_id is not null;

create table public.quality_inspection_characteristics (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  inspection_id uuid not null references public.quality_inspections(id) on delete cascade,
  source_id     uuid not null references public.quality_plan_characteristics(id),
  plan_id       uuid not null references public.quality_control_plans(id),
  plan_version_no int not null,
  pos           int not null,
  name          text not null,
  method        text not null,
  kind          text not null check (kind in ('measure', 'attribute')),
  sample_size   int not null check (sample_size between 1 and 500),
  unit          text,
  tol_min       numeric(14,4),
  tol_max       numeric(14,4),
  instrument_id uuid references public.quality_instruments(id),
  instrument_code text,
  unique (inspection_id, pos)
);

create table public.quality_measurements (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  inspection_id      uuid not null references public.quality_inspections(id) on delete cascade,
  characteristic_id  uuid not null references public.quality_inspection_characteristics(id),
  sample_no          int not null check (sample_no >= 1),
  unit               text,
  value_raw          numeric(14,4),
  result_text        text check (result_text is null or result_text in ('ok', 'ko')),
  in_tolerance       boolean not null,
  instrument_id      uuid references public.quality_instruments(id),
  instrument_code    text,
  calibration_due    date,
  recorded_at        timestamptz not null default now(),
  recorded_by        uuid default auth.uid(),
  unique (characteristic_id, sample_no)
);
create index quality_measurements_inspection_idx on public.quality_measurements (inspection_id, characteristic_id);

create function private.quality_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'QUALITY_APPEND_ONLY' using errcode = '42501';
end $$;
revoke execute on function private.quality_append_only() from public, anon, authenticated;
create trigger quality_inspection_characteristics_append_only before update or delete on public.quality_inspection_characteristics
  for each row execute function private.quality_append_only();
create trigger quality_measurements_append_only before update or delete on public.quality_measurements
  for each row execute function private.quality_append_only();

-- ---------------------------------------------------------------------------
-- 4. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.quality_instruments enable row level security;
alter table public.quality_control_plans enable row level security;
alter table public.quality_plan_characteristics enable row level security;
alter table public.quality_inspection_characteristics enable row level security;
alter table public.quality_measurements enable row level security;

create policy quality_instruments_select on public.quality_instruments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy quality_control_plans_select on public.quality_control_plans for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy quality_plan_characteristics_select on public.quality_plan_characteristics for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy quality_inspection_characteristics_select on public.quality_inspection_characteristics for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
create policy quality_measurements_select on public.quality_measurements for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));

revoke all on public.quality_instruments, public.quality_control_plans, public.quality_plan_characteristics,
              public.quality_inspection_characteristics, public.quality_measurements from anon, authenticated;
grant select on public.quality_instruments, public.quality_control_plans, public.quality_plan_characteristics,
                public.quality_inspection_characteristics, public.quality_measurements to authenticated;
grant all on public.quality_instruments, public.quality_control_plans, public.quality_plan_characteristics,
             public.quality_inspection_characteristics, public.quality_measurements to service_role;

-- ---------------------------------------------------------------------------
-- 5. Droit de gestion des plans et des instruments
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('quality.plan', 'quality', 'Gérer les plans de contrôle', 'Rédiger, activer et retirer les plans de contrôle versionnés ; gérer les instruments de mesure')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'quality.plan'
  and r.code in ('admin', 'qualite') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 6. Instruments
-- ---------------------------------------------------------------------------
create function public.quality_instrument_save(p_code text, p_name text, p_calibration_due date, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform private.require_perm('quality.plan');
  if p_calibration_due is null then raise exception 'QUALITY_INSTRUMENT_INVALID' using errcode = '22023'; end if;
  insert into public.quality_instruments (company_id, code, name, calibration_due, active)
  values (v_co, v_code, btrim(coalesce(p_name, '')), p_calibration_due, coalesce(p_active, true))
  on conflict (company_id, code) do update set name = excluded.name, calibration_due = excluded.calibration_due,
    active = excluded.active, updated_at = now()
  returning id into v_id;
  perform private.write_audit(v_co, 'quality.instrument_save', 'quality_instrument', v_id::text, v_code, null,
    jsonb_build_object('calibration_due', p_calibration_due, 'active', coalesce(p_active, true)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Plans : rédaction, caractéristiques, activation, plan en vigueur à une date
-- ---------------------------------------------------------------------------
create function public.quality_control_plan_create(p_code text, p_title text, p_stage text, p_material uuid, p_article uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_no int; v_code text := upper(btrim(coalesce(p_code, '')));
  v_prev record;
begin
  perform private.require_perm('quality.plan');
  if p_stage not in ('reception', 'in_process', 'final') then raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023'; end if;
  if p_stage = 'reception' and (p_material is null or p_article is not null) then raise exception 'QPLAN_SCOPE_MISMATCH' using errcode = '22023'; end if;
  if p_stage <> 'reception' and (p_article is null or p_material is not null) then raise exception 'QPLAN_SCOPE_MISMATCH' using errcode = '22023'; end if;
  if p_material is not null and not exists (select 1 from public.bom_materials where id = p_material and company_id = v_co) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_article is not null and not exists (select 1 from public.articles where id = p_article and company_id = v_co) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- une nouvelle version garde le même périmètre et la même étape que les versions précédentes du code
  select * into v_prev from public.quality_control_plans where company_id = v_co and code = v_code order by version_no desc limit 1;
  if found and (v_prev.stage <> p_stage or v_prev.material_id is distinct from p_material or v_prev.article_id is distinct from p_article) then
    raise exception 'QPLAN_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  select coalesce(max(version_no), 0) + 1 into v_no from public.quality_control_plans where company_id = v_co and code = v_code;
  insert into public.quality_control_plans (id, company_id, code, version_no, title, stage, material_id, article_id)
  values (v_id, v_co, v_code, v_no, btrim(coalesce(p_title, '')), p_stage, p_material, p_article);
  perform private.write_audit(v_co, 'quality.plan_create', 'quality_plan', v_id::text, v_code || ' v' || v_no, null,
    jsonb_build_object('stage', p_stage, 'version_no', v_no), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.quality_control_plan_add_characteristic(p_plan uuid, p_name text, p_method text, p_kind text, p_sample int,
  p_unit text, p_tol_min numeric, p_tol_max numeric, p_instrument uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.quality_control_plans%rowtype; v_id uuid := gen_random_uuid(); v_pos int;
begin
  perform private.require_perm('quality.plan');
  select * into p from public.quality_control_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'QPLAN_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status <> 'draft' then raise exception 'QPLAN_BAD_STATUS' using errcode = '55000'; end if;
  if p_kind not in ('measure', 'attribute') then raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023'; end if;
  if p_sample is null or p_sample < 1 or p_sample > 500 then raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_method, ''))) < 3 then raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023'; end if;
  if p_kind = 'measure' then
    if nullif(btrim(coalesce(p_unit, '')), '') is null or p_tol_min is null or p_tol_max is null or p_tol_min > p_tol_max or p_instrument is null then
      raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023';
    end if;
    if not exists (select 1 from public.quality_instruments where id = p_instrument and company_id = v_co and active) then
      raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    if p_unit is not null or p_tol_min is not null or p_tol_max is not null or p_instrument is not null then
      raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023';
    end if;
  end if;
  select coalesce(max(pos), 0) + 1 into v_pos from public.quality_plan_characteristics where plan_id = p_plan;
  insert into public.quality_plan_characteristics (id, company_id, plan_id, pos, name, method, kind, sample_size, unit, tol_min, tol_max, instrument_id)
  values (v_id, v_co, p_plan, v_pos, btrim(p_name), btrim(p_method), p_kind, p_sample, nullif(btrim(coalesce(p_unit, '')), ''), p_tol_min, p_tol_max, p_instrument);
  return v_id;
end $$;

-- Activation : rédacteur distinct de l'activateur ; retire la version précédente du code ; pas de chevauchement sur le périmètre
create function public.quality_control_plan_activate(p_plan uuid, p_valid_from date) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.quality_control_plans%rowtype; v_n int; v_overlap int;
begin
  perform private.require_perm('quality.plan');
  select * into p from public.quality_control_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'QPLAN_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status <> 'draft' then raise exception 'QPLAN_BAD_STATUS' using errcode = '55000'; end if;
  if p.created_by is not distinct from auth.uid() then raise exception 'QPLAN_SOD' using errcode = '42501'; end if;
  if p_valid_from is null then raise exception 'QPLAN_BAD_STATUS' using errcode = '22023'; end if;
  select count(*) into v_n from public.quality_plan_characteristics where plan_id = p_plan;
  if v_n = 0 then raise exception 'QPLAN_NO_CHARACTERISTIC' using errcode = '55000'; end if;
  -- version précédente du même code : fin de validité la veille de l'activation
  update public.quality_control_plans set status = 'retired', valid_to = p_valid_from - 1, retired_at = now()
    where company_id = v_co and code = p.code and status = 'active';
  -- chevauchement avec un autre plan actif du même périmètre et de la même étape
  select count(*) into v_overlap from public.quality_control_plans x
    where x.company_id = v_co and x.status = 'active' and x.stage = p.stage
      and x.material_id is not distinct from p.material_id and x.article_id is not distinct from p.article_id
      and (x.valid_to is null or x.valid_to >= p_valid_from);
  if v_overlap > 0 then raise exception 'QPLAN_OVERLAP' using errcode = '55000'; end if;
  update public.quality_control_plans set status = 'active', valid_from = p_valid_from, activated_by = auth.uid(), activated_at = now()
    where id = p_plan;
  perform private.write_audit(v_co, 'quality.plan_activate', 'quality_plan', p_plan::text, p.code || ' v' || p.version_no, null,
    jsonb_build_object('valid_from', p_valid_from, 'characteristics', v_n), '{}'::jsonb, 'rpc');
end $$;

-- Plan en vigueur à une date pour une étape et un périmètre (matière en réception, article sinon)
create function public.quality_control_plan_at(p_stage text, p_material uuid, p_article uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.quality_control_plans%rowtype;
begin
  perform private.require_perm('quality.read');
  select * into p from public.quality_control_plans
    where company_id = v_co and status = 'active' and stage = p_stage
      and material_id is not distinct from p_material and article_id is not distinct from p_article
      and valid_from <= p_date and (valid_to is null or p_date <= valid_to)
    order by version_no desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('plan_id', p.id, 'code', p.code, 'version_no', p.version_no, 'title', p.title, 'valid_from', p.valid_from, 'valid_to', p.valid_to);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Ouverture d'un contrôle planifié (snapshot du plan à la date d'ouverture)
-- ---------------------------------------------------------------------------
create function public.quality_inspection_open_planned(p_stage text, p_material uuid, p_article uuid, p_production_order uuid,
  p_purchase_receipt uuid, p_receipt_ref text, p_sample numeric, p_material_lot uuid, p_finished_lot uuid, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_plan public.quality_control_plans%rowtype; v_insp uuid := gen_random_uuid(); v_number text;
  v_kind text := p_stage;
begin
  perform private.require_perm('quality.write');
  if p_stage not in ('reception', 'in_process', 'final') then raise exception 'QPLAN_CHARACTERISTIC_INVALID' using errcode = '22023'; end if;
  if p_sample is null or p_sample <= 0 then raise exception 'QUALITY_BAD_QTY' using errcode = '22023'; end if;
  -- sources : même société
  if p_material is not null and not exists (select 1 from public.bom_materials where id = p_material and company_id = v_co) then raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_article is not null and not exists (select 1 from public.articles where id = p_article and company_id = v_co) then raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_production_order is not null and not exists (select 1 from public.production_orders where id = p_production_order and company_id = v_co) then raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_purchase_receipt is not null and not exists (select 1 from public.purchase_receipts where id = p_purchase_receipt and company_id = v_co) then raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_material_lot is not null and not exists (select 1 from public.stock_lots where id = p_material_lot and company_id = v_co) then raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_finished_lot is not null and not exists (select 1 from public.finished_lots where id = p_finished_lot and company_id = v_co) then raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_material_lot is not null and p_material is not null and (select material_id from public.stock_lots where id = p_material_lot) <> p_material then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = '22023';
  end if;
  -- plan actif à la date d'ouverture, pour la matière (réception) ou l'article (en cours, final)
  select * into v_plan from public.quality_control_plans
    where company_id = v_co and status = 'active' and stage = p_stage
      and material_id is not distinct from (case when p_stage = 'reception' then p_material end)
      and article_id is not distinct from (case when p_stage = 'reception' then null else p_article end)
      and valid_from <= current_date and (valid_to is null or current_date <= valid_to)
    order by version_no desc limit 1;
  if not found then raise exception 'QUALITY_PLAN_MISSING' using errcode = 'P0002'; end if;
  insert into public.quality_inspections (id, kind, material_id, article_id, production_order_id, purchase_receipt_id, receipt_ref, sample_size,
    note, plan_id, plan_version_no, material_lot_id, finished_lot_id)
  values (v_insp, v_kind, p_material, p_article, p_production_order, p_purchase_receipt, nullif(btrim(coalesce(p_receipt_ref, '')), ''),
    p_sample, nullif(btrim(coalesce(p_note, '')), ''), v_plan.id, v_plan.version_no, p_material_lot, p_finished_lot)
  returning number into v_number;
  insert into public.quality_inspection_characteristics (company_id, inspection_id, source_id, plan_id, plan_version_no, pos, name, method, kind,
    sample_size, unit, tol_min, tol_max, instrument_id, instrument_code)
  select v_co, v_insp, c.id, c.plan_id, v_plan.version_no, c.pos, c.name, c.method, c.kind, c.sample_size, c.unit, c.tol_min, c.tol_max,
         c.instrument_id, i.code
  from public.quality_plan_characteristics c left join public.quality_instruments i on i.id = c.instrument_id
  where c.plan_id = v_plan.id order by c.pos;
  perform private.write_audit(v_co, 'quality.inspection_open_planned', 'quality_inspection', v_insp::text, v_number, null,
    jsonb_build_object('plan', v_plan.code, 'version_no', v_plan.version_no, 'stage', p_stage), '{}'::jsonb, 'rpc');
  return v_insp;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Résultats : une mesure ou un attribut par caractéristique et par échantillon
-- ---------------------------------------------------------------------------
create function public.quality_measurement_record(p_inspection uuid, p_characteristic uuid, p_sample_no int, p_unit text,
  p_value numeric, p_result_text text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.quality_inspections%rowtype; c public.quality_inspection_characteristics%rowtype;
  v_inst public.quality_instruments%rowtype; v_in boolean; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quality.write');
  select * into i from public.quality_inspections where id = p_inspection and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if i.plan_id is null then raise exception 'QUALITY_PLAN_MISSING' using errcode = 'P0002'; end if;
  select * into c from public.quality_inspection_characteristics where id = p_characteristic and inspection_id = i.id;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_sample_no is null or p_sample_no < 1 or p_sample_no > c.sample_size then raise exception 'QUALITY_SAMPLE_OUT_OF_RANGE' using errcode = '22023'; end if;
  if exists (select 1 from public.quality_measurements where characteristic_id = c.id and sample_no = p_sample_no) then
    raise exception 'QUALITY_MEASUREMENT_EXISTS' using errcode = '23505';
  end if;
  if c.kind = 'measure' then
    if p_value is null then raise exception 'QUALITY_VALUE_REQUIRED' using errcode = '22023'; end if;
    if nullif(btrim(coalesce(p_unit, '')), '') is distinct from c.unit then raise exception 'QUALITY_UNIT_MISMATCH' using errcode = '22023'; end if;
    select * into v_inst from public.quality_instruments where id = c.instrument_id;
    if v_inst.calibration_due < current_date or not v_inst.active then raise exception 'QUALITY_INSTRUMENT_NOT_CALIBRATED' using errcode = '55000'; end if;
    v_in := p_value between c.tol_min and c.tol_max;
    insert into public.quality_measurements (id, company_id, inspection_id, characteristic_id, sample_no, unit, value_raw, in_tolerance,
      instrument_id, instrument_code, calibration_due)
    values (v_id, v_co, i.id, c.id, p_sample_no, c.unit, p_value, v_in, v_inst.id, v_inst.code, v_inst.calibration_due);
  else
    if p_result_text not in ('ok', 'ko') then raise exception 'QUALITY_RESULT_INVALID' using errcode = '22023'; end if;
    insert into public.quality_measurements (id, company_id, inspection_id, characteristic_id, sample_no, result_text, in_tolerance)
    values (v_id, v_co, i.id, c.id, p_sample_no, p_result_text, p_result_text = 'ok');
  end if;
  perform private.write_audit(v_co, 'quality.measurement_record', 'quality_inspection', i.id::text, null, null,
    jsonb_build_object('characteristic', c.name, 'sample_no', p_sample_no, 'value', p_value, 'unit', p_unit, 'result', p_result_text),
    '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Décision : redéfinie avec les seules vérifications des contrôles planifiés (contrôles sans plan inchangés)
-- ---------------------------------------------------------------------------
create or replace function public.quality_inspection_decide(p_inspection uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype; v_total numeric; v_crit int; v_major int; v_worst text; v_rej numeric; v_nc uuid; v_nc_number text;
  v_missing int; v_out int; v_recorders int;
begin
  perform private.require_perm('quality.approve');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_decision not in ('accepted', 'conditional', 'rejected') then raise exception 'QUALITY_BAD_DECISION' using errcode = '22023'; end if;
  select coalesce(sum(qty), 0), count(*) filter (where severity = 'critical'), count(*) filter (where severity = 'major'),
         (array_agg(severity order by case severity when 'critical' then 1 when 'major' then 2 else 3 end))[1]
    into v_total, v_crit, v_major, v_worst
    from public.quality_defects where inspection_id = i.id;
  if v_crit > 0 and p_decision <> 'rejected' then raise exception 'QUALITY_CRITICAL_DEFECT' using errcode = '22023'; end if;
  if v_major > 0 and p_decision = 'accepted' then raise exception 'QUALITY_DECISION_NOT_ALLOWED' using errcode = '22023'; end if;

  -- contrôle planifié : résultats complets et conformes avant acceptation ; décideur distinct des saisissants
  if i.plan_id is not null then
    if p_decision = 'accepted' then
      select count(*) into v_missing from public.quality_inspection_characteristics c
        where c.inspection_id = i.id
          and (select count(*) from public.quality_measurements m where m.characteristic_id = c.id) < c.sample_size;
      if v_missing > 0 then raise exception 'QUALITY_RESULTS_INCOMPLETE' using errcode = '55000'; end if;
      select count(*) into v_out from public.quality_measurements m where m.inspection_id = i.id and m.in_tolerance = false;
      if v_out > 0 then raise exception 'QUALITY_OUT_OF_TOLERANCE' using errcode = '55000'; end if;
    end if;
    select count(distinct recorded_by) into v_recorders from public.quality_measurements m where m.inspection_id = i.id and m.recorded_by = auth.uid();
    if v_recorders > 0 then raise exception 'QUALITY_DECIDER_IS_RECORDER' using errcode = '42501'; end if;
  end if;

  v_rej := case p_decision when 'rejected' then i.sample_size when 'conditional' then least(i.sample_size, v_total) else 0 end;
  update public.quality_inspections set status = 'closed', decision = p_decision, qty_rejected = v_rej, qty_accepted = i.sample_size - v_rej,
    note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note), closed_at = now(), closed_by = auth.uid()
    where id = i.id;

  if p_decision = 'rejected' then
    v_nc := gen_random_uuid();
    insert into public.quality_nonconformities (id, number, title, description, severity, inspection_id)
    values (v_nc, null, 'Non-conformité ' || i.number, 'Contrôle rejeté : voir les défauts constatés sur le contrôle ' || i.number,
      coalesce(v_worst, 'major'), i.id)
    returning number into v_nc_number;
    perform private.write_audit(i.company_id, 'quality.nc_open', 'quality_nonconformity', v_nc::text, v_nc_number, null,
      jsonb_build_object('inspection', i.number, 'severity', v_worst), '{}'::jsonb, 'rpc');
  end if;
  perform private.write_audit(i.company_id, 'quality.inspection_decide', 'quality_inspection', i.id::text, i.number, null,
    jsonb_build_object('decision', p_decision, 'defects', v_total, 'rejected', v_rej, 'planned', i.plan_id is not null), '{}'::jsonb, 'rpc');
  return jsonb_build_object('decision', p_decision, 'qty_rejected', v_rej, 'nc_id', v_nc, 'nc_number', v_nc_number);
end $$;

-- ---------------------------------------------------------------------------
-- 11. Rejeu : même plan et mêmes caractéristiques que le contrôle d'origine
-- ---------------------------------------------------------------------------
create function public.quality_inspection_replay(p_inspection uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.quality_inspections%rowtype; v_new uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'QUALITY_REPLAY_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into o from public.quality_inspections where id = p_inspection and company_id = v_co;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.plan_id is null then raise exception 'QUALITY_PLAN_MISSING' using errcode = 'P0002'; end if;
  if o.status <> 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  insert into public.quality_inspections (id, kind, material_id, article_id, production_order_id, purchase_receipt_id, receipt_ref, sample_size,
    note, plan_id, plan_version_no, replay_of_id, material_lot_id, finished_lot_id)
  values (v_new, o.kind, o.material_id, o.article_id, o.production_order_id, o.purchase_receipt_id, o.receipt_ref, o.sample_size,
    'Rejeu de ' || o.number || ' : ' || btrim(p_reason), o.plan_id, o.plan_version_no, o.id, o.material_lot_id, o.finished_lot_id)
  returning number into v_number;
  insert into public.quality_inspection_characteristics (company_id, inspection_id, source_id, plan_id, plan_version_no, pos, name, method, kind,
    sample_size, unit, tol_min, tol_max, instrument_id, instrument_code)
  select v_co, v_new, c.source_id, c.plan_id, c.plan_version_no, c.pos, c.name, c.method, c.kind, c.sample_size, c.unit, c.tol_min, c.tol_max,
         c.instrument_id, c.instrument_code
  from public.quality_inspection_characteristics c where c.inspection_id = o.id order by c.pos;
  perform private.write_audit(v_co, 'quality.inspection_replay', 'quality_inspection', v_new::text, v_number, null,
    jsonb_build_object('replay_of', o.number, 'plan_version_no', o.plan_version_no, 'reason', btrim(p_reason)), '{}'::jsonb, 'rpc');
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 12. Lecture : contrôle complet (plan, caractéristiques, résultats et preuves) et recherche par lot / OF / réception
-- ---------------------------------------------------------------------------
create function public.quality_inspection_snapshot(p_inspection uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); i public.quality_inspections%rowtype; v_chars jsonb; v_meas jsonb; v_plan jsonb;
begin
  perform private.require_perm('quality.read');
  select * into i from public.quality_inspections where id = p_inspection and company_id = v_co;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'pos', c.pos, 'name', c.name, 'method', c.method, 'kind', c.kind,
      'sample_size', c.sample_size, 'unit', c.unit, 'tol_min', c.tol_min, 'tol_max', c.tol_max, 'instrument', c.instrument_code,
      'plan_version_no', c.plan_version_no) order by c.pos), '[]'::jsonb)
  into v_chars from public.quality_inspection_characteristics c where c.inspection_id = i.id;
  select coalesce(jsonb_agg(jsonb_build_object('characteristic_id', m.characteristic_id, 'sample_no', m.sample_no, 'unit', m.unit,
      'value', m.value_raw, 'result', m.result_text, 'in_tolerance', m.in_tolerance, 'instrument', m.instrument_code,
      'calibration_due', m.calibration_due, 'recorded_at', m.recorded_at, 'recorded_by', m.recorded_by)
      order by m.characteristic_id, m.sample_no), '[]'::jsonb)
  into v_meas from public.quality_measurements m where m.inspection_id = i.id;
  select jsonb_build_object('code', p.code, 'version_no', p.version_no, 'status', p.status, 'valid_from', p.valid_from, 'valid_to', p.valid_to)
  into v_plan from public.quality_control_plans p where p.id = i.plan_id;
  return jsonb_build_object('inspection', i.number, 'kind', i.kind, 'status', i.status, 'decision', i.decision, 'sample_size', i.sample_size,
    'replay_of_id', i.replay_of_id, 'plan', v_plan, 'characteristics', v_chars, 'measurements', v_meas,
    'decided_by', i.closed_by, 'closed_at', i.closed_at);
end $$;

create function public.quality_inspections_for_lot(p_link text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v jsonb;
begin
  perform private.require_perm('quality.read');
  if p_link not in ('material_lot', 'finished_lot', 'production_order', 'purchase_receipt') then raise exception 'QUALITY_BAD_LINK' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('inspection', i.number, 'kind', i.kind, 'status', i.status, 'decision', i.decision,
      'plan', p.code, 'plan_version_no', i.plan_version_no, 'replay_of', (select r.number from public.quality_inspections r where r.id = i.replay_of_id),
      'opened_at', i.opened_at) order by i.opened_at), '[]'::jsonb)
  into v
  from public.quality_inspections i left join public.quality_control_plans p on p.id = i.plan_id
  where i.company_id = v_co
    and case p_link
          when 'material_lot' then i.material_lot_id = p_id
          when 'finished_lot' then i.finished_lot_id = p_id
          when 'production_order' then i.production_order_id = p_id
          else i.purchase_receipt_id = p_id end;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 13. Privilèges d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.quality_instrument_save(text, text, date, boolean), public.quality_control_plan_create(text, text, text, uuid, uuid),
  public.quality_control_plan_add_characteristic(uuid, text, text, text, int, text, numeric, numeric, uuid), public.quality_control_plan_activate(uuid, date),
  public.quality_control_plan_at(text, uuid, uuid, date),
  public.quality_inspection_open_planned(text, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid, text),
  public.quality_measurement_record(uuid, uuid, int, text, numeric, text), public.quality_inspection_replay(uuid, text),
  public.quality_inspection_snapshot(uuid), public.quality_inspections_for_lot(text, uuid) from public, anon;
grant execute on function public.quality_instrument_save(text, text, date, boolean), public.quality_control_plan_create(text, text, text, uuid, uuid),
  public.quality_control_plan_add_characteristic(uuid, text, text, text, int, text, numeric, numeric, uuid), public.quality_control_plan_activate(uuid, date),
  public.quality_control_plan_at(text, uuid, uuid, date),
  public.quality_inspection_open_planned(text, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid, text),
  public.quality_measurement_record(uuid, uuid, int, text, numeric, text), public.quality_inspection_replay(uuid, text),
  public.quality_inspection_snapshot(uuid), public.quality_inspections_for_lot(text, uuid) to authenticated, service_role;
