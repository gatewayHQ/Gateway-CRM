/**
 * Deal Room access on the visitor's device.
 *
 * Registering once should be enough. Two things are kept in the browser:
 *
 *   • an ACCESS TOKEN per campaign, issued by the server on registration (or
 *     carried in a "New in the Deal Room" email link as ?dr=…). It is signed and
 *     names one mailing, so it opens that Deal Room and nothing else.
 *   • the visitor's own DETAILS (name, phone, email, address), so the next
 *     Gateway mailer they scan offers "Continue as Jane" instead of a blank form.
 *     That still registers them on the new campaign — the agent still gets the
 *     lead — it just costs the visitor one tap.
 *
 * Browser storage can be missing or throw (private mode, blocked site data), so
 * every access is wrapped and the page works without it: the visitor simply
 * types their details again.
 */

const IDENTITY_KEY = 'gw_deal_room_identity'
const tokenKey = (mailingId) => `gw_deal_room_${mailingId}`

function store() {
  try { return window.localStorage } catch { return null }
}

export function loadIdentity() {
  try {
    const raw = store()?.getItem(IDENTITY_KEY)
    const v = raw ? JSON.parse(raw) : null
    return v && v.name && v.email && v.phone ? v : null
  } catch { return null }
}

export function saveIdentity({ name, phone, email, mailing_address = '' }) {
  try {
    store()?.setItem(IDENTITY_KEY, JSON.stringify({ name, phone, email, mailing_address }))
  } catch { /* storage unavailable — they will type it again next time */ }
}

export function forgetIdentity() {
  try { store()?.removeItem(IDENTITY_KEY) } catch { /* nothing to forget */ }
}

export function loadAccessToken(mailingId) {
  try { return store()?.getItem(tokenKey(mailingId)) || null } catch { return null }
}

export function saveAccessToken(mailingId, token) {
  if (!token) return
  try { store()?.setItem(tokenKey(mailingId), token) } catch { /* session-only access */ }
}

export function clearAccessToken(mailingId) {
  try { store()?.removeItem(tokenKey(mailingId)) } catch { /* nothing stored */ }
}

/**
 * A `?dr=` token from an update email: keep it, then take it out of the address
 * bar so a forwarded screenshot or a copied link does not carry it along.
 * Returns the token or null.
 */
export function takeTokenFromUrl(mailingId) {
  try {
    const url = new URL(window.location.href)
    const t = url.searchParams.get('dr')
    if (!t) return null
    saveAccessToken(mailingId, t)
    url.searchParams.delete('dr')
    window.history.replaceState(window.history.state, '', url.pathname + (url.search || '') + url.hash)
    return t
  } catch { return null }
}

async function post(body) {
  const res = await fetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok && !data.error, status: res.status, data }
}

/** Re-open the Deal Room with a stored token. Null when the token is refused. */
export async function fetchDealRoom(mailingId, token) {
  if (!token) return null
  const { ok, status, data } = await post({ action: 'deal_room', mailing_id: mailingId, access_token: token })
  if (status === 401 || status === 404) { clearAccessToken(mailingId); return null }
  if (!ok) throw new Error(data.error || 'Could not open the Deal Room')
  return data.deal_room || null
}

/** A short-lived download URL for one document. */
export async function requestDocument(mailingId, token, docId) {
  const { ok, data } = await post({ action: 'deal_room_doc', mailing_id: mailingId, access_token: token, doc_id: docId })
  if (!ok || !data.url) throw new Error(data.error || "We couldn't prepare the download. Please try again.")
  return data
}

/** Whole days from today until an ISO date (0 = today, negative = past). Null if unset. */
export function daysUntil(isoDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(isoDate || ''))) return null
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number)
  const target = Date.UTC(y, m - 1, d)
  const today  = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86_400_000)
}

export function formatLongDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(isoDate || ''))) return ''
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}
