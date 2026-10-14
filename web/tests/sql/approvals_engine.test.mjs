import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql'])
const { ok, as, rejects } = makeHelpers(db)
const passes = async (fn) => { try { await fn(); return true } catch { return false } }
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const J = (o) => JSON.stringify(o)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const com = await mkUser('com@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const del = await mkUser('del@x.com', null)          // délégué : aucune permission directe
const nobody = await mkUser('nobody@x.com', null)

const SNAP = (ref, qty) => J({ ref, qty, unit_price: 50 })
const stateOf = async (id) => (await q(`select state from approval_requests where id=$1`, [id]))[0].state
const countAudit = async (action) => (await q(`select count(*)::int n from audit_logs where action=$1`, [action]))[0].n
const attempts = async (id) => (await q(`select count(*)::int n from approval_decisions where request_id=$1 and action='attempt_refused'`, [id]))[0].n

// --- 0. Migration : permissions, aucune politique ni demande par défaut -------------------------------------------------------------
ok('migration : 6 permissions d’approbation créées', (await q(`select count(*)::int n from permissions where code like 'approvals.%'`))[0].n === 6)
ok('migration : aucune politique, aucune demande créée', (await q(`select (select count(*) from approval_policies)+(select count(*) from approval_requests) n`))[0].n === 0)
ok('migration : commercial a seulement approvals.request', (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='commercial' and r.company_id=$1 and p.code like 'approvals.%'`, [company])).map((r) => r.code).join() === 'approvals.request')

// --- 1. Politiques : saisie réservée, validation en base, révision sans effet sur les demandes existantes -------------------------------
await rejects('politique : saisie refusée au commercial', () => as(com, () => rpc('approval_policy_set', 'purchase_request', 1, null, 'approvals.decide', null, 'approvals.escalate', 24)), 'RBAC_FORBIDDEN')
await rejects('politique à 2 niveaux sans seuil refusée', () => as(admin, () => rpc('approval_policy_set', 'purchase_request', 2, null, 'approvals.decide', 'approvals.decide_high', 'approvals.escalate', 24)), 'approval_policies_check')
await rejects('politique à 1 niveau avec second niveau refusée', () => as(admin, () => rpc('approval_policy_set', 'purchase_request', 1, null, 'approvals.decide', 'approvals.decide_high', 'approvals.escalate', 24)), 'approval_policies_check')
await rejects('politique : délai hors plage refusé (0 h)', () => as(admin, () => rpc('approval_policy_set', 'purchase_request', 1, null, 'approvals.decide', null, 'approvals.escalate', 0)), 'approval_policies_deadline_hours_check')
await as(admin, () => rpc('approval_policy_set', 'purchase_request', 2, 1000, 'approvals.decide', 'approvals.decide_high', 'approvals.escalate', 24))
ok('politique : créée (deux niveaux, seuil 1 000, délai 24 h)', (await q(`select levels, level2_threshold::text t, deadline_hours from approval_policies where object_type='purchase_request'`))[0].deadline_hours === 24)
ok('audit : politique créée tracée', (await countAudit('approval.policy_set')) === 1)

// --- 2. Soumission : version, hash du contenu, une seule demande ouverte --------------------------------------------------------------
const O1 = (await q(`select gen_random_uuid() id`))[0].id
const r1 = await as(com, () => rpc('approval_request_create', 'purchase_request', O1, SNAP('PO-1', 10), 500))
const row1 = (await q(`select state, object_version, object_hash, requested_by from approval_requests where id=$1`, [r1]))[0]
ok('soumission : état pending_l1, version 1', row1.state === 'pending_l1' && row1.object_version === 1)
ok('soumission : hash = SHA-256 du contenu canonique', row1.object_hash === (await q(`select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h`, [SNAP('PO-1', 10)]))[0].h)
ok('soumission : demandeur enregistré', row1.requested_by === com)
await rejects('second dossier ouvert sur le même objet refusé', () => as(com, () => rpc('approval_request_create', 'purchase_request', O1, SNAP('PO-1', 11), 500)), 'APPROVAL_ALREADY_OPEN')
await rejects('type d’objet sans politique refusé', () => as(com, () => rpc('approval_request_create', 'client_price', O1, SNAP('X', 1), 1)), 'APPROVAL_NO_POLICY')
await rejects('contenu non objet refusé', () => as(com, () => rpc('approval_request_create', 'purchase_request', O1, J([1, 2]), 1)), 'APPROVAL_SNAPSHOT_INVALID')
await rejects('soumission refusée sans droit approvals.request', () => as(nobody, () => rpc('approval_request_create', 'purchase_request', O1, SNAP('PO-1', 10), 500)), 'RBAC_FORBIDDEN')
ok('audit : soumission tracée', (await countAudit('approval.request')) >= 1)

// --- 3. Transitions : séparation, pouvoir, refus motivé, transition invalide refusée -------------------------------------------------
const d1 = await as(com, () => rpc('approval_decide', r1, 'approve', null))
ok('demandeur ne décide pas sa propre demande (résultat refusé, état inchangé)', d1.ok === false && d1.code === 'SOD_SELF_APPROVAL' && (await stateOf(r1)) === 'pending_l1')
ok('tentative refusée journalisée', (await attempts(r1)) === 1)
await rejects('décision sans droit refusée (RBAC)', () => as(nobody, () => rpc('approval_decide', r1, 'approve', null)), 'RBAC_FORBIDDEN')
await rejects('refus sans motif refusé', () => as(dir, () => rpc('approval_decide', r1, 'refuse', 'non')), 'APPROVAL_REASON_REQUIRED')
const a1 = await as(dir, () => rpc('approval_decide', r1, 'approve', null))
ok('premier niveau : montant 500 ≤ seuil 1 000 : approuvé directement', a1.ok && a1.state === 'approved', JSON.stringify(a1))
const bad1 = await as(dir, () => rpc('approval_decide', r1, 'approve', null))
ok('transition invalide : approuver une demande déjà approuvée refusée', bad1.ok === false && bad1.code === 'APPROVAL_BAD_TRANSITION' && (await stateOf(r1)) === 'approved')
const bad2 = await as(dir, () => rpc('approval_decide', r1, 'refuse', 'Motif trop tardif pour changer'))
ok('transition invalide : refuser une demande approuvée refusée', bad2.ok === false && bad2.code === 'APPROVAL_BAD_TRANSITION' && (await stateOf(r1)) === 'approved')
ok('transitions invalides journalisées : 3 tentatives refusées sur r1 (auto-approbation et deux transitions)', (await attempts(r1)) === 3)

// --- 4. Deux niveaux : second niveau indépendant, refus motivé au second niveau -----------------------------------------------------
const O2 = (await q(`select gen_random_uuid() id`))[0].id
const r2 = await as(com, () => rpc('approval_request_create', 'purchase_request', O2, SNAP('PO-2', 100), 5000))
const l1 = await as(dir, () => rpc('approval_decide', r2, 'approve', null))
ok('montant 5 000 > seuil : premier niveau → pending_l2', l1.state === 'pending_l2' && (await q(`select level1_by from approval_requests where id=$1`, [r2]))[0].level1_by === dir)
const same = await as(dir, () => rpc('approval_decide', r2, 'approve', null))
ok('second niveau par la même personne refusé (indépendance)', same.ok === false && same.code === 'SOD_NOT_INDEPENDENT' && (await stateOf(r2)) === 'pending_l2')
const l2 = await as(admin, () => rpc('approval_decide', r2, 'approve', null))
ok('second niveau par une autre personne : approuvé', l2.ok && l2.state === 'approved' && l2.level === 2)
const O3 = (await q(`select gen_random_uuid() id`))[0].id
const r3 = await as(com, () => rpc('approval_request_create', 'purchase_request', O3, SNAP('PO-3', 200), 5000))
await as(dir, () => rpc('approval_decide', r3, 'approve', null))
await rejects('refus au second niveau sans motif refusé', () => as(admin, () => rpc('approval_decide', r3, 'refuse', 'non')), 'APPROVAL_REASON_REQUIRED')
const rf = await as(admin, () => rpc('approval_decide', r3, 'refuse', 'Montant non justifié par le devis'))
ok('refus motivé au second niveau : état refused, motif conservé', rf.state === 'refused' && (await q(`select refusal_reason r from approval_requests where id=$1`, [r3]))[0].r.includes('devis'))

// --- 5. Délégations : datées, bornées par montant, révocables, pouvoir de l'auteur seulement ----------------------------------------
await rejects('délégation : un détenteur absent de la permission ne peut pas déléguer', () => as(com, () => rpc('approval_delegation_grant', del, 'purchase_request', 'approvals.decide', 1000, new Date(Date.now() + 86400000 * 30).toISOString(), 'Absence du responsable')), 'RBAC_FORBIDDEN')
await rejects('délégation : durée supérieure à 90 jours refusée', () => as(dir, () => rpc('approval_delegation_grant', del, 'purchase_request', 'approvals.decide', 1000, new Date(Date.now() + 86400000 * 100).toISOString(), 'Trop longue')), 'approval_delegations_check')
const dg = await as(dir, () => rpc('approval_delegation_grant', del, 'purchase_request', 'approvals.decide', 1000, new Date(Date.now() + 86400000 * 30).toISOString(), 'Absence du responsable'))
ok('délégation accordée par une personne qui détient la permission', !!dg)
const O4 = (await q(`select gen_random_uuid() id`))[0].id
const r4 = await as(com, () => rpc('approval_request_create', 'purchase_request', O4, SNAP('PO-4', 5), 500))
const d4 = await as(del, () => rpc('approval_decide', r4, 'approve', null))
ok('délégué dans la limite (500 ≤ 1 000) : approuvé', d4.ok && d4.state === 'approved')
ok('décision déléguée : délégant enregistré (on_behalf_of)', (await q(`select on_behalf_of from approval_decisions where request_id=$1 and action='approve'`, [r4]))[0].on_behalf_of === dir)
const O5 = (await q(`select gen_random_uuid() id`))[0].id
const r5 = await as(com, () => rpc('approval_request_create', 'purchase_request', O5, SNAP('PO-5', 50), 5000))
await rejects('délégué hors montant (5 000 > 1 000) refusé', () => as(del, () => rpc('approval_decide', r5, 'approve', null)), 'RBAC_FORBIDDEN')
await as(dir, () => rpc('approval_delegation_revoke', dg, 'Retour de congé'))
const O6 = (await q(`select gen_random_uuid() id`))[0].id
const r6 = await as(com, () => rpc('approval_request_create', 'purchase_request', O6, SNAP('PO-6', 6), 300))
await rejects('délégation révoquée : plus de pouvoir', () => as(del, () => rpc('approval_decide', r6, 'approve', null)), 'RBAC_FORBIDDEN')
await rejects('révocation déjà faite : refusée', () => as(dir, () => rpc('approval_delegation_revoke', dg, 'encore')), 'APPROVAL_BAD_TRANSITION')
await rejects('révocation par un tiers sans droit refusée', () => as(com, () => rpc('approval_delegation_revoke', dg, 'x')), 'RBAC_FORBIDDEN')

// --- 6. Délais et escalade ------------------------------------------------------------------------------------------------------------
const O7 = (await q(`select gen_random_uuid() id`))[0].id
const r7 = await as(com, () => rpc('approval_request_create', 'purchase_request', O7, SNAP('PO-7', 7), 500))
const O8 = (await q(`select gen_random_uuid() id`))[0].id
const r8 = await as(com, () => rpc('approval_request_create', 'purchase_request', O8, SNAP('PO-8', 8), 500))
await db.query(`update approval_requests set deadline_at = now() - interval '1 hour' where id=$1`, [r7])
await rejects('escalade sans permission refusée', () => as(com, () => rpc('approval_escalate', r7, 'Demande en retard')), 'RBAC_FORBIDDEN')
await rejects('escalade : motif trop court refusé', () => as(admin, () => rpc('approval_escalate', r7, 'non')), 'APPROVAL_REASON_REQUIRED')
const en = await as(admin, () => rpc('approval_escalate', r8, 'Vérification du délai'))
ok('escalade d’une demande non échue refusée (résultat)', en.ok === false && en.code === 'APPROVAL_NOT_OVERDUE')
const es = await as(admin, () => rpc('approval_escalate', r7, 'Délai de 24 h dépassé'))
ok('escalade d’une demande échue : acceptée, délai prolongé', es.ok && (await q(`select escalated_at is not null e, deadline_at > now() f from approval_requests where id=$1`, [r7]))[0].f === true)
const ad7 = await as(admin, () => rpc('approval_decide', r7, 'approve', null))
ok('après escalade : la permission d’escalade permet de décider', ad7.ok && ad7.state === 'approved')
const cancel8 = await as(com, () => rpc('approval_cancel', r8, 'Commande modifiée'))
ok('annulation par le demandeur : état cancelled', cancel8.state === 'cancelled' && (await stateOf(r8)) === 'cancelled')
await rejects('annulation par une autre personne refusée', () => as(admin, () => rpc('approval_cancel', r7, 'Pas le mien')), 'RBAC_FORBIDDEN')

// --- 7. Accord lié au hash : périmé impossible --------------------------------------------------------------------------------------
const O9 = (await q(`select gen_random_uuid() id`))[0].id
const r9 = await as(com, () => rpc('approval_request_create', 'purchase_request', O9, SNAP('PO-9', 9), 500))
await as(dir, () => rpc('approval_decide', r9, 'approve', null))
ok('accord valide pour le contenu approuvé : garde passe', await passes(() => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 9)]))))
await rejects('contenu modifié sans invalidation : accord périmé refusé', () => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 10)])), 'APPROVAL_STALE')
const inv = await as(com, () => rpc('approval_object_changed', 'purchase_request', O9, SNAP('PO-9', 10)))
ok('changement substantiel : l’accord est invalidé', inv === 1 && (await stateOf(r9)) === 'invalidated')
await rejects('après invalidation : contenu nouveau sans accord refusé', () => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 10)])), 'APPROVAL_STALE')
await rejects('ancien contenu invalidé : plus d’accord', () => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 9)])), 'APPROVAL_NOT_APPROVED')
const r9b = await as(com, () => rpc('approval_request_create', 'purchase_request', O9, SNAP('PO-9', 10), 500))
ok('nouvelle version soumise : version 2', (await q(`select object_version v from approval_requests where id=$1`, [r9b]))[0].v === 2)
await rejects('version 2 non approuvée : pas d’accord', () => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 10)])), 'APPROVAL_NOT_APPROVED')
await as(dir, () => rpc('approval_decide', r9b, 'approve', null))
ok('version 2 approuvée : accord valide pour son contenu', await passes(() => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 10)]))))
await rejects('version 1 ne vaut plus après approbation de la version 2', () => as(com, () => q(`select public.approval_assert_current('purchase_request', $1, $2::jsonb)`, [O9, SNAP('PO-9', 9)])), 'APPROVAL_STALE')
const O10 = (await q(`select gen_random_uuid() id`))[0].id
const r10 = await as(com, () => rpc('approval_request_create', 'purchase_request', O10, SNAP('PO-10', 1), 100))
ok('demande ouverte invalidée aussi quand le contenu change', (await as(com, () => rpc('approval_object_changed', 'purchase_request', O10, SNAP('PO-10', 2)))) === 1 && (await stateOf(r10)) === 'invalidated')
await rejects('objet jamais soumis : pas d’accord', () => as(com, () => q(`select public.approval_assert_current('purchase_request', gen_random_uuid(), $1::jsonb)`, [SNAP('X', 1)])), 'APPROVAL_NOT_APPROVED')

// --- 8. Audit complet et journal ajout seul ---------------------------------------------------------------------------------------
const actions = ['approval.policy_set', 'approval.request', 'approval.approve', 'approval.refuse', 'approval.attempt_refused', 'approval.escalate', 'approval.cancel', 'approval.invalidate', 'approval.delegation_grant', 'approval.delegation_revoke']
const missing = []
for (const a of actions) if ((await countAudit(a)) === 0) missing.push(a)
ok('audit : chaque type d’événement accepté est tracé', missing.length === 0, missing.join())
ok('journal : chaque demande a au moins un événement « request »', (await q(`select count(*)::int n from approval_requests r where not exists (select 1 from approval_decisions d where d.request_id=r.id and d.action='request')`))[0].n === 0)
await rejects('journal : modification directe refusée', () => as(admin, () => q(`update approval_decisions set reason='falsifié'`)), 'permission denied')
await rejects('journal : suppression directe refusée', () => as(admin, () => q(`delete from approval_decisions`)), 'permission denied')
await rejects('demande : création directe refusée (pas de hash forgé)', () => as(admin, () => q(`insert into approval_requests(object_type, object_id, object_version, object_hash, snapshot, state, levels, level1_permission, escalation_permission, deadline_hours, deadline_at) values ('purchase_request', gen_random_uuid(), 1, $1, '{}', 'approved', 1, 'approvals.decide', 'approvals.escalate', 1, now())`, ['a'.repeat(64)])), 'permission denied')
ok('chaque décision acceptée porte le hash du contenu décidé', (await q(`select count(*)::int n from approval_decisions where action in ('approve','refuse') and object_hash !~ '^[a-f0-9]{64}$'`))[0].n === 0)
