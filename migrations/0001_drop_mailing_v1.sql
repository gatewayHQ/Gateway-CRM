-- Migration 0001 — Drop legacy mailing v1 tables
-- ---------------------------------------------------------------------------
-- Context:
--   The mailing feature was rebuilt as "v2" (mailings / mailing_recipients /
--   mailing_scans / mailing_leads). The original v1 tables are no longer
--   referenced anywhere in the application (verified across src/ and api/):
--     • mail_campaigns
--     • mail_sends         (FK → mail_campaigns, cold_call_leads)
--     • mail_suppressions
--
-- This migration removes them. It is safe to run on any environment: the
-- tables hold only legacy data and have no live readers or writers.
--
-- Apply once via the Supabase SQL Editor. Idempotent (IF EXISTS).
-- ---------------------------------------------------------------------------

-- Drop child first (mail_sends references mail_campaigns), then parents.
drop table if exists mail_sends        cascade;
drop table if exists mail_campaigns    cascade;
drop table if exists mail_suppressions cascade;
