/**
 * `tenon status <change> --json` 的 `step.rounds.current` 只由 canonical 转换记录链决定。
 *
 * 任务走到第 2 轮 verify（第 1 轮 verify → verify-fail → build → build-complete）之后，删除评审标记与交互标记、
 * 重跑步骤测试、重新登记评审者运行、删除或截断 `.pipeline-history.jsonl`，轮次都必须仍是 2
 * （delta spec verify-round-limit：「删除标记、重跑命令、换 agent MUST NOT 让计数清零」）。
 *
 * 链里的转换用 WorkflowRunRepository 直接提交（同 status-step-rounds.integration.test.ts：主题是读侧计数，
 * 不重走每条转换的守卫）；步骤测试、评审者运行、`status` 都走生产路径。
 */
import { appendFile, readFile, rm as fsRm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createHistoryWriter, createStateStore, createTransitionRecordStore, createWorkflowRunRepository,
  transitionRecordToHistoryEntry,
} from '@tenon/kernel'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'roundsstable'
const SESSION = '019f92c7-6e66-7290-9352-f9d915266f14'
const HISTORY = '.pipeline-history.jsonl'

/** 项目根上的门禁标记：评审、确认、交互（单文件与按会话分文件两种）。 */
const MARKERS = [
  '.pipeline-pending-review',
  '.pipeline-pending-confirm',
  '.pipeline-pending-interaction',
  `.pipeline-pending-interaction.${SESSION}`,
] as const

interface Hop { readonly event: string; readonly to: string }

/** 第 1 轮 verify → verify-fail → build → build-complete → 第 2 轮 verify。 */
const TO_FIRST_VERIFY: readonly Hop[] = [
  { event: 'open-complete', to: 'explore' },
  { event: 'explore-complete', to: 'spec' },
  { event: 'spec-complete', to: 'build' },
  { event: 'build-complete', to: 'verify' },
]
const BACK_TO_SECOND_VERIFY: readonly Hop[] = [
  { event: 'verify-fail', to: 'build' },
  { event: 'build-complete', to: 'verify' },
]

describe('status --json 的 step.rounds 不被标记、重跑、历史文件的变化清零', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE, '--host-session', SESSION]), h.err.join('\n')).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  const changeDir = (): string => join(h.cwd, 'openspec', 'changes', CHANGE)

  async function walk(hops: readonly Hop[]): Promise<void> {
    const repo = createWorkflowRunRepository({
      store: createStateStore(), recordStore: createTransitionRecordStore(), clock: () => FIXED_CLOCK,
    })
    const history = createHistoryWriter({})
    for (const hop of hops) {
      const { record } = await repo.transact(changeDir(), (tx) =>
        tx.commit({ ...tx.state.fields, phase: hop.to }, { event: hop.event, from: String(tx.state.fields.phase), to: hop.to }))
      // 与生产 transition 收尾同款：canonical 记录投影成一行 JSONL 兼容历史（transition-application.ts）。
      await history.append(changeDir(), transitionRecordToHistoryEntry(record))
    }
  }

  async function rounds(): Promise<{ readonly id: string; readonly rounds: unknown }> {
    expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
    const step = (JSON.parse(h.out.join('\n')) as { step?: { id: string; rounds?: unknown } }).step
    expect(step, 'step 分块必须存在').toBeDefined()
    return { id: (step as { id: string }).id, rounds: (step as { rounds?: unknown }).rounds }
  }

  async function expectSecondRound(): Promise<void> {
    expect(await rounds()).toEqual({ id: 'verify', rounds: { current: 2, max: 2, source: 'workflow' } })
  }

  async function historyTransitionRows(): Promise<number> {
    const raw = await readFile(join(changeDir(), HISTORY), 'utf8').catch(() => '')
    return raw.split('\n').filter((line) => line.includes('"kind":"transition"')).length
  }

  /** 走到第 2 轮 verify，并确认历史文件里确有转换行——否则「删它不影响计数」什么也没证明。 */
  async function atSecondRound(): Promise<void> {
    await walk([...TO_FIRST_VERIFY, ...BACK_TO_SECOND_VERIFY])
    await expectSecondRound()
    expect(await historyTransitionRows(), '历史文件里应有转换行').toBeGreaterThanOrEqual(TO_FIRST_VERIFY.length)
  }

  test('删除评审标记与交互标记：第 2 轮不变', async () => {
    await atSecondRound()
    for (const marker of MARKERS) await writeFile(join(h.cwd, marker), `kind=${marker}\nchange=${CHANGE}\n`, 'utf8')
    await expectSecondRound()

    for (const marker of MARKERS) await fsRm(join(h.cwd, marker), { force: true })
    await expectSecondRound()
  })

  test('重跑步骤测试：第 2 轮不变', async () => {
    await atSecondRound()
    await h.satisfyStepTests(CHANGE, 'verify')
    await expectSecondRound()

    expect(await h.run(['test', 'run', CHANGE, 'code-size']), h.err.join('\n')).toBe(0)
    await expectSecondRound()
  })

  test('重新登记评审者运行（含同一候选上带 --rerun-reason 的重跑）：第 2 轮不变', async () => {
    await atSecondRound()
    // code-size 评审者读 code-size 测试的结果：先满足本步测试，评审者才排得上。
    await h.satisfyStepTests(CHANGE, 'verify')
    await h.satisfyStepAgents(CHANGE)
    await expectSecondRound()

    expect(await h.run(['agent', 'prompt', CHANGE, 'code-size', '--host', 'claude', '--json', '--rerun-reason', '换一次运行']), h.err.join('\n')).toBe(0)
    const started = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    await writeFile(join(h.cwd, started.report_path), '# code-size\n\n```tenon-result\n{"findings":[]}\n```\n', 'utf8')
    expect(await h.run(['agent', 'record', CHANGE, started.run_id]), h.err.join('\n')).toBe(0)
    await expectSecondRound()
  })

  test('删除 .pipeline-history.jsonl：有 canonical 链的任务仍是第 2 轮', async () => {
    await atSecondRound()
    await fsRm(join(changeDir(), HISTORY), { force: true })
    expect(await historyTransitionRows()).toBe(0)
    await expectSecondRound()
  })

  test('截断 .pipeline-history.jsonl（清空、只留开头一行）：仍是第 2 轮', async () => {
    await atSecondRound()
    const first = (await readFile(join(changeDir(), HISTORY), 'utf8')).split('\n')[0] ?? ''

    await truncate(join(changeDir(), HISTORY), 0)
    expect(await historyTransitionRows()).toBe(0)
    await expectSecondRound()

    await writeFile(join(changeDir(), HISTORY), `${first}\n`, 'utf8')
    await expectSecondRound()
  })

  test('历史文件被篡改：塞进伪造的转换行也不改变轮次', async () => {
    await atSecondRound()
    const forged = [{ event: 'build-complete', to: 'verify' }, { event: 'build-complete', to: 'verify' }]
    for (const hop of forged) await appendFile(join(changeDir(), HISTORY), `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'transition', ...hop })}\n`, 'utf8')
    await expectSecondRound()
  })
})
