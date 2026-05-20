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
-- MAIL CAMPAIGNS  (outreach campaigns — mail flyers, cold call, email blasts)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists mail_campaigns (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  description         text,
  property_types      text[] default '{}',   -- target property types (multifamily, office…)
  status              text check (status in ('draft','active','paused','completed')) default 'draft',
  agent_id            uuid references agents(id) on delete set null,
  property_id         uuid references properties(id) on delete set null, -- linked property for QR/landing page
  flyer_url           text,                  -- link to flyer asset (Canva, PDF URL, etc.)
  flyer_photo_caption text,                  -- caption shown under the hero photo on the flyer
  tracking_url        text,                  -- Bitly short URL for QR tracking
  qr_code_url         text,                  -- Bitly QR code image URL
  bitly_id            text,                  -- Bitly link ID for analytics
  qr_target           text check (qr_target in ('crm_landing','custom_url')) default 'crm_landing',
  frequency_cap       integer default 0,     -- 0 = no cap; >0 = max sends per contact
  frequency_days      integer default 30,    -- rolling window for frequency cap
  total_sends         integer default 0,     -- denormalised counter (updated by trigger/app)
  total_responses     integer default 0,
  created_at          timestamptz default now()
);

-- Migration: add new columns if they don't exist yet
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name='mail_campaigns' and column_name='flyer_photo_caption') then
    alter table mail_campaigns add column flyer_photo_caption text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='mail_campaigns' and column_name='property_id') then
    alter table mail_campaigns add column property_id uuid references properties(id) on delete set null;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='mail_campaigns' and column_name='qr_target') then
    alter table mail_campaigns add column qr_target text default 'crm_landing';
  end if;
end $$;

alter table mail_campaigns enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mail_campaigns' and policyname='allow_all') then
    create policy "allow_all" on mail_campaigns for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- MAIL SENDS  (every individual send / contact event — mail, call, or email)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists mail_sends (
  id                uuid primary key default uuid_generate_v4(),
  campaign_id       uuid references mail_campaigns(id) on delete cascade,
  -- Recipient link (at least one must be set, or use raw fields below)
  contact_id        uuid references contacts(id) on delete set null,
  cold_lead_id      uuid references cold_call_leads(id) on delete set null,
  -- Raw recipient details (used when no contact record exists yet)
  recipient_name    text,
  recipient_address text,
  recipient_city    text,
  recipient_state   text,
  recipient_zip     text,
  -- Event metadata
  channel           text check (channel in ('mail','cold-call','email')) default 'mail',
  sent_at           timestamptz default now(),
  agent_id          uuid references agents(id) on delete set null,
  -- Response tracking
  response          text check (response in ('no-response','callback','interested','dnc','converted')) default 'no-response',
  responded_at      timestamptz,
  deal_id           uuid references deals(id) on delete set null,  -- deal attributed to this send
  notes             text,
  created_at        timestamptz default now()
);

create index if not exists mail_sends_campaign_id_idx on mail_sends(campaign_id);
create index if not exists mail_sends_contact_id_idx  on mail_sends(contact_id);
create index if not exists mail_sends_cold_lead_idx   on mail_sends(cold_lead_id);

alter table mail_sends enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mail_sends' and policyname='allow_all') then
    create policy "allow_all" on mail_sends for all using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- MAIL SUPPRESSIONS  (global DNC / opt-out list across all campaigns)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists mail_suppressions (
  id         uuid primary key default uuid_generate_v4(),
  address    text,
  email      text,
  phone      text,
  full_name  text,
  reason     text check (reason in ('dnc','opted-out','deceased','returned-mail','other')) default 'dnc',
  contact_id uuid references contacts(id) on delete set null,
  agent_id   uuid references agents(id) on delete set null,
  notes      text,
  created_at timestamptz default now()
);

alter table mail_suppressions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mail_suppressions' and policyname='allow_all') then
    create policy "allow_all" on mail_suppressions for all using (true) with check (true);
  end if;
end $$;

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

-- activities — contact timeline queries
create index if not exists idx_activities_contact on activities(contact_id, created_at desc);
create index if not exists idx_activities_agent   on activities(agent_id);

-- commissions
create index if not exists idx_commissions_agent   on commissions(agent_id);
create index if not exists idx_commissions_deal    on commissions(deal_id);
create index if not exists idx_commissions_paid    on commissions(paid, paid_at desc);

-- agent_notifications — real-time inbox queries
create index if not exists idx_notif_agent_unread on agent_notifications(agent_id, read) where read = false;
create index if not exists idx_notif_created      on agent_notifications(created_at desc);

-- mail_sends — campaign reporting (already has some indexes, adding agent lookup)
create index if not exists idx_mail_sends_agent    on mail_sends(agent_id);
create index if not exists idx_mail_sends_sent_at  on mail_sends(sent_at desc);
create index if not exists idx_mail_sends_response on mail_sends(response) where response != 'no-response';

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
  coalesce(sum(comm.net) filter (where comm.paid = true), 0) as total_commission_paid,
  count(distinct t.id) filter (where t.completed = false and t.due_date < now()) as overdue_tasks
from agents a
left join contacts    c    on c.assigned_agent_id = a.id
left join properties  p    on p.assigned_agent_id = a.id
left join deals       d    on d.agent_id = a.id
left join commissions comm on comm.agent_id = a.id
left join tasks       t    on t.agent_id = a.id
group by a.id;

-- Grant read access to authenticated users
grant select on agent_dashboard_stats to authenticated;
grant execute on function search_contacts(text, uuid[], int) to authenticated;
grant execute on function search_properties(text, uuid[], int) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- MAILINGS (v2) — clean rebuild of campaigns/sends with QR-first tracking.
--
-- Deprecation path:
--   • old mail_campaigns / mail_sends / mail_suppressions kept for now
--   • once frontend fully migrates, drop them in a follow-up migration
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
  country       text,                          -- inferred from Vercel headers
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
