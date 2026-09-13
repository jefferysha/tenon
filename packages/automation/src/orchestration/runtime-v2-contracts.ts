import { type ArtifactCatalog, type BoardSnapshotV2, type OrchestrationLedger, type SkillResultV2, type SkillRunV2, type ValidationReportV2, type WorkItemV2 } from '@tenon/kernel'
import { type RuntimeObservationV2, type RuntimePolicyV2, type NormalizedPolicyV2 } from './runtime-v2-boundary.js'
import { type RuntimeArtifactResolverV2, type RuntimeInputBundleV2 } from './input-materialization-v2.js'
import { type StageArtifactRuntime } from '../artifact-runtime/stage-runtime.js'
import { type ArtifactServicePort } from '../artifact-runtime/stage-runtime.js'

export interface RuntimeExecutorInputV2 {
  readonly run_id: string
  readonly work_item_id: string
  readonly skill_id: string
  readonly skill_version: string
  readonly mcp_ids: readonly string[]
  readonly input_refs: readonly string[]
  readonly input_bundle: RuntimeInputBundleV2
  readonly signal: AbortSignal
  /** Stage-scoped observer/publisher. Skills may explicitly publish actual files. */
  readonly artifact_runtime?: StageArtifactRuntime
  /** Bounded metadata exposed before execution; file bodies remain on-demand. */
  readonly artifact_catalog?: ArtifactCatalog
}

/** Provider-neutral port. The returned value is untrusted and bounded here. */
export interface RuntimeExecutorV2 {
  execute(input: RuntimeExecutorInputV2): Promise<unknown>
}

export interface RuntimeValidatorInputV2 {
  readonly run_id: string
  readonly result_id: string
  readonly work_item_id: string
  readonly skill_id: string
  readonly skill_version: string
  readonly observation: RuntimeObservationV2
  readonly input_bundle: RuntimeInputBundleV2
}

/** A validator may return a V2 report or an equivalent plain JSON record. */
export interface RuntimeValidatorV2 {
  validate(input: RuntimeValidatorInputV2): Promise<unknown>
}

export type { RuntimeObservationV2, RuntimePolicyV2 }
export type { RuntimeArtifactV2 } from './runtime-v2-boundary.js'

export interface ExecutionRuntimeOptionsV2 {
  readonly change_dir: string
  readonly ledger: OrchestrationLedger
  readonly worker_id: string
  readonly executor: RuntimeExecutorV2
  readonly validator?: RuntimeValidatorV2
  readonly signal?: AbortSignal
  readonly clock?: () => string
  readonly id_factory?: (prefix: string) => string
  readonly retry?: RuntimePolicyV2
  readonly actor_id?: string
  /** Optional resolver for project/MCP artifact references. Files in change_dir are resolved by default. */
  readonly artifact_resolver?: RuntimeArtifactResolverV2
  /** Durable runtime artifact service. When omitted, one is opened in change_dir. */
  readonly artifact_service?: ArtifactServicePort
}

export interface RuntimeRecoveryV2 {
  readonly report: Awaited<ReturnType<OrchestrationLedger['recover']>>['report']
  readonly recovered: boolean
  readonly expired_runs: readonly string[]
}

export interface ExecutionRuntimeResultV2 {
  readonly ok: boolean
  readonly snapshot: BoardSnapshotV2
  readonly recovery: RuntimeRecoveryV2
  readonly attempts: number
  readonly diagnostics: readonly string[]
}

export class ExecutionRuntimeErrorV2 extends Error {
  readonly code: 'ledger-unavailable' | 'command-rejected' | 'runtime-invalid' | 'round-budget-exceeded'

  constructor(code: ExecutionRuntimeErrorV2['code'], message: string) {
    super(message)
    this.name = 'ExecutionRuntimeErrorV2'
    this.code = code
  }
}

export interface SettledRunV2 {
  readonly run: SkillRunV2
  readonly item: WorkItemV2
  readonly result: SkillResultV2
  readonly report?: ValidationReportV2
  readonly retryable: boolean
  readonly blocking: boolean
}
