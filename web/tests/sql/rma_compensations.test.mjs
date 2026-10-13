// Retours (RMA), réparation / remplacement / avoir / remboursement : décision indépendante du retour physique, exécution après
// retour contrôlé, bornes en quantité et en montant, double compensation refusée, lien facture conservé — P058 / migration 0083
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
const comm = await mkUser('com@x.com', 'commercial')    // rma.write ; décide, ne facture ni ne rembourse
const qual = await mkUser('qual@x.com', 'qualite')      // inspection qualité
const mag = await mkUser('mag@x.com', 'magasin')        // expédition, réception et règlement de retour
const fin = await mkUser('fin@x.com', 'finance')        // rma.approve_refund, payments.write, invoices.read
const dir = await mkUser('dir@x.com', 'direction')      // rma.write et rma.approve_refund
const nobody = await mkUser('nobody@x.com', null)

// --- Référentiel : deux clients, commande livrée, facture émise, commande d'un autre client facturée ----------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const whF = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P58','finished_goods') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whF])
const C1 = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client RMA P58','FR','EUR',true) returning id`, [company]))[0].id
const C2 = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Autre client RMA P58','FR','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P58-A','Veste P58','jacket') returning id`, [company, C1]))[0].id
const art2 = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P58-B','Veste autre P58','jacket') returning id`, [company, C2]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P58','jacket',$3) returning id`, [company, C1, art]))[0].id
const prodV2 = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste autre P58','jacket',$3) returning id`, [company, C2, art2]))[0].id
const colJ = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJ], [sizeS]))
await as(admin, () => rpc('variant_generate', prodV2, [colJ], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
const vV2 = (await q(`select id from product_variants where product_id=$1`, [prodV2]))[0].id
await db.query(`update product_variants set price = 25 where id in ($1,$2)`, [vV, vV2])
await as(admin, () => rpc('finished_lot_receive', vV, whF, 'LOT-P58-A', 5, 'OF-P58-1'))
await as(admin, () => rpc('finished_lot_receive', vV2, whF, 'LOT-P58-B', 5, 'OF-P58-2'))

// Commande client 1 livrée (3 pièces) et facturée
const ORDER = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C1])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,3,25,$5)`, [company, ORDER, art, vV, d(20)])
await as(admin, () => rpc('sales_order_confirm', ORDER))
const LOTA = (await q(`select id from finished_lots where lot_code='LOT-P58-A'`))[0].id
const S = await as(mag, () => rpc('shipment_create', ORDER, whF, 'FCA', 'FR', 'EUR'))
const LN = await as(mag, () => rpc('shipment_add_line', S, vV, 3))
await as(mag, () => rpc('shipment_pick', LN, 3))
await as(mag, () => rpc('shipment_line_lot_assign', LN, LOTA, 3))
await as(mag, () => rpc('shipment_pack', S, 1, 3, 2.5))
await as(mag, () => rpc('shipment_ship', S, 'DHL', 'TRK-58-A'))
const INV = await as(admin, () => rpc('invoice_from_shipment', S, 'INV-KEY-P58-0001'))
await as(admin, () => rpc('invoice_issue', INV))
const T_INV = (await q(`select code, client_id from invoices where id=$1`, [INV]))[0]

// Commande et facture de l'autre client (pour refuser le rattachement)
const ORDER2 = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C2])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,1,25,$5)`, [company, ORDER2, art2, vV2, d(20)])
await as(admin, () => rpc('sales_order_confirm', ORDER2))
const INV2 = await as(admin, () => rpc('invoice_from_order', ORDER2, null))
await as(admin, () => rpc('invoice_issue', INV2))

// --- Retour : demande, réception, inspection qualité (rejet → lot non conforme), règlement -------------------------------------------
const LNID = (await q(`select id from shipment_lines where shipment_id=$1`, [S]))[0].id
const R = await as(admin, () => rpc('return_request', LNID, 2, 'Couture défaillante signalée par le client', null, 'damaged'))
await as(admin, () => rpc('return_receive', R, 'damaged'))
const INSP = await as(qual, () => rpc('return_open_inspection', R))
await as(qual, () => rpc('quality_inspection_decide', INSP, 'rejected', 'Défaut de couture non réparable'))

// --- A. Dossier RMA et lien facture ----------------------------------------------------------------------------------------------------------
await rejects('dossier RMA sans droit refusé (RBAC_FORBIDDEN)', () => as(mag, () => rpc('rma_open', R, INV)), 'RBAC_FORBIDDEN')
await rejects('facture d’un autre client refusée (RMA_INVOICE_NOT_RELATED)', () => as(comm, () => rpc('rma_open', R, INV2)), 'RMA_INVOICE_NOT_RELATED')
const RMA = await as(comm, () => rpc('rma_open', R, INV))
const rmaRow = (await q(`select number, invoice_id from rma_cases where id=$1`, [RMA]))[0]
ok('dossier RMA ouvert, numéroté, lié à la facture de la commande', /^RMA-\d{4}-\d{6}$/.test(rmaRow.number) && rmaRow.invoice_id === INV)
await rejects('second dossier pour le même retour refusé (RMA_EXISTS)', () => as(comm, () => rpc('rma_open', R, INV)), 'RMA_EXISTS')
await rejects('lien facture modifié refusé (RMA_INVOICE_LOCKED)', () => db.query(`update rma_cases set invoice_id = null where id=$1`, [RMA]), 'RMA_INVOICE_LOCKED')

// --- B. Décision indépendante du retour physique, bornes, double compensation -----------------------------------------------------------
const REP = await as(comm, () => rpc('rma_compensation_decide', RMA, 'repair', 1, null, null, 'Reprise de la couture sur une pièce', 'rma-p58-repair-1'))
ok('réparation décidée avant exécution (retour non réglé) : décision indépendante du retour', typeof REP === 'string')
await rejects('exécution avant contrôle du retour refusée (RMA_NOT_INSPECTED)', () => as(mag, () => rpc('rma_compensation_execute', REP)), 'RMA_NOT_INSPECTED')
ok('rejeu de la même clé : même décision, aucune seconde', (await as(comm, () => rpc('rma_compensation_decide', RMA, 'repair', 1, null, null, 'Reprise de la couture sur une pièce', 'rma-p58-repair-1'))) === REP)
await rejects('même clé pour une autre nature refusée (RMA_KEY_REUSED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'replacement', 1, null, null, 'Remplacement', 'rma-p58-repair-1')), 'RMA_KEY_REUSED')
await rejects('avoir au-delà de la quantité retournée refusé (RMA_QTY_EXCEEDED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'credit_note', 2, null, null, 'Avoir sur deux pièces', 'rma-p58-cn-2')), 'RMA_QTY_EXCEEDED')
const CN1 = await as(comm, () => rpc('rma_compensation_decide', RMA, 'credit_note', 1, null, null, 'Avoir sur la pièce non réparable', 'rma-p58-cn-1'))
await rejects('remplacement de la même pièce en plus refusé : double compensation (RMA_QTY_EXCEEDED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'replacement', 1, null, null, 'Remplacement en plus de la réparation', 'rma-p58-rep-x')), 'RMA_QTY_EXCEEDED')
await rejects('remboursement sans avoir lié refusé (RMA_CREDIT_NOTE_NOT_LINKED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'refund', null, 10, null, 'Remboursement sans avoir', 'rma-p58-ref-x')), 'RMA_CREDIT_NOTE_NOT_LINKED')
await rejects('motif manquant refusé (RMA_REASON_REQUIRED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'repair', 1, null, null, 'ok', 'rma-p58-repair-x')), 'RMA_REASON_REQUIRED')
await rejects('nature inconnue refusée (RMA_KIND_INVALID)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'cadeau', 1, null, null, 'Geste commercial', 'rma-p58-gift-1')), 'RMA_KIND_INVALID')
await rejects('montant de remboursement invalide refusé (RMA_AMOUNT_INVALID)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'refund', null, 0, null, 'Remboursement nul', 'rma-p58-ref-0')), 'RMA_AMOUNT_INVALID')
await rejects('clé d’idempotence absente refusée (RMA_KEY_REQUIRED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'repair', 1, null, null, 'Reprise sans clé', '')), 'RMA_KEY_REQUIRED')

// --- C. Retour contrôlé (NC), séparation des tâches, exécution -----------------------------------------------------------------------------
await as(admin, () => rpc('return_settle', R))
ok('retour réglé : non-conformité constatée, lot non conforme créé', (await q(`select status from customer_returns where id=$1`, [R]))[0].status === 'rejected'
  && (await count(`select count(*)::int n from finished_lots where origin='return' and status='nc'`, [])) === 1)
await rejects('exécution par celui qui a décidé refusée (RMA_SELF_EXECUTE)', () => as(comm, () => rpc('rma_compensation_execute', CN1)), 'RMA_SELF_EXECUTE')
await rejects('avoir exécuté sans droit de facturation refusé (RBAC_FORBIDDEN)', () => as(qual, () => rpc('rma_compensation_execute', CN1)), 'RBAC_FORBIDDEN')
const rep = await as(mag, () => rpc('rma_compensation_execute', REP))
ok('réparation exécutée par l’expédition (retour contrôlé, décision d’une autre personne)', rep.kind === 'repair')
const ex1 = await as(admin, () => rpc('rma_compensation_execute', CN1))
const cnRow = (await q(`select code, status, invoice_id, total::float t from credit_notes where code=$1`, [ex1.credit_note]))[0]
ok('avoir émis par le module existant pour la seule quantité décidée, rattaché à la facture d’origine', cnRow.status === 'issued' && cnRow.invoice_id === INV)
ok('bornage : une seule pièce créditée sur la ligne de facture (qty_credited = 1)', Number((await q(`select sum(qty_credited) s from invoice_lines where invoice_id=$1`, [INV]))[0].s) === 1)
await rejects('avoir exécuté deux fois refusé (RMA_BAD_STATUS)', () => as(admin, () => rpc('rma_compensation_execute', CN1)), 'RMA_BAD_STATUS')
await rejects('double compensation après exécution refusée (RMA_QTY_EXCEEDED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'credit_note', 1, null, null, 'Second avoir sur la même pièce', 'rma-p58-cn-dup')), 'RMA_QTY_EXCEEDED')
const st1 = await as(comm, () => rpc('rma_status_get', RMA))
ok('état du dossier : deux pièces compensées, aucune restante, avoir visible', st1.qty_compensated === 2 && st1.qty_remaining === 0 && st1.credit_notes.length === 1
  && st1.invoice === T_INV.code)

// --- D. Remboursement : borné par l'avoir, approbation distincte -----------------------------------------------------------------------------
const T = Number(cnRow.t)
const CNID = (await q(`select id from credit_notes where code=$1`, [ex1.credit_note]))[0].id
await rejects('remboursement au-delà du total de l’avoir refusé (RMA_AMOUNT_EXCEEDED)', () => as(comm, () => rpc('rma_compensation_decide', RMA, 'refund', null, T + 1, CNID, 'Remboursement trop élevé', 'rma-p58-ref-big')), 'RMA_AMOUNT_EXCEEDED')
const REF1 = await as(comm, () => rpc('rma_compensation_decide', RMA, 'refund', null, 10, CNID, 'Remboursement partiel du montant de l’avoir', 'rma-p58-ref-1'))
await rejects('remboursement non approuvé refusé à l’exécution (RMA_REFUND_NOT_APPROVED)', () => as(admin, () => rpc('rma_compensation_execute', REF1)), 'RMA_REFUND_NOT_APPROVED')
await rejects('approbation sans droit refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('rma_refund_approve', REF1)), 'RBAC_FORBIDDEN')
await as(dir, () => rpc('rma_refund_approve', REF1))
const ex2 = await as(admin, () => rpc('rma_compensation_execute', REF1))
ok('remboursement approuvé puis exécuté (virement hors ERP, montant conservé)', ex2.kind === 'refund' && Number((await q(`select amount::float a from rma_compensations where id=$1`, [REF1]))[0].a) === 10)
const REF2 = await as(admin, () => rpc('rma_compensation_decide', RMA, 'refund', null, Number((T - 10).toFixed(2)), CNID, 'Solde du remboursement de l’avoir', 'rma-p58-ref-2'))
await rejects('approbation par celui qui a décidé refusée (RMA_SELF_APPROVE)', () => as(admin, () => rpc('rma_refund_approve', REF2)), 'RMA_SELF_APPROVE')
await rejects('remboursement au-delà du solde restant refusé (RMA_AMOUNT_EXCEEDED)', () => as(admin, () => rpc('rma_compensation_decide', RMA, 'refund', null, 0.01, CNID, 'Centime au-delà du solde', 'rma-p58-ref-3')), 'RMA_AMOUNT_EXCEEDED')
await as(dir, () => rpc('rma_refund_approve', REF2))
await as(fin, () => rpc('rma_compensation_execute', REF2))
const st2 = await as(comm, () => rpc('rma_status_get', RMA))
ok('solde du remboursement : avoir entièrement remboursé, aucun montant restant', st2.credit_notes[0].refundable === 0 && Math.abs(st2.credit_notes[0].refunded - T) < 0.005)
await rejects('remboursement après solde nul refusé (RMA_AMOUNT_EXCEEDED)', () => as(admin, () => rpc('rma_compensation_decide', RMA, 'refund', null, 0.01, CNID, 'Remboursement double', 'rma-p58-ref-dbl')), 'RMA_AMOUNT_EXCEEDED')

// --- E. Pas d'avoir automatique : source humaine imposée ---------------------------------------------------------------------------------
await rejects('compensation d’origine automatique (source IA) refusée (contrainte source)', () => db.query(`insert into rma_compensations(company_id, rma_id, kind, qty, reason, source, idem_key, decided_by, decided_at)
  values ($1,$2,'credit_note',1,'Résumé IA proposant un avoir','ai','rma-p58-ai-0001',null,now())`, [company, RMA]), 'rma_compensations_source_check')

// --- F. Journaux figés, lien facture conservé, droits et RLS, audit --------------------------------------------------------------------------
await rejects('compensation modifiée refusée (RMA_LEDGER_APPEND_ONLY)', () => db.query(`update rma_compensations set qty = 5 where id=$1`, [CN1]), 'RMA_LEDGER_APPEND_ONLY')
await rejects('compensation supprimée refusée (RMA_LEDGER_APPEND_ONLY)', () => db.query(`delete from rma_compensations where id=$1`, [REP]), 'RMA_LEDGER_APPEND_ONLY')
await rejects('annulation d’un dossier exécuté refusée (RMA_HAS_EXECUTED)', () => as(admin, () => rpc('rma_cancel', RMA, 'Annulation après exécution')), 'RMA_HAS_EXECUTED')
ok('lien facture conservé : le dossier et l’avoir pointent la même facture', (await q(`select invoice_id from rma_cases where id=$1`, [RMA]))[0].invoice_id === INV
  && (await q(`select invoice_id from credit_notes where id=$1`, [CNID]))[0].invoice_id === INV)
ok('dossier invisible sans droit d’expédition (RLS)', (await as(nobody, () => count(`select count(*)::int n from rma_cases`))) === 0)
ok('audit : ouverture, décisions, exécutions et approbations tracées', (await count(`select count(*)::int n from audit_logs where action='rma.open'`)) === 1
  && (await count(`select count(*)::int n from audit_logs where action='rma.compensation_decide'`)) === 4
  && (await count(`select count(*)::int n from audit_logs where action='rma.compensation_execute'`)) === 4
  && (await count(`select count(*)::int n from audit_logs where action='rma.refund_approve'`)) === 2)
