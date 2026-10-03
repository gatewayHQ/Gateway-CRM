// Service functions return Supabase query builders, which are thenables: they
// have `then` but no `catch`. Chaining `.catch(` onto one throws a TypeError
// before the query even runs — that is how the Team page failed on every load.
// Use `.then(onOk, onFail)` instead.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const files = (dir) => readdirSync(dir).flatMap(f => {
  const p = join(dir, f)
  if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p)
  return /\.jsx?$/.test(f) ? [p] : []
})

/** Names a file imports from src/lib/services/*. */
const serviceImports = (src) => [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*\/services\/[^']+'/g)]
  .flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean))

describe('service calls are never chained with .catch', () => {
  it('no file calls an imported service function and then .catch()', () => {
    const offenders = []
    for (const f of files(SRC)) {
      const src = readFileSync(f, 'utf8')
      for (const name of serviceImports(src)) {
        if (new RegExp(`\\b${name}\\([^()]*\\)\\s*\\.catch\\(`).test(src)) offenders.push(`${f.replace(SRC, 'src/')}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the Team page degrades a missing team_splits table with then(ok, fail)', () => {
    const src = readFileSync(join(SRC, 'pages/Team/index.jsx'), 'utf8')
    expect(src).toMatch(/fetchAllTeamSplits\(\)\.then\(r => r, \(\) => \(\{ data: \[\] \}\)\)/)
  })
})
