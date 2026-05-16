import { createSign } from 'crypto'
import { createClient } from '@supabase/supabase-js'

const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY
const ACCOUNT_ID      = process.env.DOCUSIGN_ACCOUNT_ID
const USER_ID         = process.env.DOCUSIGN_USER_ID

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')

const AUTH_SERVERS = [
  process.env.DOCUSIGN_AUTH_SERVER,
  'account-d.docusign.com',
  'account.docusign.com',
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)

function buildJWT(authServer) {
  const raw = process.env.DOCUSIGN_PRIVATE_KEY || ''
  const privateKey = raw.replace(/\\n/g, '\n')
  const now = Math.floor(Date.now() / 1000)
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: INTEGRATION_KEY, sub: USER_ID, aud: authServer,
    iat: now, exp: now + 3600, scope: 'signature impersonation',
  })).toString('base64url')
  const sigInput = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(sigInput)
  return `${sigInput}.${signer.sign(privateKey, 'base64url')}`
}

async function getAuthConfig() {
  for (const server of AUTH_SERVERS) {
    const tokenRes = await fetch(`https://${server}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: buildJWT(server),
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) {
      if (tokenData.error === 'issuer_not_found' || tokenData.error === 'invalid_grant') continue
      throw new Error(`DocuSign auth: ${tokenData.error}`)
    }
    const userRes  = await fetch(`https://${server}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const userData = await userRes.json()
    const account  = (userData.accounts || []).find(a => a.account_id === ACCOUNT_ID)
                  || (userData.accounts || [])[0]
    const baseUri  = account?.base_uri
                  || (server.includes('-d.') ? 'https://demo.docusign.net' : 'https://na4.docusign.net')
    return { accessToken: tokenData.access_token, baseUri }
  }
  throw new Error('DocuSign auth failed on all servers')
}

export default async function handler(req, res) {
  // DocuSign Connect requires a 200 response quickly to avoid retries
  if (req.method !== 'POST') return res.status(405).end()

  // Use service role key to bypass RLS for server-side writes
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set — webhook cannot write to DB')
    return res.status(200).json({ received: true, error: 'Server misconfigured' })
  }

  const supabase = createClient(SUPABASE_URL, serviceKey)

  try {
    const body = req.body || {}

    // Parse DocuSign Connect JSON payload
    // Modern format: { event, data: { envelopeId, envelopeSummary: { status, completedDateTime } } }
    let envelopeId, status, completedDateTime

    if (body?.data?.envelopeId) {
      envelopeId       = body.data.envelopeId
      const summary    = body.data.envelopeSummary || {}
      status           = summary.status || (body.event || '').replace('envelope-', '') || 'unknown'
      completedDateTime = summary.completedDateTime || null
    } else if (body?.envelopeId) {
      envelopeId        = body.envelopeId
      status            = body.status
      completedDateTime = body.completedDateTime || null
    } else {
      return res.status(200).json({ received: true, note: 'No envelope data in payload' })
    }

    if (!envelopeId || !status) return res.status(200).json({ received: true })

    // Look up our envelope record + the associated deal (for agent_id)
    const { data: envelope } = await supabase
      .from('docusign_envelopes')
      .select('*, deals(id, agent_id, title)')
      .eq('envelope_id', envelopeId)
      .maybeSingle()

    if (!envelope) return res.status(200).json({ received: true, note: 'Envelope not tracked' })

    // Update status in docusign_envelopes
    const patch = { status }
    if (completedDateTime) patch.completed_at = completedDateTime

    await supabase
      .from('docusign_envelopes')
      .update(patch)
      .eq('envelope_id', envelopeId)

    if (status === 'completed') {
      // ── Download signed PDF from DocuSign & save to deal storage ──────────
      try {
        const { accessToken, baseUri } = await getAuthConfig()
        const docRes = await fetch(
          `${baseUri}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )

        if (docRes.ok) {
          const pdfBuffer  = await docRes.arrayBuffer()
          const timestamp  = Date.now()
          const baseName   = (envelope.document_name || 'document').replace(/\.pdf$/i, '')
          const fileName   = `${timestamp}-signed-${baseName}.pdf`
          const storagePath = `deal-${envelope.deal_id}/${fileName}`

          await supabase.storage
            .from('deal-documents')
            .upload(storagePath, Buffer.from(pdfBuffer), {
              contentType: 'application/pdf',
              upsert: false,
            })
        }
      } catch (dlErr) {
        // Non-fatal — status is already updated; log and continue
        console.error('Signed doc download failed:', dlErr.message)
      }

      // ── Create in-app notification for the deal's assigned agent ──────────
      const deal = envelope.deals
      if (deal?.agent_id) {
        const docLabel = envelope.document_name || 'Document'
        const dealLabel = deal.title || 'your deal'
        await supabase.from('agent_notifications').insert([{
          agent_id:    deal.agent_id,
          deal_id:     envelope.deal_id,
          envelope_id: envelopeId,
          title:       'Document Signed',
          message:     `"${docLabel}" for ${dealLabel} has been fully signed by ${envelope.signer_name || 'the signer'}. The signed copy has been saved to the deal's Documents tab.`,
          type:        'document_signed',
        }])
      }
    }

    return res.status(200).json({ received: true, envelopeId, status })
  } catch (err) {
    console.error('DocuSign webhook error:', err.message)
    // Always 200 so DocuSign doesn't keep retrying on transient errors
    return res.status(200).json({ received: true, error: err.message })
  }
}
