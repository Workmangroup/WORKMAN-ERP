import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql', '0022_finance.sql', '0027_multicurrency.sql', '0029_export_vat_rule.sql', '0030_vat_rates_versioned.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b) => Math.abs(Number(a) - b) < 0.0051
const year = String(new Date().getFullYear())

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const dir = await mkUser('dir@x.com', 'direction')
const prod = await mkUser('prod@x.com', 'production')

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
const has = async (c, ...codes) => { const p = await perms(c); return codes.every((x) => p.includes(x)) }
ok('commercial : prospects, devis, commandes, clients ; lecture seule des factures', (await has('commercial', 'prospects.write', 'quotes.write', 'orders.write', 'orders.confirm', 'clients.write', 'invoices.read')) && !(await has('commercial', 'invoices.write')))
ok('finance : factures, avoirs et encaissements', await has('finance', 'invoices.write', 'payments.write', 'quotes.read'))
ok('direction : lecture des prospects et devis, pas d’écriture', (await has('direction', 'prospects.read', 'quotes.read')) && !(await has('direction', 'prospects.write', 'quotes.write')))

// --- 1. Prospects -----------------------------------------------------------------------------------------------------------------------
const mkP = (u, o = {}) => as(u, async () => (await q(`insert into prospects(company_name, contact_name, email, country, source, est_value, owner_id, next_action_date) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
  [o.name ?? 'Bragard Workwear', 'Mme Durand', o.email ?? 'durand@bragard.fr', o.country === undefined ? 'TN' : o.country, o.source ?? 'trade_show', o.value ?? 50000, comm, o.next ?? null]))[0])
const p1 = await mkP(comm)
ok('prospect : code PRO-0001, étape « nouveau », société déduite', p1.code === 'PRO-0001' && p1.stage === 'new' && p1.company_id === company && p1.created_by === comm)
await rejects('création refusée sans prospects.write (production)', () => mkP(prod), 'row-level security')
await rejects('e-mail invalide refusé', () => mkP(comm, { email: 'pas-un-mail' }), 'email')
await rejects('étape non modifiable directement', () => as(comm, () => db.query(`update prospects set stage='won' where id=$1`, [p1.id])), 'permission denied')
await as(comm, () => rpc('prospect_set_stage', p1.id, 'contacted'))
await as(comm, () => db.query(`insert into prospect_activities(prospect_id, kind, summary) values ($1,'call','Premier appel, intéressée par la HV classe 2')`, [p1.id]))
ok('étape « contacté » + activité enregistrée', (await q(`select stage from prospects where id=$1`, [p1.id]))[0].stage === 'contacted' && (await q(`select count(*)::int n from prospect_activities where prospect_id=$1`, [p1.id]))[0].n === 1)
await rejects('étape « gagné » refusée : passer par la conversion', () => as(comm, () => rpc('prospect_set_stage', p1.id, 'won')), 'PROSPECT_USE_CONVERT')
await rejects('étape inconnue refusée', () => as(comm, () => rpc('prospect_set_stage', p1.id, 'rêve')), 'PROSPECT_BAD_STAGE')
await rejects('étape refusée sans prospects.write (direction)', () => as(dir, () => rpc('prospect_set_stage', p1.id, 'qualified')), 'RBAC_FORBIDDEN')
ok('lecture : direction oui, finance et production non', (await as(dir, () => q(`select id from prospects`))).length === 1 && (await as(fin, () => q(`select id from prospects`))).length === 0 && (await as(prod, () => q(`select id from prospects`))).length === 0)
const p2 = await mkP(comm, { name: 'Concurrent perdu', value: 8000 })
await rejects('« perdu » : motif obligatoire', () => as(comm, () => rpc('prospect_set_stage', p2.id, 'lost')), 'PROSPECT_REASON_REQUIRED')
await as(comm, () => rpc('prospect_set_stage', p2.id, 'lost', 'Prix trop élevé'))
await rejects('prospect clos : plus de changement d’étape', () => as(comm, () => rpc('prospect_set_stage', p2.id, 'new')), 'PROSPECT_CLOSED')
await rejects('prospect clos : modification refusée', () => as(comm, () => db.query(`update prospects set notes='x' where id=$1`, [p2.id])), 'PROSPECT_CLOSED')
await rejects('conversion refusée sans pays (fiche client)', async () => { const p = await mkP(comm, { name: 'Sans pays', country: null }); await as(comm, () => rpc('prospect_convert', p.id)) }, 'PROSPECT_COUNTRY_REQUIRED')

// --- 2. Devis sur prospect ----------------------------------------------------------------------------------------------------------------
const mkQ = (u, o) => as(u, async () => (await q(`insert into quotes(client_id, prospect_id, tax_rate, payment_terms, lead_days) values ($1,$2,$3,'30 jours',${o.lead ?? 30}) returning *`, [o.client ?? null, o.prospect ?? null, o.tax ?? 19]))[0])
const addQL = (u, quote, o) => as(u, () => db.query(`insert into quote_lines(quote_id, article_id, description, qty, unit_price, discount_pct) values ($1,$2,$3,$4,$5,$6)`, [quote, o.article ?? null, o.desc ?? null, o.qty, o.price, o.disc ?? 0]))
const qt = async (id) => (await q(`select * from quotes where id=$1`, [id]))[0]
const q1 = await mkQ(comm, { prospect: p1.id })
ok(`devis : code DEV-${year}-0001, brouillon, rattaché au prospect, validité 30 jours par défaut`, q1.code === `DEV-${year}-0001` && q1.status === 'draft' && q1.prospect_id === p1.id && q1.client_id === null)
await rejects('devis : ni client ni prospect refusé', () => as(comm, () => db.query(`insert into quotes(tax_rate) values (19)`)), 'COMMERCIAL_BAD_PROSPECT')
await rejects('devis : prospect clos refusé', () => mkQ(comm, { prospect: p2.id }), 'COMMERCIAL_BAD_PROSPECT')
await rejects('devis : refusé sans quotes.write', () => mkQ(prod, { prospect: p1.id }), 'row-level security')
await addQL(comm, q1.id, { desc: 'Veste haute visibilité classe 2', qty: 100, price: 12.5, disc: 10 })
await addQL(comm, q1.id, { desc: 'Marquage logo', qty: 10, price: 40 })
const t1 = await qt(q1.id)
ok('totaux : 1125 + 400 = 1525 HT ; TVA 19 % = 289,75 ; TTC 1814,75', near(t1.subtotal, 1525) && near(t1.tax_amount, 289.75) && near(t1.total, 1814.75), JSON.stringify([t1.subtotal, t1.tax_amount, t1.total]))
await as(comm, () => db.query(`update quotes set tax_rate=0 where id=$1`, [q1.id]))
ok('taux de TVA modifié : totaux recalculés (export exonéré)', near((await qt(q1.id)).tax_amount, 0) && near((await qt(q1.id)).total, 1525))
await as(comm, () => db.query(`update quotes set tax_rate=19 where id=$1`, [q1.id]))
await rejects('ligne : remise > 100 % refusée', () => addQL(comm, q1.id, { desc: 'X', qty: 1, price: 1, disc: 120 }), 'discount_pct')
await rejects('ligne : article refusé sur un devis de prospect', async () => addQL(comm, q1.id, { article: (await q(`select gen_random_uuid() id`))[0].id, desc: 'X', qty: 1, price: 1 }), 'COMMERCIAL_BAD_ARTICLE')
const empty = await mkQ(comm, { prospect: p1.id })
await rejects('envoi refusé : devis vide', () => as(comm, () => rpc('quote_send', empty.id)), 'COMMERCIAL_EMPTY')
await rejects('envoi refusé sans quotes.write (finance)', () => as(fin, () => rpc('quote_send', q1.id)), 'RBAC_FORBIDDEN')
await as(comm, () => rpc('quote_send', q1.id))
ok('devis envoyé ; le prospect passe automatiquement à « proposition »', (await qt(q1.id)).status === 'sent' && (await q(`select stage from prospects where id=$1`, [p1.id]))[0].stage === 'proposal')
await rejects('devis envoyé : ligne non modifiable', () => addQL(comm, q1.id, { desc: 'Tard', qty: 1, price: 1 }), 'COMMERCIAL_LOCKED')
await rejects('devis envoyé : en-tête non modifiable', () => as(comm, () => db.query(`update quotes set notes='x' where id=$1`, [q1.id])), 'COMMERCIAL_LOCKED')
await rejects('refus du client : motif obligatoire', () => as(comm, () => rpc('quote_decide', q1.id, false)), 'QUOTE_REASON_REQUIRED')
// devis expiré
const qExp = await mkQ(comm, { prospect: p1.id }); await addQL(comm, qExp.id, { desc: 'Vieux devis', qty: 1, price: 100 }); await as(comm, () => rpc('quote_send', qExp.id))
await db.exec(`select set_config('commercial.rpc','on',false)`); await db.query(`update quotes set valid_until = current_date - 1 where id=$1`, [qExp.id]); await db.exec(`select set_config('commercial.rpc','off',false)`)
await rejects('devis expiré : acceptation refusée', () => as(comm, () => rpc('quote_decide', qExp.id, true)), 'QUOTE_EXPIRED')
await as(comm, () => rpc('quote_decide', qExp.id, false, 'Trop tard'))
ok('devis expiré rejeté avec motif', (await qt(qExp.id)).status === 'rejected')
const dup = await as(comm, () => rpc('quote_duplicate', qExp.id))
ok('duplication : nouveau devis brouillon (code suivant) avec les mêmes lignes', (await qt(dup)).status === 'draft' && (await qt(dup)).code !== qExp.code && (await q(`select count(*)::int n from quote_lines where quote_id=$1`, [dup]))[0].n === 1)
await as(comm, () => rpc('quote_cancel', dup))
await as(comm, () => rpc('quote_decide', q1.id, true))
ok('devis accepté ; le prospect passe en « négociation »', (await qt(q1.id)).status === 'accepted' && (await q(`select stage from prospects where id=$1`, [p1.id]))[0].stage === 'negotiation')
await rejects('commande refusée tant que le prospect n’est pas converti en client', () => as(comm, () => rpc('quote_to_order', q1.id)), 'QUOTE_PROSPECT_NOT_CONVERTED')

// --- 3. Conversion du prospect en client ---------------------------------------------------------------------------------------------------
await rejects('conversion refusée sans clients.write (finance)', () => as(fin, () => rpc('prospect_convert', p1.id)), 'RBAC_FORBIDDEN')
const clientId = await as(comm, () => rpc('prospect_convert', p1.id))
const cl = (await q(`select * from clients where id=$1`, [clientId]))[0]
ok('conversion : fiche client créée (code CLI-xxxx, pays, e-mail, commercial affecté)', /^CLI-\d{4}$/.test(cl.code) && cl.name === 'Bragard Workwear' && cl.country === 'TN' && cl.email === 'durand@bragard.fr' && cl.sales_rep_id === comm)
const pAfter = (await q(`select * from prospects where id=$1`, [p1.id]))[0]
ok('prospect « gagné » et lié au client ; ses devis rattachés au client', pAfter.stage === 'won' && pAfter.converted_client_id === clientId && (await qt(q1.id)).client_id === clientId && (await qt(q1.id)).prospect_id === null)
await rejects('prospect converti : conversion répétée refusée', () => as(comm, () => rpc('prospect_convert', p1.id)), 'PROSPECT_CLOSED')

// --- 4. Du devis à la commande -------------------------------------------------------------------------------------------------------------
await rejects('commande refusée sans orders.write (direction)', () => as(dir, () => rpc('quote_to_order', q1.id)), 'RBAC_FORBIDDEN')
const orderId = await as(comm, () => rpc('quote_to_order', q1.id))
const ord = (await q(`select * from sales_orders where id=$1`, [orderId]))[0]
const ol = await q(`select * from sales_order_lines where order_id=$1 order by unit_price desc`, [orderId])
ok('commande issue du devis : brouillon, liée au devis, TVA (client local TN) et conditions reprises', ord.status === 'draft' && ord.quote_id === q1.id && Number(ord.tax_rate) === 19 && ord.payment_terms === '30 jours' && ord.client_id === clientId)
ok('lignes reprises (prix, remise, description) ; totaux identiques au devis (1525 / 289,75 / 1814,75)', ol.length === 2 && ol[1].description === 'Veste haute visibilité classe 2' && Number(ol[1].discount_pct) === 10 && near(ord.subtotal, 1525) && near(ord.total, 1814.75), JSON.stringify([ord.subtotal, ord.total]))
ok('échéance de livraison = date du jour + délai annoncé (30 j)', (await q(`select count(*)::int n from sales_order_lines where order_id=$1 and due_date = current_date + 30`, [orderId]))[0].n === 2)
ok('devis « transformé », lien vers la commande', (await qt(q1.id)).status === 'converted' && (await qt(q1.id)).order_id === orderId)
await rejects('devis déjà transformé : seconde commande refusée', () => as(comm, () => rpc('quote_to_order', q1.id)), 'COMMERCIAL_BAD_STATUS')
await rejects('facture refusée : commande non confirmée', () => as(fin, () => rpc('invoice_from_order', orderId)), 'INVOICE_ORDER_NOT_CONFIRMED')
await as(comm, () => rpc('sales_order_confirm', orderId))
await rejects('commande confirmée : prix non modifiable', () => as(comm, () => db.query(`update sales_order_lines set unit_price=1 where order_id=$1`, [orderId])), 'ORDER_LOCKED')

// commande avec article du client (ligne article + description par défaut)
const art = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT001','BRG-1','Veste HV Bragard','jacket') returning id`, [clientId])))[0].id
const qa = await mkQ(comm, { client: clientId, tax: 0 })
await addQL(comm, qa.id, { article: art, qty: 50, price: 30 })
ok('ligne article : description reprise de l’article ; TVA 0 %', (await q(`select description from quote_lines where quote_id=$1`, [qa.id]))[0].description === 'Veste HV Bragard' && near((await qt(qa.id)).total, 1500))
await rejects('article d’un autre client refusé', async () => { const oc = (await as(comm, () => q(`insert into clients(name,country) values ('Autre client','DE') returning id`)))[0].id; const oa = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'AUT1','A-1','Autre','shirt') returning id`, [oc])))[0].id; await addQL(comm, qa.id, { article: oa, qty: 1, price: 1 }) }, 'COMMERCIAL_BAD_ARTICLE')

// --- 5. Factures -----------------------------------------------------------------------------------------------------------------------------
await rejects('facture refusée sans invoices.write (commercial)', () => as(comm, () => rpc('invoice_from_order', orderId)), 'RBAC_FORBIDDEN')
const [l1, l2] = [ol[1], ol[0]]    // 100 × 12,50 − 10 % (1125) ; 10 × 40 (400)
const inv1 = await as(fin, () => rpc('invoice_from_order', orderId, JSON.stringify([{ order_line_id: l1.id, qty: 40 }])))
const i1 = (await q(`select * from invoices where id=$1`, [inv1]))[0]
ok('facture brouillon sans numéro, partielle : 40 × 12,50 − 10 % = 450 HT ; TVA 85,50 ; TTC 535,50', i1.status === 'draft' && i1.code === null && near(i1.subtotal, 450) && near(i1.tax_amount, 85.5) && near(i1.total, 535.5), JSON.stringify([i1.status, i1.subtotal, i1.total]))
const il = (await q(`select * from invoice_lines where invoice_id=$1`, [inv1]))[0]
ok('ligne de facture liée à la ligne de commande', il.order_line_id === l1.id && Number(il.qty) === 40)
await rejects('facture : ligne de commande non forgeable à la main', () => as(fin, () => db.query(`insert into invoice_lines(invoice_id, order_line_id, description, qty, unit_price) values ($1,$2,'x',1,1)`, [inv1, l1.id])), 'permission denied')
await rejects('quantité facturée de la commande non modifiable', () => as(fin, () => db.query(`update sales_order_lines set qty_invoiced=99 where id=$1`, [l1.id])), 'permission denied')
await rejects('émission refusée sans invoices.write', () => as(comm, () => rpc('invoice_issue', inv1)), 'RBAC_FORBIDDEN')
const code1 = await as(fin, () => rpc('invoice_issue', inv1))
const i1b = (await q(`select *, (due_date - issue_date) as days from invoices where id=$1`, [inv1]))[0]
ok(`facture émise : numéro FAC-${year}-0001, date, échéance, émetteur`, code1 === `FAC-${year}-0001` && i1b.status === 'issued' && i1b.issued_by === fin && i1b.issue_date !== null && Number(i1b.days) >= 0)
ok('commande : 40 facturés sur 100, avancement « partiel »', Number((await q(`select qty_invoiced from sales_order_lines where id=$1`, [l1.id]))[0].qty_invoiced) === 40 && (await q(`select invoice_status from sales_orders where id=$1`, [orderId]))[0].invoice_status === 'partial')
await rejects('facture émise : ligne non modifiable', () => as(fin, () => db.query(`update invoice_lines set qty=1 where invoice_id=$1`, [inv1])), 'COMMERCIAL_LOCKED')
await rejects('facture émise : en-tête non modifiable', () => as(fin, () => db.query(`update invoices set notes='x' where id=$1`, [inv1])), 'COMMERCIAL_LOCKED')
await rejects('facture émise : annulation interdite (avoir obligatoire)', () => as(fin, () => rpc('invoice_cancel', inv1)), 'INVOICE_CANCEL_ISSUED')
// numérotation sans trou
const draftA = await as(fin, () => rpc('invoice_from_order', orderId)), draftB = await as(fin, () => rpc('invoice_from_order', orderId))
const ia = (await q(`select subtotal, total from invoices where id=$1`, [draftA]))[0]
ok('facture du solde : 60 × 11,25 + 10 × 40 = 1075 HT ; TTC 1279,25', near(ia.subtotal, 1075) && near(ia.total, 1279.25), JSON.stringify(ia))
const draftC = await as(fin, () => rpc('invoice_from_order', orderId))
await as(fin, () => rpc('invoice_cancel', draftC))
const code2 = await as(fin, () => rpc('invoice_issue', draftA))
ok('numérotation sans trou : un brouillon annulé ne consomme pas de numéro (FAC-0002)', code2 === `FAC-${year}-0002`)
await rejects('sur-facturation refusée à l’émission (le solde est déjà facturé)', () => as(fin, () => rpc('invoice_issue', draftB)), 'INVOICE_OVER_INVOICED')
ok('l’échec ne consomme pas de numéro : la facture suivante prendra FAC-0003', (await q(`select last_value from company_sequences where key=$1`, [`invoice-${year}`]))[0].last_value === 2)
ok('commande entièrement facturée', (await q(`select invoice_status from sales_orders where id=$1`, [orderId]))[0].invoice_status === 'full')
await rejects('plus rien à facturer', () => as(fin, () => rpc('invoice_from_order', orderId)), 'INVOICE_NOTHING_TO_INVOICE')
await as(fin, () => rpc('invoice_cancel', draftB))
// facture manuelle (sans commande)
const man = await as(fin, async () => (await q(`insert into invoices(client_id, tax_rate) values ($1, 19) returning id`, [clientId]))[0].id)
await rejects('émission refusée : facture vide', () => as(fin, () => rpc('invoice_issue', man)), 'COMMERCIAL_EMPTY')
await as(fin, () => db.query(`insert into invoice_lines(invoice_id, description, qty, unit_price) values ($1,'Prestation de maquettage',1,300)`, [man]))
ok('facture manuelle : 300 HT ; TTC 357', near((await q(`select total from invoices where id=$1`, [man]))[0].total, 357))
await as(fin, () => rpc('invoice_cancel', man))

// --- 6. Encaissements ------------------------------------------------------------------------------------------------------------------------
await rejects('encaissement refusé sans payments.write (commercial)', () => as(comm, () => rpc('invoice_record_payment', inv1, 100)), 'RBAC_FORBIDDEN')
await rejects('encaissement refusé sur un brouillon', () => as(fin, () => rpc('invoice_record_payment', draftB, 10)), 'COMMERCIAL_BAD_STATUS')
await as(fin, () => rpc('invoice_record_payment', inv1, 500, null, 'transfer', 'VIR-2026-01'))
ok('encaissement partiel : « partiellement payée », reste 35,50', (await q(`select status from invoices where id=$1`, [inv1]))[0].status === 'partially_paid' && near((await q(`select paid_amount from invoices where id=$1`, [inv1]))[0].paid_amount, 500))
await rejects('sur-paiement refusé', () => as(fin, () => rpc('invoice_record_payment', inv1, 40)), 'INVOICE_OVERPAYMENT')
await rejects('montant nul refusé', () => as(fin, () => rpc('invoice_record_payment', inv1, 0)), 'INVOICE_BAD_AMOUNT')
await as(fin, () => rpc('invoice_record_payment', inv1, 35.5, null, 'cheque'))
ok('facture soldée : statut « payée »', (await q(`select status from invoices where id=$1`, [inv1]))[0].status === 'paid' && (await q(`select count(*)::int n from invoice_payments where invoice_id=$1`, [inv1]))[0].n === 2)
ok('encaissements visibles avec payments.read (finance), pas par le commercial', (await as(fin, () => q(`select id from invoice_payments`))).length === 2 && (await as(comm, () => q(`select id from invoice_payments`))).length === 0)
await rejects('encaissement non modifiable directement', () => as(fin, () => db.query(`update invoice_payments set amount=1`)), 'permission denied')

// --- 7. Avoirs ----------------------------------------------------------------------------------------------------------------------------
await rejects('avoir refusé sans invoices.write', () => as(comm, () => rpc('credit_note_create', inv1, 'Retour')), 'RBAC_FORBIDDEN')
await rejects('avoir : motif obligatoire', () => as(fin, () => rpc('credit_note_create', inv1, '')), 'CREDIT_REASON_REQUIRED')
await rejects('avoir refusé sur une facture brouillon', () => as(fin, () => rpc('credit_note_create', draftB, 'Test motif')), 'CREDIT_BAD_INVOICE')
const cn1 = await as(fin, () => rpc('credit_note_create', inv1, 'Défaut sur 10 vestes'))
ok('avoir brouillon sans numéro, lignes reprises de la facture (40)', (await q(`select code, status from credit_notes where id=$1`, [cn1]))[0].code === null && Number((await q(`select qty from credit_note_lines where credit_note_id=$1`, [cn1]))[0].qty) === 40)
await as(fin, () => db.query(`update credit_note_lines set qty=10 where credit_note_id=$1`, [cn1]))
const c1 = (await q(`select * from credit_notes where id=$1`, [cn1]))[0]
ok('avoir partiel : 10 × 12,50 − 10 % = 112,50 HT ; TVA 21,38 ; TTC 133,88', near(c1.subtotal, 112.5) && near(c1.tax_amount, 21.38) && near(c1.total, 133.88), JSON.stringify([c1.subtotal, c1.tax_amount, c1.total]))
await rejects('avoir : prix non modifiable', () => as(fin, () => db.query(`update credit_note_lines set unit_price=99 where credit_note_id=$1`, [cn1])), 'permission denied')
const acode = await as(fin, () => rpc('credit_note_issue', cn1))
ok(`avoir émis : numéro AV-${year}-0001, facture créditée de 133,88`, acode === `AV-${year}-0001` && near((await q(`select credited_amount from invoices where id=$1`, [inv1]))[0].credited_amount, 133.88))
await rejects('avoir émis : non modifiable', () => as(fin, () => db.query(`update credit_note_lines set qty=1 where credit_note_id=$1`, [cn1])), 'COMMERCIAL_LOCKED')
const cn2 = await as(fin, () => rpc('credit_note_create', inv1, 'Reste des vestes non conformes'))
ok('deuxième avoir : quantité proposée = reste à créditer (30)', Number((await q(`select qty from credit_note_lines where credit_note_id=$1`, [cn2]))[0].qty) === 30)
await as(fin, () => db.query(`update credit_note_lines set qty=31 where credit_note_id=$1`, [cn2]))
await rejects('sur-crédit refusé à l’émission', () => as(fin, () => rpc('credit_note_issue', cn2)), 'CREDIT_OVER_CREDIT')
await as(fin, () => db.query(`update credit_note_lines set qty=30 where credit_note_id=$1`, [cn2]))
await as(fin, () => rpc('credit_note_issue', cn2, true))
ok('avoir avec réouverture : 30 pièces redeviennent facturables (70 sur 100), commande « partielle »', Number((await q(`select qty_invoiced from sales_order_lines where id=$1`, [l1.id]))[0].qty_invoiced) === 70 && (await q(`select invoice_status from sales_orders where id=$1`, [orderId]))[0].invoice_status === 'partial')
ok('facture entièrement créditée : statut « créditée »', (await q(`select status from invoices where id=$1`, [inv1]))[0].status === 'credited')
const re = await as(fin, () => rpc('invoice_from_order', orderId))
ok('la réouverture permet de refacturer les 30 pièces (30 × 11,25 = 337,50 HT)', near((await q(`select subtotal from invoices where id=$1`, [re]))[0].subtotal, 337.5))
await as(fin, () => rpc('invoice_cancel', re))
await rejects('avoir annulable seulement en brouillon', () => as(fin, () => rpc('credit_note_cancel', cn1)), 'COMMERCIAL_BAD_STATUS')

// --- 8. Tableau de bord --------------------------------------------------------------------------------------------------------------------
const dc = await as(comm, () => rpc('commercial_dashboard'))
ok('tableau de bord commercial : prospects, devis, commandes et factures (lecture)', dc.prospects && dc.quotes && dc.orders && dc.invoices)
const df = await as(fin, () => rpc('commercial_dashboard'))
ok('tableau de bord finance : factures, commandes, devis — sans les prospects', df.invoices && df.orders && df.quotes && df.prospects === undefined)
const exp = (await q(`select coalesce(sum(subtotal) filter (where status not in ('draft','cancelled')),0)::float s from invoices where issue_date >= date_trunc('year', current_date)`))[0].s - (await q(`select coalesce(sum(subtotal),0)::float s from credit_notes where status='issued'`))[0].s
ok('CA de l’année = factures émises − avoirs émis', near(df.invoices.invoiced_year, exp), `${df.invoices.invoiced_year} / ${exp}`)
ok('encaissé du mois = 535,50 ; impayés = soldes des factures ouvertes', near(df.invoices.collected_month, 535.5) && near(df.invoices.outstanding, 1279.25), JSON.stringify([df.invoices.collected_month, df.invoices.outstanding]))
ok('indicateurs de pipeline : 1 prospect ouvert (« Sans pays »), 1 gagné sur 90 jours', dc.prospects.open_count === 1 && dc.prospects.won_90d === 1 && dc.prospects.lost_90d === 1)
ok('devis : taux de transformation sur 90 jours calculé (1 accepté/transformé sur 2 décidés)', Number(dc.quotes.conversion_rate) === 50, String(dc.quotes.conversion_rate))
ok('12 mois de facturation, top clients (Bragard en tête)', df.invoices.by_month.length === 12 && df.invoices.top_clients[0].name === 'Bragard Workwear')
await rejects('tableau de bord refusé sans aucun droit commercial', async () => { const nobody = await mkUser('nobody@x.com', null); await as(nobody, () => rpc('commercial_dashboard')) }, 'RBAC_FORBIDDEN')

// --- 9. Droits de lecture, isolation, historique ---------------------------------------------------------------------------------------------
ok('lecture : factures et avoirs pour finance et commercial (invoices.read), pas pour la production', (await as(fin, () => q(`select id from invoices`))).length > 0 && (await as(comm, () => q(`select id from invoices`))).length > 0 && (await as(prod, () => q(`select id from invoices`))).length === 0)
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
await db.query(`insert into prospects(company_id, code, company_name) values ($1,'PRO-9001','Étranger')`, [co2])
ok('isolation entre sociétés', (await as(admin, () => q(`select id from prospects where code='PRO-9001'`))).length === 0)
const h = await q(`select action from audit_logs where entity_type in ('prospect','quote','invoice','credit_note','order')`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['prospect.create', 'prospect.stage', 'prospect.convert', 'quote.create', 'quote.send', 'quote.accept', 'quote.reject', 'quote.cancel', 'quote.convert', 'order.create', 'order.confirm', 'invoice.create', 'invoice.issue', 'invoice.cancel', 'invoice.payment', 'credit_note.create', 'credit_note.issue'])
  ok(`historique : ${a}`, acts.has(a))
ok('historique lisible selon les droits (finance : factures oui, prospects non)', (await as(fin, () => q(`select id from audit_logs where entity_type='invoice'`))).length > 0 && (await as(fin, () => q(`select id from audit_logs where entity_type='prospect'`))).length === 0 && (await as(comm, () => q(`select id from audit_logs where entity_type='prospect'`))).length > 0)

process.exit(process.exitCode ?? 0)
