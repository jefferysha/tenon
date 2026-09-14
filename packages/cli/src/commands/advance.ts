/**
 * advance <name> —— auto-transition 中间档（BACKLOG #31 / GOAL B14·D12：对标 Tenon runtime AUTO-TRANSITION）。
 *
 * 立场：老仓只有「纯 HITL」（guard 只校验，推进权全在人手，pipeline-guard.sh:635 明写"永不
 * auto-transition"）与「重型 AFK」（automation 子系统）两极，缺中间档。本命令补上：
 * **guard 全绿 → 自动推进到下一相位，反复直到撞上三门／终态／guard 不过就停**——比手动逐条
 * 敲 transition 省事，又比 Tenon runtime「一路推到底」更严：**绝不跨越三门自动跑完**（HITL 红线）。
 *
 * 编排（复用现有命令函数，不重造）：循环
 *   读当前相位 → forwardStep（manifest.transitions 单一真相源求前向事件）
 *   → 终态？停 · 硬门（confirm/interaction marker 新鲜）？停 · 复核相位（reviewPhases，默认）？停
 *   → cmdCheck（guard）不过？停 → cmdTransition 单步推进 → 循环。
 *
 * 停点规则（优先级自上而下，每轮重判）：
 *   1. 终态：当前相位无前向事件（archive）→ 停（推进完成）。
 *   2. 硬门：项目根 `.pipeline-pending-confirm` / `-interaction` 新鲜（age ≤ 分级 TTL）→ 停。
 *      **三门是硬门，--through-gates 也绝不放行**（HITL 红线；review 门经 reviewPhases 判定）。
 *   3. 复核相位（manifest.reviewPhases 单一真相源）：默认停（不自动离开 explore/spec/verify）；
 *      `--through-gates` 仅在已有 exact-phase-and-event approval receipt 时才可继续，绝不伪造或跳过
 *      `tenon review request → acknowledge`（仍受 2 的硬门约束）。
 *   4. guard 不过（cmdCheck exit≠0）→ 停（exit 2 沿用 check 口径）。
 *   5. --max-steps 封顶：防失控保险丝（默认 12，足够 open→archive 六步）。
 * `--dry-run`：只报计划、只读不写盘（当前相位 guard 真判，后续步运行时 live-guard）。
 *
 * exit：0（推进完成/停在门/终态/dry-run）；2（停因 guard 不过）；1（名非法/读失败/transition 出错）。
 *
 * 双轨（对齐 transition/check 先例）：读完 state 按 workflow 字段分流（习语单源 kernel
 * resolveWorkflowName）。default → 上述 manifest 前向边链路逐字不变；非 default → 按该 workflow
 * 的 step-transitions 图推进（cmdAdvanceCustom，停点规则见该函数头）——此前 advance 只认 default
 * manifest，自定义 workflow 的 change 会被 forwardStep 误判成"终态"而永远无法 auto-advance。
 */
import { implicitCompletionTransition, resolveStep, resolveWorkflowName } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState, StepIR, StepTransitionIR } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { str } from '../render.js'
import {
  approvedReviewReceipt,
  forwardStep,
  freshHardGate,
  guardQuietly,
  reviewReceiptStop,
  transitionQuietly,
  type AdvanceOpts,
} from './advance-support.js'
import { dryRunDefaultPlan } from './advance-default-dry-run.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

export type { AdvanceOpts } from './advance-support.js'

const DEFAULT_MAX_STEPS = 12

export async function cmdAdvance(deps: CliDeps, name: string, opts: AdvanceOpts = {}): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const through = opts.throughGates ?? false

  let state: PipelineState
  let startPhase: string
  let plan: EffectiveWorkflowPlan | null
  try {
    state = await deps.store.read(changeDir(deps.cwd, name))
    startPhase = str(state.fields.phase)
    plan = effectiveWorkflowForState(deps, state)
    if (!plan) {
      const workflowName = resolveWorkflowName(state)
      deps.io.err(`ERROR: workflow '${workflowName}' 未找到（期望 .pipeline/workflows/${workflowName}.yaml）`)
      return 1
    }
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }

  // 双轨分岔（对齐 transition/check：读完 state 立刻按 workflow 字段分流，习语单源在 kernel
  // resolveWorkflowName）：default 走下方原有 manifest 前向边链路一行不改；非 default 走
  // step-transitions 图的自定义推进链路（此前 advance 只认 default manifest——自定义 workflow
  // 的 change 会被 forwardStep 误判成"终态"，功能缺口在此补上）。
  if (plan.capabilities.execution.model === 'step-graph') {
    const archived = str(state.fields.archived) === 'true'
    return cmdAdvanceGraph(deps, name, plan, startPhase, archived, through, maxSteps, opts.dryRun ?? false)
  }

  if (opts.dryRun) {
    return dryRunDefaultPlan(
      deps,
      name,
      startPhase,
      through,
      maxSteps,
      plan.capabilities.review.steps,
    )
  }

  deps.io.out(`[ADVANCE] ${name}: 从 ${startPhase} 起步（max-steps=${maxSteps}${through ? '，through-gates' : ''}）`)
  let current = startPhase
  let steps = 0
  for (;;) {
    const fwd = forwardStep(deps, current)
    if (!fwd) {
      deps.io.out(`[STOP] ${name} @ ${current}: 已到终态，无后继事件（推进完成）`)
      return 0
    }
    // 硬门：三门里的 confirm/interaction 绝不自动跨越（--through-gates 也不行）——HITL 红线
    const hard = await freshHardGate(deps)
    if (hard) {
      deps.io.out(`[STOP] ${name} @ ${current}: 硬门 .pipeline-pending-${hard} 新鲜存在——三门绝不自动跨越（HITL 红线）`)
      return 0
    }
    // 复核相位：默认停；--through-gates 只能消费 CLI/hook 写入的 exact-phase 确认回执，不能自放行。
    if (plan.capabilities.review.steps.includes(current)) {
      if (!through) {
        deps.io.out(`[STOP] ${name} @ ${current}: 复核相位（HITL 门），停给人复核——确认后可用 --through-gates 继续`)
        return 0
      }
      const approved = await approvedReviewReceipt(deps, name, current, fwd.event)
      if (approved === null) return 1
      if (!approved) {
        reviewReceiptStop(deps, name, current, fwd.event)
        return 0
      }
    }
    if (steps >= maxSteps) {
      deps.io.out(`[STOP] ${name} @ ${current}: 达到 --max-steps=${maxSteps} 上限，停（防失控保险丝）`)
      return 0
    }
    // guard 必须全绿才推进（复用 cmdCheck）
    const g = await guardQuietly(deps, name)
    if (g.code !== 0) {
      deps.io.out(`[STOP] ${name} @ ${current}: guard 未通过，停（修复后重试）`)
      for (const l of g.lines) if (l.includes('[FAIL]')) deps.io.out(`  ${l.trim()}`)
      return g.code === 2 ? 2 : 1
    }
    // 单步推进（复用 cmdTransition，含事件前置校验 + canonical review receipt 消费）
    const t = await transitionQuietly(deps, name, fwd.event)
    if (t.code !== 0) {
      deps.io.out(`[STOP] ${name} @ ${current}: transition ${fwd.event} 失败，停`)
      for (const l of t.lines) deps.io.out(`  ${l.trim()}`)
      return 1
    }
    deps.io.out(`[ADVANCE] ${name}: ${current} -> ${fwd.to}（${fwd.event}）`)
    current = fwd.to
    steps += 1
  }
}

// ════ 非 default workflow：按 step-transitions 图自动推进（功能缺口补完）════

/**
 * 自动推进可走的出口。没有前进出边的 step 只走 kernel 推导的隐式完成边 `archived`——它的退回边
 * 是人工决定；进入这类 step 不等于运行完成。返回的 completion 与 exits 中的同一对象，调用方据此
 * 判断「这一步完成并归档了运行」。
 */
function graphExits(
  plan: EffectiveWorkflowPlan,
  step: StepIR,
): { readonly exits: readonly StepTransitionIR[]; readonly completion?: StepTransitionIR } {
  const completion = implicitCompletionTransition(plan, step.id)
  return completion === undefined ? { exits: step.transitions } : { exits: [completion], completion }
}

/**
 * 自定义 workflow 的停点规则（优先级自上而下，每轮重判；与 default 档同构）：
 *   0. 运行已归档（archived=true）→ 停（推进完成）。
 *   1. 终态：当前 step 没有可自动走的出口（零出边且无隐式完成边）→ 停（推进完成）。
 *      没有前进出边的 step 的出口是隐式完成边 `archived`，走完即归档并停。
 *   2. 硬门 marker：.pipeline-pending-confirm/-interaction 新鲜 → 停——HITL 红线跨轨统一，
 *      --through-gates 也绝不放行（marker 是 hooks 落的"人正被询问"项目级信号，与 workflow 无关）。
 *   3. step.gate 人门（推进前检查，管的是"自动离开"）：gate=review 默认停给人复核、--through-gates
 *      仅可消费已存在的 exact-phase-and-event approval receipt（对位 default 轨的 reviewPhases）。
 *      transition 本身也会重验 receipt，gate 是同一 canonical approval 协议在 automation 面的提前
 *      停点，不是可绕过 transition 的旁路。
 *   4. 多条出边：走向分岔，事件选择权在人（HITL）——自动推进只吃"恰 1 条出边"的确定形，停并列出
 *      可选 events。
 *   5. --max-steps 封顶（防失控保险丝，自定义图允许环，这条保险丝更要紧）。
 *   6. guard 不过（复用 cmdCheck 自定义分支 → kernel evaluateStepGuards 单源）→ 停（exit 2 沿用
 *      check 口径）。
 * 推进复用 cmdTransition 自定义分支（withLock 内读-判-写 + applyStepTransition + history 落账），
 * 与 default 档复用 cmdCheck/cmdTransition 的编排姿势逐字同构；输出同款 [ADVANCE]/[STOP] 前缀。
 */
async function cmdAdvanceGraph(
  deps: CliDeps,
  name: string,
  plan: EffectiveWorkflowPlan,
  startPhase: string,
  archived: boolean,
  through: boolean,
  maxSteps: number,
  dryRun: boolean,
): Promise<number> {
  const wf = plan.workflow
  if (!resolveStep(wf, startPhase)) {
    deps.io.err(`ERROR: step '${startPhase}' 不在 workflow '${plan.id}' 里`)
    return 1
  }

  if (dryRun) return dryRunGraphPlan(deps, name, plan, startPhase, archived, through, maxSteps)

  if (archived) {
    deps.io.out(`[STOP] ${name} @ ${startPhase}: 运行已归档，已到终态（推进完成）`)
    return 0
  }
  deps.io.out(`[ADVANCE] ${name}: 从 ${startPhase} 起步（max-steps=${maxSteps}${through ? '，through-gates' : ''}）`)
  let current = startPhase
  let steps = 0
  for (;;) {
    const step = resolveStep(wf, current)
    if (!step) {
      deps.io.err(`ERROR: step '${current}' 不在 workflow '${plan.id}' 里`)
      return 1
    }
    const { exits, completion } = graphExits(plan, step)
    if (exits.length === 0) {
      deps.io.out(`[STOP] ${name} @ ${current}: 已到终态，无后继事件（推进完成）`)
      return 0
    }
    // 硬门 marker：confirm/interaction 新鲜绝不自动跨越（--through-gates 也不行）——同 default 档
    const hard = await freshHardGate(deps)
    if (hard) {
      deps.io.out(`[STOP] ${name} @ ${current}: 硬门 .pipeline-pending-${hard} 新鲜存在——三门绝不自动跨越（HITL 红线）`)
      return 0
    }
    // 分岔先停，让人选择确切 event；没有选中的边就不该尝试消费任何 event-bound receipt。
    if (exits.length > 1) {
      const events = exits.map((transition) => transition.event).join(', ')
      deps.io.out(`[STOP] ${name} @ ${current}: 多条出边需人选 event（HITL），手动 transition 其一：${events}`)
      return 0
    }
    const edge = exits[0]
    if (edge === undefined) return 0
    // step 自带人门：review receipt 必须由 review acknowledge 产生（auto 门是守卫，不是人门）。
    if (step.gate === 'review') {
      if (!through) {
        deps.io.out(`[STOP] ${name} @ ${current}: step gate 'review'（HITL 门），停给人复核——确认后可用 --through-gates 继续`)
        return 0
      }
      const approved = await approvedReviewReceipt(deps, name, current, edge.event)
      if (approved === null) return 1
      if (!approved) {
        reviewReceiptStop(deps, name, current, edge.event)
        return 0
      }
    }
    if (steps >= maxSteps) {
      deps.io.out(`[STOP] ${name} @ ${current}: 达到 --max-steps=${maxSteps} 上限，停（防失控保险丝）`)
      return 0
    }
    // guard 必须全绿才推进（复用 cmdCheck：自定义分支走 kernel evaluateStepGuards 单源）
    const g = await guardQuietly(deps, name)
    if (g.code !== 0) {
      deps.io.out(`[STOP] ${name} @ ${current}: guard 未通过，停（修复后重试）`)
      for (const l of g.lines) if (l.includes('[FAIL]')) deps.io.out(`  ${l.trim()}`)
      return g.code === 2 ? 2 : 1
    }
    // 单步推进（复用 cmdTransition 自定义分支：withLock 内读-判-写 + history 落账）
    const t = await transitionQuietly(deps, name, edge.event)
    if (t.code !== 0) {
      deps.io.out(`[STOP] ${name} @ ${current}: transition ${edge.event} 失败，停`)
      for (const l of t.lines) deps.io.out(`  ${l.trim()}`)
      return 1
    }
    if (edge === completion) {
      deps.io.out(`[ADVANCE] ${name}: ${current} 完成（${edge.event}）`)
      deps.io.out(`[STOP] ${name} @ ${current}: 运行已归档，已到终态（推进完成）`)
      return 0
    }
    deps.io.out(`[ADVANCE] ${name}: ${current} -> ${edge.to}（${edge.event}）`)
    current = edge.to
    steps += 1
  }
}

/** --dry-run（自定义轨）：只读推演计划，绝不写盘（当前 step guard 真判，后续步运行时 live-guard）。 */
async function dryRunGraphPlan(
  deps: CliDeps,
  name: string,
  plan: EffectiveWorkflowPlan,
  start: string,
  archived: boolean,
  through: boolean,
  maxSteps: number,
): Promise<number> {
  const wf = plan.workflow
  deps.io.out(`[DRY-RUN] ${name}: 计划预览（不改盘）从 ${start} 起（max-steps=${maxSteps}${through ? '，through-gates' : ''}）`)
  const hard = await freshHardGate(deps)
  if (hard) {
    deps.io.out(`  预计停在 ${start}: 硬门 .pipeline-pending-${hard} 新鲜存在，绝不自动跨越（HITL 红线）`)
    return 0
  }
  const startStep = resolveStep(wf, start)
  if (!startStep) {
    // 防御：调用侧已校验；措辞同 transition/check
    deps.io.err(`ERROR: step '${start}' 不在 workflow '${plan.id}' 里`)
    return 1
  }
  if (archived) {
    deps.io.out(`  预计停在 ${start}: 运行已归档，已到终态`)
    return 0
  }
  const { exits: startExits } = graphExits(plan, startStep)
  if (startExits.length === 0) {
    deps.io.out(`  预计停在 ${start}: 已到终态`)
    return 0
  }
  if (startExits.length > 1) {
    deps.io.out(`  预计停在 ${start}: 多条出边需人选 event（可选: ${startExits.map((t) => t.event).join(', ')}）`)
    return 0
  }
  const startEdge = startExits[0]
  if (startEdge === undefined) return 0
  if (startStep.gate === 'review') {
    if (!through) {
      deps.io.out(`  预计停在 ${start}: step gate 'review'（HITL 门，确认后可用 --through-gates 继续）`)
      return 0
    }
    const approved = await approvedReviewReceipt(deps, name, start, startEdge.event)
    if (approved === null) return 1
    if (!approved) {
      reviewReceiptStop(deps, name, start, startEdge.event, true)
      return 0
    }
  }
  // 当前 step guard 真判（只读，cmdCheck 自定义分支）
  const g = await guardQuietly(deps, name)
  if (g.code !== 0) {
    deps.io.out(`  guard@${start} 未通过 → 预计停在 ${start}（不推进）`)
    for (const l of g.lines) if (l.includes('[FAIL]')) deps.io.out(`  ${l.trim()}`)
    return 0
  }
  deps.io.out(`  guard@${start}: 通过`)

  let current = start
  let steps = 0
  const visited = new Set<string>()
  while (steps < maxSteps) {
    const step = resolveStep(wf, current)
    if (!step) {
      deps.io.err(`ERROR: step '${current}' 不在 workflow '${plan.id}' 里`)
      return 1
    }
    const { exits, completion } = graphExits(plan, step)
    if (exits.length === 0) {
      deps.io.out(`  预计停在 ${current}: 已到终态`)
      return 0
    }
    if (exits.length > 1) {
      deps.io.out(`  预计停在 ${current}: 多条出边需人选 event（可选: ${exits.map((t) => t.event).join(', ')}）`)
      return 0
    }
    const edge = exits[0]
    if (edge === undefined) return 0
    const liveGuard = steps === 0 ? '' : '  [live-guard]'
    if (edge === completion) {
      deps.io.out(`  计划 ${steps + 1}: ${current} 完成（${edge.event}）${liveGuard}`)
      deps.io.out(`  预计停在 ${current}: 运行归档，已到终态`)
      return 0
    }
    deps.io.out(`  计划 ${steps + 1}: ${current} -> ${edge.to}（${edge.event}）${liveGuard}`)
    visited.add(current)
    current = edge.to
    steps += 1
    const entered = resolveStep(wf, current)
    if (entered?.gate === 'review') {
      const reviewExits = graphExits(plan, entered).exits
      if (!through) {
        deps.io.out(`  预计停在 ${current}: step gate 'review'（HITL 门，确认后可用 --through-gates 继续）`)
      } else if (reviewExits.length === 1) {
        const reviewEdge = reviewExits[0]
        if (reviewEdge) reviewReceiptStop(deps, name, current, reviewEdge.event, true)
      } else {
        deps.io.out(`  预计停在 ${current}: review step 有多条出边，须由人选择 event 后 request`)
      }
      return 0
    }
    if (visited.has(current)) {
      deps.io.out(`  预计停在 ${current}: 检测到环，停`)
      return 0
    }
  }
  deps.io.out(`  预计在 ${current} 触及 --max-steps=${maxSteps} 上限`)
  return 0
}
