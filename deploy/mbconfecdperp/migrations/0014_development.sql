-- =====================================================================
-- 0014_development — Module Développement Produit
--  Workflow : Demande client → Projet → Prototype → Échantillon → BAT → Validation client → Industrialisation → Production série.
--  Tables : development_projects, prototypes, prototype_costs, samples, customer_validations, industrialization,
--           development_exchanges (historique des échanges, append-only), development_documents (pièces jointes GED).
--  Règles : l'étape n'avance que d'un cran et sous conditions (prototype approuvé, échantillon approuvé, BAT soumis puis approuvé,
--           industrialisation prête) ; tout retour en arrière exige un motif. Versions numérotées par projet (prototypes, échantillons, BAT).
--  Coûts de prototype : réservés à `development.costs` / `costs.read` (jamais dans l'historique, jamais dans les listes).
--  Alertes de validation : retards, échéances proches, validations sans réponse (RPC development_alerts).
--  Permissions nouvelles : development.read / development.write / development.costs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('development.read',  'articles', 'Voir le développement produit', 'Projets, Kanban, prototypes, échantillons, validations, tableau de bord et alertes'),
  ('development.write', 'articles', 'Gérer le développement produit', 'Créer et faire avancer les projets, prototypes, échantillons, validations client, échanges'),
  ('development.costs', 'articles', 'Saisir et voir les coûts de prototype', 'Coûts matière, main-d''œuvre, sous-traitance des prototypes')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('development.read', 'development.write', 'development.costs'))
  or (r.code = 'direction'  and p.code = 'development.read')
  or (r.code = 'commercial' and p.code in ('development.read', 'development.write'))
  or (r.code = 'production' and p.code in ('development.read', 'development.write', 'development.costs'))
  or (r.code = 'qualite'    and p.code = 'development.read')
  or (r.code = 'achat'      and p.code = 'development.read')
  or (r.code = 'finance'    and p.code = 'development.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.development_projects (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  client_id        uuid not null references public.clients(id),
  code             text not null,                                           -- DEV-0001
  name             text not null check (length(btrim(name)) between 2 and 160),
  family           text not null default 'other' check (family in ('jacket','trousers','coverall','polo','tshirt','vest','parka','shirt','apron','accessory','other')),
  description      text check (description is null or length(description) <= 4000),   -- demande du client
  stage            text not null default 'request' check (stage in ('request','project','prototype','sample','bat','validation','industrialization','production')),
  status           text not null default 'active' check (status in ('active','on_hold','cancelled','completed')),
  priority         text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  owner_id         uuid references public.profiles(id) on delete set null,
  requested_on     date not null default current_date,
  due_date         date,
  target_qty       int check (target_qty is null or target_qty > 0),         -- quantité de la série visée
  product_id       uuid references public.product_master(id) on delete set null,   -- fiche produit (PDM) liée
  stage_changed_at timestamptz not null default now(),
  hold_reason      text check (hold_reason is null or length(hold_reason) <= 300),
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  unique (company_id, code),
  constraint dev_dates_ck check (due_date is null or due_date >= requested_on)
);
create index dev_projects_idx on public.development_projects (company_id, status, stage);
create index dev_projects_client_idx on public.development_projects (client_id);

create table public.prototypes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  project_id   uuid not null references public.development_projects(id) on delete cascade,
  version_no   int not null check (version_no >= 1),
  name         text check (name is null or length(name) <= 160),
  description  text check (description is null or length(description) <= 2000),
  status       text not null default 'planned' check (status in ('planned','in_progress','ready','approved','rejected')),
  owner_id     uuid references public.profiles(id) on delete set null,
  due_date     date,
  started_on   date,
  completed_on date,
  feedback     text check (feedback is null or length(feedback) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  unique (project_id, version_no)
);

create table public.prototype_costs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  project_id   uuid not null references public.development_projects(id) on delete cascade,
  prototype_id uuid not null references public.prototypes(id) on delete cascade,
  kind         text not null default 'material' check (kind in ('material','labor','subcontract','shipping','other')),
  description  text not null check (length(btrim(description)) between 1 and 200),
  quantity     numeric(12,3) not null default 1 check (quantity > 0 and quantity < 100000000),
  unit_cost    numeric(14,4) not null default 0 check (unit_cost >= 0 and unit_cost < 1000000000),
  amount       numeric(16,2) generated always as (round(quantity * unit_cost, 2)) stored,
  incurred_on  date not null default current_date,
  created_at   timestamptz not null default now(),
  created_by   uuid
);
create index prototype_costs_idx on public.prototype_costs (prototype_id);

create table public.samples (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  project_id   uuid not null references public.development_projects(id) on delete cascade,
  version_no   int not null check (version_no >= 1),
  prototype_id uuid references public.prototypes(id) on delete set null,
  status       text not null default 'planned' check (status in ('planned','in_progress','sent','approved','rejected','revision')),
  qty          int not null default 1 check (qty > 0 and qty <= 10000),
  size_label   text check (size_label is null or length(size_label) <= 12),
  color        text check (color is null or length(color) <= 60),
  due_date     date,
  sent_on      date,
  tracking     text check (tracking is null or length(tracking) <= 80),
  notes        text check (notes is null or length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  unique (project_id, version_no)
);

create table public.customer_validations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  project_id       uuid not null references public.development_projects(id) on delete cascade,
  kind             text not null check (kind in ('sample','bat')),
  sample_id        uuid references public.samples(id) on delete cascade,
  version_no       int not null check (version_no >= 1),                    -- numéro par projet et par type (BAT v1, v2…)
  status           text not null default 'pending' check (status in ('pending','approved','rejected','changes_requested')),
  submitted_on     date not null default current_date,
  due_date         date,                                                    -- réponse attendue avant
  decided_on       date,
  decided_by_name  text check (decided_by_name is null or length(decided_by_name) <= 120),
  comment          text check (comment is null or length(comment) <= 1000),
  reminder_count   int not null default 0,
  last_reminder_on date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  unique (project_id, kind, version_no),
  constraint cv_sample_ck check ((kind = 'sample') = (sample_id is not null)),
  constraint cv_dates_ck check (due_date is null or due_date >= submitted_on)
);
create unique index cv_one_pending_uq on public.customer_validations (project_id, kind, coalesce(sample_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'pending';
create index cv_pending_idx on public.customer_validations (company_id, status, due_date);

create table public.industrialization (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  project_id     uuid not null unique references public.development_projects(id) on delete cascade,
  status         text not null default 'not_started' check (status in ('not_started','in_progress','ready','released')),
  checklist      jsonb not null default '[]'::jsonb,
  target_date    date,
  pilot_qty      int check (pilot_qty is null or pilot_qty > 0),
  lead_time_days int check (lead_time_days is null or lead_time_days between 0 and 1000),
  bom_id         uuid references public.boms(id) on delete set null,
  notes          text check (notes is null or length(notes) <= 2000),
  ready_at       timestamptz,
  released_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);

create table public.development_exchanges (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  project_id    uuid not null references public.development_projects(id) on delete cascade,
  direction     text not null check (direction in ('inbound','outbound','internal')),
  channel       text not null default 'email' check (channel in ('email','phone','meeting','portal','message','other')),
  subject       text not null check (length(btrim(subject)) between 1 and 160),
  body          text check (body is null or length(body) <= 4000),
  contact_name  text check (contact_name is null or length(contact_name) <= 120),
  exchanged_on  date not null default current_date,
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index dev_exchanges_idx on public.development_exchanges (project_id, exchanged_on desc, created_at desc);

create table public.development_documents (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  project_id      uuid not null references public.development_projects(id) on delete cascade,
  ged_document_id uuid not null references public.ged_documents(id) on delete cascade,
  kind            text not null default 'other' check (kind in ('request','tech_pack','photo','bat','sample_report','approval','other')),
  note            text check (note is null or length(note) <= 300),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  unique (project_id, ged_document_id)
);

-- ---------------------------------------------------------------------
-- 3. Outils internes
-- ---------------------------------------------------------------------
create function private.dev_flag() returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting('dev.rpc', true), 'off') = 'on' $$;

create function private.dev_meta(p_client uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('client_id', p_client, 'client_name', (select name from public.clients where id = p_client)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.dev_meta(uuid, jsonb) from public, anon, authenticated;

-- Projet modifiable : trouvé, client ouvert, projet ni annulé ni terminé (sauf p_allow_closed)
create function private.dev_assert_open(p_project uuid, p_allow_closed boolean default false) returns public.development_projects
language plpgsql stable security definer set search_path = '' as $$
declare v public.development_projects%rowtype;
begin
  select * into v from public.development_projects where id = p_project;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(v.client_id);
  if v.status in ('cancelled', 'completed') and not p_allow_closed and not private.dev_flag() then raise exception 'DEV_PROJECT_CLOSED' using errcode = '55000'; end if;
  return v;
end $$;
revoke execute on function private.dev_assert_open(uuid, boolean) from public, anon, authenticated;

create function private.dev_default_checklist() returns jsonb
language sql immutable set search_path = '' as $$
  select '[{"key":"pattern","label":"Patronage gradué validé","done":false},{"key":"bom","label":"Nomenclature (BOM) validée","done":false},
           {"key":"routing","label":"Gamme opératoire et temps validés","done":false},{"key":"sourcing","label":"Approvisionnement des matières confirmé","done":false},
           {"key":"marker","label":"Plan de coupe / marqueur validé","done":false},{"key":"pilot","label":"Série pilote réalisée","done":false},
           {"key":"quality","label":"Plan de contrôle qualité défini","done":false},{"key":"packaging","label":"Packaging et étiquetage prêts","done":false}]'::jsonb
$$;

create function private.dev_checklist_valid(c jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare e jsonb;
begin
  if coalesce(jsonb_typeof(c), '') <> 'array' or jsonb_array_length(c) > 30 then return false; end if;
  for e in select * from jsonb_array_elements(c) loop
    if jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e ->> 'key', '')), '') is null or length(e ->> 'key') > 40
       or nullif(btrim(coalesce(e ->> 'label', '')), '') is null or length(e ->> 'label') > 160 or jsonb_typeof(e -> 'done') <> 'boolean' then return false; end if;
  end loop;
  return (select count(distinct x ->> 'key') from jsonb_array_elements(c) x) = jsonb_array_length(c);
end $$;
alter table public.industrialization add constraint industrialization_checklist_ck check (private.dev_checklist_valid(checklist));

-- ---------------------------------------------------------------------
-- 4. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.dev_projects_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    perform private.ged_assert_client_open(new.client_id);
    select company_id into new.company_id from public.clients where id = new.client_id;
    v_n := private.next_seq(new.company_id, 'dev');
    new.code := 'DEV-' || lpad(v_n::text, 4, '0');
    new.stage := 'request'; new.status := 'active'; new.stage_changed_at := now(); new.closed_at := null; new.hold_reason := null;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
  elsif not private.dev_flag() then
    if new.client_id is distinct from old.client_id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
       or new.stage is distinct from old.stage or new.status is distinct from old.status or new.stage_changed_at is distinct from old.stage_changed_at
       or new.closed_at is distinct from old.closed_at or new.hold_reason is distinct from old.hold_reason then
      raise exception 'DEV_REF_LOCKED' using errcode = '42501';
    end if;
    perform private.ged_assert_client_open(new.client_id);
    if old.status in ('cancelled', 'completed') then raise exception 'DEV_PROJECT_CLOSED' using errcode = '55000'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  if new.product_id is not null and (tg_op = 'INSERT' or new.product_id is distinct from old.product_id) then
    if not exists (select 1 from public.product_master p where p.id = new.product_id and p.client_id = new.client_id) then
      raise exception 'DEV_BAD_PRODUCT' using errcode = '22023';       -- la fiche produit doit appartenir au même client
    end if;
  end if;
  new.name := btrim(new.name);
  return new;
end $$;
create trigger dev_projects_before_iu before insert or update on public.development_projects
  for each row execute function private.dev_projects_before();

create function private.dev_projects_seed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('dev.rpc', true), 'off');
begin
  perform set_config('dev.rpc', 'on', true);
  insert into public.industrialization (company_id, project_id, checklist) values (new.company_id, new.id, private.dev_default_checklist());
  perform set_config('dev.rpc', v_prev, true);
  return new;
end $$;
create trigger dev_projects_seed_i after insert on public.development_projects
  for each row execute function private.dev_projects_seed();

create function private.dev_prototypes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'INSERT' then
    p := private.dev_assert_open(new.project_id);
    perform pg_advisory_xact_lock(hashtext(new.project_id::text));
    new.company_id := p.company_id;
    new.version_no := coalesce((select max(version_no) from public.prototypes where project_id = new.project_id), 0) + 1;
    new.status := 'planned'; new.started_on := null; new.completed_on := null; new.feedback := null; new.created_by := auth.uid();
  else
    if not private.dev_flag() then
      perform private.dev_assert_open(new.project_id);
      if new.project_id is distinct from old.project_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.completed_on is distinct from old.completed_on or new.feedback is distinct from old.feedback then
        raise exception 'DEV_REF_LOCKED' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger dev_prototypes_before_iu before insert or update on public.prototypes
  for each row execute function private.dev_prototypes_before();

create function private.dev_costs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype; proto public.prototypes%rowtype;
begin
  if tg_op = 'DELETE' then
    if not private.dev_flag() then perform private.dev_assert_open(old.project_id); end if;
    return old;
  end if;
  select * into proto from public.prototypes where id = new.prototype_id;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(proto.project_id);
  new.company_id := p.company_id; new.project_id := proto.project_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid();
  elsif new.prototype_id is distinct from old.prototype_id then raise exception 'DEV_REF_LOCKED' using errcode = '42501'; end if;
  return new;
end $$;
create trigger dev_costs_before_iud before insert or update or delete on public.prototype_costs
  for each row execute function private.dev_costs_before();

create function private.dev_samples_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'INSERT' then
    p := private.dev_assert_open(new.project_id);
    perform pg_advisory_xact_lock(hashtext(new.project_id::text));
    new.company_id := p.company_id;
    new.version_no := coalesce((select max(version_no) from public.samples where project_id = new.project_id), 0) + 1;
    new.status := 'planned'; new.sent_on := null; new.created_by := auth.uid();
  else
    if not private.dev_flag() then
      perform private.dev_assert_open(new.project_id);
      if new.project_id is distinct from old.project_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.sent_on is distinct from old.sent_on or new.tracking is distinct from old.tracking then
        raise exception 'DEV_REF_LOCKED' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
  end if;
  if new.prototype_id is not null and (tg_op = 'INSERT' or new.prototype_id is distinct from old.prototype_id) then
    if not exists (select 1 from public.prototypes x where x.id = new.prototype_id and x.project_id = new.project_id) then
      raise exception 'DEV_BAD_PROTOTYPE' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger dev_samples_before_iu before insert or update on public.samples
  for each row execute function private.dev_samples_before();

create function private.dev_validations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype; s public.samples%rowtype;
begin
  if tg_op = 'INSERT' then
    p := private.dev_assert_open(new.project_id);
    perform pg_advisory_xact_lock(hashtext(new.project_id::text));
    new.company_id := p.company_id;
    if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
    if new.kind = 'sample' then
      select * into s from public.samples where id = new.sample_id and project_id = new.project_id;
      if not found then raise exception 'DEV_BAD_SAMPLE' using errcode = '22023'; end if;
      if s.status not in ('in_progress', 'sent') then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
    elsif p.stage not in ('bat', 'validation') then
      raise exception 'DEV_BAD_STAGE' using errcode = '55000';          -- un BAT se soumet aux étapes BAT / Validation client
    end if;
    new.version_no := coalesce((select max(version_no) from public.customer_validations where project_id = new.project_id and kind = new.kind), 0) + 1;
    new.status := 'pending'; new.decided_on := null; new.decided_by_name := null; new.reminder_count := 0; new.last_reminder_on := null; new.created_by := auth.uid();
  else
    if not private.dev_flag() then
      perform private.dev_assert_open(new.project_id);
      if new.project_id is distinct from old.project_id or new.kind is distinct from old.kind or new.sample_id is distinct from old.sample_id or new.version_no is distinct from old.version_no
         or new.status is distinct from old.status or new.decided_on is distinct from old.decided_on or new.decided_by_name is distinct from old.decided_by_name
         or new.submitted_on is distinct from old.submitted_on or new.reminder_count is distinct from old.reminder_count or new.last_reminder_on is distinct from old.last_reminder_on then
        raise exception 'DEV_REF_LOCKED' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger dev_validations_before_iu before insert or update on public.customer_validations
  for each row execute function private.dev_validations_before();

-- Soumettre un échantillon au client = il est « envoyé »
create function private.dev_validations_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('dev.rpc', true), 'off');
begin
  if new.kind = 'sample' then
    perform set_config('dev.rpc', 'on', true);
    update public.samples set status = 'sent', sent_on = coalesce(sent_on, new.submitted_on) where id = new.sample_id and status <> 'sent';
    perform set_config('dev.rpc', v_prev, true);
  end if;
  return new;
end $$;
create trigger dev_validations_after_i after insert on public.customer_validations
  for each row execute function private.dev_validations_after();

create function private.dev_industrialization_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'UPDATE' and not private.dev_flag() then
    p := private.dev_assert_open(new.project_id);
    if new.project_id is distinct from old.project_id or new.status is distinct from old.status or new.ready_at is distinct from old.ready_at or new.released_at is distinct from old.released_at then
      raise exception 'DEV_REF_LOCKED' using errcode = '42501';
    end if;
    if new.bom_id is not null and new.bom_id is distinct from old.bom_id and not exists (
        select 1 from public.boms b join public.articles a on a.id = b.article_id where b.id = new.bom_id and a.client_id = p.client_id) then
      raise exception 'DEV_BAD_BOM' using errcode = '22023';          -- nomenclature d'un article du même client
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger dev_industrialization_before_u before update on public.industrialization
  for each row execute function private.dev_industrialization_before();

create function private.dev_exchanges_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  p := private.dev_assert_open(new.project_id, true);       -- les échanges restent saisissables après clôture
  new.company_id := p.company_id; new.created_by := auth.uid();
  return new;
end $$;
create trigger dev_exchanges_before_i before insert on public.development_exchanges
  for each row execute function private.dev_exchanges_before();

create function private.dev_documents_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype;
begin
  if tg_op = 'DELETE' then return old; end if;
  p := private.dev_assert_open(new.project_id, true);
  new.company_id := p.company_id;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.ged_documents g where g.id = new.ged_document_id and g.client_id = p.client_id and g.deleted_at is null) then
      raise exception 'DEV_BAD_DOCUMENT' using errcode = '22023';
    end if;
  elsif new.project_id is distinct from old.project_id or new.ged_document_id is distinct from old.ged_document_id then
    raise exception 'DEV_REF_LOCKED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger dev_documents_before_iud before insert or update or delete on public.development_documents
  for each row execute function private.dev_documents_before();

-- ---------------------------------------------------------------------
-- 5. Historique (audit_logs, entity_type = 'dev_project') — aucun montant de coût dans l'historique
-- ---------------------------------------------------------------------
create function private.audit_dev_projects() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.dev_flag() then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.create', 'dev_project', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'priority', new.priority, 'due_date', new.due_date), private.dev_meta(new.client_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name','family','description','priority','owner_id','due_date','target_qty','product_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'dev.update', 'dev_project', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', private.dev_meta(new.client_id));
    end if;
  end if;
  return new;
end $$;
create trigger audit_dev_projects_iu after insert or update on public.development_projects
  for each row execute function private.audit_dev_projects();

create function private.audit_dev_prototypes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid; v_chg jsonb;
begin
  if private.dev_flag() then return new; end if;
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.prototype_add', 'dev_project', new.project_id::text, v_code, null, null, private.dev_meta(v_client, jsonb_build_object('version', new.version_no, 'name', new.name)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','description','owner_id','due_date','started_on')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'dev.prototype_update', 'dev_project', new.project_id::text, v_code, v_chg -> 'before', v_chg -> 'after', private.dev_meta(v_client, jsonb_build_object('version', new.version_no)));
    end if;
  end if;
  return new;
end $$;
create trigger audit_dev_prototypes_iu after insert or update on public.prototypes
  for each row execute function private.audit_dev_prototypes();

create function private.audit_dev_costs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.prototype_costs%rowtype; v_code text; v_client uuid; v_ver int;
begin
  if private.dev_flag() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code, client_id into v_code, v_client from public.development_projects where id = r.project_id;
  select version_no into v_ver from public.prototypes where id = r.prototype_id;
  perform private.write_audit(r.company_id, case tg_op when 'INSERT' then 'dev.cost_add' when 'UPDATE' then 'dev.cost_update' else 'dev.cost_delete' end,
    'dev_project', r.project_id::text, v_code, null, null,
    private.dev_meta(v_client, jsonb_build_object('prototype', v_ver, 'kind', r.kind, 'description', r.description)));   -- volontairement sans montant
  return coalesce(new, old);
end $$;
create trigger audit_dev_costs_iud after insert or update or delete on public.prototype_costs
  for each row execute function private.audit_dev_costs();

create function private.audit_dev_samples() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid; v_chg jsonb;
begin
  if private.dev_flag() then return new; end if;
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.sample_add', 'dev_project', new.project_id::text, v_code, null, null, private.dev_meta(v_client, jsonb_build_object('version', new.version_no, 'qty', new.qty)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('qty','size_label','color','due_date','notes','prototype_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'dev.sample_update', 'dev_project', new.project_id::text, v_code, v_chg -> 'before', v_chg -> 'after', private.dev_meta(v_client, jsonb_build_object('version', new.version_no)));
    end if;
  end if;
  return new;
end $$;
create trigger audit_dev_samples_iu after insert or update on public.samples
  for each row execute function private.audit_dev_samples();

create function private.audit_dev_validations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid;
begin
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'dev.validation_submit', 'dev_project', new.project_id::text, v_code, null, null,
      private.dev_meta(v_client, jsonb_build_object('kind', new.kind, 'version', new.version_no, 'due_date', new.due_date)));
  elsif not private.dev_flag() and new.due_date is distinct from old.due_date then
    perform private.write_audit(new.company_id, 'dev.validation_update', 'dev_project', new.project_id::text, v_code,
      jsonb_build_object('due_date', old.due_date), jsonb_build_object('due_date', new.due_date), private.dev_meta(v_client, jsonb_build_object('kind', new.kind, 'version', new.version_no)));
  end if;
  return new;
end $$;
create trigger audit_dev_validations_iu after insert or update on public.customer_validations
  for each row execute function private.audit_dev_validations();

create function private.audit_dev_exchanges() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid;
begin
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  perform private.write_audit(new.company_id, 'dev.exchange_add', 'dev_project', new.project_id::text, v_code, null, null,
    private.dev_meta(v_client, jsonb_build_object('subject', new.subject, 'direction', new.direction, 'channel', new.channel)));
  return new;
end $$;
create trigger audit_dev_exchanges_i after insert on public.development_exchanges
  for each row execute function private.audit_dev_exchanges();

create function private.audit_dev_documents() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.development_documents%rowtype; v_code text; v_client uuid; v_title text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select code, client_id into v_code, v_client from public.development_projects where id = r.project_id;
  if v_code is null then return coalesce(new, old); end if;           -- suppression en cascade du projet
  select title into v_title from public.ged_documents where id = r.ged_document_id;
  perform private.write_audit(r.company_id, case tg_op when 'INSERT' then 'dev.document_link' else 'dev.document_unlink' end, 'dev_project', r.project_id::text, v_code, null, null,
    private.dev_meta(v_client, jsonb_build_object('document', v_title, 'kind', r.kind, 'document_id', r.ged_document_id)));
  return coalesce(new, old);
end $$;
create trigger audit_dev_documents_id after insert or delete on public.development_documents
  for each row execute function private.audit_dev_documents();

create function private.audit_dev_industrialization() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_client uuid; v_toggled jsonb;
begin
  if private.dev_flag() then return new; end if;
  select code, client_id into v_code, v_client from public.development_projects where id = new.project_id;
  select coalesce(jsonb_agg(jsonb_build_object('label', n ->> 'label', 'done', (n -> 'done')::boolean)), '[]'::jsonb) into v_toggled
  from jsonb_array_elements(new.checklist) n
  where coalesce((select (o -> 'done')::boolean from jsonb_array_elements(old.checklist) o where o ->> 'key' = n ->> 'key'), false) <> (n -> 'done')::boolean;
  if jsonb_array_length(v_toggled) > 0 or new.target_date is distinct from old.target_date or new.pilot_qty is distinct from old.pilot_qty
     or new.lead_time_days is distinct from old.lead_time_days or new.bom_id is distinct from old.bom_id or new.notes is distinct from old.notes then
    perform private.write_audit(new.company_id, 'dev.industrialization_update', 'dev_project', new.project_id::text, v_code,
      jsonb_build_object('target_date', old.target_date, 'pilot_qty', old.pilot_qty, 'lead_time_days', old.lead_time_days),
      jsonb_build_object('target_date', new.target_date, 'pilot_qty', new.pilot_qty, 'lead_time_days', new.lead_time_days),
      private.dev_meta(v_client, jsonb_build_object('toggled', v_toggled,
        'done', (select count(*) from jsonb_array_elements(new.checklist) x where (x -> 'done')::boolean), 'total', jsonb_array_length(new.checklist))));
  end if;
  return new;
end $$;
create trigger audit_dev_industrialization_u after update on public.industrialization
  for each row execute function private.audit_dev_industrialization();

create policy audit_logs_select_dev on public.audit_logs for select to authenticated
  using (entity_type = 'dev_project' and company_id = private.current_company() and private.has_perm('development.read'));

-- ---------------------------------------------------------------------
-- 6. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.development_projects  enable row level security;
alter table public.prototypes            enable row level security;
alter table public.prototype_costs       enable row level security;
alter table public.samples               enable row level security;
alter table public.customer_validations  enable row level security;
alter table public.industrialization     enable row level security;
alter table public.development_exchanges enable row level security;
alter table public.development_documents enable row level security;

revoke all on public.development_projects, public.prototypes, public.prototype_costs, public.samples, public.customer_validations,
              public.industrialization, public.development_exchanges, public.development_documents from anon, authenticated;
grant all on public.development_projects, public.prototypes, public.prototype_costs, public.samples, public.customer_validations,
             public.industrialization, public.development_exchanges, public.development_documents to service_role;
grant select on public.development_projects, public.prototypes, public.prototype_costs, public.samples, public.customer_validations,
                public.industrialization, public.development_exchanges, public.development_documents to authenticated;
grant insert (client_id, name, family, description, priority, owner_id, requested_on, due_date, target_qty, product_id) on public.development_projects to authenticated;
grant update (name, family, description, priority, owner_id, due_date, target_qty, product_id) on public.development_projects to authenticated;
grant insert (project_id, name, description, owner_id, due_date) on public.prototypes to authenticated;
grant update (name, description, owner_id, due_date, started_on) on public.prototypes to authenticated;
grant insert (prototype_id, kind, description, quantity, unit_cost, incurred_on) on public.prototype_costs to authenticated;
grant update (kind, description, quantity, unit_cost, incurred_on) on public.prototype_costs to authenticated;
grant delete on public.prototype_costs to authenticated;
grant insert (project_id, prototype_id, qty, size_label, color, due_date, notes) on public.samples to authenticated;
grant update (prototype_id, qty, size_label, color, due_date, notes) on public.samples to authenticated;
grant insert (project_id, kind, sample_id, due_date, comment) on public.customer_validations to authenticated;
grant update (due_date) on public.customer_validations to authenticated;
grant update (checklist, target_date, pilot_qty, lead_time_days, bom_id, notes) on public.industrialization to authenticated;
grant insert (project_id, direction, channel, subject, body, contact_name, exchanged_on) on public.development_exchanges to authenticated;
grant insert (project_id, ged_document_id, kind, note) on public.development_documents to authenticated;
grant update (kind, note) on public.development_documents to authenticated;
grant delete on public.development_documents to authenticated;

create policy dev_projects_select on public.development_projects for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_projects_insert on public.development_projects for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_projects_update on public.development_projects for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_prototypes_select on public.prototypes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_prototypes_insert on public.prototypes for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_prototypes_update on public.prototypes for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

-- Coûts : lecture costs.read (finance…) ou development.costs ; écriture development.costs uniquement
create policy dev_costs_select on public.prototype_costs for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('development.costs') or private.has_perm('costs.read')));
create policy dev_costs_insert on public.prototype_costs for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.costs'));
create policy dev_costs_update on public.prototype_costs for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.costs'))
  with check (company_id = private.current_company() and private.has_perm('development.costs'));
create policy dev_costs_delete on public.prototype_costs for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('development.costs'));

create policy dev_samples_select on public.samples for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_samples_insert on public.samples for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_samples_update on public.samples for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_validations_select on public.customer_validations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_validations_insert on public.customer_validations for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_validations_update on public.customer_validations for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write') and status = 'pending')
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_ind_select on public.industrialization for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_ind_update on public.industrialization for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_exchanges_select on public.development_exchanges for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_exchanges_insert on public.development_exchanges for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write'));

create policy dev_documents_select on public.development_documents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('development.read'));
create policy dev_documents_insert on public.development_documents for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('development.write')
              and exists (select 1 from public.ged_documents g where g.id = ged_document_id));
create policy dev_documents_update on public.development_documents for update to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'))
  with check (company_id = private.current_company() and private.has_perm('development.write'));
create policy dev_documents_delete on public.development_documents for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('development.write'));

-- ---------------------------------------------------------------------
-- 7. RPC : avancement du projet, statut, prototypes, échantillons, validations, industrialisation
-- ---------------------------------------------------------------------
create function public.dev_project_advance(p_project uuid, p_to text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.development_projects%rowtype; ind public.industrialization%rowtype; v_prod public.product_master%rowtype;
  v_seq constant text[] := array['request','project','prototype','sample','bat','validation','industrialization','production'];
  v_from int; v_to int; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('development.write');
  select * into p from public.development_projects where id = p_project and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(p.client_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  v_from := array_position(v_seq, p.stage); v_to := array_position(v_seq, p_to);
  if v_to is null or v_to = v_from then raise exception 'DEV_BAD_STAGE' using errcode = '22023'; end if;
  select * into ind from public.industrialization where project_id = p_project for update;

  if v_to < v_from then
    if v_reason is null or length(v_reason) < 3 then raise exception 'DEV_REASON_REQUIRED' using errcode = '22023'; end if;
  elsif v_to > v_from + 1 then
    raise exception 'DEV_STAGE_SKIP' using errcode = '55000';
  else
    case p.stage
      when 'prototype' then
        if not exists (select 1 from public.prototypes where project_id = p_project and status = 'approved') then raise exception 'DEV_GATE_PROTOTYPE' using errcode = '55000'; end if;
      when 'sample' then
        if not exists (select 1 from public.samples where project_id = p_project and status = 'approved') then raise exception 'DEV_GATE_SAMPLE' using errcode = '55000'; end if;
      when 'bat' then
        if not exists (select 1 from public.customer_validations where project_id = p_project and kind = 'bat') then raise exception 'DEV_GATE_BAT' using errcode = '55000'; end if;
      when 'validation' then
        if coalesce((select status from public.customer_validations where project_id = p_project and kind = 'bat' order by version_no desc limit 1), '') <> 'approved' then
          raise exception 'DEV_GATE_VALIDATION' using errcode = '55000';
        end if;
      when 'industrialization' then
        if ind.status <> 'ready' then raise exception 'DEV_GATE_INDUSTRIALIZATION' using errcode = '55000'; end if;
        if p.product_id is not null then
          select * into v_prod from public.product_master where id = p.product_id;
          if v_prod.active_version_id is null then raise exception 'DEV_PRODUCT_NOT_VALIDATED' using errcode = '55000'; end if;
        end if;
      else null;
    end case;
  end if;

  perform set_config('dev.rpc', 'on', true);
  update public.development_projects set stage = p_to, stage_changed_at = now() where id = p_project;
  if p_to = 'industrialization' and ind.status = 'not_started' then
    update public.industrialization set status = 'in_progress' where project_id = p_project;
  elsif p_to = 'production' then
    update public.industrialization set status = 'released', released_at = now() where project_id = p_project;
  elsif v_from = 8 and ind.status = 'released' then
    update public.industrialization set status = 'ready', released_at = null where project_id = p_project;
  end if;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'dev.stage', 'dev_project', p.id::text, p.code, jsonb_build_object('stage', p.stage), jsonb_build_object('stage', p_to),
    private.dev_meta(p.client_id, jsonb_build_object('reason', v_reason, 'backward', v_to < v_from)), 'rpc');
end $$;

create function public.dev_project_set_status(p_project uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.development_projects%rowtype; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('development.write');
  select * into p from public.development_projects where id = p_project and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.ged_assert_client_open(p.client_id);
  if p.status in ('cancelled', 'completed') then raise exception 'DEV_PROJECT_CLOSED' using errcode = '55000'; end if;
  if p_status not in ('active', 'on_hold', 'cancelled', 'completed') or p_status = p.status then raise exception 'DEV_BAD_STATUS' using errcode = '22023'; end if;
  if p_status = 'cancelled' and (v_reason is null or length(v_reason) < 3) then raise exception 'DEV_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_status = 'completed' and p.stage <> 'production' then raise exception 'DEV_GATE_COMPLETE' using errcode = '55000'; end if;
  perform set_config('dev.rpc', 'on', true);
  update public.development_projects set status = p_status, hold_reason = case when p_status in ('on_hold', 'cancelled') then v_reason else null end,
         closed_at = case when p_status in ('cancelled', 'completed') then now() else null end where id = p_project;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'dev.status', 'dev_project', p.id::text, p.code, jsonb_build_object('status', p.status), jsonb_build_object('status', p_status),
    private.dev_meta(p.client_id, jsonb_build_object('reason', v_reason)), 'rpc');
end $$;

create function public.dev_prototype_set_status(p_prototype uuid, p_status text, p_feedback text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.prototypes%rowtype; p public.development_projects%rowtype; v_fb text := nullif(btrim(coalesce(p_feedback, '')), '');
begin
  perform private.require_perm('development.write');
  select * into x from public.prototypes where id = p_prototype and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(x.project_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  if not ((x.status = 'planned' and p_status in ('in_progress', 'rejected')) or (x.status = 'in_progress' and p_status in ('ready', 'rejected'))
          or (x.status = 'ready' and p_status in ('approved', 'rejected', 'in_progress'))) then
    raise exception 'DEV_BAD_STATUS' using errcode = '55000';
  end if;
  perform set_config('dev.rpc', 'on', true);
  update public.prototypes set status = p_status, feedback = coalesce(v_fb, feedback),
         started_on = case when p_status = 'in_progress' then coalesce(started_on, current_date) else started_on end,
         completed_on = case when p_status in ('ready', 'approved', 'rejected') then current_date when p_status = 'in_progress' then null else completed_on end
  where id = p_prototype;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(x.company_id, 'dev.prototype_status', 'dev_project', x.project_id::text, p.code, jsonb_build_object('status', x.status), jsonb_build_object('status', p_status),
    private.dev_meta(p.client_id, jsonb_build_object('version', x.version_no, 'feedback', v_fb)), 'rpc');
end $$;

create function public.dev_sample_set_status(p_sample uuid, p_status text, p_tracking text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.samples%rowtype; p public.development_projects%rowtype; v_trk text := nullif(btrim(coalesce(p_tracking, '')), '');
begin
  perform private.require_perm('development.write');
  select * into x from public.samples where id = p_sample and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(x.project_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  if not ((x.status in ('planned', 'revision', 'rejected') and p_status = 'in_progress') or (x.status = 'in_progress' and p_status = 'sent')) then
    raise exception 'DEV_BAD_STATUS' using errcode = '55000';
  end if;
  perform set_config('dev.rpc', 'on', true);
  update public.samples set status = p_status, tracking = case when p_status = 'sent' then coalesce(v_trk, tracking) else tracking end,
         sent_on = case when p_status = 'sent' then coalesce(sent_on, current_date) else sent_on end where id = p_sample;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(x.company_id, 'dev.sample_status', 'dev_project', x.project_id::text, p.code, jsonb_build_object('status', x.status), jsonb_build_object('status', p_status),
    private.dev_meta(p.client_id, jsonb_build_object('version', x.version_no, 'tracking', v_trk)), 'rpc');
end $$;

-- Décision du client (échantillon ou BAT)
create function public.dev_validation_decide(p_validation uuid, p_decision text, p_comment text default null, p_contact text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.customer_validations%rowtype; p public.development_projects%rowtype; s public.samples%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), ''); v_sample_status text;
begin
  perform private.require_perm('development.write');
  select * into v from public.customer_validations where id = p_validation and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(v.project_id);
  if p.status <> 'active' then raise exception 'DEV_PROJECT_NOT_ACTIVE' using errcode = '55000'; end if;
  if v.status <> 'pending' then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
  if p_decision not in ('approved', 'rejected', 'changes_requested') then raise exception 'DEV_BAD_STATUS' using errcode = '22023'; end if;
  if p_decision <> 'approved' and v_comment is null then raise exception 'DEV_COMMENT_REQUIRED' using errcode = '22023'; end if;
  perform set_config('dev.rpc', 'on', true);
  update public.customer_validations set status = p_decision, decided_on = current_date, comment = coalesce(v_comment, comment),
         decided_by_name = nullif(btrim(coalesce(p_contact, '')), '') where id = p_validation;
  if v.kind = 'sample' then
    v_sample_status := case p_decision when 'approved' then 'approved' when 'rejected' then 'rejected' else 'revision' end;
    update public.samples set status = v_sample_status where id = v.sample_id;
  end if;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'dev.validation_decide', 'dev_project', v.project_id::text, p.code, jsonb_build_object('status', 'pending'), jsonb_build_object('status', p_decision),
    private.dev_meta(p.client_id, jsonb_build_object('kind', v.kind, 'version', v.version_no, 'comment', v_comment, 'contact', nullif(btrim(coalesce(p_contact, '')), ''))), 'rpc');
end $$;

-- Relance du client (trace + compteur)
create function public.dev_validation_remind(p_validation uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.customer_validations%rowtype; p public.development_projects%rowtype;
begin
  perform private.require_perm('development.write');
  select * into v from public.customer_validations where id = p_validation and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(v.project_id);
  if v.status <> 'pending' then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('dev.rpc', 'on', true);
  update public.customer_validations set reminder_count = reminder_count + 1, last_reminder_on = current_date where id = p_validation;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'dev.validation_remind', 'dev_project', v.project_id::text, p.code, null, null,
    private.dev_meta(p.client_id, jsonb_build_object('kind', v.kind, 'version', v.version_no, 'reminder', v.reminder_count + 1, 'note', nullif(btrim(coalesce(p_note, '')), ''))), 'rpc');
end $$;

create function public.dev_industrialization_set_status(p_project uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare ind public.industrialization%rowtype; p public.development_projects%rowtype;
begin
  perform private.require_perm('development.write');
  select * into ind from public.industrialization where project_id = p_project and company_id = private.current_company() for update;
  if not found then raise exception 'DEV_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.dev_assert_open(p_project);
  if ind.status = 'released' or p_status not in ('not_started', 'in_progress', 'ready') or p_status = ind.status then raise exception 'DEV_BAD_STATUS' using errcode = '55000'; end if;
  if p_status = 'ready' and (jsonb_array_length(ind.checklist) = 0 or exists (select 1 from jsonb_array_elements(ind.checklist) x where not (x -> 'done')::boolean)) then
    raise exception 'DEV_CHECKLIST_INCOMPLETE' using errcode = '55000';
  end if;
  perform set_config('dev.rpc', 'on', true);
  update public.industrialization set status = p_status, ready_at = case when p_status = 'ready' then now() else null end where project_id = p_project;
  perform set_config('dev.rpc', 'off', true);
  perform private.write_audit(ind.company_id, 'dev.industrialization_status', 'dev_project', p_project::text, p.code, jsonb_build_object('status', ind.status), jsonb_build_object('status', p_status), private.dev_meta(p.client_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Alertes de validation et tableau de bord
-- ---------------------------------------------------------------------
create function public.development_alerts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_out jsonb;
begin
  perform private.require_perm('development.read');
  with a as (
    -- validations client en retard / proche / sans réponse
    select case when v.due_date < current_date then 'validation_overdue' when v.due_date <= current_date + 3 then 'validation_due_soon' else 'validation_stale' end as type,
           case when v.due_date < current_date then 'high' else 'medium' end as severity,
           p.id as project_id, p.code, p.name, c.name as client_name, v.id as ref_id,
           (case v.kind when 'bat' then 'BAT v' else 'Échantillon (validation) v' end || v.version_no) as ref,
           v.due_date as due_date, v.submitted_on as since,
           (current_date - coalesce(v.due_date, v.submitted_on))::int as days, v.reminder_count as reminders
    from public.customer_validations v join public.development_projects p on p.id = v.project_id join public.clients c on c.id = p.client_id
    where v.company_id = v_co and v.status = 'pending' and p.status = 'active'
      and (v.due_date <= current_date + 3 or (v.due_date is null and v.submitted_on <= current_date - 7))
    union all
    select 'project_overdue', 'high', p.id, p.code, p.name, c.name, null, ('Échéance du projet (' || p.stage || ')'), p.due_date, null, (current_date - p.due_date)::int, 0
    from public.development_projects p join public.clients c on c.id = p.client_id
    where p.company_id = v_co and p.status = 'active' and p.stage <> 'production' and p.due_date < current_date
    union all
    select 'prototype_overdue', 'medium', p.id, p.code, p.name, c.name, x.id, 'Prototype v' || x.version_no, x.due_date, null, (current_date - x.due_date)::int, 0
    from public.prototypes x join public.development_projects p on p.id = x.project_id join public.clients c on c.id = p.client_id
    where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress') and x.due_date < current_date
    union all
    select 'sample_overdue', 'medium', p.id, p.code, p.name, c.name, x.id, 'Échantillon v' || x.version_no, x.due_date, null, (current_date - x.due_date)::int, 0
    from public.samples x join public.development_projects p on p.id = x.project_id join public.clients c on c.id = p.client_id
    where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress') and x.due_date < current_date
    union all
    select 'stage_stuck', 'low', p.id, p.code, p.name, c.name, null, ('Étape « ' || p.stage || ' » depuis ' || (current_date - p.stage_changed_at::date) || ' j'), null, p.stage_changed_at::date, (current_date - p.stage_changed_at::date)::int, 0
    from public.development_projects p join public.clients c on c.id = p.client_id
    where p.company_id = v_co and p.status = 'active' and p.stage not in ('production') and p.stage_changed_at < now() - interval '21 days'
  )
  select coalesce(jsonb_agg(to_jsonb(a) order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, days desc, code), '[]'::jsonb) into v_out from a;
  return v_out;
end $$;

create function public.development_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_out jsonb; v_costs boolean := private.has_perm('development.costs') or private.has_perm('costs.read');
begin
  perform private.require_perm('development.read');
  v_out := jsonb_build_object(
    'by_stage', (select coalesce(jsonb_agg(jsonb_build_object('stage', s, 'count', (select count(*) from public.development_projects p where p.company_id = v_co and p.stage = s and p.status in ('active', 'on_hold')))
                  order by o), '[]'::jsonb)
                 from unnest(array['request','project','prototype','sample','bat','validation','industrialization','production']) with ordinality as t(s, o)),
    'projects', jsonb_build_object(
      'active',    (select count(*) from public.development_projects where company_id = v_co and status = 'active'),
      'on_hold',   (select count(*) from public.development_projects where company_id = v_co and status = 'on_hold'),
      'completed', (select count(*) from public.development_projects where company_id = v_co and status = 'completed'),
      'cancelled', (select count(*) from public.development_projects where company_id = v_co and status = 'cancelled'),
      'overdue',   (select count(*) from public.development_projects where company_id = v_co and status = 'active' and stage <> 'production' and due_date < current_date),
      'in_production', (select count(*) from public.development_projects where company_id = v_co and stage = 'production' and status in ('active', 'completed')),
      'avg_cycle_days', (select round(avg(extract(epoch from (stage_changed_at - created_at)) / 86400)::numeric, 1) from public.development_projects where company_id = v_co and stage = 'production' and status in ('active', 'completed')),
      'success_rate', (select case when count(*) filter (where status <> 'active' or stage = 'production') = 0 then null
                         else round(100.0 * count(*) filter (where stage = 'production' and status <> 'cancelled') / nullif(count(*) filter (where stage = 'production' or status = 'cancelled'), 0), 1) end
                       from public.development_projects where company_id = v_co)),
    'validations', jsonb_build_object(
      'pending',  (select count(*) from public.customer_validations v join public.development_projects p on p.id = v.project_id where v.company_id = v_co and v.status = 'pending' and p.status = 'active'),
      'overdue',  (select count(*) from public.customer_validations v join public.development_projects p on p.id = v.project_id where v.company_id = v_co and v.status = 'pending' and p.status = 'active' and v.due_date < current_date),
      'approved_90d', (select count(*) from public.customer_validations where company_id = v_co and status = 'approved' and decided_on >= current_date - 90),
      'refused_90d',  (select count(*) from public.customer_validations where company_id = v_co and status in ('rejected', 'changes_requested') and decided_on >= current_date - 90),
      'avg_response_days', (select round(avg(decided_on - submitted_on)::numeric, 1) from public.customer_validations where company_id = v_co and status <> 'pending' and decided_on >= current_date - 180)),
    'work', jsonb_build_object(
      'prototypes_open', (select count(*) from public.prototypes x join public.development_projects p on p.id = x.project_id where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress', 'ready')),
      'samples_open',    (select count(*) from public.samples x join public.development_projects p on p.id = x.project_id where x.company_id = v_co and p.status = 'active' and x.status in ('planned', 'in_progress')),
      'samples_at_client', (select count(*) from public.samples x join public.development_projects p on p.id = x.project_id where x.company_id = v_co and p.status = 'active' and x.status = 'sent')),
    'by_priority', (select coalesce(jsonb_object_agg(priority, n), '{}'::jsonb) from (select priority, count(*) n from public.development_projects where company_id = v_co and status = 'active' group by priority) x),
    'by_client', (select coalesce(jsonb_agg(jsonb_build_object('client', name, 'count', n) order by n desc), '[]'::jsonb)
                  from (select c.name, count(*) n from public.development_projects p join public.clients c on c.id = p.client_id where p.company_id = v_co and p.status in ('active', 'on_hold') group by c.name order by n desc limit 5) x),
    'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'count', (select count(*) from public.development_projects p where p.company_id = v_co and date_trunc('month', p.created_at) = m)) order by m), '[]'::jsonb)
                 from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m));
  if v_costs then
    v_out := v_out || jsonb_build_object('costs', jsonb_build_object(
      'total',   (select coalesce(sum(c.amount), 0) from public.prototype_costs c join public.development_projects p on p.id = c.project_id where c.company_id = v_co and p.status <> 'cancelled'),
      'last_30d', (select coalesce(sum(amount), 0) from public.prototype_costs where company_id = v_co and incurred_on >= current_date - 30),
      'by_project', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', amt) order by amt desc), '[]'::jsonb)
                     from (select p.code, p.name, sum(c.amount) amt from public.prototype_costs c join public.development_projects p on p.id = c.project_id where c.company_id = v_co group by p.code, p.name order by amt desc limit 5) x)));
  end if;
  return v_out;
end $$;

do $$
declare f text;
begin
  foreach f in array array['dev_project_advance(uuid,text,text)', 'dev_project_set_status(uuid,text,text)', 'dev_prototype_set_status(uuid,text,text)', 'dev_sample_set_status(uuid,text,text)',
                           'dev_validation_decide(uuid,text,text,text)', 'dev_validation_remind(uuid,text)', 'dev_industrialization_set_status(uuid,text)',
                           'development_alerts()', 'development_dashboard()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.dev_flag(), private.dev_default_checklist() from public, anon, authenticated;
