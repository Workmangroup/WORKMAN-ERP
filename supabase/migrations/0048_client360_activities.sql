-- =====================================================================
-- 0048_client360_activities — Fiche client 360 : visites, adresses courriel autorisées, tâches liées aux pièces, chronologie,
--                             encours (P023)
--  Socle réutilisé et CONSERVÉ : clients, client_contacts, client_complaints (0026), devis / commandes / factures / avoirs
--  (0012), expéditions = BL (0021), BAT = customer_validations (0014), GED et contrats = ged_documents (0005), marge
--  copilot_client_profit (0024, déjà limitée au coût par costs.read).
--  Ajouts :
--    client_visits          : visites, appels, rencontres (journal ajout seul : une correction est une nouvelle entrée)
--    client_email_channels  : adresses courriel AUTORISÉES par finalité, avec preuve ; retrait tracé (jamais effacées)
--    client_tasks           : tâches liées au client, avec responsable et échéance
--    client_task_links      : liens d'une tâche vers les pièces ORIGINALES (devis, commande, facture, réclamation, BL, visite,
--                             document GED, BAT) ; un lien n'est accepté que si la pièce est du même client ET lisible par la personne
--    client_timeline()      : chronologie unifiée ; chaque source n'apparaît que si la personne a le droit de la lire
--    client_balance()       : encours (TTC, par devise), échu, nombre de factures ouvertes — droit invoices.read
--  Règles :
--    - aucune pièce d'un autre client n'apparaît (filtre client + société) ; une source sans droit est omise, sans message
--      qui révèle son existence ;
--    - la marge reste hors de ce lot (costs.read, déjà appliqué dans copilot_client_profit) ;
--    - l'historique n'est jamais effacé : visites et courriels autorisés ajout seul ; retrait = date et auteur ;
--    - audit de chaque écriture.
--  Limites : pas de contrat distinct (les contrats sont des documents GED du dossier « Contrats ») ; pas d'envoi de courriel
--  (la porte client_email_allowed sert à un futur expéditeur) ; encours calculé sur les factures émises (pas de rapprochement
--  bancaire) ; chronologie plafonnée à 500 lignes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Visites : journal ajout seul
-- ---------------------------------------------------------------------
create table public.client_visits (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  client_id   uuid not null references public.clients(id),
  contact_id  uuid references public.client_contacts(id),
  visit_on    date not null default current_date,
  kind        text not null check (kind in ('visit', 'call', 'meeting')),
  summary     text not null check (length(btrim(summary)) between 2 and 1000),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index client_visits_idx on public.client_visits (client_id, visit_on desc);
create trigger client_visits_no_change before update or delete on public.client_visits
  for each row execute function private.append_only_guard();

create function public.client_visit_record(p_client uuid, p_on date, p_kind text, p_summary text, p_contact uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('clients.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_contact is not null and not exists (select 1 from public.client_contacts k where k.id = p_contact and k.client_id = p_client) then
    raise exception 'CLIENT_LINK_INVALID' using errcode = '22023', detail = 'contact';
  end if;
  insert into public.client_visits (company_id, client_id, contact_id, visit_on, kind, summary)
  values (v_co, p_client, p_contact, coalesce(p_on, current_date), p_kind, btrim(p_summary))
  returning id into v_id;
  perform private.write_audit(v_co, 'client.visit_record', 'client', p_client::text, p_kind, null,
    jsonb_build_object('visit', v_id, 'kind', p_kind, 'on', coalesce(p_on, current_date)), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.client_visit_record(uuid, date, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Adresses courriel autorisées par finalité
-- ---------------------------------------------------------------------
create table public.client_email_channels (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id),
  client_id       uuid not null references public.clients(id),
  email           text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and email = lower(email)),
  purpose         text not null check (purpose in ('commercial', 'billing', 'technical')),
  proof           text not null check (length(btrim(proof)) between 5 and 300),
  authorized_at   timestamptz not null default now(),
  authorized_by   uuid default auth.uid(),
  withdrawn_at    timestamptz,
  withdrawn_by    uuid,
  check ((withdrawn_at is null) = (withdrawn_by is null))
);
create unique index client_email_channels_active_uq on public.client_email_channels (client_id, email, purpose) where withdrawn_at is null;

-- Seul le retrait est une modification autorisée ; la preuve et l'adresse ne changent jamais
create function private.client_email_channels_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '42501', detail = 'client_email_channels'; end if;
  if new.client_id is distinct from old.client_id or new.email is distinct from old.email or new.purpose is distinct from old.purpose
     or new.proof is distinct from old.proof or new.authorized_at is distinct from old.authorized_at or new.authorized_by is distinct from old.authorized_by
     or old.withdrawn_at is not null then
    raise exception 'APPEND_ONLY' using errcode = '42501', detail = 'client_email_channels';
  end if;
  return new;
end $$;
create trigger client_email_channels_guard_bu before update or delete on public.client_email_channels
  for each row execute function private.client_email_channels_guard();

create function public.client_email_authorize(p_client uuid, p_email text, p_purpose text, p_proof text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_perm('clients.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co and c.archived_at is null) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_proof, ''))) < 5 then raise exception 'CONSENT_PROOF_REQUIRED' using errcode = '22023'; end if;
  if exists (select 1 from public.client_email_channels e where e.client_id = p_client and e.email = v_email and e.purpose = p_purpose and e.withdrawn_at is null) then
    raise exception 'CLIENT_EMAIL_ALREADY_AUTHORIZED' using errcode = '23505';
  end if;
  insert into public.client_email_channels (company_id, client_id, email, purpose, proof)
  values (v_co, p_client, v_email, p_purpose, btrim(p_proof)) returning id into v_id;
  perform private.write_audit(v_co, 'client.email_authorize', 'client', p_client::text, v_email, null,
    jsonb_build_object('purpose', p_purpose, 'channel', v_id), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.client_email_authorize(uuid, text, text, text) to authenticated, service_role;

create function public.client_email_withdraw(p_channel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); e public.client_email_channels%rowtype;
begin
  perform private.require_perm('clients.write');
  select * into e from public.client_email_channels where id = p_channel and company_id = v_co for update;
  if not found then raise exception 'CLIENT_EMAIL_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.withdrawn_at is not null then raise exception 'CLIENT_EMAIL_BAD_STATUS' using errcode = '55000'; end if;
  update public.client_email_channels set withdrawn_at = now(), withdrawn_by = auth.uid() where id = e.id;
  perform private.write_audit(v_co, 'client.email_withdraw', 'client', e.client_id::text, e.email, null,
    jsonb_build_object('purpose', e.purpose, 'channel', e.id), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.client_email_withdraw(uuid) to authenticated, service_role;

-- Porte d'envoi : un futur expéditeur appelle cette fonction ; sans autorisation active : refus
create function public.client_email_allowed(p_client uuid, p_email text, p_purpose text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.client_email_channels e
                  where e.company_id = private.current_company() and e.client_id = p_client
                    and e.email = lower(btrim(p_email)) and e.purpose = p_purpose and e.withdrawn_at is null)
$$;
grant execute on function public.client_email_allowed(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Tâches et liens vers les pièces originales
-- ---------------------------------------------------------------------
create table public.client_tasks (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  client_id   uuid not null references public.clients(id),
  title       text not null check (length(btrim(title)) between 3 and 200),
  due_on      date not null,
  owner_id    uuid not null references public.profiles(id),
  status      text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  done_by     uuid,
  check ((status = 'done') = (done_at is not null))
);
create index client_tasks_idx on public.client_tasks (client_id, status, due_on);

create table public.client_task_links (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  task_id     uuid not null references public.client_tasks(id) on delete cascade,
  entity_type text not null check (entity_type in ('quote', 'order', 'invoice', 'complaint', 'shipment', 'visit', 'document', 'bat')),
  entity_id   uuid not null,
  created_at  timestamptz not null default now(),
  unique (task_id, entity_type, entity_id)
);

-- Pièce d'un type, du même client, dans la société : existence seule (le droit de lecture est vérifié à part)
create function private.client_piece_exists(p_co uuid, p_client uuid, p_type text, p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'quote' then exists (select 1 from public.quotes x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'order' then exists (select 1 from public.sales_orders x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'invoice' then exists (select 1 from public.invoices x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'complaint' then exists (select 1 from public.client_complaints x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'shipment' then exists (select 1 from public.shipments x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'visit' then exists (select 1 from public.client_visits x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'document' then exists (select 1 from public.ged_documents x where x.id = p_id and x.company_id = p_co and x.client_id = p_client)
    when 'bat' then exists (select 1 from public.customer_validations v join public.development_projects d on d.id = v.project_id
                             where v.id = p_id and v.company_id = p_co and v.kind = 'bat' and d.client_id = p_client)
    else false end
$$;
revoke execute on function private.client_piece_exists(uuid, uuid, text, uuid) from public, anon, authenticated;

-- Droit de lire un type de pièce (ce que la personne peut voir dans la fiche)
create function private.client_piece_readable(p_type text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'quote' then private.has_perm('quotes.read')
    when 'order' then private.has_perm('orders.read')
    when 'invoice' then private.has_perm('invoices.read')
    when 'complaint' then private.has_perm('clients.read')
    when 'shipment' then private.has_perm('shipments.read')
    when 'visit' then private.has_perm('clients.read')
    when 'document' then private.has_perm('documents.read')
    when 'bat' then private.has_perm('development.read')
    else false end
$$;
revoke execute on function private.client_piece_readable(text) from public, anon, authenticated;

create function public.client_task_create(p_client uuid, p_title text, p_due date, p_owner uuid, p_links jsonb default '[]'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_id uuid; v_owner uuid := coalesce(p_owner, auth.uid()); l jsonb; v_type text; v_piece uuid;
begin
  perform private.require_perm('clients.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co and c.archived_at is null) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_due is null then raise exception 'TASK_DUE_REQUIRED' using errcode = '22023'; end if;
  if v_owner is null or v_owner not in (select h from private.permission_holders(v_co, 'clients.write') h) then
    raise exception 'TASK_OWNER_INVALID' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_links, '[]'::jsonb)) > 20 then
    raise exception 'CLIENT_LINK_INVALID' using errcode = '22023', detail = 'liste';
  end if;
  insert into public.client_tasks (company_id, client_id, title, due_on, owner_id) values (v_co, p_client, btrim(p_title), p_due, v_owner)
  returning id into v_id;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    v_type := l ->> 'type';
    begin v_piece := (l ->> 'id')::uuid; exception when others then v_piece := null; end;
    -- une pièce absente, d'un autre client, ou illisible : refus identique (pas de fuite sur son existence)
    if v_piece is null or not private.client_piece_exists(v_co, p_client, v_type, v_piece) or not private.client_piece_readable(v_type) then
      raise exception 'CLIENT_LINK_INVALID' using errcode = '22023', detail = coalesce(v_type, '?');
    end if;
    insert into public.client_task_links (company_id, task_id, entity_type, entity_id) values (v_co, v_id, v_type, v_piece);
  end loop;
  perform private.write_audit(v_co, 'client.task_create', 'client', p_client::text, btrim(p_title), null,
    jsonb_build_object('task', v_id, 'due_on', p_due, 'links', jsonb_array_length(coalesce(p_links, '[]'::jsonb))), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.client_task_create(uuid, text, date, uuid, jsonb) to authenticated, service_role;

create function public.client_task_complete(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.client_tasks%rowtype;
begin
  perform private.require_perm('clients.write');
  select * into t from public.client_tasks where id = p_task and company_id = private.current_company() for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;
  if t.status <> 'open' then raise exception 'TASK_BAD_STATUS' using errcode = '55000'; end if;
  update public.client_tasks set status = 'done', done_at = now(), done_by = auth.uid() where id = t.id;
  perform private.write_audit(t.company_id, 'client.task_done', 'client', t.client_id::text, t.title, null, jsonb_build_object('task', t.id), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.client_task_complete(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Sécurité des tables (lecture par le droit CRM ; écriture par fonctions seulement)
-- ---------------------------------------------------------------------
alter table public.client_visits enable row level security;
create policy client_visits_select on public.client_visits for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
alter table public.client_email_channels enable row level security;
create policy client_email_channels_select on public.client_email_channels for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
alter table public.client_tasks enable row level security;
create policy client_tasks_select on public.client_tasks for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
alter table public.client_task_links enable row level security;
create policy client_task_links_select on public.client_task_links for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read')
         and exists (select 1 from public.client_tasks t where t.id = client_task_links.task_id));
revoke all on public.client_visits, public.client_email_channels, public.client_tasks, public.client_task_links from anon, authenticated;
grant select on public.client_visits, public.client_email_channels, public.client_tasks, public.client_task_links to authenticated;
grant all on public.client_visits, public.client_email_channels, public.client_tasks, public.client_task_links to service_role;

-- ---------------------------------------------------------------------
-- 5. Chronologie : seulement les sources que la personne peut lire, pour ce client
-- ---------------------------------------------------------------------
create function public.client_timeline(p_client uuid, p_limit int default 100) returns table (kind text, ref_id uuid, at timestamptz, label text, status text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('clients.read');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  return query
    select * from (
      select 'visit'::text as kind, v.id as ref_id, v.created_at as at, (v.kind || ' · ' || left(v.summary, 120)) as label, null::text as status
        from public.client_visits v where v.company_id = v_co and v.client_id = p_client
      union all
      select 'email_authorized', e.id, e.authorized_at, e.email || ' (' || e.purpose || ')', 'authorized'
        from public.client_email_channels e where e.company_id = v_co and e.client_id = p_client
      union all
      select 'email_withdrawn', e.id, e.withdrawn_at, e.email || ' (' || e.purpose || ')', 'withdrawn'
        from public.client_email_channels e where e.company_id = v_co and e.client_id = p_client and e.withdrawn_at is not null
      union all
      select 'task', t.id, t.created_at, t.title, t.status
        from public.client_tasks t where t.company_id = v_co and t.client_id = p_client
      union all
      select 'complaint', c.id, c.created_at, c.number || ' · ' || c.subject, c.status
        from public.client_complaints c where c.company_id = v_co and c.client_id = p_client
      union all
      select 'order', o.id, o.order_date::timestamptz, o.code, o.status
        from public.sales_orders o where o.company_id = v_co and o.client_id = p_client and private.has_perm('orders.read')
      union all
      select 'quote', q.id, q.created_at, q.code, q.status
        from public.quotes q where q.company_id = v_co and q.client_id = p_client and private.has_perm('quotes.read')
      union all
      select 'invoice', i.id, coalesce(i.issued_at, i.created_at), coalesce(i.code, 'brouillon'), i.status
        from public.invoices i where i.company_id = v_co and i.client_id = p_client and private.has_perm('invoices.read') and i.status <> 'draft'
      union all
      select 'shipment', s.id, s.created_at, s.number, s.status
        from public.shipments s where s.company_id = v_co and s.client_id = p_client and private.has_perm('shipments.read')
      union all
      select 'bat', v.id, v.created_at, 'BAT v' || v.version_no || ' · ' || d.name, v.status
        from public.customer_validations v join public.development_projects d on d.id = v.project_id
       where v.company_id = v_co and d.client_id = p_client and v.kind = 'bat' and private.has_perm('development.read')
    ) tl
    order by tl.at desc nulls last
    limit greatest(least(coalesce(p_limit, 100), 500), 1);
end $$;
grant execute on function public.client_timeline(uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Encours : par devise, TTC, factures émises ; échu = échéance dépassée
-- ---------------------------------------------------------------------
create function public.client_balance(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v jsonb;
begin
  perform private.require_perm('invoices.read');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('currency', x.currency, 'open_ttc', x.open_ttc, 'overdue_ttc', x.overdue_ttc, 'open_invoices', x.n) order by x.currency), '[]'::jsonb)
    into v
    from (
      select i.currency, sum(greatest(i.total - i.paid_amount - i.credited_amount, 0)) as open_ttc,
             sum(case when i.due_date < current_date then greatest(i.total - i.paid_amount - i.credited_amount, 0) else 0 end) as overdue_ttc,
             count(*)::int as n
        from public.invoices i
       where i.company_id = v_co and i.client_id = p_client and i.status in ('issued', 'partially_paid')
         and i.total - i.paid_amount - i.credited_amount > 0
       group by i.currency
    ) x;
  return v;
end $$;
grant execute on function public.client_balance(uuid) to authenticated, service_role;
