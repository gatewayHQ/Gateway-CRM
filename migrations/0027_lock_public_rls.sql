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
-- SECTION 2 — Drop every anon-reachable policy on the eight tables, by ROLE
-- ═════════════════════════════════════════════════════════════════════════════
-- Name-agnostic on purpose: it catches allow_all, "Allow all", agent_select,
-- prop_select, properties_public_read, and anything else this database grew.
-- Each drop is announced via RAISE NOTICE so the SQL Editor output is a record
-- of what was actually removed.
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
        'properties', 'templates', 'teams', 'team_splits',
        'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads'
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
do $$
declare t text;
begin
  foreach t in array array[
    'properties', 'templates', 'teams', 'team_splits',
    'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists allow_all_authenticated on public.%I', t);
    execute format(
      'create policy allow_all_authenticated on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
  raise notice '0027 section 3: authenticated policies in place on 8 tables';
end $$;


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

-- 5c. Sanity — every one of the eight tables must still have a working
--     authenticated policy (expect 8 rows):
select tablename, policyname
from pg_policies
where schemaname = 'public'
  and policyname = 'allow_all_authenticated'
order by tablename;


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
