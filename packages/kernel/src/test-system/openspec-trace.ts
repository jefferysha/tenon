/**
 * 追溯矩阵的两类源头（纯函数）：
 *   · OpenSpec delta spec（`openspec/changes/<c>/specs/<capability>/spec.md`）里的 `#### Scenario:`；
 *     `## REMOVED Requirements` 下的场景不需要测试覆盖，不产出。
 *   · tasks.md 的勾选条目。条目自带编号（`- [ ] 2.3 …`）时用它；否则按「第几个 `##` 小节 . 小节内第几条」
 *     派生（`task:4.2`），Tenon 的按阶段 tasks.md 与 OpenSpec 的编号 tasks.md 都能引用。
 */
import { scenarioCoversKey, taskCoversKey } from './covers.js'

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

export function extractTaskItems(markdown: string): readonly TaskItem[] {
  const out: TaskItem[] = []
  const seen = new Set<string>()
  let section = 0
  let inSection = 0
  stripFences(markdown.split('\n')).forEach((raw, index) => {
    if (raw === undefined) return
    const line = raw.replace(/\r$/, '')
    if (/^##\s+/.test(line)) {
      section++
      inSection = 0
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
    out.push({ id, text: numbered?.[2] ?? body, done: item[1] !== ' ', line: index + 1, covers: taskCoversKey(id) })
  })
  return out
}
