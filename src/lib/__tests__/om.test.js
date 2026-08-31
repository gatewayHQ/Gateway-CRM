/**
 * The OM descriptor contract — the shape both halves of the feature agree on.
 *
 * The builder writes `landing_config.om = { path, filename, ... }` and the four
 * public landing pages read it back MINUS the path (api/campaigns.js strips it).
 * normalizeOm has to say "there is an OM here" in both cases, or the gate would
 * vanish from every live page the moment the path stopped being published.
 */
import { describe, it, expect } from 'vitest'
import { normalizeOm, hasOm, formatBytes, OM_MAX_BYTES } from '../om.js'

describe('normalizeOm', () => {
  it('reads the builder-side descriptor, path and all', () => {
    const om = normalizeOm({ path: 'abc/Deal-OM.pdf', filename: 'Deal-OM.pdf', size: 2048, title: 'The Deal' })
    expect(om.path).toBe('abc/Deal-OM.pdf')
    expect(om.filename).toBe('Deal-OM.pdf')
    expect(om.title).toBe('The Deal')
    expect(om.size).toBe(2048)
    expect(om.available).toBe(true)
  })

  it('still reports an OM on the public payload, which has no path', () => {
    const om = normalizeOm({ available: true, filename: 'Deal-OM.pdf', size: 2048 })
    expect(om).not.toBeNull()
    expect(om.available).toBe(true)
    expect(om.path).toBe('')
  })

  it('tolerates a bare string path from a hand-edited config', () => {
    const om = normalizeOm('folder/Some-OM.pdf')
    expect(om.path).toBe('folder/Some-OM.pdf')
    expect(om.filename).toBe('Some-OM.pdf')
  })

  it('falls back to a sensible download name', () => {
    expect(normalizeOm({ path: 'x/y' }).filename).toBe('offering-memorandum.pdf')
  })

  it.each([
    ['null',                null],
    ['undefined',           undefined],
    ['an empty object',     {}],
    ['a blank path',        { path: '   ' }],
    ['available: false',    { available: false }],
    ['a number',            42],
  ])('returns null for %s, so the gate is not rendered', (_label, input) => {
    expect(normalizeOm(input)).toBeNull()
  })

  it('drops a non-numeric size rather than printing "NaN MB"', () => {
    expect(normalizeOm({ path: 'a/b.pdf', size: 'big' }).size).toBeNull()
  })
})

describe('hasOm', () => {
  it('is true only when the config carries a usable OM', () => {
    expect(hasOm({ om: { path: 'a/b.pdf' } })).toBe(true)
    expect(hasOm({ om: { available: true } })).toBe(true)
    expect(hasOm({ headline: 'No OM' })).toBe(false)
    expect(hasOm(null)).toBe(false)
  })
})

describe('formatBytes', () => {
  it('reads like a file size, not a byte count', () => {
    expect(formatBytes(400)).toBe('1 KB')
    expect(formatBytes(1024 * 400)).toBe('400 KB')
    expect(formatBytes(4_200_000)).toBe('4.0 MB')
    expect(formatBytes(OM_MAX_BYTES)).toBe('50.0 MB')
  })

  it('says nothing rather than something wrong when the size is unknown', () => {
    expect(formatBytes(0)).toBeNull()
    expect(formatBytes(null)).toBeNull()
    expect(formatBytes('huge')).toBeNull()
  })
})
