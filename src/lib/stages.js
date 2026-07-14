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
  // The single board every deal lives on (decided 2026-06-12: no res/comm
  // split — one pipeline, with List/Focus views layered on top).
  unified: {
    id: 'unified',
    label: 'Pipeline',
    stages: ['lead', 'qualified', 'showing', 'offer', 'under-contract', 'closed', 'lost'],
  },
  // Retained for data mapping (deals stored with these tokens still resolve)
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

export const UNIFIED = 'unified'
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
  // The unified board: every commercial/seller token lands in the nearest
  // legacy column so no deal vanishes when viewed on the single pipeline.
  unified: {
    pursuit: 'lead', 'om-marketing': 'qualified', 'listing-agreement': 'qualified',
    'pre-list': 'qualified', 'on-market': 'showing', active: 'showing',
    loi: 'offer', psa: 'under-contract', 'due-diligence': 'under-contract',
  },
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

// Stages that mean the deal's property is under contract. Both residential
// tracks use the literal 'under-contract' token; on the commercial track a
// signed PSA (and the DD period that follows it) is the equivalent state.
// Drives the automatic property-status sync: entering one of these marks the
// linked property 'pending' (see syncPropertyStatusForStage in services/deals.js).
export const UNDER_CONTRACT_STAGES = ['under-contract', 'psa', 'due-diligence']
export const isUnderContractStage = (stage) => UNDER_CONTRACT_STAGES.includes(stage)

// Auto-task fired when a deal ENTERS a stage (board drag or deal-page rail).
// One rule per stage; daysOut sets the due date.
export const STAGE_AUTO_TASKS = {
  // shared / residential buyer
  qualified:        { title: d => `Schedule showing — ${d.title}`,            type: 'showing',   priority: 'high',   daysOut: 2 },
  showing:          { title: d => `Send post-showing follow-up — ${d.title}`, type: 'follow-up', priority: 'medium', daysOut: 1 },
  offer:            { title: d => `Prepare & submit offer — ${d.title}`,      type: 'document',  priority: 'high',   daysOut: 2 },
  'under-contract': { title: d => `Order inspection — ${d.title}`,            type: 'follow-up', priority: 'high',   daysOut: 5 },
  closed:           { title: d => `Request referral — ${d.title}`,            type: 'follow-up', priority: 'low',    daysOut: 7 },
  // residential seller
  'pre-list':       { title: d => `Prep listing: photos, comps, disclosures — ${d.title}`, type: 'document',  priority: 'high',   daysOut: 3 },
  active:           { title: d => `Schedule open house / showings — ${d.title}`,           type: 'showing',   priority: 'medium', daysOut: 3 },
  // commercial
  'om-marketing':       { title: d => `Build OM & marketing package — ${d.title}`,         type: 'document',  priority: 'high',   daysOut: 3 },
  'listing-agreement':  { title: d => `Collect signed listing agreement — ${d.title}`,     type: 'document',  priority: 'high',   daysOut: 2 },
  'on-market':          { title: d => `Syndicate listing (Crexi/LoopNet) — ${d.title}`,    type: 'follow-up', priority: 'medium', daysOut: 2 },
  loi:                  { title: d => `Review & respond to LOI — ${d.title}`,              type: 'document',  priority: 'high',   daysOut: 2 },
  psa:                  { title: d => `Open escrow & order title — ${d.title}`,            type: 'document',  priority: 'high',   daysOut: 3 },
  'due-diligence':      { title: d => `Track DD checklist & deadlines — ${d.title}`,       type: 'follow-up', priority: 'high',   daysOut: 2 },
}
