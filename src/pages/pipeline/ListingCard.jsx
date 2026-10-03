// One listing on the listings board.

import React from 'react'
import { formatCurrency } from '../../lib/helpers.js'
import { isResidentialPropertyType } from '../../lib/enums.js'
import { streetLine } from '../../lib/address.js'
import { Icon, Badge, Avatar } from '../../components/UI.jsx'
import { LISTING_STATUS_COLORS, LISTING_STATUS_LABELS } from './listingStatus.js'

function daysOnMarket(dateStr) {
  if (!dateStr) return null
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr)) / 86_400_000))
}

export function ListingCard({ property, agent, deals = [], onClick, onDelete, draggable, onDragStart, onDragEnd, dragging }) {
  const dom         = daysOnMarket(property.created_at)
  const isRes       = isResidentialPropertyType(property.type)
  const statusColor = LISTING_STATUS_COLORS[property.status] || '#9ca3af'
  const domAlert    = dom !== null && dom > 30 && property.status === 'active'

  // Expiry alert
  let daysToExpiry = null
  let expiryAlert  = false
  if (property.listing_expiry_date && property.status === 'active') {
    daysToExpiry = Math.ceil((new Date(property.listing_expiry_date) - Date.now()) / 86_400_000)
    expiryAlert  = daysToExpiry >= 0 && daysToExpiry <= 14
  }

  // Offer / under-contract badge from linked deals
  const linkedDeals    = deals.filter(d => d.property_id === property.id)
  const underContract  = linkedDeals.some(d => d.stage === 'under-contract')
  const offerCount     = linkedDeals.filter(d => ['offer','under-contract'].includes(d.stage)).length

  // Most recent price reduction
  const priceHistory  = Array.isArray(property.price_history) ? property.price_history : []
  const lastReduction = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : null

  return (
    <div className={`deal-card${dragging ? ' dragging' : ''}`} style={{ cursor: onClick ? 'pointer' : 'default' }}
         onClick={onClick} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {expiryAlert && (
        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:5, fontSize:10, fontWeight:700, color: daysToExpiry === 0 ? '#dc2626' : '#d97706' }}>
          <span>⚠</span>
          <span>Listing expires {daysToExpiry === 0 ? 'today' : `in ${daysToExpiry}d`}</span>
        </div>
      )}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:6, marginBottom:4 }}>
        <div style={{ fontSize:12, fontWeight:600, color:'var(--gw-ink)', lineHeight:1.35 }}>{streetLine(property)}</div>
        <span style={{ fontSize:10, fontWeight:700, color: statusColor, whiteSpace:'nowrap', flexShrink:0 }}>
          {LISTING_STATUS_LABELS[property.status] || property.status}
        </span>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4, flexWrap:'wrap' }}>
        <Badge variant="neutral" style={{ fontSize:10 }}>{property.type}</Badge>
        {property.list_price > 0 && (
          <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-slate)' }}>{formatCurrency(property.list_price)}</span>
        )}
        {offerCount > 0 && (
          <span style={{ fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:10, background: underContract ? '#dcfce7' : '#fef3c7', color: underContract ? '#16a34a' : '#d97706', whiteSpace:'nowrap' }}>
            {underContract ? 'Under contract' : `${offerCount} offer${offerCount !== 1 ? 's' : ''}`}
          </span>
        )}
      </div>
      {isRes && (property.beds || property.baths) && (
        <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:3 }}>
          {property.beds ? `${property.beds} bd` : ''}{property.beds && property.baths ? ' · ' : ''}{property.baths ? `${property.baths} ba` : ''}
          {property.sqft ? ` · ${Number(property.sqft).toLocaleString()} sqft` : ''}
        </div>
      )}
      {lastReduction && (
        <div style={{ fontSize:10, color:'#dc2626', marginBottom:3, fontWeight:600 }}>
          ↓ {formatCurrency(Math.abs(Number(lastReduction.previous_price) - Number(lastReduction.price)))}
          {' · '}{Math.floor((Date.now() - new Date(lastReduction.date)) / 86_400_000)}d ago
        </div>
      )}
      <div className="deal-card__meta" style={{ marginTop:4 }}>
        <div style={{ fontSize:10, color: domAlert ? '#dc2626' : 'var(--gw-mist)', fontWeight: domAlert ? 700 : 400 }}>
          {property.mls_number ? `MLS# ${property.mls_number}` : ''}
          {property.mls_number && dom !== null ? ' · ' : ''}
          {dom !== null ? `${dom}d on market` : ''}
          {domAlert ? ' ⚠' : ''}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
          {agent && <Avatar agent={agent} size={20} />}
          {onDelete && (
            <button className="btn btn--ghost btn--icon" style={{ padding:2 }} title="Remove listing"
              onClick={e => { e.stopPropagation(); onDelete() }}>
              <Icon name="trash" size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
