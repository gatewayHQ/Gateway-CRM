-- ─────────────────────────────────────────────────────────────────────────────
-- Gateway CRM — BoldSign audit-trail tracking  (2026-07-08)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run (idempotent).
--
-- Adds boldsign_documents.audit_trail_saved — set true once the compliance audit
-- trail PDF has been archived to deal-documents for a completed signature.
-- ─────────────────────────────────────────────────────────────────────────────
alter table boldsign_documents add column if not exists audit_trail_saved boolean default false;
