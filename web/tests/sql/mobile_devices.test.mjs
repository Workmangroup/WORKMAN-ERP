// Socle mobile : appareils identifiés, contrôle par requête, révocation (propriétaire ou administrateur), identifiant
// jamais réactivé, historique immuable — P099 / migration 0096. Données fictives de test uniquement.
import fs from 'node:fs'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const db = await createDb(files)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const uuid = () => crypto.randomUUID()

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const admin = await mkUser('admin@p099.com', 'admin')
const mag = await mkUser('mag@p099.com', 'magasin')
const mag2 = await mkUser('mag2@p099.com', 'magasin')
const com = await mkUser('com@p099.com', 'commercial')   // sans droit mobile
const nobody = await mkUser('nobody@p099.com', null)

const D1 = uuid(), D2 = uuid(), D3 = uuid()
await rejects('appareil : enregistrement sans droit mobile refusé', () => as(com, () => rpc('mobile_device_register', D3, 'Tablette test')), 'RBAC_FORBIDDEN')
await rejects('appareil : libellé trop court refusé', () => as(mag, () => rpc('mobile_device_register', D3, 'x')), 'MOBILE_BAD_INPUT')
await as(mag, () => rpc('mobile_device_register', D1, 'Tablette entrepôt 1'))
await as(mag, () => rpc('mobile_device_register', D1, 'Tablette entrepôt 1'))
ok('appareil : même identifiant réenregistré par son propriétaire, une seule ligne', (await q(`select count(*)::int n from mobile_devices where id=$1`, [D1]))[0].n === 1)
await rejects('appareil : identifiant d\'un autre utilisateur refusé', () => as(mag2, () => rpc('mobile_device_register', D1, 'Autre')), 'MOBILE_DEVICE_OWNED')

// Contrôle par requête
ok('contrôle : appareil actif accepté', (await as(mag, () => rpc('mobile_device_check', D1))) === true)
ok('contrôle : dernière activité enregistrée', (await q(`select last_seen_at is not null v from mobile_devices where id=$1`, [D1]))[0].v === true)
await rejects('contrôle : appareil inconnu refusé', () => as(mag, () => rpc('mobile_device_check', D2)), 'MOBILE_DEVICE_UNKNOWN')
await rejects('contrôle : appareil d\'un autre utilisateur refusé', () => as(mag2, () => rpc('mobile_device_check', D1)), 'MOBILE_DEVICE_NOT_OWNER')

// Révocation par le propriétaire
await rejects('révocation : motif trop court refusé', () => as(mag, () => rpc('mobile_device_revoke', D1, 'ok')), 'MOBILE_REASON_REQUIRED')
await rejects('révocation : appareil d\'un autre sans droit d\'administration refusée', () => as(mag2, () => rpc('mobile_device_revoke', D1, 'Essai de révocation')), 'MOBILE_DEVICE_NOT_OWNER')
await as(mag, () => rpc('mobile_device_revoke', D1, 'Tablette perdue'))
await rejects('révoqué : contrôle refusé à la requête suivante', () => as(mag, () => rpc('mobile_device_check', D1)), 'MOBILE_DEVICE_REVOKED')
await rejects('révoqué : identifiant non réactivable par réenregistrement', () => as(mag, () => rpc('mobile_device_register', D1, 'Tablette entrepôt 1')), 'MOBILE_DEVICE_REVOKED')
await rejects('révoqué : seconde révocation refusée', () => as(mag, () => rpc('mobile_device_revoke', D1, 'Encore une fois')), 'MOBILE_BAD_STATUS')
await rejects('historique : appareil révoqué figé (modification refusée)', () => db.query(`update mobile_devices set label = 'Autre' where id = $1`, [D1]), 'MOBILE_DEVICE_REVOKED')
await rejects('historique : suppression refusée', () => db.query(`delete from mobile_devices where id = $1`, [D1]), 'MOBILE_APPEND_ONLY')

// Révocation par un administrateur (mobile.admin) d'un appareil d'un autre utilisateur
await as(mag2, () => rpc('mobile_device_register', D2, 'Tablette entrepôt 2'))
await as(admin, () => rpc('mobile_device_revoke', D2, 'Appareil confié à un tiers'))
await rejects('révocation par administrateur : appareil de l\'autre utilisateur bloqué', () => as(mag2, () => rpc('mobile_device_check', D2)), 'MOBILE_DEVICE_REVOKED')
ok('révocation par administrateur : trace (qui, motif)', (await q(`select revoked_by is not null and revoke_reason is not null v from mobile_devices where id=$1`, [D2]))[0].v === true)

// Visibilité : chacun voit ses appareils ; l'administrateur voit tous les appareils
const visibleToMag2 = await as(mag2, () => q(`select id from mobile_devices`))
ok('visibilité : utilisateur sans droit d\'administration ne voit que ses appareils', visibleToMag2.every((r) => r.id === D2) && visibleToMag2.length === 1)
const visibleToAdmin = await as(admin, () => q(`select id from mobile_devices`))
ok('visibilité : administrateur voit les appareils révoqués', visibleToAdmin.length === 2)
await rejects('sans compte : aucun appareil visible', async () => { const r = await as(nobody, () => q(`select id from mobile_devices`)); if (r.length) throw new Error('visible'); throw new Error('RLS-OK') }, 'RLS-OK')

// Journal d'audit
ok('audit : enregistrement et révocations tracés', (await q(`select count(*)::int n from audit_logs where action like 'mobile.%'`))[0].n >= 3)
