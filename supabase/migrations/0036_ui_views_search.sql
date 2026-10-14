-- =====================================================================
-- 0036_ui_views_search — Vues sauvegardées partagées par la base et recherche de fiches autorisée (P013)
--  saved_views   : filtres, tris et pagination nommés, par utilisateur et par table d'écran. Remplace le stockage
--                  navigateur (localStorage), qui ne suivait ni l'utilisateur ni l'appareil. Une personne ne voit que les siennes.
--  global_search : recherche de clients, fournisseurs et articles. Chaque type exige sa permission de lecture ;
--                  seule la société active est interrogée ; les fiches archivées sont exclues quand elles ont un archivage.
--  Aucune donnée n'est créée. Les filtres ne contiennent que des paramètres d'affichage (pas de données métier).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vues sauvegardées
-- ---------------------------------------------------------------------
create table public.saved_views (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  user_id     uuid not null default auth.uid() references public.profiles(id),
  table_id    text not null check (table_id ~ '^[a-z0-9_.-]{2,80}$'),
  name        text not null check (length(btrim(name)) between 2 and 60),
  state       jsonb not null check (jsonb_typeof(state) = 'object' and pg_column_size(state) <= 4096),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, table_id, name)
);
create trigger saved_views_set_updated_at before update on public.saved_views
  for each row execute function private.set_updated_at();
alter table public.saved_views enable row level security;
create policy saved_views_own on public.saved_views for all to authenticated
  using (user_id = auth.uid() and company_id = private.current_company())
  with check (user_id = auth.uid() and company_id = private.current_company());
revoke all on public.saved_views from anon, authenticated;
grant select, insert, update, delete on public.saved_views to authenticated;
grant all on public.saved_views to service_role;

-- ---------------------------------------------------------------------
-- 2. Recherche de fiches autorisée
-- ---------------------------------------------------------------------
create function public.global_search(p_query text, p_limit int default 20)
returns table (kind text, id uuid, label text, sublabel text, href text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_q text := btrim(coalesce(p_query, '')); v_pat text;
  v_lim int := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if v_co is null or length(v_q) < 2 then return; end if;
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select s.kind, s.id, s.label, s.sublabel, s.href from (
      (select 'client'::text as kind, c.id, c.name::text as label, c.code::text as sublabel, ('/clients/' || c.id::text) as href
         from public.clients c
        where c.company_id = v_co and private.has_perm('clients.read') and c.archived_at is null
          and (c.name ilike v_pat or c.code ilike v_pat or c.legal_name ilike v_pat or c.tax_id ilike v_pat)
        order by c.name limit v_lim)
      union all
      (select 'supplier'::text, sp.id, sp.name::text, sp.code::text, ('/suppliers/' || sp.id::text)
         from public.suppliers sp
        where sp.company_id = v_co and private.has_perm('suppliers.read') and sp.archived_at is null
          and (sp.name ilike v_pat or sp.code ilike v_pat or sp.legal_name ilike v_pat)
        order by sp.name limit v_lim)
      union all
      (select 'article'::text, a.id, a.name::text, a.internal_ref::text, ('/articles/' || a.id::text)
         from public.articles a
        where a.company_id = v_co and private.has_perm('articles.read')
          and (a.name ilike v_pat or a.internal_ref ilike v_pat or a.client_ref ilike v_pat)
        order by a.name limit v_lim)
    ) s
    limit v_lim;
end $$;
grant execute on function public.global_search(text, int) to authenticated, service_role;
