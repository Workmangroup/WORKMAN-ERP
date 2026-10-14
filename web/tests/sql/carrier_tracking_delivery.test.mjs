// Transporteurs, suivi et livraison : transporteurs confirmés, étiquettes, événements sans doublon, panne reprenable,
// anomalies, preuve de livraison habilitée, livraison sans effet sur facture et litige — P056 / migration 0081
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
const mag = await mkUser('mag@x.com', 'magasin')       // expédition
const comm = await mkUser('com@x.com', 'commercial')   // documents.read
const fin = await mkUser('fin@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)

// --- Expédition émise (chaîne minimale) ----------------------------------------------------------------------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const whF = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P56','finished_goods') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whF])
const client = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client P56','FR','EUR',true) returning id`, [company]))[0].id
const clientOther = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Autre client P56','FR','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P56-A','Veste P56','jacket') returning id`, [company, client]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P56','jacket',$3) returning id`, [company, client, art]))[0].id
const colJ = (await q(`select id from colors where name='Jaune HV'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
await as(admin, () => rpc('variant_generate', prodV, [colJ], [sizeS]))
const vV = (await q(`select id from product_variants where product_id=$1`, [prodV]))[0].id
await db.query(`update product_variants set price = 25 where id=$1`, [vV])
await as(admin, () => rpc('finished_lot_receive', vV, whF, 'LOT-P56', 4, 'OF-P56-1'))
const order = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,4,25,$5)`, [company, order, art, vV, d(20)])
await as(admin, () => rpc('sales_order_confirm', order))
const LOTID = (await q(`select id from finished_lots where lot_code='LOT-P56'`))[0].id
const S = await as(mag, () => rpc('shipment_create', order, whF, 'FCA', 'FR', 'EUR'))
const SNUM = (await q(`select number from shipments where id=$1`, [S]))[0].number
const LN = await as(mag, () => rpc('shipment_add_line', S, vV, 4))
await as(mag, () => rpc('shipment_pick', LN, 4))
await as(mag, () => rpc('shipment_line_lot_assign', LN, LOTID, 4))
await as(mag, () => rpc('shipment_pack', S, 1, 4, 3.5))
const BL = await as(mag, () => rpc('shipment_ship', S, 'DHL', 'TRK-56-A'))
const S2 = await as(mag, () => rpc('shipment_create', order, whF, 'FCA', 'FR', 'EUR'))

// --- A. Transporteurs : enregistrement, confirmation, refus sans confirmation ----------------------------------------------------------
await rejects('transporteur créé par un utilisateur sans droit refusé (RBAC_FORBIDDEN)', () => as(mag, () => rpc('carrier_register', 'DHL', 'DHL Express')), 'RBAC_FORBIDDEN')
await as(admin, () => rpc('carrier_register', 'DHL', 'DHL Express'))
await as(admin, () => rpc('carrier_register', 'UPS', 'UPS (non confirmé)'))
await as(admin, () => rpc('carrier_confirm', 'DHL'))
ok('transporteur DHL confirmé ; UPS enregistré mais non confirmé', (await q(`select code, confirmed_at is not null c from carriers where company_id=$1 order by code`, [company])).map((r) => `${r.code}:${r.c}`).join(',') === 'DHL:true,UPS:false')
await rejects('confirmation par un utilisateur sans droit refusée (RBAC_FORBIDDEN)', () => as(mag, () => rpc('carrier_confirm', 'UPS')), 'RBAC_FORBIDDEN')
const ingUps = await db.query(`select public.carrier_ingest($1,'UPS','ups-1','TRK-UPS-1','in_transit',$2,'Tunis','',$3) r`, [company, '2026-10-13T08:00:00Z', sha('a')])
ok('événement d’un transporteur non confirmé refusé (CARRIER_NOT_CONFIRMED), rien journalisé', ingUps.rows[0].r.code === 'CARRIER_NOT_CONFIRMED'
  && (await count(`select count(*)::int n from carrier_events where company_id=$1`, [company])) === 0)

// --- B. Étiquettes : une par colis ou par expédition, suivi unique, transporteur confirmé ---------------------------------------------
await as(mag, () => rpc('carrier_label_issue', S, null, 'DHL', 'TRK-56-A', 'LBL-P56-0001'))
await rejects('étiquette en double (même transporteur, même suivi) refusée (CARRIER_TRACKING_DUPLICATE)', () => as(mag, () => rpc('carrier_label_issue', S, null, 'DHL', 'TRK-56-A', 'LBL-P56-0002')), 'CARRIER_TRACKING_DUPLICATE')
await rejects('étiquette avec un transporteur non confirmé refusée (CARRIER_NOT_CONFIRMED)', () => as(mag, () => rpc('carrier_label_issue', S, null, 'UPS', 'TRK-UPS-9', 'LBL-P56-0003')), 'CARRIER_NOT_CONFIRMED')
await rejects('étiquette sans référence refusée (CARRIER_LABEL_REF_REQUIRED)', () => as(mag, () => rpc('carrier_label_issue', S, null, 'DHL', 'TRK-56-X', 'ab')), 'CARRIER_LABEL_REF_REQUIRED')
await rejects('étiquette d’une expédition non emballée refusée (SHIP_BAD_STATUS)', () => as(mag, () => rpc('carrier_label_issue', S2, null, 'DHL', 'TRK-56-S2', 'LBL-P56-0004')), 'SHIP_BAD_STATUS')
const tr0 = await as(mag, () => rpc('carrier_tracking_get', S))
ok('suivi : l’étiquette DHL est rattachée à l’expédition', tr0.labels.length === 1 && tr0.labels[0].tracking === 'TRK-56-A' && tr0.labels[0].carrier === 'DHL')

// --- C. Ingestion serveur : événements, doublons, conflits -------------------------------------------------------------------------------
const ing = (pid, code, trk, when, digest) => db.query(`select public.carrier_ingest($1,'DHL',$2,$3,$4,$5,'Sfax','Événement',$6) r`, [company, pid, trk, code, when, digest]).then((r) => r.rows[0].r)
const T1 = '2026-10-13T09:00:00Z'
const e1 = await ing('dhl-1', 'in_transit', 'TRK-56-A', T1, sha('1'))
ok('événement de transit accepté et appliqué au suivi de l’expédition', e1.result === 'accepted' && e1.status === 'applied', JSON.stringify(e1)); ok('x', true
  && (await count(`select count(*)::int n from shipment_events where shipment_id=$1 and event_type='in_transit'`, [S])) === 1)
const e1dup = await ing('dhl-1', 'in_transit', 'TRK-56-A', T1, sha('1'))
ok('même événement répété (même identifiant, même contenu) : doublon sans effet', e1dup.result === 'duplicate' && e1dup.event_id === e1.event_id
  && (await count(`select count(*)::int n from shipment_events where shipment_id=$1 and event_type='in_transit'`, [S])) === 1)
const e1conf = await ing('dhl-1', 'in_transit', 'TRK-56-A', T1, sha('2'))
ok('même identifiant avec un contenu différent : conflit refusé, rien ajouté', e1conf.result === 'conflict' && e1conf.code === 'CARRIER_EVENT_CONFLICT'
  && (await count(`select count(*)::int n from carrier_events where company_id=$1`, [company])) === 1)
const e1b = await ing('dhl-1-bis', 'in_transit', 'TRK-56-A', T1, sha('1'))
ok('même suivi, même code, même date sous un autre identifiant : doublon', e1b.result === 'duplicate')
await rejects('code d’événement inconnu refusé (CARRIER_EVENT_INVALID)', () => ing('dhl-2', 'teleported', 'TRK-56-A', T1, sha('3')), 'CARRIER_EVENT_INVALID')

// Panne reprenable : l'événement arrive avant l'étiquette de TRK-56-B → en échec, puis rejoué après l'étiquette
const eEarly = await ing('dhl-early', 'in_transit', 'TRK-56-B', '2026-10-13T09:30:00Z', sha('4'))
ok('événement reçu avant l’étiquette : journalisé « en échec », jamais perdu', eEarly.result === 'accepted' && eEarly.status === 'failed'
  && String(eEarly.error).includes('CARRIER_TRACKING_UNKNOWN'))
await as(mag, () => rpc('carrier_label_issue', S, null, 'DHL', 'TRK-56-B', 'LBL-P56-0005'))
const replay1 = (await db.query(`select public.carrier_events_replay($1, 100) r`, [company])).rows[0].r
ok('rejeu après correction : l’événement en échec s’applique une fois', replay1.applied === 1 && replay1.still_failed === 0
  && (await q(`select status from carrier_events where provider_event_id='dhl-early' and company_id=$1`, [company]))[0].status === 'applied')
const replay2 = (await db.query(`select public.carrier_events_replay($1, 100) r`, [company])).rows[0].r
ok('second rejeu : aucun événement déjà appliqué n’est rejoué', replay2.applied === 0 && replay2.still_failed === 0)
ok('rejeu unique : le transit n’apparaît qu’une fois dans le journal d’expédition', (await count(`select count(*)::int n from shipment_events where shipment_id=$1 and event_type='in_transit'`, [S])) === 2)

// --- D. Anomalie : ouverte par l'événement, résolue avec motif -------------------------------------------------------------------------------
const ex = await ing('dhl-ex', 'exception', 'TRK-56-A', '2026-10-13T10:00:00Z', sha('5'))
ok('événement d’exception accepté : anomalie ouverte', ex.status === 'applied' && (await count(`select count(*)::int n from carrier_anomalies where shipment_id=$1 and status='open'`, [S])) === 1)
const anomId = (await q(`select id from carrier_anomalies where shipment_id=$1`, [S]))[0].id
await rejects('anomalie résolue sans motif suffisant refusée (CARRIER_REASON_REQUIRED)', () => as(mag, () => rpc('carrier_anomaly_resolve', anomId, 'ok')), 'CARRIER_REASON_REQUIRED')
await as(mag, () => rpc('carrier_anomaly_resolve', anomId, 'Colis humide constaté, reprise par le transporteur'))
await rejects('anomalie déjà résolue : seconde résolution refusée (CARRIER_ANOMALY_CLOSED)', () => as(mag, () => rpc('carrier_anomaly_resolve', anomId, 'Seconde résolution tentée')), 'CARRIER_ANOMALY_CLOSED')
ok('anomalie résolue : statut, motif et auteur conservés', (await q(`select status, resolved_by=$2 by from carrier_anomalies where id=$1`, [anomId, mag]))[0].by === true)

// --- E. Livraison : facture et litige non modifiés -------------------------------------------------------------------------------------------
const complaint = await as(admin, () => rpc('complaint_open', client, order, 'Ourlet défaillant P56', 'Ourlet ouvert constaté à la réception', 'minor'))
const invId = await as(admin, () => rpc('invoice_from_shipment', S, 'INV-KEY-P56-0001'))
const invBefore = (await q(`select status from invoices where id=$1`, [invId]))[0].status
const compBefore = (await q(`select status from client_complaints where id=$1`, [complaint]))[0].status
const dl = await ing('dhl-dl', 'delivered', 'TRK-56-A', '2026-10-13T12:00:00Z', sha('6'))
ok('événement « livré » appliqué : expédition livrée avec date', dl.status === 'applied' && (await q(`select status, delivered_at is not null dt from shipments where id=$1`, [S]))[0].status === 'delivered'
  && (await q(`select delivered_at is not null dt from shipments where id=$1`, [S]))[0].dt === true)
const invAfter = (await q(`select status from invoices where id=$1`, [invId]))[0].status
const compAfter = (await q(`select status from client_complaints where id=$1`, [complaint]))[0].status
ok('livré ne règle ni la facture ni le litige : statuts inchangés', invAfter === invBefore && compAfter === compBefore && compBefore === 'open', `${invBefore}/${invAfter} ${compBefore}/${compAfter}`)

// --- F. Preuve de livraison : rattachée au client et à l'événement livré, lisible seulement si habilité ---------------------------------------
const DOC_OTHER = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,(select id from ged_folders where client_id=$2 and system_key='certifications'),'Preuve autre client',$3) returning id`, [company, clientOther, sha('f')]))[0].id
const DOC = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,(select id from ged_folders where client_id=$2 and system_key='certifications'),'Preuve de livraison P56',$3) returning id`, [company, client, sha('e')]))[0].id
const DL_ID = dl.event_id
const TRANSIT_ID = e1.event_id
await db.query(`select public.carrier_proof_attach($1,$2)`, [TRANSIT_ID, DOC]).then(() => null, (e) => e).then((err) => ok('preuve refusée pour un événement non « livré » (CARRIER_PROOF_NOT_DELIVERED)', err !== null && String(err.message).includes('CARRIER_PROOF_NOT_DELIVERED')))
await db.query(`select public.carrier_proof_attach($1,$2)`, [DL_ID, DOC_OTHER]).then(() => null, (e) => e).then((err) => ok('preuve d’un autre client refusée (CARRIER_PROOF_DOCUMENT_REQUIRED)', err !== null && String(err.message).includes('CARRIER_PROOF_DOCUMENT_REQUIRED')))
const PROOF = (await db.query(`select public.carrier_proof_attach($1,$2) r`, [DL_ID, DOC])).rows[0].r
ok('preuve de livraison rattachée (document du client, événement livré)', typeof PROOF === 'string' && (await count(`select count(*)::int n from carrier_proofs where shipment_id=$1`, [S])) === 1)
await rejects('seconde preuve pour la même expédition refusée (CARRIER_PROOF_DUPLICATE)', () => db.query(`select public.carrier_proof_attach($1,$2)`, [DL_ID, DOC]), 'CARRIER_PROOF_DUPLICATE')
const pf = await as(comm, () => rpc('carrier_proof_get', S))
ok('preuve lisible par un utilisateur habilité (expédition et document)', pf !== null && pf.title === 'Preuve de livraison P56' && pf.sha256 === sha('e'))
await rejects('preuve refusée sans droit (RBAC_FORBIDDEN)', () => as(nobody, () => rpc('carrier_proof_get', S)), 'RBAC_FORBIDDEN')
ok('premisse : le magasinier n’a pas documents.read', (await count(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='magasin' and p.code='documents.read'`, [])) === 0)
await rejects('preuve refusée à un utilisateur sans lecture des documents (RBAC_FORBIDDEN)', () => as(mag, () => rpc('carrier_proof_get', S)), 'RBAC_FORBIDDEN')
ok('preuve invisible sans droit (RLS)', (await as(nobody, () => count(`select count(*)::int n from carrier_proofs`))) === 0)

// --- G. Journaux en ajout seul, droits directs, audit ----------------------------------------------------------------------------------------
await rejects('événement appliqué modifié refusé (CARRIER_APPEND_ONLY)', () => db.query(`update carrier_events set last_error='x' where id=$1`, [DL_ID]), 'CARRIER_APPEND_ONLY')
await rejects('événement supprimé refusé (CARRIER_APPEND_ONLY)', () => db.query(`delete from carrier_events where id=$1`, [TRANSIT_ID]), 'CARRIER_APPEND_ONLY')
await rejects('étiquette modifiée refusée (CARRIER_APPEND_ONLY)', () => db.query(`update carrier_labels set label_ref='x' where shipment_id=$1`, [S]), 'CARRIER_APPEND_ONLY')
await rejects('ingestion appelée par un utilisateur refusée (permission denied)', () => as(admin, () => db.query(`select public.carrier_ingest($1,'DHL','dhl-x','TRK-56-A','in_transit',$2,'','',$3)`, [company, T1, sha('9')])), 'permission denied')
await rejects('événement inséré directement refusé (permission denied)', () => as(admin, () => db.query(`insert into carrier_events(company_id, carrier_id, provider_event_id, tracking_number, event_code, occurred_at, payload_sha256) values ($1,(select id from carriers where code='DHL'),'direct','TRK-56-A','in_transit',$2,$3)`, [company, T1, sha('8')])), 'permission denied')
ok('audit : confirmation, étiquettes (2), événements appliqués, anomalie résolue, preuve', (await count(`select count(*)::int n from audit_logs where action='carrier.confirm'`)) === 1
  && (await count(`select count(*)::int n from audit_logs where action='carrier.label_issue'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='carrier.event_applied'`)) === 4
  && (await count(`select count(*)::int n from audit_logs where action='carrier.anomaly_resolve'`)) === 1
  && (await count(`select count(*)::int n from audit_logs where action='carrier.proof_attach'`)) === 1)
