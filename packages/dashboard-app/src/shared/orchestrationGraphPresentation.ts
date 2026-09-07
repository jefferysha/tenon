import type {
  OrchestrationEdge,
  OrchestrationGraph,
  OrchestrationNode,
  OrchestrationNodeKind,
} from '../api/orchestrationGraphClient'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

export const toneByKind: Record<OrchestrationNodeKind, string> = {
  workflow: 'border-blue-b bg-blue-t',
  change: 'border-green-b bg-green-t',
  phase: 'border-border-2 bg-card',
  task: 'border-green-b bg-green-t',
  document: 'border-amber-b bg-amber-t',
  review: 'border-red-b bg-red-t',
  session: 'border-blue-b bg-blue-t',
}

export function toggledKinds(
  current: Set<OrchestrationNodeKind>,
  kind: OrchestrationNodeKind,
): Set<OrchestrationNodeKind> {
  if (current.size === 0) return new Set([kind])
  const next = new Set(current)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  return next
}

const layerByKind: Record<OrchestrationNodeKind, number> = {
  workflow: 0,
  change: 1,
  phase: 2,
  task: 3,
  document: 3,
  review: 3,
  session: 3,
}

const defaultPhases = new Set(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
const reviewFields = new Set([
  'pre_verify_review_result',
  'agent_review_result',
  'codex_review_result',
])
const documentKinds = new Set([
  'proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr',
  'delta-spec', 'superpower-plan', 'plan', 'verification-report', 'applied-spec',
])
const metadataKeys = new Set([
  'execution_model', 'frozen_fingerprint', 'current_fingerprint',
  'phase', 'track', 'preset', 'phase_id', 'order', 'gate',
  'required_read', 'producer_count', 'field', 'heartbeat_at', 'expires_at',
])
const deferredCapabilities = new Set([
  'agent', 'historical-session-turn', 'acceptance-criteria',
  'task-dependencies', 'write-orchestration', 'live-refresh',
])
const standardEvents = new Set([
  'open-complete', 'explore-complete', 'spec-complete', 'requirements-changed',
  'build-complete', 'verify-pass', 'verify-fail', 'ship-complete', 'archived',
])

function translatedOr(t: Translate, key: string, fallback: string): string {
  const translated = t(key)
  return translated === key ? fallback : translated
}

function phaseLabel(phase: string, t: Translate): string {
  return defaultPhases.has(phase)
    ? t(`detail.orchestration_graph.phase_${phase}`)
    : phase
}

export function nodeLabel(
  node: OrchestrationNode,
  t: Translate,
  localizeBuiltinPhaseIds: boolean,
): string {
  if (node.kind === 'phase') {
    const phase = node.metadata.find((item) => item.key === 'phase_id')?.value
    if (localizeBuiltinPhaseIds && phase !== undefined && defaultPhases.has(phase)) {
      return phaseLabel(phase, t)
    }
    return node.label
  }
  if (node.kind === 'review') {
    const field = node.metadata.find((item) => item.key === 'field')?.value
    if (field !== undefined && reviewFields.has(field)) {
      return t(`detail.orchestration_graph.review_${field}`)
    }
  }
  if (node.kind === 'document' && documentKinds.has(node.label)) {
    return t(`detail.orchestration_graph.document_${node.label.replace(/-/g, '_')}`)
  }
  if (node.kind === 'session') {
    const id = node.label.startsWith('Session ') ? node.label.slice('Session '.length) : node.label
    return t('detail.orchestration_graph.session_active', { id })
  }
  return node.label
}

export function usesBuiltinPhaseLabels(graph: OrchestrationGraph | null): boolean {
  return graph?.nodes.find((node) => node.kind === 'workflow')
    ?.metadata.some((item) => item.key === 'execution_model' && item.value === 'phase-manifest') ?? false
}

export function statusLabel(status: string | null, t: Translate): string {
  return status === null ? '' : t(`detail.orchestration_graph.status_${status}`)
}

export function metadataLabel(key: string, t: Translate): string {
  return metadataKeys.has(key)
    ? t(`detail.orchestration_graph.meta_${key}`)
    : key
}

export function metadataValue(key: string, value: string, t: Translate): string {
  if (key === 'phase' || key === 'phase_id') return phaseLabel(value, t)
  if (key === 'execution_model') {
    return translatedOr(
      t,
      `detail.orchestration_graph.execution_${value.replace(/-/g, '_')}`,
      value,
    )
  }
  if (key === 'gate' && new Set(['none', 'review', 'confirm']).has(value)) {
    return t(`detail.orchestration_graph.gate_${value}`)
  }
  if (key === 'track' && new Set(['chat', 'simple', 'frontend', 'backend', 'pm', 'free', 'unknown']).has(value)) {
    return t(`detail.orchestration_graph.track_${value}`)
  }
  if (key === 'preset' && new Set(['full', 'tweak', 'hotfix', 'unknown']).has(value)) {
    return t(`detail.orchestration_graph.preset_${value}`)
  }
  if (key === 'required_read' && (value === 'true' || value === 'false')) {
    return t(`detail.orchestration_graph.boolean_${value}`)
  }
  if (key === 'field' && reviewFields.has(value)) {
    return t(`detail.orchestration_graph.review_${value}`)
  }
  return value
}

export function deferredLabel(capability: string, t: Translate): string {
  return deferredCapabilities.has(capability)
    ? t(`detail.orchestration_graph.deferred_${capability.replace(/-/g, '_')}`)
    : capability
}

export function edgeLabel(edge: OrchestrationEdge, t: Translate): string {
  const kind = t(`detail.orchestration_graph.edge_${edge.kind}`)
  if (edge.kind === 'transitions') {
    const event = standardEvents.has(edge.label)
      ? t(`detail.orchestration_graph.event_${edge.label.replace(/-/g, '_')}`)
      : edge.label.replace(/[-_]+/g, ' ')
    return `${kind} · ${event}`
  }
  const detailKind = edge.label === 'contains phase'
    ? 'phase'
    : edge.label === 'contains task'
      ? 'task'
      : edge.label === 'produces document'
        ? 'document'
        : null
  return detailKind === null
    ? kind
    : `${kind} · ${t(`detail.orchestration_graph.kind_${detailKind}`)}`
}

export function compareNodes(a: OrchestrationNode, b: OrchestrationNode): number {
  const layer = layerByKind[a.kind] - layerByKind[b.kind]
  if (layer !== 0) return layer
  if (a.kind === 'phase' && b.kind === 'phase') {
    const aOrder = Number(a.metadata.find((item) => item.key === 'order')?.value ?? Number.MAX_SAFE_INTEGER)
    const bOrder = Number(b.metadata.find((item) => item.key === 'order')?.value ?? Number.MAX_SAFE_INTEGER)
    if (aOrder !== bOrder) return aOrder - bOrder
  }
  return a.id.localeCompare(b.id)
}

export const ORCHESTRATION_RESOURCE_KINDS = [
  'task', 'document', 'review', 'session',
] as const satisfies readonly OrchestrationNodeKind[]

export interface OrchestrationGraphSections {
  readonly scope: readonly OrchestrationNode[]
  readonly phases: readonly OrchestrationNode[]
  readonly resources: ReadonlyMap<OrchestrationNodeKind, readonly OrchestrationNode[]>
  readonly trunkEdgeIds: ReadonlySet<string>
  readonly secondaryEdges: readonly OrchestrationEdge[]
}

/**
 * Projects the transport graph into one deterministic reading path without changing graph facts.
 * One forward transition per adjacent phase pair becomes a trunk cue; every other edge remains a
 * secondary relationship and is still available to the semantic list.
 */
export function orchestrationGraphSections(
  nodes: readonly OrchestrationNode[],
  edges: readonly OrchestrationEdge[],
): OrchestrationGraphSections {
  const scope = nodes.filter((node) => node.kind === 'workflow' || node.kind === 'change').sort(compareNodes)
  const phases = nodes.filter((node) => node.kind === 'phase').sort(compareNodes)
  const resources = new Map<OrchestrationNodeKind, readonly OrchestrationNode[]>()
  for (const kind of ORCHESTRATION_RESOURCE_KINDS) {
    const grouped = nodes.filter((node) => node.kind === kind).sort(compareNodes)
    if (grouped.length > 0) resources.set(kind, grouped)
  }

  const trunkEdgeIds = new Set<string>()
  for (let index = 0; index < phases.length - 1; index += 1) {
    const source = phases[index]
    const target = phases[index + 1]
    if (source === undefined || target === undefined) continue
    const trunk = edges
      .filter((edge) => edge.kind === 'transitions'
        && edge.source === source.id
        && edge.target === target.id)
      .sort((a, b) => a.id.localeCompare(b.id))[0]
    if (trunk !== undefined) trunkEdgeIds.add(trunk.id)
  }

  return {
    scope,
    phases,
    resources,
    trunkEdgeIds,
    secondaryEdges: edges.filter((edge) => !trunkEdgeIds.has(edge.id)),
  }
}

export function graphLayout(nodes: readonly OrchestrationNode[]): {
  readonly positions: Map<string, { x: number; y: number }>
  readonly height: number
  readonly width: number
} {
  const columns = new Map<number, OrchestrationNode[]>()
  for (const node of nodes) {
    const layer = layerByKind[node.kind]
    columns.set(layer, [...(columns.get(layer) ?? []), node])
  }
  const positions = new Map<string, { x: number; y: number }>()
  let maxRows = 1
  for (const [column, items] of columns) {
    const sorted = [...items].sort(compareNodes)
    const spread = column === 3 ? Math.min(3, sorted.length) : 1
    maxRows = Math.max(maxRows, Math.ceil(sorted.length / spread))
    sorted.forEach((node, index) => positions.set(node.id, {
      x: 12 + (column + (column === 3 ? index % spread : 0)) * 168,
      y: 14 + Math.floor(index / spread) * 72,
    }))
  }
  const resourceCount = columns.get(3)?.length ?? 0
  const width = resourceCount === 0 ? 680 : 680 + (Math.min(3, resourceCount) - 1) * 168
  return { positions, height: Math.max(94, 28 + maxRows * 72), width }
}
