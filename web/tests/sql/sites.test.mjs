import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0032_sites.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('comm@x.com', 'commercial')

// --- 0. Aucune donnée créée par la migration (OPEN-02 : sites à fournir par le propriétaire) ------------------------------------------------
ok('migration : aucun site créé', (await q(`select count(*)::int n from sites`))[0].n === 0)
ok('migration : entrepôts existants sans site (site_id nul)', (await q(`select count(*)::int n from warehouses where site_id is not null`))[0].n === 0)
ok('migration : permissions sites.read et sites.manage créées', (await q(`select count(*)::int n from permissions where code in ('sites.read','sites.manage')`))[0].n === 2)
ok('migration : admin a sites.read et sites.manage', (await q(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='admin' and r.company_id=$1 and p.code in ('sites.read','sites.manage')`, [company]))[0].n === 2)
ok('migration : direction a sites.read sans sites.manage', (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='direction' and r.company_id=$1 and p.code like 'sites.%'`, [company])).map((r) => r.code).join() === 'sites.read')

// --- 1. Création, codes générés, validation ----------------------------------------------------------------------------------------------------
const mkSite = (name, kind = 'site') => as(admin, async () => (await q(`insert into sites(company_id, name, kind, city) values ($1,$2,$3,'Sfax') returning *`, [company, name, kind]))[0])
const s1 = await mkSite('Siège Sfax')
const s2 = await mkSite('Atelier Coupe', 'workshop')
ok('site créé : code SIT-01, société déduite, auteur renseigné', s1.code === 'SIT-01' && s1.company_id === company && s1.created_by === admin)
ok('second site : code SIT-02', s2.code === 'SIT-02' && s2.kind === 'workshop')
await rejects('type de site inconnu refusé', () => mkSite('Cave', 'cellar'), 'sites_kind_check')
await rejects('nom en double dans la société refusé', () => mkSite('siège sfax'), 'sites_name_uq')
await rejects('code de site immuable (non modifiable par le client)', () => as(admin, () => db.query(`update sites set code='X' where id=$1`, [s1.id])), 'permission denied')
await as(admin, () => db.query(`update sites set city='Tunis' where id=$1`, [s1.id]))
ok('modification d’un site autorisée (ville)', (await q(`select city from sites where id=$1`, [s1.id]))[0].city === 'Tunis')

// --- 2. Refus par défaut ---------------------------------------------------------------------------------------------------------------------
await rejects('commercial sans sites.manage : création refusée', () => as(comm, () => db.query(`insert into sites(company_id, name) values ($1,'Intrus')`, [company])), 'SITE_FORBIDDEN')
await rejects('direction (lecture seule) : création refusée', () => as(dir, () => db.query(`insert into sites(company_id, name) values ($1,'Intrus')`, [company])), 'SITE_FORBIDDEN')
await as(dir, () => db.query(`update sites set city='X' where id=$1`, [s1.id]))
ok('direction (lecture seule) : modification sans effet (aucune ligne visible en écriture)', (await q(`select city from sites where id=$1`, [s1.id]))[0].city === 'Tunis')
ok('direction : lit les sites de sa société', (await as(dir, () => q(`select id from sites order by code`))).length === 2)
ok('commercial sans sites.read : ne voit aucun site', (await as(comm, () => q(`select id from sites`))).length === 0)

// --- 3. Archivage uniquement (pas de suppression physique) ----------------------------------------------------------------------------------
await as(admin, () => db.query(`update sites set archived_at=now() where id=$1`, [s2.id]))
ok('archivage : site conservé avec archived_at', (await q(`select archived_at is not null a from sites where id=$1`, [s2.id]))[0].a === true)
await as(admin, () => db.query(`update sites set archived_at=null where id=$1`, [s2.id]))
ok('restauration : archived_at remis à nul', (await q(`select archived_at is null a from sites where id=$1`, [s2.id]))[0].a === true)
await rejects('suppression physique refusée (aucun privilège DELETE)', () => as(admin, () => db.query(`delete from sites where id=$1`, [s2.id])), 'permission denied')
ok('suppression physique impossible : le site existe toujours', (await q(`select count(*)::int n from sites where id=$1`, [s2.id]))[0].n === 1)

// --- 4. Isolation entre sociétés ---------------------------------------------------------------------------------------------------------------
const other = (await q(`insert into companies(name, country) values ('Autre société', 'TN') returning id`))[0].id
const sOther = (await q(`insert into sites(company_id, code, name) values ($1,'SIT-99','Site autre société') returning id`, [other]))[0].id
ok('isolation : admin ne lit pas le site d’une autre société', (await as(admin, () => q(`select id from sites where id=$1`, [sOther]))).length === 0)
await rejects('isolation : admin ne crée pas de site dans une autre société', () => as(admin, () => db.query(`insert into sites(company_id, name) values ($1,'Intrus')`, [other])), 'row-level security')

// --- 5. Rattachement d'un entrepôt : même société uniquement ---------------------------------------------------------------------------
const wh = (await as(admin, () => q(`insert into warehouses(name, kind) values ('Entrepôt Tissus','fabric') returning id`)))[0].id
await as(admin, () => db.query(`update warehouses set site_id=$1 where id=$2`, [s1.id, wh]))
ok('entrepôt rattaché à un site de sa société', (await q(`select site_id from warehouses where id=$1`, [wh]))[0].site_id === s1.id)
await rejects('entrepôt ne peut pas être rattaché à un site d’une autre société', () => as(admin, () => db.query(`update warehouses set site_id=$1 where id=$2`, [sOther, wh])), 'warehouses_site_fk')
await as(admin, () => db.query(`update warehouses set site_id=null where id=$1`, [wh]))
ok('détachement d’un entrepôt (site_id nul) autorisé', (await q(`select site_id from warehouses where id=$1`, [wh]))[0].site_id === null)

// --- 6. Journal ----------------------------------------------------------------------------------------------------------------------------------
const actions = (await q(`select action from audit_logs where entity_type='site' order by created_at, action`)).map((r) => r.action)
ok('journal : création, modification, archivage et restauration tracés', ['site.create', 'site.update', 'site.archive', 'site.restore'].every((a) => actions.includes(a)), JSON.stringify([...new Set(actions)]))
