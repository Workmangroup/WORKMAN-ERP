// POS hors ligne et reprise : politique signée, appareil, synchronisation idempotente, conflits explicites,
// rien créé en conflit, panne et retransmission, conflit de prix, session close, journal immuable — P078 / migration 0094
// Fixtures de test uniquement (boutique, variantes, prix fictifs).
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const uuid = () => crypto.randomUUID()

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@p078.com', 'admin')
const mag = await mkUser('mag@p078.com', 'magasin')
const fin = await mkUser('fin@p078.com', 'finance')
const nobody = await mkUser('nobody@p078.com', null)

for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) {
  await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
}
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
const WH = (await q(`insert into warehouses(company_id, code, name, kind) values ($1,'WH-P78','Boutique P78','shop') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role, active) values ($1,$2,$3,'operator',true)`, [company, mag, WH])
const client = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P78','Client P78','FR') returning id`, [company]))[0].id
const prod = (await q(`insert into product_master(client_id, name, family) values ($1,'Veste P78','jacket') returning id`, [client]))[0].id
const colors = (await q(`select id from colors order by code limit 2`)).map((r) => r.id)
const sizes = (await q(`select id from sizes order by sort_order limit 2`)).map((r) => r.id)
const V1 = (await q(`insert into product_variants(company_id, product_id, color_id, size_id, sku, price, currency) values ($1,$2,$3,$4,'SKU-P78-1',100,'EUR') returning id`, [company, prod, colors[0], sizes[0]]))[0].id
const V2 = (await q(`insert into product_variants(company_id, product_id, color_id, size_id, sku, price, currency) values ($1,$2,$3,$4,'SKU-P78-2',50,'EUR') returning id`, [company, prod, colors[1], sizes[1]]))[0].id
await as(admin, () => rpc('variant_stock_move', V1, 'receipt', WH, 10, null, 'Stock initial test', null))
await as(admin, () => rpc('variant_stock_move', V2, 'receipt', WH, 5, null, 'Stock initial test', null))
const R1 = await as(admin, () => rpc('pos_register_create', WH, 'CAI-P78-1', 'Caisse P78 1'))
const R2 = await as(admin, () => rpc('pos_register_create', WH, 'CAI-P78-2', 'Caisse P78 2'))
const CASH = await as(admin, () => rpc('pos_payment_method_create', 'ESP', 'Espèces', 'cash', true))
const D1 = uuid(), D2 = uuid()     // identifiants locaux des appareils (générés côté caisse)

// ---------------------------------------------------------------------------
// 1. Politique : refus tant qu'elle n'est pas signée ; signature par une autre personne
// ---------------------------------------------------------------------------
await as(mag, () => rpc('pos_device_register', D1, R1, 'Tablette 1'))
await rejects('hors ligne : pas de cache sans politique signée', () => as(mag, () => rpc('pos_offline_cache', R1)), 'POS_NO_OFFLINE_POLICY')
await rejects('hors ligne : pas de synchronisation sans politique signée', () => as(mag, () => rpc('pos_sync_sale', D1, uuid(), null, new Date().toISOString(), '[]', '[]')), 'POS_NO_OFFLINE_POLICY')
const P1 = await as(admin, () => rpc('pos_offline_policy_create', 'OFF_P78_A', '2000-01-01', 180, 500))
await rejects('politique : signature par son auteur refusée', () => as(admin, () => rpc('pos_offline_policy_validate', P1, true)), 'SOD_SELF_APPROVAL')
await as(fin, () => rpc('pos_offline_policy_validate', P1, true))
await rejects('politique : version signée figée', () => db.query(`update pos_offline_policies set max_offline_minutes = 9999 where id = $1`, [P1]), 'COLLECTION_LOCKED')
await rejects('appareil : inconnu de la synchronisation refusé', () => as(mag, () => rpc('pos_sync_sale', D2, uuid(), null, new Date().toISOString(), '[]', '[]')), 'POS_DEVICE_UNKNOWN')
await rejects('appareil : même identifiant sur une autre caisse refusé', () => as(mag, () => rpc('pos_device_register', D1, R2, 'Tablette 1')), 'POS_DEVICE_OTHER_REGISTER')

// ---------------------------------------------------------------------------
// 2. Cache de caisse : contenu daté, plafond et durée, digest
// ---------------------------------------------------------------------------
const cache = await as(mag, () => rpc('pos_offline_cache', R1))
const pay = cache.payload
const validMin = (new Date(pay.valid_until) - Date.now()) / 60000
ok('cache : durée = politique (180 min) et plafond de la politique', validMin > 175 && validMin <= 180 && Number(pay.max_offline_amount) === 500, JSON.stringify({ validMin, max: pay.max_offline_amount }))
ok('cache : prix HT des variantes, modes et TVA validée, aucune opération sensible', pay.variants.some((v) => v.sku === 'SKU-P78-1' && Number(v.price_ht) === 100) && pay.payment_methods.length >= 1 && pay.vat_codes.some((v) => v.code === 'TN_STD_19') && pay.sensitive_ops_offline.length === 0)
ok('cache : digest présent (intégrité vérifiée côté caisse et par la signature de l\'API)', typeof cache.digest === 'string' && cache.digest.length === 32)

// ---------------------------------------------------------------------------
// 3. Session et ventes hors ligne : application, rejeu, réutilisation d'identifiant
// ---------------------------------------------------------------------------
const S1 = await as(mag, () => rpc('pos_session_open', R1, 100))
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString()
const sale = (variant, qty, price, vat, amount) => ({ lines: JSON.stringify([{ variant, qty, unit_price_ht: price, vat_code: vat }]), payments: JSON.stringify([{ method: CASH, amount }]) })
const A1 = uuid()
const s1 = sale(V1, 1, 100, 'TN_STD_19', 119)
const T1 = minutesAgo(5)   // une retransmission renvoie exactement le même contenu
const r1 = await as(mag, () => rpc('pos_sync_sale', D1, A1, S1, T1, s1.lines, s1.payments))
ok('synchro : vente hors ligne appliquée (ticket créé, stock sorti)', r1.status === 'applied' && r1.ticket_id && r1.replayed === false, JSON.stringify(r1))
const r1b = await as(mag, () => rpc('pos_sync_sale', D1, A1, S1, T1, s1.lines, s1.payments))
ok('retransmission (panne après envoi) : même réponse, aucun second ticket ni sortie', r1b.replayed === true && r1b.ticket_id === r1.ticket_id)
await rejects('identifiant réutilisé avec un autre contenu refusé', () => as(mag, () => rpc('pos_sync_sale', D1, A1, S1, minutesAgo(5), sale(V1, 2, 100, 'TN_STD_19', 238).lines, sale(V1, 2, 100, 'TN_STD_19', 238).payments)), 'POS_OP_ID_REUSED')
ok('journal : un seul ticket et une seule sortie après rejeu', (await q(`select count(*)::int n from pos_tickets where kind='sale'`))[0].n === 1 && (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V1, WH]))[0].qty_on_hand === 9)

// ---------------------------------------------------------------------------
// 4. Conflits explicites : prix, stock, durée, plafond — rien n'est créé
// ---------------------------------------------------------------------------
const A2 = uuid(); const s2 = sale(V1, 1, 90, 'TN_STD_19', 107.1)
const c2 = await as(mag, () => rpc('pos_sync_sale', D1, A2, S1, minutesAgo(5), s2.lines, s2.payments))
ok('conflit de prix : refusé explicitement, prix hors ligne et prix actuel donnés', c2.status === 'conflict' && c2.conflict_code === 'POS_PRICE_CONFLICT' && c2.ticket_id === null, JSON.stringify(c2))
const d2 = (await q(`select conflict_detail from pos_sync_ops where client_op_id=$1`, [A2]))[0].conflict_detail
ok('conflit de prix : détail par ligne (90 contre 100)', d2 && d2[0].offline_price === '90' && Number(d2[0].current_price) === 100, JSON.stringify(d2))
const A3 = uuid(); const s3 = sale(V2, 6, 50, 'TN_RED_7', 321)
const c3 = await as(mag, () => rpc('pos_sync_sale', D1, A3, S1, minutesAgo(5), s3.lines, s3.payments))
ok('conflit de stock : refusé, aucune sortie partielle (V2 reste à 5)', c3.conflict_code === 'VARIANT_STOCK_INSUFFICIENT' && (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V2, WH]))[0].qty_on_hand === 5)
const A4 = uuid(); const s4 = sale(V1, 1, 100, 'TN_STD_19', 119)
const c4 = await as(mag, () => rpc('pos_sync_sale', D1, A4, S1, minutesAgo(200), s4.lines, s4.payments))
ok('durée dépassée (200 min > 180) : conflit explicite', c4.conflict_code === 'POS_OFFLINE_EXPIRED' && c4.ticket_id === null)
const A5 = uuid(); const s5 = sale(V1, 5, 100, 'TN_STD_19', 595)
const c5 = await as(mag, () => rpc('pos_sync_sale', D1, A5, S1, minutesAgo(5), s5.lines, s5.payments))
ok('plafond dépassé (595 > 500) : conflit explicite', c5.conflict_code === 'POS_OFFLINE_CEILING' && c5.ticket_id === null)
ok('après conflits : un seul ticket de vente, stock inchangé', (await q(`select count(*)::int n from pos_tickets where kind='sale'`))[0].n === 1 && (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V1, WH]))[0].qty_on_hand === 9)

// ---------------------------------------------------------------------------
// 5. Panne et reprise : vente après coupure, rejeu ; session close entre-temps
// ---------------------------------------------------------------------------
const A6 = uuid(); const s6 = sale(V1, 1, 100, 'TN_STD_19', 119)
const T6 = minutesAgo(30)
const r6 = await as(mag, () => rpc('pos_sync_sale', D1, A6, S1, T6, s6.lines, s6.payments))
const r6b = await as(mag, () => rpc('pos_sync_sale', D1, A6, S1, T6, s6.lines, s6.payments))
ok('panne puis reprise : vente de 30 min appliquée une seule fois', r6.status === 'applied' && r6b.replayed === true && r6b.ticket_id === r6.ticket_id)
await as(mag, () => rpc('pos_session_close', S1, JSON.stringify([{ method: CASH, counted: 338 }])))
const A7 = uuid(); const s7 = sale(V1, 1, 100, 'TN_STD_19', 119)
const c7 = await as(mag, () => rpc('pos_sync_sale', D1, A7, S1, minutesAgo(10), s7.lines, s7.payments))
ok('session close pendant la panne : conflit explicite, rien créé', c7.conflict_code === 'POS_SESSION_CLOSED' && c7.ticket_id === null)

// ---------------------------------------------------------------------------
// 6. Résolution d'un conflit par un superviseur ; journal immuable
// ---------------------------------------------------------------------------
const opA2 = (await q(`select id from pos_sync_ops where client_op_id=$1`, [A2]))[0].id
await rejects('conflit : abandon sans motif refusé', () => as(fin, () => rpc('pos_sync_conflict_discard', opA2, 'ok')), 'POS_REASON_REQUIRED')
await as(fin, () => rpc('pos_sync_conflict_discard', opA2, 'Prix corrigé : nouvelle vente saisie à la caisse'))
ok('conflit : abandonné par un superviseur (statut et motif enregistrés)', (await q(`select status, resolution_note from pos_sync_ops where id=$1`, [opA2]))[0].status === 'discarded')
await rejects('conflit : second abandon refusé', () => as(fin, () => rpc('pos_sync_conflict_discard', opA2, 'Encore un abandon')), 'POS_BAD_STATUS')
const opApplied = (await q(`select id from pos_sync_ops where client_op_id=$1`, [A1]))[0].id
await rejects('journal : une vente appliquée ne peut pas être abandonnée', () => as(fin, () => rpc('pos_sync_conflict_discard', opApplied, 'Tentative sur vente valide')), 'POS_BAD_STATUS')
await rejects('journal : modification d\'une opération refusée', () => db.query(`update pos_sync_ops set sold_at = now() where id = $1`, [opApplied]), 'POS_APPEND_ONLY')
await rejects('journal : suppression refusée', () => db.query(`delete from pos_sync_ops where id = $1`, [opApplied]), 'POS_APPEND_ONLY')

// ---------------------------------------------------------------------------
// 7. Bilan : aucune double écriture, traçabilité
// ---------------------------------------------------------------------------
ok('bilan : deux tickets de vente (A1 et A6), aucun en conflit', (await q(`select count(*)::int n from pos_tickets where kind='sale'`))[0].n === 2)
ok('bilan : stock V1 = 10 − 2 ventes, V2 = 5', (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V1, WH]))[0].qty_on_hand === 8 && (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V2, WH]))[0].qty_on_hand === 5)
ok('bilan : paiements espèces = 2 × 119 (aucun paiement en conflit)', Number((await q(`select coalesce(sum(amount),0) s from pos_ticket_payments where direction='in'`))[0].s) === 238)
const ops = await q(`select status, count(*)::int n from pos_sync_ops group by status`)
ok('bilan : journal = 2 appliquées, 4 conflits ouverts et 1 abandonné (les rejeux ne créent aucune ligne)', ops.find((o) => o.status === 'applied')?.n === 2 && ops.find((o) => o.status === 'conflict')?.n === 4 && ops.find((o) => o.status === 'discarded')?.n === 1, JSON.stringify(ops))
ok('audit : synchronisations et conflits journalisés', (await q(`select count(*)::int n from audit_logs where action like 'pos.sync%'`))[0].n >= 6)
await rejects('synchro : sans droit de caisse refusée', () => as(nobody, () => rpc('pos_sync_sale', D1, uuid(), null, new Date().toISOString(), '[]', '[]')), 'RBAC_FORBIDDEN')
