-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 — Close the RLS policies that are open to the anonymous key
--
-- PROBLEM
-- Policies created as `for all using (true) with check (true)` with no `TO`
-- clause apply to PUBLIC, which includes the `anon` role. The anon key ships in
-- the browser bundle by design (RLS is meant to be the boundary), so these
-- tables were readable AND writable by any unauthenticated caller:
--
--     properties, templates, teams, team_splits,
--     mailings, mailing_recipients, mailing_scans, mailing_leads
--
-- mailing_recipients holds the name + street address + city/state/ZIP of every
-- person the brokerage has mailed. properties was anonymously DELETE-able.
--
-- A ninth, agents_public_read, is `for select using (true)` — read-only, but
-- `select *` over it exposes every agent's cap_amount, default_split_pct,
-- no_brokerage_split, is_admin, auth_id and twilio_sid. The whole comp plan.
--
-- ── WHY THIS DROPS POLICIES BY ROLE, NOT BY NAME ────────────────────────────
-- The live database predates this codebase and its permissive policies are NOT
-- named `allow_all` (see migrations/production/README.md — the 2026-06-10
-- diagnostic found `agent_select`/`prop_select`/`"Allow all"`, and Phase A left
-- `properties_public_read` in place). A migration that drops by hardcoded name
-- would add the locked-down policy, leave the real permissive one untouched,
-- and — because policies OR-combine — report success while the hole stayed
-- open. That failure is silent and worse than not running at all.
--
-- So Section 2 discovers every policy on these tables that PUBLIC or `anon` can
-- use, whatever it is called, and drops it. Section 3 then creates exactly one
-- authenticated policy per table. Run Section 1 first to see what you have.
--
-- SAFETY (verified against the code before writing)
-- No public page reads any of these tables directly. Every anonymous entry
-- point already goes through a service-key serverless function, which bypasses
-- RLS and is unaffected:
--     /listing/:id, /share/:id  → api/property-public.js  (SUPABASE_SERVICE_KEY)
--     /lp/*, /m/:token, /u/:t   → api/campaigns.js        (SUPABASE_SERVICE_KEY)
--     /portal/:token            → api/portal.js           (SUPABASE_SERVICE_KEY)
-- The only anonymous table read in the client is `agents`, handled by the
-- column-limited view in Section 4.
--
-- NOT TOUCHED — these genuinely need anon INSERT and are already scoped:
--     visitor_events, lead_captures  (the website tracking snippet that
--     Settings.jsx generates posts to them with the anon key)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — DIAGNOSTIC (read-only; run this FIRST and read the output)
-- ═════════════════════════════════════════════════════════════════════════════
-- Every policy in the database that an anonymous caller can use. Anything here
-- other than visitor_events / lead_captures / campaign-images is a hole.
-- Run it again after Section 5 — the list should be down to those three.

select tablename,
       policyname,
       roles,
       cmd,
       qual        as using_expr,
       with_check  as check_expr
from pg_policies
where schemaname = 'public'
  and (roles = '{public}' or 'anon' = any(roles))
order by tablename, policyname;


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 1b — PREREQUISITE: drop the legacy v1 mailing tables
-- ═════════════════════════════════════════════════════════════════════════════
-- The 2026-08-07 diagnostic found mail_campaigns / mail_sends /
-- mail_suppressions still present in production with `allow_all` ALL policies
-- open to PUBLIC — anonymous read AND write. mail_sends holds send history
-- keyed to cold_call_leads, so this is live PII on dead tables.
--
-- They have zero code references (verified across src/ and api/), and
-- migration 0001 exists precisely to remove them. Dropping is strictly better
-- than patching policies onto tables nothing reads.
--
--   >>> RUN migrations/0001_drop_mailing_v1.sql BEFORE THIS FILE. <<<
--
-- If you would rather not drop them yet, Section 2 below locks them instead —
-- they are in its table list, so this file is safe either way.


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — Drop every anon-reachable policy on the target tables, by ROLE
-- ═════════════════════════════════════════════════════════════════════════════
-- Name-agnostic on purpose: it catches allow_all, "Allow all", agent_select,
-- prop_select, properties_public_read, mailings_public_read, and anything else
-- this database grew. Each drop is announced via RAISE NOTICE so the SQL Editor
-- output is a record of what was actually removed.
--
-- The list is the UNION of what src/lib/schema.sql creates and what the
-- 2026-08-07 production diagnostic actually found. Tables absent from a given
-- database are simply skipped — the loop reads pg_policies, so nothing here
-- errors on a table that does not exist.
--
-- Production diagnostic (2026-08-07) found these ALSO open to PUBLIC, none of
-- which the repo schema knows about:
--   campaign_scans      allow_all ALL  — orphan, no code references
--   canva_connections   allow_all ALL  — orphan, no code references; the name
--                                        implies stored OAuth credentials, so
--                                        anonymous read/write is the single
--                                        worst row in that output
--   deal_contacts       allow_all ALL  — the repo expects this DEAL-SCOPED
--                                        (deal_contacts_deal_scope); production
--                                        had it wide open, leaking which
--                                        contacts sit on which deals
--   option_values       allow_all ALL  — low sensitivity, but anonymously
--                                        WRITABLE means anyone can pollute
--                                        every dropdown in the CRM
--   mail_*              allow_all ALL  — see Section 1b
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any(array[
        -- from src/lib/schema.sql
        'properties', 'templates', 'teams', 'team_splits',
        'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads',
        -- found live by the 2026-08-07 diagnostic
        'campaign_scans', 'canva_connections', 'deal_contacts', 'option_values',
        'mail_campaigns', 'mail_sends', 'mail_suppressions'
      ])
      and (roles = '{public}' or 'anon' = any(roles))
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    raise notice 'dropped anon-reachable policy %.%', r.tablename, r.policyname;
    n := n + 1;
  end loop;
  raise notice '0027 section 2: dropped % anon-reachable policy/policies', n;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — One authenticated policy per table
-- ═════════════════════════════════════════════════════════════════════════════
-- Permissiveness for signed-in users is deliberately UNCHANGED. This migration
-- removes the anonymous role and nothing else. (Per-agent scoping of
-- `properties` is a separate, higher-risk change — see the TODO at the bottom.)
--
-- `to_regclass` skips tables this database does not have, so the same file runs
-- against production and against a fresh schema.sql install.
do $$
declare t text;
begin
  foreach t in array array[
    'properties', 'templates', 'teams', 'team_splits',
    'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads',
    'option_values',
    -- Legacy tables: only reached if 0001 has not been run yet.
    'mail_campaigns', 'mail_sends', 'mail_suppressions'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'skipping % — not present in this database', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists allow_all_authenticated on public.%I', t);
    execute format(
      'create policy allow_all_authenticated on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 3b — deal_contacts: restore the scoping the repo already expects
-- ═════════════════════════════════════════════════════════════════════════════
-- Production had `allow_all` ALL to PUBLIC on this table. src/lib/schema.sql
-- defines it as deal-scoped, and the helper it needs — app_visible_deal_ids() —
-- has been live since the 2026-06-10 Phase A bundle. So this restores intended
-- behaviour rather than introducing anything new.
do $$ begin
  if to_regclass('public.deal_contacts') is null then
    raise notice 'skipping deal_contacts — not present';
  elsif not exists (select 1 from pg_proc where proname = 'app_visible_deal_ids') then
    -- Helper missing (Phase A never applied): fall back to authenticated-only
    -- rather than locking every agent out of their own deals' contacts.
    execute 'alter table public.deal_contacts enable row level security';
    execute 'drop policy if exists allow_all_authenticated on public.deal_contacts';
    execute 'create policy allow_all_authenticated on public.deal_contacts for all to authenticated using (true) with check (true)';
    raise notice 'deal_contacts: app_visible_deal_ids() missing — locked to authenticated only';
  else
    execute 'alter table public.deal_contacts enable row level security';
    execute 'drop policy if exists allow_all_authenticated on public.deal_contacts';
    execute 'drop policy if exists deal_contacts_deal_scope on public.deal_contacts';
    execute $p$create policy deal_contacts_deal_scope on public.deal_contacts for all to authenticated
               using      (deal_id in (select app_visible_deal_ids()))
               with check (deal_id in (select app_visible_deal_ids()))$p$;
    raise notice 'deal_contacts: deal-scoped policy applied';
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 3c — Orphan tables with no code references
-- ═════════════════════════════════════════════════════════════════════════════
-- campaign_scans and canva_connections are unknown to src/lib/schema.sql and
-- have zero references across src/ and api/. canva_connections in particular
-- looks like stored integration credentials, and was anonymously read/writable.
--
-- Locked to office admins rather than merely to `authenticated`: nothing reads
-- them, so the tightest posture that still leaves them inspectable is correct.
-- Once you have confirmed they are genuinely dead, drop them (commented below).
do $$
declare t text;
begin
  foreach t in array array['campaign_scans', 'canva_connections'] loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'skipping % — not present', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_admin_only on public.%I', t, t);
    execute format(
      'create policy %I_admin_only on public.%I for all to authenticated using (app_is_admin()) with check (app_is_admin())', t, t
    );
    raise notice '% locked to office admins', t;
  end loop;
end $$;

-- After confirming they are dead:
--   drop table if exists campaign_scans    cascade;
--   drop table if exists canva_connections cascade;


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 4 — agents: column-limited public view
-- ═════════════════════════════════════════════════════════════════════════════
-- The advisor cards on /advisor/:id, /lp/* and /lead need a roster read while
-- signed out. They need exactly these ten columns — verified against every
-- `agent.<field>` reference in src/components/landing/ and src/pages/Landing*.
--
-- The view is NOT security_invoker, so it runs with the owner's rights and
-- reads through the (now authenticated-only) RLS on `agents`. That is the
-- point: anon reaches these ten columns and nothing else.
create or replace view agents_public as
  select id, name, role, tagline, bio, photo_url, color, phone, email, stats
  from agents;

grant select on agents_public to anon, authenticated;

-- Drop any anon-reachable SELECT policy on agents, whatever it is named here.
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'agents'
      and (roles = '{public}' or 'anon' = any(roles))
  loop
    execute format('drop policy %I on public.agents', r.policyname);
    raise notice 'dropped anon-reachable policy agents.%', r.policyname;
  end loop;
end $$;

drop policy if exists agents_read_authenticated on agents;
create policy agents_read_authenticated on agents
  for select to authenticated using (true);


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 5 — VERIFY (both should return zero rows)
-- ═════════════════════════════════════════════════════════════════════════════
-- 5a. Anything still anon-reachable outside the three intended exceptions:
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and (roles = '{public}' or 'anon' = any(roles))
  and tablename not in ('visitor_events', 'lead_captures');

-- 5b. Sensitive columns reachable through the public view:
select column_name
from information_schema.columns
where table_name = 'agents_public'
  and column_name in ('cap_amount','cap_anniversary','default_split_pct',
                      'no_brokerage_split','is_admin','auth_id',
                      'twilio_sid','twilio_number','nav_hidden');

-- 5c. Sanity — every table Section 3 touched must still have a working policy,
--     or signed-in agents lose access. Expect one row per table present in
--     this database (plus deal_contacts under its scoped name):
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and policyname in ('allow_all_authenticated', 'deal_contacts_deal_scope',
                     'campaign_scans_admin_only', 'canva_connections_admin_only',
                     'agents_read_authenticated')
order by tablename;

-- 5d. Smoke test from the app's own posture — run these while signed OUT
--     (Supabase SQL Editor runs as the service role, which bypasses RLS, so
--     the editor cannot prove this). Easiest check: open the deployed site in
--     a private window, then in the browser console:
--       await supabase.from('properties').select('id').limit(1)
--       await supabase.from('deal_contacts').select('id').limit(1)
--     Both must return an empty array or a permission error — never rows.
--     Then confirm /advisor/<an-agent-id> still renders its card.


-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
-- Restores the pre-0027 posture (anon read+write). Only for an emergency —
-- this reopens the hole.
--
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['properties','templates','teams','team_splits',
--                            'mailings','mailing_recipients','mailing_scans','mailing_leads'] loop
--     execute format('drop policy if exists allow_all_authenticated on public.%I', t);
--     execute format('create policy allow_all on public.%I for all using (true) with check (true)', t);
--   end loop;
-- end $$;
-- drop policy if exists agents_read_authenticated on agents;
-- create policy agents_public_read on agents for select using (true);
-- drop view if exists agents_public;


-- ─────────────────────────────────────────────────────────────────────────────
-- TODO (follow-up, deliberately NOT in this migration)
-- `properties` is now authenticated-only but still firm-wide readable by any
-- signed-in agent, while App.jsx:386 already filters client-side to
-- own + team-shared. The helper to close that gap exists and is unused:
-- app_visible_agent_ids('properties'). A correct policy must ALSO admit
-- properties reachable through a co-listed deal, or DealPage breaks for
-- co-agents:
--
--   using (app_is_admin()
--          or assigned_agent_id in (select app_visible_agent_ids('properties'))
--          or id in (select property_id from deals where id in (select app_visible_deal_ids())))
--
-- Needs a run against real data (the Pipeline listings board and the Campaigns
-- property picker are the likely regressions) before shipping.
-- ─────────────────────────────────────────────────────────────────────────────
