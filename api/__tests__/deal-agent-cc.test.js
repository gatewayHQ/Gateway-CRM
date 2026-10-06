/**
 * THE DEAL'S AGENTS, COPIED ON EVERY SEND (ccWithDealAgents in api/boldsign.js).
 *
 * BoldSign emails the completed document to every signer and every CC. Agents
 * stopped getting it once most sends became client-only documents (addenda,
 * counters, change forms) sent from the shared admin@ account: the agent was on
 * the document in no capacity at all. Copying the deal's agents fixes that.
 *
 * BoldSign refuses the WHOLE send when a CC is also a signer, or is the
 * account's own user or a sender identity — so those must be dropped, and an
 * unknown must cost the automatic CC, never the send.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mergeAgentCc, sendSignerEmails, ccWithDealAgents } from '../boldsign.js'

const DEAL = 'dddddddd-0000-0000-0000-00000000d001'
const AGENT = 'aaaaaaaa-0000-0000-0000-00000000a001'
const CO    = 'aaaaaaaa-0000-0000-0000-00000000a002'

function fakeSvc({ identities = [], identityError = null, coAgents = [CO] } = {}) {
  const tables = {
    deals: [{ id: DEAL, title: '1201 Grand', agent_id: AGENT, co_agent_ids: coAgents, property_id: null }],
    agents: [
      { id: AGENT, name: 'Steph', email: 'steph@gatewayreadvisors.com' },
      { id: CO,    name: 'Nic',   email: 'nic@gatewayreadvisors.com' },
    ],
  }
  return {
    from: (name) => {
      if (name === 'boldsign_sender_identities') {
        return { select: () => Promise.resolve(identityError ? { data: null, error: identityError } : { data: identities, error: null }) }
      }
      const filters = []
      const rows = () => (tables[name] || []).filter(r => filters.every(([c, v, op]) => op === 'in' ? v.includes(r[c]) : r[c] === v))
      const q = {
        select: () => q,
        eq: (c, v) => { filters.push([c, v]); return q },
        in: (c, v) => { filters.push([c, v, 'in']); return Promise.resolve({ data: rows(), error: null }) },
        maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
      }
      return q
    },
  }
}

const usersResp = (emails) => ({
  ok: true, status: 200, headers: { get: () => null },
  text: () => Promise.resolve(JSON.stringify({ result: emails.map(email => ({ email })) })),
})

afterEach(() => vi.unstubAllGlobals())

describe('mergeAgentCc', () => {
  it('puts the agents first, then the hand-typed CC', () => {
    expect(mergeAgentCc({ cc: ['lender@bank.com'], agentEmails: ['steph@g.com'] }))
      .toEqual([{ emailAddress: 'steph@g.com' }, { emailAddress: 'lender@bank.com' }])
  })

  it('drops anyone BoldSign would refuse, whatever the case', () => {
    expect(mergeAgentCc({ agentEmails: ['Steph@G.com', 'nic@g.com'], exclude: ['steph@g.com'] }))
      .toEqual([{ emailAddress: 'nic@g.com' }])
  })
})

describe('sendSignerEmails', () => {
  it('reads both the upload shape and the template shape', () => {
    expect(sendSignerEmails({ signers: [{ email: 'a@x.com' }], roles: [{ signerEmail: 'b@x.com' }, {}] }))
      .toEqual(['a@x.com', 'b@x.com'])
  })
})

describe('ccWithDealAgents', () => {
  it('copies the assigned agent and the co-agents', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(usersResp(['admin@gatewayreadvisors.com']))))
    const cc = await ccWithDealAgents(fakeSvc(), { deal_id: DEAL, signers: [{ email: 'client@gmail.com' }] })
    expect(cc).toEqual([{ emailAddress: 'steph@gatewayreadvisors.com' }, { emailAddress: 'nic@gatewayreadvisors.com' }])
  })

  it('leaves out an agent who is signing — BoldSign rejects a CC that is a signer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(usersResp(['admin@gatewayreadvisors.com']))))
    const cc = await ccWithDealAgents(fakeSvc(), { deal_id: DEAL, roles: [{ signerEmail: 'steph@gatewayreadvisors.com' }] })
    expect(cc).toEqual([{ emailAddress: 'nic@gatewayreadvisors.com' }])
  })

  it('leaves out an agent who is a sender identity', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(usersResp(['admin@gatewayreadvisors.com']))))
    const cc = await ccWithDealAgents(fakeSvc({ identities: [{ email: 'nic@gatewayreadvisors.com' }] }), { deal_id: DEAL })
    expect(cc).toEqual([{ emailAddress: 'steph@gatewayreadvisors.com' }])
  })

  it('changes nothing for a send with no deal', async () => {
    expect(await ccWithDealAgents(fakeSvc(), { cc: ['x@y.com'] })).toEqual(['x@y.com'])
  })

  it("keeps the agent's own CC, untouched, when the sender identities cannot be read", async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(usersResp([]))))
    const body = { deal_id: DEAL, cc: ['lender@bank.com'] }
    expect(await ccWithDealAgents(fakeSvc({ identityError: { message: 'boom' } }), body)).toEqual(['lender@bank.com'])
  })
})
