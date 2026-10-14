-- 0059 — Commandes achats : versions, accord avant envoi, confirmation fournisseur, modification approuvée (P034)
-- Additive. Conserve : numérotation PO-AAAA-nnnnn, commandes existantes et leurs références (po_no inchangé),
-- réceptions et retours (0011), moteur d'approbation (0043), journal et audit.
-- Remplace (même capacité, règles renforcées) : purchase_order_send (envoi seulement après accord de la version courante),
-- purchase_order_cancel (ferme aussi la demande d'approbation ouverte).
-- Règles :
--  * Chaque soumission et chaque modification crée une version immuable (contenu, empreinte SHA-256, motif, auteur).
--  * Une version n'est envoyée qu'après approbation, et seulement si le contenu actuel est identique à la version approuvée.
--  * Une modification d'une commande déjà envoyée est proposée comme nouvelle version, approuvée avant d'être appliquée,
--    puis envoyée explicitement. Les quantités ne descendent jamais sous ce qui est déjà reçu ou retourné.
--  * La confirmation fournisseur est enregistrée avec sa référence ; la version acceptée est affichée à part.
--  * Commandes antérieures : chacune reçoit une version « historique » (accord non tracé), sans modifier son contenu.

-- ---------------------------------------------------------------------
-- 1. Colonnes additives sur les commandes
-- ---------------------------------------------------------------------
alter table public.purchase_orders
  add column if not exists current_version int not null default 0 check (current_version >= 0),
  add column if not exists approved_version int check (approved_version is null or approved_version >= 1),
  add column if not exists sent_version int check (sent_version is null or sent_version >= 1),
  add column if not exists confirmed_version int check (confirmed_version is null or confirmed_version >= 1),
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid,
  add column if not exists confirmation_reference text check (confirmation_reference is null or length(btrim(confirmation_reference)) between 3 and 80),
  add column if not exists approval_pending boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. Versions immuables et confirmations (écrites par les fonctions seulement)
-- ---------------------------------------------------------------------
create table public.purchase_order_versions (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  po_id               uuid not null references public.purchase_orders(id) on delete cascade,
  version             int not null check (version >= 1),
  kind                text not null check (kind in ('initial', 'amendment', 'legacy')),
  status              text not null check (status in ('proposed', 'approved', 'refused', 'superseded', 'cancelled')),
  snapshot            jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash       text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  total_amount        numeric(15,3) not null check (total_amount >= 0),
  reason              text check (reason is null or length(btrim(reason)) between 5 and 300),
  approval_request_id uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  decided_at          timestamptz,
  unique (po_id, version)
);
create index purchase_order_versions_po_idx on public.purchase_order_versions (po_id, version desc);

create table public.purchase_order_confirmations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  po_id        uuid not null references public.purchase_orders(id) on delete cascade,
  version      int not null check (version >= 1),
  reference    text not null check (length(btrim(reference)) between 3 and 80),
  confirmed_on date not null,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  unique (po_id, version)
);

alter table public.purchase_order_versions enable row level security;
alter table public.purchase_order_confirmations enable row level security;
create policy purchase_order_versions_select on public.purchase_order_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
create policy purchase_order_confirmations_select on public.purchase_order_confirmations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.purchase_order_versions, public.purchase_order_confirmations from public, anon, authenticated;
grant select on public.purchase_order_versions, public.purchase_order_confirmations to authenticated;

-- ---------------------------------------------------------------------
-- 3. Contenu d'une commande : même représentation textuelle quelle que soit la saisie (empreinte stable)
--    p_over : modifications proposées [{line_id, qty_ordered, unit_price, expected_date}] ; sans elles, le contenu actuel.
-- ---------------------------------------------------------------------
create function private.po_snapshot(p_po uuid, p_over jsonb default '[]'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'po_no', o.po_no, 'supplier_id', o.supplier_id, 'expected_date', o.expected_date::text,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'line_id', l.id, 'material_id', l.material_id,
        'qty_ordered', to_char(coalesce(ov.qty, l.qty_ordered), 'FM999999999990.0000'),
        'unit_price', to_char(coalesce(ov.price, l.unit_price), 'FM999999999990.0000'),
        'expected_date', coalesce(ov.edate, l.expected_date)::text) order by l.id)
      from public.purchase_order_lines l
      left join lateral (select (x ->> 'qty_ordered')::numeric as qty, (x ->> 'unit_price')::numeric as price,
                                nullif(x ->> 'expected_date', '')::date as edate
                           from jsonb_array_elements(p_over) x where (x ->> 'line_id')::uuid = l.id limit 1) ov on true
      where l.po_id = o.id), '[]'::jsonb))
  from public.purchase_orders o where o.id = p_po
$$;
revoke execute on function private.po_snapshot(uuid, jsonb) from public, anon, authenticated;

create function private.po_total(p_snapshot jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(sum((l ->> 'qty_ordered')::numeric * (l ->> 'unit_price')::numeric), 0) from jsonb_array_elements(p_snapshot -> 'lines') l
$$;

-- Demande d'approbation pour une version (politique 'purchase_order' de 0043). Une seule ouverte par commande.
create function private.po_open_approval(p_po public.purchase_orders, p_version int, p_snapshot jsonb, p_amount numeric, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.approval_policies%rowtype; v_id uuid; v_ver int; v_snap jsonb;
begin
  select * into p from public.approval_policies where company_id = p_po.company_id and object_type = 'purchase_order';
  if not found then raise exception 'APPROVAL_NO_POLICY' using errcode = '55000', detail = 'purchase_order'; end if;
  v_snap := p_snapshot || jsonb_build_object('kind', p_kind, 'version', p_version);
  select coalesce(max(object_version), 0) + 1 into v_ver from public.approval_requests
   where company_id = p_po.company_id and object_type = 'purchase_order' and object_id = p_po.id;
  insert into public.approval_requests (company_id, object_type, object_id, object_version, object_hash, snapshot, amount, state, levels,
    level2_threshold, level1_permission, level2_permission, escalation_permission, deadline_hours, requested_by, deadline_at)
  values (p_po.company_id, 'purchase_order', p_po.id, v_ver, private.approval_hash(v_snap), v_snap, round(p_amount, 2), 'pending_l1', p.levels,
    p.level2_threshold, p.level1_permission, p.level2_permission, p.escalation_permission, p.deadline_hours, auth.uid(),
    now() + make_interval(hours => p.deadline_hours))
  returning id into v_id;
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, object_hash)
  values (v_id, p_po.company_id, 0, 'request', null, 'pending_l1', private.approval_hash(v_snap));
  perform private.write_audit(p_po.company_id, 'approval.request', 'approval', v_id::text, 'purchase_order ' || p_po.po_no || ' v' || p_version, null,
    jsonb_build_object('state', 'pending_l1', 'kind', p_kind, 'version', p_version), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function private.po_open_approval(public.purchase_orders, int, jsonb, numeric, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Soumission d'un brouillon à approbation : version initiale
-- ---------------------------------------------------------------------
create function public.purchase_order_submit(p_po uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v_snap jsonb; v_ver int; v_vid uuid; v_appr uuid; v_total numeric;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if o.approval_pending then raise exception 'PO_APPROVAL_PENDING' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_order_lines where po_id = p_po) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform private.supplier_assert_open(o.supplier_id);
  v_snap := private.po_snapshot(p_po);
  v_total := private.po_total(v_snap);
  select coalesce(max(version), 0) + 1 into v_ver from public.purchase_order_versions where po_id = p_po;
  v_appr := private.po_open_approval(o, v_ver, v_snap, v_total, 'submit');
  insert into public.purchase_order_versions (company_id, po_id, version, kind, status, snapshot, snapshot_hash, total_amount, approval_request_id)
  values (o.company_id, p_po, v_ver, 'initial', 'proposed', v_snap, private.approval_hash(v_snap), v_total, v_appr) returning id into v_vid;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set current_version = v_ver, approval_pending = true where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_submit', 'purchase', o.id::text, o.po_no, null,
    jsonb_build_object('version', v_ver, 'total', v_total, 'approval', v_appr), '{}'::jsonb, 'rpc');
  return v_ver;
end $$;
revoke execute on function public.purchase_order_submit(uuid) from public, anon;
grant execute on function public.purchase_order_submit(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Envoi du brouillon : seulement la version approuvée, contenu identique à celui qui a été approuvé
-- ---------------------------------------------------------------------
create or replace function public.purchase_order_send(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v public.purchase_order_versions%rowtype; v_lead int; v_exp date;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_order_lines where po_id = p_po) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  if o.approval_pending then raise exception 'PO_APPROVAL_PENDING' using errcode = '55000'; end if;
  select * into v from public.purchase_order_versions where po_id = p_po and version = o.approved_version and status = 'approved';
  if not found then raise exception 'PO_NOT_APPROVED' using errcode = '55000'; end if;
  if private.approval_hash(private.po_snapshot(p_po)) <> v.snapshot_hash then raise exception 'PO_CHANGED_AFTER_APPROVAL' using errcode = '55000'; end if;
  perform private.supplier_assert_open(o.supplier_id);
  select coalesce(lead_time_days, 14) into v_lead from public.suppliers where id = o.supplier_id;
  v_exp := coalesce(o.expected_date, (select max(expected_date) from public.purchase_order_lines where po_id = p_po), current_date + v_lead);
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set status = 'sent', sent_at = now(), sent_by = auth.uid(), order_date = current_date, expected_date = v_exp,
         sent_version = v.version where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_send', 'purchase', o.id::text, o.po_no, null,
    jsonb_build_object('version', v.version), jsonb_build_object('total', o.total_amount), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 6. Modification approuvée d'une commande envoyée (nouvelle version ; aucune ligne modifiée avant approbation)
-- ---------------------------------------------------------------------
create function public.purchase_order_amend(p_po uuid, p_lines jsonb, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v_snap jsonb; v_ver int; v_vid uuid; v_appr uuid; v_total numeric; v_over jsonb; v_cover int; l jsonb; v_rat text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('sent', 'partial') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if o.approval_pending then raise exception 'PO_APPROVAL_PENDING' using errcode = '55000'; end if;
  if length(v_rat) < 5 then raise exception 'PO_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'PO_BAD_LINE' using errcode = '22023'; end if;
  select count(*) into v_cover from public.purchase_order_lines where po_id = p_po;
  if jsonb_array_length(p_lines) <> v_cover then raise exception 'PO_BAD_LINE' using errcode = '22023'; end if;
  for l in select value from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from public.purchase_order_lines where id = (l ->> 'line_id')::uuid and po_id = p_po) then
      raise exception 'PO_BAD_LINE' using errcode = '22023';
    end if;
    if l ->> 'qty_ordered' is null or l ->> 'unit_price' is null then raise exception 'PO_BAD_LINE' using errcode = '22023'; end if;
    if (l ->> 'qty_ordered')::numeric <= 0 or (l ->> 'unit_price')::numeric < 0 then raise exception 'PO_BAD_LINE' using errcode = '22023'; end if;
    if (l ->> 'qty_ordered')::numeric < (select qty_received + qty_returned from public.purchase_order_lines where id = (l ->> 'line_id')::uuid) then
      raise exception 'PO_QTY_BELOW_RECEIVED' using errcode = '22023';
    end if;
  end loop;
  v_over := p_lines;
  v_snap := private.po_snapshot(p_po, v_over);
  v_total := private.po_total(v_snap);
  select coalesce(max(version), 0) + 1 into v_ver from public.purchase_order_versions where po_id = p_po;
  v_appr := private.po_open_approval(o, v_ver, v_snap, v_total, 'amend');
  insert into public.purchase_order_versions (company_id, po_id, version, kind, status, snapshot, snapshot_hash, total_amount, reason, approval_request_id)
  values (o.company_id, p_po, v_ver, 'amendment', 'proposed', v_snap, private.approval_hash(v_snap), v_total, v_rat, v_appr) returning id into v_vid;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set current_version = v_ver, approval_pending = true where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_amend', 'purchase', o.id::text, o.po_no, null,
    jsonb_build_object('version', v_ver, 'total', v_total, 'approval', v_appr, 'reason', v_rat), '{}'::jsonb, 'rpc');
  return v_ver;
end $$;
revoke execute on function public.purchase_order_amend(uuid, jsonb, text) from public, anon;
grant execute on function public.purchase_order_amend(uuid, jsonb, text) to authenticated, service_role;

-- Envoi d'une modification approuvée : seule la version approuvée et non encore envoyée peut partir
create function public.purchase_order_send_amendment(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v public.purchase_order_versions%rowtype;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('sent', 'partial') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if o.approval_pending then raise exception 'PO_APPROVAL_PENDING' using errcode = '55000'; end if;
  if o.approved_version is null or o.approved_version = coalesce(o.sent_version, 0) then raise exception 'PO_NOTHING_TO_SEND' using errcode = '55000'; end if;
  select * into v from public.purchase_order_versions where po_id = p_po and version = o.approved_version and status = 'approved';
  if not found then raise exception 'PO_NOT_APPROVED' using errcode = '55000'; end if;
  if private.approval_hash(private.po_snapshot(p_po)) <> v.snapshot_hash then raise exception 'PO_CHANGED_AFTER_APPROVAL' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set sent_version = v.version, sent_at = now(), sent_by = auth.uid() where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_send_amendment', 'purchase', o.id::text, o.po_no, null,
    jsonb_build_object('version', v.version), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.purchase_order_send_amendment(uuid) from public, anon;
grant execute on function public.purchase_order_send_amendment(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Confirmation fournisseur : référence et date, pour la version envoyée
-- ---------------------------------------------------------------------
create function public.purchase_order_confirm(p_po uuid, p_version int, p_reference text, p_confirmed_on date) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v_ref text := btrim(coalesce(p_reference, ''));
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('sent', 'partial') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if o.sent_version is null or p_version is distinct from o.sent_version then raise exception 'PO_STALE_VERSION' using errcode = '55000'; end if;
  if o.confirmed_version = p_version then raise exception 'PO_ALREADY_CONFIRMED' using errcode = '55000'; end if;
  if length(v_ref) < 3 then raise exception 'PO_CONFIRMATION_REFERENCE_REQUIRED' using errcode = '22023'; end if;
  if p_confirmed_on is null or p_confirmed_on > current_date + 1 then raise exception 'PO_BAD_DATE' using errcode = '22023'; end if;
  insert into public.purchase_order_confirmations (company_id, po_id, version, reference, confirmed_on)
  values (o.company_id, p_po, p_version, v_ref, p_confirmed_on);
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set confirmed_version = p_version, confirmed_at = now(), confirmed_by = auth.uid(), confirmation_reference = v_ref where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_confirm', 'purchase', o.id::text, o.po_no, null,
    jsonb_build_object('version', p_version, 'reference', v_ref), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.purchase_order_confirm(uuid, int, text, date) from public, anon;
grant execute on function public.purchase_order_confirm(uuid, int, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Annulation : ferme la demande d'approbation ouverte (journalisée) ; refusée si réceptions
-- ---------------------------------------------------------------------
create or replace function public.purchase_order_cancel(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('draft', 'sent') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_receipts where po_id = p_po) then raise exception 'PURCHASE_HAS_RECEIPTS' using errcode = '55000'; end if;
  insert into public.approval_decisions (request_id, company_id, level, action, from_state, to_state, reason, object_hash)
  select id, company_id, 0, 'cancel', state, 'cancelled', 'annulation de la commande', object_hash
    from public.approval_requests where company_id = o.company_id and object_type = 'purchase_order' and object_id = p_po and state in ('pending_l1', 'pending_l2');
  update public.approval_requests set state = 'cancelled'
   where company_id = o.company_id and object_type = 'purchase_order' and object_id = p_po and state in ('pending_l1', 'pending_l2');
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_request_lines set po_line_id = null where po_line_id in (select id from public.purchase_order_lines where po_id = p_po);
  update public.purchase_requests set status = 'approved' where id = o.request_id and status = 'ordered';
  update public.purchase_orders set status = 'cancelled', approval_pending = false where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_cancel', 'purchase', o.id::text, o.po_no, jsonb_build_object('status', o.status), null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 9. Reliquats : par ligne, quantité commandée, reçue, retournée, restant à recevoir
-- ---------------------------------------------------------------------
create function public.purchase_order_remaining(p_po uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if not private.has_perm('purchases.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'material_id', l.material_id, 'qty_ordered', l.qty_ordered, 'qty_received', l.qty_received,
           'qty_returned', l.qty_returned, 'remaining', greatest(0, l.qty_ordered - l.qty_received), 'unit_price', l.unit_price, 'expected_date', l.expected_date)
         order by l.id), '[]'::jsonb) into v_out
    from public.purchase_order_lines l join public.purchase_orders o on o.id = l.po_id
   where l.po_id = p_po and o.company_id = private.current_company();
  return v_out;
end $$;
grant execute on function public.purchase_order_remaining(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10. Décision d'approbation → version approuvée (et modification appliquée) ; refus → version refusée, rien ne change
-- ---------------------------------------------------------------------
create function private.po_approval_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.purchase_order_versions%rowtype; l jsonb; v_prev text := coalesce(current_setting('purchases.rpc', true), 'off');
begin
  if new.object_type <> 'purchase_order' or new.state = old.state or new.state not in ('approved', 'refused', 'cancelled', 'invalidated') then return new; end if;
  select * into v from public.purchase_order_versions where approval_request_id = new.id;
  if not found then return new; end if;
  perform set_config('purchases.rpc', 'on', true);
  if new.state = 'approved' then
    update public.purchase_order_versions set status = 'superseded' where po_id = v.po_id and status = 'approved';
    if v.kind = 'amendment' then
      for l in select value from jsonb_array_elements(v.snapshot -> 'lines') loop
        if (l ->> 'qty_ordered')::numeric < (select qty_received + qty_returned from public.purchase_order_lines where id = (l ->> 'line_id')::uuid) then
          raise exception 'PO_QTY_BELOW_RECEIVED' using errcode = '22023';   -- revalidé au moment de l'application
        end if;
        update public.purchase_order_lines set qty_ordered = (l ->> 'qty_ordered')::numeric, unit_price = (l ->> 'unit_price')::numeric,
               expected_date = coalesce(nullif(l ->> 'expected_date', '')::date, expected_date)
         where id = (l ->> 'line_id')::uuid and po_id = v.po_id;
      end loop;
    end if;
    update public.purchase_order_versions set status = 'approved', decided_at = now() where id = v.id;
    update public.purchase_orders set approved_version = v.version, approval_pending = false where id = v.po_id;
  else
    update public.purchase_order_versions set status = case when new.state = 'refused' then 'refused' else 'cancelled' end, decided_at = now() where id = v.id;
    update public.purchase_orders set approval_pending = false where id = v.po_id;
  end if;
  perform set_config('purchases.rpc', v_prev, true);
  return new;
end $$;
revoke execute on function private.po_approval_sync() from public, anon, authenticated;
create trigger approval_requests_po_sync_au after update of state on public.approval_requests
  for each row execute function private.po_approval_sync();

-- ---------------------------------------------------------------------
-- 11. Reprise des commandes existantes : une version historique par commande envoyée (accord non tracé), sans modifier leur contenu
-- ---------------------------------------------------------------------
insert into public.purchase_order_versions (company_id, po_id, version, kind, status, snapshot, snapshot_hash, total_amount, reason)
select o.company_id, o.id, 1, 'legacy', 'approved', private.po_snapshot(o.id), private.approval_hash(private.po_snapshot(o.id)), o.total_amount,
       'Commande antérieure à P034 : accord d’envoi non tracé.'
  from public.purchase_orders o
 where o.status in ('sent', 'partial', 'received', 'cancelled')
   and not exists (select 1 from public.purchase_order_versions v where v.po_id = o.id);

select set_config('purchases.rpc', 'on', false);
update public.purchase_orders o set current_version = 1, approved_version = 1, sent_version = 1
 where o.status in ('sent', 'partial', 'received', 'cancelled') and o.current_version = 0;
select set_config('purchases.rpc', 'off', false);
