// TVA retenues et déclarations : jeux fiscaux signés (fixtures de test, non fiscales), règle historique conservée, absence de faux dépôt — P060 / migration 0085
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const num = Number
const lines = (...l) => JSON.stringify(l)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p060.com', 'finance')     // prépare, exporte, dépose
const fin2 = await mkUser('fin2@p060.com', 'finance')   // valide (distinct du préparateur) et signe les fixtures
const nobody = await mkUser('nobody@p060.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const c1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P60-1','Client P60','TN') returning id`, [company]))[0].id
const s1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P60-1','Fournisseur P60','TN') returning id`, [company]))[0].id

// --- 1. Jeux fiscaux signés : taux TVA validés par une autre personne (fixture de test, pas un taux fiscal réel) ----------------------
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) {
  await as(fin2, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
}
ok('taux TVA : tous validés par une autre personne que la création', (await q(`select count(*)::int n from vat_rates where status='a_valider'`))[0].n === 0)

// Retenue : fixture de test, taux arbitraire, libellé explicite ; aucune valeur réelle n'est supposée
await rejects('retenue : saisie sans droit finance refusée', () => as(nobody, () => rpc('withholding_rule_create', 'TEST_RET_A', 'Fixture de test (non fiscale)', 2, '2026-01-01', null)), 'RBAC_FORBIDDEN')
const rA = await as(fin, () => rpc('withholding_rule_create', 'TEST_RET_A', 'Fixture de test (non fiscale)', 2, '2026-01-01', null))
ok('retenue : créée à valider (jamais active sans signature)', (await q(`select status from withholding_rules where id=$1`, [rA]))[0].status === 'a_valider')
await rejects('retenue : validation par son auteur refusée', () => as(fin, () => rpc('withholding_rule_validate', rA, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('withholding_rule_validate', rA, true))
ok('retenue : validée par une autre personne', (await q(`select status, validated_by is not null v from withholding_rules where id=$1`, [rA]))[0].v === true)
await rejects('retenue validée : modification directe refusée', () => db.exec(`update withholding_rules set rate_pct = 9 where id='${rA}'`), 'WITHHOLDING_IMMUTABLE')
await rejects('retenue validée : suppression refusée', () => db.exec(`delete from withholding_rules where id='${rA}'`), 'WITHHOLDING_IMMUTABLE')
const rB = await as(fin, () => rpc('withholding_rule_create', 'TEST_RET_B', 'Fixture non signée', 5, '2026-01-01', null))

// --- 2. Factures et avoirs de mars (et une facture de février hors période) -----------------------------------------------------
await db.exec('alter table invoices disable trigger user')
await db.exec('alter table credit_notes disable trigger user')
await db.exec('alter table supplier_invoices disable trigger user')
const inv = async (code, date, subtotal, tax, rate) => (await q(
  `insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate)
   values ($1,$2,'issued',$3,$4,$4,'EUR',$5,$6,$7,$6::numeric+$7::numeric,1) returning id`, [company, c1, code, date, rate, subtotal, tax]))[0].id
const i1 = await inv('FAC-P60-1', '2026-03-10', 1000, 190, 19)
const i2 = await inv('FAC-P60-2', '2026-03-12', 100, 7, 7)
const iFeb = await inv('FAC-P60-FEV', '2026-02-15', 500, 95, 19)
const cn = (await q(`insert into credit_notes(company_id, invoice_id, client_id, status, code, issue_date, reason, currency, tax_rate, subtotal, tax_amount, total)
  values ($1,$2,$3,'issued','AV-P60-1','2026-03-20','Erreur de quantité','EUR',19,100,19,119) returning id`, [company, i1, c1]))[0].id
await db.exec('alter table invoices enable trigger user')
await db.exec('alter table credit_notes enable trigger user')

// --- 3. TVA déductible : détail par taux saisi sur la facture fournisseur ----------------------------------------------------------
const sup = async (number, date, total, currency = 'EUR') => (await q(
  `insert into supplier_invoices(company_id, number, supplier_id, supplier_ref, invoice_date, due_date, currency, total)
   values ($1,$2,$3,$2,$4,$4,$5,$6) returning id`, [company, number, s1, date, currency, total]))[0].id
const sA = await sup('FS-P60-1', '2026-03-05', 345)
const sB = await sup('FS-P60-2', '2026-03-06', 500)
const sUsd = await sup('FS-P60-USD', '2026-03-07', 100, 'USD')
const sFeb = await sup('FS-P60-FEV', '2026-02-10', 107)
const sMay = await sup('FS-P60-MAI', '2026-05-10', 1000)
await db.exec('alter table supplier_invoices enable trigger user')
await as(fin, () => rpc('supplier_invoice_vat_set', sA, lines({ rate_code: 'TN_STD_19', base: 200 }, { rate_code: 'TN_RED_7', base: 100 })))
ok('TVA déductible : détail saisi, TVA calculée côté serveur',
  (await q(`select string_agg(rate_code || ':' || tax_amount, ',' order by rate_code) s from supplier_invoice_vat_lines where supplier_invoice_id=$1`, [sA]))[0].s === 'TN_RED_7:7.00,TN_STD_19:38.00')
await rejects('TVA déductible : base + TVA ≠ total refusé', () => as(fin, () => rpc('supplier_invoice_vat_set', sB, lines({ rate_code: 'TN_STD_19', base: 200 }))), 'SUPPLIER_VAT_MISMATCH')
await rejects('TVA déductible : taux inconnu refusé', () => as(fin, () => rpc('supplier_invoice_vat_set', sB, lines({ rate_code: 'TN_XX', base: 200 }))), 'VAT_RATE_MISSING')
await rejects('TVA déductible : facture en devise étrangère refusée', () => as(fin, () => rpc('supplier_invoice_vat_set', sUsd, lines({ rate_code: 'TN_STD_19', base: 100 }))), 'VAT_CURRENCY_UNSUPPORTED')
await rejects('TVA déductible : saisie sans droit refusée', () => as(nobody, () => rpc('supplier_invoice_vat_set', sA, lines({ rate_code: 'TN_STD_19', base: 200 }))), 'RBAC_FORBIDDEN')

// --- 4. Retenue enregistrée : règle validée seulement, montant calculé par la règle en vigueur ----------------------------------------
await rejects('retenue : règle non validée refusée', () => as(fin, () => rpc('supplier_withholding_record', sA, 'TEST_RET_B', 200)), 'WITHHOLDING_NOT_VALIDATED')
await rejects('retenue : règle inconnue refusée', () => as(fin, () => rpc('supplier_withholding_record', sA, 'TEST_RET_X', 200)), 'WITHHOLDING_NOT_CONFIGURED')
await rejects('retenue : base au-delà du total refusée', () => as(fin, () => rpc('supplier_withholding_record', sA, 'TEST_RET_A', 999)), 'WITHHOLDING_BAD_AMOUNT')
const wA = await as(fin, () => rpc('supplier_withholding_record', sA, 'TEST_RET_A', 200))
ok('retenue : montant = base × taux de la règle validée (200 × 2 % = 4,00)',
  num((await q(`select amount from supplier_invoice_withholdings where id=$1`, [wA]))[0].amount) === 4)

// --- 5. Déclaration de mars : calcul et totaux --------------------------------------------------------------------------------------
const dMar = await as(fin, () => rpc('vat_declaration_prepare', 2026, 3))
const dRow = async () => (await q(`select * from vat_declarations where id=$1`, [dMar]))[0]
let d = await dRow()
ok('déclaration mars : TVA collectée 178,00 (171 nets de l’avoir + 7), février exclu', num(d.collected_tax) === 178)
ok('déclaration mars : TVA déductible 45,00 (38 + 7)', num(d.deductible_tax) === 45)
ok('déclaration mars : TVA due 133,00 (collectée − déductible)', num(d.vat_due) === 133)
ok('déclaration mars : retenues 4,00 (hors TVA due)', num(d.withholding_total) === 4)
ok('déclaration mars : brouillon, préparée par fin', d.status === 'brouillon' && d.prepared_by === fin)
const linesMar = await q(`select section, count(*)::int n from vat_declaration_lines where declaration_id=$1 group by section order by section`, [dMar])
ok('déclaration mars : 2 lignes collectées, 2 déductibles, 1 retenue', linesMar.map((x) => `${x.section}:${x.n}`).join(',') === 'collected:2,deductible:2,withholding:1')
const coll19 = await q(`select base_amount, tax_amount from vat_declaration_lines where declaration_id=$1 and section='collected' and rate_pct=19`, [dMar])
ok('collectée 19 % : base 900 et TVA 171 (avoir déduit)', num(coll19[0].base_amount) === 900 && num(coll19[0].tax_amount) === 171)
ok('contrôle de cohérence : déclaration = calcul actuel', (await as(fin, () => rpc('vat_declaration_drift', dMar))).consistent === true)

// --- 6. Validation : séparation des tâches, puis verrouillage -------------------------------------------------------------------------
await rejects('validation par le préparateur refusée', () => as(fin, () => rpc('vat_declaration_validate', dMar)), 'SOD_SELF_APPROVAL')
await rejects('validation sans droit tax.validate refusée', () => as(nobody, () => rpc('vat_declaration_validate', dMar)), 'RBAC_FORBIDDEN')
await as(fin2, () => rpc('vat_declaration_validate', dMar))
d = await dRow()
ok('validation par une autre personne : validée et figée', d.status === 'validee' && d.validated_by === fin2)
await rejects('période validée : nouveau calcul refusé', () => as(fin, () => rpc('vat_declaration_prepare', 2026, 3)), 'VAT_DECLARATION_LOCKED')
await rejects('période validée : TVA déductible refusée', () => as(fin, () => rpc('supplier_invoice_vat_set', sA, lines({ rate_code: 'TN_STD_19', base: 200 }, { rate_code: 'TN_RED_7', base: 100 }))), 'VAT_DECLARATION_LOCKED')
await rejects('période validée : retenue refusée', () => as(fin, () => rpc('supplier_withholding_record', sA, 'TEST_RET_A', 100)), 'VAT_DECLARATION_LOCKED')
await rejects('période validée : retenue non annulable', () => as(fin, () => rpc('supplier_withholding_cancel', wA, 'Tentative après validation')), 'VAT_DECLARATION_LOCKED')
await rejects('déclaration validée : montant modifié directement refusé', () => db.exec(`update vat_declarations set collected_tax = 0 where id='${dMar}'`), 'VAT_DECLARATION_IMMUTABLE')
await rejects('déclaration validée : ligne modifiée directement refusée', () => db.exec(`update vat_declaration_lines set tax_amount = 0 where declaration_id='${dMar}'`), 'VAT_DECLARATION_IMMUTABLE')
await rejects('déclaration : suppression refusée', () => db.exec(`delete from vat_declarations where id='${dMar}'`), 'VAT_DECLARATION_IMMUTABLE')
await rejects('déclaration validée : dépôt direct sans export refusé', () => db.exec(`update vat_declarations set status='deposee', receipt_ref='FAUX-1', receipt_date='2026-04-01', filed_by='${fin}', filed_at=now() where id='${dMar}'`), 'VAT_BAD_STATUS')
await rejects('déclaration validée : export direct sans empreinte refusé', () => db.exec(`update vat_declarations set status='exportee' where id='${dMar}'`), 'check constraint')
ok('après tentatives directes : déclaration toujours validée', (await dRow()).status === 'validee')

// --- 7. Export : empreinte, ré-export identique, aucun dépôt implicite --------------------------------------------------------------------
await rejects('export par un utilisateur sans droit refusé', () => as(nobody, () => rpc('vat_declaration_export', dMar)), 'RBAC_FORBIDDEN')
const ex1 = await as(fin, () => rpc('vat_declaration_export', dMar))
d = await dRow()
ok('export : statut exporté, empreinte enregistrée, export interne signalé', d.status === 'exportee' && d.export_hash === ex1.export_hash && ex1.format.includes('non fourni'))
ok('export : contient les totaux et les lignes', ex1.collected_tax !== undefined && Array.isArray(ex1.lines) && ex1.lines.length === 5)
const ex2 = await as(fin, () => rpc('vat_declaration_export', dMar))
ok('ré-export : empreinte identique (contenu inchangé)', ex2.export_hash === ex1.export_hash)
ok('export sans dépôt : aucun accusé, statut exporté seulement', d.receipt_ref === null && d.filed_by === null)

// --- 8. Dépôt : accusé réel, distinct du validateur, jamais implicite ----------------------------------------------------------------
await rejects('dépôt sans référence d’accusé refusé', () => as(fin, () => rpc('vat_declaration_file', dMar, 'AB', '2026-04-15')), 'VAT_RECEIPT_REQUIRED')
await rejects('dépôt avec date d’accusé antérieure à la période refusé', () => as(fin, () => rpc('vat_declaration_file', dMar, 'ACC-2026-0001', '2026-02-28')), 'VAT_RECEIPT_REQUIRED')
await rejects('dépôt par le validateur refusé', () => as(fin2, () => rpc('vat_declaration_file', dMar, 'ACC-2026-0001', '2026-04-15')), 'SOD_SELF_APPROVAL')
await rejects('dépôt sans droit tax.file refusé', () => as(nobody, () => rpc('vat_declaration_file', dMar, 'ACC-2026-0001', '2026-04-15')), 'RBAC_FORBIDDEN')
await as(fin, () => rpc('vat_declaration_file', dMar, 'ACC-2026-0001', '2026-04-15'))
d = await dRow()
ok('dépôt : statut déposé avec accusé, dépositaire et date', d.status === 'deposee' && d.receipt_ref === 'ACC-2026-0001' && d.filed_by === fin && d.receipt_date.toISOString().slice(0, 10) === '2026-04-15')
await rejects('déposée : annulation refusée', () => as(fin2, () => rpc('vat_declaration_cancel', dMar, 'Tentative après dépôt')), 'VAT_CANNOT_CANCEL_DEPOSITED')
await rejects('déposée : second dépôt refusé', () => as(fin, () => rpc('vat_declaration_file', dMar, 'ACC-2026-0002', '2026-04-16')), 'VAT_BAD_STATUS')
await rejects('déposée : accusé modifié directement refusé', () => db.exec(`update vat_declarations set receipt_ref='AUTRE-1' where id='${dMar}'`), 'VAT_DECLARATION_IMMUTABLE')

// --- 9. Absence de faux dépôt : avril ---------------------------------------------------------------------------------------------------
const dApr = await as(fin, () => rpc('vat_declaration_prepare', 2026, 4))
await rejects('avril : dépôt d’un brouillon refusé', () => as(fin, () => rpc('vat_declaration_file', dApr, 'ACC-2026-0002', '2026-05-15')), 'VAT_BAD_STATUS')
await rejects('avril : export d’un brouillon refusé', () => as(fin, () => rpc('vat_declaration_export', dApr)), 'VAT_BAD_STATUS')
await as(fin2, () => rpc('vat_declaration_validate', dApr))
await as(fin, () => rpc('vat_declaration_export', dApr))
await rejects('avril : accusé déjà utilisé par mars refusé (unicité par société)', () => as(fin, () => rpc('vat_declaration_file', dApr, 'ACC-2026-0001', '2026-05-15')), 'vat_declarations_receipt_uq')
ok('avril : toujours exporté, aucun dépôt', (await q(`select status, receipt_ref from vat_declarations where id=$1`, [dApr]))[0].status === 'exportee')
await rejects('avril : dépôt direct sans accusé refusé (contrainte)', () => db.exec(`update vat_declarations set status='deposee', filed_by='${fin}', filed_at=now() where id='${dApr}'`), 'check constraint')

// --- 10. Annulation avant dépôt -------------------------------------------------------------------------------------------------------
const dMay = await as(fin, () => rpc('vat_declaration_prepare', 2026, 5))
await rejects('annulation : motif trop court refusé', () => as(fin2, () => rpc('vat_declaration_cancel', dMay, 'no')), 'VAT_BAD_STATUS')
await as(fin2, () => rpc('vat_declaration_cancel', dMay, 'Erreur de période, recalcul prévu'))
ok('annulation : brouillon annulé, période libérée', (await q(`select status from vat_declarations where id=$1`, [dMay]))[0].status === 'annulee')
const dMay2 = await as(fin, () => rpc('vat_declaration_prepare', 2026, 5))
ok('après annulation : nouvelle déclaration possible pour la même période', dMay2 !== dMay && (await q(`select status from vat_declarations where id=$1`, [dMay2]))[0].status === 'brouillon')

// --- 11. Règle historique : versions de retenue datées, déclaration figée inchangée ---------------------------------------------------
await rejects('nouvelle version qui chevauche la version ouverte refusée', () => as(fin, () => rpc('withholding_rule_create', 'TEST_RET_A', 'Fixture v2', 3, '2026-04-01', null)), 'WITHHOLDING_OVERLAP')
await rejects('fermeture antérieure à une retenue enregistrée refusée', () => as(fin, () => rpc('withholding_rule_close', rA, '2026-02-28')), 'WITHHOLDING_IN_USE')
await as(fin, () => rpc('withholding_rule_close', rA, '2026-03-31'))
await rejects('version fermée : nouvelle fermeture refusée', () => as(fin, () => rpc('withholding_rule_close', rA, '2026-04-30')), 'WITHHOLDING_IMMUTABLE')
const rA2 = await as(fin, () => rpc('withholding_rule_create', 'TEST_RET_A', 'Fixture v2 (non fiscale)', 3, '2026-04-01', null))
await as(fin2, () => rpc('withholding_rule_validate', rA2, true))
const wMay = await as(fin, () => rpc('supplier_withholding_record', sMay, 'TEST_RET_A', 1000))
ok('mai : retenue calculée avec la version en vigueur (1 000 × 3 % = 30,00)',
  num((await q(`select amount from supplier_invoice_withholdings where id=$1`, [wMay]))[0].amount) === 30)
const wMar = await q(`select rate_pct, amount from supplier_invoice_withholdings where id=$1`, [wA])
ok('mars : retenue enregistrée garde son taux d’origine (2 %, 4,00)', num(wMar[0].rate_pct) === 2 && num(wMar[0].amount) === 4)
d = await dRow()
ok('mars : déclaration déposée inchangée après nouvelle version (retenues 4,00)', num(d.withholding_total) === 4 && d.status === 'deposee')
await rejects('version validée : rétroactivité (date d’effet modifiée) refusée', () => db.exec(`update withholding_rules set effective_from='2025-01-01' where id='${rA}'`), 'WITHHOLDING_IMMUTABLE')

// --- 12. Cohérence : une pièce ajoutée après validation est détectée, les totaux figés ne bougent pas -----------------------------------
await db.exec('alter table invoices disable trigger user')
await q(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate)
         values ($1,$2,'issued','FAC-P60-TARD','2026-03-25','2026-03-25','EUR',19,50,9.5,59.5,1)`, [company, c1])
await db.exec('alter table invoices enable trigger user')
const drift = await as(fin, () => rpc('vat_declaration_drift', dMar))
ok('pièce tardive en mars : écart détecté (cohérence fausse)', drift.consistent === false && drift.differences > 0)
d = await dRow()
ok('pièce tardive : totaux figés inchangés (collectée 178)', num(d.collected_tax) === 178)

// --- 13. Droits, lecture et audit -------------------------------------------------------------------------------------------------------
ok('lecture des déclarations sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from vat_declarations`)))[0].n === 0)
ok('lecture des retenues sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from withholding_rules`)))[0].n === 0)
const actions = (await q(`select string_agg(distinct action, ',' order by action) s from audit_logs where action like 'tax.%'`))[0].s
ok('audit : prépa, validation, export, dépôt, retenues et annulation tracés',
  ['tax.vat_declaration_prepare', 'tax.vat_declaration_validate', 'tax.vat_declaration_export', 'tax.vat_declaration_file', 'tax.vat_declaration_cancel',
   'tax.withholding_record', 'tax.withholding_rule_close', 'tax.withholding_rule_validate', 'tax.supplier_vat_set'].every((a) => actions.includes(a)))
