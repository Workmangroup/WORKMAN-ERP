// Capacité et ordonnancement : charge, capacité finie, calendrier, priorité, scénarios comparés, validation distincte,
// plan versionné — P047 / migration 0072
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const dateOf = async (n) => (await q(`select (current_date + $1::int)::text d`, [n]))[0].d

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const admin2 = await mkUser('admin2@x.com', 'admin')
const direction = await mkUser('dir@x.com', 'direction')
const prod = await mkUser('prod@x.com', 'production')
const comm = await mkUser('comm@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const fin = await mkUser('fin@x.com', 'finance')
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const T = await dateOf(0)
const D = (n) => dateOf(n)

// --- Référentiel : calendriers, postes (dont un sans calendrier), articles, commande client -------------------------------------
const cal7 = (await q(`insert into calendars(company_id, code, name, owner_id, working_days) values ($1,'CAL-7J','7 jours',$2,'{1,2,3,4,5,6,7}') returning id`, [company, admin]))[0].id
const cal5 = (await q(`insert into calendars(company_id, code, name, owner_id, working_days) values ($1,'CAL-5J','Semaine',$2,'{1,2,3,4,5}') returning id`, [company, admin]))[0].id
const wcCoupe = (await q(`insert into work_centers(company_id, code, name, kind, hours_per_day, efficiency_pct, calendar_id) values ($1,'COUP47','Coupe 47','coupe',8,100,$2) returning id`, [company, cal7]))[0].id
const wcCout = (await q(`insert into work_centers(company_id, code, name, kind, hours_per_day, efficiency_pct, calendar_id) values ($1,'COUT47','Couture 47','couture',8,100,$2) returning id`, [company, cal5]))[0].id
const wcSans = (await q(`insert into work_centers(company_id, code, name, kind, hours_per_day, efficiency_pct) values ($1,'SANS47','Sans calendrier','finition',8,100) returning id`, [company]))[0].id
const wcSusp = (await q(`insert into work_centers(company_id, code, name, kind, hours_per_day, efficiency_pct, calendar_id) values ($1,'SUSP47','Suspendu 47','coupe',8,100,$2) returning id`, [company, cal7]))[0].id
const wcOver = (await q(`insert into work_centers(company_id, code, name, kind, hours_per_day, efficiency_pct, calendar_id) values ($1,'OVER47','Surcharge 47','coupe',8,100,$2) returning id`, [company, cal7]))[0].id
const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT P47','FR') returning id`)))[0].id
const art = async (ref) => (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,$2,$3,$2,'jacket') returning id`, [lafont, ref, 'L-' + ref])))[0].id
const aP1 = await art('P47A'), aP2 = await art('P47B'), aP3 = await art('P47C'), aF = await art('P47F'), aO = await art('P47O'), aC = await art('P47K'), aN = await art('P47N')
const order = (await as(comm, () => q(`insert into sales_orders(client_id, client_ref) values ($1,'PO-P47') returning id`, [lafont])))[0].id
await as(comm, () => db.query(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,10, current_date + 3)`, [order, aP1]))
await as(comm, () => db.query(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,10, current_date + 2)`, [order, aP2]))
await as(comm, () => rpc('sales_order_confirm', order))

// --- Ordres de fabrication ----------------------------------------------------------------------------------------------------------------
const of = async (u, article, qty, std, wc, s, e, so = null) => (await as(u, () => rpc('production_order_create', article, qty, std, wc, s, e, so, null)))
const ofRow = async (article) => (await q(`select id, number, status, priority, planned_start::text ps, planned_end::text pe, work_center_id from production_orders where article_id=$1`, [article]))[0]
// Charge figée : OF F (10 × 60 min = 600 min, T..T+1 sur COUP47) et OF O (1 200 min le jour T sur OVER47, capacité 480)
await of(admin, aF, 10, 60, wcCoupe, T, await D(1))
const fRow = await ofRow(aF)
await as(admin, () => rpc('production_order_launch', fRow.id))
await of(admin, aO, 10, 120, wcOver, T, T)
const oRow = await ofRow(aO)
await as(admin, () => rpc('production_order_launch', oRow.id))
// Planifiés : P1 (priorité 1, échéance T+3), P2 (priorité 3, échéance T+2), même poste COUP47 ; P3 sur semaine ; C sans calendrier ; N sans poste
await of(admin, aP1, 10, 60, wcCoupe, T, await D(1), order)
await of(admin, aP2, 10, 60, wcCoupe, T, await D(1), order)
await of(admin, aP3, 20, 60, wcCout, T, await D(3))
await of(admin, aC, 5, 60, wcSans, T, await D(1))
await of(admin, aN, 5, 60, null, T, await D(1))
const aS = await art('P47S')
await of(admin, aS, 4, 60, wcSusp, T, await D(1))
const sRow = await ofRow(aS)
await as(admin, () => rpc('production_order_launch', sRow.id))
await as(admin, () => rpc('production_order_suspend', sRow.id, 'Attente matière'))
const p1 = await ofRow(aP1), p2 = await ofRow(aP2), p3 = await ofRow(aP3), oC = await ofRow(aC), oN = await ofRow(aN)
await as(admin, () => rpc('production_order_set_priority', p1.id, 1))
await as(admin, () => rpc('production_order_set_priority', p2.id, 3))
await as(admin, () => rpc('production_order_set_priority', p3.id, 2))

// --- 1. Charge atelier (état actuel) ---------------------------------------------------------------------------------------------------------
const t3 = await D(3)
const load = await as(admin, () => rpc('production_load', T, t3))
const rowAt = (code, day) => load.rows.find((r) => r.work_center === code && r.day === day)
const coupeT = rowAt('COUP47', T)
ok('charge COUP47 le jour T : figé 300 + planifié 600 = 900 min sur 480 → surcharge signalée', coupeT && Number(coupeT.committed_minutes) === 300 && Number(coupeT.planned_minutes) === 600 && coupeT.status === 'overload')
ok('poste sans calendrier : capacité absente (capacity_missing), pas de capacité inventée', rowAt('SANS47', T) && rowAt('SANS47', T).capacity_minutes === null && rowAt('SANS47', T).status === 'capacity_missing')
ok('charge : OF sans poste comptés, nombre de jours en surcharge exposé', load.orders_without_work_center === 1 && load.overload_days >= 1)
const far = await D(200)
await rejects('charge : plage supérieure à 120 jours refusée (SCHEDULE_RANGE_INVALID)', () => as(admin, () => rpc('production_load', T, far)), 'SCHEDULE_RANGE_INVALID')

// --- 2. Simulation à capacité finie : priorité -----------------------------------------------------------------------------------------------
const scnP = await as(admin, () => rpc('production_schedule_simulate', 'Priorité', JSON.stringify({ horizon_days: 60, sort: 'priority' })))
const scnPCode = (await q(`select code, status, created_by from production_schedule_scenarios where id=$1`, [scnP]))[0]
ok('scénario créé (PLN-0001, simulé, par son auteur)', scnPCode.code === 'PLN-0001' && scnPCode.status === 'simulated' && scnPCode.created_by === admin)
const sumP = (await q(`select summary from production_schedule_scenarios where id=$1`, [scnP]))[0].summary
ok('résumé : 7 OF, 2 figés, 3 ordonnancés, 1 sans capacité, 1 sans poste', sumP.orders === 7 && sumP.fixed === 2 && sumP.scheduled === 3 && sumP.capacity_missing === 1 && sumP.no_work_center === 1)
ok('OF suspendu : hors simulation mais compté dans le résumé (suspended_excluded = 1)', sumP.suspended_excluded === 1 && (await q(`select count(*)::int n from production_schedule_lines where scenario_id=$1 and number=$2`, [scnP, sRow.number]))[0].n === 0)
ok('surcharge figée signalée dans le résumé (overload_days ≥ 1)', sumP.overload_days >= 1)
const LP = async (scn, num) => (await q(`select * from production_schedule_lines where scenario_id=$1 and number=$2`, [scn, num]))[0]
const lP1 = await LP(scnP, p1.number), lP2 = await LP(scnP, p2.number)
ok('P1 (priorité 1) : fin J+2 (300 + 180 + 180 + 240 de capacité libre)', (await q(`select sim_end::text d from production_schedule_lines where id=$1`, [lP1.id]))[0].d === await D(2) && lP1.client_late === false)
ok('P2 (priorité 3) : fin J+3, en retard sur l’échéance client J+2, retard nouveau par rapport au plan actuel', (await q(`select sim_end::text d from production_schedule_lines where id=$1`, [lP2.id]))[0].d === await D(3)
  && lP2.client_late === true && lP2.new_client_late === true)
ok('aucune surcharge silencieuse : aucun jour de COUP47 au-delà de sa capacité dans le plan simulé', (await q(`select count(*)::int n from production_capacity_days where scenario_id=$1 and work_center_id=$2 and status='overload'`, [scnP, wcCoupe]))[0].n === 0
  && (await q(`select max(load_minutes)::float m from production_capacity_days where scenario_id=$1 and work_center_id=$2`, [scnP, wcCoupe]))[0].m <= 480)
ok('OF sans calendrier : statut capacity_missing, aucune date simulée, aucun jour de capacité inventé', (await LP(scnP, oC.number)).status === 'capacity_missing'
  && (await LP(scnP, oC.number)).sim_end === null && (await q(`select count(*)::int n from production_capacity_days where scenario_id=$1 and work_center_id=$2`, [scnP, wcSans]))[0].n === 0)
ok('OF sans poste : statut no_work_center', (await LP(scnP, oN.number)).status === 'no_work_center')
const lP3 = await LP(scnP, p3.number)
ok('calendrier semaine : aucun jour de capacité un samedi ou dimanche pour COUT47, fin de P3 ouvrée', (await q(`select count(*)::int n from production_capacity_days where scenario_id=$1 and work_center_id=$2 and extract(isodow from day) > 5`, [scnP, wcCout]))[0].n === 0
  && (await q(`select extract(isodow from sim_end)::int d from production_schedule_lines where id=$1`, [lP3.id]))[0].d <= 5)

// --- 3. Simulation par échéance client (scénario comparé) ----------------------------------------------------------------------------------
const scnD = await as(admin, () => rpc('production_schedule_simulate', 'Échéance', JSON.stringify({ horizon_days: 60, sort: 'due_date' })))
const sumD = (await q(`select summary from production_schedule_scenarios where id=$1`, [scnD]))[0].summary
ok('tri par échéance : aucun nouveau retard client (P2 avant P1, fin J+2 et J+3)', sumD.client_new_late === 0 && (await q(`select sim_end::text d from production_schedule_lines where scenario_id=$1 and number=$2`, [scnD, p2.number]))[0].d === await D(2)
  && (await q(`select sim_end::text d from production_schedule_lines where scenario_id=$1 and number=$2`, [scnD, p1.number]))[0].d === await D(3))
await rejects('tri inconnu refusé (SCHEDULE_SORT_INVALID)', () => as(admin, () => rpc('production_schedule_simulate', 'X', JSON.stringify({ sort: 'hasard' }))), 'SCHEDULE_SORT_INVALID')
await rejects('simulation sans droit de planification refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_schedule_simulate', 'X', '{}')), 'RBAC_FORBIDDEN')

const cmp = await as(admin, () => rpc('production_schedule_compare', scnP, scnD))
const cmpP2 = cmp.orders.find((o) => o.number === p2.number)
ok('comparaison : P2 finit un jour plus tôt par le tri par échéance, retard client évité (PLN-0001 contre PLN-0002)', cmpP2.delta_b_minus_a === -1 && cmpP2.client_late_a === true && cmpP2.client_late_b === false
  && cmp.a.summary.client_new_late === 1 && cmp.b.summary.client_new_late === 0)

// --- 4. Validation : distincte, accords explicites, obsolescence, versions -----------------------------------------------------------------
await rejects('validation par l’auteur refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('production_schedule_validate', scnD, 'validate', 'Auto', true, true)), 'SOD_SELF_APPROVAL')
await rejects('validation sans droit d’approbation refusée (RBAC_FORBIDDEN)', () => as(prod, () => rpc('production_schedule_validate', scnD, 'validate', 'Non', true, true)), 'RBAC_FORBIDDEN')
await rejects('plan avec surcharge : validation refusée sans accord de surcharge (PLAN_OVERLOAD_NOT_ACKNOWLEDGED)', () => as(admin2, () => rpc('production_schedule_validate', scnD, 'validate', 'Sans accord', false, false)), 'PLAN_OVERLOAD_NOT_ACKNOWLEDGED')
await rejects('plan avec retard client nouveau : validation refusée sans accord client (PLAN_CLIENT_IMPACT_NOT_ACKNOWLEDGED)', () => as(admin2, () => rpc('production_schedule_validate', scnP, 'validate', 'Sans accord client', false, true)), 'PLAN_CLIENT_IMPACT_NOT_ACKNOWLEDGED')
await rejects('plan avec retard client nouveau : accord client seul insuffisant (surcharge à acquitter)', () => as(admin2, () => rpc('production_schedule_validate', scnP, 'validate', 'Accord client seul', true, false)), 'PLAN_OVERLOAD_NOT_ACKNOWLEDGED')

const nChanged = (await q(`select count(*)::int n from production_schedule_lines where scenario_id=$1 and status='scheduled' and (sim_start is distinct from base_start or sim_end is distinct from base_end)`, [scnD]))[0].n
const acc = await as(admin2, () => rpc('production_schedule_validate', scnD, 'validate', 'Plan par échéance accepté', false, true))
ok('plan accepté : version 1, OF modifiés listés (avant / après)', acc.status === 'validated' && acc.version_no === 1 && acc.changed === nChanged && nChanged >= 2)
const pAfter = await q(`select number, planned_end::text pe from production_orders where id in ($1,$2)`, [p1.id, p2.id])
ok('dates des OF planifiés mises à jour selon le scénario accepté (P2 fin J+2, P1 fin J+3)', pAfter.find((r) => r.number === p2.number).pe === await D(2) && pAfter.find((r) => r.number === p1.number).pe === await D(3))
const ver = (await q(`select version_no, jsonb_array_length(changes) n, scenario_id from production_plan_versions where company_id=$1`, [company]))
ok('version du plan enregistrée avec ses changements', ver.length === 1 && ver[0].version_no === 1 && ver[0].n === nChanged && ver[0].scenario_id === scnD)
await rejects('scénario déjà validé : validation refusée (PLAN_BAD_STATUS)', () => as(admin2, () => rpc('production_schedule_validate', scnD, 'validate', 'Deux fois', false, true)), 'PLAN_BAD_STATUS')
await rejects('scénario devenu obsolète (les OF ont changé) : validation refusée (PLAN_STALE)', () => as(admin2, () => rpc('production_schedule_validate', scnP, 'validate', 'Obsolète', true, true)), 'PLAN_STALE')

// --- 5. Priorité, refus, immutabilité -----------------------------------------------------------------------------------------------------
await rejects('priorité hors 1 à 5 refusée (PRODUCTION_PRIORITY_INVALID)', () => as(prod, () => rpc('production_order_set_priority', p1.id, 9)), 'PRODUCTION_PRIORITY_INVALID')
await rejects('priorité sans droit de planification refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_order_set_priority', p1.id, 2)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('production_order_set_priority', p1.id, 2))
ok('priorité de P1 changée par le planificateur (2)', (await q(`select priority from production_orders where id=$1`, [p1.id]))[0].priority === 2)

const scnR = await as(admin, () => rpc('production_schedule_simulate', 'À refuser', JSON.stringify({ horizon_days: 60 })))
const p3Before = (await q(`select planned_start::text s, planned_end::text e from production_orders where id=$1`, [p3.id]))[0]
await as(admin2, () => rpc('production_schedule_validate', scnR, 'reject', 'Hors délai', false, false))
ok('scénario refusé : statut rejected, aucun OF modifié', (await q(`select status from production_schedule_scenarios where id=$1`, [scnR]))[0].status === 'rejected'
  && JSON.stringify((await q(`select planned_start::text s, planned_end::text e from production_orders where id=$1`, [p3.id]))[0]) === JSON.stringify(p3Before))
await rejects('scénario refusé : validation ultérieure refusée (PLAN_BAD_STATUS)', () => as(admin2, () => rpc('production_schedule_validate', scnR, 'validate', 'Tard', true, true)), 'PLAN_BAD_STATUS')

await rejects('écriture directe d’une ligne de planification refusée (permission denied)', () => as(admin, () => db.query(`insert into production_schedule_lines(company_id, scenario_id, order_id, number, status, qty, std_minutes_per_unit, priority, base_status, base_start, base_end, rank) values ($1,$2,$3,'X','scheduled',1,1,1,'planned',current_date,current_date,1)`, [company, scnP, p3.id])), 'permission denied')
await rejects('insertion de ligne sans passer par la fonction refusée (SCHEDULE_RPC_ONLY)', () => db.query(`insert into production_schedule_lines(company_id, scenario_id, order_id, number, status, qty, std_minutes_per_unit, priority, base_status, base_start, base_end, rank) values ($1,$2,$3,'X','scheduled',1,1,1,'planned',current_date,current_date,99)`, [company, scnP, p3.id]), 'SCHEDULE_RPC_ONLY')
await rejects('ligne de planification immuable (SCHEDULE_IMMUTABLE)', () => db.query(`update production_schedule_lines set sim_end = current_date where scenario_id=$1`, [scnP]), 'SCHEDULE_IMMUTABLE')
await rejects('version du plan immuable (SCHEDULE_IMMUTABLE)', () => db.query(`update production_plan_versions set note='x'`), 'SCHEDULE_IMMUTABLE')
await rejects('scénario non supprimable (SCHEDULE_IMMUTABLE)', () => db.query(`delete from production_schedule_scenarios where id=$1`, [scnP]), 'SCHEDULE_IMMUTABLE')

// isolement : scénario d'une autre société invisible
const other = (await q(`insert into companies(name) values ('Autre P47') returning id`))[0].id
await db.exec(`begin; select set_config('schedule.rpc','on',true); insert into production_schedule_scenarios(company_id, code, name, status) values ('${other}', 'PLN-9001', 'Étranger', 'simulated'); commit;`)
ok('isolation : scénario d’une autre société invisible', (await as(admin, () => q(`select id from production_schedule_scenarios where code='PLN-9001'`))).length === 0)

// --- 6. Historique ---------------------------------------------------------------------------------------------------------------------------
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
const counts = [await aud('production.schedule_simulate'), await aud('production.plan_validate'), await aud('production.plan_reject'), await aud('production.order_priority')]
ok('audit : 3 simulations, 1 validation, 1 refus, 4 changements de priorité (3 à la préparation, 1 par le planificateur)', counts.join() === '3,1,1,4', counts.join())
