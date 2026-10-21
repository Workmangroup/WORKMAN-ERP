import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0032_company_structure.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows

const companyA = (await q(`select id from companies order by created_at limit 1`))[0].id
const companyB = (await q(`insert into companies(name, country) values ('Société B', 'TN') returning id`))[0].id
const role = async (code, company = companyA) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode, company = companyA) => {
  const meta = company === companyA ? '{}' : JSON.stringify({ company_id: company })
  const id = (await q(`insert into auth.users(email, raw_app_meta_data) values ($1, $2) returning id`, [email, meta]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode, company)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const adminB = await mkUser('adminb@x.com', null, companyB)

// --- 0. Structure -----------------------------------------------------------------------------------------------------------
const cols = await q(`select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name='companies' and column_name='currency'`)
ok('companies.currency existe et reste vide (OPEN-04 non fourni)', cols.length === 1 && (await q(`select currency from companies where id=$1`, [companyA]))[0].currency === null)
ok('sites et user_companies créées', (await q(`select count(*)::int n from information_schema.tables where table_schema='public' and table_name in ('sites','user_companies')`))[0].n === 2)
ok('sites.read et sites.manage créées', (await q(`select count(*)::int n from permissions where code in ('sites.read','sites.manage')`))[0].n === 2)
ok('rôle admin reçoit sites.read et sites.manage', (await q(`select count(*)::int n from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=$1 and p.code in ('sites.read','sites.manage')`, [await role('admin')]))[0].n === 2)

// --- 1. Rattachement utilisateur ↔ société -----------------------------------------------------------------------------------
ok('reprise : profil admin rattaché à sa société par défaut', (await q(`select is_default from user_companies where user_id=$1 and company_id=$2`, [admin, companyA]))[0]?.is_default === true)
ok('reprise : chaque profil a exactement une société par défaut', (await q(`select count(*)::int n from (select user_id from user_companies where is_default group by user_id having count(*) <> 1) x`))[0].n === 0)
const moved = await mkUser('moved@x.com', 'magasin')
await db.query(`update profiles set company_id=$1 where id=$2`, [companyB, moved])
const rowsMoved = await q(`select company_id, is_default from user_companies where user_id=$1 order by company_id`, [moved])
ok('changement de société du profil : nouvelle société par défaut, ancienne retirée du défaut', rowsMoved.filter((r) => r.is_default).length === 1 && rowsMoved.find((r) => r.company_id === companyB)?.is_default === true)
await db.query(`update profiles set company_id=$1 where id=$2`, [companyA, moved])
ok('retour à la société d’origine : une seule société par défaut', (await q(`select count(*)::int n from user_companies where user_id=$1 and is_default`, [moved]))[0].n === 1)

// --- 2. Sites : création, validation, droits ---------------------------------------------------------------------------------
const mkSite = (code, name) => as(admin, async () => (await q(`insert into sites(company_id, code, name, city) values ($1,$2,$3,'Sfax') returning *`, [companyA, code, name]))[0])
const s1 = await mkSite('SITE-1', 'Atelier Sfax')
ok('admin crée un site dans sa société', s1.company_id === companyA && s1.code === 'SITE-1')
await rejects('code de site invalide refusé', () => mkSite('site 1', 'Mauvais'), 'sites_code_check')
await rejects('code de site en double refusé dans la société', () => mkSite('SITE-1', 'Doublon'), 'sites_company_id_code_key')
await rejects('nom trop court refusé', () => mkSite('SITE-2', 'a'), 'sites_name_check')

const visibleAdmin = await as(admin, () => q(`select id from sites`))
ok('admin voit les sites de sa société', visibleAdmin.length === 1)
ok('magasinier sans sites.read ne voit aucun site', (await as(mag, () => q(`select id from sites`))).length === 0)
ok('direction (sites.read) voit les sites', (await as(dir, () => q(`select id from sites`))).length === 1)

await rejects('magasinier ne peut pas créer un site', () => as(mag, () => db.query(`insert into sites(company_id, code, name) values ($1,'SITE-3','Intrus')`, [companyA])), 'row-level security')
await rejects('création d’un site dans une autre société refusée', () => as(admin, () => db.query(`insert into sites(company_id, code, name) values ($1,'SITE-X','Autre société')`, [companyB])), 'row-level security')

const archived = await as(mag, () => q(`update sites set archived_at=now() where id=$1 returning id`, [s1.id]))
ok('magasinier ne peut pas archiver un site (0 ligne modifiée)', archived.length === 0)
await rejects('suppression physique d’un site impossible (aucun droit DELETE)', () => as(admin, () => db.query(`delete from sites where id=$1`, [s1.id])), 'permission denied')
ok('le site est toujours présent après la tentative de suppression', (await q(`select count(*)::int n from sites where id=$1`, [s1.id]))[0].n === 1)
const archivedAdmin = await as(admin, () => q(`update sites set archived_at=now() where id=$1 returning archived_at`, [s1.id]))
ok('admin archive un site (désactivation, pas de suppression)', archivedAdmin[0].archived_at !== null)
await db.query(`update sites set archived_at=null where id=$1`, [s1.id])

// --- 3. Isolation inter-sociétés --------------------------------------------------------------------------------------------
const siteB = (await q(`insert into sites(company_id, code, name) values ($1,'B-1','Site société B') returning id`, [companyB]))[0].id
ok('admin de la société A ne voit pas les sites de la société B', (await as(admin, () => q(`select id from sites where id=$1`, [siteB]))).length === 0)
ok('sans rôle dans la société B, aucun site visible (refus par défaut)', (await as(adminB, () => q(`select id from sites`))).length === 0)
const roleB = (await q(`insert into roles(company_id, code, label) values ($1,'lecteur','Lecteur') returning id`, [companyB]))[0].id
await db.query(`insert into role_permissions select $1, id from permissions where code='sites.read'`, [roleB])
await db.query(`insert into user_roles values ($1,$2)`, [adminB, roleB])
ok('utilisateur de la société B avec sites.read voit le site de B, pas celui de A', (await as(adminB, () => q(`select id from sites`))).map((r) => r.id).join() === siteB)

// --- 4. Entrepôt rattaché à un site de la même société -----------------------------------------------------------------------
const whA = (await q(`insert into warehouses(company_id, code, name, kind, site_id) values ($1,'WH-S1','Entrepôt du site',  'supplies', $2) returning id, site_id`, [companyA, s1.id]))[0]
ok('entrepôt rattaché à un site de la même société', whA.site_id === s1.id)
await rejects('entrepôt de la société A rattaché à un site de la société B refusé', () => db.query(`insert into warehouses(company_id, code, name, kind, site_id) values ($1,'WH-X','Croisé','supplies',$2)`, [companyA, siteB]), 'warehouses_site_same_company_fk')
const whNoSite = (await q(`insert into warehouses(company_id, code, name, kind) values ($1,'WH-NS','Sans site','other') returning site_id`, [companyA]))[0]
ok('site_id reste optionnel (entrepôts existants inchangés)', whNoSite.site_id === null)

// --- 5. Journal d'audit ---------------------------------------------------------------------------------------------------
const audit = await q(`select action, entity_id from audit_logs where entity_type='site' and entity_id=$1 order by created_at`, [s1.id])
ok('création de site journalisée (site.create)', audit.some((a) => a.action === 'site.create'))
ok('modification de site journalisée (site.update)', audit.some((a) => a.action === 'site.update'))

// --- 6. Rattachements : lecture limitée à soi, écriture refusée au client -----------------------------------------------------
ok('utilisateur ne voit que ses propres rattachements (sans users.read)', (await as(mag, () => q(`select user_id from user_companies where user_id <> $1`, [mag]))).length === 0)
await rejects('écriture directe dans user_companies refusée', () => as(admin, () => db.query(`insert into user_companies(user_id, company_id) values ($1,$2)`, [admin, companyB])), 'permission denied')

console.log('— fin company-structure')
