-- ═════════════════════════════════════════════════════════════════════════════
-- BoldSign template-id triage & recovery — form_packets
--
-- Run when a Form Library save fails with:
--   duplicate key value violates unique constraint "uq_form_packets_boldsign_tid"
--
-- Section 1 is READ-ONLY (safe on production, paste straight into the Supabase
-- SQL editor). Section 2 is recovery — every statement is commented out on
-- purpose; uncomment ONE, fill in the ids, and run it inside a transaction.
--
-- The constraint itself is correct and must stay: one CRM packet per BoldSign
-- template. `uq_form_packets_boldsign_tid` is a PARTIAL unique index
-- (`where boldsign_template_id is not null`), so any number of packets may have
-- no template — but a given template id can appear at most once.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. DIAGNOSE (read-only) ──────────────────────────────────────────────────

-- 1a. Who already owns the id you're trying to save?
--     Replace the literal with the id from the BoldSign editor / your paste.
--     `= lower(...)` on both sides because BoldSign ids are hex GUIDs — a
--     case-only difference is the SAME template even though the index (exact
--     match) would happily store both.
select id, name, state, transaction_type, active, boldsign_template_id,
       storage_path is not null as has_pdf,
       jsonb_array_length(coalesce(storage_paths, '[]'::jsonb)) as file_count,
       description, created_at
from form_packets
where lower(boldsign_template_id) = lower('PASTE-TEMPLATE-ID-HERE');

-- 1b. Auto-discovered drafts — the usual culprit. The nightly drift sync
--     (`/api/cron?task=boldsign-sync`, 3am) registers any BoldSign template it
--     finds that the catalog doesn't know about as an INACTIVE row. If a
--     "Build in BoldSign" session was abandoned after BoldSign minted the
--     template, the id shows up here and the next attempt to link it collides.
select id, name, state, boldsign_template_id, created_at
from form_packets
where description = 'Auto-discovered from BoldSign — review and activate in Form Library.'
   or (boldsign_template_id is not null and active = false and storage_path is null)
order by created_at desc;

-- 1c. Case-insensitive duplicates that slipped past the exact-match index —
--     two CRM rows pointing at one BoldSign template. Should return 0 rows.
select lower(boldsign_template_id) as tid, count(*), array_agg(id) as packet_ids, array_agg(name) as names
from form_packets
where boldsign_template_id is not null
group by 1
having count(*) > 1;

-- 1d. Whitespace / empty-string damage (pre-normalization rows).
select id, name, boldsign_template_id
from form_packets
where boldsign_template_id is not null
  and (boldsign_template_id <> btrim(boldsign_template_id) or btrim(boldsign_template_id) = '');

-- 1e. Is the constraint even the shape we think it is?
select indexname, indexdef from pg_indexes
where tablename = 'form_packets' and indexname = 'uq_form_packets_boldsign_tid';

-- 1f. Has this template ever been sent? Decides whether the conflicting row is
--     disposable. NOTE: `boldsign_documents` records the DOCUMENT id, not the
--     template it came from — there is no template_id column — so this matches
--     on the document name BoldSign copies from the template, which is
--     indicative, not authoritative. Confirm in BoldSign (Documents → filter by
--     template) before treating a template as unused. Any hit → RELINK
--     (PATH A/B), never delete-and-recreate.
select status, count(*) as sends, min(sent_at) as first_send, max(sent_at) as last_send
from boldsign_documents
where document_name ilike '%' || (
        select name from form_packets
        where lower(boldsign_template_id) = lower('PASTE-TEMPLATE-ID-HERE') limit 1
      ) || '%'
group by status;

-- 1g. Legacy registry still holding the id (superseded by form_packets in 0019,
--     kept for rollback). Not covered by the unique index — informational.
select template_id, name, state, doc_type, active from boldsign_templates
where lower(template_id) = lower('PASTE-TEMPLATE-ID-HERE');


-- ── 2. RECOVER (uncomment exactly one path) ──────────────────────────────────
--
-- Decision rule:
--   • 1a returns the packet you actually wanted, just badly named / inactive
--       → PATH A (adopt it). Never create a second row.
--   • 1a returns a stale draft with no PDFs and 1f shows zero sends
--       → PATH B (move the id onto the real packet, then delete the draft).
--   • The BoldSign template is genuinely wrong/orphaned and nothing was sent
--       → PATH C (unlink here, delete it in BoldSign, build a fresh template).

-- PATH A — adopt the existing row: rename it, point it at the right files, and
-- activate. This is the safest option and loses nothing.
-- begin;
--   update form_packets set
--     name             = 'Iowa Listing Agreement + Disclosures',
--     state            = 'IA',
--     transaction_type = 'seller',
--     doc_type         = 'listing_agreement',
--     description      = 'Adopted 2026-07-29 — was an auto-discovered draft.',
--     active           = true
--   where id = 'EXISTING-PACKET-UUID';
--   -- verify, then:
-- commit;

-- PATH B — transplant the id onto the packet that has the PDFs, then remove the
-- empty draft. Order matters: the unique index means the draft must release the
-- id BEFORE the keeper claims it. One transaction, so no window where the id is
-- unlinked in a way an app save or the cron could race into.
-- begin;
--   update form_packets set boldsign_template_id = null where id = 'DRAFT-PACKET-UUID';
--   update form_packets set boldsign_template_id = 'PASTE-TEMPLATE-ID-HERE',
--                           active = true
--     where id = 'KEEPER-PACKET-UUID';
--   delete from form_packets where id = 'DRAFT-PACKET-UUID'
--     and storage_path is null
--     and jsonb_array_length(coalesce(storage_paths, '[]'::jsonb)) = 0;   -- refuses to delete a row that owns files
--   -- verify: expect exactly one row, the keeper
--   select id, name, active, boldsign_template_id from form_packets
--     where lower(boldsign_template_id) = lower('PASTE-TEMPLATE-ID-HERE');
-- commit;

-- PATH C — release the id so a fresh template can be built. Deactivates rather
-- than deletes, so the packet's PDFs and history survive. Delete the orphaned
-- template in BoldSign afterwards, or the nightly sync will re-register it.
-- begin;
--   update form_packets set boldsign_template_id = null, active = false
--     where id = 'PACKET-UUID';
-- commit;

-- Cleanup (any path): normalize stored ids so the exact-match index and the
-- app's case-insensitive pre-flight check agree.
-- begin;
--   update form_packets set boldsign_template_id = nullif(btrim(boldsign_template_id), '')
--     where boldsign_template_id is not null
--       and (boldsign_template_id <> btrim(boldsign_template_id) or btrim(boldsign_template_id) = '');
-- commit;

-- Optional hardening — make the uniqueness case-insensitive so the database
-- enforces what the app now checks. Run 1c FIRST and resolve any duplicates, or
-- this index creation will fail (which is the point).
-- begin;
--   drop index if exists uq_form_packets_boldsign_tid;
--   create unique index uq_form_packets_boldsign_tid
--     on form_packets (lower(boldsign_template_id))
--     where boldsign_template_id is not null;
-- commit;
