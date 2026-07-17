-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 — BoldSign audit-trail tracking
--
-- On document completion the webhook archives the signed PDF AND the compliance
-- audit trail into deal-documents. This flag records whether the audit trail
-- made it (it can lag the signed PDF), so the UI can offer a manual fetch.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
alter table boldsign_documents add column if not exists audit_trail_saved boolean default false;
