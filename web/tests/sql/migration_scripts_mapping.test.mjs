// Migration additive et simulation : scripts versionnés, exécutions à clé d'idempotence, simulation sans écriture,
// mapping d'anciens identifiants vérifiable, rejets motivés, lots bornés, aucun DROP/TRUNCATE — P110 / migration 0095
// Données fictives de test uniquement (aucun export de production).
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
const admin = await mkUser('admin@p110.com', 'admin')
const fin = await mkUser('fin@p110.com', 'finance')
const nobody = await mkUser('nobody@p110.com', null)

// Un client déjà présent dans le système local (son code ne doit pas être recréé)
await db.query(`insert into clients(company_id, code, name, country) values ($1,'CLI-EXIST','Client existant','FR')`, [company])
const countClients = async () => (await q(`select count(*)::int n from clients where company_id=$1`, [company]))[0].n
const C0 = await countClients()

const SCRIPT_CHECKSUM = 'a'.repeat(64)
await rejects('script : enregistrement sans droit refusé', () => as(nobody, () => rpc('migration_script_register', 'MIG_CLIENTS', 1, SCRIPT_CHECKSUM)), 'RBAC_FORBIDDEN')
const S1 = await as(admin, () => rpc('migration_script_register', 'MIG_CLIENTS', 1, SCRIPT_CHECKSUM))
ok('script : enregistrement versionné', !!S1)
ok('script : ré-enregistrement identique = même script (rejouable)', (await as(admin, () => rpc('migration_script_register', 'MIG_CLIENTS', 1, SCRIPT_CHECKSUM))) === S1)
await rejects('script : contenu modifié pour une version déjà enregistrée refusé', () => as(admin, () => rpc('migration_script_register', 'MIG_CLIENTS', 1, 'b'.repeat(64))), 'MIG_CHECKSUM_CHANGED')
await rejects('script : version modifiée figée (ajout seul)', () => db.query(`update migration_scripts set checksum = $1`, ['c'.repeat(64)]), 'MIG_APPEND_ONLY')

// Lot de données fictives : 1 valide, 1 déjà présent, 1 invalide, 1 doublon dans le lot, 1 valide
const rows = [
  { legacy_id: 'OLD-001', code: 'CLI-100', name: 'Atelier Alpha', country: 'TN' },
  { legacy_id: 'OLD-002', code: 'CLI-EXIST', name: 'Doublon de code', country: 'FR' },
  { legacy_id: 'OLD-003', code: 'x', name: 'Code trop court', country: 'TN' },
  { legacy_id: 'OLD-001', code: 'CLI-101', name: 'Doublon d\'identifiant', country: 'TN' },
  { legacy_id: 'OLD-004', code: 'CLI-102', name: 'Boutique Beta', country: 'tn' },
]

// ---------------------------------------------------------------------------
// 1. Simulation : aucune écriture de production, rejets et compte rendu seulement
// ---------------------------------------------------------------------------
const SIM = await as(admin, () => rpc('migration_run_start', S1, 'simulation', 50, 'SIM-P110-0001'))
const simRes = await as(admin, () => rpc('migration_run_batch', SIM, JSON.stringify(rows)))
ok('simulation : compte rendu (2 à créer, 1 déjà mappé ou présent, 2 rejets)', simRes.would_create === 2 && simRes.rejected === 3 && simRes.created === 0, JSON.stringify(simRes))
ok('simulation : aucun client créé en production', (await countClients()) === C0 + 0)
ok('simulation : aucun mapping écrit', (await q(`select count(*)::int n from legacy_id_map where company_id=$1`, [company]))[0].n === 0)
ok('simulation : rejets journalisés avec leur motif', (await q(`select code from migration_rejects where run_id=$1 order by code`, [SIM])).map((r) => r.code).join(',') === 'MIG_CODE_EXISTS,MIG_DUPLICATE_IN_BATCH,MIG_INVALID_CODE')
await as(admin, () => rpc('migration_run_finish', SIM))
await rejects('simulation : exécution close ne reçoit plus de lot', () => as(admin, () => rpc('migration_run_batch', SIM, JSON.stringify(rows))), 'MIG_RUN_CLOSED')

// ---------------------------------------------------------------------------
// 2. Application : deux exécutions, aucun doublon, identifiants conservés
// ---------------------------------------------------------------------------
const APPLY1 = await as(admin, () => rpc('migration_run_start', S1, 'apply', 50, 'APPLY-P110-0001'))
const ap1 = await as(admin, () => rpc('migration_run_batch', APPLY1, JSON.stringify(rows)))
ok('application 1 : 2 clients créés, 3 rejets', ap1.created === 2 && ap1.rejected === 3, JSON.stringify(ap1))
await as(admin, () => rpc('migration_run_finish', APPLY1))
const C1 = await countClients()
ok('application 1 : clients = départ + 2', C1 === C0 + 2)
const L1 = await as(admin, () => rpc('migration_local_id', 'OLD-001'))
ok('mapping : OLD-001 pointe le client CLI-100 existant', L1 && (await q(`select code from clients where id=$1`, [L1]))[0].code === 'CLI-100')

// Deuxième exécution : même clé d'idempotence (renvoie la même exécution) puis nouvelle clé sur les mêmes lignes
const APPLY1b = await as(admin, () => rpc('migration_run_start', S1, 'apply', 50, 'APPLY-P110-0001'))
ok('clé d\'idempotence : même exécution renvoyée, aucune nouvelle ligne', APPLY1b === APPLY1)
const APPLY2 = await as(admin, () => rpc('migration_run_start', S1, 'apply', 50, 'APPLY-P110-0002'))
const ap2 = await as(admin, () => rpc('migration_run_batch', APPLY2, JSON.stringify(rows)))
ok('deux exécutions : aucun doublon (0 créé, les identifiants déjà mappés sont comptés)', ap2.created === 0 && ap2.mapped === 2 && (await countClients()) === C1, JSON.stringify(ap2))
ok('deux exécutions : identifiant local inchangé après la seconde exécution', (await as(admin, () => rpc('migration_local_id', 'OLD-001'))) === L1)
await rejects('clé réutilisée avec un autre mode refusée', () => as(admin, () => rpc('migration_run_start', S1, 'simulation', 50, 'APPLY-P110-0001')), 'MIG_KEY_REUSED')

// ---------------------------------------------------------------------------
// 3. Lots bornés, mapping vérifiable, historique
// ---------------------------------------------------------------------------
const SMALL = await as(admin, () => rpc('migration_run_start', S1, 'apply', 1, 'APPLY-P110-0003'))
await rejects('lot : taille supérieure à la limite refusée', () => as(admin, () => rpc('migration_run_batch', SMALL, JSON.stringify(rows))), 'MIG_BATCH_TOO_LARGE')
const verify = await as(admin, () => rpc('migration_map_verify'))
ok('mapping vérifiable : toutes les correspondances pointent un client existant', verify.mapped === 2 && verify.missing_local === 0, JSON.stringify(verify))
ok('historique : le mapping garde l\'exécution d\'origine', (await q(`select run_id from legacy_id_map where legacy_id='OLD-001'`))[0].run_id === APPLY1)
await rejects('mapping : correspondance figée (ajout seul)', () => db.query(`update legacy_id_map set local_id = gen_random_uuid() where legacy_id = 'OLD-001'`), 'MIG_APPEND_ONLY')
await rejects('mapping : suppression refusée', () => db.query(`delete from legacy_id_map where legacy_id = 'OLD-001'`), 'MIG_APPEND_ONLY')
await rejects('exécution : sans droit de migration refusée', () => as(fin, () => rpc('migration_run_start', S1, 'simulation', 50, 'FIN-P110-0001')), 'RBAC_FORBIDDEN')

// ---------------------------------------------------------------------------
// 4. Contrôle des scripts : aucun DROP, TRUNCATE ni purge dans les migrations de ce lot
// ---------------------------------------------------------------------------
const src = fs.readFileSync(`${migrationsDir}/0095_migration_scripts_mapping.sql`, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').toLowerCase()
ok('contrôle : aucun DROP, TRUNCATE ni DELETE de données dans la migration 0095', !/\bdrop\s+(table|schema|function|column)/.test(src) && !/\btruncate\b/.test(src) && !/\bdelete\s+from\s+public\.clients/.test(src))
