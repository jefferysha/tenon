/**
 * 任务起点字段 start_sha / base_branch / created_at：只由 tenon init 写入。
 *
 * 真临时项目（harness）+ 真仓库：init 记下当时的 HEAD；set / set-many / cas 拒写这三个字段且投影原样不动；
 * 三字段属于「由转换 / init 管理」的集合：default 工作流各步 `status --json` 的 fields 与 next 里都不出现它们。
 */
import { appendFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'
import { commitAll, git, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const CHANGE = 'startpoint'

let h: Harness | undefined
afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

async function repoWithCommit(): Promise<{ harness: Harness; head: string }> {
  const harness = await freshHarness()
  h = harness
  await writeFiles(harness.cwd, { 'src/a.ts': 'export const a = 1\n' })
  initGit(harness.cwd)
  commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
  return { harness, head: git(harness.cwd, ['rev-parse', 'HEAD']).trim() }
}

describe('tenon init 记下任务起点', () => {
  test('仓库有提交：start_sha 等于当时的 HEAD，物理值在伴随文件里（wire 与投影保持上一正式版认得的闭集）；之后 HEAD 前进也不变', async () => {
    const { harness, head } = await repoWithCommit()
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    expect(await harness.run(['get', CHANGE, 'start_sha'])).toBe(0)
    expect(harness.out).toEqual([head])
    expect(await harness.read(CHANGE)).not.toContain('start_sha')
    const runDir = join(harness.cwd, 'openspec', 'changes', CHANGE, '.pipeline-run')
    expect(await readFile(join(runDir, 'current.json'), 'utf8')).not.toContain('start_sha')
    const records = await readdir(join(runDir, 'start-sha'))
    expect(records).toHaveLength(1)
    expect(JSON.parse(await readFile(join(runDir, 'start-sha', records[0] ?? ''), 'utf8'))).toMatchObject({ sha: head })
    await writeFiles(harness.cwd, { 'src/b.ts': 'export const b = 2\n' })
    commitAll(harness.cwd, 'later', '2026-02-01T00:00:00Z')
    expect(await harness.run(['get', CHANGE, 'start_sha'])).toBe(0)
    expect(harness.out).toEqual([head])
  })

  test('仓库还没有提交：不写 start_sha，该键不出现', async () => {
    const harness = await freshHarness()
    h = harness
    initGit(harness.cwd)
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    expect(await harness.read(CHANGE)).not.toContain('start_sha')
    expect(await harness.run(['get', CHANGE, 'start_sha'])).toBe(0)
    expect(harness.out).toEqual([''])
  })

  test('不是 git 仓库：不写 start_sha，init 照常成功', async () => {
    const harness = await freshHarness()
    h = harness
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    expect(await harness.read(CHANGE)).not.toContain('start_sha')
  })
})

describe('决定起点的字段拒写', () => {
  test.each([
    ['start_sha', 'f'.repeat(40)],
    ['base_branch', 'dev'],
    ['created_at', '2030-01-01T00:00:00Z'],
  ])('set / set-many / cas 写 %s 全部非零退出，投影与字段值保持原样', async (field, value) => {
    const { harness } = await repoWithCommit()
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'], { env: USER })).toBe(0)
    const before = await harness.read(CHANGE)
    expect(await harness.run(['get', CHANGE, field])).toBe(0)
    const original = harness.out[0] ?? ''

    expect(await harness.run(['set', CHANGE, field, value], { env: USER })).not.toBe(0)
    expect(harness.err.join('\n')).toContain('tenon init')
    expect(await harness.run(['set-many', CHANGE, `${field}=${value}`, 'branch=x'], { env: USER })).not.toBe(0)
    expect(await harness.run(['cas', CHANGE, field, original, value], { env: USER })).not.toBe(0)

    expect(await harness.read(CHANGE)).toBe(before)
    expect(await harness.run(['get', CHANGE, field])).toBe(0)
    expect(harness.out).toEqual([original])
    expect(await harness.run(['get', CHANGE, 'branch'])).toBe(0)
    expect(harness.out).toEqual(['null'])
  })
})

/**
 * default 工作流（backend 轨道）的各步。三个起点字段属于「由转换 / init 管理」的集合（statusStepParts 也消费这份集合），
 * 从来不是任何一步要填的槽：逐步读 `status --json`，既不在 `fields` 里，`next` 里也没有给它们的 `set-field`。
 */
const PHASES = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'] as const
const START_FIELDS = ['start_sha', 'base_branch', 'created_at'] as const

describe('default 工作流各步的 step 投影不受三字段只读化影响', () => {
  test('三个字段不在任何一步的待填槽里，next 里也没有写它们的 set-field', async () => {
    const { harness } = await repoWithCommit()
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'], { env: USER })).toBe(0)
    expect(await harness.run(['session', 'activate', CHANGE, '--host-session', 'batch-session'], { env: USER })).toBe(0)
    const seen: Array<{ phase: string; fields: Array<[string, string, string]>; next: readonly { action: string; field?: string }[] }> = []
    let seq = 0
    for (const phase of PHASES) {
      await harness.seedPhase(CHANGE, phase)
      seq += 1
      await appendFile(join(harness.cwd, 'openspec', 'changes', CHANGE, '.pipeline-history.jsonl'), `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: tenon' })}\n`, 'utf8')
      expect(await harness.run(['internal-native-skill-receipt', CHANGE, 'tenon', 'batch-session', `tool-${seq}`, FIXED_CLOCK], { env: USER }), harness.err.join('\n')).toBe(0)
      expect(await harness.run(['status', CHANGE, '--json'], { env: USER }), harness.err.join('\n')).toBe(0)
      const step = JSON.parse(harness.out.join('\n')).step as {
        fields: { field: string; writer: string; status: string }[]; next: readonly { action: string; field?: string }[]
      }
      seen.push({ phase, fields: step.fields.map((f): [string, string, string] => [f.field, f.writer, f.status]), next: step.next })
    }
    expect(seen.map((entry) => entry.phase)).toEqual([...PHASES])
    const slots = seen.flatMap((entry) => entry.fields.map(([field]) => field))
    const written = seen.flatMap((entry) => entry.next.filter((action) => action.action === 'set-field').map((action) => action.field))
    for (const field of START_FIELDS) {
      expect(slots).not.toContain(field)
      expect(written).not.toContain(field)
    }
  })
})
