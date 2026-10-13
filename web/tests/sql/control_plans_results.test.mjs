// Plans de contrôle et résultats : plans versionnés par date, méthode / échantillon / tolérance / instrument, résultats avec unité
// et preuve, décision distincte de la saisie, contrôle rejoué sur le plan d'origine — P051 / migration 0076
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
const admin = await mkUser('admin@x.com', ['admin'])
const qual = await mkUser('qual@x.com', ['qualite'])
const dir = await mkUser('dir@x.com', ['direction'])
const mag = await mkUser('mag@x.com', ['magasin'])
const nobody = await mkUser('nobody@x.com', [])

// --- Référentiel : entrepôt, matières, instruments --------------------------------------------------------------------------------
const wh = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Réception P51','fabric') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, wh])
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and kind='storage' limit 1`, [wh]))[0].id
const mat = async (name, unit) => (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,$2,'fabric',$3) returning *`, [company, name, unit]))[0]
const tissu = await mat('Tissu P51', 'm')
const fil = await mat('Fil P51', 'pc')
const receive = (m, qty, code) => as(mag, () => q(`select public.stock_receive_lot(p_material=>$1, p_warehouse=>$2, p_location=>$3, p_qty=>$4, p_lot_code=>$5, p_expiry=>(current_date + 300)::date, p_reference=>'REC-P51', p_reason=>null, p_unit_cost=>5)`, [m, wh, loc, qty, code]))
await receive(tissu.id, 30, 'LOT-T51')
await receive(tissu.id, 30, 'LOT-T51B')
await receive(fil.id, 50, 'LOT-F51')
const lotId = async (code) => (await q(`select id from stock_lots where lot_code=$1`, [code]))[0].id
const L_T51 = await lotId('LOT-T51')
const L_T51B = await lotId('LOT-T51B')
const L_F51 = await lotId('LOT-F51')

await as(qual, () => rpc('quality_instrument_save', 'MET-51', 'Mètre à ruban étalonné', iso(90), true))
await as(qual, () => rpc('quality_instrument_save', 'BAL-51', 'Dynamomètre de contrôle', iso(1), true))
const instId = async (code) => (await q(`select id from quality_instruments where code=$1`, [code]))[0].id
const instMet = await instId('MET-51')
const instBal = await instId('BAL-51')
ok('instrument enregistré avec date d’étalonnage tenue par la société', (await q(`select calibration_due::text d from quality_instruments where code='MET-51'`))[0].d === iso(90))

// --- Plan v1 « réception tissu » : largeur (mesure, 2 échantillons) et composition (attribut) ----------------------------------------
await rejects('plan de réception sans matière refusé (QPLAN_SCOPE_MISMATCH)', () => as(qual, () => rpc('quality_control_plan_create', 'TIS-REC', 'Plan tissu', 'reception', null, null)), 'QPLAN_SCOPE_MISMATCH')
const plan1 = await as(qual, () => rpc('quality_control_plan_create', 'TIS-REC', 'Réception tissu', 'reception', tissu.id, null))
ok('plan TIS-REC version 1 créé en brouillon', (await q(`select version_no, status from quality_control_plans where id=$1`, [plan1]))[0].version_no === 1
  && (await q(`select status from quality_control_plans where id=$1`, [plan1]))[0].status === 'draft')
await rejects('mesure sans unité refusée (QPLAN_CHARACTERISTIC_INVALID)', () => as(qual, () => rpc('quality_control_plan_add_characteristic', plan1, 'Largeur', 'Ruban sur 3 points', 'measure', 2, null, 149, 151, instMet)), 'QPLAN_CHARACTERISTIC_INVALID')
await rejects('mesure sans instrument refusée (QPLAN_CHARACTERISTIC_INVALID)', () => as(qual, () => rpc('quality_control_plan_add_characteristic', plan1, 'Largeur', 'Ruban sur 3 points', 'measure', 2, 'cm', 149, 151, null)), 'QPLAN_CHARACTERISTIC_INVALID')
await rejects('tolérance inversée refusée (QPLAN_CHARACTERISTIC_INVALID)', () => as(qual, () => rpc('quality_control_plan_add_characteristic', plan1, 'Largeur', 'Ruban sur 3 points', 'measure', 2, 'cm', 151, 149, instMet)), 'QPLAN_CHARACTERISTIC_INVALID')
await as(qual, () => rpc('quality_control_plan_add_characteristic', plan1, 'Largeur', 'Ruban sur 3 points', 'measure', 2, 'cm', 149, 151, instMet))
await as(qual, () => rpc('quality_control_plan_add_characteristic', plan1, 'Composition', 'Contrôle étiquette et fiche', 'attribute', 1, null, null, null, null))
await rejects('activation par le rédacteur refusée (QPLAN_SOD)', () => as(qual, () => rpc('quality_control_plan_activate', plan1, iso(-5))), 'QPLAN_SOD')
const emptyPlan = await as(admin, () => rpc('quality_control_plan_create', 'VIDE', 'Plan vide', 'reception', tissu.id, null))
await rejects('plan sans caractéristique refusé à l’activation (QPLAN_NO_CHARACTERISTIC)', () => as(qual, () => rpc('quality_control_plan_activate', emptyPlan, iso(-5))), 'QPLAN_NO_CHARACTERISTIC')
await as(admin, () => rpc('quality_control_plan_activate', plan1, iso(-5)))
ok('plan v1 actif à partir de J-5, caractéristiques figées', (await q(`select status, valid_from::text v from quality_control_plans where id=$1`, [plan1]))[0].status === 'active'
  && (await q(`select count(*)::int n from quality_plan_characteristics where plan_id=$1`, [plan1]))[0].n === 2)
await rejects('caractéristique ajoutée à un plan actif refusée (QPLAN_BAD_STATUS)', () => as(qual, () => rpc('quality_control_plan_add_characteristic', plan1, 'Autre', 'Méthode', 'attribute', 1, null, null, null, null)), 'QPLAN_BAD_STATUS')

// Chevauchement : un second plan actif sur le même périmètre et la même étape est refusé
const plan2x = await as(qual, () => rpc('quality_control_plan_create', 'TIS-DOUBLON', 'Doublon tissu', 'reception', tissu.id, null))
await as(qual, () => rpc('quality_control_plan_add_characteristic', plan2x, 'Composition', 'Contrôle étiquette', 'attribute', 1, null, null, null, null))
await rejects('second plan actif sur le même périmètre refusé (QPLAN_OVERLAP)', () => as(admin, () => rpc('quality_control_plan_activate', plan2x, iso(0))), 'QPLAN_OVERLAP')

// --- Plan « réception fil » (mesure de tension, instrument BAL-51) --------------------------------------------------------------------
const planFil = await as(qual, () => rpc('quality_control_plan_create', 'FIL-REC', 'Réception fil', 'reception', fil.id, null))
await as(qual, () => rpc('quality_control_plan_add_characteristic', planFil, 'Tension', 'Dynamomètre sur bobine', 'measure', 1, 'cN', 10, 20, instBal))
await as(admin, () => rpc('quality_control_plan_activate', planFil, iso(-5)))

// --- Ouverture des contrôles planifiés : lié au lot, plan à la date d'ouverture -------------------------------------------------------
await rejects('contrôle sans plan actif pour la matière refusé (QUALITY_PLAN_MISSING)', async () => {
  const mauve = await mat('Bouton P51', 'pc')
  await receive(mauve.id, 5, 'LOT-B51')
  const lB = await lotId('LOT-B51')
  return as(qual, () => rpc('quality_inspection_open_planned', 'reception', mauve.id, null, null, null, null, 2, lB, null, null))
}, 'QUALITY_PLAN_MISSING')
await rejects('lot d’une autre matière refusé (QUALITY_SOURCE_NOT_FOUND)', () => as(qual, () => rpc('quality_inspection_open_planned', 'reception', tissu.id, null, null, null, null, 2, L_F51, null, null)), 'QUALITY_SOURCE_NOT_FOUND')
const insp1 = await as(qual, () => rpc('quality_inspection_open_planned', 'reception', tissu.id, null, null, null, 'BL-51-A', 2, L_T51, null, 'Réception lot tissu A'))
const snapOpen = await as(admin, () => rpc('quality_inspection_snapshot', insp1))
ok('contrôle ouvert sur le plan v1, lié au lot matière, caractéristiques copiées avec leur tolérance', snapOpen.plan.code === 'TIS-REC' && snapOpen.plan.version_no === 1
  && snapOpen.characteristics.length === 2 && snapOpen.characteristics[0].tol_min == 149 && snapOpen.characteristics[0].unit === 'cm'
  && (await q(`select material_lot_id = $1 ok from quality_inspections where id=$2`, [L_T51, insp1]))[0].ok === true)

// --- Résultats : unité, tolérance, échantillon, saisie séparée de la décision ----------------------------------------------------------
const charWidth = snapOpen.characteristics.find((c) => c.name === 'Largeur').id
const charComp = snapOpen.characteristics.find((c) => c.name === 'Composition').id
await rejects('unité différente de celle de la caractéristique refusée (QUALITY_UNIT_MISMATCH)', () => as(qual, () => rpc('quality_measurement_record', insp1, charWidth, 1, 'm', 1.50, null)), 'QUALITY_UNIT_MISMATCH')
await rejects('valeur absente refusée (QUALITY_VALUE_REQUIRED)', () => as(qual, () => rpc('quality_measurement_record', insp1, charWidth, 1, 'cm', null, null)), 'QUALITY_VALUE_REQUIRED')
await rejects('échantillon hors plage refusé (QUALITY_SAMPLE_OUT_OF_RANGE)', () => as(qual, () => rpc('quality_measurement_record', insp1, charWidth, 3, 'cm', 150, null)), 'QUALITY_SAMPLE_OUT_OF_RANGE')
await as(qual, () => rpc('quality_measurement_record', insp1, charWidth, 1, 'cm', 150.2, null))
await rejects('même échantillon mesuré deux fois refusé (QUALITY_MEASUREMENT_EXISTS)', () => as(qual, () => rpc('quality_measurement_record', insp1, charWidth, 1, 'cm', 150.4, null)), 'QUALITY_MEASUREMENT_EXISTS')
await as(qual, () => rpc('quality_measurement_record', insp1, charWidth, 2, 'cm', 152.0, null))
await rejects('résultat d’attribut invalide refusé (QUALITY_RESULT_INVALID)', () => as(qual, () => rpc('quality_measurement_record', insp1, charComp, 1, null, null, 'peut-être')), 'QUALITY_RESULT_INVALID')
await as(qual, () => rpc('quality_measurement_record', insp1, charComp, 1, null, null, 'ok'))
const meas = await q(`select sample_no, value_raw::float v, unit, in_tolerance, instrument_code from quality_measurements where inspection_id=$1 and characteristic_id=$2 order by sample_no`, [insp1, charWidth])
ok('résultats conservés : valeur brute, unité, hors tolérance pour l’échantillon 2 (152 cm > 151), instrument et étalonnage', meas[0].v === 150.2 && meas[0].unit === 'cm' && meas[0].in_tolerance === true
  && meas[1].in_tolerance === false && meas[0].instrument_code === 'MET-51')

// Décision : résultats complets et conformes exigés ; décideur distinct des saisissants
await rejects('décision par un utilisateur sans droit d’approbation refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('quality_inspection_decide', insp1, 'rejected', 'Refus')), 'RBAC_FORBIDDEN')
await rejects('décision par le saisissant refusée (QUALITY_DECIDER_IS_RECORDER)', () => as(qual, () => rpc('quality_inspection_decide', insp1, 'rejected', 'Refus')), 'QUALITY_DECIDER_IS_RECORDER')
const insp1b = await as(qual, () => rpc('quality_inspection_open_planned', 'reception', tissu.id, null, null, null, 'BL-51-C', 1, L_T51B, null, null))
await rejects('acceptation sans tous les résultats refusée (QUALITY_RESULTS_INCOMPLETE)', () => as(admin, () => rpc('quality_inspection_decide', insp1b, 'accepted', 'Acceptation')), 'QUALITY_RESULTS_INCOMPLETE')
await rejects('acceptation avec une valeur hors tolérance refusée (QUALITY_OUT_OF_TOLERANCE)', () => as(admin, () => rpc('quality_inspection_decide', insp1, 'accepted', 'Acceptation')), 'QUALITY_OUT_OF_TOLERANCE')
const rej = await as(admin, () => rpc('quality_inspection_decide', insp1, 'rejected', 'Largeur hors tolérance au second échantillon'))
ok('décision de rejet par un utilisateur habilité : contrôle clos, non-conformité ouverte', rej.decision === 'rejected' && rej.nc_number && rej.qty_rejected === 2
  && (await q(`select status, closed_by = $2 by from quality_inspections where id=$1`, [insp1, admin]))[0].by === true)

// --- Instrument échu : mesure refusée ----------------------------------------------------------------------------------------------------
const insFil = await as(qual, () => rpc('quality_inspection_open_planned', 'reception', fil.id, null, null, null, 'BL-F51', 1, L_F51, null, null))
await db.query(`update quality_instruments set calibration_due = current_date - 1 where code='BAL-51'`)
const charFil = (await q(`select id from quality_inspection_characteristics where inspection_id=$1`, [insFil]))[0].id
await rejects('mesure avec un instrument non étalonné refusée (QUALITY_INSTRUMENT_NOT_CALIBRATED)', () => as(qual, () => rpc('quality_measurement_record', insFil, charFil, 1, 'cN', 15, null)), 'QUALITY_INSTRUMENT_NOT_CALIBRATED')
await db.query(`update quality_instruments set calibration_due = current_date + 1 where code='BAL-51'`)

// --- Plan v2 (tolérance resserrée) : le rejeu de v1 garde v1 ; un nouveau contrôle prend v2 ------------------------------------------------
const plan2 = await as(qual, () => rpc('quality_control_plan_create', 'TIS-REC', 'Réception tissu v2', 'reception', tissu.id, null))
await as(qual, () => rpc('quality_control_plan_add_characteristic', plan2, 'Largeur', 'Ruban sur 3 points', 'measure', 2, 'cm', 148, 152, instMet))
await as(qual, () => rpc('quality_control_plan_add_characteristic', plan2, 'Composition', 'Contrôle étiquette et fiche', 'attribute', 1, null, null, null, null))
await as(admin, () => rpc('quality_control_plan_activate', plan2, iso(0)))
ok('activation de v2 : v1 retirée à la veille, une seule version active', (await q(`select status, valid_to::text t from quality_control_plans where id=$1`, [plan1]))[0].status === 'retired'
  && (await q(`select count(*)::int n from quality_control_plans where code='TIS-REC' and status='active'`))[0].n === 1)
const atOld = await as(admin, () => rpc('quality_control_plan_at', 'reception', tissu.id, null, iso(-10)))
const atNow = await as(admin, () => rpc('quality_control_plan_at', 'reception', tissu.id, null, iso(0)))
ok('plan à date : avant J-5 aucun plan ; aujourd’hui la version 2', atOld === null && atNow.version_no === 2)

const replayShort = () => as(qual, () => rpc('quality_inspection_replay', insp1, 'court'))
await rejects('rejeu sans motif suffisant refusé (QUALITY_REPLAY_REASON_REQUIRED)', replayShort, 'QUALITY_REPLAY_REASON_REQUIRED')
const rp = await as(qual, () => rpc('quality_inspection_replay', insp1, 'Contrôle de confirmation demandé par le fournisseur'))
const snapRp = await as(admin, () => rpc('quality_inspection_snapshot', rp))
ok('contrôle rejoué : même plan que l’original (v1, tolérance 149–151), lien vers l’original, résultats vides',
  snapRp.plan.version_no === 1 && snapRp.characteristics.find((c) => c.name === 'Largeur').tol_max == 151 && snapRp.replay_of_id === insp1 && snapRp.measurements.length === 0)
const insp2 = await as(qual, () => rpc('quality_inspection_open_planned', 'reception', tissu.id, null, null, null, 'BL-51-B', 2, L_T51B, null, null))
const snap2 = await as(admin, () => rpc('quality_inspection_snapshot', insp2))
ok('nouveau contrôle à date : prend la version 2 (tolérance 148–152)', snap2.plan.version_no === 2 && snap2.characteristics.find((c) => c.name === 'Largeur').tol_max == 152)
await rejects('rejeu d’un contrôle ouvert refusé (QUALITY_BAD_STATUS)', () => as(qual, () => rpc('quality_inspection_replay', insp2, 'Rejeu sur un contrôle encore ouvert')), 'QUALITY_BAD_STATUS')

// --- Preuve et traçabilité -----------------------------------------------------------------------------------------------------------------------
const snap1 = await as(admin, () => rpc('quality_inspection_snapshot', insp1))
const mWidth = snap1.measurements.find((m) => m.sample_no === 2)
ok('preuve conservée : unité cm, valeur brute 152, instrument MET-51 avec date d’étalonnage, auteur de la saisie, décideur', mWidth.unit === 'cm' && mWidth.value == 152 && mWidth.instrument === 'MET-51'
  && mWidth.calibration_due === iso(90) && mWidth.recorded_by === qual && snap1.decided_by === admin && snap1.decision === 'rejected')
const byLot = await as(admin, () => rpc('quality_inspections_for_lot', 'material_lot', L_T51))
ok('traçabilité : le lot LOT-T51 retrouve son contrôle initial (plan TIS-REC v1)', byLot.some((x) => x.inspection === snap1.inspection && x.plan === 'TIS-REC' && x.plan_version_no === 1))
ok('traçabilité : le lot LOT-T51 retrouve aussi le contrôle rejoué, qui renvoie à l’original', byLot.some((x) => x.inspection === snapRp.inspection && x.replay_of === snap1.inspection))
await rejects('lien de recherche inconnu refusé (QUALITY_BAD_LINK)', () => as(admin, () => rpc('quality_inspections_for_lot', 'inconnu', insp1)), 'QUALITY_BAD_LINK')

// --- Droits, immutabilité, historique ------------------------------------------------------------------------------------------------------------
await rejects('résultat modifié directement refusé (QUALITY_APPEND_ONLY)', () => db.query(`update quality_measurements set value_raw = 1 where inspection_id=$1`, [insp1]), 'QUALITY_APPEND_ONLY')
await rejects('résultat inséré directement refusé (permission denied)', () => as(qual, () => db.query(`insert into quality_measurements(company_id, inspection_id, characteristic_id, sample_no, in_tolerance) values ($1,$2,$3,1,true)`, [company, insp1, charWidth])), 'permission denied')
await rejects('plan sans droit de rédaction refusé (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('quality_control_plan_create', 'X', 'Non', 'reception', tissu.id, null)), 'RBAC_FORBIDDEN')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : plans créés (5), activés (3), instruments (2), résultats (3), décision (1), rejeu (1)', (await aud('quality.plan_create')) === 5 && (await aud('quality.plan_activate')) === 3
  && (await aud('quality.instrument_save')) === 2 && (await aud('quality.measurement_record')) === 3 && (await aud('quality.inspection_decide')) === 1
  && (await aud('quality.inspection_replay')) === 1)
