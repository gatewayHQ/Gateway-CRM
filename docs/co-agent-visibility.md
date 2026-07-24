# Visibility: Co-Agent + Admin Partner Links — Design & Components

How Gateway CRM decides — and shows — **who can see which deals, contacts, and
properties**, and the one sanctioned way to widen that.

> **The rule (everyone).** An agent sees a deal / contact / property only when
> they **own** it or are tagged on it as a **co-agent**.
>
> **Partner links (admin-only).** An admin can pair two agents; each then sees
> the other's **full book** (all deals, contacts, properties). Agents cannot
> create, accept, enable, or disable a link — it is strictly admin-controlled.
> Sharing a *team* grants nothing.

---

## 0. Investigation first — what already existed

Two passes, before writing code.

| Area | State before this work |
|---|---|
| **Co-agent tagging + filtering (deals)** | ✅ Already shipping (`commissions.participants[]`, legacy `deals.co_agent_ids[]`, `fetchCoListedDealIds`, RLS `app_visible_deal_ids()`). |
| **Co-agent-only default for deals** | ✅ Shipped earlier in this branch (removed the team-peer branch). |
| **Co-agent-only default for contacts & properties** | ❌ Not present — still scoped to `self + team-peers-who-share` via `team_splits.share_contacts/share_properties`. |
| **Agent-to-agent Partner / share-all / visibility-link** | ❌ **None anywhere.** "partner" in the codebase only ever meant a *spouse contact* or commission narration. Fully new. |
| **Feature flags/config for any of it** | None. |

**Conclusion:** the co-agent plumbing was solid and is reused; the Partner
concept and the contacts/properties default were genuinely missing. The Partner
link slots into the existing `app_visible_agent_ids()` seam — we swap the
visibility *source* from team-peer share-flags to admin-created links — so the
change is surgical rather than a rewrite.

---

## 1. One rule, one engine

`src/lib/visibility.js` is the pure single source of truth. It answers *why* a
record is visible, and the same function backs both the fetch scoping and the
badge:

```
OWN       record.<ownerField> === me                       → priority 1
CO_AGENT  me tagged on it (deals: participant / co_agent_ids) → priority 2
PARTNER   the owner is an admin-created Partner of mine       → priority 3
NONE      none of the above — must never render for a member
```

`ownerField` is `agent_id` for deals, `assigned_agent_id` for contacts and
properties (see `ENTITY` presets). Highest-priority reason wins, so the badge
shows the most personal explanation.

---

## 2. Architecture & data flow

```
Supabase
  agent_partners (admin-only writes, RLS)      ← the ONLY visibility-widening data
  app_partner_agent_ids()  = my partners
  app_visible_agent_ids()  = self ∪ partners   ← used by deals/contacts/properties RLS
  app_visible_deal_ids()   = admin | own/partner-owned | co-listed
        │
        ▼
src/lib/services/{deals,partners}.js
  fetchPartnerLinks → partnerAgentIds(links, me) = partnerIds
  fetchTaggedDeals({ agentId, ownerIds:[me,...partners] }) → { deals, coAgentDealIds }
        │
        ▼
src/App.jsx (load)
  visibleAgentIds = dealAgentIds = [me, ...partnerIds]   → scopes contacts/properties/deals
  db.partnerIds, db.coAgentDealIds stored for badging
        │
        ▼
src/lib/visibility.js  ← pure rule (own / co-agent / partner / none)
  └─ src/components/VisibilityBadge.jsx     why-visible chip (icon + text)
src/pages/Pipeline.jsx   deal cards show a badge + a relationship filter (own/co-agent/partner)
src/pages/DealPage.jsx   header "your role" badge + "who can see this" note
src/pages/Team/PartnerManager.jsx  AdminPartnerManager — create/remove links (admin-only)
```

Because every surface reads the shared, already-scoped `db.*`, the rule is
enforced everywhere at once. The **co-agent experience lives where agents work**
— Pipeline and the deal page — rather than in a separate tab (an earlier "My
Deals" view was removed as redundant with Pipeline; see the changelog).

### Folder structure (this feature)
```
src/
├─ lib/
│  ├─ visibility.js                    # pure rule + ENTITY presets + types
│  └─ services/
│     ├─ deals.js                      # fetchTaggedDeals({ ownerIds })
│     └─ partners.js                   # fetch/create/remove links + partnerAgentIds
├─ components/VisibilityBadge.jsx      # reusable why-visible badge
└─ pages/
   ├─ Pipeline.jsx                     # per-card badge + relationship filter (integrated)
   ├─ DealPage.jsx                     # "your role" badge + who-can-see note
   └─ Team/PartnerManager.jsx          # AdminPartnerManager (admin-only)
migrations/0025_agent_partners.sql     # table + RLS + visibility functions
```

---

## 3. Props / API design

### `visibility.js` (pure)
```ts
type VisibilityReason = 'own' | 'co-agent' | 'partner' | 'none'
type Visibility = { reason: VisibilityReason, partnerId?: string }
const REASON: { OWN, CO_AGENT, PARTNER, NONE }
const ENTITY: { deal, contact, property }   // { ownerField, coAgentField }

recordVisibility(record, { agentId, ownerField?, coAgentField?, coAgentIds?, partnerIds? }): Visibility
isVisible(record, ctx): boolean
partitionVisible(records, ctx): { visible, leaked, byId: Map<id, Visibility> }
reasonLabel(reason): string
```

### `partners.js` (service)
```ts
fetchPartnerLinks(client): Promise<{ data, error }>          // RLS: my pairs, or all for admins
partnerAgentIds(links, agentId): string[]                    // bidirectional
createPartnerLink(client, { agentA, agentB, createdBy }): Promise<…>  // admin-only (RLS)
removePartnerLink(client, id): Promise<…>                    // admin-only (RLS)
```

### Pipeline integration (in `Pipeline.jsx`)
`recordVisibility` powers a memoised `dealVisibility(deal)` used for two things:
a **relationship filter** in the toolbar (All / Mine / Co-agent / Partner —
shown to non-admins only, and only once they actually have shared-in deals) and
a **per-card badge** on co-agent/partner deals. The filter drives `visibleDeals`,
so every view (Board / List / Focus) honours it, and the empty state is
filter-aware ("No deals you're a co-agent on" → "Show all deals").

### `<VisibilityBadge reason partnerName? compact? />`
Reusable on any deal/contact/property surface. Every variant is icon **+ text**
(never colour alone); the PARTNER variant names the partner ("Partner · Nic").

### `<AdminPartnerManager agents activeAgent isAdmin onChange />`
The **only** UI for Partner links. Renders `null` for non-admins; writes are
additionally blocked by RLS, so the gate is real, not cosmetic. Create (two
agent selects) / list / remove (confirm). `onChange` lets the host re-scope the
session after a change.

---

## 4. Consuming the backend

The API is assumed to return only rows the caller may see; the frontend
**re-verifies**:

1. **Fetch** partner-scoped rows — contacts/properties via `.in('assigned_agent_id', [me,...partners])`; deals via `fetchTaggedDeals({ ownerIds:[me,...partners] })` (adds co-listed).
2. **Classify** each row with `recordVisibility`; any `NONE` is a **leak** — hidden and surfaced in a quarantine banner, never shown.
3. **Badge** from the same classification, so the label always matches the scope.

RLS is the hard backstop (`migrations/0025`): `agent_partners` is admin-write-only,
and `app_visible_agent_ids()`/`app_visible_deal_ids()` resolve visibility from
partners — so even a raw query can't cross the line.

---

## 5. Security — the admin-only Partner rule (non-negotiable)

- **DB-enforced.** `agent_partners` ships with RLS on: `agent_partners_admin_write`
  allows insert/update/delete **only** when `app_is_admin()`. A non-admin's
  create/remove fails at Postgres regardless of the UI.
- **UI-gated.** `AdminPartnerManager` returns `null` for non-admins and is only
  mounted on the admin path of the Team page.
- **No agent self-service.** There is no request/accept/enable/disable flow —
  by design, agents have zero ability to widen their own or anyone's visibility.
- **Order-normalized pairs** (`agent_a < agent_b` + unique) mean a pair can't be
  double-linked from opposite sides.

---

## 6. Edge cases handled

- **Own + co-agent + partner overlap** → single, highest-priority reason (OWN > CO_AGENT > PARTNER).
- **Partner link added/removed mid-session** → the admin's session re-scopes via `onChange`; the hook re-derives on `db.partnerIds` change. Other agents pick it up on their next load (documented; realtime propagation is out of scope).
- **Multiple co-agents / multiple partners** → all resolved; the badge always reflects *the viewer's* reason.
- **Admin** → sees the whole firm; the relationship filter/badges are hidden for admins (they aren't scoped, so "why visible" doesn't apply).
- **Legacy vs structured co-agent tags** → both honored; the RLS migration includes the legacy `co_agent_ids` branch only where the column exists.
- **Loading / empty** → skeletons + `role=status`; "No deals/contacts/properties you can see" with an explanatory message.

---

## 7. Accessibility (WCAG 2.1 AA)

Icon **+ text** badges (1.4.1) · cards are real controls (`role=button`,
`tabIndex=0`, Enter/Space, `:focus-visible`, descriptive `aria-label`; 2.1.1 /
2.4.7) · labelled `role=group` filter of `aria-pressed` buttons · loading via a
polite live region, skeletons `aria-hidden` · quarantine `role=alert` · Partner
Manager selects have real `<label htmlFor>` and the remove button an
`aria-label` naming both agents · `prefers-reduced-motion` disables hover lift
and shimmer.

---

## 8. Stack decision (JSX, not TS + Tailwind)

Gateway CRM is 100% JSX with a global `--gw-*` token stylesheet and shared
primitives (`components/UI.jsx`). Introducing TypeScript tooling + Tailwind for
one feature would fragment the build and component vocabulary. The senior call
is to match the codebase — JSX + tokens — and express contracts as JSDoc
`@typedef`/`@param` (real editor intellisense, no compiler). Types are shown in
TS notation here for review; the code ships them as JSDoc.

---

## 9. Usage

```jsx
// AdminPartnerManager is mounted on the Team page for admins only:
<AdminPartnerManager agents={agents} activeAgent={activeAgent} isAdmin={isAdmin} onChange={refreshPartners} />

// Classify + badge any record (deal, contact, or property) — this is exactly
// how Pipeline and DealPage show "why can I see this":
import VisibilityBadge from './components/VisibilityBadge.jsx'
import { recordVisibility, REASON, ENTITY } from './lib/visibility.js'

const v = recordVisibility(deal, {
  agentId: activeAgent.id, ...ENTITY.deal,
  coAgentIds: new Set(db.coAgentDealIds), partnerIds: new Set(db.partnerIds),
})
{v.reason !== REASON.NONE && (
  <VisibilityBadge reason={v.reason}
    partnerName={v.reason === REASON.PARTNER ? agents.find(a => a.id === v.partnerId)?.name : undefined} />
)}
```
