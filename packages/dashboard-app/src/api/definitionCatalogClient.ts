import { ApiError, getToken, isRecord, readJson, throwApiError, wrapNetwork } from './transport'
import type { AdapterInstallJob, AdapterInstallState, DefinitionCatalog } from './definitionCatalogTypes'

function isCatalog(value: unknown): value is DefinitionCatalog {
  if (!isRecord(value) || value.schema_version !== 'definition-catalog/v1'
    || typeof value.revision !== 'string' || typeof value.fingerprint !== 'string'
    || typeof value.generated_at !== 'string' || !isRecord(value.project)
    || typeof value.project.root !== 'string' || typeof value.project.identity !== 'string'
    || !Array.isArray(value.adapters) || !Array.isArray(value.workflows)
    || !Array.isArray(value.tracks) || !Array.isArray(value.pipelines)) return false
  const capability = (entry: unknown): entry is 'native' | 'degraded' | 'none' =>
    entry === 'native' || entry === 'degraded' || entry === 'none'
  const strings = (entry: unknown): entry is string[] => Array.isArray(entry) && entry.every((item) => typeof item === 'string')
  const deps = (entry: unknown): entry is Record<string, string[]> => isRecord(entry)
    && Object.values(entry).every((items) => strings(items))
  const adapters = value.adapters.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.label === 'string'
    && (entry.kind === 'native' || entry.kind === 'adapter')
    && (entry.tier === 'A' || entry.tier === 'B' || entry.tier === 'C')
    && typeof entry.cli_flag === 'string' && (entry.target_scope === 'user' || entry.target_scope === 'project')
    && isRecord(entry.capabilities) && capability(entry.capabilities.inject)
    && capability(entry.capabilities.veto) && capability(entry.capabilities.track)
    && typeof entry.veto_fail_closed === 'boolean'
    && Array.isArray(entry.supported_operations) && entry.supported_operations.length === 2
    && entry.supported_operations[0] === 'setup' && entry.supported_operations[1] === 'update'
    && typeof entry.state === 'string')
  const workflows = value.workflows.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.version === 'string' && typeof entry.fingerprint === 'string'
    && (entry.source === 'builtin' || entry.source === 'project' || entry.source === 'user')
    && typeof entry.readonly === 'boolean' && Array.isArray(entry.steps)
    && entry.steps.every((step) => isRecord(step) && typeof step.id === 'string' && typeof step.label === 'string'
      && Number.isInteger(step.order) && (step.gate === null || step.gate === 'review' || step.gate === 'auto')
      && strings(step.skill_ids) && deps(step.skill_dependencies) && strings(step.transition_events)))
  const tracks = value.tracks.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.label === 'string' && typeof entry.builtin === 'boolean'
    && typeof entry.revision === 'string' && (entry.source === 'builtin' || entry.source === 'project')
    && typeof entry.default_workflow === 'string' && (entry.allowed_workflows === '*' || strings(entry.allowed_workflows)))
  const pipelines = value.pipelines.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.version === 'string' && typeof entry.fingerprint === 'string'
    && (entry.source === 'builtin' || entry.source === 'project' || entry.source === 'user')
    && typeof entry.workflow_id === 'string' && typeof entry.track_id === 'string' && strings(entry.stage_order)
    && Array.isArray(entry.stages) && entry.stages.every((stage) => isRecord(stage)
      && typeof stage.id === 'string' && typeof stage.label === 'string' && Number.isInteger(stage.order)
      && (stage.mode === 'serial' || stage.mode === 'parallel') && strings(stage.skill_ids)
      && deps(stage.skill_dependencies) && strings(stage.depends_on)
      && (stage.gate === null || stage.gate === 'review' || stage.gate === 'auto')))
  return adapters && workflows && tracks && pipelines
}

function isAdapterInstallJob(value: unknown): value is AdapterInstallJob {
  return isRecord(value) && value.schema_version === 'adapter-install/v1'
    && typeof value.job_id === 'string' && typeof value.root === 'string'
    && Array.isArray(value.hosts) && value.hosts.every((host) => typeof host === 'string')
    && typeof value.dry_run === 'boolean' && typeof value.stream === 'string'
}

function isAdapterInstallState(value: unknown): value is AdapterInstallState {
  return isRecord(value) && typeof value.job_id === 'string' && typeof value.host === 'string'
    && ['queued', 'preflight', 'installing', 'verifying', 'planned', 'installed', 'failed'].includes(String(value.phase))
    && typeof value.message === 'string' && typeof value.at === 'string'
    && (value.exit_code === undefined || Number.isInteger(value.exit_code))
}

export async function fetchDefinitionCatalog(root: string, signal?: AbortSignal): Promise<DefinitionCatalog> {
  let response: Response
  try {
    response = await fetch(`/api/catalog?root=${encodeURIComponent(root)}`, {
      headers: { Accept: 'application/json' }, ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwApiError(response, '定义目录获取失败')
  const body = await readJson(response)
  if (!isCatalog(body)) throw new ApiError('定义目录响应形状无效', response.status)
  return body
}

export function subscribeDefinitionCatalog(
  root: string,
  onCatalog: (catalog: DefinitionCatalog) => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => undefined
  const source = new EventSource(`/api/catalog/stream?root=${encodeURIComponent(root)}`)
  let closed = false
  let acceptedFingerprint = ''
  const close = (): void => {
    if (closed) return
    closed = true
    source.close()
  }
  const fail = (): void => {
    if (closed) return
    close()
    onError?.()
  }
  const handle = (event: MessageEvent<string>): void => {
    if (closed) return
    try {
      const payload: unknown = JSON.parse(event.data)
      if (isRecord(payload) && isCatalog(payload.catalog) && payload.catalog.fingerprint !== acceptedFingerprint) {
        acceptedFingerprint = payload.catalog.fingerprint
        onCatalog(payload.catalog)
      }
    } catch { fail() }
  }
  source.addEventListener('snapshot', handle)
  source.addEventListener('catalog-updated', handle)
  // EventSource automatically retries transient failures. Do not surface a
  // false error (or tear down a healthy subscription) while it is merely
  // reconnecting; only a terminal CLOSED state is actionable.
  source.onerror = () => {
    if (source.readyState === 2) fail()
  }
  return close
}

export async function postAdapterInstall(input: {
  root: string
  hosts: string[]
  dry_run?: boolean
  confirm?: boolean
}): Promise<AdapterInstallJob> {
  let response: Response
  try {
    response = await fetch('/api/adapters/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(input),
    })
  } catch (error) { wrapNetwork(error) }
  if (!response.ok) await throwApiError(response, '适配器安装任务创建失败')
  const body = await readJson(response)
  if (!isAdapterInstallJob(body)) {
    throw new ApiError('适配器安装响应形状无效', response.status)
  }
  return body
}

export function subscribeAdapterInstall(
  stream: string,
  onState: (state: AdapterInstallState) => void,
  onComplete?: () => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    // The install request has already been accepted by the server. Without a
    // streaming transport the UI must leave its busy state and offer recovery
    // instead of silently disabling both actions forever.
    onError?.()
    return () => undefined
  }
  const source = new EventSource(stream)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    source.close()
  }
  const fail = (): void => {
    if (closed) return
    close()
    onError?.()
  }
  source.addEventListener('install-state', (event: MessageEvent<string>) => {
    if (closed) return
    try {
      const payload: unknown = JSON.parse(event.data)
      if (isRecord(payload) && isAdapterInstallState(payload.state)) onState(payload.state)
    } catch { fail() }
  })
  source.addEventListener('complete', () => {
    if (closed) return
    close()
    onComplete?.()
  })
  source.onerror = fail
  return close
}
