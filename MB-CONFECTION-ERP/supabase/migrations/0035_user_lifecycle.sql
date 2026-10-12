-- ---------------------------------------------------------------------
-- 0035_user_lifecycle — Lot P008 : cycle de vie des comptes (partie base de données).
-- Existant conservé : suspension (rbac_set_user_active, garde du dernier administrateur), révocation de sessions
-- (rbac_revoke_user_sessions, revoke_session), historique des rôles (audit_user_roles), auto-protection (RBAC_SELF).
-- Ajouté :
--  - départ définitif : rbac_depart_user retire les rôles (tracés un par un par audit_user_roles), révoque les
--    sessions, désactive le compte et conserve l'historique. Un compte parti ne se réactive pas et son e-mail
--    reste lié à ce compte : un nouvel arrivant reçoit un nouveau compte (pas de réutilisation).
--  - comptes techniques séparés : account_kind = 'technical' exige un responsable nominatif (technical_owner_id),
--    et ne peut recevoir aucun rôle (donc aucune approbation).
-- Non fait ici : invitation et activation par e-mail (décision D-P008-01), MFA (SEC-01), écran.
--
-- Retour arrière (manuel, non exécuté) : supprimer les triggers profiles_lifecycle_guard et user_roles_lifecycle_guard,
-- la fonction rbac_depart_user, puis les colonnes ajoutées à public.profiles. Aucune donnée existante n'est supprimée.
-- ---------------------------------------------------------------------

alter table public.profiles
  add column account_kind text not null default 'personal'
    constraint profiles_account_kind_ck check (account_kind in ('personal', 'technical')),
  add column technical_owner_id uuid references public.profiles(id),
  add column departed_at timestamptz,
  add column departed_by uuid,
  add column departure_reason text
    constraint profiles_departure_reason_ck check (departure_reason is null or length(btrim(departure_reason)) between 3 and 300),
  add constraint profiles_technical_owner_ck check (
    account_kind = 'personal' or (technical_owner_id is not null and user_type = 'internal')
  ),
  add constraint profiles_departure_ck check ((departed_at is null) = (departure_reason is null));

create index profiles_technical_owner_idx on public.profiles (technical_owner_id);

-- Garde du cycle de vie : un compte parti est figé ; le type de compte ne change pas.
create function private.profiles_lifecycle_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.departed_at is not null then
      if new.is_active or new.email is distinct from old.email
         or new.departed_at is distinct from old.departed_at
         or new.departure_reason is distinct from old.departure_reason then
        raise exception 'USER_DEPARTED' using errcode = '55000';
      end if;
    end if;
    -- Type de compte : personnel -> technique seulement, et seulement sans rôle attribué.
    -- Technique -> personnel interdit (il ferait d'une identité de service un compte humain).
    if new.account_kind is distinct from old.account_kind then
      if not (old.account_kind = 'personal' and new.account_kind = 'technical'
              and not exists (select 1 from public.user_roles ur where ur.user_id = old.id)) then
        raise exception 'ACCOUNT_KIND_FROZEN' using errcode = '55000';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger profiles_lifecycle_guard before update on public.profiles
  for each row execute function private.profiles_lifecycle_guard();

-- Un compte technique et un compte parti ne reçoivent aucun rôle.
create function private.user_roles_lifecycle_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_p public.profiles%rowtype;
begin
  select * into v_p from public.profiles where id = new.user_id;
  if found then
    if v_p.departed_at is not null then raise exception 'USER_DEPARTED' using errcode = '55000'; end if;
    if v_p.account_kind = 'technical' then raise exception 'TECHNICAL_ACCOUNT_NO_ROLE' using errcode = '42501'; end if;
  end if;
  return new;
end $$;

create trigger user_roles_lifecycle_guard before insert on public.user_roles
  for each row execute function private.user_roles_lifecycle_guard();

-- Départ définitif.
create function public.rbac_depart_user(p_user uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_t public.profiles%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_roles int; v_sessions int;
begin
  perform private.require_perm('users.write');
  if length(v_reason) < 3 or length(v_reason) > 300 then
    raise exception 'DEPARTURE_REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into v_t from public.profiles where id = p_user and company_id = private.current_company();
  if not found then raise exception 'RBAC_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_user = auth.uid() then raise exception 'RBAC_SELF' using errcode = '42501'; end if;
  if v_t.departed_at is not null then raise exception 'USER_ALREADY_DEPARTED' using errcode = '55000'; end if;
  if v_t.is_active
     and exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id and r.code = 'admin'
                 where ur.user_id = p_user)
     and private.active_admin_count(v_t.company_id, p_user) = 0 then
    raise exception 'RBAC_LAST_ADMIN' using errcode = '55000';
  end if;

  -- Rôles retirés : chaque retrait est tracé par audit_user_roles (user.role_revoke).
  delete from public.user_roles where user_id = p_user;
  get diagnostics v_roles = row_count;
  -- Sessions révoquées côté authentification.
  delete from auth.sessions where user_id = p_user;
  get diagnostics v_sessions = row_count;
  update public.profiles
     set is_active = false, departed_at = now(), departed_by = auth.uid(), departure_reason = v_reason
   where id = p_user;

  perform private.write_audit(v_t.company_id, 'user.departed', 'user', p_user::text, v_t.email, null, null,
    jsonb_build_object('roles_removed', v_roles, 'sessions_revoked', v_sessions, 'reason', v_reason), 'rpc');
  return jsonb_build_object('user_id', p_user, 'roles_removed', v_roles, 'sessions_revoked', v_sessions);
end $$;

revoke all on function public.rbac_depart_user(uuid, text) from public, anon;
grant execute on function public.rbac_depart_user(uuid, text) to authenticated;
