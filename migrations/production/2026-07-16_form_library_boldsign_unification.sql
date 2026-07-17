-- ─────────────────────────────────────────────────────────────────────────────
-- Gateway CRM — Form Library ↔ BoldSign template unification  (2026-07-16)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run (idempotent).
--
-- Form Library (form_packets) becomes the single CRM catalog for both plain
-- downloadable forms AND e-signature templates. An entry with
-- boldsign_template_id set is sendable from a deal's Signatures tab.
--
-- This does NOT drop boldsign_templates — it backfills form_packets from it so
-- already-registered templates (e.g. the SD Listing Agreement) keep working
-- once the app's read path switches over. Rows with a null `state` in the old
-- registry (meant "any state") are skipped — form_packets requires exactly one
-- state per entry; add those manually per state in Form Library.
-- ─────────────────────────────────────────────────────────────────────────────

alter table form_packets add column if not exists boldsign_template_id text;
alter table form_packets add column if not exists doc_type             text;
alter table form_packets add column if not exists field_tokens         jsonb default '[]';
alter table form_packets add column if not exists active               boolean default true;

create unique index if not exists uq_form_packets_boldsign_tid
  on form_packets(boldsign_template_id) where boldsign_template_id is not null;

insert into form_packets (state, transaction_type, name, description, boldsign_template_id, doc_type, field_tokens, active)
select
  bt.state,
  case
    when bt.doc_type ilike '%buyer%' then 'buyer'
    when bt.doc_type ilike '%lease%' then 'lease'
    else 'seller'
  end,
  bt.name,
  coalesce(bt.description, 'Migrated from the boldsign_templates registry.'),
  bt.template_id,
  bt.doc_type,
  bt.field_tokens,
  bt.active
from boldsign_templates bt
where bt.state is not null
  and not exists (
    select 1 from form_packets fp where fp.boldsign_template_id = bt.template_id
  );
