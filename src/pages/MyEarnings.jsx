import React, { useState, useEffect } from 'react'
import { getAuthSession } from '../lib/services/auth.js'
import { Icon, Badge, EmptyState, Loading } from '../components/UI.jsx'
import { formatCurrency, formatMoney, formatDate } from '../lib/helpers.js'
import { useStageLabels } from '../lib/stageLabelContext.js'
import EarningsChart from '../components/EarningsChart.jsx'
import SideSplit from '../components/SideSplit.jsx'
import { addByParty, partyAmounts } from '../lib/commission.js'

// ─────────────────────────────────────────────────────────────────────────────
// My Earnings — what a non-admin agent sees on the Commission page since the
// back-office change (2026-06-12): their own takes, cap progress, and fees.
// All numbers come from /api/portal?action=my-earnings, which computes the
// caller's slice server-side — co-agents' splits never reach this browser.
// ─────────────────────────────────────────────────────────────────────────────

// Why a deal pays 100% — shown under the split so an agent can see it is not a typo.
const SPLIT_BASIS = { cap: 'Cap met', prepaid: 'Pre-paid' }

export default function MyEarnings({ activeAgent }) {
  const stageLabels       = useStageLabels()
  const [data, setData]   = useState(null)
  const [error, setError] = useState(null)

  const load = async () => {
    setError(null)
    try {
      const { data: { session } } = await getAuthSession()
      if (!session?.access_token) { setError('Please sign in again.'); return }
      const res = await fetch('/api/portal?action=my-earnings', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await res.json()
      if (!res.ok) { setError(body.error || 'Could not load earnings'); return }
      setData(body)
    } catch {
      setError('Could not reach the server — check your connection.')
    }
  }
  useEffect(() => { load() }, [])

  if (error) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">My Earnings</div></div></div>
      <EmptyState icon="commission" title="Couldn't load your earnings" message={error}
        action={<button className="btn btn--primary" onClick={load}>Try again</button>} />
    </div>
  )
  if (!data) return <div className="page-content"><Loading /></div>

  const { cap, ytd, deals } = data
  const open   = deals.filter(d => !d.closed && d.stage !== 'lost')
  const closed = deals.filter(d => d.closed)
  const capPct = cap.prepaid || cap.confirmed ? 100 : (cap.amount > 0 ? Math.min(100, Math.round(cap.ytd_cap_paid / cap.amount * 100)) : 0)
  const pipelineTake = open.reduce((s, d) => s + (d.take || 0), 0)
  // Every figure says which side of the table it comes from. `by_party` is
  // computed on the server with the take itself; an older server sends none
  // and the split lines simply don't show.
  const pipelineByParty = open.reduce((acc, d) => addByParty(acc, d.by_party, 'take'), {})
  const dealParts = (d) => (d.by_party || []).map(p => ({ party: p.party, amount: p.take }))

  const dealRow = (d) => (
    <tr key={d.deal_id} style={{ borderTop: '1px solid var(--gw-border)' }}>
      <td style={{ padding: '9px 12px', fontWeight: 600 }}>{d.title}</td>
      <td style={{ padding: '9px 12px' }}><Badge variant={d.stage === 'closed' ? 'closed' : d.stage === 'lost' ? 'lost' : 'lead'}>{stageLabels[d.stage] || d.stage}</Badge></td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{d.value > 0 ? formatCurrency(d.value) : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{d.allocation > 0 ? formatMoney(d.allocation) : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>
        {d.split_pct != null ? `${d.split_pct}%` : '—'}
        {SPLIT_BASIS[d.basis] && <div style={{ fontSize: 11, color: 'var(--gw-green)', fontWeight: 600 }}>{SPLIT_BASIS[d.basis]}</div>}
      </td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.fees > 0 ? `− ${formatMoney(d.fees)}` : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--gw-green)' }}>
        {formatMoney(d.take)}
        <SideSplit parts={dealParts(d)} />
      </td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.closed_at ? formatDate(d.closed_at) : '—'}</td>
    </tr>
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">My Earnings</div>
          <div className="page-sub">What you really take home: your share of each commission, after your split with the office and the transaction fee.</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={() => { setData(null); load() }}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      {/* ── Summary ── */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 16 }}>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color: 'var(--gw-green)' }}>{formatMoney(ytd.take)}</div>
          <div className="stat-card__label">Earned this cap year</div>
          <SideSplit parts={partyAmounts(ytd.by_party)} />
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{ytd.deals}</div>
          <div className="stat-card__label">Deals closed</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatMoney(pipelineTake)}</div>
          <div className="stat-card__label">Projected from open deals</div>
          <SideSplit parts={partyAmounts(pipelineByParty)} />
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatMoney(cap.ytd_fees)}</div>
          <div className="stat-card__label">Transaction fees paid</div>
        </div>
      </div>

      {/* ── The year, month by month ──
          The four totals above say how much; this says WHEN — which months were
          empty, and how much of the projection rests on a single deal. Drawn
          from the same `deals` payload, so it costs no extra request. */}
      <div className="card" style={{ marginBottom: 16, padding: '16px 20px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Commission by month</div>
        <EarningsChart deals={deals} />
      </div>

      {/* ── Cap tracker ── */}
      <div className="card" style={{ marginBottom: 20, padding: '18px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Cap Progress</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
            {cap.prepaid
              ? 'Cap pre-paid — you keep 100% of your splits 🎉'
              : cap.amount > 0
                ? `${formatMoney(cap.ytd_cap_paid)} of ${formatMoney(cap.amount)} · resets ${cap.anniversary ? formatDate(cap.anniversary).replace(/, \d{4}$/, '') : 'Jan 1'}`
                : 'No cap configured — ask the office to set yours'}
            {!cap.prepaid && !cap.confirmed && cap.split_pct != null && cap.amount > 0 && <> · your split is {cap.split_pct}% until it&rsquo;s met</>}
          </div>
        </div>
        <div style={{ height: 10, background: 'var(--gw-border)', borderRadius: 5, overflow: 'hidden' }}>
          <div style={{ width: `${capPct}%`, height: '100%', borderRadius: 5, transition: 'width 400ms ease',
            background: cap.capped ? 'var(--gw-green)' : 'var(--gw-azure)' }} />
        </div>
        {cap.confirmed && (
          <div style={{ fontSize: 12, color: 'var(--gw-green)', fontWeight: 700, marginTop: 8 }}>
            🎉 Cap met — confirmed by the office{cap.confirmed_at ? ` on ${formatDate(cap.confirmed_at)}` : ''}. You keep 100% of every
            commission until {cap.confirmed_until ? formatDate(cap.confirmed_until) : 'your cap anniversary'} (the transaction fee still applies).
          </div>
        )}
        {cap.awaiting_confirmation && (
          <div style={{ fontSize: 12, color: 'var(--gw-amber)', fontWeight: 700, marginTop: 8 }}>
            You&rsquo;ve reached your cap. Once the office confirms it, you keep 100% of every commission from that day on.
          </div>
        )}
      </div>

      {/* ── Deals ── */}
      {deals.length === 0 ? (
        <EmptyState icon="commission" title="No commission entries yet"
          message={'Enter the commission on a deal\u2019s Details tab and your take-home appears here — after your split and the transaction fee.'} />
      ) : (
        <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)', background: '#fff', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--gw-bone)', textAlign: 'left' }}>
                {['Deal', 'Stage', 'Sale Price', 'Your Share', 'Your Split', 'Fee', 'You Take Home', 'Closed'].map(h => (
                  <th key={h} style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {open.map(dealRow)}
              {closed.map(dealRow)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
