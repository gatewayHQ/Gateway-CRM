-- Migration 0025 — Co-agents on the deal (Property → Deal carry-over)
-- ===========================================================================
-- WHY
--   Co-agents (agents who share the commission on a listing without owning the
--   record) are picked on the PROPERTY, in the Co-Agents section, and land in
--   `properties.details.co_agent_ids`. Converting that property into a deal
--   ("Start Deal") copied the address, the contacts and the assigned agent —
--   but not the co-agents. The new deal's "Agents on deal" card showed a single
--   name, the commission editor seeded a single participant, and the co-listing
--   agent had to be re-added by hand or was simply never paid.
--
--   The app has read `deals.co_agent_ids` all along (deal page team card,
--   BoldSign signer prefill, `app_visible_deal_ids()` co-listing branch,
--   /api/portal earnings). That column exists ONLY in the original production
--   database — see `migrations/production/README.md` — so on any database built
--   from `src/lib/schema.sql` those reads had nothing to read and the portal's
--   deal select failed outright on the unknown column.
--
-- WHAT
--   `deals.co_agent_ids uuid[] not null default '{}'` — the agents sharing this
--   deal, excluding the assigned agent in `deals.agent_id`. Plus a GIN index,
--   because both the RLS helper and `fetchCoListedDealIds()` query it with the
--   array-containment operator (`co_agent_ids @> array[<agent>]`).
--
--   In production this ADOPTS the existing legacy column (`add column if not
--   exists`); only the default, the not-null guarantee and the index are new.
--   Fresh installs get the column outright.
--
-- HOW THE APP USES IT
--   • Written at conversion time by "Start Deal" (src/pages/Properties.jsx) and
--     by the pipeline's deal drawer when a NEW deal is linked to a property.
--   • Read through `src/lib/coAgents.js`, which falls back to the linked
--     property for deals converted before this shipped — so no backfill is
--     required for historical pipelines to render the right team.
--   • Seeds co-agent participants in the commission editor
--     (`normalizeCommission` in src/lib/commission.js) until an admin saves an
--     explicit structured split, which then wins as it always has.
--
-- SAFETY
--   Additive and idempotent. No existing row changes meaning: rows already
--   carrying legacy values keep them, and rows with NULL become '{}' — which is
--   exactly how every reader already treated NULL.
-- ===========================================================================

begin;

alter table deals add column if not exists co_agent_ids uuid[];

-- NULL and '{}' were always equivalent to the readers; make that explicit so
-- `array_append`-style updates and the containment index never see NULL.
update deals set co_agent_ids = '{}' where co_agent_ids is null;

alter table deals alter column co_agent_ids set default '{}';

do $$
begin
  alter table deals alter column co_agent_ids set not null;
exception when others then
  -- A concurrent insert could race the backfill above; the default makes this
  -- self-healing on the next run rather than a failed migration.
  raise notice 'deals.co_agent_ids left nullable: %', sqlerrm;
end $$;

-- Containment lookups: RLS (`app_visible_deal_ids()`) and fetchCoListedDealIds.
create index if not exists idx_deals_co_agents on deals using gin (co_agent_ids);

-- ── Visibility ─────────────────────────────────────────────────────────────
-- Carrying co-agents onto the deal only helps if they can READ it. Production's
-- `app_visible_deal_ids()` already has a co_agent_ids branch; the 0011 baseline
-- (every non-production database) does not, so a co-agent would be listed on a
-- deal that RLS then hides from them. Re-create the function with all four
-- branches — identical to production's — so both lineages converge here.
create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from deals d where app_is_admin()
  union
  select d.id from deals d
  where d.agent_id in (select app_visible_agent_ids('deals'))
  union
  -- co-listed via the co-agents carried over from the property
  select d.id from deals d
  where app_current_agent_id() = any(coalesce(d.co_agent_ids, '{}'))
  union
  -- co-listed via structured commission participants
  select c.deal_id
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
  where (p->>'agent_id') is not null
    and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and (p->>'agent_id')::uuid = app_current_agent_id();
$$;

grant execute on function app_visible_deal_ids() to authenticated;

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--  where table_name = 'deals' and column_name = 'co_agent_ids';
--
-- -- Deals whose co-agents were dropped by the pre-0025 conversion, if you want
-- -- the optional backfill (the app already falls back to the property for
-- -- these, so this is a convenience, not a requirement):
-- update deals d
--    set co_agent_ids = (
--          select coalesce(array_agg(distinct x), '{}')
--            from unnest(coalesce(array(select jsonb_array_elements_text(p.details->'co_agent_ids')::uuid), '{}')) as x
--           where x is distinct from d.agent_id)
--   from properties p
--  where p.id = d.property_id
--    and coalesce(array_length(d.co_agent_ids, 1), 0) = 0
--    and jsonb_typeof(p.details->'co_agent_ids') = 'array';
