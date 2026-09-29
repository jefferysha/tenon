/**
 * 覆盖率报告 → 百分比（lines / branches / functions / statements，可选 changed_lines）。
 *   · istanbul-summary：`coverage-summary.json` 的 `total`；changed_lines 需要旁边的 `coverage-final.json`（按语句起始行）
 *   · lcov：`SF` / `DA` / `LF` `LH` / `FNF` `FNH` / `BRF` `BRH`
 *   · cobertura：根元素的 line-rate / branch-rate；changed_lines 用 `class@filename` 下的 `line@number` `@hits`
 * changed_lines = 本任务新增 / 修改的可执行行里被覆盖的比例；没有可执行的改动行时记 100（没有东西需要覆盖）。
 * 分母为 0 的指标不输出，门禁按「未报告」处理，不会被记成 0% 或 100%。
 */
import type { CoverageResult } from '@tenon/kernel'
import { asNumber, asString, isRecord, parseJson } from './json.js'
import { repoPath } from './text.js'
import type { CoverageContext, CoverageReport } from './types.js'
import { childrenNamed, descendants, parseXml, XmlError } from './xml.js'

type Mutable = { -readonly [K in keyof CoverageResult]: CoverageResult[K] }
type LineHits = ReadonlyMap<string, ReadonlyMap<number, number>>

function pct(covered: number, total: number): number | undefined {
  return total > 0 ? Number(((covered / total) * 100).toFixed(2)) : undefined
}

function changedLinesPct(hits: LineHits, changed: ReadonlyMap<string, ReadonlySet<number>>): number {
  let executable = 0
  let covered = 0
  for (const [file, lines] of changed) {
    const known = hits.get(file)
    if (known === undefined) continue
    for (const line of lines) {
      const count = known.get(line)
      if (count === undefined) continue
      executable++
      if (count > 0) covered++
    }
  }
  return executable === 0 ? 100 : Number(((covered / executable) * 100).toFixed(2))
}

function withChanged(base: Mutable, hits: LineHits | undefined, ctx: CoverageContext): CoverageResult {
  if (ctx.changedLines !== undefined && hits !== undefined) base.changed_lines = changedLinesPct(hits, ctx.changedLines)
  return base
}

function summaryPct(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const total = asNumber(value.total)
  const covered = asNumber(value.covered)
  if (total !== undefined && covered !== undefined && total > 0) return pct(covered, total)
  const direct = asNumber(value.pct)
  return direct === undefined || total === 0 ? undefined : Number(direct.toFixed(2))
}

/** coverage-final.json → 文件 → 行 → 命中数（语句起始行；同一行多条语句取最大命中）。 */
function istanbulLineHits(detailText: string, ctx: CoverageContext): LineHits | undefined {
  const parsed = parseJson(detailText)
  if (!parsed.ok || !isRecord(parsed.value)) return undefined
  const out = new Map<string, Map<number, number>>()
  for (const [key, entry] of Object.entries(parsed.value)) {
    if (!isRecord(entry) || !isRecord(entry.statementMap) || !isRecord(entry.s)) continue
    const lines = new Map<number, number>()
    for (const [id, location] of Object.entries(entry.statementMap)) {
      const start = isRecord(location) && isRecord(location.start) ? asNumber(location.start.line) : undefined
      const hits = asNumber(entry.s[id]) ?? 0
      if (start !== undefined) lines.set(start, Math.max(lines.get(start) ?? 0, hits))
    }
    out.set(repoPath(ctx, asString(entry.path) ?? key), lines)
  }
  return out
}

function parseIstanbulSummary(text: string, ctx: CoverageContext): CoverageReport {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  if (!isRecord(parsed.value) || !isRecord(parsed.value.total)) return { ok: false, reason: '缺少 total：不是 istanbul coverage-summary.json' }
  const total = parsed.value.total
  const coverage: Mutable = {}
  for (const metric of ['lines', 'branches', 'functions', 'statements'] as const) {
    const value = summaryPct(total[metric])
    if (value !== undefined) coverage[metric] = value
  }
  const hits = ctx.detailText === undefined ? undefined : istanbulLineHits(ctx.detailText, ctx)
  return { ok: true, coverage: withChanged(coverage, hits, ctx) }
}

function parseLcov(text: string, ctx: CoverageContext): CoverageReport {
  const totals = { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0 }
  const hits = new Map<string, Map<number, number>>()
  let current: Map<number, number> | undefined
  let records = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      current = new Map()
      hits.set(repoPath(ctx, line.slice(3)), current)
      records++
    } else if (line.startsWith('DA:') && current !== undefined) {
      const [number, count] = line.slice(3).split(',')
      const at = Number(number)
      const times = Number(count)
      if (Number.isInteger(at) && Number.isFinite(times)) current.set(at, Math.max(current.get(at) ?? 0, times))
    } else if (line.startsWith('LF:')) totals.lf += Number(line.slice(3)) || 0
    else if (line.startsWith('LH:')) totals.lh += Number(line.slice(3)) || 0
    else if (line.startsWith('FNF:')) totals.fnf += Number(line.slice(4)) || 0
    else if (line.startsWith('FNH:')) totals.fnh += Number(line.slice(4)) || 0
    else if (line.startsWith('BRF:')) totals.brf += Number(line.slice(4)) || 0
    else if (line.startsWith('BRH:')) totals.brh += Number(line.slice(4)) || 0
  }
  if (records === 0) return { ok: false, reason: '没有 SF 记录：不是 lcov 报告' }
  const coverage: Mutable = {}
  const lines = pct(totals.lh, totals.lf)
  const functions = pct(totals.fnh, totals.fnf)
  const branches = pct(totals.brh, totals.brf)
  if (lines !== undefined) coverage.lines = lines
  if (functions !== undefined) coverage.functions = functions
  if (branches !== undefined) coverage.branches = branches
  return { ok: true, coverage: withChanged(coverage, hits, ctx) }
}

function rate(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? Number((parsed * 100).toFixed(2)) : undefined
}

function parseCobertura(text: string, ctx: CoverageContext): CoverageReport {
  let root
  try {
    root = parseXml(text)
  } catch (error) {
    return { ok: false, reason: `不是合法的 Cobertura XML：${error instanceof XmlError ? error.message : '解析失败'}` }
  }
  if (root.name !== 'coverage') return { ok: false, reason: `根元素是 <${root.name}>，不是 Cobertura 的 coverage` }
  const hits = new Map<string, Map<number, number>>()
  for (const element of descendants(root).filter((node) => node.name === 'class')) {
    const filename = element.attrs.filename
    if (filename === undefined) continue
    const path = repoPath(ctx, filename)
    const lines = hits.get(path) ?? new Map<number, number>()
    for (const container of childrenNamed(element, 'lines')) {
      for (const line of childrenNamed(container, 'line')) {
        const number = Number(line.attrs.number)
        const count = Number(line.attrs.hits)
        if (Number.isInteger(number) && Number.isFinite(count)) lines.set(number, Math.max(lines.get(number) ?? 0, count))
      }
    }
    hits.set(path, lines)
  }
  const coverage: Mutable = {}
  let executable = 0
  let covered = 0
  for (const lines of hits.values()) {
    for (const count of lines.values()) {
      executable++
      if (count > 0) covered++
    }
  }
  const lines = rate(root.attrs['line-rate']) ?? pct(covered, executable)
  if (lines !== undefined) coverage.lines = lines
  const branches = rate(root.attrs['branch-rate'])
  const branchesValid = Number(root.attrs['branches-valid'])
  if (branches !== undefined && !(Number.isFinite(branchesValid) && branchesValid === 0)) coverage.branches = branches
  if (lines === undefined && branches === undefined) return { ok: false, reason: 'Cobertura 报告没有 line-rate / branch-rate，也没有 line 记录' }
  return { ok: true, coverage: withChanged(coverage, hits, ctx) }
}

export function parseCoverageReport(format: 'istanbul-summary' | 'lcov' | 'cobertura', text: string, ctx: CoverageContext): CoverageReport {
  if (format === 'istanbul-summary') return parseIstanbulSummary(text, ctx)
  if (format === 'lcov') return parseLcov(text, ctx)
  return parseCobertura(text, ctx)
}
