-- =====================================================================
-- 0044_events_notifications — Outbox, consommateurs idempotents, échecs visibles, replay, notifications internes (P020)
--  Socle réutilisé : approval_decisions (0043, journal ajout seul) comme source d'événements ; user_roles / role_permissions
--  pour désigner les destinataires ; private.write_audit pour la traçabilité.
--  Ajouts :
--    event_outbox        : événement écrit DANS la transaction du changement (si la transaction échoue, rien n'est écrit).
--                          Immuable. Clé d'idempotence unique par société : un même fait ne produit jamais deux événements.
--    event_consumers     : consommateurs connus (un seul pour l'instant : notify_internal).
--    event_deliveries    : état de chaque couple (événement, consommateur) : done / failed / dead, tentatives, dernière erreur.
--    notifications       : notifications INTERNES, dédupliquées par (destinataire, clé). Lecture par le destinataire seul.
--    notification_channels : canaux externes (email, sms, webhook…). Désactivés par défaut ; activés seulement avec une
--                          autorisation écrite (référence, personne, date). Aucun envoi externe n'est implémenté ici.
--  Règles :
--    - un consommateur traite un événement au plus une fois avec effet : une répétition renvoie « already_done » ;
--    - un échec est visible (event_failures) avec sa cause, ses tentatives ; au-delà de 5 tentatives il devient « dead » ;
--    - replay (events.replay) : relance un consommateur en échec ou mort ; sans effet double grâce aux clés ;
--    - aucun canal externe n'est utilisable sans autorisation (EXTERNAL_CHANNEL_DISABLED).
--  Limite : les événements ne sont émis que pour les décisions d'approbation (0043) à ce stade. Les autres modules
--  n'émettent pas encore d'événements (leur ajout suit le même patron : trigger ou appel de event_emit dans la transaction).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, description) values
  ('events.read',                'admin', 'Voir les événements en échec et leur cause'),
  ('events.replay',              'admin', 'Relancer le traitement d''un événement en échec'),
  ('notifications.external',     'admin', 'Autoriser un canal de notification externe (e-mail, SMS, webhook)')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('events.read', 'events.replay', 'notifications.external'))
  or (r.code = 'direction' and p.code = 'events.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Outbox : événements écrits dans la transaction du fait
-- ---------------------------------------------------------------------
create table public.event_outbox (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  event_type      text not null check (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  aggregate_type  text not null check (length(btrim(aggregate_type)) between 2 and 60),
  aggregate_id    text not null check (length(btrim(aggregate_id)) between 1 and 80),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 200),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at     timestamptz not null default now(),
  unique (company_id, idempotency_key)
);
create index event_outbox_order_idx on public.event_outbox (occurred_at, id);

create function private.event_outbox_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'EVENT_OUTBOX_IMMUTABLE' using errcode = '42501';
end $$;
create trigger event_outbox_no_change before update or delete on public.event_outbox
  for each row execute function private.event_outbox_immutable();

-- Émission : un même fait (clé) ne crée jamais deux événements. Appelée dans la transaction du changement.
create function private.event_emit(p_company uuid, p_type text, p_agg_type text, p_agg_id text, p_key text, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.event_outbox (company_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload)
  values (p_company, p_type, p_agg_type, p_agg_id, p_key, p_payload)
  on conflict (company_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.event_outbox where company_id = p_company and idempotency_key = p_key;
  end if;
  return v_id;
end $$;
revoke execute on function private.event_emit(uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- Source : chaque décision d'approbation (0043) produit un événement, dans la même transaction
create function private.emit_approval_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.event_emit(new.company_id, 'approval.' || new.action, 'approval_request', new.request_id::text,
    'approval_decision:' || new.id::text,
    jsonb_build_object('request_id', new.request_id, 'action', new.action, 'level', new.level,
                       'from_state', new.from_state, 'to_state', new.to_state, 'actor_id', new.actor_id));
  return new;
end $$;
create trigger approval_decisions_emit_ai after insert on public.approval_decisions
  for each row execute function private.emit_approval_event();

-- ---------------------------------------------------------------------
-- 3. Consommateurs, livraisons et échecs
-- ---------------------------------------------------------------------
create table public.event_consumers (
  name        text primary key check (name ~ '^[a-z_]{3,40}$'),
  description text not null,
  enabled     boolean not null default true
);
insert into public.event_consumers (name, description) values
  ('notify_internal', 'Notifications internes aux personnes concernées (approbations)');

create table public.event_deliveries (
  event_id     uuid not null references public.event_outbox(id),
  consumer     text not null references public.event_consumers(name),
  company_id   uuid not null references public.companies(id),
  status       text not null check (status in ('done', 'failed', 'dead')),
  attempts     int not null default 0 check (attempts >= 0),
  last_error   text check (last_error is null or length(last_error) <= 300),
  processed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (event_id, consumer),
  check (status <> 'done' or (processed_at is not null and last_error is null))
);

-- ---------------------------------------------------------------------
-- 4. Notifications internes (dédupliquées par destinataire et clé)
-- ---------------------------------------------------------------------
create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  recipient_id    uuid not null references public.profiles(id),
  dedup_key       text not null check (length(btrim(dedup_key)) between 8 and 200),
  kind            text not null check (length(btrim(kind)) between 2 and 60),
  title           text not null check (length(btrim(title)) between 2 and 200),
  body            text check (body is null or length(body) <= 1000),
  link            text check (link is null or link like '/%'),
  source_event_id uuid references public.event_outbox(id),
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  unique (recipient_id, dedup_key)
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- ---------------------------------------------------------------------
-- 5. Canaux externes : désactivés tant que non autorisés
-- ---------------------------------------------------------------------
create table public.notification_channels (
  company_id        uuid not null references public.companies(id),
  channel           text not null check (channel in ('email', 'sms', 'webhook', 'whatsapp')),
  enabled           boolean not null default false,
  authorization_ref text check (authorization_ref is null or length(btrim(authorization_ref)) between 5 and 200),
  authorized_by     uuid references public.profiles(id),
  authorized_at     timestamptz,
  primary key (company_id, channel),
  check (enabled = false or (authorization_ref is not null and authorized_by is not null and authorized_at is not null))
);

-- ---------------------------------------------------------------------
-- 6. Sécurité des tables
-- ---------------------------------------------------------------------
alter table public.event_outbox enable row level security;
create policy event_outbox_select on public.event_outbox for select to authenticated
  using (company_id = private.current_company() and private.has_perm('events.read'));
alter table public.event_consumers enable row level security;
create policy event_consumers_select on public.event_consumers for select to authenticated using (true);
alter table public.event_deliveries enable row level security;
create policy event_deliveries_select on public.event_deliveries for select to authenticated
  using (company_id = private.current_company() and private.has_perm('events.read'));
alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated
  using (company_id = private.current_company() and recipient_id = auth.uid());
alter table public.notification_channels enable row level security;
create policy notification_channels_select on public.notification_channels for select to authenticated
  using (company_id = private.current_company() and private.has_perm('notifications.external'));

revoke all on public.event_outbox, public.event_consumers, public.event_deliveries, public.notifications, public.notification_channels from anon, authenticated;
grant select on public.event_outbox, public.event_consumers, public.event_deliveries, public.notifications, public.notification_channels to authenticated;
grant all on public.event_outbox, public.event_consumers, public.event_deliveries, public.notifications, public.notification_channels to service_role;

-- ---------------------------------------------------------------------
-- 7. Destinataires : titulaires d'une permission dans la société (directe, par rôle)
-- ---------------------------------------------------------------------
create function private.permission_holders(p_company uuid, p_perm text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct ur.user_id
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    join public.profiles pr on pr.id = ur.user_id
   where r.company_id = p_company and p.code = p_perm and pr.is_active and pr.company_id = p_company
$$;
revoke execute on function private.permission_holders(uuid, text) from public, anon, authenticated;

-- Handler du consommateur notify_internal : construit les notifications d'un événement. Renvoie le nombre créé.
create function private.notify_for_event(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  ev public.event_outbox%rowtype; r public.approval_requests%rowtype; v_rid uuid; v_n int := 0; v_uid uuid;
  v_perm text; v_title text; v_body text; v_kind text; v_to uuid[];
begin
  select * into ev from public.event_outbox where id = p_event;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if ev.event_type not in ('approval.request', 'approval.approve', 'approval.refuse') then return 0; end if;

  begin
    v_rid := (ev.payload ->> 'request_id')::uuid;
  exception when others then
    raise exception 'EVENT_PAYLOAD_INVALID' using errcode = '22023', detail = 'request_id';
  end;
  select * into r from public.approval_requests where id = v_rid and company_id = ev.company_id;
  if not found then raise exception 'EVENT_PAYLOAD_INVALID' using errcode = '22023', detail = 'demande introuvable'; end if;

  if ev.event_type = 'approval.request' then
    v_perm := r.level1_permission; v_kind := 'approval_todo';
    v_title := 'Demande d’approbation à traiter';
    v_body := r.object_type || ' version ' || r.object_version;
    v_to := array(select h from private.permission_holders(ev.company_id, v_perm) h where h <> r.requested_by);
  elsif ev.event_type = 'approval.approve' and ev.payload ->> 'to_state' = 'pending_l2' then
    v_perm := r.level2_permission; v_kind := 'approval_todo';
    v_title := 'Second niveau d’approbation requis';
    v_body := r.object_type || ' version ' || r.object_version;
    v_to := array(select h from private.permission_holders(ev.company_id, v_perm) h where h <> r.requested_by and h is distinct from r.level1_by);
  elsif ev.event_type = 'approval.approve' and ev.payload ->> 'to_state' = 'approved' then
    v_kind := 'approval_result'; v_title := 'Votre demande a été approuvée';
    v_body := r.object_type || ' version ' || r.object_version;
    v_to := array[r.requested_by];
  elsif ev.event_type = 'approval.refuse' then
    v_kind := 'approval_result'; v_title := 'Votre demande a été refusée';
    v_body := coalesce(r.refusal_reason, '');
    v_to := array[r.requested_by];
  else
    return 0;
  end if;

  foreach v_uid in array coalesce(v_to, array[]::uuid[]) loop
    insert into public.notifications (company_id, recipient_id, dedup_key, kind, title, body, link, source_event_id)
    values (ev.company_id, v_uid, 'evt:' || ev.id::text, v_kind, v_title, nullif(v_body, ''), '/admin/approvals', ev.id)
    on conflict (recipient_id, dedup_key) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;
revoke execute on function private.notify_for_event(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Traitement d'un événement par un consommateur (idempotent, échec visible)
-- ---------------------------------------------------------------------
create function public.event_process(p_event uuid, p_consumer text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid; v_status text; v_attempts int; v_max constant int := 5; v_enabled boolean;
begin
  if auth.uid() is not null and not private.has_perm('events.replay') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select company_id into v_co from public.event_outbox where id = p_event;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select enabled into v_enabled from public.event_consumers where name = p_consumer;
  if not found or not v_enabled then raise exception 'EVENT_CONSUMER_UNKNOWN' using errcode = '22023', detail = p_consumer; end if;

  select status into v_status from public.event_deliveries where event_id = p_event and consumer = p_consumer;
  if v_status = 'done' then return 'already_done'; end if;
  if v_status = 'dead' then return 'dead'; end if;

  begin
    if p_consumer = 'notify_internal' then perform private.notify_for_event(p_event); end if;
    insert into public.event_deliveries (event_id, consumer, company_id, status, attempts, processed_at, updated_at)
    values (p_event, p_consumer, v_co, 'done', 1, now(), now())
    on conflict (event_id, consumer) do update set status = 'done', attempts = public.event_deliveries.attempts + 1,
      last_error = null, processed_at = now(), updated_at = now();
    return 'done';
  exception when others then
    insert into public.event_deliveries (event_id, consumer, company_id, status, attempts, last_error, updated_at)
    values (p_event, p_consumer, v_co, case when 1 >= v_max then 'dead' else 'failed' end, 1, left(sqlerrm, 300), now())
    on conflict (event_id, consumer) do update set attempts = public.event_deliveries.attempts + 1,
      status = case when public.event_deliveries.attempts + 1 >= v_max then 'dead' else 'failed' end,
      last_error = left(sqlerrm, 300), updated_at = now()
    returning attempts into v_attempts;
    select status into v_status from public.event_deliveries where event_id = p_event and consumer = p_consumer;
    return v_status;
  end;
end $$;
grant execute on function public.event_process(uuid, text) to authenticated, service_role;

-- Passe de traitement : essaie les événements sans livraison réussie (et les échecs non morts)
create function public.event_dispatch(p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e record; v_res text; v_done int := 0; v_failed int := 0; v_dead int := 0;
begin
  if auth.uid() is not null and not private.has_perm('events.replay') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  for e in
    select o.id, c.name from public.event_outbox o cross join public.event_consumers c
     where c.enabled and (v_co is null or o.company_id = v_co)
       and not exists (select 1 from public.event_deliveries d where d.event_id = o.id and d.consumer = c.name and d.status in ('done', 'dead'))
     order by o.occurred_at, o.id, c.name
     limit greatest(least(p_limit, 500), 1)
  loop
    v_res := public.event_process(e.id, e.name);
    if v_res = 'done' then v_done := v_done + 1;
    elsif v_res = 'failed' then v_failed := v_failed + 1;
    elsif v_res = 'dead' then v_dead := v_dead + 1; end if;
  end loop;
  return jsonb_build_object('done', v_done, 'failed', v_failed, 'dead', v_dead);
end $$;
grant execute on function public.event_dispatch(int) to authenticated, service_role;

-- Échecs visibles : cause, tentatives, état (failed = relancé automatiquement ; dead = arrêté, replay requis)
create function public.event_failures(p_limit int default 100) returns table (event_id uuid, event_type text, consumer text, status text, attempts int, last_error text, occurred_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('events.read');
  return query
    select d.event_id, o.event_type, d.consumer, d.status, d.attempts, d.last_error, o.occurred_at
      from public.event_deliveries d join public.event_outbox o on o.id = d.event_id
     where d.company_id = private.current_company() and d.status in ('failed', 'dead')
     order by o.occurred_at desc, d.event_id limit greatest(least(p_limit, 500), 1);
end $$;
grant execute on function public.event_failures(int) to authenticated, service_role;

-- Replay : remet un consommateur en échec ou mort en file, puis le traite. Sans effet double.
create function public.event_replay(p_event uuid, p_consumer text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_res text;
begin
  perform private.require_perm('events.replay');
  if not exists (select 1 from public.event_deliveries where event_id = p_event and consumer = p_consumer and company_id = v_co) then
    raise exception 'EVENT_NOT_FAILED' using errcode = '55000';
  end if;
  update public.event_deliveries set status = 'failed', attempts = 0, updated_at = now()
   where event_id = p_event and consumer = p_consumer and company_id = v_co and status in ('failed', 'dead');
  v_res := public.event_process(p_event, p_consumer);
  perform private.write_audit(v_co, 'event.replay', 'event', p_event::text, p_consumer, null, jsonb_build_object('result', v_res), '{}'::jsonb, 'rpc');
  return v_res;
end $$;
grant execute on function public.event_replay(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 9. Notifications : lecture de ses propres notifications, marquage lu
-- ---------------------------------------------------------------------
create function public.notification_mark_read(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications set read_at = coalesce(read_at, now())
   where id = p_id and recipient_id = auth.uid() and company_id = private.current_company();
  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode = 'P0002'; end if;
end $$;
grant execute on function public.notification_mark_read(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10. Canaux externes : autorisation écrite, désactivation, contrôle avant tout envoi
-- ---------------------------------------------------------------------
create function public.notification_channel_authorize(p_channel text, p_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('notifications.external');
  if length(btrim(coalesce(p_ref, ''))) < 5 then raise exception 'CHANNEL_AUTHORIZATION_REQUIRED' using errcode = '22023'; end if;
  insert into public.notification_channels (company_id, channel, enabled, authorization_ref, authorized_by, authorized_at)
  values (v_co, p_channel, true, btrim(p_ref), auth.uid(), now())
  on conflict (company_id, channel) do update set enabled = true, authorization_ref = excluded.authorization_ref,
    authorized_by = excluded.authorized_by, authorized_at = now();
  perform private.write_audit(v_co, 'notification.channel_authorize', 'notification_channel', p_channel, p_channel, null,
    jsonb_build_object('enabled', true, 'authorization_ref', btrim(p_ref)), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.notification_channel_authorize(text, text) to authenticated, service_role;

create function public.notification_channel_disable(p_channel text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('notifications.external');
  update public.notification_channels set enabled = false, authorization_ref = null, authorized_by = null, authorized_at = null
   where company_id = v_co and channel = p_channel;
  perform private.write_audit(v_co, 'notification.channel_disable', 'notification_channel', p_channel, p_channel, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.notification_channel_disable(text) to authenticated, service_role;

-- Porte d'envoi externe : un futur expéditeur ne doit appeler que cette fonction. Sans autorisation : refus.
create function public.notification_external_allowed(p_channel text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.notification_channels
                    where company_id = private.current_company() and channel = p_channel), false)
$$;
grant execute on function public.notification_external_allowed(text) to authenticated, service_role;
