-- Migration 0046 — Signature Packets (deal-level envelope module)
-- ===========================================================================
-- WHY
--   `boldsign_documents` already holds one row per send, and that row IS the
--   packet — there is no second envelope concept to invent. What it could not
--   say was everything the packet module needs to act:
--
--     • whether the packet was built as ONE merged envelope or SEVERAL split
--       ones (`mode`) — the difference decides what MLS gets;
--     • which templates went into it (`template_ids`) — a merged envelope is
--       built from several, and `boldsign_template_id` holds exactly one;
--     • which FILES BoldSign holds inside it (`file_ids`) — the thing that
--       makes "download each form separately" possible at all;
--     • whether it was created with DocumentDownloadOption Combined or
--       Individually (`download_option`) — BoldSign fixes this at creation and
--       it decides whether the completed download is one PDF or a zip of them;
--     • which packet it is a CORRECTION of (`correction_of_document_id`) — a
--       completed envelope is immutable, so an acknowledgement + initials is a
--       new envelope that has to stay attached to the one it corrects;
--     • where the completed pieces landed locally (`local_files`) — the signed
--       PDF, the audit trail, and each split part, because MLS uploads are
--       assembled from those in our own PDF layer, never in BoldSign;
--     • that an async file edit is still settling (`edit_pending_since`) —
--       BoldSign answers a file Add/Update/Remove with a QUEUED document, and
--       showing a success toast over a document that has not caught up is how
--       an agent sends a packet that is missing a page.
--
--   `mls_number` is snapshotted onto the packet rather than read through
--   `properties` every time for the same reason `pricing_history` denormalizes
--   the agent's name: an MLS upload is a record of what was filed, and a
--   listing that is later re-keyed under a new MLS number must not silently
--   rewrite what an already-filed packet says it was.
--
--   `raw_status` records BoldSign's own word for the state. `status` stays the
--   normalized, forward-only lifecycle column every other query filters on
--   (the portal, the reminder sweep, the closing gate) — see the "forward-only"
--   note in api/boldsign.js — and the raw value rides beside it so the UI can
--   show the truth without an unrecognized string taking a document out of
--   those queries.
--
--   `signature_packet_events` is the deal timeline for signing. `audit_log`
--   records what an AGENT did; `agent_notifications` says what an agent should
--   look at. Neither records "BoldSign told us Jane viewed it at 14:02", which
--   is the record a compliance question actually asks for. Deliberately not
--   `activities`: that table's CHECK constrains `type` to the five human
--   activity kinds, and machine events do not belong in the call/note feed.
--
-- SAFETY: purely additive and idempotent. No existing column is altered and no
-- existing row is written. Every new column is nullable or defaulted, so the
-- app works before and after this runs (the code reads them defensively — see
-- the column-fallback pattern already in trackDocument()).
-- ===========================================================================

-- ── Packet columns on the envelope row ──────────────────────────────────────
alter table boldsign_documents
  -- 'merged'  — one BoldSign envelope built from several templates
  -- 'split'   — one of several envelopes, one per form, same signers
  -- 'single'  — the ordinary one-template / one-PDF send (the default)
  add column if not exists mode text,
  -- Every template that went into this envelope, in send order. Superset of
  -- `boldsign_template_id`, which stays as-is because deal_field_layouts keys
  -- on it.
  add column if not exists template_ids text[],
  -- The files BoldSign holds inside this document, read from
  -- GET /v1/document/properties: [{ id, name, pageCount }]. This is what makes
  -- "download the disclosures on their own" answerable.
  add column if not exists file_ids jsonb default '[]'::jsonb,
  -- Snapshot, not a join — see the header note.
  add column if not exists mls_number text,
  -- The BoldSign document id this packet corrects. Set on the clone created by
  -- "Send correction packet"; null on an original.
  add column if not exists correction_of_document_id text,
  -- 'Combined' | 'Individually' — fixed by BoldSign at creation.
  add column if not exists download_option text,
  -- What we hold locally once it completes:
  --   [{ kind: 'signed_pdf'|'audit'|'split_part'|'mls_bundle',
  --      path, pages?, form_name }]
  -- signed_storage_path / audit_storage_path stay as the canonical pointers for
  -- the two files the download action resolves; this is the full manifest the
  -- MLS packager picks from, including the per-form split parts those two
  -- columns have no room for.
  add column if not exists local_files jsonb default '[]'::jsonb,
  -- Set when BoldSign answers an edit with a Queued document; cleared when
  -- properties (or a webhook) shows it settled. A packet with this set is not
  -- safe to send — the file change has not landed yet.
  add column if not exists edit_pending_since timestamptz,
  -- BoldSign's own status string, for display only. Never filtered on.
  add column if not exists raw_status text;

comment on column boldsign_documents.mode is
  'merged | split | single — how this packet was composed before sending.';
comment on column boldsign_documents.correction_of_document_id is
  'BoldSign document id this packet is an acknowledgement/initials correction of. Completed envelopes are immutable; a correction is a clone, never an edit.';
comment on column boldsign_documents.download_option is
  'Combined | Individually — BoldSign DocumentDownloadOption, fixed at creation.';
comment on column boldsign_documents.local_files is
  'Manifest of everything archived for this packet: signed_pdf, audit, split_part, mls_bundle.';
comment on column boldsign_documents.edit_pending_since is
  'Non-null while an async BoldSign file edit is still Queued. The packet is not sendable until it clears.';

-- Find every correction of a packet without scanning the deal.
create index if not exists idx_boldsign_docs_correction_of
  on boldsign_documents(correction_of_document_id)
  where correction_of_document_id is not null;

-- The "is anything still settling?" sweep.
create index if not exists idx_boldsign_docs_edit_pending
  on boldsign_documents(edit_pending_since)
  where edit_pending_since is not null;

-- ── Signing timeline ────────────────────────────────────────────────────────
-- One row per webhook delivery worth remembering. Append-only by convention.
create table if not exists signature_packet_events (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid references deals(id) on delete cascade,
  -- The envelope row, when we have one. `set null` rather than cascade: the
  -- event happened even if the (unsigned) document is later removed, and the
  -- BoldSign document id below still identifies it.
  packet_id   uuid references boldsign_documents(id) on delete set null,
  document_id text not null,
  -- BoldSign's event name as delivered: Sent, Viewed, Signed, Completed,
  -- Declined, Revoked, Expired, ... plus our own 'Edited' for a document we
  -- changed through the edit API. Stored verbatim, not normalized: a timeline
  -- that rewrites what it was told is not a timeline.
  event       text not null,
  -- The normalized lifecycle status this event implied, when it implied one.
  status      text,
  signer_name  text,
  signer_email text,
  -- When BoldSign says it happened, not when we processed it.
  occurred_at timestamptz,
  -- Deterministic per (document, event, actor, moment) so a webhook
  -- redelivery — which BoldSign does on any non-2xx, and this handler invites
  -- by doing real work — updates one row instead of adding a duplicate to the
  -- timeline. See the "IDEMPOTENCE + ORDERING GATE" note in api/boldsign.js.
  dedupe_key  text not null,
  payload     jsonb default '{}'::jsonb,
  created_at  timestamptz default now()
);

create unique index if not exists uq_signature_packet_events_dedupe
  on signature_packet_events(dedupe_key);
create index if not exists idx_signature_packet_events_deal
  on signature_packet_events(deal_id, occurred_at desc);
create index if not exists idx_signature_packet_events_doc
  on signature_packet_events(document_id, occurred_at desc);

alter table signature_packet_events enable row level security;

-- Follows the deal, like every other deal-scoped child. Written by the webhook
-- through the service key, which bypasses RLS — this policy is what agents
-- read it back through.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_visible_deal_ids') then
    drop policy if exists signature_packet_events_deal_scope on signature_packet_events;
    create policy signature_packet_events_deal_scope on signature_packet_events
      for all to authenticated
      using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
      with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));
  else
    -- A database that has not had the scoping migrations (0002/0011) applied
    -- yet: match the posture those tables have there rather than locking the
    -- feature out entirely.
    if not exists (select 1 from pg_policies where tablename='signature_packet_events' and policyname='allow_all_authenticated') then
      create policy "allow_all_authenticated" on signature_packet_events
        for all to authenticated using (true) with check (true);
    end if;
  end if;
end $$;
