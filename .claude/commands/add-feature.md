Add a new feature to the Gateway CRM. Argument: `$ARGUMENTS`

The argument should describe the feature in plain English, e.g.:
- `email history tab on contact drawer`
- `bulk assign contacts to agent`
- `export properties to CSV`
- `deal activity timeline`

## Step 1 — Understand the request

Parse the argument to determine:
1. Which page(s) are affected (`Contacts`, `Properties`, `Pipeline`, `Tasks`, `Templates`, `ColdCalls`)
2. Whether it requires a new Supabase table, new columns on an existing table, or purely frontend state
3. Whether it touches the DocuSign integration, email templates, or reporting

## Step 2 — Read existing code

Read the affected page file(s) fully. Also read:
- `src/components/UI.jsx` — available UI primitives (Drawer, Modal, Badge, Avatar, Icon, SearchDropdown, pushToast, etc.)
- `src/lib/schema.sql` — existing tables and columns
- `src/lib/supabase.js` — client setup
- `src/lib/helpers.js` — utility functions

Do not reinvent what already exists. Use existing components and helpers.

## Step 3 — Plan before coding

Write a short implementation plan (5–10 bullet points) covering:
- What new state variables are needed
- What Supabase queries are needed
- What UI components will be added/modified
- Any SQL required (new table, new column, new RLS policy)

Present the plan and wait for the user's confirmation before writing code. If the feature is straightforward (< 50 lines of new code), you may skip the confirmation step.

## Step 4 — Implement

Follow these conventions from the existing codebase:
- Use functional React components with hooks, no class components
- Use `pushToast(message)` for success and `pushToast(message, 'error')` for errors
- Use `supabase.from(table).select/insert/update/delete` — no raw SQL from the frontend
- Coerce empty-string UUID fields to `null` before sending to Supabase
- If adding a new table, write the `CREATE TABLE` and RLS policies and present them to the user as SQL to run in Supabase
- Match the existing visual style: card-based layouts, `var(--gw-*)` CSS variables for colors

## Step 5 — Verify

After implementing, run `npm run build` to confirm no build errors. Report what was added and any SQL the user needs to run in Supabase.
