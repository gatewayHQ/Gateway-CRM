-- ─────────────────────────────────────────────────────────────────────────────
-- 0025 — Admin-controlled Partner (share-all) links between agents (2026-07)
--
-- Extends the co-agent-only default (0024) to ALL entities and adds the only
-- sanctioned way to widen it:
--
--   • Default (everyone): an agent sees deals / contacts / properties they OWN
--     or are tagged on as a co-agent.
--   • Partner link: an ADMIN pairs two agents; each then sees the other's full
--     book (all deals, contacts, properties). Fixed working pairs (e.g. a
--     commercial duo). Agents cannot create, accept, enable, or disable a link —
--     it is strictly admin-controlled.
--
-- This replaces the old team_splits.share_* sharing as the visibility source:
-- app_visible_agent_ids() now resolves to self + partners (admin-created),
-- never team-peer share flags. See docs/co-agent-visibility.md.
--
-- Additive + idempotent. The agent_partners table is created secure from day
-- one (RLS on, admin-only writes), so the admin-only rule holds at the database
-- regardless of the app.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists agent_partners (
  id         uuid primary key default uuid_generate_v4(),
  agent_a    uuid not null references agents(id) on delete cascade,
  agent_b    uuid not null references agents(id) on delete cascade,
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz default now(),
  -- store the pair order-normalized (agent_a < agent_b) so a link is unique
  constraint agent_partners_distinct check (agent_a <> agent_b),
  constraint agent_partners_ordered  check (agent_a < agent_b),
  constraint agent_partners_unique   unique (agent_a, agent_b)
);
create index if not exists idx_agent_partners_a on agent_partners(agent_a);
create index if not exists idx_agent_partners_b on agent_partners(agent_b);

alter table agent_partners enable row level security;
grant select, insert, update, delete on table agent_partners to authenticated, service_role;

-- READ: either member of the pair (they can see each other's data anyway) or admin.
drop policy if exists agent_partners_read on agent_partners;
create policy agent_partners_read on agent_partners for select to authenticated
  using (
    app_is_admin()
    or agent_a = app_current_agent_id()
    or agent_b = app_current_agent_id()
  );

-- WRITE (insert / update / delete): ADMIN ONLY. This is the non-negotiable
-- security rule — no agent can create or remove visibility into another's data.
drop policy if exists agent_partners_admin_write on agent_partners;
create policy agent_partners_admin_write on agent_partners for all to authenticated
  using      (app_is_admin())
  with check (app_is_admin());

-- Agents partnered with the current user (bidirectional).
create or replace function app_partner_agent_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select agent_b from agent_partners where agent_a = app_current_agent_id()
  union
  select agent_a from agent_partners where agent_b = app_current_agent_id();
$$;

-- The set of agent_ids whose data the current user may see: self + partners.
-- Partners share everything, so the dimension argument is accepted (for call-site
-- compatibility) but no longer differentiates — team-peer share flags are retired.
create or replace function app_visible_agent_ids(dimension text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select app_current_agent_id()
  union
  select app_partner_agent_ids();
$$;

-- Deals: admin (firm) OR owned by self/partner OR co-listed (participant, and the
-- legacy co_agent_ids array where that column exists).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'deals' and column_name = 'co_agent_ids'
  ) then
    execute $f$
      create or replace function app_visible_deal_ids()
      returns setof uuid
      language sql stable security definer set search_path = public as $body$
        select d.id from deals d where app_is_admin()
        union
        select d.id from deals d where d.agent_id in (select app_visible_agent_ids('deals'))
        union
        select d.id from deals d where app_current_agent_id() = any(coalesce(d.co_agent_ids, '{}'))
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
    execute $f$
      create or replace function app_visible_deal_ids()
      returns setof uuid
      language sql stable security definer set search_path = public as $body$
        select d.id from deals d where app_is_admin()
        union
        select d.id from deals d where d.agent_id in (select app_visible_agent_ids('deals'))
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

grant execute on function app_partner_agent_ids()     to authenticated;
grant execute on function app_visible_agent_ids(text)  to authenticated;
grant execute on function app_visible_deal_ids()       to authenticated;
