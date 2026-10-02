// ─────────────────────────────────────────────────────────────────────────────
// Deal checklists — which list of steps a deal gets, and the lists themselves.
//
// The checklist used to ask for its own State and Type and write that Type into
// comp_data.transaction_type — the same field the deal's "Representing"
// control (Buyer / Seller / Both) reads. Picking "Commercial" on the checklist
// silently cleared who the deal represents. It now READS the deal instead: the
// state from the deal or its property, the kind from the deal's side and
// category, and an agent's override is kept in its own field,
// comp_data.checklist_type, which nothing else reads.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_STEPS_RESIDENTIAL = [
  'Title Search Ordered',
  'Earnest Money Deposited',
  'Home Inspection Scheduled',
  'Inspection Report Reviewed',
  'Appraisal Ordered',
  'Appraisal Report Received',
  'Financing Conditionally Approved',
  'Financing Fully Approved',
  'Final Walkthrough Scheduled',
  'Closing Disclosure Reviewed',
  'Closing Documents Signed',
  'Keys & Possession Transferred',
]

export const DEFAULT_STEPS_COMMERCIAL = [
  'Title Search Ordered',
  'Earnest Money Deposited',
  'Environmental Due Diligence (Phase I)',
  'Property Inspection Ordered',
  'Inspection Report Reviewed',
  'Survey Ordered',
  'Survey Received & Approved',
  'Zoning & Entitlements Verified',
  'Financing Commitment Received',
  'Lease Review (if applicable)',
  'Closing Disclosure Reviewed',
  'Closing Documents Signed',
  'Keys & Possession Transferred',
]

// Per-state, per-transaction-type document checklists (BoldTrail-style)
export const STATE_DOC_TEMPLATES = {
  'SD-seller': [
    { title: 'Submit Listing into MLS',                                                             doc_action: 'manual' },
    { title: 'All SD Agency & Listing Paperwork',                                                   doc_action: 'manual' },
    { title: 'Install Yard Sign',                                                                   doc_action: 'manual' },
    { title: 'Lockbox Authorization/Put on Property',                                               doc_action: 'manual' },
    { title: 'MLS Change Form',                                                                     doc_action: 'manual' },
    { title: 'Addendum to SPD',                                                                     doc_action: 'manual' },
    { title: "Seller's Property Disclosure",                                                        doc_action: 'manual' },
    { title: 'Lead-Based Paint/Radon Pamphlets Given',                                              doc_action: 'manual' },
    { title: 'Completed Purchase Agreement',                                                        doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: "HOA Info/Disclosures sent to Buyer's Agent",                                          doc_action: 'manual' },
    { title: 'Termite Inspection Scheduled',                                                        doc_action: 'manual' },
    { title: 'Appraisal Scheduled',                                                                 doc_action: 'manual' },
    { title: 'Abstract dropped off at closing/abstract company',                                    doc_action: 'manual' },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Retrieve Yard Sign',                                                                  doc_action: 'manual' },
    { title: 'Retrieve and Unassign Lockbox',                                                       doc_action: 'manual' },
    { title: 'Update Listing Site',                                                                 doc_action: 'manual' },
    { title: 'Inspection Addendums Submitted if any',                                               doc_action: 'upload', if_applicable: true },
    { title: 'Order Home Warranty if applicable',                                                   doc_action: 'forms',  if_applicable: true },
    { title: 'Addendums to Contract if applicable',                                                 doc_action: 'forms',  if_applicable: true },
    { title: 'MLS Listing Change Form if applicable',                                               doc_action: 'forms',  if_applicable: true },
  ],
  'SD-commercial': [
    { title: 'All SD Agency/Listing Paperwork',                                                     doc_action: 'manual' },
    { title: "Seller's Property & Lead Based Paint Disclosure",                                     doc_action: 'forms'  },
    { title: 'Lead-Based Paint/Radon Pamphlets Given',                                              doc_action: 'manual' },
    { title: 'Put onto listing site if applicable',                                                 doc_action: 'manual', if_applicable: true },
    { title: 'Install Sign if applicable',                                                          doc_action: 'manual', if_applicable: true },
    { title: 'Lockbox Authorization/Put on Property',                                               doc_action: 'manual' },
    { title: 'Completed Purchase Agreement',                                                        doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Inspection Addendums Submitted if any',                                               doc_action: 'upload', if_applicable: true },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Retrieve and Unassign Lockbox',                                                       doc_action: 'manual' },
    { title: 'Remove Sign if applicable',                                                           doc_action: 'manual', if_applicable: true },
    { title: 'Update listing site if applicable',                                                   doc_action: 'manual', if_applicable: true },
    { title: 'Leases/expenses/rent/deposit prorations submitted to closing company if applicable',  doc_action: 'manual', if_applicable: true },
    { title: 'Any Addendums to Contract if applicable',                                             doc_action: 'manual', if_applicable: true },
  ],
  'SD-buyer': [
    { title: 'Buyer Representation Agreement',             doc_action: 'manual' },
    { title: 'Agency Disclosure',                          doc_action: 'manual' },
    { title: 'Purchase Agreement',                         doc_action: 'forms'  },
    { title: 'Lead-Based Paint Disclosure',                doc_action: 'manual', if_applicable: true },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Pre-Approval Letter',                        doc_action: 'upload' },
    { title: 'Home Inspection Report',                     doc_action: 'upload' },
    { title: 'Inspection Addendum / Response',             doc_action: 'forms',  if_applicable: true },
    { title: 'Financing Commitment Letter',                doc_action: 'upload' },
    { title: 'Appraisal Report',                           doc_action: 'upload', if_applicable: true },
    { title: 'Final Walkthrough Completed',                doc_action: 'manual' },
    { title: 'Closing Disclosure Reviewed',                doc_action: 'manual' },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
  ],
  'IA-seller': [
    { title: 'All Iowa Agency & Listing Paperwork',                                                 doc_action: 'manual' },
    { title: 'Seller & Lead Based Paint Disclosure',                                                doc_action: 'forms'  },
    { title: 'Iowa Radon & Lead-Based Paint Pamphlets Given',                                       doc_action: 'manual' },
    { title: 'Submit Listing into MLS',                                                             doc_action: 'manual' },
    { title: 'Install yard sign if applicable',                                                     doc_action: 'manual', if_applicable: true },
    { title: 'Lockbox Authorization/Put on Property',                                               doc_action: 'manual' },
    { title: 'Termite Inspection Scheduled',                                                        doc_action: 'manual' },
    { title: 'Appraisal Scheduled',                                                                 doc_action: 'manual' },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: 'Abstract Dropped off at Closing Company/Abstract Company',                            doc_action: 'manual' },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Update MLS',                                                                          doc_action: 'manual' },
    { title: 'Retrieve yard sign if applicable',                                                    doc_action: 'manual', if_applicable: true },
    { title: 'Retrieve lockbox & unassign property',                                                doc_action: 'manual' },
    { title: 'MLS Listing Change Form if applicable',                                               doc_action: 'forms',  if_applicable: true },
    { title: 'Any Addendums to Contract if applicable',                                             doc_action: 'upload', if_applicable: true },
    { title: 'Order Home Warranty if applicable',                                                   doc_action: 'forms',  if_applicable: true },
    { title: 'Inspection Addendums Submitted if any',                                               doc_action: 'upload', if_applicable: true },
  ],
  'IA-commercial': [
    { title: 'All IA Agency/Listing Paperwork',                                                     doc_action: 'manual' },
    { title: 'Put onto Listing site if applicable',                                                 doc_action: 'manual', if_applicable: true },
    { title: 'Install sign if applicable',                                                          doc_action: 'manual', if_applicable: true },
    { title: 'Lockbox Authorization/Put on property',                                               doc_action: 'manual' },
    { title: 'Purchase Agreement',                                                                  doc_action: 'forms'  },
    { title: 'Inspection Scheduled',                                                                doc_action: 'manual' },
    { title: 'Leases/expenses/rent/deposit prorations submitted to closing company if applicable',  doc_action: 'manual', if_applicable: true },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Update Listing site if applicable',                                                   doc_action: 'manual', if_applicable: true },
    { title: 'Retrieve lockbox/unassign from property',                                             doc_action: 'manual' },
    { title: 'Retrieve Sign if applicable',                                                         doc_action: 'manual', if_applicable: true },
    { title: 'Any Addendums to Contract if applicable',                                             doc_action: 'upload', if_applicable: true },
    { title: 'MLS Listing Change Form if applicable',                                               doc_action: 'forms',  if_applicable: true },
  ],
  'IA-buyer': [
    { title: 'Buyer Agency Agreement',                     doc_action: 'manual' },
    { title: 'Agency Disclosure',                          doc_action: 'manual' },
    { title: 'Purchase Agreement',                         doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Pre-Approval Letter',                        doc_action: 'upload' },
    { title: 'Home Inspection Report',                     doc_action: 'upload' },
    { title: 'Inspection Addendum / Response',             doc_action: 'forms',  if_applicable: true },
    { title: 'Financing Commitment Letter',                doc_action: 'upload' },
    { title: 'Appraisal Report',                           doc_action: 'upload', if_applicable: true },
    { title: 'Final Walkthrough Completed',                doc_action: 'manual' },
    { title: 'Closing Disclosure Reviewed',                doc_action: 'manual' },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
  ],
  'NE-seller': [
    { title: 'All NE Agency & Listing Paperwork',          doc_action: 'manual' },
    { title: 'NE Seller Property Condition Disclosure',    doc_action: 'manual' },
    { title: 'MLS Change Form',                            doc_action: 'manual' },
    { title: 'Lead-Based Paint Disclosure',                doc_action: 'manual', if_applicable: true },
    { title: 'Completed Purchase Agreement',               doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Title Insurance Ordered',                    doc_action: 'manual' },
    { title: 'Escrow / Settlement Sheet',                  doc_action: 'forms'  },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Inspection Addendums Submitted if any',      doc_action: 'upload', if_applicable: true },
    { title: 'Home Warranty Order if applicable',          doc_action: 'forms',  if_applicable: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
    { title: 'MLS Listing Change Form if applicable',      doc_action: 'forms',  if_applicable: true },
  ],
  'NE-buyer': [
    { title: 'Buyer Representation Agreement',             doc_action: 'manual' },
    { title: 'Agency Disclosure',                          doc_action: 'manual' },
    { title: 'Purchase Agreement',                         doc_action: 'forms'  },
    { title: 'Lead-Based Paint Disclosure',                doc_action: 'manual', if_applicable: true },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Pre-Approval Letter',                        doc_action: 'upload' },
    { title: 'Home Inspection Report',                     doc_action: 'upload' },
    { title: 'Inspection Addendum / Response',             doc_action: 'forms',  if_applicable: true },
    { title: 'Financing Commitment Letter',                doc_action: 'upload' },
    { title: 'Title Commitment Received',                  doc_action: 'manual' },
    { title: 'Appraisal Report',                           doc_action: 'upload', if_applicable: true },
    { title: 'Final Walkthrough Completed',                doc_action: 'manual' },
    { title: 'Closing Disclosure Reviewed',                doc_action: 'manual' },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
  ],
}

// What the checklist's Type control offers. 'both' is a deal representing
// both sides: it gets the seller list and the buyer list together.
export const CHECKLIST_KINDS = [
  ['seller',     'Seller (Listing)'],
  ['buyer',      'Buyer (Purchase)'],
  ['both',       'Both sides'],
  ['commercial', 'Commercial'],
  ['lease',      'Lease / Rental'],
]
const KIND_IDS = CHECKLIST_KINDS.map(([id]) => id)

/** Which checklist a deal gets: the agent's pick, else read from the deal. */
export function checklistKindFor(deal) {
  const cd = deal?.comp_data || {}
  if (KIND_IDS.includes(cd.checklist_type)) return cd.checklist_type
  const side = String(cd.transaction_type || '').trim().toLowerCase()
  if (side === 'lease') return 'lease'
  if (deal?.prop_category === 'commercial') return 'commercial'
  if (side === 'seller' || side === 'both') return side
  return 'buyer'
}

/** The state a deal's checklist is for — the deal's own, else its property's. */
export function checklistStateFor(deal, property) {
  const raw = deal?.comp_data?.state || property?.state || ''
  return String(raw).trim().toUpperCase()
}

const asSteps = (titles) => titles.map(title => ({ title, doc_action: 'manual' }))

/** The steps for a state + kind. Always returns a list — never empty. */
export function checklistTemplate(state, kind, propCategory) {
  const st = String(state || '').toUpperCase()
  if (kind === 'both') {
    const seen = new Set()
    return [...checklistTemplate(st, 'seller', propCategory), ...checklistTemplate(st, 'buyer', propCategory)]
      .filter(step => !seen.has(step.title) && seen.add(step.title))
  }
  if (STATE_DOC_TEMPLATES[`${st}-${kind}`]) return STATE_DOC_TEMPLATES[`${st}-${kind}`]
  return asSteps(kind === 'commercial' || propCategory === 'commercial' ? DEFAULT_STEPS_COMMERCIAL : DEFAULT_STEPS_RESIDENTIAL)
}

/** Rows ready to insert into transaction_steps for a deal. */
export function checklistRows(dealId, steps) {
  return steps.map((doc, i) => ({
    deal_id: dealId, title: doc.title, completed: false, sort_order: i,
    doc_action: doc.doc_action || 'manual', doc_status: 'pending',
    if_applicable: doc.if_applicable || false,
  }))
}
