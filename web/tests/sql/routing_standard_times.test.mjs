// Gammes et temps standards : opérations, unités de temps, approbation distincte, version historique, OF figé, compétences, calendrier — P045 / migration 0070
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, eps = 0.0006) => Math.abs(Number(a) - b) < eps

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
const production = await mkUser('prod@x.com', 'production')
const nobody = await mkUser('nobody@x.com', null)

// Référentiel : client, articles, calendrier, postes
const client = (await q(`insert into clients(company_id, name, country, currency) values ($1,'LAFONT P45','FR','EUR') returning id`, [company]))[0].id
const article = (await q(`insert into articles(company_id, client_id, internal_ref, client_ref, name) values ($1,$2,'JKT45','LAF-JKT45','Veste P45') returning id`, [company, client]))[0].id
const article2 = (await q(`insert into articles(company_id, client_id, internal_ref, client_ref, name) values ($1,$2,'JKT45B','LAF-JKT45B','Veste P45 sans gamme') returning id`, [company, client]))[0].id
const cal = (await q(`insert into calendars(company_id, code, name, owner_id, working_days) values ($1,'CAL-P45','Atelier 5 jours',$2,'{1,2,3,4,5}') returning id`, [company, admin]))[0].id
const wcCoupe = (await q(`insert into work_centers(company_id, code, name, kind, hours_per_day, efficiency_pct, calendar_id) values ($1,'COUP45','Coupe P45','coupe',8,85,$2) returning id`, [company, cal]))[0].id
const wcPers = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'PERS45','Personnalisation P45','personnalisation') returning id`, [company]))[0].id
const wcPack = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'PACK45','Pack P45','pack') returning id`, [company]))[0].id
const wcCtrl = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'CTRL45','Contrôle P45','controle') returning id`, [company]))[0].id
const wcConf = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'CONF45','Confection P45','couture') returning id`, [company]))[0].id

// 1. Compétences : catalogue et niveaux
const skill = await as(admin, () => rpc('production_skill_create', 'coupe-exp', 'Coupe experte'))
ok('compétence créée avec code normalisé en majuscules', (await q(`select code from production_skills where id=$1`, [skill]))[0].code === 'COUPE-EXP')
await rejects('code de compétence en double refusé', () => as(admin, () => rpc('production_skill_create', 'COUPE-EXP', 'Doublon')), 'duplicate key')
await rejects('niveau de compétence hors 1 à 3 refusé (SKILL_LEVEL_INVALID)', () => as(admin, () => rpc('profile_skill_set', admin2, skill, 4, null)), 'SKILL_LEVEL_INVALID')
await as(admin, () => rpc('profile_skill_set', admin2, skill, 2, '2027-12-31'))
await as(admin, () => rpc('profile_skill_set', admin2, skill, 3, '2027-12-31'))
const ps = (await q(`select level from profile_skills where profile_id=$1 and skill_id=$2`, [admin2, skill]))
ok('niveau de compétence mis à jour sans doublon (une ligne, niveau 3)', ps.length === 1 && Number(ps[0].level) === 3)

// 2. Calendrier de poste : capacité explicite
const cap = await as(admin, () => rpc('work_center_capacity', wcCoupe))
ok('capacité du poste COUP45 : 8 h × 60 × 85 % × 5 jours = 2040 min/semaine', cap.unit === 'min' && near(cap.minutes_per_week, 2040, 0.01) && Number(cap.working_days_per_week) === 5)
const capNone = await as(admin, () => rpc('work_center_capacity', wcPers))
ok('poste sans calendrier : pas de capacité inventée (CALENDAR_MISSING)', capNone.minutes_per_week === null && capNone.reason === 'CALENDAR_MISSING')
const otherCo = (await q(`insert into companies(name) values ('Autre société P45') returning id`))[0].id
const otherUser = await mkUser('other@x.com', null)
await db.query(`update profiles set company_id=$1 where id=$2`, [otherCo, otherUser])
const otherCal = (await q(`insert into calendars(company_id, code, name, owner_id, working_days) values ($1,'CAL-X','Autre',$2,'{1}') returning id`, [otherCo, otherUser]))[0].id
await rejects('calendrier d’une autre société refusé sur un poste (ROUTING_CALENDAR_INVALID)', () => db.query(`update work_centers set calendar_id=$1 where id=$2`, [otherCal, wcPers]), 'ROUTING_CALENDAR_INVALID')

// 3. Gamme v1 : brouillon et contrôles de saisie
const v1 = await as(admin, () => rpc('routing_version_create', article, 'Gamme initiale'))
ok('brouillon v1 créé, numéro 1', (await q(`select version_no, status from routing_versions where id=$1`, [v1]))[0].status === 'draft')
await rejects('second brouillon pour le même article refusé (ROUTING_DRAFT_EXISTS)', () => as(admin, () => rpc('routing_version_create', article, null)), 'ROUTING_DRAFT_EXISTS')
await rejects('type d’opération inconnu refusé (ROUTING_KIND_INVALID)', () => as(admin, () => rpc('routing_operation_add', v1, 'soudure', 'Soudure', wcCoupe, null, 1, 'min', 0, null)), 'ROUTING_KIND_INVALID')
await rejects('unité de temps « jour » refusée (ROUTING_TIME_UNIT_INVALID)', () => as(admin, () => rpc('routing_operation_add', v1, 'coupe', 'Coupe', wcCoupe, null, 1, 'jour', 0, null)), 'ROUTING_TIME_UNIT_INVALID')
await rejects('temps nul refusé (ROUTING_TIME_INVALID)', () => as(admin, () => rpc('routing_operation_add', v1, 'coupe', 'Coupe', wcCoupe, null, 0, 'min', 0, null)), 'ROUTING_TIME_INVALID')
await rejects('tolérance au-delà de 100 % refusée (ROUTING_ALLOWANCE_INVALID)', () => as(admin, () => rpc('routing_operation_add', v1, 'coupe', 'Coupe', wcCoupe, null, 1, 'min', 150, null)), 'ROUTING_ALLOWANCE_INVALID')
await rejects('compétence inconnue refusée (ROUTING_SKILL_INVALID)', () => as(admin, () => rpc('routing_operation_add', v1, 'coupe', 'Coupe', wcCoupe, '00000000-0000-0000-0000-000000000000', 1, 'min', 0, null)), 'ROUTING_SKILL_INVALID')

// 4. Opérations : coupe / confection / personnalisation / contrôle / pack, unités explicites
const opCoupe = await as(admin, () => rpc('routing_operation_add', v1, 'coupe', 'Coupe des pièces', wcCoupe, skill, 6, 'min', 10, 'Respecter le fil droit'))
const opConf = await as(admin, () => rpc('routing_operation_add', v1, 'confection', 'Confection complète', wcConf, null, 1.5, 'h', 0, 'Vérifier la couture de col'))
const opPers = await as(admin, () => rpc('routing_operation_add', v1, 'personnalisation', 'Broderie logo', wcPers, null, 30, 's', 5, null))
const opCtrl = await as(admin, () => rpc('routing_operation_add', v1, 'controle', 'Contrôle final', wcCtrl, null, 2, 'min', 0, null))
const opPack = await as(admin, () => rpc('routing_operation_add', v1, 'pack', 'Pliage et emballage', wcPack, null, 90, 's', 0, null))
const sum1 = await as(admin, () => rpc('routing_version_summary', v1))
// 6 min × 1,10 + 90 min + 30 s × 1,05 + 2 min + 90 s = 6,6 + 90 + 0,525 + 2 + 1,5 = 100,625 min
ok('temps standard par pièce en minutes : 100,625 min, tolérances incluses', sum1.unit === 'min' && near(sum1.minutes_per_piece, 100.625))
const byId = Object.fromEntries(sum1.operations.map((o) => [o.kind, o]))
ok('unités converties : 1,5 h = 90 min ; 30 s = 0,5 min ; 90 s = 1,5 min', near(byId.confection.standard_minutes, 90) && near(byId.personnalisation.standard_minutes, 0.5) && near(byId.pack.standard_minutes, 1.5))
ok('tolérance explicite : coupe 6 min +10 % = 6,6 min', near(byId.coupe.minutes_with_allowance, 6.6) && Number(byId.coupe.allowance_pct) === 10)
ok('total par type d’opération (min/pièce)', near(sum1.minutes_by_kind.coupe, 6.6) && near(sum1.minutes_by_kind.confection, 90) && near(sum1.minutes_by_kind.personnalisation, 0.525))
const instr = await as(admin, () => rpc('routing_operation_instructions', opConf))
ok('instructions de l’opération lisibles avec le droit de lecture de la gamme', instr.instructions === 'Vérifier la couture de col' && instr.work_center === 'CONF45')
await rejects('instructions refusées sans droit de lecture de la gamme (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('routing_operation_instructions', opConf)), 'RBAC_FORBIDDEN')
await rejects('modification directe d’une opération refusée (ROUTING_RPC_ONLY)', () => db.query(`update routing_operations set time_value=1 where id=$1`, [opCoupe]), 'ROUTING_RPC_ONLY')

// 5. Approbation : droit distinct, valideur distinct du rédacteur, version figée
await rejects('approbation sans droit d’approbation refusée (RBAC_FORBIDDEN)', () => as(production, () => rpc('routing_version_approve', v1, 'Ok')), 'RBAC_FORBIDDEN')
await rejects('approbation par le rédacteur refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('routing_version_approve', v1, 'Auto')), 'SOD_SELF_APPROVAL')
await as(direction, () => rpc('routing_version_approve', v1, 'Conforme au chiffrage atelier'))
const a1 = (await q(`select status, effective_from, approved_by from routing_versions where id=$1`, [v1]))[0]
ok('v1 approuvée par un autre utilisateur, datée', a1.status === 'approved' && a1.effective_from !== null && a1.approved_by === direction)
await rejects('ajout d’opération à une gamme approuvée refusé (ROUTING_BAD_STATUS)', () => as(admin, () => rpc('routing_operation_add', v1, 'pack', 'Pack bis', wcPack, null, 1, 'min', 0, null)), 'ROUTING_BAD_STATUS')
await rejects('modification directe d’une gamme approuvée refusée (ROUTING_RPC_ONLY)', () => db.query(`update routing_versions set note='x' where id=$1`, [v1]), 'ROUTING_RPC_ONLY')

// 6. OF lancé avec v1 : gamme figée
const wc = wcCoupe
const O1 = await as(admin, () => rpc('production_order_create', article, 10, 30, wc, '2027-03-01', '2027-03-10'))
await as(admin, () => rpc('production_order_launch', O1))
const snap1 = await as(admin, () => rpc('production_order_routing_get', O1))
ok('OF lancé : gamme v1 figée avec ses 5 opérations en minutes', snap1.status === 'frozen' && snap1.version_no === 1 && snap1.operations.length === 5 && near(snap1.operations.reduce((s, o) => s + o.minutes_with_allowance, 0), 100.625))
const O2 = await as(admin, () => rpc('production_order_create', article2, 10, 30, wc, '2027-03-01', '2027-03-10'))
await as(admin, () => rpc('production_order_launch', O2))
ok('OF sur article sans gamme approuvée : statut no_routing, aucune gamme inventée', (await as(admin, () => rpc('production_order_routing_get', O2))).status === 'no_routing')

// 7. Nouvelle version : copie, modification du brouillon, approbation, version historique conservée
const v2 = await as(admin, () => rpc('routing_version_create', article, 'Retrait du pliage'))
const copied = (await q(`select count(*)::int n from routing_operations where version_id=$1`, [v2]))[0].n
ok('v2 copie les 5 opérations de v1 dans son brouillon', copied === 5 && (await q(`select version_no from routing_versions where id=$1`, [v2]))[0].version_no === 2)
const opPackV2 = (await q(`select id from routing_operations where version_id=$1 and kind='pack'`, [v2]))[0].id
await as(admin, () => rpc('routing_operation_remove', opPackV2))
const v2ops = (await q(`select count(*)::int n from routing_operations where version_id=$1`, [v2]))[0].n
ok('brouillon v2 modifié sans toucher v1 (4 opérations en v2, 5 en v1)', v2ops === 4 && (await q(`select count(*)::int n from routing_operations where version_id=$1`, [v1]))[0].n === 5)
await rejects('approbation de v2 par son rédacteur refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('routing_version_approve', v2, 'Auto')), 'SOD_SELF_APPROVAL')
await as(direction, () => rpc('routing_version_approve', v2, 'Pliage retiré'))
const st = await q(`select id, status from routing_versions where article_id=$1 order by version_no`, [article])
ok('v1 remplacée (historique conservée), v2 seule approuvée', st[0].status === 'superseded' && st[1].status === 'approved')
ok('une seule gamme approuvée par article', (await q(`select count(*)::int n from routing_versions where article_id=$1 and status='approved'`, [article]))[0].n === 1)
const sumV1 = await as(admin, () => rpc('routing_version_summary', v1))
ok('v1 inchangée après approbation de v2 (5 opérations, 100,625 min)', sumV1.operations.length === 5 && near(sumV1.minutes_per_piece, 100.625))

// 8. OF : figés sur la version de leur lancement
const snap1b = await as(admin, () => rpc('production_order_routing_get', O1))
ok('OF lancé avant v2 garde la gamme v1 après approbation de v2', snap1b.version_no === 1 && snap1b.operations.length === 5)
const O3 = await as(admin, () => rpc('production_order_create', article, 10, 30, wc, '2027-04-01', '2027-04-10'))
await as(admin, () => rpc('production_order_launch', O3))
const snap3 = await as(admin, () => rpc('production_order_routing_get', O3))
ok('OF lancé après approbation de v2 : gamme v2 figée (4 opérations, 100,625 − 1,5 = 99,125 min)', snap3.version_no === 2 && snap3.operations.length === 4 && near(snap3.operations.reduce((s, o) => s + o.minutes_with_allowance, 0), 99.125))
await rejects('figure de gamme non modifiable même en accès direct (ROUTING_SNAPSHOT_IMMUTABLE)', () => db.query(`update production_order_routing set version_no=9 where order_id=$1`, [O1]), 'ROUTING_SNAPSHOT_IMMUTABLE')
await rejects('figure de gamme non supprimable (ROUTING_SNAPSHOT_IMMUTABLE)', () => db.query(`delete from production_order_routing where order_id=$1`, [O1]), 'ROUTING_SNAPSHOT_IMMUTABLE')

// 9. Droits d’accès direct et audit
await rejects('écriture directe du catalogue de compétences refusée (permission denied)', () => as(admin, () => db.query(`insert into production_skills(company_id, code, name) values ($1,'DIRECT','Direct')`, [company])), 'permission denied')
await rejects('gamme lue par un utilisateur sans droit refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('routing_version_summary', v1)), 'RBAC_FORBIDDEN')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : création de gamme (2), approbation (2), opérations ajoutées (5), retrait (1)', (await aud('routing.version_create')) === 2 && (await aud('routing.version_approve')) === 2
  && (await aud('routing.operation_add')) === 5 && (await aud('routing.operation_remove')) === 1)
ok('audit : compétence créée et niveau attribué', (await aud('skill.create')) === 1 && (await aud('skill.grant')) === 2)
