-- ═════════════════════════════════════════════════════════════════════════════
-- 0047 — Deal announcements: optional detail rows
--
-- Adds email_blasts.hidden_facts: the detail rows an agent switched OFF for a
-- send, as a jsonb array of field keys ('address','assetType','units','price',
-- 'terms' — ANNOUNCEMENT_FACT_FIELDS in src/lib/dealAnnouncement.js).
--
-- WHY IT IS STORED ON THE BLAST rather than being a wording choice the agent
-- makes in the body. The driving case is a property under contract: the address
-- and unit count are the pitch, the number it went under contract at is the
-- seller's business. Withholding it has to be a property of the SEND, because
--   • a blast is sent in paced batches and resumed after a timeout or the next
--     day, and every batch has to withhold exactly what the first one did; and
--   • "did this announcement publish the contract price?" is an audit question
--     about a message that has already left, answerable only from the record.
--
-- Empty array = the previous behavior (every row the property has a value for),
-- so existing blasts read back exactly as they rendered.
--
-- Additive and idempotent.
-- ═════════════════════════════════════════════════════════════════════════════

alter table email_blasts
  add column if not exists hidden_facts jsonb not null default '[]'::jsonb;

-- ─── Verification (read-only) ────────────────────────────────────────────────
-- select column_name, data_type, column_default from information_schema.columns
--  where table_name = 'email_blasts' and column_name = 'hidden_facts';
-- select id, deal_status, hidden_facts from email_blasts order by created_at desc limit 5;
