-- Migration 0004 — Agent bio, headshot & phone (landing-page advisor cards)
-- ---------------------------------------------------------------------------
-- The QR landing pages show a "Meet your advisor(s)" section. Agents need a
-- place to store the bio + headshot + phone that appears there. These live on
-- the agents table so they are written once and reused on every mailing the
-- agent is on. (phone/photo_url may already exist from earlier ad-hoc use;
-- `if not exists` makes this safe and idempotent either way.)
-- ---------------------------------------------------------------------------

alter table agents add column if not exists phone     text;
alter table agents add column if not exists photo_url text;   -- headshot (public URL)
alter table agents add column if not exists bio       text;   -- short advisor bio
