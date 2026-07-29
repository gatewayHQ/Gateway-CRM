-- ═════════════════════════════════════════════════════════════════════════════
-- 0024 — Dual-agent deals: deals.co_agent_ids
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
-- ⚠ LEGACY NOTE: production ALREADY HAS this column (`co_agent_ids uuid[]`, see
-- migrations/production/README.md) and its `app_visible_deal_ids()` already
-- grants a co-agent visibility through it. This file exists so fresh installs
-- and the repo schema match production instead of diverging — on production it
-- is a no-op except for the index and the self-reference guard.
--
-- Changes behavior? No — additive. Safe to run anytime; idempotent.
-- Run BEFORE (or with) the app deploy that carries both agents onto a deal.
-- Until it runs, the app degrades gracefully: the deal is still created with its
-- primary agent, and the UI falls back to reading co-agents off the linked
-- property (src/lib/agentRoster.js#dealAgentIds).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The roster column ────────────────────────────────────────────────────────
alter table deals add column if not exists co_agent_ids uuid[] default '{}';

-- Normalize any pre-existing nulls so array operators never see one.
update deals set co_agent_ids = '{}' where co_agent_ids is null;

-- ── Guard: the primary agent must not also be listed as a co-agent ───────────
-- Keeps roster(deal) unambiguous and stops "Alex, Alex" on paperwork. The app
-- already filters this out (dealAgentPayloadFromProperty); this is the backstop.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'deals_co_agents_exclude_primary'
  ) then
    alter table deals add constraint deals_co_agents_exclude_primary
      check (agent_id is null or not (agent_id = any(coalesce(co_agent_ids, '{}'))));
  end if;
end $$;

-- ── Index for the co-listed-deals lookup ─────────────────────────────────────
-- src/lib/services/deals.js#fetchCoListedDealIds filters with `contains`
-- (co_agent_ids @> [agent]); GIN makes that an index scan.
create index if not exists idx_deals_co_agent_ids on deals using gin (co_agent_ids);

-- ── Backfill: recover co-agents for deals converted before this fix ──────────
-- Only touches deals that (a) still have an empty roster, (b) are linked to a
-- property that carries co-agents, and (c) whose primary agent is excluded from
-- the copied list. Idempotent — re-running changes nothing once populated.
update deals d
set co_agent_ids = sub.ids
from (
  select p.id as property_id,
         array_agg(distinct x.agent_id) as ids
  from properties p
  cross join lateral (
    select (jsonb_array_elements_text(p.details -> 'co_agent_ids'))::uuid as agent_id
  ) x
  where jsonb_typeof(p.details -> 'co_agent_ids') = 'array'
  group by p.id
) sub
where d.property_id = sub.property_id
  and coalesce(array_length(d.co_agent_ids, 1), 0) = 0
  and exists (select 1 from unnest(sub.ids) i where d.agent_id is null or i <> d.agent_id);

-- Strip the primary out of anything the backfill copied in, so the check
-- constraint above can never be tripped by our own backfill.
update deals
set co_agent_ids = array_remove(co_agent_ids, agent_id)
where agent_id is not null and agent_id = any(coalesce(co_agent_ids, '{}'));

-- Drop dangling ids (an agent deleted after the property was assigned). uuid[]
-- can't carry a foreign key, so this is the equivalent of ON DELETE SET NULL.
update deals d
set co_agent_ids = coalesce((
  select array_agg(i) from unnest(d.co_agent_ids) i where exists (select 1 from agents a where a.id = i)
), '{}')
where exists (select 1 from unnest(d.co_agent_ids) i where not exists (select 1 from agents a where a.id = i));
