-- ─────────────────────────────────────────────────────────────────────────────
-- 0026 — Remove Twilio SMS (feature retired 2026-07)
--
-- Gateway is not using Twilio/SMS. This drops the messaging feature's tables and
-- the per-agent number columns to cut complexity and storage. The app code (the
-- Messages page, the Twilio integration tab, /api/twilio-send + /api/twilio-
-- webhook, and the cron SMS branch) is removed in the matching commit.
--
-- DESTRUCTIVE: this deletes any stored conversations/messages. If you want to
-- keep an archive, export those tables before running. Run only after deploying
-- the app build that no longer references them.
--
-- Idempotent (drop ... if exists). Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

drop table if exists messages      cascade;   -- child of conversations
drop table if exists conversations cascade;

alter table agents drop column if exists twilio_number;
alter table agents drop column if exists twilio_sid;

-- Related Vercel env vars are now unused and can be removed:
--   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
