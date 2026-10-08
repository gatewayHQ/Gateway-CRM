// ─────────────────────────────────────────────────────────────────────────────
// Navigation model — what the sidebar, the phone's bottom bar and its "More"
// sheet list, and what the top bar calls each screen.
//
// Static configuration plus pure functions over it. The layout components
// only render what `buildNav` returns; the rules for who sees which entry
// (admin-only items, an agent's hidden items, Messages without a Twilio
// number) are all decided here.
// ─────────────────────────────────────────────────────────────────────────────

// Primary: what every agent uses every day
const NAV_CORE = [
  { id: 'dashboard',  label: 'Dashboard',  icon: 'dashboard' },
  { id: 'contacts',   label: 'Contacts',   icon: 'contacts' },
  { id: 'properties', label: 'Properties', icon: 'building' },
  { id: 'pipeline',   label: 'Pipeline',   icon: 'pipeline' },
  { id: 'tasks',      label: 'Tasks',      icon: 'tasks' },
  { id: 'messages',   label: 'Messages',   icon: 'mail' },
]

// Office: business operations, reviewed regularly
const NAV_OFFICE = [
  { id: 'commission', label: 'Commission', icon: 'commission' },
  { id: 'review',     label: 'Review Queue', icon: 'check', adminOnly: true },
  { id: 'coldcalls',  label: 'Cold Calls', icon: 'phone' },
  { id: 'campaigns',  label: 'Mail Campaigns', icon: 'mail' },
  { id: 'reports',    label: 'Reports',    icon: 'reports' },
  { id: 'team',       label: 'Team',       icon: 'team' },
]

// Marketing & Tools: power features, collapsed for new users
const NAV_TOOLS = [
  { id: 'templates',    label: 'Email Templates', icon: 'file-text' },
  { id: 'sequences',    label: 'Drip Sequences',  icon: 'sequences' },
  { id: 'mass-email',   label: 'Mass Email',      icon: 'send'      },
  { id: 'form-library', label: 'Form Library',    icon: 'document'  },
  { id: 'toolkit',      label: 'Toolkit',         icon: 'sparkles'  },
  { id: 'leads',        label: 'Website Leads',   icon: 'leads'     },
]

// Always visible at the bottom — never buried
const NAV_ADMIN = [
  { id: 'help',           label: 'Help & How-To',   icon: 'help'      },
  { id: 'integrations',   label: 'Integrations',    icon: 'link'      },
  { id: 'data-management', label: 'Data Management', icon: 'tag', adminOnly: true },
  { id: 'settings',       label: 'Settings',        icon: 'settings' },
]

// Nav items agents are allowed to hide (dashboard + settings always stay)
export const HIDEABLE_NAV = [
  { id: 'contacts',     label: 'Contacts',        group: 'Core'   },
  { id: 'properties',   label: 'Properties',      group: 'Core'   },
  { id: 'tasks',        label: 'Tasks',            group: 'Core'   },
  { id: 'messages',     label: 'Messages',         group: 'Core'   },
  { id: 'commission',   label: 'Commission',       group: 'Office' },
  { id: 'coldcalls',    label: 'Cold Calls',       group: 'Office' },
  { id: 'campaigns',    label: 'Mail Campaigns',   group: 'Office' },
  { id: 'reports',      label: 'Reports',          group: 'Office' },
  { id: 'team',         label: 'Team',             group: 'Office' },
  { id: 'templates',    label: 'Email Templates',  group: 'Tools'  },
  { id: 'sequences',    label: 'Drip Sequences',   group: 'Tools'  },
  { id: 'mass-email',   label: 'Mass Email',       group: 'Tools'  },
  { id: 'form-library', label: 'Form Library',     group: 'Tools'  },
  { id: 'toolkit',      label: 'Toolkit',          group: 'Tools'  },
  { id: 'leads',        label: 'Website Leads',    group: 'Tools'  },
]

export const TOOLS_IDS = NAV_TOOLS.map(n => n.id)
// The phone's bottom bar; everything else is under More.
const MOBILE_TABS = ['dashboard', 'contacts', 'pipeline', 'tasks']
// Toolkit opens in a new tab (it has its own login) rather than routing.
export const TOOLKIT_URL = 'https://gatewayhq.github.io/'

const TITLES = {
  dashboard:  { title: 'Dashboard',        crumb: 'Overview' },
  contacts:   { title: 'Contacts',         crumb: 'CRM · People' },
  properties: { title: 'Properties',       crumb: 'Database · Listings' },
  pipeline:   { title: 'Pipeline',         crumb: 'Deals · Kanban' },
  coldcalls:  { title: 'Cold Call Lists',  crumb: 'Prospecting · Dialer' },
  campaigns:  { title: 'Mail Campaigns',   crumb: 'Marketing · Print · Tracking' },
  commission: { title: 'Commission',       crumb: 'Deals · Earnings' },
  tasks:      { title: 'Tasks',            crumb: 'Follow-ups · Reminders' },
  messages:   { title: 'Messages',         crumb: 'SMS · Twilio Inbox' },
  team:       { title: 'Team',             crumb: 'Agents · Roster' },
  templates:  { title: 'Email Templates',  crumb: 'Communications · Library' },
  sequences:  { title: 'Drip Sequences',   crumb: 'Marketing · Automation' },
  'mass-email': { title: 'Mass Email',     crumb: 'Marketing · Deal Announcements' },
  reports:    { title: 'Reports',          crumb: 'Analytics · ROI' },
  review:     { title: 'Review Queue',     crumb: 'Admin · Closing Approvals' },
  'form-library': { title: 'Form Library',  crumb: 'Documents · State Forms' },
  toolkit:    { title: 'Toolkit',          crumb: 'Tools · Gateway Suite' },
  leads:      { title: 'Website Leads',    crumb: 'Marketing · Captures' },
  integrations: { title: 'Integrations',    crumb: 'Tools · Connections' },
  'data-management': { title: 'Data Management', crumb: 'Admin · Controlled Vocabulary' },
  settings:     { title: 'Settings',        crumb: 'Workspace' },
  help:         { title: 'Help & How-To',   crumb: 'Guides · Step by step' },
}

const ADMIN_ONLY_IDS = new Set([...NAV_OFFICE, ...NAV_ADMIN].filter(n => n.adminOnly).map(n => n.id))

// ── Routes ───────────────────────────────────────────────────────────────────
// This app has no URL router: a route is a string in state. A deal is
// `deal/<id>` or `deal/<id>/<drawer tab>`; everything else is a page id.

export const isDealRoute = (route) => route.startsWith('deal/')

/** `deal/<id>/<tab>` → { dealId, openTab } */
export function parseDealRoute(route) {
  const [dealId, openTab] = route.slice(5).split('/')
  return { dealId, openTab: openTab || null }
}

/** The nav entry a route lights up — a deal is part of Pipeline. */
export const navRouteFor = (route) => (isDealRoute(route) ? 'pipeline' : route)

export const isAdminOnlyRoute = (route) => ADMIN_ONLY_IDS.has(route)

/**
 * Top-bar title and breadcrumb. A deal page has no TITLES entry (its route
 * carries the id), so it reads as the deal, under Pipeline.
 */
export function pageTitleFor(route, deals = []) {
  if (!isDealRoute(route)) return TITLES[route] || {}
  const deal = deals.find(d => d.id === parseDealRoute(route).dealId)
  return { title: deal?.title || 'Deal', crumb: 'Pipeline · Deal' }
}

// ── Per-agent navigation ─────────────────────────────────────────────────────

/**
 * Nav ids this agent doesn't see: the ones they hid in Settings, plus
 * Messages (two-way SMS) when they have no Twilio number — for them it was an
 * empty inbox in their main nav.
 */
export function hiddenNavFor(agent) {
  const hidden = agent?.nav_hidden || []
  return agent && !agent.twilio_number ? [...hidden, 'messages'] : hidden
}

/**
 * The nav sections this agent sees. Admin-only entries disappear for everyone
 * else; hidden entries disappear everywhere except the always-on admin block.
 * `all` is every reachable entry, in sidebar order.
 */
export function buildNav({ isAdmin, hiddenNav }) {
  const shown = (n) => !hiddenNav.includes(n.id)
  const allowed = (n) => isAdmin || !n.adminOnly
  const core   = NAV_CORE.filter(shown)
  const office = NAV_OFFICE.filter(allowed).filter(shown)
  const tools  = NAV_TOOLS.filter(shown)
  const admin  = NAV_ADMIN.filter(allowed)
  return { core, office, tools, admin, all: [...core, ...office, ...tools, ...admin] }
}

/** The phone's bottom bar. */
export const mobileTabsFor = (nav) =>
  MOBILE_TABS.map(id => nav.all.find(x => x.id === id))
    .filter(Boolean)

/** The "More" sheet: everything not already on the bottom bar, grouped like the sidebar. */
export function mobileMoreGroups(nav) {
  const offTabs = (n) => !MOBILE_TABS.includes(n.id)
  return [
    ['Work',              [...nav.core, ...nav.office].filter(offTabs)],
    ['Marketing & Tools', nav.tools.filter(offTabs)],
    ['Settings',          nav.admin.filter(offTabs)],
  ].filter(([, rows]) => rows.length)
}
