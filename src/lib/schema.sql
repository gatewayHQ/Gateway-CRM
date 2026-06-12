-- Gateway CRM — Full Database Schema
-- Run in Supabase SQL Editor (Table Editor → SQL Editor → New Query → Run)
-- Safe to re-run: uses IF NOT EXISTS and IF EXISTS guards throughout

create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agents (
  id         uuid primary key default uuid_generate_v4(),
  auth_id    uuid unique,                  -- links to Supabase Auth user
  name       text not null,
  initials   text not null,
  role       text not null,
  email      text unique not null,
  color      text default '#2d3561',
  team_id    uuid,                         -- future: multi-team support
  specialty  text check (specialty in ('residential', 'commercial')),
  phone      text,                         -- shown on landing-page advisor card
  photo_url  text,                         -- headshot (public URL)
  bio        text,                         -- short advisor bio for landing pages
  tagline    text,                          -- one-line positioning for the advisor profile page
  stats      jsonb not null default '[]',   -- [{label,value}] public vanity stats curated by the agent
  default_split_pct  numeric default 70,   -- agent's default % share of a commission allocation
  no_brokerage_split boolean default false,-- true = keeps 100% (capped / no split)
  is_admin   boolean default false,        -- office admin: sees all deals/docs/commissions
  nav_hidden text[] default '{}',          -- nav item IDs hidden from this agent's sidebar
  cap_amount      numeric,                 -- brokerage cap in dollars; null = no cap configured
  cap_anniversary date,                    -- cap year resets on this month/day; null = calendar year
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTACTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists contacts (
  id                uuid primary key default uuid_generate_v4(),
  first_name        text not null,
  last_name         text not null,
  email             text,
  phone             text,
  type              text check (type in ('buyer','seller','landlord','tenant','investor')) default 'buyer',
  status            text check (status in ('active','cold','closed','lead','opportunity','pending')) default 'active',
  source            text check (source in ('referral','website','open house','social','cold call','team','paid service','other')) default 'other',
  assigned_agent_id uuid references agents(id) on delete set null,
  notes             text,
  tags              text[],
  last_contacted_at timestamptz,
  -- Where the contact lives / is originally from
  owner_address     text,
  owner_city        text,
  owner_state       text,
  owner_zip         text,
  -- Annual reminders
  birthday          date,
  anniversary_date  date,
  -- Spouse / significant other (household relationship)
  spouse_name       text,
  spouse_phone      text,
  spouse_notes      text,
  -- Buyer / investor search criteria (for matching)
  submarket         text,          -- target area / county
  asset_types       text[],        -- e.g. ['multifamily','office']
  size_min          numeric,
  size_max          numeric,
  size_unit         text default 'sqft',  -- sqft | acres | units
  created_at        timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PROPERTIES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists properties (
  id                uuid primary key default uuid_generate_v4(),
  address           text not null,
  city              text,
  state             text,
  zip               text,
  county            text,
  type              text check (type in (
                      'residential','rental','multifamily',
                      'office','land','retail','industrial','mixed-use','commercial'
                    )) default 'residential',
  status            text check (status in (
                      'active','pending','sold','off-market','leased','cancelled'
                    )) default 'active',
  list_price        numeric,
  sqft              numeric,
  beds              integer,
  baths             numeric,
  garage            integer default 0,
  mls_number        text,
  linked_contact_id uuid references contacts(id) on delete set null,
  assigned_agent_id uuid references agents(id) on delete set null,
  notes             text,
  details           jsonb default '{}',   -- flexible commercial / type-specific fields
  created_at        timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DEALS  (Pipeline)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deals (
  id                  uuid primary key default uuid_generate_v4(),
  title               text not null,
  contact_id          uuid references contacts(id) on delete set null,
  property_id         uuid references properties(id) on delete set null,
  agent_id            uuid references agents(id) on delete set null,
  -- stage tokens cover all three boards (src/lib/stages.js): shared/legacy,
  -- the commercial track, and the residential seller track (Milestone 1)
  stage               text check (stage in (
                        'lead','qualified','showing','offer',
                        'under-contract','closed','lost',
                        'pursuit','om-marketing','listing-agreement','on-market',
                        'loi','psa','due-diligence',
                        'pre-list','active'
                      )) default 'lead',
  value               numeric constraint deals_value_nonneg
                        check (value is null or value >= 0),
  probability         integer default 0 constraint deals_probability_range
                        check (probability is null or (probability >= 0 and probability <= 100)),
  expected_close_date date,
  notes               text,
  prop_category       text,                 -- 'residential' | 'commercial' (deal-level category)
  prop_subtype        text,                 -- commercial subtype: multifamily, office, land, retail, industrial
  comp_data           jsonb default '{}',   -- { key_dates:[{type,date}], portal_docs:[name], state, transaction_type }
  portal_token        uuid,                 -- client portal share token (unguessable)
  portal_enabled      boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create unique index if not exists deals_portal_token_idx
  on deals(portal_token) where portal_token is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- TASKS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists tasks (
  id         uuid primary key default uuid_generate_v4(),
  title      text not null,
  type       text check (type in ('call','email','showing','follow-up','document','other')) default 'other',
  priority   text check (priority in ('high','medium','low')) default 'medium',
  due_date   timestamptz,
  completed  boolean default false,
  contact_id uuid references contacts(id) on delete set null,
  deal_id    uuid references deals(id) on delete set null,
  agent_id   uuid references agents(id) on delete set null,
  notes      text,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL TEMPLATES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists templates (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  subject     text not null,
  body        text not null,
  category    text check (category in ('intro','follow-up','offer','closing','nurture')) default 'follow-up',
  agent_id    uuid references agents(id) on delete set null,
  usage_count integer default 0,
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ACTIVITIES  (timeline — calls, notes, emails, meetings, showings)
-- An activity can attach to a contact, a deal, or both (e.g. a call about a
-- specific deal logs to the contact's history AND the deal's timeline).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists activities (
  id         uuid primary key default uuid_generate_v4(),
  contact_id uuid references contacts(id) on delete cascade,
  deal_id    uuid references deals(id) on delete set null,
  agent_id   uuid references agents(id) on delete set null,
  type       text check (type in ('note','call','email','meeting','showing')) default 'note',
  body       text not null,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENTS  (files attached to deals)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists documents (
  id          uuid primary key default uuid_generate_v4(),
  deal_id     uuid references deals(id) on delete cascade,
  agent_id    uuid references agents(id) on delete set null,
  name        text not null,
  size        bigint,
  mime_type   text,
  storage_path text,               -- Supabase Storage object path
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical model: one commission row per deal (keyed by deal_id). Two layers:
--   • Legacy flat columns (gross_pct … transaction_fee) — kept for backward
--     compatibility; the app upgrades them on the fly via src/lib/commission.js.
--   • Structured columns (sides, participants) — the complex model: two-sided
--     deals, per-side referrals, and per-agent brokerage arrangements. When
--     these are non-empty they are authoritative. Dollar amounts are always
--     derived in the app from the deal value — never stored.
create table if not exists commissions (
  id              uuid primary key default uuid_generate_v4(),
  deal_id         uuid references deals(id) on delete cascade unique not null,
  gross_pct       numeric not null default 3.0,    -- legacy: gross commission % of deal value
  broker_pct      numeric not null default 30.0,   -- legacy: brokerage share of the split
  agent_pct       numeric not null default 70.0,   -- legacy: agent share of the split
  referral_pct    numeric not null default 0,      -- legacy: referral fee off the top
  co_agent_pct    numeric not null default 0,      -- legacy: co-agent share of agent gross
  transaction_fee numeric not null default 0,      -- flat per-deal brokerage fee, split across agents, charged on top of cap
  sides           jsonb not null default '[]',     -- [{ key,label,rate_pct,referral_pct,referral_flat }]
  participants    jsonb not null default '[]',     -- [{ id,agent_id,name,role,allocation_pct,split_pct,no_split,fee }] (fee = per-agent override of the flat-fee share)
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- RLS is enabled here for the core tables. Policies come in two flavors:
--   • SHARED tables (agents, properties, templates, …) keep a permissive
--     allow_all policy — created just below.
--   • SCOPED tables (contacts, deals, commissions, activities, tasks, and the
--     deal-children: documents, docusign_envelopes, transaction_steps,
--     deadline_reminders, agent_notifications) are governed by the agent/team/
--     co-listing policies defined in the "SCOPED RLS POLICIES" section at the
--     END of this file (they depend on tables created later). Fresh installs
--     are scoped from day one; existing databases reach the same state via
--     migrations 0002 + 0011.
-- ─────────────────────────────────────────────────────────────────────────────
alter table agents      enable row level security;
alter table contacts    enable row level security;
alter table properties  enable row level security;
alter table deals       enable row level security;
alter table tasks       enable row level security;
alter table templates   enable row level security;
alter table activities  enable row level security;
alter table documents   enable row level security;
alter table commissions enable row level security;

-- Open access for all authenticated users on intentionally-shared tables
do $$ begin
  -- agents (roster is shared: pickers, avatars, landing pages)
  if not exists (select 1 from pg_policies where tablename='agents' and policyname='allow_all') then
    create policy "allow_all" on agents for all using (true) with check (true);
  end if;
  -- properties (read anonymously by the public PropertyLanding page — scope
  -- only after that read moves behind a service-key API; see migrations/README)
  if not exists (select 1 from pg_policies where tablename='properties' and policyname='allow_all') then
    create policy "allow_all" on properties for all using (true) with check (true);
  end if;
  -- templates (shared across all agents by design)
  if not exists (select 1 from pg_policies where tablename='templates' and policyname='allow_all') then
    create policy "allow_all" on templates for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TEAMS  (collaboration and split-commission team types)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists teams (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  type        text check (type in ('collaboration','split')) default 'collaboration',
  description text,
  created_at  timestamptz default now()
);

alter table teams enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='teams' and policyname='allow_all') then
    create policy "allow_all" on teams for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TEAM SPLITS  (per-member split % for split-type teams)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists team_splits (
  id               uuid primary key default uuid_generate_v4(),
  team_id          uuid references teams(id) on delete cascade,
  agent_id         uuid references agents(id) on delete cascade,
  split_pct        numeric default 0 check (split_pct >= 0 and split_pct <= 100),
  is_lead          boolean default false,
  share_contacts   boolean default true,   -- peer can see this member's contacts
  share_properties boolean default true,   -- peer can see this member's properties
  share_deals      boolean default true,   -- peer can see this member's pipeline deals
  created_at       timestamptz default now(),
  unique(team_id, agent_id)
);

alter table team_splits enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='team_splits' and policyname='allow_all') then
    create policy "allow_all" on team_splits for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENT NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agent_notifications (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade,
  deal_id     uuid references deals(id) on delete set null,
  envelope_id text,
  title       text,
  message     text,
  type        text default 'general',
  read        boolean default false,
  created_at  timestamptz default now()
);

alter table agent_notifications enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUSIGN ENVELOPES  (named to match app code)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists docusign_envelopes (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade,
  document_id   uuid references documents(id) on delete set null,
  agent_id      uuid references agents(id) on delete set null,
  envelope_id   text not null,
  status        text default 'sent',
  subject       text,
  signer_name   text,
  signer_email  text,
  document_name text,
  signers       jsonb default '[]',
  sent_at       timestamptz default now(),
  completed_at  timestamptz,
  created_at    timestamptz default now()
);

alter table docusign_envelopes enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- TRANSACTION STEPS  (closing checklists per deal)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists transaction_steps (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade,
  title         text not null,
  completed     boolean default false,
  completed_at  timestamptz,
  sort_order    integer default 0,
  doc_action    text    default 'manual',  -- manual | upload | forms | sign | admin
  doc_status    text    default 'pending', -- pending | complete | approved | na
  if_applicable boolean default false,     -- conditional document ("if applicable")
  created_at    timestamptz default now()
);

alter table transaction_steps enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUSIGN FIELD TEMPLATES  (pre-built anchor tab configs per document type)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists docusign_field_templates (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,             -- e.g. "Purchase Agreement"
  doc_type      text not null unique,      -- key for lookup (purchase_agreement, listing_agreement…)
  description   text,
  anchor_tabs   jsonb not null default '[]',  -- array of anchor tab definitions
  agent_id      uuid references agents(id) on delete set null,  -- null = system default
  created_at    timestamptz default now()
);

alter table docusign_field_templates enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='docusign_field_templates' and policyname='allow_all') then
    create policy "allow_all" on docusign_field_templates for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION  (run this block if upgrading an existing database)
-- ─────────────────────────────────────────────────────────────────────────────
-- alter table agents      add column if not exists auth_id uuid unique;
-- alter table agents      add column if not exists team_id uuid;
-- alter table contacts    add column if not exists owner_address    text;
-- alter table contacts    add column if not exists owner_city       text;
-- alter table contacts    add column if not exists owner_state      text;
-- alter table contacts    add column if not exists owner_zip        text;
-- alter table contacts    add column if not exists birthday         date;
-- alter table contacts    add column if not exists anniversary_date date;
-- alter table contacts    add column if not exists spouse_name      text;
-- alter table contacts    add column if not exists spouse_phone     text;
-- alter table contacts    add column if not exists spouse_notes     text;
-- alter table properties  add column if not exists county  text;
-- alter table properties  add column if not exists garage  integer default 0;
-- alter table properties  add column if not exists details jsonb   default '{}';
-- alter table deals       add column if not exists prop_category text;
-- alter table deals       add column if not exists prop_subtype  text;
-- alter table deals       add column if not exists comp_data     jsonb default '{}';
-- alter table teams       add column if not exists type text check (type in ('collaboration','split')) default 'collaboration';
-- alter table teams       add column if not exists description text;
-- -- Fix properties type constraint to include full set
-- alter table properties drop constraint if exists properties_type_check;
-- alter table properties add  constraint properties_type_check
--   check (type in ('residential','rental','multifamily','office','land','retail','industrial','mixed-use','commercial'));
-- -- Fix properties status constraint to include 'leased'
-- alter table properties drop constraint if exists properties_status_check;
-- alter table properties add  constraint properties_status_check
--   check (status in ('active','pending','sold','off-market','leased'));
-- -- Fix contacts source constraint to include 'cold call'
-- alter table contacts drop constraint if exists contacts_source_check;
-- alter table contacts add  constraint contacts_source_check
--   check (source in ('referral','website','open house','social','cold call','other'));
-- -- Team sharing flags: run after deploying Team refactor (2026-05)
-- alter table team_splits add column if not exists share_contacts   boolean default true;
-- alter table team_splits add column if not exists share_properties boolean default true;
-- alter table team_splits add column if not exists share_deals      boolean default true;
-- -- Remove legacy team column from agents (no longer used for membership)
-- alter table agents drop column if exists team_id;
-- -- Buyer/investor search criteria (for buyer matching feature)
-- alter table contacts add column if not exists submarket   text;
-- alter table contacts add column if not exists asset_types text[];
-- alter table contacts add column if not exists size_min    numeric;
-- alter table contacts add column if not exists size_max    numeric;
-- alter table contacts add column if not exists size_unit   text default 'sqft';

-- ─────────────────────────────────────────────────────────────────────────────
-- PERFORMANCE INDEXES
-- Run this migration block to enable production-scale query performance.
-- Each index here targets a specific query pattern used by the app.
-- Expected improvement: 10–100x on filtered queries over large datasets.
-- ─────────────────────────────────────────────────────────────────────────────

-- contacts — primary lookup patterns
create index if not exists idx_contacts_agent        on contacts(assigned_agent_id);
create index if not exists idx_contacts_created      on contacts(created_at desc);
create index if not exists idx_contacts_status       on contacts(status);
create index if not exists idx_contacts_type         on contacts(type);
create index if not exists idx_contacts_agent_status on contacts(assigned_agent_id, status);
-- Full-text search on contact name (used by search inputs)
create index if not exists idx_contacts_name_fts     on contacts using gin(to_tsvector('english', first_name || ' ' || last_name));

-- properties — primary lookup patterns
create index if not exists idx_properties_agent        on properties(assigned_agent_id);
create index if not exists idx_properties_created      on properties(created_at desc);
create index if not exists idx_properties_status       on properties(status);
create index if not exists idx_properties_type         on properties(type);
create index if not exists idx_properties_agent_status on properties(assigned_agent_id, status);
create index if not exists idx_properties_contact      on properties(linked_contact_id);

-- deals — primary lookup patterns
create index if not exists idx_deals_agent    on deals(agent_id);
create index if not exists idx_deals_stage    on deals(stage);
create index if not exists idx_deals_created  on deals(created_at desc);
create index if not exists idx_deals_contact  on deals(contact_id);
create index if not exists idx_deals_property on deals(property_id);
create index if not exists idx_deals_close    on deals(expected_close_date) where stage not in ('closed','lost');

-- tasks — always queried by agent + completion state
create index if not exists idx_tasks_agent          on tasks(agent_id);
create index if not exists idx_tasks_agent_complete on tasks(agent_id, completed);
create index if not exists idx_tasks_due            on tasks(due_date asc) where completed = false;
create index if not exists idx_tasks_contact        on tasks(contact_id);
create index if not exists idx_tasks_deal           on tasks(deal_id);

-- activities — contact + deal timeline queries
create index if not exists idx_activities_contact on activities(contact_id, created_at desc);
create index if not exists idx_activities_deal    on activities(deal_id, created_at desc);
create index if not exists idx_activities_agent   on activities(agent_id);

-- commissions
-- commissions are keyed uniquely by deal_id (the unique constraint already
-- provides the lookup index); no agent_id/paid columns in the canonical model.
create index if not exists idx_commissions_deal    on commissions(deal_id);

-- agent_notifications — real-time inbox queries
create index if not exists idx_notif_agent_unread on agent_notifications(agent_id, read) where read = false;
create index if not exists idx_notif_created      on agent_notifications(created_at desc);

-- docusign_envelopes — deal document queries
create index if not exists idx_ds_envelopes_deal   on docusign_envelopes(deal_id);
create index if not exists idx_ds_envelopes_agent  on docusign_envelopes(agent_id);
create index if not exists idx_ds_envelopes_status on docusign_envelopes(status) where status not in ('completed','voided');

-- transaction_steps — deal checklist queries
create index if not exists idx_txn_steps_deal  on transaction_steps(deal_id, sort_order);

-- templates — agent-scoped queries
create index if not exists idx_templates_agent on templates(agent_id, created_at desc);

-- team_splits — team resolution (hot path on every login)
create index if not exists idx_team_splits_agent on team_splits(agent_id);
create index if not exists idx_team_splits_team  on team_splits(team_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- FULL-TEXT SEARCH FUNCTION
-- Enables server-side contact/property search without fetching all rows.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function search_contacts(search_term text, agent_ids uuid[], result_limit int default 50)
returns setof contacts
language sql stable
as $$
  select * from contacts
  where assigned_agent_id = any(agent_ids)
    and (
      to_tsvector('english', first_name || ' ' || last_name) @@ plainto_tsquery('english', search_term)
      or lower(email)   like '%' || lower(search_term) || '%'
      or lower(phone)   like '%' || lower(search_term) || '%'
      or lower(owner_city) like '%' || lower(search_term) || '%'
    )
  order by created_at desc
  limit result_limit;
$$;

create or replace function search_properties(search_term text, agent_ids uuid[], result_limit int default 50)
returns setof properties
language sql stable
as $$
  select * from properties
  where assigned_agent_id = any(agent_ids)
    and (
      lower(address) like '%' || lower(search_term) || '%'
      or lower(city)  like '%' || lower(search_term) || '%'
      or lower(mls_number) like '%' || lower(search_term) || '%'
    )
  order by created_at desc
  limit result_limit;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATED_AT TRIGGER  (auto-stamp deals.updated_at on every update)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists deals_updated_at on deals;
create trigger deals_updated_at
  before update on deals
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- DASHBOARD STATS VIEW
-- Pre-aggregated stats for the dashboard — single query instead of 6.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view agent_dashboard_stats as
select
  a.id                                                   as agent_id,
  count(distinct c.id)                                   as total_contacts,
  count(distinct c.id) filter (where c.status = 'active') as active_contacts,
  count(distinct p.id)                                   as total_properties,
  count(distinct d.id) filter (where d.stage not in ('closed','lost')) as open_deals,
  count(distinct d.id) filter (where d.stage = 'closed') as closed_deals,
  coalesce(sum(d.value) filter (where d.stage = 'closed'), 0) as closed_volume,
  count(distinct t.id) filter (where t.completed = false and t.due_date < now()) as overdue_tasks
from agents a
left join contacts    c    on c.assigned_agent_id = a.id
left join properties  p    on p.assigned_agent_id = a.id
left join deals       d    on d.agent_id = a.id
left join tasks       t    on t.agent_id = a.id
group by a.id;

-- Grant read access to authenticated users
grant select on agent_dashboard_stats to authenticated;
grant execute on function search_contacts(text, uuid[], int) to authenticated;
grant execute on function search_properties(text, uuid[], int) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- MAILINGS (v2) — QR-first mailing campaigns & tracking.
--
-- This is the canonical mailing system. The legacy v1 tables
-- (mail_campaigns / mail_sends / mail_suppressions) have been removed — see
-- migrations/0001_drop_mailing_v1.sql to drop them from an existing database.
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists mailings (
  id                     uuid primary key default uuid_generate_v4(),
  name                   text not null,
  description            text,
  agent_id               uuid references agents(id) on delete set null,
  property_id            uuid references properties(id) on delete set null,
  mailing_type           text check (mailing_type in ('postcard','letter','flyer','door-hanger','other')) default 'postcard',
  status                 text check (status in ('draft','active','sent','archived')) default 'draft',
  qr_token               text not null unique,                -- short slug → /m/{token}
  landing_type           text check (landing_type in ('property','valuation','custom','multifamily')) default 'property',
  landing_custom_url     text,                                -- only used when landing_type='custom'
  landing_config         jsonb default '{}',                  -- collage/headline/highlights for custom + multifamily landings
  send_date              date,                                -- when the mailer was/will be dropped
  recipient_count        integer default 0,                   -- denormalized counter
  scan_count             integer default 0,                   -- denormalized counter
  lead_count             integer default 0,                   -- denormalized counter
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Migration for existing installs: add landing_config + multifamily landing_type
alter table mailings add column if not exists landing_config jsonb default '{}';
do $$ begin
  alter table mailings drop constraint if exists mailings_landing_type_check;
  alter table mailings add constraint mailings_landing_type_check
    check (landing_type in ('property','valuation','custom','multifamily'));
exception when others then null; end $$;

-- Allow 'multifamily' as a valid lead source_landing for existing installs
do $$ begin
  alter table mailing_leads drop constraint if exists mailing_leads_source_landing_check;
  alter table mailing_leads add constraint mailing_leads_source_landing_check
    check (source_landing in ('property','valuation','custom','multifamily'));
exception when others then null; end $$;

create index if not exists mailings_agent_id_idx     on mailings(agent_id);
create index if not exists mailings_status_idx       on mailings(status);
create index if not exists mailings_property_id_idx  on mailings(property_id);
create index if not exists mailings_qr_token_idx     on mailings(qr_token);

drop trigger if exists mailings_updated_at on mailings;
create trigger mailings_updated_at before update on mailings
  for each row execute function set_updated_at();

alter table mailings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mailings' and policyname='allow_all') then
    create policy "allow_all" on mailings for all using (true) with check (true);
  end if;
end $$;

create table if not exists mailing_recipients (
  id                uuid primary key default uuid_generate_v4(),
  mailing_id        uuid not null references mailings(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,
  -- Snapshotted address fields (so CSV imports work + history survives contact edits)
  recipient_name    text,
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  zip               text,
  source            text check (source in ('database','csv_import','manual')) default 'database',
  -- Scan tracking
  scan_count        integer default 0,
  first_scanned_at  timestamptz,
  last_scanned_at   timestamptz,
  -- Response tracking
  responded         boolean default false,
  response_type     text check (response_type in ('lead_captured','called','emailed','interested','not_interested','converted')),
  responded_at      timestamptz,
  response_notes    text,
  created_at        timestamptz default now()
);

create index if not exists mailing_recipients_mailing_idx  on mailing_recipients(mailing_id);
create index if not exists mailing_recipients_contact_idx  on mailing_recipients(contact_id);
create index if not exists mailing_recipients_responded_idx on mailing_recipients(mailing_id, responded);

alter table mailing_recipients enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mailing_recipients' and policyname='allow_all') then
    create policy "allow_all" on mailing_recipients for all using (true) with check (true);
  end if;
end $$;

create table if not exists mailing_scans (
  id            uuid primary key default uuid_generate_v4(),
  mailing_id    uuid not null references mailings(id) on delete cascade,
  recipient_id  uuid references mailing_recipients(id) on delete set null,
  ip_hash       text,                          -- sha256(ip + daily-salt) — privacy-preserving uniqueness
  user_agent    text,
  referrer      text,
  country       text,                          -- inferred from Vercel headers (x-vercel-ip-country)
  region        text,                          -- state/region code (x-vercel-ip-country-region)
  city          text,                          -- city name, URL-decoded (x-vercel-ip-city)
  scanned_at    timestamptz default now()
);

create index if not exists mailing_scans_mailing_idx  on mailing_scans(mailing_id, scanned_at desc);
create index if not exists mailing_scans_recipient_idx on mailing_scans(recipient_id);

alter table mailing_scans enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mailing_scans' and policyname='allow_all') then
    create policy "allow_all" on mailing_scans for all using (true) with check (true);
  end if;
end $$;

create table if not exists mailing_leads (
  id                uuid primary key default uuid_generate_v4(),
  mailing_id        uuid references mailings(id) on delete set null,
  recipient_id      uuid references mailing_recipients(id) on delete set null,
  contact_id        uuid references contacts(id) on delete set null,
  name              text,
  email             text,
  phone             text,
  message           text,
  property_address  text,                      -- valuation requests only
  property_type     text,
  source_landing    text check (source_landing in ('property','valuation','custom','multifamily')),
  ip_hash           text,
  created_at        timestamptz default now()
);

create index if not exists mailing_leads_mailing_idx on mailing_leads(mailing_id);
create index if not exists mailing_leads_contact_idx on mailing_leads(contact_id);

alter table mailing_leads enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mailing_leads' and policyname='allow_all') then
    create policy "allow_all" on mailing_leads for all using (true) with check (true);
  end if;
end $$;

-- ─── Campaign Images Storage (run once in Supabase SQL Editor) ───────────────
-- Creates a public bucket for direct browser uploads from the landing page
-- builder. Agents upload photos; the public URL is stored in landing_config.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-images',
  'campaign-images',
  true,
  10485760,  -- 10 MB per file
  array['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
on conflict (id) do nothing;

-- Authenticated users (agents) can upload
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-images: authenticated upload'
  ) then
    create policy "campaign-images: authenticated upload"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'campaign-images');
  end if;
end $$;

-- Public can read (needed for landing pages served to anonymous visitors)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-images: public read'
  ) then
    create policy "campaign-images: public read"
      on storage.objects for select to public
      using (bucket_id = 'campaign-images');
  end if;
end $$;

-- Authenticated users can delete their own uploads
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-images: authenticated delete'
  ) then
    create policy "campaign-images: authenticated delete"
      on storage.objects for delete to authenticated
      using (bucket_id = 'campaign-images');
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- CONSOLIDATED TABLES (formerly defined ad-hoc in component SQL_SETUP strings)
--
-- These were previously created from "run this SQL" panels inside ColdCalls,
-- Sequences, Integrations, Settings, and Properties. They now live here as the
-- single source of truth. See migrations/0003_consolidate_ghost_tables.sql for
-- applying them to an existing database. All use `if not exists` and are safe
-- to re-run.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Cold calling ────────────────────────────────────────────────────────────
create table if not exists cold_call_lists (
  id         uuid primary key default uuid_generate_v4(),
  name       text not null,
  agent_id   uuid references agents(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists cold_call_leads (
  id               uuid primary key default uuid_generate_v4(),
  list_id          uuid references cold_call_lists(id) on delete cascade,
  property_address text, town text, state text,
  prop_type        text, unit_count int,
  owner_name       text, owner_address text,
  owner_city       text, owner_state text, owner_zip text,
  contact_name     text, age int,
  phones           jsonb default '[]',
  emails           jsonb default '[]',
  remarks          text,
  status           text default 'new',
  call_notes       text, called_at timestamptz, callback_date date,
  call_count       int default 0,
  contact_id       uuid references contacts(id) on delete set null,
  agent_id         uuid references agents(id) on delete set null,
  created_at       timestamptz default now()
);
create index if not exists idx_cold_leads_list   on cold_call_leads(list_id);
create index if not exists idx_cold_leads_status  on cold_call_leads(status);
create index if not exists idx_cold_leads_agent   on cold_call_leads(agent_id);
create index if not exists idx_cold_lists_agent   on cold_call_lists(agent_id);

-- ─── Drip sequences ──────────────────────────────────────────────────────────
create table if not exists sequences (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text default '',
  created_at  timestamptz default now()
);

create table if not exists sequence_steps (
  id          uuid primary key default uuid_generate_v4(),
  sequence_id uuid references sequences(id) on delete cascade not null,
  subject     text not null default '',
  body        text not null default '',
  delay_days  int default 0,
  sort_order  int default 0
);
create index if not exists idx_seq_steps_seq on sequence_steps(sequence_id, sort_order);

create table if not exists contact_sequences (
  id           uuid primary key default uuid_generate_v4(),
  contact_id   uuid references contacts(id) on delete cascade not null,
  sequence_id  uuid references sequences(id) on delete cascade not null,
  agent_id     uuid references agents(id) on delete set null,
  started_at   timestamptz default now(),
  current_step int default 0,
  status       text default 'active',
  created_at   timestamptz default now()
);
create index if not exists idx_contact_seq_contact on contact_sequences(contact_id);
create index if not exists idx_contact_seq_status   on contact_sequences(status);

-- ─── Twilio SMS ──────────────────────────────────────────────────────────────
alter table agents add column if not exists twilio_number text;
alter table agents add column if not exists twilio_sid    text;

create table if not exists conversations (
  id                uuid primary key default uuid_generate_v4(),
  contact_id        uuid references contacts(id) on delete set null,
  agent_id          uuid references agents(id)   on delete set null,
  twilio_number     text not null,
  contact_number    text not null,
  contact_name      text,
  last_message_body text,
  last_message_at   timestamptz default now(),
  unread_count      integer default 0,
  created_at        timestamptz default now(),
  unique (twilio_number, contact_number)
);
create index if not exists idx_conversations_agent on conversations(agent_id);

create table if not exists messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid references conversations(id) on delete cascade not null,
  direction       text check (direction in ('inbound','outbound')) not null,
  body            text not null,
  status          text default 'sent',
  twilio_sid      text,
  agent_id        uuid references agents(id) on delete set null,
  error_message   text,
  created_at      timestamptz default now()
);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at);

-- ─── Website tracking ────────────────────────────────────────────────────────
create table if not exists visitor_events (
  id               uuid primary key default uuid_generate_v4(),
  session_key      text not null,
  agent_id         uuid references agents(id) on delete set null,
  property_address text,
  property_url     text,
  created_at       timestamptz default now()
);
create index if not exists idx_visitor_events_session on visitor_events(session_key);

create table if not exists lead_captures (
  id                   uuid primary key default uuid_generate_v4(),
  session_key          text,
  agent_id             uuid references agents(id) on delete set null,
  first_name           text not null,
  last_name            text not null,
  email                text not null,
  phone                text,
  property_address     text,
  message              text,
  converted_contact_id uuid references contacts(id) on delete set null,
  created_at           timestamptz default now()
);
create index if not exists idx_lead_captures_agent on lead_captures(agent_id);

-- ─── Property add-ons ────────────────────────────────────────────────────────
create table if not exists property_showings (
  id               uuid primary key default uuid_generate_v4(),
  property_id      uuid references properties(id) on delete cascade,
  agent_id         uuid references agents(id) on delete set null,
  showing_date     timestamptz not null,
  buyer_agent_name text,
  feedback         text,
  rating           int check (rating between 1 and 5),
  created_at       timestamptz default now()
);
create index if not exists idx_showings_property on property_showings(property_id);

create table if not exists listing_checklist_steps (
  id           uuid primary key default uuid_generate_v4(),
  property_id  uuid references properties(id) on delete cascade,
  title        text not null,
  completed    boolean default false,
  completed_at timestamptz,
  sort_order   int default 0,
  created_at   timestamptz default now()
);
create index if not exists idx_listing_checklist_property on listing_checklist_steps(property_id, sort_order);

-- ─── Integrations & automation (reverse-engineered from usage) ───────────────
-- Columns inferred from how the app reads/writes these; verify vs the live DB.
create table if not exists integrations (
  id         uuid primary key default uuid_generate_v4(),
  type       text not null unique,
  config     jsonb default '{}',
  active     boolean default false,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists webhook_configs (
  id         uuid primary key default uuid_generate_v4(),
  name       text not null,
  url        text not null,
  events     text[] default '{}',
  active     boolean default false,
  created_at timestamptz default now()
);

create table if not exists email_log (
  id               uuid primary key default uuid_generate_v4(),
  enrollment_id    uuid references contact_sequences(id) on delete set null,
  sequence_id      uuid references sequences(id) on delete set null,
  sequence_step_id uuid references sequence_steps(id) on delete set null,
  contact_id       uuid references contacts(id) on delete set null,
  agent_id         uuid references agents(id) on delete set null,
  to_email         text,
  subject          text,
  status           text check (status in ('sent','failed')),
  provider_id      text,
  error            text,
  created_at       timestamptz default now()
);
create index if not exists idx_email_log_contact  on email_log(contact_id);
create index if not exists idx_email_log_sequence on email_log(sequence_id);

create table if not exists option_values (
  id         uuid primary key default uuid_generate_v4(),
  field_key  text not null,
  value      text not null,
  created_at timestamptz default now(),
  unique (field_key, value)
);
create index if not exists idx_option_values_field on option_values(field_key);

-- TODO: `option_value_counts` is queried as a VIEW by DataManagement.jsx but its
-- cross-table counting logic is field-specific and not knowable from the client
-- code. The app degrades to zeros when it is absent. Define it once the counting
-- rules are confirmed. (See migrations/0003_consolidate_ghost_tables.sql.)

-- ─── RLS for consolidated tables ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'cold_call_lists','cold_call_leads','sequences','sequence_steps',
    'contact_sequences','conversations','messages','property_showings',
    'listing_checklist_steps','integrations','webhook_configs','email_log',
    'option_values'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists allow_all on %I', t);
    execute format('create policy allow_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- visitor_events & lead_captures accept anonymous inserts (landing pages),
-- authenticated read only.
alter table visitor_events enable row level security;
drop policy if exists public_insert on visitor_events;
drop policy if exists auth_read     on visitor_events;
create policy public_insert on visitor_events for insert to anon, authenticated with check (true);
create policy auth_read     on visitor_events for select to authenticated using (true);

alter table lead_captures enable row level security;
drop policy if exists public_insert on lead_captures;
drop policy if exists auth_read     on lead_captures;
create policy public_insert on lead_captures for insert to anon, authenticated with check (true);
create policy auth_read     on lead_captures for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- FORM PACKETS (BoldTrail-style document library)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists form_packets (
  id               uuid primary key default uuid_generate_v4(),
  state            text not null,
  transaction_type text not null check (transaction_type in ('buyer','seller','lease','general')),
  name             text not null,
  description      text,
  storage_path     text,
  created_at       timestamptz default now()
);
alter table form_packets enable row level security;
drop policy if exists "form_packets_all" on form_packets;
create policy "form_packets_all" on form_packets
  for all to authenticated using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- DEADLINE REMINDERS (cron-sent, dedup log)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deadline_reminders (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid references deals(id) on delete cascade not null,
  date_type  text not null,   -- matches comp_data.key_dates[].type, e.g. 'Closing'
  threshold  text not null,   -- '72h' | '24h' | 'today'
  sent_at    timestamptz default now(),
  unique (deal_id, date_type, threshold)
);
alter table deadline_reminders enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ═════════════════════════════════════════════════════════════════════════════
-- SCOPED RLS POLICIES  (single source of truth for data visibility)
--
-- Visibility model (decided 2026-06; see migrations/0011):
--   • An agent sees their OWN records, records of TEAM PEERS who share that
--     dimension (team_splits.share_*), and deals they are CO-LISTED on
--     (a participant row in commissions.participants pays them on the deal).
--   • Admins (agents.is_admin — the office admin / transaction coordinator)
--     see everything firm-wide. Tasks stay personal even for admins.
--   • /api/* serverless functions use the service key and bypass RLS.
--
-- Defined last because the helpers reference team_splits and commissions.
-- Fresh installs get these as the ONLY policies on the scoped tables (secure
-- by default). On an existing database the legacy allow_all policies OR-combine
-- with these until migration 0011 Phase B drops them.
-- ═════════════════════════════════════════════════════════════════════════════

-- The agent row for the currently authenticated user.
create or replace function app_current_agent_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select id from agents where auth_id = auth.uid() limit 1;
$$;

-- Office admin / transaction coordinator: explicit flag, with the legacy
-- role-string fallback for agents created before the column existed.
create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(is_admin or role ilike '%admin%'), false)
  from agents where auth_id = auth.uid();
$$;

-- The set of agent_ids whose data the current user may see for a given
-- dimension: self + team peers who share that dimension. A null share flag is
-- treated as "shared" to match the app's default.
create or replace function app_visible_agent_ids(dimension text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select app_current_agent_id()
  union
  select peer.agent_id
  from team_splits me
  join team_splits peer
    on peer.team_id = me.team_id
   and peer.agent_id <> me.agent_id
  where me.agent_id = app_current_agent_id()
    and case dimension
          when 'contacts'   then peer.share_contacts
          when 'properties' then peer.share_properties
          when 'deals'      then peer.share_deals
          else false
        end is not false;
$$;

-- Every deal the current user may see: all (admin), own + team-shared, or
-- co-listed (they appear as a participant on the deal's commission).
create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from deals d where app_is_admin()
  union
  select d.id from deals d
  where d.agent_id in (select app_visible_agent_ids('deals'))
  union
  select c.deal_id
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
  where (p->>'agent_id') is not null
    and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and (p->>'agent_id')::uuid = app_current_agent_id();
$$;

grant execute on function app_current_agent_id()      to authenticated;
grant execute on function app_is_admin()              to authenticated;
grant execute on function app_visible_agent_ids(text) to authenticated;
grant execute on function app_visible_deal_ids()      to authenticated;

-- CONTACTS — own + sharing team peers; admins see all.
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using      (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('contacts')))
  with check (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('contacts')));

-- ACTIVITIES — visible through the parent contact OR the parent deal; the
-- author always sees their own entries; admins see all.
drop policy if exists activities_contact_scope on activities;
drop policy if exists activities_scope on activities;
create policy activities_scope on activities for all to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = activities.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or activities.deal_id in (select app_visible_deal_ids())
  )
  with check (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = activities.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or activities.deal_id in (select app_visible_deal_ids())
  );

-- TASKS — strictly personal, even for admins (a to-do list isn't oversight data).
drop policy if exists tasks_agent_scope on tasks;
create policy tasks_agent_scope on tasks for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());

-- DEALS — own + team-shared + co-listed; admins see all. The with check arm
-- lets an agent create deals owned by themselves / a sharing peer, and lets a
-- co-listed participant edit a deal they can already see.
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );

-- COMMISSIONS — back office: ADMIN-ONLY (decided 2026-06-12). Each agent's
-- split/take-home is private even from co-agents on the same deal; agents get
-- their own slice via /api/my-earnings (service key, bypasses RLS).
drop policy if exists commissions_deal_scope on commissions;
drop policy if exists commissions_admin_only on commissions;
create policy commissions_admin_only on commissions for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- DOCUMENTS — follow the deal; unattached uploads stay personal.
drop policy if exists documents_deal_scope on documents;
create policy documents_deal_scope on documents for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or (deal_id is null and agent_id = app_current_agent_id())
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or (deal_id is null and agent_id = app_current_agent_id())
  );

-- DOCUSIGN ENVELOPES — follow the deal; sender always sees their own.
drop policy if exists docusign_envelopes_deal_scope on docusign_envelopes;
create policy docusign_envelopes_deal_scope on docusign_envelopes for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  );

-- TRANSACTION STEPS — follow the deal.
drop policy if exists transaction_steps_deal_scope on transaction_steps;
create policy transaction_steps_deal_scope on transaction_steps for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- DEADLINE REMINDERS — follow the deal (written by cron via service key).
drop policy if exists deadline_reminders_deal_scope on deadline_reminders;
create policy deadline_reminders_deal_scope on deadline_reminders for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- AGENT NOTIFICATIONS — strictly personal (written by APIs via service key).
drop policy if exists agent_notifications_own on agent_notifications;
create policy agent_notifications_own on agent_notifications for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());
