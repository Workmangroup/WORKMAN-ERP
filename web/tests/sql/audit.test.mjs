import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const exec = (sql, params) => db.query(sql, params)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const dir = await mkUser('dir@x.com', 'direction')
const fin = await mkUser('fin@x.com', 'finance')
const fin2 = await mkUser('fin2@x.com', 'finance')
const qual = await mkUser('qual@x.com', 'qualite')
const vis = await mkUser('visiteur@x.com', 'magasin')
const iso = (ms) => new Date(Date.now() + ms).toISOString()
const DAY = 24 * 3600 * 1000
const dInv = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10)

// Lecture d'audit pour le visiteur : droit audit.read accordé pour ce test ; il n'a pas costs.read ni audit.export
await db.query(`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.company_id=$1 and r.code='magasin' and p.code='audit.read' on conflict do nothing`, [company])
ok('précondition : le visiteur n’a ni costs.read ni audit.export', (await q(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='magasin' and r.company_id=$1 and p.code in ('costs.read','audit.export')`, [company]))[0].n === 0)

// --- Données métier de référence ---------------------------------------------------------------------------------------------------------------
const sup = (await q(`insert into suppliers(company_id, code, name, country) values ($1,'F-001','Tissus Sfax','TN') returning id`, [company]))[0].id
await as(fin, () => q(`select public.supplier_invoice_record($1, 'FT-1', $2, $3, 1000, 'EUR', null) `, [sup, dInv(-40), dInv(-30)]))

// --- A. Acteur réel et validation directe ----------------------------------------------------------------------------------------------------
const po = await as(fin, () => rpc('payment_order_prepare', sup, 300, 'Acompte tissus'))
await as(dir, () => rpc('payment_order_decide', po.id, true, 'Accord direction'))
const appr = (await q(`select * from audit_logs where action='payment_order.approve' and entity_id=$1`, [po.id]))[0]
ok('validation directe : acteur réel = approbateur, kind = user, pas de délégation', appr.actor_id === dir && appr.actor_kind === 'user' && appr.delegation_id === null)
ok('validation : significative, motif repris (commentaire), corrélation présente', appr.significant === true && appr.reason === 'Accord direction' && appr.correlation_id !== null)

// --- B. Acteur délégué : acteur réel + délégation + délégant ----------------------------------------------------------------------------------
const dlg = await as(admin, () => rpc('delegation_grant', fin2, 'payments.approve', 'payment_order', null, 500, iso(DAY), 'Remplacement trésorerie', null))
const po2 = await as(fin, () => rpc('payment_order_prepare', sup, 200, 'Transport'))
await as(fin2, () => rpc('payment_order_decide', po2.id, true, 'Via délégation'))
const dAppr = (await q(`select * from audit_logs where action='payment_order.approve' and entity_id=$1`, [po2.id]))[0]
ok('validation déléguée : acteur réel = délégué, kind = delegate', dAppr.actor_id === fin2 && dAppr.actor_kind === 'delegate')
ok('validation déléguée : délégation et délégant tracés', dAppr.delegation_id === dlg && dAppr.on_behalf_of === admin)
ok('la délégation ne fuit pas vers l’action suivante', (await q(`select delegation_id from audit_logs where action='payment_order.prepare' and entity_id=$1`, [po2.id]))[0].delegation_id === null)

// --- C. Corrélation : une action = un correlation_id partagé ---------------------------------------------------------------------------------
const mat = (await q(`insert into bom_materials(company_id, name, category, unit) values ($1,'Tissu coton','fabric','m') returning id`, [company]))[0].id
const insR = await as(qual, () => rpc('quality_inspection_open', 'reception', mat, null, null, null, 'BL-AUD-1', 5, 'Lot à rejeter'))
await as(qual, () => rpc('quality_inspection_decide', insR, 'rejected', 'Rejet test traçabilité'))
const corr = await q(`select action, correlation_id from audit_logs where entity_id in ($1, (select id::text from quality_nonconformities where inspection_id=$2)) and action in ('quality.inspection_decide','quality.nc_open')`, [insR, insR])
ok('une décision qui écrit plusieurs lignes : même correlation_id', corr.length === 2 && corr[0].correlation_id === corr[1].correlation_id, JSON.stringify(corr.map((c) => c.action)))
const hdr = 'b0a1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'
await db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-correlation-id': hdr })])
const po3 = await as(fin, () => rpc('payment_order_prepare', sup, 50, 'Avec en-tête'))
await db.query(`select set_config('request.headers', '', false)`)
ok('en-tête x-correlation-id repris', (await q(`select correlation_id::text c from audit_logs where entity_id=$1`, [po3.id]))[0].c === hdr)

// --- D. Version : rang par entité ----------------------------------------------------------------------------------------------------------------
const vers = (await q(`select entity_version v from audit_logs where entity_type='payment_order' and entity_id=$1 order by id`, [po.id])).map((r) => r.v)
ok('version : prépare = 1, approuve = 2 (rang par entité)', vers.join() === '1,2', vers.join())

// --- E. Significatif : décisions oui, mise à jour courante non -------------------------------------------------------------------------------
await db.query(`select private.write_audit($1, 'client.update', 'client', 'c-1', 'Client test', '{"name":"A"}'::jsonb, '{"name":"B"}'::jsonb, '{}'::jsonb, 'rpc')`, [company])
ok('mise à jour courante : non significative', (await q(`select significant from audit_logs where action='client.update'`))[0].significant === false)

// --- F. Minimisation à l'écriture : secrets et données bancaires jamais stockés -----------------------------------------------------------
await db.query(`select private.write_audit($1, 'user.update', 'user', 'u-1', 'Compte test', '{"password":"SECRET-123","iban":"TN5900000000000000000000"}'::jsonb, '{"password":"NOUVEAU-456","name":"Ok"}'::jsonb, '{"api_key":"KEY-789"}'::jsonb, 'rpc')`, [company])
const sec = (await q(`select after_data, before_data, metadata from audit_logs where action='user.update'`))[0]
ok('secrets masqués à l’écriture (mot de passe, IBAN, clé API)', sec.after_data.password === '[masqué]' && sec.before_data.iban === '[masqué]' && sec.metadata.api_key === '[masqué]' && sec.after_data.name === 'Ok')
ok('aucun secret en clair dans le journal', (await q(`select count(*)::int n from audit_logs where after_data::text like '%NOUVEAU-456%' or before_data::text like '%SECRET-123%' or metadata::text like '%KEY-789%'`))[0].n === 0)

// --- G. Minimisation à la lecture : actions de coût cachées sans costs.read ; prix masqués dans les autres actions -----------------------
await db.query(`select private.write_audit($1, 'material.price_update', 'material', $2, 'Tissu', '{"unit_price":9.5}'::jsonb, '{"unit_price":10.25}'::jsonb, '{}'::jsonb, 'rpc')`, [company, mat])
await db.query(`select private.write_audit($1, 'quote.update', 'quote', 'Q-1', 'Devis test', '{"unit_price":11}'::jsonb, '{"unit_price":12}'::jsonb, '{}'::jsonb, 'rpc')`, [company])
ok('action de coût : absente de la recherche pour qui n’a pas costs.read', (await as(vis, () => q(`select id from audit_search(p_scope => 'material.price_update')`))).length === 0)
ok('action de coût : visible pour qui a costs.read', Number((await as(admin, () => q(`select after_data from audit_search(p_scope => 'material.price_update')`)))[0].after_data.unit_price) === 10.25)
ok('autre action : prix masqué pour qui n’a pas costs.read', (await as(vis, () => q(`select after_data from audit_search(p_scope => 'quote.update')`)))[0].after_data.unit_price === '[masqué]')
ok('autre action : prix visible pour qui a costs.read', Number((await as(admin, () => q(`select after_data from audit_search(p_scope => 'quote.update')`)))[0].after_data.unit_price) === 12)

// --- H. Protection : ni modification ni suppression par les utilisateurs métier ----------------------------------------------------
await rejects('utilisateur admin : modification du journal refusée', () => as(admin, () => db.query(`update audit_logs set action='x' where id = (select min(id) from audit_logs)`)), 'permission denied')
await rejects('utilisateur admin : suppression du journal refusée', () => as(admin, () => db.query(`delete from audit_logs`)), 'permission denied')
await rejects('utilisateur : insertion directe dans le journal refusée', () => as(admin, () => db.query(`insert into audit_logs(action, entity_type) values ('forged','x')`)), 'permission denied')
await rejects('utilisateur : IP et navigateur non lisibles directement', () => as(admin, () => q(`select ip from audit_logs limit 1`)), 'permission denied')
ok('historique par module : avant/après lisibles directement avec le droit de lecture', (await as(admin, () => q(`select before_data from audit_logs where action='client.update' limit 1`))).length === 1)
ok('action de coût : invisible en lecture directe sans costs.read', (await as(vis, () => q(`select id from audit_logs where action='material.price_update'`))).length === 0)
ok('action de coût : visible en lecture directe avec costs.read', (await as(admin, () => q(`select id from audit_logs where action='material.price_update'`))).length >= 1)
await rejects('même le propriétaire ne peut pas modifier le journal (trigger)', () => db.query(`update audit_logs set action='x' where id = (select min(id) from audit_logs)`), 'AUDIT_IMMUTABLE')

// --- I. Export auditeur -----------------------------------------------------------------------------------------------------------------------
await rejects('export refusé sans audit.export', () => as(vis, () => q(`select id from audit_export()`)), 'RBAC_FORBIDDEN')
const before = (await q(`select count(*)::int n from audit_logs where action='audit.export'`))[0].n
const exp = await as(admin, () => q(`select id, ip, user_agent from audit_export(p_scope => 'payment_order.')`))
ok('export auditeur : lignes produites (périmètre payment_order.)', exp.length >= 2, String(exp.length))
const after = (await q(`select count(*)::int n from audit_logs where action='audit.export'`))[0].n
ok('export journalisé (audit.export, significatif)', after === before + 1 && (await q(`select significant from audit_logs where action='audit.export' order by id desc limit 1`))[0].significant === true)

// --- J. Périmètres, pagination, isolation entre sociétés ------------------------------------------------------------------------------------
ok('périmètre « payment_order. » : que des actions de paiement', (await as(admin, () => q(`select action from audit_search(p_scope => 'payment_order.')`))).every((r) => r.action.startsWith('payment_order.')))
ok('périmètre exact : seulement payment_order.approve', (await as(admin, () => q(`select action from audit_search(p_scope => 'payment_order.approve')`))).every((r) => r.action === 'payment_order.approve'))
ok('pagination : limite respectée', (await as(admin, () => q(`select id from audit_search(p_limit => 2)`))).length === 2)
const other = (await q(`insert into companies(name, country) values ('Autre','TN') returning id`))[0].id
await db.query(`select private.write_audit($1, 'client.update', 'client', 'c-x', 'Client autre', null, null, '{}'::jsonb, 'rpc')`, [other])
ok('isolation : une entrée d’une autre société n’apparaît pas', (await as(admin, () => q(`select id from audit_search(p_entity_id => 'c-x')`))).length === 0)
ok('recherche par acteur délégué : filtre par e-mail', (await as(admin, () => q(`select id from audit_search(p_actor => 'fin2@x.com', p_significant => true)`))).length >= 1)
