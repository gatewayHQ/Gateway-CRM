-- ═════════════════════════════════════════════════════════════════════════════
-- Why is a QR code showing "Opening your page…" instead of the landing page?
--
-- SAFE TO RUN AGAINST PRODUCTION. Blocks 1 and 2 are read-only. Block 3 performs
-- a real call inside an explicit transaction that is ROLLED BACK — verified to
-- leave both mailing_scans and mailings.scan_count unchanged.
--
-- ── HOW TO RUN IT (Supabase SQL Editor) ─────────────────────────────────────
-- Run the three blocks ONE AT A TIME (paste one, or highlight it and run the
-- selection). The editor returns only the LAST statement's result when several
-- are run together, and block 3 must not swallow the output of blocks 1-2.
--
-- Set the token first: replace NLBK8k6W everywhere below with the code from the
-- QR that failed — the part after /m/ in the URL. There are 4 occurrences.
--
-- NOTE: no psql \set here on purpose. Backslash commands are a psql CLIENT
-- feature; the Supabase editor sends raw SQL to the server, which answers
-- `syntax error at or near "\"`. Everything below is plain SQL.
--
-- ── WHAT THAT PAGE MEANS ────────────────────────────────────────────────────
-- "Opening your page…" is api/campaigns.js's last-resort retry page, reached
-- when the scan endpoint has no destination to redirect to. record_mailing_scan()
-- resolves the token AND writes the scan AND bumps the counter in one round trip,
-- so ANY failure inside it used to leave the handler with nothing. The app now
-- falls back to a plain `mailings` lookup so the visitor still lands on the page,
-- but that is a safety net, not a fix: while the RPC is broken the scan is stored
-- by a direct insert and the atomic counter is left to the nightly reconcile.
-- This script finds the underlying cause.
-- ═════════════════════════════════════════════════════════════════════════════


-- ═══ BLOCK 1 — catalog checks (read-only, cannot fail) ═══════════════════════
--
-- A. record_mailing_scan overloads
--      1+  present, move on
--      0   migration 0031 never applied. The app detects this and uses its
--          pre-0031 insert path, so this alone does NOT cause the retry page —
--          but apply 0031 to get atomic counting.
--
-- B. token rows found
--      1   the campaign is fine; the problem is the write, not the data
--      0   this token is not in THIS database. The app answers a missing token
--          with a 404, not the spinner — so if you see the spinner AND this is 0,
--          you are looking at two different databases. Check which project the
--          deployment's SUPABASE_URL points at.
--
-- C. MISSING column on mailing_scans  ← the most common real cause
--      no rows  table is complete
--      any row  0031's function was created but its ALTER TABLE additions were
--               not, so the function fails on every scan with
--               'column "…" of relation "mailing_scans" does not exist'.
--               Re-run migrations/0031_qr_scan_reliability.sql (idempotent).
select ord, "check", value, note from (
  select 1 as ord, 'A. record_mailing_scan overloads' as "check",
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'record_mailing_scan')::text as value,
    '0 = migration 0031 never applied' as note
  union all
  select 2, 'B. token rows found', count(*)::text,
    coalesce(string_agg(status || '  ->  ' ||
      case when landing_type = 'custom' then coalesce(landing_custom_url, '(custom but NO url saved)')
           else '/lp/' || landing_type || '/' || id end, ' | '),
      'NO ROWS - this token is not in this database')
  from mailings where qr_token = 'NLBK8k6W'
  union all
  select 3, 'C. MISSING column on mailing_scans', c,
    'any row here = 0031 partially applied; re-run it (idempotent)'
  from unnest(array[
    'id','mailing_id','ip_hash','visitor_hash','visit_id','user_agent','referrer',
    'country','region','city','latitude','longitude','timezone',
    'device_type','os','browser','is_bot','bot_reason','is_duplicate',
    'source','latency_ms','scanned_at']) c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mailing_scans' and column_name = c)
) t order by ord, value;


-- ═══ BLOCK 2 — resolve-only dry run (writes nothing) ═════════════════════════
-- p_record := false skips the write entirely, exercising only the half that
-- produces the redirect.
--   ONE ROW  resolving works; the failure is in the write half, see block 3
--   NO ROWS  the function cannot find this token (compare with B)
--   ERROR    read the message, that is your root cause
select 'D. resolve dry-run' as "check", mailing_id, landing_type, status
from record_mailing_scan(p_token := 'NLBK8k6W', p_record := false);


-- ═══ BLOCK 3 — the real call, rolled back ════════════════════════════════════
-- Reproduces exactly what the scan endpoint hits, write included. The ROLLBACK
-- means no scan row survives and no counter moves.
--   ONE ROW, recorded = t  the whole pipeline is healthy. If scans still are not
--     appearing, the problem is not the database: confirm the deployment's
--     SUPABASE_URL / SUPABASE_SERVICE_KEY point at THIS project, and search the
--     Vercel function logs for 'scan write unconfirmed'.
--   ERROR  the message is the cause of the retry page. Fix it and the atomic
--     path resumes on the next scan.
begin;
select 'E. full call (rolled back)' as "check", mailing_id, recorded, duplicate
from record_mailing_scan(
  p_token        := 'NLBK8k6W',
  p_scan_id      := gen_random_uuid(),
  p_visit_id     := 'diagnostic',
  p_visitor_hash := 'diagnostic',
  p_source       := 'diagnostic',
  p_record       := true
);
rollback;


-- ═══ Optional — recent scan activity for this token (read-only) ══════════════
-- If the newest row predates the mail drop, scans are not landing at all.
select 'F. recent scans' as "check",
       count(*)                           as scans_total,
       count(*) filter (where not is_bot)  as scans_human,
       max(scanned_at)                     as newest
from mailing_scans s
join mailings m on m.id = s.mailing_id
where m.qr_token = 'NLBK8k6W';
