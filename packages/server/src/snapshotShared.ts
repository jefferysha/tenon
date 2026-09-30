/**
 * The immutable values the snapshot cache hands out, and how they go on the wire: serialized once, tagged with an
 * ETag, compressed once (lazily, only for a caller that accepts gzip) and sent as those same bytes to every reader.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { ArchivedChangeSnapshot, ChangeSnapshot, ListSnapshot, Snapshot } from './types.js'

/** Below this the compression header and CPU cost more than they save. */
const GZIP_MIN_BYTES = 1_024

export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (header === undefined) return false
  const accepted = new Map<string, number>()
  for (const entry of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const [rawName, ...params] = entry.trim().toLowerCase().split(';')
    if (!rawName) continue
    const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
    const parsed = qParam === undefined ? 1 : Number(qParam.slice(2))
    accepted.set(rawName, Number.isFinite(parsed) ? parsed : 0)
  }
  const gzip = accepted.get('gzip')
  return (gzip ?? accepted.get('*') ?? 0) > 0
}

/** Serialized bytes plus their validator; `gzip` is filled the first time a reader that accepts it asks. */
export interface SharedBody {
  readonly body: string
  readonly etag: string
  gzip?: Buffer
}

export function sharedBody(body: string): SharedBody {
  return { body, etag: `"${createHash('sha1').update(body).digest('base64url')}"` }
}

/** The full-tier snapshot (`GET /api/snapshot`, `GET /api/stream`): every change with all its evidence. */
export interface SharedSnapshot extends SharedBody {
  readonly snapshot: Snapshot
  /** The input fingerprint this snapshot was built under (includes the viewer identity). */
  readonly fingerprint: string
}

/** One serialized project of the list tier; a delta frame is the chunks whose digest moved. */
export interface SharedProjectChunk {
  readonly root: string
  readonly json: string
  readonly digest: string
}

/** The list-tier snapshot (`?view=list`): what the Dashboard loads first and keeps current. */
export interface SharedListSnapshot extends SharedBody {
  readonly snapshot: ListSnapshot
  readonly fingerprint: string
  readonly chunks: readonly SharedProjectChunk[]
  /** The bytes every list frame shares: protocol, version, capabilities and counts. */
  readonly envelope: string
}

/** One change with all its evidence (`GET /api/change/:name/snapshot`). */
export interface SharedChange extends SharedBody {
  readonly change: ChangeSnapshot
  readonly archive?: ArchivedChangeSnapshot['archive']
  /** The identity of the inputs this was read from; equals the `rev` the list row carried. */
  readonly rev: string
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false
  const values = (Array.isArray(header) ? header.join(',') : header).split(',').map((value) => value.trim())
  return values.some((value) => value === '*' || value === etag || value === `W/${etag}`)
}

/** A cached-body response: the shared bytes with an ETag, gzip when the caller takes it, or 304 when it already has them. */
export function sendSharedBody(req: IncomingMessage, res: ServerResponse, shared: SharedBody): void {
  if (etagMatches(req.headers['if-none-match'], shared.etag)) {
    res.writeHead(304, { ETag: shared.etag, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' })
    res.end()
    return
  }
  const compress = shared.body.length >= GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])
  if (compress) shared.gzip ??= gzipSync(shared.body)
  const body = compress && shared.gzip !== undefined ? shared.gzip : Buffer.from(shared.body, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ETag: shared.etag,
    Vary: 'Accept-Encoding',
    ...(compress ? { 'Content-Encoding': 'gzip' } : {}),
  })
  res.end(body)
}
