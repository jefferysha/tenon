/**
 * 随发行版分发的工作流，其步骤测试项要与所引用的测试方向一致。方向是创作模板：字段被整份抄进
 * 步骤 YAML，只写 `direction: code-size` 而不带 `pass.metrics` 的步骤，冻结计划里是
 * `pass: {exit_code: 0, metrics: []}`，2000 行阈值从来不判（真机验收 F11：lines_added 2036 仍 pass）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseTestDirection } from '../test-evidence/direction.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { parseWorkflow } from './parse.js'
import type { StepDef, StepTestDef } from './types.js'

const TEMPLATES = fileURLToPath(new URL('../../../../templates', import.meta.url))

async function directions(): Promise<ReadonlyMap<string, ReturnType<typeof parseTestDirection>>> {
  const dir = join(TEMPLATES, 'test-directions')
  const found = new Map<string, ReturnType<typeof parseTestDirection>>()
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.yaml'))) {
    found.set(basename(name, '.yaml'), parseTestDirection(await readFile(join(dir, name), 'utf8')))
  }
  return found
}

async function shippedSteps(): Promise<readonly { readonly where: string; readonly step: StepDef }[]> {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const found: { where: string; step: StepDef }[] = []
  for (const step of def.steps) found.push({ where: `default/${step.id}`, step })
  for (const [track, branch] of Object.entries(def.tracks ?? {})) {
    for (const step of branch.steps) found.push({ where: `${track}/${step.id}`, step })
  }
  for (const name of (await readdir(join(TEMPLATES, 'workflows'))).filter((file) => file.endsWith('.yaml') && file !== 'default.yaml')) {
    const other = parseWorkflow(await readFile(join(TEMPLATES, 'workflows', name), 'utf8'))
    for (const step of other.steps) found.push({ where: `${name}/${step.id}`, step })
    for (const [track, branch] of Object.entries(other.tracks ?? {})) {
      for (const step of branch.steps) found.push({ where: `${name}/${track}/${step.id}`, step })
    }
  }
  return found
}

describe('发行版工作流的测试项与方向模板一致', () => {
  it('每个带 direction 的步骤测试项都带上方向的命令与通过条件（code-size 的 2000 行阈值进入计划）', async () => {
    const byId = await directions()
    const seen = new Set<string>()
    for (const { where, step } of await shippedSteps()) {
      for (const test of (step.tests ?? []) as readonly StepTestDef[]) {
        const direction = byId.get(test.direction)
        expect(direction, `${where}: 方向 ${test.direction} 不存在`).toBeDefined()
        if (direction === undefined) continue
        seen.add(test.direction)
        expect(test.command, `${where}/${test.id} command`).toBe(direction.command)
        expect(test.pass, `${where}/${test.id} pass`).toEqual(direction.pass)
      }
    }
    expect(seen.has('code-size')).toBe(true)
  })

  it('code-size 测试项：lines_added 上限 2000', async () => {
    let checked = 0
    for (const { step } of await shippedSteps()) {
      for (const test of step.tests ?? []) {
        if (test.direction !== 'code-size') continue
        checked += 1
        expect(test.pass?.metrics).toEqual([{ name: 'lines_added', max: 2000 }])
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4)
  })
})
