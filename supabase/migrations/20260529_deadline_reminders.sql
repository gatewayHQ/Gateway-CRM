-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Deadline reminders — tracks which date/threshold combos were sent
-- Run in Supabase SQL Editor
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
create policy "deadline_reminders_all" on deadline_reminders
  for all to authenticated using (true) with check (true);

create index if not exists idx_deadline_reminders_deal on deadline_reminders(deal_id);
