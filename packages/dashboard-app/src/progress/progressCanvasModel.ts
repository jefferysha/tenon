import type { WorkflowRules } from '../model/workflowModel'
import type {
  ProgressRow,
  ProgressRules,
  ProgressSelection,
} from '../model/progressModel'
import { executionProvenance } from '../model/progressModel'
import type {
  CanvasArchivedChange,
  CanvasChange,
  CanvasDotTone,
  CanvasGroup,
  CanvasStep,
} from './WorkflowCanvas'
import {
  compareArchived,
  deckMatch,
  inSandbox,
  rootBasename,
  rowKeyOf,
  stepLabel,
  toFlatRow,
  type DeckTab,
  type FlatRow,
} from './progressViewModel'

export interface CanvasProjectionOptions {
  selection: ProgressSelection
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  rowsByKey: ReadonlyMap<string, FlatRow>
  workflowFilter: string
  deckTab: DeckTab
  selectedKey: string | null
  t: (key: string, vars?: Record<string, string | number>) => string
  dotOf: (row: FlatRow) => { state: string; tone: CanvasDotTone }
  statusOf: (row: FlatRow) => string
}

function isLinear(rules: ProgressRules | undefined): boolean {
  if (!rules) return false
  return rules.steps.every((id) => {
    const outgoing = rules.transitions[id] ?? []
    const incoming = rules.steps.reduce(
      (count, from) => count + (rules.transitions[from] ?? []).filter((edge) => edge.to === id).length,
      0,
    )
    return outgoing.length <= 1 && incoming <= 1
  })
}

export function buildCanvasGroups({
  selection,
  rulesByKey: _rulesByKey,
  rowsByKey,
  workflowFilter,
  deckTab,
  selectedKey,
  t,
  dotOf,
  statusOf,
}: CanvasProjectionOptions): CanvasGroup[] {
  const groups: CanvasGroup[] = []
  for (const group of selection.groups) {
    if (group.rows.length === 0) continue
    if (workflowFilter !== 'all' && group.workflow !== workflowFilter) continue
    const rules = group.rules
    const stepIds = rules ? [...rules.steps] : []
    for (const row of [...group.rows, ...group.archived]) {
      if (!stepIds.includes(row.change.phase)) stepIds.push(row.change.phase)
    }
    if (stepIds.length === 0) continue
    const archivedByPhase = new Map<string, ProgressRow[]>()
    for (const row of group.archived) {
      archivedByPhase.set(row.change.phase, [...(archivedByPhase.get(row.change.phase) ?? []), row])
    }
    // Derive every stage from the live change phase. Todo stage metadata is optional and
    // frequently absent for older changes, so it must not collapse the whole track into
    // "pending". A stage is current when a change is in it, done when all active changes
    // have moved beyond it, and pending when work has not reached it yet.
    const phaseIndex = new Map(stepIds.map((id, index) => [id, index]))
    const activePhaseIndexes = group.rows
      .map((row) => phaseIndex.get(row.change.phase))
      .filter((index): index is number => index !== undefined)
    const steps: CanvasStep[] = stepIds.map((id) => {
      const archivedRows = [...(archivedByPhase.get(id) ?? [])]
        .sort((left, right) => compareArchived(left.change, right.change))
      const archivedChanges: CanvasArchivedChange[] = archivedRows.map((row) => {
        const flat = toFlatRow(row, rules, group.workflow)
        const dot = dotOf(flat)
        return { key: flat.key, name: row.change.name, tone: dot.tone, state: dot.state }
      })
      const index = phaseIndex.get(id) ?? 0
      const state: CanvasStep['state'] = activePhaseIndexes.some((phase) => phase === index)
        ? 'current'
        : activePhaseIndexes.length > 0 && activePhaseIndexes.every((phase) => phase > index)
          ? 'done'
          : 'pending'
      return {
        id,
        label: stepLabel(id, rules, t),
        gate: rules?.gateByStep[id] ?? null,
        archived: archivedChanges.length,
        archivedChanges,
        state,
      }
    })
    const changes: CanvasChange[] = group.rows.flatMap((row) => {
      const flat = rowsByKey.get(rowKeyOf(row.root, row.change.name))
      if (!flat) return []
      const dot = dotOf(flat)
      return [{
        key: flat.key,
        name: row.change.name,
        phase: row.change.phase,
        state: dot.state,
        tone: dot.tone,
        running: row.state === 'running',
        executionSource: executionProvenance(row.change),
        sandbox: inSandbox(flat),
        dimmed: deckTab !== 'all' && !deckMatch(flat, deckTab),
        selected: selectedKey === flat.key,
        statusLabel: statusOf(flat),
      }]
    })
    const groupKey = `${group.root}::${group.workflow}`
    const existing = groups.find((candidate) => candidate.key === groupKey)
    if (existing) {
      const known = new Set(existing.changes.map((change) => change.key))
      existing.changes = [...existing.changes, ...changes.filter((change) => !known.has(change.key))]
      continue
    }
    groups.push({
      key: groupKey,
      projName: rootBasename(group.root),
      workflow: group.workflow,
      steps,
      changes,
      linearProgress: isLinear(rules),
    })
  }
  return groups
}
