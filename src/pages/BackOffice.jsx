import React, { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { withRetry, mutationErrorMessage } from '../lib/services/db.js'
import { Icon, Avatar, Badge, pushToast } from '../components/UI.jsx'
import { formatCurrency, formatCurrencyExact, formatDate } from '../lib/helpers.js'
import { agentSliceForDeal, capWindowStart } from '../lib/commission.js'

// ─────────────────────────────────────────────────────────────────────────────
// Back Office (admin-only) — quarterly brokerage reporting and cap management.
// Rendered as tabs inside the Commission page for admins. Uses the SAME slice
// engine as My Earnings and the tracker, so every surface agrees to the cent.
// ─────────────────────────────────────────────────────────────────────────────

const fmt  = (n) => formatCurrency(Math.round((n + Number.EPSILON) * 100) / 100)       // entered figures (volume, cap amounts)
const fmtC = (n) => formatCurrencyExact(Math.round((n + Number.EPSILON) * 100) / 100)  // commission money — exact cents, never rounded to dollars

// Reporting periods: quarters + years, newest first
function buildPeriods(now = new Date()) {
  const periods = []
  const y = now.getFullYear(), q = Math.floor(now.getMonth() / 3)
  for (let i = 0; i < 5; i++) {
    const qy = y + Math.floor((q - i) / 4) * 1 - (q - i < 0 ? 1 : 0) * 0  // handled below
    const qi = ((q - i) % 4 + 4) % 4
    const yy = y - Math.floor((i - q + 3) / 4)
    periods.push({
      id: `q-${yy}-${qi}`, label: `Q${qi + 1} ${yy}${i === 0 ? ' (current)' : ''}`,
      start: new Date(yy, qi * 3, 1), end: new Date(yy, qi * 3 + 3, 0, 23, 59, 59),
    })
  }
  periods.push({ id: `y-${y}`,     label: `${y} full year`,     start: new Date(y, 0, 1),     end: new Date(y, 11, 31, 23, 59, 59) })
  periods.push({ id: `y-${y - 1}`, label: `${y - 1} full year`, start: new Date(y - 1, 0, 1), end: new Date(y - 1, 11, 31, 23, 59, 59) })
  return periods
}

export function BrokerageReport({ db }) {
  const agents      = db.agents      || []
  const deals       = db.deals       || []
  const commissions = db.commissions || []
  const periods     = useMemo(() => buildPeriods(), [])
  const [periodId, setPeriodId] = useState(periods[0].id)
  const period = periods.find(p => p.id === periodId) || periods[0]

  const commByDeal = useMemo(() => new Map(commissions.map(c => [c.deal_id, c])), [commissions])

  const report = useMemo(() => {
    const closedInPeriod = deals.filter(d => {
      if (d.stage !== 'closed') return false
      const at = new Date(d.updated_at || d.created_at)
      return at >= period.start && at <= period.end
    })
    const rows = agents.map(a => {
      let dealsCount = 0, volume = 0, gci = 0, take = 0, capPaid = 0, fees = 0
      for (const d of closedInPeriod) {
        const slice = agentSliceForDeal(d, commByDeal.get(d.id), agents, a.id)
        if (!slice.onDeal) continue
        dealsCount += 1
        volume += Number(d.value) || 0
        gci += slice.gross
        take += slice.take
        capPaid += slice.cap
        fees += slice.fees
      }
      // Cap progress over the agent's CURRENT cap window (independent of the
      // selected report period — it answers "where do they stand right now?")
      const winStart = capWindowStart(a.cap_anniversary)
      let capYearPaid = 0
      for (const d of deals) {
        if (d.stage !== 'closed') continue
        if (new Date(d.updated_at || d.created_at) < winStart) continue
        capYearPaid += agentSliceForDeal(d, commByDeal.get(d.id), agents, a.id).cap
      }
      return { agent: a, dealsCount, volume, gci, take, capPaid, fees, capYearPaid }
    }).filter(r => r.dealsCount > 0 || r.agent.cap_amount != null || r.agent.no_brokerage_split)
      .sort((x, y) => y.take - x.take)

    const totals = rows.reduce((t, r) => ({
      dealsCount: t.dealsCount + r.dealsCount, volume: t.volume + r.volume,
      gci: t.gci + r.gci, take: t.take + r.take, capPaid: t.capPaid + r.capPaid, fees: t.fees + r.fees,
    }), { dealsCount: 0, volume: 0, gci: 0, take: 0, capPaid: 0, fees: 0 })
    return { rows, totals }
  }, [deals, agents, commByDeal, period])

  const exportCSV = () => {
    const head = ['Agent', 'Closed Deals', 'Volume', 'GCI', 'Agent Take', 'House Split (cap)', 'Transaction Fees', 'Cap Status']
    const lines = [head.join(',')]
    for (const r of report.rows) {
      const capStatus = r.agent.no_brokerage_split ? 'Pre-paid'
        : r.agent.cap_amount > 0 ? `${r.capYearPaid.toFixed(2)} / ${r.agent.cap_amount}` : 'No cap set'
      lines.push([`"${r.agent.name}"`, r.dealsCount, r.volume, r.gci.toFixed(2), r.take.toFixed(2), r.capPaid.toFixed(2), r.fees.toFixed(2), `"${capStatus}"`].join(','))
    }
    const t = report.totals
    lines.push(['"TOTAL"', t.dealsCount, t.volume, t.gci.toFixed(2), t.take.toFixed(2), t.capPaid.toFixed(2), t.fees.toFixed(2), ''].join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `gateway-brokerage-report-${period.label.replace(/\s+/g, '-').toLowerCase()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <select className="form-control" style={{ width: 220, fontSize: 13 }} value={periodId} onChange={e => setPeriodId(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button className="btn btn--secondary btn--sm" onClick={exportCSV}><Icon name="download" size={13} /> Export CSV</button>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 16 }}>
        <div className="stat-card"><div className="stat-card__value">{report.totals.dealsCount}</div><div className="stat-card__label">Closed Deals</div></div>
        <div className="stat-card"><div className="stat-card__value">{fmt(report.totals.volume)}</div><div className="stat-card__label">Sales Volume</div></div>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--gw-azure)' }}>
          <div className="stat-card__value" style={{ color: 'var(--gw-azure)' }}>{fmtC(report.totals.capPaid + report.totals.fees)}</div>
          <div className="stat-card__label">Brokerage Revenue (splits + fees)</div>
        </div>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color: 'var(--gw-green)' }}>{fmtC(report.totals.take)}</div>
          <div className="stat-card__label">Agent Earnings Paid</div>
        </div>
      </div>

      <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)', background: '#fff', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--gw-bone)', textAlign: 'left' }}>
              {['Agent', 'Deals', 'Volume', 'GCI', 'Agent Take', 'House Split', 'Txn Fees', 'Cap Progress (current year)'].map(h => (
                <th key={h} style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map(r => {
              const capPct = r.agent.no_brokerage_split ? 100
                : r.agent.cap_amount > 0 ? Math.min(100, Math.round(r.capYearPaid / r.agent.cap_amount * 100)) : null
              return (
                <tr key={r.agent.id} style={{ borderTop: '1px solid var(--gw-border)' }}>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar agent={r.agent} size={22} /><span style={{ fontWeight: 600 }}>{r.agent.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '9px 12px' }}>{r.dealsCount}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmt(r.volume)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmtC(r.gci)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--gw-green)' }}>{fmtC(r.take)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmtC(r.capPaid)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmtC(r.fees)}</td>
                  <td style={{ padding: '9px 12px', minWidth: 180 }}>
                    {r.agent.no_brokerage_split ? (
                      <Badge variant="active">Cap pre-paid</Badge>
                    ) : capPct == null ? (
                      <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No cap set</span>
                    ) : (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--gw-mist)', marginBottom: 3 }}>
                          <span>{fmtC(r.capYearPaid)} / {fmt(r.agent.cap_amount)}</span><span>{capPct}%</span>
                        </div>
                        <div style={{ height: 6, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${capPct}%`, height: '100%', background: capPct >= 100 ? 'var(--gw-green)' : 'var(--gw-azure)' }} />
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
            {report.rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--gw-mist)' }}>No closed deals in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--gw-mist)', marginTop: 10 }}>
        Closed-deal attribution uses the deal's last-updated date. Cap progress is measured over each agent's own cap year
        (anniversary-based when set), independent of the report period.
      </div>
    </div>
  )
}

export function CapsEditor({ db, setDb }) {
  const agents = db.agents || []
  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(null)

  const draftFor = (a) => drafts[a.id] || {
    cap_amount: a.cap_amount ?? '',
    cap_anniversary: a.cap_anniversary || '',
    no_brokerage_split: !!a.no_brokerage_split,
    default_split_pct: a.default_split_pct ?? 70,
  }
  const setDraft = (id, patch) => setDrafts(p => ({ ...p, [id]: { ...draftFor(agents.find(a => a.id === id)), ...p[id], ...patch } }))

  const save = async (a) => {
    const d = draftFor(a)
    setSaving(a.id)
    const payload = {
      cap_amount: d.cap_amount === '' ? null : Number(d.cap_amount),
      cap_anniversary: d.cap_anniversary || null,
      no_brokerage_split: !!d.no_brokerage_split,
      default_split_pct: d.default_split_pct === '' ? null : Number(d.default_split_pct),
    }
    const { error, status } = await withRetry(() => supabase.from('agents').update(payload).eq('id', a.id))
    setSaving(null)
    if (error) { pushToast(mutationErrorMessage(error, status), 'error'); return }
    setDb(p => ({ ...p, agents: (p.agents || []).map(x => x.id === a.id ? { ...x, ...payload } : x) }))
    pushToast(`${a.name} updated`)
  }

  return (
    <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)', background: '#fff', overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--gw-bone)', textAlign: 'left' }}>
            {['Agent', 'Default Split %', 'Cap Amount ($)', 'Cap Anniversary', 'Cap Pre-paid / No Split', ''].map(h => (
              <th key={h} style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map(a => {
            const d = draftFor(a)
            return (
              <tr key={a.id} style={{ borderTop: '1px solid var(--gw-border)' }}>
                <td style={{ padding: '9px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Avatar agent={a} size={22} /><span style={{ fontWeight: 600 }}>{a.name}</span>
                    {a.is_admin && <Badge variant="active">admin</Badge>}
                  </div>
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <input type="number" min="0" max="100" className="form-control" style={{ width: 80, fontSize: 12.5 }}
                    value={d.default_split_pct} onChange={e => setDraft(a.id, { default_split_pct: e.target.value })} disabled={d.no_brokerage_split} />
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <input type="number" min="0" className="form-control" style={{ width: 120, fontSize: 12.5 }} placeholder="e.g. 25000"
                    value={d.cap_amount} onChange={e => setDraft(a.id, { cap_amount: e.target.value })} disabled={d.no_brokerage_split} />
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <input type="date" className="form-control" style={{ width: 150, fontSize: 12.5 }}
                    value={d.cap_anniversary} onChange={e => setDraft(a.id, { cap_anniversary: e.target.value })} disabled={d.no_brokerage_split} />
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <input type="checkbox" checked={d.no_brokerage_split} onChange={e => setDraft(a.id, { no_brokerage_split: e.target.checked })} />
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <button className="btn btn--primary btn--sm" onClick={() => save(a)} disabled={saving === a.id}>
                    {saving === a.id ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 11.5, color: 'var(--gw-mist)', padding: '10px 12px' }}>
        Anniversary = the date the agent's cap year restarts (year is ignored; only month/day matter). Leave blank for calendar-year resets.
        "Cap pre-paid" marks agents who paid up front and keep 100% of splits — flat transaction fees still apply.
      </div>
    </div>
  )
}
