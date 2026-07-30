-- ═════════════════════════════════════════════════════════════════════════════
-- 2026-07-29 — Dual-agent deals (production bundle for migrations/0024)
--
-- Production ALREADY HAS `deals.co_agent_ids uuid[]` (legacy denormalized shape,
-- see this folder's README) and `app_visible_deal_ids()` already grants a
-- co-agent visibility through it. So on production this bundle is NOT about
-- creating the column — it is about making it trustworthy now that the app
-- writes it on every Property → Deal conversion:
--
--   1. normalize nulls to '{}' so array operators are safe
--   2. add the exclude-primary check constraint
--   3. add the GIN index the co-listed lookup needs
--   4. backfill deals converted before the fix from their property's co-agents
--
-- Changes behavior? Reads only become MORE complete (a deal that showed one
-- agent may now show two). No column is dropped or retyped.
--
-- Apply BEFORE (or with) the dual-agent deploy. Until it runs the app degrades
-- gracefully: the deal still gets its primary agent and the UI falls back to the
-- linked property for co-agents (src/lib/agentRoster.js#dealAgentIds).
--
-- ROLLBACK (the column itself predates this repo — do NOT drop it):
--   alter table deals drop constraint if exists deals_co_agents_exclude_primary;
--   drop index if exists idx_deals_co_agent_ids;
--   -- step 4 is not automatically reversible; it only fills empty rosters from
--   -- the linked property, so to undo it:
--   -- update deals d set co_agent_ids = '{}' where d.property_id is not null;
-- ═════════════════════════════════════════════════════════════════════════════

-- Runs in one transaction, so a failure anywhere leaves the database untouched.
begin;

-- 0. Create it if this is somehow a database that lacks it (fresh replica).
alter table deals add column if not exists co_agent_ids uuid[] default '{}';

-- 1. Nulls → empty array.
update deals set co_agent_ids = '{}' where co_agent_ids is null;

-- 2. Strip any pre-existing self-reference BEFORE adding the constraint, or the
--    ALTER fails validating legacy rows.
update deals
set co_agent_ids = array_remove(co_agent_ids, agent_id)
where agent_id is not null and agent_id = any(coalesce(co_agent_ids, '{}'));

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'deals_co_agents_exclude_primary'
  ) then
    alter table deals add constraint deals_co_agents_exclude_primary
      check (agent_id is null or not (agent_id = any(coalesce(co_agent_ids, '{}'))));
  end if;
end $$;

-- 3. GIN index for `co_agent_ids @> [agent]`
--    (src/lib/services/deals.js#fetchCoListedDealIds and the RLS helper).
create index if not exists idx_deals_co_agent_ids on deals using gin (co_agent_ids);

-- 4. Backfill from the linked property for deals that never got a roster.
--    Only fills EMPTY rosters, so an explicitly-edited deal is never overwritten.
--    The regex guard skips a malformed id in the jsonb rather than aborting the
--    whole migration on a cast error.
update deals d
set co_agent_ids = sub.ids
from (
  select p.id as property_id,
         array_agg(distinct x.aid) as ids
  from properties p
  cross join lateral (
    select e::uuid as aid
    from jsonb_array_elements_text(p.details -> 'co_agent_ids') e
    where e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) x
  where jsonb_typeof(p.details -> 'co_agent_ids') = 'array'
  group by p.id
) sub
where d.property_id = sub.property_id
  and coalesce(array_length(d.co_agent_ids, 1), 0) = 0;

-- Re-strip the primary in case the backfill copied it in.
update deals
set co_agent_ids = array_remove(co_agent_ids, agent_id)
where agent_id is not null and agent_id = any(coalesce(co_agent_ids, '{}'));

-- 5. Drop dangling ids (agent deleted after assignment). uuid[] can't carry a
--    foreign key, so this is the manual equivalent of ON DELETE SET NULL.
update deals d
set co_agent_ids = coalesce((
  select array_agg(i) from unnest(d.co_agent_ids) i
  where exists (select 1 from agents a where a.id = i)
), '{}')
where exists (
  select 1 from unnest(d.co_agent_ids) i
  where not exists (select 1 from agents a where a.id = i)
);

commit;

-- ── Verification (run after applying) ────────────────────────────────────────
-- Deals carrying a co-agent:
--   select count(*) from deals where coalesce(array_length(co_agent_ids,1),0) > 0;
-- Properties with two agents whose deal did NOT get a roster (should be 0):
--   select d.id, d.title
--   from deals d join properties p on p.id = d.property_id
--   where jsonb_typeof(p.details->'co_agent_ids') = 'array'
--     and jsonb_array_length(p.details->'co_agent_ids') > 0
--     and coalesce(array_length(d.co_agent_ids,1),0) = 0;
-- No deal names its primary twice (should be 0):
--   select count(*) from deals where agent_id = any(coalesce(co_agent_ids,'{}'));
