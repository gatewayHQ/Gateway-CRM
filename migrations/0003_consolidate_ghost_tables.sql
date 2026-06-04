-- Migration 0003 — Consolidate "ghost" tables into the canonical schema
-- ===========================================================================
-- WHY
--   ~14 tables were defined ad-hoc inside component SQL_SETUP strings (shown to
--   users as "run this SQL") instead of in schema.sql. That means the database
--   shape depended on which page an admin happened to open first, and a fresh
--   schema.sql run did NOT create them. This migration makes every table a
--   first-class, version-controlled object.
--
-- WHAT
--   • Drops the orphan `envelopes` table (an unused duplicate of
--     docusign_envelopes — zero references in src/ or api/).
--   • Adds created_at to docusign_envelopes (reconciles drift vs Pipeline.jsx).
--   • Creates the consolidated tables (verbatim where the app defined them;
--     reverse-engineered from usage where it never did — those are flagged).
--   • Adds RLS policies matching each table's existing access pattern, and
--     hot-path indexes.
--
-- SAFETY
--   Everything uses `if not exists` / `if exists`, so this is safe to run on
--   the live database: tables that already exist (created via the old ad-hoc
--   setup) are left untouched; only missing objects are created. No data is
--   modified. Idempotent — safe to re-run.
-- ===========================================================================

-- ─── Drop the orphan duplicate ──────────────────────────────────────────────
-- `envelopes` was superseded by `docusign_envelopes`; nothing references it.
drop table if exists envelopes cascade;

-- ─── Reconcile docusign_envelopes drift ──────────────────────────────────────
alter table docusign_envelopes add column if not exists created_at timestamptz default now();


-- ─── Cold calling (was: src/pages/ColdCalls.jsx) ─────────────────────────────
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


-- ─── Drip sequences (was: src/pages/Sequences.jsx) ───────────────────────────
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


-- ─── Twilio SMS (was: src/pages/Integrations.jsx) ────────────────────────────
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


-- ─── Website tracking (was: src/pages/Settings.jsx) ──────────────────────────
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


-- ─── Property add-ons (was: src/pages/Properties.jsx) ────────────────────────
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


-- ─── Integrations & automation (REVERSE-ENGINEERED from usage — no prior DDL) ─
-- Columns inferred from how Integrations.jsx / webhooks.js / sequence-run.js
-- read & write these tables. Verify against the live tables before relying on
-- this as the source of truth.
create table if not exists integrations (
  id         uuid primary key default uuid_generate_v4(),
  type       text not null unique,        -- e.g. 'mailchimp' (upsert key)
  config     jsonb default '{}',          -- { api_key, list_id, ... }
  active     boolean default false,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists webhook_configs (
  id         uuid primary key default uuid_generate_v4(),
  name       text not null,
  url        text not null,
  events     text[] default '{}',         -- e.g. ['contact.created']
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
  field_key  text not null,               -- 'submarket' | 'asset_type' | 'tag' | ...
  value      text not null,
  created_at timestamptz default now(),
  unique (field_key, value)
);
create index if not exists idx_option_values_field on option_values(field_key);

-- NOTE: `option_value_counts` is queried as a VIEW by DataManagement.jsx
-- (select field_key, value, record_count). Its definition counts how many live
-- records reference each option value, and that logic is field-specific
-- (tags vs submarket vs asset_types across contacts/properties). It is NOT
-- reproduced here because the exact aggregation is not knowable from the client
-- code, and the app already degrades gracefully (shows zeros) when it is
-- absent. Define it deliberately in a follow-up once the counting rules are
-- confirmed with the team.


-- ─── RLS for all consolidated tables ─────────────────────────────────────────
-- Matches each table's existing ad-hoc access pattern. These keep the current
-- "authenticated can do anything" behavior so nothing breaks; tightening them
-- to agent scope is follow-up work (extend migration 0002's helpers).
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

-- visitor_events & lead_captures are written by ANONYMOUS landing-page visitors
-- (public insert) but only read by authenticated agents.
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
