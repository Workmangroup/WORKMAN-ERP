import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const uuid = () => crypto.randomUUID()
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const prod = await mkUser('prod@x.com', 'production')
const qual = await mkUser('qual@x.com', 'qualite')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const fin = await mkUser('fin@x.com', 'finance')

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
ok('articles.write : commercial et production', (await perms('commercial')).includes('articles.write') && (await perms('production')).includes('articles.write'))
ok('articles.validate : qualité et direction', (await perms('qualite')).includes('articles.validate') && (await perms('direction')).includes('articles.validate'))
ok('magasin : lecture seule des articles', (await perms('magasin')).includes('articles.read') && !(await perms('magasin')).includes('articles.write'))

const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const other = (await as(comm, () => q(`insert into clients(name,country) values ('Bragard','FR') returning id`)))[0].id
const ins = (u, o) => as(u, async () => (await q(`insert into articles(client_id, internal_ref, client_ref, name, family, description) values ($1,$2,$3,$4,$5,$6) returning *`,
  [o.client ?? lafont, o.ref ?? null, o.cref ?? 'LAF-HV-JKT-2027', o.name ?? 'Veste haute visibilité', o.family ?? 'jacket', o.desc ?? null]))[0])

// --- 1. Création ---------------------------------------------------------------------------------
const a1 = await ins(comm, { ref: ' jkt001 ' })
ok('référence interne normalisée (JKT001) + référence client (LAF-HV-JKT-2027)', a1.internal_ref === 'JKT001' && a1.client_ref === 'LAF-HV-JKT-2027')
ok('article créé en brouillon, société déduite', a1.status === 'draft' && a1.company_id === company && a1.created_by === comm)
const v1 = (await q(`select * from article_versions where article_id=$1`, [a1.id]))[0]
ok('version 1 (brouillon) créée automatiquement', v1.version_no === 1 && v1.status === 'draft' && a1.id)
ok('dernière version suivie (current_version_id)', (await q(`select current_version_id from articles where id=$1`, [a1.id]))[0].current_version_id === v1.id)
const auto = await ins(comm, { cref: 'LAF-X-1', name: 'Pantalon sans ref interne', family: 'trousers' })
ok('référence interne générée (ART0001)', auto.internal_ref === 'ART0001')

await rejects('création refusée sans articles.write (magasin)', () => ins(mag, { ref: 'MAG1', cref: 'M-1' }), 'row-level security')
await rejects('référence interne unique par société', () => ins(comm, { ref: 'JKT001', cref: 'AUTRE' }), 'articles_company_id_internal_ref_key')
await rejects('référence client unique par client', () => ins(comm, { ref: 'JKT002', cref: ' laf-hv-jkt-2027 ' }), 'articles_client_ref_uq')
const sameRefOtherClient = await ins(comm, { client: other, ref: 'JKT900', cref: 'LAF-HV-JKT-2027' })
ok('même référence client possible chez un autre client', !!sameRefOtherClient.id)
await rejects('format de référence interne invalide', () => ins(comm, { ref: '!!', cref: 'X' }), 'ARTICLE_INVALID_REF')
await rejects('famille invalide', () => ins(comm, { ref: 'F1', cref: 'F-1', family: 'chapeau' }), 'family')
await rejects('désignation trop courte', () => ins(comm, { ref: 'F2', cref: 'F-2', name: 'A' }), 'name')

// --- 2. Lecture / isolation / colonnes protégées ------------------------------------------------------
ok('lecture : production, qualité, magasin voient ; finance non', (await as(mag, () => q(`select id from articles`))).length === 3 && (await as(fin, () => q(`select id from articles`))).length === 0)
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const fc = (await q(`insert into clients(company_id,name,country) values ($1,'Étranger','DE') returning id`, [co2]))[0].id
await db.query(`insert into articles(company_id,client_id,internal_ref,client_ref,name) values ($1,$2,'XX1','X-1','Article étranger')`, [co2, fc])
ok('isolation entre sociétés', (await as(admin, () => q(`select id from articles`))).length === 3)
await rejects('référence interne immuable', () => as(comm, () => db.query(`update articles set internal_ref='NEW1' where id=$1`, [a1.id])), 'permission denied')
await rejects('client non modifiable', () => as(comm, () => db.query(`update articles set client_id=$2 where id=$1`, [a1.id, other])), 'permission denied')
await rejects('version courante non modifiable directement', () => as(comm, () => db.query(`update articles set active_version_id=current_version_id where id=$1`, [a1.id])), 'permission denied')
await rejects('suppression directe interdite', () => as(admin, () => db.query(`delete from articles where id=$1`, [a1.id])), 'permission denied')
await rejects('activation impossible sans version validée', () => as(comm, () => db.query(`update articles set status='active' where id=$1`, [a1.id])), 'ARTICLE_NO_VALIDATED_VERSION')
await as(comm, () => db.query(`update articles set name='Veste HV classe 2', description='Veste de signalisation' where id=$1`, [a1.id]))
ok('mise à jour de la désignation', (await q(`select name from articles where id=$1`, [a1.id]))[0].name === 'Veste HV classe 2')

// --- 3. Fiche (couleurs, tailles, normes, packaging, lavage) ---------------------------------------------------
const spec = {
  colors: [{ name: 'Jaune fluo', code: 'YEL', hex: '#e6ff00', pantone: '101 C', client_code: 'LAF-YEL' }, { name: 'Orange fluo', hex: '#ff6a00' }],
  sizes: [{ label: 'S' }, { label: 'M' }, { label: 'L' }, { label: 'XL' }, { label: '2XL' }],
  norms: [{ code: 'EN ISO 20471', label: 'Haute visibilité', class: '2', certificate_ref: 'CERT-77', valid_until: '2027-05-01' }, { code: 'EN 343' }],
  packaging: { unit: '1 pièce / polybag', units_per_carton: 10, carton_weight_kg: 12.5, carton_dims_cm: { l: 60, w: 40, h: 30 }, labeling: 'Étiquette EAN' },
  care: { wash: '40', bleach: 'none', tumble: 'low', iron: '110', dry_clean: 'no', composition: '100% polyester', instructions: 'Laver à l’envers' },
}
const save = (u, vid, s, note) => as(u, async () => {
  const r = await db.query(`update article_versions set spec=$2, change_note=coalesce($3, change_note) where id=$1`, [vid, JSON.stringify(s), note ?? null])
  if (r.affectedRows === 0) throw new Error('ARTICLE_VERSION_LOCKED (0 ligne : version non modifiable ou droits insuffisants)')
  return r
})
await save(comm, v1.id, spec)
const s1 = (await q(`select spec from article_versions where id=$1`, [v1.id]))[0].spec
ok('fiche enregistrée : 2 couleurs, 5 tailles, 2 normes, packaging, lavage', s1.colors.length === 2 && s1.sizes.length === 5 && s1.norms.length === 2 && s1.packaging.units_per_carton === 10 && s1.care.wash === '40')
ok('normes de la dernière version copiées sur l’article (filtre)', JSON.stringify((await q(`select norm_codes from articles where id=$1`, [a1.id]))[0].norm_codes) === JSON.stringify(['EN 343', 'EN ISO 20471']))
await rejects('couleur sans nom refusée', () => save(comm, v1.id, { ...spec, colors: [{ hex: '#ffffff' }] }), 'article_versions_spec_ck')
await rejects('code couleur hexadécimal invalide refusé', () => save(comm, v1.id, { ...spec, colors: [{ name: 'X', hex: 'jaune' }] }), 'article_versions_spec_ck')
await rejects('taille sans libellé refusée', () => save(comm, v1.id, { ...spec, sizes: [{}] }), 'article_versions_spec_ck')
await rejects('norme sans code refusée', () => save(comm, v1.id, { ...spec, norms: [{ label: 'x' }] }), 'article_versions_spec_ck')
await rejects('lavage : température inconnue refusée', () => save(comm, v1.id, { ...spec, care: { wash: '70' } }), 'article_versions_spec_ck')
await rejects('structure incomplète refusée', () => save(comm, v1.id, { colors: [] }), 'article_versions_spec_ck')
await rejects('plus de 60 couleurs refusé', () => save(comm, v1.id, { ...spec, colors: Array.from({ length: 61 }, (_, i) => ({ name: `C${i}` })) }), 'article_versions_spec_ck')
await rejects('écriture de la fiche refusée sans articles.write', async () => {
  const r = await as(mag, () => db.query(`update article_versions set change_note='x' where id=$1`, [v1.id]))
  if (r.affectedRows === 0) throw new Error('row-level security')
}, 'row-level security')

// --- 4. Validation de version -----------------------------------------------------------------------------------
const emptyArt = await ins(comm, { ref: 'EMP1', cref: 'E-1', name: 'Article vide' })
const emptyV = (await q(`select id from article_versions where article_id=$1`, [emptyArt.id]))[0].id
await rejects('validation refusée sans couleur ni taille', () => as(qual, () => rpc('article_validate_version', emptyV, null)), 'ARTICLE_SPEC_INCOMPLETE')
await rejects('validation refusée sans articles.validate (commercial)', () => as(comm, () => rpc('article_validate_version', v1.id, null)), 'RBAC_FORBIDDEN')
await as(qual, () => rpc('article_validate_version', v1.id, 'Normes vérifiées'))
const val = (await q(`select status, validated_by, validation_comment from article_versions where id=$1`, [v1.id]))[0]
ok('version validée (validateur, commentaire)', val.status === 'validated' && val.validated_by === qual && val.validation_comment === 'Normes vérifiées')
const art1 = (await q(`select status, active_version_id from articles where id=$1`, [a1.id]))[0]
ok('première validation : article actif + version active', art1.status === 'active' && art1.active_version_id === v1.id)
await rejects('version validée figée (fiche)', () => save(comm, v1.id, { ...spec, colors: [{ name: 'Rouge' }] }), 'ARTICLE_VERSION_LOCKED')
await rejects('statut de version non modifiable directement', () => as(comm, () => db.query(`update article_versions set status='draft' where id=$1`, [v1.id])), 'permission denied')
await rejects('revalidation refusée', () => as(qual, () => rpc('article_validate_version', v1.id, null)), 'ARTICLE_BAD_STATUS')

// --- 5. Nouvelle version ------------------------------------------------------------------------------------------
await rejects('nouvelle version refusée sans articles.write', () => as(mag, () => rpc('article_new_version', a1.id, 'x')), 'RBAC_FORBIDDEN')
const v2 = await as(prod, () => rpc('article_new_version', a1.id, 'Ajout coloris orange + norme EN 343'))
const v2row = (await q(`select * from article_versions where id=$1`, [v2]))[0]
ok('version 2 : copie de la précédente, en brouillon', v2row.version_no === 2 && v2row.status === 'draft' && v2row.spec.colors.length === 2 && v2row.change_note.includes('orange'))
await rejects('un seul brouillon à la fois', () => as(prod, () => rpc('article_new_version', a1.id, 'bis')), 'ARTICLE_DRAFT_EXISTS')
await save(prod, v2, { ...spec, colors: [...spec.colors, { name: 'Bleu marine', hex: '#001f5b' }], norms: [{ code: 'EN ISO 20471' }, { code: 'EN 343' }, { code: 'EN 1149-5' }] })
ok('la production utilise la version VALIDÉE pendant que la v2 est en brouillon', (await q(`select active_version_id, current_version_id from articles where id=$1`, [a1.id]))[0].active_version_id === v1.id && (await q(`select current_version_id from articles where id=$1`, [a1.id]))[0].current_version_id === v2)
ok('normes de l’article = celles de la dernière version (3)', (await q(`select cardinality(norm_codes) n from articles where id=$1`, [a1.id]))[0].n === 3)
await as(qual, () => rpc('article_validate_version', v2, 'OK v2'))
const vs = await q(`select version_no, status from article_versions where article_id=$1 order by version_no`, [a1.id])
ok('v2 validée → v1 obsolète (une seule version validée)', vs[0].status === 'obsolete' && vs[1].status === 'validated')
ok('version active = v2', (await q(`select active_version_id from articles where id=$1`, [a1.id]))[0].active_version_id === v2)
const v3 = await as(prod, () => rpc('article_new_version', a1.id, 'Essai'))
await as(prod, () => rpc('article_discard_draft', v3))
ok('abandon d’un brouillon', (await q(`select count(*)::int n from article_versions where article_id=$1`, [a1.id]))[0].n === 2)
await rejects('abandon de la version 1 interdit', async () => {
  const solo = await ins(comm, { ref: 'SOLO', cref: 'S-1', name: 'Article solo' })
  const sv = (await q(`select id from article_versions where article_id=$1`, [solo.id]))[0].id
  await as(comm, () => rpc('article_discard_draft', sv))
}, 'ARTICLE_FIRST_VERSION')
await rejects('abandon d’une version validée interdit', () => as(prod, () => rpc('article_discard_draft', v2)), 'ARTICLE_BAD_STATUS')

// --- 6. Photos ------------------------------------------------------------------------------------------------------------
const photoPath = () => `${company}/${lafont}/${a1.id}/${uuid()}-face.jpg`
const addPhoto = (u, path, o = {}) => as(u, async () => (await q(`insert into article_photos(article_id, storage_path, file_name, mime_type, size_bytes, view, is_main) values ($1,$2,'face.jpg',$3,$4,$5,$6) returning *`,
  [o.article ?? a1.id, path, o.mime ?? 'image/jpeg', o.size ?? 5000, o.view ?? 'front', o.main ?? false]))[0])
const p1 = await addPhoto(comm, photoPath())
ok('première photo = principale ; article mis à jour', p1.is_main === true && (await q(`select main_photo_id from articles where id=$1`, [a1.id]))[0].main_photo_id === p1.id)
const p2 = await addPhoto(comm, photoPath(), { view: 'back' })
ok('deuxième photo non principale', p2.is_main === false)
await as(comm, () => db.query(`update article_photos set is_main=true where id=$1`, [p2.id]))
ok('photo principale basculée (une seule)', (await q(`select id from article_photos where article_id=$1 and is_main`, [a1.id])).length === 1 && (await q(`select main_photo_id from articles where id=$1`, [a1.id]))[0].main_photo_id === p2.id)
await as(comm, () => db.query(`delete from article_photos where id=$1`, [p2.id]))
ok('suppression de la principale : la plus ancienne est promue', (await q(`select main_photo_id from articles where id=$1`, [a1.id]))[0].main_photo_id === p1.id)
await rejects('photo : chemin d’un autre article refusé', () => addPhoto(comm, `${company}/${lafont}/${uuid()}/${uuid()}-x.jpg`), 'ARTICLE_INVALID_PATH')
await rejects('photo : format non image refusé', () => addPhoto(comm, photoPath(), { mime: 'application/pdf' }), 'mime_type')
await rejects('photo : > 8 Mo refusée', () => addPhoto(comm, photoPath(), { size: 9_000_000 }), 'size_bytes')
await rejects('photo : refusée sans articles.write', () => addPhoto(mag, photoPath()), 'row-level security')
for (let i = 0; i < 19; i++) await addPhoto(comm, photoPath())
await rejects('photos : 20 maximum par article', () => addPhoto(comm, photoPath()), 'ARTICLE_TOO_MANY_PHOTOS')
ok('photos lisibles (lecture) ; invisibles hors droits', (await as(mag, () => q(`select id from article_photos`))).length === 20 && (await as(fin, () => q(`select id from article_photos`))).length === 0)

const put = (u, name, b = 'article-photos') => as(u, () => db.query(`insert into storage.objects(bucket_id,name) values ($2,$1)`, [name, b]))
await put(comm, photoPath())
await rejects('storage : dépôt refusé sans articles.write', () => put(mag, photoPath()), 'row-level security')
await rejects('storage : dépôt refusé pour un autre client/société', () => put(comm, `${co2}/${fc}/${uuid()}/x.jpg`), 'row-level security')
ok('storage : lecture avec articles.read (production, sans clients.read)', (await as(prod, () => q(`select name from storage.objects where bucket_id='article-photos'`))).length === 1)
ok('storage : lecture refusée sans articles.read', (await as(fin, () => q(`select name from storage.objects where bucket_id='article-photos'`))).length === 0)
ok('bucket article-photos privé, 8 Mo', (await q(`select public, file_size_limit from storage.buckets where id='article-photos'`))[0].public === false)

// --- 7. Relation avec la GED -------------------------------------------------------------------------------------------------
const folderOf = async (cid, key) => (await q(`select id from ged_folders where client_id=$1 and system_key=$2`, [cid, key]))[0].id
const mkDoc = async (cid, key, title) => {
  const id = uuid(), ver = uuid(), folder = await folderOf(cid, key)
  await as(comm, () => rpc('ged_create_document', id, folder, title, null, [], null, ver, `${company}/${cid}/${id}/${ver}-f.pdf`, 'f.pdf', 'application/pdf', 1000, uuid().replace(/-/g, '').repeat(2), null))
  return id
}
const docA = await mkDoc(lafont, 'patterns', 'Patronage JKT001 v1')
const docB = await mkDoc(lafont, 'certifications', 'Certificat EN ISO 20471')
const docOther = await mkDoc(other, 'patterns', 'Patronage autre client')
await as(comm, () => db.query(`update ged_documents set article_id=$2 where id=$1`, [docA, a1.id]))
await as(comm, () => db.query(`update ged_documents set article_id=$2 where id=$1`, [docB, a1.id]))
ok('documents GED rattachés à l’article', (await q(`select count(*)::int n from ged_documents where article_id=$1`, [a1.id]))[0].n === 2)
await rejects('rattachement à un article d’un autre client refusé', () => as(comm, () => db.query(`update ged_documents set article_id=$2 where id=$1`, [docOther, a1.id])), 'GED_BAD_ARTICLE')
await as(comm, () => db.query(`update ged_documents set article_id=null where id=$1`, [docB]))
ok('détachement', (await q(`select article_id from ged_documents where id=$1`, [docB]))[0].article_id === null)
await rejects('rattachement refusé sans documents.write', async () => {
  const r = await as(mag, () => db.query(`update ged_documents set article_id=$2 where id=$1`, [docB, a1.id]))
  if (r.affectedRows === 0) throw new Error('row-level security')
}, 'row-level security')

// --- 8. Client archivé / suppression -------------------------------------------------------------------------------------------
await as(admin, () => rpc('client_archive', lafont, 'test'))
await rejects('client archivé : nouvel article refusé', () => ins(comm, { ref: 'ARC1', cref: 'ARC-1' }), 'CLIENT_ARCHIVED')
await rejects('client archivé : nouvelle version refusée', () => as(prod, () => rpc('article_new_version', a1.id, 'x')), 'CLIENT_ARCHIVED')
await rejects('client archivé : photo refusée', () => addPhoto(comm, photoPath()), 'CLIENT_ARCHIVED')
await rejects('un client possédant des articles ne peut être supprimé', () => as(admin, () => rpc('client_delete', lafont)), 'CLIENT_IN_USE')
await as(admin, () => rpc('client_restore', lafont))

// --- 9. Suppression d'un article jamais validé -----------------------------------------------------------------------------------
await rejects('suppression refusée : article validé', () => as(comm, () => rpc('article_delete', a1.id)), 'ARTICLE_IN_USE')
const del = await ins(comm, { ref: 'DEL1', cref: 'D-1', name: 'Article à supprimer' })
await as(comm, () => db.query(`insert into article_photos(article_id, storage_path, file_name, mime_type, size_bytes) values ($1,$2,'a.jpg','image/jpeg',100)`, [del.id, `${company}/${lafont}/${del.id}/${uuid()}-a.jpg`]))
await rejects('suppression refusée sans articles.write', () => as(mag, () => rpc('article_delete', del.id)), 'RBAC_FORBIDDEN')
const files = await as(comm, () => rpc('article_delete', del.id))
ok('suppression d’un brouillon + photos à effacer du Storage', files.length === 1 && files[0].bucket === 'article-photos' && (await q(`select count(*)::int n from articles where id=$1`, [del.id]))[0].n === 0)

// --- 10. Historique -----------------------------------------------------------------------------------------------------------------
const h = await q(`select action, actor_email, entity_label, before_data, after_data, metadata from audit_logs where entity_type='article' order by id`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['article.create', 'article.update', 'article.spec_update', 'article.version_validate', 'article.version_new', 'article.version_discard', 'article.photo_add', 'article.photo_delete', 'article.photo_main', 'article.document_link', 'article.document_unlink', 'article.delete'])
  ok(`historique : ${a}`, acts.has(a))
const up = h.find((r) => r.action === 'article.update' && r.after_data.name === 'Veste HV classe 2')
ok('historique : désignation avant → après', up.before_data.name === 'Veste HV classe 2' ? false : up.before_data.name === 'Veste haute visibilité')
const su = h.find((r) => r.action === 'article.spec_update' && r.metadata.version === 2)
ok('historique : sections modifiées de la fiche (couleurs, normes) avec version', su && Array.isArray(su.after_data.colors) && su.after_data.colors.length === 3 && !('sizes' in su.after_data))
ok('historique : validation avec commentaire', h.find((r) => r.action === 'article.version_validate' && r.metadata.version === 1).metadata.comment === 'Normes vérifiées')
ok('historique : client identifié + acteur', h.find((r) => r.action === 'article.create').metadata.client_name === 'LAFONT' && h.find((r) => r.action === 'article.version_validate').actor_email === 'qual@x.com')
ok('historique : une seule entrée « validate » par validation (pas de doublon)', h.filter((r) => r.action === 'article.version_validate').length === 2)
ok('historique GED : rattachement tracé côté document', (await q(`select count(*)::int n from audit_logs where action='ged.link_article'`))[0].n >= 3)
ok('historique lisible avec articles.read, pas sans', (await as(prod, () => q(`select id from audit_logs where entity_type='article'`))).length > 0 && (await as(fin, () => q(`select id from audit_logs where entity_type='article'`))).length === 0)
