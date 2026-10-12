-- =====================================================================
-- 0038_parties — Tiers commun (clients et fournisseurs), dédoublonnage assisté et fusion traçable (P015)
--  Socle conservé : clients (0004) et fournisseurs (0006) restent des fiches PAR SOCIÉTÉ avec leurs conditions locales
--  (conditions de paiement, plafond, devise, incoterm, TVA, statut d'archive, contacts, documents). Rien n'est déplacé.
--  Ajouts :
--    parties            : identité partagée d'un tiers (raison sociale, identifiant fiscal, pays). Pas de conditions locales.
--    clients.party_id, suppliers.party_id : rattachement de chaque fiche à son tiers (chaque fiche existante reçoit le sien,
--                         sans aucune fusion automatique).
--    party_merge_proposals : proposition de fusion de deux tiers (force « strong » si l'identifiant fiscal coïncide,
--                         « ambiguous » sinon) ; seul un steward (tiers.steward), distinct de l'auteur, peut la décider.
--    party_merge_log    : journal de fusion, en ajout seul : valeurs choisies, états avant et après, décideur.
--  Règles :
--    - une fusion ne change que party_id des fiches et marque le tiers source « merged » (merged_into) : anciens identifiants
--      de tiers et de fiches restent valides, documents inchangés ;
--    - refus si une fiche est archivée ou si un tiers est lié à une autre société (fusion inter-sociétés non traitée ici) ;
--    - pas d'auto-approbation (SOD_SELF_APPROVAL).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission steward
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('tiers.steward', 'clients', 'Steward des tiers', 'Décider les fusions de tiers et corriger l’identité partagée (autre que l’auteur de la proposition)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'tiers.steward'
  and r.code in ('admin', 'direction')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tiers commun
-- ---------------------------------------------------------------------
create table public.parties (
  id            uuid primary key default gen_random_uuid(),
  legal_name    text not null check (length(btrim(legal_name)) between 2 and 160),
  tax_id        text check (tax_id is null or length(btrim(tax_id)) between 2 and 60),
  tax_key       text,                       -- identifiant fiscal normalisé (dédoublonnage)
  name_key      text not null,              -- raison sociale normalisée (dédoublonnage)
  country       char(2) not null check (country ~ '^[A-Z]{2}$'),
  status        text not null default 'active' check (status in ('active', 'merged')),
  merged_into   uuid references public.parties(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null)),
  check (merged_into is distinct from id)
);
create index parties_tax_key_idx on public.parties (tax_key) where tax_key is not null;
create index parties_name_key_idx on public.parties (name_key, country);

create function private.parties_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.legal_name := btrim(new.legal_name);
  new.tax_key := nullif(upper(regexp_replace(coalesce(new.tax_id, ''), '[^A-Za-z0-9]', '', 'g')), '');
  new.name_key := lower(regexp_replace(new.legal_name, '[^[:alnum:]]', '', 'g'));
  new.updated_at := now();
  return new;
end $$;
create trigger parties_before_iu before insert or update on public.parties
  for each row execute function private.parties_before();

-- Visible si une fiche de la société active (avec le droit de lecture correspondant) y est rattachée
create function private.party_visible(p uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (select 1 from public.clients c where c.party_id = p and c.company_id = private.current_company() and private.has_perm('clients.read'))
      or exists (select 1 from public.suppliers s where s.party_id = p and s.company_id = private.current_company() and private.has_perm('suppliers.read'));
end $$;

alter table public.parties enable row level security;
create policy parties_select on public.parties for select to authenticated using (private.party_visible(id));
revoke all on public.parties from anon, authenticated;
grant select on public.parties to authenticated;
grant all on public.parties to service_role;

-- ---------------------------------------------------------------------
-- 3. Rattachement des fiches existantes (un tiers par fiche, sans fusion) et pour les fiches futures
-- ---------------------------------------------------------------------
alter table public.clients add column party_id uuid not null default gen_random_uuid();
alter table public.suppliers add column party_id uuid not null default gen_random_uuid();

insert into public.parties (id, legal_name, tax_id, country)
select c.party_id, coalesce(nullif(btrim(c.legal_name), ''), c.name), c.tax_id, c.country from public.clients c;
insert into public.parties (id, legal_name, tax_id, country)
select s.party_id, coalesce(nullif(btrim(s.legal_name), ''), s.name), s.tax_id, s.country from public.suppliers s;

alter table public.clients add constraint clients_party_fk foreign key (party_id) references public.parties(id) deferrable initially deferred;
alter table public.suppliers add constraint suppliers_party_fk foreign key (party_id) references public.parties(id) deferrable initially deferred;
create index clients_party_idx on public.clients (party_id);
create index suppliers_party_idx on public.suppliers (party_id);

create function private.party_for_client() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.parties (id, legal_name, tax_id, country)
  values (new.party_id, coalesce(nullif(btrim(new.legal_name), ''), new.name), new.tax_id, new.country)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger clients_party_ai after insert on public.clients for each row execute function private.party_for_client();

create function private.party_for_supplier() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.parties (id, legal_name, tax_id, country)
  values (new.party_id, coalesce(nullif(btrim(new.legal_name), ''), new.name), new.tax_id, new.country)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger suppliers_party_ai after insert on public.suppliers for each row execute function private.party_for_supplier();

-- ---------------------------------------------------------------------
-- 4. Propositions de fusion et journal
-- ---------------------------------------------------------------------
create table public.party_merge_proposals (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  source_party     uuid not null references public.parties(id),
  target_party     uuid not null references public.parties(id),
  match_kind       text not null check (match_kind in ('strong', 'ambiguous')),
  status           text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  reason           text not null check (length(btrim(reason)) between 5 and 300),
  proposed_by      uuid not null default auth.uid() references public.profiles(id),
  proposed_at      timestamptz not null default now(),
  decided_by       uuid references public.profiles(id),
  decided_at       timestamptz,
  decision_comment text check (decision_comment is null or length(decision_comment) <= 300),
  field_choices    jsonb not null default '{}'::jsonb check (jsonb_typeof(field_choices) = 'object'),
  check (source_party <> target_party),
  check (decided_by is distinct from proposed_by),                  -- séparation des tâches, en base
  check ((status = 'pending' and decided_by is null) or (status <> 'pending' and decided_by is not null and decided_at is not null))
);
create index party_merge_proposals_status_idx on public.party_merge_proposals (company_id, status);
alter table public.party_merge_proposals enable row level security;
create policy party_merge_proposals_select on public.party_merge_proposals for select to authenticated
  using (company_id = private.current_company() and (proposed_by = auth.uid() or private.has_perm('tiers.steward')));
revoke all on public.party_merge_proposals from anon, authenticated;
grant select on public.party_merge_proposals to authenticated;
grant all on public.party_merge_proposals to service_role;

create table public.party_merge_log (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references public.companies(id),
  proposal_id   uuid not null references public.party_merge_proposals(id),
  source_party  uuid not null references public.parties(id),
  target_party  uuid not null references public.parties(id),
  choices       jsonb not null,
  before_data   jsonb not null,
  after_data    jsonb not null,
  decided_by    uuid not null references public.profiles(id),
  decided_at    timestamptz not null default now(),
  moved_clients int not null,
  moved_suppliers int not null
);
create function private.party_merge_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'PARTY_MERGE_LOG_IMMUTABLE' using errcode = '42501'; end $$;
create trigger party_merge_log_no_change before update or delete on public.party_merge_log
  for each row execute function private.party_merge_log_immutable();
alter table public.party_merge_log enable row level security;
create policy party_merge_log_select on public.party_merge_log for select to authenticated
  using (company_id = private.current_company() and private.has_perm('tiers.steward'));
revoke all on public.party_merge_log from anon, authenticated;
grant select on public.party_merge_log to authenticated;
grant all on public.party_merge_log to service_role;

-- ---------------------------------------------------------------------
-- 5. Garde-fous de fusion (utilisés à la proposition et à la décision)
-- ---------------------------------------------------------------------
create function private.party_merge_guard(p_source uuid, p_target uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  if p_source = p_target then raise exception 'PARTY_SAME' using errcode = '22023'; end if;
  if exists (select 1 from public.parties where id in (p_source, p_target) and status <> 'active') then
    raise exception 'PARTY_NOT_ACTIVE' using errcode = '55000';
  end if;
  if not (private.party_visible(p_source) and private.party_visible(p_target)) then raise exception 'PARTY_NOT_FOUND' using errcode = 'P0002'; end if;
  -- fusion intra-société seulement : aucune fiche d'une autre société ne doit pointer vers ces tiers
  if exists (select 1 from public.clients where party_id in (p_source, p_target) and company_id <> v_co)
     or exists (select 1 from public.suppliers where party_id in (p_source, p_target) and company_id <> v_co) then
    raise exception 'MERGE_CROSS_COMPANY' using errcode = '42501';
  end if;
  if exists (select 1 from public.clients where party_id in (p_source, p_target) and archived_at is not null)
     or exists (select 1 from public.suppliers where party_id in (p_source, p_target) and archived_at is not null) then
    raise exception 'MERGE_ARCHIVED_ROW' using errcode = '55000';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Dédoublonnage assisté : paires de tiers visibles qui se ressemblent
-- ---------------------------------------------------------------------
create function public.party_duplicate_candidates()
returns table (party_a uuid, party_b uuid, match_kind text, legal_name_a text, legal_name_b text, country char(2))
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.has_perm('clients.read') or private.has_perm('suppliers.read')) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  return query
    select a.id, b.id,
      (case when a.tax_key is not null and a.tax_key = b.tax_key then 'strong' else 'ambiguous' end)::text,
      a.legal_name::text, b.legal_name::text, a.country
    from public.parties a join public.parties b on a.id < b.id
    where a.status = 'active' and b.status = 'active' and a.country = b.country
      and ((a.tax_key is not null and a.tax_key = b.tax_key) or a.name_key = b.name_key)
      and private.party_visible(a.id) and private.party_visible(b.id)
    order by a.legal_name limit 100;
end $$;
grant execute on function public.party_duplicate_candidates() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Proposer une fusion (sans l'appliquer)
-- ---------------------------------------------------------------------
create function public.party_propose_merge(p_source uuid, p_target uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_kind text; v_co uuid := private.current_company(); s public.parties%rowtype; t public.parties%rowtype;
begin
  if not (private.has_perm('clients.read') or private.has_perm('suppliers.read')) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'PARTY_REASON_REQUIRED' using errcode = '22023'; end if;
  perform private.party_merge_guard(p_source, p_target);
  select * into s from public.parties where id = p_source;
  select * into t from public.parties where id = p_target;
  v_kind := case when s.tax_key is not null and s.tax_key = t.tax_key then 'strong' else 'ambiguous' end;
  insert into public.party_merge_proposals (id, company_id, source_party, target_party, match_kind, reason)
  values (v_id, v_co, p_source, p_target, v_kind, btrim(p_reason));
  perform private.write_audit(v_co, 'party.merge_propose', 'party', p_source::text, s.legal_name || ' → ' || t.legal_name, null,
    jsonb_build_object('target', p_target, 'match_kind', v_kind), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
  return v_id;
end $$;
grant execute on function public.party_propose_merge(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Décision du steward : application de la fusion avec choix champ par champ, ou refus
-- ---------------------------------------------------------------------
create function public.party_decide_merge(p_proposal uuid, p_approve boolean, p_choices jsonb default '{}'::jsonb, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.party_merge_proposals%rowtype; s public.parties%rowtype; t public.parties%rowtype;
  v_before jsonb; v_after jsonb; v_choice text; v_key text; v_moved_c int; v_moved_s int; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  perform private.require_perm('tiers.steward');
  select * into p from public.party_merge_proposals where id = p_proposal and company_id = private.current_company() for update;
  if not found then raise exception 'PARTY_PROPOSAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status <> 'pending' then raise exception 'PARTY_PROPOSAL_BAD_STATUS' using errcode = '55000'; end if;
  if p.proposed_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'party_merge'; end if;
  if not p_approve then
    if length(coalesce(v_comment, '')) < 3 then raise exception 'PARTY_COMMENT_REQUIRED' using errcode = '22023'; end if;
    update public.party_merge_proposals set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_comment = v_comment where id = p.id;
    perform private.write_audit(p.company_id, 'party.merge_reject', 'party', p.source_party::text, 'Fusion refusée', null, null,
      jsonb_build_object('comment', v_comment), 'rpc');
    return jsonb_build_object('status', 'rejected');
  end if;

  perform private.party_merge_guard(p.source_party, p.target_party);
  select * into s from public.parties where id = p.source_party for update;
  select * into t from public.parties where id = p.target_party for update;
  -- choix par champ : « source » ou « target » (défaut : target). Aucune autre clé acceptée.
  if exists (select 1 from jsonb_object_keys(coalesce(p_choices, '{}'::jsonb)) k where k not in ('legal_name', 'tax_id', 'country')) then
    raise exception 'PARTY_BAD_CHOICE' using errcode = '22023';
  end if;
  v_before := jsonb_build_object('source', jsonb_build_object('legal_name', s.legal_name, 'tax_id', s.tax_id, 'country', s.country),
                                 'target', jsonb_build_object('legal_name', t.legal_name, 'tax_id', t.tax_id, 'country', t.country));
  -- identité du tiers cible : champs choisis dans la source quand demandé
  foreach v_key in array array['legal_name', 'tax_id', 'country'] loop
    v_choice := coalesce(p_choices ->> v_key, 'target');
    if v_choice not in ('source', 'target') then raise exception 'PARTY_BAD_CHOICE' using errcode = '22023'; end if;
    if v_choice = 'source' then
      if v_key = 'legal_name' then update public.parties set legal_name = s.legal_name where id = t.id;
      elsif v_key = 'tax_id' then update public.parties set tax_id = s.tax_id where id = t.id;
      elsif s.country <> t.country then raise exception 'PARTY_COUNTRY_CONFLICT' using errcode = '22023';
      end if;
    end if;
  end loop;
  -- rattachement des fiches : seul party_id change ; les identifiants et documents restent
  update public.clients set party_id = t.id where party_id = s.id;
  get diagnostics v_moved_c = row_count;
  update public.suppliers set party_id = t.id where party_id = s.id;
  get diagnostics v_moved_s = row_count;
  update public.parties set status = 'merged', merged_into = t.id where id = s.id;
  select * into t from public.parties where id = t.id;
  v_after := jsonb_build_object('source', jsonb_build_object('status', 'merged', 'merged_into', t.id),
                                'target', jsonb_build_object('legal_name', t.legal_name, 'tax_id', t.tax_id, 'country', t.country));
  insert into public.party_merge_log (company_id, proposal_id, source_party, target_party, choices, before_data, after_data, decided_by, moved_clients, moved_suppliers)
  values (p.company_id, p.id, s.id, t.id, coalesce(p_choices, '{}'::jsonb), v_before, v_after, auth.uid(), v_moved_c, v_moved_s);
  update public.party_merge_proposals set status = 'applied', decided_by = auth.uid(), decided_at = now(), decision_comment = v_comment,
    field_choices = coalesce(p_choices, '{}'::jsonb) where id = p.id;
  perform private.write_audit(p.company_id, 'party.merge_approve', 'party', s.id::text, s.legal_name || ' → ' || t.legal_name, v_before, v_after,
    jsonb_build_object('moved_clients', v_moved_c, 'moved_suppliers', v_moved_s, 'choices', coalesce(p_choices, '{}'::jsonb), 'comment', v_comment), 'rpc');
  return jsonb_build_object('status', 'applied', 'target', t.id, 'moved_clients', v_moved_c, 'moved_suppliers', v_moved_s);
end $$;
grant execute on function public.party_decide_merge(uuid, boolean, jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 9. Ancien identifiant de tiers : résolution vers le tiers actif
-- ---------------------------------------------------------------------
create function public.party_resolve(p_party uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := p_party; d record; i int := 0;
begin
  loop
    select status, merged_into into d from public.parties where id = v;
    if not found then raise exception 'PARTY_NOT_FOUND' using errcode = 'P0002'; end if;
    exit when d.status = 'active';
    i := i + 1;
    if i > 5 then raise exception 'PARTY_MERGE_CHAIN' using errcode = '55000'; end if;
    v := d.merged_into;
  end loop;
  if not private.party_visible(v) then raise exception 'PARTY_NOT_FOUND' using errcode = 'P0002'; end if;
  return v;
end $$;
grant execute on function public.party_resolve(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10. Identité partagée : correction par le steward, tracée
-- ---------------------------------------------------------------------
create function public.party_update_identity(p_party uuid, p_legal_name text, p_tax_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.parties%rowtype; v_before jsonb; v_co uuid := private.current_company();
begin
  perform private.require_perm('tiers.steward');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'PARTY_REASON_REQUIRED' using errcode = '22023'; end if;
  if not private.party_visible(p_party) then raise exception 'PARTY_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into s from public.parties where id = p_party for update;
  if s.status <> 'active' then raise exception 'PARTY_NOT_ACTIVE' using errcode = '55000'; end if;
  if exists (select 1 from public.clients where party_id = p_party and company_id <> v_co)
     or exists (select 1 from public.suppliers where party_id = p_party and company_id <> v_co) then
    raise exception 'MERGE_CROSS_COMPANY' using errcode = '42501';
  end if;
  v_before := jsonb_build_object('legal_name', s.legal_name, 'tax_id', s.tax_id);
  update public.parties set legal_name = btrim(p_legal_name), tax_id = nullif(btrim(coalesce(p_tax_id, '')), '') where id = p_party;
  perform private.write_audit(v_co, 'party.identity_change', 'party', p_party::text, btrim(p_legal_name), v_before,
    jsonb_build_object('legal_name', btrim(p_legal_name), 'tax_id', nullif(btrim(coalesce(p_tax_id, '')), '')),
    jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
grant execute on function public.party_update_identity(uuid, text, text, text) to authenticated, service_role;

-- Les fusions et corrections d'identité sont des actions significatives du journal (0035)
create or replace function private.audit_is_significant(p_action text) returns boolean
language sql immutable set search_path = '' as $$
  select p_action ~ '(approve|reject|execute|grant|revoke|control|mark_critical|archive|delete|export|payment|role|permission|decide|release|reverse|denied|derogation|delegation|merge|identity)'
$$;
