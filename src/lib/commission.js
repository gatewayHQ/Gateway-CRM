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
 *      the buyer side, or BOTH (when the brokerage double-ends). Each side is
 *      priced EITHER as a percentage of the sale price (`rate_pct`) OR as a flat
 *      dollar fee (`flat` > 0 wins), and carries its own optional referral,
 *      because a referral often only touches one side (e.g. the listing was
 *      referred in, the buyer side wasn't).
 *
 *   2. PARTICIPANTS — who splits the net. Each agent on the deal carries their
 *      OWN brokerage arrangement: some agents split with the house (e.g. 60/40),
 *      others keep 100% (capped out, or simply no split). A co-agent who keeps
 *      100% never touches the primary agent's take — they're independent.
 *      Until the back office saves a split, the participant list is seeded from
 *      the deal: the assigned agent plus the co-agents carried over from the
 *      property at conversion (`deals.co_agent_ids`), allocated evenly.
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
 * ── Where the gross comes from ───────────────────────────────────────────────
 * Two people can state a deal's commission, and they win in this order:
 *
 *   1. commissions.sides   — the back office's explicit entry (admin-only table).
 *                            Once an admin saves in the Commission editor this
 *                            is authoritative, full stop.
 *   2. deals.commission_*  — the ASSIGNED AGENT's entry on the deal's Details
 *                            tab: either a percentage or a flat fee. This is the
 *                            deal the agent actually struck with the client, so
 *                            it outranks a stale legacy scalar.
 *   3. commissions.gross_pct — the legacy flat column.
 *   4. DEFAULTS.GROSS_PCT  — nothing entered anywhere.
 *
 * ── Backward compatibility ───────────────────────────────────────────────────
 * Existing rows use the old flat shape (gross_pct / referral_pct / broker_pct /
 * agent_pct / co_agent_pct / transaction_fee). `normalizeCommission` upgrades
 * those into the sides+participants shape on the fly, so legacy deals keep
 * rendering identically until someone re-saves them in the new editor.
 */

import { dealCoAgentIds } from './coAgents.js'

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
// Allocation percentages are edited to one decimal in the UI — match that here
// so a seeded split reads the same as a hand-typed one.
const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10

/** Stable id for new participants/sides created in the UI. */
export const uid = () => Math.random().toString(36).slice(2, 10)

// ── The agent's own arrangement with the office ─────────────────────────────
// What an agent keeps of their allocation comes from THEIR row on `agents`,
// set once by the office in Back Office → Agents & Caps:
//   • no_brokerage_split — pre-paid / no split: keeps 100%, always
//   • cap_confirmed_at   — the office confirmed the cap is met: keeps 100% on
//                          every deal from that date to the cap anniversary,
//                          when the cap year resets
//   • default_split_pct  — otherwise, the agent's split (house keeps the rest)
// It used to apply only once the back office had saved a split on each deal;
// until then every agent read as 70/30 with no fee, so the take-home an agent
// saw was wrong on exactly the deals nobody had touched yet.

// Parse a date column as local noon, so a date-only value never slips a day.
const parseDay = (v) => {
  if (!v) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00` : v)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The date a deal's commission counts on: the day it closed (its last update,
 * the same date every report attributes a closing to), or for an open deal its
 * expected close — never earlier than today, since it can't close in the past.
 */
export function dealCommissionDate(deal, now = new Date()) {
  if (deal?.stage === 'closed') return parseDay(deal.updated_at || deal.created_at) || now
  const expected = parseDay(deal?.expected_close_date)
  return expected && expected > now ? expected : now
}

/** The end of the cap year an office-confirmed cap applies to — the next anniversary. */
export function capConfirmedUntil(agent) {
  const confirmed = parseDay(agent?.cap_confirmed_at)
  if (!confirmed) return null
  const end = capWindowStart(agent.cap_anniversary, confirmed)
  end.setFullYear(end.getFullYear() + 1)
  return end
}

/** Whether the office's cap confirmation covers a deal counting on `date`. */
export function capCovers(agent, date) {
  const confirmed = parseDay(agent?.cap_confirmed_at)
  if (!confirmed || !date) return false
  return date >= confirmed && date < capConfirmedUntil(agent)
}

/**
 * The split an agent works on for a deal, and why: 'prepaid' and 'cap' keep
 * 100% (the flat transaction fee still applies — it is charged on top of the
 * cap), 'split' is their default share.
 */
export function agentArrangement(agent, deal) {
  if (agent?.no_brokerage_split === true) return { split_pct: 100, no_split: true, basis: 'prepaid' }
  if (capCovers(agent, dealCommissionDate(deal))) return { split_pct: 100, no_split: true, basis: 'cap' }
  return { split_pct: num(agent?.default_split_pct, DEFAULTS.SPLIT_PCT), no_split: false, basis: 'split' }
}

/**
 * The agent's per-deal transaction fee from their contract (agents.
 * transaction_fee, migration 0061) — typically $50 for a new agent — or the
 * office standard when none is set. They pay it on their SHARE of a deal: all
 * of it on a solo deal, half on a 50/50 co-listing.
 */
export function agentFee(agent) {
  const v = agent?.transaction_fee
  return v === null || v === undefined || v === '' ? DEFAULTS.TRANSACTION_FEE : Math.max(0, num(v, DEFAULTS.TRANSACTION_FEE))
}

/** Whether a participant pays their own contract fee (vs. the deal-level split). */
export const hasContractFee = (p) => p?.contract_fee !== null && p?.contract_fee !== undefined && p?.contract_fee !== ''

/**
 * Build a fresh participant row. `agent` (optional) seeds the split from the
 * agent's own arrangement — including a confirmed cap on this `deal` — so the
 * common case needs zero extra typing.
 */
export function makeParticipant({ agent = null, deal = null, role = 'primary', allocation_pct = 100 } = {}) {
  const arrangement = agentArrangement(agent, deal)
  return {
    id: uid(),
    agent_id: agent?.id || '',
    name: agent?.name || '',
    role,                              // 'primary' | 'co'
    allocation_pct,                    // share of NET commission this agent is allocated
    split_pct: arrangement.split_pct,
    no_split: arrangement.no_split,    // true = keeps 100%, no brokerage cut
    basis: arrangement.basis,          // 'split' | 'prepaid' | 'cap' — why this split
    // The agent's contract fee, charged on their allocation. Null on a row
    // built without an agent, and on rows the back office saved before
    // per-agent fees existed — those keep the deal-level fee split evenly.
    contract_fee: agent ? agentFee(agent) : null,
    fee: 0,                            // per-agent override of the fee (0 = their contract fee, or the deal-level split)
  }
}

// A confirmed cap outranks a split saved on the deal: once the office confirms
// it, every deal in that cap year pays the agent 100% without anyone re-opening
// each one. Everything else the back office saved stands.
function withConfirmedCap(participant, agents, deal) {
  const agent = agents.find(a => a.id === participant.agent_id)
  if (participant.no_split || !capCovers(agent, dealCommissionDate(deal))) return participant
  return { ...participant, no_split: true, split_pct: 100, basis: 'cap' }
}

/**
 * A single-side commission (the simple, most common case). `flat` is a flat
 * dollar fee for the side; when it is > 0 it REPLACES the percentage rate.
 */
export function makeSide(key = 'sale', rate_pct = DEFAULTS.GROSS_PCT, flat = 0) {
  const label = key === 'listing' ? 'Listing side' : key === 'buyer' ? 'Buyer side' : 'Sale'
  return { id: uid(), key, label, rate_pct, flat, referral_pct: 0, referral_flat: 0 }
}

// ── Buyer side / seller side ────────────────────────────────────────────────
// Every dollar on a deal comes from one side of the table, and an agent who
// represents both needs to see how much came from each. A side's PARTY is read
// from its key — 'listing' is the seller side, 'buyer' the buyer side — and a
// single 'sale' side belongs to whichever side the deal represents. A 'sale'
// side on a deal representing BOTH can't be placed and reads as 'unsplit', so
// the screens can say the split was never entered rather than guess at it.
export const PARTIES = ['seller', 'buyer']
export const PARTY_LABELS = { seller: 'Seller side', buyer: 'Buyer side', unsplit: 'Both sides (not split)' }

/** Which side(s) a deal represents: 'buyer' | 'seller' | 'both' (blank reads as buyer). */
export function dealRepresents(deal) {
  const t = String(deal?.comp_data?.transaction_type || '').trim().toLowerCase()
  return t === 'both' || t === 'seller' ? t : 'buyer'
}

/** The party a commission side's money comes from. */
export function partyForSide(sideKey, deal) {
  if (sideKey === 'listing') return 'seller'
  if (sideKey === 'buyer') return 'buyer'
  const rep = dealRepresents(deal)
  return rep === 'both' ? 'unsplit' : rep
}

// One side's entry as the Details tab stores it: { type, pct, flat }. Null
// when nothing usable was entered, so a blank side never prices at $0.
function entryFrom(raw) {
  if (!raw) return null
  if (raw.type === 'flat') {
    const flat = num(raw.flat, 0)
    return flat > 0 ? { type: 'flat', pct: 0, flat } : null
  }
  const pct = num(raw.pct, 0)
  return pct > 0 ? { type: 'percent', pct, flat: 0 } : null
}

/**
 * The per-side entries on a deal that represents BOTH sides, read from
 * comp_data.commission_sides — { seller, buyer }, either of which may be null —
 * or null when the deal doesn't represent both or nothing was entered per side.
 */
export function dealSideEntries(deal) {
  if (dealRepresents(deal) !== 'both') return null
  const raw = deal?.comp_data?.commission_sides
  if (!raw || typeof raw !== 'object') return null
  const seller = entryFrom(raw.seller)
  const buyer  = entryFrom(raw.buyer)
  return seller || buyer ? { seller, buyer } : null
}

/**
 * The single total a both-sides entry adds up to, in the deal's own
 * commission_type / commission_pct / commission_flat shape — what the Details
 * tab writes back to those columns so anything reading only them (agreement
 * fields, older reports) sees the real total. Two percentages stay a
 * percentage; anything involving a flat fee becomes the dollar total.
 */
export function totalEntryForSides(sides, value) {
  const list = PARTIES.map(k => entryFrom(sides?.[k])).filter(Boolean)
  if (!list.length) return { commission_type: 'percent', commission_pct: null, commission_flat: null }
  if (list.every(e => e.type === 'percent')) {
    return { commission_type: 'percent', commission_pct: round2(list.reduce((t, e) => t + e.pct, 0)), commission_flat: null }
  }
  const gross = list.reduce((t, e) => t + (e.type === 'flat' ? e.flat : num(value, 0) * e.pct / 100), 0)
  return { commission_type: 'flat', commission_pct: null, commission_flat: round2(gross) }
}

/**
 * Split `total` across weights so the parts are rounded to cents and still add
 * up to exactly `total` — the last part takes the rounding remainder.
 */
export function apportion(total, weights) {
  const sum = weights.reduce((t, w) => t + Math.max(0, num(w, 0)), 0)
  if (!weights.length) return []
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? round2(total) : 0))
  let given = 0
  return weights.map((w, i) => {
    if (i === weights.length - 1) return round2(total - given)
    const part = round2(total * Math.max(0, num(w, 0)) / sum)
    given += part
    return part
  })
}

/**
 * The assigned agent's own commission entry from the deal's Details tab, or
 * null when they haven't entered one. `commission_type` picks which field is
 * live — a zero/blank amount counts as "not entered" so an untouched deal falls
 * through to the back-office/default gross rather than computing to $0.
 */
export function dealCommissionEntry(deal) {
  if (!deal) return null
  if (deal.commission_type === 'flat') {
    const flat = num(deal.commission_flat, 0)
    return flat > 0 ? { type: 'flat', pct: 0, flat } : null
  }
  const pct = num(deal.commission_pct, 0)
  return pct > 0 ? { type: 'percent', pct, flat: 0 } : null
}

/**
 * A deal-level entry resolved to dollars: the entry plus the `gross` commission
 * it produces (the flat fee itself, or the rate applied to the deal value). Null
 * when the agent hasn't entered one. This is what the UI renders — the engine
 * itself goes through `normalizeCommission`.
 */
export function describeDealCommission(deal) {
  const value = num(deal?.value, 0)
  const grossOf = (e) => round2(e.type === 'flat' ? e.flat : value * e.pct / 100)
  // A both-sides deal entered per side: the total is the sum of the sides, and
  // `sides` says how much each one brings in.
  const perSide = dealSideEntries(deal)
  if (perSide) {
    const sides = PARTIES
      .filter(k => perSide[k])
      .map(k => ({ party: k, label: PARTY_LABELS[k], ...perSide[k], gross: grossOf(perSide[k]) }))
    const total = totalEntryForSides(perSide, value)
    const gross = round2(sides.reduce((t, x) => t + x.gross, 0))
    return total.commission_type === 'percent'
      ? { type: 'percent', pct: total.commission_pct, flat: 0, gross, sides }
      : { type: 'flat', pct: 0, flat: total.commission_flat, gross, sides }
  }
  const entry = dealCommissionEntry(deal)
  if (!entry) return null
  const party = partyForSide('sale', deal)
  const gross = grossOf(entry)
  return { ...entry, gross, sides: [{ party, label: PARTY_LABELS[party], ...entry, gross }] }
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
      sides: commission.sides.map(s => ({ ...makeSide(s.key, s.rate_pct), ...s, party: partyForSide(s.key, deal) })),
      participants: commission.participants.map(p => withConfirmedCap({ ...makeParticipant(), basis: 'saved', ...p }, agents, deal)),
      transaction_fee: num(commission.transaction_fee, 0),
    }
  }

  // Legacy flat shape (or no row yet) → upgrade to one side + participants.
  // The agent's own entry on the deal outranks the legacy scalar (see the
  // precedence list at the top of this file); a flat fee zeroes the rate.
  const entry        = dealCommissionEntry(deal)
  const gross_pct    = entry
    ? (entry.type === 'flat' ? 0 : entry.pct)
    : num(commission?.gross_pct, DEFAULTS.GROSS_PCT)
  const gross_flat   = entry && entry.type === 'flat' ? entry.flat : 0
  const referral_pct = num(commission?.referral_pct, 0)
  const agent_pct    = num(commission?.agent_pct, DEFAULTS.SPLIT_PCT)
  const co_agent_pct = num(commission?.co_agent_pct, 0)
  // A saved legacy row keeps its deal-level fee. With nothing saved, there is
  // no deal-level fee: each agent pays their own contract fee (contract_fee).
  const fee          = commission ? num(commission.transaction_fee, 0) : 0

  // A both-sides deal entered per side on the Details tab prices each side on
  // its own; everything else is one side, placed by what the deal represents.
  const perSide = !commission?.sides?.length ? dealSideEntries(deal) : null
  const sides = perSide
    ? [['listing', 'seller'], ['buyer', 'buyer']]
        .filter(([, party]) => perSide[party])
        .map(([key, party]) => {
          const e = perSide[party]
          return { ...makeSide(key, e.type === 'flat' ? 0 : e.pct, e.type === 'flat' ? e.flat : 0), referral_pct, party }
        })
    : [{ ...makeSide('sale', gross_pct, gross_flat), referral_pct, party: partyForSide('sale', deal) }]

  const primaryAgent = agents.find(a => a.id === deal?.agent_id) || null
  const primary = makeParticipant({ agent: primaryAgent, deal, role: 'primary', allocation_pct: 100 })
  // A legacy row the back office saved keeps its own agent_pct — its dollars
  // were reported on. With no row at all, the agent's own arrangement stands.
  if (commission) {
    primary.split_pct = agent_pct
    primary.no_split = false
    primary.basis = 'saved'
    Object.assign(primary, withConfirmedCap(primary, agents, deal))
  }

  const participants = [primary]

  // Legacy co-agent was carved out of the primary agent's take as a % of their
  // post-fee gross. Preserve that exactly by giving the co-agent that take as a
  // pass-through (no brokerage cut) — keeps already-saved deals identical.
  if (co_agent_pct > 0) {
    const co = makeParticipant({ role: 'co', allocation_pct: 0 })
    co._legacy_co_pct = co_agent_pct   // marker consumed below
    participants.push(co)
  }
  // Co-agents carried over from the property at conversion (deals.co_agent_ids).
  // Until the back office saves an explicit structured split, seed one
  // participant each on an even allocation, so a co-listed deal opens the
  // editor with the whole team already on it instead of the owner alone. Each
  // co-agent brings their OWN stored brokerage arrangement — a capped agent
  // still keeps 100%. Skipped when the legacy carve-out above is in play, whose
  // saved dollars must not move.
  else {
    const coAgentIds = dealCoAgentIds(deal)
    if (coAgentIds.length) {
      const evenly = round1(100 / (coAgentIds.length + 1))
      for (const id of coAgentIds) {
        participants.push(makeParticipant({
          agent: agents.find(a => a.id === id) || { id },
          deal,
          role: 'co',
          allocation_pct: evenly,
        }))
      }
      // The primary absorbs the rounding remainder so allocations total exactly
      // 100% and the editor never opens on a spurious warning.
      primary.allocation_pct = round1(100 - evenly * coAgentIds.length)
    }
  }

  // A saved legacy row's fee is the deal-level fee it was reported with, so its
  // participants don't bring contract fees of their own.
  if (commission) for (const p of participants) p.contract_fee = null

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
    const flat = num(s.flat, 0)
    // A flat fee is priced independently of the sale price; the percentage rate
    // only applies when no flat fee is set.
    const gross = flat > 0 ? flat : sale_price * rate / 100
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

  // Transaction fee, charged ON TOP and excluded from cap tracking. In order:
  //   1. a per-agent `fee` > 0 the back office typed — wins outright;
  //   2. the agent's own contract fee (`contract_fee`), on their allocation —
  //      full fee on a solo deal, half on a 50/50 co-listing;
  //   3. otherwise the deal-level `transaction_fee`, split evenly across the
  //      agents without a contract fee (rows saved before per-agent fees).
  // Legacy fixed-take co-agents pay nothing.
  const transaction_fee = num(input?.transaction_fee, 0)
  const feePayers = rawParts.filter(p => p._fixed_take == null && p._legacy_co_pct == null && !hasContractFee(p))
  const feeShare = feePayers.length ? transaction_fee / feePayers.length : 0

  const participants = rawParts.map(p => {
    const allocation = net_total * num(p.allocation_pct, 0) / 100
    const ownFee = num(p.fee, 0)
    const txnFee = p._fixed_take != null ? 0
      : ownFee > 0 ? ownFee
      : hasContractFee(p) ? num(p.contract_fee, 0) * num(p.allocation_pct, 0) / 100
      : feeShare

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

  // ── By side ───────────────────────────────────────────────────────────────
  // Where the money comes from. Sides are grouped by party (seller / buyer /
  // unsplit), and every agent's take and the house's share are divided between
  // the parties in proportion to the net each one contributes — the same rule
  // the allocation itself uses, so the parts always add back up to the totals.
  const partyOrder = [...PARTIES, 'unsplit']
  const partyKeys = partyOrder.filter(k => sides.some(sd => (sd.party || 'unsplit') === k))
  const partyNet = partyKeys.map(k => sides.filter(sd => (sd.party || 'unsplit') === k).reduce((t, sd) => t + sd.net, 0))
  for (const p of participants) {
    const shares = apportion(p.agent_take, partyNet)
    p.by_party = Object.fromEntries(partyKeys.map((k, i) => [k, shares[i]]))
  }
  const houseShares = apportion(house_total, partyNet)
  const parties = partyKeys.map((k, i) => {
    const own = sides.filter(sd => (sd.party || 'unsplit') === k)
    return {
      party: k,
      label: PARTY_LABELS[k],
      gross:    round2(own.reduce((t, sd) => t + sd.gross, 0)),
      referral: round2(own.reduce((t, sd) => t + sd.referral, 0)),
      net:      round2(partyNet[i]),
      agent_take: round2(participants.reduce((t, p) => t + (p.by_party[k] || 0), 0)),
      house: houseShares[i],
    }
  })

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
    parties,                 // [{ party, label, gross, referral, net, agent_take, house }] — seller, buyer, unsplit
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
 * Add a deal's by-side figures into a running total, for any report that sums
 * many deals: `acc` is { seller, buyer, unsplit } and `parts` is a list of
 * { party, [field] } — a breakdown's `parties`, or an agent slice's `byParty`.
 */
export function addByParty(acc, parts, field) {
  const next = { ...acc }
  for (const p of parts || []) next[p.party] = round2((next[p.party] || 0) + num(p[field], 0))
  return next
}

/** { seller, buyer, unsplit } totals → the [{ party, amount }] list the screens render. */
export function partyAmounts(totals) {
  return ['seller', 'buyer', 'unsplit']
    .filter(k => totals && num(totals[k], 0) !== 0)
    .map(k => ({ party: k, amount: round2(totals[k]) }))
}

/**
 * Convenience used by reporting: resolve a deal's full breakdown from the raw
 * commission row + context in one call.
 */
export function breakdownForDeal(deal, commission, agents) {
  return computeCommission(normalizeCommission(commission, { deal, agents }))
}

/**
 * One agent's slice of a deal: their take, the house revenue they generated,
 * and the cap-counting portion (brokerage split only — flat transaction fees
 * are charged on top of cap). Sums every participant row belonging to the
 * agent; falls back to deal ownership for legacy rows with no participants.
 * This is THE authoritative per-agent number used by My Earnings, the deal
 * page, and the brokerage report — one formula, three surfaces.
 */
export function agentSliceForDeal(deal, commission, agents, agentId) {
  const r = breakdownForDeal(deal, commission, agents)
  const mine = r.participants.filter(p => p.agent_id === agentId)
  // The agent's take by side, alongside each side's gross — what My Earnings
  // and the deal page show an agent who represents both sides.
  const byParty = (rows) => r.parties.map(pt => ({
    party: pt.party, label: pt.label, gross: pt.gross,
    take: round2(rows.reduce((t, p) => t + num(p.by_party?.[pt.party], 0), 0)),
  }))
  if (mine.length) {
    return {
      byParty: byParty(mine),
      // The agent's share of the commission before their split, and why their
      // split is what it is — what My Earnings shows as "gross → split → take".
      allocation: round2(mine.reduce((s, p) => s + num(p.allocation), 0)),
      basis: mine[0]?.basis || 'split',
      onDeal: true,
      take:  round2(mine.reduce((s, p) => s + num(p.agent_take), 0)),
      house: round2(mine.reduce((s, p) => s + num(p.house_from), 0)),
      cap:   round2(mine.reduce((s, p) => s + num(p.house_split), 0)),
      fees:  round2(mine.reduce((s, p) => s + num(p.fee, 0), 0)),
      splitPct: mine[0] ? num(mine[0].split_pct, null) : null,
      gross: r.gross_total,
    }
  }
  if (deal.agent_id === agentId) {
    return {
      byParty: r.parties.map(pt => ({ party: pt.party, label: pt.label, gross: pt.gross, take: pt.agent_take })),
      allocation: r.net_total, basis: r.primary?.basis || 'split',
      onDeal: true, take: r.agent_total, house: r.house_total,
      cap: r.house_split_total, fees: r.transaction_fee_total ?? 0,
      splitPct: r.primary ? num(r.primary.split_pct, null) : null, gross: r.gross_total,
    }
  }
  return { onDeal: false, take: 0, house: 0, cap: 0, fees: 0, splitPct: null, gross: 0, allocation: 0, basis: null, byParty: [] }
}

/**
 * Where an agent stands against their cap RIGHT NOW — the one answer the Caps
 * editor, the Brokerage Report and My Earnings all show. `paid` is the
 * brokerage split they've paid on deals closed this cap year (a confirmed cap
 * pays none, so it stops climbing once confirmed). `reached` means paid has hit
 * the cap; `confirmed` means the office has confirmed it for this cap year —
 * the only thing that switches the agent to 100%. `awaiting` is reached but not
 * yet confirmed: the office's to-do.
 */
export function capStatusFor(agent, { deals = [], commissionsByDeal = new Map(), agents = [], now = new Date() } = {}) {
  const windowStart = capWindowStart(agent?.cap_anniversary, now)
  let paid = 0
  for (const d of deals) {
    if (d.stage !== 'closed') continue
    if (dealCommissionDate(d, now) < windowStart) continue
    paid += agentSliceForDeal(d, commissionsByDeal.get(d.id), agents, agent.id).cap
  }
  paid = round2(paid)
  const amount    = agent?.cap_amount != null && agent.cap_amount !== '' ? num(agent.cap_amount, 0) : null
  const prepaid   = agent?.no_brokerage_split === true
  const confirmed = !prepaid && capCovers(agent, now)
  const reached   = amount != null && amount > 0 && paid >= amount
  return {
    windowStart, paid, amount, prepaid, confirmed, reached,
    awaiting: reached && !confirmed && !prepaid,
    confirmedAt: confirmed ? agent.cap_confirmed_at : null,
    until: confirmed ? capConfirmedUntil(agent) : null,
    pct: prepaid || confirmed ? 100 : (amount > 0 ? Math.min(100, Math.round(paid / amount * 100)) : null),
  }
}

/** Today as YYYY-MM-DD in local time — the value a date column expects. */
export function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * Start of an agent's CURRENT cap year. Caps reset on the agent's anniversary
 * (month + day) each year; agents without an anniversary date fall back to a
 * calendar year. Returns a Date.
 */
export function capWindowStart(capAnniversary, now = new Date()) {
  if (!capAnniversary) return new Date(now.getFullYear(), 0, 1)
  // Date-only strings parse as UTC midnight, which shifts a day in negative-
  // offset timezones — anchor to noon so month/day are stable everywhere.
  const ann = new Date(/^\d{4}-\d{2}-\d{2}$/.test(capAnniversary) ? `${capAnniversary}T12:00:00` : capAnniversary)
  if (Number.isNaN(ann.getTime())) return new Date(now.getFullYear(), 0, 1)
  const thisYear = new Date(now.getFullYear(), ann.getMonth(), ann.getDate())
  return thisYear <= now ? thisYear : new Date(now.getFullYear() - 1, ann.getMonth(), ann.getDate())
}
