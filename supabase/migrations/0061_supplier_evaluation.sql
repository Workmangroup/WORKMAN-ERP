-- 0061 — Évaluation fournisseur et délais (P036) : ponctualité, défauts, écart prix, réactivité, documents ; alertes ; brouillons de réapprovisionnement
-- Additive. Réutilise : réceptions et commandes (0011 : dates, quantités, prix), confirmations fournisseur (0059 : sent_at, confirmed_at),
-- contrôles qualité à la réception (0020 : quality_inspections.purchase_receipt_id, sample_size, quality_defects), prix matière (0008),
-- propositions MRP (0010 : mrp_run_suggestions, avec request_id 0011), demandes d'achat (0011, brouillon).
-- Règles :
--  * Chaque indicateur est une fraction explicite (numérateur / dénominateur) avec sa formule renvoyée. Aucun poids ni seuil n'est inventé :
--    sans politique (supplier_score_policies), le score composite n'est pas calculé et le motif est indiqué.
--  * Retard CONFIRMÉ = réception effective après la date prévue de la commande. PRÉVISION = commande ouverte dont la date prévue est dépassée sans réception
--    (non confirmé). Les deux ne sont jamais additionnés.
--  * Échantillon faible signalé (moins de réceptions que le seuil de la politique, ou aucune donnée).
--  * Aucune commande ferme autonome : le réapprovisionnement crée une demande d'achat en BROUILLON, à soumettre et approuver par des humains.
--  * Chaque évaluation est conservée (historique append-only).

-- ---------------------------------------------------------------------
-- 1. Politique d'évaluation (paramètres explicites, saisis par la société)
-- ---------------------------------------------------------------------
create table public.supplier_score_policies (
  company_id          uuid primary key default private.current_company() references public.companies(id) on delete cascade,
  w_ontime            int check (w_ontime between 0 and 100),
  w_defects           int check (w_defects between 0 and 100),
  w_price             int check (w_price between 0 and 100),
  w_reactivity        int check (w_reactivity between 0 and 100),
  w_documents         int check (w_documents between 0 and 100),
  min_sample          int not null check (min_sample >= 1),
  target_confirm_days int check (target_confirm_days is null or target_confirm_days between 0 and 365),
  price_alert_pct     numeric(6,2) check (price_alert_pct is null or price_alert_pct >= 0),
  set_by              uuid default auth.uid(),
  set_at              timestamptz not null default now(),
  check (w_ontime is null or w_defects is null or w_price is null or w_reactivity is null or w_documents is null
         or w_ontime + w_defects + w_price + w_reactivity + w_documents = 100)
);
alter table public.supplier_score_policies enable row level security;
create policy supplier_score_policies_select on public.supplier_score_policies for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.supplier_score_policies from public, anon, authenticated;
grant select on public.supplier_score_policies to authenticated;

-- Saisie : pondérations (toutes renseignées ou toutes absentes), seuil d'échantillon, délai cible, seuil d'alerte prix.
create function public.supplier_policy_set(p_w_ontime int, p_w_defects int, p_w_price int, p_w_reactivity int, p_w_documents int,
                                           p_min_sample int, p_target_days int, p_price_alert numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_w int[] := array[p_w_ontime, p_w_defects, p_w_price, p_w_reactivity, p_w_documents];
begin
  perform private.require_perm('approvals.manage');
  if p_min_sample is null or p_min_sample < 1 then raise exception 'EVAL_POLICY_INVALID' using errcode = '22023', detail = 'seuil d''échantillon'; end if;
  if (select count(*) from unnest(v_w) x where x is null) not in (0, 5) then raise exception 'EVAL_POLICY_INVALID' using errcode = '22023', detail = 'pondérations partielles'; end if;
  if p_w_ontime is not null and (p_w_ontime + p_w_defects + p_w_price + p_w_reactivity + p_w_documents) <> 100 then
    raise exception 'EVAL_POLICY_INVALID' using errcode = '22023', detail = 'pondérations à 100';
  end if;
  insert into public.supplier_score_policies (company_id, w_ontime, w_defects, w_price, w_reactivity, w_documents, min_sample, target_confirm_days, price_alert_pct, set_by, set_at)
  values (v_co, p_w_ontime, p_w_defects, p_w_price, p_w_reactivity, p_w_documents, p_min_sample, p_target_days, p_price_alert, auth.uid(), now())
  on conflict (company_id) do update set w_ontime = excluded.w_ontime, w_defects = excluded.w_defects, w_price = excluded.w_price,
    w_reactivity = excluded.w_reactivity, w_documents = excluded.w_documents, min_sample = excluded.min_sample,
    target_confirm_days = excluded.target_confirm_days, price_alert_pct = excluded.price_alert_pct, set_by = excluded.set_by, set_at = now();
  perform private.write_audit(v_co, 'eval.policy_set', 'company', v_co::text, 'politique d''évaluation fournisseur', null,
    jsonb_build_object('weights', v_w, 'min_sample', p_min_sample, 'target_days', p_target_days, 'price_alert_pct', p_price_alert), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.supplier_policy_set(int, int, int, int, int, int, int, numeric) from public, anon;
grant execute on function public.supplier_policy_set(int, int, int, int, int, int, int, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Évaluations conservées (append-only)
-- ---------------------------------------------------------------------
create table public.supplier_evaluations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  supplier_id  uuid not null references public.suppliers(id),
  period_from  date not null,
  period_to    date not null,
  result       jsonb not null check (jsonb_typeof(result) = 'object'),
  computed_at  timestamptz not null default now(),
  computed_by  uuid default auth.uid(),
  check (period_to >= period_from)
);
create index supplier_evaluations_idx on public.supplier_evaluations (supplier_id, computed_at desc);
alter table public.supplier_evaluations enable row level security;
create policy supplier_evaluations_select on public.supplier_evaluations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('purchases.read'));
revoke all on public.supplier_evaluations from public, anon, authenticated;
grant select on public.supplier_evaluations to authenticated;
create function private.supplier_evaluations_append_only() returns trigger
language plpgsql set search_path = '' as $$ begin raise exception 'EVAL_APPEND_ONLY' using errcode = '42501'; end $$;
create trigger supplier_evaluations_ao before update or delete on public.supplier_evaluations
  for each row execute function private.supplier_evaluations_append_only();

-- ---------------------------------------------------------------------
-- 3. Calcul des indicateurs (fonction de calcul seule, sans contrôle de droit ni écriture)
-- ---------------------------------------------------------------------
create function private.supplier_indicators(p_supplier uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); p public.supplier_score_policies%rowtype; v_has_policy boolean;
        v_rc int := 0; v_rc_on int := 0; v_rc_doc int := 0; v_conf int := 0; v_conf_days numeric; v_conf_in numeric := 0; v_open_late int := 0; v_open_qty numeric := 0;
        v_sample numeric := 0; v_defq numeric := 0; v_crit int := 0; v_insp int := 0;
        v_pl_qty numeric := 0; v_pl_sum numeric := 0; v_pl_ref numeric := 0; v_pl_missing int := 0;
        v_ontime numeric; v_defect numeric; v_price numeric; v_react numeric; v_docs numeric; v_missing text[] := '{}';
        v_parts jsonb := '{}'::jsonb; v_comp numeric; v_wsum int; v_flags text[] := '{}'; v_pct numeric;
begin
  select * into p from public.supplier_score_policies where company_id = v_co;
  v_has_policy := found and p.w_ontime is not null;
  -- Réceptions de la période et ponctualité (réception effective vs date prévue de la commande)
  select count(*), count(*) filter (where po.expected_date is not null and rc.received_at::date <= po.expected_date),
         count(*) filter (where rc.delivery_note is not null)
    into v_rc, v_rc_on, v_rc_doc
    from public.purchase_receipts rc join public.purchase_orders po on po.id = rc.po_id
   where rc.company_id = v_co and rc.supplier_id = p_supplier and rc.received_at::date between p_from and p_to and po.expected_date is not null;
  -- Contrôles à la réception et défauts
  select count(distinct i.id), coalesce(sum(i.sample_size), 0), coalesce(sum(d.qty), 0), count(d.id) filter (where d.severity = 'critical')
    into v_insp, v_sample, v_defq, v_crit
    from public.quality_inspections i
    join public.purchase_receipts rc on rc.id = i.purchase_receipt_id
    left join public.quality_defects d on d.inspection_id = i.id
   where i.company_id = v_co and i.kind = 'reception' and rc.supplier_id = p_supplier and rc.received_at::date between p_from and p_to;
  -- Écart de prix : prix de commande des quantités reçues vs prix catalogue actuel (lignes sans prix catalogue exclues et comptées)
  select coalesce(sum(rl.qty), 0), coalesce(sum(rl.qty * (rl.unit_price - bp.unit_cost)) filter (where bp.unit_cost is not null), 0),
         coalesce(sum(rl.qty * bp.unit_cost) filter (where bp.unit_cost is not null), 0), count(*) filter (where bp.unit_cost is null)
    into v_pl_qty, v_pl_sum, v_pl_ref, v_pl_missing
    from public.purchase_receipt_lines rl
    join public.purchase_receipts rc on rc.id = rl.receipt_id
    left join public.bom_material_prices bp on bp.material_id = rl.material_id
   where rc.company_id = v_co and rc.supplier_id = p_supplier and rc.received_at::date between p_from and p_to;
  -- Réactivité : confirmation fournisseur (P034) de commandes envoyées ; délai entre envoi et confirmation
  select count(*), coalesce(avg(c.confirmed_on - o.sent_at::date), 0),
         count(*) filter (where pol.target_confirm_days is not null and (c.confirmed_on - o.sent_at::date) <= pol.target_confirm_days)
    into v_conf, v_conf_days, v_conf_in
    from public.purchase_order_confirmations c
    join public.purchase_orders o on o.id = c.po_id
    left join public.supplier_score_policies pol on pol.company_id = v_co
   where o.company_id = v_co and o.supplier_id = p_supplier and c.confirmed_on between p_from and p_to and o.sent_at is not null;
  -- Prévision (non confirmée) : commandes ouvertes dont la date prévue est dépassée sans réception
  select count(distinct o.id), coalesce(sum(l.qty_ordered - l.qty_received), 0)
    into v_open_late, v_open_qty
    from public.purchase_orders o join public.purchase_order_lines l on l.po_id = o.id
   where o.company_id = v_co and o.supplier_id = p_supplier and o.status in ('sent', 'partial') and o.expected_date < current_date and l.qty_ordered > l.qty_received;

  -- Indicateurs : fraction explicite ou null (sans donnée)
  v_ontime := case when v_rc > 0 then 100.0 * v_rc_on / v_rc end;
  v_defect := case when v_sample > 0 then 100.0 * v_defq / v_sample end;
  v_pct := case when v_pl_ref > 0 then 100.0 * v_pl_sum / v_pl_ref end;
  v_price := case when v_pct is not null then 100 * (1 - least(1, greatest(0, v_pct) / 100)) end;
  v_react := case when v_conf > 0 and p.target_confirm_days is not null then 100.0 * v_conf_in / v_conf end;
  v_docs := case when (v_rc + v_conf) > 0 then 100.0 * (v_rc_doc + v_conf) / (v_rc + v_conf) end;

  -- Signalements : échantillon, absence de politique, données manquantes
  if v_rc = 0 then v_flags := array_append(v_flags, 'AUCUNE_RECEPTION_PERIODE'); end if;
  if v_has_policy and v_rc < p.min_sample then v_flags := array_append(v_flags, 'ECHANTILLON_FAIBLE'); end if;
  if v_rc > 0 and not v_has_policy then v_flags := array_append(v_flags, 'POLITIQUE_NON_PARAMETREE'); end if;
  if v_pl_missing > 0 then v_flags := array_append(v_flags, 'PRIX_CATALOGUE_MANQUANT'); end if;
  if v_crit > 0 then v_flags := array_append(v_flags, 'DEFAUT_CRITIQUE'); end if;
  if v_pct is not null and p.price_alert_pct is not null and v_pct > p.price_alert_pct then v_flags := array_append(v_flags, 'ECART_PRIX_AU_DELA_SEUIL'); end if;
  if v_open_late > 0 then v_flags := array_append(v_flags, 'PREVISION_RETARD'); end if;

  -- Score composite : uniquement si politique complète et tous les indicateurs disposent de données
  if v_has_policy and v_rc > 0 then
    if v_ontime is null then v_missing := array_append(v_missing, 'ponctualité'); end if;
    if v_defect is null then v_missing := array_append(v_missing, 'défauts (aucun contrôle)'); end if;
    if v_price is null then v_missing := array_append(v_missing, 'prix (catalogue)'); end if;
    if v_react is null then v_missing := array_append(v_missing, 'réactivité (délai cible ou confirmations)'); end if;
    if v_docs is null then v_missing := array_append(v_missing, 'documents'); end if;
    if cardinality(v_missing) = 0 then
      v_comp := (p.w_ontime * v_ontime + p.w_defects * (100 - least(100, v_defect)) + p.w_price * v_price + p.w_reactivity * v_react + p.w_documents * v_docs) / 100;
      v_wsum := p.w_ontime + p.w_defects + p.w_price + p.w_reactivity + p.w_documents;
    end if;
  end if;
  return jsonb_build_object(
    'data_points', jsonb_build_object('receipts', v_rc, 'receipts_with_due_date', v_rc, 'inspections', v_insp, 'defect_sample_qty', v_sample,
                                      'price_lines_qty', v_pl_qty, 'price_lines_without_catalogue', v_pl_missing, 'confirmations', v_conf, 'open_late_orders', v_open_late),
    'indicators', jsonb_build_object(
      'ponctualite', jsonb_build_object('value', round(v_ontime, 2), 'numerator', v_rc_on, 'denominator', v_rc,
                                        'formula', 'réceptions effectuées à la date prévue ou avant / réceptions de la période'),
      'defauts', jsonb_build_object('value', round(v_defect, 2), 'numerator', v_defq, 'denominator', v_sample,
                                    'critical', v_crit, 'formula', 'quantité défectueuse / quantité contrôlée (contrôles à la réception)'),
      'ecart_prix', jsonb_build_object('value', round(v_pct, 2), 'numerator', round(v_pl_sum, 2), 'denominator', round(v_pl_ref, 2),
                                       'formula', 'Σ quantité × (prix commande − prix catalogue) / Σ quantité × prix catalogue, en %'),
      'reactivite', jsonb_build_object('value', round(v_react, 2), 'average_days', round(v_conf_days, 2), 'confirmations', v_conf,
                                       'within_target', v_conf_in, 'target_days', p.target_confirm_days,
                                       'formula', 'confirmations reçues dans le délai cible / confirmations de la période'),
      'documents', jsonb_build_object('value', round(v_docs, 2), 'numerator', v_rc_doc + v_conf, 'denominator', v_rc + v_conf,
                                      'formula', '(réceptions avec bon de livraison + confirmations avec référence) / (réceptions + confirmations)')),
    'confirmed_late', jsonb_build_object('receipts_after_due_date', v_rc - v_rc_on, 'formula', 'réceptions effectives après la date prévue (retard confirmé)'),
    'forecast_late', jsonb_build_object('open_orders_past_due', v_open_late, 'open_qty', v_open_qty,
                                        'formula', 'commandes ouvertes dont la date prévue est dépassée sans réception (prévision, non confirmée)'),
    'composite', case when v_comp is null then null else jsonb_build_object('score', round(v_comp, 2), 'weights_sum', v_wsum,
                                                                            'weights', jsonb_build_object('ponctualite', p.w_ontime, 'defauts', p.w_defects, 'prix', p.w_price, 'reactivite', p.w_reactivity, 'documents', p.w_documents),
                                                                            'formula', 'Σ poids × (ponctualité ; 100 − défauts ; 100 × (1 − écart prix / 100) ; réactivité ; documents) / 100') end,
    'composite_missing', case when not v_has_policy then to_jsonb(array['politique d''évaluation non paramétrée'])
                              when v_rc = 0 then to_jsonb(array['aucune réception sur la période'])
                              when cardinality(v_missing) > 0 then to_jsonb(v_missing)
                              else null end,
    'flags', to_jsonb(v_flags)
  );
end $$;
revoke execute on function private.supplier_indicators(uuid, date, date) from public, anon, authenticated;

-- Lecture (purchases.read) : calcul sans enregistrement
create function public.supplier_evaluate_preview(p_supplier uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_perm('purchases.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'EVAL_PERIOD_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.suppliers where id = p_supplier and company_id = private.current_company()) then raise exception 'PURCHASE_BAD_SUPPLIER' using errcode = '22023'; end if;
  return private.supplier_indicators(p_supplier, p_from, p_to);
end $$;
grant execute on function public.supplier_evaluate_preview(uuid, date, date) to authenticated, service_role;

-- Enregistrement d'une évaluation (historique conservé)
create function public.supplier_evaluate(p_supplier uuid, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_res jsonb; v_id uuid;
begin
  perform private.require_perm('purchases.write');
  v_res := public.supplier_evaluate_preview(p_supplier, p_from, p_to);
  insert into public.supplier_evaluations (company_id, supplier_id, period_from, period_to, result, computed_by)
  values (private.current_company(), p_supplier, p_from, p_to, v_res, auth.uid()) returning id into v_id;
  perform private.write_audit(private.current_company(), 'eval.supplier', 'supplier', p_supplier::text, p_from || ' → ' || p_to, null,
    jsonb_build_object('composite', v_res -> 'composite' ->> 'score', 'flags', v_res -> 'flags'), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function public.supplier_evaluate(uuid, date, date) from public, anon;
grant execute on function public.supplier_evaluate(uuid, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Réapprovisionnement : brouillon de demande d'achat à partir des propositions MRP du fournisseur (jamais une commande ferme)
-- ---------------------------------------------------------------------
create function public.supplier_reorder_draft(p_supplier uuid, p_run uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_n int := 0; s record; v_code text;
begin
  perform private.require_perm('purchases.write');
  if not exists (select 1 from public.suppliers where id = p_supplier and company_id = v_co and archived_at is null) then raise exception 'PURCHASE_BAD_SUPPLIER' using errcode = '22023'; end if;
  if not exists (select 1 from public.mrp_run_suggestions where run_id = p_run and company_id = v_co and supplier_id = p_supplier and status = 'proposed' and request_id is null) then
    raise exception 'EVAL_NO_SUGGESTION' using errcode = '55000';
  end if;
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_requests (id, company_id, needed_date, reason, requested_by, status, source)
  values (v_id, v_co, (select min(need_date) from public.mrp_run_suggestions where run_id = p_run and supplier_id = p_supplier and status = 'proposed'),
          'Brouillon de réapprovisionnement (évaluation fournisseur) : à valider par un humain', auth.uid(), 'draft', 'manual')
  returning code into v_code;
  for s in select * from public.mrp_run_suggestions where run_id = p_run and company_id = v_co and supplier_id = p_supplier and status = 'proposed' and request_id is null loop
    insert into public.purchase_request_lines (company_id, request_id, material_id, qty, supplier_id, needed_date, note)
    values (v_co, v_id, s.material_id, s.qty, p_supplier, s.need_date, 'Proposition MRP (brouillon)');
    update public.mrp_run_suggestions set request_id = v_id where id = s.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'eval.reorder_draft', 'purchase', v_id::text, v_code, null, jsonb_build_object('lines', v_n, 'supplier', p_supplier), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function public.supplier_reorder_draft(uuid, uuid) from public, anon;
grant execute on function public.supplier_reorder_draft(uuid, uuid) to authenticated, service_role;
