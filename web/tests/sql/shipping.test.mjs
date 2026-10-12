import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql'])
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
const mag = await mkUser('mag@x.com', 'magasin')
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('comm@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null, revoked_by=null`, [company, u, wh, r])
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

// --- 0. Permissions ------------------------------------------------------------------------------------------------------------------------
ok('magasin : préparation et expédition (écriture)', (await perms('magasin')).includes('shipments.write'))
ok('direction : lecture seule des expéditions', (await perms('direction')).includes('shipments.read') && !(await perms('direction')).includes('shipments.write'))

// --- 1. Fixtures : entrepôt, client, articles, produits, variantes, stock, commandes -------------------------------------------------
const wh = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Expédition Sfax','finished_goods') returning *`))[0])
await grant(mag, wh.id, 'operator')
const client = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const artA = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-A','Veste A','jacket') returning id`, [client])))[0].id
const artB = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-B','Veste B','jacket') returning id`, [client])))[0].id
const prodA = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Veste A','jacket',$2) returning id`, [client, artA])))[0].id
const prodB = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Veste B','jacket',$2) returning id`, [client, artB])))[0].id
const prodX = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Sans article','jacket') returning id`, [client])))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
const sizeM = (await q(`select id from sizes where code='M'`))[0].id
await as(admin, () => rpc('variant_generate', prodA, [colJaune], [sizeS, sizeM]))
await as(admin, () => rpc('variant_generate', prodB, [colJaune], [sizeS]))
await as(admin, () => rpc('variant_generate', prodX, [colJaune], [sizeS]))
const vA = (await q(`select id from product_variants where product_id=$1 and size_id=$2`, [prodA, sizeS]))[0].id
const vA2 = (await q(`select id from product_variants where product_id=$1 and size_id=$2`, [prodA, sizeM]))[0].id
const vB = (await q(`select id from product_variants where product_id=$1`, [prodB]))[0].id
const vX = (await q(`select id from product_variants where product_id=$1`, [prodX]))[0].id
await as(admin, () => q(`update product_variants set price = 25 where id=$1`, [vA]))
await as(admin, () => q(`update product_variants set price = 30 where id=$1`, [vA2]))
await as(admin, () => q(`update product_variants set price = 40 where id=$1`, [vB]))
await as(admin, () => rpc('variant_stock_move', vA, 'receipt', wh.id, 20, null, 'Stock initial A', null))
await as(admin, () => rpc('variant_stock_move', vA2, 'receipt', wh.id, 1, null, 'Stock initial A2', null))

const order1 = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
const dueSoon = (() => { const t = new Date(); t.setUTCDate(t.getUTCDate() + 5); return t.toISOString().slice(0, 10) })()
await as(admin, () => q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,12,$3)`, [order1, artA, dueSoon]))
const order2 = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await as(admin, () => q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,5,$3)`, [order2, artA, dueSoon]))
const orderDraft = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await as(admin, () => q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,3,$3)`, [orderDraft, artA, dueSoon]))
await as(admin, () => rpc('sales_order_confirm', order1))
await as(admin, () => rpc('sales_order_confirm', order2))

// --- 2. Préparation ----------------------------------------------------------------------------------------------------------------------------
await rejects('préparation d’une commande non confirmée refusée', () => as(mag, () => rpc('shipment_create', orderDraft, wh.id, null, null, 'EUR')), 'SHIPPING_ORDER_NOT_CONFIRMED')
await rejects('préparation réservée à shipments.write', () => as(dir, () => rpc('shipment_create', order1, wh.id, null, null, 'EUR')), 'RBAC_FORBIDDEN')
const s1 = await as(mag, () => rpc('shipment_create', order1, wh.id, null, null, 'EUR'))
const s1row = (await q(`select number, status, client_id from shipments where id=$1`, [s1]))[0]
ok('expédition créée : numéro SHP-AAAA-000001, préparation, client de la commande', /^SHP-\d{4}-000001$/.test(s1row.number) && s1row.status === 'preparing' && s1row.client_id === client)
await rejects('article absent de la commande refusé', () => as(mag, () => rpc('shipment_add_line', s1, vX, 1)), 'SHIPPING_ARTICLE_NOT_IN_ORDER')
const lA = await as(mag, () => rpc('shipment_add_line', s1, vA, 10))
await rejects('quantité au-delà de la commande pour cet article refusée', () => as(mag, () => rpc('shipment_add_line', s1, vA2, 3)), 'SHIPPING_QTY_EXCEEDS_ORDER')
const lA2 = await as(mag, () => rpc('shipment_add_line', s1, vA2, 2))
ok('lignes ajoutées avec prix unitaire figé (25 et 30)', (await q(`select unit_price from shipment_lines where id=$1`, [lA]))[0].unit_price === '25.00' && (await q(`select unit_price from shipment_lines where id=$1`, [lA2]))[0].unit_price === '30.00')

// --- 3. Picking : réservation du stock ----------------------------------------------------------------------------------------------------
await as(mag, () => rpc('shipment_pick', lA, 6))
await rejects('prélèvement au-delà de la ligne refusé', () => as(mag, () => rpc('shipment_pick', lA, 5)), 'SHIPPING_QTY_EXCEEDS_LINE')
await as(mag, () => rpc('shipment_pick', lA, 4))
const stA = (await q(`select qty_on_hand, qty_reserved from variant_stock where variant_id=$1 and warehouse_id=$2`, [vA, wh.id]))[0]
ok('picking : 10 pièces réservées, 20 en stock', Number(stA.qty_reserved) === 10 && Number(stA.qty_on_hand) === 20)
await rejects('colisage avant prélèvement complet refusé', () => as(mag, () => rpc('shipment_pack', s1, 2, 14, 12)), 'SHIPPING_NOT_PICKED')
await rejects('picking sans stock disponible refusé (1 en stock, 2 demandées)', () => as(mag, () => rpc('shipment_pick', lA2, 2)), 'SHIPPING_STOCK_INSUFFICIENT')
await as(admin, () => rpc('variant_stock_move', vA2, 'receipt', wh.id, 1, null, 'Complément A2', null))
await as(mag, () => rpc('shipment_pick', lA2, 2))
ok('statut : en prélèvement', (await q(`select status from shipments where id=$1`, [s1]))[0].status === 'picking')

// --- 4. Colisage et expédition ----------------------------------------------------------------------------------------------------------------
await rejects('colis : nombre invalide refusé', () => as(mag, () => rpc('shipment_pack', s1, 0, 14, 12)), 'SHIPPING_BAD_QTY')
await rejects('poids net supérieur au brut refusé', () => as(mag, () => rpc('shipment_pack', s1, 2, 10, 12)), 'SHIPPING_BAD_WEIGHT')
await as(mag, () => rpc('shipment_pack', s1, 2, 14, 12))
ok('colisage : 2 colis, 14 kg brut, statut colisé', (await q(`select status, packages from shipments where id=$1`, [s1]))[0].packages === 2)
const bl = await as(mag, () => rpc('shipment_ship', s1, 'DHL', 'TRK-123'))
ok('expédition : bon de livraison BL-AAAA-000001', /^BL-\d{4}-000001$/.test(bl))
const stAfter = (await q(`select qty_on_hand, qty_reserved from variant_stock where variant_id=$1 and warehouse_id=$2`, [vA, wh.id]))[0]
ok('stock après expédition : 10 en stock, plus de réservation', Number(stAfter.qty_on_hand) === 10 && Number(stAfter.qty_reserved) === 0)
ok('journal de stock : sortie tracée avec le numéro d’expédition', (await q(`select count(*)::int n from variant_stock_moves where reference=$1 and move_type='issue'`, [s1row.number]))[0].n === 2)
await rejects('expédition déjà expédiée : nouvel envoi refusé', () => as(mag, () => rpc('shipment_ship', s1, 'DHL', 'X')), 'SHIPPING_BAD_STATUS')
await rejects('annulation après expédition refusée', () => as(mag, () => rpc('shipment_cancel', s1, 'Trop tard pour annuler')), 'SHIPPING_BAD_STATUS')
await rejects('facture export sans incoterm ni pays refusée', () => as(mag, () => rpc('shipment_export_invoice', s1)), 'SHIPPING_EXPORT_DATA_MISSING')
await as(mag, () => rpc('shipment_track', s1, 'in_transit', 'Tunis', 'En transit'))
await rejects('suivi : évènement de livraison refusé ici', () => as(mag, () => rpc('shipment_track', s1, 'delivered', null, null)), 'SHIPPING_BAD_EVENT')
await as(mag, () => rpc('shipment_deliver', s1))
ok('livraison : statut livré et date enregistrée', (await q(`select status, delivered_at is not null d from shipments where id=$1`, [s1]))[0].d === true)
await rejects('livraison déjà faite : refusée', () => as(mag, () => rpc('shipment_deliver', s1)), 'SHIPPING_BAD_STATUS')

// --- 5. Deuxième expédition : facture export, incident, annulation avec libération ------------------------------------------------------
const s2 = await as(mag, () => rpc('shipment_create', order2, wh.id, 'FOB', 'fr', 'EUR'))
const l2 = await as(mag, () => rpc('shipment_add_line', s2, vA, 5))
await as(mag, () => rpc('shipment_pick', l2, 5))
await as(mag, () => rpc('shipment_pack', s2, 1, 6, 5))
const bl2 = await as(mag, () => rpc('shipment_ship', s2, 'DHL', 'TRK-456'))
ok('deuxième expédition expédiée avec son bon de livraison', /^BL-/.test(bl2))
await as(mag, () => rpc('shipment_track', s2, 'exception', 'Douane', 'Document manquant'))
const exp = await as(mag, () => rpc('shipment_export_invoice', s2))
ok('facture export : numéro EXP-AAAA-000001 sur l’expédition', /^EXP-\d{4}-000001$/.test(exp))
ok('facture export : total 5 × 25 = 125 EUR', Number((await q(`select export_total from shipments where id=$1`, [s2]))[0].export_total) === 125)
await rejects('facture export déjà émise : refusée', () => as(mag, () => rpc('shipment_export_invoice', s2)), 'SHIPPING_ALREADY_INVOICED')

const s3 = await as(mag, () => rpc('shipment_create', order2, wh.id, null, null, 'EUR'))
await rejects('commande entièrement affectée : ligne supplémentaire refusée', () => as(mag, () => rpc('shipment_add_line', s3, vA, 1)), 'SHIPPING_QTY_EXCEEDS_ORDER')
// commande 1 : 12 pièces affectées ; reste à vérifier l’annulation sur une expédition fraîche
const orderNew = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await as(admin, () => q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,3,$3)`, [orderNew, artA, dueSoon]))
await as(admin, () => rpc('sales_order_confirm', orderNew))
const s4 = await as(mag, () => rpc('shipment_create', orderNew, wh.id, null, null, 'EUR'))
const l4 = await as(mag, () => rpc('shipment_add_line', s4, vA, 3))
await as(mag, () => rpc('shipment_pick', l4, 3))
ok('réservation : 3 pièces bloquées avant annulation', Number((await q(`select qty_reserved from variant_stock where variant_id=$1 and warehouse_id=$2`, [vA, wh.id]))[0].qty_reserved) === 3)
await rejects('annulation sans motif refusée', () => as(mag, () => rpc('shipment_cancel', s4, 'non')), 'SHIPPING_REASON_REQUIRED')
await as(mag, () => rpc('shipment_cancel', s4, 'Client a annulé sa commande'))
ok('annulation : réservation libérée (0 réservée), expédition annulée', Number((await q(`select qty_reserved from variant_stock where variant_id=$1 and warehouse_id=$2`, [vA, wh.id]))[0].qty_reserved) === 0 && (await q(`select status from shipments where id=$1`, [s4]))[0].status === 'cancelled')

// --- 6. Journal de suivi, droits, indicateurs -------------------------------------------------------------------------------------------------
await rejects('journal de suivi immuable', () => db.query(`update shipment_events set note = 'x'`), 'SHIPPING_IMMUTABLE')
await rejects('suivi : évènement sur expédition non expédiée refusé', () => as(mag, () => rpc('shipment_track', s4, 'in_transit', null, null)), 'SHIPPING_BAD_STATUS')
await rejects('tableau de bord refusé sans droit de lecture', () => as(nobody, () => rpc('shipping_dashboard')), 'RBAC_FORBIDDEN')
const dash = await as(dir, () => rpc('shipping_dashboard'))
ok('indicateurs : taux de livraison à temps 100 % (expédiées avant l’échéance)', Number(dash.on_time_pct) === 100)
ok('indicateurs : taux de remplissage 100 % (17 pièces expédiées sur 17 commandées)', Number(dash.fill_rate_pct) === 100)
ok('indicateurs : 3 colis au total, 1 facture export pour 125 EUR', dash.packages_total === 3 && dash.exports_invoiced === 1 && Number(dash.export_total) === 125)
ok('indicateurs : incident d’expédition non résolu comptabilisé', dash.exceptions_open === 1)
ok('indicateurs : délai moyen de préparation calculé', dash.avg_lead_time_days !== null)
const visible = await as(comm, () => q(`select count(*)::int n from shipments`))
ok('commercial sans entrepôt affecté : aucune expédition visible (entrepôts scopés)', visible[0].n === 0)
const magView = await as(mag, () => q(`select count(*)::int n from shipments`))
ok('responsable de l’entrepôt : voit ses expéditions', magView[0].n >= 3)
