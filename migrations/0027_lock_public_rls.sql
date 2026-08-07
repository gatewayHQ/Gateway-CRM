-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 — Close the RLS policies that default to PUBLIC (anon)
--
-- PROBLEM
-- Eight policies were created as:
--     create policy "allow_all" on <t> for all using (true) with check (true);
-- With no `TO` clause, Postgres applies a policy to PUBLIC — which includes the
-- `anon` role. The anon key ships in the browser bundle by design (RLS is meant
-- to be the boundary), so these eight tables were readable AND writable by any
-- unauthenticated caller:
--
--     properties, templates, teams, team_splits,
--     mailings, mailing_recipients, mailing_scans, mailing_leads
--
-- mailing_recipients holds the name + street address + city/state/ZIP of every
-- person the brokerage has mailed. properties was anonymously DELETE-able.
--
-- A ninth policy, agents_public_read, is `for select using (true)` — also
-- PUBLIC. It is READ-only, but `select *` over it exposes every agent's
-- cap_amount, default_split_pct, no_brokerage_split, is_admin, auth_id and
-- twilio_sid — i.e. the whole comp plan — to anyone with the anon key.
--
-- SAFETY OF THIS CHANGE (verified against the code before writing)
-- No public page reads any of the eight tables directly. Every anonymous entry
-- point already goes through a service-key serverless function, which bypasses
-- RLS and is unaffected:
--     /listing/:id, /share/:id  → api/property-public.js  (SUPABASE_SERVICE_KEY)
--     /lp/*, /m/:token, /u/:t   → api/campaigns.js        (SUPABASE_SERVICE_KEY)
--     /portal/:token            → api/portal.js           (SUPABASE_SERVICE_KEY)
-- The ONLY anonymous table read in the client is `agents`, handled below by a
-- column-limited view.
--
-- NOT TOUCHED (already correctly scoped, and genuinely need anon INSERT):
--     visitor_events, lead_captures — written by the external website tracking
--     snippet that Settings.jsx generates, which posts with the anon key.
--
-- REVERSIBILITY
-- Every statement is a policy swap. To roll back, re-create the dropped
-- policies without the `to authenticated` clause (see the rollback block at the
-- bottom of this file).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The eight allow_all tables ────────────────────────────────────────────
-- Permissiveness for signed-in users is deliberately UNCHANGED — this migration
-- only removes the anonymous role. Per-agent scoping of `properties` is a
-- separate, higher-risk change; see the TODO at the end of this file.
do $$
declare t text;
begin
  foreach t in array array[
    'properties', 'templates', 'teams', 'team_splits',
    'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists allow_all on %I', t);
    execute format(
      'create policy allow_all_authenticated on %I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;

-- Guard against re-running an older copy of schema.sql (whose do-blocks are
-- `if not exists` guarded on the name 'allow_all' and would happily re-add the
-- PUBLIC policy alongside ours). Dropping by name is idempotent.
drop policy if exists allow_all on properties;
drop policy if exists allow_all on templates;
drop policy if exists allow_all on teams;
drop policy if exists allow_all on team_splits;
drop policy if exists allow_all on mailings;
drop policy if exists allow_all on mailing_recipients;
drop policy if exists allow_all on mailing_scans;
drop policy if exists allow_all on mailing_leads;

-- ── 2. agents: column-limited public view ────────────────────────────────────
-- The advisor cards on the landing pages (/advisor/:id, /lp/*, /lead) need a
-- roster read while signed out. They need exactly these ten columns and no
-- others — verified against every `agent.<field>` reference in
-- src/components/landing/ and src/pages/Landing*.jsx.
--
-- The view is NOT security_invoker, so it runs with the owner's rights and
-- reads through the (now authenticated-only) RLS on `agents`. That is the
-- point: anon reaches these ten columns and nothing else.
create or replace view agents_public as
  select id, name, role, tagline, bio, photo_url, color, phone, email, stats
  from agents;

grant select on agents_public to anon, authenticated;

-- Now that the public path is served by the view, the base table's read policy
-- no longer needs to be open to anon.
drop policy if exists agents_public_read on agents;
create policy agents_read_authenticated on agents
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY  (run after applying; both should return zero rows)
-- ─────────────────────────────────────────────────────────────────────────────
-- Any remaining policy that PUBLIC/anon can use:
--   select tablename, policyname, roles, cmd
--   from pg_policies
--   where schemaname = 'public'
--     and (roles = '{public}' or 'anon' = any(roles))
--     and tablename not in ('visitor_events', 'lead_captures');
--
-- Sensitive columns reachable through the public view:
--   select column_name from information_schema.columns
--   where table_name = 'agents_public'
--     and column_name in ('cap_amount','default_split_pct','no_brokerage_split',
--                         'is_admin','auth_id','twilio_sid','twilio_number');

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['properties','templates','teams','team_splits',
--                            'mailings','mailing_recipients','mailing_scans','mailing_leads'] loop
--     execute format('drop policy if exists allow_all_authenticated on %I', t);
--     execute format('create policy allow_all on %I for all using (true) with check (true)', t);
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
-- app_visible_agent_ids('properties') in src/lib/schema.sql:1445.
-- A correct policy must ALSO admit properties reachable through a co-listed
-- deal, or DealPage breaks for co-agents:
--
--   using (app_is_admin()
--          or assigned_agent_id in (select app_visible_agent_ids('properties'))
--          or id in (select property_id from deals where id in (select app_visible_deal_ids())))
--
-- Needs a run against real data (Pipeline listings board + the Campaigns
-- property picker are the two most likely regressions) before shipping.
-- ─────────────────────────────────────────────────────────────────────────────
