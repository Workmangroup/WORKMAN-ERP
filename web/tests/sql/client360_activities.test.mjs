import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql','0044_events_notifications.sql','0045_api_idempotency.sql','0046_leads_qualification.sql','0047_opportunities_pipeline.sql','0048_client360_activities.sql'])
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
const comm = await mkUser('com@x.com', 'commercial')
const mag = await mkUser('mag@x.com', 'magasin')          // magasinier : expéditions, pas de facturation
const fin = await mkUser('fin@x.com', 'finance')          // finance : factures, pas de devis
const fin2 = await mkUser('fin2@x.com', 'finance')        // second signataire du change
const nobody = await mkUser('nobody@x.com', null)

// --- Fixtures : deux clients ; pièces réelles (factures par invoice_issue, devis, commande, réclamation, BL, BAT) ------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const cA = (await as(admin, () => q(`insert into clients(name, country, currency, email) values ('Client A 360','TN','TND','achats@clienta.tn') returning id`)))[0].id
const cB = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Client B 360','TN','TND') returning id`)))[0].id
const contactA = (await db.query(`insert into client_contacts(company_id, client_id, full_name, email) values ($1,$2,'Mme Achats A','achats@clienta.tn') returning id`, [company, cA])).rows[0].id
const contactB = (await db.query(`insert into client_contacts(company_id, client_id, full_name) values ($1,$2,'M. Bureau B') returning id`, [company, cB])).rows[0].id
await as(admin, () => db.query(`select public.vat_rate_validate('TN_STD_19', date '2000-01-01', true)`))
// Scénario : le magasinier lit la fiche client (sinon il ne voit aucune source) ; il n'a toujours ni factures ni devis ni BAT
await db.query(`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r join permissions p on p.code='clients.read' where r.code='magasin' and r.company_id=$1 on conflict do nothing`, [company])

const orderA = (await db.query(`insert into sales_orders(company_id, client_id, status) values ($1,$2,'confirmed') returning id, code`, [company, cA])).rows[0]
const orderB = (await db.query(`insert into sales_orders(company_id, client_id, status) values ($1,$2,'confirmed') returning id, code`, [company, cB])).rows[0]
const quoteA = (await as(comm, () => q(`insert into quotes(client_id, tax_rate, payment_terms, lead_days) values ($1, 19, '30 jours', 30) returning id`, [cA])))[0].id
const quoteB = (await as(comm, () => q(`insert into quotes(client_id, tax_rate, payment_terms, lead_days) values ($1, 19, '30 jours', 30) returning id`, [cB])))[0].id

const invA = (await db.query(`insert into invoices(company_id, client_id, currency) values ($1,$2,'EUR') returning id`, [company, cA])).rows[0].id
await db.query(`insert into invoice_lines(company_id, invoice_id, pos, description, qty, unit_price) values ($1,$2,1,'Veste A',1,1000)`, [company, invA])
await as(admin, () => rpc('invoice_issue', invA))
// Taux TND saisi par la finance puis signé par une autre personne (règle de change, P017)
const fxId = await as(fin, () => rpc('exchange_rate_set', '2026-01-15', 'TND', 0.3, 'Taux de référence saisi (test P023)'))
await as(fin2, () => rpc('exchange_rate_validate', fxId, true))
const invB = (await db.query(`insert into invoices(company_id, client_id, currency) values ($1,$2,'TND') returning id`, [company, cB])).rows[0].id
await db.query(`insert into invoice_lines(company_id, invoice_id, pos, description, qty, unit_price) values ($1,$2,1,'Gilet B',1,500)`, [company, invB])
await as(admin, () => rpc('invoice_issue', invB))

const complaintA = await as(comm, () => rpc('complaint_open', cA, orderA.id, 'Retard livraison client A', null, 'minor'))
const complaintB = await as(comm, () => rpc('complaint_open', cB, orderB.id, 'Erreur client B', null, 'minor'))
const wh = (await as(admin, () => q(`insert into warehouses(name, kind) values ('Magasin 360','supplies') returning id`)))[0].id
const shipA = (await db.query(`insert into shipments(company_id, number, sales_order_id, client_id, warehouse_id) values ($1,'BL-A-1',$2,$3,$4) returning id`, [company, orderA.id, cA, wh])).rows[0].id
const projA = (await db.query(`insert into development_projects(company_id, client_id, name) values ($1,$2,'Projet A 360') returning id`, [company, cA])).rows[0].id
// Fixture uniquement : le projet est mis à l'étape « BAT » par le drapeau interne du module (les étapes réelles passent par ses fonctions)
await db.query(`select set_config('dev.rpc', 'on', false)`)
await db.query(`update development_projects set stage = 'bat' where id = $1`, [projA])
await db.query(`select set_config('dev.rpc', 'off', false)`)
const batA = (await db.query(`insert into customer_validations(company_id, project_id, kind, version_no, status) values ($1,$2,'bat',1,'pending') returning id`, [company, projA])).rows[0].id

// --- 1. Visites : journal ajout seul, contact du même client -----------------------------------------------------------------------
const visit1 = await as(comm, () => rpc('client_visit_record', cA, '2026-09-15', 'visit', 'Visite atelier : nouvelle gamme de vestes', contactA))
ok('visite enregistrée et datée', !!visit1 && (await count(`select count(*)::int n from client_visits where id=$1 and visit_on='2026-09-15'`, [visit1])) === 1)
await rejects('visite avec contact d’un autre client refusée', () => as(comm, () => rpc('client_visit_record', cA, null, 'call', 'Appel test', contactB)), 'CLIENT_LINK_INVALID')
await rejects('visite : modification refusée (journal ajout seul)', () => db.query(`update client_visits set summary='falsifié'`), 'APPEND_ONLY')
await rejects('visite : suppression refusée', () => db.query(`delete from client_visits`), 'APPEND_ONLY')
await rejects('visite refusée sans droit d’écriture client (magasinier)', () => as(mag, () => rpc('client_visit_record', cA, null, 'call', 'Test droit', null)), 'RBAC_FORBIDDEN')

// --- 2. Adresses courriel autorisées : finalité, preuve, retrait tracé ------------------------------------------------------------
const mail1 = await as(comm, () => rpc('client_email_authorize', cA, 'Achats.Client@ClientA.tn', 'billing', 'Demande écrite du client mars 2026'))
ok('adresse courriel autorisée : stockée en minuscules, finalité et preuve conservées', (await count(`select count(*)::int n from client_email_channels where id=$1 and email='achats.client@clienta.tn' and purpose='billing' and withdrawn_at is null`, [mail1])) === 1)
ok('email autorisé pour la finalité : porte ouverte', (await as(comm, () => q(`select public.client_email_allowed($1,'achats.client@clienta.tn','billing') a`, [cA])))[0].a === true)
ok('même adresse, autre finalité : non autorisée', (await as(comm, () => q(`select public.client_email_allowed($1,'achats.client@clienta.tn','commercial') a`, [cA])))[0].a === false)
await rejects('autorisation sans preuve suffisante refusée', () => as(comm, () => rpc('client_email_authorize', cA, 'x@clienta.tn', 'commercial', 'ok')), 'CONSENT_PROOF_REQUIRED')
await rejects('doublon actif refusé', () => as(comm, () => rpc('client_email_authorize', cA, 'achats.client@clienta.tn', 'billing', 'Autre preuve valable')), 'CLIENT_EMAIL_ALREADY_AUTHORIZED')
await rejects('autorisation pour un client d’une autre société refusée (introuvable)', () => as(comm, () => rpc('client_email_authorize', '00000000-0000-0000-0000-000000000000', 'a@b.tn', 'billing', 'preuve valable')), 'CLIENT_NOT_FOUND')
await as(comm, () => rpc('client_email_withdraw', mail1))
ok('retrait : adresse conservée avec sa date de retrait, porte fermée', (await count(`select count(*)::int n from client_email_channels where id=$1 and withdrawn_at is not null`, [mail1])) === 1 && (await as(comm, () => q(`select public.client_email_allowed($1,'achats.client@clienta.tn','billing') a`, [cA])))[0].a === false)
await rejects('retrait déjà fait refusé', () => as(comm, () => rpc('client_email_withdraw', mail1)), 'CLIENT_EMAIL_BAD_STATUS')
await rejects('adresse autorisée : modification de l’adresse refusée', () => db.query(`update client_email_channels set email='autre@x.tn' where id=$1`, [mail1]), 'APPEND_ONLY')
await rejects('adresse autorisée : suppression refusée', () => db.query(`delete from client_email_channels where id=$1`, [mail1]), 'APPEND_ONLY')

// --- 3. Tâches liées aux pièces ORIGINALES : même client, lisibles par la personne ----------------------------------------------
const t1 = await as(comm, () => rpc('client_task_create', cA, 'Relancer le client sur la réclamation', '2026-10-20', null,
  [{ type: 'complaint', id: complaintA }, { type: 'visit', id: visit1 }, { type: 'order', id: orderA.id }]))
ok('tâche créée avec trois liens vers les pièces du client', (await count(`select count(*)::int n from client_task_links where task_id=$1`, [t1])) === 3)
await rejects('lien vers la commande d’un autre client refusé', () => as(comm, () => rpc('client_task_create', cA, 'Lien étranger', '2026-10-20', null, [{ type: 'order', id: orderB.id }])), 'CLIENT_LINK_INVALID')
// BAT d'un autre client : refusé, même pour qui peut lire les BAT (commercial)
const projB = (await db.query(`insert into development_projects(company_id, client_id, name) values ($1,$2,'Projet B 360') returning id`, [company, cB])).rows[0].id
await db.query(`select set_config('dev.rpc', 'on', false)`)
await db.query(`update development_projects set stage = 'bat' where id = $1`, [projB])
await db.query(`select set_config('dev.rpc', 'off', false)`)
const batB = (await db.query(`insert into customer_validations(company_id, project_id, kind, version_no, status) values ($1,$2,'bat',1,'pending') returning id`, [company, projB])).rows[0].id
await rejects('BAT d’un autre client refusé au lien (même lisible par le commercial)', () => as(comm, () => rpc('client_task_create', cA, 'Lien BAT B', '2026-10-20', null, [{ type: 'bat', id: batB }])), 'CLIENT_LINK_INVALID')
const batLink = await as(comm, () => rpc('client_task_create', cA, 'Valider le BAT de A', '2026-10-25', null, [{ type: 'bat', id: batA }]))
ok('BAT du même client, lisible : lien accepté', (await count(`select count(*)::int n from client_task_links where task_id=$1 and entity_type='bat'`, [batLink])) === 1)
await rejects('lien vers une pièce inexistante refusé', () => as(comm, () => rpc('client_task_create', cA, 'Lien fantôme', '2026-10-20', null, [{ type: 'quote', id: '00000000-0000-0000-0000-000000000001' }])), 'CLIENT_LINK_INVALID')
await rejects('type de lien inconnu refusé (contrainte)', () => as(comm, () => rpc('client_task_create', cA, 'Type inconnu', '2026-10-20', null, [{ type: 'secret', id: complaintA }])), 'CLIENT_LINK_INVALID')
await rejects('tâche sans échéance refusée', () => as(comm, () => rpc('client_task_create', cA, 'Sans date', null, null, [])), 'TASK_DUE_REQUIRED')
await rejects('responsable de tâche sans droit d’écriture client refusé', () => as(comm, () => rpc('client_task_create', cA, 'Responsable invalide', '2026-10-20', nobody, [])), 'TASK_OWNER_INVALID')
await as(comm, () => rpc('client_task_complete', t1))
ok('tâche terminée : statut done, liens conservés (historique)', (await count(`select count(*)::int n from client_tasks where id=$1 and status='done'`, [t1])) === 1 && (await count(`select count(*)::int n from client_task_links where task_id=$1`, [t1])) === 3)
await rejects('tâche déjà terminée : seconde clôture refusée', () => as(comm, () => rpc('client_task_complete', t1)), 'TASK_BAD_STATUS')
ok('tâches d’un client invisibles pour un utilisateur sans droit client (aucune ligne)', (await as(nobody, () => q(`select count(*)::int n from client_tasks`)))[0].n === 0)

// --- 4. Chronologie : fiche complète pour qui peut tout lire, sources étrangères et sans droit masquées ------------------------
const tlAdmin = await as(admin, () => q(`select kind, ref_id from client_timeline($1, 500)`, [cA]))
const kindsAdmin = new Set(tlAdmin.map((r) => r.kind))
ok('chronologie complète pour l’administrateur : visite, courriel, tâche, réclamation, commande, devis, facture, BL, BAT',
  ['visit', 'email_authorized', 'email_withdrawn', 'task', 'complaint', 'order', 'quote', 'invoice', 'shipment', 'bat'].every((k) => kindsAdmin.has(k)), [...kindsAdmin].join())
const foreignIds = new Set([orderB.id, quoteB, invB, complaintB])
ok('pièces étrangères masquées : aucune pièce du client B dans la chronologie du client A', tlAdmin.every((r) => !foreignIds.has(r.ref_id)))
const tlMag = await as(mag, () => q(`select kind from client_timeline($1, 500)`, [cA]))
const kindsMag = new Set(tlMag.map((r) => r.kind))
ok('magasinier : expéditions visibles, factures et devis absents (sources sans droit omises)', kindsMag.has('shipment') && !kindsMag.has('invoice') && !kindsMag.has('quote'), [...kindsMag].join())
const tlFin = await as(fin, () => q(`select kind from client_timeline($1, 500)`, [cA]))
ok('finance (factures et devis lisibles selon la matrice 0012) : les deux sources sont là', new Set(tlFin.map((r) => r.kind)).has('invoice') && new Set(tlFin.map((r) => r.kind)).has('quote'), [...new Set(tlFin.map((r) => r.kind))].join())
await rejects('chronologie refusée sans droit de lecture client', () => as(nobody, () => q(`select * from client_timeline($1, 10)`, [cA])), 'RBAC_FORBIDDEN')
ok('historique conservé : le retrait du courriel reste visible dans la chronologie', tlAdmin.some((r) => r.kind === 'email_withdrawn'))

// --- 5. Encours : TTC, par devise, sans mélange ; échu séparé ------------------------------------------------------------------------
const balA = await as(admin, () => rpc('client_balance', cA))
ok('encours A : facture 1 000 HT + TVA 19 % = 1 190 EUR ouverts, rien d’échu', balA.length === 1 && balA[0].currency === 'EUR' && Number(balA[0].open_ttc) === 1190 && Number(balA[0].overdue_ttc) === 0, JSON.stringify(balA))
await as(admin, () => rpc('invoice_record_payment', invA, 190, null, 'transfer', 'VIR-360-1'))
const balA2 = await as(admin, () => rpc('client_balance', cA))
ok('paiement partiel de 190 : encours 1 000 EUR', Number(balA2[0].open_ttc) === 1000, JSON.stringify(balA2))
const balB = await as(admin, () => rpc('client_balance', cB))
ok('encours B séparé de A, en TND (pas de mélange de devises)', balB.length === 1 && balB[0].currency === 'TND' && Number(balB[0].open_ttc) > 0, JSON.stringify(balB))
await rejects('encours refusé sans droit facturation (magasinier)', () => as(mag, () => rpc('client_balance', cA)), 'RBAC_FORBIDDEN')

// --- 6. Marge : hors du CRM ; sans costs.read, pas de marge ------------------------------------------------------------------------
const commCosts = (await as(comm, () => q(`select private.has_perm('costs.read') h`)))[0].h
const commMargin = await as(comm, () => q(`select margin from copilot_client_profit(12) where client_id=$1`, [cA]))
ok('marge : commercial (lecture CRM, sans costs.read) : marge absente', commCosts === false && (commMargin.length === 0 || commMargin[0].margin === null), JSON.stringify({ commCosts, commMargin }))
ok('marge : la finance a costs.read et voit la marge (droit séparé, non lié à la CRM)', (await as(fin, () => q(`select private.has_perm('costs.read') h`)))[0].h === true)

// --- 7. Audit ---------------------------------------------------------------------------------------------------------------------
const actions = ['client.visit_record', 'client.email_authorize', 'client.email_withdraw', 'client.task_create', 'client.task_done']
const missing = []
for (const a of actions) if ((await count(`select count(*)::int n from audit_logs where action=$1`, [a])) === 0) missing.push(a)
ok('audit : visite, courriel autorisé et retiré, tâche créée et terminée', missing.length === 0, missing.join())
