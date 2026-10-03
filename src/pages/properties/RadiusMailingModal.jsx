// Mail every owner within a radius of a property.

import React, { useState, useMemo } from 'react'
import { Icon, pushToast } from '../../components/UI.jsx'
import { updatePropertyCoords } from '../../lib/services/properties.js'
import { streetLine, geocodeQuery } from '../../lib/address.js'
import { geocodeAddress, haversineMiles } from './geo.js'

// ─── Radius Mailing helpers ───────────────────────────────────────────────────

const CAMPAIGN_TYPES = ['Just Sold','Just Listed','Exclusively Offered','Price Reduced','Open House','Investment Opportunity','Custom']

// ─── Radius Mailing Modal ─────────────────────────────────────────────────────

export function RadiusMailingModal({ property, contacts, allProperties, onClose }) {
  const [campaignType, setCampaignType]         = useState('Just Sold')
  const [customName, setCustomName]             = useState('')
  const [radius, setRadius]                     = useState(1)
  const [searching, setSearching]               = useState(false)
  const [geoProgress, setGeoProgress]           = useState(null) // { done, total }
  const [results, setResults]                   = useState(null) // null = not run yet
  const [selected, setSelected]                 = useState(new Set())

  const contactMap = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])), [contacts])

  const search = async () => {
    setSearching(true); setResults(null)

    // 1. Geocode source property (use stored coords if available)
    let src = property.lat && property.lng ? { lat: property.lat, lng: property.lng } : null
    if (!src) {
      const addr = geocodeQuery(property)
      src = await geocodeAddress(addr)
      if (src) await updatePropertyCoords(property.id, src.lat, src.lng)
    }
    if (!src) {
      pushToast('Could not geocode this property — ensure address, city, state are filled in', 'error')
      setSearching(false); return
    }

    // 2. Geocode any nearby properties that don't have coords yet
    const others = allProperties.filter(p => p.id !== property.id)
    const needsGeo = others.filter(p => !p.lat || !p.lng)
    if (needsGeo.length) {
      setGeoProgress({ done: 0, total: needsGeo.length })
      for (let i = 0; i < needsGeo.length; i++) {
        const p = needsGeo[i]
        const addr = geocodeQuery(p)
        const coords = await geocodeAddress(addr)
        if (coords) {
          await updatePropertyCoords(p.id, coords.lat, coords.lng)
          p.lat = coords.lat; p.lng = coords.lng
        }
        setGeoProgress({ done: i + 1, total: needsGeo.length })
        if (i < needsGeo.length - 1) await new Promise(r => setTimeout(r, 1100)) // Nominatim rate limit
      }
      setGeoProgress(null)
    }

    // 3. Find properties within radius and collect their linked contacts
    const found = []
    const seen = new Set()
    for (const p of others) {
      if (!p.lat || !p.lng) continue
      const dist = haversineMiles(src.lat, src.lng, p.lat, p.lng)
      if (dist > radius) continue
      if (p.linked_contact_id && !seen.has(p.linked_contact_id)) {
        // Every owner nearby, with or without an email — a mailing goes to
        // the property's address.
        const contact = contactMap[p.linked_contact_id]
        if (contact) {
          seen.add(p.linked_contact_id)
          found.push({ contact, property: p, distance: dist })
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance)

    setResults(found)
    setSelected(new Set(found.map(r => r.contact.id)))
    setSearching(false)
  }

  const toggleContact = id => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // The mailing list as a spreadsheet for the print shop or mail house: one
  // row per owner, addressed to the nearby property they own.
  const downloadList = () => {
    const rows = results.filter(r => selected.has(r.contact.id))
    if (!rows.length) { pushToast('Select at least one contact', 'error'); return }
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [
      ['First Name', 'Last Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip', 'Miles Away'].map(cell).join(','),
      ...rows.map(({ contact: c, property: p, distance }) => [
        c.first_name, c.last_name, c.email, c.phone, streetLine(p), p.city, p.state, p.zip, distance.toFixed(2),
      ].map(cell).join(',')),
    ]
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${tag.replace(/[^\w\s-]+/g, '').replace(/\s+/g, '-').toLowerCase()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    pushToast(`${rows.length} contact${rows.length !== 1 ? 's' : ''} downloaded`)
  }

  const campaignLabel = campaignType === 'Custom' ? (customName || 'Custom') : campaignType
  const tag = `${campaignLabel} — ${streetLine(property)}`

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.48)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 'var(--radius-lg,10px)', width: '100%', maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--gw-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}>Radius Mailing</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 3 }}>
                {streetLine(property)}{property.city ? `, ${property.city}` : ''}
              </div>
            </div>
            <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Campaign Type</label>
              <select className="form-control" value={campaignType} onChange={e => { setCampaignType(e.target.value); setResults(null) }}>
                {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Search Radius</label>
              <select className="form-control" value={radius} onChange={e => { setRadius(Number(e.target.value)); setResults(null) }}>
                {[0.25, 0.5, 1, 2, 5].map(r => <option key={r} value={r}>{r} mi</option>)}
              </select>
            </div>
          </div>

          {campaignType === 'Custom' && (
            <div className="form-group">
              <label className="form-label">Custom Campaign Name</label>
              <input className="form-control" value={customName} onChange={e => setCustomName(e.target.value)} placeholder="e.g. New Office Listing Available" />
            </div>
          )}

          {/* Geocoding progress */}
          {geoProgress && (
            <div style={{ marginBottom: 16, padding: 14, background: 'var(--gw-sky)', borderRadius: 'var(--radius)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                <span>Geocoding properties for first-time search…</span>
                <span>{geoProgress.done} / {geoProgress.total}</span>
              </div>
              <div style={{ height: 5, background: 'rgba(0,0,0,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'var(--gw-azure)', borderRadius: 3, width: `${Math.round(geoProgress.done / geoProgress.total * 100)}%`, transition: 'width 400ms' }} />
              </div>
            </div>
          )}

          <button className="btn btn--primary" onClick={search} disabled={searching} style={{ marginBottom: 20 }}>
            {searching ? (geoProgress ? 'Geocoding…' : 'Searching…') : 'Find Contacts Within Radius'}
          </button>

          {/* Results */}
          {results !== null && (
            results.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
                No contacts own a property within {radius} mi of this one.<br />
                <span style={{ fontSize: 11, marginTop: 6, display: 'block' }}>
                  Tip: Link contacts to nearby properties in the Properties page to appear here.
                </span>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {results.length} contact{results.length !== 1 ? 's' : ''} found &nbsp;·&nbsp; {selected.size} selected
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setSelected(new Set(results.map(r => r.contact.id)))}>All</button>
                    <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setSelected(new Set())}>None</button>
                  </div>
                </div>
                <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 12 }}>
                  {results.map(({ contact, property: p, distance }) => (
                    <label key={contact.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--gw-border)', cursor: 'pointer', background: selected.has(contact.id) ? 'var(--gw-sky)' : '#fff', transition: 'background 100ms' }}
                      onClick={() => toggleContact(contact.id)}>
                      <input type="checkbox" checked={selected.has(contact.id)} readOnly style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{contact.first_name} {contact.last_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--gw-mist)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[contact.email, streetLine(p)].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)', flexShrink: 0 }}>{distance.toFixed(2)} mi</div>
                    </label>
                  ))}
                </div>
              </>
            )
          )}
        </div>

        {/* Footer */}
        {results !== null && results.length > 0 && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--gw-border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--gw-mist)', minWidth: 0 }}>
              A spreadsheet with each owner's name, contact details and property address.
            </div>
            <button className="btn btn--secondary" onClick={onClose}>Close</button>
            <button className="btn btn--primary" onClick={downloadList} disabled={!selected.size}>
              <Icon name="download" size={13} /> Download {selected.size} as CSV
            </button>
          </div>
        )}
        {results !== null && results.length === 0 && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn--secondary" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}
