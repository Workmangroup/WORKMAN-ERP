// Commandes et reliquats — P027 / migration 0052 : reliquat, livraison partielle, annulation motivée,
// versions des engagements, échéanciers, annulation après production (consommation conservée).
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n

const company = (await q(`select id from companies`))[0].id
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, u, wh, r])
const admin = await mkUser('admin@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')
const prod = await mkUser('prod@x.com', 'production')
const dir = await mkUser('dir@x.com', 'direction')
const nobody = await mkUser('nobody@x.com', null)
const fin = await mkUser('fin@x.com', 'finance')

// Fixtures : entrepôt, client, article, variante, stock (même socle que le test d'expédition)
await as(fin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))   // taux de TVA signé (règle P017)
// Lots de test pour les expéditions (P030) : lot inséré sans mouvement de stock, affecté par la fonction officielle
const lotFor = async (shipment) => {
  const lines = (await q(`select sl.id, sl.variant_id, sl.qty_picked from shipment_lines sl where sl.shipment_id=$1 and sl.qty_picked>0
    and not exists (select 1 from shipment_line_lots a where a.shipment_line_id=sl.id)`, [shipment]))
  for (const l of lines) {
    const lot = (await db.query(`insert into finished_lots(company_id, lot_code, variant_id, warehouse_id, qty_in, origin) values ($1,$2,$3,$4,$5,'receipt') returning id`,
      [company, 'LOT-T-' + l.id.slice(0, 8), l.variant_id, wh.id, l.qty_picked])).rows[0].id
    await as(mag, () => rpc('shipment_line_lot_assign', l.id, lot, l.qty_picked))
  }
}
const wh = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Expédition Sfax P027','finished_goods') returning *`))[0])
await grant(mag, wh.id, 'operator')
const client = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT P027','TN') returning id`)))[0].id
const artA = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-P27','Veste P027','jacket') returning id`, [client])))[0].id
const prodA = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Veste P027','jacket',$2) returning id`, [client, artA])))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodA, [colJaune], [sizeS]))
const vA = (await q(`select id from product_variants where product_id=$1`, [prodA]))[0].id
await as(admin, () => q(`update product_variants set price = 25 where id=$1`, [vA]))
await as(admin, () => rpc('variant_stock_move', vA, 'receipt', wh.id, 300, null, 'Stock initial P027', null))

const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }
const newOrder = async (lines) => {
  const id = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
  for (const [qty, days] of lines) await as(admin, () => q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,$3,$4)`, [id, artA, qty, iso(days)]))
  return id
}
const lineOf = async (order, pos = 0) => (await q(`select id, qty, qty_delivered, qty_cancelled from sales_order_lines where order_id=$1 order by due_date, created_at, id`, [order]))[pos]

// ---------------------------------------------------------------------------------------------------------------------
// 1. Critère : 100 commandées, 60 livrées → 40 restantes, historique intact
// ---------------------------------------------------------------------------------------------------------------------
const A = await newOrder([[100, 5]])
await as(admin, () => rpc('sales_order_confirm', A))
const vers0 = await count(`select count(*)::int n from sales_order_versions where order_id=$1`, [A])
ok('confirmation : première version d’engagement enregistrée automatiquement', vers0 === 1 && (await q(`select label from sales_order_versions where order_id=$1`, [A]))[0].label === 'confirmed')
const rem0 = await as(admin, () => rpc('order_remaining', A))
ok('avant livraison : 100 commandées, 0 livrée, 100 restantes', rem0.totals.qty === 100 && rem0.totals.delivered === 0 && rem0.totals.remaining === 100 && rem0.state === 'confirmed', JSON.stringify(rem0.totals))

const S1 = await as(mag, () => rpc('shipment_create', A, wh.id, null, null, 'EUR'))
const L1 = await as(mag, () => rpc('shipment_add_line', S1, vA, 60))
ok('ligne d’expédition rattachée à la ligne de commande', (await q(`select order_line_id from shipment_lines where id=$1`, [L1]))[0].order_line_id === (await lineOf(A)).id)
await as(mag, () => rpc('shipment_pick', L1, 60))
await as(mag, () => rpc('shipment_pack', S1, 2, 70, 60))
await lotFor(S1)
await as(mag, () => rpc('shipment_ship', S1, 'DHL', 'TRK-P27'))
await as(mag, () => rpc('shipment_deliver', S1))

const rem1 = await as(admin, () => rpc('order_remaining', A))
ok('100 commandées et 60 livrées : 40 restantes', rem1.totals.qty === 100 && rem1.totals.delivered === 60 && rem1.totals.remaining === 40, JSON.stringify(rem1.totals))
ok('état : livraison partielle', rem1.state === 'partially_delivered')
ok('historique intact : version « confirmed » inchangée (100 commandées)', Number((await q(`select (snapshot->'lines'->0->>'qty')::numeric q from sales_order_versions where order_id=$1 and seq=1`, [A]))[0].q) === 100)
ok('historique intact : expédition livrée toujours présente et tracée', (await q(`select status from shipments where id=$1`, [S1]))[0].status === 'delivered' && (await count(`select count(*)::int n from shipment_events where shipment_id=$1`, [S1])) >= 3)
ok('livraison comptée une seule fois : relance refusée', await as(mag, () => rpc('shipment_deliver', S1)).then(() => false, () => true))
ok('livré d’une ligne confirmée en base : refusé (ORDER_LOCKED avant la garde)', await db.query(`update sales_order_lines set qty_delivered = 99 where order_id=$1`, [A]).then(() => false, (e) => /ORDER_LOCKED/.test(e.message)))
const Dd = await newOrder([[7, 18]])
ok('livré d’une ligne de brouillon en base : refusé (garde de livraison)', await db.query(`update sales_order_lines set qty_delivered = 3 where order_id=$1`, [Dd]).then(() => false, (e) => /ORDER_FULFILMENT_LOCKED/.test(e.message)))
await rejects('saisie directe du livré par un utilisateur refusée (droits colonnes)', () => as(admin, () => db.query(`update sales_order_lines set qty_delivered = 0 where order_id=$1`, [A])), 'permission denied')

// Expédition en cours : pas d'annulation tant qu'une expédition est ouverte
const S2 = await as(mag, () => rpc('shipment_create', A, wh.id, null, null, 'EUR'))
await as(mag, () => rpc('shipment_add_line', S2, vA, 40))
await rejects('annulation refusée : expédition en cours', () => as(admin, () => rpc('order_cancel', A, 'Client a annulé le reliquat')), 'ORDER_HAS_OPEN_SHIPMENTS')
const S3 = await as(mag, () => rpc('shipment_create', A, wh.id, null, null, 'EUR'))
await rejects('reliquat déjà réservé par S2 : ligne supplémentaire refusée', () => as(mag, () => rpc('shipment_add_line', S3, vA, 1)), 'SHIPPING_QTY_EXCEEDS_ORDER')
await as(mag, () => rpc('shipment_cancel', S3, 'Expédition de contrôle annulée'))
await as(mag, () => rpc('shipment_cancel', S2, 'Expédition annulée avant prélèvement'))
await rejects('statut direct « annulée » refusé dès qu’il y a de l’activité', () => as(admin, () => rpc('sales_order_set_status', A, 'cancelled')), 'ORDER_HAS_ACTIVITY')

// Annulation motivée du reliquat : le livré reste, le reliquat est annulé, versions ajoutées
await rejects('annulation sans motif refusée', () => as(admin, () => rpc('order_cancel', A, 'non')), 'ORDER_REASON_REQUIRED')
const cancelA = await as(admin, () => rpc('order_cancel', A, 'Client a annulé le reliquat'))
ok('annulation du reliquat : 40 annulées, 60 livrées conservées, commande non supprimée', cancelA.cancelled_qty === 40 && cancelA.delivered_qty === 60 && cancelA.status === 'confirmed' && cancelA.full === false, JSON.stringify(cancelA))
const rem2 = await as(admin, () => rpc('order_remaining', A))
ok('après annulation : reliquat nul, état « clôturée avec annulation »', rem2.totals.remaining === 0 && rem2.totals.cancelled === 40 && rem2.totals.delivered === 60 && rem2.state === 'closed_with_cancellation')
ok('historique intact : versions 1 (confirmation) et 2 (annulation motivée) conservées', (await count(`select count(*)::int n from sales_order_versions where order_id=$1`, [A])) === 2 && (await q(`select reason from sales_order_versions where order_id=$1 and seq=2`, [A]))[0].reason === 'Client a annulé le reliquat')
ok('historique intact : livraison et mouvements de stock de sortie inchangés', (await count(`select count(*)::int n from shipment_lines where shipment_id=$1 and qty_shipped=60`, [S1])) === 1 && (await count(`select count(*)::int n from variant_stock_moves where reference=(select number from shipments where id=$1) and move_type='issue'`, [S1])) >= 1)
await rejects('version d’engagement : modification refusée (ajout seul)', () => db.query(`update sales_order_versions set reason='falsifié' where order_id=$1`, [A]), 'APPEND_ONLY')
ok('audit : annulation motivée tracée avec motif et quantité livrée', (await count(`select count(*)::int n from audit_logs where action='order.cancel' and entity_id=$1 and (metadata->>'delivered_qty')::numeric = 60 and metadata->>'reason' = 'Client a annulé le reliquat'`, [A])) === 1)

// ---------------------------------------------------------------------------------------------------------------------
// 2. Modification d'engagement après confirmation : nouvelle version, plancher, échéancier figé
// ---------------------------------------------------------------------------------------------------------------------
const B = await newOrder([[10, 20]])
await as(admin, () => rpc('sales_order_confirm', B))
const LB = await lineOf(B)
await rejects('modification sans motif refusée', () => as(admin, () => rpc('order_amend_line', LB.id, 12, null, 'ok')), 'ORDER_REASON_REQUIRED')
ok('modification : 10 → 12 avec motif, version 2 « amended »', (await as(admin, () => rpc('order_amend_line', LB.id, 12, null, 'Client a ajouté deux pièces'))) === 2)
ok('la version 2 garde le motif et la quantité modifiée', Number((await q(`select (snapshot->'lines'->0->>'qty')::numeric q from sales_order_versions where order_id=$1 and seq=2`, [B]))[0].q) === 12 && (await q(`select reason from sales_order_versions where order_id=$1 and seq=2`, [B]))[0].reason === 'Client a ajouté deux pièces')
await rejects('modification : direction sans droit d’écriture commande refusée', () => as(dir, () => rpc('order_amend_line', LB.id, 8, null, 'Demande de la direction')), 'RBAC_FORBIDDEN')
const D = await newOrder([[12, 30]])
const LD = (await lineOf(D)).id
await rejects('échéancier : somme différente de la quantité refusée', () => as(admin, () => rpc('order_set_schedule', LD, [iso(30), iso(40)], [5, 6])), 'ORDER_SCHEDULE_MISMATCH')
ok('échéancier en brouillon : 5 + 7 = 12 enregistré', (await as(admin, () => rpc('order_set_schedule', LD, [iso(30), iso(40)], [5, 7]))) === 2)
await as(admin, () => rpc('sales_order_confirm', D))
await rejects('échéancier figé après confirmation', () => as(admin, () => rpc('order_set_schedule', LD, [iso(30)], [12])), 'ORDER_LOCKED')
await rejects('modification de quantité refusée tant qu’un échéancier existe', () => as(admin, () => rpc('order_amend_line', LD, 14, null, 'Augmentation test P027')), 'ORDER_SCHEDULE_LOCKED')
await rejects('modification d’une commande en brouillon refusée (version seulement après confirmation)', async () => {
  const E = await newOrder([[5, 9]])
  const LE = (await lineOf(E)).id
  return as(admin, () => rpc('order_amend_line', LE, 6, null, 'Brouillon à modifier'))
}, 'ORDER_BAD_STATUS')
await as(admin, () => rpc('order_set_delivery_address', B, '12 rue du Test, 3000 Sfax'))
ok('adresse de livraison enregistrée sur la commande confirmée', (await q(`select delivery_address from sales_orders where id=$1`, [B]))[0].delivery_address === '12 rue du Test, 3000 Sfax')
await rejects('adresse de livraison : commande annulée refusée', async () => {
  const F = await newOrder([[3, 11]])
  await as(admin, () => rpc('order_cancel', F, 'Commande créée par erreur'))
  return as(admin, () => rpc('order_set_delivery_address', F, '1 rue annulée, 3000 Sfax'))
}, 'ORDER_BAD_STATUS')

// Brouillon annulé : annulation complète, pas de version (rien n'a été engagé)
const G = await newOrder([[4, 15]])
const cancelG = await as(admin, () => rpc('order_cancel', G, 'Saisie en double'))
ok('brouillon annulé entièrement, sans version d’engagement', cancelG.status === 'cancelled' && cancelG.full === true && (await count(`select count(*)::int n from sales_order_versions where order_id=$1`, [G])) === 0)

// ---------------------------------------------------------------------------------------------------------------------
// 3. Annulation après production : la consommation et les coûts ne sont pas supprimés
// ---------------------------------------------------------------------------------------------------------------------
const wc = (await as(prod, () => q(`insert into work_centers(code, name, kind, hours_per_day, efficiency_pct) values ('COU-P27','Couture P27','couture',8,85) returning id`)))[0].id
const H = await newOrder([[30, 25]])
await as(admin, () => rpc('sales_order_confirm', H))
const po = await as(prod, () => rpc('production_order_create', artA, 30, 20, wc, iso(0), iso(20), H, 'Lot P027'))
await as(prod, () => rpc('production_order_launch', po))
await as(prod, () => rpc('production_order_log', po, iso(0), 4, 12, 1, 'Saisie test P027'))
const logsBefore = await count(`select count(*)::int n from production_logs where order_id=$1`, [po])
const cancelH = await as(admin, () => rpc('order_cancel', H, 'Client annule après lancement de production'))
ok('annulation après production : commande gardée, reliquat annulé, ordre de fabrication conservé', cancelH.full === false && cancelH.production_orders_kept === 1 && cancelH.cancelled_qty === 30, JSON.stringify(cancelH))
ok('consommation de production conservée (saisies inchangées)', (await count(`select count(*)::int n from production_logs where order_id=$1`, [po])) === logsBefore && logsBefore === 1)
ok('ordre de fabrication lié à la commande toujours présent', (await count(`select count(*)::int n from production_orders where id=$1 and sales_order_id=$2`, [po, H])) === 1)
await rejects('statut direct « annulée » refusé avec ordre de fabrication lié', () => as(admin, () => rpc('sales_order_set_status', H, 'cancelled')), 'ORDER_HAS_ACTIVITY')

// ---------------------------------------------------------------------------------------------------------------------
// 4. Visibilité et verrouillage
// ---------------------------------------------------------------------------------------------------------------------
ok('versions d’engagement invisibles sans droit (RLS)', (await as(nobody, () => q(`select count(*)::int n from sales_order_versions`)))[0].n === 0)
ok('reliquats lisibles par la direction (orders.read)', (await as(dir, () => rpc('order_remaining', B))).totals.remaining === 0 + (await as(admin, () => rpc('order_remaining', B))).totals.remaining)
await rejects('reliquat inconnu : refus', () => as(admin, () => rpc('order_remaining', '00000000-0000-0000-0000-000000000001')), 'ORDER_NOT_FOUND')

console.log('commandes et reliquats : fin des contrôles')
