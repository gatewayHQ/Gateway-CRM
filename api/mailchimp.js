// Vercel serverless function — CORS proxy for Mailchimp Marketing API v3
// API key is passed from the browser (stored in Supabase integrations table).
// Never hardcode secrets here — the key travels in the POST body, authenticated
// only by Supabase RLS on the integrations table.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action, apiKey, listId, members, tag } = req.body || {}
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' })

  // Mailchimp API key encodes the datacenter: xxxx-us6 → us6.api.mailchimp.com
  const dc = apiKey.split('-').pop()
  if (!dc || dc === apiKey) return res.status(400).json({ error: 'Invalid Mailchimp API key format (expected: key-dc)' })

  const base = `https://${dc}.api.mailchimp.com/3.0`
  const auth = 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64')
  const headers = { Authorization: auth, 'Content-Type': 'application/json' }

  try {
    // ── Get all audiences (lists) ────────────────────────────────────────────
    if (action === 'getLists') {
      const r = await fetch(
        `${base}/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count`,
        { headers }
      )
      const data = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: data.detail || data.title || 'Mailchimp error' })
      return res.json({ lists: data.lists || [] })
    }

    // ── Batch upsert members with a tag ──────────────────────────────────────
    if (action === 'syncMembers') {
      if (!listId)        return res.status(400).json({ error: 'Missing listId' })
      if (!members?.length) return res.status(400).json({ error: 'No members provided' })

      const r = await fetch(`${base}/lists/${listId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          members: members.map(m => ({
            email_address: m.email,
            status_if_new: 'subscribed',
            merge_fields: {
              FNAME: m.first_name || '',
              LNAME: m.last_name  || '',
            },
            tags: tag ? [{ name: tag, status: 'active' }] : [],
          })),
          update_existing: true,
        }),
      })
      const data = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: data.detail || data.title || 'Sync failed' })
      return res.json({
        added:   data.new_members?.length     || 0,
        updated: data.updated_members?.length || 0,
        errors:  data.errors                  || [],
      })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[api/mailchimp]', err)
    return res.status(500).json({ error: err.message })
  }
}
