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
  status            text check (status in ('active','cold','closed')) default 'active',
  source            text check (source in ('referral','website','open house','social','cold call','other')) default 'other',
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
  -- Extended contact info
  job_title         text,
  mobile_phone      text,
  phone_ext         text,
  company           text,
  -- Prospect tracking
  is_prospect       boolean default false,
  prospect_type     text,          -- e.g. 'Seller', 'Buyer', 'Cold Call'
  -- Buyer / investor search criteria (for matching)
  submarket         text,          -- legacy single-value field (kept for import compat)
  submarkets        text[],        -- multi-select county / market list
  asset_types       text[],        -- e.g. ['multifamily','office']
  buyer_criteria    jsonb default '{}',  -- per-asset-type criteria: {residential:{beds_min,beds_max,...}, ...}
  size_min          numeric,       -- legacy (kept for existing data)
  size_max          numeric,
  size_unit         text default 'sqft',
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
                      'active','pending','sold','off-market','leased'
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
  stage               text check (stage in (
                        'lead','qualified','showing','offer',
                        'under-contract','closed','lost'
                      )) default 'lead',
  value               numeric,
  probability         integer default 0,
  expected_close_date date,
  notes               text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

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
-- ACTIVITIES  (contact timeline — calls, notes, emails, meetings, showings)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists activities (
  id         uuid primary key default uuid_generate_v4(),
  contact_id uuid references contacts(id) on delete cascade,
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
-- ENVELOPES  (DocuSign signature tracking)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists envelopes (
  id          uuid primary key default uuid_generate_v4(),
  deal_id     uuid references deals(id) on delete cascade,
  document_id uuid references documents(id) on delete set null,
  agent_id    uuid references agents(id) on delete set null,
  envelope_id text not null,       -- DocuSign envelope ID
  status      text default 'sent', -- sent | delivered | completed | declined | voided
  subject     text,
  signers     jsonb default '[]',  -- [{name, email, routingOrder, status}]
  sent_at     timestamptz default now(),
  completed_at timestamptz
);

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists commissions (
  id          uuid primary key default uuid_generate_v4(),
  deal_id     uuid references deals(id) on delete cascade,
  agent_id    uuid references agents(id) on delete set null,
  gross       numeric,
  split_pct   numeric default 100,
  net         numeric,
  paid        boolean default false,
  paid_at     timestamptz,
  notes       text,
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────
alter table agents      enable row level security;
alter table contacts    enable row level security;
alter table properties  enable row level security;
alter table deals       enable row level security;
alter table tasks       enable row level security;
alter table templates   enable row level security;
alter table activities  enable row level security;
alter table documents   enable row level security;
alter table envelopes   enable row level security;
alter table commissions enable row level security;

-- Open access for all authenticated users (restrict per-agent later if needed)
do $$ begin
  -- agents
  if not exists (select 1 from pg_policies where tablename='agents' and policyname='allow_all') then
    create policy "allow_all" on agents for all using (true) with check (true);
  end if;
  -- contacts
  if not exists (select 1 from pg_policies where tablename='contacts' and policyname='allow_all') then
    create policy "allow_all" on contacts for all using (true) with check (true);
  end if;
  -- properties
  if not exists (select 1 from pg_policies where tablename='properties' and policyname='allow_all') then
    create policy "allow_all" on properties for all using (true) with check (true);
  end if;
  -- deals
  if not exists (select 1 from pg_policies where tablename='deals' and policyname='allow_all') then
    create policy "allow_all" on deals for all using (true) with check (true);
  end if;
  -- tasks
  if not exists (select 1 from pg_policies where tablename='tasks' and policyname='allow_all') then
    create policy "allow_all" on tasks for all using (true) with check (true);
  end if;
  -- templates
  if not exists (select 1 from pg_policies where tablename='templates' and policyname='allow_all') then
    create policy "allow_all" on templates for all using (true) with check (true);
  end if;
  -- activities
  if not exists (select 1 from pg_policies where tablename='activities' and policyname='allow_all') then
    create policy "allow_all" on activities for all using (true) with check (true);
  end if;
  -- documents
  if not exists (select 1 from pg_policies where tablename='documents' and policyname='allow_all') then
    create policy "allow_all" on documents for all using (true) with check (true);
  end if;
  -- envelopes
  if not exists (select 1 from pg_policies where tablename='envelopes' and policyname='allow_all') then
    create policy "allow_all" on envelopes for all using (true) with check (true);
  end if;
  -- commissions
  if not exists (select 1 from pg_policies where tablename='commissions' and policyname='allow_all') then
    create policy "allow_all" on commissions for all using (true) with check (true);
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
do $$ begin
  if not exists (select 1 from pg_policies where tablename='agent_notifications' and policyname='allow_all') then
    create policy "allow_all" on agent_notifications for all using (true) with check (true);
  end if;
end $$;

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
  completed_at  timestamptz
);

alter table docusign_envelopes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='docusign_envelopes' and policyname='allow_all') then
    create policy "allow_all" on docusign_envelopes for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRANSACTION STEPS  (closing checklists per deal)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists transaction_steps (
  id           uuid primary key default uuid_generate_v4(),
  deal_id      uuid references deals(id) on delete cascade,
  title        text not null,
  completed    boolean default false,
  completed_at timestamptz,
  sort_order   integer default 0,
  created_at   timestamptz default now()
);

alter table transaction_steps enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='transaction_steps' and policyname='allow_all') then
    create policy "allow_all" on transaction_steps for all using (true) with check (true);
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
-- alter table contacts add column if not exists submarket      text;
-- alter table contacts add column if not exists asset_types    text[];
-- alter table contacts add column if not exists size_min       numeric;
-- alter table contacts add column if not exists size_max       numeric;
-- alter table contacts add column if not exists size_unit      text default 'sqft';
-- alter table contacts add column if not exists job_title      text;
-- alter table contacts add column if not exists mobile_phone   text;
-- alter table contacts add column if not exists phone_ext      text;
-- alter table contacts add column if not exists company        text;
-- alter table contacts add column if not exists is_prospect    boolean default false;
-- alter table contacts add column if not exists prospect_type  text;
-- alter table contacts add column if not exists submarkets     text[];
-- alter table contacts add column if not exists buyer_criteria jsonb default '{}';
