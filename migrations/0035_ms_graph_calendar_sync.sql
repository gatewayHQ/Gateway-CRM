-- ─────────────────────────────────────────────────────────────────────────────
-- 0035 — Deal key dates → Outlook calendar sync
--
-- Extends the Microsoft Graph integration (migration 0034) to push each open
-- deal's key dates (deals.comp_data.key_dates, edited in Pipeline's Key Dates
-- tab) onto the ASSIGNED AGENT's own Outlook calendar as all-day events with a
-- native reminder — so the date shows up on every device the agent already
-- checks, not just inside the CRM.
--
-- deal_calendar_events is the idempotency ledger: one row per (deal, agent,
-- date_type) mapping to the Graph event id it created, plus a hash of the
-- fields that would change the event (title/date/property) so a sync run can
-- skip anything unchanged instead of re-writing every event every night. Rows
-- disappear (and the Graph event is deleted) when a key date is removed from
-- the deal or the deal closes/is lost — see api/_lib/calendarSync.js.
--
-- Written ONLY by the service key (api/cron.js's nightly sweep, and
-- api/email-send.js's on-demand action=outlook-calendar-sync fired right after
-- an agent edits a key date) — never directly by the client.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_calendar_events (
  id              uuid primary key default uuid_generate_v4(),
  deal_id         uuid not null references deals(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  date_type       text not null,           -- matches deals.comp_data.key_dates[].type
  graph_event_id  text not null,           -- Microsoft Graph calendar event id
  event_hash      text not null,           -- sha256 of (type,date,title,address) — cheap drift check
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_deal_calendar_events_key
  on deal_calendar_events(deal_id, agent_id, date_type);
create index if not exists idx_deal_calendar_events_deal  on deal_calendar_events(deal_id);
create index if not exists idx_deal_calendar_events_agent on deal_calendar_events(agent_id);

alter table deal_calendar_events enable row level security;

-- Follows the deal (read-only for agents in practice — writes are service-key
-- only — but scoped consistently with every other deal-child table).
drop policy if exists deal_calendar_events_deal_scope on deal_calendar_events;
create policy deal_calendar_events_deal_scope on deal_calendar_events for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()) or agent_id = app_current_agent_id())
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()) or agent_id = app_current_agent_id());
