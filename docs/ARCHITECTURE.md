# Gateway CRM — Frontend Architecture

How the browser app is layered, which way dependencies point, and where new
code goes. `api/` (Vercel functions) is out of scope here.

## Layers

```
 ┌──────────────────────────────────────────────────────────────┐
 │ Composition root   src/App.jsx                               │  wires hooks → layout → routes
 ├──────────────────────────────────────────────────────────────┤
 │ Presentation       src/app/layout/*, src/pages/*,            │  render state, raise events
 │                    src/components/*                          │
 ├──────────────────────────────────────────────────────────────┤
 │ Application        src/app/workspace/use*.js,                │  React state machines that
 │ (hooks)            src/app/notifications/use*.js,            │  drive the use cases
 │                    src/app/useAppNavigation.js               │
 ├──────────────────────────────────────────────────────────────┤
 │ Use cases / rules  src/app/workspace/loadWorkspace.js,       │  pure functions — no React,
 │                    src/app/navigation.js,                    │  no DOM; unit-tested
 │                    src/app/launchIntent.js, src/lib/*.js     │
 ├──────────────────────────────────────────────────────────────┤
 │ Data access        src/lib/services/*.js                     │  every Supabase read/write;
 │                                                              │  client passed in (testable)
 ├──────────────────────────────────────────────────────────────┤
 │ Infrastructure     src/lib/supabase.js, src/lib/queryCache.js│
 └──────────────────────────────────────────────────────────────┘
```

**Dependency rule:** an import may only point *down* this stack. Pages,
components and hooks never call Supabase directly; services never import
React; pure rule modules import neither.

**Service conventions.** One module per table or aggregate (`dealRecords.js`
is the `deals` row, `contactRecords.js` the `contacts` row, `auth.js` Supabase
Auth, `outlook.js` the Graph connection view, …). Functions return the
Supabase result untouched (`{ data, error, … }` or the builder), so callers
keep their own retries, fallbacks and messages. Most import the shared client;
the older scoped readers (`fetchVisibleDeals`, `upsertContact`, …) take the
client as their first argument so tests can pass a stub, and each has a
shared-client binding (`loadVisibleDeals`, `upsertContactRecord`, …) for pages.

## The app shell (`src/app/`)

```
src/
├── App.jsx                         composition root — no business rules
├── app/
│   ├── navigation.js               nav sections, titles, admin-only/hidden rules,
│   │                               deal-route parsing, mobile tab/More grouping
│   ├── launchIntent.js             ?outlook= / ?deal= / ?contact= / ?preview= → route
│   ├── useAppNavigation.js         route state, focus handoff, nav guards, actions
│   ├── routes.jsx                  route → lazy page, with each page's exact props
│   ├── workspace/
│   │   ├── useAuthSession.js       Supabase auth session
│   │   ├── loadWorkspace.js        boot: identity → visibility → scoped data
│   │   └── useWorkspace.js         boot state, retry, reset, onboarding completion
│   ├── notifications/
│   │   ├── useNotifications.js     unread list + realtime feed + read receipts
│   │   └── NotificationBell.jsx    bell + dropdown (presentational)
│   ├── onboarding/
│   │   └── AgentOnboardingModal.jsx
│   ├── layout/
│   │   ├── Sidebar.jsx, NavItem.jsx
│   │   ├── Topbar.jsx
│   │   └── MobileNav.jsx           bottom bar + More sheet
│   └── __tests__/
├── pages/
│   ├── campaigns/                  mail campaigns: page, form, detail, importer, builders/
│   ├── commission/                 admin back office, commission drawer, charts
│   ├── properties/                 listings: page, drawer, tabs, radius mailing
│   ├── pipeline/                   the deals + listings board
│   │   ├── PipelinePage.jsx        board shell, views (board/list/focus), filters
│   │   ├── boardFilters.js         which deals/listings the board shows (pure)
│   │   └── listingStatus.js, ListingCard.jsx, StageHeader.jsx
│   └── deal/                       the deal drawer (board + deal page share it)
│       ├── DealDrawer.jsx          Details tab + tab host
│       ├── CommissionFields.jsx
│       ├── DealTermsTab.jsx, KeyDatesTab.jsx, ChecklistTab.jsx, PortalTab.jsx
│       ├── DocumentsTab.jsx, RequiredFormsPanel.jsx, dealStorage.js
│       └── signatures/             Signatures tab + BoldSign send flows
│           ├── SignaturesTab.jsx, SignaturesGettingStarted.jsx, SignatureDialogs.jsx
│           ├── SendFromTemplateModal.jsx, DraftReviewStep.jsx, templateFields.js
│           ├── SendSignatureModal.jsx, BoldSignStepModal.jsx
│           └── boldsignDocs.js, signatureSteps.js
└── lib/services/
    ├── agents.js                   roster, team splits, identity claim, profile create
    ├── notifications.js            agent_notifications reads/writes/realtime
    ├── dealChecklist.js            seed a deal's transaction checklist
    ├── dealContacts.js             deal_contacts reconcile / reload / selectors
    └── …                           (existing: deals, contacts, properties, …)
```

## Conventions

- **Services take the client as their first argument**
  (`fetchAgentRoster(supabase)`), so tests pass a stub instead of mocking modules.
- **Rules are pure functions** next to the feature that owns them
  (`buildNav`, `readLaunchIntent`, `findAgentForUser`). Hooks call them; tests
  call them directly.
- **Adding a screen:** one lazy import and one entry in `ROUTES`
  (`src/app/routes.jsx`), one entry in the relevant `NAV_*` list and `TITLES`
  (`src/app/navigation.js`). Nothing in `App.jsx` changes.
- **Adding a boot-time dataset:** add the fetch to `loadScopedData` and the key
  to `EMPTY_DB` (`src/app/workspace/loadWorkspace.js`).

## Roadmap — applying the same pattern to the rest

Ordered by payoff. Each step is behavior-preserving and can ship on its own.

1. ~~**`pages/Pipeline.jsx`** (≈7.6k lines).~~ **Done:** split into
   `pages/pipeline/` (board) and `pages/deal/` (drawer, tabs, `signatures/`),
   with its data helpers moved to `lib/services/dealChecklist.js` and
   `dealContacts.js`. Its remaining inline queries move in step 2.
2. ~~**Direct Supabase calls in pages**~~ **Done:** ~240 calls in 48 files
   moved into `lib/services/`. Pages, components and hooks no longer call
   `supabase.from/rpc/storage/channel/auth`; the only UI-layer imports of the
   client are the shell hooks that inject it into client-parameterised
   services (`agents.js`, `notifications.js`). Remaining lib-level users:
   `lib/audit.js`, `lib/webhooks.js`, `lib/om.js`.
3. ~~**`Campaigns.jsx`, `Commission.jsx`, `Properties.jsx`**~~ **Done:** split
   into `pages/campaigns/` (with `builders/`), `pages/commission/` and
   `pages/properties/`, the same way as Pipeline.
4. **The `db` / `setDb` prop** is threaded through every page. Once pages read
   through services, replace it with a `WorkspaceContext` exposing typed
   selectors and mutations, so a page re-renders only for the slice it uses.
