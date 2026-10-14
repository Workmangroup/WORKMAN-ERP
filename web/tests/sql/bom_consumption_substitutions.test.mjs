// Nomenclatures : attributs de ligne, conversions, substitutions, approbation distincte, OF figé au lancement — P044 / migration 0069
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b) => Math.abs(Number(a) - b) < 0.0051

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const admin2 = await mkUser('admin2@x.com', 'admin')
const nobody = await mkUser('nobody@x.com', null)

// Référentiel : client, article, tailles, couleur, composants et prix
const client = (await q(`insert into clients(company_id, name, country, currency) values ($1,'LAFONT P44','FR','EUR') returning id`, [company]))[0].id
const article = (await q(`insert into articles(company_id, client_id, internal_ref, client_ref, name) values ($1,$2,'JKT44','LAF-JKT44','Veste P44') returning id`, [company, client]))[0].id
await db.query(`insert into sizes(company_id, code, label, size_group, sort_order) select $1,'M','M','other',500 where not exists (select 1 from sizes where company_id=$1 and code='M')`, [company])
await db.query(`insert into colors(company_id, code, name) select $1,'MAR','Marine' where not exists (select 1 from colors where company_id=$1 and lower(name)='marine')`, [company])
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P44','fabric','m') returning id`, [company]))[0].id
const doublure = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Doublure P44','fabric','m') returning id`, [company]))[0].id
const tissuB = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu B P44','fabric','m') returning id`, [company]))[0].id
for (const m of [tissu, doublure, tissuB]) await db.query(`insert into bom_material_prices(material_id, company_id, unit_cost) values ($1,$2,10)`, [m, company])
const wc = (await q(`insert into work_centers(company_id, code, name) values ($1,'P44','Atelier P44') returning id`, [company]))[0].id
const mats = { tissu, doublure, tissuB }

// Nomenclature : version 1 (brouillon créé par l'administrateur)
const bom = (await as(admin, () => q(`insert into boms(name, kind, article_id) values ('Veste P44','product',$1) returning id`, [article])))[0].id
const v1 = (await q(`select id from bom_versions where bom_id=$1 and version_no=1`, [bom]))[0].id
const addLine = (u, version, pos, mat, qty, waste = 0) => as(u, () => q(
  `insert into bom_lines(version_id, line_type, material_id, quantity, waste_pct) values ($1,'material',$2,$3,$4) returning id`,
  [version, mat, qty, waste]))
const L1 = (await addLine(admin, v1, 1, tissu, 2, 5))[0].id
const L2 = (await addLine(admin, v1, 2, doublure, 150))[0].id

// 1. Unités : conversion vers l'unité de la matière seulement ; attribut refusé sans conversion
await rejects('conversion vers une autre unité que celle de la matière refusée (BOM_UNIT_TARGET_INVALID)', () => as(admin, () => rpc('bom_unit_conversion_set', doublure, 'cm', 'mm', 0.1)), 'BOM_UNIT_TARGET_INVALID')
await rejects('attribut d’unité sans conversion refusé (BOM_UNIT_CONVERSION_MISSING)', () => as(admin, () => rpc('bom_line_set_attributes', L2, 'cm', null, null)), 'BOM_UNIT_CONVERSION_MISSING')
await as(admin, () => rpc('bom_unit_conversion_set', doublure, 'cm', 'm', 0.01))
await rejects('taille inconnue refusée (BOM_ATTRIBUTE_UNKNOWN)', () => as(admin, () => rpc('bom_line_set_attributes', L2, 'cm', 'ZZ9', null)), 'BOM_ATTRIBUTE_UNKNOWN')
await as(admin, () => rpc('bom_line_set_attributes', L2, 'cm', 'M', 'Marine'))
const attr = (await q(`select unit, size_code, color_name from bom_line_attributes where line_id=$1`, [L2]))[0]
ok('doublure saisie en cm, restreinte à la taille M et au coloris Marine', attr.unit === 'cm' && attr.size_code === 'M' && attr.color_name === 'Marine')

// 2. Substitutions autorisées : motif obligatoire, matière différente, pas de doublon
await rejects('substitution sans motif suffisant refusée (BOM_REASON_REQUIRED)', () => as(admin, () => rpc('bom_line_substitute_add', L1, tissuB, 1, 'ab')), 'BOM_REASON_REQUIRED')
await rejects('substitution par la même matière refusée (BOM_SUBSTITUTE_SAME)', () => as(admin, () => rpc('bom_line_substitute_add', L1, tissu, 1, 'Tissu identique')), 'BOM_SUBSTITUTE_SAME')
const sub = await as(admin, () => rpc('bom_line_substitute_add', L1, tissuB, 1, 'Tissu B équivalent en stock'))
await rejects('substitution en double refusée', () => as(admin, () => rpc('bom_line_substitute_add', L1, tissuB, 1, 'Tissu B équivalent en stock')), 'BOM_SUBSTITUTE_DUPLICATE')
ok('substitution enregistrée sur la version 1', (await q(`select count(*)::int n from bom_line_substitutions where id=$1 and version_id=$2`, [sub, v1]))[0].n === 1)

// 3. Approbation distincte : le rédacteur ne valide pas sa propre version
await rejects('approbation par le rédacteur refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('bom_validate_version', v1, 'Auto')), 'SOD_SELF_APPROVAL')
await as(admin2, () => rpc('bom_validate_version', v1, 'Conforme à la fiche technique'))
const bv1 = (await q(`select status, effective_from from bom_versions where id=$1`, [v1]))[0]
ok('version 1 approuvée par un autre utilisateur, datée (date d’effet)', bv1.status === 'validated' && bv1.effective_from !== null
  && (await q(`select active_version_id from boms where id=$1`, [bom]))[0].active_version_id === v1)

// 4. OF lancé : version figée ; besoins calculés sur la version figée
const O1 = (await as(admin, () => rpc('production_order_create', article, 10, 30, wc, '2027-03-01', '2027-03-10')))
const o1 = await q(`select id, number from production_orders where id=$1`, [O1])
await as(admin, () => rpc('production_order_launch', O1))
const snap1 = (await q(`select status, version_no, version_id from production_order_bom where order_id=$1`, [O1]))[0]
ok('OF lancé : version figée (version 1, statut « frozen »)', snap1.status === 'frozen' && snap1.version_no === 1 && snap1.version_id === v1)
const r1 = await as(admin, () => rpc('production_order_requirements', O1, 'M', 'Marine'))
const mat1 = (m) => Number(r1.materials.find((x) => x.material_id === m).qty)
ok('besoins OF (taille M) : tissu 10 × 2 × (1 + 5 %) = 21 ; doublure 10 × 150 cm = 15 m', near(mat1(tissu), 21) && near(mat1(doublure), 15))
ok('substitution autorisée listée sur la ligne du tissu, quantités non doublées', r1.lines.find((l) => l.line_id === L1).substitutes.length === 1 && near(mat1(tissu), 21))
const r1g = await as(admin, () => rpc('production_order_requirements', O1, null, null))
ok('sans taille ni coloris : la ligne restreinte n’est pas comptée et est signalée', r1g.restricted_lines.includes(L2) && r1g.materials.length === 1 && near(Number(r1g.materials[0].qty), 21))

// 5. Nouvelle version : copie des attributs et substitutions ; quantités modifiées ; OF ancien inchangé
const v2 = await as(admin, () => rpc('bom_new_version', bom, 'Tissu passé à 3 m'))
const copyLines = (await q(`select count(*)::int n from bom_lines where version_id=$1`, [v2]))[0].n
const copyAttr = (await q(`select count(*)::int n from bom_line_attributes where version_id=$1 and size_code='M' and color_name='Marine'`, [v2]))[0].n
const copySub = (await q(`select count(*)::int n from bom_line_substitutions where version_id=$1`, [v2]))[0].n
ok('nouvelle version : lignes, attributs et substitutions copiés', copyLines === 2 && copyAttr === 1 && copySub === 1)
const v2L1 = (await q(`select id from bom_lines where version_id=$1 and material_id=$2`, [v2, tissu]))[0].id
await as(admin, () => db.query(`update bom_lines set quantity=3 where id=$1`, [v2L1]))
await as(admin2, () => rpc('bom_validate_version', v2, 'Quantité tissu révisée'))
const r1after = await as(admin, () => rpc('production_order_requirements', O1, 'M', 'Marine'))
ok('nouvelle BOM validée : l’OF ancien garde ses quantités (tissu toujours 21)', near(Number(r1after.materials.find((x) => x.material_id === tissu).qty), 21)
  && (await q(`select version_id from production_order_bom where order_id=$1`, [O1]))[0].version_id === v1)

const O2 = (await as(admin, () => rpc('production_order_create', article, 10, 30, wc, '2027-04-01', '2027-04-10')))
await as(admin, () => rpc('production_order_launch', O2))
const r2 = await as(admin, () => rpc('production_order_requirements', O2, 'M', 'Marine'))
ok('nouvel OF lancé après validation : version 2 figée, tissu 10 × 3 × 1,05 = 31,5', (await q(`select version_no from production_order_bom where order_id=$1`, [O2]))[0].version_no === 2
  && near(Number(r2.materials.find((x) => x.material_id === tissu).qty), 31.5))

// 6. Figure immuable : ni modification ni suppression, même en accès direct
await rejects('figure de l’OF non modifiable par un utilisateur applicatif', () => as(admin, () => db.query(`update production_order_bom set version_no=9 where order_id=$1`, [O1])), 'permission denied')
await rejects('figure de l’OF non modifiable même en accès direct (STOCK_IMMUTABLE)', () => db.query(`update production_order_bom set version_no=9 where order_id=$1`, [O1]), 'STOCK_IMMUTABLE')

// 7. Substitution archivée : version refusée à la validation
const v3 = await as(admin, () => rpc('bom_new_version', bom, 'Substitution à revoir'))
await as(admin, () => rpc('bom_material_archive', tissuB, true))
await rejects('substitution archivée : validation refusée (BOM_MATERIAL_ARCHIVED)', () => as(admin2, () => rpc('bom_validate_version', v3, 'Test')), 'BOM_MATERIAL_ARCHIVED')

// 8. Droits et audit
await rejects('besoins d’un OF sans droit de lecture de la nomenclature refusés (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_order_requirements', O1, null, null)), 'RBAC_FORBIDDEN')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : figure des OF (2), conversions, attributs et substitutions tracés', (await aud('production.bom_freeze')) === 2 && (await aud('bom.unit_conversion')) >= 1
  && (await aud('bom.line_attributes')) >= 1 && (await aud('bom.substitute_add')) === 1)
