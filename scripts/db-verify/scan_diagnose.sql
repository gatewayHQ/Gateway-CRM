-- ═════════════════════════════════════════════════════════════════════════════
-- Why is a QR code showing "Opening your page…" instead of the landing page?
--
-- SAFE TO RUN AGAINST PRODUCTION. Checks A–D are read-only. Check E performs a
-- real call inside an explicit transaction that is ROLLED BACK, so it surfaces
-- the true error without storing a scan row (verified: row count unchanged).
--
-- WHAT THAT PAGE MEANS
-- "Opening your page…" is api/campaigns.js's last-resort retry page. The scan
-- endpoint reached it because record_mailing_scan() gave it no destination — the
-- function resolves the token AND writes the scan AND bumps the counter in one
-- round trip, so ANY failure inside it used to leave the handler with nothing to
-- redirect to. The app now falls back to a plain `mailings` lookup so the visitor
-- still lands on the page, but that fallback is a safety net, not a fix: while
-- the RPC is broken, counts are carried by a direct insert and the atomic counter
-- is left to the nightly reconcile. This script finds the underlying cause.
--
-- HOW TO USE
-- Replace the token on the next line with the one from the QR code that failed
-- (the part after /m/ in the URL), then run the whole file.
-- ═════════════════════════════════════════════════════════════════════════════

\set tok 'NLBK8k6W'


-- ── A. Is the tracking function there at all? ───────────────────────────────
--   1 (or more) → present. Move on.
--   0           → migration 0031 was never applied. The app detects this case
--                 and uses its pre-0031 insert path, so this alone does NOT
--                 cause the retry page — but apply 0031 to get atomic counting.
select 'A. record_mailing_scan overloads' as check,
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'record_mailing_scan')::text as result;


-- ── B. Does this token exist, and where should it send people? ──────────────
--   ONE ROW  → the campaign is fine; the problem is the write, not the data.
--   NO ROWS  → this token is not in the database. The QR code points at a
--              campaign that was deleted, or the code was printed from a
--              different environment than the one this database serves. The app
--              answers a missing token with a 404, not the retry page, so if you
--              are seeing the spinner AND this returns no rows, you are looking
--              at two different databases — check which Supabase project the
--              deployment's SUPABASE_URL actually points to.
select 'B. token' as check, id, name, status, landing_type,
       case when landing_type = 'custom' then landing_custom_url
            else '/lp/' || landing_type || '/' || id end as destination,
       (landing_config is null or landing_config = '{}'::jsonb) as config_empty
from mailings
where qr_token = :'tok';


-- ── C. Columns the function writes that mailing_scans does not have ─────────
-- The most common real cause: 0031's function was created but its ALTER TABLE
-- additions were not (a partially-applied migration, or the file was run past an
-- error). The function then fails on every scan with
-- 'column "…" of relation "mailing_scans" does not exist'.
--
--   NO ROWS  → the table is complete.
--   ANY ROW  → re-run migrations/0031_qr_scan_reliability.sql. It is idempotent.
select 'C. missing column on mailing_scans' as check, c as column_name
from unnest(array[
  'id','mailing_id','ip_hash','visitor_hash','visit_id','user_agent','referrer',
  'country','region','city','latitude','longitude','timezone',
  'device_type','os','browser','is_bot','bot_reason','is_duplicate',
  'source','latency_ms','scanned_at'
]) c
where not exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'mailing_scans' and column_name = c
);


-- ── D. Resolve-only dry run ─────────────────────────────────────────────────
-- p_record := false skips the write entirely, exercising only the half that
-- produces the redirect. Writes nothing.
--
--   ONE ROW  → resolving works. The failure is in the write half; see E.
--   NO ROWS  → the function cannot find this token (compare with B).
--   ERROR    → read the message; that is your root cause.
select 'D. resolve dry-run' as check, mailing_id, landing_type, status
from record_mailing_scan(p_token := :'tok', p_record := false);


-- ── E. The real call, rolled back ───────────────────────────────────────────
-- This is the one that reproduces what the scan endpoint actually hits, write
-- included. The ROLLBACK means no scan row survives and no counter moves.
--
--   ONE ROW with recorded = t → the whole pipeline is healthy. If scans are
--     still not appearing, the problem is not in the database: check that the
--     deployment's SUPABASE_URL / SUPABASE_SERVICE_KEY point at THIS project,
--     and look for 'scan write unconfirmed' in the Vercel function logs.
--   ERROR → the message is the cause of the retry page. Fix that, and the atomic
--     path resumes on the next scan.
begin;
select 'E. full call (rolled back)' as check, mailing_id, recorded, duplicate
from record_mailing_scan(
  p_token       := :'tok',
  p_scan_id     := gen_random_uuid(),
  p_visit_id    := 'diagnostic',
  p_visitor_hash:= 'diagnostic',
  p_source      := 'diagnostic',
  p_record      := true
);
rollback;


-- ── F. Recent scan activity, for context ────────────────────────────────────
-- If the newest row is older than the mail drop, scans are not landing at all.
select 'F. recent scans' as check,
       count(*)                        as scans_total,
       count(*) filter (where not is_bot) as scans_human,
       max(scanned_at)                 as newest
from mailing_scans s
join mailings m on m.id = s.mailing_id
where m.qr_token = :'tok';
