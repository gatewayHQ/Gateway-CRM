-- ─────────────────────────────────────────────────────────────────────────────
-- 0028 — Align property foreign keys with ON DELETE SET NULL (drift fix)
--
-- schema.sql declares deals.property_id and mailings.property_id as
-- `references properties(id) on delete set null`, but the live constraints were
-- created without the ON DELETE rule, so deleting a property that any deal or
-- mailing pointed at failed with:
--   "update or delete on table properties violates foreign key constraint
--    deals_property_id_fkey on table deals"
--
-- This recreates both constraints with ON DELETE SET NULL so deleting a listing
-- detaches it (nulls the reference) instead of erroring. The child tables that
-- should cascade (property_contacts, property_showings, listing_checklist_steps)
-- already do.
--
-- Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table deals    drop constraint if exists deals_property_id_fkey;
alter table deals    add  constraint deals_property_id_fkey
  foreign key (property_id) references properties(id) on delete set null;

alter table mailings drop constraint if exists mailings_property_id_fkey;
alter table mailings add  constraint mailings_property_id_fkey
  foreign key (property_id) references properties(id) on delete set null;
