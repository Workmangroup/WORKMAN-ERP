begin;
do $t$
declare
  adm uuid := (select id from public.profiles where email = 'admin@mbconfection.com');
  vic uuid := (select id from public.profiles where email = 'norole.test@mbconfection.local');
  rl uuid := (select id from public.roles where code = 'commercial' limit 1);
  ok boolean;
begin
  -- 8a. Personnel sans rôle -> technique avec responsable nommé : accepté
  update public.profiles set account_kind = 'technical', technical_owner_id = adm where id = vic;
  raise notice 'PASS 8a conversion en compte technique (sans rôle, responsable nommé)';
  -- 8b. Compte technique : aucun rôle
  begin insert into public.user_roles (user_id, role_id) values (vic, rl); ok := false;
  exception when others then ok := sqlerrm like '%TECHNICAL_ACCOUNT_NO_ROLE%'; end;
  if not ok then raise exception 'FAIL 8b compte technique reçoit un rôle'; end if;
  raise notice 'PASS 8b compte technique : aucun rôle attribuable';
  -- 8c. Responsable obligatoire
  begin update public.profiles set technical_owner_id = null where id = vic; ok := false;
  exception when others then ok := sqlerrm like '%profiles_technical_owner_ck%'; end;
  if not ok then raise exception 'FAIL 8c compte technique sans responsable accepté'; end if;
  raise notice 'PASS 8c responsable nommé obligatoire';
  -- 8d. Technique -> personnel interdit
  begin update public.profiles set account_kind = 'personal', technical_owner_id = null where id = vic; ok := false;
  exception when others then ok := sqlerrm like '%ACCOUNT_KIND_FROZEN%'; end;
  if not ok then raise exception 'FAIL 8d compte technique redevenu personnel'; end if;
  raise notice 'PASS 8d retour technique -> personnel refusé';
  -- 8e. Compte avec rôles (administrateur) : conversion refusée
  begin update public.profiles set account_kind = 'technical', technical_owner_id = vic where id = adm; ok := false;
  exception when others then ok := sqlerrm like '%ACCOUNT_KIND_FROZEN%'; end;
  if not ok then raise exception 'FAIL 8e conversion d''un compte ayant des rôles acceptée'; end if;
  raise notice 'PASS 8e conversion refusée pour un compte ayant des rôles';
end
$t$;
rollback;
