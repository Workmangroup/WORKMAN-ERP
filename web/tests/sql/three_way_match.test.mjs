// Réception et rapprochement trois voies : reçu / accepté / rejeté, quarantaine, retours, tolérances, litige, paiement — P035 / migration 0060
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b) => Math.abs(Number(a) - b) < 0.0051

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const admin2 = await mkUser('admin2@x.com', 'admin')        // contrôle qualité distinct du réceptionnaire
const buyer = await mkUser('achat@x.com', 'achat')
const mag = await mkUser('mag@x.com', 'magasin')
const fin = await mkUser('fin@x.com', 'finance')
const dir = await mkUser('dir@x.com', 'direction')
const nobody = await mkUser('nobody@x.com', null)

await as(admin, () => rpc('approval_policy_set', 'purchase_order', 1, null, 'purchases.approve', null, 'approvals.escalate', 24))
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])

// Fixtures : fournisseur, composant, entrepôt avec emplacement de quarantaine et emplacement de stockage
const sup = (await q(`insert into suppliers(company_id, code, name, country, lead_time_days, qualification) values ($1,'F-P35','Fournisseur P035','TN',10,'approved') returning id`, [company]))[0].id
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P035','fabric','m') returning id`, [company]))[0].id
const wh = (await q(`insert into warehouses(company_id, name) values ($1,'Magasin P035') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, wh])
const stock = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh]))[0].id
const qua = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUA','Quarantaine réception','quarantine') returning id`, [company, wh]))[0].id
const onLoc = async (loc) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where location_id=$1`, [loc]))[0].n)

// Commande : 1000 m à 8,50 ; approbation puis envoi
const po = (await as(buyer, () => q(`insert into purchase_orders(supplier_id) values ($1) returning id, po_no`, [sup])))[0]
await as(buyer, () => q(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,1000,8.5)`, [po.id, tissu]))
await as(buyer, () => rpc('purchase_order_submit', po.id))
const apPO = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1`, [po.id]))[0].id
await as(dir, () => rpc('approval_decide', apPO, 'approve', null))
await as(buyer, () => rpc('purchase_order_send', po.id))
const poLine = (await q(`select id from purchase_order_lines where po_id=$1`, [po.id]))[0].id

// Facture : 1000 m × 8,50 = 8 500,00 (saisie finance, rattachée à la commande)
const inv = await as(fin, () => rpc('supplier_invoice_record', sup, 'FT-P35-1', new Date().toISOString().slice(0, 10), new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), 8500, 'EUR', po.id))
const invRow = async () => (await q(`select status, dispute_reason, total from supplier_invoices where id=$1`, [inv]))[0]

// 1. Réception : 980 reçus en quarantaine ; aucune décision encore → rapprochement bloqué (réception non contrôlée)
const rc = await as(admin, () => rpc('purchase_receive', po.id, wh, qua, JSON.stringify([{ line_id: poLine, qty: 980 }]), 'BL-P35-1', null))
const rl = (await q(`select id, location_id from purchase_receipt_lines where receipt_id=$1`, [rc]))[0]
ok('réception : 980 reçus, rangés en quarantaine, aucun accepté', rl.location_id === qua && near(await onLoc(qua), 980) && near(await onLoc(stock), 0))
const m0 = await as(fin, () => rpc('supplier_invoice_match', inv))
ok('rapprochement avant contrôle : bloqué (réception non contrôlée, 980 × 8,50 = 8 330), facture en litige', m0.status === 'blocked' && near(m0.uncontrolled, 8330) && (await invRow()).status === 'disputed')
await rejects('contrôle : le réceptionnaire ne décide pas (SOD)', () => as(admin, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, 'Défauts de tissage constatés', stock)), 'SOD_SELF_APPROVAL')
await rejects('contrôle : sans droit qualité refusé', () => as(mag, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, 'Défauts de tissage constatés', stock)), 'RBAC_FORBIDDEN')
await rejects('contrôle : accepté + rejeté différent du reçu refusé', () => as(admin2, () => rpc('purchase_receipt_line_decide', rl.id, 900, 20, 'Défauts de tissage constatés', stock)), 'RECEIPT_QTY_MISMATCH')
await rejects('contrôle : rejet sans motif refusé', () => as(admin2, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, '', stock)), 'QUALITY_REASON_REQUIRED')
await rejects('contrôle : accepté en quarantaine sans emplacement de destination refusé', () => as(admin2, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, 'Défauts de tissage constatés', null)), 'RECEIPT_TARGET_REQUIRED')
await rejects('contrôle : destination = quarantaine refusée', () => as(admin2, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, 'Défauts de tissage constatés', qua)), 'RECEIPT_TARGET_INVALID')

// 2. Décision : 980 reçus = 960 acceptés + 20 rejetés (retour fournisseur réel), libération de la quarantaine
const dec = await as(admin2, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, 'Défauts de tissage constatés', stock))
ok('décision : 960 acceptés, 20 rejetés, retour fournisseur créé', dec.accepted === 960 && dec.rejected === 20 && dec.return_id)
ok('stock : 960 libérés en stockage, quarantaine vide, rejet sorti', near(await onLoc(stock), 960) && near(await onLoc(qua), 0))
const ret = await q(`select code, reason from purchase_returns where id=$1`, [dec.return_id])
ok('retour fournisseur tracé (RET-, motif de contrôle)', /^RET-\d{4}$/.test(ret[0].code) && ret[0].reason.startsWith('Rejet au contrôle de réception'))
await rejects('décision répétée refusée (ligne déjà contrôlée)', () => as(admin2, () => rpc('purchase_receipt_line_decide', rl.id, 960, 20, 'Défauts de tissage constatés', stock)), 'RECEIPT_ALREADY_INSPECTED')

// 3. Synthèse : commandé 1000 / reçu 980 / rejeté 20 / accepté 960 / facturable 960
const acc = await as(buyer, () => rpc('purchase_order_acceptance', po.id))
const a = acc[0]
ok('synthèse : 1000 commandés, 980 reçus, 20 rejetés, 960 acceptés, 0 non contrôlé, 960 facturables', near(a.qty_ordered, 1000) && near(a.qty_received, 980) && near(a.qty_rejected, 20) && near(a.qty_accepted, 960) && near(a.qty_uncontrolled, 0) && near(a.qty_billable, 960))
ok('statut de commande : partielle (reliquat 20 à recevoir après rejet)', (await q(`select status from purchase_orders where id=$1`, [po.id]))[0].status === 'partial')

// 4. Rapprochement : facture 8 500 contre 960 acceptés (8 160) → écart 340 visible, litige
const m1 = await as(fin, () => rpc('supplier_invoice_match', inv))
ok('écart facture visible : 8 500 facturés, 8 160 acceptés, écart 340 bloquant', m1.status === 'blocked' && near(m1.accepted, 8160) && near(m1.gap, 340) && near(m1.invoice_total, 8500) && near(m1.ordered, 8500))
ok('facture en litige avec motif visible', (await invRow()).status === 'disputed' && /Rapprochement : .*accepté/.test((await invRow()).dispute_reason))
await rejects('paiement refusé : facture en litige (aucun montant imputable)', () => as(fin, () => rpc('payment_order_prepare', sup, 100, 'Règlement test P35')), 'FINANCE_OVERPAYMENT')

// 5. Tolérance : paramétrée par finance (5 %) → écart de 340 (4,17 %) absorbé → rapprochement conforme, litige levé
await rejects('tolérance : saisie réservée à finance.write', () => as(buyer, () => rpc('purchase_tolerance_set', null, 5)), 'RBAC_FORBIDDEN')
await rejects('tolérance : pourcentage hors plage refusé', () => as(fin, () => rpc('purchase_tolerance_set', null, 150)), 'MATCH_TOLERANCE_INVALID')
await as(fin, () => rpc('purchase_tolerance_set', null, 5))
const m2 = await as(fin, () => rpc('supplier_invoice_match', inv))
ok('tolérance 5 % : écart 340 absorbé, rapprochement conforme, litige levé automatiquement', m2.status === 'matched' && near(m2.tolerance, 408) && (await invRow()).status === 'open' && (await invRow()).dispute_reason === null)

// 6. Paiement distinct : après rapprochement conforme, le règlement passe par un ordre approuvé et exécuté par un autre
const order = await as(fin, () => rpc('payment_order_prepare', sup, 1000, 'Acompte fournisseur P35'))
await as(dir, () => rpc('payment_order_decide', order.id ?? order, true, 'Conforme au rapprochement'))
const pay = await as(admin, () => rpc('payment_order_execute', order.id ?? order, null))
const pi = (await q(`select status, paid_amount from supplier_invoices where id=$1`, [inv]))[0]
ok('paiement après rapprochement conforme : facture imputée (1 000,00), statut partiel', pay.allocated_invoices === 1 && near(pi.paid_amount, 1000) && pi.status === 'partially_paid')
ok('rapprochement et paiement distincts : le paiement n’efface pas l’historique de rapprochement', (await q(`select count(*)::int n from purchase_invoice_matches where invoice_id=$1`, [inv]))[0].n === 3)

// 7. Cas sans écart : 500 m reçus et acceptés, facture exacte → conforme dès le premier rapprochement
const po2 = (await as(buyer, () => q(`insert into purchase_orders(supplier_id) values ($1) returning id`, [sup])))[0]
await as(buyer, () => q(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,500,8.5)`, [po2.id, tissu]))
await as(buyer, () => rpc('purchase_order_submit', po2.id))
const apPO2 = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1`, [po2.id]))[0].id
await as(dir, () => rpc('approval_decide', apPO2, 'approve', null))
await as(buyer, () => rpc('purchase_order_send', po2.id))
const pl2 = (await q(`select id from purchase_order_lines where po_id=$1`, [po2.id]))[0].id
const rc2 = await as(mag, () => rpc('purchase_receive', po2.id, wh, stock, JSON.stringify([{ line_id: pl2, qty: 500 }]), 'BL-P35-2', null))
const rl2 = (await q(`select id from purchase_receipt_lines where receipt_id=$1`, [rc2]))[0].id
await as(admin2, () => rpc('purchase_receipt_line_decide', rl2, 500, 0, null, null))
const inv2 = await as(fin, () => rpc('supplier_invoice_record', sup, 'FT-P35-2', new Date().toISOString().slice(0, 10), new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), 4250, 'EUR', po2.id))
const m3 = await as(fin, () => rpc('supplier_invoice_match', inv2))
ok('sans écart : 500 reçus et acceptés, facture 4 250,00 exacte → conforme, payable', m3.status === 'matched' && near(m3.accepted, 4250))

// 8. Sans commande : rapprochement non applicable, facture payable comme avant
const inv3 = await as(fin, () => rpc('supplier_invoice_record', sup, 'FT-P35-3', new Date().toISOString().slice(0, 10), new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), 100, 'EUR', null))
ok('facture sans commande : rapprochement non applicable, aucun blocage', (await as(fin, () => rpc('supplier_invoice_match', inv3))).status === 'no_order')

// 9. Droits et traçabilité
await rejects('rapprochement refusé sans droit finance', () => as(nobody, () => rpc('supplier_invoice_match', inv2)), 'RBAC_FORBIDDEN')
ok('audit : rapprochements, contrôle et tolérance tracés', (await q(`select count(*)::int n from audit_logs where action in ('match.compute','purchase.receipt_inspect','match.tolerance_set')`))[0].n >= 4)
