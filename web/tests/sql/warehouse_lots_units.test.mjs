// Entrepôts, emplacements, lots et unités (rouleaux) : traçabilité, scope entrepôt, propriété ≠ localisation, historique — P037 / migration 0062
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
const mag = await mkUser('mag@x.com', 'magasin')          // opérateur de l'entrepôt A seulement
const nobody = await mkUser('nobody@x.com', null)

// Entrepôts : A (affecté au magasinier), B (boutique, sans affectation)
const whA = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Tissus A','fabric') returning id`, [company]))[0].id
const whB = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Boutique B','shop') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whA])
const locA = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [whA]))[0].id
const locA2 = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'RAY-2','Rayon 2','storage') returning id`, [company, whA]))[0].id
const locB = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [whB]))[0].id

// Composants : tissu, accessoire, EPI
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P037','fabric','m') returning id`, [company]))[0].id
const zip = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Zip P037','zip','pc') returning id`, [company]))[0].id
const epi = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Gants P037','other','pc') returning id`, [company]))[0].id

// 1. Familles et types d'entrepôt
await as(admin, () => rpc('material_family_set', tissu, 'fabric'))
await as(admin, () => rpc('material_family_set', zip, 'accessory'))
await as(admin, () => rpc('material_family_set', epi, 'ppe'))
ok('familles : tissu, accessoire, EPI classés explicitement ; type d’entrepôt « boutique » accepté', (await q(`select family from bom_materials where id=$1`, [epi]))[0].family === 'ppe' && (await q(`select kind from warehouses where id=$1`, [whB]))[0].kind === 'shop')
await rejects('famille inconnue refusée', () => as(admin, () => rpc('material_family_set', tissu, 'bidon')), 'UNIT_FAMILY_INVALID')
await rejects('famille : saisie refusée sans droit stock', () => as(nobody, () => rpc('material_family_set', tissu, 'fabric')), 'RBAC_FORBIDDEN')

// Clients (propriétaire) et lots
const cli = (await q(`insert into clients(company_id, name, country, currency) values ($1,'Client consignataire P037','TN','EUR') returning id`, [company]))[0].id
const lotT = await as(admin, () => rpc('material_lot_create', tissu, 'L-2026-001', 'SUP-77', 'BAIN-A', null))
const lotZ = await as(admin, () => rpc('material_lot_create', zip, 'Z-2026-01', null, null, null))
const lotC = await as(admin, () => rpc('material_lot_create', tissu, 'CL-001', null, 'BAIN-C', cli))
await rejects('lot : code en double refusé', () => as(admin, () => rpc('material_lot_create', tissu, 'L-2026-001', null, null, null)), 'duplicate key')
await rejects('lot : propriétaire inconnu refusé', () => as(admin, () => rpc('material_lot_create', tissu, 'X-1', null, null, '00000000-0000-0000-0000-000000000000')), 'UNIT_OWNER_INVALID')

// 2. Rouleaux : réception en entrepôt A (stock société), longueur et largeur, bain
const r1 = await as(mag, () => rpc('material_unit_receive', tissu, lotT, whA, locA, 50.5, 150, 'BAIN-A', null, 'BL-P37-1'))
const u1 = (await q(`select * from material_units where id=$1`, [r1]))[0]
const stockT = async (wh, loc) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and warehouse_id=$2 ${loc ? 'and location_id=$3' : ''}`, loc ? [tissu, wh, loc] : [tissu, wh]))[0].n)
ok('rouleau reçu : code UN-, longueur 50,5 m, largeur 150, bain BAIN-A, stock société +50,5', /^UN-\d{6,}$/.test(u1.unit_code) && near(u1.length_m, 50.5) && near(u1.width_cm, 150) && u1.dye_bath === 'BAIN-A' && u1.stock_posted === true && near(await stockT(whA), 50.5))
ok('réception : historique « receive » avec mouvement de stock', (await q(`select event, stock_movement_id from material_unit_events where unit_id=$1`, [r1]))[0].event === 'receive' && (await q(`select stock_movement_id from material_unit_events where unit_id=$1`, [r1]))[0].stock_movement_id !== null)
await rejects('rouleau sans longueur refusé', () => as(mag, () => rpc('material_unit_receive', tissu, lotT, whA, locA, null, 150, 'BAIN-A', null, null)), 'UNIT_LENGTH_REQUIRED')
await rejects('scope : réception hors entrepôt affecté refusée (WAREHOUSE_FORBIDDEN)', () => as(mag, () => rpc('material_unit_receive', tissu, lotT, whB, locB, 20, 150, 'BAIN-A', null, null)), 'WAREHOUSE_FORBIDDEN')
await rejects('lot d’une autre matière refusé', () => as(mag, () => rpc('material_unit_receive', tissu, lotZ, whA, locA, 10, 150, null, null, null)), 'UNIT_LOT_INVALID')
await rejects('propriétaire incompatible avec le lot refusé', () => as(mag, () => rpc('material_unit_receive', tissu, lotT, whA, locA, 10, 150, null, cli, null)), 'UNIT_OWNER_MISMATCH')

// 3. Propriété client : suivi de localisation, aucun mouvement dans le stock société
const rc = await as(mag, () => rpc('material_unit_receive', tissu, lotC, whA, locA, 30, 140, 'BAIN-C', cli, 'Consignation P37'))
const uc = (await q(`select * from material_units where id=$1`, [rc]))[0]
ok('propriété client : unité suivie (30 m), aucun mouvement de stock société, stock société inchangé à 50,5', uc.stock_posted === false && uc.owner_client_id === cli && near(await stockT(whA), 50.5))

// 4. Zones et emplacements : déplacement dans l'entrepôt ; propriété inchangée
await as(mag, () => rpc('material_unit_move', r1, locA2))
const m1 = (await q(`select location_id from material_units where id=$1`, [r1]))[0]
ok('déplacement : localisation changée, stock déplacé vers RAY-2', m1.location_id === locA2 && near(await stockT(whA, locA2), 50.5) && near(await stockT(whA, locA), 0))
await as(mag, () => rpc('material_unit_move', rc, locA2))
ok('déplacement d’une unité client : localisation changée, propriété client conservée', (await q(`select location_id, owner_client_id from material_units where id=$1`, [rc]))[0].owner_client_id === cli)
await rejects('déplacement hors entrepôt refusé (emplacement d’une autre boutique)', () => as(mag, () => rpc('material_unit_move', r1, locB)), 'STOCK_LOCATION_NOT_FOUND')
await rejects('déplacement sur le même emplacement refusé', () => as(mag, () => rpc('material_unit_move', r1, locA2)), 'UNIT_SAME_LOCATION')

// 5. Défauts et quarantaine
await as(mag, () => rpc('material_unit_defect_record', r1, 'TRAME', 'minor', 'Trame irrégulière sur 2 m', 2))
ok('défaut mineur : enregistré, rouleau toujours disponible', (await q(`select status from material_units where id=$1`, [r1]))[0].status === 'available' && (await q(`select count(*)::int n from material_unit_defects where unit_id=$1`, [r1]))[0].n === 1)
await rejects('défaut : longueur touchée supérieure à la longueur refusée', () => as(mag, () => rpc('material_unit_defect_record', r1, 'TACHE', 'minor', 'Tache sur bordure', 99)), 'UNIT_DEFECT_LENGTH_INVALID')
await as(mag, () => rpc('material_unit_defect_record', r1, 'TROU', 'critical', 'Trou de 10 cm dans le tissu', 1))
ok('défaut critique : mise en quarantaine automatique', (await q(`select status from material_units where id=$1`, [r1]))[0].status === 'quarantine')
await rejects('unité en quarantaine : consommation refusée', () => as(mag, () => rpc('material_unit_consume', r1, 'OF-1')), 'UNIT_NOT_AVAILABLE')
await rejects('libération réservée à la qualité (magasinier refusé)', () => as(mag, () => rpc('material_unit_release', r1, 'Contrôle fait par le magasin')), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('material_unit_release', r1, 'Trou réparé et contrôlé'))
ok('libération par la qualité : rouleau de nouveau disponible', (await q(`select status from material_units where id=$1`, [r1]))[0].status === 'available')

// 6. Consommation : sortie de stock société ; unité client sans sortie de stock société
const before = await stockT(whA)
await as(mag, () => rpc('material_unit_consume', r1, 'OF-P37-1'))
const cons = (await q(`select status, consumed_at from material_units where id=$1`, [r1]))[0]
ok('consommation : rouleau consommé, stock société diminué de 50,5', cons.status === 'consumed' && cons.consumed_at !== null && near(await stockT(whA), before - 50.5))
await rejects('rouleau consommé : seconde consommation refusée', () => as(mag, () => rpc('material_unit_consume', r1, 'OF-P37-2')), 'UNIT_NOT_AVAILABLE')
await as(mag, () => rpc('material_unit_consume', rc, 'Façon client P37'))
ok('consommation d’une unité client : aucun mouvement de stock société', near(await stockT(whA), 0) && (await q(`select status from material_units where id=$1`, [rc]))[0].status === 'consumed')

// 7. Lots : pièces comptées (sans longueur) ; traçabilité du lot ; périmètre
const z1 = await as(mag, () => rpc('material_unit_receive', zip, lotZ, whA, locA, null, null, null, null, 'BL-Z-1'))
ok('pièce non mesurée : quantité 1, sans longueur', near((await q(`select qty, length_m from material_units where id=$1`, [z1]))[0].qty, 1) && (await q(`select length_m from material_units where id=$1`, [z1]))[0].length_m === null)
const trace = await as(mag, () => rpc('material_unit_trace', r1))
const evs = trace.events.map((e) => e.event)
ok('traçabilité unité : historique complet dans l’ordre (réception, déplacement, défauts, quarantaine, libération, consommation)',
  JSON.stringify(evs) === JSON.stringify(['receive', 'move', 'defect', 'defect', 'quarantine', 'release', 'consume']) && trace.unit.status === 'consumed', JSON.stringify(evs))
const lt = await as(mag, () => rpc('material_lot_trace', lotT))
ok('traçabilité lot : unités du lot visibles, quantité consommée 50,5', lt.lot.code === 'L-2026-001' && lt.lot.supplier_lot === 'SUP-77' && lt.lot.dye_bath === 'BAIN-A' && near(lt.qty_consumed_visible, 50.5))

// 8. Scope : unité dans un entrepôt hors affectation → invisible au magasinier
const ub = (await as(admin, () => rpc('material_unit_receive', tissu, lotT, whB, locB, 12, 150, 'BAIN-A', null, 'Boutique P37')))
const ubCode = (await q(`select unit_code from material_units where id=$1`, [ub]))[0].unit_code
const ltMag = await as(mag, () => rpc('material_lot_trace', lotT))
ok('scope entrepôt : unité de la boutique masquée au magasinier (comptée, non détaillée)', ltMag.units_outside_scope >= 1 && !ltMag.units.some((x) => x.code === ubCode))
await rejects('scope : trace d’une unité hors entrepôt refusée (UNIT_NOT_FOUND)', () => as(mag, () => rpc('material_unit_trace', ub)), 'UNIT_NOT_FOUND')
const visibleMag = await as(mag, () => q(`select count(*)::int n from material_units`))
ok('scope : la lecture directe ne montre que les unités de l’entrepôt affecté', visibleMag[0].n === (await q(`select count(*)::int n from material_units where warehouse_id=$1`, [whA]))[0].n)
await rejects('lecture refusée sans droit stock', () => as(nobody, () => rpc('material_unit_trace', r1)), 'RBAC_FORBIDDEN')

// 9. Historique conservé : ajout seul
await rejects('historique : modification d’un événement refusée', () => db.query(`update material_unit_events set reason='falsifié' where unit_id=$1`, [r1]), 'UNIT_HISTORY_APPEND_ONLY')
await rejects('historique : suppression d’un défaut refusée', () => db.query(`delete from material_unit_defects where unit_id=$1`, [r1]), 'UNIT_HISTORY_APPEND_ONLY')

// 10. Audit
ok('audit : réceptions, défauts, quarantaine, consommations tracés', (await q(`select count(*)::int n from audit_logs where action in ('stock.unit_receive','stock.unit_defect','stock.unit_quarantine','stock.unit_consume','stock.unit_release')`))[0].n >= 5)
