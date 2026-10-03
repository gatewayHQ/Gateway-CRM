import { describe, it, expect } from 'vitest'
import { fileExt, previewKind, neighbours } from '../quickLook.js'

describe('quickLook', () => {
  it('reads the extension case-insensitively', () => {
    expect(fileExt('1696-Purchase Agreement.PDF')).toBe('pdf')
    expect(fileExt('photo.jpeg')).toBe('jpeg')
    expect(fileExt('no-extension')).toBe('')
    expect(fileExt(undefined)).toBe('')
  })

  it('knows what can be previewed in the app', () => {
    expect(previewKind('contract.pdf')).toBe('pdf')
    expect(previewKind('site.PNG')).toBe('image')
    expect(previewKind('scan.webp')).toBe('image')
    expect(previewKind('terms.docx')).toBe('none')
    expect(previewKind('rent-roll.xlsx')).toBe('none')
  })

  it('finds neighbours without wrapping around', () => {
    const list = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    const key = d => d.name
    expect(neighbours(list, 'b', key)).toMatchObject({ index: 1, total: 3, prev: { name: 'a' }, next: { name: 'c' } })
    expect(neighbours(list, 'a', key)).toMatchObject({ prev: null, next: { name: 'b' } })
    expect(neighbours(list, 'c', key)).toMatchObject({ prev: { name: 'b' }, next: null })
    expect(neighbours(list, 'zz', key)).toMatchObject({ index: -1, prev: null, next: null })
  })
})
