import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql', '0007_articles.sql', '0008_bom.sql', '0009_stock.sql', '0010_mrp.sql', '0011_purchases.sql', '0012_commercial.sql', '0013_pdm.sql', '0014_development.sql', '0017_warehouses.sql', '0018_stock_movements.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const uuid = () => crypto.randomUUID()
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
const qual = await mkUser('qual@x.com', 'qualite')
const dir = await mkUser('dir@x.com', 'direction')
const fin = await mkUser('fin@x.com', 'finance')
const mag = await mkUser('mag@x.com', 'magasin')
const nobody = await mkUser('nobody@x.com', null)

const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
const has = async (c, ...codes) => { const p = await perms(c); return codes.every((x) => p.includes(x)) }
ok('droits : admin tout ; commercial lit/écrit sans les coûts ; production avec les coûts', (await has('admin', 'development.read', 'development.write', 'development.costs')) && (await has('commercial', 'development.write')) && !(await has('commercial', 'development.costs')) && (await has('production', 'development.write', 'development.costs')))
ok('direction et finance : lecture seule (pas d’écriture ni de saisie de coûts) ; qualité lecture seule ; magasin aucun accès', (await has('direction', 'development.read')) && !(await has('direction', 'development.write', 'development.costs')) && (await has('finance', 'development.read', 'costs.read')) && !(await has('finance', 'development.costs')) && (await has('qualite', 'development.read')) && !(await has('qualite', 'development.write')) && !(await has('magasin', 'development.read')))

const lafont = (await as(comm, () => q(`insert into clients(name,country) values ('LAFONT','FR') returning id`)))[0].id
const other = (await as(comm, () => q(`insert into clients(name,country) values ('Bragard','FR') returning id`)))[0].id
const mkProject = (u, o = {}) => as(u, async () => (await q(`insert into development_projects(client_id, name, family, description, priority, due_date, target_qty, requested_on, product_id) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8, current_date),$9) returning *`,
  [o.client ?? lafont, o.name ?? 'Veste HV hiver', o.family ?? 'jacket', o.desc ?? 'Demande : veste haute visibilité doublée', o.priority ?? 'normal', o.due ?? null, o.qty ?? 500, o.req ?? null, o.product ?? null]))[0])
const adv = (u, id, to, reason = null) => as(u, () => rpc('dev_project_advance', id, to, reason))
const stageOf = async (id) => (await q(`select stage, status from development_projects where id=$1`, [id]))[0]

// --- 1. Création ---------------------------------------------------------------------------------------------------------------------------
const p1 = await mkProject(comm)
ok('projet créé : DEV-0001, étape « demande client », actif', p1.code === 'DEV-0001' && p1.stage === 'request' && p1.status === 'active' && p1.company_id === company && p1.created_by === comm)
const ind0 = (await q(`select * from industrialization where project_id=$1`, [p1.id]))[0]
ok('industrialisation créée avec la liste de contrôle par défaut (8 points)', ind0.status === 'not_started' && ind0.checklist.length === 8 && ind0.checklist.every((c) => c.done === false))
await rejects('création refusée sans droit d’écriture', () => mkProject(dir), 'row-level security')
await rejects('création refusée sans aucun droit', () => mkProject(mag), 'row-level security')
await rejects('étape non modifiable à la main', () => as(comm, () => db.query(`update development_projects set stage='sample' where id=$1`, [p1.id])), 'permission denied')
await rejects('code immuable', () => as(comm, () => db.query(`update development_projects set code='DEV-9' where id=$1`, [p1.id])), 'permission denied')
const pOther = (await as(comm, () => q(`insert into product_master(client_id, name) values ($1,'Produit Bragard') returning id`, [other])))[0].id
await rejects('fiche produit (PDM) d’un autre client refusée', () => mkProject(comm, { name: 'X1 projet', product: pOther }), 'DEV_BAD_PRODUCT')
await rejects('échéance antérieure à la demande refusée', () => mkProject(comm, { name: 'Y2 projet', due: '2020-01-01' }), 'dev_dates_ck')

// --- 2. Workflow et portes de contrôle ---------------------------------------------------------------------------------------------------------
await adv(comm, p1.id, 'project')
ok('demande → projet', (await stageOf(p1.id)).stage === 'project')
await rejects('saut d’étape refusé', () => adv(comm, p1.id, 'sample'), 'DEV_STAGE_SKIP')
await rejects('retour en arrière sans motif refusé', () => adv(comm, p1.id, 'request'), 'DEV_REASON_REQUIRED')
await rejects('avancement réservé à development.write', () => adv(dir, p1.id, 'prototype'), 'RBAC_FORBIDDEN')
await adv(comm, p1.id, 'prototype')
await rejects('porte « prototype approuvé » : passage à l’échantillon refusé', () => adv(comm, p1.id, 'sample'), 'DEV_GATE_PROTOTYPE')

// --- 3. Prototypes et coûts -----------------------------------------------------------------------------------------------------------------
const addProto = (u, pid, o = {}) => as(u, async () => (await q(`insert into prototypes(project_id, name, description, due_date) values ($1,$2,$3,$4) returning *`, [pid, o.name ?? null, o.desc ?? null, o.due ?? null]))[0])
const pr1 = await addProto(comm, p1.id, { name: 'Proto coupe droite' })
const pr2 = await addProto(comm, p1.id, { name: 'Proto coupe ajustée' })
ok('prototypes numérotés par projet (v1, v2), statut « planifié »', pr1.version_no === 1 && pr2.version_no === 2 && pr1.status === 'planned')
const pset = (u, id, st, fb = null) => as(u, () => rpc('dev_prototype_set_status', id, st, fb))
await rejects('transition invalide (planifié → prêt)', () => pset(comm, pr1.id, 'ready'), 'DEV_BAD_STATUS')
await rejects('statut non modifiable à la main', () => as(comm, () => db.query(`update prototypes set status='approved' where id=$1`, [pr1.id])), 'permission denied')
await pset(comm, pr1.id, 'in_progress')
await pset(comm, pr1.id, 'ready', 'Essayage OK')
const pr1r = (await q(`select * from prototypes where id=$1`, [pr1.id]))[0]
ok('prototype : début et fin renseignés, retour d’essayage conservé', pr1r.status === 'ready' && pr1r.started_on && pr1r.completed_on && pr1r.feedback === 'Essayage OK')
await pset(comm, pr2.id, 'in_progress'); await pset(comm, pr2.id, 'rejected', 'Manche trop courte')
ok('prototype rejeté', (await q(`select status from prototypes where id=$1`, [pr2.id]))[0].status === 'rejected')
await rejects('prototype rejeté définitivement (nouvelle version à créer)', () => pset(comm, pr2.id, 'in_progress'), 'DEV_BAD_STATUS')

const addCost = (u, proto, o = {}) => as(u, () => db.query(`insert into prototype_costs(prototype_id, kind, description, quantity, unit_cost) values ($1,$2,$3,$4,$5)`, [proto, o.kind ?? 'material', o.desc ?? 'Tissu jaune HV', o.qty ?? 2.5, o.unit ?? 12.4]))
await addCost(prod, pr1.id)
await addCost(prod, pr1.id, { kind: 'labor', desc: 'Couture proto', qty: 1.5, unit: 18 })
ok('coût de prototype : montant calculé (2,5 × 12,40 = 31,00 ; 1,5 × 18 = 27,00)', (await q(`select amount::float a from prototype_costs order by amount`)).map((r) => r.a).join() === '27,31')
await rejects('coût : saisie réservée à development.costs', () => addCost(comm, pr1.id), 'row-level security')
ok('coût : invisible sans droit (commercial, qualité)', (await as(comm, () => q(`select id from prototype_costs`))).length === 0 && (await as(qual, () => q(`select id from prototype_costs`))).length === 0)
const dirCosts = await has('direction', 'costs.read')
ok('coût : visible pour production et pour finance (costs.read), pour la direction seulement avec costs.read', (await as(prod, () => q(`select id from prototype_costs`))).length === 2 && (await as(fin, () => q(`select id from prototype_costs`))).length === 2 && (await as(dir, () => q(`select id from prototype_costs`))).length === (dirCosts ? 2 : 0))
await rejects('coût : finance ne peut pas saisir (lecture seule)', () => addCost(fin, pr1.id), 'row-level security')
await rejects('coût négatif refusé', () => addCost(prod, pr1.id, { unit: -1 }), 'prototype_costs_unit_cost_check')

await pset(comm, pr1.id, 'approved', 'Validé en interne')
await adv(comm, p1.id, 'sample')
ok('prototype approuvé : porte franchie (étape échantillon)', (await stageOf(p1.id)).stage === 'sample')

// --- 4. Échantillons et validations client -----------------------------------------------------------------------------------------------------
const addSample = (u, pid, o = {}) => as(u, async () => (await q(`insert into samples(project_id, prototype_id, qty, size_label, color, due_date) values ($1,$2,$3,$4,$5,$6) returning *`, [pid, o.proto ?? null, o.qty ?? 2, o.size ?? 'L', o.color ?? 'Jaune HV', o.due ?? null]))[0])
const s1 = await addSample(comm, p1.id, { proto: pr1.id })
const s2 = await addSample(comm, p1.id, { qty: 1, size: 'M' })
ok('échantillons numérotés (v1, v2), statut « planifié »', s1.version_no === 1 && s2.version_no === 2 && s1.status === 'planned')
await rejects('échantillon lié à un prototype d’un autre projet refusé', async () => { const px = await mkProject(comm, { name: 'Autre projet' }); await adv(comm, px.id, 'project'); await adv(comm, px.id, 'prototype'); const pp = await addProto(comm, px.id); await addSample(comm, p1.id, { proto: pp.id }) }, 'DEV_BAD_PROTOTYPE')
const submitSample = (u, sid, due = null) => as(u, () => db.query(`insert into customer_validations(project_id, kind, sample_id, due_date) values ($1,'sample',$2,$3)`, [p1.id, sid, due]))
await rejects('soumission au client impossible tant que l’échantillon n’est pas en cours', () => submitSample(comm, s1.id), 'DEV_BAD_STATUS')
const sset = (u, id, st, trk = null) => as(u, () => rpc('dev_sample_set_status', id, st, trk))
await sset(comm, s1.id, 'in_progress')
await rejects('échantillon : approbation par RPC interdite (réservée à la décision du client)', () => sset(comm, s1.id, 'approved'), 'DEV_BAD_STATUS')
await submitSample(comm, s1.id, new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))
const cv1 = (await q(`select * from customer_validations where sample_id=$1`, [s1.id]))[0]
ok('validation client « échantillon » v1 en attente ; l’échantillon passe à « envoyé »', cv1.status === 'pending' && cv1.version_no === 1 && (await q(`select status, sent_on from samples where id=$1`, [s1.id]))[0].status === 'sent')
await rejects('une seule validation en attente par échantillon', () => submitSample(comm, s1.id), 'cv_one_pending_uq')
await rejects('refus sans commentaire refusé', () => as(comm, () => rpc('dev_validation_decide', cv1.id, 'rejected', null, 'M. Dupont')), 'DEV_COMMENT_REQUIRED')
await rejects('décision réservée à development.write', () => as(dir, () => rpc('dev_validation_decide', cv1.id, 'approved')), 'RBAC_FORBIDDEN')
await as(comm, () => rpc('dev_validation_remind', cv1.id, 'Relance par e-mail'))
ok('relance tracée (compteur, date)', (await q(`select reminder_count, last_reminder_on from customer_validations where id=$1`, [cv1.id]))[0].reminder_count === 1)
await as(comm, () => rpc('dev_validation_decide', cv1.id, 'changes_requested', 'Raccourcir la manche de 1 cm', 'M. Dupont'))
const cv1r = (await q(`select * from customer_validations where id=$1`, [cv1.id]))[0]
ok('modifications demandées : décision, contact et date enregistrés ; échantillon en « révision »', cv1r.status === 'changes_requested' && cv1r.decided_by_name === 'M. Dupont' && cv1r.decided_on && (await q(`select status from samples where id=$1`, [s1.id]))[0].status === 'revision')
await rejects('décision déjà prise : non modifiable', () => as(comm, () => rpc('dev_validation_decide', cv1.id, 'approved')), 'DEV_BAD_STATUS')
await sset(comm, s1.id, 'in_progress')
await sset(comm, s1.id, 'sent', 'DHL 123456')
ok('retour en « en cours » après révision, puis envoi avec n° de suivi', (await q(`select status, tracking from samples where id=$1`, [s1.id]))[0].tracking === 'DHL 123456')
await submitSample(comm, s1.id)
ok('nouvelle validation = v2', (await q(`select version_no from customer_validations where sample_id=$1 order by version_no desc limit 1`, [s1.id]))[0].version_no === 2)
const cv2 = (await q(`select id from customer_validations where sample_id=$1 and status='pending'`, [s1.id]))[0].id
await rejects('porte « échantillon approuvé » : passage au BAT refusé', () => adv(comm, p1.id, 'bat'), 'DEV_GATE_SAMPLE')
await as(comm, () => rpc('dev_validation_decide', cv2, 'approved', 'OK pour la suite', 'M. Dupont'))
ok('échantillon approuvé par le client', (await q(`select status from samples where id=$1`, [s1.id]))[0].status === 'approved')
await adv(comm, p1.id, 'bat')

// --- 5. BAT, validation client ---------------------------------------------------------------------------------------------------------------
await rejects('porte « BAT soumis » : passage à la validation refusé', () => adv(comm, p1.id, 'validation'), 'DEV_GATE_BAT')
const submitBat = (u, pid, due = null) => as(u, () => db.query(`insert into customer_validations(project_id, kind, due_date) values ($1,'bat',$2)`, [pid, due]))
const pEarly = await mkProject(comm, { name: 'Projet trop tôt' })
await rejects('BAT refusé avant l’étape BAT', () => submitBat(comm, pEarly.id), 'DEV_BAD_STAGE')
await submitBat(comm, p1.id)
const bat1 = (await q(`select * from customer_validations where project_id=$1 and kind='bat'`, [p1.id]))[0]
ok('BAT v1 soumis, en attente', bat1.status === 'pending' && bat1.version_no === 1 && bat1.sample_id === null)
await adv(comm, p1.id, 'validation')
await rejects('porte « BAT approuvé » : passage à l’industrialisation refusé (en attente)', () => adv(comm, p1.id, 'industrialization'), 'DEV_GATE_VALIDATION')
await as(comm, () => rpc('dev_validation_decide', bat1.id, 'rejected', 'Couleur du marquage à corriger', 'Mme Martin'))
await rejects('BAT refusé : toujours bloquant', () => adv(comm, p1.id, 'industrialization'), 'DEV_GATE_VALIDATION')
await submitBat(comm, p1.id)
const bat2 = (await q(`select * from customer_validations where project_id=$1 and kind='bat' and status='pending'`, [p1.id]))[0]
ok('BAT v2 (le BAT se resoumet à l’étape Validation client)', bat2.version_no === 2)
await rejects('un BAT en attente bloque aussi', () => adv(comm, p1.id, 'industrialization'), 'DEV_GATE_VALIDATION')
await as(comm, () => rpc('dev_validation_decide', bat2.id, 'approved', null, 'Mme Martin'))
await adv(comm, p1.id, 'industrialization')
ok('BAT approuvé : industrialisation démarrée', (await stageOf(p1.id)).stage === 'industrialization' && (await q(`select status from industrialization where project_id=$1`, [p1.id]))[0].status === 'in_progress')

// --- 6. Industrialisation ----------------------------------------------------------------------------------------------------------------------
await rejects('porte « industrialisation prête » : passage en série refusé', () => adv(comm, p1.id, 'production'), 'DEV_GATE_INDUSTRIALIZATION')
await rejects('« prête » refusé tant que la liste de contrôle est incomplète', () => as(comm, () => rpc('dev_industrialization_set_status', p1.id, 'ready')), 'DEV_CHECKLIST_INCOMPLETE')
await rejects('statut d’industrialisation non modifiable à la main', () => as(comm, () => db.query(`update industrialization set status='ready' where project_id=$1`, [p1.id])), 'permission denied')
const cl = (await q(`select checklist from industrialization where project_id=$1`, [p1.id]))[0].checklist
await as(comm, () => db.query(`update industrialization set checklist=$2::jsonb, pilot_qty=50, lead_time_days=21, target_date=current_date + 30 where project_id=$1`, [p1.id, JSON.stringify(cl.map((c, i) => ({ ...c, done: i < 7 })))]))
await rejects('liste de contrôle invalide refusée', () => as(comm, () => db.query(`update industrialization set checklist='[{"key":"a"}]'::jsonb where project_id=$1`, [p1.id])), 'industrialization_checklist_ck')
await rejects('encore incomplète (7/8)', () => as(comm, () => rpc('dev_industrialization_set_status', p1.id, 'ready')), 'DEV_CHECKLIST_INCOMPLETE')
await as(comm, () => db.query(`update industrialization set checklist=$2::jsonb where project_id=$1`, [p1.id, JSON.stringify(cl.map((c) => ({ ...c, done: true })))]))
const artO = (await as(comm, () => q(`insert into articles(client_id, client_ref, name, family) values ($1,'BRG-1','Veste Bragard','jacket') returning id`, [other])))[0].id
const bomO = (await as(prod, () => q(`insert into boms(name, article_id) values ('BOM Bragard', $1) returning id`, [artO])))[0].id
await rejects('nomenclature d’un autre client refusée', () => as(comm, () => db.query(`update industrialization set bom_id=$2 where project_id=$1`, [p1.id, bomO])), 'DEV_BAD_BOM')
// fiche produit liée mais non validée → blocage
const pdm = (await as(comm, () => q(`insert into product_master(client_id, name) values ($1,'Veste HV hiver') returning id`, [lafont])))[0].id
await as(comm, () => db.query(`update development_projects set product_id=$2 where id=$1`, [p1.id, pdm]))
await as(comm, () => rpc('dev_industrialization_set_status', p1.id, 'ready'))
ok('industrialisation « prête » (8/8)', (await q(`select status, ready_at from industrialization where project_id=$1`, [p1.id]))[0].ready_at !== null)
await rejects('fiche produit liée non validée : mise en série refusée', () => adv(comm, p1.id, 'production'), 'DEV_PRODUCT_NOT_VALIDATED')
await as(comm, () => db.query(`update development_projects set product_id=null where id=$1`, [p1.id]))
await adv(comm, p1.id, 'production')
ok('mise en production série : industrialisation « livrée »', (await stageOf(p1.id)).stage === 'production' && (await q(`select status, released_at from industrialization where project_id=$1`, [p1.id]))[0].status === 'released')
await rejects('terminer exige l’étape production', async () => { const pz = await mkProject(comm, { name: 'Projet non abouti' }); await as(comm, () => rpc('dev_project_set_status', pz.id, 'completed')) }, 'DEV_GATE_COMPLETE')
await adv(comm, p1.id, 'industrialization', 'Défaut de gamme détecté')
ok('retour arrière avec motif : industrialisation de nouveau « prête »', (await stageOf(p1.id)).stage === 'industrialization' && (await q(`select status, released_at from industrialization where project_id=$1`, [p1.id]))[0].status === 'ready')
await adv(comm, p1.id, 'production')

// --- 7. Échanges et pièces jointes ------------------------------------------------------------------------------------------------------------------
await as(comm, () => db.query(`insert into development_exchanges(project_id, direction, channel, subject, body, contact_name) values ($1,'inbound','email','Demande initiale','Merci de proposer une veste doublée…','M. Dupont')`, [p1.id]))
await as(comm, () => db.query(`insert into development_exchanges(project_id, direction, channel, subject) values ($1,'outbound','phone','Point sur le BAT')`, [p1.id]))
ok('historique des échanges (entrant, sortant)', (await q(`select count(*)::int n from development_exchanges where project_id=$1`, [p1.id]))[0].n === 2)
await rejects('échange non modifiable', () => as(comm, () => db.query(`update development_exchanges set subject='x' where project_id=$1`, [p1.id])), 'permission denied')
await rejects('échange non supprimable', () => as(admin, () => db.query(`delete from development_exchanges where project_id=$1`, [p1.id])), 'permission denied')
const folderOf = async (cid, key) => (await q(`select id from ged_folders where client_id=$1 and system_key=$2`, [cid, key]))[0].id
const mkDoc = async (cid, key, title) => {
  const id = uuid(), ver = uuid(), folder = await folderOf(cid, key)
  await as(comm, () => rpc('ged_create_document', id, folder, title, null, [], null, ver, `${company}/${cid}/${id}/${ver}-f.pdf`, 'f.pdf', 'application/pdf', 1000, uuid().replace(/-/g, '').repeat(2), null))
  return id
}
const doc1 = await mkDoc(lafont, 'patterns', 'Demande client — cahier des charges')
const docOther = await mkDoc(other, 'patterns', 'Document autre client')
await as(comm, () => db.query(`insert into development_documents(project_id, ged_document_id, kind) values ($1,$2,'request')`, [p1.id, doc1]))
ok('pièce jointe GED rattachée au projet', (await q(`select kind from development_documents where project_id=$1`, [p1.id]))[0].kind === 'request')
await rejects('même document deux fois refusé', () => as(comm, () => db.query(`insert into development_documents(project_id, ged_document_id) values ($1,$2)`, [p1.id, doc1])), 'development_documents_project_id_ged_document_id_key')
await rejects('document d’un autre client refusé', () => as(comm, () => db.query(`insert into development_documents(project_id, ged_document_id) values ($1,$2)`, [p1.id, docOther])), 'DEV_BAD_DOCUMENT')

// --- 8. Statuts du projet (pause, annulation, clôture) -----------------------------------------------------------------------------------------------
await as(comm, () => rpc('dev_project_set_status', p1.id, 'completed'))
ok('projet terminé (étape production)', (await stageOf(p1.id)).status === 'completed')
await rejects('projet terminé : prototype refusé', () => addProto(comm, p1.id), 'DEV_PROJECT_CLOSED')
await rejects('projet terminé : modification refusée', () => as(comm, () => db.query(`update development_projects set name='Autre nom' where id=$1`, [p1.id])), 'DEV_PROJECT_CLOSED')
await rejects('projet terminé : coût refusé', () => addCost(prod, pr1.id), 'DEV_PROJECT_CLOSED')
await as(comm, () => db.query(`insert into development_exchanges(project_id, direction, channel, subject) values ($1,'inbound','email','Retour sur la première série')`, [p1.id]))
ok('projet terminé : les échanges restent saisissables', (await q(`select count(*)::int n from development_exchanges where project_id=$1`, [p1.id]))[0].n === 3)
await rejects('projet terminé : statut non modifiable', () => as(comm, () => rpc('dev_project_set_status', p1.id, 'active')), 'DEV_PROJECT_CLOSED')

const p2 = await mkProject(comm, { name: 'Pantalon cargo HV', family: 'trousers', priority: 'urgent' })
await as(comm, () => rpc('dev_project_set_status', p2.id, 'on_hold', 'Attente de la décision du client'))
await rejects('projet en pause : avancement refusé', () => adv(comm, p2.id, 'project'), 'DEV_PROJECT_NOT_ACTIVE')
await as(comm, () => rpc('dev_project_set_status', p2.id, 'active'))
await adv(comm, p2.id, 'project')
await rejects('annulation sans motif refusée', () => as(comm, () => rpc('dev_project_set_status', p2.id, 'cancelled')), 'DEV_REASON_REQUIRED')
await as(comm, () => rpc('dev_project_set_status', p2.id, 'cancelled', 'Le client abandonne le modèle'))
ok('projet annulé (motif conservé, date de clôture)', (await q(`select status, hold_reason, closed_at from development_projects where id=$1`, [p2.id]))[0].hold_reason === 'Le client abandonne le modèle')
await rejects('projet annulé : prototype refusé', () => addProto(comm, p2.id), 'DEV_PROJECT_CLOSED')

// --- 9. Alertes de validation et tableau de bord -----------------------------------------------------------------------------------------------------
const p3 = await mkProject(comm, { name: 'Parka grand froid', family: 'parka', req: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10), due: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10) })
await adv(comm, p3.id, 'project'); await adv(comm, p3.id, 'prototype')
const pr3 = await addProto(comm, p3.id, { name: 'Proto parka', due: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10) })
const mkS = async (qty) => { const s = await addSample(comm, p3.id, { qty }); await sset(comm, s.id, 'in_progress'); return s.id }
const sa = await mkS(1), sb = await mkS(2), sc = await mkS(3)
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
// dates passées : insertion directe (le trigger ne les réécrit pas)
await db.query(`insert into customer_validations(project_id, kind, sample_id, submitted_on, due_date) values ($1,'sample',$2,$3,$4)`, [p3.id, sa, day(-10), day(-3)])
await db.query(`insert into customer_validations(project_id, kind, sample_id, submitted_on, due_date) values ($1,'sample',$2,$3,$4)`, [p3.id, sb, day(-1), day(2)])
await db.query(`insert into customer_validations(project_id, kind, sample_id, submitted_on, due_date) values ($1,'sample',$2,$3,null)`, [p3.id, sc, day(-10)])
const al = await as(comm, () => rpc('development_alerts'))
const t = (type) => al.filter((a) => a.type === type)
ok('alerte : validation en retard (3 jours, gravité haute)', t('validation_overdue').length === 1 && t('validation_overdue')[0].days === 3 && t('validation_overdue')[0].severity === 'high' && t('validation_overdue')[0].code === p3.code)
ok('alerte : validation à échéance proche (2 jours)', t('validation_due_soon').length === 1 && t('validation_due_soon')[0].days === -2)
ok('alerte : validation sans réponse depuis plus de 7 jours (sans échéance)', t('validation_stale').length === 1 && t('validation_stale')[0].days === 10)
ok('alerte : projet en retard (5 jours) et prototype en retard (2 jours)', t('project_overdue').some((a) => a.code === p3.code && a.days === 5) && t('prototype_overdue').some((a) => a.days === 2))
ok('alertes triées : les retards d’abord', al[0].severity === 'high' && al.findIndex((a) => a.severity === 'medium') > al.findLastIndex((a) => a.severity === 'high'))
ok('alertes : aucun projet annulé ou terminé', al.every((a) => a.code !== p2.code && a.code !== p1.code))
await rejects('alertes refusées sans droit de lecture', () => as(mag, () => rpc('development_alerts')), 'RBAC_FORBIDDEN')

const dash = await as(prod, () => rpc('development_dashboard'))
const stageCount = (s) => dash.by_stage.find((x) => x.stage === s).count
ok('tableau de bord : projets par étape (8 colonnes)', dash.by_stage.length === 8 && stageCount('production') === 0 && stageCount('prototype') === 2 && stageCount('request') === 2, JSON.stringify(dash.by_stage))
ok('tableau de bord : totaux (actifs, terminés, annulés, en retard)', dash.projects.active === 4 && dash.projects.completed === 1 && dash.projects.cancelled === 1 && dash.projects.overdue === 1, JSON.stringify(dash.projects))
ok('tableau de bord : validations (3 en attente, 1 en retard, taux et délais)', dash.validations.pending === 3 && dash.validations.overdue === 1 && dash.validations.approved_90d >= 2 && dash.validations.refused_90d >= 2 && dash.validations.avg_response_days !== null, JSON.stringify(dash.validations))
ok('tableau de bord : en cours (prototypes, échantillons)', dash.work.prototypes_open === 2 && dash.work.samples_at_client === 3 && dash.work.samples_open === 0, JSON.stringify(dash.work))
ok('tableau de bord : 6 mois, top clients, priorités, cycle moyen', dash.by_month.length === 6 && dash.by_client[0].client === 'LAFONT' && dash.by_priority.normal === 4 && dash.projects.avg_cycle_days !== null)
ok('tableau de bord : coûts de prototype visibles avec development.costs (58 €)', Number(dash.costs?.total) === 58 && dash.costs?.by_project[0].code === p1.code, JSON.stringify(dash.costs))
ok('tableau de bord : coûts absents sans droit (commercial)', (await as(comm, () => rpc('development_dashboard'))).costs === undefined)
ok('tableau de bord : coûts visibles pour la finance (costs.read), pas pour la qualité', Number((await as(fin, () => rpc('development_dashboard'))).costs.total) === 58 && (await as(qual, () => rpc('development_dashboard'))).costs === undefined)

// --- 10. Historique, isolation ------------------------------------------------------------------------------------------------------------------------
const acts = new Set((await q(`select action from audit_logs where entity_type='dev_project'`)).map((r) => r.action))
for (const a of ['dev.create', 'dev.update', 'dev.stage', 'dev.status', 'dev.prototype_add', 'dev.prototype_status', 'dev.cost_add', 'dev.sample_add', 'dev.sample_status', 'dev.validation_submit',
  'dev.validation_decide', 'dev.validation_remind', 'dev.exchange_add', 'dev.document_link', 'dev.industrialization_update', 'dev.industrialization_status'])
  ok(`historique : ${a}`, acts.has(a))
const stg = (await q(`select before_data, after_data, metadata from audit_logs where action='dev.stage' and entity_id=$1 and (metadata->>'backward')::boolean`, [p1.id]))[0]
ok('historique : retour arrière tracé avec le motif', stg.before_data.stage === 'production' && stg.after_data.stage === 'industrialization' && stg.metadata.reason === 'Défaut de gamme détecté')
const costAudit = JSON.stringify(await q(`select before_data, after_data, metadata from audit_logs where action like 'dev.cost_%'`))
ok('historique : jamais de montant de coût (31, 27, 12,4, 18)', !/\b31\b|\b27\b|12\.4|\b18\b|amount|unit_cost/.test(costAudit))
const toggled = (await q(`select metadata from audit_logs where action='dev.industrialization_update' order by created_at limit 1`))[0].metadata
ok('historique : points de contrôle cochés tracés', Array.isArray(toggled.toggled) && toggled.toggled.length === 7 && toggled.total === 8)
ok('historique lisible avec development.read (qualité), pas sans', (await as(qual, () => q(`select id from audit_logs where entity_type='dev_project'`))).length > 0 && (await as(nobody, () => q(`select id from audit_logs where entity_type='dev_project'`))).length === 0)
await rejects('historique append-only', () => as(admin, () => db.query(`delete from audit_logs where entity_type='dev_project'`)), 'permission denied')
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const cli2 = (await q(`insert into clients(company_id, code, name, country) values ($1,'CLI-9','Étranger','FR') returning id`, [co2]))[0].id
await db.query(`insert into development_projects(company_id, client_id, code, name) values ($1,$2,'DEV-9001','Étranger')`, [co2, cli2])
ok('isolation entre sociétés', (await as(admin, () => q(`select id from development_projects where code='DEV-9001'`))).length === 0)
ok('sans droit : aucune lecture', (await as(nobody, () => q(`select id from development_projects`))).length === 0 && (await as(mag, () => q(`select id from samples`))).length === 0)

process.exit(process.exitCode ?? 0)
