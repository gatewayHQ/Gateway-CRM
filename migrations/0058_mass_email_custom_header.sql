-- ─────────────────────────────────────────────────────────────────────────────
-- 0058 — Mass Email: Market Update and "Other" sends
--
-- Mass Email gains two sends that are not about one property: a Market Update
-- (the agent's own graphic plus commentary) and "Other", where the agent writes
-- the header that prints in the email's coloured band. Both are new values of
-- email_blasts.deal_status, which is free text — no CHECK to change.
--
-- The only new storage is that agent-written header. It is kept on the blast,
-- like hidden_facts, because it is part of what was SENT: a resumed batch
-- tomorrow has to print the same header the first batch did.
--
-- Additive and idempotent. Until it is applied, deal announcements and Market
-- Updates send as before; only an "Other" send is refused (the insert names the
-- missing column), since that is the one send that needs it.
-- ─────────────────────────────────────────────────────────────────────────────

alter table email_blasts add column if not exists custom_header text;
