/**
 * 解析出的用例 → 记录里的用例。三件事：
 *   · 已知失败清单里的失败（未过期）标 known-fail，其余失败保持 fail；
 *   · 只保留失败、flaky、已知失败，以及计划登记的文件 / 映射里的用例全量（其余只进 totals，大型套件的记录不膨胀）；
 *   · 用例附件换成本次运行产物索引里的路径。
 * 「已登记用例未执行」的判定依赖第二条：登记过的文件里执行过的用例必须留在记录里；
 * 报告没给文件的用例（UNKNOWN_CASE_FILE）只能按名字对，所以名字对得上某条登记引用的无文件用例、
 * 以及与它们同名的其它用例（别的文件里的同名用例会让「名字唯一」不成立）也必须留下，判定才看得到完整的同名集合。
 */
import {
  caseTitleMatchesRef, classifyAgainstKnownFailures, fileRefMatches, formatCaseRef, isUnknownCaseFile, parseCaseRef,
  type CaseRef, type CaseResultV2, type CaseTotals, type KnownFailure, type TestPlan,
} from '@tenon/kernel'
import type { ParsedCase } from './parsers/index.js'

const MAX_TEXT = 4000

function clip(value: string): string {
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT - 1)}…`
}

export function totalsOf(cases: ReadonlyArray<{ readonly status: CaseResultV2['status'] }>): CaseTotals {
  const count = (status: CaseResultV2['status']): number => cases.filter((item) => item.status === status).length
  return {
    cases: cases.length, pass: count('pass'), fail: count('fail'), skip: count('skip'),
    flaky: count('flaky'), known_fail: count('known-fail'),
  }
}

/** 必须留在记录里的文件：计划登记的、映射引用的、已知失败清单点名的。 */
export function wantedFiles(plan: TestPlan | undefined, planFiles: readonly string[], known: readonly KnownFailure[], suiteId: string): string[] {
  const mapped = (plan?.cases ?? []).flatMap((item) => item.tests.flatMap((test) => {
    const ref = parseCaseRef(test)
    return ref === undefined ? [] : [ref.file]
  }))
  const listed = known.filter((entry) => entry.suite === suiteId).flatMap((entry) => {
    const ref = parseCaseRef(entry.test)
    return ref === undefined ? [] : [ref.file]
  })
  return [...planFiles, ...mapped, ...listed]
}

/** 计划映射与已知失败清单点名的、带标题路径的引用：无文件的用例靠它们按名字留下（只写文件的引用没有名字可对）。 */
export function wantedRefs(plan: TestPlan | undefined, known: readonly KnownFailure[], suiteId: string): CaseRef[] {
  const tests = [
    ...(plan?.cases ?? []).flatMap((item) => item.tests),
    ...known.filter((entry) => entry.suite === suiteId).map((entry) => entry.test),
  ]
  return tests.flatMap((test) => {
    const ref = parseCaseRef(test)
    return ref === undefined || ref.title.length === 0 ? [] : [ref]
  })
}

export function isRetained(item: Pick<ParsedCase, 'status' | 'file'>, wanted: readonly string[]): boolean {
  return item.status === 'fail' || item.status === 'flaky'
    || wanted.some((file) => fileRefMatches(file, item.file) || fileRefMatches(item.file, file))
}

export interface RecordContext {
  readonly suiteId: string
  readonly wanted: readonly string[]
  readonly wantedRefs: readonly CaseRef[]
  readonly knownFailures: readonly KnownFailure[]
  readonly today: string
  /** 附件绝对路径 → 产物索引路径。 */
  readonly indexed: (absolute: string) => string | undefined
  readonly resolveAttachment: (path: string) => string
}

/** 名字对得上某条登记引用、且其中有无文件用例的那一组用例（含同名的有文件用例）：判定按名字唯一对时要看到整组。 */
function keptByName(all: readonly CaseResultV2[], refs: readonly CaseRef[]): ReadonlySet<CaseResultV2> {
  const kept = new Set<CaseResultV2>()
  if (!all.some((item) => isUnknownCaseFile(item.file))) return kept
  for (const ref of refs) {
    const named = all.filter((item) => caseTitleMatchesRef(ref, item))
    if (named.some((item) => isUnknownCaseFile(item.file))) for (const item of named) kept.add(item)
  }
  return kept
}

export function recordCases(parsed: readonly ParsedCase[], context: RecordContext): { readonly all: CaseResultV2[]; readonly kept: CaseResultV2[] } {
  const all: CaseResultV2[] = []
  const always = new Set<CaseResultV2>()
  for (const item of parsed) {
    const identity = { file: item.file, suite_path: item.suite_path, name: item.name }
    let status: CaseResultV2['status'] = item.status
    if (status === 'fail' && classifyAgainstKnownFailures(context.knownFailures, context.suiteId, identity, 'fail', context.today).verdict === 'known-fail') {
      status = 'known-fail'
    }
    const artifacts = item.attachments.flatMap((attachment) => {
      const path = context.indexed(context.resolveAttachment(attachment.path))
      return path === undefined ? [] : [path]
    })
    const record: CaseResultV2 = {
      id: clip(`${formatCaseRef(identity)}${item.project === null ? '' : ` [${item.project}]`}`),
      file: clip(item.file),
      ...(item.line === undefined ? {} : { line: item.line }),
      name: clip(item.name),
      suite_path: item.suite_path.map(clip),
      project: item.project === null ? null : item.project.slice(0, 120),
      status,
      duration_ms: Math.max(0, Math.round(item.duration_ms)),
      attempts: item.attempts,
      ...(item.failure === undefined || status === 'pass' || status === 'skip' ? {} : { failure: item.failure }),
      artifacts: [...new Set(artifacts)],
    }
    all.push(record)
    if (status === 'known-fail' || isRetained(item, context.wanted)) always.add(record)
  }
  const named = keptByName(all, context.wantedRefs)
  return { all, kept: all.filter((record) => always.has(record) || named.has(record)) }
}
