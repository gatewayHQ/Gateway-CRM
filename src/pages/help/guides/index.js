// The Help & How-To content. Each topic's guides live in their own file; this
// one orders the topics and gathers the guides. See ../guideModel.js for the
// guide shape — validateGuides() runs in the test suite against every guide.

import contacts from './contacts.js'
import properties from './properties.js'
import deals from './deals.js'
import documents from './documents.js'
import marketing from './marketing.js'
import account from './account.js'

export const CATEGORIES = [
  { id: 'getting-started', label: 'Getting started',           icon: 'star' },
  { id: 'contacts',        label: 'Contacts & tasks',          icon: 'contacts' },
  { id: 'properties',      label: 'Properties & listings',     icon: 'building' },
  { id: 'deals',           label: 'Deals & the pipeline',      icon: 'pipeline' },
  { id: 'documents',       label: 'Documents & e-signatures',  icon: 'document' },
  { id: 'marketing',       label: 'Email & marketing',         icon: 'send' },
  { id: 'account',         label: 'Your account & settings',   icon: 'settings' },
  { id: 'office',          label: 'Office admin',              icon: 'commission' },
]

export const GUIDES = [...contacts, ...properties, ...deals, ...documents, ...marketing, ...account]
