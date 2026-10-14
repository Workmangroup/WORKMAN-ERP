-- 0082_sav_tickets — Tickets SAV et résolution (P057) : réclamation client / qualité liée à la commande, la facture et les lots ;
-- canal, priorité, responsable, SLA mesurable, preuves, investigation, base de connaissance, réponse proposée, clôture confirmée,
-- détection de doublons, causes répétées liées aux CAPA.
--
-- Existant conservé (0026) : client_complaints (REC-, client, commande, gravité, statuts, solution). Un ticket EST une réclamation :
-- les réclamations antérieures et leur cycle (complaint_open / complaint_update) restent inchangés ; seuls les tickets suivent le
-- parcours ci-dessous. Réutilisés : factures (0012, 0056), lots produits (0055), expéditions (0021), GED (0005), NC et CAPA (0020, 0079),
-- audit (0035). Droits clients.read / clients.write de la fiche client conservés pour la lecture des tickets.
--
-- Règles :
--  * SLA : durées par priorité saisies par un administrateur (aucune valeur par défaut). Sans politique, le ticket n'a pas d'échéance
--    et est compté « sans SLA ». Horloge en minutes écoulées (aucun calendrier ouvré n'est supposé).
--  * Données client protégées : coordonnées du demandeur dans une table distincte, lisibles avec sav.contact seulement ; jamais
--    écrites dans l'audit.
--  * Doublon : un ticket non clos du même client qui partage la commande, la facture ou un lot est un candidat ; la création est
--    suspendue tant que l'agent ne confirme pas (motif) ou ne rattache pas le ticket au principal. Jamais entre clients.
--  * Réponse : proposée à partir d'articles publiés de la base de connaissance ; rien n'est envoyé au client par le système.
--  * Résolution : cause et investigation exigées. Clôture : confirmation (client avec référence, ou interne par une autre personne
--    que celle qui a résolu).
--  * Causes répétées : au-delà d'un seuil explicite, une non-conformité est ouverte et liée aux tickets (CAPA).
-- Erreurs : SAV_OWNER_INVALID, SAV_OWNER_REQUIRED, SAV_CAUSE_REQUIRED, SAV_INVESTIGATION_REQUIRED, SAV_CAUSE_INVALID,
-- SAV_CONFIRMATION_REQUIRED, SAV_CONFIRM_SELF, SAV_KIND_INVALID, SAV_CHANNEL_INVALID, SAV_PRIORITY_INVALID, SAV_TICKET_CLOSED,
-- SAV_NOT_FOUND, SAV_BAD_STATUS, SAV_KB_SELF_PUBLISH, SAV_KB_NOT_PUBLISHED, SAV_THRESHOLD_INVALID, SAV_NO_UNLINKED_TICKETS,
-- SAV_APPEND_ONLY, COMPLAINT_USE_TICKET_FLOW, COMPLAINT_INVOICE_NOT_FOUND, COMPLAINT_LOT_NOT_FOUND, COMPLAINT_LOT_NOT_IN_ORDER,
-- COMPLAINT_DOCUMENT_REQUIRED, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('sav.write',   'clients', 'Traiter les tickets SAV',          'Ouvrir, assigner, investiguer, répondre, résoudre et clore un ticket SAV'),
  ('sav.contact', 'clients', 'Voir les coordonnées du demandeur', 'Nom, e-mail et téléphone du demandeur d''un ticket SAV'),
  ('sav.kb',      'clients', 'Rédiger la base de connaissance SAV', 'Créer des brouillons d''articles de réponse'),
  ('sav.publish', 'clients', 'Publier la base de connaissance SAV', 'Publier ou retirer un article (distinct de son auteur)'),
  ('sav.admin',   'clients', 'Paramétrer le SAV',                 'Politiques de SLA par priorité')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (p.code = 'sav.write'   and r.code in ('admin', 'direction', 'commercial', 'qualite'))
  or (p.code = 'sav.contact' and r.code in ('admin', 'direction', 'commercial'))
  or (p.code = 'sav.kb'      and r.code in ('admin', 'commercial', 'qualite'))
  or (p.code = 'sav.publish' and r.code in ('admin', 'direction', 'qualite'))
  or (p.code = 'sav.admin'   and r.code in ('admin', 'direction')))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Colonnes additives sur les réclamations (un ticket est une réclamation)
-- ---------------------------------------------------------------------------
alter table public.client_complaints
  add column invoice_id          uuid references public.invoices(id) on delete set null,
  add column ticket              boolean not null default false,
  add column channel             text check (channel is null or channel in ('email', 'phone', 'portal', 'whatsapp', 'visit', 'other')),
  add column priority            text check (priority is null or priority in ('low', 'normal', 'high', 'urgent')),
  add column owner_id            uuid,
  add column first_response_due  timestamptz,
  add column resolution_due      timestamptz,
  add column first_response_at   timestamptz,
  add column resolved_by         uuid,
  add column cause_category      text check (cause_category is null or cause_category in
    ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other')),
  add column nc_id               uuid references public.quality_nonconformities(id) on delete set null,
  add column duplicate_of        uuid references public.client_complaints(id) on delete restrict,
  add column close_kind          text check (close_kind is null or close_kind in ('client_confirmed', 'internal_confirmed', 'duplicate')),
  add column close_ref           text check (close_ref is null or length(btrim(close_ref)) between 5 and 200),
  add column closed_by           uuid,
  add constraint complaints_ticket_ck check (not ticket or (channel is not null and priority is not null)),
  add constraint complaints_close_ck check (close_kind is null or status = 'closed'),
  add constraint complaints_close_ticket_ck check (not (ticket and status = 'closed') or close_kind is not null),
  add constraint complaints_duplicate_ck check (duplicate_of is null or close_kind = 'duplicate');
create index client_complaints_open_idx on public.client_complaints (company_id, client_id) where status <> 'closed';
create index client_complaints_cause_idx on public.client_complaints (company_id, cause_category, created_at) where ticket;

-- La facture d'un ticket appartient au même client et à la même société
create function private.complaint_invoice_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.invoice_id is not null and not exists (select 1 from public.invoices i where i.id = new.invoice_id
        and i.company_id = new.company_id and i.client_id = new.client_id) then
    raise exception 'COMPLAINT_INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.complaint_invoice_check() from public, anon, authenticated;
create trigger client_complaints_invoice_check_biu before insert or update on public.client_complaints
  for each row execute function private.complaint_invoice_check();

-- Un ticket ne change pas de statut par le chemin des réclamations antérieures (complaint_update) : seul le parcours ticket le fait.
create function private.complaint_ticket_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.ticket then
    if new.ticket is distinct from old.ticket then raise exception 'COMPLAINT_USE_TICKET_FLOW' using errcode = '55000'; end if;
    if new.status is distinct from old.status and coalesce(current_setting('sav.rpc', true), '') <> 'on' then
      raise exception 'COMPLAINT_USE_TICKET_FLOW' using errcode = '55000';
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.complaint_ticket_guard() from public, anon, authenticated;
create trigger client_complaints_ticket_guard_bu before update on public.client_complaints
  for each row execute function private.complaint_ticket_guard();

-- ---------------------------------------------------------------------------
-- 3. Tables : SLA, lots, demandeur, preuves, investigations, réponses, base de connaissance
-- ---------------------------------------------------------------------------
create table public.sav_sla_policies (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null default private.current_company() references public.companies(id) on delete cascade,
  priority               text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  first_response_minutes int not null check (first_response_minutes between 1 and 525600),
  resolution_minutes     int not null check (resolution_minutes between 1 and 525600),
  set_by                 uuid default auth.uid(),
  set_at                 timestamptz not null default now(),
  unique (company_id, priority),
  check (resolution_minutes >= first_response_minutes)
);

create table public.complaint_lots (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  complaint_id  uuid not null references public.client_complaints(id) on delete restrict,
  lot_id        uuid not null references public.finished_lots(id) on delete restrict,
  added_by      uuid default auth.uid(),
  added_at      timestamptz not null default now(),
  unique (complaint_id, lot_id)
);

create table public.complaint_requesters (
  complaint_id  uuid primary key references public.client_complaints(id) on delete restrict,
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 2 and 120),
  email         text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone         text check (phone is null or length(btrim(phone)) between 5 and 40)
);

create table public.complaint_evidence (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  complaint_id     uuid not null references public.client_complaints(id) on delete restrict,
  ged_document_id  uuid not null references public.ged_documents(id) on delete restrict,
  note             text check (note is null or length(note) <= 300),
  added_by         uuid default auth.uid(),
  added_at         timestamptz not null default now(),
  unique (complaint_id, ged_document_id)
);

create table public.complaint_investigations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  complaint_id    uuid not null references public.client_complaints(id) on delete restrict,
  finding         text not null check (length(btrim(finding)) between 10 and 2000),
  cause_category  text not null check (cause_category in
    ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other')),
  author          uuid default auth.uid(),
  created_at      timestamptz not null default now()
);

create table public.sav_kb_articles (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  title           text not null check (length(btrim(title)) between 3 and 160),
  body            text not null check (length(btrim(body)) between 20 and 4000),
  cause_category  text check (cause_category is null or cause_category in
    ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other')),
  status          text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  author          uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  published_by    uuid,
  published_at    timestamptz,
  check ((status = 'draft') = (published_at is null))
);

create table public.complaint_responses (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  complaint_id  uuid not null references public.client_complaints(id) on delete restrict,
  body          text not null check (length(btrim(body)) between 10 and 4000),
  channel       text not null check (channel in ('email', 'phone', 'portal', 'whatsapp', 'visit', 'other')),
  kb_article_id uuid references public.sav_kb_articles(id) on delete restrict,
  author        uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

-- Journaux en ajout seul ; contenu publié d'un article figé (seul le retrait change son statut)
create function private.sav_ledger_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'SAV_APPEND_ONLY' using errcode = '42501';
end $$;
revoke execute on function private.sav_ledger_guard() from public, anon, authenticated;
create trigger complaint_lots_immutable_bud before update or delete on public.complaint_lots for each row execute function private.sav_ledger_guard();
create trigger complaint_requesters_immutable_bud before update or delete on public.complaint_requesters for each row execute function private.sav_ledger_guard();
create trigger complaint_evidence_immutable_bud before update or delete on public.complaint_evidence for each row execute function private.sav_ledger_guard();
create trigger complaint_investigations_immutable_bud before update or delete on public.complaint_investigations for each row execute function private.sav_ledger_guard();
create trigger complaint_responses_immutable_bud before update or delete on public.complaint_responses for each row execute function private.sav_ledger_guard();

create function private.sav_kb_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'SAV_APPEND_ONLY' using errcode = '42501'; end if;
  if old.status <> 'draft' and (new.title, new.body, new.cause_category, new.author) is distinct from (old.title, old.body, old.cause_category, old.author) then
    raise exception 'SAV_APPEND_ONLY' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function private.sav_kb_guard() from public, anon, authenticated;
create trigger sav_kb_articles_guard_bud before update or delete on public.sav_kb_articles for each row execute function private.sav_kb_guard();

-- ---------------------------------------------------------------------------
-- 4. SLA : politiques par priorité (saisies, jamais supposées)
-- ---------------------------------------------------------------------------
create function public.sla_policy_set(p_priority text, p_first_response_minutes int, p_resolution_minutes int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('sav.admin');
  if p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'SAV_PRIORITY_INVALID' using errcode = '22023'; end if;
  insert into public.sav_sla_policies (company_id, priority, first_response_minutes, resolution_minutes)
  values (v_co, p_priority, p_first_response_minutes, p_resolution_minutes)
  on conflict (company_id, priority) do update set first_response_minutes = excluded.first_response_minutes,
    resolution_minutes = excluded.resolution_minutes, set_by = auth.uid(), set_at = now();
  perform private.write_audit(v_co, 'sav.sla_set', 'sav_sla', p_priority, p_priority, null,
    jsonb_build_object('first_response_minutes', p_first_response_minutes, 'resolution_minutes', p_resolution_minutes), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Ouverture d'un ticket : références, lots, doublon, SLA, coordonnées protégées
-- ---------------------------------------------------------------------------
-- Tickets non clos du même client qui partagent la commande, la facture ou un lot (jamais d'un autre client)
create function private.ticket_candidates(p_co uuid, p_client uuid, p_order uuid, p_invoice uuid, p_lots uuid[]) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id order by c.created_at), '{}'::uuid[])
  from public.client_complaints c
  where c.company_id = p_co and c.client_id = p_client and c.status <> 'closed'
    and ((p_order is not null and c.order_id = p_order)
      or (p_invoice is not null and c.invoice_id = p_invoice)
      or (p_lots is not null and exists (select 1 from public.complaint_lots l where l.complaint_id = c.id and l.lot_id = any (p_lots))))
$$;
revoke execute on function private.ticket_candidates(uuid, uuid, uuid, uuid, uuid[]) from public, anon, authenticated;

create function public.ticket_open(p_client uuid, p_order uuid, p_invoice uuid, p_lots uuid[], p_channel text, p_priority text,
  p_severity text, p_subject text, p_description text, p_contact_name text, p_contact_email text, p_contact_phone text,
  p_duplicate_of uuid default null, p_not_duplicate_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_number text; v_cand uuid[]; v_priority text;
  v_pol public.sav_sla_policies%rowtype; v_has_pol boolean; v_lot uuid; v_cands jsonb; v_dup boolean := p_duplicate_of is not null;
  v_reason text := btrim(coalesce(p_not_duplicate_reason, ''));
begin
  perform private.require_perm('sav.write');
  if p_channel is null or p_channel not in ('email', 'phone', 'portal', 'whatsapp', 'visit', 'other') then raise exception 'SAV_CHANNEL_INVALID' using errcode = '22023'; end if;
  v_priority := coalesce(p_priority, case p_severity when 'critical' then 'urgent' when 'major' then 'high' else 'normal' end);
  if v_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'SAV_PRIORITY_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'COMPLAINT_CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  -- lots : lots produits de ce client ; avec une commande, lots effectivement livrés pour cette commande
  foreach v_lot in array coalesce(p_lots, '{}'::uuid[]) loop
    if not exists (select 1 from public.finished_lots f join public.product_variants pv on pv.id = f.variant_id
                   join public.product_master pm on pm.id = pv.product_id
                   where f.id = v_lot and f.company_id = v_co and pm.client_id = p_client) then
      raise exception 'COMPLAINT_LOT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if p_order is not null and not exists (select 1 from public.shipment_line_lots sll join public.shipment_lines sl on sl.id = sll.shipment_line_id
                   join public.shipments s on s.id = sl.shipment_id where sll.lot_id = v_lot and s.sales_order_id = p_order) then
      raise exception 'COMPLAINT_LOT_NOT_IN_ORDER' using errcode = '22023';
    end if;
  end loop;
  -- doublon : candidats du même client ; création suspendue tant que l'agent ne tranche pas
  v_cand := private.ticket_candidates(v_co, p_client, p_order, p_invoice, p_lots);
  if cardinality(v_cand) > 0 and not v_dup and length(v_reason) < 10 then
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'number', c.number, 'subject', c.subject, 'status', c.status) order by c.created_at), '[]'::jsonb)
      into v_cands from public.client_complaints c where c.id = any (v_cand);
    return jsonb_build_object('result', 'duplicate_suspected', 'candidates', v_cands);
  end if;
  if v_dup and not (p_duplicate_of = any (v_cand)) then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_pol from public.sav_sla_policies where company_id = v_co and priority = v_priority;
  v_has_pol := found;  -- capturé tout de suite : perform réinitialise found
  perform set_config('sav.rpc', 'on', true);
  insert into public.client_complaints (id, client_id, order_id, invoice_id, subject, description, severity, ticket, channel, priority,
      first_response_due, resolution_due, status, closed_at, closed_by, close_kind, duplicate_of, close_ref)
  values (v_id, p_client, p_order, p_invoice, btrim(p_subject), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_severity, 'minor'), true, p_channel, v_priority,
      case when v_has_pol then now() + make_interval(mins => v_pol.first_response_minutes) end,
      case when v_has_pol then now() + make_interval(mins => v_pol.resolution_minutes) end,
      case when v_dup then 'closed' else 'open' end, case when v_dup then now() end, case when v_dup then auth.uid() end,
      case when v_dup then 'duplicate' end, p_duplicate_of, case when v_dup then 'Doublon du ticket principal' end)
  returning number into v_number;
  foreach v_lot in array coalesce(p_lots, '{}'::uuid[]) loop
    insert into public.complaint_lots (company_id, complaint_id, lot_id) values (v_co, v_id, v_lot);
  end loop;
  if btrim(coalesce(p_contact_name, '')) <> '' then
    insert into public.complaint_requesters (complaint_id, company_id, name, email, phone)
    values (v_id, v_co, btrim(p_contact_name), nullif(btrim(coalesce(p_contact_email, '')), ''), nullif(btrim(coalesce(p_contact_phone, '')), ''));
  end if;
  -- l'audit ne contient jamais les coordonnées du demandeur
  perform private.write_audit(v_co, 'sav.ticket_open', 'client', p_client::text, v_number, null,
    jsonb_build_object('priority', v_priority, 'channel', p_channel, 'duplicate', v_dup, 'lots', cardinality(coalesce(p_lots, '{}'::uuid[]))), '{}'::jsonb, 'rpc');
  return jsonb_build_object('result', case when v_dup then 'duplicate_linked' else 'created' end, 'ticket_id', v_id, 'number', v_number,
    'sla', case when v_has_pol then 'defined' else 'no_policy' end);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Traitement : responsable, preuves, investigation, base de connaissance, réponse, résolution, clôture confirmée
-- ---------------------------------------------------------------------------
create function private.ticket_lock(p_id uuid) returns public.client_complaints
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype;
begin
  select * into c from public.client_complaints where id = p_id and company_id = private.current_company() and ticket for update;
  if not found then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  return c;
end $$;
revoke execute on function private.ticket_lock(uuid) from public, anon, authenticated;

create function public.ticket_assign(p_ticket uuid, p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('sav.write');
  c := private.ticket_lock(p_ticket);
  if c.status = 'closed' then raise exception 'SAV_TICKET_CLOSED' using errcode = '55000'; end if;
  if p_owner is null or not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p_owner and r.company_id = v_co) then
    raise exception 'SAV_OWNER_INVALID' using errcode = '22023';
  end if;
  update public.client_complaints set owner_id = p_owner where id = c.id;
  perform private.write_audit(v_co, 'sav.ticket_assign', 'client', c.client_id::text, c.number, null, jsonb_build_object('owner_id', p_owner), '{}'::jsonb, 'rpc');
end $$;

create function public.ticket_evidence_add(p_ticket uuid, p_document uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('sav.write');
  c := private.ticket_lock(p_ticket);
  if c.status = 'closed' then raise exception 'SAV_TICKET_CLOSED' using errcode = '55000'; end if;
  if p_document is null or not exists (select 1 from public.ged_documents where id = p_document and company_id = v_co
       and client_id = c.client_id and deleted_at is null) then
    raise exception 'COMPLAINT_DOCUMENT_REQUIRED' using errcode = '22023';
  end if;
  insert into public.complaint_evidence (company_id, complaint_id, ged_document_id, note) values (v_co, c.id, p_document, nullif(btrim(coalesce(p_note, '')), ''));
  perform private.write_audit(v_co, 'sav.evidence_add', 'client', c.client_id::text, c.number, null, jsonb_build_object('document', p_document), '{}'::jsonb, 'rpc');
end $$;

create function public.ticket_investigate(p_ticket uuid, p_finding text, p_cause text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company(); v_f text := btrim(coalesce(p_finding, ''));
begin
  perform private.require_perm('sav.write');
  c := private.ticket_lock(p_ticket);
  if c.status = 'closed' then raise exception 'SAV_TICKET_CLOSED' using errcode = '55000'; end if;
  if p_cause not in ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other') then raise exception 'SAV_CAUSE_INVALID' using errcode = '22023'; end if;
  insert into public.complaint_investigations (company_id, complaint_id, finding, cause_category) values (v_co, c.id, v_f, p_cause);
  update public.client_complaints set cause_category = p_cause where id = c.id;
  perform private.write_audit(v_co, 'sav.investigate', 'client', c.client_id::text, c.number, null, jsonb_build_object('cause_category', p_cause), '{}'::jsonb, 'rpc');
end $$;

-- Base de connaissance : brouillon, publication par une autre personne que l'auteur, retrait
create function public.kb_article_save(p_title text, p_body text, p_cause text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('sav.kb');
  if p_cause is not null and p_cause not in ('material', 'method', 'machine', 'workforce', 'measurement', 'environment', 'design', 'supplier', 'other') then raise exception 'SAV_CAUSE_INVALID' using errcode = '22023'; end if;
  insert into public.sav_kb_articles (id, company_id, title, body, cause_category) values (v_id, v_co, btrim(p_title), btrim(p_body), p_cause);
  perform private.write_audit(v_co, 'sav.kb_save', 'sav_kb', v_id::text, btrim(p_title), null, '{}'::jsonb, '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.kb_article_publish(p_article uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.sav_kb_articles%rowtype;
begin
  perform private.require_perm('sav.publish');
  select * into a from public.sav_kb_articles where id = p_article and company_id = v_co for update;
  if not found then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status <> 'draft' then raise exception 'SAV_BAD_STATUS' using errcode = '55000'; end if;
  if a.author is not distinct from auth.uid() then raise exception 'SAV_KB_SELF_PUBLISH' using errcode = '42501'; end if;
  update public.sav_kb_articles set status = 'published', published_by = auth.uid(), published_at = now() where id = a.id;
  perform private.write_audit(v_co, 'sav.kb_publish', 'sav_kb', a.id::text, a.title, jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'published'), '{}'::jsonb, 'rpc');
end $$;

create function public.kb_article_retire(p_article uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.sav_kb_articles%rowtype;
begin
  perform private.require_perm('sav.publish');
  select * into a from public.sav_kb_articles where id = p_article and company_id = v_co for update;
  if not found then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  if a.status <> 'published' then raise exception 'SAV_BAD_STATUS' using errcode = '55000'; end if;
  update public.sav_kb_articles set status = 'retired' where id = a.id;
  perform private.write_audit(v_co, 'sav.kb_retire', 'sav_kb', a.id::text, a.title, jsonb_build_object('status', 'published'), jsonb_build_object('status', 'retired'), '{}'::jsonb, 'rpc');
end $$;

-- Réponse proposée : articles publiés de la cause du ticket. Proposition seule : rien n'est enregistré ni envoyé.
create function public.ticket_propose_response(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.client_complaints%rowtype; v_items jsonb;
begin
  perform private.require_perm('sav.write');
  select * into c from public.client_complaints where id = p_ticket and company_id = v_co and ticket;
  if not found then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('article_id', a.id, 'title', a.title, 'body', a.body, 'cause_category', a.cause_category) order by a.published_at desc), '[]'::jsonb)
    into v_items from public.sav_kb_articles a
    where a.company_id = v_co and a.status = 'published' and (a.cause_category is null or a.cause_category = c.cause_category);
  return jsonb_build_object('ticket_id', c.id, 'cause_category', c.cause_category, 'proposals', v_items, 'sent', false);
end $$;

-- Réponse enregistrée par un humain (pas d'envoi par le système) ; la première réponse arrête l'horloge de première réponse.
create function public.ticket_respond(p_ticket uuid, p_body text, p_channel text, p_kb uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('sav.write');
  c := private.ticket_lock(p_ticket);
  if c.status = 'closed' then raise exception 'SAV_TICKET_CLOSED' using errcode = '55000'; end if;
  if c.owner_id is null then raise exception 'SAV_OWNER_REQUIRED' using errcode = '55000'; end if;
  if p_channel is null or p_channel not in ('email', 'phone', 'portal', 'whatsapp', 'visit', 'other') then raise exception 'SAV_CHANNEL_INVALID' using errcode = '22023'; end if;
  if p_kb is not null and not exists (select 1 from public.sav_kb_articles where id = p_kb and company_id = v_co and status = 'published') then
    raise exception 'SAV_KB_NOT_PUBLISHED' using errcode = '22023';
  end if;
  insert into public.complaint_responses (company_id, complaint_id, body, channel, kb_article_id) values (v_co, c.id, btrim(p_body), p_channel, p_kb);
  perform set_config('sav.rpc', 'on', true);
  update public.client_complaints set first_response_at = coalesce(first_response_at, now()),
    status = case when status = 'open' then 'in_progress' else status end where id = c.id;
  perform private.write_audit(v_co, 'sav.respond', 'client', c.client_id::text, c.number, null, jsonb_build_object('channel', p_channel, 'kb', p_kb), '{}'::jsonb, 'rpc');
end $$;

create function public.ticket_resolve(p_ticket uuid, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company(); v_res text := btrim(coalesce(p_resolution, ''));
begin
  perform private.require_perm('sav.write');
  c := private.ticket_lock(p_ticket);
  if c.status not in ('open', 'in_progress') then raise exception 'SAV_BAD_STATUS' using errcode = '55000'; end if;
  if c.owner_id is null then raise exception 'SAV_OWNER_REQUIRED' using errcode = '55000'; end if;
  if c.cause_category is null or not exists (select 1 from public.complaint_investigations where complaint_id = c.id) then
    raise exception 'SAV_INVESTIGATION_REQUIRED' using errcode = '55000';
  end if;
  if length(v_res) < 10 then raise exception 'COMPLAINT_RESOLUTION_REQUIRED' using errcode = '22023'; end if;
  perform set_config('sav.rpc', 'on', true);
  update public.client_complaints set status = 'resolved', resolution = v_res, resolved_at = now(), resolved_by = auth.uid() where id = c.id;
  perform private.write_audit(v_co, 'sav.resolve', 'client', c.client_id::text, c.number, null, jsonb_build_object('cause_category', c.cause_category), '{}'::jsonb, 'rpc');
end $$;

-- Clôture confirmée : client (référence de sa confirmation) ou interne (autre personne que celle qui a résolu, quality.approve)
create function public.ticket_close(p_ticket uuid, p_kind text, p_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company(); v_ref text := btrim(coalesce(p_ref, ''));
begin
  perform private.require_perm('sav.write');
  if p_kind not in ('client_confirmed', 'internal_confirmed') then raise exception 'SAV_KIND_INVALID' using errcode = '22023'; end if;
  c := private.ticket_lock(p_ticket);
  if c.status <> 'resolved' then raise exception 'SAV_BAD_STATUS' using errcode = '55000'; end if;
  if length(v_ref) < 5 then raise exception 'SAV_CONFIRMATION_REQUIRED' using errcode = '22023'; end if;
  if p_kind = 'internal_confirmed' then
    perform private.require_perm('quality.approve');
    if c.resolved_by is not distinct from auth.uid() then raise exception 'SAV_CONFIRM_SELF' using errcode = '42501'; end if;
  end if;
  perform set_config('sav.rpc', 'on', true);
  update public.client_complaints set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_kind = p_kind, close_ref = v_ref where id = c.id;
  perform private.write_audit(v_co, 'sav.close', 'client', c.client_id::text, c.number, null, jsonb_build_object('close_kind', p_kind), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Causes répétées liées aux CAPA
-- ---------------------------------------------------------------------------
create function public.ticket_link_nc(p_ticket uuid, p_nc uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('sav.write');
  c := private.ticket_lock(p_ticket);
  if not exists (select 1 from public.quality_nonconformities where id = p_nc and company_id = v_co) then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.client_complaints set nc_id = p_nc where id = c.id;
  perform private.write_audit(v_co, 'sav.link_nc', 'client', c.client_id::text, c.number, null, jsonb_build_object('nc_id', p_nc), '{}'::jsonb, 'rpc');
end $$;

-- Causes qui reviennent : seuil explicite, fenêtre en jours ; indique ce qui est déjà lié à une non-conformité.
create function public.ticket_repeat_causes(p_days int, p_threshold int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_items jsonb;
begin
  perform private.require_perm('sav.write');
  if p_threshold is null or p_threshold < 2 or p_days is null or p_days < 1 or p_days > 730 then raise exception 'SAV_THRESHOLD_INVALID' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('cause_category', g.cause_category, 'tickets', g.n, 'unlinked', g.unlinked,
      'nonconformities', g.ncs) order by g.n desc, g.cause_category), '[]'::jsonb)
    into v_items from (
      select c.cause_category, count(*)::int n, count(*) filter (where c.nc_id is null)::int unlinked,
             coalesce(jsonb_agg(distinct nc.number) filter (where nc.number is not null), '[]'::jsonb) ncs
      from public.client_complaints c left join public.quality_nonconformities nc on nc.id = c.nc_id
      where c.company_id = v_co and c.ticket and c.cause_category is not null and c.duplicate_of is null
        and c.created_at >= now() - make_interval(days => p_days)
      group by c.cause_category having count(*) >= p_threshold) g;
  return jsonb_build_object('days', p_days, 'threshold', p_threshold, 'causes', v_items);
end $$;

-- Ouvre une non-conformité (CAPA) pour une cause répétée et la lie aux tickets de la période qui n'en ont pas encore.
create function public.ticket_open_capa_for_cause(p_cause text, p_days int, p_threshold int, p_title text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_total int; v_unlinked uuid[]; v_nc uuid; v_numbers text;
begin
  perform private.require_perm('sav.write');
  perform private.require_perm('quality.write');
  if p_threshold is null or p_threshold < 2 or p_days is null or p_days < 1 or p_days > 730 then raise exception 'SAV_THRESHOLD_INVALID' using errcode = '22023'; end if;
  select count(*)::int, coalesce(array_agg(c.id) filter (where c.nc_id is null), '{}'::uuid[]),
         string_agg(c.number, ', ' order by c.number) filter (where c.nc_id is null)
    into v_total, v_unlinked, v_numbers
    from public.client_complaints c
    where c.company_id = v_co and c.ticket and c.cause_category = p_cause and c.duplicate_of is null
      and c.created_at >= now() - make_interval(days => p_days);
  if v_total < p_threshold then raise exception 'SAV_THRESHOLD_INVALID' using errcode = '22023'; end if;
  if cardinality(v_unlinked) = 0 then raise exception 'SAV_NO_UNLINKED_TICKETS' using errcode = '55000'; end if;
  v_nc := public.quality_nc_open(btrim(p_title), 'Cause répétée en SAV (' || p_cause || ', ' || v_total || ' tickets en ' || p_days || ' jours) : ' || v_numbers, 'major', null);
  update public.client_complaints set nc_id = v_nc where id = any (v_unlinked);
  perform private.write_audit(v_co, 'sav.capa_for_cause', 'quality_nonconformity', v_nc::text, null, null,
    jsonb_build_object('cause_category', p_cause, 'tickets', cardinality(v_unlinked)), '{}'::jsonb, 'rpc');
  return jsonb_build_object('nc_id', v_nc, 'linked_tickets', cardinality(v_unlinked), 'total_tickets', v_total);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Lecture : fiche d'un ticket (coordonnées protégées) et rapport de SLA
-- ---------------------------------------------------------------------------
create function public.ticket_get(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.client_complaints%rowtype; v_contact jsonb; v_can boolean := private.has_perm('sav.contact');
  v_lots jsonb; v_inv text; v_dup text; v_nc text; v_sla jsonb;
begin
  perform private.require_perm('clients.read');
  select * into c from public.client_complaints where id = p_ticket and company_id = v_co and ticket;
  if not found then raise exception 'SAV_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_can then
    select jsonb_build_object('name', r.name, 'email', r.email, 'phone', r.phone) into v_contact from public.complaint_requesters r where r.complaint_id = c.id;
  end if;
  select coalesce(jsonb_agg(f.lot_code order by f.lot_code), '[]'::jsonb) into v_lots from public.complaint_lots l join public.finished_lots f on f.id = l.lot_id where l.complaint_id = c.id;
  select code into v_inv from public.invoices where id = c.invoice_id;
  select number into v_dup from public.client_complaints where id = c.duplicate_of;
  select number into v_nc from public.quality_nonconformities where id = c.nc_id;
  v_sla := jsonb_build_object(
    'defined', c.first_response_due is not null,
    'first_response_due', c.first_response_due, 'first_response_at', c.first_response_at,
    'first_response_state', case when c.first_response_due is null then 'no_policy'
        when c.first_response_at is not null then (case when c.first_response_at <= c.first_response_due then 'met' else 'breached' end)
        when now() > c.first_response_due then 'overdue' else 'pending' end,
    'resolution_due', c.resolution_due, 'resolved_at', c.resolved_at,
    'resolution_state', case when c.resolution_due is null then 'no_policy'
        when c.resolved_at is not null then (case when c.resolved_at <= c.resolution_due then 'met' else 'breached' end)
        when now() > c.resolution_due then 'overdue' else 'pending' end);
  return jsonb_build_object('id', c.id, 'number', c.number, 'client_id', c.client_id, 'order_id', c.order_id, 'invoice_id', c.invoice_id, 'invoice', v_inv, 'lots', v_lots,
    'subject', c.subject, 'severity', c.severity, 'priority', c.priority, 'channel', c.channel, 'status', c.status, 'owner_id', c.owner_id,
    'cause_category', c.cause_category, 'nonconformity', v_nc, 'duplicate_of', v_dup, 'close_kind', c.close_kind,
    'responses', (select count(*) from public.complaint_responses where complaint_id = c.id),
    'evidence', (select count(*) from public.complaint_evidence where complaint_id = c.id),
    'investigations', (select count(*) from public.complaint_investigations where complaint_id = c.id),
    'sla', v_sla, 'contact', v_contact, 'contact_protected', not v_can);
end $$;

-- SLA mesurable : par priorité, respectés / manqués / en retard / sans politique, pour les tickets créés dans la période.
create function public.ticket_sla_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_items jsonb;
begin
  perform private.require_perm('clients.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'SAV_THRESHOLD_INVALID' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('priority', t.priority, 'tickets', t.n, 'no_policy', t.no_policy,
      'first_response_met', t.fr_met, 'first_response_breached', t.fr_breached, 'first_response_overdue', t.fr_overdue,
      'resolution_met', t.rs_met, 'resolution_breached', t.rs_breached, 'resolution_overdue', t.rs_overdue) order by t.priority), '[]'::jsonb)
    into v_items from (
      select c.priority, count(*)::int n, count(*) filter (where c.first_response_due is null)::int no_policy,
        count(*) filter (where c.first_response_at is not null and c.first_response_at <= c.first_response_due)::int fr_met,
        count(*) filter (where c.first_response_at is not null and c.first_response_at > c.first_response_due)::int fr_breached,
        count(*) filter (where c.first_response_at is null and c.first_response_due is not null and now() > c.first_response_due)::int fr_overdue,
        count(*) filter (where c.resolved_at is not null and c.resolved_at <= c.resolution_due)::int rs_met,
        count(*) filter (where c.resolved_at is not null and c.resolved_at > c.resolution_due)::int rs_breached,
        count(*) filter (where c.resolved_at is null and c.resolution_due is not null and now() > c.resolution_due)::int rs_overdue
      from public.client_complaints c
      where c.company_id = v_co and c.ticket and c.duplicate_of is null and c.created_at::date between p_from and p_to
      group by c.priority) t;
  return jsonb_build_object('from', p_from, 'to', p_to, 'by_priority', v_items);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.sav_sla_policies enable row level security;
alter table public.complaint_lots enable row level security;
alter table public.complaint_requesters enable row level security;
alter table public.complaint_evidence enable row level security;
alter table public.complaint_investigations enable row level security;
alter table public.complaint_responses enable row level security;
alter table public.sav_kb_articles enable row level security;
create policy sav_sla_policies_select on public.sav_sla_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy complaint_lots_select on public.complaint_lots for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy complaint_requesters_select on public.complaint_requesters for select to authenticated
  using (company_id = private.current_company() and private.has_perm('sav.contact'));
create policy complaint_evidence_select on public.complaint_evidence for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy complaint_investigations_select on public.complaint_investigations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy complaint_responses_select on public.complaint_responses for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
create policy sav_kb_articles_select on public.sav_kb_articles for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('sav.write') or private.has_perm('sav.kb')));
revoke all on public.sav_sla_policies, public.complaint_lots, public.complaint_requesters, public.complaint_evidence,
  public.complaint_investigations, public.complaint_responses, public.sav_kb_articles from anon, authenticated;
grant select on public.sav_sla_policies, public.complaint_lots, public.complaint_requesters, public.complaint_evidence,
  public.complaint_investigations, public.complaint_responses, public.sav_kb_articles to authenticated;
grant all on public.sav_sla_policies, public.complaint_lots, public.complaint_requesters, public.complaint_evidence,
  public.complaint_investigations, public.complaint_responses, public.sav_kb_articles to service_role;

revoke execute on function public.sla_policy_set(text, int, int), public.ticket_open(uuid, uuid, uuid, uuid[], text, text, text, text, text, text, text, text, uuid, text),
  public.ticket_assign(uuid, uuid), public.ticket_evidence_add(uuid, uuid, text), public.ticket_investigate(uuid, text, text),
  public.kb_article_save(text, text, text), public.kb_article_publish(uuid), public.kb_article_retire(uuid), public.ticket_propose_response(uuid),
  public.ticket_respond(uuid, text, text, uuid), public.ticket_resolve(uuid, text), public.ticket_close(uuid, text, text),
  public.ticket_link_nc(uuid, uuid), public.ticket_repeat_causes(int, int), public.ticket_open_capa_for_cause(text, int, int, text),
  public.ticket_get(uuid), public.ticket_sla_report(date, date) from public, anon;
grant execute on function public.sla_policy_set(text, int, int), public.ticket_open(uuid, uuid, uuid, uuid[], text, text, text, text, text, text, text, text, uuid, text),
  public.ticket_assign(uuid, uuid), public.ticket_evidence_add(uuid, uuid, text), public.ticket_investigate(uuid, text, text),
  public.kb_article_save(text, text, text), public.kb_article_publish(uuid), public.kb_article_retire(uuid), public.ticket_propose_response(uuid),
  public.ticket_respond(uuid, text, text, uuid), public.ticket_resolve(uuid, text), public.ticket_close(uuid, text, text),
  public.ticket_link_nc(uuid, uuid), public.ticket_repeat_causes(int, int), public.ticket_open_capa_for_cause(text, int, int, text),
  public.ticket_get(uuid), public.ticket_sla_report(date, date) to authenticated, service_role;
