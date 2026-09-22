/**
 * handoff 子命令 —— 上下文压缩（BACKLOG #30 / GOAL B13·D11：对标 Tenon runtime CONTEXT-COMPRESSION）。
 *
 * `tenon handoff <name> [--phase p] [--json]`：对指定 change 的当前相位产出文档
 * （design_doc / plan / verification_report 指向的路径 + change 目录内 proposal/design/tasks.md）
 * 做**确定性**结构化压缩，输出下游 handoff 摘要 + 压缩率。零 LLM（纯规则，可测可 oracle）。
 * stdout：压缩摘要（下游消费的产物）+ 压缩率行；--json 结构化信封。exit：非法名/状态缺失=1，否则 0。
 *
 * 触发面：handoff 只在用户显式敲 `tenon handoff` 时跑——相位转换不自动产出 handoff
 * 摘要（transition.ts 的进相位副作用里没有 buildHandoff 调用）。注意 transition 仍会写
 * `.breadcrumb`，但那只是一行 `pipeline:<name> phase=<to>` 的相位标记，与 handoff 摘要无关。
 */
import {
  buildHandoff,
  compileLedgerContextBundle,
  nodeHandoffFs,
  resolveWorkflowName,
  type CompileLedgerContextBundleInput,
  type CompiledLedgerContextBundle,
  type HandoffFs,
  type HandoffResult,
} from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import type { DocumentLocale } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { resolveChangeDocumentLocale } from '../documentLocale.js'
import { isValidChangeName, resolveChangeDir } from '../paths.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

export type { HandoffFs } from '@tenon/kernel'

export interface HandoffOpts {
  json?: boolean
  /** 覆写要压缩的相位产出（缺省 = change 当前 phase） */
  phase?: string
  /** Opt-in Context Bundle v1; legacy handoff remains the default. */
  bundle?: boolean
  /** Exact consumer phase/role for bundle policy selection. */
  target?: string
  budgetBytes?: number
}

export type HandoffLocaleResolver = (changeDirPath: string) => Promise<DocumentLocale>
export type LedgerContextBundleCompiler = (
  input: CompileLedgerContextBundleInput,
) => Promise<CompiledLedgerContextBundle>

function scalarField(v: string | string[] | undefined): string {
  if (v === undefined) return ''
  return Array.isArray(v) ? v.join(',') : v
}

/** --json 结构化信封（下游可编程消费；对 Tenon runtime 纯文本压缩的超越点：结构化 + 逐文档量化）。 */
function renderJson(result: HandoffResult): string {
  return JSON.stringify({
    change: result.name,
    phase: result.phase,
    aggregate: result.aggregate,
    docs: result.docs.map((d) => ({
      label: d.label,
      path: d.path,
      stats: d.doc.stats,
      title: d.doc.title,
      headings: d.doc.headings,
      decisions: d.doc.decisions,
      constraints: d.doc.constraints,
      openTodos: d.doc.openTodos,
      doneTodoCount: d.doc.doneTodoCount,
      keyFields: d.doc.keyFields,
      summary: d.summary,
    })),
  })
}

function pct(ratio: number): number {
  return Math.round(ratio * 100)
}

/** 人读输出：header + 压缩率 + 逐文档摘要（下游可直接读的压缩产物）。 */
function renderText(deps: CliDeps, result: HandoffResult): void {
  const chinese = result.documentLocale === 'zh-CN'
  deps.io.out(chinese
    ? `# 交接摘要: ${result.name}（阶段 ${result.phase}）`
    : `# Handoff: ${result.name} (phase ${result.phase})`)
  if (result.docs.length === 0) {
    deps.io.out(chinese ? '# 当前阶段没有可交接文档。' : '# No handoff documents found for this phase.')
    deps.io.err(`[HANDOFF] ${result.name} @ ${result.phase}: 无可压缩产出文档（相位无 upstream doc 或文件缺失/空）`)
    return
  }
  const agg = result.aggregate
  deps.io.out(chinese
    ? `# 压缩率: ${pct(agg.ratio)}%（${agg.originalChars} → ${agg.compressedChars} 字符，${result.docs.length} 份文档）`
    : `# Compression: ${pct(agg.ratio)}% (${agg.originalChars} → ${agg.compressedChars} chars, ${result.docs.length} doc(s))`)
  for (const d of result.docs) {
    deps.io.out('')
    deps.io.out(chinese
      ? `## ${d.path} — ${pct(d.doc.stats.ratio)}%（${d.doc.stats.originalChars} → ${d.doc.stats.compressedChars} 字符）`
      : `## ${d.path} — ${pct(d.doc.stats.ratio)}% (${d.doc.stats.originalChars} → ${d.doc.stats.compressedChars} chars)`)
    for (const line of d.summary.split('\n')) deps.io.out(line)
  }
}

/**
 * handoff 命令（纯函数 + deps 注入，风格同 task.ts）。
 * fs 缺省真 fs（nodeHandoffFs，integration 走真路径）；mock 层注入 fake HandoffFs 快速回归。
 */
export async function cmdHandoff(
  deps: CliDeps,
  name: string | undefined,
  opts: HandoffOpts,
  fs: HandoffFs | undefined = undefined,
  localeResolver: HandoffLocaleResolver = resolveChangeDocumentLocale,
  bundleCompiler: LedgerContextBundleCompiler = compileLedgerContextBundle,
): Promise<number> {
  if (name === undefined || name === '' || !isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name ?? ''}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  const dir = resolveChangeDir(deps.cwd, name)
  let state: PipelineState
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }

  const phase = opts.phase ?? scalarField(state.fields.phase)
  if (opts.bundle) {
    try {
      const plan = effectiveWorkflowForState(deps, state)
      const policy = plan?.capabilities.documents.policy
      if (policy === undefined) {
        deps.io.err(`ERROR: workflow '${plan?.id ?? resolveWorkflowName(state)}' 未开启 openspec，--bundle 不适用`)
        return 1
      }
      const { bundle } = await bundleCompiler({
        root: deps.cwd,
        change: name,
        from: phase,
        target: opts.target ?? '',
        policy,
        ...(opts.budgetBytes === undefined ? {} : { budgetBytes: opts.budgetBytes }),
        ...(fs === undefined ? {} : { fs }),
      })
      deps.io.out(opts.json ? JSON.stringify(bundle) : JSON.stringify(bundle, null, 2))
      return 0
    } catch (error) {
      deps.io.err(`ERROR: ${errMsg(error)}`)
      return 1
    }
  }
  const handoffFs = fs ?? nodeHandoffFs()
  let documentLocale: 'zh-CN' | 'en'
  try {
    documentLocale = await localeResolver(dir)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  const result = buildHandoff(
    {
      name,
      phase,
      cwd: deps.cwd,
      changeDirRel: `openspec/changes/${name}`,
      fields: state.fields,
      documentLocale,
    },
    handoffFs,
  )

  if (opts.json) {
    deps.io.out(renderJson(result))
    return 0
  }
  renderText(deps, result)
  return 0
}
