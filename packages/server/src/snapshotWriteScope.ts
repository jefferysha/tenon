/**
 * Which projects a write request can have touched, so the snapshot cache drops only those.
 *
 * A project-scoped write names its project in the query (`?root=`) or in the JSON body (`{ root }`). A request that
 * names none is treated as touching everything: global config, identity and registry writes change inputs of every
 * project, and guessing wrong would serve a stale snapshot. Requests that only compute a preview change nothing.
 */
import type { IncomingMessage } from 'node:http'

const bodyRoots = new WeakMap<IncomingMessage, Set<string>>()

/** POST routes that only compute an answer from the request and write no state. */
const READ_ONLY_WRITES: ReadonlySet<string> = new Set(['/api/router/preview', '/api/loops/scope-preview'])

/**
 * Drop what a write may have touched from the snapshot cache. `before` runs as the request arrives: the body is
 * not read yet, so only a project named in the query can be dropped. `after` runs once the handler settled and
 * knows the body's project too; a write that names none drops every project.
 */
export function dropWrittenProjects(
  cache: { invalidate(roots?: readonly string[]): void },
  req: IncomingMessage,
  path: string,
  when: 'before' | 'after',
): void {
  const scope = writeScopeOf(req, path)
  if (when === 'before' ? scope !== undefined && scope.length > 0 : scope === undefined || scope.length > 0) cache.invalidate(scope)
}

/** Remember the project a parsed JSON body names (called by the body reader). */
export function noteBodyRoot(req: IncomingMessage, body: unknown): void {
  if (typeof body !== 'object' || body === null) return
  const root = Reflect.get(body, 'root')
  if (typeof root !== 'string' || root === '') return
  const known = bodyRoots.get(req) ?? new Set<string>()
  known.add(root)
  bodyRoots.set(req, known)
}

/**
 * The roots a request touched: `[]` for a write that changes nothing, a list when it names its projects, `undefined`
 * when it names none (touches everything).
 */
export function writeScopeOf(req: IncomingMessage, path: string): readonly string[] | undefined {
  if (READ_ONLY_WRITES.has(path)) return []
  const roots = new Set<string>(bodyRoots.get(req) ?? [])
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root')
  if (query !== null && query !== '') roots.add(query)
  return roots.size === 0 ? undefined : [...roots]
}
