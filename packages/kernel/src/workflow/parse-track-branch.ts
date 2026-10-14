/**
 * `tracks.<id>` 分支新键的窄解析：`spec`、`route`、`automation`。块写法与单行 flow map 写法等价。
 * 这里只做语法层——闭集键、必填项、整数 / 布尔字面量、单行列表；值域（范围、字符集、个数）留给
 * compile-track-branch.ts。未知字段行 fail-loud 并点名该键。
 */
import type { TrackAutomation, TrackRoute, TrackSpec } from './types.js'
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { indentOf, parseInlineList, parseInlineMap } from './parse-primitives.js'

type RawValue = string | string[]
type RawMapping = ReadonlyMap<string, RawValue>

const ROUTE_KEYS: readonly string[] = ['keywords', 'exclude', 'priority', 'fallback']
const AUTOMATION_KEYS: readonly string[] = ['eligible', 'enqueue_after_spec']

function fail(message: string): never {
  throw new Error(`workflow 解析错误：${message}`)
}

/** `route:` / `automation:` 之后的键值：单行 `{ a: b }` 或其下缩进更深的 `k: v` 行（值是标量或单行列表）。 */
function readMapping(cur: Cursor, keyIndent: number, inline: string, what: string): RawMapping {
  const out = new Map<string, RawValue>()
  if (inline !== '') {
    for (const [key, value] of Object.entries(parseInlineMap(inline))) out.set(key, value)
    return out
  }
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= keyIndent) break
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line)
    if (!match) fail(`${what} 出现未知字段行 '${line.trim()}'`)
    const key = match[1] ?? ''
    if (out.has(key)) fail(`${what}.${key} 重复声明`)
    const value = match[2] ?? ''
    out.set(key, value.startsWith('[') ? parseInlineList(value) : value)
    cur.i++
  }
  return out
}

function rejectUnknownKeys(raw: RawMapping, allowed: readonly string[], what: string): void {
  for (const key of raw.keys()) {
    if (!allowed.includes(key)) fail(`${what} 出现未知字段 '${key}'（闭集：${allowed.join(' / ')}）`)
  }
}

function scalar(raw: RawMapping, key: string, what: string): string | undefined {
  const value = raw.get(key)
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail(`${what}.${key} 必须是单个值，不是列表`)
  return value
}

function list(raw: RawMapping, key: string, what: string): string[] | undefined {
  const value = raw.get(key)
  if (value === undefined) return undefined
  if (typeof value === 'string') fail(`${what}.${key} 必须是 [a, b] 形态的单行列表（实际 '${value}'）`)
  return value
}

function bool(raw: RawMapping, key: string, what: string): boolean | undefined {
  const value = scalar(raw, key, what)
  if (value === undefined) return undefined
  if (value !== 'true' && value !== 'false') fail(`${what}.${key} 必须是 true 或 false（实际 '${value}'）`)
  return value === 'true'
}

function parseBranchSpec(raw: string, id: string): TrackSpec {
  if (raw !== 'openspec' && raw !== 'none') fail(`分支 '${id}' 的 spec 只支持 openspec 或 none（实际 '${raw}'）`)
  return raw
}

/** `keywords`、`priority` 必填；`exclude` 缺省 []，`fallback` 缺省 false。 */
function parseRouteMapping(cur: Cursor, keyIndent: number, inline: string, what: string): TrackRoute {
  const raw = readMapping(cur, keyIndent, inline, what)
  rejectUnknownKeys(raw, ROUTE_KEYS, what)
  const keywords = list(raw, 'keywords', what)
  if (keywords === undefined) fail(`${what} 缺 keywords（形如 [a, b] 的单行列表）`)
  const priority = scalar(raw, 'priority', what)
  if (priority === undefined) fail(`${what} 缺 priority`)
  if (!/^-?\d+$/.test(priority)) fail(`${what}.priority 必须是整数（实际 '${priority}'）`)
  return {
    keywords,
    exclude: list(raw, 'exclude', what) ?? [],
    priority: Number(priority),
    fallback: bool(raw, 'fallback', what) ?? false,
  }
}

/** 平铺工作流顶层的 `route:`（调用方已吃掉 `route:` 行，`inline` 是同一行冒号后的部分）；与分支 route 同一套语法。 */
export function parseTopLevelRoute(cur: Cursor, inline: string): TrackRoute {
  return parseRouteMapping(cur, 0, inline, '顶层 route')
}

/** `eligible` 必填；`enqueue_after_spec` 缺省 false。 */
function parseBranchAutomation(cur: Cursor, keyIndent: number, inline: string, id: string): TrackAutomation {
  const what = `分支 '${id}' 的 automation`
  const raw = readMapping(cur, keyIndent, inline, what)
  rejectUnknownKeys(raw, AUTOMATION_KEYS, what)
  const eligible = bool(raw, 'eligible', what)
  if (eligible === undefined) fail(`${what} 缺 eligible（true 或 false）`)
  return { eligible, enqueueAfterSpec: bool(raw, 'enqueue_after_spec', what) ?? false }
}

/** 一个分支里已读到的新键；只含出现过的键。 */
export interface BranchPolicyDraft {
  spec?: TrackSpec
  route?: TrackRoute
  automation?: TrackAutomation
}

/**
 * 分支内当前行若是 `spec:` / `route:` / `automation:`，就连同 route / automation 的子行一起消费并写进 draft，
 * 返回 true；其他行原样不动，返回 false。同一个键重复声明 fail-loud。
 */
export function parseBranchPolicyLine(cur: Cursor, id: string, draft: BranchPolicyDraft): boolean {
  const line = cur.lines[cur.i] ?? ''
  const match = /^\s*(spec|route|automation):\s*(.*?)\s*$/.exec(line)
  if (!match) return false
  const key = match[1]
  const rest = match[2] ?? ''
  const keyIndent = indentOf(line)
  if (key === 'spec') {
    if (rest === '') fail(`分支 '${id}' 的 spec 缺值（openspec 或 none）`)
    if (draft.spec !== undefined) fail(`分支 '${id}' 重复声明 spec`)
    draft.spec = parseBranchSpec(rest, id)
    cur.i++
    return true
  }
  cur.i++
  if (key === 'route') {
    if (draft.route !== undefined) fail(`分支 '${id}' 重复声明 route`)
    draft.route = parseRouteMapping(cur, keyIndent, rest, `分支 '${id}' 的 route`)
    return true
  }
  // 正则只放行这三个键，剩下的只能是 automation。
  if (draft.automation !== undefined) fail(`分支 '${id}' 重复声明 automation`)
  draft.automation = parseBranchAutomation(cur, keyIndent, rest, id)
  return true
}
