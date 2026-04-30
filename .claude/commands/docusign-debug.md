Debug the DocuSign integration in this CRM. Argument (optional): `$ARGUMENTS`

If an argument is provided, treat it as an error message to investigate (e.g. `issuer_not_found`, `invalid_grant`, `consent_required`).

## Step 1 — Read the integration

Read `api/docusign.js` in full to understand the current state of the JWT auth, envelope sending, and status polling.

## Step 2 — Check environment variables

Grep for all DocuSign env vars used:
```
grep -n "process.env.DOCUSIGN" api/docusign.js
```

List each one and what it should contain:
- `DOCUSIGN_INTEGRATION_KEY` — the App's Integration Key (Client ID) from Apps & Keys page
- `DOCUSIGN_ACCOUNT_ID` — the Account ID (not the User ID) from the same page
- `DOCUSIGN_USER_ID` — the User ID of the impersonated user (the admin account)
- `DOCUSIGN_PRIVATE_KEY` — the RSA private key, newlines replaced with `\n`
- `DOCUSIGN_AUTH_SERVER` (optional) — override auth server, e.g. `account-d.docusign.com` for sandbox

## Step 3 — Diagnose by error message

### `issuer_not_found` / `invalid_grant`
The Integration Key in `DOCUSIGN_INTEGRATION_KEY` doesn't match the one in DocuSign, OR the private key doesn't match the RSA keypair registered under that Integration Key.

Fix checklist:
1. Go to DocuSign → Apps & Keys → find your app
2. Copy the **Integration Key** exactly — paste as `DOCUSIGN_INTEGRATION_KEY` in Vercel
3. Under the same app, go to **RSA Keypairs** → Delete the existing keypair → Generate a new one
4. Copy the private key (everything from `-----BEGIN RSA PRIVATE KEY-----` to `-----END RSA PRIVATE KEY-----`)
5. In Vercel: paste as `DOCUSIGN_PRIVATE_KEY`, replacing every real newline with the literal string `\n`
6. Set `DOCUSIGN_AUTH_SERVER=account-d.docusign.com` for sandbox, or remove it for production

### `consent_required`
The user hasn't granted consent for JWT impersonation.
Fix: construct the consent URL:
`https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=YOUR_INTEGRATION_KEY&redirect_uri=https://localhost`
Open it in a browser, log in as the DocuSign admin, click Allow. You only need to do this once per Integration Key.

### `No signature fields / signer received email but nothing to sign`
The tabs are using anchor strings that don't exist in the PDF, and DocuSign silently skips them.
Fix: ensure all tabs use absolute x/y coordinates (`xPosition`, `yPosition`, `pageNumber`) — never `anchorString`.

### `new row violates row-level security policy` on documents table
The `documents` table in Supabase doesn't have an INSERT policy for the current user.
Run in Supabase SQL Editor:
```sql
create policy if not exists "allow_insert" on documents for insert with check (true);
create policy if not exists "allow_select" on documents for select using (true);
```

## Step 4 — Test the integration

Call the debug endpoint to inspect live config:
Suggest the user open their browser console on the deployed app and run:
```javascript
fetch('/api/docusign', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'debug' })
}).then(r => r.json()).then(console.log)
```
This returns `integrationKey`, `userId`, `accountId`, `privateKeyStart`, `privateKeyEnd`, `privateKeyValid` — useful for spotting truncated or malformed keys.

## Step 5 — Report

List what's misconfigured and provide exact step-by-step instructions to fix each item, including the exact Vercel env var names and where to find the values in the DocuSign dashboard.
