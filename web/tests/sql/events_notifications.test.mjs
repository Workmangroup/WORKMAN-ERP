import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql','0043_approvals_engine.sql','0044_events_notifications.sql','0045_api_idempotency.sql'])
const { ok, as, rejects } = makeHelpers(db)
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
const admin = await mkUser('admin@x.com', 'admin')     // détient decide, decide_high, escalate, replay, external
const dir = await mkUser('dir@x.com', 'direction')     // détient decide, decide_high, escalate ; pas replay
const com = await mkUser('com@x.com', 'commercial')    // demandeur seulement
const nobody = await mkUser('nobody@x.com', null)

const count = async (sql, params) => (await q(sql, params))[0].n
const outboxCount = () => count(`select count(*)::int n from event_outbox`)
const notifCount = (uid) => count(`select count(*)::int n from notifications where recipient_id=$1`, [uid])

// --- 0. Migration ----------------------------------------------------------------------------------------------------------------------
ok('migration : 3 permissions d’événements et canaux créées', (await count(`select count(*)::int n from permissions where code in ('events.read','events.replay','notifications.external')`)) === 3)
ok('migration : consommateur notify_internal enregistré', (await count(`select count(*)::int n from event_consumers where name='notify_internal' and enabled`)) === 1)
ok('migration : aucun canal externe actif par défaut', (await count(`select count(*)::int n from notification_channels where enabled`)) === 0)
ok('migration : outbox vide à l’installation', (await outboxCount()) === 0)

// --- 1. Politique d'approbation et demande : l'événement est écrit dans la même transaction ----------------------------------------
await as(admin, () => rpc('approval_policy_set', 'purchase_request', 2, 1000, 'approvals.decide', 'approvals.decide_high', 'approvals.escalate', 24))
const O1 = (await q(`select gen_random_uuid() id`))[0].id
const r1 = await as(com, () => rpc('approval_request_create', 'purchase_request', O1, J({ ref: 'PO-1', qty: 10 }), 5000))
ok('demande créée : un événement approval.request dans l’outbox', (await count(`select count(*)::int n from event_outbox where event_type='approval.request' and aggregate_id=$1`, [r1])) === 1)
ok('chaque décision d’approbation produit un événement (même nombre)', (await count(`select count(*)::int n from approval_decisions`)) === (await count(`select count(*)::int n from event_outbox where aggregate_type='approval_request'`)))

// Outbox : un échec de la transaction métier n'écrit aucun événement
const before = await outboxCount()
await rejects('décision par une personne sans droit : refusée', () => as(nobody, () => rpc('approval_decide', r1, 'approve', null)), 'RBAC_FORBIDDEN')
ok('échec de la transaction métier : aucun événement écrit (outbox après commit)', (await outboxCount()) === before)
const self = await as(com, () => rpc('approval_decide', r1, 'approve', null))
ok('tentative d’auto-approbation : résultat refusé, événement de tentative journalisé', self.ok === false && (await count(`select count(*)::int n from event_outbox where event_type='approval.attempt_refused'`)) === 1)

// --- 2. Répétition sans doublon côté producteur ---------------------------------------------------------------------------------------
const key = 'approval_decision:test-repeat-1'
const co = company
const ea = (await db.query(`select private.event_emit($1::uuid, 'test.repeat', 'probe', '1', $2, '{"n":1}'::jsonb) id`, [co, key])).rows[0].id
const eb = (await db.query(`select private.event_emit($1::uuid, 'test.repeat', 'probe', '1', $2, '{"n":2}'::jsonb) id`, [co, key])).rows[0].id
ok('même clé d’idempotence : même événement, pas de doublon', ea === eb && (await count(`select count(*)::int n from event_outbox where idempotency_key=$1`, [key])) === 1)

// --- 3. Consommateurs : notifications internes dédupliquées ------------------------------------------------------------------------------
const d1 = await as(admin, () => rpc('event_dispatch', 500))
ok('traitement : événements traités sans échec', d1.failed === 0 && d1.dead === 0 && d1.done >= 1, JSON.stringify(d1))
ok('demande à approuver : notification à chaque détenteur du premier niveau (admin et direction)', (await notifCount(admin)) >= 1 && (await notifCount(dir)) >= 1)
ok('le demandeur ne reçoit pas la demande à traiter', (await count(`select count(*)::int n from notifications where recipient_id=$1 and kind='approval_todo'`, [com])) === 0)
const before2 = { a: await notifCount(admin), d: await notifCount(dir) }
const d2 = await as(admin, () => rpc('event_dispatch', 500))
ok('répétition du traitement : aucun traitement nouveau, aucune notification en double', d2.done === 0 && (await notifCount(admin)) === before2.a && (await notifCount(dir)) === before2.d, JSON.stringify(d2))
const firstReq = (await q(`select id from event_outbox where event_type='approval.request' limit 1`))[0].id
ok('répétition : un consommateur déjà traité renvoie already_done', (await as(admin, () => rpc('event_process', firstReq, 'notify_internal'))) === 'already_done')

// Second niveau : notifications aux détenteurs du second niveau, hors premier niveau
const dec = await as(dir, () => rpc('approval_decide', r1, 'approve', null))
ok('premier niveau de 5 000 > seuil : pending_l2', dec.state === 'pending_l2')
await as(admin, () => rpc('event_dispatch', 500))
ok('second niveau requis : notification au détenteur du second niveau (admin), pas au premier', (await count(`select count(*)::int n from notifications where recipient_id=$1 and title like 'Second niveau%'`, [admin])) === 1 && (await count(`select count(*)::int n from notifications where recipient_id=$1 and title like 'Second niveau%'`, [dir])) === 0)

// Refus motivé : le demandeur est notifié, motif inclus
const O2 = (await q(`select gen_random_uuid() id`))[0].id
const r2 = await as(com, () => rpc('approval_request_create', 'purchase_request', O2, J({ ref: 'PO-2', qty: 3 }), 100))
await as(dir, () => rpc('approval_decide', r2, 'refuse', 'Devis non conforme au tarif'))
await as(admin, () => rpc('event_dispatch', 500))
const nRef = await q(`select title, body from notifications where recipient_id=$1 and title like 'Votre demande a été refusée%'`, [com])
ok('refus : le demandeur reçoit une seule notification, avec le motif', nRef.length === 1 && nRef[0].body.includes('tarif'), JSON.stringify(nRef))

// Confidentialité : chacun ne voit que ses notifications
const comRows = await as(com, () => q(`select recipient_id from notifications`))
ok('confidentialité : le demandeur ne voit que ses notifications', comRows.length === 1 && comRows.every((r) => r.recipient_id === com))
const adminRows = await as(admin, () => q(`select count(*)::int n from notifications where recipient_id <> $1`, [admin]))
ok('confidentialité : l’administrateur ne voit pas celles des autres', adminRows[0].n === 0)

// Lecture : propre notification seulement
const mine = (await as(com, () => q(`select id from notifications`)))[0].id
await as(com, () => rpc('notification_mark_read', mine))
ok('marquage lu de sa notification : read_at renseigné', (await count(`select count(*)::int n from notifications where id=$1 and read_at is not null`, [mine])) === 1)
const theirs = (await q(`select id from notifications where recipient_id=$1 limit 1`, [admin]))[0].id
await rejects('marquage lu d’une notification d’autrui refusé', () => as(com, () => rpc('notification_mark_read', theirs)), 'NOTIFICATION_NOT_FOUND')

// --- 4. Échec visible, réessais, état mort, replay ----------------------------------------------------------------------------------
const bad = (await db.query(`select private.event_emit($1::uuid, 'approval.approve', 'approval_request', 'bad', 'approval_decision:bad-payload-1', '{"action":"approve"}'::jsonb) id`, [co])).rows[0].id
const f1 = await as(admin, () => rpc('event_dispatch', 500))
ok('événement mal formé : échec compté, pas de traitement silencieux', f1.failed === 1, JSON.stringify(f1))
let failures = await as(admin, () => q(`select status, attempts, last_error from event_failures() where event_id=$1`, [bad]))
ok('échec visible : statut failed, une tentative, cause renseignée', failures.length === 1 && failures[0].status === 'failed' && failures[0].attempts === 1 && failures[0].last_error.includes('EVENT_PAYLOAD_INVALID'), JSON.stringify(failures))
for (let i = 0; i < 4; i++) await as(admin, () => rpc('event_dispatch', 500))
failures = await as(admin, () => q(`select status, attempts from event_failures() where event_id=$1`, [bad]))
ok('après 5 tentatives : statut dead, arrêt des réessais automatiques', failures[0].status === 'dead' && failures[0].attempts === 5, JSON.stringify(failures))
const d5 = await as(admin, () => rpc('event_dispatch', 500))
ok('événement mort : plus repris par le traitement automatique', d5.failed === 0 && d5.dead === 0)
const rep = await as(admin, () => rpc('event_replay', bad, 'notify_internal'))
ok('replay d’un événement mort : relancé, échoue de nouveau et reste visible', rep === 'failed' && (await count(`select count(*)::int n from event_deliveries where event_id=$1 and status='failed'`, [bad])) === 1)
ok('replay : tracé dans l’audit', (await count(`select count(*)::int n from audit_logs where action='event.replay'`)) >= 1)
const neverId = (await db.query(`select private.event_emit($1::uuid, 'approval.request', 'approval_request', 'never', 'approval_decision:never-1', '{"request_id":"${r2}"}'::jsonb) id`, [co])).rows[0].id
await rejects('replay d’un événement jamais traité refusé', () => as(admin, () => rpc('event_replay', neverId, 'notify_internal')), 'EVENT_NOT_FAILED')
await rejects('consommateur inconnu refusé', () => as(admin, () => rpc('event_process', bad, 'inconnu_bidule')), 'EVENT_CONSUMER_UNKNOWN')

// Droits : échecs et replay réservés
await rejects('liste des échecs refusée sans droit events.read (commercial)', () => as(com, () => q(`select * from event_failures()`)), 'RBAC_FORBIDDEN')
await rejects('replay refusé à la direction (events.replay absent)', () => as(dir, () => rpc('event_replay', bad, 'notify_internal')), 'RBAC_FORBIDDEN')
ok('direction : lecture des échecs autorisée (events.read)', (await as(dir, () => q(`select count(*)::int n from event_failures()`)))[0].n === 1)

// --- 5. Outbox immuable -------------------------------------------------------------------------------------------------------------
await rejects('outbox : modification refusée même au service (trigger)', () => db.query(`update event_outbox set payload='{}'::jsonb`), 'EVENT_OUTBOX_IMMUTABLE')
await rejects('outbox : modification directe refusée à l’utilisateur', () => as(admin, () => q(`update event_outbox set payload='{}'::jsonb`)), 'permission denied')
await rejects('notifications : création directe refusée', () => as(admin, () => q(`insert into notifications(company_id, recipient_id, dedup_key, kind, title) values ($1,$2,'manual-key-1','x','Faux')`, [co, com])), 'permission denied')

// --- 5b. Idempotence de l'API : table réservée au serveur ------------------------------------------------------------------------
await rejects('table d’idempotence : lecture refusée à l’utilisateur', () => as(admin, () => q(`select * from api_idempotency`)), 'permission denied')
ok('table d’idempotence : présente et vide au départ (serveur seulement)', (await count(`select count(*)::int n from api_idempotency`)) === 0)

// --- 6. Canaux externes : désactivés tant que non autorisés ---------------------------------------------------------------------------
ok('canal e-mail : refusé par défaut', (await as(admin, () => rpc('notification_external_allowed', 'email'))) === false)
await rejects('autorisation sans référence refusée', () => as(admin, () => rpc('notification_channel_authorize', 'email', 'x')), 'CHANNEL_AUTHORIZATION_REQUIRED')
await rejects('autorisation refusée sans droit notifications.external (direction)', () => as(dir, () => rpc('notification_channel_authorize', 'email', 'AUT-2026-001')), 'RBAC_FORBIDDEN')
await rejects('activation directe sans autorisation écrite refusée (contrainte)', () => db.query(`insert into notification_channels(company_id, channel, enabled) values ($1,'sms',true)`, [co]), 'notification_channels_check')
await as(admin, () => rpc('notification_channel_authorize', 'email', 'AUT-2026-001'))
ok('canal e-mail autorisé par écrit : porte ouverte', (await as(admin, () => rpc('notification_external_allowed', 'email'))) === true)
await as(admin, () => rpc('notification_channel_disable', 'email'))
ok('canal e-mail désactivé : porte fermée à nouveau', (await as(admin, () => rpc('notification_external_allowed', 'email'))) === false)
ok('autorisation externe tracée dans l’audit', (await count(`select count(*)::int n from audit_logs where action like 'notification.channel_%'`)) === 2)
