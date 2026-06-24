-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 — Lead routing observability log
--
-- Every assignment decision gets one row: which agent was picked, by what
-- method (explicit-pin / round-robin / unassigned), and what specialty pool
-- was searched. Admins can then audit distribution at a glance and spot the
-- failure modes (specialty mismatch, dead admin pool, signature rejections).
--
-- Safe to run on populated DBs:
--   • Table is new — IF NOT EXISTS guard
--   • RLS allows the service-role (server) to insert, admins to read
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists lead_routing_log (
  id              uuid primary key default uuid_generate_v4(),
  lead_email      text,
  property_type   text,
  contact_type    text,
  source_url      text,
  method          text not null,                -- 'pinned' | 'round_robin' | 'unassigned'
  assigned_agent  uuid references agents(id) on delete set null,
  pool_size       integer,                      -- candidate count at decision time
  sig_rejected    boolean default false,        -- agent_id was sent but signature failed
  notes           text,
  contact_id      uuid references contacts(id) on delete set null,
  created_at      timestamptz default now()
);

create index if not exists idx_lead_routing_log_created  on lead_routing_log(created_at desc);
create index if not exists idx_lead_routing_log_agent    on lead_routing_log(assigned_agent, created_at desc);
create index if not exists idx_lead_routing_log_method   on lead_routing_log(method, created_at desc);

alter table lead_routing_log enable row level security;

-- Service role inserts (the lead-intake endpoint runs with the service key);
-- admins read for the audit screen.
drop policy if exists lead_routing_log_admin_read on lead_routing_log;
create policy lead_routing_log_admin_read on lead_routing_log
  for select to authenticated
  using (app_is_admin());

-- No insert/update/delete policy for authenticated users — only the service
-- key writes here, which bypasses RLS automatically.
