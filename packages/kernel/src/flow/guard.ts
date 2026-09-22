/**
 * guardCheck 全量校验面（BACKLOG #12）—— 相位「出口」规则引擎。
 *
 * 规则真相源（老仓 workflow-plugin，严格只读）：
 *   · skills/pipeline/scripts/pipeline-guard.sh（相位 case 块 + 显式步 + automation 闸）
 *   · skills/pipeline/scripts/pipeline-guard-lib.sh（谓词原语与 coverage 矩阵）
 *   · skills/pipeline/manifest.yaml phases.*.exit_checks（S4 数据表）
 * 逐相位 × track × preset 的完整盘点（含未移植面与理由）见同目录 GUARD-RULES.md。
 *
 * 三个消费者，读同一张 EXIT_RULES：`tenon check`（人读报告）、`status --json` 的
 * `exits[].blockers`（运行器照做的动作表）、以及 default 轨 transition 的前进边强制层
 * （workflow/transition-plan-default.ts）。2026-09 之前只有第一个：同一份状态上 check 说 FAIL
 * exit 2、status 说 ready=true、transition 照样 exit 0，pm 就这样带着 prd_path=null 归了档。
 * 相应地，EXIT_RULES 点名的**可填字段**由 phaseExitGuardFields 投影出去，投影与强制同源。
 *
 * 两个运行面（GUARD-RULES §7.2）：
 *   · guardCheck(state)          —— lite 纯字段面：文件类检查静默跳过（向后兼容原 lite 子集）。
 *   · guardCheck(state, ctx)     —— 注入 GuardContext（fileExists/readFile/... 由 CLI 落地）后
 *                                   即老 guard 全语义；缺某能力则对应检查跳过。
 * skill/工具留痕类检查（mandatory skills / 三轨 review 证据）未移植——证据链（skill-tracker →
 * tools_history）在新仓尚不存在（BACKLOG #18/#21），见 GUARD-RULES §7.3。
 *
 * lite 早期两处投影已随全量移植撤销、回对齐老仓（GUARD-RULES §7.6）：
 *   · build 出口不再要求 build_sha（老仓由 build-complete 事件体冻结 SHA，
 *     新仓 transition.ts 已实现同款自动冻结——barrier 语义不变，ADR 0005）。
 *   · verify 出口 verify_result=pass 只对 pm track（老 manifest M246 tracks: pm；
 *     fe/be 由 verify-pass 事件体落 pass，新仓 transition.ts 同款）。
 *
 * track 条件（2026-07-17 P0 advisory/enforcement 对齐）：规则的 when= 是 TrackPredicate
 * （workflow/predicates.ts），老仓 tracks=backend,frontend 白名单已统一改为 NON_PM 谓词——
 * guard 的 advisory 预览（tenon check/doctor）与 transition 强制层（flow/transition-table.ts）
 * 对 chat/未知 track 同判（都要求 plan/review 等）。PM 对 legacy `plan` state artifact 保持
 * 原流程豁免；它仍须通过 OpenSpec 文档账本提交 plan 文档，二者不可混为一谈。
 *
 * 「null」哨兵：老内核把字符串 "null" 视同空（yaml_nonempty `[ "$v" != "null" ]`），照搬。
 */
import type { FieldName, GuardContext, GuardResult, Phase, PipelineState } from '../types.js'
// 具体文件路径而非 barrel（同 transition-table.ts）：predicates.ts 零 import，物理上无环。
import { matchesTrackPredicate, NON_PM, NON_PM_OR_FREE, type TrackPredicate } from '../workflow/predicates.js'
import { incompletePipelineTasksForExit } from '../workflow/todo-projection.js'
// spec 出口的覆盖矩阵（profile × 层）单独成模块：那是一张领域数据表，不是这里的规则求值。
import { evaluateCoverage } from './guard-coverage.js'

type GuardRule =
  // ── 纯字段谓词（无 ctx 也评估；lite 原有面）──
  | { kind: 'nonempty'; field: FieldName; when?: TrackPredicate }
  | { kind: 'eq'; field: FieldName; value: string; when?: TrackPredicate }
  | { kind: 'automation-queued' }      // guard.sh:154-162 build 前置闸（纯字段 + ctx.automationRunner 旁路）
  | { kind: 'full-direct-override' }   // guard.sh:537-542 preset=full && build_mode=direct → direct_override=true
  // ── 文件面谓词（需 ctx 对应能力，缺则跳过）──
  | { kind: 'statefile' }                                                    // manifest: file_nonempty .pipeline.yaml
  | { kind: 'file-nonempty'; path: string; when?: TrackPredicate }           // change 目录内产物
  | { kind: 'file-exists'; path: string }                                    // change 目录内产物
  | { kind: 'tasks-at-least'; n: number }                                    // lib:34-39 `^- \[[ x]\]` 计数
  | { kind: 'tasks-through-phase' }                                          // structured Todo 仅校验截至当前 phase
  | { kind: 'field-file-exists'; field: FieldName; desc?: string; when?: TrackPredicate } // 字段值=项目根相对路径
  | { kind: 'coverage' }                                                     // guard.sh:510-528 M1 覆盖 gate
  | { kind: 'depends-archived' }                                             // guard.sh:544-559

/** 仅 pm 轨适用（老仓 tracks=pm 的 verify_result / prd_path 各条，语义与老仓一致）。 */
const PM_ONLY: TrackPredicate = { kind: 'track-in', values: ['pm'] }

/** 相位出口规则表（顺序 = 老仓声明/评估顺序：automation 闸 → exit_checks → 显式步）。
 *  when= 语义见文件头「track 条件」：NON_PM 用于原流程的 plan/review/PR 分支；PM_ONLY 各条
 *  保留 PM 交付物行为。OpenSpec document ledger 对所有 track 另有独立的文档要求。 */
const EXIT_RULES: Readonly<Record<Phase, readonly GuardRule[]>> = {
  // open 出口（manifest.yaml:146-151）
  open: [
    { kind: 'statefile' },
    { kind: 'file-nonempty', path: 'proposal.md' },
    { kind: 'file-exists', path: 'tasks.md' },
    { kind: 'tasks-at-least', n: 1 },
    { kind: 'tasks-through-phase' },
    { kind: 'file-nonempty', path: 'design.md' },
  ],
  // explore 出口（manifest.yaml:171-174）
  explore: [
    { kind: 'statefile' },
    { kind: 'nonempty', field: 'design_doc' },
    { kind: 'field-file-exists', field: 'design_doc' },
    { kind: 'tasks-through-phase' },
  ],
  // spec 出口（manifest.yaml:188-192 + guard.sh:510-528 coverage 显式步）
  spec: [
    { kind: 'statefile' },
    { kind: 'nonempty', field: 'plan', when: NON_PM },
    { kind: 'field-file-exists', field: 'plan', when: NON_PM },
    { kind: 'tasks-at-least', n: 3 },
    { kind: 'tasks-through-phase' },
    { kind: 'coverage' },
  ],
  // build 出口（guard.sh:154-162 前置闸 + manifest.yaml:218-222 + guard.sh:532-559 显式步）
  build: [
    { kind: 'automation-queued' },
    { kind: 'statefile' },
    { kind: 'tasks-through-phase' },
    { kind: 'nonempty', field: 'build_mode' },
    { kind: 'nonempty', field: 'isolation' },
    { kind: 'full-direct-override' },
    { kind: 'eq', field: 'pre_verify_review_result', value: 'pass' },
    { kind: 'depends-archived' },
  ],
  // verify 出口（manifest.yaml:239-247；verify_result 仅 pm——fe/be 由 verify-pass 事件体落值）
  verify: [
    { kind: 'statefile' },
    { kind: 'nonempty', field: 'verification_report' },
    { kind: 'field-file-exists', field: 'verification_report', desc: 'verification_report 文件存在' },
    { kind: 'eq', field: 'branch_status', value: 'handled' },
    { kind: 'eq', field: 'verify_result', value: 'pass', when: PM_ONLY },
    { kind: 'tasks-through-phase' },
  ],
  // ship 出口（manifest.yaml:259-263）
  ship: [
    { kind: 'statefile' },
    { kind: 'nonempty', field: 'prd_path', when: PM_ONLY },
    { kind: 'field-file-exists', field: 'prd_path', desc: 'prd_path 文件存在', when: PM_ONLY },
    { kind: 'nonempty', field: 'pr_url', when: NON_PM_OR_FREE },
    { kind: 'tasks-through-phase' },
  ],
  // archive 出口（manifest.yaml:272-274）
  archive: [
    { kind: 'statefile' },
    { kind: 'eq', field: 'verify_result', value: 'pass' },
    { kind: 'tasks-through-phase' },
  ],
}

// ===== 谓词与工具 =====

/** 老内核空值语义：空串与 "null" 哨兵都算空；列表字段取长度 */
function isEmpty(v: string | string[] | undefined): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  return v === '' || v === 'null'
}

function scalar(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : ''
}

/** depends_on 展开：数组逐项 / 老式逗号标量逐项，trim 后剔空与 "null"（guard.sh:544-549） */
function depsOf(v: string | string[] | undefined): string[] {
  const items = Array.isArray(v) ? v : (v ?? '').split(',')
  return items.map((s) => s.trim()).filter((s) => s !== '' && s !== 'null')
}

/** `^- \[[ x]\]` 任务行计数（lib:34-39；大写 X 不计，照老仓 regex）。
 *  单一真相源：workflow/stepGuard.ts 的 tasks-at-least guard 复用本函数，勿另造计数逻辑。 */
export function taskCount(content: string | undefined): number {
  if (content === undefined) return 0
  return content.split('\n').filter((l) => /^- \[[ x]\]/.test(l)).length
}

/** when= 条件求值（占老仓 guard.sh:322-331 tracks= 过滤的位置）：无 when 对全轨生效；
 *  有 when 按 TrackPredicate 判定——与 transition 层共用 matchesTrackPredicate，两层同判。 */
function trackApplies(when: TrackPredicate | undefined, track: string): boolean {
  return when === undefined || matchesTrackPredicate(when, track)
}

/** 老仓 label 的 track 后缀（guardcheck_* 有 track 条件时带出当前 track） */
function trackSuffix(when: TrackPredicate | undefined, track: string): string {
  return when === undefined ? '' : ` (${track} track)`
}

/** 相位出口 guard 对某字段点名的值集（形状与 default 轨事件表的同名投影一致）。 */
export interface PhaseExitGuardFieldRequirement {
  readonly field: FieldName
  /** guard 接受的具体值；缺省 = 只要求非空（file-exists 另要求该路径存在）。 */
  readonly required?: readonly string[]
}

/**
 * 当前相位的出口 guard 会读哪些**人可填**的字段，按规则声明序去重。
 *
 * 这张表此前只有 `tenon check` 一个消费者，于是 `status --json` 的字段投影看不见它点名的槽：
 * pm 在 verify 步既看不到 `verify_result`、blockers 里也没有它，运行器只能在 `request-review`
 * 上空转；pm 的 ship 步显示的是 `pr_url`（非 pm 的 guard），而真正卡住出口的是 `prd_path`。
 *
 * 不列进来的两类，因为它们不是「填一个值就能过」的槽：
 *   · automation-queued —— 要的是「别让主线抢调度器的活」，不是给 automation 填一个值；
 *   · coverage / tasks / statefile / depends-archived —— 判定的是文档、任务与依赖证据。
 */
export function phaseExitGuardFields(state: PipelineState): readonly PhaseExitGuardFieldRequirement[] {
  const phase = scalar(state.fields.phase)
  const rules = (EXIT_RULES as Record<string, readonly GuardRule[] | undefined>)[phase]
  if (!rules) return []
  const track = scalar(state.fields.track)
  const out: PhaseExitGuardFieldRequirement[] = []
  const push = (field: FieldName, required?: readonly string[]): void => {
    if (out.some((item) => item.field === field)) return
    out.push(required === undefined ? { field } : { field, required })
  }
  for (const rule of rules) {
    switch (rule.kind) {
      case 'nonempty':
        if (trackApplies(rule.when, track)) push(rule.field)
        break
      case 'eq':
        if (trackApplies(rule.when, track)) push(rule.field, [rule.value])
        break
      case 'field-file-exists':
        if (trackApplies(rule.when, track)) push(rule.field)
        break
      case 'full-direct-override':
        if (scalar(state.fields.preset) === 'full' && scalar(state.fields.build_mode) === 'direct') {
          push('direct_override', ['true'])
        }
        break
      default:
        break
    }
  }
  return out
}

export function evaluateGuard(state: PipelineState, ctx?: GuardContext): GuardResult {
  const phase = scalar(state.fields.phase)
  const rules = (EXIT_RULES as Record<string, readonly GuardRule[] | undefined>)[phase]
  if (!rules) {
    return { pass: false, failures: [`未知 phase '${phase}'，无法评估出口条件`] }
  }
  const track = scalar(state.fields.track)
  const changeDir = ctx?.changeDirRel
  const failures: string[] = []
  const warnings: string[] = []

  for (const rule of rules) {
    switch (rule.kind) {
      case 'nonempty': {
        if (!trackApplies(rule.when, track)) break
        const value = state.fields[rule.field]
        if (isEmpty(value)) {
          failures.push(`${phase} 出口：要求 ${rule.field} 非空（当前='${scalar(value)}'）`)
        }
        break
      }
      case 'eq': {
        if (!trackApplies(rule.when, track)) break
        const value = state.fields[rule.field]
        if (scalar(value) !== rule.value) {
          failures.push(`${phase} 出口：要求 ${rule.field}=${rule.value}（当前='${scalar(value)}'）`)
        }
        break
      }
      case 'automation-queued': {
        // guard.sh:154-162：主线 build 路径拦截；调度器（TENON_AUTOMATION_RUNNER=1）旁路
        if (ctx?.automationRunner === true) break
        if (scalar(state.fields.automation) === 'queued') {
          failures.push(
            `${phase} 出口：automation=queued 已入队调度器，主线 build 路径被拦（想手动跑先 set automation off）`,
          )
        }
        break
      }
      case 'full-direct-override': {
        if (scalar(state.fields.preset) === 'full' && scalar(state.fields.build_mode) === 'direct') {
          const ovr = scalar(state.fields.direct_override)
          if (ovr !== 'true') {
            failures.push(`${phase} 出口：full+direct 要求 direct_override=true（当前='${ovr}'）`)
          }
        }
        break
      }
      case 'statefile': {
        if (changeDir === undefined) break
        const exists = ctx?.stateExists !== undefined
          ? ctx.stateExists(changeDir)
          : ctx?.fileNonempty?.(`${changeDir}/.pipeline.yaml`)
        if (exists === undefined) break
        if (!exists) {
          failures.push(`${phase} 出口：要求 canonical 状态文件存在（兼容 legacy .pipeline.yaml）`)
        }
        break
      }
      case 'file-nonempty': {
        if (!trackApplies(rule.when, track)) break
        if (ctx?.fileNonempty === undefined || changeDir === undefined) break
        if (!ctx.fileNonempty(`${changeDir}/${rule.path}`)) {
          failures.push(`${phase} 出口：要求 ${rule.path} 存在且非空${trackSuffix(rule.when, track)}`)
        }
        break
      }
      case 'file-exists': {
        if (ctx?.fileExists === undefined || changeDir === undefined) break
        if (!ctx.fileExists(`${changeDir}/${rule.path}`)) {
          failures.push(`${phase} 出口：要求 ${rule.path} 存在`)
        }
        break
      }
      case 'tasks-at-least': {
        if (ctx?.readFile === undefined || changeDir === undefined) break
        const count = taskCount(ctx.readFile(`${changeDir}/tasks.md`))
        if (count < rule.n) {
          failures.push(`${phase} 出口：要求 tasks.md 至少 ${rule.n} 个任务（当前=${count}）`)
        }
        break
      }
      case 'tasks-through-phase': {
        if (ctx?.readFile === undefined || changeDir === undefined) break
        const content = ctx.readFile(`${changeDir}/tasks.md`)
        if (content === undefined) {
          // Open already has explicit existence/count checks. Later governed
          // phases get the file requirement from the document ledger. Keep
          // legacy guard compatibility while retaining build's historical
          // fail-closed behaviour when no ledger is present.
          if (phase === 'build') {
            failures.push(`${phase} 出口：要求截至当前阶段的 tasks.md 全部勾选（tasks.md 缺失）`)
          }
        } else {
          const projectionStatus = ctx.canonicalTasksProjectionStatus?.({
            changeDirRel: changeDir,
            tasksMarkdown: content,
          }) ?? 'legacy'
          if (projectionStatus === 'invalid') {
            failures.push(`${phase} 出口：canonical TaskPlan tasks.md 投影认证失败`)
            break
          }
          const status = incompletePipelineTasksForExit({
            phase,
            tasksMarkdown: content,
            trustedCanonicalProjection: projectionStatus === 'current',
          })
          if (status.incomplete > 0) {
            failures.push(
              `${phase} 出口：要求截至当前阶段的 tasks.md 全部勾选（仍有 ${status.incomplete} 项未勾）`,
            )
          }
        }
        break
      }
      case 'field-file-exists': {
        if (!trackApplies(rule.when, track)) break
        if (ctx?.fileExists === undefined) break
        const v = scalar(state.fields[rule.field])
        // lib:67-72 yaml_file_exists：字段空/"null"/文件不存在 都 FAIL（与 nonempty 条双计，老仓同）
        if (v === '' || v === 'null' || !ctx.fileExists(v)) {
          const label = rule.desc ?? `${rule.field} 指向的文件存在`
          failures.push(`${phase} 出口：要求 ${label}${trackSuffix(rule.when, track)}（当前='${v}'）`)
        }
        break
      }
      case 'coverage': {
        if (ctx !== undefined) {
          evaluateCoverage({
            ctx,
            preset: scalar(state.fields.preset),
            designDoc: scalar(state.fields.design_doc),
          }, failures, warnings)
        }
        break
      }
      case 'depends-archived': {
        if (ctx?.dirExists === undefined || ctx.changeArchived === undefined) break
        for (const dep of depsOf(state.fields.depends_on)) {
          if (ctx.dirExists(`openspec/changes/${dep}`)) {
            if (ctx.activeChangeArchived?.(dep) !== true) {
              failures.push(`${phase} 出口：依赖 change '${dep}' 必须先归档（当前活跃）`)
            }
          } else if (!ctx.changeArchived(dep)) {
            failures.push(`${phase} 出口：依赖 change '${dep}' 不存在（既不在活跃也不在归档）`)
          }
        }
        break
      }
    }
  }

  const result: GuardResult = { pass: failures.length === 0, failures }
  if (warnings.length > 0) result.warnings = warnings
  return result
}
