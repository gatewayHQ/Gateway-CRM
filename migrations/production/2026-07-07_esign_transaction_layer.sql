-- ─────────────────────────────────────────────────────────────────────────────
-- Gateway CRM — e-signature + transaction-layer reconciliation (2026-07-07)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run (idempotent).
--
-- WHY THIS EXISTS
-- The live database was reconciled up through the Back Office milestone
-- (2026-06-12 ≈ numbered migration 0013). The numbered migrations 0014
-- (DocuSign→SignWell), 0015 (transaction layer) and 0016 (SignWell→BoldSign)
-- were NEVER applied to production. As a result these features are backed by
-- tables that don't exist in live yet:
--   • E-signature (Signatures tab)      → boldsign_documents
--   • Deal activity log / audit trail    → audit_log
--   • Document versioning / pin-as-final → document_versions
--   • Closing packet generator           → closing_packets + closing-packets bucket
--   • Broker review workflow (AdminReview)→ deals.review_* columns
--   • Cron agent nudges                   → agent_nudges
--
-- This bundle creates all of them in one pass. It collapses 0014/0015/0016 into
-- their end state: because SignWell was never live, we create boldsign_documents
-- directly (no rename step). Depends on the app_* deal-scope helpers created by
-- the 2026-06-10 milestone-0 bundle (already applied).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. BoldSign documents (e-signature requests tracked per deal) ────────────
create table if not exists boldsign_documents (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade,
  document_ref  uuid references documents(id) on delete set null,
  agent_id      uuid references agents(id) on delete set null,
  document_id   text not null,
  status        text default 'sent',
  subject       text,
  signer_name   text,
  signer_email  text,
  document_name text,
  signers       jsonb default '[]',
  sent_at       timestamptz default now(),
  completed_at  timestamptz,
  created_at    timestamptz default now()
);
create index if not exists idx_boldsign_docs_deal   on boldsign_documents(deal_id);
create index if not exists idx_boldsign_docs_agent  on boldsign_documents(agent_id);
create index if not exists idx_boldsign_docs_status on boldsign_documents(status) where status not in ('completed','voided');
create index if not exists idx_boldsign_docs_docid  on boldsign_documents(document_id);

alter table boldsign_documents enable row level security;
drop policy if exists boldsign_documents_deal_scope on boldsign_documents;
create policy boldsign_documents_deal_scope on boldsign_documents for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()) or agent_id = app_current_agent_id())
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()) or agent_id = app_current_agent_id());

-- ── 2. Universal audit log ───────────────────────────────────────────────────
create table if not exists audit_log (
  id          uuid primary key default uuid_generate_v4(),
  table_name  text not null,
  record_id   uuid,
  deal_id     uuid references deals(id) on delete cascade,
  actor_id    uuid references agents(id) on delete set null,
  action      text not null,
  old_values  jsonb,
  new_values  jsonb,
  summary     text,
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

-- ── 3. Document versions (file history + pin-as-final) ───────────────────────
create table if not exists document_versions (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade not null,
  document_name text not null,
  storage_path  text not null,
  size          bigint,
  mime_type     text,
  version_num   integer not null default 1,
  pinned_as     text check (pinned_as in ('final','signed','superseded') or pinned_as is null),
  source        text default 'upload' check (source in ('upload','boldsign','signwell','closing_packet','import')),
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

-- ── 4. Closing packets ───────────────────────────────────────────────────────
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

-- ── 5. Agent nudges (cron dedupe) ────────────────────────────────────────────
create table if not exists agent_nudges (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade not null,
  deal_id     uuid references deals(id) on delete cascade not null,
  nudge_kind  text not null,
  sent_at     timestamptz default now(),
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

-- ── 6. Broker review workflow columns on deals ───────────────────────────────
alter table deals add column if not exists review_status text default 'none'
  check (review_status in ('none','pending','approved','changes_requested'));
alter table deals add column if not exists review_requested_at timestamptz;
alter table deals add column if not exists review_requested_by uuid references agents(id) on delete set null;
alter table deals add column if not exists review_decided_at   timestamptz;
alter table deals add column if not exists review_decided_by   uuid references agents(id) on delete set null;
alter table deals add column if not exists review_notes        text;
create index if not exists idx_deals_review_pending
  on deals(review_requested_at desc) where review_status = 'pending';

-- ── 7. Storage bucket for closing packets ────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('closing-packets', 'closing-packets', false)
on conflict (id) do nothing;

-- ── 8. OPTIONAL cleanup — legacy DocuSign tracking ───────────────────────────
-- The live DB carries an old-shape `docusign_envelopes` table (and possibly
-- `docusign_field_templates`). Nothing in the current app reads them. They are
-- harmless if left in place. Uncomment to remove them once you've confirmed you
-- don't need the historical DocuSign envelope ids.
--   drop table if exists docusign_envelopes cascade;
--   drop table if exists docusign_field_templates cascade;
