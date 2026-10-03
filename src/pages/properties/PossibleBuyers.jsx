import React, { useMemo } from 'react'
import { Avatar } from '../../components/UI.jsx'
import { findMatchingBuyers } from '../../lib/matching.js'

export function PossibleBuyers({ form, contacts }) {
  const buyers = useMemo(() => findMatchingBuyers(form, contacts), [form, contacts])
  const hasSubmarket = Boolean(form.submarket)

  if (!hasSubmarket) return null

  return (
    <div style={{ borderTop: '1px solid var(--gw-border)', marginTop: 4, paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gw-mist)' }}>
          Possible Buyers
        </div>
        {buyers.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gw-azure)', background: 'var(--gw-sky)', padding: '2px 8px', borderRadius: 99 }}>
            {buyers.length} match{buyers.length !== 1 ? 'es' : ''}
          </span>
        )}
      </div>
      {buyers.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '8px 0' }}>
          No buyers have this submarket + asset type in their criteria yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {buyers.map(c => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px',
              background: 'var(--gw-sky)',
              border: '1px solid var(--gw-azure)',
              borderRadius: 'var(--radius)',
            }}>
              <Avatar agent={{ name: `${c.first_name} ${c.last_name}` }} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gw-ink)' }}>
                  {c.first_name} {c.last_name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gw-azure)', marginTop: 1 }}>
                  {(c.submarkets || []).join(', ')}
                  {c.asset_types?.length > 0 ? ` · ${c.asset_types.join(', ')}` : ''}
                </div>
              </div>
              {(c.size_min || c.size_max) && (
                <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap' }}>
                  {c.size_min ? Number(c.size_min).toLocaleString() : '0'}
                  {'–'}
                  {c.size_max ? Number(c.size_max).toLocaleString() : '∞'} {c.size_unit || 'sqft'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
