/**
 * The Dashboard's snapshot state, cached per project instead of as one monolith.
 *
 * Each registered project owns a cell holding what was built from it, keyed by the project's own input fingerprint:
 *   list    the rows every view renders (`?view=list`), already serialized for the wire
 *   full    every change with all its evidence (`GET /api/snapshot` without a view), built only when asked for
 *   details one change with all its evidence (`GET /api/change/:name/snapshot`), keyed by that change's `rev`
 * A project whose fingerprint did not move is not rebuilt; a write invalidates only the projects it names. The
 * aggregate a reader receives is assembled from the cells, so one changed project costs one project's scan plus a
 * string join, not a rebuild of every registered project.
 *
 * Inputs the fingerprint does not cover (working-tree content, workflow files edited elsewhere, history) are caught
 * by an age limit: a cell older than `maxAgeMs` is rebuilt when read. At most MAX_AGE_REFRESH_PER_READ aged cells are
 * refreshed per read, oldest first, so the cells built together at start-up do not all expire into one huge rebuild.
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { TenonUserResolution } from '@tenon/kernel'
import { mapWithConcurrency } from './concurrentMap.js'
import { dedupeRoots } from './projectRoots.js'
import { normalizeRepositoryLabels } from './repositoryIdentity.js'
import { defaultResolveUser } from './serverUserRoutes.js'
import {
  readTerminalActivity, scanChangeDetail, scanProject, snapshotEnvelope, type SnapshotDeps,
} from './snapshot.js'
import { computeRootFingerprints, type RootFingerprint } from './snapshotFingerprint.js'
import type { ScannedChange } from './snapshotProjectScan.js'
import {
  sendSharedBody, sharedBody, type SharedChange, type SharedListSnapshot, type SharedProjectChunk, type SharedSnapshot,
} from './snapshotShared.js'
import { encodeListProject } from './snapshotWire.js'
import type { ListSnapshot, ProjectListSnapshot, ProjectSnapshot, Snapshot } from './types.js'

export type { SharedChange, SharedListSnapshot, SharedProjectChunk, SharedSnapshot } from './snapshotShared.js'
export { sendSharedBody as sendSharedSnapshot } from './snapshotShared.js'

export interface SnapshotCache {
  /** The list tier of every registered project: what the Dashboard renders. */
  list(): Promise<SharedListSnapshot>
  /** The full tier: every change with all its evidence (the documented `GET /api/snapshot`). */
  full(): Promise<SharedSnapshot>
  /** One change with all its evidence; `null` when the project is not registered or holds no readable change of that name. */
  detail(root: string, name: string): Promise<SharedChange | null>
  /** The input fingerprint of every registered project; concurrent callers share one computation. */
  fingerprint(): Promise<string>
  /**
   * Drop what was built for `roots` (every project when omitted), any in-flight build of it and the remembered
   * identities; the next read rebuilds only those. The server calls this once a write settles: the write may have
   * touched inputs the fingerprint does not cover (or the declared identity), and the next read must see its result.
   */
  invalidate(roots?: readonly string[]): void
}

export interface SnapshotCacheOptions {
  snapshotDeps: (nowMs?: number) => SnapshotDeps
  /** @internal test seams: replace the per-project builders and the fingerprint computation. */
  scanners?: Partial<ProjectScanners>
  fingerprints?: (deps: SnapshotDeps, nowMs: number, roots: readonly string[]) => Promise<RootFingerprint[]>
  now?: () => number
  /** Upper bound on reuse of one project's list / full build (see the file header). */
  maxAgeMs?: number
  /**
   * How long a root's resolved viewer / acting user is reused. Resolution may run `git config`
   * synchronously twice per root, which dominated the fingerprint (about 700 ms for 34 roots) and
   * blocked the event loop on every one-second poll.
   */
  identityTtlMs?: number
}

/** What the cache builds from: one project per tier, one change with its evidence. */
export interface ProjectScanners {
  list(deps: SnapshotDeps, root: string, nowMs: number): Promise<ProjectListSnapshot>
  full(deps: SnapshotDeps, root: string, nowMs: number): Promise<ProjectSnapshot>
  detail(deps: SnapshotDeps, root: string, name: string, nowMs: number): Promise<ScannedChange | undefined>
}

const PRODUCTION_SCANNERS: ProjectScanners = {
  list: (deps, root, nowMs) => scanProject(deps, root, nowMs, 'list'),
  full: (deps, root, nowMs) => scanProject(deps, root, nowMs, 'full'),
  detail: (deps, root, name, nowMs) => scanChangeDetail(deps, root, name, nowMs),
}

export const SNAPSHOT_CACHE_MAX_AGE_MS = 30_000
export const SNAPSHOT_IDENTITY_TTL_MS = 30_000
/** Aged-out cells refreshed by one read. */
export const MAX_AGE_REFRESH_PER_READ = 4
/** Projects built at once on a cold or partially invalidated cache. */
const BUILD_CONCURRENCY = 4
/** Detail entries kept per project, least recently built first out. */
const MAX_DETAILS_PER_PROJECT = 64

interface Built<P> {
  readonly seq: number
  readonly key: string
  readonly builtAt: number
  readonly project: P
  readonly revs: ReadonlyMap<string, string>
  /** List tier only: the serialized project, valid for the repository label it was written with. */
  chunk?: { readonly label: string | undefined; readonly value: SharedProjectChunk }
}
interface Flight<T> { readonly key: string; readonly promise: Promise<T> }
interface Slot<P> { built?: Built<P>; flight?: Flight<Built<P>> }
interface DetailEntry { readonly builtAt: number; readonly rev: string; readonly shared: SharedChange | null }
interface Cell {
  readonly root: string
  /** The epoch of the latest invalidation that named this project; a build that started before it is never stored. */
  validFrom: number
  list: Slot<ProjectListSnapshot>
  full: Slot<ProjectSnapshot>
  details: Map<string, DetailEntry>
  detailFlights: Map<string, Flight<SharedChange | null>>
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

export function createSnapshotCache(options: SnapshotCacheOptions): SnapshotCache {
  const scanners: ProjectScanners = { ...PRODUCTION_SCANNERS, ...options.scanners }
  const now = options.now ?? Date.now
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_CACHE_MAX_AGE_MS
  const identityTtlMs = options.identityTtlMs ?? SNAPSHOT_IDENTITY_TTL_MS
  const fingerprintOf = options.fingerprints ?? ((deps: SnapshotDeps, nowMs: number, roots: readonly string[]) => computeRootFingerprints(
    roots, nowMs, deps.rootAnchor, readTerminalActivity, deps.readChangesDirectory, deps.viewer,
  ))
  // Every invalidation advances the epoch. A build remembers the epoch it started in and is only stored when no
  // invalidation named its project afterwards, so nothing built before a write is kept after it.
  let epoch = 0
  let seq = 0
  const cells = new Map<string, Cell>()
  let fingerprintFlight: { readonly epoch: number; readonly promise: Promise<RootFingerprint[]> } | undefined
  let listAssembly: { readonly signature: string; readonly value: SharedListSnapshot } | undefined
  let fullAssembly: { readonly signature: string; readonly value: SharedSnapshot } | undefined
  const identities = new Map<string, { readonly at: number; readonly value: TenonUserResolution }>()

  function remembered(role: 'viewer' | 'acting', resolveIdentity: (root: string) => TenonUserResolution) {
    return (root: string): TenonUserResolution => {
      const key = `${role}\u0000${resolve(root)}`
      const at = now()
      const hit = identities.get(key)
      if (hit !== undefined && at - hit.at < identityTtlMs) return hit.value
      const value = resolveIdentity(root)
      identities.set(key, { at, value })
      return value
    }
  }

  function depsAt(nowMs: number): SnapshotDeps {
    const deps = options.snapshotDeps(nowMs)
    return {
      ...deps,
      ...(deps.viewer === undefined ? {} : { viewer: remembered('viewer', deps.viewer) }),
      resolveUser: remembered('acting', deps.resolveUser ?? defaultResolveUser),
    }
  }

  function fingerprints(): Promise<RootFingerprint[]> {
    if (fingerprintFlight !== undefined && fingerprintFlight.epoch === epoch) return fingerprintFlight.promise
    const nowMs = now()
    const deps = depsAt(nowMs)
    const promise = fingerprintOf(deps, nowMs, deps.registry())
    const flight = { epoch, promise }
    fingerprintFlight = flight
    const clear = (): void => { if (fingerprintFlight === flight) fingerprintFlight = undefined }
    promise.then(clear, clear)
    return promise
  }

  function cellFor(root: string): Cell {
    let cell = cells.get(root)
    if (cell === undefined) {
      cell = { root, validFrom: 0, list: {}, full: {}, details: new Map(), detailFlights: new Map() }
      cells.set(root, cell)
    }
    return cell
  }

  /** Forget cells of projects that are no longer registered. */
  function retain(fps: readonly RootFingerprint[]): void {
    const live = new Set(fps.map((fp) => fp.root))
    for (const root of cells.keys()) if (!live.has(root)) cells.delete(root)
  }

  /** The slot's build for this fingerprint: the stored one, the one in flight, or a new one. */
  function ensure<P>(
    cell: Cell,
    slot: Slot<P>,
    fp: RootFingerprint,
    build: (deps: SnapshotDeps, nowMs: number) => Promise<P>,
    refreshAged: boolean,
  ): Promise<Built<P>> {
    const stored = slot.built
    if (stored !== undefined && stored.key === fp.key && (!refreshAged || now() - stored.builtAt < maxAgeMs)) {
      return Promise.resolve(stored)
    }
    if (slot.flight !== undefined && slot.flight.key === fp.key) return slot.flight.promise
    const startedEpoch = epoch
    const mine = ++seq
    const nowMs = now()
    const promise = build(depsAt(nowMs), nowMs).then((project): Built<P> => {
      const built: Built<P> = { seq: mine, key: fp.key, builtAt: nowMs, project, revs: fp.revs }
      // An older build finishing late never replaces a newer one, and nothing built before a write is kept.
      if (cells.get(cell.root) === cell && startedEpoch >= cell.validFrom && (slot.built === undefined || slot.built.seq < mine)) {
        slot.built = built
      }
      return built
    })
    const flight = { key: fp.key, promise }
    slot.flight = flight
    const clear = (): void => { if (slot.flight === flight) slot.flight = undefined }
    promise.then(clear, clear)
    return promise
  }

  /** The aged cells allowed a refresh in this read: the oldest MAX_AGE_REFRESH_PER_READ of them. */
  function agedRoots<P>(fps: readonly RootFingerprint[], slotOf: (cell: Cell) => Slot<P>): ReadonlySet<string> {
    const aged = fps
      .map((fp) => ({ root: fp.root, built: slotOf(cellFor(fp.root)).built, key: fp.key }))
      .filter((item) => item.built !== undefined && item.built.key === item.key && now() - item.built.builtAt >= maxAgeMs)
      .sort((left, right) => (left.built?.builtAt ?? 0) - (right.built?.builtAt ?? 0))
    return new Set(aged.slice(0, MAX_AGE_REFRESH_PER_READ).map((item) => item.root))
  }

  async function buildAll<P>(
    fps: readonly RootFingerprint[],
    slotOf: (cell: Cell) => Slot<P>,
    build: (deps: SnapshotDeps, nowMs: number, root: string) => Promise<P>,
  ): Promise<Built<P>[]> {
    const refresh = agedRoots(fps, slotOf)
    return mapWithConcurrency(fps, BUILD_CONCURRENCY, (fp) => ensure(
      cellFor(fp.root), slotOf(cellFor(fp.root)), fp, (deps, nowMs) => build(deps, nowMs, fp.root), refresh.has(fp.root),
    ))
  }

  /** Projects of a cache that cannot fingerprint: nothing proves a stored build is current, so build fresh and keep nothing. */
  async function buildUncached<P>(build: (deps: SnapshotDeps, nowMs: number, root: string) => Promise<P>): Promise<Built<P>[]> {
    const nowMs = now()
    const deps = depsAt(nowMs)
    return mapWithConcurrency(dedupeRoots(deps.registry()), BUILD_CONCURRENCY, async (root) => ({
      seq: ++seq, key: '', builtAt: nowMs, project: await build(depsAt(nowMs), nowMs, root), revs: new Map<string, string>(),
    }))
  }

  function listChunk(built: Built<ProjectListSnapshot>, project: ProjectListSnapshot): SharedProjectChunk {
    const label = project.repository?.label
    if (built.chunk !== undefined && built.chunk.label === label) return built.chunk.value
    const json = encodeListProject(project, built.revs)
    const value = { root: project.root, json, digest: digest(json) }
    built.chunk = { label, value }
    return value
  }

  function assembleList(builts: readonly Built<ProjectListSnapshot>[], fingerprint: string): SharedListSnapshot {
    const projects = normalizeRepositoryLabels(builts.map((built) => built.project))
    const signature = `${fingerprint}\u0000${builts.map((built, index) => `${built.seq}:${projects[index]?.repository?.label ?? ''}`).join('|')}`
    if (fingerprint !== '' && listAssembly?.signature === signature) return listAssembly.value
    const chunks = builts.map((built, index) => listChunk(built, projects[index] ?? built.project))
    const deps = depsAt(now())
    const snapshot: ListSnapshot = { ...snapshotEnvelope(deps, projects), view: 'list', projects }
    const { projects: _projects, ...head } = snapshot
    const envelope = JSON.stringify(head)
    const body = `${envelope.slice(0, -1)},"projects":[${chunks.map((chunk) => chunk.json).join(',')}]}`
    const value: SharedListSnapshot = { ...sharedBody(body), snapshot, fingerprint, chunks, envelope }
    if (fingerprint !== '') listAssembly = { signature, value }
    return value
  }

  function assembleFull(builts: readonly Built<ProjectSnapshot>[], fingerprint: string): SharedSnapshot {
    const projects = normalizeRepositoryLabels(builts.map((built) => built.project))
    const signature = `${fingerprint}\u0000${builts.map((built, index) => `${built.seq}:${projects[index]?.repository?.label ?? ''}`).join('|')}`
    if (fingerprint !== '' && fullAssembly?.signature === signature) return fullAssembly.value
    const snapshot: Snapshot = { ...snapshotEnvelope(depsAt(now()), projects), projects }
    const value: SharedSnapshot = { ...sharedBody(JSON.stringify(snapshot)), snapshot, fingerprint }
    if (fingerprint !== '') fullAssembly = { signature, value }
    return value
  }

  const joined = (fps: readonly RootFingerprint[]): string => fps.map((fp) => `${fp.root}:${fp.key}`).join('|')

  async function tryFingerprints(): Promise<RootFingerprint[] | undefined> {
    try {
      const fps = await fingerprints()
      retain(fps)
      return fps
    } catch {
      return undefined
    }
  }

  async function list(): Promise<SharedListSnapshot> {
    const fps = await tryFingerprints()
    if (fps === undefined) return assembleList(await buildUncached((deps, nowMs, root) => scanners.list(deps, root, nowMs)), '')
    const builts = await buildAll(fps, (cell) => cell.list, (deps, nowMs, root) => scanners.list(deps, root, nowMs))
    return assembleList(builts, joined(fps))
  }

  async function full(): Promise<SharedSnapshot> {
    const fps = await tryFingerprints()
    if (fps === undefined) return assembleFull(await buildUncached((deps, nowMs, root) => scanners.full(deps, root, nowMs)), '')
    const builts = await buildAll(fps, (cell) => cell.full, (deps, nowMs, root) => scanners.full(deps, root, nowMs))
    return assembleFull(builts, joined(fps))
  }

  function buildDetail(cell: Cell, root: string, name: string, rev: string): Promise<SharedChange | null> {
    const flightKey = `${name}\u0000${rev}`
    const known = cell.detailFlights.get(name)
    if (known !== undefined && known.key === flightKey) return known.promise
    const startedEpoch = epoch
    const nowMs = now()
    const promise = scanners.detail(depsAt(nowMs), root, name, nowMs).then((scanned): SharedChange | null => {
      const shared: SharedChange | null = scanned === undefined
        ? null
        : {
            ...sharedBody(JSON.stringify({ ...scanned.change, rev, ...(scanned.archive === undefined ? {} : { archive: scanned.archive }) })),
            change: { ...scanned.change, rev },
            ...(scanned.archive === undefined ? {} : { archive: scanned.archive }),
            rev,
          }
      if (cells.get(root) === cell && startedEpoch >= cell.validFrom) {
        cell.details.delete(name)
        cell.details.set(name, { builtAt: nowMs, rev, shared })
        while (cell.details.size > MAX_DETAILS_PER_PROJECT) {
          const oldest = cell.details.keys().next().value
          if (oldest === undefined) break
          cell.details.delete(oldest)
        }
      }
      return shared
    })
    const flight = { key: flightKey, promise }
    cell.detailFlights.set(name, flight)
    const clear = (): void => { if (cell.detailFlights.get(name) === flight) cell.detailFlights.delete(name) }
    promise.then(clear, clear)
    return promise
  }

  async function detail(root: string, name: string): Promise<SharedChange | null> {
    const normalized = resolve(root)
    const nowMs = now()
    const deps = depsAt(nowMs)
    let fp: RootFingerprint | undefined
    try {
      fp = (await fingerprintOf(deps, nowMs, [normalized]))[0]
    } catch {
      fp = undefined
    }
    const rev = fp?.revs.get(name)
    if (rev === undefined) return null
    const cell = cellFor(normalized)
    const stored = cell.details.get(name)
    if (stored !== undefined && stored.rev === rev && now() - stored.builtAt < maxAgeMs) return stored.shared
    return buildDetail(cell, normalized, name, rev)
  }

  return {
    list,
    full,
    detail,
    async fingerprint(): Promise<string> {
      return joined(await fingerprints())
    },
    invalidate(roots?: readonly string[]): void {
      epoch += 1
      fingerprintFlight = undefined
      listAssembly = undefined
      fullAssembly = undefined
      if (roots === undefined) {
        cells.clear()
        identities.clear()
        return
      }
      for (const root of roots) {
        const normalized = resolve(root)
        const cell = cells.get(normalized)
        if (cell !== undefined) {
          cell.validFrom = epoch
          cell.list = {}
          cell.full = {}
          cell.details.clear()
          cell.detailFlights.clear()
        }
        for (const role of ['viewer', 'acting']) identities.delete(`${role}\u0000${normalized}`)
      }
    },
  }
}

