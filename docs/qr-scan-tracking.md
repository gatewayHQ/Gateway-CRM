# QR scan tracking

How a scan of a mailer's QR code becomes a recorded, attributed, reportable
event — and what guarantees each step makes.

The governing requirement is **zero lost scans**. Everything below follows from
it.

---

## The path a scan takes

```
  phone camera
      │
      ▼
  GET /m/{token}                      ← never cached, at any layer
      │
      ▼
  api/campaigns.js  ?action=scan
      │
      ├─ classify        bot / prefetch / duplicate?      (flagged, never dropped)
      ├─ enrich          device, OS, browser, city, region
      │
      ▼
  record_mailing_scan()               ← ONE atomic round trip
      │  resolves the token
      │  inserts the scan row  (caller-supplied primary key)
      │  bumps mailings.scan_count    (atomic increment)
      │
      ├── confirmed ──▶ 302 → /lp/{type}/{id}?v={visit}
      │
      └── NOT confirmed ─▶ 302 → /lp/{type}/{id}?v={visit}&sr={signed replay}
                                        │
                                        ▼
                                 landing page re-reports it
                                 (same scan id → absorbed if it landed)
```

## The five guarantees

### 1. Nothing on the scan path is ever cached

`/m/{token}` responses carry `Cache-Control: no-store`, `CDN-Cache-Control`,
`Vercel-CDN-Cache-Control` and `Vary: User-Agent`, set both in the handler and
in `vercel.json`.

This is not a micro-optimisation, it is the single largest source of lost scans
that was found. The crawler branch used to answer link-preview bots with
`Cache-Control: public, s-maxage=3600` **on the `/m/{token}` URL itself**, with
no `Vary`. Vercel's edge caches by URL. So one preview fetch — someone texting
the short link, posting it in Slack, sending it in iMessage — installed a
cached response, and for the next hour **every real scan of that QR code was
served by the CDN and never reached the function**. No error, no log line, the
redirect still worked; the campaign's numbers just stopped moving. The links
that get shared the most were the ones that went dark.

Note that the `/api/(.*)` no-store rule in `vercel.json` does *not* cover this:
header rules match the **incoming** path, and a scan arrives at `/m/{token}`
before the rewrite. That is why `/m/(.*)` needs its own rule.

### 2. The write is awaited, not fired and forgotten

The previous implementation kicked off the insert **after** `res.end()` had
already flushed the 302. On Vercel the instance can be frozen or reclaimed the
moment a response completes, so every scan write was racing the runtime.

Now the write is awaited under a latency budget (`SCAN_WRITE_BUDGET_MS`,
default 1500ms). In the normal case this costs one fast round trip and is
imperceptible; the scanner is never held longer than the budget.

### 3. Concurrent scans cannot lose each other

The counter was previously bumped with a read-modify-write: `scan_count` was
read at the top of the request and `read + 1` written back at the end. Two scans
that overlapped both read *N* and both wrote *N+1*.

Measured on a local PostgreSQL with 150 simultaneous scans:

| path | scans stored | counter | lost |
|---|---|---|---|
| old (read-modify-write) | 150 | **46** | **104 (69%)** |
| new (`record_mailing_scan`) | 150 | **150** | **0** |

The new counter is an atomic `scan_count = scan_count + 1` inside the same
statement that stores the row, so concurrent scans serialize on the row and
every one of them counts.

### 4. An unconfirmed write is still not a lost scan

If the write can't be confirmed inside the budget, the scanner is redirected
anyway and the scan rides along as a **signed replay payload** (`?sr=`), which
the landing page re-reports (`src/lib/scanTracking.js`).

The scan's primary key is minted by the server *before* the write, and the
replay carries that same id. So:

- write never landed → the replay lands it
- write did land → the replay collides on the primary key and is absorbed

At-least-once delivery, exactly-once storage. The payload is HMAC-signed and
time-limited, so a replay can recover a real scan but cannot forge one.

If the database is unreachable enough that even the *destination* can't be
resolved, the scanner gets a small self-retrying page rather than an error — the
scan is captured once the database recovers.

### 5. Nothing is ever thrown away

Bot hits, link previews, prefetches and rapid repeats are **stored and flagged**
(`is_bot`, `bot_reason`, `is_duplicate`), never dropped. Headline counts filter
them out at read time; the Scans tab can show them.

This matters because filtering decisions are guesses. A UA pattern that turns
out to be too aggressive costs nothing if the rows are still there — it can be
re-run. A dropped row is gone.

---

## The half that is not the scan path: rendering the landing page

A scan is only half the job. The 302 above hands the visitor a
`/lp/{type}/{id}` URL, and **that URL is served by the SPA, not by this
function** — `vercel.json`'s catch-all rewrite sends it to `index.html`, and
`src/main.jsx` mounts the matching `Landing*` component. (The only exception is
the social-crawler rewrite, which routes `/lp/*` to `?action=og` by user-agent.)

So the two halves run in different places on different credentials:

| | where it runs | credential |
|---|---|---|
| `/m/{token}` | serverless function | **service key** (bypasses RLS) |
| `/lp/{type}/{id}` | the visitor's browser | **anon key** (RLS applies) |

That split caused a live outage worth remembering. Migration 0027 closed
`mailings` to `anon` — correctly; it holds `qr_token`, `description` and the
denormalized counters — on the stated assumption that `/lp/*` was served by this
function. It wasn't. All four `Landing*` pages were calling
`supabase.from('mailings')` from the browser, and **RLS filters rather than
errors**, so the select came back with zero rows and every scanner saw
"Listing not available" on a perfectly healthy campaign. Scans kept recording
the whole time, so the dashboards looked fine and nothing logged an error.

The fix is `?action=landing&id={uuid}` — a service-key read of exactly the four
fields those pages render (`id, name, agent_id, landing_config`), reached through
the shared `src/lib/publicMailing.js` helper. Two rules keep it safe:

- **Never widen that projection to `*`.** `qr_token` would then be readable by
  anyone who can open a landing page — i.e. every scanner of every QR code — and
  a token is all you need to forge scans against a campaign.
- **A public page must never read an RLS-closed table with the anon key.**
  `src/lib/__tests__/publicPageDataAccess.test.js` enforces this by scanning the
  pages `main.jsx` mounts, so the next table lockdown fails the build instead of
  silently emptying a public page.

The same 0027 breakage hit three non-QR surfaces, all now fixed the same way:
`/listing/:id` (read `properties` in the browser), `/share/:id` and
`/api/listings` (both ran server-side but **presented the anon key** — a
serverless function is privileged by the key it presents, not by where it runs).
The listings feed was the sneakiest: it returned `{ listings: [], count: 0 }`, a
200 that every embedded widget renders as "no listings" rather than as an error.
That second flavour has its own check in the same test file.

To see what a given database's posture actually is, run the read-only
`scripts/db-verify/public_read_posture.sql` in the Supabase SQL Editor.

The handoff itself is covered end to end by
`api/__tests__/campaigns-scan-to-landing.test.js`, which follows the real
`Location` header through the real route regex into the real landing fetch. The
bug above survived a green suite precisely because every test covered one half or
the other and none followed the redirect.

---

## Attribution with one QR code per campaign

Every mailer in a drop carries the **same** QR code. That is a deliberate
product decision, and it bounds what can honestly be claimed:

**What cannot be known:** which recipients scanned. There is no per-piece
signal, so any "X% of your recipients scanned" figure would be invented.

The old UI showed exactly that — and because the underlying per-recipient
columns were never written by any code, it always read **0%** for every
campaign.

**What is reported instead:**

| metric | meaning |
|---|---|
| **Response index** | scans per 100 pieces mailed — a drop-level rate, not a per-person one |
| **People** | distinct visitors (`visitor_hash`, monthly-rotating salt) |
| **Scan → lead conversion** | share of scans that submitted the landing form |
| **Attributed leads** | leads tied to a *specific* scan via `visit_id` |

**How a conversion is tied to a scan.** The redirect carries a `visit_id`. The
landing page stores it for the session and sends it with the form submission.
`link_visit_conversion()` then joins the lead to the scan row.

If that person also matches a contact **already on the campaign's recipient
list**, the link is extended to the mail piece: `mailing_scans.recipient_id` and
the recipient's `scan_count` / `first_scanned_at` / `last_scanned_at` are
populated. This is the only path that writes those columns, and it is
deterministic — a contact match, never a guess from geography.

Location shown in the UI is labelled as approximate and derived from network
location. It is never used to attribute a scan to an address.

---

## Reporting

Counting moved out of JavaScript and into SQL:

| endpoint | function |
|---|---|
| `?action=list` | `mailing_stats(uuid[])` |
| `?action=analytics` | `mailing_analytics(uuid, days)` |
| `?action=dashboard` | `mailing_dashboard(agent, all, days)` |
| `?action=live` | direct windowed query |

The old versions fetched raw rows and tallied them in the function. Past
PostgREST's row cap (1,000 by default on Supabase) the totals silently stopped
growing — a busy campaign's numbers would simply plateau, with no error. They
also pulled the whole scan table across the wire on every page load.

`?action=dashboard` is also now **scoped** to the calling agent, matching the
campaign list beneath it. It previously aggregated the entire brokerage for
everyone.

---

## Operations

**Nightly reconcile.** `/api/cron?task=scan-reconcile` (04:00 UTC) runs
`reconcile_mailing_counters()`, which repairs any drift between the denormalized
counters and the event tables. The counters are a cache; the event tables are
the truth. It is a no-op when nothing has drifted.

**Environment.**

| variable | default | purpose |
|---|---|---|
| `SCAN_WRITE_BUDGET_MS` | `1500` | how long to wait for write confirmation before falling back to replay |
| `SCAN_SIGNING_SECRET` | service key | HMAC key for replay payloads |
| `VITE_PUBLIC_LINK_DOMAIN` | current origin | branded short-link domain for printed QR codes |

**QR generation** is local (`src/lib/qr.js`, the `qrcode` package). It was
previously an `<img>` pointing at `api.qrserver.com`, which meant the codes an
agent printed depended on a free third party being up at that moment, and handed
every campaign's destination URL to it on every render. Downloads are produced
as Blobs, so they work offline and always yield a real file. Error correction
defaults to level Q (~25%) because print gets scuffed, folded and photographed
at an angle.

---

## Verifying it

Database-level (56 assertions, real PostgreSQL):

```bash
createdb crm_qr_verify
psql -d crm_qr_verify -v ON_ERROR_STOP=1 -f scripts/db-verify/supabase_shim.sql
psql -d crm_qr_verify -v ON_ERROR_STOP=1 -f src/lib/schema.sql
psql -d crm_qr_verify -f scripts/db-verify/qr_scan_matrix.sql
dropdb crm_qr_verify
```

Application-level:

```bash
npx vitest run api/__tests__/campaigns-scan.test.js api/__tests__/campaigns-handler.test.js
```

`campaigns-handler.test.js` includes explicit regression tests for the cache
poisoning bug — if someone reintroduces a cacheable response on `/m/`, those
fail.

---

## If scans ever look wrong again

1. **Check the response headers on a short link first.**
   `curl -sI https://<domain>/m/<token>` — anything other than `no-store` in
   `Cache-Control` means scans are being served from cache and lost. This is the
   failure mode with no error message.
2. **Compare stored rows to the counter.** `select reconcile_mailing_counters();`
   reports how many campaigns had drifted. Repeated non-zero results mean
   something is writing scan rows outside the RPC.
3. **Look for `scan write unconfirmed` in the logs.** Emitted whenever the write
   misses its budget. A burst means the database is slow — the replay path is
   covering it, but the latency budget may need raising.
4. **Check `source = 'replay'` volume.** Visible per-scan in the Scans tab as
   "recovered". A rise means unconfirmed writes are becoming common.
5. **Bot filtering too aggressive?** Nothing was lost — the rows are all still
   there. Compare `raw_scans` against `scans` in `mailing_stats`, and adjust
   `GENERIC_BOTS` in `api/campaigns.js`.
