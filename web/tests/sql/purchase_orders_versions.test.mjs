// Commandes achats : versions, accord avant envoi, confirmation fournisseur, modification approuvée, reliquats — P034 / migration 0059
import fs from 'node:fs'
import path from 'node:path'
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
const buyer = await mkUser('achat@x.com', 'achat')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

await as(admin, () => rpc('approval_policy_set', 'purchase_order', 1, null, 'purchases.approve', null, 'approvals.escalate', 24))

// Fixtures : fournisseur qualifié, composants, entrepôt
const sup = (await q(`insert into suppliers(company_id, code, name, country, lead_time_days, qualification) values ($1,'F-P34','Fournisseur P034','TN',10,'approved') returning id`, [company]))[0].id
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P034','fabric','m') returning id`, [company]))[0].id
const zip = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Zip P034','fabric','pc') returning id`, [company]))[0].id
const wh = (await q(`insert into warehouses(company_id, name) values ($1,'Magasin P034') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, wh])
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh]))[0].id

// Commande : deux lignes
const po = (await as(buyer, () => q(`insert into purchase_orders(supplier_id, notes) values ($1,'Commande P034') returning *`, [sup])))[0]
const lineT = (await as(buyer, () => q(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,100,8.5) returning id`, [po.id, tissu])))[0].id
const lineZ = (await as(buyer, () => q(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,200,1.2) returning id`, [po.id, zip])))[0].id
const row = async () => (await q(`select * from purchase_orders where id=$1`, [po.id]))[0]
const versions = async () => q(`select version, kind, status from purchase_order_versions where po_id=$1 order by version`, [po.id])
const lineQty = async (id) => Number((await q(`select qty_ordered, unit_price from purchase_order_lines where id=$1`, [id]))[0].qty_ordered)

// 1. Accord avant envoi
await rejects('envoi refusé sans version approuvée (PO_NOT_APPROVED)', () => as(buyer, () => rpc('purchase_order_send', po.id)), 'PO_NOT_APPROVED')
const v1 = await as(buyer, () => rpc('purchase_order_submit', po.id))
ok('soumission : version 1 proposée, commande en attente d’accord', v1 === 1 && (await row()).approval_pending === true && (await versions())[0].status === 'proposed')
await rejects('seconde soumission refusée pendant l’accord (PO_APPROVAL_PENDING)', () => as(buyer, () => rpc('purchase_order_submit', po.id)), 'PO_APPROVAL_PENDING')
await rejects('envoi refusé pendant l’accord (PO_APPROVAL_PENDING ou non approuvée)', () => as(buyer, () => rpc('purchase_order_send', po.id)), 'PO_APPROVAL_PENDING')
const ap1 = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1`, [po.id]))[0].id
const refusal = await as(dir, () => rpc('approval_decide', ap1, 'refuse', 'Prix à renégocier avant envoi'))
ok('refus de la version 1 : version refusée visible, commande toujours brouillon, aucun envoi', refusal.state === 'refused' && (await versions())[0].status === 'refused' && (await row()).status === 'draft' && (await row()).approval_pending === false)

// 2. Version 2 approuvée ; contenu modifié après accord = envoi refusé ; retour au contenu approuvé = envoi accepté
const v2 = await as(buyer, () => rpc('purchase_order_submit', po.id))
const ap2 = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1 and state='pending_l1'`, [po.id]))[0].id
const dec2 = await as(dir, () => rpc('approval_decide', ap2, 'approve', null))
ok('version 2 approuvée : version approuvée visible (2), version 1 reste refusée', v2 === 2 && dec2.state === 'approved' && (await row()).approved_version === 2 && JSON.stringify((await versions()).map((v) => v.status)) === JSON.stringify(['refused', 'approved']))
await as(buyer, () => db.query(`update purchase_order_lines set unit_price = 9 where id=$1`, [lineT]))
await rejects('envoi refusé : contenu modifié après accord (PO_CHANGED_AFTER_APPROVAL)', () => as(buyer, () => rpc('purchase_order_send', po.id)), 'PO_CHANGED_AFTER_APPROVAL')
await as(buyer, () => db.query(`update purchase_order_lines set unit_price = 8.5 where id=$1`, [lineT]))
await as(buyer, () => rpc('purchase_order_send', po.id))
ok('envoi : seulement la version approuvée, identique à celle approuvée', (await row()).status === 'sent' && (await row()).sent_version === 2)

// 3. Confirmation fournisseur : version envoyée, référence et date
await rejects('confirmation refusée : mauvaise version (PO_STALE_VERSION)', () => as(buyer, () => rpc('purchase_order_confirm', po.id, 1, 'CONF-1', new Date().toISOString().slice(0, 10))), 'PO_STALE_VERSION')
await rejects('confirmation refusée : référence absente', () => as(buyer, () => rpc('purchase_order_confirm', po.id, 2, '', new Date().toISOString().slice(0, 10))), 'PO_CONFIRMATION_REFERENCE_REQUIRED')
await rejects('confirmation refusée : date future', () => as(buyer, () => rpc('purchase_order_confirm', po.id, 2, 'CONF-2026-77', '2999-01-01')), 'PO_BAD_DATE')
await as(buyer, () => rpc('purchase_order_confirm', po.id, 2, 'CONF-2026-77', new Date().toISOString().slice(0, 10)))
ok('confirmation : version acceptée visible (2) avec référence', (await row()).confirmed_version === 2 && (await row()).confirmation_reference === 'CONF-2026-77')
await rejects('confirmation refusée : déjà confirmée', () => as(buyer, () => rpc('purchase_order_confirm', po.id, 2, 'CONF-BIS', new Date().toISOString().slice(0, 10))), 'PO_ALREADY_CONFIRMED')

// 4. Réception partielle, puis modification approuvée
await as(mag, () => rpc('purchase_receive', po.id, wh, loc, JSON.stringify([{ line_id: lineT, qty: 40 }]), 'BL-P34-1', null))
ok('réception partielle : commande « partielle »', (await row()).status === 'partial')
await rejects('modification refusée : motif absent', () => as(buyer, () => rpc('purchase_order_amend', po.id, JSON.stringify([{ line_id: lineT, qty_ordered: 120, unit_price: 8.2 }, { line_id: lineZ, qty_ordered: 200, unit_price: 1.2 }]), '')), 'PO_REASON_REQUIRED')
await rejects('modification refusée : ligne manquante (PO_BAD_LINE)', () => as(buyer, () => rpc('purchase_order_amend', po.id, JSON.stringify([{ line_id: lineT, qty_ordered: 120, unit_price: 8.2 }]), 'Hausse de quantité demandée')), 'PO_BAD_LINE')
await rejects('modification refusée : quantité sous le reçu (40)', () => as(buyer, () => rpc('purchase_order_amend', po.id, JSON.stringify([{ line_id: lineT, qty_ordered: 30, unit_price: 8.2 }, { line_id: lineZ, qty_ordered: 200, unit_price: 1.2 }]), 'Baisse trop forte')), 'PO_QTY_BELOW_RECEIVED')
const v3 = await as(buyer, () => rpc('purchase_order_amend', po.id, JSON.stringify([{ line_id: lineT, qty_ordered: 120, unit_price: 8.2 }, { line_id: lineZ, qty_ordered: 200, unit_price: 1.2 }]), 'Hausse de quantité demandée'))
ok('modification proposée : version 3 en attente, lignes inchangées tant qu’elle n’est pas approuvée', v3 === 3 && (await row()).approval_pending === true && near(await lineQty(lineT), 100))
await rejects('seconde modification refusée pendant l’accord', () => as(buyer, () => rpc('purchase_order_amend', po.id, JSON.stringify([{ line_id: lineT, qty_ordered: 110, unit_price: 8.2 }, { line_id: lineZ, qty_ordered: 200, unit_price: 1.2 }]), 'Autre modification')), 'PO_APPROVAL_PENDING')
await rejects('envoi de modification refusé avant accord', () => as(buyer, () => rpc('purchase_order_send_amendment', po.id)), 'PO_APPROVAL_PENDING')
const ap3 = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1 and state='pending_l1' order by object_version desc limit 1`, [po.id]))[0].id
await as(dir, () => rpc('approval_decide', ap3, 'refuse', 'Pas de hausse avant la prochaine livraison'))
ok('modification refusée : version 3 refusée, lignes et version approuvée (2) inchangées', (await versions()).find((v) => v.version === 3).status === 'refused' && near(await lineQty(lineT), 100) && (await row()).approved_version === 2)

// 5. Nouvelle modification approuvée : appliquée aux lignes, version précédente remplacée
const v4 = await as(buyer, () => rpc('purchase_order_amend', po.id, JSON.stringify([{ line_id: lineT, qty_ordered: 120, unit_price: 8.2 }, { line_id: lineZ, qty_ordered: 200, unit_price: 1.2 }]), 'Hausse de quantité demandée'))
const ap4 = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1 and state='pending_l1' order by object_version desc limit 1`, [po.id]))[0].id
await as(dir, () => rpc('approval_decide', ap4, 'approve', null))
ok('modification approuvée : lignes appliquées (120 × 8,20), version 4 approuvée, version 2 remplacée', v4 === 4 && near(await lineQty(lineT), 120) && (await row()).approved_version === 4
  && (await versions()).find((v) => v.version === 2).status === 'superseded')
ok('total recalculé après modification : 120 × 8,20 + 200 × 1,20 = 1 224,00', near((await row()).total_amount, 1224))
await as(buyer, () => rpc('purchase_order_send_amendment', po.id))
ok('envoi de la modification : version 4 envoyée, version acceptée encore 2 (à confirmer)', (await row()).sent_version === 4 && (await row()).confirmed_version === 2)
await rejects('envoi de modification refusé : rien de nouveau à envoyer', () => as(buyer, () => rpc('purchase_order_send_amendment', po.id)), 'PO_NOTHING_TO_SEND')
await rejects('confirmation de l’ancienne version refusée après modification (PO_STALE_VERSION)', () => as(buyer, () => rpc('purchase_order_confirm', po.id, 2, 'CONF-OLD', new Date().toISOString().slice(0, 10))), 'PO_STALE_VERSION')
await as(buyer, () => rpc('purchase_order_confirm', po.id, 4, 'CONF-2026-78', new Date().toISOString().slice(0, 10)))
ok('confirmation de la version 4 : version acceptée visible (4), référence conservée', (await row()).confirmed_version === 4 && (await row()).confirmation_reference === 'CONF-2026-78')

// 6. Historique, reliquats, références
const vs = await versions()
ok('historique complet : 1 refusée, 2 remplacée, 3 refusée, 4 approuvée ; aucune supprimée', JSON.stringify(vs.map((v) => `${v.version}:${v.status}`)) === JSON.stringify(['1:refused', '2:superseded', '3:refused', '4:approved']))
const rem = await as(buyer, () => rpc('purchase_order_remaining', po.id))
const remT = rem.find((l) => l.line_id === lineT)
ok('reliquat : 120 commandés, 40 reçus, 80 restant à recevoir', near(remT.qty_ordered, 120) && near(remT.qty_received, 40) && near(remT.remaining, 80))
ok('référence de commande conservée (PO-AAAA-nnnnn)', /^PO-\d{4}-\d{5}$/.test((await row()).po_no) && (await row()).po_no === po.po_no)
await rejects('versions immuables : modification directe refusée', () => as(buyer, () => db.query(`update purchase_order_versions set status='approved' where po_id=$1`, [po.id])), 'permission denied')
await rejects('confirmation directe refusée (écriture par fonction seulement)', () => as(buyer, () => db.query(`insert into purchase_order_confirmations(po_id, version, reference, confirmed_on) values ($1,4,'FAKE','2026-01-01')`, [po.id])), 'permission denied')
await rejects('lecture des reliquats refusée sans droit achats', () => as(nobody, () => rpc('purchase_order_remaining', po.id)), 'RBAC_FORBIDDEN')

// 7. Annulation d'une commande en attente d'accord : demande fermée, version annulée
const po2 = (await as(buyer, () => q(`insert into purchase_orders(supplier_id) values ($1) returning id`, [sup])))[0].id
await as(buyer, () => q(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,5,2)`, [po2, zip]))
await as(buyer, () => rpc('purchase_order_submit', po2))
await as(buyer, () => rpc('purchase_order_cancel', po2))
const ap5 = (await q(`select state from approval_requests where object_type='purchase_order' and object_id=$1`, [po2]))[0].state
const v5 = (await q(`select status from purchase_order_versions where po_id=$1`, [po2]))[0].status
ok('annulation : demande d’accord fermée, version annulée, commande annulée', ap5 === 'cancelled' && v5 === 'cancelled' && (await q(`select status from purchase_orders where id=$1`, [po2]))[0].status === 'cancelled')

// 8. Commande ancienne (envoyée avant P034) : version historique, contenu et référence inchangés
await db.query(`select set_config('purchases.rpc','on',false)`)
const legacy = (await q(`insert into purchase_orders(company_id, supplier_id, po_no, status, total_amount) values ($1,$2,'PO-2025-00007','sent',50) returning id`, [company, sup]))[0].id
await db.exec(`insert into purchase_order_lines(company_id, po_id, material_id, qty_ordered, unit_price) values ('${company}','${legacy}','${zip}',10,5); select set_config('purchases.rpc','off',false);`)
const migrationSql = fs.readFileSync(path.join(migrationsDir, '0059_purchase_orders_versions_confirmations.sql'), 'utf8')
await db.exec(migrationSql.slice(migrationSql.indexOf('-- 11. Reprise')).replace(/^.*\n/, ''))
const lv = await q(`select version, kind, status from purchase_order_versions where po_id=$1`, [legacy])
const lo = (await q(`select po_no, status, approved_version, sent_version, current_version from purchase_orders where id=$1`, [legacy]))[0]
ok('commande ancienne : version historique approuvée (accord non tracé), référence PO-2025-00007 conservée', lv.length === 1 && lv[0].kind === 'legacy' && lv[0].status === 'approved'
  && lo.po_no === 'PO-2025-00007' && lo.status === 'sent' && lo.approved_version === 1 && lo.sent_version === 1)

// 9. Traçabilité : audit des étapes
ok('audit : soumission, envoi, modification, confirmation et annulation tracés', (await q(`select count(*)::int n from audit_logs where action in ('purchase.po_submit','purchase.po_send','purchase.po_amend','purchase.po_confirm','purchase.po_cancel','purchase.po_send_amendment')`))[0].n >= 6)
