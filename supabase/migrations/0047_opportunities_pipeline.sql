-- =====================================================================
-- 0047_opportunities_pipeline — Opportunités, étapes paramétrables, pipeline pondéré, commandes, CA (P022)
--  Socle réutilisé : opportunities (0046), prospects et scope (0046), invoices / credit_notes / sales_orders (0010, 0012),
--  currencies / finance_settings / exchange_rates validés (0027, 0040), private.write_audit, private.prospect_visible.
--  Trois chiffres DISTINCTS, jamais mélangés :
--    1. pipeline pondéré : opportunités ouvertes × probabilité de l'étape, en devise de base au taux VALIDÉ du jour ;
--    2. commandes : nombre de commandes confirmées et quantités (les commandes n'ont pas de prix dans le modèle) ;
--    3. CA : factures émises (HT) moins avoirs émis, en devise de base au taux VALIDÉ de la date d'émission.
--  Règles :
--    - aucun montant n'est inventé : probabilité absente, devise absente ou taux absent = l'opportunité est EXCLUE du total
--      et comptée à part (rien n'est supposé) ; la probabilité des étapes ouvertes n'est pas seedée (paramètre à saisir) ;
--    - étapes autorisées : une transition n'existe que si elle est dans pipeline_transitions ; étape fermée = terminale ;
--    - perte : motif obligatoire (3 caractères) ; gain et perte : date enregistrée ;
--    - historique des étapes ajout seul, avec probabilité et montant figés au moment du changement.
--  Limites : pas de lignes de devis reliées aux opportunités (produits saisis à titre indicatif) ; pas de devise sur les
--  opportunités créées avant ce lot (exclues du pondéré jusqu'à saisie) ; CA calculé sur les factures et avoirs seulement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('opportunities.read',  'clients', 'Voir les opportunités',         'Lire les opportunités, le pipeline et sa synthèse (dans le périmètre commercial)'),
  ('opportunities.write', 'clients', 'Gérer les opportunités',        'Créer, modifier, faire avancer, gagner ou perdre une opportunité'),
  ('pipeline.configure',  'clients', 'Paramétrer le pipeline',        'Étapes, probabilités et transitions autorisées')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('opportunities.read', 'opportunities.write', 'pipeline.configure'))
  or (r.code = 'direction'  and p.code = 'opportunities.read')
  or (r.code = 'commercial' and p.code in ('opportunities.read', 'opportunities.write')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Étapes et transitions autorisées (paramétrables par société)
-- ---------------------------------------------------------------------
create table public.pipeline_stages (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id),
  code            text not null check (code ~ '^[a-z_]{2,30}$'),
  label           text not null check (length(btrim(label)) between 2 and 60),
  kind            text not null check (kind in ('open', 'won', 'lost')),
  position        int not null check (position > 0),
  probability_pct numeric(5,2) check (probability_pct is null or probability_pct between 0 and 100),
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, position),
  unique (company_id, id),
  -- gagné = 100 %, perdu = 0 % (définitions, pas des hypothèses) ; ouverte = à saisir par la société
  check (kind <> 'won' or probability_pct = 100),
  check (kind <> 'lost' or probability_pct = 0)
);

create table public.pipeline_transitions (
  company_id uuid not null references public.companies(id),
  from_code  text not null,
  to_code    text not null,
  primary key (company_id, from_code, to_code),
  check (from_code <> to_code),
  foreign key (company_id, from_code) references public.pipeline_stages(company_id, code),
  foreign key (company_id, to_code) references public.pipeline_stages(company_id, code)
);

-- Graine : structure de base (libellés et ordre). Les probabilités des étapes ouvertes restent vides.
create function private.seed_pipeline(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pipeline_stages (company_id, code, label, kind, position, probability_pct) values
    (p_company, 'qualification', 'Qualification', 'open', 1, null),
    (p_company, 'proposition',   'Proposition',   'open', 2, null),
    (p_company, 'negociation',   'Négociation',   'open', 3, null),
    (p_company, 'gagnee',        'Gagnée',        'won',  4, 100),
    (p_company, 'perdue',        'Perdue',        'lost', 5, 0)
  on conflict do nothing;
  -- transitions : entre étapes ouvertes dans les deux sens, et de chaque étape ouverte vers gagnée ou perdue
  insert into public.pipeline_transitions (company_id, from_code, to_code)
  select a.company_id, a.code, b.code from public.pipeline_stages a join public.pipeline_stages b
     on b.company_id = a.company_id and a.kind = 'open' and b.kind = 'open' and a.code <> b.code
   where a.company_id = p_company
  on conflict do nothing;
  insert into public.pipeline_transitions (company_id, from_code, to_code)
  select a.company_id, a.code, b.code from public.pipeline_stages a join public.pipeline_stages b
     on b.company_id = a.company_id and a.kind = 'open' and b.kind in ('won', 'lost')
   where a.company_id = p_company
  on conflict do nothing;
end $$;
revoke execute on function private.seed_pipeline(uuid) from public, anon, authenticated;

-- Sociétés existantes et futures
do $$ declare c record; begin
  for c in select id from public.companies loop perform private.seed_pipeline(c.id); end loop;
end $$;
create function private.companies_seed_pipeline() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform private.seed_pipeline(new.id); return new; end $$;
create trigger companies_seed_pipeline_ai after insert on public.companies
  for each row execute function private.companies_seed_pipeline();

-- ---------------------------------------------------------------------
-- 3. Opportunités : colonnes additives
-- ---------------------------------------------------------------------
alter table public.opportunities alter column prospect_id drop not null;   -- opportunité créée directement (sans prospect)
alter table public.opportunities
  add column stage_id        uuid,
  add column currency        char(3) check (currency is null or currency ~ '^[A-Z]{3}$') references public.currencies(code),
  add column probability_pct numeric(5,2) check (probability_pct is null or probability_pct between 0 and 100),
  add column next_action     text check (next_action is null or length(btrim(next_action)) between 2 and 200),
  add column next_action_date date,
  add column won_at          timestamptz,
  add column lost_at         timestamptz,
  add column lost_reason     text check (lost_reason is null or length(btrim(lost_reason)) between 3 and 300),
  add column closed_by       uuid,
  add column updated_at      timestamptz not null default now(),
  add constraint opportunities_stage_fk foreign key (company_id, stage_id) references public.pipeline_stages(company_id, id),
  add constraint opportunities_won_ck check (stage <> 'won' or won_at is not null),
  add constraint opportunities_lost_ck check (stage <> 'lost' or (lost_at is not null and lost_reason is not null));

-- Produits (indicatifs) et concurrents
create table public.opportunity_products (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  product_id     uuid references public.product_master(id),
  label          text not null check (length(btrim(label)) between 2 and 120),
  quantity       numeric(12,2) not null check (quantity > 0),
  unit_amount    numeric(15,2) check (unit_amount is null or unit_amount >= 0),
  created_at     timestamptz not null default now()
);
create index opportunity_products_idx on public.opportunity_products (opportunity_id);

create table public.opportunity_competitors (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  name           text not null check (length(btrim(name)) between 2 and 120),
  note           text check (note is null or length(note) <= 300),
  created_at     timestamptz not null default now(),
  unique (opportunity_id, name)
);

-- Historique des étapes : ajout seul, valeurs figées au moment du changement
create table public.opportunity_stage_history (
  id             bigint generated always as identity primary key,
  company_id     uuid not null references public.companies(id),
  opportunity_id uuid not null references public.opportunities(id),
  from_stage     text,
  to_stage       text not null,
  probability_pct numeric(5,2),
  amount         numeric(15,2),
  currency       char(3),
  reason         text,
  changed_by     uuid,
  changed_at     timestamptz not null default now()
);
create index opportunity_stage_history_idx on public.opportunity_stage_history (opportunity_id, id);

create trigger opportunity_stage_history_no_change before update or delete on public.opportunity_stage_history
  for each row execute function private.append_only_guard();

-- ---------------------------------------------------------------------
-- 4. Visibilité et droits (même périmètre que les prospects)
-- ---------------------------------------------------------------------
drop policy if exists opportunities_select on public.opportunities;
create policy opportunities_select on public.opportunities for select to authenticated
  using (company_id = private.current_company() and private.has_perm('opportunities.read') and private.prospect_visible(owner_id));

alter table public.opportunity_products enable row level security;
create policy opportunity_products_select on public.opportunity_products for select to authenticated
  using (company_id = private.current_company() and private.has_perm('opportunities.read')
         and exists (select 1 from public.opportunities o where o.id = opportunity_products.opportunity_id));
alter table public.opportunity_competitors enable row level security;
create policy opportunity_competitors_select on public.opportunity_competitors for select to authenticated
  using (company_id = private.current_company() and private.has_perm('opportunities.read')
         and exists (select 1 from public.opportunities o where o.id = opportunity_competitors.opportunity_id));
alter table public.opportunity_stage_history enable row level security;
create policy opportunity_stage_history_select on public.opportunity_stage_history for select to authenticated
  using (company_id = private.current_company() and private.has_perm('opportunities.read')
         and exists (select 1 from public.opportunities o where o.id = opportunity_stage_history.opportunity_id));
alter table public.pipeline_stages enable row level security;
create policy pipeline_stages_select on public.pipeline_stages for select to authenticated
  using (company_id = private.current_company() and private.has_perm('opportunities.read'));
alter table public.pipeline_transitions enable row level security;
create policy pipeline_transitions_select on public.pipeline_transitions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('opportunities.read'));

revoke all on public.opportunity_products, public.opportunity_competitors, public.opportunity_stage_history,
  public.pipeline_stages, public.pipeline_transitions from anon, authenticated;
grant select on public.opportunity_products, public.opportunity_competitors, public.opportunity_stage_history,
  public.pipeline_stages, public.pipeline_transitions to authenticated;
grant all on public.opportunity_products, public.opportunity_competitors, public.opportunity_stage_history,
  public.pipeline_stages, public.pipeline_transitions to service_role;

-- ---------------------------------------------------------------------
-- 5. Taux validé sans exception (pour les synthèses : absence = exclusion, pas erreur)
-- ---------------------------------------------------------------------
create function private.fx_or_null(p_currency char(3), p_date date, p_base char(3)) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_currency = p_base then 1 else (
    select e.rate from public.exchange_rates e
     where e.company_id = private.current_company() and e.currency = p_currency and e.status = 'valide' and e.rate_date <= p_date
     order by e.rate_date desc limit 1) end
$$;
revoke execute on function private.fx_or_null(char, date, char) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Étapes : configuration (pipeline.configure)
-- ---------------------------------------------------------------------
create function public.pipeline_stage_set(p_code text, p_label text, p_kind text, p_position int, p_probability numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.pipeline_stages%rowtype; o record;
begin
  perform private.require_perm('pipeline.configure');
  if p_kind not in ('open', 'won', 'lost') then raise exception 'PIPELINE_BAD_KIND' using errcode = '22023'; end if;
  select * into s from public.pipeline_stages where company_id = v_co and code = p_code;
  if found then
    if s.kind <> p_kind then raise exception 'PIPELINE_KIND_LOCKED' using errcode = '55000'; end if;   -- le genre d'une étape existante ne change pas
    update public.pipeline_stages set label = btrim(p_label), position = p_position, probability_pct = p_probability, updated_at = now()
     where id = s.id;
    perform private.write_audit(v_co, 'pipeline.stage_update', 'pipeline_stage', s.id::text, p_code, to_jsonb(s),
      jsonb_build_object('label', btrim(p_label), 'position', p_position, 'probability_pct', p_probability), '{}'::jsonb, 'rpc');
    return;
  end if;
  if p_kind <> 'open' then raise exception 'PIPELINE_STAGE_FIXED' using errcode = '55000'; end if;  -- gagnée et perdue sont uniques (seedées)
  insert into public.pipeline_stages (company_id, code, label, kind, position, probability_pct)
  values (v_co, p_code, btrim(p_label), 'open', p_position, p_probability) returning * into s;
  -- transitions par défaut d'une nouvelle étape ouverte : vers et depuis les autres étapes ouvertes, et vers gagnée/perdue
  insert into public.pipeline_transitions (company_id, from_code, to_code)
  select v_co, a.code, s.code from public.pipeline_stages a where a.company_id = v_co and a.kind = 'open' and a.id <> s.id
  union all select v_co, s.code, a.code from public.pipeline_stages a where a.company_id = v_co and a.kind = 'open' and a.id <> s.id
  union all select v_co, s.code, a.code from public.pipeline_stages a where a.company_id = v_co and a.kind in ('won', 'lost')
  on conflict do nothing;
  perform private.write_audit(v_co, 'pipeline.stage_create', 'pipeline_stage', s.id::text, p_code, null, to_jsonb(s), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.pipeline_stage_set(text, text, text, int, numeric) to authenticated, service_role;

create function public.pipeline_transition_set(p_from text, p_to text, p_allowed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('pipeline.configure');
  if not exists (select 1 from public.pipeline_stages where company_id = v_co and code = p_from)
     or not exists (select 1 from public.pipeline_stages where company_id = v_co and code = p_to) then
    raise exception 'PIPELINE_STAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.pipeline_stages where company_id = v_co and code = p_from and kind <> 'open') then
    raise exception 'PIPELINE_TERMINAL_STAGE' using errcode = '55000';                  -- une étape fermée ne se rouvre pas
  end if;
  if p_allowed then
    insert into public.pipeline_transitions (company_id, from_code, to_code) values (v_co, p_from, p_to) on conflict do nothing;
  else
    delete from public.pipeline_transitions where company_id = v_co and from_code = p_from and to_code = p_to;
  end if;
  perform private.write_audit(v_co, 'pipeline.transition_set', 'pipeline_stage', p_from, p_from || ' → ' || p_to, null,
    jsonb_build_object('allowed', p_allowed), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.pipeline_transition_set(text, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Opportunités : création, mise à jour, produits, concurrents
-- ---------------------------------------------------------------------
create function public.opportunity_create(p_client uuid, p_name text, p_amount numeric, p_currency text, p_expected_close date,
                                          p_owner uuid, p_next_action text default null, p_next_date date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_stage public.pipeline_stages%rowtype; v_id uuid; v_owner uuid := coalesce(p_owner, auth.uid());
begin
  perform private.require_perm('opportunities.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co and c.archived_at is null) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'OPPORTUNITY_NAME_REQUIRED' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'OPPORTUNITY_AMOUNT_INVALID' using errcode = '22023'; end if;
  if p_currency is null or not exists (select 1 from public.currencies where code = p_currency) then
    raise exception 'OPPORTUNITY_CURRENCY_REQUIRED' using errcode = '22023';
  end if;
  if v_owner is null or v_owner not in (select h from private.permission_holders(v_co, 'opportunities.write') h) then
    raise exception 'PROSPECT_OWNER_INVALID' using errcode = '22023';
  end if;
  select * into v_stage from public.pipeline_stages where company_id = v_co and kind = 'open' and active order by position limit 1;
  if not found then raise exception 'PIPELINE_NO_OPEN_STAGE' using errcode = '55000'; end if;
  insert into public.opportunities (company_id, client_id, prospect_id, name, value, stage, owner_id, expected_close,
    stage_id, currency, probability_pct, next_action, next_action_date)
  values (v_co, p_client, null, btrim(p_name), p_amount, 'open', v_owner, p_expected_close,
    v_stage.id, p_currency, v_stage.probability_pct, nullif(btrim(coalesce(p_next_action, '')), ''), p_next_date)
  returning id into v_id;
  insert into public.opportunity_stage_history (company_id, opportunity_id, from_stage, to_stage, probability_pct, amount, currency, reason, changed_by)
  values (v_co, v_id, null, v_stage.code, v_stage.probability_pct, p_amount, p_currency, 'création', auth.uid());
  perform private.write_audit(v_co, 'opportunity.create', 'opportunity', v_id::text, btrim(p_name), null,
    jsonb_build_object('amount', p_amount, 'currency', p_currency, 'stage', v_stage.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.opportunity_create(uuid, text, numeric, text, date, uuid, text, date) to authenticated, service_role;

create function public.opportunity_update(p_opp uuid, p_amount numeric, p_currency text, p_expected_close date,
                                          p_next_action text, p_next_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities%rowtype;
begin
  perform private.require_perm('opportunities.write');
  select * into o from public.opportunities where id = p_opp and company_id = private.current_company() for update;
  if not found or not private.prospect_visible(o.owner_id) then raise exception 'OPPORTUNITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.stage <> 'open' then raise exception 'OPPORTUNITY_CLOSED' using errcode = '55000'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'OPPORTUNITY_AMOUNT_INVALID' using errcode = '22023'; end if;
  if p_currency is null or not exists (select 1 from public.currencies where code = p_currency) then
    raise exception 'OPPORTUNITY_CURRENCY_REQUIRED' using errcode = '22023';
  end if;
  update public.opportunities set value = p_amount, currency = p_currency, expected_close = p_expected_close,
         next_action = nullif(btrim(coalesce(p_next_action, '')), ''), next_action_date = p_next_date, updated_at = now()
   where id = o.id;
  perform private.write_audit(o.company_id, 'opportunity.update', 'opportunity', o.id::text, o.name,
    jsonb_build_object('amount', o.value, 'currency', o.currency, 'expected_close', o.expected_close),
    jsonb_build_object('amount', p_amount, 'currency', p_currency, 'expected_close', p_expected_close), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.opportunity_update(uuid, numeric, text, date, text, date) to authenticated, service_role;

create function public.opportunity_set_stage(p_opp uuid, p_stage text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); o public.opportunities%rowtype; s public.pipeline_stages%rowtype; v_from public.pipeline_stages%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('opportunities.write');
  select * into o from public.opportunities where id = p_opp and company_id = v_co for update;
  if not found or not private.prospect_visible(o.owner_id) then raise exception 'OPPORTUNITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.stage <> 'open' then raise exception 'OPPORTUNITY_CLOSED' using errcode = '55000'; end if;
  select * into s from public.pipeline_stages where company_id = v_co and code = p_stage and active;
  if not found then raise exception 'PIPELINE_STAGE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_from from public.pipeline_stages where id = o.stage_id;
  -- étape autorisée : la transition doit exister dans la configuration de la société (les opportunités sans étape ne passent que par la création)
  if o.stage_id is null or not exists (select 1 from public.pipeline_transitions t where t.company_id = v_co and t.from_code = v_from.code and t.to_code = s.code) then
    raise exception 'PIPELINE_TRANSITION_FORBIDDEN' using errcode = '55000', detail = coalesce(v_from.code, 'sans étape') || ' → ' || s.code;
  end if;
  if s.kind = 'lost' and (v_reason is null or length(v_reason) < 3) then raise exception 'OPPORTUNITY_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.opportunities set stage_id = s.id, stage = s.kind, probability_pct = s.probability_pct, updated_at = now(),
         won_at = case when s.kind = 'won' then now() else won_at end,
         lost_at = case when s.kind = 'lost' then now() else lost_at end,
         lost_reason = case when s.kind = 'lost' then v_reason else lost_reason end,
         closed_by = case when s.kind <> 'open' then auth.uid() else closed_by end
   where id = o.id;
  insert into public.opportunity_stage_history (company_id, opportunity_id, from_stage, to_stage, probability_pct, amount, currency, reason, changed_by)
  values (v_co, o.id, v_from.code, s.code, s.probability_pct, o.value, o.currency, v_reason, auth.uid());
  perform private.write_audit(v_co, 'opportunity.stage', 'opportunity', o.id::text, o.name,
    jsonb_build_object('stage', v_from.code), jsonb_build_object('stage', s.code), jsonb_build_object('reason', v_reason), 'rpc');
end $$;
grant execute on function public.opportunity_set_stage(uuid, text, text) to authenticated, service_role;

create function public.opportunity_add_product(p_opp uuid, p_label text, p_quantity numeric, p_unit_amount numeric, p_product uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities%rowtype; v_id uuid;
begin
  perform private.require_perm('opportunities.write');
  select * into o from public.opportunities where id = p_opp and company_id = private.current_company();
  if not found or not private.prospect_visible(o.owner_id) then raise exception 'OPPORTUNITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.stage <> 'open' then raise exception 'OPPORTUNITY_CLOSED' using errcode = '55000'; end if;
  insert into public.opportunity_products (company_id, opportunity_id, product_id, label, quantity, unit_amount)
  values (o.company_id, o.id, p_product, btrim(p_label), p_quantity, p_unit_amount) returning id into v_id;
  return v_id;
end $$;
grant execute on function public.opportunity_add_product(uuid, text, numeric, numeric, uuid) to authenticated, service_role;

create function public.opportunity_add_competitor(p_opp uuid, p_name text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities%rowtype; v_id uuid;
begin
  perform private.require_perm('opportunities.write');
  select * into o from public.opportunities where id = p_opp and company_id = private.current_company();
  if not found or not private.prospect_visible(o.owner_id) then raise exception 'OPPORTUNITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.stage <> 'open' then raise exception 'OPPORTUNITY_CLOSED' using errcode = '55000'; end if;
  insert into public.opportunity_competitors (company_id, opportunity_id, name, note)
  values (o.company_id, o.id, btrim(p_name), nullif(btrim(coalesce(p_note, '')), '')) returning id into v_id;
  return v_id;
end $$;
grant execute on function public.opportunity_add_competitor(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Tableau et synthèse
-- ---------------------------------------------------------------------
-- Pipeline : étapes et opportunités visibles (périmètre commercial) ; les opportunités sans étape sont listées à part
create function public.pipeline_board() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('opportunities.read');
  return jsonb_build_object(
    'stages', coalesce((select jsonb_agg(jsonb_build_object('code', s.code, 'label', s.label, 'kind', s.kind, 'position', s.position,
                                    'probability_pct', s.probability_pct) order by s.position)
                          from public.pipeline_stages s where s.company_id = v_co and s.active), '[]'::jsonb),
    'opportunities', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'stage', st.code, 'amount', o.value,
                                    'currency', o.currency, 'probability_pct', o.probability_pct, 'expected_close', o.expected_close,
                                    'next_action', o.next_action, 'next_action_date', o.next_action_date, 'client_id', o.client_id,
                                    'status', o.stage) order by o.expected_close nulls last, o.created_at)
                                from public.opportunities o left join public.pipeline_stages st on st.id = o.stage_id
                               where o.company_id = v_co and private.prospect_visible(o.owner_id)), '[]'::jsonb));
end $$;
grant execute on function public.pipeline_board() to authenticated, service_role;

-- Synthèse : pondéré (opportunités), commandes (quantités), CA (factures − avoirs). Sans droit : section absente (null).
create function public.pipeline_summary(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_base char(3); v_minor int;
  v_w numeric := 0; v_gross numeric := 0; v_n int := 0; v_no_prob int := 0; v_no_cur int := 0; v_no_fx int := 0;
  v_ca numeric := 0; v_ca_n int := 0; v_ca_no_fx int := 0; v_ord_n int := 0; v_ord_qty numeric := 0;
  r record; v_fx numeric; v_amt numeric; v_inv_sub numeric;
begin
  select f.base_currency into v_base from public.finance_settings f where f.company_id = v_co;
  if v_base is null then raise exception 'FINANCE_BASE_MISSING' using errcode = '55000'; end if;
  select minor_units into v_minor from public.currencies where code = v_base;

  if private.has_perm('opportunities.read') then
    for r in select o.id, o.value, o.currency, o.probability_pct, o.expected_close from public.opportunities o
              where o.company_id = v_co and o.stage = 'open' and private.prospect_visible(o.owner_id) loop
      v_n := v_n + 1;
      if r.probability_pct is null then v_no_prob := v_no_prob + 1; continue; end if;
      if r.currency is null then v_no_cur := v_no_cur + 1; continue; end if;
      v_fx := private.fx_or_null(r.currency, current_date, v_base);
      if v_fx is null then v_no_fx := v_no_fx + 1; continue; end if;
      v_amt := round(r.value * v_fx, v_minor);
      v_gross := v_gross + v_amt;
      v_w := v_w + round(v_amt * r.probability_pct / 100, v_minor);
    end loop;
  end if;

  if private.has_perm('orders.read') then
    select count(*), coalesce(sum(l.qty), 0) into v_ord_n, v_ord_qty
      from public.sales_orders so left join public.sales_order_lines l on l.order_id = so.id
     where so.company_id = v_co and so.status = 'confirmed'
       and (p_from is null or so.order_date >= p_from) and (p_to is null or so.order_date <= p_to);
  end if;

  if private.has_perm('invoices.read') then
    for r in select i.total, i.subtotal, i.currency, i.issue_date from public.invoices i
              where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid', 'credited')
                and (p_from is null or i.issue_date >= p_from) and (p_to is null or i.issue_date <= p_to) loop
      v_fx := private.fx_or_null(r.currency, r.issue_date, v_base);
      if v_fx is null then v_ca_no_fx := v_ca_no_fx + 1; continue; end if;
      v_ca := v_ca + round(r.subtotal * v_fx, v_minor); v_ca_n := v_ca_n + 1;
    end loop;
    for r in select c.subtotal, c.currency, c.issue_date from public.credit_notes c
              where c.company_id = v_co and c.status = 'issued'
                and (p_from is null or c.issue_date >= p_from) and (p_to is null or c.issue_date <= p_to) loop
      v_fx := private.fx_or_null(r.currency, r.issue_date, v_base);
      if v_fx is null then v_ca_no_fx := v_ca_no_fx + 1; continue; end if;
      v_ca := v_ca - round(r.subtotal * v_fx, v_minor);
    end loop;
  end if;

  return jsonb_build_object(
    'base_currency', v_base,
    'pipeline', case when private.has_perm('opportunities.read') then jsonb_build_object(
        'weighted', v_w, 'gross', v_gross, 'open_count', v_n,
        'excluded', jsonb_build_object('no_probability', v_no_prob, 'no_currency', v_no_cur, 'no_rate', v_no_fx)) end,
    'orders', case when private.has_perm('orders.read') then jsonb_build_object(
        'confirmed_count', v_ord_n, 'confirmed_qty', v_ord_qty, 'note', 'quantités, sans montant') end,
    'revenue', case when private.has_perm('invoices.read') then jsonb_build_object(
        'net_ht', v_ca, 'invoices_counted', v_ca_n, 'excluded_no_rate', v_ca_no_fx) end);
end $$;
grant execute on function public.pipeline_summary(date, date) to authenticated, service_role;
