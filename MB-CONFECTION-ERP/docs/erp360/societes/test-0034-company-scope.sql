begin;
do $t$
declare
  co uuid := (select company_id from public.purchase_requests limit 1);
  co2 uuid := gen_random_uuid();
  inv uuid := (select id from public.purchase_requests limit 1);
  u uuid := (select id from public.profiles where company_id is not null limit 1);
  n int; ok boolean; msg text;
begin
  -- 1. Reprise : une ligne d'accès par rattachement existant
  select count(*) into n from public.user_company_access;
  if n <> (select count(*) from public.profiles where company_id is not null) then raise exception 'FAIL 1 reprise'; end if;
  raise notice 'PASS 1 reprise : % accès = % rattachements', n, n;

  -- 2. Changement de société refusé sur un document existant
  insert into public.companies (id, name, country) values (co2, 'Société test annulée', 'TN');
  begin update public.purchase_requests set company_id = co2 where id = inv; ok := false;
  exception when others then ok := true; get stacked diagnostics msg = message_text; end;
  if not ok then raise exception 'FAIL 2 changement de société accepté'; end if;
  if msg not like '%COMPANY_CHANGE_FORBIDDEN%' then raise exception 'FAIL 2 mauvais motif : %', msg; end if;
  raise notice 'PASS 2 changement de société refusé (%)', msg;

  -- 3. Mise à jour sans changement de société acceptée
  update public.purchase_requests set company_id = company_id where id = inv;
  raise notice 'PASS 3 mise à jour sans changement acceptée';

  -- 4. Accès : vrai pour la société rattachée, faux pour une autre
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select private.has_company_access(co) into ok;
  if not ok then raise exception 'FAIL 4a accès refusé à la société rattachée'; end if;
  select private.has_company_access(co2) into ok;
  if ok then raise exception 'FAIL 4b accès accordé à une société non rattachée'; end if;
  reset role;
  raise notice 'PASS 4 accès : société rattachée oui, autre non';

  -- 5. RLS : l'utilisateur ne voit que ses propres accès
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.user_company_access;
  reset role;
  if n <> 0 then raise exception 'FAIL 5 accès d''un autre utilisateur visible : %', n; end if;
  raise notice 'PASS 5 RLS : accès d''un autre utilisateur invisible';
end
$t$;
rollback;
