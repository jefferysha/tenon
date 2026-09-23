import { parseBuildRevisionToken, type EffectiveWorkflowPlan, type PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

/**
 * 候选版本 = 「这份代码」的稳定身份：评审结论与测试记录都绑定它，改了代码旧结论就过期。
 * 与测试记录同一口径：有工作区指纹能力时一律用内容寻址的工作区指纹——冻结的 build token 在 verify
 * 期间不随代码变化，拿它当评审候选会让改码后的旧评审继续显示通过（测试却已过期）。只有没有指纹能力
 * 时才回落到 candidate 形态的 step input（build token）。Dashboard 的评审投影同样用工作区指纹。
 */
const CANDIDATE_RE = /^(?:sha256:|workspace:sha256:)[0-9a-f]{64}$|^git:[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** Normalize the current Build token to the candidate ABI. The token is accepted only in its
 * canonical build:v1 grammar; legacy candidate fingerprints remain valid. No trimming or hash
 * recomputation is performed here, so caller-supplied non-canonical values fail closed before
 * they can be compared with or persisted as a candidate. */
export function normalizeCandidate(value: unknown): string | undefined {
  const token = parseBuildRevisionToken(value)
  if (token !== undefined) return `sha256:${token.revisionHash}`
  if (typeof value === 'string' && CANDIDATE_RE.test(value)) return value
  return undefined
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(',')
  return null
}

/** Resolve the current candidate: the content-addressed workspace fingerprint when the capability
 * exists (the same key test records bind to), else a candidate-shaped frozen step input. */
export async function currentCandidate(
  deps: CliDeps,
  change: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  scope: string,
): Promise<string> {
  const step = plan.workflow.steps.find((entry) => entry.id === scope)
  if (step === undefined) throw new Error(`当前 step '${scope}' 不在 frozen workflow 中`)
  if (deps.workspaceFingerprint !== undefined) {
    const current = (await deps.workspaceFingerprint(change)).trim()
    const candidate = normalizeCandidate(current)
    if (candidate === undefined) throw new Error('workspace fingerprint capability 返回非法 candidate')
    return candidate
  }
  const declared = [...new Set(step.inputs.flatMap((input) => {
    const value = scalar(Reflect.get(state.fields, input.field))
    const candidate = value === null ? undefined : normalizeCandidate(value)
    return candidate === undefined ? [] : [candidate]
  }))]
  if (declared.length > 1) throw new Error(`step '${scope}' 存在多个 candidate-shaped frozen input`)
  if (declared[0] !== undefined) return declared[0]
  throw new Error(`step '${scope}' 未声明 candidate input，且缺少 workspace fingerprint capability`)
}
