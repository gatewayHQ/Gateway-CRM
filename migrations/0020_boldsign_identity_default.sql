-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 — BoldSign sender identity: org-wide default
--
-- Adds boldsign_sender_identities.is_default — the fallback sender used for
-- OnBehalfOf when the acting agent has no approved identity of their own (e.g.
-- an admin- or system-triggered send). A partial unique index enforces at most
-- one default at a time. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
alter table boldsign_sender_identities add column if not exists is_default boolean default false;

create unique index if not exists uq_boldsign_identity_default
  on boldsign_sender_identities(is_default) where is_default;
