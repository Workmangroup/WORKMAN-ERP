// Codes-barres retenus et tâches mobiles : résolution des codes, mauvais article/lot/emplacement refusés, scans répétés idempotents, droits serveur — P042 / migration 0067
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
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
const nobody = await mkUser('nobody@x.com', null)

const w1 = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Atelier P42','mixed') returning id`, [company]))[0].id
const w2 = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Dépôt P42','mixed') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, w1])
const gen1 = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [w1]))[0].id
const gen2 = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [w2]))[0].id
const mat = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P42','fabric','m') returning id`, [company]))[0].id
const matCode = (await q(`select code from bom_materials where id=$1`, [mat]))[0].code
await as(admin, () => rpc('material_family_set', mat, 'fabric'))

// Stock : 50 au lot L-P42-1 à l'atelier (magasinier)
await as(mag, () => rpc('stock_receive_lot', mat, w1, gen1, 50, 'L-P42-1', null, 'BL-P42-1', 'Réception P42', 10))

// ---------------------------------------------------------------------------
// 1. Résolution des codes : un seul résultat, sinon erreur explicite ; périmètre entrepôt
// ---------------------------------------------------------------------------
const rMat = await as(mag, () => rpc('scan_resolve', matCode.toLowerCase()))
ok('code matière résolu (saisie en minuscules acceptée) : genre « material »', rMat.ok === true && rMat.hit.kind === 'material')
const rLot = await as(mag, () => rpc('scan_resolve', 'L-P42-1'))
ok('code de lot résolu : genre « lot »', rLot.ok === true && rLot.hit.kind === 'lot')
const rLocMag = await as(mag, () => rpc('scan_resolve', 'GEN'))
ok('emplacement « GEN » : unique dans le périmètre du magasinier (entrepôt de l’atelier seulement)', rLocMag.ok === true && rLocMag.hit.kind === 'location')
const rLocAdmin = await as(admin, () => rpc('scan_resolve', 'GEN'))
ok('emplacement « GEN » : ambigu pour un utilisateur ayant les deux entrepôts (SCAN_AMBIGUOUS)', rLocAdmin.ok === false && rLocAdmin.code === 'SCAN_AMBIGUOUS')
const rUnknown = await as(mag, () => rpc('scan_resolve', 'ZZZ-999'))
ok('code inconnu : SCAN_UNKNOWN avec message exploitable', rUnknown.ok === false && rUnknown.code === 'SCAN_UNKNOWN' && /inconnu/.test(rUnknown.message))
const rEmpty = await as(mag, () => rpc('scan_resolve', '  '))
ok('scan vide : SCAN_UNKNOWN', rEmpty.code === 'SCAN_UNKNOWN')
await rejects('résolution sans droit de lecture refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('scan_resolve', 'GEN')), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------
// 2. Picking mobile : lot et emplacement scannés ; mauvais lot / emplacement refusés ; scans répétés idempotents
// ---------------------------------------------------------------------------
const pick = await as(mag, () => rpc('stock_pick_create', mat, w1, 20, null))
const line = (await q(`select id from stock_pick_lines where pick_id=$1 and seq=1`, [pick]))[0].id
const pickNo = (await q(`select number from stock_pick_lists where id=$1`, [pick]))[0].number
const sPick = (u, l, lot, loc, key) => as(u, () => rpc('mob_pick_scan', l, lot, loc, key))
const wrongLot = await sPick(mag, line, 'L-AUTRE', 'GEN', 'SCAN-PICK-LOT1')
ok('mauvais lot refusé (SCAN_WRONG_LOT), lot attendu indiqué, son sonore d’erreur', wrongLot.ok === false && wrongLot.code === 'SCAN_WRONG_LOT' && wrongLot.expected === 'L-P42-1' && wrongLot.sound === 'error')
const wrongLoc = await sPick(mag, line, 'L-P42-1', 'RAY', 'SCAN-PICK-LOC1')
ok('mauvais emplacement refusé (SCAN_WRONG_LOCATION), emplacement attendu GEN', wrongLoc.ok === false && wrongLoc.code === 'SCAN_WRONG_LOCATION' && wrongLoc.expected === 'GEN')
ok('refus sans effet : ligne non scannée', (await q(`select scanned from stock_pick_lines where id=$1`, [line]))[0].scanned === false)
const good = await sPick(mag, line, 'L-P42-1', 'GEN', 'SCAN-PICK-OK1')
ok('bon lot au bon emplacement : confirmé (ok, son ok, non répété)', good.ok === true && good.sound === 'ok' && good.duplicate === false && good.replayed === false)
ok('ligne scannée une fois', (await q(`select scanned from stock_pick_lines where id=$1`, [line]))[0].scanned === true)
const replay = await sPick(mag, line, 'L-P42-1', 'GEN', 'SCAN-PICK-OK1')
ok('même clé de scan rejouée : résultat identique, marqué « rejoué », aucun effet', replay.ok === true && replay.replayed === true)
const again = await sPick(mag, line, 'L-P42-1', 'GEN', 'SCAN-PICK-OK2')
ok('scan répété avec une nouvelle clé : doublon ignoré (duplicate=true)', again.ok === true && again.duplicate === true)
await rejects('clé de scan trop courte refusée (SCAN_KEY_REQUIRED)', () => sPick(mag, line, 'L-P42-1', 'GEN', 'k'), 'SCAN_KEY_REQUIRED')
await rejects('picking mobile sans droit d’écriture refusé (RBAC_FORBIDDEN)', () => sPick(nobody, line, 'L-P42-1', 'GEN', 'SCAN-NOBODY-1'), 'RBAC_FORBIDDEN')
const reuse = await as(mag, () => rpc('mob_count_scan', line, matCode, 'GEN', 1, 'SCAN-PICK-OK1'))
ok('clé déjà utilisée pour un autre type de tâche : refusée (SCAN_KEY_REUSED)', reuse.ok === false && reuse.code === 'SCAN_KEY_REUSED')
await as(mag, () => rpc('stock_pick_confirm', pick))
ok('sortie confirmée : 20 consommés une seule fois (50 − 20 = 30), malgré les scans répétés', Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and warehouse_id=$2`, [mat, w1]))[0].n) === 30)

// ---------------------------------------------------------------------------
// 3. Réception mobile : article et emplacement de destination scannés ; idempotence ; périmètre
// ---------------------------------------------------------------------------
const tr = await as(mag, () => rpc('stock_transfer_create', w1, gen1, w2, gen2, 'Transfert mobile P42', JSON.stringify([{ material_id: mat, qty: 10 }])))
const trLine = (await q(`select id from stock_transfer_lines where transfer_id=$1`, [tr]))[0].id
await as(mag, () => rpc('stock_transfer_prepare', tr, JSON.stringify([{ line_id: trLine, qty: 10 }])))
await as(mag, () => rpc('stock_transfer_ship', tr))
const trNo = (await q(`select number from stock_transfers where id=$1`, [tr]))[0].number
const rcv = (u, mc, lc, qty, key) => as(u, () => rpc('mob_transfer_receive_scan', tr, mc, lc, qty, 'Bon mobile P42', key))
await rejects('réception hors entrepôt destination refusée (WAREHOUSE_FORBIDDEN)', () => rcv(mag, matCode, 'GEN', 10, 'RCV-MAG-0001'), 'WAREHOUSE_FORBIDDEN')
const wrongSku = await rcv(admin, 'ZZZ-999', 'GEN', 10, 'RCV-SKU-0001')
ok('mauvais article refusé (SCAN_WRONG_SKU)', wrongSku.ok === false && wrongSku.code === 'SCAN_WRONG_SKU')
const wrongRcvLoc = await rcv(admin, matCode, 'RAY', 10, 'RCV-LOC-0001')
ok('mauvais emplacement de réception refusé (SCAN_WRONG_LOCATION), attendu GEN', wrongRcvLoc.ok === false && wrongRcvLoc.code === 'SCAN_WRONG_LOCATION' && wrongRcvLoc.expected === 'GEN')
ok('refus de réception sans effet : destination à 0', Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where warehouse_id=$1`, [w2]))[0].n) === 0)
const rc1 = await rcv(admin, matCode, 'GEN', 10, 'RCV-OK-00001')
ok('réception scannée : ok, sonore ok, 10 en destination', rc1.ok === true && rc1.duplicate === false && Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where warehouse_id=$1`, [w2]))[0].n) === 10)
const rc1b = await rcv(admin, matCode, 'GEN', 10, 'RCV-OK-00001')
ok('même clé rejouée : aucune seconde réception (rejoué, destination toujours 10)', rc1b.replayed === true && Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where warehouse_id=$1`, [w2]))[0].n) === 10)
const rc2 = await rcv(admin, matCode, 'GEN', 10, 'RCV-OK-00002')
ok('nouveau scan après clôture du transfert : refusé (TRANSFER_BAD_STATUS), aucun effet', rc2.ok === false && rc2.code === 'TRANSFER_BAD_STATUS')
ok('réception répétée : toujours 10 en destination', Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where warehouse_id=$1`, [w2]))[0].n) === 10)

// ---------------------------------------------------------------------------
// 4. Comptage mobile : article et emplacement de la ligne ; saisie aveugle ; répétition idempotente
// ---------------------------------------------------------------------------
const invId = await as(mag, () => rpc('stock_inventory_create', w1, gen1, 'Inventaire mobile P42'))
const invLine = (await q(`select id from stock_inventory_lines where inventory_id=$1`, [invId]))[0].id
const cnt = (mc, lc, qty, key) => as(mag, () => rpc('mob_count_scan', invLine, mc, lc, qty, key))
const cWrongSku = await cnt('ZZZ-999', 'GEN', 20, 'CNT-SKU-0001')
ok('comptage : mauvais article refusé (SCAN_WRONG_SKU)', cWrongSku.ok === false && cWrongSku.code === 'SCAN_WRONG_SKU')
const cWrongLoc = await cnt(matCode, 'RAY', 20, 'CNT-LOC-0001')
ok('comptage : mauvais emplacement refusé (SCAN_WRONG_LOCATION)', cWrongLoc.ok === false && cWrongLoc.code === 'SCAN_WRONG_LOCATION')
const c1 = await cnt(matCode, 'GEN', 20, 'CNT-OK-00001')
ok('comptage juste : enregistré, réponse sans quantité théorique ni écart', c1.ok === true && !/system|expected|unexplained|theor/i.test(JSON.stringify(c1)))
const c1b = await cnt(matCode, 'GEN', 20, 'CNT-OK-00001')
ok('même clé de comptage rejouée : aucun second comptage', c1b.replayed === true)
const c2 = await cnt(matCode, 'GEN', 19, 'CNT-OK-00002')
ok('second comptage du même passage refusé (COUNT_ALREADY_SUBMITTED), aucun effet', c2.ok === false && /COUNT_ALREADY_SUBMITTED/.test(c2.code))
ok('une seule saisie de passage 1 enregistrée', Number((await q(`select count(*)::int n from stock_inventory_count_entries where line_id=$1`, [invLine]))[0].n) === 1)

// ---------------------------------------------------------------------------
// 5. Journal des scans et droits
// ---------------------------------------------------------------------------
const journal = await q(`select task, outcome, error_code from scan_events order by created_at`)
ok('journal : chaque scan refusé est tracé avec son code d’erreur', journal.filter((e) => e.outcome === 'refused').length >= 8
  && journal.some((e) => e.error_code === 'SCAN_WRONG_LOT') && journal.some((e) => e.error_code === 'SCAN_WRONG_SKU'))
await rejects('journal des scans non modifiable (STOCK_IMMUTABLE)', () => db.query(`update scan_events set outcome = 'ok'`), 'STOCK_IMMUTABLE')
const invW2 = await as(admin, () => rpc('stock_inventory_create', w2, gen2, 'Inventaire dépôt P42'))
await as(admin, () => rpc('stock_inventory_add_line', invW2, mat, gen2))
const lineW2 = (await q(`select id from stock_inventory_lines where inventory_id=$1`, [invW2]))[0].id
await rejects('comptage mobile hors entrepôt affecté refusé (WAREHOUSE_FORBIDDEN)', () => as(mag, () => rpc('mob_count_scan', lineW2, matCode, 'GEN', 1, 'CNT-MAG-OTHER-1')), 'WAREHOUSE_FORBIDDEN')
