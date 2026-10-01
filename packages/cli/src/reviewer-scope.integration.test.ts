/**
 * 评审者按风险挂载（R5）：官方 `security` 声明 `attach_on: [auth, dependency, contract]`，default 工作流的 Verify 要求它，
 * 但只有本任务的改动碰到鉴权 / 依赖 / 契约路径时它才进入评审者集合。
 *
 * 真临时项目 + 真仓库 + 真冻结 agent：`agent next`、`status --json` 的 `step.reviewers` 与 `agent prompt` 是同一份判定。
 */
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const CHANGE = 'scoped'

describe('default 工作流 Verify 的 security 评审者按路径挂载', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  async function project(): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      'package.json': '{ "name": "scoped", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
      'src/add.js': 'export const add = (a, b) => a + b\n',
      'test/add.test.js': "import { test } from 'node:test'\ntest('noop', () => {})\n",
    })
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    await harness.seedPhase(CHANGE, 'verify')
    return harness
  }

  async function reviewers(harness: Harness): Promise<string[]> {
    expect(await harness.run(['status', CHANGE, '--json'], { env: USER }), harness.err.join('\n')).toBe(0)
    const step = JSON.parse(harness.out.join('\n')).step as { reviewers: { agent: string; required: boolean }[] }
    return step.reviewers.map((reviewer) => reviewer.agent)
  }

  async function nextAgents(harness: Harness): Promise<string[]> {
    expect(await harness.run(['agent', 'next', CHANGE, '--json'], { env: USER }), harness.err.join('\n')).toBe(0)
    return (JSON.parse(harness.out.join('\n')).agents as { agent: string }[]).map((agent) => agent.agent)
  }

  test('改动没碰到鉴权 / 依赖 / 契约：security 不在评审者集合里，派发被拒（exit 2），其余评审者不受影响', async () => {
    const harness = await project()
    await writeFiles(harness.cwd, { 'src/add.js': 'export const add = (a, b) => a + b + 0\n' })
    const shown = await reviewers(harness)
    expect(shown).not.toContain('security')
    expect(shown).toContain('spec-consistency')
    expect(await nextAgents(harness)).not.toContain('security')
    expect(await harness.run(['agent', 'prompt', CHANGE, 'security', '--json'], { env: USER })).toBe(2)
    expect(harness.err.join('\n')).toContain('只在 auth/dependency/contract 路径变化时挂载')
  })

  test.each([
    ['鉴权', 'src/auth/login.js', 'export const login = () => true\n'],
    ['依赖', 'package.json', '{ "name": "scoped", "private": true, "dependencies": { "leftpad": "1.0.0" } }\n'],
    ['契约', 'api/openapi.yaml', 'openapi: 3.0.0\n'],
  ])('改动碰到%s路径：security 进入评审者集合，派发不再被「不需要」拒绝', async (_name, path, body) => {
    const harness = await project()
    await writeFiles(harness.cwd, { [path]: body })
    expect(await reviewers(harness)).toContain('security')
    expect(await nextAgents(harness)).toContain('security')
    // 挂载了：不再是「不需要运行」的拒绝（这里它还在等必需测试 code-size，所以仍是 exit 2，但原因是等待）。
    await harness.run(['agent', 'prompt', CHANGE, 'security', '--json'], { env: USER })
    expect(harness.err.join('\n')).not.toContain('只在 auth/dependency/contract 路径变化时挂载')
    expect(harness.err.join('\n')).toContain('还需等待')
  })

  test('读不出改动（不是仓库）→ 失败关闭：security 照旧挂载', async () => {
    const harness = await freshHarness()
    h = harness
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full']), harness.err.join('\n')).toBe(0)
    await harness.seedPhase(CHANGE, 'verify')
    expect(await harness.run(['agent', 'next', CHANGE, '--json'])).toBe(0)
    expect((JSON.parse(harness.out.join('\n')).agents as { agent: string }[]).map((agent) => agent.agent)).toContain('security')
  })
})
