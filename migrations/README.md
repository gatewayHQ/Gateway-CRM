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
| 0024 | `0024_deals_rls_insert_fix.sql` | Fixes "new row violates RLS" on deal INSERT: adds a BEFORE INSERT trigger stamping a null `deals.agent_id` to the caller's own agent id, and splits 0011's single `deals_agent_scope` FOR ALL policy into explicit SELECT/INSERT/UPDATE/DELETE policies. INSERT gates on the caller being a claimed agent (ownership is enforced on SELECT/UPDATE); DELETE tightened to owner-or-admin | Yes — unblocks agent deal creation; co-listed non-owners can no longer DELETE | After 0011 |
| 0025 | `0025_properties_teamsplits_rls.sql` | Security remediation (2026-07 audit): scopes `properties` (own + share-properties peers + admin; public reads move behind `/api/property-public`) with an owner-stamp trigger, and locks `team_splits` writes to admins (reads stay open) | **Yes** — properties become agent-scoped; team membership edits become admin-only. **Deploy the matching app build FIRST** (public listing/share pages must use the service-key endpoint) | After 0011; deploy app first |
| 0026 | `0026_remove_twilio.sql` | Retires the Twilio SMS feature: drops `conversations` + `messages` and `agents.twilio_number`/`twilio_sid`. App code (Messages page, Twilio integration tab, `/api/twilio-*`, cron SMS branch) removed in the same commit | **Yes (destructive)** — deletes stored SMS conversations. Export first if you want an archive. `TWILIO_*` env vars become unused | After deploying the app build |
| 0027 | `0027_audit_r2_security_data.sql` | Round-2 audit remediation: adds `to authenticated` to six anon-exposed policies (mailing PII, templates, teams; mailings keeps public read), makes `integrations` admin-only, switches `app_is_admin()` to the `is_admin` flag (drops the `%admin%` substring), adds `deals.closed_at` + trigger for cap-year accounting, and a GIN index on `commissions.participants` | **Yes** — non-admins lose direct Mailchimp-config read; anyone flagged admin only by a role-string must have `is_admin` set (safety back-fill + review query included) | After 0011; deploy app build alongside |
| 0028 | `0028_property_fk_ondelete.sql` | Recreates `deals_property_id_fkey` + `mailings_property_id_fkey` with `ON DELETE SET NULL` (live constraints were missing it, blocking property deletes). Matches what `schema.sql` already declares | No — deleting a property now detaches deals/mailings instead of erroring | Anytime |
| 0029 | `0029_capture_deal_agents_model.sql` | **Drift capture (F-03):** writes the live deal-visibility model into source control — `deal_agents` + `visibility_settings` tables, `app_team_deal_visibility()`, the `deal_agents`-based `app_visible_deal_ids()`, `sync_primary_deal_agent` + `app_deal_owner_guard` triggers, and their policies. Retires the redundant `deals_stamp_owner` and duplicate `deals_set_updated_at` triggers | No — faithful capture of what prod already runs (idempotent no-op there); makes `schema.sql` truthful and fresh installs correct | After 0011; already live in prod |

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
