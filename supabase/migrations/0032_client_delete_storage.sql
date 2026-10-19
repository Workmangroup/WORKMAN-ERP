-- ---------------------------------------------------------------------
-- Suppression définitive d'un client : la liste des fichiers GED à retirer du Storage
-- est calculée ici (security definer), et non par une lecture préalable de l'API soumise à la RLS
-- de ged_document_versions. Un utilisateur avec clients.delete mais sans documents.read obtenait
-- une liste vide et laissait les fichiers orphelins.
-- Migration additive : remplace client_delete (grants inchangés), ne supprime aucune donnée.
-- ---------------------------------------------------------------------
create or replace function public.client_delete(p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.clients%rowtype; v_contacts int; v_addresses int; v_documents int; v_files jsonb;
begin
  perform private.require_perm('clients.delete');
  select * into v from public.clients where id = p_client and company_id = private.current_company();
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v.archived_at is null then raise exception 'CLIENT_NOT_ARCHIVED' using errcode = '55000'; end if;
  if exists (select 1 from public.profiles where client_id = p_client) then
    raise exception 'CLIENT_IN_USE' using errcode = '23503';
  end if;
  select count(*) into v_contacts  from public.client_contacts  where client_id = p_client;
  select count(*) into v_addresses from public.client_addresses where client_id = p_client;
  select count(*) into v_documents from public.ged_documents    where client_id = p_client;
  -- Fichiers lus avant la suppression en cascade : ils sont retirés du Storage par l'appelant.
  select coalesce(jsonb_agg(jsonb_build_object('bucket', storage_bucket, 'path', storage_path)), '[]'::jsonb)
    into v_files from public.ged_document_versions where client_id = p_client;

  perform set_config('clients.rpc', 'on', true);
  begin
    delete from public.clients where id = p_client;
  exception when foreign_key_violation then
    perform set_config('clients.rpc', 'off', true);
    raise exception 'CLIENT_IN_USE' using errcode = '23503';
  end;
  perform set_config('clients.rpc', 'off', true);

  perform private.write_audit(v.company_id, 'client.delete', 'client', v.id::text, v.name,
    to_jsonb(v) - array['company_id','created_at','updated_at','created_by','updated_by'], null,
    jsonb_build_object('contacts', v_contacts, 'addresses', v_addresses, 'documents', v_documents), 'rpc');
  return jsonb_build_object('contacts', v_contacts, 'addresses', v_addresses, 'documents', v_documents, 'files', v_files);
end $$;
