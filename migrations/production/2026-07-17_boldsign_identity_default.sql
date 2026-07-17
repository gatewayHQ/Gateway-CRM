-- ─────────────────────────────────────────────────────────────────────────────
-- Gateway CRM — BoldSign sender identity default  (2026-07-17)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run (idempotent).
--
-- Adds boldsign_sender_identities.is_default — the org-wide fallback sender for
-- OnBehalfOf when the acting agent has no approved identity of their own.
-- ─────────────────────────────────────────────────────────────────────────────
alter table boldsign_sender_identities add column if not exists is_default boolean default false;

create unique index if not exists uq_boldsign_identity_default
  on boldsign_sender_identities(is_default) where is_default;
