import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql', '0033_delegations_sod.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const exec = (sql, params) => db.query(sql, params)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const fin = await mkUser('fin@x.com', 'finance')
const fin2 = await mkUser('fin2@x.com', 'finance')
const com = await mkUser('com@x.com', 'commercial')
const qual = await mkUser('qual@x.com', 'qualite')
const qual2 = await mkUser('qual2@x.com', 'qualite')
const nobody = await mkUser('nobody@x.com', null)
const other = (await q(`insert into companies(name, country) values ('Autre société','TN') returning id`))[0].id
await db.query(`update profiles set company_id = $1 where id = $2`, [other, nobody])
const iso = (ms) => new Date(Date.now() + ms).toISOString()
const DAY = 24 * 3600 * 1000

// --- Fournisseur et factures ouvertes (1 000 au total) -----------------------------------------------------------------------------------------
const sup = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'F-001','Tissus Sfax','TN') returning id`, [company]))[0].id
const dInv = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10)
await as(fin, () => rpc('supplier_invoice_record', sup, 'FT-1', dInv(-40), dInv(-30), 1000, 'EUR', null))

// --- A. Ordres de paiement : préparateur ≠ approbateur ------------------------------------------------------------------------------
const po1 = await as(fin, () => rpc('payment_order_prepare', sup, 300, 'Acompte tissus'))
ok('préparation : numéro PAY-AAAA-nnnnnn généré par la base', /^PAY-\d{4}-\d{6}$/.test(po1.number), po1.number)
await rejects('préparation : montant supérieur au solde ouvert refusé', () => as(fin, () => rpc('payment_order_prepare', sup, 5000, 'Trop')), 'FINANCE_OVERPAYMENT')
await rejects('préparation : sans payments.prepare refusée', () => as(com, () => rpc('payment_order_prepare', sup, 10, 'Intrus')), 'RBAC_FORBIDDEN')
await rejects('auto-approbation : admin prépare puis approuve son ordre', async () => {
  const mine = await as(admin, () => rpc('payment_order_prepare', sup, 50, 'Frais de port'))
  return as(admin, () => rpc('payment_order_decide', mine.id, true, null))
}, 'SOD_SELF_APPROVAL')
await rejects('préparateur ne peut pas approuver son ordre (séparation des tâches)', () => as(fin, () => rpc('payment_order_decide', po1.id, true, null)), 'SOD_SELF_APPROVAL')
await as(dir, () => rpc('payment_order_decide', po1.id, true, 'OK'))
ok('approbation par une autre personne : statut approuvé, approbateur tracé', (await q(`select status, decided_by is not null d from payment_orders where id=$1`, [po1.id]))[0].status === 'approved')
await rejects('décision déjà prise : second traitement refusé', () => as(dir, () => rpc('payment_order_decide', po1.id, false, 'Revirement')), 'PAYMENT_ORDER_BAD_STATUS')
await rejects('défense en profondeur : base refuse decided_by = prepared_by (écriture directe)', async () =>
  exec(`update payment_orders set decided_by = prepared_by, status='approved', decided_at=now() where id=$1 and status='prepared'`, [(await as(fin, () => rpc('payment_order_prepare', sup, 20, 'Test direct'))).id]), 'payment_orders_check')

// --- B. Délégations datées et bornées --------------------------------------------------------------------------------------------------------
const po2 = await as(fin, () => rpc('payment_order_prepare', sup, 300, 'Transport'))
const po3 = await as(fin, () => rpc('payment_order_prepare', sup, 800, 'Gros achat'))
await rejects('délégation : impossible de déléguer une permission qu’on ne détient pas', () =>
  as(dir, () => rpc('delegation_grant', fin2, 'derogations.control', 'derogation', null, 100, iso(DAY), 'Essai', null)), 'DELEGATION_NOT_HELD')
await rejects('délégation : fenêtre supérieure à 90 jours refusée', () =>
  as(dir, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', null, 100, iso(100 * DAY), 'Trop long', null)), 'DELEGATION_WINDOW')
await rejects('délégation : sans montant ni objet (non bornée) refusée', () =>
  as(dir, () => db.query(`select public.delegation_grant($1,'payments.approve','payment_order',null,null,$2,'Illimitée',null)`, [fin2, iso(DAY)])), 'delegations_check')
await rejects('délégation : sans délégation de la gestion, le pouvoir d’accorder est refusé', () =>
  as(fin, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', null, 300, iso(DAY), 'Auto', null)), 'RBAC_FORBIDDEN')
await rejects('délégation : délégué inconnu de la société refusé', () =>
  as(dir, () => rpc('delegation_grant', nobody, 'payments.approve', 'payment_order', null, 300, iso(DAY), 'Hors liste', null)), 'DELEGATION_BAD_DELEGATE')
const dAmt = await as(dir, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', null, 500, iso(DAY), 'Délégation montant ≤ 500', null))
ok('délégation accordée, bornée au montant (500)', typeof dAmt === 'string')
await as(fin2, () => rpc('payment_order_decide', po2.id, true, 'OK délégué'))
ok('délégué : approuve un ordre ≤ 500 (préparé par un autre)', (await q(`select status from payment_orders where id=$1`, [po2.id]))[0].status === 'approved')
await rejects('délégué : refus au-delà du montant délégué', () => as(fin2, () => rpc('payment_order_decide', po3.id, true, null)), 'DELEGATION_AMOUNT_EXCEEDED')
await rejects('délégué : ne peut pas approuver ce qu’il a préparé', async () => {
  const mine = await as(fin2, () => rpc('payment_order_prepare', sup, 100, 'Sa propre demande'))
  return as(fin2, () => rpc('payment_order_decide', mine.id, true, null))
}, 'SOD_SELF_APPROVAL')

// Délégation sur un objet précis, sans limite de montant
const dObj = await as(dir, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', po3.id, null, iso(DAY), 'Ordre précis', null))
await as(fin2, () => rpc('payment_order_decide', po3.id, true, 'Objet délégué'))
ok('délégation bornée à l’objet : approuve l’ordre désigné, quel que soit le montant', (await q(`select status from payment_orders where id=$1`, [po3.id]))[0].status === 'approved')

// Révocation de la délégation par montant (avant les scénarios de fenêtre)
await as(dir, () => rpc('delegation_revoke', dAmt, 'Fin de remplacement'))
const po5 = await as(fin, () => rpc('payment_order_prepare', sup, 100, 'Après révocation'))
await rejects('délégation révoquée : refusée immédiatement', () => as(fin2, () => rpc('payment_order_decide', po5.id, true, null)), 'RBAC_FORBIDDEN')
await rejects('révocation : une seconde révocation refusée', () => as(dir, () => rpc('delegation_revoke', dAmt, 'Encore')), 'DELEGATION_BAD_STATUS')
await rejects('révocation : tiers sans delegations.manage refusé', () => as(fin, () => rpc('delegation_revoke', dObj, 'Pas à moi')), 'RBAC_FORBIDDEN')

// Délégation expirée : fenêtre de 2,5 s, puis attente réelle de 3 s
const po4 = await as(fin, () => rpc('payment_order_prepare', sup, 100, 'Expire'))
const dExp = await as(dir, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', null, 1000, iso(2500), 'Très courte', null))
await exec(`select pg_sleep(3)`)
await rejects('délégation expirée refusée', () => as(fin2, () => rpc('payment_order_decide', po4.id, true, null)), 'DELEGATION_EXPIRED')
await as(admin, () => rpc('delegation_revoke', dExp, 'Expirée : clôture'))

// Délégation pas encore active : commence dans un jour
const po6 = await as(fin, () => rpc('payment_order_prepare', sup, 100, 'Future'))
const future = await as(dir, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', null, 1000, iso(2 * DAY), 'Pas encore active', iso(DAY)))
await rejects('délégation pas encore active refusée', () => as(fin2, () => rpc('payment_order_decide', po6.id, true, null)), 'DELEGATION_INACTIVE')
await as(admin, () => rpc('delegation_revoke', future, 'Nettoyage admin'))
ok('administrateur révoque une délégation d’un autre utilisateur (delegations.manage)', (await q(`select revoked_at is not null r from delegations where id=$1`, [future]))[0].r === true)

// --- C. Dérogations : demande → approbation → second contrôle indépendant ---------------------------------------------------------------
const der = await as(com, () => rpc('derogation_request', 'discount', 'other', null, 'Remise exceptionnelle client stratégique', dInv(30)))
ok('demande de dérogation : numéro DER-AAAA-nnnnnn', /^DER-\d{4}-\d{6}$/.test(der.number), der.number)
await rejects('dérogation : validité au-delà de 90 jours refusée', () => as(com, () => rpc('derogation_request', 'discount', 'other', null, 'Motif assez long ici', dInv(120))), 'DEROGATION_WINDOW')
await rejects('auto-approbation : admin demande puis approuve sa dérogation', async () => {
  const mine = await as(admin, () => rpc('derogation_request', 'price', 'other', null, 'Prix spécial test interne', dInv(10)))
  return as(admin, () => rpc('derogation_approve', mine.id, true, null))
}, 'SOD_SELF_APPROVAL')
await rejects('approbation : contrôleur sans derogations.approve refusé', () => as(qual, () => rpc('derogation_approve', der.id, true, null)), 'RBAC_FORBIDDEN')
await as(dir, () => rpc('derogation_approve', der.id, true, 'Accord direction'))
await rejects('contrôle indépendant : l’approbateur ne contrôle pas sa propre décision', () => as(dir, () => rpc('derogation_control', der.id, true, null)), 'SOD_NOT_INDEPENDENT')
await rejects('contrôle indépendant : le demandeur ne contrôle pas', () => as(com, () => rpc('derogation_control', der.id, true, null)), 'SOD_NOT_INDEPENDENT')
ok('dérogation non effective avant contrôle', (await as(qual, () => q(`select public.derogation_is_effective($1) e`, [der.id])))[0].e === false)
await as(qual, () => rpc('derogation_control', der.id, true, 'Contrôle conforme'))
ok('dérogation contrôlée : effective (période valide)', (await as(qual, () => q(`select public.derogation_is_effective($1) e`, [der.id])))[0].e === true)
await rejects('dérogation déjà contrôlée : second contrôle refusé', () => as(qual2, () => rpc('derogation_control', der.id, true, null)), 'DEROGATION_BAD_STATUS')
await rejects('défense en profondeur : base refuse approved_by = requested_by', async () =>
  exec(`update derogations set approved_by = requested_by, status='approved', approved_at=now() where id=$1`, [(await as(com, () => rpc('derogation_request', 'other', 'other', null, 'Autre motif valable', dInv(5)))).id]), 'derogations_check')
const derRej = await as(com, () => rpc('derogation_request', 'credit_limit', 'other', null, 'Dépassement de plafond client', dInv(20)))
await as(dir, () => rpc('derogation_approve', derRej.id, true, null))
await rejects('contrôle refusé sans commentaire', () => as(qual, () => rpc('derogation_control', derRej.id, false, null)), 'DEROGATION_COMMENT_REQUIRED')
await as(qual, () => rpc('derogation_control', derRej.id, false, 'Pièces insuffisantes'))
ok('contrôle négatif : dérogation rejetée, non effective', (await q(`select status from derogations where id=$1`, [derRej.id]))[0].status === 'rejected' && (await as(qual, () => q(`select public.derogation_is_effective($1) e`, [derRej.id])))[0].e === false)
await exec(`update derogations set valid_until = current_date - 1 where id = $1`, [der.id])
ok('dérogation contrôlée mais échue : non effective', (await as(qual, () => q(`select public.derogation_is_effective($1) e`, [der.id])))[0].e === false)

// --- D. Lots qualité critiques : le contrôleur ne libère pas son lot -------------------------------------------------------------------
const mat = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu coton','fabric','m') returning id`, [company]))[0].id
const insC = await as(qual, () => rpc('quality_inspection_open', 'reception', mat, null, null, null, 'BL-CRIT-1', 20, 'Lot critique'))
await rejects('lot critique : motif obligatoire pour le marquer', () => as(qual, () => rpc('quality_inspection_mark_critical', insC, 'x')), 'QUALITY_REASON_REQUIRED')
await as(qual, () => rpc('quality_inspection_mark_critical', insC, 'Matière certifiée sensible'))
await rejects('lot critique : le contrôleur qui a ouvert le lot ne le libère pas', () => as(qual, () => rpc('quality_inspection_decide', insC, 'accepted', null)), 'QUALITY_SELF_RELEASE')
await as(qual2, () => rpc('quality_inspection_decide', insC, 'accepted', 'Second contrôleur'))
ok('lot critique : libéré par un second contrôleur indépendant', (await q(`select decision, status from quality_inspections where id=$1`, [insC]))[0].decision === 'accepted')
const insN = await as(qual, () => rpc('quality_inspection_open', 'reception', mat, null, null, null, 'BL-STD-1', 10, 'Lot standard'))
await as(qual, () => rpc('quality_inspection_decide', insN, 'accepted', null))
ok('lot standard (non critique) : le même contrôleur peut le libérer', (await q(`select decision from quality_inspections where id=$1`, [insN]))[0].decision === 'accepted')
const insD = await as(qual, () => rpc('quality_inspection_open', 'reception', mat, null, null, null, 'BL-CRIT-2', 10, null))
await as(qual, () => rpc('quality_defect_code_save', 'DEF-CRIT', 'Défaut critique test', 'finition', 'critical'))
await as(qual, () => rpc('quality_defect_add', insD, 'DEF-CRIT', 1, 'critical', null))
await rejects('défaut critique saisi par le contrôleur : il ne libère pas le lot', () => as(qual, () => rpc('quality_inspection_decide', insD, 'accepted', null)), 'QUALITY_SELF_RELEASE')
await as(qual2, () => rpc('quality_inspection_decide', insD, 'rejected', 'Rejet par second contrôleur'))
ok('lot avec défaut critique : rejeté par un tiers (rejet autorisé)', (await q(`select decision from quality_inspections where id=$1`, [insD]))[0].decision === 'rejected')
await rejects('lot critique : tiers sans quality.approve refusé', () => as(com, () => rpc('quality_inspection_decide', insC, 'accepted', null)), 'RBAC_FORBIDDEN')

// Délégation de libération qualité bornée à un contrôle précis
const qual3 = await mkUser('qual3@x.com', 'magasin')
const insE = await as(qual, () => rpc('quality_inspection_open', 'reception', mat, null, null, null, 'BL-DEL-1', 5, 'Délégation qualité'))
const insF = await as(qual, () => rpc('quality_inspection_open', 'reception', mat, null, null, null, 'BL-DEL-2', 5, 'Hors délégation'))
await rejects('libération qualité sans permission ni délégation refusée', () => as(qual3, () => rpc('quality_inspection_decide', insE, 'accepted', null)), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('delegation_grant', qual3, 'quality.approve', 'quality_inspection', insE, null, iso(DAY), 'Remplacement qualité', null))
await as(qual3, () => rpc('quality_inspection_decide', insE, 'accepted', 'Libéré par délégation'))
ok('délégation qualité bornée : libère le contrôle désigné', (await q(`select decision from quality_inspections where id=$1`, [insE]))[0].decision === 'accepted')
await rejects('délégation qualité : refusée pour un autre contrôle (hors objet)', () => as(qual3, () => rpc('quality_inspection_decide', insF, 'accepted', null)), 'RBAC_FORBIDDEN')

// Annuaire : seules les personnes de la société, sans e-mail ni droits
const people = (await as(admin, () => q(`select id, full_name from company_people()`))).map((r) => r.id)
ok('annuaire : personnes de la société visibles', people.includes(dir) && people.includes(fin))
ok('annuaire : personne d’une autre société non visible', !people.includes(nobody))

// --- E. Audit des décisions -------------------------------------------------------------------------------------------------------------
const actions = new Set((await q(`select action from audit_logs where company_id=$1`, [company])).map((r) => r.action))
const expected = ['payment_order.prepare', 'payment_order.approve', 'delegation.grant', 'delegation.revoke', 'derogation.request', 'derogation.approve', 'derogation.control', 'derogation.control_reject', 'quality.mark_critical', 'quality.inspection_decide']
ok('audit : toutes les décisions sont journalisées', expected.every((a) => actions.has(a)), expected.filter((a) => !actions.has(a)).join(',') || 'complet')
const row = (await q(`select before_data, after_data, metadata from audit_logs where action='payment_order.approve' limit 1`))[0]
ok('audit : décision d’approbation avec montant, préparateur et statut', row && row.metadata.prepared_by === fin && row.after_data.status === 'approved', JSON.stringify(row?.metadata))
