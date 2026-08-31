-- ─────────────────────────────────────────────────────────────────────────────
-- 0043 — Gated Offering Memorandum download on QR landing pages
--
-- A QR code on a mailer, sign rider or flyer gets someone to the landing page;
-- what actually gets a broker on the phone is the Offering Memorandum. Until
-- now the only way to hand one over was a public link (Dropbox, a raw storage
-- URL) pasted into the page — which means the OM circulates freely and the
-- broker never learns who read it. That is the wrong trade: the OM is the most
-- valuable thing on the page and the cheapest thing to ask for a name in
-- exchange for.
--
-- This migration adds the storage and the audit trail behind a GATED download:
--
--   • `campaign-oms` — a PRIVATE storage bucket. Private is the whole point:
--     an object in here has no working public URL, so the only way to read an
--     OM is a short-lived signed URL that api/campaigns.js mints AFTER the
--     visitor has handed over name + phone + email. A public bucket would make
--     the gate decorative — one shared link and it is bypassed forever.
--
--   • `mailing_om_requests` — one row per person who unlocked an OM on a
--     landing page, with the contact details they gave, the scan visit that
--     brought them (so an OM read is attributable to a specific piece of mail),
--     and a download counter. This is the "who is looking at my deal" list.
--
--   • `mailing_leads.om_requested` — a flag on the lead the gate creates, so
--     the Leads tab can tell an OM unlock apart from a plain "call me" form
--     fill. An OM reader is a materially warmer lead and should look like one.
--
-- Additive and idempotent. Campaigns with no OM attached are untouched and
-- render exactly as before.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Private OM bucket ────────────────────────────────────────────────────
-- Agents upload straight from the landing-page builder (authenticated), so the
-- insert policy is `to authenticated`. There is deliberately NO public select
-- policy: reads happen through service-key signed URLs only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-oms',
  'campaign-oms',
  false,      -- PRIVATE. See the header — a public bucket defeats the gate.
  52428800,   -- 50 MB per file; an OM with rent rolls and photos runs large
  array['application/pdf']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
      and policyname='campaign-oms: authenticated upload'
  ) then
    create policy "campaign-oms: authenticated upload"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'campaign-oms');
  end if;
end $$;

-- Signed-in agents can list/preview what they uploaded (the builder shows the
-- attached file and lets them replace it). Anon is NOT granted select.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
      and policyname='campaign-oms: authenticated read'
  ) then
    create policy "campaign-oms: authenticated read"
      on storage.objects for select to authenticated
      using (bucket_id = 'campaign-oms');
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
      and policyname='campaign-oms: authenticated delete'
  ) then
    create policy "campaign-oms: authenticated delete"
      on storage.objects for delete to authenticated
      using (bucket_id = 'campaign-oms');
  end if;
end $$;

-- ─── 2. Who unlocked the OM ──────────────────────────────────────────────────
create table if not exists mailing_om_requests (
  id            uuid primary key default uuid_generate_v4(),
  mailing_id    uuid not null references mailings(id) on delete cascade,
  lead_id       uuid references mailing_leads(id) on delete set null,
  contact_id    uuid references contacts(id) on delete set null,
  -- Snapshot of what they typed into the gate. Kept here as well as on the
  -- lead/contact so the OM audit trail stays truthful even if the contact is
  -- later merged, renamed or deleted.
  name          text,
  email         text,
  phone         text,
  om_path       text,                       -- object key inside `campaign-oms`
  om_filename   text,
  visit_id      text,                       -- ties the unlock back to a scan
  scan_id       uuid references mailing_scans(id) on delete set null,
  ip_hash       text,
  user_agent    text,
  download_count integer default 1,         -- bumped when they re-unlock
  created_at    timestamptz default now(),
  last_download_at timestamptz default now()
);

create index if not exists mailing_om_requests_mailing_idx on mailing_om_requests(mailing_id, created_at desc);
create index if not exists mailing_om_requests_contact_idx on mailing_om_requests(contact_id);
create index if not exists mailing_om_requests_visit_idx   on mailing_om_requests(visit_id) where visit_id is not null;
-- Re-unlocking from the same browser session must not create a second row —
-- it is the same person clicking download twice. This composite is the
-- ON CONFLICT target the API upserts against.
create unique index if not exists mailing_om_requests_dedupe
  on mailing_om_requests(mailing_id, email) where email is not null;

alter table mailing_om_requests enable row level security;
do $$ begin
  -- Reads are for signed-in agents (the Campaigns UI). The public gate writes
  -- through the service-key API, which bypasses RLS — so no anon policy.
  if not exists (
    select 1 from pg_policies
    where tablename='mailing_om_requests' and policyname='om_requests_authenticated_read'
  ) then
    create policy "om_requests_authenticated_read" on mailing_om_requests
      for select to authenticated using (true);
  end if;
end $$;

comment on table mailing_om_requests is
  'One row per person who unlocked a campaign''s Offering Memorandum on a /lp/* landing page, with the name/phone/email they exchanged for it and the scan visit that brought them. Written only by api/campaigns.js (action=om_request) on the service key.';

-- ─── 3. Flag the lead the gate created ───────────────────────────────────────
alter table mailing_leads add column if not exists om_requested boolean default false;

comment on column mailing_leads.om_requested is
  'True when this lead came from the Offering Memorandum download gate rather than a plain contact form — a materially warmer lead. See mailing_om_requests for the full unlock trail.';

-- ─── 4. Make the landing-page contact sources legal ──────────────────────────
-- A latent bug the OM gate would otherwise inherit: api/campaigns.js has always
-- tagged a landing-page capture with `contacts.source = 'mailing-landing'`, and
-- that value is not in the column's CHECK. The insert is wrapped in a
-- best-effort try/catch (a lead must never be lost to a failed contact mirror),
-- so the violation was silent — the lead landed, the CONTACT did not, and the
-- person a QR scan produced never appeared in the CRM.
--
-- Widening the constraint is the fix that keeps the existing values meaningful
-- ('mailing-landing' says exactly where the person came from, which 'website'
-- does not). 'om-download' joins it for the gate. Every previously valid value
-- is preserved, so no existing row can be invalidated by this.
do $$ begin
  alter table contacts drop constraint if exists contacts_source_check;
  alter table contacts add constraint contacts_source_check
    check (source in (
      'referral','website','open house','social','cold call','team','paid service','other',
      'mailing-landing',   -- captured on a QR landing page form
      'om-download'        -- unlocked a campaign's offering memorandum
    ));
exception when others then null; end $$;
