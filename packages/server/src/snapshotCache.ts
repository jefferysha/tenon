import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildSnapshot, computeFingerprint, type SnapshotDeps } from './snapshot.js'
import type { Snapshot } from './types.js'

/** One built snapshot shared by every reader until its input fingerprint changes. */
export interface SharedSnapshot {
  readonly snapshot: Snapshot
  /** Serialized once; `/api/snapshot`, the SSE first frame and broadcasts all send these bytes. */
  readonly body: string
  readonly etag: string
  /** The `computeFingerprint` value this snapshot was built under (includes the viewer identity). */
  readonly fingerprint: string
}

export interface SnapshotCache {
  /** Current snapshot: reused while the fingerprint holds, concurrent callers share one build. */
  current(): Promise<SharedSnapshot>
  /** The input fingerprint; concurrent callers share one computation. */
  fingerprint(): Promise<string>
  /**
   * Drop the cached snapshot and any in-flight build; the next read rebuilds. The server calls this
   * before every non-GET request runs and again once it settles: a server-side write may touch inputs
   * the fingerprint does not cover, and the next read must see its result.
   */
  invalidate(): void
}

export interface SnapshotCacheOptions {
  snapshotDeps: (nowMs?: number) => SnapshotDeps
  build?: (deps: SnapshotDeps) => Promise<Snapshot>
  fingerprint?: (deps: SnapshotDeps, nowMs: number) => Promise<string>
  now?: () => number
  /**
   * Upper bound on reuse. The fingerprint covers state, tasks, documents, tests, archive and git HEAD,
   * but not every input (working-tree deletions, workspace content, workflow files edited outside the
   * server), so a cached snapshot is rebuilt at least this often even when the fingerprint holds.
   */
  maxAgeMs?: number
}

export const SNAPSHOT_CACHE_MAX_AGE_MS = 30_000

function defaultFingerprint(deps: SnapshotDeps, nowMs: number): Promise<string> {
  return computeFingerprint(deps.registry(), nowMs, deps.rootAnchor, deps.readChangesDirectory, deps.viewer)
}

interface Entry { readonly generation: number; readonly seq: number; readonly builtAt: number; readonly value: SharedSnapshot }
interface Pending { readonly generation: number; readonly fingerprint: string; readonly promise: Promise<SharedSnapshot> }

export function createSnapshotCache(options: SnapshotCacheOptions): SnapshotCache {
  const build = options.build ?? buildSnapshot
  const fingerprintOf = options.fingerprint ?? defaultFingerprint
  const now = options.now ?? Date.now
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_CACHE_MAX_AGE_MS
  // A write bumps the generation: builds and fingerprints started before it are never reused after it.
  let generation = 0
  let seq = 0
  let entry: Entry | undefined
  let pending: Pending | undefined
  let fingerprintInFlight: { readonly generation: number; readonly promise: Promise<string> } | undefined

  function fingerprint(): Promise<string> {
    if (fingerprintInFlight !== undefined && fingerprintInFlight.generation === generation) return fingerprintInFlight.promise
    const nowMs = now()
    const promise = fingerprintOf(options.snapshotDeps(nowMs), nowMs)
    const flight = { generation, promise }
    fingerprintInFlight = flight
    const clear = (): void => { if (fingerprintInFlight === flight) fingerprintInFlight = undefined }
    promise.then(clear, clear)
    return promise
  }

  function share(snapshot: Snapshot, fp: string): SharedSnapshot {
    const body = JSON.stringify(snapshot)
    return { snapshot, body, etag: `"${createHash('sha1').update(body).digest('base64url')}"`, fingerprint: fp }
  }

  async function current(): Promise<SharedSnapshot> {
    let fp: string
    try {
      fp = await fingerprint()
    } catch {
      // Without a fingerprint nothing proves a cached snapshot is current: build fresh, keep nothing.
      return share(await build(options.snapshotDeps(now())), '')
    }
    const cached = entry
    if (cached !== undefined && cached.generation === generation && cached.value.fingerprint === fp
      && now() - cached.builtAt < maxAgeMs) {
      return cached.value
    }
    if (pending !== undefined && pending.generation === generation && pending.fingerprint === fp) return pending.promise
    const startedGeneration = generation
    const startedSeq = ++seq
    const nowMs = now()
    const promise = build(options.snapshotDeps(nowMs)).then((snapshot): SharedSnapshot => {
      const value = share(snapshot, fp)
      // An older build finishing late never replaces a newer one, and nothing built before a write is kept.
      if (startedGeneration === generation && (entry === undefined || entry.seq < startedSeq)) {
        entry = { generation: startedGeneration, seq: startedSeq, builtAt: nowMs, value }
      }
      return value
    })
    const flight: Pending = { generation: startedGeneration, fingerprint: fp, promise }
    pending = flight
    const clear = (): void => { if (pending === flight) pending = undefined }
    promise.then(clear, clear)
    return promise
  }

  return {
    current,
    fingerprint,
    invalidate(): void {
      generation += 1
      entry = undefined
      pending = undefined
      fingerprintInFlight = undefined
    },
  }
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false
  const values = (Array.isArray(header) ? header.join(',') : header).split(',').map((value) => value.trim())
  return values.some((value) => value === '*' || value === etag || value === `W/${etag}`)
}

/** `GET /api/snapshot` response: the shared bytes with an ETag, or 304 when the client already has them. */
export function sendSharedSnapshot(req: IncomingMessage, res: ServerResponse, shared: SharedSnapshot): void {
  if (etagMatches(req.headers['if-none-match'], shared.etag)) {
    res.writeHead(304, { ETag: shared.etag, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  const body = Buffer.from(shared.body, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ETag: shared.etag,
  })
  res.end(body)
}
