-- ===========================================================================
-- 0096 — Socle mobile : registre des appareils, révocation, contrôle par requête (P099), additif
--
-- Ajoute : appareils mobiles identifiés par un identifiant local (généré par l'appareil), rattachés
-- à un utilisateur ; révocation par le propriétaire ou par un administrateur ; contrôle d'un appareil
-- avant chaque requête mobile (appareil inconnu, d'un autre utilisateur, révoqué) ; trace d'activité.
-- Une fois révoqué, un identifiant ne peut pas être réactivé : l'appareil doit en générer un nouveau.
-- Non inclus : durée de vie des jetons (réglage du projet d'authentification, hors dépôt) ; durée
-- d'inactivité et durée hors ligne (valeurs à fournir, comme pour la politique POS hors ligne).
-- ===========================================================================

insert into public.permissions (code, module, label, description) values
  ('mobile.use', 'admin', 'Utiliser une application mobile', 'Enregistrer son appareil et utiliser les écrans mobiles'),
  ('mobile.admin', 'admin', 'Révoquer les appareils mobiles', 'Révocation d’un appareil d’un autre utilisateur')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('mobile.use', 'mobile.admin')
where r.is_system and r.code = 'admin' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'mobile.use'
where r.is_system and r.code = 'magasin' on conflict do nothing;

create table public.mobile_devices (
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  id            uuid primary key,
  user_id       uuid not null,
  label         text not null check (length(btrim(label)) between 2 and 80),
  registered_at timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text check (revoke_reason is null or length(btrim(revoke_reason)) between 5 and 300),
  check ((revoked_at is null) = (revoked_by is null and revoke_reason is null))
);
create index mobile_devices_user_idx on public.mobile_devices (company_id, user_id);

-- Historique : une ligne ne se supprime pas ; seule la révocation la modifie (une seule fois)
create function private.mobile_devices_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'MOBILE_APPEND_ONLY' using errcode = '55000'; end if;
  if old.revoked_at is not null then raise exception 'MOBILE_DEVICE_REVOKED' using errcode = '55000'; end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.label <> old.label or new.registered_at <> old.registered_at then
    raise exception 'MOBILE_APPEND_ONLY' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.mobile_devices_guard() from public, anon, authenticated;
create trigger mobile_devices_guard before update or delete on public.mobile_devices
  for each row execute function private.mobile_devices_guard();

alter table public.mobile_devices enable row level security;
create policy mobile_devices_select on public.mobile_devices for select to authenticated
  using (company_id = private.current_company() and (user_id = auth.uid() or private.has_perm('mobile.admin')));
revoke all on public.mobile_devices from anon, authenticated;
grant select on public.mobile_devices to authenticated;
grant all on public.mobile_devices to service_role;

-- Enregistrement : l'identifiant local appartient au premier utilisateur qui l'enregistre
create function public.mobile_device_register(p_device uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.mobile_devices%rowtype;
begin
  perform private.require_perm('mobile.use');
  if p_device is null or p_label is null or length(btrim(p_label)) < 2 or length(btrim(p_label)) > 80 then
    raise exception 'MOBILE_BAD_INPUT' using errcode = '22023';
  end if;
  select * into d from public.mobile_devices where id = p_device;
  if found then
    if d.company_id <> v_co or d.user_id <> auth.uid() then raise exception 'MOBILE_DEVICE_OWNED' using errcode = '42501'; end if;
    if d.revoked_at is not null then raise exception 'MOBILE_DEVICE_REVOKED' using errcode = '42501'; end if;
    return;
  end if;
  insert into public.mobile_devices (company_id, id, user_id, label) values (v_co, p_device, auth.uid(), btrim(p_label));
  perform private.write_audit(v_co, 'mobile.device_register', 'mobile_device', p_device::text, btrim(p_label), null,
    jsonb_build_object('user_id', auth.uid()), '{}'::jsonb, 'rpc');
end $$;

-- Contrôle à chaque requête : retourne true si l'appareil est actif et appartient à l'utilisateur ; sinon erreur explicite
create function public.mobile_device_check(p_device uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.mobile_devices%rowtype;
begin
  perform private.require_perm('mobile.use');
  select * into d from public.mobile_devices where id = p_device and company_id = v_co;
  if not found then raise exception 'MOBILE_DEVICE_UNKNOWN' using errcode = '42501'; end if;
  if d.user_id <> auth.uid() then raise exception 'MOBILE_DEVICE_NOT_OWNER' using errcode = '42501'; end if;
  if d.revoked_at is not null then raise exception 'MOBILE_DEVICE_REVOKED' using errcode = '42501'; end if;
  update public.mobile_devices set last_seen_at = now() where id = d.id;
  return true;
end $$;

-- Révocation : par le propriétaire, ou par un administrateur (mobile.admin) ; une seule fois
create function public.mobile_device_revoke(p_device uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); d public.mobile_devices%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 or length(btrim(p_reason)) > 300 then raise exception 'MOBILE_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into d from public.mobile_devices where id = p_device and company_id = v_co for update;
  if not found then raise exception 'MOBILE_DEVICE_UNKNOWN' using errcode = '42501'; end if;
  if d.user_id <> auth.uid() and not private.has_perm('mobile.admin') then raise exception 'MOBILE_DEVICE_NOT_OWNER' using errcode = '42501'; end if;
  if d.revoked_at is not null then raise exception 'MOBILE_BAD_STATUS' using errcode = '55000'; end if;
  update public.mobile_devices set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason) where id = d.id;
  perform private.write_audit(v_co, 'mobile.device_revoke', 'mobile_device', d.id::text, d.label, jsonb_build_object('status', 'actif'),
    jsonb_build_object('status', 'révoqué'), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
