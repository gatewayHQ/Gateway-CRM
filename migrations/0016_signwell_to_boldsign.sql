-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — Migrate SignWell → BoldSign
--
-- Renames signwell_documents to the provider-neutral esign_documents instead
-- of dropping it (unlike 0014's DocuSign drop, existing rows are real signed
-- documents we must keep). Every existing row is stamped provider='signwell'
-- so historical envelopes stay visible in the UI; new BoldSign sends default
-- to provider='boldsign'.
--
-- New columns:
--   provider      — 'signwell' (historical) | 'boldsign'
--   template_id   — BoldSign template used for the send (null for uploads)
--   prepare_url   — BoldSign embedded prepare/send URL while status='draft'
--   signer_status — per-signer status snapshots from webhook/status polls:
--                   [{ name, email, status, viewed, last_activity }]
--   error         — last send/webhook failure surfaced to the UI (null = ok)
--
-- agent_notifications.envelope_id stays put: opaque text that now stores the
-- BoldSign document id when a "Document Signed" notification fires (historic
-- rows keep their SignWell ids — they are display-only).
-- ─────────────────────────────────────────────────────────────────────────────

alter table if exists signwell_documents rename to esign_documents;

alter table esign_documents add column if not exists provider      text  not null default 'signwell';
alter table esign_documents add column if not exists template_id   text;
alter table esign_documents add column if not exists prepare_url   text;
alter table esign_documents add column if not exists signer_status jsonb not null default '[]';
alter table esign_documents add column if not exists error         text;

-- Existing rows were all created through SignWell (default above covered
-- them); flip the default so new inserts are BoldSign.
alter table esign_documents alter column provider set default 'boldsign';
alter table esign_documents drop constraint if exists esign_documents_provider_check;
alter table esign_documents add constraint esign_documents_provider_check
  check (provider in ('signwell', 'boldsign'));

alter index if exists idx_signwell_docs_deal   rename to idx_esign_docs_deal;
alter index if exists idx_signwell_docs_agent  rename to idx_esign_docs_agent;
alter index if exists idx_signwell_docs_status rename to idx_esign_docs_status;
alter index if exists idx_signwell_docs_docid  rename to idx_esign_docs_docid;

-- Policy follows the renamed table automatically; rename it for consistency.
-- (DO block: "alter policy if exists" doesn't exist, and fresh installs from
-- schema.sql already have the new name.)
do $$
begin
  if exists (
    select 1 from pg_policies
    where tablename = 'esign_documents' and policyname = 'signwell_documents_deal_scope'
  ) then
    alter policy signwell_documents_deal_scope on esign_documents
      rename to esign_documents_deal_scope;
  end if;
end $$;

-- document_versions.source gains 'boldsign'. 'signwell' stays in the allowed
-- set — historical rows carry it and the check validates existing data.
alter table document_versions drop constraint if exists document_versions_source_check;
alter table document_versions add constraint document_versions_source_check
  check (source in ('upload', 'signwell', 'boldsign', 'closing_packet', 'import'));
