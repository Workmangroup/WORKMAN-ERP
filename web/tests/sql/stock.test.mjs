import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const uuid = () => crypto.randomUUID()
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const near = (a, b) => Math.abs(Number(a) - b) < 0.00005

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')
const achat = await mkUser('achat@x.com', 'achat')
const dir = await mkUser('dir@x.com', 'direction')
const prod = await mkUser('prod@x.com', 'production')
const comm = await mkUser('comm@x.com', 'commercial')

// --- 0. Permissions ----------------------------------------------------------------------------------------------------------------
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
ok('magasin : stock.write sans stock.adjust ni costs.read', (await perms('magasin')).includes('stock.write') && !(await perms('magasin')).includes('stock.adjust') && !(await perms('magasin')).includes('costs.read'))
ok('direction : stock.adjust + costs.read, pas stock.write', (await perms('direction')).includes('stock.adjust') && !(await perms('direction')).includes('stock.write'))
ok('commercial : aucun accès au stock', !(await perms('commercial')).includes('stock.read'))

// --- 1. Entrepôts et emplacements -----------------------------------------------------------------------------------------------------
// Création d'entrepôt réservée à warehouses.manage (admin) ; le magasinier en devient responsable, la production lit.
const grant = (u, wh, role) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null`, [company, u, wh, role])
const mkWh = async (name, city = null) => {
  const w = (await as(admin, async () => (await q(`insert into warehouses(name, city) values ($1,$2) returning *`, [name, city]))[0]))
  await grant(mag, w.id, 'manager'); await grant(prod, w.id, 'viewer'); await grant(dir, w.id, 'operator'); return w
}
const wh1 = await mkWh('Magasin principal', 'Tunis')
ok('entrepôt créé : code WH-01, société déduite', wh1.code === 'WH-01' && wh1.company_id === company && wh1.created_by === admin)
const gen1 = (await q(`select * from stock_locations where warehouse_id=$1`, [wh1.id]))[0]
ok('emplacement général GEN créé automatiquement', gen1.code === 'GEN' && gen1.kind === 'storage')
const wh2 = await mkWh('Atelier')
ok('second entrepôt WH-02', wh2.code === 'WH-02')
await rejects('création refusée sans stock.write (achat)', () => as(achat, () => db.query(`insert into warehouses(name) values ('Interdit')`)), 'WAREHOUSE_FORBIDDEN')
await rejects('nom d’entrepôt unique (insensible à la casse)', () => mkWh(' magasin PRINCIPAL '), 'warehouses_name_uq')
await rejects('code d’entrepôt non modifiable', () => as(mag, () => db.query(`update warehouses set code='X' where id=$1`, [wh1.id])), 'permission denied')
const mkLoc = (u, wh, code, kind = 'storage') => as(u, async () => (await q(`insert into stock_locations(warehouse_id, code, name, kind) values ($1,$2,$3,$4) returning *`, [wh, code, 'Allée ' + code, kind]))[0])
const a01 = await mkLoc(mag, wh1.id, 'a-01')
const a02 = await mkLoc(mag, wh1.id, 'A-02')
const rec = await mkLoc(mag, wh1.id, 'REC', 'receiving')
ok('emplacement : code normalisé en majuscules, société déduite', a01.code === 'A-01' && a01.company_id === company && rec.kind === 'receiving')
await rejects('emplacement : code unique par entrepôt', () => mkLoc(mag, wh1.id, 'A-01'), 'stock_locations_warehouse_id_code_key')
await rejects('emplacement : même code possible dans un autre entrepôt', () => mkLoc(mag, wh2.id, 'A-01').then(() => { throw new Error('autorisé') }).catch((e) => { if (e.message === 'autorisé') throw new Error('stock_locations_ok'); throw e }), 'stock_locations_ok')
await rejects('emplacement : code invalide', () => mkLoc(mag, wh1.id, 'a b!'), 'stock_locations_code_check')
await rejects('emplacement : type invalide', () => mkLoc(mag, wh1.id, 'ZZ', 'cave'), 'kind')
await as(mag, () => db.query(`update warehouses set city='La Marsa' where id=$1`, [wh1.id]))
await as(mag, () => db.query(`update warehouses set city='Tunis' where id=$1`, [wh1.id]))
const loc2 = (await q(`select id from stock_locations where warehouse_id=$1 and code='A-01'`, [wh2.id]))[0].id
const gen2 = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [wh2.id]))[0].id
ok('lecture : production oui, commercial non', (await as(prod, () => q(`select id from warehouses`))).length === 2 && (await as(comm, () => q(`select id from warehouses`))).length === 0)

// --- 2. Composants -------------------------------------------------------------------------------------------------------------------
const mat = async (name, unit, cost) => {
  const m = (await as(prod, () => q(`insert into bom_materials(name, category, unit) values ($1,'fabric',$2) returning *`, [name, unit])))[0]
  if (cost !== null) await as(achat, () => db.query(`insert into bom_material_prices(material_id, unit_cost) values ($1,$2)`, [m.id, cost]))
  return m
}
const tissu = await mat('Tissu jaune HV', 'm', 8.5)
const fil = await mat('Fil polyester', 'm', 0.001)

const mv = (u, o) => as(u, () => rpc('stock_move', ...[o.type, o.material, o.qty, o.wh, o.loc ?? null, o.to ?? null, o.ref ?? null, o.reason ?? null, o.cost ?? null, o.res ?? null]).catch((e) => { throw e }))
const mvNamed = (u, o) => as(u, async () => (await db.query(`select public.stock_move(p_type=>$1, p_material=>$2, p_qty=>$3, p_warehouse=>$4, p_location=>$5, p_to_location=>$6, p_reference=>$7, p_reason=>$8, p_unit_cost=>$9, p_reservation=>$10) r`,
  [o.type, o.material, o.qty, o.wh, o.loc ?? null, o.to ?? null, o.ref ?? null, o.reason ?? null, o.cost ?? null, o.res ?? null])).rows[0].r)
const onHand = async (m, wh, loc) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and warehouse_id=$2 and ($3::uuid is null or location_id=$3)`, [m, wh, loc ?? null]))[0].n)
const overview = async (u, m, wh) => (await as(u, () => q(`select on_hand::float, reserved::float, available::float, safety_qty::float, below_safety from stock_overview where material_id=$1 and warehouse_id=$2`, [m, wh])))[0]

// --- 3. Entrées (lots FIFO) -----------------------------------------------------------------------------------------------------------
const in1 = await mvNamed(mag, { type: 'in', material: tissu.id, qty: 100, wh: wh1.id, loc: a01.id, ref: 'BL-001', reason: 'Réception fournisseur' })
await as(achat, () => db.query(`update bom_material_prices set unit_cost=9 where material_id=$1`, [tissu.id]))
const in2 = await mvNamed(mag, { type: 'in', material: tissu.id, qty: 50, wh: wh1.id, loc: a01.id, ref: 'BL-002' })
const in3 = await mvNamed(admin, { type: 'in', material: tissu.id, qty: 30, wh: wh1.id, loc: a02.id, ref: 'BL-003', cost: 9.5 })
const lots = await q(`select l.*, c.unit_cost::float uc from stock_lots l join stock_lot_costs c on c.lot_id=l.id where material_id=$1 order by received_at, id`, [tissu.id])
ok('3 lots FIFO créés, dans l’ordre de réception', lots.length === 3 && lots[0].reference === 'BL-001' && lots[2].reference === 'BL-003')
ok('coût du lot = prix du catalogue BOM à la réception (8,50 puis 9,00) ; coût saisi (costs.read) = 9,50', near(lots[0].uc, 8.5) && near(lots[1].uc, 9) && near(lots[2].uc, 9.5))
ok('en stock : 180 m', (await onHand(tissu.id, wh1.id)) === 180)
await rejects('entrée refusée sans stock.write (achat)', () => mvNamed(achat, { type: 'in', material: tissu.id, qty: 1, wh: wh1.id, loc: a01.id }), 'RBAC_FORBIDDEN')
await rejects('entrée : emplacement obligatoire', () => mvNamed(mag, { type: 'in', material: tissu.id, qty: 1, wh: wh1.id }), 'STOCK_LOCATION_REQUIRED')
await rejects('entrée : quantité nulle', () => mvNamed(mag, { type: 'in', material: tissu.id, qty: 0, wh: wh1.id, loc: a01.id }), 'STOCK_BAD_QTY')
await rejects('entrée : emplacement d’un autre entrepôt', () => mvNamed(mag, { type: 'in', material: tissu.id, qty: 1, wh: wh1.id, loc: loc2 }), 'STOCK_LOCATION_NOT_FOUND')
await rejects('entrée : type inconnu', () => mvNamed(mag, { type: 'x', material: tissu.id, qty: 1, wh: wh1.id, loc: a01.id }), 'STOCK_BAD_TYPE')
await rejects('entrée : composant inconnu', () => mvNamed(mag, { type: 'in', material: uuid(), qty: 1, wh: wh1.id, loc: a01.id }), 'STOCK_MATERIAL_NOT_FOUND')
await rejects('coût saisi sans costs.read : ignoré, pas d’erreur (prix du catalogue)', () => mvNamed(mag, { type: 'in', material: fil.id, qty: 10, wh: wh1.id, loc: a01.id, cost: 99 }).then(async () => { const c = (await q(`select unit_cost::float u from stock_lot_costs c join stock_lots l on l.id=c.lot_id where l.material_id=$1`, [fil.id]))[0].u; if (near(c, 0.001)) throw new Error('coût_ignoré_ok'); throw new Error('coût ' + c) }), 'coût_ignoré_ok')
await mvNamed(mag, { type: 'out', material: fil.id, qty: 10, wh: wh1.id })

// --- 4. Sorties FIFO ----------------------------------------------------------------------------------------------------------------
const out1 = await mvNamed(mag, { type: 'out', material: tissu.id, qty: 120, wh: wh1.id, ref: 'OF-2026-001', reason: 'Coupe veste HV' })
const alloc = await q(`select a.qty::float q, l.reference ref from stock_movement_allocations a join stock_lots l on l.id=a.lot_id where a.movement_id=$1 order by l.received_at`, [out1])
ok('sortie 120 m : FIFO = 100 m du lot 1 puis 20 m du lot 2', alloc.length === 2 && alloc[0].ref === 'BL-001' && alloc[0].q === 100 && alloc[1].ref === 'BL-002' && alloc[1].q === 20)
const rem = (await q(`select reference, qty_remaining::float q from stock_lots where material_id=$1 order by received_at`, [tissu.id])).map((r) => `${r.reference}:${r.q}`).join()
ok('quantités restantes par lot : 0 / 30 / 30', rem === 'BL-001:0,BL-002:30,BL-003:30', rem)
ok('coût de la sortie FIFO = 100×8,50 + 20×9,00 = 1030 (visible avec costs.read)', near((await as(admin, () => q(`select total_cost from stock_movement_costs where movement_id=$1`, [out1])))[0].total_cost, 1030))
ok('coûts invisibles sans costs.read (magasin, production)', (await as(mag, () => q(`select * from stock_movement_costs`))).length === 0 && (await as(prod, () => q(`select * from stock_lot_costs`))).length === 0 && (await as(dir, () => q(`select * from stock_lot_costs`))).length > 0)
await rejects('sortie : stock insuffisant', () => mvNamed(mag, { type: 'out', material: tissu.id, qty: 61, wh: wh1.id }), 'STOCK_INSUFFICIENT')
ok('le stock n’est pas modifié par une sortie refusée', (await onHand(tissu.id, wh1.id)) === 60)
await rejects('sortie : emplacement précis insuffisant (A-01 ne contient que 30 m)', () => mvNamed(mag, { type: 'out', material: tissu.id, qty: 40, wh: wh1.id, loc: a01.id }), 'STOCK_INSUFFICIENT')

// --- 5. Réservations, disponible, sécurité --------------------------------------------------------------------------------------------
const res1 = await as(mag, () => rpc('stock_reserve', tissu.id, wh1.id, 40, 'OF-2026-002', 'Pantalon HV'))
ok('réservation 40 m : en stock 60, réservé 40, disponible 20', JSON.stringify(await overview(prod, tissu.id, wh1.id)) === JSON.stringify({ on_hand: 60, reserved: 40, available: 20, safety_qty: 0, below_safety: false }))
await rejects('réservation au-delà du disponible refusée', () => as(mag, () => rpc('stock_reserve', tissu.id, wh1.id, 30, 'OF-X')), 'STOCK_INSUFFICIENT_AVAILABLE')
await rejects('réservation : référence obligatoire', () => as(mag, () => rpc('stock_reserve', tissu.id, wh1.id, 1, '  ')), 'STOCK_REFERENCE_REQUIRED')
await rejects('réservation refusée sans stock.write', () => as(achat, () => rpc('stock_reserve', tissu.id, wh1.id, 1, 'X')), 'RBAC_FORBIDDEN')
await rejects('sortie de 30 m refusée : 20 m seulement disponibles (le reste est réservé)', () => mvNamed(mag, { type: 'out', material: tissu.id, qty: 30, wh: wh1.id }), 'STOCK_RESERVED')
await rejects('transfert refusé pour la même raison', () => mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 30, wh: wh1.id, loc: a02.id, to: a01.id }), 'STOCK_RESERVED')
await mvNamed(mag, { type: 'out', material: tissu.id, qty: 20, wh: wh1.id, ref: 'libre' })
ok('la sortie du disponible (20 m) est autorisée', (await onHand(tissu.id, wh1.id)) === 40)
await rejects('sortie sur réservation : quantité supérieure au reste réservé', () => mvNamed(mag, { type: 'out', material: tissu.id, qty: 41, wh: wh1.id, res: res1 }), 'STOCK_BAD_RESERVATION')
await mvNamed(mag, { type: 'out', material: tissu.id, qty: 25, wh: wh1.id, res: res1, ref: 'OF-2026-002' })
const r1 = (await q(`select * from stock_reservations where id=$1`, [res1]))[0]
ok('sortie sur réservation : consommée 25, reste 15, active', Number(r1.qty_consumed) === 25 && r1.status === 'active')
ok('après sortie : en stock 15, réservé 15, disponible 0', JSON.stringify(await overview(mag, tissu.id, wh1.id)) === JSON.stringify({ on_hand: 15, reserved: 15, available: 0, safety_qty: 0, below_safety: false }))
await as(mag, () => rpc('stock_release', res1))
ok('libération : réservation libérée, disponible = en stock', (await q(`select status from stock_reservations where id=$1`, [res1]))[0].status === 'released' && (await overview(mag, tissu.id, wh1.id)).available === 15)
await rejects('libération : réservation déjà fermée', () => as(mag, () => rpc('stock_release', res1)), 'STOCK_BAD_RESERVATION')
const res2 = await as(mag, () => rpc('stock_reserve', tissu.id, wh1.id, 10, 'OF-2026-003'))
await mvNamed(mag, { type: 'out', material: tissu.id, qty: 10, wh: wh1.id, res: res2 })
ok('réservation entièrement consommée → statut « consumed »', (await q(`select status from stock_reservations where id=$1`, [res2]))[0].status === 'consumed')
// restock pour la suite : 15 m restants (lot 3), on remet 20 m
await mvNamed(mag, { type: 'in', material: tissu.id, qty: 20, wh: wh1.id, loc: a01.id, ref: 'BL-004' })   // 5 (lot3) + 20 = 25
ok('stock : 25 m', (await onHand(tissu.id, wh1.id)) === 25)

await as(mag, () => rpc('stock_set_safety', tissu.id, wh1.id, 50))
const ov = await overview(prod, tissu.id, wh1.id)
ok('stock de sécurité 50 : alerte (disponible 25 < 50)', ov.safety_qty === 50 && ov.below_safety === true)
await as(mag, () => rpc('stock_set_safety', tissu.id, wh1.id, 10))
ok('stock de sécurité 10 : plus d’alerte', (await overview(prod, tissu.id, wh1.id)).below_safety === false)
await as(mag, () => rpc('stock_set_safety', fil.id, wh2.id, 5))
ok('stock de sécurité sans stock : ligne présente et en alerte', (await overview(mag, fil.id, wh2.id)).below_safety === true)
await rejects('sécurité négative refusée', () => as(mag, () => rpc('stock_set_safety', tissu.id, wh1.id, -1)), 'STOCK_BAD_QTY')
await rejects('sécurité refusée sans stock.write', () => as(prod, () => rpc('stock_set_safety', tissu.id, wh1.id, 1)), 'RBAC_FORBIDDEN')
ok('vue d’ensemble invisible sans stock.read', (await as(comm, () => q(`select * from stock_overview`))).length === 0)

// --- 6. Transferts (le FIFO suit le stock) -----------------------------------------------------------------------------------------
// état : lot3 (BL-003, 5 m, A-02, 9,50) ; lot4 (BL-004, 20 m, A-01, 9,00)
await rejects('transfert : même emplacement refusé', () => mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 1, wh: wh1.id, loc: a01.id, to: a01.id }), 'STOCK_SAME_LOCATION')
await rejects('transfert : destination obligatoire', () => mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 1, wh: wh1.id, loc: a01.id }), 'STOCK_LOCATION_NOT_FOUND')
await rejects('transfert : quantité supérieure à l’emplacement source', () => mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 21, wh: wh1.id, loc: a01.id, to: a02.id }), 'STOCK_INSUFFICIENT')
const t1 = await mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 8, wh: wh1.id, loc: a01.id, to: a02.id, ref: 'Réorganisation' })
const lot4 = (await q(`select received_at from stock_lots where reference='BL-004' and source_movement is not null and location_id=$1 and qty_in=20`, [a01.id]))[0]
const moved = (await q(`select l.*, c.unit_cost::float uc from stock_lots l join stock_lot_costs c on c.lot_id=l.id where l.source_movement=$1`, [t1]))[0]
ok('transfert 8 m A-01 → A-02 : nouveau lot à destination (8 m), date de réception, référence et coût conservés', moved.location_id === a02.id && Number(moved.qty_in) === 8 && moved.reference === 'BL-004' && near(moved.uc, 9) && String(moved.received_at) === String(lot4.received_at))
ok('transfert : stock total inchangé (25 m), A-01 = 12 m, A-02 = 13 m', (await onHand(tissu.id, wh1.id)) === 25 && (await onHand(tissu.id, wh1.id, a01.id)) === 12 && (await onHand(tissu.id, wh1.id, a02.id)) === 13)
const mt = (await q(`select * from stock_movements where id=$1`, [t1]))[0]
ok('transfert : un seul mouvement (type transfer, origine et destination)', mt.type === 'transfer' && mt.direction === 'move' && mt.location_id === a01.id && mt.to_location_id === a02.id && mt.to_warehouse_id === wh1.id)
const other = await mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 5, wh: wh1.id, loc: a02.id, to: gen2 })
ok('transfert entre entrepôts : stock côté Atelier (5 m), vue d’ensemble par entrepôt', (await onHand(tissu.id, wh2.id)) === 5 && (await onHand(tissu.id, wh1.id)) === 20 && (await overview(mag, tissu.id, wh2.id)).on_hand === 5)
const fifoNext = await mvNamed(mag, { type: 'out', material: tissu.id, qty: 1, wh: wh1.id })
ok('FIFO après transfert : la sortie prend le lot le plus ancien (BL-003 à 9,50)', (await q(`select l.reference ref from stock_movement_allocations a join stock_lots l on l.id=a.lot_id where a.movement_id=$1`, [fifoNext]))[0].ref === 'BL-004')

// --- 7. Ajustements -------------------------------------------------------------------------------------------------------------------
await rejects('ajustement refusé sans stock.adjust (magasin)', () => mvNamed(mag, { type: 'adjustment', material: tissu.id, qty: 2, wh: wh1.id, loc: a01.id, reason: 'Casse' }), 'RBAC_FORBIDDEN')
await rejects('ajustement : motif obligatoire', () => mvNamed(dir, { type: 'adjustment', material: tissu.id, qty: 2, wh: wh1.id, loc: a01.id }), 'STOCK_REASON_REQUIRED')
await rejects('ajustement : quantité nulle', () => mvNamed(dir, { type: 'adjustment', material: tissu.id, qty: 0, wh: wh1.id, loc: a01.id, reason: 'Test' }), 'STOCK_BAD_QTY')
const before = await onHand(tissu.id, wh1.id)
const adjUp = await mvNamed(dir, { type: 'adjustment', material: tissu.id, qty: 3, wh: wh1.id, loc: a01.id, reason: 'Rouleau retrouvé' })
const adjDown = await mvNamed(dir, { type: 'adjustment', material: tissu.id, qty: -2, wh: wh1.id, reason: 'Casse constatée' })
ok('ajustement +3 puis −2 : stock +1, mouvements de type adjustment (sens in / out)', (await onHand(tissu.id, wh1.id)) === before + 1
  && (await q(`select direction from stock_movements where id=$1`, [adjUp]))[0].direction === 'in' && (await q(`select direction, qty::float q from stock_movements where id=$1`, [adjDown]))[0].q === 2)
await rejects('ajustement négatif au-delà du stock refusé', () => mvNamed(dir, { type: 'adjustment', material: tissu.id, qty: -1000, wh: wh1.id, reason: 'Test' }), 'STOCK_INSUFFICIENT')
ok('ajustement positif valorisé au prix courant du catalogue (9,00)', near((await q(`select c.unit_cost u from stock_lots l join stock_lot_costs c on c.lot_id=l.id where l.source_movement=$1`, [adjUp]))[0].u, 9))

// --- 8. Inventaire --------------------------------------------------------------------------------------------------------------------------
const total = await onHand(tissu.id, wh1.id)
const inv = await as(mag, () => rpc('stock_inventory_create', wh1.id, null, 'Inventaire de fin de mois'))
const invRow = (await q(`select * from stock_inventories where id=$1`, [inv]))[0]
const lines = await q(`select * from stock_inventory_lines where inventory_id=$1 order by location_id`, [inv])
ok('inventaire créé : code INV-0001, brouillon, une ligne par composant et emplacement en stock', invRow.code === 'INV-0001' && invRow.status === 'draft' && lines.length >= 2 && lines.every((l) => Number(l.system_qty) > 0))
ok('quantités théoriques figées = stock réel', lines.filter((l) => l.material_id === tissu.id).reduce((a, l) => a + Number(l.system_qty), 0) === total)
await rejects('un seul inventaire ouvert par périmètre', () => as(mag, () => rpc('stock_inventory_create', wh1.id)), 'STOCK_INVENTORY_OPEN')
const tl = lines.filter((l) => l.material_id === tissu.id)
await as(mag, () => db.query(`update stock_inventory_lines set counted_qty=$2 where id=$1`, [tl[0].id, Number(tl[0].system_qty) - 2]))
await as(mag, () => db.query(`update stock_inventory_lines set counted_qty=$2 where id=$1`, [tl[1].id, Number(tl[1].system_qty)]))
await rejects('comptage négatif refusé', () => as(mag, () => db.query(`update stock_inventory_lines set counted_qty=-1 where id=$1`, [tl[0].id])), 'counted_qty')
await rejects('théorique non modifiable par l’utilisateur', () => as(mag, () => db.query(`update stock_inventory_lines set system_qty=999 where id=$1`, [tl[0].id])), 'permission denied')
await as(mag, () => rpc('stock_inventory_add_line', inv, fil.id, gen1.id))
await as(mag, () => db.query(`update stock_inventory_lines set counted_qty=12 where inventory_id=$1 and material_id=$2`, [inv, fil.id]))
await rejects('validation refusée sans stock.adjust (magasin)', () => as(mag, () => rpc('stock_inventory_validate', inv)), 'RBAC_FORBIDDEN')
const adj = await as(dir, () => rpc('stock_inventory_validate', inv))
ok('validation : 2 écarts appliqués (−2 tissu, +12 fil), stock corrigé', adj === 2 && (await onHand(tissu.id, wh1.id)) === total - 2 && (await onHand(fil.id, wh1.id, gen1.id)) === 12)
const im = await q(`select type, direction, qty::float q, reason, inventory_id from stock_movements where inventory_id=$1 order by seq`, [inv])
ok('mouvements « inventaire » tracés (type, sens, motif, lien vers l’inventaire)', im.length === 2 && im.every((m) => m.type === 'inventory' && m.reason === 'Inventaire INV-0001') && im.some((m) => m.direction === 'out' && m.q === 2) && im.some((m) => m.direction === 'in' && m.q === 12))
ok('écarts enregistrés sur les lignes, inventaire validé', (await q(`select count(*)::int n from stock_inventory_lines where inventory_id=$1 and applied_delta is not null`, [inv]))[0].n === 3 && (await q(`select status from stock_inventories where id=$1`, [inv]))[0].status === 'validated')
await rejects('inventaire validé : comptage refusé', () => as(mag, () => db.query(`update stock_inventory_lines set counted_qty=1 where id=$1`, [tl[0].id])), 'STOCK_INVENTORY_CLOSED')
await rejects('inventaire validé : nouvelle validation refusée', () => as(dir, () => rpc('stock_inventory_validate', inv)), 'STOCK_INVENTORY_CLOSED')
const inv2 = await as(mag, () => rpc('stock_inventory_create', wh1.id, a01.id))
await rejects('inventaire vide (aucun comptage) refusé', () => as(dir, () => rpc('stock_inventory_validate', inv2)), 'STOCK_INVENTORY_EMPTY')
await as(mag, () => rpc('stock_inventory_cancel', inv2))
ok('inventaire annulé', (await q(`select status from stock_inventories where id=$1`, [inv2]))[0].status === 'cancelled')
await rejects('inventaire annulé : annulation refusée', () => as(mag, () => rpc('stock_inventory_cancel', inv2)), 'STOCK_INVENTORY_CLOSED')

// --- 9. Historique immuable --------------------------------------------------------------------------------------------------------------
await rejects('historique : modification refusée (même service_role)', () => db.query(`update stock_movements set qty=1`), 'STOCK_IMMUTABLE')
await rejects('historique : suppression refusée', () => db.query(`delete from stock_movements`), 'STOCK_IMMUTABLE')
await rejects('historique : allocations non modifiables', () => db.query(`delete from stock_movement_allocations`), 'STOCK_IMMUTABLE')
await rejects('écriture directe des mouvements interdite aux utilisateurs', () => as(admin, () => db.query(`insert into stock_movements(type,direction,material_id,qty,warehouse_id) values ('in','in',$1,1,$2)`, [tissu.id, wh1.id])), 'permission denied')
await rejects('écriture directe des lots interdite', () => as(admin, () => db.query(`update stock_lots set qty_remaining=9999`)), 'permission denied')
const hist = await as(prod, () => q(`select type, count(*)::int n from stock_movements group by type order by type`))
ok('historique lisible avec stock.read : les 5 types de mouvements présents', hist.map((h) => h.type).join() === 'adjustment,in,inventory,out,transfer', JSON.stringify(hist))
ok('historique : numéro de séquence croissant, acteur et date enregistrés', (await q(`select count(*)::int n from stock_movements where created_by is not null and created_at is not null`))[0].n === (await q(`select count(*)::int n from stock_movements`))[0].n)
ok('chaque quantité sortie est expliquée par ses lots (somme des allocations = quantité)', (await q(`select count(*)::int n from stock_movements m where qty <> (select sum(qty) from stock_movement_allocations a where a.movement_id=m.id)`))[0].n === 0)
ok('cohérence : somme des mouvements = stock réel (tissu, entrepôts 1 + 2)', (await q(`select (select coalesce(sum(case direction when 'in' then qty when 'out' then -qty else 0 end),0) from stock_movements where material_id=$1)::float a, (select coalesce(sum(qty_remaining),0) from stock_lots where material_id=$1)::float b`, [tissu.id])).every((r) => r.a === r.b))

// --- 10. Archivage ----------------------------------------------------------------------------------------------------------------------
await rejects('entrepôt avec stock : archivage refusé', () => as(mag, () => rpc('stock_warehouse_archive', wh1.id, true)), 'STOCK_NOT_EMPTY')
await rejects('emplacement avec stock : archivage refusé', () => as(mag, () => rpc('stock_location_archive', a01.id, true)), 'STOCK_NOT_EMPTY')
await mvNamed(mag, { type: 'out', material: tissu.id, qty: 5, wh: wh2.id })
await as(mag, () => rpc('stock_warehouse_archive', wh2.id, true).catch((e) => { throw e }))
ok('entrepôt vide archivé', (await q(`select archived_at from warehouses where id=$1`, [wh2.id]))[0].archived_at !== null)
await rejects('entrepôt archivé : entrée refusée', () => mvNamed(mag, { type: 'in', material: tissu.id, qty: 1, wh: wh2.id, loc: gen2 }), 'STOCK_WAREHOUSE_ARCHIVED')
await rejects('entrepôt archivé : modification refusée', () => as(mag, () => db.query(`update warehouses set name='Autre nom' where id=$1`, [wh2.id])), 'STOCK_WAREHOUSE_ARCHIVED')
await rejects('transfert vers un entrepôt archivé refusé', () => mvNamed(mag, { type: 'transfer', material: tissu.id, qty: 1, wh: wh1.id, loc: a01.id, to: gen2 }), 'STOCK_WAREHOUSE_ARCHIVED')
await as(mag, () => rpc('stock_warehouse_archive', wh2.id, false))
await as(mag, () => rpc('stock_location_archive', loc2, true))
await rejects('dernier emplacement actif : archivage refusé', () => as(mag, () => rpc('stock_location_archive', gen2, true)), 'STOCK_LAST_LOCATION')
await as(mag, () => rpc('stock_location_archive', rec.id, true))
await rejects('emplacement archivé : entrée refusée', () => mvNamed(mag, { type: 'in', material: tissu.id, qty: 1, wh: wh1.id, loc: rec.id }), 'STOCK_LOCATION_ARCHIVED')
await as(mag, () => rpc('stock_location_archive', rec.id, false))
ok('emplacement restauré : entrée possible', !!(await mvNamed(mag, { type: 'in', material: tissu.id, qty: 1, wh: wh1.id, loc: rec.id })))
await rejects('archivage refusé sans stock.write', () => as(achat, () => rpc('stock_warehouse_archive', wh1.id, true)), 'RBAC_FORBIDDEN')
await rejects('composant archivé : entrée refusée', async () => { await as(prod, () => rpc('bom_material_archive', fil.id, true)); await mvNamed(mag, { type: 'in', material: fil.id, qty: 1, wh: wh1.id, loc: gen1.id }) }, 'STOCK_MATERIAL_ARCHIVED')
ok('composant archivé : la sortie reste possible', !!(await mvNamed(mag, { type: 'out', material: fil.id, qty: 1, wh: wh1.id })))

// --- 11. Isolation entre sociétés ---------------------------------------------------------------------------------------------------------
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const fw = (await q(`insert into warehouses(company_id, name) values ($1,'Entrepôt étranger') returning id`, [co2]))[0].id
ok('isolation : entrepôts, lots et mouvements de l’autre société invisibles', (await as(admin, () => q(`select id from warehouses where id=$1`, [fw]))).length === 0)
await rejects('isolation : mouvement dans un entrepôt d’une autre société refusé', () => mvNamed(mag, { type: 'in', material: tissu.id, qty: 1, wh: fw, loc: gen1.id }), 'STOCK_WAREHOUSE_NOT_FOUND')

// --- 12. Historique des objets -----------------------------------------------------------------------------------------------------------
const h = await q(`select action, entity_type, before_data, after_data, metadata from audit_logs where entity_type in ('warehouse','location','inventory','stock')`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['warehouse.create', 'warehouse.update', 'warehouse.archive', 'warehouse.restore', 'location.create', 'location.archive', 'location.restore', 'inventory.create', 'inventory.validate', 'inventory.cancel', 'stock.reserve', 'stock.release', 'stock.safety_set'])
  ok(`historique : ${a}`, acts.has(a))
ok('historique : sécurité avant → après', (() => { const r = h.find((x) => x.action === 'stock.safety_set' && Number(x.after_data.safety_qty) === 10); return Number(r.before_data.safety_qty) === 50 })())
ok('historique lisible avec stock.read, pas sans', (await as(prod, () => q(`select id from audit_logs where entity_type in ('warehouse','stock')`))).length > 0 && (await as(comm, () => q(`select id from audit_logs where entity_type in ('warehouse','stock')`))).length === 0)

process.exit(process.exitCode ?? 0)
