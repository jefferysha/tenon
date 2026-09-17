/**
 * tenon internal-skill-gate <name> <skillId> —— 隐藏命令，所有 workflow 的 effective Skill
 * DAG 解锁判定，从 hooks/gate.sh 委托过来（GOAL 清单 E Task 9）。default 的 manifest overlay
 * 与 custom 的 step graph 都先编译为 EffectiveWorkflowPlan capability，再在本入口统一判定。
 *
 * exit 口径（同 gate.sh 契约）：0=放行，2=拦截。本命令绝不让 0/2 之外的 code 泄漏出去——Skill
 * 的内部异常（state 读不到 / workflow 文件损坏 / history 行损坏等）仍 catch 到顶层并 fail-open，
 * 避免证据系统死锁。
 */
import {
  isSkillUnlocked,
  resolveAvailableSkillSlots,
  resolveRequiredSkillSlots,
  type PipelineState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { str } from '../render.js'
import { reconcileCodexSkillEvidence } from '../codexSkillReceipt.js'
import { agentSkillDecision } from '../agentSkillGate.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { canonicalTenonSkillId, completedSkillsSinceStepEntry, parseHistoryLines } from './stepSkillEvidence.js'

/** `tenon` is the normal-chat orchestration entrypoint, not a phase work item. Every custom
 * workflow reaches it before the selected step's own DAG can run, so enforcing per-step membership
 * here would prevent the workflow from starting. Keep this allowlist deliberately exact: phase
 * skills such as `tenon-open` remain subject to the declared DAG. */
function isTenonOrchestratorSkill(skillId: string): boolean {
  return canonicalTenonSkillId(skillId) === 'tenon'
}

export async function cmdInternalSkillGate(deps: CliDeps, name: string, skillId: string): Promise<number> {
  try {
    if (!isValidChangeName(name)) {
      deps.io.err(`WARN: internal-skill-gate 收到非法 change 名 '${name}'，fail-open 放行`)
      return 0
    }
    if (isTenonOrchestratorSkill(skillId)) return 0
    const canonicalSkillId = canonicalTenonSkillId(skillId)

    const dir = changeDir(deps.cwd, name)
    // Reconciliation is deliberately synchronous and under the same change lock as this DAG
    // read.  A Codex PreToolUse receipt still has no effect unless the host transcript proves the
    // matching exec call completed; after that proof is appended, this invocation immediately sees
    // it instead of requiring an unreliable PostToolUse callback or a second user turn.
    return await deps.store.withLock(dir, async () => {
      const state = await deps.store.read(dir)
      // 双轨分岔同 transition.ts（Task 8）：'' 历史遗留兜 'default' 的 `||` 习语单源在 kernel
      // resolveWorkflowName（Wave 2 下沉；`??` 只挡 null/undefined、不挡空串的语义原样继承）。
      const plan = effectiveWorkflowForState(deps, state)
      if (!plan) {
        deps.io.err(`WARN: workflow '${String(state.fields.workflow ?? '')}' 未找到，fail-open 放行`)
        return 0
      }
      const currentStepId = str(state.fields.phase)
      // agent 技能先判：它不属于步骤 DAG，只在自己的 agent 跑着时解锁。
      const agentDecision = await agentSkillDecision({
        deps, name, dir, stepId: currentStepId, plan, state, skillId: canonicalSkillId,
      })
      if (agentDecision.kind === 'allow') return 0
      if (agentDecision.kind === 'block') {
        deps.io.err(agentDecision.message)
        return 2
      }
      const skillCapability = plan.capabilities.skills
      const capabilityStep = skillCapability.steps.find((candidate) => candidate.stepId === currentStepId)
      if (!capabilityStep) {
        deps.io.err(`WARN: step '${currentStepId}' 不在 workflow '${plan.id}' 里，fail-open 放行`)
        return 0
      }
      if (skillCapability.source === 'manifest-overlay') {
        const slots = resolveAvailableSkillSlots(deps.resolver, skillCapability, currentStepId)
        const requiredSlots = resolveRequiredSkillSlots(deps.resolver, skillCapability, currentStepId)
        const canonicalSlots = slots.map((slot) => ({
          token: slot.token,
          alternatives: slot.alternatives.map(canonicalTenonSkillId),
        }))
        const canonicalRequiredSlots = requiredSlots.map((slot) => ({
          token: slot.token,
          alternatives: slot.alternatives.map(canonicalTenonSkillId),
        }))
        const slotIndex = canonicalSlots.findIndex((slot) => slot.alternatives.includes(canonicalSkillId))
        await reconcileCodexSkillEvidence({
          repoRoot: deps.cwd,
          changeDir: dir,
          candidateSkillIds: [
            ...canonicalSlots.flatMap((slot) => slot.alternatives),
            ...canonicalRequiredSlots.flatMap((slot) => slot.alternatives),
          ],
          recordedAt: deps.clock(),
          history: deps.history,
          evidenceScope: currentStepId,
        })
        const lines = parseHistoryLines((await deps.readHistoryRaw?.(dir)) ?? '')
        const completed = completedSkillsSinceStepEntry(lines, currentStepId)
        // Optional/undeclared skills cannot be used to bypass a missing Workflow-owned phase
        // requirement. The optional path intentionally checks only the frozen Workflow phase
        // slots: Track mandatory overlays are available/orderable when declared, but they must
        // not turn an otherwise-unrelated optional Skill into a new mandatory dependency.
        if (slotIndex < 0) {
          const phaseRequiredSlots = capabilityStep.requiredSkillIds.map((id) => ({
            token: id,
            alternatives: [canonicalTenonSkillId(id)],
          }))
          const missingRequired = phaseRequiredSlots
            .filter((slot) => !slot.alternatives.some((candidate) => completed.has(candidate)))
            .map((slot) => slot.token)
          // Unrelated optional skills are gated only by the Workflow-owned phase entry
          // requirement. Track overlay mandatory slots (for example openspec-propose on
          // backend) must not turn an undeclared optional invocation into a hard dependency
          // once the phase skill itself has completed.
          const phaseEntry = phaseRequiredSlots[0]
          if (phaseEntry === undefined || phaseEntry.alternatives.some((candidate) => completed.has(candidate))) return 0
          if (missingRequired.length === 0) return 0
          deps.io.err(
            `【Tenon 门】skill '${skillId}' 在 default step '${currentStepId}' 未解锁：` +
            `还需先完成 ${missingRequired.join(', ')}（本次进入该 step 之后）`,
          )
          return 2
        }
        const missing = canonicalSlots
          .slice(0, slotIndex)
          .filter((slot) => !slot.alternatives.some((candidate) => completed.has(candidate)))
          .map((slot) => slot.token)
        if (missing.length === 0) return 0
        deps.io.err(
          `【Tenon 门】skill '${skillId}' 在 default step '${currentStepId}' 未解锁：` +
          `还需先完成 ${missing.join(', ')}（本次进入该 step 之后）`,
        )
        return 2
      }

      await reconcileCodexSkillEvidence({
        repoRoot: deps.cwd,
        changeDir: dir,
        // A missing Codex PostToolUse callback must not force a user retry: reconcile every
        // declared node in this exact step before checking the next node's dependencies.  The
        // transcript bridge remains bounded to trusted plugin paths and this physical project.
          candidateSkillIds: capabilityStep.declared.map((ref) => canonicalTenonSkillId(ref.id)),
        recordedAt: deps.clock(),
        history: deps.history,
        evidenceScope: currentStepId,
      })

      // step 声明了 skills: []（未声明任何 skill）时的"视为不使用 DAG，任意 skillId 放行"这条
      // opt-in 语义现在是 isSkillUnlocked 自己契约的一部分（见该函数上方注释），本层不再需要
      // 重复这条判断——统一交给下面的 isSkillUnlocked 调用处理，避免同一条契约在两处漂移。
      const historyRaw = (await deps.readHistoryRaw?.(dir)) ?? ''
      const lines = parseHistoryLines(historyRaw)
      const completedSinceEntry = completedSkillsSinceStepEntry(lines, currentStepId)
      // Workflow YAML may retain the historical `tenon:<id>` spelling while Codex uses
      // its namespace at invocation time and cache receipts use bare ids. Normalize only our own
      // namespace, including dependencies, before delegating to the single kernel DAG predicate.
      const canonicalStepSkills = capabilityStep.declared.map((ref) => ({
        id: canonicalTenonSkillId(ref.id),
        depends_on: ref.dependsOn.map(canonicalTenonSkillId),
      }))

      if (isSkillUnlocked(canonicalSkillId, canonicalStepSkills, completedSinceEntry)) return 0

      // 判定为锁定：区分"根本没声明这个 skill"和"声明了但依赖没完成"两种情形，给出更具体的指引。
      const ref = canonicalStepSkills.find((s) => s.id === canonicalSkillId)
      if (!ref) {
        deps.io.err(
          `【Tenon 门】skill '${skillId}' 不在 step '${currentStepId}'（workflow '${plan.id}'）声明的 skills 列表里，暂不可用`,
        )
      } else {
        const missing = (ref.depends_on ?? []).filter((d) => !completedSinceEntry.has(d))
        deps.io.err(
          `【Tenon 门】skill '${skillId}' 在 step '${currentStepId}'（workflow '${plan.id}'）未解锁：` +
            `还需先完成 ${missing.join(', ')}（本次进入该 step 之后）`,
        )
      }
      return 2
    })
  } catch (e) {
    deps.io.err(`WARN: internal-skill-gate 内部异常，fail-open 放行: ${errMsg(e)}`)
    return 0
  }
}
