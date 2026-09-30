/**
 * 目录里的项目级「不适用」声明（`not_applicable`）：解码、规范化写出，以及评审批准（纯函数）。
 *
 * 一个种类在本项目根本不适用（纯 JavaScript 项目没有 typecheck、没有前端的项目没有 playwright）时，
 * 每个任务都去登记一条豁免是重复劳动，也是 F6 反复出现的原因。这里把它提到项目级：声明写在
 * `catalog.yaml` 里、带原因，经**一次**人工确认后对所有任务生效（策略不再要求这个种类）。
 *
 * 确认沿用计划豁免的机制：`tenon review request` 把未批准的声明（键 `not-applicable:<kind>`）
 * 和计划豁免一起冻结进清单，`tenon review acknowledge` 只批准清单里仍原样存在的那几条，
 * `approved_by` 记录批准人。批准前的声明不生效，判定层给出 `waiver-unapproved`。
 */
import type { CatalogNotApplicable, TestCatalog } from './catalog-types.js'
import type { PendingWaiver, WaiverSkipReason } from './plan-waivers.js'
import { TEST_KINDS, isTestKind, type TestKind } from './vocabulary.js'
import type { YamlValue } from './yaml-emit.js'
import { IssueSink, asMap, asSeq, checkKeys, field, oneOf, str } from './yaml-read.js'
import type { YamlNode } from './yaml-subset.js'

export const NOT_APPLICABLE_KEY_PREFIX = 'not-applicable:'
const NOT_APPLICABLE_KEYS = ['kind', 'reason', 'approved_by'] as const
const REASON_RULE = { maxBytes: 1000 } as const

export function notApplicableKey(kind: TestKind): string {
  return `${NOT_APPLICABLE_KEY_PREFIX}${kind}`
}

export function isNotApplicableKey(key: string): boolean {
  return key.startsWith(NOT_APPLICABLE_KEY_PREFIX)
}

/** 解码 `not_applicable` 列表；问题逐条进 sink。同一个种类只能声明一次。 */
export function decodeNotApplicable(node: YamlNode | undefined, sink: IssueSink): CatalogNotApplicable[] {
  const out: CatalogNotApplicable[] = []
  const seen = new Set<TestKind>()
  for (const item of asSeq(node, sink, 'not_applicable') ?? []) {
    const map = asMap(item, sink, 'not_applicable 的一项')
    if (map === undefined) continue
    checkKeys(map, NOT_APPLICABLE_KEYS, sink, 'not_applicable 的一项')
    const kind = field(map, 'kind') === undefined
      ? sink.add(map.line, 'not_applicable 的一项缺 kind')
      : oneOf(field(map, 'kind'), sink, 'not_applicable 的 kind', isTestKind, TEST_KINDS)
    const reason = str(field(map, 'reason'), sink, `not_applicable '${kind ?? '?'}' 的 reason`, map.line, REASON_RULE)
    const approvedNode = field(map, 'approved_by')
    const approvedValue = approvedNode?.kind === 'scalar' ? approvedNode.value : undefined
    if (approvedNode !== undefined && approvedValue !== null && (typeof approvedValue !== 'string' || approvedValue === '')) {
      sink.add(approvedNode.line, `not_applicable '${kind ?? '?'}' 的 approved_by 必须是 null 或批准人`)
      continue
    }
    if (kind === undefined || reason === undefined) continue
    if (seen.has(kind)) {
      sink.add(map.line, `not_applicable 重复声明种类 '${kind}'`)
      continue
    }
    seen.add(kind)
    out.push({ kind, reason, approved_by: typeof approvedValue === 'string' ? approvedValue : null })
  }
  return out
}

/** 写出用：没有声明时 undefined（该键整体省略）。 */
export function notApplicableValue(entries: readonly CatalogNotApplicable[] | undefined): YamlValue | undefined {
  if (entries === undefined || entries.length === 0) return undefined
  return entries.map((entry) => ({ kind: entry.kind, reason: entry.reason, approved_by: entry.approved_by }))
}

export function catalogNotApplicable(catalog: TestCatalog, kind: TestKind): CatalogNotApplicable | undefined {
  return catalog.not_applicable?.find((entry) => entry.kind === kind)
}

/** 目录里还没批准的声明，按种类排序（键与理由是评审请求冻结的内容）。 */
export function pendingNotApplicable(catalog: TestCatalog): readonly PendingWaiver[] {
  return (catalog.not_applicable ?? [])
    .filter((entry) => entry.approved_by === null)
    .map((entry) => ({ key: notApplicableKey(entry.kind), reason: entry.reason }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

export interface NotApplicableApproval {
  readonly catalog: TestCatalog
  /** 本次批准的键（`not-applicable:<kind>`），保持选择顺序。 */
  readonly approved: readonly string[]
  readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
}

/**
 * 批准 `selection` 里列出的声明：键相同、理由逐字相同、且当前仍未批准的才写入 `approver`；
 * 其余原样保留并说明原因（与计划豁免的批准同一口径）。`selection` 里非 `not-applicable:` 键的条目忽略。
 */
export function approveNotApplicable(
  catalog: TestCatalog,
  selection: readonly PendingWaiver[],
  approver: string,
): NotApplicableApproval {
  const chosen = new Map(selection.filter((item) => isNotApplicableKey(item.key)).map((item) => [item.key, item.reason]))
  const approved: string[] = []
  const skipped: { key: string; why: WaiverSkipReason }[] = []
  const entries = (catalog.not_applicable ?? []).map((entry): CatalogNotApplicable => {
    const key = notApplicableKey(entry.kind)
    const reason = chosen.get(key)
    if (reason === undefined) return entry
    chosen.delete(key)
    if (entry.approved_by !== null) {
      skipped.push({ key, why: 'already-approved' })
      return entry
    }
    if (entry.reason !== reason) {
      skipped.push({ key, why: 'reason-changed' })
      return entry
    }
    approved.push(key)
    return { ...entry, approved_by: approver }
  })
  for (const key of chosen.keys()) skipped.push({ key, why: 'missing' })
  return { catalog: approved.length === 0 ? catalog : { ...catalog, not_applicable: entries }, approved, skipped }
}

/**
 * 声明一个种类不适用（CLI 用）。同种类同理由已存在 → 原样保留（已批准的不丢批准）；
 * 理由变了 → 批准清零（批准的是旧理由）。按种类排序，保证写出稳定。
 */
export function withNotApplicable(catalog: TestCatalog, kind: TestKind, reason: string): TestCatalog {
  const existing = catalogNotApplicable(catalog, kind)
  if (existing !== undefined && existing.reason === reason) return catalog
  const others = (catalog.not_applicable ?? []).filter((entry) => entry.kind !== kind)
  const entries = [...others, { kind, reason, approved_by: null }]
    .sort((left, right) => TEST_KINDS.indexOf(left.kind) - TEST_KINDS.indexOf(right.kind))
  return { ...catalog, not_applicable: entries }
}

/** 撤销一个种类的不适用声明；没有声明时 removed 为 false。全部撤完后整个键省略。 */
export function withoutNotApplicable(catalog: TestCatalog, kind: TestKind): { readonly catalog: TestCatalog; readonly removed: boolean } {
  const entries = catalog.not_applicable ?? []
  if (!entries.some((entry) => entry.kind === kind)) return { catalog, removed: false }
  const rest = entries.filter((entry) => entry.kind !== kind)
  const bare: TestCatalog = {
    schema: catalog.schema, profiles_env: catalog.profiles_env, suites: catalog.suites, services: catalog.services,
  }
  return { catalog: rest.length === 0 ? bare : { ...catalog, not_applicable: rest }, removed: true }
}
