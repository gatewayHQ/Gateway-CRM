// ─────────────────────────────────────────────────────────────────────────────
// Shared constants — single source of truth for buckets, table names, and the
// other magic strings that used to drift between files. Importing from here
// means a typo becomes a build error instead of a silent prod incident.
//
// (STAGE_LABELS lives in helpers.js — kept there because it's already the
// canonical export and many files import it via that path.)
// ─────────────────────────────────────────────────────────────────────────────

export const BUCKETS = Object.freeze({
  DEAL_DOCS:        'deal-documents',
  CLOSING_PACKETS:  'closing-packets',
})

// Table names. Use these instead of string literals so renames are tractable.
export const TABLES = Object.freeze({
  AGENTS:              'agents',
  AGENT_NOTIFICATIONS: 'agent_notifications',
  AGENT_NUDGES:        'agent_nudges',
  AUDIT_LOG:           'audit_log',
  CLOSING_PACKETS:     'closing_packets',
  COMMISSIONS:         'commissions',
  CONTACTS:            'contacts',
  DEADLINE_REMINDERS:  'deadline_reminders',
  DEALS:               'deals',
  DOCUMENTS:           'documents',
  DOCUMENT_VERSIONS:   'document_versions',
  PROPERTIES:          'properties',
  BOLDSIGN_DOCUMENTS:  'boldsign_documents',
  BOLDSIGN_SENDER_IDENTITIES: 'boldsign_sender_identities',
  BOLDSIGN_TEMPLATES:  'boldsign_templates',
  TASKS:               'tasks',
  TEAMS:               'teams',
  TEAM_SPLITS:         'team_splits',
  TRANSACTION_STEPS:   'transaction_steps',
})

// Review status values for deals.review_status. Mirrors the CHECK constraint
// in migrations/0015_transaction_layer.sql.
export const REVIEW_STATUS = Object.freeze({
  NONE:               'none',
  PENDING:            'pending',
  APPROVED:           'approved',
  CHANGES_REQUESTED:  'changes_requested',
})

// Document-version "source" values. Mirrors the CHECK constraint.
export const DOC_SOURCE = Object.freeze({
  UPLOAD:         'upload',
  BOLDSIGN:       'boldsign',
  CLOSING_PACKET: 'closing_packet',
  IMPORT:         'import',
})

// Audit action codes — keep aligned with audit.js writers and the UI icon map
// in DealPage's Activity Log.
export const AUDIT_ACTIONS = Object.freeze({
  INSERT:           'insert',
  UPDATE:           'update',
  DELETE:           'delete',
  STAGE:            'stage',
  PIN:              'pin',
  DOC_SIGNED:       'doc_signed',
  PACKET_GENERATED: 'packet_generated',
  REVIEW_SUBMIT:    'review_submit',
  REVIEW_APPROVE:   'review_approve',
  REVIEW_CHANGES:   'review_changes',
})
