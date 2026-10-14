-- ===========================================================================
-- 0092 — Point de vente : sessions de caisse, tickets, clôture, visa, stock magasin (P077), additif
--
-- Ajoute : caisses rattachées à un entrepôt de type boutique ; modes de paiement configurés
-- (aucun par défaut, D3) ; sessions de caisse avec fonds de caisse saisi à l'ouverture (D6, aucun
-- défaut) ; tickets et lignes immuables, prix lus sur la variante, TVA par code validé ; annulation
-- uniquement par ticket d'annulation (contre-passation), jamais par modification ; clôture avec
-- attendu / réel par mode de paiement et écart visible ; visa d'une personne distincte du clôturant
-- dès qu'un écart existe ; session close protégée ; sorties de stock via le module variantes
-- existant (variant_stock_move) ; rapprochement stock magasin = ventes POS et mouvements.
--
-- Non inclus, faute de données ou de règles fournies : numérotation fiscale (D2), seuils d'écart
-- (D4, le visa est exigé dès qu'un écart est non nul), rapprochement des dépôts avec les relevés
-- bancaires (module 0087 non connecté), boutiques et articles réels (D5).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('pos.read', 'pos', 'Voir les caisses et les tickets', 'Consultation des sessions, tickets, écarts et rapprochement du stock magasin'),
  ('pos.admin', 'pos', 'Gérer caisses et modes de paiement', 'Création des caisses rattachées à une boutique et des modes de paiement'),
  ('pos.sell', 'pos', 'Ouvrir une caisse et encaisser', 'Ouverture de session, tickets de vente, annulation par ticket de contre-passation'),
  ('pos.close', 'pos', 'Clôturer une caisse et déposer', 'Comptage à la clôture et dépôt des espèces'),
  ('pos.supervise', 'pos', 'Viser un écart de caisse', 'Visa d’une clôture avec écart, par une personne distincte du clôturant')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('pos.read', 'pos.admin', 'pos.sell', 'pos.close', 'pos.supervise')
where r.is_system and r.code = 'admin' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('pos.read', 'pos.sell', 'pos.close')
where r.is_system and r.code = 'magasin' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('pos.read', 'pos.supervise')
where r.is_system and r.code = 'finance' on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.pos_registers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  warehouse_id  uuid not null references public.warehouses(id),
  code          text not null check (code ~ '^[A-Z0-9_-]{2,20}$'),
  label         text not null check (length(btrim(label)) between 2 and 80),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, code)
);

create table public.pos_payment_methods (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code          text not null check (code ~ '^[A-Z0-9_]{2,20}$'),
  label         text not null check (length(btrim(label)) between 2 and 60),
  kind          text not null check (kind in ('cash', 'card', 'cheque', 'transfer', 'other')),
  refund_allowed boolean not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, code)
);

create table public.pos_sessions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  register_id     uuid not null references public.pos_registers(id),
  opening_float   numeric(14,2) not null check (opening_float >= 0),
  status          text not null default 'open' check (status in ('open', 'closed')),
  opened_by       uuid default auth.uid(),
  opened_at       timestamptz not null default now(),
  closed_by       uuid,
  closed_at       timestamptz,
  variance_total  numeric(14,2),
  visa_required   boolean,
  visa_by         uuid,
  visa_at         timestamptz,
  visa_note       text check (visa_note is null or length(btrim(visa_note)) <= 300),
  check ((status = 'open') = (closed_at is null and closed_by is null and variance_total is null and visa_required is null)),
  check (visa_by is null or visa_by is distinct from closed_by),
  check ((visa_by is null) = (visa_at is null))
);
create unique index pos_sessions_one_open on public.pos_sessions (register_id) where status = 'open';

create table public.pos_tickets (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  session_id    uuid not null references public.pos_sessions(id),
  code          text not null unique check (code ~ '^TKT-[0-9]{8}-[0-9A-F]{8}$'),
  kind          text not null check (kind in ('sale', 'reversal')),
  reverses_id   uuid references public.pos_tickets(id),
  subtotal_ht   numeric(14,2) not null check (subtotal_ht >= 0),
  tax_total     numeric(14,2) not null check (tax_total >= 0),
  total         numeric(14,2) not null check (total > 0),
  reason        text check (reason is null or length(btrim(reason)) between 5 and 300),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  check ((kind = 'reversal') = (reverses_id is not null and reason is not null))
);
create unique index pos_tickets_one_reversal on public.pos_tickets (reverses_id) where reverses_id is not null;

create table public.pos_ticket_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  ticket_id     uuid not null references public.pos_tickets(id),
  pos           int not null check (pos >= 1),
  variant_id    uuid not null references public.product_variants(id),
  qty           int not null check (qty > 0),
  unit_price_ht numeric(14,2) not null check (unit_price_ht >= 0),
  vat_code      text not null check (length(btrim(vat_code)) between 3 and 30),
  vat_rate      numeric(5,2) not null check (vat_rate >= 0 and vat_rate <= 100),
  line_ht       numeric(14,2) not null check (line_ht >= 0),
  line_tax      numeric(14,2) not null check (line_tax >= 0),
  line_total    numeric(14,2) not null check (line_total >= 0),
  unique (ticket_id, pos)
);

create table public.pos_ticket_payments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  ticket_id     uuid not null references public.pos_tickets(id),
  method_id     uuid not null references public.pos_payment_methods(id),
  direction     text not null check (direction in ('in', 'refund')),
  amount        numeric(14,2) not null check (amount > 0)
);

create table public.pos_session_counts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  session_id    uuid not null references public.pos_sessions(id),
  method_id     uuid not null references public.pos_payment_methods(id),
  expected      numeric(14,2) not null,
  counted       numeric(14,2) not null check (counted >= 0),
  variance      numeric(14,2) not null,
  unique (session_id, method_id),
  check (variance = counted - expected)
);

create table public.pos_deposits (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  session_id    uuid not null references public.pos_sessions(id),
  amount        numeric(14,2) not null check (amount > 0),
  reference     text not null check (length(btrim(reference)) between 3 and 80),
  deposited_by  uuid default auth.uid(),
  deposited_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Gardes : session close protégée, historiques immuables
-- ---------------------------------------------------------------------------
create function private.pos_sessions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'POS_APPEND_ONLY' using errcode = '55000'; end if;
  if old.status = 'closed' then
    -- Une session close ne change plus que son visa (une seule fois)
    if new.register_id <> old.register_id or new.opening_float <> old.opening_float or new.opened_at <> old.opened_at
       or new.opened_by is distinct from old.opened_by or new.status <> 'closed' or new.closed_at is distinct from old.closed_at
       or new.closed_by is distinct from old.closed_by or new.variance_total is distinct from old.variance_total
       or new.visa_required is distinct from old.visa_required then
      raise exception 'POS_SESSION_CLOSED' using errcode = '55000';
    end if;
    if old.visa_by is not null then raise exception 'POS_SESSION_CLOSED' using errcode = '55000'; end if;
    return new;
  end if;
  if new.register_id <> old.register_id or new.opening_float <> old.opening_float or new.opened_at <> old.opened_at then
    raise exception 'POS_SESSION_CLOSED' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger pos_sessions_guard before update or delete on public.pos_sessions
  for each row execute function private.pos_sessions_guard();

create function private.pos_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'POS_APPEND_ONLY' using errcode = '55000';
end $$;

-- Lignes, paiements, comptages : ajout seulement, et seulement dans une session ouverte
create function private.pos_require_open_session(p_session uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from public.pos_sessions where id = p_session and status = 'open') then
    raise exception 'POS_SESSION_CLOSED' using errcode = '55000';
  end if;
end $$;

create function private.pos_tickets_insert_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.pos_require_open_session(new.session_id);
  return new;
end $$;
create function private.pos_lines_insert_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.pos_require_open_session((select session_id from public.pos_tickets where id = new.ticket_id));
  return new;
end $$;
create function private.pos_payments_insert_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.pos_require_open_session((select session_id from public.pos_tickets where id = new.ticket_id));
  return new;
end $$;

create trigger pos_tickets_guard_ins before insert on public.pos_tickets for each row execute function private.pos_tickets_insert_guard();
create trigger pos_lines_guard_ins before insert on public.pos_ticket_lines for each row execute function private.pos_lines_insert_guard();
create trigger pos_payments_guard_ins before insert on public.pos_ticket_payments for each row execute function private.pos_payments_insert_guard();
create trigger pos_tickets_append before update or delete on public.pos_tickets for each row execute function private.pos_append_only();
create trigger pos_lines_append before update or delete on public.pos_ticket_lines for each row execute function private.pos_append_only();
create trigger pos_payments_append before update or delete on public.pos_ticket_payments for each row execute function private.pos_append_only();
create trigger pos_counts_append before update or delete on public.pos_session_counts for each row execute function private.pos_append_only();
create trigger pos_deposits_append before update or delete on public.pos_deposits for each row execute function private.pos_append_only();

-- ---------------------------------------------------------------------------
-- 4. Privilèges et sécurité de ligne
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pos_registers', 'pos_payment_methods', 'pos_sessions', 'pos_tickets', 'pos_ticket_lines',
    'pos_ticket_payments', 'pos_session_counts', 'pos_deposits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm(''pos.read''))',
      t || '_select', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Caisses et modes de paiement
-- ---------------------------------------------------------------------------
create function public.pos_register_create(p_warehouse uuid, p_code text, p_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('pos.admin');
  if not exists (select 1 from public.warehouses w where w.id = p_warehouse and w.company_id = v_co and w.kind = 'shop' and w.archived_at is null) then
    raise exception 'POS_BAD_WAREHOUSE' using errcode = '22023';
  end if;
  insert into public.pos_registers (id, company_id, warehouse_id, code, label) values (v_id, v_co, p_warehouse, p_code, p_label);
  perform private.write_audit(v_co, 'pos.register_create', 'pos_register', v_id::text, p_code, null, jsonb_build_object('warehouse_id', p_warehouse), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.pos_payment_method_create(p_code text, p_label text, p_kind text, p_refund_allowed boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('pos.admin');
  insert into public.pos_payment_methods (id, company_id, code, label, kind, refund_allowed) values (v_id, v_co, p_code, p_label, p_kind, p_refund_allowed);
  perform private.write_audit(v_co, 'pos.method_create', 'pos_payment_method', v_id::text, p_code, null, jsonb_build_object('kind', p_kind), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Taux de TVA validé applicable à la date du ticket (table versionnée, 0030) ; refus sinon
create function private.pos_vat_rate(p_code text, p_on date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_rate numeric;
begin
  select v.rate into v_rate from public.vat_rates v
    where v.code = p_code and v.status = 'valide' and v.effective_from <= p_on and (v.effective_to is null or v.effective_to > p_on)
    order by v.effective_from desc limit 1;
  if v_rate is null then raise exception 'POS_BAD_VAT' using errcode = '22023'; end if;
  return v_rate;
end $$;
revoke execute on function private.pos_vat_rate(text, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Session : ouverture (fonds saisi), tickets, annulation par contre-passation
-- ---------------------------------------------------------------------------
create function public.pos_session_open(p_register uuid, p_float numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('pos.sell');
  if p_float is null then raise exception 'POS_FLOAT_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.pos_registers r where r.id = p_register and r.company_id = v_co and r.active) then
    raise exception 'POS_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.pos_sessions s where s.register_id = p_register and s.status = 'open') then
    raise exception 'POS_SESSION_ALREADY_OPEN' using errcode = '23505';
  end if;
  insert into public.pos_sessions (id, company_id, register_id, opening_float) values (v_id, v_co, p_register, p_float);
  perform private.write_audit(v_co, 'pos.session_open', 'pos_session', v_id::text, null, null, jsonb_build_object('opening_float', p_float), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Lignes : [{variant, qty, vat_code}] ; paiements : [{method, amount}]. Prix lus sur la variante.
create function public.pos_ticket_create(p_session uuid, p_lines jsonb, p_payments jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); s public.pos_sessions%rowtype;
  r public.pos_registers%rowtype; l jsonb; v public.product_variants%rowtype; vr numeric; v_id uuid := gen_random_uuid();
  v_code text; v_seq int := 0; v_ht numeric := 0; v_tax numeric := 0; v_qty int; v_unit numeric; v_lht numeric; v_ltax numeric;
  v_vat text; v_pay_sum numeric := 0; p jsonb; v_m public.pos_payment_methods%rowtype;
begin
  perform private.require_perm('pos.sell');
  select * into s from public.pos_sessions where id = p_session and company_id = v_co for update;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'open' then raise exception 'POS_SESSION_CLOSED' using errcode = '55000'; end if;
  select * into r from public.pos_registers where id = s.register_id;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'POS_EMPTY_TICKET' using errcode = '22023'; end if;
  if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) = 0 then raise exception 'POS_NO_PAYMENT' using errcode = '22023'; end if;

  -- Contrôle des lignes et calcul des montants (aucun montant saisi par l'appelant)
  for l in select * from jsonb_array_elements(p_lines) loop
    v_seq := v_seq + 1;
    v_qty := (l->>'qty')::int; v_vat := l->>'vat_code';
    if v_qty is null or v_qty <= 0 then raise exception 'POS_BAD_QTY' using errcode = '22023'; end if;
    select * into v from public.product_variants where id = (l->>'variant')::uuid and company_id = v_co and active;
    if not found or v.price is null then raise exception 'POS_VARIANT_NOT_SALEABLE' using errcode = '22023'; end if;
    if v.currency <> v_base then raise exception 'POS_CURRENCY_NOT_BASE' using errcode = '22023'; end if;
    vr := private.pos_vat_rate(v_vat, current_date);
    v_unit := v.price;
    v_lht := round(v_qty * v_unit, 2);
    v_ltax := round(v_lht * vr / 100, 2);
    v_ht := v_ht + v_lht; v_tax := v_tax + v_ltax;
  end loop;
  if v_ht + v_tax <= 0 then raise exception 'POS_EMPTY_TICKET' using errcode = '22023'; end if;

  -- Paiements : modes configurés, montants positifs, somme égale au total
  for p in select * from jsonb_array_elements(p_payments) loop
    select * into v_m from public.pos_payment_methods where id = (p->>'method')::uuid and company_id = v_co and active;
    if not found then raise exception 'POS_BAD_METHOD' using errcode = '22023'; end if;
    if (p->>'amount')::numeric is null or (p->>'amount')::numeric <= 0 then raise exception 'POS_BAD_AMOUNT' using errcode = '22023'; end if;
    v_pay_sum := v_pay_sum + (p->>'amount')::numeric;
  end loop;
  if v_pay_sum <> v_ht + v_tax then raise exception 'POS_PAYMENT_MISMATCH' using errcode = '22023', detail = (v_ht + v_tax)::text; end if;

  v_code := 'TKT-' || to_char(current_date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.pos_tickets (id, company_id, session_id, code, kind, subtotal_ht, tax_total, total)
    values (v_id, v_co, p_session, v_code, 'sale', v_ht, v_tax, v_ht + v_tax);

  v_seq := 0;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_seq := v_seq + 1;
    select * into v from public.product_variants where id = (l->>'variant')::uuid;
    v_qty := (l->>'qty')::int;
    vr := private.pos_vat_rate(l->>'vat_code', current_date);
    v_lht := round(v_qty * v.price, 2); v_ltax := round(v_lht * vr / 100, 2);
    insert into public.pos_ticket_lines (company_id, ticket_id, pos, variant_id, qty, unit_price_ht, vat_code, vat_rate, line_ht, line_tax, line_total)
      values (v_co, v_id, v_seq, v.id, v_qty, v.price, l->>'vat_code', vr, v_lht, v_ltax, v_lht + v_ltax);
    -- Sortie de stock magasin par le module variantes (refusée si stock insuffisant)
    perform public.variant_stock_move(v.id, 'issue', r.warehouse_id, v_qty, null, 'Vente caisse', v_code);
  end loop;
  for p in select * from jsonb_array_elements(p_payments) loop
    insert into public.pos_ticket_payments (company_id, ticket_id, method_id, direction, amount)
      values (v_co, v_id, (p->>'method')::uuid, 'in', (p->>'amount')::numeric);
  end loop;

  perform private.write_audit(v_co, 'pos.ticket_create', 'pos_ticket', v_id::text, v_code, null,
    jsonb_build_object('total', v_ht + v_tax, 'session_id', p_session), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Annulation : un seul ticket de contre-passation, dans la session ouverte de la même caisse ;
-- remboursement par les modes autorisés ; stock rendu par le module variantes. L'original reste intact.
create function public.pos_ticket_reverse(p_ticket uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.pos_tickets%rowtype; orig_s public.pos_sessions%rowtype; s public.pos_sessions%rowtype;
  r public.pos_registers%rowtype; l record; p record; v_id uuid := gen_random_uuid(); v_code text; v_ht numeric; v_tax numeric;
begin
  perform private.require_perm('pos.sell');
  if p_reason is null or length(btrim(p_reason)) < 5 or length(btrim(p_reason)) > 300 then raise exception 'POS_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into t from public.pos_tickets where id = p_ticket and company_id = v_co;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if t.kind <> 'sale' then raise exception 'POS_BAD_TICKET' using errcode = '22023'; end if;
  if exists (select 1 from public.pos_tickets where reverses_id = t.id) then raise exception 'POS_ALREADY_REVERSED' using errcode = '23505'; end if;
  select * into orig_s from public.pos_sessions where id = t.session_id;
  select * into s from public.pos_sessions where register_id = orig_s.register_id and status = 'open' for update;
  if not found then raise exception 'POS_SESSION_NOT_OPEN' using errcode = '55000'; end if;
  select * into r from public.pos_registers where id = s.register_id;
  if exists (select 1 from public.pos_ticket_payments tp join public.pos_payment_methods m on m.id = tp.method_id
      where tp.ticket_id = t.id and tp.direction = 'in' and not m.refund_allowed) then
    raise exception 'POS_REFUND_NOT_ALLOWED' using errcode = '22023';
  end if;

  v_code := 'TKT-' || to_char(current_date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.pos_tickets (id, company_id, session_id, code, kind, reverses_id, subtotal_ht, tax_total, total, reason)
    values (v_id, v_co, s.id, v_code, 'reversal', t.id, t.subtotal_ht, t.tax_total, t.total, btrim(p_reason));
  for l in select * from public.pos_ticket_lines where ticket_id = t.id order by pos loop
    insert into public.pos_ticket_lines (company_id, ticket_id, pos, variant_id, qty, unit_price_ht, vat_code, vat_rate, line_ht, line_tax, line_total)
      values (v_co, v_id, l.pos, l.variant_id, l.qty, l.unit_price_ht, l.vat_code, l.vat_rate, l.line_ht, l.line_tax, l.line_total);
    perform public.variant_stock_move(l.variant_id, 'receipt', r.warehouse_id, l.qty, null, 'Annulation caisse', v_code);
  end loop;
  for p in select * from public.pos_ticket_payments where ticket_id = t.id and direction = 'in' loop
    insert into public.pos_ticket_payments (company_id, ticket_id, method_id, direction, amount) values (v_co, v_id, p.method_id, 'refund', p.amount);
  end loop;

  perform private.write_audit(v_co, 'pos.ticket_reverse', 'pos_ticket', t.id::text, t.code, null,
    jsonb_build_object('reversal_id', v_id, 'session_id', s.id), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Clôture : attendu / réel par mode, écart visible, visa si écart
-- ---------------------------------------------------------------------------
-- Attendu : fonds (espèces) + encaissements − remboursements, par mode.
-- p_counts : [{method, counted}] ; chaque mode concerné (espèces et modes utilisés) doit être compté.
create function public.pos_session_close(p_session uuid, p_counts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.pos_sessions%rowtype; m record; c jsonb; v_counted numeric; v_exp numeric;
  v_var numeric; v_total numeric := 0; v_out jsonb := '[]'::jsonb; v_any boolean := false; v_seen uuid[] := '{}';
begin
  perform private.require_perm('pos.close');
  select * into s from public.pos_sessions where id = p_session and company_id = v_co for update;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'open' then raise exception 'POS_SESSION_CLOSED' using errcode = '55000'; end if;
  if jsonb_typeof(p_counts) <> 'array' then raise exception 'POS_COUNT_MISSING' using errcode = '22023'; end if;

  for m in select pm.id, pm.kind,
      coalesce((select sum(tp.amount) from public.pos_ticket_payments tp join public.pos_tickets t on t.id = tp.ticket_id
        where t.session_id = s.id and tp.method_id = pm.id and tp.direction = 'in'), 0)
      - coalesce((select sum(tp.amount) from public.pos_ticket_payments tp join public.pos_tickets t on t.id = tp.ticket_id
        where t.session_id = s.id and tp.method_id = pm.id and tp.direction = 'refund'), 0) as net
    from public.pos_payment_methods pm
    where pm.company_id = v_co and (pm.kind = 'cash' or exists (select 1 from public.pos_ticket_payments tp join public.pos_tickets t on t.id = tp.ticket_id
      where t.session_id = s.id and tp.method_id = pm.id)) loop
    v_exp := m.net + case when m.kind = 'cash' then s.opening_float else 0 end;
    select x into c from jsonb_array_elements(p_counts) x where (x->>'method')::uuid = m.id;
    if c is null or (c->>'counted') is null or (c->>'counted')::numeric < 0 then raise exception 'POS_COUNT_MISSING' using errcode = '22023', detail = m.id::text; end if;
    v_counted := (c->>'counted')::numeric;
    v_var := v_counted - v_exp;
    insert into public.pos_session_counts (company_id, session_id, method_id, expected, counted, variance)
      values (v_co, s.id, m.id, v_exp, v_counted, v_var);
    v_total := v_total + v_var;
    v_any := v_any or v_var <> 0;
    v_seen := v_seen || m.id;
    v_out := v_out || jsonb_build_object('method', m.id, 'expected', v_exp, 'counted', v_counted, 'variance', v_var);
  end loop;
  if jsonb_array_length(p_counts) <> cardinality(v_seen) then raise exception 'POS_COUNT_UNKNOWN_METHOD' using errcode = '22023'; end if;
  if not exists (select 1 from public.pos_payment_methods where company_id = v_co and kind = 'cash' and active) then
    raise exception 'POS_NO_CASH_METHOD' using errcode = '22023';
  end if;
  if not (v_seen && array(select pm.id from public.pos_payment_methods pm where pm.company_id = v_co and pm.kind = 'cash')) then
    raise exception 'POS_COUNT_MISSING' using errcode = '22023';
  end if;

  update public.pos_sessions set status = 'closed', closed_by = auth.uid(), closed_at = now(), variance_total = v_total, visa_required = v_any
    where id = s.id;
  perform private.write_audit(v_co, 'pos.session_close', 'pos_session', s.id::text, null, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'closed', 'variance_total', v_total, 'visa_required', v_any), jsonb_build_object('lines', v_out), 'rpc');
  return jsonb_build_object('session_id', s.id, 'variance_total', v_total, 'visa_required', v_any, 'methods', v_out);
end $$;

-- Visa : une personne distincte du clôturant, et seulement pour une session avec écart
create function public.pos_session_visa(p_session uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.pos_sessions%rowtype;
begin
  perform private.require_perm('pos.supervise');
  select * into s from public.pos_sessions where id = p_session and company_id = v_co for update;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'closed' then raise exception 'POS_BAD_STATUS' using errcode = '55000'; end if;
  if not s.visa_required or s.visa_by is not null then raise exception 'POS_VISA_NOT_REQUIRED' using errcode = '55000'; end if;
  if s.closed_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'pos_session'; end if;
  if p_note is null or length(btrim(p_note)) < 5 or length(btrim(p_note)) > 300 then raise exception 'POS_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.pos_sessions set visa_by = auth.uid(), visa_at = now(), visa_note = btrim(p_note) where id = s.id;
  perform private.write_audit(v_co, 'pos.session_visa', 'pos_session', s.id::text, null, null,
    jsonb_build_object('variance_total', s.variance_total), jsonb_build_object('note', btrim(p_note)), 'rpc');
end $$;

-- Dépôt d'espèces : après clôture, dans la limite des espèces comptées. Non rapproché des relevés (module 0087 non connecté).
create function public.pos_deposit_record(p_session uuid, p_amount numeric, p_reference text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.pos_sessions%rowtype; v_id uuid := gen_random_uuid(); v_cash numeric; v_dep numeric;
begin
  perform private.require_perm('pos.close');
  select * into s from public.pos_sessions where id = p_session and company_id = v_co;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'closed' then raise exception 'POS_BAD_STATUS' using errcode = '55000'; end if;
  select coalesce(sum(c.counted), 0) into v_cash from public.pos_session_counts c join public.pos_payment_methods m on m.id = c.method_id
    where c.session_id = s.id and m.kind = 'cash';
  select coalesce(sum(amount), 0) into v_dep from public.pos_deposits where session_id = s.id;
  if p_amount is null or p_amount <= 0 or v_dep + p_amount > v_cash then raise exception 'POS_DEPOSIT_EXCEEDS_CASH' using errcode = '22023'; end if;
  insert into public.pos_deposits (id, company_id, session_id, amount, reference) values (v_id, v_co, s.id, p_amount, btrim(p_reference));
  perform private.write_audit(v_co, 'pos.deposit', 'pos_session', s.id::text, null, null, jsonb_build_object('amount', p_amount), jsonb_build_object('reference', btrim(p_reference)), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Rapprochement du stock magasin : ventes POS et mouvements de stock
-- ---------------------------------------------------------------------------
-- Pour chaque variante de la boutique : quantité nette vendue (tickets) ; mouvements de stock
-- portant les motifs « Vente caisse » / « Annulation caisse » ; solde du stock = somme des mouvements.
create function public.pos_stock_reconcile(p_warehouse uuid) returns table (variant_id uuid, sku text, on_hand int, pos_net_sold int, pos_moves int, moves_balance int, ok boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('pos.read');
  if not exists (select 1 from public.warehouses w where w.id = p_warehouse and w.company_id = v_co) then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  return query
  with v as (
    select pv.id, pv.sku from public.product_variants pv where pv.company_id = v_co
      and (pv.id in (select vs.variant_id from public.variant_stock vs where vs.warehouse_id = p_warehouse)
        or pv.id in (select l.variant_id from public.pos_ticket_lines l join public.pos_tickets t on t.id = l.ticket_id
          join public.pos_sessions s on s.id = t.session_id join public.pos_registers r on r.id = s.register_id where r.warehouse_id = p_warehouse))
  )
  select v.id, v.sku::text,
    coalesce((select vs.qty_on_hand from public.variant_stock vs where vs.variant_id = v.id and vs.warehouse_id = p_warehouse), 0)::int,
    coalesce((select sum(case when t.kind = 'sale' then l.qty else -l.qty end)
      from public.pos_ticket_lines l join public.pos_tickets t on t.id = l.ticket_id
      join public.pos_sessions s on s.id = t.session_id join public.pos_registers r on r.id = s.register_id
      where l.variant_id = v.id and r.warehouse_id = p_warehouse), 0)::int,
    coalesce((select sum(-m.qty_delta) from public.variant_stock_moves m
      where m.variant_id = v.id and m.warehouse_id = p_warehouse and m.reason in ('Vente caisse', 'Annulation caisse')), 0)::int,
    coalesce((select sum(m.qty_delta) from public.variant_stock_moves m where m.variant_id = v.id and m.warehouse_id = p_warehouse), 0)::int,
    (coalesce((select sum(m.qty_delta) from public.variant_stock_moves m where m.variant_id = v.id and m.warehouse_id = p_warehouse), 0)
       = coalesce((select vs.qty_on_hand from public.variant_stock vs where vs.variant_id = v.id and vs.warehouse_id = p_warehouse), 0))
    and (coalesce((select sum(-m.qty_delta) from public.variant_stock_moves m
       where m.variant_id = v.id and m.warehouse_id = p_warehouse and m.reason in ('Vente caisse', 'Annulation caisse')), 0)
       = coalesce((select sum(case when t.kind = 'sale' then l.qty else -l.qty end)
       from public.pos_ticket_lines l join public.pos_tickets t on t.id = l.ticket_id
       join public.pos_sessions s on s.id = t.session_id join public.pos_registers r on r.id = s.register_id
       where l.variant_id = v.id and r.warehouse_id = p_warehouse), 0))
  from v order by v.sku;
end $$;

-- Privilèges des fonctions : appel par les rôles connectés (le contrôle de droits est dans chaque fonction)
revoke execute on function private.pos_sessions_guard(), private.pos_append_only(), private.pos_tickets_insert_guard(),
  private.pos_lines_insert_guard(), private.pos_payments_insert_guard(), private.pos_require_open_session(uuid) from public, anon, authenticated;
