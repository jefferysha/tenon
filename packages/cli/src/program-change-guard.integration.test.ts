/**
 * 真实 e2e —— 作用于既有 change 的命令遇到不存在的 change：与 status/get 同一句
 * `ERROR: change 不存在: <name>`、exit 1，绝不泄漏 `.pipeline.yaml` / `.pipeline.lock.claim-*` 路径。
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { freshHarness, rm, type Harness } from './integration-harness.js'

describe('unknown change name → change 不存在', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  const argvs: ReadonlyArray<readonly string[]> = [
    ['set', 'foo', 'plan', 'x.md'],
    ['set-many', 'foo', 'plan=x.md'],
    ['transition', 'foo', 'open-complete'],
    ['check', 'foo'],
    ['advance', 'foo'],
    ['handoff', 'foo'],
    ['test', 'run', 'foo', 't1'],
    ['test', 'status', 'foo'],
    ['agent', 'next', 'foo'],
    ['agent', 'prompt', 'foo', 'reviewer'],
    ['workflow', 'plan', 'foo'],
    ['document', 'status', 'foo'],
  ]

  for (const argv of argvs) {
    test(argv.join(' '), async () => {
      expect(await h.run([...argv])).toBe(1)
      const err = h.err.join('\n')
      expect(err).toContain('ERROR: change 不存在: foo')
      expect(err).not.toMatch(/ENOENT|\.pipeline\.yaml|\.pipeline\.lock/u)
      expect(existsSync(join(h.cwd, 'openspec', 'changes', 'foo'))).toBe(false)
    })
  }

  test('an existing change is not affected by the guard', async () => {
    expect(await h.run(['init', 'real', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['check', 'real'])).not.toBe(1)
    expect(h.err.join('\n')).not.toContain('change 不存在')
  })
})
