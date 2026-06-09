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

/**
 * "Easy mode": infer { role, type, key } from a plain field name + the PDF's own
 * widget type, so the admin doesn't have to type the full gw_ convention.
 *   - type comes from the actual PDF field (a signature widget → sign-here, a
 *     checkbox → checkbox, everything else → text) — so a signature field needs
 *     no special name at all.
 *   - role comes from a leading token (`agent_…`, `client2_…`/`co_…`); otherwise
 *     it defaults to the primary client.
 *   - key is the cleaned remainder, which still drives text auto-fill.
 * Push buttons return null (nothing to sign/fill).
 */
export function inferField(name = '', widgetType = 'text') {
  if (widgetType === 'button') return null
  const lc = String(name).trim().toLowerCase()
  let role = 'client', rest = lc
  const rm = /^(agent|client2|co)[ _-]+(.*)$/.exec(lc)
  if (rm) { role = rm[1] === 'agent' ? 'agent' : 'client2'; rest = rm[2] }

  let type = 'text'
  if (widgetType === 'signature') type = 'signature'
  else if (widgetType === 'checkbox' || widgetType === 'radiobutton') type = 'checkbox'

  const key = rest.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return { role, type, key }
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
 * Map a PDF's form fields → DocuSign tabs grouped by role, applying CRM prefill
 * to text fields. Accepts either plain name strings or { name, type } objects
 * (the latter unlocks "easy mode" type inference from the PDF widget).
 * Returns { tabsByRole, recognized, skipped }.
 *   tabsByRole : { client:[], client2:[], agent:[] } of { type, tabLabel, value? }
 *   skipped    : field names we couldn't turn into a tab (e.g. push buttons)
 */
export function buildFormTabs(fields = [], prefill = {}) {
  const tabsByRole = { client: [], client2: [], agent: [] }
  const skipped = []
  let recognized = 0

  for (const raw of fields) {
    const name = typeof raw === 'string' ? raw : raw?.name
    const widgetType = typeof raw === 'string' ? 'text' : (raw?.type || 'text')
    if (!name) continue
    // Explicit gw_ convention wins; otherwise infer from the widget + name.
    const f = parseFieldName(name) || inferField(name, widgetType)
    if (!f) { skipped.push(name); continue }
    recognized++
    const tab = { type: f.type, tabLabel: name }
    if (f.type === 'text' && f.key) {
      const v = prefill[f.key]
      if (v != null && v !== '') tab.value = String(v)
    }
    if (!tabsByRole[f.role]) tabsByRole[f.role] = []
    tabsByRole[f.role].push(tab)
  }
  return { tabsByRole, recognized, skipped, unmatched: skipped }
}
