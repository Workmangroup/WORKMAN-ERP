import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql'])
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
const fin = await mkUser('fin@x.com', 'finance')
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('comm@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

// --- 0. Permissions --------------------------------------------------------------------------------------------------------------------
ok('finance : lecture et écriture', (await perms('finance')).includes('finance.write') && (await perms('finance')).includes('finance.read'))
ok('direction : lecture seule', (await perms('direction')).includes('finance.read') && !(await perms('direction')).includes('finance.write'))

// --- 1. Fixtures ------------------------------------------------------------------------------------------------------------------------
const d = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const c1 = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const c2 = (await as(admin, () => q(`insert into clients(name, country) values ('Bragard','FR') returning id`)))[0].id
const s1 = (await as(admin, () => q(`insert into suppliers(name, country) values ('Tissus Sfax','TN') returning id`)))[0].id
const s2 = (await as(admin, () => q(`insert into suppliers(name, country) values ('Accessoires Nord','TN') returning id`)))[0].id
const mkInv = (client, code, issue, due, total) => db.query(`insert into invoices(company_id, client_id, code, status, issue_date, due_date, total, subtotal, tax_amount) values ($1,$2,$3,'issued',$4,$5,$6,$6,0) returning id`, [company, client, code, issue, due, total]).then((r) => r.rows[0].id)
// Factures émises directement : déclencheurs de facturation désactivés le temps du fixture (statut et total fixés ici)
await db.exec('alter table invoices disable trigger all')
const i1 = await mkInv(c1, 'FAC-T-1', d(-60), d(-45), 1000)
const i2 = await mkInv(c1, 'FAC-T-2', d(-20), d(-5), 500)
const i3 = await mkInv(c1, 'FAC-T-3', d(-5), d(10), 300)
const i4 = await mkInv(c2, 'FAC-T-4', d(-120), d(-100), 800)
await db.exec('alter table invoices enable trigger all')

// --- 2. Factures fournisseurs -----------------------------------------------------------------------------------------------------------
const f1 = await as(fin, () => rpc('supplier_invoice_record', s1, 'FT-1', d(-40), d(-30), 600, 'EUR', null))
const f2 = await as(fin, () => rpc('supplier_invoice_record', s1, 'FT-2', d(-10), d(5), 400, 'EUR', null))
const f3 = await as(fin, () => rpc('supplier_invoice_record', s2, 'AC-9', d(-5), d(20), 200, 'EUR', null))
ok('facture fournisseur : numéro FF-AAAA-000001', /^FF-\d{4}-000001$/.test((await q(`select number from supplier_invoices where id=$1`, [f1]))[0].number))
await rejects('même référence fournisseur : doublon refusé', () => as(fin, () => rpc('supplier_invoice_record', s1, 'FT-1', d(-1), d(5), 10, 'EUR', null)), 'supplier_invoices_company_id_supplier_id_supplier_ref_key')
await rejects('échéance avant la date de facture refusée', () => as(fin, () => rpc('supplier_invoice_record', s1, 'FT-X', d(0), d(-1), 10, 'EUR', null)), 'check constraint')
await rejects('saisie fournisseur réservée à finance.write', () => as(dir, () => rpc('supplier_invoice_record', s1, 'FT-Y', d(0), d(5), 10, 'EUR', null)), 'RBAC_FORBIDDEN')
await rejects('litige : motif trop court refusé', () => as(fin, () => rpc('supplier_invoice_dispute', f3, 'x')), 'FINANCE_REASON_REQUIRED')
await as(fin, () => rpc('supplier_invoice_dispute', f3, 'Pièces non livrées'))
ok('litige : facture AC-9 non payable', (await q(`select status from supplier_invoices where id=$1`, [f3]))[0].status === 'disputed')

const fin2 = await mkUser('fin2@x.com', 'finance')
// Règlement fournisseur : seul chemin = ordre préparé, approuvé par un autre, exécuté par un autre que le préparateur
const payOrder = async (supplier, amount, reason) => {
  const o = await as(fin, () => rpc('payment_order_prepare', supplier, amount, reason))
  await as(dir, () => rpc('payment_order_decide', o.id, true, 'OK'))
  const r = await as(fin2, () => rpc('payment_order_execute', o.id, null))
  return { ...r, order: o.id }
}

// --- 3. Règlements fournisseurs : affectation FIFO -----------------------------------------------------------------------------------------
await rejects('règlement supérieur au solde ouvert refusé (à la préparation de l’ordre)', () => as(fin, () => rpc('payment_order_prepare', s1, 1100, 'Trop')), 'FINANCE_OVERPAYMENT')
await rejects('paiement direct fournisseur refusé : ordre approuvé obligatoire', () => as(fin, () => rpc('supplier_payment_record', s1, 10, d(0), 'transfer', null)), 'PAYMENT_REQUIRES_APPROVED_ORDER')
const p1 = await payOrder(s1, 700, 'Règlement 700 FT-1/FT-2')
ok('règlement de 700 : deux factures touchées, la plus ancienne payée en premier', p1.allocated_invoices === 2 && (await q(`select status from supplier_invoices where id=$1`, [f1]))[0].status === 'paid')
ok('reste dû sur FT-2 : 300, statut partiellement payée', (await q(`select status, paid_amount from supplier_invoices where id=$1`, [f2]))[0].status === 'partially_paid' && Number((await q(`select paid_amount from supplier_invoices where id=$1`, [f2]))[0].paid_amount) === 100)
await rejects('facture en litige non réglable : solde nul pour Accessoires Nord', () => as(fin, () => rpc('payment_order_prepare', s2, 50, 'Litige')), 'FINANCE_OVERPAYMENT')
await as(fin, () => rpc('supplier_invoice_resolve', f3))
ok('litige résolu : facture de nouveau payable', (await q(`select status from supplier_invoices where id=$1`, [f3]))[0].status === 'open')
await rejects('résolution d’une facture non litigieuse refusée', () => as(fin, () => rpc('supplier_invoice_resolve', f2)), 'FINANCE_BAD_STATUS')
await payOrder(s2, 100, 'Règlement AC-9 partiel')
const oSelf = await as(fin, () => rpc('payment_order_prepare', s2, 1, 'Auto-exécution'))
await as(dir, () => rpc('payment_order_decide', oSelf.id, true, 'OK'))
await rejects('exécution par le préparateur refusée (séparation des tâches)', () => as(fin, () => rpc('payment_order_execute', oSelf.id, null)), 'SOD_SELF_APPROVAL')
await rejects('exécution sans droit payments.execute refusée', () => as(comm, () => rpc('payment_order_execute', oSelf.id, null)), 'RBAC_FORBIDDEN')
await rejects('ordre déjà exécuté : second règlement refusé', () => as(fin2, () => rpc('payment_order_execute', p1.order, null)), 'PAYMENT_ORDER_BAD_STATUS')
await rejects('journal des affectations immuable', () => db.query(`update supplier_payment_allocations set amount = 1`), 'FINANCE_IMMUTABLE')

// --- 4. Encaissements clients : FIFO ------------------------------------------------------------------------------------------------------------
await rejects('encaissement supérieur au solde client refusé', () => as(fin, () => rpc('customer_receipt_record', c1, 1900, d(0), 'transfer', null)), 'FINANCE_OVERPAYMENT')
const r1 = await as(fin, () => rpc('customer_receipt_record', c1, 1200, d(0), 'transfer', 'ENC-1'))
ok('encaissement de 1 200 : I1 soldée, I2 partiellement', r1.allocated_invoices === 2 && (await q(`select status from invoices where id=$1`, [i1]))[0].status === 'paid' && (await q(`select status from invoices where id=$1`, [i2]))[0].status === 'partially_paid')
ok('encaissements visibles par facture (journal)', (await as(fin, () => q(`select count(*)::int n from finance_receipts where client_id=$1`, [c1])))[0].n === 2)
await rejects('encaissement client sans droit payments.write refusé', () => as(dir, () => rpc('customer_receipt_record', c1, 10, d(0), 'transfer', null)), 'RBAC_FORBIDDEN')

// --- 5. Balances âgées ----------------------------------------------------------------------------------------------------------------------
const ag = await as(fin, () => q(`select * from finance_aging_clients(current_date)`))
const agC1 = ag.find((r) => r.cli_name === 'LAFONT')
const agC2 = ag.find((r) => r.cli_name === 'Bragard')
ok('balance âgée clients : LAFONT à échoir 300, 1-30 jours 300, total 600', Number(agC1.cur) === 300 && Number(agC1.d1_30) === 300 && Number(agC1.total) === 600)
ok('balance âgée clients : Bragard plus de 90 jours 800', Number(agC2.d90_plus) === 800 && Number(agC2.total) === 800)
const sg = await as(fin, () => q(`select * from finance_aging_suppliers(current_date)`))
const sgS1 = sg.find((r) => r.sup_name === 'Tissus Sfax')
ok('balance âgée fournisseurs : Tissus Sfax à échoir 300', Number(sgS1.cur) === 300 && Number(sgS1.total) === 300)
await rejects('balance âgée fournisseurs réservée à finance.read', () => as(nobody, () => q(`select * from finance_aging_suppliers(current_date)`)), 'RBAC_FORBIDDEN')

// --- 6. Relances automatiques ----------------------------------------------------------------------------------------------------------------
const n1 = await as(fin, () => rpc('finance_generate_reminders'))
ok('relances : une par facture échue encore due (I2 niveau 1, I4 niveau 3)', n1 === 2)
ok('relances : niveau selon le retard (I4 = 100 jours → niveau 3)', (await q(`select level from finance_reminders where invoice_id=$1`, [i4]))[0].level === 3)
const n2 = await as(fin, () => rpc('finance_generate_reminders'))
ok('relances : relancer ne crée pas de doublon', n2 === 0)
const rem4 = (await q(`select id from finance_reminders where invoice_id=$1`, [i4]))[0].id
await as(fin, () => rpc('finance_reminder_mark_sent', rem4))
await rejects('relance déjà envoyée : nouvel envoi refusé', () => as(fin, () => rpc('finance_reminder_mark_sent', rem4)), 'FINANCE_BAD_STATUS')

// --- 7. Trésorerie ---------------------------------------------------------------------------------------------------------------------------
const acc = await as(fin, () => rpc('cash_account_create', 'Banque BIAT', 5000, d(-100)))
await rejects('mouvement antérieur à l’ouverture du compte refusé', () => as(fin, () => rpc('cash_movement_add', acc, 'in', 10, d(-200), 'Test')), 'FINANCE_BEFORE_OPENING')
await as(fin, () => rpc('cash_movement_add', acc, 'in', 200, d(0), 'Remboursement assurance'))
await as(fin, () => rpc('cash_movement_add', acc, 'out', 50, d(0), 'Frais bancaires'))
const pos = await as(fin, () => rpc('treasury_position'))
ok('trésorerie : 5 000 + 1 200 encaissés − 800 réglés + 200 − 50 = 5 550', Number(pos.balance) === 5550 && Number(pos.receipts) === 1200 && Number(pos.payments) === 800)

// --- 8. Prévisions de trésorerie ----------------------------------------------------------------------------------------------------------------
const fc = await as(fin, () => q(`select * from treasury_forecast(current_date, 4, 100)`))
ok('prévision : semaine 1 — 1 100 d’encaissements (retard inclus), 300 de décaissements, solde 6 350', Number(fc[0].receipts) === 1100 && Number(fc[0].payments) === 300 && Number(fc[0].projected_balance) === 6350)
ok('prévision : semaine 3 — 100 de décaissements (litige résolu)', Number(fc[2].payments) === 100)
ok('prévision : solde final 6 550', Number(fc[3].projected_balance) === 6550)
const half = await as(fin, () => q(`select * from treasury_forecast(current_date, 4, 50)`))
ok('prévision à 50 % d’encaissement : semaine 1 = 550', Number(half[0].receipts) === 550)
await rejects('taux d’encaissement hors bornes refusé', () => as(fin, () => q(`select * from treasury_forecast(current_date, 4, 150)`)), 'FINANCE_BAD_PCT')

// --- 9. Tableau de bord ---------------------------------------------------------------------------------------------------------------------
const dash = await as(dir, () => rpc('finance_dashboard'))
ok('dashboard : créances 1 400 dont 1 100 échues', Number(dash.receivables) === 1400 && Number(dash.receivables_overdue) === 1100)
ok('dashboard : DSO 70 jours (1 400 ÷ 1 800 × 90)', Number(dash.dso_days) === 70)
ok('dashboard : dettes fournisseurs 400, aucune en litige', Number(dash.payables) === 400 && Number(dash.payables_disputed) === 0)
ok('dashboard : client le plus en retard : Bragard', dash.top_overdue_clients[0].client === 'Bragard')
ok('dashboard : une relance en attente (I2), la seconde envoyée', dash.reminders_pending === 1)
ok('dashboard : trésorerie 5 550 et prévision 4 semaines +1 000', Number(dash.treasury.balance) === 5550 && Number(dash.forecast_4w_net) === 1000)
await rejects('dashboard refusé sans droit financier', () => as(nobody, () => rpc('finance_dashboard')), 'RBAC_FORBIDDEN')
await rejects('dashboard : commercial sans finance.read refusé', () => as(comm, () => rpc('finance_dashboard')), 'RBAC_FORBIDDEN')
