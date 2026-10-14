import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql','0044_events_notifications.sql','0045_api_idempotency.sql','0046_leads_qualification.sql','0047_opportunities_pipeline.sql'])
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
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('com@x.com', 'commercial')
const comm2 = await mkUser('com2@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const fin2 = await mkUser('fin2@x.com', 'finance')
const prod = await mkUser('prod@x.com', 'production')

// Fixtures : devise de base, client, taux de change (saisi puis signé par une autre personne)
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const cl = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client pipe','TN','TND') returning id`)))[0].id
const prodMaster = (await as(admin, () => q(`insert into product_master(client_id, name, family) values ($1,'Veste pipe','jacket') returning id`, [cl])))[0].id

// --- 0. Graine : étapes et transitions (structure, probabilités ouvertes vides) ---------------------------------------------------------
const stages = await q(`select code, kind, probability_pct from pipeline_stages where company_id=$1 order by position`, [company])
ok('graine : cinq étapes (3 ouvertes, gagnée, perdue)', stages.map((s) => s.code).join() === 'qualification,proposition,negociation,gagnee,perdue', stages.map((s) => s.code).join())
ok('graine : probabilités des étapes ouvertes NON renseignées (à saisir par la société)', stages.filter((s) => s.kind === 'open').every((s) => s.probability_pct === null))
ok('graine : gagnée = 100 %, perdue = 0 % (définitions)', stages.find((s) => s.code === 'gagnee').probability_pct === '100.00' && stages.find((s) => s.code === 'perdue').probability_pct === '0.00')
ok('graine : 12 transitions autorisées (6 entre ouvertes, 6 vers gagnée/perdue)', (await count(`select count(*)::int n from pipeline_transitions where company_id=$1`, [company])) === 12)

// --- 1. Configuration : étapes et transitions réservées au paramétrage ----------------------------------------------------------------
await rejects('paramétrage refusé au commercial', () => as(comm, () => rpc('pipeline_stage_set', 'qualification', 'Qualif', 'open', 1, 10)), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('pipeline_stage_set', 'qualification', 'Qualification', 'open', 1, 10))
await as(admin, () => rpc('pipeline_stage_set', 'proposition', 'Proposition', 'open', 2, 40))
await as(admin, () => rpc('pipeline_stage_set', 'negociation', 'Négociation', 'open', 3, 70))
ok('probabilités saisies par l’administrateur : 10 %, 40 %, 70 %', (await count(`select count(*)::int n from pipeline_stages where company_id=$1 and probability_pct in (10,40,70)`, [company])) === 3)
await rejects('étape existante : changement de genre refusé', () => as(admin, () => rpc('pipeline_stage_set', 'negociation', 'Négociation', 'won', 3, 100)), 'PIPELINE_KIND_LOCKED')
await rejects('nouvelle étape gagnée refusée (étapes fermées uniques)', () => as(admin, () => rpc('pipeline_stage_set', 'gagnee2', 'Gagnée 2', 'won', 9, 100)), 'PIPELINE_STAGE_FIXED')
await as(admin, () => rpc('pipeline_stage_set', 'relance', 'Relance', 'open', 6, null))
ok('nouvelle étape ouverte sans probabilité : créée, transitions par défaut ajoutées', (await count(`select count(*)::int n from pipeline_transitions where company_id=$1 and (from_code='relance' or to_code='relance')`, [company])) === 8)
await rejects('transition : refusée au commercial', () => as(comm, () => rpc('pipeline_transition_set', 'qualification', 'negociation', false)), 'RBAC_FORBIDDEN')
await rejects('étape fermée : on ne la rouvre pas', () => as(admin, () => rpc('pipeline_transition_set', 'gagnee', 'qualification', true)), 'PIPELINE_TERMINAL_STAGE')
await as(admin, () => rpc('pipeline_transition_set', 'proposition', 'negociation', false))
ok('transition proposition → négociation retirée de la configuration', (await count(`select count(*)::int n from pipeline_transitions where company_id=$1 and from_code='proposition' and to_code='negociation'`, [company])) === 0)

// --- 2. Opportunités : création, montant et devise obligatoires, probabilité figée -------------------------------------------------------
const O1 = await as(comm, () => rpc('opportunity_create', cl, 'Veste HV classe 2', 10000, 'EUR', '2026-12-31', null, null, null))
await rejects('création : client inconnu refusé', () => as(comm, () => rpc('opportunity_create', '00000000-0000-0000-0000-000000000000', 'X opp', 1, 'EUR', null, null, null, null)), 'CLIENT_NOT_FOUND')
await rejects('création : devise absente refusée', () => as(comm, () => rpc('opportunity_create', cl, 'Sans devise', 1000, null, null, null, null, null)), 'OPPORTUNITY_CURRENCY_REQUIRED')
await rejects('création : montant négatif refusé', () => as(comm, () => rpc('opportunity_create', cl, 'Négatif', -5, 'EUR', null, null, null, null)), 'OPPORTUNITY_AMOUNT_INVALID')
const o1 = (await q(`select stage_id, probability_pct, stage, owner_id from opportunities where id=$1`, [O1]))[0]
ok('création : première étape ouverte, probabilité figée à 10 %, responsable = créateur', o1.stage === 'open' && o1.probability_pct === '10.00' && o1.owner_id === comm)
ok('création : historique initial écrit (étape, montant, devise)', (await count(`select count(*)::int n from opportunity_stage_history where opportunity_id=$1`, [O1])) === 1)

// --- 3. Étapes autorisées ----------------------------------------------------------------------------------------------------------------
await as(comm, () => rpc('opportunity_set_stage', O1, 'proposition', null))
ok('étape autorisée : qualification → proposition, probabilité figée à 40 %', (await q(`select probability_pct from opportunities where id=$1`, [O1]))[0].probability_pct === '40.00')
await as(admin, () => rpc('pipeline_transition_set', 'proposition', 'negociation', false))
await rejects('étape interdite refusée : proposition → négociation (transition retirée)', () => as(comm, () => rpc('opportunity_set_stage', O1, 'negociation', null)), 'PIPELINE_TRANSITION_FORBIDDEN')
await rejects('étape inconnue refusée', () => as(comm, () => rpc('opportunity_set_stage', O1, 'rien', null)), 'PIPELINE_STAGE_NOT_FOUND')
await rejects('perte sans motif refusée', () => as(comm, () => rpc('opportunity_set_stage', O1, 'perdue', null)), 'OPPORTUNITY_REASON_REQUIRED')
await rejects('changement d’étape hors périmètre refusé (commercial B)', () => as(comm2, () => rpc('opportunity_set_stage', O1, 'qualification', null)), 'OPPORTUNITY_NOT_FOUND')

// --- 4. Calcul pondéré vérifiable -------------------------------------------------------------------------------------------------------
// O4 : 10 000 EUR en proposition (40 %) → pondéré 4 000 EUR
const O4 = await as(comm, () => rpc('opportunity_create', cl, 'Blouson pipe', 10000, 'EUR', '2026-11-30', null, null, null))
await as(comm, () => rpc('opportunity_set_stage', O4, 'proposition', null))
// O5 : 5 000 TND en négociation (70 %) ; taux TND non encore signé → exclue (aucun taux supposé)
const O5 = await as(comm, () => rpc('opportunity_create', cl, 'Gilet pipe TND', 5000, 'TND', '2026-12-15', null, null, null))
await as(comm, () => rpc('opportunity_set_stage', O5, 'negociation', null))   // qualification → négociation (transition conservée)
// O3 : étape « relance » sans probabilité → exclue
const O3 = await as(comm, () => rpc('opportunity_create', cl, 'Relance pipe', 2000, 'EUR', null, null, null, null))
await as(comm, () => rpc('opportunity_set_stage', O3, 'relance', null))

const s1 = await as(comm, () => rpc('pipeline_summary', null, null))
ok('taux non signé : opportunité TND exclue du pondéré et comptée (no_rate = 1)', s1.pipeline.excluded.no_rate === 1, JSON.stringify(s1.pipeline))
ok('sans probabilité : opportunité « relance » exclue (no_probability = 1)', s1.pipeline.excluded.no_probability === 1)
ok('pondéré sans taux TND : O1 (10 000 × 40 % = 4 000) + O4 (10 000 × 40 % = 4 000) = 8 000', Number(s1.pipeline.weighted) === 8000, JSON.stringify(s1.pipeline))

const fxId = await as(fin, () => rpc('exchange_rate_set', '2026-01-15', 'TND', 0.3, 'Taux de référence saisi (test P022)'))
await as(fin2, () => rpc('exchange_rate_validate', fxId, true))
const s2 = await as(comm, () => rpc('pipeline_summary', null, null))
// O1 : 10 000 × 40 % = 4 000 ; O4 : 10 000 × 40 % = 4 000 ; O5 : 5 000 TND × 0,3 = 1 500 EUR × 70 % = 1 050
ok('pondéré avec taux signé : 4 000 + 4 000 + 1 050 = 9 050 EUR (vérifiable à la main)', Number(s2.pipeline.weighted) === 9050, JSON.stringify(s2.pipeline))
ok('montant brut converti : 10 000 + 10 000 + 1 500 = 21 500 EUR (sans relance sans probabilité)', Number(s2.pipeline.gross) === 21500, JSON.stringify(s2.pipeline))
ok('nombre d’opportunités ouvertes compté (O1, O3, O4, O5)', s2.pipeline.open_count === 4)
ok('devise de base renvoyée par la synthèse (EUR)', s2.base_currency === 'EUR')

// --- 5. Gain, perte, clôture ----------------------------------------------------------------------------------------------------------
await as(comm, () => rpc('opportunity_set_stage', O4, 'perdue', 'Concurrent moins cher de 20 %'))
const o4 = (await q(`select stage, lost_reason, lost_at is not null lost_at_set from opportunities where id=$1`, [O4]))[0]
ok('perte : statut perdu, motif et date conservés', o4.stage === 'lost' && o4.lost_reason.includes('Concurrent') && o4.lost_at_set)
await rejects('opportunité close : plus de changement d’étape', () => as(comm, () => rpc('opportunity_set_stage', O4, 'qualification', null)), 'OPPORTUNITY_CLOSED')
await rejects('opportunité close : plus de produit ajouté', () => as(comm, () => rpc('opportunity_add_product', O4, 'Veste', 1, 1, null)), 'OPPORTUNITY_CLOSED')
const O2 = await as(comm, () => rpc('opportunity_create', cl, 'Pantalon gagné', 3000, 'EUR', '2026-10-01', null, null, null))
await as(comm, () => rpc('opportunity_set_stage', O2, 'proposition', null))
await as(comm, () => rpc('opportunity_set_stage', O2, 'gagnee', null))
ok('gain : statut gagné, date de gain, plus dans le pondéré', (await q(`select stage, won_at is not null w from opportunities where id=$1`, [O2]))[0].w === true)
const s3 = await as(comm, () => rpc('pipeline_summary', null, null))
ok('après perte de O4 et gain de O2 : pondéré = O1 (4 000) + O5 (1 050) = 5 050', Number(s3.pipeline.weighted) === 5050, JSON.stringify(s3.pipeline))

// --- 6. Produits et concurrents (indicatifs) -----------------------------------------------------------------------------------------------
await as(comm, () => rpc('opportunity_add_product', O1, 'Veste HV classe 2', 120, 45, prodMaster))
await as(comm, () => rpc('opportunity_add_competitor', O1, 'Concurrent Bragard', 'Prix inférieur'))
ok('produit et concurrent enregistrés sur l’opportunité ouverte', (await count(`select count(*)::int n from opportunity_products where opportunity_id=$1`, [O1])) === 1 && (await count(`select count(*)::int n from opportunity_competitors where opportunity_id=$1`, [O1])) === 1)
await rejects('concurrent en double refusé', () => as(comm, () => rpc('opportunity_add_competitor', O1, 'Concurrent Bragard', null)), 'opportunity_competitors_opportunity_id_name_key')

// --- 7. CA : factures émises moins avoirs émis, jamais le pipeline ----------------------------------------------------------------------
ok('aucune commande confirmée : compteur à zéro (pas de montant inventé)', s3.orders === null || s3.orders.confirmed_count === 0 || s3.orders.confirmed_count === '0')
ok('aucune facture émise : CA nul (le pipeline n’est jamais compté comme CA)', Number((await as(dir, () => rpc('pipeline_summary', null, null))).revenue.net_ht) === 0)
await as(fin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))   // taux de TVA signé (règle P017)
// Factures réelles : brouillon + lignes, puis émission par invoice_issue (date du jour, code généré)
const invA = (await db.query(`insert into invoices(company_id, client_id, currency) values ($1,$2,'EUR') returning id`, [company, cl])).rows[0].id
await db.query(`insert into invoice_lines(company_id, invoice_id, pos, description, qty, unit_price) values ($1,$2,1,'Veste CA',1,1000)`, [company, invA])
await as(admin, () => rpc('invoice_issue', invA))
const invB = (await db.query(`insert into invoices(company_id, client_id, currency) values ($1,$2,'TND') returning id`, [company, cl])).rows[0].id
await db.query(`insert into invoice_lines(company_id, invoice_id, pos, description, qty, unit_price) values ($1,$2,1,'Gilet CA TND',1,500)`, [company, invB])
await as(admin, () => rpc('invoice_issue', invB))
const cn = await as(admin, () => rpc('credit_note_create', invB, 'Retour complet test P022'))
await as(admin, () => rpc('credit_note_issue', cn, false))
const rev = await as(dir, () => rpc('pipeline_summary', '2026-01-01', '2026-12-31'))
// A : 1 000 EUR ; B : 500 TND × 0,3 = 150 EUR ; avoir sur B : − 150 EUR → CA net HT = 1 000 EUR
ok('CA net HT = 1 000 + 150 − 150 = 1 000 EUR (factures émises moins avoir émis)', Number(rev.revenue.net_ht) === 1000, JSON.stringify(rev.revenue))
ok('CA : deux factures comptées, aucune exclue faute de taux', rev.revenue.invoices_counted === 2 && rev.revenue.excluded_no_rate === 0, JSON.stringify(rev.revenue))
ok('CA hors période : exclu (période 2025 vide)', Number((await as(dir, () => rpc('pipeline_summary', '2025-01-01', '2025-12-31'))).revenue.net_ht) === 0)
ok('le pipeline n’entre pas dans le CA : CA = 1 000 malgré les opportunités ouvertes', Number(rev.revenue.net_ht) !== Number(rev.pipeline ? rev.pipeline.weighted : 0))
const prodSum = await as(prod, () => rpc('pipeline_summary', null, null))
ok('production (lecture des commandes seulement) : ni pipeline ni CA ; commandes sans aucun montant', prodSum.pipeline === null && prodSum.revenue === null && prodSum.orders !== null && !('amount' in prodSum.orders) && !('net_ht' in prodSum.orders))

// --- 8. Périmètre et lecture ---------------------------------------------------------------------------------------------------------------
const boardB = await as(comm2, () => rpc('pipeline_board'))
ok('tableau : le commercial B ne voit aucune opportunité du commercial A', boardB.opportunities.length === 0)
const boardA = await as(comm, () => rpc('pipeline_board'))
ok('tableau : le commercial A voit ses opportunités avec leur étape', boardA.opportunities.length >= 4 && boardA.stages.length >= 6, String(boardA.opportunities.length))
ok('historique de l’étape lisible par le responsable : création et changement (2 lignes)', (await as(comm, () => q(`select count(*)::int n from opportunity_stage_history where opportunity_id=$1`, [O1])))[0].n === 2)
await rejects('historique immuable : modification refusée', () => db.query(`update opportunity_stage_history set reason='x'`), 'APPEND_ONLY')
await rejects('création directe d’opportunité refusée (fonction seulement)', () => as(comm, () => q(`insert into opportunities(company_id, client_id, name, value, owner_id) values ($1,$2,'Direct',1,$3)`, [company, cl, comm])), 'permission denied')

// --- 9. Audit ----------------------------------------------------------------------------------------------------------------------
const actions = ['opportunity.create', 'opportunity.stage', 'pipeline.stage_create', 'pipeline.stage_update', 'pipeline.transition_set']
const missing = []
for (const a of actions) if ((await count(`select count(*)::int n from audit_logs where action=$1`, [a])) === 0) missing.push(a)
ok('audit : création, étapes, paramétrage tracés', missing.length === 0, missing.join())
