// Recouvrement et trésorerie prévisionnelle : politique signée, litige suspend la relance, promesses et plans suivis,
// brouillons de relance sans envoi, escalades, balance âgée hors litige, scores révisables, prévision 13 semaines sourcée — P067 / migration 0091
// Toutes les données sont des fixtures de test (non des données réelles). Les dates sont relatives à aujourd'hui.
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const rows = (fn, ...args) => db.query(`select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args).then((r) => r.rows)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p067.com', 'finance')     // saisit politique, promesses, plans, brouillons
const fin2 = await mkUser('fin2@p067.com', 'finance')   // signe politique, hypothèses, plans ; approuve les brouillons
const nobody = await mkUser('nobody@p067.com', null)

const [T] = (await q(`select current_date::text t`)).map((r) => r.t)
const day = (n) => { const x = new Date(`${T}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])

// ---------------------------------------------------------------------------
// Fixtures : clients, factures émises (insertion directe, déclencheurs suspendus), litige, fournisseurs, trésorerie
// ---------------------------------------------------------------------------
const cl = async (code) => (await q(`insert into clients(company_id, code, name, country) values ($1,$2,$3,'FR') returning id`, [company, code, `Client ${code}`]))[0].id
const C1 = await cl('CL-P67-1'), C2 = await cl('CL-P67-2'), C3 = await cl('CL-P67-3'), C4 = await cl('CL-P67-4'), C5 = await cl('CL-P67-5')
const C6 = await cl('CL-P67-6'), C7 = await cl('CL-P67-7'), C8 = await cl('CL-P67-8'), C9 = await cl('CL-P67-9')

await db.exec('alter table invoices disable trigger all')
const inv = async (code, client, total, dueOffset, { currency = 'EUR', fx = 1, paid = 0, status = 'issued' } = {}) =>
  (await q(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate, paid_amount)
    values ($1,$2,$3,$4,$5,$6,$7,0,$8,0,$8,$9,$10) returning id`,
    [company, client, status, code, day(dueOffset - 30), day(dueOffset), currency, total, fx, paid]))[0].id
const I1 = await inv('FAC-P67-1', C1, 1000, -45)
const I2 = await inv('FAC-P67-2', C2, 800, -20)
const I3 = await inv('FAC-P67-3', C3, 500, -10)
const I4 = await inv('FAC-P67-4', C4, 300, -6)
const I5 = await inv('FAC-P67-5', C4, 250, -5)
const I6 = await inv('FAC-P67-6', C6, 400, -15, { currency: 'USD', fx: null })    // sans taux applicable
const I7 = await inv('FAC-P67-7', C5, 400, -30)
const I8 = await inv('FAC-P67-8', C8, 500, -40)
const I9 = await inv('FAC-P67-9', C7, 500, -100)
const I10 = await inv('FAC-P67-10', C9, 700, 200)                                    // échéance au-delà de l'horizon
await db.query(`insert into client_invoice_disputes(company_id, invoice_id, amount, reason, status) values ($1,$2,300,'Quantité contestée','open')`, [company, I2])
await db.exec('alter table invoices enable trigger all')

const S1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P67-1','Fournisseur P67','TN') returning id`, [company]))[0].id
await db.exec('alter table supplier_invoices disable trigger all')
await db.query(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total, paid_amount, status)
  values ($1,'FSI-P67-1',$2,'REF-1',$3,$4,'EUR',400,0,'open')`, [company, S1, day(-10), day(5)])
await db.query(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total, paid_amount, status)
  values ($1,'FSI-P67-2',$2,'REF-2',$3,$4,'EUR',200,0,'disputed')`, [company, S1, day(-10), day(10)])
await db.exec('alter table supplier_invoices enable trigger all')
await as(fin, () => db.query(`select public.cash_account_create('Banque P67', 10000, $1::date)`, [day(-100)]))

// ---------------------------------------------------------------------------
// 1. Politique : création, signature distincte, droits
// ---------------------------------------------------------------------------
await rejects('politique : création sans droit refusée', () => as(nobody, () => rpc('collection_policy_create', 'POL_P67_A', day(-365), 7, 30, 60, 90, true, true, false)), 'RBAC_FORBIDDEN')
await rejects('relance sans politique validée refusée', () => as(fin, () => rpc('collection_reminders_generate', T)), 'COLLECTION_NO_POLICY')
const P1 = await as(fin, () => rpc('collection_policy_create', 'POL_P67_A', day(-365), 7, 30, 60, 90, true, true, false))
await rejects('politique : signature par son auteur refusée', () => as(fin, () => rpc('collection_policy_validate', P1, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('collection_policy_validate', P1, true))
ok('politique : version signée par une autre personne', (await q(`select status from collection_policies where id=$1`, [P1]))[0].status === 'valide')
await rejects('politique : version signée figée', () => db.query(`update collection_policies set contact_frequency_days = 1 where id = $1`, [P1]), 'COLLECTION_LOCKED')

// ---------------------------------------------------------------------------
// 2. Promesse sur I3 (avant la génération) : engagement qui suspend la relance
// ---------------------------------------------------------------------------
await as(fin, () => rpc('collection_promise_create', I3, 200, day(5), 'Paiement annoncé'))

// ---------------------------------------------------------------------------
// 3. Relances : brouillons, litige, engagement, fréquence, doublon
// ---------------------------------------------------------------------------
const gen = await as(fin, () => rpc('collection_reminders_generate', T))
ok('relances : 5 brouillons créés', gen.created === 5, JSON.stringify(gen))
ok('relances : litige suspend la relance (I2)', gen.skipped_dispute === 1, JSON.stringify(gen))
ok('relances : promesse ouverte suspend la relance (I3)', gen.skipped_commitment === 1, JSON.stringify(gen))
ok('relances : fréquence par client (I5 après I4)', gen.skipped_frequency === 1, JSON.stringify(gen))
const drafts = await q(`select i.code, d.level, d.status from collection_reminder_drafts d join invoices i on i.id = d.invoice_id order by i.code`)
ok('relances : aucun brouillon pour la pièce en litige', !drafts.some((d) => d.code === 'FAC-P67-2'))
ok('relances : aucun brouillon pour la pièce sans taux', !drafts.some((d) => d.code === 'FAC-P67-6'))
ok('relances : niveau 3 au-delà du seuil (I9, 100 jours)', drafts.some((d) => d.code === 'FAC-P67-9' && d.level === 3))
ok('relances : niveau 2 entre les seuils (I1, 45 jours)', drafts.some((d) => d.code === 'FAC-P67-1' && d.level === 2))
const again = await as(fin, () => rpc('collection_reminders_generate', T))
ok('relances : relance rejouée sans nouveau brouillon', again.created === 0, JSON.stringify(again))

// ---------------------------------------------------------------------------
// 4. Brouillons : approbation distincte, envoi conditionné à la politique
// ---------------------------------------------------------------------------
const D1 = (await q(`select d.id from collection_reminder_drafts d join invoices i on i.id = d.invoice_id where i.code='FAC-P67-1'`))[0].id
const D9 = (await q(`select d.id from collection_reminder_drafts d join invoices i on i.id = d.invoice_id where i.code='FAC-P67-9'`))[0].id
await rejects('brouillon : approbation par son auteur refusée', () => as(fin, () => rpc('collection_draft_approve', D1, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('collection_draft_approve', D1, true))
await as(fin2, () => rpc('collection_draft_approve', D9, false))
ok('brouillon : approuvé puis annulé', (await q(`select status from collection_reminder_drafts where id=$1`, [D9]))[0].status === 'annule')
await rejects('envoi : refusé tant que la politique ne l\'autorise pas', () => as(fin2, () => rpc('collection_draft_authorize_send', D1)), 'COLLECTION_SEND_NOT_AUTHORIZED')
const P2 = await as(fin, () => rpc('collection_policy_create', 'POL_P67_B', day(-30), 7, 30, 60, 90, true, true, true))
await as(fin2, () => rpc('collection_policy_validate', P2, true))
await rejects('envoi : par l\'auteur de la relance refusé', () => as(fin, () => rpc('collection_draft_authorize_send', D1)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('collection_draft_authorize_send', D1))
ok('envoi : autorisation enregistrée (envoi réel hors application)', (await q(`select status from collection_reminder_drafts where id=$1`, [D1]))[0].status === 'envoi_autorise')
await rejects('envoi : autorisation renouvelée refusée', () => as(fin2, () => rpc('collection_draft_authorize_send', D1)), 'COLLECTION_BAD_STATUS')

// ---------------------------------------------------------------------------
// 5. Promesses : plafond, doublon, encaissement, rupture
// ---------------------------------------------------------------------------
await rejects('promesse : montant au-delà de l\'exigible refusé', () => as(fin, () => rpc('collection_promise_create', I1, 1100, day(3), null)), 'COLLECTION_PROMISE_AMOUNT')
await rejects('promesse : date passée refusée', () => as(fin, () => rpc('collection_promise_create', I1, 100, day(-1), null)), 'COLLECTION_BAD_DATE')
await as(fin, () => rpc('collection_promise_create', I1, 300, day(3), 'Virement annoncé'))
await rejects('promesse : seconde promesse ouverte sur la pièce refusée', () => as(fin, () => rpc('collection_promise_create', I1, 100, day(4), null)), 'COLLECTION_PROMISE_EXISTS')
const PR7 = await as(fin, () => rpc('collection_promise_create', I7, 150, T, 'Chèque remis'))
await as(fin, () => db.query(`select public.invoice_record_payment($1, 300, $2::date, 'transfer', 'VIR-P67-1')`, [I1, T]))
const f0 = await as(fin, () => rpc('collection_promise_follow_up', T))
ok('promesse : tenue quand l\'encaissement couvre le montant', f0.kept >= 1, JSON.stringify(f0))
ok('promesse : I3 reste ouverte avant son échéance', (await q(`select status from collection_promises where invoice_id=$1`, [I3]))[0].status === 'open')
const f1 = await as(fin, () => rpc('collection_promise_follow_up', day(1)))
ok('promesse : rompue après échéance sans encaissement', f1.broken === 1 && (await q(`select status from collection_promises where id=$1`, [PR7]))[0].status === 'broken', JSON.stringify(f1))
await rejects('promesse : annulation d\'une promesse rompue refusée', () => as(fin, () => rpc('collection_promise_cancel', PR7, 'Erreur de saisie')), 'COLLECTION_BAD_STATUS')

// ---------------------------------------------------------------------------
// 6. Plans de paiement : plafond sur le retard, signature, suivi sur encaissements
// ---------------------------------------------------------------------------
await rejects('plan : somme au-delà du retard exigible refusée', () => as(fin, () => rpc('payment_plan_create', C1, JSON.stringify([{ due_on: day(7), amount: 1200 }]))), 'COLLECTION_PLAN_EXCEEDS_OVERDUE')
await rejects('plan : échéances non croissantes refusées', () => as(fin, () => rpc('payment_plan_create', C1, JSON.stringify([{ due_on: day(30), amount: 100 }, { due_on: day(7), amount: 100 }]))), 'COLLECTION_BAD_SCHEDULE')
const PL1 = await as(fin, () => rpc('payment_plan_create', C1, JSON.stringify([{ due_on: day(7), amount: 400 }, { due_on: day(30), amount: 300 }])))
await as(fin2, () => rpc('payment_plan_validate', PL1, true))
ok('plan : signé et valide', (await q(`select status from payment_plans where id=$1`, [PL1]))[0].status === 'valide')
const PL8 = await as(fin, () => rpc('payment_plan_create', C8, JSON.stringify([{ due_on: day(2), amount: 500 }])))
await as(fin2, () => rpc('payment_plan_validate', PL8, true))
await as(fin, () => db.query(`select public.invoice_record_payment($1, 500, $2::date, 'transfer', 'VIR-P67-8')`, [I8, T]))
const pf1 = await as(fin, () => rpc('payment_plan_follow_up', day(1)))
ok('plan : soldé quand l\'échéance est couverte', pf1.settled === 1, JSON.stringify(pf1))
const pf8 = await as(fin, () => rpc('payment_plan_follow_up', day(8)))
ok('plan : rompu quand une échéance non couverte est dépassée', pf8.broken === 1 && (await q(`select status from payment_plans where id=$1`, [PL1]))[0].status === 'rompu', JSON.stringify(pf8))

// ---------------------------------------------------------------------------
// 7. Escalades : retard au seuil, promesse rompue, plan rompu ; pas de doublon ; clôture motivée
// ---------------------------------------------------------------------------
const e1 = await as(fin, () => rpc('collection_escalations_run', day(8)))
ok('escalades : trois ouvertes (retard, promesse, plan)', e1.opened === 3, JSON.stringify(e1))
const e2 = await as(fin, () => rpc('collection_escalations_run', day(8)))
ok('escalades : relance sans doublon', e2.opened === 0, JSON.stringify(e2))
const reasons = Object.fromEntries((await q(`select reason, count(*)::int n from collection_escalations where status='open' group by reason`)).map((r) => [r.reason, r.n]))
ok('escalades : motifs attendus', reasons.retard_seuil === 1 && reasons.promesse_rompue === 1 && reasons.plan_rompu === 1, JSON.stringify(reasons))
const ESC = (await q(`select id from collection_escalations where reason='plan_rompu'`))[0].id
await rejects('escalade : clôture sans motif refusée', () => as(fin, () => rpc('collection_escalation_close', ESC, 'ok')), 'COLLECTION_REASON_REQUIRED')
await as(fin, () => rpc('collection_escalation_close', ESC, 'Nouvel échéancier demandé au client'))
ok('escalade : clôturée avec motif', (await q(`select status from collection_escalations where id=$1`, [ESC]))[0].status === 'closed')

// ---------------------------------------------------------------------------
// 8. Balance âgée : litige hors exigible, pièce sans taux signalée
// ---------------------------------------------------------------------------
const aging = await as(fin, () => rows('collection_aging', T))
const a2 = aging.find((r) => r.client_code === 'CL-P67-2')
const a6 = aging.find((r) => r.client_code === 'CL-P67-6')
ok('balance âgée : litige séparé de l\'exigible', Number(a2.disputed) === 300 && Number(a2.d1_30) === 500 && Number(a2.total) === 800, JSON.stringify(a2))
ok('balance âgée : pièce sans taux signalée et exclue', Number(a6.total) === 0 && a6.fx_missing === 1, JSON.stringify(a6))
await rejects('balance âgée : lecture sans droit refusée', () => as(nobody, () => rows('collection_aging', T)), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------
// 9. Scores : modèle signé, bandes par seuil, historique sans doublon
// ---------------------------------------------------------------------------
const M1 = await as(fin, () => rpc('collection_score_model_create', 'SCORE_P67_A', day(-365), 1, 10, 5, 10, 35))
await as(fin2, () => rpc('collection_score_model_validate', M1, true))
const sc = await as(fin, () => rpc('collection_scores_run', M1, T))
ok('scores : clients scorés', sc > 0, `(${sc})`)
const band = Object.fromEntries((await q(`select c.code, s.band from collection_scores s join clients c on c.id = s.client_id where s.model_id=$1`, [M1])).map((r) => [r.code, r.band]))
ok('scores : bande « élevé » au-dessus du seuil (CL-P67-1)', band['CL-P67-1'] === 'eleve', JSON.stringify(band))
ok('scores : bande « standard » sous le seuil (CL-P67-2)', band['CL-P67-2'] === 'standard', JSON.stringify(band))
const sc2 = await as(fin, () => rpc('collection_scores_run', M1, T))
ok('scores : second calcul identique sans doublon', sc2 === 0, `(${sc2})`)

// ---------------------------------------------------------------------------
// 10. Trésorerie prévisionnelle : hypothèses signées, exécution figée, lignes sourcées
// ---------------------------------------------------------------------------
const H1 = await as(fin, () => rpc('cash_forecast_hypothesis_create', 'HYP_P67_A', day(-365), 90, 50, 0, 100, 100, 0))
await rejects('prévision : hypothèse non signée refusée', () => as(fin, () => rpc('cash_forecast_run', T, H1, 13)), 'COLLECTION_HYPOTHESIS_NOT_VALID')
await as(fin2, () => rpc('cash_forecast_hypothesis_validate', H1, true))
const RUN = await as(fin, () => rpc('cash_forecast_run', T, H1, 13))
const run = (await q(`select * from cash_forecast_runs where id=$1`, [RUN]))[0]
ok('prévision : solde d\'ouverture = trésorerie réelle (10 000 + 800 encaissés)', Number(run.opening_balance) === 10800, `(${run.opening_balance})`)
ok('prévision : encaissements prévus (litige et engagements suivis)', Number(run.receipts_total) === 1675, `(${run.receipts_total})`)
ok('prévision : décaissements prévus (fournisseur en litige à 0 %)', Number(run.payments_total) === 400, `(${run.payments_total})`)
ok('prévision : pièce sans taux exclue et comptée', run.excluded_fx_missing === 1, `(${run.excluded_fx_missing})`)
ok('prévision : échéance au-delà de l\'horizon comptée, non incluse', run.excluded_beyond_horizon === 1, `(${run.excluded_beyond_horizon})`)
const chk = await as(fin, () => rpc('cash_forecast_check', RUN))
ok('prévision : chaque ligne sourcée et totaux égaux', chk.ok === true && chk.unsourced_lines === 0, JSON.stringify(chk))
const l2 = (await q(`select amount from cash_forecast_lines where run_id=$1 and source_ref='FAC-P67-2'`, [RUN]))[0]
ok('prévision : litige retiré de la source (FAC-P67-2 : 500 × 50 %)', l2 && Number(l2.amount) === 250, JSON.stringify(l2))
const wk = await as(fin, () => rows('cash_forecast_weeks', RUN))
ok('prévision : 13 semaines, solde projeté cohérent', wk.length === 13 && Number(wk[12].projected_balance) === 12075, `(${wk[12] && wk[12].projected_balance})`)
await rejects('prévision : ligne figée (ajout seul)', () => db.query(`update cash_forecast_lines set amount = 1 where run_id = $1`, [RUN]), 'COLLECTION_APPEND_ONLY')
await rejects('prévision : exécution figée (suppression refusée)', () => db.query(`delete from cash_forecast_runs where id = $1`, [RUN]), 'COLLECTION_APPEND_ONLY')

// ---------------------------------------------------------------------------
// 11. Journal et droits
// ---------------------------------------------------------------------------
const au = (await q(`select count(*)::int n from audit_logs where action like 'collections.%' or action like 'forecast.%'`))[0].n
ok('audit : opérations de recouvrement et de prévision journalisées', au >= 20, `(${au})`)
await rejects('prévision : exécution sans droit refusée', () => as(nobody, () => rpc('cash_forecast_run', T, H1, 13)), 'RBAC_FORBIDDEN')
const P3 = await as(fin, () => rpc('collection_policy_create', 'POL_P67_C', day(-10), 7, 30, 60, 90, true, true, false))
await rejects('politique : signature sans droit de validation refusée', () => as(nobody, () => rpc('collection_policy_validate', P3, true)), 'RBAC_FORBIDDEN')
