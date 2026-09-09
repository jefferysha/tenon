export type AdapterTier = 'A' | 'B' | 'C'
export type AdapterState = 'unknown' | 'detected' | 'not-detected' | 'installed' | 'installing' | 'failed'
/**
 * 单项适配器能力的保真度档位（与 kernel 的 AdapterCapabilityStatus 同构）。
 * `degraded` = 有实现但语义弱于原生，必须与 `none` 区分开呈现，否则用户答不出
 * 「我这个终端的 veto 是不是降级的」。
 */
export type AdapterCapabilityStatus = 'native' | 'degraded' | 'none'
export type AdapterCapabilityId = 'inject' | 'veto' | 'track'

export interface DefinitionCatalogAdapter {
  id: string
  label: string
  kind: 'native' | 'adapter'
  tier: AdapterTier
  cli_flag: string
  target_scope: 'user' | 'project'
  capabilities: Record<AdapterCapabilityId, AdapterCapabilityStatus>
  /** veto 钩子失败时是否按拦截处理；只有显式声明的宿主才是硬拦承诺。 */
  veto_fail_closed: boolean
  supported_operations: ['setup', 'update']
  state: AdapterState
  state_reason?: string
}

export interface DefinitionCatalogWorkflow {
  id: string
  version: string
  fingerprint: string
  source: 'builtin' | 'project' | 'user'
  readonly: boolean
  steps: Array<{ id: string; label: string; order: number; gate: 'review' | 'confirm' | null; skill_ids: string[]; skill_dependencies: Record<string, string[]>; transition_events: string[] }>
}

export interface DefinitionCatalogTrack {
  id: string
  label: string
  builtin: boolean
  revision: string
  source: 'builtin' | 'project'
  default_workflow: string
  allowed_workflows: '*' | string[]
}

export interface DefinitionCatalogPipeline {
  id: string
  version: string
  fingerprint: string
  source: 'builtin' | 'project' | 'user'
  workflow_id: string
  track_id: string
  stage_order: string[]
  stages: Array<{ id: string; label: string; order: number; mode: 'serial' | 'parallel'; skill_ids: string[]; skill_dependencies: Record<string, string[]>; depends_on: string[]; gate: 'review' | 'confirm' | null }>
}

export interface DefinitionCatalog {
  schema_version: 'definition-catalog/v1'
  revision: string
  fingerprint: string
  generated_at: string
  project: { root: string; identity: string }
  adapters: DefinitionCatalogAdapter[]
  workflows: DefinitionCatalogWorkflow[]
  tracks: DefinitionCatalogTrack[]
  pipelines: DefinitionCatalogPipeline[]
}

export interface AdapterInstallJob {
  schema_version: 'adapter-install/v1'
  job_id: string
  root: string
  hosts: string[]
  dry_run: boolean
  stream: string
}

export interface AdapterInstallState {
  job_id: string
  host: string
  phase: 'queued' | 'preflight' | 'installing' | 'verifying' | 'planned' | 'installed' | 'failed'
  message: string
  at: string
  exit_code?: number
}
