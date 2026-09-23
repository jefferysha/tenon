/**
 * 回归锚（v0.1.1 验收 ship 步 / D8）：
 *   · 真正卡住出口的未勾任务要作为 `tasks` 来源的 blocker 投影出来（`next` 据此在交付值之前发 fix）；
 *   · `pr_url` 只接受 http(s) URL，或在仓库确实没有 git 远端时取 `no-remote`（本地交付、无 PR）。
 *
 * 零 mock：真临时项目（本身不是 git 仓 = 没有远端），需要远端的用例在里面真 `git init` + `git remote add`。
 */
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'shipx'
let h: Harness

beforeEach(async () => {
  h = await freshHarness()
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

interface Blocker {
  readonly source: string
  readonly code: string
  readonly message: string
  readonly items?: readonly string[]
}
interface StatusJson {
  readonly step: {
    readonly exits: readonly { readonly event: string; readonly blockers: readonly Blocker[] }[]
    readonly fields: readonly { readonly field: string; readonly recommended: string | null }[]
  }
}

async function step(): Promise<StatusJson['step']> {
  expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  return (JSON.parse(h.out.join('\n')) as StatusJson).step
}

describe('ship 步的出口投影', () => {
  test('未勾的任务是 tasks 来源的 blocker；pr_url 在无远端仓库推荐 no-remote', async () => {
    await h.seedPhase(CHANGE, 'ship')
    const projected = await step()
    const blockers = projected.exits.find((exit) => exit.event === 'ship-complete')?.blockers ?? []
    expect(blockers.filter((item) => item.source === 'tasks').map((item) => item.code)).toEqual(['tasks-incomplete'])
    expect(projected.fields.find((item) => item.field === 'pr_url')?.recommended).toBe('no-remote')
  })

  test('tasks 来源的 blocker 自带截至本步仍未勾的任务原文（fix 据此点名要做的事）', async () => {
    await h.seedPhase(CHANGE, 'ship')
    await writeFile(join(h.cwd, 'openspec', 'changes', CHANGE, 'tasks.md'), [
      '## Open', '- [x] scope', '## Build', '- [x] implement', '- [ ] wire the CLI flag',
      '## Ship', '- [ ] Update README usage', '## Archive', '- [ ] later work', '',
    ].join('\n'), 'utf8')
    const blockers = (await step()).exits.find((exit) => exit.event === 'ship-complete')?.blockers ?? []
    expect(blockers.filter((item) => item.source === 'tasks')).toEqual([expect.objectContaining({
      code: 'tasks-incomplete',
      message: expect.stringContaining('仍有 2 项未勾'),
      // 未来步骤（archive）的任务不算。
      items: ['wire the CLI flag', 'Update README usage'],
    })])
  })
})

describe('pr_url 取值闸', () => {
  test('无远端：拒任意字符串，接受 http(s) URL 与 no-remote', async () => {
    expect(await h.run(['set', CHANGE, 'pr_url', 'not a url'])).toBe(1)
    expect(h.err.join('\n')).toContain("字段 'pr_url' 必须是 http(s) URL，或在仓库没有 git 远端时取 'no-remote'")
    expect(await h.run(['set', CHANGE, 'pr_url', 'ftp://example.com/x'])).toBe(1)
    expect(await h.run(['set-many', CHANGE, 'pr_url=javascript:alert(1)'])).toBe(1)
    expect(await h.run(['set', CHANGE, 'pr_url', 'no-remote']), h.err.join('\n')).toBe(0)
    expect(await h.run(['set', CHANGE, 'pr_url', 'https://github.com/o/r/pull/1'])).toBe(0)
    expect(await h.run(['cas', CHANGE, 'pr_url', 'https://github.com/o/r/pull/1', 'nope'])).toBe(1)
  })

  test('有远端：no-remote 被拒，并提示去开 PR', async () => {
    execFileSync('git', ['init', '-q'], { cwd: h.cwd })
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/o/r.git'], { cwd: h.cwd })
    expect(await h.run(['set', CHANGE, 'pr_url', 'no-remote'])).toBe(1)
    expect(h.err.join('\n')).toContain("不能取 'no-remote'：仓库配置了远端（origin）")
    await h.seedPhase(CHANGE, 'ship')
    expect((await step()).fields.find((item) => item.field === 'pr_url')?.recommended).toBeNull()
  })
})
