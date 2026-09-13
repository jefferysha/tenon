import { createHash } from 'node:crypto'
import {
  ADAPTER_CAPABILITY_BY_HOST,
  BUILTIN_WORKFLOW_IDS,
  DEFAULT_WORKFLOW_SOURCE,
  builtinWorkflow,
  loadTrackRegistry,
  parseWorkflow,
  type AdapterCatalogEntryV1,
  type DefinitionCatalogV1,
  type PipelineCatalogEntryV1,
  type TrackCatalogEntryV1,
  type WorkflowCatalogEntryV1,
  type WorkflowDef,
  validateDefinitionCatalogV1,
  isDefaultWorkflowName,
} from '@tenon/kernel'
import { detectNativeHostTargets } from './hostTargetDetection.js'
import { parsePipelineCliJson, type PipelineCliRunner } from './operations.js'
import {
  decodeHostTargetCatalog,
  type HostTargetCatalogDto,
} from './hostTargetPlanProtocol.js'
import {
  assertWorkflowRootAnchor,
  listWorkflowNames,
  readWorkflowForApi,
  type WorkflowRootAnchor,
} from './workflows.js'
import type { TrackValidationContext } from '@tenon/kernel'

/**
 * 能力矩阵一律来自 adapters/registry.yaml 的生成表（ADAPTER_CAPABILITY_BY_HOST），
 * 不再手抄 tier 表、也不再「由 tier 推导能力」。此前的推导（inject 恒 true、
 * veto = tier==='A'、track = tier!=='C'）同时少报了 cursor/copilot 的 native veto，
 * 又把 4 个降级 host 的 inject 多报成 true；pi（tier B / inject native / veto degraded）
 * 证明档位字母不决定哪个能力降级。
 *
 * 三态原样透出：`native` / `degraded` / `none`。此前协议折叠成布尔（true = native），
 * 把 degraded 与 none 一起报成 false，UI 因此无法区分「没有」与「有但更弱」。
 * 未在 registry 中登记的 host 一律按 none + fail-open 处理（fail-closed 的能力承诺
 * 只能来自真源，不能靠缺省猜测）。
 */
function capabilityProjection(hostId: string): Pick<AdapterCatalogEntryV1, 'capabilities' | 'veto_fail_closed'> {
  const row = ADAPTER_CAPABILITY_BY_HOST.get(hostId)
  if (row === undefined) {
    return { capabilities: { inject: 'none', veto: 'none', track: 'none' }, veto_fail_closed: false }
  }
  return { capabilities: row.capabilities, veto_fail_closed: row.veto_fail_closed }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex').slice(0, 32)
}

function workflowEntry(workflow: WorkflowDef, source: WorkflowCatalogEntryV1['source']): WorkflowCatalogEntryV1 {
  const steps = workflow.steps.map((step, order) => ({
    id: step.id,
    label: step.label,
    order,
    gate: step.gate,
    skill_ids: step.skills.map((skill: { id: string }) => skill.id),
    skill_dependencies: Object.fromEntries(step.skills.map((skill: { id: string; depends_on?: readonly string[] }) => [skill.id, [...(skill.depends_on ?? [])]])),
    transition_events: step.transitions.map((transition: { event: string }) => transition.event),
  }))
  return {
    id: workflow.name,
    version: 'v1',
    fingerprint: digest(workflow),
    source,
    readonly: source === 'builtin',
    steps,
  }
}

function pipelineEntry(
  workflow: WorkflowCatalogEntryV1,
  track: TrackCatalogEntryV1,
): PipelineCatalogEntryV1 {
  const stages = workflow.steps.map((step, order) => {
    const previous = order === 0 ? [] : [workflow.steps[order - 1]?.id ?? '']
    const sourceStep = workflow.steps[order]
    const skillDependencies = sourceStep?.skill_dependencies ?? {}
    const mode = sourceStep !== undefined
      && sourceStep.skill_ids.length > 1
      && Object.values(skillDependencies).every((dependencies) => dependencies.length === 0)
      ? 'parallel' as const
      : 'serial' as const
    return {
      id: step.id,
      label: step.label,
      order,
      mode,
      skill_ids: step.skill_ids,
      skill_dependencies: skillDependencies,
      depends_on: previous.filter(Boolean),
      gate: step.gate,
    }
  })
  const source = { workflow_id: workflow.id, track_id: track.id, stages }
  return {
    // Keep catalog identity aligned with planner-v2's canonical automatic
    // pipeline identity so a selected pipeline can be replayed verbatim.
    id: `${workflow.id}:${track.id}:main`,
    version: 'v1',
    fingerprint: digest(source),
    source: workflow.source === 'builtin' && track.source === 'builtin' ? 'builtin' : 'project',
    workflow_id: workflow.id,
    track_id: track.id,
    stage_order: stages.map((stage) => stage.id),
    stages,
  }
}

function adapterEntries(catalog: HostTargetCatalogDto, hostHome: string): AdapterCatalogEntryV1[] {
  const detection = detectNativeHostTargets(hostHome)
  const detectedRaw = detection.status === 200 && typeof detection.body === 'object' && detection.body !== null
    ? (detection.body as { detected_hosts?: unknown }).detected_hosts
    : undefined
  const detected = new Set<string>(Array.isArray(detectedRaw)
    ? detectedRaw.filter((id: unknown): id is string => typeof id === 'string')
    : [])
  return catalog.targets.map((target) => {
    // registry.yaml 的连接键是 cliFlag（TS 侧 host id），不是 registry 的 id
    // （registry 用 'claude-code'，TS 侧用 'claude'）。
    const tier = ADAPTER_CAPABILITY_BY_HOST.get(target.id)?.tier ?? 'C'
    return {
      id: target.id,
      label: target.id[0]?.toUpperCase() + target.id.slice(1),
      kind: target.kind,
      tier,
      cli_flag: target.cli_flag,
      target_scope: target.target_scope,
      ...capabilityProjection(target.id),
      supported_operations: ['setup', 'update'],
      state: detected.has(target.id) ? 'detected' : target.kind === 'native' ? 'not-detected' : 'unknown',
      ...(target.kind === 'adapter' ? { state_reason: 'adapter 状态在项目目标目录安装后由安装任务回写' } : {}),
    }
  })
}

function workflowDefinitions(anchor: WorkflowRootAnchor): WorkflowCatalogEntryV1[] {
  const result: WorkflowCatalogEntryV1[] = []
  const names = listWorkflowNames(anchor)
  const defaultOverride = names.includes('default') ? readWorkflowForApi(anchor, 'default') : null
  result.push(defaultOverride === null
    ? workflowEntry(parseWorkflow(DEFAULT_WORKFLOW_SOURCE), 'builtin')
    : workflowEntry(defaultOverride, 'project'))
  for (const id of BUILTIN_WORKFLOW_IDS) {
    const workflow = builtinWorkflow(id)
    if (workflow !== null) result.push(workflowEntry(workflow, 'builtin'))
  }
  for (const name of names.filter((candidate) => !isDefaultWorkflowName(candidate))) {
    const workflow = readWorkflowForApi(anchor, name)
    result.push(workflowEntry(workflow, 'project'))
  }
  const seen = new Set<string>()
  return result.filter((entry) => !seen.has(entry.id) && (seen.add(entry.id), true))
}

export interface DefinitionCatalogDeps {
  readonly anchor: WorkflowRootAnchor
  readonly hostHome: string
  readonly operationRunner: PipelineCliRunner
  readonly trackValidationContext: TrackValidationContext
  readonly generatedAt: string
}

export async function buildDefinitionCatalog(deps: DefinitionCatalogDeps): Promise<DefinitionCatalogV1> {
  assertWorkflowRootAnchor(deps.anchor)
  const hostResult = await deps.operationRunner(deps.hostHome, ['host-target-plan', '--json'])
  if (hostResult.exitCode !== 0) throw new Error('宿主 catalog 命令失败')
  const hostCatalog = decodeHostTargetCatalog(parsePipelineCliJson(hostResult.stdout))
  if (hostCatalog === null) throw new Error('宿主 catalog 响应无效')
  const trackRegistry = loadTrackRegistry(deps.anchor.path, deps.trackValidationContext)
  const tracks = trackRegistry.ordered.map<TrackCatalogEntryV1>((track) => ({
    id: track.id,
    label: track.label,
    builtin: track.builtin,
    revision: trackRegistry.revision,
    source: track.builtin ? 'builtin' : 'project',
    default_workflow: track.workflow.default,
    allowed_workflows: track.workflow.allowed,
  }))
  const workflows = workflowDefinitions(deps.anchor)
  const pipelines = workflows.flatMap((workflow) => tracks
    .filter((track) => track.allowed_workflows === '*' || track.allowed_workflows.includes(workflow.id))
    .map((track) => pipelineEntry(workflow, track)))
  const base = {
    schema_version: 'definition-catalog/v1' as const,
    generated_at: deps.generatedAt,
    project: { root: deps.anchor.path, identity: digest(deps.anchor.path) },
    adapters: adapterEntries(hostCatalog, deps.hostHome),
    workflows,
    tracks,
    pipelines,
  }
  // `generated_at` is observability metadata, not definition identity.  Keep
  // it fresh for clients, but exclude it from the semantic fingerprint so an
  // SSE poll does not look like a catalog mutation every time the clock ticks.
  const { generated_at: _generatedAt, ...semanticBase } = base
  const fingerprint = digest(semanticBase)
  const catalog: DefinitionCatalogV1 = { ...base, revision: fingerprint.slice(0, 16), fingerprint }
  if (!validateDefinitionCatalogV1(catalog)) throw new Error('definition catalog 内部校验失败')
  return catalog
}
