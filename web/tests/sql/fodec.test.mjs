import { createDb, makeHelpers } from './_harness.mjs'

// Taux de 2 % et 4 % : valeurs DE TEST uniquement (saisies comme les autres paramètres signés). Aucun taux réel n'est codé.
const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const com = await mkUser('com@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const fin2 = await mkUser('fin2@x.com', 'finance')

// --- Chaîne de prix minimale (même schéma que pricing.test.mjs) ----------------------------------------------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1, 'EUR') on conflict (company_id) do nothing`, [company])
const base = (await q(`select base_currency from finance_settings where company_id=$1`, [company]))[0].base_currency
const listCur = base === 'TND' ? 'EUR' : 'TND'
const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client FODEC','TN','TND') returning id`)))[0].id
const prod = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste FODEC','jacket') returning id`, [cl])))[0].id
const jau = (await q(`select id from colors where code='JAU'`))[0].id
const sS = (await q(`select id from sizes where code='S'`))[0].id
const art = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'FOD-JAU-S') returning id`, [prod, jau, sS])))[0].id
const list = await as(com, () => rpc('price_list_create', 'DIR-FOD', 'Vente FODEC', listCur, 'direct'))
const item = await as(com, () => rpc('price_item_set', list, art, 10, '2026-01-01', null))
await as(fin, () => rpc('price_validate', 'list', list, true))
await as(com, () => rpc('client_price_assign', cl, list, '2026-01-01', null))
await as(fin, () => rpc('price_validate', 'item', item, true))
await as(fin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))
const fx = await as(fin, () => rpc('exchange_rate_set', '2026-01-15', listCur, 0.3, 'Taux de référence saisi (test)'))
await as(fin2, () => rpc('exchange_rate_validate', fx, true))

const snapshots = async () => Number((await q(`select count(*) n from price_snapshots`))[0].n)
const resolveFodec = (on, snap = false) => as(com, () => rpc('price_resolve_fodec', cl, art, 3, on, 0, snap))

// --- 1. Sans paramètre FODEC : aucun article confectionné n'est valorisé ----------------------------------------------------------
await rejects('FODEC absent : calcul refusé (aucun taux supposé)', () => resolveFodec('2026-02-01'), 'FODEC_NOT_CONFIGURED')
const s0 = await snapshots()
await rejects('FODEC absent, snapshot demandé : refus et aucun snapshot écrit', () => resolveFodec('2026-02-01', true), 'FODEC_NOT_CONFIGURED')
ok('aucun snapshot de prix écrit quand FODEC refuse', (await snapshots()) === s0)

// --- 2. Saisie et séparation des tâches ----------------------------------------------------------------------------------------------
await rejects('saisie FODEC réservée à la finance (commercial refusé)', () => as(com, () => rpc('fodec_set', 2, 'HT', '2026-01-01', null)), 'RBAC_FORBIDDEN')
const f1 = await as(fin, () => rpc('fodec_set', 2, 'HT', '2026-01-01', '2026-06-30'))
await rejects('FODEC saisi mais non signé : calcul refusé', () => resolveFodec('2026-02-01'), 'FODEC_NOT_VALIDATED')
await rejects('auto-signature FODEC refusée', () => as(fin, () => rpc('fodec_validate', f1, true)), 'SOD_SELF_APPROVAL')
await rejects('signature FODEC réservée à la finance (commercial refusé)', () => as(com, () => rpc('fodec_validate', f1, true)), 'RBAC_FORBIDDEN')
const fIncomplete = await as(fin, () => rpc('fodec_set', null, 'HT', '2026-07-01', '2026-07-31'))
await rejects('signature d’un FODEC sans taux refusée', () => as(fin2, () => rpc('fodec_validate', fIncomplete, true)), 'FODEC_INCOMPLETE')
await rejects('période de FODEC qui chevauche refusée', () => as(fin, () => rpc('fodec_set', 3, 'HT', '2026-06-15', null)), 'FODEC_PERIOD_OVERLAP')
await rejects('date d’effet obligatoire', () => as(fin, () => rpc('fodec_set', 2, 'HT', null, null)), 'FODEC_DATE_REQUIRED')

// --- 3. Signature par une autre personne : calcul possible, séparé du prix --------------------------------------------------------
await as(fin2, () => rpc('fodec_validate', f1, true))
ok('FODEC signé par une autre personne (statut valide)', (await q(`select status from fodec_parameters where id=$1`, [f1]))[0].status === 'valide')
await rejects('signature d’un FODEC déjà signé refusée', () => as(fin, () => rpc('fodec_validate', f1, true)), 'FODEC_BAD_STATUS')

const r1 = await resolveFodec('2026-02-01')
const plain = await as(com, () => rpc('price_resolve', cl, art, 3, '2026-02-01', 0, false))
ok('FODEC base HT : 2 % de 30,000 = 0,600 TND', Number(r1.fodec_amount) === 0.6 && r1.fodec_base === 'HT' && Number(r1.fodec_rate_pct) === 2, JSON.stringify(r1))
ok('total de prix inchangé par le FODEC (30 HT, 35,700 TTC)', Number(r1.line_amount) === Number(plain.line_amount) && Number(r1.total_amount) === Number(plain.total_amount))
await rejects('FODEC hors période : calcul refusé', () => resolveFodec('2025-12-31'), 'FODEC_NOT_CONFIGURED')

// --- 4. Nouvelle période : la base TTC et le taux suivant s'appliquent à la date ---------------------------------------------------
const f2 = await as(fin, () => rpc('fodec_set', 4, 'TTC', '2026-08-01', null))
await as(fin2, () => rpc('fodec_validate', f2, true))
const r2 = await resolveFodec('2026-08-01')
ok('FODEC base TTC à partir du 1er août : 4 % de 35,700 = 1,428', Number(r2.fodec_amount) === 1.428 && r2.fodec_base === 'TTC', JSON.stringify(r2))
const r3 = await resolveFodec('2026-06-30')
ok('à la date de fin de la 1re période : l’ancien paramètre (2 % HT) reste appliqué', Number(r3.fodec_rate_pct) === 2 && Number(r3.fodec_amount) === 0.6)
await rejects('ligne FODEC incomplète non signée : calcul refusé en juillet', () => resolveFodec('2026-07-15'), 'FODEC_NOT_VALIDATED')

// --- 5. Snapshot : figé avec le taux et la base utilisés -----------------------------------------------------------------------------
const before = await snapshots()
await resolveFodec('2026-08-01', true)
ok('snapshot de prix écrit quand FODEC est signé', (await snapshots()) === before + 1)

// --- 6. Lecture et écriture directes refusées --------------------------------------------------------------------------------------
await rejects('écriture directe de la table FODEC refusée', () => as(fin, () => q(`insert into fodec_parameters(rate_pct, base, effective_from, status) values (1,'HT','2030-01-01','valide')`)), 'permission denied')
ok('lecture FODEC accordée à la finance (les 3 lignes de test)', (await as(fin, () => q(`select count(*) n from fodec_parameters`)))[0].n === 3)
const nobody = await mkUser('nobody@x.com', null)
ok('lecture FODEC refusée sans droit (aucune ligne visible)', (await as(nobody, () => q(`select count(*) n from fodec_parameters`)))[0].n === 0)
