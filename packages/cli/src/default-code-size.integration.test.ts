import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

interface FrozenTest { readonly id: string; readonly pass?: { readonly metrics?: readonly { readonly name: string; readonly max?: number }[] } }

/** 冻结计划里逐步骤的内联测试（不同快照版本把它放在 steps 或 tracks 分支里，这里只按结构找）。 */
function inlineTests(value: unknown, found: FrozenTest[] = []): FrozenTest[] {
  if (Array.isArray(value)) {
    for (const item of value) inlineTests(item, found)
    return found
  }
  if (typeof value !== 'object' || value === null) return found
  const record = value as Record<string, unknown>
  if (record.direction === 'code-size' && typeof record.id === 'string') found.push(record as unknown as FrozenTest)
  for (const item of Object.values(record)) inlineTests(item, found)
  return found
}

describe('默认工作流的 code-size 阈值进入冻结计划（真机验收 F11）', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  test('新建 default 任务的冻结计划里 code-size 带 lines_added ≤ 2000', async () => {
    h = await freshHarness()
    expect(await h.run(['init', 'sized', '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
    const plan: unknown = JSON.parse(await readFile(join(h.cwd, 'openspec', 'changes', 'sized', '.pipeline-workflow-plan.json'), 'utf8'))
    const tests = inlineTests(plan)
    expect(tests.length).toBeGreaterThan(0)
    for (const test of tests) expect(test.pass?.metrics, test.id).toEqual([{ name: 'lines_added', max: 2000, better: 'lower' }])
  })
})
