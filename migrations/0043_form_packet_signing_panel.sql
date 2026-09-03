-- ─────────────────────────────────────────────────────────────────────────────
-- 0043 — form_packets.signing_panel
--
-- WHAT THIS FIXES. The send screen's "Prepare Draft Agreement" panel — the
-- Representation / Term / Policy decisions a buyer packet cannot be sent
-- without — was a single hard-coded map of BoldSign field ids (CheckBox1 …
-- CheckBox9) applied to EVERY template an agent opened.
--
-- Those ids are not names anyone chose. BoldSign auto-assigns CheckBox1,
-- CheckBox2, … on every template it creates, so every template in the account
-- with checkboxes has a CheckBox1. Registering a second template with tick
-- boxes — a seller listing agreement, a disclosure, a Nebraska form — meant the
-- Iowa buyer packet's answers were written onto that template's first nine
-- boxes as locked terms of a signed agreement, silently. The same map also
-- gated both send buttons, so a listing agreement could not be saved as a draft
-- until the agent answered two buyer-agency questions that did not apply to it.
--
-- A panel is now DECLARED PER PACKET here, and is only ever applied to the
-- template it was declared for.
--
-- Additive and safe to run at any time. A packet with a null signing_panel
-- behaves exactly as it does today: the app falls back to a built-in panel for
-- the packet's (state, transaction_type), and applies it ONLY if every field id
-- it names exists on the live template, is a tick box, and is printed beside
-- the words the panel expects. A template that fails any of those gets no panel
-- rather than the wrong one.
-- ─────────────────────────────────────────────────────────────────────────────

alter table form_packets
  add column if not exists signing_panel jsonb;

comment on column form_packets.signing_panel is
  'Sender decisions this packet asks for before it can be sent (Representation, Term, Policy …), '
  'as { version, key, groups:[{ key, kind: choice|toggles|fixed, label, required, collapsed, help, '
  'options:[{ key, label, fieldId, expect, default, value, revealToken }] }] }. `fieldId` is the '
  'BoldSign field id on THIS packet''s template; `expect` is a case-insensitive regex source matched '
  'against the caption read off the page, which is what re-checks the id after a template edit. '
  'Null means no declared panel — see src/lib/services/boldsignPacketPanel.js for the built-in '
  'fallback and why it is only applied to a template that validates against it completely.';

-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL — declaring the Iowa buyer agency panel explicitly.
--
-- Nothing below runs as part of this migration, and it does not need to: the
-- app already applies this panel to any IA/buyer packet whose template
-- validates against it. Declaring it explicitly buys one thing — a validation
-- failure becomes a BLOCKED send that names the field, instead of the panel
-- quietly not appearing. That is the stronger guarantee, and it is the right
-- one once you have confirmed the ids below are this template's.
--
-- STEP 1 — see which packets would be affected, and confirm the ids.
--
--   select id, name, state, transaction_type, boldsign_template_id
--     from form_packets
--    where state = 'IA' and transaction_type = 'buyer'
--      and boldsign_template_id is not null and active;
--
-- Then open the packet in Prepare Draft Agreement as an admin. The panel's
-- status line names every box it writes to and whether the page agrees. Do not
-- run STEP 2 until it reads "verified against this form".
--
-- STEP 2 — declare it, for ONE packet, by id. Never by state alone: two Iowa
-- buyer packets built from different source PDFs do not share field ids.
--
--   update form_packets set signing_panel = $json${
--     "version": 1,
--     "key": "ia_buyer_agency_v1",
--     "groups": [
--       { "key": "representation", "kind": "choice", "label": "Representation", "required": true,
--         "options": [
--           { "key": "exclusive",     "label": "Exclusive",     "fieldId": "CheckBox1", "expect": "^(?!.*non-?\\s?exclusive).*\\bexclusive\\b" },
--           { "key": "non-exclusive", "label": "Non-exclusive", "fieldId": "CheckBox2", "expect": "non-?\\s?exclusive" }
--         ] },
--       { "key": "term", "kind": "choice", "label": "Term", "required": true,
--         "options": [
--           { "key": "close", "label": "Until the deal closes", "fieldId": "CheckBox8", "expect": "continue\\s+until\\s+clos|until\\s+closing" },
--           { "key": "fixed", "label": "Ends on a fixed date",  "fieldId": "CheckBox9", "expect": "ends?\\s+at\\s+11:?59|and\\s+ends\\s+at\\b", "revealToken": "retainer_end_date" }
--         ] },
--       { "key": "policy", "kind": "toggles", "label": "Policy", "collapsed": true,
--         "help": "The packet is authored with appointed agency and consensual dual agency on.",
--         "options": [
--           { "key": "single_seller", "label": "Single seller",    "fieldId": "CheckBox4", "default": false, "expect": "single\\s+seller\\s+agency" },
--           { "key": "single_buyer",  "label": "Single buyer",     "fieldId": "CheckBox5", "default": false, "expect": "single\\s+buyer\\s+agency" },
--           { "key": "appointed",     "label": "Appointed agency", "fieldId": "CheckBox6", "default": true,  "expect": "appointed\\s+agency" },
--           { "key": "dual",          "label": "Consensual dual",  "fieldId": "CheckBox7", "default": true,  "expect": "consensual\\s+dual\\s+agency" }
--         ] },
--       { "key": "party", "kind": "fixed",
--         "options": [ { "key": "buyer", "label": "Party: Buyer", "fieldId": "CheckBox3", "value": true, "expect": "^(prospective\\s+)?buyer\\b" } ] }
--     ]
--   }$json$::jsonb
--   where id = '<the packet id from STEP 1>';
--
-- TO UNDO a declaration (the panel reverts to the self-validating fallback):
--
--   update form_packets set signing_panel = null where id = '<packet id>';
-- ─────────────────────────────────────────────────────────────────────────────
