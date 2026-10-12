import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
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
const comm = await mkUser('comm@x.com', 'commercial')
const prod = await mkUser('prod@x.com', 'production')
const mag = await mkUser('mag@x.com', 'magasin')
const fin = await mkUser('fin@x.com', 'finance')
const qual = await mkUser('qual@x.com', 'qualite')
const nobody = await mkUser('nobody@x.com', null)

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
const has = async (c, ...codes) => { const p = await perms(c); return codes.every((x) => p.includes(x)) }
ok('droits : admin tout ; commercial lit/écrit sans le stock ; production tout ; magasin lit et gère le stock sans modifier les variantes', (await has('admin', 'variants.read', 'variants.write', 'variants.stock')) && (await has('commercial', 'variants.write')) && !(await has('commercial', 'variants.stock')) && (await has('production', 'variants.write', 'variants.stock')) && (await has('magasin', 'variants.read', 'variants.stock')) && !(await has('magasin', 'variants.write')))
ok('finance, qualité : lecture seule', (await has('finance', 'variants.read')) && !(await has('finance', 'variants.write', 'variants.stock')) && (await has('qualite', 'variants.read')) && !(await has('qualite', 'variants.write')))

// --- 1. Catalogues ------------------------------------------------------------------------------------------------------------------------
const nSizes = (await q(`select count(*)::int n from sizes`))[0].n
const nColors = (await q(`select count(*)::int n from colors`))[0].n
ok('catalogues par défaut : tailles (XS → 4XL, 36 → 60) et couleurs (Jaune HV, Orange HV, Marine…)', nSizes === 21 && nColors === 10 && (await q(`select 1 from sizes where code='XXL'`)).length === 1 && (await q(`select 1 from colors where name='Jaune HV'`)).length === 1)
await as(comm, () => db.query(`insert into sizes(code, label, size_group, sort_order) values ('5xl','5XL','letters',90)`))
ok('taille ajoutée : code normalisé en majuscules', (await q(`select code from sizes where label='5XL'`))[0].code === '5XL')
await rejects('taille en double refusée (insensible à la casse)', () => as(comm, () => db.query(`insert into sizes(code, label) values ('xxl','Double')`)), 'sizes_code_uq')
await rejects('code de taille invalide refusé', () => as(comm, () => db.query(`insert into sizes(code, label) values ('!!','X')`)), 'sizes_code_check')
await rejects('couleur en double (nom) refusée', () => as(comm, () => db.query(`insert into colors(code, name) values ('JA2','jaune hv')`)), 'colors_name_uq')
await rejects('couleur : teinte invalide refusée', () => as(comm, () => db.query(`insert into colors(code, name, hex) values ('ZZZ','Zinzolin','rouge')`)), 'colors_hex_check')
await as(comm, () => db.query(`insert into colors(code, name, hex, pantone) values ('COR','Corail','#ff7f50','PMS 1635 C')`))
await rejects('catalogue : écriture réservée à variants.write', () => as(mag, () => db.query(`insert into sizes(code, label) values ('7XL','7XL')`)), 'row-level security')
await rejects('catalogue : sans droit de lecture, rien de visible', async () => { const r = await as(nobody, () => q(`select id from sizes`)); if (r.length) throw new Error('visible') ; throw new Error('RLS-OK') }, 'RLS-OK')
await as(comm, () => db.query(`update sizes set label='Très grand 5XL' where code='5XL'`))
await rejects('code de taille immuable', () => as(comm, () => db.query(`update sizes set code='6XL' where code='5XL'`)), 'permission denied')

// --- 2. Produit et génération de la matrice ---------------------------------------------------------------------------------------------------
const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const other = (await as(comm, () => q(`insert into clients(name,country) values ('Bragard','FR') returning id`)))[0].id
const mkProduct = (name, client = lafont) => as(comm, async () => (await q(`insert into product_master(client_id, name, family) values ($1,$2,'jacket') returning *`, [client, name]))[0])
const p1 = await mkProduct('VESTE HV')
const ids = async (table, col, vals) => (await q(`select id from ${table} where ${col} = any($1) order by ${col}`, [vals])).map((r) => r.id)
const colJMO = await ids('colors', 'code', ['JAU', 'ORA', 'MAR'])
const sizes5 = await ids('sizes', 'code', ['S', 'M', 'L', 'XL', 'XXL'])
const gen = await as(comm, () => rpc('variant_generate', p1.id, colJMO, sizes5))
ok('matrice 3 couleurs × 5 tailles : 15 variantes créées', gen === 15 && (await q(`select count(*)::int n from product_variants where product_id=$1`, [p1.id]))[0].n === 15)
ok('SKU généré : PRD-0001-JAU-S, couleur et taille respectées', (await q(`select count(*)::int n from product_variants where product_id=$1 and sku='PRD-0001-JAU-S'`, [p1.id]))[0].n === 1 && (await q(`select count(*)::int n from product_variants where product_id=$1 and sku ~ '^PRD-0001-(JAU|ORA|MAR)-(S|M|L|XL|XXL)$'`, [p1.id]))[0].n === 15)
ok('génération idempotente (rien de recréé)', (await as(comm, () => rpc('variant_generate', p1.id, colJMO, sizes5))) === 0)
const colNoir = await ids('colors', 'code', ['NOI'])
ok('ajout d’un coloris : seules les 5 variantes manquantes sont créées', (await as(comm, () => rpc('variant_generate', p1.id, [...colJMO, ...colNoir], sizes5))) === 5)
await rejects('génération : sélection vide refusée', () => as(comm, () => rpc('variant_generate', p1.id, [], sizes5)), 'VARIANT_EMPTY_SELECTION')
await rejects('génération réservée à variants.write', () => as(mag, () => rpc('variant_generate', p1.id, colJMO, sizes5)), 'RBAC_FORBIDDEN')
await as(comm, () => db.query(`update colors set active=false where code='NOI'`))
const xs = (await ids('sizes', 'code', ['XS']))[0]
await rejects('couleur inactive : variante refusée', () => as(comm, () => db.query(`insert into product_variants(product_id, color_id, size_id) values ($1,$2,$3)`, [p1.id, colNoir[0], xs])), 'VARIANT_ATTRIBUTE_INACTIVE')
await as(comm, () => db.query(`update colors set active=true where code='NOI'`))
await rejects('SKU immuable', () => as(comm, () => db.query(`update product_variants set sku='X-1' where product_id=$1`, [p1.id])), 'permission denied')
await rejects('variante : insertion sans droit refusée', () => as(mag, () => db.query(`insert into product_variants(product_id, color_id, size_id) values ($1,$2,$3)`, [p1.id, colNoir[0], xs])), 'row-level security')

// --- 3. Import depuis la fiche technique du PDM ----------------------------------------------------------------------------------------------------
const p2 = await mkProduct('PANTALON HV')
const v2 = (await q(`select id from product_versions where product_id=$1`, [p2.id]))[0].id
const spec2 = { tech: {}, colors: [{ name: 'Jaune HV' }, { name: 'Corail' }, { name: 'Vert pomme', hex: '#8db600' }], sizes: [{ label: 'S' }, { label: 'M' }, { label: '7XL' }],
  variants: [{ sku: 'PRD-0002-JAU-S', color: 'Jaune HV', size: 'S', active: true, barcode: '4006381333931' }, { sku: 'PRD-0002-COR-M', color: 'Corail', size: 'M', barcode: '4006381333932' },
    { sku: 'PRD-0002-VER-7XL', color: 'Vert pomme', size: '7XL' }, { sku: 'PRD-0002-JAU-M', color: 'Jaune HV', size: 'M', active: false }], measurements: [], care: {}, packaging: {} }
await as(comm, () => db.query(`update product_versions set spec=$2::jsonb where id=$1`, [v2, JSON.stringify(spec2)]))
const sync = await as(comm, () => rpc('variant_sync_from_spec', p2.id))
ok('import : 1 couleur et 1 taille créées au catalogue (Vert pomme, 7XL), 3 variantes actives (la variante inactive est ignorée)', sync.colors_created === 1 && sync.sizes_created === 1 && sync.variants_created === 3, JSON.stringify(sync))
const imp = await q(`select v.sku, v.barcode, c.name color from product_variants v join colors c on c.id=v.color_id where v.product_id=$1 order by v.sku`, [p2.id])
ok('import : SKU de la fiche conservés, code-barres valide repris, code-barres invalide ignoré', imp.map((r) => r.sku).join() === 'PRD-0002-COR-M,PRD-0002-JAU-S,PRD-0002-VER-7XL' && imp.find((r) => r.sku === 'PRD-0002-JAU-S').barcode === '4006381333931' && imp.find((r) => r.sku === 'PRD-0002-COR-M').barcode === null)
ok('import idempotent', (await as(comm, () => rpc('variant_sync_from_spec', p2.id))).variants_created === 0)
const p3 = await mkProduct('POLO HV')
await as(comm, () => db.query(`update product_versions set spec=$2::jsonb where product_id=$1`, [p3.id, JSON.stringify({ tech: {}, colors: [{ name: 'Marine' }, { name: 'Jaune HV' }], sizes: [{ label: 'M' }, { label: 'L' }], variants: [], measurements: [], care: {}, packaging: {} })]))
ok('import sans liste de variantes : matrice couleurs × tailles (2 × 2)', (await as(comm, () => rpc('variant_sync_from_spec', p3.id))).variants_created === 4)

// --- 4. Codes-barres ----------------------------------------------------------------------------------------------------------------------------
ok('GTIN : somme de contrôle (4006381333931 valide, …932 invalide, EAN-8 73513537 valide)', (await q(`select private.gtin_valid('4006381333931') a, private.gtin_valid('4006381333932') b, private.gtin_valid('73513537') c, private.gtin_valid('12345') d, private.gtin_valid('40063813339a1') e`))[0].a === true
  && (await q(`select private.gtin_valid('4006381333932') b`))[0].b === false && (await q(`select private.gtin_valid('73513537') c`))[0].c === true && (await q(`select private.gtin_valid('12345') d`))[0].d === false)
const firstV = (await q(`select id from product_variants where product_id=$1 order by sku limit 1`, [p1.id]))[0].id
await rejects('code-barres : somme de contrôle invalide refusée', () => as(comm, () => db.query(`update product_variants set barcode='4006381333932' where id=$1`, [firstV])), 'product_variants_barcode_check')
await as(comm, () => db.query(`update product_variants set barcode='5901234123457' where id=$1`, [firstV]))
const secondV = (await q(`select id from product_variants where product_id=$1 order by sku offset 1 limit 1`, [p1.id]))[0].id
await rejects('code-barres déjà utilisé par une autre variante refusé', () => as(comm, () => db.query(`update product_variants set barcode='5901234123457' where id=$1`, [secondV])), 'product_variants_barcode_uq')
const assigned = await as(comm, () => rpc('variant_assign_barcodes', p1.id))
const bars = (await q(`select barcode from product_variants where product_id=$1`, [p1.id])).map((r) => r.barcode)
ok('codes-barres internes EAN-13 générés pour les 19 variantes sans code', assigned === 19 && bars.every(Boolean) && new Set(bars).size === 20)
ok('codes générés valides (somme de contrôle) et en plage interne (préfixe 29)', (await q(`select count(*)::int n from product_variants where product_id=$1 and barcode like '29%' and private.gtin_valid(barcode)`, [p1.id]))[0].n === 19)
ok('génération idempotente', (await as(comm, () => rpc('variant_assign_barcodes', p1.id))) === 0)

// --- 5. Prix, activation, nomenclature par variante ------------------------------------------------------------------------------------------------
const all1 = await q(`select v.id, v.sku, s.code size from product_variants v join sizes s on s.id=v.size_id where v.product_id=$1 order by v.sku`, [p1.id])
const surcharge = { S: 0, M: 0, L: 0, XL: 2, XXL: 4 }
const changes = all1.filter((v) => v.size in surcharge).map((v) => ({ id: v.id, price: 59 + surcharge[v.size] }))
const nPrice = await as(comm, () => rpc('variant_bulk_update', p1.id, JSON.stringify(changes)))
ok('prix par variante : 20 variantes avec supplément de taille (59 / 61 / 63 €)', nPrice === 20 && (await q(`select count(*)::int n from product_variants where product_id=$1 and price=63`, [p1.id]))[0].n === 4)
ok('prix : historique agrégé (une ligne d’audit pour le lot)', (await q(`select metadata from audit_logs where action='variant.bulk_update' order by created_at desc limit 1`))[0].metadata.count === 20)
await rejects('prix négatif refusé', () => as(comm, () => rpc('variant_bulk_update', p1.id, JSON.stringify([{ id: all1[0].id, price: -1 }]))), 'product_variants_price_check')
const foreignV = (await q(`select id from product_variants where product_id=$1 limit 1`, [p2.id]))[0].id
await rejects('mise à jour groupée : variante d’un autre produit refusée', () => as(comm, () => rpc('variant_bulk_update', p1.id, JSON.stringify([{ id: foreignV, price: 1 }]))), 'VARIANT_NOT_FOUND')
await rejects('mise à jour groupée : prix en lecture seule pour le magasin', () => as(mag, () => rpc('variant_bulk_update', p1.id, JSON.stringify(changes))), 'RBAC_FORBIDDEN')
await as(comm, () => rpc('variant_bulk_update', p1.id, JSON.stringify([{ id: all1[0].id, active: false }, { id: all1[1].id, price: null }])))
ok('désactivation et effacement du prix', (await q(`select active from product_variants where id=$1`, [all1[0].id]))[0].active === false && (await q(`select price from product_variants where id=$1`, [all1[1].id]))[0].price === null)

const art = (await as(comm, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-HV-1','Veste HV','jacket') returning id`, [lafont])))[0].id
const artO = (await as(comm, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'BRG-1','Veste Bragard','jacket') returning id`, [other])))[0].id
const bomP = (await as(prod, () => q(`insert into boms(name, article_id) values ('Veste HV', $1) returning id`, [art])))[0].id
const bomVar = (await as(prod, () => q(`insert into boms(name) values ('Veste HV — Marine') returning id`)))[0].id
const bomO = (await as(prod, () => q(`insert into boms(name, article_id) values ('BOM Bragard', $1) returning id`, [artO])))[0].id
const bomSub = (await as(prod, () => q(`insert into boms(name, kind) values ('Capuche','subassembly') returning id`)))[0].id
await as(comm, () => db.query(`update product_master set article_id=$2 where id=$1`, [p1.id, art]))
const marine = (await q(`select v.id from product_variants v join colors c on c.id=v.color_id where v.product_id=$1 and c.code='MAR'`, [p1.id])).map((r) => r.id)
await as(comm, () => rpc('variant_bulk_update', p1.id, JSON.stringify(marine.map((id) => ({ id, bom_id: bomVar })))))
ok('nomenclature propre à la couleur Marine (5 variantes), sans article requis', (await q(`select count(*)::int n from product_variants where product_id=$1 and bom_id=$2`, [p1.id, bomVar]))[0].n === 5)
await rejects('nomenclature d’un article d’un autre client refusée', () => as(comm, () => db.query(`update product_variants set bom_id=$2 where id=$1`, [marine[0], bomO])), 'VARIANT_BAD_BOM')
await rejects('sous-ensemble refusé comme nomenclature de variante', () => as(comm, () => db.query(`update product_variants set bom_id=$2 where id=$1`, [marine[0], bomSub])), 'VARIANT_BAD_BOM')
await as(admin, () => db.query(`select 1`))
const mx0 = await as(comm, () => rpc('variant_matrix', p1.id))
ok('matrice : nomenclature produit (via l’article) et nomenclature de variante exposées', mx0.product_bom.id === bomP && mx0.variants.filter((v) => v.bom_code).length === 5)

// --- 6. Stock par variante ----------------------------------------------------------------------------------------------------------------------
const wh1 = (await q(`insert into warehouses(company_id, code, name) values ($1,'WH-T1','Magasin principal') returning id`, [company]))[0].id

const wh2 = (await q(`insert into warehouses(company_id, code, name) values ($1,'WH-T2','Dépôt Sfax') returning id`, [company]))[0].id
const whArch = (await q(`insert into warehouses(company_id, code, name) values ($1,'WH-T3','Ancien dépôt') returning id`, [company]))[0].id
// affectation : le magasinier responsable de ces entrepôts (la création est réservée à l'admin)
for (const w of [wh1, wh2, whArch]) await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'manager')`, [company, mag, w])
await db.exec(`select set_config('stock.rpc','on',false)`); await db.query(`update warehouses set archived_at=now() where id=$1`, [whArch]); await db.exec(`select set_config('stock.rpc','off',false)`)
const vA = all1.find((v) => v.sku === 'PRD-0001-JAU-M').id
const mv = (u, ...a) => as(u, () => rpc('variant_stock_move', ...a))
const r1 = await mv(mag, vA, 'receipt', wh1, 100, null, 'Fin de lot OF-2026-014', null)
ok('entrée de production : 100 pièces', r1.on_hand === 100 && r1.available === 100)
await mv(mag, vA, 'issue', wh1, 30, null, 'Expédition CMD-0001')
await rejects('sortie supérieure au disponible refusée', () => mv(mag, vA, 'issue', wh1, 80), 'VARIANT_STOCK_INSUFFICIENT')
const rs = await as(mag, () => rpc('variant_stock_reserve', vA, wh1, 20))
ok('réservation : 70 en stock, 20 réservées, 50 disponibles', rs.on_hand === 70 && rs.reserved === 20 && rs.available === 50)
await rejects('sortie au-delà du disponible (réservations déduites) refusée', () => mv(mag, vA, 'issue', wh1, 60), 'VARIANT_STOCK_INSUFFICIENT')
await rejects('réservation supérieure au stock refusée', () => as(mag, () => rpc('variant_stock_reserve', vA, wh1, 60)), 'VARIANT_STOCK_INSUFFICIENT')
await rejects('ajustement sans motif refusé', () => mv(mag, vA, 'adjustment', wh1, -5), 'VARIANT_REASON_REQUIRED')
await mv(mag, vA, 'adjustment', wh1, -5, null, 'Pièce défectueuse')
await rejects('ajustement sous le niveau réservé refusé', () => mv(mag, vA, 'adjustment', wh1, -50, null, 'Erreur'), 'VARIANT_STOCK_INSUFFICIENT')
const inv = await mv(mag, vA, 'inventory', wh1, 40)
ok('inventaire : comptage de 40 (écart −25) ; 20 réservées', inv.on_hand === 40 && inv.reserved === 20)
await rejects('inventaire sans écart refusé', () => mv(mag, vA, 'inventory', wh1, 40), 'VARIANT_NO_CHANGE')
await rejects('inventaire sous le réservé refusé', () => mv(mag, vA, 'inventory', wh1, 10), 'VARIANT_STOCK_INSUFFICIENT')
const tr = await mv(mag, vA, 'transfer', wh1, 15, wh2, 'Réapprovisionnement Sfax')
ok('transfert de 15 vers le dépôt de Sfax', tr.on_hand === 25 && (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [vA, wh2]))[0].qty_on_hand === 15)
await rejects('transfert au-delà du disponible refusé (25 − 20 réservées = 5)', () => mv(mag, vA, 'transfer', wh1, 10, wh2), 'VARIANT_STOCK_INSUFFICIENT')
await rejects('transfert vers le même entrepôt refusé', () => mv(mag, vA, 'transfer', wh1, 1, wh1), 'VARIANT_BAD_WAREHOUSE')
await rejects('entrepôt archivé refusé', () => mv(mag, vA, 'receipt', whArch, 1), 'VARIANT_BAD_WAREHOUSE')
await rejects('quantité nulle ou négative refusée', () => mv(mag, vA, 'receipt', wh1, 0), 'VARIANT_BAD_QTY')
await rejects('mouvement réservé à variants.stock (commercial refusé)', () => mv(comm, vA, 'receipt', wh1, 5), 'RBAC_FORBIDDEN')
await rejects('finance : lecture seule du stock', () => mv(fin, vA, 'receipt', wh1, 5), 'RBAC_FORBIDDEN')
await as(mag, () => rpc('variant_stock_set_safety', vA, wh1, 30))
const moves = await q(`select move_type, qty_delta, balance_after, transfer_group from variant_stock_moves where variant_id=$1 order by created_at, (move_type = 'transfer_in')`, [vA])
ok('journal des mouvements : entrée, sortie, ajustement, inventaire, transfert (2 lignes liées), soldes enchaînés', moves.map((m) => m.move_type).join() === 'receipt,issue,adjustment,inventory,transfer_out,transfer_in'
  && moves[0].balance_after === 100 && moves[1].balance_after === 70 && moves[2].balance_after === 65 && moves[3].balance_after === 40 && moves[4].balance_after === 25 && moves[4].transfer_group === moves[5].transfer_group)
ok('stock cohérent : somme des écarts = solde ; entrepôt 1 = 25, entrepôt 2 = 15', moves.filter((m) => m.move_type !== 'transfer_in').reduce((a, m) => a + m.qty_delta, 0) === 25 && (await q(`select sum(qty_on_hand)::int n from variant_stock where variant_id=$1`, [vA]))[0].n === 40)
await rejects('journal non modifiable', () => as(admin, () => db.query(`update variant_stock_moves set qty_delta=1`)), 'permission denied')
await rejects('journal non supprimable', () => as(admin, () => db.query(`delete from variant_stock_moves`)), 'permission denied')
await rejects('stock non modifiable en direct', () => as(admin, () => db.query(`update variant_stock set qty_on_hand=999`)), 'permission denied')
const mx = await as(mag, () => rpc('variant_matrix', p1.id))
const mA = mx.variants.find((v) => v.id === vA)
ok('matrice : stock total 40, réservé 20, alerte « stock bas » (disponible 5 ≤ sécurité 30), détail par entrepôt', mA.on_hand === 40 && mA.reserved === 20 && mA.low === true && mA.stock.length === 2 && mx.warehouses.length === 2)
await rejects('suppression d’une variante avec historique de stock refusée', () => as(comm, () => rpc('variant_delete', vA)), 'VARIANT_HAS_STOCK')
const vDel = all1.find((v) => v.sku === 'PRD-0001-ORA-S').id
await as(comm, () => rpc('variant_delete', vDel))
ok('variante sans stock supprimable', (await q(`select 1 from product_variants where id=$1`, [vDel])).length === 0)

// --- 7. Vue d'ensemble, archivage, historique, isolation --------------------------------------------------------------------------------------------
const ov = (await as(qual, () => rpc('variant_overview'))).find((r) => r.product_id === p1.id)
ok('vue d’ensemble : variantes, couleurs, tailles, stock, ruptures, codes-barres et prix manquants', ov.variants === 19 && ov.colors === 4 && ov.sizes === 5 && ov.on_hand === 40 && ov.low === 1 && ov.out_of_stock === 17 && ov.missing_price === 1 && ov.missing_barcode === 0, JSON.stringify(ov))
await as(admin, () => rpc('product_archive', p1.id, 'Fin de série'))
await rejects('produit archivé : génération refusée', () => as(comm, () => rpc('variant_generate', p1.id, colJMO, sizes5)), 'VARIANT_PRODUCT_ARCHIVED')
await rejects('produit archivé : mise à jour refusée', () => as(comm, () => rpc('variant_bulk_update', p1.id, JSON.stringify([{ id: vA, price: 1 }]))), 'VARIANT_PRODUCT_ARCHIVED')
await rejects('produit archivé : modification directe refusée', () => as(comm, () => db.query(`update product_variants set price=1 where id=$1`, [vA])), 'VARIANT_PRODUCT_ARCHIVED')
await mv(mag, vA, 'receipt', wh1, 5, null, 'Retour client')
ok('produit archivé : le stock reste gérable', (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [vA, wh1]))[0].qty_on_hand === 30)
ok('vue d’ensemble : les produits archivés disparaissent', !(await as(qual, () => rpc('variant_overview'))).some((r) => r.product_id === p1.id))

const acts = new Set((await q(`select action from audit_logs where entity_type in ('variant','variant_catalog')`)).map((r) => r.action))
for (const a of ['variant.size_add', 'variant.size_update', 'variant.color_add', 'variant.generate', 'variant.sync_spec', 'variant.barcodes', 'variant.bulk_update', 'variant.update', 'variant.stock_move', 'variant.stock_reserve', 'variant.stock_safety', 'variant.delete'])
  ok(`historique : ${a}`, acts.has(a))
const upd = (await q(`select before_data, after_data from audit_logs where action='variant.update' limit 1`))[0]
ok('historique : avant/après d’une modification directe', upd && upd.before_data.barcode !== undefined)
ok('historique lisible avec variants.read, pas sans', (await as(fin, () => q(`select id from audit_logs where entity_type='variant'`))).length > 0 && (await as(nobody, () => q(`select id from audit_logs where entity_type='variant'`))).length === 0)
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
await db.query(`select private.variants_seed($1)`, [co2])
ok('isolation entre sociétés : catalogues propres à chaque société', (await as(admin, () => q(`select id from sizes where company_id=$1`, [co2]))).length === 0 && (await q(`select count(*)::int n from sizes where company_id=$1`, [co2]))[0].n === 21)
const cli2 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CLI-9','Étranger','FR') returning id`, [co2]))[0].id
const pForeign = (await q(`insert into product_master(company_id, client_id, code, name) values ($1,$2,'PRD-9001','Étranger') returning id`, [co2, cli2]))[0].id
await rejects('produit d’une autre société introuvable', () => as(admin, () => rpc('variant_matrix', pForeign)), 'VARIANT_PRODUCT_NOT_FOUND')
ok('sans droit : aucune lecture des variantes ni du stock', (await as(nobody, () => q(`select id from product_variants`))).length === 0 && (await as(nobody, () => q(`select id from variant_stock_moves`))).length === 0)

process.exit(process.exitCode ?? 0)
