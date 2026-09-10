import {
  DEFINITION_CATALOG_EVENT_SCHEMA,
  DEFINITION_CATALOG_SCHEMA,
  PIPELINE_SELECTION_SCHEMA,
  type DefinitionCatalogEventV1,
  type DefinitionCatalogV1,
  type PipelineSelectionV1,
} from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function skillDependencies(value: unknown): value is Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([skillId, dependencies]) => nonempty(skillId) && stringArray(dependencies))
}

/** Lightweight structural validator used at every API boundary. */
export function validateDefinitionCatalogV1(value: unknown): value is DefinitionCatalogV1 {
  if (!isRecord(value)
    || value.schema_version !== DEFINITION_CATALOG_SCHEMA
    || !nonempty(value.revision)
    || !nonempty(value.fingerprint)
    || !nonempty(value.generated_at)
    || !isRecord(value.project)
    || !nonempty(value.project.root)
    || !nonempty(value.project.identity)) return false
  for (const key of ['adapters', 'workflows', 'tracks', 'pipelines'] as const) {
    if (!Array.isArray(value[key])) return false
  }
  const adapters = value.adapters as unknown[]
  const workflows = value.workflows as unknown[]
  const tracks = value.tracks as unknown[]
  const pipelines = value.pipelines as unknown[]
  return adapters.every((entry: unknown) => {
    if (!isRecord(entry) || !nonempty(entry.id) || !nonempty(entry.label)
      || (entry.kind !== 'native' && entry.kind !== 'adapter')
      || !['A', 'B', 'C'].includes(String(entry.tier))
      || !nonempty(entry.cli_flag)
      || (entry.target_scope !== 'user' && entry.target_scope !== 'project')
      || !Array.isArray(entry.supported_operations)
      || entry.supported_operations.length !== 2
      || entry.supported_operations[0] !== 'setup'
      || entry.supported_operations[1] !== 'update'
      || !isRecord(entry.capabilities)
      || typeof entry.capabilities.inject !== 'boolean'
      || typeof entry.capabilities.veto !== 'boolean'
      || typeof entry.capabilities.track !== 'boolean'
      || !['unknown', 'detected', 'not-detected', 'installed', 'installing', 'failed'].includes(String(entry.state))) return false
    return entry.state_reason === undefined || typeof entry.state_reason === 'string'
  }) && workflows.every((entry: unknown) => {
    if (!isRecord(entry) || !nonempty(entry.id) || !nonempty(entry.version)
      || !nonempty(entry.fingerprint) || !['builtin', 'project', 'user'].includes(String(entry.source))
      || typeof entry.readonly !== 'boolean' || !Array.isArray(entry.steps)) return false
    return entry.steps.every((step) => {
      if (!isRecord(step) || !nonempty(step.id) || !nonempty(step.label)
        || !Number.isInteger(step.order) || (step.gate !== null && step.gate !== 'review' && step.gate !== 'auto')
        || !stringArray(step.skill_ids) || !skillDependencies(step.skill_dependencies) || !stringArray(step.transition_events)) return false
      const skillIds = new Set(step.skill_ids)
      return Object.entries(step.skill_dependencies).every(([skillId, refs]) => skillIds.has(skillId) && refs.every((ref) => skillIds.has(ref) && ref !== skillId))
    })
  }) && tracks.every((entry: unknown) => {
    if (!isRecord(entry) || !nonempty(entry.id) || !nonempty(entry.label) || typeof entry.builtin !== 'boolean'
      || !nonempty(entry.revision) || (entry.source !== 'builtin' && entry.source !== 'project')
      || !nonempty(entry.default_workflow)) return false
    return entry.allowed_workflows === '*'
      || stringArray(entry.allowed_workflows)
  }) && pipelines.every((entry: unknown) => {
    if (!isRecord(entry) || !nonempty(entry.id) || !nonempty(entry.version) || !nonempty(entry.fingerprint)
      || !['builtin', 'project', 'user'].includes(String(entry.source)) || !nonempty(entry.workflow_id)
      || !nonempty(entry.track_id) || !stringArray(entry.stage_order) || !Array.isArray(entry.stages)) return false
    return entry.stages.every((stage) => {
      if (!isRecord(stage) || !nonempty(stage.id) || !nonempty(stage.label)
        || !Number.isInteger(stage.order) || (stage.mode !== 'serial' && stage.mode !== 'parallel')
        || !stringArray(stage.skill_ids) || !skillDependencies(stage.skill_dependencies) || !stringArray(stage.depends_on)
        || (stage.gate !== null && stage.gate !== 'review' && stage.gate !== 'auto')) return false
      const skillIds = new Set(stage.skill_ids)
      const dependencies = Object.entries(stage.skill_dependencies)
      if (dependencies.some(([skillId, refs]) => !skillIds.has(skillId) || refs.some((ref) => !skillIds.has(ref) || ref === skillId))) return false
      return stage.mode !== 'parallel' || dependencies.every(([, refs]) => refs.length === 0)
    })
  })
}

export function validateDefinitionCatalogEventV1(value: unknown): value is DefinitionCatalogEventV1 {
  if (!isRecord(value) || value.schema_version !== DEFINITION_CATALOG_EVENT_SCHEMA
    || !['snapshot', 'catalog-updated', 'install-state'].includes(String(value.kind))
    || !nonempty(value.revision) || !nonempty(value.fingerprint)) return false
  if (value.catalog !== undefined && !validateDefinitionCatalogV1(value.catalog)) return false
  return value.install === undefined || (isRecord(value.install)
    && nonempty(value.install.job_id) && nonempty(value.install.host)
    && ['queued', 'preflight', 'installing', 'verifying', 'planned', 'installed', 'failed'].includes(String(value.install.phase))
    && nonempty(value.install.message) && nonempty(value.install.at)
    && (value.install.exit_code === undefined || Number.isInteger(value.install.exit_code)))
}

export function validatePipelineSelectionV1(value: unknown): value is PipelineSelectionV1 {
  return isRecord(value)
    && value.schema_version === PIPELINE_SELECTION_SCHEMA
    && nonempty(value.pipeline_id)
    && nonempty(value.pipeline_version)
    && nonempty(value.workflow_id)
    && /^[0-9a-f]{64}$/u.test(String(value.workflow_fingerprint))
    && nonempty(value.track_id)
    && nonempty(value.track_revision)
    && (value.source === 'automatic' || value.source === 'user')
    && nonempty(value.selected_at)
}
