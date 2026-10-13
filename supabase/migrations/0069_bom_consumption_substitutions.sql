-- 0069_bom_consumption_substitutions — Nomenclatures : attributs de ligne (unité, taille, couleur), conversions d'unité,
-- substitutions autorisées, approbation distincte, figure de la version à chaque lancement d'OF, besoins par OF.
--
-- Existant conservé (0008, 0010, 0015, 0019) : nomenclatures (boms), versions (bom_versions : brouillon, validé, obsolète),
-- lignes matière et sous-ensembles (bom_lines, pertes waste_pct), opérations, coûts figés à la validation, MRP (0010),
-- nomenclature propre à une variante (product_variants.bom_id, 0015), ordres de fabrication (0019).
--
-- Règles ajoutées :
--  * Attributs de ligne (bom_line_attributes) : unité de saisie, taille et couleur de référence (facultatives ; vide = toutes).
--    Ils sont validés contre la matière (conversion) et contre le référentiel tailles / couleurs de la société.
--  * Conversion (bom_unit_conversions) : une unité de saisie vers l'unité de la matière, facteur strictement positif.
--    Refus à la validation si une ligne n'a pas de conversion (BOM_UNIT_CONVERSION_MISSING).
--  * Substitutions autorisées (bom_line_substitutions) : matières de remplacement d'une ligne, saisies avec un motif,
--    rattachées à la version ; elles sont copiées avec la version et validées avec elle.
--  * Approbation distincte : le validateur ne peut pas être le rédacteur de la version (SOD_SELF_APPROVAL).
--  * Versions datées : effective_from = date de validation.
--  * Figure de l'OF : au lancement, la version active de la nomenclature (et des sous-ensembles) est figée dans
--    production_order_bom. Une nouvelle version n'y change rien ; les OF ne sont jamais recalculés.
--  * Besoins d'un OF : calculés sur la version figée, avec pertes, conversions et substitutions autorisées.
--    Les lignes restreintes à une taille ou couleur ne sont comptées que si cette taille ou couleur est précisée.
-- Erreurs : BOM_UNIT_CONVERSION_MISSING, BOM_UNIT_TARGET_INVALID, BOM_ATTRIBUTE_UNKNOWN, BOM_LINE_NOT_MATERIAL,
-- BOM_SUBSTITUTE_SAME, BOM_SUBSTITUTE_DUPLICATE, BOM_REASON_REQUIRED, BOM_BAD_STATUS, BOM_SELF_APPROVAL (SOD_SELF_APPROVAL),
-- BOM_MATERIAL_ARCHIVED, PRODUCTION_BOM_SNAPSHOT_MISSING.

-- ---------------------------------------------------------------------------
-- 1. Colonnes et tables additives
-- ---------------------------------------------------------------------------
alter table public.bom_versions add column if not exists effective_from date;

create table public.bom_line_attributes (
  line_id     uuid primary key references public.bom_lines(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  version_id  uuid not null references public.bom_versions(id) on delete cascade,
  unit        text check (unit is null or length(btrim(unit)) between 1 and 12),
  size_code   text check (size_code is null or length(btrim(size_code)) between 1 and 12),
  color_name  text check (color_name is null or length(btrim(color_name)) between 1 and 60),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
alter table public.bom_line_attributes enable row level security;
create policy bom_line_attributes_select on public.bom_line_attributes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
revoke all on public.bom_line_attributes from public, anon, authenticated;
grant select on public.bom_line_attributes to authenticated;

create table public.bom_unit_conversions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id) on delete cascade,
  from_unit    text not null check (length(btrim(from_unit)) between 1 and 12),
  to_unit      text not null check (length(btrim(to_unit)) between 1 and 12),
  factor       numeric(14,6) not null check (factor > 0),
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  unique (material_id, from_unit, to_unit),
  check (lower(btrim(from_unit)) <> lower(btrim(to_unit)))
);
alter table public.bom_unit_conversions enable row level security;
create policy bom_unit_conversions_select on public.bom_unit_conversions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
revoke all on public.bom_unit_conversions from public, anon, authenticated;
grant select on public.bom_unit_conversions to authenticated;

create table public.bom_line_substitutions (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id),
  version_id              uuid not null references public.bom_versions(id) on delete cascade,
  line_id                 uuid not null references public.bom_lines(id) on delete cascade,
  substitute_material_id  uuid not null references public.bom_materials(id),
  factor                  numeric(14,6) not null check (factor > 0 and factor <= 1000),
  reason                  text not null check (length(btrim(reason)) between 5 and 300),
  created_at              timestamptz not null default now(),
  created_by              uuid default auth.uid(),
  unique (line_id, substitute_material_id)
);
alter table public.bom_line_substitutions enable row level security;
create policy bom_line_substitutions_select on public.bom_line_substitutions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
revoke all on public.bom_line_substitutions from public, anon, authenticated;
grant select on public.bom_line_substitutions to authenticated;

-- Figure de l'OF au lancement : ajout seul.
create table public.production_order_bom (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  order_id     uuid not null unique references public.production_orders(id) on delete restrict,
  status       text not null check (status in ('frozen', 'no_bom')),
  bom_id       uuid references public.boms(id),
  version_id   uuid references public.bom_versions(id),
  version_no   int,
  effective_from date,
  frozen_at    timestamptz not null default clock_timestamp(),
  frozen_by    uuid default auth.uid(),
  lines        jsonb not null default '[]'::jsonb,
  check ((status = 'frozen') = (version_id is not null))
);
create trigger production_order_bom_immutable before update or delete on public.production_order_bom
  for each row execute function private.stock_immutable();
alter table public.production_order_bom enable row level security;
create policy production_order_bom_select on public.production_order_bom for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
revoke all on public.production_order_bom from public, anon, authenticated;
grant select on public.production_order_bom to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Conversions et attributs de ligne
-- ---------------------------------------------------------------------------
-- Facteur pour ramener une quantité saisie en p_unit vers l'unité de la matière (null si conversion absente).
create function private.bom_unit_factor(p_material uuid, p_unit text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case
    when p_unit is null or lower(btrim(p_unit)) = lower(btrim(m.unit)) then 1::numeric
    else (select c.factor from public.bom_unit_conversions c
          where c.material_id = m.id and lower(btrim(c.from_unit)) = lower(btrim(p_unit)) and lower(btrim(c.to_unit)) = lower(btrim(m.unit)))
  end
  from public.bom_materials m where m.id = p_material $$;
revoke execute on function private.bom_unit_factor(uuid, text) from public, anon, authenticated;

create function public.bom_unit_conversion_set(p_material uuid, p_from text, p_to text, p_factor numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); m public.bom_materials%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if lower(btrim(coalesce(p_to, ''))) <> lower(btrim(m.unit)) then raise exception 'BOM_UNIT_TARGET_INVALID' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_from, ''))) = 0 or lower(btrim(p_from)) = lower(btrim(m.unit)) then raise exception 'BOM_UNIT_TARGET_INVALID' using errcode = '22023'; end if;
  if p_factor is null or p_factor <= 0 then raise exception 'BOM_UNIT_TARGET_INVALID' using errcode = '22023'; end if;
  insert into public.bom_unit_conversions (company_id, material_id, from_unit, to_unit, factor, updated_by)
  values (v_co, p_material, btrim(p_from), m.unit, p_factor, auth.uid())
  on conflict (material_id, from_unit, to_unit) do update set factor = excluded.factor, updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'bom.unit_conversion', 'material', p_material::text, m.code, null,
    jsonb_build_object('from_unit', btrim(p_from), 'to_unit', m.unit, 'factor', p_factor), '{}'::jsonb, 'rpc');
end $$;

-- Attributs d'une ligne matière d'un brouillon : unité, taille, couleur (vide = toutes).
create function public.bom_line_set_attributes(p_line uuid, p_unit text, p_size text, p_color text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.bom_lines%rowtype; v public.bom_versions%rowtype; m public.bom_materials%rowtype;
  v_unit text := nullif(btrim(coalesce(p_unit, '')), ''); v_size text := nullif(btrim(coalesce(p_size, '')), ''); v_color text := nullif(btrim(coalesce(p_color, '')), '');
begin
  perform private.require_perm('bom.write');
  select * into l from public.bom_lines where id = p_line and company_id = v_co;
  if not found then raise exception 'BOM_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v from public.bom_versions where id = l.version_id for update;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  if l.line_type <> 'material' then raise exception 'BOM_LINE_NOT_MATERIAL' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = l.material_id;
  if v_unit is not null and private.bom_unit_factor(l.material_id, v_unit) is null then
    raise exception 'BOM_UNIT_CONVERSION_MISSING' using errcode = '22023', detail = m.code || ' ' || v_unit;
  end if;
  if v_size is not null and not exists (select 1 from public.sizes where company_id = v_co and upper(code) = upper(v_size)) then
    raise exception 'BOM_ATTRIBUTE_UNKNOWN' using errcode = '22023', detail = 'taille ' || v_size;
  end if;
  if v_color is not null and not exists (select 1 from public.colors where company_id = v_co and lower(btrim(name)) = lower(v_color)) then
    raise exception 'BOM_ATTRIBUTE_UNKNOWN' using errcode = '22023', detail = 'couleur ' || v_color;
  end if;
  insert into public.bom_line_attributes (line_id, company_id, version_id, unit, size_code, color_name, updated_by)
  values (l.id, v_co, v.id, v_unit, v_size, v_color, auth.uid())
  on conflict (line_id) do update set unit = excluded.unit, size_code = excluded.size_code, color_name = excluded.color_name,
    updated_at = now(), updated_by = auth.uid();
  perform private.write_audit(v_co, 'bom.line_attributes', 'bom', v.bom_id::text, null, null,
    jsonb_build_object('line', l.id, 'unit', v_unit, 'size', v_size, 'color', v_color), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Substitutions autorisées (brouillon uniquement)
-- ---------------------------------------------------------------------------
create function public.bom_line_substitute_add(p_line uuid, p_material uuid, p_factor numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.bom_lines%rowtype; v public.bom_versions%rowtype; sm public.bom_materials%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('bom.write');
  select * into l from public.bom_lines where id = p_line and company_id = v_co;
  if not found then raise exception 'BOM_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v from public.bom_versions where id = l.version_id for update;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  if l.line_type <> 'material' then raise exception 'BOM_LINE_NOT_MATERIAL' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'BOM_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_factor is null or p_factor <= 0 or p_factor > 1000 then raise exception 'BOM_BAD_QTY' using errcode = '22023'; end if;
  select * into sm from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'BOM_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if sm.id = l.material_id then raise exception 'BOM_SUBSTITUTE_SAME' using errcode = '22023'; end if;
  if exists (select 1 from public.bom_line_substitutions where line_id = l.id and substitute_material_id = p_material) then
    raise exception 'BOM_SUBSTITUTE_DUPLICATE' using errcode = '23505';
  end if;
  insert into public.bom_line_substitutions (id, company_id, version_id, line_id, substitute_material_id, factor, reason)
  values (v_id, v_co, v.id, l.id, p_material, p_factor, btrim(p_reason));
  perform private.write_audit(v_co, 'bom.substitute_add', 'bom', v.bom_id::text, null, null,
    jsonb_build_object('line', l.id, 'substitute', sm.code, 'factor', p_factor), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

create function public.bom_line_substitute_remove(p_substitution uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.bom_line_substitutions%rowtype; v public.bom_versions%rowtype;
begin
  perform private.require_perm('bom.write');
  select * into s from public.bom_line_substitutions where id = p_substitution and company_id = v_co;
  if not found then raise exception 'BOM_SUBSTITUTE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v from public.bom_versions where id = s.version_id for update;
  perform private.bom_assert_writable(v.bom_id);
  if v.status <> 'draft' then raise exception 'BOM_BAD_STATUS' using errcode = '55000'; end if;
  delete from public.bom_line_substitutions where id = s.id;
  perform private.write_audit(v_co, 'bom.substitute_remove', 'bom', v.bom_id::text, null, jsonb_build_object('substitute', s.substitute_material_id::text), null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Copie d'une version : lignes, attributs, substitutions, opérations, coûts (0008 + attributs et substitutions)
-- ---------------------------------------------------------------------------
create or replace function private.bom_copy_content(p_from uuid, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('bom.rpc', true), 'off'); l record; v_new uuid; v_bom uuid := (select bom_id from public.bom_versions where id = p_to);
begin
  perform set_config('bom.rpc', 'on', true);
  for l in select * from public.bom_lines where version_id = p_from order by pos, id loop
    insert into public.bom_lines (company_id, bom_id, version_id, pos, line_type, material_id, child_bom_id, quantity, waste_pct, note)
    values (l.company_id, v_bom, p_to, l.pos, l.line_type, l.material_id, l.child_bom_id, l.quantity, l.waste_pct, l.note)
    returning id into v_new;
    insert into public.bom_line_attributes (line_id, company_id, version_id, unit, size_code, color_name)
    select v_new, l.company_id, p_to, a.unit, a.size_code, a.color_name from public.bom_line_attributes a where a.line_id = l.id;
    insert into public.bom_line_substitutions (company_id, version_id, line_id, substitute_material_id, factor, reason)
    select s.company_id, p_to, v_new, s.substitute_material_id, s.factor, s.reason from public.bom_line_substitutions s where s.line_id = l.id;
  end loop;
  insert into public.bom_operations (company_id, bom_id, version_id, pos, name, minutes, note)
  select o.company_id, (select bom_id from public.bom_versions where id = p_to), p_to, o.pos, o.name, o.minutes, o.note
  from public.bom_operations o where o.version_id = p_from;
  update public.bom_version_costs t set hourly_rate = s.hourly_rate, overhead_pct = s.overhead_pct
  from public.bom_version_costs s where s.version_id = p_from and t.version_id = p_to;
  perform set_config('bom.rpc', v_prev, true);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Figure de la version à chaque lancement d'OF
-- ---------------------------------------------------------------------------
create function private.production_freeze_bom(p_order uuid, p_company uuid, p_article uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.boms%rowtype; v_lines jsonb;
begin
  select * into b from public.boms where article_id = p_article and company_id = p_company and kind = 'product'
    and archived_at is null and active_version_id is not null limit 1;
  if not found then
    insert into public.production_order_bom (company_id, order_id, status, lines) values (p_company, p_order, 'no_bom', '[]'::jsonb);
    return;
  end if;
  with recursive t(version_id, mult, depth) as (
    select b.active_version_id, 1::numeric, 0
    union all
    select cb.active_version_id, t.mult * l.quantity, t.depth + 1
    from t
    join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null
    where t.depth < 8
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'line_id', l.id, 'version_id', t.version_id, 'material_id', l.material_id, 'mult', t.mult, 'quantity', l.quantity,
      'waste_pct', l.waste_pct, 'material_unit', m.unit, 'unit', coalesce(a.unit, m.unit),
      'factor', private.bom_unit_factor(l.material_id, coalesce(a.unit, m.unit)),
      'size_code', a.size_code, 'color_name', a.color_name,
      'substitutes', (select coalesce(jsonb_agg(jsonb_build_object('material_id', s.substitute_material_id, 'factor', s.factor, 'reason', s.reason)
                                                 order by s.created_at), '[]'::jsonb)
                      from public.bom_line_substitutions s where s.line_id = l.id)) order by l.pos, l.id), '[]'::jsonb)
    into v_lines
    from t
    join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'material'
    join public.bom_materials m on m.id = l.material_id
    left join public.bom_line_attributes a on a.line_id = l.id;
  insert into public.production_order_bom (company_id, order_id, status, bom_id, version_id, version_no, effective_from, lines)
  select p_company, p_order, 'frozen', b.id, b.active_version_id, v.version_no, v.effective_from, v_lines
  from public.bom_versions v where v.id = b.active_version_id;
  perform private.write_audit(p_company, 'production.bom_freeze', 'production', p_order::text, null, null,
    jsonb_build_object('bom', b.code, 'version_id', b.active_version_id), '{}'::jsonb, 'trigger');
end $$;
revoke execute on function private.production_freeze_bom(uuid, uuid, uuid) from public, anon, authenticated;

create function private.production_orders_bom_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.production_freeze_bom(new.id, new.company_id, new.article_id);
  return new;
end $$;
create trigger production_orders_bom_freeze_au after update of status on public.production_orders
  for each row when (old.status is distinct from new.status and new.status = 'launched')
  execute function private.production_orders_bom_freeze();

-- ---------------------------------------------------------------------------
-- 6. Besoins d'un OF sur sa version figée
-- ---------------------------------------------------------------------------
create function public.production_order_requirements(p_order uuid, p_size text default null, p_color text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; s public.production_order_bom%rowtype;
  v_restricted jsonb; v_lines jsonb; v_mat jsonb; v_missing int;
begin
  perform private.require_perm('bom.read');
  select * into o from public.production_orders where id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into s from public.production_order_bom where order_id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_BOM_SNAPSHOT_MISSING' using errcode = '55000'; end if;
  if s.status = 'no_bom' then return jsonb_build_object('order', o.number, 'status', 'no_bom', 'lines', '[]'::jsonb, 'materials', '[]'::jsonb); end if;
  select count(*) into v_missing from jsonb_to_recordset(s.lines) as x(factor numeric) where x.factor is null;
  if v_missing > 0 then raise exception 'BOM_UNIT_CONVERSION_MISSING' using errcode = '22023'; end if;
  -- Lignes restreintes à une taille ou couleur : non comptées si cette taille / couleur n'est pas précisée
  select coalesce(jsonb_agg(x.line_id), '[]'::jsonb) into v_restricted
  from jsonb_to_recordset(s.lines) as x(line_id uuid, size_code text, color_name text)
  where (x.size_code is not null and (p_size is null or upper(btrim(p_size)) <> upper(btrim(x.size_code))))
     or (x.color_name is not null and (p_color is null or lower(btrim(p_color)) <> lower(btrim(x.color_name))));
  -- Besoin par ligne : quantité planifiée × multiplicateur × quantité × conversion × (1 + perte) ; substitutions listées, non additionnées
  select coalesce(jsonb_agg(jsonb_build_object('line_id', x.line_id, 'material_id', x.material_id, 'qty', l.qty, 'substitutes', x.substitutes)
           order by x.material_id), '[]'::jsonb) into v_lines
  from jsonb_to_recordset(s.lines) as x(line_id uuid, material_id uuid, mult numeric, quantity numeric, waste_pct numeric, factor numeric, size_code text, color_name text, substitutes jsonb)
  cross join lateral (select o.qty_planned * x.mult * x.quantity * x.factor * (1 + x.waste_pct / 100) as qty) l
  where not (x.line_id in (select jsonb_array_elements_text(v_restricted)::uuid));
  -- Total par matière principale
  select coalesce(jsonb_agg(jsonb_build_object('material_id', t.material_id, 'qty', t.qty) order by t.material_id), '[]'::jsonb) into v_mat
  from (select (e ->> 'material_id')::uuid as material_id, sum((e ->> 'qty')::numeric) as qty
        from jsonb_array_elements(v_lines) e group by (e ->> 'material_id')::uuid) t;
  return jsonb_build_object('order', o.number, 'status', 'frozen', 'version_no', s.version_no, 'effective_from', s.effective_from,
    'size', p_size, 'color', p_color, 'restricted_lines', v_restricted, 'lines', v_lines, 'materials', v_mat);
end $$;

-- Validation (0008) redéfinie : séparation des tâches, conversions, restrictions, substitutions archivées, date d'effet.
create or replace function public.bom_validate_version(p_version uuid, p_comment text default null) returns void
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

  -- Séparation des tâches : le validateur n'est pas le rédacteur de la version
  if auth.uid() is null or auth.uid() = v.created_by then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  -- Conversions : toute ligne saisie dans une autre unité que celle de la matière doit avoir sa conversion
  select string_agg(m.code || ' (' || a.unit || ')', ', ') into v_bad from public.bom_line_attributes a
   join public.bom_lines l on l.id = a.line_id join public.bom_materials m on m.id = l.material_id
   where a.version_id = p_version and a.unit is not null and private.bom_unit_factor(l.material_id, a.unit) is null;
  if v_bad is not null then raise exception 'BOM_UNIT_CONVERSION_MISSING' using errcode = '55000', detail = v_bad; end if;
  -- Restrictions : taille et couleur connues de la société
  if exists (select 1 from public.bom_line_attributes a where a.version_id = p_version and a.size_code is not null
             and not exists (select 1 from public.sizes z where z.company_id = v.company_id and upper(z.code) = upper(a.size_code))) then
    raise exception 'BOM_ATTRIBUTE_UNKNOWN' using errcode = '22023';
  end if;
  if exists (select 1 from public.bom_line_attributes a where a.version_id = p_version and a.color_name is not null
             and not exists (select 1 from public.colors z where z.company_id = v.company_id and lower(btrim(z.name)) = lower(btrim(a.color_name)))) then
    raise exception 'BOM_ATTRIBUTE_UNKNOWN' using errcode = '22023';
  end if;
  -- Substitutions : aucune matière de remplacement archivée
  select string_agg(m.code, ', ') into v_bad from public.bom_line_substitutions s join public.bom_materials m on m.id = s.substitute_material_id
   where s.version_id = p_version and m.archived_at is not null;
  if v_bad is not null then raise exception 'BOM_MATERIAL_ARCHIVED' using errcode = '55000', detail = v_bad; end if;

  v_calc := private.bom_calc(p_version);
  if jsonb_array_length(v_calc -> 'missing') > 0 then
    raise exception 'BOM_PRICE_MISSING' using errcode = '55000', detail = (select string_agg(x, ', ') from jsonb_array_elements_text(v_calc -> 'missing') x);
  end if;

  perform set_config('bom.rpc', 'on', true);
  update public.bom_versions set status = 'obsolete' where bom_id = v.bom_id and status = 'validated';
  update public.bom_versions set status = 'validated', validated_by = auth.uid(), validated_at = now(), effective_from = current_date,
         validation_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_version;
  update public.bom_version_costs set snap_material = (v_calc ->> 'material')::numeric, snap_labor = (v_calc ->> 'labor')::numeric,
         snap_overhead = (v_calc ->> 'overhead')::numeric, snap_total = (v_calc ->> 'total')::numeric, frozen_at = now() where version_id = p_version;
  perform set_config('bom.rpc', 'off', true);
  perform private.bom_refresh(v.bom_id);   -- (la validation est tracée par le trigger d'audit des versions)
end $$;

-- ---------------------------------------------------------------------------
-- 7. Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.bom_unit_conversion_set(uuid, text, text, numeric), public.bom_line_set_attributes(uuid, text, text, text),
  public.bom_line_substitute_add(uuid, uuid, numeric, text), public.bom_line_substitute_remove(uuid),
  public.production_order_requirements(uuid, text, text) from public, anon;
grant execute on function public.bom_unit_conversion_set(uuid, text, text, numeric), public.bom_line_set_attributes(uuid, text, text, text),
  public.bom_line_substitute_add(uuid, uuid, numeric, text), public.bom_line_substitute_remove(uuid),
  public.production_order_requirements(uuid, text, text) to authenticated;
