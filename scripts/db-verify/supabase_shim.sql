-- Supabase environment shims for vanilla Postgres validation
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
-- Mirrors Supabase's own auth.jwt(): the whole claim set as jsonb, null when
-- unset. Needed since migration 0023 — the agents policies and the
-- agents_guard_privileged trigger read auth.jwt() ->> 'email' / 'role', so
-- schema.sql fails to load without it.
create or replace function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(
     nullif(current_setting('request.jwt.claim',  true), ''),
     nullif(current_setting('request.jwt.claims', true), '')
   )::jsonb $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
