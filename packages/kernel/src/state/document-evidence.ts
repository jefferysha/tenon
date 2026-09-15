import { createHash } from 'node:crypto'
import {
  isAcceptedDocumentProducer,
  isRecordedDocumentProducerAllowedThroughPolicyStep,
  isDocumentContractPhase,
  recordsRequiredForPolicyStep,
  readsRequiredForPolicyStep,
  readsRequiredForPhase,
  recordsRequiredForPhase,
  type DocumentContractPhase,
  type DocumentGovernancePolicy,
  type DocumentKind,
} from '../workflow/document-contract.js'
import { readDocumentSkillConfirmations } from '../skill-invocation/document-confirmation-store.js'
import { readSkillInvocationEventsForApplication } from '../skill-invocation/repository.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import { skillsEquivalent } from './document-record-policy.js'
import { deltaSpecSlot, resolveDocument } from './document-path.js'
import {
  currentDocumentStepVisitId,
  readDocumentLedger,
  type DocumentRecord,
} from './document-ledger.js'

function digest(...values: readonly string[]): string {
  const hash = createHash('sha256')
  for (const value of values) hash.update(value).update('\0')
  return hash.digest('hex')
}

function confirmationDigest(...values: readonly string[]): string {
  const hash = createHash('sha256')
  values.forEach((value, index) => {
    hash.update(value)
    if (index < values.length - 1) hash.update('\0')
  })
  return hash.digest('hex')
}

function documentApplicationInvocationId(
  confirmationInvocationId: string,
  record: DocumentRecord,
): string {
  return `invocation-${digest(
    'document-application', confirmationInvocationId, record.kind,
    record.path, record.sha256, record.recordedAt,
  )}`
}

function confirmationInvocationId(confirmation: Awaited<ReturnType<typeof readDocumentSkillConfirmations>>[number]): string {
  const values = confirmation.adapter.kind === 'codex' && confirmation.adapter.application_ref !== undefined
    ? [
        'codex-document-skill', confirmation.step_visit.run_id,
        String(confirmation.step_visit.transition_sequence), confirmation.producer,
        confirmation.adapter.proof_ref, confirmation.adapter.application_ref,
      ]
    : [
        confirmation.adapter.kind === 'native' ? 'native-document-skill' : 'codex-document-skill',
        confirmation.step_visit.run_id, String(confirmation.step_visit.transition_sequence),
        confirmation.producer, confirmation.adapter.proof_ref,
      ]
  return `invocation-${confirmationDigest(...values)}`
}

function hasExactDocumentApplication(
  events: readonly SkillInvocationEventV1[],
  confirmation: Awaited<ReturnType<typeof readDocumentSkillConfirmations>>[number],
  record: DocumentRecord,
): boolean {
  if (confirmation.invocation_id !== confirmationInvocationId(confirmation)) return false
  const allowedInvocationIds = new Set([
    confirmation.invocation_id,
    documentApplicationInvocationId(confirmation.invocation_id, record),
  ])
  for (const invocationId of allowedInvocationIds) {
    const invocationEvents = events.filter((event) => event.invocation_id === invocationId)
    const started = invocationEvents.find((event): event is Extract<SkillInvocationEventV1, { type: 'invocation-started' }> =>
      event.type === 'invocation-started')
    if (started === undefined
      || !skillsEquivalent(started.payload.skill.id, record.producer)
      || started.subject.step_id !== confirmation.evidence_scope
      || started.subject.workflow_run_id !== confirmation.step_visit.run_id
      || started.subject.step_visit.run_id !== confirmation.step_visit.run_id
      || started.subject.step_visit.transition_sequence !== confirmation.step_visit.transition_sequence
      || !invocationEvents.some((event) => event.type === 'invocation-completed')) continue
    const intent = invocationEvents.find((event): event is Extract<SkillInvocationEventV1, { type: 'artifact-binding-intent' }> =>
      event.type === 'artifact-binding-intent'
      && event.payload.output_id === 'document_record'
      && event.payload.artifact.kind === 'document'
      && event.payload.artifact.ref === record.path
      && event.payload.artifact.digest === `sha256:${record.sha256}`
      && event.payload.artifact.document?.kind === record.kind
      && event.payload.artifact.document.recorded_at === record.recordedAt
      && event.payload.validator_ids.length > 0)
    if (intent === undefined) continue
    const bound = invocationEvents.find((event): event is Extract<SkillInvocationEventV1, { type: 'artifact-bound' }> =>
      event.type === 'artifact-bound' && event.payload.binding_id === intent.payload.binding_id)
    if (bound !== undefined
      && bound.payload.artifact_digest === `sha256:${record.sha256}`
      && bound.payload.validators.length > 0
      && bound.payload.validators.every((validator) => validator.status === 'pass')) return true
  }
  return false
}

export type DocumentEvidenceItemStatus = 'recorded' | 'missing' | 'stale' | 'unread'

export interface DocumentEvidenceItem {
  readonly kind: DocumentKind
  readonly status: DocumentEvidenceItemStatus
  readonly requiredRead: boolean
  readonly paths: readonly string[]
  readonly producers: readonly string[]
  readonly timeline: readonly {
    readonly producer: string
    readonly recordedAt: string
    readonly readAt?: string
    readonly actor?: { readonly id: string; readonly name: string }
  }[]
}

export interface DocumentEvidenceReport {
  readonly phase: string
  readonly hasLedger: boolean
  readonly pass: boolean
  readonly blockers: readonly string[]
  readonly items: readonly DocumentEvidenceItem[]
}

export interface DocumentEvidenceScope {
  readonly recordKinds?: readonly DocumentKind[]
  readonly readKinds?: readonly DocumentKind[]
}

async function currentRecordDigest(repoRoot: string, record: DocumentRecord): Promise<string | undefined> {
  try {
    return (await resolveDocument(repoRoot, record.path)).digest
  } catch {
    return undefined
  }
}

function item(
  kind: DocumentKind,
  status: DocumentEvidenceItemStatus,
  requiredRead: boolean,
  records: readonly DocumentRecord[],
  phase: string,
  currentVisitId?: string,
): DocumentEvidenceItem {
  return {
    kind,
    status,
    requiredRead,
    paths: records.map((record) => record.path),
    producers: records.map((record) => record.producer),
    timeline: records.map((record) => ({
      producer: record.producer,
      recordedAt: record.recordedAt,
      ...(record.actor === undefined ? {} : { actor: { id: record.actor.id, name: record.actor.name } }),
      ...(status === 'recorded' && requiredRead
        ? (() => {
            const receipt = record.reads.find((candidate) => currentVisitId !== undefined && receiptMatchesVisit(candidate, phase, record.sha256, currentVisitId))
            return receipt === undefined ? {} : { readAt: receipt.readAt }
          })()
        : {}),
    })),
  }
}

function receiptMatchesVisit(
  receipt: DocumentRecord['reads'][number],
  phase: string,
  digest: string,
  visitId: string,
): boolean {
  return receipt.phase === phase
    && receipt.sha256 === digest
    && receipt.visitId === visitId
}

export async function evaluateDocumentEvidence(
  repoRoot: string,
  changeDir: string,
  phase: string,
  scope: DocumentEvidenceScope = {},
  policy?: DocumentGovernancePolicy,
): Promise<DocumentEvidenceReport> {
  let ledger
  try {
    ledger = await readDocumentLedger(changeDir)
  } catch (error) {
    return {
      phase,
      hasLedger: true,
      pass: false,
      blockers: [`document ledger 不可读取: ${error instanceof Error ? error.message : String(error)}`],
      items: [],
    }
  }
  if (!ledger) {
    return {
      phase,
      hasLedger: false,
      pass: false,
      blockers: ['缺少 .pipeline-documents.json；执行 tenon document init 后按 phase 重新登记产物'],
      items: [],
    }
  }

  const recordRequirements = policy
    ? recordsRequiredForPolicyStep(policy, phase)
    : isDocumentContractPhase(phase) ? recordsRequiredForPhase(phase) : []
  const recordKinds = scope.recordKinds ?? recordRequirements.map((requirement) => requirement.kind)
  const readRequirements = new Set(scope.readKinds ?? (
    policy
      ? readsRequiredForPolicyStep(policy, phase)
      : isDocumentContractPhase(phase) ? readsRequiredForPhase(phase) : []
  ))
  const kinds = new Set<DocumentKind>([...recordKinds, ...readRequirements])
  const blockers: string[] = []
  const items: DocumentEvidenceItem[] = []
  let confirmations
  let invocationEvents: readonly SkillInvocationEventV1[]
  try {
    confirmations = await readDocumentSkillConfirmations(changeDir)
    invocationEvents = await readSkillInvocationEventsForApplication(changeDir)
  } catch (error) {
    blockers.push(`document producer invocation evidence 不可验证: ${error instanceof Error ? error.message : String(error)}`)
    confirmations = []
    invocationEvents = []
  }
  let currentVisitId: string | undefined
  if (readRequirements.size > 0) {
    try {
      currentVisitId = await currentDocumentStepVisitId(changeDir)
    } catch (error) {
      blockers.push(
        `current step visit 不可验证: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  for (const kind of kinds) {
    const records = ledger.records.filter((record) => record.kind === kind)
    const requiredRead = readRequirements.has(kind)
    if (records.length === 0) {
      blockers.push(`缺少 document '${kind}'；执行 tenon document record <change> ${kind} <path> --producer <skill>`)
      items.push(item(kind, 'missing', requiredRead, records, phase, currentVisitId))
      continue
    }
    if (records.some((record) => {
      return policy
        ? !isRecordedDocumentProducerAllowedThroughPolicyStep(policy, kind, phase, record.producer)
        : !isAcceptedDocumentProducer(kind, record.producer)
    })) {
      blockers.push(`document '${kind}' 的 producer 不符合当前 document contract`)
      items.push(item(kind, 'stale', requiredRead, records, phase, currentVisitId))
      continue
    }
    const legacyDelta = kind === 'delta-spec'
      ? records.filter((record) => deltaSpecSlot(record.path, changeDir) === undefined)
      : []
    if (legacyDelta.length > 0) {
      blockers.push(
        `存在旧 delta-spec 记录，必须用 tenon document migrate-delta 显式迁移: ${legacyDelta.map((record) => record.path).join(', ')}`,
      )
      items.push(item(kind, 'stale', requiredRead, records, phase, currentVisitId))
      continue
    }
    const digests: Array<string | undefined> = []
    for (const record of records) {
      digests.push(await currentRecordDigest(repoRoot, record))
    }
    if (records.some((record, index) => digests[index] !== record.sha256)) {
      blockers.push(`document '${kind}' 已缺失或内容变化；重新执行 tenon document record 后再继续`)
      items.push(item(kind, 'stale', requiredRead, records, phase, currentVisitId))
      continue
    }
    const incompleteProducer = records.find((record) => {
      const applicableConfirmations = confirmations.filter((confirmation) => {
        if (!skillsEquivalent(confirmation.producer, record.producer)
          || Date.parse(confirmation.confirmed_at) > Date.parse(record.recordedAt)) return false
        const anchor = record.producerInvocation
        return anchor === undefined || (
          confirmation.invocation_id === anchor.confirmationInvocationId
          && confirmation.evidence_scope === anchor.evidenceScope
          && confirmation.step_visit.run_id === anchor.stepVisit.runId
          && confirmation.step_visit.transition_sequence === anchor.stepVisit.transitionSequence
        )
      })
      // Records that predate the host-neutral confirmation ledger retain explicit legacy
      // compatibility. Once a sealed confirmation exists before a write, the exact raw
      // invocation subject and digest-bound artifact events are mandatory.
      if (record.producerInvocation === undefined && applicableConfirmations.length === 0) return false
      return !applicableConfirmations.some((confirmation) =>
        hasExactDocumentApplication(invocationEvents, confirmation, record))
    })
    if (incompleteProducer !== undefined) {
      blockers.push(
        `document '${kind}' 的 producer invocation/artifact 尚未原子完成: ${incompleteProducer.path}；执行 tenon document record <change> ${kind} ${incompleteProducer.path} --producer ${incompleteProducer.producer}`,
      )
      items.push(item(kind, 'stale', requiredRead, records, phase, currentVisitId))
      continue
    }
    if (requiredRead && (
      currentVisitId === undefined
      || records.some((record) => !record.reads.some(
        (receipt) => receiptMatchesVisit(receipt, phase, record.sha256, currentVisitId),
      ))
    )) {
      if (currentVisitId !== undefined) {
        blockers.push(
          `document '${kind}' 尚未由 ${phase} 的当前 step visit 读取；执行 tenon document read <change> ${kind}`,
        )
      }
      items.push(item(kind, 'unread', requiredRead, records, phase, currentVisitId))
      continue
    }
    items.push(item(kind, 'recorded', requiredRead, records, phase, currentVisitId))
  }
  return { phase, hasLedger: true, pass: blockers.length === 0, blockers, items }
}
