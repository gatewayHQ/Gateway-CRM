-- ═════════════════════════════════════════════════════════════════════════════
-- 0048 — Mass email: pasted-list recipients, address-level opt-out, tracking
--
-- THE PROBLEM. The audience step could only mail contacts. An agent pasting a
-- 122-row county roll into the wizard was told "122 addresses · 0 matched a
-- contact · 122 new" and then mailed the 12 people the asset-type filter found.
-- The list did nothing. The only offered fix — import all 122 as contacts — is
-- worse than the problem: it buries a working contact book under addresses
-- nobody has qualified.
--
-- So a blast recipient no longer has to be a contact. email_blast_recipients
-- already snapshotted the address and name and already allowed a null
-- contact_id, so the row shape was ready; what was missing is everything that
-- hung off the contact record.
--
-- What this adds:
--   • email_suppressions                — opt-out keyed by ADDRESS, not contact
--   • email_blast_recipients.source     — 'contact' or 'list'
--   • email_blast_recipients tracking   — opened / unsubscribed / replied
--   • email_blasts roll-up counters     — for the per-send report
--
-- WHY SUPPRESSION IS ITS OWN TABLE, keyed by address. Until now an opt-out was
-- contacts.email_opt_out, which cannot represent "this mailbox asked not to be
-- mailed" when no contact owns that mailbox. It also quietly under-protected
-- the people it did cover: the same human on a second address, or re-imported
-- as a new row, came back mailable. An address-level list is the honest unit —
-- the recipient opted out a mailbox, not a database row — and it now gates
-- every send, contact or list.
--
-- Additive and idempotent.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── email_suppressions ──────────────────────────────────────────────────────
-- One row per address that must not be mailed. Deliberately NOT scoped to an
-- agent or a blast: an opt-out is global, and "he unsubscribed from Daniel's
-- list but not mine" is not a distinction a recipient would recognise.
create table if not exists email_suppressions (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  -- 'unsubscribed' (they clicked the link), 'manual' (an agent was asked
  -- directly), 'bounced' (the address is dead). Free text rather than a CHECK
  -- so a new reason needs no migration; the app writes the three above.
  reason          text not null default 'unsubscribed',
  -- Provenance, all nullable: which send they left from, which recipient row
  -- carried the link, and the contact record if the address had one. A
  -- suppression stands on its own without any of them.
  blast_id        uuid references email_blasts(id)             on delete set null,
  recipient_id    uuid references email_blast_recipients(id)   on delete set null,
  contact_id      uuid references contacts(id)                 on delete set null,
  unsubscribed_at timestamptz not null default now(),
  created_at      timestamptz default now()
);

-- Addresses are stored LOWER-CASED (api/campaigns.js lower-cases before every
-- write, and the CHECK below makes that an invariant rather than a habit), so a
-- plain unique index on the column does two jobs at once: it de-duplicates
-- case-insensitively, AND it is a valid ON CONFLICT target for the upsert the
-- unsubscribe path uses. A unique index on lower(email) would do only the
-- first — Postgres cannot infer a conflict target from a column name when the
-- index is on an expression, so every second click on an opt-out link would
-- have raised "no unique or exclusion constraint matching the ON CONFLICT
-- specification" and shown the recipient an error instead of confirming they
-- were unsubscribed. Same reasoning as mailing_subscribers_unique.
alter table email_suppressions drop constraint if exists email_suppressions_lower_check;
alter table email_suppressions add  constraint email_suppressions_lower_check
  check (email = lower(email));
create unique index if not exists uq_email_suppressions_email
  on email_suppressions(email);
create index if not exists idx_email_suppressions_blast on email_suppressions(blast_id);

-- ─── email_blast_recipients: where the row came from, and what happened ──────
alter table email_blast_recipients
  add column if not exists source text not null default 'contact';
-- 'contact' — resolved from the contact book by the audience filter or a hand
-- add. 'list' — an address off a pasted/uploaded list with no contact record.
-- Kept on the row because it changes what the CRM can tell you afterwards: a
-- 'contact' send lands on somebody's timeline, a 'list' send exists only here.
alter table email_blast_recipients
  drop constraint if exists email_blast_recipients_source_check;
alter table email_blast_recipients
  add  constraint email_blast_recipients_source_check check (source in ('contact','list'));

-- Opens. first_opened_at is kept separately from last_opened_at because "did
-- this land?" and "are they still coming back to it?" are different questions,
-- and a re-open must not overwrite the answer to the first.
alter table email_blast_recipients add column if not exists first_opened_at timestamptz;
alter table email_blast_recipients add column if not exists last_opened_at  timestamptz;
alter table email_blast_recipients add column if not exists open_count      integer not null default 0;

-- The opt-out and the reply, stamped on the row that carried the message.
alter table email_blast_recipients add column if not exists unsubscribed_at timestamptz;
alter table email_blast_recipients add column if not exists replied_at      timestamptz;
alter table email_blast_recipients add column if not exists reply_subject   text;

-- Reply matching (api/_lib/inboxSync.js) looks recipients up by address across
-- recent sends, so the address needs to be indexed on its own.
create index if not exists idx_blast_recipients_email
  on email_blast_recipients(lower(email));

-- ─── email_blasts: roll-up counters for the report ───────────────────────────
-- Denormalised the same way sent_count / failed_count already are, and
-- recomputed from the recipient rows rather than incremented — a retried or
-- interrupted batch must not be able to double-count.
alter table email_blasts add column if not exists opened_count       integer not null default 0;
alter table email_blasts add column if not exists replied_count      integer not null default 0;
alter table email_blasts add column if not exists unsubscribed_count integer not null default 0;
-- How many of this send's recipients came off a pasted list, so the report can
-- say "122 from Marshalltown_Name_Email.csv" rather than leaving an agent to
-- work out why the number is bigger than their contact book.
alter table email_blasts add column if not exists list_recipient_count integer not null default 0;
-- The file or paste the list came from, purely so the send is recognisable
-- later. Null for a send built only from contacts.
alter table email_blasts add column if not exists list_source text;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- A suppression is org-wide fact, not an agent's private record: every agent
-- needs to see that an address is off-limits, and the UI has to be able to say
-- WHY somebody was skipped. Reads are open to any authenticated user for that
-- reason; writes stay with the service key, because an agent must not be able
-- to delete somebody's opt-out.
alter table email_suppressions enable row level security;

drop policy if exists email_suppressions_read on email_suppressions;
create policy email_suppressions_read on email_suppressions for select to authenticated
  using (true);

-- ─── Verification (read-only) ────────────────────────────────────────────────
-- select count(*) from email_suppressions;
-- select column_name from information_schema.columns
--  where table_name = 'email_blast_recipients'
--    and column_name in ('source','first_opened_at','open_count','unsubscribed_at','replied_at');
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conname = 'email_blast_recipients_source_check';
