/**
 * 测试完整性报告（纯函数）：把本任务相对起点的改动读成「证据变弱了吗」的信号。
 *
 * 十种信号，来源两类：
 *   · 运行记录（同一套件在本任务里的全量运行之间）：用例数下降、跳过数上升；
 *   · 起点以来的 diff（git diff -U0 的新增 / 删除行）：测试文件被删、声明的用例变少、新增跳过标记、断言被删、
 *     快照被改写、基线被改、已知失败新增、覆盖率门槛降低。
 *
 * 全是启发式：信号说「值得看一眼」，不下结论。策略 `integrity: notice`（缺省）只提示，`block` 让信号挡住出口。
 * 读 diff 的 IO 在 integrity-diff.ts；本文件不碰文件系统与 git，输入由调用方给出。
 */
import { INTEGRITY_SIGNAL_CODES, INTEGRITY_SIGNAL_LABELS, type IntegritySignalCode } from './integrity-labels.js'
import {
  assertions, declaredTests, integrityPathKind, knownFailureRefOf, skipMarkers, thresholdDrops,
} from './integrity-patterns.js'
import type { RunScope } from './vocabulary.js'

export { INTEGRITY_SIGNAL_CODES, INTEGRITY_SIGNAL_LABELS, type IntegritySignalCode }

export type IntegrityMode = 'notice' | 'block'

export interface IntegritySignal {
  readonly code: IntegritySignalCode
  /** 涉及的对象：仓库相对路径（来自 diff）、套件 id（来自运行记录）、已知失败的用例引用。 */
  readonly subject: string
  /** 一行事实，不是句子：`12 → 9`、`-3 +1`、`lines 80 → 70`。 */
  readonly detail: string
  /** 认领该文件的目录套件（认得出时）。 */
  readonly suite?: string
}

/** 一个文件相对起点的改动行（`git diff -U0`）；未跟踪的新文件整份算新增。 */
export interface IntegrityFileDiff {
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted'
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface IntegrityDiff {
  readonly files: readonly IntegrityFileDiff[]
  /** 相关文件超过读取上限被截断：只读了前 `limit` 个。 */
  readonly truncated?: { readonly found: number; readonly limit: number }
}

/** 一个套件的一次运行（来自运行记录，按时间从旧到新）。 */
export interface IntegrityRunSample {
  readonly suite: string
  readonly scope: RunScope
  readonly cases: number
  readonly skip: number
}

/** 运行记录（从旧到新）→ 每个套件每次运行的样本。 */
export function integrityRunSamples(records: readonly {
  readonly suites: readonly { readonly suite: string; readonly scope: RunScope; readonly totals: { readonly cases: number; readonly skip: number } }[]
}[]): readonly IntegrityRunSample[] {
  return records.flatMap((record) => record.suites.map((run) => ({
    suite: run.suite, scope: run.scope, cases: run.totals.cases, skip: run.totals.skip,
  })))
}

export interface IntegrityInput {
  readonly diff: IntegrityDiff | undefined
  readonly runs: readonly IntegrityRunSample[]
  /** 认领文件的目录套件；没有目录或没人认领返回 undefined。 */
  readonly suiteOf: (path: string) => string | undefined
}

export interface TestIntegrityReport {
  readonly mode: IntegrityMode
  /** unavailable = 读不出 diff（运行记录类信号照常给出）。 */
  readonly state: 'ok' | 'unavailable'
  readonly reason?: string
  readonly signals: readonly IntegritySignal[]
  readonly truncated?: { readonly found: number; readonly limit: number }
}

const MAX_SIGNALS = 200

function fromRuns(runs: readonly IntegrityRunSample[]): IntegritySignal[] {
  const bySuite = new Map<string, IntegrityRunSample[]>()
  for (const run of runs) {
    // 只比全量运行：改动范围 / 文件 / 筛选的用例数本来就少，不能当作下降。
    if (run.scope !== 'full') continue
    const list = bySuite.get(run.suite) ?? []
    list.push(run)
    bySuite.set(run.suite, list)
  }
  const out: IntegritySignal[] = []
  for (const [suite, samples] of bySuite) {
    const latest = samples[samples.length - 1]
    const first = samples[0]
    if (latest === undefined || first === undefined || samples.length < 2) continue
    const peak = Math.max(...samples.slice(0, -1).map((sample) => sample.cases))
    if (latest.cases < peak) out.push({ code: 'case-count-drop', subject: suite, detail: `${peak} → ${latest.cases}`, suite })
    if (latest.skip > first.skip) out.push({ code: 'skip-count-rise', subject: suite, detail: `${first.skip} → ${latest.skip}`, suite })
  }
  return out
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

interface Facts {
  readonly declaredRemoved: number
  readonly declaredAdded: number
}

function testFileSignals(
  file: IntegrityFileDiff,
  facts: Facts,
  suite: string | undefined,
  movedTo: IntegrityFileDiff | undefined,
): IntegritySignal[] {
  const out: IntegritySignal[] = []
  const withSuite = suite === undefined ? {} : { suite }
  if (file.status === 'deleted' && movedTo === undefined) {
    out.push({ code: 'test-file-deleted', subject: file.path, detail: facts.declaredRemoved > 0 ? `-${facts.declaredRemoved}` : '-', ...withSuite })
  } else if (file.status === 'modified' && facts.declaredRemoved > facts.declaredAdded) {
    out.push({ code: 'tests-removed', subject: file.path, detail: `-${facts.declaredRemoved} +${facts.declaredAdded}`, ...withSuite })
  }
  if (file.status !== 'deleted') {
    const skipped = skipMarkers(file.added) - skipMarkers(file.removed)
    if (skipped > 0) out.push({ code: 'test-skipped', subject: file.path, detail: `+${skipped}`, ...withSuite })
  }
  // 整个用例被删时，它的断言一并消失，已由 tests-removed 说明；断言信号只给「用例还在、断言少了」。
  if (file.status === 'modified' && facts.declaredRemoved <= facts.declaredAdded) {
    const removed = assertions(file.removed)
    const added = assertions(file.added)
    if (removed > added) out.push({ code: 'assertion-weakened', subject: file.path, detail: `-${removed} +${added}`, ...withSuite })
  }
  return out
}

function snapshotSignal(file: IntegrityFileDiff): IntegritySignal | undefined {
  if (file.status === 'added') return undefined
  // 二进制快照（截图）git 不给文本行：改了却看不到行，一样算改写。
  const rewritten = file.status === 'deleted' || file.removed.length > 0 || (file.added.length === 0 && file.removed.length === 0)
  if (!rewritten) return undefined
  return {
    code: 'snapshot-rewritten',
    subject: file.path,
    detail: file.status === 'deleted' ? '-' : `-${file.removed.length} +${file.added.length}`,
  }
}

function coverageSignals(file: IntegrityFileDiff): IntegritySignal[] {
  return thresholdDrops(file.removed, file.added).map((drop) => ({
    code: 'coverage-threshold-lowered' as const,
    subject: file.path,
    detail: `${drop.key} ${drop.before} → ${drop.after ?? '-'}`,
  }))
}

function knownFailureSignals(file: IntegrityFileDiff): IntegritySignal[] {
  if (file.status === 'deleted') return []
  const removed = new Set(file.removed.flatMap((line) => knownFailureRefOf(line) ?? []))
  return file.added.flatMap((line) => {
    const ref = knownFailureRefOf(line)
    return ref === undefined || removed.has(ref) ? [] : [{ code: 'known-failure-added' as const, subject: ref, detail: '+1' }]
  })
}

function fromDiff(diff: IntegrityDiff, suiteOf: (path: string) => string | undefined): IntegritySignal[] {
  const out: IntegritySignal[] = []
  const entries = diff.files.map((file) => ({ file, kind: integrityPathKind(file.path, suiteOf(file.path) !== undefined) }))
  const addedTests = entries.filter((entry) => entry.kind === 'test' && entry.file.status === 'added').map((entry) => entry.file)
  for (const { file, kind } of entries) {
    const suite = suiteOf(file.path)
    switch (kind) {
      case 'test': {
        // 删除一个测试文件又在别处新增同名文件 = 搬家：按用例数净变化判断，不报「被删」。
        const movedTo = file.status === 'deleted'
          ? addedTests.find((candidate) => basename(candidate.path) === basename(file.path))
          : undefined
        const declaredAdded = movedTo === undefined ? declaredTests(file.added) : declaredTests(movedTo.added)
        const facts = { declaredRemoved: declaredTests(file.removed), declaredAdded }
        if (movedTo !== undefined && facts.declaredRemoved > facts.declaredAdded) {
          out.push({ code: 'tests-removed', subject: movedTo.path, detail: `-${facts.declaredRemoved} +${facts.declaredAdded}`, ...(suite === undefined ? {} : { suite }) })
        } else {
          out.push(...testFileSignals(file, facts, suite, movedTo))
        }
        break
      }
      case 'snapshot': {
        const signal = snapshotSignal(file)
        if (signal !== undefined) out.push(signal)
        break
      }
      case 'baseline':
        out.push({ code: 'baseline-changed', subject: file.path, detail: file.status })
        break
      case 'known-failures':
        out.push(...knownFailureSignals(file))
        break
      case 'coverage-config':
      case 'workflow':
        out.push(...coverageSignals(file))
        break
      case undefined:
        break
    }
  }
  return out
}

const ORDER: ReadonlyMap<IntegritySignalCode, number> = new Map(INTEGRITY_SIGNAL_CODES.map((code, index) => [code, index]))

export function evaluateIntegrity(input: IntegrityInput, mode: IntegrityMode): TestIntegrityReport {
  const signals = [...fromRuns(input.runs), ...(input.diff === undefined ? [] : fromDiff(input.diff, input.suiteOf))]
    .sort((left, right) => (ORDER.get(left.code) ?? 0) - (ORDER.get(right.code) ?? 0)
      || (left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0))
  return {
    mode,
    state: 'ok',
    signals: signals.slice(0, MAX_SIGNALS),
    ...(input.diff?.truncated === undefined ? {} : { truncated: input.diff.truncated }),
  }
}

/** 读不出 diff：运行记录类信号照常，diff 类信号缺席并说明原因。 */
export function unavailableIntegrity(mode: IntegrityMode, reason: string, runs: readonly IntegrityRunSample[]): TestIntegrityReport {
  return { mode, state: 'unavailable', reason, signals: fromRuns(runs) }
}

/** 一行汇总：`用例被跳过 2、断言变少 1`（按信号种类计数）。 */
export function integritySummary(signals: readonly IntegritySignal[], lang: 'zh' | 'en' = 'zh'): string {
  const counts = new Map<IntegritySignalCode, number>()
  for (const signal of signals) counts.set(signal.code, (counts.get(signal.code) ?? 0) + 1)
  return INTEGRITY_SIGNAL_CODES.flatMap((code) => {
    const n = counts.get(code)
    return n === undefined ? [] : [`${INTEGRITY_SIGNAL_LABELS[code][lang]} ${n}`]
  }).join(lang === 'zh' ? '、' : ', ')
}
