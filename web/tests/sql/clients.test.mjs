import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)

// --- Acteurs -----------------------------------------------------------
const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')
const comm = await mkUser('comm@x.com', 'commercial')
const comm2 = await mkUser('comm2@x.com', 'commercial')
const fin = await mkUser('fin@x.com', 'finance')
const prod = await mkUser('prod@x.com', 'production')
const direction = await mkUser('dir@x.com', 'direction')
const nobody = await mkUser('nobody@x.com')

const base = (o = {}) => ({ name: 'Engie Workwear', country: 'FR', currency: 'EUR', ...o })
const insertClient = (u, c) => as(u, async () => (await q(
  `insert into clients (name, country, currency, tax_id, sales_rep_id, payment_terms_id, incoterm, email) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
  [c.name, c.country, c.currency, c.tax_id ?? null, c.sales_rep_id ?? null, c.payment_terms_id ?? null, c.incoterm ?? null, c.email ?? null]))[0])

// --- 1. Conditions de paiement ----------------------------------------------
const terms = await q(`select id, code, days, end_of_month from payment_terms order by sort_order`)
ok('8 conditions de paiement seedées', terms.length === 8 && terms.some((t) => t.code === '60FDM' && t.end_of_month))
ok('conditions visibles par un utilisateur de la société', (await as(comm, () => q(`select id from payment_terms`))).length === 8)
const t60 = terms.find((t) => t.code === '60J').id

// --- 2. Création + droits ------------------------------------------------------
const c1 = await insertClient(comm, base({ tax_id: 'FR12345678901', sales_rep_id: comm, payment_terms_id: t60, incoterm: 'DAP', email: 'achats@engie.com' }))
ok('code client généré automatiquement (CLI-0001)', c1.code === 'CLI-0001')
ok('company_id déduit de l’utilisateur', c1.company_id === company)
ok('created_by renseigné', c1.created_by === comm)
const c2 = await insertClient(comm, base({ name: 'Bragard Pro', country: 'fr' }))
ok('séquence : CLI-0002 ; pays normalisé en majuscules', c2.code === 'CLI-0002' && c2.country === 'FR')

await rejects('sans permission clients.write : insertion refusée', () => insertClient(fin, base({ name: 'Zéro droit' })), 'row-level security')
await rejects('utilisateur sans rôle : insertion refusée', () => insertClient(nobody, base({ name: 'Zéro droit 2' })), 'row-level security')
await rejects('nom en doublon (client actif) refusé', () => insertClient(comm, base({ name: ' engie workwear ' })), 'clients_name_active_uq')
await rejects('identifiant fiscal en doublon refusé', () => insertClient(comm, base({ name: 'Autre société', tax_id: ' fr12345678901 ' })), 'clients_tax_id_uq')
await rejects('pays invalide refusé', () => as(comm, () => db.query(`insert into clients(name,country) values ('Pays KO','FRA')`)), 'too long')
await rejects('pays inconnu (format) refusé', () => as(comm, () => db.query(`insert into clients(name,country) values ('Pays KO2','f1')`)), 'country')
await rejects('devise invalide refusée', () => insertClient(comm, base({ name: 'Devise KO', currency: 'EU' })), 'currency')
await rejects('incoterm invalide refusé', () => insertClient(comm, base({ name: 'Incoterm KO', incoterm: 'XYZ' })), 'incoterm')
await rejects('e-mail invalide refusé', () => insertClient(comm, base({ name: 'Mail KO', email: 'pas-un-mail' })), 'email')
await rejects('commercial affecté inexistant refusé', () => insertClient(comm, base({ name: 'Rep KO', sales_rep_id: '00000000-0000-4000-8000-0000000000ff' })), 'CLIENT_INVALID_REP')

// --- 3. Lecture / isolation ---------------------------------------------------
ok('commercial voit ses clients', (await as(comm, () => q(`select id from clients`))).length === 2)
ok('finance (clients.read par défaut) voit les clients en lecture', (await as(fin, () => q(`select id from clients`))).length === 2)
ok('production (sans clients.read) ne voit rien', (await as(prod, () => q(`select id from clients`))).length === 0)
ok('direction voit tout (lecture)', (await as(direction, () => q(`select id from clients`))).length === 2)
const c2co = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const foreign = (await q(`insert into clients(company_id,name,country) values ($1,'Client étranger','DE') returning id`, [c2co]))[0].id
ok('isolation entre sociétés (RLS)', (await as(admin, () => q(`select id from clients where id=$1`, [foreign]))).length === 0)

// --- 4. Mise à jour, colonnes protégées ----------------------------------------
await as(comm, () => db.query(`update clients set phone='+33 1 00 00 00 00', credit_limit=50000.5 where id=$1`, [c1.id]))
ok('mise à jour autorisée (clients.write)', (await q(`select phone from clients where id=$1`, [c1.id]))[0].phone.startsWith('+33'))
ok('updated_by renseigné', (await q(`select updated_by from clients where id=$1`, [c1.id]))[0].updated_by === comm)
await rejects('code non modifiable (privilège de colonne)', () => as(comm, () => db.query(`update clients set code='HACK' where id=$1`, [c1.id])), 'permission denied')
await rejects('archivage direct interdit (privilège de colonne)', () => as(comm, () => db.query(`update clients set archived_at=now() where id=$1`, [c1.id])), 'permission denied')
await rejects('suppression directe interdite', () => as(admin, () => db.query(`delete from clients where id=$1`, [c1.id])), 'permission denied')
await rejects('direction (lecture seule) ne peut pas modifier', async () => {
  const r = await as(direction, () => db.query(`update clients set phone='x' where id=$1`, [c1.id]))
  if (r.affectedRows === 0) throw new Error('row-level security: 0 ligne')
}, 'row-level security')
await rejects('commercial affecté d’une autre société refusé', async () => {
  const other = (await q(`insert into auth.users(email, raw_app_meta_data) values ('x@other.com', $1) returning id`, [JSON.stringify({ company_id: c2co })]))[0].id
  await as(comm, () => db.query(`update clients set sales_rep_id=$1 where id=$2`, [other, c1.id]))
}, 'CLIENT_INVALID_REP')
await as(comm, () => db.query(`update clients set sales_rep_id=$1 where id=$2`, [comm2, c1.id]))
ok('changement de commercial affecté', (await q(`select sales_rep_id from clients where id=$1`, [c1.id]))[0].sales_rep_id === comm2)

// annuaire + commerciaux affectables
const dir = await as(comm, () => q(`select id, full_name from company_directory`))
ok('annuaire : visible pour la société uniquement', dir.length === 7 && dir.some((d) => d.id === comm2))
const reps = await as(comm, () => q(`select * from public.client_sales_reps()`))
ok('commerciaux affectables = détenteurs de clients.write', reps.length === 3 && reps.some((r) => r.id === comm) && !reps.some((r) => r.id === fin))
await rejects('client_sales_reps réservé à clients.read', () => as(prod, () => q(`select * from public.client_sales_reps()`)), 'RBAC_FORBIDDEN')

// --- 5. Contacts ----------------------------------------------------------------
const addContact = (u, cid, c) => as(u, async () => (await q(
  `insert into client_contacts (client_id, full_name, email, is_primary, job_title) values ($1,$2,$3,$4,$5) returning *`, [cid, c.name, c.email ?? null, c.primary ?? false, c.title ?? null]))[0])
const k1 = await addContact(comm, c1.id, { name: 'Alice Martin', email: 'alice@engie.com', title: 'Acheteuse' })
ok('premier contact = principal automatiquement', k1.is_primary === true && k1.company_id === company)
const k2 = await addContact(comm, c1.id, { name: 'Bob Durand' })
ok('second contact non principal', k2.is_primary === false)
await as(comm, () => db.query(`update client_contacts set is_primary=true where id=$1`, [k2.id]))
const prim = await q(`select full_name from client_contacts where client_id=$1 and is_primary`, [c1.id])
ok('un seul contact principal (bascule)', prim.length === 1 && prim[0].full_name === 'Bob Durand')
await rejects('contact : e-mail invalide', () => addContact(comm, c1.id, { name: 'Mail KO', email: 'nope' }), 'email')
await rejects('contact : écriture refusée sans clients.write', () => addContact(fin, c1.id, { name: 'Intrus' }), 'row-level security')
ok('contacts invisibles sans clients.read', (await as(prod, () => q(`select id from client_contacts`))).length === 0)
await rejects('contact rattaché à un client d’une autre société refusé', () => addContact(comm, foreign, { name: 'Intrus 2' }), 'row-level security')
await as(comm, () => db.query(`delete from client_contacts where id=$1`, [k1.id]))
ok('suppression d’un contact', (await q(`select id from client_contacts where client_id=$1`, [c1.id])).length === 1)

// --- 6. Adresses ----------------------------------------------------------------
const addAddr = (u, cid, a) => as(u, async () => (await q(
  `insert into client_addresses (client_id, type, line1, city, country, postal_code, is_default) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
  [cid, a.type, a.line1, a.city, a.country ?? 'FR', a.zip ?? null, a.def ?? false]))[0])
const a1 = await addAddr(comm, c1.id, { type: 'billing', line1: '1 rue de la Paix', city: 'Paris', zip: '75002' })
ok('première adresse du type = par défaut', a1.is_default === true)
const a2 = await addAddr(comm, c1.id, { type: 'billing', line1: '2 av. Foch', city: 'Lyon', def: true })
const defs = await q(`select city from client_addresses where client_id=$1 and type='billing' and is_default`, [c1.id])
ok('une seule adresse par défaut par type', defs.length === 1 && defs[0].city === 'Lyon')
const a3 = await addAddr(comm, c1.id, { type: 'delivery', line1: 'Zone Indus. 4', city: 'Lille' })
ok('adresse de livraison par défaut indépendante', a3.is_default === true && (await q(`select count(*)::int n from client_addresses where client_id=$1 and is_default`, [c1.id]))[0].n === 2)
await rejects('adresse : type invalide', () => addAddr(comm, c1.id, { type: 'autre', line1: 'x yz', city: 'Y' }), 'type')
await rejects('adresse : pays invalide', () => addAddr(comm, c1.id, { type: 'other', line1: 'rue test', city: 'Y', country: 'FRA' }), 'too long')

// --- 8. Archivage / restauration / suppression ---------------------------------------
await rejects('archivage réservé à clients.delete (commercial refusé)', () => as(comm, () => rpc('client_archive', c2.id, 'test')), 'RBAC_FORBIDDEN')
await as(direction, () => rpc('client_archive', c2.id, 'Contrat terminé'))
const arch = (await q(`select archived_at, archived_by, archive_reason from clients where id=$1`, [c2.id]))[0]
ok('archivage : date, auteur et motif', arch.archived_at && arch.archived_by === direction && arch.archive_reason === 'Contrat terminé')
await rejects('client archivé : modification refusée', () => as(comm, () => db.query(`update clients set phone='1' where id=$1`, [c2.id])), 'CLIENT_ARCHIVED')
await rejects('client archivé : ajout de contact refusé', () => addContact(comm, c2.id, { name: 'Trop tard' }), 'CLIENT_ARCHIVED')
await rejects('déjà archivé', () => as(direction, () => rpc('client_archive', c2.id, null)), 'CLIENT_ARCHIVED')
await rejects('suppression définitive : seulement si archivé', () => as(direction, () => rpc('client_delete', c1.id)), 'CLIENT_NOT_ARCHIVED')
ok('un client archivé libère son nom (réutilisable)', !!(await insertClient(comm, base({ name: 'Bragard Pro' }))))
await rejects('restauration refusée si un client actif porte déjà le nom', () => as(direction, () => rpc('client_restore', c2.id)), 'clients_name_active_uq')
await as(admin, () => db.query(`select 1`))
await db.query(`update clients set name='Bragard Pro (ancien)' where id=$1`, [c2.id]).catch(() => {})
await db.exec(`alter table clients disable trigger clients_before_iu; update clients set name='Bragard Pro (ancien)' where id='${c2.id}'; alter table clients enable trigger clients_before_iu;`)
await as(direction, () => rpc('client_restore', c2.id))
ok('restauration', (await q(`select archived_at from clients where id=$1`, [c2.id]))[0].archived_at === null)
await rejects('restauration : déjà actif', () => as(direction, () => rpc('client_restore', c2.id)), 'CLIENT_NOT_ARCHIVED')

// suppression définitive
await as(direction, () => rpc('client_archive', c1.id, 'Doublon'))
await db.query(`insert into auth.users(email, raw_app_meta_data) values ('portal@x.com', $1)`, [JSON.stringify({ user_type: 'client', client_id: c1.id })])
await rejects('suppression refusée si un utilisateur portail est rattaché', () => as(direction, () => rpc('client_delete', c1.id)), 'CLIENT_IN_USE')
await db.query(`delete from auth.users where email='portal@x.com'`)
const del = await as(direction, () => rpc('client_delete', c1.id))
ok('suppression définitive (cascade) + comptage', del.contacts === 1 && del.addresses === 3 && del.documents === 0, JSON.stringify(del))
ok('lignes supprimées', (await q(`select count(*)::int n from clients where id=$1`, [c1.id]))[0].n === 0 && (await q(`select count(*)::int n from client_contacts where client_id=$1`, [c1.id]))[0].n === 0)

// --- 9. Historique ---------------------------------------------------------------------
const hist = (id) => q(`select action, entity_type, entity_label, actor_email, before_data, after_data, metadata from audit_logs where entity_type='client' and entity_id=$1 order by id`, [id])
const h1 = await hist(c1.id)
const acts = h1.map((r) => r.action)
for (const a of ['client.create', 'client.update', 'client.contact_create', 'client.contact_update', 'client.contact_delete', 'client.address_create', 'client.archive', 'client.delete'])
  ok(`historique : ${a}`, acts.includes(a))
const upd = h1.filter((r) => r.action === 'client.update')
ok('historique : seuls les champs modifiés (avant/après)', upd.some((r) => r.after_data.phone && r.after_data.credit_limit !== undefined && !('name' in r.after_data) && r.before_data.phone === null))
ok('historique : changement de commercial tracé', upd.some((r) => r.after_data.sales_rep_id === comm2 && r.before_data.sales_rep_id === comm))
ok('historique : acteur et libellé du client', upd[0].actor_email === 'comm@x.com' && upd[0].entity_label === 'Engie Workwear')
ok('historique : contact nommé dans les métadonnées', h1.find((r) => r.action === 'client.contact_create').metadata.contact === 'Alice Martin')
ok('historique : archivage avec motif', h1.find((r) => r.action === 'client.archive').metadata.reason === 'Doublon')
ok('historique : suppression définitive avec comptage', h1.find((r) => r.action === 'client.delete').metadata.contacts === 1)
ok('historique : pas de bruit sur created_at/updated_by', upd.every((r) => !('updated_at' in r.after_data) && !('updated_by' in r.after_data)))
ok('historique lisible avec clients.read (sans audit.read)', (await as(direction, () => q(`select id from audit_logs where entity_type='client' and entity_id=$1`, [c2.id]))).length >= 2)
ok('historique illisible sans clients.read', (await as(prod, () => q(`select id from audit_logs where entity_type='client'`))).length === 0)
ok('historique : utilisateurs d’une autre société exclus', (await as(admin, () => q(`select id from audit_logs where entity_id=$1`, [foreign]))).length === 0)

// --- 10. Cohérence globale ---------------------------------------------------------------
ok('rôle direction : clients.delete accordé, clients.write non', await (async () => {
  const p = (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='direction'`)).map((r) => r.code)
  return p.includes('clients.delete') && !p.includes('clients.write')
})())
ok('audit_logs reste en ajout seul', await (async () => { try { await db.query(`delete from audit_logs`); return false } catch (e) { return e.message.includes('AUDIT_IMMUTABLE') } })())
