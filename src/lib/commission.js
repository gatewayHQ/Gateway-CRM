/**
 * Gateway CRM — Commission engine
 *
 * One pure function (`computeCommission`) is the single source of truth for
 * every dollar figure shown anywhere in the app (the editor drawer, the
 * Commission dashboard, the monthly chart, per-agent totals). Keeping the math
 * in one place means the breakdown an agent sees while editing is byte-for-byte
 * what the reports roll up.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * A real transaction is two things stacked together:
 *
 *   1. SIDES — where the commission comes from. A deal can be the listing side,
 *      the buyer side, or BOTH (when the brokerage double-ends). Each side has
 *      its own rate and its own optional referral, because a referral often only
 *      touches one side (e.g. the listing was referred in, the buyer side wasn't).
 *
 *   2. PARTICIPANTS — who splits the net. Each agent on the deal carries their
 *      OWN brokerage arrangement: some agents split with the house (e.g. 60/40),
 *      others keep 100% (capped out, or simply no split). A co-agent who keeps
 *      100% never touches the primary agent's take — they're independent.
 *
 * Net commission = Σ(side.gross − side.referral). Each participant is allocated a
 * share of that net and applies their own split (or none) to it. The house total
 * is whatever the agents don't keep.
 *
 *   3. TRANSACTION FEE — a flat per-deal fee the brokerage charges on every
 *      closing (default $100), split evenly across the agents on the deal ($50
 *      each for two agents). It is charged ON TOP and does NOT count toward an
 *      agent's annual cap — the cap measures only the brokerage SPLIT. A
 *      per-agent `fee` > 0 overrides that agent's share of the flat fee.
 *
 * ── Backward compatibility ───────────────────────────────────────────────────
 * Existing rows use the old flat shape (gross_pct / referral_pct / broker_pct /
 * agent_pct / co_agent_pct / transaction_fee). `normalizeCommission` upgrades
 * those into the sides+participants shape on the fly, so legacy deals keep
 * rendering identically until someone re-saves them in the new editor.
 */

export const DEFAULTS = {
  GROSS_PCT: 3.0,        // typical one-side rate
  SPLIT_PCT: 70.0,       // agent's share of their allocation (house keeps the rest)
  TRANSACTION_FEE: 100,  // flat per-deal brokerage transaction fee, split across agents
}

const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

/** Stable id for new participants/sides created in the UI. */
export const uid = () => Math.random().toString(36).slice(2, 10)

/**
 * Build a fresh participant row. `agent` (optional) seeds the split from the
 * agent's stored default so the common case needs zero extra typing.
 */
export function makeParticipant({ agent = null, role = 'primary', allocation_pct = 100 } = {}) {
  const noSplit = agent?.no_brokerage_split === true
  return {
    id: uid(),
    agent_id: agent?.id || '',
    name: agent?.name || '',
    role,                              // 'primary' | 'co'
    allocation_pct,                    // share of NET commission this agent is allocated
    split_pct: noSplit ? 100 : num(agent?.default_split_pct, DEFAULTS.SPLIT_PCT),
    no_split: noSplit,                 // true = keeps 100%, no brokerage cut
    fee: 0,                            // per-agent override of the flat fee share (0 = use the deal-level split)
  }
}

/** A single-side commission (the simple, most common case). */
export function makeSide(key = 'sale', rate_pct = DEFAULTS.GROSS_PCT) {
  const label = key === 'listing' ? 'Listing side' : key === 'buyer' ? 'Buyer side' : 'Sale'
  return { id: uid(), key, label, rate_pct, referral_pct: 0, referral_flat: 0 }
}

/**
 * Coerce any stored commission row (legacy flat OR new structured) plus the
 * deal/agent context into the canonical { sale_price, sides, participants }
 * input shape that `computeCommission` consumes.
 */
export function normalizeCommission(commission, { deal, agents = [] } = {}) {
  const sale_price = num(deal?.value, 0)

  // New structured shape already stored — use it verbatim.
  if (commission && Array.isArray(commission.sides) && commission.sides.length &&
      Array.isArray(commission.participants) && commission.participants.length) {
    return {
      sale_price,
      sides: commission.sides.map(s => ({ ...makeSide(s.key, s.rate_pct), ...s })),
      participants: commission.participants.map(p => ({ ...makeParticipant(), ...p })),
      transaction_fee: num(commission.transaction_fee, 0),
    }
  }

  // Legacy flat shape (or no row yet) → upgrade to one side + participants.
  const gross_pct    = num(commission?.gross_pct, DEFAULTS.GROSS_PCT)
  const referral_pct = num(commission?.referral_pct, 0)
  const agent_pct    = num(commission?.agent_pct, DEFAULTS.SPLIT_PCT)
  const co_agent_pct = num(commission?.co_agent_pct, 0)
  const fee          = num(commission?.transaction_fee, 0)

  const sides = [{ ...makeSide('sale', gross_pct), referral_pct }]

  const primaryAgent = agents.find(a => a.id === deal?.agent_id) || null
  const primary = makeParticipant({ agent: primaryAgent, role: 'primary', allocation_pct: 100 })
  primary.split_pct = agent_pct
  primary.no_split = false

  const participants = [primary]

  // Legacy co-agent was carved out of the primary agent's take as a % of their
  // post-fee gross. Preserve that exactly by giving the co-agent that take as a
  // pass-through (no brokerage cut) — keeps already-saved deals identical.
  if (co_agent_pct > 0) {
    const co = makeParticipant({ role: 'co', allocation_pct: 0 })
    co._legacy_co_pct = co_agent_pct   // marker consumed below
    participants.push(co)
  }

  // The legacy flat `transaction_fee` was a single deal-level fee — carry it
  // straight through as the deal-level fee (no longer pinned to the primary).
  return { sale_price, sides, participants, transaction_fee: fee, _legacy: true }
}

/**
 * THE function. Takes a normalized input and returns a fully-resolved breakdown
 * with every dollar amount the UI needs. Pure — no I/O, no rounding surprises in
 * intermediate math (only the surfaced amounts are rounded to cents).
 */
export function computeCommission(input) {
  const sale_price = num(input?.sale_price, 0)
  const rawSides = Array.isArray(input?.sides) && input.sides.length ? input.sides : [makeSide()]

  const sides = rawSides.map(s => {
    const rate = num(s.rate_pct, 0)
    const gross = sale_price * rate / 100
    const referral = num(s.referral_flat, 0) > 0
      ? num(s.referral_flat, 0)
      : gross * num(s.referral_pct, 0) / 100
    return {
      ...s,
      gross: round2(gross),
      referral: round2(Math.min(referral, gross)),
      net: round2(gross - Math.min(referral, gross)),
    }
  })

  const gross_total    = round2(sides.reduce((s, x) => s + x.gross, 0))
  const referral_total = round2(sides.reduce((s, x) => s + x.referral, 0))
  const net_total      = round2(sides.reduce((s, x) => s + x.net, 0))

  let rawParts = Array.isArray(input?.participants) && input.participants.length
    ? input.participants
    : [makeParticipant({ allocation_pct: 100 })]

  // Legacy co-agent marker: convert "% of primary's post-fee take" into an
  // explicit pass-through allocation so the new engine reproduces old numbers.
  const legacyCo = rawParts.find(p => p._legacy_co_pct != null)
  if (legacyCo) {
    const primary = rawParts.find(p => p.role === 'primary') || rawParts[0]
    const primaryAlloc = net_total * num(primary.allocation_pct, 100) / 100
    const primaryGross = primaryAlloc * num(primary.split_pct, 100) / 100 - num(primary.fee, 0)
    const coTake = Math.max(0, primaryGross) * num(legacyCo._legacy_co_pct, 0) / 100
    // Represent co-agent take as a fixed dollar pass-through via a synthetic field.
    legacyCo._fixed_take = round2(coTake)
  }

  // Flat per-deal transaction fee, split evenly across the agents who pay it
  // (legacy fixed-take co-agents don't). A per-agent `fee` > 0 overrides the
  // even share. This fee is charged ON TOP and is excluded from cap tracking.
  const transaction_fee = num(input?.transaction_fee, 0)
  const feePayers = rawParts.filter(p => p._fixed_take == null && p._legacy_co_pct == null)
  const feeShare = feePayers.length ? transaction_fee / feePayers.length : 0

  const participants = rawParts.map(p => {
    const allocation = net_total * num(p.allocation_pct, 0) / 100
    const ownFee = num(p.fee, 0)
    const txnFee = p._fixed_take != null ? 0 : (ownFee > 0 ? ownFee : feeShare)

    if (p._fixed_take != null) {
      // Legacy co-agent: fixed dollar take, comes out of the agent pool.
      return { ...p, allocation: round2(p._fixed_take), agent_take: round2(p._fixed_take), house_split: 0, house_fee: 0, house_from: 0, fee: 0 }
    }

    if (p.no_split) {
      // Keeps 100% of their allocation (capped / no brokerage split). Only the
      // flat transaction fee goes to the house.
      const take = allocation - txnFee
      return { ...p, allocation: round2(allocation), agent_take: round2(take), house_split: 0, house_fee: round2(txnFee), house_from: round2(txnFee), fee: round2(txnFee) }
    }

    const split = num(p.split_pct, DEFAULTS.SPLIT_PCT)
    const splitTake = allocation * split / 100
    const houseSplit = allocation - splitTake   // the brokerage split — counts toward cap
    const take = splitTake - txnFee
    return {
      ...p,
      allocation: round2(allocation),
      agent_take: round2(take),
      house_split: round2(houseSplit),
      house_fee: round2(txnFee),                // transaction fee — charged on top, not capped
      house_from: round2(houseSplit + txnFee),
      fee: round2(txnFee),
    }
  })

  // For the legacy co-agent case the co-agent take was carved OUT of the primary's
  // take, so subtract it back off the primary so totals reconcile.
  if (legacyCo) {
    const primary = participants.find(p => p.role === 'primary') || participants[0]
    const co = participants.find(p => p._fixed_take != null)
    if (primary && co) {
      primary.agent_take = round2(primary.agent_take - co.agent_take)
    }
  }

  const allocatedAgentTake = participants.reduce((s, p) => s + p.agent_take, 0)
  const allocatedHouse     = participants.reduce((s, p) => s + p.house_from, 0)
  const transaction_fee_total = round2(participants.reduce((s, p) => s + (p.house_fee || 0), 0))
  const house_split_total     = round2(participants.reduce((s, p) => s + (p.house_split || 0), 0))
  const allocatedTotal     = participants.reduce((s, p) => s + (p._fixed_take != null ? 0 : p.allocation), 0)
  // Anything not allocated to a participant falls to the house.
  const unallocated = Math.max(0, net_total - allocatedTotal)

  const agent_total = round2(allocatedAgentTake)
  const house_total = round2(allocatedHouse + unallocated)

  const primary = participants.find(p => p.role === 'primary') || participants[0] || null

  const allocPctSum = rawParts
    .filter(p => p._fixed_take == null && p._legacy_co_pct == null)
    .reduce((s, p) => s + num(p.allocation_pct, 0), 0)

  return {
    sale_price,
    sides,
    gross_total,
    referral_total,
    net_total,
    participants,
    agent_total,
    house_total,
    transaction_fee: round2(transaction_fee),
    transaction_fee_total,   // total flat fees charged on this deal (on top of cap)
    house_split_total,       // brokerage split only — the cap-counting portion
    primary,
    // Effective blended rate (for the dashboard's "GC %" column).
    effective_rate_pct: sale_price > 0 ? round2(gross_total / sale_price * 100) : 0,
    // Legacy-compatible fields consumed by existing report rollups:
    gross: gross_total,
    agentAmt: primary ? primary.agent_take : 0,   // primary agent's take
    brokerAmt: house_total,
    warnings: validateAllocations(allocPctSum, participants),
  }
}

function validateAllocations(allocPctSum, participants) {
  const w = []
  if (participants.length && Math.abs(allocPctSum - 100) > 0.5) {
    w.push(`Agent allocations add up to ${round2(allocPctSum)}% (should be 100%). The remainder goes to the brokerage.`)
  }
  return w
}

/**
 * Convenience used by reporting: resolve a deal's full breakdown from the raw
 * commission row + context in one call.
 */
export function breakdownForDeal(deal, commission, agents) {
  return computeCommission(normalizeCommission(commission, { deal, agents }))
}
