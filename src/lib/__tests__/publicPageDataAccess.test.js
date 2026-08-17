// ─────────────────────────────────────────────────────────────────────────────
// Public pages may not read RLS-closed tables with the anon key.
//
// This is the structural guard on the QR landing-page bug. Migration 0027 closed
// eight tables to `anon`, on the written assumption that "no public page reads
// any of these tables directly". That assumption was false for /lp/*: all four
// Landing* pages called `supabase.from('mailings')` from the browser. RLS
// filters instead of erroring, so the page got zero rows and rendered its
// not-found state for every real scanner — while the scan itself, which runs on
// the service key in api/campaigns.js, kept recording perfectly. A silent break
// that the analytics could not show.
//
// The same shape of bug is one line away any time a public page is added or a
// table is locked down, and nothing about it is loud. Hence a test that reads
// the source instead of trusting a comment in a migration.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pagesDir = fileURLToPath(new URL('../../pages/', import.meta.url))
const mainJsx  = readFileSync(fileURLToPath(new URL('../../main.jsx', import.meta.url)), 'utf8')

// Tables migration 0027 closed to anon. A public page reaching any of these
// through the browser client gets zero rows, not an error.
const CLOSED_TO_ANON = [
  'properties', 'templates', 'teams', 'team_splits',
  'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads',
]

// ── KNOWN BROKEN, NOT YET FIXED ─────────────────────────────────────────────
// The same 0027 breakage on the property-listing pages, found by this guard
// while fixing the QR landing pages. Recorded here rather than deleted from the
// deny-list so the guard keeps passing on a green build without pretending these
// are fine — they are NOT fine, they are the identical bug on another route:
//
//   PropertyLanding.jsx (/listing/:id) reads `properties` with the anon key, so
//   post-0027 the public listing page renders "not found" for every visitor.
//
// Fixing it needs a projection decision this change should not make on its own:
// the page does `select('*')`, and `properties` carries internal columns
// (notably `notes`) that must not be published. It needs its own service-key
// endpoint with an explicit column list, plus a look at api/property-public.js,
// whose handleShare() reads `properties` with the ANON key server-side and is
// therefore broken on /share/:id for the same reason.
const KNOWN_BROKEN = new Set([
  'PropertyLanding.jsx:properties',
])

/**
 * Drop comments so the scan reads CODE only.
 *
 * Without this the guard trips on the explanatory comments in the landing pages,
 * which name `supabase.from('mailings')` precisely to say "don't do this" — a
 * test that a comment can fail is a test people learn to work around.
 *
 * Only block comments and comment-ONLY lines are removed: stripping from any
 * `//` to end-of-line would also eat the tail of any line holding an `https://`
 * URL, and silently deleting real code is the one failure mode a deny-list
 * guard must not have.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

/**
 * The components main.jsx mounts BEFORE <App/> — i.e. the ones that render for a
 * visitor with no session. Derived from main.jsx rather than hardcoded, so a new
 * public route is covered the day it is added.
 */
function publicPageFiles() {
  const mounted = [...mainJsx.matchAll(/publicView\s*=\s*<([A-Z][A-Za-z0-9_]*)/g)].map(m => m[1])
  const imports = new Map(
    [...mainJsx.matchAll(/import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+'\.\/pages\/([^']+)'/g)]
      .map(m => [m[1], m[2]])
  )
  const files = [...new Set(mounted)].map(name => imports.get(name)).filter(Boolean)
  return files.map(f => {
    const raw = readFileSync(pagesDir + f, 'utf8')
    return { file: f, src: stripComments(raw), raw }
  })
}

describe('public pages never read RLS-closed tables with the anon key', () => {
  const pages = publicPageFiles()

  it('discovers the public pages from main.jsx', () => {
    // If this drops to nothing, the regex above has drifted from main.jsx and
    // every assertion below would be vacuously passing.
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.map(p => p.file)).toContain('LandingProperty.jsx')
  })

  for (const table of CLOSED_TO_ANON) {
    it(`no public page calls supabase.from('${table}')`, () => {
      const offenders = pages
        .filter(p => new RegExp(`supabase\\s*\\n?\\s*\\.from\\(\\s*['"\`]${table}['"\`]`, 'm').test(p.src))
        .map(p => p.file)
        .filter(file => !KNOWN_BROKEN.has(`${file}:${table}`))

      expect(offenders,
        `${offenders.join(', ')} read '${table}' with the anon key. Migration 0027 ` +
        `closed it to anon, so this returns ZERO ROWS in production and the page ` +
        `renders its not-found state. Read it through a service-key endpoint in ` +
        `api/ instead — see src/lib/publicMailing.js.`).toEqual([])
    })
  }

  it('every KNOWN_BROKEN entry is still actually broken', () => {
    // A stale exemption is how a deny-list quietly stops denying. When someone
    // fixes one of these, this fails and tells them to delete the entry.
    for (const entry of KNOWN_BROKEN) {
      const [file, table] = entry.split(':')
      const page = pages.find(p => p.file === file)
      expect(page, `KNOWN_BROKEN names ${file}, which is no longer a public page — remove the entry`).toBeTruthy()
      expect(page.src,
        `${file} no longer reads '${table}' with the anon key — it has been fixed. ` +
        `Delete "${entry}" from KNOWN_BROKEN so the guard protects it from now on.`)
        .toMatch(new RegExp(`supabase\\s*\\n?\\s*\\.from\\(\\s*['"\`]${table}['"\`]`, 'm'))
    }
  })

  it('the four /lp/* pages go through the shared service-key helper', () => {
    for (const file of ['LandingProperty.jsx', 'LandingValuation.jsx',
                        'LandingMultifamily.jsx', 'LandingMailing.jsx']) {
      const page = pages.find(p => p.file === file)
      expect(page, `${file} is no longer mounted by main.jsx`).toBeTruthy()
      expect(page.src, `${file} must fetch its mailing via fetchPublicMailing`)
        .toMatch(/fetchPublicMailing\(/)
    }
  })

  it('reading agents through the column-limited view is still allowed', () => {
    // agents_public is granted to anon on purpose (0027 §4) — the advisor cards
    // need it. This asserts the guard above does not overreach into it.
    const usesView = pages.filter(p => /supabase\.from\('agents_public'\)/.test(p.src))
    expect(usesView.length).toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.src, `${p.file} must use agents_public, not agents`)
        .not.toMatch(/supabase\s*\n?\s*\.from\(\s*'agents'\s*\)/)
    }
  })
})
