Perform a thorough code review. The argument determines what to review:

**Argument:** `$ARGUMENTS`

## Determine review target

- **No argument** → review local uncommitted changes: run `git diff HEAD` and `git diff --cached`
- **A number (e.g. `123`)** → review GitHub PR #`$ARGUMENTS` using `mcp__github__pull_request_read` for the PR and `mcp__github__get_file_contents` for changed files
- **A URL** → extract the PR number from the URL and do the same as above

If reviewing a PR, fetch the full diff and read the relevant source files for context. Also read `src/lib/schema.sql` and `src/lib/supabase.js` to understand the data layer.

## Review checklist

Work through every changed file. For each one, check:

### Bugs & correctness
- Logic errors: off-by-one, wrong operator, incorrect condition
- Async mistakes: missing `await`, unhandled Promise rejection, race condition
- State mutation: directly mutating React state instead of returning new objects
- Null / undefined dereference: accessing `.foo` on a value that could be null
- Wrong dependency arrays in `useEffect` / `useCallback` / `useMemo`

### Supabase & RLS
- UUID columns receiving empty string `""` instead of `null` (causes `invalid input syntax for type uuid` error)
- Values that bypass the `check` constraint (e.g. a `type` column receiving a value not in the allowed list)
- INSERT without `.select()` when the caller needs the returned row
- RLS policy mismatch: INSERT succeeds but SELECT returns nothing because policies differ
- Missing `|| null` coercion on optional foreign-key fields

### Security
- User-controlled input used in a Supabase query without parameterisation
- Secrets or API keys hardcoded in source files
- `dangerouslySetInnerHTML` used without sanitisation
- CORS headers that are too permissive on API routes

### Edge cases
- Empty array / empty string / zero handled differently from `null`/`undefined`
- What happens when `activeAgent` is null (not yet loaded)?
- What happens when Supabase returns an error object instead of data?
- What if a user has no `assigned_agent_id`?

### Style & maintainability
- Function longer than 60 lines doing two unrelated things
- Variable names that don't convey intent
- Commented-out code left in
- Console logs left in production paths

## Output format

Write your review as:

```
## Files reviewed
- list each file

## Issues found

### [Severity: Critical / High / Medium / Low] — short title
File: `path/to/file.jsx` line N
Description of the problem.
Suggested fix (code snippet if helpful).

---
(repeat for each issue)

## Summary
X critical, Y high, Z medium, W low issues found.
One sentence on the overall quality.
```

Do **not** make any edits to files. This is a read-only review. If the user wants fixes applied, they should run `/simplify` or ask you to fix specific issues.
