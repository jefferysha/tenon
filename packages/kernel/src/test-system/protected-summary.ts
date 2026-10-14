/**
 * 受保护配置改动的语义摘要（纯函数）：评审请求里除了路径和摘要，还要让用户一眼看到「到底改了什么」。
 * 目录列出新增 / 改动 / 删除的套件命令和服务启动命令，也列出档位定义与项目级不适用声明的变化；
 * 已知失败清单列出新增 / 改期 / 移出的条目；
 * 基线与工作流只有摘要（内容看 diff）。解析失败或文本缺失时给出说明，不猜测。
 */
import { parseTestCatalog } from './catalog.js'
import type { CatalogNotApplicable, CatalogService, CatalogSuite } from './catalog-types.js'
import { canonicalJson } from './canonical.js'
import { parseKnownFailures, type KnownFailure } from './known-failures.js'
import { describeLevelChanges } from './levels-diff.js'
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

/**
 * 项目级不适用声明按 kind 对齐：新增 / 删除 / 理由变了各一行；只有 approved_by 变化（评审批准写入）不出行。
 * 理由原文不进摘要：它已在待批准清单里经清理后展示。
 */
function describeNotApplicable(before: readonly CatalogNotApplicable[], after: readonly CatalogNotApplicable[]): readonly string[] {
  const old = new Map(before.map((entry) => [entry.kind, entry]))
  const lines: string[] = []
  for (const entry of after) {
    const was = old.get(entry.kind)
    if (was === undefined) lines.push(`新增项目级不适用声明 ${entry.kind}（批准后对全项目生效）`)
    else if (was.reason !== entry.reason) lines.push(`改动项目级不适用声明 ${entry.kind} 的理由`)
  }
  for (const entry of before) if (!after.some((item) => item.kind === entry.kind)) lines.push(`删除项目级不适用声明 ${entry.kind}`)
  return lines
}

function describeCatalog(before: string | undefined, after: string | undefined): readonly string[] {
  if (after === undefined) return ['目录已删除']
  const next = parseTestCatalog(after)
  if (!next.ok) return ['目录无法解析（改动后的 catalog.yaml 无效）']
  const prev = before === undefined ? undefined : parseTestCatalog(before)
  const old = prev?.ok === true ? prev.catalog : undefined
  const oldSuites = new Map<string, CatalogSuite>(old?.suites.map((suite) => [suite.id, suite]))
  const oldServices = new Map<string, CatalogService>(old?.services.map((service) => [service.id, service]))
  // 门槛（档位与不适用声明）与命令（套件与服务）分两段各自截到 MAX_LINES：门槛被放宽、命令被换掉，用户批准前都必须看得见，
  // 哪一段改得再多也不能把另一段挤出摘要。门槛段在前。
  const thresholds = [
    ...describeLevelChanges(old?.levels, next.catalog.levels),
    ...describeNotApplicable(old?.not_applicable ?? [], next.catalog.not_applicable ?? []),
  ]
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
  if (thresholds.length === 0 && lines.length === 0) return ['套件、服务、档位定义与不适用声明都没有变化（其它字段有改动）']
  return [...capped(thresholds), ...capped(lines)]
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
