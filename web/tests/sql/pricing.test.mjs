import { createDb, makeHelpers } from './_harness.mjs'

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
const com = await mkUser('com@x.com', 'commercial')      // saisit tarifs et remises
const fin = await mkUser('fin@x.com', 'finance')         // signe : tarifs, TVA, change
const fin2 = await mkUser('fin2@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)

// --- Paramètres de départ -----------------------------------------------------------------------------------------------------------
// Fixture de test : la devise de base de la société est posée ici (en production, elle vient de 0027 et doit être confirmée par la finance)
await db.query(`insert into finance_settings(company_id, base_currency) values ($1, 'EUR') on conflict (company_id) do nothing`, [company])
const base = (await q(`select base_currency from finance_settings where company_id=$1`, [company]))[0].base_currency
const listCur = base === 'TND' ? 'EUR' : 'TND'
ok('devise de base lue dans les réglages de la société (pas supposée)', !!base, base)

const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client tarif','TN','TND') returning id`)))[0].id
const prod = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste tarif','jacket') returning id`, [cl])))[0].id
const jau = (await q(`select id from colors where code='JAU'`))[0].id
const sS = (await q(`select id from sizes where code='S'`))[0].id
const art = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'TAR-JAU-S') returning id`, [prod, jau, sS])))[0].id

// --- 1. Tarif : saisie, signature par la finance, séparation des tâches -------------------------------------------------------------
const list = await as(com, () => rpc('price_list_create', 'DIR-TN', 'Vente directe Tunisie', listCur, 'direct'))
await rejects('tarif non signé : calcul refusé', () => as(com, () => rpc('price_resolve', cl, art, 1, '2026-06-01', 0, false)), 'PRICE_NO_LIST')
const i1 = await as(com, () => rpc('price_item_set', list, art, 10, '2026-01-01', '2026-05-31'))
const i2 = await as(com, () => rpc('price_item_set', list, art, 10.5, '2026-06-01', null))
await rejects('chevauchement de périodes refusé', () => as(com, () => rpc('price_item_set', list, art, 11, '2026-05-01', '2026-05-15')), 'PRICE_PERIOD_OVERLAP')
await rejects('validation du tarif réservée à la finance (commercial refusé)', () => as(com, () => rpc('price_validate', 'list', list, true)), 'RBAC_FORBIDDEN')
const listAdm = await as(admin, () => rpc('price_list_create', 'ADM-TN', 'Liste test séparation', listCur, 'other'))
await rejects('auto-validation du tarif refusée (même personne saisit et signe)', () => as(admin, () => rpc('price_validate', 'list', listAdm, true)), 'SOD_SELF_APPROVAL')
await as(fin, () => rpc('price_validate', 'list', list, true))
await as(com, () => rpc('client_price_assign', cl, list, '2026-01-01', null))
await rejects('tarif de liste non signé : refus (article non signé)', () => as(com, () => rpc('price_resolve', cl, art, 1, '2026-02-01', 0, false)), 'PRICE_NOT_VALIDATED')
await as(fin, () => rpc('price_validate', 'item', i1, true))
await as(fin, () => rpc('price_validate', 'item', i2, true))
await rejects('article déjà signé : seconde signature refusée', () => as(fin2, () => rpc('price_validate', 'item', i1, true)), 'PRICE_BAD_STATUS')
await rejects('pas de tarif sans liste de la période : refus', () => as(com, () => rpc('price_resolve', cl, art, 1, '2025-12-31', 0, false)), 'PRICE_NO_LIST')

// --- 2. TVA : seuls les taux signés servent au calcul -------------------------------------------------------------------------------
await rejects('TVA non signée : calcul refusé (aucun taux supposé)', () => as(com, () => rpc('price_resolve', cl, art, 1, '2026-02-01', 0, false)), 'VAT_RATE_NOT_VALIDATED')
await as(fin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))
ok('taux de TVA signé par la finance', (await q(`select status from vat_rates where code='TN_STD_19'`))[0].status === 'valide')
await rejects('taux de TVA : signature réservée à la finance (commercial refusé)', () => as(com, () => q(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`)), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('vat_rate_create', 'TN_TEST_SEP', 'Taux test séparation', 5, 'reduced', 'TN', '2030-01-01', null))
await rejects('taux de TVA : auto-signature refusée', () => as(admin, () => q(`select public.vat_rate_validate('TN_TEST_SEP', date '2030-01-01', true)`)), 'SOD_SELF_APPROVAL')

// --- 3. Change : source obligatoire, signature distincte ----------------------------------------------------------------------------
await rejects('change sans source refusé', () => as(fin, () => rpc('exchange_rate_set', '2026-01-15', listCur, 0.3, 'x')), 'FX_SOURCE_REQUIRED')
const fx1 = await as(fin, () => rpc('exchange_rate_set', '2026-01-15', listCur, 0.3, 'Taux de référence saisi (test)'))
await rejects('change : auto-signature refusée', () => as(fin, () => rpc('exchange_rate_validate', fx1, true)), 'SOD_SELF_APPROVAL')
await rejects('change non signé : calcul refusé', () => as(com, () => rpc('price_resolve', cl, art, 1, '2026-02-01', 0, false)), 'FX_RATE_MISSING')
await as(fin2, () => rpc('exchange_rate_validate', fx1, true))

// --- 4. Calcul exact, arrondi, montants devise et fonctionnel --------------------------------------------------------------------------
const r1 = await as(com, () => rpc('price_resolve', cl, art, 3, '2026-02-01', 0, false))
ok('calcul : 3 × 10,000 = 30,000 TND HT', Number(r1.line_amount) === 30 && r1.currency === listCur)
ok('calcul : TVA lue dans les taux signés (19 %) : 5,700', Number(r1.vat_rate) === 19 && Number(r1.tax_amount) === 5.7)
ok('calcul : TTC = 35,700', Number(r1.total_amount) === 35.7)
ok('calcul : montant fonctionnel = HT × taux signé, arrondi à la décimale de la devise de base', Number(r1.functional_amount) === Number((30 * 0.3).toFixed(2)), JSON.stringify(r1))
ok('calcul : montant devise et montant fonctionnel conservés séparément', r1.currency !== r1.functional_currency && Number(r1.line_amount) !== Number(r1.functional_amount))

// Remise : bornée par la règle signée
await rejects('remise sans règle refusée', () => as(com, () => rpc('price_resolve', cl, art, 3, '2026-02-01', 5, false)), 'DISCOUNT_NOT_ALLOWED')
const d1 = await as(com, () => rpc('client_discount_set', cl, 5, '2026-01-01', null))
await rejects('remise : signature réservée à la finance (commercial refusé)', () => as(com, () => rpc('price_validate', 'discount', d1, true)), 'RBAC_FORBIDDEN')
const cl2 = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client séparation','TN','TND') returning id`)))[0].id
const dAdm = await as(admin, () => rpc('client_discount_set', cl2, 1, '2026-01-01', null))
await rejects('remise : auto-signature refusée', () => as(admin, () => rpc('price_validate', 'discount', dAdm, true)), 'SOD_SELF_APPROVAL')
await as(fin, () => rpc('price_validate', 'discount', d1, true))
await rejects('remise au-delà de la limite signée refusée', () => as(com, () => rpc('price_resolve', cl, art, 3, '2026-02-01', 10, false)), 'DISCOUNT_ABOVE_LIMIT')
const r2 = await as(com, () => rpc('price_resolve', cl, art, 3, '2026-02-01', 5, false))
ok('remise 5 % : prix net 9,5000 et ligne 28,500', Number(r2.unit_net) === 9.5 && Number(r2.line_amount) === 28.5 && Number(r2.tax_amount) === 5.415)

// Arrondi : quantité décimale, arrondi à 3 décimales (TND), demi vers l'extérieur
const r3 = await as(com, () => rpc('price_resolve', cl, art, 1.3333, '2026-02-01', 5, false))
ok('arrondi : 1,3333 × 9,5 = 12,666 TND (3 décimales)', Number(r3.line_amount) === 12.666 && Number(r3.tax_amount) === 2.407, JSON.stringify([r3.line_amount, r3.tax_amount]))

// --- 5. Date d'effet : le tarif et le taux du jour sont appliqués ----------------------------------------------------------------------
const r4a = await as(com, () => rpc('price_resolve', cl, art, 1, '2026-05-31', 0, false))
const r4b = await as(com, () => rpc('price_resolve', cl, art, 1, '2026-06-01', 0, false))
ok('date d’effet : avant le 1er juin, ancien tarif 10,000', Number(r4a.unit_price) === 10)
ok('date d’effet : à partir du 1er juin, nouveau tarif 10,500', Number(r4b.unit_price) === 10.5)
await rejects('aucun tarif avant la période couverte', () => as(com, () => rpc('price_resolve', cl, art, 1, '2025-12-31', 0, false)), 'PRICE_NO_LIST')
const fxOld = await as(fin, () => rpc('exchange_rate_set', '2026-03-01', listCur, 0.5, 'Taux de mars (test)'))
await as(fin2, () => rpc('exchange_rate_validate', fxOld, true))
const r5 = await as(com, () => rpc('price_resolve', cl, art, 1, '2026-04-15', 0, false))
ok('taux de change : dernier taux signé à la date (mars 0,5, pas janvier 0,3)', Number(r5.fx_rate) === 0.5)
await rejects('taux de change : date antérieure à tout taux signé refusée', () => as(com, () => rpc('price_resolve', cl, art, 1, '2026-01-05', 0, false)), 'FX_RATE_MISSING')

// --- 6. Snapshot immuable -------------------------------------------------------------------------------------------------------------
const snap = await as(com, () => rpc('price_resolve', cl, art, 2, '2026-06-01', 0, true))
ok('snapshot créé avec sa référence', !!snap.snapshot)
await rejects('snapshot immuable', () => db.query(`update price_snapshots set qty = 9 where id = $1`, [snap.snapshot]), 'PRICE_SNAPSHOT_IMMUTABLE')
ok('snapshot journalisé (pricing.snapshot)', (await q(`select count(*)::int n from audit_logs where action='pricing.snapshot'`))[0].n === 1)

// --- 7. Droits -------------------------------------------------------------------------------------------------------------------------------
await rejects('calcul refusé sans droit de lecture des tarifs', () => as(nobody, () => rpc('price_resolve', cl, art, 1, '2026-06-01', 0, false)), 'RBAC_FORBIDDEN')
await rejects('saisie de tarif refusée à la finance (pricing.manage)', () => as(fin, () => rpc('price_item_set', list, art, 1, '2027-01-01', null)), 'RBAC_FORBIDDEN')
await rejects('genre de signature inconnu refusé', () => as(fin, () => rpc('price_validate', 'autre', i1, true)), 'PRICE_BAD_KIND')
ok('audit : signatures et rejets tracés (finance.price_approve)', (await q(`select count(*)::int n from audit_logs where action='finance.price_approve'`))[0].n >= 2)
