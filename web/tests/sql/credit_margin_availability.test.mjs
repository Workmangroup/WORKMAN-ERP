// Crédit, marge et disponibilité promise — P028 / migration 0053
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, u, wh, r])
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('com@x.com', 'commercial')
const dir = await mkUser('dir@x.com', 'direction')
const qual1 = await mkUser('qual1@x.com', 'qualite')
const qual2 = await mkUser('qual2@x.com', 'qualite')
const fin = await mkUser('fin@x.com', 'finance')
const mag = await mkUser('mag@x.com', 'magasin')
const prod = await mkUser('prod@x.com', 'production')
const nobody = await mkUser('nobody@x.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
// Taux de TVA signés (règle P017) : standard et exonéré, par la finance
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

// Clients, articles, produits, variantes
const C = (await as(admin, () => q(`insert into clients(name, country, currency, credit_limit, vat_exempt) values ('Client crédit P028','TN','EUR',1000,true) returning id`)))[0].id
const D = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('Client marge P028','TN','EUR',true) returning id`)))[0].id
const artD = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'D-P28','Article marge','jacket') returning id`, [D])))[0].id
const artS = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'S-P28','Article stock','jacket') returning id`, [D])))[0].id
const artC = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'C-P28','Article crédit','jacket') returning id`, [C])))[0].id
const prodD = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Produit marge','jacket',$2) returning id`, [D, artD])))[0].id
const prodS = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Produit stock','jacket',$2) returning id`, [D, artS])))[0].id
const prodC = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Produit crédit','jacket',$2) returning id`, [C, artC])))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
const sizeM = (await q(`select id from sizes where code='M'`))[0].id
await as(admin, () => rpc('variant_generate', prodD, [colJaune], [sizeS, sizeM]))
await as(admin, () => rpc('variant_generate', prodS, [colJaune], [sizeS]))
await as(admin, () => rpc('variant_generate', prodC, [colJaune], [sizeS]))
const vD = (await q(`select id from product_variants where product_id=$1 and size_id=$2`, [prodD, sizeS]))[0].id
const vD2 = (await q(`select id from product_variants where product_id=$1 and size_id=$2`, [prodD, sizeM]))[0].id
const vS = (await q(`select id from product_variants where product_id=$1`, [prodS]))[0].id
const vC = (await q(`select id from product_variants where product_id=$1`, [prodC]))[0].id

// Lots de test pour les expéditions (P030) : lot inséré sans mouvement de stock, affecté par la fonction officielle
const lotFor = async (shipment) => {
  const lines = (await q(`select sl.id, sl.variant_id, sl.qty_picked from shipment_lines sl where sl.shipment_id=$1 and sl.qty_picked>0
    and not exists (select 1 from shipment_line_lots a where a.shipment_line_id=sl.id)`, [shipment]))
  for (const l of lines) {
    const lot = (await db.query(`insert into finished_lots(company_id, lot_code, variant_id, warehouse_id, qty_in, origin) values ($1,$2,$3,$4,$5,'receipt') returning id`,
      [company, 'LOT-T-' + l.id.slice(0, 8), l.variant_id, wh.id, l.qty_picked])).rows[0].id
    await as(mag, () => rpc('shipment_line_lot_assign', l.id, lot, l.qty_picked))
  }
}
const wh = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Stock P028','finished_goods') returning *`))[0])
await grant(mag, wh.id, 'operator')
await as(admin, () => rpc('variant_stock_move', vS, 'receipt', wh.id, 100, null, 'Stock initial P028', null))

// Commandes : lignes à prix et variantes explicites
const order = async (client, article, variant, lines) => {
  const id = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
  for (const [qty, unit, disc = 0] of lines) await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, discount_pct, due_date) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [company, id, article, variant, qty, unit, disc, iso(20)])
  return id
}
const confirm = (o, u = admin) => as(u, () => rpc('sales_order_confirm', o))

// ---------------------------------------------------------------------------------------------------------------------
// 1. Droits
// ---------------------------------------------------------------------------------------------------------------------
await rejects('blocage de stock refusé au commercial (quality.write réservé)', () => as(comm, () => rpc('stock_block', vS, wh.id, 5, 'Blocage refusé test P028')), 'RBAC_FORBIDDEN')
await rejects('coût de variante refusé au commercial (costs.read réservé)', () => as(comm, () => rpc('variant_cost_set', vD, 20, 'EUR')), 'RBAC_FORBIDDEN')
await rejects('politique de marge refusée au commercial (finance.write réservé)', () => as(comm, () => rpc('margin_policy_set', 30)), 'RBAC_FORBIDDEN')
ok('coûts et marge invisibles au commercial (RLS, refus par défaut)', (await as(comm, () => q(`select count(*)::int n from variant_costs`)))[0].n === 0 && (await as(comm, () => q(`select count(*)::int n from margin_policy`)))[0].n === 0)
await rejects('écriture directe de coût refusée', () => as(fin, () => db.query(`insert into variant_costs(company_id, variant_id, unit_cost, currency) values ($1,$2,1,'EUR')`, [company, vD])), 'permission denied')

// ---------------------------------------------------------------------------------------------------------------------
// 2. Crédit bloquant, dérogation bornée et tracée
// ---------------------------------------------------------------------------------------------------------------------
const invC = (await db.query(`insert into invoices(company_id, client_id, currency) values ($1,$2,'EUR') returning id`, [company, C])).rows[0].id
await db.query(`insert into invoice_lines(company_id, invoice_id, pos, description, qty, unit_price) values ($1,$2,1,'Facture ouverte P028',1,800)`, [company, invC])
await as(admin, () => rpc('invoice_issue', invC))
const st0 = await as(comm, () => rpc('client_credit_status', C))
ok('encours : facture ouverte de 800 EUR, plafond 1000', Number(st0.invoices_open) === 800 && Number(st0.credit_limit) === 1000 && Number(st0.headroom) === 200, JSON.stringify(st0))

const O1 = await order(C, artC, vC, [[1, 300]])
await rejects('crédit bloquant : commande de 300 au-delà du plafond refusée (800 + 300 > 1000)', () => confirm(O1, comm), 'CREDIT_BLOCKED')
const O2 = await order(C, artC, vC, [[1, 150]])
await confirm(O2, comm)
ok('commande dans le plafond (800 + 150 = 950) confirmée', (await q(`select status from sales_orders where id=$1`, [O2]))[0].status === 'confirmed')

const dRequest = await as(comm, () => rpc('credit_derogation_request', C, 100, 'Client important, paiement attendu le mois prochain', iso(60)))
ok('dérogation de crédit demandée : plafond élargi de 100 au maximum', Number(dRequest.max_amount) === 100 && dRequest.number !== undefined, JSON.stringify(dRequest))
await rejects('dérogation : le demandeur ne l’approuve pas (séparation des tâches)', () => as(comm, () => rpc('derogation_approve', dRequest.id, true, 'Auto-approbation test')), 'SOD_SELF_APPROVAL')
await as(dir, () => rpc('derogation_approve', dRequest.id, true, 'Accord direction P028'))
await as(qual1, () => rpc('derogation_control', dRequest.id, true, 'Contrôle indépendant P028'))
const O3 = await order(C, artC, vC, [[1, 300]])
await rejects('dérogation bornée : 950 + 300 = 1250 dépasse le plafond élargi (1100)', () => confirm(O3, comm), 'CREDIT_BLOCKED')
const O4 = await order(C, artC, vC, [[1, 100]])
await confirm(O4, comm)
ok('dérogation effective : 950 + 100 = 1050 au-dessus de la limite mais sous 1100, confirmée', (await q(`select status from sales_orders where id=$1`, [O4]))[0].status === 'confirmed')
ok('dérogation tracée dans l’audit de confirmation', (await count(`select count(*)::int n from audit_logs where action='order.confirm' and entity_id=$1 and metadata->'controls'->'derogations'->0->>'derogation' = $2`, [O4, dRequest.id])) === 1)
const O5 = await order(C, artC, vC, [[1, 60]])
await rejects('au-delà du plafond élargi (1050 + 60 > 1100) : refusé même avec dérogation', () => confirm(O5, comm), 'CREDIT_BLOCKED')
const st1 = await as(comm, () => rpc('client_credit_status', C))
ok('statut crédit : encours 800 + 250 = 1050, marge disponible négative (−50)', Number(st1.total) === 1050 && Number(st1.headroom) === -50, JSON.stringify(st1))
ok('sans dérogation de crédit, la limite est un blocage absolu (pas de dérogation implicite)', (await count(`select count(*)::int n from credit_derogation_scopes where client_id=$1`, [D])) === 0)

// ---------------------------------------------------------------------------------------------------------------------
// 3. Prix et marge : paramétrage, contrôles, dérogation tracée
// ---------------------------------------------------------------------------------------------------------------------
const M0 = await order(D, artD, vD, [[1, 25]])
await confirm(M0, comm)
ok('sans coût ni minimum de marge paramétrés : aucun contrôle appliqué (commande confirmée)', (await q(`select status from sales_orders where id=$1`, [M0]))[0].status === 'confirmed')
await as(fin, () => rpc('margin_policy_set', 30))
await as(fin, () => rpc('variant_cost_set', vD, 20, 'EUR'))
const M1 = await order(D, artD, vD, [[1, 25]])
await rejects('marge sous le minimum (25 pour un coût de 20 : 20 % < 30 %) refusée', () => confirm(M1, comm), 'MARGIN_BELOW_MIN')
const M2 = await order(D, artD, vD, [[1, 10]])
await rejects('prix sous le coût (10 < 20) refusé', () => confirm(M2, comm), 'PRICE_BELOW_COST')
const M3 = await order(D, artD, vD, [[1, 40]])
await confirm(M3, comm)
ok('marge de 50 % au-dessus du minimum : confirmée', (await q(`select status from sales_orders where id=$1`, [M3]))[0].status === 'confirmed')
const M4 = await order(D, artD, vD, [[1, 40, 50]])
await rejects('remise prise en compte : net 20 pour un coût de 20 (marge 0 %) refusé', () => confirm(M4, comm), 'MARGIN_BELOW_MIN')
const vD2cost = await q(`select count(*)::int n from variant_costs where variant_id=$1`, [vD2])
const M5 = await order(D, artD, vD2, [[1, 40]])
await rejects('coût absent alors qu’un minimum est paramétré : refusé', () => confirm(M5, comm), 'MARGIN_COST_MISSING')
ok('aucun coût saisi pour la variante M : rien n’est inventé', vD2cost[0].n === 0)

const pDer = await as(comm, () => rpc('derogation_request', 'price', 'order', M1, 'Client stratégique : prix négocié avec la direction', iso(30)))
await as(dir, () => rpc('derogation_approve', pDer.id, true, 'Prix validé direction'))
await as(qual1, () => rpc('derogation_control', pDer.id, true, 'Second contrôle P028'))
await confirm(M1, comm)
ok('dérogation « prix » effective : commande sous minimum confirmée et tracée', (await count(`select count(*)::int n from audit_logs where action='order.confirm' and entity_id=$1 and metadata->'controls'->'derogations'->0->>'derogation' = $2`, [M1, pDer.id])) === 1)
ok('dérogation liée à une seule commande : une autre commande du même prix reste bloquée', await as(comm, () => db.query(`select 1`)).then(async () => {
  const M6 = await order(D, artD, vD, [[1, 25]])
  return await confirm(M6, comm).then(() => false, (e) => /MARGIN_BELOW_MIN/.test(e.message))
}))

// ---------------------------------------------------------------------------------------------------------------------
// 4. Stock : utilisable, réservé, bloqué, engagé ; pas de double réservation ; promesse sur le seul utilisable
// ---------------------------------------------------------------------------------------------------------------------
await as(admin, () => rpc('variant_cost_set', vS, 0.5, 'EUR'))
const blk = await as(qual1, () => rpc('stock_block', vS, wh.id, 20, 'Lot non conforme (test P028)'))
await rejects('blocage au-delà du stock libre refusé (20 + 90 > 100)', () => as(qual1, () => rpc('stock_block', vS, wh.id, 90, 'Blocage excessif test P028')), 'STOCK_BLOCK_EXCEEDS_FREE')
const S1 = await order(D, artS, vS, [[70, 1]])
await confirm(S1, comm)
const pos0 = await as(admin, () => rpc('stock_position', vS))
ok('avant picking : stock 100, bloqué 20, engagé 70, utilisable 10', Number(pos0.on_hand) === 100 && Number(pos0.blocked) === 20 && Number(pos0.committed_not_picked) === 70 && Number(pos0.usable) === 10, JSON.stringify(pos0))
const pr0 = await as(admin, () => rpc('promise_check', vS, 15, iso(5)))
ok('promesse de 15 refusée : seulement 10 utilisables (5 manquantes), bloqué exclu', pr0.promisable === false && Number(pr0.shortage) === 5 && Number(pr0.blocked_excluded) === 20, JSON.stringify(pr0))
ok('promesse de 10 acceptée : seul le stock utilisable est promis', (await as(admin, () => rpc('promise_check', vS, 10, iso(5)))).promisable === true)

const SH = await as(mag, () => rpc('shipment_create', S1, wh.id, null, null, 'EUR'))
const SL = await as(mag, () => rpc('shipment_add_line', SH, vS, 30))
await as(mag, () => rpc('shipment_pick', SL, 30))
const pos1 = await as(admin, () => rpc('stock_position', vS))
ok('après picking de 30 : réservé 30, engagé non prélevé 40, utilisable toujours 10 (pas de double réservation)', Number(pos1.reserved) === 30 && Number(pos1.committed_not_picked) === 40 && Number(pos1.usable) === 10, JSON.stringify(pos1))
await as(mag, () => rpc('shipment_pack', SH, 1, 30, 30))
await lotFor(SH)
await as(mag, () => rpc('shipment_ship', SH, 'DHL', 'TRK-P28'))
const pos2 = await as(admin, () => rpc('stock_position', vS))
ok('après expédition : stock 70, réservé 0, expédié non livré 30, utilisable toujours 10', Number(pos2.on_hand) === 70 && Number(pos2.reserved) === 0 && Number(pos2.shipped_not_delivered) === 30 && Number(pos2.usable) === 10, JSON.stringify(pos2))
await as(mag, () => rpc('shipment_deliver', SH))
const pos3 = await as(admin, () => rpc('stock_position', vS))
ok('après livraison : utilisable toujours 10 (le livré ne compte pas deux fois)', Number(pos3.usable) === 10 && Number(pos3.open_order_demand) === 40, JSON.stringify(pos3))

const pid = (await as(prod, () => q(`insert into work_centers(code, name, kind, hours_per_day, efficiency_pct) values ('COU-P28','Couture P28','couture',8,85) returning id`)))[0].id
const po = await as(prod, () => rpc('production_order_create', artS, 50, 20, pid, iso(0), iso(10), null, 'Attendu P028'))
await as(prod, () => rpc('production_order_launch', po))
const pr1 = await as(admin, () => rpc('promise_check', vS, 15, iso(20)))
ok('attendu production lancé (50 au plus tard à J+10) : affiché avec sa date, mais pas promis', Number(pr1.expected_confirmed_by_date) === 50 && pr1.promisable === false && Number(pr1.usable_now) === 10, JSON.stringify(pr1))

await rejects('libération du blocage par celui qui l’a posé refusée (séparation des tâches)', () => as(qual1, () => rpc('stock_block_release', blk, 'Libération par le même contrôleur')), 'SOD_SELF_APPROVAL')
await as(qual2, () => rpc('stock_block_release', blk, 'Lot reconditionné et conforme'))
const pos4 = await as(admin, () => rpc('stock_position', vS))
ok('après libération : bloqué 0, utilisable 30 (70 − 40 engagés)', Number(pos4.blocked) === 0 && Number(pos4.usable) === 30, JSON.stringify(pos4))
ok('audit : blocage et libération tracés', (await count(`select count(*)::int n from audit_logs where action in ('stock.block','stock.release') and entity_id=$1`, [vS])) === 2)

console.log('crédit, marge et disponibilité : fin des contrôles')
