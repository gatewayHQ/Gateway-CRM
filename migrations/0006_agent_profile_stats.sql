-- ============================================================================
-- 0006  Advisor profile: tagline + stats (standalone "About the Advisor" page)
-- ----------------------------------------------------------------------------
-- Idempotent, additive only. Powers two things:
--   1. The "Meet your advisor" section already on the dark landing pages.
--   2. The new standalone advisor profile page (/advisor/:id) that agents can
--      drop into an email signature, link in a bio, etc.
--
-- `bio` and `photo_url` already exist (migration 0004). This adds:
--   • agents.tagline  — one-line positioning shown under the name on the
--                       profile page (e.g. "Multifamily & investment sales, Sioux City").
--   • agents.stats    — array of { label, value } the agent curates themselves
--                       (e.g. [{label:"Closed volume", value:"$240M+"}, …]).
--                       Public, vanity-safe figures — NOT pulled from the
--                       commissions table, which stays private behind RLS.
-- ============================================================================

alter table agents add column if not exists tagline text;
alter table agents add column if not exists stats   jsonb not null default '[]';

comment on column agents.tagline is
  'One-line positioning shown under the advisor''s name on landing pages and the /advisor/:id profile page.';
comment on column agents.stats is
  'Array of { label, value } curated by the agent for public display (e.g. closed volume, years, deals). Public vanity stats — never derived from the private commissions table.';
