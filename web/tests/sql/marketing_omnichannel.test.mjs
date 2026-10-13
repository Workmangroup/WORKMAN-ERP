// Marketing et canaux omnicanaux — P026 / migration 0051 : segments, campagnes brouillons, consentements, désinscription,
// liste de suppression, webhooks idempotents, envoi refusé, coûts.
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
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('com@x.com', 'commercial')
const comm2 = await mkUser('com2@x.com', 'commercial')
const prod = await mkUser('prod@x.com', 'production')
const nobody = await mkUser('nobody@x.com', null)

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const newClient = async (name, country) => (await as(admin, () => q(`insert into clients(name, country, currency) values ($1,$2,'EUR') returning id`, [name, country])))[0].id
const A = await newClient('Client A mkt', 'TN')
const B = await newClient('Client B mkt', 'TN')   // aucun consentement
const C = await newClient('Client C mkt', 'TN')   // consentement puis désinscription
const D = await newClient('Client D mkt', 'TN')   // désinscription puis nouveau consentement (reprise)
const E = await newClient('Client E mkt', 'TN')   // SMS seulement
const F = await newClient('Client F mkt', 'TN')   // consentement, puis rebond
const H = await newClient('Client H mkt', 'FR')   // consentement, pays FR, puis plainte
const G = await newClient('Client G mkt (archivé)', 'TN')

const consent = (client, email) => as(comm, () => rpc('client_email_authorize', client, email, 'commercial', 'Formulaire web daté, case cochée'))
const consentA = await consent(A, 'a@client.test')
await consent(C, 'c@client.test')
const consentD = await consent(D, 'd@client.test')
await consent(F, 'f@client.test')
await consent(H, 'h@client.test')
await consent(G, 'g@client.test')
await as(comm, () => rpc('marketing_phone_authorize', E, 'sms', '+21620123456', 'Consentement SMS signé (test P026)'))
await db.query(`update clients set archived_at = now() where id=$1`, [G])   // archivé après consentement : exclu de l'audience

// ---------------------------------------------------------------------------------------------------------------------
// 1. Droits : refus par défaut, séparation configuration / envoi / écriture
// ---------------------------------------------------------------------------------------------------------------------
await rejects('politique d’envoi refusée au commercial (marketing.configure réservé)', () => as(comm, () => rpc('marketing_policy_set', true, ['email'], null)), 'RBAC_FORBIDDEN')
await rejects('envoi refusé à la direction (pas de marketing.send)', () => as(dir, () => rpc('marketing_campaign_send', '00000000-0000-0000-0000-000000000001')), 'RBAC_FORBIDDEN')
await rejects('modèle refusé au profil production (aucun droit marketing)', () => as(prod, () => rpc('marketing_template_create', 'email', 'Test', 'Sujet', 'Bonjour {{client}} {{desinscription}}')), 'RBAC_FORBIDDEN')
ok('segments invisibles sans droit (RLS, refus par défaut)', (await as(nobody, () => q(`select count(*)::int n from marketing_segments`)))[0].n === 0)
await rejects('écriture directe de campagne refusée', () => as(comm, () => db.query(`insert into marketing_campaigns(company_id, name, channel, template_id, body_snapshot, segment_id) values ($1,'x','email','00000000-0000-0000-0000-000000000001','x','00000000-0000-0000-0000-000000000001')`, [company])), 'permission denied')

// ---------------------------------------------------------------------------------------------------------------------
// 2. Politique d'envoi : aucun connecteur homologué
// ---------------------------------------------------------------------------------------------------------------------
await rejects('connecteur non homologué refusé', () => as(admin, () => rpc('marketing_policy_set', true, ['email'], 'brevo')), 'MARKETING_CONNECTOR_UNKNOWN')
await rejects('canal inconnu refusé dans la politique', () => as(admin, () => rpc('marketing_policy_set', true, ['fax'], null)), 'MARKETING_CHANNEL_INVALID')
await as(admin, () => rpc('marketing_policy_set', false, ['email'], null))
ok('politique enregistrée : envoi désactivé par défaut', (await q(`select send_enabled from marketing_policy where company_id=$1`, [company]))[0].send_enabled === false)

// ---------------------------------------------------------------------------------------------------------------------
// 3. Modèles : lien de désinscription obligatoire, variables bornées, approbation par une autre personne
// ---------------------------------------------------------------------------------------------------------------------
await rejects('modèle sans lien de désinscription refusé', () => as(comm, () => rpc('marketing_template_create', 'email', 'Sans désinscription', 'Sujet', 'Bonjour {{client}}, nouvelle collection disponible.')), 'MARKETING_TEMPLATE_INVALID')
await rejects('variable non autorisée refusée', () => as(comm, () => rpc('marketing_template_create', 'email', 'Variable', 'Sujet', 'Bonjour {{iban}} {{desinscription}}')), 'MARKETING_TEMPLATE_INVALID')
const T1 = await as(comm, () => rpc('marketing_template_create', 'email', 'Collection automne', 'Nouvelle collection', 'Bonjour {{client}}, découvrez la collection. Désinscription : {{desinscription}}'))
const TS = await as(comm, () => rpc('marketing_template_create', 'sms', 'SMS automne', null, 'Collection automne disponible. STOP : {{desinscription}}'))
await rejects('modèle e-mail sans sujet refusé (contrainte de table)', () => db.query(`insert into marketing_templates(company_id, channel, name, body) values ($1,'email','Sans sujet','Bonjour {{desinscription}} corps suffisant')`, [company]), 'marketing_templates_subject_chk')
await rejects('approbation par son auteur refusée (séparation des tâches)', () => as(comm, () => rpc('marketing_template_approve', T1)), 'MARKETING_SOD')
await as(comm2, () => rpc('marketing_template_approve', T1))
await as(comm2, () => rpc('marketing_template_approve', TS))
ok('modèles approuvés par une autre personne', (await count(`select count(*)::int n from marketing_templates where status='approved' and approved_by=$1`, [comm2])) === 2)
await rejects('modèle approuvé : modification refusée (verrou)', () => db.query(`update marketing_templates set body='Autre texte {{desinscription}} modifié' where id=$1`, [T1]), 'MARKETING_LOCKED')
await rejects('modèle approuvé : suppression refusée (verrou)', () => db.query(`delete from marketing_templates where id=$1`, [T1]), 'MARKETING_LOCKED')

// ---------------------------------------------------------------------------------------------------------------------
// 4. Segments et campagnes brouillons
// ---------------------------------------------------------------------------------------------------------------------
const SEG_EMAIL = await as(comm, () => rpc('marketing_segment_create', 'Tous les clients e-mail', 'email', null, null))
const SEG_TN = await as(comm, () => rpc('marketing_segment_create', 'Clients tunisiens e-mail', 'email', 'TN', null))
const SEG_SMS = await as(comm, () => rpc('marketing_segment_create', 'Clients SMS', 'sms', null, null))
await rejects('segment avec client d’une autre société refusé', () => as(comm, () => rpc('marketing_segment_create', 'Hors société', 'email', null, ['00000000-0000-0000-0000-000000000009'])), 'CLIENT_NOT_FOUND')
await rejects('campagne sur un modèle non approuvé refusée', async () => {
  const brouillon = await as(comm, () => rpc('marketing_template_create', 'email', 'Brouillon', 'Sujet', 'Bonjour {{desinscription}} brouillon'))
  return as(comm, () => rpc('marketing_campaign_create', 'Campagne brouillon', brouillon, SEG_EMAIL))
}, 'MARKETING_TEMPLATE_NOT_APPROVED')
await rejects('campagne e-mail sur un segment SMS refusée (canal)', () => as(comm, () => rpc('marketing_campaign_create', 'Mauvais canal', T1, SEG_SMS)), 'MARKETING_CHANNEL_MISMATCH')
const CAMP = await as(comm, () => rpc('marketing_campaign_create', 'Automne e-mail', T1, SEG_EMAIL))
const CAMP_SMS = await as(comm, () => rpc('marketing_campaign_create', 'Automne SMS', TS, SEG_SMS))
ok('campagne créée en brouillon, modèle figé dans la campagne', (await q(`select status, body_snapshot like '%{{desinscription}}%' as ok from marketing_campaigns where id=$1`, [CAMP]))[0].ok === true)
await rejects('campagne : nom et contenu verrouillés après création', () => db.query(`update marketing_campaigns set name='Renommée' where id=$1`, [CAMP]), 'MARKETING_LOCKED')

// ---------------------------------------------------------------------------------------------------------------------
// 5. Préparation : exclusions (aucun consentement, désinscription, liste de suppression), reprise
// ---------------------------------------------------------------------------------------------------------------------
const p1 = await as(comm, () => rpc('marketing_campaign_prepare', CAMP))
ok('préparation : A, C, D, F, H éligibles, B et E exclus sans consentement e-mail, G (archivé) hors audience', p1.eligible === 5 && p1.excluded.no_consent === 2 && !(await q(`select 1 from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, G])).length, JSON.stringify(p1))
const tokC = (await q(`select token from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, C]))[0].token
const tokD = (await q(`select token from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, D]))[0].token
ok('jeton de désinscription propre à chaque destinataire (64 caractères)', tokC.length === 64 && tokC !== tokD)
ok('jetons stables après préparation rejouée (liens déjà diffusés restent valides)', (await q(`select token from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, C]))[0].token === tokC)

// Désinscription publique (sans connexion) : réponse identique, jeton invalide sans effet
await db.query(`select public.marketing_unsubscribe($1)`, [tokC])
await db.query(`select public.marketing_unsubscribe($1)`, ['0'.repeat(64)])
await db.query(`select public.marketing_unsubscribe($1)`, ['trop-court'])
ok('jeton invalide ou court : aucune désinscription créée', (await count(`select count(*)::int n from marketing_unsubscribes where client_id in ($1,$2)`, [C, D])) === 1)
const p2 = await as(comm, () => rpc('marketing_campaign_prepare', CAMP))
ok('désinscrit exclu à la préparation suivante (C : unsubscribed)', p2.excluded.unsubscribed === 1 && (await q(`select status, reason from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, C]))[0].reason === 'unsubscribed')

// Reprise : D se désinscrit, puis donne un nouveau consentement postérieur → à nouveau éligible
await db.query(`select public.marketing_unsubscribe($1)`, [tokD])
await as(comm, () => rpc('marketing_campaign_prepare', CAMP))
ok('D désinscrit : exclu tant qu’aucun nouveau consentement n’existe', (await q(`select reason from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, D]))[0].reason === 'unsubscribed')
await as(comm, () => rpc('client_email_withdraw', consentD))
await consent(D, 'd@client.test')
const p3 = await as(comm, () => rpc('marketing_campaign_prepare', CAMP))
ok('reprise : D éligible après nouveau consentement postérieur à la désinscription', (await q(`select status from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, D]))[0].status === 'eligible')

// Liste de suppression : rebond sur F, plainte sur H (webhooks idempotents)
const ingest = (type, addr, evt, channel = 'email') => db.query(`select public.marketing_ingest_event($1,'mailtest',$2,$3,$4,$5,$6,now()) r`, [company, evt, type, channel, addr, CAMP]).then((r) => r.rows[0].r)
ok('webhook : rebond enregistré', (await ingest('bounced', 'F@client.test', 'evt-001')) === 'recorded')
ok('webhook : même événement reçu deux fois = doublon ignoré (idempotent)', (await ingest('bounced', 'f@client.test', 'evt-001')) === 'duplicate')
ok('webhook : une seule ligne d’événement pour l’identifiant reçu deux fois', (await count(`select count(*)::int n from marketing_events where provider_event_id='evt-001'`)) === 1)
ok('webhook : plainte enregistrée', (await ingest('complained', 'h@client.test', 'evt-002')) === 'recorded')
await rejects('webhook : type d’événement inconnu refusé', () => ingest('teleported', 'x@client.test', 'evt-003'), 'check')
await rejects('webhook : campagne d’une autre société refusée', () => db.query(`select public.marketing_ingest_event($1,'mailtest','evt-004','delivered','email','x@client.test','00000000-0000-0000-0000-000000000003',now())`, [company]), 'MARKETING_NOT_FOUND')
await rejects('webhook : appel direct par un utilisateur refusé (serveur uniquement)', () => as(comm, () => db.query(`select public.marketing_ingest_event($1,'mailtest','evt-005','delivered','email','x@client.test',null,now())`, [company])), 'permission denied')
const p4 = await as(comm, () => rpc('marketing_campaign_prepare', CAMP))
ok('rebond et plainte : F et H exclus (liste de suppression)', (await q(`select reason from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, F]))[0].reason === 'suppressed' && (await q(`select reason from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP, H]))[0].reason === 'suppressed')
ok('au final : seuls A et D sont éligibles, les autres sont exclus avec motif', p4.eligible === 2 && p4.excluded.unsubscribed === 1 && p4.excluded.suppressed === 2 && p4.excluded.no_consent === 2, JSON.stringify(p4))
const p5 = await as(comm, () => rpc('marketing_campaign_prepare', CAMP))
ok('reprise : la préparation rejouée donne le même résultat', p5.eligible === p4.eligible && JSON.stringify(p5.excluded) === JSON.stringify(p4.excluded))
ok('segment pays FR : seul H apparaît, avec son motif (pas de fuite vers les autres pays)', (await (async () => {
  const c = await as(comm, () => rpc('marketing_campaign_create', 'Test pays', T1, SEG_TN))
  await as(comm, () => rpc('marketing_campaign_prepare', c))
  return (await q(`select count(*)::int n from marketing_recipients where campaign_id=$1 and client_id=$2`, [c, H]))[0].n === 0
})()))

// SMS : seul E (consentement téléphone) est éligible
const ps = await as(comm, () => rpc('marketing_campaign_prepare', CAMP_SMS))
ok('SMS : seul E (consentement SMS) est éligible', ps.eligible === 1 && (await q(`select status from marketing_recipients where campaign_id=$1 and client_id=$2`, [CAMP_SMS, E]))[0].status === 'eligible')
await rejects('consentement SMS au format invalide refusé', () => as(comm, () => rpc('marketing_phone_authorize', A, 'sms', '06 12', 'Preuve valable test')), 'check')
await rejects('consentement SMS en double refusé', () => as(comm, () => rpc('marketing_phone_authorize', E, 'sms', '+21620123456', 'Preuve valable test')), 'MARKETING_CONSENT_EXISTS')

// ---------------------------------------------------------------------------------------------------------------------
// 6. Envoi : jamais réalisé ; refus journalisé ; aucun statut « envoyé »
// ---------------------------------------------------------------------------------------------------------------------
await rejects('envoi d’une campagne non préparée refusé', async () => {
  const brouillon = await as(comm, () => rpc('marketing_campaign_create', 'Non préparée', T1, SEG_EMAIL))
  return as(admin, () => rpc('marketing_campaign_send', brouillon))
}, 'MARKETING_NOT_PREPARED')
const refus = await as(admin, () => rpc('marketing_campaign_send', CAMP))
ok('envoi demandé : refusé (aucun connecteur, politique désactivée)', refus.sent === false && refus.reason === 'POLICY_DISABLED', JSON.stringify(refus))
await as(admin, () => rpc('marketing_policy_set', true, ['email'], null))
const refus2 = await as(admin, () => rpc('marketing_campaign_send', CAMP))
ok('politique activée sans connecteur : toujours refusé (NO_CONNECTOR)', refus2.sent === false && refus2.reason === 'NO_CONNECTOR', JSON.stringify(refus2))
await as(admin, () => rpc('marketing_policy_set', false, ['email'], null))
ok('aucun destinataire n’a le statut « envoyé » (statut absent du modèle)', (await count(`select count(*)::int n from marketing_recipients where status not in ('eligible','excluded')`)) === 0)
ok('campagne toujours « préparée » après refus (pas de statut envoyé)', (await q(`select status from marketing_campaigns where id=$1`, [CAMP]))[0].status === 'prepared')
ok('audit : refus d’envoi journalisé', (await count(`select count(*)::int n from audit_logs where action='marketing.send_refused' and entity_id=$1`, [CAMP])) >= 2)

// ---------------------------------------------------------------------------------------------------------------------
// 7. Coûts et délivrabilité
// ---------------------------------------------------------------------------------------------------------------------
const s0 = await as(comm, () => rpc('marketing_campaign_summary', CAMP))
ok('coût estimé absent sans tarif saisi (null, jamais inventé)', s0.estimated_cost === null)
await rejects('tarif négatif refusé', () => as(admin, () => rpc('marketing_price_set', 'email', 'EUR', -0.01)), 'MARKETING_PRICE_INVALID')
await rejects('tarif pour un canal inconnu refusé', () => as(admin, () => rpc('marketing_price_set', 'telegram', 'EUR', 0.02)), 'check')
await as(admin, () => rpc('marketing_price_set', 'email', 'EUR', 0.05))
const s1 = await as(dir, () => rpc('marketing_campaign_summary', CAMP))
ok('coût estimé = éligibles × tarif (2 × 0,05 = 0,10 EUR)', Number(s1.estimated_cost) === 0.1 && s1.currency === 'EUR', JSON.stringify(s1))
ok('délivrabilité : rebonds et plaintes comptés par type', s1.events.bounced === 1 && s1.events.complained === 1 && s1.events.delivered === undefined, JSON.stringify(s1.events))
ok('lecture du résumé possible à la direction (marketing.read) et refusée sans droit', s1.campaign_id === CAMP && (await as(prod, () => q(`select count(*)::int n from marketing_campaigns`)))[0].n === 0)
ok('campagne SMS : coût nul tant qu’aucun tarif SMS n’est saisi', (await as(comm, () => rpc('marketing_campaign_summary', CAMP_SMS))).estimated_cost === null)

// ---------------------------------------------------------------------------------------------------------------------
// 8. Audit et intégrité
// ---------------------------------------------------------------------------------------------------------------------
ok('audit : préparation, modèles, consentements et désinscription tracés', (await count(`select count(*)::int n from audit_logs where action in ('marketing.campaign_prepare','marketing.template_create','marketing.template_approve','marketing.phone_authorize','marketing.unsubscribe','marketing.policy_set','marketing.price_set')`)) >= 8)
ok('désinscription publique tracée (source « app »)', (await count(`select count(*)::int n from audit_logs where action='marketing.unsubscribe' and source='app'`)) >= 2)

console.log('marketing : fin des contrôles')
