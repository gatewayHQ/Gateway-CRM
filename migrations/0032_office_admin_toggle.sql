-- ============================================================================
-- 0032  Office-admin toggle: the flag is the answer for the accounts that own it
-- ----------------------------------------------------------------------------
-- WHY
--   `agents.is_admin` grants firm-wide X-ray — every agent's deals, documents,
--   signatures, commissions and contacts. Two accounts own that switch and may
--   turn it on and off at will: Erin (broker) and Daniel (builds the CRM). The
--   checkbox is rendered for nobody else and /api/portal refuses the column for
--   anyone else (src/lib/officeAdmins.js).
--
--   Turning it OFF has to actually drop them to an agent-level view, and RLS is
--   the layer that decides which rows they can read. `app_is_admin()` carried a
--   legacy fallback — `role ilike '%admin%'` — for profiles created before the
--   is_admin column existed (migration 0005, which back-filled the flag from
--   exactly that role text). For these two accounts that fallback would quietly
--   keep the whole firm visible after they switched themselves off: the app
--   would narrow, the database would not, and the toggle would be decorative.
--
--   So: the flag alone answers for the allow-listed accounts. Everyone else
--   keeps the fallback untouched — this migration takes no access away from any
--   other agent and rewrites no data.
--
-- KEEP IN SYNC
--   The email list below mirrors OFFICE_ADMIN_ACCOUNTS in src/lib/officeAdmins.js
--   (used by the browser and by api/portal.js). Two places, both commented; a
--   settings table for a two-name list would be more machinery to keep honest.
--
-- CHANGES BEHAVIOR?
--   Only for an allow-listed account whose free-text role mentions "admin" AND
--   whose is_admin is false — which is precisely the case the toggle is for.
--
-- SAFE TO RE-RUN: yes (create or replace only).
-- ============================================================================

create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(
    is_admin
    or (
      role ilike '%admin%'
      -- The legacy role fallback does not apply to the accounts that can toggle
      -- themselves off; for them OFF must mean OFF.
      and lower(coalesce(email, '')) not in (
        'erin@gatewayreadvisors.com',
        'daniel@gatewayreadvisors.com'
      )
    )
  ), false)
  from agents where auth_id = auth.uid();
$$;

comment on function app_is_admin() is
  'True when the signed-in user is an office admin. The explicit agents.is_admin flag, '
  'plus a legacy role-string fallback for profiles predating migration 0005 — except for '
  'the accounts that own the office-admin toggle, where the flag is the only answer. '
  'Mirrors src/lib/officeAdmins.js.';

-- Sanity check (read-only): who does the database consider an office admin?
--   select id, name, email, is_admin, role from agents
--   where is_admin or role ilike '%admin%' order by name;
