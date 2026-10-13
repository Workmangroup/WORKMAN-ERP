// Livraisons BL et retours — P030 / migration 0055
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, u, wh, r])
const admin = await mkUser('admin@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')
const qual = await mkUser('qual@x.com', 'qualite')
const comm = await mkUser('com@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const fin = await mkUser('fin@x.com', 'finance')

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

// Fixtures : entrepôt, client, article, variante, lots de produits finis
const wh = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Expédition P030','finished_goods') returning *`))[0])
await grant(mag, wh.id, 'operator')
const client = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('Client livraisons P030','TN','EUR',true) returning id`)))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LIV-30','Veste P030','jacket') returning id`, [client])))[0].id
const prodV = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Veste P030','jacket',$2) returning id`, [client, art])))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJaune], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
await as(admin, () => q(`update product_variants set price = 25 where id=$1`, [vV]))

const LA = await as(admin, () => rpc('finished_lot_receive', vV, wh.id, 'LOT-A-30', 100, 'OF-P30-1'))
const stockOf = async () => Number((await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [vV, wh.id]))[0].qty_on_hand)
ok('lot A reçu : 100 pièces en stock et au lot', (await stockOf()) === 100 && (await q(`select qty_in, status from finished_lots where id=$1`, [LA]))[0].status === 'released')
await rejects('réception de lot refusée au commercial (stock.write réservé)', () => as(comm, () => rpc('finished_lot_receive', vV, wh.id, 'LOT-X', 5, null)), 'RBAC_FORBIDDEN')

const order = async (qty) => {
  const id = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
  await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,$5,25,$6)`, [company, id, art, vV, qty, iso(20)])
  await as(admin, () => rpc('sales_order_confirm', id))
  return id
}
const O1 = await order(10)
const O2 = await order(30)

// Expédition 1 : BL, lots affectés, sortie unique
const S1 = await as(mag, () => rpc('shipment_create', O1, wh.id, null, null, 'EUR'))
const L1 = await as(mag, () => rpc('shipment_add_line', S1, vV, 10))
await as(mag, () => rpc('shipment_pick', L1, 10))
await as(mag, () => rpc('shipment_pack', S1, 1, 12, 10))
await rejects('expédition sans lot affecté refusée (SHIPPING_LOT_REQUIRED)', () => as(mag, () => rpc('shipment_ship', S1, 'DHL', 'TRK-30')), 'SHIPPING_LOT_REQUIRED')
const AS1 = await as(mag, () => rpc('shipment_line_lot_assign', L1, LA, 10))
const BL1 = await as(mag, () => rpc('shipment_ship', S1, 'DHL', 'TRK-30'))
ok('BL émis à l’expédition', /^BL-\d{4}-\d{6}$/.test(BL1))
ok('après expédition : stock 90, lot A consommé de 10', (await stockOf()) === 90 && (await q(`select qty_out from finished_lots where id=$1`, [LA]))[0].qty_out === 10)

// BL répété : aucune seconde sortie
await rejects('BL répété : second envoi refusé', () => as(mag, () => rpc('shipment_ship', S1, 'DHL', 'TRK-30')), 'SHIPPING_BAD_STATUS')
ok('BL répété : stock et lot inchangés (pas de double sortie)', (await stockOf()) === 90 && (await q(`select qty_out from finished_lots where id=$1`, [LA]))[0].qty_out === 10)
ok('BL répété : une seule sortie de stock pour l’expédition', (await count(`select count(*)::int n from variant_stock_moves where reference=(select number from shipments where id=$1) and move_type='issue'`, [S1])) === 1)
const re1 = await as(mag, () => rpc('bl_reprint', S1))
const re2 = await as(mag, () => rpc('bl_reprint', S1))
ok('reprint de BL : même numéro, sans nouvel effet de stock', re1.bl_number === BL1 && re2.bl_number === BL1 && (await stockOf()) === 90)
await rejects('affectation de lot après expédition refusée', () => as(mag, () => rpc('shipment_line_lot_assign', L1, LA, 1)), 'SHIPPING_BAD_STATUS')

// Confirmation de livraison idempotente
const c1 = await as(mag, () => rpc('delivery_confirm', S1, 'livraison-30-key-1', 'Réceptionnaire Sfax'))
const c2 = await as(mag, () => rpc('delivery_confirm', S1, 'livraison-30-key-1', 'Réceptionnaire Sfax'))
ok('confirmation : rejouée avec la même clé, même confirmation, sans effet', c1.replayed === false && c2.replayed === true && c1.confirmation_id === c2.confirmation_id)
await rejects('confirmation avec une autre clé refusée (déjà confirmée)', () => as(mag, () => rpc('delivery_confirm', S1, 'livraison-30-key-2', 'Autre personne')), 'DELIVERY_ALREADY_CONFIRMED')
ok('livraison : quantité livrée sur la commande une seule fois', (await q(`select qty_delivered from sales_order_lines where order_id=$1`, [O1]))[0].qty_delivered === '10.00')
ok('confirmation tracée dans l’audit', (await count(`select count(*)::int n from audit_logs where action='delivery.confirm' and entity_id=$1`, [S1])) === 1)

// Lot non conforme : jamais expédié
const LB = await as(admin, () => rpc('finished_lot_receive', vV, wh.id, 'LOT-B-30', 50, 'OF-P30-2'))
await rejects('lot NC : marquage refusé sans motif', () => as(qual, () => rpc('finished_lot_mark_nc', LB, 'nok')), 'LOT_REASON_REQUIRED')
await as(qual, () => rpc('finished_lot_mark_nc', LB, 'Couture défectueuse constatée au contrôle'))
ok('lot B non conforme : statut NC et stock restant bloqué (hors promesse)', (await q(`select status from finished_lots where id=$1`, [LB]))[0].status === 'nc' && (await count(`select count(*)::int n from variant_stock_blocks where variant_id=$1 and status='active'`, [vV])) === 1)

const S3 = await as(mag, () => rpc('shipment_create', O2, wh.id, null, null, 'EUR'))
const L3 = await as(mag, () => rpc('shipment_add_line', S3, vV, 20))
await as(mag, () => rpc('shipment_pick', L3, 20))
await as(mag, () => rpc('shipment_pack', S3, 1, 25, 20))
await rejects('lot NC non vendu : affectation refusée', () => as(mag, () => rpc('shipment_line_lot_assign', L3, LB, 20)), 'LOT_NOT_RELEASED')
await as(mag, () => rpc('shipment_line_lot_assign', L3, LA, 20))
await as(mag, () => rpc('shipment_ship', S3, 'DHL', 'TRK-31'))
ok('lot NC jamais consommé (qty_out 0) malgré la présence de stock', (await q(`select qty_out from finished_lots where id=$1`, [LB]))[0].qty_out === 0)
const remShipped = await as(admin, () => rpc('order_remaining', O2))
ok('BL partiel expédié : 30 commandées, rien encore livré (reliquat 30 tant que le client n’a pas reçu)', remShipped.totals.remaining === 30 && remShipped.totals.delivered === 0, JSON.stringify(remShipped.totals))
await as(mag, () => rpc('delivery_confirm', S3, 'livraison-30-partielle-key', 'Réceptionnaire Sfax (partiel)'))
const rem = await as(admin, () => rpc('order_remaining', O2))
ok('BL partiel livré : 20 livrées sur 30, reliquat 10', rem.totals.qty === 30 && rem.totals.remaining === 10 && rem.totals.delivered === 20, JSON.stringify(rem.totals))

// Retours : demande, réception, inspection qualité, règlement — hors avoir et remboursement
const credits0 = await count(`select count(*)::int n from credit_notes`, [])
const lineS1 = (await q(`select id from shipment_lines where shipment_id=$1`, [S1]))[0].id
const R1 = await as(mag, () => rpc('return_request', lineS1, 3, 'Pièces retournées pour défaut de finition', LA, 'damaged'))
await rejects('retour au-delà de la quantité expédiée refusé', () => as(mag, () => rpc('return_request', lineS1, 8, 'Retour trop important test', LA, 'good')), 'RETURN_QTY_EXCEEDS_SHIPPED')
await rejects('retour d’un lot non affecté à la ligne refusé', () => as(mag, () => rpc('return_request', lineS1, 1, 'Retour lot étranger', LB, 'good')), 'RETURN_LOT_MISMATCH')
await rejects('règlement avant réception refusé', () => as(mag, () => rpc('return_settle', R1)), 'RETURN_BAD_STATUS')
await as(mag, () => rpc('return_receive', R1, 'damaged'))
const insp1 = await as(qual, () => rpc('return_open_inspection', R1))
await rejects('règlement avant décision qualité refusé', () => as(mag, () => rpc('return_settle', R1)), 'RETURN_DECISION_PENDING')
await as(qual, () => rpc('quality_inspection_decide', insp1, 'accepted', 'Pièces remises en état conformes'))
const st1 = await as(mag, () => rpc('return_settle', R1))
ok('retour accepté : remis en stock vendable (90 + 50 du lot NC − 20 + 3 = 123, dont 50 bloqués)', st1.status === 'accepted' && (await stockOf()) === 123 && (await count(`select count(*)::int n from variant_stock_blocks where variant_id=$1 and status='active' and qty=50`, [vV])) === 1, JSON.stringify({ st1, stock: await stockOf() }))
ok('retour accepté : lot de retour libéré et tracé', (await q(`select status, origin, qty_in from finished_lots where id=$1`, [st1.lot_id]))[0].status === 'released' && (await q(`select origin from finished_lots where id=$1`, [st1.lot_id]))[0].origin === 'return')

const lineS1b = (await q(`select id from shipment_lines where shipment_id=$1`, [S1]))[0].id
const R2 = await as(mag, () => rpc('return_request', lineS1b, 2, 'Retour de deux pièces non conformes', LA, 'unknown'))
await as(mag, () => rpc('return_receive', R2, 'unknown'))
const insp2 = await as(qual, () => rpc('return_open_inspection', R2))
await as(qual, () => rpc('quality_inspection_decide', insp2, 'rejected', 'Défaut de couture non réparable'))
const before2 = await stockOf()
const st2 = await as(mag, () => rpc('return_settle', R2))
ok('retour refusé : lot NC créé, rien ajouté au stock vendable', st2.status === 'rejected' && (await q(`select status from finished_lots where id=$1`, [st2.lot_id]))[0].status === 'nc' && (await stockOf()) === before2)
ok('retour et avoir séparés : aucun avoir créé par les retours', (await count(`select count(*)::int n from credit_notes`, [])) === credits0)
await rejects('retour réglé : second règlement refusé', () => as(mag, () => rpc('return_settle', R2)), 'RETURN_BAD_STATUS')
ok('audit : réception, NC, retour et règlement tracés', (await count(`select count(*)::int n from audit_logs where action in ('lot.receive','lot.nc','return.request','return.receive','return.settle','bl.reprint')`)) >= 6)

// Droits et visibilité
await rejects('réception de retour refusée à la qualité (shipments.write réservé)', () => as(qual, () => rpc('return_receive', R2, 'good')), 'RBAC_FORBIDDEN')
ok('lots invisibles sans droit (RLS)', (await as(nobody, () => q(`select count(*)::int n from finished_lots`)))[0].n === 0)
await rejects('lot : écriture directe refusée', () => as(admin, () => db.query(`update finished_lots set qty_out = 0 where id=$1`, [LA])), 'permission denied')

console.log('livraisons BL et retours : fin des contrôles')
