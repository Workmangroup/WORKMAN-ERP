import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql'])
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
const com = await mkUser('com@x.com', 'commercial')

// --- A. Référentiel d'unités et composants ----------------------------------------------------------------------------------------------
ok('référentiel : pièce, mètre, centimètre, m², gramme, kilogramme et rouleau', (await q(`select count(*)::int n from measurement_units`))[0].n === 7)
await rejects('unité inconnue refusée sur un composant', () => as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Ruban','label','xyz')`)), 'bom_materials_unit_fk')
await rejects('rouleau sans longueur refusé', () => as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Tissu rouleau','fabric','roll')`)), 'bom_materials_roll_ck')
const tissu = (await as(admin, () => q(`insert into bom_materials(name, category, unit, roll_length_m, width_m, grammage_g_m2) values ('Coton 200 g','fabric','roll', 50, 1.5, 200) returning id`)))[0].id
const tissuM = (await as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Doublure au mètre','lining','m') returning id`)))[0].id
const piece = (await as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Bouton','button','pc') returning id`)))[0].id

// --- B. Conversions : standard, dérivées des caractéristiques, jamais inventées -----------------------------------------------------------
const conv = (m, qty, f, t) => as(admin, () => q(`select public.unit_convert($1, $2, $3, $4) v`, [m, qty, f, t])).then((r) => Number(r[0].v))
ok('cm → m : 150 cm = 1,5 m (standard)', (await conv(tissuM, 150, 'cm', 'm')) === 1.5)
ok('rouleau → m : 2 rouleaux de 50 m = 100 m (longueur du rouleau)', (await conv(tissu, 2, 'roll', 'm')) === 100)
ok('m → kg : 1 m de tissu 1,5 m de large à 200 g/m² = 0,3 kg', (await conv(tissu, 1, 'm', 'kg')) === 0.3)
ok('kg → m : l’inverse, 0,3 kg = 1 m', (await conv(tissu, 0.3, 'kg', 'm')) === 1)
ok('m² → kg : 1 m² à 200 g/m² = 0,2 kg', (await conv(tissu, 1, 'm2', 'kg')) === 0.2)
await rejects('kg → m refusé sans grammage (aucune conversion inventée)', () => as(admin, () => q(`select public.unit_convert($1, 1, 'kg', 'm') v`, [tissuM])), 'UNIT_CONVERSION_MISSING')
await rejects('m → kg refusé sans largeur ni grammage', () => as(admin, () => q(`select public.unit_convert($1, 1, 'm', 'kg') v`, [tissuM])), 'UNIT_CONVERSION_MISSING')
await rejects('pièce → mètre refusé sans conversion explicite', () => as(admin, () => q(`select public.unit_convert($1, 1, 'pc', 'm') v`, [piece])), 'UNIT_CONVERSION_MISSING')
await rejects('unité inconnue refusée dans une conversion', () => as(admin, () => q(`select public.unit_convert($1, 1, 'xyz', 'm') v`, [tissuM])), 'UNIT_UNKNOWN')

// Conversion explicite : pièce → mètre, avec sa base
await rejects('conversion sans base refusée', () => as(admin, () => rpc('material_conversion_set', piece, 'pc', 'm', 2, 'x')), 'UNIT_BASIS_REQUIRED')
await rejects('conversion d’une unité vers elle-même refusée', () => as(admin, () => rpc('material_conversion_set', piece, 'pc', 'pc', 2, 'Fiche technique du bouton')), 'UNIT_SAME')
await rejects('conversion au facteur nul refusée', () => as(admin, () => rpc('material_conversion_set', piece, 'pc', 'm', 0, 'Fiche technique du bouton')), 'UNIT_BAD_FACTOR')
await rejects('conversion sans droit bom.write refusée', () => as(com, () => rpc('material_conversion_set', piece, 'pc', 'm', 2, 'Fiche technique du bouton')), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('material_conversion_set', piece, 'pc', 'm', 2, 'Fiche technique du fournisseur'))
ok('conversion explicite appliquée avec sa base', (await conv(piece, 3, 'pc', 'm')) === 6)
ok('conversion explicite tracée (audit)', (await q(`select count(*)::int n from audit_logs where action='material.conversion_set'`))[0].n === 1)
ok('quantité entière dans l’unité du composant (inchangée par la conversion)', (await q(`select unit from bom_materials where id=$1`, [piece]))[0].unit === 'pc')

// --- C. SKU : unicité, immuabilité, historique jamais réattribué -------------------------------------------------------------------------
const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client variantes','FR','EUR') returning id`)))[0].id
const prod = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste test','jacket') returning id`, [cl])))[0].id
const jau = (await q(`select id from colors where code='JAU'`))[0].id
const mar = (await q(`select id from colors where code='MAR'`))[0].id
const sS = (await q(`select id from sizes where code='S'`))[0].id
const sM = (await q(`select id from sizes where code='M'`))[0].id
const v1 = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'JKT001-JAU-S') returning id`, [prod, jau, sS])))[0].id
ok('SKU normalisé en majuscules à la création', (await q(`select sku from product_variants where id=$1`, [v1]))[0].sku === 'JKT001-JAU-S')
await rejects('SKU déjà utilisé : doublon refusé (insensible à la casse)', () => as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'jkt001-jau-s') returning id`, [prod, mar, sM])), 'SKU_HISTORICAL')
await rejects('SKU attribué : modification refusée par le déclencheur (chemin de service)', () => db.query(`update product_variants set sku='JKT001-JAU-M' where id=$1`, [v1]), 'SKU_IMMUTABLE')
await rejects('SKU attribué : pas de modification directe pour les utilisateurs', () => as(admin, () => db.query(`update product_variants set sku='JKT001-JAU-M' where id=$1`, [v1])), 'permission denied')
// désactivation : le SKU reste réservé
await db.query(`update product_variants set active=false where id=$1`, [v1])
await rejects('variante désactivée : son SKU ne peut pas être réattribué', () => as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'JKT001-JAU-S') returning id`, [prod, jau, sM])), 'SKU_HISTORICAL')
// suppression : l'historique survit, le SKU reste réservé
await db.query(`delete from product_variants where id=$1`, [v1])
await rejects('variante supprimée : son SKU n’est jamais réattribué', () => as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'JKT001-JAU-S') returning id`, [prod, jau, sS])), 'SKU_HISTORICAL')
ok('historique SKU conservé après suppression', (await q(`select count(*)::int n from sku_history where sku_key='JKT001-JAU-S' and variant_id=$1`, [v1]))[0].n === 1)
const v2 = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'JKT001-MAR-M') returning id`, [prod, mar, sM])))[0].id
ok('nouveau SKU distinct accepté', !!v2)
const coB = (await q(`insert into companies(name, country) values ('Société B','TN') returning id`))[0].id
await db.query(`insert into sku_history(company_id, sku_key) values ($1, 'JKT001-JAU-S')`, [coB])
ok('historique SKU propre à chaque société : même code possible dans une autre société', (await q(`select count(*)::int n from sku_history where sku_key='JKT001-JAU-S'`))[0].n === 2)
