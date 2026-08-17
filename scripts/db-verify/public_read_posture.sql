-- ═════════════════════════════════════════════════════════════════════════════
-- Public-read posture check  (migration 0027_lock_public_rls.sql)
--
-- READ-ONLY. Every statement is a SELECT — nothing is created, altered or
-- dropped. Unlike the other files in this folder, this one is SAFE TO RUN
-- AGAINST PRODUCTION, and is meant to be: paste it into the Supabase SQL Editor.
--
-- WHAT IT IS FOR
-- 0027 closed eight tables to the `anon` role. That was correct, but its safety
-- audit was written by reading api/ and not the SPA router, so it missed that
-- four QR landing pages, the public listing page, the share card and the public
-- listings feed all read those tables as anon. The app-side fixes route every
-- one of them through a service-key endpoint instead.
--
-- NO MIGRATION IS REQUIRED FOR THOSE FIXES — service-role reads bypass RLS, so
-- there is nothing to grant. This script exists to answer the question the fixes
-- raise: *is 0027 actually applied to this database, and is the posture what we
-- think it is?* The repo cannot answer that (0027_lock_public_rls.sql duplicates
-- the number 0027 and never made it into the apply-order table in
-- migrations/README.md), so ask the database.
--
-- Read the four results top to bottom; each says what a good answer looks like.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── 1. Is 0027 applied? ──────────────────────────────────────────────────────
-- Lists every policy an anonymous caller can use on the eight tables 0027
-- closed.
--
--   ZERO ROWS   → 0027 is applied. Expected. The app fixes are what make the
--                 public pages work again; nothing further to do here.
--   SOME ROWS   → 0027 is NOT fully applied on those tables, so they are still
--                 anonymously readable (and, if cmd is ALL, writable). The app
--                 fixes are still correct and still work — they just are not
--                 yet load-bearing. Apply 0027 to close the hole.
select 'anon-reachable policy on a table 0027 closes' as finding,
       tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('properties', 'templates', 'teams', 'team_splits',
                    'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads')
  and (roles = '{public}' or 'anon' = any(roles))
order by tablename, policyname;


-- ── 2. Can signed-in agents still use those tables? ──────────────────────────
-- The failure mode on the other side: a table locked with no working policy for
-- authenticated users locks the agents out of their own CRM.
--
--   Expect one row per table that exists in this database.
--   A MISSING table name here means nobody can read it — investigate before
--   anything else, this is worse than the anon hole.
select 'authenticated policy present' as finding,
       tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('properties', 'templates', 'teams', 'team_splits',
                    'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads')
  and 'authenticated' = any(roles)
order by tablename;


-- ── 3. Does the advisor-card view exist, and is it still narrow? ─────────────
-- The landing pages read `agents_public` (granted to anon on purpose) for the
-- advisor cards. This is the one anonymous table-ish read the app still makes,
-- so it is the one that must stay column-limited.
--
--   Expect exactly: id, name, role, tagline, bio, photo_url, color, phone, email,
--   stats — and NOTHING resembling cap_amount, default_split_pct, is_admin,
--   auth_id or twilio_*. If the view is missing entirely, 0027 §4 was not
--   applied and the advisor cards will be blank (the pages still render).
select 'agents_public column' as finding, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'agents_public'
order by ordinal_position;


-- ── 4. Anything else still open to anon, anywhere? ───────────────────────────
-- The whole-database sweep. `visitor_events` and `lead_captures` are intentional
-- (the website tracking snippet posts to them with the anon key), as is any
-- storage policy for the public campaign-images bucket.
--
--   Expect ONLY those. Anything else — especially a table holding credentials,
--   contacts or addresses — is a hole worth closing.
select 'still anon-reachable' as finding,
       tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and (roles = '{public}' or 'anon' = any(roles))
  and tablename not in ('visitor_events', 'lead_captures')
order by tablename, policyname;
