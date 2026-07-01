-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 — Transaction management layer
--
-- Adds the foundations the admin's daily workflow stands on:
--   • audit_log         — universal change ledger (who/what/when/before/after)
--   • document_versions — per-deal file history with "pin as final" support
--   • closing_packets   — generated PDF bundles (the closing record)
--   • agent_nudges      — dedupe ledger for cron-sent agent reminders
--   • deals.review_*    — broker-review workflow columns
--
-- Designed to slot in beside transaction_steps / signwell_documents — no
-- existing flow changes shape. RLS follows the same deal-scope helpers from
-- migration 0011 so everyone sees exactly what they already do.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Universal audit log ──────────────────────────────────────────────────────
-- One row per material event on any deal-owned record. deal_id is denormalized
-- so the deal's activity-log card reads from a single index.
create table if not exists audit_log (
  id          uuid primary key default uuid_generate_v4(),
  table_name  text not null,
  record_id   uuid,
  deal_id     uuid references deals(id) on delete cascade,
  actor_id    uuid references agents(id) on delete set null,
  action      text not null,           -- 'insert'|'update'|'delete'|'stage'|'pin'|'unpin'|'review_submit'|'review_approve'|'review_changes'|'doc_signed'|'packet_generated'
  old_values  jsonb,
  new_values  jsonb,
  summary     text,                    -- human-readable; denormalized for fast UI reads
  created_at  timestamptz default now()
);
create index if not exists idx_audit_log_deal       on audit_log(deal_id, created_at desc);
create index if not exists idx_audit_log_actor      on audit_log(actor_id, created_at desc);
create index if not exists idx_audit_log_table_rec  on audit_log(table_name, record_id);

alter table audit_log enable row level security;
drop policy if exists audit_log_scope on audit_log;
create policy audit_log_scope on audit_log for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()) or actor_id = app_current_agent_id())
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()) or actor_id = app_current_agent_id());

-- ── Document versions ────────────────────────────────────────────────────────
-- A logical document on a deal can have many versions. The current "final" is
-- pinned_as = 'final'; the latest signed copy is pinned_as = 'signed'. Storage
-- paths stay in the existing deal-documents bucket so SignWell's webhook flow
-- doesn't need to change.
create table if not exists document_versions (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade not null,
  document_name text not null,
  storage_path  text not null,
  size          bigint,
  mime_type     text,
  version_num   integer not null default 1,
  pinned_as     text check (pinned_as in ('final','signed','superseded') or pinned_as is null),
  source        text default 'upload' check (source in ('upload','signwell','closing_packet','import')),
  uploaded_by   uuid references agents(id) on delete set null,
  note          text,
  created_at    timestamptz default now()
);
create index if not exists idx_docver_deal       on document_versions(deal_id);
create index if not exists idx_docver_deal_name  on document_versions(deal_id, document_name, version_num desc);
create index if not exists idx_docver_pinned     on document_versions(deal_id, pinned_as) where pinned_as is not null;

alter table document_versions enable row level security;
drop policy if exists document_versions_scope on document_versions;
create policy document_versions_scope on document_versions for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- ── Closing packets ──────────────────────────────────────────────────────────
-- One row per generated bundle. Multiple are allowed — the admin can re-run
-- after a late addition. Each packet is a frozen snapshot referenced by the
-- audit log.
create table if not exists closing_packets (
  id           uuid primary key default uuid_generate_v4(),
  deal_id      uuid references deals(id) on delete cascade not null,
  storage_path text not null,
  size         bigint,
  doc_count    integer default 0,
  generated_by uuid references agents(id) on delete set null,
  notes        text,
  created_at   timestamptz default now()
);
create index if not exists idx_closing_packets_deal on closing_packets(deal_id, created_at desc);

alter table closing_packets enable row level security;
drop policy if exists closing_packets_scope on closing_packets;
create policy closing_packets_scope on closing_packets for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- ── Agent nudges (cron dedupe) ───────────────────────────────────────────────
-- Same pattern as deadline_reminders: one row per (agent, deal, kind, day).
-- Stops the daily cron from re-firing the same nudge.
create table if not exists agent_nudges (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade not null,
  deal_id     uuid references deals(id) on delete cascade not null,
  nudge_kind  text not null,           -- 'review_overdue'|'rotting_steps'|'closing_soon'|'docs_missing'|'review_requested'
  sent_at     timestamptz default now(),
  -- Generated column so the unique index uses an IMMUTABLE expression
  -- (date_trunc/timestamptz::date are STABLE, not valid in unique indexes).
  sent_on     date generated always as ((sent_at at time zone 'UTC')::date) stored
);
create unique index if not exists uq_agent_nudges_per_day
  on agent_nudges(agent_id, deal_id, nudge_kind, sent_on);
create index if not exists idx_agent_nudges_deal on agent_nudges(deal_id, sent_at desc);

alter table agent_nudges enable row level security;
drop policy if exists agent_nudges_scope on agent_nudges;
create policy agent_nudges_scope on agent_nudges for all to authenticated
  using      (app_is_admin() or agent_id = app_current_agent_id() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or agent_id = app_current_agent_id() or deal_id in (select app_visible_deal_ids()));

-- ── Broker review workflow on deals ──────────────────────────────────────────
-- Lightweight 1:1 columns; no new join table needed.
alter table deals add column if not exists review_status text default 'none'
  check (review_status in ('none','pending','approved','changes_requested'));
alter table deals add column if not exists review_requested_at timestamptz;
alter table deals add column if not exists review_requested_by uuid references agents(id) on delete set null;
alter table deals add column if not exists review_decided_at   timestamptz;
alter table deals add column if not exists review_decided_by   uuid references agents(id) on delete set null;
alter table deals add column if not exists review_notes        text;

create index if not exists idx_deals_review_pending
  on deals(review_requested_at desc) where review_status = 'pending';

-- ── Storage bucket for closing packets ───────────────────────────────────────
-- Idempotent — Supabase ignores duplicates by name. RLS on objects defers to
-- the closing_packets row (which is already scoped).
insert into storage.buckets (id, name, public)
values ('closing-packets', 'closing-packets', false)
on conflict (id) do nothing;
