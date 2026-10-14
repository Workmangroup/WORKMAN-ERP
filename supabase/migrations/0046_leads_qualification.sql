-- =====================================================================
-- 0046_leads_qualification — Prospects : scope commercial, qualification, consentements, tâches, conversion sans perte (P021)
--  Socle conservé et réutilisé : prospects, prospect_activities, quotes (0012) ; clients (0004) ; profils (0001) ;
--  permissions prospects.read / prospects.write / clients.read / clients.write ; private.next_seq ; private.write_audit.
--  Changements (additifs ou de droits, documentés) :
--    1. SCOPE : un commercial ne voit et ne modifie que ses prospects (owner_id = lui-même) ; prospects.read_all
--       (admin, direction) voit tout. Les activités suivent le prospect. Le RLS générique de 0012 est remplacé.
--    2. Colonnes prospects : segment ; confirmations de qualification (budget, besoin, décideur, échéance) ; traces de conversion.
--    3. prospect_set_stage : l'étape « qualifié » exige les trois confirmations (règle proposée, à valider par le propriétaire).
--    4. prospect_convert devient un appel de lead_convert (même signature) : plus aucune suppression de lien devis-prospect.
--    5. Nouvelles tables : prospect_consents (ajout seul), prospect_tasks, opportunities (une par prospect).
--  Règles de conversion :
--    - aucune donnée perdue : devis, activités, tâches et consentements restent liés au prospect ;
--    - aucun doublon : une seule opportunité par prospect (contrainte) ; une relance renvoie les mêmes identifiants ;
--    - un client au même e-mail ou nom existe : refus (LEAD_DUPLICATE_CANDIDATE) tant qu'il n'est pas choisi explicitement (p_client).
--  Limites : devise de l'opportunité absente (la valeur est celle du prospect) ; pas d'écran de tâches séparé ;
--  les devis ne sont pas filtrés par commercial (hors périmètre de ce lot).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission de lecture élargie
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('prospects.read_all', 'clients', 'Voir tous les prospects', 'Lire les prospects de tous les commerciaux (sinon : ses propres prospects)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code = 'prospects.read_all')
  or (r.code = 'direction' and p.code = 'prospects.read_all'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Colonnes des prospects (additives) : segment, qualification, conversion
-- ---------------------------------------------------------------------
alter table public.prospects
  add column segment                    text check (segment is null or length(btrim(segment)) between 2 and 60),
  add column budget_confirmed           boolean,
  add column need_confirmed             boolean,
  add column decision_maker_confirmed   boolean,
  add column timeline                   text check (timeline is null or length(btrim(timeline)) between 2 and 120),
  add column qualified_at               timestamptz,
  add column qualified_by               uuid,
  add column converted_opportunity_id   uuid,
  add column converted_at               timestamptz,
  add column converted_by               uuid;

-- Historique devis : un devis porte client OU prospect (contrainte quotes_one_party, 0012).
-- À la conversion, le prospect d'origine est gardé ici (écrit par la seule conversion).
alter table public.quotes add column origin_prospect_id uuid references public.prospects(id);
create index quotes_origin_prospect_idx on public.quotes (origin_prospect_id);

-- Saisie directe : segment seulement (le reste passe par les fonctions)
grant insert (segment) on public.prospects to authenticated;
grant update (segment) on public.prospects to authenticated;

-- ---------------------------------------------------------------------
-- 3. Visibilité : fonction unique réutilisée par les politiques et les fonctions
-- ---------------------------------------------------------------------
create function private.prospect_visible(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_perm('prospects.read_all') or p_owner is not distinct from auth.uid() and p_owner is not null
$$;
revoke execute on function private.prospect_visible(uuid) from public, anon;
grant execute on function private.prospect_visible(uuid) to authenticated;

-- Remplace les politiques générées de 0012 par le périmètre commercial
drop policy if exists prospects_select on public.prospects;
drop policy if exists prospects_insert on public.prospects;
drop policy if exists prospects_update on public.prospects;

create policy prospects_select on public.prospects for select to authenticated
  using (company_id = private.current_company() and private.has_perm('prospects.read') and private.prospect_visible(owner_id));
create policy prospects_insert on public.prospects for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('prospects.write')
              and (private.has_perm('prospects.read_all') or owner_id = auth.uid()));
create policy prospects_update on public.prospects for update to authenticated
  using (company_id = private.current_company() and private.has_perm('prospects.write') and private.prospect_visible(owner_id))
  with check (company_id = private.current_company() and private.has_perm('prospects.write')
              and (private.has_perm('prospects.read_all') or owner_id = auth.uid()));

-- Activités : visibles seulement si le prospect l'est (RLS du prospect appliqué par la sous-requête)
drop policy if exists prospect_activities_select on public.prospect_activities;
create policy prospect_activities_select on public.prospect_activities for select to authenticated
  using (company_id = private.current_company() and private.has_perm('prospects.read')
         and exists (select 1 from public.prospects p where p.id = prospect_activities.prospect_id));

-- ---------------------------------------------------------------------
-- 4. Étape : visibilité et qualification exigée pour « qualifié »
-- ---------------------------------------------------------------------
create or replace function public.prospect_set_stage(p_prospect uuid, p_stage text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  perform private.require_perm('prospects.write');
  if p_stage not in ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost') then raise exception 'PROSPECT_BAD_STAGE' using errcode = '22023'; end if;
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p_stage = 'won' then raise exception 'PROSPECT_USE_CONVERT' using errcode = '22023'; end if;            -- « gagné » = conversion
  if p_stage = 'qualified' and not coalesce(p.budget_confirmed and p.need_confirmed and p.decision_maker_confirmed, false) then
    raise exception 'PROSPECT_NOT_QUALIFIED' using errcode = '55000';
  end if;
  if p_stage = 'lost' and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PROSPECT_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_stage = p.stage then return; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.prospects set stage = p_stage, stage_changed_at = now(), lost_reason = case when p_stage = 'lost' then btrim(p_reason) end where id = p_prospect;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.stage', 'prospect', p.id::text, p.code, jsonb_build_object('stage', p.stage), jsonb_build_object('stage', p_stage),
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 5. Affectation d'un responsable (commercial avec prospects.write, dans son périmètre)
-- ---------------------------------------------------------------------
create function public.prospect_assign(p_prospect uuid, p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  perform private.require_perm('prospects.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p_owner is null or p_owner not in (select h from private.permission_holders(p.company_id, 'prospects.write') h) then
    raise exception 'PROSPECT_OWNER_INVALID' using errcode = '22023';
  end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.prospects set owner_id = p_owner, updated_at = now() where id = p.id;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.assign', 'prospect', p.id::text, p.code,
    jsonb_build_object('owner_id', p.owner_id), jsonb_build_object('owner_id', p_owner), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.prospect_assign(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Qualification : confirmations (sans changer l'étape)
-- ---------------------------------------------------------------------
create function public.prospect_qualify(p_prospect uuid, p_budget boolean, p_need boolean, p_decision_maker boolean, p_timeline text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype;
begin
  perform private.require_perm('prospects.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p_budget is null or p_need is null or p_decision_maker is null then raise exception 'PROSPECT_QUALIFY_INCOMPLETE' using errcode = '22023'; end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.prospects set budget_confirmed = p_budget, need_confirmed = p_need, decision_maker_confirmed = p_decision_maker,
         timeline = nullif(btrim(coalesce(p_timeline, '')), ''), qualified_at = now(), qualified_by = auth.uid(), updated_at = now()
   where id = p.id;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(p.company_id, 'prospect.qualify', 'prospect', p.id::text, p.code, null,
    jsonb_build_object('budget', p_budget, 'need', p_need, 'decision_maker', p_decision_maker, 'timeline', nullif(btrim(coalesce(p_timeline, '')), '')), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.prospect_qualify(uuid, boolean, boolean, boolean, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Consentements : journal ajout seul, dernier statut par finalité
-- ---------------------------------------------------------------------
create table public.prospect_consents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  prospect_id  uuid not null references public.prospects(id),
  purpose      text not null check (purpose in ('commercial_prospection', 'phone_contact', 'email_marketing')),
  status       text not null check (status in ('granted', 'withdrawn')),
  proof        text not null check (length(btrim(proof)) between 5 and 300),
  recorded_by  uuid not null default auth.uid(),
  recorded_at  timestamptz not null default now()
);
create index prospect_consents_idx on public.prospect_consents (prospect_id, purpose, recorded_at desc);

create function private.append_only_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY' using errcode = '42501', detail = tg_table_name;
end $$;
create trigger prospect_consents_no_change before update or delete on public.prospect_consents
  for each row execute function private.append_only_guard();

create function public.prospect_consent_record(p_prospect uuid, p_purpose text, p_status text, p_proof text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype; v_id uuid;
begin
  perform private.require_perm('prospects.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company();
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_proof, ''))) < 5 then raise exception 'CONSENT_PROOF_REQUIRED' using errcode = '22023'; end if;
  insert into public.prospect_consents (company_id, prospect_id, purpose, status, proof)
  values (p.company_id, p.id, p_purpose, p_status, btrim(p_proof))
  returning id into v_id;
  perform private.write_audit(p.company_id, 'prospect.consent', 'prospect', p.id::text, p.code, null,
    jsonb_build_object('purpose', p_purpose, 'status', p_status), jsonb_build_object('proof', btrim(p_proof)), 'rpc');
  return v_id;
end $$;
grant execute on function public.prospect_consent_record(uuid, text, text, text) to authenticated, service_role;

create function public.prospect_consent_status(p_prospect uuid, p_purpose text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare p public.prospects%rowtype; v_status text;
begin
  perform private.require_perm('prospects.read');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company();
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  select c.status into v_status from public.prospect_consents c
   where c.prospect_id = p.id and c.purpose = p_purpose order by c.recorded_at desc, c.id desc limit 1;
  return coalesce(v_status, 'unknown');
end $$;
grant execute on function public.prospect_consent_status(uuid, text) to authenticated, service_role;

alter table public.prospect_consents enable row level security;
create policy prospect_consents_select on public.prospect_consents for select to authenticated
  using (company_id = private.current_company() and private.has_perm('prospects.read')
         and exists (select 1 from public.prospects p where p.id = prospect_consents.prospect_id));
revoke all on public.prospect_consents from anon, authenticated;
grant select on public.prospect_consents to authenticated;
grant all on public.prospect_consents to service_role;

-- ---------------------------------------------------------------------
-- 8. Tâches liées au prospect
-- ---------------------------------------------------------------------
create table public.prospect_tasks (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  prospect_id  uuid not null references public.prospects(id),
  title        text not null check (length(btrim(title)) between 3 and 200),
  due_on       date not null,
  owner_id     uuid not null references public.profiles(id),
  status       text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  done_by      uuid,
  check ((status = 'done') = (done_at is not null))
);
create index prospect_tasks_idx on public.prospect_tasks (prospect_id, status, due_on);

create function public.prospect_task_create(p_prospect uuid, p_title text, p_due date, p_owner uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.prospects%rowtype; v_owner uuid := coalesce(p_owner, null); v_id uuid;
begin
  perform private.require_perm('prospects.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company();
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;
  if p_due is null then raise exception 'TASK_DUE_REQUIRED' using errcode = '22023'; end if;
  v_owner := coalesce(v_owner, p.owner_id);
  -- le responsable d'une tâche doit pouvoir travailler le prospect (détenir prospects.write)
  if v_owner is null or v_owner not in (select h from private.permission_holders(p.company_id, 'prospects.write') h) then
    raise exception 'PROSPECT_OWNER_INVALID' using errcode = '22023';
  end if;
  insert into public.prospect_tasks (company_id, prospect_id, title, due_on, owner_id)
  values (p.company_id, p.id, btrim(p_title), p_due, v_owner) returning id into v_id;
  perform private.write_audit(p.company_id, 'prospect.task_create', 'prospect', p.id::text, p.code, null,
    jsonb_build_object('task', v_id, 'due_on', p_due, 'owner_id', v_owner), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.prospect_task_create(uuid, text, date, uuid) to authenticated, service_role;

create function public.prospect_task_complete(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.prospect_tasks%rowtype; p public.prospects%rowtype;
begin
  perform private.require_perm('prospects.write');
  select * into t from public.prospect_tasks where id = p_task and company_id = private.current_company() for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from public.prospects where id = t.prospect_id;
  if not private.prospect_visible(p.owner_id) and t.owner_id is distinct from auth.uid() then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;
  if t.status <> 'open' then raise exception 'TASK_BAD_STATUS' using errcode = '55000'; end if;
  update public.prospect_tasks set status = 'done', done_at = now(), done_by = auth.uid() where id = t.id;
  perform private.write_audit(t.company_id, 'prospect.task_done', 'prospect', p.id::text, p.code, null,
    jsonb_build_object('task', t.id), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.prospect_task_complete(uuid) to authenticated, service_role;

alter table public.prospect_tasks enable row level security;
create policy prospect_tasks_select on public.prospect_tasks for select to authenticated
  using (company_id = private.current_company() and private.has_perm('prospects.read')
         and exists (select 1 from public.prospects p where p.id = prospect_tasks.prospect_id
                     and (private.prospect_visible(p.owner_id) or prospect_tasks.owner_id = auth.uid())));
revoke all on public.prospect_tasks from anon, authenticated;
grant select on public.prospect_tasks to authenticated;
grant all on public.prospect_tasks to service_role;

-- ---------------------------------------------------------------------
-- 9. Doublons : candidats visibles, jamais de fusion automatique
-- ---------------------------------------------------------------------
create function public.prospect_duplicates(p_prospect uuid) returns table (cand_kind text, cand_id uuid, cand_label text, cand_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare p public.prospects%rowtype; v_co uuid := private.current_company();
begin
  perform private.require_perm('prospects.read');
  select * into p from public.prospects where id = p_prospect and company_id = v_co;
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;
  return query
    select 'client'::text, c.id, c.name::text,
           case when p.email is not null and lower(c.email) = lower(p.email) then 'e-mail identique' else 'nom identique' end
      from public.clients c
     where c.company_id = v_co and c.archived_at is null and private.has_perm('clients.read')
       and ((p.email is not null and lower(c.email) = lower(p.email)) or lower(btrim(c.name)) = lower(btrim(p.company_name)))
    union all
    select 'prospect'::text, o.id, o.company_name::text,
           case when p.email is not null and lower(o.email) = lower(p.email) then 'e-mail identique' else 'nom identique' end
      from public.prospects o
     where o.company_id = v_co and o.id <> p.id and private.prospect_visible(o.owner_id)
       and ((p.email is not null and lower(o.email) = lower(p.email)) or lower(btrim(o.company_name)) = lower(btrim(p.company_name)));
end $$;
grant execute on function public.prospect_duplicates(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10. Opportunité : une par prospect, créée à la conversion
-- ---------------------------------------------------------------------
create table public.opportunities (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text not null,
  client_id      uuid not null references public.clients(id),
  prospect_id    uuid not null references public.prospects(id),
  name           text not null check (length(btrim(name)) between 2 and 120),
  value          numeric(15,2) not null default 0 check (value >= 0),
  stage          text not null default 'open' check (stage in ('open', 'won', 'lost')),
  owner_id       uuid references public.profiles(id),
  expected_close date,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, prospect_id)
);

create function private.opportunities_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.company_id := coalesce(new.company_id, private.current_company());
  new.code := 'OPP-' || lpad(private.next_seq(new.company_id, 'opportunity')::text, 4, '0');
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end $$;
create trigger opportunities_fill_bi before insert on public.opportunities
  for each row execute function private.opportunities_fill();

alter table public.opportunities enable row level security;
create policy opportunities_select on public.opportunities for select to authenticated
  using (company_id = private.current_company() and private.has_perm('prospects.read') and private.prospect_visible(owner_id));
revoke all on public.opportunities from anon, authenticated;
grant select on public.opportunities to authenticated;
grant all on public.opportunities to service_role;

-- ---------------------------------------------------------------------
-- 11. Conversion sans perte ni doublon
-- ---------------------------------------------------------------------
create function public.lead_convert(p_prospect uuid, p_client uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.prospects%rowtype; v_client uuid; v_code text; v_opp uuid; v_quotes int; v_dups int;
begin
  perform private.require_perm('prospects.write');
  perform private.require_perm('clients.write');
  select * into p from public.prospects where id = p_prospect and company_id = private.current_company() for update;
  if not found or not private.prospect_visible(p.owner_id) then raise exception 'PROSPECT_NOT_FOUND' using errcode = 'P0002'; end if;

  -- Relance : même résultat, aucune ligne nouvelle
  if p.converted_client_id is not null then
    return jsonb_build_object('client_id', p.converted_client_id, 'opportunity_id', p.converted_opportunity_id, 'already_converted', true);
  end if;
  if p.stage in ('won', 'lost') then raise exception 'PROSPECT_CLOSED' using errcode = '55000'; end if;

  if p_client is null then
    if p.country is null then raise exception 'PROSPECT_COUNTRY_REQUIRED' using errcode = '22023'; end if;   -- champ obligatoire de la fiche client
    select count(*) into v_dups from public.clients c
     where c.company_id = p.company_id and c.archived_at is null
       and ((p.email is not null and lower(c.email) = lower(p.email)) or lower(btrim(c.name)) = lower(btrim(p.company_name)));
    if v_dups > 0 then raise exception 'LEAD_DUPLICATE_CANDIDATE' using errcode = '22023', detail = v_dups::text; end if;
    v_client := gen_random_uuid();
    insert into public.clients (id, company_id, name, email, phone, country, sales_rep_id, notes)
    values (v_client, p.company_id, p.company_name, p.email, p.phone, p.country, p.owner_id, 'Converti depuis le prospect ' || p.code || coalesce(E'\n' || p.notes, ''));
  else
    if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = p.company_id and c.archived_at is null) then
      raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
    end if;
    v_client := p_client;
  end if;
  select code into v_code from public.clients where id = v_client;

  insert into public.opportunities (company_id, client_id, prospect_id, name, value, stage, owner_id, expected_close)
  values (p.company_id, v_client, p.id, p.company_name, p.est_value, 'open', p.owner_id, p.expected_close)
  returning id into v_opp;

  -- Les devis passent au client ; le prospect d'origine est gardé dans origin_prospect_id (une seule colonne porte un tiers, contrainte quotes_one_party)
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set client_id = v_client, origin_prospect_id = p.id, prospect_id = null
   where prospect_id = p.id and company_id = p.company_id and client_id is null;
  get diagnostics v_quotes = row_count;
  update public.prospects set stage = 'won', stage_changed_at = now(), converted_client_id = v_client,
         converted_opportunity_id = v_opp, converted_at = now(), converted_by = auth.uid() where id = p.id;
  perform set_config('commercial.rpc', 'off', true);

  perform private.write_audit(p.company_id, 'lead.convert', 'prospect', p.id::text, p.code, jsonb_build_object('stage', p.stage),
    jsonb_build_object('client_id', v_client, 'client_code', v_code, 'opportunity_id', v_opp, 'quotes_linked', v_quotes), '{}'::jsonb, 'rpc');
  return jsonb_build_object('client_id', v_client, 'opportunity_id', v_opp, 'already_converted', false, 'quotes_linked', v_quotes);
end $$;
grant execute on function public.lead_convert(uuid, uuid) to authenticated, service_role;

-- Conversion historique (même signature) : passe par lead_convert, donc refuse les doublons et ne supprime aucun lien
create or replace function public.prospect_convert(p_prospect uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  -- Comportement historique conservé : un prospect déjà converti n'est pas reconverti (la relance idempotente est dans lead_convert)
  if exists (select 1 from public.prospects where id = p_prospect and converted_client_id is not null) then
    raise exception 'PROSPECT_CLOSED' using errcode = '55000';
  end if;
  return (public.lead_convert(p_prospect, null) ->> 'client_id')::uuid;
end $$;
