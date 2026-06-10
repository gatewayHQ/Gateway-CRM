# Database verification harness

Proves, against a **disposable** Postgres database, that:

1. `src/lib/schema.sql` runs top-to-bottom on a fresh database and is
   idempotent (safe to re-run), and
2. the RLS visibility model does exactly what was decided (2026-06):
   *a regular agent sees only their own deals & earnings plus deals they are
   co-listed on and will get paid on; firm-wide visibility is admin only.*

`rls_matrix.sql` seeds five agents (an office admin/TC, two commercial
advisors where one is co-listed on the other's deal via
`commissions.participants`, and a two-member team), activates Phase B
enforcement, then asserts the full visibility matrix — including that a
co-listed agent can read AND edit the shared deal, that data guards reject a
negative deal value, and that an agent cannot create a deal owned by an
unrelated agent.

## Run it

Against a scratch local Postgres (NEVER a real database — the script seeds
test rows and drops `allow_all` policies):

```bash
createdb crm_verify
psql -d crm_verify -v ON_ERROR_STOP=1 -f scripts/db-verify/supabase_shim.sql
psql -d crm_verify -v ON_ERROR_STOP=1 -f src/lib/schema.sql
psql -d crm_verify -v ON_ERROR_STOP=1 -f scripts/db-verify/rls_matrix.sql
# expect: NOTICE PASS ... ×16 and "ALL RLS TESTS PASSED"
dropdb crm_verify
```

To verify the **upgrade path** instead (what the live database goes through),
apply the old schema first, then the migration chain in the order documented
in `migrations/README.md`, then run `rls_matrix.sql`.

`supabase_shim.sql` stands in for the Supabase runtime on vanilla Postgres:
`auth.uid()` / `auth.role()` read the `request.jwt.claim.*` settings the test
sets per agent, and stub `storage` tables absorb the bucket/policy statements.
On a real Supabase project none of this is needed (or appropriate) — the shim
must never be applied there.
