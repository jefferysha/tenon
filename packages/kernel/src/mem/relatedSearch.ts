import type { BoundedTextRead, MemFs } from './fs.js'
import { searchMemSessions } from './sessions.js'
import type {
  MemPlatformFilter,
  MemWarning,
  RelatedSessionMatch,
  RelatedSessionSearchResult,
} from './types.js'

export const RELATED_SESSION_SEARCH_BUDGETS = Object.freeze({
  queryMinChars: 2,
  queryMaxChars: 128,
  queryMaxTokens: 8,
  candidates: 100,
  discoveryEntries: 4_096,
  discoveryFiles: 400,
  discoveryDepth: 8,
  discoveryMs: 75,
  results: 8,
  perFileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  excerptChars: 320,
  titleChars: 160,
})

const PLATFORMS = new Set<MemPlatformFilter>(['all', 'claude', 'codex', 'opencode', 'pi'])

export type RelatedSessionSearchInputErrorReason =
  | 'query-length'
  | 'query-token-count'
  | 'invalid-platform'

export class RelatedSessionSearchInputError extends Error {
  constructor(public readonly reason: RelatedSessionSearchInputErrorReason) {
    super(`invalid related-session search input: ${reason}`)
    this.name = 'RelatedSessionSearchInputError'
  }
}

export interface RelatedSessionSearchOptions {
  root: string
  query: string
  platform: MemPlatformFilter
  /**
   * Millisecond clock for the candidate-discovery time budget. Defaults to `Date.now`; tests inject a
   * fake clock so the budget never trips on a loaded machine and only trips when the test says so.
   */
  now?: () => number
}

interface BudgetState {
  bytesRead: number
  warnings: MemWarning[]
  warningCodes: Set<string>
}

function addWarning(state: BudgetState, warning: MemWarning): void {
  if (state.warningCodes.has(warning.code)) return
  state.warningCodes.add(warning.code)
  state.warnings.push(warning)
}

/**
 * Existing adapters consume MemFs.readText. This request-local wrapper redirects every text read through
 * the optional bounded primitive, caches it, and stops issuing reads when the aggregate budget is spent.
 * nodeMemFs always supplies the primitive; the fallback exists only for older injected fakes and is
 * explicitly reported as partial because it cannot prove a read-layer ceiling.
 */
function budgetedFs(
  source: MemFs,
  state: BudgetState,
  platform: MemPlatformFilter,
  now: () => number,
): MemFs {
  const cache = new Map<string, string | undefined>()
  const prefixBytes = new Map<string, Buffer>()
  const sourceBytes = new Map<string, number>()
  const completeSources = new Set<string>()
  const sourceEnv = source.env
  const sourceReadDirBounded = source.readDirBounded
  const discoveryEntryLimits = platform === 'all'
    ? new Map([['claude', 1_366], ['codex', 1_365], ['pi', 1_365]] as const)
    : new Map(
      platform === 'opencode'
        ? []
        : [[platform, RELATED_SESSION_SEARCH_BUDGETS.discoveryEntries]] as const,
    )
  const discoveryEntries = new Map<string, number>()
  const discoveryFileLimits = platform === 'all'
    ? new Map([['claude', 134], ['codex', 133], ['pi', 133]] as const)
    : new Map(
      platform === 'opencode'
        ? []
        : [[platform, RELATED_SESSION_SEARCH_BUDGETS.discoveryFiles]] as const,
    )
  const discoveryFiles = new Map<string, number>()
  const discoveryTimeLimits = platform === 'all'
    ? new Map([['claude', 25], ['codex', 25], ['pi', 25]] as const)
    : new Map(
      platform === 'opencode'
        ? []
        : [[platform, RELATED_SESSION_SEARCH_BUDGETS.discoveryMs]] as const,
    )
  const discoveryDeadlines = new Map<string, number>()

  const boundedRead = (path: string, offset: number, maxBytes: number): BoundedTextRead | undefined => {
    if (offset > 0 && source.readTextRangeBounded) {
      return source.readTextRangeBounded(path, offset, maxBytes)
    }
    if (offset === 0 && source.readTextBounded) return source.readTextBounded(path, maxBytes)
    if (offset > 0) {
      addWarning(state, {
        code: 'bounded-read-unavailable',
        message: 'A session source could not prove a read-layer byte ceiling.',
      })
      return undefined
    }
    const raw = source.readText(path)
    if (raw === undefined) return undefined
    addWarning(state, {
      code: 'bounded-read-unavailable',
      message: 'A session source could not prove a read-layer byte ceiling.',
    })
    const bytes = Buffer.from(raw)
    const selected = bytes.subarray(0, maxBytes)
    return {
      text: selected.toString('utf8'),
      bytesRead: selected.byteLength,
      truncated: selected.byteLength < bytes.byteLength,
    }
  }

  const readWithinBudget = (
    path: string,
    requestedMaxBytes: number,
    reportPerFileTruncation: boolean,
  ): BoundedTextRead | undefined => {
    const existingBytes = prefixBytes.get(path) ?? Buffer.alloc(0)
    const consumed = sourceBytes.get(path) ?? 0
    if (completeSources.has(path) || consumed >= requestedMaxBytes) {
      return {
        text: existingBytes.toString('utf8'),
        bytesRead: consumed,
        truncated: !completeSources.has(path),
        rawBytes: existingBytes,
      }
    }

    const aggregateRemaining = RELATED_SESSION_SEARCH_BUDGETS.totalBytes - state.bytesRead
    if (aggregateRemaining <= 0) {
      addWarning(state, {
        code: 'total-read-budget-exhausted',
        message: 'The total session-read budget was exhausted.',
      })
      return undefined
    }

    const sourceRemaining = RELATED_SESSION_SEARCH_BUDGETS.perFileBytes - consumed
    if (sourceRemaining <= 0) {
      if (reportPerFileTruncation) {
        addWarning(state, {
          code: 'file-read-truncated',
          message: 'At least one session exceeded the per-file read budget.',
        })
      }
      return {
        text: existingBytes.toString('utf8'),
        bytesRead: consumed,
        truncated: true,
        rawBytes: existingBytes,
      }
    }

    const requestedRemaining = requestedMaxBytes - consumed
    const maxBytes = Math.min(requestedRemaining, sourceRemaining, aggregateRemaining)
    const read = boundedRead(path, consumed, maxBytes)
    if (!read) {
      if (source.exists(path)) {
        addWarning(state, {
          code: 'file-read-unavailable',
          message: 'A session source could not be read.',
        })
      }
      return undefined
    }

    const bytesRead = Math.min(maxBytes, Math.max(0, Math.trunc(read.bytesRead)))
    state.bytesRead += bytesRead
    sourceBytes.set(path, consumed + bytesRead)
    const returnedBytes = read.rawBytes === undefined ? Buffer.from(read.text) : Buffer.from(read.rawBytes)
    const nextBytes = returnedBytes.subarray(0, bytesRead)
    const combinedBytes = Buffer.concat([existingBytes, nextBytes])
    const text = combinedBytes.toString('utf8')
    prefixBytes.set(path, combinedBytes)
    const truncated = read.truncated || returnedBytes.byteLength > maxBytes || read.bytesRead > maxBytes
    if (!truncated) completeSources.add(path)

    if (truncated && maxBytes < requestedRemaining && aggregateRemaining <= sourceRemaining) {
      addWarning(state, {
        code: 'total-read-budget-exhausted',
        message: 'The total session-read budget was exhausted.',
      })
    } else if (truncated && reportPerFileTruncation) {
      addWarning(state, {
        code: 'file-read-truncated',
        message: 'At least one session exceeded the per-file read budget.',
      })
    }

    return { text, bytesRead: consumed + bytesRead, truncated, rawBytes: combinedBytes }
  }

  const fromCached = (text: string, maxBytes: number): BoundedTextRead => {
    const bytes = Buffer.from(text)
    const selected = bytes.subarray(0, maxBytes)
    return {
      text: selected.toString('utf8'),
      bytesRead: 0,
      truncated: selected.byteLength < bytes.byteLength,
      rawBytes: selected,
    }
  }

  return {
    home: source.home,
    exists: (path) => source.exists(path),
    readDir: (path) => {
      const checked = source.readDirChecked?.(path)
      if (!checked) return source.readDir(path)
      if (checked.unavailable && source.exists(path)) {
        addWarning(state, {
          code: 'directory-read-unavailable',
          message: 'A session directory could not be read.',
        })
      }
      return checked.entries
    },
    readDirBounded: sourceReadDirBounded
      ? (path, maxEntries, shouldContinue) => {
          const checked = sourceReadDirBounded(path, maxEntries, shouldContinue)
          if (checked.unavailable && source.exists(path)) {
            addWarning(state, {
              code: 'directory-read-unavailable',
              message: 'A session directory could not be read.',
            })
          }
          return checked
        }
      : undefined,
    readText: (path) => {
      if (cache.has(path)) return cache.get(path)

      const read = readWithinBudget(path, RELATED_SESSION_SEARCH_BUDGETS.perFileBytes, true)
      cache.set(path, read?.text)
      return read?.text
    },
    readTextBounded: (path, maxBytes) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined
      if (cache.has(path)) {
        const text = cache.get(path)
        return text === undefined ? undefined : fromCached(text, maxBytes)
      }

      return readWithinBudget(path, maxBytes, false)
    },
    realPath: source.realPath ? (path) => source.realPath?.(path) : undefined,
    enforcePhysicalProjectScope: true,
    mtimeMs: (path) => source.mtimeMs(path),
    env: sourceEnv ? (name) => sourceEnv(name) : undefined,
    contentReadBudget: {
      perSourceBytes: RELATED_SESSION_SEARCH_BUDGETS.perFileBytes,
      remainingBytes: () => RELATED_SESSION_SEARCH_BUDGETS.totalBytes - state.bytesRead,
      consume: (bytes) => {
        const remaining = RELATED_SESSION_SEARCH_BUDGETS.totalBytes - state.bytesRead
        state.bytesRead += Math.min(remaining, Math.max(0, Math.trunc(bytes)))
      },
      noteSourceUnavailable: (source) => addWarning(state, {
        code: `${source}-reader-unavailable`,
        message: `The ${source} session source could not be read.`,
      }),
      noteSourceTruncated: () => addWarning(state, {
        code: 'file-read-truncated',
        message: 'At least one session exceeded the per-file read budget.',
      }),
      noteTotalExhausted: () => addWarning(state, {
        code: 'total-read-budget-exhausted',
        message: 'The total session-read budget was exhausted.',
      }),
      noteProjectScopeUnavailable: () => addWarning(state, {
        code: 'project-scope-unavailable',
        message: 'At least one session cwd could not be resolved inside the physical project scope.',
      }),
      remainingDiscoveryEntries: (source) => (
        (discoveryEntryLimits.get(source) ?? 0) - (discoveryEntries.get(source) ?? 0)
      ),
      consumeDiscoveryEntries: (source, entries) => {
        const used = discoveryEntries.get(source) ?? 0
        const limit = discoveryEntryLimits.get(source) ?? 0
        discoveryEntries.set(source, used + Math.min(
          limit - used,
          Math.max(0, Math.trunc(entries)),
        ))
      },
      remainingDiscoveryFiles: (source) => (
        (discoveryFileLimits.get(source) ?? 0) - (discoveryFiles.get(source) ?? 0)
      ),
      consumeDiscoveryFiles: (source, files) => {
        const used = discoveryFiles.get(source) ?? 0
        const limit = discoveryFileLimits.get(source) ?? 0
        discoveryFiles.set(source, used + Math.min(
          limit - used,
          Math.max(0, Math.trunc(files)),
        ))
      },
      shouldContinueDiscovery: (source) => {
        let deadline = discoveryDeadlines.get(source)
        if (deadline === undefined) {
          deadline = now() + (discoveryTimeLimits.get(source) ?? 0)
          discoveryDeadlines.set(source, deadline)
        }
        return (discoveryEntries.get(source) ?? 0) < (discoveryEntryLimits.get(source) ?? 0)
          && now() <= deadline
      },
      maxDiscoveryDepth: RELATED_SESSION_SEARCH_BUDGETS.discoveryDepth,
      maxDiscoveryFiles: RELATED_SESSION_SEARCH_BUDGETS.discoveryFiles,
      noteDiscoveryTruncated: () => addWarning(state, {
        code: 'candidate-discovery-truncated',
        message: 'Session candidate discovery reached its bounded work limit.',
      }),
    },
  }
}

function validateOptions(options: RelatedSessionSearchOptions): { query: string; platform: MemPlatformFilter } {
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  const queryLength = Array.from(query).length
  if (
    queryLength < RELATED_SESSION_SEARCH_BUDGETS.queryMinChars
    || queryLength > RELATED_SESSION_SEARCH_BUDGETS.queryMaxChars
  ) {
    throw new RelatedSessionSearchInputError('query-length')
  }
  if (query.split(/\s+/).filter(Boolean).length > RELATED_SESSION_SEARCH_BUDGETS.queryMaxTokens) {
    throw new RelatedSessionSearchInputError('query-token-count')
  }
  if (!PLATFORMS.has(options.platform)) {
    throw new RelatedSessionSearchInputError('invalid-platform')
  }
  return { query, platform: options.platform }
}

function boundedDisplayText(raw: string | null | undefined, maxChars: number): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return chars.slice(0, maxChars - 1).join('').trimEnd() + '…'
}

/**
 * Project-scoped, privacy-reduced search for the Dashboard.
 *
 * This is deliberately separate from searchMemSessions so the CLI retains its existing unbounded
 * recall contract. The returned DTO cannot serialize session source paths, cwd, or assistant text.
 */
export function searchRelatedSessions(
  fs: MemFs,
  options: RelatedSessionSearchOptions,
): RelatedSessionSearchResult {
  const { query, platform } = validateOptions(options)
  const state: BudgetState = {
    bytesRead: 0,
    warnings: [],
    warningCodes: new Set(),
  }
  const scopedFs = budgetedFs(fs, state, platform, options.now ?? Date.now)

  const search = searchMemSessions(scopedFs, {
    keyword: query,
    filter: {
      cwd: options.root,
      platform,
      limit: RELATED_SESSION_SEARCH_BUDGETS.candidates,
    },
    includeChildren: true,
    candidateLimit: RELATED_SESSION_SEARCH_BUDGETS.candidates,
    hostSummariesAsAssistant: true,
    excerptChars: RELATED_SESSION_SEARCH_BUDGETS.excerptChars,
  })
  for (const warning of search.warnings) addWarning(state, warning)

  const matches: RelatedSessionMatch[] = []
  for (const match of search.matches) {
    if (match.hit.userCount <= 0) continue
    const userExcerpt = match.hit.excerpts.find((excerpt) => excerpt.role === 'user')
    const excerpt = boundedDisplayText(userExcerpt?.snippet, RELATED_SESSION_SEARCH_BUDGETS.excerptChars)
    if (!excerpt) continue
    const totalTurns = match.hit.totalTurns
    matches.push({
      platform: match.session.platform,
      sessionId: match.session.id,
      title: boundedDisplayText(match.session.title, RELATED_SESSION_SEARCH_BUDGETS.titleChars),
      updatedAt: match.session.updated ?? null,
      score: totalTurns > 0 ? (3 * match.hit.userCount) / totalTurns : 0,
      hitCount: match.hit.userCount,
      excerpt,
      descendantsMerged: match.descendantsMerged,
    })
  }
  matches.sort((a, b) => {
    const relevance = b.score - a.score || b.hitCount - a.hitCount
    if (relevance !== 0) return relevance
    const aUpdated = a.updatedAt ?? ''
    const bUpdated = b.updatedAt ?? ''
    return aUpdated < bUpdated ? 1 : aUpdated > bUpdated ? -1 : 0
  })

  return {
    query,
    platform,
    partial: state.warnings.length > 0,
    warnings: state.warnings,
    matches: matches.slice(0, RELATED_SESSION_SEARCH_BUDGETS.results),
  }
}
