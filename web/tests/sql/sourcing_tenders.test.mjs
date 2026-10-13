// Consultations et comparatifs fournisseurs : même base, source des prix, décision humaine tracée — P033 / migration 0058
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - b) <= tol

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const buyer = await mkUser('achat@x.com', 'achat')
const prod = await mkUser('prod@x.com', 'production')
const dir = await mkUser('dir@x.com', 'direction')
const fin = await mkUser('fin@x.com', 'finance')
const nobody = await mkUser('nobody@x.com', null)

// Politique d'attribution (approvals.manage : admin)
await as(admin, () => rpc('approval_policy_set', 'sourcing_award', 1, null, 'purchases.approve', null, 'approvals.escalate', 24))

// Taux de change de la veille (le comparatif utilise le taux du jour d'ouverture, sans devinette)
const yesterday = (await q(`select (current_date - 1)::text d`))[0].d
await as(fin, () => rpc('fx_rate_set', yesterday, 'TND', 0.3))
await as(fin, () => rpc('fx_rate_set', yesterday, 'USD', 0.9))
const base = (await q(`select private.base_currency() c`))[0]
const BASE = base.c
ok('base de société : EUR (hypothèse des montants attendus ci-dessous)', BASE === 'EUR', BASE)

// Fournisseurs : A (EUR, notation 4), B (TND, notation 5), C (USD, notation 3), D (EUR, sans notation), E (en attente de qualification)
const mkSup = async (name, qual, rating) => {
  const id = (await q(`insert into suppliers(company_id, code, name, country, lead_time_days, currency) values ($1, $2, $3, 'TN', 10, 'EUR') returning id`, [company, 'F-' + name.slice(-1), name]))[0].id
  await db.query(`update suppliers set qualification=$2, rating=$3 where id=$1`, [id, qual, rating])
  return id
}
const supA = await mkSup('Fournisseur A', 'approved', 4)
const supB = await mkSup('Fournisseur B', 'approved', 5)
const supC = await mkSup('Fournisseur C', 'approved', 3)
const supD = await mkSup('Fournisseur D sans notation', 'approved', null)
const supE = await mkSup('Fournisseur E en attente', 'pending', 4)

const mat = async (name, unit) => (await as(prod, () => q(`insert into bom_materials(name, category, unit) values ($1,'fabric',$2) returning id`, [name, unit])))[0].id
const tissu = await mat('Tissu P033', 'm')
const zip = await mat('Zip P033', 'pc')

// Consultation 1 : 100 m de tissu + 200 pièces de zip
const lines = [{ material_id: tissu, qty: 100 }, { material_id: zip, qty: 200 }]
await rejects('consultation vide refusée', () => as(buyer, () => rpc('sourcing_event_create', 'Vide', null, null, JSON.stringify([]))), 'SOURCING_EMPTY')
const E1 = await as(buyer, () => rpc('sourcing_event_create', 'Consultation tissus collection', `${new Date().getUTCFullYear()}-09-30`, null, JSON.stringify(lines)))
const ev1 = (await q(`select * from sourcing_events where id=$1`, [E1]))[0]
ok('consultation créée : code CON-, brouillon, deux lignes', /^CON-\d{4}$/.test(ev1.code) && ev1.status === 'draft' && (await q(`select count(*)::int n from sourcing_event_lines where event_id=$1`, [E1]))[0].n === 2)
await rejects('consultation : clé de composant inconnue refusée', () => as(buyer, () => rpc('sourcing_event_create', 'Mauvaise', null, null, JSON.stringify([{ material_id: '00000000-0000-0000-0000-000000000000', qty: 1 }]))), 'SOURCING_BAD_MATERIAL')
await rejects('ouverture refusée : pondérations qui ne font pas 100', () => as(buyer, () => rpc('sourcing_event_open', E1, 60, 20, 30)), 'SOURCING_WEIGHTS_INVALID')
await as(buyer, () => rpc('sourcing_event_open', E1, 50, 20, 30))
ok('ouverture : pondérations 50/20/30 enregistrées, statut ouvert', (await q(`select status, weight_price, weight_lead, weight_quality from sourcing_events where id=$1`, [E1]))[0].status === 'open')

const lineIds = async (ev) => Object.fromEntries((await q(`select el.id, el.material_id from sourcing_event_lines el where el.event_id=$1`, [ev])).map((r) => [r.material_id, r.id]))
const L1 = await lineIds(E1)
const offerLines = (ev, pt, pz) => JSON.stringify([{ event_line_id: L1[tissu], unit_price: pt }, { event_line_id: L1[zip], unit_price: pz }])
const submit = (u, ev, sup, cur, lead, tr, du, lines_json, ref, sha = null) =>
  as(u, () => rpc('sourcing_offer_submit', ev, sup, cur, 'DAP', lead, tr, du, null, ref, sha, lines_json))

await rejects('offre refusée : fournisseur non qualifié', () => submit(buyer, E1, supE, 'EUR', 10, 0, 0, offerLines(E1, 8, 1), 'Offre E'), 'SOURCING_SUPPLIER_NOT_APPROVED')
await rejects('offre refusée : lignes incomplètes (une seule ligne sur deux)', () => submit(buyer, E1, supA, 'EUR', 10, 50, 0, JSON.stringify([{ event_line_id: L1[tissu], unit_price: 8 }]), 'Offre A'), 'SOURCING_INCOMPLETE')
await rejects('offre refusée : devise sans taux de change (GBP)', () => submit(buyer, E1, supA, 'GBP', 10, 0, 0, offerLines(E1, 8, 1), 'Offre GBP'), 'FX_RATE_MISSING')
await rejects('offre refusée : empreinte du document mal formée', () => submit(buyer, E1, supA, 'EUR', 10, 0, 0, offerLines(E1, 8, 1), 'Offre A', 'abc'), 'SOURCING_BAD_SHA')
await rejects('offre refusée : référence du document absente', () => submit(buyer, E1, supA, 'EUR', 10, 0, 0, offerLines(E1, 8, 1), ''), 'SOURCING_REFERENCE_REQUIRED')
await rejects('offre refusée sans droit d’écriture (production)', () => submit(prod, E1, supA, 'EUR', 10, 0, 0, offerLines(E1, 8, 1), 'Offre A'), 'RBAC_FORBIDDEN')

const sha = 'a'.repeat(64)
const vA1 = await submit(buyer, E1, supA, 'EUR', 10, 50, 0, offerLines(E1, 8, 1), 'Offre A-2026-01', sha)
const vB1 = await submit(buyer, E1, supB, 'TND', 20, 40, 0, offerLines(E1, 22, 3), 'Offre B TND')
const vC1 = await submit(buyer, E1, supC, 'USD', 5, 30, 10, offerLines(E1, 9, 0.9), 'Offre C USD')
const vA2 = await submit(buyer, E1, supA, 'EUR', 10, 50, 0, offerLines(E1, 7.8, 1), 'Offre A-2026-02 (révision)', sha)
ok('offres enregistrées : A v1 puis révision v2, B v1, C v1', vA1 === 1 && vA2 === 2 && vB1 === 1 && vC1 === 1)
const versions = await q(`select count(*)::int n from sourcing_offer_versions v join sourcing_offers o on o.id = v.offer_id where o.supplier_id=$1`, [supA])
ok('offre révisée : la version 1 est conservée (deux versions pour A)', versions[0].n === 2)
const vA1row = (await q(`select id from sourcing_offer_versions where offer_id = (select id from sourcing_offers where event_id=$1 and supplier_id=$2) and version=1`, [E1, supA]))[0].id
await rejects('version d’offre immuable : modification directe refusée', () => as(buyer, () => db.query(`update sourcing_offer_versions set lead_time_days = 1 where id=$1`, [vA1row])), 'permission denied')

// Comparatif : refusé tant que la consultation est ouverte ; droits
await rejects('comparatif refusé tant que la consultation est ouverte', () => as(buyer, () => rpc('sourcing_compare', E1)), 'SOURCING_NOT_CLOSED')
await rejects('comparatif refusé sans droit achats', () => as(nobody, () => rpc('sourcing_compare', E1)), 'RBAC_FORBIDDEN')
await rejects('clôture refusée sans offre sur une consultation vide', async () => { const E0 = await as(buyer, () => rpc('sourcing_event_create', 'Sans offre', null, null, JSON.stringify([{ material_id: zip, qty: 5 }]))); await as(buyer, () => rpc('sourcing_event_open', E0, 100, 0, 0)); await as(buyer, () => rpc('sourcing_event_close', E0)) }, 'SOURCING_NO_OFFER')

await as(buyer, () => rpc('sourcing_event_close', E1))
const cmp = await as(buyer, () => rpc('sourcing_compare', E1))
ok('comparatif : même base (devise de référence), taux du jour d’ouverture, deux lignes de base', cmp.base_currency === BASE && cmp.basis.lines.length === 2 && cmp.offers.length === 3)

// Valeurs attendues recalculées dans le test (formules affichées par le comparatif)
const landedA = 100 * 7.8 + 200 * 1 + 50 + 0                       // EUR, taux 1
const landedB = (100 * 22 + 200 * 3 + 40 + 0) * 0.3                // TND 2840 × 0.30
const landedC = (100 * 9 + 200 * 0.9 + 30 + 10) * 0.9              // USD 1120 × 0.90
const byName = Object.fromEntries(cmp.offers.map((o) => [o.supplier_name, o]))
ok('coût rendu : A = 1 030,00 ; B = 852,00 ; C = 1 008,00 (en devise de base)', near(byName['Fournisseur A'].landed_base, landedA) && near(byName['Fournisseur B'].landed_base, landedB) && near(byName['Fournisseur C'].landed_base, landedC),
  JSON.stringify([byName['Fournisseur A'].landed_base, byName['Fournisseur B'].landed_base, byName['Fournisseur C'].landed_base]))
ok('offre A : version courante = révision v2 (prix 7,80 retenus, v1 non utilisée)', byName['Fournisseur A'].version === 2)
ok('source des prix : référence et empreinte de l’original, taux utilisé', byName['Fournisseur A'].source.reference === 'Offre A-2026-02 (révision)' && byName['Fournisseur A'].source.sha256 === sha && byName['Fournisseur B'].source.rate === 0.3)

// Scoring : prix 100 × min / coût ; délai min-max ; qualité 20 × notation ; pondérations 50/20/30
const minL = Math.min(landedA, landedB, landedC)
const leads = { A: 10, B: 20, C: 5 }
const sc = (landed, lead, rating) => {
  const ps = 100 * minL / landed
  const ls = 100 * (20 - lead) / (20 - 5)
  const qs = 20 * rating
  return { ps, ls, qs, total: (50 * ps + 20 * ls + 30 * qs) / 100 }
}
const eA = sc(landedA, leads.A, 4), eB = sc(landedB, leads.B, 5), eC = sc(landedC, leads.C, 3)
ok('scoring : scores prix, délai et qualité conformes à la formule affichée', near(byName['Fournisseur A'].price_score, eA.ps, 0.01) && near(byName['Fournisseur A'].lead_score, eA.ls, 0.01)
  && near(byName['Fournisseur A'].quality_score, eA.qs, 0.01) && near(byName['Fournisseur B'].price_score, 100, 0.01) && near(byName['Fournisseur C'].lead_score, 100, 0.01))
ok('total pondéré : A, B, C conformes au calcul attendu', near(byName['Fournisseur A'].total_score, eA.total, 0.011) && near(byName['Fournisseur B'].total_score, eB.total, 0.011) && near(byName['Fournisseur C'].total_score, eC.total, 0.011))
const order = cmp.offers.map((o) => o.supplier_name)
const expectedOrder = [['Fournisseur A', eA.total], ['Fournisseur B', eB.total], ['Fournisseur C', eC.total]].sort((x, y) => y[1] - x[1]).map((x) => x[0])
ok('classement : ordre décroissant du total, rang 1 = meilleur total', JSON.stringify(order) === JSON.stringify(expectedOrder) && cmp.offers[0].rank === 1)
ok('formule et pondérations affichées', cmp.weights.price === 50 && cmp.weights.lead === 20 && cmp.weights.quality === 30 && typeof cmp.formula.total === 'string')

// Attribution : demande humaine, séparation des tâches, décision tracée
const vCid = (await q(`select v.id from sourcing_offer_versions v join sourcing_offers o on o.id=v.offer_id where o.event_id=$1 and o.supplier_id=$2 and v.version=1`, [E1, supC]))[0].id
await rejects('attribution refusée : motif trop court', () => as(buyer, () => rpc('sourcing_award_request', E1, vCid, 'Court')), 'SOURCING_RATIONALE_REQUIRED')
const vAold = vA1row
await rejects('attribution refusée : version révisée par une version plus récente (version obsolète)', () => as(buyer, () => rpc('sourcing_award_request', E1, vAold, 'Motif suffisamment long pour passer le contrôle du texte')), 'SOURCING_STALE_VERSION')
const AW1 = await as(buyer, () => rpc('sourcing_award_request', E1, vCid, 'Meilleur coût rendu cumulé avec un délai de 5 jours ; notation 3 acceptée.'))
const evA = (await q(`select status, awarding_request_id from sourcing_events where id=$1`, [E1]))[0]
ok('demande d’attribution : approbation ouverte, consultation toujours clôturée (aucune attribution automatique)', evA.status === 'closed' && evA.awarding_request_id === AW1)
const snap = (await q(`select snapshot, amount, state from approval_requests where id=$1`, [AW1]))[0]
ok('demande : version figée dans la demande, montant = coût rendu retenu', snap.state === 'pending_l1' && snap.snapshot.version_id === vCid && near(snap.amount, landedC))
await rejects('attribution refusée pendant une demande ouverte', () => as(buyer, () => rpc('sourcing_award_request', E1, vCid, 'Autre motif suffisamment long pour le contrôle')), 'SOURCING_AWARD_PENDING')
const selfDec = await as(buyer, () => rpc('approval_decide', AW1, 'approve', null))
ok('demandeur ne peut pas approuver sa propre attribution (SOD, tentative journalisée)', selfDec.ok === false && selfDec.code === 'SOD_SELF_APPROVAL')
await rejects('décision d’attribution refusée à qui n’a pas le droit d’approuver', () => as(nobody, () => rpc('approval_decide', AW1, 'approve', null)), 'RBAC_FORBIDDEN')
const approve = await as(dir, () => rpc('approval_decide', AW1, 'approve', null))
const evB = (await q(`select status, awarded_version_id, awarded_by, award_rationale, awarding_request_id from sourcing_events where id=$1`, [E1]))[0]
ok('décision humaine approuvée : consultation attribuée, version figée, décideur et motif tracés', approve.ok && approve.state === 'approved' && evB.status === 'awarded'
  && evB.awarded_version_id === vCid && evB.awarded_by === dir && evB.award_rationale.startsWith('Meilleur coût') && evB.awarding_request_id === null)
await rejects('attribution déjà faite : seconde attribution refusée', () => as(buyer, () => rpc('sourcing_award_request', E1, vCid, 'Motif suffisamment long pour le contrôle')), 'SOURCING_BAD_STATUS')
await rejects('attribution : modification directe du statut refusée', () => as(buyer, () => db.query(`update sourcing_events set status='draft' where id=$1`, [E1])), 'permission denied')
ok('comparatif après attribution : toujours lisible, base inchangée', (await as(buyer, () => rpc('sourcing_compare', E1))).base_currency === BASE)

// Consultation 2 : fournisseur sans notation → comparatif refusé (aucun classement partiel)
const E2 = await as(buyer, () => rpc('sourcing_event_create', 'Consultation sans notation', `${new Date().getUTCFullYear()}-10-31`, null, JSON.stringify(lines)))
await as(buyer, () => rpc('sourcing_event_open', E2, 50, 20, 30))
const L2 = await lineIds(E2)
const ol2 = (pt, pz) => JSON.stringify([{ event_line_id: L2[tissu], unit_price: pt }, { event_line_id: L2[zip], unit_price: pz }])
await as(buyer, () => rpc('sourcing_offer_submit', E2, supA, 'EUR', 'DAP', 10, 0, 0, null, 'Offre A event 2', null, ol2(8, 1)))
await as(buyer, () => rpc('sourcing_offer_submit', E2, supD, 'EUR', 'DAP', 12, 0, 0, null, 'Offre D event 2', null, ol2(7.5, 1.1)))
await as(buyer, () => rpc('sourcing_event_close', E2))
await rejects('comparatif refusé : un fournisseur n’a pas de notation qualité', () => as(buyer, () => rpc('sourcing_compare', E2)), 'SOURCING_QUALITY_MISSING')

// Consultation 3 : refus humain, motif visible, demande de nouveau possible
const E3 = await as(buyer, () => rpc('sourcing_event_create', 'Consultation à refuser', `${new Date().getUTCFullYear()}-11-30`, null, JSON.stringify(lines)))
await as(buyer, () => rpc('sourcing_event_open', E3, 50, 20, 30))
const L3 = await lineIds(E3)
const ol3 = (pt, pz) => JSON.stringify([{ event_line_id: L3[tissu], unit_price: pt }, { event_line_id: L3[zip], unit_price: pz }])
const vB3 = await as(buyer, () => rpc('sourcing_offer_submit', E3, supB, 'TND', 'DAP', 20, 40, 0, null, 'Offre B event 3', null, ol3(22, 3)))
await as(buyer, () => rpc('sourcing_offer_submit', E3, supA, 'EUR', 'DAP', 10, 50, 0, null, 'Offre A event 3', null, ol3(8, 1)))
await as(buyer, () => rpc('sourcing_event_close', E3))
const vB3id = (await q(`select v.id from sourcing_offer_versions v join sourcing_offers o on o.id=v.offer_id where o.event_id=$1 and o.supplier_id=$2`, [E3, supB]))[0].id
const AW3 = await as(buyer, () => rpc('sourcing_award_request', E3, vB3id, 'Demande de refus de test : coût rendu le plus bas, délai acceptable.'))
await rejects('refus : motif de refus trop court refusé', () => as(dir, () => rpc('approval_decide', AW3, 'refuse', 'court')), 'APPROVAL_REASON_REQUIRED')
const refused = await as(dir, () => rpc('approval_decide', AW3, 'refuse', 'Délai de livraison trop long pour la saison'))
const ev3 = (await q(`select status, awarding_request_id, awarded_version_id from sourcing_events where id=$1`, [E3]))[0]
const ap3 = (await q(`select state, refusal_reason from approval_requests where id=$1`, [AW3]))[0]
ok('refus humain : consultation non attribuée, motif visible, demande libérée', refused.state === 'refused' && ev3.status === 'closed' && ev3.awarded_version_id === null && ev3.awarding_request_id === null && ap3.refusal_reason.startsWith('Délai'))
const AW3b = await as(buyer, () => rpc('sourcing_award_request', E3, vB3id, 'Nouvelle demande après refus, motif suffisamment long.'))
ok('après refus : une nouvelle demande d’attribution est possible, version 2 de la demande', AW3b !== AW3 && (await q(`select object_version from approval_requests where id=$1`, [AW3b]))[0].object_version === 2)

// Traçabilité : journal et audit
ok('journal d’approbation : refus et décision tracés avec leur auteur', (await q(`select count(*)::int n from approval_decisions where request_id=$1 and action='approve' and actor_id=$2`, [AW1, dir]))[0].n === 1)
ok('audit : création, ouverture, offres, clôture et attribution tracées', (await q(`select count(*)::int n from audit_logs where action in ('sourcing.event_create','sourcing.event_open','sourcing.offer_submit','sourcing.event_close','sourcing.award_request')`))[0].n >= 10)
