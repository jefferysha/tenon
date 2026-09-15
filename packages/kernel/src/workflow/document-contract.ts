/**
 * Governed document contract.
 *
 * This module deliberately contains only deterministic workflow rules. Filesystem persistence,
 * digests, and receipts live in state/document-ledger.ts so CLI, server, and Dashboard consume one
 * matrix without making the workflow domain depend on Node I/O.
 */
import type { WorkflowDocumentContractV1 } from './types.js'
import {
  DOCUMENT_CONTRACT_PHASES,
  isDocumentKind,
  type DocumentContractPhase,
  type DocumentGovernancePolicy,
  type DocumentKind,
  type DocumentOutputRequirement,
} from './document-contract-model.js'
import { isDefaultWorkflowName } from './identifier.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from './migrations/openspec-v1-document-policy.js'
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
export { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from './migrations/openspec-v1-document-policy.js'

const OUTPUTS_BY_PHASE = LEGACY_DOCUMENT_GOVERNANCE_POLICY.outputsByStep
const MUTABLE_RECORDS_BY_PHASE = LEGACY_DOCUMENT_GOVERNANCE_POLICY.mutableByStep
const READS_BY_PHASE = LEGACY_DOCUMENT_GOVERNANCE_POLICY.readsByStep

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

export function outputsRequiredForPhase(phase: DocumentContractPhase): readonly DocumentOutputRequirement[] {
  return OUTPUTS_BY_PHASE[phase] ?? []
}

export function readsRequiredForPhase(phase: DocumentContractPhase): readonly DocumentKind[] {
  return READS_BY_PHASE[phase] ?? []
}

/** All outputs that must exist before a governed phase can complete. */
export function recordsRequiredForPhase(phase: DocumentContractPhase): readonly DocumentOutputRequirement[] {
  const required: DocumentOutputRequirement[] = []
  for (const candidate of DOCUMENT_CONTRACT_PHASES) {
    required.push(...(OUTPUTS_BY_PHASE[candidate] ?? []))
    if (candidate === phase) break
  }
  return required
}

function outputRequirementFor(kind: DocumentKind): DocumentOutputRequirement | undefined {
  for (const phase of DOCUMENT_CONTRACT_PHASES) {
    const requirement = (OUTPUTS_BY_PHASE[phase] ?? []).find((candidate) => candidate.kind === kind)
    if (requirement) return requirement
  }
  return undefined
}

function recordRequirementFor(kind: DocumentKind, phase: DocumentContractPhase): DocumentOutputRequirement | undefined {
  return [...(OUTPUTS_BY_PHASE[phase] ?? []), ...(MUTABLE_RECORDS_BY_PHASE[phase] ?? [])]
    .find((candidate) => candidate.kind === kind)
}

function aliasesForSkill(id: string): readonly string[] {
  const aliases = new Set<string>([id])
  if (id.startsWith('tenon:')) aliases.add(id.slice('tenon:'.length))
  if (id.startsWith('superpowers:')) aliases.add(id.slice('superpowers:'.length))
  if (id === 'opsx:propose') aliases.add('openspec-propose')
  if (id === 'openspec-propose') aliases.add('opsx:propose')
  if (id === 'opsx:apply') aliases.add('openspec-apply-change')
  if (id === 'openspec-apply-change') aliases.add('opsx:apply')
  return [...aliases]
}

/** Host aliases are allowed, but a record cannot claim an unrelated phase skill as its producer. */
export function isAcceptedDocumentProducer(kind: DocumentKind, producer: string): boolean {
  const supplied = new Set(aliasesForSkill(producer))
  return producerCandidatesFor(kind).some((candidate) => aliasesForSkill(candidate).some((alias) => supplied.has(alias)))
}

export function producerCandidatesFor(kind: DocumentKind): readonly string[] {
  const candidates = new Set<string>()
  const origin = outputRequirementFor(kind)
  for (const candidate of origin?.producerCandidates ?? []) candidates.add(candidate)
  for (const phase of DOCUMENT_CONTRACT_PHASES) {
    for (const requirement of MUTABLE_RECORDS_BY_PHASE[phase] ?? []) {
      if (requirement.kind !== kind) continue
      for (const candidate of requirement.producerCandidates) candidates.add(candidate)
    }
  }
  return [...candidates]
}

/** The phase that first creates a governed document kind. */
export function documentOwnerPhase(kind: DocumentKind): DocumentContractPhase | undefined {
  return DOCUMENT_CONTRACT_PHASES.find((phase) =>
    (OUTPUTS_BY_PHASE[phase] ?? []).some((requirement) => requirement.kind === kind),
  )
}

/** Whether this phase may write a fresh digest for this document kind. */
export function isDocumentRecordAllowedInPhase(kind: DocumentKind, phase: DocumentContractPhase): boolean {
  return recordRequirementFor(kind, phase) !== undefined
}

/** Exact phase-local producer authorization for a newly written digest. */
export function isDocumentProducerAllowedInPhase(
  kind: DocumentKind,
  phase: DocumentContractPhase,
  producer: string,
): boolean {
  const requirement = recordRequirementFor(kind, phase)
  if (!requirement) return false
  const supplied = new Set(aliasesForSkill(producer))
  return requirement.producerCandidates.some((candidate) => aliasesForSkill(candidate).some((alias) => supplied.has(alias)))
}

export function recordProducerCandidatesFor(kind: DocumentKind, phase: DocumentContractPhase): readonly string[] {
  return recordRequirementFor(kind, phase)?.producerCandidates ?? []
}

/** The document kind may only be newly produced by the phase that owns it. */
export function isOutputAllowedInPhase(kind: DocumentKind, phase: DocumentContractPhase): boolean {
  return (OUTPUTS_BY_PHASE[phase] ?? []).some((item) => item.kind === kind)
}

/** Whether a workflow is document-governed: default, or an explicit `openspec: true`. */
export function isOpenSpecDocumentContractRequired(
  workflowName: string,
  _track: string,
  workflow?: { readonly openspec?: boolean },
): boolean {
  return isDefaultWorkflowName(workflowName) || workflow?.openspec === true
}

/** A rollback remains available even when forward evidence is stale or incomplete. */
export function shouldEnforceDocumentEvidenceOnTransition(from: string, to: string): boolean {
  const fromIndex = DOCUMENT_CONTRACT_PHASES.indexOf(from as DocumentContractPhase)
  const toIndex = DOCUMENT_CONTRACT_PHASES.indexOf(to as DocumentContractPhase)
  return !(fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex)
}

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
