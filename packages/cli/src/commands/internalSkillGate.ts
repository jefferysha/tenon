/**
 * tenon internal-skill-gate <name> <skillId> —— 隐藏命令，所有 workflow 的 effective Skill
 * DAG 解锁判定，从 hooks/gate.sh 委托过来（GOAL 清单 E Task 9）。default 的 manifest overlay
 * 与 custom 的 step graph 都先编译为 EffectiveWorkflowPlan capability，再在本入口统一判定。
 *
 * exit 口径（同 gate.sh 契约）：0=放行，2=拦截。本命令绝不让 0/2 之外的 code 泄漏出去——任何
 * 普通 work Skill 的内部异常（state 读不到 / workflow 文件损坏 / history 行损坏等）仍 catch 到
 * 顶层并 fail-open，避免证据系统死锁；但一旦 effective plan 已显式把 Skill 分类为 Review，active
 * attempt 的缺失、损坏或 lane 不匹配必须在派发前 fail-closed（exit 2）。
 */
import {
  createReviewAttemptBudgetStore,
  isSkillUnlocked,
  resolveAvailableSkillSlots,
  resolveRequiredSkillSlots,
  type EffectiveWorkflowPlan,
  type PipelineState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { str } from '../render.js'
import { reconcileCodexSkillEvidence } from '../codexSkillReceipt.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { frozenReviewCandidate } from './review-candidate.js'

interface HistLine {
  readonly kind: string
  readonly to?: string
  readonly raw?: string
}

function decodeHistoryLine(value: unknown): HistLine | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.kind !== 'string') return null
  if (record.to !== undefined && typeof record.to !== 'string') return null
  if (record.raw !== undefined && typeof record.raw !== 'string') return null
  return {
    kind: record.kind,
    ...(typeof record.to === 'string' ? { to: record.to } : {}),
    ...(typeof record.raw === 'string' ? { raw: record.raw } : {}),
  }
}

/** 容错解析 .pipeline-history.jsonl 原文——单行损坏不该拖垮整条 gate 判定，跳过即可（fail-open 精神）。 */
function parseHistoryLines(raw: string): HistLine[] {
  const out: HistLine[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const decoded = decodeHistoryLine(JSON.parse(line))
      if (decoded) out.push(decoded)
    } catch {
      // 损坏行跳过，不拖垮整体判定
    }
  }
  return out
}

/** hooks/skill-tracker.sh 落的 skill 完成记录有两种可信宿主形态：Claude 的
 * "Skill: <skill-id>" 与 Codex 对当前插件已打包 SKILL.md 的受控读取
 * "CodexSkillRead: <skill-id>"。二者都由同一 hook 写入，且后者已通过
 * skill-evidence.sh 限制为插件根内实际存在的 skill；因此它们都可以满足 DAG 依赖。
 * Agent/Task 等其它 tool kind 仍不属于 skill DAG 命名空间，不能误算为已完成。 */
function skillIdFromToolRaw(raw: string): string | null {
  const m = /^(?:Skill|CodexSkillRead): (.+)$/.exec(raw)
  return m?.[1] ?? null
}

/** Pipeline-owned skills are presented by Codex as `tenon:<id>`, while workflow YAML and
 * immutable cache receipts use their bare id. Canonicalize this one plugin namespace before DAG
 * membership and prior-completion comparisons; leave third-party namespaces intact so custom
 * workflows can still model them explicitly. */
function canonicalTenonSkillId(skillId: string): string {
  return skillId.startsWith('tenon:') ? skillId.slice('tenon:'.length) : skillId
}

/** `tenon` is the normal-chat orchestration entrypoint, not a phase work item. Every custom
 * workflow reaches it before the selected step's own DAG can run, so enforcing per-step membership
 * here would prevent the workflow from starting. Keep this allowlist deliberately exact: phase
 * skills such as `tenon-open` remain subject to the declared DAG. */
function isTenonOrchestratorSkill(skillId: string): boolean {
  return canonicalTenonSkillId(skillId) === 'tenon'
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function explicitReviewLane(
  deps: CliDeps,
  plan: EffectiveWorkflowPlan,
  stepId: string,
  skillId: string,
): string | undefined {
  if (plan.capabilities.skills.source === 'manifest-overlay') {
    return deps.resolver.reviewLaneFor?.(plan.capabilities.skills, stepId, skillId)
  }
  const step = plan.capabilities.skills.steps.find((candidate) => candidate.stepId === stepId)
  return step?.declared.find((skill) => skill.id === skillId && skill.kind === 'review')?.reviewLane
}

async function requireActiveReviewAttempt(
  deps: CliDeps,
  change: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  skillId: string,
): Promise<boolean> {
  const stepId = scalar(state, 'phase')
  const lane = explicitReviewLane(deps, plan, stepId, skillId)
  if (lane === undefined) return true
  const requiredLanes = plan.capabilities.review.laneScopes
    .find((scope) => scope.stepId === stepId)?.lanes
  if (requiredLanes === undefined || !requiredLanes.includes(lane)) {
    deps.io.err(
      `【Tenon Review 门】skill '${skillId}' 映射 lane '${lane}'，但 step '${stepId}' 未声明该 review_lanes`,
    )
    return false
  }
  const runId = state.runMetadata?.runId
  if (runId === undefined || runId === '') {
    deps.io.err(`【Tenon Review 门】skill '${skillId}' 缺 durable run identity，拒绝派发`)
    return false
  }
  try {
    const budget = await createReviewAttemptBudgetStore().inspect({
      projectRoot: deps.cwd,
      changeDir: dir,
      runId,
      workflowFingerprint: plan.workflowFingerprint,
      scope: stepId,
    })
    const active = budget?.active
    const candidateFingerprint = await frozenReviewCandidate(deps, change, state, plan, stepId)
    if (active === null || active === undefined
      || active.requiredLanes.length !== requiredLanes.length
      || active.requiredLanes.some((required, index) => required !== requiredLanes[index])
      || active.candidateFingerprint !== candidateFingerprint) {
      deps.io.err(
        `【Tenon Review 门】skill '${skillId}' 属于 lane '${lane}'，派发前必须先为当前 frozen candidate `
        + `执行 tenon review-attempt begin（used=${budget?.used ?? 0}/${budget?.maxAttempts ?? plan.reviewBudget.max_attempts}）`,
      )
      return false
    }
    return true
  } catch (error) {
    deps.io.err(`【Tenon Review 门】无法证明 active attempt，拒绝派发: ${errMsg(error)}`)
    return false
  }
}

/**
 * 找最近一次进入 currentStepId 的 transition 记录，只统计其后的 skill 完成记录——同一 step
 * 可能被回环重新进入多次（自定义 workflow 允许任意 event 图，不像 default workflow 只有
 * build⇄verify 这一条回边），只有"这一次"进入之后的完成记录才该算数，否则上一轮的旧完成
 * 记录会让重新进入的 step 误判为"已解锁"。
 *
 * 复用 workflow-skill-orchestration.integration.test.ts 的 index-based 分段扫描写法（先定位
 * 分段起点索引，再 slice 之后的区间），只是这里要找"最近一次"（倒序扫描取第一个命中）而非
 * 该测试里固定线性顺序的"第一次"（正序 findIndex）——需求不同，扫描 shape 相同。
 */
function completedSkillsSinceStepEntry(lines: readonly HistLine[], currentStepId: string): ReadonlySet<string> {
  let enteredAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.kind === 'transition' && lines[i]?.to === currentStepId) {
      enteredAt = i
      break
    }
  }
  const completed = new Set<string>()
  for (const line of lines.slice(enteredAt + 1)) {
    if (line.kind !== 'tool') continue
    const id = skillIdFromToolRaw(line.raw ?? '')
    if (id) completed.add(canonicalTenonSkillId(id))
  }
  return completed
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
    const preflightState = await deps.store.read(dir)
    const preflightPlan = effectiveWorkflowForState(deps, preflightState)
    if (preflightPlan !== null
      && !await requireActiveReviewAttempt(deps, name, dir, preflightState, preflightPlan, canonicalSkillId)) {
      return 2
    }
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
