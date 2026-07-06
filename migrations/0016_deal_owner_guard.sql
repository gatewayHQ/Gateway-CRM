-- Migration 0016 — Deal owner guard: default the owner, reject bad owners clearly
-- ===========================================================================
-- BUG THIS FIXES (2026-07): with 0011 Phase B enforcement live, an agent
-- clicking "Start Deal" on a property could hit the raw Postgres error
--   new row violates row-level security policy for table "deals"
-- The app's deal-creation paths could hand the database an owner the
-- deals_agent_scope WITH CHECK rejects:
--   • agent_id = NULL ("Unassigned" in the deal forms, or no active agent) —
--     NULL never satisfies `agent_id in (select app_visible_agent_ids(...))`;
--   • agent_id = another agent who does not share deals with the creator
--     (e.g. starting a deal from a teammate's listing, or after "Switch to"
--     on the Team page changed the client-side active agent).
--
-- THE FIX, database side (the app ships matching changes in
-- src/lib/services/deals.js — resolveDealOwnerId — so the client proposes a
-- valid owner in the first place):
--   1. A BEFORE INSERT trigger defaults a missing owner to the creator
--      (app_current_agent_id()), so ownerless inserts from any app build
--      succeed and are owned by whoever created them.
--   2. When a non-admin explicitly names an owner they may not create deals
--      for, the trigger raises a plain-English error (still SQLSTATE 42501)
--      instead of the raw policy violation, so old app builds show an
--      actionable message.
--
-- WHAT DOES NOT CHANGE:
--   • The visibility/ownership model (0011): a non-admin may only create
--     deals owned by themselves or a deal-sharing team peer; admins anything.
--   • Admin inserts — admins may still create unassigned (NULL-owner) deals.
--   • Service-key inserts (/api/*, cron) — no JWT, the trigger is a no-op.
--
-- PREREQS: 0002 (app_current_agent_id, app_visible_agent_ids),
--          0005/0011 (app_is_admin). Idempotent; safe to re-run.
-- ===========================================================================

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
