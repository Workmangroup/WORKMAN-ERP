import { createDb, makeHelpers } from './_harness.mjs'
import fs from 'node:fs'

const files = fs.readdirSync(new URL('../../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

const company = (await q(`select id from companies`))[0].id
const role = async (code, co = company) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, co]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')       // steward (distinct de l'auteur)
const com = await mkUser('com@x.com', 'commercial')      // lecture clients, pas de décision
const fin = await mkUser('fin@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)

// --- Fiches de départ (identiques à celles d'une société existante) ----------------------------------------------------------------
const c1 = (await as(admin, () => q(`insert into clients(name, country, currency, tax_id) values ('Engie Workwear','FR','EUR','FR12345678901') returning id, party_id`)))[0]
const c2 = (await as(admin, () => q(`insert into clients(name, legal_name, country, currency, tax_id, credit_limit) values ('Engie WW','Engie Workwear SARL','FR','EUR','fr-12345678901', 500) returning id, party_id`)))[0]
const c3 = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Atelier Nord','TN','TND') returning id, party_id`)))[0]
const s1 = (await as(admin, () => q(`insert into suppliers(name, country, currency) values ('Tissus Sfax','TN','TND') returning id, party_id`)))[0]
const s2 = (await as(admin, () => q(`insert into suppliers(name, country, currency) values ('Tissus-Sfax','TN','TND') returning id, party_id`)))[0]

// --- A. Migration : chaque fiche a son tiers, sans fusion ----------------------------------------------------------------------------
ok('chaque fiche client a son tiers, distinct des autres', c1.party_id !== c2.party_id && c3.party_id !== c1.party_id)
ok('tiers créé à partir de la fiche (raison sociale, identifiant fiscal, pays)', (await q(`select legal_name, tax_id, country from parties where id=$1`, [c1.party_id]))[0].tax_id === 'FR12345678901')
ok('raison sociale légale reprise quand elle existe', (await q(`select legal_name from parties where id=$1`, [c2.party_id]))[0].legal_name === 'Engie Workwear SARL')
await rejects('tiers non modifiable directement (pas de privilège d’écriture)', () => as(admin, () => db.query(`update parties set legal_name='X' where id=$1`, [c1.party_id])), 'permission denied')

// --- B. Conditions locales séparées --------------------------------------------------------------------------------------------------------
ok('conditions locales propres à chaque fiche (plafond)', (await q(`select credit_limit from clients where id=$1`, [c2.id]))[0].credit_limit === '500.000' && (await q(`select credit_limit from clients where id=$1`, [c1.id]))[0].credit_limit === null)
const coB = (await q(`insert into companies(name, country) values ('Société B','TN') returning id`))[0].id
const adminB = await mkUser('adminb@x.com', null)
await db.query(`update profiles set company_id = $1 where id = $2`, [coB, adminB])
await db.query(`insert into roles(company_id, code, label, is_system) values ($1,'admin','Administrateur B',true)`, [coB])
await db.query(`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.company_id=$1 and r.code='admin' and p.code in ('clients.read','clients.write','suppliers.read') on conflict do nothing`, [coB])
await db.query(`insert into user_roles values ($1, (select id from roles where code='admin' and company_id=$2))`, [adminB, coB])
const cB = (await db.query(`insert into clients(company_id, name, country, currency, tax_id, credit_limit, party_id) values ($1,'Atelier Nord (société B)','TN','TND', null, 9000, $2) returning id`, [coB, c3.party_id])).rows[0]
ok('tiers partagé : la société B voit le tiers qu’elle partage (Atelier Nord)', (await as(adminB, () => q(`select id from parties where id=$1`, [c3.party_id]))).length === 1)
ok('tiers non partagé : la société B ne voit pas le tiers de la société A', (await as(adminB, () => q(`select id from parties where id=$1`, [c1.party_id]))).length === 0)
ok('conditions locales : la société B ne voit pas le plafond de la société A', (await as(adminB, () => q(`select credit_limit from clients where id=$1`, [c2.id]))).length === 0)
ok('conditions locales : la société A voit seulement ses fiches', (await as(admin, () => q(`select id from clients where party_id=$1`, [c1.party_id]))).every((r) => r.id !== cB.id))
ok('plafond de la société B distinct du plafond de la société A', (await q(`select credit_limit from clients where id=$1`, [cB.id]))[0].credit_limit === '9000.000')

// --- C. Dédoublonnage assisté ----------------------------------------------------------------------------------------------------------------
const cands = await as(admin, () => q(`select party_a, party_b, match_kind from party_duplicate_candidates()`))
ok('doublon fort : même identifiant fiscal', cands.some((r) => (r.party_a === c1.party_id || r.party_b === c1.party_id) && (r.party_a === c2.party_id || r.party_b === c2.party_id) && r.match_kind === 'strong'), JSON.stringify(cands))
ok('doublon ambigu : même raison sociale et pays seulement', cands.some((r) => [r.party_a, r.party_b].includes(s1.party_id) && [r.party_a, r.party_b].includes(s2.party_id) && r.match_kind === 'ambiguous'))
ok('pas de faux doublon (pays différents)', !cands.some((r) => [r.party_a, r.party_b].includes(c3.party_id)))
ok('candidats : sans droit de lecture, rien', (await as(nobody, () => q(`select * from party_duplicate_candidates()`).catch(() => []))).length === 0)

// --- D. Proposition et décision : séparation des tâches --------------------------------------------------------------------------------
await rejects('proposition refusée sans motif', () => as(admin, () => rpc('party_propose_merge', c2.party_id, c1.party_id, 'x')), 'PARTY_REASON_REQUIRED')
await rejects('fusion inter-sociétés refusée (tiers lié à la société B)', () => as(admin, () => rpc('party_propose_merge', c3.party_id, c1.party_id, 'Test inter-sociétés')), 'MERGE_CROSS_COMPANY')
const pA = await as(admin, () => rpc('party_propose_merge', c2.party_id, c1.party_id, 'Même identifiant fiscal, même société'))
ok('proposition créée, marquée forte', (await q(`select match_kind, status from party_merge_proposals where id=$1`, [pA]))[0].match_kind === 'strong')
await rejects('auto-approbation de fusion refusée', () => as(admin, () => rpc('party_decide_merge', pA, true, '{}', null)), 'SOD_SELF_APPROVAL')
await rejects('décision réservée au steward (commercial refusé)', () => as(com, () => rpc('party_decide_merge', pA, true, '{}', null)), 'RBAC_FORBIDDEN')
await rejects('choix de champ inconnu refusé', () => as(dir, () => rpc('party_decide_merge', pA, true, '{"adresse":"target"}', null)), 'PARTY_BAD_CHOICE')
await rejects('choix de source invalide refusé', () => as(dir, () => rpc('party_decide_merge', pA, true, '{"legal_name":"peut-etre"}', null)), 'PARTY_BAD_CHOICE')
ok('après choix refusés : rien n’a changé', (await q(`select status from parties where id=$1`, [c2.party_id]))[0].status === 'active' && (await q(`select status from party_merge_proposals where id=$1`, [pA]))[0].status === 'pending')

// --- E. Fusion appliquée : traçable, anciens identifiants conservés, documents lisibles --------------------------------------------------------
const folderC2 = (await q(`select id from ged_folders where client_id=$1 limit 1`, [c2.id]))[0].id
await db.query(`insert into ged_documents(company_id, client_id, folder_id, title) values ($1,$2,$3,'Contrat cadre')`, [company, c2.id, folderC2])
const res = await as(dir, () => rpc('party_decide_merge', pA, true, '{"legal_name":"source","tax_id":"target"}', 'Doublon confirmé'))
ok('fusion appliquée : la fiche du tiers source est rattachée au tiers cible', res.status === 'applied' && res.moved_clients === 1)
ok('raison sociale choisie dans la source (mapping par champ)', (await q(`select legal_name from parties where id=$1`, [c1.party_id]))[0].legal_name === 'Engie Workwear SARL')
ok('ancien identifiant de tiers résolu vers le tiers actif', (await as(admin, () => q(`select party_resolve($1) r`, [c2.party_id])))[0].r === c1.party_id)
ok('ancienne fiche toujours lisible et rattachée au tiers cible', (await as(admin, () => q(`select party_id from clients where id=$1`, [c2.id])))[0].party_id === c1.party_id)
ok('documents de l’ancienne fiche lisibles après fusion', (await as(admin, () => q(`select title from ged_documents where client_id=$1`, [c2.id]))).length === 1)
ok('conditions locales conservées après fusion (plafond de la fiche)', (await q(`select credit_limit from clients where id=$1`, [c2.id]))[0].credit_limit === '500.000')
ok('tiers source marqué fusionné, avec son lien', (await q(`select status, merged_into from parties where id=$1`, [c2.party_id]))[0].merged_into === c1.party_id)
const log = (await q(`select before_data, after_data, moved_clients from party_merge_log where proposal_id=$1`, [pA]))[0]
ok('journal de fusion : états avant et après', !!log && log.before_data.source.legal_name === 'Engie Workwear SARL' && log.after_data.source.status === 'merged')
await rejects('journal de fusion immuable', () => db.query(`update party_merge_log set moved_clients=0`), 'PARTY_MERGE_LOG_IMMUTABLE')
await rejects('proposition déjà décidée : second traitement refusé', () => as(dir, () => rpc('party_decide_merge', pA, false, '{}', 'Revirement')), 'PARTY_PROPOSAL_BAD_STATUS')
ok('fusion tracée dans le journal d’audit (significative)', (await q(`select significant from audit_logs where action='party.merge_approve' and entity_id=$1`, [c2.party_id]))[0]?.significant === true)

// --- F. Refus de fusion ambiguë : commentaire requis ------------------------------------------------------------------------------------
const pB = await as(admin, () => rpc('party_propose_merge', s2.party_id, s1.party_id, 'Même raison sociale, à vérifier'))
await rejects('refus sans commentaire refusé', () => as(dir, () => rpc('party_decide_merge', pB, false, '{}', null)), 'PARTY_COMMENT_REQUIRED')
await as(dir, () => rpc('party_decide_merge', pB, false, '{}', 'Deux sociétés distinctes'))
ok('fusion ambiguë refusée : les deux fournisseurs restent actifs', (await q(`select count(*)::int n from parties where id in ($1,$2) and status='active'`, [s1.party_id, s2.party_id]))[0].n === 2)

// --- G. Identité partagée : correction par le steward, tracée -----------------------------------------------------------------------------
await rejects('correction d’identité réservée au steward', () => as(com, () => rpc('party_update_identity', c1.party_id, 'Engie', 'FR12345678901', 'Correction test')), 'RBAC_FORBIDDEN')
await rejects('correction d’identité d’un tiers lié à la société B refusée', () => as(dir, () => rpc('party_update_identity', c3.party_id, 'Atelier', null, 'Correction test')), 'MERGE_CROSS_COMPANY')
await as(dir, () => rpc('party_update_identity', c1.party_id, 'Engie Workwear SARL', 'FR12345678901', 'Raison sociale confirmée au registre'))
ok('correction d’identité tracée (action identity_change, significative)', (await q(`select significant from audit_logs where action='party.identity_change' and entity_id=$1`, [c1.party_id]))[0]?.significant === true)

// --- H. Lecture des fiches : aucune fuite de tiers ----------------------------------------------------------------------------------------
ok('utilisateur sans droit : aucun tiers visible', (await as(nobody, () => q(`select id from parties`))).length === 0)
ok('journal de fusion réservé au steward', (await as(com, () => q(`select id from party_merge_log`))).length === 0 && (await as(dir, () => q(`select id from party_merge_log`))).length >= 1)

// --- I. Fiche archivée : fusion refusée -----------------------------------------------------------------------------------------------
const cA = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Archive Test','FR','EUR') returning id, party_id`)))[0]
const cA2 = (await as(admin, () => q(`insert into clients(name, country, currency) values ('Archive Test SA','FR','EUR') returning id, party_id`)))[0]
await as(admin, () => rpc('client_archive', cA.id, 'Client inactif'))
await rejects('fiche archivée : proposition de fusion refusée', () => as(admin, () => rpc('party_propose_merge', cA.party_id, cA2.party_id, 'Test archivage')), 'MERGE_ARCHIVED_ROW')
