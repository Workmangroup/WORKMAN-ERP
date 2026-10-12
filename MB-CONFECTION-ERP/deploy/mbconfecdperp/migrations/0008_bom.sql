-- =====================================================================
-- 0008_bom — Module BOM (nomenclatures produit)
--  Composants (matières, mercerie…) + prix, nomenclatures versionnées (brouillon → validée → obsolète),
--  multi-niveaux (sous-ensembles), opérations de main-d'œuvre, duplication, archivage,
--  calcul du coût matière / main-d'œuvre / revient, vue arbre, historique (audit_logs, entity_type 'bom' | 'material').
--
--  Visibilité des coûts : la structure d'une nomenclature se lit avec `bom.read` ; les PRIX (composants),
--  le taux horaire, les frais généraux et tous les montants exigent en plus `costs.read` (tables séparées,
--  RLS dédiée, fonctions de calcul filtrées). Monnaie de calcul unique : EUR.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('bom.read',     'bom', 'Voir les nomenclatures', 'Nomenclatures, composants, vue arbre (les coûts exigent aussi « Voir les coûts et marges »)'),
  ('bom.write',    'bom', 'Gérer les nomenclatures', 'Créer / modifier / dupliquer / archiver les nomenclatures et le catalogue de composants'),
  ('bom.validate', 'bom', 'Valider les versions de nomenclature', 'Valider un brouillon de nomenclature (calcul et gel du coût de revient)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('bom.read', 'bom.write', 'bom.validate'))
  or (r.code = 'direction'  and p.code in ('bom.read', 'bom.validate'))
  or (r.code = 'commercial' and p.code = 'bom.read')
  or (r.code = 'achat'      and p.code in ('bom.read', 'bom.write', 'costs.read'))   -- l'achat tient le catalogue et les prix
  or (r.code = 'production' and p.code in ('bom.read', 'bom.write'))
  or (r.code = 'qualite'    and p.code in ('bom.read', 'bom.validate'))
  or (r.code = 'magasin'    and p.code = 'bom.read')
  or (r.code = 'finance'    and p.code = 'bom.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Catalogue de composants et prix
-- ---------------------------------------------------------------------
create table public.bom_materials (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null,                                              -- MAT-0001 (généré, immuable)
  name        text not null check (length(btrim(name)) between 2 and 160),
  category    text not null default 'other' check (category in ('fabric','lining','zip','button','thread','label','reflective','trim','packaging','other')),
  unit        text not null default 'pc' check (unit in ('m','m2','pc','kg','cm')),
  color       text check (color is null or length(color) <= 60),
  supplier_id uuid references public.suppliers(id) on delete set null,
  description text check (description is null or length(description) <= 500),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code)
);
create index bom_materials_idx on public.bom_materials (company_id, category, name);

create table public.bom_material_prices (
  material_id uuid primary key references public.bom_materials(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  unit_cost   numeric(14,4) not null check (unit_cost >= 0 and unit_cost < 1000000000),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- ---------------------------------------------------------------------
-- 3. Nomenclatures, versions, lignes, opérations
-- ---------------------------------------------------------------------
create table public.boms (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  code               text not null,                                       -- BOM-0001 (généré, immuable)
  name               text not null check (length(btrim(name)) between 2 and 160),
  kind               text not null default 'product' check (kind in ('product','subassembly')),
  article_id         uuid references public.articles(id),                 -- RESTRICT : un article avec nomenclature ne se supprime pas
  description        text check (description is null or length(description) <= 2000),
  current_version_id uuid,
  active_version_id  uuid,
  archived_at        timestamptz,
  archived_by        uuid,
  archive_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid,
  unique (company_id, code),
  constraint boms_subassembly_no_article check (kind = 'product' or article_id is null)
);
create unique index boms_article_uq on public.boms (article_id) where article_id is not null and archived_at is null;
create index boms_idx on public.boms (company_id, kind, archived_at);

create table public.bom_versions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  bom_id             uuid not null references public.boms(id) on delete cascade,
  version_no         int  not null check (version_no >= 1),
  status             text not null default 'draft' check (status in ('draft','validated','obsolete')),
  change_note        text check (change_note is null or length(change_note) <= 500),
  validated_by       uuid,
  validated_at       timestamptz,
  validation_comment text,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (bom_id, version_no)
);
create unique index bom_versions_one_draft_uq on public.bom_versions (bom_id) where status = 'draft';

alter table public.boms
  add constraint boms_current_version_fk foreign key (current_version_id) references public.bom_versions(id) deferrable initially deferred,
  add constraint boms_active_version_fk  foreign key (active_version_id)  references public.bom_versions(id) deferrable initially deferred;

-- Paramètres de coût d'une version + coût figé à la validation (confidentiels : costs.read)
create table public.bom_version_costs (
  version_id    uuid primary key references public.bom_versions(id) on delete cascade,
  company_id    uuid not null references public.companies(id),
  hourly_rate   numeric(10,4) not null default 0 check (hourly_rate >= 0 and hourly_rate <= 1000),
  overhead_pct  numeric(6,2)  not null default 0 check (overhead_pct >= 0 and overhead_pct <= 300),
  snap_material numeric(14,4),
  snap_labor    numeric(14,4),
  snap_overhead numeric(14,4),
  snap_total    numeric(14,4),
  frozen_at     timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table public.bom_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  bom_id       uuid not null references public.boms(id) on delete cascade,
  version_id   uuid not null references public.bom_versions(id) on delete cascade,
  pos          int  not null default 0,
  line_type    text not null check (line_type in ('material','bom')),
  material_id  uuid references public.bom_materials(id),
  child_bom_id uuid references public.boms(id),
  quantity     numeric(14,4) not null check (quantity > 0 and quantity <= 1000000),
  waste_pct    numeric(6,2)  not null default 0 check (waste_pct >= 0 and waste_pct <= 100),
  note         text check (note is null or length(note) <= 300),
  created_at   timestamptz not null default now(),
  constraint bom_lines_kind_ck check (
    (line_type = 'material' and material_id is not null and child_bom_id is null)
    or (line_type = 'bom' and child_bom_id is not null and material_id is null and waste_pct = 0))
);
create index bom_lines_version_idx  on public.bom_lines (version_id, pos);
create index bom_lines_child_idx    on public.bom_lines (child_bom_id) where child_bom_id is not null;
create index bom_lines_material_idx on public.bom_lines (material_id) where material_id is not null;

create table public.bom_operations (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  bom_id     uuid not null references public.boms(id) on delete cascade,
  version_id uuid not null references public.bom_versions(id) on delete cascade,
  pos        int  not null default 0,
  name       text not null check (length(btrim(name)) between 2 and 120),
  minutes    numeric(8,2) not null check (minutes > 0 and minutes <= 600),
  note       text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now()
);
create index bom_operations_version_idx on public.bom_operations (version_id, pos);

-- ---------------------------------------------------------------------
-- 4. Garde-fous communs
-- ---------------------------------------------------------------------
create function private.bom_rpc() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('bom.rpc', true), 'off') = 'on' $$;

-- Une nomenclature est modifiable si elle n'est pas archivée et si le client de son article n'est pas archivé
create function private.bom_assert_writable(p_bom uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  select * into b from public.boms where id = p_bom;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.archived_at is not null then raise exception 'BOM_ARCHIVED' using errcode = '55000'; end if;
  if b.article_id is not null then
    perform private.ged_assert_client_open((select client_id from public.articles where id = b.article_id));
  end if;
end $$;

-- Le BOM « p_from » contient-il « p_target » parmi ses descendants (toutes versions confondues) ?
create function private.bom_reaches(p_from uuid, p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive d(id) as (
    select child_bom_id from public.bom_lines where bom_id = p_from and line_type = 'bom'
    union
    select l.child_bom_id from public.bom_lines l join d on l.bom_id = d.id where l.line_type = 'bom')
  select exists (select 1 from d where id = p_target) $$;

-- Recalcule dernière version / version validée d'une nomenclature
create function private.bom_refresh(p_bom uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cur uuid; v_act uuid; v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  select id into v_cur from public.bom_versions where bom_id = p_bom order by version_no desc limit 1;
  select id into v_act from public.bom_versions where bom_id = p_bom and status = 'validated' limit 1;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set current_version_id = v_cur, active_version_id = v_act where id = p_bom;
  perform set_config('bom.rpc', v_prev, true);
end $$;

-- ---------------------------------------------------------------------
-- 5. Triggers : composants et prix
-- ---------------------------------------------------------------------
create function private.bom_materials_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'MAT-' || lpad(private.next_seq(new.company_id, 'material')::text, 4, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid(); new.archived_at := null;
  else
    if new.unit is distinct from old.unit and exists (select 1 from public.bom_lines where material_id = old.id) then
      raise exception 'BOM_MATERIAL_UNIT_LOCKED' using errcode = '55000';   -- l'unité d'un composant utilisé ne change plus
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.name := btrim(new.name);
  new.color := nullif(btrim(coalesce(new.color, '')), '');
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  if new.supplier_id is not null and not exists (select 1 from public.suppliers s where s.id = new.supplier_id and s.company_id = new.company_id) then
    raise exception 'BOM_BAD_SUPPLIER' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger bom_materials_before_iu before insert or update on public.bom_materials
  for each row execute function private.bom_materials_before();

create function private.bom_prices_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select company_id into new.company_id from public.bom_materials where id = new.material_id;
  if new.company_id is null then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
create trigger bom_prices_before_iu before insert or update on public.bom_material_prices
  for each row execute function private.bom_prices_before();

-- ---------------------------------------------------------------------
-- 6. Triggers : nomenclatures, versions, lignes, opérations
-- ---------------------------------------------------------------------
create function private.boms_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_art public.articles%rowtype;
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'BOM-' || lpad(private.next_seq(new.company_id, 'bom')::text, 4, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.current_version_id := null; new.active_version_id := null; new.archived_at := null; new.archived_by := null; new.archive_reason := null;
  elsif not private.bom_rpc() then
    if old.archived_at is not null then raise exception 'BOM_ARCHIVED' using errcode = '55000'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  if new.article_id is not null and (tg_op = 'INSERT' or new.article_id is distinct from old.article_id) then
    select * into v_art from public.articles where id = new.article_id;
    if not found or v_art.company_id <> new.company_id then raise exception 'BOM_BAD_ARTICLE' using errcode = '22023'; end if;
    perform private.ged_assert_client_open(v_art.client_id);
  end if;
  new.name := btrim(new.name);
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  return new;
end $$;
create trigger boms_before_iu before insert or update on public.boms
  for each row execute function private.boms_before();

-- Chaque nomenclature reçoit sa version 1 (brouillon) et ses paramètres de coût
create function private.boms_seed_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  perform set_config('bom.rpc', 'on', true);
  insert into public.bom_versions (company_id, bom_id, version_no, change_note) values (new.company_id, new.id, 1, 'Création de la nomenclature');
  perform set_config('bom.rpc', v_prev, true);
  perform private.bom_refresh(new.id);
  return new;
end $$;
create trigger boms_seed_version_i after insert on public.boms
  for each row execute function private.boms_seed_version();

create function private.bom_versions_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into b from public.boms where id = new.bom_id;
    if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := b.company_id; new.status := 'draft'; new.created_by := auth.uid(); new.updated_by := auth.uid();
    new.validated_by := null; new.validated_at := null; new.validation_comment := null;
  else
    if not private.bom_rpc() then
      perform private.bom_assert_writable(new.bom_id);
      if new.bom_id is distinct from old.bom_id or new.version_no is distinct from old.version_no or new.status is distinct from old.status
         or new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at then
        raise exception 'BOM_VERSION_LOCKED' using errcode = '42501';
      end if;
      if old.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger bom_versions_before_iu before insert or update on public.bom_versions
  for each row execute function private.bom_versions_before();

create function private.bom_versions_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.bom_version_costs (version_id, company_id) values (new.id, new.company_id) on conflict do nothing;
  end if;
  perform private.bom_refresh(coalesce(new.bom_id, old.bom_id));
  return coalesce(new, old);
end $$;
create trigger bom_versions_after_iud after insert or update of status or delete on public.bom_versions
  for each row execute function private.bom_versions_after();

create function private.bom_costs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype;
begin
  select * into v from public.bom_versions where id = new.version_id;
  new.company_id := v.company_id;
  if not private.bom_rpc() then
    perform private.bom_assert_writable(v.bom_id);
    if v.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
    new.snap_material := old.snap_material; new.snap_labor := old.snap_labor; new.snap_overhead := old.snap_overhead;
    new.snap_total := old.snap_total; new.frozen_at := old.frozen_at;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
create trigger bom_costs_before_u before update on public.bom_version_costs
  for each row execute function private.bom_costs_before();

-- Lignes
create function private.bom_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; m public.bom_materials%rowtype; c public.boms%rowtype; v_ver uuid := coalesce(new.version_id, old.version_id);
begin
  select * into v from public.bom_versions where id = v_ver;
  if not private.bom_rpc() and found then
    perform private.bom_assert_writable(v.bom_id);
    if v.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'INSERT' then
    if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := v.company_id; new.bom_id := v.bom_id;
    if new.pos is null or new.pos <= 0 then
      new.pos := coalesce((select max(pos) from public.bom_lines where version_id = new.version_id), 0) + 1;
    end if;
    if not private.bom_rpc() then
      if new.line_type = 'material' then
        select * into m from public.bom_materials where id = new.material_id;
        if not found or m.company_id <> v.company_id then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
        if m.archived_at is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
      else
        select * into c from public.boms where id = new.child_bom_id;
        if not found or c.company_id <> v.company_id then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
        if c.archived_at is not null then raise exception 'BOM_CHILD_ARCHIVED' using errcode = '55000'; end if;
        if c.id = v.bom_id or private.bom_reaches(c.id, v.bom_id) then raise exception 'BOM_CYCLE' using errcode = '23514'; end if;
      end if;
    end if;
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger bom_lines_before_iud before insert or update or delete on public.bom_lines
  for each row execute function private.bom_lines_before();

-- Opérations
create function private.bom_operations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; v_ver uuid := coalesce(new.version_id, old.version_id);
begin
  select * into v from public.bom_versions where id = v_ver;
  if not private.bom_rpc() and found then
    perform private.bom_assert_writable(v.bom_id);
    if v.status <> 'draft' then raise exception 'BOM_VERSION_LOCKED' using errcode = '55000'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := v.company_id; new.bom_id := v.bom_id;
    if new.pos is null or new.pos <= 0 then
      new.pos := coalesce((select max(pos) from public.bom_operations where version_id = new.version_id), 0) + 1;
    end if;
  end if;
  new.name := btrim(new.name);
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger bom_operations_before_iud before insert or update or delete on public.bom_operations
  for each row execute function private.bom_operations_before();

-- « Modifié le » de la nomenclature suit ses lignes / opérations
create function private.bom_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_bom uuid := coalesce(new.bom_id, old.bom_id); v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  if v_prev = 'on' then return coalesce(new, old); end if;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set updated_at = now(), updated_by = auth.uid() where id = v_bom;
  perform set_config('bom.rpc', v_prev, true);
  return coalesce(new, old);
end $$;
create trigger bom_lines_touch_iud after insert or update or delete on public.bom_lines for each row execute function private.bom_touch();
create trigger bom_operations_touch_iud after insert or update or delete on public.bom_operations for each row execute function private.bom_touch();

-- ---------------------------------------------------------------------
-- 7. Calcul des coûts
--    matière  = Σ quantité × (1 + perte %) × prix unitaire  (+ quantité × matière du sous-ensemble)
--    main-d'œuvre = Σ minutes / 60 × taux horaire           (+ quantité × main-d'œuvre du sous-ensemble)
--    frais généraux = (matière + main-d'œuvre) × %          (appliqués au niveau du produit fini uniquement)
--    coût de revient = matière + main-d'œuvre + frais généraux
--    Un sous-ensemble est valorisé avec sa version VALIDÉE.
-- ---------------------------------------------------------------------
create function private.bom_calc(p_version uuid, p_depth int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  vc public.bom_version_costs%rowtype; r record; sub jsonb; v_child uuid;
  v_mat numeric := 0; v_lab numeric := 0; v_ov numeric; v_min numeric; v_missing jsonb := '[]'::jsonb;
begin
  if p_depth > 8 then raise exception 'BOM_TOO_DEEP' using errcode = '54001'; end if;
  select * into vc from public.bom_version_costs where version_id = p_version;
  for r in
    select l.line_type, l.quantity, l.waste_pct, l.child_bom_id, m.code m_code, pr.unit_cost, cb.code c_code, cb.active_version_id c_active
    from public.bom_lines l
    left join public.bom_materials m on m.id = l.material_id
    left join public.bom_material_prices pr on pr.material_id = l.material_id
    left join public.boms cb on cb.id = l.child_bom_id
    where l.version_id = p_version
  loop
    if r.line_type = 'material' then
      if r.unit_cost is null then v_missing := v_missing || to_jsonb(r.m_code);
      else v_mat := v_mat + r.quantity * (1 + r.waste_pct / 100) * r.unit_cost; end if;
    else
      if r.c_active is null then v_missing := v_missing || to_jsonb(r.c_code);
      else
        sub := private.bom_calc(r.c_active, p_depth + 1);
        v_mat := v_mat + r.quantity * (sub ->> 'material')::numeric;
        v_lab := v_lab + r.quantity * (sub ->> 'labor')::numeric;
        v_missing := v_missing || coalesce(sub -> 'missing', '[]'::jsonb);
      end if;
    end if;
  end loop;
  select coalesce(sum(minutes), 0) into v_min from public.bom_operations where version_id = p_version;
  v_lab := v_lab + v_min / 60 * coalesce(vc.hourly_rate, 0);
  v_ov := (v_mat + v_lab) * coalesce(vc.overhead_pct, 0) / 100;
  return jsonb_build_object('material', round(v_mat, 4), 'labor', round(v_lab, 4), 'overhead', round(v_ov, 4),
                            'total', round(v_mat + v_lab + v_ov, 4), 'minutes', v_min,
                            'missing', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(v_missing) x));
end $$;
revoke execute on function private.bom_calc(uuid, int) from public, anon, authenticated;

-- Nœud de l'arbre (nomenclature + lignes + opérations, sous-ensembles dépliés récursivement)
create function private.bom_node(p_version uuid, p_mult numeric, p_depth int, p_costs boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.bom_versions%rowtype; b public.boms%rowtype; vc public.bom_version_costs%rowtype;
  r record; o record; v_lines jsonb := '[]'::jsonb; v_ops jsonb := '[]'::jsonb; v_child jsonb; v_sub jsonb; v_cost numeric; v_tq numeric;
begin
  if p_depth > 8 then raise exception 'BOM_TOO_DEEP' using errcode = '54001'; end if;
  select * into v from public.bom_versions where id = p_version;
  select * into b from public.boms where id = v.bom_id;
  select * into vc from public.bom_version_costs where version_id = p_version;

  for r in
    select l.id, l.pos, l.line_type, l.quantity, l.waste_pct, l.note, l.child_bom_id,
           m.id m_id, m.code m_code, m.name m_name, m.category m_cat, m.unit m_unit, m.color m_color, m.archived_at m_arch, pr.unit_cost
    from public.bom_lines l
    left join public.bom_materials m on m.id = l.material_id
    left join public.bom_material_prices pr on pr.material_id = l.material_id
    where l.version_id = p_version order by l.pos, l.id
  loop
    if r.line_type = 'material' then
      v_tq := r.quantity * (1 + r.waste_pct / 100) * p_mult;
      v_cost := case when p_costs and r.unit_cost is not null then round(r.quantity * (1 + r.waste_pct / 100) * r.unit_cost, 4) end;
      v_lines := v_lines || (jsonb_build_object('id', r.id, 'type', 'material', 'pos', r.pos, 'qty', r.quantity, 'waste_pct', r.waste_pct,
          'note', r.note, 'total_qty', round(v_tq, 4), 'unit', r.m_unit,
          'material', jsonb_build_object('id', r.m_id, 'code', r.m_code, 'name', r.m_name, 'category', r.m_cat, 'unit', r.m_unit, 'color', r.m_color, 'archived', r.m_arch is not null))
        || case when p_costs then jsonb_build_object('unit_cost', r.unit_cost, 'cost', v_cost) else '{}'::jsonb end);
    else
      select * into b from public.boms where id = r.child_bom_id;   -- (b est réutilisé puis restauré ci-dessous)
      v_child := null; v_sub := null; v_cost := null;
      if b.active_version_id is not null then
        v_child := private.bom_node(b.active_version_id, p_mult * r.quantity, p_depth + 1, p_costs);
        if p_costs then
          v_sub := private.bom_calc(b.active_version_id, p_depth + 1);
          v_cost := round(r.quantity * ((v_sub ->> 'material')::numeric + (v_sub ->> 'labor')::numeric), 4);
        end if;
      end if;
      v_lines := v_lines || (jsonb_build_object('id', r.id, 'type', 'bom', 'pos', r.pos, 'qty', r.quantity, 'waste_pct', 0, 'note', r.note,
          'total_qty', round(p_mult * r.quantity, 4), 'unit', 'pc',
          'child', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'archived', b.archived_at is not null, 'validated', b.active_version_id is not null),
          'node', v_child)
        || case when p_costs then jsonb_build_object('cost', v_cost) else '{}'::jsonb end);
      select * into b from public.boms where id = v.bom_id;
    end if;
  end loop;

  for o in select id, pos, name, minutes, note from public.bom_operations where version_id = p_version order by pos, id loop
    v_ops := v_ops || (jsonb_build_object('id', o.id, 'pos', o.pos, 'name', o.name, 'minutes', o.minutes, 'note', o.note, 'total_minutes', round(o.minutes * p_mult, 2))
      || case when p_costs then jsonb_build_object('cost', round(o.minutes / 60 * coalesce(vc.hourly_rate, 0), 4)) else '{}'::jsonb end);
  end loop;

  return jsonb_build_object(
    'bom', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'kind', b.kind, 'archived', b.archived_at is not null),
    'version', jsonb_build_object('id', v.id, 'no', v.version_no, 'status', v.status),
    'lines', v_lines, 'operations', v_ops)
    || case when p_costs then jsonb_build_object('hourly_rate', vc.hourly_rate, 'overhead_pct', vc.overhead_pct, 'totals', private.bom_calc(p_version, p_depth)) else '{}'::jsonb end;
end $$;
revoke execute on function private.bom_node(uuid, numeric, int, boolean) from public, anon, authenticated;

create function public.bom_tree(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('bom.read');
  if not exists (select 1 from public.bom_versions where id = p_version and company_id = private.current_company()) then
    raise exception 'BOM_NOT_FOUND' using errcode = 'P0002';
  end if;
  return private.bom_node(p_version, 1, 0, private.has_perm('costs.read'));
end $$;

-- Coût recalculé aux prix actuels + coût figé à la validation (si la version est validée)
create function public.bom_cost(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare vc public.bom_version_costs%rowtype;
begin
  perform private.require_perm('bom.read');
  perform private.require_perm('costs.read');
  select * into vc from public.bom_version_costs where version_id = p_version and company_id = private.current_company();
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('live', private.bom_calc(p_version),
    'frozen', case when vc.frozen_at is null then null else jsonb_build_object('material', vc.snap_material, 'labor', vc.snap_labor,
      'overhead', vc.snap_overhead, 'total', vc.snap_total, 'frozen_at', vc.frozen_at) end);
end $$;

-- ---------------------------------------------------------------------
-- 8. Historique
-- ---------------------------------------------------------------------
create function private.audit_bom_materials() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.bom_rpc() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'material.create', 'material', new.id::text, new.code,
      null, jsonb_build_object('code', new.code, 'name', new.name, 'category', new.category, 'unit', new.unit));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
             where k not in ('name','category','unit','color','supplier_id','description')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'material.update', 'material', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after');
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_bom_materials_iu after insert or update on public.bom_materials
  for each row execute function private.audit_bom_materials();

create function private.audit_bom_prices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  select code into v_code from public.bom_materials where id = new.material_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'material.price_set', 'material', new.material_id::text, v_code,
      null, jsonb_build_object('unit_cost', new.unit_cost));
  elsif new.unit_cost is distinct from old.unit_cost then
    perform private.write_audit(new.company_id, 'material.price_update', 'material', new.material_id::text, v_code,
      jsonb_build_object('unit_cost', old.unit_cost), jsonb_build_object('unit_cost', new.unit_cost));
  end if;
  return new;
end $$;
create trigger audit_bom_prices_iu after insert or update on public.bom_material_prices
  for each row execute function private.audit_bom_prices();

create function private.audit_boms() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.bom_rpc() then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'bom.create', 'bom', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'kind', new.kind,
                         'article', (select internal_ref from public.articles where id = new.article_id)));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','description','article_id')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'bom.update', 'bom', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after');
    end if;
  end if;
  return new;
end $$;
create trigger audit_boms_iu after insert or update on public.boms
  for each row execute function private.audit_boms();

create function private.audit_bom_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  select code into v_code from public.boms where id = new.bom_id;
  if tg_op = 'INSERT' and new.version_no > 1 then
    perform private.write_audit(new.company_id, 'bom.version_new', 'bom', new.bom_id::text, v_code, null, null,
      jsonb_build_object('version', new.version_no, 'note', new.change_note));
  elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'validated' then
    perform private.write_audit(new.company_id, 'bom.version_validate', 'bom', new.bom_id::text, v_code, null, null,
      jsonb_build_object('version', new.version_no, 'comment', new.validation_comment));
  end if;
  return new;
end $$;
create trigger audit_bom_versions_iu after insert or update on public.bom_versions
  for each row execute function private.audit_bom_versions();

create function private.audit_bom_costs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; v_code text;
begin
  if private.bom_rpc() then return new; end if;
  if new.hourly_rate is distinct from old.hourly_rate or new.overhead_pct is distinct from old.overhead_pct then
    select * into v from public.bom_versions where id = new.version_id;
    select code into v_code from public.boms where id = v.bom_id;
    perform private.write_audit(new.company_id, 'bom.costing_update', 'bom', v.bom_id::text, v_code,
      jsonb_build_object('hourly_rate', old.hourly_rate, 'overhead_pct', old.overhead_pct),
      jsonb_build_object('hourly_rate', new.hourly_rate, 'overhead_pct', new.overhead_pct), jsonb_build_object('version', v.version_no));
  end if;
  return new;
end $$;
create trigger audit_bom_costs_u after update on public.bom_version_costs
  for each row execute function private.audit_bom_costs();

create function private.audit_bom_lines() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.bom_lines%rowtype; v_code text; v_no int; v_what jsonb; v_before jsonb; v_after jsonb;
begin
  if private.bom_rpc() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.boms where id = r.bom_id;
  select version_no into v_no from public.bom_versions where id = r.version_id;
  v_what := jsonb_build_object('component', coalesce((select code || ' — ' || name from public.bom_materials where id = r.material_id),
                                                       (select code || ' — ' || name from public.boms where id = r.child_bom_id)),
                               'type', r.line_type);
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'bom.line_add', 'bom', r.bom_id::text, v_code, null,
      jsonb_build_object('quantity', r.quantity, 'waste_pct', r.waste_pct), v_what || jsonb_build_object('version', v_no));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'bom.line_delete', 'bom', r.bom_id::text, v_code,
      jsonb_build_object('quantity', r.quantity, 'waste_pct', r.waste_pct), null, v_what || jsonb_build_object('version', v_no));
  elsif old.quantity is distinct from new.quantity or old.waste_pct is distinct from new.waste_pct or old.note is distinct from new.note then
    v_before := jsonb_build_object('quantity', old.quantity, 'waste_pct', old.waste_pct);
    v_after  := jsonb_build_object('quantity', new.quantity, 'waste_pct', new.waste_pct);
    perform private.write_audit(r.company_id, 'bom.line_update', 'bom', r.bom_id::text, v_code, v_before, v_after, v_what || jsonb_build_object('version', v_no));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_bom_lines_iud after insert or update or delete on public.bom_lines
  for each row execute function private.audit_bom_lines();

create function private.audit_bom_operations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.bom_operations%rowtype; v_code text; v_no int;
begin
  if private.bom_rpc() then return coalesce(new, old); end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.boms where id = r.bom_id;
  select version_no into v_no from public.bom_versions where id = r.version_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(r.company_id, 'bom.op_add', 'bom', r.bom_id::text, v_code, null,
      jsonb_build_object('name', r.name, 'minutes', r.minutes), jsonb_build_object('version', v_no));
  elsif tg_op = 'DELETE' then
    perform private.write_audit(r.company_id, 'bom.op_delete', 'bom', r.bom_id::text, v_code,
      jsonb_build_object('name', r.name, 'minutes', r.minutes), null, jsonb_build_object('version', v_no));
  elsif old.name is distinct from new.name or old.minutes is distinct from new.minutes then
    perform private.write_audit(r.company_id, 'bom.op_update', 'bom', r.bom_id::text, v_code,
      jsonb_build_object('name', old.name, 'minutes', old.minutes), jsonb_build_object('name', new.name, 'minutes', new.minutes), jsonb_build_object('version', v_no));
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_bom_operations_iud after insert or update or delete on public.bom_operations
  for each row execute function private.audit_bom_operations();

-- Les actions de coût ne sont visibles qu'avec costs.read
create policy audit_logs_select_bom on public.audit_logs for select to authenticated
  using (entity_type in ('bom', 'material') and company_id = private.current_company() and private.has_perm('bom.read')
         and (action not in ('bom.costing_update', 'material.price_set', 'material.price_update') or private.has_perm('costs.read')));

-- ---------------------------------------------------------------------
-- 9. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.bom_materials      enable row level security;
alter table public.bom_material_prices enable row level security;
alter table public.boms               enable row level security;
alter table public.bom_versions       enable row level security;
alter table public.bom_version_costs  enable row level security;
alter table public.bom_lines          enable row level security;
alter table public.bom_operations     enable row level security;

revoke all on public.bom_materials, public.bom_material_prices, public.boms, public.bom_versions, public.bom_version_costs,
              public.bom_lines, public.bom_operations from anon, authenticated;
grant all on public.bom_materials, public.bom_material_prices, public.boms, public.bom_versions, public.bom_version_costs,
             public.bom_lines, public.bom_operations to service_role;
grant select on public.bom_materials, public.bom_material_prices, public.boms, public.bom_versions, public.bom_version_costs,
                public.bom_lines, public.bom_operations to authenticated;

grant insert (name, category, unit, color, supplier_id, description) on public.bom_materials to authenticated;
grant update (name, category, unit, color, supplier_id, description) on public.bom_materials to authenticated;
grant insert (material_id, unit_cost) on public.bom_material_prices to authenticated;
grant update (unit_cost) on public.bom_material_prices to authenticated;
grant insert (name, kind, article_id, description) on public.boms to authenticated;
grant update (name, description, article_id) on public.boms to authenticated;
grant update (change_note) on public.bom_versions to authenticated;
grant update (hourly_rate, overhead_pct) on public.bom_version_costs to authenticated;
grant insert (version_id, line_type, material_id, child_bom_id, quantity, waste_pct, note) on public.bom_lines to authenticated;
grant update (pos, quantity, waste_pct, note) on public.bom_lines to authenticated;
grant delete on public.bom_lines to authenticated;
grant insert (version_id, name, minutes, note) on public.bom_operations to authenticated;
grant update (pos, name, minutes, note) on public.bom_operations to authenticated;
grant delete on public.bom_operations to authenticated;

create policy bom_materials_select on public.bom_materials for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_materials_insert on public.bom_materials for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_materials_update on public.bom_materials for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_prices_select on public.bom_material_prices for select to authenticated
  using (company_id = private.current_company() and private.has_perm('costs.read'));
create policy bom_prices_insert on public.bom_material_prices for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'));
create policy bom_prices_update on public.bom_material_prices for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'))
  with check (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'));

create policy boms_select on public.boms for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy boms_insert on public.boms for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy boms_update on public.boms for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_versions_select on public.bom_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_versions_update on public.bom_versions for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_costs_select on public.bom_version_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('costs.read'));
create policy bom_costs_update on public.bom_version_costs for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'))
  with check (company_id = private.current_company() and private.has_perm('bom.write') and private.has_perm('costs.read'));

create policy bom_lines_select on public.bom_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_lines_insert on public.bom_lines for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_lines_update on public.bom_lines for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_lines_delete on public.bom_lines for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'));

create policy bom_operations_select on public.bom_operations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
create policy bom_operations_insert on public.bom_operations for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_operations_update on public.bom_operations for update to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'))
  with check (company_id = private.current_company() and private.has_perm('bom.write'));
create policy bom_operations_delete on public.bom_operations for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.write'));

-- ---------------------------------------------------------------------
-- 10. RPC : versions, duplication, archivage, suppression
-- ---------------------------------------------------------------------
-- Copie lignes, opérations et paramètres de coût d'une version vers une autre (sans audit ligne à ligne)
create function private.bom_copy_content(p_from uuid, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('bom.rpc', true), 'off');
begin
  perform set_config('bom.rpc', 'on', true);
  insert into public.bom_lines (company_id, bom_id, version_id, pos, line_type, material_id, child_bom_id, quantity, waste_pct, note)
  select l.company_id, (select bom_id from public.bom_versions where id = p_to), p_to, l.pos, l.line_type, l.material_id, l.child_bom_id, l.quantity, l.waste_pct, l.note
  from public.bom_lines l where l.version_id = p_from;
  insert into public.bom_operations (company_id, bom_id, version_id, pos, name, minutes, note)
  select o.company_id, (select bom_id from public.bom_versions where id = p_to), p_to, o.pos, o.name, o.minutes, o.note
  from public.bom_operations o where o.version_id = p_from;
  update public.bom_version_costs t set hourly_rate = s.hourly_rate, overhead_pct = s.overhead_pct
  from public.bom_version_costs s where s.version_id = p_from and t.version_id = p_to;
  perform set_config('bom.rpc', v_prev, true);
end $$;
revoke execute on function private.bom_copy_content(uuid, uuid) from public, anon, authenticated;

create function public.bom_new_version(p_bom uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype; v_last public.bom_versions%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.bom_assert_writable(p_bom);
  if exists (select 1 from public.bom_versions where bom_id = p_bom and status = 'draft') then
    raise exception 'BOM_DRAFT_EXISTS' using errcode = '55000';
  end if;
  select * into v_last from public.bom_versions where bom_id = p_bom order by version_no desc limit 1;
  insert into public.bom_versions (id, company_id, bom_id, version_no, change_note)
  values (v_id, b.company_id, p_bom, v_last.version_no + 1, nullif(btrim(coalesce(p_note, '')), ''));
  perform private.bom_copy_content(v_last.id, v_id);
  return v_id;
end $$;

create function public.bom_validate_version(p_version uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; b public.boms%rowtype; v_calc jsonb; v_bad text;
begin
  perform private.require_perm('bom.validate');
  select * into v from public.bom_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into b from public.boms where id = v.bom_id for update;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.bom_lines where version_id = p_version) then raise exception 'BOM_EMPTY' using errcode = '55000'; end if;

  select string_agg(m.code, ', ') into v_bad from public.bom_lines l join public.bom_materials m on m.id = l.material_id
   where l.version_id = p_version and m.archived_at is not null;
  if v_bad is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000', detail = v_bad; end if;
  select string_agg(c.code, ', ') into v_bad from public.bom_lines l join public.boms c on c.id = l.child_bom_id
   where l.version_id = p_version and (c.archived_at is not null or c.active_version_id is null);
  if v_bad is not null then raise exception 'BOM_CHILD_NOT_VALIDATED' using errcode = '55000', detail = v_bad; end if;

  v_calc := private.bom_calc(p_version);
  if jsonb_array_length(v_calc -> 'missing') > 0 then
    raise exception 'BOM_PRICE_MISSING' using errcode = '55000', detail = (select string_agg(x, ', ') from jsonb_array_elements_text(v_calc -> 'missing') x);
  end if;

  perform set_config('bom.rpc', 'on', true);
  update public.bom_versions set status = 'obsolete' where bom_id = v.bom_id and status = 'validated';
  update public.bom_versions set status = 'validated', validated_by = auth.uid(), validated_at = now(),
         validation_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_version;
  update public.bom_version_costs set snap_material = (v_calc ->> 'material')::numeric, snap_labor = (v_calc ->> 'labor')::numeric,
         snap_overhead = (v_calc ->> 'overhead')::numeric, snap_total = (v_calc ->> 'total')::numeric, frozen_at = now() where version_id = p_version;
  perform set_config('bom.rpc', 'off', true);
  perform private.bom_refresh(v.bom_id);   -- (la validation est tracée par le trigger d'audit des versions)
end $$;

create function public.bom_discard_draft(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.bom_versions%rowtype; b public.boms%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into v from public.bom_versions where id = p_version and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into b from public.boms where id = v.bom_id;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  if v.version_no = 1 then raise exception 'BOM_FIRST_VERSION' using errcode = '55000'; end if;
  perform set_config('bom.rpc', 'on', true);
  delete from public.bom_versions where id = p_version;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'bom.version_discard', 'bom', b.id::text, b.code, null, null, jsonb_build_object('version', v.version_no), 'rpc');
end $$;

-- Duplication : nouvelle nomenclature (même type) dont la version 1 reprend la version source
create function public.bom_duplicate(p_bom uuid, p_name text, p_article uuid default null, p_version uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare src public.boms%rowtype; v_src uuid; v_new uuid := gen_random_uuid(); v_v1 uuid; v_code text;
begin
  perform private.require_perm('bom.write');
  select * into src from public.boms where id = p_bom and company_id = private.current_company();
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'BOM_INVALID_NAME' using errcode = '22023'; end if;
  if p_version is not null then
    select id into v_src from public.bom_versions where id = p_version and bom_id = p_bom;
    if v_src is null then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  else
    v_src := coalesce(src.active_version_id, src.current_version_id);
  end if;
  if src.kind = 'subassembly' and p_article is not null then raise exception 'BOM_BAD_ARTICLE' using errcode = '22023'; end if;

  perform set_config('bom.rpc', 'on', true);       -- pas d'audit « création » : seule la duplication est tracée
  insert into public.boms (id, company_id, name, kind, article_id, description)
  values (v_new, src.company_id, btrim(p_name), src.kind, p_article, src.description);
  perform set_config('bom.rpc', 'off', true);
  select id into v_v1 from public.bom_versions where bom_id = v_new and version_no = 1;
  perform private.bom_copy_content(v_src, v_v1);
  select code into v_code from public.boms where id = v_new;
  perform private.write_audit(src.company_id, 'bom.duplicate', 'bom', v_new::text, v_code, null,
    jsonb_build_object('code', v_code, 'name', btrim(p_name)), jsonb_build_object('source_id', src.id, 'source_code', src.code,
      'source_version', (select version_no from public.bom_versions where id = v_src)), 'rpc');
  return v_new;
end $$;

create function public.bom_archive(p_bom uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype; v_used text;
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.archived_at is not null then raise exception 'BOM_ARCHIVED' using errcode = '55000'; end if;
  -- un sous-ensemble utilisé par une nomenclature active ne s'archive pas
  select string_agg(distinct p.code, ', ') into v_used
  from public.bom_lines l join public.boms p on p.id = l.bom_id
  where l.child_bom_id = p_bom and p.archived_at is null
    and l.version_id in (p.current_version_id, p.active_version_id);
  if v_used is not null then raise exception 'BOM_USED_AS_CHILD' using errcode = '23503', detail = v_used; end if;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set archived_at = now(), archived_by = auth.uid(), archive_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_bom;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(b.company_id, 'bom.archive', 'bom', b.id::text, b.code, null, null, jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

create function public.bom_restore(p_bom uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.archived_at is null then raise exception 'BOM_NOT_ARCHIVED' using errcode = '55000'; end if;
  perform set_config('bom.rpc', 'on', true);
  update public.boms set archived_at = null, archived_by = null, archive_reason = null where id = p_bom;   -- (l'index unique d'article empêche une double nomenclature active)
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(b.company_id, 'bom.restore', 'bom', b.id::text, b.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- Suppression : nomenclature jamais validée et jamais utilisée comme sous-ensemble
create function public.bom_delete(p_bom uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into b from public.boms where id = p_bom and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.bom_assert_writable(p_bom);
  if exists (select 1 from public.bom_versions where bom_id = p_bom and status in ('validated','obsolete'))
     or exists (select 1 from public.bom_lines where child_bom_id = p_bom) then
    raise exception 'BOM_IN_USE' using errcode = '23503';
  end if;
  perform set_config('bom.rpc', 'on', true);
  delete from public.boms where id = p_bom;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(b.company_id, 'bom.delete', 'bom', b.id::text, b.code, jsonb_build_object('code', b.code, 'name', b.name), null, '{}'::jsonb, 'rpc');
end $$;

-- Composants : archivage / restauration / suppression (jamais utilisé)
create function public.bom_material_archive(p_material uuid, p_archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.bom_materials%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into m from public.bom_materials where id = p_material and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_archive and m.archived_at is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
  if not p_archive and m.archived_at is null then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('bom.rpc', 'on', true);
  update public.bom_materials set archived_at = case when p_archive then now() end, updated_at = now(), updated_by = auth.uid() where id = p_material;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(m.company_id, case when p_archive then 'material.archive' else 'material.restore' end, 'material', m.id::text, m.code, null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.bom_material_delete(p_material uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.bom_materials%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into m from public.bom_materials where id = p_material and company_id = private.current_company() for update;
  if not found then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.bom_lines where material_id = p_material) then raise exception 'BOM_MATERIAL_IN_USE' using errcode = '23503'; end if;
  perform set_config('bom.rpc', 'on', true);
  delete from public.bom_materials where id = p_material;
  perform set_config('bom.rpc', 'off', true);
  perform private.write_audit(m.company_id, 'material.delete', 'material', m.id::text, m.code, jsonb_build_object('code', m.code, 'name', m.name), null, '{}'::jsonb, 'rpc');
end $$;

do $$
declare f text;
begin
  foreach f in array array['bom_tree(uuid)', 'bom_cost(uuid)', 'bom_new_version(uuid,text)', 'bom_validate_version(uuid,text)', 'bom_discard_draft(uuid)',
                           'bom_duplicate(uuid,text,uuid,uuid)', 'bom_archive(uuid,text)', 'bom_restore(uuid)', 'bom_delete(uuid)',
                           'bom_material_archive(uuid,boolean)', 'bom_material_delete(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
