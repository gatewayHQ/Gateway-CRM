# Gateway CRM — Deployment & Operations

> Senior DevOps reference for the Gateway CRM production environment.
> Last updated: 2026-05-20

---

## 1. Infrastructure Architecture

```
                        ┌────────────────────────────┐
                        │  GitHub (gatewayhq/        │
                        │  Gateway-CRM)              │
                        └──────────────┬─────────────┘
                                       │  push / PR
                  ┌────────────────────┴────────────────────┐
                  │                                         │
        ┌─────────▼─────────┐                     ┌─────────▼─────────┐
        │ GitHub Actions CI │                     │  Vercel           │
        │ - build           │                     │  - Preview / Prod │
        │ - syntax check    │                     │  - Edge Network   │
        │ - audit           │                     │  - Serverless fns │
        │ - fn-count guard  │                     │  (api/*.js)       │
        └───────────────────┘                     └─────────┬─────────┘
                                                            │
                          ┌─────────────────────────────────┼──────────────────┐
                          │                                 │                  │
                ┌─────────▼─────────┐                       │       ┌──────────▼─────────┐
                │ Supabase          │                       │       │ Third-party APIs   │
                │  - Postgres       │◄──────service key─────┘       │ Resend (email)     │
                │  - Auth           │                               │ Twilio (SMS)       │
                │  - Storage        │                               │ BoldSign           │
                │  - RLS policies   │                               │ Bitly  (QR codes)  │
                └───────────────────┘                               │ Anthropic (AI)     │
                                                                    └────────────────────┘
```

### Components

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React 18 + Vite, served via Vercel Edge CDN | SPA UI |
| API | Vercel Serverless Functions (Node 20) | Backend, max **12** functions on Hobby |
| Database | Supabase Postgres (us-east-1) | Tables, RLS, real-time |
| Auth | Supabase Auth | Agent login, JWT sessions |
| Object storage | Supabase Storage | OM docs, attachments |
| Email | Resend | Transactional + campaign blasts |
| SMS / Voice | Twilio | Outbound SMS, webhooks |
| E-signature | BoldSign | Listing agreements |
| AI | Anthropic Claude | Lead scoring, OM generation |

### Regions

- **Vercel**: edge-cached globally; functions execute in `iad1` (us-east-1).
- **Supabase**: `aws-us-east-1` (co-located with Vercel functions → <5 ms DB latency).
- **DR target**: Dockerfile + `docker-compose.yml` allow lift to Fly.io / Render / Cloud Run if Vercel is unavailable.

---

## 2. Deployment Workflow

### Git branching

- `main` — production. Auto-deployed by Vercel.
- `claude/*` / feature branches — preview deployments via Vercel PR comments.

### Standard flow

1. Open PR against `main` → GitHub Actions CI runs (build, audit, syntax check, function-count guard).
2. Vercel posts a preview URL on the PR.
3. Author + reviewer test on the preview URL.
4. Merge to `main` → Vercel builds + deploys to production (typical: 90 s).
5. Smoke-test `/api/listings?action=health` and the Campaigns tab.

### Rollback

- Vercel → Deployments → click the prior successful deployment → **Promote to Production**.
- Rollback completes in < 30 s (DNS-level swap; no rebuild).
- Database changes: see *Schema Migrations* below — never auto-rolled.

### Hotfix path

1. Branch from `main`, fix, push.
2. PR + merge once CI passes — same as standard flow.
3. If site is fully down: `vercel rollback` from CLI (< 30 s).

---

## 3. CI/CD Pipeline

### `.github/workflows/ci.yml`

Runs on every PR and push to `main`:

- **Build** the SPA against placeholder env vars (catches syntax + build-time errors).
- **Function-count guard** — fails the build if `api/*.js` > 12 (Hobby plan limit).
- **Syntax-check** each API handler with `node --check`.
- **Bundle-size check** — warns if the main bundle > 250 KB gzipped.
- **`npm audit`** at `high` severity, production deps only.

### `.github/dependabot.yml`

- Weekly grouped PRs for npm minor/patch.
- Monthly bumps for GitHub Actions.
- Major-version updates ignored (require human review).

### Vercel

- Production deployment is **automatic on push to `main`**.
- Preview deployments are **automatic on every PR**.
- Build command, output dir, framework, headers, and rewrites are pinned in `vercel.json`.

---

## 4. Monitoring & Logging

### Health check

`GET /api/listings?action=health`

Returns 200 (healthy) / 503 (degraded) with a JSON payload:
```json
{
  "status": "healthy",
  "service": "gateway-crm",
  "version": "b491fa6",
  "env": "production",
  "region": "iad1",
  "checks": { "supabase": { "ok": true, "latency_ms": 23 } },
  "timestamp": "2026-05-20T14:32:00.000Z"
}
```

> Folded into `listings.js` instead of its own endpoint to stay within the
> Hobby plan's 12-function ceiling.

### Uptime monitoring

Configure an external monitor (UptimeRobot / Better Stack / Cronitor — free tier sufficient) to:
- `GET https://<domain>/api/listings?action=health` every 60 s
- Page on 3 consecutive failures or `status != "healthy"`

### Structured logs

`api/_lib/observability.js` exports `wrap()` and `log` helpers. Every wrapped
handler emits one JSON line per request to stdout:

```json
{"ts":"2026-05-20T14:32:00.000Z","level":"info","service":"gateway-crm","msg":"campaigns ok","action":"create_campaign","method":"POST","status":200,"duration_ms":142,"req_id":"iad1::abc123"}
```

Vercel ingests these automatically. To export off-platform, add a **Log Drain**
in the Vercel dashboard pointing at Datadog / Logflare / Better Stack.

### Error tracking

Errors are logged as `level: "error"` with truncated stack traces. For
full-fidelity error tracking, add the Vercel Sentry integration (one click;
does not consume a function slot) — Sentry's wrapper reads stdout/stderr.

### Performance budgets

| Metric | Target | Hard limit |
|--------|--------|------------|
| Main JS bundle (gzip) | < 200 KB | 250 KB (CI warns) |
| `/api/listings?action=health` p99 | < 300 ms | 1000 ms |
| Campaigns analytics query | < 500 ms | 2000 ms |
| First Contentful Paint | < 1.5 s | 3 s |

---

## 5. Reliability

### Already implemented

- **Schema-tolerant API** — `api/campaigns.js` retries inserts with the offending
  column removed when Supabase reports a missing column. Lets the app keep
  working through partial migrations.
- **Suppression list** — global DNC enforcement before every send.
- **Frequency caps** — per-campaign send limits prevent runaway outreach.
- **Idempotent webhook routing** — `/api/boldsign` handles both action calls
  and BoldSign webhooks based on payload shape.
- **Optimistic UI** — pushToast() pattern; failures roll back cleanly.

### Recommended next steps

- **Database backups**: Supabase Pro auto-snapshots daily. On Free tier, run a
  weekly `pg_dump` via GitHub Actions to S3 / R2.
- **Circuit breaker** for third-party APIs (Resend, Twilio, BoldSign) — return
  cached fallback when 5xx rate > 50 % over 5 min.
- **Rate limiting** on `/api/email-send` and `/api/twilio-send` via Upstash
  Redis (10 req/min/agent) to cap blast-radius of credential theft.
- **CSP headers** — tighten `vercel.json` to disallow inline scripts once we
  audit all our `style={{}}` patterns.

---

## 6. Downtime Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Vercel outage | Dockerfile + nginx.conf ready; emergency deploy to Fly.io takes ~10 min |
| Supabase outage | App is read-mostly; cache reads in localStorage with stale-while-revalidate |
| Bad deploy | Vercel one-click rollback (< 30 s) |
| Migration breaks schema | Schema-tolerant API auto-degrades; CI lints schema.sql for destructive ops |
| Function quota exhausted | CI fails if `api/*.js` > 12; consolidate before merging |
| Secrets leaked | Rotate via Vercel env-var UI; `SUPABASE_SERVICE_KEY` is server-only |
| Email blast misfire | Frequency caps + suppression list enforced server-side |
| Vendor API key revoked | Health check surfaces degraded status within 60 s |

---

## 7. Scaling

### Today

- **Frontend**: Vercel Edge CDN handles unlimited reads.
- **API**: Vercel Hobby gives 100 GB-hours/month; current usage is < 5 %.
- **DB**: Supabase Free supports 500 MB, 2 GB egress/month — current < 10 %.

### Triggers to upgrade

| Threshold | Action |
|-----------|--------|
| > 100 active agents | Move Vercel to Pro ($20/mo) → 1000 functions, longer timeouts, crons |
| > 50 MB DB | Move Supabase to Pro ($25/mo) → daily backups, no auto-pause |
| > 100 sends/hour sustained | Add Upstash Redis ($0–10/mo) for rate limiting + job queue |
| > 10 K page views/day | Enable Vercel Analytics ($10/mo) for real-user metrics |

### Horizontal scaling

- Serverless functions scale to zero and out automatically — no manual capacity planning.
- Supabase connection pool handles 60 concurrent connections on Free, 200 on Pro.
- For burst email blasts, batch into chunks of 100 with a 1 s pause between
  to stay under Resend's 100 req/s ceiling.

---

## 8. Schema Migrations

- Single source of truth: `src/lib/schema.sql`.
- CI lints for `DROP TABLE` / `TRUNCATE` — those require human review.
- **Migration playbook**:
  1. Add new column with `ADD COLUMN IF NOT EXISTS … DEFAULT …`.
  2. Deploy app code that *optionally* reads/writes the column (schema-tolerant pattern).
  3. Run migration in Supabase SQL Editor.
  4. Ship code that *requires* the column once column is in place everywhere.

This three-step pattern lets us deploy app and DB independently with zero downtime.

---

## 9. Secrets Management

All secrets live in Vercel **Project → Settings → Environment Variables**:

| Variable | Scope | Purpose |
|----------|-------|---------|
| `SUPABASE_URL` | All | Server-side Supabase client |
| `SUPABASE_SERVICE_KEY` | Server-side only | Service role; bypasses RLS — **never** expose to frontend |
| `VITE_SUPABASE_URL` | Build-time | Frontend Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | Build-time | Frontend anon key (safe to expose) |
| `RESEND_API_KEY` | All | Email delivery |
| `RESEND_FROM` | All | Verified sender domain |
| `TWILIO_ACCOUNT_SID` | All | SMS |
| `TWILIO_AUTH_TOKEN` | All | SMS |
| `BOLDSIGN_API_KEY` | All | E-signature |
| `BITLY_ACCESS_TOKEN` | All | QR code generation |
| `ANTHROPIC_API_KEY` | All | AI features |
| `GATEWAY_CRON_SECRET` | All | Authenticates internal scheduled jobs |
| `ALLOWED_ORIGIN` | All | CORS allowlist (defaults to "*" until configured) |

**Rotation**: rotate `SUPABASE_SERVICE_KEY` and `ANTHROPIC_API_KEY` quarterly
or immediately on contributor offboarding.

---

## 10. Production Deployment Checklist

Use this checklist before promoting any significant change to production.

### Pre-deploy

- [ ] PR has at least one approving review
- [ ] CI is green (build, audit, function count, syntax)
- [ ] Vercel preview tested manually for the affected feature
- [ ] If touching DB: migration written, idempotent (`IF NOT EXISTS`), tested on a Supabase branch
- [ ] If adding a new third-party integration: env vars added to Vercel for *both* Preview and Production
- [ ] If adding a new API file: confirm `api/*.js` count is still ≤ 12
- [ ] If adding a feature flag: documented in this file
- [ ] Performance budget respected (CI bundle-size check did not warn)
- [ ] No `console.log` debug stubs left in shipped code

### Deploy

- [ ] Merge PR to `main`
- [ ] Watch Vercel build logs for warnings
- [ ] Wait for build to complete (~ 60–120 s)

### Post-deploy verification

- [ ] `GET /api/listings?action=health` returns 200
- [ ] Hard-reload the SPA — no console errors
- [ ] Smoke-test the affected feature
- [ ] If DB migration ran: spot-check a few rows
- [ ] Check Vercel function logs for new error spikes (first 5 min after deploy)
- [ ] Notify the team in #releases with a one-line summary + commit hash

### Rollback (if issues found)

- [ ] Vercel dashboard → previous deployment → Promote to Production
- [ ] Confirm health endpoint returns 200
- [ ] Open a tracking issue with the failure mode
- [ ] DB changes: assess whether to roll forward (preferred) or roll back the migration

---

## 11. Local Development

```bash
# Frontend only (talks to deployed APIs / Supabase)
npm install
npm run dev                       # http://localhost:5173

# Full stack with Vercel emulation
npm install -g vercel
vercel dev                        # http://localhost:3000

# Docker (matches production runtime closely)
docker compose up web
docker compose --profile api up   # also starts vercel dev for /api
```

Required `.env.local`:
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
RESEND_API_KEY=...
```

---

## 12. Incident Response

**On-call rotation**: TBD (currently single-maintainer)

**Severity ladder**:
- **SEV-1** — site down, data loss, leaked credentials → rollback immediately, notify all stakeholders
- **SEV-2** — major feature broken (e.g., can't create campaigns) → rollback or hotfix within 1 hour
- **SEV-3** — minor bug, no data impact → fix in next regular deploy

**Communication**: post in #releases (or temporary group chat) with:
1. What's broken
2. Who's affected (% of agents)
3. Mitigation in progress
4. ETA to resolution

**Post-incident**: write a short blameless retro within 48 h — root cause,
detection time, recovery time, action items.
