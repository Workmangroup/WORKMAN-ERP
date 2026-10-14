// Immobilisations : acquisition, mise en service, amortissement linéaire reproductible, période close respectée, cession rapprochée,
// inventaire contre le grand livre, règles et catégories signées — P064 / migration 0089
// Les durées, comptes et montants sont des fixtures de test (non des paramètres fiscaux ou comptables réels).
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const num = Number
const lines = (...l) => JSON.stringify(l)
const L = (account, debit, credit, label = 'ligne') => ({ account, debit, credit, label })

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p064.com', 'finance')
const fin2 = await mkUser('fin2@p064.com', 'finance')
const nobody = await mkUser('nobody@p064.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const sumOf = (rows, key) => rows.reduce((s, r) => s + num(r[key]), 0)
const r2 = (x) => Math.round(x * 100) / 100

// --- 1. Comptes nécessaires (saisis par la finance, à valider par l'expert) ----------------------------------------------------------
await as(fin, () => rpc('gl_account_add', '2180', 'Matériel test P64', 2, 'asset'))
await as(fin, () => rpc('gl_account_add', '2810', 'Amortissement matériel test P64', 2, 'asset'))
await as(fin, () => rpc('gl_account_add', '6811', 'Dotation test P64', 6, 'expense'))
await as(fin, () => rpc('gl_account_add', '6581', 'Moins-value test P64', 6, 'expense'))
await as(fin, () => rpc('gl_account_add', '7581', 'Plus-value test P64', 7, 'income'))

// --- 2. Règles comptables et fiscales : saisies, signées par une autre personne, jamais par défaut ----------------------------------
await rejects('règle : saisie sans droit refusée', () => as(nobody, () => rpc('asset_rule_create', 'accounting', 'ACC_TEST_60', 60, '2026-01-01')), 'RBAC_FORBIDDEN')
const RA = await as(fin, () => rpc('asset_rule_create', 'accounting', 'ACC_TEST_60', 60, '2026-01-01'))
const RT = await as(fin, () => rpc('asset_rule_create', 'tax', 'TAX_TEST_36', 36, '2026-01-01'))
const RU = await as(fin, () => rpc('asset_rule_create', 'accounting', 'ACC_TEST_UNSIGNED', 48, '2026-01-01'))
await rejects('règle : signature par son auteur refusée', () => as(fin, () => rpc('asset_rule_validate', RA, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('asset_rule_validate', RA, true))
await as(fin2, () => rpc('asset_rule_validate', RT, true))
ok('règles : comptable et fiscale distinctes, signées', (await q(`select count(*)::int n from asset_rule_sets where status='valide'`))[0].n === 2)
await rejects('règle signée : modification directe refusée', () => db.exec(`update asset_rule_sets set useful_life_months = 1 where id='${RA}'`), 'FIXED_ASSET_IMMUTABLE')

// --- 3. Catégorie : comptes contrôlés, signature distincte --------------------------------------------------------------------------
await rejects('catégorie : compte inconnu refusé', () => as(fin, () => rpc('fixed_asset_category_create', 'BAD', 'Mauvais', '2180', '2810', '6811', '9999', '7581')), 'FIXED_ASSET_CATEGORY_ACCOUNT_MISSING')
const CAT = await as(fin, () => rpc('fixed_asset_category_create', 'MAT', 'Matériel', '2180', '2810', '6811', '7581', '6581'))
const CATU = await as(fin, () => rpc('fixed_asset_category_create', 'NONVAL', 'Catégorie non signée', '2180', '2810', '6811', '7581', '6581'))
await rejects('catégorie : signature par son auteur refusée', () => as(fin, () => rpc('fixed_asset_category_validate', CAT, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('fixed_asset_category_validate', CAT, true))

// --- 4. Acquisition : écriture au coût, montants contrôlés -------------------------------------------------------------------------------
await rejects('acquisition : valeur résiduelle ≥ coût refusée', () => as(fin, () => rpc('fixed_asset_acquire', CAT, 'Presse test', '2026-01-10', 500, 500, '521')), 'FIXED_ASSET_BAD_AMOUNT')
await rejects('acquisition : catégorie non signée refusée', () => as(fin, () => rpc('fixed_asset_acquire', CATU, 'Presse test', '2026-01-10', 500, 0, '521')), 'FIXED_ASSET_CATEGORY_NOT_VALIDATED')
await rejects('acquisition : contrepartie inconnue refusée', () => as(fin, () => rpc('fixed_asset_acquire', CAT, 'Presse test', '2026-01-10', 500, 0, '9998')), 'GL_ACCOUNT_MISSING')
const A1 = await as(fin, () => rpc('fixed_asset_acquire', CAT, 'Presse A', '2026-01-10', 1000, 100, '521'))
const A2 = await as(fin, () => rpc('fixed_asset_acquire', CAT, 'Presse B', '2026-01-10', 1000, 0, '521'))
const a1 = (await q(`select * from fixed_assets where id=$1`, [A1]))[0]
const a2 = (await q(`select * from fixed_assets where id=$1`, [A2]))[0]
ok('acquisition : codes FIX-000001 et FIX-000002, statut brouillon, écriture liée', a1.code === 'FIX-000001' && a2.code === 'FIX-000002' && a1.status === 'draft' && a1.acquisition_entry_id !== null)
const acqLines = await q(`select g.code, sum(l.debit) d, sum(l.credit) c from gl_entry_lines l join gl_accounts g on g.id=l.account_id join gl_entries e on e.id=l.entry_id
  where e.id=$1 group by g.code`, [a1.acquisition_entry_id])
ok('acquisition : 2180 débit 1 000, 521 crédit 1 000', acqLines.find((x) => x.code === '2180') && num(acqLines.find((x) => x.code === '2180').d) === 1000 && num(acqLines.find((x) => x.code === '521').c) === 1000)

// --- 5. Mise en service : justificatif, règles validées, durée figée -----------------------------------------------------------------------
await rejects('mise en service : sans justificatif fournisseur refusée', () => as(fin, () => rpc('fixed_asset_commission', A1, '2026-02-01', 'ACC_TEST_60', 'TAX_TEST_36')), 'FIXED_ASSET_DOCUMENT_REQUIRED')
await as(fin, () => rpc('fixed_asset_document_add', A1, 'supplier_invoice', 'FS-AST-1', '2026-01-10'))
await as(fin, () => rpc('fixed_asset_document_add', A2, 'supplier_invoice', 'FS-AST-2', '2026-01-10'))
await rejects('mise en service : règle non signée refusée', () => as(fin, () => rpc('fixed_asset_commission', A1, '2026-02-01', 'ACC_TEST_UNSIGNED', 'TAX_TEST_36')), 'FIXED_ASSET_RULE_NOT_VALIDATED')
await rejects('mise en service : date antérieure à l’acquisition refusée', () => as(fin, () => rpc('fixed_asset_commission', A1, '2026-01-01', 'ACC_TEST_60', 'TAX_TEST_36')), 'FIXED_ASSET_BAD_DATE')
await as(fin, () => rpc('fixed_asset_commission', A1, '2026-02-01', 'ACC_TEST_60', 'TAX_TEST_36'))
await as(fin, () => rpc('fixed_asset_commission', A2, '2026-02-01', 'ACC_TEST_60', 'TAX_TEST_36'))
const a1s = (await q(`select * from fixed_assets where id=$1`, [A1]))[0]
ok('mise en service : statut en service, durée figée (60 mois comptable, 36 fiscal)', a1s.status === 'in_service' && a1s.acc_life_months === 60 && a1s.tax_life_months === 36)
await rejects('mise en service : seconde fois refusée', () => as(fin, () => rpc('fixed_asset_commission', A1, '2026-02-01', 'ACC_TEST_60', 'TAX_TEST_36')), 'FIXED_ASSET_BAD_STATUS')
await rejects('immobilisation en service : durée modifiée directement refusée', () => db.exec(`update fixed_assets set acc_life_months = 1 where id='${A1}'`), 'FIXED_ASSET_BAD_STATUS')

// --- 6. Dotation reproductible : fonction pure, arrondi et dernier mois ---------------------------------------------------------------------
const sched = async (cost, residual, life, date) => (await q(`select * from private.asset_schedule($1,$2,$3,$4::date) order by period_year, period_month`, [cost, residual, life, date]))
const sA = await sched(1000, 100, 60, '2026-02-01')
const sA2 = await sched(1000, 100, 60, '2026-02-01')
ok('dotation reproductible : deux calculs identiques', JSON.stringify(sA) === JSON.stringify(sA2))
ok('dotation : 60 mensualités de 15,00 du 02/2026 au 01/2031, total 900', sA.length === 60 && num(sA[0].amount) === 15 && num(sA[59].amount) === 15 && r2(sumOf(sA, 'amount')) === 900 && sA[0].period_year === 2026 && sA[0].period_month === 2)
const sB = await sched(1000, 0, 60, '2026-02-01')
ok('arrondi : 1 000 sur 60 mois = 16,67 par mois, dernier mois 16,47, total exact 1 000',
  num(sB[0].amount) === 16.67 && num(sB[58].amount) === 16.67 && num(sB[59].amount) === 16.47 && r2(sumOf(sB, 'amount')) === 1000)
const sTax = await sched(1000, 100, 36, '2026-02-01')
ok('dotation fiscale : 900 sur 36 mois = 25,00 (calcul séparé, non comptabilisé)', num(sTax[0].amount) === 25 && r2(sumOf(sTax, 'amount')) === 900)

// --- 7. Dotations comptabilisées : une écriture par mois, idempotente, équilibrée -------------------------------------------------------
const E_FEB = await as(fin, () => rpc('fixed_asset_depreciation_post', 2026, 2))
const dep = await q(`select a.code, p.amount, p.entry_id from fixed_asset_depreciation_posted p join fixed_assets a on a.id=p.asset_id where p.period_year=2026 and p.period_month=2 order by a.code`)
ok('dotation février : A1 15,00 et A2 16,67 comptabilisées', dep.length === 2 && num(dep[0].amount) === 15 && num(dep[1].amount) === 16.67)
ok('dotation reproductible : chaque montant posté = calcul de l’échéancier', (await q(`select count(*)::int n from fixed_asset_depreciation_posted p join lateral private.asset_schedule(
  (select acquisition_cost from fixed_assets where id=p.asset_id),(select residual_value from fixed_assets where id=p.asset_id),
  (select acc_life_months from fixed_assets where id=p.asset_id),(select in_service_date from fixed_assets where id=p.asset_id)) s
  on s.period_year=p.period_year and s.period_month=p.period_month where s.amount = p.amount and p.period_year=2026 and p.period_month=2`))[0].n === 2)
const feb = await q(`select g.code, sum(l.debit) d, sum(l.credit) c from gl_entry_lines l join gl_accounts g on g.id=l.account_id where l.entry_id=$1 group by g.code`, [E_FEB])
ok('écriture de dotation : 6811 débit 31,67, 2810 crédit 31,67, équilibrée',
  num(feb.find((x) => x.code === '6811').d) === 31.67 && num(feb.find((x) => x.code === '2810').c) === 31.67 && num(feb.find((x) => x.code === '6811').c) === 0)
const E_FEB2 = await as(fin, () => rpc('fixed_asset_depreciation_post', 2026, 2))
ok('dotation : rejouée, même écriture, aucun doublon', E_FEB2 === E_FEB && (await q(`select count(*)::int n from fixed_asset_depreciation_posted where period_year=2026 and period_month=2`))[0].n === 2)
ok('dotation sans immobilisation échue : aucune écriture (2025-12)', (await as(fin, () => rpc('fixed_asset_depreciation_post', 2025, 12))) === null)
await as(fin, () => rpc('fixed_asset_depreciation_post', 2026, 3))
await rejects('dotation : mois invalide refusé', () => as(fin, () => rpc('fixed_asset_depreciation_post', 2026, 13)), 'FIXED_ASSET_PERIOD_INVALID')

// --- 8. Période close respectée ---------------------------------------------------------------------------------------------------------
await as(fin, () => rpc('gl_close_period', 2026, 12))
await rejects('période close : dotation de décembre refusée', () => as(fin, () => rpc('fixed_asset_depreciation_post', 2026, 12)), 'GL_PERIOD_CLOSED')
ok('période close : aucune dotation décembre enregistrée', (await q(`select count(*)::int n from fixed_asset_depreciation_posted where period_year=2026 and period_month=12`))[0].n === 0)

// --- 9. Cessions : dotations à jour, écriture équilibrée, plus ou moins-value, rapprochement ----------------------------------------------
await rejects('cession : dotations en retard refusée (avril non comptabilisé)', () => as(fin, () => rpc('fixed_asset_dispose', A2, '2026-04-15', 1000, '521', 'Cession de test avril')), 'FIXED_ASSET_DEPRECIATION_PENDING')
await rejects('cession : produit sans compte refusé', () => as(fin, () => rpc('fixed_asset_dispose', A1, '2026-03-15', 800, null, 'Cession sans compte')), 'FIXED_ASSET_BAD_AMOUNT')
await rejects('cession : motif trop court refusé', () => as(fin, () => rpc('fixed_asset_dispose', A1, '2026-03-15', 800, '521', 'x')), 'FIXED_ASSET_REASON_REQUIRED')
const D1 = await as(fin, () => rpc('fixed_asset_dispose', A1, '2026-03-15', 800, '521', 'Vente du matériel A'))
const d1 = (await q(`select * from fixed_asset_disposals where id=$1`, [D1]))[0]
ok('cession A1 : valeur nette 970, produit 800, moins-value 170', num(d1.accumulated) === 30 && num(d1.net_book_value) === 970 && num(d1.loss) === 170 && num(d1.gain) === 0)
const chk1 = await as(fin, () => rpc('fixed_asset_disposal_check', D1))
ok('cession rapprochée A1 : écriture équilibrée, coût, amortissement, produit et moins-value concordants', chk1.balanced && chk1.proceeds_ok && chk1.cost_removed_ok && chk1.accumulated_removed_ok && chk1.gain_loss_ok && chk1.register_matches_ledger)
ok('cession A1 : immobilisation sortie du registre', (await q(`select status from fixed_assets where id=$1`, [A1]))[0].status === 'disposed')
await rejects('cession : déjà cédée refusée', () => as(fin, () => rpc('fixed_asset_dispose', A1, '2026-03-16', 800, '521', 'Deuxième cession')), 'FIXED_ASSET_BAD_STATUS')
await as(fin, () => rpc('fixed_asset_depreciation_post', 2026, 4))
ok('avril : seule A2 est dotée après la cession de A1 (16,67)', (await q(`select count(*)::int n from fixed_asset_depreciation_posted where period_year=2026 and period_month=4`))[0].n === 1)
const D2 = await as(fin, () => rpc('fixed_asset_dispose', A2, '2026-04-15', 1000, '521', 'Vente du matériel B'))
const d2 = (await q(`select * from fixed_asset_disposals where id=$1`, [D2]))[0]
ok('cession A2 : amortissement cumulé 50,01, valeur nette 949,99, plus-value 50,01', num(d2.accumulated) === 50.01 && num(d2.net_book_value) === 949.99 && num(d2.gain) === 50.01 && num(d2.loss) === 0)
const chk2 = await as(fin, () => rpc('fixed_asset_disposal_check', D2))
ok('cession rapprochée A2 : concordance complète', chk2.balanced && chk2.register_matches_ledger)

// --- 10. Inventaire : registre contre grand livre, écart détecté ----------------------------------------------------------------------
const inv1 = await as(fin, () => q(`select account, kind, register, ledger, difference from fixed_asset_reconcile('2026-04-30')`))
ok('inventaire au 30 avril : aucun écart (registre vide après cessions)', inv1.every((x) => num(x.difference) === 0))
await as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-20', 'Écriture manuelle test P64', lines(L('2180', 50, 0), L('521', 0, 50))))
const manual = (await q(`select id from gl_entries where label='Écriture manuelle test P64'`))[0].id
await as(fin, () => rpc('gl_entry_validate', manual))
const inv2 = await as(fin, () => q(`select account, kind, register, ledger, difference from fixed_asset_reconcile('2026-04-30')`))
const gap = inv2.find((x) => x.account === '2180')
ok('inventaire : écart de 50 sur 2180 détecté (écriture hors registre)', gap && num(gap.difference) === -50)

// --- 11. Historique immuable, droits, audit ---------------------------------------------------------------------------------------------
await rejects('dotation comptabilisée : modification refusée', () => db.exec(`update fixed_asset_depreciation_posted set amount = 1 where period_year=2026 and period_month=2`), 'FIXED_ASSET_IMMUTABLE')
await rejects('cession : suppression refusée', () => db.exec(`delete from fixed_asset_disposals where id='${D1}'`), 'FIXED_ASSET_IMMUTABLE')
await rejects('immobilisation cédée : retour en service refusé', () => db.exec(`update fixed_assets set status='in_service' where id='${A1}'`), 'FIXED_ASSET_BAD_STATUS')
await rejects('immobilisation : coût modifié refusé', () => db.exec(`update fixed_assets set acquisition_cost = 1 where id='${A2}'`), 'FIXED_ASSET_IMMUTABLE')
await rejects('cession sans droit refusée', () => as(nobody, () => rpc('fixed_asset_dispose', A2, '2026-05-01', 0, null, 'Tentative sans droit')), 'RBAC_FORBIDDEN')
ok('lecture des immobilisations sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from fixed_assets`)))[0].n === 0)
const trial = (await as(fin, () => q(`select sum(total_debit) d, sum(total_credit) c from gl_trial_balance('2000-01-01','2030-12-31')`)))[0]
ok('grand livre : balance équilibrée après acquisitions, dotations et cessions', Math.abs(num(trial.d) - num(trial.c)) < 0.001)
const actions = (await q(`select string_agg(distinct action, ',' order by action) s from audit_logs where action like 'assets.%'`))[0].s
ok('audit : règles, catégories, acquisition, mise en service, dotation et cession tracées',
  ['assets.rule_create', 'assets.rule_validate', 'assets.category_create', 'assets.category_validate', 'assets.acquire', 'assets.commission', 'assets.depreciation_post', 'assets.dispose'].every((a) => actions.includes(a)))
