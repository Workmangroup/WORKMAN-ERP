// Inventaire : comptage aveugle, recomptage, gel ciblé, accord distinct, écarts expliqués, quantité et valeur rapprochées — P041 / migration 0066
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
const mag2 = await mkUser('mag2@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const wh = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock P41','mixed') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, wh])
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag2, wh])
const gen = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh]))[0].id
const ray = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'RAY','Rayon P41','storage') returning id`, [company, wh]))[0].id
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P41','fabric','m') returning id`, [company]))[0].id
const fil = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Fil P41','thread','m') returning id`, [company]))[0].id

const onHand = async (m, loc) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and warehouse_id=$2 and location_id=$3`, [m, wh, loc]))[0].n)
const inv = (u, ...a) => as(u, () => rpc(...a))
const linesOf = async (invId) => q(`select id, material_id, location_id from stock_inventory_lines where inventory_id=$1`, [invId])
const lineFor = (ls, m) => ls.find((l) => l.material_id === m).id
const statusOf = async (invId) => (await q(`select phase, status, decision_reason from stock_inventories where id=$1`, [invId]))[0]

// Stock initial (coûts unitaires saisis par la finance / l'administration)
await inv(admin, 'stock_move', 'in', tissu, 100, wh, gen, null, 'BL-T-1', 'Stock initial tissu', 10, null)
await inv(admin, 'stock_move', 'in', tissu, 20, wh, ray, null, 'BL-T-2', 'Stock rayon tissu', 10, null)
await inv(admin, 'stock_move', 'in', fil, 50, wh, gen, null, 'BL-F-1', 'Stock initial fil', 4, null)

// ---------------------------------------------------------------------------
// Inventaire 1 : gel ciblé sur le magasin GEN (le rayon RAY n'est pas compté)
// ---------------------------------------------------------------------------
const inv1 = await inv(mag, 'stock_inventory_create', wh, gen, 'Inventaire GEN P41')
await inv(mag, 'stock_inventory_freeze_set', inv1, true)
const ls1 = await linesOf(inv1)
const lT1 = lineFor(ls1, tissu), lF1 = lineFor(ls1, fil)
ok('inventaire gelé sur GEN : deux lignes (tissu, fil), rayon RAY hors périmètre', ls1.length === 2 && ls1.every((l) => l.location_id === gen))

// Comptage aveugle : aucune quantité visible par le compteur
const forCount = await inv(mag, 'stock_inventory_lines_for_count', inv1)
const txt = JSON.stringify(forCount)
ok('comptage aveugle : la liste du compteur ne contient ni théorique, ni comptage, ni écart', !/system_qty|counted|expected|unexplained|on_hand/.test(txt) && forCount.lines.length === 2)
await rejects('théorique non lisible par le compteur (accès refusé)', () => as(mag, () => q(`select system_qty from stock_inventory_lines where id=$1`, [lT1])), 'permission denied')

// Gel ciblé : mouvement sur GEN refusé ; mouvement sur RAY (hors périmètre) accepté
await rejects('mouvement sur un emplacement gelé refusé (STOCK_COUNT_FROZEN)', () => inv(mag, 'stock_move', 'out', fil, 1, wh, gen, null, 'OF-GELE', 'Sortie pendant gel', null, null), 'STOCK_COUNT_FROZEN')
await inv(mag, 'stock_move', 'out', tissu, 5, wh, ray, null, 'OF-RAY', 'Sortie rayon hors gel', null, null)
ok('gel ciblé : mouvement sur RAY (hors périmètre compté) accepté', (await onHand(tissu, ray)) === 15)

// Passage 1 : tissu compté juste (100), fil compté 48 (écart non expliqué −2)
await inv(mag, 'stock_inventory_count_submit', lT1, 100)
await inv(admin2, 'stock_inventory_count_submit', lF1, 48)
await rejects('deuxième saisie du même compteur refusée (COUNT_ALREADY_SUBMITTED)', () => inv(mag, 'stock_inventory_count_submit', lT1, 100), 'COUNT_ALREADY_SUBMITTED')
const cc1 = await inv(mag, 'stock_inventory_close_count', inv1)
ok('clôture : écart non expliqué sur le fil seulement → recomptage d’une ligne ; tissu sans recomptage', cc1.phase === 'recounting' && cc1.recount_lines === 1)
const sq = (await q(`select l.id, l.recount_needed from stock_inventory_lines l where l.id=$1`, [lF1]))[0]
ok('ligne du fil marquée « recomptage » (le tissu ne l’est pas)', sq.recount_needed === true)

// Recomptage : même compteur refusé ; autre compteur accepté
await rejects('recomptage par le compteur initial refusé (COUNT_SAME_COUNTER)', () => inv(admin2, 'stock_inventory_count_submit', lF1, 48), 'COUNT_SAME_COUNTER')
await rejects('recomptage d’une ligne sans écart refusé (COUNT_NOT_REQUIRED)', () => inv(mag2, 'stock_inventory_count_submit', lT1, 100), 'COUNT_NOT_REQUIRED')
await inv(mag2, 'stock_inventory_count_submit', lF1, 48)
const cr1 = await inv(mag, 'stock_inventory_close_recount', inv1)
ok('recomptage concordant : phase « réconciliation »', cr1.phase === 'reconciling')

// Accord distinct : demande par le magasinier ; décision par un compteur (refusé), par un sans droit (refusé), puis par la direction
await inv(mag, 'stock_inventory_request_approval', inv1)
await rejects('décision par un compteur refusée (SOD_COUNTER_APPROVAL)', () => inv(admin2, 'stock_inventory_decide', inv1, true, 'Accord du compteur'), 'SOD_COUNTER_APPROVAL')
await rejects('décision sans droit d’ajustement refusée (magasin)', () => inv(mag, 'stock_inventory_decide', inv1, true, 'Motif de test'), 'RBAC_FORBIDDEN')
await rejects('décision sans motif refusée', () => inv(admin, 'stock_inventory_decide', inv1, true, 'ab'), 'INVENTORY_REASON_REQUIRED')
const d1 = await inv(admin, 'stock_inventory_decide', inv1, true, 'Écart de comptage du fil')
ok('accord distinct : 1 ajustement (fil −2), décision « validé », tissu inchangé à 100', d1.status === 'validated' && d1.adjusted === 1 && near(d1.qty_delta, -2)
  && (await onHand(fil, gen)) === 48 && (await onHand(tissu, gen)) === 100)
ok('mouvement d’inventaire : une sortie de 2, tracée à l’inventaire', (await q(`select direction, qty::float q from stock_movements where inventory_id=$1 and type='inventory'`, [inv1])).length === 1
  && (await q(`select direction, qty::float q from stock_movements where inventory_id=$1 and type='inventory'`, [inv1]))[0].q === 2)
await rejects('inventaire validé : nouvelle décision refusée (INVENTORY_BAD_PHASE)', () => inv(admin, 'stock_inventory_decide', inv1, true, 'Nouvelle décision'), 'INVENTORY_BAD_PHASE')
await rejects('validation directe refusée (INVENTORY_APPROVAL_REQUIRED)', () => inv(admin, 'stock_inventory_validate', inv1), 'INVENTORY_APPROVAL_REQUIRED')

// ---------------------------------------------------------------------------
// Inventaire 2 : sans gel ; mouvements simultanés expliqués ; refus puis accord
// ---------------------------------------------------------------------------
const inv2 = await inv(mag, 'stock_inventory_create', wh, gen, 'Inventaire 2 P41')
const ls2 = await linesOf(inv2)
const lT2 = lineFor(ls2, tissu), lF2 = lineFor(ls2, fil)
await inv(admin, 'stock_move', 'out', tissu, 10, wh, gen, null, 'OF-SIM-1', 'Sortie pendant inventaire', null, null)
await inv(mag, 'stock_inventory_count_submit', lT2, 90)
await inv(mag2, 'stock_inventory_count_submit', lF2, 48)
const cc2 = await inv(mag, 'stock_inventory_close_count', inv2)
ok('mouvement simultané expliqué (−10 avant comptage) : aucun recomptage, phase « réconciliation »', cc2.phase === 'reconciling' && cc2.recount_lines === 0)
await inv(admin, 'stock_move', 'in', tissu, 5, wh, gen, null, 'BL-SIM-2', 'Entrée après comptage', 10, null)
const rec2 = await inv(admin, 'stock_inventory_reconcile', inv2)
const rT2 = rec2.lines.find((x) => x.line_id === lT2)
ok('écart expliqué : mouvements avant comptage −10, après comptage +5, écart non expliqué 0', near(rT2.movements_since, -10) && near(rT2.movements_after_count, 5) && near(rT2.unexplained, 0))

// Accord : demandé par la direction (demandeur), décision par la direction → refusé ; refus par un autre utilisateur ; nouvelle demande ; accord
await inv(admin, 'stock_inventory_request_approval', inv2)
await rejects('auto-approbation refusée (SOD_SELF_APPROVAL)', () => inv(admin, 'stock_inventory_decide', inv2, true, 'Auto-approbation'), 'SOD_SELF_APPROVAL')
const r2 = await inv(admin2, 'stock_inventory_decide', inv2, false, 'Recompter le tissu après mouvement')
ok('refus motivé : retour en réconciliation, motif conservé, aucun mouvement', r2.status === 'refused' && (await statusOf(inv2)).phase === 'reconciling'
  && (await statusOf(inv2)).decision_reason === 'Recompter le tissu après mouvement' && (await q(`select count(*)::int n from stock_movements where inventory_id=$1`, [inv2]))[0].n === 0)
await inv(mag, 'stock_inventory_request_approval', inv2)
const d2 = await inv(admin2, 'stock_inventory_decide', inv2, true, 'Ajustement après mouvement simultané')
ok('accord : ajustement du stock réel (95 → 90, soit −5), fil inchangé', d2.adjusted === 1 && near(d2.qty_delta, -5) && (await onHand(tissu, gen)) === 90 && (await onHand(fil, gen)) === 48)

// ---------------------------------------------------------------------------
// Valorisation : confirmation par la finance, quantité et valeur rapprochées
// ---------------------------------------------------------------------------
await rejects('méthode non prévue refusée (STOCK_VALUATION_METHOD_UNSUPPORTED)', () => inv(admin, 'stock_valuation_set', 'weighted_average', true), 'STOCK_VALUATION_METHOD_UNSUPPORTED')
await rejects('valorisation réservée à la finance (magasin refusé)', () => inv(mag, 'stock_valuation_set', 'lot_cost', true), 'RBAC_FORBIDDEN')
const rv0 = await inv(admin, 'stock_inventory_reconcile', inv1)
ok('avant confirmation : valeur « à confirmer » (méthode non décidée dans le dépôt)', rv0.valuation.status === 'to_confirm')
await inv(admin, 'stock_valuation_set', 'lot_cost', true)
const rv1 = await inv(admin, 'stock_inventory_reconcile', inv1)
ok('après confirmation finance : valeur « confirmée » (coût du lot)', rv1.valuation.status === 'confirmed' && rv1.valuation.method === 'lot_cost')
ok('quantité rapprochée : ajustements appliqués = mouvements d’inventaire (−2 = −2)', near(rv1.adjustments.applied_qty, -2) && near(rv1.adjustments.movement_qty, -2) && rv1.adjustments.qty_matches === true)
ok('valeur de l’ajustement : −2 × 4 = −8 (coût du lot du fil)', near(rv1.adjustments.applied_value, -8))
const rv2 = await inv(admin, 'stock_inventory_reconcile', inv2)
ok('valeur de l’inventaire 2 : −5 × 10 = −50 (coût du lot du tissu)', near(rv2.adjustments.applied_value, -50))
const mats = rv2.materials.concat(rv1.materials)
ok('journal = lots, par matière : écarts de quantité et de valeur nuls', mats.length >= 2 && mats.every((m) => near(m.qty_difference, 0) && near(m.value_difference, 0)))

// ---------------------------------------------------------------------------
// Journal historique intact et droits
// ---------------------------------------------------------------------------
await rejects('mouvement d’inventaire non réécrivable par un utilisateur applicatif', () => as(admin, () => db.query(`update stock_movements set qty = 1 where inventory_id = $1`, [inv1])), 'permission denied')
await rejects('mouvement d’inventaire non réécrivable même en accès direct (STOCK_IMMUTABLE)', () => db.query(`update stock_movements set qty = 1 where inventory_id = $1`, [inv1]), 'STOCK_IMMUTABLE')
await rejects('inventaire hors périmètre : lecture de la réconciliation refusée', () => inv(nobody, 'stock_inventory_reconcile', inv1), 'RBAC_FORBIDDEN')

// Audit
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : comptages (5), recomptage clôturé, demandes, refus (1), validations (2), gel et valorisation tracés',
  (await aud('inventory.count')) === 5 && (await aud('inventory.refuse')) === 1 && (await aud('inventory.validate')) === 2
  && (await aud('inventory.request_approval')) === 3 && (await aud('inventory.freeze')) === 1 && (await aud('stock.valuation_set')) === 1)
