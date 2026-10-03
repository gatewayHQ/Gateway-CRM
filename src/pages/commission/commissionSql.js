// The setup SQL shown when the commissions table is missing.

export const COMMISSION_SQL = `create table if not exists commissions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete cascade unique not null,
  gross_pct numeric not null default 3.0,
  broker_pct numeric not null default 30.0,
  agent_pct numeric not null default 70.0,
  referral_pct numeric not null default 0,
  co_agent_pct numeric not null default 0,
  transaction_fee numeric not null default 0,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table commissions enable row level security;
create policy "Auth all" on commissions for all using (auth.role() = 'authenticated');`
