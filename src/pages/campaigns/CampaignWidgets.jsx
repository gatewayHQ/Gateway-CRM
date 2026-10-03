// Small presentational pieces shared by the campaigns list and detail.

import React from 'react'
import { STATUS_CONFIG } from './campaignConfig.js'

export function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color }}>{c.label}</span>
}

export function LandingTypeChip({ type }) {
  const cfg = {
    property:    { label: 'Property',    bg: '#dbeafe',   color: '#1d4ed8' },
    multifamily: { label: 'Multifamily', bg: '#fef3c7',   color: '#92400e' },
    valuation:   { label: 'Valuation',   bg: '#dcfce7',   color: '#166534' },
    mailing:     { label: 'Mailing List',bg: '#fce7f3',   color: '#9d174d' },
    custom:      { label: 'Custom URL',  bg: '#f3e8ff',   color: '#6b21a8' },
  }
  const c = cfg[type] || cfg.property
  return (
    <span style={{ padding:'1px 7px', borderRadius:9, fontSize:10, fontWeight:700,
                   background:c.bg, color:c.color, letterSpacing:0.3 }}>
      {c.label}
    </span>
  )
}

export function FunnelBar({ scanRate, leadRate }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      <FunnelRow label="Scanned" rate={scanRate} color="var(--gw-azure)" />
      <FunnelRow label="Lead"    rate={leadRate} color="var(--gw-green)" />
    </div>
  )
}

function FunnelRow({ label, rate, color }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ width:48, fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase', fontWeight:600 }}>{label}</div>
      <div style={{ flex:1, height:5, background:'var(--gw-bone)', borderRadius:3, overflow:'hidden' }}>
        <div style={{ width:`${rate}%`, height:'100%', background:color, transition:'width 300ms' }} />
      </div>
      <div style={{ width:32, textAlign:'right', fontSize:10, color:'var(--gw-mist)', fontWeight:700 }}>
        {rate > 0 ? `${rate.toFixed(rate < 10 ? 1 : 0)}%` : '—'}
      </div>
    </div>
  )
}

// Horizontal share bars for a {key: count} map — device, OS, browser splits.
function ShareBars({ title, data, color = 'var(--gw-azure)', limit = 5, empty = null }) {
  const rows = Object.entries(data || {})
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
  if (!rows.length) return empty
  const total = rows.reduce((n, [, v]) => n + v, 0) || 1
  return (
    <div>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase',
                    letterSpacing:0.6, marginBottom:6 }}>{title}</div>
      <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:78, fontSize:11.5, color:'var(--gw-ink)', textTransform:'capitalize',
                          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{k}</div>
            <div style={{ flex:1, background:'var(--gw-bone)', borderRadius:4, height:7, overflow:'hidden' }}>
              <div style={{ width:`${(v / total) * 100}%`, height:'100%', background:color, borderRadius:4 }} />
            </div>
            <div style={{ width:28, textAlign:'right', fontSize:11, fontWeight:700, color:'var(--gw-mist)' }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Device / OS / location splits. Rendered only when the analytics RPC supplied
// them, so a database still on the pre-0031 schema simply shows nothing here
// rather than a row of empty boxes.
export function Breakdowns({ analytics }) {
  if (!analytics) return null
  const hasDevice = analytics.by_device && Object.keys(analytics.by_device).length > 0
  const regions   = Array.isArray(analytics.by_region) ? analytics.by_region.filter(r => r.count > 0) : []
  if (!hasDevice && !regions.length) return null

  return (
    <div style={{ marginTop:18, display:'grid', gridTemplateColumns:'1fr 1fr', gap:18 }}>
      {hasDevice && <ShareBars title="Device" data={analytics.by_device} />}
      {analytics.by_os && Object.keys(analytics.by_os).length > 0 &&
        <ShareBars title="Platform" data={analytics.by_os} color="#7c3aed" />}
      {regions.length > 0 && (
        <div style={{ gridColumn:'1 / -1' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase',
                        letterSpacing:0.6, marginBottom:6 }}>Where scans came from</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {regions.slice(0, 12).map((r, i) => (
              <span key={`${r.region}-${r.city}-${i}`}
                    style={{ fontSize:11.5, padding:'3px 9px', borderRadius:20, background:'var(--gw-bone)',
                             border:'1px solid var(--gw-border)', color:'var(--gw-ink)' }}>
                {[r.city, r.region].filter(v => v && v !== '—').join(', ') || 'Unknown'}
                <strong style={{ marginLeft:6, color:'var(--gw-azure)' }}>{r.count}</strong>
              </span>
            ))}
          </div>
          <div style={{ fontSize:10.5, color:'var(--gw-mist)', marginTop:6 }}>
            Approximate — derived from network location, not the mailing address.
          </div>
        </div>
      )}
    </div>
  )
}

export function StatCard({ value, label, sub, color }) {
  return (
    <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 18px', minWidth:120 }}>
      <div style={{ fontSize:28, fontWeight:800, color: color || 'var(--gw-ink)', fontFamily:'var(--font-display)', lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginTop:3 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>{sub}</div>}
    </div>
  )
}
