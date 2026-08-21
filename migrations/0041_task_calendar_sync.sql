-- ─────────────────────────────────────────────────────────────────────────────
-- 0041 — Task due dates → Outlook calendar sync
--
-- The companion to migration 0035 (deal key dates). A task created in the CRM
-- with a due date now shows up on the ASSIGNED AGENT's own Outlook calendar,
-- so the thing they are supposed to do on Thursday appears in the calendar
-- they already check rather than only inside the CRM's Tasks page.
--
-- task_calendar_events is the idempotency ledger, one row per task (a task has
-- a single due_date, unlike a deal's several key dates), mapping to the Graph
-- event id it created plus a hash of the fields that would change the event
-- (title/date/contact/deal/priority/notes) so a sync can skip anything
-- unchanged instead of re-writing every event every night.
--
-- The row and its Graph event go away when the task is completed, loses its due
-- date, is unassigned, is reassigned to another agent (the event moves to the
-- new assignee's calendar), or is deleted — a task ticked off in the CRM must
-- not keep nagging from the agent's phone. See api/_lib/calendarSync.js.
--
-- Written ONLY by the service key (api/cron.js's nightly ?task=calendar-sync
-- sweep, and api/email-send.js's on-demand ?action=outlook-task-calendar-sync
-- fired right after a task is saved) — never directly by the client.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists task_calendar_events (
  id              uuid primary key default uuid_generate_v4(),
  task_id         uuid not null references tasks(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  graph_event_id  text not null,           -- Microsoft Graph calendar event id
  event_hash      text not null,           -- sha256 of the event-visible task fields — cheap drift check
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
-- One event per (task, agent). Not just task_id: a reassignment briefly has the
-- old assignee's row alongside the new one, and the sync deletes the old event
-- off that agent's calendar using that agent's own token.
create unique index if not exists uq_task_calendar_events_key
  on task_calendar_events(task_id, agent_id);
create index if not exists idx_task_calendar_events_task  on task_calendar_events(task_id);
create index if not exists idx_task_calendar_events_agent on task_calendar_events(agent_id);

alter table task_calendar_events enable row level security;

-- Mirrors tasks_agent_scope exactly: STRICTLY PERSONAL, admins included — a
-- to-do list isn't oversight data, and neither is which of those to-dos landed
-- on someone's calendar. Writes are service-key only in practice (the service
-- role bypasses RLS), but the policy is scoped consistently anyway.
drop policy if exists task_calendar_events_agent_scope on task_calendar_events;
create policy task_calendar_events_agent_scope on task_calendar_events for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());
