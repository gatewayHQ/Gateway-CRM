import React, { useEffect, useState } from 'react'
import { formatCurrency } from '../lib/helpers.js'
import { loadPricingHistory, loadDealPricingHistory } from '../lib/services/pricing.js'

// ─────────────────────────────────────────────────────────────────────────────
// Pricing History — the same panel on a property and on a deal.
//
// This is the property drawer's original Price History tab, lifted out so the
// deal drawer shows the identical thing. That matters beyond tidiness: the price
// is ONE number shared by the listing and every deal on it (src/lib/pricing.js),
// so two differently-shaped histories of it would be two accounts of the same
// events. One component, one source, read from whichever surface you are on.
//
// `entries` are normalized (src/lib/pricing.js): `reduction` is positive for a
// price cut, negative for an increase, and null for the first recorded price —
// which renders as "Initial price" rather than a fake reduction from zero.
// ─────────────────────────────────────────────────────────────────────────────

const dateLabel = (at) => {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const SOURCE_LABELS = { deal: 'on the deal', property: 'on the listing', import: '', system: '' }

// Who and where, on one line — 'Daniel Stillson · on the deal'. Legacy jsonb
// entries have neither, and print nothing rather than a placeholder.
function attribution(entry) {
  return [entry.changedByName, SOURCE_LABELS[entry.source] || ''].filter(Boolean).join(' · ')
}

function HistoryRow({ entry }) {
  const initial   = entry.reduction === null
  const reduction = entry.reduction || 0
  const pct = entry.previousPrice > 0 ? Math.abs(reduction / entry.previousPrice * 100).toFixed(1) : 0
  const who = attribution(entry)

  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:6, background:'#fff' }}>
      <div style={{ width:32, height:32, borderRadius:6, background: initial ? 'var(--gw-bone)' : reduction > 0 ? '#fee2e2' : '#dcfce7', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
        {initial ? '•' : reduction > 0 ? '↓' : '↑'}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:700, color: initial ? 'var(--gw-ink)' : reduction > 0 ? '#dc2626' : '#16a34a' }}>
          {formatCurrency(entry.price)}
          {!initial && (
            <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)', marginLeft:8 }}>from {formatCurrency(entry.previousPrice)}</span>
          )}
        </div>
        <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
          {initial
            ? 'Initial price'
            : reduction > 0
              ? `↓ ${formatCurrency(Math.abs(reduction))} (${pct}% reduction)`
              : `↑ ${formatCurrency(Math.abs(reduction))} increase`}
          {who ? ` · ${who}` : ''}
        </div>
      </div>
      <div style={{ fontSize:11, color:'var(--gw-mist)', whiteSpace:'nowrap' }}>{dateLabel(entry.at)}</div>
    </div>
  )
}

/**
 * The panel itself. Newest first — the reverse of how the entries are stored,
 * which is the order the property tab has always shown.
 *
 * @param {Array}   entries    normalized history entries (oldest first)
 * @param {boolean} loading
 * @param {string}  emptyHint  the line under "No price changes recorded yet."
 * @param {boolean} tableReady false when `pricing_history` isn't there yet (pre-0040)
 */
export default function PricingHistoryPanel({ entries = [], loading = false, emptyHint, tableReady = true }) {
  if (loading) return (
    <div style={{ padding:24, textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>Loading price history…</div>
  )

  if (entries.length === 0) return (
    <div style={{ padding:24, textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>
      No price changes recorded yet.<br/>
      <span style={{ fontSize:11 }}>
        {emptyHint || 'Changes are tracked automatically when you update the price and save.'}
      </span>
      {!tableReady && (
        <div style={{ fontSize:11, marginTop:10, color:'#b45309' }}>
          Shared pricing history is not set up on this database yet — ask an admin to apply migration 0040.
        </div>
      )}
    </div>
  )

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>Price History</div>
      {[...entries].reverse().map((entry, i) => <HistoryRow key={entry.id || `${entry.at}-${i}`} entry={entry} />)}
      {!tableReady && (
        <div style={{ fontSize:11, color:'#b45309', marginTop:8 }}>
          Showing this listing's own record only — shared pricing history needs migration 0040.
        </div>
      )}
    </div>
  )
}

/**
 * Property drawer tab. `property` carries the in-drawer (possibly unsaved)
 * `price_history` mirror, so a reduction the agent just saved is visible without
 * waiting for a reload — exactly how the original tab behaved.
 */
export function PropertyPricingHistoryTab({ property, refreshKey }) {
  const { entries, loading, tableReady } = usePricingHistory(
    () => loadPricingHistory({ propertyId: property?.id, property }),
    [property?.id, refreshKey, JSON.stringify(property?.price_history || [])],
  )
  return (
    <PricingHistoryPanel entries={entries} loading={loading} tableReady={tableReady}
      emptyHint="Changes are tracked automatically when you update the list price and save." />
  )
}

/**
 * Deal drawer tab. Reads the LINKED PROPERTY's history — the price belongs to
 * the building, so a reduction a colleague made on the listing shows up here
 * too, and a change made here shows up there.
 */
export function DealPricingHistoryTab({ deal, property, refreshKey }) {
  const { entries, loading, tableReady } = usePricingHistory(
    () => loadDealPricingHistory({ deal, property }),
    [deal?.id, deal?.property_id, refreshKey, JSON.stringify(property?.price_history || [])],
  )
  return (
    <>
      {!deal?.property_id && (
        <div style={{ padding:'12px 16px 0', fontSize:11.5, color:'var(--gw-mist)' }}>
          No property linked — link one on the Details tab and this deal's price changes join the listing's history.
        </div>
      )}
      <PricingHistoryPanel entries={entries} loading={loading} tableReady={tableReady}
        emptyHint="Changes are tracked automatically when you update the Sale / Deal Value and save — on the deal or on the listing." />
    </>
  )
}

// Shared loader. Deliberately re-runs on the property's jsonb mirror as well as
// its id: the drawer saves, patches its own copy, and the tab must show the
// entry it just wrote without a full reload.
function usePricingHistory(load, deps) {
  const [state, setState] = useState({ entries: [], loading: true, tableReady: true })
  useEffect(() => {
    let alive = true
    setState(s => ({ ...s, loading: true }))
    load().then(({ entries, tableReady }) => {
      if (alive) setState({ entries, loading: false, tableReady })
    }).catch(() => { if (alive) setState({ entries: [], loading: false, tableReady: true }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids and
    // the mirror's CONTENT, so a background refetch that changes nothing is a no-op.
  }, deps)
  return state
}
