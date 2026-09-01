// The decisions a packet asks its sender for. Three failures matter, in order:
// writing a term onto a field that belongs to a DIFFERENT form, writing one onto
// a box whose printed meaning has changed, and blocking a form that asks for no
// decisions at all because another form does.
import { describe, it, expect } from 'vitest'
import {
  normalizePanel, validatePanel, resolvePanel, panelFieldIds, isPanelField,
  seedPanelState, panelTickValues, panelMissing, revealedTokens,
  describePanelProblem, builtInPanelFor, IA_BUYER_AGENCY_PANEL,
} from '../boldsignPacketPanel.js'

// The Iowa packet's own boxes, captioned the way the page prints them.
const iowaFields = [
  { id: 'CheckBox1', type: 'CheckBox', caption: 'exclusive' },
  { id: 'CheckBox2', type: 'CheckBox', caption: 'non-exclusive' },
  { id: 'CheckBox3', type: 'CheckBox', caption: 'BUYER' },
  { id: 'CheckBox4', type: 'CheckBox', caption: '1. SINGLE SELLER AGENCY' },
  { id: 'CheckBox5', type: 'CheckBox', caption: '2. SINGLE BUYER AGENCY' },
  { id: 'CheckBox6', type: 'CheckBox', caption: '3. APPOINTED AGENCY' },
  { id: 'CheckBox7', type: 'CheckBox', caption: '4. CONSENSUAL DUAL AGENCY' },
  { id: 'CheckBox8', type: 'CheckBox', caption: 'A. This Agreement shall continue until closing of the transaction' },
  { id: 'CheckBox9', type: 'CheckBox', caption: 'B. This Agreement ends at 11:59 p.m. on the date stated' },
]
const iowaPacket = { state: 'IA', transaction_type: 'buyer' }

describe('normalizePanel', () => {
  it('compiles expect patterns from stored strings — a panel round-trips through jsonb', () => {
    const { panel } = normalizePanel(IA_BUYER_AGENCY_PANEL)
    const rep = panel.groups.find(g => g.key === 'representation')
    expect(rep.options[0].expect).toBeInstanceOf(RegExp)
    expect(rep.options[0].expect.test('exclusive')).toBe(true)
    // The negative lookahead is load-bearing: "exclusive" is a substring of
    // "non-exclusive", so a bare /exclusive/ accepts the sibling's caption and
    // the cross-check goes quiet on exactly the swap it exists to catch.
    expect(rep.options[0].expect.test('non-exclusive')).toBe(false)
    expect(rep.options[1].expect.test('non-exclusive')).toBe(true)
  })

  it('reports defects instead of throwing, and keeps the groups that are sound', () => {
    const { panel, errors } = normalizePanel({
      groups: [
        { key: 'ok', kind: 'choice', options: [{ key: 'a', fieldId: 'A' }, { key: 'b', fieldId: 'B' }] },
        { key: 'bad_kind', kind: 'wat', options: [{ fieldId: 'C' }] },
        { key: 'empty', kind: 'toggles', options: [] },
        { key: 'one_option', kind: 'choice', options: [{ fieldId: 'D' }] },
      ],
    })
    expect(panel.groups.map(g => g.key)).toEqual(['ok'])
    expect(errors.map(e => e.code).sort()).toEqual(['bad_group_kind', 'choice_needs_two_options', 'group_without_options'])
  })

  it('refuses to let two options own the same box', () => {
    const { panel, errors } = normalizePanel({
      groups: [{ key: 'g', kind: 'choice', options: [{ key: 'a', fieldId: 'X' }, { key: 'b', fieldId: 'X' }, { key: 'c', fieldId: 'Y' }] }],
    })
    expect(errors.some(e => e.code === 'duplicate_field')).toBe(true)
    expect(panel.groups[0].options.map(o => o.fieldId)).toEqual(['X', 'Y'])
  })

  it('survives an uncompilable pattern rather than taking the screen down', () => {
    const { panel, errors } = normalizePanel({
      groups: [{ key: 'g', kind: 'choice', options: [{ key: 'a', fieldId: 'X', expect: '[' }, { key: 'b', fieldId: 'Y' }] }],
    })
    expect(errors.some(e => e.code === 'bad_expect')).toBe(true)
    expect(panel.groups[0].options[0].expect).toBeNull()
  })

  it('treats an absent panel as no panel, not as an error', () => {
    expect(normalizePanel(null)).toEqual({ panel: null, errors: [] })
    expect(normalizePanel(undefined).panel).toBeNull()
  })
})

describe('what the panel owns', () => {
  const { panel } = normalizePanel(IA_BUYER_AGENCY_PANEL)

  it('names exactly the nine boxes it decides', () => {
    expect([...panelFieldIds(panel)].sort()).toEqual(
      ['CheckBox1', 'CheckBox2', 'CheckBox3', 'CheckBox4', 'CheckBox5', 'CheckBox6', 'CheckBox7', 'CheckBox8', 'CheckBox9'],
    )
    expect(isPanelField(panel, 'CheckBox10')).toBe(false)
  })

  it('owns nothing when there is no panel — the case that was writing terms onto other forms', () => {
    expect([...panelFieldIds(null)]).toEqual([])
    expect(panelTickValues({ panel: null, state: { representation: 'exclusive' } })).toEqual({})
    expect(panelMissing({ panel: null, state: {} })).toEqual([])
  })
})

describe('validation against the live template', () => {
  const { panel } = normalizePanel(IA_BUYER_AGENCY_PANEL)

  it('passes on the form it was written for', () => {
    expect(validatePanel({ panel, fields: iowaFields })).toMatchObject({ ok: true, blocking: [], warnings: [] })
  })

  // THE BUG THIS WHOLE MODULE EXISTS FOR. BoldSign auto-names checkboxes
  // CheckBox1, CheckBox2, … on every template, so a seller listing agreement
  // has boxes with the same ids and completely different meanings.
  it('blocks when the ids exist but mean something else on this form', () => {
    const sellerListing = [
      { id: 'CheckBox1', type: 'CheckBox', caption: 'Seller will provide a home warranty' },
      { id: 'CheckBox2', type: 'CheckBox', caption: 'Property is currently tenant-occupied' },
    ]
    const v = validatePanel({ panel, fields: sellerListing })
    expect(v.ok).toBe(false)
    expect(v.blocking.some(b => b.code === 'caption_conflict' && b.fieldId === 'CheckBox1')).toBe(true)
    expect(v.blocking.some(b => b.code === 'missing_field' && b.fieldId === 'CheckBox8')).toBe(true)
  })

  it('blocks a box that is no longer a tick box', () => {
    const fields = iowaFields.map(f => (f.id === 'CheckBox1' ? { ...f, type: 'TextBox' } : f))
    const v = validatePanel({ panel, fields })
    expect(v.blocking).toEqual([expect.objectContaining({ code: 'not_tickable', fieldId: 'CheckBox1', type: 'TextBox' })])
  })

  // A scanned or image-only page yields no caption. Real, common, and not a
  // reason to stop an agent sending a form that is otherwise intact.
  it('warns rather than blocks when the page carries no caption to check against', () => {
    const fields = iowaFields.map(f => ({ ...f, caption: '' }))
    const v = validatePanel({ panel, fields })
    expect(v.ok).toBe(true)
    expect(v.warnings).toHaveLength(9)
    expect(v.warnings.every(w => w.code === 'no_caption')).toBe(true)
  })
})

describe('resolvePanel — declared beats inferred, and inferred has to earn it', () => {
  it('uses a declared panel and hands back its validation for the caller to block on', () => {
    const packet = { ...iowaPacket, signing_panel: IA_BUYER_AGENCY_PANEL }
    const bad = resolvePanel({ packet, fields: [{ id: 'CheckBox1', type: 'CheckBox', caption: 'exclusive' }] })
    expect(bad.source).toBe('declared')
    expect(bad.panel).toBeTruthy()          // still returned — the admin asserted it applies
    expect(bad.validation.ok).toBe(false)   // …and the send is the caller's to stop
  })

  it('applies the built-in panel to the packet it fits', () => {
    const r = resolvePanel({ packet: iowaPacket, fields: iowaFields })
    expect(r.source).toBe('builtin')
    expect(r.panel.key).toBe('ia_buyer_agency_v1')
  })

  // The regression guard. Before this, the Iowa map was applied to whatever
  // template the agent had selected.
  it('applies NOTHING to a template that merely shares BoldSign’s auto ids', () => {
    const sellerPacket = { state: 'IA', transaction_type: 'seller' }
    expect(resolvePanel({ packet: sellerPacket, fields: iowaFields }).panel).toBeNull()

    // Even an IA/buyer packet built from a different PDF gets nothing, because
    // the built-in panel does not validate against it.
    const otherBuyerForm = [
      { id: 'CheckBox1', type: 'CheckBox', caption: 'Buyer has been pre-approved' },
      { id: 'CheckBox2', type: 'CheckBox', caption: 'Buyer is paying cash' },
    ]
    expect(resolvePanel({ packet: iowaPacket, fields: otherBuyerForm }).panel).toBeNull()
  })

  it('will not infer a panel it could not verify — "probably that packet" is not enough', () => {
    const unreadable = iowaFields.map(f => ({ ...f, caption: '' }))
    expect(resolvePanel({ packet: iowaPacket, fields: unreadable }).panel).toBeNull()
  })

  it('has no candidate for a packet outside the built-in scopes', () => {
    expect(builtInPanelFor({ state: 'NE', transaction_type: 'buyer' })).toBeNull()
    expect(builtInPanelFor({})).toBeNull()
  })
})

describe('state and what gets written', () => {
  const { panel } = normalizePanel(IA_BUYER_AGENCY_PANEL)

  it('adopts a choice the template already states', () => {
    const fields = iowaFields.map(f => (
      f.id === 'CheckBox2' ? { ...f, value: 'true' } : f.id === 'CheckBox9' ? { ...f, value: 'true' } : f
    ))
    const state = seedPanelState({ panel, fields })
    expect(state.representation).toBe('non-exclusive')
    expect(state.term).toBe('fixed')
  })

  // Both ticked, or neither, is not the form stating a choice — picking one for
  // the sender would be the panel deciding a term of the agreement.
  it('stays unset when the template states no single choice', () => {
    const both = iowaFields.map(f => (['CheckBox1', 'CheckBox2'].includes(f.id) ? { ...f, value: 'true' } : f))
    expect(seedPanelState({ panel, fields: both }).representation).toBeNull()
    expect(seedPanelState({ panel, fields: iowaFields }).representation).toBeNull()
  })

  it('defaults toggles to the spec where the template is silent, and to the template where it is not', () => {
    expect(seedPanelState({ panel, fields: iowaFields }).policy).toEqual({
      CheckBox4: false, CheckBox5: false, CheckBox6: true, CheckBox7: true,
    })
    const off = iowaFields.map(f => (f.id === 'CheckBox6' ? { ...f, value: 'false' } : f))
    expect(seedPanelState({ panel, fields: off }).policy.CheckBox6).toBe(false)
  })

  it('sets the picked option and clears its sibling — the mutex is structural', () => {
    const v = panelTickValues({ panel, state: { representation: 'exclusive', term: 'close' } })
    expect(v).toMatchObject({ CheckBox1: true, CheckBox2: false, CheckBox8: true, CheckBox9: false })
    const n = panelTickValues({ panel, state: { representation: 'non-exclusive', term: 'fixed' } })
    expect(n).toMatchObject({ CheckBox1: false, CheckBox2: true, CheckBox8: false, CheckBox9: true })
  })

  it('keeps the fixed party box ticked without showing it', () => {
    expect(panelTickValues({ panel, state: {} }).CheckBox3).toBe(true)
  })

  it('writes a value for nothing outside the boxes it owns', () => {
    const owned = panelFieldIds(panel)
    for (const id of Object.keys(panelTickValues({ panel, state: { representation: 'exclusive' } }))) {
      expect(owned.has(id)).toBe(true)
    }
  })
})

describe('gates and reveals', () => {
  const { panel } = normalizePanel(IA_BUYER_AGENCY_PANEL)

  it('requires every required choice', () => {
    expect(panelMissing({ panel, state: {} })).toEqual(['Representation', 'Term'])
    expect(panelMissing({ panel, state: { representation: 'exclusive' } })).toEqual(['Term'])
    expect(panelMissing({ panel, state: { representation: 'exclusive', term: 'close' } })).toEqual([])
  })

  // The gate is the panel's, not the app's. A form that declares no decisions
  // blocks nothing — which is the whole point: a listing agreement used to be
  // unsendable until the agent answered two buyer-agency questions.
  it('blocks nothing on a form with no panel', () => {
    expect(panelMissing({ panel: null, state: {} })).toEqual([])
  })

  it('reveals the end date only on the fixed-date term', () => {
    expect(revealedTokens({ panel, state: { term: 'fixed' } })).toEqual(['retainer_end_date'])
    expect(revealedTokens({ panel, state: { term: 'close' } })).toEqual([])
    expect(revealedTokens({ panel, state: {} })).toEqual([])
  })
})

describe('problem messages', () => {
  it('names the decision, the box and what the page says', () => {
    expect(describePanelProblem({ code: 'caption_conflict', option: 'Exclusive', fieldId: 'CheckBox1', caption: 'home warranty' }))
      .toContain('CheckBox1')
    expect(describePanelProblem({ code: 'missing_field', option: 'Exclusive', fieldId: 'CheckBox1', groupLabel: 'Representation' }))
      .toContain('Representation')
    expect(describePanelProblem({ code: 'not_tickable', option: 'Exclusive', fieldId: 'CheckBox1', groupLabel: 'Representation', type: 'TextBox' }))
      .toContain('TextBox')
  })
})
