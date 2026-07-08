// ─────────────────────────────────────────────────────────────────────────────
// BoldSign client service — the single place the browser talks to /api/boldsign.
//
// Every call carries the Supabase access token as a Bearer header; the API's
// requireAgent()/requireAdmin() reject requests without it. Centralizing here
// fixes the class of bug where a caller forgot the token and got a 401.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
  }
}

async function call(payload) {
  const res  = await fetch('/api/boldsign', {
    method: 'POST', headers: await authHeaders(), body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Documents (ad-hoc send flow) ─────────────────────────────────────────────
export const sendDocument   = (p)          => call({ action: 'send', ...p })
export const getDocStatus   = (documentId) => call({ action: 'status',   documentId })
export const downloadSigned = (documentId) => call({ action: 'download', documentId })
export const remindDocument = (documentId) => call({ action: 'remind',   documentId })
export const debugBoldsign  = ()           => call({ action: 'debug' })

// ── Sender identities (admin) ────────────────────────────────────────────────
export const createIdentity = (agentId, name, email) => call({ action: 'identity-create', agentId, name, email })
export const syncIdentities = ()      => call({ action: 'identity-sync' })
export const resendIdentity = (email) => call({ action: 'identity-resend', email })

// ── Templates ────────────────────────────────────────────────────────────────
export const listBoldsignTemplates = ()  => call({ action: 'template-list' })
export const templateEditorUrl     = (p) => call({ action: 'template-editor-url', ...p })
export const sendFromTemplate      = (p) => call({ action: 'template-send', ...p })

// Normalize a state value to a 2-letter code. Accepts existing codes (IA) or
// the full names of the states the brokerage operates in. Extend the map if you
// add states.
const STATE_CODES = { iowa: 'IA', 'south dakota': 'SD', nebraska: 'NE' }
export function normalizeState(s) {
  const v = String(s || '').trim()
  if (!v) return ''
  if (v.length === 2) return v.toUpperCase()
  return STATE_CODES[v.toLowerCase()] || v.toUpperCase()
}

// ── CRM → template field prefill ─────────────────────────────────────────────
// Maps our fixed label/id tokens to values pulled from the deal + its property
// and primary contact. Only tokens the template actually declares get sent.
export function buildPrefill(fieldTokens = [], { deal, property, contact } = {}) {
  const money = (n) => (n != null && n !== '' ? `$${Number(n).toLocaleString()}` : '')
  const source = {
    property_address:   property?.address || deal?.prop_address || '',
    list_price:         money(property?.price ?? deal?.value),
    commission_pct:     deal?.commission_pct != null ? `${deal.commission_pct}%` : '',
    listing_start_date: deal?.comp_data?.listing_start || '',
    listing_end_date:   deal?.comp_data?.listing_end || deal?.expected_close_date || '',
    seller_name:        [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    client_name:        [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    close_date:         deal?.expected_close_date || '',
  }
  return (fieldTokens || [])
    .map(id => ({ id, value: source[id] }))
    .filter(f => f.value)                          // skip unknown/empty tokens
    .map(f => ({ ...f, isReadOnly: true }))        // CRM-owned values are locked
}
