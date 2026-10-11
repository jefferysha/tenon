/**
 * `tenon tracks list/show` —— 工作流分支（轨道）的**只读**视图。
 *
 * 轨道只是工作流 YAML 里的 `tracks.<id>` 分支，身份是「工作流 + 轨道 id」；没有 `tracks:` 的平铺工作流
 * 只有一条与工作流同名的隐式轨道。没有任何独立的轨道登记表：列出的是项目可用的全部工作流
 * （项目 → 全局存储 → 插件模板）里的分支，写坏的工作流跳过并警告，不挡住其余。
 *
 * 退出码：0 成功；1 一切错误（未知轨道 / 轨道名有歧义）。JSON 模式 stdout 只放 JSON、警告与错误走 stderr。
 */
import { listWorkflowTracks } from '@tenon/kernel'
import type { WorkflowTrackEntry, WorkflowTrackListing } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { warnIgnoredTracksFile } from './tracks-file-hint.js'

export interface TracksCommonOpts {
  json?: boolean
}

const idOf = (entry: WorkflowTrackEntry): string => `${entry.workflow}:${entry.branch.id}`

/** 参与自动路由 = 分支写了 `route`。 */
const routable = (entry: WorkflowTrackEntry): boolean => entry.branch.route !== undefined

function trackJson(entry: WorkflowTrackEntry): Record<string, unknown> {
  const { branch } = entry
  return {
    workflow: entry.workflow,
    track: branch.id,
    label: branch.label,
    implicit: branch.implicit,
    spec: branch.spec,
    routable: routable(entry),
    ...(branch.route === undefined ? {} : { route: branch.route }),
    automation: branch.automation,
    steps: branch.steps.map((step) => step.id),
  }
}

/** 读全部工作流的分支；写坏的工作流各输出一行警告（stderr）。 */
function loadListing(deps: CliDeps): WorkflowTrackListing {
  warnIgnoredTracksFile(deps)
  const listing = listWorkflowTracks(deps.cwd)
  for (const skipped of listing.skipped) deps.io.err(`WARN: 工作流 '${skipped.workflow}' 已跳过：${skipped.reason}`)
  return listing
}

function renderList(deps: CliDeps, entries: readonly WorkflowTrackEntry[]): void {
  const header = ['WORKFLOW:TRACK', 'LABEL', 'ROUTABLE']
  const rows = entries.map((entry) => [idOf(entry), entry.branch.label, routable(entry) ? 'yes' : 'no'])
  // 列宽取 header 与各行的最大值——不截断、不省略（名称一律完整显示，排版规整）。
  const widths = header.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => (row[column] ?? '').length)))
  const fmt = (cells: string[]) =>
    cells.map((value, column) => value.padEnd(widths[column] ?? value.length)).join('  ').trimEnd()
  deps.io.out(fmt(header))
  for (const row of rows) deps.io.out(fmt(row))
}

function renderShow(deps: CliDeps, entry: WorkflowTrackEntry): void {
  const { branch } = entry
  deps.io.out(`workflow: ${entry.workflow}`)
  deps.io.out(`track: ${branch.id}`)
  deps.io.out(`label: ${branch.label}`)
  deps.io.out(`implicit: ${branch.implicit}`)
  deps.io.out(`spec: ${branch.spec}`)
  deps.io.out(
    branch.route === undefined
      ? 'route: none'
      : `route: keywords=${branch.route.keywords.join(',')} exclude=${branch.route.exclude.join(',')} priority=${branch.route.priority} fallback=${branch.route.fallback}`,
  )
  deps.io.out(`automation: eligible=${branch.automation.eligible} enqueue_after_spec=${branch.automation.enqueueAfterSpec}`)
  deps.io.out(`steps: ${branch.steps.map((step) => step.id).join(' -> ')}`)
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

export async function cmdTracksList(deps: CliDeps, opts: TracksCommonOpts): Promise<number> {
  const { entries } = loadListing(deps)
  if (opts.json) {
    deps.io.out(JSON.stringify(entries.map(trackJson)))
    return 0
  }
  renderList(deps, entries)
  return 0
}

/** `<工作流>:<轨道>` 精确指定；只写轨道 id 时在全部工作流里找，多于一处要求带工作流名。 */
export async function cmdTracksShow(deps: CliDeps, id: string, opts: TracksCommonOpts): Promise<number> {
  const { entries } = loadListing(deps)
  const exact = entries.filter((entry) => idOf(entry) === id)
  const found = exact.length > 0 ? exact : entries.filter((entry) => entry.branch.id === id)
  if (found.length === 0) {
    deps.io.err(`ERROR: ${msg(deps, 'tracks.notFound', { track: id })}`)
    return 1
  }
  const [entry] = found
  if (found.length > 1 || entry === undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'tracks.ambiguous', { track: id, candidates: found.map(idOf).join(', ') })}`)
    return 1
  }
  if (opts.json) {
    deps.io.out(JSON.stringify(trackJson(entry)))
    return 0
  }
  renderShow(deps, entry)
  return 0
}
