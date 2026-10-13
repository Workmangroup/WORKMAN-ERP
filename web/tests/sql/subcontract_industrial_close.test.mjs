// Sous-traitance et clôture industrielle : matières externes (propres et propriétaires), coûts standard / réel expliqués,
// revue des écarts significatifs, clôture refusée si incohérente — P050 / migration 0075
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - b) < eps
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }
const sha = (c) => c.repeat(64)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCodes) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  for (const rc of roleCodes) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(rc)])
  return id
}
const admin = await mkUser('admin@x.com', ['admin'])
const dir = await mkUser('dir@x.com', ['direction'])
const prod = await mkUser('prod@x.com', ['production'])
const opr = await mkUser('opr@x.com', ['production', 'magasin'])
const achat = await mkUser('achat@x.com', ['achat'])
const qual = await mkUser('qual@x.com', ['qualite'])
const opA = await mkUser('opa@x.com', ['production'])
const comm = await mkUser('com@x.com', ['commercial'])
const fin = await mkUser('fin@x.com', ['finance'])
const nobody = await mkUser('nobody@x.com', [])

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))

// --- Référentiel : entrepôts, matières, article et fiche produit, variante, nomenclature, taux horaire ---------------------------
const whRaw = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Magasin tissu P50','fabric') returning id`, [company]))[0].id
const whFin = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P50','finished_goods') returning id`, [company]))[0].id
const grant = (u, wh) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager') on conflict (user_id, warehouse_id) do update set role='manager', active=true, revoked_at=null`, [company, u, wh])
await grant(opr, whRaw); await grant(opr, whFin)
const locRaw = (await q(`select id from stock_locations where warehouse_id=$1 and kind='storage' limit 1`, [whRaw]))[0].id
const client = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'LAFONT P50','TN','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, internal_ref, client_ref, name, family) values ($1,$2,'VES50','LAF-50','Polo P50','jacket') returning id`, [company, client]))[0].id
const prodM = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Polo P50','jacket',$3) returning id`, [company, client, art]))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodM, [colJaune], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodM]))[0].id

const mat = async (name, unit, cost) => {
  const m = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,$2,'fabric',$3) returning *`, [company, name, unit]))[0]
  await db.query(`insert into bom_material_prices(material_id, company_id, unit_cost) values ($1,$2,$3)`, [m.id, company, cost])
  return m
}
const tissu = await mat('Tissu P50', 'm', 8)
const doublure = await mat('Doublure P50', 'm', 3)
const bom = (await as(admin, () => q(`insert into boms(name, kind, article_id) values ('Polo P50','product',$1) returning *`, [art])))[0]
const bv = (await q(`select id from bom_versions where bom_id=$1 and version_no=1`, [bom.id]))[0].id
await db.query(`insert into bom_lines(company_id, version_id, line_type, material_id, quantity, waste_pct) values ($1,$2,'material',$3,2,0)`, [company, bv, tissu.id])
await db.query(`update bom_version_costs set hourly_rate = 30 where version_id = $1`, [bv])
await as(qual, () => rpc('bom_validate_version', bv, 'Fiche conforme'))

await db.query(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUAR50','Quarantaine','quarantine')`, [company, whRaw])
const recv = (m, qty, code, cost) => as(opr, () => q(`select public.stock_receive_lot(p_material=>$1, p_warehouse=>$2, p_location=>$3, p_qty=>$4, p_lot_code=>$5, p_expiry=>(current_date + 120)::date, p_reference=>'REC-P50', p_reason=>null, p_unit_cost=>$6)`, [m, whRaw, locRaw, qty, code, cost]))
await recv(tissu.id, 40, 'TIS-50', 8)
await recv(doublure.id, 10, 'DBL-50', 3)

// --- Gamme et OF (10 pièces) : confection au poste affecté -----------------------------------------------------------------------------------
const WCC = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'CONF50','Confection P50','couture') returning id`, [company]))[0].id
const rv = await as(admin, () => rpc('routing_version_create', art, 'Gamme P50'))
await as(admin, () => rpc('routing_operation_add', rv, 'confection', 'Confection du polo', WCC, null, 60, 'min', 0, null))
await as(dir, () => rpc('routing_version_approve', rv, 'Gamme validée'))
await as(prod, () => rpc('production_operator_assign', opA, WCC, true))
const mkOf = async (qty) => {
  const id = await as(admin, () => rpc('production_order_create', art, qty, 60, WCC, iso(0), iso(10), null, 'OF P50'))
  await as(admin, () => rpc('production_order_set_variant', id, vV))
  await as(admin, () => rpc('production_order_launch', id))
  return id
}
const OF = await mkOf(10)
const ofNo = (await q(`select number from production_orders where id=$1`, [OF]))[0].number
ok('OF lancé avec nomenclature et gamme figées (10 pièces)', (await q(`select status from production_order_bom where order_id=$1`, [OF]))[0].status === 'frozen'
  && (await q(`select status from production_order_routing where order_id=$1`, [OF]))[0].status === 'frozen')

// Coupe : 20 m de tissu (10 pièces × 2 m), coût des lots 8 €/m ; déclaration de confection 600 min, 10 bons
const plan = await as(prod, () => rpc('production_cut_plan_create', OF, tissu.id, whRaw, 20, 1, 10, 0, 'Coupe 10 pièces'))
await as(opr, () => rpc('production_cut_plan_consume', plan))
await as(opA, () => rpc('production_operation_declare', OF, 1, iso(0), 600, 0, 0, 10, 0, 0, null, null, 'Confection lot 1'))
ok('matières de coupe consommées : 20 m (lot à 8 €)', near((await q(`select sum(qty_remaining)::float r from stock_lots where material_id=$1`, [tissu.id]))[0].r, 20))

// --- Sous-traitance rattachée à l'OF : broderie 10 pièces, prix convenu 2 €, coût réel 2,50 € ---------------------------------------
const sub = (await as(achat, () => q(`insert into subcontractors(name, services, country, city, default_lead_days) values ('Brodeur P50','{embroidery}','TN','Sfax',10) returning id`)))[0].id
const insSc = async (u, qty, product = null) => (await as(u, () => q(`insert into subcontract_orders(subcontractor_id, service, product_id, description, qty, requested_on, due_date) values ($1,'embroidery',$4,'Broderie P50',$2,current_date,$3) returning *`, [sub, qty, iso(14), product])))[0]
const sc1 = await insSc(prod, 10, prodM)
await as(achat, () => rpc('sc_order_set_price', sc1.id, 2))
await as(prod, () => rpc('sc_order_link_production', sc1.id, OF))
await as(prod, () => rpc('sc_order_send', sc1.id, null))
const ship1 = await as(prod, () => rpc('sc_shipment_add', sc1.id, 10, iso(0), 'DHL', null))
await as(achat, () => db.query(`insert into subcontract_costs(order_id, shipment_id, kind, description, quantity, unit_cost, incurred_on) values ($1,$2,'service','Broderie 10 pièces',10,2.5,current_date)`, [sc1.id, ship1]))
const rec1 = await as(prod, () => rpc('sc_receipt_add', sc1.id, 10, iso(0), ship1))
await as(qual, () => rpc('sc_receipt_qc', rec1, 10, 0, null))
await as(opr, () => rpc('sc_receipt_stock', rec1, vV, whFin))
await as(prod, () => rpc('sc_order_close', sc1.id))
ok('sous-traitance clôturée (réception contrôlée, en stock)', (await q(`select status from subcontract_orders where id=$1`, [sc1.id]))[0].status === 'closed')

// Sortie des produits finis et fin d'OF (journal de production requis)
await as(opr, () => rpc('production_finished_lot_receive', OF, 'LOT-P50-A', whFin, 10))
await as(prod, () => rpc('production_order_log', OF, iso(0), 10, 10, 0, 'Journée complète'))
await as(prod, () => rpc('production_order_finish', OF))

// --- Réconciliation : vérifications OK ; coût sous-traitance en écart significatif (25 % pour un seuil de 10 %) ----------------------------
const rec = await as(admin, () => rpc('production_order_reconcile', OF, 10))
const chk = (c) => rec.checks.find((x) => x.code === c)
ok('vérifications de clôture toutes passées (statut, bons, sortie, coupe, sous-traitance, taux horaire, prix)', rec.all_checks_ok === true && rec.checks.every((c) => c.ok))
const comp = (c) => rec.components.find((x) => x.component === c)
ok('coût matière expliqué : standard 160 € (2 m × 10 × 8 €), réel 160 € (lot coupé)', near(comp('material').standard, 160) && near(comp('material').real, 160) && comp('material').formula_standard.length > 10)
ok('main-d’œuvre expliquée : standard 300 € (60 min × 10 / 60 × 30 €/h), réel 300 € (600 min déclarées)', near(comp('labour').standard, 300) && near(comp('labour').real, 300))
ok('sous-traitance : standard 20 € (10 × 2 €), réel 25 € (coût saisi), écart significatif', near(comp('subcontract').standard, 20) && near(comp('subcontract').real, 25) && rec.significant_components === 1)
const vSub = rec.variances.find((v) => v.component === 'subcontract')
ok('écart significatif soumis à revue (en attente)', vSub.status === 'pending' && vSub.significant === true && near(vSub.variance, 5))
await rejects('clôture refusée tant que l’écart n’est pas revu (CLOSE_VARIANCE_REVIEW_PENDING)', () => as(prod, () => rpc('production_order_close_industrial', OF, 10)), 'CLOSE_VARIANCE_REVIEW_PENDING')
await rejects('seuil absent : réconciliation refusée (CLOSE_THRESHOLD_REQUIRED)', () => as(prod, () => rpc('production_order_reconcile', OF, null)), 'CLOSE_THRESHOLD_REQUIRED')
await rejects('ancienne clôture simple refusée (CLOSE_USE_INDUSTRIAL)', () => as(prod, () => rpc('production_order_close', OF)), 'CLOSE_USE_INDUSTRIAL')
await rejects('revue par le demandeur refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('production_variance_decide', vSub.id, true, 'Je valide mon propre calcul')), 'SOD_SELF_APPROVAL')
await rejects('revue sans droit d’approbation refusée (RBAC_FORBIDDEN)', () => as(prod, () => rpc('production_variance_decide', vSub.id, true, 'Écart justifié par le devis')), 'RBAC_FORBIDDEN')
await rejects('revue sans motif suffisant refusée (VARIANCE_REASON_REQUIRED)', () => as(dir, () => rpc('production_variance_decide', vSub.id, true, 'ok')), 'VARIANCE_REASON_REQUIRED')
await as(dir, () => rpc('production_variance_decide', vSub.id, true, 'Surcoût dû au second passage de broderie, devis fournisseur 2,50 € accepté'))
ok('écart approuvé par un autre utilisateur, motif et auteur tracés', (await q(`select status, decided_by = $2 ok, decision_note like 'Surcoût%' n from production_order_variances where id=$1`, [vSub.id, dir]))[0].ok === true)
await rejects('seconde décision sur le même écart refusée (VARIANCE_BAD_STATUS)', () => as(dir, () => rpc('production_variance_decide', vSub.id, false, 'Revirement de décision')), 'VARIANCE_BAD_STATUS')

// --- Clôture : refusée à seuil nul (sans effet) ; acceptée une fois l'écart approuvé ---------------------------------------------------------
const closed = await as(prod, () => rpc('production_order_close_industrial', OF, 10))
ok('OF clôturé après réconciliation et approbation de l’écart', closed.closed === true && (await q(`select closed_at is not null c from production_orders where id=$1`, [OF]))[0].c === true)
await rejects('OF déjà clôturé : nouvelle clôture refusée (PRODUCTION_BAD_STATUS)', () => as(prod, () => rpc('production_order_close_industrial', OF, 10)), 'PRODUCTION_BAD_STATUS')

// --- Clôture incohérente : OF sans sortie de produits finis -------------------------------------------------------------------------------
const OF2 = await mkOf(5)
await as(opA, () => rpc('production_operation_declare', OF2, 1, iso(0), 240, 0, 0, 4, 0, 0, null, null, null))
// Matières externes d'un sous-traitant : consommation valorisée sur l'OF2 ; commande non clôturée
const sc2 = await insSc(prod, 5)
await as(prod, () => rpc('sc_order_send', sc2.id, null))
await as(opr, () => rpc('sc_material_send', sc2.id, tissu.id, 4, null, whRaw, locRaw, 'Envoi tissu P50'))
await as(prod, () => rpc('sc_material_consume', sc2.id, tissu.id, null, 3, 'consume', 'Coupe chez le sous-traitant'))
await as(prod, () => rpc('sc_order_link_production', sc2.id, OF2))
await as(prod, () => rpc('production_order_log', OF2, iso(0), 4, 4, 0, 'Journée partielle'))
await as(prod, () => rpc('production_order_finish', OF2))
const rec2 = await as(admin, () => rpc('production_order_reconcile', OF2, 10))
ok('sans sortie de produits finis : contrôle « sortie réconciliée » en échec', rec2.all_checks_ok === false && rec2.checks.find((c) => c.code === 'OUTPUT_RECONCILED').ok === false)
ok('coût matière de l’OF2 inclut la matière confiée consommée : 3 m × 8 € = 24 € en plus des lots coupés', near(rec2.components.find((c) => c.component === 'material').real, 24))
await rejects('clôture incohérente refusée (CLOSE_INCONSISTENT)', () => as(prod, () => rpc('production_order_close_industrial', OF2, 10)), 'CLOSE_INCONSISTENT')
ok('OF incohérent non clôturé', (await q(`select closed_at is null o from production_orders where id=$1`, [OF2]))[0].o === true)

// --- Matières externes : matière de la société et matière propriétaire du client ---------------------------------------------------------
const stockTissu = async () => Number((await q(`select coalesce(sum(qty_remaining),0)::float s from stock_lots where material_id=$1`, [tissu.id]))[0].s)
const scX = await insSc(prod, 6)
await rejects('envoi de matière sur une commande en brouillon refusé (SC_BAD_STATUS)', () => as(opr, () => rpc('sc_material_send', scX.id, tissu.id, 1, null, whRaw, locRaw, null)), 'SC_BAD_STATUS')
await as(prod, () => rpc('sc_order_send', scX.id, null))
const beforeSend = await stockTissu()
const sendOwn = await as(opr, () => rpc('sc_material_send', scX.id, tissu.id, 4, null, whRaw, locRaw, 'Envoi tissu propre'))
ok('matière de la société envoyée : sortie de stock, coût moyen d’envoi 8 €', near(sendOwn.unit_cost, 8) && near(await stockTissu(), beforeSend - 4))
const beforeClient = await stockTissu()
const sendClient = await as(opr, () => rpc('sc_material_send', scX.id, doublure.id, 5, client, whRaw, locRaw, 'Doublure du client'))
ok('matière propriétaire du client : suivie hors stock de la société (aucun mouvement, aucun coût)', sendClient.movement_id === null && (await stockTissu()) === beforeClient
  && (await q(`select count(*)::int n from stock_movements where material_id=$1 and direction='out'`, [doublure.id]))[0].n === 0)
await rejects('propriétaire inconnu refusé (SC_MATERIAL_OWNER_INVALID)', () => as(opr, () => rpc('sc_material_send', scX.id, doublure.id, 1, '00000000-0000-0000-0000-000000000000', whRaw, locRaw, null)), 'SC_MATERIAL_OWNER_INVALID')
await as(prod, () => rpc('sc_material_consume', scX.id, tissu.id, null, 3, 'consume', 'Coupe chez le sous-traitant'))
await rejects('consommation au-delà du solde refusée (SC_MATERIAL_INSUFFICIENT)', () => as(prod, () => rpc('sc_material_consume', scX.id, tissu.id, null, 2, 'consume', 'Trop')), 'SC_MATERIAL_INSUFFICIENT')
await as(opr, () => rpc('sc_material_return', scX.id, tissu.id, 1, null, whRaw, locRaw, 'Retour chutes'))
ok('retour de la matière de la société : rentrée en stock (+1 m), solde nul', near(await stockTissu(), beforeClient + 1) && (await q(`select count(*)::int n from sc_material_ledger where sc_order_id=$1`, [scX.id]))[0].n === 4)
await as(prod, () => rpc('sc_material_consume', scX.id, doublure.id, client, 5, 'scrap', 'Rebut du client'))
await rejects('consommation de la matière du client au-delà du solde refusée (SC_MATERIAL_INSUFFICIENT)', () => as(prod, () => rpc('sc_material_consume', scX.id, doublure.id, client, 1, 'consume', 'Trop')), 'SC_MATERIAL_INSUFFICIENT')
const summ = await as(prod, () => rpc('sc_material_summary', scX.id))
const sTissu = summ.materials.find((m) => m.material === 'Tissu P50')
const sDbl = summ.materials.find((m) => m.material === 'Doublure P50')
ok('résumé : matière de la société envoyée 4, consommée 3, retournée 1, solde 0, coût consommé 24 €', sTissu.owner === 'company' && near(sTissu.sent, 4) && near(sTissu.consumed, 3) && near(sTissu.returned, 1) && near(sTissu.balance, 0) && near(sTissu.consumed_cost, 24))
ok('résumé : matière du client envoyée 5, rebutée 5, solde 0, sans coût pour la société', sDbl.owner === 'client' && near(sDbl.sent, 5) && near(sDbl.balance, 0) && near(sDbl.consumed_cost, 0))
await rejects('registre des matières : écriture directe refusée (permission denied)', () => as(prod, () => db.query(`insert into sc_material_ledger(company_id, sc_order_id, material_id, kind, qty) values ($1,$2,$3,'send',1)`, [company, scX.id, tissu.id])), 'permission denied')
await rejects('registre des matières : modification refusée (SC_MATERIAL_APPEND_ONLY)', () => db.query(`update sc_material_ledger set qty = 99 where sc_order_id=$1`, [scX.id]), 'SC_MATERIAL_APPEND_ONLY')

// --- Droits et historique -----------------------------------------------------------------------------------------------------------------
await rejects('réconciliation sans droit de planification refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_order_reconcile', OF, 10)), 'RBAC_FORBIDDEN')
await rejects('prix sans droit de coût refusé (RBAC_FORBIDDEN)', () => as(prod, () => rpc('sc_order_set_price', scX.id, 9)), 'RBAC_FORBIDDEN')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : réconciliations (2), revue approuvée (1), clôture industrielle (1), rattachements (2)', (await aud('production.reconcile')) === 2 && (await aud('production.variance_approve')) === 1
  && (await aud('production.order_close_industrial')) === 1 && (await aud('subcontract.link_production')) === 2)
ok('audit : envois (3), consommations (2), rebut (1), retour (1) de matières tracés', (await aud('subcontract.material_send')) === 3 && (await aud('subcontract.material_consume')) === 2 && (await aud('subcontract.material_scrap')) === 1 && (await aud('subcontract.material_return')) === 1)
