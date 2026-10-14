// Transferts inter-entrepôts et stock en transit : quantités exactes, pas de double réception, propriété respectée — P040 / migration 0065
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
const admin2 = await mkUser('admin2@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')
const recv = await mkUser('recv@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const src = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Source P40','mixed') returning id`, [company]))[0].id
const dst = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Destination P40','mixed') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, src])
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, recv, dst])
const srcGen = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [src]))[0].id
const dstGen = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [dst]))[0].id
const srcQua = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUA','Quarantaine P40','quarantine') returning id`, [company, src]))[0].id
const mat = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P40','fabric','m') returning id`, [company]))[0].id
const otherCo = (await q(`insert into companies(name) values ('Autre société P40') returning id`))[0].id
const otherWh = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Entrepôt autre société P40','mixed') returning id`, [otherCo]))[0].id
const otherLoc = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [otherWh]))[0].id
const transitLoc = (await q(`select private.transit_location($1) l`, [company]))[0].l
const transitWh = (await q(`select warehouse_id w from stock_locations where id=$1`, [transitLoc]))[0].w

const onHand = async (wh) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and warehouse_id=$2`, [mat, wh]))[0].n)
const transitOn = () => onHand(transitWh)
const detail = (u, t) => as(u, () => rpc('stock_transfer_detail', t))
const lineOf = async (t, seq) => (await q(`select id, qty_requested, qty_prepared, qty_shipped, qty_received, qty_lost from stock_transfer_lines where transfer_id=$1 and seq=$2`, [t, seq]))[0]
const statusOf = async (t) => (await q(`select status from stock_transfers where id=$1`, [t]))[0].status
const lines = (...items) => JSON.stringify(items)
const auditCount = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)

// Stock initial : 100 au magasin source
await as(admin, () => rpc('stock_move', 'in', mat, 100, src, srcGen, null, 'BL-IN-P40', 'Stock initial P40', null, null))
await as(admin, () => rpc('material_family_set', mat, 'fabric'))

// 1. Création : brouillon, quantité demandée, numéro TRF
const t1 = await as(mag, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, 'Transfert test', lines({ material_id: mat, qty: 60 })))
const t1h = (await q(`select number, status from stock_transfers where id=$1`, [t1]))[0]
ok('création : brouillon TRF-…, 60 demandés', t1h.status === 'draft' && /^TRF-\d{4}-\d{6}$/.test(t1h.number) && Number((await lineOf(t1, 1)).qty_requested) === 60)

// 2. Refus : même entrepôt, quarantaine, autre société, hors périmètre, entrepôt transit, vide, quantité nulle
await rejects('transfert vers le même entrepôt refusé', () => as(mag, () => rpc('stock_transfer_create', src, srcGen, src, srcGen, null, lines({ material_id: mat, qty: 1 }))), 'TRANSFER_SAME_WAREHOUSE')
await rejects('source en quarantaine refusée (TRANSFER_SOURCE_BLOCKED)', () => as(mag, () => rpc('stock_transfer_create', src, srcQua, dst, dstGen, null, lines({ material_id: mat, qty: 1 }))), 'TRANSFER_SOURCE_BLOCKED')
await rejects('entrepôt d’une autre société refusé (pas de flux intersociétés)', () => as(mag, () => rpc('stock_transfer_create', src, srcGen, otherWh, otherLoc, null, lines({ material_id: mat, qty: 1 }))), 'STOCK_WAREHOUSE_NOT_FOUND')
await rejects('création hors entrepôt source affecté refusée', () => as(recv, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, null, lines({ material_id: mat, qty: 1 }))), 'WAREHOUSE_FORBIDDEN')
await rejects('destination transit refusée (TRANSFER_TRANSIT_RESERVED)', () => as(mag, () => rpc('stock_transfer_create', src, srcGen, transitWh, transitLoc, null, lines({ material_id: mat, qty: 1 }))), 'TRANSFER_TRANSIT_RESERVED')
await rejects('transfert sans ligne refusé', () => as(mag, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, null, '[]')), 'TRANSFER_EMPTY')
await rejects('quantité nulle refusée', () => as(mag, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, null, lines({ material_id: mat, qty: 0 }))), 'TRANSFER_BAD_QTY')

// 3. Préparation : jamais au-delà de la quantité demandée ; seul l'entrepôt source
const l1 = (await lineOf(t1, 1)).id
await rejects('préparation par un utilisateur sans l’entrepôt source refusée', () => as(recv, () => rpc('stock_transfer_prepare', t1, lines({ line_id: l1, qty: 60 }))), 'WAREHOUSE_FORBIDDEN')
await rejects('préparation au-delà de la demande refusée', () => as(mag, () => rpc('stock_transfer_prepare', t1, lines({ line_id: l1, qty: 70 }))), 'TRANSFER_BAD_QTY')
await as(mag, () => rpc('stock_transfer_prepare', t1, lines({ line_id: l1, qty: 60 })))
ok('préparation : 60 préparés, statut « préparé », rien expédié', (await statusOf(t1)) === 'prepared' && Number((await lineOf(t1, 1)).qty_shipped) === 0)

// 4. Expédition : sortie du source, stock en transit exact
await rejects('expédition par un utilisateur sans l’entrepôt source refusée', () => as(recv, () => rpc('stock_transfer_ship', t1)), 'WAREHOUSE_FORBIDDEN')
const sh1 = await as(mag, () => rpc('stock_transfer_ship', t1))
ok('expédition : source 100 → 40, transit 60, statut « expédié »', sh1.qty === 60 && (await onHand(src)) === 40 && (await transitOn()) === 60 && (await statusOf(t1)) === 'shipped')
ok('quantité en transit de la ligne : 60 expédié − 0 reçu − 0 écart = 60', (await detail(admin, t1)).lines[0].in_transit === 60)
await rejects('seconde expédition refusée (TRANSFER_BAD_STATUS)', () => as(mag, () => rpc('stock_transfer_ship', t1)), 'TRANSFER_BAD_STATUS')

// 5. Rapprochement du transit (quantités exactes, écart nul)
const rec0 = await as(admin, () => rpc('stock_transit_reconcile', mat))
ok('rapprochement transit : stock du transit = quantités en transit (60), écart 0', near(rec0.transit_on_hand, 60) && near(rec0.open_in_transit, 60) && near(rec0.difference, 0))
await rejects('rapprochement du transit réservé aux droits d’ajustement', () => as(mag, () => rpc('stock_transit_reconcile', mat)), 'RBAC_FORBIDDEN')

// 6. Réception partielle (25) avec preuve et clé d'idempotence
await rejects('réception par un utilisateur sans l’entrepôt destination refusée', () => as(mag, () => rpc('stock_transfer_receive', t1, 'KEY-P40-RCV1', 'BL-DST-001', lines({ line_id: l1, qty: 25 }))), 'WAREHOUSE_FORBIDDEN')
await rejects('réception sans preuve refusée (TRANSFER_PROOF_REQUIRED)', () => as(recv, () => rpc('stock_transfer_receive', t1, 'KEY-P40-NOPROOF', '  ', lines({ line_id: l1, qty: 25 }))), 'TRANSFER_PROOF_REQUIRED')
await rejects('clé d’idempotence trop courte refusée (TRANSFER_KEY_REQUIRED)', () => as(recv, () => rpc('stock_transfer_receive', t1, 'k1', 'BL-DST-001', lines({ line_id: l1, qty: 25 }))), 'TRANSFER_KEY_REQUIRED')
const r1 = await as(recv, () => rpc('stock_transfer_receive', t1, 'KEY-P40-RCV1', 'BL-DST-001', lines({ line_id: l1, qty: 25 })))
ok('réception partielle : 25 reçus, transit 35, destination 25, statut « partiellement reçu »', r1.status === 'partially_received' && (await onHand(dst)) === 25 && (await transitOn()) === 35)
ok('quantité en transit exacte après réception : 60 − 25 = 35', (await detail(admin, t1)).lines[0].in_transit === 35)

// 7. Pas de double réception : même clé rejouée, sur-réception refusée
await rejects('réception rejouée avec la même clé refusée (TRANSFER_DUPLICATE_RECEIPT)', () => as(recv, () => rpc('stock_transfer_receive', t1, 'KEY-P40-RCV1', 'BL-DST-001', lines({ line_id: l1, qty: 25 }))), 'TRANSFER_DUPLICATE_RECEIPT')
ok('après rejeu : destination toujours 25, transit toujours 35 (aucun mouvement en double)', (await onHand(dst)) === 25 && (await transitOn()) === 35)
await rejects('réception au-delà de ce qui est en transit refusée (TRANSFER_OVER_RECEIPT)', () => as(recv, () => rpc('stock_transfer_receive', t1, 'KEY-P40-OVER', 'BL-DST-002', lines({ line_id: l1, qty: 40 }))), 'TRANSFER_OVER_RECEIPT')
ok('sur-réception refusée : destination 25, transit 35', (await onHand(dst)) === 25 && (await transitOn()) === 35)

// 8. Réception du solde : statut « reçu », transit à zéro
const r2 = await as(recv, () => rpc('stock_transfer_receive', t1, 'KEY-P40-RCV2', 'BL-DST-003', lines({ line_id: l1, qty: 35 })))
ok('réception du solde : statut « reçu », destination 60, transit 0', r2.status === 'received' && (await onHand(dst)) === 60 && (await transitOn()) === 0)
await rejects('réception après clôture refusée (TRANSFER_BAD_STATUS)', () => as(recv, () => rpc('stock_transfer_receive', t1, 'KEY-P40-LATE', 'BL-DST-004', lines({ line_id: l1, qty: 1 }))), 'TRANSFER_BAD_STATUS')
const rcpts = await q(`select proof_ref, qty from stock_transfer_receipts where transfer_id=$1 order by received_at`, [t1])
ok('preuves : 2 réceptions (25 puis 35) avec leur bon de transport', rcpts.length === 2 && Number(rcpts[0].qty) === 25 && rcpts[0].proof_ref === 'BL-DST-001' && rcpts[1].proof_ref === 'BL-DST-003')

// 9. Écart de transit : déclaré, accord par un autre utilisateur, sortie du transit seulement après accord
const t2 = await as(mag, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, null, lines({ material_id: mat, qty: 20 })))
const l2 = (await lineOf(t2, 1)).id
await as(mag, () => rpc('stock_transfer_prepare', t2, lines({ line_id: l2, qty: 20 })))
await as(mag, () => rpc('stock_transfer_ship', t2))
await as(recv, () => rpc('stock_transfer_receive', t2, 'KEY-P40-T2-01', 'BL-T2-001', lines({ line_id: l2, qty: 15 })))
ok('T2 : 20 expédiés, 15 reçus, transit 5, statut « partiellement reçu »', (await statusOf(t2)) === 'partially_received' && (await transitOn()) === 5)
const loss = await as(admin2, () => rpc('stock_transfer_declare_loss', t2, l2, 5, 'Colis manquant au transport'))
ok('écart déclaré : transit toujours 5 (rien ne sort avant accord)', (await transitOn()) === 5 && (await q(`select status from stock_transfer_losses where id=$1`, [loss]))[0].status === 'pending')
await rejects('réception du reliquat refusée tant que l’écart est en attente (TRANSFER_OVER_RECEIPT)', () => as(recv, () => rpc('stock_transfer_receive', t2, 'KEY-P40-T2-02', 'BL-T2-002', lines({ line_id: l2, qty: 5 }))), 'TRANSFER_OVER_RECEIPT')
await rejects('auto-approbation de l’écart refusée (SOD_SELF_APPROVAL)', () => as(admin2, () => rpc('stock_transfer_decide_loss', loss, true)), 'SOD_SELF_APPROVAL')
await rejects('décision d’écart refusée sans droit d’ajustement', () => as(recv, () => rpc('stock_transfer_decide_loss', loss, true)), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('stock_transfer_decide_loss', loss, true))
const lt2 = await lineOf(t2, 1)
ok('écart approuvé : sortie du transit de 5, ligne 20 = 15 reçus + 5 perdus, transit 0, statut « reçu »', near(lt2.qty_lost, 5) && (await transitOn()) === 0 && (await statusOf(t2)) === 'received')
ok('destination : 60 (T1) + 15 (T2) = 75', (await onHand(dst)) === 75)
ok('quantité en transit de la ligne T2 : 20 − 15 − 5 = 0', (await detail(admin, t2)).lines[0].in_transit === 0)

// 10. Écart refusé : la marchandise reste en transit
const t3 = await as(mag, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, null, lines({ material_id: mat, qty: 10 })))
const l3 = (await lineOf(t3, 1)).id
await as(mag, () => rpc('stock_transfer_prepare', t3, lines({ line_id: l3, qty: 10 })))
await as(mag, () => rpc('stock_transfer_ship', t3))
const loss3 = await as(admin2, () => rpc('stock_transfer_declare_loss', t3, l3, 2, 'Emballage abîmé à l’arrivée'))
await as(admin, () => rpc('stock_transfer_decide_loss', loss3, false))
ok('écart refusé : marchandise toujours en transit (10), statut « expédié », aucune sortie', (await transitOn()) === 10 && (await statusOf(t3)) === 'shipped' && (await q(`select status from stock_transfer_losses where id=$1`, [loss3]))[0].status === 'refused')
await rejects('décision déjà prise refusée (TRANSFER_NO_LOSS_PENDING)', () => as(admin, () => rpc('stock_transfer_decide_loss', loss3, true)), 'TRANSFER_NO_LOSS_PENDING')

// 11. Propriété : seul le stock société voyage ; une unité de propriété client n'entre pas dans le stock société
const cli = (await q(`insert into clients(company_id, name, country, currency) values ($1,'Client consignataire P40','TN','EUR') returning id`, [company]))[0].id
const lotC = (await q(`insert into material_lots(company_id, material_id, lot_code, owner_client_id) values ($1,$2,'LOT-CLI-P40',$3) returning id`, [company, mat, cli]))[0].id
const unitC = await as(mag, () => rpc('material_unit_receive', mat, lotC, src, srcGen, 30, 140, 'BAIN-P40', cli, 'Consignation P40'))
const uc = (await q(`select stock_posted, owner_client_id from material_units where id=$1`, [unitC]))[0]
ok('unité client reçue : propriété client, hors stock société (source inchangé à 10)', uc.stock_posted === false && uc.owner_client_id === cli && (await onHand(src)) === 10)
const t4 = await as(mag, () => rpc('stock_transfer_create', src, srcGen, dst, dstGen, null, lines({ material_id: mat, qty: 15 })))
const l4 = (await lineOf(t4, 1)).id
await as(mag, () => rpc('stock_transfer_prepare', t4, lines({ line_id: l4, qty: 15 })))
await rejects('expédition au-delà du stock société refusée : la marchandise cliente n’est pas expédiable (STOCK_INSUFFICIENT)', () => as(mag, () => rpc('stock_transfer_ship', t4)), 'STOCK_INSUFFICIENT')
ok('après refus : transfert toujours « préparé », source inchangé à 10, transit inchangé à 10', (await statusOf(t4)) === 'prepared' && (await onHand(src)) === 10 && (await transitOn()) === 10)
await as(mag, () => rpc('stock_transfer_cancel', t4))
ok('annulation avant expédition : statut « annulé »', (await statusOf(t4)) === 'cancelled')
await rejects('annulation d’un transfert expédié refusée (TRANSFER_BAD_STATUS)', () => as(mag, () => rpc('stock_transfer_cancel', t3)), 'TRANSFER_BAD_STATUS')

// 12. Lecture : périmètre et rapprochement final
await rejects('détail hors périmètre refusé', () => as(nobody, () => rpc('stock_transfer_detail', t1)), 'RBAC_FORBIDDEN')
const rec1 = await as(admin, () => rpc('stock_transit_reconcile', mat))
ok('rapprochement final : transit 10 = quantités en transit 10 (T3), écart 0', near(rec1.transit_on_hand, 10) && near(rec1.open_in_transit, 10) && near(rec1.difference, 0))
ok('journal des transferts : évènements et écarts tracés', (await detail(admin, t2)).events.some((e) => e.event === 'loss_approved')
  && (await detail(admin, t3)).events.some((e) => e.event === 'shipped'))

// 13. Audit
ok('audit : création, préparation, expéditions (3), réceptions (3), écarts déclarés (2) et décidés (2)',
  (await auditCount('stock.transfer_create')) >= 3 && (await auditCount('stock.transfer_ship')) === 3 && (await auditCount('stock.transfer_receive')) === 3
  && (await auditCount('stock.transfer_loss_declare')) === 2 && (await auditCount('stock.transfer_loss_decide')) === 2 && (await auditCount('stock.transfer_cancel')) === 1)
