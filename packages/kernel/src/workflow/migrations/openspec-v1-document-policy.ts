import type { DocumentGovernancePolicy, DocumentKind, DocumentOutputRequirement } from '../document-contract-model.js'
import { DOCUMENT_CONTRACT_PHASES, isDocumentKind } from '../document-contract-model.js'
import { isDefaultWorkflowName } from '../identifier.js'
import type { WorkflowDocumentContractV1 } from '../types.js'

/**
 * Immutable openspec-v1 document table that `default` and `openspec_contract: required` used before
 * workflows declared their own per-track contracts. `templates/workflows/default.yaml` spells out the
 * same table in every branch; this copy exists only for V1 snapshot restore and fingerprint equality.
 */
const OUTPUTS_BY_PHASE: Readonly<Record<string, readonly DocumentOutputRequirement[]>> = {
  open: [
    { kind: 'proposal', producerCandidates: ['openspec-propose', 'opsx:propose'] },
    { kind: 'openspec-design', producerCandidates: ['openspec-propose', 'opsx:propose'] },
    { kind: 'tasks', producerCandidates: ['openspec-propose', 'opsx:propose'] },
  ],
  explore: [
    { kind: 'superpower-design', producerCandidates: ['brainstorming', 'superpowers:brainstorming'] },
    { kind: 'adr', producerCandidates: ['brainstorming', 'superpowers:brainstorming'] },
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
      producerCandidates: ['verification-before-completion', 'superpowers:verification-before-completion'],
    },
  ],
  ship: [
    { kind: 'applied-spec', producerCandidates: ['tenon'] },
  ],
  archive: [],
}

const MUTABLE_RECORDS_BY_PHASE: Readonly<Record<string, readonly DocumentOutputRequirement[]>> = {
  open: [],
  explore: [
    { kind: 'proposal', producerCandidates: ['tenon'] },
    { kind: 'openspec-design', producerCandidates: ['tenon'] },
    { kind: 'tasks', producerCandidates: ['tenon'] },
  ],
  spec: [
    { kind: 'proposal', producerCandidates: ['tenon'] },
    { kind: 'openspec-design', producerCandidates: ['tenon'] },
    { kind: 'tasks', producerCandidates: ['tenon'] },
    { kind: 'superpower-design', producerCandidates: ['tenon'] },
    { kind: 'adr', producerCandidates: ['tenon'] },
  ],
  build: [
    { kind: 'tasks', producerCandidates: ['tenon'] },
  ],
  verify: [
    { kind: 'tasks', producerCandidates: ['tenon'] },
  ],
  ship: [
    { kind: 'tasks', producerCandidates: ['tenon'] },
  ],
  archive: [
    { kind: 'tasks', producerCandidates: ['tenon'] },
  ],
}

const READS_BY_PHASE: Readonly<Record<string, readonly DocumentKind[]>> = {
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

/** The pre-`openspec: true` selection rule, used only when a V1 snapshot carries no frozen policy. */
export function legacyDocumentPolicyForSnapshot(
  workflowId: string,
  workflow: {
    readonly openspecContract?: 'required'
    readonly documentContract?: WorkflowDocumentContractV1
    readonly steps: readonly { readonly id: string }[]
  },
): DocumentGovernancePolicy | undefined {
  if (isDefaultWorkflowName(workflowId) || workflow.openspecContract === 'required') {
    return LEGACY_DOCUMENT_GOVERNANCE_POLICY
  }
  const contract = workflow.documentContract
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
