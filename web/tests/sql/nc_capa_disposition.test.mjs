// Non-conformités et CAPA : cause, périmètre aval, retouche et rebut terminal, coûts, clôture conditionnée à l'efficacité — P053 / migration 0079
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => Number((await q(sql, params))[0].n)
const d = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const qual = await mkUser('qual@x.com', 'qualite')     // quality.read / write / approve ; pas de coûts, pas de stock
const fin = await mkUser('fin@x.com', 'finance')       // quality.cost
const mag = await mkUser('mag@x.com', 'magasin')       // expédition (opérateur d'entrepôt)
const nobody = await mkUser('nobody@x.com', null)

// --- Référentiel : matière, lots matière, entrepôt produits finis, lot produit, expédition ----------------------------------------
const whM = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock P53','fabric') returning id`, [company]))[0].id
const locM = (await q(`select id from stock_locations where warehouse_id=$1 and kind='storage' limit 1`, [whM]))[0].id
const tissu = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu P53','fabric','m') returning *`, [company]))[0]
const receive = (code, qty) => as(admin, () => q(`select public.stock_receive_lot(p_material=>$1, p_warehouse=>$2, p_location=>$3, p_qty=>$4, p_lot_code=>$5, p_expiry=>(current_date + 300)::date, p_reference=>'REC-P53', p_reason=>null, p_unit_cost=>5)`, [tissu.id, whM, locM, qty, code]))
await receive('LOT-M1', 20)
await receive('LOT-M2', 10)
await receive('LOT-M3', 10)
const lotM = async (code) => (await q(`select id from stock_lots where lot_code=$1`, [code]))[0].id
const M1 = await lotM('LOT-M1')
const M2 = await lotM('LOT-M2')
const M3 = await lotM('LOT-M3')
const qtyRemaining = async (id) => Number((await q(`select qty_remaining from stock_lots where id=$1`, [id]))[0].qty_remaining)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const whF = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P53','finished_goods') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whF])
const client = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client P53','TN','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P53-A','Veste P53','jacket') returning id`, [company, client]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P53','jacket',$3) returning id`, [company, client, art]))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJaune], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
await db.query(`update product_variants set price = 25 where id=$1`, [vV])
const onHand = async () => Number((await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [vV, whF]))[0].qty_on_hand)

const LF = await as(admin, () => rpc('finished_lot_receive', vV, whF, 'LOT-F53', 10, 'OF-P53-1'))
const order = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,10,25,$5)`, [company, order, art, vV, d(20)])
await as(admin, () => rpc('sales_order_confirm', order))
const S = await as(mag, () => rpc('shipment_create', order, whF, null, null, 'EUR'))
const SNUM = (await q(`select number from shipments where id=$1`, [S]))[0].number
const LN = await as(mag, () => rpc('shipment_add_line', S, vV, 4))
await as(mag, () => rpc('shipment_pick', LN, 4))
await as(mag, () => rpc('shipment_pack', S, 1, 5, 4))
await as(mag, () => rpc('shipment_line_lot_assign', LN, LF, 4))

// --- A. Non-conformité A : confinement, règles de clôture ------------------------------------------------------------------------------
const A = await as(qual, () => rpc('quality_nc_open', 'Couture défaillante lot M1', 'Coutures ouvertes constatées au contrôle', 'major', d(30)))
const NUM_A = (await q(`select number from quality_nonconformities where id=$1`, [A]))[0].number
await as(qual, () => rpc('quality_nc_contain', A, 'Lots mis en quarantaine', null))
const cl0 = await as(qual, () => rpc('quality_nc_closure', A))
ok('clôture : règles non satisfaites listées (cause, cause racine, responsable, périmètre, efficacité)', cl0.closable === false
  && ['CAUSE_MISSING', 'ROOT_CAUSE_MISSING', 'OWNER_MISSING', 'SCOPE_NOT_ASSESSED', 'EFFECTIVENESS_NOT_VERIFIED'].every((b) => cl0.blockers.includes(b)), JSON.stringify(cl0.blockers))
await rejects('clôture sans cause refusée (NC_CLOSE_CAUSE_MISSING)', () => as(qual, () => rpc('quality_nc_close', A, null)), 'NC_CLOSE_CAUSE_MISSING')
await rejects('cause inconnue refusée (NC_CAUSE_INVALID)', () => as(qual, () => rpc('quality_nc_set_cause', A, 'chance', 'Cause non reconnue')), 'NC_CAUSE_INVALID')
await rejects('cause racine trop courte refusée (NC_REASON_REQUIRED)', () => as(qual, () => rpc('quality_nc_set_cause', A, 'material', 'ok')), 'NC_REASON_REQUIRED')
await as(qual, () => rpc('quality_nc_set_cause', A, 'material', 'Tissu avec tension de fil irrégulière à la réception'))
await rejects('responsable inconnu de la société refusé (NC_OWNER_INVALID)', () => as(qual, () => rpc('quality_nc_assign', A, nobody, d(30))), 'NC_OWNER_INVALID')
await rejects('échéance absente refusée (NC_DUE_REQUIRED)', () => as(qual, () => rpc('quality_nc_assign', A, qual, null)), 'NC_DUE_REQUIRED')
await as(qual, () => rpc('quality_nc_assign', A, qual, d(30)))
ok('cause, cause racine, responsable et échéance enregistrés', (await q(`select cause_category, owner_id, due_date::text d from quality_nonconformities where id=$1`, [A]))[0].owner_id === qual)

// --- B. Périmètre aval : lots impactés retrouvés -----------------------------------------------------------------------------------------
await rejects('impact supérieur à la quantité du lot refusé (NC_QTY_EXCEEDS_LOT)', () => as(qual, () => rpc('quality_nc_impact_add', A, 'material', M1, 25)), 'NC_QTY_EXCEEDS_LOT')
const I1 = await as(qual, () => rpc('quality_nc_impact_add', A, 'material', M1, 8))
const I2 = await as(qual, () => rpc('quality_nc_impact_add', A, 'finished', LF, 4))
await rejects('même lot deux fois dans la même NC refusé (unicité)', () => as(qual, () => rpc('quality_nc_impact_add', A, 'material', M1, 2)), 'quality_nc_impacts_nc_id_lot_kind_lot_id_key')
const scopeA = await as(qual, () => rpc('quality_nc_scope', A))
const impM1 = scopeA.impacts.find((x) => x.lot_code === 'LOT-M1')
const impF = scopeA.impacts.find((x) => x.lot_code === 'LOT-F53')
ok('périmètre : lot matière retrouvé avec son statut et sa quantité impactée', impM1 && impM1.qty === 8 && impM1.lot_status === 'released' && impM1.disposition === null)
ok('périmètre : lot produit retrouvé jusqu’à son expédition (numéro de BL)', impF && impF.shipments.includes(SNUM) && impF.qty === 4)
ok('clôture : impacts sans disposition signalés', (await as(qual, () => rpc('quality_nc_closure', A))).blockers.includes('IMPACT_NOT_DISPOSITIONED'))

// --- C. Retouche : blocage du lot, libération par une autre personne -----------------------------------------------------------------
const RW1 = await as(qual, () => rpc('quality_nc_rework', I1, 'Reprise des coutures sur 8 m'))
ok('retouche : le lot impacté est bloqué pendant la reprise', (await as(qual, () => rpc('lot_quality_status_get', 'material', M1))).status === 'blocked')
await rejects('seconde disposition sur le même impact refusée (NC_ALREADY_DISPOSITIONED)', () => as(qual, () => rpc('quality_nc_rework', I1, 'Autre disposition du même impact')), 'NC_ALREADY_DISPOSITIONED')
ok('clôture : retouche non terminée signalée', (await as(qual, () => rpc('quality_nc_closure', A))).blockers.includes('REWORK_PENDING'))
await rejects('fin de retouche par celui qui a bloqué refusée (LOT_SELF_RELEASE)', () => as(qual, () => rpc('quality_nc_rework_complete', RW1, 'Reprise contrôlée conforme')), 'LOT_SELF_RELEASE')
await as(admin, () => rpc('quality_nc_rework_complete', RW1, 'Reprise contrôlée conforme au standard'))
ok('retouche terminée : lot libéré par un autre utilisateur, disposition complétée', (await as(qual, () => rpc('lot_quality_status_get', 'material', M1))).status === 'released'
  && (await count(`select count(*)::int n from quality_nc_dispositions where id=$1 and completed_at is not null`, [RW1])) === 1)

// --- D. Rebut terminal : produit fini, puis matière ---------------------------------------------------------------------------------------
await rejects('rebut de produit fini sans droit de stock produit refusé (RBAC_FORBIDDEN)', () => as(qual, () => rpc('quality_nc_scrap', I2, 'Couture non réparable')), 'RBAC_FORBIDDEN')
const onHandBefore = await onHand()
const SC1 = await as(admin, () => rpc('quality_nc_scrap', I2, 'Couture non réparable sur 4 pièces'))
ok('rebut produit fini : lot rejeté, 4 pièces sorties du stock produit', (await as(qual, () => rpc('lot_quality_status_get', 'finished', LF))).status === 'rejected'
  && (await onHand()) === onHandBefore - 4 && SC1)
await rejects('rebut produit fini : libération refusée, rebut terminal (LOT_BAD_STATUS)', () => as(admin, () => rpc('lot_quality_release', 'finished', LF, 'Tentative de libération après rebut')), 'LOT_BAD_STATUS')
await rejects('rebut de même impact deux fois refusé (NC_ALREADY_DISPOSITIONED)', () => as(admin, () => rpc('quality_nc_scrap', I2, 'Second rebut du même impact')), 'NC_ALREADY_DISPOSITIONED')

const I3 = await as(qual, () => rpc('quality_nc_impact_add', A, 'material', M2, 5))
await rejects('rebut de matière sans droit de stock refusé (RBAC_FORBIDDEN)', () => as(qual, () => rpc('quality_nc_scrap', I3, 'Tissu troué à rebuter')), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('quality_nc_scrap', I3, 'Tissu troué à rebuter'))
ok('rebut matière : lot rejeté, 5 m sortis du lot, mouvement tracé avec la NC', (await as(qual, () => rpc('lot_quality_status_get', 'material', M2))).status === 'rejected'
  && (await qtyRemaining(M2)) === 5
  && (await count(`select count(*)::int n from stock_movements where reference=$1 and direction='out' and qty=5`, [NUM_A])) === 1)

// Rebut jamais réintroduit : libération, retouche, nouveau rebut et réception de même code refusés
await rejects('lot rebuté : libération refusée (LOT_BAD_STATUS)', () => as(admin, () => rpc('lot_quality_release', 'material', M2, 'Libération après rebut')), 'LOT_BAD_STATUS')
const B = await as(qual, () => rpc('quality_nc_open', 'Tache sur lot M2 déjà rebuté', 'Contrôle de contrôle', 'minor', d(5)))
const IB = await as(qual, () => rpc('quality_nc_impact_add', B, 'material', M2, 2))
await rejects('lot rebuté : retouche refusée (NC_SCRAPPED_TERMINAL)', () => as(qual, () => rpc('quality_nc_rework', IB, 'Retouche d’un lot rebuté')), 'NC_SCRAPPED_TERMINAL')
await rejects('lot rebuté : second rebut refusé (NC_SCRAPPED_TERMINAL)', () => as(admin, () => rpc('quality_nc_scrap', IB, 'Second rebut')), 'NC_SCRAPPED_TERMINAL')
await rejects('réception du même code après rebut refusée (NC_SCRAP_REINTRODUCTION)', () => receive('LOT-M2', 3), 'NC_SCRAP_REINTRODUCTION')
ok('après rebut : quantité du lot inchangée, aucune nouvelle quantité introduite', (await qtyRemaining(M2)) === 5)

// Retouche en cours sur la NC B : clôture bloquée tant que la retouche n'est pas terminée
const IB3 = await as(qual, () => rpc('quality_nc_impact_add', B, 'material', M3, 3))
await as(qual, () => rpc('quality_nc_rework', IB3, 'Reprise de la tache sur 3 m'))
ok('retouche en attente signalée dans la clôture de la NC B', (await as(qual, () => rpc('quality_nc_closure', B))).blockers.includes('REWORK_PENDING'))

// --- E. CAPA : action inefficace non clôturée, puis action efficace ----------------------------------------------------------------------
const CA1 = await as(qual, () => rpc('quality_ca_add', A, 'corrective', 'Recaler la tension de fil à la réception', qual, d(10), null))
await as(qual, () => rpc('quality_ca_progress', CA1, 'done'))
await as(qual, () => rpc('quality_ca_verify', CA1, false))
const cl1 = await as(qual, () => rpc('quality_nc_closure', A))
ok('action corrective vérifiée inefficace : clôture bloquée (ACTION_INEFFECTIVE)', cl1.blockers.includes('ACTION_INEFFECTIVE') && cl1.closable === false)
ok('surveillance CAPA : NC avec action inefficace non clôturée signalée', (await as(qual, () => rpc('quality_capa_watch'))).ineffective_open.some((x) => x.nc === NUM_A))
await rejects('clôture refusée avec action inefficace (NC_CLOSE_ACTION_INEFFECTIVE)', () => as(qual, () => rpc('quality_nc_close', A, 'Fermeture malgré l’inefficacité')), 'NC_CLOSE_ACTION_INEFFECTIVE')

// Coûts de non-qualité : droit distinct
await rejects('coût de non-qualité saisi sans droit coût refusé (RBAC_FORBIDDEN)', () => as(qual, () => rpc('quality_nc_cost_add', A, 'rework', 120.5, 'EUR', 'Reprise couture 8 m')), 'RBAC_FORBIDDEN')
await rejects('devise invalide refusée (NC_CURRENCY_INVALID)', () => as(fin, () => rpc('quality_nc_cost_add', A, 'rework', 120.5, 'eur', 'Reprise couture 8 m')), 'NC_CURRENCY_INVALID')
await rejects('nature de coût inconnue refusée (NC_COST_KIND_INVALID)', () => as(fin, () => rpc('quality_nc_cost_add', A, 'luck', 10, 'EUR', 'Coût inconnu')), 'NC_COST_KIND_INVALID')
await as(fin, () => rpc('quality_nc_cost_add', A, 'rework', 120.5, 'EUR', 'Reprise couture 8 m'))
await as(fin, () => rpc('quality_nc_cost_add', A, 'scrap', 40, 'EUR', 'Rebut 4 pièces produit fini'))
const costs = await as(fin, () => rpc('quality_nc_costs', A))
ok('coûts : totaux par devise, sans conversion', Number(costs.totals_by_currency.EUR) === 160.5 && costs.costs.length === 2)
await rejects('lecture des coûts refusée sans droit (RBAC_FORBIDDEN)', () => as(qual, () => rpc('quality_nc_costs', A)), 'RBAC_FORBIDDEN')
ok('coûts invisibles à la qualité (RLS) et visibles à la finance', (await as(qual, () => count(`select count(*)::int n from quality_nc_costs`))) === 0
  && (await as(fin, () => count(`select count(*)::int n from quality_nc_costs`))) === 2)

// Action efficace ultérieure : la NC peut être clôturée
const CA2 = await as(qual, () => rpc('quality_ca_add', A, 'preventive', 'Contrôle de tension à chaque bobine reçue', qual, d(20), null))
await as(qual, () => rpc('quality_ca_progress', CA2, 'done'))
await as(qual, () => rpc('quality_ca_verify', CA2, true))
ok('action efficace ultérieure : inefficacité levée, NC clôturable', (await as(qual, () => rpc('quality_nc_closure', A))).closable === true)
ok('surveillance CAPA : plus signalée après action efficace', !(await as(qual, () => rpc('quality_capa_watch'))).ineffective_open.some((x) => x.nc === NUM_A))
await as(qual, () => rpc('quality_nc_close', A, null))
ok('NC A clôturée après cause, responsable, échéance, périmètre, dispositions et efficacité', (await q(`select status from quality_nonconformities where id=$1`, [A]))[0].status === 'closed')
await rejects('NC clôturée : nouvel impact refusé (QUALITY_BAD_STATUS)', () => as(qual, () => rpc('quality_nc_impact_add', A, 'material', M1, 1)), 'QUALITY_BAD_STATUS')

// --- F. Clôture sans lot impacté : motif de périmètre, justification sans efficacité ----------------------------------------------------
const C = await as(qual, () => rpc('quality_nc_open', 'Étiquette illisible', null, 'minor', null))
await as(qual, () => rpc('quality_nc_contain', C, 'Étiquettes retirées', null))
await as(qual, () => rpc('quality_nc_set_cause', C, 'method', 'Procédure d’étiquetage non suivie'))
await as(qual, () => rpc('quality_nc_assign', C, qual, d(15)))
await rejects('périmètre non évalué : clôture refusée (NC_CLOSE_SCOPE_NOT_ASSESSED)', () => as(qual, () => rpc('quality_nc_close', C, 'Défaut cosmétique isolé, aucune récurrence')), 'NC_CLOSE_SCOPE_NOT_ASSESSED')
await as(qual, () => rpc('quality_nc_scope_declare', C, 'Aucun lot ne porte cette étiquette : lot non expédié'))
await rejects('sans efficacité, justification trop courte refusée (QUALITY_JUSTIFICATION_REQUIRED)', () => as(qual, () => rpc('quality_nc_close', C, 'court')), 'QUALITY_JUSTIFICATION_REQUIRED')
await as(qual, () => rpc('quality_nc_close', C, 'Défaut cosmétique isolé, aucune récurrence'))
ok('NC C clôturée avec périmètre déclaré et justification écrite', (await q(`select status from quality_nonconformities where id=$1`, [C]))[0].status === 'closed')

// --- G. Journaux en ajout seul, droits directs, audit -----------------------------------------------------------------------------------
await rejects('impact modifié directement refusé (NC_APPEND_ONLY)', () => db.query(`update quality_nc_impacts set qty = 1 where nc_id=$1`, [A]), 'NC_APPEND_ONLY')
await rejects('coût supprimé refusé (NC_APPEND_ONLY)', () => db.query(`delete from quality_nc_costs where nc_id=$1`, [A]), 'NC_APPEND_ONLY')
await rejects('disposition réécrite refusée (NC_APPEND_ONLY)', () => db.query(`update quality_nc_dispositions set reason = 'réécrit' where nc_id=$1`, [A]), 'NC_APPEND_ONLY')
await rejects('disposition insérée directement refusée (permission denied)', () => as(qual, () => db.query(`insert into quality_nc_dispositions(company_id, nc_id, impact_id, kind, qty, reason, decided_by, completed_by, completed_at) values ($1,$2,$3,'scrap',1,'Insertion directe',$4,$4,now())`, [company, A, I1, qual])), 'permission denied')
ok('NC invisible sans droit qualité (RLS)', (await as(nobody, () => count(`select count(*)::int n from quality_nc_impacts`))) === 0)
ok('audit : rebuts (2), retouches (2), fin de retouche (1), clôtures (2) tracés', (await count(`select count(*)::int n from audit_logs where action='quality.nc_scrap'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='quality.nc_rework'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='quality.nc_rework_complete'`)) === 1
  && (await count(`select count(*)::int n from audit_logs where action='quality.nc_close'`)) === 2)
