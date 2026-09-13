/**
 * THE SIGNED COPY, IN THE AGENTS' INBOXES (api/_lib/signedCopyMail.js).
 *
 * WHAT WAS MISSING. A completed packet was archived onto the deal and announced
 * with an in-app notification — to the ASSIGNED agent only, and the notification
 * is not the document. An agent not looking at the CRM found out whenever they
 * next looked; a co-agent on a co-listed deal found out never; and anyone who
 * needed to forward the executed agreement to a lender or a title company had to
 * go and fetch it by hand.
 *
 * WHAT THESE GUARD:
 *
 * 1. EVERYONE ON THE DEAL. Assigned agent AND co-agents, including the co-agents
 *    a deal converted before migration 0025 only carries on its property. This
 *    is the half that was silently broken, so it is the half with the most tests.
 *
 * 2. THE FILE, NOT A POINTER TO IT. The signed PDF rides on the message. A
 *    packet too large to attach still gets an email — with the link — because a
 *    500-page packet is exactly when an agent most needs to be told.
 *
 * 3. ONE EMAIL PER COMPLETION. BoldSign redelivers webhooks freely; a second
 *    copy of "your document was signed" trains an agent to ignore the first.
 *
 * 4. IT NEVER THROWS. The caller is a webhook where a throw means BoldSign
 *    redelivers the whole event — two more PDF downloads, two more uploads. A
 *    mail problem must never cost the archive that already succeeded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  signedCopyAudience, signedCopyEmail, propertyLine, mailSignedCopyToAgents, MAX_ATTACHMENT_BYTES,
} = await import('../_lib/signedCopyMail.js')

const AGENT   = 'aaaaaaaa-0000-0000-0000-00000000a001'
const CO      = 'aaaaaaaa-0000-0000-0000-00000000a002'
const CO_2    = 'aaaaaaaa-0000-0000-0000-00000000a003'
const DEAL    = 'dddddddd-0000-0000-0000-00000000d001'
const PROPERTY = 'pppppppp-0000-0000-0000-00000000p001'

const AGENTS = [
  { id: AGENT, name: 'Daniel Stillson', email: 'daniel@gatewayreadvisors.com' },
  { id: CO,    name: 'Pat Moreno',      email: 'pat@gatewayreadvisors.com' },
  { id: CO_2,  name: 'Robin Vega',      email: 'robin@gatewayreadvisors.com' },
]

// ─── A stand-in for the service-key client ───────────────────────────────────
// `dealColumnError` is how a database that predates migration 0025 behaves:
// selecting co_agent_ids fails, and the code has to fall back rather than
// deciding the deal does not exist.
function fakeClient({ deals = [], properties = [], agents = AGENTS, dealColumnError = false, file = null } = {}) {
  const db = { deals, properties, agents }

  const from = (name) => {
    const filters = []
    let selected = ''
    const match = row => filters.every(([col, val, op]) => op === 'in' ? val.includes(row[col]) : row[col] === val)
    const rows = () => (db[name] || []).filter(match)
    const fail = () => name === 'deals' && dealColumnError && selected.includes('co_agent_ids')

    const q = {
      select(cols = '') { selected = cols; return q },
      eq(col, val) { filters.push([col, val]); return q },
      in(col, val) { filters.push([col, val, 'in']); return q },
      maybeSingle() {
        if (fail()) return Promise.resolve({ data: null, error: { message: 'column deals.co_agent_ids does not exist' } })
        return Promise.resolve({ data: rows()[0] || null, error: null })
      },
      then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej) },
    }
    return q
  }

  const storage = {
    from: () => ({
      download: async () => file
        ? { data: { arrayBuffer: async () => file }, error: null }
        : { data: null, error: { message: 'Object not found' } },
    }),
  }

  return { from, storage }
}

const deal = (over = {}) => ({
  id: DEAL, title: '1201 Grand — 24 units', agent_id: AGENT,
  co_agent_ids: [], property_id: null, ...over,
})

// ─── 1. Everyone on the deal ─────────────────────────────────────────────────

describe('the signed copy goes to every agent on the deal', () => {
  it('starts with the assigned agent', async () => {
    const svc = fakeClient({ deals: [deal()] })
    const { recipients } = await signedCopyAudience(svc, DEAL)
    expect(recipients.map(r => r.email)).toEqual(['daniel@gatewayreadvisors.com'])
  })

  it('includes co-agents, assigned agent first', async () => {
    const svc = fakeClient({ deals: [deal({ co_agent_ids: [CO, CO_2] })] })
    const { recipients } = await signedCopyAudience(svc, DEAL)
    expect(recipients.map(r => r.email)).toEqual([
      'daniel@gatewayreadvisors.com', 'pat@gatewayreadvisors.com', 'robin@gatewayreadvisors.com',
    ])
  })

  it("falls back to the PROPERTY's co-agents for a deal converted before migration 0025", async () => {
    const svc = fakeClient({
      deals: [deal({ co_agent_ids: [], property_id: PROPERTY })],
      properties: [{ id: PROPERTY, address: '1201 Grand Ave', city: 'Des Moines', state: 'IA', details: { co_agent_ids: [CO] } }],
    })
    const { recipients } = await signedCopyAudience(svc, DEAL)
    expect(recipients.map(r => r.email)).toContain('pat@gatewayreadvisors.com')
  })

  it('still reaches the assigned agent on a database with no co_agent_ids column', async () => {
    const svc = fakeClient({ deals: [deal()], dealColumnError: true })
    const { recipients } = await signedCopyAudience(svc, DEAL)
    expect(recipients.map(r => r.email)).toEqual(['daniel@gatewayreadvisors.com'])
  })

  it('never lists the same address twice, however the agent got on the deal', async () => {
    const svc = fakeClient({ deals: [deal({ co_agent_ids: [AGENT, CO, CO] })] })
    const { recipients } = await signedCopyAudience(svc, DEAL)
    expect(recipients.map(r => r.email)).toEqual(['daniel@gatewayreadvisors.com', 'pat@gatewayreadvisors.com'])
  })

  it('drops an agent with no address rather than failing the whole send', async () => {
    const svc = fakeClient({
      deals: [deal({ co_agent_ids: [CO] })],
      agents: [AGENTS[0], { id: CO, name: 'Pat Moreno', email: '  ' }],
    })
    const { recipients } = await signedCopyAudience(svc, DEAL)
    expect(recipients.map(r => r.email)).toEqual(['daniel@gatewayreadvisors.com'])
  })

  it('answers empty for a deal that is not there', async () => {
    const svc = fakeClient({ deals: [] })
    expect((await signedCopyAudience(svc, DEAL)).recipients).toEqual([])
    expect((await signedCopyAudience(svc, null)).recipients).toEqual([])
  })
})

// ─── The wording ─────────────────────────────────────────────────────────────

describe('the email says which deal, and where the document is', () => {
  const base = {
    documentName: 'Iowa Listing Agreement.pdf',
    dealTitle: '1201 Grand — 24 units',
    propertyAddress: '1201 Grand Ave · Des Moines, IA',
    signerNames: ['Janet Hala'],
    completedAt: '2026-09-13T18:04:00.000Z',
    dealUrl: 'https://crm.example.com/?deal=abc',
    filename: 'signed-Iowa Listing Agreement.pdf',
  }

  it('names the document and the deal in the subject', () => {
    const { subject } = signedCopyEmail({ ...base, attached: true })
    expect(subject).toContain('Iowa Listing Agreement')
    expect(subject).toContain('1201 Grand — 24 units')
  })

  it('says the file is attached when it is', () => {
    const { text, html } = signedCopyEmail({ ...base, attached: true })
    expect(text).toContain('attached')
    expect(html).toContain('attached')
    expect(text).toContain('Janet Hala')
  })

  it('says where the file is instead when it was too big to attach', () => {
    const { text } = signedCopyEmail({ ...base, attached: false })
    expect(text).toContain('too large to attach')
    expect(text).toContain("Documents tab")
  })

  it('escapes a deal title that contains markup', () => {
    const { html } = signedCopyEmail({ ...base, dealTitle: '<img src=x onerror=alert(1)>', attached: true })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('reads the property line off the property, unit and all', () => {
    expect(propertyLine({ address: '1201 Grand Ave', unit: 'Ste 300', city: 'Des Moines', state: 'IA' }))
      .toBe('1201 Grand Ave, Ste 300 · Des Moines, IA')
    expect(propertyLine(null)).toBeNull()
  })
})

// ─── 2-4. The send itself ────────────────────────────────────────────────────

describe('sending', () => {
  let fetchMock
  const OLD_ENV = { ...process.env }

  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key'
    process.env.RESEND_FROM    = 'Gateway CRM <noreply@gatewayreadvisors.com>'
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'email-1' }) }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...OLD_ENV }
  })

  const send = (svc, over = {}) => mailSignedCopyToAgents(svc, {
    dealId: DEAL, documentId: 'doc-1', documentName: 'Iowa Listing Agreement.pdf',
    signerNames: ['Janet Hala'], completedAt: '2026-09-13T18:04:00.000Z',
    signedStoragePath: `deal-${DEAL}/signed.pdf`, bucket: 'deal-documents',
    baseUrl: 'https://crm.example.com', ...over,
  })

  const body = () => JSON.parse(fetchMock.mock.calls[0][1].body)

  it('attaches the signed PDF and addresses every agent on the deal', async () => {
    const svc = fakeClient({ deals: [deal({ co_agent_ids: [CO] })], file: new Uint8Array([37, 80, 68, 70]).buffer })

    const result = await send(svc)

    expect(result).toMatchObject({ sent: true, recipients: 2, attached: true })
    const payload = body()
    expect(payload.to).toEqual(['daniel@gatewayreadvisors.com', 'pat@gatewayreadvisors.com'])
    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments[0].filename).toBe('signed-Iowa Listing Agreement.pdf')
    expect(Buffer.from(payload.attachments[0].content, 'base64')).toEqual(Buffer.from([37, 80, 68, 70]))
  })

  it('sends the email anyway — without the file — when the packet is too large', async () => {
    const svc = fakeClient({ deals: [deal()], file: new Uint8Array(MAX_ATTACHMENT_BYTES + 1).buffer })

    const result = await send(svc)

    expect(result).toMatchObject({ sent: true, attached: false })
    expect(result.skippedAttachment).toMatch(/too large/)
    expect(body().attachments).toBeUndefined()
    expect(body().text).toContain('too large to attach')
  })

  it('sends the email anyway when the archived PDF cannot be read', async () => {
    const svc = fakeClient({ deals: [deal()], file: null })   // storage download fails
    const result = await send(svc)
    expect(result).toMatchObject({ sent: true, attached: false })
  })

  it('keys the message on the document so a webhook redelivery cannot double it', async () => {
    const svc = fakeClient({ deals: [deal()], file: new Uint8Array([1]).buffer })
    await send(svc)
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('signed-copy:doc-1')
  })

  it('links into the deal with the query param the app actually reads', async () => {
    const svc = fakeClient({ deals: [deal()], file: new Uint8Array([1]).buffer })
    await send(svc)
    // src/App.jsx routes on ?deal=<id>; a /deal/<id> PATH is a page this app
    // does not have, and the link would land on the dashboard.
    expect(body().text).toContain(`https://crm.example.com/?deal=${DEAL}`)
  })

  it('reports rather than throws when Resend refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, json: async () => ({ message: 'Invalid to field' }) })
    const svc = fakeClient({ deals: [deal()], file: new Uint8Array([1]).buffer })
    await expect(send(svc)).resolves.toMatchObject({ sent: false, reason: 'Invalid to field' })
  })

  it('reports rather than throws when the network fails outright', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const svc = fakeClient({ deals: [deal()], file: new Uint8Array([1]).buffer })
    await expect(send(svc)).resolves.toMatchObject({ sent: false, reason: 'ECONNRESET' })
  })

  it('does nothing, quietly, when Resend is not configured', async () => {
    delete process.env.RESEND_API_KEY
    const svc = fakeClient({ deals: [deal()] })
    await expect(send(svc)).resolves.toMatchObject({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not send to nobody when the deal has no agent with an address', async () => {
    const svc = fakeClient({ deals: [deal({ agent_id: null })] })
    await expect(send(svc)).resolves.toMatchObject({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
