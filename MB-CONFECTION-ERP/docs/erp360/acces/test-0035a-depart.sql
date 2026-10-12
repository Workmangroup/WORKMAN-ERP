begin;
do $t$
declare
  adm uuid := (select id from public.profiles where email = 'admin@mbconfection.com');
  vic uuid := (select id from public.profiles where email = 'norole.test@mbconfection.local');
  rl uuid := (select id from public.roles where code = 'commercial' limit 1);
  r jsonb; msg text; n int; ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. Motif obligatoire
  begin perform public.rbac_depart_user(vic, ''); ok := false;
  exception when others then ok := sqlerrm like '%DEPARTURE_REASON_REQUIRED%'; end;
  if not ok then raise exception 'FAIL 1 motif non exigé'; end if;
  raise notice 'PASS 1 motif obligatoire';

  -- 2. Auto-départ refusé
  begin perform public.rbac_depart_user(adm, 'Test auto-départ'); ok := false;
  exception when others then ok := sqlerrm like '%RBAC_SELF%'; end;
  if not ok then raise exception 'FAIL 2 auto-départ accepté'; end if;
  raise notice 'PASS 2 auto-départ refusé';

  -- 3. Départ : rôles retirés, sessions révoquées, compte désactivé
  r := public.rbac_depart_user(vic, 'Fin de contrat (test)');
  raise notice 'INFO départ : %', r;
  reset role;
  select count(*) into n from public.profiles where id = vic and is_active = false and departed_at is not null;
  if n <> 1 then raise exception 'FAIL 3 compte non désactivé'; end if;
  select count(*) into n from public.user_roles where user_id = vic;
  if n <> 0 then raise exception 'FAIL 3b rôles restants : %', n; end if;
  select count(*) into n from public.audit_logs where action = 'user.departed' and entity_id = vic::text;
  if n < 1 then raise exception 'FAIL 3c journal du départ absent'; end if;
  raise notice 'PASS 3 départ : compte désactivé, rôles retirés, journal présent';

  -- 4. Réactivation refusée
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.rbac_set_user_active(vic, true); ok := false;
  exception when others then ok := sqlerrm like '%USER_DEPARTED%'; msg := sqlerrm; end;
  reset role;
  if not ok then raise exception 'FAIL 4 réactivation d''un compte parti acceptée'; end if;
  raise notice 'PASS 4 réactivation refusée (%)', msg;

  -- 5. Double départ refusé
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.rbac_depart_user(vic, 'Deuxième départ'); ok := false;
  exception when others then ok := sqlerrm like '%USER_ALREADY_DEPARTED%'; end;
  reset role;
  if not ok then raise exception 'FAIL 5 double départ accepté'; end if;
  raise notice 'PASS 5 double départ refusé';

  -- 6. Changement d'e-mail d'un compte parti refusé
  begin update public.profiles set email = 'nouveau@example.com' where id = vic; ok := false;
  exception when others then ok := sqlerrm like '%USER_DEPARTED%'; end;
  if not ok then raise exception 'FAIL 6 e-mail d''un compte parti modifiable'; end if;
  raise notice 'PASS 6 e-mail d''un compte parti figé';

  -- 7. Rôle refusé à un compte parti
  begin insert into public.user_roles (user_id, role_id) values (vic, rl); ok := false;
  exception when others then ok := sqlerrm like '%USER_DEPARTED%'; end;
  if not ok then raise exception 'FAIL 7 rôle attribué à un compte parti'; end if;
  raise notice 'PASS 7 rôle refusé à un compte parti';

end
$t$;
rollback;
