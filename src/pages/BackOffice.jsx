import React, { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { withRetry, mutationErrorMessage } from '../lib/services/db.js'
import { Icon, Avatar, Badge, pushToast } from '../components/UI.jsx'
import { formatCurrency, formatDate } from '../lib/helpers.js'
import { agentSliceForDeal, capWindowStart } from '../lib/commission.js'
import { buildZip, safePathSegment } from '../lib/zipStore.js'

// ─────────────────────────────────────────────────────────────────────────────
// Back Office (admin-only) — quarterly brokerage reporting and cap management.
// Rendered as tabs inside the Commission page for admins. Uses the SAME slice
// engine as My Earnings and the tracker, so every surface agrees to the cent.
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (n) => formatCurrency(Math.round((n + Number.EPSILON) * 100) / 100)

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
        : r.agent.cap_amount > 0 ? `${Math.round(r.capYearPaid)} / ${r.agent.cap_amount}` : 'No cap set'
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
          <div className="stat-card__value" style={{ color: 'var(--gw-azure)' }}>{fmt(report.totals.capPaid + report.totals.fees)}</div>
          <div className="stat-card__label">Brokerage Revenue (splits + fees)</div>
        </div>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color: 'var(--gw-green)' }}>{fmt(report.totals.take)}</div>
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
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmt(r.gci)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--gw-green)' }}>{fmt(r.take)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmt(r.capPaid)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmt(r.fees)}</td>
                  <td style={{ padding: '9px 12px', minWidth: 180 }}>
                    {r.agent.no_brokerage_split ? (
                      <Badge variant="active">Cap pre-paid</Badge>
                    ) : capPct == null ? (
                      <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No cap set</span>
                    ) : (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--gw-mist)', marginBottom: 3 }}>
                          <span>{fmt(r.capYearPaid)} / {fmt(r.agent.cap_amount)}</span><span>{capPct}%</span>
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

// ─────────────────────────────────────────────────────────────────────────────
// Compliance Export — packages every deal's documents into a ZIP organized as
// State/Address/file.pdf so a State auditor can find anything in two clicks.
// Underlying storage keeps the deal-{id} path scheme (stable, no rename risk);
// this layer just rewrites the layout into auditor-friendly folders at export
// time. Runs entirely in the browser; nothing else has to change.
// ─────────────────────────────────────────────────────────────────────────────
export function ComplianceExport({ db }) {
  const deals      = db.deals      || []
  const properties = db.properties || []
  const propById   = useMemo(() => new Map(properties.map(p => [p.id, p])), [properties])

  const [scope, setScope]       = useState('closed')   // closed | all
  const [busy, setBusy]         = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' })

  const dealsInScope = deals.filter(d => scope === 'all' ? true : d.stage === 'closed')

  // Build a display label for a deal — used both for the folder name and the
  // empty-state preview list.
  const dealFolder = (deal) => {
    const prop  = propById.get(deal.property_id)
    const cd    = deal.comp_data || {}
    const state = (prop?.state || cd.state || 'NoState').toString().toUpperCase()
    const addressBits = [prop?.address, prop?.city].filter(Boolean).join(', ')
    const address     = addressBits || deal.title || `deal-${deal.id.slice(0, 8)}`
    return { state: safePathSegment(state), address: safePathSegment(address) }
  }

  const stateBreakdown = useMemo(() => {
    const m = new Map()
    for (const d of dealsInScope) {
      const { state } = dealFolder(d)
      m.set(state, (m.get(state) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [dealsInScope, properties])

  const runExport = async () => {
    if (busy || dealsInScope.length === 0) return
    setBusy(true)
    setProgress({ done: 0, total: dealsInScope.length, label: 'Listing files…' })
    const entries = []
    let i = 0
    try {
      for (const deal of dealsInScope) {
        i++
        const { state, address } = dealFolder(deal)
        setProgress({ done: i, total: dealsInScope.length, label: `${state} / ${address}` })

        const { data: files, error: listErr } = await supabase.storage
          .from('deal-documents')
          .list(`deal-${deal.id}`, { sortBy: { column: 'name', order: 'asc' } })
        if (listErr || !files || files.length === 0) continue

        for (const f of files) {
          if (!f.name) continue
          const { data: signed, error: urlErr } = await supabase.storage
            .from('deal-documents')
            .createSignedUrl(`deal-${deal.id}/${f.name}`, 120)
          if (urlErr || !signed?.signedUrl) continue
          try {
            const res   = await fetch(signed.signedUrl)
            if (!res.ok) continue
            const bytes = new Uint8Array(await res.arrayBuffer())
            entries.push({
              path: `${state}/${address}/${safePathSegment(f.name)}`,
              bytes,
            })
          } catch (_) { /* skip the file, keep the rest */ }
        }
      }

      if (entries.length === 0) {
        pushToast('No documents found in scope', 'info')
        return
      }

      // Manifest CSV — gives auditors a one-page index of what's in the ZIP.
      const manifestLines = [
        'state,address,file,deal_id,deal_stage,closed_at',
        ...entries.map(e => {
          const [st, ad, fn] = e.path.split('/')
          return [st, ad, fn, '', '', ''].map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',')
        }),
      ]
      entries.push({
        path: 'INDEX.csv',
        bytes: new TextEncoder().encode(manifestLines.join('\n')),
      })

      setProgress({ done: dealsInScope.length, total: dealsInScope.length, label: 'Compressing…' })
      const zipBytes = buildZip(entries)
      const blob = new Blob([zipBytes], { type: 'application/zip' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      const ts   = new Date().toISOString().slice(0, 10)
      a.href     = url
      a.download = `gateway-compliance-${scope}-${ts}.zip`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      pushToast(`Exported ${entries.length - 1} documents`, 'success')
    } catch (err) {
      pushToast('Export failed: ' + (err?.message || 'unknown error'), 'error')
    } finally {
      setBusy(false)
      setProgress({ done: 0, total: 0, label: '' })
    }
  }

  return (
    <div>
      <div style={{ background: '#fff', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)', padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>State Audit Export</div>
        <div style={{ fontSize: 12.5, color: 'var(--gw-mist)', marginBottom: 14, lineHeight: 1.5 }}>
          Downloads every deal document as a single ZIP, organized as
          {' '}<code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3 }}>State / Address / file.pdf</code>.
          {' '}An <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3 }}>INDEX.csv</code> is added at the root so auditors can search the whole archive in one place.
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="scope" checked={scope === 'closed'} onChange={() => setScope('closed')} />
            Closed deals only
          </label>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
            Every deal
          </label>
          <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
            {dealsInScope.length} deal{dealsInScope.length === 1 ? '' : 's'} in scope
          </span>
        </div>

        <button className="btn btn--primary" onClick={runExport} disabled={busy || dealsInScope.length === 0}>
          <Icon name="download" size={13} />
          {busy
            ? `Building ZIP… ${progress.done}/${progress.total}${progress.label ? ` · ${progress.label}` : ''}`
            : 'Download Audit ZIP'}
        </button>

        {stateBreakdown.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--gw-border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
              Will produce folders for
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {stateBreakdown.map(([s, n]) => (
                <span key={s} style={{ fontSize: 11, padding: '3px 9px', background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 12 }}>
                  {s} · {n}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
