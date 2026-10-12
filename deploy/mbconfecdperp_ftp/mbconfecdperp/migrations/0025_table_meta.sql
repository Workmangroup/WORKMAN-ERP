-- =====================================================================
-- 0025_table_meta — Données de tableau : responsable (auteur) exposé sur la vue des ordres de fabrication.
--  Ajout en fin de liste de colonnes : la vue existante reste compatible (create or replace).
-- =====================================================================
create or replace view public.production_order_metrics with (security_invoker = true) as
with logs as (
  select order_id, sum(hours) hours, sum(qty_good) good, sum(qty_scrap) scrap, max(log_date) last_log
  from public.production_logs group by order_id
)
select o.id, o.company_id, o.number, o.status, o.article_id, a.internal_ref as article_ref, a.name as article_name,
       o.work_center_id, w.code as work_center_code, w.name as work_center_name, w.hours_per_day, w.efficiency_pct,
       o.qty_planned, o.std_minutes_per_unit, o.planned_start, o.planned_end, o.launched_at, o.finished_at, o.closed_at, o.sales_order_id,
       round(o.qty_planned * o.std_minutes_per_unit / 60, 2) as planned_hours,
       coalesce(l.hours, 0) as hours_worked,
       coalesce(l.good, 0) as qty_good,
       coalesce(l.scrap, 0) as qty_scrap,
       case when coalesce(l.good, 0) + coalesce(l.scrap, 0) = 0 then null
            else round(100 * l.good / (l.good + l.scrap), 1) end as yield_pct,
       case when coalesce(l.hours, 0) = 0 then null else round(l.good / l.hours, 2) end as productivity,
       case
         when o.status <> 'done' and o.planned_end < current_date then current_date - o.planned_end
         when o.status = 'done' and o.finished_at::date > o.planned_end then o.finished_at::date - o.planned_end
         else 0 end as late_days,
       o.created_by,
       o.launched_by
  from public.production_orders o
  join public.articles a on a.id = o.article_id
  left join public.work_centers w on w.id = o.work_center_id
  left join logs l on l.order_id = o.id;
grant select on public.production_order_metrics to authenticated;
