Run a full health check of the Gateway CRM codebase and report any issues. No argument needed.

This is a read-only audit — do not make edits unless the user explicitly asks for fixes.

## Step 1 — Schema vs code consistency

Read `src/lib/schema.sql`. For each table, extract the column names and check constraints.

Then scan the source:
```
grep -rn "\.from('" src/ --include="*.jsx" --include="*.js"
```

For every Supabase table access, verify:
- Column names used in INSERT/UPDATE payloads match the schema columns
- Values sent to `type`, `status`, `stage`, `priority`, `category`, `source` columns are in the allowed check-constraint list
- UUID foreign-key columns (`*_id` fields) always send `null` not `""` when empty

Report mismatches as **Critical** issues.

## Step 2 — RLS policy audit

Check `src/lib/schema.sql` for the RLS policies defined there. Then note:
- Does every table have both a SELECT and INSERT policy?
- Are there any tables where INSERT passes `with check (true)` but SELECT has a restrictive `using` clause? (This causes the "saves but doesn't appear" bug.)
- Do any SELECT policies filter by `linked_contact_id` instead of `assigned_agent_id`? (Properties linked to no contact become invisible.)

## Step 3 — Component data flow

Read each page component (`src/pages/*.jsx`) and check:
- Is `activeAgent` passed through to every drawer/modal that saves records?
- Does every save function coerce empty-string UUIDs to `null`?
- Does every save use `.select().single()` or an optimistic update so the list refreshes after save?
- Are errors from Supabase surfaced to the user with `pushToast(error.message, 'error')` rather than silently swallowed?

## Step 4 — Dead imports and unused state

For each changed or suspect file:
```
grep -n "^import" src/pages/*.jsx | grep -v "from './"
```
Flag imports that are not used in the file.

Also check for `useState` variables that are set but never read, or vice versa.

## Step 5 — API routes

Read all files in `api/`. Verify:
- Every route handles the `OPTIONS` preflight and returns CORS headers
- Every route returns a JSON error (not 500 HTML) when env vars are missing
- No route uses `req.query` or `req.body` values directly in shell commands or SQL (injection risk)

## Step 6 — Output report

```
## Gateway CRM Health Check — {date}

### Critical (breaks functionality)
- ...

### High (likely causes user-visible bugs)
- ...

### Medium (code quality / reliability)
- ...

### Low (style / maintainability)
- ...

### All clear ✅
- Areas with no issues found: ...
```
