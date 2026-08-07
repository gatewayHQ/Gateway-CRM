// React plumbing for per-agent pipeline column headers.
//
// App resolves the signed-in agent's overrides once and provides the finished
// map here; every screen that prints a stage name reads it with useStageLabels()
// instead of importing STAGE_LABELS directly. That way a column renamed on the
// board reads the same on the deal page, the dashboard funnel, and the deal
// drawer's stage picker — one rename, one vocabulary.
//
// Default value is the built-in map, so a component rendered outside the
// provider (tests, the public landing pages) still shows correct labels.
import { createContext, useContext } from 'react'
import { STAGE_LABELS } from './stages.js'

export const StageLabelContext = createContext(STAGE_LABELS)

export function useStageLabels() {
  return useContext(StageLabelContext)
}
