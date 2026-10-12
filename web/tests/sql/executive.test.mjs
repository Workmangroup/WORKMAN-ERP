import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql', '0022_finance.sql', '0023_executive.sql'])
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
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const comm = await mkUser('comm@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

// --- 0. Permissions ------------------------------------------------------------------------------------------------------------------------
ok('direction et admin : vue DG', (await perms('direction')).includes('dashboard.executive') && (await perms('admin')).includes('dashboard.executive'))
ok('magasin : pas de vue DG', !(await perms('magasin')).includes('dashboard.executive'))

// --- 1. Données : factures clients et fournisseurs --------------------------------------------------------------------------------------
const d = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const firstPrev = (() => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - 1); return t.toISOString().slice(0, 10) })()
const client = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const sup = (await as(admin, () => q(`insert into suppliers(name, country) values ('Tissus Sfax','TN') returning id`)))[0].id
const mkInv = (code, issue, due, total) => db.query(`insert into invoices(company_id, client_id, code, status, issue_date, due_date, total, subtotal, tax_amount) values ($1,$2,$3,'issued',$4,$5,$6,$6,0) returning id`, [company, client, code, issue, due, total]).then((r) => r.rows[0].id)
await db.exec('alter table invoices disable trigger all')
await mkInv('FAC-E-1', d(0), d(30), 1000)
await mkInv('FAC-E-2', firstPrev, d(-20), 400)
await mkInv('FAC-E-3', d(0), d(-10), 500)
await db.exec('alter table invoices enable trigger all')
await as(admin, () => rpc('supplier_invoice_record', sup, 'FT-E-1', d(0), d(20), 300, 'EUR', null))

// --- 2. Vue DG -----------------------------------------------------------------------------------------------------------------------------
const dg = await as(dir, () => rpc('executive_dashboard', 12))
ok('vue DG : accès à tous les blocs pour la direction', dg.access.ca && dg.access.marge && dg.access.finance && dg.access.qualite && dg.access.expeditions && dg.access.production)
ok('CA du mois : 1 500 (factures émises ce mois)', Number(dg.ca.current_month) === 1500)
ok('CA du mois précédent : 400', Number(dg.ca.previous_month) === 400)
ok('tendance CA : 12 mois de série', dg.ca.series.length === 12)
ok('marge estimée du mois : (1 500 − 300) ÷ 1 500 = 80 %', Number(dg.marge.current_month_rate_pct) === 80)
ok('CA ouvert : solde des factures non réglées', Number(dg.ca.open_balance) === 1900)
ok('finance : prévision à 13 semaines', dg.finance.forecast.length === 13)
ok('alerte stratégique : créances échues > 30 %', dg.alerts.some((a) => a.module === 'finance' && a.title === 'Créances échues élevées'))
ok('alertes : aucune alerte de trésorerie négative sans compte', !dg.alerts.some((a) => a.title === 'Trésorerie négative'))
ok('horodatage et période renseignés', !!dg.generated_at && dg.period_months === 12)

// --- 3. Limitation par module ------------------------------------------------------------------------------------------------------------------
await db.query(`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.code='commercial' and r.company_id=$1 and p.code='dashboard.executive' on conflict do nothing`, [company])
const cg = await as(comm, () => rpc('executive_dashboard', 12))
ok('commercial avec vue DG : finance masquée (pas de finance.read)', cg.finance === null && cg.access.finance === false)
ok('commercial : marge masquée (pas de costs.read)', cg.marge === null && cg.access.marge === false)
ok('commercial : CA visible (invoices.read)', cg.ca !== null)

// --- 4. Droits et paramètres ----------------------------------------------------------------------------------------------------------------------
await rejects('magasinier : vue DG refusée', () => as(mag, () => rpc('executive_dashboard', 12)), 'RBAC_FORBIDDEN')
await rejects('sans rôle : vue DG refusée', () => as(nobody, () => rpc('executive_dashboard', 12)), 'RBAC_FORBIDDEN')
await rejects('période hors bornes refusée', () => as(dir, () => rpc('executive_dashboard', 2)), 'EXEC_BAD_PERIOD')
