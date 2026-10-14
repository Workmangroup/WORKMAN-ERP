import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0088_fx_versions_revaluation.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
/** Contexte utilisateur pour les déclencheurs, sans changer de rôle (utile pour les fixtures et les mises à jour directes). */
const asSuper = async (uid, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid })}', false);`)
  try { return await fn() } finally { await db.exec(`select set_config('request.jwt.claims', '', false);`) }
}

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@mc.com', 'admin')
const fin = await mkUser('fin@mc.com', 'finance')
const dir = await mkUser('dir@mc.com', 'direction')
const fin2 = await mkUser('fin2@x.com', 'finance')
// Règlement fournisseur : seul chemin possible = ordre préparé, approuvé par un autre, exécuté par un autre que le préparateur
const payOrder = async (supplier, amount, reason, paidOn = null) => {
  const o = await as(fin, () => rpc('payment_order_prepare', supplier, amount, reason))
  await as(dir, () => rpc('payment_order_decide', o.id, true, 'OK'))
  return as(fin2, () => rpc('payment_order_execute', o.id, paidOn))
}
const nobody = await mkUser('nobody@mc.com', null)

const d = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }

// --- 1. Référentiels ---------------------------------------------------------------------------------------------------------------------
ok('devises : EUR, TND, USD, GBP', (await q(`select code from currencies order by code`)).map((r) => r.code).join(',') === 'EUR,GBP,TND,USD')
ok('TND : 3 décimales', (await q(`select minor_units from currencies where code='TND'`))[0].minor_units === 3)
ok('TVA : taux standard 19 % et export 0 %', (await q(`select count(*)::int n from vat_rates where (code='TN_STD_19' and rate=19) or (code='EXPORT_0' and rate=0)`))[0].n === 2)
ok('sans réglage : devise de base EUR, taux 1', Number(await as(fin, async () => (await q(`select public.fx_rate('EUR', current_date) r`))[0].r)) === 1)

// --- 2. Taux de change : absence, saisie, droits, validation ------------------------------------------------------------------------------
await rejects('TND sans aucun taux : refusé', () => as(fin, () => q(`select public.fx_rate('TND', current_date)`)), 'FX_RATE_MISSING')
await rejects('saisie sans droit finance : refusée', () => as(nobody, () => rpc('fx_rate_set', d(0), 'TND', 0.33)), 'RBAC_FORBIDDEN')
await rejects('direction (lecture seule) : saisie refusée', () => as(dir, () => rpc('fx_rate_set', d(0), 'TND', 0.33)), 'RBAC_FORBIDDEN')
await rejects('devise de base : pas de taux à saisir', () => as(fin, () => rpc('fx_rate_set', d(0), 'EUR', 1)), 'FX_CURRENCY_IS_BASE')
await rejects('devise inconnue : refusée', () => as(fin, () => rpc('fx_rate_set', d(0), 'JPY', 150)), 'FX_CURRENCY_UNKNOWN')
await rejects('taux négatif : refusé', () => as(fin, () => rpc('fx_rate_set', d(0), 'TND', -1)), 'FX_RATE_INVALID')
await rejects('date future de plus d’un jour : refusée', () => as(fin, () => rpc('fx_rate_set', d(5), 'TND', 0.33)), 'FX_DATE_INVALID')

await as(fin, () => rpc('fx_rate_set', d(-30), 'TND', 0.30))
await as(fin, () => rpc('fx_rate_set', d(-10), 'TND', 0.31))
await as(fin, () => rpc('fx_rate_set', d(0), 'TND', 0.33))
await as(fin, () => rpc('fx_rate_set', d(-30), 'USD', 0.90))
await as(fin, () => rpc('fx_rate_set', d(-5), 'USD', 0.93))
await as(fin, () => rpc('fx_rate_set', d(0), 'USD', 0.95))

const rateAt = (cur, date) => as(fin, async () => Number((await q(`select public.fx_rate($1, $2) r`, [cur, date]))[0].r))
ok('taux du jour : TND = 0,33', (await rateAt('TND', d(0))) === 0.33)
ok('taux d’une date passée : 0,30 avant le 2e relevé', (await rateAt('TND', d(-20))) === 0.30)
ok('taux le plus récent avant la date : 0,31', (await rateAt('TND', d(-5))) === 0.31)
await rejects('avant le premier relevé : taux manquant', () => as(fin, () => q(`select public.fx_rate('TND', $1)`, [d(-60)])), 'FX_RATE_MISSING')

await as(fin, () => rpc('fx_rate_set', d(0), 'TND', 0.34))
ok('même jour : nouvelle version, la dernière saisie fait foi, l’ancienne est conservée', (await rateAt('TND', d(0))) === 0.34 && (await q(`select count(*)::int n from exchange_rates where currency='TND' and rate_date=$1`, [d(0)]))[0].n === 2)
await as(fin, () => rpc('fx_rate_set', d(0), 'TND', 0.33))

ok('conversion : 1 000,555 TND = 330,18 EUR (arrondi 2 décimales)', Number((await as(fin, () => q(`select public.fx_convert(1000.555, 'TND', $1) r`, [d(0)])))[0].r) === 330.18)

// --- 3. Factures : taux figé à l'émission -----------------------------------------------------------------------------------------------------
const c1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-FR','LAFONT','FR') returning id`, [company]))[0].id
const s1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-TN','Tissus Sfax','TN') returning id`, [company]))[0].id
// Les autres déclencheurs de facturation réinitialisent les montants et le numéro des brouillons : ils sont désactivés
// pour les fixtures. Seul le déclencheur de figement des taux reste actif au moment de l'émission.
await db.exec('alter table invoices disable trigger user')
const newInvoice = async (currency, total, tax, rate) => (await q(
  `insert into invoices(company_id, client_id, status, currency, tax_rate, subtotal, tax_amount, total) values ($1,$2,'draft',$3,$4,$5,$6,$7) returning id`,
  [company, c1, currency, rate, total - tax, tax, total]))[0].id
const usdInv = await newInvoice('USD', 1000, 0, 0)
const eurInv = await newInvoice('EUR', 1000, 190, 19)
const lateUsd = await newInvoice('USD', 500, 0, 0)
await db.exec('alter table invoices enable trigger invoices_fx_snapshot_u')
const issue = (id, code, date) => asSuper(admin, () => db.query(`update invoices set status='issued', code=$2, issue_date=$3, due_date=$3 where id=$1`, [id, code, date]))

await issue(usdInv, 'FAC-USD-1', d(-30))
const usd = (await q(`select fx_rate, base_total from invoices where id=$1`, [usdInv]))[0]
ok('facture USD émise : taux du jour d’émission figé (0,90)', Number(usd.fx_rate) === 0.9)
ok('facture USD : équivalent EUR figé (900,00)', Number(usd.base_total) === 900)
await rejects('facture USD émise sans taux à la date : refusée', () => asSuper(admin, () => db.query(`update invoices set status='issued', issue_date=$2 where id=$1`, [lateUsd, d(-200)])), 'FX_RATE_MISSING')
await issue(eurInv, 'FAC-EUR-1', d(-10))
ok('facture EUR : taux 1, équivalent = montant', Number((await q(`select fx_rate, base_total from invoices where id=$1`, [eurInv]))[0].base_total) === 1000)

// Facture USD déjà émise : un règlement partiel, à un taux différent (écart réalisé attendu).
await asSuper(admin, () => db.query(`insert into invoice_payments(company_id, invoice_id, amount, paid_on) values ($1,$2,400,$3)`, [company, usdInv, d(-1)]))
await asSuper(admin, () => db.query(`update invoices set paid_amount = 400, status='partially_paid' where id=$1`, [usdInv]))

// --- 4. Fournisseurs en TND ------------------------------------------------------------------------------------------------------------------
const tf1 = await as(fin, () => rpc('supplier_invoice_record', s1, 'TF-1', d(-30), d(-20), 600, 'TND', null))
const sf1 = (await q(`select fx_rate, base_total, currency from supplier_invoices where id=$1`, [tf1]))[0]
ok('facture TND : taux du jour de la facture (0,30), 600 TND = 180,00 EUR', Number(sf1.fx_rate) === 0.3 && Number(sf1.base_total) === 180)
await rejects('facture TND à une date sans taux : refusée', () => as(fin, () => rpc('supplier_invoice_record', s1, 'TF-OLD', d(-200), d(-190), 100, 'TND', null)), 'FX_RATE_MISSING')

// --- 5. Verrou de la devise de base ----------------------------------------------------------------------------------------------------------
await rejects('changement de devise de base : refusé quand des factures ont un taux figé', () => as(fin, () => rpc('finance_set_base_currency', 'USD')), 'FX_BASE_LOCKED')

// --- 6. Écarts latents au jour J ---------------------------------------------------------------------------------------------------------------
const pos = await as(fin, () => q(`select kind, number, currency, open_amount, base_booked, base_today, unrealized from fx_open_positions(current_date) order by number`))
const fTf = pos.find((p) => p.kind === 'payable')
const fUsd = pos.find((p) => p.number === 'FAC-USD-1')
ok('dette TND latente : 600 TND, 180,00 € au taux figé, 198,00 € au jour J', fTf && Number(fTf.base_booked) === 180 && Number(fTf.base_today) === 198)
ok('dette qui augmente : perte latente de 18,00 €', fTf && Number(fTf.unrealized) === -18)
ok('créance USD latente : 600 USD ouverts, plus-value de change', fUsd && Number(fUsd.open_amount) === 600 && Number(fUsd.unrealized) > 0)
ok('créance USD : gain latent = 600 × (0,95 − 0,90) = 30,00 €', fUsd && Number(fUsd.unrealized) === 30)
ok('factures EUR absentes des écarts', !pos.some((p) => p.number === 'FAC-EUR-1'))

// --- 7. Écarts réalisés au règlement -----------------------------------------------------------------------------------------------------------
const real = await as(fin, () => q(`select kind, number, realized from fx_realized_gains(current_date - 60, current_date)`))
const rUsd = real.find((r) => r.number === 'FAC-USD-1')
ok('règlement client USD : 400 × (0,93 − 0,90) = 12,00 € de gain réalisé', rUsd && Number(rUsd.realized) === 12 && rUsd.kind === 'receivable')

await payOrder(s1, 300, 'Règlement fournisseur MC', d(-1))
const real2 = await as(fin, () => q(`select kind, number, realized from fx_realized_gains(current_date - 60, current_date)`))
const rTf = real2.find((r) => r.kind === 'payable')
ok('règlement fournisseur TND : 300 × (0,30 − 0,31) = −3,00 € de perte réalisée', rTf && Number(rTf.realized) === -3 && rTf.kind === 'payable')

// --- 8. Fiscalité export et TVA -----------------------------------------------------------------------------------------------------------------
ok('client FR, société TN : traitement export', (await as(fin, () => q(`select public.fiscal_treatment($1) t`, [c1])))[0].t === 'export')
const ctrl = await as(fin, () => q(`select code, issues from export_controls(current_date - 60, current_date)`))
const cUsd = ctrl.find((c) => c.code === 'FAC-USD-1')
const cEur = ctrl.find((c) => c.code === 'FAC-EUR-1')
ok('export sans BL : preuve d’exportation manquante signalée', cUsd && cUsd.issues.some((x) => x.startsWith('Preuve')))
ok('export avec TVA facturée : anomalie signalée', cEur && cEur.issues.some((x) => x.startsWith('TVA facturée')))
const vat = await as(fin, () => q(`select tax_rate, label, invoices_count, base_ht, base_tva, base_ttc from vat_summary(current_date - 60, current_date) order by tax_rate`))
const v19 = vat.find((v) => Number(v.tax_rate) === 19)
const v0 = vat.find((v) => Number(v.tax_rate) === 0)
ok('TVA 19 % : base HT 810,00 et TVA 190,00 € (TTC 1 000,00)', v19 && Number(v19.base_ht) === 810 && Number(v19.base_tva) === 190 && Number(v19.base_ttc) === 1000)
ok('TVA 0 % : TTC converti en EUR (900,00)', v0 && Number(v0.base_ttc) === 900)
ok('TVA : libellé du taux renseigné', v19 && v19.label === 'TVA normale 19 %')
await rejects('TVA réservée à la finance : refusée', () => as(nobody, () => q(`select * from vat_summary(current_date - 60, current_date)`)), 'RBAC_FORBIDDEN')

// --- 9. Reporting multi-devise -----------------------------------------------------------------------------------------------------------------
const rep = await as(fin, () => q(`select currency, invoiced_foreign, invoiced_base, payable_open_foreign, receivable_open_foreign, realized_gain, unrealized_gain from multicurrency_report(current_date - 60, current_date, current_date) order by currency`))
const rUsdRep = rep.find((r) => r.currency === 'USD')
const rTndRep = rep.find((r) => r.currency === 'TND')
ok('reporting : CA USD facturé 1 000 USD (900 € au cours d’émission)', rUsdRep && Number(rUsdRep.invoiced_foreign) === 1000 && Number(rUsdRep.invoiced_base) === 900)
ok('reporting : dettes TND ouvertes présentes', rTndRep && Number(rTndRep.payable_open_foreign) === 300)
ok('reporting : écart réalisé TND et USD agrégés par devise', rTndRep && Number(rTndRep.realized_gain) === -3 && rUsdRep && Number(rUsdRep.realized_gain) === 12)
await rejects('reporting : refusé sans droit', () => as(nobody, () => q(`select * from multicurrency_report(current_date - 60, current_date, current_date)`)), 'RBAC_FORBIDDEN')

// --- 10. Isolation -------------------------------------------------------------------------------------------------------------------------------
ok('sans rôle : aucun taux visible', (await as(nobody, () => q(`select count(*)::int n from exchange_rates`)))[0].n === 0)
ok('finance : taux visibles', (await as(fin, () => q(`select count(*)::int n from exchange_rates`)))[0].n >= 5)

console.log(process.exitCode ? '\nÉCHEC' : '\nOK')
