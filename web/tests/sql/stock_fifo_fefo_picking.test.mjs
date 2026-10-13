// Règle de sortie FIFO/FEFO, proposition de lots, préparation avec scan et substitution soumise à accord — P039 / migration 0064
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const plus = async (n) => (await q(`select (current_date + $1::int)::text d`, [n]))[0].d

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const admin2 = await mkUser('admin2@x.com', 'admin')
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const w1 = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock W1 P39','mixed') returning id`, [company]))[0].id
const w2 = (await q(`insert into warehouses(company_id, name, kind) values ($1,'Stock W2 P39','mixed') returning id`, [company]))[0].id
await db.query(`insert into user_warehouses(company_id, user_id, warehouse_id, role) values ($1,$2,$3,'operator')`, [company, mag, w1])
const gen = (await q(`select id from stock_locations where warehouse_id=$1 and code='GEN'`, [w1]))[0].id
const qua = (await q(`insert into stock_locations(company_id, warehouse_id, code, name, kind) values ($1,$2,'QUA','Quarantaine P39','quarantine') returning id`, [company, w1]))[0].id
const mat = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Fil P39','fabric','m') returning id`, [company]))[0].id

const recv = (u, qty, code, expiry, loc = gen, wh = w1) =>
  as(u, () => rpc('stock_receive_lot', mat, wh, loc, qty, code, expiry, 'BL-' + code, 'Réception P39', null))
const lotId = async (code) => (await q(`select id from stock_lots where material_id=$1 and lot_code=$2 order by received_at limit 1`, [mat, code]))[0].id
const lotRemaining = async (code) => Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1 and lot_code=$2`, [mat, code]))[0].n)
const setExpiry = (code, d) => db.query(`update stock_lots set expiry_date = $2 where material_id = $1 and lot_code = $3`, [mat, d, code])
const proposal = (u, qty, wh = w1) => as(u, () => rpc('stock_pick_proposal', mat, wh, qty))
const lineOf = async (pick, seq) => (await q(`select id, lot_code, qty, scanned, substitution_status, lot_id from stock_pick_lines where pick_id=$1 and seq=$2`, [pick, seq]))[0]
const setRule = (rule) => as(admin, () => rpc('stock_exit_policy_set', rule))

// Entrées : L-OLD (reçu en premier, échéance lointaine), L-FEFO (reçu ensuite, échéance proche), L-EXP (échu plus tard), L-QUA (quarantaine)
await recv(mag, 50, 'L-OLD', await plus(90))
await recv(mag, 40, 'L-FEFO', await plus(10))
await recv(mag, 30, 'L-EXP', await plus(5))
await recv(mag, 25, 'L-QUA', await plus(200), qua)

// 1. Lot à réception : date passée, code vide, même code avec autre échéance refusés
const datePast = await plus(-1), dateOld30 = await plus(30)
await rejects('lot échu à la réception refusé', () => recv(mag, 5, 'L-PAST', datePast), 'LOT_EXPIRED_AT_RECEIPT')
await rejects('lot sans code refusé', () => as(mag, () => rpc('stock_receive_lot', mat, w1, gen, 5, ' ', null, 'BL-X', 'Réception', null)), 'LOT_CODE_REQUIRED')
await rejects('même code de lot avec autre échéance refusé', () => recv(mag, 5, 'L-OLD', dateOld30), 'LOT_EXPIRY_MISMATCH')
ok('réception : 50 + 40 + 30 + 25 = 145 au stock', Number((await q(`select coalesce(sum(qty_remaining),0) n from stock_lots where material_id=$1`, [mat]))[0].n) === 145)

// L-EXP devient échu (le temps passe) : simulé par une mise à jour directe de l'échéance en test
await setExpiry('L-EXP', await plus(-1))

// 2. Proposition FIFO (règle par défaut) : lots les plus anciens ; échu et quarantaine exclus avec motif
const pf = await proposal(mag, 60)
ok('FIFO par défaut : règle « fifo », proposition 60 = L-OLD 50 puis L-FEFO 10', pf.rule === 'fifo' && pf.proposed === 60 && pf.lines.length === 2
  && pf.lines[0].lot_code === 'L-OLD' && Number(pf.lines[0].qty) === 50 && pf.lines[1].lot_code === 'L-FEFO' && Number(pf.lines[1].qty) === 10)
ok('exclus : L-EXP échu (EXPIRED) et L-QUA en quarantaine (BLOCKED)', pf.excluded.some((e) => e.lot_code === 'L-EXP' && e.reason === 'EXPIRED')
  && pf.excluded.some((e) => e.lot_code === 'L-QUA' && e.reason === 'BLOCKED') && !pf.lines.some((l) => ['L-EXP', 'L-QUA'].includes(l.lot_code)))
const fv = await proposal(mag, 200)
ok('disponible éligible 90 : demande 200 signale un manque de 110', Number(fv.available) === 90 && Number(fv.short) === 110)
await rejects('préparation au-delà du disponible refusée (PICK_SHORT)', () => as(mag, () => rpc('stock_pick_create', mat, w1, 200, null)), 'PICK_SHORT')

// 3. Règle FEFO : échéance la plus proche d'abord ; la valorisation (coût du lot) n'est pas modifiée
await setRule('fefo')
const pe = await proposal(mag, 60)
ok('FEFO : règle « fefo » ; proposition 60 = L-FEFO 40 (échéance proche) puis L-OLD 20', pe.rule === 'fefo' && pe.valuation_method === 'lot_cost'
  && pe.lines[0].lot_code === 'L-FEFO' && Number(pe.lines[0].qty) === 40 && pe.lines[1].lot_code === 'L-OLD' && Number(pe.lines[1].qty) === 20)
await rejects('règle de sortie inconnue refusée', () => as(admin, () => rpc('stock_exit_policy_set', 'lifo')), 'STOCK_EXIT_RULE_INVALID')
await rejects('changement de règle refusé sans droit stock.adjust', () => as(mag, () => rpc('stock_exit_policy_set', 'fifo')), 'RBAC_FORBIDDEN')
ok('politique lisible : règle fefo, valorisation lot_cost', (await as(mag, () => rpc('stock_exit_policy_get')))?.exit_rule === 'fefo')

// 4. Préparation 45 en FEFO : L-FEFO 40 puis L-OLD 5
const pick1 = await as(mag, () => rpc('stock_pick_create', mat, w1, 45, 'Commande test P39'))
const pick1no = (await q(`select number, status, exit_rule from stock_pick_lists where id=$1`, [pick1]))[0]
ok('liste de prélèvement créée : numéro PRL, ouverte, règle fefo', /^PRL-\d{4}-\d{6}$/.test(pick1no.number) && pick1no.status === 'open' && pick1no.exit_rule === 'fefo')
const l1 = await lineOf(pick1, 1), l2 = await lineOf(pick1, 2)
ok('lignes : L-FEFO 40 puis L-OLD 5, scan en attente', l1.lot_code === 'L-FEFO' && Number(l1.qty) === 40 && l2.lot_code === 'L-OLD' && Number(l2.qty) === 5 && !l1.scanned && !l2.scanned)

// 5. Confirmation impossible sans scan
await rejects('confirmation refusée tant que tous les lots ne sont pas scannés', () => as(mag, () => rpc('stock_pick_confirm', pick1)), 'PICK_NOT_SCANNED')

// 6. Scan erroné détecté et enregistré (sans annuler la transaction)
const bad = await as(mag, () => rpc('stock_pick_scan', l1.id, 'L-OLD'))
ok('scan erroné : refusé (ok=false, PICK_SCAN_MISMATCH) avec lot attendu L-FEFO', bad.ok === false && bad.error === 'PICK_SCAN_MISMATCH' && bad.expected === 'L-FEFO')
ok('scan erroné : enregistré (compteur 1, audit)', Number((await q(`select scan_errors from stock_pick_lines where id=$1`, [l1.id]))[0].scan_errors) === 1
  && Number((await q(`select count(*)::int n from audit_logs where action='stock.pick_scan_error'`))[0].n) === 1)
const good1 = await as(mag, () => rpc('stock_pick_scan', l1.id, 'L-FEFO'))
ok('scan juste : ok=true et ligne marquée scannée', good1.ok === true && (await lineOf(pick1, 1)).scanned === true)

// 7. Lot échu et lot bloqué refusés pour une substitution
const idExp = await lotId('L-EXP'), idQua = await lotId('L-QUA'), idOld = await lotId('L-OLD')
await rejects('substitution vers lot échu refusée (LOT_EXPIRED)', () => as(mag, () => rpc('stock_pick_request_substitution', l2.id, idExp, 'Lot échu test')), 'LOT_EXPIRED')
await rejects('substitution vers lot en quarantaine refusée (LOT_BLOCKED)', () => as(mag, () => rpc('stock_pick_request_substitution', l2.id, idQua, 'Lot bloqué test')), 'LOT_BLOCKED')
await rejects('substitution avec motif trop court refusée', () => as(mag, () => rpc('stock_pick_request_substitution', l2.id, idExp, 'ab')), 'PICK_REASON_REQUIRED')

// 8. Substitution soumise à accord : lot de remplacement, demande par admin, décision par un autre utilisateur
await recv(mag, 100, 'L-ALT', await plus(60))
const idAlt = await lotId('L-ALT')
await as(admin, () => rpc('stock_pick_request_substitution', l2.id, idAlt, 'Lot L-OLD à contrôler au magasin'))
ok('substitution demandée : ligne « en attente », lot de remplacement enregistré', (await lineOf(pick1, 2)).substitution_status === 'pending')
await rejects('scan refusé pendant une substitution en attente', () => as(mag, () => rpc('stock_pick_scan', l2.id, 'L-OLD')), 'PICK_SUBSTITUTION_PENDING')
await rejects('confirmation refusée pendant une substitution en attente', () => as(mag, () => rpc('stock_pick_confirm', pick1)), 'PICK_SUBSTITUTION_PENDING')
await rejects('auto-approbation refusée (SOD_SELF_APPROVAL)', () => as(admin, () => rpc('stock_pick_decide_substitution', l2.id, true)), 'SOD_SELF_APPROVAL')
await rejects('décision refusée sans droit stock.adjust', () => as(mag, () => rpc('stock_pick_decide_substitution', l2.id, true)), 'RBAC_FORBIDDEN')
await as(admin2, () => rpc('stock_pick_decide_substitution', l2.id, true))
const l2after = await lineOf(pick1, 2)
ok('accord donné par un autre utilisateur : le lot à sortir devient L-ALT, nouveau scan requis', l2after.substitution_status === 'approved' && l2after.lot_code === 'L-ALT' && l2after.scanned === false)
const badAlt = await as(mag, () => rpc('stock_pick_scan', l2.id, 'L-OLD'))
ok('scan de l’ancien lot après substitution : erroné détecté', badAlt.ok === false && badAlt.expected === 'L-ALT')
await as(mag, () => rpc('stock_pick_scan', l2.id, 'L-ALT'))

// 9. Confirmation : sort exactement les lots scannés
const conf = await as(mag, () => rpc('stock_pick_confirm', pick1))
ok('confirmation : 2 lignes, 45 pièces sorties', conf.lines === 2 && Number(conf.qty) === 45)
ok('bon lot sorti : L-FEFO 40 entièrement consommé, L-ALT 100 − 5 = 95, L-OLD intact à 50', (await lotRemaining('L-FEFO')) === 0
  && (await lotRemaining('L-ALT')) === 95 && (await lotRemaining('L-OLD')) === 50)
const movs = await q(`select sm.reference, sm.direction, sm.qty from stock_movements sm where sm.reference = $1 order by sm.qty desc`, [pick1no.number])
ok('mouvements : 2 sorties liées à la liste, classées « sortie » au journal', movs.length === 2 && movs.every((m) => m.direction === 'out')
  && (await as(admin, () => q(`select class from stock_journal_list($1, $2) where reference = $3 limit 1`, [w1, mat, pick1no.number])))[0].class === 'sortie')
ok('coût du mouvement tracé (valorisation par coût du lot)', Number((await q(`select count(*)::int n from stock_movement_costs mc join stock_movements sm on sm.id = mc.movement_id where sm.reference=$1`, [pick1no.number]))[0].n) === 2)
await rejects('seconde confirmation refusée (PICK_BAD_STATUS)', () => as(mag, () => rpc('stock_pick_confirm', pick1)), 'PICK_BAD_STATUS')

// 10. Lot échu entre la proposition et la confirmation : refusé, rien n'est sorti
const pick2 = await as(mag, () => rpc('stock_pick_create', mat, w1, 10, null))
const p2l = await lineOf(pick2, 1)
ok('liste 2 : lot à sortir L-ALT (échéance la plus proche en FEFO)', p2l.lot_code === 'L-ALT')
await as(mag, () => rpc('stock_pick_scan', p2l.id, 'L-ALT'))
await setExpiry('L-ALT', await plus(-1))
await rejects('confirmation refusée : lot échu depuis la préparation (LOT_EXPIRED)', () => as(mag, () => rpc('stock_pick_confirm', pick2)), 'LOT_EXPIRED')
ok('lot échu refusé : aucune sortie, quantité inchangée (95)', (await lotRemaining('L-ALT')) === 95)
await setExpiry('L-ALT', await plus(60))

// 11. Annulation d'une liste ouverte
await as(mag, () => rpc('stock_pick_cancel', pick2))
await rejects('liste annulée non confirmable (PICK_BAD_STATUS)', () => as(mag, () => rpc('stock_pick_confirm', pick2)), 'PICK_BAD_STATUS')
ok('liste annulée : stock inchangé', (await lotRemaining('L-ALT')) === 95)

// 12. Scope et droits
await rejects('préparation hors entrepôt affecté refusée (WAREHOUSE_FORBIDDEN)', () => as(mag, () => rpc('stock_pick_create', mat, w2, 1, null)), 'WAREHOUSE_FORBIDDEN')
await rejects('proposition hors entrepôt affecté refusée', () => proposal(mag, 1, w2), 'WAREHOUSE_FORBIDDEN')
await rejects('proposition sans droit de lecture refusée', () => proposal(nobody, 1), 'RBAC_FORBIDDEN')

// 13. Journal et rapprochement : les sorties de préparation restent réconciliées
const rec = await as(admin, () => q(`select * from stock_journal_reconcile($1)`, [mat]))
ok('journal réconcilié après préparation : écart nul sur tous les entrepôts', rec.length >= 1 && rec.every((x) => Math.abs(Number(x.difference)) < 0.0051))

// 14. Audit
const aud = async (a) => Number((await q(`select count(*)::int n from audit_logs where action = $1`, [a]))[0].n)
ok('audit : création, scan erroné, substitution demandée et décidée, confirmation et annulation tracés',
  (await aud('stock.pick_create')) >= 2 && (await aud('stock.pick_scan_error')) === 2 && (await aud('stock.pick_substitution_request')) === 1
  && (await aud('stock.pick_substitution_decide')) === 1 && (await aud('stock.pick_confirm')) === 1 && (await aud('stock.pick_cancel')) === 1)
