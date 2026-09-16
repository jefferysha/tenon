/**
 * 一个步骤的测试证据判定：读当前用户的记录，与候选版本、测试声明摘要、工作流指纹比对，
 * 算出每项状态与必需项的拦截理由。
 *
 * 只读当前用户的记录（CCR-6）：环境不同、基准按用户维护，别人跑过不等于我这份代码跑过。
 * 记录损坏或来自另一个 workflow_run_id 一律忽略（视为未运行），宁可多跑一次也不放行。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../sha256.js'
import { readCurrentRunRevision } from '../state/run-revision-store.js'
import { TENON_PROJECT_DIR, userProjectPaths } from '../users/user-paths.js'
import type { EffectiveWorkflowPlan } from '../workflow/effective-plan-types.js'
import type { StepTestIR } from '../workflow/ir.js'
import { readRunningMarker, readTestRunRecord } from './record.js'
import { testEvidencePaths, testRunningMarkerPath } from './paths.js'
import { RUNNING_MARKER_GRACE_MS, type TestRunRecordV1 } from './types.js'

export type TestItemStatus = 'passed' | 'failed' | 'stale' | 'missing' | 'running'

/**
 * 判定的注入面。两项输入回答的是两个不同的问题，所以缺失时的口径也不同：
 *   · `user` 回答「读谁的记录」。记录按用户存放，没有身份就没有可读的证据集，与「没跑过」不可区分，
 *     必须失败关闭。
 *   · `currentCandidate` 回答「这条记录是否仍绑定当前代码」。它只是四条新鲜度绑定里的一条；另外三条
 *     （workflow_run_id、工作流指纹、测试声明摘要）不依赖它。宿主没有这项能力时跳过候选比对，
 *     其余三条照查——kernel 早已把 workspaceFingerprint 列为可降级的 GuardCapability，且「缺能力就
 *     恒判过期」会让门禁无法被满足：再怎么跑测试都清不掉，那是故障不是门禁。
 *     能力在但调用失败是另一回事（生产可达的竞态），按未知处理、仍判过期。
 */
export interface TestEvidenceContext {
  readonly user: { readonly id: string; readonly name: string; readonly slug: string }
  readonly currentCandidate?: () => Promise<string>
  readonly now?: () => number
}

export interface TestEvidenceItem {
  readonly test: StepTestIR
  readonly status: TestItemStatus
  readonly run?: TestRunRecordV1
  readonly staleBecause?: 'candidate' | 'declaration' | 'workflow'
}

export interface TestEvidenceReport {
  readonly stepId: string
  readonly pass: boolean
  readonly blockers: readonly string[]
  readonly items: readonly TestEvidenceItem[]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 测试声明摘要：键序无关，声明改一个字就过期。 */
export function testDigest(test: StepTestIR): string {
  return `sha256:${sha256Hex(canonical(test))}`
}

function stepTests(plan: EffectiveWorkflowPlan, stepId: string): readonly StepTestIR[] {
  return plan.workflow.steps.find((step) => step.id === stepId)?.tests ?? []
}

async function workflowRunId(changeDir: string): Promise<string | undefined> {
  try {
    return (await readCurrentRunRevision(changeDir))?.state.runMetadata?.runId
  } catch {
    return undefined
  }
}

async function runIdsIn(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort()
  } catch {
    return []
  }
}

/** 某用户在某任务上的全部记录，按 run-id 升序（= 时间序）。 */
export async function listTestRuns(
  repoRoot: string,
  changeName: string,
  filter: { readonly slug?: string; readonly testId?: string } = {},
): Promise<readonly { readonly slug: string; readonly record: TestRunRecordV1 }[]> {
  const slugs = filter.slug === undefined ? await userSlugs(repoRoot) : [filter.slug]
  const out: { slug: string; record: TestRunRecordV1 }[] = []
  for (const slug of slugs) {
    const paths = testEvidencePaths(repoRoot, slug, changeName)
    for (const runId of await runIdsIn(paths.runsDir)) {
      const record = await readTestRunRecord(join(paths.runsDir, `${runId}.json`))
      if (record === undefined) continue
      if (filter.testId !== undefined && record.test_id !== filter.testId) continue
      out.push({ slug, record })
    }
  }
  // 同一秒内 run-id 只靠随机后缀区分，所以时间序按记录的完成时间排，run-id 只作稳定兜底。
  return out.sort((left, right) => {
    if (left.record.finished_at !== right.record.finished_at) {
      return left.record.finished_at < right.record.finished_at ? -1 : 1
    }
    return left.record.run_id < right.record.run_id ? -1 : 1
  })
}

async function userSlugs(repoRoot: string): Promise<readonly string[]> {
  try {
    const usersDir = join(repoRoot, TENON_PROJECT_DIR, 'users')
    return (await readdir(usersDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 当前用户在本 workflow_run 内最新的一条该测试记录。 */
export async function latestTestRun(
  repoRoot: string,
  changeName: string,
  slug: string,
  testId: string,
  workflowRunIdValue: string,
): Promise<TestRunRecordV1 | undefined> {
  const runs = await listTestRuns(repoRoot, changeName, { slug, testId })
  return runs.filter((entry) => entry.record.workflow_run_id === workflowRunIdValue).at(-1)?.record
}

/** 记录损坏文件名，供 server 快照的诊断列表使用。 */
export async function corruptTestRunFiles(
  repoRoot: string,
  changeName: string,
  slug: string,
): Promise<readonly string[]> {
  const paths = testEvidencePaths(repoRoot, slug, changeName)
  const corrupt: string[] = []
  for (const runId of await runIdsIn(paths.runsDir)) {
    if (await readTestRunRecord(join(paths.runsDir, `${runId}.json`)) === undefined) corrupt.push(`${runId}.json`)
  }
  return corrupt
}

function statusWord(status: TestItemStatus): string {
  return status === 'passed' ? '通过'
    : status === 'failed' ? '失败'
      : status === 'stale' ? '过期'
        : status === 'running' ? '运行中' : '未运行'
}

function staleWord(because: TestEvidenceItem['staleBecause']): string {
  return because === 'declaration' ? '测试声明已变化' : because === 'workflow' ? '工作流已变化' : '代码已变化'
}

function blockerFor(item: TestEvidenceItem, changeName: string): string {
  const name = item.test.label ?? item.test.id
  const rerun = `执行 tenon test run ${changeName} ${item.test.id}`
  if (item.status === 'running') return `测试 ${name}（${item.test.id}）运行中`
  if (item.status === 'missing') return `测试 ${name}（${item.test.id}）未运行；${rerun}`
  if (item.status === 'stale') {
    return `测试 ${name}（${item.test.id}）过期：${staleWord(item.staleBecause)}；${rerun}`
  }
  const codes = (item.run?.reasons ?? []).map((reason) => reason.code)
  const escalate = codes.includes('sandbox-denied')
    ? '（Codex 中以 sandbox_permissions=require_escalated 执行）'
    : ''
  return `测试 ${name}（${item.test.id}）失败：${codes.join(', ')}；${rerun}${escalate}`
}

export async function evaluateTestEvidence(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  readonly stepId: string
  readonly context: TestEvidenceContext | undefined
}): Promise<TestEvidenceReport> {
  const tests = stepTests(input.plan, input.stepId)
  if (tests.length === 0) return { stepId: input.stepId, pass: true, blockers: [], items: [] }
  if (input.context === undefined) {
    return {
      stepId: input.stepId,
      pass: false,
      blockers: ['测试证据无法验证：宿主未提供用户身份'],
      items: tests.map((test) => ({ test, status: 'missing' as const })),
    }
  }
  const slug = input.context.user.slug
  const now = (input.context.now ?? Date.now)()
  const runId = await workflowRunId(input.changeDir)
  // undefined = 宿主没有工作区指纹能力（跳过候选比对）；null = 能力在但这次取不到（按未知判过期）。
  // 惰性求值且只求一次：指纹要遍历整棵实现树，没有任何记录可判时不该付这个代价。
  const readCandidate = input.context.currentCandidate
  let candidate: string | null | undefined
  let candidateRead = readCandidate === undefined
  const currentCandidate = async (): Promise<string | null | undefined> => {
    if (!candidateRead && readCandidate !== undefined) {
      candidate = await readCandidate().catch(() => null)
      candidateRead = true
    }
    return candidate
  }
  const items: TestEvidenceItem[] = []
  for (const test of tests) {
    const marker = await readRunningMarker(testRunningMarkerPath(input.repoRoot, slug, input.changeName, test.id))
    if (marker !== undefined) {
      const deadline = Date.parse(marker.deadline_at)
      if (Number.isFinite(deadline) && deadline + RUNNING_MARKER_GRACE_MS > now) {
        items.push({ test, status: 'running' })
        continue
      }
    }
    const record = runId === undefined
      ? undefined
      : await latestTestRun(input.repoRoot, input.changeName, slug, test.id, runId)
    if (record === undefined) {
      items.push({ test, status: 'missing' })
      continue
    }
    const current = record.workflow_fingerprint === input.plan.workflowFingerprint
      && record.test_digest === testDigest(test)
      ? await currentCandidate()
      : undefined
    const staleBecause = record.workflow_fingerprint !== input.plan.workflowFingerprint
      ? 'workflow' as const
      : record.test_digest !== testDigest(test)
        ? 'declaration' as const
        : current !== undefined && (current === null || record.candidate !== current)
          ? 'candidate' as const
          : undefined
    if (staleBecause !== undefined) {
      items.push({ test, status: 'stale', run: record, staleBecause })
      continue
    }
    items.push({ test, status: record.result === 'pass' ? 'passed' : 'failed', run: record })
  }
  const blockers = items
    .filter((item) => item.test.required && item.status !== 'passed')
    .map((item) => blockerFor(item, input.changeName))
  return { stepId: input.stepId, pass: blockers.length === 0, blockers, items }
}

export { statusWord as testStatusWord }

/** 判定时用到的用户目录（server 快照列诊断时复用）。 */
export function testEvidenceUserRoot(repoRoot: string, slug: string): string {
  return userProjectPaths(repoRoot, slug).userRoot
}
