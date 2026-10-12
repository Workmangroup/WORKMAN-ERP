-- =====================================================================
-- 0024_copilot — MB Confection AI Copilot : historique des conversations et analyses ERP
--  Tables :
--    copilot_conversations : conversations d'un utilisateur (titre, dates) — visibles par leur auteur seul
--    copilot_messages      : messages (question, réponse) avec leur charge structurée (payload) — auteur seul
--  Analyses (fonctions, droits contrôlés par module) :
--    copilot_client_profit    : rentabilité client (CA TTC facturé, avoirs, encours, marge estimée, taux de couverture des coûts)
--    copilot_product_profit   : rentabilité article (quantité, CA HT, coût standard BOM, marge estimée)
--    copilot_purchase_suggestions   : achats à lancer (besoins MRP non commandés + sous stock de sécurité)
--    copilot_production_suggestions : ordres à lancer (demande client confirmée non couverte par les ordres et le stock fini)
--  L'interprétation des questions et la mise en forme des réponses sont faites côté application (moteur à règles, sans LLM).
--  Marge : estimation (coût standard BOM figé de la version validée ; sans coût figé, la ligne n'est pas valorisée et la couverture baisse).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission et rôles
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('copilot.use', 'copilot', 'Utiliser le copilote IA', 'Questions en langage naturel, analyses et historique personnel des conversations')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and p.code = 'copilot.use'
 where r.code in ('admin', 'direction', 'finance', 'production', 'qualite', 'commercial', 'achat', 'magasin')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Historique des conversations
-- ---------------------------------------------------------------------
create table public.copilot_conversations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  user_id     uuid not null default auth.uid(),
  title       text not null check (length(btrim(title)) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index copilot_conversations_user_idx on public.copilot_conversations (company_id, user_id, updated_at desc);

create table public.copilot_messages (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  conversation_id uuid not null references public.copilot_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (length(content) between 1 and 8000),
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index copilot_messages_conv_idx on public.copilot_messages (conversation_id, created_at);

alter table public.copilot_conversations enable row level security;
alter table public.copilot_messages enable row level security;
create policy copilot_conversations_own on public.copilot_conversations for all to authenticated
  using (company_id = private.current_company() and user_id = auth.uid() and private.has_perm('copilot.use'))
  with check (company_id = private.current_company() and user_id = auth.uid() and private.has_perm('copilot.use'));
create policy copilot_messages_own on public.copilot_messages for all to authenticated
  using (company_id = private.current_company() and private.has_perm('copilot.use')
         and exists (select 1 from public.copilot_conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  with check (company_id = private.current_company() and private.has_perm('copilot.use')
         and exists (select 1 from public.copilot_conversations c where c.id = conversation_id and c.user_id = auth.uid()));
revoke all on public.copilot_conversations, public.copilot_messages from anon;
grant select, insert, update, delete on public.copilot_conversations, public.copilot_messages to authenticated;

-- ---------------------------------------------------------------------
-- 3. Rentabilité client
-- ---------------------------------------------------------------------
create function public.copilot_client_profit(p_months int default 12)
returns table (client_id uuid, client_name text, invoiced numeric, credited numeric, net_revenue numeric, open_balance numeric,
               overdue_balance numeric, margin numeric, margin_pct numeric, cost_coverage_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
  v_from date := (date_trunc('month', current_date) - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))::date;
  v_cost boolean;
begin
  perform private.require_perm('invoices.read');
  v_cost := private.has_perm('costs.read');
  return query
  with inv as (
    select i.id, i.client_id, i.total, i.credited_amount from public.invoices i
     where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid') and i.issue_date >= v_from),
  acost as (
    select a.id as article_id, bc.snap_total as cost from public.articles a
      join public.bom_version_costs bc on bc.version_id = a.active_version_id where a.company_id = v_co),
  ln as (
    select inv.client_id,
           il.qty * il.unit_price * (1 - il.discount_pct / 100) as rev,
           il.qty * ac.cost as cst,
           (ac.cost is not null) as known
      from inv join public.invoice_lines il on il.invoice_id = inv.id
      left join public.sales_order_lines sl on sl.id = il.order_line_id
      left join acost ac on ac.article_id = sl.article_id),
  lagg as (
    select ln.client_id as cid, sum(ln.rev) as ra, sum(ln.rev) filter (where ln.known) as rk, sum(ln.cst) filter (where ln.known) as ck
      from ln group by ln.client_id),
  iagg as (
    select inv.client_id as cid, sum(inv.total) as invoiced, sum(inv.credited_amount) as credited from inv group by inv.client_id),
  bagg as (
    select i.client_id as cid, sum(i.total - i.credited_amount - i.paid_amount) as open_bal,
           sum(i.total - i.credited_amount - i.paid_amount) filter (where coalesce(i.due_date, i.issue_date) < current_date) as overdue_bal
      from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid') group by i.client_id)
  select c.id, c.name,
         coalesce(ia.invoiced, 0),
         coalesce(ia.credited, 0),
         coalesce(ia.invoiced, 0) - coalesce(ia.credited, 0),
         coalesce(ba.open_bal, 0),
         coalesce(ba.overdue_bal, 0),
         case when v_cost then coalesce(la.rk, 0) - coalesce(la.ck, 0) end,
         case when v_cost and coalesce(la.rk, 0) > 0 then round(100 * (la.rk - la.ck) / la.rk, 1) end,
         case when coalesce(la.ra, 0) > 0 then round(100 * coalesce(la.rk, 0) / la.ra, 1) end
    from public.clients c
    left join iagg ia on ia.cid = c.id
    left join lagg la on la.cid = c.id
    left join bagg ba on ba.cid = c.id
   where c.company_id = v_co and ia.cid is not null
   order by coalesce(ia.invoiced, 0) desc;
end $$;

-- ---------------------------------------------------------------------
-- 4. Rentabilité article
-- ---------------------------------------------------------------------
create function public.copilot_product_profit(p_months int default 12)
returns table (article_id uuid, article_ref text, article_name text, qty_sold numeric, revenue numeric, unit_cost numeric,
               margin numeric, margin_pct numeric, cost_coverage_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
  v_from date := (date_trunc('month', current_date) - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))::date;
  v_cost boolean;
begin
  perform private.require_perm('invoices.read');
  v_cost := private.has_perm('costs.read');
  return query
  with inv as (select i.id from public.invoices i where i.company_id = v_co and i.status in ('issued', 'partially_paid', 'paid') and i.issue_date >= v_from),
  acost as (
    select a.id as aid, bc.snap_total as cost from public.articles a
      join public.bom_version_costs bc on bc.version_id = a.active_version_id where a.company_id = v_co),
  ln as (
    select sl.article_id as aid, il.qty as q, il.qty * il.unit_price * (1 - il.discount_pct / 100) as rev,
           il.qty * ac.cost as cst, (ac.cost is not null) as known
      from inv join public.invoice_lines il on il.invoice_id = inv.id
      join public.sales_order_lines sl on sl.id = il.order_line_id
      left join acost ac on ac.aid = sl.article_id)
  select a.id, a.internal_ref, a.name,
         coalesce(sum(ln.q), 0),
         coalesce(sum(ln.rev), 0),
         case when v_cost and sum(ln.q) filter (where ln.known) > 0 then round(sum(ln.cst) filter (where ln.known) / sum(ln.q) filter (where ln.known), 2) end,
         case when v_cost then coalesce(sum(ln.rev) filter (where ln.known), 0) - coalesce(sum(ln.cst) filter (where ln.known), 0) end,
         case when v_cost and coalesce(sum(ln.rev) filter (where ln.known), 0) > 0 then
           round(100 * (sum(ln.rev) filter (where ln.known) - sum(ln.cst) filter (where ln.known)) / sum(ln.rev) filter (where ln.known), 1) end,
         case when coalesce(sum(ln.rev), 0) > 0 then round(100 * coalesce(sum(ln.rev) filter (where ln.known), 0) / sum(ln.rev), 1) end
    from ln
    join public.articles a on a.id = ln.aid
   group by a.id, a.internal_ref, a.name
   order by coalesce(sum(ln.rev), 0) desc;
end $$;

-- ---------------------------------------------------------------------
-- 5. Suggestions d'achat
-- ---------------------------------------------------------------------
create function public.copilot_purchase_suggestions()
returns table (kind text, material_id uuid, material_code text, material_name text, qty numeric, due_date date, reason text, severity text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_run uuid;
begin
  perform private.require_perm('purchases.read');
  select r.id into v_run from public.mrp_runs r where r.company_id = v_co order by r.created_at desc limit 1;
  return query
  select 'mrp'::text, s.material_id, m.code, m.name, s.qty, s.release_date,
         case when s.late then 'Besoin MRP : date de commande dépassée' else 'Besoin MRP à commander avant le ' || s.release_date end,
         case when s.late then 'critical' else 'warning' end
    from public.mrp_run_suggestions s
    join public.bom_materials m on m.id = s.material_id
   where v_run is not null and s.run_id = v_run and s.status = 'proposed' and private.has_perm('mrp.read');
  if private.has_perm('stock.read') then
    return query
    select 'safety'::text, t.material_id, m.code, m.name, sum(greatest(t.safety_qty - coalesce(oh.q, 0), 0)), null::date,
           'Stock sous le seuil de sécurité', 'warning'
      from public.stock_thresholds t
      join public.bom_materials m on m.id = t.material_id
      left join (select l.material_id, l.warehouse_id, sum(l.qty_remaining) q from public.stock_lots l
                  where l.company_id = v_co group by l.material_id, l.warehouse_id) oh
        on oh.material_id = t.material_id and oh.warehouse_id = t.warehouse_id
     where t.company_id = v_co
     group by t.material_id, m.code, m.name
    having sum(greatest(t.safety_qty - coalesce(oh.q, 0), 0)) > 0;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Suggestions de production
-- ---------------------------------------------------------------------
create function public.copilot_production_suggestions()
returns table (article_id uuid, article_ref text, article_name text, demand numeric, planned numeric, finished_stock numeric, gap numeric,
               earliest_due date, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company();
begin
  perform private.require_perm('production.read');
  return query
  with dem as (
    select sl.article_id as aid, sum(sl.qty) as q, min(sl.due_date) as due
      from public.sales_order_lines sl join public.sales_orders so on so.id = sl.order_id
     where sl.company_id = v_co and so.status = 'confirmed' group by sl.article_id),
  pla as (
    select po.article_id as aid, sum(po.qty_planned) as q from public.production_orders po
     where po.company_id = v_co and po.status in ('planned', 'launched', 'in_progress', 'suspended') group by po.article_id),
  stk as (
    select pm.article_id as aid, sum(vs.qty_on_hand - vs.qty_reserved)::numeric as q
      from public.product_master pm
      join public.product_variants pv on pv.product_id = pm.id
      join public.variant_stock vs on vs.variant_id = pv.id
     where pm.company_id = v_co and pm.article_id is not null group by pm.article_id)
  select a.id, a.internal_ref, a.name, d.q, coalesce(p.q, 0), coalesce(s.q, 0),
         d.q - coalesce(p.q, 0) - coalesce(s.q, 0), d.due,
         'Demande client confirmée non couverte par les ordres ni par le stock fini'
    from dem d
    join public.articles a on a.id = d.aid
    left join pla p on p.aid = d.aid
    left join stk s on s.aid = d.aid
   where d.q - coalesce(p.q, 0) - coalesce(s.q, 0) > 0
   order by d.due;
end $$;

-- ---------------------------------------------------------------------
-- 7. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.copilot_client_profit(int)',
    'public.copilot_product_profit(int)',
    'public.copilot_purchase_suggestions()',
    'public.copilot_production_suggestions()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
