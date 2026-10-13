// Tickets SAV et résolution : références commande / facture / lot, SLA mesurable, doublon, coordonnées protégées, investigation,
// base de connaissance, réponse proposée, clôture confirmée, causes répétées liées aux CAPA — P057 / migration 0082
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => Number((await q(sql, params))[0].n)
const d = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }
const sha = (c) => c.repeat(64)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('com@x.com', 'commercial')   // sav.write, sav.contact, sav.kb
const qual = await mkUser('qual@x.com', 'qualite')     // sav.write, sav.kb, sav.publish, quality.write / approve ; pas de sav.contact
const dir = await mkUser('dir@x.com', 'direction')     // sav.admin, sav.publish
const fin = await mkUser('fin@x.com', 'finance')       // clients.read seulement : lit un ticket sans les coordonnées
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

// --- Référentiel : deux clients, commande livrée, facture, deux lots produits ---------------------------------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const whF = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P57','finished_goods') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whF])
const C1 = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client SAV P57','FR','EUR',true) returning id`, [company]))[0].id
const C2 = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Autre client SAV P57','FR','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P57-A','Veste P57','jacket') returning id`, [company, C1]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P57','jacket',$3) returning id`, [company, C1, art]))[0].id
const colJ = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJ], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
await db.query(`update product_variants set price = 25 where id=$1`, [vV])
const LF = await as(admin, () => rpc('finished_lot_receive', vV, whF, 'LOT-P57-A', 4, 'OF-P57-1'))
const LF2 = await as(admin, () => rpc('finished_lot_receive', vV, whF, 'LOT-P57-B', 3, 'OF-P57-2'))
const ORDER = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C1])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,4,25,$5)`, [company, ORDER, art, vV, d(20)])
await as(admin, () => rpc('sales_order_confirm', ORDER))
const S = await as(mag, () => rpc('shipment_create', ORDER, whF, 'FCA', 'FR', 'EUR'))
const LN = await as(mag, () => rpc('shipment_add_line', S, vV, 4))
await as(mag, () => rpc('shipment_pick', LN, 4))
await as(mag, () => rpc('shipment_line_lot_assign', LN, LF, 4))
await as(mag, () => rpc('shipment_pack', S, 1, 4, 3.5))
await as(mag, () => rpc('shipment_ship', S, 'DHL', 'TRK-57-A'))
const INV = await as(admin, () => rpc('invoice_from_shipment', S, 'INV-KEY-P57-0001'))
const DOC1 = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,(select id from ged_folders where client_id=$2 and system_key='certifications'),'Photo réclamation P57',$3) returning id`, [company, C1, sha('a')]))[0].id
const DOC2 = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,(select id from ged_folders where client_id=$2 and system_key='certifications'),'Document autre client',$3) returning id`, [company, C2, sha('b')]))[0].id

const open = (who, over = {}) => {
  const a = { client: C1, order: null, invoice: null, lots: null, channel: 'email', priority: null, severity: 'major', subject: 'Couture défaillante P57',
    description: 'Couture ouverte constatée', name: 'Mme Test', email: 'test@client.tn', phone: '+21620000000', dup: null, reason: null, ...over }
  return as(who, () => rpc('ticket_open', a.client, a.order, a.invoice, a.lots, a.channel, a.priority, a.severity, a.subject, a.description, a.name, a.email, a.phone, a.dup, a.reason))
}

// --- A. Ouverture : droits, canal, priorité, références ---------------------------------------------------------------------------------
await rejects('ouverture sans droit SAV refusée (RBAC_FORBIDDEN)', () => open(mag), 'RBAC_FORBIDDEN')
await rejects('canal inconnu refusé (SAV_CHANNEL_INVALID)', () => open(comm, { channel: 'pigeon' }), 'SAV_CHANNEL_INVALID')
await rejects('priorité inconnue refusée (SAV_PRIORITY_INVALID)', () => open(comm, { priority: 'critique' }), 'SAV_PRIORITY_INVALID')
await rejects('facture d’un autre client refusée (COMPLAINT_INVOICE_NOT_FOUND)', () => open(comm, { client: C2, invoice: INV }), 'COMPLAINT_INVOICE_NOT_FOUND')
await rejects('lot d’un autre client refusé (COMPLAINT_LOT_NOT_FOUND)', () => open(comm, { client: C2, lots: [LF] }), 'COMPLAINT_LOT_NOT_FOUND')
await rejects('lot non livré pour la commande refusé (COMPLAINT_LOT_NOT_IN_ORDER)', () => open(comm, { order: ORDER, lots: [LF2] }), 'COMPLAINT_LOT_NOT_IN_ORDER')
await rejects('commande d’un autre client refusée (COMPLAINT_ORDER_NOT_FOUND)', () => open(comm, { client: C2, order: ORDER }), 'COMPLAINT_ORDER_NOT_FOUND')

// --- B. SLA mesurable : sans politique, puis avec politique saisie ----------------------------------------------------------------
const t1 = await open(comm, { order: ORDER, invoice: INV, lots: [LF] })
ok('ticket ouvert avec commande, facture et lot ; priorité dérivée de la gravité (majeur → haute) ; SLA « sans politique »', t1.result === 'created' && t1.sla === 'no_policy'
  && (await q(`select priority, first_response_due, ticket from client_complaints where id=$1`, [t1.ticket_id]))[0].priority === 'high'
  && (await q(`select first_response_due from client_complaints where id=$1`, [t1.ticket_id]))[0].first_response_due === null)
const g1 = await as(comm, () => rpc('ticket_get', t1.ticket_id))
ok('fiche du ticket : facture, lot et état de SLA « sans politique » (aucune échéance supposée)', g1.invoice_id === INV && g1.lots.includes('LOT-P57-A') && g1.sla.first_response_state === 'no_policy' && g1.sla.defined === false)
await rejects('politique de SLA sans droit d’administration refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('sla_policy_set', 'high', 60, 240)), 'RBAC_FORBIDDEN')
await rejects('politique incohérente refusée (résolution < première réponse)', () => as(dir, () => rpc('sla_policy_set', 'high', 240, 60)), 'sav_sla_policies_check')
await as(dir, () => rpc('sla_policy_set', 'high', 60, 240))

const t2 = await open(comm, { priority: 'high', subject: 'Fermeture éclair bloquée P57' })
const t2row = (await q(`select extract(epoch from (first_response_due - created_at))/60 fr, extract(epoch from (resolution_due - created_at))/60 rs from client_complaints where id=$1`, [t2.ticket_id]))[0]
ok('avec politique : échéances = création + 60 min (première réponse) et + 240 min (résolution)', t2.sla === 'defined' && Math.round(t2row.fr) === 60 && Math.round(t2row.rs) === 240)

// --- C. Doublon : même client seulement, sur commande / facture / lot partagés ------------------------------------------------------------
const dupTry = await open(comm, { order: ORDER, subject: 'Couture défaillante (nouvel appel) P57' })
ok('doublon suspecté : création suspendue, ticket candidat du même client proposé', dupTry.result === 'duplicate_suspected' && dupTry.candidates.length === 1
  && dupTry.candidates[0].id === t1.ticket_id && (await count(`select count(*)::int n from client_complaints where ticket`, [])) === 2)
const otherClient = await open(comm, { client: C2, severity: 'minor', subject: 'Autre client sans référence P57' })
ok('un ticket d’un autre client n’est jamais candidat ni exposé', otherClient.result === 'created' && otherClient.candidates === undefined)
await rejects('doublon rattaché à un ticket sans lien refusé (SAV_NOT_FOUND)', () => open(comm, { order: ORDER, dup: t2.ticket_id }), 'SAV_NOT_FOUND')
const t3 = await open(comm, { order: ORDER, subject: 'Couture défaillante, autre pièce P57', reason: 'Autre pièce du même lot, constat distinct du premier' })
ok('création confirmée par l’agent avec motif : ticket distinct créé', t3.result === 'created')
const dupLinked = await open(comm, { order: ORDER, subject: 'Relance du client sur la couture P57', dup: t1.ticket_id })
const dupRow = (await q(`select status, close_kind, duplicate_of from client_complaints where id=$1`, [dupLinked.ticket_id]))[0]
ok('doublon rattaché au ticket principal : clos « doublon », lien conservé', dupLinked.result === 'duplicate_linked' && dupRow.status === 'closed' && dupRow.close_kind === 'duplicate' && dupRow.duplicate_of === t1.ticket_id)

// --- D. Traitement : responsable, preuves, investigation, base de connaissance, réponse -----------------------------------------------
await rejects('réponse sans responsable refusée (SAV_OWNER_REQUIRED)', () => as(comm, () => rpc('ticket_respond', t1.ticket_id, 'Nous reprenons votre dossier ce jour.', 'email', null)), 'SAV_OWNER_REQUIRED')
await rejects('responsable inconnu de la société refusé (SAV_OWNER_INVALID)', () => as(comm, () => rpc('ticket_assign', t1.ticket_id, nobody)), 'SAV_OWNER_INVALID')
await as(comm, () => rpc('ticket_assign', t1.ticket_id, comm))
await as(comm, () => rpc('ticket_assign', t2.ticket_id, comm))
await as(comm, () => rpc('ticket_assign', t3.ticket_id, comm))
await rejects('preuve d’un autre client refusée (COMPLAINT_DOCUMENT_REQUIRED)', () => as(comm, () => rpc('ticket_evidence_add', t1.ticket_id, DOC2, 'Photo')), 'COMPLAINT_DOCUMENT_REQUIRED')
await as(comm, () => rpc('ticket_evidence_add', t1.ticket_id, DOC1, 'Photo de la couture'))
ok('preuve rattachée (document GED du client)', (await count(`select count(*)::int n from complaint_evidence where complaint_id=$1`, [t1.ticket_id])) === 1)
await rejects('résolution sans investigation refusée (SAV_INVESTIGATION_REQUIRED)', () => as(comm, () => rpc('ticket_resolve', t1.ticket_id, 'Remplacement de la pièce défectueuse')), 'SAV_INVESTIGATION_REQUIRED')
await rejects('cause inconnue refusée (SAV_CAUSE_INVALID)', () => as(comm, () => rpc('ticket_investigate', t1.ticket_id, 'Fil de couture cassant sur le lot', 'chance')), 'SAV_CAUSE_INVALID')

// Base de connaissance : brouillon, publication par une autre personne que l'auteur, proposition
const kb = await as(qual, () => rpc('kb_article_save', 'Réponse type : fil de couture non conforme', 'Nous avons identifié un défaut de fil sur le lot. Une pièce de remplacement vous sera expédiée.', 'material'))
const prop0 = await as(comm, () => rpc('ticket_propose_response', t1.ticket_id))
ok('brouillon non proposé (seuls les articles publiés le sont)', prop0.proposals.length === 0)
await rejects('publication par l’auteur refusée (SAV_KB_SELF_PUBLISH)', () => as(qual, () => rpc('kb_article_publish', kb)), 'SAV_KB_SELF_PUBLISH')
await rejects('publication sans droit refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('kb_article_publish', kb)), 'RBAC_FORBIDDEN')
await as(dir, () => rpc('kb_article_publish', kb))
await as(comm, () => rpc('ticket_investigate', t1.ticket_id, 'Fil de couture cassant sur le lot, constaté sur trois pièces', 'material'))
const responsesBefore = await count(`select count(*)::int n from complaint_responses`, [])
const prop1 = await as(comm, () => rpc('ticket_propose_response', t1.ticket_id))
ok('réponse proposée : article publié de la cause « matière » ; rien envoyé ni enregistré', prop1.proposals.length === 1 && prop1.proposals[0].article_id === kb && prop1.sent === false
  && (await count(`select count(*)::int n from complaint_responses`, [])) === responsesBefore)
await rejects('réponse avec un article non publié refusée (SAV_KB_NOT_PUBLISHED)', () => as(comm, () => rpc('ticket_respond', t1.ticket_id, 'Nous avons identifié un défaut de fil sur votre lot.', 'email', t2.ticket_id)), 'SAV_KB_NOT_PUBLISHED')
await as(comm, () => rpc('ticket_respond', t1.ticket_id, 'Nous avons identifié un défaut de fil sur votre lot. Une pièce de remplacement vous sera expédiée.', 'email', kb))
const frAt = (await q(`select first_response_at from client_complaints where id=$1`, [t1.ticket_id]))[0].first_response_at
await as(comm, () => rpc('ticket_respond', t1.ticket_id, 'Complément : le colis de remplacement part demain.', 'phone', null))
ok('première réponse horodatée une seule fois ; ticket en cours ; réponses conservées', frAt !== null
  && String((await q(`select first_response_at from client_complaints where id=$1`, [t1.ticket_id]))[0].first_response_at) === String(frAt)
  && (await q(`select status from client_complaints where id=$1`, [t1.ticket_id]))[0].status === 'in_progress'
  && (await count(`select count(*)::int n from complaint_responses where complaint_id=$1`, [t1.ticket_id])) === 2)

// --- E. SLA mesuré : respecté, manqué, en retard -------------------------------------------------------------------------------------------
await as(comm, () => rpc('ticket_investigate', t2.ticket_id, 'Fermeture à glissière sous-dimensionnée par le fournisseur', 'material'))
await as(comm, () => rpc('ticket_investigate', t3.ticket_id, 'Fil de couture identique au lot précédent, même fournisseur', 'material'))
await as(comm, () => rpc('ticket_respond', t3.ticket_id, 'Nous avons bien enregistré votre signalement.', 'email', null))
await db.query(`update client_complaints set first_response_due = first_response_at - interval '1 minute' where id=$1`, [t3.ticket_id])
await db.query(`update client_complaints set first_response_due = now() - interval '1 hour' where id=$1`, [t2.ticket_id])
const rep = await as(comm, () => rpc('ticket_sla_report', d(-1), d(1)))
const high = rep.by_priority.find((p) => p.priority === 'high')
ok('rapport de SLA : tickets, sans politique, première réponse manquée, en retard — comptés sans les doublons', high.tickets === 3 && high.no_policy === 1
  && high.first_response_breached === 1 && high.first_response_overdue === 1 && high.first_response_met === 0, JSON.stringify(high))
const g2 = await as(comm, () => rpc('ticket_get', t2.ticket_id))
ok('fiche : première réponse en retard pour le ticket sans réponse', g2.sla.first_response_state === 'overdue')

// --- F. Résolution et clôture confirmée --------------------------------------------------------------------------------------------------------
await rejects('solution trop courte refusée (COMPLAINT_RESOLUTION_REQUIRED)', () => as(comm, () => rpc('ticket_resolve', t1.ticket_id, 'ok')), 'COMPLAINT_RESOLUTION_REQUIRED')
await as(comm, () => rpc('ticket_resolve', t1.ticket_id, 'Remplacement de la pièce défectueuse et contrôle du lot de fil'))
await rejects('seconde résolution refusée (SAV_BAD_STATUS)', () => as(comm, () => rpc('ticket_resolve', t1.ticket_id, 'Seconde résolution tentée sur le même ticket')), 'SAV_BAD_STATUS')
await rejects('clôture sans confirmation refusée (SAV_CONFIRMATION_REQUIRED)', () => as(comm, () => rpc('ticket_close', t1.ticket_id, 'client_confirmed', 'ok')), 'SAV_CONFIRMATION_REQUIRED')
await rejects('nature de confirmation inconnue refusée (SAV_KIND_INVALID)', () => as(comm, () => rpc('ticket_close', t1.ticket_id, 'verbal', 'REF-123456')), 'SAV_KIND_INVALID')
await rejects('clôture « résolu » par le chemin des réclamations antérieures refusée (COMPLAINT_USE_TICKET_FLOW)', () => as(comm, () => rpc('complaint_update', t1.ticket_id, 'closed', null)), 'COMPLAINT_USE_TICKET_FLOW')
await rejects('statut écrit directement refusé (COMPLAINT_USE_TICKET_FLOW)', () => db.query(`update client_complaints set status='closed', closed_at=now(), close_kind='client_confirmed' where id=$1`, [t1.ticket_id]), 'COMPLAINT_USE_TICKET_FLOW')
await as(comm, () => rpc('ticket_close', t1.ticket_id, 'client_confirmed', 'MAIL-CLIENT-2026-0001'))
ok('ticket clos avec la confirmation du client (référence conservée)', (await q(`select status, close_kind, close_ref from client_complaints where id=$1`, [t1.ticket_id]))[0].close_ref === 'MAIL-CLIENT-2026-0001')
await rejects('ticket clos : nouvelle réponse refusée (SAV_TICKET_CLOSED)', () => as(comm, () => rpc('ticket_respond', t1.ticket_id, 'Réponse après la clôture du ticket.', 'email', null)), 'SAV_TICKET_CLOSED')

// Confirmation interne : par une autre personne que celle qui a résolu
await as(comm, () => rpc('ticket_assign', t3.ticket_id, qual))
await as(qual, () => rpc('ticket_resolve', t3.ticket_id, 'Lot de fil écarté, pièces remplacées et vérifiées'))
await rejects('confirmation interne par le résolveur refusée (SAV_CONFIRM_SELF)', () => as(qual, () => rpc('ticket_close', t3.ticket_id, 'internal_confirmed', 'CONTROLE-INTERNE-01')), 'SAV_CONFIRM_SELF')
await rejects('confirmation interne sans droit de qualité refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('ticket_close', t3.ticket_id, 'internal_confirmed', 'CONTROLE-INTERNE-01')), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('ticket_close', t3.ticket_id, 'internal_confirmed', 'CONTROLE-INTERNE-01'))
ok('confirmation interne par une autre personne acceptée', (await q(`select close_kind from client_complaints where id=$1`, [t3.ticket_id]))[0].close_kind === 'internal_confirmed')

// Réclamation antérieure : cycle inchangé
const legacy = await as(comm, () => rpc('complaint_open', C1, null, 'Réclamation antérieure P57', null, 'minor'))
await as(comm, () => rpc('complaint_update', legacy, 'in_progress', null))
await as(comm, () => rpc('complaint_update', legacy, 'resolved', 'Reprise effectuée sur la pièce'))
await as(comm, () => rpc('complaint_update', legacy, 'closed', null))
ok('réclamation antérieure : cycle ouvert → clos conservé', (await q(`select status, ticket from client_complaints where id=$1`, [legacy]))[0].status === 'closed')

// --- G. Données client protégées --------------------------------------------------------------------------------------------------------------
const gC = await as(comm, () => rpc('ticket_get', t1.ticket_id))
const gF = await as(fin, () => rpc('ticket_get', t1.ticket_id))
ok('coordonnées du demandeur visibles avec sav.contact', gC.contact && gC.contact.email === 'test@client.tn' && gC.contact_protected === false)
ok('coordonnées masquées sans sav.contact (clients.read seul)', gF.contact === null && gF.contact_protected === true && gF.number === gC.number)
await rejects('fiche sans droit client refusée (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('ticket_get', t1.ticket_id)), 'RBAC_FORBIDDEN')
ok('coordonnées invisibles en lecture directe sans sav.contact (RLS)', (await as(fin, () => count(`select count(*)::int n from complaint_requesters`))) === 0
  && (await as(comm, () => count(`select count(*)::int n from complaint_requesters`))) >= 1)
ok('audit sans coordonnées du demandeur', (await count(`select count(*)::int n from audit_logs where action like 'sav.%' and (position('@' in coalesce(after_data::text,'') || coalesce(metadata::text,'')) > 0 or position('21620000000' in coalesce(after_data::text,'') || coalesce(metadata::text,'')) > 0)`, [])) === 0)

// --- H. Causes répétées liées aux CAPA --------------------------------------------------------------------------------------------------------
await rejects('seuil trop bas refusé (SAV_THRESHOLD_INVALID)', () => as(comm, () => rpc('ticket_repeat_causes', 30, 1)), 'SAV_THRESHOLD_INVALID')
const causes = await as(comm, () => rpc('ticket_repeat_causes', 30, 3))
const mat = causes.causes.find((c) => c.cause_category === 'material')
ok('cause répétée détectée : « matière » sur trois tickets, aucun lié à une non-conformité', mat && mat.tickets === 3 && mat.unlinked === 3)
await rejects('ouverture de la CAPA sans droit qualité refusée (RBAC_FORBIDDEN)', () => as(comm, () => rpc('ticket_open_capa_for_cause', 'material', 30, 3, 'Fil non conforme répété P57')), 'RBAC_FORBIDDEN')
const capa = await as(qual, () => rpc('ticket_open_capa_for_cause', 'material', 30, 3, 'Fil non conforme répété P57'))
ok('non-conformité ouverte et liée aux trois tickets', capa.linked_tickets === 3 && (await count(`select count(*)::int n from client_complaints where nc_id=$1`, [capa.nc_id])) === 3
  && (await q(`select status from quality_nonconformities where id=$1`, [capa.nc_id]))[0].status === 'open')
await rejects('seconde ouverture sans ticket non lié refusée (SAV_NO_UNLINKED_TICKETS)', () => as(qual, () => rpc('ticket_open_capa_for_cause', 'material', 30, 3, 'Fil non conforme répété P57')), 'SAV_NO_UNLINKED_TICKETS')
const causes2 = await as(comm, () => rpc('ticket_repeat_causes', 30, 3))
ok('cause répétée : désormais liée à la non-conformité', causes2.causes.find((c) => c.cause_category === 'material').unlinked === 0 && causes2.causes.find((c) => c.cause_category === 'material').nonconformities.length === 1)
ok('doublon exclu du comptage des causes', mat.tickets === 3)

// --- I. Journaux en ajout seul, droits directs, audit ----------------------------------------------------------------------------------------
await rejects('réponse modifiée refusée (SAV_APPEND_ONLY)', () => db.query(`update complaint_responses set body='réécrit pour le test de modification' where complaint_id=$1`, [t1.ticket_id]), 'SAV_APPEND_ONLY')
await rejects('investigation supprimée refusée (SAV_APPEND_ONLY)', () => db.query(`delete from complaint_investigations where complaint_id=$1`, [t1.ticket_id]), 'SAV_APPEND_ONLY')
await rejects('article publié modifié refusé (SAV_APPEND_ONLY)', () => db.query(`update sav_kb_articles set body='Contenu réécrit après publication de l''article' where id=$1`, [kb]), 'SAV_APPEND_ONLY')
await rejects('réponse insérée directement refusée (permission denied)', () => as(admin, () => db.query(`insert into complaint_responses(company_id, complaint_id, body, channel) values ($1,$2,'Insertion directe de test','email')`, [company, t1.ticket_id])), 'permission denied')
await as(dir, () => rpc('kb_article_retire', kb))
ok('article retiré : plus proposé', (await as(comm, () => rpc('ticket_propose_response', t2.ticket_id))).proposals.length === 0)
ok('audit : ouvertures, réponses, résolutions, clôtures, causes et CAPA tracées', (await count(`select count(*)::int n from audit_logs where action='sav.ticket_open'`)) === 5
  && (await count(`select count(*)::int n from audit_logs where action='sav.respond'`)) === 3
  && (await count(`select count(*)::int n from audit_logs where action='sav.resolve'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='sav.close'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='sav.capa_for_cause'`)) === 1)
