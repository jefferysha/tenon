/**
 * `.codex-plugin/plugin.json` 的 defaultPrompt 是用户在 Codex 里看到的起手提示：它得描述今天的模型
 * （任务按冻结的工作流逐步执行，下一步看 `tenon status`），而不是早已改掉的「默认 pipeline 的阶段 / change」
 * （产品评估 P2）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

interface CodexManifest { readonly interface?: { readonly defaultPrompt?: readonly string[] } }

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '.codex-plugin', 'plugin.json'), 'utf8')) as CodexManifest

describe('.codex-plugin defaultPrompt', () => {
  const prompts = manifest.interface?.defaultPrompt ?? []

  test('至多三条、每条一句短话', () => {
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.length).toBeLessThanOrEqual(3)
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThanOrEqual(128)
      expect(prompt).not.toMatch(/\n/u)
    }
  })

  test('描述任务与下一步，不再提「默认 pipeline change / 阶段 / 记录 OpenSpec 输出」', () => {
    const text = prompts.join('\n')
    expect(text).toMatch(/task/iu)
    expect(text).toMatch(/next step/iu)
    expect(text).not.toMatch(/default pipeline|pipeline phase|pipeline change|record its OpenSpec outputs/iu)
  })
})
