-- Migration 0055 — Fix app_request_deal_access()
-- ===========================================================================
-- The version shipped in 0054 could never run. Its INSERT names five columns
-- and supplies four values:
--
--   insert into agent_notifications (agent_id, deal_id, title, message, type)
--   values (owner_id, <title>, <message>, 'deal_access_request');
--
-- `deal_id` was dropped, so every call raised
-- `42601: INSERT has more target columns than expressions` and the
-- "Ask <agent> to add me" button on the duplicate-deal dialog failed with a
-- toast instead of notifying anyone.
--
-- Caught by scripts/db-verify/deal_sharing_matrix.sql, which exercises the
-- function rather than reading it. It is a one-line fix; the rest of 0054 —
-- the duplicate detection, the whitespace trim, the unique index — was
-- unaffected and needs no re-run.
-- ===========================================================================

begin;

create or replace function app_request_deal_access(p_deal_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid; me_name text; owner_id uuid; d_title text;
begin
  me := app_current_agent_id();
  if me is null then return false; end if;

  select d.agent_id, d.title into owner_id, d_title from deals d where d.id = p_deal_id;
  if owner_id is null or owner_id = me then return false; end if;

  -- One pending ask per agent per deal. Clicking twice must not page someone
  -- twice, and a stuck request must not become a nightly reminder.
  if exists (
    select 1 from agent_notifications n
     where n.agent_id = owner_id and n.deal_id = p_deal_id
       and n.type = 'deal_access_request' and n.read = false
       and n.message like '%' || me::text || '%'
  ) then
    return true;
  end if;

  select a.name into me_name from agents a where a.id = me;

  insert into agent_notifications (agent_id, deal_id, title, message, type)
  values (
    owner_id,
    p_deal_id,          -- <-- missing in 0054
    coalesce(me_name, 'An agent') || ' wants access to ' || coalesce(d_title, 'a deal'),
    coalesce(me_name, 'An agent') || ' opened this property and found your deal instead of starting their own. '
      || 'Add them under Agents on deal if they are working it with you.  [' || me::text || ']',
    'deal_access_request'
  );
  return true;
end
$$;

grant execute on function app_request_deal_access(uuid) to authenticated;

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- Run as an agent who is NOT the deal's owner; it should return true and
-- leave one unread notification on the owner:
--   select app_request_deal_access('<a deal id you do not own>');
--   select title, message from agent_notifications where type = 'deal_access_request';
