# Production database reconciliation (2026-06-10)

The live Supabase database **predates this codebase** and was never given the
numbered migrations in `migrations/`. A read-only diagnostic (run by Daniel,
2026-06-10) revealed its true state. This folder holds the bundles actually
applied to production and the findings, so the repo's history matches reality.

## What the diagnostic showed

- **None of the numbered migrations (0001–0011) had ever been applied.** The
  legacy v1 mailing tables still exist; 0002's helper functions were absent.
- **`documents` did not exist at all** — the deal-documents feature was broken
  in production.
- **`docusign_envelopes` is an older shape** — no `agent_id`, `document_id`,
  or `signers` columns.
- **`deals` carries a legacy denormalized shape** the repo schema doesn't
  know: `prop_address`, `prop_price`, `sold_price`, `commission_pct`,
  `agent_side`, `is_1031`, `deal_state`, and notably **`co_agent_ids uuid[]`**
  (legacy co-listing). There is also a `deal_contacts` table, extra `contacts`
  columns (`is_prospect`, `deleted_at`, `company`, …), and `campaign_scans` /
  `canva_connections` tables — all unknown to `src/lib/schema.sql`.
  **Reconciling the deal/contact shape is Milestone 1 scope.**
- **RLS is enabled on every table but protective on paper only** — permissive
  policies everywhere. The permissive policy NAMES differ from the repo's
  assumption (`agent_select/insert/update/delete` etc., not `allow_all`), which
  is why Phase B here uses different drops than `migrations/0011`.
- **Three real holes** (fixed by the bundle): `properties` had
  INSERT/UPDATE/DELETE policies open to the `public` role (anonymous visitors
  could delete listings); `integrations` (stores credentials) and
  `webhook_configs` were fully readable/writable by anonymous visitors.

## Applied bundles

| Date | File | Status |
|------|------|--------|
| 2026-06-10 | `2026-06-10_milestone0_phaseA.sql` | Built and validated against an exact replica (see `scripts/db-verify/production/`) — applied by Daniel via the SQL editor |

The bundle: creates `documents` (secure from day one), adds the missing
`docusign_envelopes` columns, adds `activities.deal_id`, adds the deal value /
probability guards, installs the visibility helpers and dormant scoped
policies, and closes the anonymous-access holes. The production
`app_visible_deal_ids()` includes a branch for the legacy `deals.co_agent_ids`
array that the repo-schema version does not have (the column doesn't exist on
fresh installs); the app reads both sources via
`src/lib/services/deals.js#fetchCoListedDealIds`. Once Milestone 1 migrates
`co_agent_ids` into `commissions.participants`, that branch can be dropped.

## Phase B for PRODUCTION (the actual enforcement switch)

The generic Phase B in `migrations/0011` drops `allow_all` policies — but
production's permissive policies have different names. Use THIS block (it is
also included, commented out, at the bottom of the applied bundle):

```sql
do $$
declare t text;
begin
  foreach t in array array['contacts','deals','tasks','activities'] loop
    execute format('drop policy if exists agent_select on %I', t);
    execute format('drop policy if exists agent_insert on %I', t);
    execute format('drop policy if exists agent_update on %I', t);
    execute format('drop policy if exists agent_delete on %I', t);
  end loop;
end $$;
drop policy if exists agent_select on commissions;
drop policy if exists agent_insert on commissions;
drop policy if exists agent_update on commissions;
drop policy if exists agents_envelopes on docusign_envelopes;
drop policy if exists allow_all        on docusign_envelopes;
drop policy if exists auth_all_steps   on transaction_steps;
drop policy if exists allow_all        on transaction_steps;
drop policy if exists agent_notifications_policy on agent_notifications;
drop policy if exists allow_all                  on agent_notifications;
drop policy if exists deadline_reminders_all     on deadline_reminders;
```

Pre-conditions: the app build from this branch is deployed, and a non-admin
agent has confirmed their pipeline/commission views look right. Rollback: the
`PHASE B-ROLLBACK` block at the bottom of the applied bundle reopens
everything instantly.

## Verifying against the replica

`scripts/db-verify/production/replica.sql` rebuilds the production shape
(tables, columns, policy names) on a scratch Postgres;
`replica_behavior.sql` then applies the dress rehearsal: Phase A inertness,
anon-hole closure, Phase B with the real policy names, and the full
visibility matrix (own / team / participant co-listing / legacy
`co_agent_ids` co-listing / admin / write guards). Run order:

```bash
createdb prod_replica
psql -d prod_replica -f scripts/db-verify/supabase_shim.sql
psql -d prod_replica -f scripts/db-verify/production/replica.sql
psql -d prod_replica --single-transaction -f migrations/production/2026-06-10_milestone0_phaseA.sql
psql -d prod_replica -f scripts/db-verify/production/replica_behavior.sql
# expect: PASS ×17 and "ALL REPLICA BEHAVIOR TESTS PASSED"
```
