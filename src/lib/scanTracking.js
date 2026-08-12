/**
 * Landing-page half of the QR scan pipeline.
 *
 * A scan of /m/{token} redirects here carrying up to two query parameters:
 *
 *   ?v=<visit id>   Always present on internal landing pages. Stitches this
 *                   page view back to the scan row that produced it, so a lead
 *                   captured on this page can be attributed to a specific scan
 *                   (and, when the person is already on the recipient list, to
 *                   a specific piece of mail). With one QR code per campaign
 *                   this is the only hard evidence of that link.
 *
 *   ?sr=<signed>    Present ONLY when the server could not confirm the scan
 *                   write before it had to answer the scanner — a database
 *                   blip, a cold start that blew the latency budget. The
 *                   payload is signed by the server and carries the ORIGINAL
 *                   scan id, so re-reporting it is safe in both directions: if
 *                   the write never landed it lands now, and if it did land the
 *                   replay collides on the primary key and is absorbed. This is
 *                   what turns "we tried to record the scan" into "the scan is
 *                   recorded".
 *
 * Both are stripped from the address bar afterwards so a visitor never sees or
 * shares tracking junk, and a refresh can't re-fire the replay.
 */

const VISIT_KEY = 'gw_visit_id'

/**
 * Call once when a landing page mounts. Safe to call repeatedly and safe during
 * SSR/prerender (no-ops without a window).
 */
export function initScanTracking() {
  if (typeof window === 'undefined') return null

  let visitId = null
  let replay  = null

  try {
    const params = new URLSearchParams(window.location.search)
    visitId = params.get('v')
    replay  = params.get('sr')

    if (visitId) {
      // sessionStorage, not localStorage: the attribution belongs to THIS visit.
      // A different campaign opened in the same browser next week must not
      // inherit it.
      sessionStorage.setItem(VISIT_KEY, visitId)
    }

    if (visitId || replay) {
      params.delete('v')
      params.delete('sr')
      const qs = params.toString()
      window.history.replaceState({}, '',
        window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
    }
  } catch { /* private mode / storage disabled — attribution degrades, page works */ }

  if (replay) reportUnconfirmedScan(replay)

  return visitId
}

/** The current visit id, if this page view came from a QR scan. */
export function getVisitId() {
  if (typeof window === 'undefined') return null
  try { return sessionStorage.getItem(VISIT_KEY) } catch { return null }
}

/**
 * Re-report a scan the server couldn't confirm. Retries with backoff because
 * the reason it's unconfirmed is usually that something was briefly down — one
 * attempt would fail for exactly the same reason.
 */
async function reportUnconfirmedScan(replay, attempt = 0) {
  try {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'scan_replay', replay }),
      cache: 'no-store',
      keepalive: true,   // survives the page being closed mid-flight
    })
    if (!res.ok) throw new Error(String(res.status))
  } catch {
    if (attempt < 4) {
      setTimeout(() => reportUnconfirmedScan(replay, attempt + 1), 800 * 2 ** attempt)
    }
  }
}

/**
 * Merge the visit id into a landing-page form submission. Returns the payload
 * unchanged when this view didn't come from a scan.
 */
export function withVisitId(payload) {
  const v = getVisitId()
  return v ? { ...payload, visit_id: v } : payload
}
