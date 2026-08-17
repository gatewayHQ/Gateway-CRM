-- ─────────────────────────────────────────────────────────────────────────────
-- 0033 — record_mailing_scan(): stop depending on uuid-ossp
--
-- PROBLEM (a total, silent QR outage)
-- Every scan of every QR code failed, and every scanner was shown the
-- "Opening your page…" retry page. Zero scans were recorded.
--
-- record_mailing_scan() declares `security definer` + `set search_path = public`.
-- Supabase installs the uuid-ossp extension into the `extensions` schema, not
-- `public`. So the function's very first statement —
--
--     v_scan_id uuid := coalesce(p_scan_id, uuid_generate_v4());
--
-- could not resolve uuid_generate_v4() and raised
--
--     ERROR 42883: function uuid_generate_v4() does not exist
--     CONTEXT: ... line 4 during statement block local variable initialization
--
-- Two things made this hard to see:
--
--   1. It looks like it should be harmless. The application ALWAYS passes
--      p_scan_id, so COALESCE would never need the generator. But function-name
--      resolution happens when the statement is planned, before COALESCE can
--      short-circuit — so it failed on every call regardless.
--
--   2. uuid_generate_v4() works everywhere else in this database. Table DEFAULTS
--      (every `id uuid default uuid_generate_v4()`) resolve against the SESSION
--      search_path, which on Supabase includes `extensions`. Only code that pins
--      its own search_path is affected. So campaigns could be created normally
--      while the scan path was 100% broken.
--
-- And the app could not fall back: it detects a missing RPC by matching
-- /function .*record_mailing_scan.* does not exist/, and this error names
-- uuid_generate_v4, not record_mailing_scan. So it fell through to the retry page.
--
-- FIX
-- gen_random_uuid() instead. Core Postgres (pg_catalog) since 13, so no
-- search_path can hide it and no extension need be installed. The body is
-- otherwise identical to 0031's.
--
-- Safe to run more than once, and safe before or after the app deploy:
-- `create or replace function` swaps the body atomically and the signature is
-- unchanged.
--
-- WHY NOT just widen the search_path
--   alter function record_mailing_scan(...) set search_path = public, extensions;
-- also works (verified), but it keeps a dependency on where an extension happens
-- to be installed. Removing the dependency is the durable fix.
-- ─────────────────────────────────────────────────────────────────────────────


create or replace function record_mailing_scan(
  p_token        text,
  p_scan_id      uuid    default null,
  p_visit_id     text    default null,
  p_ip_hash      text    default null,
  p_visitor_hash text    default null,
  p_user_agent   text    default null,
  p_referrer     text    default null,
  p_country      text    default null,
  p_region       text    default null,
  p_city         text    default null,
  p_latitude     text    default null,
  p_longitude    text    default null,
  p_timezone     text    default null,
  p_device_type  text    default null,
  p_os           text    default null,
  p_browser      text    default null,
  p_is_bot       boolean default false,
  p_bot_reason   text    default null,
  p_source       text    default 'qr',
  p_latency_ms   integer default null,
  p_record       boolean default true,
  p_dedupe_secs  integer default 30
)
returns table (
  mailing_id         uuid,
  name               text,
  landing_type       text,
  landing_custom_url text,
  landing_config     jsonb,
  property_id        uuid,
  status             text,
  scan_id            uuid,
  recorded           boolean,
  duplicate          boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  m            record;
  -- gen_random_uuid(), NOT uuid_generate_v4(). This function pins
  -- `set search_path = public` (below), and Supabase installs uuid-ossp into the
  -- `extensions` schema — so uuid_generate_v4() is UNRESOLVABLE from in here even
  -- though it works fine in table defaults, which resolve against the session's
  -- search_path. Name resolution happens before COALESCE short-circuits, so this
  -- failed on EVERY call even though the caller always passes p_scan_id: every
  -- QR scan errored, and every scanner got the retry page. gen_random_uuid() is
  -- core Postgres (pg_catalog), so no search_path can hide it.
  v_scan_id    uuid    := coalesce(p_scan_id, gen_random_uuid());
  v_duplicate  boolean := false;
  v_recorded   boolean := false;
  v_inserted   integer := 0;
begin
  select mg.id, mg.name, mg.landing_type, mg.landing_custom_url,
         mg.landing_config, mg.property_id, mg.status
    into m
    from mailings mg
   where mg.qr_token = p_token
   limit 1;

  -- Unknown token: return zero rows so the caller can 404 without a second trip.
  if not found then
    return;
  end if;

  if p_record then
    -- A repeat hit from the same visitor inside the window is the same physical
    -- scan (iOS preview then open, a double-tap, a refresh). Stored, flagged,
    -- and kept out of the headline count.
    if p_visitor_hash is not null then
      select exists (
        select 1 from mailing_scans s
         where s.mailing_id   = m.id
           and s.visitor_hash = p_visitor_hash
           and s.is_bot       = false
           and s.scanned_at   > now() - make_interval(secs => greatest(p_dedupe_secs, 0))
      ) into v_duplicate;
    end if;

    -- The caller owns the primary key, so a retried request or a client-side
    -- replay of a write that already landed collides here and is absorbed.
    insert into mailing_scans (
      id, mailing_id, ip_hash, visitor_hash, visit_id, user_agent, referrer,
      country, region, city, latitude, longitude, timezone,
      device_type, os, browser, is_bot, bot_reason, is_duplicate,
      source, latency_ms
    ) values (
      v_scan_id, m.id, p_ip_hash, p_visitor_hash, p_visit_id,
      left(coalesce(p_user_agent, ''), 500), left(coalesce(p_referrer, ''), 500),
      p_country, p_region, p_city, p_latitude, p_longitude, p_timezone,
      p_device_type, p_os, p_browser, coalesce(p_is_bot, false), p_bot_reason,
      v_duplicate, coalesce(p_source, 'qr'), p_latency_ms
    )
    on conflict (id) do nothing;

    get diagnostics v_inserted = row_count;
    v_recorded := v_inserted > 0;

    -- Atomic increment off the stored value — never a read-modify-write from
    -- something the application read earlier. Concurrent scans serialize on the
    -- row and every one of them counts.
    if v_recorded and not coalesce(p_is_bot, false) and not v_duplicate then
      update mailings
         set scan_count   = coalesce(scan_count, 0) + 1,
             last_scan_at = now()
       where id = m.id;
    end if;
  end if;

  return query select
    m.id, m.name, m.landing_type, m.landing_custom_url,
    m.landing_config, m.property_id, m.status,
    v_scan_id, v_recorded, v_duplicate;
end $$;



-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY — run after the above. Uncomment; it rolls back, so it stores nothing
-- and does not move any counter. Swap in a real token:
--   select qr_token from mailings limit 1;
-- Expect one row, recorded = t, no error.
-- ═════════════════════════════════════════════════════════════════════════════
-- begin;
-- select mailing_id, recorded
-- from record_mailing_scan(
--   p_token    := 'PUT_A_REAL_TOKEN_HERE',
--   p_scan_id  := gen_random_uuid(),
--   p_visit_id := 'verify',
--   p_record   := true);
-- rollback;
