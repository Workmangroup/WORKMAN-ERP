// Quarantaine et libération qualité : statut par lot, blocage consommation / picking / prise / expédition, libération auditée,
// lot critique réservé au rôle dédié, retour physique en quarantaine — P052 / migration 0077
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }
const failsWith = async (name, fn, re) => {
  try { await fn(); ok(name, false, 'aucune erreur levée') } catch (e) { ok(name, re.test(e.message), e.message) }
}

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const qual = await mkUser('qual@x.com', 'qualite')
const mag = await mkUser('mag@x.com', 'magasin')
const comm = await mkUser('com@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)
const NO_LOT = '00000000-0000-0000-0000-000000000000'

// --- Référentiel matière : entrepôt tissu, trois lots reçus dans l'ordre FIFO ----------------------------------------------------
const wh = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock P52','fabric') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, wh])
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and kind='storage' limit 1`, [wh]))[0].id
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P52','fabric','m') returning *`, [company]))[0]
const receive = (code, qty) => as(mag, () => q(`select public.stock_receive_lot(p_material=>$1, p_warehouse=>$2, p_location=>$3, p_qty=>$4, p_lot_code=>$5, p_expiry=>(current_date + 300)::date, p_reference=>'REC-P52', p_reason=>null, p_unit_cost=>5)`, [tissu.id, wh, loc, qty, code]))
await receive('LOT-5A', 30)
await receive('LOT-5B', 30)
await receive('LOT-5C', 10)
const lotId = async (code) => (await q(`select id from stock_lots where lot_code=$1`, [code]))[0].id
const L5A = await lotId('LOT-5A')
const L5B = await lotId('LOT-5B')
const L5C = await lotId('LOT-5C')
const remaining = async (id) => Number((await q(`select qty_remaining from stock_lots where id=$1`, [id]))[0].qty_remaining)
const lotCodes = (p) => p.lines.map((l) => l.lot_code)
const status = (who, kind, lot) => as(who, () => rpc('lot_quality_status_get', kind, lot))

ok('trois lots tissu reçus, aucun statut qualité enregistré : lecture « libéré » par défaut', (await status(qual, 'material', L5A)).status === 'released' && (await status(qual, 'material', L5A)).recorded === false)

// --- A. Blocage : motif, droits, transitions -------------------------------------------------------------------------------------------
await rejects('blocage sans motif refusé (LOT_REASON_REQUIRED)', () => as(qual, () => rpc('lot_quality_hold', 'material', L5A, 'quarantine', 'nok')), 'LOT_REASON_REQUIRED')
await rejects('blocage par un utilisateur sans droit qualité refusé (RBAC_FORBIDDEN)', () => as(mag, () => rpc('lot_quality_hold', 'material', L5A, 'quarantine', 'Contrôle visuel de la lisière')), 'RBAC_FORBIDDEN')
await rejects('statut « libéré » impossible par blocage (LOT_BAD_STATUS)', () => as(qual, () => rpc('lot_quality_hold', 'material', L5A, 'released', 'Tentative de statut libéré')), 'LOT_BAD_STATUS')
await rejects('lot inconnu ou d’une autre société refusé (LOT_NOT_FOUND)', () => as(qual, () => rpc('lot_quality_hold', 'material', NO_LOT, 'quarantine', 'Lot inexistant pour le test')), 'LOT_NOT_FOUND')
await as(qual, () => rpc('lot_quality_hold', 'material', L5A, 'quarantine', 'Contrôle visuel : tache sur la lisière'))
const st5A = await status(qual, 'material', L5A)
ok('lot 5A en quarantaine : statut, motif et auteur enregistrés', st5A.status === 'quarantine' && st5A.recorded === true && st5A.reason.includes('tache') && st5A.set_by === qual)
await rejects('second blocage du même lot refusé (LOT_BAD_STATUS)', () => as(qual, () => rpc('lot_quality_hold', 'material', L5A, 'blocked', 'Second blocage du même lot')), 'LOT_BAD_STATUS')

// --- B. Blocage effectif : picking, prise de lot, consommation, écriture directe ------------------------------------------------------
const prop40 = await as(mag, () => rpc('stock_pick_proposal', tissu.id, wh, 40))
ok('proposition de picking : le lot 5A bloqué est exclu ; disponible = 5B (30) + 5C (10) = 40', Number(prop40.available) === 40 && !lotCodes(prop40).includes('LOT-5A') && lotCodes(prop40).includes('LOT-5B') && Number(prop40.proposed) === 40, JSON.stringify(prop40.lines))
await rejects('préparation au-delà du disponible hors lot bloqué refusée (PICK_SHORT)', () => as(mag, () => rpc('stock_pick_create', tissu.id, wh, 45, null)), 'PICK_SHORT')
await rejects('contrôle de lot de picking : lot bloqué refusé (LOT_BLOCKED)', () => db.query(`select private.stock_pick_check_lot($1,$2,$3,$4,1,null)`, [company, tissu.id, wh, L5A]), 'LOT_BLOCKED')
await rejects('prise de lot bloqué refusée à la préparation (LOT_BLOCKED)', () => db.query(`select private.stock_take_lot($1,$2,$3,$4,1,'PREP-52')`, [company, tissu.id, wh, L5A]), 'LOT_BLOCKED')
// Stock total 70 m dont 30 m bloqués : une sortie de 45 m dépasse le libre (40 m) et est refusée
await failsWith('sortie de 45 m refusée : 30 m bloqués sur 70 m en stock (STOCK_QUALITY_BLOCKED)', () => as(mag, () => rpc('stock_move', 'out', tissu.id, 45, wh, loc)), /STOCK_QUALITY_BLOCKED/)
ok('sortie refusée sans effet : lots inchangés', (await remaining(L5A)) === 30 && (await remaining(L5B)) === 30 && (await remaining(L5C)) === 10)
await as(mag, () => rpc('stock_move', 'out', tissu.id, 20, wh, loc))
ok('sortie de 20 m : consommée sur le lot 5B (FIFO), lot 5A intact (exclu)', (await remaining(L5A)) === 30 && (await remaining(L5B)) === 10 && (await remaining(L5C)) === 10)
await rejects('écriture directe de décrémentation d’un lot bloqué refusée (LOT_BLOCKED)', () => db.query(`update stock_lots set qty_remaining = qty_remaining - 1 where id=$1`, [L5A]), 'LOT_BLOCKED')
const locQuar = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUAR-52','Quarantaine P52','quarantine') returning id`, [company, wh]))[0].id
await rejects('déplacement d’un lot bloqué refusé (LOT_BLOCKED)', () => db.query(`update stock_lots set location_id = $2 where id=$1`, [L5A, locQuar]), 'LOT_BLOCKED')

// --- C. Libération matière : SOD, droits, motif, retour dans le disponible -----------------------------------------------------------
await rejects('libération par la personne qui a bloqué refusée (LOT_SELF_RELEASE)', () => as(qual, () => rpc('lot_quality_release', 'material', L5A, 'Contrôle refait, conforme')), 'LOT_SELF_RELEASE')
await rejects('libération sans droit d’approbation refusée (RBAC_FORBIDDEN)', () => as(mag, () => rpc('lot_quality_release', 'material', L5A, 'Libération par magasin')), 'RBAC_FORBIDDEN')
await rejects('libération sans motif refusée (LOT_REASON_REQUIRED)', () => as(admin, () => rpc('lot_quality_release', 'material', L5A, 'ok')), 'LOT_REASON_REQUIRED')
await as(admin, () => rpc('lot_quality_release', 'material', L5A, 'Contrôle refait : tissu conforme, photo jointe au dossier'))
const rel5A = await status(admin, 'material', L5A)
ok('libération 5A : statut libéré, historique quarantaine puis libéré', rel5A.status === 'released' && rel5A.history.length === 2 && rel5A.history[1].to === 'released' && rel5A.history[1].actor === admin)
await rejects('libération d’un lot déjà libéré refusée (LOT_BAD_STATUS)', () => as(admin, () => rpc('lot_quality_release', 'material', L5A, 'Seconde libération inutile')), 'LOT_BAD_STATUS')
const prop40b = await as(mag, () => rpc('stock_pick_proposal', tissu.id, wh, 40))
ok('après libération : le lot 5A redevient disponible au picking (5A 30 + 5B 10 + 5C 10 = 50)', Number(prop40b.available) === 50 && lotCodes(prop40b).includes('LOT-5A'))

// --- D. Lot critique : seul le rôle dédié libère -------------------------------------------------------------------------------------
await as(qual, () => rpc('lot_quality_hold', 'material', L5B, 'blocked', 'Défaut de teinture détecté au contrôle, lot critique', true))
await rejects('lot critique : libération par la qualité refusée (RBAC_FORBIDDEN, droit dédié absent)', () => as(qual, () => rpc('lot_quality_release', 'material', L5B, 'Libération qualité sur lot critique')), 'RBAC_FORBIDDEN')
await rejects('lot critique : libération par le magasin refusée (RBAC_FORBIDDEN)', () => as(mag, () => rpc('lot_quality_release', 'material', L5B, 'Libération magasin sur lot critique')), 'RBAC_FORBIDDEN')
await as(dir, () => rpc('lot_quality_release', 'material', L5B, 'Teinture vérifiée en laboratoire, conforme au standard'))
const rel5B = await status(dir, 'material', L5B)
ok('lot critique libéré par la direction (droit dédié) : statut libéré, critique conservé dans l’historique', rel5B.status === 'released' && rel5B.history.at(-1).critical === true && rel5B.history.at(-1).actor === dir)
ok('droit dédié présent pour administrateur et direction seulement (matrice)', (await count(`select count(*)::int n from role_permissions rp join permissions p on p.id = rp.permission_id join roles r on r.id = rp.role_id where p.code='quality.release_critical' and r.company_id=$1`, [company])) === 2)

// --- E. Rejet définitif -----------------------------------------------------------------------------------------------------------------
await as(qual, () => rpc('lot_quality_hold', 'material', L5C, 'quarantine', 'Lot de 10 m à contrôler avant rejet'))
await rejects('rejet sans droit d’approbation refusé (RBAC_FORBIDDEN)', () => as(mag, () => rpc('lot_quality_reject', 'material', L5C, 'Rejet par le magasin')), 'RBAC_FORBIDDEN')
await as(qual, () => rpc('lot_quality_reject', 'material', L5C, 'Défaut irréparable sur toute la longueur'))
ok('lot rejeté : statut rejected avec motif', (await status(qual, 'material', L5C)).status === 'rejected')
await rejects('lot rejeté : libération refusée (LOT_BAD_STATUS)', () => as(admin, () => rpc('lot_quality_release', 'material', L5C, 'Tentative de libération après rejet')), 'LOT_BAD_STATUS')
await rejects('lot rejeté : nouveau blocage refusé (LOT_BAD_STATUS)', () => as(qual, () => rpc('lot_quality_hold', 'material', L5C, 'blocked', 'Blocage après rejet définitif')), 'LOT_BAD_STATUS')
const prop40c = await as(mag, () => rpc('stock_pick_proposal', tissu.id, wh, 40))
ok('lot rejeté exclu du picking', !lotCodes(prop40c).includes('LOT-5C'))

// --- F. Produits finis : blocage à l'expédition, libération, retour physique ------------------------------------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const whF = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P52','finished_goods') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whF])
const client = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client P52','TN','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P52-A','Veste P52','jacket') returning id`, [company, client]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P52','jacket',$3) returning id`, [company, client, art]))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJaune], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
await db.query(`update product_variants set price = 25 where id=$1`, [vV])

const LF = await as(admin, () => rpc('finished_lot_receive', vV, whF, 'LOT-F52', 50, 'OF-P52-1'))
await as(qual, () => rpc('lot_quality_hold', 'finished', LF, 'blocked', 'Couture défectueuse constatée au contrôle final'))
const order = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,15,25,$5)`, [company, order, art, vV, iso(20)])
await as(admin, () => rpc('sales_order_confirm', order))
const S = await as(mag, () => rpc('shipment_create', order, whF, null, null, 'EUR'))
// Une seule ligne par variante : 15 pièces prélevées, 10 affectées au lot F52 ; 5 restent libres pour le test de retour
const LN = await as(mag, () => rpc('shipment_add_line', S, vV, 15))
await as(mag, () => rpc('shipment_pick', LN, 15))
await as(mag, () => rpc('shipment_pack', S, 1, 12, 10))
await rejects('produit fini bloqué : affectation à l’expédition refusée (LOT_BLOCKED)', () => as(mag, () => rpc('shipment_line_lot_assign', LN, LF, 10)), 'LOT_BLOCKED')
await rejects('produit fini bloqué : libération par la personne qui l’a bloqué refusée (LOT_SELF_RELEASE)', () => as(qual, () => rpc('lot_quality_release', 'finished', LF, 'Contrôle refait sans reprise')), 'LOT_SELF_RELEASE')
await as(admin, () => rpc('lot_quality_release', 'finished', LF, 'Reprise de couture vérifiée, lot conforme'))
const LNA = await as(mag, () => rpc('shipment_line_lot_assign', LN, LF, 10))
ok('produit fini libéré : affectation à l’expédition acceptée', typeof LNA === 'string' && LNA.length > 0)

// Retour physique : lot libéré en apparence, mais en quarantaine dès l'entrée
const RET = (await db.query(`insert into finished_lots(company_id, lot_code, variant_id, warehouse_id, qty_in, origin, origin_ref) values ($1,'RET-P52-1',$2,$3,3,'return','RET-P52') returning id`, [company, vV, whF])).rows[0].id
const stRet = await status(qual, 'finished', RET)
ok('retour physique accepté : entrée en quarantaine automatique, motif retour', stRet.status === 'quarantine' && stRet.recorded === true && stRet.reason.includes('Retour physique') && stRet.history.length === 1)
await rejects('retour physique non vendable : affectation refusée (LOT_BLOCKED)', () => as(mag, () => rpc('shipment_line_lot_assign', LN, RET, 1)), 'LOT_BLOCKED')
const RETNC = (await db.query(`insert into finished_lots(company_id, lot_code, variant_id, warehouse_id, qty_in, status, origin, origin_ref, nc_reason, nc_at) values ($1,'RET-P52-2',$2,$3,2,'nc','return','RET-P52-2','Retour non conforme (rejected)', now()) returning id`, [company, vV, whF])).rows[0].id
ok('retour non conforme (lot nc) : pas de quarantaine supplémentaire, déjà exclu de la vente', (await count(`select count(*)::int n from lot_quality_states where lot_id=$1`, [RETNC])) === 0)
await as(admin, () => rpc('lot_quality_release', 'finished', RET, 'Retour remis en état et contrôlé conforme'))
ok('retour physique libéré : statut libéré après contrôle, pas avant', (await status(admin, 'finished', RET)).status === 'released')

// --- G. Droits, RLS, journal en ajout seul, audit -------------------------------------------------------------------------------------
ok('statuts invisibles sans droit qualité (RLS)', (await as(nobody, () => count(`select count(*)::int n from lot_quality_states`))) === 0)
await rejects('écriture directe du statut refusée (permission denied)', () => as(admin, () => db.query(`update lot_quality_states set status = 'released' where lot_id=$1`, [L5C])), 'permission denied')
await rejects('journal des statuts en ajout seul : modification refusée (LOT_EVENTS_APPEND_ONLY)', () => db.query(`update lot_quality_events set reason = 'modifié' where lot_id=$1`, [L5A]), 'LOT_EVENTS_APPEND_ONLY')
await rejects('journal des statuts en ajout seul : suppression refusée (LOT_EVENTS_APPEND_ONLY)', () => db.query(`delete from lot_quality_events where lot_id=$1`, [L5A]), 'LOT_EVENTS_APPEND_ONLY')
ok('audit : blocages (4), libérations (4) et rejet (1) tracés', (await count(`select count(*)::int n from audit_logs where action='lot.hold'`)) === 4
  && (await count(`select count(*)::int n from audit_logs where action='lot.release'`)) === 4
  && (await count(`select count(*)::int n from audit_logs where action='lot.reject'`)) === 1)
