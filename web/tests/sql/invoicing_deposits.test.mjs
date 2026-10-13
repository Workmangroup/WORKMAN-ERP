// Facturation commerciale : acomptes, facturation par BL, avoirs bornés, idempotence — P031 / migration 0056
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, u, wh, r])
const admin = await mkUser('admin@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')
const fin = await mkUser('fin@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const iso = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

// Fixtures : entrepôt, client, article, variante, lot de produits finis
const wh = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Expédition P031','finished_goods') returning *`))[0])
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator') on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, mag, wh.id])
const client = (await as(admin, () => q(`insert into clients(name, country, currency, vat_exempt) values ('Client facturation P031','TN','EUR',true) returning id`)))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'FAC-31','Veste P031','jacket') returning id`, [client])))[0].id
const prodV = (await as(admin, () => q(`insert into product_master(client_id, name, family, article_id) values ($1,'Veste P031','jacket',$2) returning id`, [client, art])))[0].id
const colJaune = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJaune], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
await as(admin, () => q(`update product_variants set price = 25 where id=$1`, [vV]))
const LA = await as(admin, () => rpc('finished_lot_receive', vV, wh.id, 'LOT-A-31', 100, 'OF-P31-1'))

const order = async (qty) => {
  const id = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
  await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,$5,25,$6)`, [company, id, art, vV, qty, iso(20)])
  await as(admin, () => rpc('sales_order_confirm', id))
  return id
}
const O1 = await order(10) // sous-total 250,00
const O2 = await order(30) // sous-total 750,00
const inv = async (id) => (await q(`select * from invoices where id=$1`, [id]))[0]

// 1. Acomptes : bornes, idempotence, émission
const D1 = await as(admin, () => rpc('invoice_deposit_create', O1, 100, 'acompte-31-key-1'))
const D1b = await as(admin, () => rpc('invoice_deposit_create', O1, 100, 'acompte-31-key-1'))
ok('acompte : reprise avec la même clé renvoie la même facture, sans doublon', D1 === D1b && (await count(`select count(*)::int n from invoices where order_id=$1 and kind='deposit'`, [O1])) === 1)
await rejects('acompte : clé réutilisée pour un autre montant refusée', () => as(admin, () => rpc('invoice_deposit_create', O1, 50, 'acompte-31-key-1')), 'IDEMPOTENCY_KEY_REUSED')
await rejects('acompte : au-delà du sous-total commandé refusé (100 + 200 > 250)', () => as(admin, () => rpc('invoice_deposit_create', O1, 200, 'acompte-31-key-2')), 'DEPOSIT_OVER_ORDER')
await rejects('acompte : clé d’idempotence absente refusée', () => as(admin, () => rpc('invoice_deposit_create', O1, 10, '')), 'IDEMPOTENCY_KEY_REQUIRED')
await rejects('acompte : utilisateur sans droit facture refusé', () => as(nobody, () => rpc('invoice_deposit_create', O1, 10, 'acompte-31-key-3')), 'RBAC_FORBIDDEN')
const DC1 = await as(admin, () => rpc('invoice_issue', D1))
const d1 = await inv(D1)
ok('acompte émis : code FAC, type deposit, sous-total 100, TVA = arrondi du taux', /^FAC-\d{4}-\d{4}$/.test(DC1) && d1.kind === 'deposit' && Number(d1.subtotal) === 100 && Number(d1.tax_amount) === Math.round(100 * Number(d1.tax_rate)) / 100)
ok('acompte : la commande n’est pas consommée (qty_invoiced inchangé)', Number((await q(`select qty_invoiced from sales_order_lines where order_id=$1`, [O1]))[0].qty_invoiced) === 0)

const D2 = await as(admin, () => rpc('invoice_deposit_create', O2, 50, 'acompte-31-key-4'))
await as(admin, () => rpc('invoice_issue', D2))

// 2. Facturation par BL
const S1 = await as(admin, () => rpc('shipment_create', O1, wh.id, null, null, 'EUR'))
const L1 = await as(admin, () => rpc('shipment_add_line', S1, vV, 10))
await as(admin, () => rpc('shipment_pick', L1, 10))
await as(admin, () => rpc('shipment_pack', S1, 1, 12, 10))
await as(admin, () => rpc('shipment_line_lot_assign', L1, LA, 10))
const BL1 = await as(admin, () => rpc('shipment_ship', S1, 'DHL', 'TRK-31'))
const S2 = await as(admin, () => rpc('shipment_create', O2, wh.id, null, null, 'EUR'))
await as(admin, () => rpc('shipment_add_line', S2, vV, 5))

await rejects('facture BL : expédition non expédiée refusée', () => as(admin, () => rpc('invoice_from_shipment', S2, 'bl-s2-key-31-a')), 'INVOICE_SHIPMENT_NOT_SHIPPED')
await rejects('facture BL : sans droit facture refusée', () => as(nobody, () => rpc('invoice_from_shipment', S1, 'bl-s1-key-31-x')), 'RBAC_FORBIDDEN')
const F1 = await as(admin, () => rpc('invoice_from_shipment', S1, 'bl-s1-key-31-a'))
const F1b = await as(admin, () => rpc('invoice_from_shipment', S1, 'bl-s1-key-31-a'))
ok('facture BL : reprise avec la même clé, même facture', F1 === F1b && (await count(`select count(*)::int n from invoices where order_id=$1 and kind='standard' and status='draft'`, [O1])) === 1)
await rejects('facture BL : même BL avec une autre clé refusée (rien à facturer)', () => as(admin, () => rpc('invoice_from_shipment', S1, 'bl-s1-key-31-b')), 'INVOICE_NOTHING_TO_INVOICE')
await rejects('facture BL : clé réutilisée pour un autre BL refusée', () => as(admin, () => rpc('invoice_from_shipment', S2, 'bl-s1-key-31-a')), 'IDEMPOTENCY_KEY_REUSED')
const f1 = await inv(F1)
const lines1 = await q(`select il.qty, il.unit_price, il.shipment_line_id, sl.id as sl from invoice_lines il join shipment_lines sl on sl.id = il.shipment_line_id where il.invoice_id=$1`, [F1])
ok('facture BL : une ligne par ligne de BL, quantité expédiée, lien conservé', lines1.length === 1 && Number(lines1[0].qty) === 10 && lines1[0].shipment_line_id === lines1[0].sl)
ok('facture BL : sous-total 250, TVA arrondie au centime, TTC = HT + TVA', Number(f1.subtotal) === 250 && Number(f1.tax_amount) === Math.round(250 * Number(f1.tax_rate)) / 100 && Number(f1.total) === Number(f1.subtotal) + Number(f1.tax_amount))
const bs0 = await as(admin, () => rpc('shipment_billing_status', S1))
ok('rapprochement BL : 10 expédiés, 0 facturé, 10 en brouillon', bs0.length === 1 && Number(bs0[0].qty_shipped) === 10 && Number(bs0[0].billed) === 0 && Number(bs0[0].draft) === 10)
const F1CODE = await as(admin, () => rpc('invoice_issue', F1))
const bs1 = await as(admin, () => rpc('shipment_billing_status', S1))
ok('rapprochement BL : après émission, 10 facturés, 0 en brouillon', Number(bs1[0].billed) === 10 && Number(bs1[0].draft) === 0)

// 3. Imputation d’acompte sur la facture finale
const FO2 = await as(admin, () => rpc('invoice_from_order', O2, null))
const DB2 = (await q(`select id from invoices where order_id=$1 and kind='deposit'`, [O2]))[0].id
await rejects('imputation : facture brouillon refusée', () => as(admin, () => rpc('invoice_deposit_apply', FO2, DB2, 10)), 'COMMERCIAL_BAD_STATUS')
await rejects('imputation : acompte d’une autre commande refusé', () => as(admin, () => rpc('invoice_deposit_apply', F1, DB2, 10)), 'DEPOSIT_ORDER_MISMATCH')
await rejects('imputation : sans droit paiement refusée', () => as(nobody, () => rpc('invoice_deposit_apply', F1, D1, 10)), 'RBAC_FORBIDDEN')
await rejects('imputation : montant nul refusé', () => as(admin, () => rpc('invoice_deposit_apply', F1, D1, 0)), 'INVOICE_BAD_AMOUNT')
const dTotal = Number((await inv(D1)).total)
await rejects('imputation : au-delà du solde de l’acompte refusée', () => as(admin, () => rpc('invoice_deposit_apply', F1, D1, dTotal + 0.01)), 'DEPOSIT_EXCEEDS_BALANCE')
await as(admin, () => rpc('invoice_deposit_apply', F1, D1, dTotal))
const f1p = await inv(F1)
const d1p = await inv(D1)
ok('imputation : facture finale créditée du montant, acompte soldé (statut paid)', Number(f1p.paid_amount) === dTotal && d1p.status === 'paid' && Number(d1p.paid_amount) === dTotal)
ok('imputation : trace conservée (une ligne d’application)', (await count(`select count(*)::int n from invoice_deposit_applications where final_invoice_id=$1`, [F1])) === 1)
await rejects('imputation : acompte déjà soldé ne peut plus être imputé', () => as(admin, () => rpc('invoice_deposit_apply', F1, D1, 1)), 'DEPOSIT_EXCEEDS_BALANCE')

// 4. Facture émise immuable
await rejects('facture émise : montant non modifiable hors fonction', () => db.query(`update invoices set total = 1 where id=$1`, [F1]), 'COMMERCIAL_LOCKED')
await rejects('facture émise : ligne non modifiable hors fonction', () => db.query(`update invoice_lines set qty = 1 where invoice_id=$1`, [F1]), 'COMMERCIAL_LOCKED')

// 5. Avoirs bornés
const D3 = await as(admin, () => rpc('invoice_deposit_create', O1, 100, 'acompte-31-key-5'))
await as(admin, () => rpc('invoice_issue', D3))
await as(admin, () => rpc('invoice_deposit_apply', F1, D3, 10))
const CN3 = await as(admin, () => rpc('credit_note_create', D3, 'Annulation acompte test'))
await rejects('avoir sur acompte : au-delà du solde non imputé refusé (CREDIT_OVER_BALANCE)', () => as(admin, () => rpc('credit_note_issue', CN3, false)), 'CREDIT_OVER_BALANCE')
ok('avoir refusé : reste en brouillon, sans effet sur l’acompte', (await q(`select status from credit_notes where id=$1`, [CN3]))[0].status === 'draft' && Number((await inv(D3)).credited_amount) === 0)

const CNF = await as(admin, () => rpc('credit_note_create', F1, 'Retour total BL test'))
const AV = await as(admin, () => rpc('credit_note_issue', CNF, false))
const f1c = await inv(F1)
ok('avoir sur facture : code AV, facture passée à credited, montant avoir = total', /^AV-\d{4}-\d{4}$/.test(AV) && f1c.status === 'credited' && Number(f1c.credited_amount) === Number(f1c.total))
await rejects('avoir : facture déjà entièrement créditée, second avoir refusé', () => as(admin, () => rpc('credit_note_create', F1, 'Second avoir test')), 'CREDIT_BAD_INVOICE')
await rejects('avoir : facture BL sans droit facture refusé', () => as(nobody, () => rpc('credit_note_create', F1, 'Test droits')), 'RBAC_FORBIDDEN')

// 6. Pas d’émission en double sur reprise : second émission refusée, numéro inchangé
await rejects('émission répétée d’une facture refusée', () => as(admin, () => rpc('invoice_issue', F1)), 'COMMERCIAL_BAD_STATUS')
ok('numéro de facture stable après reprise', (await inv(F1)).code === F1CODE && /^FAC-\d{4}-\d{4}$/.test(F1CODE))
