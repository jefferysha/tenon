import type { FileIdentity } from './workflowTrustedFs.js'

export class WorkflowNotFoundError extends Error {}

export type WorkflowReferenceKind =
  | 'active-change'
  | 'loop-binding'
  | 'policy-template-recommended'

export interface WorkflowReference {
  readonly kind: WorkflowReferenceKind
  readonly source: string
}

export interface WorkflowReferenceScanBlocker {
  readonly source: string
  readonly detail: string
}

export interface WorkflowReferenceScanResult {
  readonly references: readonly WorkflowReference[]
  readonly blockers: readonly WorkflowReferenceScanBlocker[]
}

export interface WorkflowDeletePermit extends FileIdentity {
  readonly name: string
}

export class WorkflowDeleteConflictError extends Error {
  readonly _tag = 'WorkflowDeleteConflictError'
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowDeleteConflictError'
  }
}
