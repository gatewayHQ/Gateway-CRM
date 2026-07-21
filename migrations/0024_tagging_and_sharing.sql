-- Migration 0024 — Tag-based deal visibility + cross-team sharing + config
-- ===========================================================================
-- WHY
--   Deal visibility today is derived from THREE disagreeing sources:
--     • deals.agent_id                     (primary; also the primary chip)
--     • property.details.co_agent_ids      (the EXTRA chips shown on cards)
--     • commissions.participants + deals.co_agent_ids  (what RLS enforces)
--   A person can appear as a chip without DB access, or have access with no
--   chip. This migration collapses all three into ONE source of truth —
--   deal_agents — that the UI renders from and RLS enforces from, so
--   "the chips are who can see it" becomes literally true.
--
-- BUSINESS RULES (Daniel, 2026-07)
--   • An agent sees a deal (+ its property, contacts, commissions) ONLY if
--     tagged on it as primary or additional. Nothing else grants deal sight.
--   • Team membership grants NOTHING by default (strict per-deal). A team may
--     opt-in to "see all team deals" via visibility_settings.
--   • Cross-team partners (e.g. Daniel × Nic) share specific contacts &
--     properties through sharing_groups — never deals or teams.
--   • Pay ≠ access: commissions.participants still drives MONEY; deal_agents
--     drives SIGHT. They are independent.
--   • Admins (agents.is_admin) see everything, firm-wide (unchanged).
--
-- SAFETY MODEL (matches 0002 / 0011)
--   PHASE A  Create tables, BACKFILL tags from all three legacy sources so
--            nobody loses (and the displayed chips gain matching) access, then
--            REFRESH the helper functions so RLS reads the new model. The
--            backfill runs BEFORE the refresh, so the switch is continuous.
--   PHASE B  (Only if this DB still has legacy `allow_all` on scoped tables —
--            fresh installs and post-0011 DBs do not.) Drop any remaining
--            allow_all. Commented at the bottom; run after verifying.
--
--   Idempotent — safe to run more than once. Rollback block at the bottom
--   restores the previous app_visible_deal_ids() definition.
--
--   /api/* serverless functions use the SERVICE key and bypass RLS — webhooks,
--   cron, portal, BoldSign, Twilio, campaigns are all unaffected.
-- ===========================================================================


-- ───────────────────────────────────────────────────────────────────────────
-- 1) TABLES
-- ───────────────────────────────────────────────────────────────────────────

-- deal_agents — the tagging table (SOLE source of deal visibility).
create table if not exists deal_agents (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id)  on delete cascade,
  agent_id   uuid not null references agents(id) on delete cascade,
  role       text not null check (role in ('primary','additional')) default 'additional',
  can_edit   boolean not null default true,   -- future: view-only additional agents
  added_by   uuid references agents(id) on delete set null,
  created_at timestamptz default now(),
  unique (deal_id, agent_id)
);
create unique index if not exists deal_agents_one_primary
  on deal_agents(deal_id) where role = 'primary';
create index if not exists deal_agents_agent_idx on deal_agents(agent_id);
create index if not exists deal_agents_deal_idx  on deal_agents(deal_id);
alter table deal_agents enable row level security;

-- Cross-team partner sharing --------------------------------------------------
create table if not exists sharing_groups (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  created_by  uuid references agents(id) on delete set null,
  archived    boolean not null default false,
  created_at  timestamptz default now()
);
alter table sharing_groups enable row level security;

create table if not exists sharing_group_members (
  id         uuid primary key default uuid_generate_v4(),
  group_id   uuid not null references sharing_groups(id) on delete cascade,
  agent_id   uuid not null references agents(id)         on delete cascade,
  role       text not null check (role in ('owner','member')) default 'member',
  created_at timestamptz default now(),
  unique (group_id, agent_id)
);
create index if not exists sgm_agent_idx on sharing_group_members(agent_id);
alter table sharing_group_members enable row level security;

create table if not exists sharing_group_records (
  id          uuid primary key default uuid_generate_v4(),
  group_id    uuid not null references sharing_groups(id) on delete cascade,
  entity_type text not null check (entity_type in ('contact','property')),
  entity_id   uuid not null,
  shared_by   uuid references agents(id) on delete set null,
  created_at  timestamptz default now(),
  unique (group_id, entity_type, entity_id)
);
create index if not exists sgr_lookup_idx on sharing_group_records(entity_type, entity_id);
create index if not exists sgr_group_idx   on sharing_group_records(group_id);
alter table sharing_group_records enable row level security;

-- Configuration hierarchy (brokerage / team / user) --------------------------
create table if not exists visibility_settings (
  id          uuid primary key default uuid_generate_v4(),
  scope       text not null check (scope in ('brokerage','team','user')),
  scope_id    uuid,                          -- null for brokerage; team_id / agent_id otherwise
  team_deal_visibility text check (team_deal_visibility in ('off','all','leads_only')) default 'off',
  rules       jsonb not null default '{}',   -- e.g. {"by_prop_category":{"commercial":"all"}}
  updated_by  uuid references agents(id) on delete set null,
  updated_at  timestamptz default now(),
  unique (scope, scope_id)
);
alter table visibility_settings enable row level security;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) BACKFILL — seed tags from all three legacy sources (continuity)
-- ───────────────────────────────────────────────────────────────────────────

-- Primary = current owner.
insert into deal_agents (deal_id, agent_id, role)
  select id, agent_id, 'primary' from deals where agent_id is not null
  on conflict (deal_id, agent_id) do nothing;

-- Additional (a) = the chips users SEE: property.details.co_agent_ids, mapped
-- onto every deal referencing that property.
insert into deal_agents (deal_id, agent_id, role)
  select d.id, (ca)::uuid, 'additional'
  from deals d
  join properties pr on pr.id = d.property_id
  cross join lateral jsonb_array_elements_text(coalesce(pr.details->'co_agent_ids','[]'::jsonb)) ca
  where (ca) ~ '^[0-9a-fA-F-]{36}$'
  on conflict (deal_id, agent_id) do nothing;

-- Additional (b) = commission participants (what RLS enforced).
insert into deal_agents (deal_id, agent_id, role)
  select c.deal_id, (p->>'agent_id')::uuid, 'additional'
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants,'[]'::jsonb)) p
  where (p->>'agent_id') ~ '^[0-9a-fA-F-]{36}$'
  on conflict (deal_id, agent_id) do nothing;

-- Additional (c) = legacy deals.co_agent_ids (only exists in the original prod
-- DB; guarded so it no-ops where the column is absent).
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_name='deals' and column_name='co_agent_ids') then
    execute $q$
      insert into deal_agents (deal_id, agent_id, role)
        select id, unnest(co_agent_ids), 'additional' from deals
        where co_agent_ids is not null
        on conflict (deal_id, agent_id) do nothing
    $q$;
  end if;
end $$;

-- Grandfather existing team sharing: any team currently sharing deals keeps
-- "see all team deals" as an explicit setting, so nobody loses access today.
insert into visibility_settings (scope, scope_id, team_deal_visibility)
  select 'team', team_id, 'all'
  from team_splits
  where share_deals is not false and team_id is not null
  group by team_id
  on conflict (scope, scope_id) do nothing;

-- New rows default to strict (existing rows untouched).
alter table team_splits alter column share_contacts   set default false;
alter table team_splits alter column share_properties set default false;
alter table team_splits alter column share_deals       set default false;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) TRIGGER — keep deals.agent_id and the primary tag in lockstep
-- ───────────────────────────────────────────────────────────────────────────
create or replace function sync_primary_deal_agent()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is not null then
    -- remove any stale primary that isn't the new owner
    delete from deal_agents
      where deal_id = new.id and role='primary' and agent_id <> new.agent_id;
    -- upsert the current owner as primary (promote if already an additional tag)
    insert into deal_agents (deal_id, agent_id, role)
      values (new.id, new.agent_id, 'primary')
    on conflict (deal_id, agent_id) do update set role='primary';
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_primary_deal_agent on deals;
create trigger trg_sync_primary_deal_agent
  after insert or update of agent_id on deals
  for each row execute function sync_primary_deal_agent();


-- ───────────────────────────────────────────────────────────────────────────
-- 4) HELPER FUNCTIONS — refresh visibility to read the new model
-- ───────────────────────────────────────────────────────────────────────────

-- Resolve team deal-visibility: user > team > brokerage > 'off', with an
-- optional per-property-category override in `rules`.
create or replace function app_team_deal_visibility(p_team uuid, p_prop_category text)
returns text
language sql stable security definer set search_path = public as $$
  with s as (
    select scope, team_deal_visibility, rules
    from visibility_settings
    where (scope='team' and scope_id = p_team) or scope='brokerage'
  )
  select coalesce(
    (select rules->'by_prop_category'->>p_prop_category from s where scope='team'),
    (select team_deal_visibility from s where scope='team'),
    (select rules->'by_prop_category'->>p_prop_category from s where scope='brokerage'),
    (select team_deal_visibility from s where scope='brokerage'),
    'off'
  );
$$;

-- Every deal the current user may see: admin (all) + explicitly tagged +
-- team-override deals (only when a team opted in).
create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from deals where app_is_admin()
  union
  select deal_id from deal_agents where agent_id = app_current_agent_id()
  union
  select d.id
  from deals d
  join deal_agents da     on da.deal_id = d.id and da.role='primary'
  join team_splits ots    on ots.agent_id = da.agent_id
  join team_splits mts    on mts.team_id  = ots.team_id
                         and mts.agent_id = app_current_agent_id()
  where app_team_deal_visibility(ots.team_id, d.prop_category) in ('all','leads_only');
$$;

-- Contacts shared to me via any (non-archived) sharing group.
create or replace function app_shared_contact_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select r.entity_id
  from sharing_group_records r
  join sharing_group_members m on m.group_id = r.group_id
  join sharing_groups g        on g.id = r.group_id and not g.archived
  where r.entity_type='contact' and m.agent_id = app_current_agent_id();
$$;

-- Properties shared to me via any (non-archived) sharing group.
create or replace function app_shared_property_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select r.entity_id
  from sharing_group_records r
  join sharing_group_members m on m.group_id = r.group_id
  join sharing_groups g        on g.id = r.group_id and not g.archived
  where r.entity_type='property' and m.agent_id = app_current_agent_id();
$$;

grant execute on function app_team_deal_visibility(uuid,text) to authenticated;
grant execute on function app_visible_deal_ids()              to authenticated;
grant execute on function app_shared_contact_ids()            to authenticated;
grant execute on function app_shared_property_ids()           to authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 5) POLICIES
-- ───────────────────────────────────────────────────────────────────────────

-- DEALS — purely tag-driven now (via the refreshed function). with-check also
-- lets an agent create a deal owned by themselves (the trigger tags them).
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  );

-- CONTACTS — own assigned + tagged-deal-linked + group-shared (admins: all).
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_shared_contact_ids())
    or id in (select contact_id from deals where id in (select app_visible_deal_ids()) and contact_id is not null)
    or id in (select contact_id from deal_contacts where deal_id in (select app_visible_deal_ids()))
  )
  with check (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
  );

-- deal_agents — visible for deals you can see; manageable on those deals.
drop policy if exists deal_agents_scope on deal_agents;
create policy deal_agents_scope on deal_agents for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- Sharing groups — members read their groups; owners/admins manage.
drop policy if exists sg_scope on sharing_groups;
create policy sg_scope on sharing_groups for all to authenticated
  using (app_is_admin()
     or id in (select group_id from sharing_group_members where agent_id = app_current_agent_id()))
  with check (app_is_admin() or created_by = app_current_agent_id()
     or id in (select group_id from sharing_group_members where agent_id = app_current_agent_id() and role='owner'));

drop policy if exists sgm_scope on sharing_group_members;
create policy sgm_scope on sharing_group_members for all to authenticated
  using (app_is_admin()
     or group_id in (select group_id from sharing_group_members where agent_id = app_current_agent_id()))
  with check (app_is_admin()
     or group_id in (select group_id from sharing_group_members where agent_id = app_current_agent_id() and role='owner'));

drop policy if exists sgr_scope on sharing_group_records;
create policy sgr_scope on sharing_group_records for all to authenticated
  using (app_is_admin()
     or group_id in (select group_id from sharing_group_members where agent_id = app_current_agent_id()))
  with check (app_is_admin()
     or group_id in (select group_id from sharing_group_members where agent_id = app_current_agent_id()));

-- visibility_settings — everyone reads (needed to resolve their own view);
-- writes are admin-only (team toggles are set by admins/leads through the app).
drop policy if exists vs_read on visibility_settings;
create policy vs_read  on visibility_settings for select to authenticated using (true);
drop policy if exists vs_write on visibility_settings;
create policy vs_write on visibility_settings for all to authenticated
  using (app_is_admin()) with check (app_is_admin());


-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B (run ONLY if legacy allow_all still exists on these tables) ---------
-- ───────────────────────────────────────────────────────────────────────────
-- drop policy if exists allow_all on deals;
-- drop policy if exists allow_all on contacts;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICATION (staging, as a non-admin JWT)
-- ───────────────────────────────────────────────────────────────────────────
--   ✓ Pipeline shows only deals you are tagged on; a teammate's untagged deal
--     is absent (unless their team has team_deal_visibility='all').
--   ✓ Tagging yourself as 'additional' on a peer deal makes it (and its
--     property/contacts) appear; your earnings are unchanged (pay ≠ access).
--   ✓ Removing your tag makes the deal + children disappear on next query.
--   ✓ A contact/property placed in a sharing group appears for group members
--     only; the owner's deals stay private.
-- Diff to review BEFORE Phase B — deals a chip implied but RLS didn't grant:
--   select da.deal_id, da.agent_id from deal_agents da
--   where da.role='additional'
--     and not exists (select 1 from commissions c
--        where c.deal_id=da.deal_id
--          and c.participants @> jsonb_build_array(jsonb_build_object('agent_id', da.agent_id::text)));


-- ───────────────────────────────────────────────────────────────────────────
-- ROLLBACK — restore the previous (0011) visibility definition
-- ───────────────────────────────────────────────────────────────────────────
-- create or replace function app_visible_deal_ids()
-- returns setof uuid language sql stable security definer set search_path=public as $$
--   select d.id from deals d where app_is_admin()
--   union
--   select d.id from deals d where d.agent_id in (select app_visible_agent_ids('deals'))
--   union
--   select c.deal_id from commissions c
--   cross join lateral jsonb_array_elements(coalesce(c.participants,'[]'::jsonb)) p
--   where (p->>'agent_id') ~ '^[0-9a-fA-F-]{36}$'
--     and (p->>'agent_id')::uuid = app_current_agent_id();
-- $$;
-- drop trigger if exists trg_sync_primary_deal_agent on deals;
-- -- (deal_agents / sharing_* / visibility_settings tables may be left in place.)
