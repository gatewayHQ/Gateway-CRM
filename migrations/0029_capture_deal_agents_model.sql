-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 — Capture the live deal-visibility model into source control (F-03)
--
-- The production database's deal visibility runs on a `deal_agents` ownership
-- table + a per-team/brokerage `visibility_settings` table, surfaced through
-- app_team_deal_visibility() and app_visible_deal_ids(). That model was built in
-- the Supabase dashboard and existed in NO repo file — schema.sql still described
-- the older deals.agent_id + commissions.participants model. This migration
-- writes the real model into source control so a fresh deploy / DR rebuild
-- reproduces production exactly, and reconciles two redundant triggers.
--
-- This is a faithful capture of what already runs in prod. It is idempotent and
-- a no-op there (create-if-not-exists / create-or-replace); it MATTERS for fresh
-- installs and for keeping schema.sql honest.
--
-- Depends on: app_current_agent_id, app_is_admin, app_visible_agent_ids (0011).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists visibility_settings (
  id                   uuid primary key default uuid_generate_v4(),
  scope                text not null check (scope in ('team','brokerage')),
  scope_id             uuid,                       -- team id when scope='team'; null for brokerage
  team_deal_visibility text default 'off',         -- 'all' | 'leads_only' | 'off'
  rules                jsonb not null default '{}', -- { by_prop_category: { residential: 'all', ... } }
  updated_by           uuid references agents(id) on delete set null,
  updated_at           timestamptz default now()
);
create unique index if not exists visibility_settings_scope_idx
  on visibility_settings (scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists deal_agents (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id)  on delete cascade,
  agent_id   uuid not null references agents(id) on delete cascade,
  role       text not null default 'additional', -- 'primary' | 'additional'
  can_edit   boolean not null default true,
  added_by   uuid references agents(id) on delete set null,
  created_at timestamptz default now(),
  unique (deal_id, agent_id)
);
create index if not exists deal_agents_agent_idx on deal_agents(agent_id);
create index if not exists deal_agents_deal_idx  on deal_agents(deal_id);

-- ── Functions ────────────────────────────────────────────────────────────────
-- Per-team / brokerage deal-visibility resolver (category override → team →
-- brokerage → 'off'). Reads visibility_settings.
create or replace function app_team_deal_visibility(p_team uuid, p_prop_category text)
returns text language sql stable security definer set search_path = public as $$
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

-- Every deal the current user may see: all (admin), any deal they are linked to
-- in deal_agents, or a team peer's primary deal the team is allowed to see.
create or replace function app_visible_deal_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from deals where app_is_admin()
  union
  select deal_id from deal_agents where agent_id = app_current_agent_id()
  union
  select d.id
  from deals d
  join deal_agents da  on da.deal_id = d.id and da.role = 'primary'
  join team_splits ots on ots.agent_id = da.agent_id
  join team_splits mts on mts.team_id  = ots.team_id
                      and mts.agent_id = app_current_agent_id()
  where app_team_deal_visibility(ots.team_id, d.prop_category) in ('all','leads_only');
$$;

-- Keep the primary deal_agents link in sync with deals.agent_id.
create or replace function sync_primary_deal_agent()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is not null then
    delete from deal_agents
      where deal_id = new.id and role='primary' and agent_id <> new.agent_id;
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

-- Owner guard: stamp a null owner to the creator, and enforce the "self or a
-- sharing teammate" rule with human-readable errors. Admins/service bypass.
create or replace function app_deal_owner_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare me uuid;
begin
  if auth.uid() is null then return new; end if;          -- service key / cron
  if app_is_admin() then return new; end if;
  me := app_current_agent_id();
  if me is null then
    raise exception 'Your login is not linked to an agent profile yet, so the deal could not be created. Finish setting up your profile, or ask an admin to link your account.'
      using errcode = '42501';
  end if;
  if new.agent_id is null then new.agent_id := me; end if;
  if new.agent_id not in (select app_visible_agent_ids('deals')) then
    raise exception 'Deals can only be created for yourself or a teammate who shares deals with you. Assign the deal to yourself, or ask an admin to create it for another agent.'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists deals_owner_guard on deals;
create trigger deals_owner_guard
  before insert on deals
  for each row execute function app_deal_owner_guard();

-- ── Policies ─────────────────────────────────────────────────────────────────
alter table visibility_settings enable row level security;
drop policy if exists vs_read  on visibility_settings;
drop policy if exists vs_write on visibility_settings;
create policy vs_read  on visibility_settings for select using (true);
create policy vs_write on visibility_settings for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

alter table deal_agents enable row level security;
drop policy if exists deal_agents_scope on deal_agents;
create policy deal_agents_scope on deal_agents for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- ── Reconcile redundant triggers ─────────────────────────────────────────────
-- app_deal_owner_guard supersedes the 0024 owner-stamp (it stamps AND validates
-- with friendly errors), so retire the older one.
drop trigger   if exists deals_stamp_owner_trg on deals;
drop function  if exists deals_stamp_owner();
-- Two identical BEFORE UPDATE set_updated_at triggers existed; keep deals_updated_at.
drop trigger   if exists deals_set_updated_at on deals;

-- ── Backfill (idempotent safety; prod already fully linked) ───────────────────
insert into deal_agents (deal_id, agent_id, role)
select id, agent_id, 'primary' from deals where agent_id is not null
on conflict (deal_id, agent_id) do update set role = 'primary';
