import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql'])
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
const com = await mkUser('com@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const magasin = await mkUser('mag@x.com', 'magasin')

// --- Recherche de fiches : permissions, société, archives ----------------------------------------------------------------------------
await q(`select 1`)
const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Laforêt Tunisie','TN','EUR') returning id`)))[0].id
const old = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Laforêt ancien','TN','EUR') returning id`)))[0].id
await db.query(`update clients set archived_at = now(), archived_by = null, archive_reason = 'Test' where id = $1`, [old])
const sup = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'F-001','Tissus Laforêt Sfax','TN') returning id`, [company]))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT001','LAF-HV-JKT','Veste Laforêt','jacket') returning id`, [cl])))[0].id
// --- Vues sauvegardées : personnelles, validées ----------------------------------------------------------------------------------------
const v1 = await as(admin, () => q(`insert into saved_views(table_id, name, state) values ('clients.list', 'Clients actifs', '{"search":"tex","sort":null,"pageSize":25}') returning id, user_id, company_id`))
ok('vue sauvegardée : rattachée à l’auteur et à la société active', v1[0].user_id === admin && v1[0].company_id === company)
ok('vue : visible par son auteur', (await as(admin, () => q(`select id from saved_views`))).length === 1)
ok('vue : invisible pour un autre utilisateur, même avec le droit de lecture de la fiche', (await as(com, () => q(`select id from saved_views`))).length === 0)
await rejects('vue : impossible de la créer au nom d’un autre utilisateur', () => as(com, () => db.query(`insert into saved_views(user_id, table_id, name, state) values ($1, 'clients.list', 'Intrus', '{}')`, [admin])), 'row-level security')
await rejects('vue : contenu non objet refusé', () => as(admin, () => db.query(`insert into saved_views(table_id, name, state) values ('clients.list', 'Tableau', '[1,2]')`)), 'saved_views_state_check')
await rejects('vue : contenu trop volumineux refusé', () => as(admin, () => db.query(`insert into saved_views(table_id, name, state) values ('clients.list', 'Gros', jsonb_build_object('x', repeat('a', 5000)))`)), 'saved_views_state_check')
await rejects('vue : nom en double pour la même table refusé', () => as(admin, () => db.query(`insert into saved_views(table_id, name, state) values ('clients.list', 'Clients actifs', '{}')`)), 'saved_views_user_id_table_id_name_key')
await as(admin, () => db.query(`update saved_views set state='{"search":"coton"}' where table_id='clients.list'`))
ok('vue : mise à jour par son auteur', (await q(`select state->>'search' s from saved_views where table_id='clients.list'`))[0].s === 'coton')
await as(com, () => db.query(`delete from saved_views where table_id='clients.list'`))
ok('vue : suppression par un autre utilisateur sans effet', (await q(`select count(*)::int n from saved_views`))[0].n === 1)
await as(admin, () => db.query(`delete from saved_views where table_id='clients.list'`))
ok('vue : suppression par son auteur', (await q(`select count(*)::int n from saved_views`))[0].n === 0)

const s1 = await as(admin, () => q(`select kind, label from global_search('laf')`))
ok('recherche : clients, fournisseurs et articles trouvés pour qui a les droits', ['client','supplier','article'].every((k) => s1.some((r) => r.kind === k)), JSON.stringify(s1.map((r) => r.kind)))
ok('recherche : fiche archivée exclue (client ancien)', s1.filter((r) => r.kind === 'client').length === 1)
ok('recherche : une seule ligne par fiche, libellé exact', s1.find((r) => r.kind === 'client').label === 'Laforêt Tunisie')
const comKinds = (await as(com, () => q(`select kind from global_search('laf')`))).map((r) => r.kind)
ok('recherche : seuls les types autorisés (commercial : clients et articles, pas fournisseurs)', comKinds.includes('client') && comKinds.includes('article') && !comKinds.includes('supplier'), comKinds.join())
ok('recherche : sans droit de lecture, rien', (await as(nobody, () => q(`select kind from global_search('laf')`))).length === 0)
ok('recherche : moins de 2 caractères, rien', (await as(admin, () => q(`select kind from global_search('l')`))).length === 0)
ok('recherche : le caractère % n’ouvre pas la recherche (échappé)', (await as(admin, () => q(`select kind from global_search('%')`))).length === 0)
const other = (await q(`insert into companies(name, country) values ('Autre','TN') returning id`))[0].id
await db.query(`insert into clients(company_id, code, name, country, currency) values ($1,'X-1','Laforêt Autre société','TN','EUR')`, [other])
ok('recherche : fiches d’une autre société exclues', (await as(admin, () => q(`select label from global_search('laf')`))).every((r) => r.label !== 'Laforêt Autre société'))
ok('recherche : href de la fiche', s1.find((r) => r.kind === 'client') && (await as(admin, () => q(`select href from global_search('Tunisie')`)))[0].href === '/clients/' + cl)
