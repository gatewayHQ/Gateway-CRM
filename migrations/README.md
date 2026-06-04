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
| 0002 | `0002_rls_agent_scoping.sql` | Real RLS: enforces the existing agent/team scoping in the database (two phases — see below) | **Phase A: no. Phase B: yes (activates enforcement)** | After 0003, with testing |

> Note the numeric order vs. recommended run order: **0001 → 0003 → 0002**.
> 0002 is applied last because its Phase B is the only step that changes what
> data the database returns, so it should land after the schema is settled.

---

## 0002 — the RLS rollout (read before running)

Today every table uses `allow_all using(true)`, and data isolation happens only
in client code (`App.jsx` filters by `assigned_agent_id`). Any authenticated
user can read every row by issuing an unfiltered query. 0002 moves that scoping
into the database for the genuinely-private tables: **contacts, deals, tasks,
commissions, activities**.

It is split into phases so it can land with zero downtime:

### Phase A — safe to run immediately
Creates helper functions (`app_current_agent_id`, `app_is_admin`,
`app_visible_agent_ids`) and the scoped policies. Because the existing
`allow_all` policy is OR-combined with these, **the tables stay fully open** —
applying Phase A changes nothing a user can observe. This is the whole file as
shipped (everything above the commented Phase B block).

### Verify (ideally in a staging project) before Phase B
Sign in as a **normal (non-admin) agent** and confirm:
- Contacts, Pipeline, Tasks, and Commission pages show the **same rows as before**.
- Creating a contact / deal / task assigned to yourself succeeds.
- In the SQL Editor, impersonating that agent, `select * from contacts` returns
  **only** your + sharing-peers' rows (previously it returned everyone's).

Sign in as an **admin** and confirm Pipeline still shows **all** deals.

`/api/*` endpoints use the service key and bypass RLS, so Twilio, DocuSign,
cron (sequence-run), and campaign tracking are unaffected — no need to retest
those for RLS.

### Phase B — activates enforcement
Uncomment and run the `PHASE B` block (drops `allow_all` on the five tables).
After this, the database itself enforces scoping.

### Rollback
If anything misbehaves, run the `PHASE B-ROLLBACK` block — it recreates
`allow_all` instantly and reopens the tables.

### Edge cases to know
- Tasks must carry `agent_id` = the creating agent (the app always sets this).
  A task inserted with a null `agent_id` would be rejected once Phase B is live.

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
