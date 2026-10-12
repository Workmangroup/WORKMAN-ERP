import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const prod = await mkUser('prod@x.com', 'production')
const qual = await mkUser('qual@x.com', 'qualite')
const achat = await mkUser('achat@x.com', 'achat')
const fin = await mkUser('fin@x.com', 'finance')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
const has = async (c, ...codes) => { const p = await perms(c); return codes.every((x) => p.includes(x)) }
ok('droits : production écrit et contrôle ; qualité contrôle sans écrire ; achat écrit avec coûts ; finance coûts sans écrire ; magasin lecture', (await has('production', 'subcontract.write', 'subcontract.qc')) && (await has('qualite', 'subcontract.qc')) && !(await has('qualite', 'subcontract.write')) && (await has('achat', 'subcontract.write', 'subcontract.costs')) && (await has('finance', 'subcontract.costs')) && !(await has('finance', 'subcontract.write')) && (await has('magasin', 'subcontract.read')) && !(await has('magasin', 'subcontract.costs')))
ok('commercial : aucun accès à la sous-traitance', !(await has('commercial', 'subcontract.read')))

// --- 1. Sous-traitants ------------------------------------------------------------------------------------------------------------------
const insSub = (u, o) => as(u, async () => (await q(`insert into subcontractors(name, services, country, city, default_lead_days) values ($1,$2,$3,$4,$5) returning *`, [o.name, o.services, o.country ?? 'TN', o.city ?? 'Sfax', o.lead ?? 10]))[0])
const broderie = await insSub(achat, { name: 'Broderie Atelier Sfax', services: ['embroidery'] })
const serig = await insSub(achat, { name: 'Sérigraphie Nabeul', services: ['screen_printing', 'printing'], city: 'Nabeul', lead: 7 })
const lav = await insSub(achat, { name: 'Lavage & finition Tunis', services: ['washing', 'finishing'], city: 'Tunis', lead: 5 })
ok('sous-traitant créé : code SST-0001, société déduite, prestations', broderie.code === 'SST-0001' && broderie.company_id === company && broderie.services[0] === 'embroidery' && serig.code === 'SST-0002')
await rejects('prestation inconnue refusée', () => insSub(achat, { name: 'Autre sous-traitant', services: ['laser'] }), 'subcontractors_services_check')
await rejects('nom en double refusé (insensible à la casse)', () => insSub(achat, { name: 'broderie atelier SFAX', services: ['embroidery'] }), 'subcontractors_name_uq')
await rejects('création refusée à la qualité (sans écriture)', () => insSub(qual, { name: 'Qualité Test', services: ['other'] }), 'row-level security')
await rejects('délai hors plage refusé', () => as(achat, () => db.query(`update subcontractors set default_lead_days=999 where id=$1`, [broderie.id])), 'subcontractors_default_lead_days_check')
await rejects('code du sous-traitant immuable', () => as(achat, () => db.query(`update subcontractors set code='X' where id=$1`, [broderie.id])), 'permission denied')

// --- 2. Produit et variantes (stock fini) ------------------------------------------------------------------------------------------------------
const cli = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const prodMaster = (await as(comm, () => q(`insert into product_master(client_id, name, family) values ($1, 'VESTE HV', 'jacket') returning *`, [cli])))[0]
const colJau = (await q(`select id from colors where code='JAU'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
const sizeM = (await q(`select id from sizes where code='M'`))[0].id
await as(comm, () => rpc('variant_generate', prodMaster.id, [colJau], [sizeS, sizeM]))
const vS = (await q(`select id from product_variants where product_id=$1 and size_id=$2`, [prodMaster.id, sizeS]))[0].id
const prod2 = (await as(comm, () => q(`insert into product_master(client_id, name, family) values ($1, 'POLO HV', 'polo') returning *`, [cli])))[0]
const colOra = (await q(`select id from colors where code='ORA'`))[0].id
await as(comm, () => rpc('variant_generate', prod2.id, [colOra], [sizeS]))
const vOther = (await q(`select id from product_variants where product_id=$1`, [prod2.id]))[0].id
const wh1 = (await q(`insert into warehouses(company_id, code, name) values ($1,'WH-S1','Atelier principal') returning id`, [company]))[0].id
const wh2 = (await q(`insert into warehouses(company_id, code, name) values ($1,'WH-S2','Dépôt Sfax') returning id`, [company]))[0].id
// affectations : le magasinier responsable, la production opératrice (écriture de stock)
for (const w of [wh1, wh2]) { await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, w]); await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, prod, w]) }
ok('produit et variante de test prêts', !!vS && !!vOther && !!wh1)

// --- 3. Commandes : création, envoi, verrouillage -----------------------------------------------------------------------------------------------
const insOrder = (u, o) => as(u, async () => (await q(`insert into subcontract_orders(subcontractor_id, service, product_id, description, qty, requested_on, due_date, notes) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
  [o.sub, o.service, o.product ?? null, o.desc ?? 'Broderie logo poitrine', o.qty ?? 20, o.req ?? day(0), o.due ?? day(14), o.notes ?? null]))[0])
const o1 = await insOrder(prod, { sub: broderie.id, service: 'embroidery', product: prodMaster.id, qty: 20 })
ok('commande créée en brouillon : SC-0001, quantités à zéro', o1.code === 'SC-0001' && o1.status === 'draft' && o1.qty_received === 0 && o1.qty_shipped === 0)
await rejects('prestation non proposée par le sous-traitant refusée', () => insOrder(prod, { sub: broderie.id, service: 'washing' }), 'SC_SERVICE_NOT_OFFERED')
await rejects('échéance antérieure à la demande refusée', () => insOrder(prod, { sub: broderie.id, service: 'embroidery', req: day(0), due: day(-3) }), 'SC_DATE_ORDER')
await rejects('produit d’une autre société refusé', async () => { const co = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id; const cl = (await q(`insert into clients(company_id, code, name, country) values ($1,'CLI-X','Autre client','FR') returning id`, [co]))[0].id; const pp = (await q(`insert into product_master(company_id, client_id, code, name) values ($1,$2,'PRD-X','Produit X') returning id`, [co, cl]))[0].id; return insOrder(prod, { sub: broderie.id, service: 'embroidery', product: pp }) }, 'SC_BAD_PRODUCT')
await rejects('statut modifié à la main refusé', () => as(prod, () => db.query(`update subcontract_orders set status='sent' where id=$1`, [o1.id])), 'permission denied')
await rejects('envoi refusé à la qualité (pas d’écriture)', () => as(qual, () => rpc('sc_order_send', o1.id, null)), 'RBAC_FORBIDDEN')
await rejects('envoi sans échéance refusé', async () => { const o = await insOrder(prod, { sub: serig.id, service: 'screen_printing', due: null }).catch(() => null); if (o) await db.query(`update subcontract_orders set due_date=null where id=$1`, [o.id]); return as(prod, () => rpc('sc_order_send', o?.id ?? o1.id, null)) }, 'SC_DUE_REQUIRED')
await as(prod, () => rpc('sc_order_send', o1.id, null))
ok('commande envoyée au sous-traitant : statut « envoyée », date d’envoi', (await q(`select status, sent_on from subcontract_orders where id=$1`, [o1.id]))[0].status === 'sent' && (await q(`select sent_on from subcontract_orders where id=$1`, [o1.id]))[0].sent_on)
await rejects('quantité modifiée après envoi refusée', () => as(prod, () => db.query(`update subcontract_orders set qty=30 where id=$1`, [o1.id])), 'SC_ORDER_LOCKED')
await as(prod, () => db.query(`update subcontract_orders set notes='Livraison en 2 lots souhaitée' where id=$1`, [o1.id]))
ok('notes modifiables après envoi', (await q(`select notes from subcontract_orders where id=$1`, [o1.id]))[0].notes.includes('2 lots'))

// --- 4. Envois ---------------------------------------------------------------------------------------------------------------------------------------
await rejects('envoi au-delà de la commande refusé', () => as(prod, () => rpc('sc_shipment_add', o1.id, 25, day(0), 'DHL', null)), 'SC_OVER_QTY')
await rejects('envoi saisi directement refusé (passer par la RPC)', () => as(prod, () => db.query(`insert into subcontract_shipments(company_id, order_id, number, qty, shipped_on) values ($1,$2,1,5,current_date)`, [company, o1.id])), 'permission denied')
const s1 = await as(prod, () => rpc('sc_shipment_add', o1.id, 12, day(0), 'DHL', 'DHL-778812'))
const s2 = await as(prod, () => rpc('sc_shipment_add', o1.id, 8, day(0), 'Transporteur local', 'TL-0042'))
const shipments = await q(`select number, qty, tracking from subcontract_shipments where order_id=$1 order by number`, [o1.id])
ok('envois numérotés 1 et 2 (12 + 8 = 20), suivi transporteur', shipments.map((s) => `${s.number}:${s.qty}`).join() === '1:12,2:8' && shipments[0].tracking === 'DHL-778812' && (await q(`select qty_shipped from subcontract_orders where id=$1`, [o1.id]))[0].qty_shipped === 20)

// coûts de la commande 1 (avant clôture)
await as(achat, () => db.query(`insert into subcontract_costs(order_id, kind, description, quantity, unit_cost, incurred_on) values ($1,'service','Broderie 20 pièces',20,1.85,current_date)`, [o1.id]))
ok('coût de prestation : montant calculé (20 × 1,85 = 37,00)', (await q(`select amount::float a from subcontract_costs where order_id=$1 and kind='service'`, [o1.id]))[0].a === 37)
await rejects('deuxième prestation sur la même commande refusée', () => as(achat, () => db.query(`insert into subcontract_costs(order_id, kind, description, quantity, unit_cost) values ($1,'service','Doublon',1,1)`, [o1.id])), 'sc_costs_one_service_uq')
await as(achat, () => db.query(`insert into subcontract_costs(order_id, shipment_id, kind, description, quantity, unit_cost, incurred_on) values ($1,$2,'shipping','Transport DHL',1,12.5,current_date)`, [o1.id, s1]))

// --- 5. Réceptions ---------------------------------------------------------------------------------------------------------------------------------------
await rejects('réception supérieure à l’envoi refusée (reçu ≤ envoyé)', async () => { await as(prod, () => rpc('sc_receipt_add', o1.id, 15, day(0), null)); return as(prod, () => rpc('sc_receipt_add', o1.id, 10, day(0), null)) }, 'SC_RECEIPT_EXCEEDS_SHIPMENT')
const rA = (await q(`select id from subcontract_receipts where order_id=$1`, [o1.id]))[0].id
ok('première réception (15 pièces) : commande « partiellement reçue »', (await q(`select status, qty_received from subcontract_orders where id=$1`, [o1.id]))[0].status === 'partially_received' && (await q(`select qc_status from subcontract_receipts where id=$1`, [rA]))[0].qc_status === 'pending')
const rB = await as(prod, () => rpc('sc_receipt_add', o1.id, 5, day(0), s2))
ok('réception complète (5 pièces, lot 2) : commande « reçue »', (await q(`select status, qty_received from subcontract_orders where id=$1`, [o1.id]))[0].status === 'received' && (await q(`select number from subcontract_receipts where id=$1`, [rB]))[0].number === 2)
await rejects('envoi supplémentaire refusé une fois la commande reçue', () => as(prod, () => rpc('sc_shipment_add', o1.id, 1, day(0), null, null)), 'SC_BAD_STATUS')
await rejects('réception saisie directement refusée', () => as(prod, () => db.query(`insert into subcontract_receipts(company_id, order_id, number, qty_received, received_on) values ($1,$2,9,1,current_date)`, [company, o1.id])), 'permission denied')

// --- 6. Contrôle qualité -------------------------------------------------------------------------------------------------------------------------------------
await rejects('contrôle : accepté + rejeté doit égaler le reçu', () => as(qual, () => rpc('sc_receipt_qc', rA, 14, 2, null)), 'SC_QC_SUM')
await rejects('contrôle réservé au droit qualité (achat refusé)', () => as(achat, () => rpc('sc_receipt_qc', rA, 14, 1, null)), 'RBAC_FORBIDDEN')
await as(qual, () => rpc('sc_receipt_qc', rA, 14, 1, 'Quelques fils cassés sur 1 pièce'))
ok('contrôle partiel : 14 acceptées, 1 rejetée', (await q(`select qc_status, qty_accepted, qty_rejected from subcontract_receipts where id=$1`, [rA]))[0].qc_status === 'partial')
await rejects('contrôle déjà fait : non renouvelable', () => as(qual, () => rpc('sc_receipt_qc', rA, 15, 0, null)), 'SC_BAD_STATUS')
await as(qual, () => rpc('sc_receipt_qc', rB, 5, 0, null))
ok('contrôle complet du lot 2 : accepté', (await q(`select qc_status from subcontract_receipts where id=$1`, [rB]))[0].qc_status === 'accepted')
ok('cumul sur la commande : 19 acceptées, 1 rejetée', (await q(`select qty_accepted, qty_rejected from subcontract_orders where id=$1`, [o1.id]))[0].qty_accepted === 19)

// --- 7. Entrée en stock ----------------------------------------------------------------------------------------------------------------------------------------
await rejects('clôture refusée tant que les retours ne sont pas en stock', () => as(prod, () => rpc('sc_order_close', o1.id)), 'SC_STOCK_PENDING')
await rejects('entrée en stock d’un article d’un autre produit refusée', () => as(prod, () => rpc('sc_receipt_stock', rA, vOther, wh1)), 'SC_BAD_VARIANT')
await rejects('entrée en stock sans droit de stock variantes refusée (qualité)', () => as(qual, () => rpc('sc_receipt_stock', rA, vS, wh1)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('sc_receipt_stock', rA, vS, wh1))
await as(prod, () => rpc('sc_receipt_stock', rB, vS, wh2))
const stockS = await q(`select warehouse_id, qty_on_hand from variant_stock where variant_id=$1 order by qty_on_hand`, [vS])
ok('entrée en stock : 14 pièces au premier entrepôt, 5 au second (seules les acceptées)', stockS.reduce((a, s) => a + s.qty_on_hand, 0) === 19 && stockS.length === 2)
await rejects('retour déjà en stock : pas de double entrée', () => as(prod, () => rpc('sc_receipt_stock', rA, vS, wh1)), 'SC_BAD_STATUS')
await rejects('clôture refusée avec un retour à contrôler', async () => { const o = await insOrder(prod, { sub: broderie.id, service: 'embroidery', product: prodMaster.id, qty: 4 }); await as(prod, () => rpc('sc_order_send', o.id, null)); await as(prod, () => rpc('sc_shipment_add', o.id, 4, day(0), null, null)); await as(prod, () => rpc('sc_receipt_add', o.id, 4, day(0), null)); return as(prod, () => rpc('sc_order_close', o.id)) }, 'SC_QC_PENDING')
await as(prod, () => rpc('sc_order_close', o1.id))
ok('commande clôturée (retours contrôlés et entrés en stock)', (await q(`select status, closed_at from subcontract_orders where id=$1`, [o1.id]))[0].status === 'closed' && (await q(`select closed_at from subcontract_orders where id=$1`, [o1.id]))[0].closed_at)
await rejects('commande clôturée : plus d’envoi', () => as(prod, () => rpc('sc_shipment_add', o1.id, 1, day(0), null, null)), 'SC_BAD_STATUS')
await rejects('commande clôturée : plus de modification', () => as(prod, () => db.query(`update subcontract_orders set notes='x' where id=$1`, [o1.id])), 'SC_ORDER_CLOSED')

// --- 8. Autres scénarios : rejet total, annulation, retard ----------------------------------------------------------------------------------------------
const o3 = await insOrder(prod, { sub: lav.id, service: 'washing', product: prodMaster.id, qty: 10, desc: 'Lavage prélavage lot 12', due: day(14) })
await as(prod, () => rpc('sc_order_send', o3.id, null))
await as(prod, () => rpc('sc_shipment_add', o3.id, 10, day(0), null, null))
const r3 = await as(prod, () => rpc('sc_receipt_add', o3.id, 10, day(0), null))
await as(qual, () => rpc('sc_receipt_qc', r3, 0, 10, 'Teinte délavée, renvoi refusé'))
await as(achat, () => db.query(`insert into subcontract_costs(order_id, kind, description, quantity, unit_cost) values ($1,'service','Lavage 10 pièces',10,0.9)`, [o3.id]))
await as(prod, () => rpc('sc_order_close', o3.id))
ok('retour entièrement rejeté : pas d’entrée en stock nécessaire, commande clôturée', (await q(`select status, qty_rejected from subcontract_orders where id=$1`, [o3.id]))[0].status === 'closed' && (await q(`select qc_status from subcontract_receipts where id=$1`, [r3]))[0].qc_status === 'rejected')

const o2 = await insOrder(prod, { sub: serig.id, service: 'screen_printing', product: prod2.id, qty: 30, desc: 'Sérigraphie logo dos', due: day(7) })
await rejects('annulation sans motif refusée', () => as(prod, () => rpc('sc_order_cancel', o2.id, 'ok')), 'SC_REASON_REQUIRED')
await as(prod, () => rpc('sc_order_cancel', o2.id, 'Client a changé de logo'))
ok('commande annulée avec son motif', (await q(`select status, cancel_reason from subcontract_orders where id=$1`, [o2.id]))[0].cancel_reason === 'Client a changé de logo')
await rejects('commande annulée : plus d’envoi', () => as(prod, () => rpc('sc_order_send', o2.id, null)), 'SC_BAD_STATUS')

const o4 = await insOrder(prod, { sub: lav.id, service: 'finishing', product: prod2.id, qty: 8, desc: 'Finition boutons et étiquettes', req: day(-20), due: day(-5) })
await as(prod, () => rpc('sc_order_send', o4.id, null))
await rejects('annulation refusée après expédition', async () => { const o = await insOrder(prod, { sub: serig.id, service: 'printing', qty: 5, due: day(10) }); await as(prod, () => rpc('sc_order_send', o.id, null)); await as(prod, () => rpc('sc_shipment_add', o.id, 5, day(0), null, null)); return as(prod, () => rpc('sc_order_cancel', o.id, 'Trop tard')) }, 'SC_BAD_STATUS')
ok('commande en retard détectée (échéance dépassée, non reçue)', (await q(`select count(*)::int n from subcontract_orders where id=$1 and status='sent' and due_date < current_date`, [o4.id]))[0].n === 1)

// --- 9. Coûts ----------------------------------------------------------------------------------------------------------------------------------------------------
ok('frais de transport rattachés à un envoi', (await q(`select amount::float a from subcontract_costs where order_id=$1 and kind='shipping'`, [o1.id]))[0].a === 12.5)
await rejects('coût refusé à la qualité (sans droit coûts)', () => as(qual, () => db.query(`insert into subcontract_costs(order_id, kind, description, quantity, unit_cost) values ($1,'other','Test',1,1)`, [o4.id])), 'row-level security')
ok('coûts invisibles pour la qualité, visibles pour l’achat et la finance', (await as(qual, () => q(`select id from subcontract_costs`))).length === 0 && (await as(achat, () => q(`select id from subcontract_costs`))).length === 3 && (await as(fin, () => q(`select id from subcontract_costs`))).length === 3)
await rejects('coût refusé sur une commande clôturée', () => as(achat, () => db.query(`insert into subcontract_costs(order_id, kind, description, quantity, unit_cost) values ($1,'other','Tard',1,1)`, [o1.id])), 'SC_ORDER_CLOSED')

// --- 10. Tableau de bord et performance ---------------------------------------------------------------------------------------------------------------------
const dAchat = await as(achat, () => rpc('subcontract_dashboard'))
const dQual = await as(qual, () => rpc('subcontract_dashboard'))
const nOrders = (await q(`select count(*)::int n from subcontract_orders where company_id=$1 and status<>'cancelled'`, [company]))[0].n
ok('tableau de bord : commandes (hors annulées), en retard (1), en cours (3 : retour à contrôler, expédiée, en retard)', dAchat.kpi.orders === nOrders && dAchat.kpi.overdue === 1 && dAchat.kpi.open === 3, JSON.stringify(dAchat.kpi))
ok('tableau de bord : taux de ponctualité 100 % (2 commandes reçues dans les temps)', Number(dAchat.kpi.on_time_rate) === 100, String(dAchat.kpi.on_time_rate))
ok('tableau de bord : taux de rejet = 11 rejetées / 30 contrôlées (36,7 %)', Number(dAchat.kpi.rejection_rate) === 36.7, String(dAchat.kpi.rejection_rate))
ok('tableau de bord : coûts et coût par pièce visibles pour l’achat (49,50 € de frais, 19 pièces acceptées)', Number(dAchat.kpi.cost_total) === 49.5 + 9 && Number(dAchat.kpi.cost_per_piece) > 0, JSON.stringify([dAchat.kpi.cost_total, dAchat.kpi.cost_per_piece]))
ok('tableau de bord : coûts absents pour la qualité', dQual.kpi.cost_total === undefined && dQual.kpi.cost_per_piece === undefined && dQual.costs_by_month === undefined && dQual.top_subcontractors === undefined)
ok('tableau de bord : prestations, retards et historique mensuel', dAchat.by_service.length === 6 && dAchat.overdue[0].code === o4.code && dAchat.by_month.length === 6 && Object.keys(dAchat.by_status).length >= 3)
ok('tableau de bord : un retour attend son contrôle qualité (liste et compteur)', dAchat.pending_qc.length === 1 && dAchat.kpi.pending_qc === 1)
const perf = await as(achat, () => rpc('subcontractor_performance'))
const pB = perf.find((p) => p.code === 'SST-0001'), pL = perf.find((p) => p.code === 'SST-0003')
ok('performance broderie : 2 commandes, 24 reçues, 2 dans les temps, rejet 5 % (1 / 20 contrôlées)', pB.orders === 2 && pB.qty_received === 24 && Number(pB.on_time) === 2 && Number(pB.rejection_rate) === 5, JSON.stringify(pB))
ok('performance lavage : 2 commandes, 1 livrée à l’heure, retour total rejeté (rejet 100 %)', pL.orders === 2 && Number(pL.delivered) === 1 && Number(pL.on_time) === 1 && Number(pL.rejection_rate) === 100, JSON.stringify(pL))
ok('performance : coût par pièce et coût total visibles pour l’achat seul', Number(pB.cost_total) === 49.5 && pB.cost_per_piece !== undefined && (await as(qual, () => rpc('subcontractor_performance'))).find((p) => p.code === 'SST-0001').cost_total === null)
ok('performance : la commande annulée n’est pas comptée (seule l’expédiée compte)', perf.find((p) => p.code === 'SST-0002').orders === 1)

// --- 11. Historique, isolation, droits de lecture ----------------------------------------------------------------------------------------------------------------
const acts = new Set((await q(`select action from audit_logs where entity_type in ('subcontractor','subcontract')`)).map((r) => r.action))
for (const a of ['subcontractor.create', 'subcontract.create', 'subcontract.send', 'subcontract.shipment', 'subcontract.receipt', 'subcontract.qc', 'subcontract.stock', 'subcontract.close', 'subcontract.cancel', 'subcontract.cost_add', 'subcontract.update'])
  ok(`historique : ${a}`, acts.has(a))
const costAudit = JSON.stringify(await q(`select metadata, before_data, after_data from audit_logs where action like 'subcontract.cost_%'`))
ok('historique : aucun montant de coût ni prix unitaire tracé', !/unit_cost|"amount"|quantity|1\.85|12\.5/.test(costAudit))
ok('historique lisible avec subcontract.read (qualité), pas sans', (await as(qual, () => q(`select id from audit_logs where entity_type='subcontract'`))).length > 0 && (await as(nobody, () => q(`select id from audit_logs where entity_type='subcontract'`))).length === 0)
await rejects('historique append-only', () => as(admin, () => db.query(`delete from audit_logs where entity_type='subcontract'`)), 'permission denied')
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
await db.exec(`alter table subcontractors disable trigger subcontractors_before_iu`)
await db.query(`insert into subcontractors(company_id, code, name, services) values ($1,'SST-9001','Étranger','{other}')`, [co2])
await db.exec(`alter table subcontractors enable trigger subcontractors_before_iu`)
ok('isolation entre sociétés : sous-traitants et commandes', (await as(admin, () => q(`select id from subcontractors where code='SST-9001'`))).length === 0 && (await as(admin, () => q(`select id from subcontract_orders where company_id=$1`, [co2]))).length === 0)
ok('sans droit : aucune lecture des sous-traitants, envois ni retours', (await as(nobody, () => q(`select id from subcontractors`))).length === 0 && (await as(mag, () => q(`select id from subcontract_receipts`))).length > 0 && (await as(nobody, () => q(`select id from subcontract_receipts`))).length === 0)
await rejects('tableau de bord refusé sans droit', () => as(nobody, () => rpc('subcontract_dashboard')), 'RBAC_FORBIDDEN')

process.exit(process.exitCode ?? 0)
