-- Production bundle 2026-08-06 — Per-deal field layouts (BoldSign placements
-- that stick). Identical to migrations/0026_deal_field_layouts.sql; kept here
-- because production predates the numbered migrations (see README.md).
-- ===========================================================================
-- WHY
--   Field placement for a signature packet happens inside BoldSign's embedded
--   editor: the agent drags a second signer's name onto the right line, adds
--   initials at the bottom of page 3, types a label the form needs. That work is
--   real and it is deal-specific — 3820 Orleans Ave needs the co-seller's
--   initials in places the blank Iowa listing template knows nothing about.
--
--   It also used to evaporate. Placements live on the BoldSign DOCUMENT, so they
--   survived only as long as that one draft. Send it (or delete it) and the next
--   packet for the SAME deal came back from the template with the template's
--   default fields — the agent redid the same arranging, every time, from memory.
--
--   The shared template is the wrong place to save it back to: `form_packets`
--   entries are brokerage-wide and compliance-relevant, so one agent's per-deal
--   arrangement must not rewrite the form every other deal sends. Hence a
--   per-deal layout record, applied to the next document built for that deal.
--
-- WHAT
--   `deal_field_layouts` — one row per (deal, BoldSign template), holding the
--   normalized placement of every field: type, page, bounds, assignee role, and
--   value. Written by /api/boldsign `layout-capture` (read back from BoldSign's
--   own document properties, so it records what the agent actually left behind,
--   not what the app guessed) and by the Sent webhook, so a send always records
--   the final arrangement even if the browser vanished mid-flow.
--
--   `boldsign_documents.boldsign_template_id` — which template a tracked document
--   came from. Without it a captured layout has no key to hang on, and the next
--   send has no way to ask "is there a saved arrangement for THIS form?".
--
-- HOW THE APP USES IT
--   • Capture: the Signatures tab calls `layout-capture` when an editing session
--     ends (draft saved, sent, or closed); the webhook does the same on Sent.
--   • Apply: `template-embed-url` looks for a saved layout for (deal, template)
--     and pushes it onto the freshly created draft via BoldSign's /document/edit
--     before handing back the editor URL — so the packet opens already arranged.
--   • The Signatures tab reads this table directly (RLS-scoped) to tell the agent
--     a saved arrangement exists and how many fields it holds.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

-- ── Which template a tracked document came from ──────────────────────────────
alter table boldsign_documents add column if not exists boldsign_template_id text;

create index if not exists idx_boldsign_docs_template
  on boldsign_documents(boldsign_template_id)
  where boldsign_template_id is not null;

-- ── The layouts themselves ───────────────────────────────────────────────────
create table if not exists deal_field_layouts (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid not null references deals(id) on delete cascade,
  -- The BoldSign template this arrangement belongs to; '' for an ad-hoc (upload
  -- a PDF) send. NOT NULL with an empty-string default on purpose: the unique
  -- key below is (deal_id, template_id), and Postgres treats every NULL as
  -- distinct — a nullable column would let one deal accumulate a fresh ad-hoc
  -- row on every capture instead of updating the one it already has.
  template_id   text not null default '',
  document_name text,
  -- { signers: [{ signerRole, signerName, signerEmail, order, formFields: [...] }],
  --   commonFields: [...] } — see normalizeCapturedLayout() in api/boldsign.js
  -- for the exact field shape. Stored as JSON rather than a fields table because
  -- it is read and written whole, never queried field-by-field.
  layout        jsonb not null default '{}'::jsonb,
  field_count   integer not null default 0,
  captured_from text,                                            -- BoldSign document id it was read from
  captured_by   uuid references agents(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create unique index if not exists idx_deal_field_layouts_key
  on deal_field_layouts(deal_id, template_id);

-- ── RLS — a deal-child table, scoped exactly like the documents it describes ──
alter table deal_field_layouts enable row level security;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_visible_deal_ids') then
    drop policy if exists deal_field_layouts_deal_scope on deal_field_layouts;
    create policy deal_field_layouts_deal_scope on deal_field_layouts for all to authenticated
      using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
      with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));
  else
    -- Database predating the scoped-RLS helpers: fall back to authenticated
    -- access rather than leaving the table unreadable (0002/0011 tighten it).
    drop policy if exists deal_field_layouts_all on deal_field_layouts;
    create policy deal_field_layouts_all on deal_field_layouts for all to authenticated
      using (true) with check (true);
  end if;
end $$;
