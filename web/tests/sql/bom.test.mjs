import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql'])
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
const comm = await mkUser('comm@x.com', 'commercial')
const achat = await mkUser('achat@x.com', 'achat')
const prod = await mkUser('prod@x.com', 'production')
const qual = await mkUser('qual@x.com', 'qualite')
const dir = await mkUser('dir@x.com', 'direction')
const mag = await mkUser('mag@x.com', 'magasin')
const fin = await mkUser('fin@x.com', 'finance')

// --- 0. Permissions par défaut -------------------------------------------------------------------------------------------------
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
const has = async (c, ...codes) => { const p = await perms(c); return codes.every((x) => p.includes(x)) }
ok('admin : bom.read/write/validate', await has('admin', 'bom.read', 'bom.write', 'bom.validate'))
ok('production : bom.write sans costs.read', (await has('production', 'bom.read', 'bom.write')) && !(await has('production', 'costs.read')))
ok('achat : bom.write + costs.read (catalogue et prix)', await has('achat', 'bom.read', 'bom.write', 'costs.read'))
ok('qualité et direction valident', (await has('qualite', 'bom.validate')) && (await has('direction', 'bom.validate', 'costs.read')))
ok('commercial, magasin, finance : lecture seule', (await has('commercial', 'bom.read')) && !(await has('commercial', 'bom.write')) && (await has('magasin', 'bom.read')) && !(await has('magasin', 'bom.write')) && (await has('finance', 'bom.read', 'costs.read')) && !(await has('finance', 'bom.write')))

// --- 1. Composants ---------------------------------------------------------------------------------------------------------------
const mat = (u, o) => as(u, async () => (await q(`insert into bom_materials(name, category, unit, color, description) values ($1,$2,$3,$4,$5) returning *`, [o.name, o.category ?? 'other', o.unit ?? 'pc', o.color ?? null, o.desc ?? null]))[0])
const price = (u, id, cost) => as(u, () => db.query(`insert into bom_material_prices(material_id, unit_cost) values ($1,$2)`, [id, cost]))
const tissu = await mat(prod, { name: 'Tissu jaune HV 120 g', category: 'fabric', unit: 'm', color: 'Jaune HV' })
ok('composant créé : code MAT-0001 généré, société déduite', tissu.code === 'MAT-0001' && tissu.company_id === company && tissu.created_by === prod)
const zip = await mat(prod, { name: 'Zip 60 cm', category: 'zip' })
const bouton = await mat(prod, { name: 'Bouton pression', category: 'button' })
const fil = await mat(prod, { name: 'Fil polyester', category: 'thread', unit: 'm' })
ok('codes séquentiels', [zip.code, bouton.code, fil.code].join() === 'MAT-0002,MAT-0003,MAT-0004')
await rejects('création refusée sans bom.write (commercial)', () => mat(comm, { name: 'Interdit' }), 'row-level security')
await rejects('catégorie invalide', () => mat(prod, { name: 'Test cat', category: 'chapeau' }), 'category')
await rejects('unité invalide', () => mat(prod, { name: 'Test unité', unit: 'tonne' }), 'unit')
await rejects('code non modifiable', () => as(prod, () => db.query(`update bom_materials set code='X' where id=$1`, [tissu.id])), 'permission denied')

// prix : confidentiels
await rejects('la production (sans costs.read) ne peut pas fixer un prix', () => price(prod, tissu.id, 8.5), 'row-level security')
await price(achat, tissu.id, 8.5)
await price(achat, zip.id, 1.2)
await price(achat, bouton.id, 0.15)
await price(achat, fil.id, 0.001)
ok('prix fixés par l’achat', (await q(`select count(*)::int n from bom_material_prices`))[0].n === 4)
ok('prix invisibles : production, commercial, magasin', (await as(prod, () => q(`select * from bom_material_prices`))).length === 0 && (await as(comm, () => q(`select * from bom_material_prices`))).length === 0 && (await as(mag, () => q(`select * from bom_material_prices`))).length === 0)
ok('prix visibles : achat, finance, direction', (await as(achat, () => q(`select * from bom_material_prices`))).length === 4 && (await as(fin, () => q(`select * from bom_material_prices`))).length === 4 && (await as(dir, () => q(`select * from bom_material_prices`))).length === 4)
ok('composants visibles par tous les lecteurs', (await as(mag, () => q(`select id from bom_materials`))).length === 4)
await rejects('prix négatif refusé', () => as(achat, () => db.query(`update bom_material_prices set unit_cost=-1 where material_id=$1`, [fil.id])), 'unit_cost')
await as(achat, () => db.query(`update bom_material_prices set unit_cost=9 where material_id=$1`, [tissu.id]))
await as(achat, () => db.query(`update bom_material_prices set unit_cost=8.5 where material_id=$1`, [tissu.id]))
ok('modification de prix tracée (avant → après)', (await q(`select before_data, after_data from audit_logs where action='material.price_update' order by id desc limit 1`))[0].before_data.unit_cost == 9)
await as(prod, () => db.query(`update bom_materials set color='Jaune fluo' where id=$1`, [tissu.id]))
await as(prod, () => db.query(`update bom_materials set color='Jaune HV' where id=$1`, [tissu.id]))

// --- 2. Nomenclature « Veste HV » ----------------------------------------------------------------------------------------------------
const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const art = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT001','LAF-HV-JKT-2027','Veste haute visibilité','jacket') returning id`, [lafont])))[0].id
const art2 = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT002','LAF-HV-JKT-2028','Veste HV hiver','jacket') returning id`, [lafont])))[0].id
const mkBom = (u, o) => as(u, async () => (await q(`insert into boms(name, kind, article_id, description) values ($1,$2,$3,$4) returning *`, [o.name, o.kind ?? 'product', o.article ?? null, o.desc ?? null]))[0])
const veste = await mkBom(prod, { name: 'Veste HV', article: art })
ok('BOM créé : code BOM-0001, brouillon, société déduite', veste.code === 'BOM-0001' && veste.company_id === company && veste.kind === 'product')
const verOf = async (bom, n = 1) => (await q(`select * from bom_versions where bom_id=$1 and version_no=$2`, [bom, n]))[0]
let v1 = await verOf(veste.id)
ok('version 1 (brouillon) + paramètres de coût créés automatiquement', v1.status === 'draft' && (await q(`select * from bom_version_costs where version_id=$1`, [v1.id])).length === 1)
ok('version courante suivie, aucune validée', (await q(`select current_version_id, active_version_id from boms where id=$1`, [veste.id]))[0].current_version_id === v1.id && (await q(`select active_version_id from boms where id=$1`, [veste.id]))[0].active_version_id === null)
await rejects('une seule nomenclature active par article', () => mkBom(prod, { name: 'Doublon', article: art }), 'boms_article_uq')
await rejects('création refusée sans bom.write (magasin)', () => mkBom(mag, { name: 'Interdit' }), 'row-level security')
await rejects('sous-ensemble rattaché à un article refusé', () => mkBom(prod, { name: 'Capuche X', kind: 'subassembly', article: art2 }), 'boms_subassembly_no_article')
await rejects('code BOM non modifiable', () => as(prod, () => db.query(`update boms set code='Z' where id=$1`, [veste.id])), 'permission denied')

const addLine = (u, version, material, qty, waste = 0, note = null) => as(u, async () => (await q(`insert into bom_lines(version_id, line_type, material_id, quantity, waste_pct, note) values ($1,'material',$2,$3,$4,$5) returning *`, [version, material, qty, waste, note]))[0])
const addChild = (u, version, child, qty) => as(u, async () => (await q(`insert into bom_lines(version_id, line_type, child_bom_id, quantity) values ($1,'bom',$2,$3) returning *`, [version, child, qty]))[0])
const addOp = (u, version, name, minutes) => as(u, async () => (await q(`insert into bom_operations(version_id, name, minutes) values ($1,$2,$3) returning *`, [version, name, minutes]))[0])

const l1 = await addLine(prod, v1.id, tissu.id, 2.2, 5)
await addLine(prod, v1.id, zip.id, 1)
await addLine(prod, v1.id, bouton.id, 6)
await addLine(prod, v1.id, fil.id, 180)
ok('lignes : position automatique 1..4, société/BOM déduits', (await q(`select pos from bom_lines where version_id=$1 order by pos`, [v1.id])).map((r) => r.pos).join() === '1,2,3,4' && l1.bom_id === veste.id && l1.company_id === company)
await rejects('ligne : quantité nulle refusée', () => addLine(prod, v1.id, zip.id, 0), 'quantity')
await rejects('ligne : perte > 100 % refusée', () => addLine(prod, v1.id, zip.id, 1, 150), 'waste_pct')
await rejects('ligne : refusée sans bom.write', () => addLine(comm, v1.id, zip.id, 1), 'row-level security')
await rejects('ligne : bom_id non modifiable', () => as(prod, () => db.query(`update bom_lines set bom_id=$2 where id=$1`, [l1.id, veste.id])), 'permission denied')

await as(achat, () => db.query(`update bom_version_costs set hourly_rate=12, overhead_pct=10 where version_id=$1`, [v1.id]))
await addOp(prod, v1.id, 'Coupe', 6); await addOp(prod, v1.id, 'Assemblage', 18); await addOp(prod, v1.id, 'Finitions', 6)
await rejects('opération : durée nulle refusée', () => addOp(prod, v1.id, 'Vide', 0), 'minutes')
await rejects('production : taux horaire non modifiable (pas costs.read)', () => as(prod, () => db.query(`update bom_version_costs set hourly_rate=99 where version_id=$1`, [v1.id])).then((r) => { if (!r.affectedRows) throw new Error('row-level security') }), 'row-level security')
ok('paramètres de coût invisibles pour la production', (await as(prod, () => q(`select * from bom_version_costs`))).length === 0 && (await as(fin, () => q(`select * from bom_version_costs`))).length >= 1)

// --- 3. Calcul des coûts (exemple Veste HV) ---------------------------------------------------------------------------------------
//   matière : 2,2 m × 1,05 × 8,50 = 19,635 ; zip 1,20 ; 6 boutons 0,90 ; fil 180 m × 0,001 = 0,18 → 21,915
//   main-d'œuvre : 30 min × 12 €/h = 6,00 ; frais généraux 10 % de 27,915 = 2,7915 ; revient 30,7065
const cost1 = await as(fin, () => rpc('bom_cost', v1.id))
ok('coût matière = 21,915', near(cost1.live.material, 21.915), JSON.stringify(cost1.live))
ok('coût main-d’œuvre = 6,00 (30 min à 12 €/h)', near(cost1.live.labor, 6) && Number(cost1.live.minutes) === 30)
ok('frais généraux = 2,7915 ; coût de revient = 30,7065', near(cost1.live.overhead, 2.7915) && near(cost1.live.total, 30.7065))
ok('aucun prix manquant, aucun coût figé (brouillon)', cost1.live.missing.length === 0 && cost1.frozen === null)
await rejects('bom_cost refusé sans costs.read (production)', () => as(prod, () => rpc('bom_cost', v1.id)), 'RBAC_FORBIDDEN')
await rejects('bom_cost refusé sans costs.read (qualité)', () => as(qual, () => rpc('bom_cost', v1.id)), 'RBAC_FORBIDDEN')

// --- 4. Vue arbre ---------------------------------------------------------------------------------------------------------------------
const tree = await as(fin, () => rpc('bom_tree', v1.id))
ok('arbre : racine, version, 4 lignes, 3 opérations', tree.bom.code === 'BOM-0001' && tree.version.no === 1 && tree.lines.length === 4 && tree.operations.length === 3)
ok('arbre : ligne tissu (2,2 m, perte 5 %, quantité totale 2,31, coût 19,635)', (() => { const t = tree.lines[0]; return t.material.name.startsWith('Tissu') && near(t.qty, 2.2) && near(t.total_qty, 2.31) && near(t.cost, 19.635) && t.unit === 'm' })())
ok('arbre : totaux = calcul', near(tree.totals.total, 30.7065) && near(tree.hourly_rate, 12) && near(tree.overhead_pct, 10))
const treeProd = await as(prod, () => rpc('bom_tree', v1.id))
ok('arbre sans costs.read : structure oui, aucun montant', treeProd.lines.length === 4 && !('totals' in treeProd) && treeProd.lines.every((l) => !('cost' in l) && !('unit_cost' in l)) && treeProd.operations.every((o) => !('cost' in o)) && !('hourly_rate' in treeProd))
await rejects('arbre : refusé sans bom.read', () => as(admin, () => rpc('bom_tree', uuid())), 'BOM_NOT_FOUND')

// --- 5. Validation -----------------------------------------------------------------------------------------------------------------------
const empty = await mkBom(prod, { name: 'Vide' })
const emptyV1 = await verOf(empty.id)
await rejects('validation refusée : nomenclature vide', () => as(qual, () => rpc('bom_validate_version', emptyV1.id)), 'BOM_EMPTY')
await rejects('validation refusée sans bom.validate (production)', () => as(prod, () => rpc('bom_validate_version', v1.id)), 'RBAC_FORBIDDEN')
await rejects('la première version ne peut pas être abandonnée', () => as(prod, () => rpc('bom_discard_draft', emptyV1.id)), 'BOM_FIRST_VERSION')

const etiquette = await mat(prod, { name: 'Étiquette tissée', category: 'label' })
const testPrix = await mkBom(prod, { name: 'Test prix' })
const tpV1 = await verOf(testPrix.id)
const tpLine = await addLine(prod, tpV1.id, tissu.id, 1)
const tpLine2 = await addLine(prod, tpV1.id, etiquette.id, 2)
await addOp(prod, tpV1.id, 'Pose étiquette', 1)
await rejects('validation refusée : composant sans prix', () => as(qual, () => rpc('bom_validate_version', tpV1.id)), 'BOM_PRICE_MISSING')
ok('coût : le composant sans prix est signalé', (await as(fin, () => rpc('bom_cost', tpV1.id))).live.missing.join() === etiquette.code)
// historique des lignes / opérations (brouillon)
await as(prod, () => db.query(`update bom_lines set quantity=3 where id=$1`, [tpLine.id]))
await as(prod, () => db.query(`delete from bom_lines where id=$1`, [tpLine2.id]))
const tpOp = (await q(`select id from bom_operations where version_id=$1`, [tpV1.id]))[0].id
await as(prod, () => db.query(`update bom_operations set minutes=2 where id=$1`, [tpOp]))
await as(prod, () => db.query(`delete from bom_operations where id=$1`, [tpOp]))

await as(qual, () => rpc('bom_validate_version', v1.id, 'Nomenclature vérifiée'))
v1 = await verOf(veste.id)
ok('validation : version validée (par, quand, commentaire), version active suivie', v1.status === 'validated' && v1.validated_by === qual && v1.validated_at && v1.validation_comment === 'Nomenclature vérifiée'
  && (await q(`select active_version_id from boms where id=$1`, [veste.id]))[0].active_version_id === v1.id)
const frozen1 = (await as(fin, () => rpc('bom_cost', v1.id))).frozen
ok('coût de revient figé à la validation (30,7065)', frozen1 && near(frozen1.total, 30.7065) && near(frozen1.material, 21.915) && near(frozen1.labor, 6) && near(frozen1.overhead, 2.7915))
await rejects('validation d’une version déjà validée refusée', () => as(qual, () => rpc('bom_validate_version', v1.id)), 'BOM_BAD_STATUS')

// version validée = figée
await rejects('figée : ajout de ligne', () => addLine(prod, v1.id, fil.id, 1), 'BOM_VERSION_LOCKED')
await rejects('figée : modification de quantité', () => as(prod, () => db.query(`update bom_lines set quantity=9 where id=$1`, [l1.id])), 'BOM_VERSION_LOCKED')
await rejects('figée : suppression de ligne', () => as(prod, () => db.query(`delete from bom_lines where id=$1`, [l1.id])), 'BOM_VERSION_LOCKED')
await rejects('figée : ajout d’opération', () => addOp(prod, v1.id, 'Repassage', 3), 'BOM_VERSION_LOCKED')
await rejects('figée : taux horaire', () => as(achat, () => db.query(`update bom_version_costs set hourly_rate=20 where version_id=$1`, [v1.id])), 'BOM_VERSION_LOCKED')
await rejects('figée : note de version', () => as(prod, () => db.query(`update bom_versions set change_note='x' where id=$1`, [v1.id])), 'BOM_VERSION_LOCKED')
await rejects('statut de version non modifiable directement', () => as(prod, () => db.query(`update bom_versions set status='draft' where id=$1`, [v1.id])), 'permission denied')

// le prix change : le coût recalculé bouge, le coût figé non
await as(achat, () => db.query(`update bom_material_prices set unit_cost=10 where material_id=$1`, [tissu.id]))
const drift = await as(fin, () => rpc('bom_cost', v1.id))
ok('prix modifié : coût actuel recalculé (25,38) mais coût figé inchangé (21,915)', near(drift.live.material, 25.38) && near(drift.frozen.material, 21.915), JSON.stringify(drift))
await as(achat, () => db.query(`update bom_material_prices set unit_cost=8.5 where material_id=$1`, [tissu.id]))

// --- 6. Versions ---------------------------------------------------------------------------------------------------------------------------
const v2id = await as(prod, () => rpc('bom_new_version', veste.id, 'Plus de tissu'))
const v2 = (await q(`select * from bom_versions where id=$1`, [v2id]))[0]
ok('nouvelle version : brouillon n°2, dernière version suivie, version active inchangée', v2.version_no === 2 && v2.status === 'draft' && v2.change_note === 'Plus de tissu'
  && (await q(`select current_version_id, active_version_id from boms where id=$1`, [veste.id]))[0].current_version_id === v2id
  && (await q(`select active_version_id from boms where id=$1`, [veste.id]))[0].active_version_id === v1.id)
ok('nouvelle version : lignes, opérations et paramètres copiés', (await q(`select count(*)::int n from bom_lines where version_id=$1`, [v2id]))[0].n === 4
  && (await q(`select count(*)::int n from bom_operations where version_id=$1`, [v2id]))[0].n === 3
  && (await q(`select hourly_rate::float h, overhead_pct::float o from bom_version_costs where version_id=$1`, [v2id]))[0].h === 12)
await rejects('un seul brouillon à la fois', () => as(prod, () => rpc('bom_new_version', veste.id)), 'BOM_DRAFT_EXISTS')
await rejects('nouvelle version refusée sans bom.write', () => as(qual, () => rpc('bom_new_version', veste.id)), 'RBAC_FORBIDDEN')
const l2 = (await q(`select id from bom_lines where version_id=$1 and material_id=$2`, [v2id, tissu.id]))[0].id
await as(prod, () => db.query(`update bom_lines set quantity=2.4 where id=$1`, [l2]))
ok('la version validée n’est pas touchée par l’édition du brouillon', Number((await q(`select quantity from bom_lines where id=$1`, [l1.id]))[0].quantity) === 2.2)
const c2 = (await as(fin, () => rpc('bom_cost', v2id))).live
ok('coût du brouillon v2 : matière 23,70 ; MO 6 ; frais 2,97 ; revient 32,67', near(c2.material, 23.7) && near(c2.labor, 6) && near(c2.overhead, 2.97) && near(c2.total, 32.67), JSON.stringify(c2))
await as(dir, () => rpc('bom_validate_version', v2id, 'OK direction'))
ok('validation v2 : v1 devient obsolète, v2 active', (await verOf(veste.id, 1)).status === 'obsolete' && (await q(`select active_version_id from boms where id=$1`, [veste.id]))[0].active_version_id === v2id)
ok('chaque version garde son propre coût figé', near((await as(fin, () => rpc('bom_cost', v1.id))).frozen.total, 30.7065) && near((await as(fin, () => rpc('bom_cost', v2id))).frozen.total, 32.67))
const v3tmp = await as(prod, () => rpc('bom_new_version', veste.id, 'Essai abandonné'))
await as(prod, () => rpc('bom_discard_draft', v3tmp))
ok('brouillon abandonné : version et lignes supprimées', (await q(`select count(*)::int n from bom_versions where id=$1`, [v3tmp]))[0].n === 0 && (await q(`select count(*)::int n from bom_lines where version_id=$1`, [v3tmp]))[0].n === 0)
await rejects('abandon refusé : version validée', () => as(prod, () => rpc('bom_discard_draft', v2id)), 'BOM_BAD_STATUS')

// --- 7. Sous-ensembles, arbre multi-niveaux ----------------------------------------------------------------------------------------------
const capuche = await mkBom(prod, { name: 'Capuche', kind: 'subassembly' })
const cV1 = await verOf(capuche.id)
await addLine(prod, cV1.id, tissu.id, 0.4)
await addOp(prod, cV1.id, 'Assemblage capuche', 5)
await as(achat, () => db.query(`update bom_version_costs set hourly_rate=12 where version_id=$1`, [cV1.id]))
const v3id = await as(prod, () => rpc('bom_new_version', veste.id, 'Ajout capuche'))
const childLine = await addChild(prod, v3id, capuche.id, 2)
ok('sous-ensemble ajouté (ligne de type « bom »)', childLine.line_type === 'bom' && childLine.child_bom_id === capuche.id && childLine.material_id === null)
await rejects('ligne : perte refusée sur un sous-ensemble', () => as(prod, () => db.query(`insert into bom_lines(version_id,line_type,child_bom_id,quantity,waste_pct) values ($1,'bom',$2,1,5)`, [v3id, capuche.id])), 'bom_lines_kind_ck')
await rejects('ligne : composant ET sous-ensemble refusés', () => as(prod, () => db.query(`insert into bom_lines(version_id,line_type,material_id,child_bom_id,quantity) values ($1,'material',$2,$3,1)`, [v3id, tissu.id, capuche.id])), 'bom_lines_kind_ck')
await rejects('validation refusée : sous-ensemble non validé', () => as(qual, () => rpc('bom_validate_version', v3id)), 'BOM_CHILD_NOT_VALIDATED')
await as(qual, () => rpc('bom_validate_version', cV1.id))
// capuche : 0,4 m × 8,50 = 3,40 ; 5 min × 12 = 1,00 ; ×2 → matière +6,80, MO +2,00
const c3 = (await as(fin, () => rpc('bom_cost', v3id))).live
ok('coût avec sous-ensemble ×2 : matière 30,50 ; MO 8 ; frais 3,85 ; revient 42,35', near(c3.material, 30.5) && near(c3.labor, 8) && near(c3.overhead, 3.85) && near(c3.total, 42.35), JSON.stringify(c3))
const t3 = await as(fin, () => rpc('bom_tree', v3id))
const childNode = t3.lines.find((l) => l.type === 'bom')
ok('arbre : sous-ensemble déplié avec ses lignes et opérations', childNode.child.code === capuche.code && childNode.node.lines.length === 1 && childNode.node.operations.length === 1)
ok('arbre : quantité cumulée (0,4 m × 2 = 0,8) et coût du sous-ensemble (2 × 4,40 = 8,80)', near(childNode.node.lines[0].total_qty, 0.8) && near(childNode.cost, 8.8) && near(childNode.node.operations[0].total_minutes, 10))
await as(qual, () => rpc('bom_validate_version', v3id, 'Avec capuche'))
ok('validation v3 : coût figé 42,35', near((await as(fin, () => rpc('bom_cost', v3id))).frozen.total, 42.35))

// 3 niveaux : cordon dans la capuche (v2 de la capuche)
const cordon = await mkBom(prod, { name: 'Cordon', kind: 'subassembly' })
const cordV1 = await verOf(cordon.id)
await addLine(prod, cordV1.id, fil.id, 100)
await as(qual, () => rpc('bom_validate_version', cordV1.id))   // 100 m × 0,001 = 0,10
const cV2 = await as(prod, () => rpc('bom_new_version', capuche.id, 'Ajout du cordon'))
await addChild(prod, cV2, cordon.id, 2)
await rejects('cycle direct refusé (un BOM ne se contient pas)', () => addChild(prod, cV2, capuche.id, 1), 'BOM_CYCLE')
await rejects('cycle indirect refusé (capuche → veste → capuche)', () => addChild(prod, cV2, veste.id, 1), 'BOM_CYCLE')
await as(qual, () => rpc('bom_validate_version', cV2))        // capuche : matière 3,40 + 0,20 = 3,60 ; MO 1,00
const live3 = (await as(fin, () => rpc('bom_cost', v3id)))
ok('la nomenclature parente suit la version validée du sous-ensemble : revient actuel 42,79, figé 42,35', near(live3.live.total, 42.79) && near(live3.frozen.total, 42.35), JSON.stringify(live3))
const t3b = await as(fin, () => rpc('bom_tree', v3id))
const cordLine = t3b.lines.find((l) => l.type === 'bom').node.lines.find((l) => l.type === 'bom')
ok('arbre à 3 niveaux : cordon ×2 dans capuche ×2 → fil 100 m × 4 = 400 m', cordLine.child.code === cordon.code && near(cordLine.node.lines[0].total_qty, 400))
ok('les sous-ensembles validés sont lisibles sans coût pour la production', !('cost' in (await as(prod, () => rpc('bom_tree', v3id))).lines.find((l) => l.type === 'bom')))

// --- 8. Duplication --------------------------------------------------------------------------------------------------------------------------
const dupId = await as(prod, () => rpc('bom_duplicate', veste.id, 'Veste HV hiver', art2))
const dup = (await q(`select * from boms where id=$1`, [dupId]))[0]
const dupV1 = await verOf(dupId)
ok('duplication : nouveau code, même type, article choisi, version 1 brouillon', /^BOM-\d{4}$/.test(dup.code) && dup.code !== veste.code && dup.kind === 'product' && dup.article_id === art2 && dupV1.status === 'draft')
ok('duplication : lignes (5), opérations (3) et paramètres copiés depuis la version validée', (await q(`select count(*)::int n from bom_lines where version_id=$1`, [dupV1.id]))[0].n === 5
  && (await q(`select count(*)::int n from bom_operations where version_id=$1`, [dupV1.id]))[0].n === 3
  && (await q(`select hourly_rate::float h, overhead_pct::float o from bom_version_costs where version_id=$1`, [dupV1.id]))[0].o === 10)
ok('duplication : même coût que la source, source inchangée', near((await as(fin, () => rpc('bom_cost', dupV1.id))).live.total, 42.79) && (await q(`select count(*)::int n from bom_lines where version_id=$1`, [v3id]))[0].n === 5)
const dup2 = await as(prod, () => rpc('bom_duplicate', veste.id, 'Modèle sans article', null, v1.id))
ok('duplication d’une version précise (v1 → 4 lignes)', (await q(`select count(*)::int n from bom_lines where version_id=$1`, [(await verOf(dup2)).id]))[0].n === 4)
await rejects('duplication : article déjà pourvu d’une nomenclature', () => as(prod, () => rpc('bom_duplicate', veste.id, 'Encore', art)), 'boms_article_uq')
await rejects('duplication : nom trop court', () => as(prod, () => rpc('bom_duplicate', veste.id, 'A')), 'BOM_INVALID_NAME')
await rejects('duplication : sous-ensemble + article refusé', () => as(prod, () => rpc('bom_duplicate', capuche.id, 'Capuche bis', art2)), 'BOM_BAD_ARTICLE')
await rejects('duplication refusée sans bom.write', () => as(comm, () => rpc('bom_duplicate', veste.id, 'Interdit')), 'RBAC_FORBIDDEN')
ok('duplication tracée (source), sans entrée « création » en double', (await q(`select metadata from audit_logs where action='bom.duplicate' and entity_id=$1`, [dupId]))[0].metadata.source_code === veste.code
  && (await q(`select count(*)::int n from audit_logs where action='bom.create' and entity_id=$1`, [dupId]))[0].n === 0)

// --- 9. Archivage ----------------------------------------------------------------------------------------------------------------------------
await rejects('archivage refusé : sous-ensemble utilisé par une nomenclature active', () => as(prod, () => rpc('bom_archive', capuche.id)), 'BOM_USED_AS_CHILD')
await rejects('archivage refusé sans bom.write', () => as(qual, () => rpc('bom_archive', dup2)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('bom_archive', dup2, 'Modèle abandonné'))
const arch = (await q(`select * from boms where id=$1`, [dup2]))[0]
ok('archivage : date, auteur, motif', arch.archived_at && arch.archived_by === prod && arch.archive_reason === 'Modèle abandonné')
const dup2v = await verOf(dup2)
await rejects('archivé : ajout de ligne refusé', () => addLine(prod, dup2v.id, zip.id, 1), 'BOM_ARCHIVED')
await rejects('archivé : modification refusée', () => as(prod, () => db.query(`update boms set name='Renommé' where id=$1`, [dup2])), 'BOM_ARCHIVED')
await rejects('archivé : nouvelle version refusée', () => as(prod, () => rpc('bom_new_version', dup2)), 'BOM_ARCHIVED')
await rejects('archivé : double archivage refusé', () => as(prod, () => rpc('bom_archive', dup2)), 'BOM_ARCHIVED')
await rejects('archivé : utilisation comme sous-ensemble refusée', () => addChild(prod, dupV1.id, dup2, 1), 'BOM_CHILD_ARCHIVED')
await as(prod, () => rpc('bom_restore', dup2))
ok('restauration', (await q(`select archived_at from boms where id=$1`, [dup2]))[0].archived_at === null)
await rejects('restauration d’une nomenclature non archivée refusée', () => as(prod, () => rpc('bom_restore', dup2)), 'BOM_NOT_ARCHIVED')
await as(prod, () => rpc('bom_archive', dupId))                      // porte l'article JKT002
const another = await mkBom(prod, { name: 'Remplaçante', article: art2 })
await rejects('restauration refusée : l’article a déjà une nomenclature active', () => as(prod, () => rpc('bom_restore', dupId)), 'boms_article_uq')
await as(prod, () => rpc('bom_delete', another.id))
await as(prod, () => rpc('bom_restore', dupId))

// --- 10. Suppression, composants ------------------------------------------------------------------------------------------------------------
await rejects('suppression refusée : nomenclature validée', () => as(prod, () => rpc('bom_delete', veste.id)), 'BOM_IN_USE')
await rejects('suppression refusée : sous-ensemble utilisé', () => as(prod, () => rpc('bom_delete', capuche.id)), 'BOM_IN_USE')
await rejects('suppression refusée sans bom.write', () => as(comm, () => rpc('bom_delete', dup2)), 'RBAC_FORBIDDEN')
await as(prod, () => rpc('bom_delete', dup2))
await as(prod, () => rpc('bom_delete', empty.id))
ok('suppression d’un brouillon jamais validé (versions et lignes en cascade)', (await q(`select count(*)::int n from boms where id in ($1,$2)`, [dup2, empty.id]))[0].n === 0 && (await q(`select count(*)::int n from bom_lines where bom_id=$1`, [dup2]))[0].n === 0)

await rejects('composant : unité figée une fois utilisé', () => as(prod, () => db.query(`update bom_materials set unit='kg' where id=$1`, [tissu.id])), 'BOM_MATERIAL_UNIT_LOCKED')
await rejects('composant : suppression refusée si utilisé', () => as(prod, () => rpc('bom_material_delete', tissu.id)), 'BOM_MATERIAL_IN_USE')
await as(prod, () => rpc('bom_material_archive', zip.id, true))
await rejects('composant archivé : ajout dans une nomenclature refusé', () => addLine(prod, dupV1.id, zip.id, 1), 'BOM_MATERIAL_ARCHIVED')
await rejects('validation refusée : composant archivé dans la nomenclature', () => as(qual, () => rpc('bom_validate_version', dupV1.id)), 'BOM_MATERIAL_ARCHIVED')
await rejects('composant : double archivage refusé', () => as(prod, () => rpc('bom_material_archive', zip.id, true)), 'BOM_MATERIAL_ARCHIVED')
await as(prod, () => rpc('bom_material_archive', zip.id, false))
ok('composant restauré', (await q(`select archived_at from bom_materials where id=$1`, [zip.id]))[0].archived_at === null)
await as(prod, () => rpc('bom_material_delete', etiquette.id))
ok('composant jamais utilisé : supprimé (prix en cascade)', (await q(`select count(*)::int n from bom_materials where id=$1`, [etiquette.id]))[0].n === 0)
await rejects('composant : archivage refusé sans bom.write', () => as(comm, () => rpc('bom_material_archive', fil.id, true)), 'RBAC_FORBIDDEN')

// --- 11. Client archivé ---------------------------------------------------------------------------------------------------------------------
const art3 = (await as(comm, () => q(`insert into articles(client_id, internal_ref, client_ref, name, family) values ($1,'JKT003','LAF-3','Gilet','vest') returning id`, [lafont])))[0].id
await as(admin, () => rpc('client_archive', lafont, 'test'))
await rejects('client archivé : nouvelle nomenclature sur ses articles refusée', () => mkBom(prod, { name: 'Gilet', article: art3 }), 'CLIENT_ARCHIVED')
await rejects('client archivé : nouvelle version refusée', () => as(prod, () => rpc('bom_new_version', veste.id)), 'CLIENT_ARCHIVED')
await rejects('client archivé : ligne refusée dans un brouillon', () => addLine(prod, dupV1.id, fil.id, 1), 'CLIENT_ARCHIVED')
await as(admin, () => rpc('client_restore', lafont))
ok('client restauré : édition de nouveau possible', !!(await addLine(prod, dupV1.id, fil.id, 1)).id)
await rejects('un article possédant une nomenclature ne peut pas être supprimé', () => as(comm, () => rpc('article_delete', art2)), 'boms_article_id_fkey')

// --- 12. Isolation entre sociétés ------------------------------------------------------------------------------------------------------------
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
await db.query(`insert into bom_materials(company_id, code, name) values ($1,'MAT-9001','Composant étranger')`, [co2])
const foreign = (await q(`insert into boms(company_id, code, name) values ($1,'BOM-9001','Nomenclature étrangère') returning id`, [co2]))[0].id
ok('isolation : composants et nomenclatures de l’autre société invisibles', (await as(admin, () => q(`select id from bom_materials where code='MAT-9001'`))).length === 0 && (await as(admin, () => q(`select id from boms where id=$1`, [foreign]))).length === 0)
await rejects('isolation : sous-ensemble d’une autre société refusé', () => addChild(prod, dupV1.id, foreign, 1), 'BOM_NOT_FOUND')
await rejects('isolation : arbre d’une autre société refusé', () => as(admin, () => rpc('bom_tree', uuid())), 'BOM_NOT_FOUND')

// --- 13. Historique ------------------------------------------------------------------------------------------------------------------------------
const h = await q(`select action, actor_email, entity_type, entity_label, before_data, after_data, metadata from audit_logs where entity_type in ('bom','material') order by id`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['bom.create', 'bom.line_add', 'bom.line_update', 'bom.line_delete', 'bom.op_add', 'bom.op_update', 'bom.op_delete', 'bom.costing_update', 'bom.version_new', 'bom.version_validate',
  'bom.version_discard', 'bom.duplicate', 'bom.archive', 'bom.restore', 'bom.delete', 'material.create', 'material.update', 'material.price_set', 'material.price_update', 'material.archive', 'material.restore', 'material.delete'])
  ok(`historique : ${a}`, acts.has(a))
ok('historique : quantité avant → après d’une ligne', (() => { const r = h.find((x) => x.action === 'bom.line_update'); return Number(r.before_data.quantity) === 1 && Number(r.after_data.quantity) === 3 && r.metadata.component.includes('Tissu') })())
ok('historique : validation avec commentaire et version', h.find((r) => r.action === 'bom.version_validate' && r.metadata.version === 1 && r.entity_label === 'BOM-0001').metadata.comment === 'Nomenclature vérifiée')
ok('historique : taux horaire avant → après', (() => { const r = h.find((x) => x.action === 'bom.costing_update'); return Number(r.before_data.hourly_rate) === 0 && Number(r.after_data.hourly_rate) === 12 })())
ok('historique : acteur identifié', h.find((r) => r.action === 'bom.version_validate').actor_email === 'qual@x.com')
const visible = (u) => as(u, () => q(`select action from audit_logs where entity_type in ('bom','material')`))
const COST_ACTIONS = ['bom.costing_update', 'material.price_set', 'material.price_update']
const vProd = await visible(prod), vFin = await visible(fin), vCom = await visible(comm)
ok('historique lisible avec bom.read (production, commercial)', vProd.length > 0 && vCom.length > 0)
ok('historique : actions de prix et de taux masquées sans costs.read', vProd.every((r) => !COST_ACTIONS.includes(r.action)) && vCom.every((r) => !COST_ACTIONS.includes(r.action)))
ok('historique : actions de prix visibles avec costs.read (finance)', vFin.some((r) => COST_ACTIONS.includes(r.action)))

process.exit(process.exitCode ?? 0)
