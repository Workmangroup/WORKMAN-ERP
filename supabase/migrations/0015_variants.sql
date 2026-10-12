-- =====================================================================
-- 0015_variants — Module Variantes Textile
--  Déclinaisons taille × couleur d'un produit (PDM) : catalogues de tailles et de couleurs, variantes (SKU, code-barres GTIN,
--  prix, nomenclature propre à la variante), stock fini par variante et par entrepôt avec mouvements (append-only),
--  matrice taille/couleur (RPC variant_matrix), génération de la matrice, import depuis la fiche technique du PDM.
--  Tables : sizes, colors, product_variants, variant_stock (+ variant_stock_moves).
--  Permissions nouvelles : variants.read / variants.write / variants.stock.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('variants.read',  'articles', 'Voir les variantes textile', 'Matrice taille/couleur, prix, codes-barres, stock par variante'),
  ('variants.write', 'articles', 'Gérer les variantes',        'Catalogues tailles/couleurs, génération de la matrice, prix, codes-barres, nomenclature par variante'),
  ('variants.stock', 'articles', 'Mouvements de stock des variantes', 'Entrées, sorties, ajustements, inventaires, transferts, réservations, stock de sécurité')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('variants.read', 'variants.write', 'variants.stock'))
  or (r.code = 'commercial' and p.code in ('variants.read', 'variants.write'))
  or (r.code = 'production' and p.code in ('variants.read', 'variants.write', 'variants.stock'))
  or (r.code = 'magasin'    and p.code in ('variants.read', 'variants.stock'))
  or (r.code in ('direction', 'qualite', 'achat', 'finance') and p.code = 'variants.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Outils : GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) et drapeaux
-- ---------------------------------------------------------------------
create function private.gtin_valid(g text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare n int; i int; s int := 0; d int;
begin
  if g is null or g !~ '^[0-9]+$' or length(g) not in (8, 12, 13, 14) then return false; end if;
  n := length(g);
  for i in 1 .. n - 1 loop
    d := substr(g, n - i, 1)::int;                       -- chiffres de droite à gauche, hors clé
    s := s + d * case when i % 2 = 1 then 3 else 1 end;
  end loop;
  return (10 - s % 10) % 10 = substr(g, n, 1)::int;
end $$;

create function private.variants_flag(p_name text) returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting(p_name, true), 'off') = 'on' $$;

-- ---------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------
create table public.sizes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,11}$'),         -- S, M, XXL, 42…
  label      text not null check (length(btrim(label)) between 1 and 30),
  size_group text not null default 'letters' check (size_group in ('letters', 'numeric', 'other')),
  sort_order int  not null default 100 check (sort_order between 0 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create unique index sizes_code_uq on public.sizes (company_id, upper(code));

create table public.colors (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null check (code ~ '^[A-Z0-9]{1,10}$'),                          -- JAU, MAR…
  name       text not null check (length(btrim(name)) between 1 and 60),
  hex        text check (hex is null or hex ~ '^#[0-9a-fA-F]{6}$'),
  pantone    text check (pantone is null or length(pantone) <= 30),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create unique index colors_code_uq on public.colors (company_id, code);
create unique index colors_name_uq on public.colors (company_id, lower(btrim(name)));

create table public.product_variants (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  product_id uuid not null references public.product_master(id) on delete cascade,
  color_id   uuid not null references public.colors(id),
  size_id    uuid not null references public.sizes(id),
  sku        text not null check (length(btrim(sku)) between 3 and 40),
  barcode    text check (barcode is null or private.gtin_valid(barcode)),
  price      numeric(14,2) check (price is null or (price >= 0 and price < 1000000000)),    -- prix de vente HT
  currency   char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  bom_id     uuid references public.boms(id) on delete set null,        -- nomenclature propre à la variante (sinon celle de l'article du produit)
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (product_id, color_id, size_id)
);
create unique index product_variants_sku_uq on public.product_variants (company_id, upper(sku));
create unique index product_variants_barcode_uq on public.product_variants (company_id, barcode) where barcode is not null;
create index product_variants_idx on public.product_variants (product_id, active);

create table public.variant_stock (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  variant_id   uuid not null references public.product_variants(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  qty_on_hand  int not null default 0 check (qty_on_hand >= 0),
  qty_reserved int not null default 0 check (qty_reserved >= 0),
  safety_qty   int not null default 0 check (safety_qty >= 0),
  updated_at   timestamptz not null default now(),
  unique (variant_id, warehouse_id),
  constraint variant_stock_reserved_ck check (qty_reserved <= qty_on_hand)
);

create table public.variant_stock_moves (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  variant_id     uuid not null references public.product_variants(id),
  warehouse_id   uuid not null references public.warehouses(id),
  move_type      text not null check (move_type in ('receipt', 'issue', 'adjustment', 'inventory', 'transfer_in', 'transfer_out')),
  qty_delta      int not null check (qty_delta <> 0),
  balance_after  int not null check (balance_after >= 0),
  reason         text check (reason is null or length(reason) <= 200),
  reference      text check (reference is null or length(reference) <= 80),
  transfer_group uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid
);
create index variant_moves_idx on public.variant_stock_moves (variant_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Catalogues par défaut
-- ---------------------------------------------------------------------
create function private.variants_seed(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sizes (company_id, code, label, size_group, sort_order)
  select p_company, c, c, 'letters', o from (values ('XS', 10), ('S', 20), ('M', 30), ('L', 40), ('XL', 50), ('XXL', 60), ('3XL', 70), ('4XL', 80)) v(c, o)
  on conflict do nothing;
  insert into public.sizes (company_id, code, label, size_group, sort_order)
  select p_company, n::text, n::text, 'numeric', 200 + n from generate_series(36, 60, 2) n
  on conflict do nothing;
  insert into public.colors (company_id, code, name, hex)
  select p_company, c, n, h from (values ('JAU', 'Jaune HV', '#e6e600'), ('ORA', 'Orange HV', '#ff6600'), ('MAR', 'Marine', '#1f3a5f'), ('NOI', 'Noir', '#111111'),
    ('GRI', 'Gris', '#808080'), ('VER', 'Vert bouteille', '#1e5631'), ('ROU', 'Rouge', '#c00000'), ('BLE', 'Bleu roi', '#1b4fa3'), ('BLA', 'Blanc', '#ffffff'), ('BEI', 'Beige', '#d8c3a5')) v(c, n, h)
  on conflict do nothing;
end $$;
revoke execute on function private.variants_seed(uuid) from public, anon, authenticated;
select private.variants_seed(id) from public.companies;

-- ---------------------------------------------------------------------
-- 5. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.sizes_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(private.current_company(), new.company_id); new.created_by := auth.uid();
  elsif new.company_id is distinct from old.company_id then raise exception 'VARIANT_REF_LOCKED' using errcode = '42501';
  else new.updated_at := now(); end if;
  new.code := upper(btrim(new.code)); new.label := btrim(new.label);
  return new;
end $$;
create trigger sizes_before_iu before insert or update on public.sizes for each row execute function private.sizes_before();

create function private.colors_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(private.current_company(), new.company_id); new.created_by := auth.uid();
  elsif new.company_id is distinct from old.company_id then raise exception 'VARIANT_REF_LOCKED' using errcode = '42501';
  else new.updated_at := now(); end if;
  new.code := upper(btrim(new.code)); new.name := btrim(new.name);
  return new;
end $$;
create trigger colors_before_iu before insert or update on public.colors for each row execute function private.colors_before();

create function private.variants_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; c public.colors%rowtype; s public.sizes%rowtype; b public.boms%rowtype;
begin
  select * into p from public.product_master where id = new.product_id;
  if not found then raise exception 'VARIANT_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status = 'archived' and not private.variants_flag('variants.bulk') and not private.variants_flag('variants.rpc') then raise exception 'VARIANT_PRODUCT_ARCHIVED' using errcode = '55000'; end if;
  new.company_id := p.company_id;
  if tg_op = 'INSERT' then
    select * into c from public.colors where id = new.color_id and company_id = p.company_id;
    select * into s from public.sizes  where id = new.size_id  and company_id = p.company_id;
    if c.id is null or s.id is null then raise exception 'VARIANT_BAD_ATTRIBUTE' using errcode = '22023'; end if;
    if not c.active or not s.active then raise exception 'VARIANT_ATTRIBUTE_INACTIVE' using errcode = '55000'; end if;
    if nullif(btrim(coalesce(new.sku, '')), '') is null then
      new.sku := upper(regexp_replace(p.code || '-' || c.code || '-' || s.code, '[^A-Za-z0-9-]', '', 'g'));
    end if;
    new.sku := upper(btrim(new.sku)); new.created_by := auth.uid(); new.updated_by := auth.uid();
  else
    if new.product_id is distinct from old.product_id or new.color_id is distinct from old.color_id or new.size_id is distinct from old.size_id or new.sku is distinct from old.sku then
      raise exception 'VARIANT_REF_LOCKED' using errcode = '42501';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  if new.bom_id is not null and (tg_op = 'INSERT' or new.bom_id is distinct from old.bom_id) then
    select * into b from public.boms where id = new.bom_id and company_id = p.company_id;
    if b.id is null or b.kind <> 'product' or b.archived_at is not null
       or (b.article_id is not null and not exists (select 1 from public.articles a where a.id = b.article_id and a.client_id = p.client_id)) then
      raise exception 'VARIANT_BAD_BOM' using errcode = '22023';       -- nomenclature produit, non archivée, du même client (ou sans article)
    end if;
  end if;
  new.currency := upper(new.currency);
  return new;
end $$;
create trigger variants_before_iu before insert or update on public.product_variants for each row execute function private.variants_before();

-- ---------------------------------------------------------------------
-- 6. Historique (entity_type 'variant' → id du produit ; 'variant_catalog')
-- ---------------------------------------------------------------------
create function private.audit_variants() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_chg jsonb; v_sku text;
begin
  if private.variants_flag('variants.bulk') or private.variants_flag('variants.rpc') then return coalesce(new, old); end if;
  select code into v_code from public.product_master where id = coalesce(new.product_id, old.product_id);
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'variant.add', 'variant', new.product_id::text, v_code, null, jsonb_build_object('sku', new.sku, 'price', new.price), jsonb_build_object('sku', new.sku));
  elsif tg_op = 'UPDATE' then
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('price','currency','barcode','bom_id','active')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'variant.update', 'variant', new.product_id::text, v_code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('sku', new.sku));
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_variants_iu after insert or update on public.product_variants for each row execute function private.audit_variants();

create function private.audit_variant_catalog() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text := case tg_table_name when 'sizes' then 'size' else 'color' end; v_chg jsonb; v_label text;
begin
  v_label := case when tg_table_name = 'sizes' then new.code else new.code end;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'variant.' || v_kind || '_add', 'variant_catalog', new.id::text, v_label, null, to_jsonb(new) - 'id' - 'company_id' - 'created_at' - 'updated_at' - 'created_by', '{}');
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k in ('id','company_id','created_at','updated_at','created_by')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'variant.' || v_kind || '_update', 'variant_catalog', new.id::text, v_label, v_chg -> 'before', v_chg -> 'after', '{}');
    end if;
  end if;
  return new;
end $$;
create trigger audit_sizes_iu after insert or update on public.sizes for each row execute function private.audit_variant_catalog();
create trigger audit_colors_iu after insert or update on public.colors for each row execute function private.audit_variant_catalog();

create policy audit_logs_select_variants on public.audit_logs for select to authenticated
  using (entity_type in ('variant', 'variant_catalog') and company_id = private.current_company() and private.has_perm('variants.read'));

-- ---------------------------------------------------------------------
-- 7. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.sizes               enable row level security;
alter table public.colors              enable row level security;
alter table public.product_variants    enable row level security;
alter table public.variant_stock       enable row level security;
alter table public.variant_stock_moves enable row level security;

revoke all on public.sizes, public.colors, public.product_variants, public.variant_stock, public.variant_stock_moves from anon, authenticated;
grant all on public.sizes, public.colors, public.product_variants, public.variant_stock, public.variant_stock_moves to service_role;
grant select on public.sizes, public.colors, public.product_variants, public.variant_stock, public.variant_stock_moves to authenticated;
grant insert (code, label, size_group, sort_order, active) on public.sizes to authenticated;
grant update (label, size_group, sort_order, active) on public.sizes to authenticated;
grant delete on public.sizes to authenticated;
grant insert (code, name, hex, pantone, active) on public.colors to authenticated;
grant update (name, hex, pantone, active) on public.colors to authenticated;
grant delete on public.colors to authenticated;
grant insert (product_id, color_id, size_id, sku, barcode, price, currency, bom_id, active) on public.product_variants to authenticated;
grant update (barcode, price, currency, bom_id, active) on public.product_variants to authenticated;

create policy sizes_select on public.sizes for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy sizes_insert on public.sizes for insert to authenticated with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy sizes_update on public.sizes for update to authenticated using (company_id = private.current_company() and private.has_perm('variants.write')) with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy sizes_delete on public.sizes for delete to authenticated using (company_id = private.current_company() and private.has_perm('variants.write'));
create policy colors_select on public.colors for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy colors_insert on public.colors for insert to authenticated with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy colors_update on public.colors for update to authenticated using (company_id = private.current_company() and private.has_perm('variants.write')) with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy colors_delete on public.colors for delete to authenticated using (company_id = private.current_company() and private.has_perm('variants.write'));
create policy variants_select on public.product_variants for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy variants_insert on public.product_variants for insert to authenticated with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy variants_update on public.product_variants for update to authenticated using (company_id = private.current_company() and private.has_perm('variants.write')) with check (company_id = private.current_company() and private.has_perm('variants.write'));
create policy variant_stock_select on public.variant_stock for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));
create policy variant_moves_select on public.variant_stock_moves for select to authenticated using (company_id = private.current_company() and private.has_perm('variants.read'));

-- ---------------------------------------------------------------------
-- 8. RPC : catalogues, matrice, import de la fiche technique, mise à jour groupée, codes-barres, suppression
-- ---------------------------------------------------------------------
create function public.variants_seed_defaults() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('variants.write');
  perform private.variants_seed(private.current_company());
end $$;

create function private.variant_product(p_product uuid, p_allow_archived boolean default false) returns public.product_master
language plpgsql stable security definer set search_path = '' as $$
declare p public.product_master%rowtype;
begin
  select * into p from public.product_master where id = p_product and company_id = private.current_company();
  if not found then raise exception 'VARIANT_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status = 'archived' and not p_allow_archived then raise exception 'VARIANT_PRODUCT_ARCHIVED' using errcode = '55000'; end if;
  return p;
end $$;
revoke execute on function private.variant_product(uuid, boolean) from public, anon, authenticated;

-- Génère les combinaisons manquantes couleurs × tailles (idempotent)
create function public.variant_generate(p_product uuid, p_colors uuid[], p_sizes uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; v_n int := 0; r record;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  if coalesce(cardinality(p_colors), 0) = 0 or coalesce(cardinality(p_sizes), 0) = 0 then raise exception 'VARIANT_EMPTY_SELECTION' using errcode = '22023'; end if;
  if cardinality(p_colors) * cardinality(p_sizes) > 400 then raise exception 'VARIANT_TOO_MANY' using errcode = '22023'; end if;
  perform set_config('variants.bulk', 'on', true);
  for r in select c.id cid, s.id sid from public.colors c cross join public.sizes s
           where c.id = any (p_colors) and s.id = any (p_sizes) and c.company_id = p.company_id and s.company_id = p.company_id and c.active and s.active
           order by c.name, s.sort_order loop
    if not exists (select 1 from public.product_variants where product_id = p_product and color_id = r.cid and size_id = r.sid) then
      insert into public.product_variants (product_id, color_id, size_id) values (p_product, r.cid, r.sid);
      v_n := v_n + 1;
    end if;
  end loop;
  perform set_config('variants.bulk', 'off', true);
  if v_n > 0 then
    perform private.write_audit(p.company_id, 'variant.generate', 'variant', p.id::text, p.code, null, null, jsonb_build_object('created', v_n, 'colors', cardinality(p_colors), 'sizes', cardinality(p_sizes)), 'rpc');
  end if;
  return v_n;
end $$;

-- Importe couleurs, tailles et variantes depuis la fiche technique (version de référence du PDM)
create function public.variant_sync_from_spec(p_product uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; v_spec jsonb; e jsonb; rr record; v_cid uuid; v_sid uuid; v_code text; v_i int;
  n_colors int := 0; n_sizes int := 0; n_variants int := 0; v_bar text; v_sku text;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  select spec into v_spec from public.product_versions where id = coalesce(p.active_version_id, p.current_version_id);
  if v_spec is null then raise exception 'VARIANT_NO_SPEC' using errcode = '55000'; end if;
  perform set_config('variants.bulk', 'on', true);
  for e in select * from jsonb_array_elements(v_spec -> 'colors') loop
    if not exists (select 1 from public.colors where company_id = p.company_id and lower(btrim(name)) = lower(btrim(e ->> 'name'))) then
      v_code := coalesce(nullif(upper(left(regexp_replace(e ->> 'name', '[^A-Za-z0-9]', '', 'g'), 3)), ''), 'X'); v_i := 1;
      while exists (select 1 from public.colors where company_id = p.company_id and code = v_code) loop v_i := v_i + 1; v_code := upper(left(regexp_replace(e ->> 'name', '[^A-Za-z0-9]', '', 'g'), 3)) || v_i; end loop;
      insert into public.colors (code, name, hex, pantone) values (v_code, btrim(e ->> 'name'), nullif(e ->> 'hex', ''), nullif(e ->> 'pantone', ''));
      n_colors := n_colors + 1;
    end if;
  end loop;
  for e in select * from jsonb_array_elements(v_spec -> 'sizes') loop
    if not exists (select 1 from public.sizes where company_id = p.company_id and upper(code) = upper(btrim(e ->> 'label'))) then
      begin
        insert into public.sizes (code, label, size_group, sort_order) values (upper(btrim(e ->> 'label')), btrim(e ->> 'label'), 'other', 500);
        n_sizes := n_sizes + 1;
      exception when check_violation then null;       -- libellé de taille inutilisable comme code : ignoré
      end;
    end if;
  end loop;
  if jsonb_array_length(coalesce(v_spec -> 'variants', '[]'::jsonb)) > 0 then
    for e in select * from jsonb_array_elements(v_spec -> 'variants') loop
      continue when coalesce((e ->> 'active')::boolean, true) is false;
      select id into v_cid from public.colors where company_id = p.company_id and lower(btrim(name)) = lower(btrim(e ->> 'color'));
      select id into v_sid from public.sizes where company_id = p.company_id and upper(code) = upper(btrim(e ->> 'size'));
      continue when v_cid is null or v_sid is null;
      continue when exists (select 1 from public.product_variants where product_id = p_product and color_id = v_cid and size_id = v_sid);
      v_sku := upper(btrim(e ->> 'sku'));
      if exists (select 1 from public.product_variants where company_id = p.company_id and upper(sku) = v_sku) then v_sku := null; end if;
      v_bar := nullif(e ->> 'barcode', '');
      if v_bar is not null and (not private.gtin_valid(v_bar) or exists (select 1 from public.product_variants where company_id = p.company_id and barcode = v_bar)) then v_bar := null; end if;
      insert into public.product_variants (product_id, color_id, size_id, sku, barcode) values (p_product, v_cid, v_sid, v_sku, v_bar);
      n_variants := n_variants + 1;
    end loop;
  else
    for rr in select c.id cid, s.id sid from public.colors c cross join public.sizes s
             where lower(btrim(c.name)) in (select lower(btrim(x ->> 'name')) from jsonb_array_elements(v_spec -> 'colors') x)
               and upper(s.code) in (select upper(btrim(x ->> 'label')) from jsonb_array_elements(v_spec -> 'sizes') x) and c.company_id = p.company_id and s.company_id = p.company_id loop
      continue when exists (select 1 from public.product_variants where product_id = p_product and color_id = rr.cid and size_id = rr.sid);
      insert into public.product_variants (product_id, color_id, size_id) values (p_product, rr.cid, rr.sid);
      n_variants := n_variants + 1;
    end loop;
  end if;
  perform set_config('variants.bulk', 'off', true);
  perform private.write_audit(p.company_id, 'variant.sync_spec', 'variant', p.id::text, p.code, null, null,
    jsonb_build_object('colors_created', n_colors, 'sizes_created', n_sizes, 'variants_created', n_variants), 'rpc');
  return jsonb_build_object('colors_created', n_colors, 'sizes_created', n_sizes, 'variants_created', n_variants);
end $$;

-- Mise à jour groupée depuis la matrice : [{id, price?, barcode?, active?, bom_id?}] ; seules les clés présentes sont appliquées
create function public.variant_bulk_update(p_product uuid, p_changes jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; e jsonb; v public.product_variants%rowtype; n int := 0; v_log jsonb := '[]'::jsonb; v_new numeric; v_bar text; v_bom uuid; v_act boolean; changed boolean;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 800 then raise exception 'VARIANT_BAD_INPUT' using errcode = '22023'; end if;
  perform set_config('variants.bulk', 'on', true);
  for e in select * from jsonb_array_elements(p_changes) loop
    select * into v from public.product_variants where id = (e ->> 'id')::uuid and product_id = p_product for update;
    if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
    changed := false;
    if e ? 'price' then
      v_new := case when jsonb_typeof(e -> 'price') = 'null' then null else (e ->> 'price')::numeric end;
      if v_new is distinct from v.price then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'price', 'from', v.price, 'to', v_new); update public.product_variants set price = v_new where id = v.id; changed := true;
      end if;
    end if;
    if e ? 'barcode' then
      v_bar := nullif(btrim(coalesce(e ->> 'barcode', '')), '');
      if v_bar is distinct from v.barcode then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'barcode', 'from', v.barcode, 'to', v_bar); update public.product_variants set barcode = v_bar where id = v.id; changed := true;
      end if;
    end if;
    if e ? 'active' then
      v_act := (e ->> 'active')::boolean;
      if v_act is distinct from v.active then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'active', 'from', v.active, 'to', v_act); update public.product_variants set active = v_act where id = v.id; changed := true;
      end if;
    end if;
    if e ? 'bom_id' then
      v_bom := case when jsonb_typeof(e -> 'bom_id') = 'null' then null else (e ->> 'bom_id')::uuid end;
      if v_bom is distinct from v.bom_id then
        v_log := v_log || jsonb_build_object('sku', v.sku, 'field', 'bom_id', 'from', (select code from public.boms where id = v.bom_id), 'to', (select code from public.boms where id = v_bom));
        update public.product_variants set bom_id = v_bom where id = v.id; changed := true;
      end if;
    end if;
    if changed then n := n + 1; end if;
  end loop;
  perform set_config('variants.bulk', 'off', true);
  if n > 0 then
    perform private.write_audit(p.company_id, 'variant.bulk_update', 'variant', p.id::text, p.code, null, null,
      jsonb_build_object('count', n, 'changes', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_log) x limit 100) s)), 'rpc');
  end if;
  return n;
end $$;

-- Codes-barres EAN-13 internes (préfixe 29, diffusion restreinte) pour les variantes actives qui n'en ont pas
create function public.variant_assign_barcodes(p_product uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare p public.product_master%rowtype; r record; v_base text; v_sum int; v_i int; v_n int := 0;
begin
  perform private.require_perm('variants.write');
  p := private.variant_product(p_product);
  perform set_config('variants.bulk', 'on', true);
  for r in select id from public.product_variants where product_id = p_product and active and barcode is null order by sku loop
    v_base := '29' || lpad(private.next_seq(p.company_id, 'barcode')::text, 10, '0');
    v_sum := 0;
    for v_i in 1 .. 12 loop v_sum := v_sum + substr(v_base, v_i, 1)::int * case when v_i % 2 = 1 then 1 else 3 end; end loop;
    update public.product_variants set barcode = v_base || ((10 - v_sum % 10) % 10)::text where id = r.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('variants.bulk', 'off', true);
  if v_n > 0 then perform private.write_audit(p.company_id, 'variant.barcodes', 'variant', p.id::text, p.code, null, null, jsonb_build_object('assigned', v_n), 'rpc'); end if;
  return v_n;
end $$;

create function public.variant_delete(p_variant uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype;
begin
  perform private.require_perm('variants.write');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company() for update;
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  p := private.variant_product(v.product_id);
  if exists (select 1 from public.variant_stock_moves where variant_id = p_variant) or exists (select 1 from public.variant_stock where variant_id = p_variant and (qty_on_hand > 0 or qty_reserved > 0)) then
    raise exception 'VARIANT_HAS_STOCK' using errcode = '23503';      -- une variante avec historique de stock se désactive, elle ne se supprime pas
  end if;
  perform set_config('variants.rpc', 'on', true);
  delete from public.product_variants where id = p_variant;
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.delete', 'variant', p.id::text, p.code, jsonb_build_object('sku', v.sku, 'barcode', v.barcode, 'price', v.price), null, jsonb_build_object('sku', v.sku), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 9. RPC : stock par variante
-- ---------------------------------------------------------------------
create function public.variant_stock_move(p_variant uuid, p_type text, p_warehouse uuid, p_qty int, p_to_warehouse uuid default null, p_reason text default null, p_reference text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype; w public.warehouses%rowtype; w2 public.warehouses%rowtype; s public.variant_stock%rowtype; s2 public.variant_stock%rowtype;
  v_new int; v_delta int; v_group uuid := gen_random_uuid(); v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  perform private.require_perm('variants.stock');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company();
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.product_master where id = v.product_id;
  select * into w from public.warehouses where id = p_warehouse and company_id = v.company_id;
  if not found or w.archived_at is not null then raise exception 'VARIANT_BAD_WAREHOUSE' using errcode = '22023'; end if;
  if p_type not in ('receipt', 'issue', 'adjustment', 'inventory', 'transfer') or p_qty is null then raise exception 'VARIANT_BAD_INPUT' using errcode = '22023'; end if;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, w.id) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = v.id and warehouse_id = w.id for update;
  perform set_config('variants.rpc', 'on', true);

  if p_type = 'receipt' then
    if p_qty <= 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    v_delta := p_qty;
  elsif p_type = 'issue' then
    if p_qty <= 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if p_qty > s.qty_on_hand - s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    v_delta := -p_qty;
  elsif p_type = 'adjustment' then
    if p_qty = 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if v_reason is null then raise exception 'VARIANT_REASON_REQUIRED' using errcode = '22023'; end if;
    if s.qty_on_hand + p_qty < s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    v_delta := p_qty;
  elsif p_type = 'inventory' then
    if p_qty < 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if p_qty < s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    v_delta := p_qty - s.qty_on_hand;
    if v_delta = 0 then raise exception 'VARIANT_NO_CHANGE' using errcode = '22023'; end if;
    v_reason := coalesce(v_reason, 'Inventaire');
  else   -- transfer
    select * into w2 from public.warehouses where id = p_to_warehouse and company_id = v.company_id;
    if not found or w2.archived_at is not null or w2.id = w.id then raise exception 'VARIANT_BAD_WAREHOUSE' using errcode = '22023'; end if;
    if p_qty <= 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
    if p_qty > s.qty_on_hand - s.qty_reserved then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, w2.id) on conflict (variant_id, warehouse_id) do nothing;
    select * into s2 from public.variant_stock where variant_id = v.id and warehouse_id = w2.id for update;
    update public.variant_stock set qty_on_hand = qty_on_hand - p_qty, updated_at = now() where id = s.id;
    update public.variant_stock set qty_on_hand = qty_on_hand + p_qty, updated_at = now() where id = s2.id;
    insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, transfer_group, created_by)
      values (v.company_id, v.id, w.id, 'transfer_out', -p_qty, s.qty_on_hand - p_qty, v_reason, v_ref, v_group, auth.uid()),
             (v.company_id, v.id, w2.id, 'transfer_in', p_qty, s2.qty_on_hand + p_qty, v_reason, v_ref, v_group, auth.uid());
    perform set_config('variants.rpc', 'off', true);
    perform private.write_audit(v.company_id, 'variant.stock_move', 'variant', p.id::text, p.code, null, null,
      jsonb_build_object('sku', v.sku, 'type', 'transfer', 'qty', p_qty, 'from', w.name, 'to', w2.name, 'reason', v_reason, 'reference', v_ref), 'rpc');
    return jsonb_build_object('on_hand', s.qty_on_hand - p_qty, 'reserved', s.qty_reserved, 'available', s.qty_on_hand - p_qty - s.qty_reserved);
  end if;

  v_new := s.qty_on_hand + v_delta;
  update public.variant_stock set qty_on_hand = v_new, updated_at = now() where id = s.id;
  insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, created_by)
    values (v.company_id, v.id, w.id, p_type, v_delta, v_new, v_reason, v_ref, auth.uid());
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.stock_move', 'variant', p.id::text, p.code, null, null,
    jsonb_build_object('sku', v.sku, 'type', p_type, 'qty', v_delta, 'warehouse', w.name, 'balance', v_new, 'reason', v_reason, 'reference', v_ref), 'rpc');
  return jsonb_build_object('on_hand', v_new, 'reserved', s.qty_reserved, 'available', v_new - s.qty_reserved);
end $$;

create function public.variant_stock_reserve(p_variant uuid, p_warehouse uuid, p_delta int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype; s public.variant_stock%rowtype; v_new int;
begin
  perform private.require_perm('variants.stock');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company();
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.product_master where id = v.product_id;
  select * into s from public.variant_stock where variant_id = p_variant and warehouse_id = p_warehouse for update;
  if not found or p_delta is null or p_delta = 0 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
  v_new := s.qty_reserved + p_delta;
  if v_new < 0 or v_new > s.qty_on_hand then raise exception 'VARIANT_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
  perform set_config('variants.rpc', 'on', true);
  update public.variant_stock set qty_reserved = v_new, updated_at = now() where id = s.id;
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.stock_reserve', 'variant', p.id::text, p.code, null, null, jsonb_build_object('sku', v.sku, 'delta', p_delta, 'reserved', v_new), 'rpc');
  return jsonb_build_object('on_hand', s.qty_on_hand, 'reserved', v_new, 'available', s.qty_on_hand - v_new);
end $$;

create function public.variant_stock_set_safety(p_variant uuid, p_warehouse uuid, p_qty int) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.product_variants%rowtype; p public.product_master%rowtype; w public.warehouses%rowtype; s public.variant_stock%rowtype;
begin
  perform private.require_perm('variants.stock');
  select * into v from public.product_variants where id = p_variant and company_id = private.current_company();
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.product_master where id = v.product_id;
  select * into w from public.warehouses where id = p_warehouse and company_id = v.company_id;
  if not found or w.archived_at is not null then raise exception 'VARIANT_BAD_WAREHOUSE' using errcode = '22023'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 10000000 then raise exception 'VARIANT_BAD_QTY' using errcode = '22023'; end if;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, w.id) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = v.id and warehouse_id = w.id for update;
  perform set_config('variants.rpc', 'on', true);
  update public.variant_stock set safety_qty = p_qty, updated_at = now() where id = s.id;
  perform set_config('variants.rpc', 'off', true);
  perform private.write_audit(v.company_id, 'variant.stock_safety', 'variant', p.id::text, p.code, jsonb_build_object('safety', s.safety_qty), jsonb_build_object('safety', p_qty), jsonb_build_object('sku', v.sku, 'warehouse', w.name), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 10. Matrice et vue d'ensemble
-- ---------------------------------------------------------------------
create function public.variant_matrix(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.product_master%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('variants.read');
  select * into p from public.product_master where id = p_product and company_id = v_co;
  if not found then raise exception 'VARIANT_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'product', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'status', p.status, 'client_id', p.client_id, 'article_id', p.article_id),
    'product_bom', (select jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'active_version_id', b.active_version_id)
                    from public.boms b where p.article_id is not null and b.article_id = p.article_id and b.archived_at is null limit 1),
    'warehouses', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name) order by w.name), '[]'::jsonb) from public.warehouses w where w.company_id = v_co and w.archived_at is null),
    'variants', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'color_id', x.color_id, 'size_id', x.size_id, 'sku', x.sku, 'barcode', x.barcode, 'price', x.price, 'currency', x.currency, 'bom_id', x.bom_id, 'active', x.active,
        'bom_code', (select code from public.boms where id = x.bom_id),
        'on_hand', coalesce((select sum(qty_on_hand) from public.variant_stock where variant_id = x.id), 0),
        'reserved', coalesce((select sum(qty_reserved) from public.variant_stock where variant_id = x.id), 0),
        'low', coalesce((select bool_or(safety_qty > 0 and qty_on_hand - qty_reserved <= safety_qty) from public.variant_stock where variant_id = x.id), false),
        'stock', (select coalesce(jsonb_agg(jsonb_build_object('warehouse_id', st.warehouse_id, 'on_hand', st.qty_on_hand, 'reserved', st.qty_reserved, 'safety', st.safety_qty)), '[]'::jsonb) from public.variant_stock st where st.variant_id = x.id)
      ) order by x.sku), '[]'::jsonb) from public.product_variants x where x.product_id = p.id));
end $$;

create function public.variant_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('variants.read');
  return (select coalesce(jsonb_agg(r order by r ->> 'code'), '[]'::jsonb) from (
    select jsonb_build_object('product_id', p.id, 'code', p.code, 'name', p.name, 'status', p.status, 'client_name', c.name,
      'variants', count(v.id), 'active', count(v.id) filter (where v.active),
      'colors', count(distinct v.color_id), 'sizes', count(distinct v.size_id),
      'on_hand', coalesce(sum((select sum(qty_on_hand) from public.variant_stock where variant_id = v.id)), 0),
      'reserved', coalesce(sum((select sum(qty_reserved) from public.variant_stock where variant_id = v.id)), 0),
      'out_of_stock', count(v.id) filter (where v.active and coalesce((select sum(qty_on_hand) from public.variant_stock where variant_id = v.id), 0) = 0),
      'low', count(v.id) filter (where v.active and coalesce((select bool_or(safety_qty > 0 and qty_on_hand - qty_reserved <= safety_qty) from public.variant_stock where variant_id = v.id), false)),
      'missing_barcode', count(v.id) filter (where v.active and v.barcode is null),
      'missing_price', count(v.id) filter (where v.active and v.price is null)) as r
    from public.product_master p join public.clients c on c.id = p.client_id left join public.product_variants v on v.product_id = p.id
    where p.company_id = v_co and p.status <> 'archived' group by p.id, c.name order by p.code limit 500) x);
end $$;

do $$
declare f text;
begin
  foreach f in array array['variants_seed_defaults()', 'variant_generate(uuid,uuid[],uuid[])', 'variant_sync_from_spec(uuid)', 'variant_bulk_update(uuid,jsonb)', 'variant_assign_barcodes(uuid)', 'variant_delete(uuid)',
                           'variant_stock_move(uuid,text,uuid,int,uuid,text,text)', 'variant_stock_reserve(uuid,uuid,int)', 'variant_stock_set_safety(uuid,uuid,int)', 'variant_matrix(uuid)', 'variant_overview()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.variants_flag(text) from public, anon, authenticated;
