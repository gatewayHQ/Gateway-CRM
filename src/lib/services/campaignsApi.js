// The /api/campaigns endpoint: one action-dispatching call for the campaigns UI.

// ─── API helper ───────────────────────────────────────────────────────────────

export async function api(action, payload = {}, method = 'POST') {
  if (method === 'GET') {
    const qs = new URLSearchParams({ action, ...payload }).toString()
    const r = await fetch(`/api/campaigns?${qs}`)
    return r.json()
  }
  const r = await fetch('/api/campaigns', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  return r.json()
}
