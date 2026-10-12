import { createDb, makeHelpers } from './_harness.mjs'
import { randomUUID } from 'node:crypto'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const uuid = () => randomUUID()

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const prod = await mkUser('prod@x.com', 'production')       // lecture des documents seulement
const nobody = await mkUser('nobody@x.com', null)
const foreignCo = (await q(`insert into companies(name, country) values ('Autre','TN') returning id`))[0].id
const foreign = (await q(`insert into auth.users(email) values ('etranger@x.com') returning id`))[0].id
await db.query(`insert into profiles(id, company_id, email, full_name, user_type, is_active) values ($1,$2,'etranger@x.com','Étranger','internal',true) on conflict (id) do update set company_id = excluded.company_id`, [foreign, foreignCo])
await db.query(`insert into roles(company_id, code, label, is_system) values ($1,'admin','Administrateur étranger', true)`, [foreignCo])
await db.query(`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.company_id=$1 and r.code='admin' and p.code like 'documents.%' on conflict do nothing`, [foreignCo])
await db.query(`insert into user_roles values ($1, (select id from roles where code='admin' and company_id=$2))`, [foreign, foreignCo])

// --- Client, dossier et document -------------------------------------------------------------------------------------------------------
const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client documents','TN','EUR') returning id`)))[0].id
const folder = (await q(`select id from ged_folders where client_id=$1 and system_key='contracts'`, [cl]))[0].id
const newVersion = async (docId, fileName = 'contrat.pdf', sha = 'a'.repeat(64)) => {
  const ver = uuid()
  await as(admin, () => rpc('ged_add_version', docId, ver, `${company}/${cl}/${docId}/${ver}-${fileName}`, fileName, 'application/pdf', 1000, sha, 'Version de test'))
  return ver
}
const docId = uuid(), v1 = uuid()
await as(admin, () => rpc('ged_create_document', docId, folder, 'Contrat cadre', 'Description', ['test'], null, v1, `${company}/${cl}/${docId}/${v1}-contrat.pdf`, 'contrat.pdf', 'application/pdf', 1000, 'a'.repeat(64), null))

// --- A. Publication : une version n'est publiée qu'après analyse propre --------------------------------------------------------------------
ok('nouvelle version : en quarantaine (pending) à la création', (await q(`select scan_status from ged_version_scans where version_id=$1`, [v1]))[0].scan_status === 'pending')
await rejects('version en attente : téléchargement refusé', () => as(admin, () => q(`select * from ged_download_check($1)`, [v1])), 'GED_NOT_PUBLISHED')
await rejects('analyse : écriture directe du statut refusée', () => as(admin, () => db.query(`update ged_version_scans set scan_status='clean'`)), 'permission denied')
await rejects('analyse : appel du service réservé au service d’analyse', () => as(admin, () => q(`select public.ged_record_scan($1, 'clean', 'engine-x')`, [v1])), 'permission denied')
await rejects('version : toujours immuable (UPDATE interdit)', () => db.query(`update ged_document_versions set file_name='x' where id=$1`, [v1]), 'GED_VERSION_IMMUTABLE')
await db.query(`select public.ged_record_scan($1, 'clean', 'antivirus-test', 'Aucune menace', null)`, [v1])
const dl = (await as(admin, () => q(`select file_name, version_no from ged_download_check($1)`, [v1])))[0]
ok('analyse propre : téléchargement autorisé pour qui a documents.read', dl.file_name === 'contrat.pdf' && dl.version_no === 1)
ok('lecteur (production) : téléchargement autorisé avec documents.read', (await as(prod, () => q(`select version_no from ged_download_check($1)`, [v1]))).length === 1)

// --- B. Fichier suspect : jamais publié -----------------------------------------------------------------------------------------------------
const v2 = await newVersion(docId, 'suspect.pdf')
await db.query(`select public.ged_record_scan($1, 'infected', 'antivirus-test', 'Signature de logiciel malveillant', null)`, [v2])
await rejects('fichier suspect : téléchargement refusé', () => as(admin, () => q(`select * from ged_download_check($1)`, [v2])), 'GED_NOT_PUBLISHED')
await rejects('fichier suspect : lien refusé', () => as(admin, () => rpc('ged_link_create', v2, 24)), 'GED_NOT_PUBLISHED')
ok('fichier suspect : visible en quarantaine avec son motif', (await as(admin, () => q(`select scan_status, scan_details from ged_quarantine_list() where version_id=$1`, [v2])))[0]?.scan_status === 'infected')

// empreinte annoncée différente de celle calculée : erreur, non publié
const v3 = await newVersion(docId, 'empreinte.pdf', 'c'.repeat(64))
await db.query(`select public.ged_record_scan($1, 'clean', 'antivirus-test', null, $2)`, [v3, 'd'.repeat(64)])
ok('empreinte différente : statut erreur, non publié', (await q(`select scan_status from ged_version_scans where version_id=$1`, [v3]))[0].scan_status === 'error')
await rejects('empreinte différente : téléchargement refusé', () => as(admin, () => q(`select * from ged_download_check($1)`, [v3])), 'GED_NOT_PUBLISHED')
ok('résultat d’analyse invalide refusé', (await db.query(`select public.ged_record_scan($1, 'peut-etre', 'antivirus-test')`, [v3]).then(() => 'ok', (e) => e.message)).includes('GED_BAD_SCAN_RESULT'))

// --- C. Fichier étranger : inaccessible --------------------------------------------------------------------------------------------------------
await rejects('fichier d’une autre société : téléchargement refusé', () => as(foreign, () => q(`select * from ged_download_check($1)`, [v1])), 'GED_NOT_FOUND')
await rejects('sans droit de lecture : téléchargement refusé', () => as(nobody, () => q(`select * from ged_download_check($1)`, [v1])), 'RBAC_FORBIDDEN')
ok('quarantaine : invisible pour une autre société', (await as(foreign, () => q(`select version_id from ged_quarantine_list()`))).length === 0)

// --- D. Liens temporaires -----------------------------------------------------------------------------------------------------------------------
const link = await as(admin, () => rpc('ged_link_create', v1, 2))
ok('lien créé : jeton et date d’expiration', typeof link.token === 'string' && link.token.length === 64 && link.expires_at)
const stored = await q(`select token_hash from ged_share_links`)
ok('jeton non stocké en clair (empreinte seulement)', stored.length === 1 && stored[0].token_hash !== link.token && stored[0].token_hash.length === 64)
const opened = await as(prod, () => q(`select version_no from ged_link_resolve($1)`, [link.token]))
ok('lien valide : ouvert par un lecteur autorisé', opened.length === 1 && opened[0].version_no === 1)
await rejects('lien : personne sans droit refusée, même avec le jeton', () => as(nobody, () => q(`select * from ged_link_resolve($1)`, [link.token])), 'RBAC_FORBIDDEN')
await rejects('lien : autre société refusée, même avec le jeton', () => as(foreign, () => q(`select * from ged_link_resolve($1)`, [link.token])), 'GED_NOT_FOUND')
await rejects('lien inconnu refusé', () => as(admin, () => q(`select * from ged_link_resolve($1)`, ['f'.repeat(64)])), 'GED_LINK_INVALID')
await rejects('lien : durée au-delà de 7 jours refusée', () => as(admin, () => rpc('ged_link_create', v1, 200)), 'GED_LINK_WINDOW')
await rejects('lien : durée nulle refusée', () => as(admin, () => rpc('ged_link_create', v1, 0)), 'GED_LINK_WINDOW')
await db.query(`update ged_share_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where token_hash = $1`, [stored[0].token_hash])
await rejects('lien expiré refusé', () => as(admin, () => q(`select * from ged_link_resolve($1)`, [link.token])), 'GED_LINK_EXPIRED')
const link2 = await as(admin, () => rpc('ged_link_create', v1, 24))
const link2Id = (await q(`select id from ged_share_links where token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')`, [link2.token]))[0].id
await as(admin, () => rpc('ged_link_revoke', link2Id, 'Partage terminé'))
await rejects('lien révoqué refusé', () => as(admin, () => q(`select * from ged_link_resolve($1)`, [link2.token])), 'GED_LINK_REVOKED')
await rejects('lien : vers une version en quarantaine refusé', () => as(admin, () => rpc('ged_link_create', v2, 24)), 'GED_NOT_PUBLISHED')
ok('ouverture de lien tracée (compteur et journal)', (await q(`select use_count from ged_share_links where token_hash=$1`, [stored[0].token_hash]))[0].use_count === 1)

// --- E. Rétention par catégorie : durée validée seulement -------------------------------------------------------------------------------
await rejects('rétention : refusée sans droit documents.retention', () => as(prod, () => rpc('ged_retention_set', 'contracts', 60, 'Obligation comptable locale', true)), 'RBAC_FORBIDDEN')
await rejects('rétention : durée requise pour valider', () => as(admin, () => rpc('ged_retention_set', 'contracts', null, 'Obligation comptable locale', true)), 'GED_RETENTION_MONTHS_REQUIRED')
await rejects('rétention : base légale requise', () => as(admin, () => rpc('ged_retention_set', 'contracts', 60, 'x', true)), 'GED_RETENTION_BASIS_REQUIRED')
await as(admin, () => rpc('ged_retention_set', 'orders', null, 'À confirmer par le propriétaire', false))
ok('catégorie non validée : « à confirmer », sans durée', (await q(`select status, retention_months from ged_retention_rules where category='orders'`))[0].status === 'a_confirmer')
await as(admin, () => rpc('ged_retention_set', 'contracts', 60, 'Obligation comptable locale', true))
ok('catégorie validée : durée et validateur enregistrés', (await q(`select status, retention_months, validated_by from ged_retention_rules where category='contracts'`))[0].validated_by === admin)
await db.query(`update ged_documents set retention_category='contracts' where id=$1`, [docId])
const due = await as(admin, () => q(`select category, due_documents from ged_retention_due(current_date + 365 * 10)`))
ok('échéance calculée pour la catégorie validée uniquement', due.find((r) => r.category === 'contracts')?.due_documents >= 1 && !due.some((r) => r.category === 'orders' && r.due_documents > 0))

// --- F. Types de fichiers au niveau du bucket ---------------------------------------------------------------------------------------------
const mimes = (await q(`select allowed_mime_types m from storage.buckets where id='ged'`))[0].m
ok('bucket : PDF autorisé, SVG et HTML refusés', mimes.includes('application/pdf') && !mimes.includes('image/svg+xml') && !mimes.includes('text/html'))

// --- G. Journal -----------------------------------------------------------------------------------------------------------------------------------
const actions = new Set((await q(`select action from audit_logs where company_id=$1`, [company])).map((r) => r.action))
const need = ['ged.scan_clean', 'ged.scan_infected', 'ged.scan_error', 'ged.link_create', 'ged.link_open', 'ged.link_revoke', 'ged.retention_set']
ok('journal : analyses, liens et rétention tracés', need.every((a) => actions.has(a)), need.filter((a) => !actions.has(a)).join(','))
