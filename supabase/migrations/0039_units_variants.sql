-- =====================================================================
-- 0039_units_variants — Unités explicites, rouleaux, conversions sans invention, SKU historiques (P016)
--  Socle conservé : sizes / colors / product_variants (0015), composants et unités (0008 : bom_materials.unit, verrouillé
--  quand le composant est utilisé), statut produit (0013 : draft / active / archived), stock variantes (quantités entières).
--  Ajouts :
--    measurement_units         : référentiel des unités (pc, m, cm, m2, kg, g, roll) avec leur dimension
--    bom_materials.unit        : la liste fermée devient une clé étrangère vers measurement_units (même valeurs existantes)
--    bom_materials roll/width/grammage : caractéristiques explicites (longueur d'un rouleau, largeur, grammage)
--    unit_conversions_standard : seules conversions métriques exactes (cm↔m, g↔kg)
--    material_unit_conversions : conversions saisies explicitement pour un composant, avec leur base (source)
--    unit_factor / unit_convert: résolvent un facteur ; rien d'inventé : kg↔m et m2↔kg exigent largeur et grammage ;
--                                 rouleau↔m exige la longueur du rouleau ; sinon UNIT_CONVERSION_MISSING
--    sku_history               : tout SKU jamais attribué, conservé même si la variante est supprimée : jamais réattribué
--    SKU immuable              : un SKU attribué ne se modifie plus ; une variante désactivée garde son SKU
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Référentiel des unités
-- ---------------------------------------------------------------------
create table public.measurement_units (
  code       text primary key check (code ~ '^[a-z0-9]{1,8}$'),
  label      text not null,
  dimension  text not null check (dimension in ('count', 'length', 'area', 'weight', 'packaging'))
);
insert into public.measurement_units (code, label, dimension) values
  ('pc', 'Pièce', 'count'),
  ('cm', 'Centimètre', 'length'),
  ('m', 'Mètre', 'length'),
  ('m2', 'Mètre carré', 'area'),
  ('g', 'Gramme', 'weight'),
  ('kg', 'Kilogramme', 'weight'),
  ('roll', 'Rouleau (longueur explicite)', 'packaging');
alter table public.measurement_units enable row level security;
create policy measurement_units_select on public.measurement_units for select to authenticated using (true);
revoke all on public.measurement_units from anon, authenticated;
grant select on public.measurement_units to authenticated;
grant all on public.measurement_units to service_role;

-- ---------------------------------------------------------------------
-- 2. Composants : unité référencée, caractéristiques explicites
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.bom_materials'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%unit%' loop
    execute format('alter table public.bom_materials drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.bom_materials
  add constraint bom_materials_unit_fk foreign key (unit) references public.measurement_units(code),
  add column roll_length_m numeric(10,2) check (roll_length_m is null or roll_length_m > 0),
  add column width_m numeric(6,3) check (width_m is null or width_m > 0),
  add column grammage_g_m2 numeric(8,2) check (grammage_g_m2 is null or grammage_g_m2 > 0),
  add constraint bom_materials_roll_ck check (unit <> 'roll' or roll_length_m is not null);

-- ---------------------------------------------------------------------
-- 3. Conversions : standard (métrique exact) et explicites par composant
-- ---------------------------------------------------------------------
create table public.unit_conversions_standard (
  from_unit text not null references public.measurement_units(code),
  to_unit   text not null references public.measurement_units(code),
  factor    numeric(18,8) not null check (factor > 0),
  primary key (from_unit, to_unit),
  check (from_unit <> to_unit)
);
insert into public.unit_conversions_standard (from_unit, to_unit, factor) values
  ('cm', 'm', 0.01), ('m', 'cm', 100), ('g', 'kg', 0.001), ('kg', 'g', 1000);
alter table public.unit_conversions_standard enable row level security;
create policy unit_conversions_standard_select on public.unit_conversions_standard for select to authenticated using (true);
revoke all on public.unit_conversions_standard from anon, authenticated;
grant select on public.unit_conversions_standard to authenticated;
grant all on public.unit_conversions_standard to service_role;

create table public.material_unit_conversions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  material_id uuid not null references public.bom_materials(id),
  from_unit   text not null references public.measurement_units(code),
  to_unit     text not null references public.measurement_units(code),
  factor      numeric(18,8) not null check (factor > 0),
  basis       text not null check (length(btrim(basis)) between 5 and 300),   -- source de la valeur (fiche technique, mesure…)
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (material_id, from_unit, to_unit),
  check (from_unit <> to_unit)
);
alter table public.material_unit_conversions enable row level security;
create policy material_unit_conversions_select on public.material_unit_conversions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('bom.read'));
revoke all on public.material_unit_conversions from anon, authenticated;
grant select on public.material_unit_conversions to authenticated;
grant all on public.material_unit_conversions to service_role;

-- Facteur de conversion : multiplie une quantité exprimée dans from_unit pour obtenir to_unit.
-- Ordre : identité, standard métrique, conversion explicite, puis dérivée des caractéristiques du composant.
create function public.unit_factor(p_material uuid, p_from text, p_to text) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare m public.bom_materials%rowtype; f numeric; v_co uuid := private.current_company();
begin
  if p_from = p_to then return 1; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_from not in (select code from public.measurement_units) or p_to not in (select code from public.measurement_units) then
    raise exception 'UNIT_UNKNOWN' using errcode = '22023';
  end if;
  select factor into f from public.unit_conversions_standard where from_unit = p_from and to_unit = p_to;
  if found then return f; end if;
  select factor into f from public.material_unit_conversions where material_id = p_material and from_unit = p_from and to_unit = p_to;
  if found then return f; end if;
  -- rouleau ↔ mètre : longueur du rouleau (caractéristique du composant)
  if p_from = 'roll' and p_to = 'm' and m.roll_length_m is not null then return m.roll_length_m; end if;
  if p_from = 'm' and p_to = 'roll' and m.roll_length_m is not null then return 1 / m.roll_length_m; end if;
  -- masse ↔ surface / longueur : seulement avec grammage (et largeur pour les mètres linéaires)
  if p_from = 'm2' and p_to = 'kg' and m.grammage_g_m2 is not null then return m.grammage_g_m2 / 1000; end if;
  if p_from = 'kg' and p_to = 'm2' and m.grammage_g_m2 is not null then return 1000 / m.grammage_g_m2; end if;
  if p_from = 'm' and p_to = 'kg' and m.grammage_g_m2 is not null and m.width_m is not null then return m.width_m * m.grammage_g_m2 / 1000; end if;
  if p_from = 'kg' and p_to = 'm' and m.grammage_g_m2 is not null and m.width_m is not null then return 1000 / (m.width_m * m.grammage_g_m2); end if;
  raise exception 'UNIT_CONVERSION_MISSING' using errcode = '22023', detail = p_from || '->' || p_to;
end $$;
grant execute on function public.unit_factor(uuid, text, text) to authenticated, service_role;

create function public.unit_convert(p_material uuid, p_qty numeric, p_from text, p_to text) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(p_qty * public.unit_factor(p_material, p_from, p_to), 6)
$$;
grant execute on function public.unit_convert(uuid, numeric, text, text) to authenticated, service_role;

-- Conversion explicite saisie par une personne habilitée, avec sa base. Le composant doit exister dans la société.
create function public.material_conversion_set(p_material uuid, p_from text, p_to text, p_factor numeric, p_basis text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('bom.write');
  if not exists (select 1 from public.bom_materials where id = p_material and company_id = v_co) then raise exception 'MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_from = p_to then raise exception 'UNIT_SAME' using errcode = '22023'; end if;
  if p_factor is null or p_factor <= 0 then raise exception 'UNIT_BAD_FACTOR' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_basis, ''))) < 5 then raise exception 'UNIT_BASIS_REQUIRED' using errcode = '22023'; end if;
  insert into public.material_unit_conversions (company_id, material_id, from_unit, to_unit, factor, basis)
  values (v_co, p_material, p_from, p_to, p_factor, btrim(p_basis))
  on conflict (material_id, from_unit, to_unit) do update set factor = excluded.factor, basis = excluded.basis, created_at = now();
  perform private.write_audit(v_co, 'material.conversion_set', 'material', p_material::text, p_from || ' → ' || p_to, null,
    jsonb_build_object('factor', p_factor, 'basis', btrim(p_basis)), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.material_conversion_set(uuid, text, text, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Historique des SKU : jamais réattribué, même après suppression
-- ---------------------------------------------------------------------
create table public.sku_history (
  company_id  uuid not null references public.companies(id),
  sku_key     text not null,                 -- SKU normalisé (majuscules, sans espaces)
  variant_id  uuid,                          -- identifiant de la variante d'origine (conservé même supprimée)
  first_seen  timestamptz not null default now(),
  primary key (company_id, sku_key)
);
alter table public.sku_history enable row level security;
create policy sku_history_select on public.sku_history for select to authenticated
  using (company_id = private.current_company() and private.has_perm('variants.read'));
revoke all on public.sku_history from anon, authenticated;
grant select on public.sku_history to authenticated;
grant all on public.sku_history to service_role;

insert into public.sku_history (company_id, sku_key, variant_id)
select v.company_id, upper(btrim(v.sku)), v.id from public.product_variants v
on conflict (company_id, sku_key) do nothing;

create function private.variant_sku_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.sku := upper(btrim(new.sku));
    if exists (select 1 from public.sku_history h where h.company_id = new.company_id and h.sku_key = new.sku) then
      raise exception 'SKU_HISTORICAL' using errcode = '23505', detail = new.sku;
    end if;
    insert into public.sku_history (company_id, sku_key, variant_id) values (new.company_id, new.sku, new.id);
  elsif tg_op = 'UPDATE' then
    if new.sku is distinct from old.sku then raise exception 'SKU_IMMUTABLE' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger product_variants_sku_guard_iu before insert or update on public.product_variants
  for each row execute function private.variant_sku_guard();

-- Caractéristiques saisies comme les autres colonnes du composant (privilèges par colonne, voir 0008)
grant insert (roll_length_m, width_m, grammage_g_m2) on public.bom_materials to authenticated;
grant update (roll_length_m, width_m, grammage_g_m2) on public.bom_materials to authenticated;
