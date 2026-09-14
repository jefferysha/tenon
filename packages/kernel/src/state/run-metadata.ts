/**
 * .pipeline.yaml 内部提交元数据的核心三行 + 可选 policy/loop/iteration 序列化/解析，以及 transition 前后
 * PipelineState.fields 的真实字段级 diff（TransitionRecord.effects 的唯一来源——调用方不猜测
 * 传入，repository 自己 diff，避免两处各自实现一份再悄悄漂移）。
 *
 * 核心三行固定顺序、要么全有要么全无；policy 是第四行，governed identity 是与 policy 绑定的
 * 第五/六行。document/workflow governance 三项只为读取早期开发快照保留；新 Change 将其写入
 * rollback-compatible sidecar。损坏的可选尾部不获授权语义，仍交给 opaqueTail 保留。
 */
import {
  COMPANION_BACKED_FIELDS,
  PRE_VERIFY_REVIEW_FIELD,
  type FieldName,
  type RunMetadata,
  type StateProjectionMetadata,
} from '../types.js'
import { validateAutomationPolicySnapshot } from '../loops/automation-policy.js'

const RUN_ID_KEY = 'pipeline_run_id'
const SEQUENCE_KEY = 'pipeline_transition_sequence'
const HEAD_KEY = 'pipeline_transition_head'
const POLICY_KEY = 'pipeline_automation_policy_b64'
const LOOP_ID_KEY = 'pipeline_loop_id'
const ITERATION_ID_KEY = 'pipeline_iteration_id'
const DOCUMENT_PROFILE_KEY = 'pipeline_document_profile'
const DOCUMENT_GOVERNANCE_FINGERPRINT_KEY = 'pipeline_document_governance_fingerprint'
const WORKFLOW_PLAN_FINGERPRINT_KEY = 'pipeline_workflow_plan_fingerprint'
const STATE_REVISION_KEY = 'pipeline_state_revision'
const STATE_REVISION_ID_KEY = 'pipeline_state_revision_id'
const STATE_DIGEST_KEY = 'pipeline_state_digest'
const NULL_LITERAL = 'null'

export function serializeRunMetadataLines(metadata: RunMetadata | undefined): string[] {
  if (!metadata) return []
  const lines = [
    `${RUN_ID_KEY}: ${metadata.runId}`,
    `${SEQUENCE_KEY}: ${metadata.transitionSequence}`,
    `${HEAD_KEY}: ${metadata.transitionHead ?? NULL_LITERAL}`,
  ]
  if (metadata.automationPolicy !== undefined) {
    lines.push(`${POLICY_KEY}: ${Buffer.from(JSON.stringify(metadata.automationPolicy)).toString('base64url')}`)
    if (metadata.loopId !== undefined && metadata.iterationId !== undefined) {
      lines.push(`${LOOP_ID_KEY}: ${metadata.loopId}`)
      lines.push(`${ITERATION_ID_KEY}: ${metadata.iterationId}`)
    }
  }
  if (metadata.documentProfile !== undefined) {
    lines.push(`${DOCUMENT_PROFILE_KEY}: ${metadata.documentProfile}`)
  }
  if (metadata.documentGovernanceFingerprint !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(metadata.documentGovernanceFingerprint)) {
      throw new Error('document governance fingerprint 必须是 64 位小写 SHA-256')
    }
    if (metadata.documentProfile === undefined) {
      throw new Error('document governance fingerprint 缺少 document profile')
    }
    lines.push(`${DOCUMENT_GOVERNANCE_FINGERPRINT_KEY}: ${metadata.documentGovernanceFingerprint}`)
  }
  if (metadata.workflowPlanFingerprint !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(metadata.workflowPlanFingerprint)) {
      throw new Error('workflow plan fingerprint 必须是 64 位小写 SHA-256')
    }
    lines.push(`${WORKFLOW_PLAN_FINGERPRINT_KEY}: ${metadata.workflowPlanFingerprint}`)
  }
  return lines
}

export interface ParseRunMetadataResult {
  metadata?: RunMetadata
  /** 成功解析时为核心 3 行加可选 policy/loop/profile 行数；未识别核心块时为 0。 */
  consumedLines: number
}

/** 从 `lines` 开头尝试解析固定三行元数据块；不匹配（含损坏/截断）→ {metadata: undefined, consumedLines: 0}。 */
export function parseRunMetadataLines(lines: readonly string[]): ParseRunMetadataResult {
  const NOT_FOUND: ParseRunMetadataResult = { metadata: undefined, consumedLines: 0 }
  const l0 = lines[0]
  const l1 = lines[1]
  const l2 = lines[2]
  if (l0 === undefined || l1 === undefined || l2 === undefined) return NOT_FOUND
  const runId = matchLine(l0, RUN_ID_KEY)
  const sequenceRaw = matchLine(l1, SEQUENCE_KEY)
  const headRaw = matchLine(l2, HEAD_KEY)
  if (runId === undefined || sequenceRaw === undefined || headRaw === undefined) return NOT_FOUND
  const transitionSequence = Number(sequenceRaw)
  if (!Number.isInteger(transitionSequence) || transitionSequence < 0) return NOT_FOUND
  const metadata: RunMetadata = {
    runId,
    transitionSequence,
    transitionHead: headRaw === NULL_LITERAL ? undefined : headRaw,
  }
  let consumedLines = 3
  const policyLine = lines[consumedLines]
  const policyRaw = policyLine === undefined ? undefined : matchLine(policyLine, POLICY_KEY)
  if (policyRaw !== undefined) {
    try {
      metadata.automationPolicy = validateAutomationPolicySnapshot(
        JSON.parse(Buffer.from(policyRaw, 'base64url').toString('utf8')),
      )
      const loopId = lines[4] === undefined ? undefined : matchLine(lines[4], LOOP_ID_KEY)
      const iterationId = lines[5] === undefined ? undefined : matchLine(lines[5], ITERATION_ID_KEY)
      if (loopId !== undefined && iterationId !== undefined
        && loopId === metadata.automationPolicy.loop_id && iterationId.length > 0) {
        metadata.loopId = loopId
        metadata.iterationId = iterationId
        consumedLines = 6
      } else {
        consumedLines = 4
      }
    } catch {
      // Leave a malformed fourth line untouched in opaqueTail.
    }
  }
  const profileLine = lines[consumedLines]
  const profileRaw = profileLine === undefined ? undefined : matchLine(profileLine, DOCUMENT_PROFILE_KEY)
  if (profileRaw === 'legacy-full' || profileRaw === 'document-v1') {
    metadata.documentProfile = profileRaw
    consumedLines += 1
  }
  const fingerprintLine = lines[consumedLines]
  const fingerprintRaw = fingerprintLine === undefined
    ? undefined
    : matchLine(fingerprintLine, DOCUMENT_GOVERNANCE_FINGERPRINT_KEY)
  if (fingerprintRaw !== undefined) {
    if (metadata.documentProfile === undefined || !/^[0-9a-f]{64}$/.test(fingerprintRaw)) {
      throw new Error('tenon document governance fingerprint 损坏')
    }
    metadata.documentGovernanceFingerprint = fingerprintRaw
    consumedLines += 1
  }
  const workflowFingerprintLine = lines[consumedLines]
  const workflowFingerprintRaw = workflowFingerprintLine === undefined
    ? undefined
    : matchLine(workflowFingerprintLine, WORKFLOW_PLAN_FINGERPRINT_KEY)
  if (workflowFingerprintRaw !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(workflowFingerprintRaw)) {
      throw new Error('tenon workflow plan fingerprint 损坏')
    }
    metadata.workflowPlanFingerprint = workflowFingerprintRaw
    consumedLines += 1
  }
  return { metadata, consumedLines }
}

export function serializeProjectionMetadataLines(metadata: StateProjectionMetadata | undefined): string[] {
  if (!metadata) return []
  return [
    `${STATE_REVISION_KEY}: ${metadata.stateRevision}`,
    `${STATE_REVISION_ID_KEY}: ${metadata.stateRevisionId}`,
    `${STATE_DIGEST_KEY}: ${metadata.stateDigest}`,
  ]
}

export interface ParseProjectionMetadataResult {
  metadata?: StateProjectionMetadata
  consumedLines: number
}

export function parseProjectionMetadataLines(lines: readonly string[]): ParseProjectionMetadataResult {
  const revisionRaw = lines[0] === undefined ? undefined : matchLine(lines[0], STATE_REVISION_KEY)
  const revisionId = lines[1] === undefined ? undefined : matchLine(lines[1], STATE_REVISION_ID_KEY)
  const stateDigest = lines[2] === undefined ? undefined : matchLine(lines[2], STATE_DIGEST_KEY)
  const stateRevision = Number(revisionRaw)
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 0
    || revisionId === undefined || !/^[A-Za-z0-9_-]+$/.test(revisionId)
    || stateDigest === undefined || !/^[0-9a-f]{64}$/.test(stateDigest)) {
    return { metadata: undefined, consumedLines: 0 }
  }
  return { metadata: { stateRevision, stateRevisionId: revisionId, stateDigest }, consumedLines: 3 }
}

function matchLine(line: string, key: string): string | undefined {
  const prefix = `${key}: `
  return line.startsWith(prefix) ? line.slice(prefix.length) : undefined
}

function fieldValueEqual(a: string | readonly string[], b: string | readonly string[]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((v, i) => v === b[i])
  }
  return a === b
}

/** diff 两份 fields 快照，产出真实改动的字段列表（不猜测、不遗漏、不重复）。 */
export function diffFieldsToEffects(
  before: Record<FieldName, string | string[]>,
  after: Record<FieldName, string | string[]>,
): Array<{ kind: 'state-field-change'; field: FieldName; from: string | readonly string[]; to: string | readonly string[] }> {
  const effects: Array<{ kind: 'state-field-change'; field: FieldName; from: string | readonly string[]; to: string | readonly string[] }> = []
  const fields = new Set<FieldName>([...Object.keys(before), ...Object.keys(after)] as FieldName[])
  for (const field of fields) {
    const from = before[field] ?? ''
    const to = after[field] ?? ''
    if (!fieldValueEqual(from, to)) {
      effects.push({ kind: 'state-field-change', field, from, to })
    }
  }
  return effects
}

const COMPANION_FIELD_SET: ReadonlySet<string> = new Set(COMPANION_BACKED_FIELDS)

/**
 * Canonical revision / TransitionRecord 的 wire effects 必须保持 N-1 字段闭包。
 *
 * `pre_verify_review_result` 与 `review_acknowledged_via` 是新版逻辑 canonical 状态，但物理值由
 * revision-bound companion record 承载；旧 runtime 不认识这两个字段。它们的变化由 companion
 * revision 链审计，不能再重复写入旧版会拒绝的 mutation/transition effects。
 */
export function diffWireFieldsToEffects(
  before: Record<FieldName, string | string[]>,
  after: Record<FieldName, string | string[]>,
): Array<{ kind: 'state-field-change'; field: FieldName; from: string | readonly string[]; to: string | readonly string[] }> {
  return diffFieldsToEffects(before, after).filter(({ field }) => !COMPANION_FIELD_SET.has(field))
}

/**
 * 未发布开发构建写出的 effects 形状：`review_acknowledged_via` 仍在 wire 闭集内，因此它的真实
 * 变化出现在 mutation/TransitionRecord effects 中。只供读取端作为同一对 previous→current 逻辑
 * 状态的另一份精确 diff 接受；新写入一律使用 `diffWireFieldsToEffects`。
 */
export function diffLegacyChannelWireFieldsToEffects(
  before: Record<FieldName, string | string[]>,
  after: Record<FieldName, string | string[]>,
): Array<{ kind: 'state-field-change'; field: FieldName; from: string | readonly string[]; to: string | readonly string[] }> {
  return diffFieldsToEffects(before, after).filter(({ field }) => field !== PRE_VERIFY_REVIEW_FIELD)
}
