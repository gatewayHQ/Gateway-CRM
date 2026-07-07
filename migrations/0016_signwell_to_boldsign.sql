-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — Migrate SignWell → BoldSign
--
-- Swaps the e-signature vendor from SignWell to BoldSign. The stored data model
-- is unchanged (a per-deal record keyed by the vendor's document id), so we
-- RENAME the table in place rather than drop/recreate — existing signature
-- records and their signed-PDF links are preserved.
--
-- What changes for the app: /api/signwell → /api/boldsign, and the vendor's
-- document id in `document_id` now comes from BoldSign's /v1/document/send.
-- A new BoldSign webhook must be registered pointing at /api/boldsign (the old
-- SignWell webhook can be deleted).
--
-- Idempotent: every step is guarded so re-running is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Rename the table (only when the old one still exists and the new one does not).
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'signwell_documents')
     and not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'boldsign_documents')
  then
    alter table signwell_documents rename to boldsign_documents;
  end if;
end $$;

-- Fresh databases that never had the SignWell table still need the BoldSign one.
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

-- 2) Rename indexes (guarded — pg errors if the source name is absent).
do $$
begin
  if exists (select 1 from pg_class where relname = 'idx_signwell_docs_deal')
     and not exists (select 1 from pg_class where relname = 'idx_boldsign_docs_deal')
  then alter index idx_signwell_docs_deal rename to idx_boldsign_docs_deal; end if;

  if exists (select 1 from pg_class where relname = 'idx_signwell_docs_agent')
     and not exists (select 1 from pg_class where relname = 'idx_boldsign_docs_agent')
  then alter index idx_signwell_docs_agent rename to idx_boldsign_docs_agent; end if;

  if exists (select 1 from pg_class where relname = 'idx_signwell_docs_status')
     and not exists (select 1 from pg_class where relname = 'idx_boldsign_docs_status')
  then alter index idx_signwell_docs_status rename to idx_boldsign_docs_status; end if;

  if exists (select 1 from pg_class where relname = 'idx_signwell_docs_docid')
     and not exists (select 1 from pg_class where relname = 'idx_boldsign_docs_docid')
  then alter index idx_signwell_docs_docid rename to idx_boldsign_docs_docid; end if;
end $$;

-- Ensure indexes exist on fresh installs / partial renames.
create index if not exists idx_boldsign_docs_deal   on boldsign_documents(deal_id);
create index if not exists idx_boldsign_docs_agent  on boldsign_documents(agent_id);
create index if not exists idx_boldsign_docs_status on boldsign_documents(status) where status not in ('completed','voided');
create index if not exists idx_boldsign_docs_docid  on boldsign_documents(document_id);

-- 3) RLS: drop the old policy name, create the new one (identical scope).
alter table boldsign_documents enable row level security;
drop policy if exists signwell_documents_deal_scope on boldsign_documents;
drop policy if exists boldsign_documents_deal_scope on boldsign_documents;
create policy boldsign_documents_deal_scope on boldsign_documents for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  );

-- 4) Allow document_versions.source = 'boldsign'. Keep the legacy 'signwell'
--    value so historical rows still satisfy the constraint.
alter table document_versions drop constraint if exists document_versions_source_check;
alter table document_versions add  constraint document_versions_source_check
  check (source in ('upload','boldsign','signwell','closing_packet','import'));
