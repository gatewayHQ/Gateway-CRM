-- Migration 0064 — Remember that the signed copy was emailed
-- ===========================================================================
-- Agents stopped getting the "✅ Signed:" email with the executed PDF.
--
-- The BoldSign webhook only sent it from the ONE delivery that moved the row
-- to 'completed'. Anything else that got there first took the email with it:
--   • an agent pressing Refresh status (or any packet action, which re-reads
--     BoldSign) after the last signature and before the webhook landed;
--   • a first delivery that set 'completed' and then ran out of function time
--     archiving a large packet — BoldSign redelivers, but the redelivery no
--     longer "made the transition", so it archived and stayed silent.
--
-- `signed_copy_emailed_at` is the email's own ledger. The webhook claims it
-- with a compare-and-set (`where signed_copy_emailed_at is null`) on any
-- completion delivery, so exactly one delivery sends, whichever it is.
--
-- Backfill: every row already completed is stamped, so a stray redelivery for
-- an old packet cannot email agents about a document signed weeks ago.
--
-- Safe to re-run. The app works before this runs (it falls back to the old
-- behaviour), so code and migration can ship in either order.

alter table boldsign_documents
  add column if not exists signed_copy_emailed_at timestamptz;

update boldsign_documents
   set signed_copy_emailed_at = coalesce(completed_at, now())
 where status = 'completed'
   and signed_copy_emailed_at is null;
