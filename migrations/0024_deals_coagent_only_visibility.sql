-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 — Co-agent-only deal visibility (2026-07)
--
-- Product change: a team member sees a deal ONLY when they OWN it (primary
-- agent) or are TAGGED on it as a CO-AGENT (commission participant, or the
-- legacy deals.co_agent_ids array where that column exists). Being on the same
-- team as the deal's owner is NO LONGER sufficient — the team-peer branch is
-- removed from app_visible_deal_ids().
--
-- This is defense-in-depth for the app-level scoping in src/App.jsx /
-- src/lib/services/deals.js (fetchTaggedDeals). The RLS function is the hard
-- backstop; the client already fetches co-agent-only. See
-- docs/co-agent-visibility.md.
--
-- Additive + idempotent (create or replace). Safe to re-run. The legacy
-- deals.co_agent_ids co-agent branch is included only when that column exists
-- (production has it; fresh installs from schema.sql do not), mirroring
-- src/lib/services/deals.js#fetchCoListedDealIds.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'deals' and column_name = 'co_agent_ids'
  ) then
    -- Production shape: own + legacy co_agent_ids + commission participants.
    execute $f$
      create or replace function app_visible_deal_ids()
      returns setof uuid
      language sql stable security definer set search_path = public as $body$
        select d.id from deals d where app_is_admin()
        union
        select d.id from deals d
        where d.agent_id = app_current_agent_id()
        union
        select d.id from deals d
        where app_current_agent_id() = any(coalesce(d.co_agent_ids, '{}'))
        union
        select c.deal_id
        from commissions c
        cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
        where (p->>'agent_id') is not null
          and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and (p->>'agent_id')::uuid = app_current_agent_id();
      $body$;
    $f$;
  else
    -- Repo/schema.sql shape: own + commission participants (no legacy column).
    execute $f$
      create or replace function app_visible_deal_ids()
      returns setof uuid
      language sql stable security definer set search_path = public as $body$
        select d.id from deals d where app_is_admin()
        union
        select d.id from deals d
        where d.agent_id = app_current_agent_id()
        union
        select c.deal_id
        from commissions c
        cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
        where (p->>'agent_id') is not null
          and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and (p->>'agent_id')::uuid = app_current_agent_id();
      $body$;
    $f$;
  end if;
end $$;

grant execute on function app_visible_deal_ids() to authenticated;

-- Write path: members may create/own only their own deals; they may still edit
-- any deal they can already see (own or co-listed). Admins unrestricted.
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or id in (select app_visible_deal_ids())
  );
