-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — Form Library ↔ BoldSign template unification
--
-- Form Library (form_packets) becomes the single CRM catalog for both plain
-- downloadable forms AND e-signature templates. An entry with
-- boldsign_template_id set is sendable from a deal's Signatures tab; BoldSign
-- stays the source of truth for the template's actual fields/roles.
--
-- The separate boldsign_templates registry (added in 0017) is NOT dropped —
-- it's superseded, not removed, so nothing breaks if a rollback is needed. This
-- migration backfills its rows into form_packets so existing registered
-- templates (e.g. the SD Listing Agreement) keep working after the app switches
-- its read path.
--
-- Idempotent: safe to re-run. The backfill only inserts rows that aren't
-- already present (matched by boldsign_template_id).
-- ─────────────────────────────────────────────────────────────────────────────

alter table form_packets add column if not exists boldsign_template_id text;
alter table form_packets add column if not exists doc_type             text;
alter table form_packets add column if not exists field_tokens         jsonb default '[]';
alter table form_packets add column if not exists active               boolean default true;

create unique index if not exists uq_form_packets_boldsign_tid
  on form_packets(boldsign_template_id) where boldsign_template_id is not null;

-- Backfill from boldsign_templates. Rows with a null `state` (meant "any state"
-- in the old registry — a concept form_packets' NOT NULL state doesn't support)
-- are intentionally skipped; register those manually per state in Form Library.
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
