import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0015_variants.sql', '0039_units_variants.sql', '0068_collections_dossiers_approval.sql'])
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
const qual = await mkUser('qual@x.com', 'qualite')
const dir = await mkUser('dir@x.com', 'direction')
const prod = await mkUser('prod@x.com', 'production')
const nobody = await mkUser('nobody@x.com', null)

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
const has = async (c, ...codes) => { const p = await perms(c); return codes.every((x) => p.includes(x)) }
ok('droits : admin tout ; commercial et production écrivent ; qualité valide ; direction lit', (await has('admin', 'products.read', 'products.write', 'products.validate', 'products.archive')) && (await has('commercial', 'products.write')) && (await has('production', 'products.write', 'products.archive')) && (await has('qualite', 'products.validate')) && (await has('direction', 'products.read')) && !(await has('direction', 'products.write')))
ok('commercial ne valide ni n’archive', !(await has('commercial', 'products.validate')) && !(await has('commercial', 'products.archive')))

const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const other = (await as(comm, () => q(`insert into clients(name,country) values ('Bragard','FR') returning id`)))[0].id
const mkProduct = (u, o = {}) => as(u, async () => (await q(`insert into product_master(client_id, name, family, description) values ($1,$2,$3,$4) returning *`, [o.client ?? lafont, o.name ?? 'Veste HV classe 2', o.family ?? 'jacket', o.desc ?? null]))[0])
const spec = (extra = {}) => ({
  tech: { composition: '100 % polyester', fabric: 'Oxford 240 g', weight_gsm: 240, season: 'Permanent' },
  colors: [{ name: 'Jaune HV', hex: '#e6e600' }, { name: 'Orange HV', hex: '#ff6600' }],
  sizes: [{ label: 'M' }, { label: 'L' }],
  variants: [{ sku: 'PRD-0001-JAU-M', color: 'Jaune HV', size: 'M', active: true }, { sku: 'PRD-0001-JAU-L', color: 'Jaune HV', size: 'L', active: true }],
  measurements: [{ point: 'Tour de poitrine', tolerance: 1, values: { M: 112, L: 118 } }],
  care: { wash: '40', tumble: 'low' }, packaging: { units_per_carton: 20 }, ...extra,
})
const saveSpec = (u, vid, s, note = null) => as(u, () => db.query(`update product_versions set spec=$2::jsonb, change_note=$3 where id=$1`, [vid, JSON.stringify(s), note]))

// --- 1. Création -------------------------------------------------------------------------------------------------------------------------
const p1 = await mkProduct(comm, { desc: 'Veste haute visibilité' })
ok('produit créé : code PRD-0001, brouillon, société déduite', p1.code === 'PRD-0001' && p1.status === 'draft' && p1.company_id === company && p1.created_by === comm)
const v1 = (await q(`select * from product_versions where product_id=$1`, [p1.id]))[0]
ok('version 1 (brouillon) créée automatiquement, suivie par le produit', v1.version_no === 1 && v1.status === 'draft' && (await q(`select current_version_id from product_master where id=$1`, [p1.id]))[0].current_version_id === v1.id)
const p2 = await mkProduct(comm, { name: 'Pantalon HV', family: 'trousers' })
ok('numérotation séquentielle (PRD-0002)', p2.code === 'PRD-0002')
await rejects('création refusée sans droit d’écriture', () => as(dir, () => db.query(`insert into product_master(client_id,name) values ($1,'X1')`, [lafont])), 'row-level security')
await rejects('code immuable', () => as(comm, () => db.query(`update product_master set code='PRD-9999' where id=$1`, [p1.id])), 'permission denied')
await rejects('statut non modifiable à la main', () => as(comm, () => db.query(`update product_master set status='active' where id=$1`, [p1.id])), 'permission denied')

// --- 2. Fiche technique de la version 1 ------------------------------------------------------------------------------------------------------
await saveSpec(comm, v1.id, spec(), 'Première fiche')
ok('fiche enregistrée (tech, couleurs, tailles, variantes, mesures, entretien)', (await q(`select spec from product_versions where id=$1`, [v1.id]))[0].spec.tech.fabric === 'Oxford 240 g')
await rejects('SKU en double refusé', () => saveSpec(comm, v1.id, spec({ variants: [{ sku: 'A1' }, { sku: 'a1' }] })), 'product_versions_spec_ck')
await rejects('couleur en double refusée', () => saveSpec(comm, v1.id, spec({ colors: [{ name: 'Jaune' }, { name: 'jaune' }] })), 'product_versions_spec_ck')
await rejects('mesure non numérique refusée', () => saveSpec(comm, v1.id, spec({ measurements: [{ point: 'Tour', values: { M: 'x' } }] })), 'product_versions_spec_ck')
await rejects('lavage invalide refusé', () => saveSpec(comm, v1.id, spec({ care: { wash: '99' } })), 'product_versions_spec_ck')
await rejects('poids négatif refusé', () => saveSpec(comm, v1.id, spec({ tech: { weight_gsm: -3 } })), 'product_versions_spec_ck')

// --- 3. Validation ---------------------------------------------------------------------------------------------------------------------------
await rejects('validation réservée à products.validate', () => as(comm, () => rpc('product_validate_version', v1.id)), 'RBAC_FORBIDDEN')
const v1p2 = (await q(`select id from product_versions where product_id=$1`, [p2.id]))[0].id
await rejects('demande de revue impossible sans couleur ni taille', () => as(comm, () => rpc('product_version_submit_review', v1p2)), 'PRODUCT_SPEC_INCOMPLETE')
await rejects('validation directe depuis le brouillon refusée (passage par la revue)', () => as(qual, () => rpc('product_validate_version', v1.id)), 'PRODUCT_BAD_STATUS')
await as(comm, () => rpc('product_version_submit_review', v1.id, 'Prêt pour revue'))
await rejects('approbation sans preuve visuelle refusée (PRODUCT_EVIDENCE_REQUIRED)', () => as(qual, () => rpc('product_validate_version', v1.id, 'Conforme au prototype')), 'PRODUCT_EVIDENCE_REQUIRED')

// --- 4. Photos ---------------------------------------------------------------------------------------------------------------------------------
const photo = (u, pid, name, o = {}) => as(u, () => db.query(`insert into product_photos(product_id, storage_path, file_name, mime_type, size_bytes, view, color, is_main) values ($1,$2,$3,'image/jpeg',2000,$4,$5,false) returning id`,
  [pid, o.path ?? `${company}/${lafont}/${pid}/${uuid()}-${name}`, name, o.view ?? 'front', o.color ?? null]))
const ph1 = (await photo(comm, p1.id, 'face.jpg', { color: 'Jaune HV' })).rows[0].id
const ph2 = (await photo(comm, p1.id, 'dos.jpg', { view: 'back' })).rows[0].id
ok('première photo = principale, suivie par le produit', (await q(`select is_main from product_photos where id=$1`, [ph1]))[0].is_main && (await q(`select main_photo_id from product_master where id=$1`, [p1.id]))[0].main_photo_id === ph1)
await as(comm, () => db.query(`update product_photos set is_main=true where id=$1`, [ph2]))
ok('changement de photo principale (une seule principale)', (await q(`select count(*)::int n from product_photos where product_id=$1 and is_main`, [p1.id]))[0].n === 1 && (await q(`select main_photo_id from product_master where id=$1`, [p1.id]))[0].main_photo_id === ph2)
await rejects('chemin de photo hors du produit refusé', () => photo(comm, p1.id, 'x.jpg', { path: `${company}/${lafont}/${uuid()}/x.jpg` }), 'PRODUCT_INVALID_PATH')
await as(comm, () => db.query(`delete from product_photos where id=$1`, [ph2]))
ok('suppression de la principale : promotion d’une autre photo', (await q(`select main_photo_id from product_master where id=$1`, [p1.id]))[0].main_photo_id === ph1)

// Approbation après les photos : le visuel de preuve existe
await rejects('approbation par le rédacteur refusée (SOD_SELF_APPROVAL)', () => as(comm, () => rpc('product_validate_version', v1.id)), 'RBAC_FORBIDDEN')
await as(qual, () => rpc('product_validate_version', v1.id, 'Conforme au prototype'))
const pa = (await q(`select * from product_master where id=$1`, [p1.id]))[0]
const v1v = (await q(`select * from product_versions where id=$1`, [v1.id]))[0]
ok('validation : version validée, produit actif, version active suivie', v1v.status === 'validated' && v1v.validated_by === qual && pa.status === 'active' && pa.active_version_id === v1.id)
ok('instantané figé à la validation (entête, certifications, documents)', v1v.snapshot.header.name === 'Veste HV classe 2' && Array.isArray(v1v.snapshot.certifications) && v1v.snapshot.certifications.length === 0)
const r0 = await as(comm, () => db.query(`update product_versions set spec=$2::jsonb where id=$1`, [v1.id, JSON.stringify(spec({ tech: { fabric: 'Modifié' } }))]))
ok('version validée figée (aucune ligne modifiable)', r0.affectedRows === 0 && (await q(`select spec from product_versions where id=$1`, [v1.id]))[0].spec.tech.fabric === 'Oxford 240 g')

// --- 5. Documents GED (patronages…) --------------------------------------------------------------------------------------------------------------
const folderOf = async (cid, key) => (await q(`select id from ged_folders where client_id=$1 and system_key=$2`, [cid, key]))[0].id
const mkDoc = async (cid, key, title) => {
  const id = uuid(), ver = uuid(), folder = await folderOf(cid, key)
  await as(comm, () => rpc('ged_create_document', id, folder, title, null, [], null, ver, `${company}/${cid}/${id}/${ver}-f.pdf`, 'f.pdf', 'application/pdf', 1000, uuid().replace(/-/g, '').repeat(2), null))
  return id
}
const docPat = await mkDoc(lafont, 'patterns', 'Patronage HV v1')
const docCert = await mkDoc(lafont, 'certifications', 'Certificat EN ISO 20471')
const docOther = await mkDoc(other, 'patterns', 'Patronage autre client')
await as(comm, () => db.query(`insert into product_documents(product_id, ged_document_id, kind, revision) values ($1,$2,'pattern','Rév. A')`, [p1.id, docPat]))
ok('patronage rattaché au produit (type + révision)', (await q(`select kind, revision from product_documents where product_id=$1`, [p1.id]))[0].kind === 'pattern')
await rejects('même document deux fois refusé', () => as(comm, () => db.query(`insert into product_documents(product_id, ged_document_id) values ($1,$2)`, [p1.id, docPat])), 'product_documents_product_id_ged_document_id_key')
await rejects('document d’un autre client refusé', () => as(comm, () => db.query(`insert into product_documents(product_id, ged_document_id) values ($1,$2)`, [p1.id, docOther])), 'PRODUCT_BAD_DOCUMENT')

// --- 6. Certifications ---------------------------------------------------------------------------------------------------------------------------
const cert1 = (await as(comm, () => q(`insert into product_certifications(product_id, standard_code, label, class_level, certificate_no, issuer, issued_on, valid_until, ged_document_id) values ($1,'EN ISO 20471','Haute visibilité','2','CE-2026-118','CTTN','2026-01-10','2031-01-09',$2) returning *`, [p1.id, docCert])))[0]
ok('certification enregistrée (norme, classe, n°, organisme, validité, justificatif GED)', cert1.class_level === '2' && cert1.ged_document_id === docCert && cert1.status === 'valid')
await rejects('validité antérieure à l’émission refusée', () => as(comm, () => db.query(`insert into product_certifications(product_id, standard_code, issued_on, valid_until) values ($1,'EN 343','2026-05-01','2026-01-01')`, [p1.id])), 'product_cert_dates_ck')
await as(comm, () => db.query(`update product_certifications set class_level='3' where id=$1`, [cert1.id]))

// --- 7. Nouvelle version et comparaison ------------------------------------------------------------------------------------------------------------
const nv = await as(comm, () => rpc('product_new_version', p1.id, 'Ajout coloris orange et certification'))
const v2 = (await q(`select * from product_versions where id=$1`, [nv]))[0]
ok('nouvelle version = copie de la précédente (brouillon v2)', v2.version_no === 2 && v2.status === 'draft' && v2.spec.tech.fabric === 'Oxford 240 g' && v2.spec.variants.length === 2)
await rejects('un seul brouillon à la fois', () => as(comm, () => rpc('product_new_version', p1.id)), 'PRODUCT_DRAFT_EXISTS')
const s2 = spec({
  tech: { composition: '100 % polyester', fabric: 'Oxford 260 g', weight_gsm: 260, season: 'Permanent' },
  colors: [{ name: 'Jaune HV', hex: '#e6e600' }, { name: 'Marine' }],
  variants: [{ sku: 'PRD-0001-JAU-M', color: 'Jaune HV', size: 'M', active: true }, { sku: 'PRD-0001-MAR-M', color: 'Marine', size: 'M', active: true }],
  measurements: [{ point: 'Tour de poitrine', tolerance: 1, values: { M: 114, L: 118 } }, { point: 'Longueur dos', tolerance: 2, values: { M: 72 } }],
})
await saveSpec(comm, v2.id, s2, 'Tissu 260 g, marine remplace orange')
const cdraft = await as(comm, () => rpc('product_compare_versions', v1.id, v2.id))
const ch = (path) => cdraft.changes.find((c) => c.path === path)
ok('comparaison v1 ↔ v2 (brouillon) : champ modifié (grammage 240 → 260)', ch('tech.weight_gsm')?.change === 'changed' && Number(ch('tech.weight_gsm').a) === 240 && Number(ch('tech.weight_gsm').b) === 260)
ok('comparaison : couleur ajoutée (Marine) et retirée (Orange HV)', ch('colors[Marine]')?.change === 'added' && ch('colors[Orange HV]')?.change === 'removed')
ok('comparaison : variante ajoutée / retirée', ch('variants[PRD-0001-MAR-M]')?.change === 'added' && ch('variants[PRD-0001-JAU-L]')?.change === 'removed')
ok('comparaison : mesure modifiée, point de mesure ajouté', Number(ch('measurements[Tour de poitrine].values.M')?.b) === 114 && ch('measurements[Longueur dos]')?.change === 'added')
ok('comparaison : pas de bruit (les champs d’un élément ajouté ne sont pas listés, les champs inchangés non plus)', !ch('colors[Marine].hex') && !ch('colors[Jaune HV].hex') && !ch('tech.season') && cdraft.changes.every((c) => c.path !== 'measurements[Longueur dos].values.M'))
ok('comparaison : le brouillon voit la certification ajoutée depuis la v1 (instantané en direct)', ch('certifications[EN ISO 20471 · CE-2026-118]')?.change === 'added' && ch('documents[pattern : Patronage HV v1]')?.change === 'added')
ok('comparaison : résumé', cdraft.summary.added >= 4 && cdraft.summary.removed >= 2 && cdraft.summary.changed >= 2 && cdraft.a.version_no === 1 && cdraft.b.status === 'draft')
await rejects('comparaison de versions de produits différents refusée', () => as(comm, () => rpc('product_compare_versions', v1.id, v1p2)), 'PRODUCT_COMPARE_MISMATCH')
await rejects('comparaison refusée sans droit de lecture', () => as(nobody, () => rpc('product_compare_versions', v1.id, v2.id)), 'RBAC_FORBIDDEN')

await as(comm, () => rpc('product_version_submit_review', v2.id, 'Essai tissu fait'))
await as(qual, () => rpc('product_validate_version', v2.id, 'Validée après essai tissu'))
const vs = (await q(`select version_no, status from product_versions where product_id=$1 order by version_no`, [p1.id])).map((r) => `${r.version_no}:${r.status}`).join(',')
ok('validation v2 : v1 devient obsolète, v2 active', vs === '1:obsolete,2:validated' && (await q(`select active_version_id from product_master where id=$1`, [p1.id]))[0].active_version_id === v2.id)
const cfrozen = await as(comm, () => rpc('product_compare_versions', v1.id, v2.id))
ok('comparaison de deux versions figées : la v1 (instantané sans certification) diffère toujours de la v2', cfrozen.changes.some((c) => c.path === 'certifications[EN ISO 20471 · CE-2026-118]' && c.change === 'added'))
await as(comm, () => db.query(`update product_certifications set valid_until='2030-12-31' where id=$1`, [cert1.id]))
const cfrozen2 = await as(comm, () => rpc('product_compare_versions', v1.id, v2.id))
ok('l’instantané est figé : modifier la certification après validation ne change pas la v2', JSON.stringify(cfrozen2.changes.filter((c) => c.section === 'certifications')) === JSON.stringify(cfrozen.changes.filter((c) => c.section === 'certifications')))
const nv3 = await as(comm, () => rpc('product_new_version', p1.id, 'Essai'))
await rejects('la première version ne peut pas être abandonnée', () => as(comm, () => rpc('product_discard_draft', v1.id)), 'PRODUCT_BAD_STATUS')
await as(comm, () => rpc('product_discard_draft', nv3))
ok('brouillon v3 abandonné', (await q(`select count(*)::int n from product_versions where product_id=$1`, [p1.id]))[0].n === 2)

// --- 8. Lien article ----------------------------------------------------------------------------------------------------------------------
const art = (await as(comm, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-HV-1','Veste HV','jacket') returning id`, [lafont])))[0].id
const artO = (await as(comm, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'BRG-1','Veste Bragard','jacket') returning id`, [other])))[0].id
await as(comm, () => db.query(`update product_master set article_id=$2 where id=$1`, [p1.id, art]))
ok('article du même client lié (nomenclature accessible via l’article)', (await q(`select article_id from product_master where id=$1`, [p1.id]))[0].article_id === art)
await rejects('article d’un autre client refusé', () => as(comm, () => db.query(`update product_master set article_id=$2 where id=$1`, [p2.id, artO])), 'PRODUCT_BAD_ARTICLE')
await rejects('un article ne se lie qu’à un seul produit', () => as(comm, () => db.query(`update product_master set article_id=$2 where id=$1`, [p2.id, art])), 'product_master_article_uq')
await as(comm, () => db.query(`update product_master set name='Veste HV classe 2 — modèle 2027', description='Mise à jour' where id=$1`, [p1.id]))

// --- 9. Duplication ----------------------------------------------------------------------------------------------------------------------------
const dupId = await as(comm, () => rpc('product_duplicate', p1.id, null))
const dup = (await q(`select * from product_master where id=$1`, [dupId]))[0]
const dv = (await q(`select * from product_versions where product_id=$1`, [dupId]))
ok('duplication : nouveau code, nom « Copie de … », brouillon, trace de la source', dup.code === 'PRD-0003' && dup.name.startsWith('Copie de ') && dup.status === 'draft' && dup.duplicated_from === p1.id)
ok('duplication : v1 brouillon = fiche de la dernière version, SKU re-préfixés', dv.length === 1 && dv[0].version_no === 1 && dv[0].spec.tech.fabric === 'Oxford 260 g' && dv[0].spec.variants.every((v) => v.sku.startsWith('PRD-0003-')) && dv[0].spec.variants.length === 2)
ok('duplication : ni photo, ni document, ni certification, ni article', (await q(`select (select count(*) from product_photos where product_id=$1)::int + (select count(*) from product_documents where product_id=$1)::int + (select count(*) from product_certifications where product_id=$1)::int n`, [dupId]))[0].n === 0 && dup.article_id === null)
await rejects('duplication réservée à products.write', () => as(dir, () => rpc('product_duplicate', p1.id)), 'RBAC_FORBIDDEN')

// --- 10. Archivage ------------------------------------------------------------------------------------------------------------------------------
await rejects('archivage réservé à products.archive', () => as(comm, () => rpc('product_archive', p1.id, 'x')), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('product_archive', p1.id, 'Fin de série'))
const arch = (await q(`select status, archived_at, archive_reason from product_master where id=$1`, [p1.id]))[0]
ok('produit archivé (date, motif)', arch.status === 'archived' && arch.archived_at && arch.archive_reason === 'Fin de série')
await rejects('archivé : modification refusée', () => as(comm, () => db.query(`update product_master set name='Autre nom' where id=$1`, [p1.id])), 'PRODUCT_ARCHIVED')
await rejects('archivé : nouvelle version refusée', () => as(comm, () => rpc('product_new_version', p1.id)), 'PRODUCT_ARCHIVED')
await rejects('archivé : photo refusée', () => photo(comm, p1.id, 'z.jpg'), 'PRODUCT_ARCHIVED')
await rejects('archivé : certification refusée', () => as(comm, () => db.query(`insert into product_certifications(product_id, standard_code) values ($1,'EN 343')`, [p1.id])), 'PRODUCT_ARCHIVED')
const rd = await as(comm, () => db.query(`delete from product_certifications where id=$1`, [cert1.id]))
ok('archivé : certification non supprimable', rd.affectedRows === 0)
ok('archivé : lecture toujours possible, version active conservée', (await as(dir, () => q(`select id from product_master where id=$1 and active_version_id is not null`, [p1.id]))).length === 1)
await as(admin, () => rpc('product_restore', p1.id))
ok('restauration : produit de nouveau actif', (await q(`select status, archived_at from product_master where id=$1`, [p1.id]))[0].status === 'active')
await as(comm, () => db.query(`delete from product_certifications where id=$1`, [cert1.id]))
ok('après restauration : certification supprimable', (await q(`select count(*)::int n from product_certifications where product_id=$1`, [p1.id]))[0].n === 0)

// --- 11. Suppression ----------------------------------------------------------------------------------------------------------------------------
await rejects('produit déjà validé : suppression refusée', () => as(comm, () => rpc('product_delete', p1.id)), 'PRODUCT_IN_USE')
const ph3 = (await photo(comm, dupId, 'copie.jpg')).rows[0].id
const files = await as(comm, () => rpc('product_delete', dupId))
ok('produit jamais validé : supprimé, photos à effacer du Storage renvoyées', files.length === 1 && files[0].bucket === 'product-photos' && ph3 && (await q(`select id from product_master where id=$1`, [dupId])).length === 0)

// --- 12. GED : un document lié disparaît avec sa purge --------------------------------------------------------------------------------------------
const gdoc = await mkDoc(lafont, 'patterns', 'Marqueur HV')
await as(comm, () => db.query(`insert into product_documents(product_id, ged_document_id, kind) values ($1,$2,'marker')`, [p2.id, gdoc]))
await db.query(`delete from ged_documents where id=$1`, [gdoc])
ok('purge d’un document GED : le lien produit disparaît sans erreur', (await q(`select count(*)::int n from product_documents where product_id=$1`, [p2.id]))[0].n === 0)

// --- 13. Historique (timeline), isolation ------------------------------------------------------------------------------------------------------
const acts = new Set((await q(`select action from audit_logs where entity_type='product'`)).map((r) => r.action))
for (const a of ['product.create', 'product.update', 'product.spec_update', 'product.version_new', 'product.version_validate', 'product.version_discard', 'product.photo_add', 'product.photo_main', 'product.photo_delete',
  'product.document_link', 'product.cert_add', 'product.cert_update', 'product.cert_delete', 'product.duplicate', 'product.duplicated_from', 'product.archive', 'product.restore', 'product.delete'])
  ok(`historique : ${a}`, acts.has(a))
const tl = await q(`select action, before_data, after_data from audit_logs where entity_type='product' and entity_id=$1 order by created_at, id`, [p1.id])
const upd = tl.find((r) => r.action === 'product.update' && r.after_data?.name)
ok('historique : avant/après de l’entête (nom)', upd && upd.before_data.name === 'Veste HV classe 2' && upd.after_data.name.includes('2027'))
const ce = (await q(`select before_data, after_data from audit_logs where action='product.cert_update' order by created_at limit 1`))[0]
ok('historique : avant/après d’une certification (classe 2 → 3)', ce.before_data.class_level === '2' && ce.after_data.class_level === '3')
ok('historique : la duplication n’ajoute pas de « fiche modifiée » parasite sur la copie', (await q(`select count(*)::int n from audit_logs where action='product.spec_update' and entity_id=$1`, [dupId]))[0].n === 0)
ok('historique lisible avec products.read, pas sans', (await as(dir, () => q(`select id from audit_logs where entity_type='product'`))).length > 0 && (await as(nobody, () => q(`select id from audit_logs where entity_type='product'`))).length === 0)
await rejects('historique append-only (suppression refusée)', () => as(admin, () => db.query(`delete from audit_logs where entity_type='product'`)), 'permission denied')
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const cli2 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CLI-9','Étranger','FR') returning id`, [co2]))[0].id
await db.query(`insert into product_master(company_id, client_id, code, name) values ($1,$2,'PRD-9001','Étranger')`, [co2, cli2])
ok('isolation entre sociétés', (await as(admin, () => q(`select id from product_master where code='PRD-9001'`))).length === 0)
ok('sans droit : aucune lecture des produits ni des versions', (await as(nobody, () => q(`select id from product_master`))).length === 0 && (await as(nobody, () => q(`select id from product_versions`))).length === 0)

process.exit(process.exitCode ?? 0)
