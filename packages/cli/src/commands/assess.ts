/**
 * `tenon assess --files <p…> [--workflow <w>] [--track <t>] [--json]` —— 建任务前评估轻重。
 *
 * 用与改动风险探针（`tenon test diff-risk`）完全相同的分类规则与阈值，评估一组「预计要改的文件」：
 * 阈值读自生效工作流（项目 → 全局存储 → 插件模板）里所选分支的 `diff-risk` 测试的 `pass.metrics`，分类与
 * 受保护测试配置的计数口径都是 kernel 的 `classifyChange` / `protectedTestFileCount`。所选分支没有这条测试
 * 就报错，不猜阈值。只按路径分类，不读文件内容；路径必须是仓库内相对路径（见 assessPaths.ts）。
 *
 * 缺省 `--workflow default --track lite`（只有 default 缺省轨道；别的工作流有分支时须指定，平铺工作流不必）。
 * 退出码：0 不超限；3 超限（推荐重型轨道）；1 用法错误、路径不合法、或该轨道没有改动风险阈值。
 * JSON 模式 stdout 只放 `{ workflow, track, metrics, exceeded, reasons, recommendation }`，错误走 stderr。
 */
import {
  classifyChange, isDefaultWorkflowName, listTracks, loadTrack, protectedTestFileCount, readProtectedChanges,
  riskThresholdsFor, UnknownTrackError,
  type ChangeRiskVerdict, type LoadedTrack,
} from '@tenon/kernel'
import { repoPathChanges, type RepoPathProblem } from '../assessPaths.js'
import { errMsg, type CliDeps } from '../deps.js'
import { msg, type MessageCode } from '../i18n/messages.js'
import { riskReportLines } from './test-diff-risk.js'

export interface AssessOpts {
  readonly files?: readonly string[]
  readonly workflow?: string
  readonly track?: string
  readonly json?: boolean
}

/** 缺省工作流 default 的轻量轨道。 */
const DEFAULT_WORKFLOW = 'default'
const LITE_TRACK = 'lite'
/** 超限的退出码：与「用法 / 无阈值」的 1 区分开，调用方（agent）据此直接分流。 */
const EXIT_EXCEEDED = 3

const PATH_MESSAGES: Readonly<Record<RepoPathProblem, MessageCode>> = {
  empty: 'assess.path.empty',
  nul: 'assess.path.nul',
  absolute: 'assess.path.absolute',
  parent: 'assess.path.parent',
  outside: 'assess.path.outside',
  unreadable: 'assess.path.unreadable',
}

/** 超限时的推荐：同工作流里的其它轨道；没有别的轨道可选就如实说。 */
function heavyRecommendation(deps: CliDeps, loaded: LoadedTrack, workflow: string): string {
  const others = listTracks(loaded.workflow).map((branch) => branch.id).filter((id) => id !== loaded.branch.id)
  return others.length === 0
    ? msg(deps, 'assess.heavyNone', { track: loaded.branch.id, workflow })
    : msg(deps, 'assess.heavy', { tracks: others.join(' / '), workflow })
}

function loadOrReport(deps: CliDeps, workflow: string, track: string | undefined): LoadedTrack | undefined {
  try {
    return loadTrack(deps.cwd, workflow, track)
  } catch (error) {
    // 指定了却不存在的轨道，就是「这条轨道没有阈值」；没指定轨道（有分支的工作流）是用法问题，原样给出可选项。
    if (error instanceof UnknownTrackError && error.track !== '') {
      deps.io.err(`ERROR: ${msg(deps, 'assess.unknownTrack', { reason: error.message })}`)
    } else {
      deps.io.err(`ERROR: ${errMsg(error)}`)
    }
    return undefined
  }
}

export async function cmdAssess(deps: CliDeps, opts: AssessOpts): Promise<number> {
  const files = opts.files ?? []
  if (files.length === 0) {
    deps.io.err(`ERROR: ${msg(deps, 'assess.filesRequired')}`)
    return 1
  }
  const parsed = await repoPathChanges(deps.cwd, files)
  if (!parsed.ok) {
    deps.io.err(`ERROR: ${msg(deps, PATH_MESSAGES[parsed.problem], { path: JSON.stringify(parsed.path), reason: parsed.reason ?? '' })}`)
    return 1
  }
  const workflow = opts.workflow ?? DEFAULT_WORKFLOW
  const loaded = loadOrReport(deps, workflow, opts.track ?? (isDefaultWorkflowName(workflow) ? LITE_TRACK : undefined))
  if (loaded === undefined) return 1
  const thresholds = riskThresholdsFor(loaded.branch)
  if (thresholds === undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'assess.noThresholds', { workflow, track: loaded.branch.id })}`)
    return 1
  }
  let verdict: ChangeRiskVerdict
  try {
    const protectedCount = protectedTestFileCount(await readProtectedChanges(deps.cwd, parsed.changes))
    verdict = classifyChange(parsed.changes, protectedCount, thresholds)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  const recommendation = verdict.exceeded ? heavyRecommendation(deps, loaded, workflow) : loaded.branch.id
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      workflow, track: loaded.branch.id, metrics: verdict.metrics, exceeded: verdict.exceeded, reasons: verdict.reasons, recommendation,
    }))
  } else {
    deps.io.out(msg(deps, 'assess.header', { count: parsed.changes.length, workflow, track: loaded.branch.id }))
    for (const line of riskReportLines(deps, verdict)) deps.io.out(line)
    deps.io.out(msg(deps, 'assess.recommend', { recommendation }))
  }
  return verdict.exceeded ? EXIT_EXCEEDED : 0
}
