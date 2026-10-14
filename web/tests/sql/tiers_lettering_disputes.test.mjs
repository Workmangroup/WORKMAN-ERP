// Clients et fournisseurs : lettrage partiel, litiges, échéances, soldes exacts, groupe de tiers sans mélange — P061 / migration 0086
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const num = Number
const lines = (...l) => JSON.stringify(l)
const AS_OF = '2026-03-20'

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p061.com', 'finance')
const fin2 = await mkUser('fin2@p061.com', 'finance')
const nobody = await mkUser('nobody@p061.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const C1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P61-1','Client P61 un','TN') returning id`, [company]))[0].id
const C2 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P61-2','Client P61 deux','TN') returning id`, [company]))[0].id
const C3 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P61-3','Client P61 trois','TN') returning id`, [company]))[0].id
const S1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P61-1','Fournisseur P61 un','TN') returning id`, [company]))[0].id
const S2 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P61-2','Fournisseur P61 deux','TN') returning id`, [company]))[0].id

// --- Fixtures : pièces émises (triggers de facturation désactivés), taux USD = fixture de test, crédit appliqué = fixture ----------
await db.exec('alter table invoices disable trigger user')
const inv = async (code, client, cur, subtotal, tax, due, issue, fx, credited = 0) => (await q(
  `insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate, credited_amount)
   values ($1,$2,'issued',$3,$4,$5,$6,$7,$8,$9,$8::numeric+$9::numeric,$10,$11) returning id`,
  [company, client, code, issue, due, cur, tax === 0 ? 0 : 19, subtotal, tax, fx, credited]))[0].id
const I1 = await inv('FAC-P61-1', C1, 'EUR', 1000, 190, '2026-05-10', '2026-03-10', null)
const I2 = await inv('FAC-P61-2', C1, 'EUR', 300, 57, '2026-03-01', '2026-02-20', null, 57)
const I3 = await inv('FAC-P61-3', C1, 'USD', 1000, 0, '2026-05-10', '2026-03-10', 0.9)
const I6 = await inv('FAC-P61-6', C1, 'EUR', 200, 0, '2026-01-15', '2026-01-01', null)
const I4 = await inv('FAC-P61-4', C2, 'EUR', 500, 0, '2026-05-10', '2026-03-10', null)
await db.exec('alter table invoices enable trigger user')
const invRow = async (id) => (await q(`select status, paid_amount, credited_amount, total from invoices where id=$1`, [id]))[0]
const bal = async (id) => { const r = await invRow(id); return num(r.total) - num(r.paid_amount) - num(r.credited_amount) }

const stC1 = await as(fin, () => rpc('client_statement', C1, AS_OF))
const eur0 = stC1.currencies.find((c) => c.currency === 'EUR')
const usd0 = stC1.currencies.find((c) => c.currency === 'USD')
ok('solde initial EUR exact : 1 190 + 300 (après avoir de 57) + 200 = 1 690', num(eur0.balance) === 1690)
ok('solde initial USD exact : 1 000, équivalent figé 900 (taux de la pièce)', num(usd0.balance) === 1000 && num(usd0.balance_base) === 900)
ok('solde en devise de base : 1 690 + 900 = 2 590 (sans mélange de devises)', num(eur0.balance_base) + num(usd0.balance_base) === 2590)
ok('échéancier : facture de janvier en retard 61-90 jours (200)', num(eur0.overdue_61_90) === 200)

// --- Paiement partiel : une pièce, montant inférieur au solde -------------------------------------------------------------------
const L1 = await as(fin, () => rpc('client_lettering_apply', C1, 500, '2026-03-15', 'transfer', 'VIR-P61-1', lines({ invoice_id: I1, amount: 500 })))
ok('lettrage partiel : code LET-000001 attribué', L1 === 'LET-000001')
ok('paiement partiel : solde de la pièce 1 190 → 690, statut partiellement réglé', (await bal(I1)) === 690 && (await invRow(I1)).status === 'partially_paid')
ok('paiement partiel : une ligne de paiement client créée et liée', (await q(`select count(*)::int n from tier_lettering_lines l join invoice_payments p on p.id = l.client_payment_id where l.invoice_id=$1`, [I1]))[0].n === 1)

// --- Règlement réparti sur deux pièces (somme exacte) ------------------------------------------------------------------------------
const L2 = await as(fin, () => rpc('client_lettering_apply', C1, 500, '2026-03-16', 'cheque', 'CHQ-P61-2',
  lines({ invoice_id: I1, amount: 200 }, { invoice_id: I2, amount: 300 })))
ok('règlement réparti : LET-000002', L2 === 'LET-000002')
ok('règlement réparti : pièce 1 à 490, pièce 2 soldée', (await bal(I1)) === 490 && (await bal(I2)) === 0 && (await invRow(I2)).status === 'paid')

// --- Refus : atomicité (aucune pièce ni paiement modifié) --------------------------------------------------------------------------
const before = { pay: (await q(`select count(*)::int n from invoice_payments`))[0].n, let: (await q(`select count(*)::int n from tier_letterings`))[0].n, b1: await bal(I1) }
await rejects('lettrage : somme des affectations différente du règlement refusée', () => as(fin, () => rpc('client_lettering_apply', C1, 700, '2026-03-17', 'transfer', null, lines({ invoice_id: I1, amount: 100 }))), 'LETTERING_UNBALANCED')
await rejects('lettrage : affectation au-delà du solde refusée', () => as(fin, () => rpc('client_lettering_apply', C1, 600, '2026-03-17', 'transfer', null, lines({ invoice_id: I1, amount: 600 }))), 'LETTERING_OVERPAYMENT')
await rejects('lettrage : devises mélangées refusées', () => as(fin, () => rpc('client_lettering_apply', C1, 1000, '2026-03-17', 'transfer', null, lines({ invoice_id: I1, amount: 200 }, { invoice_id: I3, amount: 300 }))), 'LETTERING_CURRENCY_MISMATCH')
await rejects('lettrage : pièce d’un autre client refusée (groupe sans mélange)', () => as(fin, () => rpc('client_lettering_apply', C1, 100, '2026-03-17', 'transfer', null, lines({ invoice_id: I4, amount: 100 }))), 'LETTERING_TIER_MISMATCH')
await rejects('lettrage : même pièce deux fois refusé', () => as(fin, () => rpc('client_lettering_apply', C1, 200, '2026-03-17', 'transfer', null, lines({ invoice_id: I1, amount: 100 }, { invoice_id: I1, amount: 100 }))), 'LETTERING_DUPLICATE_LINE')
await rejects('lettrage : sans affectation refusé', () => as(fin, () => rpc('client_lettering_apply', C1, 100, '2026-03-17', 'transfer', null, lines())), 'LETTERING_EMPTY')
await rejects('lettrage : sans droit paiement refusé', () => as(nobody, () => rpc('client_lettering_apply', C1, 100, '2026-03-17', 'transfer', null, lines({ invoice_id: I1, amount: 100 }))), 'RBAC_FORBIDDEN')
ok('refus : aucun paiement ni lettre créé, solde inchangé',
  (await q(`select count(*)::int n from invoice_payments`))[0].n === before.pay && (await q(`select count(*)::int n from tier_letterings`))[0].n === before.let && (await bal(I1)) === before.b1)

// --- Lettrage immuable ------------------------------------------------------------------------------------------------------------
await rejects('lettrage : modification refusée', () => db.exec(`update tier_letterings set amount = 1 where code='LET-000001'`), 'LETTERING_IMMUTABLE')
await rejects('lettrage : suppression de ligne refusée', () => db.exec(`delete from tier_lettering_lines`), 'LETTERING_IMMUTABLE')

// --- Devise étrangère : montant d'origine et équivalent figé ------------------------------------------------------------------------
await as(fin, () => rpc('fx_rate_set', '2026-03-18', 'USD', 0.9))
await as(fin, () => rpc('client_lettering_apply', C1, 400, '2026-03-18', 'transfer', 'VIR-USD-P61', lines({ invoice_id: I3, amount: 400 })))
const line = (await q(`select l.amount, l.fx_rate, l.amount_base from tier_lettering_lines l join tier_letterings t on t.id=l.lettering_id where t.code='LET-000003'`))[0]
ok('devise : règlement de 400 USD conservé en devise d’origine, équivalent 360 au taux figé', line && num(line.amount) === 400 && num(line.amount_base) === 360)

// --- Solde après lettrage, litige et échéances --------------------------------------------------------------------------------------
await as(fin, () => rpc('client_dispute_open', I1, 100, 'Qualité contestée sur un lot'))
await rejects('litige : second litige ouvert sur la même pièce refusé', () => as(fin, () => rpc('client_dispute_open', I1, 50, 'Autre motif de contestation')), 'DISPUTE_ALREADY_OPEN')
await rejects('litige : montant au-delà du solde refusé', () => as(fin, () => rpc('client_dispute_open', I6, 999, 'Montant supérieur au solde')), 'DISPUTE_BAD_AMOUNT')
const stDisp = await as(fin, () => rpc('client_statement', C1, AS_OF))
const eurD = stDisp.currencies.find((c) => c.currency === 'EUR')
ok('litige : solde inchangé (690 EUR), montant contesté 100 séparé', num(eurD.balance) === 690 && num(eurD.disputed) === 100)
ok('échéancier : exigible = solde − litige (non échu 390)', num(eurD.not_due) === 390)
ok('échéancier : 200 en retard 61-90 jours, indépendant du litige', num(eurD.overdue_61_90) === 200)
ok('devise USD : solde 600, équivalent 540, non échu 600', (() => { const u = stDisp.currencies.find((c) => c.currency === 'USD'); return num(u.balance) === 600 && num(u.balance_base) === 540 && num(u.not_due) === 600 })())
ok('solde total en devise de base : 690 + 540 = 1 230', num(eurD.balance_base) + num(stDisp.currencies.find((c) => c.currency === 'USD').balance_base) === 1230)
const item1 = stDisp.items.find((x) => x.code === 'FAC-P61-1')
ok('pièce : lettres rattachées (LET-000001, LET-000002)', item1 && item1.letters.join(',') === 'LET-000001,LET-000002')
ok('pièce : litige visible sur la pièce', item1.disputed === 100)

const DSP1 = (await q(`select id from client_invoice_disputes where invoice_id=$1`, [I1]))[0].id
await rejects('résolution par l’ouvreur refusée', () => as(fin, () => rpc('client_dispute_resolve', DSP1, 'Résolu par le même agent')), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('client_dispute_resolve', DSP1, 'Lot re-contrôlé, avoir non nécessaire'))
const stRes = await as(fin, () => rpc('client_statement', C1, AS_OF))
ok('litige résolu : exigible 490, litige 0', num(stRes.currencies.find((c) => c.currency === 'EUR').not_due) === 490 && num(stRes.currencies.find((c) => c.currency === 'EUR').disputed) === 0)
await rejects('litige résolu : modification refusée', () => db.exec(`update client_invoice_disputes set amount = 1 where invoice_id='${I1}'`), 'DISPUTE_BAD_STATUS')
await rejects('litige : sans droit refusé', () => as(nobody, () => rpc('client_dispute_open', I1, 10, 'Tentative sans droit')), 'RBAC_FORBIDDEN')

// --- Fournisseurs : lettrage partiel et litige ----------------------------------------------------------------------------------------
const SI1 = (await q(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
  values ($1,'FS-P61-1',$2,'FS-P61-1','2026-03-05','2026-04-05','EUR',345) returning id`, [company, S1]))[0].id
const SI2 = (await q(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
  values ($1,'FS-P61-2',$2,'FS-P61-2','2026-02-06','2026-03-06','EUR',500) returning id`, [company, S1]))[0].id
await as(fin, () => rpc('fx_rate_set', '2026-03-07', 'USD', 0.9))
const SI3 = (await q(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total, fx_rate)
  values ($1,'FS-P61-3',$2,'FS-P61-3','2026-03-07','2026-05-01','USD',100,0.9) returning id`, [company, S1]))[0].id
const SI4 = (await q(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
  values ($1,'FS-P61-4',$2,'FS-P61-4','2026-03-07','2026-05-01','EUR',80) returning id`, [company, S2]))[0].id
const sBal = async (id) => num((await q(`select total - paid_amount b from supplier_invoices where id=$1`, [id]))[0].b)

const LS1 = await as(fin, () => rpc('supplier_lettering_apply', S1, 300, '2026-03-15', 'transfer', 'VIR-FRN-P61',
  lines({ supplier_invoice_id: SI1, amount: 200 }, { supplier_invoice_id: SI2, amount: 100 })))
ok('fournisseur : règlement réparti 200 + 100 (LET-000004)', LS1 === 'LET-000004')
ok('fournisseur : soldes 145 et 400, statuts partiellement réglés', (await sBal(SI1)) === 145 && (await sBal(SI2)) === 400)
const stS1 = await as(fin, () => rpc('supplier_statement', S1, AS_OF))
const sEur = stS1.currencies.find((c) => c.currency === 'EUR')
ok('fournisseur : solde exact 145 + 400 = 545 ; échu 1-30 jours 400, non échu 145', num(sEur.balance) === 545 && num(sEur.overdue_1_30) === 400 && num(sEur.not_due) === 145)
await rejects('fournisseur : affectation au-delà du solde refusée', () => as(fin, () => rpc('supplier_lettering_apply', S1, 150, '2026-03-15', 'transfer', null, lines({ supplier_invoice_id: SI1, amount: 150 }))), 'LETTERING_OVERPAYMENT')
await rejects('fournisseur : pièce d’un autre fournisseur refusée', () => as(fin, () => rpc('supplier_lettering_apply', S1, 80, '2026-03-15', 'transfer', null, lines({ supplier_invoice_id: SI4, amount: 80 }))), 'LETTERING_TIER_MISMATCH')
await as(fin, () => rpc('supplier_invoice_dispute', SI2, 'Quantité livrée contestée'))
const stS2 = await as(fin, () => rpc('supplier_statement', S1, AS_OF))
const sEur2 = stS2.currencies.find((c) => c.currency === 'EUR')
ok('fournisseur litigieux : montant contesté 400 séparé, échu retiré de l’exigible', num(sEur2.disputed) === 400 && num(sEur2.overdue_1_30) === 0 && num(sEur2.balance) === 545)
await rejects('fournisseur litigieux : affectation refusée', () => as(fin, () => rpc('supplier_lettering_apply', S1, 100, '2026-03-15', 'transfer', null, lines({ supplier_invoice_id: SI2, amount: 100 }))), 'LETTERING_BAD_STATUS')

// --- Groupe de tiers : un même tiers (party) pour un client et un fournisseur de la société ---------------------------------
const P = (await q(`select party_id from suppliers where id=$1`, [S1]))[0].party_id
await db.query(`update clients set party_id = $1 where id = $2`, [P, C1])
const pb = await as(fin, () => rpc('party_balance', P))
ok('groupe : une fiche client et une fiche fournisseur comptées', pb.clients === 1 && pb.suppliers === 1)
const recv = pb.receivables.find((x) => x.currency === 'EUR')
const pay = pb.payables.find((x) => x.currency === 'EUR')
ok('groupe : créances client 690 et dettes fournisseur 545 restent séparées (pas de compensation)', num(recv.balance) === 690 && num(pay.balance) === 545)
ok('groupe : devise USD séparée des EUR (créance 600 USD, dette 100 USD)', num(pb.receivables.find((x) => x.currency === 'USD').balance) === 600 && num(pb.payables.find((x) => x.currency === 'USD').balance) === 100)

// Autre société partageant le même tiers : ses encours ne doivent pas apparaître
const co2 = (await q(`insert into companies(name) values ('Autre société P61') returning id`))[0].id
await db.exec('alter table invoices disable trigger user')
const cx = (await q(`insert into clients(company_id, code, name, country, party_id) values ($1,'CL-OTHER','Autre client',$2,$3) returning id`, [co2, 'TN', P]))[0].id
await db.query(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total)
                values ($1,$2,'issued','FAC-OTHER-1','2026-03-10','2026-05-10','EUR',0,9999,0,9999)`, [co2, cx])
await db.exec('alter table invoices enable trigger user')
const pb2 = await as(fin, () => rpc('party_balance', P))
ok('société séparée : les encours d’une autre société ne sont pas mélangés', num(pb2.receivables.find((x) => x.currency === 'EUR').balance) === 690 && pb2.clients === 1)

// --- Pièce en devise sans taux figé : refus explicite -----------------------------------------------------------------------------
await db.exec('alter table invoices disable trigger user')
await db.query(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate)
                values ($1,$2,'issued','FAC-P61-NOFX',$3,$3,'USD',0,100,0,100,null)`, [company, C3, '2026-03-10'])
await db.exec('alter table invoices enable trigger user')
await rejects('devise sans taux figé : état du tiers refusé', () => as(fin, () => rpc('client_statement', C3, AS_OF)), 'LETTERING_FX_MISSING')
const INV_NOFX = (await q(`select id from invoices where code='FAC-P61-NOFX'`))[0].id
await rejects('devise sans taux figé : lettrage refusé', () => as(fin, () => rpc('client_lettering_apply', C3, 10, '2026-03-17', 'transfer', null, lines({ invoice_id: INV_NOFX, amount: 10 }))), 'LETTERING_FX_MISSING')

// --- Droits, lecture et audit ------------------------------------------------------------------------------------------------------
await rejects('état du tiers sans droit : refusé', () => as(nobody, () => rpc('client_statement', C1, AS_OF)), 'RBAC_FORBIDDEN')
ok('lecture des lettres sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from tier_letterings`)))[0].n === 0)
const actions = (await q(`select string_agg(distinct action, ',' order by action) s from audit_logs where action like 'tier.%'`))[0].s
ok('audit : lettrage, litige et résolution tracés', ['tier.lettering_apply', 'tier.dispute_open', 'tier.dispute_resolve'].every((a) => actions.includes(a)))
