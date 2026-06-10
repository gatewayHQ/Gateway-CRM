-- Migration 0009 — Activities can attach to deals
-- ===========================================================================
-- WHY
--   Activities (calls, notes, emails, meetings, showings) could only attach to
--   a contact, so a deal had no timeline of its own — the single biggest
--   connectivity gap in the data model. An activity can now reference a
--   contact, a deal, or both (a call about a specific deal logs to the
--   contact's history AND the deal's timeline).
--
--   on delete set null (not cascade): deleting a deal keeps the activity on
--   the contact's history — the conversation still happened.
--
-- SAFETY: purely additive, idempotent. No behavior change (no existing rows
-- have a deal_id; the UI starts writing it as deal-timeline features land).
-- ===========================================================================

alter table activities
  add column if not exists deal_id uuid references deals(id) on delete set null;

create index if not exists idx_activities_deal on activities(deal_id, created_at desc);
