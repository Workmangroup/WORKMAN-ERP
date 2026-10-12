-- =====================================================================
-- 0028_access_token_hook_fix — Hook JWT : ne plus émettre client_id à null
--  GoTrue réserve le claim « client_id » (identifiant OAuth) et refuse un null :
--  « output claims do not conform to the expected schema ». Le claim n'est donc
--  ajouté que pour les comptes client (client_id renseigné).
--  Corps repris de 0003 (app_permissions conservé), seule la gestion de client_id change.
-- =====================================================================
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := event -> 'claims';
  v_uid    uuid  := (event ->> 'user_id')::uuid;
  v_prof   public.profiles%rowtype;
  v_roles  jsonb;
  v_perms  jsonb;
begin
  select * into v_prof from public.profiles where id = v_uid;
  if not found then
    return event;
  end if;

  select coalesce(jsonb_agg(r.code order by r.code), '[]'::jsonb) into v_roles
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.user_id = v_uid;

  select coalesce(jsonb_agg(distinct pe.code), '[]'::jsonb) into v_perms
  from public.user_roles ur
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions pe on pe.id = rp.permission_id
  where ur.user_id = v_uid;

  v_claims := v_claims
    || jsonb_build_object(
         'company_id',           v_prof.company_id,
         'user_type',            v_prof.user_type,
         'app_roles',            v_roles,
         'app_permissions',      v_perms,
         'must_change_password', v_prof.must_change_password,
         'is_active',            v_prof.is_active);

  -- client_id : uniquement pour un compte client (sinon GoTrue rejette le jeton)
  if v_prof.client_id is not null then
    v_claims := v_claims || jsonb_build_object('client_id', v_prof.client_id::text);
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end $$;
