// Confection, personnalisation et temps réels : déclarations par opération, BAT, rebuts et retouches, corrections
// tardives approuvées, tâches par poste affecté — P049 / migration 0074
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, eps = 0.0005) => Math.abs(Number(a) - b) < eps
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
const comm = await mkUser('com@x.com', ['commercial'])
const comm2 = await mkUser('com2@x.com', ['commercial'])
const prod = await mkUser('prod@x.com', ['production'])
const opA = await mkUser('opa@x.com', ['production'])     // opérateur de confection
const opP = await mkUser('opp@x.com', ['production'])     // opérateur de personnalisation
const fin = await mkUser('fin@x.com', ['finance'])
const nobody = await mkUser('nobody@x.com', [])

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))

// --- Clients, article, commande confirmée, contact habilité, logo et BAT ----------------------------------------------------------
const C = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('LAFONT P49','TN','EUR',true) returning id`)))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-P49','Polo brodé P49','jacket') returning id`, [C])))[0].id
const O1 = (await as(comm, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C])))[0].id
const line1 = (await db.query(`insert into sales_order_lines(company_id, order_id, article_id, qty, unit_price, due_date) values ($1,$2,$3,50,12,$4) returning id`, [company, O1, art, iso(20)])).rows[0].id
const line2 = (await db.query(`insert into sales_order_lines(company_id, order_id, article_id, qty, unit_price, due_date) values ($1,$2,$3,10,12,$4) returning id`, [company, O1, art, iso(20)])).rows[0].id
await as(admin, () => rpc('sales_order_confirm', O1))
const contactOk = (await db.query(`insert into client_contacts(company_id, client_id, full_name, email) values ($1,$2,'Marie Durand','marie@lafont.test') returning id`, [company, C])).rows[0].id
await as(comm, () => rpc('client_contact_set_bat_approver', contactOk, true))
const folder = async (key) => (await q(`select id from ged_folders where client_id=$1 and system_key=$2`, [C, key]))[0].id
const logoDoc = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'Logo P49','${sha('1')}') returning id`, [company, C, await folder('logos')]))[0].id
const batDoc = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,$3,'BAT P49 PDF','${sha('a')}') returning id`, [company, C, await folder('bat')]))[0].id
const LOGO = await as(comm, () => rpc('logo_register', C, logoDoc, 'Logo P49', 'owned', 'Logo fourni par le client, cession écrite datée', null))
await as(comm, () => rpc('personalization_spec_set', line1, LOGO, 'embroidery', 'poitrine', 80, 60, ['#000000'], 'Brodé 1 couleur'))
const spec1 = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [line1]))[0].id
await as(comm, () => rpc('personalization_spec_set', line2, LOGO, 'screen_print', 'dos', 200, 250, ['#FFFFFF'], 'Sérigraphie dos'))
const spec2 = (await q(`select id from personalization_specs where order_line_id=$1 and status='current'`, [line2]))[0].id
const B1 = await as(comm, () => rpc('bat_issue', spec1, batDoc))

// --- Gamme approuvée (confection puis personnalisation) et OF lancé -------------------------------------------------------------------
const WCC = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'CONF49','Confection P49','couture') returning id`, [company]))[0].id
const WCP = (await q(`insert into work_centers(company_id, code, name, kind) values ($1,'PERS49','Personnalisation P49','personnalisation') returning id`, [company]))[0].id
const rv = await as(admin, () => rpc('routing_version_create', art, 'Gamme P49'))
await as(admin, () => rpc('routing_operation_add', rv, 'confection', 'Confection du polo', WCC, null, 30, 'min', 0, 'Vérifier la couture de col'))
await as(admin, () => rpc('routing_operation_add', rv, 'personnalisation', 'Broderie logo', WCP, null, 20, 'min', 5, 'Respecter le placement'))
await as(dir, () => rpc('routing_version_approve', rv, 'Gamme validée'))
const OF = await as(admin, () => rpc('production_order_create', art, 10, 60, WCC, iso(0), iso(10), O1, 'OF P49'))
const ofNumber = (await q(`select number from production_orders where id=$1`, [OF]))[0].number
await as(admin, () => rpc('production_order_launch', OF))

// --- Affectations : chaque opérateur ne voit que son poste ---------------------------------------------------------------------------
await rejects('affectation par un utilisateur sans droit de planification refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_operator_assign', opA, WCC, true)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('production_operator_assign', opA, WCC, true))
await as(prod, () => rpc('production_operator_assign', opP, WCP, true))
const tasksA = await as(opA, () => rpc('production_my_tasks'))
const tasksP = await as(opP, () => rpc('production_my_tasks'))
ok('opérateur de confection : une seule tâche (confection), aucune tâche de personnalisation', tasksA.length === 1 && tasksA[0].op_kind === 'confection' && tasksA[0].instructions === 'Vérifier la couture de col')
ok('opérateur de personnalisation : une seule tâche (personnalisation), marquée à personnaliser', tasksP.length === 1 && tasksP[0].op_kind === 'personnalisation' && tasksP[0].needs_personalization === true)
ok('sans affectation : aucune tâche', (await as(admin, () => rpc('production_my_tasks'))).length === 0)
await rejects('tâches sans droit d’opérateur refusées (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_my_tasks')), 'RBAC_FORBIDDEN')

// --- Personnalisation : sans BAT approuvé, rien n'est déclarable -------------------------------------------------------------------------
await rejects('personnalisation sans spécification refusée (PERSO_SPEC_REQUIRED)', () => as(opP, () => rpc('production_operation_declare', OF, 2, iso(0), 20, 0, 0, 1, 0, 0, null, null, null)), 'PERSO_SPEC_REQUIRED')
await rejects('personnalisation : BAT émis mais non approuvé, déclaration refusée (PERSO_NO_VALID_BAT)', () => as(opP, () => rpc('production_operation_declare', OF, 2, iso(0), 20, 0, 0, 1, 0, 0, spec1, null, null)), 'PERSO_NO_VALID_BAT')
await as(comm2, () => rpc('bat_record_acceptance', B1, contactOk, 'email', 'Mail de Marie Durand du jour, BAT approuvé', iso(0), sha('a')))
await rejects('personnalisation : spécification d’une autre ligne de la commande, sans BAT, refusée (PERSO_NO_VALID_BAT)', () => as(opP, () => rpc('production_operation_declare', OF, 2, iso(0), 20, 0, 0, 1, 0, 0, spec2, null, null)), 'PERSO_NO_VALID_BAT')
await as(prod, () => rpc('personalization_operation_start', spec1))

// --- Déclarations : confection et personnalisation ---------------------------------------------------------------------------------------
const E1 = await as(opA, () => rpc('production_operation_declare', OF, 1, iso(0), 60, 0, 0, 6, 2, 1, null, null, 'Lot du matin'))
const E2 = await as(opA, () => rpc('production_operation_declare', OF, 1, iso(0), 30, 15, 0, 0, 0, 0, null, 'Panne machine', null))
await rejects('arrêt sans motif refusé (OPERATION_STOP_REASON_REQUIRED)', () => as(opA, () => rpc('production_operation_declare', OF, 1, iso(0), 0, 10, 0, 0, 0, 0, null, null, null)), 'OPERATION_STOP_REASON_REQUIRED')
await rejects('opérateur non affecté au poste de personnalisation refusé (OPERATION_NOT_AUTHORIZED)', () => as(opA, () => rpc('production_operation_declare', OF, 2, iso(0), 20, 0, 0, 1, 0, 0, spec1, null, null)), 'OPERATION_NOT_AUTHORIZED')
await rejects('déclaration sans temps ni pièce refusée (OPERATION_TIME_REQUIRED)', () => as(opA, () => rpc('production_operation_declare', OF, 1, iso(0), 0, 0, 0, 0, 0, 0, null, null, null)), 'OPERATION_TIME_REQUIRED')
await rejects('déclaration datée dans le futur refusée (OPERATION_DATE_INVALID)', () => as(opA, () => rpc('production_operation_declare', OF, 1, iso(1), 10, 0, 0, 1, 0, 0, null, null, null)), 'OPERATION_DATE_INVALID')
const E_LATE = await as(opA, () => rpc('production_operation_declare', OF, 1, iso(-3), 40, 0, 0, 1, 0, 0, null, null, 'Saisie tardive'))
await rejects('pièces au-delà de la quantité de l’OF refusées (OPERATION_QTY_EXCEEDED)', () => as(opA, () => rpc('production_operation_declare', OF, 1, iso(0), 0, 0, 0, 2, 0, 0, null, null, null)), 'OPERATION_QTY_EXCEEDED')
const E3 = await as(opP, () => rpc('production_operation_declare', OF, 2, iso(0), 20, 0, 0, 5, 0, 0, spec1, null, 'Broderie OK'))
ok('déclarations enregistrées : confection (3) et personnalisation (1) avec BAT approuvé', E1 && E2 && E_LATE && E3 && (await q(`select count(*)::int n from production_operation_entries where order_id=$1`, [OF]))[0].n === 4)

// --- Totaux : rebuts et retouches jamais comptés bons -------------------------------------------------------------------------------------
const t0 = await as(admin, () => rpc('production_order_totals', OF))
const op1 = t0.operations.find((o) => o.op_pos === 1)
ok('rebut et retouche non comptés bons : confection 7 bons (6 + 1), 2 rebuts, 1 retouche', near(op1.good, 7) && near(op1.scrap, 2) && near(op1.rework, 1))
ok('temps : productif 130 min, arrêt 15 min (motif tracé), aucune correction en attente', near(op1.productive_min, 130) && near(op1.stop_min, 15) && t0.pending_corrections === 0)
ok('bonnes pièces de l’OF = bons du dernier poste (personnalisation : 5)', near(t0.good_pieces, 5))

// --- Corrections tardives : motif, approbation distincte, totaux seulement après approbation ----------------------------------------------
const aC1 = await as(opA, () => rpc('production_entry_request_correction', E_LATE, 5, 0, 0, 0, 0, 0, 'Oubli de 5 min de saisie'))
const adjLate = (await q(`select late, status from production_entry_adjustments where id=$1`, [aC1]))[0]
ok('correction d’une saisie de plus de 2 jours : marquée tardive, en attente', adjLate.late === true && adjLate.status === 'pending')
ok('avant approbation : totaux inchangés', near((await as(admin, () => rpc('production_order_totals', OF))).operations.find((o) => o.op_pos === 1).productive_min, 130))
await rejects('correction au motif trop court refusée (CORRECTION_REASON_REQUIRED)', () => as(opA, () => rpc('production_entry_request_correction', E1, 1, 0, 0, 0, 0, 0, 'ok')), 'CORRECTION_REASON_REQUIRED')
await rejects('correction par un utilisateur sans droit refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('production_entry_request_correction', E1, 1, 0, 0, 0, 0, 0, 'Motif suffisamment long')), 'RBAC_FORBIDDEN')
const aC2 = await as(opA, () => rpc('production_entry_request_correction', E1, 0, 0, 0, -50, 0, 0, 'Correction de bons trop élevée'))
const aC3 = await as(admin, () => rpc('production_entry_request_correction', E2, 1, 0, 0, 0, 0, 0, 'Ajustement de temps productif'))
await rejects('décision par le demandeur (sans droit d’approbation) refusée (RBAC_FORBIDDEN)', () => as(opA, () => rpc('production_entry_decide_correction', aC1, true, 'Auto')), 'RBAC_FORBIDDEN')
await rejects('approbation par le demandeur de la correction refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('production_entry_decide_correction', aC3, true, 'Auto')), 'SOD_SELF_APPROVAL')
await as(dir, () => rpc('production_entry_decide_correction', aC1, true, 'Saisie justifiée, pièce jointe au dossier'))
ok('après approbation : temps productif 135 (130 + 5)', near((await as(admin, () => rpc('production_order_totals', OF))).operations.find((o) => o.op_pos === 1).productive_min, 135))
await rejects('correction rendant des bons négatifs refusée à l’approbation (CORRECTION_NEGATIVE)', () => as(dir, () => rpc('production_entry_decide_correction', aC2, true, 'Vérification')), 'CORRECTION_NEGATIVE')
await as(dir, () => rpc('production_entry_decide_correction', aC2, false, 'Correction refusée : bons non justifiés'))
await as(dir, () => rpc('production_entry_decide_correction', aC3, true, 'Ajustement accepté'))
await rejects('décision déjà prise : seconde décision refusée (CORRECTION_BAD_STATUS)', () => as(dir, () => rpc('production_entry_decide_correction', aC1, false, 'Revirement')), 'CORRECTION_BAD_STATUS')
const t1 = await as(admin, () => rpc('production_order_totals', OF))
const op1b = t1.operations.find((o) => o.op_pos === 1)
ok('après décisions : productif 136 (130 + 5 + 1), bons 7 inchangés (correction refusée), rebuts 2', near(op1b.productive_min, 136) && near(op1b.good, 7) && near(op1b.scrap, 2) && t1.pending_corrections === 0)

// --- Droits et audit ----------------------------------------------------------------------------------------------------------------------
await rejects('saisie directe d’une déclaration refusée (permission denied)', () => as(admin, () => db.query(`insert into production_operation_entries(company_id, order_id, op_pos, work_center_id, op_kind, entry_date, productive_min) values ($1,$2,1,$3,'confection',current_date,5)`, [company, OF, WCC])), 'permission denied')
await rejects('déclaration modifiée directement refusée (OPERATION_APPEND_ONLY)', () => db.query(`update production_operation_entries set good_qty = 99 where id=$1`, [E1]), 'OPERATION_APPEND_ONLY')
await rejects('déclaration effacée refusée (OPERATION_APPEND_ONLY)', () => db.query(`delete from production_operation_entries where id=$1`, [E1]), 'OPERATION_APPEND_ONLY')
await rejects('correction approuvée non modifiable (OPERATION_APPEND_ONLY)', () => db.query(`update production_entry_adjustments set reason = 'Autre motif de correction' where id=$1`, [aC1]), 'OPERATION_APPEND_ONLY')
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action=$1`, [a]))[0].n)
ok('audit : 4 déclarations, 3 demandes de correction, 2 approbations, 1 refus', (await aud('production.operation_declare')) === 4 && (await aud('production.correction_request')) === 3
  && (await aud('production.correction_approve')) === 2 && (await aud('production.correction_reject')) === 1)
ok('audit : affectations des opérateurs tracées', (await aud('production.operator_assign')) === 2)
ok('OF : statut passé en cours à la première déclaration', (await q(`select status from production_orders where id=$1`, [OF]))[0].status === 'in_progress')
void ofNumber
