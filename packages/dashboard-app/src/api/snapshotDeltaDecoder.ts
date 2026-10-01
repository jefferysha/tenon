import type { ProjectSnapshot, Snapshot } from '../types'
import { decodeProject } from './snapshotDecoder'
import { isRecord, recordOfBooleans, stringArray } from './transport'

/** A `snapshot-delta` frame: the envelope, the registry order, and only the projects whose bytes moved. */
export interface SnapshotDelta {
  readonly envelope: Omit<Snapshot, 'projects'>
  readonly roots: readonly string[]
  readonly projects: readonly ProjectSnapshot[]
}

export function decodeSnapshotDelta(value: unknown): SnapshotDelta | null {
  if (!isRecord(value)
    || typeof value.version !== 'string'
    || typeof value.generated_at !== 'string'
    || !recordOfBooleans(value.capabilities)
    || typeof value.project_count !== 'number'
    || typeof value.change_count !== 'number'
    || !stringArray(value.roots)
    || !Array.isArray(value.projects)) return null
  const projects: ProjectSnapshot[] = []
  for (const project of value.projects) {
    const decoded = decodeProject(project)
    if (!decoded) return null
    projects.push(decoded)
  }
  return {
    envelope: {
      ...(value.snapshot_protocol === 'tenon-snapshot/v2' ? { snapshot_protocol: value.snapshot_protocol } : {}),
      ...(value.view === 'list' ? { view: 'list' as const } : {}),
      version: value.version,
      generated_at: value.generated_at,
      capabilities: value.capabilities,
      project_count: value.project_count,
      change_count: value.change_count,
    },
    roots: value.roots,
    projects,
  }
}

/**
 * The snapshot a delta produces from the one the stream last delivered. Projects the delta does not resend keep their
 * object identity, so views memoized on a project do not recompute. `null` when the delta names a project neither
 * side knows: the stream is out of step and the caller reconnects.
 */
export function applySnapshotDelta(base: Snapshot, delta: SnapshotDelta): Snapshot | null {
  const known = new Map(base.projects.map((project) => [project.root, project]))
  for (const project of delta.projects) known.set(project.root, project)
  const projects: ProjectSnapshot[] = []
  for (const root of delta.roots) {
    const project = known.get(root)
    if (project === undefined) return null
    projects.push(project)
  }
  return { ...delta.envelope, projects }
}
