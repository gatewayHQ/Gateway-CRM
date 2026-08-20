-- ═════════════════════════════════════════════════════════════════════════════
-- 0039 — Mass email / deal announcements
--
-- One-time, agent-initiated bulk sends through the agent's OWN connected
-- Microsoft 365 mailbox (migration 0034). Not a drip sequence, and not a
-- third-party bulk mail service: every message is a personalised /me/sendMail
-- from the agent, logged into the CRM exactly like a one-off send is.
--
-- What this adds:
--   • email_blasts             — one row per send (audience, property, content)
--   • email_blast_recipients   — one row per contact in that send
--   • email_messages.blast_id  — provenance for messages produced by a blast
--   • contacts.email_opt_out   — a contact who has asked not to be included
--   • templates.category       — widened to accept 'deal-announcement'
--
-- WHY A ROW PER RECIPIENT. A blast is not one API call, it is N calls to Graph,
-- each of which can independently fail, and Graph write paths deliberately do
-- not retry (api/_lib/msGraph.js) because a resent email is worse than a
-- surfaced error. Per-recipient status is therefore the send cursor: a batch
-- that dies halfway through leaves 'sent' rows sent and 'pending' rows pending,
-- so resuming picks up exactly where it stopped and no contact is ever mailed
-- twice. It is also the audit trail the announcement feature is required to
-- keep — who received which announcement about which property, and when.
--
-- Additive and idempotent; nothing existing changes behavior until the app
-- deploy that uses these tables.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── contacts: email opt-out ─────────────────────────────────────────────────
-- Excluded from every audience by src/lib/audience.js. Distinct from
-- mailing_subscribers.status, which is about a specific QR/landing-page mailing
-- list; this is the contact record itself saying "not for bulk email".
alter table contacts add column if not exists email_opt_out boolean not null default false;

-- ─── templates: the announcement category ────────────────────────────────────
-- The category list is mirrored in src/lib/enums.js (TEMPLATE_CATEGORIES) and
-- asserted against this constraint by scripts/check-enums.mjs.
alter table templates drop constraint if exists templates_category_check;
alter table templates add  constraint templates_category_check
  check (category in ('intro','follow-up','offer','closing','nurture','deal-announcement'));

-- ─── email_blasts ────────────────────────────────────────────────────────────
create table if not exists email_blasts (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid not null references agents(id)     on delete cascade,
  property_id      uuid          references properties(id) on delete set null,
  template_id      uuid          references templates(id)  on delete set null,
  -- The announcement headline ('closed', 'under-contract', …). Deliberately its
  -- own vocabulary, not properties.status or deals.stage — an agent can
  -- announce "Just Closed" without the property record having been moved, and
  -- "Price Reduced" is not a status at all. Free text (no CHECK) so a new
  -- announcement type doesn't need a migration; the app offers a fixed list
  -- (DEAL_ANNOUNCEMENT_STATUSES in src/lib/dealAnnouncement.js).
  deal_status      text,
  subject          text not null,
  -- The body WITH its {{tokens}} intact — this is the reproducible source of
  -- the send, not the rendered result. Per-recipient HTML lands on each
  -- email_messages row instead.
  body             text not null default '',
  photo_url        text,                       -- resolved hero image (property default or per-send override)
  terms            text,                       -- free-text price/terms note
  custom_message   text,                       -- the agent's free-text block
  -- { assetTypes: [...], sides: ['buyer','seller'], manual: { added: [], removed: [] } }
  -- Stored so the recipient list is reproducible from the record alone, rather
  -- than only ever having existed in the wizard that built it.
  audience         jsonb not null default '{}',
  status           text not null default 'draft'
                     check (status in ('draft','sending','sent','failed','cancelled')),
  recipient_count  integer not null default 0,
  sent_count       integer not null default 0,
  failed_count     integer not null default 0,
  skipped_count    integer not null default 0,
  last_error       text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz default now()
);
create index if not exists idx_email_blasts_agent    on email_blasts(agent_id, created_at desc);
create index if not exists idx_email_blasts_property on email_blasts(property_id, created_at desc);
create index if not exists idx_email_blasts_status   on email_blasts(status) where status in ('draft','sending');

-- ─── email_blast_recipients ──────────────────────────────────────────────────
create table if not exists email_blast_recipients (
  id               uuid primary key default gen_random_uuid(),
  blast_id         uuid not null references email_blasts(id) on delete cascade,
  contact_id       uuid          references contacts(id)     on delete set null,
  -- Snapshotted rather than joined: the address this send actually went to,
  -- even if the contact's email is edited (or the contact deleted) afterwards.
  email            text not null,
  first_name       text,
  last_name        text,
  status           text not null default 'pending'
                     check (status in ('pending','sent','failed','skipped')),
  error_message    text,
  skip_reason      text,                       -- 'Opted out of email', 'No email on file', …
  email_message_id uuid references email_messages(id) on delete set null,
  sent_at          timestamptz,
  created_at       timestamptz default now()
);
-- The double-send guard. One row per (blast, contact) means a retried batch
-- cannot insert a second copy of a recipient, and the send loop only ever
-- claims rows still in 'pending'.
create unique index if not exists uq_blast_recipient_contact
  on email_blast_recipients(blast_id, contact_id) where contact_id is not null;
-- Excludes 'skipped' rows: two contacts sharing one address both get a row (one
-- mailed, one skipped as a duplicate), and the skipped one keeps the real
-- address for the audit trail rather than a mangled unique variant.
create unique index if not exists uq_blast_recipient_email
  on email_blast_recipients(blast_id, lower(email)) where status <> 'skipped';
create index if not exists idx_blast_recipients_blast   on email_blast_recipients(blast_id, status);
create index if not exists idx_blast_recipients_contact on email_blast_recipients(contact_id, sent_at desc);

-- ─── email_messages: which blast produced this message ───────────────────────
alter table email_messages add column if not exists blast_id uuid references email_blasts(id) on delete set null;
create index if not exists idx_email_messages_blast on email_messages(blast_id) where blast_id is not null;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- A blast is the sending agent's own record; team peers and admins see it under
-- the same visibility model as the rest of the CRM. Writes are the service
-- key's (api/email-send.js) — an agent must not be able to hand-edit sent_count
-- or repoint a recipient row after the fact.
alter table email_blasts           enable row level security;
alter table email_blast_recipients enable row level security;

drop policy if exists email_blasts_scope on email_blasts;
create policy email_blasts_scope on email_blasts for select to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or agent_id in (select app_visible_agent_ids('contacts'))
  );

-- Recipients follow the parent blast, restated rather than relying on nested
-- RLS — the same shape as activities_scope / lead_property_views_scope.
drop policy if exists email_blast_recipients_scope on email_blast_recipients;
create policy email_blast_recipients_scope on email_blast_recipients for select to authenticated
  using (exists (
    select 1 from email_blasts b
     where b.id = email_blast_recipients.blast_id
       and (
         app_is_admin()
         or b.agent_id = app_current_agent_id()
         or b.agent_id in (select app_visible_agent_ids('contacts'))
       )
  ));

-- ─── Verification (read-only) ────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where table_name = 'contacts' and column_name = 'email_opt_out';
-- select count(*) from email_blasts;
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conname = 'templates_category_check';
