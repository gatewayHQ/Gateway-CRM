// The deal drawer's tabs, in order. One list so every "open the deal at…" link
// (compliance Fix buttons, the dashboard, notifications) can be checked against
// the tabs that actually exist — a link to a tab that isn't here opened the
// drawer onto a tab bar with nothing under it.
export const DEAL_TABS = [
  ['details',    'Details'],
  ['terms',      'Deal Terms'],
  ['dates',      'Key Dates'],
  ['checklist',  'Checklist'],
  ['documents',  'Documents'],
  ['signatures', 'Signatures'],
  ['portal',     'Client Portal'],
]

export const DEAL_TAB_IDS = DEAL_TABS.map(([id]) => id)

// The tab to open for a requested id — Details for anything unknown.
export const dealTabOrDefault = (id) => (DEAL_TAB_IDS.includes(id) ? id : 'details')
