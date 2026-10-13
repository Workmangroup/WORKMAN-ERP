// MRP et planification : stock bloqué et périmé exclus, réservations liées sans double comptage, conversions,
// lignes restreintes, réconciliation, explication, propositions d'OF sans engagement — P046 / migration 0071
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, eps = 0.0005) => Math.abs(Number(a) - b) < eps
const day = (n) => `current_date + ${n}`

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
const nobody = await mkUser('nobody@x.com', null)
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))

// --- Référentiel ----------------------------------------------------------------------------------------------------------------------------
const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT P46','FR') returning id`)))[0].id
const artA = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT46A','LAF-A','Veste A','jacket') returning id`, [lafont])))[0].id
const artB = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT46B','LAF-B','Veste B (cm)','jacket') returning id`, [lafont])))[0].id
const artC = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT46C','LAF-C','Veste C (taille)','jacket') returning id`, [lafont])))[0].id
const artNoBom = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'PNT46','LAF-P','Pantalon sans BOM','trousers') returning id`, [lafont])))[0].id
await db.query(`insert into sizes(company_id, code, label, size_group, sort_order) select $1,'M','M','other',500 where not exists (select 1 from sizes where company_id=$1 and code='M')`, [company])

const mat = async (name, unit, cost) => {
  const m = (await as(prod, () => q(`insert into bom_materials(name, category, unit) values ($1,'fabric',$2) returning *`, [name, unit])))[0]
  await as(achat, () => db.query(`insert into bom_material_prices(material_id, unit_cost) values ($1,$2)`, [m.id, cost]))
  return m
}
const tissu = await mat('Tissu P46', 'm', 8.5)
const zip = await mat('Zip P46', 'pc', 1.2)
const ruban = await mat('Ruban P46', 'm', 2)
const bouton = await mat('Bouton P46 (lot périmé)', 'pc', 0.1)
const mkBom = async (name, article) => (await as(prod, () => q(`insert into boms(name, kind, article_id) values ($1,'product',$2) returning *`, [name, article])))[0]
const verOf = async (bom) => (await q(`select id from bom_versions where bom_id=$1 and version_no=1`, [bom]))[0].id
const addLine = (v, m, qty, waste = 0) => as(prod, () => q(`insert into bom_lines(version_id,line_type,material_id,quantity,waste_pct) values ($1,'material',$2,$3,$4) returning id`, [v, m, qty, waste]))

// A : 2 m de tissu + 1 zip par pièce
const bomA = await mkBom('Veste A', artA); const vA = await verOf(bomA.id)
await addLine(vA, tissu.id, 2); await addLine(vA, zip.id, 1)
// B : ruban saisi en cm (150 cm = 1,5 m par pièce), conversion cm → m
const bomB = await mkBom('Veste B', artB); const vB = await verOf(bomB.id)
const lineB = (await addLine(vB, ruban.id, 150))[0].id
await as(prod, () => rpc('bom_unit_conversion_set', ruban.id, 'cm', 'm', 0.01))
await as(prod, () => rpc('bom_line_set_attributes', lineB, 'cm', null, null))
// C : zip (sans restriction) + ruban restreint à la taille M (non compté : aucune taille fournie au MRP)
const bomC = await mkBom('Veste C', artC); const vC = await verOf(bomC.id)
await addLine(vC, zip.id, 1)
const lineC = (await addLine(vC, ruban.id, 100))[0].id
await as(prod, () => rpc('bom_line_set_attributes', lineC, null, 'M', null))
await as(qual, () => rpc('bom_validate_version', vA, 'Fiche A conforme'))
await as(qual, () => rpc('bom_validate_version', vB, 'Fiche B conforme'))
await as(qual, () => rpc('bom_validate_version', vC, 'Fiche C conforme'))

// --- Emplacements et stock -------------------------------------------------------------------------------------------------------------------
const wh = (await q(`insert into warehouses(company_id, name) values ($1, 'Magasin P46') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1, $2, $3, 'manager')`, [company, mag, wh])
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and kind='storage' limit 1`, [wh]))[0].id
const quar = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUAR46','Quarantaine','quarantine') returning id`, [company, wh]))[0].id
const mv = (type, m, qty, location) => as(mag, () => db.query(`select public.stock_move(p_type=>$1, p_material=>$2, p_qty=>$3, p_warehouse=>$4, p_location=>$5)`, [type, m, qty, wh, location]))
await mv('in', tissu.id, 100, loc)              // stock utilisable
await mv('in', tissu.id, 30, quar)              // stock bloqué (quarantaine) : ne doit jamais être compté
await mv('in', zip.id, 50, loc)
await mv('in', ruban.id, 500, loc)
// lot périmé : reçu avec une date future, puis daté dans le passé (accès direct de test)
await as(mag, () => db.query(`select public.stock_receive_lot(p_material=>$1, p_warehouse=>$2, p_location=>$3, p_qty=>20, p_lot_code=>'BTN-OLD', p_expiry=>(current_date + 30)::date, p_reference=>'REC-P46', p_reason=>null, p_unit_cost=>0.1)`, [bouton.id, wh, loc]))
await db.query(`update stock_lots set expiry_date = current_date - 1 where material_id=$1`, [bouton.id])
await as(mag, () => rpc('stock_set_safety', tissu.id, wh, 120))
await as(mag, () => rpc('stock_set_safety', bouton.id, wh, 10))

// --- Commandes confirmées -----------------------------------------------------------------------------------------------------------------------
const mkOrder = (ref) => as(comm, async () => (await q(`insert into sales_orders(client_id, client_ref) values ($1,$2) returning *`, [lafont, ref]))[0])
const addOl = (order, article, qty, days) => as(comm, async () => (await q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,$3,${day(days)}) returning *`, [order, article, qty]))[0])
const o1 = await mkOrder('PO-P46-1')
const lA = await addOl(o1.id, artA, 5, 30)
const lB = await addOl(o1.id, artB, 4, 30)
const lC = await addOl(o1.id, artC, 2, 30)
await addOl(o1.id, artNoBom, 3, 30)
await as(comm, () => rpc('sales_order_confirm', o1.id))

const R = async (run, m) => (await q(`select * from mrp_run_materials where run_id=$1 and material_id=$2`, [run, m]))[0]
const countPO = async () => Number((await q(`select (select count(*) from purchase_orders)::int + (select count(*) from production_orders)::int n`))[0].n)
const poBefore = await countPO()

// --- 1. Stock bloqué et périmé exclus ----------------------------------------------------------------------------------------------------------
const r1 = await as(prod, () => rpc('mrp_run', 'Sans réservation', { include_forecasts: false }))
const t1 = await R(r1, tissu.id)
ok('stock bloqué (quarantaine 30) exclu du disponible : disponible 100, total des lots 130', near(t1.on_hand, 100) && near(t1.quarantine_excluded, 30) && near(t1.total_lots, 130))
const sq1 = (await q(`select coalesce(sum(qty),0)::float q from mrp_run_suggestions where run_id=$1 and material_id=$2`, [r1, tissu.id]))[0].q
ok('quarantaine exclue : stock 100, besoin 10, sécurité 120 → proposition totale de 30 (20 aujourd’hui, 10 à J+23)', near(sq1, 30))
const rb = await R(r1, bouton.id)
ok('lot périmé exclu : 20 pièces hors disponible, disponible 0', near(rb.expired_excluded, 20) && near(rb.on_hand, 0) && near(rb.total_lots, 20))
ok('simulation réconciliée (résumé et contrôle)', (await q(`select summary from mrp_runs where id=$1`, [r1]))[0].summary.reconciled === true
  && (await as(prod, () => rpc('mrp_run_reconcile', r1))).ok === true)

// --- 2. Conversion d'unité et lignes restreintes ------------------------------------------------------------------------------------------------
const tr = await R(r1, ruban.id)
ok('conversion : 4 vestes × 150 cm = 6 m de ruban (et non 600)', near(tr.gross, 6))
ok('ligne restreinte à la taille M non comptée sans taille fournie, article signalé', near(tr.gross, 6)
  && (await q(`select summary from mrp_runs where id=$1`, [r1]))[0].summary.warnings.some((w) => w.issue === 'restricted_lines' && w.ref === 'JKT46C'))
ok('zip : 5 pièces (veste A) + 2 pièces (veste C, ligne sans restriction)', near((await R(r1, zip.id)).gross, 7))
ok('article sans nomenclature signalé (no_bom), aucun besoin inventé', (await q(`select summary from mrp_runs where id=$1`, [r1]))[0].summary.warnings.some((w) => w.issue === 'no_bom' && w.ref === 'PNT46'))

// --- 3. Réservations : liées (couvertes une seule fois) et non liées -------------------------------------------------------------------------------
const res = await as(mag, () => rpc('stock_reserve', tissu.id, wh, 10, 'CMD-PO-P46-1', 'Réservé pour la veste A'))
await as(mag, () => rpc('stock_reservation_link_order_line', res, lA.id))
const r2 = await as(prod, () => rpc('mrp_run', 'Réservation liée', { include_forecasts: false }))
const t2 = await R(r2, tissu.id)
ok('réservation liée à la ligne A : couvre les 10 m du besoin, comptée une seule fois', near(t2.reserved, 10) && near(t2.covered_qty, 10) && near(t2.gross, 10))
const s2 = (await q(`select coalesce(sum(qty),0)::float q from mrp_run_suggestions where run_id=$1 and material_id=$2`, [r2, tissu.id]))[0].q
ok('réservation liée : proposition 30 m (100 − 10 + 10 − 10 = 90 projeté, sécurité 120)', s2 === 30 && near(t2.projected_end, 120))
await as(mag, () => rpc('stock_reservation_link_order_line', res, null))
const r3 = await as(prod, () => rpc('mrp_run', 'Réservation non liée', { include_forecasts: false }))
const s3 = (await q(`select coalesce(sum(qty),0)::float q from mrp_run_suggestions where run_id=$1 and material_id=$2`, [r3, tissu.id]))[0].q
ok('même réservation non liée : proposition 40 m (double comptage = 10 m de plus, attendu)', s3 === 40 && near((await R(r3, tissu.id)).covered_qty, 0))
await as(mag, () => rpc('stock_reservation_link_order_line', res, lA.id))

// refus de liaison
const o2 = await mkOrder('PO-P46-DRAFT'); const lDraft = await addOl(o2.id, artA, 1, 40)
await rejects('liaison à une ligne de commande non confirmée refusée (MRP_LINE_NOT_CONFIRMED)', () => as(mag, () => rpc('stock_reservation_link_order_line', res, lDraft.id)), 'MRP_LINE_NOT_CONFIRMED')
await rejects('liaison à une ligne qui n’utilise pas la matière refusée (MRP_MATERIAL_NOT_IN_LINE)', () => as(mag, () => rpc('stock_reservation_link_order_line', res, lB.id)), 'MRP_MATERIAL_NOT_IN_LINE')
const resOff = await as(mag, () => rpc('stock_reserve', zip.id, wh, 2, 'CMD-OFF', null))
await as(mag, () => rpc('stock_release', resOff))
await rejects('liaison d’une réservation libérée refusée (MRP_RESERVATION_NOT_ACTIVE)', () => as(mag, () => rpc('stock_reservation_link_order_line', resOff, lC.id)), 'MRP_RESERVATION_NOT_ACTIVE')
await rejects('liaison sans droit de planification refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('stock_reservation_link_order_line', res, lA.id)), 'RBAC_FORBIDDEN')

// --- 4. Explication des calculs --------------------------------------------------------------------------------------------------------------------
const exp = (await q(`select explanation from mrp_run_suggestions where run_id=$1 and material_id=$2 order by need_date limit 1`, [r2, tissu.id]))[0].explanation
ok('explication (première proposition, aujourd’hui) : stock utilisable 100, quarantaine 30 exclue, couvert 10, écart à la sécurité 20', near(exp.stock_usable, 100) && near(exp.quarantine_excluded, 30)
  && near(exp.covered_by_order_lines, 10) && near(exp.projected_before_order, 100) && near(exp.shortfall, 20) && near(exp.safety_stock, 120) && String(exp.basis).includes('aucune commande'))

// --- 5. Propositions d'OF : sans engagement, article sans nomenclature exclu -------------------------------------------------------------------
const po = await q(`select article_id, qty::float q, need_date, explanation from mrp_run_production_suggestions where run_id=$1 order by q`, [r2])
ok('propositions d’OF : articles A (5) et B (4) ; article C (restreint) et sans nomenclature exclus', po.length === 2 && po.map((p) => p.q).join() === '4,5'
  && po.every((p) => p.explanation.finished_stock_netted === false))
const ofAid = (await q(`select id from mrp_run_production_suggestions where run_id=$1 and qty=5`, [r2]))[0].id
await as(admin, () => rpc('mrp_production_suggestion_decide', ofAid, 'accepted', 'À lancer à J+23'))
ok('décision sur une proposition d’OF : statut accepté, auteur tracé, aucun OF créé', (await q(`select status, decided_by from mrp_run_production_suggestions where run_id=$1 and qty=5`, [r2]))[0].status === 'accepted'
  && (await q(`select status, decided_by from mrp_run_production_suggestions where run_id=$1 and qty=5`, [r2]))[0].decided_by === admin)
const anyOf = (await q(`select id from mrp_run_production_suggestions where run_id=$1 limit 1`, [r2]))[0].id
await rejects('décision sur une proposition d’OF sans droit de planification refusée (RBAC_FORBIDDEN)', () => as(mag, () => rpc('mrp_production_suggestion_decide', anyOf, 'accepted')), 'RBAC_FORBIDDEN')
ok('aucune commande d’achat ni OF créé par la simulation ou la décision', (await countPO()) === poBefore)
const decS = (await q(`select id from mrp_run_suggestions where run_id=$1 and material_id=$2 limit 1`, [r2, tissu.id]))[0].id
await as(achat, () => rpc('mrp_suggestion_decide', decS, 'accepted', 'Commande à passer'))
ok('décision d’achat acceptée : toujours aucune commande d’achat créée', (await countPO()) === poBefore)

// --- 6. Réconciliation : détection d’un écart ----------------------------------------------------------------------------------------------------
const rec = await as(prod, () => rpc('mrp_run_reconcile', r2))
ok('réconciliation : aucune incohérence sur la simulation liée', rec.ok === true && rec.issues.length === 0)
await db.query(`update mrp_run_materials set gross = gross + 1 where run_id=$1 and material_id=$2`, [r2, tissu.id])
const rec2 = await as(prod, () => rpc('mrp_run_reconcile', r2))
ok('un écart de besoin brut est détecté (GROSS_NOT_RECONCILED)', rec2.ok === false && rec2.issues.some((i) => i.issue === 'GROSS_NOT_RECONCILED'))
await db.query(`update mrp_run_materials set gross = gross - 1 where run_id=$1 and material_id=$2`, [r2, tissu.id])

// --- 7. Droits, historique -----------------------------------------------------------------------------------------------------------------------
await rejects('réconciliation refusée sans droit MRP (finance)', () => as(fin, () => rpc('mrp_run_reconcile', r2)), 'RBAC_FORBIDDEN')
await rejects('réconciliation refusée sans droit MRP (utilisateur sans rôle)', () => as(nobody, () => rpc('mrp_run_reconcile', r2)), 'RBAC_FORBIDDEN')
await rejects('propositions d’OF non insérables directement', () => as(admin, () => db.query(`insert into mrp_run_production_suggestions(run_id, company_id, article_id, qty, need_date, release_date) values ($1,$2,$3,1,current_date,current_date)`, [r2, company, artA])), 'permission denied')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : 3 simulations, 2 liaisons, 1 déliaison, 1 décision d’OF', (await aud('mrp.run')) === 3 && (await aud('mrp.reservation_link')) === 2
  && (await aud('mrp.reservation_unlink')) === 1 && (await aud('mrp.decide_production')) === 1)
