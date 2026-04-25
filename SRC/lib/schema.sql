-- Gateway CRM Database Schema
-- Paste this entire file into Supabase SQL Editor and click Run

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Agents (team members)
create table agents (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  initials text not null,
  role text not null,
  email text unique not null,
  color text default '#2d3561',
  created_at timestamptz default now()
);

-- Contacts
create table contacts (
  id uuid primary key default uuid_generate_v4(),
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  type text check (type in ('buyer','seller','landlord','tenant','investor')) default 'buyer',
  status text check (status in ('active','cold','closed')) default 'active',
  source text check (source in ('referral','website','open house','social','other')) default 'other',
  assigned_agent_id uuid references agents(id),
  notes text,
  tags text[],
  last_contacted_at timestamptz,
  created_at timestamptz default now()
);

-- Properties
create table properties (
  id uuid primary key default uuid_generate_v4(),
  address text not null,
  city text,
  state text,
  zip text,
  type text check (type in ('residential','commercial','rental','land')) default 'residential',
  status text check (status in ('active','pending','sold','off-market')) default 'active',
  list_price numeric,
  sqft numeric,
  beds integer,
  baths numeric,
  mls_number text,
  linked_contact_id uuid references contacts(id),
  assigned_agent_id uuid references agents(id),
  notes text,
  created_at timestamptz default now()
);

-- Deals (Pipeline)
create table deals (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  contact_id uuid references contacts(id),
  property_id uuid references properties(id),
  agent_id uuid references agents(id),
  stage text check (stage in ('lead','qualified','showing','offer','under-contract','closed','lost')) default 'lead',
  value numeric,
  probability integer default 0,
  expected_close_date date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Tasks
create table tasks (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  type text check (type in ('call','email','showing','follow-up','document','other')) default 'other',
  priority text check (priority in ('high','medium','low')) default 'medium',
  due_date timestamptz,
  completed boolean default false,
  contact_id uuid references contacts(id),
  deal_id uuid references deals(id),
  agent_id uuid references agents(id),
  notes text,
  created_at timestamptz default now()
);

-- Email Templates
create table templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  subject text not null,
  body text not null,
  category text check (category in ('intro','follow-up','offer','closing','nurture')) default 'follow-up',
  agent_id uuid references agents(id),
  usage_count integer default 0,
  created_at timestamptz default now()
);

-- Insert default agents
insert into agents (name, initials, role, email, color) values
  ('Your Name', 'YN', 'Lead Agent', 'you@gateway.com', '#2d3561'),
  ('Team Member', 'TM', 'Agent', 'team@gateway.com', '#4a6fa5');

-- Enable Row Level Security (RLS) - open access for now
alter table agents enable row level security;
alter table contacts enable row level security;
alter table properties enable row level security;
alter table deals enable row level security;
alter table tasks enable row level security;
alter table templates enable row level security;

-- Allow all operations for anon key (you can restrict later with auth)
create policy "Allow all for anon" on agents for all using (true) with check (true);
create policy "Allow all for anon" on contacts for all using (true) with check (true);
create policy "Allow all for anon" on properties for all using (true) with check (true);
create policy "Allow all for anon" on deals for all using (true) with check (true);
create policy "Allow all for anon" on tasks for all using (true) with check (true);
create policy "Allow all for anon" on templates for all using (true) with check (true);
