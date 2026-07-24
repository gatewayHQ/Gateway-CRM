import React from 'react'
import RecordList from './RecordList.jsx'

// Contact-specific configuration of the generic RecordList. Presentational.
const contactFields = {
  title:   c => [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed contact',
  ownerId: c => c.assigned_agent_id,
  badges:  c => [
    c.type   && { variant: c.type,   label: c.type },
    c.status && { variant: c.status, label: c.status },
  ],
  stats:   c => [
    c.email && { icon: 'mail',  text: c.email },
    c.phone && { icon: 'phone', text: c.phone },
  ],
}

/**
 * @param {object} props  See RecordList — minus `fields` (supplied here).
 * @param {object[]} props.contacts
 */
export default function ContactList({ contacts, ...rest }) {
  return (
    <RecordList
      records={contacts}
      fields={contactFields}
      emptyIcon="contacts"
      emptyTitle="No contacts you can see"
      emptyMessage="A contact appears here when it's assigned to you, or you're partnered (by an admin) with its owner."
      {...rest}
    />
  )
}
