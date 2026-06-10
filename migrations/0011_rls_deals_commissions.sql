-- Migration 0011 — RLS for deals, commissions, and deal-children
-- ===========================================================================
-- DECISION (2026-06, Daniel): "A regular agent should only see their own deals
-- & earnings, with respect to deals that they are co-listed on & will get paid
-- on. Firm-wide visibility is for admin only."
--
-- This resolves the question migration 0002 deferred. The visibility model:
--   • An agent sees deals they OWN (deals.agent_id), deals of TEAM PEERS who
--     share deals (team_splits.share_deals), and deals they are CO-LISTED on
--     (they appear as a participant in commissions.participants — i.e. they
--     get paid on the deal).
--   • Commissions, documents, docusign envelopes, transaction steps and
--     deadline reminders follow the deal they belong to.
--   • Admins (agents.is_admin — the office admin / transaction coordinator)
--     see everything firm-wide. Tasks stay personal even for admins.
--   • agent_notifications are strictly personal.
--   • /api/* serverless functions (portal, cron, Twilio, DocuSign, campaigns)
--     use the SERVICE key and bypass RLS — unaffected.
--
-- PREREQS: 0002 (helpers + contacts/activities/tasks policies), 0005
-- (agents.is_admin), 0008 (comp_data), 0009 (activities.deal_id).
--
-- SAFETY MODEL — same two phases as 0002:
--   PHASE A  Create/refresh helpers + scoped policies. The legacy `allow_all`
--            policies OR-combine with these, so nothing observable changes.
--   PHASE B  Drop `allow_all` on the scoped tables to activate enforcement —
--            for BOTH this migration's tables AND 0002's (contacts/activities/
--            tasks), so the whole model switches on as one verified unit.
--            Run only after the verification checklist passes.
--
-- APP PREREQ FOR PHASE B: deploy the app version that ships with this
-- migration. It scopes the Commission page's refresh and includes co-listed
-- deals in every deal fetch (src/lib/services/deals.js). Older app builds
-- still work under Phase B — queries simply return the scoped subset.
-- ===========================================================================


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE A — helpers + scoped policies (no behavioral change while allow_all exists)
-- ───────────────────────────────────────────────────────────────────────────

-- Refresh: admin check now honors the explicit is_admin flag (migration 0005)
-- with the legacy role-string fallback.
create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(is_admin or role ilike '%admin%'), false)
  from agents where auth_id = auth.uid();
$$;

-- Every deal the current user may see: all (admin), own + team-shared, or
-- co-listed (they appear as a participant on the deal's commission).
create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from deals d where app_is_admin()
  union
  select d.id from deals d
  where d.agent_id in (select app_visible_agent_ids('deals'))
  union
  select c.deal_id
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
  where (p->>'agent_id') is not null
    and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and (p->>'agent_id')::uuid = app_current_agent_id();
$$;

grant execute on function app_visible_deal_ids() to authenticated;

-- CONTACTS — refresh 0002's policy to add the admin bypass (App.jsx loads all
-- contacts firm-wide for admins; 0002 predates the is_admin decision).
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using      (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('contacts')))
  with check (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('contacts')));

-- ACTIVITIES — replaces 0002's contact-only policy: visible through the parent
-- contact OR the parent deal (0009); the author always sees their own entries;
-- admins see all.
drop policy if exists activities_contact_scope on activities;
drop policy if exists activities_scope on activities;
create policy activities_scope on activities for all to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = activities.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or activities.deal_id in (select app_visible_deal_ids())
  )
  with check (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = activities.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or activities.deal_id in (select app_visible_deal_ids())
  );

-- DEALS — own + team-shared + co-listed; admins see all. The with check arm
-- lets an agent create deals owned by themselves / a sharing peer, and lets a
-- co-listed participant edit a deal they can already see.
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );

-- COMMISSIONS — follow the deal.
drop policy if exists commissions_deal_scope on commissions;
create policy commissions_deal_scope on commissions for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- DOCUMENTS — follow the deal; unattached uploads stay personal.
drop policy if exists documents_deal_scope on documents;
create policy documents_deal_scope on documents for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or (deal_id is null and agent_id = app_current_agent_id())
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or (deal_id is null and agent_id = app_current_agent_id())
  );

-- DOCUSIGN ENVELOPES — follow the deal; sender always sees their own.
drop policy if exists docusign_envelopes_deal_scope on docusign_envelopes;
create policy docusign_envelopes_deal_scope on docusign_envelopes for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  );

-- TRANSACTION STEPS — follow the deal.
drop policy if exists transaction_steps_deal_scope on transaction_steps;
create policy transaction_steps_deal_scope on transaction_steps for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- DEADLINE REMINDERS — follow the deal (written by cron via service key).
drop policy if exists deadline_reminders_deal_scope on deadline_reminders;
create policy deadline_reminders_deal_scope on deadline_reminders for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- AGENT NOTIFICATIONS — strictly personal (written by APIs via service key).
drop policy if exists agent_notifications_own on agent_notifications;
create policy agent_notifications_own on agent_notifications for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B — ACTIVATE enforcement (run AFTER the verification checklist below)
-- ───────────────────────────────────────────────────────────────────────────
-- Uncomment and run as a single group. This activates 0002's tables too.
--
-- drop policy if exists allow_all on contacts;
-- drop policy if exists allow_all on activities;
-- drop policy if exists allow_all on tasks;
-- drop policy if exists allow_all on deals;
-- drop policy if exists allow_all on commissions;
-- drop policy if exists allow_all on documents;
-- drop policy if exists allow_all on docusign_envelopes;
-- drop policy if exists allow_all on transaction_steps;
-- drop policy if exists allow_all on agent_notifications;
-- drop policy if exists deadline_reminders_all on deadline_reminders;


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B-ROLLBACK — instantly reopen if anything misbehaves
-- ───────────────────────────────────────────────────────────────────────────
-- do $$
-- declare t text;
-- begin
--   foreach t in array array[
--     'contacts','activities','tasks','deals','commissions','documents',
--     'docusign_envelopes','transaction_steps','agent_notifications',
--     'deadline_reminders'
--   ] loop
--     execute format('drop policy if exists allow_all on %I', t);
--     execute format('create policy allow_all on %I for all using (true) with check (true)', t);
--   end loop;
-- end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICATION CHECKLIST (run between Phase A and Phase B, ideally in staging)
-- ───────────────────────────────────────────────────────────────────────────
-- As a normal (non-admin) agent's JWT:
--   ✓ Pipeline shows your own deals AND deals you are co-listed on
--     (commission participant), but NOT other agents' deals.
--   ✓ Commission page totals/leaderboard cover only the deals you can see;
--     your own earnings and cap tracker are unchanged.
--   ✓ Creating a deal owned by yourself succeeds; editing a co-listed deal
--     (e.g. dragging its stage) succeeds.
--   ✓ Documents/signatures on a co-listed deal are reachable; another agent's
--     deal documents are not.
--   ✓ select * from deals / commissions / documents returns only your scoped
--     rows (previously returned everything).
-- As the office admin / transaction coordinator (is_admin = true):
--   ✓ All deals, commissions, documents and contacts remain visible firm-wide.
-- As the service role (api/* endpoints):
--   ✓ Client portal, deadline cron, DocuSign webhooks unaffected (bypass RLS).
-- Realtime note: agent_notifications uses a realtime subscription filtered by
--   agent_id — unaffected (the policy matches the filter).
