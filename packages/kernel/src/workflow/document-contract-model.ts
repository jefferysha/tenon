export const DOCUMENT_CONTRACT_PHASES = [
  'open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive',
] as const

export type DocumentContractPhase = (typeof DOCUMENT_CONTRACT_PHASES)[number]

export const DOCUMENT_KINDS = [
  'proposal',
  'openspec-design',
  'tasks',
  'superpower-design',
  'adr',
  'delta-spec',
  'superpower-plan',
  'plan',
  'verification-report',
  'applied-spec',
  'design-md',
] as const

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]
export type DocumentScope = 'change' | 'project'
export type DocumentSlotRole = 'produce' | 'update' | 'require'

export interface DocumentKindInfo {
  readonly scope: DocumentScope
  /** Upstream skills that write this kind; used for editor suggestions only, never for runtime authority. */
  readonly producers: readonly string[]
  /** Fixed repository path for project scope; change-scope paths come from the document registry. */
  readonly projectPath?: string
}

export const DOCUMENT_KIND_CATALOG: Readonly<Record<DocumentKind, DocumentKindInfo>> = {
  proposal: { scope: 'change', producers: ['openspec-propose'] },
  'openspec-design': { scope: 'change', producers: ['openspec-propose'] },
  tasks: { scope: 'change', producers: ['openspec-propose'] },
  'superpower-design': { scope: 'change', producers: ['brainstorming'] },
  adr: { scope: 'change', producers: ['brainstorming'] },
  'delta-spec': { scope: 'change', producers: ['openspec-propose'] },
  'superpower-plan': { scope: 'change', producers: ['writing-plans'] },
  plan: { scope: 'change', producers: ['writing-plans'] },
  'verification-report': { scope: 'change', producers: ['verification-before-completion'] },
  'applied-spec': { scope: 'change', producers: ['openspec-apply-change'] },
  'design-md': { scope: 'project', producers: ['hue'], projectPath: 'DESIGN.md' },
}

/** A branch declaring one kind of a pair without the other has a chain gap (editor warning only). */
export const DOCUMENT_CHAIN_PAIRS: readonly (readonly [DocumentKind, DocumentKind])[] = [
  ['proposal', 'tasks'],
  ['delta-spec', 'applied-spec'],
]

export interface DocumentOutputRequirement {
  readonly kind: DocumentKind
  readonly producerCandidates: readonly string[]
}

export interface DocumentGovernancePolicy {
  readonly id: 'openspec-v1' | 'document-v1'
  readonly steps: readonly string[]
  /** role produce */
  readonly outputsByStep: Readonly<Record<string, readonly DocumentOutputRequirement[]>>
  /** role update */
  readonly mutableByStep: Readonly<Record<string, readonly DocumentOutputRequirement[]>>
  readonly readsByStep: Readonly<Record<string, readonly DocumentKind[]>>
  /** role require; omitted when the branch declares none, so existing policy fingerprints are unchanged. */
  readonly requiresByStep?: Readonly<Record<string, readonly DocumentKind[]>>
}

function includes<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value)
}

export function isDocumentContractPhase(value: string): value is DocumentContractPhase {
  return includes(DOCUMENT_CONTRACT_PHASES, value)
}

export function isDocumentKind(value: string): value is DocumentKind {
  return includes(DOCUMENT_KINDS, value)
}

export function documentKindScope(kind: DocumentKind): DocumentScope {
  return DOCUMENT_KIND_CATALOG[kind].scope
}
