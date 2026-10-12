import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildDefinitionCatalog } from './definitionCatalog.js'
import type { PipelineCliRunner } from './operations.js'
import type { WorkflowRootAnchor } from './workflows.js'

export interface DefinitionCatalogRouteDeps {
  readonly workflowRootForRequest: (root: string) =>
    | { readonly ok: true; readonly anchor: WorkflowRootAnchor }
    | { readonly ok: false; readonly code: 403 | 404; readonly error: string }
  readonly hostHome: string
  readonly operationRunner: PipelineCliRunner
  readonly clock: () => string
  readonly pollIntervalMs: number
  readonly heartbeatMs: number
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
}
function streamHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

export async function resolveDefinitionCatalogRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: DefinitionCatalogRouteDeps,
): Promise<boolean> {
  if (path !== '/api/catalog' && path !== '/api/catalog/stream') return false
  const url = new URL(req.url ?? '/', 'http://localhost')
  const root = url.searchParams.get('root') ?? ''
  const checked = deps.workflowRootForRequest(root)
  if (!checked.ok) {
    deps.sendJson(res, checked.code, { ok: false, code: 'CATALOG_ROOT_INVALID', error: checked.error })
    return true
  }
  const anchor = checked.anchor
  const load = (): Promise<Awaited<ReturnType<typeof buildDefinitionCatalog>>> => buildDefinitionCatalog({
    anchor,
    hostHome: deps.hostHome,
    operationRunner: deps.operationRunner,
    generatedAt: deps.clock(),
  })
  if (path === '/api/catalog') {
    try {
      deps.sendJson(res, 200, await load())
    } catch (error) {
      deps.sendJson(res, 503, { ok: false, code: 'CATALOG_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  streamHeaders(res)
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let lastRevision = url.searchParams.get('after_revision') ?? ''
  let lastBeat = Date.now()
  const cleanup = (): void => {
    if (closed) {
      if (timer !== undefined) clearInterval(timer)
      return
    }
    closed = true
    if (timer !== undefined) clearInterval(timer)
  }
  const writeEvent = (event: string, data: unknown): void => {
    if (closed || res.writableEnded) return
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      lastBeat = Date.now()
    } catch {
      cleanup()
    }
  }
  const writeHeartbeat = (): void => {
    if (closed || res.writableEnded) return
    try {
      res.write(': ping\n\n')
      lastBeat = Date.now()
    } catch {
      cleanup()
    }
  }
  // Attach the close listener before the first asynchronous catalog load. A
  // browser can navigate away while the CLI projection is still running; in
  // that case no timer may be left behind and the completed snapshot must not
  // be written to a dead socket.
  req.on('close', cleanup)
  const initial = await load().catch((error: unknown) => {
    writeEvent('error', { code: 'CATALOG_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) })
    return null
  })
  if (initial !== null && !closed) {
    lastRevision = initial.revision
    writeEvent('snapshot', {
      schema_version: 'definition-catalog-event/v1',
      kind: 'snapshot',
      revision: initial.revision,
      fingerprint: initial.fingerprint,
      catalog: initial,
    })
  }
  if (closed) return true
  let loading = false
  timer = setInterval(() => {
    if (loading || closed) return
    loading = true
    void load().then((catalog) => {
      if (catalog.revision === lastRevision) {
        if (Date.now() - lastBeat >= deps.heartbeatMs) {
          writeHeartbeat()
        }
        return
      }
      lastRevision = catalog.revision
      writeEvent('catalog-updated', {
        schema_version: 'definition-catalog-event/v1',
        kind: 'catalog-updated',
        revision: catalog.revision,
        fingerprint: catalog.fingerprint,
        catalog,
      })
    }).catch(() => {
      if (Date.now() - lastBeat >= deps.heartbeatMs) writeHeartbeat()
    }).finally(() => {
      loading = false
    })
  }, deps.pollIntervalMs)
  timer.unref?.()
  return true
}
