-- ─────────────────────────────────────────────────────────────────────────────
-- 0036 — Microsoft Graph power features: inbound mail matching, contact
-- enrichment, draft-mode send, free/busy availability
--
-- Two small additions support these (contact enrichment, draft-mode send, and
-- free/busy are all read-only or reuse existing columns — no schema changes
-- needed for them):
--
--   • ms_graph_connections.mail_delta_link — Microsoft Graph delta query
--     cursor, one per connected agent. Lets the nightly inbox-sync task
--     (api/_lib/inboxSync.js, api/cron.js ?task=inbox-sync) ask Graph for only
--     the mail that changed since the last run instead of re-scanning the
--     whole inbox every time. Null until an agent's first sync.
--
--   • email_messages.status gains 'received' — the value used for an inbound
--     message matched to a contact by inbox-sync. 'sent'/'failed'/'draft'
--     described only outbound outcomes; an inbound row was never "sent" by
--     this CRM, so reusing 'sent' there would be misleading in the UI.
-- ─────────────────────────────────────────────────────────────────────────────

alter table ms_graph_connections add column if not exists mail_delta_link text;

alter table email_messages drop constraint if exists email_messages_status_check;
alter table email_messages add constraint email_messages_status_check
  check (status in ('sent', 'failed', 'draft', 'received'));
