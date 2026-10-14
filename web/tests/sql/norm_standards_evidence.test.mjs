// Normes EPI et preuves documentaires : registre (édition, amendement, marché), applicabilité confirmée par la qualité,
// essais et certificats rattachés au produit, à la version et à l'édition, échéances — P054 / migration 0078
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => Number((await q(sql, params))[0].n)
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const qual = await mkUser('qual@x.com', 'qualite')      // certifications.read / write, quality.approve
const comm = await mkUser('com@x.com', 'commercial')    // certifications.read seulement
const nobody = await mkUser('nobody@x.com', null)

// --- Clients, produits, versions, documents GED (client 1 et client 2) -------------------------------------------------------------
const C1 = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('Client EPI P54','TN','EUR',true) returning id`)))[0].id
const C2 = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('Autre client EPI P54','TN','EUR',true) returning id`)))[0].id
const P = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Gilet EPI P54','vest') returning id`, [C1])))[0].id
const Q = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste autre P54','jacket') returning id`, [C2])))[0].id
const v1P = (await q(`select id from product_versions where product_id=$1 order by version_no limit 1`, [P]))[0].id
const v1Q = (await q(`select id from product_versions where product_id=$1 order by version_no limit 1`, [Q]))[0].id
// Fixture (test seulement) : version 1 de P passée à « validated » hors flux de revue, puis version 2 en brouillon.
// Le module produit refuse une nouvelle version tant qu'un brouillon existe, et force le statut « draft » à l'insertion.
await db.query(`select set_config('product.rpc', 'on', false)`)
await db.query(`update product_versions set status='validated', validated_by=$2, validated_at=now(), snapshot='{}'::jsonb where id=$1`, [v1P, admin])
await db.query(`select set_config('product.rpc', 'off', false)`)
const v2P = (await q(`insert into product_versions(company_id, client_id, product_id, version_no) values ($1,$2,$3,2) returning id`, [company, C1, P]))[0].id
const folder = async (cid) => (await q(`select id from ged_folders where client_id=$1 and system_key='certifications'`, [cid]))[0].id
const doc = async (cid, title, c) => (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,$4,$5) returning id`,
  [company, cid, await folder(cid), title, c.repeat(64)]))[0].id
const DOC1 = await doc(C1, 'Certificat EN 343 P54', 'a')
const DOC2 = await doc(C1, 'Certificat EN ISO 13688 P54', 'b')
const DOC3 = await doc(C1, 'Certificat EN 14058 P54', 'c')
const DOC4 = await doc(C1, 'Certificat EN ISO 20471 P54', 'd')
const DOC5 = await doc(C1, 'Rapport essai P54', 'e')
const DOC_OTHER = await doc(C2, 'Document autre client P54', 'f')

// --- Registre -----------------------------------------------------------------------------------------------------------------------------
const std = async (code) => (await q(`select id from norm_standards where code=$1 and company_id=$2`, [code, company]))[0].id
const S_ISO = await std('ISO 9001')
const S_20471 = await std('EN ISO 20471')
const S_343 = await std('EN 343')
const S_13688 = await std('EN ISO 13688')
const S_14058 = await std('EN 14058')
ok('registre : cinq normes déclarées, ISO 9001 au niveau organisation, quatre normes produit, intitulés non renseignés', (await count(`select count(*)::int n from norm_standards where company_id=$1`, [company])) === 5
  && (await q(`select scope from norm_standards where id=$1`, [S_ISO]))[0].scope === 'organization'
  && (await count(`select count(*)::int n from norm_standards where company_id=$1 and scope='product'`, [company])) === 4
  && (await count(`select count(*)::int n from norm_standards where company_id=$1 and title is not null`, [company])) === 0)
await rejects('édition ajoutée par un utilisateur sans droit d’écriture refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('norm_edition_add', S_343, 'TEST-E1', null, null, null)), 'RBAC_FORBIDDEN')
await rejects('norme inconnue refusée pour une édition (NORM_STANDARD_NOT_FOUND)', () => as(qual, () => rpc('norm_edition_add', '00000000-0000-0000-0000-000000000000', 'TEST-X', null, null, null)), 'NORM_STANDARD_NOT_FOUND')

const E343_1 = await as(qual, () => rpc('norm_edition_add', S_343, 'TEST-E1', null, 'UE test', null))
const E343_2 = await as(qual, () => rpc('norm_edition_add', S_343, 'TEST-E2', 'TEST-AMD1', 'UE test', null))
const E20471_A = await as(qual, () => rpc('norm_edition_add', S_20471, 'TEST-A', null, 'UE test', null))
const E20471_A2 = await as(qual, () => rpc('norm_edition_add', S_20471, 'TEST-A2', null, 'UE test', null))
const E13688_B = await as(qual, () => rpc('norm_edition_add', S_13688, 'TEST-B', null, 'UE test', null))
const E14058_C = await as(qual, () => rpc('norm_edition_add', S_14058, 'TEST-C', null, 'UE test', null))
await rejects('édition en double (même édition, amendement et marché) refusée', () => as(qual, () => rpc('norm_edition_add', S_343, 'TEST-E1', null, 'UE test', null)), 'norm_editions_uq')
ok('édition avec amendement et marché conservés', (await q(`select amendment, market from norm_editions where id=$1`, [E343_2]))[0].amendment === 'TEST-AMD1')

// --- Applicabilité : confirmée par la qualité -------------------------------------------------------------------------------------------
const stOf = async (prod, ver, code) => (await as(qual, () => rpc('norm_product_status', prod, ver, 60))).standards.find((s) => s.standard_code === code)
const all = await as(qual, () => rpc('norm_product_status', P, v1P, 60))
ok('avant confirmation : chaque norme produit est « à confirmer », norme organisation absente de la fiche produit', all.standards.length === 4 && all.standards.every((s) => s.state === 'a_confirmer'))
await rejects('confirmation d’applicabilité par le commercial refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('norm_requirement_confirm', P, S_343, true, E343_1, 'Gilet exposé à la pluie')), 'RBAC_FORBIDDEN')
await rejects('norme organisation (ISO 9001) non applicable à un produit (NORM_SCOPE_MISMATCH)', () => as(qual, () => rpc('norm_requirement_confirm', P, S_ISO, true, null, 'Certification de société')), 'NORM_SCOPE_MISMATCH')
await rejects('confirmation sans motif refusée (NORM_RATIONALE_REQUIRED)', () => as(qual, () => rpc('norm_requirement_confirm', P, S_343, true, E343_1, 'ok')), 'NORM_RATIONALE_REQUIRED')
await rejects('édition d’une autre norme refusée (NORM_EDITION_MISMATCH)', () => as(qual, () => rpc('norm_requirement_confirm', P, S_20471, true, E343_1, 'Haute visibilité sur gilet')), 'NORM_EDITION_MISMATCH')
await as(qual, () => rpc('norm_requirement_confirm', P, S_20471, true, null, 'Gilet haute visibilité exigé par le client'))
ok('norme applicable sans édition retenue : « édition à confirmer » (aucune édition n’est supposée)', (await stOf(P, v1P, 'EN ISO 20471')).state === 'edition_a_confirmer')
await as(qual, () => rpc('norm_requirement_confirm', P, S_20471, true, E20471_A, 'Gilet haute visibilité exigé par le client'))
ok('édition retenue : la norme devient « manquant » tant qu’aucune preuve n’existe', (await stOf(P, v1P, 'EN ISO 20471')).state === 'manquant')
await as(qual, () => rpc('norm_requirement_confirm', P, S_343, false, null, 'Non concerné : pas de protection contre la pluie'))
ok('norme confirmée non applicable : état explicite, pas « manquant »', (await stOf(P, v1P, 'EN 343')).state === 'non_applicable')
await as(qual, () => rpc('norm_requirement_confirm', P, S_343, true, E343_1, 'Gilet exposé à la pluie sur chantier'))
ok('norme 343 réappliquée avec son édition : « manquant »', (await stOf(P, v1P, 'EN 343')).state === 'manquant')
await as(qual, () => rpc('norm_requirement_confirm', P, S_13688, true, E13688_B, 'Exigences générales du vêtement de protection'))
await as(qual, () => rpc('norm_requirement_confirm', P, S_14058, true, E14058_C, 'Vêtement contre environnement froid'))
ok('audit des confirmations d’applicabilité : six décisions réussies à ce stade', (await count(`select count(*)::int n from audit_logs where action='norm.requirement_confirm'`)) === 6)

// --- Essais : preuve, sans statut produit -----------------------------------------------------------------------------------------------
await rejects('essai sans document refusé (NORM_DOCUMENT_NOT_FOUND)', () => as(qual, () => rpc('norm_test_record', P, v1P, S_343, E343_1, 'Labo test', 'RAP-1', iso(-10), 'pass', null)), 'NORM_DOCUMENT_NOT_FOUND')
await rejects('essai avec document d’un autre client refusé (NORM_DOCUMENT_CLIENT_MISMATCH)', () => as(qual, () => rpc('norm_test_record', P, v1P, S_343, E343_1, 'Labo test', 'RAP-1', iso(-10), 'pass', DOC_OTHER)), 'NORM_DOCUMENT_CLIENT_MISMATCH')
await rejects('essai rattaché à la version d’un autre produit refusé (NORM_VERSION_MISMATCH)', () => as(qual, () => rpc('norm_test_record', P, v1Q, S_343, E343_1, 'Labo test', 'RAP-1', iso(-10), 'pass', DOC5)), 'NORM_VERSION_MISMATCH')
await rejects('essai avec édition d’une autre norme refusé (NORM_EDITION_MISMATCH)', () => as(qual, () => rpc('norm_test_record', P, v1P, S_343, E20471_A, 'Labo test', 'RAP-1', iso(-10), 'pass', DOC5)), 'NORM_EDITION_MISMATCH')
await as(qual, () => rpc('norm_test_record', P, v1P, S_343, E343_1, 'Labo test', 'RAP-1', iso(-10), 'pass', DOC5))
ok('essai conforme enregistré, mais la norme reste « manquant » : un essai ne crée pas de statut produit', (await stOf(P, v1P, 'EN 343')).state === 'manquant'
  && (await stOf(P, v1P, 'EN 343')).last_test.result === 'pass')
await rejects('même rapport deux fois pour la même version refusé', () => as(qual, () => rpc('norm_test_record', P, v1P, S_343, E343_1, 'Labo test', 'RAP-1', iso(-10), 'pass', DOC5)), 'norm_tests_product_version_id_standard_id_report_no_key')

// --- Certificats : produit + version + édition ; organisation seule ----------------------------------------------------------------------
await rejects('certificat produit sans version refusé (NORM_SCOPE_MISMATCH)', () => as(qual, () => rpc('norm_certificate_record', P, null, S_343, E343_1, 'CERT-1', 'Organisme test', iso(-30), iso(400), DOC1)), 'NORM_SCOPE_MISMATCH')
const E_ISO = await as(qual, () => rpc('norm_edition_add', S_ISO, 'TEST-ISO', null, 'UE test', null))
await rejects('certificat d’organisation rattaché à un produit refusé (NORM_SCOPE_MISMATCH)', () => as(qual, () => rpc('norm_certificate_record', P, v1P, S_ISO, E_ISO, 'CERT-ISO', 'Organisme test', iso(-30), iso(400), DOC1)), 'NORM_SCOPE_MISMATCH')
const CERT_ISO = await as(qual, () => rpc('norm_certificate_record', null, null, S_ISO, E_ISO, 'CERT-ISO-1', 'Organisme test', iso(-30), iso(400), DOC1))
ok('certificat ISO 9001 au niveau société : aucun produit ni version rattaché', (await q(`select product_id, product_version_id from norm_certificates where id=$1`, [CERT_ISO]))[0].product_id === null)
await rejects('certificat avec dates incohérentes refusé (norm_cert_dates_ck)', () => as(qual, () => rpc('norm_certificate_record', P, v1P, S_343, E343_1, 'CERT-X', 'Organisme test', iso(10), iso(-10), DOC1)), 'norm_cert_dates_ck')
await rejects('certificat avec version d’un autre produit refusé (NORM_VERSION_MISMATCH)', () => as(qual, () => rpc('norm_certificate_record', P, v1Q, S_343, E343_1, 'CERT-X', 'Organisme test', iso(-30), iso(400), DOC1)), 'NORM_VERSION_MISMATCH')
const CERT343 = await as(qual, () => rpc('norm_certificate_record', P, v1P, S_343, E343_1, 'CERT-343-1', 'Organisme test', iso(-30), iso(400), DOC1))
const s343 = await stOf(P, v1P, 'EN 343')
ok('certificat daté et rattaché à la version : « preuve documentaire valide », numéro et document conservés', s343.state === 'preuve_valide' && s343.certificate_no === 'CERT-343-1' && s343.ged_document_id === DOC1 && s343.days_left >= 399)
const s343v2 = await stOf(P, v2P, 'EN 343')
ok('nouvelle version : le certificat de la version 1 ne couvre pas la version 2 (« manquant »)', s343v2.state === 'manquant')

// Échéances : expiré, échéance proche, édition différente
await as(qual, () => rpc('norm_certificate_record', P, v1P, S_13688, E13688_B, 'CERT-13688-OLD', 'Organisme test', iso(-400), iso(-1), DOC2))
ok('certificat expiré : statut « expiré » signalé', (await stOf(P, v1P, 'EN ISO 13688')).state === 'expire')
await as(qual, () => rpc('norm_certificate_record', P, v1P, S_14058, E14058_C, 'CERT-14058', 'Organisme test', iso(-300), iso(30), DOC3))
ok('échéance dans 30 jours : « échéance proche » avec seuil de 60 jours', (await stOf(P, v1P, 'EN 14058')).state === 'echeance_proche')
await as(qual, () => rpc('norm_requirement_confirm', P, S_20471, true, E20471_A2, 'Gilet haute visibilité — édition A2'))
await as(qual, () => rpc('norm_certificate_record', P, v1P, S_20471, E20471_A, 'CERT-20471-A', 'Organisme test', iso(-30), iso(300), DOC4))
ok('certificat d’une autre édition que celle exigée : « édition différente », pas de preuve retenue', (await stOf(P, v1P, 'EN ISO 20471')).state === 'edition_differente')
await as(qual, () => rpc('norm_requirement_confirm', P, S_20471, true, E20471_A, 'Gilet haute visibilité exigé par le client'))
ok('audit des confirmations : huit décisions réussies une fois l’édition A2 puis A retenues', (await count(`select count(*)::int n from audit_logs where action='norm.requirement_confirm'`)) === 8)

// Suspension et retrait : motif obligatoire, transitions contrôlées
await rejects('suspension sans motif refusée (NORM_REASON_REQUIRED)', () => as(qual, () => rpc('norm_certificate_set_status', CERT343, 'suspended', 'ok')), 'NORM_REASON_REQUIRED')
await rejects('statut inconnu refusé (NORM_BAD_STATUS)', () => as(qual, () => rpc('norm_certificate_set_status', CERT343, 'approved', 'Statut inventé pour le test')), 'NORM_BAD_STATUS')
await as(qual, () => rpc('norm_certificate_set_status', CERT343, 'suspended', 'Rapport de contrôle en attente'))
ok('certificat suspendu : la norme n’est plus « preuve valide »', (await stOf(P, v1P, 'EN 343')).state === 'suspendu_ou_retire')
await as(qual, () => rpc('norm_certificate_set_status', CERT343, 'valid', null))
ok('certificat rétabli : « preuve documentaire valide » à nouveau', (await stOf(P, v1P, 'EN 343')).state === 'preuve_valide')
await as(qual, () => rpc('norm_certificate_set_status', CERT343, 'withdrawn', 'Retiré par l’organisme'))
await rejects('certificat retiré : retour au statut valide refusé (NORM_BAD_STATUS)', () => as(qual, () => rpc('norm_certificate_set_status', CERT343, 'valid', null)), 'NORM_BAD_STATUS')

// --- Alertes d'échéance -----------------------------------------------------------------------------------------------------------------------
const alerts = await as(qual, () => rpc('norm_expiry_alerts', 60))
ok('alertes : certificat expiré et certificat à 30 jours signalés, certificat à 400 jours et certificat retiré absents', alerts.some((a) => a.certificate_no === 'CERT-13688-OLD' && a.expired === true)
  && alerts.some((a) => a.certificate_no === 'CERT-14058' && a.expired === false) && !alerts.some((a) => a.certificate_no === 'CERT-343-1'))
await rejects('délai d’alerte hors plage refusé (NORM_ALERT_DAYS_INVALID)', () => as(qual, () => rpc('norm_expiry_alerts', 400)), 'NORM_ALERT_DAYS_INVALID')

// --- Droits, RLS, écriture directe, audit ---------------------------------------------------------------------------------------------------
ok('lecture de la fiche de statut autorisée au commercial (certifications.read)', (await as(comm, () => rpc('norm_product_status', P, v1P, 60))).standards.length === 4)
await rejects('lecture de la fiche de statut refusée sans droit (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('norm_product_status', P, v1P, 60)), 'RBAC_FORBIDDEN')
ok('certificats invisibles sans droit (RLS)', (await as(nobody, () => count(`select count(*)::int n from norm_certificates`))) === 0)
await rejects('insertion directe d’un certificat refusée (permission denied)', () => as(qual, () => db.query(`insert into norm_certificates(product_id, product_version_id, standard_id, edition_id, certificate_no, issuer, issued_on, valid_until, ged_document_id) values ($1,$2,$3,$4,'DIRECT','X',current_date,current_date,$5)`, [P, v1P, S_343, E343_1, DOC1])), 'permission denied')
await rejects('essai en écriture directe refusé (permission denied)', () => as(qual, () => db.query(`update norm_tests set result='fail'`)), 'permission denied')
ok('audit : certificats enregistrés et changements de statut tracés (trois changements)', (await count(`select count(*)::int n from audit_logs where action='norm.certificate_status'`)) === 3
  && (await count(`select count(*)::int n from audit_logs where action='norm.certificate_record'`)) >= 4
  && (await count(`select count(*)::int n from audit_logs where action='norm.test_record'`)) === 1)
