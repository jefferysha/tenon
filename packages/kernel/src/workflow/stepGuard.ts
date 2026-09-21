import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentBlocker } from './agent-verdict.js'
import { compileStepGuards } from './compile.js'
import { evaluateGuards, type GuardEvaluation } from './guard-handlers.js'
import type { CompiledGuardConfig, GuardInput, StepIR } from './ir.js'
import type { StepDef } from './types.js'
import type { PipelineState, GuardResult } from '../types.js'
import { normalizeDefaultGuardFields } from '../flow/default-event-policy.js'
import { safeRevisionHash } from './build-revision.js'

/**
 * 自定义 workflow 当前 step 的出口 guard 评估（G2 P2：v1 两变体经 compileStepGuards 下沉后走
 * GUARD_HANDLERS 同一 handler 路径，不再各写一份 if 链）。changeDirAbs = tasks.md 所在 change 目录；
 * fileExists（项目根相对）/gitHeadSha/workspaceFingerprint 是 guard 变体能力；普通文件面
 * 仍按既有可选能力语义处理，但 build-head-unchanged 现在必须绑定 revision assessor，缺失
 * capability 会 fail-closed 为 typed revision blocker，绝不 skipped/pass。
 */
export interface StepGuardContext {
  readonly changeDirAbs: string
  readonly fileExists?: (repoRelativePath: string) => boolean
  readonly gitHeadSha?: () => Promise<string>
  readonly workspaceFingerprint?: () => Promise<string>
  readonly assessBuildRevision?: GuardInput['assessBuildRevision']
  readonly currentStep?: string
  readonly specMigrationStatus?: GuardInput['specMigrationStatus']
  /**
   * 本步 agent 的阻断（Dashboard 的预测读模型用）：缺省 = 该门禁未接线，不产生 agent 拦截。
   * 只在前进出边上加进 readiness——退回边永不检查 agent。
   */
  readonly stepAgents?: () => Promise<readonly AgentBlocker[]>
}

export type { GuardResult } from '../types.js'

function fieldStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(',') : (v ?? '')
}

/** 读 <changeDirAbs>/<rel> 原文；缺失/不可读 → undefined（tasks-at-least handler 视作 0 任务，
 *  与 flow/guard.ts 缺文件语义一致）。 */
function readChangeText(changeDirAbs: string, rel: string): string | undefined {
  try {
    return readFileSync(path.join(changeDirAbs, rel), 'utf8')
  } catch {
    return undefined
  }
}

/** 由 state + StepGuardContext 组装 handler 注入面（GuardInput）：readText 绑 changeDir（tasks-at-least
 *  用）、track 取 change 的 track 字段（when 谓词按它生效）、fileExists/gitHeadSha/workspaceFingerprint 透传。 */
export function buildStepGuardInput(state: PipelineState, ctx: StepGuardContext): GuardInput {
  return {
    fields: state.fields,
    stateHash: safeRevisionHash(state.fields),
    rawBuildSha: state.fields.build_sha,
    track: fieldStr(state.fields.track),
    readText: (rel) => readChangeText(ctx.changeDirAbs, rel),
    fileExists: ctx.fileExists,
    gitHeadSha: ctx.gitHeadSha,
    workspaceFingerprint: ctx.workspaceFingerprint,
    specMigrationStatus: ctx.specMigrationStatus,
    assessBuildRevision: ctx.assessBuildRevision,
    currentStep: ctx.currentStep ?? fieldStr(state.fields.phase),
  }
}

/** Default transitions share the same infrastructure capabilities but preserve legacy fstr fields. */
export function buildDefaultGuardInput(state: PipelineState, ctx: StepGuardContext): GuardInput {
  return {
    ...buildStepGuardInput(state, ctx),
    fields: normalizeDefaultGuardFields(state.fields),
    track: fieldStr(state.fields.track),
    currentStep: ctx.currentStep ?? fieldStr(state.fields.phase),
  }
}

/**
 * 单条 failed 评估 → 面向人的失败文案。v1 两变体逐字复刻旧 evaluateStepGuards 的文案
 * （tasks-at-least / nonempty-output 展开出的 field-nonempty——check 命令等直接断言这两句，
 * 逐字不变是硬约束）；新变体给清晰的中文说明。仅在 decision.kind==='failed' 时有意义。
 */
export function renderGuardFailure(ev: GuardEvaluation, stepId: string): string {
  const g = ev.guard
  const d = ev.decision
  if (d.kind !== 'failed') return ''
  switch (g.type) {
    case 'tasks-at-least':
      return `step '${stepId}' 要求 tasks.md 至少 ${g.n} 个任务（当前=${d.actual ?? '0'}）`
    case 'field-nonempty':
      return `字段 '${g.field}' 未设置（step '${stepId}' 声明为必须产出）`
    case 'output-present':
      // v1 nonempty-output 下沉到列表/未知惰性 output 的失败文案，与 field-nonempty 逐字同款
      // （旧 evaluateStepGuards 对每个未产出 output 都是这句「声明为必须产出」，无缝衔接）。
      return `字段 '${g.field}' 未设置（step '${stepId}' 声明为必须产出）`
    case 'file-exists':
      return `step '${stepId}' 要求字段 '${g.path.field}' 指向的文件存在（当前=${d.actual ?? ''}）`
    case 'field-equals':
      return `step '${stepId}' 要求字段 '${g.field}'=${g.value}（当前=${d.actual ?? ''}）`
    case 'field-in':
      return `step '${stepId}' 要求字段 '${g.field}' ∈ {${g.values.join(', ')}}（当前=${d.actual ?? ''}）`
    case 'full-direct-override':
      return `step '${stepId}' 要求 preset=full 且 build_mode=direct 时 direct_override=true（当前=${d.actual ?? ''}）`
    case 'build-head-unchanged':
      if (d.blocker !== undefined) {
        const blocker = d.blocker
        return [
          blocker.code,
          `reason=${blocker.reason}`,
          `remediation=${blocker.remediation}`,
          ...(blocker.stateHash === undefined ? [] : [`stateHash=${blocker.stateHash}`]),
          ...(blocker.revisionHash === undefined ? [] : [`revisionHash=${blocker.revisionHash}`]),
        ].join(' ')
      }
      if ((d.expected?.[0] ?? '').startsWith('workspace:sha256:')) {
        return `step '${stepId}' 要求当前工作区内容等于 build 冻结基线（build_sha=${d.expected?.[0] ?? ''}，当前=${d.actual ?? ''}）`
      }
      return `step '${stepId}' 要求当前 HEAD 等于 build 冻结的 SHA（build_sha=${d.expected?.[0] ?? ''}，HEAD=${d.actual ?? ''}）`
    case 'spec-migration-applied':
      return `step '${stepId}' 要求主规格迁移已由机器证据确认（当前=${d.actual ?? '未知'}）`
    default: {
      const exhaustive: never = g
      return `step '${stepId}' guard 未通过：${JSON.stringify(exhaustive)}`
    }
  }
}

/**
 * 评估一组已编译 guard（collect-all——评估全部适用 guard 并收集全部 failed，对齐旧
 * evaluateStepGuards 逐条列全部未过项的 step-guard 语义，令旧 YAML 多失败项行为逐字不变）
 * + 渲染失败文案。engine.planStepTransition 与 evaluateStepGuards 共用此单源，两处失败文案同口径。
 */
export async function evaluateCompiledGuards(
  guards: readonly CompiledGuardConfig[],
  stepId: string,
  input: GuardInput,
): Promise<GuardResult> {
  const evals = await evaluateGuards(guards, input, { stopOnFirstFailure: false })
  const failures = evals
    .filter((e) => e.decision.kind === 'failed')
    .map((e) => renderGuardFailure(e, stepId))
  const blockers = evals
    .flatMap((e) => e.decision.kind === 'failed' && e.decision.blocker !== undefined
      ? [e.decision.blocker]
      : [])
  return {
    pass: failures.length === 0,
    failures,
    ...(blockers.length === 0 ? {} : { blockers }),
  }
}

/**
 * check 预览等直接消费的入口：编译 StepDef 的 guards（含 nonempty-output → field-nonempty 展开）
 * 后走 evaluateCompiledGuards。变 async：handler 面（含 file-exists/build-head-unchanged 的 IO）
 * 统一异步；tasks-at-least 经 readText 注入读 changeDir/tasks.md 真实计数（单一真相源 taskCount）。
 */
export async function evaluateStepGuards(state: PipelineState, step: StepDef, ctx: StepGuardContext): Promise<GuardResult> {
  const guards = compileStepGuards(step)
  return evaluateCompiledGuards(guards, step.id, buildStepGuardInput(state, ctx))
}

/** EffectiveWorkflowPlan consumers already hold compiled StepIR and must not rebuild definition
 * semantics in an adapter. */
export async function evaluateWorkflowIrStepGuards(
  state: PipelineState,
  step: StepIR,
  ctx: StepGuardContext,
): Promise<GuardResult> {
  return evaluateCompiledGuards(step.guards, step.id, buildStepGuardInput(state, ctx))
}
