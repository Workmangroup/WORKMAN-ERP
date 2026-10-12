import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations')

const db = new PGlite()
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) process.exitCode = 1 }

// --- Simulation minimale de Supabase ---------------------------------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}');
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade,
     created_at timestamptz default now(), updated_at timestamptz default now(), user_agent text, ip inet, not_after timestamptz);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to authenticated, service_role, supabase_auth_admin;
  grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;
`)

for (const f of ['0001_auth_core.sql', '0002_auth_seed.sql', '0028_access_token_hook_fix.sql']) {
  await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
}
ok('migrations appliquées', true)

const as = async (uid, sessionId, fn) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, session_id: sessionId })}', false);`)
  try { return await fn() } finally { await db.exec(`reset role; select set_config('request.jwt.claims','',false);`) }
}

// --- Trigger de profil -----------------------------------------------
const company = (await db.query(`select id from companies`)).rows[0].id
const { rows: [u1] } = await db.query(`insert into auth.users(email, raw_app_meta_data, raw_user_meta_data) values ('admin@x.com', '{"must_change_password": true}', '{"full_name":"Admin MB"}') returning id`)
const { rows: [u2] } = await db.query(`insert into auth.users(email, raw_user_meta_data) values ('op@x.com', '{"user_type":"client","company_id":"00000000-0000-0000-0000-000000000000"}') returning id`)
const prof = (await db.query(`select * from profiles order by email`)).rows
ok('profil créé pour chaque utilisateur', prof.length === 2)
ok('company par défaut', prof[0].company_id === company)
ok('must_change_password lu dans app_metadata', prof[0].must_change_password === true)
ok('user_metadata ignoré (pas d’escalade client/company)', prof[1].user_type === 'internal' && prof[1].company_id === company)

// --- Rôles / permissions ---------------------------------------------
const adminRole = (await db.query(`select id from roles where code='admin'`)).rows[0].id
await db.query(`insert into user_roles values ($1,$2)`, [u1.id, adminRole])
const nperm = (await db.query(`select count(*)::int n from permissions`)).rows[0].n
const nroles = (await db.query(`select count(*)::int n from roles`)).rows[0].n
ok('seed : 14 rôles', nroles === 14, `(${nroles})`)
const access = await as(u1.id, null, async () => (await db.query(`select public.my_access() a`)).rows[0].a)
ok('my_access : admin a toutes les permissions', access.permissions.length === nperm && access.roles[0].code === 'admin')
const access2 = await as(u2.id, null, async () => (await db.query(`select public.my_access() a`)).rows[0].a)
ok('my_access : utilisateur sans rôle -> vide', access2.roles.length === 0 && access2.permissions.length === 0)

// --- Hook JWT ---------------------------------------------------------
const hook = (await db.query(`select public.custom_access_token_hook($1::jsonb) r`, [JSON.stringify({ user_id: u1.id, claims: { role: 'authenticated', sub: u1.id } })])).rows[0].r
ok('hook : claims ajoutés', hook.claims.app_roles[0] === 'admin' && hook.claims.must_change_password === true && hook.claims.company_id === company)
ok('hook : pas de client_id pour un compte interne (GoTrue le refuse à null)', hook.claims.client_id === undefined)
ok('hook : claim « role » inchangé', hook.claims.role === 'authenticated')

// --- RLS ---------------------------------------------------------------
const own = await as(u2.id, null, async () => (await db.query(`select id from profiles`)).rows)
ok('RLS : un utilisateur sans droit ne voit que son profil', own.length === 1 && own[0].id === u2.id)
const all = await as(u1.id, null, async () => (await db.query(`select id from profiles`)).rows)
ok('RLS : admin (users.read) voit les profils de sa société', all.length === 2)

let blocked = false
try { await as(u2.id, null, async () => db.query(`update profiles set must_change_password=false, is_active=true where id=$1`, [u2.id])) } catch { blocked = true }
ok('column grants : impossible de modifier must_change_password/is_active', blocked)
let okSelf = true
try { await as(u2.id, null, async () => db.query(`update profiles set full_name='Nouveau' where id=$1`, [u2.id])) } catch (e) { okSelf = false; console.log(e.message) }
ok('column grants : full_name modifiable', okSelf)
let blockedWrite = false
try { await as(u1.id, null, async () => db.query(`insert into user_roles values ($1,$2)`, [u2.id, adminRole])) } catch { blockedWrite = true }
ok('RLS : pas d’écriture user_roles côté authenticated (pas d’auto-promotion)', blockedWrite)
let blockedEvt = false
try { await as(u1.id, null, async () => db.query(`insert into auth_events(event_type) values ('login_success')`)) } catch { blockedEvt = true }
ok('RLS : auth_events non inscriptible côté client', blockedEvt)

// --- auth_events visibilité -------------------------------------------
await db.query(`insert into auth_events(user_id,email,event_type,company_id) values ($1,'op@x.com','login_success',$2),($3,'admin@x.com','login_failed',$2)`, [u2.id, company, u1.id])
const ev2 = await as(u2.id, null, async () => (await db.query(`select * from auth_events`)).rows)
ok('auth_events : l’utilisateur ne voit que les siens', ev2.length === 1)
const ev1 = await as(u1.id, null, async () => (await db.query(`select * from auth_events`)).rows)
ok('auth_events : audit.read voit ceux de la société', ev1.length === 2)

// --- Sessions ----------------------------------------------------------
const s = []
for (let i = 0; i < 3; i++) s.push((await db.query(`insert into auth.sessions(user_id,user_agent,ip) values ($1,'UA${i}','10.0.0.${i}') returning id`, [u1.id])).rows[0].id)
await db.query(`insert into auth.sessions(user_id) values ($1)`, [u2.id])
const list = await as(u1.id, s[0], async () => (await db.query(`select * from public.list_my_sessions()`)).rows)
ok('list_my_sessions : 3 sessions, la courante marquée', list.length === 3 && list.filter((r) => r.is_current).length === 1 && list.find((r) => r.is_current).id === s[0])
const otherUserSession = (await db.query(`select id from auth.sessions where user_id=$1`, [u2.id])).rows[0].id
const rev = await as(u1.id, s[0], async () => (await db.query(`select public.revoke_session($1) r`, [otherUserSession])).rows[0].r)
ok('revoke_session : impossible de révoquer la session d’un autre utilisateur', rev === false)
const rev2 = await as(u1.id, s[0], async () => (await db.query(`select public.revoke_session($1) r`, [s[1]])).rows[0].r)
ok('revoke_session : session propre révoquée', rev2 === true)
const n = await as(u1.id, s[0], async () => (await db.query(`select public.revoke_other_sessions() n`)).rows[0].n)
const left = (await db.query(`select id from auth.sessions where user_id=$1`, [u1.id])).rows
ok('revoke_other_sessions : conserve la session courante', n === 1 && left.length === 1 && left[0].id === s[0])

// --- Permissions d'exécution ------------------------------------------
let anonBlocked = false
try { await db.exec(`set role anon; select public.my_access();`) } catch { anonBlocked = true } finally { await db.exec('reset role') }
ok('anon ne peut pas exécuter my_access', anonBlocked)
let hookBlocked = false
try { await db.exec(`set role authenticated; select public.custom_access_token_hook('{}'::jsonb);`) } catch { hookBlocked = true } finally { await db.exec('reset role') }
ok('authenticated ne peut pas appeler le hook JWT', hookBlocked)

// --- Email sync ---------------------------------------------------------
await db.query(`update auth.users set email='new@x.com' where id=$1`, [u1.id])
ok('email du profil synchronisé', (await db.query(`select email from profiles where id=$1`, [u1.id])).rows[0].email === 'new@x.com')
