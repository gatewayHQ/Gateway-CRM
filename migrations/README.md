# Database Migrations

This folder holds **apply-once, ordered** SQL changes for the Gateway CRM
Supabase database. `src/lib/schema.sql` is the full, re-runnable description of
the *current* schema (safe to run top-to-bottom on a brand-new database). These
migration files are the deltas that bring an **existing** database up to match
it.

Run each file in the **Supabase Dashboard → SQL Editor**. Apply them in number
order. Every file is idempotent (`if exists` / `if not exists`), so re-running a
file is safe.

> The application code does not run these automatically and has no access to do
> so — a human applies them through the SQL Editor.

---

## Apply order

| # | File | What it does | Changes behavior? | When to run |
|---|------|--------------|-------------------|-------------|
| 0001 | `0001_drop_mailing_v1.sql` | Drops the dead legacy mailing tables (`mail_campaigns`, `mail_sends`, `mail_suppressions`) | No — they have zero code references | Anytime |
| 0003 | `0003_consolidate_ghost_tables.sql` | Creates the tables that were previously defined ad-hoc in component "run this SQL" panels; drops the orphan `envelopes`; adds `created_at` to `docusign_envelopes` | No — uses `if not exists`, touches no data | Anytime |
| 0004 | `0004_agent_bio_headshot.sql` | Adds `phone` / `photo_url` / `bio` to `agents` for landing-page advisor cards | No (additive columns) | Anytime |
| 0005 | `0005_commission_structured_admin.sql` | Adds `commissions.sides` / `commissions.participants` (complex two-sided deals), `agents.default_split_pct` / `agents.no_brokerage_split` (per-agent split defaults), and `agents.is_admin` (back-filled from role) | No (additive columns; legacy rows still computed on the fly) | Anytime |
| 0006 | `0006_agent_profile_stats.sql` | Adds `agents.tagline` / `agents.stats` for the standalone advisor profile page (`/advisor/:id`) and the "Meet your advisor" sections | No (additive columns) | Anytime |
| 0007 | `0007_properties_status_cancelled.sql` | Widens the `properties.status` CHECK to include `'cancelled'` so listings can be dragged to a Cancelled column in the pipeline | No (constraint swap) | Anytime |
| 0002 | `0002_rls_agent_scoping.sql` | Real RLS: enforces the existing agent/team scoping in the database (two phases — see below) | **Phase A: no. Phase B: superseded — use 0011's Phase B** | After 0003 |
| 0008 | `0008_schema_drift_reconciliation.sql` | Adds the `deals` columns the app already uses (`prop_category`, `prop_subtype`, `comp_data`) to environments missing them; restates the 20260605 dated migration so the numbered chain is self-contained | No (additive, idempotent) | Anytime |
| 0009 | `0009_deal_activities.sql` | `activities.deal_id` — activities can attach to a deal as well as a contact, giving deals a real timeline | No (additive) | After 0008 |
| 0010 | `0010_deal_data_guards.sql` | Cleans and then CHECK-constrains `deals.value` (≥ 0) and `deals.probability` (0–100) so commission math can't be poisoned | Only for out-of-range rows (normally none — see the preview SELECTs in the file) | After 0008 |
| 0011 | `0011_rls_deals_commissions.sql` | RLS for deals/commissions/documents/envelopes/steps per the decided visibility model (own + team-shared + co-listed; admin sees all). Its Phase B activates enforcement for 0002's tables too | **Phase A: no. Phase B: yes (activates ALL scoping)** | Last, with testing |
| 0012 | `0012_deal_stage_tracks.sql` | Widens the `deals.stage` CHECK to the track-aware superset (commercial + residential buyer/seller boards, `src/lib/stages.js`) | No (constraint swap; superset includes every legacy token) | Before/with the Milestone 1 app deploy |
| 0013 | `0013_back_office.sql` | Back office: `agents.cap_amount`/`cap_anniversary`, and commissions become ADMIN-ONLY at the DB level (agents get their slice via `/api/portal?action=my-earnings`) | **Yes — non-admins lose direct commission reads** | With the Back Office app deploy |
| 0014 | `0014_docusign_to_signwell.sql` | Replaces `docusign_envelopes` with `signwell_documents`; drops the DocuSign tables | No (superseded by 0016) | With the SignWell app deploy |
| 0015 | `0015_transaction_layer.sql` | Transaction-management layer: `transaction_steps`, deal `review_status`, `closing_packets` + the `closing-packets` storage bucket | No (additive) | With the transaction-layer app deploy |
| 0016 | `0016_signwell_to_boldsign.sql` | Renames `signwell_documents` → `boldsign_documents` (data preserved), renames its indexes/policy, and allows `document_versions.source = 'boldsign'` | No (rename + additive constraint) | With the BoldSign app deploy |
| 0017 | `0017_boldsign_phase1.sql` | BoldSign Phase 1: adds `boldsign_sender_identities` (per-agent send-on-behalf) and `boldsign_templates` (reusable docs + prefill field tokens) | No (additive tables) | With the BoldSign templates deploy |
| 0018 | `0018_boldsign_audit_trail.sql` | Adds `boldsign_documents.audit_trail_saved` — tracks whether the compliance audit trail PDF was archived on completion | No (additive column) | With the audit-trail deploy |
| 0019 | `0019_form_library_boldsign_unification.sql` | Folds the `boldsign_templates` registry into Form Library: adds `boldsign_template_id` / `doc_type` / `field_tokens` / `active` to `form_packets`, and backfills existing registered templates. `boldsign_templates` is superseded, not dropped | Data migration (backfill) — see file for the null-state skip rule | With the Form Library unification deploy |
| 0020 | `0020_boldsign_identity_default.sql` | Adds `boldsign_sender_identities.is_default` (org-wide OnBehalfOf fallback) with a partial unique index enforcing at most one default | No (additive column) | With the sender-identity management deploy |
| 0021 | `0021_multi_contacts.sql` | Adds `deal_contacts` + `property_contacts` junction tables so a deal/property can carry additional contacts (husband & wife, co-buyers, co-owners). Primary `contact_id`/`linked_contact_id` unchanged | No (additive tables; app degrades to single-contact until run) | With the multi-contact deploy |
| 0022 | `0022_form_packet_multi_file.sql` | Adds `form_packets.storage_paths` (jsonb) so a packet/template can hold several source PDFs (listing agreement + disclosures) combined into one BoldSign template. `storage_path` stays the primary/first | No (additive column; save degrades to single-file until run) | With the package-template deploy |
| 0024 | `0024_deal_commission_entry.sql` | Adds `deals.commission_type` / `commission_pct` / `commission_flat` — the assigned agent's own commission entry (percentage **or** flat fee) on the deal's Details tab, since `commissions` is admin-only. Adopts the legacy production `commission_pct` column and backfills `commission_type = 'percent'` | Yes, indirectly — an agent-entered commission now outranks a legacy `commissions.gross_pct` scalar in reports (structured `sides` still win) | With the commission-entry deploy |
| 0025 | `0025_deal_co_agents.sql` | Adds `deals.co_agent_ids uuid[]` (+ GIN index) so the co-agents picked on a property carry over when it is converted into a deal; adds the matching co-listing branch to `app_visible_deal_ids()` so a carried-over co-agent can actually read the deal. Adopts the legacy production column | Yes, indirectly — a co-listed deal with no saved split now seeds a participant per co-agent (even allocation), so reports share the take instead of giving it all to the owner. Saved structured splits and legacy `co_agent_pct` rows are untouched | With the co-agent carry-over deploy |
| 0026 | `0026_deal_field_layouts.sql` | Adds `deal_field_layouts` (per-deal BoldSign field placement that survives the draft) and `boldsign_documents.boldsign_template_id` | No (additive) | With the field-layout deploy |
| 0029 | `0029_deal_delete_fk_actions.sql` | Gives every foreign key that points at `deals` the `on delete` action `src/lib/schema.sql` already specifies (`tasks`/`activities`/`agent_notifications` → set null, the rest → cascade). Without it, deleting a deal that a **co-agent** had a task on failed with `violates foreign key constraint "tasks_deal_id_fkey"` — the app's clear-tasks-first workaround only ever reached the caller's own tasks, because tasks are personal under RLS | **Yes — deleting a deal now clears those links instead of failing.** No rows changed by the migration itself | With the pipeline delete fix deploy |
| 0030 | `0030_boldsign_go_live.sql` | BoldSign Sandbox → Live hardening: a unique index on `boldsign_documents.document_id` (a duplicate made every server-side `maybeSingle()` lookup throw — in the webhook that was caught, answered 200, and the document silently stopped updating forever), and `form_packets` writes become **admin-only** (they were open to every authenticated agent, including deleting a state-required form or repointing its BoldSign template). Duplicates are reported, never auto-deleted | **Yes — non-admins lose write access to the form catalog** (the UI already hid those buttons) | Before switching BOLDSIGN_API_KEY to the Live key |
| 0027 | `0027_agent_stage_labels_and_split_guard.sql` | Adds `agents.stage_labels` (per-agent pipeline column headers) **and fixes `agents_guard_privileged()`**, whose service-role detection read only the JWT claim — under Supabase's newer `sb_secret_…` keys that is null, so the trigger silently froze commission splits / caps / `is_admin` on writes from the admin API and the UPDATE still reported success | **Yes — admin edits to splits and caps actually persist now.** No data rewritten | With the commission-split fix deploy |
| 0031 | `0031_qr_scan_reliability.sql` | QR scan pipeline: `record_mailing_scan()` resolves the token, stores the event and bumps the counter in **one atomic round trip** (the old read-modify-write lost ~2 of every 3 concurrent scans); scan rows gain bot/duplicate flags, device, geo and a `visit_id` that ties a captured lead back to the scan that produced it; reporting moves into SQL (`mailing_stats` / `mailing_analytics` / `mailing_dashboard`) instead of tallying raw rows in a serverless function, where totals silently capped at PostgREST's max-rows; `reconcile_mailing_counters()` repairs counter drift nightly | No — additive columns + new functions. The app falls back to its pre-0031 query path when the functions are absent, so code and migration can ship in either order | With the QR tracking deploy |
| 0032 | `0032_office_admin_toggle.sql` | Office-admin toggle: `app_is_admin()` stops applying the legacy `role ilike '%admin%'` fallback to the two accounts that own the toggle (Erin, Daniel — mirrors `src/lib/officeAdmins.js`), so switching themselves off actually narrows RLS to their own rows | Only for an allow-listed account whose role text says "admin" while `is_admin` is false — the case the toggle exists for. No other agent's access changes, no data rewritten | With the office-admin toggle deploy |
| 0033 | `0033_scan_uuid_searchpath.sql` | **Fixes a total QR-scan outage.** `record_mailing_scan()` is `security definer` with `set search_path = public`, but Supabase installs uuid-ossp into the `extensions` schema — so its first statement (`coalesce(p_scan_id, uuid_generate_v4())`) could not resolve the generator and **every scan of every QR code failed** with `42883`, showing scanners the "Opening your page…" retry page and recording nothing. Name resolution happens before COALESCE short-circuits, so passing `p_scan_id` (which the app always does) did not save it. Recreates the function using core `gen_random_uuid()`, removing the extension dependency | **Yes — scans start recording again.** No data rewritten; signature unchanged, so it is safe before or after the app deploy | **Apply now if QR codes are live.** Diagnose with `scripts/db-verify/scan_diagnose.sql` |
| 0027b | `0027_lock_public_rls.sql` | Closes the RLS policies that were open to the **anonymous** key. Written `for all using (true)` with no `TO` clause, they applied to PUBLIC — so `properties`, `templates`, `teams`, `team_splits` and the four mailing tables were anonymously readable AND writable (`mailing_recipients` holds every mailed person's street address; `properties` was anonymously DELETE-able). Also replaces the `agents` public-read policy with the 10-column `agents_public` view, so the comp plan stops reaching the browser. Drops policies by ROLE, not by name, because the live database's permissive policies are not named `allow_all` | **Yes — anonymous callers lose all access to those tables.** Its own safety note was WRONG about `/lp/*`, `/listing/:id` and `/share/:id`, which read those tables as anon and broke silently (RLS filters rather than errors); the app fixes that route them through service-key endpoints shipped later — deploy those FIRST or with it, never after | With (or after) the public-page service-key fixes |
| 0034 | `0034_ms_graph_outlook_integration.sql` | Microsoft Graph (Outlook) integration: `ms_graph_connections` (one encrypted token pair per agent, locked to the service role — no `authenticated`/`anon` policy at all) + `ms_graph_connection_status` view (non-secret status, agent reads their own row directly), `ms_oauth_states` (short-lived PKCE state, service-role only), and `email_messages` (sent-email log linked to contacts/deals, RLS mirrors `activities_scope`) | No (additive tables; nothing existing changes behavior until the app deploy that uses them) | With the Outlook integration app deploy |
| 0035 | `0035_ms_graph_calendar_sync.sql` | Deal key dates → Outlook calendar sync: `deal_calendar_events` — one row per (deal, agent, date_type) mapping to the Graph calendar event id it created, plus a hash to skip unchanged syncs. RLS follows the deal, matching `documents`/`transaction_steps` | No (additive table; nothing writes to it until the calendar-sync app deploy) | With the calendar-sync app deploy |
| 0036 | `0036_ms_graph_power_features.sql` | Inbound mail matching + contact enrichment + draft-mode send + free/busy: adds `ms_graph_connections.mail_delta_link` (Graph delta cursor per agent) and widens `email_messages.status` to accept `'received'` (an inbound-matched message, distinct from an outbound `'sent'`) | No (additive column + constraint widening; nothing writes 'received' until the inbox-sync app deploy) | With the Graph power-features app deploy |
| 0037 | `0037_website_lead_intake.sql` | Website lead intake: `leads` + `lead_property_views` (the canonical webhook lead record and the properties the visitor looked at), and `lead_rotations` + `lead_rotation_members` — a **durable round-robin cursor** advanced by `assign_lead_round_robin()` inside a `for update` lock. The old picker read the newest `lead_captures` row and took the next agent alphabetically: two leads in the same second both got the SAME agent (the read-modify-write race 0031 fixed for QR scans), there was no way to park an agent, and deleting test leads moved the rotation. Also adds `sequences.auto_enroll_lane` so a new lead is handed to the existing drip runner. Rings are backfilled from `agents.specialty` | No — additive tables + functions; the pre-deploy code never calls them, and the app falls back to the legacy picker when they are absent, so code and migration can ship in either order | With the website-lead webhook deploy |
| 0038 | `0038_contact_email_correspondence.sql` | Contact-level email correspondence: adds `email_messages.from_address` / `from_name` / `web_link` / `has_attachments` / `source` (`'crm'` = a message this CRM sent, `'graph'` = a copy mirrored out of the mailbox for the history panel), plus `contact_email_sync` — the per-(contact, agent) Graph paging cursor and refresh clock behind the contact panel's **Emails** tab. Replaces the old "Enrich from Outlook" button as the way a contact's email is surfaced: that button queried the agent's Outlook CONTACTS address book (`/me/contacts`), so any correspondent who was never saved to the address book reported "No matching Outlook contact found" even with years of mail on file. The new panel queries `/me/messages` instead. The address-book lookup itself is unchanged and still available on the Details tab for filling in a blank phone/company | No — additive columns + one new table; the pre-deploy code never reads them | With the contact Emails tab deploy |
| 0039 | `0039_mass_email_deal_announcements.sql` | Mass email / deal announcements: `email_blasts` + `email_blast_recipients` (one row per send and one per recipient — the recipient row is the send cursor, which is what makes a batch resumable without mailing anyone twice), `email_messages.blast_id`, `contacts.email_opt_out`, and a widened `templates.category` accepting `'deal-announcement'` | No — additive tables/columns plus one constraint widening; nothing existing changes behavior until the app deploy that uses them | With the mass-email app deploy |
| 0040 | `0040_deal_sides_and_pricing_history.sql` | Deal sides & shared pricing history: `deals.buyer_contact_id`/`seller_contact_id` + `deal_contacts.side` (so a deal representing BOTH sides keeps two client sets that can't overwrite each other), the canonical `pricing_history` log behind the Pricing History tab on both the deal and the property, and declarations for the `properties.price_history`/`comps` drift | Backfills only: existing deals get their single contact filed onto the side they represent, legacy `price_history` jsonb is imported into `pricing_history`, and an open deal with a NULL value inherits its property's list price | With the deal pricing/representation app deploy |
| 0041 | `0041_task_calendar_sync.sql` | Task due dates → the assigned agent's Outlook calendar: `task_calendar_events`, the ledger of one Graph event id per (task, agent) plus a hash of the event-visible task fields, so a re-sync of an unchanged task writes nothing. The companion to 0035 (deal key dates) — a task created with a due date now appears on the calendar the agent already checks, and the event is removed again when the task is completed, loses its date, is unassigned, is reassigned (it moves to the new assignee) or is deleted. RLS mirrors `tasks_agent_scope`: strictly personal, admins included | No — additive table; nothing writes to it until the task-calendar app deploy | With the task calendar-sync app deploy |
| 0042 | `0042_property_suite_unit.sql` | Adds `properties.unit` — the suite / unit / space identifier inside the building at `address` (`'Suite 120'`, `'#4'`, `'Bldg C'`), so a space for lease in a strip mall or office building is its own listing rather than a suite typed into the street line. Also widens `search_properties` so global search matches the suite | No (additive column; existing rows read exactly as before, nothing is back-filled) | With the suite/unit app deploy |
| 0043 | `0043_form_packet_signing_panel.sql` | Adds `form_packets.signing_panel` — the sender decisions a packet asks for (Representation / Term / Policy) declared **per packet** and bound to that packet's own BoldSign field ids. Replaces the single hard-coded `CheckBox1`–`CheckBox9` map that was applied to every template, which wrote one packet's terms onto another's boxes because BoldSign auto-names checkboxes identically on every template | No (additive column; a null panel falls back to the self-validating built-in, so today's Iowa buyer packet is unchanged) | With the packet-panel app deploy |
| 0044 | `0044_deal_template_drafts.sql` | Adds `deal_template_drafts` — the saved state of the **prepare-from-template** screen, one row per (deal, template): signer rows, prefilled field values, the tri-state tick boxes, the packet's declared terms, and the send options BoldSign fixes at creation. Preparing a packet is where an agent decides what an agreement says, and none of it was stored anywhere: closing the modal (the X, Escape, the backdrop, Cancel, a reload) discarded every one of those decisions with no warning, and reopening the template re-seeded from the deal. Distinct from `deal_field_layouts`, which records where fields SIT on a document read back out of BoldSign, not what the agent answered on our own screen | No (additive table; the pre-deploy code never reads it, and the app treats its absence as "nothing saved" rather than an error, so code and migration can ship in either order) | With the save-for-later app deploy |
| 0045 | `0045_om_gated_download.sql` | Gated Offering Memorandum downloads on QR landing pages: the **private** `campaign-oms` storage bucket, `mailing_om_requests` (who unlocked which OM, with the scan that brought them), and `mailing_leads.om_requested` | No (additive; campaigns with no OM attached render exactly as before) | With the OM-gate app deploy |

> **Note on the duplicated 0027.** Two files carry that number: `0027_agent_stage_labels_and_split_guard.sql` and `0027_lock_public_rls.sql`. They are unrelated and both real. The RLS one is listed above as **0027b** purely to keep this table unambiguous — the filename on disk is unchanged, since it may already have been applied under its own name. It is not recorded in `migrations/production/README.md` either, so to find out whether a given database has it, run the read-only `scripts/db-verify/public_read_posture.sql`.

> Note the numeric order vs. recommended run order: **0001 → 0003 → 0004 → 0005 → 0006 → 0007 → 0002 (Phase A) → 0008 → 0009 → 0010 → 0011 (Phase A, then Phase B after verification)**.
> 0011's Phase B is the only step that changes what data the database returns,
> so it lands last — after the schema is settled, the matching app build is
> deployed, and the verification checklist in the file passes.

---

## 0002 — the RLS rollout (read before running)

Today every table uses `allow_all using(true)`, and data isolation happens only
in client code (`App.jsx` filters by `assigned_agent_id`). Any authenticated
user can read every row by issuing an unfiltered query. 0002 moves that scoping
into the database.

**This cut enforces scoping on `contacts`, `activities`, `tasks`** — the tables
where a codebase audit confirmed enforcement is correct and non-breaking.
`deals` and `commissions` are **deferred** (policies are written but left
inactive in the file) because they are entangled with the brokerage-wide
Commission page — see the decision note below.

It is split into phases so it can land with zero downtime:

### Phase A — safe to run immediately
Creates the helper functions and the scoped policies. Because the existing
`allow_all` policy is OR-combined with these, **the tables stay fully open** —
applying Phase A changes nothing a user can observe.

### Verify (ideally in a staging project) before Phase B
Sign in as a **normal (non-admin) agent** and confirm:
- Contacts and Tasks pages show the **same rows as before**.
- Creating a contact/task assigned to yourself succeeds.
- `select * from contacts` returns **only** your + sharing-peers' rows.
- Cold Calls import still works (dedup now checks your contacts only).
- The Campaigns recipient picker now lists your contacts only (intended).
- A contact's Activity tab still shows its history.

`/api/*` endpoints use the service key and bypass RLS, so Twilio, DocuSign,
cron (sequence-run), and campaign tracking are unaffected.

### Phase B — activates enforcement
Uncomment and run the `PHASE B` block (drops `allow_all` on
contacts/activities/tasks). After this, the database enforces scoping.

### Rollback
Run the `PHASE B-ROLLBACK` block — it recreates `allow_all` and reopens the
tables instantly.

### Edge cases to know
- A task inserted with a null `agent_id` would be rejected once Phase B is live
  (the app always sets it, so this does not happen in normal use).

### Decision on `deals` / `commissions` visibility → RESOLVED (2026-06)
Decided: **a regular agent sees only their own deals & earnings, plus deals
they are co-listed on and will get paid on; firm-wide visibility is admin
only.** Migration **0011** implements exactly this (deals, commissions, and the
deal-children: documents, docusign_envelopes, transaction_steps,
deadline_reminders, plus personal agent_notifications), and its Phase B is now
the single switch that activates enforcement for 0002's tables as well. The
previously-unscoped client reads were fixed alongside it: every deal/commission
(re)load now goes through `src/lib/services/deals.js`, which also adds
co-listed deals (commission participants) to what a non-admin fetches.

---

## 0005 — structured commissions, per-agent splits, admin access

Three additive changes, all safe to run anytime:

1. **`commissions.sides` + `commissions.participants` (jsonb).** The complex
   commission model: a deal can carry both a listing and a buyer side (each with
   its own rate and its own referral), and any number of agents who each split
   the net with the brokerage on *their own* terms. When these columns are
   non-empty they are authoritative; the legacy flat columns (`gross_pct` …
   `transaction_fee`) are still written as a best-effort mirror and still drive
   any old row that hasn't been re-saved (`src/lib/commission.js` upgrades them
   transparently, so nothing about existing deals changes until edited).
2. **`agents.default_split_pct` + `agents.no_brokerage_split`.** Each agent's
   default brokerage arrangement, so the editor pre-fills correctly — e.g. an
   agent who is capped / keeps 100% (`no_brokerage_split = true`) vs. one on a
   60/40 split (`default_split_pct = 60`).
3. **`agents.is_admin`.** Explicit office-admin flag (back-filled from any role
   containing "admin"). `App.jsx` uses it to load **all** deals, contacts,
   properties, commissions and activities firm-wide; documents and signatures
   are deal-scoped, so an admin who can see every deal can see every document.
   Until this runs, admin still works via the role-string fallback.

**Mailing scoping** (each agent sees only their own campaigns + ones they
collaborate on) is enforced today in the app layer — `api/campaigns.js?action=list`
filters by the caller's `agent_id` / `landing_config.agent_ids`. The eventual
hard guarantee is a `mailings` RLS policy (a follow-up to 0002), since the
campaigns API runs on the service key and bypasses RLS.

---

## 0024 — the agent's own commission entry (read before running)

0013 made `commissions` **admin-only**: every row holds each participant's
split, so an agent can neither read nor write one. That left the agent with no
place to record the one commission number they actually negotiate — *what are we
charging this client?* — and the back office had to chase it by phone.

0024 puts that number on `deals`, which agents already read/write under 0011's
scoping, entered from the deal drawer's **Details** tab as either a percentage
(`commission_pct`) or a flat fee (`commission_flat`), selected by
`commission_type`. It is the **input** to the split, never the split itself — no
take-home, no per-agent percentage, nothing an agent shouldn't see.

**It adopts an existing production column.** The live `deals` table has carried a
legacy `commission_pct numeric` since before this codebase (see
`production/README.md`), already feeding the `commission_pct` BoldSign token.
`add column if not exists` adopts it rather than recreating it, and the
`commission_type` backfill lights up whatever values are already stored — so
deals that silently held a rate start showing it in the UI the moment this runs.

**The one behavior change.** `src/lib/commission.js` resolves a deal's gross in
this order:

1. `commissions.sides` — the back office's explicit entry. Once an admin saves in
   the Commission editor this wins, full stop.
2. `deals.commission_*` — the agent's entry (this migration).
3. `commissions.gross_pct` — the legacy scalar.
4. `3.0%` — nothing entered anywhere.

So on a deal whose commission row is still the **legacy** shape (never re-saved
in the structured editor), an agent's entry now drives the reports where
`gross_pct` used to. That is the intent — the agent is stating the deal's actual
commission — but it means a legacy row's rate can be superseded by an agent
typing a different one. Deals already carrying structured `sides` are unaffected,
and an admin can always override by saving in the Commission editor. Before
running, the deals exposed to that change are:

```sql
select d.id, d.title, c.gross_pct, d.commission_pct
  from deals d join commissions c on c.deal_id = d.id
 where coalesce(jsonb_array_length(c.sides), 0) = 0
   and d.commission_pct is not null
   and d.commission_pct <> c.gross_pct;
```

**Flat fees reach the engine too.** A commission *side* can now be priced as a
flat dollar fee (`sides[].flat` > 0 replaces `rate_pct`), so an agent's flat-fee
deal survives an admin edit in the Commission editor instead of being forced back
into a percentage. `sides` is jsonb — no schema change, only the column comment
is refreshed.

---

## Known follow-ups (not yet written)

These are deliberately deferred and documented so they aren't lost:

1. **`properties` RLS.** The public `PropertyLanding` page reads `properties`
   anonymously (`src/pages/PropertyLanding.jsx`). Scope it only after that read
   is routed through a service-key API (or given a narrow anon SELECT policy),
   otherwise the public page breaks.
2. **Ghost-table RLS.** The tables consolidated in 0003 currently keep the
   permissive `allow_all` policy. Extend 0002's helpers to them once 0002 is
   proven in production.
3. **`option_value_counts` view.** Queried by `DataManagement.jsx` but never
   defined; its per-value counting logic is field-specific and must be confirmed
   with the team before it can be written correctly. The app degrades to zeros
   when it is absent.
4. **`templates` / `agents`.** Currently shared across all agents by design —
   left permissive intentionally; revisit only if per-agent isolation is wanted.

---

## Conventions

- Number files `NNNN_short_description.sql`, zero-padded, monotonically.
- Keep every statement idempotent (`if [not] exists`, `drop ... if exists`).
- Never modify or delete an already-applied migration — add a new one.
- When a migration adds/changes a table, also update `src/lib/schema.sql` so a
  fresh install stays in sync.

---

## Enum values: single source of truth + drift guard

Controlled-vocabulary fields (`contacts.type/status/source`,
`properties.type/status`) are guarded by **three** layers that must agree:

1. **The database CHECK constraint** — what the live Supabase DB actually enforces.
2. **`src/lib/schema.sql`** — the re-runnable description of the current schema.
3. **`src/lib/enums.js`** — the single source of truth the UI imports. Forms,
   filters, CSV import, and cold-call intake all read these lists (no more
   copy-pasted arrays).

`npm run check:enums` (also a CI step in the `schema-lint` job) parses the CHECK
constraints out of `schema.sql` and fails the build if `enums.js` ever offers a
value the constraint would reject. This catches **code-vs-schema** drift before
it ships.

> ⚠️ The guard cannot see the **live database**. The original
> `contacts_status_check` failure was a value (`opportunity`) that existed in
> `enums.js` *and* `schema.sql` but whose migration had never been run in
> Supabase. That **schema-vs-production** axis is closed only by actually
> applying migrations (see "Apply order" above) — until then,
> `friendlyDbError()` in `src/lib/dbErrors.js` turns the raw Postgres message
> into an actionable one for the agent.
>
> **To add a new enum value:** (1) add it to the CHECK constraint via a new
> migration, (2) mirror it into `schema.sql`, (3) add it to `enums.js`, and
> (4) run the migration in Supabase. Steps 1–3 are enforced by CI; step 4 is the
> manual deploy step.
