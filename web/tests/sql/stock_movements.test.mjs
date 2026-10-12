import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const op = await mkUser('op@x.com', 'magasin')
const vw = await mkUser('vw@x.com', 'commercial')
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null, revoked_by=null`, [company, u, wh, r])
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

// --- 0. Permissions -----------------------------------------------------------------------------------------------------------------
ok('admin et direction : stock.approve + stock.approve_high', (await perms('admin')).includes('stock.approve_high') && (await perms('direction')).includes('stock.approve_high'))
ok('magasin : stock.approve (niveau 1) sans niveau 2', (await perms('magasin')).includes('stock.approve') && !(await perms('magasin')).includes('stock.approve_high'))
ok('commercial : aucun accès aux mouvements', !(await perms('commercial')).includes('stock.read'))

// --- 1. Entrepôts, emplacements, matière ----------------------------------------------------------------------------------------------
const wh1 = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Entrepôt Tissus','fabric') returning *`))[0])
const wh2 = await as(admin, async () => (await q(`insert into warehouses(name, kind) values ('Entrepôt Fournitures','supplies') returning *`))[0])
await grant(mag, wh1.id, 'manager'); await grant(mag, wh2.id, 'operator')
await grant(op, wh1.id, 'operator')
await grant(dir, wh1.id, 'operator'); await grant(dir, wh2.id, 'operator')
const locA = await as(mag, async () => (await q(`insert into stock_locations(warehouse_id, code, name, kind) values ($1,'A-01','Allée A','storage') returning *`, [wh1.id]))[0])
const locB = await as(admin, async () => (await q(`insert into stock_locations(warehouse_id, code, name, kind) values ($1,'B-01','Allée B','storage') returning *`, [wh2.id]))[0])
const mat = (await as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Tissu coton','fabric','m') returning *`)))[0]
await as(admin, () => q(`insert into bom_material_prices(material_id, unit_cost) values ($1, 5)`, [mat.id]))
const onHand = async (wh) => Number((await q(`select private.stock_on_hand($1,$2) v`, [mat.id, wh]))[0].v)
const req = (u, args) => as(u, () => rpc('stock_request_create', ...args))

// --- 2. Mouvements sous seuil : publiés immédiatement, numérotés ----------------------------------------------------------------------
const e1 = await req(op, ['entree_achat', mat.id, 100, wh1.id, locA.id, null, null, 5, 'BL-001', null])
ok('entrée achat sous seuil : publiée immédiatement', e1.status === 'posted' && e1.approval_level === 0 && e1.movement_id)
ok('demande : numéro DEM-AAAA-000001', /^DEM-\d{4}-000001$/.test(e1.number))
const mv1 = (await q(`select * from stock_movements where id=$1`, [e1.movement_id]))[0]
ok('mouvement : numéro MVT-AAAA-000001, type métier entrée achat, lien vers la demande', /^MVT-\d{4}-000001$/.test(mv1.number) && mv1.kind === 'entree_achat' && mv1.request_id === e1.id)
ok('stock après entrée : 100', (await onHand(wh1.id)) === 100)

const s1 = await req(op, ['sortie_production', mat.id, 30, wh1.id, locA.id, null, null, null, 'OF-2026-01', null])
ok('sortie production : publiée, stock 70', s1.status === 'posted' && (await onHand(wh1.id)) === 70)
await rejects('sortie supérieure au stock : refusée, aucune demande laissée en attente', () => req(op, ['sortie_production', mat.id, 500, wh1.id, locA.id, null, null, null, 'OF-TROP', null]), 'STOCK_INSUFFICIENT')
ok('échec : aucune demande créée', (await q(`select count(*)::int c from stock_movement_requests where reference='OF-TROP'`))[0].c === 0)
await rejects('type métier inconnu refusé', () => req(op, ['inconnu', mat.id, 1, wh1.id, locA.id, null, null, null, null, null]), 'STOCK_BAD_KIND')
await rejects('quantité négative hors ajustement refusée', () => req(op, ['sortie_production', mat.id, -3, wh1.id, locA.id, null, null, null, null, null]), 'STOCK_BAD_QTY')
await rejects('transfert sans destination refusé', () => req(mag, ['transfert', mat.id, 5, wh1.id, locA.id, null, null, null, null, null]), 'STOCK_DESTINATION_REQUIRED')
await rejects('ajustement sans motif valable refusé', () => req(dir, ['ajustement', mat.id, 2, wh1.id, locA.id, null, null, null, null, 'ab']), 'STOCK_REASON_REQUIRED')
await rejects('ajustement : droit stock.adjust requis (magasinier)', () => req(op, ['ajustement', mat.id, 2, wh1.id, locA.id, null, null, null, null, 'Inventaire tournant']), 'RBAC_FORBIDDEN')
const legacy = await as(op, async () => (await q(`select public.stock_move('out', $1, 1, $2, $3, null, 'LEG-1', null, null, null) id`, [mat.id, wh1.id, locA.id]))[0].id)
const legacyRow = (await q(`select * from stock_movements where id=$1`, [legacy]))[0]
ok('mouvement posé par l’ancien point d’entrée : numéroté et typé sortie production', /^MVT-/.test(legacyRow.number) && legacyRow.kind === 'sortie_production')

// --- 3. Ajustement : validation obligatoire, auto-validation refusée --------------------------------------------------------------------
const adj = await req(dir, ['ajustement', mat.id, 2, wh1.id, locA.id, null, null, null, 'INV-01', 'Écart d’inventaire constaté'])
ok('ajustement : demande en attente de validation niveau 1', adj.status === 'pending' && adj.approval_level === 1 && adj.movement_id === null)
ok('stock inchangé tant que la demande n’est pas validée (69)', (await onHand(wh1.id)) === 69)
await rejects('le demandeur ne valide pas sa propre demande', () => as(dir, () => rpc('stock_request_approve', adj.id, null)), 'STOCK_SELF_APPROVAL')
await rejects('validation par une personne sans droit stock.approve', () => as(vw, () => rpc('stock_request_approve', adj.id, null)), 'RBAC_FORBIDDEN')
const appr = await as(mag, () => rpc('stock_request_approve', adj.id, 'Contrôlé en rayon'))
ok('validation niveau 1 par le magasinier : publiée', appr.status === 'posted' && appr.step === 1 && appr.movement_id)
const adjMv = (await q(`select * from stock_movements where id=$1`, [appr.movement_id]))[0]
ok('mouvement de validation : type ajustement, valideur enregistré', adjMv.kind === 'ajustement' && adjMv.direction === 'in' && adjMv.approved_by === mag)
ok('stock après ajustement : 71', (await onHand(wh1.id)) === 71)
await rejects('demande déjà traitée : nouvelle validation refusée', () => as(mag, () => rpc('stock_request_approve', adj.id, null)), 'STOCK_REQUEST_CLOSED')

// --- 4. Refus et annulation de demande -----------------------------------------------------------------------------------------------
const rb = await req(mag, ['rebut', mat.id, 4, wh1.id, locA.id, null, null, null, 'REB-01', 'Tissu taché'])
ok('rebut : validation exigée', rb.status === 'pending')
await rejects('refus sans motif valable refusé', () => as(dir, () => rpc('stock_request_reject', rb.id, 'a')), 'STOCK_REASON_REQUIRED')
await as(dir, () => rpc('stock_request_reject', rb.id, 'Quantité à vérifier'))
ok('refus : demande rejetée, stock inchangé', (await q(`select status from stock_movement_requests where id=$1`, [rb.id]))[0].status === 'rejected' && (await onHand(wh1.id)) === 71)
const rb2 = await req(mag, ['rebut', mat.id, 1, wh1.id, locA.id, null, null, null, null, 'Casse rayon'])
await rejects('annulation d’une demande par un tiers sans niveau 2 refusée', () => as(op, () => rpc('stock_request_cancel', rb2.id, 'x')), 'RBAC_FORBIDDEN')
await as(mag, () => rpc('stock_request_cancel', rb2.id, 'Erreur de saisie'))
ok('annulation par son auteur : demande annulée', (await q(`select status from stock_movement_requests where id=$1`, [rb2.id]))[0].status === 'cancelled')

// --- 5. Validation sensible : niveau 2, distinct du niveau 1 ------------------------------------------------------------------------
const big = await req(mag, ['sortie_production', mat.id, 60, wh1.id, locA.id, null, null, 200, 'OF-2026-02', null])
ok('sortie valorisée 12 000 : validation niveau 2 requise', big.status === 'pending' && big.approval_level === 2)
await rejects('le demandeur ne valide pas au niveau 1 non plus', () => as(mag, () => rpc('stock_request_approve', big.id, null)), 'STOCK_SELF_APPROVAL')
const l1 = await as(dir, () => rpc('stock_request_approve', big.id, 'Ordre de fabrication validé'))
ok('niveau 1 par la direction : toujours en attente', l1.status === 'pending' && l1.step === 1 && l1.movement_id === null)
await rejects('niveau 2 par la même personne que le niveau 1 refusé', () => as(dir, () => rpc('stock_request_approve', big.id, null)), 'STOCK_HIERARCHY')
await rejects('niveau 2 : droit stock.approve_high requis (magasinier, hors demandeur)', () => as(op, () => rpc('stock_request_approve', big.id, null)), 'RBAC_FORBIDDEN')
const l2 = await as(admin, () => rpc('stock_request_approve', big.id, 'Validé au second niveau'))
ok('niveau 2 par l’administrateur : publiée, stock 11', l2.status === 'posted' && l2.step === 2 && (await onHand(wh1.id)) === 11)
ok('audit : création et deux validations tracées', Number((await q(`select count(*)::int c from audit_logs where entity_type='stock_request' and entity_id=$1`, [big.id]))[0].c) >= 3)

// --- 6. Transferts, retours, sous-traitance : types métier ------------------------------------------------------------------------------
const tr = await req(mag, ['transfert', mat.id, 10, wh1.id, locA.id, wh2.id, locB.id, 5, 'TR-01', 'Approvisionnement atelier'])
ok('transfert : publié, stock 1 → 10', tr.status === 'posted' && (await onHand(wh1.id)) === 1 && (await onHand(wh2.id)) === 10)
const rp = await req(op, ['retour_production', mat.id, 5, wh1.id, locA.id, null, null, 5, 'RET-01', null])
ok('retour production : publié, type métier retour production', rp.status === 'posted' && (await q(`select kind from stock_movements where id=$1`, [rp.movement_id]))[0].kind === 'retour_production')
const st = await req(op, ['sous_traitance', mat.id, 3, wh1.id, locA.id, null, null, null, 'ST-2026-01', null])
ok('sous-traitance : sortie publiée', st.status === 'posted' && (await onHand(wh1.id)) === 3)
const rf = await req(mag, ['retour_fournisseur', mat.id, 1, wh1.id, locA.id, null, null, 5, 'RF-01', 'Non conforme'])
ok('retour fournisseur : validation exigée (niveau 1)', rf.status === 'pending' && rf.approval_level === 1)
await as(dir, () => rpc('stock_request_reject', rf.id, 'Conformité vérifiée'))

// --- 7. Annulation contrôlée : réversion validée -------------------------------------------------------------------------------------
await rejects('annulation : motif trop court refusé', () => as(mag, () => rpc('stock_cancel_movement', tr.movement_id, 'ok')), 'STOCK_REASON_REQUIRED')
const cx = await as(mag, () => rpc('stock_cancel_movement', tr.movement_id, 'Transfert adressé au mauvais atelier'))
ok('annulation d’un transfert : demande en attente de validation', cx.status === 'pending' && cx.approval_level === 1)
await rejects('une seule annulation active par mouvement', () => as(mag, () => rpc('stock_cancel_movement', tr.movement_id, 'Deuxième tentative')), 'STOCK_ALREADY_CANCELLED')
ok('stock inchangé avant validation (wh1 3, wh2 10)', (await onHand(wh1.id)) === 3 && (await onHand(wh2.id)) === 10)
const cxOk = await as(dir, () => rpc('stock_request_approve', cx.id, null))
ok('validation : transfert annulé, stock revenu (wh1 13, wh2 0)', cxOk.status === 'posted' && (await onHand(wh1.id)) === 13 && (await onHand(wh2.id)) === 0)
const rev = (await q(`select * from stock_movements where reversal_of=$1`, [tr.movement_id]))[0]
ok('réversion journalisée : type annulation, lien vers le mouvement d’origine', rev && rev.kind === 'annulation' && rev.type === 'transfer' && rev.direction === 'move')
await rejects('une réversion n’est pas annulable', () => as(mag, () => rpc('stock_cancel_movement', rev.id, 'Annuler une annulation')), 'STOCK_CANCEL_FORBIDDEN')
const e1cancel = await as(mag, () => rpc('stock_cancel_movement', e1.movement_id, 'Entrée saisie en double'))
await rejects('annulation d’une entrée dont le stock a été consommé : refusée à la validation', () => as(dir, () => rpc('stock_request_approve', e1cancel.id, null)), 'STOCK_INSUFFICIENT')
ok('échec de validation : la demande reste en attente, aucun mouvement créé', (await q(`select status from stock_movement_requests where id=$1`, [e1cancel.id]))[0].status === 'pending' && (await onHand(wh1.id)) === 13)

// --- 8. Numérotation des réservations ----------------------------------------------------------------------------------------------
const res = await as(mag, () => rpc('stock_reserve', mat.id, wh1.id, 3, 'OF-RES', 'Réservation test'))
const resRow = (await q(`select number from stock_reservations where id=$1`, [res]))[0]
ok('réservation : numéro RES-000001', resRow && /^RES-\d{6}$/.test(resRow.number))

// --- 9. Règles de validation ------------------------------------------------------------------------------------------------------------
await rejects('modification des règles réservée au niveau 2', () => as(mag, () => rpc('stock_policy_set', 'rebut', false, null, null)), 'RBAC_FORBIDDEN')
await rejects('seuils incohérents refusés', () => as(dir, () => rpc('stock_policy_set', 'retour_fournisseur', true, 500, 100)), 'stock_movement_policies_check')
await as(dir, () => rpc('stock_policy_set', 'rebut', false, null, null))
const rb3 = await req(mag, ['rebut', mat.id, 1, wh1.id, locA.id, null, null, null, 'REB-02', 'Casse'])
ok('règle assouplie : rebut sans validation, publié immédiatement', rb3.status === 'posted' && rb3.approval_level === 0)

// --- 10. Journal, immuabilité et visibilité -----------------------------------------------------------------------------------------------
const journal = await q(`select count(*)::int c, count(distinct number)::int d from stock_journal`)
ok('journal : numéros uniques, réversions incluses', journal[0].c === journal[0].d && journal[0].c >= 10)
await rejects('journal immuable : modification refusée', () => db.query(`update stock_movements set reason = 'x' where id=$1`, [e1.movement_id]), 'STOCK_IMMUTABLE')
ok('visibilité : utilisateur sans stock.read ne voit aucune demande', (await as(vw, () => q(`select count(*)::int c from stock_movement_requests`)))[0].c === 0)
ok('visibilité : opérateur de wh1 ne voit pas les demandes de wh2', (await as(op, () => q(`select count(*)::int c from stock_movement_requests where warehouse_id=$1`, [wh2.id])))[0].c === 0)
ok('visibilité : responsable de wh2 voit ses demandes', (await as(mag, () => q(`select count(*)::int c from stock_movement_requests where warehouse_id=$1`, [wh2.id])))[0].c >= 1)
