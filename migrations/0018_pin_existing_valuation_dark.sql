-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 — Pin already-existing Home Valuation campaigns to the legacy dark design
--
-- The valuation landing page got a new light/interactive redesign, but
-- multifamily is staying on its current dark design permanently (no change
-- there — this migration does not touch it).
--
-- To avoid changing the look of anything already live, every 'valuation'
-- mailing that exists at the moment this migration runs gets
-- landing_config.theme = 'dark' stamped on it, which the dispatcher in
-- LandingValuation.jsx reads to keep rendering the original dark design.
-- Any 'valuation' mailing created AFTER this migration has no theme key and
-- gets the new light design by default.
--
-- Run this promptly relative to deploying the new frontend code — any
-- valuation campaign created in the gap between deploy and running this
-- migration will not be flagged and will pick up the new light design.
-- ─────────────────────────────────────────────────────────────────────────────

update mailings
set landing_config = coalesce(landing_config, '{}'::jsonb) || '{"theme":"dark"}'::jsonb
where landing_type = 'valuation'
  and (landing_config ->> 'theme') is null;
