-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Client Portal — shareable read-only transaction tracker
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-deal portal token (unguessable v4 uuid) + enable flag.
-- Documents shared with the client are tracked in deals.comp_data.portal_docs
-- (array of storage filenames) so internal files are never exposed by default.
alter table deals add column if not exists portal_token   uuid;
alter table deals add column if not exists portal_enabled  boolean default false;

create unique index if not exists deals_portal_token_idx
  on deals(portal_token) where portal_token is not null;
