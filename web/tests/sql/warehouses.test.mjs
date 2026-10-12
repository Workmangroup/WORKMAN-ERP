import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
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
const magT = await mkUser('mag.tissus@x.com', 'magasin')
const magF = await mkUser('mag.fournitures@x.com', 'magasin')
const magP = await mkUser('mag.pf@x.com', 'magasin')
const comm = await mkUser('comm@x.com', 'commercial')
const nobody = await mkUser('nobody@x.com', null)
const grant = (u, wh, r) => db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,$4) on conflict (user_id, warehouse_id) do update set role=excluded.role, active=true, revoked_at=null, revoked_by=null`, [company, u, wh, r])

// --- 0. Entrepôts créés par l'admin (le créateur en devient responsable) ----------------------------------------------------------------
const mkWh = (name, kind) => as(admin, async () => (await q(`insert into warehouses(name, kind, city) values ($1,$2,'Sfax') returning *`, [name, kind]))[0])
const wT = await mkWh('Entrepôt Tissus', 'fabric')
const wF = await mkWh('Entrepôt Fournitures', 'supplies')
const wP = await mkWh('Entrepôt Produits Finis', 'finished_goods')
ok('entrepôt créé par l’admin : code WH-01, type tissus, société déduite', wT.code === 'WH-01' && wT.kind === 'fabric' && wT.company_id === company)
ok('le créateur devient responsable de l’entrepôt créé', (await q(`select role from user_warehouses where user_id=$1 and warehouse_id=$2`, [admin, wT.id]))[0].role === 'manager')
await rejects('type d’entrepôt inconnu refusé', () => mkWh('Cave', 'cellar'), 'warehouses_kind_check')
await grant(magT, wT.id, 'manager'); await grant(magF, wF.id, 'manager'); await grant(magP, wP.id, 'manager')
await grant(dir, wT.id, 'viewer')
const opT = await mkUser('op.tissus@x.com', 'magasin')
await grant(opT, wT.id, 'operator')
const vwT = await mkUser('viewer.tissus@x.com', 'magasin')
await grant(vwT, wT.id, 'viewer')

// --- 1. Création et modification -----------------------------------------------------------------------------------------------------------
await rejects('magasinier sans droit de gestion : création d’entrepôt refusée', () => as(magT, () => db.query(`insert into warehouses(name, kind) values ('Intrus','other')`)), 'WAREHOUSE_FORBIDDEN')
await rejects('opérateur : modification de l’entrepôt refusée (responsable requis)', () => as(opT, () => db.query(`update warehouses set city='Tunis' where id=$1`, [wT.id])), 'WAREHOUSE_FORBIDDEN')
await as(magT, () => db.query(`update warehouses set city='La Marsa' where id=$1`, [wT.id]))
ok('responsable : modification de son entrepôt', (await q(`select city from warehouses where id=$1`, [wT.id]))[0].city === 'La Marsa')
await rejects('suppression d’entrepôt impossible sans droit de gestion (aucun droit DELETE accordé)', () => as(magT, () => db.query(`delete from warehouses where id=$1`, [wT.id])), 'permission denied')
await rejects('code d’entrepôt immuable', () => as(admin, () => db.query(`update warehouses set code='X' where id=$1`, [wT.id])), 'permission denied')

// --- 2. Accès : chacun ne voit que ce qui lui est affecté ----------------------------------------------------------------------------------------
ok('magasinier Tissus : voit uniquement l’entrepôt Tissus', (await as(magT, () => q(`select id from warehouses`))).map((r) => r.id).join() === wT.id)
ok('refus : magasinier Tissus ne voit ni Fournitures ni Produits finis', (await as(magT, () => q(`select id from warehouses where id = any($1)`, [[wF.id, wP.id]]))).length === 0)
ok('magasinier Fournitures : voit uniquement Fournitures', (await as(magF, () => q(`select id from warehouses`))).map((r) => r.id).join() === wF.id)
ok('direction (warehouses.all) : voit les trois entrepôts, sans écriture', (await as(dir, () => q(`select id from warehouses`))).length === 3)
ok('sans affectation : aucun entrepôt visible', (await as(nobody, () => q(`select id from warehouses`))).length === 0)
ok('zones et emplacements de Fournitures invisibles à Tissus', (await as(magT, () => q(`select id from stock_locations where warehouse_id=$1`, [wF.id]))).length === 0)

// --- 3. Emplacements et zones : responsable de l'entrepôt uniquement -------------------------------------------------------------------------------
const zT = await as(magT, async () => (await q(`insert into warehouse_locations(warehouse_id, code, name, zone_type) values ($1,'zc','Zone de coupe','cutting') returning *`, [wT.id]))[0])
ok('zone créée par le responsable : code en majuscules, type cutting', zT.code === 'ZC' && zT.zone_type === 'cutting' && zT.company_id === company)
await rejects('zone en double dans le même entrepôt refusée', () => as(magT, () => db.query(`insert into warehouse_locations(warehouse_id, code, name) values ($1,'ZC','Doublon')`, [wT.id])), 'warehouse_locations_warehouse_id_code_key')
await rejects('zone : type inconnu refusé', () => as(magT, () => db.query(`insert into warehouse_locations(warehouse_id, code, name, zone_type) values ($1,'ZX','Zone X','cave')`, [wT.id])), 'warehouse_locations_zone_type_check')
await rejects('zone dans l’entrepôt Fournitures refusée au responsable Tissus', () => as(magT, () => db.query(`insert into warehouse_locations(warehouse_id, code, name) values ($1,'ZF','Zone F')`, [wF.id])), 'WAREHOUSE_FORBIDDEN')
await rejects('zone : création refusée à l’opérateur (responsable requis)', () => as(opT, () => db.query(`insert into warehouse_locations(warehouse_id, code, name) values ($1,'ZO','Zone O')`, [wT.id])), 'WAREHOUSE_FORBIDDEN')
ok('zones : la responsable de Fournitures ne voit que ses zones', (await as(magF, () => q(`select id from warehouse_locations`))).length === 0)
const binT = await as(magT, async () => (await q(`insert into stock_locations(warehouse_id, code, name, kind, zone_id) values ($1,'t-01','Rack tissus 1','storage',$2) returning *`, [wT.id, zT.id]))[0])
ok('emplacement rattaché à sa zone (même entrepôt)', binT.zone_id === zT.id)
const zF = await as(magF, async () => (await q(`insert into warehouse_locations(warehouse_id, code, name, zone_type) values ($1,'zr','Zone réception','reception') returning *`, [wF.id]))[0])
await rejects('emplacement rattaché à une zone d’un autre entrepôt refusé', () => as(magT, () => db.query(`insert into stock_locations(warehouse_id, code, name, kind, zone_id) values ($1,'t-02','Rack','storage',$2)`, [wT.id, zF.id])), 'WAREHOUSE_ZONE_MISMATCH')
await rejects('emplacement dans Fournitures refusé au responsable Tissus', () => as(magT, () => db.query(`insert into stock_locations(warehouse_id, code, name, kind) values ($1,'f-01','Rack','storage')`, [wF.id])), 'WAREHOUSE_FORBIDDEN')
await rejects('emplacement : création refusée à l’opérateur', () => as(opT, () => db.query(`insert into stock_locations(warehouse_id, code, name, kind) values ($1,'t-03','Rack','storage')`, [wT.id])), 'WAREHOUSE_FORBIDDEN')
await as(magT, () => db.query(`update warehouse_locations set name='Zone de coupe principale' where id=$1`, [zT.id]))
ok('zone modifiée par son responsable', (await q(`select name from warehouse_locations where id=$1`, [zT.id]))[0].name === 'Zone de coupe principale')

// --- 4. Stock : refus sur les entrepôts non autorisés ---------------------------------------------------------------------------------------------
const colJau = (await q(`select id from colors where code='JAU'`))[0].id
const sizeS = (await q(`select id from sizes where code='S'`))[0].id
const cli = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const prod = (await as(comm, () => q(`insert into product_master(client_id, name, family) values ($1,'VESTE HV','jacket') returning *`, [cli])))[0]
await as(comm, () => rpc('variant_generate', prod.id, [colJau], [sizeS]))
const v = (await q(`select id from product_variants where product_id=$1`, [prod.id]))[0].id
const vm = (u, type, wh, qty, to = null, reason = null, ref = null) => as(u, () => rpc('variant_stock_move', v, type, wh, qty, to, reason, ref))
await rejects('entrée dans Fournitures refusée au responsable Tissus', () => vm(magT, 'receipt', wF.id, 5), 'WAREHOUSE_FORBIDDEN')
await rejects('entrée dans Produits finis refusée au responsable Tissus', () => vm(magT, 'receipt', wP.id, 5), 'WAREHOUSE_FORBIDDEN')
const r1 = await vm(magT, 'receipt', wT.id, 40, null, null, 'OF-1')
ok('entrée dans Tissus autorisée : 40 pièces', r1.on_hand === 40)
await rejects('transfert de Tissus vers Fournitures refusé (destination non autorisée)', () => vm(magT, 'transfer', wT.id, 5, wF.id, 'Test'), 'WAREHOUSE_FORBIDDEN')
await rejects('opérateur Tissus : sortie d’un entrepôt non affecté refusée', () => vm(opT, 'issue', wF.id, 1), 'WAREHOUSE_FORBIDDEN')
const r2 = await vm(opT, 'issue', wT.id, 10)
ok('opérateur Tissus : sortie autorisée sur Tissus (40 → 30)', r2.on_hand === 30)
await rejects('lecteur (viewer) : aucune écriture de stock', () => vm(vwT, 'receipt', wT.id, 1), 'WAREHOUSE_FORBIDDEN')
ok('lecteur (viewer) : lit le stock de Tissus', (await as(vwT, () => q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [v, wT.id])))[0].qty_on_hand === 30)
ok('stock de Tissus invisible aux responsables de Fournitures', (await as(magF, () => q(`select id from variant_stock where variant_id=$1`, [v]))).length === 0)
ok('mouvements de Tissus invisibles aux responsables de Produits finis', (await as(magP, () => q(`select id from variant_stock_moves where variant_id=$1`, [v]))).length === 0)
ok('direction : voit le stock de Tissus et les mouvements (lecture)', (await as(dir, () => q(`select id from variant_stock_moves where variant_id=$1`, [v]))).length >= 2)
await rejects('direction : aucune écriture de stock (pas d’affectation opérateur)', () => vm(dir, 'receipt', wT.id, 1), 'RBAC_FORBIDDEN')

// --- 5. Affectation des utilisateurs ----------------------------------------------------------------------------------------------------------------
const newbie = await mkUser('nouveau@x.com', 'magasin')
const assign = (u, wh, roleName, target) => as(u, () => rpc('wh_assign_user', target, wh, roleName))
await rejects('affectation : rôle inconnu refusé', () => assign(magT, wT.id, 'chef', newbie), 'WAREHOUSE_BAD_ROLE')
await rejects('affectation sur Fournitures refusée au responsable Tissus', () => assign(magT, wF.id, 'operator', newbie), 'WAREHOUSE_FORBIDDEN')
await assign(magT, wT.id, 'operator', newbie)
ok('affectation par le responsable : nouvel opérateur sur Tissus', (await q(`select role, active from user_warehouses where user_id=$1 and warehouse_id=$2`, [newbie, wT.id]))[0].role === 'operator')
ok('le nouvel opérateur peut écrire sur Tissus', (await vm(newbie, 'receipt', wT.id, 2)).on_hand === 32)
const other = (await q(`insert into companies(name) values ('Autre société') returning id`))[0].id
const foreign = (await q(`insert into auth.users(email) values ('etranger@x.com') returning id`))[0].id
await db.query(`update profiles set company_id=$2 where id=$1`, [foreign, other])
await rejects('affectation d’un utilisateur d’une autre société refusée', () => assign(magT, wT.id, 'viewer', foreign), 'WAREHOUSE_USER_NOT_FOUND')
const myAccess = (u) => as(u, () => q('select * from public.wh_my_access()'))
const acc = await myAccess(newbie)
ok('mes accès : entrepôt Tissus, rôle opérateur', acc.length === 1 && acc[0].code === 'WH-01' && acc[0].role === 'operator')
ok('mes accès (direction) : trois entrepôts, rôle lecture', (await myAccess(dir)).every((x) => x.role === 'viewer') && (await myAccess(dir)).length === 3)
ok('mes accès (administrateur) : rôle responsable partout', (await myAccess(admin)).every((x) => x.role === 'manager'))

// --- 6. Révocation -------------------------------------------------------------------------------------------------------------------------------------------
await rejects('révocation : accès inexistant refusé', () => as(magT, () => rpc('wh_revoke_user', nobody, wT.id)), 'WAREHOUSE_ACCESS_NOT_FOUND')
await rejects('révocation sur Fournitures refusée au responsable Tissus', () => as(magT, () => rpc('wh_revoke_user', newbie, wF.id)), 'WAREHOUSE_FORBIDDEN')
await as(magT, () => rpc('wh_revoke_user', newbie, wT.id))
ok('révocation : l’ancien opérateur ne voit plus Tissus et ne peut plus écrire', (await as(newbie, () => q(`select id from warehouses`))).length === 0)
await rejects('révocation effective : écriture refusée après retrait', () => vm(newbie, 'receipt', wT.id, 1), 'WAREHOUSE_FORBIDDEN')
ok('historique : la révocation reste enregistrée (ligne inactive, date et auteur)', (await q(`select active, revoked_at is not null r, revoked_by=$2 by from user_warehouses where user_id=$1 and warehouse_id=$3`, [newbie, magT, wT.id]))[0].r === true)
// dernier responsable : on retire l'admin (non bloquant pour un responsable sans gestion), puis le dernier responsable ne peut pas se retirer
await as(magT, () => rpc('wh_revoke_user', admin, wT.id))
await rejects('un entrepôt garde au moins un responsable (dernier responsable refusé)', () => as(magT, () => rpc('wh_revoke_user', magT, wT.id)), 'WAREHOUSE_LAST_MANAGER')

// --- 7. Traçabilité -------------------------------------------------------------------------------------------------------------------------------------------
const acts = new Set((await q(`select action from audit_logs where entity_type='warehouse'`)).map((r) => r.action))
for (const a of ['warehouse.create', 'warehouse.zone_add', 'warehouse.zone_update', 'warehouse.location_add', 'warehouse.access_grant', 'warehouse.access_revoke'])
  ok(`traçabilité : ${a}`, acts.has(a))
const grantLog = (await q(`select metadata, after_data from audit_logs where action='warehouse.access_grant' order by created_at desc limit 1`))[0]
ok('traçabilité : l’affectation indique l’utilisateur et le rôle', grantLog.after_data.role && grantLog.after_data.user)
ok('traçabilité lisible avec le droit stock (direction), pas sans droit', (await as(dir, () => q(`select id from audit_logs where entity_type='warehouse'`))).length > 0 && (await as(nobody, () => q(`select id from audit_logs where entity_type='warehouse'`))).length === 0)
await rejects('journal append-only', () => as(admin, () => db.query(`delete from audit_logs where entity_type='warehouse'`)), 'permission denied')

// --- 8. Isolation entre sociétés --------------------------------------------------------------------------------------------------------------------------------
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
await db.exec(`alter table warehouses disable trigger warehouses_access_guard_iud`)
const w2 = (await q(`insert into warehouses(company_id, code, name, kind) values ($1,'WH-9001','Entrepôt étranger','other') returning id`, [co2]))[0].id
await db.exec(`alter table warehouses enable trigger warehouses_access_guard_iud`)
ok('isolation : l’administrateur ne voit pas l’entrepôt d’une autre société', (await as(admin, () => q(`select id from warehouses where id=$1`, [w2]))).length === 0)
ok('isolation : aucune zone ni affectation croisée', (await as(admin, () => q(`select id from warehouse_locations where warehouse_id=$1`, [w2]))).length === 0)

process.exit(process.exitCode ?? 0)
