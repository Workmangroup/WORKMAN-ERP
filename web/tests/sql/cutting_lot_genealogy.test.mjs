// OF coupe et généalogie des lots : OF figé, réservations, matelas, consommation de lots, produits finis, fractionnement,
// expédition, traçabilité amont / aval, encours — P048 / migration 0073
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, eps = 0.0005) => Math.abs(Number(a) - b) < eps
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCodes) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  for (const rc of roleCodes) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(rc)])
  return id
}
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, u, wh, r])
const admin = await mkUser('admin@x.com', ['admin'])
const qual = await mkUser('qual@x.com', ['qualite'])
const opr = await mkUser('opr@x.com', ['production', 'magasin'])     // planifie, coupe, sort, expédie (magasin)
const prodOnly = await mkUser('prodonly@x.com', ['production'])     // sans droit de stock
const magOnly = await mkUser('magonly@x.com', ['magasin'])          // sans droit de production
const comm = await mkUser('com@x.com', ['commercial'])
const fin = await mkUser('fin@x.com', ['finance'])
const nobody = await mkUser('nobody@x.com', [])

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))

// --- Référentiel : entrepôts, client, article, variante, matières -------------------------------------------------------------------
const whRaw = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Magasin tissu P48','fabric') returning id`, [company]))[0].id
const whFin = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P48','finished_goods') returning id`, [company]))[0].id
await grant(opr, whRaw, 'manager'); await grant(opr, whFin, 'manager'); await grant(magOnly, whRaw, 'manager')
const locRaw = (await q(`select id from stock_locations where warehouse_id=$1 and kind='storage' limit 1`, [whRaw]))[0].id
const locQuar = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUAR48','Quarantaine','quarantine') returning id`, [company, whRaw]))[0].id
const client = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client P48','TN','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, internal_ref, client_ref, name, family) values ($1,$2,'VES48','LAF-48','Veste P48','jacket') returning id`, [company, client]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P48','jacket',$3) returning id`, [company, client, art]))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJaune], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id

const mat = async (name, unit, cost) => {
  const m = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,$2,'fabric',$3) returning *`, [company, name, unit]))[0]
  await db.query(`insert into bom_material_prices(material_id, company_id, unit_cost) values ($1,$2,$3)`, [m.id, company, cost])
  return m
}
const tissu = await mat('Tissu P48', 'm', 8)
const doublure = await mat('Doublure P48', 'm', 2)
const zip = await mat('Zip P48', 'm', 1)
const pc = await mat('Bouton P48', 'pc', 0.1)

// Nomenclature validée de l'article : 2 m de tissu + 1 m de doublure par pièce
const bom = (await q(`insert into boms(company_id, name, kind, article_id) values ($1,'Veste P48','product',$2) returning *`, [company, art]))[0]
const bv = (await q(`select id from bom_versions where bom_id=$1 and version_no=1`, [bom.id]))[0].id
await db.query(`insert into bom_lines(company_id, version_id, line_type, material_id, quantity, waste_pct) values ($1,$2,'material',$3,2,0)`, [company, bv, tissu.id])
await db.query(`insert into bom_lines(company_id, version_id, line_type, material_id, quantity, waste_pct) values ($1,$2,'material',$3,1,0)`, [company, bv, doublure.id])
await as(qual, () => rpc('bom_validate_version', bv, 'Fiche conforme'))

// --- Stock matière : lots FIFO (TIS-A avant TIS-B), doublure périmée seule, tissu en quarantaine ---------------------------------------
const recv = (u, m, qty, code, expiry, loc) => as(u, () => q(`select public.stock_receive_lot(p_material=>$1, p_warehouse=>$2, p_location=>$3, p_qty=>$4, p_lot_code=>$5, p_expiry=>$6::date, p_reference=>'REC-P48', p_reason=>null, p_unit_cost=>1) as id`, [m, whRaw, loc, qty, code, expiry]))
await recv(opr, tissu.id, 40, 'TIS-A', iso(90), locRaw)
await recv(opr, tissu.id, 40, 'TIS-B', iso(120), locRaw)
await recv(opr, doublure.id, 10, 'DBL-OLD', iso(60), locRaw)
await db.query(`update stock_lots set expiry_date = current_date - 1 where lot_code='DBL-OLD'`)
await recv(opr, tissu.id, 5, 'TIS-Q', iso(90), locQuar)
await recv(opr, zip.id, 20, 'ZIP-A', iso(200), locRaw)
const lotId = async (code) => (await q(`select id from stock_lots where lot_code=$1`, [code]))[0].id
const lotQty = async (code) => Number((await q(`select qty_remaining from stock_lots where lot_code=$1`, [code]))[0].qty_remaining)

// --- OF : quantité 10, variante, lancement (nomenclature et gamme figées) ---------------------------------------------------------
// création de l'OF sous l'administrateur
const wc48 = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'WC48','Coupe P48','coupe') returning id`, [company]))[0].id
const orderId = await as(admin, () => rpc('production_order_create', art, 10, 60, wc48, iso(0), iso(10), null, 'OF P48'))
// Variante d'une autre fiche produit (article différent) : refusée
const art2 = (await q(`insert into articles(company_id, client_id, internal_ref, client_ref, name, family) values ($1,$2,'AUT48','LAF-AUT48','Autre veste P48','jacket') returning id`, [company, client]))[0].id
const prod2 = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Autre veste P48','jacket',$3) returning id`, [company, client, art2]))[0].id
await as(admin, () => rpc('variant_generate', prod2, [colJaune], [sizeS]))
const vAutre = (await q(`select id from product_variants where product_id=$1`, [prod2]))[0].id
await rejects('variante d’une autre fiche produit refusée (OF_VARIANT_ARTICLE_MISMATCH)', () => as(admin, () => rpc('production_order_set_variant', orderId, vAutre)), 'OF_VARIANT_ARTICLE_MISMATCH')
await as(admin, () => rpc('production_order_set_variant', orderId, vV))
const number = (await q(`select number from production_orders where id=$1`, [orderId]))[0].number
await as(admin, () => rpc('production_order_launch', orderId))
const snap = (await q(`select status from production_order_bom where order_id=$1`, [orderId]))[0]
ok('OF lancé : nomenclature figée (statut frozen) et variante renseignée avant lancement', snap.status === 'frozen' && (await q(`select variant_id is not null v, frozen_at is not null f from production_orders where id=$1`, [orderId]))[0].v === true)
await rejects('quantité d’un OF lancé non modifiable (OF_FROZEN)', () => db.query(`update production_orders set qty_planned = 99 where id=$1`, [orderId]), 'OF_FROZEN')
await rejects('variante d’un OF lancé non modifiable (OF_FROZEN)', () => as(admin, () => rpc('production_order_set_variant', orderId, vV)), 'OF_FROZEN')

// --- Réservation rattachée à l'OF ----------------------------------------------------------------------------------------------------
const resT = await as(opr, () => rpc('stock_reserve', tissu.id, whRaw, 20, 'RES-OF-P48', 'Tissu pour la veste'))
await as(opr, () => rpc('production_reservation_link', resT, orderId))
ok('réservation rattachée à l’OF (matière de la nomenclature figée)', (await q(`select production_order_id = $2 ok from stock_reservations where id=$1`, [resT, orderId]))[0].ok === true)
const resZ = await as(opr, () => rpc('stock_reserve', zip.id, whRaw, 5, 'RES-ZIP-P48', null))
await rejects('réservation d’une matière absente de la nomenclature refusée (CUT_MATERIAL_NOT_IN_BOM)', () => as(opr, () => rpc('production_reservation_link', resZ, orderId)), 'CUT_MATERIAL_NOT_IN_BOM')

// --- Matelas (coupe) : garde-fous de création -----------------------------------------------------------------------------------------
await rejects('matelas sans droit de production refusé (RBAC_FORBIDDEN)', () => as(magOnly, () => rpc('production_cut_plan_create', orderId, tissu.id, whRaw, 4, 1, 1, 0, null)), 'RBAC_FORBIDDEN')
await rejects('matelas en unité pièce refusé (CUT_UNIT_MISMATCH)', () => as(opr, () => rpc('production_cut_plan_create', orderId, pc.id, whRaw, 1, 1, 1, 0, null)), 'CUT_UNIT_MISMATCH')
await rejects('matelas d’une matière absente de la nomenclature refusé (CUT_MATERIAL_NOT_IN_BOM)', () => as(opr, () => rpc('production_cut_plan_create', orderId, zip.id, whRaw, 1, 1, 1, 0, null)), 'CUT_MATERIAL_NOT_IN_BOM')
await rejects('plus de pièces que l’OF (CUT_PIECES_EXCEED_ORDER)', () => as(opr, () => rpc('production_cut_plan_create', orderId, tissu.id, whRaw, 4, 6, 2, 0, null)), 'CUT_PIECES_EXCEED_ORDER')
const planA = await as(opr, () => rpc('production_cut_plan_create', orderId, tissu.id, whRaw, 4, 3, 3, 5, 'Matelas 1 : 3 couches'))
const planB = await as(opr, () => rpc('production_cut_plan_create', orderId, doublure.id, whRaw, 1, 1, 1, 0, 'Doublure'))
const planA2 = (await q(`select code, required_qty::float rq from production_cut_plans where id=$1`, [planA]))[0]
ok('matelas MAT-0001 : 4 m × 3 couches × 1,05 = 12,6 m à consommer', planA2.code === 'MAT-0001' && near(planA2.rq, 12.6))

// --- Consommation : FIFO, réservation de l'OF, lots enregistrés -----------------------------------------------------------------------
await rejects('consommation sans droit de stock refusée (RBAC_FORBIDDEN)', () => as(prodOnly, () => rpc('production_cut_plan_consume', planA)), 'RBAC_FORBIDDEN')
const cA = await as(opr, () => rpc('production_cut_plan_consume', planA))
ok('consommation MAT-0001 : 12,6 m tirés du premier lot (TIS-A), réservation de l’OF utilisée', cA.lots.length === 1 && cA.lots[0].lot_code === 'TIS-A' && near(cA.lots[0].qty, 12.6)
  && near(await lotQty('TIS-A'), 27.4) && near(Number((await q(`select qty_consumed from stock_reservations where id=$1`, [resT]))[0].qty_consumed), 12.6))
await rejects('second passage sur un matelas consommé refusé (CUT_BAD_STATUS)', () => as(opr, () => rpc('production_cut_plan_consume', planA)), 'CUT_BAD_STATUS')

// Lot périmé : la consommation est refusée et rien ne sort
const dblBefore = await lotQty('DBL-OLD')
await rejects('consommation d’un lot périmé refusée (CUT_EXPIRED_LOT), annulée', () => as(opr, () => rpc('production_cut_plan_consume', planB)), 'CUT_EXPIRED_LOT')
ok('après refus : lot périmé intact, matelas toujours planifié, aucun mouvement enregistré', (await lotQty('DBL-OLD')) === dblBefore
  && (await q(`select status from production_cut_plans where id=$1`, [planB]))[0].status === 'planned'
  && (await q(`select count(*)::int n from stock_movements where reference like 'OF % MAT-0002'`))[0].n === 0)

// Le matelas de doublure est annulé : il libère la capacité de pièces de l'OF pour le test suivant
await as(opr, () => rpc('production_cut_plan_cancel', planB, 'Lot périmé : doublure à reprendre'))
// Stock insuffisant (quarantaine et réservation non comptées) : refus, puis annulation du matelas
const planBig = await as(opr, () => rpc('production_cut_plan_create', orderId, tissu.id, whRaw, 80, 1, 1, 0, 'Trop long'))
await rejects('consommation au-delà du disponible refusée (STOCK_*)', () => as(opr, () => rpc('production_cut_plan_consume', planBig)), 'STOCK_')
ok('après refus : stock tissu inchangé (27,4 + 40 = 67,4 ; quarantaine 5 hors calcul)', near(await lotQty('TIS-A'), 27.4) && near(await lotQty('TIS-B'), 40) && near(await lotQty('TIS-Q'), 5))
await as(opr, () => rpc('production_cut_plan_cancel', planBig, 'Matelas trop long, à refaire'))
await rejects('matelas annulé non consommable (CUT_BAD_STATUS)', () => as(opr, () => rpc('production_cut_plan_consume', planBig)), 'CUT_BAD_STATUS')

// --- Encours --------------------------------------------------------------------------------------------------------------------------------
const w1 = await as(opr, () => rpc('production_order_wip', orderId))
ok('encours après coupe : 9 pièces coupées, 0 sortie, 1 pièce non encore coupée', w1.cut_pieces === 9 && w1.output_pieces === 0 && w1.wip_pieces === 9 && w1.not_cut_pieces === 1)

// Consommation sur deux lots (TIS-A puis TIS-B) : le lot en quarantaine n'est jamais touché
const planC = await as(opr, () => rpc('production_cut_plan_create', orderId, tissu.id, whRaw, 60, 1, 1, 0, 'Coupe sur deux lots'))
const cC = await as(opr, () => rpc('production_cut_plan_consume', planC))
ok('consommation sur deux lots : 27,4 m de TIS-A puis 32,6 m de TIS-B ; quarantaine TIS-Q intacte (5 m)',
  cC.lots.length === 2 && cC.lots[0].lot_code === 'TIS-A' && near(cC.lots[0].qty, 27.4) && cC.lots[1].lot_code === 'TIS-B' && near(cC.lots[1].qty, 32.6)
  && near(await lotQty('TIS-A'), 0) && near(await lotQty('TIS-B'), 7.4) && near(await lotQty('TIS-Q'), 5))

// --- Produits finis : sortie liée à l'OF ------------------------------------------------------------------------------------------------
await rejects('sortie de produits sans droit de stock refusée (RBAC_FORBIDDEN)', () => as(prodOnly, () => rpc('production_finished_lot_receive', orderId, 'LOT-P48-A', whFin, 6)), 'RBAC_FORBIDDEN')
const lotA = await as(opr, () => rpc('production_finished_lot_receive', orderId, 'LOT-P48-A', whFin, 6))
const lotARow = (await q(`select origin, origin_ref, production_order_id = $2 o, qty_in from finished_lots where id=$1`, [lotA, orderId]))[0]
ok('lot produit LOT-P48-A : 6 pièces, origine réception, référence OF, lié à l’OF', lotARow.origin === 'receipt' && lotARow.origin_ref === number && lotARow.o === true && lotARow.qty_in === 6)
await rejects('sortie au-delà de la quantité de l’OF refusée (PRODUCTION_OUTPUT_EXCEEDS_ORDER)', () => as(opr, () => rpc('production_finished_lot_receive', orderId, 'LOT-P48-B', whFin, 5)), 'PRODUCTION_OUTPUT_EXCEEDS_ORDER')
await rejects('code de lot produit en double refusé', () => as(opr, () => rpc('production_finished_lot_receive', orderId, 'LOT-P48-A', whFin, 1)), 'duplicate key')
const w2 = await as(opr, () => rpc('production_order_wip', orderId))
ok('encours après sortie : 10 coupées, 6 sorties, 4 en cours', w2.cut_pieces === 10 && w2.output_pieces === 6 && w2.wip_pieces === 4)

// --- Fractionnement avec quantités -----------------------------------------------------------------------------------------------------
await rejects('fractionnement au-delà du disponible refusé (LOT_SPLIT_INVALID) : 7 pièces demandées, 6 disponibles', () => as(opr, () => rpc('finished_lot_split', lotA, 7, 'LOT-P48-X', 'Trop')), 'LOT_SPLIT_INVALID')
const lotChild = await as(opr, () => rpc('finished_lot_split', lotA, 2, 'LOT-P48-A2', 'Colis de 2 pièces'))
const parent = (await q(`select qty_in, qty_out from finished_lots where id=$1`, [lotA]))[0]
const child = (await q(`select qty_in, origin, origin_ref, production_order_id = $2 o from finished_lots where id=$1`, [lotChild, orderId]))[0]
ok('fractionnement : 2 pièces sorties du lot d’origine (disponible 4), lot enfant de 2 lié à l’OF', parent.qty_out === 2 && (parent.qty_in - parent.qty_out) === 4 && child.qty_in === 2 && child.origin === 'split' && child.origin_ref === 'LOT-P48-A' && child.o === true)
ok('fractionnement historisé (lot_splits)', (await q(`select count(*)::int n from lot_splits where child_lot_id=$1 and qty=2`, [lotChild]))[0].n === 1)

// --- Expédition : la commande reçoit les pièces du lot ----------------------------------------------------------------------------------
const order = (await q(`insert into sales_orders(company_id, client_id) values ($1,$2) returning id`, [company, client]))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,3,25,$5)`, [company, order, art, vV, iso(20)])
await as(admin, () => rpc('sales_order_confirm', order))
const shp = await as(opr, () => rpc('shipment_create', order, whFin, null, null, 'EUR'))
const shpLine = await as(opr, () => rpc('shipment_add_line', shp, vV, 3))
await as(opr, () => rpc('shipment_pick', shpLine, 3))
await as(opr, () => rpc('shipment_pack', shp, 1, 12, 3))
await as(opr, () => rpc('shipment_line_lot_assign', shpLine, lotA, 3))
const bl = await as(opr, () => rpc('shipment_ship', shp, 'DHL', 'TRK-P48'))
const shipNumber = (await q(`select number from shipments where id=$1`, [shp]))[0].number
ok('expédition envoyée : lot LOT-P48-A affecté (3 pièces), bon de livraison émis', typeof bl === 'string' && bl.length > 0 && (await q(`select qty_out from finished_lots where id=$1`, [lotA]))[0].qty_out === 5)

// --- Traçabilité amont : lot matière → matelas → OF → lot produit → expédition → commande -----------------------------------------
const tisA = await lotId('TIS-A')
const trM = await as(opr, () => rpc('lot_trace_material', tisA))
ok('lot matière TIS-A retrouvable : matelas MAT-0001, OF, lot produit LOT-P48-A, expédition et commande', trM.consumptions.some((c) => c.plan === 'MAT-0001' && c.order === number)
  && trM.finished_lots.some((f) => f.lot_code === 'LOT-P48-A') && trM.shipments.some((s) => s.shipment === shipNumber && s.sales_order_id === order))
ok('traçabilité : pas de consommation hors matelas pour TIS-A (autres mouvements = 0)', trM.other_movements === 0)

// --- Traçabilité aval : lot produit fractionné → OF → lots matière ---------------------------------------------------------------------
const trF = await as(opr, () => rpc('lot_trace_finished', lotChild))
ok('lot produit LOT-P48-A2 : parent LOT-P48-A, OF, matière TIS-A consommée (12,6 m)', trF.split_from.some((p) => p.lot_code === 'LOT-P48-A')
  && trF.order === number && trF.material_consumptions.some((c) => c.plan === 'MAT-0001' && c.lots.some((l) => l.lot_code === 'TIS-A' && near(l.qty, 12.6))))

// --- Historique ------------------------------------------------------------------------------------------------------------------------------
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : matelas créés (4), consommations (2), annulations (2), sortie produit (1), fractionnement (1), liaison réservation (1), variante (1)',
  (await aud('production.cut_plan_create')) === 4 && (await aud('production.cut_consume')) === 2 && (await aud('production.cut_cancel')) === 2
  && (await aud('production.output_lot')) === 1 && (await aud('lot.split')) === 1 && (await aud('production.reservation_link')) === 1 && (await aud('production.order_variant')) === 1)
