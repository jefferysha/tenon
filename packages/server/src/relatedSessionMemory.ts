import { nodeMemFs, searchRelatedSessions, type MemFs } from '@tenon/kernel'
import type {
  RelatedSessionSearchRequest,
  RelatedSessionSearchResponse,
  RelatedSessionSearchRunner,
} from './types.js'

export function createKernelRelatedSessionSearchRunner(
  memFs: MemFs,
  now: () => number = Date.now,
): RelatedSessionSearchRunner {
  return (request) => {
    const result = searchRelatedSessions(memFs, { ...request, now })
    return {
      protocol: 'tenon-related-session-memory/v1',
      query: result.query,
      platform: result.platform,
      partial: result.partial,
      warnings: result.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
      })),
      matches: result.matches.map((match) => ({
        platform: match.platform,
        session_id: match.sessionId,
        ...(match.title == null ? {} : { title: match.title }),
        ...(match.updatedAt == null ? {} : { updated_at: match.updatedAt }),
        score: match.score,
        hit_count: match.hitCount,
        excerpt: match.excerpt,
        descendants_merged: match.descendantsMerged,
      })),
    }
  }
}

export type RelatedSessionSearchExecution =
  | { ok: true; response: RelatedSessionSearchResponse }
  | { ok: false; reason: 'busy' | 'unavailable' }

export type RelatedSessionSearchExecutor = (
  request: RelatedSessionSearchRequest,
) => Promise<RelatedSessionSearchExecution>

export function createRelatedSessionMemoryServices(options: {
  hostHome: string
  memFs?: MemFs
  runner?: RelatedSessionSearchRunner
  now?: () => number
}): { memFs: MemFs; executor: RelatedSessionSearchExecutor } {
  const memFs = options.memFs ?? nodeMemFs(options.hostHome)
  const runner = options.runner ?? createKernelRelatedSessionSearchRunner(memFs, options.now)
  return { memFs, executor: createRelatedSessionSearchExecutor(runner) }
}

/**
 * A dashboard process deliberately permits one related-memory scan at a time. The gate wraps
 * both synchronous kernel scans and injected asynchronous runners, and always releases after
 * success or failure so a transient adapter error cannot wedge the server.
 */
export function createRelatedSessionSearchExecutor(
  runner: RelatedSessionSearchRunner,
): RelatedSessionSearchExecutor {
  let inFlight = false
  return async (request) => {
    if (inFlight) return { ok: false, reason: 'busy' }
    inFlight = true
    try {
      // The bounded kernel scan is synchronous. Yield once while the gate is held so another
      // request already queued by node:http can observe `busy` before filesystem work begins.
      await new Promise<void>((resolve) => setImmediate(resolve))
      return { ok: true, response: await runner(request) }
    } catch {
      return { ok: false, reason: 'unavailable' }
    } finally {
      // A synchronous filesystem scan blocks node:http from dispatching requests that arrived
      // during the scan. Keep the gate held through one poll opportunity so those queued requests
      // observe `busy`; the first response also waits for this release, so later requests do not
      // receive a false 429 after the completed response is visible.
      await new Promise<void>((resolve) => setImmediate(resolve))
      inFlight = false
    }
  }
}
