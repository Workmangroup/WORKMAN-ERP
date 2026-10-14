-- ===========================================================================
-- 0094 — POS hors ligne et reprise (P078), additif
--
-- Ajoute : politique hors ligne versionnée et signée (durée et plafond saisis, aucune valeur par
-- défaut) ; appareils avec identifiant local ; journal de synchronisation idempotent (clé
-- appareil + identifiant d'opération, ajout seul) ; synchronisation d'une vente : rejeu sans effet
-- de bord, refus explicite en conflit (prix changé, stock, session close, durée ou plafond dépassés),
-- rien n'est créé en conflit ; abandon d'un conflit par un superviseur ; contenu du cache de caisse.
--
-- Opérations sensibles interdites hors ligne (décision à valider) : annulation, clôture de session,
-- dépôt, visa. Elles n'existent pas dans le journal : le client ne peut pas les mettre en file.
-- Le cache est signé par l'API (clé privée hors dépôt) ; cette migration ne fournit que le contenu.
-- ===========================================================================

insert into public.permissions (code, module, label, description) values
  ('pos.offline', 'pos', 'Définir la politique hors ligne', 'Création des politiques de durée et de plafond hors ligne')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'pos.offline'
where r.is_system and r.code = 'admin' on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. Politique hors ligne (versionnée, signée, figée une fois validée)
-- ---------------------------------------------------------------------------
create table public.pos_offline_policies (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code               text not null check (code ~ '^[A-Z0-9_]{3,40}$'),
  effective_from     date not null,
  max_offline_minutes int not null check (max_offline_minutes between 1 and 10080),
  max_offline_amount numeric(14,2) not null check (max_offline_amount > 0),
  status             text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  validated_by       uuid,
  validated_at       timestamptz,
  check ((status = 'valide') = (validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by),
  unique (company_id, code, effective_from)
);
alter table public.pos_offline_policies enable row level security;
create policy pos_offline_policies_select on public.pos_offline_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('pos.read'));
create trigger pos_offline_policies_guard before update or delete on public.pos_offline_policies
  for each row execute function private.collections_versioned_guard();
revoke all on public.pos_offline_policies from anon, authenticated;
grant select on public.pos_offline_policies to authenticated;
grant all on public.pos_offline_policies to service_role;

create function private.pos_offline_policy_at(p_at timestamptz) returns public.pos_offline_policies
language plpgsql stable security definer set search_path = '' as $$
declare r public.pos_offline_policies%rowtype;
begin
  select * into r from public.pos_offline_policies
    where company_id = private.current_company() and status = 'valide' and effective_from <= p_at::date
    order by effective_from desc, validated_at desc limit 1;
  if not found then raise exception 'POS_NO_OFFLINE_POLICY' using errcode = '55000'; end if;
  return r;
end $$;
revoke execute on function private.pos_offline_policy_at(timestamptz) from public, anon, authenticated;

create function public.pos_offline_policy_create(p_code text, p_effective_from date, p_minutes int, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('pos.offline');
  insert into public.pos_offline_policies (id, company_id, code, effective_from, max_offline_minutes, max_offline_amount)
    values (v_id, v_co, p_code, p_effective_from, p_minutes, p_amount);
  perform private.write_audit(v_co, 'pos.offline_policy_create', 'pos_offline_policy', v_id::text, p_code, null,
    jsonb_build_object('status', 'a_valider'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.pos_offline_policy_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.pos_offline_policies%rowtype;
begin
  perform private.require_perm('pos.supervise');
  select * into r from public.pos_offline_policies where id = p_id and company_id = v_co for update;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'a_valider' then raise exception 'POS_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'pos_offline_policy'; end if;
  if p_validate then
    update public.pos_offline_policies set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  else
    delete from public.pos_offline_policies where id = r.id;
  end if;
  perform private.write_audit(v_co, case when p_validate then 'pos.offline_policy_validate' else 'pos.offline_policy_reject' end,
    'pos_offline_policy', r.id::text, r.code, jsonb_build_object('status', 'a_valider'),
    jsonb_build_object('status', case when p_validate then 'valide' else 'supprimee' end), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Appareils : identifiant local, rattaché à une caisse
-- ---------------------------------------------------------------------------
create table public.pos_devices (
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  id           uuid not null,
  register_id  uuid not null references public.pos_registers(id),
  label        text not null check (length(btrim(label)) between 2 and 80),
  registered_by uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  primary key (company_id, id)
);
alter table public.pos_devices enable row level security;
create policy pos_devices_select on public.pos_devices for select to authenticated
  using (company_id = private.current_company() and private.has_perm('pos.read'));
revoke all on public.pos_devices from anon, authenticated;
grant select on public.pos_devices to authenticated;
grant all on public.pos_devices to service_role;

create function public.pos_device_register(p_device uuid, p_register uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.pos_devices%rowtype;
begin
  perform private.require_perm('pos.sell');
  if not exists (select 1 from public.pos_registers r where r.id = p_register and r.company_id = v_co and r.active) then
    raise exception 'POS_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into d from public.pos_devices where company_id = v_co and id = p_device;
  if found then
    if d.register_id <> p_register then raise exception 'POS_DEVICE_OTHER_REGISTER' using errcode = '22023'; end if;
    return;
  end if;
  insert into public.pos_devices (company_id, id, register_id, label) values (v_co, p_device, p_register, btrim(p_label));
  perform private.write_audit(v_co, 'pos.device_register', 'pos_device', p_device::text, p_label, null,
    jsonb_build_object('register_id', p_register), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Journal de synchronisation (idempotent, en ajout seul ; conflit abandonnable seulement)
-- ---------------------------------------------------------------------------
create table public.pos_sync_ops (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  device_id        uuid not null,
  client_op_id     uuid not null,
  op_kind          text not null check (op_kind = 'sale'),
  payload_hash     text not null check (length(payload_hash) = 32),
  session_id       uuid,
  sold_at          timestamptz not null,
  status           text not null check (status in ('applied', 'conflict', 'discarded')),
  conflict_code    text,
  conflict_detail  jsonb,
  ticket_id        uuid references public.pos_tickets(id),
  received_at      timestamptz not null default now(),
  resolved_by      uuid,
  resolved_at      timestamptz,
  resolution_note  text check (resolution_note is null or length(btrim(resolution_note)) between 5 and 300),
  unique (company_id, device_id, client_op_id),
  check ((status = 'applied') = (ticket_id is not null)),
  check ((status in ('conflict', 'discarded')) = (conflict_code is not null)),
  check ((status = 'discarded') = (resolved_at is not null and resolution_note is not null))
);

create function private.pos_sync_ops_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'POS_APPEND_ONLY' using errcode = '55000'; end if;
  -- Seul un conflit non résolu peut être abandonné ; le reste est figé
  if old.status <> 'conflict' or new.status <> 'discarded' then raise exception 'POS_APPEND_ONLY' using errcode = '55000'; end if;
  if new.device_id <> old.device_id or new.client_op_id <> old.client_op_id or new.payload_hash <> old.payload_hash
     or new.ticket_id is distinct from old.ticket_id or new.conflict_code <> old.conflict_code or new.sold_at <> old.sold_at then
    raise exception 'POS_APPEND_ONLY' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.pos_sync_ops_guard() from public, anon, authenticated;
create trigger pos_sync_ops_guard before update or delete on public.pos_sync_ops
  for each row execute function private.pos_sync_ops_guard();

alter table public.pos_sync_ops enable row level security;
create policy pos_sync_ops_select on public.pos_sync_ops for select to authenticated
  using (company_id = private.current_company() and private.has_perm('pos.read'));
revoke all on public.pos_sync_ops from anon, authenticated;
grant select on public.pos_sync_ops to authenticated;
grant all on public.pos_sync_ops to service_role;

-- Synchronisation d'une vente hors ligne. Rejeu : même réponse, aucune nouvelle écriture.
-- Conflit : rien n'est créé (ni ticket, ni paiement, ni sortie de stock), le conflit est journalisé.
create function public.pos_sync_sale(p_device uuid, p_client_op uuid, p_session uuid, p_sold_at timestamptz,
  p_lines jsonb, p_payments jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_hash text; o public.pos_sync_ops%rowtype; pol public.pos_offline_policies%rowtype;
  dev public.pos_devices%rowtype; s public.pos_sessions%rowtype; l jsonb; v_total numeric := 0; v_ticket uuid; v_code text;
  v_conflict text; v_detail jsonb := '[]'::jsonb; v_status text := 'applied'; v_op uuid := gen_random_uuid(); v_result jsonb; v_sfound boolean;
begin
  perform private.require_perm('pos.sell');
  if p_device is null or p_client_op is null or p_sold_at is null or p_lines is null or p_payments is null then
    raise exception 'POS_BAD_INPUT' using errcode = '22023';
  end if;
  v_hash := md5(jsonb_build_object('session', p_session, 'sold_at', p_sold_at, 'lines', p_lines, 'payments', p_payments)::text);

  -- Rejeu ou réutilisation d'un identifiant
  select * into o from public.pos_sync_ops where company_id = v_co and device_id = p_device and client_op_id = p_client_op;
  if found then
    if o.payload_hash <> v_hash then raise exception 'POS_OP_ID_REUSED' using errcode = '22023'; end if;
    return jsonb_build_object('status', o.status, 'ticket_id', o.ticket_id, 'conflict_code', o.conflict_code, 'replayed', true);
  end if;

  select * into dev from public.pos_devices where company_id = v_co and id = p_device;
  if not found then raise exception 'POS_DEVICE_UNKNOWN' using errcode = 'P0002'; end if;
  pol := private.pos_offline_policy_at(now());
  select * into s from public.pos_sessions where id = p_session and company_id = v_co;
  v_sfound := found;

  -- Contrôles de conflit (aucune écriture métier avant le dernier)
  if p_sold_at > now() + interval '5 minutes' then raise exception 'POS_BAD_TIME' using errcode = '22023'; end if;
  if now() - p_sold_at > make_interval(mins => pol.max_offline_minutes) then v_conflict := 'POS_OFFLINE_EXPIRED';
  end if;
  select coalesce(sum((p->>'amount')::numeric), 0) into v_total from jsonb_array_elements(p_payments) p;
  if v_conflict is null and v_total > pol.max_offline_amount then v_conflict := 'POS_OFFLINE_CEILING'; end if;
  if v_conflict is null and (not v_sfound or s.status <> 'open') then v_conflict := 'POS_SESSION_CLOSED'; end if;
  if v_conflict is null and s.register_id <> dev.register_id then v_conflict := 'POS_SESSION_OTHER_REGISTER'; end if;
  if v_conflict is null then
    -- Prix : le prix utilisé hors ligne doit égaler le prix actuel de la variante
    for l in select * from jsonb_array_elements(p_lines) loop
      if (l->>'unit_price_ht') is null or (l->>'unit_price_ht')::numeric <> (select pv.price from public.product_variants pv
          where pv.id = (l->>'variant')::uuid and pv.company_id = v_co) then
        v_detail := v_detail || jsonb_build_object('variant', l->>'variant', 'offline_price', l->>'unit_price_ht',
          'current_price', (select pv.price from public.product_variants pv where pv.id = (l->>'variant')::uuid and pv.company_id = v_co));
      end if;
    end loop;
    if jsonb_array_length(v_detail) > 0 then v_conflict := 'POS_PRICE_CONFLICT'; end if;
  end if;

  if v_conflict is null then
    -- Création par le module caisse : sous-transaction, toute erreur métier devient un conflit
    begin
      v_ticket := public.pos_ticket_create(p_session, (select coalesce(jsonb_agg(jsonb_build_object('variant', x->>'variant', 'qty', x->>'qty', 'vat_code', x->>'vat_code')), '[]'::jsonb)
        from jsonb_array_elements(p_lines) x), p_payments);
    exception when others then
      if sqlerrm in ('VARIANT_STOCK_INSUFFICIENT', 'POS_PAYMENT_MISMATCH', 'POS_BAD_METHOD', 'POS_BAD_VAT', 'POS_VARIANT_NOT_SALEABLE', 'POS_BAD_QTY', 'POS_EMPTY_TICKET', 'POS_CURRENCY_NOT_BASE') then
        v_conflict := sqlerrm;
      else
        raise;
      end if;
    end;
  end if;

  if v_conflict is null then
    v_status := 'applied';
  else
    v_status := 'conflict';
    v_ticket := null;
  end if;

  insert into public.pos_sync_ops (id, company_id, device_id, client_op_id, op_kind, payload_hash, session_id, sold_at,
    status, conflict_code, conflict_detail, ticket_id)
  values (v_op, v_co, p_device, p_client_op, 'sale', v_hash, p_session, p_sold_at, v_status, v_conflict,
    case when v_conflict = 'POS_PRICE_CONFLICT' then v_detail else null end, v_ticket);

  perform private.write_audit(v_co, case when v_status = 'applied' then 'pos.sync_applied' else 'pos.sync_conflict' end, 'pos_sync_op', v_op::text,
    v_conflict, null, jsonb_build_object('status', v_status, 'ticket_id', v_ticket), '{}'::jsonb, 'rpc');
  v_result := jsonb_build_object('status', v_status, 'ticket_id', v_ticket, 'conflict_code', v_conflict, 'replayed', false);
  return v_result;
end $$;

-- Abandon d'un conflit par un superviseur (le client ne renvoie rien ; une nouvelle vente est une nouvelle opération)
create function public.pos_sync_conflict_discard(p_op uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.pos_sync_ops%rowtype;
begin
  perform private.require_perm('pos.supervise');
  if p_note is null or length(btrim(p_note)) < 5 or length(btrim(p_note)) > 300 then raise exception 'POS_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into o from public.pos_sync_ops where id = p_op and company_id = v_co for update;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'conflict' then raise exception 'POS_BAD_STATUS' using errcode = '55000'; end if;
  update public.pos_sync_ops set status = 'discarded', resolved_by = auth.uid(), resolved_at = now(), resolution_note = btrim(p_note) where id = o.id;
  perform private.write_audit(v_co, 'pos.sync_discard', 'pos_sync_op', o.id::text, o.conflict_code, jsonb_build_object('status', 'conflict'),
    jsonb_build_object('status', 'discarded'), jsonb_build_object('reason', btrim(p_note)), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Contenu du cache de caisse : prix, modes, TVA validée, stock de la boutique, durée et plafond
-- ---------------------------------------------------------------------------
create function public.pos_offline_cache(p_register uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); pol public.pos_offline_policies%rowtype; r public.pos_registers%rowtype; v_payload jsonb;
begin
  perform private.require_perm('pos.sell');
  select * into r from public.pos_registers where id = p_register and company_id = v_co;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  pol := private.pos_offline_policy_at(now());
  v_payload := jsonb_build_object(
    'register_id', r.id, 'register_code', r.code, 'warehouse_id', r.warehouse_id,
    'generated_at', now(), 'valid_until', now() + make_interval(mins => pol.max_offline_minutes),
    'max_offline_amount', pol.max_offline_amount, 'policy_code', pol.code,
    'sensitive_ops_offline', '[]'::jsonb,
    'variants', coalesce((select jsonb_agg(jsonb_build_object('variant_id', pv.id, 'sku', pv.sku, 'price_ht', pv.price,
        'currency', pv.currency, 'on_hand', coalesce(vs.qty_on_hand, 0)) order by pv.sku)
      from public.product_variants pv left join public.variant_stock vs on vs.variant_id = pv.id and vs.warehouse_id = r.warehouse_id
      where pv.company_id = v_co and pv.active and pv.price is not null), '[]'::jsonb),
    'payment_methods', coalesce((select jsonb_agg(jsonb_build_object('method_id', m.id, 'code', m.code, 'kind', m.kind) order by m.code)
      from public.pos_payment_methods m where m.company_id = v_co and m.active), '[]'::jsonb),
    'vat_codes', coalesce((select jsonb_agg(jsonb_build_object('code', v.code, 'rate', v.rate) order by v.code)
      from public.vat_rates v where v.status = 'valide' and v.effective_from <= current_date
        and (v.effective_to is null or v.effective_to > current_date)), '[]'::jsonb));
  return jsonb_build_object('payload', v_payload, 'digest', md5(v_payload::text));
end $$;
