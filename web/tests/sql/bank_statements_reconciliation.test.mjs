// Banques : relevés idempotents, rapprochements, exceptions, coordonnées fournisseur, lot de transmission à double contrôle — P062 / migration 0087
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const num = Number

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p062.com', 'finance')      // prépare, saisit, rapproche
const fin2 = await mkUser('fin2@p062.com', 'finance')    // transmet, accuse réception, exécute, valide
const dir = await mkUser('dir@p062.com', 'direction')    // approuve les ordres de paiement
const nobody = await mkUser('nobody@p062.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const C1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P62-1','Client P62','TN') returning id`, [company]))[0].id
const S1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P62-1','Fournisseur P62','TN') returning id`, [company]))[0].id
const S2 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P62-2','Fournisseur P62 bis','TN') returning id`, [company]))[0].id

// --- Comptes bancaires -------------------------------------------------------------------------------------------------------------
await rejects('compte : sans droit bank.manage refusé', () => as(nobody, () => rpc('bank_account_create', 'Compte X', 'Banque', 'EUR', '0001')), 'RBAC_FORBIDDEN')
const A = await as(fin, () => rpc('bank_account_create', 'Compte principal P62', 'Banque test', 'EUR', '1234'))
const AUSD = await as(fin, () => rpc('bank_account_create', 'Compte devise P62', 'Banque test', 'USD', '5678'))
ok('compte : seuls les 4 derniers caractères du numéro sont stockés', (await q(`select account_last4 from bank_accounts where id=$1`, [A]))[0].account_last4 === '1234')
await rejects('compte : doublon de nom refusé', () => as(fin, () => rpc('bank_account_create', 'Compte principal P62', 'Autre', 'EUR', '9999')), 'duplicate key')

// --- Fixtures de pièces : client payé 300 (encaissement réel), fournisseur 345 et 100 -----------------------------------------------
await db.exec('alter table invoices disable trigger user')
const I1 = (await q(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate)
  values ($1,$2,'issued','FAC-P62-1','2026-03-10','2026-05-10','EUR',0,500,0,500,1) returning id`, [company, C1]))[0].id
await db.exec('alter table invoices enable trigger user')
await as(fin, () => rpc('invoice_record_payment', I1, 300, '2026-03-15', 'transfer', 'VIR-CL-P62'))
const CP = (await q(`select id from invoice_payments where invoice_id=$1`, [I1]))[0].id
await db.exec('alter table supplier_invoices disable trigger user')
await q(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
  values ($1,'FS-P62-1',$2,'FS-P62-1','2026-03-05','2026-04-05','EUR',345)`, [company, S1])
await q(`insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
  values ($1,'FS-P62-2',$2,'FS-P62-2','2026-03-06','2026-04-06','EUR',100)`, [company, S2])
await db.exec('alter table supplier_invoices enable trigger user')

// --- Coordonnées bancaires fournisseur : saisie, validation distincte, aucune coordonnée complète stockée --------------------------
const IBAN = 'TN59 1000 6035 1835 9847 8831'
await rejects('coordonnées : IBAN invalide refusé', () => as(fin, () => rpc('supplier_bank_detail_set', S1, 'Banque', 'pas un iban')), 'BANK_IBAN_INVALID')
const D1 = await as(fin, () => rpc('supplier_bank_detail_set', S1, 'Banque fournisseur test', IBAN))
const row = (await q(`select * from supplier_bank_details where id=$1`, [D1]))[0]
ok('coordonnées : statut à valider, 4 derniers caractères seulement', row.status === 'a_valider' && row.iban_last4 === '8831')
ok('coordonnées : l’IBAN complet n’apparaît dans aucune colonne', !JSON.stringify(row).includes('TN5910006035183598478831'))
await rejects('coordonnées : validation par son auteur refusée', () => as(fin, () => rpc('supplier_bank_detail_validate', D1, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('supplier_bank_detail_validate', D1, true))
ok('coordonnées : validées par une autre personne', (await q(`select status from supplier_bank_details where id=$1`, [D1]))[0].status === 'valide')
const D2 = await as(fin, () => rpc('supplier_bank_detail_set', S2, 'Banque fournisseur bis', 'TN59 1000 6035 1835 9847 8831'))
ok('coordonnées du fournisseur 2 : en attente, donc non transmissibles', (await q(`select status from supplier_bank_details where id=$1`, [D2]))[0].status === 'a_valider')

// --- Ordres de paiement : préparés par fin, approuvés par dir (chaîne existante inchangée) -------------------------------------------
const O1 = await as(fin, () => rpc('payment_order_prepare', S1, 200, 'Règlement fournisseur P62'))
await as(dir, () => rpc('payment_order_decide', O1.id, true, 'OK'))
const O2 = await as(fin, () => rpc('payment_order_prepare', S1, 50, 'Ordre non approuvé P62'))
const O3 = await as(fin, () => rpc('payment_order_prepare', S2, 40, 'Fournisseur sans coordonnées validées'))
await as(dir, () => rpc('payment_order_decide', O3.id, true, 'OK'))

// --- Relevé idempotent : import, doublons et contrôles refusés ----------------------------------------------------------------------
const L = (date, amount, label, ref) => ({ value_date: date, amount, label, bank_ref: ref })
const linesMar = [
  L('2026-03-15', 300, 'VIR CLIENT FAC-P62-1', 'R1'),
  L('2026-03-20', -200, 'VIR FOURNISSEUR ' + O1.number, 'R2'),
  L('2026-03-21', -12.5, 'FRAIS BANCAIRES', 'F1'),
]
const ST1 = await as(fin, () => rpc('bank_statement_import', A, 'REL-P62-1', '2026-03-01', '2026-03-31', 1000, 1087.5, linesMar))
ok('relevé : importé, 3 lignes, solde de clôture contrôlé (1 000 + 300 − 200 − 12,5 = 1 087,5)',
  (await q(`select line_count from bank_statements where id=$1`, [ST1]))[0].line_count === 3)
await rejects('relevé doublon : même référence refusé', () => as(fin, () => rpc('bank_statement_import', A, 'REL-P62-1', '2026-03-01', '2026-03-31', 1000, 1087.5, linesMar)), 'BANK_STATEMENT_DUPLICATE')
await rejects('relevé doublon : même contenu sous une autre référence refusé', () => as(fin, () => rpc('bank_statement_import', A, 'REL-P62-COPIE', '2026-03-01', '2026-03-31', 1000, 1087.5, linesMar)), 'BANK_STATEMENT_DUPLICATE')
await rejects('relevé chevauchant : ligne déjà importée refusée', () => as(fin, () => rpc('bank_statement_import', A, 'REL-P62-2', '2026-03-16', '2026-03-31', 1087.5, 1074,
  [L('2026-03-21', -12.5, 'FRAIS BANCAIRES', 'F1'), L('2026-03-22', -1, 'AUTRE', 'G1')])), 'BANK_LINE_DUPLICATE')
await rejects('relevé : solde de clôture faux refusé', () => as(fin, () => rpc('bank_statement_import', A, 'REL-P62-3', '2026-04-01', '2026-04-30', 1087.5, 1000, [L('2026-04-02', -1, 'AUTRE', 'G2')])), 'BANK_BALANCE_MISMATCH')
await rejects('relevé : ligne hors période refusée', () => as(fin, () => rpc('bank_statement_import', A, 'REL-P62-4', '2026-03-01', '2026-03-31', 1000, 999, [L('2026-04-01', -1, 'HORS', 'H1')])), 'BANK_LINE_OUT_OF_PERIOD')
await rejects('relevé : compte en devise étrangère refusé', () => as(fin, () => rpc('bank_statement_import', AUSD, 'REL-USD-1', '2026-03-01', '2026-03-31', 0, -1, [L('2026-03-02', -1, 'USD', 'U1')])), 'BANK_CURRENCY_MISMATCH')
await rejects('relevé : sans droit refusé', () => as(nobody, () => rpc('bank_statement_import', A, 'REL-P62-9', '2026-03-01', '2026-03-31', 1000, 1087.5, linesMar)), 'RBAC_FORBIDDEN')
ok('après refus : un seul relevé, trois lignes, aucune ligne partielle',
  (await q(`select count(*)::int n from bank_statements where bank_account_id=$1`, [A]))[0].n === 1 &&
  (await q(`select count(*)::int n from bank_lines where bank_account_id=$1`, [A]))[0].n === 3)
ok('lecture des lignes sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from bank_lines`)))[0].n === 0)

// --- Propositions et rapprochement -------------------------------------------------------------------------------------------------
const sugg1 = await as(fin, () => q(`select * from bank_match_suggest($1)`, [A]))
const cand1 = sugg1.find((x) => x.target_kind === 'client_payment')
ok('proposition : encaissement client proposé pour la ligne de +300 (référence de la facture)', cand1 && cand1.score === 'reference' && num(cand1.amount) === 300)
ok('proposition : aucun règlement fournisseur avant exécution', !sugg1.some((x) => x.target_kind === 'supplier_payment'))
const LINE1 = cand1.line_id
const LINE2 = (await q(`select id from bank_lines where bank_account_id=$1 and amount=-200`, [A]))[0].id
const LINE3 = (await q(`select id from bank_lines where bank_account_id=$1 and amount=-12.5`, [A]))[0].id
await rejects('rapprochement : montant différent refusé', () => as(fin, () => rpc('bank_match_confirm', LINE2, 'client_payment', CP)), 'BANK_TARGET_MISMATCH')
await rejects('rapprochement : type inconnu refusé', () => as(fin, () => rpc('bank_match_confirm', LINE1, 'autre', CP)), 'BANK_BAD_KIND')
const M1 = await as(fin, () => rpc('bank_match_confirm', LINE1, 'client_payment', CP))
ok('rapprochement : ligne +300 ↔ encaissement, ligne rapprochée', M1 && (await q(`select status from bank_lines where id=$1`, [LINE1]))[0].status === 'matched')
await rejects('rapprochement : ligne déjà rapprochée refusée', () => as(fin, () => rpc('bank_match_confirm', LINE1, 'client_payment', CP)), 'BANK_BAD_STATUS')

// --- Exceptions : motif obligatoire, clôture par une autre personne -------------------------------------------------------------------
await rejects('exception : motif trop court refusé', () => as(fin, () => rpc('bank_exception_raise', LINE3, 'other', 'x')), 'BANK_REASON_REQUIRED')
const EX1 = await as(fin, () => rpc('bank_exception_raise', LINE3, 'no_match', 'Frais bancaires à imputer, pas de pièce'))
ok('exception : ligne en exception', (await q(`select status from bank_lines where id=$1`, [LINE3]))[0].status === 'excepted')
await rejects('exception : seconde exception sur la même ligne refusée', () => as(fin, () => rpc('bank_exception_raise', LINE3, 'other', 'Autre motif de test')), 'BANK_BAD_STATUS')
await rejects('exception : clôture par celui qui l’a ouverte refusée', () => as(fin, () => rpc('bank_exception_close', EX1, 'Clôture par le même agent')), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('bank_exception_close', EX1, 'Frais bancaires confirmés, aucune pièce'))
ok('exception clôturée par une autre personne : ligne close, décision documentée',
  (await q(`select status from bank_lines where id=$1`, [LINE3]))[0].status === 'closed' &&
  (await q(`select resolved_by is not null r from bank_exceptions where id=$1`, [EX1]))[0].r === true)

await rejects('rapprochement : ligne clôturée refusée', () => as(fin, () => rpc('bank_match_confirm', LINE3, 'client_payment', CP)), 'BANK_BAD_STATUS')

// --- Lot de transmission : préparation, approbation, transmission, accusé, exécution ------------------------------------------------
await rejects('transmission : ordre non approuvé refusé', () => as(fin2, () => rpc('payment_transmission_create', [O2.id])), 'BANK_ORDER_NOT_APPROVED')
await rejects('transmission : fournisseur sans coordonnées validées refusé', () => as(fin2, () => rpc('payment_transmission_create', [O3.id])), 'BANK_DETAIL_NOT_VALIDATED')
await rejects('transmission : par le préparateur refusée', () => as(fin, () => rpc('payment_transmission_create', [O1.id])), 'SOD_SELF_APPROVAL')
await rejects('transmission : par l’approbateur refusée', () => as(dir, () => rpc('payment_transmission_create', [O1.id])), 'RBAC_FORBIDDEN')
const T1 = await as(fin2, () => rpc('payment_transmission_create', [O1.id]))
ok('transmission : lot créé, statut transmis, aucune exécution', (await as(fin, () => rpc('payment_transmission_status', T1))).status === 'transmitted')
await rejects('transmission : ordre déjà transmis refusé', () => as(fin2, () => rpc('payment_transmission_create', [O1.id])), 'BANK_ALREADY_TRANSMITTED')
await rejects('accusé : par le transmetteur refusé', () => as(fin2, () => rpc('payment_transmission_acknowledge', T1, 'ACK-P62-0001')), 'SOD_SELF_APPROVAL')
await rejects('accusé : référence absente refusée', () => as(fin, () => rpc('payment_transmission_acknowledge', T1, 'A')), 'BANK_ACK_REQUIRED')
await as(fin, () => rpc('payment_transmission_acknowledge', T1, 'ACK-P62-0001'))
const st1 = await as(fin, () => rpc('payment_transmission_status', T1))
ok('accepté par la banque, sans exécution : statut accepté, exécutés 0, en attente 1', st1.status === 'accepted' && st1.executed === 0 && st1.pending === 1)
await rejects('accusé : second accusé refusé', () => as(fin, () => rpc('payment_transmission_acknowledge', T1, 'ACK-P62-0002')), 'BANK_BAD_STATUS')
await rejects('accusé : modification directe refusée', () => db.exec(`update payment_transmissions set bank_ack_ref='ACK-P62-0002' where id='${T1}'`), 'BANK_IMMUTABLE')

// Exécution (chaîne existante) par une personne distincte du préparateur ; accepté ≠ exécuté tant que le relevé n'est pas rapproché
await as(fin2, () => rpc('payment_order_execute', O1.id, '2026-03-20'))
const st2 = await as(fin, () => rpc('payment_transmission_status', T1))
ok('ordre exécuté mais non rapproché : toujours non compté comme exécuté', st2.executed === 0 && st2.pending === 1)
const sugg2 = await as(fin, () => q(`select * from bank_match_suggest($1)`, [A]))
const cand2 = sugg2.find((x) => x.target_kind === 'supplier_payment')
ok('proposition : règlement fournisseur exécuté proposé pour la ligne de −200', cand2 && num(cand2.amount) === -200)
await as(fin, () => rpc('bank_match_confirm', LINE2, 'supplier_payment', cand2.target_id))
const st3 = await as(fin, () => rpc('payment_transmission_status', T1))
ok('ordre exécuté et rapproché au relevé : exécuté 1, en attente 0', st3.executed === 1 && st3.pending === 0)
ok('exécution : la ligne de relevé est rapprochée au règlement de l’ordre',
  (await q(`select m.supplier_payment_id = o.supplier_payment_id r from bank_matches m join payment_orders o on o.supplier_payment_id = m.supplier_payment_id where o.id=$1`, [O1.id]))[0].r === true)

// --- Journal d'audit ---------------------------------------------------------------------------------------------------------------
const actions = (await q(`select string_agg(distinct action, ',' order by action) s from audit_logs where action like 'bank.%'`))[0].s
ok('audit : import, rapprochement, exception, coordonnées, transmission et accusé tracés',
  ['bank.account_create', 'bank.statement_import', 'bank.match_confirm', 'bank.exception_raise', 'bank.exception_close', 'bank.supplier_detail_set',
   'bank.supplier_detail_validate', 'bank.transmission_create', 'bank.transmission_acknowledge'].every((a) => actions.includes(a)))
