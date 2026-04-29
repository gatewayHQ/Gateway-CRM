import { createSign } from 'crypto'

const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY
const ACCOUNT_ID      = process.env.DOCUSIGN_ACCOUNT_ID
const USER_ID         = process.env.DOCUSIGN_USER_ID

const AUTH_SERVERS = [
  process.env.DOCUSIGN_AUTH_SERVER,
  'account-d.docusign.com',
  'account.docusign.com',
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)

function buildJWT(authServer) {
  const raw = process.env.DOCUSIGN_PRIVATE_KEY || ''
  const privateKey = raw.replace(/\\n/g, '\n')
  if (!privateKey.includes('PRIVATE KEY')) {
    throw new Error('DOCUSIGN_PRIVATE_KEY is missing or malformed — must include BEGIN/END PRIVATE KEY headers')
  }
  const now = Math.floor(Date.now() / 1000)
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: INTEGRATION_KEY,
    sub: USER_ID,
    aud: authServer,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  })).toString('base64url')
  const sigInput = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(sigInput)
  return `${sigInput}.${signer.sign(privateKey, 'base64url')}`
}

// Auto-discovers the right auth server and account base URI
async function getAuthConfig() {
  const errors = []
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
      errors.push(`[${server}] ${tokenData.error}: ${tokenData.error_description || ''}`)
      if (tokenData.error === 'issuer_not_found' || tokenData.error === 'invalid_grant') continue
      throw new Error(errors.join(' | '))
    }
    // Discover correct base URI from userinfo
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
  throw new Error(
    `DocuSign auth failed on all servers. ${errors.join(' | ')} — ` +
    `Check: (1) DOCUSIGN_INTEGRATION_KEY matches Apps & Keys page, ` +
    `(2) DOCUSIGN_USER_ID is the User ID (not Account ID), ` +
    `(3) RSA keypair in Vercel matches the one in DocuSign — if unsure, regenerate the keypair in DocuSign and update DOCUSIGN_PRIVATE_KEY.`
  )
}

function buildTabs(tabs, recipientId) {
  const signHereTabs = [], initialHereTabs = [], dateSignedTabs = []
  for (const t of (tabs || [])) {
    const base = { documentId: '1', recipientId, pageNumber: String(t.page), xPosition: t.xPosition, yPosition: t.yPosition }
    if (t.type === 'signature')      signHereTabs.push(base)
    else if (t.type === 'initials')  initialHereTabs.push(base)
    else if (t.type === 'date')      dateSignedTabs.push(base)
  }
  const result = {}
  if (signHereTabs.length)    result.signHereTabs    = signHereTabs
  if (initialHereTabs.length) result.initialHereTabs = initialHereTabs
  if (dateSignedTabs.length)  result.dateSignedTabs  = dateSignedTabs
  return result
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!INTEGRATION_KEY || !ACCOUNT_ID || !USER_ID || !process.env.DOCUSIGN_PRIVATE_KEY) {
    return res.status(500).json({
      error: 'DocuSign environment variables not configured',
      missing: { INTEGRATION_KEY: !INTEGRATION_KEY, ACCOUNT_ID: !ACCOUNT_ID, USER_ID: !USER_ID, PRIVATE_KEY: !process.env.DOCUSIGN_PRIVATE_KEY },
    })
  }

  if (req.body?.action === 'debug') {
    const pk = (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    return res.json({
      authServersToTry: AUTH_SERVERS,
      integrationKey:   INTEGRATION_KEY,
      accountId:        ACCOUNT_ID,
      userId:           USER_ID,
      privateKeyStart:  pk.slice(0, 50),
      privateKeyEnd:    pk.slice(-40),
      privateKeyLength: pk.length,
      privateKeyValid:  pk.includes('PRIVATE KEY'),
    })
  }

  try {
    const { accessToken, baseUri } = await getAuthConfig()
    const { action } = req.body
    const baseUrl = `${baseUri}/restapi/v2.1/accounts/${ACCOUNT_ID}`
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }

    if (action === 'send') {
      const { signers, documentBase64, documentName, emailSubject } = req.body
      const ext = (documentName || 'document.pdf').split('.').pop().toLowerCase()

      const recipients = (signers || []).map((s, i) => ({
        email:        s.email,
        name:         s.name,
        recipientId:  String(i + 1),
        routingOrder: String(s.routingOrder || 1),
        tabs:         buildTabs(s.tabs, String(i + 1)),
      }))

      const envelope = {
        emailSubject: emailSubject || 'Please sign this document',
        documents: [{ documentBase64, name: documentName || 'Document', fileExtension: ext, documentId: '1' }],
        recipients: { signers: recipients },
        status: 'sent',
      }

      const r    = await fetch(`${baseUrl}/envelopes`, { method: 'POST', headers, body: JSON.stringify(envelope) })
      const data = await r.json()
      if (!r.ok) return res.status(400).json({ error: data.message || 'Failed to send envelope' })
      return res.json({ envelopeId: data.envelopeId, status: data.status })
    }

    if (action === 'status') {
      const { envelopeId } = req.body
      const r    = await fetch(`${baseUrl}/envelopes/${envelopeId}`, { headers })
      const data = await r.json()
      if (!r.ok) return res.status(400).json({ error: data.message })
      return res.json({ status: data.status, sentDateTime: data.sentDateTime, completedDateTime: data.completedDateTime })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
