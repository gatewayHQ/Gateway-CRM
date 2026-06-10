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
| 0002 | `0002_rls_agent_scoping.sql` | Real RLS: enforces the existing agent/team scoping in the database (two phases — see below) | **Phase A: no. Phase B: yes (activates enforcement)** | After 0003, with testing |

> Note the numeric order vs. recommended run order: **0001 → 0003 → 0004 → 0005 → 0006 → 0007 → 0002**.
> 0002 is applied last because its Phase B is the only step that changes what
> data the database returns, so it should land after the schema is settled.

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

### Decision needed before hardening `deals` / `commissions`
`src/pages/Commission.jsx` is a **brokerage-wide report** (org totals, per-agent
leaderboard, cap tracking) — today every agent sees the whole firm's numbers.
The deferred deals/commissions policies (written, inactive, in 0002) would make
a **non-admin** see only their own data there; **admins are unaffected**.
Decide: is firm-wide earnings visibility meant for everyone (keep those tables
permissive, or admin-gate the page) or for admins only (then the deferred
policies are the intended hardening)? Also scope the unscoped client reads
(App.jsx:329, Commission.jsx:554-555) at that time.

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
