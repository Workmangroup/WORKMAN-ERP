import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql', '0022_finance.sql', '0023_executive.sql', '0024_copilot.sql', '0025_table_meta.sql', '0026_client_complaints.sql'])
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
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const c1 = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const c2 = (await as(admin, () => q(`insert into clients(name, country) values ('Bragard','FR') returning id`)))[0].id
const order = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [c1])))[0].id
const otherOrder = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [c2])))[0].id

const r1 = await as(comm, () => rpc('complaint_open', c1, order, 'Ourlets mal finis', 'Lot 12, 6 pièces', 'major'))
const row = (await q(`select number, status from client_complaints where id=$1`, [r1]))[0]
ok('réclamation ouverte : numéro REC-AAAA-000001, statut ouverte', /^REC-\d{4}-000001$/.test(row.number) && row.status === 'open')
await rejects('commande d’un autre client refusée', () => as(comm, () => rpc('complaint_open', c1, otherOrder, 'Erreur', null, 'minor')), 'COMPLAINT_ORDER_NOT_FOUND')
await rejects('objet trop court refusé', () => as(comm, () => rpc('complaint_open', c1, null, 'ab', null, 'minor')), 'check constraint')
await rejects('clôture directe refusée (pas encore résolue)', () => as(comm, () => rpc('complaint_update', r1, 'closed', null)), 'COMPLAINT_BAD_STATUS')
await rejects('résolution sans solution écrite refusée', () => as(comm, () => rpc('complaint_update', r1, 'resolved', 'ok')), 'COMPLAINT_RESOLUTION_REQUIRED')
await as(comm, () => rpc('complaint_update', r1, 'in_progress', null))
await as(comm, () => rpc('complaint_update', r1, 'resolved', 'Reprise des ourlets sur le lot 12'))
await as(comm, () => rpc('complaint_update', r1, 'closed', null))
ok('cycle complet : statut clos avec date de clôture', (await q(`select status, closed_at is not null c from client_complaints where id=$1`, [r1]))[0].c === true)
await rejects('réclamation close : nouvelle transition refusée', () => as(comm, () => rpc('complaint_update', r1, 'in_progress', null)), 'COMPLAINT_BAD_STATUS')
ok('réclamations visibles avec clients.read (commercial)', (await as(comm, () => q(`select count(*)::int n from client_complaints where client_id=$1`, [c1])))[0].n === 1)
ok('réclamations invisibles sans droit clients (aucune ligne)', (await as(nobody, () => q(`select count(*)::int n from client_complaints`)))[0].n === 0)
await rejects('ouverture par un magasinier (sans clients.write) refusée', () => as(mag, () => rpc('complaint_open', c1, null, 'Test droits', null, 'minor')), 'RBAC_FORBIDDEN')
