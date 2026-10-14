/**
 * 测试目录的按节点写回：只替换 before → after 实际变化的节点所在的行，其余字节（注释、空行、排版、换行符）原样保留。
 *
 * 节点分三层：顶层键（`profile`、`profiles_env`、`suites`、`services`、`not_applicable`、`levels`）、
 * `suites`（以及 `services`、`not_applicable`）的条目、条目里的键。
 *   · 新增：条目追加在所属列表末尾，键追加在条目末尾，标量列表的新项追加在该列表末尾，顶层键追加在文件末尾；
 *   · 删除：只去掉该节点自己的行——紧挨在它前面的注释行、分隔空行属于下一个节点，留着；
 *   · 修改：只替换该节点的行区间（被改键内部的行内注释随之丢失，这是唯一不保留的情形）。
 * 单个节点按 `serializeTestCatalog` 同一套规则发射（catalogValue / emitEntries / emitItems），
 * 写回后整份重新解析，必须与 after 完全一致，否则抛错（调用方不写盘）。
 * 原文用了写不进行区间的形态（flow 写法的条目、套件顺序变了、列表里夹着不能逐项对上的内容）时，退回替换所属的整个节点。
 */
import { canonicalJson } from './canonical.js'
import { catalogValue, formatCatalogIssues, parseTestCatalog } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import {
  applyLineEdits, contentColumn, isDashLine, lastContentLine, leadingSpaces, splitSegments, type LineEdit, type Segment,
} from './catalog-patch-lines.js'
import { emitEntries, emitItems, type YamlValue } from './yaml-emit.js'
import { parseYamlSubset, type YamlMap, type YamlMapEntry } from './yaml-subset.js'

type ValueMap = { readonly [key: string]: YamlValue | undefined }

interface Ctx {
  readonly segments: readonly Segment[]
  readonly edits: LineEdit[]
}

/** 一个映射（根或列表条目）在原文里占的位置。 */
interface Site {
  readonly entries: readonly YamlMapEntry[]
  /** 本映射所占区域的结束行（1 起、不含）：下一个同级节点的起始行，或文件末尾之后。 */
  readonly limit: number
  /** 键所在的列。 */
  readonly column: number
  /** 第一个条目与 `- ` 同行时，那一行的行号：替换它要保住 `- ` 前缀。 */
  readonly dashLine?: number
  /** 新增条目插入的行下标（0 起）。 */
  readonly appendAt: number
}

/** 返回 true = 已自行处理（并写入了 edits）；false = 由调用方替换整个键。 */
type Hook = (ctx: Ctx, site: Site, entry: YamlMapEntry, key: string, was: YamlValue | undefined, now: YamlValue) => boolean

/** 条目的身份键：列表按它对上原文里的条目，而不是按下标。 */
const LIST_IDENTITY: Readonly<Record<string, string>> = { suites: 'id', services: 'id', not_applicable: 'kind' }

function isSeq(value: YamlValue | undefined): value is readonly YamlValue[] {
  return Array.isArray(value)
}

function isMap(value: YamlValue | undefined): value is ValueMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(left: YamlValue | undefined, right: YamlValue | undefined): boolean {
  return left === undefined || right === undefined ? left === right : canonicalJson(left) === canonicalJson(right)
}

function textOf(ctx: Ctx, line: number): string {
  return ctx.segments[line - 1]?.text ?? ''
}

function limitAfter(site: Site, entry: YamlMapEntry): number {
  return site.entries[site.entries.indexOf(entry) + 1]?.line ?? site.limit
}

function entryRange(ctx: Ctx, site: Site, entry: YamlMapEntry): { readonly start: number; readonly end: number } {
  return { start: entry.line - 1, end: lastContentLine(ctx.segments, entry.line, limitAfter(site, entry)) }
}

function replaceEntry(ctx: Ctx, site: Site, entry: YamlMapEntry, key: string, value: YamlValue): LineEdit {
  const [first = '', ...rest] = emitEntries({ [key]: value }, ' '.repeat(site.column))
  const head = entry.line === site.dashLine ? textOf(ctx, entry.line).slice(0, site.column) + first.slice(site.column) : first
  return { ...entryRange(ctx, site, entry), lines: [head, ...rest] }
}

function patchMap(ctx: Ctx, site: Site, was: ValueMap, now: ValueMap, hook: Hook): void {
  const appended: string[] = []
  for (const key of [...Object.keys(now), ...Object.keys(was).filter((name) => !(name in now))]) {
    const before = was[key]
    const after = now[key]
    if (same(before, after)) continue
    const entry = site.entries.find((item) => item.key === key)
    if (after === undefined) {
      if (entry !== undefined) ctx.edits.push({ ...entryRange(ctx, site, entry), lines: [] })
    } else if (entry === undefined) {
      appended.push(...emitEntries({ [key]: after }, ' '.repeat(site.column)))
    } else if (!hook(ctx, site, entry, key, before, after)) {
      ctx.edits.push(replaceEntry(ctx, site, entry, key, after))
    }
  }
  if (appended.length > 0) ctx.edits.push({ start: site.appendAt, end: site.appendAt, lines: appended })
}

/** 标量列表只多了末尾的新项：新项逐行插在最后一项之后，原来的行一行不动。 */
const appendToList: Hook = (ctx, _site, entry, _key, was, now) => {
  const node = entry.value
  if (!isSeq(was) || !isSeq(now) || node.kind !== 'seq' || node.items.length !== was.length || was.length === 0) return false
  const scalar = (item: YamlValue | undefined): boolean => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
  if (now.length <= was.length || !now.every(scalar) || !was.every((item, index) => same(item, now[index]))) return false
  const last = node.items.at(-1)
  if (last === undefined || (node.items[0]?.line ?? 0) <= entry.line) return false
  if (!node.items.every((item, index) => item.kind === 'scalar' && item.value === was[index] && isDashLine(textOf(ctx, item.line)))) return false
  const pad = ' '.repeat(leadingSpaces(textOf(ctx, last.line)))
  ctx.edits.push({ start: last.line, end: last.line, lines: emitItems(now.slice(was.length), pad) })
  return true
}

function idOf(value: YamlValue | undefined, idKey: string): string | undefined {
  const id = isMap(value) ? value[idKey] : undefined
  return typeof id === 'string' ? id : undefined
}

function textIdOf(item: YamlMap, idKey: string): unknown {
  const node = item.entries.find((entry) => entry.key === idKey)?.value
  return node?.kind === 'scalar' ? node.value : undefined
}

/** 整个条目换成新发射的块式条目（flow 写法的条目、或第一个键被删掉时用）。 */
function replaceItem(ctx: Ctx, item: YamlMap, limit: number, value: YamlValue): void {
  const pad = ' '.repeat(leadingSpaces(textOf(ctx, item.line)))
  ctx.edits.push({ start: item.line - 1, end: lastContentLine(ctx.segments, item.line, limit), lines: emitItems([value], pad) })
}

/** 第三层：同一个条目里按键逐个比较。 */
function patchItem(ctx: Ctx, item: YamlMap, limit: number, was: YamlValue | undefined, now: YamlValue | undefined): void {
  if (now === undefined) return
  const dashText = textOf(ctx, item.line)
  const first = item.entries[0]
  if (!isMap(was) || !isMap(now) || first === undefined || /^ *-\s*\{/.test(dashText)
    || (now[first.key] === undefined && was[first.key] !== undefined)) {
    replaceItem(ctx, item, limit, now)
    return
  }
  const site: Site = {
    entries: item.entries, limit, column: contentColumn(dashText), dashLine: item.line,
    appendAt: lastContentLine(ctx.segments, item.line, limit),
  }
  patchMap(ctx, site, was, now, appendToList)
}

/** 第二层：列表条目按身份键对上原文——删的删、改的改、新增的追加在列表末尾。对不上时返回 false，由调用方换整个键。 */
const patchObjectList: Hook = (ctx, site, entry, key, was, now) => {
  const idKey = LIST_IDENTITY[key]
  const node = entry.value
  if (idKey === undefined || !isSeq(was) || !isSeq(now) || now.length === 0 || was.length === 0) return false
  if (node.kind !== 'seq' || node.items.length !== was.length || (node.items[0]?.line ?? 0) <= entry.line) return false
  const oldIds = was.map((item) => idOf(item, idKey))
  const newIds = now.map((item) => idOf(item, idKey))
  const items: YamlMap[] = []
  for (const [index, item] of node.items.entries()) {
    if (item.kind !== 'map' || textIdOf(item, idKey) !== oldIds[index] || !isDashLine(textOf(ctx, item.line))) return false
    items.push(item)
  }
  if (oldIds.includes(undefined) || newIds.includes(undefined)) return false
  const added = newIds.filter((id) => !oldIds.includes(id))
  if (canonicalJson([...oldIds.filter((id) => newIds.includes(id)), ...added]) !== canonicalJson(newIds)) return false
  const limit = limitAfter(site, entry)
  for (const [index, item] of items.entries()) {
    const itemLimit = items[index + 1]?.line ?? limit
    const at = newIds.indexOf(oldIds[index])
    if (at < 0) ctx.edits.push({ start: item.line - 1, end: lastContentLine(ctx.segments, item.line, itemLimit), lines: [] })
    else if (!same(was[index], now[at])) patchItem(ctx, item, itemLimit, was[index], now[at])
  }
  const last = items.at(-1)
  if (added.length > 0 && last !== undefined) {
    const at = lastContentLine(ctx.segments, last.line, limit)
    const pad = ' '.repeat(leadingSpaces(textOf(ctx, last.line)))
    ctx.edits.push({ start: at, end: at, lines: emitItems(added.flatMap((id) => now.filter((item) => idOf(item, idKey) === id)), pad) })
  }
  return true
}

const patchTopLevel: Hook = (ctx, site, entry, key, was, now) =>
  patchObjectList(ctx, site, entry, key, was, now) || appendToList(ctx, site, entry, key, was, now)

/**
 * 只重写 before → after 变化的节点所在的行。before 必须是 text 解析出的目录；返回的文本一定能被 parseTestCatalog
 * 解析成与 after 完全一致的目录，否则抛错。
 */
export function patchCatalogText(text: string, before: TestCatalog, after: TestCatalog): string {
  const current = parseTestCatalog(text)
  if (!current.ok) throw new Error(`目录原文无法解析：${formatCatalogIssues(current.issues).slice(0, 3).join('；')}`)
  if (canonicalJson(current.catalog) !== canonicalJson(before)) throw new Error('目录原文与改动前的目录不一致（文件在读取之后又被改过），拒绝改写')
  const root = parseYamlSubset(text)
  if (root.kind !== 'map') throw new Error('目录原文无法解析：顶层不是映射')
  const segments = splitSegments(text)
  const ctx: Ctx = { segments, edits: [] }
  const site: Site = { entries: root.entries, limit: segments.length + 1, column: 0, appendAt: segments.length }
  patchMap(ctx, site, catalogValue(before), catalogValue(after), patchTopLevel)
  if (ctx.edits.length === 0) return text
  const patched = applyLineEdits(segments, ctx.edits)
  const reparsed = parseTestCatalog(patched)
  if (!reparsed.ok) throw new Error(`改动后的目录不合法：${formatCatalogIssues(reparsed.issues).slice(0, 3).join('；')}`)
  if (canonicalJson(reparsed.catalog) !== canonicalJson(after)) throw new Error('改动后的目录与预期不一致，拒绝写盘')
  return patched
}
