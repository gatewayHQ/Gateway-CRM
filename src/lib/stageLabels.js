// ─────────────────────────────────────────────────────────────────────────────
// Per-agent pipeline column headers.
//
// Agents don't all speak the same dialect. "Qualified" means something precise
// to one advisor and nothing to the next; a commercial broker wants "LOI Out"
// where the board says "Offer". Renaming the column is a *display* preference,
// so this layer never touches data:
//
//   • `deals.stage` keeps its canonical token forever (the CHECK constraint,
//     automations, reports, and the client portal all key off it).
//   • An override is a label the agent typed for a token they already have.
//     Delete the override and the default label comes straight back.
//   • Overrides are personal — stored on `agents.stage_labels`, so one agent
//     renaming a column can never change what a teammate sees.
//
// Everything here is pure — no React — so the same normalization runs in the
// browser and inside api/portal.js, which re-normalizes rather than trusting
// the client. The React plumbing lives in ./stageLabelContext.js.
// ─────────────────────────────────────────────────────────────────────────────
import { STAGE_LABELS, ALL_DEAL_STAGES } from './stages.js'

// Long enough for "Listing Agreement"; short enough that a renamed column still
// fits the 240px board column without wrapping into the card area.
export const STAGE_LABEL_MAX = 22

// Normalize whatever the agent typed into a storable label, or null when the
// entry should be treated as "no override" (blank, whitespace, or identical to
// the built-in label — storing those would just be noise that blocks a reset).
export function normalizeStageLabel(stage, value) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, STAGE_LABEL_MAX)
  if (!clean) return null
  if (clean === STAGE_LABELS[stage]) return null
  return clean
}

// Normalize a whole override map. Unknown stage tokens are dropped — a renamed
// column must correspond to a stage that actually exists, otherwise a typo (or
// a malicious client) could pack arbitrary JSON onto the agent row.
export function normalizeStageLabels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const stage of ALL_DEAL_STAGES) {
    if (!(stage in raw)) continue
    const label = normalizeStageLabel(stage, raw[stage])
    if (label) out[stage] = label
  }
  return out
}

// The full label map an agent sees: defaults with their overrides layered on.
export function resolveStageLabels(overrides) {
  return { ...STAGE_LABELS, ...normalizeStageLabels(overrides) }
}

// One stage's label. Falls back to the raw token so an unrecognized legacy
// stage still renders as something rather than blank.
export function resolveStageLabel(stage, overrides) {
  return normalizeStageLabels(overrides)[stage] || STAGE_LABELS[stage] || stage
}

// True when the agent has renamed at least one column (drives "Reset headers").
export const hasStageLabelOverrides = (overrides) =>
  Object.keys(normalizeStageLabels(overrides)).length > 0
