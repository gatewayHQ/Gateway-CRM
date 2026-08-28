// The Prepare Draft Agreement panel's decisions. Two failures matter: writing a
// term onto the wrong field id, and flipping a box the panel does not show.
import { describe, it, expect } from 'vitest'
import {
  PACKET_FIELD_MAP, PACKET_FIELD_IDS, isPacketField,
  seedPacketState, packetTickValues, packetMissing, wantsEndDate, captionConflicts,
  resolvePacketFieldIds, missingPacketFields, packetPayloadCheck, desiredTickState, tickPayloadValue,
} from '../boldsignPacketPanel.js'
import { isTicked } from '../boldsignSelections.js'

describe('the field map (verify table, PR #114)', () => {
  it('writes each decision to the id the table names', () => {
    expect(PACKET_FIELD_MAP.representation.options.map(o => [o.key, o.id]))
      .toEqual([['exclusive', 'CheckBox1'], ['non-exclusive', 'CheckBox2']])
    expect(PACKET_FIELD_MAP.term.options.map(o => [o.key, o.id]))
      .toEqual([['close', 'CheckBox8'], ['fixed', 'CheckBox9']])
    expect(PACKET_FIELD_MAP.policy.map(p => [p.id, p.default])).toEqual([
      ['CheckBox4', false], ['CheckBox5', false], ['CheckBox6', true], ['CheckBox7', true],
    ])
    // CheckBox3 is decided by nobody on this screen, so it is listed as
    // untouched and carries no value to send.
    expect(PACKET_FIELD_MAP.untouched).toEqual([{ id: 'CheckBox3', expect: expect.any(RegExp) }])
  })

  it('writes exactly the eight boxes it decides — CheckBox3 is not one of them', () => {
    expect([...PACKET_FIELD_IDS].sort()).toEqual(
      ['CheckBox1', 'CheckBox2', 'CheckBox4', 'CheckBox5', 'CheckBox6', 'CheckBox7', 'CheckBox8', 'CheckBox9'],
    )
    expect(isPacketField('CheckBox3')).toBe(false)
    expect(isPacketField('CheckBox10')).toBe(false)
    expect(isPacketField('CheckBox15')).toBe(false)
  })
})

describe('what gets written', () => {
  it('sets the picked option and clears its sibling — the mutex is structural', () => {
    const ex = packetTickValues({ representation: 'exclusive', term: 'close' })
    expect(ex).toMatchObject({ CheckBox1: true, CheckBox2: false, CheckBox8: true, CheckBox9: false })
    const non = packetTickValues({ representation: 'non-exclusive', term: 'fixed' })
    expect(non).toMatchObject({ CheckBox1: false, CheckBox2: true, CheckBox8: false, CheckBox9: true })
  })

  // The wipe bug. BoldSign reads an explicit "false" as "clear the box", and it
  // answers 2xx either way, so a value sent for a box nobody decided is how the
  // template's own Party: Buyer tick disappeared.
  it('sends no value at all for Party: Buyer', () => {
    expect('CheckBox3' in packetTickValues({ representation: 'exclusive', term: 'close' })).toBe(false)
  })

  it('carries the authored policy state — 3 and 4 on', () => {
    const v = packetTickValues({ representation: 'exclusive', term: 'close' })
    expect([v.CheckBox4, v.CheckBox5, v.CheckBox6, v.CheckBox7]).toEqual([false, false, true, true])
  })

  it('writes a value for nothing outside its own nine boxes', () => {
    for (const id of Object.keys(packetTickValues({ representation: 'exclusive', term: 'close' }))) {
      expect(PACKET_FIELD_IDS.has(id)).toBe(true)
    }
  })
})

describe('seeding from the template', () => {
  it('adopts a choice the template already states', () => {
    const state = seedPacketState({ fields: [
      { id: 'CheckBox2', value: 'true' }, { id: 'CheckBox1', value: 'false' },
      { id: 'CheckBox9', value: 'true' }, { id: 'CheckBox8', value: 'false' },
    ] })
    expect(state.representation).toBe('non-exclusive')
    expect(state.term).toBe('fixed')
  })

  // A template with both or neither ticked is not stating a choice. Picking one
  // for the sender would be the panel deciding a term of the agreement.
  it('stays unset when the template states no single choice', () => {
    expect(seedPacketState({ fields: [{ id: 'CheckBox1', value: 'true' }, { id: 'CheckBox2', value: 'true' }] }).representation).toBeNull()
    expect(seedPacketState({ fields: [] }).representation).toBeNull()
    expect(seedPacketState({ fields: [] }).term).toBeNull()
  })

  it('defaults policy to the table where the template is silent', () => {
    expect(seedPacketState({ fields: [] }).policy).toEqual({
      CheckBox4: false, CheckBox5: false, CheckBox6: true, CheckBox7: true,
    })
  })

  it('prefers the template over the table for policy', () => {
    expect(seedPacketState({ fields: [{ id: 'CheckBox6', value: 'false' }] }).policy.CheckBox6).toBe(false)
  })
})

describe('gates', () => {
  it('requires both decisions', () => {
    expect(packetMissing({})).toEqual(['Representation', 'Term'])
    expect(packetMissing({ representation: 'exclusive' })).toEqual(['Term'])
    expect(packetMissing({ representation: 'exclusive', term: 'close' })).toEqual([])
  })

  it('asks for an end date only on the fixed-date term', () => {
    expect(wantsEndDate('fixed')).toBe(true)
    expect(wantsEndDate('close')).toBe(false)
    expect(wantsEndDate(null)).toBe(false)
  })
})

// The map is authoritative by instruction, so this is the only safety net: if a
// template edit moves a box, the caption read off the PDF stops matching the id
// the panel writes to, and that is reported rather than silently locking a wrong
// term onto an agreement.
describe('caption cross-check', () => {
  it('is silent when the page agrees with the map', () => {
    expect(captionConflicts({ fields: [
      { id: 'CheckBox1', caption: 'exclusive' },
      { id: 'CheckBox2', caption: 'non-exclusive' },
      { id: 'CheckBox8', caption: 'A. This Agreement shall continue until closing of the transaction' },
      { id: 'CheckBox9', caption: 'B. This Agreement ends at 11:59 p.m.' },
      { id: 'CheckBox6', caption: '3. APPOINTED AGENCY' },
      { id: 'CheckBox3', caption: 'BUYER' },
    ] })).toEqual([])
  })

  it('reports a box whose printed meaning no longer matches its id', () => {
    const out = captionConflicts({ fields: [{ id: 'CheckBox1', caption: 'non-exclusive' }] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'CheckBox1', caption: 'non-exclusive' })
  })

  it('says nothing about a box the page could not caption', () => {
    expect(captionConflicts({ fields: [{ id: 'CheckBox1' }] })).toEqual([])
  })
})

// ── The payload, which is where both reported bugs lived ─────────────────────
describe('payload — silent fields stay out of it', () => {
  // Every box on a real packet, including the ones behind the unnamed-fields
  // toggle and the already-ticked Party: Buyer.
  const templateFields = [
    { id: 'CheckBox1' }, { id: 'CheckBox2' }, { id: 'CheckBox3', value: 'true' },
    { id: 'CheckBox4' }, { id: 'CheckBox5' }, { id: 'CheckBox6', value: 'true' },
    { id: 'CheckBox7', value: 'true' }, { id: 'CheckBox8' }, { id: 'CheckBox9' },
    { id: 'CheckBox10' }, { id: 'CheckBox11' }, { id: 'CheckBox13' },
    { id: 'CheckBox14' }, { id: 'CheckBox15' },
  ]

  it('omits every field the panel does not own', () => {
    const rows = packetPayloadCheck({ representation: 'non-exclusive', term: 'fixed', fields: templateFields }).rows
    const ids = rows.map(r => r.id)
    for (const absent of ['CheckBox3', 'CheckBox10', 'CheckBox11', 'CheckBox13', 'CheckBox14', 'CheckBox15']) {
      expect(ids).not.toContain(absent)
    }
    expect(ids.sort()).toEqual(
      ['CheckBox1', 'CheckBox2', 'CheckBox4', 'CheckBox5', 'CheckBox6', 'CheckBox7', 'CheckBox8', 'CheckBox9'],
    )
  })

  // Sending only the "on" side leaves yesterday's tick on the other box, and a
  // packet claiming both exclusive and non-exclusive representation is worse
  // than one claiming neither.
  it('always sends both sides of a mutex pair', () => {
    for (const [rep, term] of [['exclusive', 'close'], ['non-exclusive', 'fixed']]) {
      const rows = packetPayloadCheck({ representation: rep, term, fields: templateFields }).rows
      const byId = Object.fromEntries(rows.map(r => [r.id, r.value]))
      expect(Object.keys(byId)).toEqual(expect.arrayContaining(['CheckBox1', 'CheckBox2', 'CheckBox8', 'CheckBox9']))
      // "on"/"off" is BoldSign's own spelling for a checkbox value.
      expect([byId.CheckBox1, byId.CheckBox2].sort()).toEqual(['off', 'on'])
      expect([byId.CheckBox8, byId.CheckBox9].sort()).toEqual(['off', 'on'])
    }
  })

  it('addresses a ticked box with the value the client already uses', () => {
    const rows = packetPayloadCheck({ representation: 'exclusive', term: 'close', fields: templateFields }).rows
    expect(rows.find(r => r.id === 'CheckBox1').value).toBe('on')
    expect(rows.find(r => r.id === 'CheckBox2').value).toBe('off')
  })

  it('passes its own assertions on a sound payload', () => {
    expect(packetPayloadCheck({ representation: 'exclusive', term: 'close', fields: templateFields }).problems).toEqual([])
  })

  it('complains when a decision has not been made', () => {
    const { problems } = packetPayloadCheck({ representation: null, term: 'close', fields: templateFields })
    expect(problems.join(' ')).toMatch(/Representation: 0 of 2/)
  })

  it('complains when the template has no box for a decision', () => {
    const { problems } = packetPayloadCheck({
      representation: 'exclusive', term: 'close',
      fields: templateFields.filter(f => f.id !== 'CheckBox9'),
    })
    expect(problems.join(' ')).toMatch(/CheckBox9 is not on this template/)
    expect(missingPacketFields({ fields: templateFields.filter(f => f.id !== 'CheckBox9') })).toEqual(['CheckBox9'])
  })
})

// A payload addressed to an id the template does not have is accepted with a
// 2xx and changes nothing — the box just opens empty, with no error to chase.
describe('payload — ids come from the template, not from the map', () => {
  const oddCasing = [
    { id: 'Checkbox1' }, { id: 'checkbox2' }, { id: 'CHECKBOX8' }, { id: 'CheckBox9' },
    { id: 'CheckBox4' }, { id: 'CheckBox5' }, { id: 'CheckBox6' }, { id: 'CheckBox7' },
    { id: 'Checkbox3', value: 'true' },
  ]

  it('adopts whatever casing the template reports', () => {
    expect(resolvePacketFieldIds({ fields: oddCasing })).toMatchObject({
      CheckBox1: 'Checkbox1', CheckBox2: 'checkbox2', CheckBox8: 'CHECKBOX8', CheckBox9: 'CheckBox9',
    })
    const ids = packetPayloadCheck({ representation: 'exclusive', term: 'close', fields: oddCasing }).rows.map(r => r.id)
    expect(ids).toEqual(expect.arrayContaining(['Checkbox1', 'checkbox2', 'CHECKBOX8']))
    expect(ids).not.toContain('CheckBox1')
  })

  it('still keeps the untouched box out, whatever its casing', () => {
    const ids = packetPayloadCheck({ representation: 'exclusive', term: 'close', fields: oddCasing }).rows.map(r => r.id)
    expect(ids).not.toContain('Checkbox3')
  })

  it('reads the template state through the same casing', () => {
    expect(seedPacketState({ fields: [{ id: 'checkbox2', value: 'true' }, { id: 'Checkbox1', value: 'false' }] }).representation)
      .toBe('non-exclusive')
  })
})

// ── The tick state the document must end up in ───────────────────────────────
// Stated in full, rather than relying on omission to preserve anything: a draft
// created from a template whose BUYER box was ticked came back with it empty.
describe('desiredTickState', () => {
  const fields = [
    { id: 'CheckBox1' }, { id: 'CheckBox2' }, { id: 'CheckBox3', value: 'true' },
    { id: 'CheckBox4' }, { id: 'CheckBox5' }, { id: 'CheckBox6', value: 'true' },
    { id: 'CheckBox7', value: 'true' }, { id: 'CheckBox8' }, { id: 'CheckBox9' },
    { id: 'CheckBox14', value: 'true' }, { id: 'CheckBox15' },
  ]

  it('asserts every tick the template carries, owned or not', () => {
    const want = desiredTickState({ representation: 'non-exclusive', term: 'fixed', fields })
    expect(want.CheckBox3).toBe(true)     // Party: Buyer — not in the UI, still kept
    expect(want.CheckBox14).toBe(true)    // behind the unnamed-fields toggle, still kept
  })

  it('lets the panel’s decision win over the template', () => {
    const want = desiredTickState({ representation: 'non-exclusive', term: 'fixed', policy: { CheckBox6: false }, fields })
    expect(want.CheckBox2).toBe(true)
    expect(want.CheckBox1).toBe(false)
    expect(want.CheckBox9).toBe(true)
    expect(want.CheckBox8).toBe(false)
    expect(want.CheckBox6).toBe(false)    // turned off in the panel
  })

  // An unticked box nobody decided has no entry, so nothing can be cleared on
  // this map's authority.
  it('says nothing about an unticked box it does not own', () => {
    const want = desiredTickState({ representation: 'exclusive', term: 'close', fields })
    expect('CheckBox15' in want).toBe(false)
  })

  it('is empty for a template with no boxes and no decisions', () => {
    expect(desiredTickState({ fields: [] })).toEqual({})
  })
})

// ── The one string that broke every packet ───────────────────────────────────
// BoldSign spells a checkbox tick "on". "true" is accepted by the API, ignored,
// and leaves the box empty — no error, nothing in any response to explain it.
// That single wrong value produced BOTH reported symptoms: boxes the send screen
// ticked arrived unticked, and a box the TEMPLATE had ticked also arrived empty,
// which read as the send having cleared it.
//
// Pinned here by name so a future change back to "true" fails loudly instead of
// silently shipping unticked agreements.
describe('a tick is spelled "on", never "true"', () => {
  it('writes on/off, from the panel', () => {
    expect(tickPayloadValue(true)).toBe('on')
    expect(tickPayloadValue(false)).toBe('off')
  })

  it('writes on/off, from the prefill builder that actually sends it', async () => {
    const { prefillFieldEntry, tickValue } = await import('../boldsign.js')
    expect(tickValue(true)).toBe('on')
    expect(tickValue(false)).toBe('off')
    expect(prefillFieldEntry({ id: 'CheckBox2', type: 'CheckBox' }, true).value).toBe('on')
    expect(prefillFieldEntry({ id: 'CheckBox1', type: 'CheckBox' }, false).value).toBe('off')
  })

  it('still reads back every spelling a document may report', () => {
    for (const v of ['on', 'true', 'X', '1', 'yes', 'checked']) expect(isTicked(v)).toBe(true)
    for (const v of ['off', 'false', '', null]) expect(isTicked(v)).toBe(false)
  })
})
