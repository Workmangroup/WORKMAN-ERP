// Analytique, clés d'allocation versionnées, budgets historisés, engagé, marges rapprochées, écarts prix/volume/mix/coût sans double comptage — P065 / migration 0090
// Les coûts, prix, budgets et clés sont des fixtures de test (non des données réelles).
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const num = Number
const lines = (...l) => JSON.stringify(l)
const d = (s) => s

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p065.com', 'finance')     // saisit l'analytique, les budgets et les clés
const fin2 = await mkUser('fin2@p065.com', 'finance')   // signe clés et budgets (distinct de la saisie)
const admin = await mkUser('admin@p065.com', 'admin')   // lecture des marges (costs.read)
const nobody = await mkUser('nobody@p065.com', null)
const asSuper = async (uid, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid })}', false);`)
  try { return await fn() } finally { await db.exec(`select set_config('request.jwt.claims', '', false);`) }
}

await db.query(`insert into finance_settings(company_id, base_currency) values ($1,'EUR') on conflict (company_id) do nothing`, [company])
for (const r of await q(`select code, effective_from from vat_rates where status = 'a_valider'`)) {
  await as(fin2, () => db.query(`select public.vat_rate_validate($1, $2::date, true)`, [r.code, r.effective_from]))
}
const C1 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CL-P65-1','Client P65','FR') returning id`, [company]))[0].id
const S1 = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'SU-P65-1','Fournisseur P65','TN') returning id`, [company]))[0].id
const artA = (await q(`insert into articles(client_id, client_ref, name, family) values ($1,'ART-P65-A','Article A','jacket') returning id`, [C1]))[0].id
const artB = (await q(`insert into articles(client_id, client_ref, name, family) values ($1,'ART-P65-B','Article B','jacket') returning id`, [C1]))[0].id

// Coûts figés : nomenclature active par article (A : 60 par unité ; B : 160 par unité, au-dessus du budget de 150)
const freezeCost = async (art, code, cost) => {
  const bom = (await q(`insert into boms(company_id, code, name, kind, article_id) values ($1,$2,$2,'product',$3) returning id`, [company, code, art]))[0].id
  const ver = (await q(`select id from bom_versions where bom_id=$1 order by version_no desc limit 1`, [bom]))[0].id
  // Fixture de test : le coût figé s'écrit via le drapeau de la fonction de validation (bom.rpc), normalement réservé à bom_validate_version
  await db.exec(`select set_config('bom.rpc', 'on', false);`)
  await db.query(`insert into bom_version_costs(version_id, company_id, snap_total) values ($1,$2,$3)
    on conflict (version_id) do update set snap_total = excluded.snap_total`, [ver, company, cost])
  await db.exec(`select set_config('bom.rpc', 'off', false);`)
  await db.query(`update boms set active_version_id=$1 where id=$2`, [ver, bom])
}
await freezeCost(artA, 'BOM-P65-A', 60)
await freezeCost(artB, 'BOM-P65-B', 160)

// --- 1. Membres analytiques ----------------------------------------------------------------------------------------------------------------
await rejects('membre : saisie sans droit refusée', () => as(nobody, () => rpc('analytic_member_create', 'center', 'CTR-X', 'Centre X', 'cost', null)), 'RBAC_FORBIDDEN')
const CP = await as(fin, () => rpc('analytic_member_create', 'center', 'CTR-PROD', 'Production', 'cost', null))
const CS = await as(fin, () => rpc('analytic_member_create', 'center', 'CTR-SUP', 'Support', 'cost', null))
const PA = await as(fin, () => rpc('analytic_member_create', 'product', 'PRD-A', 'Produit A', null, artA))
const PB = await as(fin, () => rpc('analytic_member_create', 'product', 'PRD-B', 'Produit B', null, artB))
const CH = await as(fin, () => rpc('analytic_member_create', 'channel', 'CH-DIRECT', 'Vente directe', null, null))
await rejects('membre : centre sans genre refusé', () => as(fin, () => rpc('analytic_member_create', 'center', 'CTR-BAD', 'Mauvais', null, null)), 'check constraint')
ok('membres : centres, produits et canal créés', (await q(`select count(*)::int n from analytic_members`))[0].n === 5)

// --- 2. Expense réelle comptabilisée (achat fournisseur de 1 000 en janvier) ----------------------------------------------------------
await as(fin, () => rpc('supplier_invoice_record', S1, 'FS-P65-1', '2026-01-15', '2026-02-15', 1000, 'EUR', null))
const exLine = (await q(`select l.id from gl_entry_lines l join gl_accounts a on a.id=l.account_id where a.code='607' and l.debit > 0 order by l.id limit 1`))[0].id
const apLine = (await q(`select l.id from gl_entry_lines l join gl_accounts a on a.id=l.account_id where a.code='401' and l.credit > 0 order by l.id limit 1`))[0].id

// --- 3. Clés d'allocation versionnées : somme 100 exigée, signature distincte, version explicable -----------------------------------
const KEY = await as(fin, () => rpc('analytic_key_create', 'KEY_CTR', 'Frais support vers production'))
const KV1 = await as(fin, () => rpc('analytic_key_version_create', KEY, '2026-01-01', lines({ member: CP, pct: 60 }, { member: CS, pct: 30 })))
await rejects('clé : somme des pourcentages différente de 100 refusée', () => as(fin2, () => rpc('analytic_key_version_validate', KV1, true)), 'ANALYTIC_WEIGHTS_NOT_100')
await as(fin2, () => rpc('analytic_key_version_validate', KV1, false))
ok('clé : version non valide supprimée', (await q(`select count(*)::int n from analytic_allocation_key_versions where id=$1`, [KV1]))[0].n === 0)
const KV2 = await as(fin, () => rpc('analytic_key_version_create', KEY, '2026-01-01', lines({ member: CP, pct: 60 }, { member: CS, pct: 40 })))
await rejects('clé : signature par son auteur refusée', () => as(fin, () => rpc('analytic_key_version_validate', KV2, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('analytic_key_version_validate', KV2, true))
await rejects('clé signée : modification directe refusée', () => db.exec(`update analytic_allocation_key_weights set weight_pct = 1 where version_id='${KV2}'`), 'ANALYTIC_IMMUTABLE')

// --- 4. Allocation explicable, sommes exactes, pas de double comptage ------------------------------------------------------------------
const RUN = await as(fin, () => rpc('analytic_allocate_line', exLine, KEY))
const tags = await q(`select m.code, t.amount from analytic_line_tags t join analytic_members m on m.id=t.member_id where t.gl_line_id=$1 order by m.code`, [exLine])
ok('allocation : 600,00 sur CTR-PROD et 400,00 sur CTR-SUP (60 % / 40 %)', tags.find((x) => x.code === 'CTR-PROD') && num(tags.find((x) => x.code === 'CTR-PROD').amount) === 600 && num(tags.find((x) => x.code === 'CTR-SUP').amount) === 400)
ok('allocation : somme des rattachements = montant de la ligne (1 000)', sumOf(tags) === 1000)
const runRow = (await q(`select formula, amount from analytic_allocation_runs where id=$1`, [RUN]))[0]
ok('allocation explicable : clé, version et parts figurent dans la formule', runRow.formula.key === 'KEY_CTR' && runRow.formula.version === 1 && runRow.formula.shares.length === 2)
await rejects('allocation : même ligne deux fois refusée', () => as(fin, () => rpc('analytic_allocate_line', exLine, KEY)), 'ANALYTIC_ALREADY_ALLOCATED')
await rejects('allocation : ligne de bilan refusée', () => as(fin, () => rpc('analytic_allocate_line', apLine, KEY)), 'ANALYTIC_BAD_LINE')
await rejects('rattachement direct au-delà de la ligne refusé', () => as(fin, () => rpc('analytic_tag_line', exLine, CH, 1)), 'ANALYTIC_OVER_TAGGED')
await rejects('allocation : suppression d’un rattachement refusée', () => db.exec(`delete from analytic_line_tags where gl_line_id='${exLine}'`), 'ANALYTIC_IMMUTABLE')
function sumOf(rows) { return rows.reduce((s, r) => s + num(r.amount), 0) }

// --- 5. Engagé : distinct du réalisé, clôturé avec motif ----------------------------------------------------------------------------------
const CMT = await as(fin, () => rpc('analytic_commitment_add', CP, 300, 'PO-P65-1', '2026-01-20'))
await rejects('engagement : clôture sans motif refusée', () => as(fin, () => rpc('analytic_commitment_close', CMT, 'x')), 'ANALYTIC_REASON_REQUIRED')

// --- 6. Budgets initiaux historisés, révisés avec motif, prévision ------------------------------------------------------------------------
const BI = await as(fin, () => rpc('analytic_budget_version_create', 'initial', 2026, null))
await as(fin, () => rpc('analytic_budget_lines_set', BI, lines(
  { kind: 'product', member: PA, month: 1, qty: 10, unit_price: 100, unit_cost: 60 },
  { kind: 'product', member: PA, month: 2, qty: 10, unit_price: 100, unit_cost: 60 },
  { kind: 'product', member: PB, month: 1, qty: 5, unit_price: 200, unit_cost: 150 },
  { kind: 'center_expense', member: CP, month: 1, amount: 500 })))
await rejects('budget : ligne produit sur un centre refusée', () => as(fin, () => rpc('analytic_budget_lines_set', BI, lines({ kind: 'product', member: CP, month: 1, qty: 1, unit_price: 1, unit_cost: 1 }))), 'ANALYTIC_BAD_MEMBER')
await rejects('budget : validation par son auteur refusée', () => as(fin, () => rpc('analytic_budget_version_validate', BI, true)), 'SOD_SELF_APPROVAL')
await as(fin2, () => rpc('analytic_budget_version_validate', BI, true))
await rejects('budget initial : second initial de l’année refusé', () => as(fin, () => rpc('analytic_budget_version_create', 'initial', 2026, null)), 'ANALYTIC_BAD_STATUS')
await rejects('budget révisé sans motif refusé', () => as(fin, () => rpc('analytic_budget_version_create', 'revised', 2026, null)), 'ANALYTIC_REASON_REQUIRED')
await rejects('budget révisé sans initial validé (2027) refusé', () => as(fin, () => rpc('analytic_budget_version_create', 'revised', 2027, 'Révision sans budget initial')), 'ANALYTIC_NO_BUDGET')
const BR = await as(fin, () => rpc('analytic_budget_version_create', 'revised', 2026, 'Révision après commande client'))
await as(fin, () => rpc('analytic_budget_lines_set', BR, lines({ kind: 'center_expense', member: CP, month: 1, amount: 700 })))
await as(fin2, () => rpc('analytic_budget_version_validate', BR, true))
const BF = await as(fin, () => rpc('analytic_budget_version_create', 'forecast', 2026, null))
await as(fin, () => rpc('analytic_budget_lines_set', BF, lines({ kind: 'center_expense', member: CP, month: 1, amount: 650 })))
await as(fin2, () => rpc('analytic_budget_version_validate', BF, true))
await rejects('budget validé : ligne ajoutée directement refusée', () => db.exec(`insert into analytic_budget_lines(company_id, version_id, line_kind, member_id, month, amount) values ('${company}','${BI}','center_expense','${CS}',2,10)`), 'ANALYTIC_IMMUTABLE')
await rejects('budget validé : montant modifié directement refusé', () => db.exec(`update analytic_budget_lines set amount = 1 where version_id='${BI}' and line_kind='center_expense'`), 'ANALYTIC_IMMUTABLE')
await rejects('budget validé : suppression refusée', () => db.exec(`delete from analytic_budget_versions where id='${BI}'`), 'ANALYTIC_IMMUTABLE')

// --- 7. Position par centre : budget initial, révisé, prévision, réalisé et engagé distincts ----------------------------------------------
const pos = await as(fin, () => q(`select center_code, budget_initial, budget_revised, forecast, actual, committed_open from analytic_center_position(2026, 1) order by center_code`))
const pCP = pos.find((x) => x.center_code === 'CTR-PROD')
const pCS = pos.find((x) => x.center_code === 'CTR-SUP')
ok('position CTR-PROD : budget initial 500 conservé, révisé 700, prévision 650 (historique intact)', num(pCP.budget_initial) === 500 && num(pCP.budget_revised) === 700 && num(pCP.forecast) === 650)
ok('position CTR-PROD : réalisé 600 (rattachement), engagé 300 distinct', num(pCP.actual) === 600 && num(pCP.committed_open) === 300)
ok('position CTR-SUP : réalisé 400, aucun budget ni engagement', num(pCS.actual) === 400 && pCS.budget_initial === null && pCS.committed_open === null)
await as(fin, () => rpc('analytic_commitment_close', CMT, 'Commande facturée sur janvier'))
const pos2 = await as(fin, () => q(`select committed_open, actual from analytic_center_position(2026, 1) where center_code='CTR-PROD'`))
ok('engagement clôturé : plus d’engagement ouvert, réalisé inchangé (600)', pos2[0].committed_open === null && num(pos2[0].actual) === 600)
await rejects('engagement déjà clôturé refusé', () => as(fin, () => rpc('analytic_commitment_close', CMT, 'Deuxième clôture de test')), 'ANALYTIC_BAD_STATUS')

// --- 8. Ventes : deux articles, coûts figés, facturation avec écritures comptables -----------------------------------------------------
await db.exec('alter table invoices disable trigger user')
await db.exec('alter table invoice_lines disable trigger user')
const so = (await asSuper(fin, () => q(`insert into sales_orders(client_id) values ($1) returning id`, [C1])))[0].id
const solLine = (art) => asSuper(fin, async () => (await q(`insert into sales_order_lines(order_id, article_id, qty, due_date) values ($1,$2,30,'2026-03-01') returning id`, [so, art]))[0].id)
const solA1 = await solLine(artA)
const solA2 = await solLine(artA)
const solB = await solLine(artB)
const mkInvoice = async (code, date, lns) => {
  const subtotal = lns.reduce((s, l) => s + l.qty * l.price, 0)
  const id = (await q(`insert into invoices(company_id, client_id, status, code, issue_date, due_date, currency, tax_rate, subtotal, tax_amount, total, fx_rate)
    values ($1,$2,'draft',$3,$4,$4,'EUR',0,$5,0,$5,1) returning id`, [company, C1, code, date, subtotal]))[0].id
  for (const [i, l] of lns.entries()) {
    await db.query(`insert into invoice_lines(company_id, invoice_id, order_line_id, pos, description, qty, unit_price, discount_pct) values ($1,$2,$3,$4,'Ligne',$5,$6,0)`, [company, id, l.sol, i + 1, l.qty, l.price])
  }
  await db.exec(`alter table invoices enable trigger invoices_fx_snapshot_u; alter table invoices enable trigger invoices_gl_issue_u`)
  await asSuper(fin, () => db.query(`update invoices set status='issued' where id=$1`, [id]))
  await db.exec(`alter table invoices disable trigger invoices_fx_snapshot_u; alter table invoices disable trigger invoices_gl_issue_u`)
  return id
}
await mkInvoice('FAC-P65-1', '2026-01-15', [{ sol: solA1, qty: 12, price: 110 }])
await mkInvoice('FAC-P65-2', '2026-02-15', [{ sol: solA2, qty: 9, price: 105 }, { sol: solB, qty: 4, price: 210 }])
await db.exec('alter table invoices enable trigger user')
await db.exec('alter table invoice_lines enable trigger user')

// --- 9. Marges : définies par ligne, rapprochées du grand livre ------------------------------------------------------------------------
const mr = await as(admin, () => q(`select article_code, qty, revenue, margin, cost_coverage_pct from analytic_margin_report('2026-01-01','2026-02-28') order by article_code`))
const mA = mr.find((x) => x.article_code === 'ART-P65-A')
const mB = mr.find((x) => x.article_code === 'ART-P65-B')
ok('marge produit A : 21 unités, revenu 2 265, marge 1 005 (coût figé 60), couverture 100 %', num(mA.qty) === 21 && num(mA.revenue) === 2265 && num(mA.margin) === 1005 && num(mA.cost_coverage_pct) === 100)
ok('marge produit B : 4 unités, revenu 840, marge 200 (coût figé 160)', num(mB.qty) === 4 && num(mB.revenue) === 840 && num(mB.margin) === 200)
const rec = (await as(admin, () => q(`select analytic_margin_reconcile('2026-01-01','2026-02-28') r`)))[0].r
ok('marge rapprochée : revenu des lignes 3 105 = compte 701 du grand livre, écart 0', num(rec.revenue_lines) === 3105 && num(rec.ledger_701) === 3105 && rec.reconciled === true)
await rejects('marge refusée sans droit de coûts', () => as(nobody, () => q(`select * from analytic_margin_report('2026-01-01','2026-02-28')`)), 'RBAC_FORBIDDEN')

// --- 10. Écarts : volume, mix, prix, coût/rendement — identité exacte, sans double comptage ----------------------------------------------------
const dec = await as(admin, () => q(`select article_code, qty_budget, qty_actual, volume, mix, price, cost_yield, total from analytic_variance_decompose(2026, 1, 2, 'initial') order by article_code`))
const dA = dec.find((x) => x.article_code === 'ART-P65-A')
const dB = dec.find((x) => x.article_code === 'ART-P65-B')
ok('écarts produit A : volume +42, mix −42, prix +165, coût 0', num(dA.volume) === 42 && num(dA.mix) === -42 && Math.abs(num(dA.price) - 165) < 0.0001 && num(dA.cost_yield) === 0)
ok('écarts produit B : volume −42, mix +32, prix +40, coût/rendement −40', num(dB.volume) === -42 && num(dB.mix) === 32 && num(dB.price) === 40 && num(dB.cost_yield) === -40)
const sumTotals = dec.reduce((s, x) => s + num(x.total), 0)
const marginVariance = (1005 + 200) - (800 + 250)
ok('identité : somme des écarts = variation de marge (1 205 − 1 050 = 155), sans double comptage', Math.abs(sumTotals - marginVariance) < 0.0001)
ok('volumes : la quantité totale est identique (25 vs 25), donc volume total nul', Math.abs(dec.reduce((s, x) => s + num(x.volume), 0)) < 0.0001)
await rejects('écarts refusés sans budget validé (2027)', () => as(admin, () => q(`select * from analytic_variance_decompose(2027, 1, 2, 'initial')`)), 'ANALYTIC_NO_BUDGET')

// --- 11. Historique, droits, audit -----------------------------------------------------------------------------------------------------
await rejects('clé déjà signée : seconde signature refusée', () => as(fin, () => rpc('analytic_key_version_validate', KV2, true)), 'ANALYTIC_BAD_STATUS')
ok('budget initial inchangé après révision (500 → 700 en révision, 500 en initial)', num((await q(`select sum(amount) s from analytic_budget_lines where version_id=$1 and line_kind='center_expense'`, [BI]))[0].s) === 500)
ok('lecture des budgets sans droit : aucune ligne visible', (await as(nobody, () => q(`select count(*)::int n from analytic_budget_versions`)))[0].n === 0)
const actions = (await q(`select string_agg(distinct action, ',' order by action) s from audit_logs where action like 'analytic.%'`))[0].s
ok('audit : membres, clés, allocations, budgets, engagements tracés',
  ['analytic.member_create', 'analytic.key_create', 'analytic.key_version_create', 'analytic.key_validate', 'analytic.allocate', 'analytic.budget_version_create',
   'analytic.budget_validate', 'analytic.commitment_add', 'analytic.commitment_close'].every((a) => actions.includes(a)))
