-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — Webhook delivery log + drip-cron column fix
--
-- Two changes:
--   1. contact_sequences.last_sent_at — fixes the drip cron, which has been
--      trying to write this column and silently failing every send past
--      step 0. The column is documented in src/lib/schema.sql; this just
--      adds it to live databases.
--   2. webhook_deliveries — every outbound webhook POST records its result
--      so admins can debug failed subscribers from the UI instead of
--      console-spelunking on the server.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drip cron column (see migration 0016/0017 notes; this is the one we
--    missed at the time).
alter table contact_sequences
  add column if not exists last_sent_at timestamptz;

-- 2. Webhook deliveries — one row per outbound POST attempt.
create table if not exists webhook_deliveries (
  id              uuid primary key default uuid_generate_v4(),
  webhook_id      uuid references webhook_configs(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  status_code     integer,                  -- HTTP status from the subscriber (null on transport error)
  ok              boolean default false,
  error           text,                     -- network error message; subscriber 5xx body if available
  duration_ms     integer,
  created_at      timestamptz default now()
);

create index if not exists idx_webhook_deliveries_webhook on webhook_deliveries(webhook_id, created_at desc);
create index if not exists idx_webhook_deliveries_event   on webhook_deliveries(event, created_at desc);
create index if not exists idx_webhook_deliveries_failed
  on webhook_deliveries(created_at desc) where ok = false;

alter table webhook_deliveries enable row level security;
drop policy if exists webhook_deliveries_admin_read on webhook_deliveries;
create policy webhook_deliveries_admin_read on webhook_deliveries
  for select to authenticated
  using (app_is_admin());

-- No insert policy — only the service role writes. (Client-side fireWebhooks
-- runs under the user's session, which IS authenticated; allow inserts under
-- the user's session too so client emissions are logged.)
drop policy if exists webhook_deliveries_auth_insert on webhook_deliveries;
create policy webhook_deliveries_auth_insert on webhook_deliveries
  for insert to authenticated
  with check (true);
