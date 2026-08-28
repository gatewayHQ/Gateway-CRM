import { describe, it, expect } from 'vitest'
import { readTemplateFields, isAlreadySet, mutexCandidates, renderSpec, renderSpecBundle } from '../boldsignSelectionsSpec.js'
import { orderFieldsByPosition, fieldRows, fieldPosition } from '../boldsignFields.js'

// The packet that started this: page 1 carries "(exclusive) … (non-exclusive)"
// on one line and "BUYER or SELLER" on the next, and BoldSign hands them back in
// placement order — CheckBox11 (non-exclusive) BEFORE CheckBox1 (exclusive),
// with the party boxes interleaved. Reading order has to undo that.
const box = (id, page, y, x, extra = {}) => ({ id, type: 'CheckBox', page, bounds: { x, y, width: 10, height: 10 }, ...extra })

const PACKET = [
  box('CheckBox11', 1, 120, 300),   // non-exclusive — placed first, prints second
  box('CheckBox2',  1, 140, 60, { value: 'true' }),  // BUYER, already ticked
  box('CheckBox1',  1, 120, 150),   // exclusive
  box('CheckBox3',  1, 140, 130),   // SELLER
  box('CheckBox6',  4, 300, 60, { value: 'true' }),  // policy 3
  box('CheckBox12', 4, 200, 60),    // policy 1 — prints ABOVE 3 and 4
]

describe('orderFieldsByPosition', () => {
  it('reads page, then line, then left to right', () => {
    expect(orderFieldsByPosition(PACKET).map(f => f.id)).toEqual([
      'CheckBox1', 'CheckBox11',    // the exclusive line, left then right
      'CheckBox2', 'CheckBox3',     // BUYER then SELLER
      'CheckBox12', 'CheckBox6',    // page 4, policy 1 above policy 3
    ])
  })

  it('treats boxes a few units apart as one printed line', () => {
    const nudged = [box('right', 1, 123, 300), box('left', 1, 120, 150)]
    expect(orderFieldsByPosition(nudged).map(f => f.id)).toEqual(['left', 'right'])
  })

  it('does not merge lines that are genuinely apart', () => {
    const stacked = [box('lower', 1, 140, 60), box('upper', 1, 120, 300)]
    expect(orderFieldsByPosition(stacked).map(f => f.id)).toEqual(['upper', 'lower'])
  })

  // A field with no geometry cannot be placed against the paper. Sorting it as
  // if it sat at (0,0) would put it above boxes whose position IS known and
  // silently shift every row's meaning — the exact class of error this ordering
  // exists to remove.
  it('keeps unpositioned fields last, in their original order', () => {
    const mixed = [{ id: 'noBounds1', type: 'CheckBox' }, box('placed', 2, 50, 50), { id: 'noBounds2', type: 'CheckBox' }]
    expect(orderFieldsByPosition(mixed).map(f => f.id)).toEqual(['placed', 'noBounds1', 'noBounds2'])
    expect(fieldPosition(mixed[0])).toBeNull()
  })

  it('leaves the input array alone', () => {
    const input = [...PACKET]
    orderFieldsByPosition(input)
    expect(input.map(f => f.id)).toEqual(PACKET.map(f => f.id))
  })
})

describe('fieldRows', () => {
  it('groups a printed line together and keeps pages apart', () => {
    expect(fieldRows(PACKET).map(r => [r.page, r.fields.map(f => f.id)])).toEqual([
      [1, ['CheckBox1', 'CheckBox11']],
      [1, ['CheckBox2', 'CheckBox3']],
      [4, ['CheckBox12']],
      [4, ['CheckBox6']],
    ])
  })
})

describe('mutexCandidates', () => {
  it('proposes a group per shared line and none for a box that stands alone', () => {
    const groups = mutexCandidates(PACKET)
    expect(groups.get('CheckBox1')).toBe(groups.get('CheckBox11'))
    expect(groups.get('CheckBox2')).toBe(groups.get('CheckBox3'))
    expect(groups.get('CheckBox1')).not.toBe(groups.get('CheckBox2'))
    expect(groups.has('CheckBox12')).toBe(false)
    expect(groups.has('CheckBox6')).toBe(false)
  })
})

describe('isAlreadySet', () => {
  it('accepts every spelling BoldSign returns for a ticked box', () => {
    for (const v of [true, 'true', 'True', 'on', 'yes', 'checked', '1', 'X']) expect(isAlreadySet(v)).toBe(true)
  })
  it('treats anything else as unticked', () => {
    for (const v of [false, '', null, undefined, 'false', 'off', '0', 'maybe']) expect(isAlreadySet(v)).toBe(false)
  })
})

describe('readTemplateFields', () => {
  it('collects fields from the top level and from inside roles, deduped', () => {
    const { roles, fields } = readTemplateFields({
      roles: [
        { roleIndex: 1, roleName: 'Buyer', formFields: [{ id: 'CheckBox2', fieldType: 'CheckBox', pageNumber: 1, bounds: { x: 1, y: 2 } }] },
        { roleIndex: 2, roleName: 'Agent', formFields: [{ id: 'CheckBox2', fieldType: 'CheckBox' }] },
      ],
      formFields: [{ id: 'Label1', fieldType: 'Label', pageNumber: 3 }],
    })
    expect(roles).toEqual([{ index: 1, name: 'Buyer' }, { index: 2, name: 'Agent' }])
    expect(fields.map(f => f.id)).toEqual(['Label1', 'CheckBox2'])
    expect(fields.find(f => f.id === 'CheckBox2').roleIndex).toBe(1)
  })
})

describe('renderSpec', () => {
  const md = renderSpec({
    template: { templateId: 'tmpl-123', templateName: 'IA Buyer Agency Packet' },
    roles: [{ index: 1, name: 'Buyer' }, { index: 2, name: "Buyer's Agent" }],
    fields: [
      // CheckBox3 is the one box an admin bothered to caption in the editor.
      ...PACKET.map(f => ({ ...f, roleIndex: 1, ...(f.id === 'CheckBox3' ? { label: 'Party: Seller' } : {}) })),
      { id: 'Label1', type: 'Label', page: 1, bounds: { x: 5, y: 5 } },     // not a tick box
      { id: 'CheckBox9', type: 'CheckBox', page: 9 },                        // no bounds
    ],
  })

  // Every row of the table, split into cells — the spec is read as a table, so
  // it is checked as one rather than as prose containing the right substrings.
  const rows = md.split('\n')
    .filter(l => /^\| \d+ \|/.test(l))
    .map(l => l.split('|').map(c => c.trim()))

  it('lists tick boxes only, in reading order', () => {
    expect(rows.map(r => r[4])).toEqual(
      ['CheckBox1', 'CheckBox11', 'CheckBox2', 'CheckBox3', 'CheckBox12', 'CheckBox6', 'CheckBox9'].map(id => `\`${id}\``))
  })

  it('reports the already-ticked ones rather than leaving them to be discovered', () => {
    expect(md).toContain('Already ticked in the template: **2**')
  })

  // The one thing the generator must never do: put a name in a row. It cannot
  // read the words printed beside a box, and a plausible wrong name is the whole
  // failure mode. short_label and owner stay TODO on every row.
  it('never invents a name or an owner for a box', () => {
    expect(rows.map(r => r[9])).toEqual(rows.map(() => 'TODO'))
    expect(rows.map(r => r[10])).toEqual(rows.map(() => 'TODO'))
  })

  it("carries the template's own field name through when the admin typed one", () => {
    expect(rows.map(r => `${r[4]}=${r[5]}`)).toEqual([
      '`CheckBox1`=—', '`CheckBox11`=—', '`CheckBox2`=—', '`CheckBox3`=Party: Seller',
      '`CheckBox12`=—', '`CheckBox6`=—', '`CheckBox9`=—',
    ])
  })

  it('calls out the field it could not place', () => {
    expect(md).toContain('**no bounds**')
    expect(md).toMatch(/No bounds:\*\* `CheckBox9`/)
  })
})

describe('renderSpecBundle — the whole-account sweep in one document', () => {
  const entry = (name, fields) => ({ template: { templateId: `id-${name}`, templateName: name }, roles: [], fields })
  const today = new Date('2026-08-28T00:00:00Z')

  it('includes one spec per template and lists them up front', () => {
    const md = renderSpecBundle([
      entry('Buyer Agency', [box('CheckBox1', 1, 120, 150)]),
      entry('Listing Agreement', [box('CheckBox4', 2, 90, 70)]),
    ], { today })
    expect(md).toContain('2 templates with tick boxes')
    expect(md).toContain('- Buyer Agency')
    expect(md).toContain('# Buyer Agency — selections spec')
    expect(md).toContain('# Listing Agreement — selections spec')
  })

  // A packet with nothing to select is a page an admin scrolls past. Dropping it
  // is safe in a way that dropping a template with boxes never is.
  it('drops templates that have no tick box', () => {
    const md = renderSpecBundle([
      entry('Buyer Agency', [box('CheckBox1', 1, 120, 150)]),
      entry('Wire Instructions', [{ id: 'Label1', type: 'Label', page: 1, bounds: { x: 5, y: 5 } }]),
    ], { today })
    expect(md).toContain('1 template with tick boxes')
    expect(md).not.toContain('Wire Instructions')
  })

  // A sweep that stopped early looks exactly like an account with fewer
  // templates, and an unlisted packet is one nobody knows to name — so it is
  // stated at the top rather than inferred from a short list.
  it('says so at the top when the template walk was cut short', () => {
    const md = renderSpecBundle([entry('Buyer Agency', [box('CheckBox1', 1, 120, 150)])], { today, incomplete: true })
    expect(md.indexOf('**Incomplete.**')).toBeLessThan(md.indexOf('# Buyer Agency'))
  })

  it('survives an account with nothing to spec', () => {
    expect(renderSpecBundle([], { today })).toContain('0 templates with tick boxes')
  })
})
