// ─────────────────────────────────────────────────────────────────────────────
// Deal team access — migration 0055.
//
// THE BUG THESE GUARD: `deals.co_agent_ids` is a COPY of the listing's
// co-agents, taken once, when the property is converted into a deal. Add an
// agent to the listing AFTERWARDS and the copy is never refreshed (Pipeline.jsx
// re-seeds only for a NEW deal). The UI read the listing as a fallback and
// showed them on the team card; RLS read only the copy and hid the deal, its
// documents, its storage objects and its whole history from them.
//
// So these tests hold the two halves together: the database must DERIVE access
// from the listing as well as the deal, and the client must fetch what the
// database grants rather than reimplementing the rule and drifting from it.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchGrantedDealIds, fetchCoListedDealIds } from '../services/deals.js'
import { fetchGrantedPropertyIds, fetchVisibleProperties } from '../services/properties.js'
import { fetchGrantedContactIds, fetchVisibleContacts } from '../services/contacts.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const migration = read('../../../migrations/0055_deal_team_access.sql')
const schema    = read('../schema.sql')

// Both files describe the same model: the migration moves an existing database
// to it, schema.sql builds a new one already there. A rule added to one and
// forgotten in the other is how the two lineages drift apart (see the note in
// migrations/production/README.md), so every assertion below runs against both.
const BOTH = { '0055_deal_team_access.sql': migration, 'schema.sql': schema }
const inBoth = (label, pattern) => {
  it(label, () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      expect(sql, `${name} is missing: ${pattern}`).toMatch(pattern)
    }
  })
}

describe('app_visible_deal_ids derives access from the listing', () => {
  inBoth('grants the deal to the listing\'s assigned agent',
    /join properties p on p\.id = d\.property_id\s*\n\s*where p\.assigned_agent_id in \(select app_my_agent_ids\(\)\)/)

  inBoth('grants the deal to the co-agents named on the listing',
    /app_jsonb_uuid_array\(p\.details -> 'co_agent_ids'\) && array\(select m from app_my_agent_ids\(\) m\)/)

  inBoth('still grants on the deal\'s own additional-agent column',
    /coalesce\(d\.co_agent_ids, '\{\}'\) && array\(select m from app_my_agent_ids\(\) m\)/)

  inBoth('still grants on a structured commission participant',
    /jsonb_array_elements\(coalesce\(c\.participants/)

  it('keeps every arm a UNION, so no agent loses access they have today', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      const fn = sql.match(/create or replace function app_visible_deal_ids\(\)[\s\S]*?\$\$;/)
      expect(fn, `${name}: app_visible_deal_ids not found`).toBeTruthy()
      expect(fn[0], `${name}: an arm must never subtract`).not.toMatch(/\bexcept\b|\bintersect\b/i)
      // admin + own/team + deal co-agents + listing agent + listing co-agents
      // + commission participants
      expect((fn[0].match(/\bunion\b/g) || []).length).toBe(5)
    }
  })
})

describe('identity no longer hinges on agents.auth_id alone', () => {
  inBoth('resolves the caller by the verified email on their JWT too',
    /lower\(a\.email\) = app_jwt_email\(\)/)

  inBoth('covers every agent row that belongs to the caller',
    /create or replace function app_my_agent_ids\(\)/)

  it('only claims an UNLINKED row by email — a linked row is its owner\'s', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      const fn = sql.match(/create or replace function app_my_agent_ids\(\)[\s\S]*?\$\$;/)
      expect(fn, `${name}: app_my_agent_ids not found`).toBeTruthy()
      expect(fn[0]).toMatch(/where a\.auth_id is null/)
    }
  })
})

describe('the deal\'s people come with the deal', () => {
  inBoth('contacts are visible through a visible deal',
    /create or replace function app_visible_contact_ids\(\)/)

  // 0057 puts row-local arms in front of the lookup (see
  // insertReturningRls.test.js); the lookup itself must stay in `using`.
  inBoth('the contacts policy reads that list',
    /create policy contacts_agent_scope on contacts for all to authenticated\s*\n\s*using\s*\((?:(?!with check)[\s\S])*id in \(select app_visible_contact_ids\(\)\)/)

  inBoth('co-signers linked through deal_contacts count too',
    /from deal_contacts dc\s*\n\s*where dc\.deal_id in \(select app_visible_deal_ids\(\)\)/)
})

describe('writing yourself onto a listing is closed off', () => {
  // Without this, deriving deal access from the listing would be a self-service
  // grant: every signed-in agent could UPDATE every property in the firm under
  // the old `allow_all_authenticated` policy.
  it('properties no longer carries a blanket for-all policy', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      expect(sql, `${name}: the wide-open properties policy must be dropped`)
        .not.toMatch(/create policy "?allow_all_authenticated"? on properties/)
      expect(sql).toMatch(/drop policy if exists allow_all_authenticated\s+on properties/)
    }
  })

  inBoth('reads stay firm-wide for signed-in agents',
    /create policy properties_read on properties for select to authenticated\s*\n\s*using \(true\)/)

  it('updates and deletes require being on the listing', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      for (const cmd of ['update', 'delete']) {
        const policy = sql.match(new RegExp(`create policy properties_${cmd} on properties[\\s\\S]*?;`))
        expect(policy, `${name}: properties_${cmd} not found`).toBeTruthy()
        expect(policy[0], `${name}: properties_${cmd} must be authenticated-only`).toMatch(/to authenticated/)
        expect(policy[0]).toMatch(/app_is_admin\(\)/)
        expect(policy[0]).toMatch(/assigned_agent_id in \(select app_visible_agent_ids\('properties'\)\)/)
        expect(policy[0]).toMatch(/app_jsonb_uuid_array\(details -> 'co_agent_ids'\)/)
      }
    }
  })
})

describe('the co-agent cache is kept by the database', () => {
  inBoth('a listing edit reaches its deals', /trg_property_coagents_to_deals/)
  inBoth('a deal edit reaches its listing', /trg_deal_coagents_to_property/)

  it('both directions stop the recursion they would otherwise cause', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      const hits = sql.match(/if pg_trigger_depth\(\) > 1 then return new; end if;/g) || []
      expect(hits.length, `${name}: both sync triggers need the depth guard`).toBe(2)
    }
  })

  it('the deal → listing direction never removes anyone', () => {
    // One property can carry a buyer-side AND a seller-side deal (migration
    // 0054). Letting one deal's list prune the listing would take the other
    // deal's co-agent off it — and, through the other direction, off that deal.
    for (const [name, sql] of Object.entries(BOTH)) {
      const fn = sql.match(/create or replace function app_sync_deal_coagents_to_property\(\)[\s\S]*?end \$\$;/)
      expect(fn, `${name}: the deal → listing trigger is missing`).toBeTruthy()
      expect(fn[0], `${name}: it must union, never diff`).not.toMatch(/\bexcept\b/)
    }
  })

  it('the listing → deals direction applies the exact diff', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      const fn = sql.match(/create or replace function app_sync_property_coagents_to_deals\(\)[\s\S]*?end \$\$;/)
      expect(fn, `${name}: the listing → deals trigger is missing`).toBeTruthy()
      expect(fn[0]).toMatch(/added\s+:= array\(/)
      expect(fn[0]).toMatch(/removed := array\(/)
      // The deal's own agent is never also one of its co-agents.
      expect(fn[0]).toMatch(/s\.x is distinct from d\.agent_id/)
    }
  })
})

describe('the nightly audit knows the new model', () => {
  // CI parses schema.sql as TEXT and passes whether or not a migration has been
  // applied. That is how a storage policy hid every deal's documents for months
  // without one red build, so the audit that runs against the live database is
  // the only thing that can catch a database this was never applied to.
  inBoth('checks that deal access really is derived from the listing here',
    /item := '0055 deal team access'/)

  inBoth('checks the property write guard', /item := 'properties write scope'/)
  inBoth('checks both sync triggers', /item := 'listing <-> deal triggers'/)
  inBoth('reports agent rows with no login link', /item := 'agents with no login link'/)

  it('reads app_visible_deal_ids out of the catalog rather than trusting the repo', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      expect(sql, `${name}: the check must inspect the INSTALLED function`)
        .toMatch(/pg_get_functiondef\(pr\.oid\) into deal_fn/)
    }
  })

  it('fails loudly, so admins are notified — cron.js only pages on FAIL', () => {
    for (const [name, sql] of Object.entries(BOTH)) {
      const check = sql.match(/item := '0055 deal team access';[\s\S]*?return next;/)
      expect(check, `${name}: the 0055 check is missing`).toBeTruthy()
      expect(check[0]).toMatch(/status := 'FAIL'/)
      expect(check[0]).toMatch(/0055_deal_team_access\.sql/)
    }
  })

  it('wraps 0050\'s function instead of copying it', () => {
    // Two copies of an audit is how the audit drifts. The migration renames
    // 0050's function and returns its rows before adding its own.
    expect(migration).toMatch(/alter function app_access_audit\(\) rename to app_access_audit_core/)
    expect(migration).toMatch(/from app_access_audit_core\(\) c loop/)
  })

  it('stops telling admins a stale cache means lost access', () => {
    // The old detail told them to run 0053 and that RLS was not granting. Since
    // the listing grants directly, the cost is the commission seed and the
    // signer prefill, not access — so the advice had to change with the model.
    for (const [name, sql] of Object.entries(BOTH)) {
      expect(sql, `${name}: the pre-0055 advice is still in place`)
        .toMatch(/costs no ACCESS|no ACCESS/)
    }
    expect(schema, 'schema.sql still tells admins to run 0053 for this')
      .not.toMatch(/show a co-agent on the team card that RLS does not grant\. Run migration 0053/)
  })

  it('declares the variable its new checks use', () => {
    // A plpgsql function referencing an undeclared variable fails at CREATE
    // time and takes the rest of schema.sql with it.
    expect(schema).toMatch(/declare[\s\S]{0,400}deal_fn text;/)
  })
})

describe('the migration is safe to hand to an office admin', () => {
  it('runs in a transaction and reports what it found', () => {
    expect(migration).toMatch(/^begin;/m)
    expect(migration).toMatch(/^commit;/m)
    expect(migration).toMatch(/AGENT WITH NO LOGIN LINK|agents with no login link/i)
  })

  it('names the one thing it narrows, so nobody applies it blind', () => {
    expect(migration).toMatch(/property WRITES|WRITES now require/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The client side: ask the database, do not reimplement it.
// ─────────────────────────────────────────────────────────────────────────────

/** supabase-shaped mock with an `rpc` and a table router. */
function mockClient({ rpc = {}, tables = {} } = {}) {
  const calls = []
  return {
    calls,
    rpc(name) {
      calls.push({ rpc: name })
      const answer = rpc[name]
      if (typeof answer === 'function') return Promise.resolve(answer())
      return Promise.resolve(answer ?? { data: null, error: { message: 'function does not exist' } })
    },
    from(table) {
      const call = { table, filters: [] }
      calls.push(call)
      const chain = {
        select() { return chain },
        order(c, o) { call.filters.push(['order', c, o]); return chain },
        in(c, v) { call.filters.push(['in', c, v]); return chain },
        contains(c, v) { call.filters.push(['contains', c, v]); return chain },
        then(res, rej) {
          const handler = tables[table]
          const out = typeof handler === 'function' ? handler(call) : (handler ?? { data: [], error: null })
          return Promise.resolve(out).then(res, rej)
        },
      }
      return chain
    },
  }
}

describe('fetchGrantedDealIds', () => {
  it('returns the ids the database grants', async () => {
    const client = mockClient({ rpc: { app_visible_deal_ids: { data: ['d1', 'd2'], error: null } } })
    expect(await fetchGrantedDealIds(client)).toEqual(['d1', 'd2'])
  })

  it('unwraps the row-object shape PostgREST may return', async () => {
    const client = mockClient({
      rpc: { app_visible_deal_ids: { data: [{ app_visible_deal_ids: 'd1' }], error: null } },
    })
    expect(await fetchGrantedDealIds(client)).toEqual(['d1'])
  })

  // null, never []: an empty array would read as "you may see nothing" and
  // silently blank the board on a database that is simply behind on migrations.
  it('answers null when the function is not there yet', async () => {
    expect(await fetchGrantedDealIds(mockClient())).toBeNull()
    expect(await fetchGrantedDealIds({ from() {} })).toBeNull()
  })

  it('answers null rather than throwing when the call blows up', async () => {
    const client = mockClient({ rpc: { app_visible_deal_ids: () => { throw new Error('offline') } } })
    expect(await fetchGrantedDealIds(client)).toBeNull()
  })
})

describe('fetchCoListedDealIds', () => {
  it('picks up a deal granted ONLY through the listing', async () => {
    // The reported bug, at the fetch layer: nothing in the browser knew to look
    // at the property, so a deal RLS had already granted was never asked for.
    const client = mockClient({
      rpc: { app_visible_deal_ids: { data: ['via-listing'], error: null } },
      tables: {
        commissions: { data: [], error: null },
        deals: { data: [], error: null },
      },
    })
    const { data, error } = await fetchCoListedDealIds(client, 'agent-1')
    expect(data).toEqual(['via-listing'])
    expect(error).toBeNull()
  })

  it('merges the database\'s answer with the legacy arms, de-duplicated', async () => {
    const client = mockClient({
      rpc: { app_visible_deal_ids: { data: ['d1', 'd2'], error: null } },
      tables: {
        commissions: { data: [{ deal_id: 'd2' }, { deal_id: 'd3' }], error: null },
        deals: { data: [{ id: 'd4' }], error: null },
      },
    })
    const { data } = await fetchCoListedDealIds(client, 'agent-1')
    expect([...data].sort()).toEqual(['d1', 'd2', 'd3', 'd4'])
  })

  it('still works against a database without the function', async () => {
    const client = mockClient({
      tables: {
        commissions: { data: [{ deal_id: 'd1' }], error: null },
        deals: { data: [], error: null },
      },
    })
    const { data, error } = await fetchCoListedDealIds(client, 'agent-1')
    expect(data).toEqual(['d1'])
    expect(error).toBeNull()
  })
})

describe('fetchVisibleProperties', () => {
  it('fetches the listing behind a deal the agent is on', async () => {
    const listing = { id: 'p-listing', created_at: '2026-06-01' }
    const client = mockClient({
      rpc: { app_visible_property_ids: { data: ['p-listing'], error: null } },
      tables: {
        properties: (call) => {
          if (call.filters.some(f => f[0] === 'contains')) return { data: [], error: null }
          const inFilter = call.filters.find(f => f[0] === 'in')
          if (inFilter?.[1] === 'assigned_agent_id') return { data: [], error: null }
          expect(inFilter[2]).toEqual(['p-listing'])
          return { data: [listing], error: null }
        },
      },
    })
    const { data } = await fetchVisibleProperties(client, {
      isAdmin: false, agentId: 'a1', propertyAgentIds: ['a1'],
    })
    expect(data.map(p => p.id)).toEqual(['p-listing'])
  })

  it('never re-fetches a property the owner arms already returned', async () => {
    const own = { id: 'p1', created_at: '2026-06-02' }
    const client = mockClient({
      rpc: { app_visible_property_ids: { data: ['p1'], error: null } },
      tables: {
        properties: (call) => {
          if (call.filters.some(f => f[0] === 'contains')) return { data: [], error: null }
          const inFilter = call.filters.find(f => f[0] === 'in')
          if (inFilter?.[1] === 'assigned_agent_id') return { data: [own], error: null }
          throw new Error('should not re-fetch a property already in hand')
        },
      },
    })
    const { data } = await fetchVisibleProperties(client, {
      isAdmin: false, agentId: 'a1', propertyAgentIds: ['a1'],
    })
    expect(data.map(p => p.id)).toEqual(['p1'])
  })

  it('keeps the agent\'s own listings when the function is absent', async () => {
    const own = { id: 'p1', created_at: '2026-06-02' }
    const client = mockClient({
      tables: {
        properties: (call) =>
          call.filters.some(f => f[0] === 'contains')
            ? { data: [], error: null }
            : { data: [own], error: null },
      },
    })
    const { data } = await fetchVisibleProperties(client, {
      isAdmin: false, agentId: 'a1', propertyAgentIds: ['a1'],
    })
    expect(data.map(p => p.id)).toEqual(['p1'])
  })
})

describe('fetchVisibleContacts', () => {
  it('fetches the buyer and seller on a deal the agent is on', async () => {
    const seller = { id: 'c-seller', created_at: '2026-06-01' }
    const client = mockClient({
      rpc: { app_visible_contact_ids: { data: ['c-seller'], error: null } },
      tables: {
        contacts: (call) => {
          const inFilter = call.filters.find(f => f[0] === 'in')
          if (inFilter?.[1] === 'assigned_agent_id') return { data: [], error: null }
          expect(inFilter[2]).toEqual(['c-seller'])
          return { data: [seller], error: null }
        },
      },
    })
    const { data } = await fetchVisibleContacts(client, {
      isAdmin: false, agentId: 'a1', contactAgentIds: ['a1'],
    })
    expect(data.map(c => c.id)).toEqual(['c-seller'])
  })

  it('admins read the firm unscoped', async () => {
    const client = mockClient({ tables: { contacts: { data: [{ id: 'c1' }], error: null } } })
    await fetchVisibleContacts(client, { isAdmin: true, agentId: 'a1' })
    const call = client.calls.find(c => c.table === 'contacts')
    expect(call.filters.some(f => f[0] === 'in')).toBe(false)
  })

  it('keeps the agent\'s own book when the function is absent', async () => {
    const own = { id: 'c1', created_at: '2026-06-02' }
    const client = mockClient({ tables: { contacts: { data: [own], error: null } } })
    const { data } = await fetchVisibleContacts(client, {
      isAdmin: false, agentId: 'a1', contactAgentIds: ['a1'],
    })
    expect(data.map(c => c.id)).toEqual(['c1'])
  })
})
