/**
 * `tenon check` 的唯一渲染出口。
 *
 * default 轨与 step-graph 轨此前各抄一份「打表头 → 全过就 PASS → 否则逐类 [FAIL] → 统计行」，
 * 两份必须字字相同才不会让用户看到两套口径；每加一类证据（技能门就是最近一例）都要改两处，
 * 漏改一处就是一条静默的假绿。现在两轨都调这一个函数，分类顺序与计数只有一处定义。
 */
import type { CliDeps } from '../deps.js'

/** 各类证据的未通过项；顺序即渲染顺序。空数组 = 该类全过或本轨不适用。 */
export interface CheckSections {
  readonly warnings?: readonly string[]
  readonly guards: readonly string[]
  readonly revision?: readonly string[]
  readonly documents: readonly string[]
  readonly skills: readonly string[]
  readonly tests: readonly string[]
  readonly agents: readonly string[]
  readonly migration?: string | undefined
}

/** 人读报告 + 退出码：全过 0 / 有未通过项 2（CONTRACT §3）。 */
export function renderCheckReport(
  deps: CliDeps,
  name: string,
  phase: string,
  sections: CheckSections,
): number {
  deps.io.out(`[CHECK] ${name} (phase=${phase})`)
  for (const warning of sections.warnings ?? []) deps.io.out(`  [WARN] ${warning}`)

  const groups: readonly (readonly [string, readonly string[]])[] = [
    ['', sections.guards],
    ['', sections.revision ?? []],
    ['document: ', sections.documents],
    ['skill: ', sections.skills],
    ['test: ', sections.tests],
    ['agent: ', sections.agents],
    ['migration: ', sections.migration === undefined ? [] : [sections.migration]],
  ]
  const total = groups.reduce((sum, [, lines]) => sum + lines.length, 0)
  if (total === 0) {
    deps.io.out('  [PASS] 所有检查通过')
    return 0
  }
  for (const [prefix, lines] of groups) {
    for (const line of lines) deps.io.out(`  [FAIL] ${prefix}${line}`)
  }
  deps.io.out(`  [FAIL] 共 ${total} 项未通过`)
  return 2
}
