/**
 * 已知失败清单 `.tenon/tests/known-failures.yaml`（进 git，经 `tenon test known add|rm` 维护）。
 *
 * 判定口径（回归套件在当前代码上全量跑时）：
 *   · 清单内、未过期的用例失败 → known-fail，不挡；
 *   · 清单内用例通过 → fixed，提示移出清单；
 *   · 清单内但已过期的用例失败 → 按普通失败挡，并提示续期或修复；
 *   · 清单外失败 → new-fail，挡。
 */
import { caseMatchesRef, parseCaseRef, type CaseIdentity } from './covers.js'
import { SUITE_ID_RE } from './vocabulary.js'
import { emitYaml } from './yaml-emit.js'
import { IssueSink, asMap, asSeq, checkKeys, field, optionalStr, str, type DecodeIssue } from './yaml-read.js'
import { YamlSubsetError, parseYamlSubset, type YamlNode } from './yaml-subset.js'

export const KNOWN_FAILURES_SCHEMA = 'tenon-known-failures/v1'
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/

export interface KnownFailure {
  readonly suite: string
  /** 用例引用 `<文件> › <用例名>`。 */
  readonly test: string
  readonly reason: string
  readonly link?: string
  /** YYYY-MM-DD；当天仍有效，次日起过期。 */
  readonly expires: string
  readonly added_by: string
}

export type KnownFailuresParseResult =
  | { readonly ok: true; readonly entries: readonly KnownFailure[] }
  | { readonly ok: false; readonly issues: readonly DecodeIssue[] }

function decodeEntry(node: YamlNode, sink: IssueSink): KnownFailure | undefined {
  const map = asMap(node, sink, '已知失败条目')
  if (map === undefined) return undefined
  checkKeys(map, ['suite', 'test', 'reason', 'link', 'expires', 'added_by'], sink, '已知失败条目')
  const suite = str(field(map, 'suite'), sink, '已知失败 suite', map.line, { pattern: SUITE_ID_RE })
  const test = str(field(map, 'test'), sink, '已知失败 test', map.line)
  const reason = str(field(map, 'reason'), sink, '已知失败 reason', map.line, { maxBytes: 1000 })
  const link = optionalStr(field(map, 'link'), sink, '已知失败 link', { pattern: /^https?:\/\/\S+$/, hint: 'http(s) 链接' })
  const expires = str(field(map, 'expires'), sink, '已知失败 expires', map.line, { pattern: DATE_RE, hint: 'YYYY-MM-DD' })
  const addedBy = str(field(map, 'added_by'), sink, '已知失败 added_by', map.line, { maxBytes: 320 })
  if (suite === undefined || test === undefined || reason === undefined || expires === undefined || addedBy === undefined) return undefined
  if (field(map, 'link') !== undefined && link === undefined) return undefined
  if (parseCaseRef(test) === undefined) return sink.add(map.line, `已知失败 test '${test}' 非法（<文件> › <用例名>）`)
  return { suite, test, reason, ...(link === undefined ? {} : { link }), expires, added_by: addedBy }
}

export function parseKnownFailures(text: string): KnownFailuresParseResult {
  let root
  try {
    root = parseYamlSubset(text)
  } catch (error) {
    if (error instanceof YamlSubsetError) return { ok: false, issues: [{ line: error.line, message: error.message.replace(/^第 \d+ 行：/, '') }] }
    throw error
  }
  const sink = new IssueSink()
  const map = asMap(root, sink, '已知失败清单')
  if (map === undefined) return { ok: false, issues: sink.issues }
  checkKeys(map, ['schema', 'entries'], sink, '已知失败清单')
  const schema = str(field(map, 'schema'), sink, 'schema', map.line)
  if (schema !== undefined && schema !== KNOWN_FAILURES_SCHEMA) sink.add(map.line, `schema 必须是 ${KNOWN_FAILURES_SCHEMA}`)
  const entries: KnownFailure[] = []
  for (const node of asSeq(field(map, 'entries'), sink, 'entries') ?? []) {
    const entry = decodeEntry(node, sink)
    if (entry === undefined) continue
    if (entries.some((existing) => existing.suite === entry.suite && existing.test === entry.test)) {
      sink.add(node.line, `已知失败 '${entry.suite}' / '${entry.test}' 重复`)
      continue
    }
    entries.push(entry)
  }
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues }
  return { ok: true, entries }
}

export function serializeKnownFailures(entries: readonly KnownFailure[]): string {
  const sorted = [...entries].sort((left, right) => {
    const a = `${left.suite}\0${left.test}`
    const b = `${right.suite}\0${right.test}`
    return a < b ? -1 : a > b ? 1 : 0
  })
  return emitYaml({
    schema: KNOWN_FAILURES_SCHEMA,
    entries: sorted.map((entry) => ({
      suite: entry.suite, test: entry.test, reason: entry.reason, link: entry.link,
      expires: entry.expires, added_by: entry.added_by,
    })),
  })
}

export function knownFailureExpired(entry: KnownFailure, today: string): boolean {
  return entry.expires < today
}

export function findKnownFailure(
  entries: readonly KnownFailure[],
  suite: string,
  identity: CaseIdentity,
): KnownFailure | undefined {
  return entries.find((entry) => {
    if (entry.suite !== suite) return false
    const ref = parseCaseRef(entry.test)
    return ref !== undefined && caseMatchesRef(ref, identity)
  })
}

export type KnownFailureVerdict =
  | { readonly verdict: 'pass' | 'new-fail' | 'skip' }
  | { readonly verdict: 'known-fail' | 'fixed' | 'expired'; readonly entry: KnownFailure }

/** status 是报告里的最终结果（known-fail 视同 fail 重新判定，清单可能在运行后已变）。 */
export function classifyAgainstKnownFailures(
  entries: readonly KnownFailure[],
  suite: string,
  identity: CaseIdentity,
  status: 'pass' | 'fail' | 'skip' | 'flaky' | 'known-fail',
  today: string,
): KnownFailureVerdict {
  if (status === 'skip') return { verdict: 'skip' }
  const entry = findKnownFailure(entries, suite, identity)
  const failed = status === 'fail' || status === 'known-fail'
  if (entry === undefined) return { verdict: failed ? 'new-fail' : 'pass' }
  if (!failed) return { verdict: 'fixed', entry }
  return knownFailureExpired(entry, today) ? { verdict: 'expired', entry } : { verdict: 'known-fail', entry }
}
