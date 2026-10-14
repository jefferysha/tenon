import { createHash } from 'node:crypto'
import {
  WORKFLOW_ACTIONS,
  type WorkflowAction,
  type WorkflowPermissionLayer,
  type WorkflowPermissionLayerStatus,
} from '../workflow/policy.js'
import type {
  CreateWorkflowActionAuthoritySnapshotInput,
  WorkflowActionAuthorityLayerSnapshotV1,
  WorkflowActionAuthorityProvenanceKind,
  WorkflowActionAuthoritySnapshotV1,
} from '../workflow/action-authority-types.js'

const LAYERS = Object.freeze([
  'platform', 'skill', 'project', 'workflow', 'run',
] as const satisfies readonly WorkflowPermissionLayer[])
const STATUSES = new Set<WorkflowPermissionLayerStatus>([
  'valid', 'missing', 'stale', 'malformed', 'identity-mismatch', 'fingerprint-mismatch',
])
const ACTIONS = new Set<WorkflowAction>(WORKFLOW_ACTIONS)
const PROVENANCE_KIND = Object.freeze({
  platform: 'platform-policy', skill: 'skill-contract', project: 'track-registry',
  workflow: 'workflow-plan', run: 'workflow-run',
} as const)
const TOP_LEVEL_KEYS = new Set([
  'version', 'action', 'workflow_run_id', 'workflow_id', 'workflow_fingerprint',
  'loop_id', 'iteration_id', 'attempt_id', 'reservation_id', 'skill_bundle_id',
  'track_id', 'track_registry_revision', 'layers', 'authorization_fingerprint',
])
const LAYER_KEYS = new Set(['layer', 'status', 'grants', 'provenance'])
const PROVENANCE_KEYS = new Set(['kind', 'identity', 'revision'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} shape must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(value)
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} shape has unknown or missing keys`)
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty`)
  return value
}

function digest(value: unknown, label: string): string {
  const text = nonEmpty(value, label)
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${label} must be a sha256 digest`)
  return text
}

function normalizedGrants(value: unknown, label: string): readonly WorkflowAction[] {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !ACTIONS.has(item as WorkflowAction))
    || new Set(value).size !== value.length) {
    throw new Error(`${label} grants are malformed`)
  }
  const present = new Set(value as WorkflowAction[])
  return Object.freeze(WORKFLOW_ACTIONS.filter((action) => present.has(action)))
}

function fingerprintFor(core: Omit<WorkflowActionAuthoritySnapshotV1, 'authorization_fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(core)).digest('hex')
}

function freezeSnapshot(
  core: Omit<WorkflowActionAuthoritySnapshotV1, 'authorization_fingerprint'>,
  fingerprint: string,
): WorkflowActionAuthoritySnapshotV1 {
  const layers = core.layers.map((layer) => Object.freeze({
    ...layer,
    grants: Object.freeze([...layer.grants]),
    provenance: Object.freeze({ ...layer.provenance }),
  }))
  return Object.freeze({ ...core, layers: Object.freeze(layers), authorization_fingerprint: fingerprint })
}

function validateCrossBindings(snapshot: Omit<WorkflowActionAuthoritySnapshotV1, 'authorization_fingerprint'>): void {
  const byLayer = new Map(snapshot.layers.map((layer) => [layer.layer, layer]))
  const project = byLayer.get('project')?.provenance
  const workflow = byLayer.get('workflow')?.provenance
  const run = byLayer.get('run')?.provenance
  const skill = byLayer.get('skill')?.provenance
  if (project?.identity !== snapshot.track_id || project.revision !== snapshot.track_registry_revision
    || workflow?.identity !== snapshot.workflow_id || workflow.revision !== snapshot.workflow_fingerprint
    || run?.identity !== snapshot.workflow_run_id || run.revision !== snapshot.iteration_id
    || skill?.identity !== snapshot.skill_bundle_id) {
    throw new Error('Workflow action authority provenance identity does not match snapshot binding')
  }
  if (snapshot.iteration_id !== `iteration-${snapshot.attempt_id}`) {
    throw new Error('Workflow action authority iteration must identify the exact attempt')
  }
  if (snapshot.layers.some((layer) => layer.status !== 'valid' || !layer.grants.includes(snapshot.action))) {
    throw new Error('Workflow action authority snapshot must describe an effective allowed authorization')
  }
}

function parseCore(value: unknown): Omit<WorkflowActionAuthoritySnapshotV1, 'authorization_fingerprint'> {
  const top = record(value, 'Workflow action authority snapshot')
  exactKeys(top, TOP_LEVEL_KEYS, 'Workflow action authority snapshot')
  if (top.version !== 1 || typeof top.action !== 'string' || !ACTIONS.has(top.action as WorkflowAction)) {
    throw new Error('Workflow action authority snapshot version/action is invalid')
  }
  if (!Array.isArray(top.layers) || top.layers.length !== LAYERS.length) {
    throw new Error('Workflow action authority snapshot must contain exactly five layers')
  }
  const layers = top.layers.map((rawLayer, index): WorkflowActionAuthorityLayerSnapshotV1 => {
    const layer = record(rawLayer, `authority layer ${index}`)
    exactKeys(layer, LAYER_KEYS, `authority layer ${index}`)
    const expectedLayer = LAYERS[index]
    if (expectedLayer === undefined || layer.layer !== expectedLayer || !STATUSES.has(layer.status as WorkflowPermissionLayerStatus)) {
      throw new Error(`authority layer ${index} is not canonical`)
    }
    const provenance = record(layer.provenance, `authority layer ${expectedLayer} provenance`)
    exactKeys(provenance, PROVENANCE_KEYS, `authority layer ${expectedLayer} provenance`)
    if (provenance.kind !== PROVENANCE_KIND[expectedLayer]) {
      throw new Error(`authority layer ${expectedLayer} provenance kind is invalid`)
    }
    const grants = normalizedGrants(layer.grants, `authority layer ${expectedLayer}`)
    if (JSON.stringify(grants) !== JSON.stringify(layer.grants)) {
      throw new Error(`authority layer ${expectedLayer} grants are not normalized`)
    }
    return {
      layer: expectedLayer,
      status: layer.status as WorkflowPermissionLayerStatus,
      grants,
      provenance: {
        kind: provenance.kind as WorkflowActionAuthorityProvenanceKind,
        identity: nonEmpty(provenance.identity, `${expectedLayer} provenance identity`),
        revision: nonEmpty(provenance.revision, `${expectedLayer} provenance revision`),
      },
    }
  })
  const core = {
    version: 1 as const,
    action: top.action as WorkflowAction,
    workflow_run_id: nonEmpty(top.workflow_run_id, 'workflow_run_id'),
    workflow_id: nonEmpty(top.workflow_id, 'workflow_id'),
    workflow_fingerprint: digest(top.workflow_fingerprint, 'workflow_fingerprint'),
    loop_id: nonEmpty(top.loop_id, 'loop_id'),
    iteration_id: nonEmpty(top.iteration_id, 'iteration_id'),
    attempt_id: nonEmpty(top.attempt_id, 'attempt_id'),
    reservation_id: nonEmpty(top.reservation_id, 'reservation_id'),
    skill_bundle_id: nonEmpty(top.skill_bundle_id, 'skill_bundle_id'),
    track_id: nonEmpty(top.track_id, 'track_id'),
    track_registry_revision: nonEmpty(top.track_registry_revision, 'track_registry_revision'),
    layers,
  }
  // 字段名是旧登记表时代留下的持久化名；值是冻结计划指纹的前 16 位十六进制。
  if (!/^[0-9a-f]{16}$/.test(core.track_registry_revision)) {
    throw new Error('track_registry_revision must be a registry digest')
  }
  validateCrossBindings(core)
  return core
}

export function createWorkflowActionAuthoritySnapshot(
  input: CreateWorkflowActionAuthoritySnapshotInput,
): WorkflowActionAuthoritySnapshotV1 {
  const layers = LAYERS.map((layer) => ({
    layer,
    status: input.layers[layer].status,
    grants: normalizedGrants(input.layers[layer].grants, `authority layer ${layer}`),
    provenance: { ...input.provenance[layer] },
  }))
  const raw = {
    version: 1,
    action: input.action,
    workflow_run_id: input.workflowRunId,
    workflow_id: input.workflowId,
    workflow_fingerprint: input.workflowFingerprint,
    loop_id: input.loopId,
    iteration_id: input.iterationId,
    attempt_id: input.attemptId,
    reservation_id: input.reservationId,
    skill_bundle_id: input.skillBundleId,
    track_id: input.trackId,
    track_registry_revision: input.trackRegistryRevision,
    layers,
    authorization_fingerprint: '0'.repeat(64),
  }
  const core = parseCore(raw)
  return freezeSnapshot(core, fingerprintFor(core))
}

export function parseWorkflowActionAuthoritySnapshot(raw: string): WorkflowActionAuthoritySnapshotV1 {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Workflow action authority snapshot is not valid JSON')
  }
  const core = parseCore(value)
  const top = value as Record<string, unknown>
  const observed = digest(top.authorization_fingerprint, 'authorization_fingerprint')
  const expected = fingerprintFor(core)
  if (observed !== expected) throw new Error('Workflow action authority snapshot fingerprint mismatch')
  return freezeSnapshot(core, expected)
}

export function workflowActionAuthoritySnapshotContent(snapshot: WorkflowActionAuthoritySnapshotV1): string {
  const parsed = parseWorkflowActionAuthoritySnapshot(JSON.stringify(snapshot))
  return `${JSON.stringify(parsed)}\n`
}

export function sameWorkflowActionAuthoritySnapshot(
  left: WorkflowActionAuthoritySnapshotV1,
  right: WorkflowActionAuthoritySnapshotV1,
): boolean {
  return workflowActionAuthoritySnapshotContent(left) === workflowActionAuthoritySnapshotContent(right)
}
