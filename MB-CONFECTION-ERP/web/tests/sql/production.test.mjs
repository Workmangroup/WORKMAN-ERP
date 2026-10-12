import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0019_production.sql', '0025_table_meta.sql'])
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
const prod = await mkUser('prod@x.com', 'production')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

const permsP = await perms('production')
// --- 0. Permissions ------------------------------------------------------------------------------------------------------------------
ok('production : lecture, saisie et planification', ['production.read', 'production.write', 'production.plan'].every((p) => (permsP).includes(p)))
ok('direction : lecture seule de la production', (await perms('direction')).includes('production.read') && !(await perms('direction')).includes('production.plan'))
ok('magasin : lecture seule de la production (aucune saisie ni planification)', (await perms('magasin')).includes('production.read') && !(await perms('magasin')).some((p) => p === 'production.write' || p === 'production.plan'))

// --- 1. Fixtures : client, article, postes -------------------------------------------------------------------------------------------
const client = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-HV-1','Veste HV','jacket') returning id`, [client])))[0].id
const wc1 = (await as(prod, () => q(`insert into work_centers(code, name, kind, hours_per_day, efficiency_pct) values ('COU-01','Couture 1','couture',8,85) returning id`)))[0].id
const wc2 = (await as(prod, () => q(`insert into work_centers(code, name, kind, hours_per_day, efficiency_pct) values ('FIN-01','Finition 1','finition',8,80) returning id`)))[0].id
await rejects('code de poste invalide refusé', () => as(prod, () => q(`insert into work_centers(code, name) values ('co u', 'Mauvais')`)), 'work_centers_code_check')
await rejects('magasinier ne crée pas de poste', () => as(mag, () => q(`insert into work_centers(code, name) values ('MAG-1', 'Intrus')`)), 'row-level security')

// Dates relatives à aujourd'hui (base de données)
const base = (await q(`select current_date::text d`))[0].d
const d = (n) => { const t = new Date(base + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }

// --- 2. Planification (Planifié) ------------------------------------------------------------------------------------------------------
const o1 = await as(prod, () => rpc('production_order_create', art, 100, 30, wc1, d(0), d(10), null, 'Lot test'))
const o1row = (await q(`select number, status, planned_start::text ps from production_orders where id=$1`, [o1]))[0]
ok('ordre créé : numéro OF-AAAA-000001 et statut Planifié', /^OF-\d{4}-000001$/.test(o1row.number) && o1row.status === 'planned')
const o2 = await as(prod, () => rpc('production_order_create', art, 40, 20, null, d(2), d(6), null, null))
await rejects('création par la direction (sans production.plan) refusée', () => as(dir, () => rpc('production_order_create', art, 10, 10, wc1, d(0), d(1), null, null)), 'RBAC_FORBIDDEN')
await rejects('dates inversées refusées', () => as(prod, () => rpc('production_order_create', art, 10, 10, wc1, d(5), d(1), null, null)), 'check constraint')
await rejects('article d’une autre société ou inconnu refusé', () => as(prod, () => rpc('production_order_create', '00000000-0000-0000-0000-000000000000', 10, 10, wc1, d(0), d(1), null, null)), 'PRODUCTION_ARTICLE_NOT_FOUND')
await as(prod, () => rpc('production_order_reschedule', o1, wc1, d(0), d(12), 100, 30))
ok('replanification avant lancement : nouvelle date de fin', (await q(`select planned_end::text e from production_orders where id=$1`, [o1]))[0].e === d(12))
await rejects('lancement sans poste refusé', () => as(prod, () => rpc('production_order_launch', o2)), 'PRODUCTION_WORK_CENTER_REQUIRED')
await rejects('saisie de suivi sur ordre planifié refusée', () => as(prod, () => rpc('production_order_log', o1, d(0), 2, 5, 0, null)), 'PRODUCTION_BAD_STATUS')

// --- 3. Lancement, suivi, suspension ----------------------------------------------------------------------------------------------------
await as(prod, () => rpc('production_order_launch', o1))
ok('lancement : statut Lancé', (await q(`select status from production_orders where id=$1`, [o1]))[0].status === 'launched')
await rejects('replanification après lancement refusée', () => as(prod, () => rpc('production_order_reschedule', o1, wc1, d(0), d(9), 100, 30)), 'PRODUCTION_BAD_STATUS')
await as(prod, () => rpc('production_order_log', o1, d(0), 4, 30, 2, 'Première demi-journée'))
ok('première saisie : statut En cours', (await q(`select status from production_orders where id=$1`, [o1]))[0].status === 'in_progress')
await rejects('saisie sans quantité refusée', () => as(prod, () => rpc('production_order_log', o1, d(0), 1, 0, 0, null)), 'PRODUCTION_BAD_QTY')
await rejects('saisie au-delà de la quantité planifiée refusée', () => as(prod, () => rpc('production_order_log', o1, d(0), 1, 80, 0, null)), 'PRODUCTION_QTY_EXCEEDED')
await rejects('saisie datée dans le futur refusée', () => as(prod, () => rpc('production_order_log', o1, d(3), 1, 5, 0, null)), 'PRODUCTION_BAD_DATE')
await rejects('suspension sans motif refusée', () => as(prod, () => rpc('production_order_suspend', o1, 'x')), 'PRODUCTION_REASON_REQUIRED')
await as(prod, () => rpc('production_order_suspend', o1, 'Panne machine'))
ok('suspension : statut Suspendu', (await q(`select status from production_orders where id=$1`, [o1]))[0].status === 'suspended')
await rejects('saisie pendant la suspension refusée', () => as(prod, () => rpc('production_order_log', o1, d(0), 1, 5, 0, null)), 'PRODUCTION_BAD_STATUS')
await as(prod, () => rpc('production_order_resume', o1))
ok('reprise : retour En cours (saisies existantes)', (await q(`select status from production_orders where id=$1`, [o1]))[0].status === 'in_progress')
await as(prod, () => rpc('production_order_log', o1, d(0), 3, 40, 1, 'Après-midi'))

// --- 4. Terminer, clôturer ---------------------------------------------------------------------------------------------------------------
await as(prod, () => rpc('production_order_reschedule', o2, wc2, d(2), d(6), 40, 20))
await as(prod, () => rpc('production_order_launch', o2))
await rejects('terminer sans saisie de suivi refusé', () => as(prod, () => rpc('production_order_finish', o2)), 'PRODUCTION_NO_LOG')
await rejects('clôture d’un ordre non terminé refusée', () => as(prod, () => rpc('production_order_close', o1)), 'PRODUCTION_BAD_STATUS')
await as(prod, () => rpc('production_order_finish', o1))
ok('fin de l’ordre : statut Terminé', (await q(`select status from production_orders where id=$1`, [o1]))[0].status === 'done')
await rejects('clôture par la direction refusée', () => as(dir, () => rpc('production_order_close', o1)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('production_order_close', o1))
ok('clôture : ordre verrouillé', (await q(`select closed_at is not null c from production_orders where id=$1`, [o1]))[0].c === true)
await rejects('clôture déjà faite : refusée', () => as(prod, () => rpc('production_order_close', o1)), 'PRODUCTION_BAD_STATUS')
await rejects('saisie après clôture refusée', () => as(prod, () => rpc('production_order_log', o1, d(0), 1, 5, 0, null)), 'PRODUCTION_BAD_STATUS')
await rejects('journal de suivi immuable', () => db.query(`update production_logs set hours = 9`), 'PRODUCTION_IMMUTABLE')

// --- 5. Retard : ordre planifié dont l'échéance est dépassée -------------------------------------------------------------------------
const o3 = await as(prod, () => rpc('production_order_create', art, 10, 30, wc1, d(-10), d(-5), null, null))
await as(prod, () => rpc('production_order_reschedule', o3, wc1, d(-10), d(-5), 10, 30))

// --- 6. Calculs : rendement, productivité, retards, charge --------------------------------------------------------------------------
const m1 = (await as(dir, () => q(`select * from production_order_metrics where id=$1`, [o1])))[0]
ok('métriques : heures planifiées = 100 × 30 min ÷ 60 = 50', Number(m1.planned_hours) === 50)
ok('métriques : quantité bonne 70, rebut 3 (saisies cumulées)', Number(m1.qty_good) === 70 && Number(m1.qty_scrap) === 3)
ok('rendement = 70 ÷ 73 = 95,9 %', Number(m1.yield_pct) === 95.9)
ok('productivité = 70 ÷ 7 h = 10 pièces par heure', Number(m1.productivity) === 10)
ok('ordre terminé dans les temps : retard 0', Number(m1.late_days) === 0)
const m3 = (await as(dir, () => q(`select * from production_order_metrics where id=$1`, [o3])))[0]
ok('ordre non lancé dépassé : retard de 5 jours', Number(m3.late_days) === 5)
const dash = await as(dir, () => rpc('production_dashboard'))
ok('tableau de bord : un ordre en retard ouvert', dash.late === 1)
ok('tableau de bord : ordres ouverts et clôturés comptés', dash.open === 2 && dash.closed === 1)
ok('tableau de bord : statuts par état (planifié 1, lancé 1)', dash.by_status.planned === 1 && dash.by_status.launched === 1 && dash.by_status.done === undefined)
const wl = dash.workload.find((w) => w.code === 'COU-01')
ok('charge atelier COU-01 : 5 h ouvertes, capacité 6,8 h/j, 0,7 jour de charge', wl && wl.open_hours === 5 && wl.capacity_hours_per_day === 6.8 && wl.load_days === 0.7 && wl.overloaded === false)
ok('rendement et productivité par poste (COU-01)', wl.yield_pct === 95.9 && wl.productivity === 10)
ok('liste des retards triée : premier ordre en retard de 5 jours', dash.late_orders[0].late_days === 5 && dash.late_orders[0].id === o3)
const nobody = await mkUser('nobody@x.com', null)
await rejects('tableau de bord refusé sans aucun droit de production', () => as(nobody, () => rpc('production_dashboard')), 'RBAC_FORBIDDEN')
ok('ordre 2 non en retard (échéance future)', Number((await q(`select late_days from production_order_metrics where id=$1`, [o2]))[0].late_days) === 0)
