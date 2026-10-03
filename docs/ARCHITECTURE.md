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

**Dependency rule:** an import may only point *down* this stack. Layout
components never import Supabase; services never import React; pure rule
modules import neither.

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
└── lib/services/
    ├── agents.js                   roster, team splits, identity claim, profile create
    ├── notifications.js            agent_notifications reads/writes/realtime
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

1. **`pages/Pipeline.jsx` (≈7.6k lines, 45 direct `supabase.from` calls).**
   Split into `pages/pipeline/` — board, deal drawer, drawer tabs as separate
   modules — and move its queries into `lib/services/deals.js` /
   `dealStage.js` / `documents.js`, which already exist.
2. **Direct Supabase calls in pages** (~39 `.jsx` files). Move each into the
   matching `lib/services/*` module. Start with `Properties.jsx` (25),
   `Sequences.jsx` (13) and `ColdCalls.jsx` (12).
3. **`Campaigns.jsx` (≈2.9k) and `Commission.jsx` (≈1.2k):** same treatment as
   Pipeline — a folder per page, presentational pieces separated from data.
4. **The `db` / `setDb` prop** is threaded through every page. Once pages read
   through services, replace it with a `WorkspaceContext` exposing typed
   selectors and mutations, so a page re-renders only for the slice it uses.
