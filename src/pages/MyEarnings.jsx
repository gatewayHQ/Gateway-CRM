import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Badge, EmptyState, Loading } from '../components/UI.jsx'
import { formatCurrency, formatDate, STAGE_LABELS } from '../lib/helpers.js'
import EarningsChart from '../components/EarningsChart.jsx'
import { RANGE_PRESETS } from '../lib/earnings.js'

// ─────────────────────────────────────────────────────────────────────────────
// My Earnings — what a non-admin agent sees on the Commission page since the
// back-office change (2026-06-12): their own takes, cap progress, and fees.
// All numbers come from /api/portal?action=my-earnings, which computes the
// caller's slice server-side — co-agents' splits never reach this browser.
//
// The chart (2026-07-27) is aggregated server-side too: the endpoint returns a
// ready-made `series` for the selected range, so changing the range refetches
// rather than re-crunching hundreds of deals in the browser. There is no
// agent_id parameter — the JWT decides whose earnings these are, so an agent
// cannot request a colleague's chart.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_RANGE = { preset: '12m', from: '', to: '' }

export default function MyEarnings({ activeAgent }) {
  const [data, setData]   = useState(null)
  const [error, setError] = useState(null)
  const [range, setRange] = useState(DEFAULT_RANGE)
  const [busy, setBusy]   = useState(false)
  // Which chart bar is selected — filters the deals table underneath.
  const [picked, setPicked] = useState(null)

  const load = useCallback(async (nextRange = range, { keepData = false } = {}) => {
    setError(null)
    setBusy(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setError('Please sign in again.'); return }
      const qs = new URLSearchParams({ action: 'my-earnings', range: nextRange.preset })
      if (nextRange.preset === 'custom') {
        if (nextRange.from) qs.set('from', nextRange.from)
        if (nextRange.to)   qs.set('to', nextRange.to)
      }
      const res = await fetch(`/api/portal?${qs}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await res.json()
      if (!res.ok) { setError(body.error || 'Could not load earnings'); return }
      setData(body)
      if (!keepData) setPicked(null)
    } catch {
      setError('Could not reach the server — check your connection.')
    } finally {
      setBusy(false)
    }
  }, [range])

  useEffect(() => { load(range) /* eslint-disable-next-line */ }, [range.preset, range.from, range.to])

  if (error) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">My Earnings</div></div></div>
      <EmptyState icon="commission" title="Couldn't load your earnings" message={error}
        action={<button className="btn btn--primary" onClick={() => load(range)}>Try again</button>} />
    </div>
  )
  if (!data) return <div className="page-content"><Loading /></div>

  const { cap, ytd, deals, series } = data
  const open   = deals.filter(d => !d.closed && d.stage !== 'lost')
  const closed = deals.filter(d => d.closed)
  const capPct = cap.prepaid ? 100 : (cap.amount > 0 ? Math.min(100, Math.round(cap.ytd_cap_paid / cap.amount * 100)) : 0)
  const pipelineTake = open.reduce((s, d) => s + (d.take || 0), 0)

  // Clicking a bar narrows the closed list to that period; open deals are hidden
  // while a period is selected (they haven't earned in it yet).
  const pickedPoint = picked ? (series?.points || []).find(p => p.key === picked) : null
  const pickedIds   = pickedPoint ? new Set(pickedPoint.items.map(i => i.deal_id)) : null
  const closedRows  = pickedIds ? closed.filter(d => pickedIds.has(d.deal_id)) : closed
  const openRows    = pickedIds ? [] : open

  const rangeLabel = RANGE_PRESETS.find(p => p.id === (series?.preset || range.preset))?.label || 'range'

  const changeRange = (next) => {
    // Switching to Custom keeps the window already on screen, so the chart holds
    // still until the agent actually moves a date.
    if (next.preset === 'custom' && !next.from && !next.to) {
      setRange({ preset: 'custom', from: series?.from || '', to: series?.to || '' })
      return
    }
    // A half-entered custom range would refetch the same thing — hold until both
    // dates are set.
    if (next.preset === 'custom' && !(next.from && next.to)) { setRange(r => ({ ...r, ...next })); return }
    setRange(next)
  }

  const dealRow = (d) => (
    <tr key={d.deal_id} style={{ borderTop: '1px solid var(--gw-border)' }}>
      <td style={{ padding: '9px 12px', fontWeight: 600 }}>{d.title}</td>
      <td style={{ padding: '9px 12px' }}><Badge variant={d.stage === 'closed' ? 'closed' : d.stage === 'lost' ? 'lost' : 'lead'}>{STAGE_LABELS[d.stage] || d.stage}</Badge></td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{d.value > 0 ? formatCurrency(d.value) : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
        {d.is_flat
          ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-azure)', background: '#eff6ff', padding: '2px 7px', borderRadius: 8 }}>Flat fee</span>
          : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-green)', background: '#f0fdf4', padding: '2px 7px', borderRadius: 8 }}>% rate</span>}
      </td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--gw-green)' }}>{formatCurrency(d.take)}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.split_pct != null ? `${d.split_pct}%` : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.fees > 0 ? formatCurrency(d.fees) : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.closed_at ? formatDate(d.closed_at) : '—'}</td>
    </tr>
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">My Earnings</div>
          <div className="page-sub">Your commissions only — splits are entered and managed by the office.</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={() => load(range, { keepData: true })} disabled={busy}>
          <Icon name="refresh" size={13} /> {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ── Summary ── */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 16 }}>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color: 'var(--gw-green)' }}>{formatCurrency(ytd.take)}</div>
          <div className="stat-card__label">Earned this cap year</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{ytd.deals}</div>
          <div className="stat-card__label">Deals closed</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatCurrency(pipelineTake)}</div>
          <div className="stat-card__label">Projected from open deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatCurrency(cap.ytd_fees)}</div>
          <div className="stat-card__label">Transaction fees paid</div>
        </div>
      </div>

      {/* ── Earnings chart ── */}
      <EarningsChart
        series={series}
        loading={busy && !series}
        range={range}
        onRangeChange={changeRange}
        selectedKey={picked}
        onSelect={setPicked}
        title="My Commissions"
        subtitle={`Closed deals · ${rangeLabel.toLowerCase()} · by ${series?.bucket === 'week' ? 'week' : 'month'}`}
      />

      {/* ── Cap tracker ── */}
      <div className="card" style={{ marginBottom: 20, padding: '18px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Cap Progress</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
            {cap.prepaid
              ? 'Cap pre-paid — you keep 100% of your splits 🎉'
              : cap.amount > 0
                ? `${formatCurrency(cap.ytd_cap_paid)} of ${formatCurrency(cap.amount)} · resets ${cap.anniversary ? formatDate(cap.anniversary).replace(/, \d{4}$/, '') : 'Jan 1'}`
                : 'No cap configured — ask the office to set yours'}
          </div>
        </div>
        <div style={{ height: 10, background: 'var(--gw-border)', borderRadius: 5, overflow: 'hidden' }}>
          <div style={{ width: `${capPct}%`, height: '100%', borderRadius: 5, transition: 'width 400ms ease',
            background: cap.capped ? 'var(--gw-green)' : 'var(--gw-azure)' }} />
        </div>
        {cap.capped && !cap.prepaid && (
          <div style={{ fontSize: 12, color: 'var(--gw-green)', fontWeight: 700, marginTop: 8 }}>
            🎉 Cap hit — every split from here is 100% yours (flat fees still apply).
          </div>
        )}
      </div>

      {/* ── Deals ── */}
      {deals.length === 0 ? (
        <EmptyState icon="commission" title="No commission entries yet"
          message="When the office enters a commission on one of your deals, your numbers appear here." />
      ) : (
        <>
          {pickedPoint && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {pickedPoint.label} — {formatCurrency(pickedPoint.take)} from {pickedPoint.deals} deal{pickedPoint.deals === 1 ? '' : 's'}
              </span>
              <button className="btn btn--ghost btn--sm" onClick={() => setPicked(null)} style={{ fontSize: 12 }}>
                <Icon name="x" size={11} /> Clear period filter
              </button>
            </div>
          )}
          <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)', background: '#fff', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--gw-bone)', textAlign: 'left' }}>
                  {['Deal', 'Stage', 'Sale Price', 'Priced', 'Your Take', 'Your Split', 'Fee', 'Closed'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openRows.map(dealRow)}
                {closedRows.map(dealRow)}
                {pickedIds && closedRows.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '14px 12px', color: 'var(--gw-mist)', fontSize: 12 }}>
                    No deals from this period are in your list.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
