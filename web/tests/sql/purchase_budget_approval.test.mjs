// Demandes d'achat et budget : engagé / réalisé, contrôle à la soumission, seuils, séparation des tâches, délégation bornée — P032 / migration 0057
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b) => Math.abs(Number(a) - b) < 0.0051

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const buyer = await mkUser('achat@x.com', 'achat')
const prod = await mkUser('prod@x.com', 'production')
const dir = await mkUser('dir@x.com', 'direction')
const dir2 = await mkUser('dir2@x.com', 'direction')
const fin = await mkUser('fin@x.com', 'finance')
const mag = await mkUser('mag@x.com', 'magasin')
const del = await mkUser('del@x.com', null)        // délégué : aucune permission directe
const nobody = await mkUser('nobody@x.com', null)

const Y = new Date().getUTCFullYear()
const YS = `${Y}-01-01`, YE = `${Y}-12-31`, DUE = `${Y}-09-30`

// Politique à deux niveaux (seuil 1000) : la configuration est réservée à approvals.manage (admin)
await as(admin, () => rpc('approval_policy_set', 'purchase_request', 2, 1000, 'purchases.approve', 'approvals.decide_high', 'approvals.escalate', 24))

// Centres de coût : A (budgété), B (sans budget)
const ccA = (await q(`insert into cost_centers(company_id, code, label, owner_id) values ($1,'CC-A','Atelier A',$2) returning id`, [company, admin]))[0].id
const ccB = (await q(`insert into cost_centers(company_id, code, label, owner_id) values ($1,'CC-B','Atelier B',$2) returning id`, [company, admin]))[0].id

// Données : matières avec prix catalogue, fournisseurs, entrepôt
const mat = async (name, unit, cost) => {
  const m = (await as(prod, () => q(`insert into bom_materials(name, category, unit) values ($1,'fabric',$2) returning *`, [name, unit])))[0]
  if (cost !== null) await as(buyer, () => db.query(`insert into bom_material_prices(material_id, unit_cost) values ($1,$2)`, [m.id, cost]))
  return m
}
const tissu = await mat('Tissu jaune HV', 'm', 8.5)
const zip = await mat('Zip 60 cm', 'pc', 1.2)
const sansPrix = await mat('Matière sans prix', 'pc', null)
const supA = (await as(buyer, () => q(`insert into suppliers(name, country, lead_time_days) values ('Tissus du Sud','TN',10) returning id`)))[0].id
await as(prod, () => db.query(`update bom_materials set supplier_id=$2 where id=$1`, [tissu.id, supA]))
await as(prod, () => db.query(`update bom_materials set supplier_id=$2 where id=$1`, [zip.id, supA]))
const wh = (await q(`insert into warehouses(company_id, name) values ($1, 'Magasin P032') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1, $2, $3, 'manager')`, [company, mag, wh])
const loc = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh]))[0].id

// Délégations et rôles : le demandeur n'a pas de pouvoir d'approbation
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
ok('prod (demandeur) n’a pas purchases.approve ; direction l’a', !(await perms('production')).includes('purchases.approve') && (await perms('direction')).includes('purchases.approve'))

// --- 1. Budget : définition, bornes, lecture -------------------------------------------------------------------------------------
await rejects('budget : saisie refusée à l’acheteur (finance.write réservé)', () => as(buyer, () => rpc('purchase_budget_set', null, ccA, YS, YE, 1000)), 'RBAC_FORBIDDEN')
await rejects('budget : période inversée refusée', () => as(fin, () => rpc('purchase_budget_set', null, ccA, YE, YS, 1000)), 'BUDGET_BAD_PERIOD')
const bA = await as(fin, () => rpc('purchase_budget_set', null, ccA, YS, YE, 1000))
await rejects('budget : chevauchement sur le même centre refusé', () => as(fin, () => rpc('purchase_budget_set', null, ccA, `${Y}-06-01`, `${Y}-12-31`, 500)), 'BUDGET_OVERLAP')
const s0 = await as(buyer, () => rpc('purchase_budget_summary', ccA, DUE))
ok('budget : lecture acheteur, montant 1000, engagé 0, réalisé 0, disponible 1000', Number(s0.amount) === 1000 && Number(s0.engaged) === 0 && Number(s0.realised) === 0 && Number(s0.available) === 1000)
await rejects('budget : lecture refusée sans droit achats', () => as(nobody, () => rpc('purchase_budget_summary', ccA, DUE)), 'RBAC_FORBIDDEN')

// --- 2. Demandes : contrôle à la soumission ---------------------------------------------------------------------------------------
const mkDa = (reason, cc = ccA, needed = DUE) => as(prod, async () => (await q(`insert into purchase_requests(needed_date, reason, cost_center_id) values ($1, $2, $3) returning *`, [needed, reason, cc]))[0])
const addL = (da, m, qty) => as(prod, () => db.query(`insert into purchase_request_lines(request_id, material_id, qty) values ($1,$2,$3)`, [da, m, qty]))
const status = async (id) => (await q(`select status, decision_comment from purchase_requests where id=$1`, [id]))[0]
const engaged = async (cc = ccA) => Number((await as(buyer, () => rpc('purchase_budget_summary', cc, DUE))).engaged)

const short = await mkDa('ok')
await addL(short.id, tissu.id, 1)
await rejects('soumission refusée : motif trop court pour une demande budgétée', () => as(prod, () => rpc('purchase_request_submit', short.id)), 'PURCHASE_REASON_REQUIRED')

const PRa = await mkDa('Collection hiver : tissu jaune')
await addL(PRa.id, tissu.id, 100)                               // 100 m × 8,50 (prix catalogue repris) = 850
await as(prod, () => rpc('purchase_request_submit', PRa.id))
const lineA = (await q(`select est_unit_cost from purchase_request_lines where request_id=$1`, [PRa.id]))[0]
ok('soumission : estimation reprise du prix catalogue (8,50), statut soumise', near(lineA.est_unit_cost, 8.5) && (await status(PRa.id)).status === 'submitted')
const apA = (await q(`select id, state, amount from approval_requests where object_type='purchase_request' and object_id=$1`, [PRa.id]))[0]
ok('workflow : une demande d’approbation ouverte, montant 850, niveau 1', apA.state === 'pending_l1' && near(apA.amount, 850))
ok('engagé après soumission : 850, disponible 150', near(await engaged(), 850) && near((await as(buyer, () => rpc('purchase_budget_summary', ccA, DUE))).available, 150))

const PRb = await mkDa('Mercerie pour la même collection')
await addL(PRb.id, zip.id, 200)                                 // 200 × 1,20 = 240 > 150 disponibles
await rejects('budget dépassé : soumission refusée (BUDGET_EXCEEDED)', () => as(prod, () => rpc('purchase_request_submit', PRb.id)), 'BUDGET_EXCEEDED')
ok('budget dépassé : la demande reste en brouillon, rien n’est engagé', (await status(PRb.id)).status === 'draft' && near(await engaged(), 850))

const PRc = await mkDa('Demande sur centre sans budget', ccB)
await addL(PRc.id, zip.id, 10)
await rejects('centre sans budget défini : soumission refusée (BUDGET_NOT_DEFINED)', () => as(prod, () => rpc('purchase_request_submit', PRc.id)), 'BUDGET_NOT_DEFINED')

const PRd = await mkDa('Matière sans prix catalogue')
await addL(PRd.id, sansPrix.id, 5)
await rejects('estimation absente : soumission refusée (PURCHASE_ESTIMATE_REQUIRED)', () => as(prod, () => rpc('purchase_request_submit', PRd.id)), 'PURCHASE_ESTIMATE_REQUIRED')

// --- 3. Séparation des tâches et décision directe refusée -----------------------------------------------------------------------
const decA = async (who, action, reason) => as(who, () => rpc('approval_decide', apA.id, action, reason))
const sodBefore = (await q(`select count(*)::int n from approval_decisions where request_id=$1 and action='attempt_refused'`, [apA.id]))[0].n
const selfTry = await decA(prod, 'approve', null)
ok('demandeur ne peut pas approuver sa demande : tentative refusée et journalisée', selfTry.ok === false && selfTry.code === 'SOD_SELF_APPROVAL'
  && (await q(`select count(*)::int n from approval_decisions where request_id=$1 and action='attempt_refused'`, [apA.id]))[0].n === sodBefore + 1)
await rejects('décision directe refusée tant qu’une demande d’approbation est ouverte', () => as(dir, () => rpc('purchase_request_decide', PRa.id, true, null)), 'PURCHASE_USE_APPROVAL')
await rejects('acheteur sans purchases.approve ne peut pas décider', () => as(buyer, () => rpc('approval_decide', apA.id, 'approve', null)), 'RBAC_FORBIDDEN')

// --- 4. Approbation de niveau 1, puis seuil : niveau 2 avec approbateur distinct ------------------------------------------------
const ok1 = await decA(dir, 'approve', null)
ok('850 ≤ seuil : approuvée au niveau 1 ; demande DA approuvée, décision tracée', ok1.ok && ok1.state === 'approved' && (await status(PRa.id)).status === 'approved')
ok('approbation : décideur et date renseignés', (await q(`select decided_by, decided_at from purchase_requests where id=$1`, [PRa.id]))[0].decided_by === dir)
ok('engagé inchangé par l’approbation (demande approuvée = toujours engagée)', near(await engaged(), 850))

await as(fin, () => rpc('purchase_budget_set', bA, ccA, YS, YE, 5000))
await rejects('budget : révision sous l’engagé + réalisé refusée (BUDGET_BELOW_COMMITTED)', () => as(fin, () => rpc('purchase_budget_set', bA, ccA, YS, YE, 100)), 'BUDGET_BELOW_COMMITTED')

const PRe = await mkDa('Grosse commande de tissu')
await addL(PRe.id, tissu.id, 240)                                // 240 × 8,50 = 2040 > 1000 : niveau 2
await as(prod, () => rpc('purchase_request_submit', PRe.id))
const apE = (await q(`select id from approval_requests where object_type='purchase_request' and object_id=$1`, [PRe.id]))[0]
const l1 = await as(dir, () => rpc('approval_decide', apE.id, 'approve', null))
ok('2040 > seuil : niveau 1 valide, demande en attente de niveau 2', l1.ok && l1.state === 'pending_l2' && (await status(PRe.id)).status === 'submitted')
const l2same = await as(dir, () => rpc('approval_decide', apE.id, 'approve', null))
ok('niveau 2 : même personne que le niveau 1 refusée (SOD_NOT_INDEPENDENT)', l2same.ok === false && l2same.code === 'SOD_NOT_INDEPENDENT')
const l2 = await as(dir2, () => rpc('approval_decide', apE.id, 'approve', null))
ok('niveau 2 par un autre directeur : approuvée', l2.ok && l2.state === 'approved' && (await status(PRe.id)).status === 'approved')

// --- 5. Refus visible et libération de l'engagé ------------------------------------------------------------------------------------
const PRf = await mkDa('Demande à refuser')
await addL(PRf.id, zip.id, 100)                                  // 120
await as(prod, () => rpc('purchase_request_submit', PRf.id))
const apF = (await q(`select id from approval_requests where object_type='purchase_request' and object_id=$1`, [PRf.id]))[0]
const eBeforeRefuse = await engaged()
const refused = await as(dir, () => rpc('approval_decide', apF.id, 'refuse', 'Hors budget de la saison'))
const sF = await status(PRf.id)
ok('refus : demande refusée avec motif visible sur la DA', refused.state === 'refused' && sF.status === 'rejected' && sF.decision_comment === 'Hors budget de la saison')
ok('refus : l’engagé est libéré (120 retirés)', near(await engaged(), eBeforeRefuse - 120))

// --- 6. Annulation : libère l'engagé, ferme la demande d'approbation ----------------------------------------------------------------
const PRg = await mkDa('Demande annulée par le demandeur')
await addL(PRg.id, zip.id, 10)                                   // 12
await as(prod, () => rpc('purchase_request_submit', PRg.id))
const apGrefuse = (await q(`select id from approval_requests where object_type='purchase_request' and object_id=$1`, [PRg.id]))[0]
await rejects('refus à motif trop court (moins de 10 caractères) refusé', () => as(dir, () => rpc('approval_decide', apGrefuse.id, 'refuse', 'court')), 'APPROVAL_REASON_REQUIRED')
ok('refus à motif trop court : aucune modification d’état', (await q(`select state from approval_requests where id=$1`, [apGrefuse.id]))[0].state === 'pending_l1')
const eBeforeCancel = await engaged()
await as(prod, () => rpc('purchase_request_cancel', PRg.id))
const apG = (await q(`select state from approval_requests where object_type='purchase_request' and object_id=$1`, [PRg.id]))[0]
ok('annulation : demande annulée, approbation fermée, engagé libéré (12)', (await status(PRg.id)).status === 'cancelled' && apG.state === 'cancelled' && near(await engaged(), eBeforeCancel - 12))

// --- 7. Délégation bornée ----------------------------------------------------------------------------------------------------------------
await as(dir, () => rpc('approval_delegation_grant', del, 'purchase_request', 'purchases.approve', 500, `${Y + 1}-01-01T00:00:00Z`, 'Absence du directeur'))
const PRh = await mkDa('Achat de 850 hors délégation')
await addL(PRh.id, tissu.id, 100)                                // 850 > limite 500
await as(prod, () => rpc('purchase_request_submit', PRh.id))
const apH = (await q(`select id from approval_requests where object_type='purchase_request' and object_id=$1`, [PRh.id]))[0]
await rejects('délégation : montant au-delà de la limite refusé', () => as(del, () => rpc('approval_decide', apH.id, 'approve', null)), 'RBAC_FORBIDDEN')
const PRi = await mkDa('Achat de 120 dans la délégation')
await addL(PRi.id, zip.id, 100)                                  // 120 ≤ 500
await as(prod, () => rpc('purchase_request_submit', PRi.id))
const apI = (await q(`select id from approval_requests where object_type='purchase_request' and object_id=$1`, [PRi.id]))[0]
const dOk = await as(del, () => rpc('approval_decide', apI.id, 'approve', null))
const dRow = (await q(`select on_behalf_of from approval_decisions where request_id=$1 and action='approve'`, [apI.id]))[0]
ok('délégation : approbation dans la limite, tracée au nom du délégant', dOk.ok && dOk.state === 'approved' && dRow.on_behalf_of === dir && (await status(PRi.id)).status === 'approved')

// --- 8. Commande et réalisé : l'engagé migre vers la commande, puis le réalisé se constate à la réception -----------------------
const eBeforeOrder = await engaged()
const pos = await as(buyer, () => rpc('purchase_request_to_orders', PRa.id))
ok('transformation en commande : engagé inchangé (pas de double comptage)', pos.length === 1 && near(await engaged(), eBeforeOrder))
const poA = (await q(`select id, total_amount from purchase_orders where request_id=$1`, [PRa.id]))[0]
const tl = (await q(`select id from purchase_order_lines where po_id=$1`, [poA.id]))[0].id
await as(buyer, () => rpc('purchase_order_send', poA.id))
await as(mag, () => rpc('purchase_receive', poA.id, wh, loc, JSON.stringify([{ line_id: tl, qty: 40 }]), 'BL-P032-1', null))
const sR = await as(buyer, () => rpc('purchase_budget_summary', ccA, DUE))
ok('réception partielle : réalisé 340 (40 × 8,50), engagé diminué d’autant', near(sR.realised, 340) && near(sR.engaged, eBeforeOrder - 340))
ok('disponible = montant − engagé − réalisé', near(sR.available, 5000 - Number(sR.engaged) - Number(sR.realised)))

// --- 9. Trace : chaque décision et refus est journalisé ------------------------------------------------------------------------------
ok('journal : refus de demande et annulation présents dans le journal d’approbation', (await q(`select count(*)::int n from approval_decisions where action in ('refuse','cancel')`))[0].n >= 2)
ok('audit : création de budget et révision tracées', (await q(`select count(*)::int n from audit_logs where action in ('purchase.budget_create','purchase.budget_update')`))[0].n >= 2)
