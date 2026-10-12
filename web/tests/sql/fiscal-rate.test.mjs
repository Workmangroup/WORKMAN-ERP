import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql', '0021_shipping.sql', '0022_finance.sql', '0027_multicurrency.sql', '0029_export_vat_rule.sql', '0030_vat_rates_versioned.sql'])
const { ok } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows

// Société en Tunisie (par défaut) : clients locaux et clients étrangers.
const company = (await q(`select id, country from companies`))[0]
let seq = 0
const mk = async (name, country, exempt = false) => (await q(
  `insert into clients(company_id, code, name, country, vat_exempt) values ($1, $2, $3, $4, $5) returning id`,
  [company.id, `CL-FISC-${++seq}`, name, country, exempt]))[0].id
const rate = async (client) => Number((await q(`select private.client_tax_rate($1) r`, [client]))[0].r)

const tn = await mk('Tunisie Textile', 'TN')
const tnExempt = await mk('Tunisie Exonere', 'TN', true)
const fr = await mk('LAFONT', 'FR')
const frExempt = await mk('Export Exonere', 'FR', true)

ok('société TN : société tunisienne', company.country === 'TN')
ok('client local TN : TVA 19 %', (await rate(tn)) === 19)
ok('client local exonéré : TVA 0 %', (await rate(tnExempt)) === 0)
ok('client FR (export) : TVA 0 %', (await rate(fr)) === 0)
ok('client FR exonéré : TVA 0 %', (await rate(frExempt)) === 0)

// Le taux figé à l'émission reprend la règle : facture pour un client export = TVA 0.
const inv = (await q(`insert into invoices(company_id, client_id, tax_rate) values ($1, $2, private.client_tax_rate($2)) returning tax_rate`, [company.id, fr]))[0]
ok('facture client export : taux de TVA repris (0)', Number(inv.tax_rate) === 0)

// Taux versionnés : un changement futur ne s'applique pas aujourd'hui.
const d = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
await db.query(`insert into vat_rates (code, label, rate, kind, country, effective_from) values ('TN_STD_21_TEST', 'Test 21 %', 21, 'standard', 'TN', $1)`, [d(30)])
ok('taux futur (21 %, effet dans 30 jours) : non appliqué aujourd’hui (19 %)', (await rate(tn)) === 19)
ok('taux à une date future : 21 %', Number((await q(`select private.vat_rate_at('standard', 'TN', $1) r`, [d(40)]))[0].r) === 21)
ok('taux à la date du jour : 19 % (version en vigueur)', Number((await q(`select private.vat_rate_at('standard', 'TN', current_date) r`))[0].r) === 19)
let missing = false
try { await db.query(`select private.vat_rate_at('reduced', 'DE', current_date)`) } catch (e) { missing = String(e.message).includes('VAT_RATE_MISSING') }
ok('taux manquant (pays sans référentiel) : opération bloquée, pas de 0 % silencieux', missing)
ok('taux 0027 : statut à valider par l’expert-comptable', (await q(`select count(*)::int n from vat_rates where code in ('TN_STD_19','EXPORT_0') and status = 'a_valider'`))[0].n === 2)

console.log(process.exitCode ? '\nÉCHEC' : '\nOK')
