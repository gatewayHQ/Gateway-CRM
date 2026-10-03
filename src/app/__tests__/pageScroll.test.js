// Every routed page must render inside `.page-content` — the shell's `.main`
// is `overflow: hidden`, and `.page-content` (flex: 1; overflow-y: auto) is the
// only thing that scrolls. A page whose root is a bare <div> grows past the
// screen and gets clipped with no scrollbar: that is how agents lost every Mail
// Campaign below the first five.
//
// A page that only picks another component to render (CommissionPage → MyEarnings
// or AdminBackOffice) passes when every page it imports passes.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const SRC = resolve(__dirname, '../..')
const read = (p) => readFileSync(p, 'utf8')

function hasScrollRoot(file, seen = new Set()) {
  if (seen.has(file)) return false
  seen.add(file)
  const src = read(file)
  if (src.includes('page-content')) return true
  // Follow imports of other pages (not shared components) one hop at a time.
  const pageImports = [...src.matchAll(/from '(\.[^']+\.jsx)'/g)]
    .map(m => resolve(dirname(file), m[1]))
    .filter(p => p.includes('/pages/') && existsSync(p))
  return pageImports.length > 0 && pageImports.every(p => hasScrollRoot(p, seen))
}

const routed = [...read(resolve(SRC, 'app/routes.jsx')).matchAll(/import\('\.\.\/(pages\/[^']+)'\)/g)]
  .map(m => m[1])

describe('routed pages scroll', () => {
  it('finds the routed pages', () => {
    expect(routed.length).toBeGreaterThan(15)
  })

  it.each(routed)('%s renders inside .page-content', (page) => {
    expect(hasScrollRoot(resolve(SRC, page))).toBe(true)
  })
})
