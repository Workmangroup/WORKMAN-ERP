import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql', '0022_finance.sql', '0023_executive.sql', '0024_copilot.sql'])
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
const admin2 = await mkUser('admin2@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

// --- 0. Permissions ------------------------------------------------------------------------------------------------------------------------------
ok('copilote : accessible à la direction et à la finance', (await perms('direction')).includes('copilot.use') && (await perms('finance')).includes('copilot.use'))

// --- 1. Historique personnel ---------------------------------------------------------------------------------------------------------------------
const conv = (await as(admin, () => q(`insert into copilot_conversations(title) values ('Rentabilité clients') returning id`)))[0].id
await as(admin, () => q(`insert into copilot_messages(conversation_id, role, content, payload) values ($1,'user','Quelle est la rentabilité des clients ?','{}')`, [conv]))
await as(admin, () => q(`insert into copilot_messages(conversation_id, role, content, payload) values ($1,'assistant','Réponse de test','{"kind":"table"}')`, [conv]))
ok('historique : la conversation et ses deux messages sont enregistrés', (await as(admin, () => q(`select count(*)::int n from copilot_messages where conversation_id=$1`, [conv])))[0].n === 2)
ok('historique : un autre administrateur ne voit pas la conversation', (await as(admin2, () => q(`select count(*)::int n from copilot_conversations where id=$1`, [conv])))[0].n === 0)
await rejects('historique : impossible d’écrire dans la conversation d’un autre', () => as(admin2, () => q(`insert into copilot_messages(conversation_id, role, content) values ($1,'user','intrusion')`, [conv])), 'row-level security')
await rejects('historique : sans droit copilote, aucune conversation créée', () => as(nobody, () => q(`insert into copilot_conversations(title) values ('x')`)), 'row-level security')
await as(admin, () => q(`delete from copilot_conversations where id=$1`, [conv]))
ok('historique : supprimer une conversation supprime ses messages', (await q(`select count(*)::int n from copilot_messages where conversation_id=$1`, [conv]))[0].n === 0)

// --- 2. Fixtures : clients, factures, commandes, seuils -----------------------------------------------------------------------------------------
const d = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const c1 = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const c2 = (await as(admin, () => q(`insert into clients(name, country) values ('Bragard','FR') returning id`)))[0].id
const mkInv = (client, code, issue, due, total, credited = 0, paid = 0, status = 'issued') => db.query(`insert into invoices(company_id, client_id, code, status, issue_date, due_date, total, subtotal, tax_amount, credited_amount, paid_amount) values ($1,$2,$3,$4,$5,$6,$7,$7,0,$8,$9) returning id`, [company, client, code, status, issue, due, total, credited, paid]).then((r) => r.rows[0].id)
await db.exec('alter table invoices disable trigger all')
await mkInv(c1, 'FAC-C-1', d(0), d(20), 1000, 100, 0)
await mkInv(c1, 'FAC-C-2', d(0), d(-15), 500, 0, 200)
await mkInv(c2, 'FAC-C-3', d(0), d(30), 300, 0, 0)
await db.exec('alter table invoices enable trigger all')
const prof = await as(admin, () => q(`select * from copilot_client_profit(12)`))
const pL = prof.find((r) => r.client_name === 'LAFONT')
const pB = prof.find((r) => r.client_name === 'Bragard')
ok('rentabilité client : LAFONT facturé 1 500 TTC, avoirs 100, net 1 400', Number(pL.invoiced) === 1500 && Number(pL.credited) === 100 && Number(pL.net_revenue) === 1400)
ok('rentabilité client : encours 1 200 dont 300 en retard', Number(pL.open_balance) === 1200 && Number(pL.overdue_balance) === 300)
ok('rentabilité client : marge non calculée sans coût figé (couverture 0 %)', pL.margin_pct === null && Number(pB.net_revenue) === 300)
const profC = await as(comm, () => q(`select * from copilot_client_profit(12)`))
ok('rentabilité client : commercial sans costs.read : marge masquée', profC.every((r) => r.margin === null))
await rejects('rentabilité client refusée sans invoices.read', () => as(nobody, () => q(`select * from copilot_client_profit(12)`)), 'RBAC_FORBIDDEN')

const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-A','Veste A','jacket') returning id`, [c1])))[0].id
const order = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [c1])))[0].id
await as(admin, () => q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,40,$3)`, [order, art, d(10)]))
await as(admin, () => rpc('sales_order_confirm', order))
const prod = await as(admin, () => q(`select * from copilot_production_suggestions()`))
ok('suggestion de production : 40 pièces confirmées, rien planifié ni en stock → écart de 40', prod.some((r) => r.article_name === 'Veste A' && Number(r.gap) === 40))

const mat = (await as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Fil coton','thread','m') returning id`)))[0].id
const wh = (await as(admin, () => q(`insert into warehouses(name, kind) values ('Magasin fils','supplies') returning id`)))[0].id
await db.query(`insert into stock_thresholds(company_id, material_id, warehouse_id, safety_qty) values ($1,$2,$3,25)`, [company, mat, wh])
const buy = await as(admin, () => q(`select * from copilot_purchase_suggestions()`))
ok('suggestion d’achat : seuil de sécurité non atteint → 25 à commander', buy.some((r) => r.kind === 'safety' && Number(r.qty) === 25))
await rejects('suggestions d’achat refusées sans droit d’achat', () => as(nobody, () => q(`select * from copilot_purchase_suggestions()`)), 'RBAC_FORBIDDEN')
await rejects('suggestions de production refusées sans droit de production', () => as(nobody, () => q(`select * from copilot_production_suggestions()`)), 'RBAC_FORBIDDEN')
