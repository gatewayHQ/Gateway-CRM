Diagnose and fix Supabase issues in this CRM project. Argument (optional): `$ARGUMENTS`

If an argument is provided, treat it as a specific error message or table name to focus on.
If no argument, run a full audit of all tables.

## Step 1 — Read the schema

Read `src/lib/schema.sql` to understand the intended table structure, column types, check constraints, and RLS policies.

## Step 2 — Identify issues to check

For each table (`contacts`, `properties`, `deals`, `tasks`, `agents`, `templates`), look for these common problems in the codebase:

### UUID columns receiving empty string
Search for patterns like:
```
grep -rn "|| ''" src/
grep -rn 'value=""' src/
```
Any foreign-key UUID column (`assigned_agent_id`, `linked_contact_id`, `contact_id`, `agent_id`, `property_id`) that could receive `""` instead of `null` will cause:
`invalid input syntax for type uuid: ""`
Fix: ensure the payload uses `field || null` not `field || ''`.

### Check constraint violations
Read each `<Table>Drawer` or save function. Verify the values being sent match the allowed values in the schema `check` constraint. Common mismatches:
- `properties.type`: must be one of `residential, rental, multifamily, office, land, retail, industrial, mixed-use, commercial`
- `properties.status`: must be one of `active, pending, sold, off-market, leased`
- `contacts.type`: must be one of `buyer, seller, landlord, tenant, investor`
- `deals.stage`: must be one of `lead, qualified, showing, offer, under-contract, closed, lost`

### RLS SELECT returning nothing after INSERT
Check if any table has both a permissive `ALL` policy AND a restrictive SELECT-specific policy. The SELECT policy filters rows the INSERT policy doesn't — newly inserted rows may pass INSERT check but fail SELECT using clause.
Fix: the SELECT using clause should include `assigned_agent_id = current_agent_id() OR assigned_agent_id IS NULL`.

### Missing columns in schema vs code
Search the source for column names used in `.insert()`, `.update()`, `.select()` calls:
```
grep -rn "\.from('properties')" src/
```
Compare against the schema. If the code sends a column that doesn't exist in `schema.sql`, it will silently fail or error.

## Step 3 — Fix what you find in the code

Edit source files (in `src/`) to fix the issues. Do not modify `src/lib/schema.sql` unless specifically asked — instead, generate the ALTER TABLE / DROP POLICY / CREATE POLICY SQL that the user needs to run in Supabase.

## Step 4 — Output

Provide:
1. A list of code fixes applied (file + line)
2. A SQL block the user should run in Supabase SQL Editor to fix database-side issues:

```sql
-- Paste into Supabase SQL Editor
...
```
