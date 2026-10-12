import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0015_variants.sql', '0016_subcontracting.sql', '0017_warehouses.sql', '0018_stock_movements.sql', '0019_production.sql', '0020_quality.sql'])
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
const qual = await mkUser('qual@x.com', 'qualite')
const prodU = await mkUser('prod@x.com', 'production')
const dir = await mkUser('dir@x.com', 'direction')
const nobody = await mkUser('nobody@x.com', null)
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)

// --- 0. Permissions -------------------------------------------------------------------------------------------------------------------
const pq = await perms('qualite')
ok('qualité : lecture, saisie et approbation', pq.includes('quality.read') && pq.includes('quality.write') && pq.includes('quality.approve'))
ok('production : lecture seule de la qualité', (await perms('production')).includes('quality.read') && !(await perms('production')).includes('quality.approve'))

// --- 1. Fixtures : référentiel, matière, article, ordre de fabrication -------------------------------------------------------------
await as(qual, () => rpc('quality_defect_code_save', 'CO-01', 'Couture décalée', 'couture', 'minor'))
await as(qual, () => rpc('quality_defect_code_save', 'TA-01', 'Taille hors tolérance', 'dimension', 'major'))
await as(qual, () => rpc('quality_defect_code_save', 'TC-01', 'Trou dans le tissu', 'matiere', 'critical'))
ok('référentiel : code enregistré en majuscules', (await q(`select code from quality_defect_codes where code='CO-01'`)).length === 1)
await rejects('code défaut invalide refusé', () => as(qual, () => rpc('quality_defect_code_save', 'co 01', 'Mauvais', 'couture', 'minor')), 'check constraint')
await rejects('référentiel réservé à qualité.write', () => as(nobody, () => rpc('quality_defect_code_save', 'XX-01', 'Intrus', 'autre', 'minor')), 'RBAC_FORBIDDEN')

const mat = (await as(admin, () => q(`insert into bom_materials(name, category, unit) values ('Tissu coton','fabric','m') returning *`)))[0]
const client = (await as(admin, () => q(`insert into clients(name, country) values ('LAFONT','FR') returning id`)))[0].id
const art = (await as(admin, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'LAF-HV-1','Veste HV','jacket') returning id`, [client])))[0].id
const wc = (await as(admin, () => q(`insert into work_centers(code, name, kind) values ('COU-01','Couture 1','couture') returning id`)))[0].id
const d = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const of1 = await as(admin, () => rpc('production_order_create', art, 50, 20, wc, d(0), d(5), null, null))

// --- 2. Contrôle réception : défauts, décision ----------------------------------------------------------------------------------------
const r1 = await as(qual, () => rpc('quality_inspection_open', 'reception', mat.id, null, null, null, 'BL-2026-044', 20, 'Lot tissu'))
const insp1 = (await q(`select number, status, sample_size from quality_inspections where id=$1`, [r1]))[0]
ok('contrôle réception : numéro QC-AAAA-000001, ouvert, échantillon 20', /^QC-\d{4}-000001$/.test(insp1.number) && insp1.status === 'open' && Number(insp1.sample_size) === 20)
await rejects('contrôle réception sans matière refusé', () => as(qual, () => rpc('quality_inspection_open', 'reception', null, null, null, null, null, 5, null)), 'check constraint')
await rejects('défaut inconnu refusé', () => as(qual, () => rpc('quality_defect_add', r1, 'ZZ-99', 1, null, null)), 'QUALITY_DEFECT_CODE_NOT_FOUND')
await rejects('défaut de quantité nulle refusé', () => as(qual, () => rpc('quality_defect_add', r1, 'CO-01', 0, null, null)), 'QUALITY_BAD_QTY')
await as(qual, () => rpc('quality_defect_add', r1, 'CO-01', 2, null, 'Couture décalée sur deux pièces'))
await as(qual, () => rpc('quality_defect_add', r1, 'TA-01', 1, null, null))
const dfx = (await q(`select severity from quality_defects where inspection_id=$1 order by severity`, [r1]))
ok('gravité prise dans le référentiel par défaut (majeure pour TA-01)', dfx.some((x) => x.severity === 'major'))
await rejects('acceptation impossible avec un défaut majeur', () => as(qual, () => rpc('quality_inspection_decide', r1, 'accepted', null)), 'QUALITY_DECISION_NOT_ALLOWED')
await rejects('décision réservée à qualité.approve (saisie seule refusée)', () => as(nobody, () => rpc('quality_inspection_decide', r1, 'conditional', null)), 'RBAC_FORBIDDEN')
const dec1 = await as(qual, () => rpc('quality_inspection_decide', r1, 'conditional', 'Acceptation sous réserve'))
ok('acceptation conditionnelle : rebut estimé = 3 défauts, pas de non-conformité', dec1.decision === 'conditional' && dec1.qty_rejected === 3 && dec1.nc_id === null)
const insp1b = (await q(`select status, decision, qty_accepted, qty_rejected from quality_inspections where id=$1`, [r1]))[0]
ok('contrôle fermé : quantités acceptée 17 / rebutée 3', insp1b.status === 'closed' && Number(insp1b.qty_accepted) === 17 && Number(insp1b.qty_rejected) === 3)
await rejects('défaut ajouté à un contrôle fermé refusé', () => as(qual, () => rpc('quality_defect_add', r1, 'CO-01', 1, null, null)), 'QUALITY_BAD_STATUS')
await rejects('historique des défauts immuable', () => db.query(`update quality_defects set qty = 9 where inspection_id=$1`, [r1]), 'QUALITY_IMMUTABLE')

// --- 3. Contrôle réception rejeté : non-conformité automatique ----------------------------------------------------------------------
const r2 = await as(qual, () => rpc('quality_inspection_open', 'reception', mat.id, null, null, null, 'BL-2026-045', 10, null))
await as(qual, () => rpc('quality_defect_add', r2, 'TC-01', 1, null, 'Trou visible'))
await rejects('acceptation refusée en présence d’un défaut critique', () => as(qual, () => rpc('quality_inspection_decide', r2, 'conditional', null)), 'QUALITY_CRITICAL_DEFECT')
const dec2 = await as(qual, () => rpc('quality_inspection_decide', r2, 'rejected', 'Tissu troué'))
ok('rejet : non-conformité NC-AAAA-000001 ouverte automatiquement', dec2.nc_id && /^NC-\d{4}-000001$/.test(dec2.nc_number))
const nc1 = (await q(`select status, severity, inspection_id from quality_nonconformities where id=$1`, [dec2.nc_id]))[0]
ok('non-conformité : statut ouvert, gravité critique (pire défaut), liée au contrôle', nc1.status === 'open' && nc1.severity === 'critical' && nc1.inspection_id === r2)
ok('rejet : toute la quantité échantillonnée rebutée (10)', Number((await q(`select qty_rejected from quality_inspections where id=$1`, [r2]))[0].qty_rejected) === 10)
await rejects('décision déjà prise : nouvelle décision refusée', () => as(qual, () => rpc('quality_inspection_decide', r2, 'accepted', null)), 'QUALITY_BAD_STATUS')

// --- 4. Contrôle production et final ---------------------------------------------------------------------------------------------------
const rp = await as(qual, () => rpc('quality_inspection_open', 'production', null, null, of1, null, null, 50, null))
ok('contrôle production : lié à l’ordre de fabrication', (await q(`select production_order_id from quality_inspections where id=$1`, [rp]))[0].production_order_id === of1)
await rejects('contrôle production sans ordre refusé', () => as(qual, () => rpc('quality_inspection_open', 'production', null, null, null, null, null, 5, null)), 'check constraint')
await as(qual, () => rpc('quality_defect_add', rp, 'CO-01', 1, null, null))
await as(qual, () => rpc('quality_inspection_decide', rp, 'accepted', null))
const rf = await as(qual, () => rpc('quality_inspection_open', 'final', null, art, null, null, null, 5, 'Contrôle final lot 1'))
ok('contrôle final sur article : ouvert', (await q(`select kind, status from quality_inspections where id=$1`, [rf]))[0].status === 'open')
await as(qual, () => rpc('quality_inspection_decide', rf, 'accepted', null))
ok('contrôle final accepté sans défaut : 5 acceptées', Number((await q(`select qty_accepted from quality_inspections where id=$1`, [rf]))[0].qty_accepted) === 5)

// --- 5. Non-conformités et actions correctives ----------------------------------------------------------------------------------------
const nc2 = await as(qual, () => rpc('quality_nc_open', 'Ourlet mal fini sur lot 12', 'Plusieurs ourlets ouverts', 'major', d(3)))
await rejects('clôture sans confinement refusée', () => as(qual, () => rpc('quality_nc_close', nc2, null)), 'QUALITY_BAD_STATUS')
await rejects('confinement sans explication refusé', () => as(qual, () => rpc('quality_nc_contain', nc2, 'ok', null)), 'QUALITY_REASON_REQUIRED')
await as(qual, () => rpc('quality_nc_contain', nc2, 'Lot 12 mis en quarantaine', 'Réglage de la surjeteuse'))
ok('confinement : non-conformité contenue, cause enregistrée', (await q(`select status, root_cause from quality_nonconformities where id=$1`, [nc2]))[0].root_cause === 'Réglage de la surjeteuse')
const plan = await as(qual, () => rpc('quality_plan_create', 'Plan ourlets', 'Supprimer les ourlets défectueux', null, d(0), d(30)))
await rejects('action liée à un plan en brouillon refusée', () => as(qual, () => rpc('quality_ca_add', nc2, 'corrective', 'Recaler la surjeteuse', null, d(5), plan)), 'QUALITY_PLAN_NOT_ACTIVE')
await as(qual, () => rpc('quality_plan_activate', plan))
const ca1 = await as(qual, () => rpc('quality_ca_add', nc2, 'corrective', 'Recaler la surjeteuse', null, d(-2), plan))
const ca2 = await as(qual, () => rpc('quality_ca_add', nc2, 'preventive', 'Contrôle à chaque changement de bobine', null, d(10), null))
await rejects('vérification avant réalisation refusée', () => as(qual, () => rpc('quality_ca_verify', ca1, true)), 'QUALITY_BAD_STATUS')
await rejects('passage direct à en cours puis fait : étape invalide refusée', () => as(qual, () => rpc('quality_ca_progress', ca1, 'todo')), 'QUALITY_BAD_STATUS')
await as(qual, () => rpc('quality_ca_progress', ca1, 'in_progress'))
await as(qual, () => rpc('quality_ca_progress', ca1, 'done'))
await rejects('plan non clôturable : une action encore ouverte', () => as(qual, () => rpc('quality_plan_close', plan)), 'QUALITY_ACTIONS_OPEN')
await rejects('clôture NC refusée : une action non vérifiée', () => as(qual, () => rpc('quality_nc_close', nc2, null)), 'QUALITY_ACTIONS_OPEN')
await as(qual, () => rpc('quality_ca_verify', ca1, true))
await as(qual, () => rpc('quality_ca_cancel', ca2, 'Remplacée par la procédure de bobine'))
await rejects('action annulée : vérification refusée', () => as(qual, () => rpc('quality_ca_verify', ca2, true)), 'QUALITY_BAD_STATUS')
await as(qual, () => rpc('quality_nc_close', nc2, null))
ok('clôture NC : action vérifiée efficace, NC fermée', (await q(`select status from quality_nonconformities where id=$1`, [nc2]))[0].status === 'closed')
await rejects('non-conformité fermée : nouvelle action refusée', () => as(qual, () => rpc('quality_ca_add', nc2, 'corrective', 'Trop tard', null, d(2), null)), 'QUALITY_BAD_STATUS')
await as(qual, () => rpc('quality_plan_close', plan))
ok('plan clôturé', (await q(`select status from quality_action_plans where id=$1`, [plan]))[0].status === 'closed')

// --- 6. Clôture sans action : justification exigée -------------------------------------------------------------------------------------
const nc3 = await as(qual, () => rpc('quality_nc_open', 'Étiquette illisible', null, 'minor', null))
await as(qual, () => rpc('quality_nc_contain', nc3, 'Étiquettes retirées du lot', null))
await rejects('clôture sans action ni justification refusée', () => as(qual, () => rpc('quality_nc_close', nc3, 'court')), 'QUALITY_JUSTIFICATION_REQUIRED')
await as(qual, () => rpc('quality_nc_close', nc3, 'Défaut cosmétique, aucune récurrence'))
ok('clôture avec justification écrite : fermée', (await q(`select status from quality_nonconformities where id=$1`, [nc3]))[0].status === 'closed')

// --- 7. Retards, historique, indicateurs ----------------------------------------------------------------------------------------------
const nc4 = await as(qual, () => rpc('quality_nc_open', 'Taches sur la doublure', null, 'minor', null))
await as(qual, () => rpc('quality_nc_contain', nc4, 'Pièces isolées', null))
await as(qual, () => rpc('quality_ca_add', nc4, 'corrective', 'Nettoyer la machine', null, d(-5), null))
const dash = await as(dir, () => rpc('quality_dashboard'))
ok('indicateurs : taux de conformité au premier passage (réception : 0 accepté sur 2 fermés, conditionnel exclu)',
  dash.controls.find((c) => c.kind === 'reception').first_pass_pct === 0)
ok('indicateurs : action corrective en retard détectée', dash.actions_overdue >= 1)
ok('indicateurs : efficacité des actions 100 % (une vérifiée efficace)', dash.action_effectiveness_pct === 100)
ok('indicateurs : pareto des défauts, CO-01 en tête (3 unités)', dash.pareto[0].code === 'CO-01' && Number(dash.pareto[0].qty) === 3)
ok('indicateurs : non-conformités ouvertes par gravité', dash.nc_open === 2 && dash.nc_by_severity.critical === 1)
const hist = await as(dir, () => q(`select defect_code, inspection_number from quality_defect_history where inspection_id=$1 order by defect_code`, [r1]))
ok('historique des défauts : 2 défauts du contrôle réception 1, avec leur numéro', hist.length === 2 && hist[0].inspection_number && hist.some((h) => h.defect_code === 'TA-01'))
await rejects('dashboard refusé sans quality.read', () => as(nobody, () => rpc('quality_dashboard')), 'RBAC_FORBIDDEN')
