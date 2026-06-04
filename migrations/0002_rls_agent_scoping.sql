-- Migration 0002 — Real RLS: enforce agent/team scoping in the database
-- ===========================================================================
-- WHY
--   Today every table has `allow_all using(true)`, and data isolation is done
--   ONLY client-side (App.jsx filters with .in('assigned_agent_id', ...)). Any
--   authenticated user can read every row by issuing an unfiltered query. This
--   migration moves the existing agent/team scoping INTO the database so it is
--   enforced regardless of the client.
--
-- SCOPE (first cut — the genuinely-private, non-public-read tables)
--   contacts, deals, tasks, commissions, activities
--
-- DELIBERATELY EXCLUDED (see notes at bottom — follow-up work)
--   • properties — read anonymously by the public PropertyLanding page
--   • templates, agents, team_splits — currently shared across all agents;
--     locking them down would CHANGE current behavior
--   • ghost/ad-hoc tables (cold_call_*, sequences, conversations, etc.) — not
--     yet consolidated into schema.sql; harden after migration 0003
--
-- SAFETY MODEL — this file is split into phases:
--   PHASE A  Create helper functions + scoped policies. Because the existing
--            `allow_all` permissive policy is OR-combined with these, the
--            tables STAY fully open. Applying Phase A changes NOTHING that a
--            user can observe. Safe to run in production immediately.
--   PHASE B  Drop `allow_all` on the five tables. THIS activates enforcement.
--            Run it only after the verification checklist passes. Easy to
--            reverse (PHASE B-ROLLBACK recreates allow_all instantly).
--
-- The app's authenticated client carries the user JWT, so auth.uid() resolves.
-- All /api/* serverless functions use the SERVICE key and bypass RLS, so
-- webhooks, cron (sequence-run), Twilio, DocuSign, and campaign tracking are
-- unaffected.
-- ===========================================================================


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE A — helpers + scoped policies (no behavioral change while allow_all exists)
-- ───────────────────────────────────────────────────────────────────────────

-- The agent row for the currently authenticated user.
create or replace function app_current_agent_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select id from agents where auth_id = auth.uid() limit 1;
$$;

-- Whether the current user is an admin (mirrors App.jsx role check).
create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(role ilike '%admin%'), false)
  from agents where auth_id = auth.uid();
$$;

-- The set of agent_ids whose data the current user may see for a given
-- dimension. Mirrors App.jsx: self + team peers who share that dimension.
-- A null share flag is treated as "shared" to match the app's default.
create or replace function app_visible_agent_ids(dimension text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select app_current_agent_id()
  union
  select peer.agent_id
  from team_splits me
  join team_splits peer
    on peer.team_id = me.team_id
   and peer.agent_id <> me.agent_id
  where me.agent_id = app_current_agent_id()
    and case dimension
          when 'contacts'   then peer.share_contacts
          when 'properties' then peer.share_properties
          when 'deals'      then peer.share_deals
          else false
        end is not false;
$$;

grant execute on function app_current_agent_id()            to authenticated;
grant execute on function app_is_admin()                    to authenticated;
grant execute on function app_visible_agent_ids(text)       to authenticated;

-- CONTACTS — visible when assigned to self or a sharing team peer.
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using      (assigned_agent_id in (select app_visible_agent_ids('contacts')))
  with check (assigned_agent_id in (select app_visible_agent_ids('contacts')));

-- DEALS — admins see all (matches App.jsx); others see self + sharing peers.
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using      (app_is_admin() or agent_id in (select app_visible_agent_ids('deals')))
  with check (app_is_admin() or agent_id in (select app_visible_agent_ids('deals')));

-- TASKS — strictly personal (never shared, matches App.jsx).
drop policy if exists tasks_agent_scope on tasks;
create policy tasks_agent_scope on tasks for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());

-- COMMISSIONS — keyed by deal_id; visibility derives from the parent deal.
drop policy if exists commissions_deal_scope on commissions;
create policy commissions_deal_scope on commissions for all to authenticated
  using (exists (
    select 1 from deals d
    where d.id = commissions.deal_id
      and (app_is_admin() or d.agent_id in (select app_visible_agent_ids('deals')))
  ))
  with check (exists (
    select 1 from deals d
    where d.id = commissions.deal_id
      and (app_is_admin() or d.agent_id in (select app_visible_agent_ids('deals')))
  ));

-- ACTIVITIES — visibility derives from the parent contact.
drop policy if exists activities_contact_scope on activities;
create policy activities_contact_scope on activities for all to authenticated
  using (exists (
    select 1 from contacts c
    where c.id = activities.contact_id
      and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
  ))
  with check (exists (
    select 1 from contacts c
    where c.id = activities.contact_id
      and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
  ));


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B — ACTIVATE enforcement (run AFTER the verification checklist below)
-- ───────────────────────────────────────────────────────────────────────────
-- Uncomment and run as a single statement-group once Phase A is verified.
--
-- drop policy if exists allow_all on contacts;
-- drop policy if exists allow_all on deals;
-- drop policy if exists allow_all on tasks;
-- drop policy if exists allow_all on commissions;
-- drop policy if exists allow_all on activities;


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B-ROLLBACK — instantly reopen if anything misbehaves
-- ───────────────────────────────────────────────────────────────────────────
-- do $$ begin
--   perform 1;
--   create policy allow_all on contacts    for all using (true) with check (true);
--   create policy allow_all on deals       for all using (true) with check (true);
--   create policy allow_all on tasks       for all using (true) with check (true);
--   create policy allow_all on commissions for all using (true) with check (true);
--   create policy allow_all on activities  for all using (true) with check (true);
-- exception when duplicate_object then null; end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICATION CHECKLIST (run between Phase A and Phase B, ideally in staging)
-- ───────────────────────────────────────────────────────────────────────────
-- As a normal (non-admin) agent's JWT:
--   ✓ Contacts/Pipeline/Tasks/Commission pages load the SAME rows as before.
--   ✓ Creating a contact/deal/task assigned to yourself succeeds.
--   ✓ select * from contacts  returns ONLY your + sharing-peers' rows
--     (previously returned everyone's).
-- As an admin agent's JWT:
--   ✓ Pipeline still shows ALL deals.
-- As the service role (api/* endpoints): unaffected (bypasses RLS).
-- Edge: tasks must carry agent_id = the creating agent (the app always sets
--   this); a task inserted with a null agent_id would be rejected.
--
-- FOLLOW-UPS (separate migrations):
--   • properties: route PropertyLanding's anonymous read through a service-key
--     API (or a narrow anon SELECT policy), THEN add an agent_scope policy.
--   • Consolidate ghost tables into schema.sql (migration 0003), then extend
--     these same helpers to them.
