-- ─────────────────────────────────────────────────────────────────────────────
-- 0038 — Contact-level email correspondence (Outlook "Emails" tab)
--
-- The contact panel's Outlook feature used to be "Enrich from Outlook", which
-- searched the agent's Outlook CONTACTS address book (/me/contacts). For a
-- contact like Janet_Hala@yahoo.com — a real correspondent who was never saved
-- as an Outlook Contact — that search legitimately returns nothing, which is
-- why it reported "No matching Outlook contact found". Agents don't want the
-- address book; they want the MAIL. The new panel queries /me/messages for
-- everything ever exchanged with the contact's address, in both directions.
--
-- Two changes support that:
--
--   • email_messages gains the columns a mirrored Graph message needs that an
--     outbound CRM send never did — who it was FROM, a deep link back into
--     Outlook, whether it carried attachments — plus `source`, which separates
--     rows this CRM itself sent (source='crm') from rows mirrored out of the
--     mailbox for the history panel (source='graph'). Without that split there
--     is no way to tell a send the CRM is responsible for from a copy of one it
--     merely observed.
--
--   • contact_email_sync — one row per (contact, agent), holding the Graph
--     paging cursor for that contact's history and when it was last refreshed.
--     Lifetime history is paged, so the cursor is what makes "Load more"
--     resumable across requests, and last_synced_at is what stops the panel
--     from re-hitting Graph on every render (see MAIL_SYNC_TTL_MS in
--     api/_lib/contactMail.js).
--
-- Additive and idempotent. Nothing here changes existing behavior: the
-- /me/contacts enrichment path is untouched and still available on the Details
-- tab, since filling in a blank phone/company from the address book is a
-- separate, legitimate job.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── email_messages: mirrored-message columns ─────────────────────────────────
alter table email_messages add column if not exists from_address    text;
alter table email_messages add column if not exists from_name       text;
alter table email_messages add column if not exists web_link        text;
alter table email_messages add column if not exists has_attachments boolean not null default false;
alter table email_messages add column if not exists source          text not null default 'crm';

alter table email_messages drop constraint if exists email_messages_source_check;
alter table email_messages add constraint email_messages_source_check
  check (source in ('crm', 'graph'));

-- The history panel reads a contact's mail newest-first and needs to know which
-- Graph ids it already holds before mirroring a page. Both are covered by the
-- existing idx_email_messages_contact (contact_id, sent_at desc) and
-- uq_email_messages_graph_id, so no new index is needed here.

-- ── contact_email_sync ────────────────────────────────────────────────────────
-- Per (contact, agent) because the history is drawn from THAT agent's mailbox:
-- two agents who both correspond with the same contact have genuinely different
-- correspondence, different cursors, and different refresh clocks.
create table if not exists contact_email_sync (
  id                uuid primary key default uuid_generate_v4(),
  contact_id        uuid not null references contacts(id) on delete cascade,
  agent_id          uuid not null references agents(id)   on delete cascade,
  -- The address the history was pulled for. Kept so that editing a contact's
  -- email invalidates the cursor instead of silently paging the old address.
  email             text not null,
  -- Graph @odata.nextLink for the next OLDER page. Null once the mailbox has
  -- no more matches — i.e. lifetime history is fully mirrored.
  next_link         text,
  backfill_complete boolean not null default false,
  -- 'search' — both directions, mailbox-wide (the normal case).
  -- 'filter' — received-only fallback, for a mailbox that refuses $search.
  mode              text,
  message_count     integer not null default 0,
  last_synced_at    timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists uq_contact_email_sync_pair
  on contact_email_sync(contact_id, agent_id);

alter table contact_email_sync enable row level security;
-- Deliberately NO policy for `authenticated`/`anon` — deny by default, same as
-- ms_graph_connections. A Graph nextLink is a bearer-ish URL that encodes the
-- mailbox query; it has no business reaching a browser. Every read and write
-- goes through api/email-send.js (?action=outlook-messages) on the service key,
-- which returns only the sync FACTS the panel needs (last_synced_at, whether
-- more pages exist) and never the cursor itself.

drop trigger if exists contact_email_sync_updated_at on contact_email_sync;
create trigger contact_email_sync_updated_at
  before update on contact_email_sync
  for each row execute function set_updated_at();
