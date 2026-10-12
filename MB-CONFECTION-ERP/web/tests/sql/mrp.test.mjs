import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b) => Math.abs(Number(a) - b) < 0.00005
const day = (n) => (n === 0 ? 'current_date' : `current_date + ${n}`)
const dateOf = async (n) => (await q(`select (current_date + $1::int)::text d`, [n]))[0].d

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const prod = await mkUser('prod@x.com', 'production')
const achat = await mkUser('achat@x.com', 'achat')
const mag = await mkUser('mag@x.com', 'magasin')
const qual = await mkUser('qual@x.com', 'qualite')
const fin = await mkUser('fin@x.com', 'finance')

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
ok('mrp.write : production et achat ; lecture : commercial, magasin, direction', (await perms('production')).includes('mrp.write') && (await perms('achat')).includes('mrp.write')
  && (await perms('commercial')).includes('mrp.read') && !(await perms('commercial')).includes('mrp.write') && (await perms('magasin')).includes('mrp.read') && (await perms('direction')).includes('mrp.read'))
ok('finance : pas d’accès au MRP', !(await perms('finance')).includes('mrp.read'))

// --- Données : client, articles, composants, BOM validées, stock -------------------------------------------------------------------
const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const art = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT001','LAF-1','Veste HV','jacket') returning id`, [lafont])))[0].id
const artNoBom = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'PNT001','LAF-2','Pantalon sans BOM','trousers') returning id`, [lafont])))[0].id
const mat = async (name, unit, cost) => {
  const m = (await as(prod, () => q(`insert into bom_materials(name, category, unit) values ($1,'fabric',$2) returning *`, [name, unit])))[0]
  await as(achat, () => db.query(`insert into bom_material_prices(material_id, unit_cost) values ($1,$2)`, [m.id, cost]))
  return m
}
const tissu = await mat('Tissu jaune HV', 'm', 8.5)
const zip = await mat('Zip 60 cm', 'pc', 1.2)
const idle = await mat('Étiquette stock bas', 'pc', 0.05)
const mkBom = async (name, kind, article) => (await as(prod, () => q(`insert into boms(name, kind, article_id) values ($1,$2,$3) returning *`, [name, kind, article])))[0]
const ver = async (bom) => (await q(`select id from bom_versions where bom_id=$1 and version_no=1`, [bom]))[0].id
const line = (v, m, qty, w = 0) => as(prod, () => db.query(`insert into bom_lines(version_id,line_type,material_id,quantity,waste_pct) values ($1,'material',$2,$3,$4)`, [v, m, qty, w]))
const capuche = await mkBom('Capuche', 'subassembly', null)
const capV = await ver(capuche.id)
await line(capV, tissu.id, 0.5)
await as(qual, () => rpc('bom_validate_version', capV, null))
const veste = await mkBom('Veste HV', 'product', art)
const vV = await ver(veste.id)
await line(vV, tissu.id, 2); await line(vV, zip.id, 1)
await as(prod, () => db.query(`insert into bom_lines(version_id,line_type,child_bom_id,quantity) values ($1,'bom',$2,1)`, [vV, capuche.id]))
await as(qual, () => rpc('bom_validate_version', vV, null))
// unitaire : tissu 2 + 0,5 (capuche) = 2,5 m ; zip 1

const wh = (await q(`insert into warehouses(company_id, name) values ((select id from companies limit 1), 'Magasin') returning id`))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ((select id from companies limit 1), $1, $2, 'manager')`, [mag, wh])   // création réservée à l'admin : l'affectation du responsable se fait ici
const loc = (await q(`select id from stock_locations where warehouse_id=$1`, [wh]))[0].id
const mv = (type, m, qty) => as(mag, () => db.query(`select public.stock_move(p_type=>$1, p_material=>$2, p_qty=>$3, p_warehouse=>$4, p_location=>$5)`, [type, m, qty, wh, loc]))
await mv('in', tissu.id, 100); await mv('in', zip.id, 50)
await as(mag, () => rpc('stock_set_safety', tissu.id, wh, 20))
await as(mag, () => rpc('stock_set_safety', idle.id, wh, 10))

// --- 1. Commandes client (socle) --------------------------------------------------------------------------------------------------------
const mkOrder = (u, ref) => as(u, async () => (await q(`insert into sales_orders(client_id, client_ref) values ($1,$2) returning *`, [lafont, ref]))[0])
const addLine = (u, order, article, qty, days) => as(u, async () => (await q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,$3,${day(days)}) returning *`, [order, article, qty]))[0])
const o1 = await mkOrder(comm, 'PO-LAF-100')
ok('commande créée : code CMD-0001, brouillon', o1.code === 'CMD-0001' && o1.status === 'draft' && o1.created_by === comm)
await rejects('commande : refusée sans orders.write (production)', () => mkOrder(prod, 'X'), 'row-level security')
await addLine(comm, o1.id, art, 30, 30)
await rejects('ligne : article d’un autre client refusé', async () => { const other = (await as(comm, () => q(`insert into clients(name,country) values ('Bragard','FR') returning id`)))[0].id; const a2 = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'BRG1','B-1','Blouse','shirt') returning id`, [other])))[0].id; await addLine(comm, o1.id, a2, 1, 5) }, 'ORDER_BAD_ARTICLE')
await rejects('ligne : quantité nulle refusée', () => addLine(comm, o1.id, art, 0, 5), 'qty')
await rejects('confirmation refusée sans orders.confirm (production)', () => as(prod, () => rpc('sales_order_confirm', o1.id)), 'RBAC_FORBIDDEN')
const empty = await mkOrder(comm, 'VIDE')
await rejects('confirmation refusée : commande vide', () => as(comm, () => rpc('sales_order_confirm', empty.id)), 'ORDER_EMPTY')
await as(comm, () => rpc('sales_order_confirm', o1.id))
ok('commande confirmée', (await q(`select status, confirmed_by from sales_orders where id=$1`, [o1.id]))[0].status === 'confirmed')
await rejects('commande confirmée : ajout de ligne refusé', () => addLine(comm, o1.id, art, 1, 5), 'ORDER_LOCKED')
await rejects('commande confirmée : modification refusée', () => as(comm, () => db.query(`update sales_orders set notes='x' where id=$1`, [o1.id])), 'ORDER_LOCKED')
await rejects('double confirmation refusée', () => as(comm, () => rpc('sales_order_confirm', o1.id)), 'ORDER_BAD_STATUS')
const o2 = await mkOrder(comm, 'PO-LAF-101'); await addLine(comm, o2.id, art, 20, 10); await as(comm, () => rpc('sales_order_confirm', o2.id))
const o3 = await mkOrder(comm, 'PO-LAF-DRAFT'); await addLine(comm, o3.id, art, 100, 20)         // brouillon : exclu par défaut
const o4 = await mkOrder(comm, 'PO-ANNULE'); await addLine(comm, o4.id, art, 500, 5); await as(comm, () => rpc('sales_order_confirm', o4.id)); await as(comm, () => rpc('sales_order_set_status', o4.id, 'cancelled'))
ok('commande annulée', (await q(`select status from sales_orders where id=$1`, [o4.id]))[0].status === 'cancelled')
await rejects('livraison refusée sur une commande non confirmée', () => as(comm, () => rpc('sales_order_set_status', o3.id, 'delivered')), 'ORDER_BAD_STATUS')

// prévision
await rejects('prévision refusée sans mrp.write (commercial)', () => as(comm, () => db.query(`insert into mrp_forecasts(article_id, forecast_date, qty) values ($1, ${day(60)}, 10)`, [art])), 'row-level security')
await as(prod, () => db.query(`insert into mrp_forecasts(article_id, forecast_date, qty, note) values ($1, ${day(60)}, 10, 'Saison hiver')`, [art]))
ok('prévision enregistrée (lecture : commercial)', (await as(comm, () => q(`select * from mrp_forecasts`))).length === 1 && (await as(fin, () => q(`select * from mrp_forecasts`))).length === 0)

// --- 2. Simulation par défaut -------------------------------------------------------------------------------------------------------------
await rejects('simulation refusée sans mrp.write (magasin, commercial)', () => as(mag, () => rpc('mrp_run', 'X', {})), 'RBAC_FORBIDDEN')
const run1 = await as(prod, () => rpc('mrp_run', 'Simulation de base', {}))
const R = async (run, m) => (await q(`select * from mrp_run_materials where run_id=$1 and material_id=$2`, [run, m]))[0]
const runRow = (await q(`select * from mrp_runs where id=$1`, [run1]))[0]
ok('simulation : code MRP-0001, paramètres par défaut figés', runRow.code === 'MRP-0001' && runRow.params.horizon_days === 90 && runRow.params.offset_days === 7 && runRow.params.include_forecasts === true && runRow.created_by === prod)
const t1 = await R(run1, tissu.id), z1 = await R(run1, zip.id)
// besoin brut : 20×2,5 + 30×2,5 + 10×2,5 (prévision) = 150 m ; zip 60
ok('besoin brut = explosion multi-niveaux (tissu 2 + 0,5 capuche = 2,5 m par veste) : 150 m ; zip 60', near(t1.gross, 150) && near(z1.gross, 60))
ok('commande brouillon et commande annulée exclues du besoin', near(t1.gross, 150))
ok('stock repris : en stock 100, réservé 0, sécurité 20', near(t1.on_hand, 100) && near(t1.reserved, 0) && near(t1.safety, 20))
// tissu : +3 → 50 ; +23 → −25 (< sécurité 20 ⇒ commander 45) ; +53 → −5 ⇒ commander 25
ok('besoin net tissu = 45 + 25 = 70 (sécurité incluse) ; suggestion 70', near(t1.net, 70) && near(t1.suggested, 70))
ok('alerte tissu = high', t1.alert === 'high')
const dShort = (await q(`select (shortage_date = current_date + 23) ok from mrp_run_materials where run_id=$1 and material_id=$2`, [run1, tissu.id]))[0].ok
ok('date de rupture = J+23 (commande J+30 − 7 j de production)', dShort === true)
ok('zip : besoin net 10 (rupture à J+53), alerte high', near(z1.net, 10) && near(z1.suggested, 10) && z1.alert === 'high')
const sugg = await q(`select qty::float q, (need_date - current_date) nd, (release_date - current_date) rd, late from mrp_run_suggestions where run_id=$1 and material_id=$2 order by need_date`, [run1, tissu.id])
ok('suggestions tissu : 45 m pour J+23 (à commander avant J+9), 25 m pour J+53 (avant J+39), aucune en retard', sugg.length === 2 && sugg[0].q === 45 && sugg[0].nd === 23 && sugg[0].rd === 9 && sugg[1].q === 25 && sugg[1].rd === 39 && sugg.every((s) => !s.late))
const idleR = await R(run1, idle.id)
ok('composant sous son stock de sécurité sans aucune demande : suggestion de réassort (10), alerte low, commande déjà en retard', idleR && near(idleR.suggested, 10) && idleR.alert === 'low' && (await q(`select late from mrp_run_suggestions where run_id=$1 and material_id=$2`, [run1, idle.id]))[0].late === true)
const tl = t1.timeline
ok('projection datée : stock projeté J0=100, J+3=50, J+23=20 (après commande), J+53=20', tl.length === 4 && near(tl[0].projected, 100) && near(tl[1].projected, 50) && near(tl[2].projected, 20) && near(tl[3].projected, 20) && near(tl[2].planned, 45))
const peg = await q(`select source_type, count(*)::int n, sum(qty)::float q from mrp_run_pegging where run_id=$1 and material_id=$2 group by 1 order by 1`, [run1, tissu.id])
ok('pegging : chaque besoin renvoie à sa commande / prévision (2 commandes + 1 prévision)', peg.map((p) => `${p.source_type}:${p.n}:${p.q}`).join() === 'forecast:1:25,order:2:125')
ok('résumé : 3 composants, 0 critique, 2 high, 1 low, suggestions comptées', runRow.summary.materials === 3 && runRow.summary.critical === 0 && runRow.summary.high === 2 && runRow.summary.low === 1 && runRow.summary.suggestions === 4)

// --- 3. Variantes de simulation ---------------------------------------------------------------------------------------------------------
const noFc = await as(prod, () => rpc('mrp_run', 'Sans prévisions', { include_forecasts: false }))
ok('sans prévisions : besoin brut 125 m', near((await R(noFc, tissu.id)).gross, 125))
const withDraft = await as(prod, () => rpc('mrp_run', 'Avec brouillons', { include_draft_orders: true, include_forecasts: false }))
ok('avec commandes brouillon : besoin brut 125 + 250 = 375 m', near((await R(withDraft, tissu.id)).gross, 375))
const noSafe = await as(prod, () => rpc('mrp_run', 'Sans sécurité', { use_safety: false }))
const ns = await R(noSafe, tissu.id)
ok('sans stock de sécurité : besoin net tissu 25 + 25 = 50 (seuil à 0), composant sans demande absent', near(ns.net, 50) && near(ns.safety, 0) && !(await R(noSafe, idle.id)))
const shortH = await as(prod, () => rpc('mrp_run', 'Horizon court', { horizon_days: 20, include_forecasts: false }))
const sh = await R(shortH, tissu.id)
ok('horizon 20 jours : seule la commande proche (50 m), aucune rupture', near(sh.gross, 50) && sh.shortage_date === null && near(sh.suggested, 0))
const offs = await as(prod, () => rpc('mrp_run', 'Production 30 j', { offset_days: 30, include_forecasts: false }))
ok('délai de production 30 j : les besoins se rapprochent (date de rupture J+0 → critique)', (await R(offs, tissu.id)).alert === 'critical')

// --- 4. Réservations, réceptions, MOQ, délais -----------------------------------------------------------------------------------------
await as(mag, () => rpc('stock_reserve', tissu.id, wh, 40, 'OF-EN-COURS'))
const resv = await as(prod, () => rpc('mrp_run', 'Avec réservation', { include_forecasts: false }))
const rr = await R(resv, tissu.id)
ok('stock réservé retiré du disponible : projection de départ 60 → besoin net augmenté', near(rr.reserved, 40) && near(rr.net, 85), `net=${rr.net}`)
const resId = (await q(`select id from stock_reservations`))[0].id
await as(mag, () => rpc('stock_release', resId))
await as(prod, () => db.query(`insert into mrp_scheduled_receipts(material_id, qty, due_date, reference) values ($1, 200, ${day(15)}, 'PO-2026-001')`, [tissu.id]))
const withRec = await as(prod, () => rpc('mrp_run', 'Avec réception', { include_forecasts: false }))
const wr = await R(withRec, tissu.id)
ok('réception planifiée de 200 m à J+15 : plus de rupture ni de suggestion', near(wr.receipts, 200) && wr.shortage_date === null && near(wr.suggested, 0) && wr.alert === null)
await as(prod, () => db.query(`delete from mrp_scheduled_receipts`))

await as(prod, () => db.query(`insert into mrp_params(material_id, lead_time_days, moq, order_multiple) values ($1, 40, 100, 50)`, [tissu.id]))
const moq = await as(prod, () => rpc('mrp_run', 'MOQ et délai', { include_forecasts: false }))
const mq = await R(moq, tissu.id)
const ms = await q(`select qty::float q, late, release_date < current_date as past from mrp_run_suggestions where run_id=$1 and material_id=$2`, [moq, tissu.id])
ok('MOQ 100 / multiple 50 : un besoin de 45 m devient une commande de 100 m ; délai 40 j', near(mq.suggested, 100) && near(mq.moq, 100) && mq.lead_time_days === 40 && ms.length === 1 && ms[0].q === 100)
ok('délai 40 j > temps restant : suggestion en retard et alerte critique', ms[0].late === true && ms[0].past === true && mq.alert === 'critical')
await as(prod, () => db.query(`update mrp_params set moq=0, order_multiple=30, lead_time_days=null where material_id=$1`, [tissu.id]))
const mult = await as(prod, () => rpc('mrp_run', 'Multiple 30', { include_forecasts: false }))
ok('multiple de 30 : 45 m → 60 m', near((await R(mult, tissu.id)).suggested, 60))
await rejects('paramètres refusés sans mrp.write', () => as(mag, () => db.query(`update mrp_params set moq=5 where material_id=$1`, [tissu.id])).then((r) => { if (!r.affectedRows) throw new Error('row-level security') }), 'row-level security')
await rejects('MOQ négatif refusé', () => as(prod, () => db.query(`update mrp_params set moq=-1 where material_id=$1`, [tissu.id])), 'moq')

// délai fournisseur utilisé par défaut
const sup = (await as(achat, () => q(`insert into suppliers(name, country, lead_time_days) values ('Tissus du Sud','TN',21) returning id`)))[0].id
await as(prod, () => db.query(`update bom_materials set supplier_id=$2 where id=$1`, [zip.id, sup]))
const supRun = await as(prod, () => rpc('mrp_run', 'Délai fournisseur', { include_forecasts: false }))
const zs = await R(supRun, zip.id)
ok('délai du fournisseur (21 j) repris, fournisseur porté par la suggestion', zs.lead_time_days === 21 && zs.supplier_id === sup)

// --- 5. Nomenclature manquante ---------------------------------------------------------------------------------------------------------------
const o5 = await mkOrder(comm, 'PO-SANS-BOM'); await addLine(comm, o5.id, artNoBom, 15, 12); await as(comm, () => rpc('sales_order_confirm', o5.id))
const nb = await as(prod, () => rpc('mrp_run', 'Avec article sans BOM', { include_forecasts: false }))
const w = (await q(`select summary from mrp_runs where id=$1`, [nb]))[0].summary.warnings
ok('article sans BOM validée signalé dans la simulation (no_bom, 15 pièces)', w.length === 1 && w[0].issue === 'no_bom' && w[0].ref === 'PNT001' && Number(w[0].qty) === 15)
// commande en retard : besoin immédiat
const o6 = await mkOrder(comm, 'PO-RETARD'); await addLine(comm, o6.id, art, 4, -5); await as(comm, () => rpc('sales_order_confirm', o6.id))
const late = await as(prod, () => rpc('mrp_run', 'Commande en retard', { include_forecasts: false }))
ok('commande déjà en retard : besoin à la date du jour', (await q(`select count(*)::int n from mrp_run_pegging where run_id=$1 and material_id=$2 and need_date=current_date and demand_qty=4`, [late, tissu.id]))[0].n === 1)

// --- 6. Décisions, droits, isolation ------------------------------------------------------------------------------------------------------
const s1 = (await q(`select id from mrp_run_suggestions where run_id=$1 and material_id=$2 limit 1`, [run1, tissu.id]))[0].id
await rejects('décision refusée sans mrp.write (magasin)', () => as(mag, () => rpc('mrp_suggestion_decide', s1, 'accepted')), 'RBAC_FORBIDDEN')
await rejects('statut de décision invalide', () => as(achat, () => rpc('mrp_suggestion_decide', s1, 'perdu')), 'MRP_BAD_STATUS')
await as(achat, () => rpc('mrp_suggestion_decide', s1, 'accepted', 'Commande passée chez Tissus du Sud'))
const dec = (await q(`select status, decided_by, note from mrp_run_suggestions where id=$1`, [s1]))[0]
ok('suggestion acceptée (qui, quand, note)', dec.status === 'accepted' && dec.decided_by === achat && dec.note.includes('Tissus'))
await rejects('résultats non modifiables directement', () => as(achat, () => db.query(`update mrp_run_suggestions set qty=1 where id=$1`, [s1])), 'permission denied')
await rejects('résultats non insérables directement', () => as(admin, () => db.query(`insert into mrp_runs(name, as_of) values ('faux', current_date)`)), 'permission denied')
ok('lecture des résultats : commercial et magasin oui, finance non', (await as(comm, () => q(`select id from mrp_runs`))).length >= 1 && (await as(mag, () => q(`select material_id from mrp_run_materials`))).length >= 1 && (await as(fin, () => q(`select id from mrp_runs`))).length === 0)
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
await db.query(`insert into mrp_runs(company_id, code, name, as_of) values ($1,'MRP-9001','Étrangère', current_date)`, [co2])
ok('isolation : simulation d’une autre société invisible', (await as(admin, () => q(`select id from mrp_runs where code='MRP-9001'`))).length === 0)
const before = (await q(`select count(*)::int n from mrp_runs`))[0].n
await as(prod, () => rpc('mrp_run_delete', noFc))
ok('suppression d’une simulation (résultats en cascade)', (await q(`select count(*)::int n from mrp_runs`))[0].n === before - 1 && (await q(`select count(*)::int n from mrp_run_materials where run_id=$1`, [noFc]))[0].n === 0)
await rejects('suppression refusée sans mrp.write', () => as(mag, () => rpc('mrp_run_delete', run1)), 'RBAC_FORBIDDEN')

// --- 7. Historique -------------------------------------------------------------------------------------------------------------------------------
const h = await q(`select action from audit_logs where entity_type in ('mrp','order')`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['mrp.run', 'mrp.decide', 'mrp.delete', 'order.create', 'order.confirm', 'order.cancel']) ok(`historique : ${a}`, acts.has(a))
ok('historique MRP lisible avec mrp.read, pas sans', (await as(mag, () => q(`select id from audit_logs where entity_type='mrp'`))).length > 0 && (await as(fin, () => q(`select id from audit_logs where entity_type='mrp'`))).length === 0)
ok('historique commandes lisible avec orders.read', (await as(comm, () => q(`select id from audit_logs where entity_type='order'`))).length > 0)

process.exit(process.exitCode ?? 0)
