-- ─────────────────────────────────────────────────────────────────────────────
-- 0059 — Mass Email: bounce tracking
--
-- "Failed" on a send only ever meant Microsoft refused to accept a message. A
-- message Microsoft accepted and the RECEIVING server then rejected — the
-- address doesn't exist, the mailbox is full — comes back later as a bounce
-- notice ("Undeliverable: …") in the agent's own inbox, and the send's report
-- went on calling that recipient "sent".
--
-- The nightly inbox sync (api/_lib/bounces.js) now reads those notices, and
-- stamps the recipient row they are about. Stored on the row, like opens and
-- replies, because a pasted-list recipient has no contact to hang it on.
--
-- The status column is deliberately left 'sent': Microsoft did send it, and
-- that is still the send cursor. A bounce is a later fact about the delivery.
--
-- Additive and idempotent. Until applied the sync skips bounce marking (it
-- cannot write the columns) and everything else runs as before.
-- ─────────────────────────────────────────────────────────────────────────────

alter table email_blast_recipients add column if not exists bounced_at    timestamptz;
-- A short human reason ("Address does not exist", "Mailbox full") and whether
-- it was permanent. Only a permanent bounce suppresses the address from future
-- sends — a full mailbox today is a working one next week.
alter table email_blast_recipients add column if not exists bounce_reason text;
alter table email_blast_recipients add column if not exists bounce_permanent boolean;

alter table email_blasts add column if not exists bounced_count integer not null default 0;
