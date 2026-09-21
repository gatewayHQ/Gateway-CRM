-- Migration 0052 — Merge property co-agents instead of only filling blanks
-- ===========================================================================
-- WHY THIS IS URGENT, AND WHY IT COMES BEFORE 0049 ON A LIVE DATABASE
--
-- Today, on a database where 0049 has NOT been applied, the only policy on the
-- deal-documents bucket is the one the app's own setup panel printed:
--
--     create policy "agents_deal_docs" on storage.objects for all to authenticated
--     using (bucket_id = 'deal-documents') with check (bucket_id = 'deal-documents');
--
-- That is bucket-wide and unconditional: EVERY signed-in agent can read EVERY
-- deal's documents. So nobody is currently blocked by storage, and applying
-- 0049 does not widen access — it NARROWS it, from "everyone" down to "the
-- agents on the deal". That is the right destination, but it means
-- `deals.co_agent_ids` stops being cosmetic the moment 0049 lands: an agent
-- missing from it loses access they have right now.
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- The backfill in 0049 (and restated in 0051) only fills deals whose array is
-- EMPTY:
--
--     where coalesce(array_length(d2.co_agent_ids, 1), 0) = 0
--
-- A deal that is PARTIALLY populated is skipped entirely. Measured on a real
-- database mid-diagnosis:
--
--     deal bf61b854   granted co-agents = 1   shown via property = 2
--     deal 532a1d55   granted co-agents = 0   shown via property = 1
--
-- 532a1d55 is covered — its array is empty. bf61b854 is NOT: it already has
-- one co-agent, so the backfill skips it, and the SECOND agent the deal page
-- has been displaying all along never reaches the column. Apply 0049 to that
-- database and one agent silently stops seeing a deal's documents — caused by
-- the migration meant to fix exactly that.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────
-- Replaces fill-if-empty with a UNION: every co-agent the linked property
-- lists is merged into whatever the deal already carries. Nothing is removed —
-- a co-agent added on the deal but not on the property keeps their place, and
-- the assigned agent is never also a co-agent.
--
-- Idempotent. Re-running changes nothing once the two agree.
--
-- SAFE TO RUN BEFORE 0049. It only writes deals.co_agent_ids, touches no
-- policy and no storage object, so it cannot itself change who sees what while
-- `agents_deal_docs` is still the operative rule. Run it FIRST, confirm the
-- numbers line up, then apply 0049/0051.
-- ===========================================================================

begin;

update deals d
   set co_agent_ids = merged.ids
  from (
    select d2.id,
           (
             -- what the deal already grants
             select coalesce(array_agg(distinct x), '{}')
               from (
                 select unnest(coalesce(d2.co_agent_ids, '{}')) as x
                 union
                 -- what the property (and therefore the team card) shows
                 select nullif(v, '')::uuid
                   from jsonb_array_elements_text(p.details->'co_agent_ids') as t(v)
                  where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               ) both_sources
              where x is not null
                and x is distinct from d2.agent_id   -- the owner is never a co-agent
           ) as ids
      from deals d2
      join properties p on p.id = d2.property_id
     where jsonb_typeof(p.details->'co_agent_ids') = 'array'
  ) merged
 where d.id = merged.id
   -- Only touch rows that actually change, so re-runs are free and the row
   -- count below means something.
   and not (d.co_agent_ids @> merged.ids and d.co_agent_ids <@ merged.ids);

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- Every deal should now show granted >= shown-via-property. Any row where
-- granted is still lower is a deal whose property lists an id that is not a
-- real agent — worth looking at by hand before 0049 narrows access.
--
-- select left(d.id::text,8) as deal,
--        coalesce(array_length(d.co_agent_ids,1),0) as granted,
--        coalesce(jsonb_array_length(p.details->'co_agent_ids'),0) as shown_via_property
--   from deals d join properties p on p.id = d.property_id
--  where jsonb_typeof(p.details->'co_agent_ids') = 'array'
--  order by 2 - 3;
