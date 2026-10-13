-- 0081_carrier_tracking_delivery — Transporteurs confirmés, étiquettes, suivi, événements, preuve de livraison, anomalies (P056).
--
-- Existant conservé : expéditions, statuts, BL, événements d'expédition (0021 : shipment_events, shipment_track) ; livraison
-- confirmée par le client (0055 : delivery_confirm, idempotente, preuve textuelle) ; colis (0080) ; réclamations (0026) ;
-- factures (0012 / 0056) ; GED (0005) ; modèle de webhook idempotent (0051 marketing_ingest_event, route /api/webhooks/marketing).
--
-- Règles :
--  * Transporteur utilisable seulement après confirmation par un administrateur (carrier_confirm) et s'il est actif.
--  * Événement transporteur : identifiant fournisseur unique par transporteur. Même identifiant et même contenu (empreinte
--    SHA-256 du corps brut) = doublon sans effet ; même identifiant et contenu différent = conflit refusé ; même suivi, même
--    code et même date sous un autre identifiant = doublon.
--  * Panne reprenable : l'événement est reçu et journalisé avant son application. Si l'application échoue (ex. suivi inconnu,
--    expédition pas encore émise), il reste « en échec » et est rejoué (carrier_events_replay) ; une fois la cause levée, il
--    s'applique une seule fois.
--  * Événements : journal en ajout seul ; seuls l'état de traitement (status, attempts, last_error, applied_at) évolue.
--  * « Livré » : passe l'expédition à livrée (et l'événement de livraison au journal d'expédition). Il ne modifie ni facture,
--    ni avoir, ni réclamation : leur règlement reste une décision distincte.
--  * Preuve de livraison : document GED de la société et du client de l'expédition, lisible seulement avec shipments.read ET
--    documents.read. Un seul document de preuve par expédition.
--  * Anomalies : un événement « exception » ou « returned » ouvre une anomalie ; sa résolution exige un motif et une
--    personne habilitée (shipments.write).
--  * Les appels du webhook (carrier_ingest, carrier_events_replay) ne sont accordés qu'au serveur (service_role).
-- Erreurs : CARRIER_NOT_CONFIRMED, CARRIER_CODE_INVALID, CARRIER_EVENT_INVALID, CARRIER_EVENT_CONFLICT, CARRIER_TRACKING_UNKNOWN,
-- CARRIER_TRACKING_DUPLICATE, CARRIER_LABEL_REF_REQUIRED, CARRIER_APPEND_ONLY, CARRIER_ANOMALY_CLOSED, CARRIER_PROOF_DUPLICATE,
-- CARRIER_PROOF_NOT_DELIVERED, CARRIER_PROOF_DOCUMENT_REQUIRED, CARRIER_REASON_REQUIRED, SHIP_BAD_STATUS, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droit de gestion des transporteurs
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('carriers.manage', 'shipping', 'Gérer les transporteurs', 'Enregistrer et confirmer un transporteur ; rejouer les événements en échec')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'carriers.manage'
where r.is_system and r.code in ('admin', 'direction') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.carriers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code          text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  name          text not null check (length(btrim(name)) between 2 and 120),
  active        boolean not null default true,
  confirmed_at  timestamptz,
  confirmed_by  uuid,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (company_id, code)
);

create table public.carrier_labels (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id     uuid not null references public.shipments(id) on delete restrict,
  package_id      uuid references public.shipment_packages(id) on delete restrict,
  carrier_id      uuid not null references public.carriers(id) on delete restrict,
  tracking_number text not null check (length(btrim(tracking_number)) between 4 and 80),
  label_ref       text not null check (length(btrim(label_ref)) between 3 and 80),
  issued_at       timestamptz not null default now(),
  issued_by       uuid default auth.uid(),
  unique (company_id, carrier_id, tracking_number)
);
create unique index carrier_labels_package_uq on public.carrier_labels (package_id) where package_id is not null;
create index carrier_labels_shipment_idx on public.carrier_labels (shipment_id);

create table public.carrier_events (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  carrier_id         uuid not null references public.carriers(id) on delete restrict,
  provider_event_id  text not null check (length(btrim(provider_event_id)) between 1 and 200),
  tracking_number    text not null check (length(btrim(tracking_number)) between 4 and 80),
  event_code         text not null check (event_code in ('picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned')),
  occurred_at        timestamptz not null,
  location           text check (location is null or length(location) <= 120),
  detail             text check (detail is null or length(detail) <= 300),
  payload_sha256     text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at        timestamptz not null default now(),
  status             text not null default 'pending' check (status in ('pending', 'applied', 'failed')),
  attempts           int not null default 0 check (attempts >= 0),
  last_error         text,
  applied_at         timestamptz,
  unique (company_id, carrier_id, provider_event_id),
  unique (company_id, carrier_id, tracking_number, event_code, occurred_at),
  check ((status = 'applied') = (applied_at is not null))
);
create index carrier_events_pending_idx on public.carrier_events (company_id, status, occurred_at) where status <> 'applied';

create table public.carrier_anomalies (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id  uuid not null references public.shipments(id) on delete restrict,
  event_id     uuid not null unique references public.carrier_events(id) on delete restrict,
  kind         text not null check (kind in ('exception', 'returned')),
  status       text not null default 'open' check (status in ('open', 'resolved')),
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid,
  reason       text check (reason is null or length(btrim(reason)) between 10 and 500),
  check ((status = 'resolved') = (resolved_at is not null and reason is not null))
);

create table public.carrier_proofs (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id         uuid not null unique references public.shipments(id) on delete restrict,
  event_id            uuid not null references public.carrier_events(id) on delete restrict,
  ged_document_id     uuid not null references public.ged_documents(id) on delete restrict,
  attached_at         timestamptz not null default now(),
  attached_by         uuid default auth.uid()
);

-- ---------------------------------------------------------------------------
-- 3. Garde-fous des journaux
-- ---------------------------------------------------------------------------
create function private.carrier_event_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'CARRIER_APPEND_ONLY' using errcode = '42501'; end if;
  if old.status = 'applied' then raise exception 'CARRIER_APPEND_ONLY' using errcode = '42501'; end if;
  if (new.id, new.company_id, new.carrier_id, new.provider_event_id, new.tracking_number, new.event_code, new.occurred_at,
      new.location, new.detail, new.payload_sha256, new.received_at)
     is distinct from (old.id, old.company_id, old.carrier_id, old.provider_event_id, old.tracking_number, old.event_code, old.occurred_at,
      old.location, old.detail, old.payload_sha256, old.received_at) then
    raise exception 'CARRIER_APPEND_ONLY' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function private.carrier_event_guard() from public, anon, authenticated;
create trigger carrier_events_guard_bud before update or delete on public.carrier_events
  for each row execute function private.carrier_event_guard();

create function private.carrier_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'CARRIER_APPEND_ONLY' using errcode = '42501';
end $$;
revoke execute on function private.carrier_immutable() from public, anon, authenticated;
create trigger carrier_labels_immutable_bud before update or delete on public.carrier_labels
  for each row execute function private.carrier_immutable();
create trigger carrier_proofs_immutable_bud before update or delete on public.carrier_proofs
  for each row execute function private.carrier_immutable();

-- ---------------------------------------------------------------------------
-- 4. Transporteurs et étiquettes
-- ---------------------------------------------------------------------------
create function public.carrier_register(p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform private.require_perm('carriers.manage');
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,19}$' then raise exception 'CARRIER_CODE_INVALID' using errcode = '22023'; end if;
  insert into public.carriers (id, company_id, code, name) values (v_id, v_co, v_code, btrim(p_name));
  perform private.write_audit(v_co, 'carrier.register', 'carrier', v_id::text, v_code, null, jsonb_build_object('name', btrim(p_name)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Confirmation d'un transporteur : seule voie vers un webhook accepté.
create function public.carrier_confirm(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.carriers%rowtype;
begin
  perform private.require_perm('carriers.manage');
  select * into c from public.carriers where company_id = v_co and code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'CARRIER_NOT_CONFIRMED' using errcode = 'P0002'; end if;
  update public.carriers set confirmed_at = now(), confirmed_by = auth.uid(), active = true where id = c.id;
  perform private.write_audit(v_co, 'carrier.confirm', 'carrier', c.id::text, c.code, null, jsonb_build_object('confirmed', true), '{}'::jsonb, 'rpc');
end $$;

-- Étiquette : colis fermé (si précisé) de l'expédition, expédition emballée ou expédiée, transporteur confirmé.
create function public.carrier_label_issue(p_shipment uuid, p_package uuid, p_carrier_code text, p_tracking text, p_label_ref text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; c public.carriers%rowtype; pk public.shipment_packages%rowtype;
  v_id uuid := gen_random_uuid(); v_trk text := btrim(coalesce(p_tracking, ''));
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status not in ('packed', 'shipped') then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
  select * into c from public.carriers where company_id = v_co and code = upper(btrim(coalesce(p_carrier_code, '')));
  if not found or c.confirmed_at is null or not c.active then raise exception 'CARRIER_NOT_CONFIRMED' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_label_ref, ''))) < 3 then raise exception 'CARRIER_LABEL_REF_REQUIRED' using errcode = '22023'; end if;
  if p_package is not null then
    select * into pk from public.shipment_packages where id = p_package and shipment_id = s.id;
    if not found or pk.status <> 'closed' then raise exception 'SHIP_PACKAGE_OPEN' using errcode = '55000'; end if;
  end if;
  begin
    insert into public.carrier_labels (id, company_id, shipment_id, package_id, carrier_id, tracking_number, label_ref)
    values (v_id, v_co, s.id, p_package, c.id, v_trk, btrim(p_label_ref));
  exception when unique_violation then
    raise exception 'CARRIER_TRACKING_DUPLICATE' using errcode = '23505';
  end;
  perform private.write_audit(v_co, 'carrier.label_issue', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('carrier', c.code, 'tracking', v_trk, 'label_ref', btrim(p_label_ref)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Application d'un événement (interne) : rejouable, sans effet de bord en cas d'échec
-- ---------------------------------------------------------------------------
create function private.carrier_apply(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.carrier_events%rowtype; l public.carrier_labels%rowtype; s public.shipments%rowtype;
begin
  select * into e from public.carrier_events where id = p_event for update;
  if e.status = 'applied' then return; end if;
  select * into l from public.carrier_labels where company_id = e.company_id and carrier_id = e.carrier_id and tracking_number = e.tracking_number;
  if not found then raise exception 'CARRIER_TRACKING_UNKNOWN' using errcode = 'P0002'; end if;
  select * into s from public.shipments where id = l.shipment_id for update;
  if e.event_code in ('picked_up', 'in_transit', 'out_for_delivery') then
    if s.status <> 'shipped' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
    insert into public.shipment_events (company_id, shipment_id, event_type, location, note) values (e.company_id, s.id, 'in_transit', nullif(btrim(coalesce(e.location, '')), ''), nullif(btrim(coalesce(e.detail, '')), ''));
  elsif e.event_code in ('exception', 'returned') then
    if s.status not in ('shipped', 'delivered') then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
    insert into public.shipment_events (company_id, shipment_id, event_type, location, note) values (e.company_id, s.id, 'exception', nullif(btrim(coalesce(e.location, '')), ''), nullif(btrim(coalesce(e.detail, '')), ''));
    insert into public.carrier_anomalies (company_id, shipment_id, event_id, kind)
    values (e.company_id, s.id, e.id, e.event_code);
  elsif e.event_code = 'delivered' then
    if s.status <> 'shipped' then raise exception 'SHIP_BAD_STATUS' using errcode = '55000'; end if;
    update public.shipments set status = 'delivered', delivered_at = e.occurred_at where id = s.id;
    insert into public.shipment_events (company_id, shipment_id, event_type, location, note) values (e.company_id, s.id, 'delivered', nullif(btrim(coalesce(e.location, '')), ''), nullif(btrim(coalesce(e.detail, '')), ''));
  end if;
  update public.carrier_events set status = 'applied', attempts = attempts + 1, last_error = null, applied_at = now() where id = e.id;
  perform private.write_audit(e.company_id, 'carrier.event_applied', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('event', e.event_code, 'provider_event_id', e.provider_event_id), '{}'::jsonb, 'app');
end $$;
revoke execute on function private.carrier_apply(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Ingestion (serveur) : anti-doublon, conflit, application tolérante aux pannes
-- ---------------------------------------------------------------------------
create function public.carrier_ingest(p_company uuid, p_carrier_code text, p_provider_event_id text, p_tracking text, p_event_code text,
  p_occurred_at timestamptz, p_location text, p_detail text, p_payload_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.carriers%rowtype; e public.carrier_events%rowtype; v_id uuid := gen_random_uuid();
  v_pid text := btrim(coalesce(p_provider_event_id, '')); v_trk text := btrim(coalesce(p_tracking, ''));
begin
  if p_event_code not in ('picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned') or p_occurred_at is null
     or length(v_pid) < 1 or length(v_pid) > 200 or length(v_trk) < 4 or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'CARRIER_EVENT_INVALID' using errcode = '22023';
  end if;
  select * into c from public.carriers where company_id = p_company and code = upper(btrim(coalesce(p_carrier_code, '')));
  if not found or c.confirmed_at is null or not c.active then
    return jsonb_build_object('result', 'refused', 'code', 'CARRIER_NOT_CONFIRMED');
  end if;
  -- même identifiant fournisseur : doublon si le contenu est identique, sinon conflit
  select * into e from public.carrier_events where company_id = p_company and carrier_id = c.id and provider_event_id = v_pid;
  if found then
    if e.payload_sha256 = p_payload_sha256 then
      return jsonb_build_object('result', 'duplicate', 'event_id', e.id, 'status', e.status);
    end if;
    return jsonb_build_object('result', 'conflict', 'code', 'CARRIER_EVENT_CONFLICT', 'event_id', e.id);
  end if;
  -- même suivi, même code, même date sous un autre identifiant : doublon
  select * into e from public.carrier_events where company_id = p_company and carrier_id = c.id and tracking_number = v_trk
    and event_code = p_event_code and occurred_at = p_occurred_at;
  if found then
    return jsonb_build_object('result', 'duplicate', 'event_id', e.id, 'status', e.status);
  end if;
  begin
    insert into public.carrier_events (id, company_id, carrier_id, provider_event_id, tracking_number, event_code, occurred_at, location, detail, payload_sha256)
    values (v_id, p_company, c.id, v_pid, v_trk, p_event_code, p_occurred_at, nullif(btrim(coalesce(p_location, '')), ''),
            nullif(btrim(coalesce(p_detail, '')), ''), p_payload_sha256);
  exception when unique_violation then
    -- réception concurrente de la même livraison : le second appel devient un doublon
    select * into e from public.carrier_events where company_id = p_company and carrier_id = c.id and provider_event_id = v_pid;
    return jsonb_build_object('result', 'duplicate', 'event_id', e.id, 'status', e.status);
  end;
  -- l'événement est reçu ; son application peut échouer sans annuler la réception (reprise par carrier_events_replay)
  begin
    perform private.carrier_apply(v_id);
  exception when others then
    update public.carrier_events set status = 'failed', attempts = attempts + 1, last_error = sqlerrm where id = v_id;
  end;
  select * into e from public.carrier_events where id = v_id;
  return jsonb_build_object('result', 'accepted', 'event_id', v_id, 'status', e.status, 'error', e.last_error);
end $$;

-- Rejeu des événements en attente ou en échec, dans l'ordre de survenue (un transit avant la livraison).
create function public.carrier_events_replay(p_company uuid, p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_applied int := 0; v_failed int := 0;
begin
  for r in select id from public.carrier_events where company_id = p_company and status <> 'applied'
           order by occurred_at, received_at, id limit greatest(coalesce(p_limit, 100), 1) loop
    begin
      perform private.carrier_apply(r.id);
      v_applied := v_applied + 1;
    exception when others then
      update public.carrier_events set status = 'failed', attempts = attempts + 1, last_error = sqlerrm where id = r.id;
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'still_failed', v_failed);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Suivi, anomalies, preuve de livraison
-- ---------------------------------------------------------------------------
create function public.carrier_tracking_get(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; v_labels jsonb; v_events jsonb; v_open int; v_pending int;
begin
  perform private.require_perm('shipments.read');
  select * into s from public.shipments where id = p_shipment and company_id = v_co;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('carrier', c.code, 'tracking', l.tracking_number, 'label_ref', l.label_ref,
      'package_id', l.package_id) order by l.issued_at), '[]'::jsonb)
    into v_labels from public.carrier_labels l join public.carriers c on c.id = l.carrier_id where l.shipment_id = s.id;
  select coalesce(jsonb_agg(jsonb_build_object('event', e.event_code, 'occurred_at', e.occurred_at, 'status', e.status,
      'provider_event_id', e.provider_event_id, 'error', e.last_error) order by e.occurred_at), '[]'::jsonb)
    into v_events from public.carrier_events e join public.carrier_labels l on l.company_id = e.company_id and l.carrier_id = e.carrier_id
      and l.tracking_number = e.tracking_number where l.shipment_id = s.id;
  select count(*) into v_open from public.carrier_anomalies where shipment_id = s.id and status = 'open';
  select count(*) into v_pending from public.carrier_events e join public.carrier_labels l on l.company_id = e.company_id
    and l.carrier_id = e.carrier_id and l.tracking_number = e.tracking_number where l.shipment_id = s.id and e.status <> 'applied';
  return jsonb_build_object('shipment', s.number, 'status', s.status, 'delivered_at', s.delivered_at, 'labels', v_labels,
    'events', v_events, 'open_anomalies', v_open, 'pending_events', v_pending);
end $$;

create function public.carrier_anomaly_resolve(p_anomaly uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.carrier_anomalies%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('shipments.write');
  if length(v_reason) < 10 then raise exception 'CARRIER_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into a from public.carrier_anomalies where id = p_anomaly and company_id = v_co for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status <> 'open' then raise exception 'CARRIER_ANOMALY_CLOSED' using errcode = '55000'; end if;
  update public.carrier_anomalies set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), reason = v_reason where id = a.id;
  perform private.write_audit(v_co, 'carrier.anomaly_resolve', 'shipment', a.shipment_id::text, null, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'resolved'), jsonb_build_object('reason', v_reason), 'rpc');
end $$;

-- Preuve : document GED de la société et du client de l'expédition, après un événement « livré » appliqué.
-- Appelée par le serveur (webhook, pas d'utilisateur) ou par un utilisateur habilité à expédier.
create function public.carrier_proof_attach(p_event uuid, p_document uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid; e public.carrier_events%rowtype; s public.shipments%rowtype; v_client uuid; v_doc_client uuid; v_id uuid := gen_random_uuid();
begin
  if auth.uid() is not null then perform private.require_perm('shipments.write'); v_co := private.current_company(); end if;
  select * into e from public.carrier_events where id = p_event and (v_co is null or company_id = v_co);
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_co is null then v_co := e.company_id; end if;
  if e.event_code <> 'delivered' or e.status <> 'applied' then raise exception 'CARRIER_PROOF_NOT_DELIVERED' using errcode = '55000'; end if;
  select s2.* into s from public.shipments s2 join public.carrier_labels l on l.shipment_id = s2.id
    where l.company_id = e.company_id and l.carrier_id = e.carrier_id and l.tracking_number = e.tracking_number;
  if not found then raise exception 'CARRIER_TRACKING_UNKNOWN' using errcode = 'P0002'; end if;
  select client_id into v_doc_client from public.ged_documents where id = p_document and company_id = v_co and deleted_at is null;
  if not found then raise exception 'CARRIER_PROOF_DOCUMENT_REQUIRED' using errcode = '22023'; end if;
  if v_doc_client is distinct from s.client_id then raise exception 'CARRIER_PROOF_DOCUMENT_REQUIRED' using errcode = '22023'; end if;
  insert into public.carrier_proofs (id, company_id, shipment_id, event_id, ged_document_id)
  values (v_id, v_co, s.id, e.id, p_document);
  perform private.write_audit(v_co, 'carrier.proof_attach', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('document', p_document), '{}'::jsonb, 'app');
  return v_id;
exception when unique_violation then
  raise exception 'CARRIER_PROOF_DUPLICATE' using errcode = '23505';
end $$;

-- Lecture de la preuve : expédition lisible (shipments.read) ET document lisible (documents.read).
create function public.carrier_proof_get(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.carrier_proofs%rowtype; d public.ged_documents%rowtype;
begin
  perform private.require_perm('shipments.read');
  perform private.require_perm('documents.read');
  select * into p from public.carrier_proofs where shipment_id = p_shipment and company_id = v_co;
  if not found then return null; end if;
  select * into d from public.ged_documents where id = p.ged_document_id;
  return jsonb_build_object('shipment_id', p.shipment_id, 'document_id', d.id, 'title', d.title, 'sha256', d.sha256,
    'attached_at', p.attached_at);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.carriers enable row level security;
alter table public.carrier_labels enable row level security;
alter table public.carrier_events enable row level security;
alter table public.carrier_anomalies enable row level security;
alter table public.carrier_proofs enable row level security;
create policy carriers_select on public.carriers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy carrier_labels_select on public.carrier_labels for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy carrier_events_select on public.carrier_events for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy carrier_anomalies_select on public.carrier_anomalies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy carrier_proofs_select on public.carrier_proofs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read') and private.has_perm('documents.read'));
revoke all on public.carriers, public.carrier_labels, public.carrier_events, public.carrier_anomalies, public.carrier_proofs
  from anon, authenticated;
grant select on public.carriers, public.carrier_labels, public.carrier_events, public.carrier_anomalies, public.carrier_proofs to authenticated;
grant all on public.carriers, public.carrier_labels, public.carrier_events, public.carrier_anomalies, public.carrier_proofs to service_role;

revoke execute on function public.carrier_register(text, text), public.carrier_confirm(text),
  public.carrier_label_issue(uuid, uuid, text, text, text), public.carrier_tracking_get(uuid), public.carrier_anomaly_resolve(uuid, text),
  public.carrier_proof_get(uuid) from public, anon;
grant execute on function public.carrier_register(text, text), public.carrier_confirm(text),
  public.carrier_label_issue(uuid, uuid, text, text, text), public.carrier_tracking_get(uuid), public.carrier_anomaly_resolve(uuid, text),
  public.carrier_proof_get(uuid) to authenticated, service_role;
-- Webhook et rejeu : serveur uniquement
revoke execute on function public.carrier_ingest(uuid, text, text, text, text, timestamptz, text, text, text),
  public.carrier_events_replay(uuid, int), public.carrier_proof_attach(uuid, uuid) from public, anon, authenticated;
grant execute on function public.carrier_ingest(uuid, text, text, text, text, timestamptz, text, text, text),
  public.carrier_events_replay(uuid, int), public.carrier_proof_attach(uuid, uuid) to service_role;
-- Les utilisateurs habilités peuvent aussi attacher une preuve (contrôle dans la fonction)
grant execute on function public.carrier_proof_attach(uuid, uuid) to authenticated;
