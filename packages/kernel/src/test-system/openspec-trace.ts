/**
 * 追溯矩阵的两类源头（纯函数）：
 *   · OpenSpec delta spec（`openspec/changes/<c>/specs/<capability>/spec.md`）里的 `#### Scenario:`；
 *     `## REMOVED Requirements` 下的场景不需要测试覆盖，不产出。
 *   · tasks.md 的勾选条目。条目自带编号（`- [ ] 2.3 …`）时用它；否则按「第几个 `##` 小节 . 小节内第几条」
 *     派生（`task:4.2`），Tenon 的按阶段 tasks.md 与 OpenSpec 的编号 tasks.md 都能引用。
 *
 * 哪些条目要求映射用例（`required`）：场景一律要；tasks.md 里只有「实现」阶段小节下、且不是骨架提示词的条目要。
 * 其余阶段的小节（立项 / 调研 / 规格 / 验证 / 交付 / 完结）里作者写的条目照样进矩阵与报告，但只是可选，绝不出阻塞。
 * 骨架提示词（「将本阶段目标拆成可验证任务」，`document scaffold` 每个阶段铺一行）不是任务，不产出条目——
 * 计划初稿、追溯矩阵与报告里都不会再出现这些占位行；条目编号仍按它们占位的序号数，作者把占位行改写成真任务时编号不变。
 * 阶段小节的识别与 Todo 投影同一份（标题的 id 或名称）；
 * 整份 tasks.md 没有任何可识别的阶段小节时，沿用 Todo 的历史口径：整份清单都算实现阶段。
 */
import { findDocumentPlaceholders } from '../documents/document-placeholders.js'
import { DEFAULT_WORKFLOW_TODO_STAGES, stageIdForHeading, type PipelineTodoStageDefinition } from '../workflow/todo-projection.js'
import { scenarioCoversKey, taskCoversKey } from './covers.js'

/** 实现阶段的 id：tasks.md 里这个阶段小节下的条目才要求映射用例，其余阶段的条目可选、不挡。 */
export const TRACE_TASK_STAGE = 'build'

export type DeltaSection = 'added' | 'modified' | 'removed' | 'renamed'

export interface OpenSpecScenario {
  readonly capability: string
  readonly requirement: string | null
  readonly title: string
  readonly section: DeltaSection | null
  readonly line: number
  /** `spec:<capability>/<title>` */
  readonly covers: string
}

export interface TaskItem {
  readonly id: string
  readonly text: string
  readonly done: boolean
  readonly line: number
  /** `task:<id>` */
  readonly covers: string
  /** 所在的阶段小节 id；开头没有可识别的阶段小节时 null。 */
  readonly stage: string | null
  /** 要求映射用例：实现阶段小节里的条目。false = 可选（其余阶段小节），不挡。 */
  readonly required: boolean
}

function stripFences(lines: readonly string[]): (string | undefined)[] {
  let fence: string | undefined
  return lines.map((line) => {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (fence === marker) fence = undefined
      return undefined
    }
    return fence === undefined ? line : undefined
  })
}

export function extractScenarios(capability: string, markdown: string): readonly OpenSpecScenario[] {
  const out: OpenSpecScenario[] = []
  const seen = new Set<string>()
  let section: DeltaSection | null = null
  let requirement: string | null = null
  stripFences(markdown.split('\n')).forEach((raw, index) => {
    if (raw === undefined) return
    const line = raw.replace(/\r$/, '')
    const delta = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i.exec(line)?.[1]
    if (delta !== undefined) {
      section = delta.toLowerCase() as DeltaSection
      requirement = null
      return
    }
    const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line)?.[1]
    if (req !== undefined) { requirement = req; return }
    const title = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line)?.[1]
    if (title === undefined || section === 'removed') return
    const covers = scenarioCoversKey(capability, title)
    if (seen.has(covers)) return
    seen.add(covers)
    out.push({ capability, requirement, title, section, line: index + 1, covers })
  })
  return out
}

export function extractTaskItems(
  markdown: string,
  stages: readonly PipelineTodoStageDefinition[] = DEFAULT_WORKFLOW_TODO_STAGES,
): readonly TaskItem[] {
  const found: { readonly item: Omit<TaskItem, 'required'>; readonly placeholder: boolean }[] = []
  const seen = new Set<string>()
  let section = 0
  let inSection = 0
  let stage: string | null = null
  let structured = false
  const lines = markdown.split('\n')
  stripFences(lines).forEach((raw, index) => {
    if (raw === undefined) return
    const line = raw.replace(/\r$/, '')
    if (/^##\s+/.test(line)) {
      section++
      inSection = 0
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]
    if (heading !== undefined) {
      // 规范投影里的分组标题（`<!-- task-group:x -->`）在阶段小节之内，不改阶段。
      const recognised = /<!-- task-group:[^>]+ -->\s*$/u.test(heading) ? undefined : stageIdForHeading(heading, stages)
      if (recognised !== undefined) {
        stage = recognised
        structured = true
      }
      return
    }
    const item = /^\s*[-*]\s+\[([ xX])\]\s+(.*?)\s*$/.exec(line)
    if (item === null) return
    inSection++
    const body = item[2] ?? ''
    const numbered = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(body)
    const id = numbered?.[1] ?? `${section}.${inSection}`
    if (seen.has(id)) return
    seen.add(id)
    found.push({
      item: { id, text: numbered?.[2] ?? body, done: item[1] !== ' ', line: index + 1, covers: taskCoversKey(id), stage },
      placeholder: findDocumentPlaceholders(line).length > 0,
    })
  })
  // 没有任何可识别的阶段小节：整份清单归实现阶段（Todo 投影同一口径）。骨架提示词不是任务，丢掉。
  return found.filter(({ placeholder }) => !placeholder).map(({ item }) => {
    const owner = structured ? item.stage : TRACE_TASK_STAGE
    return { ...item, stage: owner, required: owner === TRACE_TASK_STAGE }
  })
}
