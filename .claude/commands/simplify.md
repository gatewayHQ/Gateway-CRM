Review recently changed files in this codebase for code quality, then fix every issue you find automatically.

## What to examine

Run `git diff HEAD --name-only` to get the list of changed files, then read each one fully. If there are no staged/unstaged changes, read the files from the most recent commit (`git diff HEAD~1 --name-only`).

## What to look for and fix

**Duplication & reuse**
- Repeated logic that can be extracted into a shared helper or hook
- Inline styles / class names repeated 3+ times that should be a constant or component
- Copy-pasted blocks that differ only by variable — refactor to a parameterized function

**React-specific**
- State variables that could be derived (remove the state, compute inline)
- Missing or incorrect `useEffect` dependency arrays
- Components that re-render unnecessarily — memoize with `React.useMemo` / `React.useCallback` only where there's a measurable cost
- Prop drilling through 3+ levels — consider lifting state or a context

**Supabase / data fetching**
- Missing `.select()` columns (fetching `*` when only 2-3 fields are used)
- No error handling on a query that could fail
- Sequential awaits that could run in `Promise.all`
- RLS-sensitive queries where a missing fallback (`|| null` on UUIDs) would cause a constraint error

**General JS/JSX**
- `var` → `const`/`let`
- Loose equality `==` → `===`
- Long functions (>40 lines) that do two unrelated things — split them
- Dead code: unused variables, imports, functions, branches
- Magic numbers/strings that should be named constants

**Security**
- User input rendered with `dangerouslySetInnerHTML` without sanitisation
- Credentials or secrets hardcoded in source

## How to fix

- Edit every file that has issues — don't just list them.
- Keep fixes minimal: change only what is necessary, don't rewrite working logic.
- After all edits, run `npm run build` (or `npx vite build`) and fix any build errors introduced by your changes.
- Summarise what you changed in a short bullet list at the end.
