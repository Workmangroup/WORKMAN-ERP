import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql', '0022_finance.sql', '0027_multicurrency.sql', '0029_export_vat_rule.sql', '0030_vat_rates_versioned.sql', '0031_general_ledger.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
/** Contexte utilisateur pour les déclencheurs, sans changer de rôle (fixtures et mises à jour directes). */
const asSuper = async (uid, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid })}', false);`)
  try { return await fn() } finally { await db.exec(`select set_config('request.jwt.claims', '', false);`) }
}
const d = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const num = (v) => Number(v)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@gl.com', 'admin')
const fin = await mkUser('fin@gl.com', 'finance')
const dir = await mkUser('dir@gl.com', 'direction')
const nobody = await mkUser('nobody@gl.com', null)

// --- 1. Plan comptable et journaux provisoires ----------------------------------------------------------------------------
ok('plan comptable : 9 comptes créés pour la société', (await q(`select count(*)::int n from gl_accounts where company_id=$1`, [company]))[0].n === 9)
ok('plan comptable : tous les comptes à valider par l’expert', (await q(`select count(*)::int n from gl_accounts where company_id=$1 and status='a_valider'`, [company]))[0].n === 9)
ok('journaux : VT, AC, BQ, CA, OD', (await q(`select string_agg(code, ',' order by code) s from gl_journals where company_id=$1`, [company]))[0].s === 'AC,BQ,CA,OD,VT')
await rejects('compte de plan : code invalide refusé', () => db.query(`insert into gl_accounts(company_id, code, label, account_class, kind) values ($1, 'AB', 'Mauvais', 4, 'asset')`, [company]), 'check')

// --- 2. Facture client émise : 411 / 701 / 445 ----------------------------------------------------------------------------
const c1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-GL-1','Textile Sfax','TN') returning id`, [company]))[0].id
const c2 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-GL-2','LAFONT','FR') returning id`, [company]))[0].id
const s1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-GL-1','Tissus Nord','TN') returning id`, [company]))[0].id
await db.exec('alter table invoices disable trigger user')
const draft = async (client, currency, total, tax, rate) => (await q(
  `insert into invoices(company_id, client_id, status, currency, tax_rate, subtotal, tax_amount, total) values ($1,$2,'draft',$3,$4,$5,$6,$7) returning id`,
  [company, client, currency, rate, total - tax, tax, total]))[0].id
const eur = await draft(c1, 'EUR', 1190, 190, 19)
const usd = await draft(c2, 'USD', 1000, 0, 0)
await db.exec('alter table invoices enable trigger invoices_fx_snapshot_u')
await db.exec('alter table invoices enable trigger invoices_gl_issue_u')
const issue = (id, code, date) => asSuper(admin, () => db.query(`update invoices set status='issued', code=$2, issue_date=$3, due_date=$3 where id=$1`, [id, code, date]))

await issue(eur, 'FAC-GL-1', d(0))
const e1 = (await q(`select e.id, e.number, e.status, e.source_type from gl_entries e where e.source_id=$1`, [eur]))[0]
ok('facture émise : écriture VT générée et validée', e1 && e1.status === 'posted' && e1.number.startsWith('VT-') && e1.source_type === 'invoice')
const l1 = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id=l.account_id where l.entry_id=$1 order by a.code`, [e1.id])
const get = (code) => l1.find((x) => x.code === code)
ok('facture 1 190 TTC : 411 débit 1 190', get('411') && num(get('411').debit) === 1190 && num(get('411').credit) === 0)
ok('facture : 701 crédit 1 000 HT, 445 crédit 190 TVA', num(get('701').credit) === 1000 && num(get('445').credit) === 190)
ok('écriture équilibrée (débit = crédit)', Math.abs(l1.reduce((s, x) => s + num(x.debit), 0) - l1.reduce((s, x) => s + num(x.credit), 0)) < 0.001)
ok('numéro d’écriture au format VT-AAAA-000001', /^VT-\d{4}-000001$/.test(e1.number))

// --- 3. Facture fournisseur : 607 / 401 ------------------------------------------------------------------------------------
const sf = await as(fin, () => rpc('supplier_invoice_record', s1, 'TF-GL-1', d(0), d(30), 500, 'EUR', null))
const ea = (await q(`select e.status, e.source_type from gl_entries e where e.source_id=$1`, [sf]))[0]
ok('facture fournisseur : écriture AC validée', ea && ea.status === 'posted' && ea.source_type === 'supplier_invoice')
const al = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id=l.account_id join gl_entries e on e.id=l.entry_id where e.source_id=$1 order by a.code`, [sf])
ok('facture fournisseur 500 : 401 crédit 500, 607 débit 500', al.find((x) => x.code === '607') && num(al.find((x) => x.code === '607').debit) === 500 && num(al.find((x) => x.code === '401').credit) === 500)

// --- 4. Encaissement client : 521 / 411 -----------------------------------------------------------------------------------
await as(fin, () => rpc('invoice_record_payment', eur, 400, d(0), 'transfer', 'VIR-GL-1'))
const ep = (await q(`select e.number, e.status from gl_entries e where e.source_type='invoice_payment' order by e.created_at desc limit 1`))[0]
ok('encaissement client : écriture BQ validée', ep && ep.status === 'posted' && ep.number.startsWith('BQ-'))
const lp = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id=l.account_id join gl_entries e on e.id=l.entry_id where e.source_type='invoice_payment' order by a.code`)
ok('encaissement 400 : 521 débit 400, 411 crédit 400', lp.find((x) => x.code === '521') && num(lp.find((x) => x.code === '521').debit) === 400 && num(lp.find((x) => x.code === '411').credit) === 400)

// --- 5. Écart de change sur encaissement USD : taux figé 0,90, taux du règlement 0,93 -----------------------------------
await as(fin, () => rpc('fx_rate_set', d(-30), 'USD', 0.9))
await as(fin, () => rpc('fx_rate_set', d(0), 'USD', 0.93))
await issue(usd, 'FAC-GL-USD', d(-30))
const fxBefore = (await q(`select fx_rate from invoices where id=$1`, [usd]))[0]
ok('facture USD : taux figé au jour d’émission (0,90)', num(fxBefore.fx_rate) === 0.9)
await as(fin, () => rpc('invoice_record_payment', usd, 400, d(0), 'transfer', 'VIR-GL-USD'))
const fxLines = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id=l.account_id join gl_entries e on e.id=l.entry_id where e.source_type='invoice_payment' and e.source_id = (select id from invoice_payments where invoice_id=$1 limit 1) order by a.code`, [usd])
const g = fxLines.find((x) => x.code === '766')
ok('encaissement USD 400 : 521 = 372 (taux du jour), 411 = 360 (taux figé)', fxLines.find((x) => x.code === '521') && num(fxLines.find((x) => x.code === '521').debit) === 372 && num(fxLines.find((x) => x.code === '411').credit) === 360)
ok('écart de change : gain 12 en 766', g && num(g.credit) === 12)

// --- 6. Règlement fournisseur affecté : 401 / 521 --------------------------------------------------------------------------
await as(fin, () => rpc('supplier_payment_record', s1, 200, d(0), 'transfer', 'VIR-SU-1'))
const sp = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id=l.account_id join gl_entries e on e.id=l.entry_id where e.source_type='supplier_allocation' order by a.code`)
ok('règlement fournisseur 200 : 401 débit 200, 521 crédit 200', sp.find((x) => x.code === '401') && num(sp.find((x) => x.code === '401').debit) === 200 && num(sp.find((x) => x.code === '521').credit) === 200)

// --- 7. Avoir émis : contrepassation 701 / 445 / 411 ----------------------------------------------------------------------
await asSuper(admin, async () => {
  await db.exec('alter table credit_notes disable trigger user')
  await db.exec('alter table credit_notes enable trigger credit_notes_gl_u')
})
const cn = (await q(`insert into credit_notes(company_id, invoice_id, client_id, status, reason, currency, tax_rate, subtotal, tax_amount, total) values ($1,$2,$3,'draft','Erreur de quantité',$4,19,100,19,119) returning id`, [company, eur, c1, 'EUR']))[0].id
await asSuper(admin, () => db.query(`update credit_notes set status='issued', code='AV-GL-1', issue_date=$2 where id=$1`, [cn, d(0)]))
const ec = (await q(`select e.number from gl_entries e where e.source_type='credit_note' and e.source_id=$1`, [cn]))[0]
ok('avoir émis : écriture VT de contrepassation', ec && ec.number.startsWith('VT-'))
const lc = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id=l.account_id join gl_entries e on e.id=l.entry_id where e.source_type='credit_note' and e.source_id=$1 order by a.code`, [cn])
ok('avoir 119 TTC : 701 débit 100, 445 débit 19, 411 crédit 119', lc.find((x) => x.code === '701') && num(lc.find((x) => x.code === '701').debit) === 100 && num(lc.find((x) => x.code === '445').debit) === 19 && num(lc.find((x) => x.code === '411').credit) === 119)

// --- 8. Balance et grand livre -----------------------------------------------------------------------------------------------
const tb = await as(fin, () => q(`select account_code, total_debit, total_credit, balance from gl_trial_balance($1, $2)`, [d(-60), d(60)]))
const totD = tb.reduce((s, r) => s + num(r.total_debit), 0)
const totC = tb.reduce((s, r) => s + num(r.total_credit), 0)
ok('balance : total débit = total crédit', Math.abs(totD - totC) < 0.001 && totD > 0)
const t411 = tb.find((r) => r.account_code === '411')
ok('balance : 411 = factures EUR 1 190 + USD 900 − encaissements 400 − 360 − avoir 119 = 1 211', t411 && Math.abs(num(t411.balance) - 1211) < 0.001)
const ledger = await as(fin, () => q(`select number, debit, credit, running_balance from gl_ledger('411', $1, $2)`, [d(-60), d(60)]))
ok('grand livre 411 : solde progressif cohérent avec la dernière ligne', ledger.length > 0 && Math.abs(num(ledger[ledger.length - 1].running_balance) - num(t411.balance)) < 0.001)

// --- 9. Immutabilité et garde-fous -----------------------------------------------------------------------------------------
await rejects('écriture validée : modification refusée', () => db.exec(`update gl_entry_lines set debit = 1 where entry_id = '${e1.id}'`), 'GL_IMMUTABLE')
await rejects('écriture validée : suppression refusée', () => db.exec(`delete from gl_entries where id = '${e1.id}'`), 'GL_IMMUTABLE')
await rejects('ligne ajoutée à une écriture validée : refusée', () => db.exec(`insert into gl_entry_lines(company_id, entry_id, pos, account_id, debit, credit) select company_id, id, 9, (select id from gl_accounts where code='411' and company_id=gl_entries.company_id), 1, 0 from gl_entries where id='${e1.id}'`), 'GL_ENTRY_NOT_DRAFT')
await rejects('écriture déséquilibrée : refusée', () => db.query(`select private.gl_post($1, 'OD', current_date, 'Test', null, null, '[{"account":"411","debit":100,"credit":0},{"account":"701","debit":0,"credit":90}]'::jsonb)`, [company]), 'GL_UNBALANCED')
await rejects('compte inconnu : refusé', () => db.query(`select private.gl_post($1, 'OD', current_date, 'Test', null, null, '[{"account":"999","debit":10,"credit":0},{"account":"701","debit":0,"credit":10}]'::jsonb)`, [company]), 'GL_ACCOUNT_MISSING')
const before = (await q(`select count(*)::int n from gl_entries where company_id=$1`, [company]))[0].n
const again = await db.query(`select private.gl_post($1, 'VT', $2, 'Rejeu', 'invoice', $3, '[{"account":"411","debit":5,"credit":0},{"account":"701","debit":0,"credit":5}]'::jsonb) r`, [company, d(0), eur])
ok('rejeu sur un document déjà comptabilisé : même écriture, pas de doublon', (await q(`select count(*)::int n from gl_entries where company_id=$1`, [company]))[0].n === before && again.rows[0].r === e1.id)
ok('isolation : sans rôle, aucune écriture visible', (await as(nobody, () => q(`select count(*)::int n from gl_entries`)))[0].n === 0)
await rejects('état : refusé sans droit finance', () => as(nobody, () => q(`select * from gl_trial_balance($1, $2)`, [d(-60), d(60)])), 'RBAC_FORBIDDEN')

// --- 10. Clôture de période --------------------------------------------------------------------------------------------------
// Une écriture en brouillon bloque la clôture (saisie non finalisée).
await db.query(`insert into gl_entries(company_id, journal_id, period_id, number, entry_date, label, status) select $1, j.id, (select id from gl_periods where company_id=$1 and year=extract(year from current_date)::int and month=extract(month from current_date)::int), 'VT-BRO-1', current_date, 'Brouillon', 'draft' from gl_journals j where j.company_id=$1 and j.code='VT' limit 1`, [company])
await rejects('clôture : refusée tant qu’une écriture est en brouillon', () => as(fin, () => rpc('gl_close_period', new Date().getUTCFullYear(), new Date().getUTCMonth() + 1)), 'GL_DRAFT_ENTRIES')
await db.query(`delete from gl_entries where number='VT-BRO-1'`)
ok('brouillon supprimé : plus aucune écriture VT-BRO-1', (await q(`select count(*)::int n from gl_entries where number='VT-BRO-1'`))[0].n === 0)
await as(fin, () => rpc('gl_close_period', new Date().getUTCFullYear(), new Date().getUTCMonth() + 1))
ok('clôture du mois en cours : période fermée', (await q(`select status from gl_periods where company_id=$1 and year=$2 and month=$3`, [company, new Date().getUTCFullYear(), new Date().getUTCMonth() + 1]))[0].status === 'closed')
await db.exec('alter table invoices disable trigger user')
const late = (await q(`insert into invoices(company_id, client_id, status, currency, tax_rate, subtotal, tax_amount, total) values ($1,$2,'draft','EUR',0,100,0,100) returning id`, [company, c1]))[0].id
await db.exec('alter table invoices enable trigger invoices_gl_issue_u')
await rejects('période clôturée : nouvelle facture refusée', () => issue(late, 'FAC-GL-LATE', d(0)), 'GL_PERIOD_CLOSED')

console.log(process.exitCode ? '\nÉCHEC' : '\nOK')
