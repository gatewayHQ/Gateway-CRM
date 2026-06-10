-- Migration 0010 — Data guards on deals: no negative values, sane probability
-- ===========================================================================
-- WHY
--   deals.value feeds every commission calculation and pipeline total, and
--   deals.probability is meant to be a percentage — but neither had any
--   constraint, so a typo (negative value, 1000% probability) silently
--   poisoned the commission math and reports. Garbage in, garbage out.
--
-- WHAT
--   1. One-time cleanup of any existing out-of-range rows (value: negative →
--      null, i.e. "unknown"; probability: clamped into 0–100).
--   2. Named CHECK constraints so bad rows can never be written again. The
--      same constraints are in schema.sql's deals DDL for fresh installs.
--
-- SAFETY: the cleanup updates only out-of-range rows (run the SELECTs below
-- first if you want to see what will change — normally zero rows). The
-- constraint swap is idempotent.
--
--   select id, title, value       from deals where value < 0;
--   select id, title, probability from deals where probability < 0 or probability > 100;
-- ===========================================================================

-- 1) Cleanup (no-op when the data is already clean)
update deals set value = null
  where value < 0;

update deals set probability = greatest(0, least(100, probability))
  where probability < 0 or probability > 100;

-- 2) Guards
alter table deals drop constraint if exists deals_value_nonneg;
alter table deals add  constraint deals_value_nonneg
  check (value is null or value >= 0);

alter table deals drop constraint if exists deals_probability_range;
alter table deals add  constraint deals_probability_range
  check (probability is null or (probability >= 0 and probability <= 100));
