import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql','0044_events_notifications.sql','0045_api_idempotency.sql','0046_leads_qualification.sql','0047_opportunities_pipeline.sql','0048_client360_activities.sql','0049_quotes_pricing_versions.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => (await q(sql, params))[0].n
const sql = (s, p) => db.query(s, p).then((r) => r.rows)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('com@x.com', 'commercial')
const dir = await mkUser('dir@x.com', 'direction')        // premier niveau d'approbation
const fin = await mkUser('fin@x.com', 'finance')          // valide la remise signée
const nobody = await mkUser('nobody@x.com', null)

// --- Fixtures -------------------------------------------------------------------------------------------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client devis 360','TN','TND') returning id`)))[0].id
const cl2 = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Autre client devis','TN','TND') returning id`)))[0].id
const pm = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste devis','jacket') returning id`, [cl])))[0].id
const jau = (await q(`select id from colors where code='JAU'`))[0].id
const sS = (await q(`select id from sizes where code='S'`))[0].id
const sM = (await q(`select id from sizes where code='M'`))[0].id
const variant = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'QDV-JAU-S') returning id`, [pm, jau, sS])))[0].id
const variantM = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'QDV-JAU-M') returning id`, [pm, jau, sM])))[0].id
const pmOther = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste autre','jacket') returning id`, [cl2])))[0].id
const variantOther = (await as(admin, () => q(`insert into product_variants(product_id, color_id, size_id, sku) values ($1,$2,$3,'QDO-JAU-S') returning id`, [pmOther, jau, sS])))[0].id

await as(fin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))   // taux de TVA signé (règle P017)
// Remise signée : plafond 5 % pour le client (saisie par le commercial, validée par la finance)
const dRule = await as(comm, () => rpc('client_discount_set', cl, 5, '2026-01-01', null))
await as(fin, () => rpc('price_validate', 'discount', dRule, true))
// Politique d'approbation « devis » (configurée par l'administrateur ; aucune par défaut)
await as(admin, () => rpc('approval_policy_set', 'quote', 1, null, 'approvals.decide', null, 'approvals.escalate', 24))

const newQuote = (client, o = {}) => as(comm, () => q(`insert into quotes(client_id, tax_rate, payment_terms, lead_days) values ($1, 19, '30 jours', $2) returning *`, [client, o.lead ?? 30]))
const addLine = (quote, o) => db.query(`insert into quote_lines(quote_id, pos, description, qty, unit_price, discount_pct, variant_id, customization) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
  [quote, o.pos ?? 1, o.desc ?? 'Veste', o.qty ?? 1, o.price ?? 10, o.disc ?? 0, o.variant ?? null, o.custom ?? null]).then((r) => r.rows[0].id)
const asLine = (u, quote, o) => as(u, () => q(`insert into quote_lines(quote_id, pos, description, qty, unit_price, discount_pct, variant_id, customization) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
  [quote, o.pos ?? 1, o.desc ?? 'Veste', o.qty ?? 1, o.price ?? 10, o.disc ?? 0, o.variant ?? null, o.custom ?? null]))
const quoteRow = async (id) => (await q(`select * from quotes where id=$1`, [id]))[0]

// --- 1. Totaux exacts (règle : ligne arrondie à 2 décimales, TVA arrondie à 2 décimales) ---------------------------------------
const QT = (await newQuote(cl))[0].id
await asLine(comm, QT, { pos: 1, desc: 'Veste HV', qty: 3, price: 33.333, disc: 10, variant: variant, custom: 'Logo brodé poitrine' })
await asLine(comm, QT, { pos: 2, desc: 'Pantalon', qty: 2, price: 50, disc: 0, variant: variantM })
const qt = await quoteRow(QT)
// ligne 1 : 3 × 33,333 × 0,90 = 89,9991 → 90,00 ; ligne 2 : 2 × 50 = 100,00 ; sous-total 190,00 ; TVA 19 % = 36,10 ; total 226,10
ok('total exact : sous-total 190,00 (90,00 + 100,00)', Number(qt.subtotal) === 190)
ok('total exact : TVA 36,10 (19 % de 190,00)', Number(qt.tax_amount) === 36.1)
ok('total exact : total 226,10', Number(qt.total) === 226.1, JSON.stringify(qt))
const lines = await q(`select pos, sku_v, qty from (select l.pos, v.sku as sku_v, l.qty from quote_lines l left join product_variants v on v.id=l.variant_id where l.quote_id=$1) x order by pos`, [QT])
ok('SKU et tailles sur les lignes : QDV-JAU-S et QDV-JAU-M', lines[0].sku_v === 'QDV-JAU-S' && lines[1].sku_v === 'QDV-JAU-M', JSON.stringify(lines))
await rejects('variante d’un autre client refusée sur le devis', () => asLine(comm, QT, { pos: 3, desc: 'Autre', variant: variantOther }), 'QUOTE_BAD_VARIANT')
ok('instantané du devis : lignes avec SKU et personnalisation', (await as(comm, () => q(`select public.quote_document($1, null)::text s`, [QT])))[0].s.includes('Logo brodé'))

// --- 2. Remise bloquée hors seuil : envoi et acceptation impossibles sans accord valide -------------------------------------
const QR = (await newQuote(cl))[0].id
await asLine(comm, QR, { pos: 1, desc: 'Veste remise forte', qty: 1, price: 100, disc: 10, variant: variant })
ok('remise 10 % au-dessus du plafond 5 % : devis marqué « accord requis »', (await quoteRow(QR)).requires_approval === true)
await rejects('envoi bloqué sans accord (remise hors seuil)', () => as(comm, () => rpc('quote_send', QR)), 'QUOTE_APPROVAL_REQUIRED')
await rejects('demande d’accord par un utilisateur sans droit refusée', () => as(nobody, () => rpc('quote_request_approval', QR)), 'RBAC_FORBIDDEN')
const req1 = await as(comm, () => rpc('quote_request_approval', QR))
ok('demande d’accord soumise au moteur d’approbation (identifiant renvoyé)', !!req1)
await rejects('envoi encore bloqué : demande en attente, non approuvée', () => as(comm, () => rpc('quote_send', QR)), 'QUOTE_APPROVAL_REQUIRED')
const self1 = await as(comm, () => rpc('approval_decide', req1, 'approve', null))
ok('auto-approbation du demandeur refusée (résultat, tentative journalisée)', self1.ok === false && self1.code === 'SOD_SELF_APPROVAL')
const ap1 = await as(dir, () => rpc('approval_decide', req1, 'approve', null))
ok('approbation par la direction : accord valide', ap1.ok === true && ap1.state === 'approved', JSON.stringify(ap1))
await as(comm, () => rpc('quote_send', QR))
ok('après accord valide : devis envoyé', (await quoteRow(QR)).status === 'sent')

// Remise dans le plafond : aucun accord nécessaire
const QS = (await newQuote(cl))[0].id
await asLine(comm, QS, { pos: 1, desc: 'Veste dans le plafond', qty: 1, price: 100, disc: 5, variant: variant })
ok('remise 5 % (plafond) : aucun accord requis', (await quoteRow(QS)).requires_approval === false)
await as(comm, () => rpc('quote_send', QS))
ok('remise dans le plafond : envoi direct', (await quoteRow(QS)).status === 'sent')

// Accord périmé : modification d'une ligne après approbation → accord invalide, nouvelle demande nécessaire
const QP = (await newQuote(cl))[0].id
const lineP = await asLine(comm, QP, { pos: 1, desc: 'Veste à modifier', qty: 1, price: 100, disc: 10, variant: variant })
const reqP = await as(comm, () => rpc('quote_request_approval', QP))
await as(dir, () => rpc('approval_decide', reqP, 'approve', null))
await as(comm, () => db.query(`update quote_lines set discount_pct = 8 where id = $1`, [lineP[0].id]))
await rejects('accord périmé après modification du contenu : envoi refusé', () => as(comm, () => rpc('quote_send', QP)), 'QUOTE_APPROVAL_REQUIRED')
const reqP2 = await as(comm, () => rpc('quote_request_approval', QP))
await as(dir, () => rpc('approval_decide', reqP2, 'approve', null))
await as(comm, () => rpc('quote_send', QP))
ok('nouvel accord pour le nouveau contenu : envoi possible', (await quoteRow(QP)).status === 'sent')

// --- 3. Versions : envoi et acceptation tracés ; modification après accord = nouvelle version -----------------------------------
const QV = (await newQuote(cl))[0].id
await asLine(comm, QV, { pos: 1, desc: 'Veste version', qty: 2, price: 40, disc: 0, variant: variant })
await as(comm, () => rpc('quote_send', QV))
await as(comm, () => rpc('quote_decide', QV, true, null))
ok('acceptation : statut accepté, deux versions historisées (envoi, acceptation)', (await quoteRow(QV)).status === 'accepted' && (await count(`select count(*)::int n from quote_versions where quote_id=$1`, [QV])) === 2)
ok('versions : empreinte SHA-256 et contenu conservés', (await q(`select bool_and(content_hash ~ '^[a-f0-9]{64}$') ok from quote_versions where quote_id=$1`, [QV]))[0].ok === true)
await rejects('devis accepté : modification de ligne refusée (verrou)', () => asLine(comm, QV, { pos: 2, desc: 'Ajout interdit', qty: 1, price: 1 }), 'COMMERCIAL_LOCKED')
await rejects('historique des versions : modification refusée', () => db.query(`update quote_versions set snapshot='{}'::jsonb`), 'APPEND_ONLY')
const rev = await as(comm, () => rpc('quote_revise', QV))
const rv = await quoteRow(rev)
const ov = await quoteRow(QV)
ok('révision : nouvelle version (numéro 2) de la même famille, brouillon', rv.version_no === 2 && rv.family_id === ov.family_id && rv.status === 'draft')
ok('révision : ancienne version marquée remplacée, liée à la nouvelle', ov.status === 'superseded' && ov.superseded_by === rev)
ok('révision : lignes et SKU recopiés à l’identique', (await count(`select count(*)::int n from quote_lines l join quote_lines o on o.pos=l.pos where l.quote_id=$1 and o.quote_id=$2 and l.variant_id=o.variant_id and l.qty=o.qty and l.unit_price=o.unit_price`, [rev, QV])) === 1)
await rejects('révision d’un brouillon refusée (modifier directement)', () => as(comm, () => rpc('quote_revise', rev)), 'COMMERCIAL_BAD_STATUS')
const docOld = (await as(comm, () => q(`select public.quote_document($1, 1) d`, [QV])))[0].d
ok('PDF de la version envoyée : total historisé 80,00 + TVA 15,20 = 95,20', Number(docOld.snapshot.total) === 95.2 && docOld.label === 'sent', JSON.stringify(docOld).slice(0, 200))
const docCur = (await as(comm, () => q(`select public.quote_document($1, null) d`, [QV])))[0].d
ok('PDF courant : même total que le devis', Number(docCur.snapshot.total) === Number(ov.total))

// --- 4. Conversion unique et idempotente --------------------------------------------------------------------------------------------
const QC = (await newQuote(cl))[0].id
await asLine(comm, QC, { pos: 1, desc: 'Veste commande', qty: 3, price: 33.333, disc: 10, variant: variant })
await asLine(comm, QC, { pos: 2, desc: 'Pantalon commande', qty: 2, price: 50, disc: 0, variant: variantM })
const reqC = await as(comm, () => rpc('quote_request_approval', QC))
await as(dir, () => rpc('approval_decide', reqC, 'approve', null))
await rejects('conversion refusée tant que le devis n’est pas accepté', () => as(comm, () => rpc('quote_convert', QC, 'cle-conv-0001')), 'COMMERCIAL_BAD_STATUS')
await as(comm, () => rpc('quote_send', QC))
await rejects('conversion refusée si le devis n’est qu’envoyé', () => as(comm, () => rpc('quote_convert', QC, 'cle-conv-0001')), 'COMMERCIAL_BAD_STATUS')
await rejects('clé de conversion trop courte refusée', () => as(comm, () => rpc('quote_convert', QC, 'court')), 'QUOTE_KEY_REQUIRED')
await as(comm, () => rpc('quote_decide', QC, true, null))
const o1 = await as(comm, () => rpc('quote_convert', QC, 'cle-conv-0001'))
const o2 = await as(comm, () => rpc('quote_convert', QC, 'cle-conv-0001'))
ok('conversion : même clé relancée renvoie la même commande (idempotence)', o1 === o2)
ok('conversion : une seule commande pour ce devis', (await count(`select count(*)::int n from sales_orders where quote_id=$1`, [QC])) === 1)
const versionsSeen = (await as(comm, () => q(`select count(*)::int n from quote_versions where quote_id=$1`, [QV])))[0].n
ok('historique des versions lisible par le commercial (quotes.read)', versionsSeen >= 2, `n=${versionsSeen}`)
const versionsNobody = (await as(nobody, () => q(`select count(*)::int n from quote_versions where quote_id=$1`, [QV])))[0].n
ok('historique des versions invisible sans droit (RLS, refus par défaut)', versionsNobody === 0, `n=${versionsNobody}`)
await rejects('conversion avec une autre clé refusée (déjà convertie)', () => as(comm, () => rpc('quote_convert', QC, 'cle-autre-0002')), 'QUOTE_ALREADY_CONVERTED')
await rejects('ancienne transformation : seconde refusée', () => as(comm, () => rpc('quote_to_order', QC)), 'COMMERCIAL_BAD_STATUS')
await rejects('insertion directe de commande par un commercial refusée (droits colonnes)', () => as(comm, () => q(`insert into sales_orders(client_id, quote_id) values ($1,$2)`, [cl, QC])), 'permission denied')
await db.query(`select set_config('commercial.rpc', 'on', false)`)
await rejects('seconde commande liée au même devis refusée par l’index unique (chemin système)', () => db.query(`insert into sales_orders(company_id, client_id, quote_id) values ($1,$2,$3)`, [company, cl, QC]), 'sales_orders_quote_uq')
await db.query(`select set_config('commercial.rpc', 'off', false)`)
const oLines = await q(`select l.qty, l.unit_price, l.discount_pct, l.variant_id from sales_order_lines l where l.order_id=$1 order by l.description`, [o1])
ok('conversion sans ressaisie : lignes, prix, remises et SKU recopiés', oLines.length === 2 && oLines.some((l) => l.variant_id !== null), JSON.stringify(oLines))
const ord = (await q(`select total, subtotal, tax_amount from sales_orders where id=$1`, [o1]))[0]
ok('total de la commande identique au devis : 226,10', Number(ord.total) === 226.1 && Number(ord.subtotal) === 190, JSON.stringify(ord))
for (const a of ['quote.send', 'quote.accept', 'quote.convert', 'quote.revise']) ok(`audit : ${a} tracé`, (await count(`select count(*)::int n from audit_logs where action=$1`, [a])) >= 1)
