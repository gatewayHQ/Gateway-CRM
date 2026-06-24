-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 — Webhook retry queue + cron health monitoring
--
-- Two operational improvements:
--
-- 1. Webhook retries — failed deliveries get re-tried with exponential
--    backoff (1m → 5m → 30m → 2h → 8h) up to 5 attempts. The new
--    /api/cron?task=webhook-retries pass picks rows where ok=false AND
--    next_retry_at <= now() AND retry_count < 5, fires them again, and
--    records a new webhook_deliveries row per attempt.
--
-- 2. cron_runs — every cron task writes a row with started_at, finished_at,
--    success/error, and summary metrics. An admin tile reads this to alert
--    if the daily cron hasn't fired in over a day ("cron is silently broken").
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Retry plumbing on webhook_deliveries.
alter table webhook_deliveries
  add column if not exists retry_count   integer default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists parent_delivery_id uuid references webhook_deliveries(id) on delete set null;

-- Index for the retry runner — only rows that need attention.
create index if not exists idx_webhook_deliveries_retry_due
  on webhook_deliveries(next_retry_at)
  where ok = false and retry_count < 5 and next_retry_at is not null;

-- 2. Cron run log.
create table if not exists cron_runs (
  id          uuid primary key default uuid_generate_v4(),
  task        text not null,                  -- 'sequence' | 'reminders' | 'webhook-retries'
  started_at  timestamptz default now(),
  finished_at timestamptz,
  ok          boolean default false,
  error       text,
  summary     jsonb,                          -- task-specific metrics
  created_at  timestamptz default now()
);

create index if not exists idx_cron_runs_task on cron_runs(task, created_at desc);

alter table cron_runs enable row level security;
drop policy if exists cron_runs_admin_read on cron_runs;
create policy cron_runs_admin_read on cron_runs
  for select to authenticated using (app_is_admin());
-- Only the service role writes (cron handler uses the service key).
