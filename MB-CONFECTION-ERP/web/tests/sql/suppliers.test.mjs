import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql', '0002_auth_seed.sql', '0003_rbac_audit.sql', '0004_clients.sql', '0005_ged.sql', '0006_suppliers.sql'])
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
const buyer = await mkUser('achat@x.com', 'achat')
const buyer2 = await mkUser('achat2@x.com', 'achat')
const direction = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('comm@x.com', 'commercial')
const prod = await mkUser('prod@x.com', 'production')
const fin = await mkUser('fin@x.com', 'finance')

// --- Permissions -----------------------------------------------------------------------
const perms = async (c) => (await q(`select p.code from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code=$1`, [c])).map((r) => r.code)
ok('suppliers.delete : admin et direction uniquement', (await perms('admin')).includes('suppliers.delete') && (await perms('direction')).includes('suppliers.delete') && !(await perms('achat')).includes('suppliers.delete'))
ok('achat : lecture + écriture fournisseurs et achats', (await perms('achat')).includes('suppliers.write') && (await perms('achat')).includes('purchases.write'))

const terms = await q(`select id, code from payment_terms`)
const t60 = terms.find((t) => t.code === '60J').id
const ins = (u, o) => as(u, async () => (await q(
  `insert into suppliers (name, country, currency, category, tax_id, buyer_id, payment_terms_id, lead_time_days, incoterm, incoterm_place, email, rating, qualification)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
  [o.name, o.country ?? 'IT', o.currency ?? 'EUR', o.category ?? 'fabric', o.tax_id ?? null, o.buyer ?? null, o.terms ?? null, o.lead ?? null, o.incoterm ?? null, o.place ?? null, o.email ?? null, o.rating ?? null, o.qual ?? 'pending']))[0])

// --- 1. Création ----------------------------------------------------------------------------
const s1 = await ins(buyer, { name: 'Tessitura Rossi', tax_id: 'IT01234567890', buyer, terms: t60, lead: 21, incoterm: 'FCA', place: 'Prato', email: 'ventes@rossi.it', rating: 4 })
ok('code généré automatiquement (FOU-0001)', s1.code === 'FOU-0001')
ok('société, créateur, délai, incoterm, lieu', s1.company_id === company && s1.created_by === buyer && s1.lead_time_days === 21 && s1.incoterm === 'FCA' && s1.incoterm_place === 'Prato')
const s2 = await ins(buyer, { name: 'Boutons Express', country: 'tn', currency: 'TND', category: 'accessories' })
ok('FOU-0002 ; pays normalisé', s2.code === 'FOU-0002' && s2.country === 'TN')
ok('qualification initiale : en attente', s1.qualification === 'pending')

await rejects('création refusée sans suppliers.write', () => ins(prod, { name: 'Intrus' }), 'row-level security')
await rejects('doublon de nom actif refusé', () => ins(buyer, { name: ' tessitura rossi ' }), 'suppliers_name_active_uq')
await rejects('doublon d’identifiant fiscal refusé', () => ins(buyer, { name: 'Autre', tax_id: ' it01234567890' }), 'suppliers_tax_id_uq')
await rejects('délai > 365 jours refusé', () => ins(buyer, { name: 'Lent', lead: 400 }), 'lead_time_days')
await rejects('note hors 1..5 refusée', () => ins(buyer, { name: 'Note KO', rating: 7 }), 'rating')
await rejects('incoterm invalide refusé', () => ins(buyer, { name: 'Inco KO', incoterm: 'ZZZ' }), 'incoterm')
await rejects('catégorie invalide refusée', () => ins(buyer, { name: 'Cat KO', category: 'magie' }), 'category')
await rejects('acheteur inexistant refusé', () => ins(buyer, { name: 'Ach KO', buyer: uuid() }), 'SUPPLIER_INVALID_BUYER')
await rejects('e-mail invalide refusé', () => ins(buyer, { name: 'Mail KO', email: 'x' }), 'email')

// --- 2. Lecture / isolation -------------------------------------------------------------------
ok('lecture : achat, direction, finance, magasin voient', (await as(direction, () => q(`select id from suppliers`))).length === 2 && (await as(fin, () => q(`select id from suppliers`))).length === 2)
ok('commercial et production (sans suppliers.read) ne voient rien', (await as(comm, () => q(`select id from suppliers`))).length === 0 && (await as(prod, () => q(`select id from suppliers`))).length === 0)
const co2 = (await q(`insert into companies(name) values ('Autre') returning id`))[0].id
const foreign = (await q(`insert into suppliers(company_id,name,country) values ($1,'Étranger','DE') returning id`, [co2]))[0].id
ok('isolation entre sociétés', (await as(admin, () => q(`select id from suppliers where id=$1`, [foreign]))).length === 0)

// --- 3. Mise à jour / colonnes protégées ----------------------------------------------------------
await as(buyer, () => db.query(`update suppliers set lead_time_days=30, qualification='approved', min_order_amount=500, incoterm='DAP' where id=$1`, [s1.id]))
const u1 = (await q(`select * from suppliers where id=$1`, [s1.id]))[0]
ok('mise à jour : délai, qualification, minimum, incoterm', u1.lead_time_days === 30 && u1.qualification === 'approved' && Number(u1.min_order_amount) === 500 && u1.incoterm === 'DAP' && u1.updated_by === buyer)
await rejects('code immuable (privilège de colonne)', () => as(buyer, () => db.query(`update suppliers set code='X1' where id=$1`, [s1.id])), 'permission denied')
await rejects('archivage direct interdit', () => as(buyer, () => db.query(`update suppliers set archived_at=now() where id=$1`, [s1.id])), 'permission denied')
await rejects('suppression directe interdite', () => as(admin, () => db.query(`delete from suppliers where id=$1`, [s1.id])), 'permission denied')
await rejects('lecture seule (direction) : modification refusée', async () => {
  const r = await as(direction, () => db.query(`update suppliers set notes='x' where id=$1`, [s1.id]))
  if (r.affectedRows === 0) throw new Error('row-level security')
}, 'row-level security')
const reps = await as(buyer, () => q(`select * from public.supplier_buyers()`))
ok('acheteurs affectables = détenteurs de suppliers.write', reps.some((r) => r.id === buyer2) && reps.some((r) => r.id === admin) && !reps.some((r) => r.id === fin))
await rejects('supplier_buyers réservé à suppliers.read', () => as(comm, () => q(`select * from public.supplier_buyers()`)), 'RBAC_FORBIDDEN')
await as(buyer, () => db.query(`update suppliers set buyer_id=$2 where id=$1`, [s1.id, buyer2]))
ok('changement d’acheteur référent', (await q(`select buyer_id from suppliers where id=$1`, [s1.id]))[0].buyer_id === buyer2)

// --- 4. Contacts ------------------------------------------------------------------------------------------
const addContact = (u, sid, c) => as(u, async () => (await q(`insert into supplier_contacts(supplier_id, full_name, email, is_primary) values ($1,$2,$3,$4) returning *`, [sid, c.name, c.email ?? null, c.primary ?? false]))[0])
const c1 = await addContact(buyer, s1.id, { name: 'Marco Rossi', email: 'marco@rossi.it' })
const c2 = await addContact(buyer, s1.id, { name: 'Giulia Bianchi' })
ok('premier contact principal ; second non', c1.is_primary && !c2.is_primary)
await as(buyer, () => db.query(`update supplier_contacts set is_primary=true where id=$1`, [c2.id]))
ok('un seul contact principal (bascule)', (await q(`select full_name from supplier_contacts where supplier_id=$1 and is_primary`, [s1.id])).length === 1)
await rejects('contact : écriture refusée sans suppliers.write', () => addContact(fin, s1.id, { name: 'Intrus' }), 'row-level security')
await rejects('contact : e-mail invalide', () => addContact(buyer, s1.id, { name: 'Mail KO', email: 'zzz' }), 'email')
await as(buyer, () => db.query(`delete from supplier_contacts where id=$1`, [c1.id]))

// --- 5. Documents + stockage ----------------------------------------------------------------------------------
const path = `${company}/${s1.id}/${uuid()}-contrat.pdf`
const addDoc = (u, sid, p, o = {}) => as(u, async () => (await q(
  `insert into supplier_documents(supplier_id,title,doc_type,file_name,mime_type,size_bytes,storage_path,valid_until) values ($1,$2,'price_list','tarifs.pdf','application/pdf',$3,$4,$5) returning *`,
  [sid, o.title ?? 'Tarifs 2026', o.size ?? 2000, p, o.valid ?? null]))[0])
const d1 = await addDoc(buyer, s1.id, path)
ok('document : société et auteur déduits', d1.company_id === company && d1.uploaded_by === buyer)
await rejects('document : chemin d’un autre fournisseur refusé', () => addDoc(buyer, s1.id, `${company}/${s2.id}/${uuid()}-x.pdf`), 'SUPPLIER_INVALID_PATH')
await rejects('document : > 10 Mo refusé', () => addDoc(buyer, s1.id, `${company}/${s1.id}/${uuid()}-big.pdf`, { size: 20_000_000 }), 'size_bytes')
await rejects('document : refusé sans suppliers.write', () => addDoc(fin, s1.id, `${company}/${s1.id}/${uuid()}-f.pdf`), 'row-level security')
await rejects('document : chemin non modifiable', () => as(buyer, () => db.query(`update supplier_documents set storage_path='a/b/c' where id=$1`, [d1.id])), 'permission denied')
ok('bucket supplier-docs privé', (await q(`select public from storage.buckets where id='supplier-docs'`))[0].public === false)
const put = (u, n) => as(u, () => db.query(`insert into storage.objects(bucket_id,name) values ('supplier-docs',$1)`, [n]))
await put(buyer, path)
await rejects('storage : dépôt refusé sans suppliers.write', () => put(fin, `${company}/${s1.id}/${uuid()}-f.pdf`), 'row-level security')
await rejects('storage : dépôt refusé hors société', () => put(buyer, `${co2}/${foreign}/${uuid()}-f.pdf`), 'row-level security')
ok('storage : lecture avec suppliers.read (finance, sans clients.read requis)', (await as(fin, () => q(`select name from storage.objects where bucket_id='supplier-docs'`))).length === 1)
ok('storage : lecture refusée sans suppliers.read', (await as(prod, () => q(`select name from storage.objects where bucket_id='supplier-docs'`))).length === 0)

// --- 6. Commandes d'achat, historique, statistiques -------------------------------------------------------------
const po = (u, o) => as(u, async () => (await q(
  `insert into purchase_orders(supplier_id, status, order_date, expected_date, received_date, total_amount, currency) values ($1,$2,$3,$4,$5,$6,'EUR') returning *`,
  [o.sid ?? s1.id, o.status ?? 'sent', o.order, o.expected ?? null, o.received ?? null, o.total]))[0])
const d = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const p1 = await po(buyer, { order: d(-60), expected: d(-40), received: d(-42), total: 1000, status: 'received' })   // à l'heure, 18 j
await po(buyer, { order: d(-50), expected: d(-30), received: d(-25), total: 3000, status: 'received' })             // en retard, 25 j
await po(buyer, { order: d(-10), expected: d(-2), total: 500, status: 'sent' })                                      // ouverte et en retard
await po(buyer, { order: d(-5), total: 700, status: 'draft' })
await po(buyer, { order: d(-5), total: 9999, status: 'cancelled' })
ok('numérotation automatique des commandes (PO-AAAA-00001)', /^PO-\d{4}-00001$/.test(p1.po_no))
await rejects('commande refusée sans purchases.write (finance : lecture seule)', () => po(fin, { order: d(0), total: 1 }), 'row-level security')
ok('commandes visibles avec purchases.read, pas sans', (await as(fin, () => q(`select id from purchase_orders`))).length === 5 && (await as(comm, () => q(`select id from purchase_orders`))).length === 0)

const st = await as(buyer, () => rpc('supplier_purchase_stats', s1.id))
ok('stats : nombre de commandes hors annulées', st.orders_count === 4 && st.cancelled === 1)
ok('stats : montant total hors annulées', Number(st.total_amount) === 5200, String(st.total_amount))
ok('stats : commandes ouvertes (brouillon + envoyée)', st.open_orders === 2)
ok('stats : taux de ponctualité 50 %', Number(st.on_time_rate) === 50, String(st.on_time_rate))
ok('stats : délai moyen réel', Number(st.avg_lead_days) === 21.5, String(st.avg_lead_days))
ok('stats : commandes ouvertes en retard', st.late_open === 1)
ok('stats : 12 mois, montants agrégés', st.by_month.length === 12 && st.by_month.reduce((n, m) => n + Number(m.amount), 0) === 5200)
await rejects('stats réservées à purchases.read', () => as(comm, () => rpc('supplier_purchase_stats', s1.id)), 'RBAC_FORBIDDEN')
await rejects('stats : fournisseur d’une autre société introuvable', () => as(admin, () => rpc('supplier_purchase_stats', foreign)), 'SUPPLIER_NOT_FOUND')
const stEmpty = await as(buyer, () => rpc('supplier_purchase_stats', s2.id))
ok('stats : fournisseur sans commande', stEmpty.orders_count === 0 && stEmpty.on_time_rate === null)

// --- 7. Archivage / restauration / suppression ---------------------------------------------------------------------
await rejects('archivage réservé à suppliers.delete (achat refusé)', () => as(buyer, () => rpc('supplier_archive', s2.id, 'x')), 'RBAC_FORBIDDEN')
await as(direction, () => rpc('supplier_archive', s2.id, 'Plus utilisé'))
const arch = (await q(`select archived_at, archived_by, archive_reason from suppliers where id=$1`, [s2.id]))[0]
ok('archivage : date, auteur, motif', arch.archived_at && arch.archived_by === direction && arch.archive_reason === 'Plus utilisé')
await rejects('archivé : modification refusée', () => as(buyer, () => db.query(`update suppliers set notes='x' where id=$1`, [s2.id])), 'SUPPLIER_ARCHIVED')
await rejects('archivé : contact refusé', () => addContact(buyer, s2.id, { name: 'Trop tard' }), 'SUPPLIER_ARCHIVED')
await rejects('archivé : commande refusée', () => po(buyer, { sid: s2.id, order: d(0), total: 5 }), 'SUPPLIER_ARCHIVED')
await rejects('suppression : seulement si archivé', () => as(direction, () => rpc('supplier_delete', s1.id)), 'SUPPLIER_NOT_ARCHIVED')
ok('le nom d’un archivé est réutilisable', !!(await ins(buyer, { name: 'Boutons Express' })))
await rejects('restauration refusée si un fournisseur actif porte le nom', () => as(direction, () => rpc('supplier_restore', s2.id)), 'suppliers_name_active_uq')
await db.exec(`alter table suppliers disable trigger suppliers_before_iu; update suppliers set name='Boutons Express (ancien)' where id='${s2.id}'; alter table suppliers enable trigger suppliers_before_iu;`)
await as(direction, () => rpc('supplier_restore', s2.id))
ok('restauration', (await q(`select archived_at from suppliers where id=$1`, [s2.id]))[0].archived_at === null)
await as(direction, () => rpc('supplier_archive', s1.id, null))
await rejects('suppression refusée : fournisseur déjà commandé', () => as(direction, () => rpc('supplier_delete', s1.id)), 'SUPPLIER_IN_USE')
await as(direction, () => rpc('supplier_archive', s2.id, 'test suppression'))
await addDoc(buyer, s2.id, `${company}/${s2.id}/${uuid()}-z.pdf`).catch(() => {})
const files = await as(direction, () => rpc('supplier_delete', s2.id))
ok('suppression définitive d’un fournisseur jamais commandé (+ fichiers à effacer)', Array.isArray(files) && (await q(`select count(*)::int n from suppliers where id=$1`, [s2.id]))[0].n === 0)

// --- 8. Historique ---------------------------------------------------------------------------------------------------
const h = await q(`select action, actor_email, entity_label, before_data, after_data, metadata from audit_logs where entity_type='supplier' order by id`)
const acts = new Set(h.map((r) => r.action))
for (const a of ['supplier.create', 'supplier.update', 'supplier.contact_create', 'supplier.contact_update', 'supplier.contact_delete', 'supplier.document_create', 'supplier.archive', 'supplier.restore', 'supplier.delete'])
  ok(`historique : ${a}`, acts.has(a))
const upd = h.find((r) => r.action === 'supplier.update' && r.after_data.lead_time_days === 30)
ok('historique : délai 21 → 30 j (avant/après, champs modifiés seulement)', upd.before_data.lead_time_days === 21 && !('name' in upd.after_data) && upd.actor_email === 'achat@x.com')
ok('historique : suppression avec comptage', h.find((r) => r.action === 'supplier.delete' && r.metadata.contacts !== undefined) !== undefined)
ok('historique lisible avec suppliers.read', (await as(fin, () => q(`select id from audit_logs where entity_type='supplier'`))).length > 0)
ok('historique illisible sans suppliers.read', (await as(prod, () => q(`select id from audit_logs where entity_type='supplier'`))).length === 0)
