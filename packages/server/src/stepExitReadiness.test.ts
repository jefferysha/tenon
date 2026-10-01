/**
 * 快照 readiness 与 `tenon status <c> --json` 的 exits 是同一份判定：同一个 Change（缺技能、缺文档、
 * tasks.md 未勾），CLI 说哪条边不能走、为什么，快照就给出同样的 ready 与同样的阻断文案。
 * CLI 侧跑真实构建产物（packages/cli/dist/main.js），不是在测试里重拼一遍判定。
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TenonUser } from '@tenon/kernel'
import { buildSnapshot } from './snapshot.js'
import { initChange, makeProject, newStore, testFlow } from './test-support.js'

const execFileAsync = promisify(execFile)
const CLI_MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'main.js')
const USER: TenonUser = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' }

interface CliExit {
  readonly event: string
  readonly ready: boolean
  readonly blockers: ReadonlyArray<{
    readonly source: string; readonly code: string; readonly message: string; readonly items?: readonly string[]
    readonly subject?: string; readonly state?: string; readonly count?: number
  }>
}

async function cliExits(root: string, name: string): Promise<readonly CliExit[]> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_MAIN, 'status', name, '--json'], {
    cwd: root,
    env: { ...process.env, TENON_USER: USER.id, TENON_USER_NAME: USER.name, TENON_AFK: '' },
  })
  const parsed: unknown = JSON.parse(stdout)
  const step = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'step') : undefined
  const exits = typeof step === 'object' && step !== null ? Reflect.get(step, 'exits') : undefined
  if (!Array.isArray(exits)) throw new Error(`tenon status --json 没有 step.exits：${stdout.slice(0, 400)}`)
  return exits as CliExit[]
}

async function buildFixture(): Promise<{ root: string; name: string; changeDir: string; store: ReturnType<typeof newStore> }> {
  const store = newStore()
  const root = await makeProject()
  const name = 'parity-change'
  const changeDir = await initChange(store, root, name, { track: 'backend' })
  const seeded = await store.read(changeDir)
  await store.write(changeDir, { ...seeded, fields: { ...seeded.fields, phase: 'build' } })
  // 未勾的任务：旧格式（无阶段标题）整张清单归 build。
  await writeFile(join(changeDir, 'tasks.md'), '# Tasks\n\n- [ ] 实现解析器\n- [x] 写测试\n- [ ] 更新文档\n', 'utf8')
  return { root, name, changeDir, store }
}

describe('snapshot readiness = tenon status exits', () => {
  it('缺技能 / 缺文档 / tasks.md 未勾：两边 ready 一致，阻断文案一致', async () => {
    const { root, name, store } = await buildFixture()
    const exits = await cliExits(root, name)
    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => '2026-07-07T00:00:00Z',
      flow: testFlow(),
      resolveUser: () => USER,
    })
    const change = snapshot.projects[0]?.changes[0]
    expect(change?.name).toBe(name)
    const readiness = change?.workflowExecution.readinessByTransition.build ?? {}
    expect(exits.length).toBeGreaterThan(0)
    const forward = exits.find((exit) => exit.event === 'build-complete')
    expect(forward?.ready).toBe(false)
    // 三类阻断在 CLI 侧确实都出现了（fixture 本身有效）。
    const sources = new Set(forward?.blockers.map((blocker) => blocker.source))
    expect(sources.has('skill')).toBe(true)
    expect(sources.has('tasks')).toBe(true)
    expect(sources.has('document')).toBe(true)
    expect(forward?.blockers.find((blocker) => blocker.source === 'tasks')?.items).toEqual(['实现解析器', '更新文档'])
    for (const exit of exits) {
      const projected = readiness[exit.event]
      expect(projected, exit.event).toBeDefined()
      expect(projected?.ready, exit.event).toBe(exit.ready)
      const projectedMessages = (projected?.blockers ?? [])
        .flatMap((blocker) => blocker.kind === 'step-exit' ? [blocker.message] : [])
      const cliMessages = exit.blockers
        .filter((blocker) => !(blocker.source === 'guard' && blocker.code === 'guard-failed'))
        .filter((blocker) => blocker.source !== 'revision' && blocker.source !== 'reviewer')
        .map((blocker) => blocker.message)
      expect(projectedMessages, exit.event).toEqual(cliMessages)
      // 结构化字段（subject / state / count）两边同一份：Dashboard 按它分类，不解析中文整句。
      const detailsOf = (blockers: ReadonlyArray<{ subject?: string; state?: string; count?: number }>) =>
        blockers.map((blocker) => ({ subject: blocker.subject, state: blocker.state, count: blocker.count }))
      const projectedDetails = detailsOf((projected?.blockers ?? []).flatMap((blocker) => blocker.kind === 'step-exit' ? [blocker] : []))
      const cliDetails = detailsOf(exit.blockers
        .filter((blocker) => !(blocker.source === 'guard' && blocker.code === 'guard-failed'))
        .filter((blocker) => blocker.source !== 'revision' && blocker.source !== 'reviewer'))
      expect(projectedDetails, exit.event).toEqual(cliDetails)
    }
    // 三类阻断各自带着结构化字段：tasks 有未勾项数，文档有 kind + 状态，技能有 token + 状态。
    const blockers = forward?.blockers ?? []
    expect(blockers.find((blocker) => blocker.source === 'tasks')).toMatchObject({ code: 'tasks-incomplete', count: 2 })
    const document = blockers.find((blocker) => blocker.source === 'document')
    expect(document).toMatchObject({ code: 'document-evidence', state: 'missing' })
    expect(typeof document?.subject).toBe('string')
    const skill = blockers.find((blocker) => blocker.source === 'skill')
    expect(skill).toMatchObject({ code: 'skill-incomplete' })
    expect(['not-run', 'unrecorded']).toContain(skill?.state)
    expect(typeof skill?.subject).toBe('string')
    // 这些字段是服务端的协议；整句只是人读的补充，快照里的 message 保持原文。
    const projectedTasks = (readiness['build-complete']?.blockers ?? []).find((blocker) => blocker.kind === 'step-exit' && blocker.source === 'tasks')
    expect(projectedTasks).toMatchObject({ kind: 'step-exit', code: 'tasks-incomplete', count: 2 })
  })

  it('未注入 flow 的只读快照不做 step-exit 判定（向后兼容的最小 readiness）', async () => {
    const { root, store } = await buildFixture()
    const snapshot = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    const readiness = snapshot.projects[0]?.changes[0]?.workflowExecution.readinessByTransition.build ?? {}
    const kinds = Object.values(readiness).flatMap((value) => value.blockers.map((blocker) => blocker.kind))
    expect(kinds).not.toContain('step-exit')
  })
})
