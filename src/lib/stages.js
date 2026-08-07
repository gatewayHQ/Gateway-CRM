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

// The single board every deal lives on (decided 2026-06-12: no res/comm split
// — one pipeline, with List/Focus views layered on top).
//
// The commercial / residential-buyer / residential-seller track definitions,
// TRACK_ORDER, and trackForDeal() were removed once that decision had held for
// two months: nothing outside this file's own tests ever referenced them, and
// boardStageFor() was only ever called with UNIFIED. Deals stored with a
// commercial or seller token still resolve — FOREIGN_STAGE_MAP.unified below is
// what actually does that work, and it is unchanged. See git history to restore.
export const TRACKS = {
  unified: {
    id: 'unified',
    label: 'Pipeline',
    stages: ['lead', 'qualified', 'showing', 'offer', 'under-contract', 'closed', 'lost'],
  },
}

export const UNIFIED = 'unified'

// Every storable stage token — drives the deals.stage CHECK constraint
// (see schema.sql / migration 0012); checked by scripts/check-enums.mjs.
export const ALL_DEAL_STAGES = [
  'lead', 'qualified', 'showing', 'offer', 'under-contract', 'closed', 'lost',
  'pursuit', 'om-marketing', 'listing-agreement', 'on-market', 'loi', 'psa', 'due-diligence',
  'pre-list', 'active',
]

// Nearest-column map for stage tokens foreign to the board. Used for display
// grouping only — a deal's stored stage changes only when dragged. Every
// commercial/seller token lands in the nearest legacy column so no deal
// vanishes when viewed on the single pipeline.
const FOREIGN_STAGE_MAP = {
  unified: {
    pursuit: 'lead', 'om-marketing': 'qualified', 'listing-agreement': 'qualified',
    'pre-list': 'qualified', 'on-market': 'showing', active: 'showing',
    loi: 'offer', psa: 'under-contract', 'due-diligence': 'under-contract',
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
