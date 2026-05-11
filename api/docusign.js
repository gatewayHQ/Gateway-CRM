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

// ── Tab builder — supports both coordinate-based and anchor-based tabs ───────
// Coordinate tab:  { type, page, xPosition, yPosition }
// Anchor tab:      { type, anchorString, anchorXOffset?, anchorYOffset?, anchorUnits? }
function buildTabs(tabs, recipientId) {
  const signHereTabs = [], initialHereTabs = [], dateSignedTabs = [],
        checkboxTabs = [], textTabs = []

  for (const t of (tabs || [])) {
    const isAnchor = Boolean(t.anchorString)
    let base

    if (isAnchor) {
      base = {
        documentId:     '1',
        recipientId,
        anchorString:   t.anchorString,
        anchorXOffset:  String(t.anchorXOffset  ?? '5'),
        anchorYOffset:  String(t.anchorYOffset  ?? '0'),
        anchorUnits:    t.anchorUnits            || 'pixels',
        anchorMatchWholeWord:  false,
        anchorIgnoreIfNotPresent: true,  // skip if anchor not found (multi-type docs)
        scaleValue:     t.scaleValue             || '0.8',
      }
      if (t.optional) base.optional = true
    } else {
      base = {
        documentId:  '1',
        recipientId,
        pageNumber:  String(t.page),
        xPosition:   t.xPosition,
        yPosition:   t.yPosition,
      }
    }

    if (t.tabLabel) base.tabLabel = t.tabLabel

    if      (t.type === 'signature') signHereTabs.push(base)
    else if (t.type === 'initials')  initialHereTabs.push(base)
    else if (t.type === 'date')      dateSignedTabs.push(base)
    else if (t.type === 'checkbox')  checkboxTabs.push({ ...base, selected: t.selected || false })
    else if (t.type === 'text')      textTabs.push({ ...base, value: t.value || '', required: t.required || false, locked: t.locked || false })
  }

  const result = {}
  if (signHereTabs.length)    result.signHereTabs    = signHereTabs
  if (initialHereTabs.length) result.initialHereTabs = initialHereTabs
  if (dateSignedTabs.length)  result.dateSignedTabs  = dateSignedTabs
  if (checkboxTabs.length)    result.checkboxTabs    = checkboxTabs
  if (textTabs.length)        result.textTabs        = textTabs
  return result
}

// ── Document-type detection from filename ────────────────────────────────────
// Returns { docType, label, confidence } where confidence is 0–1
function detectDocumentType(filename) {
  const n = (filename || '').toLowerCase().replace(/[_-]/g, ' ')

  const patterns = [
    { type: 'purchase_agreement',  label: 'Purchase Agreement',     patterns: ['purchase agreement','purchase contract','sales contract','buy sell','offer to purchase','residential purchase'] },
    { type: 'listing_agreement',   label: 'Listing Agreement',      patterns: ['listing agreement','listing contract','exclusive listing','exclusive right to sell','exclusive agency'] },
    { type: 'lease_agreement',     label: 'Lease / Rental Agreement', patterns: ['lease agreement','rental agreement','lease contract','tenancy agreement'] },
    { type: 'counter_offer',       label: 'Counter Offer',          patterns: ['counter offer','counteroffer','counter proposal','response to offer'] },
    { type: 'commission_agreement',label: 'Commission Agreement',   patterns: ['commission agreement','referral agreement','co-broke','co broke','fee agreement'] },
    { type: 'disclosure',          label: 'Disclosure',             patterns: ['disclosure','lead paint','seller disclosure','property disclosure','spds','transfer disclosure'] },
    { type: 'addendum',            label: 'Addendum',               patterns: ['addendum','amendment','rider','addendum to','modification of'] },
    { type: 'loi',                 label: 'Letter of Intent',       patterns: ['letter of intent','loi','intent to purchase','intent to lease'] },
    { type: 'inspection_report',   label: 'Inspection Addendum',    patterns: ['inspection','inspection addendum','inspection contingency','inspection removal'] },
    { type: 'closing_docs',        label: 'Closing Documents',      patterns: ['closing','settlement statement','hud','cd form','closing disclosure','deed of trust','warranty deed'] },
    { type: 'lease_commercial',    label: 'Commercial Lease',       patterns: ['commercial lease','nnn','triple net','gross lease','modified gross','office lease','retail lease','industrial lease'] },
  ]

  for (const p of patterns) {
    for (const pat of p.patterns) {
      if (n.includes(pat)) return { docType: p.type, label: p.label, confidence: 1.0 }
    }
  }

  // Partial keyword fallbacks
  if (n.includes('purchase') || n.includes('sale'))   return { docType: 'purchase_agreement',  label: 'Purchase Agreement',   confidence: 0.7 }
  if (n.includes('listing'))                           return { docType: 'listing_agreement',   label: 'Listing Agreement',    confidence: 0.7 }
  if (n.includes('lease')   || n.includes('rental'))  return { docType: 'lease_agreement',     label: 'Lease Agreement',      confidence: 0.7 }
  if (n.includes('counter'))                          return { docType: 'counter_offer',       label: 'Counter Offer',        confidence: 0.7 }
  if (n.includes('loi')     || n.includes('intent'))  return { docType: 'loi',                 label: 'Letter of Intent',     confidence: 0.7 }
  if (n.includes('addendum')|| n.includes('amend'))   return { docType: 'addendum',            label: 'Addendum',             confidence: 0.7 }
  if (n.includes('disclos'))                          return { docType: 'disclosure',          label: 'Disclosure',           confidence: 0.7 }

  return { docType: 'generic', label: 'General Document', confidence: 0.3 }
}

// ── Anchor tab templates per document type ───────────────────────────────────
// Each tab uses anchorString so DocuSign finds the text and places the field.
// anchorIgnoreIfNotPresent:true means the tab is silently skipped if text isn't found.
function getAnchorTabsForDocType(docType) {
  const TEMPLATES = {
    purchase_agreement: {
      buyer: [
        { type:'signature', anchorString:'Buyer Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Buyer\'s Signature',    anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'BUYER:',                anchorXOffset:'80',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Purchaser Signature',   anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'initials',  anchorString:'Buyer\'s Initials',     anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'initials',  anchorString:'Buyer Initials',        anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Buyer Date',            anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Date (Buyer)',          anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
      seller: [
        { type:'signature', anchorString:'Seller Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Seller\'s Signature',   anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'SELLER:',               anchorXOffset:'80',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Seller\'s Initials',    anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'initials',  anchorString:'Seller Initials',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Seller Date',           anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Date (Seller)',         anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
      agent: [
        { type:'signature', anchorString:'Agent Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Buyer\'s Agent',        anchorXOffset:'100', anchorYOffset:'0'  },
        { type:'signature', anchorString:'Listing Agent',         anchorXOffset:'100', anchorYOffset:'0'  },
        { type:'date',      anchorString:'Agent Date',            anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    listing_agreement: {
      seller: [
        { type:'signature', anchorString:'Seller/Owner Signature', anchorXOffset:'5',  anchorYOffset:'0'  },
        { type:'signature', anchorString:'Owner Signature',        anchorXOffset:'5',  anchorYOffset:'0'  },
        { type:'signature', anchorString:'Seller:',                anchorXOffset:'60', anchorYOffset:'-5' },
        { type:'signature', anchorString:'SELLER:',                anchorXOffset:'60', anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Seller Initials',        anchorXOffset:'5',  anchorYOffset:'0'  },
        { type:'date',      anchorString:'Seller Date',            anchorXOffset:'5',  anchorYOffset:'0'  },
      ],
      agent: [
        { type:'signature', anchorString:'Listing Agent Signature', anchorXOffset:'5', anchorYOffset:'0' },
        { type:'signature', anchorString:'Agent:',                  anchorXOffset:'60',anchorYOffset:'-5' },
        { type:'date',      anchorString:'Agent Date',              anchorXOffset:'5', anchorYOffset:'0' },
        { type:'date',      anchorString:'Broker Date',             anchorXOffset:'5', anchorYOffset:'0' },
      ],
    },

    lease_agreement: {
      tenant: [
        { type:'signature', anchorString:'Tenant Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Tenant:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Lessee Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'TENANT:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Tenant Initials',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Tenant Date',           anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
      landlord: [
        { type:'signature', anchorString:'Landlord Signature',    anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Landlord:',             anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Lessor Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Owner/Agent:',          anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Landlord Initials',     anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Landlord Date',         anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    lease_commercial: {
      tenant: [
        { type:'signature', anchorString:'Tenant Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Authorized Signature',  anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Lessee:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Tenant Initials',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Execution Date',        anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
      landlord: [
        { type:'signature', anchorString:'Landlord Signature',    anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Lessor:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Landlord Initials',     anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Landlord Date',         anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    counter_offer: {
      buyer: [
        { type:'signature', anchorString:'Buyer Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Buyer:',                anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Buyer Initials',        anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
      seller: [
        { type:'signature', anchorString:'Seller Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Seller:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'initials',  anchorString:'Seller Initials',       anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    loi: {
      buyer: [
        { type:'signature', anchorString:'Prospective Purchaser', anchorXOffset:'5',   anchorYOffset:'20' },
        { type:'signature', anchorString:'Buyer:',                anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Authorized By:',        anchorXOffset:'100', anchorYOffset:'-5' },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
      ],
      seller: [
        { type:'signature', anchorString:'Seller:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Property Owner',        anchorXOffset:'5',   anchorYOffset:'20' },
      ],
    },

    commission_agreement: {
      agent: [
        { type:'signature', anchorString:'Agent Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Associate:',            anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
      ],
      broker: [
        { type:'signature', anchorString:'Broker Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Broker:',               anchorXOffset:'60',  anchorYOffset:'-5' },
      ],
    },

    disclosure: {
      seller: [
        { type:'signature', anchorString:'Seller Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'SELLER:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
      ],
      buyer: [
        { type:'signature', anchorString:'Buyer Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Buyer acknowledges',    anchorXOffset:'5',   anchorYOffset:'20' },
        { type:'date',      anchorString:'Buyer Date',            anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    addendum: {
      buyer: [
        { type:'signature', anchorString:'Buyer:',                anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Buyer Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'initials',  anchorString:'Buyer Initials',        anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
      ],
      seller: [
        { type:'signature', anchorString:'Seller:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Seller Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'initials',  anchorString:'Seller Initials',       anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    closing_docs: {
      buyer: [
        { type:'signature', anchorString:'Buyer Signature',       anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'Borrower Signature',    anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'BUYER:',                anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
      ],
      seller: [
        { type:'signature', anchorString:'Seller Signature',      anchorXOffset:'5',   anchorYOffset:'0'  },
        { type:'signature', anchorString:'SELLER:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'date',      anchorString:'Seller Date',           anchorXOffset:'5',   anchorYOffset:'0'  },
      ],
    },

    generic: {
      buyer: [
        { type:'signature', anchorString:'Signature:',            anchorXOffset:'80',  anchorYOffset:'-5' },
        { type:'signature', anchorString:'Signed:',               anchorXOffset:'60',  anchorYOffset:'-5' },
        { type:'date',      anchorString:'Date:',                 anchorXOffset:'40',  anchorYOffset:'-5' },
      ],
    },
  }

  return TEMPLATES[docType] || TEMPLATES.generic
}

// ── Infer signer roles from signers array ─────────────────────────────────────
// Guesses role from signer name/context if role is not explicitly set
function inferRole(signer, index, total) {
  const name = (signer.role || '').toLowerCase()
  if (name.includes('buyer') || name.includes('purchaser')) return 'buyer'
  if (name.includes('seller') || name.includes('vendor'))   return 'seller'
  if (name.includes('tenant') || name.includes('lessee'))   return 'tenant'
  if (name.includes('landlord')|| name.includes('lessor'))  return 'landlord'
  if (name.includes('agent') || name.includes('broker'))    return 'agent'
  // Fallback: first signer = buyer/tenant, second = seller/landlord, third+ = agent
  if (index === 0) return 'buyer'
  if (index === 1) return 'seller'
  return 'agent'
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

  // ── analyze: detect document type + return suggested anchor tabs ──────────
  // No DocuSign API call needed; pure local analysis.
  if (req.body?.action === 'analyze') {
    const { documentName, signers = [] } = req.body
    const { docType, label, confidence } = detectDocumentType(documentName)
    const tabsByRole = getAnchorTabsForDocType(docType)

    // Map anchor tabs onto each signer based on their inferred role
    const signerTabs = signers.map((s, i) => {
      const role = inferRole(s, i, signers.length)
      const tabs = tabsByRole[role] || tabsByRole.buyer || []
      return { signerIndex: i, role, tabs }
    })

    // Fallback: if no signers provided, return all roles
    const allRoles = Object.entries(tabsByRole).map(([role, tabs]) => ({ role, tabs }))

    return res.json({
      docType,
      label,
      confidence,
      signerTabs,
      allRoles,
      totalTabs: signerTabs.reduce((n, s) => n + s.tabs.length, 0),
    })
  }

  // ── field_templates: return named anchor tab presets ──────────────────────
  if (req.body?.action === 'field_templates') {
    const allTypes = [
      'purchase_agreement','listing_agreement','lease_agreement','lease_commercial',
      'counter_offer','loi','commission_agreement','disclosure','addendum','closing_docs','generic',
    ]
    const templates = allTypes.map(docType => {
      const { label, confidence } = detectDocumentType(docType.replace(/_/g, ' '))
      const tabsByRole = getAnchorTabsForDocType(docType)
      return {
        docType,
        label:      label !== 'General Document' ? label : docType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        tabsByRole,
        roleCount:  Object.keys(tabsByRole).length,
        totalTabs:  Object.values(tabsByRole).flat().length,
      }
    })
    return res.json({ templates })
  }

  try {
    const { accessToken, baseUri } = await getAuthConfig()
    const { action } = req.body
    const baseUrl = `${baseUri}/restapi/v2.1/accounts/${ACCOUNT_ID}`
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }

    if (action === 'send') {
      const { signers, documentBase64, documentName, emailSubject, useAnchorTabs } = req.body
      const ext = (documentName || 'document.pdf').split('.').pop().toLowerCase()

      const recipients = (signers || []).map((s, i) => {
        let tabs

        if (useAnchorTabs && !s.tabs?.length) {
          // Auto-apply anchor tabs based on detected doc type + signer role
          const { docType } = detectDocumentType(documentName)
          const tabsByRole  = getAnchorTabsForDocType(docType)
          const role        = inferRole(s, i, (signers || []).length)
          tabs = buildTabs(tabsByRole[role] || tabsByRole.buyer || [], String(i + 1))
        } else {
          tabs = buildTabs(s.tabs, String(i + 1))
        }

        return {
          email:        s.email,
          name:         s.name,
          recipientId:  String(i + 1),
          routingOrder: String(s.routingOrder || 1),
          tabs,
        }
      })

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

    if (action === 'download') {
      const { envelopeId } = req.body
      const r = await fetch(`${baseUrl}/envelopes/${envelopeId}/documents/combined`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!r.ok) {
        const data = await r.json()
        return res.status(400).json({ error: data.message || 'Failed to download signed document' })
      }
      const buffer = await r.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')
      return res.json({ base64, contentType: 'application/pdf' })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
