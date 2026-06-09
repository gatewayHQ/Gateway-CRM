-- ============================================================================
-- 0007  Add 'cancelled' to the properties.status options (listings pipeline)
-- ----------------------------------------------------------------------------
-- The Listings board in the pipeline now has a "Cancelled" column so an agent
-- can drag a listing there when it falls through. The existing CHECK constraint
-- only allowed active/pending/sold/off-market/leased, which would reject the
-- update — this widens it. Safe/idempotent: drops the old constraint by name
-- and re-adds the full allowed set.
-- ============================================================================

alter table properties drop constraint if exists properties_status_check;
alter table properties add  constraint properties_status_check
  check (status in ('active','pending','sold','off-market','leased','cancelled'));
