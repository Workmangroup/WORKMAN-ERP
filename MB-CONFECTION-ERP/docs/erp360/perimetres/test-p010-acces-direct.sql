-- P010 : accès par identifiant direct et paramètres falsifiés. Transaction annulée (aucune donnée conservée).
begin;
do $t$
declare
  adm uuid := (select id from public.profiles where email = 'admin@mbconfection.com');
  vic uuid := (select id from public.profiles where email = 'norole.test@mbconfection.local');
  co1 uuid := (select company_id from public.profiles where id = adm);
  co2 uuid := gen_random_uuid();
  c2 uuid; n int; ok boolean; msg text;
  wh_a uuid := (select id from public.warehouses where code = 'WH-03');
  wh_b uuid := (select id from public.warehouses where code = 'WH-04');
  mag uuid := (select id from public.roles where code = 'magasin' limit 1);
begin
  -- Préparation (rôle propriétaire) : un second locataire avec un client
  insert into public.companies (id, name, country) values (co2, 'Locataire test annulé', 'TN');
  insert into public.clients (company_id, code, name, country) values (co2, 'CLI-TEST-X', 'Client autre locataire', 'FR')
    returning id into c2;

  -- A. Identifiant direct d'un autre locataire
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.clients where id = c2;
  if n <> 0 then raise exception 'FAIL A1 lecture directe inter-locataires : %', n; end if;
  update public.clients set name = 'piratage' where id = c2;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL A2 modification inter-locataires : %', n; end if;
  begin perform public.client_archive(c2, 'test'); ok := false;
  exception when others then ok := sqlerrm like '%NOT_FOUND%'; msg := sqlerrm; end;
  if not ok then raise exception 'FAIL A3 archivage inter-locataires accepté'; end if;
  reset role;
  raise notice 'PASS A inter-locataires : lecture 0, modification 0, archivage refusé (%)', msg;

  -- B. Utilisateur de magasin limité à l'entrepôt WH-03 : stock d'un autre entrepôt
  insert into public.user_roles (user_id, role_id) values (vic, mag);
  insert into public.user_warehouses (company_id, user_id, warehouse_id, role) values (co1, vic, wh_a, 'operator');
  perform set_config('request.jwt.claims', json_build_object('sub', vic, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.stock_overview where warehouse_id = wh_a;
  if n = 0 then raise exception 'FAIL B0 : l''entrepôt autorisé n''est pas visible'; end if;
  raise notice 'INFO B0 entrepôt autorisé : % ligne(s) de stock visibles', n;
  select count(*) into n from public.stock_overview where warehouse_id = wh_b;
  if n <> 0 then raise exception 'FAIL B1 stock d''un autre entrepôt visible par ID : %', n; end if;
  select count(*) into n from public.warehouses where id = wh_b;
  raise notice 'INFO B2 entrepôt non autorisé visible par ID dans warehouses : % (attendu 0)', n;
  reset role;
  raise notice 'PASS B1 : stock de l''entrepôt non autorisé invisible par identifiant direct';
end
$t$;
rollback;
