# Production Deployment & Operations — Gateway CRM

Senior-DevOps reference for shipping and running this app in production. It is
written for the stack the app actually uses — a **Vite SPA + Vercel serverless
functions + Supabase (Postgres/Auth/Storage)** — not a generic microservice
template. Kubernetes is deliberately *not* the primary target: a static SPA with
a dozen edge functions doesn't need an orchestrator, and adding one would only
add failure surface and cost. A container path is documented as a
disaster-recovery fallback.

---

## 1. Infrastructure architecture

```
                    ┌──────────────────────────────────────────────┐
   End users ─────▶ │  Vercel Edge (global CDN + TLS + WAF)         │
   (web/mobile)     │   • Static SPA assets  (immutable, 1y cache)  │
                    │   • index.html         (no-store)             │
                    │   • Rewrites: SPA fallback, OG bot previews,  │
                    │     /m/:token scan, /share/:id                │
                    └───────────────┬──────────────────────────────┘
                                    │
              ┌─────────────────────┼───────────────────────────┐
              ▼                                                   ▼
   ┌────────────────────────┐                      ┌──────────────────────────┐
   │ Vercel Functions /api/* │  service-role key    │  Supabase                │
   │  (≤12, Hobby limit)     │ ───────────────────▶ │  • Postgres (RLS)        │
   │  campaigns, cron,       │                      │  • Auth (JWT)            │
   │  docusign, email-send,  │   anon key + JWT     │  • Storage (headshots,   │
   │  twilio-*, portal, …    │ ◀─── browser ──────▶ │    campaign-images)      │
   │  Cron: sequence(9:00),  │                      │  • Realtime (notifs)     │
   │        reminders(8:00)  │                      └──────────────────────────┘
   └───────────┬─────────────┘
               │  outbound
               ▼
   Twilio (SMS) · Mailchimp/SMTP (email) · DocuSign (e-sign) · Anthropic (AI)
```

**Trust boundaries**
- **Browser → Supabase**: carries the anon key + the user's JWT; every table is
  guarded by **RLS**. This is the hard security boundary.
- **Browser → /api/***: functions hold the **service-role key** (bypasses RLS),
  so they must enforce product rules themselves (e.g. mailing scope, portal
  token checks). Treat every function as internet-facing and untrusted-input.
- **Public landing/advisor pages** (`/lp/*`, `/advisor/:id`, `/portal/:token`)
  read with the anon key only; they rely on permissive read policies for the
  specific public tables (agents, mailings, lead_captures insert).

**State**: all durable state is in Supabase. The container/edge tier is
stateless and disposable — this is what makes horizontal scaling trivial.

---

## 2. Deployment workflow

Trunk-based, PR-gated, with Vercel's immutable deployments providing instant
rollback.

```
feature branch ──PR──▶ CI (build + checks) ──▶ Vercel Preview deploy (per-PR URL)
        │                                                  │
        │                                          manual QA on preview
        ▼                                                  ▼
   review + approve ───────────merge to main───────▶ Vercel Production deploy
                                                           │
                                              (bad deploy?) │ instant rollback
                                                           ▼  to prior immutable build
```

- **Preview deploys**: every PR gets an isolated URL wired to the same Supabase
  project (or a staging project — see §7). QA there before merge.
- **Production**: merging to `main` triggers the production deploy.
- **Rollback**: Vercel keeps every build immutable. Promote a previous
  deployment from the dashboard or `vercel rollback` — seconds, no rebuild.
- **DB migrations** are decoupled from app deploys and are **expand/contract**:
  additive migrations (all of `migrations/0001`–`0006` are additive/idempotent)
  ship *before* the app that needs them, so old and new app versions both run
  against the same schema during the deploy window. Never drop a column in the
  same release that stops writing it.

---

## 3. CI/CD pipeline

Current CI lives in `.github/workflows/ci.yml` (build + the Hobby ≤12 function
guard). Recommended production-grade pipeline:

```yaml
# .github/workflows/ci.yml  (target state)
name: CI
on:
  pull_request: { branches: [main] }
  push:         { branches: [main] }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci --no-audit --no-fund
      - name: Lint            # add when eslint is wired
        run: npm run lint --if-present
      - name: Function budget  # Vercel Hobby hard limit
        run: |
          COUNT=$(find api -maxdepth 1 -type f \( -name '*.js' -o -name '*.ts' \) | wc -l)
          [ "$COUNT" -le 12 ] || { echo "::error::$COUNT functions > 12"; exit 1; }
      - name: Build
        run: npm run build
        env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
      - name: Smoke test       # build artifact serves + key routes 200
        run: npx serve -s dist -l 5000 & sleep 2 && npx --yes wait-on http://localhost:5000
```

**Pipeline principles**
- **Fail fast & cheap**: lint → budget check → build → smoke, cheapest first.
- **Reproducible installs**: `npm ci` against the committed lockfile.
- **Deploy is Vercel's job**, not the workflow's — the GitHub↔Vercel
  integration handles preview/prod deploys, keeping secrets out of CI logs.
- **Migrations in CI** (optional next step): run `supabase db push` against a
  throwaway branch DB to catch broken SQL before it reaches staging.

---

## 4. Container / Kubernetes fallback (DR only)

The repo already ships a hardened path for running the SPA off-Vercel:

- `Dockerfile` — multi-stage (node:20 build → nginx:1.27 runtime), **non-root
  user**, `/healthz` HEALTHCHECK, SPA fallback + cache headers via
  `docker/nginx.conf`.
- `docker-compose.yml` — local full-stack run; `--profile api` adds `vercel dev`
  for the function surface.

Run locally / on any container host (Fly.io, Cloud Run, Render, ECS):

```bash
docker compose up --build         # SPA on :8080, /healthz for probes
```

If a Kubernetes target is ever mandated, the shape is intentionally boring
because the tier is stateless:

```
Deployment (2–3 replicas, the nginx image)
  ├─ readiness/liveness probe → GET /healthz
  ├─ resources: requests 50m/64Mi, limits 200m/128Mi
  └─ HorizontalPodAutoscaler: target 70% CPU, min 2 / max 10
Service (ClusterIP) ─▶ Ingress (TLS via cert-manager) ─▶ CDN
Secrets: VITE_* baked at build time (public anon key only — safe);
         service-role key NEVER in the SPA image, only in the API tier.
```

The serverless functions do **not** containerize cleanly 1:1 — if leaving
Vercel, port `/api/*` to a small Node/Express service or Supabase Edge
Functions. This is DR scope, not day-one.

---

## 5. Monitoring & logging

| Layer | Tool | What it watches |
|-------|------|-----------------|
| Frontend RUM | `@vercel/analytics` + `src/lib/perf.js` (Web Vitals, already wired in `main.jsx`) | FCP/LCP/TTI vs. the targets in `perf.js`, route timings, cache hit rate |
| Errors | `ErrorBoundary` (in place) → wire to **Sentry** | Unhandled SPA exceptions, function errors, source-mapped stacks |
| Functions | Vercel function logs + log drain → **Logflare/Datadog** | Per-invocation latency, 5xx rate, cold starts, cron success |
| Database | Supabase dashboard + `pg_stat_statements` | Slow queries, connection saturation, index hit rate |
| Uptime | **Better Uptime / Pingdom** on `/` + `/api/cron` health | External availability, TLS expiry, cron heartbeats |
| Delivery | Twilio / Mailchimp / DocuSign dashboards + webhook logs | Send failures, bounce/opt-out, envelope status |

**Recommended alerts (page → Slack/email):**
- Function 5xx rate > 2% over 5 min.
- p95 function latency > 2s over 10 min.
- Supabase connections > 80% of pool.
- A daily cron (`sequence` 09:00, `reminders` 08:00) didn't report success.
- LCP p75 > 2.5s (regression budget).

**Logging hygiene**: never log the service-role key, JWTs, PII, or lead phone
numbers. Structured JSON from functions; redact at the edge.

---

## 6. Reliability, downtime & scaling

**Reduce downtime risk**
- Immutable deploys + instant rollback (§2) make the recovery path one click.
- Additive/idempotent migrations (§2) mean a deploy never requires a
  maintenance window; the app degrades gracefully when a column is missing
  (the agent editor and commission engine both have explicit fallbacks).
- `ErrorBoundary` keeps a single component crash from white-screening the app.
- Public pages fail **closed** (e.g. mailing scope returns `[]` before identity
  loads) so a bug leaks nothing.

**Improve reliability**
- Idempotent webhooks (Twilio/DocuSign): dedupe on provider event id.
- Retries with backoff on outbound provider calls; circuit-break a dead
  provider rather than stacking timeouts.
- Backpressure on AI/email/SMS endpoints (rate-limit per agent/IP).

**Scaling**
- SPA assets scale on the CDN for free (immutable, 1-year cache; hashed
  filenames bust correctly on deploy).
- Functions autoscale per-request on Vercel; keep them stateless and fast to
  avoid cold-start tax — the ≤12 budget is enforced in CI.
- **Postgres is the real bottleneck**: rely on RLS-friendly indexes, add a
  connection pooler (Supabase **PgBouncer**/Supavisor in transaction mode) so
  bursty function concurrency doesn't exhaust connections, and push reporting
  rollups to the client or materialized views rather than N+1 queries.
- Storage (headshots/images) is CDN-served from Supabase — no app involvement.

**Backups / DR**
- Supabase daily automated backups + **PITR** on a paid plan; periodically
  test a restore into a scratch project.
- IaC the Vercel/Supabase config (env vars, RLS policies in `schema.sql`,
  migrations in `migrations/`) so the whole stack is reproducible from git.
- RTO target: < 30 min (rollback or container fallback). RPO: ≤ 24h (≤ 5 min
  with PITR).

---

## 7. Environments & secrets

| Env | Branch | Supabase | Notes |
|-----|--------|----------|-------|
| Preview | every PR | staging project | Safe to seed/wipe |
| Production | `main` | prod project | PITR + alerts on |

- **Public (browser) env**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` only.
  These ship in the bundle — they are *meant* to be public; RLS is the guard.
- **Server-only secrets** (Vercel env, never `VITE_`-prefixed): service-role
  key, Twilio, Mailchimp/SMTP, DocuSign, Anthropic. See `.env.example`.
- Rotate the service-role key on any suspected exposure; it bypasses RLS.

---

## 8. Production deployment checklist

**Before first production cutover**
- [ ] Run migrations `0001`→`0006` against the prod Supabase project (in order).
- [ ] Verify RLS is **enabled** on every table; spot-check anon cannot read
      deals/commissions/contacts; confirm anon *can* read `agents`, `mailings`
      and insert `lead_captures` (public pages depend on this).
- [ ] Set all server secrets in Vercel (service-role, Twilio, Mailchimp,
      DocuSign, Anthropic); confirm none are `VITE_`-prefixed.
- [ ] Set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for Production.
- [ ] Custom domain + TLS attached; `index.html` is `no-store`, `/assets/*`
      immutable (already in `vercel.json`).
- [ ] Confirm function count ≤ 12 (CI gate) and crons registered (sequence,
      reminders).
- [ ] Create at least one `is_admin` agent (migration 0005) for oversight.
- [ ] Seed agent profiles with bio/photo/tagline/stats so `/advisor/:id` and the
      "Meet your advisor" sections render.

**Every release**
- [ ] CI green (build + function budget + smoke).
- [ ] Migrations applied (additive) **before** the app deploy.
- [ ] QA on the PR preview URL: a public landing page, a form submission, and an
      advisor profile load.
- [ ] Watch function error rate + Web Vitals for 15 min post-deploy.
- [ ] Rollback plan confirmed (previous deployment is one click away).

**Smoke (post-deploy, prod)**
- [ ] `/` loads and authenticates.
- [ ] `/lp/valuation/:id`, `/lp/multifamily/:id` render correctly on mobile +
      desktop and submit a lead.
- [ ] `/advisor/:id` renders bio/stats/contact and the email-signature link works.
- [ ] A test SMS/email/DocuSign send succeeds; webhooks land.
- [ ] Crons report success the next morning.
```
