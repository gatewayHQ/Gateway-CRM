// The Prepare Draft Agreement panel's decisions. Two failures matter: writing a
// term onto the wrong field id, and flipping a box the panel does not show.
import { describe, it, expect } from 'vitest'
import {
  PACKET_FIELD_MAP, PACKET_FIELD_IDS, isPacketField,
  seedPacketState, packetTickValues, packetMissing, wantsEndDate, captionConflicts,
} from '../boldsignPacketPanel.js'

describe('the field map (verify table, PR #114)', () => {
  it('writes each decision to the id the table names', () => {
    expect(PACKET_FIELD_MAP.representation.options.map(o => [o.key, o.id]))
      .toEqual([['exclusive', 'CheckBox1'], ['non-exclusive', 'CheckBox2']])
    expect(PACKET_FIELD_MAP.term.options.map(o => [o.key, o.id]))
      .toEqual([['close', 'CheckBox8'], ['fixed', 'CheckBox9']])
    expect(PACKET_FIELD_MAP.policy.map(p => [p.id, p.default])).toEqual([
      ['CheckBox4', false], ['CheckBox5', false], ['CheckBox6', true], ['CheckBox7', true],
    ])
    expect(PACKET_FIELD_MAP.locked).toEqual([{ id: 'CheckBox3', value: true, expect: expect.any(RegExp) }])
  })

  it('owns exactly the nine boxes it decides', () => {
    expect([...PACKET_FIELD_IDS].sort()).toEqual(
      ['CheckBox1', 'CheckBox2', 'CheckBox3', 'CheckBox4', 'CheckBox5', 'CheckBox6', 'CheckBox7', 'CheckBox8', 'CheckBox9'],
    )
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

  it('keeps Party: Buyer ticked without showing it', () => {
    expect(packetTickValues({}).CheckBox3).toBe(true)
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
