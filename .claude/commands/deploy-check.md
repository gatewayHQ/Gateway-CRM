Run a full pre-deployment check on this project before pushing to Vercel. Fix everything that can be fixed in code; report what requires manual action.

## Step 1 — Build check

Run:
```
npm run build 2>&1
```
If the build fails, read the error output carefully and fix the source files causing the errors. Re-run the build to confirm it passes before continuing.

## Step 2 — Environment variable audit

Read `vercel.json` (if it exists) and check for any `env` entries.
Then grep the source for all `import.meta.env.VITE_` and `process.env.` references:
```
grep -rn "import.meta.env\|process\.env\." src/ api/ --include="*.js" --include="*.jsx"
```

List every env var referenced. For each one, note:
- Is it in `.env.example` or `vercel.json`?
- Is it a secret (key, token, password) or a public URL?

Report any that are missing from the Vercel config.

## Step 3 — API route check

Read every file in `api/`. For each serverless function:
- Does it handle CORS (`Access-Control-Allow-Origin`, OPTIONS preflight)?
- Does it validate required inputs before using them?
- Does it return a proper error response (not just throw) if an env var is missing?
- Is there a try/catch around external API calls (DocuSign, etc.)?

Fix any that are missing basic error handling.

## Step 4 — Supabase connectivity

Read `src/lib/supabase.js`. Check:
- Is the URL and anon key hardcoded as fallback (acceptable for dev) or only from env vars?
- Is the client created once and exported (not recreated on each render)?

## Step 5 — Console logs in production paths

```
grep -rn "console\." src/ api/ --include="*.js" --include="*.jsx"
```
Remove any `console.log` / `console.error` that expose sensitive data (tokens, user emails, API responses with secrets). Keep ones that are clearly debug-only and wrapped in a dev check.

## Step 6 — Final report

Output a deploy readiness checklist:

```
✅ Build passes
✅ / ❌ All env vars documented
✅ / ❌ API routes have error handling
✅ / ❌ No secrets in source
✅ / ❌ No build-breaking console errors

## Manual steps required before deploying:
- (list anything that needs human action in Vercel dashboard or Supabase)
```
