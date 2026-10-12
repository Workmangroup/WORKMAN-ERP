begin;
do $t$
declare
  adm uuid := (select id from public.profiles where email = 'admin@mbconfection.com');
  vic uuid := (select id from public.profiles where email = 'norole.test@mbconfection.local');
  rl uuid := (select id from public.roles where code = 'commercial' limit 1);
  r jsonb; n int; perm boolean; comp uuid; ok boolean;
begin
  -- Préparation (propriétaire de la base) : le salarié reçoit un rôle commercial
  insert into public.user_roles (user_id, role_id) values (vic, rl);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  r := public.rbac_depart_user(vic, 'Démission (test)');
  reset role;
  if (r->>'roles_removed')::int <> 1 then raise exception 'FAIL 9a rôle non retiré : %', r; end if;
  select count(*) into n from public.user_roles where user_id = vic;
  if n <> 0 then raise exception 'FAIL 9b rôle restant'; end if;
  select count(*) into n from public.audit_logs where action = 'user.role_revoke' and entity_id = vic::text;
  if n < 1 then raise exception 'FAIL 9c retrait de rôle non journalisé'; end if;
  raise notice 'PASS 9 départ avec rôle : rôle retiré et journalisé (%)', r;
  -- Le salarié parti n'a plus aucun droit ni société active
  perform set_config('request.jwt.claims', json_build_object('sub', vic, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perm := private.has_perm('clients.read');
  comp := private.current_company();
  reset role;
  if perm or comp is not null then raise exception 'FAIL 10 accès conservé après départ'; end if;
  raise notice 'PASS 10 après départ : aucun droit, aucune société active';
end
$t$;
rollback;
