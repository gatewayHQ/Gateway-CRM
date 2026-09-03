-- Migration 0044 — Saved work-in-progress on a signature template
-- ===========================================================================
-- WHY
--   "Prepare from Template" is where an agent decides what an agreement says:
--   who signs it, which boxes are ticked (the representation, the term, the
--   policy — these are the terms of the contract, not decoration), the client's
--   name where the deal's own record needs correcting, an expiry, a copy to the
--   lender.
--
--   None of it was stored anywhere. It lived in React state, and closing the
--   modal — the X, Escape, the backdrop, Cancel, a browser reload — discarded
--   every one of those decisions with no warning that anything was being lost.
--   Reopening the same template on the same deal re-seeded from the deal and the
--   agent typed it all again.
--
--   The reported symptom was exactly that: checkboxes and a buyer name filled
--   in, X out of the screen, reopen, gone. Agents need to work on a packet that
--   is not needed yet, leave it, and come back to it.
--
-- WHAT
--   `deal_template_drafts` — one row per (deal, BoldSign template), holding the
--   prepare screen's own state: signer rows, prefilled field values, the
--   tri-state tick boxes, the packet's declared terms, and the send options
--   BoldSign fixes at creation time. Shape defined by serializeTemplateWork()
--   in src/lib/services/templateWork.js.
--
--   `document_id` is the BoldSign draft this work last produced. The screen also
--   saves a real, filled draft to the Signatures tab on every save — this column
--   is how the next save supersedes that draft instead of leaving a second
--   half-finished row behind.
--
-- WHY NOT deal_field_layouts
--   That table records where fields SIT on a document, read back out of BoldSign
--   after an editing session. This records what the agent ANSWERED on the CRM's
--   own screen, before any document exists. Different lifecycle, different
--   writer, and a layout capture would happily overwrite one with the other.
--
-- WHY NOT form_packets
--   `form_packets` rows are brokerage-wide and compliance-relevant. One agent's
--   in-progress answers on one deal must never rewrite the form every other deal
--   sends from. Same reasoning as migration 0026.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

create table if not exists deal_template_drafts (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid not null references deals(id) on delete cascade,
  -- The BoldSign template these answers belong to. NOT NULL with an empty-string
  -- default for the same reason as deal_field_layouts.template_id: the unique key
  -- below is (deal_id, template_id), and Postgres treats every NULL as distinct —
  -- a nullable column would add a row per save instead of updating the one there.
  template_id   text not null default '',
  template_name text,
  -- { version, signers: { "1": { name, email } }, values: { fieldId: value },
  --   selections: { fieldId: true|false|null }, panelState: { groupKey: … },
  --   inOrder, subject, message, cc: [], expiryDays }
  -- JSON because it is read and written whole, and because the field ids in it
  -- belong to a template that can change shape under a save — the restore is a
  -- merge onto a freshly seeded screen (applySavedTemplateWork), never a
  -- replacement of it.
  work          jsonb not null default '{}'::jsonb,
  -- How many of the packet's blanks carry a value, so the screen and the
  -- Signatures tab agree about how filled-in this packet is.
  field_count   integer not null default 0,
  -- The BoldSign draft this work last produced, if it produced one.
  document_id   text,
  saved_by      uuid references agents(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create unique index if not exists idx_deal_template_drafts_key
  on deal_template_drafts(deal_id, template_id);

-- Reopening the draft from the Signatures tab looks it up by document.
create index if not exists idx_deal_template_drafts_document
  on deal_template_drafts(document_id)
  where document_id is not null;

-- ── RLS — a deal-child table, scoped exactly like the deal it hangs on ───────
alter table deal_template_drafts enable row level security;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_visible_deal_ids') then
    drop policy if exists deal_template_drafts_deal_scope on deal_template_drafts;
    create policy deal_template_drafts_deal_scope on deal_template_drafts for all to authenticated
      using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
      with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));
  else
    -- Database predating the scoped-RLS helpers: fall back to authenticated
    -- access rather than leaving the table unreadable (0002/0011 tighten it).
    drop policy if exists deal_template_drafts_all on deal_template_drafts;
    create policy deal_template_drafts_all on deal_template_drafts for all to authenticated
      using (true) with check (true);
  end if;
end $$;
