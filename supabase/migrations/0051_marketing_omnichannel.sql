-- 0051 — Marketing et canaux omnicanaux : segments, campagnes brouillons, modèles e-mail / SMS / WhatsApp,
-- consentements, désinscription, délivrabilité (webhooks idempotents) et coûts.
-- Additive. Aucun connecteur n'est homologué dans cette version : l'envoi réel reste refusé (statut « sent » absent du modèle).
-- Aucune donnée inventée : pas de tarif, pas de politique d'envoi, pas de modèle par défaut.

-- ---------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('marketing.read',      'commercial', 'Voir le marketing',        'Segments, campagnes, délivrabilité et coûts'),
  ('marketing.write',     'commercial', 'Préparer le marketing',    'Modèles, segments, campagnes brouillons, consentements SMS/WhatsApp'),
  ('marketing.send',      'commercial', 'Déclencher un envoi',      'Demande d’envoi réel (refusée tant qu’aucun connecteur n’est autorisé)'),
  ('marketing.configure', 'commercial', 'Configurer le marketing',  'Politique d’envoi, tarifs par canal')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('marketing.read','marketing.write','marketing.send','marketing.configure')
where r.code = 'admin' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('marketing.read','marketing.write')
where r.code = 'commercial' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'marketing.read'
where r.code = 'direction' on conflict do nothing;

-- Mutations : journal d'un seul sens pour les tables append-only ; les autres ne sont modifiables que par fonctions
create function private.marketing_random_token() returns text language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- ---------------------------------------------------------------------
-- 2. Politique d'envoi et tarifs
-- ---------------------------------------------------------------------
create table public.marketing_policy (
  company_id       uuid primary key default private.current_company() references public.companies(id),
  send_enabled     boolean not null default false,
  enabled_channels text[] not null default '{}' check (enabled_channels <@ array['email', 'sms', 'whatsapp']::text[]),
  connector        text check (connector is null),   -- aucun connecteur homologué dans cette version
  updated_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now()
);
alter table public.marketing_policy enable row level security;
create policy marketing_policy_select on public.marketing_policy for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_policy to authenticated;

create function public.marketing_policy_set(p_send_enabled boolean, p_channels text[], p_connector text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_channels text[] := coalesce(p_channels, '{}');
begin
  perform private.require_perm('marketing.configure');
  if p_connector is not null then raise exception 'MARKETING_CONNECTOR_UNKNOWN' using errcode = '22023'; end if;
  if not (v_channels <@ array['email', 'sms', 'whatsapp']::text[]) then raise exception 'MARKETING_CHANNEL_INVALID' using errcode = '22023'; end if;
  insert into public.marketing_policy (company_id, send_enabled, enabled_channels, connector, updated_by, updated_at)
  values (v_co, coalesce(p_send_enabled, false), v_channels, null, auth.uid(), now())
  on conflict (company_id) do update set send_enabled = excluded.send_enabled, enabled_channels = excluded.enabled_channels,
    connector = null, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.write_audit(v_co, 'marketing.policy_set', 'company', v_co::text, 'politique d’envoi', null,
    jsonb_build_object('send_enabled', coalesce(p_send_enabled, false), 'channels', v_channels), null, 'rpc');
  return jsonb_build_object('send_enabled', coalesce(p_send_enabled, false), 'channels', v_channels);
end $$;
grant execute on function public.marketing_policy_set(boolean, text[], text) to authenticated, service_role;

create table public.marketing_channel_prices (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  channel     text not null check (channel in ('email', 'sms', 'whatsapp')),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  unit_price  numeric(12,4) not null check (unit_price >= 0),
  set_by      uuid default auth.uid(),
  set_at      timestamptz not null default now()
);
create trigger marketing_channel_prices_no_change before update or delete on public.marketing_channel_prices
  for each row execute function private.append_only_guard();
alter table public.marketing_channel_prices enable row level security;
create policy marketing_channel_prices_select on public.marketing_channel_prices for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_channel_prices to authenticated;

create function public.marketing_price_set(p_channel text, p_currency char(3), p_unit_price numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('marketing.configure');
  if p_unit_price is null or p_unit_price < 0 then raise exception 'MARKETING_PRICE_INVALID' using errcode = '22023'; end if;
  insert into public.marketing_channel_prices (company_id, channel, currency, unit_price)
  values (v_co, p_channel, p_currency, p_unit_price) returning id into v_id;   -- contrainte de canal : refus si inconnu
  perform private.write_audit(v_co, 'marketing.price_set', 'company', v_co::text, p_channel, null,
    jsonb_build_object('channel', p_channel, 'currency', p_currency, 'unit_price', p_unit_price), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.marketing_price_set(text, char, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Modèles e-mail / SMS / WhatsApp (validés et approuvés par une autre personne)
-- ---------------------------------------------------------------------
create table public.marketing_templates (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  channel      text not null check (channel in ('email', 'sms', 'whatsapp')),
  name         text not null check (length(btrim(name)) between 2 and 120),
  subject      text check (subject is null or length(btrim(subject)) between 2 and 150),
  body         text not null check (length(btrim(body)) between 10 and 2000),
  status       text not null default 'draft' check (status in ('draft', 'approved')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  approved_by  uuid,
  approved_at  timestamptz,
  constraint marketing_templates_subject_chk check (channel <> 'email' or subject is not null),
  constraint marketing_templates_approval_chk check ((status = 'approved') = (approved_by is not null and approved_at is not null))
);
create function private.marketing_template_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'MARKETING_LOCKED' using errcode = '55000'; end if;
    return old;
  end if;
  if old.status = 'approved' then raise exception 'MARKETING_LOCKED' using errcode = '55000'; end if;
  if new.status = 'approved' and (new.company_id, new.channel, new.name, new.subject, new.body)
       is distinct from (old.company_id, old.channel, old.name, old.subject, old.body) then
    raise exception 'MARKETING_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger marketing_templates_guard before update or delete on public.marketing_templates
  for each row execute function private.marketing_template_guard();
alter table public.marketing_templates enable row level security;
create policy marketing_templates_select on public.marketing_templates for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_templates to authenticated;

-- Seuls {{client}} et {{desinscription}} sont autorisés ; le lien de désinscription est obligatoire sur tout modèle
create function private.marketing_body_check(p_body text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if position('{{desinscription}}' in p_body) = 0 then raise exception 'MARKETING_TEMPLATE_INVALID' using errcode = '22023', detail = 'désinscription absente'; end if;
  if position('{{' in replace(replace(p_body, '{{client}}', ''), '{{desinscription}}', '')) > 0 then
    raise exception 'MARKETING_TEMPLATE_INVALID' using errcode = '22023', detail = 'variable non autorisée';
  end if;
end $$;

create function public.marketing_template_create(p_channel text, p_name text, p_subject text, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('marketing.write');
  perform private.marketing_body_check(coalesce(p_body, ''));
  insert into public.marketing_templates (company_id, channel, name, subject, body)
  values (v_co, p_channel, btrim(p_name), nullif(btrim(p_subject), ''), btrim(p_body)) returning id into v_id;
  perform private.write_audit(v_co, 'marketing.template_create', 'marketing_template', v_id::text, btrim(p_name), null,
    jsonb_build_object('channel', p_channel), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.marketing_template_create(text, text, text, text) to authenticated, service_role;

create function public.marketing_template_approve(p_template uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); t public.marketing_templates%rowtype;
begin
  perform private.require_perm('marketing.write');
  select * into t from public.marketing_templates where id = p_template and company_id = v_co for update;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if t.status <> 'draft' then raise exception 'MARKETING_BAD_STATUS' using errcode = '55000'; end if;
  if t.created_by is not distinct from auth.uid() then raise exception 'MARKETING_SOD' using errcode = '42501'; end if;
  update public.marketing_templates set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = t.id;
  perform private.write_audit(v_co, 'marketing.template_approve', 'marketing_template', t.id::text, t.name, null,
    jsonb_build_object('approved_by', auth.uid()), null, 'rpc');
end $$;
grant execute on function public.marketing_template_approve(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Consentements SMS / WhatsApp (e-mail : client_email_channels, finalité « commercial », déjà en place)
-- ---------------------------------------------------------------------
create table public.marketing_phone_channels (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id),
  client_id      uuid not null references public.clients(id),
  channel        text not null check (channel in ('sms', 'whatsapp')),
  phone          text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  proof          text not null check (length(btrim(proof)) between 5 and 300),
  authorized_at  timestamptz not null default now(),
  authorized_by  uuid default auth.uid(),
  withdrawn_at   timestamptz,
  withdrawn_by   uuid,
  check ((withdrawn_at is null) = (withdrawn_by is null))
);
create unique index marketing_phone_channels_active_uq on public.marketing_phone_channels (client_id, channel, phone) where withdrawn_at is null;
create function private.marketing_phone_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if (new.company_id, new.client_id, new.channel, new.phone, new.proof, new.authorized_at, new.authorized_by)
     is distinct from (old.company_id, old.client_id, old.channel, old.phone, old.proof, old.authorized_at, old.authorized_by) then
    raise exception 'APPEND_ONLY' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger marketing_phone_channels_guard before update or delete on public.marketing_phone_channels
  for each row execute function private.marketing_phone_guard();
alter table public.marketing_phone_channels enable row level security;
create policy marketing_phone_channels_select on public.marketing_phone_channels for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_phone_channels to authenticated;

create function public.marketing_phone_authorize(p_client uuid, p_channel text, p_phone text, p_proof text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s.-]', '', 'g');
begin
  perform private.require_perm('marketing.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co and c.archived_at is null) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_proof, ''))) < 5 then raise exception 'CONSENT_PROOF_REQUIRED' using errcode = '22023'; end if;
  if exists (select 1 from public.marketing_phone_channels x where x.client_id = p_client and x.channel = p_channel and x.phone = v_phone and x.withdrawn_at is null) then
    raise exception 'MARKETING_CONSENT_EXISTS' using errcode = '23505';
  end if;
  insert into public.marketing_phone_channels (company_id, client_id, channel, phone, proof)
  values (v_co, p_client, p_channel, v_phone, btrim(p_proof)) returning id into v_id;
  perform private.write_audit(v_co, 'marketing.phone_authorize', 'client', p_client::text, p_channel, null,
    jsonb_build_object('channel', p_channel, 'consent', v_id), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.marketing_phone_authorize(uuid, text, text, text) to authenticated, service_role;

create function public.marketing_phone_withdraw(p_consent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v public.marketing_phone_channels%rowtype;
begin
  perform private.require_perm('marketing.write');
  select * into v from public.marketing_phone_channels where id = p_consent and company_id = v_co for update;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.withdrawn_at is not null then raise exception 'MARKETING_BAD_STATUS' using errcode = '55000'; end if;
  update public.marketing_phone_channels set withdrawn_at = now(), withdrawn_by = auth.uid() where id = v.id;
  perform private.write_audit(v_co, 'marketing.phone_withdraw', 'client', v.client_id::text, v.channel, null,
    jsonb_build_object('consent', v.id), null, 'rpc');
end $$;
grant execute on function public.marketing_phone_withdraw(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Désinscriptions (ajout seul) et liste de suppression (rebonds, plaintes)
-- ---------------------------------------------------------------------
create table public.marketing_unsubscribes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  client_id   uuid not null references public.clients(id),
  channel     text not null check (channel in ('email', 'sms', 'whatsapp')),
  source      text not null check (source in ('link', 'complaint', 'manual')),
  created_at  timestamptz not null default now()
);
create trigger marketing_unsubscribes_no_change before update or delete on public.marketing_unsubscribes
  for each row execute function private.append_only_guard();
alter table public.marketing_unsubscribes enable row level security;
create policy marketing_unsubscribes_select on public.marketing_unsubscribes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_unsubscribes to authenticated;

create table public.marketing_suppressions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  channel     text not null check (channel in ('email', 'sms', 'whatsapp')),
  address     text not null check (length(address) between 3 and 200),
  reason      text not null check (reason in ('bounce', 'complaint')),
  event_key   text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, channel, address)
);
create trigger marketing_suppressions_no_change before update or delete on public.marketing_suppressions
  for each row execute function private.append_only_guard();
alter table public.marketing_suppressions enable row level security;
create policy marketing_suppressions_select on public.marketing_suppressions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_suppressions to authenticated;

-- ---------------------------------------------------------------------
-- 6. Segments (règle explicite : canal, pays facultatif, liste de clients facultative)
-- ---------------------------------------------------------------------
create table public.marketing_segments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  name        text not null check (length(btrim(name)) between 2 and 120),
  channel     text not null check (channel in ('email', 'sms', 'whatsapp')),
  country     char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  client_ids  uuid[],
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create trigger marketing_segments_no_change before update or delete on public.marketing_segments
  for each row execute function private.append_only_guard();
alter table public.marketing_segments enable row level security;
create policy marketing_segments_select on public.marketing_segments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_segments to authenticated;

create function public.marketing_segment_create(p_name text, p_channel text, p_country text, p_client_ids uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('marketing.write');
  if p_client_ids is not null and exists (select 1 from unnest(p_client_ids) u(id)
       where not exists (select 1 from public.clients c where c.id = u.id and c.company_id = v_co)) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.marketing_segments (company_id, name, channel, country, client_ids)
  values (v_co, btrim(p_name), p_channel, nullif(upper(btrim(coalesce(p_country, ''))), ''), p_client_ids) returning id into v_id;
  perform private.write_audit(v_co, 'marketing.segment_create', 'marketing_segment', v_id::text, btrim(p_name), null,
    jsonb_build_object('channel', p_channel, 'clients', coalesce(array_length(p_client_ids, 1), 0)), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.marketing_segment_create(text, text, text, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Campagnes (brouillons) et destinataires (instantané recalculé à chaque préparation)
-- ---------------------------------------------------------------------
create table public.marketing_campaigns (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  name             text not null check (length(btrim(name)) between 2 and 120),
  channel          text not null check (channel in ('email', 'sms', 'whatsapp')),
  template_id      uuid not null references public.marketing_templates(id),
  subject_snapshot text,
  body_snapshot   text not null,
  segment_id       uuid not null references public.marketing_segments(id),
  status           text not null default 'draft' check (status in ('draft', 'prepared', 'cancelled')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  prepared_by      uuid,
  prepared_at      timestamptz,
  constraint marketing_campaigns_prepared_chk check ((status = 'draft') or prepared_at is not null)
);
create function private.marketing_campaign_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'MARKETING_LOCKED' using errcode = '55000'; end if;
    return old;
  end if;
  if (new.company_id, new.name, new.channel, new.template_id, new.subject_snapshot, new.body_snapshot, new.segment_id, new.created_by, new.created_at)
     is distinct from (old.company_id, old.name, old.channel, old.template_id, old.subject_snapshot, old.body_snapshot, old.segment_id, old.created_by, old.created_at) then
    raise exception 'MARKETING_LOCKED' using errcode = '55000';
  end if;
  if old.status = 'cancelled' or (old.status = 'prepared' and new.status = 'draft') then raise exception 'MARKETING_BAD_STATUS' using errcode = '55000'; end if;
  return new;
end $$;
create trigger marketing_campaigns_guard before update or delete on public.marketing_campaigns
  for each row execute function private.marketing_campaign_guard();
alter table public.marketing_campaigns enable row level security;
create policy marketing_campaigns_select on public.marketing_campaigns for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_campaigns to authenticated;

create table public.marketing_recipients (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id),
  campaign_id   uuid not null references public.marketing_campaigns(id) on delete cascade,
  client_id     uuid not null references public.clients(id),
  channel       text not null check (channel in ('email', 'sms', 'whatsapp')),
  address       text,
  status        text not null check (status in ('eligible', 'excluded')),
  reason        text check (reason in ('no_consent', 'unsubscribed', 'suppressed')),
  token         text not null unique default private.marketing_random_token(),
  unique (campaign_id, client_id),
  constraint marketing_recipients_status_chk check ((status = 'eligible') = (reason is null)),
  constraint marketing_recipients_address_chk check (status = 'excluded' or address is not null)
);
alter table public.marketing_recipients enable row level security;
create policy marketing_recipients_select on public.marketing_recipients for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_recipients to authenticated;

-- Audience : clients du segment (ou tous, non archivés), pays optionnel. Précédence des exclusions :
-- liste de suppression, puis désinscription postérieure au dernier consentement, puis absence de consentement actif.
create function private.marketing_audience(p_company uuid, p_segment uuid) returns table(client_id uuid, channel text, address text, status text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare s public.marketing_segments%rowtype; c record; v_addr text; v_last timestamptz; v_unsub boolean; v_suppressed boolean;
begin
  select * into s from public.marketing_segments where id = p_segment and company_id = p_company;
  for c in select cl.id from public.clients cl
           where cl.company_id = p_company and cl.archived_at is null
             and (s.client_ids is null or cl.id = any(s.client_ids))
             and (s.country is null or cl.country = s.country)
           order by cl.name loop
    v_addr := null; v_last := null;
    if s.channel = 'email' then
      select e.email, e.authorized_at into v_addr, v_last from public.client_email_channels e
       where e.company_id = p_company and e.client_id = c.id and e.purpose = 'commercial' and e.withdrawn_at is null
       order by e.authorized_at desc limit 1;
      select max(e.authorized_at) into v_last from public.client_email_channels e where e.company_id = p_company and e.client_id = c.id and e.purpose = 'commercial';
    else
      select p.phone, p.authorized_at into v_addr, v_last from public.marketing_phone_channels p
       where p.company_id = p_company and p.client_id = c.id and p.channel = s.channel and p.withdrawn_at is null
       order by p.authorized_at desc limit 1;
      select max(p.authorized_at) into v_last from public.marketing_phone_channels p where p.company_id = p_company and p.client_id = c.id and p.channel = s.channel;
    end if;
    v_suppressed := v_addr is not null and exists (select 1 from public.marketing_suppressions x
                     where x.company_id = p_company and x.channel = s.channel and x.address = v_addr);
    v_unsub := exists (select 1 from public.marketing_unsubscribes u
                where u.company_id = p_company and u.client_id = c.id and u.channel = s.channel and u.created_at > coalesce(v_last, '-infinity'::timestamptz));
    if v_suppressed then return query select c.id, s.channel, v_addr, 'excluded'::text, 'suppressed'::text;
    elsif v_unsub then return query select c.id, s.channel, v_addr, 'excluded'::text, 'unsubscribed'::text;
    elsif v_addr is null then return query select c.id, s.channel, null::text, 'excluded'::text, 'no_consent'::text;
    else return query select c.id, s.channel, v_addr, 'eligible'::text, null::text;
    end if;
  end loop;
end $$;

create function public.marketing_campaign_create(p_name text, p_template uuid, p_segment uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; t public.marketing_templates%rowtype; s public.marketing_segments%rowtype;
begin
  perform private.require_perm('marketing.write');
  select * into t from public.marketing_templates where id = p_template and company_id = v_co;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if t.status <> 'approved' then raise exception 'MARKETING_TEMPLATE_NOT_APPROVED' using errcode = '55000'; end if;
  select * into s from public.marketing_segments where id = p_segment and company_id = v_co;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.channel <> t.channel then raise exception 'MARKETING_CHANNEL_MISMATCH' using errcode = '22023'; end if;
  insert into public.marketing_campaigns (company_id, name, channel, template_id, subject_snapshot, body_snapshot, segment_id)
  values (v_co, btrim(p_name), t.channel, t.id, t.subject, t.body, s.id) returning id into v_id;
  perform private.write_audit(v_co, 'marketing.campaign_create', 'marketing_campaign', v_id::text, btrim(p_name), null,
    jsonb_build_object('template', t.id, 'segment', s.id), null, 'rpc');
  return v_id;
end $$;
grant execute on function public.marketing_campaign_create(text, uuid, uuid) to authenticated, service_role;

-- Préparation : reconstruit les destinataires (rejouable, même résultat à données égales) ; ne envoie rien
create function public.marketing_campaign_prepare(p_campaign uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); k public.marketing_campaigns%rowtype; r record; v_tokens jsonb;
begin
  perform private.require_perm('marketing.write');
  select * into k from public.marketing_campaigns where id = p_campaign and company_id = v_co for update;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if k.status = 'cancelled' then raise exception 'MARKETING_BAD_STATUS' using errcode = '55000'; end if;
  -- Les jetons de désinscription déjà diffusés restent valides : une préparation rejouée reprend le jeton de chaque destinataire
  select coalesce(jsonb_object_agg(m.client_id::text, m.token), '{}'::jsonb) into v_tokens from public.marketing_recipients m where m.campaign_id = k.id;
  delete from public.marketing_recipients where campaign_id = k.id;
  for r in select * from private.marketing_audience(v_co, k.segment_id) loop
    insert into public.marketing_recipients (company_id, campaign_id, client_id, channel, address, status, reason, token)
    values (v_co, k.id, r.client_id, r.channel, r.address, r.status, r.reason,
            coalesce(v_tokens ->> r.client_id::text, private.marketing_random_token()));
  end loop;
  update public.marketing_campaigns set status = 'prepared', prepared_by = auth.uid(), prepared_at = now() where id = k.id;
  perform private.write_audit(v_co, 'marketing.campaign_prepare', 'marketing_campaign', k.id::text, k.name, null,
    jsonb_build_object('eligible', (select count(*) from public.marketing_recipients where campaign_id = k.id and status = 'eligible')), null, 'rpc');
  return public.marketing_campaign_summary(k.id);
end $$;
grant execute on function public.marketing_campaign_prepare(uuid) to authenticated, service_role;

-- Résumé : destinataires par statut, coût estimé (éligibles × dernier tarif du canal, sinon null), délivrabilité issue des webhooks
create function public.marketing_campaign_summary(p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); k public.marketing_campaigns%rowtype; v_eligible int; v_price public.marketing_channel_prices%rowtype;
  v_excl jsonb; v_events jsonb;
begin
  perform private.require_perm('marketing.read');
  select * into k from public.marketing_campaigns where id = p_campaign and company_id = v_co;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  select count(*)::int into v_eligible from public.marketing_recipients where campaign_id = k.id and status = 'eligible';
  select coalesce(jsonb_object_agg(reason, n), '{}') into v_excl from (
    select reason, count(*)::int n from public.marketing_recipients where campaign_id = k.id and status = 'excluded' group by reason) x;
  select * into v_price from public.marketing_channel_prices where company_id = v_co and channel = k.channel order by set_at desc limit 1;
  select coalesce(jsonb_object_agg(event_type, n), '{}') into v_events from (
    select event_type, count(*)::int n from public.marketing_events where company_id = v_co and campaign_id = k.id group by event_type) x;
  return jsonb_build_object('campaign_id', k.id, 'name', k.name, 'channel', k.channel, 'status', k.status,
    'eligible', v_eligible, 'excluded', v_excl,
    'unit_price', v_price.unit_price, 'currency', v_price.currency,
    'estimated_cost', case when v_price.unit_price is null then null else round(v_eligible * v_price.unit_price, 2) end,
    'events', v_events);
end $$;
grant execute on function public.marketing_campaign_summary(uuid) to authenticated, service_role;

-- Demande d'envoi : toujours refusée dans cette version (aucun connecteur homologué). Le refus est journalisé et renvoyé
-- sans exception, pour que l'audit soit conservé. Aucun statut « envoyé » n'existe.
create function private.marketing_send_gate(p_company uuid, p_channel text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v public.marketing_policy%rowtype;
begin
  select * into v from public.marketing_policy where company_id = p_company;
  if not found or not v.send_enabled then return 'POLICY_DISABLED'; end if;
  if v.connector is null then return 'NO_CONNECTOR'; end if;
  if not (p_channel = any(v.enabled_channels)) then return 'CHANNEL_NOT_ENABLED'; end if;
  return 'CONNECTOR_NOT_IMPLEMENTED';
end $$;

create function public.marketing_campaign_send(p_campaign uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); k public.marketing_campaigns%rowtype; v_gate text;
begin
  perform private.require_perm('marketing.send');
  select * into k from public.marketing_campaigns where id = p_campaign and company_id = v_co;
  if not found then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if k.status <> 'prepared' then raise exception 'MARKETING_NOT_PREPARED' using errcode = '55000'; end if;
  v_gate := private.marketing_send_gate(v_co, k.channel);
  perform private.write_audit(v_co, 'marketing.send_refused', 'marketing_campaign', k.id::text, k.name, null,
    jsonb_build_object('reason', v_gate), null, 'rpc');
  return jsonb_build_object('sent', false, 'reason', v_gate);
end $$;
grant execute on function public.marketing_campaign_send(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Désinscription publique (jeton par destinataire) : réponse identique, que le jeton existe ou non
-- ---------------------------------------------------------------------
create function public.marketing_unsubscribe(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.marketing_recipients%rowtype;
begin
  if p_token is null or length(p_token) <> 64 then return; end if;
  select * into r from public.marketing_recipients where token = p_token;
  if not found then return; end if;
  insert into public.marketing_unsubscribes (company_id, client_id, channel, source) values (r.company_id, r.client_id, r.channel, 'link');
  perform private.write_audit(r.company_id, 'marketing.unsubscribe', 'client', r.client_id::text, r.channel, null, null,
    jsonb_build_object('campaign', r.campaign_id), 'app');
end $$;
grant execute on function public.marketing_unsubscribe(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 9. Délivrabilité : webhooks idempotents (appel serveur uniquement, après vérification de signature)
-- ---------------------------------------------------------------------
create table public.marketing_events (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  provider          text not null check (length(btrim(provider)) between 1 and 40),
  provider_event_id text not null check (length(btrim(provider_event_id)) between 1 and 200),
  event_type        text not null check (event_type in ('delivered', 'bounced', 'complained', 'opened', 'clicked', 'failed')),
  channel           text not null check (channel in ('email', 'sms', 'whatsapp')),
  address           text not null,
  campaign_id       uuid references public.marketing_campaigns(id),
  occurred_at       timestamptz not null,
  received_at       timestamptz not null default now(),
  unique (provider, provider_event_id)
);
create trigger marketing_events_no_change before update or delete on public.marketing_events
  for each row execute function private.append_only_guard();
alter table public.marketing_events enable row level security;
create policy marketing_events_select on public.marketing_events for select to authenticated
  using (company_id = private.current_company() and private.has_perm('marketing.read'));
grant select on public.marketing_events to authenticated;

create function public.marketing_ingest_event(p_company uuid, p_provider text, p_event_id text, p_type text, p_channel text,
  p_address text, p_campaign uuid, p_occurred timestamptz) returns text
language plpgsql security definer set search_path = '' as $$
declare v_addr text := lower(btrim(coalesce(p_address, ''))); v_client uuid; v_new uuid;
begin
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_campaign is not null and not exists (select 1 from public.marketing_campaigns where id = p_campaign and company_id = p_company) then
    raise exception 'MARKETING_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.marketing_events (company_id, provider, provider_event_id, event_type, channel, address, campaign_id, occurred_at)
  values (p_company, btrim(p_provider), btrim(p_event_id), p_type, p_channel, v_addr, p_campaign, p_occurred)
  on conflict (provider, provider_event_id) do nothing
  returning id into v_new;
  if v_new is null then return 'duplicate'; end if;   -- déjà reçu : aucun effet de bord rejoué
  if p_type in ('bounced', 'complained') then
    insert into public.marketing_suppressions (company_id, channel, address, reason, event_key)
    values (p_company, p_channel, v_addr, case when p_type = 'bounced' then 'bounce' else 'complaint' end, btrim(p_provider) || ':' || btrim(p_event_id))
    on conflict (company_id, channel, address) do nothing;
  end if;
  if p_type = 'complained' then
    select c.client_id into v_client from public.client_email_channels c where p_channel = 'email' and c.company_id = p_company and c.email = v_addr limit 1;
    if v_client is null then
      select p.client_id into v_client from public.marketing_phone_channels p where p_channel <> 'email' and p.company_id = p_company and p.phone = v_addr limit 1;
    end if;
    if v_client is not null then
      insert into public.marketing_unsubscribes (company_id, client_id, channel, source) values (p_company, v_client, p_channel, 'complaint');
    end if;
  end if;
  return 'recorded';
end $$;
revoke execute on function public.marketing_ingest_event(uuid, text, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.marketing_ingest_event(uuid, text, text, text, text, text, uuid, timestamptz) to service_role;

-- Verrouillage : écritures uniquement par fonctions
revoke all on public.marketing_policy, public.marketing_channel_prices, public.marketing_templates, public.marketing_phone_channels,
  public.marketing_unsubscribes, public.marketing_suppressions, public.marketing_segments, public.marketing_campaigns,
  public.marketing_recipients, public.marketing_events from anon;
revoke insert, update, delete, truncate on public.marketing_policy, public.marketing_channel_prices, public.marketing_templates, public.marketing_phone_channels,
  public.marketing_unsubscribes, public.marketing_suppressions, public.marketing_segments, public.marketing_campaigns,
  public.marketing_recipients, public.marketing_events from authenticated;
