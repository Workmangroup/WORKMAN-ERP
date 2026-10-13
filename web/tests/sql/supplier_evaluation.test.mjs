// Évaluation fournisseur et délais : scores explicables, retard confirmé vs prévision, échantillon faible, brouillon sans commande ferme — P036 / migration 0061
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - b) <= tol

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const buyer = await mkUser('achat@x.com', 'achat')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

await as(admin, () => rpc('approval_policy_set', 'purchase_order', 1, null, 'purchases.approve', null, 'approvals.escalate', 24))
const today = (await q(`select current_date::text d`))[0].d
const plus = async (n) => (await q(`select (current_date + $1::int)::text d`, [n]))[0].d
const DM1 = await plus(-1), DP1 = await plus(1), DM3 = await plus(-3), DP0 = await plus(0), DP10 = await plus(10), DM5 = await plus(-5), DM2 = await plus(-2), DP20 = await plus(20)

// Fournisseurs A (étudié) et B (commande en retard sans réception)
const supA = (await q(`insert into suppliers(company_id, code, name, country, lead_time_days, qualification, rating) values ($1,'F-A36','Fournisseur A','TN',10,'approved',4) returning id`, [company]))[0].id
const supB = (await q(`insert into suppliers(company_id, code, name, country, lead_time_days, qualification, rating) values ($1,'F-B36','Fournisseur B','TN',10,'approved',3) returning id`, [company]))[0].id
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P036','fabric','m') returning id`, [company]))[0].id
await db.query(`insert into bom_material_prices(material_id, company_id, unit_cost) values ($1,$2,8.0)`, [tissu, company])
const wh = (await q(`insert into warehouses(company_id, name) values ($1,'Magasin P036') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, wh])
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh]))[0].id

// Commande fournisseur (approuvée, envoyée) avec date prévue explicite
const mkPo = async (sup, expected, qty, price) => {
  const po = (await as(buyer, () => q(`insert into purchase_orders(supplier_id) values ($1) returning id`, [sup])))[0].id
  await as(buyer, () => q(`update purchase_orders set expected_date = $2 where id = $1`, [po, expected]))
  const line = (await as(buyer, () => q(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,$3,$4) returning id`, [po, tissu, qty, price])))[0].id
  await as(buyer, () => rpc('purchase_order_submit', po))
  const apId = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1`, [po]))[0].id
  await as(dir, () => rpc('approval_decide', apId, 'approve', null))
  await as(buyer, () => rpc('purchase_order_send', po))
  return { po, line }
}
const p1 = await mkPo(supA, await plus(-5), 100, 8.5)     // prévue il y a 5 jours : réception aujourd'hui = retard confirmé
const p2 = await mkPo(supA, await plus(10), 50, 8.5)      // prévue dans 10 jours : à l'heure
const pB = await mkPo(supB, await plus(-2), 30, 8.5)      // prévue il y a 2 jours, rien reçu : prévision de retard

// Confirmation de la commande A1 (réactivité) et réceptions avec bon de livraison
await as(buyer, () => rpc('purchase_order_confirm', p1.po, 1, 'CONF-P36-1', today))
const rc1 = await as(mag, () => rpc('purchase_receive', p1.po, wh, loc, JSON.stringify([{ line_id: p1.line, qty: 100 }]), 'BL-A-1', null))
const rc2 = await as(mag, () => rpc('purchase_receive', p2.po, wh, loc, JSON.stringify([{ line_id: p2.line, qty: 50 }]), 'BL-A-2', null))
const rl1 = (await q(`select id from purchase_receipt_lines where receipt_id=$1`, [rc1]))[0].id

// Contrôle à la réception de la réception 1 : 20 contrôlés, 2 défauts mineurs
await db.query(`insert into quality_inspections(company_id, number, kind, sample_size, purchase_receipt_id, material_id, status) values ($1,'QI-P36-1','reception',20,$2,$3,'open')`, [company, rc1, tissu])
const insp = (await q(`select id from quality_inspections where number='QI-P36-1'`))[0].id
await db.query(`insert into quality_defects(company_id, inspection_id, defect_code, category, severity, qty) values ($1,$2,'FIL','tissage','minor',2)`, [company, insp])

// 1. Sans politique : indicateurs visibles, score composite non calculé, motif indiqué
const pre = await as(buyer, () => rpc('supplier_evaluate_preview', supA, DM1, DP1))
ok('sans politique : score composite non calculé, motif « politique non paramétrée » affiché', pre.composite === null && pre.composite_missing.some((m) => m.includes('politique')) && pre.flags.includes('POLITIQUE_NON_PARAMETREE'))
ok('ponctualité explicable : 1 réception à l’heure sur 2 (50 %), retard confirmé = 1', pre.indicators.ponctualite.numerator === 1 && pre.indicators.ponctualite.denominator === 2 && near(pre.indicators.ponctualite.value, 50) && pre.confirmed_late.receipts_after_due_date === 1)
ok('défauts explicables : 2 défauts sur 20 contrôlés (10 %), 0 critique', near(pre.indicators.defauts.value, 10) && pre.indicators.defauts.critical === 0)
ok('écart prix : 8,50 commandé vs 8,00 catalogue = +6,25 % sur 150 pièces', near(pre.indicators.ecart_prix.value, 6.25, 0.01))
ok('réactivité : 1 confirmation, délai moyen 0 jour', pre.indicators.reactivite.confirmations === 1 && near(pre.indicators.reactivite.average_days, 0))
ok('documents : 2 bons de livraison et 1 confirmation sur 2 réceptions et 1 confirmation (100 %)', near(pre.indicators.documents.value, 100))

// 2. Politique : pondérations explicites, seuils ; invalide refusée
await rejects('politique : pondérations qui ne font pas 100 refusées', () => as(admin, () => rpc('supplier_policy_set', 30, 20, 20, 15, 10, 3, 3, 5)), 'EVAL_POLICY_INVALID')
await rejects('politique : pondérations partielles refusées', () => as(admin, () => rpc('supplier_policy_set', 30, 20, null, 15, 15, 3, 3, 5)), 'EVAL_POLICY_INVALID')
await rejects('politique : saisie refusée sans droit de gouvernance (achat)', () => as(buyer, () => rpc('supplier_policy_set', 30, 20, 20, 15, 15, 3, 3, 5)), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('supplier_policy_set', 30, 20, 20, 15, 15, 3, 3, 5))

// 3. Score composite : 30×50 + 20×90 + 20×93,75 + 15×100 + 15×100 = 81,75 ; échantillon faible (2 < 3) signalé
const v = await as(buyer, () => rpc('supplier_evaluate_preview', supA, DM1, DP1))
ok('score composite : 81,75 conforme à la formule affichée', v.composite && near(v.composite.score, 81.75, 0.01) && v.composite.weights_sum === 100)
ok('données peu nombreuses signalées : échantillon faible (2 réceptions, seuil 3)', v.flags.includes('ECHANTILLON_FAIBLE'))
ok('écart prix au-delà du seuil d’alerte (5 %) signalé', v.flags.includes('ECART_PRIX_AU_DELA_SEUIL') && v.flags.includes('DEFAUT_CRITIQUE') === false)

// 4. Prévision distincte du retard confirmé : fournisseur B, commande en retard, rien reçu
const vb = await as(buyer, () => rpc('supplier_evaluate_preview', supB, DM3, DP0))
ok('prévision : commande B dépassée sans réception = prévision (non confirmée), retard confirmé = 0', vb.forecast_late.open_orders_past_due === 1 && vb.confirmed_late.receipts_after_due_date === 0 && vb.flags.includes('PREVISION_RETARD') && vb.flags.includes('AUCUNE_RECEPTION_PERIODE'))
ok('fournisseur sans réception : pas de score composite, motif donné', vb.composite === null && vb.composite_missing.length > 0)

// 5. Enregistrement : historique conservé, ajout seul
const evId = await as(buyer, () => rpc('supplier_evaluate', supA, DM1, DP1))
ok('évaluation enregistrée et relisible', (await q(`select count(*)::int n from supplier_evaluations where id=$1`, [evId]))[0].n === 1)
await rejects('évaluation conservée : modification refusée (ajout seul)', () => db.query(`update supplier_evaluations set period_from = period_from where id=$1`, [evId]), 'EVAL_APPEND_ONLY')
await rejects('évaluation : lecture refusée sans droit achats', () => as(nobody, () => rpc('supplier_evaluate_preview', supA, DM1, DP1)), 'RBAC_FORBIDDEN')
await rejects('évaluation : période inversée refusée', () => as(buyer, () => rpc('supplier_evaluate_preview', supA, DP1, DM1)), 'EVAL_PERIOD_INVALID')

// 6. Réapprovisionnement : brouillon de demande d'achat, jamais une commande ferme
const run = (await q(`insert into mrp_runs(company_id, code, name, as_of) values ($1,'MRP-P36','Calcul P036',current_date) returning id`, [company]))[0].id
const sug = (await q(`insert into mrp_run_suggestions(run_id, company_id, material_id, supplier_id, qty, need_date, release_date, late) values ($1,$2,$3,$4,200,$5,$5,false) returning id`, [run, company, tissu, supA, await plus(20)]))[0].id
const dr = await as(buyer, () => rpc('supplier_reorder_draft', supA, run))
const dreq = (await q(`select status, source, reason from purchase_requests where id=$1`, [dr]))[0]
ok('réapprovisionnement : demande d’achat en brouillon, non soumise, non approuvée', dreq.status === 'draft' && dreq.reason.includes('à valider par un humain'))
ok('aucune commande ferme créée par le réapprovisionnement', (await q(`select count(*)::int n from purchase_orders where request_id=$1`, [dr]))[0].n === 0)
ok('suggestion MRP rattachée à la demande brouillon (traçabilité)', (await q(`select request_id from mrp_run_suggestions where id=$1`, [sug]))[0].request_id === dr)
await rejects('réapprovisionnement : seconde demande sur une suggestion déjà rattachée refusée', () => as(buyer, () => rpc('supplier_reorder_draft', supA, run)), 'EVAL_NO_SUGGESTION')
await rejects('réapprovisionnement refusé sans droit d’écriture', () => as(mag, () => rpc('supplier_reorder_draft', supA, run)), 'RBAC_FORBIDDEN')

// 7. Audit
ok('audit : politique, évaluations et brouillon tracés', (await q(`select count(*)::int n from audit_logs where action in ('eval.policy_set','eval.supplier','eval.reorder_draft')`))[0].n >= 3)
