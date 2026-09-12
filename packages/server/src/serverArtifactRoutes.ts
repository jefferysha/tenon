import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ArtifactPolicy, ArtifactCatalog, ArtifactEvent, ArtifactReadReceipt, ArtifactVersion } from '@tenon/kernel'
import { lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
interface ArtifactInspection { version: ArtifactVersion; bytes?: Uint8Array; structure?: unknown }
export interface ArtifactService { catalog(id: string, policy?: ArtifactPolicy): Promise<ArtifactCatalog>; inspect(id: string, version: string, options?: { includeContent?: boolean; maxBytes?: number }): Promise<ArtifactInspection>; read(id: string, artifactId: string, version: string, options?: { representation?: ArtifactReadReceipt['representation']; consumer?: ArtifactReadReceipt['consumer']; maxBytes?: number }): Promise<ArtifactInspection>; events(after?: number, limit?: number): Promise<readonly ArtifactEvent[]>; attempts?: (stageId?: string) => Promise<readonly { stageId: string; stageAttemptId: string; startedAt: string }[]>; }
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

const MAX_ENTRIES = 256
const MAX_BYTES = 512 * 1024
const ID_RE = /^[a-zA-Z0-9._:-]{1,160}$/u

export interface ArtifactRouteDeps {
  service?: ArtifactService
  serviceForRoot?: (root: string, anchor: WorkflowRootAnchor) => ArtifactService | undefined | Promise<ArtifactService | undefined>
  workflowRootForRequest: (root: string) => { ok: true; anchor: WorkflowRootAnchor } | { ok: false; code: 403 | 404; error: string }
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
}

function query(req: IncomingMessage): URLSearchParams { return new URL(req.url ?? '/', 'http://localhost').searchParams }
function required(q: URLSearchParams, key: string): string | undefined {
  const v = q.get(key) ?? undefined
  return v && ID_RE.test(v) ? v : undefined
}
function policy(q: URLSearchParams): ArtifactPolicy {
  const max = Number(q.get('maxEntries') ?? '')
  const cursor = q.get('cursor')
  return {
    includeCandidates: q.get('includeCandidates') === 'true',
    includeHistory: q.get('includeHistory') === 'true',
    ...(Number.isSafeInteger(max) && max > 0 ? { maxEntries: Math.min(max, MAX_ENTRIES) } : {}),
    ...(cursor !== null && /^\d{1,12}$/u.test(cursor) ? { cursor } : {}),
    ...(q.get('pinned') === 'true' ? { pinned: true } : {}),
  }
}
function scopedRoot(anchor: WorkflowRootAnchor, change: string | undefined): string {
  if (!change) return anchor.path
  if (!/^[\p{L}\p{N}_-]{1,160}$/u.test(change)) throw new Error('非法 change 参数')
  const candidate = resolve(join(anchor.path, 'openspec', 'changes', change))
  if (!candidate.startsWith(`${anchor.path}${sep}`) || !lstatSync(candidate).isDirectory()) throw new Error('change 不存在')
  return candidate
}

/** Read-only runtime artifact projections. UI reads never create execution receipts. */
export async function resolveArtifactRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: ArtifactRouteDeps): Promise<boolean> {
  if (!path.startsWith('/api/artifacts/')) return false
  const q = query(req)
  const root = q.get('root') ?? ''
  if (!root) { deps.sendJson(res, 400, { ok: false, error: '缺少 root 参数' }); return true }
  const checked = deps.workflowRootForRequest(root)
  if (!checked.ok) { deps.sendJson(res, checked.code, { ok: false, error: checked.error }); return true }
  const change = q.get('change') ?? undefined
  let service: ArtifactService | undefined
  try { service = await (deps.serviceForRoot?.(scopedRoot(checked.anchor, change), checked.anchor) ?? deps.service) } catch (error) { deps.sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) }); return true }
  if (!service) { deps.sendJson(res, 404, { ok: false, error: 'artifact runtime unavailable' }); return true }
  try {
    if (path === '/api/artifacts/catalog') {
      let attempt = required(q, 'stageAttemptId')
      if (!attempt) {
        const stageId = required(q, 'stageId')
        if (stageId && service.attempts) { const rows = await service.attempts(stageId); attempt = [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.stageAttemptId }
      }
      if (!attempt) { deps.sendJson(res, 400, { ok: false, error: '缺少合法 stageAttemptId/stageId' }); return true }
      const catalog = await service.catalog(attempt, policy(q))
      deps.sendJson(res, 200, { ok: true, catalog })
      return true
    }
    if (path === '/api/artifacts/inspect') {
      const artifactId = required(q, 'artifactId'); const version = required(q, 'version')
      if (!artifactId || !version) { deps.sendJson(res, 400, { ok: false, error: '缺少合法 artifactId/version' }); return true }
      const inspection = await service.inspect(artifactId, version, { includeContent: false })
      deps.sendJson(res, 200, { ok: true, inspection })
      return true
    }
    if (path === '/api/artifacts/read') {
      const attempt = required(q, 'stageAttemptId'); const artifactId = required(q, 'artifactId'); const version = required(q, 'version')
      if (!attempt || !artifactId || !version) { deps.sendJson(res, 400, { ok: false, error: '缺少合法 stageAttemptId/artifactId/version' }); return true }
      const max = Number(q.get('maxBytes') ?? '')
      const result = await service.read(attempt, artifactId, version, { representation: 'content', consumer: 'ui', maxBytes: Number.isSafeInteger(max) && max > 0 ? Math.min(max, MAX_BYTES) : MAX_BYTES })
      const bytes = result.bytes instanceof Uint8Array ? Buffer.from(result.bytes).toString('base64') : undefined
      deps.sendJson(res, 200, { ok: true, version: result.version, bytes, encoding: bytes === undefined ? undefined : 'base64' })
      return true
    }
    if (path === '/api/artifacts/events') {
      const after = Number(q.get('after') ?? '0')
      const limit = Number(q.get('limit') ?? '')
      const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_ENTRIES) : MAX_ENTRIES
      const events = (await service.events(Number.isSafeInteger(after) && after >= 0 ? after : 0, boundedLimit)).slice(0, boundedLimit)
      deps.sendJson(res, 200, { ok: true, events })
      return true
    }
    return false
  } catch (error) {
    deps.sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return true
  }
}
