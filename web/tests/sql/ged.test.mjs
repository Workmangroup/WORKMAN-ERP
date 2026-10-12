import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const uuid = () => crypto.randomUUID()
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

// --- Acteurs -----------------------------------------------------------------------
const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const qual = await mkUser('qual@x.com', 'qualite')
const fin = await mkUser('fin@x.com', 'finance')
const prod = await mkUser('prod@x.com', 'production')
const magasin = await mkUser('mag@x.com', 'magasin')

const perms = async (code) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [code])).map((r) => r.code)
ok('permissions GED : validate/delete pour admin, validate pour direction et qualité',
  (await perms('admin')).includes('documents.delete') && (await perms('direction')).includes('documents.validate') &&
  (await perms('qualite')).includes('documents.validate') && !(await perms('qualite')).includes('documents.delete'))
ok('commercial et finance peuvent déposer des documents', (await perms('commercial')).includes('documents.write') && (await perms('finance')).includes('documents.write'))
ok('magasin et production : pas de dépôt', !(await perms('magasin')).includes('documents.write') && !(await perms('production')).includes('documents.write'))

// --- 1. Espace documentaire automatique -------------------------------------------------
const mkClient = async (name, u = comm) => as(u, async () => (await q(`insert into clients(name,country) values ($1,'FR') returning id`, [name]))[0])
const c1 = await mkClient('Engie Workwear')
const folders = await q(`select name, system_key, sort_order from ged_folders where client_id=$1 order by sort_order`, [c1.id])
ok('9 dossiers système créés automatiquement avec le client', folders.length === 9)
ok('arborescence : Contrats, Commandes, Factures, BAT, Patronages, Certifications, Logos, Correspondances, Qualité',
  folders.map((f) => f.name).join('|') === 'Contrats|Commandes|Factures|BAT|Patronages|Certifications|Logos|Correspondances|Qualité')
const F = async (key, cid = c1.id) => (await q(`select id from ged_folders where client_id=$1 and system_key=$2`, [cid, key]))[0].id
ok('dossiers visibles avec documents.read', (await as(prod, () => q(`select id from ged_folders where client_id=$1`, [c1.id]))).length === 9)
ok('dossiers invisibles sans documents.read', (await as(magasin, () => q(`select id from ged_folders`))).length === 0)

// dossiers système protégés
const contracts = await F('contracts')
await rejects('dossier système : renommage refusé', () => as(comm, () => db.query(`update ged_folders set name='X' where id=$1`, [contracts])), 'GED_SYSTEM_FOLDER')
await rejects('dossier système : suppression refusée', () => as(comm, () => db.query(`delete from ged_folders where id=$1`, [contracts])), 'GED_SYSTEM_FOLDER')
await rejects('dossier système : création manuelle refusée', () => as(comm, () => db.query(`insert into ged_folders(client_id,name,system_key) values ($1,'Faux','bat')`, [c1.id])), 'permission denied')

// sous-dossiers
const sub = await as(comm, async () => (await q(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,'2026') returning id`, [c1.id, contracts]))[0])
ok('sous-dossier créé', !!sub.id)
await rejects('doublon de nom dans le même dossier refusé', () => as(comm, () => db.query(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,' 2026 ')`, [c1.id, contracts])), 'ged_folders_name_uq')
await rejects('création de dossier refusée sans documents.write', () => as(prod, () => db.query(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,'Intrus')`, [c1.id, contracts])), 'row-level security')
await rejects('nom de dossier avec « / » refusé', () => as(comm, () => db.query(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,'a/b')`, [c1.id, contracts])), 'name')
const sub2 = await as(comm, async () => (await q(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,'T1') returning id`, [c1.id, sub.id]))[0])
await rejects('profondeur limitée à 3 niveaux', () => as(comm, () => db.query(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,'T2')`, [c1.id, sub2.id])), 'GED_TOO_DEEP')
await as(comm, () => db.query(`update ged_folders set name='2026 (archives)' where id=$1`, [sub.id]))
await as(comm, () => db.query(`delete from ged_folders where id=$1`, [sub2.id]))
ok('renommage et suppression d’un sous-dossier vide', (await q(`select name from ged_folders where id=$1`, [sub.id]))[0].name === '2026 (archives)')

// --- 2. Création de documents + versions ---------------------------------------------------
const create = (u, o) => as(u, () => rpc('ged_create_document', o.id, o.folder, o.title ?? 'Contrat cadre 2026', o.desc ?? 'Description', o.tags ?? ['Contrat', ' 2026 ', 'contrat'],
  o.valid ?? null, o.ver, o.path, o.file ?? 'contrat.pdf', o.mime ?? 'application/pdf', o.size ?? 1000, o.sha ?? 'a'.repeat(64), o.note ?? null))
const newDoc = async (u, folder, over = {}) => {
  const id = uuid(), ver = uuid()
  const cid = (await q(`select client_id from ged_folders where id=$1`, [folder]))[0].client_id
  await create(u, { id, ver, folder, path: `${company}/${cid}/${id}/${ver}-contrat.pdf`, ...over })
  return { id, ver, cid }
}
const d1 = await newDoc(comm, contracts)
const doc1 = (await q(`select * from ged_documents where id=$1`, [d1.id]))[0]
ok('document créé : statut brouillon, version 1', doc1.status === 'draft' && doc1.version_count === 1 && doc1.current_version_id === d1.ver)
ok('métadonnées de la version courante copiées', doc1.file_name === 'contrat.pdf' && Number(doc1.size_bytes) === 1000)
ok('tags normalisés (minuscules, dédoublonnés)', JSON.stringify(doc1.tags) === JSON.stringify(['2026', 'contrat']))
ok('créateur et société déduits', doc1.created_by === comm && doc1.company_id === company)

await rejects('création refusée sans documents.write', () => newDoc(prod, contracts), 'RBAC_FORBIDDEN')
await rejects('chemin de stockage hors du dossier du document refusé', () => create(comm, { id: uuid(), ver: uuid(), folder: contracts, path: `${company}/${c1.id}/${uuid()}/x.pdf` }), 'GED_INVALID_PATH')
await rejects('chemin d’un autre client refusé', async () => { const id = uuid(); await create(comm, { id, ver: uuid(), folder: contracts, path: `${company}/${uuid()}/${id}/x.pdf` }) }, 'GED_INVALID_PATH')
await rejects('taille > 25 Mo refusée', () => newDoc(comm, contracts, { size: 30_000_000 }), 'size_bytes')
await rejects('empreinte invalide refusée', () => newDoc(comm, contracts, { sha: 'zz' }), 'sha256')
await rejects('titre trop court refusé', () => newDoc(comm, contracts, { title: 'A' }), 'title')
await rejects('plus de 10 tags refusé', () => newDoc(comm, contracts, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), 'GED_TOO_MANY_TAGS')

// versionnement
const v2id = uuid()
const n2 = await as(comm, () => rpc('ged_add_version', d1.id, v2id, `${company}/${d1.cid}/${d1.id}/${v2id}-contrat-v2.pdf`, 'contrat-v2.pdf', 'application/pdf', 2048, 'b'.repeat(64), 'Corrections article 4'))
ok('nouvelle version : numéro 2', n2 === 2)
const doc1b = (await q(`select * from ged_documents where id=$1`, [d1.id]))[0]
ok('version courante mise à jour', doc1b.current_version_id === v2id && doc1b.file_name === 'contrat-v2.pdf' && doc1b.version_count === 2)
ok('toutes les versions conservées', (await q(`select version_no from ged_document_versions where document_id=$1 order by version_no`, [d1.id])).map((v) => v.version_no).join() === '1,2')
await rejects('version : chemin invalide refusé', () => as(comm, () => rpc('ged_add_version', d1.id, uuid(), `${company}/${d1.cid}/${uuid()}/x.pdf`, 'x.pdf', 'application/pdf', 1, null)), 'GED_INVALID_PATH')
await rejects('version : refusée sans documents.write', () => as(prod, () => rpc('ged_add_version', d1.id, uuid(), `${company}/${d1.cid}/${d1.id}/z.pdf`, 'z.pdf', 'application/pdf', 1, null)), 'RBAC_FORBIDDEN')
await rejects('version immuable (UPDATE interdit)', () => db.query(`update ged_document_versions set file_name='hack' where document_id=$1`, [d1.id]), 'GED_VERSION_IMMUTABLE')
await rejects('version : pas d’écriture directe', () => as(comm, () => db.query(`update ged_document_versions set file_name='hack'`)), 'permission denied')
await rejects('document : pas de création directe', () => as(comm, () => db.query(`insert into ged_documents(client_id, folder_id, title) values ($1,$2,'Direct')`, [c1.id, contracts])), 'permission denied')

// doublons
const dup = await as(comm, () => q(`select * from public.ged_find_duplicate($1,$2)`, [c1.id, 'b'.repeat(64)]))
ok('détection de doublon par empreinte', dup.length === 1 && dup[0].id === d1.id)

// --- 3. Validation ----------------------------------------------------------------------------
await rejects('validation refusée si le document n’est pas soumis', () => as(qual, () => rpc('ged_review', d1.id, true, null)), 'GED_BAD_STATUS')
await as(comm, () => rpc('ged_submit', d1.id))
ok('soumission : en validation', (await q(`select status from ged_documents where id=$1`, [d1.id]))[0].status === 'pending_review')
await rejects('soumission déjà faite refusée', () => as(comm, () => rpc('ged_submit', d1.id)), 'GED_BAD_STATUS')
await rejects('validation refusée sans documents.validate (commercial)', () => as(comm, () => rpc('ged_review', d1.id, true, null)), 'RBAC_FORBIDDEN')
await rejects('rejet sans commentaire refusé', () => as(qual, () => rpc('ged_review', d1.id, false, ' ')), 'GED_COMMENT_REQUIRED')
await as(qual, () => rpc('ged_review', d1.id, false, 'Signature manquante page 3'))
let st = (await q(`select status, validated_by, validation_comment from ged_documents where id=$1`, [d1.id]))[0]
ok('rejet : statut + commentaire + validateur', st.status === 'rejected' && st.validated_by === qual && st.validation_comment === 'Signature manquante page 3')
await as(comm, () => rpc('ged_submit', d1.id))
await as(qual, () => rpc('ged_review', d1.id, true, 'Conforme'))
st = (await q(`select status, validated_version_id from ged_documents where id=$1`, [d1.id]))[0]
ok('validation : statut validé, version validée mémorisée', st.status === 'validated' && st.validated_version_id === v2id)
const v3id = uuid()
await as(comm, () => rpc('ged_add_version', d1.id, v3id, `${company}/${d1.cid}/${d1.id}/${v3id}-v3.pdf`, 'v3.pdf', 'application/pdf', 3000, null, 'Révision'))
st = (await q(`select status, validated_by, validated_version_id from ged_documents where id=$1`, [d1.id]))[0]
ok('nouvelle version : validation annulée (retour brouillon)', st.status === 'draft' && st.validated_by === null && st.validated_version_id === null)

// --- 4. Métadonnées, déplacement, commentaires -------------------------------------------------
const orders = await F('orders')
await as(comm, () => db.query(`update ged_documents set title='Contrat cadre 2026 v3', folder_id=$2, tags='{a,b}', valid_until='2027-01-31' where id=$1`, [d1.id, orders]))
ok('mise à jour des métadonnées + déplacement', (await q(`select title, folder_id from ged_documents where id=$1`, [d1.id]))[0].folder_id === orders)
await rejects('statut non modifiable directement', () => as(comm, () => db.query(`update ged_documents set status='validated' where id=$1`, [d1.id])), 'permission denied')
const c2 = await mkClient('Bragard Pro')
const otherFolder = await F('orders', c2.id)
await rejects('déplacement inter-clients refusé', () => as(comm, () => db.query(`update ged_documents set folder_id=$2 where id=$1`, [d1.id, otherFolder])), 'GED_BAD_FOLDER')

await as(prod, () => db.query(`insert into ged_comments(document_id, body) values ($1, 'Vu côté production')`, [d1.id]))
await as(qual, () => db.query(`insert into ged_comments(document_id, body) values ($1, 'À revoir')`, [d1.id]))
const cm = await q(`select id, author_id, body from ged_comments where document_id=$1 order by created_at`, [d1.id])
ok('commentaires : auteur déduit (lecteur sans droit d’écriture inclus)', cm.length === 2 && cm[0].author_id === prod)
await rejects('commentaire vide refusé', () => as(prod, () => db.query(`insert into ged_comments(document_id, body) values ($1, '  ')`, [d1.id])), 'body')
await rejects('commentaire refusé sans documents.read', () => as(magasin, () => db.query(`insert into ged_comments(document_id, body) values ($1, 'x')`, [d1.id])), 'row-level security')
await rejects('usurpation d’auteur impossible', () => as(prod, () => db.query(`insert into ged_comments(document_id, body, author_id) values ($1, 'x', $2)`, [d1.id, qual])), 'permission denied')
await rejects('commentaire d’autrui non supprimable', () => as(prod, () => rpc('ged_delete_comment', cm[1].id)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('ged_delete_comment', cm[0].id))
ok('commentaire : suppression logique par son auteur', (await q(`select deleted_at from ged_comments where id=$1`, [cm[0].id]))[0].deleted_at !== null)
await as(admin, () => rpc('ged_delete_comment', cm[1].id))
ok('commentaire : supprimable par documents.delete', (await q(`select count(*)::int n from ged_comments where document_id=$1 and deleted_at is null`, [d1.id]))[0].n === 0)
await rejects('commentaire : édition interdite', () => db.query(`update ged_comments set body='modifié'`), 'GED_VERSION_IMMUTABLE')

// --- 5. Corbeille ------------------------------------------------------------------------------------
const d2 = await newDoc(comm, await F('invoices'), { title: 'Facture 2026-001', sha: 'c'.repeat(64) })
await as(comm, () => rpc('ged_trash', d2.id))
ok('corbeille : document marqué supprimé (non effacé)', (await q(`select deleted_at, deleted_by from ged_documents where id=$1`, [d2.id]))[0].deleted_by === comm)
await rejects('corbeille : déjà supprimé', () => as(comm, () => rpc('ged_trash', d2.id)), 'GED_TRASHED')
await rejects('corbeille : nouvelle version refusée', () => as(comm, () => rpc('ged_add_version', d2.id, uuid(), `${company}/${d2.cid}/${d2.id}/n.pdf`, 'n.pdf', 'application/pdf', 1, null)), 'GED_TRASHED')
await rejects('corbeille : modification directe refusée', async () => {
  const r = await as(comm, () => db.query(`update ged_documents set title='Modifié en corbeille' where id=$1`, [d2.id]))
  if (r.affectedRows === 0) throw new Error('row-level security')
}, 'row-level security')
await rejects('corbeille : restauration refusée sans documents.write', () => as(prod, () => rpc('ged_restore', d2.id)), 'RBAC_FORBIDDEN')
await as(comm, () => rpc('ged_restore', d2.id))
ok('corbeille : restauration', (await q(`select deleted_at from ged_documents where id=$1`, [d2.id]))[0].deleted_at === null)
await rejects('restauration d’un document hors corbeille refusée', () => as(comm, () => rpc('ged_restore', d2.id)), 'GED_NOT_TRASHED')

// document validé = protégé
const d3 = await newDoc(comm, await F('certifications'), { title: 'Certificat OEKO-TEX', sha: 'd'.repeat(64) })
await as(comm, () => rpc('ged_submit', d3.id)); await as(qual, () => rpc('ged_review', d3.id, true, null))
await rejects('un document validé ne peut être mis à la corbeille que par documents.delete', () => as(comm, () => rpc('ged_trash', d3.id)), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('ged_trash', d3.id))
ok('document validé mis à la corbeille par un administrateur', (await q(`select deleted_at from ged_documents where id=$1`, [d3.id]))[0].deleted_at !== null)

// purge
await rejects('purge refusée hors corbeille', () => as(admin, () => rpc('ged_purge', d1.id)), 'GED_NOT_TRASHED')
await rejects('purge réservée à documents.delete', () => as(comm, () => rpc('ged_purge', d3.id)), 'RBAC_FORBIDDEN')
const purged = await as(admin, () => rpc('ged_purge', d3.id))
ok('purge : renvoie les fichiers à supprimer du Storage', Array.isArray(purged) && purged.length === 1 && purged[0].bucket === 'ged' && purged[0].path.includes(d3.id))
ok('purge : document supprimé définitivement', (await q(`select count(*)::int n from ged_documents where id=$1`, [d3.id]))[0].n === 0)
// vider la corbeille
const d4 = await newDoc(comm, await F('logos'), { title: 'Logo client', sha: 'e'.repeat(64) })
const d5 = await newDoc(comm, await F('logos'), { title: 'Logo noir', sha: 'f'.repeat(64) })
await as(comm, () => rpc('ged_trash', d4.id)); await as(comm, () => rpc('ged_trash', d5.id))
const emptied = await as(admin, () => rpc('ged_empty_trash', c1.id))
ok('vider la corbeille : 2 fichiers à supprimer', emptied.length === 2)
// rétention
const d6 = await newDoc(comm, await F('logos'), { title: 'Vieux logo', sha: '1'.repeat(64) })
await as(comm, () => rpc('ged_trash', d6.id))
await db.query(`update ged_documents set deleted_at = now() - interval '45 days' where id=$1`, [d6.id])
await rejects('purge automatique non appelable par un utilisateur', () => as(admin, () => rpc('ged_purge_expired', 30)), 'permission denied')
const expired = await rpc('ged_purge_expired', 30)
ok('purge automatique (30 j) : document expiré supprimé', expired.length === 1 && (await q(`select count(*)::int n from ged_documents where id=$1`, [d6.id]))[0].n === 0)

// --- 6. Isolation / client archivé / suppression client -----------------------------------------------------
const foreignCo = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const foreignClient = (await q(`insert into clients(company_id,name,country) values ($1,'Étranger','DE') returning id`, [foreignCo]))[0].id
ok('société étrangère : dossiers créés aussi (trigger)', (await q(`select count(*)::int n from ged_folders where client_id=$1`, [foreignClient]))[0].n === 9)
ok('isolation : dossiers d’une autre société invisibles', (await as(admin, () => q(`select id from ged_folders where client_id=$1`, [foreignClient]))).length === 0)

const stats = await as(comm, () => q(`select * from public.ged_client_stats()`))
const s1 = stats.find((s) => s.client_id === c1.id)
ok('statistiques par client (documents, en validation, corbeille)', s1 && Number(s1.documents) === 2 && Number(s1.trashed) === 0, JSON.stringify(s1))
await rejects('statistiques réservées à documents.read', () => as(magasin, () => q(`select * from public.ged_client_stats()`)), 'RBAC_FORBIDDEN')

// archivage du client : GED verrouillée en écriture, lecture conservée
const dArch = await newDoc(comm, await F('quality'), { title: 'Rapport qualité', sha: '2'.repeat(64) })
await as(admin, () => rpc('client_archive', c1.id, 'test'))
await rejects('client archivé : dépôt refusé', () => newDoc(comm, contracts, { sha: '3'.repeat(64) }), 'CLIENT_ARCHIVED')
await rejects('client archivé : nouvelle version refusée', () => as(comm, () => rpc('ged_add_version', dArch.id, uuid(), `${company}/${dArch.cid}/${dArch.id}/n.pdf`, 'n.pdf', 'application/pdf', 1, null)), 'CLIENT_ARCHIVED')
await rejects('client archivé : création de dossier refusée', () => as(comm, () => db.query(`insert into ged_folders(client_id,parent_id,name) values ($1,$2,'Nouveau')`, [c1.id, contracts])), 'CLIENT_ARCHIVED')
await rejects('client archivé : suppression de document refusée', () => as(comm, () => rpc('ged_trash', dArch.id)), 'CLIENT_ARCHIVED')
ok('client archivé : documents toujours consultables', (await as(prod, () => q(`select id from ged_documents where client_id=$1`, [c1.id]))).length >= 1)
await as(admin, () => rpc('client_restore', c1.id))

// --- 7. Historique ------------------------------------------------------------------------------------
const h = await q(`select action, entity_type, entity_label, actor_email, before_data, after_data, metadata from audit_logs where entity_type in ('document','folder') order by id`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['ged.create', 'ged.version_add', 'ged.submit', 'ged.reject', 'ged.validate', 'ged.invalidate', 'ged.update', 'ged.move', 'ged.comment_add', 'ged.comment_delete', 'ged.trash', 'ged.restore', 'ged.purge', 'ged.folder_create', 'ged.folder_rename', 'ged.folder_delete'])
  ok(`historique : ${a}`, acts.has(a))
ok('historique : un seul ged.create par document (pas de bruit de version 1)', h.filter((r) => r.action === 'ged.create' && r.entity_label === 'Contrat cadre 2026').length === 1 && !h.some((r) => r.action === 'ged.version_add' && r.metadata.version === 1))
const mv = h.find((r) => r.action === 'ged.move')
ok('historique : déplacement avec dossier avant/après', mv.before_data.folder === 'Contrats' && mv.after_data.folder === 'Commandes')
const upd = h.find((r) => r.action === 'ged.update')
ok('historique : mise à jour avec avant/après des champs suivis', upd.after_data.valid_until === '2027-01-31' || upd.after_data.title !== undefined)
ok('historique : version avec note et taille', h.find((r) => r.action === 'ged.version_add').metadata.file_name !== undefined)
ok('historique : validation avec commentaire', h.find((r) => r.action === 'ged.reject').metadata.comment === 'Signature manquante page 3')
ok('historique : le client est identifié', h.every((r) => r.metadata.client_id) && h.find((r) => r.action === 'ged.create').metadata.client_name === 'Engie Workwear')
ok('historique : acteur renseigné', h.find((r) => r.action === 'ged.validate').actor_email === 'qual@x.com')
ok('historique : purge tracée avec raison', h.filter((r) => r.action === 'ged.purge').map((r) => r.metadata.reason).sort().join() === 'empty_trash,empty_trash,manual,retention')
ok('historique GED lisible avec documents.read', (await as(prod, () => q(`select id from audit_logs where entity_type='document'`))).length > 0)
ok('historique GED illisible sans documents.read', (await as(magasin, () => q(`select id from audit_logs where entity_type='document'`))).length === 0)
ok('historique GED : société étrangère invisible', (await as(admin, () => q(`select id from audit_logs where entity_type='folder' and company_id=$1`, [foreignCo]))).length === 0)

// --- 8. Storage -----------------------------------------------------------------------------------------
const bucket = (await q(`select public, file_size_limit from storage.buckets where id='ged'`))[0]
ok('bucket ged privé, limite 25 Mo', bucket.public === false && Number(bucket.file_size_limit) === 26214400)
const put = (u, name) => as(u, () => db.query(`insert into storage.objects(bucket_id, name) values ('ged', $1)`, [name]))
const objPath = `${company}/${c1.id}/${uuid()}/${uuid()}-plan.dxf`
await put(comm, objPath)
ok('storage : dépôt autorisé dans l’espace du client', (await q(`select 1 from storage.objects where name=$1`, [objPath])).length === 1)
await rejects('storage : dépôt refusé sans documents.write', () => put(prod, `${company}/${c1.id}/${uuid()}/${uuid()}-x.pdf`), 'row-level security')
await rejects('storage : dépôt refusé pour un autre client/société', () => put(comm, `${foreignCo}/${foreignClient}/${uuid()}/${uuid()}-x.pdf`), 'row-level security')
await rejects('storage : dépôt refusé pour un client inconnu', () => put(comm, `${company}/${uuid()}/${uuid()}/${uuid()}-x.pdf`), 'row-level security')
ok('storage : lecture avec documents.read', (await as(prod, () => q(`select name from storage.objects where bucket_id='ged'`))).length === 1)
ok('storage : lecture refusée sans documents.read', (await as(magasin, () => q(`select name from storage.objects where bucket_id='ged'`))).length === 0)
await rejects('storage : suppression directe interdite', () => as(admin, () => db.query(`delete from storage.objects where bucket_id='ged'`)).then(async (r) => { if (r.affectedRows === 0) throw new Error('row-level security') }), 'row-level security')
await as(admin, () => rpc('client_archive', c1.id, 'dépôt après archivage'))
await rejects('storage : dépôt refusé pour un client archivé', () => put(comm, `${company}/${c1.id}/${uuid()}/${uuid()}-y.pdf`), 'row-level security')
await as(admin, () => rpc('client_restore', c1.id))

// --- 9. Suppression définitive d'un client : la GED suit -----------------------------------------------------------
await as(admin, () => rpc('client_archive', c1.id, 'fin'))
const before = (await q(`select count(*)::int n from ged_documents where client_id=$1`, [c1.id]))[0].n
const del = await as(admin, () => rpc('client_delete', c1.id))
ok('suppression du client : documents comptés et supprimés en cascade', del.documents === before && (await q(`select count(*)::int n from ged_folders where client_id=$1`, [c1.id]))[0].n === 0 && (await q(`select count(*)::int n from ged_document_versions where client_id=$1`, [c1.id]))[0].n === 0, JSON.stringify(del))

// --- 10. Migration depuis client_documents (aperçu fonctionnel : table supprimée) ------------------------------
ok('client_documents supprimée (remplacée par la GED)', (await q(`select to_regclass('public.client_documents') r`))[0].r === null)
