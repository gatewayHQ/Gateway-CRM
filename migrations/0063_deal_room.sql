-- ─────────────────────────────────────────────────────────────────────────────
-- 0063 — Deal Room on QR landing pages
--
-- The OM gate (0045) becomes a Deal Room: one registration unlocks the
-- underwriting numbers, the full gallery, every diligence document and a dated
-- list of updates, and keeps the visitor signed in on their device. This adds
-- what that needs to remember:
--
--   • optional qualifiers the registration form now asks for — mailing
--     address, "I am a principal / broker / lender", 1031 exchange — on both the
--     lead and the registration row;
--   • a visit counter on the registration, so "came back after the update
--     email" is visible to the agent;
--   • `deal_room_events` — enter / return / document / update-email, the trail
--     behind "who opened the new financials";
--   • the `campaign-oms` bucket accepts the formats rent rolls and T-12s really
--     arrive in (Excel, CSV, Word, images, zip), not just PDF.
--
-- Additive and idempotent. A campaign that never adds a Deal Room document
-- behaves exactly as before.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Qualifiers on the lead and the registration ─────────────────────────
alter table mailing_leads add column if not exists mailing_address text;
alter table mailing_leads add column if not exists buyer_role      text;
alter table mailing_leads add column if not exists is_1031         boolean;

alter table mailing_om_requests add column if not exists mailing_address text;
alter table mailing_om_requests add column if not exists buyer_role      text;
alter table mailing_om_requests add column if not exists is_1031         boolean;
alter table mailing_om_requests add column if not exists visit_count     integer default 1;
alter table mailing_om_requests add column if not exists last_visit_at   timestamptz default now();

comment on column mailing_om_requests.visit_count is
  'Times this registered visitor opened the Deal Room (first entry = 1). Bumped by api/campaigns.js action=deal_room.';

-- ─── 2. Deal Room activity trail ─────────────────────────────────────────────
create table if not exists deal_room_events (
  id            uuid primary key default uuid_generate_v4(),
  mailing_id    uuid not null references mailings(id) on delete cascade,
  om_request_id uuid references mailing_om_requests(id) on delete cascade,
  email         text,
  kind          text not null check (kind in ('enter','return','document','update_email')),
  doc_id        text,     -- landing_config document id for kind='document'
  update_id     text,     -- landing_config update id for kind='update_email'
  created_at    timestamptz default now()
);

create index if not exists deal_room_events_mailing_idx on deal_room_events(mailing_id, created_at desc);
create index if not exists deal_room_events_request_idx on deal_room_events(om_request_id);
-- One "New in the Deal Room" email per person per update, however many times
-- the agent presses Send (a long list is sent across several calls).
create unique index if not exists deal_room_events_update_once
  on deal_room_events(mailing_id, email, update_id) where kind = 'update_email';

alter table deal_room_events enable row level security;
do $$ begin
  -- Signed-in agents read it in the Campaigns drawer. Every write is the
  -- service-key API, which bypasses RLS — so no insert policy for anyone.
  if not exists (
    select 1 from pg_policies
    where tablename='deal_room_events' and policyname='deal_room_events_authenticated_read'
  ) then
    create policy "deal_room_events_authenticated_read" on deal_room_events
      for select to authenticated using (true);
  end if;
end $$;

comment on table deal_room_events is
  'Deal Room activity on a /lp/* landing page: registrations, return visits, document opens and update emails sent. Written only by api/campaigns.js on the service key.';

-- ─── 3. Diligence documents are not all PDFs ─────────────────────────────────
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-excel',
     'text/csv',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/msword',
     'image/jpeg', 'image/png', 'image/webp',
     'application/zip', 'application/x-zip-compressed'
   ]
 where id = 'campaign-oms';
