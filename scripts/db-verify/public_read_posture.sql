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
-- The consolidated query below returns everything in ONE result set, because the
-- Supabase SQL Editor shows only the LAST statement's result when several are run
-- together. The first three rows are the answer; the rest is supporting detail.
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════

with closed(t) as (
  values ('properties'),('templates'),('teams'),('team_splits'),
         ('mailings'),('mailing_recipients'),('mailing_scans'),('mailing_leads')
),
anon_open as (
  select tablename, policyname, cmd, roles from pg_policies
  where schemaname = 'public'
    and tablename in (select t from closed)
    and (roles = '{public}' or 'anon' = any(roles))
),
auth_ok as (
  select tablename from pg_policies
  where schemaname = 'public' and 'authenticated' = any(roles)
  group by tablename
),
missing_auth as (
  select c.t from closed c
  where to_regclass('public.' || c.t) is not null
    and c.t not in (select tablename from auth_ok)
)
select * from (
  -- 1. Is 0027 applied? Zero anon-reachable policies on those eight tables = yes.
  select 1 as ord, 'VERDICT' as section,
    case when (select count(*) from anon_open) = 0
      then 'PASS  0027 is applied - none of the 8 tables are anon-reachable'
      else 'ACTION  ' || (select count(*) from anon_open) ||
           ' anon-reachable policy(ies) remain - 0027 is NOT fully applied'
    end as item, '' as detail
  union all
  -- 2. The opposite failure: a locked table with no policy for signed-in users
  --    locks the agents out of their own CRM. Worse than the anon hole.
  select 2, 'VERDICT',
    case when (select count(*) from missing_auth) = 0
      then 'PASS  every one of those tables still has an authenticated policy'
      else 'ACTION  NO authenticated policy on: ' ||
           (select string_agg(t, ', ') from missing_auth) ||
           '  <- signed-in agents are locked out, fix this first'
    end, ''
  union all
  -- 3. agents_public is the one anonymous read the app still makes (advisor
  --    cards), so it must exist AND stay column-limited.
  select 3, 'VERDICT',
    case
      when to_regclass('public.agents_public') is null
        then 'ACTION  agents_public view is MISSING (0027 sec.4 not applied) - advisor cards will be blank'
      when exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'agents_public'
          and column_name in ('cap_amount','cap_anniversary','default_split_pct',
                              'no_brokerage_split','is_admin','auth_id',
                              'twilio_sid','twilio_number','nav_hidden'))
        then 'ACTION  agents_public EXPOSES a sensitive column - see section 3 below'
      else 'PASS  agents_public exists with ' ||
           (select count(*) from information_schema.columns
            where table_schema = 'public' and table_name = 'agents_public') ||
           ' columns, none sensitive'
    end, ''
  union all
  select 4, '1. anon-reachable on 0027 tables', tablename || '.' || policyname,
         cmd || '   roles=' || roles::text from anon_open
  union all
  select 5, '2. authenticated policy present', tablename, 'ok' from auth_ok
  where tablename in (select t from closed)
  union all
  select 6, '3. agents_public columns', column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'agents_public'
  union all
  -- 4. Whole-database sweep. visitor_events / lead_captures are intentional:
  --    the website tracking snippet posts to them with the anon key.
  select 7, '4. anon-reachable anywhere else', tablename || '.' || policyname,
         cmd || '   roles=' || roles::text
  from pg_policies
  where schemaname = 'public'
    and (roles = '{public}' or 'anon' = any(roles))
    and tablename not in ('visitor_events', 'lead_captures')
) t order by ord, item;
