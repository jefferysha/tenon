/**
 * Pipeline Todo projection.
 *
 * This module projects trusted canonical or legacy `tasks.md` checkbox rows onto the workflow's
 * ordered stages. Canonical TaskPlan current state remains authoritative when present; `tasks.md`
 * is then its compatibility projection. A native Todo or dashboard can keep the seven pipeline
 * phases visible without inventing generic work items. The projection stays pure and accepts custom
 * workflow stage definitions as data.
 */
import { DEFAULT_WORKFLOW_STEPS } from './default-workflow.generated.js'

export type PipelineTodoStageStatus = 'done' | 'current' | 'pending'

export interface PipelineTodoStageDefinition {
  readonly id: string
  readonly label: string
  /** Optional graph edges. When present, completion is inferred by dominance instead of array order. */
  readonly transitions?: readonly string[]
}

export interface PipelineTodoItem {
  readonly text: string
  readonly completed: boolean
}

export interface PipelineTodoStage extends PipelineTodoStageDefinition {
  readonly status: PipelineTodoStageStatus
  readonly tasks: readonly PipelineTodoItem[]
}

export interface PipelineTodoProjection {
  /** false means tasks.md was absent/unreadable; the phase skeleton is still truthful. */
  readonly hasTaskSource: boolean
  readonly stages: readonly PipelineTodoStage[]
}

export const DEFAULT_WORKFLOW_TODO_STAGES: readonly PipelineTodoStageDefinition[] = DEFAULT_WORKFLOW_STEPS.map(
  (step) => ({ id: step.id, label: step.label }),
)

function definitelyCompletedStageIds(
  stages: readonly PipelineTodoStageDefinition[],
  currentStage: string,
): ReadonlySet<string> | undefined {
  if (!stages.some((stage) => stage.transitions !== undefined)) return undefined
  const ids = stages.map((stage) => stage.id)
  const all = new Set(ids)
  const entry = ids[0]
  if (entry === undefined || !all.has(currentStage)) return new Set()
  const predecessors = new Map(ids.map((id) => [id, [] as string[]]))
  for (const stage of stages) {
    for (const target of stage.transitions ?? []) {
      const incoming = predecessors.get(target)
      if (incoming) incoming.push(stage.id)
    }
  }
  const dominators = new Map<string, Set<string>>()
  for (const id of ids) dominators.set(id, id === entry ? new Set([id]) : new Set(all))
  let changed = true
  while (changed) {
    changed = false
    for (const id of ids) {
      if (id === entry) continue
      const incoming = predecessors.get(id) ?? []
      const next = incoming.length === 0
        ? new Set([id])
        : new Set([...all].filter((candidate) => incoming.every((from) => dominators.get(from)?.has(candidate))))
      next.add(id)
      const prior = dominators.get(id)!
      if (next.size !== prior.size || [...next].some((candidate) => !prior.has(candidate))) {
        dominators.set(id, next)
        changed = true
      }
    }
  }
  const completed = new Set(dominators.get(currentStage) ?? [])
  completed.delete(currentStage)
  return completed
}

function normalized(value: string): string {
  return value
    .trim()
    .replace(/^\d+\s*[.)、:：-]\s*/, '')
    .replace(/^phase\s+/i, '')
    .toLocaleLowerCase()
}

function stageForHeading(heading: string, stages: readonly PipelineTodoStageDefinition[]): string | undefined {
  const candidate = normalized(heading)
  for (const stage of stages) {
    const id = normalized(stage.id)
    const label = normalized(stage.label)
    if (candidate === id || candidate === label) return stage.id
    if (candidate.startsWith(`${id} `) || candidate.endsWith(` ${id}`)) return stage.id
    if (candidate.startsWith(`${label} `) || candidate.endsWith(` ${label}`)) return stage.id
  }
  return undefined
}

function parseTasks(
  markdown: string | undefined,
  currentStage: string,
  stages: readonly PipelineTodoStageDefinition[],
  trustedCanonicalProjection = false,
): {
  readonly byStage: ReadonlyMap<string, readonly PipelineTodoItem[]>
  readonly structured: boolean
} {
  const byStage = new Map<string, PipelineTodoItem[]>()
  if (markdown === undefined) return { byStage, structured: false }
  let target = stages.some((stage) => stage.id === currentStage) ? currentStage : stages[0]?.id
  let structured = false
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      if (trustedCanonicalProjection && /\s+<!-- task-group:[^>]+ -->\s*$/u.test(heading[1] ?? '')) continue
      const headingStage = stageForHeading(heading[1] ?? '', stages)
      if (headingStage !== undefined) {
        target = headingStage
        structured = true
      }
      continue
    }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line)
    if (!task || target === undefined) continue
    const rawText = (task[2] ?? '').trim()
    const text = trustedCanonicalProjection
      ? rawText.replace(/\s+<!-- work-item:[^>\s]+ -->\s*$/u, '').trim()
      : rawText
    if (text === '') continue
    const items = byStage.get(target) ?? []
    items.push({ text, completed: (task[1] ?? '').toLowerCase() === 'x' })
    byStage.set(target, items)
  }
  return { byStage, structured }
}

/**
 * Project a tasks.md text onto ordered workflow stages. Checklist rows below an unrecognised heading
 * stay on the current phase rather than disappearing; recognised `## Open`/`## 立项` style headings
 * select their matching stage. Earlier phases are complete because the state machine reached a later
 * phase, not because every historical checkbox happened to be manually toggled.
 */
export function projectPipelineTodo(input: {
  readonly phase: string
  readonly tasksMarkdown: string | undefined
  readonly stages?: readonly PipelineTodoStageDefinition[]
  readonly additionalItemsByStage?: Readonly<Record<string, readonly PipelineTodoItem[]>>
  readonly trustedCanonicalProjection?: boolean
}): PipelineTodoProjection {
  const declared = input.stages ?? DEFAULT_WORKFLOW_TODO_STAGES
  const stages = declared.filter((stage, index) =>
    stage.id !== '' && stage.label !== '' && declared.findIndex((other) => other.id === stage.id) === index,
  )
  const currentIndex = stages.findIndex((stage) => stage.id === input.phase)
  const definitelyCompleted = definitelyCompletedStageIds(stages, input.phase)
  const tasks = parseTasks(
    input.tasksMarkdown,
    input.phase,
    stages,
    input.trustedCanonicalProjection,
  ).byStage
  return {
    hasTaskSource: input.tasksMarkdown !== undefined,
    stages: stages.map((stage, index) => ({
      id: stage.id,
      label: stage.label,
      status: currentIndex === -1
        ? 'pending'
        : stage.id === input.phase
          ? 'current'
          : (definitelyCompleted?.has(stage.id) ?? index < currentIndex)
            ? 'done'
            : 'pending',
      tasks: [
        ...(input.additionalItemsByStage?.[stage.id] ?? []),
        ...(tasks.get(stage.id) ?? []),
      ],
    })),
  }
}

/**
 * Count unfinished tasks that are due by the requested phase. Future-stage
 * checkboxes remain visible in the seven-stage Todo projection, but cannot
 * block an earlier phase exit.
 *
 * Legacy files without recognised phase headings retain their historical
 * compatibility rule: their whole checklist belongs to build.
 */
export function incompletePipelineTasksForExit(input: {
  readonly phase: string
  readonly tasksMarkdown: string
  readonly stages?: readonly PipelineTodoStageDefinition[]
  readonly trustedCanonicalProjection?: boolean
}): {
  readonly structured: boolean
  readonly incomplete: number
  /** 未勾项的文本，按 tasks.md 中的顺序；`incomplete === items.length`。 */
  readonly items: readonly string[]
} {
  const declared = input.stages ?? DEFAULT_WORKFLOW_TODO_STAGES
  const stages = declared.filter((stage, index) =>
    stage.id !== '' && stage.label !== '' && declared.findIndex((other) => other.id === stage.id) === index,
  )
  const parsed = parseTasks(
    input.tasksMarkdown,
    input.phase,
    stages,
    input.trustedCanonicalProjection,
  )

  if (!parsed.structured) {
    const items = input.phase === 'build'
      ? [...parsed.byStage.values()].flat().filter((task) => !task.completed).map((task) => task.text)
      : []
    return { structured: false, incomplete: items.length, items }
  }

  const phaseIndex = stages.findIndex((stage) => stage.id === input.phase)
  if (phaseIndex < 0) return { structured: true, incomplete: 0, items: [] }

  const items = stages
    .slice(0, phaseIndex + 1)
    .flatMap((stage) => parsed.byStage.get(stage.id) ?? [])
    .filter((task) => !task.completed)
    .map((task) => task.text)
  return { structured: true, incomplete: items.length, items }
}
