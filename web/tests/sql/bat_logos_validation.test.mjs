// BAT, logos et validation client — P029 / migration 0054
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
const comm = await mkUser('com@x.com', 'commercial')
const comm2 = await mkUser('com2@x.com', 'commercial')
const dir = await mkUser('dir@x.com', 'direction')
const prod = await mkUser('prod@x.com', 'production')
const fin = await mkUser('fin@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }
const sha = (c) => c.repeat(64)

// Clients (le client C reçoit la personnalisation ; X est un autre client)
const C = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('LAFONT BAT','TN','EUR',true) returning id`)))[0].id
const X = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('Autre client BAT','TN','EUR',true) returning id`)))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-BAT','Polo brodé','jacket') returning id`, [C])))[0].id
const contactOk = (await db.query(`insert into client_contacts(company_id, client_id, full_name, email) values ($1,$2,'Marie Durand','marie@lafont.test') returning id`, [company, C])).rows[0].id
const contactNo = (await db.query(`insert into client_contacts(company_id, client_id, full_name) values ($1,$2,'Paul Simon') returning id`, [company, C])).rows[0].id
const contactX = (await db.query(`insert into client_contacts(company_id, client_id, full_name) values ($1,$2,'Autre contact') returning id`, [company, X])).rows[0].id

// Habilitation du contact (clients.write)
await as(comm, () => rpc('client_contact_set_bat_approver', contactOk, true))
ok('contact habilité à approuver un BAT', (await q(`select can_approve_bat from client_contacts where id=$1`, [contactOk]))[0].can_approve_bat === true)
ok('contact non habilité par défaut', (await q(`select can_approve_bat from client_contacts where id=$1`, [contactNo]))[0].can_approve_bat === false)

// Documents GED : dossiers « logos » et « bat » du client
const folder = async (cid, key) => (await q(`select id from ged_folders where client_id=$1 and system_key=$2`, [cid, key]))[0].id
const logoDoc = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'Logo LAFONT','${sha('1')}') returning id`, [company, C, await folder(C, 'logos')]))[0].id
const logoOld = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'Logo ancien','${sha('2')}') returning id`, [company, C, await folder(C, 'logos')]))[0].id
const batDoc = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'BAT v1 PDF','${sha('a')}') returning id`, [company, C, await folder(C, 'bat')]))[0].id
const batNoHash = (await q(`insert into ged_documents(company_id, client_id, folder_id, title) values ($1,$2,$3,'BAT sans empreinte') returning id`, [company, C, await folder(C, 'bat')]))[0].id
const wrongDoc = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'Pas un logo','${sha('3')}') returning id`, [company, C, await folder(C, 'bat')]))[0].id
const logoNew = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'Logo nouveau','${sha('5')}') returning id`, [company, C, await folder(C, 'logos')]))[0].id

// Logos : pièce du dossier logos uniquement, droits prouvés et datés
await rejects('logo : document hors dossier logos refusé', () => as(comm, () => rpc('logo_register', C, wrongDoc, 'Logo', 'owned', 'Fichier fourni par le client', null)), 'LOGO_DOCUMENT_INVALID')
await rejects('logo : preuve de droits trop courte refusée', () => as(comm, () => rpc('logo_register', C, logoDoc, 'Logo LAFONT', 'owned', 'ok', null)), 'check')
const LOGO = await as(comm, () => rpc('logo_register', C, logoDoc, 'Logo LAFONT', 'owned', 'Logo fourni par le client, cession écrite du 01/09', null))
const LOGO_OLD = await as(comm, () => rpc('logo_register', C, logoOld, 'Logo ancien', 'licensed', 'Licence annuelle signée', iso(-1)))
await rejects('logo sous licence sans date de fin refusé', () => db.query(`insert into client_logos(company_id, client_id, document_id, name, rights_kind, rights_proof) values ($1,$2,$3,'x','licensed','Licence test sans date')`, [company, C, batNoHash]), 'check')
ok('logo enregistré avec droits prouvés', (await count(`select count(*)::int n from client_logos where id=$1 and rights_proof like 'Logo fourni%'`, [LOGO])) === 1)

// Commande de personnalisation (confirmée) : lignes brodées
const mkOrder = async () => {
  const id = (await as(comm, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C])))[0].id
  const line = (await db.query(`insert into sales_order_lines(company_id, order_id, article_id, qty, unit_price, due_date) values ($1,$2,$3,50,12,$4) returning id`, [company, id, art, iso(20)])).rows[0].id
  return { id, line }
}
const O1 = await mkOrder()
await as(admin, () => rpc('sales_order_confirm', O1.id))

// ---------------------------------------------------------------------------------------------------------------------
// 1. Spécification : technique, placement, dimensions, couleurs ; logo du client avec droits valides
// ---------------------------------------------------------------------------------------------------------------------
await rejects('technique inconnue refusée', () => as(comm, () => rpc('personalization_spec_set', O1.line, LOGO, 'laser', 'poitrine', 80, 60, ['#000000'], null)), 'PERSO_TECHNIQUE_INVALID')
await rejects('dimension nulle refusée', () => as(comm, () => rpc('personalization_spec_set', O1.line, LOGO, 'embroidery', 'poitrine', 0, 60, ['#000000'], null)), 'PERSO_DIMENSION_INVALID')
await rejects('couleurs vides refusées', () => as(comm, () => rpc('personalization_spec_set', O1.line, LOGO, 'embroidery', 'poitrine', 80, 60, [], null)), 'PERSO_COLORS_INVALID')
await rejects('logo d’un autre client refusé', async () => {
  const xl = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'Logo X','${sha('4')}') returning id`, [company, X, await folder(X, 'logos')]))[0].id
  const LX = await as(comm, () => rpc('logo_register', X, xl, 'Logo X', 'owned', 'Fourni par le client X', null))
  return as(comm, () => rpc('personalization_spec_set', O1.line, LX, 'embroidery', 'poitrine', 80, 60, ['#000000'], null))
}, 'LOGO_NOT_FOUND')
await rejects('logo dont les droits sont échus refusé', () => as(comm, () => rpc('personalization_spec_set', O1.line, LOGO_OLD, 'embroidery', 'poitrine', 80, 60, ['#000000'], null)), 'LOGO_RIGHTS_INVALID')
const v1 = await as(comm, () => rpc('personalization_spec_set', O1.line, LOGO, 'embroidery', 'poitrine gauche', 80, 60, ['#FFCC00', '#000000'], 'Brodé fil 2 couleurs'))
ok('spécification version 1 courante', v1 === 1 && (await count(`select count(*)::int n from personalization_specs where order_line_id=$1 and status='current'`, [O1.line])) === 1)

// ---------------------------------------------------------------------------------------------------------------------
// 2. BAT : émis sur la version courante, PDF de la GED avec empreinte
// ---------------------------------------------------------------------------------------------------------------------
const specO1 = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [O1.line]))[0].id
await rejects('BAT : document hors dossier BAT refusé', () => as(comm, () => rpc('bat_issue', specO1, logoDoc)), 'BAT_DOCUMENT_INVALID')
await rejects('BAT : PDF sans empreinte refusé', () => as(comm, () => rpc('bat_issue', specO1, batNoHash)), 'BAT_DOCUMENT_NO_HASH')
const B1 = await as(comm, () => rpc('bat_issue', specO1, batDoc))
ok('BAT v1 émis avec l’empreinte exacte du PDF', (await q(`select version_no, pdf_sha256, status from bat_proofs where id=$1`, [B1]))[0].pdf_sha256 === sha('a') && (await q(`select status from bat_proofs where id=$1`, [B1]))[0].status === 'issued')

// Aucun accord implicite : sans accord, l'opération est bloquée
await rejects('aucun accord implicite : opération refusée sans BAT approuvé', () => as(prod, () => rpc('personalization_operation_start', specO1)), 'PERSO_NO_VALID_BAT')
await rejects('opération refusée au commercial (personalization.operate réservé à la production)', () => as(comm, () => rpc('personalization_operation_start', specO1)), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------------------------------------------------
// 3. Accord : contact habilité, version exacte, preuve, date ; auteur du BAT exclu
// ---------------------------------------------------------------------------------------------------------------------
await rejects('accord : contact non habilité refusé', () => as(comm2, () => rpc('bat_record_acceptance', B1, contactNo, 'email', 'Accord reçu par e-mail le jour même', iso(0), sha('a'))), 'BAT_CONTACT_NOT_HABILITATED')
await rejects('accord : contact d’un autre client refusé', () => as(comm2, () => rpc('bat_record_acceptance', B1, contactX, 'email', 'Accord reçu par e-mail le jour même', iso(0), sha('a'))), 'BAT_CONTACT_NOT_HABILITATED')
await rejects('mauvaise version : empreinte du PDF différente refusée', () => as(comm2, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'Accord reçu par e-mail le jour même', iso(0), sha('b'))), 'BAT_VERSION_MISMATCH')
await rejects('accord par l’auteur du BAT refusé (séparation des tâches)', () => as(comm, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'Accord reçu par e-mail le jour même', iso(0), sha('a'))), 'SOD_SELF_APPROVAL')
await rejects('preuve d’accord trop courte refusée', () => as(comm2, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'ok', iso(0), sha('a'))), 'BAT_PROOF_REQUIRED')
await rejects('date d’accord future refusée', () => as(comm2, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'Accord reçu par e-mail le jour même', iso(3), sha('a'))), 'BAT_DATE_INVALID')
await as(comm2, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'Mail de Marie Durand du jour, « BAT v1 approuvé »', iso(0), sha('a')))
const acc = (await q(`select status, contact_name, contact_id, acceptance_channel, acceptance_proof, accepted_on, decided_by, issued_by from bat_proofs where id=$1`, [B1]))[0]
ok('accord enregistré : contact, canal, preuve exacte, date, auteur de la décision', acc.status === 'approved' && acc.contact_name === 'Marie Durand' && acc.acceptance_channel === 'email' && acc.acceptance_proof === 'Mail de Marie Durand du jour, « BAT v1 approuvé »' && acc.accepted_on !== null && acc.decided_by !== acc.issued_by, JSON.stringify(acc))
ok('preuve de l’accord conservée dans l’audit', (await count(`select count(*)::int n from audit_logs where action='bat.approve' and entity_id=$1 and metadata->>'proof' = 'Mail de Marie Durand du jour, « BAT v1 approuvé »' and metadata->>'contact_name' = 'Marie Durand'`, [O1.id])) === 1)
await rejects('accord déjà enregistré : second accord refusé', () => as(comm2, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'Second accord sur le même BAT', iso(0), sha('a'))), 'BAT_BAD_STATUS')

// Opération : autorisée avec BAT approuvé de la version courante
const opO1 = await as(prod, () => rpc('personalization_operation_start', specO1))
ok('opération de personnalisation démarrée avec BAT approuvé', opO1 !== undefined && (await count(`select count(*)::int n from personalization_operations where id=$1 and bat_sha256=$2`, [opO1, sha('a')])) === 1)
await rejects('opération déjà démarrée : modification du visuel refusée', () => as(comm, () => rpc('personalization_spec_set', O1.line, LOGO, 'embroidery', 'manche', 40, 40, ['#000000'], null)), 'PERSO_OPERATION_STARTED')

// ---------------------------------------------------------------------------------------------------------------------
// 4. Changement de visuel : invalide l'accord ; ancien BAT refusé ; rejet tracé
// ---------------------------------------------------------------------------------------------------------------------
const O2 = await mkOrder()
await as(admin, () => rpc('sales_order_confirm', O2.id))
await as(comm, () => rpc('personalization_spec_set', O2.line, LOGO, 'screen_print', 'dos', 200, 250, ['#FFFFFF'], null))
const spec2a = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [O2.line]))[0].id
const B2 = await as(comm, () => rpc('bat_issue', spec2a, batDoc))
await as(comm2, () => rpc('bat_record_acceptance', B2, contactOk, 'signed_form', 'Formulaire signé par Marie Durand le jour', iso(0), sha('a')))
ok('BAT approuvé pour la version 1 de O2', (await q(`select status from bat_proofs where id=$1`, [B2]))[0].status === 'approved')
await as(comm, () => rpc('personalization_spec_set', O2.line, LOGO, 'screen_print', 'dos haut', 200, 250, ['#FFFFFF'], 'Placement modifié'))
ok('changement de placement : l’accord est invalidé (BAT superseded)', (await q(`select status from bat_proofs where id=$1`, [B2]))[0].status === 'superseded')
await rejects('accord sur l’ancienne version refusé (mauvaise version)', () => as(comm2, () => rpc('bat_record_acceptance', B2, contactOk, 'signed_form', 'Formulaire signé par Marie Durand le jour', iso(0), sha('a'))), 'BAT_SUPERSEDED')
const spec2cur = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [O2.line]))[0].id
await rejects('opération refusée : pas de BAT approuvé pour la version courante', () => as(prod, () => rpc('personalization_operation_start', spec2cur)), 'PERSO_NO_VALID_BAT')
const spec2b = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [O2.line]))[0].id
const B2b = await as(comm, () => rpc('bat_issue', spec2b, batDoc))
await as(comm2, () => rpc('bat_record_acceptance', B2b, contactOk, 'email', 'Mail de Marie Durand, version 2 approuvée', iso(0), sha('a')))
const opO2 = await as(prod, () => rpc('personalization_operation_start', spec2b))
ok('nouvelle version approuvée : opération possible sur la version courante uniquement', opO2 !== undefined)

// Retrait des droits du logo : les BAT en cours ne sont plus valides
const O3 = await mkOrder()
await as(admin, () => rpc('sales_order_confirm', O3.id))
await as(comm, () => rpc('personalization_spec_set', O3.line, LOGO, 'flock', 'poitrine', 60, 60, ['#000000'], null))
const spec3 = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [O3.line]))[0].id
const B3 = await as(comm, () => rpc('bat_issue', spec3, batDoc))
await as(comm, () => rpc('logo_withdraw', LOGO, 'Cession de droits résiliée par le client'))
ok('retrait des droits : BAT en cours invalidé', (await q(`select status from bat_proofs where id=$1`, [B3]))[0].status === 'superseded')
await rejects('après retrait : nouvel accord impossible', () => as(comm2, () => rpc('bat_record_acceptance', B3, contactOk, 'email', 'Accord tardif après retrait', iso(0), sha('a'))), 'BAT_SUPERSEDED')

// Rejet par un contact habilité : tracé, pas d'accord
const O4 = await mkOrder()
await as(admin, () => rpc('sales_order_confirm', O4.id))
const LOGO2 = await as(comm, () => rpc('logo_register', C, logoNew, 'Logo nouveau', 'owned', 'Fichier fourni, droits cédés par écrit', null))
await as(comm, () => rpc('personalization_spec_set', O4.line, LOGO2, 'embroidery', 'col', 30, 30, ['#112233'], null))
const spec4 = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [O4.line]))[0].id
const B4 = await as(comm, () => rpc('bat_issue', spec4, batDoc))
await rejects('rejet sans motif refusé', () => as(comm2, () => rpc('bat_record_rejection', B4, contactOk, 'non')), 'BAT_NOTE_REQUIRED')
await rejects('rejet par un contact non habilité refusé', () => as(comm2, () => rpc('bat_record_rejection', B4, contactNo, 'Couleurs à revoir')), 'BAT_CONTACT_NOT_HABILITATED')
await as(comm2, () => rpc('bat_record_rejection', B4, contactOk, 'Couleurs à revoir, le bleu est trop foncé'))
ok('rejet tracé : statut rejeté, aucun accord', (await q(`select status, acceptance_proof from bat_proofs where id=$1`, [B4]))[0].status === 'rejected')
await rejects('opération refusée après rejet', () => as(prod, () => rpc('personalization_operation_start', spec4)), 'PERSO_NO_VALID_BAT')

// Commande non confirmée : aucune opération
const D1 = (await as(comm, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C])))[0].id
const DL = (await db.query(`insert into sales_order_lines(company_id, order_id, article_id, qty, unit_price, due_date) values ($1,$2,$3,5,12,$4) returning id`, [company, D1, art, iso(10)])).rows[0].id
await rejects('logo retiré : spécification refusée (droits retirés)', () => as(comm, () => rpc('personalization_spec_set', DL, LOGO, 'embroidery', 'poitrine', 10, 10, ['#000000'], null)), 'LOGO_RIGHTS_INVALID')
const specD = await as(comm, () => rpc('personalization_spec_set', DL, LOGO2, 'embroidery', 'poitrine', 10, 10, ['#000000'], null))
ok('spécification possible sur commande en brouillon (pas d’opération)', specD === 1)

// ---------------------------------------------------------------------------------------------------------------------
// 5. Visibilité, audit
// ---------------------------------------------------------------------------------------------------------------------
ok('BAT et logos invisibles sans droit (RLS)', (await as(nobody, () => q(`select count(*)::int n from bat_proofs`)))[0].n === 0 && (await as(nobody, () => q(`select count(*)::int n from client_logos`)))[0].n === 0)
ok('lecture des BAT ouverte à la direction (personalization.read)', (await as(dir, () => q(`select count(*)::int n from bat_proofs`)))[0].n >= 3)
await rejects('BAT : écriture directe refusée', () => as(comm, () => db.query(`update bat_proofs set status='approved' where id=$1`, [B2])), 'permission denied')
await rejects('BAT approuvé : modification du PDF refusée (ajout seul)', () => db.query(`update bat_proofs set pdf_sha256=$2 where id=$1`, [B1, sha('c')]), 'APPEND_ONLY')
ok('audit : émission, accord, rejet et opération tracés', (await count(`select count(*)::int n from audit_logs where action in ('bat.issue','bat.approve','bat.reject','perso.operation_start')`)) >= 6)

console.log('BAT, logos et validation : fin des contrôles')
