// Contrats datés, objectifs comparables au CA, visites (agenda, GPS encadré, compte rendu relu) — P025 / migration 0050
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('com@x.com', 'commercial')
const comm2 = await mkUser('com2@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const fin2 = await mkUser('fin2@x.com', 'finance')
const prod = await mkUser('prod@x.com', 'production')
const nobody = await mkUser('nobody@x.com', null)

// Fixtures : devise de base, TVA et taux de change signés (règles P017 / P022), deux clients, factures réelles
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
await as(fin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))
const clA = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client A P025','TN','EUR') returning id`)))[0].id
const clB = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client B P025','TN','EUR') returning id`)))[0].id
const fxId = await as(fin, () => rpc('exchange_rate_set', '2026-01-15', 'TND', 0.3, 'Taux de référence saisi (test P025)'))
await as(fin2, () => rpc('exchange_rate_validate', fxId, true))

const issued = async (client, currency, price) => {
  const id = (await db.query(`insert into invoices(company_id, client_id, currency) values ($1,$2,$3) returning id`, [company, client, currency])).rows[0].id
  await db.query(`insert into invoice_lines(company_id, invoice_id, pos, description, qty, unit_price) values ($1,$2,1,'Ligne test P025',1,$3)`, [company, id, price])
  await as(admin, () => rpc('invoice_issue', id))
  return id
}
const invA1 = await issued(clA, 'EUR', 1000)            // client A : 1 000 EUR
const invA2 = await issued(clA, 'TND', 500)             // client A : 500 TND × 0,3 = 150 EUR
const cnA2 = await as(admin, () => rpc('credit_note_create', invA2, 'Retour complet test P025'))
await as(admin, () => rpc('credit_note_issue', cnA2, false))   // avoir : − 150 EUR
const invB1 = await issued(clB, 'EUR', 2000)            // client B : 2 000 EUR

// Dossiers GED « contrats » des deux clients (créés par la GED) et pièces signées
const folderOf = async (cid) => (await q(`select id from ged_folders where client_id=$1 and system_key='contracts'`, [cid]))[0].id
const docA1 = (await q(`insert into ged_documents(company_id, client_id, folder_id, title) values ($1,$2,$3,'Contrat A signé') returning id`, [company, clA, await folderOf(clA)]))[0].id
const docA2 = (await q(`insert into ged_documents(company_id, client_id, folder_id, title) values ($1,$2,$3,'Avenant A signé') returning id`, [company, clA, await folderOf(clA)]))[0].id
const docB1 = (await q(`insert into ged_documents(company_id, client_id, folder_id, title) values ($1,$2,$3,'Contrat B signé') returning id`, [company, clB, await folderOf(clB)]))[0].id
const photoA = (await q(`insert into ged_documents(company_id, client_id, folder_id, title) values ($1,$2,$3,'Photo stand A') returning id`, [company, clA, await folderOf(clA)]))[0].id

// ---------------------------------------------------------------------------------------------------------------------
// 1. Droits : refus par défaut, séparation lecture / écriture
// ---------------------------------------------------------------------------------------------------------------------
await rejects('création de contrat refusée au rôle sans droit (production)', () => as(prod, () => rpc('contract_create', clA, 'framework', '2026-01-01', '2026-12-31', false, 30, 'EUR', '30 jours', null, null)), 'RBAC_FORBIDDEN')
await rejects('objectif refusé au commercial (objectives.write réservé à la direction)', () => as(comm, () => rpc('objective_create', 'company', null, 'Objectif refusé', '2026-01-01', '2026-12-31', 5000)), 'RBAC_FORBIDDEN')
await rejects('visite : la direction ne planifie pas (visits.write réservé au terrain)', () => as(dir, () => rpc('visit_plan_create', clA, null, new Date().toISOString(), 30, 'Test droits')), 'RBAC_FORBIDDEN')
ok('lecture des contrats refusée sans droit (RLS) : zéro ligne', (await as(nobody, () => q(`select count(*)::int n from client_contracts`)))[0].n === 0)
await rejects('écriture directe de contrat refusée (aucune écriture hors fonctions)', () => as(comm, () => db.query(`update client_contracts set discount_pct = 9`)), 'permission denied')

// ---------------------------------------------------------------------------------------------------------------------
// 2. Contrats : conditions valides à date, signature, renouvellement, résiliation
// ---------------------------------------------------------------------------------------------------------------------
const C1 = await as(admin, () => rpc('contract_create', clA, 'framework', '2026-01-01', '2026-12-31', false, 60, 'EUR', '30 jours', 5, 'Remise cadre 5 %'))
const C0 = await as(admin, () => rpc('contract_create', clA, 'service', '2026-07-01', '2026-08-31', false, 30, null, null, null, null))
await rejects('contrat sans devise ni conditions : signature refusée', () => as(admin, () => rpc('contract_sign', C0, docA1, 'Jean Dupont')), 'CONTRACT_CONDITIONS_REQUIRED')
await rejects('création : fin antérieure au début refusée', () => as(admin, () => rpc('contract_create', clA, 'other', '2026-05-01', '2026-04-01', false, 30, null, null, null, null)), 'CONTRACT_BAD_DATES')
await rejects('signature : pièce d’un autre client refusée', () => as(admin, () => rpc('contract_sign', C1, docB1, 'Jean Dupont')), 'CONTRACT_DOCUMENT_INVALID')
await rejects('signature : nom du signataire obligatoire', () => as(admin, () => rpc('contract_sign', C1, docA1, ' ')), 'CONTRACT_SIGNATURE_REQUIRED')
await as(admin, () => rpc('contract_sign', C1, docA1, 'Jean Dupont'))
ok('contrat signé : statut et pièce signée enregistrés', (await q(`select status, signed_document_id = $2 as doc_ok from client_contracts where id=$1`, [C1, docA1]))[0].status === 'signed')
await rejects('contrat signé : nouvelle signature refusée', () => as(admin, () => rpc('contract_sign', C1, docA1, 'Jean Dupont')), 'CONTRACT_BAD_STATUS')
await rejects('contrat signé : modification directe des conditions refusée (verrou)', () => db.query(`update client_contracts set discount_pct = 9 where id=$1`, [C1]), 'CONTRACT_LOCKED')
await rejects('contrat signé : suppression refusée (verrou)', () => db.query(`delete from client_contracts where id=$1`, [C1]), 'CONTRACT_LOCKED')

const cond = (on) => as(comm, () => rpc('contract_conditions_at', clA, on))
ok('conditions valides à date : 15 juin 2026 → contrat C1 (30 jours, remise 5 %)', (await cond('2026-06-15')).code !== undefined && (await cond('2026-06-15')).payment_terms === '30 jours' && Number((await cond('2026-06-15')).discount_pct) === 5)
ok('conditions : avant le début du contrat → aucune condition (null, pas de supposition)', (await cond('2025-12-31')) === null)
ok('conditions : après la fin du contrat → aucune condition', (await cond('2027-01-01')) === null)
ok('conditions : un autre client n’hérite pas des conditions', (await as(comm, () => rpc('contract_conditions_at', clB, '2026-06-15'))) === null)

await rejects('chevauchement : second contrat signé sur la même période refusé', async () => {
  const C2 = await as(admin, () => rpc('contract_create', clA, 'price_agreement', '2026-06-01', '2027-05-31', false, 30, 'EUR', '45 jours', null, 'Grille prix'))
  return as(admin, () => rpc('contract_sign', C2, docA2, 'Jean Dupont'))
}, 'CONTRACT_OVERLAP')

// Renouvellement : après la fin de C1, nouveau contrat signé, C1 passe en « renouvelé » (encore valide jusqu’à sa fin)
await rejects('renouvellement : date de début avant la fin du contrat remplacé refusée', () => as(admin, () => rpc('contract_renew', C1, '2026-12-01', '2027-11-30', 'EUR', '45 jours', null, null)), 'CONTRACT_RENEWAL_DATES')
const R1 = await as(admin, () => rpc('contract_renew', C1, '2027-01-01', '2027-12-31', 'EUR', '45 jours', 3, null))
await rejects('renouvellement : un seul renouvellement par contrat', () => as(admin, () => rpc('contract_renew', C1, '2028-01-01', '2028-12-31', 'EUR', '60 jours', null, null)), 'CONTRACT_ALREADY_RENEWED')
await rejects('renouvellement non signé : signature refusée sans pièce', () => as(admin, () => rpc('contract_sign', R1, docB1, 'Jean Dupont')), 'CONTRACT_DOCUMENT_INVALID')
await as(admin, () => rpc('contract_sign', R1, docA2, 'Jean Dupont'))
ok('C1 passe en « renouvelé » après signature du renouvellement', (await q(`select status from client_contracts where id=$1`, [C1]))[0].status === 'renewed')
ok('à 15 juin 2026 : C1 reste la référence (30 jours)', (await cond('2026-06-15')).payment_terms === '30 jours')
ok('à 15 juin 2027 : renouvellement R1 (45 jours, remise 3 %)', (await cond('2027-06-15')).payment_terms === '45 jours' && Number((await cond('2027-06-15')).discount_pct) === 3)

await rejects('renouvellement d’un contrat déjà renouvelé refusé', () => as(admin, () => rpc('contract_renew', C1, '2028-01-01', '2028-12-31', 'EUR', '45 jours', null, null)), 'CONTRACT_BAD_STATUS')
await rejects('résiliation : motif obligatoire', () => as(admin, () => rpc('contract_terminate', R1, '2027-06-30', ' ')), 'CONTRACT_REASON_REQUIRED')
await rejects('résiliation : date hors du contrat refusée', () => as(admin, () => rpc('contract_terminate', R1, '2028-01-15', 'Fin test')), 'CONTRACT_BAD_DATES')
await as(admin, () => rpc('contract_terminate', R1, '2027-06-30', 'Fin de partenariat (test P025)'))
ok('résiliation : la veille de la date de résiliation est la dernière journée couverte', (await cond('2027-06-29')).payment_terms === '45 jours')
ok('résiliation : après la date de résiliation, aucune condition', (await cond('2027-06-30')) === null)
ok('audit : signature et résiliation tracées', (await count(`select count(*)::int n from audit_logs where action in ('contract.sign','contract.terminate','contract.renew')`)) >= 4)

// ---------------------------------------------------------------------------------------------------------------------
// 3. Objectifs : même périmètre, même période, même règle que le CA (pipeline P022)
// ---------------------------------------------------------------------------------------------------------------------
const OC = await as(admin, () => rpc('objective_create', 'company', null, 'Objectif société 2026', '2026-01-01', '2026-12-31', 5000))
const OA = await as(admin, () => rpc('objective_create', 'client', clA, 'Objectif client A 2026', '2026-01-01', '2026-12-31', 2000))
const OB = await as(admin, () => rpc('objective_create', 'client', clB, 'Objectif client B 2026', '2026-01-01', '2026-12-31', 4000))
await rejects('objectif en double (même périmètre et même période) refusé', () => as(admin, () => rpc('objective_create', 'company', null, 'Doublon', '2026-01-01', '2026-12-31', 6000)), 'sales_objectives_uq')
await rejects('objectif client sans client refusé', () => as(admin, () => rpc('objective_create', 'client', null, 'Sans client', '2026-01-01', '2026-12-31', 100)), 'OBJECTIVE_BAD_SCOPE')
await rejects('objectif société avec un client refusé', () => as(admin, () => rpc('objective_create', 'company', clA, 'Avec client', '2025-01-01', '2025-12-31', 100)), 'OBJECTIVE_BAD_SCOPE')
await rejects('objectif à montant nul refusé', () => as(admin, () => rpc('objective_create', 'company', null, 'Zéro', '2025-01-01', '2025-12-31', 0)), 'OBJECTIVE_TARGET_INVALID')

const pOC = await as(admin, () => rpc('objective_progress', OC))
const pOA = await as(admin, () => rpc('objective_progress', OA))
const pOB = await as(admin, () => rpc('objective_progress', OB))
ok('CA société 2026 = 1 000 + 150 − 150 + 2 000 = 3 000 EUR', Number(pOC.realised_net_ht) === 3000, JSON.stringify(pOC))
ok('CA client A 2026 = 1 000 EUR (avoir déduit de sa facture TND)', Number(pOA.realised_net_ht) === 1000, JSON.stringify(pOA))
ok('CA client B 2026 = 2 000 EUR', Number(pOB.realised_net_ht) === 2000, JSON.stringify(pOB))
ok('périmètre comparable : CA société = CA client A + CA client B (même règle, même période)', Number(pOC.realised_net_ht) === Number(pOA.realised_net_ht) + Number(pOB.realised_net_ht))
ok('taux d’atteinte : société 60 %, client A 50 % (calcul à la main : 3 000 / 5 000 ; 1 000 / 2 000)', Number(pOC.percent) === 60 && Number(pOA.percent) === 50)
ok('objectif et CA dans la même devise de base (EUR)', pOC.currency === 'EUR' && pOA.currency === 'EUR')
const O2025 = await as(admin, () => rpc('objective_create', 'company', null, 'Objectif 2025', '2025-01-01', '2025-12-31', 1000))
ok('objectif 2025 sans facture : CA nul et 0 facture comptée (période distincte)', (await as(admin, () => rpc('objective_progress', O2025))).invoices_counted === 0)
// Accès : objectifs visibles sans CA si le droit facture manque (CA absent, pas nul)
await db.query(`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r join permissions p on p.code='objectives.read' where r.code='production' and r.company_id=$1 on conflict do nothing`, [company])
const pProd = await as(prod, () => rpc('objective_progress', OC))
ok('sans droit factures : objectif visible, CA absent (null, jamais zéro)', pProd.realised_net_ht === null && pProd.target !== undefined && pProd.percent === null, JSON.stringify(pProd))
await rejects('objectif inconnu : refus', () => as(admin, () => rpc('objective_progress', '00000000-0000-0000-0000-000000000001')), 'OBJECTIVE_NOT_FOUND')

// ---------------------------------------------------------------------------------------------------------------------
// 4. Visites : agenda, pointage GPS honnête, photos, compte rendu avec dictée relue
// ---------------------------------------------------------------------------------------------------------------------
const now = new Date().toISOString()
const V1 = await as(comm, () => rpc('visit_plan_create', clA, null, now, 60, 'Présentation collection'))
const V2 = await as(comm, () => rpc('visit_plan_create', clA, null, now, 30, 'Visite sans position'))
const V3 = await as(comm, () => rpc('visit_plan_create', clA, null, now, 30, 'Visite annulée'))
const Vold = await as(comm, () => rpc('visit_plan_create', clA, null, '2026-01-10T09:00:00Z', 30, 'Visite ancienne'))
await rejects('visite : client d’une autre fiche / inconnu refusé', () => as(comm, () => rpc('visit_plan_create', '00000000-0000-0000-0000-000000000002', null, now, 30, 'Client inconnu')), 'CLIENT_NOT_FOUND')
ok('agenda : la direction lit les visites (visits.read)', (await as(dir, () => q(`select count(*)::int n from visit_plans`)))[0].n >= 4)

await rejects('pointage hors fenêtre (± 24 h) refusé', () => as(comm, () => rpc('visit_checkin', Vold, 'captured', 36.8, 10.18, 25, null)), 'VISIT_OUT_OF_WINDOW')
await rejects('GPS « capturé » sans précision refusé', () => as(comm, () => rpc('visit_checkin', V1, 'captured', 36.8, 10.18, null, null)), 'VISIT_GPS_INVALID')
await rejects('GPS imprécis (> 500 m) : position non enregistrée comme preuve', () => as(comm, () => rpc('visit_checkin', V1, 'captured', 36.8, 10.18, 900, null)), 'VISIT_GPS_IMPRECISE')
await rejects('GPS « indisponible » avec coordonnées refusé (pas de fausse preuve)', () => as(comm, () => rpc('visit_checkin', V2, 'unavailable', 36.8, 10.18, null, 'Pas de signal')), 'VISIT_GPS_INVALID')
await rejects('GPS « indisponible » sans motif refusé', () => as(comm, () => rpc('visit_checkin', V2, 'unavailable', null, null, null, null)), 'VISIT_REASON_REQUIRED')
await rejects('pointage par un autre commercial refusé (responsable de la visite)', () => as(comm2, () => rpc('visit_checkin', V1, 'captured', 36.8, 10.18, 25, null)), 'VISIT_NOT_OWNER')

await as(comm, () => rpc('visit_checkin', V1, 'captured', 36.8, 10.18, 25, null))
await rejects('second pointage de la même visite refusé', () => as(comm, () => rpc('visit_checkin', V1, 'captured', 36.8, 10.18, 25, null)), 'VISIT_ALREADY_CHECKED_IN')
await as(comm, () => rpc('visit_checkin', V2, 'unavailable', null, null, null, 'Pas de signal dans le bâtiment'))
const ck1 = (await q(`select gps_status, latitude, longitude, accuracy_m from visit_checkins where plan_id=$1`, [V1]))[0]
const ck2 = (await q(`select gps_status, latitude, longitude, accuracy_m, reason from visit_checkins where plan_id=$1`, [V2]))[0]
ok('pointage capturé : position et précision conservées', ck1.gps_status === 'captured' && Number(ck1.latitude) === 36.8 && Number(ck1.accuracy_m) === 25)
ok('pointage indisponible : aucune coordonnée inventée, motif conservé', ck2.gps_status === 'unavailable' && ck2.latitude === null && ck2.longitude === null && ck2.reason !== null)

await rejects('photo d’un autre client refusée', () => as(comm, () => rpc('visit_photo_add', V1, docB1, 'Photo B')), 'VISIT_PHOTO_INVALID')
await as(comm, () => rpc('visit_photo_add', V1, photoA, 'Vitrine client A'))
ok('photo rattachée à la visite (pièce GED du même client)', (await count(`select count(*)::int n from visit_photos where plan_id=$1`, [V1])) === 1)

await rejects('dictée non relue refusée', () => as(comm, () => rpc('visit_report_finalize', V1, 'Compte rendu test', 'texte dicté brut', false)), 'VISIT_DICTATION_NOT_REVIEWED')
await rejects('compte rendu trop court refusé', () => as(comm, () => rpc('visit_report_finalize', V1, 'ok', null, false)), 'check')
await as(comm, () => rpc('visit_report_finalize', V1, 'Client intéressé par la collection automne ; relance le 15.', 'client interesse collection automne relance quinze', true))
ok('compte rendu relu enregistré : visite passée à « réalisée »', (await q(`select status from visit_plans where id=$1`, [V1]))[0].status === 'done')
await rejects('second compte rendu de la même visite refusé', () => as(comm, () => rpc('visit_report_finalize', V1, 'Doublon compte rendu', null, false)), 'VISIT_BAD_STATUS')
await rejects('visite réalisée : plus de pointage', () => as(comm, () => rpc('visit_checkin', V1, 'unavailable', null, null, null, 'Tard')), 'VISIT_BAD_STATUS')

await as(comm, () => rpc('visit_plan_cancel', V3, 'Client absent'))
ok('visite annulée avec motif : statut « annulée »', (await q(`select status from visit_plans where id=$1`, [V3]))[0].status === 'cancelled')
await rejects('annulation sans motif refusée', () => as(comm, () => rpc('visit_plan_cancel', V2, '  ')), 'VISIT_REASON_REQUIRED')
await rejects('visite d’un autre commercial : annulation refusée', () => as(comm2, () => rpc('visit_plan_cancel', V2, 'Pas la mienne')), 'VISIT_NOT_OWNER')
await rejects('visite : modification directe refusée (verrou)', () => db.query(`update visit_plans set purpose='Modifié' where id=$1`, [V2]), 'VISIT_LOCKED')
ok('audit : pointage, compte rendu et annulation tracés', (await count(`select count(*)::int n from audit_logs where action in ('visit.checkin','visit.report','visit.cancel')`)) >= 4)

