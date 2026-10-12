import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

// --- Données de test ---------------------------------------------------
const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0]?.id
const mkUser = async (email) => (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
const give = (u, r) => db.query(`insert into user_roles values ($1,$2)`, [u, r])

const admin = await mkUser('admin@x.com');   await give(admin, await role('admin'))
const admin2 = await mkUser('admin2@x.com'); await give(admin2, await role('admin'))
const comm = await mkUser('comm@x.com');     await give(comm, await role('commercial'))
const nobody = await mkUser('nobody@x.com')

// --- 1. Rôles système --------------------------------------------------
const sys = await q(`select code, label, is_system from roles order by code`)
const expected = ['achat', 'admin', 'commercial', 'direction', 'finance', 'magasin', 'production', 'qualite']
ok('8 rôles système exactement', JSON.stringify(sys.map((r) => r.code)) === JSON.stringify(expected), JSON.stringify(sys.map((r) => r.code)))
ok('tous marqués is_system', sys.every((r) => r.is_system))
ok('libellés FR (Qualité, Administrateur…)', sys.find((r) => r.code === 'qualite').label === 'Qualité' && sys.find((r) => r.code === 'admin').label === 'Administrateur')

// --- 2. Matrice par défaut ----------------------------------------------
const perms = async (code) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [code])).map((r) => r.code)
const total = (await q(`select count(*)::int n from permissions`))[0].n
ok('admin possède toutes les permissions', (await perms('admin')).length === total, `(${total})`)
const dir = await perms('direction')
ok('direction : lecture + approbations, aucune écriture métier', dir.includes('orders.confirm') && dir.includes('reports.read') && !dir.includes('orders.write') && !dir.includes('roles.write'))
const fin = await perms('finance')
ok('finance : factures/paiements oui, stock/production non', fin.includes('invoices.write') && fin.includes('payments.write') && !fin.includes('stock.write') && !fin.includes('production.write'))
ok('magasin : stock.write oui, invoices non', (await perms('magasin')).includes('stock.write') && !(await perms('magasin')).includes('invoices.read'))
ok('qualité : quality.approve oui', (await perms('qualite')).includes('quality.approve'))
ok('seuls admin (et direction en lecture) accèdent à l’audit', (await perms('commercial')).every((c) => c !== 'audit.read'))

// --- 3. Hook JWT --------------------------------------------------------
const hook = (await q(`select public.custom_access_token_hook($1::jsonb) r`, [JSON.stringify({ user_id: comm, claims: { role: 'authenticated' } })]))[0].r
ok('hook : app_permissions & app_roles', hook.claims.app_permissions.includes('orders.write') && hook.claims.app_roles[0] === 'commercial' && hook.claims.role === 'authenticated')

// --- 4. Droits d'appel ---------------------------------------------------
await rejects('commercial ne peut pas créer de rôle', () => as(comm, () => rpc('rbac_create_role', 'x_role', 'X')), 'RBAC_FORBIDDEN')
await rejects('utilisateur sans rôle refusé', () => as(nobody, () => rpc('rbac_set_user_roles', comm, [])), 'RBAC_FORBIDDEN')
let anonDenied = false
try { await db.exec(`set role anon; select public.rbac_create_role('a_b','x');`) } catch { anonDenied = true } finally { await db.exec('reset role') }
ok('anon ne peut pas appeler les RPC', anonDenied)

// --- 5. Gestion des rôles ----------------------------------------------
const newRole = await as(admin, () => rpc('rbac_create_role', 'controle', 'Contrôle interne', 'Rôle de test'))
ok('création d’un rôle personnalisé', !!newRole)
await rejects('code de rôle invalide refusé', () => as(admin, () => rpc('rbac_create_role', 'Bad Code!', 'X')), 'RBAC_INVALID_CODE')
await rejects('doublon refusé', () => as(admin, () => rpc('rbac_create_role', 'controle', 'Autre')), 'RBAC_DUPLICATE')
await as(admin, () => rpc('rbac_update_role', newRole, 'Contrôle interne v2', 'Desc'))
ok('mise à jour du rôle', (await q(`select label from roles where id=$1`, [newRole]))[0].label === 'Contrôle interne v2')
const sysAdminRole = await role('admin')
const qualiteRole = await role('qualite')
await as(admin, () => rpc('rbac_update_role', qualiteRole, 'Hack', 'Nouvelle description'))
ok('libellé d’un rôle système verrouillé (description modifiable)', (await q(`select label, description from roles where code='qualite'`))[0].label === 'Qualité')

const setPerms = (r, codes) => rpc('rbac_set_role_permissions', r, codes)
const res = await as(admin, () => setPerms(newRole, ['orders.read', 'clients.read', 'reports.read']))
ok('permissions affectées (added)', res.added.length === 3 && res.removed.length === 0)
const res2 = await as(admin, () => setPerms(newRole, ['orders.read', 'stock.read']))
ok('diff : ajout + retrait', res2.added.join() === 'stock.read' && res2.removed.join() === 'clients.read,reports.read')
await rejects('permission inconnue refusée', () => as(admin, () => setPerms(newRole, ['nope.do'])), 'RBAC_UNKNOWN_PERMISSION')
await rejects('admin garde roles.write (anti-verrouillage)', () => as(admin, () => setPerms(sysAdminRole, ['orders.read'])), 'RBAC_ADMIN_PROTECTED')

// --- 6. Anti-escalade ----------------------------------------------------
const delegate = await mkUser('delegate@x.com')
const delegRole = await as(admin, () => rpc('rbac_create_role', 'delegue', 'Délégué RBAC'))
await as(admin, () => setPerms(delegRole, ['roles.read', 'roles.write', 'roles.assign', 'users.read', 'audit.read', 'orders.read']))
await as(admin, () => rpc('rbac_set_user_roles', delegate, [delegRole]))
await rejects('escalade : ne peut accorder une permission qu’il n’a pas', () => as(delegate, () => setPerms(newRole, ['orders.read', 'invoices.write'])), 'RBAC_ESCALATION')
const financeRole = await role('finance')
await rejects('escalade : rôle finance non affectable sans ses permissions', () => as(delegate, () => rpc('rbac_set_user_roles', nobody, [financeRole])), 'RBAC_ESCALATION')
await rejects('escalade : rôle contenant stock.read non affectable', () => as(delegate, () => rpc('rbac_set_user_roles', nobody, [newRole])), 'RBAC_ESCALATION')
await as(admin, () => setPerms(newRole, ['orders.read']))
const okGrant = await as(delegate, () => rpc('rbac_set_user_roles', nobody, [newRole]))
ok('affectation autorisée si permissions détenues', okGrant.roles.includes('controle'))

// --- 7. Dernier administrateur / auto-désactivation ----------------------
await db.query(`delete from user_roles where user_id=$1 and role_id=$2`, [admin2, sysAdminRole])   // il ne reste qu'un admin
await rejects('dernier admin : retrait du rôle refusé', () => as(admin, () => rpc('rbac_set_user_roles', admin, [])), 'RBAC_LAST_ADMIN')
await rejects('dernier admin : désactivation refusée', () => as(admin, () => rpc('rbac_set_user_active', admin, false)), 'RBAC_SELF')
await rejects('dernier admin désactivé par un autre acteur refusé', async () => {
  const tmp = await mkUser('tmp@x.com'); await give(tmp, delegRole)
  await as(admin, () => setPerms(delegRole, ['roles.read', 'roles.write', 'roles.assign', 'users.read', 'users.write', 'audit.read']))
  await as(tmp, () => rpc('rbac_set_user_active', admin, false))
}, 'RBAC_LAST_ADMIN')
await give(admin2, sysAdminRole)

// --- 8. Désactivation : sessions révoquées + audit -----------------------
await db.query(`insert into auth.sessions(user_id) values ($1),($1)`, [comm])
await as(admin, () => rpc('rbac_set_user_active', comm, false))
ok('désactivation : profil inactif', (await q(`select is_active from profiles where id=$1`, [comm]))[0].is_active === false)
ok('désactivation : sessions supprimées', (await q(`select count(*)::int n from auth.sessions where user_id=$1`, [comm]))[0].n === 0)
await as(admin, () => rpc('rbac_set_user_active', comm, true))

const n = await as(admin, () => rpc('rbac_revoke_user_sessions', comm))
ok('rbac_revoke_user_sessions renvoie un nombre', n === 0)
await rejects('révocation de sessions réservée à sessions.manage', () => as(delegate, () => rpc('rbac_revoke_user_sessions', comm)), 'RBAC_FORBIDDEN')

// --- 9. Suppression de rôle ---------------------------------------------
await rejects('suppression d’un rôle système refusée', () => as(admin, () => rpc('rbac_delete_role', sysAdminRole)), 'RBAC_SYSTEM_ROLE')
await rejects('suppression d’un rôle utilisé refusée', () => as(admin, () => rpc('rbac_delete_role', newRole)), 'RBAC_ROLE_IN_USE')
await as(admin, () => rpc('rbac_set_user_roles', nobody, []))
await as(admin, () => rpc('rbac_delete_role', newRole))
ok('suppression d’un rôle personnalisé inutilisé', (await q(`select count(*)::int n from roles where id=$1`, [newRole]))[0].n === 0)

// --- 10. Isolation multi-société -----------------------------------------
const c2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const foreignRole = (await q(`insert into roles(company_id, code, label) values ($1,'etranger','Étranger') returning id`, [c2]))[0].id
await rejects('rôle d’une autre société introuvable', () => as(admin, () => setPerms(foreignRole, ['orders.read'])), 'RBAC_NOT_FOUND')
ok('rôles d’une autre société invisibles (RLS)', (await as(admin, async () => (await q(`select id from roles where id=$1`, [foreignRole])))).length === 0)

// --- 11. Audit -----------------------------------------------------------
const audit = await q(`select action, entity_type, entity_label, actor_email, source, metadata, before_data, after_data from audit_logs order by id`)
const has = (a) => audit.some((r) => r.action === a)
for (const a of ['role.create', 'role.update', 'role.delete', 'role.permissions_update', 'user.roles_update', 'user.deactivate', 'user.activate', 'user.sessions_revoked', 'user.create'])
  ok(`audit : ${a}`, has(a))
const perm = audit.find((r) => r.action === 'role.permissions_update' && r.entity_label.startsWith('Contr'))
ok('audit : actor_email + source rpc + diff added/removed', perm.actor_email === 'admin@x.com' && perm.source === 'rpc' && Array.isArray(perm.metadata.added))
ok('audit : before/after des permissions', Array.isArray(perm.before_data.permissions) && Array.isArray(perm.after_data.permissions))
const del = audit.find((r) => r.action === 'role.delete')
ok('audit : suppression garde l’état précédent et les permissions', del.before_data.code === 'controle' && Array.isArray(del.metadata.permissions))
const nAggregated = audit.filter((r) => r.action === 'role.permission_grant' && r.actor_email).length
ok('audit : pas de bruit ligne-à-ligne pour les RPC', nAggregated === 0)

// écritures hors RPC (service_role / SQL) : audit ligne à ligne
const before = audit.length
await db.query(`insert into role_permissions select $1, id from permissions where code='quality.read'`, [await role('commercial')])
await db.query(`delete from role_permissions rp using permissions p where p.id=rp.permission_id and p.code='quality.read' and rp.role_id=$1`, [await role('commercial')])
await db.query(`insert into user_roles values ($1,$2)`, [nobody, await role('achat')])
await db.query(`delete from user_roles where user_id=$1 and role_id=$2`, [nobody, await role('achat')])
const extra = (await q(`select action, source, actor_id from audit_logs where id > (select max(id) - 4 from audit_logs) order by id`)).map((r) => r.action)
ok('audit direct : grant/revoke permission + assign/revoke rôle', extra.join() === 'role.permission_grant,role.permission_revoke,user.role_assign,user.role_revoke', extra.join())

await db.query(`update profiles set last_sign_in_at = now() where id=$1`, [admin])
ok('audit : last_sign_in_at ne génère pas d’entrée', (await q(`select count(*)::int n from audit_logs`))[0].n === before + 4)

// --- 12. Immutabilité & accès ---------------------------------------------
await rejects('audit_logs : UPDATE interdit (même propriétaire)', () => db.query(`update audit_logs set action='x'`), 'AUDIT_IMMUTABLE')
await rejects('audit_logs : DELETE interdit', () => db.query(`delete from audit_logs`), 'AUDIT_IMMUTABLE')
await rejects('audit_logs : TRUNCATE interdit', () => db.query(`truncate audit_logs`), 'AUDIT_IMMUTABLE')
await rejects('authenticated ne peut pas forger une entrée', () => as(admin, () => db.query(`insert into audit_logs(action, entity_type) values ('fake','x')`)), 'permission denied')
await rejects('authenticated ne peut pas appeler write_audit', () => as(admin, () => db.query(`select private.write_audit(null,'a','b',null,null,null,null)`)), 'permission denied')
ok('audit lisible avec audit.read', (await as(admin, () => q(`select id from audit_logs limit 1`))).length === 1)
ok('audit invisible sans audit.read', (await as(comm, () => q(`select id from audit_logs limit 1`))).length === 0)
ok('audit invisible pour une autre société', (await as(admin, () => q(`select id from audit_logs where company_id=$1`, [c2]))).length === 0)

// --- 13. Cohérence catalogue TS ↔ SQL --------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.resolve(here, '../../src/lib/rbac/permissions.ts'), 'utf8')
const tsCodes = [...src.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1])
const dbCodes = new Set((await q(`select code from permissions`)).map((r) => r.code))
const missing = tsCodes.filter((c) => !dbCodes.has(c))
ok('catalogue TypeScript = catalogue SQL', tsCodes.length >= dbCodes.size - 0 && missing.length === 0, missing.join())
const notInTs = [...dbCodes].filter((c) => !tsCodes.includes(c))
ok('aucune permission SQL absente du catalogue TypeScript', notInTs.length === 0, notInTs.join())
