-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — Migrate DocuSign → SignWell
--
-- Replaces docusign_envelopes with signwell_documents (the SignWell document
-- id is the new external reference) and drops the docusign_field_templates
-- table (anchor-tab presets no longer needed — SignWell uses text-tags or
-- explicit coordinate fields).
--
-- agent_notifications.envelope_id stays put: it's just opaque text now used to
-- store the SignWell document id when a "Document Signed" notification fires.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists signwell_documents (
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

create index if not exists idx_signwell_docs_deal   on signwell_documents(deal_id);
create index if not exists idx_signwell_docs_agent  on signwell_documents(agent_id);
create index if not exists idx_signwell_docs_status on signwell_documents(status) where status not in ('completed','voided');
create index if not exists idx_signwell_docs_docid  on signwell_documents(document_id);

alter table signwell_documents enable row level security;

drop policy if exists signwell_documents_deal_scope on signwell_documents;
create policy signwell_documents_deal_scope on signwell_documents for all to authenticated
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

-- Drop legacy DocuSign tables (data is not migrated — DocuSign envelopes
-- belong to DocuSign; carrying their IDs into SignWell would be misleading).
drop table if exists docusign_envelopes cascade;
drop table if exists docusign_field_templates cascade;
