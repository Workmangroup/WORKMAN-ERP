// Journal des mouvements et réservations : journal immuable, blocage qualité, stock négatif refusé, réservations sans dépassement, journal réconcilié — P038 / migration 0063
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
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const whA = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock A P38','mixed') returning id`, [company]))[0].id
const whB = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock B P38','mixed') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whA])
const gen = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [whA]))[0].id
const qua = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUA','Quarantaine P38','quarantine') returning id`, [company, whA]))[0].id
const genB = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [whB]))[0].id
const mat = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Composant P38','fabric','m') returning id`, [company]))[0].id

const onHand = async (wh, loc) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and warehouse_id=$2 ${loc ? 'and location_id=$3' : ''}`, loc ? [mat, wh, loc] : [mat, wh]))[0].n)
const mv = (u, ...args) => as(u, () => rpc('stock_move', ...args))

// 1. Entrées et journal immuable
const e1 = await mv(mag, 'in', mat, 100, whA, gen, null, 'BL-38-1', 'Réception P38', null, null)
ok('entrée : 100 au stock ; le journal la classe « entrée »', (await onHand(whA)) === 100 && (await as(admin, () => q(`select class from stock_journal_list($1, $2) where seq = (select seq from stock_movements where id=$3)`, [whA, mat, e1])))[0].class === 'entree')
await rejects('journal immuable : modification d’un mouvement refusée', () => db.query(`update stock_movements set qty = 1 where id=$1`, [e1]), 'STOCK_IMMUTABLE')
await rejects('journal immuable : suppression d’un mouvement refusée', () => db.query(`delete from stock_movements where id=$1`, [e1]), 'STOCK_IMMUTABLE')

// 2. Stock négatif : refusé (aucune politique de stock négatif dans le dépôt)
await rejects('sortie au-delà du stock refusée (stock négatif interdit)', () => mv(mag, 'out', mat, 150, whA, gen, null, 'OF-X', null), 'STOCK_INSUFFICIENT')
await rejects('ajustement négatif au-delà du stock refusé', () => mv(admin, 'adjustment', mat, -150, whA, gen, null, 'INV-P38', 'Inventaire P38'), 'STOCK_INSUFFICIENT')
ok('aucun stock négatif après les refus', (await onHand(whA)) === 100)

// 3. Lot qualité bloqué : quarantaine non sortable, non réservable ; libération par transfert explicite seulement
await mv(admin, 'in', mat, 20, whA, qua, null, 'NC-38-1', 'Lot non conforme P38', null, null)
ok('quarantaine : 20 au stock bloqué, 120 au total', (await onHand(whA, qua)) === 20 && (await onHand(whA)) === 120)
await rejects('sortie qui entamerait le stock bloqué refusée (STOCK_QUALITY_BLOCKED)', () => mv(mag, 'out', mat, 110, whA, gen, null, 'OF-2', null), 'STOCK_QUALITY_BLOCKED')
await rejects('sortie explicitement depuis la quarantaine refusée', () => mv(mag, 'out', mat, 5, whA, qua, null, 'OF-3', null), 'STOCK_QUALITY_BLOCKED')
await rejects('réservation sur stock bloqué refusée', () => as(mag, () => rpc('stock_reserve', mat, whA, 115, 'OF-RES-X', null)), 'STOCK_INSUFFICIENT_AVAILABLE')
await mv(mag, 'out', mat, 100, whA, gen, null, 'OF-4', null)
ok('sortie du stock disponible seulement : quarantaine intacte (20)', (await onHand(whA, qua)) === 20 && (await onHand(whA, gen)) === 0)
await mv(admin, 'transfer', mat, 20, whA, qua, gen, 'Libération P38', 'Libération après contrôle', null, null)
ok('libération par transfert explicite : 20 passés en stockage', (await onHand(whA, qua)) === 0 && (await onHand(whA, gen)) === 20)

// 4. Réservations atomiques : deux réservations du dernier stock, sans dépassement
const r1 = await as(mag, () => rpc('stock_reserve', mat, whA, 12, 'OF-R1', 'première réservation'))
const r2 = await as(mag, () => rpc('stock_reserve', mat, whA, 8, 'OF-R2', 'dernier stock'))
const act = (await q(`select coalesce(sum(qty - qty_consumed),0) n from stock_reservations where material_id=$1 and warehouse_id=$2 and status='active'`, [mat, whA]))[0].n
ok('deux réservations : 12 + 8 = dernier stock (20), aucun dépassement', near(act, 20) && near(act, await onHand(whA)))
const nBefore = (await q(`select count(*)::int n from stock_reservations where material_id=$1`, [mat]))[0].n
await rejects('troisième réservation sans stock libre refusée', () => as(mag, () => rpc('stock_reserve', mat, whA, 1, 'OF-R3', null)), 'STOCK_INSUFFICIENT_AVAILABLE')
ok('réservation refusée : aucune ligne créée (atomicité)', (await q(`select count(*)::int n from stock_reservations where material_id=$1`, [mat]))[0].n === nBefore)
await as(mag, () => rpc('stock_release', r2))
const r3 = await as(mag, () => rpc('stock_reserve', mat, whA, 8, 'OF-R3', 'après libération'))
ok('après libération : le stock libéré est réservable à nouveau', r3 !== null)

// 5. Ajustement négatif : ne consomme pas le stock réservé
await rejects('ajustement négatif qui entamerait une réservation refusé (STOCK_RESERVED)', () => mv(admin, 'adjustment', mat, -1, whA, gen, null, 'CASSE-P38', 'Casse P38'), 'STOCK_RESERVED')

// 6. Consommation d'une réservation : sortie liée, classée « consommation »
const cons = await mv(mag, 'out', mat, 12, whA, gen, null, 'OF-R1', 'Consommation OF-R1', null, r1)
const resRow = (await q(`select qty_consumed, status from stock_reservations where id=$1`, [r1]))[0]
ok('consommation de la réservation : 12 consommés, réservation soldée, classée « consommation »', near(resRow.qty_consumed, 12) && resRow.status === 'consumed'
  && (await as(admin, () => q(`select class from stock_journal_list($1, $2) where seq = (select seq from stock_movements where id=$3)`, [whA, mat, cons])))[0].class === 'consommation')

// 7. Retour au stock : classé « retour »
const ret = await mv(mag, 'in', mat, 3, whA, gen, null, 'RET-0001', 'Retour fournisseur P38', null, null)
ok('retour : entrée de référence RET- classée « retour »', (await as(admin, () => q(`select class from stock_journal_list($1, $2) where seq = (select seq from stock_movements where id=$3)`, [whA, mat, ret])))[0].class === 'retour')

// 8. Réconciliation : solde du journal = solde des lots, par composant et entrepôt
const rec = await as(admin, () => q(`select * from stock_journal_reconcile($1)`, [mat]))
ok('journal réconcilié : écart nul sur tous les entrepôts et composants', rec.length >= 1 && rec.every((x) => near(x.difference, 0)))
const recA = rec.find((x) => x.warehouse_id === whA)
ok('réconciliation : solde journal = solde lots = 11 (100 + 20 − 100 − 12 + 3) ; réservé 8 ; bloqué 0', near(recA.journal_balance, 11) && near(recA.lot_balance, 11) && near(recA.reserved, 8) && near(recA.quality_blocked, 0), JSON.stringify(recA))

// 9. Scope : le magasinier ne voit que son entrepôt (journal et réconciliation) ; sans droit stock : refusé
await mv(admin, 'in', mat, 5, whB, genB, null, 'Réception B P38', null)
const jB = await as(mag, () => q(`select count(*)::int n from stock_journal_list(null, $1)`, [mat]))
ok('scope : le journal du magasinier n’inclut pas l’entrepôt B', jB[0].n === (await q(`select count(*)::int n from stock_movements where material_id=$1 and warehouse_id=$2`, [mat, whA]))[0].n)
const recMag = await as(mag, () => q(`select * from stock_journal_reconcile($1)`, [mat]))
ok('scope : la réconciliation du magasinier n’expose que l’entrepôt A', recMag.every((x) => x.warehouse_id === whA))
const jNobody = await as(nobody, () => q(`select * from stock_journal_list(null, null)`))
ok('journal sans droit stock : aucune ligne visible', jNobody.length === 0)

// 10. Audit
ok('audit : une trace par réservation acceptée (3), aucune pour la refusée', (await q(`select count(*)::int n from audit_logs where action = 'stock.reserve'`))[0].n === 3)
