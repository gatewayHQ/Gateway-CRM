/**
 * Public listing-page data access — the /listing/:id counterpart to
 * publicMailing.js.
 *
 * PropertyLanding.jsx runs in an anonymous browser, so it must not read
 * `properties` directly: migration 0027 closed that table to anon, and RLS
 * filters rather than errors, so the select silently returned zero rows and the
 * page showed "not found" to every visitor.
 *
 * The endpoint behind this returns an explicit column projection (and filters
 * the free-form `details` blob down to the spec keys the page renders) — see
 * PUBLIC_PROPERTY_COLUMNS in api/property-public.js.
 */

/**
 * Fetch the property behind a public listing page, with its advisor card joined.
 *
 * Returns the property, or `null` when the id doesn't resolve. Throws on
 * transport or server failure so the caller can tell "this listing is gone" from
 * "we couldn't reach the server" — only one of those is worth a retry button.
 */
export async function fetchPublicProperty(propertyId) {
  const res = await fetch(
    `/api/property-public?action=listing&id=${encodeURIComponent(propertyId)}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' }
  )
  if (res.status === 404 || res.status === 400) return null
  if (!res.ok) throw new Error(`listing fetch failed: ${res.status}`)

  const body = await res.json().catch(() => null)
  return body?.property || null
}
