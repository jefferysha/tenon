/**
 * Project builds → the aggregate a reader receives. A list aggregate is an envelope plus each project's own
 * serialized bytes, so a project that did not rebuild contributes the string it contributed last time.
 */
import { createHash } from 'node:crypto'
import { snapshotEnvelope, type SnapshotDeps } from './snapshot.js'
import {
  sharedBody, type SharedListSnapshot, type SharedProjectChunk, type SharedSnapshot,
} from './snapshotShared.js'
import type { ListSnapshot, ProjectListSnapshot } from './snapshotListTypes.js'
import { encodeListProject } from './snapshotWire.js'
import type { ProjectSnapshot, Snapshot } from './types.js'

/** What one project's scan produced under one fingerprint. */
export interface Built<P> {
  readonly seq: number
  readonly key: string
  readonly builtAt: number
  readonly project: P
  readonly revs: ReadonlyMap<string, string>
  /** List tier only: the serialized project, valid for the repository label it was written with. */
  chunk?: { readonly label: string | undefined; readonly value: SharedProjectChunk }
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** Identifies an assembly: the same builds under the same fingerprint and labels assemble to the same bytes. */
export function assemblySignature(
  fingerprint: string,
  builts: readonly Built<unknown>[],
  projects: readonly { readonly repository?: { readonly label: string } }[],
): string {
  return `${fingerprint}\u0000${builts.map((built, index) => `${built.seq}:${projects[index]?.repository?.label ?? ''}`).join('|')}`
}

function listChunk(built: Built<ProjectListSnapshot>, project: ProjectListSnapshot): SharedProjectChunk {
  const label = project.repository?.label
  if (built.chunk !== undefined && built.chunk.label === label) return built.chunk.value
  const json = encodeListProject(project, built.revs)
  const value = { root: project.root, json, digest: digest(json) }
  built.chunk = { label, value }
  return value
}

/** `projects` are the builds' projects after the cross-project repository-label normalisation. */
export function assembleList(
  builts: readonly Built<ProjectListSnapshot>[],
  projects: ProjectListSnapshot[],
  fingerprint: string,
  deps: Pick<SnapshotDeps, 'version' | 'clock' | 'capabilities'>,
): SharedListSnapshot {
  const chunks = builts.map((built, index) => listChunk(built, projects[index] ?? built.project))
  const snapshot: ListSnapshot = { ...snapshotEnvelope(deps, projects), view: 'list', projects }
  const { projects: _projects, ...head } = snapshot
  const envelope = JSON.stringify(head)
  const body = `${envelope.slice(0, -1)},"projects":[${chunks.map((chunk) => chunk.json).join(',')}]}`
  return { ...sharedBody(body), snapshot, fingerprint, chunks, envelope }
}

export function assembleFull(
  projects: ProjectSnapshot[],
  fingerprint: string,
  deps: Pick<SnapshotDeps, 'version' | 'clock' | 'capabilities'>,
): SharedSnapshot {
  const snapshot: Snapshot = { ...snapshotEnvelope(deps, projects), projects }
  return { ...sharedBody(JSON.stringify(snapshot)), snapshot, fingerprint }
}
