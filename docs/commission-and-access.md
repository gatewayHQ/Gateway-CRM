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

  **Where the list comes from before the back office touches it.** Co-agents are
  picked on the *property* (Co-Agents section → `properties.details.co_agent_ids`)
  and copied onto the deal at conversion (`deals.co_agent_ids`, migration 0025).
  Until an admin saves a structured split, `normalizeCommission` seeds one
  participant per co-agent on an even allocation, each with their own stored
  arrangement — so a co-listed deal opens the editor with the whole team on it.
  A saved `sides`/`participants` row always wins, and legacy `co_agent_pct` rows
  keep their exact dollars. Reads go through `src/lib/coAgents.js`, which falls
  back to the linked property for deals converted before 0025 — no backfill
  needed for historical pipelines.

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
properties, commissions, activities. Documents and BoldSign e-signature
documents are deal-scoped (`eq('deal_id', …)`), so an admin who can open every
deal can see every document and signature without extra plumbing. Tasks stay personal — a
to-do list is not oversight data.

### 3ab. Who is on a deal (migration 0055)

An agent sees a deal when **any one** of these says they are on it:

| Record | Where it is set |
|---|---|
| `deals.agent_id` | the deal's own agent — plus team peers who share deals |
| `deals.co_agent_ids` | "Additional Agents" on the deal drawer |
| `properties.assigned_agent_id` | the listing agent, whoever started the deal |
| `properties.details.co_agent_ids` | the Co-Agents section on the listing |
| `commissions.participants` | whoever gets paid on it |

`app_visible_deal_ids()` is that list, and it is the single definition: every
deal-scoped table policy (documents, document versions, BoldSign documents,
signature packet events, transaction steps, deal contacts, field layouts,
template drafts, deadline reminders, closing packets, audit log, nudges) and
every deal-documents storage policy is written as
`deal_id in (select app_visible_deal_ids())`. The deal's buyer and seller come
with it, through `app_visible_contact_ids()`. **Commissions stay admin-only**
even between co-agents on one deal, and tasks stay personal.

**Why the two property rows are there.** `deals.co_agent_ids` is a *copy* of the
listing's co-agents, taken once, when the property is converted into a deal —
and an existing deal never re-seeds. So this sequence:

> create the property → start the deal → **then** add the second agent to the
> listing → upload documents

wrote the second agent to the property and nowhere else. `src/lib/coAgents.js`
read the property as a fallback and put them on the team card; RLS read only the
copy and hid the deal, its documents and its whole history from them. The card
said shared, the database said private, and four migrations of backfilling
could not fix it, because the divergence is re-created every time a listing is
edited after its deal exists. Access is derived from both records now, so there
is nothing to keep in sync for access to work.

**The cache is still kept in step, for a different reason.** The commission
seed, the BoldSign signer prefill, the deal announcement and `/api/portal`
earnings all read `deals.co_agent_ids`. Two triggers
(`trg_property_coagents_to_deals`, `trg_deal_coagents_to_property`) mirror the
two lists in both directions, so those cannot name a smaller team than the deal
page does. A listing edit applies the exact diff (adding a co-agent adds them to
its deals; removing them takes them off); the deal → listing direction only ever
unions, because one property can carry a buyer-side and a seller-side deal.

**The one thing this narrowed.** `properties` used to be
`allow_all_authenticated` for every command: any signed-in agent could rewrite
any listing in the firm. With membership derived from the listing that would be
a self-service grant — write yourself onto a listing, see someone else's deal.
Reads stay firm-wide (the pickers and the duplicate-deal check in 0054 need
them); UPDATE and DELETE now require being on the listing already. Migration
0054's rule still holds: the owner widens the team, never the person wanting in
— `app_request_deal_access()` notifies them and grants nothing.

**Identity comes first.** All of the above resolves through
`app_my_agent_ids()`, which returns every `agents` row belonging to the caller:
the one linked to their login, plus any *unlinked* row carrying the same
verified email. Before that, an agent whose `agents.auth_id` was never set
resolved to NULL, matched no policy, and saw a blank CRM no matter what any
co-agent column said. The nightly audit reports those rows rather than repairing
them (`identity / agents with no login link`).

**The client asks the database.** `src/lib/services/{deals,properties,contacts}.js`
call `app_visible_deal_ids()` / `app_visible_property_ids()` /
`app_visible_contact_ids()` over RPC instead of reimplementing the rule in the
browser. The old client-side filters were a second implementation that drifted:
a deal RLS had already granted was never fetched, so being granted it changed
nothing on screen.

### 3a. Where per-agent split settings are written (and how they used to vanish)

`agents.default_split_pct` / `no_brokerage_split` / `cap_amount` /
`cap_anniversary` / `is_admin` are **guarded columns**: the
`agents_guard_privileged` BEFORE trigger rewrites them back to their old values
for any caller it doesn't recognize as trusted. It does not raise — the UPDATE
reports success having changed nothing.

That produced a bug worth remembering. Trusted-caller detection originally read
only `auth.jwt() ->> 'role' = 'service_role'`. Under Supabase's legacy
service_role key (a JWT) that holds; under the newer `sb_secret_…` keys there
are no JWT claims to read, so the brokerage's own admin endpoint was treated as
hostile and every commission-split edit silently reverted while the UI toasted
"saved". Migration 0027 detects the service role via `current_user` (PostgREST
issues `SET LOCAL ROLE service_role` regardless of key format).

Three rules follow, and they are load-bearing:

1. **Never write these columns straight from the browser.** Go through
   `src/lib/services/agentProfile.js` → `POST /api/portal {action:'profile-save'}`.
   The Team drawer, Back Office caps table, and pipeline header rename all do.
2. **The server verifies the row it gets back.** `verifyPrivilegedWrite()`
   compares the requested privileged fields against the saved row and returns a
   500 naming the offenders if any didn't stick. A frozen write can no longer
   masquerade as a successful one.
3. **Render the saved row, not the request.** Callers merge the `agent` the API
   returns into state. Optimistically merging the *payload* is what made the old
   bug invisible for so long.

`stage_labels` is deliberately outside the guard: renaming your own pipeline
column headers is a display preference, not a permission, so every agent may set
it on their own row.

### 3b. Team splits (`team_splits`)

Separate from an agent's brokerage split. `teams.type` decides whether the
per-member `split_pct` means anything:

- `collaboration` — shared visibility only (`share_contacts` / `share_properties`
  / `share_deals` per member); each agent is paid on their own brokerage split
  and `split_pct` is stored as 0.
- `split` — the team commission is divided by `split_pct`, which the Team modal
  requires to total exactly 100% before it will save.

Membership saves as an **upsert on `(team_id, agent_id)` followed by a prune of
the members actually removed**. The previous delete-then-insert wiped the roster
first, so a failed insert left the team empty — and since no result was checked,
it still reported "Team updated."

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

`migrations/0027_agent_stage_labels_and_split_guard.sql` — **required** for split
edits to persist on projects using Supabase's newer secret keys (see 3a). Also
adds `agents.stage_labels` for per-agent pipeline column headers and asserts the
`(team_id, agent_id)` uniqueness the team-membership upsert relies on. No data is
rewritten.
