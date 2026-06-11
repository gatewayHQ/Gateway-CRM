-- Migration 0008 — Reconcile schema drift: columns the app uses that were
-- never in the canonical DDL
-- ===========================================================================
-- WHY
--   The app reads/writes three columns on `deals` (`prop_category`,
--   `prop_subtype`, `comp_data`) that existed only as a commented-out
--   "MIGRATION" block in schema.sql — they are present in the original
--   production database but missing from the canonical DDL, so any fresh
--   environment broke deal creation, the client portal (comp_data.portal_docs)
--   and deadline reminders (comp_data.key_dates).
--
--   The two files in supabase/migrations/ dated 20260605 (transaction_steps
--   doc columns, agents.nav_hidden) are also restated here so the numbered
--   chain in THIS folder is complete on its own.
--
--   schema.sql now carries all of these in the create-table DDL.
--
-- SAFETY: purely additive, all idempotent. No behavior change.
-- ===========================================================================

-- Deal-level category / subtype / flexible metadata (used by Pipeline.jsx,
-- Commission.jsx, api/portal.js, api/cron.js)
alter table deals add column if not exists prop_category text;
alter table deals add column if not exists prop_subtype  text;
alter table deals add column if not exists comp_data     jsonb default '{}';

-- State-based document checklist columns (restated from
-- supabase/migrations/20260605_state_checklist_nav_prefs.sql)
alter table transaction_steps
  add column if not exists doc_action    text    default 'manual',
  add column if not exists doc_status    text    default 'pending',
  add column if not exists if_applicable boolean default false;

comment on column transaction_steps.doc_action    is 'manual | upload | forms | sign | admin';
comment on column transaction_steps.doc_status    is 'pending | complete | approved | na';
comment on column transaction_steps.if_applicable is 'True when this document is conditional (if applicable)';

-- Per-agent sidebar visibility preferences (restated from 20260605)
alter table agents add column if not exists nav_hidden text[] default '{}';

comment on column agents.nav_hidden is 'Array of nav item IDs hidden from this agent''s sidebar';

-- The orphaned `envelopes` table (superseded by docusign_envelopes) is dropped
-- by migration 0003; schema.sql no longer references it, so a fresh install of
-- schema.sql now runs top-to-bottom without error.
