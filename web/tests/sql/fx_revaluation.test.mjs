// Multi-devises : taux versionnés et signés, arrondis, réévaluation des postes ouverts et reprise, totaux cohérents — P063 / migration 0088
// Les taux de ce test sont des fixtures de test (non des cours de marché) : ils servent à vérifier le mécanisme, pas une valeur fiscale.
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const num = Number
/** Contexte utilisateur pour les déclencheurs (taux de la société), sans changer de rôle. */
const asSuper = async (uid, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid })}', false);`)
  try { return await fn() } finally { await db.exec(`select set_config('request.jwt.claims', '', false);`) }
}

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p063.com', 'finance')      // saisit les taux, la politique et lance les réévaluations
const fin2 = await mkUser('fin2@p063.com', 'finance')    // signe les taux et la politique
const nobody = await mkUser('nobody@p063.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const C1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P63-1','Client P63','FR') returning id`, [company]))[0].id
const S1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P63-1','Fournisseur P63','TN') returning id`, [company]))[0].id

// --- 1. Taux : versions, jamais d'écrasement -----------------------------------------------------------------------------------------------
const R1 = await as(fin, () => rpc('fx_rate_set', '2026-02-20', 'USD', 0.90))
await as(fin2, () => rpc('exchange_rate_validate', R1, true))
const RV1 = await as(fin, () => rpc('fx_rate_set', '2026-03-31', 'USD', 0.95))
await as(fin2, () => rpc('exchange_rate_validate', RV1, true))
const RV2 = await as(fin, () => rpc('fx_rate_set', '2026-03-31', 'USD', 0.96))
const hist = await as(fin, () => q(`select * from fx_rate_history('USD')`))
ok('même date : une nouvelle version créée, l’ancienne taux 0,95 conservée', hist.filter((h) => h.rate_date.toISOString().slice(0, 10) === '2026-03-31').length === 2)
const rateAt = (d) => as(fin, async () => num((await q(`select public.fx_rate('USD', $1::date) r`, [d]))[0].r))
ok('taux en vigueur : la dernière version (0,96), même non signée', (await rateAt('2026-03-31')) === 0.96)
ok('la dernière version n’est pas encore signée', (await q(`select status from exchange_rates where id=$1`, [RV2]))[0].status === 'a_valider')
ok('avant la date de la dernière version : le taux antérieur (0,90) reste la référence', (await rateAt('2026-03-30')) === 0.90)
await rejects('taux signé : modification directe refusée', () => db.exec(`update exchange_rates set rate = 9 where id='${RV1}'`), 'FX_IMMUTABLE')
await rejects('taux : suppression directe refusée', () => db.exec(`delete from exchange_rates where id='${RV1}'`), 'FX_IMMUTABLE')
await rejects('signature par son auteur refusée', () => as(fin, () => rpc('exchange_rate_validate', RV2, true)), 'SOD_SELF_APPROVAL')
await rejects('signature sans droit refusée', () => as(nobody, () => rpc('exchange_rate_validate', RV2, true)), 'RBAC_FORBIDDEN')
await rejects('signature déjà faite refusée', () => as(fin2, () => rpc('exchange_rate_validate', RV1, true)), 'FX_BAD_STATUS')

// Le réglage de la tarification (0040, exchange_rate_set avec source) ajoute aussi une version : pas d'écrasement non plus
await as(fin, () => rpc('exchange_rate_set', '2026-03-20', 'USD', 0.93, 'Source de test P63'))
await as(fin, () => rpc('exchange_rate_set', '2026-03-20', 'USD', 0.94, 'Source de test P63'))
const v320 = await as(fin, () => q(`select version, rate from exchange_rates where currency='USD' and rate_date='2026-03-20' order by version`))
ok('réglage 0040 : deux versions au 20 mars (0,93 puis 0,94), la première conservée', v320.length === 2 && num(v320[0].rate) === 0.93 && num(v320[1].rate) === 0.94)

// --- 2. Arrondis et conversions --------------------------------------------------------------------------------------------------------
ok('arrondi : 33,33 USD à 0,96 = 31,9968 → 32,00 (2 décimales EUR)', num((await as(fin, () => q(`select public.fx_convert(33.33, 'USD', '2026-03-31') r`)))[0].r) === 32)
await as(fin, () => rpc('fx_rate_set', '2026-03-31', 'TND', 0.33))
ok('arrondi : 1 000,555 TND à 0,33 = 330,18315 → 330,18', num((await as(fin, () => q(`select public.fx_convert(1000.555, 'TND', '2026-03-31') r`)))[0].r) === 330.18)

// --- 3. Factures : taux figé à l'émission, jamais réécrit -----------------------------------------------------------------------------
await db.exec('alter table invoices disable trigger user')
const AR = (await q(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total)
  values ($1,$2,'draft','FAC-P63-1','2026-02-20','2026-03-31','USD',0,1000,0,1000) returning id`, [company, C1]))[0].id
await db.exec(`alter table invoices enable trigger invoices_fx_snapshot_u; alter table invoices enable trigger invoices_gl_issue_u`)
await asSuper(fin, () => db.query(`update invoices set status='issued' where id=$1`, [AR]))
const arRow = (await q(`select fx_rate, base_total, total, paid_amount, credited_amount from invoices where id=$1`, [AR]))[0]
ok('facture USD émise le 20 février : taux figé 0,90 et équivalent 900', num(arRow.fx_rate) === 0.9 && num(arRow.base_total) === 900)
await db.exec('alter table invoices disable trigger user')
await asSuper(fin, () => db.query(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
  values ($1,'FS-P63-1',$2,'FS-P63-1','2026-02-25','2026-04-25','USD',500)`, [company, S1]))
await db.exec('alter table invoices enable trigger user')
const AP = (await q(`select id, fx_rate from supplier_invoices where number='FS-P63-1'`))[0]
ok('facture fournisseur USD du 25 février : taux figé 0,90', num(AP.fx_rate) === 0.9)
ok('facture émise : le taux figé ne bouge pas après de nouvelles versions', (await q(`select fx_rate from invoices where id=$1`, [AR]))[0].fx_rate === arRow.fx_rate)

// --- 4. Politique de réévaluation : signée, pas de valeur par défaut --------------------------------------------------------------------
await rejects('réévaluation sans politique refusée', () => as(fin, () => rpc('fx_revaluation_run', '2026-03-31')), 'FX_POLICY_MISSING')
await rejects('politique : méthode inconnue refusée', () => as(fin, () => rpc('fx_policy_set', 'auto', 'per_document_base_minor')), 'check constraint')
await as(fin, () => rpc('fx_policy_set', 'reversal_next_period', 'per_document_base_minor'))
await rejects('réévaluation avec politique non signée refusée', () => as(fin, () => rpc('fx_revaluation_run', '2026-03-31')), 'FX_POLICY_NOT_VALIDATED')
await rejects('politique : signature par son auteur refusée', () => as(fin, () => rpc('fx_policy_validate', true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('fx_policy_validate', true))
await rejects('politique signée : modification refusée', () => as(fin, () => rpc('fx_policy_set', 'no_reversal', 'per_document_base_minor')), 'FX_POLICY_IMMUTABLE')

// --- 5. Réévaluation au 31 mars : taux du jour signé requis ------------------------------------------------------------------------
await rejects('réévaluation : taux du jour non signé refusée', () => as(fin, () => rpc('fx_revaluation_run', '2026-03-31')), 'FX_RATE_NOT_VALIDATED')
await as(fin2, () => rpc('exchange_rate_validate', RV2, true))
await rejects('réévaluation : sans droit finance refusée', () => as(nobody, () => rpc('fx_revaluation_run', '2026-03-31')), 'RBAC_FORBIDDEN')
await rejects('réévaluation : date future refusée', () => as(fin, () => rpc('fx_revaluation_run', '2099-01-01')), 'FX_DATE_INVALID')

const pos = await as(fin, () => q(`select kind, number, open_amount, rate_booked, rate_today, base_booked, base_today, unrealized from fx_open_positions('2026-03-31')`))
const posAR = pos.find((p) => p.kind === 'receivable')
const posAP = pos.find((p) => p.kind === 'payable')
ok('positions : créance 1 000 USD, 900 au taux figé, 960 au taux du jour, écart +60', posAR && num(posAR.base_booked) === 900 && num(posAR.base_today) === 960 && num(posAR.unrealized) === 60)
ok('positions : dette 500 USD, 450 au taux figé, 480 au taux du jour, écart −30', posAP && num(posAP.base_booked) === 450 && num(posAP.base_today) === 480 && num(posAP.unrealized) === -30)

const R_A = await as(fin, () => rpc('fx_revaluation_run', '2026-03-31'))
const run1 = (await q(`select * from fx_revaluation_runs where id=$1`, [R_A]))[0]
ok('réévaluation : gain 60, perte 30, net 30', num(run1.gain_total) === 60 && num(run1.loss_total) === 30 && num(run1.net_total) === 30)
ok('réévaluation : écriture comptable créée et liée', run1.entry_id !== null)

const entryLines = await q(`select a.code, sum(l.debit) d, sum(l.credit) c from gl_entry_lines l join gl_accounts a on a.id=l.account_id where l.entry_id=$1 group by a.code order by a.code`, [run1.entry_id])
const byCode = Object.fromEntries(entryLines.map((x) => [x.code, { d: num(x.d), c: num(x.c) }]))
ok('écriture : 411 débit 60 (créance gagnée), 766 crédit 60', byCode['411'].d === 60 && byCode['766'].c === 60)
ok('écriture : 666 débit 30 (perte), 401 crédit 30 (dette augmentée)', byCode['666'].d === 30 && byCode['401'].c === 30)
const balance = (await q(`select sum(l.debit) d, sum(l.credit) c from gl_entry_lines l where l.entry_id=$1`, [run1.entry_id]))[0]
ok('écriture équilibrée : débit = crédit', num(balance.d) === num(balance.c))

ok('totaux cohérents : somme du détail = net de la réévaluation',
  num((await q(`select coalesce(sum(unrealized),0) s from fx_revaluation_lines where run_id=$1`, [R_A]))[0].s) === num(run1.net_total))
ok('totaux cohérents : détail = positions ouvertes au même jour',
  num((await as(fin, () => q(`select coalesce(sum(unrealized),0) s from fx_open_positions('2026-03-31')`)))[0].s) === num(run1.net_total))

await rejects('réévaluation : deuxième réévaluation du même jour refusée', () => as(fin, () => rpc('fx_revaluation_run', '2026-03-31')), 'FX_REVAL_ALREADY_RUN')
await rejects('réévaluation : nouvelle réévaluation avant reprise refusée', () => as(fin, () => rpc('fx_revaluation_run', '2026-04-30')), 'FX_REVAL_OPEN_RUN')

// --- 6. Reprise : écriture inverse datée après la réévaluation, une seule fois ------------------------------------------------------
await rejects('reprise : datée le jour même refusée', () => as(fin, () => rpc('fx_revaluation_reverse', R_A, '2026-03-31')), 'FX_REVAL_REVERSAL_DATE')
const REV = await as(fin, () => rpc('fx_revaluation_reverse', R_A, '2026-04-01'))
ok('reprise : écriture inverse créée', REV !== null)
await rejects('reprise : seconde reprise refusée', () => as(fin, () => rpc('fx_revaluation_reverse', R_A, '2026-04-02')), 'FX_REVAL_ALREADY_REVERSED')
const net = await q(`select a.code, sum(l.debit - l.credit) n from gl_entry_lines l join gl_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id
  where e.source_type in ('fx_revaluation','fx_reversal') group by a.code order by a.code`)
ok('réévaluation + reprise : effet net nul sur 411, 401, 666 et 766', net.every((x) => num(x.n) === 0))

// --- 7. Nouvelle réévaluation au 30 avril : taux signé, positions mesurées au taux de transaction --------------------------------------
const RA30 = await as(fin, () => rpc('fx_rate_set', '2026-04-30', 'USD', 0.99))
await rejects('réévaluation du 30 avril : taux non signé refusé', () => as(fin, () => rpc('fx_revaluation_run', '2026-04-30')), 'FX_RATE_NOT_VALIDATED')
await as(fin2, () => rpc('exchange_rate_validate', RA30, true))
const R_B = await as(fin, () => rpc('fx_revaluation_run', '2026-04-30'))
const run2 = (await q(`select * from fx_revaluation_runs where id=$1`, [R_B]))[0]
ok('réévaluation du 30 avril : mesurée au taux de transaction (gain 90, perte 45, net 45)',
  num(run2.gain_total) === 90 && num(run2.loss_total) === 45 && num(run2.net_total) === 45)
ok('historique : la réévaluation du 31 mars garde son taux du jour (0,96) et son net (30)',
  num((await q(`select rate_today from fx_revaluation_lines where run_id=$1 and kind='receivable'`, [R_A]))[0].rate_today) === 0.96 &&
  num((await q(`select net_total from fx_revaluation_runs where id=$1`, [R_A]))[0].net_total) === 30)

// --- 8. Historique, immuabilité, droits, audit ---------------------------------------------------------------------------------------
await rejects('réévaluation : ligne de détail modifiée refusée', () => db.exec(`update fx_revaluation_lines set unrealized = 0 where run_id='${R_A}'`), 'FX_IMMUTABLE')
await rejects('réévaluation : suppression refusée', () => db.exec(`delete from fx_revaluation_runs where id='${R_A}'`), 'FX_IMMUTABLE')
await rejects('réévaluation : montant modifié refusé', () => db.exec(`update fx_revaluation_runs set gain_total = 0 where id='${R_A}'`), 'FX_IMMUTABLE')
ok('facture : taux figé et équivalent intacts après les réévaluations', num((await q(`select fx_rate, base_total from invoices where id=$1`, [AR]))[0].base_total) === 900)
ok('lecture des réévaluations sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from fx_revaluation_runs`)))[0].n === 0)
const trial = (await as(fin, () => q(`select sum(total_debit) d, sum(total_credit) c from gl_trial_balance('2000-01-01','2030-12-31')`)))[0]
ok('grand livre : balance équilibrée après réévaluations et reprise', Math.abs(num(trial.d) - num(trial.c)) < 0.001)
const actions = (await q(`select string_agg(distinct action, ',' order by action) s from audit_logs where action like 'fx.%' or action like 'finance.fx%'`))[0].s
ok('audit : saisie, signature, politique, réévaluation et reprise tracées',
  ['finance.fx_rate', 'finance.fx_approve', 'fx.policy_set', 'fx.policy_validate', 'fx.revaluation_run', 'fx.revaluation_reverse'].every((a) => actions.includes(a)))
