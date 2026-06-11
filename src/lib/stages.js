// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stage tracks — the single source of truth.
//
// One deals.stage column, three boards (decided 2026-06, Daniel):
//   • Commercial:          Pursuit → OM/Marketing → Listing Agreement →
//                          On Market → LOI → PSA → Due Diligence → Closed
//                          (off-market deals simply skip On Market)
//   • Residential buyers:  Lead → Showing → Offer → Under Contract → Closed
//   • Residential sellers: Lead → Pre-List → Active → Under Contract → Closed
//
// A deal's track comes from prop_category, then comp_data.transaction_type
// (the buyer/seller field the Forms tab already maintains). Deals carrying a
// stage token from another track (legacy data, or a deal whose side was
// recategorized) are DISPLAYED in the nearest column via the maps below, but
// their stored stage is rewritten only when an agent actually drags them —
// display never mutates data.
// ─────────────────────────────────────────────────────────────────────────────

export const STAGE_LABELS = {
  // shared
  lead: 'Lead', 'under-contract': 'Under Contract', closed: 'Closed', lost: 'Lost',
  // residential buyer
  showing: 'Showing', offer: 'Offer',
  // residential seller
  'pre-list': 'Pre-List', active: 'Active',
  // commercial
  pursuit: 'Pursuit', 'om-marketing': 'OM / Marketing',
  'listing-agreement': 'Listing Agreement', 'on-market': 'On Market',
  loi: 'LOI', psa: 'PSA', 'due-diligence': 'Due Diligence',
  // legacy (still on old rows; no board column of its own)
  qualified: 'Qualified',
}

export const TRACKS = {
  commercial: {
    id: 'commercial',
    label: 'Commercial',
    stages: ['pursuit', 'om-marketing', 'listing-agreement', 'on-market', 'loi', 'psa', 'due-diligence', 'closed', 'lost'],
  },
  'residential-buyer': {
    id: 'residential-buyer',
    label: 'Residential · Buyers',
    stages: ['lead', 'showing', 'offer', 'under-contract', 'closed', 'lost'],
  },
  'residential-seller': {
    id: 'residential-seller',
    label: 'Residential · Sellers',
    stages: ['lead', 'pre-list', 'active', 'under-contract', 'closed', 'lost'],
  },
}

export const TRACK_ORDER = ['commercial', 'residential-buyer', 'residential-seller']

// Every storable stage token — drives the deals.stage CHECK constraint
// (see schema.sql / migration 0012); checked by scripts/check-enums.mjs.
export const ALL_DEAL_STAGES = [
  'lead', 'qualified', 'showing', 'offer', 'under-contract', 'closed', 'lost',
  'pursuit', 'om-marketing', 'listing-agreement', 'on-market', 'loi', 'psa', 'due-diligence',
  'pre-list', 'active',
]

// Which board a deal belongs on.
export function trackForDeal(deal) {
  if (deal?.prop_category === 'commercial') return 'commercial'
  // Residential: the Forms tab's buyer/seller field decides the side; deals
  // without one default to the buyer board (the legacy stage set matches it).
  return deal?.comp_data?.transaction_type === 'seller'
    ? 'residential-seller'
    : 'residential-buyer'
}

// Nearest-column maps for stage tokens foreign to a track. Used for display
// grouping only — a deal's stored stage changes only when dragged.
const FOREIGN_STAGE_MAP = {
  commercial: {
    lead: 'pursuit', qualified: 'pursuit', showing: 'om-marketing',
    'pre-list': 'listing-agreement', active: 'on-market', offer: 'loi',
    'under-contract': 'psa',
  },
  'residential-buyer': {
    qualified: 'showing', 'pre-list': 'lead', active: 'showing',
    pursuit: 'lead', 'om-marketing': 'lead', 'listing-agreement': 'lead',
    'on-market': 'showing', loi: 'offer', psa: 'under-contract',
    'due-diligence': 'under-contract',
  },
  'residential-seller': {
    qualified: 'lead', showing: 'active', offer: 'active',
    pursuit: 'lead', 'om-marketing': 'pre-list', 'listing-agreement': 'pre-list',
    'on-market': 'active', loi: 'active', psa: 'under-contract',
    'due-diligence': 'under-contract',
  },
}

// The column a deal occupies on a given board. Always returns a valid column
// of that track so no deal can silently vanish from its board.
export function boardStageFor(deal, trackId) {
  const track = TRACKS[trackId]
  if (!track) return deal?.stage
  if (track.stages.includes(deal?.stage)) return deal.stage
  return FOREIGN_STAGE_MAP[trackId]?.[deal?.stage] || track.stages[0]
}

// A deal is in-flight when it's neither won nor lost — shared by boards,
// dashboards, and the "open deals" pickers.
export const isOpenStage = (stage) => stage !== 'closed' && stage !== 'lost'
