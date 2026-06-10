import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = join(root, 'scripts', 'check-enums.mjs')

describe('check-enums guard', () => {
  it('passes on the current tree (enums.js agrees with schema.sql)', () => {
    const out = execFileSync('node', [script], { cwd: root, encoding: 'utf8' })
    expect(out).toMatch(/All app enum lists are consistent/)
    expect(out).not.toMatch(/✗/)
  })
})
