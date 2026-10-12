-- =====================================================================
-- 0023_executive — Dashboards exécutifs (DG) : CA, marge, stocks, production, achats, MRP, finance, qualité, expéditions
--  Une seule fonction (executive_dashboard) assemble les indicateurs ; les blocs des modules existants réutilisent
--  leur fonction de tableau de bord (production_dashboard, quality_dashboard, shipping_dashboard, finance_dashboard).
--  Droits :
--    dashboard.executive : accès à la vue DG (admin, direction) ;
--    chaque bloc n'est renvoyé que si l'utilisateur détient aussi le droit de lecture du module (sinon null) :
--    invoices.read (CA), costs.read + invoices.read (marge), stock.read, production.read, purchases.read,
--    mrp.read, finance.read, quality.read, shipments.read.
--  Alertes stratégiques : calculées dans la même fonction (règles documentées dans le corps).
--  Temps réel : la page interroge la fonction toutes les 30 secondes (pas d'abonnement temps réel en base).
--  Marge : estimation (CA − factures fournisseurs du même mois) ; le coût de revient par article n'est pas encore suivi.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('dashboard.executive', 'dashboard', 'Voir le tableau de bord DG', 'Vue exécutive multi-modules, indicateurs et alertes stratégiques')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin' and p.code = 'dashboard.executive')
  or (r.code = 'direction' and p.code = 'dashboard.executive'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Vue DG
-- ---------------------------------------------------------------------
create function public.executive_dashboard(p_months int default 12) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company();
  v_from date := (date_trunc('month', current_date) - make_interval(months => coalesce(p_months, 12) - 1))::date;
  v_month date := date_trunc('month', current_date)::date;
  v_prev date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_access jsonb := '{}'::jsonb;
  v_ca jsonb := null; v_marge jsonb := null; v_stocks jsonb := null; v_prod jsonb := null; v_achats jsonb := null;
  v_mrp jsonb := null; v_fin jsonb := null; v_qual jsonb := null; v_exp jsonb := null;
  v_cur numeric; v_prev_ca numeric; v_alerts jsonb := '[]'::jsonb;
  v_has_inv boolean := private.has_perm('invoices.read');
  v_has_cost boolean := private.has_perm('costs.read') and private.has_perm('invoices.read');
begin
  perform private.require_perm('dashboard.executive');
  if coalesce(p_months, 12) not between 3 and 24 then raise exception 'EXEC_BAD_PERIOD' using errcode = '22023'; end if;

  -- CA et marge (mois, tendance)
  if v_has_inv then
    select coalesce(sum(total) filter (where issue_date >= v_month), 0), coalesce(sum(total) filter (where issue_date >= v_prev and issue_date < v_month), 0)
      into v_cur, v_prev_ca
      from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid');
    v_ca := jsonb_build_object(
      'current_month', v_cur, 'previous_month', v_prev_ca,
      'ytd', (select coalesce(sum(total), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid')
              and issue_date >= date_trunc('year', current_date)::date),
      'open_balance', (select coalesce(sum(total - credited_amount - paid_amount), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid')),
      'series', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.mo, 'YYYY-MM'), 'amount', coalesce(r.amt, 0)) order by m.mo), '[]'::jsonb)
                 from generate_series(v_from::timestamp, v_month::timestamp, interval '1 month') m(mo)
                 left join (select date_trunc('month', issue_date)::timestamp mo, sum(total) amt from public.invoices
                            where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_from group by 1) r on r.mo = m.mo));
  end if;

  if v_has_cost then
    v_marge := jsonb_build_object(
      'estimate', 'CA − factures fournisseurs du même mois',
      'series', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.mo, 'YYYY-MM'), 'revenue', coalesce(r.amt, 0), 'cost', coalesce(c.amt, 0),
                   'margin', coalesce(r.amt, 0) - coalesce(c.amt, 0),
                   'rate_pct', case when coalesce(r.amt, 0) = 0 then null else round(100 * (coalesce(r.amt, 0) - coalesce(c.amt, 0)) / r.amt, 1) end) order by m.mo), '[]'::jsonb)
                 from generate_series(v_from::timestamp, v_month::timestamp, interval '1 month') m(mo)
                 left join (select date_trunc('month', issue_date)::timestamp mo, sum(total) amt from public.invoices
                            where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_from group by 1) r on r.mo = m.mo
                 left join (select date_trunc('month', invoice_date)::timestamp mo, sum(total) amt from public.supplier_invoices
                            where company_id = v_co and status <> 'cancelled' and invoice_date >= v_from group by 1) c on c.mo = m.mo),
      'current_month_rate_pct', (select case when coalesce(sum(total), 0) = 0 then null else round(100 * (
                 (select coalesce(sum(total), 0) from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_month)
                 - (select coalesce(sum(total), 0) from public.supplier_invoices where company_id = v_co and status <> 'cancelled' and invoice_date >= v_month))
                 / sum(total), 1) end from public.invoices where company_id = v_co and status in ('issued', 'partially_paid', 'paid') and issue_date >= v_month));
  end if;

  -- Stocks
  if private.has_perm('stock.read') then
    v_stocks := jsonb_build_object(
      'finished_units', (select coalesce(sum(qty_on_hand), 0) from public.variant_stock where company_id = v_co),
      'finished_reserved', (select coalesce(sum(qty_reserved), 0) from public.variant_stock where company_id = v_co),
      'finished_value', (select coalesce(sum(vs.qty_on_hand * coalesce(pv.price, 0)), 0) from public.variant_stock vs
                          join public.product_variants pv on pv.id = vs.variant_id where vs.company_id = v_co),
      'raw_materials_in_stock', (select count(distinct material_id) from public.stock_lots where company_id = v_co and qty_remaining > 0),
      'raw_lots_open', (select count(*) from public.stock_lots where company_id = v_co and qty_remaining > 0));
  end if;

  -- Production (réutilise production_dashboard)
  if private.has_perm('production.read') then
    v_prod := public.production_dashboard();
  end if;

  -- Achats
  if private.has_perm('purchases.read') then
    v_achats := jsonb_build_object(
      'open_orders', (select count(*) from public.purchase_orders where company_id = v_co and status in ('sent', 'partial')),
      'open_value', (select coalesce(sum(total_amount), 0) from public.purchase_orders where company_id = v_co and status in ('sent', 'partial')),
      'late_orders', (select count(*) from public.purchase_orders where company_id = v_co and status in ('sent', 'partial') and expected_date < current_date),
      'received_this_month', (select coalesce(sum(total_amount), 0) from public.purchase_orders where company_id = v_co and status = 'received' and received_date >= v_month));
  end if;

  -- MRP (dernier calcul)
  if private.has_perm('mrp.read') then
    v_mrp := (select jsonb_build_object('run', r.name, 'as_of', r.as_of, 'proposed', count(s.id) filter (where s.status = 'proposed'),
                 'late', count(s.id) filter (where s.status = 'proposed' and s.late))
              from (select * from public.mrp_runs where company_id = v_co order by created_at desc limit 1) r
              left join public.mrp_run_suggestions s on s.run_id = r.id
              group by r.id, r.name, r.as_of);
  end if;

  -- Finance, qualité, expéditions (réutilisent leurs fonctions)
  if private.has_perm('finance.read') then
    v_fin := public.finance_dashboard() || jsonb_build_object('forecast', (
      select coalesce(jsonb_agg(jsonb_build_object('week', week_no, 'start', week_start, 'balance', projected_balance, 'net', net) order by week_no), '[]'::jsonb)
      from public.treasury_forecast(current_date, 13, 100)));
  end if;
  if private.has_perm('quality.read') then v_qual := public.quality_dashboard(); end if;
  if private.has_perm('shipments.read') then v_exp := public.shipping_dashboard(); end if;

  v_access := jsonb_build_object('ca', v_has_inv, 'marge', v_has_cost, 'stocks', private.has_perm('stock.read'),
    'production', private.has_perm('production.read'), 'achats', private.has_perm('purchases.read'), 'mrp', private.has_perm('mrp.read'),
    'finance', private.has_perm('finance.read'), 'qualite', private.has_perm('quality.read'), 'expeditions', private.has_perm('shipments.read'));

  -- Alertes stratégiques (règles)
  if v_fin is not null then
    if coalesce((v_fin->'treasury'->>'balance')::numeric, 0) < 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'finance', 'title', 'Trésorerie négative',
        'detail', 'Le solde de trésorerie consolidé est négatif.', 'link', '/finance/tresorerie'));
    end if;
    if exists (select 1 from jsonb_array_elements(v_fin->'forecast') f where (f->>'balance')::numeric < 0) then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'finance', 'title', 'Point bas prévisionnel négatif',
        'detail', 'La prévision à 13 semaines passe sous zéro : anticiper un encaissement ou différer un règlement.', 'link', '/finance/previsions'));
    end if;
    if coalesce((v_fin->>'receivables')::numeric, 0) > 0 and coalesce((v_fin->>'receivables_overdue')::numeric, 0) / (v_fin->>'receivables')::numeric > 0.3 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'finance', 'title', 'Créances échues élevées',
        'detail', 'Plus de 30 % des créances clients sont échues.', 'link', '/finance/balances'));
    end if;
    if coalesce((v_fin->>'payables_disputed')::numeric, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'info', 'module', 'finance', 'title', 'Factures fournisseurs en litige',
        'detail', 'Des factures fournisseurs sont bloquées pour litige.', 'link', '/finance/fournisseurs'));
    end if;
  end if;
  if v_ca is not null and extract(day from current_date) >= 15 and v_prev_ca > 0 and v_cur < 0.6 * v_prev_ca then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'ca', 'title', 'CA en retard sur le mois précédent',
      'detail', 'Le CA du mois est inférieur à 60 % du mois précédent à mi-parcours.', 'link', '/commercial'));
  end if;
  if v_marge is not null and v_marge->>'current_month_rate_pct' is not null and (v_marge->>'current_month_rate_pct')::numeric < 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'marge', 'title', 'Marge négative ce mois-ci',
      'detail', 'Les achats fournisseurs du mois dépassent le CA facturé (estimation).', 'link', '/finance/fournisseurs'));
  end if;
  if v_prod is not null then
    if coalesce((v_prod->>'late')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'production', 'title', 'Ordres de fabrication en retard',
        'detail', (v_prod->>'late') || ' ordre(s) dépassent leur date de fin.', 'link', '/production/ordres'));
    end if;
    if exists (select 1 from jsonb_array_elements(v_prod->'workload') w where (w->>'overloaded')::boolean) then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'production', 'title', 'Poste de travail surchargé',
        'detail', 'Au moins un poste dépasse 20 jours de charge.', 'link', '/production/postes'));
    end if;
  end if;
  if v_qual is not null then
    if coalesce((v_qual->'nc_by_severity'->>'critical')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'qualite', 'title', 'Non-conformité critique ouverte',
        'detail', 'Une non-conformité critique attend son confinement ou sa clôture.', 'link', '/quality/non-conformites'));
    end if;
    if coalesce((v_qual->>'actions_overdue')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'qualite', 'title', 'Actions correctives en retard',
        'detail', (v_qual->>'actions_overdue') || ' action(s) ont dépassé leur échéance.', 'link', '/quality/plans'));
    end if;
  end if;
  if v_exp is not null then
    if coalesce((v_exp->>'late_open')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'critical', 'module', 'expeditions', 'title', 'Expéditions en retard',
        'detail', (v_exp->>'late_open') || ' expédition(s) ouvertes dépassent la date due.', 'link', '/shipments'));
    end if;
    if coalesce((v_exp->>'exceptions_open')::int, 0) > 0 then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'expeditions', 'title', 'Incidents de transport non résolus',
        'detail', (v_exp->>'exceptions_open') || ' expédition(s) signalées en incident.', 'link', '/shipments'));
    end if;
  end if;
  if v_mrp is not null and coalesce((v_mrp->>'late')::int, 0) > 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'warning', 'module', 'mrp', 'title', 'Commandes d’approvisionnement en retard',
      'detail', (v_mrp->>'late') || ' besoin(s) arrivent trop tard : la date de commande est dépassée.', 'link', '/mrp/runs'));
  end if;
  if v_stocks is not null and coalesce((v_stocks->>'finished_units')::numeric, 0) = 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('severity', 'info', 'module', 'stocks', 'title', 'Aucun produit fini en stock',
      'detail', 'Le stock de produits finis est vide.', 'link', '/variants/catalog'));
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'period_months', coalesce(p_months, 12),
    'access', v_access,
    'ca', v_ca, 'marge', v_marge, 'stocks', v_stocks, 'production', v_prod, 'achats', v_achats,
    'mrp', v_mrp, 'finance', v_fin, 'qualite', v_qual, 'expeditions', v_exp,
    'alerts', v_alerts);
end $$;

revoke execute on function public.executive_dashboard(int) from public, anon;
grant execute on function public.executive_dashboard(int) to authenticated;
