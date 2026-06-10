-- Exact replica of Daniel's production DB shape, built from the 2026-06-10 diagnostic
create extension if not exists "uuid-ossp";
create table agents (
  id uuid primary key default uuid_generate_v4(), name text, initials text, role text,
  email text unique, color text, created_at timestamptz default now(), team_id uuid,
  auth_id uuid unique, default_commission_pct numeric, default_listing_side_pct numeric,
  default_buyer_side_pct numeric, specialty text, nav_hidden text[], default_split_pct numeric,
  no_brokerage_split boolean, is_admin boolean, phone text, photo_url text, bio text,
  tagline text, stats jsonb
);
create table contacts (
  id uuid primary key default uuid_generate_v4(), first_name text, last_name text, email text,
  phone text, type text, status text, source text,
  assigned_agent_id uuid references agents(id), notes text, tags text[],
  last_contacted_at timestamptz, created_at timestamptz default now(),
  owner_address text, owner_city text, owner_state text, owner_zip text,
  birthday date, anniversary_date date, submarket text, asset_types text[],
  size_min numeric, size_max numeric, size_unit text, job_title text, mobile_phone text,
  phone_ext text, company text, is_prospect boolean, prospect_type text, types text[],
  beds_min int, beds_max int, baths_min numeric, baths_max numeric, garage_min int,
  deleted_at timestamptz, submarkets text[], spouse_name text, spouse_phone text, spouse_notes text
);
create table properties (
  id uuid primary key default uuid_generate_v4(), address text, city text, state text, zip text,
  type text, status text, list_price numeric, sqft numeric, beds int, baths numeric,
  mls_number text, linked_contact_id uuid references contacts(id),
  assigned_agent_id uuid references agents(id), notes text, created_at timestamptz default now(),
  garage int, details jsonb, lat numeric, lng numeric, county text, submarket text,
  price_history jsonb, listing_expiry_date date, comps jsonb
);
create table deals (
  id uuid primary key default uuid_generate_v4(), title text, contact_id uuid references contacts(id),
  property_id uuid references properties(id), agent_id uuid references agents(id),
  stage text, value numeric, probability int, expected_close_date date, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  comp_data jsonb, prop_category text, prop_address text, prop_price numeric, prop_type text,
  prop_subtype text, prop_city text, prop_state text, prop_zip text, prop_status text,
  prop_list_price numeric, prop_sqft numeric, prop_beds int, prop_baths numeric,
  prop_mls_number text, prop_notes text, is_1031 boolean, deal_state text, sold_price numeric,
  commission_pct numeric, listing_side_pct numeric, buyer_side_pct numeric, referral_fee numeric,
  agent_side text, co_agent_ids uuid[], portal_token uuid, portal_enabled boolean
);
create table tasks (
  id uuid primary key default uuid_generate_v4(), title text, type text, priority text,
  due_date timestamptz, completed boolean, contact_id uuid references contacts(id),
  deal_id uuid references deals(id), agent_id uuid references agents(id),
  notes text, created_at timestamptz default now()
);
create table activities (
  id uuid primary key default uuid_generate_v4(), contact_id uuid references contacts(id),
  agent_id uuid references agents(id), type text, body text, notes text,
  created_at timestamptz default now()
);
create table teams (
  id uuid primary key default uuid_generate_v4(), name text, created_at timestamptz default now(),
  type text, description text
);
create table team_splits (
  id uuid primary key default uuid_generate_v4(), team_id uuid references teams(id),
  agent_id uuid references agents(id), split_pct numeric, is_lead boolean,
  created_at timestamptz default now(), share_contacts boolean, share_properties boolean,
  share_deals boolean
);
create table commissions (
  id uuid primary key default uuid_generate_v4(), deal_id uuid references deals(id) unique,
  gross_pct numeric, broker_pct numeric, agent_pct numeric, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  referral_pct numeric, co_agent_pct numeric, transaction_fee numeric,
  co_agent_id uuid, sides jsonb, participants jsonb
);
create table docusign_envelopes (
  id uuid primary key default uuid_generate_v4(), deal_id uuid references deals(id),
  envelope_id text, signer_name text, signer_email text, document_name text,
  subject text, status text, sent_at timestamptz, completed_at timestamptz,
  created_at timestamptz default now()
);
create table transaction_steps (
  id uuid primary key default uuid_generate_v4(), deal_id uuid references deals(id),
  title text, completed boolean, completed_at timestamptz, sort_order int,
  created_at timestamptz default now(), category text, due_date date, step_note text,
  doc_action text, doc_status text, if_applicable boolean
);
create table deadline_reminders (
  id uuid primary key default uuid_generate_v4(), deal_id uuid references deals(id),
  date_type text, threshold text, sent_at timestamptz default now()
);
create table agent_notifications (
  id uuid primary key default uuid_generate_v4(), agent_id uuid references agents(id),
  deal_id uuid references deals(id), envelope_id text, title text, message text,
  type text, read boolean, created_at timestamptz default now()
);
create table templates (id uuid primary key default uuid_generate_v4(), name text, subject text, body text);
create table integrations (id uuid primary key default uuid_generate_v4(), type text, config jsonb, active boolean);
create table webhook_configs (id uuid primary key default uuid_generate_v4(), name text, url text, events text[], active boolean);
create table deal_contacts (id uuid primary key default uuid_generate_v4(), deal_id uuid, contact_id uuid, role text);
create table mail_campaigns (id uuid primary key default uuid_generate_v4());
create table mail_sends (id uuid primary key default uuid_generate_v4());
create table mail_suppressions (id uuid primary key default uuid_generate_v4());

-- RLS ON everywhere + the exact policy names from the diagnostic (permissive quals)
do $$
declare t text;
begin
  foreach t in array array['agents','contacts','properties','deals','tasks','activities','teams',
    'team_splits','commissions','docusign_envelopes','transaction_steps','deadline_reminders',
    'agent_notifications','templates','integrations','webhook_configs','deal_contacts',
    'mail_campaigns','mail_sends','mail_suppressions'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
do $$
declare t text; p text;
begin
  foreach t in array array['contacts','deals','tasks','activities','templates','agents'] loop
    execute format('create policy agent_select on %I for select to authenticated using (true)', t);
    execute format('create policy agent_insert on %I for insert to authenticated with check (true)', t);
    execute format('create policy agent_update on %I for update to authenticated using (true) with check (true)', t);
    execute format('create policy agent_delete on %I for delete to authenticated using (true)', t);
  end loop;
end $$;
-- agents: diagnostic shows agents_select/insert/update/delete; close enough behaviorally (above)
create policy agent_notifications_policy on agent_notifications for all to authenticated using (true) with check (true);
create policy allow_all on agent_notifications for all using (true) with check (true);
create policy agent_insert on commissions for insert to authenticated with check (true);
create policy agent_select on commissions for select to authenticated using (true);
create policy agent_update on commissions for update to authenticated using (true) with check (true);
create policy agents_envelopes on docusign_envelopes for all to authenticated using (true) with check (true);
create policy allow_all on docusign_envelopes for all using (true) with check (true);
create policy deadline_reminders_all on deadline_reminders for all to authenticated using (true) with check (true);
create policy allow_all on transaction_steps for all using (true) with check (true);
create policy auth_all_steps on transaction_steps for all to authenticated using (true) with check (true);
create policy allow_all on teams for all using (true) with check (true);
create policy auth_all on teams for all to authenticated using (true) with check (true);
create policy allow_all on team_splits for all using (true) with check (true);
create policy "Allow all" on properties for all using (true) with check (true);
create policy allow_all on properties for all using (true) with check (true);
create policy prop_select on properties for select using (true);
create policy prop_insert on properties for insert with check (true);
create policy prop_update on properties for update using (true) with check (true);
create policy prop_delete on properties for delete using (true);
create policy "Allow all for anon" on integrations for all using (true) with check (true);
create policy "Allow all for anon" on webhook_configs for all using (true) with check (true);
create policy allow_all on deal_contacts for all using (true) with check (true);
create policy allow_all on mail_campaigns for all using (true) with check (true);
create policy allow_all on mail_sends for all using (true) with check (true);
create policy allow_all on mail_suppressions for all using (true) with check (true);
grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, anon;
