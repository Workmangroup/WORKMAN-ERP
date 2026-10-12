-- 00_prerequis : schémas et rôles Supabase (auth, storage, rôles anon/authenticated/service_role).
-- Nécessaire sur une base Postgres qui ne vient pas de Supabase. Ne pas exécuter sur une base Supabase existante.
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
  
