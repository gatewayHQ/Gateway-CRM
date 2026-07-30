-- ═════════════════════════════════════════════════════════════════════════════
-- 0025 — Dual-agent deals: deals.co_agent_ids
--
-- A property can be assigned to two agents (properties.details.co_agent_ids),
-- but the deal created from it had nowhere to put the second one, so the
-- co-listing was dropped at conversion and downstream paperwork showed a single
-- agent. This makes the deal-level roster a real, queryable column:
--
--     roster(deal) = [deals.agent_id] + deals.co_agent_ids
--
-- `deals.agent_id` is unchanged and remains the PRIMARY (listing) agent, so
-- every existing feature that reads the single owner keeps working.
--
-- ORDER MATTERS: all data cleanup happens FIRST and the check constraint is
-- added LAST. Adding it up front tripped it mid-migration on legacy rows where a
-- property lists its own assigned agent inside details.co_agent_ids — the
-- backfill copied that primary straight back into the deal's roster. Constraint
-- last = no illegal intermediate state.
--
-- ⚠ LEGACY NOTE: production ALREADY HAS this column (`co_agent_ids uuid[]`, see
-- migrations/production/README.md) and its `app_visible_deal_ids()` already
-- grants a co-agent visibility through it. This file exists so fresh installs
-- and the repo schema match production instead of diverging.
--
-- Changes behavior? No — additive. Idempotent and re-runnable (the constraint is
-- dropped at the start, so a partially-applied attempt is cleaned up rather than
-- blocking). Run BEFORE (or with) the app deploy that carries both agents onto a
-- deal. Until it runs, the app degrades gracefully: the deal is still created
-- with its primary agent, and the UI falls back to reading co-agents off the
-- linked property (src/lib/agentRoster.js#dealRosterIds).
-- ═════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Make re-runs safe ─────────────────────────────────────────────────────
alter table deals drop constraint if exists deals_co_agents_exclude_primary;

-- ── 1. The roster column ─────────────────────────────────────────────────────
alter table deals add column if not exists co_agent_ids uuid[] default '{}';
update deals set co_agent_ids = '{}' where co_agent_ids is null;

-- ── 2. Index for the co-listed-deals lookup ──────────────────────────────────
-- src/lib/services/deals.js#fetchCoListedDealIds filters with `contains`
-- (co_agent_ids @> [agent]); GIN makes that an index scan.
create index if not exists idx_deals_co_agent_ids on deals using gin (co_agent_ids);

-- ── 3. Fix the SOURCE data: properties listing their own assigned agent ──────
-- The Property UI hides the assigned agent from the co-agent picker, but if the
-- assignment was CHANGED after a co-agent was picked, the stale id stayed in
-- details.co_agent_ids. Clean it so the backfill reads sane data and the
-- Property drawer stops showing a phantom co-agent. (The app now prevents this
-- going forward — see setPrimaryAgent in Properties.jsx / Pipeline.jsx.)
update properties p
set details = jsonb_set(
      p.details,
      '{co_agent_ids}',
      coalesce((
        select jsonb_agg(e)
        from jsonb_array_elements_text(p.details -> 'co_agent_ids') e
        where e <> p.assigned_agent_id::text
      ), '[]'::jsonb)
    )
where p.assigned_agent_id is not null
  and jsonb_typeof(p.details -> 'co_agent_ids') = 'array'
  and p.details -> 'co_agent_ids' ? p.assigned_agent_id::text;

-- ── 4. Backfill: recover co-agents for deals converted before this fix ───────
-- Only touches deals that still have an empty roster and are linked to a
-- property carrying co-agents, so an explicitly-edited deal is never
-- overwritten. The regex guard skips a malformed id rather than aborting the
-- migration on a cast error. The deal's own primary is excluded explicitly — a
-- property can legitimately be assigned to a DIFFERENT agent than the deal it
-- produced, so step 3 alone does not make this safe.
update deals d
set co_agent_ids = case
      when d.agent_id is null then sub.ids
      else array_remove(sub.ids, d.agent_id)
    end
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
  and coalesce(array_length(d.co_agent_ids, 1), 0) = 0
  and coalesce(array_length(
        case when d.agent_id is null then sub.ids else array_remove(sub.ids, d.agent_id) end,
      1), 0) > 0;

-- ── 5. Normalize every existing roster ───────────────────────────────────────
-- 5a. The primary must never also be a co-agent.
update deals
set co_agent_ids = array_remove(co_agent_ids, agent_id)
where agent_id is not null and agent_id = any(coalesce(co_agent_ids, '{}'));

-- 5b. Drop dangling ids (an agent deleted after the property was assigned).
--     uuid[] can't carry a foreign key, so this is the equivalent of
--     ON DELETE SET NULL.
update deals d
set co_agent_ids = coalesce((
  select array_agg(i) from unnest(d.co_agent_ids) i
  where exists (select 1 from agents a where a.id = i)
), '{}')
where exists (
  select 1 from unnest(d.co_agent_ids) i
  where not exists (select 1 from agents a where a.id = i)
);

-- 5c. Any nulls introduced along the way.
update deals set co_agent_ids = '{}' where co_agent_ids is null;

-- ── 6. The guard, added LAST against clean data ──────────────────────────────
-- Keeps roster(deal) unambiguous and stops "Alex & Alex" on paperwork. The app
-- already filters this out (dealAgentPayloadFromProperty, setPrimaryAgent);
-- this is the backstop.
alter table deals add constraint deals_co_agents_exclude_primary
  check (agent_id is null or not (agent_id = any(coalesce(co_agent_ids, '{}'))));

commit;
