// ─────────────────────────────────────────────────────────────────────────────
// Route → screen.
//
// Every page is lazy-loaded, so only the current route's bundle downloads.
// Each route declares exactly the props its page takes: most take the shared
// page context (`ctx.page`), a few take a narrower slice or a one-shot
// handoff. Adding a screen means one lazy import and one entry below.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'
import { HIDEABLE_NAV, isDealRoute, parseDealRoute } from './navigation.js'
import { lazyWithReload } from '../lib/chunkReload.js'

const Dashboard          = lazyWithReload(() => import('../pages/Dashboard.jsx'))
const ContactsPage       = lazyWithReload(() => import('../pages/Contacts.jsx'))
const PropertiesPage     = lazyWithReload(() => import('../pages/properties/PropertiesPage.jsx'))
const PipelinePage       = lazyWithReload(() => import('../pages/pipeline/PipelinePage.jsx'))
const DealPage           = lazyWithReload(() => import('../pages/DealPage.jsx'))
const TasksPage          = lazyWithReload(() => import('../pages/Tasks.jsx'))
const MessagesPage       = lazyWithReload(() => import('../pages/Messages.jsx'))
const CommissionPage     = lazyWithReload(() => import('../pages/commission/CommissionPage.jsx'))
const TemplatesPage      = lazyWithReload(() => import('../pages/Templates.jsx'))
const TeamPage           = lazyWithReload(() => import('../pages/Team/index.jsx'))
const SettingsPage       = lazyWithReload(() => import('../pages/Settings.jsx'))
const LeadsPage          = lazyWithReload(() => import('../pages/Leads.jsx'))
const DataManagementPage = lazyWithReload(() => import('../pages/DataManagement.jsx'))
const ReportsPage        = lazyWithReload(() => import('../pages/Reports.jsx'))
const SequencesPage      = lazyWithReload(() => import('../pages/Sequences.jsx'))
const MassEmailPage      = lazyWithReload(() => import('../pages/MassEmail.jsx'))
const ColdCallsPage      = lazyWithReload(() => import('../pages/ColdCalls.jsx'))
const IntegrationsPage   = lazyWithReload(() => import('../pages/Integrations.jsx'))
const CampaignsPage      = lazyWithReload(() => import('../pages/campaigns/CampaignsPage.jsx'))
const FormLibraryPage    = lazyWithReload(() => import('../pages/FormLibrary.jsx'))
const AdminReviewPage    = lazyWithReload(() => import('../pages/AdminReview.jsx'))
const HelpPage           = lazyWithReload(() => import('../pages/help/HelpPage.jsx'))
// Unreleased. Reached only by ?preview=markup — deliberately not in the nav,
// so testing it cannot become an agent stumbling onto it mid-transaction.
const MarkupPreviewPage  = lazyWithReload(() => import('../pages/MarkupPreview.jsx'))

// ComposeModal is a named export — wrap in a lazy default-export shim
export const ComposeModalLazy = lazyWithReload(() =>
  import('../pages/Templates.jsx').then(m => ({ default: m.ComposeModal }))
)

// The one-shot "open this record" handoff, for pages that accept one.
const focusProps = (ctx) => ({ focusRecord: ctx.focusRecord, onFocusHandled: ctx.clearFocus })

/**
 * ctx = {
 *   page,                          shared page context (db, activeAgent, go, …)
 *   focusRecord, clearFocus,       record handoff (search hit, deep link, "+ New")
 *   announceProperty, clearAnnounce,  Properties → "Announce" → Mass Email
 *   activeAgentId, onSwitchAgent,
 * }
 */
const ROUTES = {
  dashboard:    (ctx) => <Dashboard {...ctx.page} />,
  contacts:     (ctx) => <ContactsPage {...ctx.page} {...focusProps(ctx)} />,
  properties:   (ctx) => <PropertiesPage {...ctx.page} {...focusProps(ctx)} />,
  pipeline:     (ctx) => <PipelinePage {...ctx.page} {...focusProps(ctx)} />,
  coldcalls:    ({ page: { db, setDb, activeAgent } }) => <ColdCallsPage db={db} setDb={setDb} activeAgent={activeAgent} />,
  campaigns:    ({ page: { db, setDb, activeAgent } }) => <CampaignsPage db={db} setDb={setDb} activeAgent={activeAgent} />,
  commission:   (ctx) => <CommissionPage {...ctx.page} />,
  tasks:        (ctx) => <TasksPage {...ctx.page} />,
  messages:     ({ page: { db, activeAgent } }) => <MessagesPage db={db} activeAgent={activeAgent} />,
  team:         (ctx) => <TeamPage {...ctx.page} onSwitchAgent={ctx.onSwitchAgent} />,
  templates:    (ctx) => <TemplatesPage {...ctx.page} />,
  sequences:    (ctx) => <SequencesPage {...ctx.page} />,
  'mass-email': (ctx) => (
    <MassEmailPage {...ctx.page} focusProperty={ctx.announceProperty}
      onFocusHandled={ctx.clearAnnounce} />
  ),
  reports:      (ctx) => <ReportsPage {...ctx.page} />,
  review:       (ctx) => <AdminReviewPage {...ctx.page} />,
  'form-library': ({ page: { isAdmin } }) => <FormLibraryPage isAdmin={isAdmin} />,
  leads:        (ctx) => <LeadsPage {...ctx.page} />,
  integrations: ({ page: { isAdmin } }) => <IntegrationsPage isAdmin={isAdmin} />,
  'data-management': ({ page: { isAdmin } }) => (isAdmin ? <DataManagementPage /> : null),
  settings:     (ctx) => <SettingsPage {...ctx.page} activeAgentId={ctx.activeAgentId} hideableNav={HIDEABLE_NAV} />,
  help:         (ctx) => <HelpPage {...ctx.page} {...focusProps(ctx)} />,
  'markup-preview': () => <MarkupPreviewPage />,
}

/** Every screen id — the Help guides' "Take me there" links are checked against it. */
export const ROUTE_IDS = Object.keys(ROUTES)

/** The screen for `route`, or nothing for a route this build doesn't know. */
export function RouteOutlet({ route, ...ctx }) {
  // `deal/<id>` and `deal/<id>/<drawer tab>`. The suffix is how another
  // screen hands an agent straight to the thing they clicked — the
  // dashboard's signature queue lands on that deal's Signatures tab
  // rather than on the deal page for them to find it again.
  if (isDealRoute(route)) {
    const { dealId, openTab } = parseDealRoute(route)
    return <DealPage {...ctx.page} dealId={dealId} openTab={openTab} />
  }
  return Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route](ctx) : null
}
