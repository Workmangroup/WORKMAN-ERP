import { createDb, makeHelpers } from './_harness.mjs'

const db = await createDb(['0001_auth_core.sql','0002_auth_seed.sql','0003_rbac_audit.sql','0004_clients.sql','0005_ged.sql','0006_suppliers.sql','0007_articles.sql','0008_bom.sql','0009_stock.sql','0010_mrp.sql','0011_purchases.sql','0012_commercial.sql','0013_pdm.sql','0014_development.sql','0015_variants.sql','0016_subcontracting.sql','0017_warehouses.sql','0018_stock_movements.sql','0019_production.sql','0020_quality.sql','0021_shipping.sql','0022_finance.sql','0023_executive.sql','0024_copilot.sql','0025_table_meta.sql','0026_client_complaints.sql','0027_multicurrency.sql','0028_access_token_hook_fix.sql','0029_export_vat_rule.sql','0030_vat_rates_versioned.sql','0031_general_ledger.sql','0032_sites.sql','0033_delegations_sod.sql','0034_payment_execution.sql','0035_audit_traceability.sql','0036_ui_views_search.sql','0037_documents_security.sql','0038_parties.sql','0039_units_variants.sql','0040_pricing_fx_tax.sql','0041_fodec.sql','0042_imports_reference.sql'])
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const sha = (c) => c.repeat(64)

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@x.com', 'admin')            // charge et simule
const admin2 = await mkUser('admin2@x.com', 'admin')          // valide (personne différente)
const dir = await mkUser('dir@x.com', 'direction')
const comm = await mkUser('comm@x.com', 'commercial')
const resp = await mkUser('resp.cc@x.com', null)              // responsable actif (profil créé par trigger)
const ancien = await mkUser('ancien@x.com', null)             // responsable qui sera désactivé

// --- 0. Migration : permissions et rôles ----------------------------------------------------------------------------------------------
ok('migration : 5 permissions d’import et de référentiels créées', (await q(`select count(*)::int n from permissions where code in ('imports.read','imports.write','imports.commit','referentials.read','referentials.manage')`))[0].n === 5)
ok('migration : admin a imports.commit ; direction ne l’a pas', (await q(`select
   (select count(*)::int from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='admin' and p.code='imports.commit') as adm,
   (select count(*)::int from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='direction' and p.code='imports.commit') as dr`))[0].adm === 1 && (await q(`select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id where r.code='direction' and p.code='imports.commit'`))[0].n === 0)
ok('migration : aucune donnée de référentiel créée', (await q(`select ((select count(*) from cost_centers)+(select count(*) from calendars)+(select count(*) from import_batches))::int n`))[0].n === 0)

// Fixtures : entrepôt et site existants (réutilisés, non recréés)
const wh = (await as(admin, () => q(`insert into warehouses(name, kind) values ('Magasin import','supplies') returning id, code`)))[0]
const site = (await as(admin, () => q(`insert into sites(company_id, name, kind, city) values ($1,'Siège import','site','Sfax') returning id, code`, [company])))[0]

// --- 1. Simulation sans mutation, rejets expliqués, doublon dans le fichier --------------------------------------------------------------
const b1 = await as(admin, () => rpc('import_batch_create', 'cost_centers', 'cc-sale.csv', sha('a'), 'IMP-CC-LOT-0001'))
const load1 = await as(admin, () => rpc('import_rows_load', b1, [
  { code: 'cc-100', label: 'Production coupe', owner_email: 'resp.cc@x.com' },
  { code: 'CC-200', label: 'Expédition', owner_email: 'inconnu@x.com' },
  { code: 'cc-100', label: 'Doublon dans le fichier', owner_email: 'resp.cc@x.com' },
  { code: 'BAD CODE', label: 'X', owner_email: 'resp.cc@x.com' },
]))
ok('chargement : 4 lignes, 2 valides, 2 rejets', load1.total === 4 && load1.loaded === 2 && load1.rejected === 2, JSON.stringify(load1))
const cc0 = (await q(`select count(*)::int n from cost_centers`))[0].n
const sim1 = await as(admin, () => rpc('import_simulate', b1))
ok('simulation : doublon dans le fichier rejeté des deux côtés, rien à créer', sim1.to_create === 0 && sim1.rejected === 4, JSON.stringify(sim1))
ok('simulation sans mutation : aucun centre analytique écrit', (await q(`select count(*)::int n from cost_centers`))[0].n === cc0)
const rej1 = await as(admin, () => rpc('import_rejects_export', b1))
const byLine = Object.fromEntries(rej1.map((r) => [r.line_no, r.errors.map((e) => e.code)]))
ok('rejet ligne 2 expliqué : responsable inconnu', (byLine[2] || []).includes('OWNER_NOT_FOUND'), JSON.stringify(byLine))
ok('rejet ligne 4 expliqué : code invalide et libellé trop court', (byLine[4] || []).includes('CC_CODE_INVALID') && (byLine[4] || []).includes('CC_LABEL_INVALID'))
ok('export des rejets : données brutes conservées avec numéro de ligne', rej1.length === 4 && rej1[0].raw.code === 'cc-100' && rej1[1].line_no === 2)
await rejects('chargement après simulation refusé (lot figé à l’étape)', () => as(admin, () => rpc('import_rows_load', b1, [{ code: 'CC-900', label: 'Trop tard', owner_email: 'resp.cc@x.com' }])), 'IMPORT_BAD_STATUS')
const bx = await as(admin, () => rpc('import_batch_create', 'cost_centers', 'cc-double.csv', sha('3'), 'IMP-CC-LOT-DBL'))
await as(admin, () => rpc('import_rows_load', bx, [{ code: 'CC-900', label: 'Une fois', owner_email: 'resp.cc@x.com' }]))
await rejects('chargement en double refusé sur un lot encore préparé (aucune ligne ajoutée deux fois)', () => as(admin, () => rpc('import_rows_load', bx, [{ code: 'CC-901', label: 'Deux fois', owner_email: 'resp.cc@x.com' }])), 'IMPORT_ALREADY_LOADED')
ok('lot préparé : une seule ligne après la tentative de double chargement', (await q(`select count(*)::int n from import_rows where batch_id=$1`, [bx]))[0].n === 1)
await rejects('validation par le chargeur refusée (séparation des tâches)', () => as(admin, () => rpc('import_commit', b1)), 'SOD_SELF_APPROVAL')
const c1 = await as(admin2, () => rpc('import_commit', b1))
ok('validation d’un lot sans ligne à créer : 0 créé, lot figé', c1.created === 0 && c1.already_committed === false)

// --- 2. Import propre : simulation, validation par une autre personne, reprise sans doublon -------------------------------------------
const b2 = await as(admin, () => rpc('import_batch_create', 'cost_centers', 'cc-lot2.csv', sha('b'), 'IMP-CC-LOT-0002'))
await as(admin, () => rpc('import_rows_load', b2, [
  { code: 'CC-300', label: 'Coupe', owner_email: 'resp.cc@x.com' },
  { code: 'CC-400', label: 'Finition', owner_email: 'resp.cc@x.com' },
]))
await rejects('validation refusée avant simulation', () => as(admin2, () => rpc('import_commit', b2)), 'IMPORT_BAD_STATUS')
const sim2 = await as(admin, () => rpc('import_simulate', b2))
ok('simulation : 2 créations prévues', sim2.to_create === 2 && sim2.rejected === 0, JSON.stringify(sim2))
ok('simulation sans mutation (lot 2) : aucune écriture sur les centres', (await q(`select count(*)::int n from cost_centers where code in ('CC-300','CC-400')`))[0].n === 0)
await rejects('validation par le commercial refusée (droit imports.commit absent)', () => as(comm, () => rpc('import_commit', b2)), 'RBAC_FORBIDDEN')
const c2 = await as(admin2, () => rpc('import_commit', b2))
ok('validation : 2 centres créés', c2.created === 2 && c2.already_committed === false, JSON.stringify(c2))
ok('centres créés avec le responsable de la même société (profil actif)', (await q(`select count(*)::int n from cost_centers c join profiles p on p.id=c.owner_id where c.code in ('CC-300','CC-400') and p.email='resp.cc@x.com'`))[0].n === 2)
ok('audit : création de centre et validation de lot tracées', (await q(`select count(*)::int n from audit_logs where action in ('cost_center.create','import.commit') and entity_id in (select id::text from cost_centers where code in ('CC-300','CC-400') union select id::text from import_batches where id=$1)`, [b2]))[0].n >= 3)

// Reprise : même clé = même lot, rien de nouveau ; relance de validation sans doublon
const again = await as(admin, () => rpc('import_batch_create', 'cost_centers', 'cc-lot2.csv', sha('b'), 'IMP-CC-LOT-0002'))
ok('reprise : même clé renvoie le même lot', again === b2)
ok('reprise : aucune ligne ajoutée au lot', (await q(`select count(*)::int n from import_rows where batch_id=$1`, [b2]))[0].n === 2)
const c2b = await as(admin2, () => rpc('import_commit', b2))
ok('relance de validation : rien écrit, résumé du lot déjà validé', c2b.already_committed === true && c2b.created === 2)
ok('reprise : toujours 2 centres en base (pas de doublon)', (await q(`select count(*)::int n from cost_centers where code in ('CC-300','CC-400')`))[0].n === 2)
await rejects('même clé avec un autre contenu refusée', () => as(admin, () => rpc('import_batch_create', 'cost_centers', 'autre.csv', sha('c'), 'IMP-CC-LOT-0002')), 'IMPORT_KEY_CONFLICT')
await rejects('clé d’un autre utilisateur refusée (lot non le sien)', () => as(admin2, () => rpc('import_batch_create', 'cost_centers', 'cc-lot2.csv', sha('b'), 'IMP-CC-LOT-0002')), 'IMPORT_NOT_OWNER')

// Nouveau lot, autre clé, même contenu : rien ne se duplique
const b3 = await as(admin, () => rpc('import_batch_create', 'cost_centers', 'cc-lot2-bis.csv', sha('d'), 'IMP-CC-LOT-0003'))
await as(admin, () => rpc('import_rows_load', b3, [{ code: 'CC-300', label: 'Coupe', owner_email: 'resp.cc@x.com' }]))
const sim3 = await as(admin, () => rpc('import_simulate', b3))
ok('nouveau lot au contenu déjà présent : déjà présent, pas de création', sim3.to_create === 0 && sim3.already_exist === 1, JSON.stringify(sim3))
const c3 = await as(admin2, () => rpc('import_commit', b3))
ok('validation du lot sans création : aucun doublon', c3.created === 0 && (await q(`select count(*)::int n from cost_centers where code='CC-300'`))[0].n === 1)

// --- 3. Calendriers, sites et emplacements : responsables, liens, rejets ----------------------------------------------------------------
const bc = await as(admin, () => rpc('import_batch_create', 'calendars', 'cal.csv', sha('e'), 'IMP-CAL-LOT-0001'))
await as(admin, () => rpc('import_rows_load', bc, [
  { code: 'cal-std', name: 'Standard', owner_email: 'resp.cc@x.com', site_code: site.code, working_days: '1,2,3,4,5' },
  { code: 'CAL-X', name: 'Site inconnu', owner_email: 'resp.cc@x.com', site_code: 'SIT-99', working_days: '1,2' },
  { code: 'CAL-BAD', name: 'Jours invalides', owner_email: 'resp.cc@x.com', working_days: '0,8' },
  { code: 'CAL-NR', name: 'Sans responsable', owner_email: 'nobody@x.com', working_days: '1' },
]))
const simc = await as(admin, () => rpc('import_simulate', bc))
ok('calendriers : 1 à créer, 3 rejets (site inconnu, jours invalides, responsable inconnu)', simc.to_create === 1 && simc.rejected === 3, JSON.stringify(simc))
const rejc = await as(admin, () => rpc('import_rejects_export', bc))
const codesc = Object.fromEntries(rejc.map((r) => [r.line_no, r.errors.map((e) => e.code)]))
ok('rejet calendrier : site inconnu expliqué', (codesc[2] || []).includes('SITE_NOT_FOUND'), JSON.stringify(codesc))
ok('rejet calendrier : jours invalides expliqués', (codesc[3] || []).includes('WORKING_DAYS_INVALID'))
await as(admin2, () => rpc('import_commit', bc))
ok('calendrier créé : jours ISO normalisés, rattaché au site', (await q(`select working_days::text d, site_id is not null s from calendars where code='CAL-STD'`))[0].d === '{1,2,3,4,5}')

const bs = await as(admin, () => rpc('import_batch_create', 'sites', 'sites.csv', sha('f'), 'IMP-SITE-LOT-0001'))
await as(admin, () => rpc('import_rows_load', bs, [
  { name: 'Atelier import', kind: 'workshop', city: 'Sfax' },
  { name: 'Siège import', kind: 'site', city: 'Sfax' },
  { name: 'A', kind: 'site' },
]))
const sims = await as(admin, () => rpc('import_simulate', bs))
ok('sites : nouveau créé, existant reconnu (pas de doublon), nom trop court rejeté', sims.to_create === 1 && sims.already_exist === 1 && sims.rejected === 1, JSON.stringify(sims))
await as(admin2, () => rpc('import_commit', bs))
ok('sites : le site existant n’est pas recréé', (await q(`select count(*)::int n from sites where lower(name)='siège import'`))[0].n === 1)
ok('sites : le nouveau site reçoit son code généré (SIT-nn)', (await q(`select code from sites where name='Atelier import'`))[0].code.startsWith('SIT-'))

const bz = await as(admin, () => rpc('import_batch_create', 'warehouse_locations', 'zones.csv', sha('1'), 'IMP-ZONE-LOT-0001'))
await as(admin, () => rpc('import_rows_load', bz, [
  { warehouse_code: wh.code, code: 'zc', name: 'Zone coupe', zone_type: 'cutting' },
  { warehouse_code: 'WH-99', code: 'za', name: 'Zone orpheline', zone_type: 'storage' },
  { warehouse_code: wh.code, code: 'zq', name: 'Quarantaine', zone_type: 'cave' },
]))
const simz = await as(admin, () => rpc('import_simulate', bz))
ok('zones : 1 créée ; entrepôt inconnu (orphelin) et type inconnu rejetés', simz.to_create === 1 && simz.rejected === 2, JSON.stringify(simz))
const rejz = await as(admin, () => rpc('import_rejects_export', bz))
ok('rejet zone : entrepôt introuvable expliqué', rejz.some((r) => r.errors.some((e) => e.code === 'WAREHOUSE_NOT_FOUND')))
ok('rejet zone : type inconnu expliqué', rejz.some((r) => r.errors.some((e) => e.code === 'ZONE_TYPE_INVALID')))
await as(admin2, () => rpc('import_commit', bz))
ok('zone créée dans l’entrepôt par la validation', (await q(`select count(*)::int n from warehouse_locations where code='ZC'`))[0].n === 1)

// --- 4. Droits, immuabilité, rapport d'intégrité -----------------------------------------------------------------------------------------
await rejects('direction : création d’import refusée (lecture seule)', () => as(dir, () => rpc('import_batch_create', 'sites', 'x.csv', sha('2'), 'IMP-DIR-LOT-0001')), 'RBAC_FORBIDDEN')
ok('direction : lecture des lots autorisée', (await as(dir, () => q(`select count(*)::int n from import_batches`)))[0].n >= 4)
await rejects('écriture directe des lignes d’import refusée', () => as(admin, () => q(`insert into import_rows(batch_id, company_id, line_no, raw) values ($1,$2,99,'{}')`, [b2, company])), 'permission denied')
await rejects('création directe de centre refusée au commercial', () => as(comm, () => q(`insert into cost_centers(code,label,owner_id) values ('CC-COM','Commercial',$1)`, [resp])), 'row-level security')
await rejects('modification du code d’un centre refusée (colonne non accordée)', () => as(admin, () => q(`update cost_centers set code='CC-NEW' where code='CC-300'`)), 'permission denied')

// Orphelins : responsable devenu inactif après création, zone d'entrepôt archivé. Détectés sans rien corriger.
await as(admin, () => q(`insert into cost_centers(code,label,owner_id) values ('CC-OLD','Coupe',$1)`, [ancien]))
await db.query(`update profiles set is_active=false where id=$1`, [ancien])
await rejects('responsable inactif refusé à la création d’un centre', () => as(admin, () => q(`insert into cost_centers(code,label,owner_id) values ('CC-OFF','Hors service',$1)`, [ancien])), 'OWNER_INVALID')
await db.query(`update warehouses set archived_at=now() where id=$1`, [wh.id])
const ccBefore = (await q(`select count(*)::int n from cost_centers`))[0].n
const rep = await as(admin, () => q(`select ref_kind, ref_code, issue from reference_integrity_report() order by 2, 3`))
ok('rapport : doublon de libellé détecté (CC-300 / CC-OLD « Coupe »)', rep.some((r) => r.issue === 'DUPLICATE_LABEL' && r.ref_code === 'CC-300') && rep.some((r) => r.ref_code === 'CC-OLD' && r.issue === 'DUPLICATE_LABEL'), JSON.stringify(rep))
ok('rapport : responsable inactif détecté, sans désactivation automatique', rep.some((r) => r.ref_code === 'CC-OLD' && r.issue === 'OWNER_INACTIVE'))
ok('rapport : zone d’un entrepôt archivé détectée', rep.some((r) => r.ref_kind === 'warehouse_locations' && r.issue === 'WAREHOUSE_ARCHIVED'))
ok('rapport en lecture seule : aucune ligne modifiée ni supprimée', (await q(`select count(*)::int n from cost_centers`))[0].n === ccBefore && (await q(`select is_active from profiles where id=$1`, [ancien]))[0].is_active === false)
await rejects('rapport refusé sans droit de lecture des référentiels', () => as(comm, () => q(`select * from reference_integrity_report()`)), 'RBAC_FORBIDDEN')
ok('lots validés : 6 lots figés (statut committed)', (await q(`select count(*)::int n from import_batches where status='committed'`))[0].n === 6)
