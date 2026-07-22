-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 — Fix deals INSERT under RLS (owner-stamp + explicit per-command policies)
--
-- SYMPTOM: after the visibility expansion (0011 Phase B), agents creating a deal
-- hit "new row violates row-level security policy for table 'deals'".
--
-- ROOT CAUSE: 0011's single `deals_agent_scope` FOR ALL policy has a WITH CHECK
-- of:
--     app_is_admin()
--     OR agent_id in (select app_visible_agent_ids('deals'))
--     OR id in (select app_visible_deal_ids())
-- On INSERT only WITH CHECK runs, and for a non-admin the only branch that can
-- pass is `agent_id in app_visible_agent_ids('deals')` — i.e. agent_id must be
-- the caller's own agents.id (or a share-deals peer). The `id in (...)` branch
-- is always false on INSERT (the row isn't visible yet). The clients
-- (QuickAdd.jsx, Properties.jsx) can send `agent_id = null`, and `null in (...)`
-- is NULL (not TRUE) → the check fails.
--
-- FIX:
--   1. deals_stamp_owner() BEFORE INSERT trigger: default a null agent_id to the
--      caller's own agent id, so an authenticated agent always owns what they
--      create — regardless of which client issues the insert. Explicit values
--      (admin assigning to a teammate, service-key APIs) are preserved.
--   2. Replace the one FOR ALL policy with explicit SELECT/INSERT/UPDATE/DELETE
--      policies. INSERT drops the dead `id in (...)` branch; DELETE is tightened
--      to owner-or-admin (least privilege). SELECT/UPDATE keep 0011's semantics.
--
-- Idempotent; safe to re-run. Behavior change: co-listed (non-owner) agents can
-- no longer DELETE a deal they can see — only its owner or an admin can.
-- PREREQS: 0011 (helpers app_current_agent_id / app_is_admin /
-- app_visible_agent_ids / app_visible_deal_ids).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Owner-stamp trigger — guarantees agent_id is set for authenticated agents.
create or replace function deals_stamp_owner()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is null then
    new.agent_id := app_current_agent_id();  -- null for service role / unclaimed seat
  end if;
  return new;
end $$;

drop trigger if exists deals_stamp_owner_trg on deals;
create trigger deals_stamp_owner_trg
  before insert on deals
  for each row execute function deals_stamp_owner();

-- 2. Explicit per-command policies (replaces 0011's single FOR ALL policy).
drop policy if exists deals_agent_scope on deals;

-- SELECT — own + team-shared + co-listed; admin sees all (unchanged from 0011).
drop policy if exists deals_select on deals;
create policy deals_select on deals for select to authenticated
  using (id in (select app_visible_deal_ids()));

-- INSERT — any claimed agent (or admin) may create a deal. Ownership/visibility
-- is enforced on SELECT/UPDATE via app_visible_deal_ids(); it CANNOT be gated
-- here, because in the deal_agents ownership model the owning link can only be
-- written after the deals row exists (chicken-and-egg). Gating on the caller's
-- identity — not on who the row is assigned to — is what unblocks creation.
drop policy if exists deals_insert on deals;
create policy deals_insert on deals for insert to authenticated
  with check (
    app_is_admin()
    or app_current_agent_id() is not null
  );

-- UPDATE — edit any deal you can see; the new row must still be one you own /
-- share / can see (co-listed participants can edit, e.g. drag stage). Matches
-- 0011's WITH CHECK.
drop policy if exists deals_update on deals;
create policy deals_update on deals for update to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );

-- DELETE — owner or admin only (least privilege; tighter than 0011's FOR ALL,
-- which let any co-listed agent delete).
drop policy if exists deals_delete on deals;
create policy deals_delete on deals for delete to authenticated
  using (app_is_admin() or agent_id = app_current_agent_id());
