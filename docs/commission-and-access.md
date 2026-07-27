# Commissions, Admin Access & Mailing Scoping — Design

Senior-architect notes for the three capabilities shipped together: a complex
commission engine, firm-wide office-admin access, and per-agent campaign
visibility. Written design-first; the implementation mirrors it.

## 1. System architecture (unchanged shape, hardened seams)

```
React SPA (Vite)                         Vercel serverless (/api/*)        Supabase
─────────────────                        ──────────────────────────        ─────────────
Commission.jsx ─┐                                                          Postgres
Campaigns.jsx ──┼─ supabase-js (anon, RLS) ─────────────────────────────▶  • commissions
Team/AgentDrawer┘                                                          • agents
                └─ fetch /api/campaigns ── service key (bypasses RLS) ───▶  • mailings
src/lib/commission.js  ← pure engine, no I/O (shared by editor + reports)
```

- **Trust boundaries.** Browser → Supabase carries the user's JWT and is subject
  to RLS. Browser → `/api/*` hits functions that hold the service key and must
  therefore enforce product rules themselves (the mailing scope filter lives
  here; DB-level RLS on `mailings` is the eventual hard backstop).
- **One math module.** `src/lib/commission.js` is pure and is imported by both
  the editor drawer and every report rollup, so the number an agent sees while
  editing is exactly what the dashboard sums. It is unit-checkable in isolation.

## 2. Commission data model

A transaction is two stacked concepts:

- **Sides** — where commission comes from. `{ key, label, rate_pct, flat,
  referral_pct, referral_flat }`. A side is priced **either** by rate **or** by a
  flat fee (`flat > 0` wins) — flat-fee pricing is normal on commercial/BOV work
  where the fee doesn't scale with price.
  One side for a normal deal; two when the brokerage double-ends
  (listing + buyer). A referral lives on the side it actually applied to, which
  is the only correct way to model "the listing was referred in, the buyer side
  wasn't."
- **Participants** — who splits the net. `{ agent_id, role, allocation_pct,
  split_pct, no_split, fee }`. Each agent carries their **own** brokerage
  arrangement: `no_split` agents keep 100% of their allocation (capped out / a
  referred co-agent who owes the house nothing); others split with the house.
  Participants are independent — a co-agent never carves down the primary's take.

- **Transaction fee** — a flat per-deal brokerage fee (default $100), split
  evenly across the agents on the deal ($50 each for two). It is charged **on
  top** of the split and is **excluded from the annual cap** — the cap measures
  only the brokerage split. A per-agent `fee > 0` overrides that agent's share.

```
net = Σ(side.gross − side.referral)
fee_share = transaction_fee / (number of paying agents)
for each participant:
  allocation  = net × allocation_pct
  txn_fee     = participant.fee > 0 ? participant.fee : fee_share
  split_take  = no_split ? allocation : allocation × split_pct
  take        = split_take − txn_fee
  house_split = allocation − split_take      ← counts toward the agent's cap
  house      += house_split + txn_fee        (+ any unallocated net)

cap progress = Σ house_split   (transaction fees never count toward cap)
```

Stored as two `jsonb` columns on `commissions` (`sides`, `participants`). The
legacy flat columns remain and are written as a best-effort mirror;
`normalizeCommission` upgrades any old row on read, so existing deals render
identically until re-saved. This keeps one row per deal (no schema churn) while
being extensible — a `commission_splits` child table is the natural next step if
per-participant reporting outgrows client-side aggregation.

### Where the numbers come from — precedence

Three layers, highest first:

1. **The commissions row** an admin saved — sides, participants, splits,
   referrals, overrides. Authoritative the moment it exists.
2. **The agent's own entry on the deal** — `deals.agent_comp_type`
   (`'rate' | 'flat'`) plus `agent_comp_rate_pct` **or** `agent_comp_flat`,
   entered on the deal form at creation. This is the deal's default
   compensation, so the office no longer has to open every transaction just to
   record the agent's cut. Resolved by `dealCompensation(deal)`.
3. **The firm default** — `DEFAULTS.GROSS_PCT` (3%) with the agent's stored
   `default_split_pct`. What every pre-0024 deal still uses.

`breakdownForDeal()` reports which layer priced a deal as
`comp_source: 'admin' | 'agent' | 'default'`, and flags flat pricing as
`is_flat` — the Back Office tracker uses both (an `AGENT-SET` tag, and `flat`
instead of a meaningless percentage in the GC % column).

**Who may write layer 2.** The agent sets it while creating the deal (or fills it
in on a deal that predates the field); after that it is admin-only. Splits,
overrides and every later change stay entirely with the office. This is enforced
in the database by the `deals_guard_agent_comp` trigger (migration 0024), not
just in the form — a co-listed agent or a sharing team peer who can otherwise
edit the deal can never touch another agent's compensation, whatever client
issues the write. The deal form mirrors the same rule: the fields are hidden from
other agents and rendered read-only once locked.

### Worked example — 400 S Mulberry ($345,000)
Listing 3% w/ 20% referral + buyer 2%; Nic keeps 100% of 60%, Daniel 40% @ his split.

| | |
|---|---|
| Gross (5%) | $17,250 |
| Referral (listing only, 20% of 3%) | −$2,070 |
| **Net to split** | **$15,180** |
| Nic — 60% allocation, no split | **$9,108** |
| Daniel — 40% allocation, his split − fee | his take |
| Brokerage | the remainder |

### Earnings chart — what it shows and how it's computed

`src/components/EarningsChart.jsx` draws an agent's commission income over time
on **My Earnings** (and, for admins, on Back Office → **Agent Earnings** for any
agent or the firm). One bar per period, stacked into the two ways a deal can be
priced: **% commission** (green) and **flat fee** (blue).

- **What a bar is worth** — the sum of `agentSliceForDeal(...).take` for the
  deals that CLOSED in that period, i.e. the agent's take after sides, referrals,
  allocation, their brokerage split and transaction fees. It is the same function
  My Earnings' table, the deal page and the brokerage report use, so admin
  overrides and splits are already baked in. Open deals earn nothing and are not
  charted (they still show in the table as projected).
- **Rate vs flat** — `is_flat` from the resolved breakdown. A deal with any
  flat-priced side counts as flat, matching how the tracker suppresses the
  meaningless "%" reading for those deals.
- **When a deal counts** — `deals.updated_at` (fall back: `created_at`) for a
  deal in the `closed` stage. That is the same closing timestamp the cap tracker
  and the monthly chart already use.
- **Buckets** — `src/lib/earnings.js` (`resolveRange` + `buildEarningsSeries`).
  Presets: last 30 days and last 3 months by Monday-based week, last 12 months
  and this year by month, plus a custom range that picks weeks up to ~4 months and
  months beyond. Empty periods are kept, so the timeline reads as time rather
  than as a list of paydays.
- **Where it's aggregated** — server-side for the agent
  (`/api/portal?action=my-earnings&range=…` returns a ready-made `series`), so a
  large book of business never ships row-by-row to a phone; in the browser for
  the admin view, which already holds every deal and commission. Same pure
  functions either way.
- **Privacy** — the endpoint has no `agent_id` parameter: the caller's JWT
  decides whose numbers come back, so one agent cannot request another's chart.
  Only admins get the agent picker, and it runs on data the DB already lets them
  read.
- **Interaction** — hover or keyboard-focus a bar for a tooltip (period, total,
  rate/flat split, top deals); click or press Enter to filter the deals table
  below to that period. Bars are `role="button"` with a full aria-label, and the
  same numbers are repeated in a visually-hidden table for screen readers.

No charting dependency: it's one inline `<svg>` whose width is measured from its
container (so labels stay 10px on a phone instead of being scaled into mush) and
which scrolls horizontally only when bars would fall below 30px.

## 3. Admin access

`agents.is_admin` (explicit flag, back-filled from any role containing "admin").
On login `App.jsx` loads the firm-wide tables for admins — deals, contacts,
properties, commissions, activities. Documents and BoldSign e-signature
documents are deal-scoped (`eq('deal_id', …)`), so an admin who can open every
deal can see every document and signature without extra plumbing. Tasks stay personal — a
to-do list is not oversight data.

## 4. API design — mailing scope

`GET /api/campaigns?action=list`:
- `all=1` → every mailing (admin).
- `agent_id=<id>` → mailings where the agent is the owner (`agent_id`) **or** a
  collaborator (`landing_config.agent_ids` contains the id).
- neither → `[]` (fail closed; never leak the full list before identity loads).

The client passes `all=1` for admins, else its `activeAgent.id`. Collaboration is
already modeled in `landing_config.agent_ids`, so "shared if you work on it"
needs no new column.

## 5. Caching strategy

- Static assets: `immutable, max-age=1y` (hashed filenames). `index.html`:
  `no-store` so deploys are picked up immediately.
- `/api/*`: `no-store`, except the public OG/scan HTML which is
  `s-maxage=3600, stale-while-revalidate=86400` at the Vercel edge — crawler
  previews are cacheable, authenticated data is not.
- App data: in-memory query cache in `App.jsx`; the commission engine is pure so
  results are trivially memoizable per (deal, commission) pair.

## 6. Migration

`migrations/0005_commission_structured_admin.sql` — additive only, idempotent,
safe to run anytime. Adds the jsonb columns, the per-agent split defaults, and
`is_admin` (back-filled). Nothing about existing deals changes until edited.

`migrations/0024_deal_agent_compensation.sql` — additive only, idempotent. Adds
the three `deals.agent_comp_*` columns, their CHECK guards (rate 0–100, flat ≥ 0,
and "the chosen type must carry its amount", which is what keeps rate and flat
mutually exclusive at rest), and the `deals_guard_agent_comp` trigger. Existing
deals have all three columns NULL, so every current number is unchanged until an
agent sets a value. Until it is applied, the deal form saves without the
compensation and says so, and `my-earnings` falls back to the pre-0024 columns.
