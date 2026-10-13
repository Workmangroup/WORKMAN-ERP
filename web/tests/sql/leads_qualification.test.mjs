import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql','0044_events_notifications.sql','0045_api_idempotency.sql','0046_leads_qualification.sql'])
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
const comm = await mkUser('com@x.com', 'commercial')        // commercial A
const comm2 = await mkUser('com2@x.com', 'commercial')      // commercial B
const fin = await mkUser('fin@x.com', 'finance')            // n'a pas prospects.write
const prod = await mkUser('prod@x.com', 'production')

// --- 0. Migration ------------------------------------------------------------------------------------------------------------------
ok('migration : prospects.read_all accordé à admin et direction seulement', (await count(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where p.code='prospects.read_all' and r.code in ('admin','direction')`)) === 2 && (await count(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where p.code='prospects.read_all' and r.code='commercial'`)) === 0)
ok('migration : fonction prospect_convert conservée (même signature)', (await count(`select count(*)::int n from pg_proc where proname='prospect_convert' and pronargs=1`)) === 1)

// --- 1. Scope commercial -----------------------------------------------------------------------------------------------------------
const mkP = (u, o = {}) => as(u, async () => (await q(`insert into prospects(company_name, contact_name, email, country, source, est_value, owner_id, segment) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
  [o.name ?? 'Bragard Workwear', 'Mme Durand', o.email === undefined ? 'contact@bragard.fr' : o.email, o.country === undefined ? 'TN' : o.country, o.source ?? 'trade_show', o.value ?? 50000, o.owner ?? u, o.segment ?? null]))[0])
const P1 = await mkP(comm, { segment: 'Textile professionnel' })
ok('prospect créé : code PRO, segment enregistré, responsable = créateur', P1.code.startsWith('PRO-') && P1.segment === 'Textile professionnel' && P1.owner_id === comm)
ok('scope : le commercial B ne voit pas le prospect du commercial A', (await as(comm2, () => q(`select id from prospects where id=$1`, [P1.id]))).length === 0)
ok('scope : le commercial A voit le sien ; la direction voit tout', (await as(comm, () => q(`select id from prospects where id=$1`, [P1.id]))).length === 1 && (await as(dir, () => q(`select id from prospects where id=$1`, [P1.id]))).length === 1)
await rejects('scope : étape refusée hors périmètre (introuvable)', () => as(comm2, () => rpc('prospect_set_stage', P1.id, 'contacted')), 'PROSPECT_NOT_FOUND')
await rejects('scope : création au nom d’un autre refusée', () => as(comm2, () => q(`insert into prospects(company_name, country, owner_id) values ('Autre','TN',$1)`, [comm])), 'row-level security')
await rejects('scope : modification directe hors périmètre refusée (aucune ligne)', () => as(comm2, async () => { const r = await q(`update prospects set notes='x' where id=$1 returning id`, [P1.id]); if (r.length === 0) throw new Error('row-level security: 0 rows'); }), 'row-level security')

// --- 2. Responsable : affectation contrôlée -------------------------------------------------------------------------------------------
await rejects('affectation à une personne sans prospects.write refusée', () => as(comm, () => rpc('prospect_assign', P1.id, fin)), 'PROSPECT_OWNER_INVALID')
await as(comm, () => rpc('prospect_assign', P1.id, comm2))
ok('affectation : le responsable devient le commercial B', (await q(`select owner_id from prospects where id=$1`, [P1.id]))[0].owner_id === comm2)
ok('après affectation : le commercial A ne voit plus ce prospect', (await as(comm, () => q(`select id from prospects where id=$1`, [P1.id]))).length === 0)
await rejects('affectation par un hors périmètre refusée', () => as(comm, () => rpc('prospect_assign', P1.id, comm)), 'PROSPECT_NOT_FOUND')

// --- 3. Qualification : étape « qualifié » exige les trois confirmations ---------------------------------------------------------------
await rejects('qualifié sans confirmations refusé', () => as(comm2, () => rpc('prospect_set_stage', P1.id, 'qualified')), 'PROSPECT_NOT_QUALIFIED')
await rejects('qualification incomplète refusée', () => as(comm2, () => rpc('prospect_qualify', P1.id, true, null, false, null)), 'PROSPECT_QUALIFY_INCOMPLETE')
await as(comm2, () => rpc('prospect_qualify', P1.id, true, true, false, 'Avant fin 2026'))
await rejects('décideur non confirmé : toujours pas qualifié', () => as(comm2, () => rpc('prospect_set_stage', P1.id, 'qualified')), 'PROSPECT_NOT_QUALIFIED')
await rejects('qualification par le commercial A (hors périmètre) refusée', () => as(comm, () => rpc('prospect_qualify', P1.id, true, true, true, 'x')), 'PROSPECT_NOT_FOUND')
await as(comm2, () => rpc('prospect_qualify', P1.id, true, true, true, 'Avant fin 2026'))
await as(comm2, () => rpc('prospect_set_stage', P1.id, 'qualified'))
ok('qualifié après les trois confirmations', (await q(`select stage, timeline from prospects where id=$1`, [P1.id]))[0].stage === 'qualified')

// --- 4. Consentements : journal ajout seul, dernier statut par finalité ------------------------------------------------------------------
await rejects('consentement : preuve trop courte refusée', () => as(comm2, () => rpc('prospect_consent_record', P1.id, 'commercial_prospection', 'granted', 'ok')), 'CONSENT_PROOF_REQUIRED')
ok('consentement inconnu par défaut', (await as(comm2, () => rpc('prospect_consent_status', P1.id, 'commercial_prospection'))) === 'unknown')
await as(comm2, () => rpc('prospect_consent_record', P1.id, 'commercial_prospection', 'granted', 'Formulaire salon mars 2026'))
ok('consentement accordé enregistré', (await as(comm2, () => rpc('prospect_consent_status', P1.id, 'commercial_prospection'))) === 'granted')
await as(comm2, () => rpc('prospect_consent_record', P1.id, 'commercial_prospection', 'withdrawn', 'Demande écrite du client'))
ok('retrait : le dernier statut prime, historique conservé', (await as(comm2, () => rpc('prospect_consent_status', P1.id, 'commercial_prospection'))) === 'withdrawn' && (await count(`select count(*)::int n from prospect_consents where prospect_id=$1`, [P1.id])) === 2)
await rejects('consentement : modification refusée (journal ajout seul)', () => db.query(`update prospect_consents set status='granted'`), 'APPEND_ONLY')
await rejects('consentement : hors périmètre refusé', () => as(comm, () => rpc('prospect_consent_record', P1.id, 'phone_contact', 'granted', 'appel test')), 'PROSPECT_NOT_FOUND')

// --- 5. Tâches ----------------------------------------------------------------------------------------------------------------------
const T1 = await as(comm2, () => rpc('prospect_task_create', P1.id, 'Rappeler après devis', '2026-11-15', null))
ok('tâche : responsable par défaut = responsable du prospect', (await q(`select owner_id from prospect_tasks where id=$1`, [T1]))[0].owner_id === comm2)
await rejects('tâche sans échéance refusée', () => as(comm2, () => rpc('prospect_task_create', P1.id, 'Sans date', null, null)), 'TASK_DUE_REQUIRED')
await rejects('tâche : titre trop court refusé (contrainte)', () => as(comm2, () => rpc('prospect_task_create', P1.id, 'ab', '2026-11-15', null)), 'prospect_tasks_title_check')
await rejects('tâche : responsable invalide refusé', () => as(comm2, () => rpc('prospect_task_create', P1.id, 'Relance', '2026-11-15', fin)), 'PROSPECT_OWNER_INVALID')
ok('tâche visible au responsable, pas au commercial A', (await as(comm2, () => q(`select id from prospect_tasks`))).length === 1 && (await as(comm, () => q(`select id from prospect_tasks`))).length === 0)
await rejects('tâche terminée par un hors périmètre refusée', () => as(comm, () => rpc('prospect_task_complete', T1)), 'TASK_NOT_FOUND')
await as(comm2, () => rpc('prospect_task_complete', T1))
ok('tâche terminée : statut done et date', (await q(`select status, done_at is not null d from prospect_tasks where id=$1`, [T1]))[0].status === 'done')
await rejects('tâche déjà terminée : pas de seconde fermeture', () => as(comm2, () => rpc('prospect_task_complete', T1)), 'TASK_BAD_STATUS')

// --- 6. Doublons : candidats visibles, aucune fusion automatique -----------------------------------------------------------------------
await as(admin, () => q(`insert into clients(name, country, currency, email) values ('BRAGARD WORKWEAR','TN','TND','contact@bragard.fr')`))
const P3 = await mkP(comm2, { name: 'Tissage Nord', email: 'achats@tissage.tn', value: 9000 })
const P4 = await mkP(comm, { name: 'Tissage Nord', email: 'autre@tissage.tn', value: 1000 })
const dupB = await as(comm2, () => q(`select * from prospect_duplicates($1)`, [P1.id]))
ok('doublon : client au même e-mail proposé au commercial B', dupB.some((d) => d.cand_kind === 'client' && d.cand_reason === 'e-mail identique'), JSON.stringify(dupB))
ok('doublon : le prospect de lui-même n’est jamais proposé', !dupB.some((d) => d.cand_id === P1.id))
const dupP3B = await as(comm2, () => q(`select * from prospect_duplicates($1)`, [P3.id]))
ok('doublon : le commercial B ne voit pas le prospect du commercial A (même nom)', !dupP3B.some((d) => d.cand_id === P4.id))
const dupP3Adm = await as(admin, () => q(`select * from prospect_duplicates($1)`, [P3.id]))
ok('doublon : la direction voit le prospect au même nom', dupP3Adm.some((d) => d.cand_id === P4.id && d.cand_reason === 'nom identique'))
await rejects('doublon : prospect hors périmètre introuvable', () => as(comm, () => q(`select * from prospect_duplicates($1)`, [P3.id])), 'PROSPECT_NOT_FOUND')

// --- 7. Conversion : refus si doublon sans choix explicite ------------------------------------------------------------------------
const clientsBefore = await count(`select count(*)::int n from clients`)
await rejects('conversion refusée : client au même e-mail existe (aucun doublon créé)', () => as(comm2, () => rpc('lead_convert', P1.id, null)), 'LEAD_DUPLICATE_CANDIDATE')
await rejects('conversion (ancienne fonction) : même refus', () => as(comm2, () => rpc('prospect_convert', P1.id)), 'LEAD_DUPLICATE_CANDIDATE')
ok('aucun client créé par les tentatives refusées', (await count(`select count(*)::int n from clients`)) === clientsBefore)

// --- 8. Conversion vers un client existant : aucune perte, aucun doublon ---------------------------------------------------------------
const clientC1 = (await q(`select id from clients where email='contact@bragard.fr'`))[0].id
const Q1 = (await as(comm2, () => q(`insert into quotes(prospect_id, tax_rate, payment_terms, lead_days) values ($1, 19, '30 jours', 30) returning id`, [P1.id])))[0].id
await as(comm2, () => db.query(`insert into prospect_activities(prospect_id, kind, summary) values ($1,'call','Premier appel, intéressée')`, [P1.id]))
const hist = { act: await count(`select count(*)::int n from prospect_activities where prospect_id=$1`, [P1.id]), task: await count(`select count(*)::int n from prospect_tasks where prospect_id=$1`, [P1.id]), cons: await count(`select count(*)::int n from prospect_consents where prospect_id=$1`, [P1.id]) }
const conv = await as(comm2, () => rpc('lead_convert', P1.id, clientC1))
ok('conversion vers le client existant : client lié, opportunité créée', conv.client_id === clientC1 && conv.already_converted === false && !!conv.opportunity_id, JSON.stringify(conv))
const pAfter = (await q(`select stage, converted_client_id, converted_opportunity_id from prospects where id=$1`, [P1.id]))[0]
ok('prospect : passe « gagné » avec ses liens client et opportunité', pAfter.stage === 'won' && pAfter.converted_client_id === clientC1 && pAfter.converted_opportunity_id === conv.opportunity_id)
const opp = (await q(`select client_id, prospect_id, value::text v, owner_id, stage from opportunities where id=$1`, [conv.opportunity_id]))[0]
ok('opportunité : client, prospect d’origine, valeur, responsable et étape ouverte', opp.client_id === clientC1 && opp.prospect_id === P1.id && Number(opp.v) === 50000 && opp.owner_id === comm2 && opp.stage === 'open')
const qAfter = (await q(`select client_id, prospect_id, origin_prospect_id from quotes where id=$1`, [Q1]))[0]
ok('devis : reçoit le client ; le prospect d’origine reste lié (historique, sans double rattachement)', qAfter.client_id === clientC1 && qAfter.prospect_id === null && qAfter.origin_prospect_id === P1.id)
ok('aucune perte : activités, tâches et consentements inchangés', (await count(`select count(*)::int n from prospect_activities where prospect_id=$1`, [P1.id])) === hist.act && (await count(`select count(*)::int n from prospect_tasks where prospect_id=$1`, [P1.id])) === hist.task && (await count(`select count(*)::int n from prospect_consents where prospect_id=$1`, [P1.id])) === hist.cons)
const again = await as(comm2, () => rpc('lead_convert', P1.id, clientC1))
ok('relance de conversion : mêmes identifiants, rien de nouveau', again.already_converted === true && again.opportunity_id === conv.opportunity_id)
const oppCountP1 = await count(`select count(*)::int n from opportunities where prospect_id=$1`, [P1.id])
ok('aucun doublon : une seule opportunité pour ce prospect', oppCountP1 === 1)
const again2 = await as(comm2, () => rpc('lead_convert', P1.id, null))
ok('relance sans client (même prospect converti) : pas de nouveau client', again2.already_converted === true && again2.client_id === clientC1)
await rejects('opportunité : second enregistrement pour le même prospect refusé (contrainte)', () => db.query(`insert into opportunities(company_id, client_id, prospect_id, name, value) values ($1,$2,$3,'Doublon',1)`, [company, clientC1, P1.id]), 'opportunities_company_id_prospect_id_key')

// --- 9. Conversion sans doublon : nouveau client créé une seule fois ------------------------------------------------------------------
const P5 = await mkP(comm2, { name: 'Atelier Sousse', email: 'atelier@sousse.tn', value: 12000 })
const c5 = await count(`select count(*)::int n from clients`)
const conv5 = await as(comm2, () => rpc('lead_convert', P5.id, null))
ok('conversion sans doublon : un client créé, opportunité liée', conv5.already_converted === false && (await count(`select count(*)::int n from clients`)) === c5 + 1 && (await count(`select count(*)::int n from opportunities where client_id=$1`, [conv5.client_id])) === 1)
ok('client créé : nom et e-mail repris du prospect, responsable commercial', (await q(`select name, email, sales_rep_id from clients where id=$1`, [conv5.client_id]))[0].sales_rep_id === comm2)

// --- 10. Cas refusés à la conversion ----------------------------------------------------------------------------------------------
const P6 = await mkP(comm2, { name: 'Perdu SARL', email: 'perdu@x.tn' })
await as(comm2, () => rpc('prospect_set_stage', P6.id, 'lost', 'Budget gelé'))
await rejects('prospect perdu : conversion refusée', () => as(comm2, () => rpc('lead_convert', P6.id, null)), 'PROSPECT_CLOSED')
const P7 = await mkP(comm2, { name: 'Sans pays SA', email: 'x@sanspays.tn', country: null })
await rejects('conversion sans pays refusée (fiche client)', () => as(comm2, () => rpc('lead_convert', P7.id, null)), 'PROSPECT_COUNTRY_REQUIRED')
const P8 = await mkP(comm, { name: 'Hors périmètre SA', email: 'h@p.tn' })
await rejects('conversion hors périmètre : introuvable', () => as(comm2, () => rpc('lead_convert', P8.id, null)), 'PROSPECT_NOT_FOUND')
await rejects('conversion vers un client inexistant refusée', () => as(comm2, () => rpc('lead_convert', P3.id, '00000000-0000-0000-0000-000000000000')), 'CLIENT_NOT_FOUND')

// --- 11. Ancienne conversion (même signature) : même garanties --------------------------------------------------------------------
const P9 = await mkP(comm2, { name: 'Confection Gabes', email: 'cg@gabes.tn', value: 3000 })
const legacy = await as(comm2, () => rpc('prospect_convert', P9.id))
ok('ancienne fonction conversion : renvoie le client et crée l’opportunité', !!legacy && (await count(`select count(*)::int n from opportunities where prospect_id=$1`, [P9.id])) === 1)

// --- 12. Audit ------------------------------------------------------------------------------------------------------------------------
const actions = ['prospect.assign', 'prospect.qualify', 'prospect.stage', 'prospect.consent', 'prospect.task_create', 'prospect.task_done', 'lead.convert']
const missing = []
for (const a of actions) if ((await count(`select count(*)::int n from audit_logs where action=$1`, [a])) === 0) missing.push(a)
ok('audit : chaque action du lot est tracée', missing.length === 0, missing.join())
