/**
 * Public landing-page data access.
 *
 * The /lp/{type}/{id} pages are the destination of every QR scan, and they run
 * in an ANONYMOUS browser — no session, only the anon key that ships in the
 * bundle. They must therefore never read `mailings` directly: migration 0027
 * closed that table to anon (it holds qr_token, description and the
 * denormalized counters), so a client-side `supabase.from('mailings')` returns
 * zero rows and the page renders its not-found state on a campaign that is
 * perfectly healthy. That was a live bug: scans were recorded and every scanner
 * then saw "Listing not available".
 *
 * All four Landing* pages go through this helper so the service-key read lives
 * in exactly one place, and adding a fifth landing type can't quietly
 * reintroduce the anon read.
 *
 * The advisor cards are NOT fetched here — those read the column-limited
 * `agents_public` view, which 0027 grants to anon on purpose.
 */

/**
 * Fetch the mailing behind a landing page.
 *
 * Returns the mailing, or `null` when the id doesn't resolve (a deleted or
 * mistyped campaign — the page's "not available" state). Throws on transport or
 * server failure, so callers can tell "this campaign is gone" apart from
 * "we couldn't reach the server", which get different UI and only one of which
 * is worth offering a retry for.
 */
export async function fetchPublicMailing(mailingId) {
  const res = await fetch(
    `/api/campaigns?action=landing&id=${encodeURIComponent(mailingId)}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' }
  )
  // 400 is a malformed id, 404 a real miss — both mean "no such landing page",
  // and neither is worth showing a visitor a retry button for.
  if (res.status === 404 || res.status === 400) return null
  if (!res.ok) throw new Error(`landing fetch failed: ${res.status}`)

  const body = await res.json().catch(() => null)
  return body?.mailing || null
}
