-- ═════════════════════════════════════════════════════════════════════════════
-- DUAL-AGENT DEALS — paste-ready for the Supabase SQL editor
-- Gateway CRM · repo equivalent: migrations/production/2026-07-29_deal_co_agents.sql
--
-- Makes deals.co_agent_ids trustworthy now that the app writes it on every
-- Property → Deal conversion.
--
-- ORDER MATTERS: all data cleanup happens FIRST, and the check constraint is
-- added LAST. An earlier version added the constraint up front and tripped it
-- mid-migration on legacy rows where a property lists its own assigned agent
-- inside details.co_agent_ids (the backfill copied the primary straight back
-- into the deal's roster). Constraint last = no illegal intermediate state.
--
-- Idempotent and re-runnable — it drops the constraint at the start, so a
-- partially-applied previous attempt is cleaned up rather than blocking.
-- Additive: no column is dropped or retyped, and reads only become MORE
-- complete. Standalone: does not depend on any other pending bundle.
--
-- Runs in one transaction, so a failure anywhere leaves the database untouched.
-- ═════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Make re-runs safe ─────────────────────────────────────────────────────
-- Dropped so the cleanup below can run freely; re-added at the end (step 6).
alter table deals drop constraint if exists deals_co_agents_exclude_primary;

-- ── 1. The roster column ─────────────────────────────────────────────────────
-- Already present in production (legacy shape); this covers fresh databases.
alter table deals add column if not exists co_agent_ids uuid[] default '{}';

update deals set co_agent_ids = '{}' where co_agent_ids is null;

-- ── 2. Index for the co-listed-deal lookup ───────────────────────────────────
-- The app filters with `co_agent_ids @> [agent]` (fetchCoListedDealIds), and so
-- does the production RLS helper app_visible_deal_ids(). GIN makes that an
-- index scan instead of a sequential one.
create index if not exists idx_deals_co_agent_ids
  on deals using gin (co_agent_ids);

-- ── 3. Fix the SOURCE data: properties listing their own assigned agent ──────
-- This is where the bad rosters come from. The Property UI hides the assigned
-- agent from the co-agent picker, but if the assignment was CHANGED after a
-- co-agent was picked, the stale id stayed behind in details.co_agent_ids.
-- Cleaning it here means the backfill below reads sane data, and the Property
-- drawer stops showing a phantom co-agent.
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

-- ── 4. Backfill deal rosters from the linked property ────────────────────────
-- Recovers co-agents for deals converted BEFORE the carry-over fix. Only fills
-- rosters that are still empty, so a deal whose roster was edited by hand is
-- never overwritten.
--   • The regex guard skips a malformed id in the jsonb rather than aborting the
--     migration on a cast error (details is free-form jsonb, no shape enforced).
--   • The deal's own primary is excluded explicitly — a property can legitimately
--     be assigned to a DIFFERENT agent than the deal it produced, so step 3
--     alone does not make this safe.
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
  -- Skip rows the backfill would leave empty anyway (property's only co-agent
  -- IS this deal's primary) — avoids a pointless write and an updated_at bump.
  and coalesce(array_length(
        case when d.agent_id is null then sub.ids else array_remove(sub.ids, d.agent_id) end,
      1), 0) > 0;

-- ── 5. Normalize every existing roster ───────────────────────────────────────
-- 5a. The primary must never also be a co-agent (the legacy rows that tripped
--     the constraint on the first attempt).
update deals
set co_agent_ids = array_remove(co_agent_ids, agent_id)
where agent_id is not null
  and agent_id = any(coalesce(co_agent_ids, '{}'));

-- 5b. Drop dangling ids (agent deleted after being assigned). A uuid[] cannot
--     carry a foreign key, so this is the manual equivalent of ON DELETE SET NULL.
update deals d
set co_agent_ids = coalesce((
  select array_agg(i)
  from unnest(d.co_agent_ids) i
  where exists (select 1 from agents a where a.id = i)
), '{}')
where exists (
  select 1 from unnest(d.co_agent_ids) i
  where not exists (select 1 from agents a where a.id = i)
);

-- 5c. Any nulls introduced along the way.
update deals set co_agent_ids = '{}' where co_agent_ids is null;

-- ── 6. The guard, added LAST against clean data ──────────────────────────────
-- Keeps roster(deal) = [agent_id] + co_agent_ids unambiguous and stops
-- "Alex & Alex" on generated paperwork.
alter table deals add constraint deals_co_agents_exclude_primary
  check (agent_id is null or not (agent_id = any(coalesce(co_agent_ids, '{}'))));

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — run this second block on its own; all five rows should be OK
-- ═════════════════════════════════════════════════════════════════════════════
select 'column exists' as check_name,
       case when exists (
         select 1 from information_schema.columns
         where table_name = 'deals' and column_name = 'co_agent_ids'
       ) then 'OK' else 'MISSING' end as result,
       '' as detail
union all
select 'constraint + index',
       case when exists (select 1 from pg_constraint where conname = 'deals_co_agents_exclude_primary')
             and exists (select 1 from pg_indexes  where indexname = 'idx_deals_co_agent_ids')
            then 'OK' else 'MISSING' end,
       ''
union all
select 'no deal names its primary twice',
       case when count(*) = 0 then 'OK' else 'FOUND ' || count(*) end,
       ''
  from deals where agent_id = any(coalesce(co_agent_ids, '{}'))
union all
select 'no property lists its own assigned agent',
       case when count(*) = 0 then 'OK' else 'FOUND ' || count(*) end,
       ''
  from properties p
  where p.assigned_agent_id is not null
    and jsonb_typeof(p.details -> 'co_agent_ids') = 'array'
    and p.details -> 'co_agent_ids' ? p.assigned_agent_id::text
union all
select 'two-agent properties whose deal has no roster',
       case when count(*) = 0 then 'OK' else 'FOUND ' || count(*) end,
       coalesce(string_agg(title, ', '), '')
  from (
    select d.title
    from deals d
    join properties p on p.id = d.property_id
    where jsonb_typeof(p.details -> 'co_agent_ids') = 'array'
      and jsonb_array_length(p.details -> 'co_agent_ids') > 0
      and coalesce(array_length(d.co_agent_ids, 1), 0) = 0
  ) q;

-- Who is on the deals that now carry a co-agent:
--   select d.title,
--          pa.name as primary_agent,
--          (select string_agg(a.name, ', ') from agents a where a.id = any(d.co_agent_ids)) as co_agents
--   from deals d
--   left join agents pa on pa.id = d.agent_id
--   where coalesce(array_length(d.co_agent_ids, 1), 0) > 0
--   order by d.created_at desc;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — the column itself predates this repo, so do NOT drop it
-- ═════════════════════════════════════════════════════════════════════════════
-- alter table deals drop constraint if exists deals_co_agents_exclude_primary;
-- drop index if exists idx_deals_co_agent_ids;
-- -- to undo step 4 only (clears rosters on property-linked deals):
-- -- update deals set co_agent_ids = '{}' where property_id is not null;
