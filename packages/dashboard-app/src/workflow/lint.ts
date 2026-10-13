import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { isAbandonEvent } from '@tenon/kernel/workflow/abandon-event'
import { isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'

type LintKind =
  | { kind: 'transition-empty-event'; stepId: string }
  | { kind: 'transition-duplicate-event'; stepId: string; event: string }
  | { kind: 'transition-contract-required'; stepId: string; to: string }
  | { kind: 'transition-not-next-or-back'; stepId: string; event: string; to: string }
  | { kind: 'test-id-duplicate'; stepId: string; test: string }
  | { kind: 'test-command-empty'; stepId: string; test: string }
  | { kind: 'test-output-location'; stepId: string; test: string; path: string }
  | { kind: 'agent-missing'; stepId: string; agent: string }

/** error 挡保存（与 kernel 校验一致）；warning 只在导航上标点。 */
export type LintIssue = LintKind & { severity: 'error' | 'warning' }

/**
 * default 必须保留的转移（与 kernel 的 CANONICAL_TRANSITIONS 逐条对齐）。包含两条回流：
 * build → spec（需求变了，退回规格）与 verify → build（验收不通过，退回实现）。删掉它们服务端会
 * 拒，前端先挡住，让用户看到原因而不是吃一个 400。
 */
const CONTRACT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  open: ['explore'],
  explore: ['spec'],
  spec: ['build'],
  build: ['verify', 'spec'],
  verify: ['ship', 'build'],
  ship: ['archive'],
  archive: [],
}

/** 声明式测试输出只能落在工作区指纹排除的目录下（同 kernel TEST_OUTPUT_DIR_SEGMENTS）。 */
const TEST_OUTPUT_SEGMENTS: readonly string[] = ['test-results', 'playwright-report', 'coverage']

/** 测试项的编辑期检查，与 kernel compileStepTests 对齐：id 分支内唯一、命令非空、输出位置受限。 */
function testIssues(def: WbWorkflowDef): LintIssue[] {
  const issues: LintIssue[] = []
  const owner = new Map<string, string>()
  for (const step of def.steps) {
    for (const test of step.tests ?? []) {
      if (owner.has(test.id)) issues.push({ kind: 'test-id-duplicate', stepId: step.id, test: test.id, severity: 'error' })
      else owner.set(test.id, step.id)
      if (test.command.trim() === '') issues.push({ kind: 'test-command-empty', stepId: step.id, test: test.id, severity: 'error' })
      for (const output of test.outputs ?? []) {
        if (!output.path.split('/').some((segment) => TEST_OUTPUT_SEGMENTS.includes(segment))) {
          issues.push({ kind: 'test-output-location', stepId: step.id, test: test.id, path: output.path, severity: 'error' })
        }
      }
    }
  }
  return issues
}

/**
 * 编辑器保存前校验（kernel 校验之外的产品规则）：
 *   · 转移的事件名非空且在本阶段内唯一——引擎按事件名分派，重名无法判定走哪条；
 *   · 每条转移要么是去下一阶段的唯一一条，要么退回更早的阶段；
 *   · default 保留 CONTRACT_TRANSITIONS 要求的去向；
 *   · 测试 id 在分支内唯一、命令非空、声明输出落在测试目录下；
 *   · 步骤声明的 agent 必须在库里——库还没拉到（agents 为 null）就不判，不谎报。
 * 不手写每步的输入输出：没有输出的阶段不是问题，必须产出由 `required-output` 守卫表达，由 kernel 校验路径模式。
 */
export function lintWorkflow(def: WbWorkflowDef, agents?: readonly string[] | null): LintIssue[] {
  const issues: LintIssue[] = []
  const canonical = def.openspec === true && isDefaultWorkflowName(def.name)
  def.steps.forEach((step, index) => {
    const next = def.steps[index + 1]
    const earlier = new Set(def.steps.slice(0, index).map((candidate) => candidate.id))
    const seen = new Set<string>()
    for (const transition of step.transitions) {
      if (transition.event.trim() === '') {
        issues.push({ kind: 'transition-empty-event', stepId: step.id, severity: 'error' })
        continue
      }
      if (seen.has(transition.event)) issues.push({ kind: 'transition-duplicate-event', stepId: step.id, event: transition.event, severity: 'error' })
      seen.add(transition.event)
    }
    let forwardSeen = false
    for (const transition of step.transitions) {
      if (!forwardSeen && next !== undefined && transition.to === next.id) {
        forwardSeen = true
        continue
      }
      if (earlier.has(transition.to)) continue
      // An explicit `archived` self-edge is the kernel's completion edge written out in YAML.
      if (transition.event === 'archived' && transition.to === step.id) continue
      // The abandon edge (`scope-expanded`, lite track) leaves for a terminal step on purpose; it is neither next nor back.
      if (isAbandonEvent(transition.event) && step.id !== transition.to && def.steps.some((candidate) => candidate.id === transition.to)) continue
      issues.push({ kind: 'transition-not-next-or-back', stepId: step.id, event: transition.event, to: transition.to, severity: 'error' })
    }
    if (canonical) {
      for (const to of CONTRACT_TRANSITIONS[step.id] ?? []) {
        if (!step.transitions.some((transition) => transition.to === to)) {
          issues.push({ kind: 'transition-contract-required', stepId: step.id, to, severity: 'error' })
        }
      }
    }
  })
  issues.push(...testIssues(def))
  if (agents != null) {
    for (const step of def.steps) {
      const declared = [
        ...(step.agents?.executors ?? []).map((ref) => ref.agent),
        ...(step.agents?.reviewers ?? []).map((ref) => ref.agent),
      ]
      for (const agent of declared) {
        if (!agents.includes(agent)) issues.push({ kind: 'agent-missing', stepId: step.id, agent, severity: 'error' })
      }
    }
  }
  return issues
}

export function issuesFor(issues: readonly LintIssue[], stepId: string): LintIssue[] {
  return issues.filter((issue) => issue.stepId === stepId)
}

export function stepById(def: WbWorkflowDef, id: string): WbStepDef | undefined {
  return def.steps.find((step) => step.id === id)
}
