-- Gateway CRM — promote an agent to office admin
-- Run in the Supabase Dashboard → SQL Editor. Idempotent: safe to re-run.
--
-- This is a maintenance tool, not a numbered migration. It changes one row of
-- data, never the schema, so it lives outside the apply-once chain.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS ISN'T JUST `update agents set is_admin = true`
--
-- Migration 0023 added the BEFORE INSERT/UPDATE trigger
-- `agents_guard_privileged_trg`, so nobody can self-promote from the app. On
-- UPDATE it reverts is_admin / role / commission columns to their old values
-- unless the caller is the service key or an existing admin:
--
--     if coalesce(auth.jwt() ->> 'role', '') = 'service_role' or app_is_admin()
--
-- The SQL Editor connects as `postgres` with no JWT and no auth.uid(), so it is
-- neither — auth.jwt() is null and app_is_admin() is false. A bare
--
--     update agents set is_admin = true where email = '…';
--
-- therefore reports "UPDATE 1" and silently changes nothing. That is the
-- trigger doing its job; it just also catches legitimate DBA promotions.
--
-- The fix below sets `request.jwt.claims` for the transaction, which is what
-- auth.jwt() reads, so the trigger sees a trusted service-role caller and lets
-- the write through. set_config(..., true) is transaction-local: it disappears
-- on commit, and no trigger is ever left disabled. (Prefer this over
-- `alter table agents disable trigger …`, which leaves the guard off for every
-- session if the script aborts partway.)
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- Mark this transaction as the trusted service-role caller (transaction-local).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Flip the explicit admin flag. `role` is deliberately left alone: it is the
-- agent's displayed job title, and every admin check in the codebase
-- (app_is_admin(), App.jsx, api/cron.js, api/portal.js) honors is_admin first
-- and only falls back to the legacy role-string match.
update agents
   set is_admin = true
 where lower(email) = lower('daniel@gatewayreadvisors.com')
   and is_admin is distinct from true;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — expect exactly one row with is_admin = t.
--
--   • Zero rows  → no agents row carries that email yet. Sign in to the CRM
--                  once to claim a seat (App.jsx onboarding creates the row),
--                  then re-run this file.
--   • is_admin f → the trigger reverted the write; confirm the set_config line
--                  above ran inside the same transaction as the update.
-- ─────────────────────────────────────────────────────────────────────────────
select id, name, email, role, is_admin, auth_id
  from agents
 where lower(email) = lower('daniel@gatewayreadvisors.com');

-- To promote someone else, replace both copies of the email address above.
