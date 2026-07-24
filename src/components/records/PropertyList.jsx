import React from 'react'
import RecordList from './RecordList.jsx'
import { formatCurrency } from '../../lib/helpers.js'

// Property-specific configuration of the generic RecordList. Presentational.
const propertyFields = {
  title:    p => p.address || 'Untitled property',
  subtitle: p => [p.city, p.state].filter(Boolean).join(', ') || null,
  ownerId:  p => p.assigned_agent_id,
  badges:   p => [
    p.type   && { variant: p.type,   label: p.type },
    p.status && { variant: p.status, label: p.status },
  ],
  stats:    p => [
    p.list_price != null && { icon: 'dollar', text: formatCurrency(p.list_price) },
    p.mls_number && { icon: 'tag', text: `MLS ${p.mls_number}` },
  ],
}

/**
 * @param {object} props  See RecordList — minus `fields` (supplied here).
 * @param {object[]} props.properties
 */
export default function PropertyList({ properties, ...rest }) {
  return (
    <RecordList
      records={properties}
      fields={propertyFields}
      emptyIcon="building"
      emptyTitle="No properties you can see"
      emptyMessage="A property appears here when it's assigned to you, or you're partnered (by an admin) with its owner."
      {...rest}
    />
  )
}
