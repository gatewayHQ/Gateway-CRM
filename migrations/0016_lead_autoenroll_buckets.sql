-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — Auto-enrollment plumbing + storage bucket bootstrap + lead tracking
--
-- Adds the schema needed for website leads to be auto-enrolled in an agent's
-- drip campaign, ensures every storage bucket the app uses actually exists,
-- and stamps the source URL on inbound web leads so reporting can answer
-- "which page did this lead come from?".
--
-- Safe to run on a populated production DB:
--   • All ALTERs use IF NOT EXISTS
--   • Bucket inserts use ON CONFLICT DO NOTHING
--   • No table renames, no data movement, no policy changes on existing tables
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Storage buckets ─────────────────────────────────────────────────────
-- Until now, every bucket was a manual dashboard step. A fresh environment
-- silently 404s the first upload. This block creates each one if missing.
-- Storage policies are intentionally left untouched — they're managed
-- via the Supabase dashboard UI and changing them here would risk locking
-- out existing signed URLs.
insert into storage.buckets (id, name, public)
values
  ('form-packets',    'form-packets',    false),
  ('deal-documents',  'deal-documents',  false),
  ('property-photos', 'property-photos', false),
  ('campaign-images', 'campaign-images', false)
on conflict (id) do nothing;

-- ── 2. Per-agent default drip sequences ────────────────────────────────────
-- One slot per contact type. An agent who only does residential can leave
-- the commercial slot null; auto-enrollment will detect that and notify the
-- office admin instead of silently dropping the lead.
alter table agents
  add column if not exists default_buyer_sequence_id      uuid references sequences(id) on delete set null,
  add column if not exists default_seller_sequence_id     uuid references sequences(id) on delete set null,
  add column if not exists default_commercial_sequence_id uuid references sequences(id) on delete set null;

-- ── 3. Distinguish auto vs manual enrollments ──────────────────────────────
-- So an agent can see at a glance which contacts the system enrolled vs
-- the ones they enrolled themselves, and so we can build reports later.
alter table contact_sequences
  add column if not exists auto_enrolled boolean default false;

-- Prevent double-enrolling the same contact into the same sequence twice
-- (would happen if the lead form is submitted twice before the contact is
-- de-duped). Partial unique index — only enforced for active enrollments.
create unique index if not exists uniq_contact_seq_active
  on contact_sequences(contact_id, sequence_id)
  where status = 'active';

-- ── 4. Source URL on contacts ──────────────────────────────────────────────
-- The lead intake endpoint will stamp this from the request body
-- (preferred) or the Referer header (fallback). Lets us answer "which
-- landing page generated this lead" without parsing notes.
alter table contacts
  add column if not exists source_url text;

create index if not exists idx_contacts_source_url
  on contacts(source_url)
  where source_url is not null;

-- ── 5. Notification type for unconfigured-agent alerts ─────────────────────
-- A new notification type so the admin alert ("Agent X received a lead but
-- has no default drip configured") can be styled distinctly in the UI.
-- agent_notifications.type is a free-form text column today, so nothing to
-- alter — this comment documents the new vocabulary.
--   type='lead'         — agent received a new lead (existing)
--   type='setup_needed' — agent needs to configure something (new)
