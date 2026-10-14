/**
 * `tracks.<id>` 分支新键的编译（定义层 → IR）：闭集键、值域，补齐 route 的默认项。结构化输入
 * （server 的 decodeWorkflowDef 直调）与 YAML 走同一条校验链。三个键都只在声明时进入 IR，
 * 没声明的分支编译成与之前逐字相同的 IR，所以旧工作流指纹不变。
 */
import type { TrackAutomation, TrackRoute, TrackSpec } from './types.js'

const ROUTE_KEYS: ReadonlySet<string> = new Set(['keywords', 'exclude', 'priority', 'fallback'])
const AUTOMATION_KEYS: ReadonlySet<string> = new Set(['eligible', 'enqueueAfterSpec'])

/** 每个列表最多的路由词数与每个词的最大长度：路由表是有界的纯数据。 */
const MAX_ROUTE_TERMS = 64
const MAX_ROUTE_TERM_LENGTH = 64
/**
 * 路由词写在 `[a, b]` 单行列表里并进入路由缓存：逗号与方括号 / 花括号会让 serialize → parse 不能往返，
 * 控制字符与行 / 段分隔符会破坏逐行缓存。
 */
const ROUTE_TERM_RE = /^[^\p{Cc}\p{Zl}\p{Zp},[\]{}]+$/u

/** 一个分支声明的新键；没声明的键不出现。 */
export interface BranchPolicy {
  readonly spec?: TrackSpec
  readonly route?: TrackRoute
  readonly automation?: TrackAutomation
}

function compileError(path: string, message: string): never {
  throw new Error(`compileWorkflow: ${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    compileError(path, `必须是对象（实际 ${JSON.stringify(value)}）`)
  }
  return value as Record<string, unknown>
}

function rejectExtraKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      compileError(path, `出现该变体不接受的附加键 '${key}'（闭集：${[...allowed].join('/')}）`)
    }
  }
}

function compileBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') compileError(path, `必须是 true | false（实际 ${JSON.stringify(value)}）`)
  return value
}

function compileRouteTerms(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) compileError(path, `必须是数组（实际 ${JSON.stringify(value)}）`)
  const terms: readonly unknown[] = value
  if (terms.length > MAX_ROUTE_TERMS) compileError(path, `最多 ${MAX_ROUTE_TERMS} 项（实际 ${terms.length}）`)
  return terms.map((term, index) => {
    const termPath = `${path}[${index}]`
    if (typeof term !== 'string' || term === '' || term !== term.trim() || term.length > MAX_ROUTE_TERM_LENGTH || !ROUTE_TERM_RE.test(term)) {
      compileError(termPath, `必须是 1–${MAX_ROUTE_TERM_LENGTH} 字符、首尾无空白、不含逗号 / 方括号 / 花括号 / 控制字符的字符串（实际 ${JSON.stringify(term)}）`)
    }
    return term
  })
}

export function compileBranchSpec(value: unknown, path: string): TrackSpec | undefined {
  if (value === undefined) return undefined
  if (value !== 'openspec' && value !== 'none') compileError(path, `必须是 'openspec' | 'none'（实际 ${JSON.stringify(value)}）`)
  return value
}

export function compileBranchRoute(value: unknown, path: string): TrackRoute | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, path)
  rejectExtraKeys(record, ROUTE_KEYS, path)
  const priority = record.priority
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0 || Object.is(priority, -0)) {
    compileError(`${path}.priority`, `必须是非负安全整数且不含 -0（实际 ${JSON.stringify(priority)}）`)
  }
  return {
    keywords: compileRouteTerms(record.keywords, `${path}.keywords`),
    exclude: record.exclude === undefined ? [] : compileRouteTerms(record.exclude, `${path}.exclude`),
    priority,
    fallback: record.fallback === undefined ? false : compileBoolean(record.fallback, `${path}.fallback`),
  }
}

export function compileBranchAutomation(value: unknown, path: string): TrackAutomation | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, path)
  rejectExtraKeys(record, AUTOMATION_KEYS, path)
  return {
    eligible: compileBoolean(record.eligible, `${path}.eligible`),
    enqueueAfterSpec: record.enqueueAfterSpec === undefined ? false : compileBoolean(record.enqueueAfterSpec, `${path}.enqueueAfterSpec`),
  }
}

/** 一个分支（已是对象）的 spec / route / automation；顺序固定，只含声明了的键。 */
export function compileBranchPolicy(
  branch: { readonly spec?: unknown; readonly route?: unknown; readonly automation?: unknown },
  path: string,
): BranchPolicy {
  const spec = compileBranchSpec(branch.spec, `${path}.spec`)
  const route = compileBranchRoute(branch.route, `${path}.route`)
  const automation = compileBranchAutomation(branch.automation, `${path}.automation`)
  return {
    ...(spec === undefined ? {} : { spec }),
    ...(route === undefined ? {} : { route }),
    ...(automation === undefined ? {} : { automation }),
  }
}
