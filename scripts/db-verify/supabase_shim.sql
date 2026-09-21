-- Supabase environment shims for vanilla Postgres validation
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
-- Several policies and the agents privilege guard read auth.jwt() directly
-- (schema.sql:387, migration 0023). Without it schema.sql aborts partway
-- through on vanilla Postgres and nothing after that point gets created.
create or replace function auth.jwt() returns jsonb language sql stable as
$$ select jsonb_strip_nulls(jsonb_build_object(
     'sub',   nullif(current_setting('request.jwt.claim.sub',   true), ''),
     'role',  nullif(current_setting('request.jwt.claim.role',  true), ''),
     'email', nullif(current_setting('request.jwt.claim.email', true), '')
   )) $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
-- The deal-file storage policies at the end of schema.sql (migration 0049) read
-- `owner` off storage.objects and are created against this table, so the shim
-- has to carry the column even though vanilla Postgres has no storage at all.
alter table storage.objects add column if not exists owner uuid;
-- Supabase ships storage.foldername(); nothing in schema.sql uses it today (the
-- deal id is parsed out of the path by app_storage_deal_id instead), but a
-- policy written against it later should not abort the whole file here.
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$ select string_to_array(name, '/') $$;
