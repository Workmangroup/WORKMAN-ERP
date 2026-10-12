-- =====================================================================
-- 0041_fodec — FODEC sur les articles confectionnés : paramètre versionné, signé par la finance, sans taux supposé (P017)
--  Règle confirmée par le propriétaire : FODEC s'applique à tout article confectionné (produits finis / variantes).
--  Taux, base et dates d'effet : NON FOURNIS. Aucune valeur n'est inventée : la ligne FODEC n'existe pas tant que
--  la finance ne la saisit pas, et un article confectionné ne peut pas être valorisé sans ligne FODEC signée.
--  Ajouts :
--    fodec_parameters : taux, base (HT ou TTC), période d'effet, statut et signature finance (auteur exclu)
--    fodec_for_variant : lit la ligne applicable à la date ; refuse si absente ou non signée
--    price_resolve_fodec : calcul de prix (price_resolve) complété par le montant FODEC, sans changer le total existant
--  Décision à confirmer : tous les produits du module Articles / PDM sont des articles confectionnés (pas des tissus).
-- =====================================================================

create table public.fodec_parameters (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id),
  rate_pct      numeric(7,4) check (rate_pct is null or (rate_pct >= 0 and rate_pct <= 100)),
  base          text check (base is null or base in ('HT', 'TTC')),
  effective_from date not null,
  effective_to  date,
  status        text not null default 'a_valider' check (status in ('a_valider', 'valide')),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  validated_by  uuid,
  validated_at  timestamptz,
  check (effective_to is null or effective_to >= effective_from),
  -- une ligne signée est complète : taux, base, signataire et date
  check ((status = 'valide') = (rate_pct is not null and base is not null and validated_by is not null and validated_at is not null)),
  check (validated_by is null or validated_by is distinct from created_by)
);
alter table public.fodec_parameters enable row level security;
create policy fodec_parameters_select on public.fodec_parameters for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('finance.read') or private.has_perm('pricing.read')));
revoke all on public.fodec_parameters from anon, authenticated;
grant select on public.fodec_parameters to authenticated;
grant all on public.fodec_parameters to service_role;

create function private.fodec_period_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.fodec_parameters o where o.id <> new.id and o.company_id = new.company_id
             and o.effective_from <= coalesce(new.effective_to, date '9999-12-31') and new.effective_from <= coalesce(o.effective_to, date '9999-12-31')) then
    raise exception 'FODEC_PERIOD_OVERLAP' using errcode = '23P01';
  end if;
  return new;
end $$;
create trigger fodec_parameters_period_iu before insert or update on public.fodec_parameters
  for each row execute function private.fodec_period_guard();

-- Saisie par la finance (finance.write) : statut « à valider » ; signature par une autre personne
create function public.fodec_set(p_rate_pct numeric, p_base text, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('finance.write');
  if p_from is null then raise exception 'FODEC_DATE_REQUIRED' using errcode = '22023'; end if;
  insert into public.fodec_parameters (id, company_id, rate_pct, base, effective_from, effective_to, status)
  values (v_id, private.current_company(), p_rate_pct, p_base, p_from, p_to, 'a_valider');
  perform private.write_audit(private.current_company(), 'finance.fodec_create', 'fodec', v_id::text, 'FODEC', null,
    jsonb_build_object('rate_pct', p_rate_pct, 'base', p_base, 'from', p_from, 'to', p_to), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.fodec_set(numeric, text, date, date) to authenticated, service_role;

create function public.fodec_validate(p_id uuid, p_validate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.fodec_parameters%rowtype;
begin
  perform private.require_perm('finance.write');
  select * into r from public.fodec_parameters where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'FODEC_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status = 'valide' then raise exception 'FODEC_BAD_STATUS' using errcode = '55000'; end if;
  if r.created_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'fodec'; end if;
  if p_validate then
    if r.rate_pct is null or r.base is null then raise exception 'FODEC_INCOMPLETE' using errcode = '22023'; end if;
    update public.fodec_parameters set status = 'valide', validated_by = auth.uid(), validated_at = now() where id = r.id;
  end if;
  perform private.write_audit(r.company_id, case when p_validate then 'finance.fodec_approve' else 'finance.fodec_reject' end, 'fodec', r.id::text,
    'FODEC', jsonb_build_object('status', r.status), jsonb_build_object('status', case when p_validate then 'valide' else 'a_valider' end),
    '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.fodec_validate(uuid, boolean) to authenticated, service_role;

-- Ligne applicable à une date : absente → FODEC_NOT_CONFIGURED ; non signée → FODEC_NOT_VALIDATED
create function private.fodec_at(p_date date) returns public.fodec_parameters
language plpgsql stable security definer set search_path = '' as $$
declare r public.fodec_parameters%rowtype;
begin
  select * into r from public.fodec_parameters
   where company_id = private.current_company() and p_date >= effective_from and (effective_to is null or p_date <= effective_to)
   order by effective_from desc limit 1;
  if not found then raise exception 'FODEC_NOT_CONFIGURED' using errcode = '55000', detail = p_date::text; end if;
  if r.status <> 'valide' then raise exception 'FODEC_NOT_VALIDATED' using errcode = '55000', detail = p_date::text; end if;
  return r;
end $$;
revoke execute on function private.fodec_at(date) from public, anon, authenticated;

-- Calcul : prix (price_resolve) + FODEC sur l'article confectionné ; le total existant n'est pas modifié
create function public.price_resolve_fodec(p_client uuid, p_variant uuid, p_qty numeric, p_on date, p_discount_pct numeric default 0, p_snapshot boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; f public.fodec_parameters%rowtype; v_minor int; v_base_amount numeric; v_fodec numeric;
begin
  f := private.fodec_at(p_on);                       -- refus avant tout calcul ou snapshot si FODEC absent/non signé
  v := public.price_resolve(p_client, p_variant, p_qty, p_on, p_discount_pct, p_snapshot);
  select minor_units into v_minor from public.currencies where code = v ->> 'currency';
  v_base_amount := case when f.base = 'TTC' then (v ->> 'total_amount')::numeric else (v ->> 'line_amount')::numeric end;
  v_fodec := round(v_base_amount * f.rate_pct / 100, v_minor);
  return v || jsonb_build_object('fodec_rate_pct', f.rate_pct, 'fodec_base', f.base, 'fodec_amount', v_fodec, 'fodec_parameter', f.id);
end $$;
grant execute on function public.price_resolve_fodec(uuid, uuid, numeric, date, numeric, boolean) to authenticated, service_role;
