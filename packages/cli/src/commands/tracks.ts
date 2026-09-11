/**
 * `tenon tracks list/show` —— Track Registry 的**只读**视图。
 *
 * 写入面（create/update/delete）已移除：轨道能否与某个工作流一起用，只由工作流 YAML 的 `tracks:`
 * 分支决定（`selectTrackBranch` 缺分支即抛 `WorkflowTrackBranchError`）。注册表曾允许登记一条工作流
 * 未声明的轨道，那是个不作数的承诺——登记成功，`init --track <id>` 仍被分支检查拒绝。
 *
 * 退出码：0 成功；1 一切错误（未注册 id / tracks.yaml 损坏 / IO）。JSON 模式 stdout 只放 JSON、
 * 错误走 stderr。
 */
import { BUILTIN_TRACK_IDS, builtinTrack, isBuiltinTrackId } from '@tenon/kernel'
import type { BuiltinTrackId, TrackDefinition, TrackRegistry } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

type TrackSource = 'builtin' | 'builtin-override' | 'custom'

export interface TracksCommonOpts {
  json?: boolean
}


function allowedEq(a: '*' | readonly string[], b: '*' | readonly string[]): boolean {
  if (a === '*' || b === '*') return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** builtin 是否被覆盖：effective label/workflow 与代码默认不同即 override（归一化保证 no-op override
 *  不残留，故 effective==base ⇔ 无覆盖）。 */
function sourceOf(def: TrackDefinition): TrackSource {
  if (!def.builtin) return 'custom'
  const base = builtinTrack(def.id as BuiltinTrackId)
  const same =
    def.label === base.label &&
    def.workflow.default === base.workflow.default &&
    allowedEq(def.workflow.allowed, base.workflow.allowed)
  return same ? 'builtin' : 'builtin-override'
}

function allowedText(allowed: '*' | readonly string[]): string {
  return allowed === '*' ? '*' : allowed.join(', ')
}

/** JSON schema（含 id,label,builtin,source,workflow,policyProfile,revision）。 */
function trackJson(def: TrackDefinition, source: TrackSource, revision: string): Record<string, unknown> {
  return {
    id: def.id,
    label: def.label,
    builtin: def.builtin,
    source,
    workflow: { default: def.workflow.default, allowed: def.workflow.allowed },
    policyProfile: def.policyProfile,
    revision,
  }
}

// ── 活跃 change 引用扫描（fail-closed：读不了的进 unreadable）─────────────────────

// ── 输出 ──────────────────────────────────────────────────────────────────────

function renderList(deps: CliDeps, registry: TrackRegistry): void {
  const header = ['ID', 'LABEL', 'BUILTIN', 'DEFAULT', 'ALLOWED', 'POLICY']
  const rows = registry.ordered.map((d) => [
    d.id,
    d.label,
    d.builtin ? 'yes' : 'no',
    d.workflow.default,
    allowedText(d.workflow.allowed),
    d.policyProfile.coverageProfile,
  ])
  // 列宽取 header 与各行的最大值——不截断、不省略（名称一律完整显示，排版规整）。
  const widths = header.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => (row[column] ?? '').length)))
  const fmt = (cells: string[]) =>
    cells.map((value, column) => value.padEnd(widths[column] ?? value.length)).join('  ').trimEnd()
  deps.io.out(fmt(header))
  for (const r of rows) deps.io.out(fmt(r))
}

function renderShow(deps: CliDeps, def: TrackDefinition, source: TrackSource, revision: string): void {
  const p = def.policyProfile
  deps.io.out(`id: ${def.id}`)
  deps.io.out(`label: ${def.label}`)
  deps.io.out(`builtin: ${def.builtin}`)
  deps.io.out(`source: ${source}`)
  deps.io.out(`workflow.default: ${def.workflow.default}`)
  deps.io.out(`workflow.allowed: ${allowedText(def.workflow.allowed)}`)
  deps.io.out(`policy.reviewSeed: ${p.reviewSeed}`)
  deps.io.out(`policy.automationEligible: ${p.automationEligible}`)
  deps.io.out(`policy.coverageProfile: ${p.coverageProfile}`)
  deps.io.out(
    p.routing.enabled
      ? `policy.routing: enabled=true pattern=${p.routing.pattern} priority=${p.routing.priority}`
      : 'policy.routing: enabled=false',
  )
  deps.io.out(`policy.skills: matrix=${p.skills.matrix} profile=${p.skills.profile}`)
  // builtin-override：把「与代码默认不同」的字段单列，避免用户误以为完整 builtin 已写进 YAML。
  if (source === 'builtin-override') {
    const base = builtinTrack(def.id as BuiltinTrackId)
    if (def.label !== base.label) deps.io.out(`override: label=${def.label}`)
    if (def.workflow.default !== base.workflow.default) deps.io.out(`override: workflow.default=${def.workflow.default}`)
    if (!allowedEq(def.workflow.allowed, base.workflow.allowed)) {
      deps.io.out(`override: workflow.allowed=${allowedText(def.workflow.allowed)}`)
    }
  }
  deps.io.out(`revision: ${revision}`)
}

/** 领域错误/校验/IO 一律 exit 1，消息走 stderr（JSON 模式 stdout 仍纯净）。 */
function fail(deps: CliDeps, e: unknown): number {
  deps.io.err(`ERROR: ${errMsg(e)}`)
  return 1
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

export async function cmdTracksList(deps: CliDeps, opts: TracksCommonOpts): Promise<number> {
  let registry: TrackRegistry
  try {
    registry = deps.loadRegistry()
  } catch (e) {
    return fail(deps, e)
  }
  if (opts.json) {
    deps.io.out(JSON.stringify(registry.ordered.map((d) => trackJson(d, sourceOf(d), registry.revision))))
    return 0
  }
  renderList(deps, registry)
  return 0
}

export async function cmdTracksShow(deps: CliDeps, id: string, opts: TracksCommonOpts): Promise<number> {
  let registry: TrackRegistry
  try {
    registry = deps.loadRegistry()
  } catch (e) {
    return fail(deps, e)
  }
  const def = registry.byId.get(id)
  if (!def) {
    deps.io.err(`ERROR: 未注册的 track '${id}'（已注册：${registry.ordered.map((t) => t.id).join(', ')}）`)
    return 1
  }
  const source = sourceOf(def)
  if (opts.json) {
    deps.io.out(JSON.stringify(trackJson(def, source, registry.revision)))
    return 0
  }
  renderShow(deps, def, source, registry.revision)
  return 0
}
