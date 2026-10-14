// Collections, cycle des dossiers techniques, approbation distincte, preuves, cohérence SKU, ancien dossier accessible — P043 / migration 0068
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
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
const qual2 = await mkUser('qual2@x.com', 'qualite')
const nobody = await mkUser('nobody@x.com', null)

const client = (await q(`insert into clients(company_id, name, country, currency) values ($1,'LAFONT P43','FR','EUR') returning id`, [company]))[0].id
const client2 = (await q(`insert into clients(company_id, name, country, currency) values ($1,'Bragard P43','FR','EUR') returning id`, [company]))[0].id

// Spécification complète : couleur, taille, variante, mesure avec tolérance, entretien, conditionnement
const spec = (sku = 'JAC-MAR-M', extra = {}) => ({
  tech: { composition: 'Coton 100 %', weight_gsm: 240 }, colors: [{ name: 'Marine' }], sizes: [{ label: 'M' }],
  variants: [{ sku, color: 'Marine', size: 'M' }], measurements: [{ point: 'Tour de poitrine', tolerance: '±1 cm', values: { M: 110 } }],
  care: {}, packaging: {}, ...extra,
})
const newProduct = async (u, name, cl = client) => {
  const id = (await as(u, () => q(`insert into product_master(client_id, name, family) values ($1,$2,'jacket') returning id`, [cl, name])))[0].id
  const v = (await q(`select id from product_versions where product_id=$1`, [id]))[0].id
  return { id, v }
}
const setSpec = (u, v, s) => as(u, () => db.query(`update product_versions set spec=$2 where id=$1`, [v, JSON.stringify(s)]))
const addPhoto = async (product) => {
  const cl = (await q(`select client_id, company_id from product_master where id=$1`, [product]))[0]
  await db.query(`insert into product_photos(company_id, client_id, product_id, storage_path, file_name, mime_type, size_bytes)
    values ($1,$2,$3,$4,'face.jpg','image/jpeg',1234)`, [cl.company_id, cl.client_id, product, `${cl.company_id}/${cl.client_id}/${product}/face.jpg`])
}
const versionStatus = async (v) => (await q(`select status from product_versions where id=$1`, [v]))[0].status

// ---------------------------------------------------------------------------
// 1. Collections : rattachement au même client, collection active seulement
// ---------------------------------------------------------------------------
const col = await as(comm, () => rpc('product_collection_create', client, 'Printemps HV', 'SS', 2027))
const colRow = (await q(`select code, status from product_collections where id=$1`, [col]))[0]
ok('collection créée : code COL-…, brouillon', /^COL-\d{4}$/.test(colRow.code) && colRow.status === 'draft')
await rejects('nom trop court refusé (COLLECTION_NAME_REQUIRED)', () => as(comm, () => rpc('product_collection_create', client, 'A', 'SS', 2027)), 'COLLECTION_NAME_REQUIRED')
await rejects('année hors bornes refusée (COLLECTION_YEAR_INVALID)', () => as(comm, () => rpc('product_collection_create', client, 'Hiver', 'AW', 1990)), 'COLLECTION_YEAR_INVALID')
await rejects('doublon de nom pour le même client et la même année refusé', () => as(comm, () => rpc('product_collection_create', client, 'printemps hv', 'SS', 2027)), 'product_collections_name_uq')

const P1 = await newProduct(comm, 'Veste HV P43')
const P2 = await newProduct(qual, 'Veste test P43')
const P3 = await newProduct(qual, 'Veste rejet P43')
await setSpec(comm, P1.v, spec())
await rejects('rattachement à une collection non active refusé (COLLECTION_NOT_ACTIVE)', () => as(comm, () => rpc('product_collection_assign', P1.id, col)), 'COLLECTION_NOT_ACTIVE')
await as(comm, () => rpc('product_collection_set_status', col, 'active'))
const colOther = await as(comm, () => rpc('product_collection_create', client2, 'Été Bragard', 'SS', 2027))
await as(comm, () => rpc('product_collection_set_status', colOther, 'active'))
await rejects('collection d’un autre client refusée (COLLECTION_CLIENT_MISMATCH)', () => as(comm, () => rpc('product_collection_assign', P1.id, colOther)), 'COLLECTION_CLIENT_MISMATCH')
await as(comm, () => rpc('product_collection_assign', P1.id, col))
ok('fiche rattachée à la collection active du même client', (await q(`select collection_id from product_master where id=$1`, [P1.id]))[0].collection_id === col)
await rejects('collection sans droit d’écriture refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('product_collection_create', client, 'Pirate', 'SS', 2027)), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------
// 2. Cycle : brouillon → prototype → revue ; contenu figé hors brouillon ; rejet motivé
// ---------------------------------------------------------------------------
await as(comm, () => rpc('product_version_prototype', P1.v))
ok('prototype : statut « prototype »', (await versionStatus(P1.v)) === 'prototype')
await rejects('contenu figé en prototype (PRODUCT_VERSION_LOCKED)', () => db.query(`update product_versions set spec=$2 where id=$1`, [P1.v, JSON.stringify(spec('AUTRE'))]), 'PRODUCT_VERSION_LOCKED')
await rejects('second passage en prototype refusé (PRODUCT_BAD_STATUS)', () => as(comm, () => rpc('product_version_prototype', P1.v)), 'PRODUCT_BAD_STATUS')
await as(comm, () => rpc('product_version_submit_review', P1.v, 'Prototype conforme, à revoir'))
ok('demande de revue : statut « revue », demandeur tracé', (await versionStatus(P1.v)) === 'review'
  && (await q(`select review_requested_by from product_versions where id=$1`, [P1.v]))[0].review_requested_by === comm)
await rejects('approbation sans droit de validation refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('product_validate_version', P1.v)), 'RBAC_FORBIDDEN')
await rejects('auto-approbation par le demandeur refusée (SOD_SELF_APPROVAL)', () => as(comm, () => rpc('product_validate_version', P1.v)), 'RBAC_FORBIDDEN')
await rejects('approbation sans preuve visuelle refusée (PRODUCT_EVIDENCE_REQUIRED)', () => as(qual2, () => rpc('product_validate_version', P1.v, 'Essai ok')), 'PRODUCT_EVIDENCE_REQUIRED')

// Rejet motivé sur P3, puis retour en brouillon avec retour de revue
await setSpec(qual, P3.v, spec('JAC-REJ-M'))
await as(qual, () => rpc('product_version_submit_review', P3.v))
await rejects('rejet sans motif suffisant refusé (PRODUCT_REVIEW_REASON_REQUIRED)', () => as(qual2, () => rpc('product_version_reject', P3.v, 'ok')), 'PRODUCT_REVIEW_REASON_REQUIRED')
await as(qual2, () => rpc('product_version_reject', P3.v, 'Tolérance des mesures absente'))
const p3 = (await q(`select status, review_feedback from product_versions where id=$1`, [P3.v]))[0]
ok('rejet : retour en brouillon, motif conservé pour le rédacteur', p3.status === 'draft' && p3.review_feedback === 'Tolérance des mesures absente')
await setSpec(qual, P3.v, spec('JAC-REJ-M', { measurements: [{ point: 'Tour de poitrine', tolerance: '±1 cm', values: { M: 110 } }] }))
ok('après rejet : le brouillon redevient modifiable', (await versionStatus(P3.v)) === 'draft')

// ---------------------------------------------------------------------------
// 3. Approbation distincte et cohérence SKU (P2 : catalogue généré depuis la spécification)
// ---------------------------------------------------------------------------
await setSpec(qual, P2.v, spec('JAC-MAR-M'))
await as(admin, () => rpc('variant_sync_from_spec', P2.id))
ok('catalogue généré depuis la spécification : SKU JAC-MAR-M', (await q(`select sku from product_variants where product_id=$1`, [P2.id]))[0].sku === 'JAC-MAR-M')
await as(qual, () => rpc('product_version_submit_review', P2.v))
await addPhoto(P2.id)
await rejects('approbation par le rédacteur et demandeur refusée (SOD_SELF_APPROVAL)', () => as(qual, () => rpc('product_validate_version', P2.v, 'Auto')), 'SOD_SELF_APPROVAL')
await as(qual2, () => rpc('product_version_reject', P2.v, 'Changer le SKU selon la nouvelle codification'))
await setSpec(qual, P2.v, spec('JAC-MAR-M2'))
await as(qual, () => rpc('product_version_submit_review', P2.v))
const chk = await as(admin, () => rpc('product_sku_check', P2.id))
ok('cohérence SKU : catalogue JAC-MAR-M ≠ spécification JAC-MAR-M2 → bloquant', chk.blocking === true && chk.issues.some((i) => i.type === 'sku_differs' && i.catalog_sku === 'JAC-MAR-M' && i.spec_sku === 'JAC-MAR-M2'))
await rejects('approbation refusée tant que les SKU divergent (PRODUCT_SKU_INCOHERENT)', () => as(qual2, () => rpc('product_validate_version', P2.v, 'Essai')), 'PRODUCT_SKU_INCOHERENT')
await rejects('renommage sans motif suffisant refusé (PRODUCT_REVIEW_REASON_REQUIRED)', () => as(qual2, () => rpc('product_sku_map_apply', P2.id, 'JAC-MAR-M', 'JAC-MAR-M2', 'ok')), 'PRODUCT_REVIEW_REASON_REQUIRED')
await rejects('SKU du catalogue non modifiable hors mapping (VARIANT_REF_LOCKED)', () => db.query(`update product_variants set sku='DIRECT-1' where product_id=$1`, [P2.id]), 'VARIANT_REF_LOCKED')
await rejects('renommage vers un SKU absent de la spécification refusé (SKU_NOT_IN_SPEC)', () => as(qual2, () => rpc('product_sku_map_apply', P2.id, 'JAC-MAR-M', 'XYZ-999', 'Renommage test')), 'SKU_NOT_IN_SPEC')
await as(qual2, () => rpc('product_sku_map_apply', P2.id, 'JAC-MAR-M', 'JAC-MAR-M2', 'Référence alignée sur la spécification'))
const sku1 = (await q(`select sku from product_variants where product_id=$1`, [P2.id]))[0].sku
const maps = await q(`select from_sku, to_sku from product_sku_mappings where product_id=$1`, [P2.id])
ok('renommage avec mapping : catalogue JAC-MAR-M2, mapping conservé (JAC-MAR-M → JAC-MAR-M2)', sku1 === 'JAC-MAR-M2' && maps.length === 1 && maps[0].from_sku === 'JAC-MAR-M')
ok('après renommage : aucun SKU bloquant', (await as(admin, () => rpc('product_sku_check', P2.id))).blocking === false)
await as(qual2, () => rpc('product_validate_version', P2.v, 'Conforme : SKU alignés, visuel fourni'))
ok('approbation distincte réussie : version approuvée, produit actif', (await versionStatus(P2.v)) === 'validated'
  && (await q(`select status from product_master where id=$1`, [P2.id]))[0].status === 'active')

// ---------------------------------------------------------------------------
// 5. Ancien dossier accessible : version obsolète lisible, instantané conservé, comparaison possible
// ---------------------------------------------------------------------------
await addPhoto(P1.id)
await as(qual2, () => rpc('product_validate_version', P1.v, 'Approuvée avec visuel'))
const v2 = await as(comm, () => rpc('product_new_version', P1.id, 'Évolution grammage'))
await rejects('nouvelle version refusée tant qu’une revue est ouverte (PRODUCT_DRAFT_EXISTS)', () => as(comm, () => rpc('product_new_version', P1.id, 'Doublon')), 'PRODUCT_DRAFT_EXISTS')
await setSpec(comm, v2, spec('JAC-MAR-M', { tech: { composition: 'Coton 100 %', weight_gsm: 260 } }))
await as(comm, () => rpc('product_version_prototype', v2))
await as(comm, () => rpc('product_version_submit_review', v2, 'Grammage 260 g/m²'))
await as(qual2, () => rpc('product_validate_version', v2, 'Grammage validé'))
const vv = await as(comm, () => q(`select version_no, status, snapshot is not null as has_snapshot from product_versions where product_id=$1 order by version_no`, [P1.id]))
ok('ancien dossier accessible : version 1 obsolète après approbation de la version 2, instantané conservé et lisible', vv.length === 2 && vv[0].version_no === 1 && vv[0].status === 'obsolete' && vv[0].has_snapshot === true)
ok('version 2 approuvée et active', vv[1].status === 'validated' && (await q(`select active_version_id from product_master where id=$1`, [P1.id]))[0].active_version_id === v2)
const cmp = await as(comm, () => rpc('product_compare_versions', P1.v, v2))
ok('comparaison v1 ↔ v2 accessible après approbation', cmp && cmp.changes && cmp.changes.length >= 1)

// ---------------------------------------------------------------------------
// 6. Droits et audit
// ---------------------------------------------------------------------------
await rejects('lecture de la cohérence SKU sans droit refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('product_sku_check', P2.id)), 'RBAC_FORBIDDEN')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : collections, statuts, revues, rejet, approbation et renommage SKU tracés',
  (await aud('product.collection_create')) >= 2 && (await aud('product.collection_assign')) >= 1 && (await aud('product.version_prototype')) >= 1
  && (await aud('product.version_review')) >= 2 && (await aud('product.version_reject')) === 2 && (await aud('product.version_validate')) >= 2
  && (await aud('product.sku_map')) === 1)
