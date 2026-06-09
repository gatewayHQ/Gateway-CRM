/**
 * Gateway CRM — DocuSign fillable-form mapping
 *
 * Turns the *named form fields* an admin draws in a Form Library PDF into the
 * DocuSign tab spec our `/api/docusign` send action expects, and auto-fills the
 * data fields from the deal. This is the glue for the "PDF fillable fields +
 * per-recipient assignment + CRM auto-fill" model.
 *
 * ── Field-naming convention (admin sets these in Acrobat) ─────────────────────
 *   gw_<role>_<type>__<key>
 *
 *   role : client | client2 | agent   (who fills/signs the field)
 *   type : sig | initial | date | text | check
 *   key  : free-form identifier; for text fields it also drives CRM auto-fill
 *
 *   Examples:
 *     gw_client_text__buyer_name        → client text box, auto-filled w/ buyer name
 *     gw_client_sig__1                  → client signature
 *     gw_client_initial__1              → client initials
 *     gw_client_date__1                 → client date-signed
 *     gw_agent_text__list_price         → agent text box, auto-filled w/ list price
 *     gw_agent_sig__1                   → agent signature
 *     gw_client2_sig__1                 → second client (co-buyer/co-seller) signature
 *
 * The name is sent to DocuSign as the tab's `tabLabel`; with `transformPdfFields`
 * enabled on the document, DocuSign places each tab onto the PDF form field of
 * the same name and assigns it to that tab's recipient.
 *
 * Pure module — no React, no I/O — so it is unit-testable on its own.
 */

const ROLE_ALIASES = { client: 'client', signer1: 'client', buyer: 'client',
                       client2: 'client2', signer2: 'client2', cobuyer: 'client2', coseller: 'client2',
                       agent: 'agent' }
const TYPE_ALIASES = { sig: 'signature', signature: 'signature',
                       initial: 'initials', initials: 'initials',
                       date: 'date', text: 'text',
                       check: 'checkbox', checkbox: 'checkbox' }

/** Parse a field name into { role, type, key } or null if it isn't ours. */
export function parseFieldName(name = '') {
  const m = /^gw_([a-z0-9]+)_([a-z]+)__(.+)$/i.exec(String(name).trim())
  if (!m) return null
  const role = ROLE_ALIASES[m[1].toLowerCase()]
  const type = TYPE_ALIASES[m[2].toLowerCase()]
  if (!role || !type) return null
  return { role, type, key: m[3].toLowerCase() }
}

const money = (n) => (n != null && n !== '' && !Number.isNaN(Number(n)))
  ? `$${Number(n).toLocaleString()}` : ''

/**
 * Build the auto-fill value map (key → string) from the deal context. Keys match
 * the `<key>` portion of `gw_<role>_text__<key>` field names.
 */
export function buildPrefillFromDeal({ deal = {}, contact = null, property = null, agent = null } = {}) {
  const cd = deal.comp_data || {}
  const keyDates = Array.isArray(cd.key_dates) ? cd.key_dates : []
  const kd = (needle) => (keyDates.find(d => (d.type || '').toLowerCase().includes(needle))?.date) || ''
  const fullName = contact ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() : ''
  const today = new Date().toISOString().slice(0, 10)

  return {
    buyer_name:       fullName,
    seller_name:      fullName,   // single-contact deals; refine when both sides are modeled
    client_name:      fullName,
    contact_name:     fullName,
    contact_email:    contact?.email || '',
    contact_phone:    contact?.phone || '',
    property_address: property?.address || '',
    list_price:       money(property?.list_price),
    sale_price:       money(deal.value),
    price:            money(deal.value),
    deal_title:       deal.title || '',
    closing_date:     kd('clos'),
    inspection_date:  kd('inspect'),
    financing_date:   kd('financ'),
    appraisal_date:   kd('apprais'),
    possession_date:  kd('possession'),
    agent_name:       agent?.name || '',
    agent_email:      agent?.email || '',
    agent_phone:      agent?.phone || '',
    today,
  }
}

/**
 * Map a list of PDF form-field names → DocuSign tabs grouped by role, applying
 * CRM prefill to text fields. Returns { tabsByRole, unmatched, recognized }.
 *   tabsByRole : { client:[], client2:[], agent:[] } of { type, tabLabel, value? }
 *   unmatched  : field names that didn't follow the convention (left for DocuSign
 *                to convert as plain, unassigned fields)
 */
export function buildFormTabs(fieldNames = [], prefill = {}) {
  const tabsByRole = { client: [], client2: [], agent: [] }
  const unmatched = []
  let recognized = 0

  for (const name of fieldNames) {
    const f = parseFieldName(name)
    if (!f) { unmatched.push(name); continue }
    recognized++
    const tab = { type: f.type, tabLabel: name }
    if (f.type === 'text') {
      const v = prefill[f.key]
      if (v != null && v !== '') tab.value = String(v)
    }
    if (!tabsByRole[f.role]) tabsByRole[f.role] = []
    tabsByRole[f.role].push(tab)
  }
  return { tabsByRole, unmatched, recognized }
}
