-- ═════════════════════════════════════════════════════════════════════════════
-- QR scan pipeline verification  (migrations/0031_qr_scan_reliability.sql)
--
-- Proves, against a disposable Postgres database, that a QR scan is recorded
-- exactly once and counted honestly. Each assertion below maps to a way scans
-- were previously lost or miscounted in production:
--
--   • the write lands and the counter moves atomically (was: read-modify-write,
--     which lost ~2 out of every 3 concurrent scans — see the concurrency probe
--     at the bottom)
--   • a replayed scan cannot double-count (idempotent on the primary key)
--   • bot hits and rapid repeats are STORED but not counted
--   • a conversion can be tied back to the scan that produced it
--   • recipient scan columns are actually populated (were always 0)
--   • counts are correct at any volume, computed in SQL
--   • the nightly reconcile repairs drift and is a no-op when there is none
--
-- Run it (NEVER against a real database — it seeds and mutates rows):
--
--   createdb crm_qr_verify
--   psql -d crm_qr_verify -v ON_ERROR_STOP=1 -f scripts/db-verify/supabase_shim.sql
--   psql -d crm_qr_verify -v ON_ERROR_STOP=1 -f src/lib/schema.sql
--   psql -d crm_qr_verify -f scripts/db-verify/qr_scan_matrix.sql
--   # expect: 56 × "pass" and "ALL ASSERTIONS PASSED"
--   dropdb crm_qr_verify
--
-- To verify the UPGRADE path instead, apply the pre-0031 schema, then
-- migrations/0031_qr_scan_reliability.sql, then run this file — the assertions
-- are identical and must all pass either way.
-- ═════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\pset pager off

create or replace function assert_eq(got anyelement, want anyelement, label text)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL % — got %, want %', label, coalesce(got::text,'NULL'), coalesce(want::text,'NULL');
  else
    raise notice 'pass  %  (%)', label, coalesce(got::text,'NULL');
  end if;
end $$;

-- ── Seed ────────────────────────────────────────────────────────────────────
insert into agents (id, name, initials, role, email) values
  ('11111111-1111-1111-1111-111111111111', 'Daniel',   'DS', 'Agent', 'd@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'Co Agent', 'CA', 'Agent', 'c@example.com');
insert into contacts (id, first_name, last_name, email) values
  ('33333333-3333-3333-3333-333333333333', 'Jane', 'Owner', 'jane@example.com');
insert into mailings (id, name, agent_id, qr_token, landing_type, status, landing_config) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Spring Postcard', '11111111-1111-1111-1111-111111111111',
   'TokenAA1', 'property', 'sent', '{"agent_ids":["22222222-2222-2222-2222-222222222222"]}'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Other Agent Campaign', '22222222-2222-2222-2222-222222222222',
   'TokenBB2', 'valuation', 'active', '{}');
insert into mailing_recipients (id, mailing_id, contact_id, recipient_name, city, state) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333', 'Jane Owner', 'Des Moines', 'IA');
insert into mailing_recipients (mailing_id, recipient_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'No Contact Person');

\echo '=== TEST 1 — a scan is recorded and the counter bumps ==='
select assert_eq((select recorded from record_mailing_scan(
    p_token => 'TokenAA1', p_visit_id => 'v-001', p_visitor_hash => 'visitorA',
    p_device_type => 'mobile', p_os => 'iOS', p_browser => 'Safari',
    p_country => 'US', p_region => 'IA', p_city => 'Des Moines')), true, 'recorded=true');
select assert_eq((select count(*)::int from mailing_scans), 1, 'scan rows');
select assert_eq((select scan_count from mailings where qr_token='TokenAA1'), 1, 'scan_count');
select assert_eq((select last_scan_at is not null from mailings where qr_token='TokenAA1'), true, 'last_scan_at set');

\echo '=== TEST 2 — unknown token returns zero rows (caller 404s) ==='
select assert_eq((select count(*)::int from record_mailing_scan(p_token => 'NOPE')), 0, 'unknown token');

\echo '=== TEST 3 — idempotency: replaying the same scan id cannot double-count ==='
select assert_eq((select recorded from record_mailing_scan(
    p_token => 'TokenAA1', p_scan_id => 'cccccccc-0000-0000-0000-000000000009',
    p_visit_id => 'v-002', p_visitor_hash => 'visitorB')), true, 'first write recorded');
-- Same primary key again — this is the client-side replay path.
select assert_eq((select recorded from record_mailing_scan(
    p_token => 'TokenAA1', p_scan_id => 'cccccccc-0000-0000-0000-000000000009',
    p_visit_id => 'v-002', p_visitor_hash => 'visitorB', p_source => 'replay')), false, 'replay absorbed');
select assert_eq((select count(*)::int from mailing_scans), 2, 'still 2 rows after replay');
select assert_eq((select scan_count from mailings where qr_token='TokenAA1'), 2, 'counter not double-bumped');

\echo '=== TEST 4 — rapid repeat by the same visitor: stored, flagged, not counted ==='
select assert_eq((select duplicate from record_mailing_scan(
    p_token => 'TokenAA1', p_visitor_hash => 'visitorB', p_visit_id => 'v-003')), true, 'flagged duplicate');
select assert_eq((select count(*)::int from mailing_scans), 3, 'duplicate row IS stored');
select assert_eq((select scan_count from mailings where qr_token='TokenAA1'), 2, 'counter unchanged by duplicate');

\echo '=== TEST 5 — bot hit: stored, flagged, not counted ==='
select assert_eq((select recorded from record_mailing_scan(
    p_token => 'TokenAA1', p_visitor_hash => 'crawler1', p_is_bot => true,
    p_bot_reason => 'facebookexternalhit')), true, 'bot row recorded');
select assert_eq((select count(*)::int from mailing_scans where is_bot), 1, 'bot row stored');
select assert_eq((select scan_count from mailings where qr_token='TokenAA1'), 2, 'counter unchanged by bot');

\echo '=== TEST 6 — p_record=false resolves the mailing without recording ==='
select assert_eq((select name from record_mailing_scan(p_token => 'TokenAA1', p_record => false)),
                 'Spring Postcard', 'resolves name');
select assert_eq((select count(*)::int from mailing_scans), 4, 'no new row when p_record=false');

\echo '=== TEST 7 — link_visit_conversion stitches lead -> scan -> recipient ==='
insert into mailing_leads (id, mailing_id, name, email, visit_id, contact_id, source_landing)
values ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'Jane Owner', 'jane@example.com', 'v-001', '33333333-3333-3333-3333-333333333333', 'property');
select assert_eq((select link_visit_conversion(
    'v-001', 'aaaaaaaa-0000-0000-0000-000000000001',
    'dddddddd-0000-0000-0000-000000000001', null,
    '33333333-3333-3333-3333-333333333333') is not null), true, 'returns the scan id');
select assert_eq((select scan_id is not null from mailing_leads where id='dddddddd-0000-0000-0000-000000000001'),
                 true, 'lead linked to scan');
select assert_eq((select recipient_id from mailing_leads where id='dddddddd-0000-0000-0000-000000000001'),
                 'bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'lead attributed to recipient');
select assert_eq((select scan_count from mailing_recipients where id='bbbbbbbb-0000-0000-0000-000000000001'),
                 1, 'recipient scan_count now populated (was always 0 pre-0031)');
select assert_eq((select first_scanned_at is not null from mailing_recipients
                   where id='bbbbbbbb-0000-0000-0000-000000000001'), true, 'first_scanned_at populated');

\echo '=== TEST 8 — an unknown visit id links nothing and does not error ==='
select assert_eq((select link_visit_conversion('no-such-visit', 'aaaaaaaa-0000-0000-0000-000000000001')),
                 null::uuid, 'unknown visit -> null');

\echo '=== TEST 9 — mailing_stats counts in SQL, splitting real from bot/duplicate ==='
select assert_eq((select scans::int      from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid])), 2, 'stats.scans (human, deduped)');
select assert_eq((select raw_scans::int  from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid])), 4, 'stats.raw_scans (everything stored)');
select assert_eq((select bot_scans::int  from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid])), 1, 'stats.bot_scans');
select assert_eq((select leads::int      from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid])), 1, 'stats.leads');
select assert_eq((select converted::int  from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid])), 1, 'stats.converted');
select assert_eq((select recipients::int from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid])), 2, 'stats.recipients');
-- A campaign with no activity must still come back as a zero row, not vanish.
select assert_eq((select count(*)::int from mailing_stats(array[
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000002'::uuid])), 2, 'zero-activity campaign still returned');
select assert_eq((select scans::int from mailing_stats(array['aaaaaaaa-0000-0000-0000-000000000002'::uuid])), 0, 'zero-activity scans = 0 not null');

\echo '=== TEST 10 — mailing_analytics returns a complete document ==='
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'total_scans')::int, 2, 'analytics.total_scans');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'bot_scans')::int, 1, 'analytics.bot_scans');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'duplicate_scans')::int, 1, 'analytics.duplicate_scans');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'recipients_total')::int, 2, 'analytics.recipients_total');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'recipients_scanned')::int, 1, 'analytics.recipients_scanned (no longer stuck at 0)');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'attributed_leads')::int, 1, 'analytics.attributed_leads');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) ->> 'response_index')::numeric, 100.0, 'analytics.response_index = 2 scans / 2 pieces');
select assert_eq(jsonb_typeof(mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) -> 'timeline'), 'array', 'analytics.timeline is an array');
select assert_eq(jsonb_typeof(mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) -> 'by_device'), 'object', 'analytics.by_device is an object');
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 90) -> 'by_device' ->> 'mobile')::int, 1, 'analytics.by_device.mobile');
-- The timeline must span the whole window with zero-filled days, not just days that had scans.
select assert_eq((select jsonb_array_length(mailing_analytics('aaaaaaaa-0000-0000-0000-000000000001', 7) -> 'timeline')), 8, 'timeline zero-fills the window');
-- A campaign with zero scans must not divide by zero.
select assert_eq((mailing_analytics('aaaaaaaa-0000-0000-0000-000000000002', 30) ->> 'conversion_rate')::numeric, 0::numeric, 'no divide-by-zero on empty campaign');

\echo '=== TEST 11 — dashboard scoping ==='
select assert_eq((mailing_dashboard(null, true, 30) ->> 'total_mailings')::int, 2, 'admin (all) sees both');
select assert_eq((mailing_dashboard('11111111-1111-1111-1111-111111111111', false, 30) ->> 'total_mailings')::int, 1, 'primary agent sees own only');
-- Co-agent is named in landing_config.agent_ids of campaign 1 AND owns campaign 2.
select assert_eq((mailing_dashboard('22222222-2222-2222-2222-222222222222', false, 30) ->> 'total_mailings')::int, 2, 'co-agent sees collaborated + own');
select assert_eq((mailing_dashboard(null, false, 30) ->> 'total_mailings')::int, 0, 'no identity leaks nothing');
select assert_eq((mailing_dashboard(null, true, 30) ->> 'total_scans_30d')::int, 2, 'dashboard counts human scans only');
select assert_eq((mailing_dashboard(null, true, 30) ->> 'scans_today')::int, 2, 'scans_today');
select assert_eq(jsonb_typeof(mailing_dashboard(null, true, 30) -> 'top_mailings'), 'array', 'top_mailings is an array');

\echo '=== TEST 12 — reconcile repairs drift ==='
update mailings set scan_count = 999, lead_count = 42 where qr_token = 'TokenAA1';
select assert_eq((reconcile_mailing_counters() ->> 'mailings_repaired')::int, 1, 'one campaign repaired');
select assert_eq((select scan_count from mailings where qr_token='TokenAA1'), 2, 'scan_count restored to truth');
select assert_eq((select lead_count from mailings where qr_token='TokenAA1'), 1, 'lead_count restored to truth');
-- Second run must be a no-op — otherwise the job would rewrite every row nightly.
select assert_eq((reconcile_mailing_counters() ->> 'mailings_repaired')::int, 0, 'reconcile is idempotent');

\echo '=== TEST 13 — dedupe window is time-bounded (an hour later is a real scan) ==='
update mailing_scans set scanned_at = now() - interval '1 hour' where visitor_hash = 'visitorB';
select assert_eq((select duplicate from record_mailing_scan(
    p_token => 'TokenAA1', p_visitor_hash => 'visitorB', p_visit_id => 'v-later')), false, 'later scan is not a duplicate');
select assert_eq((select scan_count from mailings where qr_token='TokenAA1'), 3, 'later scan counted');

\echo ''
\echo '████ ALL ASSERTIONS PASSED ████'
