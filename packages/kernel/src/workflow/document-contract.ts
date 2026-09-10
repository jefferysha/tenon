/**
 * Governed OpenSpec document contract.
 *
 * This module deliberately contains only deterministic workflow rules. Filesystem persistence,
 * digests, and receipts live in state/document-ledger.ts so CLI, server, and Dashboard consume one
 * matrix without making the workflow domain depend on Node I/O.
 */
import type { WorkflowDef } from './types.js'
import {
  DOCUMENT_CONTRACT_PHASES,
  DOCUMENT_KINDS,
  isDocumentContractPhase,
  isDocumentKind,
  type DocumentContractPhase,
  type DocumentGovernancePolicy,
  type DocumentKind,
  type DocumentOutputRequirement,
  type OpenSpecContract,
} from './document-contract-model.js'
export {
  DOCUMENT_CONTRACT_PHASES,
  DOCUMENT_KINDS,
  isDocumentContractPhase,
  isDocumentKind,
  type DocumentContractPhase,
  type DocumentGovernancePolicy,
  type DocumentKind,
  type DocumentOutputRequirement,
  type OpenSpecContract,
} from './document-contract-model.js'

const OUTPUTS_BY_PHASE: Readonly<Record<DocumentContractPhase, readonly DocumentOutputRequirement[]>> = {
  open: [
    { kind: 'proposal', producerCandidates: ['openspec-propose', 'opsx:propose'] },
    { kind: 'openspec-design', producerCandidates: ['openspec-propose', 'opsx:propose'] },
    { kind: 'tasks', producerCandidates: ['openspec-propose', 'opsx:propose'] },
  ],
  explore: [
    { kind: 'superpower-design', producerCandidates: ['brainstorming', 'superpowers:brainstorming'] },
    { kind: 'adr', producerCandidates: ['tenon-explore', 'tenon:tenon-explore', 'brainstorming', 'superpowers:brainstorming'] },
  ],
  spec: [
    { kind: 'delta-spec', producerCandidates: ['openspec-propose', 'opsx:propose'] },
    { kind: 'superpower-plan', producerCandidates: ['writing-plans', 'superpowers:writing-plans'] },
    { kind: 'plan', producerCandidates: ['writing-plans', 'superpowers:writing-plans'] },
  ],
  build: [],
  verify: [
    {
      kind: 'verification-report',
      producerCandidates: ['verification-before-completion', 'superpowers:verification-before-completion', 'tenon-verify', 'tenon:tenon-verify'],
    },
  ],
  ship: [
    { kind: 'applied-spec', producerCandidates: ['openspec-apply-change', 'opsx:apply'] },
  ],
  archive: [],
}

const SPEC_ADR_LIVING_DOCUMENT: DocumentOutputRequirement = {
  kind: 'adr',
  producerCandidates: ['tenon-spec', 'tenon:tenon-spec'],
}

/**
 * A small number of governed documents deliberately remain living documents after their first
 * phase. Their newest digest must identify the *current* phase skill that changed it; retaining
 * the original producer after a later edit would make the ledger's hash/provenance pair false.
 *
 * These entries do not add new phase-exit requirements. They only grant a later phase authority
 * to replace an existing record with fresh, phase-local Skill evidence.
 */
const MUTABLE_RECORDS_BY_PHASE: Readonly<Record<DocumentContractPhase, readonly DocumentOutputRequirement[]>> = {
  open: [],
  explore: [
    // Open creates intentionally small OpenSpec scaffolds. Explore owns consolidating the
    // validated problem framing and initial design hypothesis into those living documents; the
    // resulting digest must therefore be attributed to the phase driver, not left under the
    // now-stale open-phase openspec-propose receipt.
    { kind: 'proposal', producerCandidates: ['tenon-explore', 'tenon:tenon-explore'] },
    { kind: 'openspec-design', producerCandidates: ['tenon-explore', 'tenon:tenon-explore'] },
    { kind: 'tasks', producerCandidates: ['tenon-explore', 'tenon:tenon-explore'] },
  ],
  spec: [
    { kind: 'proposal', producerCandidates: ['tenon-spec', 'tenon:tenon-spec'] },
    { kind: 'openspec-design', producerCandidates: ['tenon-spec', 'tenon:tenon-spec'] },
    { kind: 'tasks', producerCandidates: ['tenon-spec', 'tenon:tenon-spec'] },
    { kind: 'superpower-design', producerCandidates: ['tenon-spec', 'tenon:tenon-spec'] },
    SPEC_ADR_LIVING_DOCUMENT,
  ],
  build: [
    { kind: 'tasks', producerCandidates: ['tenon-build', 'tenon:tenon-build'] },
  ],
  verify: [
    { kind: 'tasks', producerCandidates: ['tenon-verify', 'tenon:tenon-verify'] },
  ],
  ship: [
    { kind: 'tasks', producerCandidates: ['tenon-ship', 'tenon:tenon-ship'] },
  ],
  archive: [
    { kind: 'tasks', producerCandidates: ['tenon-archive', 'tenon:tenon-archive'] },
  ],
}

const READS_BY_PHASE: Readonly<Record<DocumentContractPhase, readonly DocumentKind[]>> = {
  open: [],
  explore: ['proposal', 'openspec-design', 'tasks'],
  spec: ['proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr'],
  build: [
    'proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr', 'delta-spec', 'superpower-plan', 'plan',
  ],
  verify: [
    'proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr', 'delta-spec', 'superpower-plan', 'plan',
  ],
  ship: [
    'proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr', 'delta-spec', 'superpower-plan', 'plan',
    'verification-report',
  ],
  archive: [
    'proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr', 'delta-spec', 'superpower-plan', 'plan',
    'verification-report', 'applied-spec',
  ],
}

export const LEGACY_DOCUMENT_GOVERNANCE_POLICY: DocumentGovernancePolicy = {
  id: 'openspec-v1',
  steps: DOCUMENT_CONTRACT_PHASES,
  outputsByStep: OUTPUTS_BY_PHASE,
  mutableByStep: MUTABLE_RECORDS_BY_PHASE,
  readsByStep: READS_BY_PHASE,
}

export function documentGovernancePolicy(
  workflowName: string,
  workflow?: {
    readonly openspecContract?: WorkflowDef['openspecContract']
    readonly documentContract?: WorkflowDef['documentContract']
    readonly steps: readonly { readonly id: string }[]
  },
): DocumentGovernancePolicy | undefined {
  if (workflowName === 'default' || workflow?.openspecContract === 'required') {
    return LEGACY_DOCUMENT_GOVERNANCE_POLICY
  }
  const contract = workflow?.documentContract
  if (!contract) return undefined
  const outputsByStep: Record<string, DocumentOutputRequirement[]> = Object.fromEntries(
    workflow.steps.map((step) => [step.id, []]),
  )
  for (const slot of contract.slots) {
    if (!isDocumentKind(slot.kind)) continue
    outputsByStep[slot.ownerStep]?.push({ kind: slot.kind, producerCandidates: slot.producers })
  }
  const readsByStep: Record<string, readonly DocumentKind[]> = Object.fromEntries(
    workflow.steps.map((step) => [step.id, []]),
  )
  for (const read of contract.reads) {
    readsByStep[read.step] = read.kinds.filter(isDocumentKind)
  }
  return {
    id: 'document-v1',
    steps: workflow.steps.map((step) => step.id),
    outputsByStep,
    mutableByStep: Object.fromEntries(workflow.steps.map((step) => [step.id, []])),
    readsByStep,
  }
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
  return OUTPUTS_BY_PHASE[phase]
}

export function readsRequiredForPhase(phase: DocumentContractPhase): readonly DocumentKind[] {
  return READS_BY_PHASE[phase]
}

/** All outputs that must exist before a governed phase can complete. */
export function recordsRequiredForPhase(phase: DocumentContractPhase): readonly DocumentOutputRequirement[] {
  const required: DocumentOutputRequirement[] = []
  for (const candidate of DOCUMENT_CONTRACT_PHASES) {
    required.push(...OUTPUTS_BY_PHASE[candidate])
    if (candidate === phase) break
  }
  return required
}

function outputRequirementFor(kind: DocumentKind): DocumentOutputRequirement | undefined {
  for (const phase of DOCUMENT_CONTRACT_PHASES) {
    const requirement = OUTPUTS_BY_PHASE[phase].find((candidate) => candidate.kind === kind)
    if (requirement) return requirement
  }
  return undefined
}

function recordRequirementFor(kind: DocumentKind, phase: DocumentContractPhase): DocumentOutputRequirement | undefined {
  return [...OUTPUTS_BY_PHASE[phase], ...MUTABLE_RECORDS_BY_PHASE[phase]]
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
    for (const requirement of MUTABLE_RECORDS_BY_PHASE[phase]) {
      if (requirement.kind !== kind) continue
      for (const candidate of requirement.producerCandidates) candidates.add(candidate)
    }
  }
  return [...candidates]
}

/** The phase that first creates a governed document kind. */
export function documentOwnerPhase(kind: DocumentKind): DocumentContractPhase | undefined {
  return DOCUMENT_CONTRACT_PHASES.find((phase) =>
    OUTPUTS_BY_PHASE[phase].some((requirement) => requirement.kind === kind),
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
  return OUTPUTS_BY_PHASE[phase].some((item) => item.kind === kind)
}

/**
 * Every default change is governed, including PM: a PRD/prototype delivery still needs an
 * inspectable OpenSpec proposal, design, executable plan, and applied spec. Custom workflows opt
 * in explicitly so legacy arbitrary graphs remain compatible instead of merely claiming compliance.
 */
export function isOpenSpecDocumentContractRequired(
  workflowName: string,
  _track: string,
  workflow?: {
    readonly openspecContract?: WorkflowDef['openspecContract']
    readonly documentContract?: WorkflowDef['documentContract']
  },
): boolean {
  if (workflowName === 'default') return true
  return workflow?.openspecContract === 'required' || workflow?.documentContract !== undefined
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

export { aliasesForSkill, validateDefaultWorkflowStructure, validateOpenSpecContractWorkflow } from './document-contract-validation.js'
