import { useCallback, useMemo } from 'react'
import type { Snapshot } from '../types'
import { isPhase } from '../types'
import type { BoardLane } from './boardLane'
import { stageCounts, type WbStepDef, type WbWorkflowDef } from './workbenchDefinition'

type Tr = (key: string, vars?: Record<string, string | number>) => string

export function useWorkbenchBoard({
  def,
  defaultWorkflow,
  root,
  snapshot,
  readonlyWorkflow,
  t,
}: {
  def: WbWorkflowDef | null
  defaultWorkflow: boolean
  root: string
  snapshot: Snapshot | null
  readonlyWorkflow: boolean
  t: Tr
}): {
  boardLanes: BoardLane[]
  summary: { stages: number; gates: number; skills: number; hooks: number | null } | null
} {
  const stepName = useCallback(
    (step: WbStepDef): string => (defaultWorkflow && isPhase(step.id) ? t(`phases.${step.id}`) : step.label || step.id),
    [defaultWorkflow, t],
  )
  const ambientByStage = useMemo(
    () => (def ? stageCounts(snapshot, root, def.name) : {}),
    [def, snapshot, root],
  )
  const boardLanes: BoardLane[] = useMemo(() => {
    if (!def) return []
    return def.steps.map((step, index) => {
      const next = def.steps[index + 1]
      const forward = next ? step.transitions.find((transition) => transition.to === next.id) : undefined
      const ambient = ambientByStage[step.id]
      return {
        id: step.id,
        name: stepName(step),
        gate: step.gate,
        skills: readonlyWorkflow ? undefined : [...new Set(step.skills.map((skill) => skill.id))],
        skillDeps: readonlyWorkflow
          ? undefined
          : Object.fromEntries(
              step.skills.map((skill) => {
                const inLane = new Set(step.skills.map((candidate) => candidate.id))
                return [skill.id, (skill.depends_on ?? []).filter((dependency) => inLane.has(dependency))]
              }),
            ),
        outputs: step.outputs.map((output) => output.field),
        nonemptyGuard: readonlyWorkflow ? undefined : step.guards.some((guard) => guard.type === 'nonempty-output'),
        linkEvent: forward?.event ?? null,
        count: ambient?.count ?? 0,
        running: ambient?.running ?? false,
      }
    })
  }, [def, stepName, ambientByStage, readonlyWorkflow])
  const summary = useMemo(() => {
    if (!def) return null
    const skillIds = new Set<string>()
    for (const step of def.steps) {
      for (const skill of step.skills) skillIds.add(skill.id)
    }
    return {
      stages: def.steps.length,
      gates: def.steps.filter((step) => step.gate !== null).length,
      skills: skillIds.size,
      hooks: null,
    }
  }, [def])
  return { boardLanes, summary }
}
