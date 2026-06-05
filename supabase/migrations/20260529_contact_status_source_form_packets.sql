-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Expand contacts status/source constraints + add form_packets table
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Expand contact status to include lead, opportunity, pending
alter table contacts drop constraint if exists contacts_status_check;
alter table contacts add constraint contacts_status_check
  check (status in ('active','cold','closed','lead','opportunity','pending'));

-- 2. Expand contact source to include team and paid service
alter table contacts drop constraint if exists contacts_source_check;
alter table contacts add constraint contacts_source_check
  check (source in ('referral','website','open house','social','cold call','team','paid service','other'));

-- 3. Form packets table (BoldTrail-style document library)
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
create policy "form_packets_all" on form_packets
  for all to authenticated using (true) with check (true);

-- Create storage bucket for form packets (run separately in Supabase Dashboard
-- Storage → New bucket → name: form-packets, public: false)
