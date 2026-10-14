import { createHash } from 'node:crypto'
import {
  ADAPTER_CAPABILITY_BY_HOST,
  DEFAULT_WORKFLOW_SOURCE,
  listTracks,
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

function stepEntries(steps: WorkflowDef['steps']): WorkflowCatalogEntryV1['steps'] {
  return steps.map((step, order) => ({
    id: step.id,
    label: step.label,
    order,
    gate: step.gate,
    skill_ids: step.skills.map((skill: { id: string }) => skill.id),
    skill_dependencies: Object.fromEntries(step.skills.map((skill: { id: string; depends_on?: readonly string[] }) => [skill.id, [...(skill.depends_on ?? [])]])),
    transition_events: step.transitions.map((transition: { event: string }) => transition.event),
  }))
}

function workflowEntry(workflow: WorkflowDef, source: WorkflowCatalogEntryV1['source']): WorkflowCatalogEntryV1 {
  return {
    id: workflow.name,
    version: 'v1',
    fingerprint: digest(workflow),
    source,
    readonly: source === 'builtin',
    steps: stepEntries(workflow.steps),
  }
}

/**
 * 轨道就是工作流的分支：每条分支一个条目，身份是「工作流 + 轨道 id」（allowed_workflows 只有它所在的工作流）。
 * 分支没有独立的 revision，随工作流内容走；平铺工作流的唯一隐式分支用工作流名当 id。
 */
function trackEntries(workflow: WorkflowDef, entry: WorkflowCatalogEntryV1): TrackCatalogEntryV1[] {
  return listTracks(workflow).map((branch) => ({
    id: branch.id,
    label: branch.label,
    builtin: entry.source === 'builtin',
    revision: entry.fingerprint.slice(0, 16),
    source: entry.source === 'builtin' ? 'builtin' : 'project',
    default_workflow: entry.id,
    allowed_workflows: [entry.id],
  }))
}

function pipelineEntry(
  workflow: WorkflowCatalogEntryV1,
  track: TrackCatalogEntryV1,
  branchSteps: WorkflowCatalogEntryV1['steps'],
): PipelineCatalogEntryV1 {
  const stages = branchSteps.map((step, order) => {
    const previous = order === 0 ? [] : [branchSteps[order - 1]?.id ?? '']
    const skillDependencies = step.skill_dependencies
    const mode = step.skill_ids.length > 1
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

interface CatalogWorkflow {
  readonly entry: WorkflowCatalogEntryV1
  readonly definition: WorkflowDef
}

function workflowDefinitions(anchor: WorkflowRootAnchor): CatalogWorkflow[] {
  const result: CatalogWorkflow[] = []
  const add = (definition: WorkflowDef, source: WorkflowCatalogEntryV1['source']): void => {
    result.push({ entry: workflowEntry(definition, source), definition })
  }
  const names = listWorkflowNames(anchor)
  add(names.includes('default') ? readWorkflowForApi(anchor, 'default') : parseWorkflow(DEFAULT_WORKFLOW_SOURCE), names.includes('default') ? 'project' : 'builtin')
  for (const name of names.filter((candidate) => !isDefaultWorkflowName(candidate))) {
    add(readWorkflowForApi(anchor, name), 'project')
  }
  const seen = new Set<string>()
  return result.filter(({ entry }) => !seen.has(entry.id) && (seen.add(entry.id), true))
}

export interface DefinitionCatalogDeps {
  readonly anchor: WorkflowRootAnchor
  readonly hostHome: string
  readonly operationRunner: PipelineCliRunner
  readonly generatedAt: string
}

export async function buildDefinitionCatalog(deps: DefinitionCatalogDeps): Promise<DefinitionCatalogV1> {
  assertWorkflowRootAnchor(deps.anchor)
  const hostResult = await deps.operationRunner(deps.hostHome, ['host-target-plan', '--json'])
  if (hostResult.exitCode !== 0) throw new Error('宿主 catalog 命令失败')
  const hostCatalog = decodeHostTargetCatalog(parsePipelineCliJson(hostResult.stdout))
  if (hostCatalog === null) throw new Error('宿主 catalog 响应无效')
  const catalogWorkflows = workflowDefinitions(deps.anchor)
  const workflows = catalogWorkflows.map(({ entry }) => entry)
  const tracks = catalogWorkflows.flatMap(({ entry, definition }) => trackEntries(definition, entry))
  const pipelines = catalogWorkflows.flatMap(({ entry, definition }) => listTracks(definition).map((branch) => {
    const track = tracks.find((candidate) => candidate.default_workflow === entry.id && candidate.id === branch.id)
    if (track === undefined) throw new Error(`definition catalog: 轨道 ${entry.id}/${branch.id} 缺条目`)
    return pipelineEntry(entry, track, stepEntries(branch.steps))
  }))
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
