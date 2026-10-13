import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = (await import('node:fs')).default.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
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
const prod = await mkUser('prod@x.com', 'production')
const mag = await mkUser('mag@x.com', 'magasin')
const fin = await mkUser('fin@x.com', 'finance')
const comm = await mkUser('comm@x.com', 'commercial')

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
ok('production : demander seulement ; magasin : demander + réceptionner ; achat : écrire + réceptionner', (await perms('production')).includes('purchases.request') && !(await perms('production')).includes('purchases.read')
  && (await perms('magasin')).includes('purchases.receive') && (await perms('achat')).includes('purchases.write') && (await perms('achat')).includes('purchases.receive'))
ok('approbation : direction, pas achat', (await perms('direction')).includes('purchases.approve') && !(await perms('achat')).includes('purchases.approve'))

// --- Données ---------------------------------------------------------------------------------------------------------------------------
const mat = async (name, unit, cost) => {
  const m = (await as(prod, () => q(`insert into bom_materials(name, category, unit) values ($1,'fabric',$2) returning *`, [name, unit])))[0]
  await as(buyer, () => db.query(`insert into bom_material_prices(material_id, unit_cost) values ($1,$2)`, [m.id, cost]))
  return m
}
const tissu = await mat('Tissu jaune HV', 'm', 8.5)
const zip = await mat('Zip 60 cm', 'pc', 1.2)
const bouton = await mat('Bouton pression', 'pc', 0.15)
const fil = await mat('Fil polyester', 'm', 0.001)
const mkSup = (name, lead) => as(buyer, async () => (await q(`insert into suppliers(name, country, lead_time_days) values ($1,'TN',$2) returning id`, [name, lead]))[0].id)
const supA = await mkSup('Tissus du Sud', 10)
const supB = await mkSup('Mercerie Nord', 5)
const setSup = (m, s) => as(prod, () => db.query(`update bom_materials set supplier_id=$2 where id=$1`, [m, s]))
await setSup(tissu.id, supA); await setSup(zip.id, supA); await setSup(bouton.id, supB)
const wh = (await q(`insert into warehouses(company_id, name) values ((select id from companies limit 1), 'Magasin') returning id`))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ((select id from companies limit 1), $1, $2, 'manager')`, [mag, wh])   // création réservée à l'admin : l'affectation du responsable se fait ici
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh]))[0].id
const onHand = async (m) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1`, [m]))[0].n)
const day = (n) => `current_date + ${n}`

// --- 1. Demandes d'achat ---------------------------------------------------------------------------------------------------------
const mkDa = (u, reason = 'Collection hiver') => as(u, async () => (await q(`insert into purchase_requests(needed_date, reason) values (${day(20)}, $1) returning *`, [reason]))[0])
const addL = (u, da, m, qty, sup = null) => as(u, () => db.query(`insert into purchase_request_lines(request_id, material_id, qty, supplier_id, needed_date) values ($1,$2,$3,$4,${day(20)})`, [da, m, qty, sup]))
const da1 = await mkDa(prod)
ok('DA créée : code DA-0001, brouillon, demandeur = production', da1.code === 'DA-0001' && da1.status === 'draft' && da1.requested_by === prod && da1.company_id === company)
await rejects('DA refusée sans purchases.request (commercial)', () => mkDa(comm), 'row-level security')
await rejects('soumission refusée : DA vide', () => as(prod, () => rpc('purchase_request_submit', da1.id)), 'PURCHASE_EMPTY')
await addL(prod, da1.id, tissu.id, 100); await addL(prod, da1.id, zip.id, 200); await addL(prod, da1.id, bouton.id, 1000); await addL(prod, da1.id, fil.id, 50)
await rejects('ligne : quantité nulle refusée', () => addL(prod, da1.id, zip.id, 0), 'qty')
await rejects('ligne : fournisseur d’une autre société refusé', async () => { const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id; const fs = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'FOU-9','Étranger','DE') returning id`, [co2]))[0].id; await addL(prod, da1.id, zip.id, 1, fs) }, 'PURCHASE_BAD_SUPPLIER')
const other = await mkDa(mag, 'Demande du magasin')
ok('visibilité : la production ne voit que ses demandes ; finance et achat voient tout', (await as(prod, () => q(`select id from purchase_requests`))).length === 1 && (await as(fin, () => q(`select id from purchase_requests`))).length === 2 && (await as(comm, () => q(`select id from purchase_requests`))).length === 0)
ok('lignes : mêmes règles de visibilité', (await as(prod, () => q(`select id from purchase_request_lines`))).length === 4)
await rejects('un autre demandeur ne peut pas soumettre la DA d’autrui', () => as(mag, () => rpc('purchase_request_submit', da1.id)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('purchase_request_submit', da1.id))
ok('DA soumise', (await q(`select status, submitted_at from purchase_requests where id=$1`, [da1.id]))[0].status === 'submitted')
await rejects('DA soumise : ajout de ligne refusé', () => addL(prod, da1.id, zip.id, 1), 'PURCHASE_LOCKED')
await rejects('DA soumise : modification refusée', () => as(prod, () => db.query(`update purchase_requests set reason='x' where id=$1`, [da1.id])), 'PURCHASE_LOCKED')
await rejects('validation refusée sans purchases.approve (achat)', () => as(buyer, () => rpc('purchase_request_decide', da1.id, true)), 'RBAC_FORBIDDEN')
await rejects('validation refusée sans purchases.approve (production)', () => as(prod, () => rpc('purchase_request_decide', da1.id, true)), 'RBAC_FORBIDDEN')
await rejects('conversion refusée tant que la DA n’est pas validée', () => as(buyer, () => rpc('purchase_request_to_orders', da1.id)), 'PURCHASE_BAD_STATUS')
await as(dir, () => rpc('purchase_request_decide', da1.id, true, 'OK'))
const d1 = (await q(`select * from purchase_requests where id=$1`, [da1.id]))[0]
ok('DA validée (par, quand, commentaire)', d1.status === 'approved' && d1.decided_by === dir && d1.decided_at && d1.decision_comment === 'OK')
await rejects('décision déjà prise', () => as(dir, () => rpc('purchase_request_decide', da1.id, false, 'Non')), 'PURCHASE_BAD_STATUS')
// séparation des tâches
const daAdmin = await mkDa(admin, 'Demande admin'); await addL(admin, daAdmin.id, zip.id, 5); await as(admin, () => rpc('purchase_request_submit', daAdmin.id))
await rejects('auto-validation interdite (séparation des tâches)', () => as(admin, () => rpc('purchase_request_decide', daAdmin.id, true)), 'PURCHASE_SELF_APPROVAL')
await as(admin, () => rpc('purchase_request_cancel', daAdmin.id))
// rejet
const da3 = await mkDa(prod, 'À rejeter'); await addL(prod, da3.id, zip.id, 9); await as(prod, () => rpc('purchase_request_submit', da3.id))
await rejects('rejet : commentaire obligatoire', () => as(dir, () => rpc('purchase_request_decide', da3.id, false)), 'PURCHASE_COMMENT_REQUIRED')
await as(dir, () => rpc('purchase_request_decide', da3.id, false, 'Budget dépassé'))
ok('DA rejetée avec motif', (await q(`select status, decision_comment from purchase_requests where id=$1`, [da3.id]))[0].status === 'rejected')
await rejects('DA rejetée : annulation refusée', () => as(prod, () => rpc('purchase_request_cancel', da3.id)), 'PURCHASE_BAD_STATUS')

// --- 2. De la demande aux bons de commande ------------------------------------------------------------------------------------------------
await setSup(bouton.id, supB)
await rejects('conversion refusée : composant sans fournisseur (fil)', () => as(buyer, () => rpc('purchase_request_to_orders', da1.id)), 'PURCHASE_NO_SUPPLIER')
await setSup(fil.id, supB)
await rejects('conversion refusée sans purchases.write (production)', () => as(prod, () => rpc('purchase_request_to_orders', da1.id)), 'RBAC_FORBIDDEN')
const pos = await as(buyer, () => rpc('purchase_request_to_orders', da1.id))
ok('conversion : un bon de commande par fournisseur (2)', pos.length === 2)
const poRows = await q(`select p.*, s.name sname from purchase_orders p join suppliers s on s.id=p.supplier_id where p.request_id=$1 order by s.name`, [da1.id])
const poA = poRows.find((p) => p.sname === 'Tissus du Sud'), poB = poRows.find((p) => p.sname === 'Mercerie Nord')
ok('BC brouillon liés à la DA, numérotés PO-AAAA-xxxxx', poA.status === 'draft' && poB.status === 'draft' && /^PO-\d{4}-\d{5}$/.test(poA.po_no) && poA.request_id === da1.id)
ok('prix repris du catalogue : BC A = 100×8,50 + 200×1,20 = 1090 ; BC B = 1000×0,15 + 50×0,001 = 150,05', near(poA.total_amount, 1090) && near(poB.total_amount, 150.05), `${poA.total_amount} / ${poB.total_amount}`)
ok('DA passée à « commandée », lignes liées aux lignes de commande', (await q(`select status from purchase_requests where id=$1`, [da1.id]))[0].status === 'ordered' && (await q(`select count(*)::int n from purchase_request_lines where request_id=$1 and po_line_id is not null`, [da1.id]))[0].n === 4)
await rejects('double conversion refusée', () => as(buyer, () => rpc('purchase_request_to_orders', da1.id)), 'PURCHASE_BAD_STATUS')
await rejects('annulation de la DA refusée une fois commandée', () => as(buyer, () => rpc('purchase_request_cancel', da1.id)), 'PURCHASE_BAD_STATUS')

// --- 3. Commande fournisseur : édition, envoi ---------------------------------------------------------------------------------------------
await rejects('statut non modifiable directement', () => as(buyer, () => db.query(`update purchase_orders set status='received' where id=$1`, [poA.id])), 'permission denied')
await rejects('montant non modifiable directement', () => as(buyer, () => db.query(`update purchase_orders set total_amount=1 where id=$1`, [poA.id])), 'permission denied')
await rejects('édition de commande refusée sans purchases.write (magasin)', () => as(mag, () => db.query(`update purchase_order_lines set unit_price=1 where po_id=$1`, [poA.id])).then((r) => { if (!r.affectedRows) throw new Error('row-level security') }), 'row-level security')
const tl = (await q(`select id from purchase_order_lines where po_id=$1 and material_id=$2`, [poA.id, tissu.id]))[0].id
await as(buyer, () => db.query(`update purchase_order_lines set unit_price=9 where id=$1`, [tl]))
ok('prix modifié : total recalculé (100×9 + 240 = 1140)', near((await q(`select total_amount from purchase_orders where id=$1`, [poA.id]))[0].total_amount, 1140))
await as(buyer, () => db.query(`update purchase_order_lines set qty_received=50 where id=$1`, [tl]).catch(() => null))
ok('quantité reçue non modifiable à la main', Number((await q(`select qty_received from purchase_order_lines where id=$1`, [tl]))[0].qty_received) === 0)
const direct = await as(buyer, async () => (await q(`insert into purchase_orders(supplier_id, notes) values ($1,'BC direct') returning *`, [supB]))[0])
ok('BC direct possible (brouillon, total 0, sans DA)', direct.status === 'draft' && Number(direct.total_amount) === 0 && direct.request_id === null)
await rejects('BC direct : statut imposé refusé', () => as(buyer, () => db.query(`insert into purchase_orders(supplier_id, status) values ($1,'received')`, [supB])), 'permission denied')
await rejects('envoi refusé : BC vide', () => as(buyer, () => rpc('purchase_order_send', direct.id)), 'PURCHASE_EMPTY')
await as(buyer, () => db.query(`insert into purchase_order_lines(po_id, material_id, qty_ordered, unit_price) values ($1,$2,10,0.2)`, [direct.id, bouton.id]))
await as(buyer, () => rpc('purchase_order_cancel', direct.id))
ok('BC brouillon annulé', (await q(`select status from purchase_orders where id=$1`, [direct.id]))[0].status === 'cancelled')
await rejects('envoi refusé sans purchases.write', () => as(mag, () => rpc('purchase_order_send', poA.id)), 'RBAC_FORBIDDEN')
await as(buyer, () => db.query(`update purchase_orders set expected_date = current_date - 3 where id=$1`, [poB.id]))
await rejects('envoi refusé sans accord : BC A non approuvé (PO_NOT_APPROVED)', () => as(buyer, () => rpc('purchase_order_send', poA.id)), 'PO_NOT_APPROVED')
await as(admin, () => rpc('approval_policy_set', 'purchase_order', 1, null, 'purchases.approve', null, 'approvals.escalate', 24))
for (const po of [poA, poB]) {
  await as(buyer, () => rpc('purchase_order_submit', po.id))
  const ap = (await q(`select id from approval_requests where object_type='purchase_order' and object_id=$1 and state='pending_l1'`, [po.id]))[0].id
  await as(dir, () => rpc('approval_decide', ap, 'approve', null))
}
await as(buyer, () => rpc('purchase_order_send', poA.id)); await as(buyer, () => rpc('purchase_order_send', poB.id))
const sentA = (await q(`select * from purchase_orders where id=$1`, [poA.id]))[0]
ok('BC envoyé : statut, date, expéditeur ; échéance reprise des lignes', sentA.status === 'sent' && sentA.sent_by === buyer && sentA.sent_at && (await q(`select (expected_date = current_date + 20) ok from purchase_orders where id=$1`, [poA.id]))[0].ok)
await rejects('BC envoyé : ligne non modifiable', () => as(buyer, () => db.query(`update purchase_order_lines set unit_price=1 where id=$1`, [tl])), 'PURCHASE_LOCKED')
await rejects('BC envoyé : en-tête non modifiable', () => as(buyer, () => db.query(`update purchase_orders set notes='x' where id=$1`, [poA.id])), 'PURCHASE_LOCKED')
await rejects('BC envoyé : ajout de ligne refusé', () => as(buyer, () => db.query(`insert into purchase_order_lines(po_id, material_id, qty_ordered) values ($1,$2,1)`, [poA.id, fil.id])), 'PURCHASE_LOCKED')

// annulation d'un BC issu d'une DA : la DA redevient disponible
const da2 = await mkDa(prod, 'Zips'); await addL(prod, da2.id, zip.id, 10); await as(prod, () => rpc('purchase_request_submit', da2.id)); await as(dir, () => rpc('purchase_request_decide', da2.id, true))
const [poC] = await as(buyer, () => rpc('purchase_request_to_orders', da2.id))
await as(buyer, () => rpc('purchase_order_cancel', poC))
ok('BC annulé : DA de nouveau « validée », lignes libérées', (await q(`select status from purchase_requests where id=$1`, [da2.id]))[0].status === 'approved' && (await q(`select count(*)::int n from purchase_request_lines where request_id=$1 and po_line_id is null`, [da2.id]))[0].n === 1)
const [poD] = await as(buyer, () => rpc('purchase_request_to_orders', da2.id))
ok('nouvelle conversion possible après annulation', !!poD)
await as(buyer, () => rpc('purchase_order_cancel', poD))
await as(buyer, () => rpc('purchase_request_cancel', da2.id))
ok('DA annulée', (await q(`select status from purchase_requests where id=$1`, [da2.id]))[0].status === 'cancelled')

// --- 4. Réception → stock automatique ---------------------------------------------------------------------------------------------------
await as(buyer, () => db.query(`update bom_material_prices set unit_cost=10 where material_id=$1`, [tissu.id]))     // le catalogue change : la réception reste au prix commandé
const line = async (po, m) => (await q(`select id from purchase_order_lines where po_id=$1 and material_id=$2`, [po, m]))[0].id
const recv = (u, po, lines, o = {}) => as(u, () => rpc('purchase_receive', po, o.wh ?? wh, o.loc === undefined ? loc : o.loc, JSON.stringify(lines), o.bl ?? null, null))
await rejects('réception refusée sans purchases.receive (commercial)', () => recv(comm, poA.id, [{ line_id: tl, qty: 1 }]), 'RBAC_FORBIDDEN')
await rejects('réception refusée : emplacement obligatoire', () => recv(mag, poA.id, [{ line_id: tl, qty: 1 }], { loc: null }), 'STOCK_LOCATION_REQUIRED')
await rejects('réception refusée : aucune quantité', () => recv(mag, poA.id, [{ line_id: tl, qty: 0 }]), 'PURCHASE_EMPTY')
await rejects('réception refusée : ligne d’une autre commande', async () => recv(mag, poA.id, [{ line_id: await line(poB.id, bouton.id), qty: 1 }]), 'PURCHASE_BAD_LINE')
await rejects('réception refusée : BC non envoyé', () => recv(mag, direct.id, [{ line_id: tl, qty: 1 }]), 'PURCHASE_BAD_STATUS')
const rc1 = await recv(mag, poA.id, [{ line_id: tl, qty: 60 }], { bl: 'BL-4521' })
const rcRow = (await q(`select * from purchase_receipts where id=$1`, [rc1]))[0]
ok('réception : code REC-0001, entrepôt, n° de bon de livraison, réceptionnaire', rcRow.code === 'REC-0001' && rcRow.warehouse_id === wh && rcRow.delivery_note === 'BL-4521' && rcRow.received_by === mag)
ok('stock alimenté automatiquement : 60 m de tissu', (await onHand(tissu.id)) === 60)
const mvt = (await q(`select m.type, m.reference, m.reason, m.qty::float q from stock_movements m join purchase_receipt_lines l on l.movement_id=m.id where l.receipt_id=$1`, [rc1]))[0]
ok('mouvement de stock « entrée » tracé (référence REC-0001 / BL, motif = BC)', mvt.type === 'in' && mvt.reference === 'REC-0001 / BL BL-4521' && mvt.reason === `Réception ${poA.po_no}` && mvt.q === 60)
ok('lot FIFO au prix de la COMMANDE (9,00) et non au prix du catalogue (10,00), même sans costs.read', near((await q(`select c.unit_cost u from stock_lot_costs c join stock_lots l on l.id=c.lot_id where l.material_id=$1`, [tissu.id]))[0].u, 9))
ok('BC partiellement reçu', (await q(`select status from purchase_orders where id=$1`, [poA.id]))[0].status === 'partial' && Number((await q(`select qty_received from purchase_order_lines where id=$1`, [tl]))[0].qty_received) === 60)
await rejects('sur-réception refusée (50 > 40 restants)', () => recv(mag, poA.id, [{ line_id: tl, qty: 50 }]), 'PURCHASE_OVER_RECEIPT')
ok('sur-réception refusée : stock inchangé', (await onHand(tissu.id)) === 60 && (await q(`select count(*)::int n from purchase_receipts`))[0].n === 1)
const zl = await line(poA.id, zip.id)
const rc2 = await recv(mag, poA.id, [{ line_id: tl, qty: 40 }, { line_id: zl, qty: 200 }], { bl: 'BL-4530' })
ok('2e réception : BC soldé, date de réception renseignée, stock = 100 m et 200 zips', (await q(`select status, received_date from purchase_orders where id=$1`, [poA.id]))[0].status === 'received' && (await q(`select received_date is not null ok from purchase_orders where id=$1`, [poA.id]))[0].ok && (await onHand(tissu.id)) === 100 && (await onHand(zip.id)) === 200)
await rejects('BC soldé : nouvelle réception refusée', () => recv(mag, poA.id, [{ line_id: tl, qty: 1 }]), 'PURCHASE_BAD_STATUS')
await rejects('BC reçu : annulation refusée', () => as(buyer, () => rpc('purchase_order_cancel', poA.id)), 'PURCHASE_BAD_STATUS')
ok('réceptions et lignes immuables pour les utilisateurs', await (async () => { try { await as(admin, () => db.query(`update purchase_receipts set notes='x'`)); return false } catch (e) { return String(e.message).includes('permission denied') } })())

// --- 5. Retour fournisseur ----------------------------------------------------------------------------------------------------------------
const rl1 = (await q(`select id from purchase_receipt_lines where receipt_id=$1`, [rc1]))[0].id
await rejects('retour refusé sans purchases.receive', () => as(fin, () => rpc('purchase_return', rc1, JSON.stringify([{ receipt_line_id: rl1, qty: 1 }]), 'Défaut')), 'RBAC_FORBIDDEN')
await rejects('retour : motif obligatoire', () => as(mag, () => rpc('purchase_return', rc1, JSON.stringify([{ receipt_line_id: rl1, qty: 1 }]), '')), 'PURCHASE_REASON_REQUIRED')
const ret1 = await as(mag, () => rpc('purchase_return', rc1, JSON.stringify([{ receipt_line_id: rl1, qty: 10 }]), 'Défaut de teinte'))
ok('retour : code RET-0001, stock diminué (90 m), mouvement « sortie » tracé', (await q(`select code from purchase_returns where id=$1`, [ret1]))[0].code === 'RET-0001' && (await onHand(tissu.id)) === 90
  && (await q(`select m.type, m.reference from stock_movements m join purchase_return_lines l on l.movement_id=m.id where l.return_id=$1`, [ret1]))[0].reference === 'RET-0001')
ok('le retour rouvre le besoin : BC de nouveau « partiellement reçu », date de réception effacée', (await q(`select status, received_date from purchase_orders where id=$1`, [poA.id]))[0].status === 'partial' && (await q(`select received_date is null ok from purchase_orders where id=$1`, [poA.id]))[0].ok)
ok('quantités retournées suivies (ligne de réception et ligne de commande)', Number((await q(`select qty_returned from purchase_receipt_lines where id=$1`, [rl1]))[0].qty_returned) === 10 && Number((await q(`select qty_returned from purchase_order_lines where id=$1`, [tl]))[0].qty_returned) === 10)
await rejects('retour au-delà de la quantité reçue refusé', () => as(mag, () => rpc('purchase_return', rc1, JSON.stringify([{ receipt_line_id: rl1, qty: 55 }]), 'Trop')), 'PURCHASE_OVER_RETURN')
await as(mag, () => db.query(`select public.stock_move(p_type=>'out', p_material=>$1, p_qty=>85, p_warehouse=>$2)`, [tissu.id, wh]))     // il ne reste que 5 m
await rejects('retour impossible si le stock n’est plus là (annulé en bloc)', () => as(mag, () => rpc('purchase_return', rc1, JSON.stringify([{ receipt_line_id: rl1, qty: 10 }]), 'Encore')), 'STOCK_INSUFFICIENT')
ok('retour refusé : rien n’a changé', (await onHand(tissu.id)) === 5 && Number((await q(`select qty_returned from purchase_receipt_lines where id=$1`, [rl1]))[0].qty_returned) === 10 && (await q(`select count(*)::int n from purchase_returns`))[0].n === 1)
await recv(mag, poA.id, [{ line_id: tl, qty: 10 }], { bl: 'BL-4600' })
ok('re-réception du manque (10 m) : BC de nouveau soldé', (await q(`select status from purchase_orders where id=$1`, [poA.id]))[0].status === 'received' && (await onHand(tissu.id)) === 15)

// --- 6. Statistiques ----------------------------------------------------------------------------------------------------------------------
await rejects('statistiques refusées sans purchases.read (production)', () => as(prod, () => rpc('purchase_stats')), 'RBAC_FORBIDDEN')
const st = await as(fin, () => rpc('purchase_stats'))
ok('stats : 2 commandes (envoyées / reçues), montant 1140 + 150,05', st.orders === 2 && near(st.amount, 1290.05), JSON.stringify([st.orders, st.amount]))
ok('stats : 1 commande ouverte (BC B) en retard, 1 reçue à l’heure (100 %)', st.open_count === 1 && st.late_open === 1 && st.received_count === 1 && Number(st.on_time_rate) === 100)
ok('stats : reçu 540 + 360 + 240 + 90 = 1230, retourné 90, taux de retour 7,3 %', near(st.received_amount, 1230) && near(st.returned_amount, 90) && Number(st.return_rate) === 7.3, JSON.stringify([st.received_amount, st.returned_amount, st.return_rate]))
ok('stats : 1er fournisseur = Tissus du Sud (1140, 1 commande, délai moyen calculé)', st.by_supplier[0].name === 'Tissus du Sud' && near(st.by_supplier[0].amount, 1140) && st.by_supplier[0].orders === 1 && st.by_supplier[0].avg_lead_days !== undefined)
ok('stats : composant le plus acheté = tissu (900)', st.top_materials[0].code === tissu.code && near(st.top_materials[0].amount, 900))
ok('stats : 12 mois, entonnoir des demandes (1 commandée, 1 rejetée, 1 en brouillon…)', st.by_month.length === 12 && st.requests.ordered === 1 && st.requests.rejected === 1 && st.requests.avg_approval_hours !== undefined)
const stFuture = await as(fin, () => rpc('purchase_stats', '2000-01-01', '2000-12-31'))
ok('stats : période sans activité', stFuture.orders === 0 && Number(stFuture.amount) === 0)
const supStats = await as(buyer, () => rpc('supplier_purchase_stats', supA))
ok('les statistiques du module Fournisseurs suivent les nouvelles commandes (1 commande, 1 reçue)', supStats.orders_count === 1 && supStats.received_count === 1)

// --- 7. Intégration MRP → demande d'achat ----------------------------------------------------------------------------------------------
const run = (await q(`insert into mrp_runs(company_id, code, name, as_of) values ($1,'MRP-0001','Test', current_date) returning id`, [company]))[0].id
const sg = async (m, qty, sup, need, status) => (await q(`insert into mrp_run_suggestions(run_id, company_id, material_id, supplier_id, qty, need_date, release_date, status) values ($1,$2,$3,$4,$5,current_date + $6::int, current_date, $7) returning id`, [run, company, m, sup, qty, need, status]))[0].id
await sg(zip.id, 30, supA, 10, 'accepted'); await sg(zip.id, 20, supA, 25, 'accepted'); await sg(bouton.id, 400, supB, 12, 'accepted'); await sg(fil.id, 99, supB, 5, 'proposed')
await rejects('DA depuis le MRP refusée sans accès MRP (production n’a pas mrp.write mais mrp.read ; finance non)', () => as(fin, () => rpc('purchase_request_from_mrp', run)), 'RBAC_FORBIDDEN')
const daM = await as(buyer, () => rpc('purchase_request_from_mrp', run))
const mr = (await q(`select * from purchase_requests where id=$1`, [daM]))[0]
const ml = await q(`select m.code, l.qty::float q from purchase_request_lines l join bom_materials m on m.id=l.material_id where l.request_id=$1 order by m.code`, [daM])
ok('DA issue du MRP : source « mrp », suggestions acceptées regroupées par composant (zips 30 + 20 = 50 ; boutons 400)', mr.source === 'mrp' && mr.mrp_run_id === run && ml.length === 2 && ml.find((x) => x.code === zip.code).q === 50 && ml.find((x) => x.code === bouton.code).q === 400)
ok('suggestions converties marquées (la proposée reste libre)', (await q(`select count(*)::int n from mrp_run_suggestions where run_id=$1 and request_id=$2`, [run, daM]))[0].n === 3)
await rejects('pas de seconde DA tant que rien de nouveau n’est accepté', () => as(buyer, () => rpc('purchase_request_from_mrp', run)), 'PURCHASE_NO_SUGGESTION')
await as(buyer, () => rpc('purchase_request_cancel', daM))
ok('DA MRP annulée : suggestions de nouveau disponibles', (await q(`select count(*)::int n from mrp_run_suggestions where run_id=$1 and request_id is not null`, [run]))[0].n === 0)
await rejects('source « mrp » non forgeable à la main', () => as(buyer, () => db.query(`insert into purchase_requests(source, needed_date) values ('mrp', ${day(1)})`)), 'permission denied')

// --- 8. Historique ----------------------------------------------------------------------------------------------------------------------------
const h = await q(`select action from audit_logs where entity_type='purchase'`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['purchase.request_create', 'purchase.request_submit', 'purchase.request_approve', 'purchase.request_reject', 'purchase.request_cancel', 'purchase.request_convert', 'purchase.po_create', 'purchase.po_send', 'purchase.po_cancel', 'purchase.receive', 'purchase.return'])
  ok(`historique : ${a}`, acts.has(a))
ok('historique lisible avec purchases.read, pas sans', (await as(fin, () => q(`select id from audit_logs where entity_type='purchase'`))).length > 0 && (await as(prod, () => q(`select id from audit_logs where entity_type='purchase'`))).length === 0)

process.exit(process.exitCode ?? 0)
