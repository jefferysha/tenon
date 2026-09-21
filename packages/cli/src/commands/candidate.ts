import { parseBuildRevisionToken, type EffectiveWorkflowPlan, type PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

/**
 * 候选版本 = 「这份代码」的稳定身份：评审结论与测试记录都绑定它，改了代码旧结论就过期。
 * 声明了 candidate 形态的 step input（build token）就用它，否则用内容寻址的工作区指纹。
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

/** Resolve the candidate from a frozen step input; steps that declare no candidate-shaped input
 * fall back to the current content-addressed workspace fingerprint. */
export async function currentCandidate(
  deps: CliDeps,
  change: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  scope: string,
): Promise<string> {
  const step = plan.workflow.steps.find((entry) => entry.id === scope)
  if (step === undefined) throw new Error(`当前 step '${scope}' 不在 frozen workflow 中`)
  const declared = [...new Set(step.inputs.flatMap((input) => {
    const value = scalar(Reflect.get(state.fields, input.field))
    const candidate = value === null ? undefined : normalizeCandidate(value)
    return candidate === undefined ? [] : [candidate]
  }))]
  if (declared.length > 1) throw new Error(`step '${scope}' 存在多个 candidate-shaped frozen input`)
  if (declared[0] !== undefined) return declared[0]
  if (deps.workspaceFingerprint === undefined) {
    throw new Error(`step '${scope}' 未声明 candidate input，且缺少 workspace fingerprint capability`)
  }
  const current = (await deps.workspaceFingerprint(change)).trim()
  const candidate = normalizeCandidate(current)
  if (candidate === undefined) throw new Error('workspace fingerprint capability 返回非法 candidate')
  return candidate
}
