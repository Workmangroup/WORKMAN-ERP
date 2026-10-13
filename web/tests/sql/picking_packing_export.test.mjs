// Picking, colisage et export : scan commande / SKU / lot / emplacement, colis individualisés, rapprochement BL,
// liste de colisage versionnée, déclaration douanière acceptée seulement sur retour officiel — P055 / migration 0080
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const count = async (sql, params) => Number((await q(sql, params))[0].n)
const d = (days) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10) }

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')       // expédition : opérateur d'entrepôt
const comm = await mkUser('com@x.com', 'commercial')   // douane : shipments.customs
const nobody = await mkUser('nobody@x.com', null)
const fin = await mkUser('fin@x.com', 'finance')

// --- Référentiel : entrepôt produits finis, client, article, produit, couleurs et tailles -----------------------------------------
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
const whF = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Expédition P55','finished_goods') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, whF])
const locCode = (await q(`select code from stock_locations where warehouse_id=$1 limit 1`, [whF]))[0].code
const client = (await q(`insert into clients(company_id, name, country, currency, vat_exempt) values ($1,'Client P55','FR','EUR',true) returning id`, [company]))[0].id
const art = (await q(`insert into articles(company_id, client_id, client_ref, name, family) values ($1,$2,'P55-A','Veste P55','jacket') returning id`, [company, client]))[0].id
const prodV = (await q(`insert into product_master(company_id, client_id, name, family, article_id) values ($1,$2,'Veste P55','jacket',$3) returning id`, [company, client, art]))[0].id
const colJ = (await q(`select id from colors where name='Jaune HV'`))[0].id
const colN = (await q(`insert into colors(company_id, code, name) values ($1,'NP55','Noir P55') returning id`, [company]))[0].id
const ensureSize = async (code) => {
  const r = await q(`select id from sizes where company_id=$1 and upper(code)=$2`, [company, code])
  if (r[0]) return r[0].id
  return (await q(`insert into sizes(company_id, code, label) values ($1,$2,$2) returning id`, [company, code]))[0].id
}
const sizeS = await ensureSize('S')
const sizeM = await ensureSize('M')
const sizeL = await ensureSize('L')
await as(admin, () => rpc('variant_generate', prodV, [colJ, colN], [sizeS, sizeM, sizeL]))
const vid = async (col, size) => (await q(`select id from product_variants where product_id=$1 and color_id=$2 and size_id=$3`, [prodV, col, size]))[0].id
const sku = async (id) => (await q(`select sku from product_variants where id=$1`, [id]))[0].sku
const JS = await vid(colJ, sizeS)
const SJS = await sku(JS)
const JM = await vid(colJ, sizeM)
const SJM = await sku(JM)
const JL = await vid(colJ, sizeL)
const SJL = await sku(JL)
const NS = await vid(colN, sizeS)
const SNS = await sku(NS)
await db.query(`update product_variants set price = 25 where product_id=$1`, [prodV])

const LOT_JS = await as(admin, () => rpc('finished_lot_receive', JS, whF, 'LOT-JS55', 5, 'OF-P55-1'))
const LOT_JM = await as(admin, () => rpc('finished_lot_receive', JM, whF, 'LOT-JM55', 5, 'OF-P55-2'))

const order = (await as(admin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [client])))[0].id
await db.query(`insert into sales_order_lines(company_id, order_id, article_id, variant_id, qty, unit_price, due_date) values ($1,$2,$3,$4,3,25,$5)`, [company, order, art, JS, d(20)])
await as(admin, () => rpc('sales_order_confirm', order))
const ORDER_CODE = (await q(`select code from sales_orders where id=$1`, [order]))[0].code

// --- Expédition : export (FR), deux lignes, prélèvement et affectation des lots ----------------------------------------------------
const S = await as(mag, () => rpc('shipment_create', order, whF, 'FCA', 'FR', 'EUR'))
const SNUM = (await q(`select number from shipments where id=$1`, [S]))[0].number
const LS = await as(mag, () => rpc('shipment_add_line', S, JS, 2))
const LM = await as(mag, () => rpc('shipment_add_line', S, JM, 1))
await as(mag, () => rpc('shipment_pick', LS, 2))
await as(mag, () => rpc('shipment_pick', LM, 1))
await as(mag, () => rpc('shipment_line_lot_assign', LS, LOT_JS, 2))
await as(mag, () => rpc('shipment_line_lot_assign', LM, LOT_JM, 1))
const S2 = await as(mag, () => rpc('shipment_create', order, whF, 'FCA', 'FR', 'EUR'))
const scan = (kind, code, key) => as(mag, () => rpc('shipment_scan', S, kind, code, key))

// --- A. Scan : commande, SKU, lot, emplacement ---------------------------------------------------------------------------------------
const r1 = await scan('order', 'COMMANDE-INCONNUE', 'scan-p55-order-1')
ok('scan commande erronée refusé (SHIP_WRONG_ORDER)', r1.ok === false && r1.code === 'SHIP_WRONG_ORDER')
ok('scan commande : le numéro de l’expédition est reconnu', (await scan('order', SNUM, 'scan-p55-order-2')).ok === true)
ok('scan SKU inconnu refusé (SHIP_SKU_UNKNOWN)', (await scan('sku', 'NOPE-000', 'scan-p55-unk-1')).code === 'SHIP_SKU_UNKNOWN')
const wrongSize = await scan('sku', SJL, 'scan-p55-size-1')
ok('mauvaise taille bloquée au scan (même pièce, taille L absente de l’expédition) : SHIP_WRONG_SIZE', wrongSize.ok === false && wrongSize.code === 'SHIP_WRONG_SIZE')
const wrongColor = await scan('sku', SNS, 'scan-p55-color-1')
ok('mauvais coloris bloqué au scan (même taille, coloris noir absent) : SHIP_WRONG_COLOR', wrongColor.ok === false && wrongColor.code === 'SHIP_WRONG_COLOR')
ok('scan refusé : aucune quantité scannée pour la mauvaise taille', (await q(`select qty_scanned from shipment_lines where id=$1`, [LS]))[0].qty_scanned === 0)

const sJS1 = await scan('sku', SJS, 'scan-p55-js-1')
const sJS1r = await scan('sku', SJS, 'scan-p55-js-1')
ok('scan SKU valide : une pièce scannée', sJS1.ok === true && (await q(`select qty_scanned from shipment_lines where id=$1`, [LS]))[0].qty_scanned === 1)
ok('rejeu de la même clé de scan : résultat rejoué, aucune seconde pièce comptée', sJS1r.replayed === true && (await q(`select qty_scanned from shipment_lines where id=$1`, [LS]))[0].qty_scanned === 1)
await scan('sku', SJS, 'scan-p55-js-2')
const over = await scan('sku', SJS, 'scan-p55-js-3')
ok('scan au-delà de la quantité prélevée refusé (SHIP_SCAN_EXCEEDS_PICKED)', over.code === 'SHIP_SCAN_EXCEEDS_PICKED')
ok('scan du second SKU valide', (await scan('sku', SJM, 'scan-p55-jm-1')).ok === true)
ok('scan lot assigné à la ligne : accepté', (await scan('lot', 'LOT-JS55', 'scan-p55-lot-1')).ok === true)
ok('scan lot non assigné à l’expédition refusé (SHIP_WRONG_LOT)', (await scan('lot', 'LOT-AUTRE', 'scan-p55-lot-2')).code === 'SHIP_WRONG_LOT')
ok('scan emplacement de l’entrepôt accepté', (await scan('location', locCode, 'scan-p55-loc-1')).ok === true)
ok('scan emplacement d’un autre entrepôt refusé (SHIP_WRONG_LOCATION)', (await scan('location', 'ZZ-99', 'scan-p55-loc-2')).code === 'SHIP_WRONG_LOCATION')
const reused = await as(mag, () => rpc('shipment_scan', S, 'lot', 'LOT-JS55', 'scan-p55-js-1'))
ok('même clé pour une autre nature de scan refusée (SCAN_KEY_REUSED)', reused.code === 'SCAN_KEY_REUSED')
const s2scan = await as(mag, () => rpc('shipment_scan', S2, 'sku', 'NOPE-000', 'scan-p55-s2-1'))
ok('scan sur une expédition non prélevée refusé (SHIP_BAD_STATUS)', s2scan.ok === false && s2scan.code === 'SHIP_BAD_STATUS')
ok('journal de scan : refus et succès enregistrés', (await count(`select count(*)::int n from shipment_scan_events where outcome='refused'`)) >= 5
  && (await count(`select count(*)::int n from shipment_scan_events where outcome='ok'`)) >= 6)

// --- B. Colisage : colis individualisés, contenu scanné, rapprochement BL -----------------------------------------------------------
ok('rapprochement avant colisage : non rapproché, aucun colis', (await as(mag, () => rpc('shipment_reconcile', S))).reconciled === false)
const P1 = await as(mag, () => rpc('shipment_package_open', S))
await rejects('colis : pièce d’une autre taille refusée (SHIP_WRONG_SIZE)', () => as(mag, () => rpc('shipment_package_add', P1, SJL, 1)), 'SHIP_WRONG_SIZE')
await rejects('colis : pièce d’un autre coloris refusée (SHIP_WRONG_COLOR)', () => as(mag, () => rpc('shipment_package_add', P1, SNS, 1)), 'SHIP_WRONG_COLOR')
await rejects('colis : plus que les pièces scannées refusé (SHIP_PACK_EXCEEDS_SCANNED)', () => as(mag, () => rpc('shipment_package_add', P1, SJS, 3)), 'SHIP_PACK_EXCEEDS_SCANNED')
await as(mag, () => rpc('shipment_package_add', P1, SJS, 2))
await rejects('colis : poids brut inférieur au net refusé (SHIP_BAD_WEIGHT)', () => as(mag, () => rpc('shipment_package_close', P1, 4.0, 5.0, 40, 30, 12)), 'SHIP_BAD_WEIGHT')
await rejects('colis : dimension nulle refusée (SHIP_BAD_DIMENSION)', () => as(mag, () => rpc('shipment_package_close', P1, 6.5, 5.0, 0, 30, 12)), 'SHIP_BAD_DIMENSION')
await as(mag, () => rpc('shipment_package_close', P1, 6.5, 5.0, 40, 30, 12))
ok('colis 1 fermé avec poids et dimensions', (await q(`select status, gross_kg::float g, label_code from shipment_packages where id=$1`, [P1]))[0].status === 'closed'
  && (await q(`select gross_kg::float g from shipment_packages where id=$1`, [P1]))[0].g === 6.5)
await rejects('colis fermé : ajout refusé (SHIP_PACKAGE_CLOSED)', () => as(mag, () => rpc('shipment_package_add', P1, SJS, 1)), 'SHIP_PACKAGE_CLOSED')

const P2 = await as(mag, () => rpc('shipment_package_open', S))
await rejects('colis vide non fermable (SHIP_PACKAGE_EMPTY)', () => as(mag, () => rpc('shipment_package_close', P2, 3.2, 2.5, 35, 25, 10)), 'SHIP_PACKAGE_EMPTY')
await rejects('colisage terminé refusé tant qu’un colis est ouvert (SHIP_PACKAGE_OPEN)', () => as(mag, () => rpc('shipment_packing_complete', S)), 'SHIP_PACKAGE_OPEN')
await as(mag, () => rpc('shipment_package_discard', P2))
ok('colis vide supprimé', (await count(`select count(*)::int n from shipment_packages where id=$1`, [P2])) === 0)
await rejects('colisage terminé refusé : pièce scannée non emballée (SHIP_NOT_RECONCILED)', () => as(mag, () => rpc('shipment_packing_complete', S)), 'SHIP_NOT_RECONCILED')

const P3 = await as(mag, () => rpc('shipment_package_open', S))
await as(mag, () => rpc('shipment_package_add', P3, SJM, 1))
await as(mag, () => rpc('shipment_package_close', P3, 3.2, 2.5, 35, 25, 10))
const rec = await as(mag, () => rpc('shipment_reconcile', S))
ok('rapprochement : chaque ligne a prélevé = scanné = emballé', rec.reconciled === true && rec.packages === 2 && rec.open_packages === 0, JSON.stringify(rec.lines))
const packed = await as(mag, () => rpc('shipment_packing_complete', S))
ok('colisage terminé : deux colis, poids cumulés, expédition emballée', packed.packages === 2 && Math.abs(packed.gross_kg - 9.7) < 0.001
  && (await q(`select status from shipments where id=$1`, [S]))[0].status === 'packed')
ok('étiquettes : code de colis unique, rattaché à l’expédition', (await q(`select label_code from shipment_packages where shipment_id=$1 order by package_no`, [S])).map((r) => r.label_code).join('|')
  === `PKG-${SNUM}-001|PKG-${SNUM}-002`)
await rejects('colisage hors colis individualisés refusé (SHIPPING_PACKAGES_EXIST)', () => as(mag, () => rpc('shipment_pack', S, 2, 9.7, 7.5)), 'SHIPPING_PACKAGES_EXIST')

// --- C. BL : émission à l'expédition, colis rapprochés du BL --------------------------------------------------------------------------
const BL = await as(mag, () => rpc('shipment_ship', S, 'DHL', 'TRK-P55-1'))
ok('BL émis à l’expédition', /^BL-\d{4}-\d{6}$/.test(BL))
const proof1 = await as(mag, () => rpc('shipment_export_proof', S))
ok('colis rapprochés du BL : chaque colis porte le numéro de BL de son expédition', proof1.packages.length === 2 && proof1.packages.every((p) => p.bl_number === BL))

// --- D. Documents export : liste de colisage versionnée, empreinte ----------------------------------------------------------------------
await rejects('type de document inconnu refusé (SHIP_DOCUMENT_KIND_INVALID)', () => as(mag, () => rpc('shipment_document_generate', S, 'invoice')), 'SHIP_DOCUMENT_KIND_INVALID')
await rejects('liste de colisage d’une expédition non emballée refusée (SHIP_BAD_STATUS)', () => as(mag, () => rpc('shipment_document_generate', S2, 'packing_list')), 'SHIP_BAD_STATUS')
const pl1 = await as(mag, () => rpc('shipment_document_generate', S, 'packing_list'))
const pl2 = await as(mag, () => rpc('shipment_document_generate', S, 'packing_list'))
ok('liste de colisage : numéro PL- versionné, empreinte SHA-256 de 64 caractères', pl1.number === `PL-${SNUM}-1` && /^[0-9a-f]{64}$/.test(pl1.sha256) && pl2.number === `PL-${SNUM}-2`)
ok('deuxième version au contenu identique : même empreinte (intégrité)', pl1.sha256 === pl2.sha256)
const plContent = (await q(`select content from shipment_documents where id=$1`, [pl1.id]))[0].content
ok('liste de colisage : contenu par colis (SKU et quantités) et totaux', plContent.packages.length === 2 && plContent.packages[0].lines[0].qty === 2 && plContent.totals.pieces === 3)
await rejects('liste de colisage modifiée refusée (SHIP_APPEND_ONLY)', () => db.query(`update shipment_documents set content='{}'::jsonb where id=$1`, [pl1.id]), 'SHIP_APPEND_ONLY')
const INV = await as(admin, () => rpc('shipment_export_invoice', S))
ok('facture export (EXP-) produite par le module existant', /^EXP-\d{4}-\d{6}$/.test(INV))

// --- E. Douane : acceptation seulement sur retour officiel -----------------------------------------------------------------------------
await rejects('déclaration douanière sans droit douane refusée (RBAC_FORBIDDEN)', () => as(mag, () => rpc('customs_declaration_open', S, 'Régime à confirmer')), 'RBAC_FORBIDDEN')
await rejects('déclaration sur expédition non emballée refusée (SHIP_BAD_STATUS)', () => as(comm, () => rpc('customs_declaration_open', S2, null)), 'SHIP_BAD_STATUS')
const DEC = await as(comm, () => rpc('customs_declaration_open', S, 'Régime à confirmer (OPEN-03)'))
await rejects('seconde déclaration pour la même expédition refusée (CUSTOMS_ALREADY_OPEN)', () => as(comm, () => rpc('customs_declaration_open', S, null)), 'CUSTOMS_ALREADY_OPEN')
await rejects('soumission sans référence refusée (CUSTOMS_REF_REQUIRED)', () => as(comm, () => rpc('customs_declaration_submit', DEC, 'ok')), 'CUSTOMS_REF_REQUIRED')
await as(comm, () => rpc('customs_declaration_submit', DEC, 'SUB-P55-0001'))
const proofSub = await as(mag, () => rpc('shipment_export_proof', S))
ok('preuve export après soumission : douane soumise, aucune acceptation', proofSub.customs.status === 'submitted' && proofSub.customs_accepted === false && proofSub.customs.official_return === false)
await rejects('réponse officielle inconnue refusée (CUSTOMS_OUTCOME_INVALID)', () => as(comm, () => rpc('customs_declaration_respond', DEC, 'approved', 'REP-1', d(0), null)), 'CUSTOMS_OUTCOME_INVALID')
await rejects('acceptation sans document de retour refusée (CUSTOMS_RESPONSE_DOCUMENT_REQUIRED)', () => as(comm, () => rpc('customs_declaration_respond', DEC, 'accepted', 'REP-P55-0001', d(0), null)), 'CUSTOMS_RESPONSE_DOCUMENT_REQUIRED')
// Document de retour officiel : GED de la société, dossier « certifications » du client
const DOC = (await q(`insert into ged_documents(company_id, client_id, folder_id, title, sha256) values ($1,$2,(select id from ged_folders where client_id=$2 and system_key='certifications'),'Retour douane P55',$3) returning id`,
  [company, client, 'e'.repeat(64)]))[0].id
await rejects('retour officiel daté du futur refusé (CUSTOMS_DATE_INVALID)', () => as(comm, () => rpc('customs_declaration_respond', DEC, 'accepted', 'REP-P55-0001', d(5), DOC)), 'CUSTOMS_DATE_INVALID')
await rejects('acceptation écrite directement sans retour refusée (contrainte de statut)', () => db.query(`update customs_declarations set status='accepted' where id=$1`, [DEC]), 'customs_declarations_check')
await as(comm, () => rpc('customs_declaration_respond', DEC, 'accepted', 'REP-P55-0001', d(0), DOC))
const proofOk = await as(mag, () => rpc('shipment_export_proof', S))
ok('acceptation douanière : seulement après retour officiel (référence, date, document)', proofOk.customs.status === 'accepted' && proofOk.customs_accepted === true && proofOk.customs.official_return === true)
await rejects('déclaration déjà répondue : nouvelle soumission refusée (SHIP_BAD_STATUS)', () => as(comm, () => rpc('customs_declaration_submit', DEC, 'SUB-P55-0002')), 'SHIP_BAD_STATUS')

// --- F. Droits, RLS, audit ------------------------------------------------------------------------------------------------------------------
ok('colis invisibles sans droit d’expédition (RLS)', (await as(nobody, () => count(`select count(*)::int n from shipment_packages`))) === 0)
await rejects('colis inséré directement refusé (permission denied)', () => as(admin, () => db.query(`insert into shipment_packages(company_id, shipment_id, package_no, label_code) values ($1,$2,9,'PKG-DIRECT')`, [company, S])), 'permission denied')
await rejects('journal de scan modifié refusé (SHIP_APPEND_ONLY)', () => db.query(`update shipment_scan_events set outcome='ok'`), 'SHIP_APPEND_ONLY')
ok('audit : colis fermés (2), colisage terminé (1), documents (2), réponse douanière (1)', (await count(`select count(*)::int n from audit_logs where action='shipping.package_close'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='shipping.packing_complete'`)) === 1
  && (await count(`select count(*)::int n from audit_logs where action='shipping.document'`)) === 2
  && (await count(`select count(*)::int n from audit_logs where action='customs.response'`)) === 1)
