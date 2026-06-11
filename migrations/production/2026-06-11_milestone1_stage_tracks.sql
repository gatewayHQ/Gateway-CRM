-- Gateway CRM — Milestone 1 database change (stage tracks)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run.
--
-- Lets deals carry the new commercial-track stages (pursuit, om-marketing,
-- listing-agreement, on-market, loi, psa, due-diligence) and residential
-- seller-track stages (pre-list, active) alongside every legacy token.
-- No data is rewritten.
--
-- APPLY BEFORE (or with) deploying the Milestone 1 app build: dragging a card
-- on the new commercial board writes the new tokens, which a pre-existing
-- stage CHECK constraint (if the production deals table has one) would reject.
--
-- `not valid` = the constraint applies to NEW writes only; existing rows are
-- never re-checked, so this cannot fail on legacy data whatever it contains.

alter table deals drop constraint if exists deals_stage_check;
alter table deals add constraint deals_stage_check
  check (stage in (
    'lead','qualified','showing','offer','under-contract','closed','lost',
    'pursuit','om-marketing','listing-agreement','on-market',
    'loi','psa','due-diligence',
    'pre-list','active'
  )) not valid;
