import { describe, it, expect, vi } from 'vitest'
import {
  serializeTemplateWork, templateWorkEdits, hasTemplateWorkEdits,
  applySavedTemplateWork, countFilledWork, describeTemplateWorkEdits,
  readTemplateWork, saveTemplateWork, clearTemplateWork, isUnsentDraft,
  TEMPLATE_WORK_VERSION,
} from '../templateWork.js'

// A seeded prepare screen: what the deal put there before the agent touched it.
const seed = () => ({
  signers:    { 1: { name: 'Jane Buyer', email: 'jane@example.com' }, 2: { name: '', email: '' } },
  values:     { Label1: 'Jane Buyer', Label2: 'Gateway Real Estate Advisors', Label3: '' },
  selections: { CheckBox1: null, CheckBox2: null },
  panelState: { representation: '', term: '' },
  inOrder:    true,
  subject:    'Please sign: 123 Main',
  message:    'Please review and sign.',
  cc:         [],
  expiryDays: '',
})

const fields = [
  { id: 'Label1' }, { id: 'Label2' }, { id: 'Label3' },
  { id: 'CheckBox1' }, { id: 'CheckBox2' },
]
const roles = [{ index: 1, name: 'Buyer' }, { index: 2, name: 'Co-buyer' }]

describe('serializeTemplateWork', () => {
  it('stores a tri-state tick box as null rather than dropping it', () => {
    const work = serializeTemplateWork({ selections: { CheckBox1: null, CheckBox2: false, CheckBox3: true } })
    expect(work.selections).toEqual({ CheckBox1: null, CheckBox2: false, CheckBox3: true })
  })

  it('normalizes signer rows and stamps the version', () => {
    const work = serializeTemplateWork({ signers: { 1: { name: 'Jane', email: 'j@x.com', extra: 'ignored' } } })
    expect(work.signers).toEqual({ 1: { name: 'Jane', email: 'j@x.com' } })
    expect(work.version).toBe(TEMPLATE_WORK_VERSION)
  })

  it('survives being handed nothing', () => {
    expect(serializeTemplateWork().values).toEqual({})
    expect(serializeTemplateWork().inOrder).toBe(true)
  })
})

describe('templateWorkEdits', () => {
  it('reports nothing for a screen that has only been seeded — closing must be silent', () => {
    expect(hasTemplateWorkEdits({ current: seed(), seeded: seed() })).toBe(false)
  })

  it('does not count key order or a null/empty swap as an edit', () => {
    const current = { ...seed(), values: { Label3: undefined, Label2: 'Gateway Real Estate Advisors', Label1: 'Jane Buyer' } }
    expect(hasTemplateWorkEdits({ current, seeded: seed() })).toBe(false)
  })

  it('names the ticked box and the corrected name', () => {
    const current = {
      ...seed(),
      values:     { ...seed().values, Label1: 'Jane Q. Buyer' },
      selections: { ...seed().selections, CheckBox2: true },
    }
    const edits = templateWorkEdits({ current, seeded: seed() })
    expect(edits.values).toEqual(['Label1'])
    expect(edits.selections).toEqual(['CheckBox2'])
    expect(edits.count).toBe(2)
  })

  it('counts a panel answer, a signer and a send option', () => {
    const current = {
      ...seed(),
      panelState: { ...seed().panelState, representation: 'buyer' },
      signers:    { ...seed().signers, 2: { name: 'John Buyer', email: 'john@example.com' } },
      cc:         ['lender@example.com'],
      expiryDays: '7',
    }
    const edits = templateWorkEdits({ current, seeded: seed() })
    expect(edits.panel).toEqual(['representation'])
    expect(edits.signers).toEqual(['2'])
    expect(edits.options.sort()).toEqual(['cc', 'expiryDays'])
  })

  it('treats a screen with no baseline yet as unedited', () => {
    expect(hasTemplateWorkEdits({ current: seed(), seeded: null })).toBe(true) // no baseline → everything differs
    expect(hasTemplateWorkEdits({ current: {}, seeded: null })).toBe(false)
  })
})

describe('applySavedTemplateWork', () => {
  it('brings back the ticked boxes and the corrected buyer name', () => {
    const saved = serializeTemplateWork({
      ...seed(),
      values:     { ...seed().values, Label1: 'Jane Q. Buyer' },
      selections: { CheckBox1: true, CheckBox2: false },
      panelState: { representation: 'buyer', term: 'fixed' },
    })
    const { state, restored } = applySavedTemplateWork({ saved, seeded: seed(), fields, roles })
    expect(state.values.Label1).toBe('Jane Q. Buyer')
    expect(state.selections).toEqual({ CheckBox1: true, CheckBox2: false })
    expect(state.panelState).toEqual({ representation: 'buyer', term: 'fixed' })
    expect(restored.count).toBe(5)
  })

  it('keeps a value the agent deliberately cleared', () => {
    const saved = serializeTemplateWork({ ...seed(), values: { ...seed().values, Label2: '' } })
    const { state } = applySavedTemplateWork({ saved, seeded: seed(), fields, roles })
    expect(state.values.Label2).toBe('')
  })

  it('drops a saved value for a field the template no longer has', () => {
    const saved = serializeTemplateWork({ ...seed(), values: { Label1: 'Jane Q. Buyer', LabelGone: 'stale' } })
    const { state, restored, dropped } = applySavedTemplateWork({ saved, seeded: seed(), fields, roles })
    expect(state.values.LabelGone).toBeUndefined()
    expect(dropped).toContain('LabelGone')
    expect(restored.values).toBe(1)
  })

  it('drops a saved signer for a role the template no longer has', () => {
    const saved = serializeTemplateWork({
      ...seed(),
      signers: { 1: { name: 'Jane Buyer', email: 'jane@example.com' }, 9: { name: 'Ghost', email: 'g@x.com' } },
    })
    const { state, dropped } = applySavedTemplateWork({ saved, seeded: seed(), fields, roles })
    expect(state.signers['9']).toBeUndefined()
    expect(dropped).toContain('role:9')
  })

  it('keeps a field the template has GAINED seeded from the deal', () => {
    const seeded = { ...seed(), values: { ...seed().values, Label4: 'from the deal' } }
    const saved  = serializeTemplateWork(seed())        // saved before Label4 existed
    const { state } = applySavedTemplateWork({ saved, seeded, fields: [...fields, { id: 'Label4' }], roles })
    expect(state.values.Label4).toBe('from the deal')
  })

  it('restores the send options BoldSign fixes at creation', () => {
    const saved = serializeTemplateWork({ ...seed(), cc: ['lender@example.com'], expiryDays: '7', inOrder: false })
    const { state, restored } = applySavedTemplateWork({ saved, seeded: seed(), fields, roles })
    expect(state.cc).toEqual(['lender@example.com'])
    expect(state.expiryDays).toBe('7')
    expect(state.inOrder).toBe(false)
    expect(restored.options).toBe(3)
  })

  it('returns the seed untouched when there is no save', () => {
    const { state, restored } = applySavedTemplateWork({ saved: null, seeded: seed(), fields, roles })
    expect(state.values).toEqual(seed().values)
    expect(restored.count).toBe(0)
  })

  it('restoring then re-comparing reports no outstanding edits', () => {
    const saved = serializeTemplateWork({ ...seed(), values: { ...seed().values, Label1: 'Jane Q. Buyer' } })
    const { state } = applySavedTemplateWork({ saved, seeded: seed(), fields, roles })
    // The screen is dirty against the SEED (that is what the banner reports),
    // but rebaselining on save is what stops the close prompt firing forever.
    expect(hasTemplateWorkEdits({ current: state, seeded: seed() })).toBe(true)
    expect(hasTemplateWorkEdits({ current: state, seeded: state })).toBe(false)
  })
})

describe('countFilledWork', () => {
  it('counts filled values and answered boxes, not blanks or "as the form is"', () => {
    expect(countFilledWork({
      values:     { a: 'Jane', b: '', c: '   ', d: 'Gateway' },
      selections: { x: true, y: false, z: null },
    })).toBe(4)   // a, d, x, y
  })
})

describe('describeTemplateWorkEdits', () => {
  it('says what is at stake instead of "unsaved changes"', () => {
    const text = describeTemplateWorkEdits(templateWorkEdits({
      current: { ...seed(), values: { ...seed().values, Label1: 'X' }, selections: { ...seed().selections, CheckBox1: true } },
      seeded:  seed(),
    }))
    expect(text).toBe('1 filled-in value and 1 box or term')
  })

  it('is empty when nothing changed', () => {
    expect(describeTemplateWorkEdits(templateWorkEdits({ current: seed(), seeded: seed() }))).toBe('')
  })
})

// ── The Supabase-facing half. The client is injected, so the query each one
//    builds is assertable without a database.
function mockClient(handler) {
  const calls = []
  const chain = (call) => {
    const c = {
      select() { return c },
      eq(col, val) { call.filters.push(['eq', col, val]); return c },
      upsert(rows, opts) { call.upsert = { rows, opts }; return c },
      delete() { call.op = 'delete'; return c },
      maybeSingle() { return Promise.resolve(handler(call)) },
      single() { return Promise.resolve(handler(call)) },
      then(resolve, reject) { return Promise.resolve(handler(call)).then(resolve, reject) },
    }
    return c
  }
  return {
    calls,
    from(table) {
      const call = { table, filters: [] }
      calls.push(call)
      return chain(call)
    },
  }
}

describe('readTemplateWork', () => {
  it('reads the one row for (deal, template)', async () => {
    const client = mockClient(() => ({ data: { id: 'r1', work: { values: {} } }, error: null }))
    const row = await readTemplateWork({ dealId: 'd1', templateId: 't1', client })
    expect(row.id).toBe('r1')
    expect(client.calls[0].table).toBe('deal_template_drafts')
    expect(client.calls[0].filters).toEqual([['eq', 'deal_id', 'd1'], ['eq', 'template_id', 't1']])
  })

  it('returns null (and does not throw) when the table is not there yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = mockClient(() => ({ data: null, error: { message: 'relation does not exist' } }))
    expect(await readTemplateWork({ dealId: 'd1', templateId: 't1', client })).toBeNull()
    warn.mockRestore()
  })

  it('does not query at all without a deal', async () => {
    const client = mockClient(() => ({ data: null, error: null }))
    expect(await readTemplateWork({ dealId: null, templateId: 't1', client })).toBeNull()
    expect(client.calls).toHaveLength(0)
  })
})

describe('saveTemplateWork', () => {
  it('upserts one row per (deal, template) with the filled count', async () => {
    const client = mockClient(() => ({ data: { id: 'r1' }, error: null }))
    await saveTemplateWork({
      dealId: 'd1', templateId: 't1', templateName: 'Buyer Agency', agentId: 'a1', documentId: 'doc1',
      work: { values: { Label1: 'Jane' }, selections: { CheckBox1: true, CheckBox2: null } },
      client,
    })
    const { rows, opts } = client.calls[0].upsert
    expect(opts).toEqual({ onConflict: 'deal_id,template_id' })
    expect(rows[0].deal_id).toBe('d1')
    expect(rows[0].template_id).toBe('t1')
    expect(rows[0].document_id).toBe('doc1')
    expect(rows[0].field_count).toBe(2)
    expect(rows[0].work.values).toEqual({ Label1: 'Jane' })
  })

  it('refuses to save work that is not against a deal — a draft nobody can find is not a draft', async () => {
    await expect(saveTemplateWork({ dealId: null, templateId: 't1', work: {} })).rejects.toThrow(/deal/i)
  })

  it('surfaces a write failure, because the typing is the whole point', async () => {
    const client = mockClient(() => ({ data: null, error: { message: 'permission denied' } }))
    await expect(saveTemplateWork({ dealId: 'd1', templateId: 't1', work: {}, client })).rejects.toThrow('permission denied')
  })
})

describe('clearTemplateWork', () => {
  it('deletes only this deal + template row', async () => {
    const client = mockClient(() => ({ data: null, error: null }))
    await clearTemplateWork({ dealId: 'd1', templateId: 't1', client })
    expect(client.calls[0].op).toBe('delete')
    expect(client.calls[0].filters).toEqual([['eq', 'deal_id', 'd1'], ['eq', 'template_id', 't1']])
  })
})

describe('isUnsentDraft', () => {
  it('is true only while the CRM still calls the document a draft', async () => {
    const draft = mockClient(() => ({ data: { id: 'x', status: 'draft' }, error: null }))
    const sent  = mockClient(() => ({ data: { id: 'x', status: 'sent'  }, error: null }))
    expect(await isUnsentDraft({ dealId: 'd1', documentId: 'doc1', client: draft })).toBe(true)
    expect(await isUnsentDraft({ dealId: 'd1', documentId: 'doc1', client: sent  })).toBe(false)
  })

  it('is false for a document this deal has no row for', async () => {
    const client = mockClient(() => ({ data: null, error: null }))
    expect(await isUnsentDraft({ dealId: 'd1', documentId: 'doc1', client })).toBe(false)
  })

  it('is false with nothing to check', async () => {
    expect(await isUnsentDraft({ dealId: 'd1', documentId: null })).toBe(false)
  })
})
