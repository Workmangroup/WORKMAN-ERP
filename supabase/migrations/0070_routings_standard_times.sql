-- 0070_routings_standard_times — Gammes et temps standards : opérations coupe / confection / personnalisation /
-- contrôle / pack, postes, compétences, calendrier de poste, temps standard versionnés, gamme approuvée figée à chaque
-- lancement d'OF, instructions accessibles par droit de lecture de la gamme.
--
-- Existant conservé (0008, 0019, 0042, 0069) :
--   * work_centers (0019) : postes, heures par jour, rendement ; kinds étendus (personnalisation, pack).
--   * calendars (0042) : calendriers à jours ouvrés ISO ; reliés désormais à un poste (work_centers.calendar_id).
--   * bom_operations (0008) : opérations de nomenclature et coût main d'œuvre ; elles ne sont PAS remplacées.
--     La gamme est un référentiel séparé ; bom_operations reste utilisé par le calcul de coût de la nomenclature.
--   * production_orders (0019) : std_minutes_per_unit saisi à la main est conservé tel quel.
--   * production_order_bom (0069) : figure de nomenclature, inchangée.
--
-- Règles :
--  * Unité de temps explicite : chaque opération saisit une valeur et une unité (s, min, h). Le temps standard est
--    stocké en minutes par pièce (colonne générée). La tolérance (pourcentage) s'ajoute explicitement.
--  * Gamme versionnée : routing_versions (brouillon, approuvée, remplacée). Une seule version approuvée par article.
--    Une version approuvée est figée (opérations non modifiables). Une nouvelle version part de la version approuvée.
--  * Approbation distincte : le valideur ne peut pas être le rédacteur (SOD_SELF_APPROVAL).
--  * Figure de l'OF : au lancement, la gamme approuvée de l'article est figée dans production_order_routing (opérations
--    incluses). Une gamme approuvée plus tard n'y change rien. Sans gamme approuvée : statut no_routing.
--  * Écritures uniquement par fonctions (drapeau routing.rpc) ; lectures filtrées par société et droit routing.read.
--  * Compétences : catalogue de compétences (production_skills) et niveaux attribués à des personnes (profile_skills, niveau
--    1 à 3). Pas de décision RH : la compétence décrit seulement ce qu'une personne sait faire ; aucune paie ni évaluation.
--  * Capacité d'un poste : heures par jour × rendement × jours ouvrés du calendrier du poste. Sans calendrier : pas de capacité.
--
-- Erreurs : ROUTING_RPC_ONLY, ROUTING_VERSION_LOCKED, ROUTING_BAD_STATUS, ROUTING_DRAFT_EXISTS, ROUTING_EMPTY,
-- ROUTING_KIND_INVALID, ROUTING_TIME_UNIT_INVALID, ROUTING_TIME_INVALID, ROUTING_ALLOWANCE_INVALID,
-- ROUTING_WORK_CENTER_INVALID, ROUTING_SKILL_INVALID, ROUTING_SNAPSHOT_IMMUTABLE, ROUTING_CALENDAR_INVALID,
-- SKILL_LEVEL_INVALID, SOD_SELF_APPROVAL, RBAC_FORBIDDEN, PRODUCTION_NOT_FOUND.

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('routing.read',    'production', 'Voir les gammes et temps standards', 'Gammes, opérations, instructions, capacité des postes, compétences'),
  ('routing.write',   'production', 'Gérer les gammes',                   'Créer et modifier le brouillon de gamme, catalogue des compétences, compétences des personnes'),
  ('routing.approve', 'production', 'Approuver les gammes',               'Approuver une gamme (distinct du rédacteur)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('routing.read', 'routing.write', 'routing.approve'))
  or (r.code = 'direction' and p.code in ('routing.read', 'routing.approve'))
  or (r.code = 'production' and p.code in ('routing.read', 'routing.write'))
  or (r.code = 'qualite'   and p.code = 'routing.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Postes : nouveaux types et calendrier
-- ---------------------------------------------------------------------------
alter table public.work_centers drop constraint if exists work_centers_kind_check;
alter table public.work_centers add constraint work_centers_kind_check
  check (kind in ('coupe', 'couture', 'finition', 'repassage', 'controle', 'personnalisation', 'pack', 'other'));
alter table public.work_centers add column if not exists calendar_id uuid references public.calendars(id) on delete set null;

create function private.work_centers_calendar_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.calendar_id is not null and not exists (
    select 1 from public.calendars c
    where c.id = new.calendar_id and c.company_id = new.company_id and c.archived_at is null) then
    raise exception 'ROUTING_CALENDAR_INVALID' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger work_centers_calendar_guard_biu before insert or update of calendar_id, company_id on public.work_centers
  for each row execute function private.work_centers_calendar_guard();

-- ---------------------------------------------------------------------------
-- 3. Compétences
-- ---------------------------------------------------------------------------
create table public.production_skills (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name        text not null check (length(btrim(name)) between 2 and 120),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, code)
);

create table public.profile_skills (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  skill_id     uuid not null references public.production_skills(id) on delete cascade,
  level        smallint not null check (level between 1 and 3),
  valid_until  date,
  granted_at   timestamptz not null default now(),
  granted_by   uuid default auth.uid(),
  unique (profile_id, skill_id)
);

-- ---------------------------------------------------------------------------
-- 4. Gammes versionnées et opérations
-- ---------------------------------------------------------------------------
create table public.routing_versions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  article_id      uuid not null references public.articles(id) on delete cascade,
  version_no      int  not null check (version_no >= 1),
  status          text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  note            text check (note is null or length(note) <= 500),
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  approved_at     timestamptz,
  approved_by     uuid,
  approval_note   text check (approval_note is null or length(approval_note) <= 500),
  effective_from  date,
  superseded_at   timestamptz,
  unique (article_id, version_no)
);
-- Une seule gamme approuvée par article
create unique index routing_versions_one_approved_idx on public.routing_versions (article_id) where status = 'approved';
-- Un seul brouillon par article
create unique index routing_versions_one_draft_idx on public.routing_versions (article_id) where status = 'draft';

create table public.routing_operations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  version_id          uuid not null references public.routing_versions(id) on delete cascade,
  pos                 int  not null check (pos >= 1),
  kind                text not null check (kind in ('coupe', 'confection', 'personnalisation', 'controle', 'pack')),
  name                text not null check (length(btrim(name)) between 2 and 120),
  work_center_id      uuid not null references public.work_centers(id),
  skill_id            uuid references public.production_skills(id),
  time_value          numeric(10,3) not null check (time_value > 0 and time_value <= 100000),
  time_unit           text not null check (time_unit in ('s', 'min', 'h')),
  -- Temps standard par pièce, en minutes (colonne générée à partir de la valeur et de l'unité)
  standard_minutes    numeric(12,4) generated always as (
                        time_value * (case time_unit when 's' then 1.0 / 60 when 'min' then 1 else 60 end)) stored,
  allowance_pct       numeric(5,2) not null default 0 check (allowance_pct >= 0 and allowance_pct <= 100),
  -- Temps standard tolérance incluse, en minutes par pièce
  minutes_with_allowance numeric(12,4) generated always as (
                        time_value * (case time_unit when 's' then 1.0 / 60 when 'min' then 1 else 60 end)
                        * (1 + allowance_pct / 100)) stored,
  instructions        text check (instructions is null or length(instructions) <= 4000),
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  unique (version_id, pos)
);
create index routing_operations_version_idx on public.routing_operations (version_id, pos);

-- Figure de la gamme au lancement d'un OF (immuable)
create table public.production_order_routing (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  order_id     uuid not null unique references public.production_orders(id) on delete cascade,
  status       text not null check (status in ('frozen', 'no_routing')),
  version_id   uuid references public.routing_versions(id),
  version_no   int,
  operations   jsonb not null default '[]'::jsonb,
  frozen_at    timestamptz not null default now(),
  frozen_by    uuid default auth.uid()
);

-- ---------------------------------------------------------------------------
-- 5. Garde-fous : écritures par fonctions seulement, brouillon seulement pour les opérations
-- ---------------------------------------------------------------------------
create function private.routing_rpc_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('routing.rpc', true), '') <> 'on' then
    raise exception 'ROUTING_RPC_ONLY' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create trigger routing_versions_guard_iud before insert or update or delete on public.routing_versions
  for each row execute function private.routing_rpc_guard();
create trigger routing_operations_guard_iud before insert or update or delete on public.routing_operations
  for each row execute function private.routing_rpc_guard();

create function private.routing_operations_draft_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.routing_versions where id = coalesce(new.version_id, old.version_id);
  if v_status is distinct from 'draft' then raise exception 'ROUTING_VERSION_LOCKED' using errcode = '55000'; end if;
  return coalesce(new, old);
end $$;
create trigger routing_operations_draft_biud before insert or update or delete on public.routing_operations
  for each row execute function private.routing_operations_draft_guard();

create function private.production_order_routing_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'ROUTING_SNAPSHOT_IMMUTABLE' using errcode = '55000';
end $$;
create trigger production_order_routing_immutable_bud before update or delete on public.production_order_routing
  for each row execute function private.production_order_routing_immutable();

-- ---------------------------------------------------------------------------
-- 6. Sécurité des lignes et droits d'accès direct
-- ---------------------------------------------------------------------------
alter table public.production_skills        enable row level security;
alter table public.profile_skills           enable row level security;
alter table public.routing_versions         enable row level security;
alter table public.routing_operations       enable row level security;
alter table public.production_order_routing enable row level security;

create policy production_skills_select on public.production_skills for select to authenticated
  using (company_id = private.current_company() and private.has_perm('routing.read'));
create policy profile_skills_select on public.profile_skills for select to authenticated
  using (company_id = private.current_company() and private.has_perm('routing.read'));
create policy routing_versions_select on public.routing_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('routing.read'));
create policy routing_operations_select on public.routing_operations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('routing.read'));
create policy production_order_routing_select on public.production_order_routing for select to authenticated
  using (company_id = private.current_company() and private.has_perm('routing.read'));

revoke all on public.production_skills, public.profile_skills, public.routing_versions,
             public.routing_operations, public.production_order_routing from anon, authenticated;
grant select on public.production_skills, public.profile_skills, public.routing_versions,
                public.routing_operations, public.production_order_routing to authenticated;
grant all on public.production_skills, public.profile_skills, public.routing_versions,
             public.routing_operations, public.production_order_routing to service_role;

-- ---------------------------------------------------------------------------
-- 7. Fonctions : compétences
-- ---------------------------------------------------------------------------
create function public.production_skill_create(p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text := upper(btrim(p_code));
begin
  perform private.require_perm('routing.write');
  if v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,19}$' then raise exception 'ROUTING_SKILL_CODE_INVALID' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'ROUTING_SKILL_NAME_INVALID' using errcode = '22023'; end if;
  perform set_config('routing.rpc', 'on', true);
  insert into public.production_skills (id, company_id, code, name) values (v_id, v_co, v_code, btrim(p_name));
  perform set_config('routing.rpc', 'off', true);
  perform private.write_audit(v_co, 'skill.create', 'production_skill', v_id::text, v_code, null,
    jsonb_build_object('code', v_code, 'name', btrim(p_name)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.production_skill_set_active(p_skill uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.production_skills%rowtype;
begin
  perform private.require_perm('routing.write');
  select * into s from public.production_skills where id = p_skill and company_id = v_co for update;
  if not found then raise exception 'ROUTING_SKILL_INVALID' using errcode = 'P0002'; end if;
  perform set_config('routing.rpc', 'on', true);
  update public.production_skills set active = p_active where id = p_skill;
  perform set_config('routing.rpc', 'off', true);
  perform private.write_audit(v_co, case when p_active then 'skill.restore' else 'skill.archive' end, 'production_skill',
    p_skill::text, s.code, jsonb_build_object('active', s.active), jsonb_build_object('active', p_active), '{}'::jsonb, 'rpc');
end $$;

create function public.profile_skill_set(p_profile uuid, p_skill uuid, p_level int, p_valid_until date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_code text;
begin
  perform private.require_perm('routing.write');
  if p_level is null or p_level not between 1 and 3 then raise exception 'SKILL_LEVEL_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_profile and company_id = v_co) then
    raise exception 'ROUTING_SKILL_INVALID' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.production_skills where id = p_skill and company_id = v_co and active) then
    raise exception 'ROUTING_SKILL_INVALID' using errcode = '22023';
  end if;
  select code into v_code from public.production_skills where id = p_skill;
  perform set_config('routing.rpc', 'on', true);
  insert into public.profile_skills (company_id, profile_id, skill_id, level, valid_until)
    values (v_co, p_profile, p_skill, p_level, p_valid_until)
  on conflict (profile_id, skill_id) do update set level = excluded.level, valid_until = excluded.valid_until,
    granted_at = now(), granted_by = auth.uid();
  perform set_config('routing.rpc', 'off', true);
  perform private.write_audit(v_co, 'skill.grant', 'profile', p_profile::text, v_code, null,
    jsonb_build_object('skill', v_code, 'level', p_level, 'valid_until', p_valid_until), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 8. Fonctions : gammes
-- ---------------------------------------------------------------------------
-- Crée le brouillon suivant d'un article. Copie les opérations de la version approuvée, s'il y en a une.
create function public.routing_version_create(p_article uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_no int; v_src uuid;
begin
  perform private.require_perm('routing.write');
  if not exists (select 1 from public.articles where id = p_article and company_id = v_co) then
    raise exception 'ROUTING_ARTICLE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.routing_versions where article_id = p_article and status = 'draft') then
    raise exception 'ROUTING_DRAFT_EXISTS' using errcode = '55000';
  end if;
  select coalesce(max(version_no), 0) + 1 into v_no from public.routing_versions where article_id = p_article;
  select id into v_src from public.routing_versions where article_id = p_article and status = 'approved';
  perform set_config('routing.rpc', 'on', true);
  insert into public.routing_versions (id, company_id, article_id, version_no, status, note)
    values (v_id, v_co, p_article, v_no, 'draft', p_note);
  if v_src is not null then
    insert into public.routing_operations (company_id, version_id, pos, kind, name, work_center_id, skill_id,
        time_value, time_unit, allowance_pct, instructions)
      select v_co, v_id, o.pos, o.kind, o.name, o.work_center_id, o.skill_id, o.time_value, o.time_unit,
             o.allowance_pct, o.instructions
      from public.routing_operations o where o.version_id = v_src order by o.pos;
  end if;
  perform set_config('routing.rpc', 'off', true);
  perform private.write_audit(v_co, 'routing.version_create', 'routing_version', v_id::text, null, null,
    jsonb_build_object('article_id', p_article, 'version_no', v_no, 'copied_from', v_src), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Ajoute une opération à un brouillon. Temps saisi dans une unité explicite (s, min, h) ; tolérance en pourcentage.
create function public.routing_operation_add(p_version uuid, p_kind text, p_name text, p_work_center uuid, p_skill uuid,
  p_time_value numeric, p_time_unit text, p_allowance_pct numeric default 0, p_instructions text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v jsonb; v_status text; v_id uuid := gen_random_uuid(); v_pos int;
begin
  perform private.require_perm('routing.write');
  select status into v_status from public.routing_versions where id = p_version and company_id = v_co for update;
  if not found then raise exception 'ROUTING_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'draft' then raise exception 'ROUTING_BAD_STATUS' using errcode = '55000'; end if;
  if p_kind not in ('coupe', 'confection', 'personnalisation', 'controle', 'pack') then
    raise exception 'ROUTING_KIND_INVALID' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'ROUTING_NAME_INVALID' using errcode = '22023'; end if;
  if p_time_unit is null or p_time_unit not in ('s', 'min', 'h') then raise exception 'ROUTING_TIME_UNIT_INVALID' using errcode = '22023'; end if;
  if p_time_value is null or p_time_value <= 0 or p_time_value > 100000 then raise exception 'ROUTING_TIME_INVALID' using errcode = '22023'; end if;
  if p_allowance_pct is null or p_allowance_pct < 0 or p_allowance_pct > 100 then raise exception 'ROUTING_ALLOWANCE_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.work_centers w where w.id = p_work_center and w.company_id = v_co and w.active) then
    raise exception 'ROUTING_WORK_CENTER_INVALID' using errcode = '22023';
  end if;
  if p_skill is not null and not exists (select 1 from public.production_skills s where s.id = p_skill and s.company_id = v_co and s.active) then
    raise exception 'ROUTING_SKILL_INVALID' using errcode = '22023';
  end if;
  if p_instructions is not null and length(p_instructions) > 4000 then raise exception 'ROUTING_INSTRUCTIONS_TOO_LONG' using errcode = '22001'; end if;
  select coalesce(max(pos), 0) + 1 into v_pos from public.routing_operations where version_id = p_version;
  perform set_config('routing.rpc', 'on', true);
  insert into public.routing_operations (id, company_id, version_id, pos, kind, name, work_center_id, skill_id,
      time_value, time_unit, allowance_pct, instructions)
    values (v_id, v_co, p_version, v_pos, p_kind, btrim(p_name), p_work_center, p_skill, p_time_value, p_time_unit,
      p_allowance_pct, p_instructions);
  perform set_config('routing.rpc', 'off', true);
  select jsonb_build_object('kind', o.kind, 'name', o.name, 'time_value', o.time_value, 'time_unit', o.time_unit,
      'allowance_pct', o.allowance_pct, 'standard_minutes', o.standard_minutes, 'minutes_with_allowance', o.minutes_with_allowance)
    into v from public.routing_operations o where o.id = v_id;
  perform private.write_audit(v_co, 'routing.operation_add', 'routing_version', p_version::text, null, null,
    v, '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.routing_operation_remove(p_op uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.routing_operations%rowtype; v_status text;
begin
  perform private.require_perm('routing.write');
  select * into o from public.routing_operations where id = p_op and company_id = v_co for update;
  if not found then raise exception 'ROUTING_NOT_FOUND' using errcode = 'P0002'; end if;
  select status into v_status from public.routing_versions where id = o.version_id;
  if v_status <> 'draft' then raise exception 'ROUTING_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('routing.rpc', 'on', true);
  delete from public.routing_operations where id = p_op;
  perform set_config('routing.rpc', 'off', true);
  perform private.write_audit(v_co, 'routing.operation_remove', 'routing_version', o.version_id::text, o.name, null,
    jsonb_build_object('kind', o.kind, 'name', o.name, 'pos', o.pos), '{}'::jsonb, 'rpc');
end $$;

-- Approbation : brouillon seulement, au moins une opération, valideur distinct du rédacteur, postes actifs.
-- La version précédemment approuvée passe à « remplacée ». La nouvelle version devient figée.
create function public.routing_version_approve(p_version uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v public.routing_versions%rowtype; v_ops int; v_bad int; v_prev uuid;
begin
  perform private.require_perm('routing.approve');
  select * into v from public.routing_versions where id = p_version and company_id = v_co for update;
  if not found then raise exception 'ROUTING_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'ROUTING_BAD_STATUS' using errcode = '55000'; end if;
  if v.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  select count(*) into v_ops from public.routing_operations where version_id = p_version;
  if v_ops = 0 then raise exception 'ROUTING_EMPTY' using errcode = '55000'; end if;
  select count(*) into v_bad from public.routing_operations o
    left join public.work_centers w on w.id = o.work_center_id and w.company_id = v_co and w.active
    where o.version_id = p_version and w.id is null;
  if v_bad > 0 then raise exception 'ROUTING_WORK_CENTER_INVALID' using errcode = '22023'; end if;
  select id into v_prev from public.routing_versions where article_id = v.article_id and status = 'approved';
  perform set_config('routing.rpc', 'on', true);
  if v_prev is not null then
    update public.routing_versions set status = 'superseded', superseded_at = now() where id = v_prev;
  end if;
  update public.routing_versions set status = 'approved', approved_at = now(), approved_by = auth.uid(),
    approval_note = p_note, effective_from = current_date where id = p_version;
  perform set_config('routing.rpc', 'off', true);
  perform private.write_audit(v_co, 'routing.version_approve', 'routing_version', p_version::text, null,
    jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'approved', 'version_no', v.version_no),
    jsonb_build_object('replaces', v_prev, 'operations', v_ops), 'rpc');
end $$;

-- Résumé d'une version : temps en minutes par pièce, par type d'opération (tolérance incluse)
create function public.routing_version_summary(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v public.routing_versions%rowtype; v_ops jsonb; v_kinds jsonb; v_total numeric;
begin
  perform private.require_perm('routing.read');
  select * into v from public.routing_versions where id = p_version and company_id = v_co;
  if not found then raise exception 'ROUTING_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('pos', o.pos, 'kind', o.kind, 'name', o.name, 'work_center_id', o.work_center_id,
      'skill_id', o.skill_id, 'time_value', o.time_value, 'time_unit', o.time_unit, 'allowance_pct', o.allowance_pct,
      'standard_minutes', o.standard_minutes, 'minutes_with_allowance', o.minutes_with_allowance) order by o.pos), '[]'::jsonb),
    coalesce(sum(o.minutes_with_allowance), 0)
  into v_ops, v_total
  from public.routing_operations o where o.version_id = p_version;
  select coalesce(jsonb_object_agg(k.kind, k.minutes), '{}'::jsonb) into v_kinds
  from (select kind, sum(minutes_with_allowance) as minutes from public.routing_operations where version_id = p_version group by kind) k;
  return jsonb_build_object('version_id', v.id, 'version_no', v.version_no, 'status', v.status, 'article_id', v.article_id,
    'unit', 'min', 'minutes_per_piece', round(v_total, 4), 'minutes_by_kind', v_kinds, 'operations', v_ops);
end $$;

-- Instructions d'une opération : droit de lecture de la gamme requis
create function public.routing_operation_instructions(p_op uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r record;
begin
  perform private.require_perm('routing.read');
  select o.id, o.name, o.kind, o.instructions, w.code as work_center, o.version_id into r
    from public.routing_operations o join public.work_centers w on w.id = o.work_center_id
    where o.id = p_op and o.company_id = v_co;
  if not found then raise exception 'ROUTING_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('operation_id', r.id, 'name', r.name, 'kind', r.kind, 'work_center', r.work_center,
    'instructions', r.instructions);
end $$;

-- Capacité d'un poste par semaine (minutes) : heures/jour × 60 × rendement × jours ouvrés du calendrier
create function public.work_center_capacity(p_work_center uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); w public.work_centers%rowtype; c public.calendars%rowtype;
begin
  perform private.require_perm('production.read');
  select * into w from public.work_centers where id = p_work_center and company_id = v_co;
  if not found then raise exception 'ROUTING_WORK_CENTER_INVALID' using errcode = 'P0002'; end if;
  if w.calendar_id is null then
    return jsonb_build_object('work_center', w.code, 'unit', 'min', 'minutes_per_week', null, 'reason', 'CALENDAR_MISSING');
  end if;
  select * into c from public.calendars where id = w.calendar_id;
  return jsonb_build_object('work_center', w.code, 'unit', 'min', 'calendar', c.code,
    'working_days_per_week', cardinality(c.working_days), 'hours_per_day', w.hours_per_day, 'efficiency_pct', w.efficiency_pct,
    'minutes_per_week', round(w.hours_per_day * 60 * w.efficiency_pct / 100 * cardinality(c.working_days), 2));
end $$;

-- Gamme figée d'un OF
create function public.production_order_routing_get(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.production_order_routing%rowtype;
begin
  perform private.require_perm('routing.read');
  select * into r from public.production_order_routing where order_id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('status', r.status, 'version_id', r.version_id, 'version_no', r.version_no,
    'frozen_at', r.frozen_at, 'unit', 'min', 'operations', r.operations);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Figure de la gamme au lancement d'un OF
-- ---------------------------------------------------------------------------
create function private.production_freeze_routing(p_order uuid, p_company uuid, p_article uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.routing_versions%rowtype; v_ops jsonb;
begin
  select * into v from public.routing_versions where article_id = p_article and company_id = p_company and status = 'approved';
  if not found then
    insert into public.production_order_routing (company_id, order_id, status, operations)
      values (p_company, p_order, 'no_routing', '[]'::jsonb);
    return;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('pos', o.pos, 'kind', o.kind, 'name', o.name, 'work_center_id', o.work_center_id,
      'work_center', w.code, 'skill_id', o.skill_id, 'time_value', o.time_value, 'time_unit', o.time_unit,
      'allowance_pct', o.allowance_pct, 'standard_minutes', o.standard_minutes,
      'minutes_with_allowance', o.minutes_with_allowance, 'instructions', o.instructions) order by o.pos), '[]'::jsonb)
  into v_ops
  from public.routing_operations o join public.work_centers w on w.id = o.work_center_id where o.version_id = v.id;
  insert into public.production_order_routing (company_id, order_id, status, version_id, version_no, operations)
    values (p_company, p_order, 'frozen', v.id, v.version_no, v_ops);
end $$;
revoke execute on function private.production_freeze_routing(uuid, uuid, uuid) from public, anon, authenticated;

create function private.production_orders_routing_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.production_freeze_routing(new.id, new.company_id, new.article_id);
  return new;
end $$;
create trigger production_orders_routing_freeze_au after update of status on public.production_orders
  for each row when (old.status is distinct from new.status and new.status = 'launched')
  execute function private.production_orders_routing_freeze();

-- ---------------------------------------------------------------------------
-- 10. Privilèges d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.production_skill_create(text, text), public.production_skill_set_active(uuid, boolean),
  public.profile_skill_set(uuid, uuid, int, date), public.routing_version_create(uuid, text),
  public.routing_operation_add(uuid, text, text, uuid, uuid, numeric, text, numeric, text),
  public.routing_operation_remove(uuid), public.routing_version_approve(uuid, text), public.routing_version_summary(uuid),
  public.routing_operation_instructions(uuid), public.work_center_capacity(uuid), public.production_order_routing_get(uuid)
  from public, anon;
grant execute on function public.production_skill_create(text, text), public.production_skill_set_active(uuid, boolean),
  public.profile_skill_set(uuid, uuid, int, date), public.routing_version_create(uuid, text),
  public.routing_operation_add(uuid, text, text, uuid, uuid, numeric, text, numeric, text),
  public.routing_operation_remove(uuid), public.routing_version_approve(uuid, text), public.routing_version_summary(uuid),
  public.routing_operation_instructions(uuid), public.work_center_capacity(uuid), public.production_order_routing_get(uuid)
  to authenticated, service_role;
