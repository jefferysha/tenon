/**
 * Unified, versioned definition catalog consumed by every Tenon client.
 *
 * The catalog is a projection, never a second source of truth: workflow files,
 * tracks.yaml, the adapter registry and the immutable pipeline plan remain
 * authoritative.  `revision`/`fingerprint` make the projection observable and
 * allow clients to reconcile SSE updates without guessing.
 */

export const DEFINITION_CATALOG_SCHEMA = 'definition-catalog/v1' as const
export const DEFINITION_CATALOG_EVENT_SCHEMA = 'definition-catalog-event/v1' as const
export const PIPELINE_SELECTION_SCHEMA = 'pipeline-selection/v1' as const

export type DefinitionCatalogSource = 'builtin' | 'project' | 'user'
export type AdapterTier = 'A' | 'B' | 'C'
export type AdapterKind = 'native' | 'adapter'
export type AdapterState = 'unknown' | 'detected' | 'not-detected' | 'installed' | 'installing' | 'failed'
export type PipelineStageMode = 'serial' | 'parallel'

export interface AdapterCatalogEntryV1 {
  readonly id: string
  readonly label: string
  readonly kind: AdapterKind
  readonly tier: AdapterTier
  readonly cli_flag: string
  readonly target_scope: 'user' | 'project'
  readonly capabilities: {
    readonly inject: boolean
    readonly veto: boolean
    readonly track: boolean
  }
  readonly supported_operations: readonly ['setup', 'update']
  readonly state: AdapterState
  readonly state_reason?: string
}

export interface WorkflowStepCatalogEntryV1 {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly gate: 'review' | 'auto' | null
  readonly skill_ids: readonly string[]
  readonly skill_dependencies: Readonly<Record<string, readonly string[]>>
  readonly transition_events: readonly string[]
}

export interface WorkflowCatalogEntryV1 {
  readonly id: string
  readonly version: string
  readonly fingerprint: string
  readonly source: DefinitionCatalogSource
  readonly readonly: boolean
  readonly steps: readonly WorkflowStepCatalogEntryV1[]
}

export interface TrackCatalogEntryV1 {
  readonly id: string
  readonly label: string
  readonly builtin: boolean
  readonly revision: string
  readonly source: 'builtin' | 'project'
  readonly default_workflow: string
  readonly allowed_workflows: '*' | readonly string[]
}

export interface PipelineStageCatalogEntryV1 {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly mode: PipelineStageMode
  readonly skill_ids: readonly string[]
  /** Exact in-stage dependency graph; an empty list means the skill is eligible to run in parallel. */
  readonly skill_dependencies: Readonly<Record<string, readonly string[]>>
  readonly depends_on: readonly string[]
  readonly gate: 'review' | 'auto' | null
}

export interface PipelineCatalogEntryV1 {
  readonly id: string
  readonly version: string
  readonly fingerprint: string
  readonly source: DefinitionCatalogSource
  readonly workflow_id: string
  readonly track_id: string
  readonly stage_order: readonly string[]
  readonly stages: readonly PipelineStageCatalogEntryV1[]
}

export interface DefinitionCatalogV1 {
  readonly schema_version: typeof DEFINITION_CATALOG_SCHEMA
  readonly revision: string
  readonly fingerprint: string
  readonly generated_at: string
  readonly project: { readonly root: string; readonly identity: string }
  readonly adapters: readonly AdapterCatalogEntryV1[]
  readonly workflows: readonly WorkflowCatalogEntryV1[]
  readonly tracks: readonly TrackCatalogEntryV1[]
  readonly pipelines: readonly PipelineCatalogEntryV1[]
}

export type DefinitionCatalogEventKind = 'snapshot' | 'catalog-updated' | 'install-state'

export interface AdapterInstallStateV1 {
  readonly job_id: string
  readonly host: string
  readonly phase: 'queued' | 'preflight' | 'installing' | 'verifying' | 'planned' | 'installed' | 'failed'
  readonly message: string
  readonly at: string
  readonly exit_code?: number
}

export interface DefinitionCatalogEventV1 {
  readonly schema_version: typeof DEFINITION_CATALOG_EVENT_SCHEMA
  readonly kind: DefinitionCatalogEventKind
  readonly revision: string
  readonly fingerprint: string
  readonly catalog?: DefinitionCatalogV1
  readonly install?: AdapterInstallStateV1
}

/** Immutable selection receipt written with a newly-created Change. */
export interface PipelineSelectionV1 {
  readonly schema_version: typeof PIPELINE_SELECTION_SCHEMA
  readonly pipeline_id: string
  readonly pipeline_version: string
  readonly workflow_id: string
  readonly workflow_fingerprint: string
  readonly track_id: string
  readonly track_revision: string
  readonly source: 'automatic' | 'user'
  readonly selected_at: string
}
