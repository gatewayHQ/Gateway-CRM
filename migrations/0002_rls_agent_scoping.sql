-- Migration 0002 — Real RLS: enforce agent/team scoping in the database
-- ===========================================================================
-- WHY
--   Today every table has `allow_all using(true)`, and data isolation is done
--   ONLY client-side (App.jsx filters with .in('assigned_agent_id', ...)). Any
--   authenticated user can read every row by issuing an unfiltered query. This
--   migration moves that scoping INTO the database so it is enforced regardless
--   of the client.
--
-- SCOPE OF THIS CUT (verified safe to enforce — see the audit notes below)
--   contacts, activities, tasks
--
-- DEFERRED to a later migration (reasons documented inline / at bottom)
--   • deals & commissions — entangled with the brokerage-wide Commission page;
--     enforcing them changes what NON-ADMIN agents see there. That is a product
--     decision (should agents see firm-wide earnings?), so the policies are
--     written below but left INACTIVE until the decision is made.
--   • properties — read anonymously by the public PropertyLanding page; scope
--     only after that read is routed through a service-key API.
--   • templates, agents, team_splits — intentionally shared across all agents.
--   • ghost/ad-hoc tables (now consolidated by 0003) — harden after this proves
--     out in production.
--
-- AUDIT FINDING — what actually changes for a NON-ADMIN agent at Phase B:
--   contacts   : ColdCalls dedup (ColdCalls.jsx:176) and the Campaigns recipient
--                picker (Campaigns.jsx:~1711) read contacts unscoped today. They
--                do NOT break — they narrow to the agent's own/shared contacts,
--                which is the intended hardening (an agent can no longer dedup
--                or mail-merge against other agents' contacts).
--   activities : loaded unscoped today (App.jsx:332) but only ever DISPLAYED
--                per-contact, and contacts are scoped — so there is no visible
--                regression. (Verify no global activity feed before Phase B.)
--   tasks      : already scoped everywhere — zero change.
--
-- SAFETY MODEL — phased:
--   PHASE A  Create helpers + scoped policies. Because the existing `allow_all`
--            permissive policy is OR-combined with these, the tables STAY fully
--            open — applying Phase A changes NOTHING observable. Safe now.
--   PHASE B  Drop `allow_all` on contacts/activities/tasks to activate. Run only
--            after the verification checklist passes. PHASE B-ROLLBACK reverses
--            it instantly.
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

grant execute on function app_current_agent_id()      to authenticated;
grant execute on function app_is_admin()              to authenticated;
grant execute on function app_visible_agent_ids(text) to authenticated;

-- CONTACTS — visible when assigned to self or a sharing team peer.
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using      (assigned_agent_id in (select app_visible_agent_ids('contacts')))
  with check (assigned_agent_id in (select app_visible_agent_ids('contacts')));

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

-- TASKS — strictly personal (already scoped everywhere; matches App.jsx).
drop policy if exists tasks_agent_scope on tasks;
create policy tasks_agent_scope on tasks for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B — ACTIVATE enforcement (run AFTER the verification checklist below)
-- ───────────────────────────────────────────────────────────────────────────
-- Uncomment and run as a single group once Phase A is verified.
--
-- drop policy if exists allow_all on contacts;
-- drop policy if exists allow_all on activities;
-- drop policy if exists allow_all on tasks;


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B-ROLLBACK — instantly reopen if anything misbehaves
-- ───────────────────────────────────────────────────────────────────────────
-- do $$ begin
--   create policy allow_all on contacts   for all using (true) with check (true);
--   create policy allow_all on activities for all using (true) with check (true);
--   create policy allow_all on tasks      for all using (true) with check (true);
-- exception when duplicate_object then null; end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICATION CHECKLIST (run between Phase A and Phase B, ideally in staging)
-- ───────────────────────────────────────────────────────────────────────────
-- As a normal (non-admin) agent's JWT:
--   ✓ Contacts and Tasks pages load the SAME rows as before.
--   ✓ Creating a contact/task assigned to yourself succeeds.
--   ✓ select * from contacts returns ONLY your + sharing-peers' rows
--     (previously returned everyone's).
--   ✓ Cold Calls import still works; dedup now checks your contacts only.
--   ✓ Campaigns recipient picker now lists your contacts only (intended).
--   ✓ A contact's Activity tab still shows its history.
--   ✓ No "global activity feed" anywhere shows a reduced count (there isn't one
--     today — confirm before Phase B).
-- As the service role (api/* endpoints): unaffected (bypasses RLS).
-- Edge: a task inserted with a null agent_id would be rejected (the app always
--   sets agent_id = the active agent, so this does not occur in normal use).


-- ═══════════════════════════════════════════════════════════════════════════
-- DEFERRED — deals & commissions (DO NOT APPLY until the decision below)
-- ═══════════════════════════════════════════════════════════════════════════
-- DECISION NEEDED: src/pages/Commission.jsx is a brokerage-wide report — org
-- totals, a per-agent leaderboard, and cap tracking. Today EVERY agent sees the
-- whole firm's deals & commissions there. Enforcing the policies below makes a
-- non-admin see only their own (+ sharing-peer) data; admins still see all (the
-- policies have an admin bypass).
--
--   • If firm-wide earnings are meant for everyone → keep deals/commissions
--     permissive, OR gate the Commission page's totals/leaderboard to admins
--     in the app, THEN apply these.
--   • If earnings should be private to each agent (admins see all) → these
--     policies ARE the intended hardening; apply them with a Phase B.
--
-- The policies are written and ready; they are intentionally left unapplied.
--
-- create policy deals_agent_scope on deals for all to authenticated
--   using      (app_is_admin() or agent_id in (select app_visible_agent_ids('deals')))
--   with check (app_is_admin() or agent_id in (select app_visible_agent_ids('deals')));
--
-- create policy commissions_deal_scope on commissions for all to authenticated
--   using (exists (select 1 from deals d where d.id = commissions.deal_id
--           and (app_is_admin() or d.agent_id in (select app_visible_agent_ids('deals')))))
--   with check (exists (select 1 from deals d where d.id = commissions.deal_id
--           and (app_is_admin() or d.agent_id in (select app_visible_agent_ids('deals')))));
--
-- Before applying, also scope the client reads that currently fetch all rows:
--   • App.jsx:329  commissions load  → scope, or read via a service-key API
--   • App.jsx:318  admin deals load  → already admin-only; fine
--   • Commission.jsx:554-555         → admin-only data path, or service-key API


-- ───────────────────────────────────────────────────────────────────────────
-- OTHER FOLLOW-UPS (separate migrations)
-- ───────────────────────────────────────────────────────────────────────────
--   • properties: route PropertyLanding's anonymous read through a service-key
--     API (or a narrow anon SELECT policy), THEN add an agent_scope policy.
--   • Extend these helpers to the ghost tables consolidated in migration 0003.
