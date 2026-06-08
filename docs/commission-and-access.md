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

- **Sides** — where commission comes from. `{ key, label, rate_pct, referral_pct,
  referral_flat }`. One side for a normal deal; two when the brokerage double-ends
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

## 3. Admin access

`agents.is_admin` (explicit flag, back-filled from any role containing "admin").
On login `App.jsx` loads the firm-wide tables for admins — deals, contacts,
properties, commissions, activities. Documents and DocuSign envelopes are
deal-scoped (`eq('deal_id', …)`), so an admin who can open every deal can see
every document and signature without extra plumbing. Tasks stay personal — a
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
