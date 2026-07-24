import React from 'react'
import RecordList from './RecordList.jsx'
import { formatCurrency, formatDate, STAGE_LABELS } from '../../lib/helpers.js'

// Deal-specific configuration of the generic RecordList. Presentational.
const dealFields = {
  title:   d => d.title || 'Untitled deal',
  ownerId: d => d.agent_id,
  badges:  d => [
    d.stage && { variant: d.stage, label: STAGE_LABELS[d.stage] || d.stage },
    d.prop_category && { variant: d.prop_category, label: d.prop_category },
  ],
  stats:   d => [
    { icon: 'dollar', text: formatCurrency(d.value) },
    d.expected_close_date && { icon: 'calendar', text: formatDate(d.expected_close_date) },
  ],
}

/**
 * @param {object} props  See RecordList — minus `fields` (supplied here).
 * @param {object[]} props.deals
 */
export default function DealList({ deals, ...rest }) {
  return (
    <RecordList
      records={deals}
      fields={dealFields}
      emptyIcon="pipeline"
      emptyTitle="No deals you can see"
      emptyMessage="A deal appears here when you're its primary agent, tagged as a co-agent, or partnered (by an admin) with its owner."
      {...rest}
    />
  )
}
