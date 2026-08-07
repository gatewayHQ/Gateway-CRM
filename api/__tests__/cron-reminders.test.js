// ─────────────────────────────────────────────────────────────────────────────
// Deadline engine — stage coverage and notification channels.
//
// Two bugs this locks down:
//   1. ACTIVE_STAGES was hand-listed as
//      ['lead','qualified','showing','offer','under-contract'], omitting all
//      seven commercial stages and both residential-seller stages. Gateway is a
//      commercial multifamily brokerage, so the deadline engine was blind to
//      most of the pipeline while reporting success.
//   2. The reminder SMS was addressed to `contact.phone` — the CLIENT — with an
//      internal "log in to review your deal" body.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ALL_DEAL_STAGES, isOpenStage } from '../../src/lib/stages.js'

const cronSrc = readFileSync(
  fileURLToPath(new URL('../cron.js', import.meta.url)),
  'utf8'
)

// Comments legitimately mention the old SMS path (that's why it's documented).
// Assertions about what the code DOES must run against code only.
const cronCode = cronSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/^[ \t]*\/\/.*$/gm, '')    // whole-line comments

const COMMERCIAL_STAGES = [
  'pursuit', 'om-marketing', 'listing-agreement', 'on-market',
  'loi', 'psa', 'due-diligence',
]
const SELLER_STAGES = ['pre-list', 'active']

describe('deadline engine — stage coverage', () => {
  const openStages = ALL_DEAL_STAGES.filter(isOpenStage)

  it('covers every commercial stage', () => {
    for (const stage of COMMERCIAL_STAGES) {
      expect(openStages, `commercial stage "${stage}" must produce reminders`).toContain(stage)
    }
  })

  it('covers both residential-seller stages', () => {
    for (const stage of SELLER_STAGES) {
      expect(openStages, `seller stage "${stage}" must produce reminders`).toContain(stage)
    }
  })

  it('covers every in-flight stage in the registry', () => {
    const missing = ALL_DEAL_STAGES.filter(isOpenStage).filter(s => !openStages.includes(s))
    expect(missing).toEqual([])
  })

  it('excludes terminal stages — closed and lost never need a deadline chase', () => {
    expect(openStages).not.toContain('closed')
    expect(openStages).not.toContain('lost')
  })

  it('derives the stage list from the registry instead of hand-listing it', () => {
    // The specific regression: a literal array of only the legacy residential
    // tokens. Deriving from ALL_DEAL_STAGES means a new stage is covered for
    // free; a hand-listed array silently drops it.
    expect(cronCode).toMatch(/const OPEN_STAGES = ALL_DEAL_STAGES\.filter\(isOpenStage\)/)
    expect(cronCode).not.toMatch(
      /ACTIVE_STAGES\s*=\s*\[\s*'lead',\s*'qualified',\s*'showing',\s*'offer',\s*'under-contract'\s*\]/
    )
  })

  it('applies the same coverage to the nudge sweep', () => {
    expect(cronCode).toMatch(/const OPEN_STAGES_FOR_NUDGES = OPEN_STAGES/)
  })
})

describe('deadline engine — notification channels', () => {
  it('sends no SMS at all', () => {
    expect(cronCode).not.toMatch(/api\.twilio\.com/)
    expect(cronCode).not.toMatch(/function sendSms/)
    expect(cronCode).not.toMatch(/TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN/)
  })

  it('never addresses a notification to a contact phone number', () => {
    // The exact shape of the old bug: a send whose recipient was contact.phone.
    expect(cronCode).not.toMatch(/contact\?\.phone/)
    expect(cronCode).not.toMatch(/contact\.phone/)
  })

  it('emails the assigned agent', () => {
    expect(cronCode).toMatch(/sendResend\(resendKey, resendFrom, agent\.email/)
    expect(cronCode).toMatch(/channel: 'email:agent'/)
  })

  it('also writes an in-app notification to the assigned agent', () => {
    expect(cronCode).toMatch(/channel: 'inapp:agent'/)
    // Keyed to agent.id, not the contact — the whole point of the fix.
    expect(cronCode).toMatch(/agent_id:\s*agent\.id/)
  })
})
