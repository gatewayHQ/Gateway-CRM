// ─────────────────────────────────────────────────────────────────────────────
// What the URL the app was opened with asks for.
//
// This app has no real URL routing (a route is a string in state), so links
// from outside — OAuth redirects, emails — arrive as query parameters that are
// translated into a route once, at launch:
//
//   ?outlook=connected|error  The Microsoft OAuth redirect (api/email-send.js's
//                             outlook-callback). Lands on Integrations with a
//                             toast.
//   ?deal=<id>                Into a deal — the signed-copy email the BoldSign
//                             webhook sends (api/_lib/signedCopyMail.js).
//   ?contact=<id>             Into a contact — the new-lead email's "Open in the
//                             CRM". Lead emails sent before Oct 2026 link to
//                             /contacts?id=<id>, which still works.
//   ?preview=markup           The unreleased strike-through markup bench. No nav
//                             entry, nothing links to it.
//
// The first three strip the query string so a refresh doesn't re-route an
// agent who has since navigated elsewhere. The preview deliberately keeps it:
// testing it means reloading repeatedly, and a refresh that dumped you on the
// dashboard would make that tedious. Earlier entries win.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {null | {
 *   route: string,
 *   focus?: { type: string, id: string },
 *   toast?: { message: string, type?: string },
 *   replaceUrl?: string,
 * }}
 */
export function readLaunchIntent({ search, pathname }) {
  const params = new URLSearchParams(search)

  const outlook = params.get('outlook')
  if (outlook) {
    return {
      route: 'integrations',
      toast: outlook === 'connected'
        ? { message: 'Outlook connected' }
        : { message: params.get('message') || 'Could not connect Outlook', type: 'error' },
      replaceUrl: pathname,
    }
  }

  const dealId = params.get('deal')
  const contactId = params.get('contact')
    || (pathname.replace(/\/+$/, '') === '/contacts' ? params.get('id') : null)
  if (dealId || contactId) {
    return {
      ...(dealId
        ? { route: `deal/${dealId}` }
        : { route: 'contacts', focus: { type: 'contact', id: contactId } }),
      replaceUrl: contactId ? '/' : pathname,
    }
  }

  if (params.get('preview') === 'markup') return { route: 'markup-preview' }

  return null
}
