-- Migration 0012 — Track-aware pipeline stages (Milestone 1)
-- ===========================================================================
-- WHY
--   One pipeline board forced commercial deals through residential stages.
--   Decided 2026-06 (Daniel): three boards over the same deals.stage column —
--     Commercial:          pursuit → om-marketing → listing-agreement →
--                          on-market → loi → psa → due-diligence → closed
--     Residential buyers:  lead → showing → offer → under-contract → closed
--     Residential sellers: lead → pre-list → active → under-contract → closed
--   plus the shared 'lost'. Legacy tokens ('qualified', and old commercial
--   deals using residential tokens) remain valid; boards display them in the
--   nearest column and only rewrite stage when an agent drags the card
--   (src/lib/stages.js).
--
-- SAFETY: constraint swap only; no data rewritten. The superset includes every
-- legacy token, so existing rows always satisfy the new constraint.
-- ===========================================================================

alter table deals drop constraint if exists deals_stage_check;
alter table deals add constraint deals_stage_check
  check (stage in (
    'lead','qualified','showing','offer','under-contract','closed','lost',
    'pursuit','om-marketing','listing-agreement','on-market',
    'loi','psa','due-diligence',
    'pre-list','active'
  ));
