# Co-Agent Deal Visibility — Design & Components

How Gateway CRM enforces and communicates the rule that **a team member sees a
deal only when they are personally on it** — as the primary agent, or tagged as
a co-agent. Being on the same team as the owner is not enough.

> Applies to deals and the data that follows a deal (commissions, documents,
> transaction steps, deadlines — all already scoped by `app_visible_deal_ids()`).

---

## 0. Investigation first — what already existed

Before building anything we checked whether this was already implemented and
never shipped. Findings:

| Area | State before this change |
|---|---|
| **Co-agent tagging + filtering plumbing** | **Already built & shipping.** `commissions.participants[].agent_id` (canonical) and the legacy `deals.co_agent_ids[]` are the tags; `src/lib/services/deals.js#fetchCoListedDealIds` reads both; `app_visible_deal_ids()` mirrors it in RLS. |
| **Per-member `share_deals` flag** | Existed (`team_splits.share_deals`, shown as "Pipeline" in the Team modal) but **defaulted to ON**, so every member saw every teammate's deals. It was an opt-out, not a guarantee. |
| **Co-agent-*only* as the enforced default** | **Missing.** `App.jsx` computed `dealPeerIds` from `share_deals !== false` and fetched `own + team-peers + co-listed`. |
| **UI that enforces/communicates the rule** | **Missing.** No component distinguished "deals I'm tagged on" from a teammate's deal. |
| **Dormant/bypassed feature flag for this** | None found. RLS "Phase B" (in `migrations/production/`) enforces the *old* model, not co-agent-only. |

**Conclusion: partially present.** The tagging/filtering layer was solid and
reused; what was missing was making co-agent-only the *enforced default* and the
UI to communicate it. This change closes both with minimal, surgical edits on
top of the existing architecture — no reinvention.

---

## 1. The rule (one definition, reused everywhere)

A non-admin agent may see deal *D* iff:

```
D.agent_id == me                      (I'm the primary agent)      → REL.PRIMARY
OR me ∈ D.co_agent_ids                (legacy co-agent tag)        → REL.CO_AGENT
OR me ∈ commission(D).participants    (structured co-agent tag)    → REL.CO_AGENT
```

Primary **and** tagged → `REL.BOTH`. None of the above → `REL.NONE` (must never
render in a member's view). Admins (office admin / TC) still see the whole firm.

This lives in one pure module, **`src/lib/dealVisibility.js`**, imported by both
the data layer and the UI so the value we *scope on* is the value we *badge*.

---

## 2. Architecture & data flow

```
Supabase (RLS: app_visible_deal_ids — own + co-listed, NO team branch)
   │
   ▼
src/lib/services/deals.js
   fetchTaggedDeals(client,{agentId})  →  { data: deals, coAgentDealIds }
   (own via eq(agent_id) + co-listed via fetchCoListedDealIds; NO team peers)
   │
   ▼
src/App.jsx  (load)
   db.deals           = co-agent-scoped rows            (admins: whole firm)
   db.coAgentDealIds  = subset the agent is co-tagged on (for badging)
   │
   ▼
src/pages/TeamDeals/
   index.jsx  TeamDealsView   ← container: reads db + activeAgent, owns view state
     └ useTaggedDeals.js       ← derives relationship map, counts, leak set (pure/memoised)
        └ src/lib/dealVisibility.js   ← the rule (pure)
     └ DealList.jsx            ← grid · loading skeletons · empty state
        └ DealCard.jsx         ← one deal (presentational, keyboard-accessible)
           └ CoAgentBadge.jsx  ← reusable relationship badge (icon + text)
```

Because every deal surface (Pipeline, Commission, Reports, Dashboard) reads the
same centralized `db.deals`, the scope change fixes them all at once — the new
`TeamDealsView` is the focused, self-explaining surface, not the only one
protected.

### Folder structure

```
src/
├─ lib/
│  ├─ dealVisibility.js              # pure rule + types (single source of truth)
│  └─ services/deals.js              # + fetchTaggedDeals()
└─ pages/TeamDeals/
   ├─ index.jsx                      # TeamDealsView (container)
   ├─ useTaggedDeals.js              # hook: derive relationships/counts/leaks
   ├─ DealList.jsx                   # presentational list + states
   ├─ DealCard.jsx                   # presentational card
   └─ CoAgentBadge.jsx               # reusable badge
```

---

## 3. Props / API design

### `dealVisibility.js` (pure)
```ts
type DealRelationship = 'primary' | 'co-agent' | 'primary+co-agent' | 'none'
const REL: { PRIMARY, CO_AGENT, BOTH, NONE }

dealRelationship(deal, { agentId, coAgentDealIds?, commissions? }): DealRelationship
isTaggedOn(deal, ctx): boolean
partitionTaggedDeals(deals, ctx): { tagged, leaked, byId: Map<id, DealRelationship> }
relationshipLabel(rel): string
```
`coAgentDealIds` accepts a `Set` or array. `commissions` only contributes when
the caller actually has the rows (admins) — members get the co-agent signal
pre-computed via `coAgentDealIds`, so admin-only commission data is never needed
in the browser to badge correctly.

### `useTaggedDeals({ deals, coAgentDealIds?, commissions?, agentId, view? })`
Returns `{ deals (filtered by view), allTagged, leaked, counts, relationshipOf }`.
`counts = { total, primary, coAgent, both }`. Memoised on its inputs, so an
agent switch or a mid-session refresh re-derives without a reload. `view` is one
of `VIEW.ALL | VIEW.PRIMARY | VIEW.CO_AGENT`.

### `<TeamDealsView db activeAgent isAdmin go />`
Container. Reads `db.deals / db.coAgentDealIds / db.commissions / db.agents`,
owns the view filter, renders the explainer, the quarantine banner (members
only), the role filter, and `DealList`. `go(route)` navigates (`deal/:id`).

### `<DealList deals relationshipOf loading agents onOpenDeal emptyTitle emptyMessage emptyAction skeletonCount />`
Presentational. `loading` → skeleton grid + polite live region; empty → shared
`EmptyState`; else a `role="list"` grid of `DealCard`.

### `<DealCard deal relationship agents onOpen />`
Presentational, no state/fetches. `role="button"`, `tabIndex=0`, Enter/Space to
open, descriptive `aria-label`. Leaked deals render with a red `deal-card--leak`
treatment (defensive; should never appear).

### `<CoAgentBadge relationship compact />`
Reusable anywhere a deal is shown (deal page header, pipeline card, etc.).
Icon **and** text for every variant — colour is never the only signal.

---

## 4. Consuming the backend

The frontend assumes the API returns only deals the caller may see, and
**re-verifies** rather than trusts:

1. **Fetch** co-agent-scoped rows via `fetchTaggedDeals` (members) — own
   (`eq('agent_id', me)`) + co-listed (`fetchCoListedDealIds`), no team peers.
2. **Classify** each returned deal with `dealRelationship`; anything that comes
   back `REL.NONE` is treated as a **leak**: hidden from the list and surfaced in
   a quarantine banner instead of being shown. Defense in depth — a looser query
   or a future regression can't silently expose a teammate's deal.
3. **Badge** from the same classification, so the label matches the scope.

RLS is the hard backstop: `app_visible_deal_ids()` (see `src/lib/schema.sql` and
`migrations/0024_deals_coagent_only_visibility.sql`) drops the team-peer branch,
so even a raw query can't return a deal the caller isn't on.

---

## 5. Edge cases handled

- **Primary *and* co-agent** → `REL.BOTH`; counted in both the Primary and
  Co-agent filters; badged distinctly (purple).
- **Multiple co-agents on a deal** → co-agent avatars stack on the card; the
  badge still reflects *the viewer's* relationship.
- **Permission change mid-session** → `useTaggedDeals` is memoised on its
  inputs; when `db.deals` refreshes (Pipeline/Commission refresh paths reuse the
  same `[self]` scope) or the active agent switches, the view re-derives with no
  reload.
- **Admin** → sees the whole firm in Pipeline; `TeamDealsView` shows the deals
  *they* are on and silently omits the rest (not treated as a leak).
- **Legacy vs structured tags** → both `deals.co_agent_ids` and
  `commissions.participants` are honored; the RLS migration includes the legacy
  branch only where the column exists (production), matching `fetchCoListedDealIds`.
- **Loading** → skeleton cards + `role="status"`; **empty** → "No deals you're
  tagged on" with a message explaining teammates' deals stay private.

---

## 6. Accessibility (WCAG 2.1 AA)

- Relationship conveyed by icon **+ text**, not colour alone (1.4.1).
- Cards are real controls: `role="button"`, `tabIndex=0`, Enter/Space, visible
  `:focus-visible` ring, descriptive `aria-label` (2.1.1, 2.4.7).
- Filter is a labelled `role="group"` of `aria-pressed` buttons.
- Loading announced via a polite live region; skeletons are `aria-hidden`.
- Quarantine uses `role="alert"`; explainer uses `role="note"`.
- `prefers-reduced-motion` disables hover lift and skeleton shimmer.

---

## 7. Stack decision (why JSX, not TS + Tailwind)

The brief suggested "React + TypeScript; Tailwind or CSS Modules." Gateway CRM
is **100% JSX with a global design-token stylesheet** (`src/styles/app.css`,
`--gw-*`) and shared primitives in `src/components/UI.jsx`. Introducing
TypeScript tooling and Tailwind for one feature would fragment the build and the
component vocabulary. The senior call is to **match the codebase**: JSX +
existing primitives + design tokens, with **JSDoc `@typedef`/`@param`** giving
real editor intellisense and documented contracts without a compiler. Types are
expressed above in TS notation for review; the code ships them as JSDoc.

---

## 8. Usage

```jsx
// Routed automatically as "My Deals" in App.jsx; to embed elsewhere:
import TeamDealsView from './pages/TeamDeals/index.jsx'
<TeamDealsView db={db} activeAgent={activeAgent} isAdmin={isAdmin} go={setRoute} />

// Reuse the badge on any deal surface:
import CoAgentBadge from './pages/TeamDeals/CoAgentBadge.jsx'
import { dealRelationship } from './lib/dealVisibility.js'
<CoAgentBadge relationship={dealRelationship(deal, { agentId, coAgentDealIds })} />

// Filter a list yourself:
import { partitionTaggedDeals } from './lib/dealVisibility.js'
const { tagged, leaked } = partitionTaggedDeals(deals, { agentId, coAgentDealIds })
```
