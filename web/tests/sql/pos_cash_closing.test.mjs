// Point de vente : caisses rattachées aux boutiques, sessions à fonds saisi, tickets sans montant saisi,
// annulation par contre-passation, clôture attendu / réel, écart visible, visa distinct, session close protégée,
// rapprochement du stock magasin — P077 / migration 0092
// Fixtures de test uniquement : boutique, variantes et prix sont fictifs (aucune donnée réelle).
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
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
const admin = await mkUser('admin@p077.com', 'admin')
const mag = await mkUser('mag@p077.com', 'magasin')      // vend, clôture
const mag2 = await mkUser('mag2@p077.com', 'magasin')    // second caissier
const fin = await mkUser('fin@p077.com', 'finance')      // visa seulement
const nobody = await mkUser('nobody@p077.com', null)

for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) {
  await as(fin, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
}
await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])

// Fixtures : boutique, entrepôt de stock, produit et deux variantes vendables, une variante sans prix
const WH_SHOP = (await q(`insert into warehouses(company_id, code, name, kind) values ($1,'WH-P77-SHOP','Boutique test','shop') returning id`, [company]))[0].id
const WH_STOCK = (await q(`insert into warehouses(company_id, code, name, kind) values ($1,'WH-P77-STK','Stock test','fabric') returning id`, [company]))[0].id
const client = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P77','Client P77','FR') returning id`, [company]))[0].id
const prod = (await q(`insert into product_master(client_id, name, family) values ($1,'Veste P77','jacket') returning id`, [client]))[0].id
const colors = (await q(`select id from colors order by code limit 2`)).map((r) => r.id)
const sizes = (await q(`select id from sizes order by sort_order limit 3`)).map((r) => r.id)
const V1 = (await q(`insert into product_variants(company_id, product_id, color_id, size_id, sku, price, currency) values ($1,$2,$3,$4,'SKU-P77-1',100,'EUR') returning id`, [company, prod, colors[0], sizes[0]]))[0].id
const V2 = (await q(`insert into product_variants(company_id, product_id, color_id, size_id, sku, price, currency) values ($1,$2,$3,$4,'SKU-P77-2',50,'EUR') returning id`, [company, prod, colors[1], sizes[1]]))[0].id
const V3 = (await q(`insert into product_variants(company_id, product_id, color_id, size_id, sku, price, currency) values ($1,$2,$3,$4,'SKU-P77-3',null,'EUR') returning id`, [company, prod, colors[0], sizes[2]]))[0].id
// Caissière : accès opérateur à la boutique (contrôle d'entrepôt 0017) ; le stock de la boutique n'est pas accessible sans lui
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role, active) values ($1,$2,$3,'operator',true)`, [company, mag, WH_SHOP])
// Stock initial en boutique (entrée par le module variantes)
await as(admin, () => rpc('variant_stock_move', V1, 'receipt', WH_SHOP, 10, null, 'Stock initial test', null))
await as(admin, () => rpc('variant_stock_move', V2, 'receipt', WH_SHOP, 5, null, 'Stock initial test', null))

// ---------------------------------------------------------------------------
// 1. Droits et paramétrage
// ---------------------------------------------------------------------------
await rejects('caisse : création sans droit refusée', () => as(nobody, () => rpc('pos_register_create', WH_SHOP, 'CAI-X', 'Caisse X')), 'RBAC_FORBIDDEN')
await rejects('caisse : création par magasin (pos.admin réservé) refusée', () => as(mag, () => rpc('pos_register_create', WH_SHOP, 'CAI-X', 'Caisse X')), 'RBAC_FORBIDDEN')
await rejects('caisse : entrepôt non boutique refusé', () => as(admin, () => rpc('pos_register_create', WH_STOCK, 'CAI-X', 'Caisse X')), 'POS_BAD_WAREHOUSE')
const R1 = await as(admin, () => rpc('pos_register_create', WH_SHOP, 'CAI-1', 'Caisse 1'))
const CASH = await as(admin, () => rpc('pos_payment_method_create', 'ESP', 'Espèces', 'cash', true))
const CB = await as(admin, () => rpc('pos_payment_method_create', 'CB', 'Carte bancaire', 'card', false))
ok('modes de paiement : espèces remboursables, carte non remboursable', (await q(`select refund_allowed from pos_payment_methods where id=$1`, [CASH]))[0].refund_allowed === true && (await q(`select refund_allowed from pos_payment_methods where id=$1`, [CB]))[0].refund_allowed === false)

// ---------------------------------------------------------------------------
// 2. Session S1 : ouverture avec fonds saisi
// ---------------------------------------------------------------------------
await rejects('session : ouverture sans fonds refusée', () => as(mag, () => rpc('pos_session_open', R1, null)), 'POS_FLOAT_REQUIRED')
const S1 = await as(mag, () => rpc('pos_session_open', R1, 200))
await rejects('session : seconde session ouverte sur la même caisse refusée', () => as(mag2, () => rpc('pos_session_open', R1, 100)), 'POS_SESSION_ALREADY_OPEN')

// ---------------------------------------------------------------------------
// 3. Tickets : montants lus sur la variante, paiements égaux, stock sorti
// ---------------------------------------------------------------------------
const lines = (...l) => JSON.stringify(l)
const pays = (...p) => JSON.stringify(p)
const T1 = await as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V1, qty: 2, vat_code: 'TN_STD_19' }), pays({ method: CASH, amount: 238 })))
const t1 = (await q(`select subtotal_ht, tax_total, total from pos_tickets where id=$1`, [T1]))[0]
ok('ticket : montants calculés sur la variante (HT 200, TVA 38, TTC 238)', Number(t1.subtotal_ht) === 200 && Number(t1.tax_total) === 38 && Number(t1.total) === 238, JSON.stringify(t1))
const T2 = await as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V2, qty: 1, vat_code: 'TN_RED_7' }), pays({ method: CB, amount: 53.5 })))
ok('ticket : second ticket en TVA réduite 7 %', Number((await q(`select total from pos_tickets where id=$1`, [T2]))[0].total) === 53.5)
ok('stock magasin : sorties ventes (V1 10 → 8, V2 5 → 4)', (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V1, WH_SHOP]))[0].qty_on_hand === 8 && (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V2, WH_SHOP]))[0].qty_on_hand === 4)
await rejects('ticket : paiement différent du total refusé', () => as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V1, qty: 1, vat_code: 'TN_STD_19' }), pays({ method: CASH, amount: 100 }))), 'POS_PAYMENT_MISMATCH')
await rejects('ticket : stock insuffisant refusé, rien n\'est sorti', () => as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V2, qty: 10, vat_code: 'TN_RED_7' }), pays({ method: CB, amount: 535 }))), 'VARIANT_STOCK_INSUFFICIENT')
ok('stock magasin : refus sans sortie partielle (V2 toujours 4)', (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V2, WH_SHOP]))[0].qty_on_hand === 4)
await rejects('ticket : variante sans prix refusée', () => as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V3, qty: 1, vat_code: 'TN_STD_19' }), pays({ method: CASH, amount: 1 }))), 'POS_VARIANT_NOT_SALEABLE')
await rejects('ticket : code de TVA inconnu refusé', () => as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V1, qty: 1, vat_code: 'INCONNU' }), pays({ method: CASH, amount: 119 }))), 'POS_BAD_VAT')
await rejects('ticket : mode de paiement inconnu refusé', () => as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V1, qty: 1, vat_code: 'TN_STD_19' }), pays({ method: '00000000-0000-0000-0000-000000000000', amount: 119 }))), 'POS_BAD_METHOD')
await rejects('ticket : vente sans droit de caisse refusée', () => as(nobody, () => rpc('pos_ticket_create', S1, lines({ variant: V1, qty: 1, vat_code: 'TN_STD_19' }), pays({ method: CASH, amount: 119 }))), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------
// 4. Annulation par contre-passation : jamais de modification de l'original
// ---------------------------------------------------------------------------
await rejects('annulation : carte non remboursable refusée', () => as(mag, () => rpc('pos_ticket_reverse', T2, 'Client a changé d’avis')), 'POS_REFUND_NOT_ALLOWED')
await rejects('annulation : motif trop court refusé', () => as(mag, () => rpc('pos_ticket_reverse', T1, 'ok')), 'POS_REASON_REQUIRED')
const R_T1 = await as(mag, () => rpc('pos_ticket_reverse', T1, 'Erreur de saisie de caisse'))
ok('annulation : stock rendu (V1 8 → 10)', (await q(`select qty_on_hand from variant_stock where variant_id=$1 and warehouse_id=$2`, [V1, WH_SHOP]))[0].qty_on_hand === 10)
await rejects('annulation : seconde annulation du même ticket refusée', () => as(mag, () => rpc('pos_ticket_reverse', T1, 'Encore une annulation')), 'POS_ALREADY_REVERSED')
await rejects('ticket : modification de l\'original refusée', () => db.query(`update pos_tickets set total = 1 where id = $1`, [T1]), 'POS_APPEND_ONLY')
ok('annulation : l\'original reste intact (238)', Number((await q(`select total from pos_tickets where id=$1`, [T1]))[0].total) === 238)

// ---------------------------------------------------------------------------
// 5. Clôture S1 : attendu / réel par mode, écart visible
// ---------------------------------------------------------------------------
// Attendu espèces = 200 (fonds) + 238 − 238 (annulation) = 200 ; carte = 53,50 − 0 = 53,50
await rejects('clôture : mode de paiement non compté refusée', () => as(mag, () => rpc('pos_session_close', S1, lines({ method: CASH, counted: 199 }))), 'POS_COUNT_MISSING')
await rejects('clôture : mode inconnu de la session refusé', () => as(mag, () => rpc('pos_session_close', S1, lines({ method: CASH, counted: 199 }, { method: CB, counted: 53.5 }, { method: '00000000-0000-0000-0000-000000000000', counted: 1 }))), 'POS_COUNT_UNKNOWN_METHOD')
const C1 = await as(mag, () => rpc('pos_session_close', S1, lines({ method: CASH, counted: 199 }, { method: CB, counted: 53.5 })))
ok('clôture : écart espèces visible (−1,00) et visa exigé', Number(C1.variance_total) === -1 && C1.visa_required === true, JSON.stringify(C1))
const cnt = Object.fromEntries((await q(`select method_id, expected, counted, variance from pos_session_counts where session_id=$1`, [S1])).map((r) => [r.method_id, r]))
ok('clôture : attendu espèces 200 et carte 53,50 figés', Number(cnt[CASH].expected) === 200 && Number(cnt[CB].expected) === 53.5, JSON.stringify(cnt))
await rejects('clôture : session déjà close refusée', () => as(mag, () => rpc('pos_session_close', S1, lines({ method: CASH, counted: 200 }, { method: CB, counted: 53.5 }))), 'POS_SESSION_CLOSED')

// ---------------------------------------------------------------------------
// 6. Session close protégée
// ---------------------------------------------------------------------------
await rejects('session close : ajout de ticket refusé', () => as(mag, () => rpc('pos_ticket_create', S1, lines({ variant: V1, qty: 1, vat_code: 'TN_STD_19' }), pays({ method: CASH, amount: 119 }))), 'POS_SESSION_CLOSED')
await rejects('session close : insertion directe de ticket refusée', () => db.query(`insert into pos_tickets(company_id, session_id, code, kind, subtotal_ht, tax_total, total) values ($1,$2,'TKT-20990101-DEADBEEF','sale',1,0,1)`, [company, S1]), 'POS_SESSION_CLOSED')
await rejects('session close : fonds modifié refusé', () => db.query(`update pos_sessions set opening_float = 999 where id = $1`, [S1]), 'POS_SESSION_CLOSED')
await rejects('session close : écart modifié refusé', () => db.query(`update pos_sessions set variance_total = 0 where id = $1`, [S1]), 'POS_SESSION_CLOSED')
await rejects('session close : suppression refusée', () => db.query(`delete from pos_sessions where id = $1`, [S1]), 'POS_APPEND_ONLY')
await rejects('session close : comptage modifié refusé', () => db.query(`update pos_session_counts set counted = 0 where session_id = $1`, [S1]), 'POS_APPEND_ONLY')

// ---------------------------------------------------------------------------
// 7. Visa : distinct du clôturant, requis pour l'écart seulement
// ---------------------------------------------------------------------------
await rejects('visa : par la caissière sans droit de visa refusé', () => as(mag, () => rpc('pos_session_visa', S1, 'Écart de 1 euro expliqué')), 'RBAC_FORBIDDEN')
await rejects('visa : note trop courte refusée', () => as(fin, () => rpc('pos_session_visa', S1, 'ok')), 'POS_REASON_REQUIRED')
await as(fin, () => rpc('pos_session_visa', S1, 'Écart de 1 euro, monnaie rendue en erreur'))
ok('visa : enregistré par une personne distincte du clôturant', (await q(`select visa_by is not null v from pos_sessions where id=$1`, [S1]))[0].v === true)
await rejects('visa : second visa refusé', () => as(fin, () => rpc('pos_session_visa', S1, 'Encore un visa sur la même session')), 'POS_VISA_NOT_REQUIRED')

// S2 : session sans écart, S3 : session close par l'administrateur avec écart (visa par soi-même refusé)
const S2 = await as(mag, () => rpc('pos_session_open', R1, 100))
const C2 = await as(mag, () => rpc('pos_session_close', S2, lines({ method: CASH, counted: 100 })))
ok('clôture sans écart : visa non requis', C2.visa_required === false && Number(C2.variance_total) === 0)
await rejects('visa : session sans écart refusé', () => as(fin, () => rpc('pos_session_visa', S2, 'Visa inutile sur session juste')), 'POS_VISA_NOT_REQUIRED')
const S3 = await as(admin, () => rpc('pos_session_open', R1, 50))
await as(admin, () => rpc('pos_session_close', S3, lines({ method: CASH, counted: 40 })))
await rejects('visa : clôturant ne peut pas viser sa propre session', () => as(admin, () => rpc('pos_session_visa', S3, 'Je me vise moi-même')), 'SOD_SELF_APPROVAL')
await as(fin, () => rpc('pos_session_visa', S3, 'Écart de 10 euros, à justifier'))
ok('session S3 : écart −10 visé par un tiers', (await q(`select variance_total from pos_sessions where id=$1`, [S3]))[0].variance_total === '-10.00' || Number((await q(`select variance_total from pos_sessions where id=$1`, [S3]))[0].variance_total) === -10)

// ---------------------------------------------------------------------------
// 8. Dépôt d'espèces après clôture, dans la limite des espèces comptées
// ---------------------------------------------------------------------------
await rejects('dépôt : session inconnue refusée', () => as(mag, () => rpc('pos_deposit_record', '00000000-0000-0000-0000-000000000000', 10, 'DEP-000')), 'POS_NOT_FOUND')
await as(mag, () => rpc('pos_deposit_record', S1, 150, 'Dépôt bancaire 1'))
await rejects('dépôt : au-delà des espèces comptées refusé', () => as(mag, () => rpc('pos_deposit_record', S1, 100, 'Dépôt bancaire 2')), 'POS_DEPOSIT_EXCEEDS_CASH')

// ---------------------------------------------------------------------------
// 9. Rapprochement du stock magasin
// ---------------------------------------------------------------------------
const rec = await as(mag, () => q(`select * from pos_stock_reconcile($1)`, [WH_SHOP]))
const byV = Object.fromEntries(rec.map((r) => [r.sku, r]))
ok('stock magasin : V1 rapproché (stock 10, ventes nettes 0, mouvements POS 0, solde 10)', byV['SKU-P77-1'] && byV['SKU-P77-1'].ok === true && Number(byV['SKU-P77-1'].on_hand) === 10 && Number(byV['SKU-P77-1'].pos_net_sold) === 0, JSON.stringify(byV['SKU-P77-1']))
ok('stock magasin : V2 rapproché (stock 4, ventes nettes 1, mouvements POS 1)', byV['SKU-P77-2'] && byV['SKU-P77-2'].ok === true && Number(byV['SKU-P77-2'].on_hand) === 4 && Number(byV['SKU-P77-2'].pos_net_sold) === 1 && Number(byV['SKU-P77-2'].pos_moves) === 1, JSON.stringify(byV['SKU-P77-2']))
await as(admin, () => rpc('variant_stock_move', V2, 'adjustment', WH_SHOP, -1, null, 'Casse constatée', null))
const rec2 = await as(mag, () => q(`select * from pos_stock_reconcile($1)`, [WH_SHOP]))
ok('stock magasin : ajustement manuel hors ticket reste rapproché (aucun écart POS)', rec2.find((r) => r.sku === 'SKU-P77-2').ok === true)
await db.exec(`update variant_stock set qty_on_hand = qty_on_hand + 3 where variant_id = '${V1}' and warehouse_id = '${WH_SHOP}'`)
const rec3 = await as(mag, () => q(`select * from pos_stock_reconcile($1)`, [WH_SHOP]))
ok('stock magasin : écart de solde non enregistré par mouvement détecté', rec3.find((r) => r.sku === 'SKU-P77-1').ok === false)
await rejects('rapprochement : sans droit de lecture refusé', () => as(nobody, () => q(`select * from pos_stock_reconcile($1)`, [WH_SHOP])), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------
// 10. Journal
// ---------------------------------------------------------------------------
const au = (await q(`select count(*)::int n from audit_logs where action like 'pos.%'`))[0].n
ok('audit : ouvertures, tickets, annulations, clôtures, visas et dépôts journalisés', au >= 10, `(${au})`)
