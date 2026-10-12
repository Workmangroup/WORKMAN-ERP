import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations')

/** Base PGlite avec un schéma `auth` simulé (users, sessions, auth.uid/jwt) + migrations demandées. */
export async function createDb(files) {
  const db = new PGlite()
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
    -- Stub minimal de Supabase Storage
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:greatest(cardinality(string_to_array(name, '/')) - 1, 0)] $$;
    grant usage on schema storage to authenticated, service_role;
    grant select, insert, delete on storage.objects to authenticated;
  `)
  for (const f of files) await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
  return db
}

export function makeHelpers(db) {
  let failed = 0
  const ok = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
    if (!cond) { failed++; process.exitCode = 1 }
  }
  /** Exécute `fn` avec le rôle `authenticated` et un JWT { sub }. */
  const as = async (uid, fn, sessionId = null) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, session_id: sessionId })}', false);`)
    try { return await fn() } finally { await db.exec(`reset role; select set_config('request.jwt.claims','',false);`) }
  }
  /** Vérifie qu'`fn` échoue avec un message contenant `code`. */
  const rejects = async (name, fn, code) => {
    try { await fn(); ok(name, false, '(aucune erreur)') }
    catch (e) { ok(name, String(e.message).includes(code), String(e.message).includes(code) ? '' : `(reçu: ${e.message})`) }
  }
  return { ok, as, rejects, failed: () => failed }
}
