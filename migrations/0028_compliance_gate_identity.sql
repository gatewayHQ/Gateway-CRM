-- ─────────────────────────────────────────────────────────────────────────────
-- 0028 — Closing gate: envelope identity + state-required forms
--
-- PROBLEM 1 — the signature check counted instead of identifying.
-- src/lib/compliance.js proved signatures with:
--     if (signSteps.length > envelopes.filter(e => e.status==='completed').length)
-- A deal with three sign-steps and three completed copies of the SAME
-- disclosure passed the gate. Nothing tied a step to the envelope that
-- satisfied it.
--
-- `satisfied_by` makes that link explicit. It is nullable: legacy steps carry
-- no link, and for those the gate now does distinct-envelope matching instead
-- (each completed envelope can satisfy at most one step), which closes the
-- three-copies hole without requiring a backfill.
--
-- PROBLEM 2 — multi-state compliance was a human habit.
-- form_packets already carries (state, transaction_type) and a
-- boldsign_template_id, and boldsign_documents records the
-- boldsign_template_id it was built from (migration 0026). Nothing ever
-- compared them, so an Iowa listing could close without an executed Iowa
-- listing agreement. `required` marks the packets a deal of that
-- (state, transaction_type) cannot close without; the gate joins them to the
-- deal's completed envelopes on boldsign_template_id — real identity, no new
-- join table.
--
-- Both columns default to the pre-migration behaviour (null link, not
-- required), so applying this alone changes no deal's gate status. Marking a
-- packet required in the Form Library is the deliberate act that turns
-- enforcement on, state by state.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Which envelope satisfies which sign-step ──────────────────────────────
alter table transaction_steps
  add column if not exists satisfied_by uuid references boldsign_documents(id) on delete set null;

comment on column transaction_steps.satisfied_by is
  'The boldsign_documents row that satisfies this sign-step. Null on legacy '
  'rows, where the closing gate falls back to distinct-envelope matching.';

create index if not exists idx_txn_steps_satisfied_by
  on transaction_steps(satisfied_by) where satisfied_by is not null;

-- ── 2. Which packets a state actually requires ───────────────────────────────
alter table form_packets
  add column if not exists required boolean not null default false;

comment on column form_packets.required is
  'When true, a deal in this (state, transaction_type) cannot reach closed '
  'until a completed envelope built from this packet exists on the deal.';

-- The gate looks up required packets by (state, transaction_type) on every
-- deal load; only template-linked, active rows can ever be satisfied.
create index if not exists idx_form_packets_required
  on form_packets(state, transaction_type)
  where required and active and boldsign_template_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY
-- ─────────────────────────────────────────────────────────────────────────────
-- Columns exist:
--   select column_name, data_type, column_default from information_schema.columns
--   where (table_name, column_name) in
--         (('transaction_steps','satisfied_by'), ('form_packets','required'));
--
-- Nothing is enforced until a packet is marked required (expect 0 on a fresh
-- apply — this is what makes the migration behaviour-neutral):
--   select state, transaction_type, count(*) from form_packets
--   where required and active and boldsign_template_id is not null
--   group by 1, 2;
--
-- Which required packets a given deal is still missing:
--   select fp.name
--   from deals d
--   join form_packets fp
--     on fp.state = d.comp_data->>'state'
--    and fp.transaction_type = d.comp_data->>'transaction_type'
--   where d.id = '<deal-id>'
--     and fp.required and fp.active and fp.boldsign_template_id is not null
--     and not exists (
--       select 1 from boldsign_documents bd
--       where bd.deal_id = d.id
--         and bd.status = 'completed'
--         and bd.boldsign_template_id = fp.boldsign_template_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- drop index if exists idx_form_packets_required;
-- drop index if exists idx_txn_steps_satisfied_by;
-- alter table form_packets      drop column if exists required;
-- alter table transaction_steps drop column if exists satisfied_by;
