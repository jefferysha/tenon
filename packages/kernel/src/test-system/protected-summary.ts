/**
 * 受保护配置改动的语义摘要（纯函数）：评审请求里除了路径和摘要，还要让用户一眼看到「到底改了什么」。
 * 目录列出新增 / 改动 / 删除的套件命令和服务启动命令，已知失败清单列出新增 / 改期 / 移出的条目；
 * 基线与工作流只有摘要（内容看 diff）。解析失败或文本缺失时给出说明，不猜测。
 */
import { parseTestCatalog } from './catalog.js'
import type { CatalogService, CatalogSuite } from './catalog-types.js'
import { canonicalJson } from './canonical.js'
import { parseKnownFailures, type KnownFailure } from './known-failures.js'
import type { ProtectedKind } from './protected-files.js'

const MAX_LINES = 8
const MAX_TEXT = 120

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT - 1)}…`
}

function capped(lines: readonly string[]): readonly string[] {
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES), `… 另有 ${lines.length - MAX_LINES} 项`]
}

function describeCatalog(before: string | undefined, after: string | undefined): readonly string[] {
  if (after === undefined) return ['目录已删除']
  const next = parseTestCatalog(after)
  if (!next.ok) return ['目录无法解析（改动后的 catalog.yaml 无效）']
  const prev = before === undefined ? undefined : parseTestCatalog(before)
  const oldSuites = new Map<string, CatalogSuite>(prev?.ok === true ? prev.catalog.suites.map((suite) => [suite.id, suite]) : [])
  const oldServices = new Map<string, CatalogService>(prev?.ok === true ? prev.catalog.services.map((service) => [service.id, service]) : [])
  const lines: string[] = []
  for (const suite of next.catalog.suites) {
    const old = oldSuites.get(suite.id)
    if (old === undefined) lines.push(`新增套件 ${suite.id}：${clip(suite.command)}`)
    else if (canonicalJson(old) !== canonicalJson(suite)) {
      lines.push(old.command === suite.command
        ? `改动套件 ${suite.id}（命令不变）`
        : `改动套件 ${suite.id} 的命令：${clip(old.command)} → ${clip(suite.command)}`)
    }
  }
  for (const id of oldSuites.keys()) if (!next.catalog.suites.some((suite) => suite.id === id)) lines.push(`删除套件 ${id}`)
  for (const service of next.catalog.services) {
    const old = oldServices.get(service.id)
    if (old === undefined) lines.push(`新增服务 ${service.id}：${clip(service.start)}`)
    else if (canonicalJson(old) !== canonicalJson(service)) lines.push(`改动服务 ${service.id}：${clip(old.start)} → ${clip(service.start)}`)
  }
  for (const id of oldServices.keys()) if (!next.catalog.services.some((service) => service.id === id)) lines.push(`删除服务 ${id}`)
  return capped(lines.length === 0 ? ['套件与服务没有变化（其它字段有改动）'] : lines)
}

function knownEntries(text: string | undefined): readonly KnownFailure[] | undefined {
  if (text === undefined) return []
  const parsed = parseKnownFailures(text)
  return parsed.ok ? parsed.entries : undefined
}

function describeKnownFailures(before: string | undefined, after: string | undefined): readonly string[] {
  if (after === undefined) return ['清单已删除']
  const next = knownEntries(after)
  if (next === undefined) return ['清单无法解析（改动后的 known-failures.yaml 无效）']
  const prev = knownEntries(before) ?? []
  const key = (entry: KnownFailure): string => `${entry.suite}\u0000${entry.test}`
  const old = new Map(prev.map((entry) => [key(entry), entry]))
  const lines: string[] = []
  for (const entry of next) {
    const was = old.get(key(entry))
    if (was === undefined) lines.push(`新增已知失败 ${entry.suite} / ${entry.test}（到期 ${entry.expires}；${clip(entry.reason)}）`)
    else if (was.expires !== entry.expires || was.reason !== entry.reason) lines.push(`改动已知失败 ${entry.suite} / ${entry.test}（到期 ${was.expires} → ${entry.expires}）`)
  }
  for (const entry of prev) if (!next.some((item) => key(item) === key(entry))) lines.push(`移出已知失败 ${entry.suite} / ${entry.test}`)
  return capped(lines.length === 0 ? ['条目没有变化'] : lines)
}

/** before = 任务起点时的文件内容（起点没有该文件为 undefined）；after = 现在的内容（已删除为 undefined）。 */
export function describeProtectedChange(kind: ProtectedKind, before: string | undefined, after: string | undefined): readonly string[] {
  if (kind === 'catalog') return describeCatalog(before, after)
  if (kind === 'known-failures') return describeKnownFailures(before, after)
  return []
}
