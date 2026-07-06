-- Migration 0016 — Deal owner guard + app_is_admin() drift repair
-- ===========================================================================
-- BUG THIS FIXES (2026-07): with 0011 Phase B enforcement live, an agent
-- clicking "Start Deal" on a property could hit the raw Postgres error
--   new row violates row-level security policy for table "deals"
--
-- ROOT CAUSE (two independent problems, both fixed here):
--
-- A. app_is_admin() DRIFT — the primary cause seen in production. Migration
--    0002 defined app_is_admin() as `bool_or(role ilike '%admin%')` (role
--    TEXT only). 0005 added the explicit agents.is_admin flag and 0011 /
--    the production milestone-0 script redefined app_is_admin() to
--    `bool_or(is_admin or role ilike '%admin%')` — but on databases where
--    that redefinition never actually landed (or was later overwritten by an
--    0002 re-run), app_is_admin() still ignores the flag. An agent flagged
--    is_admin = true whose ROLE does not contain "admin" (e.g. role
--    "Commercial Associate") is then treated as a NON-admin by every RLS
--    policy: the deals WITH CHECK admin arm is false, so even creating a
--    deal fails. The app UI, which reads the is_admin column directly, still
--    shows them as an admin — a silent split-brain. Section 1 below restores
--    the flag-aware definition idempotently.
--
-- B. UNSAFE DEAL OWNER — the app's deal-creation paths could hand the
--    database an owner the deals_agent_scope WITH CHECK rejects:
--      • agent_id = NULL ("Unassigned" in the deal forms, or no active
--        agent) — NULL never satisfies `agent_id in (app_visible_agent_ids)`;
--      • agent_id = another agent who does not share deals with the creator
--        (starting a deal from a teammate's listing, or after "Switch to" on
--        the Team page changed the client-side active agent).
--    Section 2 adds a BEFORE INSERT trigger that defaults a missing owner to
--    the creator and turns a disallowed owner into a plain-English 42501.
--    The app ships a matching resolveDealOwnerId (src/lib/services/deals.js)
--    so the client proposes a valid owner in the first place.
--
-- WHAT DOES NOT CHANGE:
--   • The visibility/ownership model (0011): a non-admin may only create
--     deals owned by themselves or a deal-sharing team peer; admins anything.
--   • Admins (by flag OR role) may create unassigned (NULL-owner) deals.
--   • Service-key inserts (/api/*, cron) — no JWT, the trigger is a no-op.
--   • Section 1 only ever GRANTS admin to agents already flagged is_admin —
--     it never removes admin from anyone the old function recognized.
--
-- PREREQS: 0002 (app_current_agent_id, app_visible_agent_ids),
--          0005 (agents.is_admin). Idempotent; safe to re-run.
-- ===========================================================================

-- ── 1. Repair app_is_admin() so it honors the explicit is_admin flag ────────
-- (Identical to the definition in src/lib/schema.sql / 0011 — restated here so
-- applying THIS migration is sufficient to fix a drifted database.)
create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(is_admin or role ilike '%admin%'), false)
  from agents where auth_id = auth.uid();
$$;

grant execute on function app_is_admin() to authenticated;

-- ── 2. Deal owner guard ─────────────────────────────────────────────────────

create or replace function app_deal_owner_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me uuid;
begin
  -- No JWT (service key / cron): leave the row untouched — RLS is bypassed
  -- there anyway and those callers manage ownership themselves.
  if auth.uid() is null then return new; end if;

  -- Admins may create deals for anyone, including unassigned ones.
  if app_is_admin() then return new; end if;

  me := app_current_agent_id();
  if me is null then
    raise exception 'Your login is not linked to an agent profile yet, so the deal could not be created. Finish setting up your profile, or ask an admin to link your account.'
      using errcode = '42501';
  end if;

  -- Ownerless inserts (e.g. "Start Deal", quick-add left Unassigned) become
  -- owned by their creator instead of failing the RLS check.
  if new.agent_id is null then
    new.agent_id := me;
  end if;

  -- Same rule the deals_agent_scope WITH CHECK enforces, but with an error an
  -- agent can act on. app_visible_agent_ids('deals') = self + team peers who
  -- share deals.
  if new.agent_id not in (select app_visible_agent_ids('deals')) then
    raise exception 'Deals can only be created for yourself or a teammate who shares deals with you. Assign the deal to yourself, or ask an admin to create it for another agent.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists deals_owner_guard on deals;
create trigger deals_owner_guard
  before insert on deals
  for each row execute function app_deal_owner_guard();
