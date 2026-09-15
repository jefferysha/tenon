/**
 * Governed document contract.
 *
 * This module deliberately contains only deterministic workflow rules. Filesystem persistence,
 * digests, and receipts live in state/document-ledger.ts so CLI, server, and Dashboard consume one
 * matrix without making the workflow domain depend on Node I/O. Every rule reads a
 * DocumentGovernancePolicy built from the workflow YAML; there is no phase-keyed fallback.
 */
import type { WorkflowDocumentContractV1 } from './types.js'
import {
  isDocumentKind,
  type DocumentGovernancePolicy,
  type DocumentKind,
  type DocumentOutputRequirement,
} from './document-contract-model.js'
import { aliasesForSkill } from './document-contract-validation.js'
import { isDefaultWorkflowName } from './identifier.js'
import { WorkflowTrackBranchError } from './track-branch-error.js'
export {
  DOCUMENT_CHAIN_PAIRS,
  DOCUMENT_CONTRACT_PHASES,
  DOCUMENT_KIND_CATALOG,
  DOCUMENT_KINDS,
  documentKindScope,
  isDocumentContractPhase,
  isDocumentKind,
  type DocumentContractPhase,
  type DocumentGovernancePolicy,
  type DocumentKind,
  type DocumentKindInfo,
  type DocumentOutputRequirement,
  type DocumentScope,
  type DocumentSlotRole,
} from './document-contract-model.js'

const SPEC_ADR_LIVING_DOCUMENT: DocumentOutputRequirement = {
  kind: 'adr',
  producerCandidates: ['tenon-spec', 'tenon:tenon-spec'],
}

interface DocumentContractBranch {
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly { readonly id: string }[]
}

function governedBranch(
  workflowId: string,
  workflow: DocumentContractBranch & { readonly tracks?: Readonly<Record<string, DocumentContractBranch>> },
  track: string | undefined,
): DocumentContractBranch {
  const tracks = workflow.tracks ?? {}
  const entries = Object.entries(tracks)
  if (entries.length === 0) return workflow
  const branch = track === undefined || track === ''
    ? entries[0]?.[1]
    : Object.hasOwn(tracks, track) ? tracks[track] : undefined
  if (branch === undefined) throw new WorkflowTrackBranchError(workflowId, track ?? '')
  return branch
}

function policyFromBranch(id: DocumentGovernancePolicy['id'], branch: DocumentContractBranch): DocumentGovernancePolicy {
  const steps = branch.steps.map((step) => step.id)
  const byStep = <T>(): Record<string, T[]> => Object.fromEntries(steps.map((step) => [step, []]))
  const outputsByStep = byStep<DocumentOutputRequirement>()
  const mutableByStep = byStep<DocumentOutputRequirement>()
  const readsByStep = byStep<DocumentKind>()
  const requiresByStep = byStep<DocumentKind>()
  let requires = false
  for (const slot of branch.documentContract?.slots ?? []) {
    if (!isDocumentKind(slot.kind) || !Object.hasOwn(outputsByStep, slot.ownerStep)) continue
    if (slot.role === 'require') {
      requires = true
      requiresByStep[slot.ownerStep]?.push(slot.kind)
      continue
    }
    const target = slot.role === 'update' ? mutableByStep : outputsByStep
    target[slot.ownerStep]?.push({ kind: slot.kind, producerCandidates: slot.producers })
  }
  for (const read of branch.documentContract?.reads ?? []) {
    if (Object.hasOwn(readsByStep, read.step)) readsByStep[read.step] = read.kinds.filter(isDocumentKind)
  }
  return { id, steps, outputsByStep, mutableByStep, readsByStep, ...(requires ? { requiresByStep } : {}) }
}

/**
 * undefined = not governed. With tracks the selected branch's contract applies (no track → first
 * branch; unknown track → WorkflowTrackBranchError); otherwise the top-level contract.
 */
export function documentGovernancePolicy(
  workflowId: string,
  workflow: DocumentContractBranch & {
    readonly openspec?: boolean
    readonly tracks?: Readonly<Record<string, DocumentContractBranch>>
  },
  track?: string,
): DocumentGovernancePolicy | undefined {
  if (workflow.openspec !== true) return undefined
  // The id is the persisted document profile (default → legacy-full); content always comes from YAML.
  const id = isDefaultWorkflowName(workflowId) ? 'openspec-v1' : 'document-v1'
  return policyFromBranch(id, governedBranch(workflowId, workflow, track))
}

export function isDocumentPolicyStep(policy: DocumentGovernancePolicy, value: string): boolean {
  return policy.steps.includes(value)
}

export function outputsRequiredForPolicyStep(
  policy: DocumentGovernancePolicy,
  step: string,
): readonly DocumentOutputRequirement[] {
  return policy.outputsByStep[step] ?? []
}

export function readsRequiredForPolicyStep(
  policy: DocumentGovernancePolicy,
  step: string,
): readonly DocumentKind[] {
  return policy.readsByStep[step] ?? []
}

/** Documents that must exist before leaving this step (role require; project documents may pre-exist). */
export function requiresForPolicyStep(
  policy: DocumentGovernancePolicy,
  step: string,
): readonly DocumentKind[] {
  return policy.requiresByStep?.[step] ?? []
}

export function recordsRequiredForPolicyStep(
  policy: DocumentGovernancePolicy,
  step: string,
): readonly DocumentOutputRequirement[] {
  const required: DocumentOutputRequirement[] = []
  for (const candidate of policy.steps) {
    required.push(...outputsRequiredForPolicyStep(policy, candidate))
    if (candidate === step) break
  }
  return required
}

export function documentOwnerPolicyStep(
  policy: DocumentGovernancePolicy,
  kind: DocumentKind,
): string | undefined {
  return policy.steps.find((step) =>
    outputsRequiredForPolicyStep(policy, step).some((requirement) => requirement.kind === kind),
  )
}

function recordRequirementForPolicy(
  policy: DocumentGovernancePolicy,
  kind: DocumentKind,
  step: string,
): DocumentOutputRequirement | undefined {
  const frozenRequirement = [
    ...outputsRequiredForPolicyStep(policy, step),
    ...(policy.mutableByStep[step] ?? []),
  ].find((requirement) => requirement.kind === kind)
  if (frozenRequirement) return frozenRequirement

  // A WorkflowRun freezes its graph and baseline document matrix, but living-document provenance
  // fixes must also repair an already-running default Change. Keep this evolution deliberately
  // narrower than a policy replacement: only openspec-v1 Spec may refresh ADR, and only the
  // current tenon-spec producer can supply the new digest. Outputs, reads, owner steps, workflow
  // edges, old producer receipts, and every other mutable kind remain exactly as frozen.
  return policy.id === 'openspec-v1' && step === 'spec' && kind === 'adr'
    ? SPEC_ADR_LIVING_DOCUMENT
    : undefined
}

export function isDocumentRecordAllowedInPolicyStep(
  policy: DocumentGovernancePolicy,
  kind: DocumentKind,
  step: string,
): boolean {
  return recordRequirementForPolicy(policy, kind, step) !== undefined
}

export function isDocumentProducerAllowedInPolicyStep(
  policy: DocumentGovernancePolicy,
  kind: DocumentKind,
  step: string,
  producer: string,
): boolean {
  const requirement = recordRequirementForPolicy(policy, kind, step)
  if (!requirement) return false
  const supplied = new Set(aliasesForSkill(producer))
  return requirement.producerCandidates.some((candidate) =>
    aliasesForSkill(candidate).some((alias) => supplied.has(alias)),
  )
}

/**
 * Validate the producer stored on the latest ledger record at a later workflow step.
 *
 * Living documents may be re-recorded by a phase-local producer after their owner step. The
 * ledger intentionally stores only the latest digest/producer pair, so evidence validation must
 * accept any producer that was authorized for this document from its owner through the current
 * step. Checking only the owner would incorrectly stale every legitimate mutable record.
 */
export function isRecordedDocumentProducerAllowedThroughPolicyStep(
  policy: DocumentGovernancePolicy,
  kind: DocumentKind,
  currentStep: string,
  producer: string,
): boolean {
  for (const step of policy.steps) {
    if (isDocumentProducerAllowedInPolicyStep(policy, kind, step, producer)) return true
    if (step === currentStep) break
  }
  return false
}

export function recordProducerCandidatesForPolicyStep(
  policy: DocumentGovernancePolicy,
  kind: DocumentKind,
  step: string,
): readonly string[] {
  return recordRequirementForPolicy(policy, kind, step)?.producerCandidates ?? []
}

/** A rollback remains available even when forward evidence is stale or incomplete. */
export function shouldEnforceDocumentPolicyOnTransition(
  policy: DocumentGovernancePolicy,
  from: string,
  to: string,
): boolean {
  const fromIndex = policy.steps.indexOf(from)
  const toIndex = policy.steps.indexOf(to)
  return !(fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex)
}

export { aliasesForSkill, validateDefaultWorkflowStructure, validateDocumentContract } from './document-contract-validation.js'
