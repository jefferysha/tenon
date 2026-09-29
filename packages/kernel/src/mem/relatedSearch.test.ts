import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  MEM_SESSION_METADATA_BYTES,
  nodeMemFs,
  type BoundedTextRead,
  type MemDirent,
  type MemFs,
} from './fs.js'
import {
  RELATED_SESSION_SEARCH_BUDGETS,
  RelatedSessionSearchInputError,
  searchRelatedSessions as searchRelatedSessionsWithClock,
  type RelatedSessionSearchOptions,
} from './relatedSearch.js'

/** Frozen discovery clock: the 75 ms budget trips only when a test injects a moving clock. */
const FROZEN_CLOCK = (): number => 0

function searchRelatedSessions(fs: MemFs, options: RelatedSessionSearchOptions) {
  return searchRelatedSessionsWithClock(fs, { now: FROZEN_CLOCK, ...options })
}

const PROJECT = '/home/u/work/proj'

function codexFile(id: string): string {
  return `/home/u/.codex/sessions/2026/07/rollout-2026-07-28T12-00-00-${id}.jsonl`
}

function claudeFile(id: string): string {
  return `/home/u/.claude/projects/-home-u-work-proj/${id}.jsonl`
}

function piFile(id: string): string {
  return `/home/u/custom-pi-sessions/${id}.jsonl`
}

function codexSession(
  id: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  cwd = PROJECT,
): string {
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-28T12:00:00Z',
      payload: { id, cwd },
    }),
  ]
  for (const turn of turns) {
    lines.push(JSON.stringify({
      payload: {
        type: 'message',
        role: turn.role,
        content: [{
          type: turn.role === 'user' ? 'input_text' : 'output_text',
          text: turn.text,
        }],
      },
    }))
  }
  return lines.join('\n')
}

function claudeSession(id: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    cwd: PROJECT,
    sessionId: id,
    timestamp: '2026-07-28T12:00:00Z',
  })
}

function piSession(id: string, cwd: string, text: string): string {
  return [
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-07-28T12:00:00Z' }),
    JSON.stringify({
      type: 'message',
      id: `${id}-message`,
      message: { role: 'user', content: text, timestamp: '2026-07-28T12:00:01Z' },
    }),
  ].join('\n')
}

function boundedFakeFs(
  files: Record<string, string>,
  options: {
    mtimes?: Record<string, number>
    onRead?: (path: string, maxBytes: number) => void
    onRangeRead?: (path: string, offset: number, maxBytes: number) => void
    env?: Record<string, string>
    unreadableDirs?: ReadonlySet<string>
  } = {},
): MemFs {
  const fileSet = new Set(Object.keys(files))
  const dirs = new Set<string>()
  for (const p of fileSet) {
    let d = dirname(p)
    while (d && !dirs.has(d)) {
      dirs.add(d)
      const parent = dirname(d)
      if (parent === d) break
      d = parent
    }
  }
  return {
    home: '/home/u',
    exists: (p) => fileSet.has(p) || dirs.has(p),
    readDir: (p) => {
      if (options.unreadableDirs?.has(p)) return []
      const out: MemDirent[] = []
      for (const f of fileSet) {
        if (dirname(f) === p) out.push({ name: basename(f), isFile: true, isDirectory: false })
      }
      for (const d of dirs) {
        if (dirname(d) === p && d !== p) out.push({ name: basename(d), isFile: false, isDirectory: true })
      }
      return out
    },
    readDirChecked: (p) => {
      const entries: MemDirent[] = []
      if (!options.unreadableDirs?.has(p)) {
        for (const file of fileSet) {
          if (dirname(file) === p) entries.push({ name: basename(file), isFile: true, isDirectory: false })
        }
        for (const directory of dirs) {
          if (dirname(directory) === p && directory !== p) {
            entries.push({ name: basename(directory), isFile: false, isDirectory: true })
          }
        }
      }
      return {
        entries,
        unavailable: options.unreadableDirs?.has(p) ?? false,
      }
    },
    readDirBounded: (p, maxEntries) => {
      const checked = options.unreadableDirs?.has(p)
        ? { entries: [] as MemDirent[], unavailable: true }
        : (() => {
            const entries: MemDirent[] = []
            for (const file of fileSet) {
              if (dirname(file) === p) entries.push({ name: basename(file), isFile: true, isDirectory: false })
            }
            for (const directory of dirs) {
              if (dirname(directory) === p && directory !== p) {
                entries.push({ name: basename(directory), isFile: false, isDirectory: true })
              }
            }
            return { entries, unavailable: false }
          })()
      return {
        entries: checked.entries.slice(0, maxEntries),
        unavailable: checked.unavailable,
        truncated: checked.entries.length > maxEntries,
      }
    },
    readText: () => {
      throw new Error('related search must not call the unbounded read primitive')
    },
    readTextBounded: (p, maxBytes): BoundedTextRead | undefined => {
      options.onRead?.(p, maxBytes)
      const raw = files[p]
      if (raw === undefined) return undefined
      const bytes = Buffer.from(raw)
      const selected = bytes.subarray(0, maxBytes)
      return {
        text: selected.toString('utf8'),
        bytesRead: selected.byteLength,
        truncated: bytes.byteLength > selected.byteLength,
        rawBytes: selected,
      }
    },
    readTextRangeBounded: (p, offset, maxBytes): BoundedTextRead | undefined => {
      options.onRangeRead?.(p, offset, maxBytes)
      const raw = files[p]
      if (raw === undefined) return undefined
      const bytes = Buffer.from(raw)
      const selected = bytes.subarray(offset, offset + maxBytes)
      return {
        text: selected.toString('utf8'),
        bytesRead: selected.byteLength,
        truncated: bytes.byteLength > offset + selected.byteLength,
        rawBytes: selected,
      }
    },
    realPath: (p) => p,
    mtimeMs: (p) => options.mtimes?.[p] ?? (fileSet.has(p) ? Date.parse('2026-07-28T12:00:00Z') : undefined),
    env: (name) => options.env?.[name],
  }
}

describe('searchRelatedSessions input contract', () => {
  test.each([
    ['a', 'query-length'],
    ['x'.repeat(129), 'query-length'],
    ['one two three four five six seven eight nine', 'query-token-count'],
  ])('rejects invalid query %j with stable reason %s', (query, reason) => {
    expect(() => searchRelatedSessions(boundedFakeFs({}), {
      root: PROJECT,
      query,
      platform: 'codex',
    })).toThrowError(expect.objectContaining<Partial<RelatedSessionSearchInputError>>({ reason }))
  })

  test('rejects a runtime platform outside the explicit closed set before any adapter reads', () => {
    let reads = 0
    expect(() => searchRelatedSessions(boundedFakeFs({}, { onRead: () => { reads += 1 } }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'unknown' as 'codex',
    })).toThrowError(expect.objectContaining<Partial<RelatedSessionSearchInputError>>({
      reason: 'invalid-platform',
    }))
    expect(reads).toBe(0)
  })
})

describe('searchRelatedSessions bounded privacy contract', () => {
  test('admits a session cwd through a symlinked ancestor when its physical path is inside the root', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'tenon-related-physical-inside-'))
    try {
      const home = join(fixture, 'home')
      const physicalParent = join(fixture, 'physical')
      const project = join(physicalParent, 'project')
      const aliasParent = join(fixture, 'alias-parent')
      const lexicalProject = join(aliasParent, 'project')
      const sessionPath = join(
        home,
        '.codex',
        'sessions',
        '2026',
        '07',
        'rollout-2026-07-28T12-00-00-physical-inside.jsonl',
      )
      await mkdir(project, { recursive: true })
      await mkdir(dirname(sessionPath), { recursive: true })
      await symlink(physicalParent, aliasParent, 'dir')
      await writeFile(sessionPath, codexSession(
        'physical-inside',
        [{ role: 'user', text: 'physical scope needle' }],
        lexicalProject,
      ))

      const result = searchRelatedSessions(nodeMemFs(home), {
        root: await realpath(project),
        query: 'scope needle',
        platform: 'codex',
      })

      expect(result.matches.map((match) => match.sessionId)).toEqual(['physical-inside'])
      expect(result.partial).toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  test('rejects a symlinked descendant cwd that physically escapes the project root', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'tenon-related-physical-escape-'))
    try {
      const home = join(fixture, 'home')
      const project = join(fixture, 'project')
      const outside = join(fixture, 'outside')
      const escapedCwd = join(project, 'alias-outside')
      const sessionPath = join(
        home,
        '.codex',
        'sessions',
        '2026',
        '07',
        'rollout-2026-07-28T12-00-00-physical-escape.jsonl',
      )
      await mkdir(project, { recursive: true })
      await mkdir(outside, { recursive: true })
      await mkdir(dirname(sessionPath), { recursive: true })
      await symlink(outside, escapedCwd, 'dir')
      await writeFile(sessionPath, codexSession(
        'physical-escape',
        [{ role: 'user', text: 'secret outside needle' }],
        escapedCwd,
      ))

      const result = searchRelatedSessions(nodeMemFs(home), {
        root: project,
        query: 'outside needle',
        platform: 'codex',
      })

      expect(result.matches).toEqual([])
      expect(result.partial).toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  test('fails closed and reports partial when a historical cwd cannot be canonicalized', () => {
    const path = codexFile('missing-physical-cwd')
    const base = boundedFakeFs({
      [path]: codexSession(
        'missing-physical-cwd',
        [{ role: 'user', text: 'unresolved scope needle' }],
        '/home/u/work/deleted-project',
      ),
    })
    const result = searchRelatedSessions({
      ...base,
      realPath: (candidate) => candidate === PROJECT ? PROJECT : undefined,
    }, {
      root: PROJECT,
      query: 'scope needle',
      platform: 'codex',
    })

    expect(result.matches).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('project-scope-unavailable')
  })

  test('uses bounded Claude fallback discovery when the derived project directory is absent', () => {
    const fallback = '/home/u/.claude/projects/-legacy-alias/fallback.jsonl'
    const base = boundedFakeFs({
      [fallback]: claudeSession('fallback', 'memory needle from the matching project'),
    })
    const fs: MemFs = {
      ...base,
      readDir: (path) => {
        if (path === '/home/u/.claude/projects') {
          throw new Error('bounded related search must not eagerly enumerate every Claude project')
        }
        return base.readDir(path)
      },
    }

    const result = searchRelatedSessions(fs, {
      root: PROJECT,
      query: 'memory needle',
      platform: 'claude',
    })

    expect(result.matches.map((match) => match.sessionId)).toEqual(['fallback'])
  })

  test('discovers Claude sessions in a descendant project shard', () => {
    const descendant = '/home/u/.claude/projects/-home-u-work-proj-subdir/descendant.jsonl'
    const result = searchRelatedSessions(boundedFakeFs({
      [descendant]: claudeSession(
        'descendant',
        'memory needle from a descendant project directory',
      ).replace(`"cwd":"${PROJECT}"`, `"cwd":"${PROJECT}/subdir"`),
    }), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'claude',
    })

    expect(result.matches.map((match) => match.sessionId)).toEqual(['descendant'])
  })

  test('fails closed for a bounded Claude session with unknown cwd in a colliding shard', () => {
    const collision = '/home/u/.claude/projects/-home-u-work-proj/missing-cwd.jsonl'
    const result = searchRelatedSessions(boundedFakeFs({
      [collision]: JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'private memory needle' },
        sessionId: 'missing-cwd',
        timestamp: '2026-07-28T12:00:00Z',
      }),
    }), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'claude',
    })

    expect(result.matches).toEqual([])
  })

  test('discovers Pi sessions in a descendant default project shard', () => {
    const descendant = '/home/u/.pi/agent/sessions/--home-u-work-proj-subdir--/2026-07-28_descendant.jsonl'
    const result = searchRelatedSessions(boundedFakeFs({
      [descendant]: piSession(
        'descendant',
        `${PROJECT}/subdir`,
        'memory needle from a descendant project directory',
      ),
    }), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'pi',
    })

    expect(result.matches.map((match) => match.sessionId)).toEqual(['descendant'])
  })

  test('excludes nested Claude subagent logs from top-level related sessions', () => {
    const parent = claudeFile('parent')
    const subagent = `${dirname(parent)}/parent/subagents/agent-sensitive.jsonl`
    const result = searchRelatedSessions(boundedFakeFs({
      [parent]: claudeSession('parent', 'memory needle in the real session'),
      [subagent]: claudeSession('agent-sensitive', 'memory needle in a delegated prompt'),
    }, {
      mtimes: {
        [parent]: Date.parse('2026-07-28T11:00:00Z'),
        [subagent]: Date.parse('2026-07-28T12:00:00Z'),
      },
    }), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'claude',
    })

    expect(result.partial).toBe(false)
    expect(result.matches.map((match) => match.sessionId)).toEqual(['parent'])
  })

  test('reserves all-host discovery capacity so an earlier host cannot starve a newer Codex match', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let index = 0; index < RELATED_SESSION_SEARCH_BUDGETS.discoveryFiles; index += 1) {
      const path = claudeFile(`claude-${index}`)
      files[path] = claudeSession(`claude-${index}`, 'unrelated request')
      mtimes[path] = Date.parse('2026-07-27T12:00:00Z')
    }
    const target = codexFile('newer-cross-host-target')
    files[target] = codexSession(
      'newer-cross-host-target',
      [{ role: 'user', text: 'memory needle' }],
    )
    mtimes[target] = Date.parse('2026-07-28T12:00:00Z')

    const result = searchRelatedSessions(boundedFakeFs(files, { mtimes }), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'all',
    })

    expect(result.matches.map((match) => `${match.platform}:${match.sessionId}`))
      .toContain('codex:newer-cross-host-target')
    expect(result.warnings.map((warning) => warning.code))
      .toContain('candidate-discovery-truncated')
  })

  test('uses bounded reads and returns only a bounded user excerpt without cwd or file path', () => {
    const path = codexFile('safe')
    const reads: Array<{ path: string; maxBytes: number }> = []
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: codexSession('safe', [
        { role: 'user', text: `memory search ${'u'.repeat(500)}` },
        { role: 'assistant', text: 'memory search private assistant detail' },
      ]),
    }, {
      onRead: (readPath, maxBytes) => reads.push({ path: readPath, maxBytes }),
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(reads).toEqual([{ path, maxBytes: MEM_SESSION_METADATA_BYTES }])
    expect(result.partial).toBe(false)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      platform: 'codex',
      sessionId: 'safe',
      hitCount: 2,
      descendantsMerged: 0,
    })
    expect(result.matches[0]?.excerpt).toContain('memory search')
    expect(result.matches[0]?.excerpt).not.toContain('private assistant detail')
    expect(result.matches[0]?.excerpt.length).toBeLessThanOrEqual(RELATED_SESSION_SEARCH_BUDGETS.excerptChars)
    expect(result.matches[0]).not.toHaveProperty('cwd')
    expect(result.matches[0]).not.toHaveProperty('filePath')
  })

  test('does not inspect OpenCode storage for an explicit Codex-only search', () => {
    const path = codexFile('codex-only')
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: codexSession('codex-only', [{
        role: 'user',
        text: 'memory search from the selected host',
      }]),
      '/home/u/.local/share/opencode/opencode.db': 'not a sqlite database',
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.matches.map((match) => match.sessionId)).toEqual(['codex-only'])
    expect(result.partial).toBe(false)
    expect(result.warnings).toEqual([])
  })

  test('keeps a late search hit inside the 320-character API excerpt', () => {
    const path = codexFile('late-hit')
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: codexSession('late-hit', [{
        role: 'user',
        text: `${'prefix '.repeat(52)}memory search`,
      }]),
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.excerpt).toContain('memory search')
    expect(Array.from(result.matches[0]?.excerpt ?? '').length)
      .toBeLessThanOrEqual(RELATED_SESSION_SEARCH_BUDGETS.excerptChars)
  })

  test('drops sessions whose query appears only in assistant content', () => {
    const path = codexFile('assistant-only')
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: codexSession('assistant-only', [
        { role: 'user', text: 'a different request' },
        { role: 'assistant', text: 'memory search implementation detail' },
      ]),
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.matches).toEqual([])
  })

  test('marks a per-file truncation as partial with a stable warning', () => {
    const path = codexFile('large')
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: codexSession('large', [{ role: 'user', text: 'memory search' }])
        + ' '.repeat(RELATED_SESSION_SEARCH_BUDGETS.perFileBytes),
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('file-read-truncated')
  })

  test('counts metadata and dialogue reads against one cumulative per-file ceiling', () => {
    const path = codexFile('cumulative-file-budget')
    const ranges: Array<{ offset: number; maxBytes: number }> = []
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: codexSession('cumulative-file-budget', [{
        role: 'user',
        text: `memory search ${'x'.repeat(RELATED_SESSION_SEARCH_BUDGETS.perFileBytes)}`,
      }]),
    }, {
      onRead: (_path, maxBytes) => ranges.push({ offset: 0, maxBytes }),
      onRangeRead: (_path, offset, maxBytes) => ranges.push({ offset, maxBytes }),
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(ranges).toEqual([
      { offset: 0, maxBytes: MEM_SESSION_METADATA_BYTES },
      {
        offset: MEM_SESSION_METADATA_BYTES,
        maxBytes: RELATED_SESSION_SEARCH_BUDGETS.perFileBytes - MEM_SESSION_METADATA_BYTES,
      },
    ])
    expect(ranges.reduce((total, read) => total + read.maxBytes, 0))
      .toBe(RELATED_SESSION_SEARCH_BUDGETS.perFileBytes)
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('file-read-truncated')
  })

  test('marks an oversized first metadata event partial instead of claiming a complete empty search', () => {
    const path = codexFile('oversized-metadata')
    const firstEvent = JSON.stringify({
      timestamp: '2026-07-28T12:00:00Z',
      payload: {
        id: 'oversized-metadata',
        padding: 'x'.repeat(MEM_SESSION_METADATA_BYTES),
        cwd: PROJECT,
      },
    })
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: `${firstEvent}\n${JSON.stringify({
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'memory search' }],
        },
      })}`,
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.matches).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('file-read-truncated')
  })

  test('marks a truncated Claude metadata scan partial when cwd appears after complete earlier lines', () => {
    const path = claudeFile('late-cwd')
    const leadingEvents = Array.from({ length: 120 }, (_, index) => JSON.stringify({
      type: 'progress',
      index,
      padding: 'x'.repeat(80),
    }))
    const source = [
      ...leadingEvents,
      claudeSession('late-cwd', 'memory search'),
    ].join('\n')
    expect(Buffer.byteLength(leadingEvents.slice(0, 80).join('\n'))).toBeGreaterThan(MEM_SESSION_METADATA_BYTES)

    const result = searchRelatedSessions(boundedFakeFs({ [path]: source }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'claude',
    })

    expect(result.matches).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('file-read-truncated')
  })

  test('preserves UTF-8 code points split across the metadata and dialogue byte ranges', () => {
    const path = codexFile('utf8-boundary')
    const metadata = `${JSON.stringify({
      timestamp: '2026-07-28T12:00:00Z',
      payload: { id: 'utf8-boundary', cwd: PROJECT },
    })}\n`
    const lineFor = (padding: number): string => JSON.stringify({
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${'x'.repeat(padding)}🙂 memory` }],
      },
    })
    const emojiOffsetWithoutPadding = Buffer.from(`${metadata}${lineFor(0)}`).indexOf(Buffer.from('🙂'))
    const padding = MEM_SESSION_METADATA_BYTES - 1 - emojiOffsetWithoutPadding
    expect(padding).toBeGreaterThan(0)
    const source = `${metadata}${lineFor(padding)}`
    expect(Buffer.from(source).indexOf(Buffer.from('🙂'))).toBe(MEM_SESSION_METADATA_BYTES - 1)

    const result = searchRelatedSessions(boundedFakeFs({ [path]: source }), {
      root: PROJECT,
      query: '🙂 memory',
      platform: 'codex',
    })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.sessionId).toBe('utf8-boundary')
    expect(result.matches[0]?.excerpt).toContain('🙂 memory')
    expect(result.partial).toBe(false)
  })

  test('marks an existing but unreadable selected session directory as partial', () => {
    const sessionsRoot = '/home/u/.codex/sessions'
    const base = boundedFakeFs({}, { unreadableDirs: new Set([sessionsRoot]) })
    const result = searchRelatedSessions({
      ...base,
      exists: (path) => path === sessionsRoot || base.exists(path),
    }, {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.matches).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('directory-read-unavailable')
  })

  test('never exceeds the aggregate byte budget and stops subsequent file reads', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 10; i += 1) {
      files[codexFile(`budget-${i}`)] = codexSession(`budget-${i}`, [
        { role: 'user', text: 'memory search' },
      ]) + ' '.repeat(RELATED_SESSION_SEARCH_BUDGETS.perFileBytes)
    }
    let bytesRead = 0
    let readCalls = 0
    const result = searchRelatedSessions(boundedFakeFs(files, {
      onRead: (_path, maxBytes) => {
        bytesRead += maxBytes
        readCalls += 1
      },
      onRangeRead: (_path, _offset, maxBytes) => {
        bytesRead += maxBytes
        readCalls += 1
      },
    }), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(bytesRead).toBeLessThanOrEqual(RELATED_SESSION_SEARCH_BUDGETS.totalBytes)
    expect(readCalls).toBe(10 + Math.ceil(
      (RELATED_SESSION_SEARCH_BUDGETS.totalBytes - 10 * MEM_SESSION_METADATA_BYTES)
      / RELATED_SESSION_SEARCH_BUDGETS.perFileBytes,
    ))
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('total-read-budget-exhausted')
  })

  test('searches at most the 100 most recently updated candidates', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i <= RELATED_SESSION_SEARCH_BUDGETS.candidates; i += 1) {
      const id = `candidate-${i}`
      const path = codexFile(id)
      const isOldest = i === 0
      files[path] = codexSession(id, [{
        role: 'user',
        text: isOldest ? 'unique oldest needle' : 'unrelated words',
      }])
      mtimes[path] = Date.parse('2026-07-28T00:00:00Z') + i
    }
    let reads = 0
    const result = searchRelatedSessions(boundedFakeFs(files, {
      mtimes,
      onRead: () => { reads += 1 },
    }), {
      root: PROJECT,
      query: 'oldest needle',
      platform: 'codex',
    })

    expect(reads).toBe(RELATED_SESSION_SEARCH_BUDGETS.candidates + 1)
    expect(result.matches).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('candidate-limit-reached')
  })

  test('the discovery time budget follows the injected clock, not the wall clock', () => {
    const path = codexFile('clocked')
    const files = { [path]: codexSession('clocked', [{ role: 'user', text: 'clocked memory needle' }]) }
    const frozen = searchRelatedSessions(boundedFakeFs(files), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'codex',
    })
    expect(frozen.matches.map((match) => match.sessionId)).toEqual(['clocked'])
    expect(frozen.warnings.map((warning) => warning.code)).not.toContain('candidate-discovery-truncated')

    let tick = 0
    const expired = searchRelatedSessions(boundedFakeFs(files), {
      root: PROJECT,
      query: 'memory needle',
      platform: 'codex',
      // Every reading is one second later: the first deadline check already sees the budget spent.
      now: () => { tick += 1_000; return tick },
    })
    expect(expired.matches).toEqual([])
    expect(expired.partial).toBe(true)
    expect(expired.warnings.map((warning) => warning.code)).toContain('candidate-discovery-truncated')
  })

  test('bounds Codex filesystem discovery before sorting a large history tree', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i < RELATED_SESSION_SEARCH_BUDGETS.discoveryEntries * 2; i += 1) {
      const path = codexFile(`discovery-${i}`)
      files[path] = codexSession(`discovery-${i}`, [{ role: 'user', text: 'unrelated words' }])
      mtimes[path] = Date.parse('2026-07-28T00:00:00Z') + i
    }
    let mtimeReads = 0
    const base = boundedFakeFs(files, { mtimes })
    const result = searchRelatedSessions({
      ...base,
      mtimeMs: (path) => {
        mtimeReads += 1
        return base.mtimeMs(path)
      },
    }, {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(mtimeReads).toBeLessThanOrEqual(RELATED_SESSION_SEARCH_BUDGETS.discoveryEntries * 2)
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('candidate-discovery-truncated')
  })

  test('chooses the global newest project candidates before adapter order in all mode', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i < RELATED_SESSION_SEARCH_BUDGETS.candidates; i += 1) {
      const path = claudeFile(`claude-${i}`)
      files[path] = claudeSession(`claude-${i}`, 'unrelated claude history')
      mtimes[path] = Date.parse('2026-07-28T00:00:00Z') + i
    }
    const newestCodex = codexFile('newest-codex')
    files[newestCodex] = codexSession('newest-codex', [{
      role: 'user',
      text: 'global candidate needle',
    }])
    mtimes[newestCodex] = Date.parse('2026-07-29T00:00:00Z')

    const result = searchRelatedSessions(boundedFakeFs(files, { mtimes }), {
      root: PROJECT,
      query: 'candidate needle',
      platform: 'all',
    })

    expect(result.matches).toEqual([
      expect.objectContaining({ platform: 'codex', sessionId: 'newest-codex' }),
    ])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('candidate-limit-reached')
  })

  test('foreign Codex sessions do not consume project candidate admission', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i < RELATED_SESSION_SEARCH_BUDGETS.candidates; i += 1) {
      const id = `foreign-${i}`
      const path = codexFile(id)
      files[path] = codexSession(id, [{ role: 'user', text: 'foreign words' }], '/home/u/work/other')
      mtimes[path] = Date.parse('2026-07-29T00:00:00Z') + i
    }
    const target = codexFile('target-codex')
    files[target] = codexSession('target-codex', [{ role: 'user', text: 'target project needle' }])
    mtimes[target] = Date.parse('2026-07-28T00:00:00Z')

    const result = searchRelatedSessions(boundedFakeFs(files, { mtimes }), {
      root: PROJECT,
      query: 'project needle',
      platform: 'codex',
    })

    expect(result.matches).toEqual([
      expect.objectContaining({ sessionId: 'target-codex' }),
    ])
  })

  test('reports partial when the bounded discovery top-K cannot reach an older project session', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i < RELATED_SESSION_SEARCH_BUDGETS.discoveryFiles; i += 1) {
      const id = `newer-foreign-${i}`
      const path = codexFile(id)
      files[path] = codexSession(id, [{ role: 'user', text: 'foreign words' }], '/home/u/work/other')
      mtimes[path] = Date.parse('2026-07-29T00:00:00Z') + i
    }
    const target = codexFile('older-target')
    files[target] = codexSession('older-target', [{ role: 'user', text: 'target project needle' }])
    mtimes[target] = Date.parse('2026-07-28T00:00:00Z')

    const result = searchRelatedSessions(boundedFakeFs(files, { mtimes }), {
      root: PROJECT,
      query: 'project needle',
      platform: 'codex',
    })

    expect(result.matches).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('candidate-discovery-truncated')
  })

  test('foreign Pi sessions in a custom root do not consume project candidate admission', () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i < RELATED_SESSION_SEARCH_BUDGETS.candidates; i += 1) {
      const id = `foreign-pi-${i}`
      const path = piFile(id)
      files[path] = piSession(id, '/home/u/work/other', 'foreign words')
      mtimes[path] = Date.parse('2026-07-29T00:00:00Z') + i
    }
    const target = piFile('target-pi')
    files[target] = piSession('target-pi', PROJECT, 'target project needle')
    mtimes[target] = Date.parse('2026-07-28T00:00:00Z')

    const result = searchRelatedSessions(boundedFakeFs(files, {
      mtimes,
      env: { PI_CODING_AGENT_SESSION_DIR: '/home/u/custom-pi-sessions' },
    }), {
      root: PROJECT,
      query: 'project needle',
      platform: 'pi',
    })

    expect(result.matches).toEqual([
      expect.objectContaining({ sessionId: 'target-pi' }),
    ])
  })

  test('does not expose a Claude host compaction summary as an original user match', () => {
    const path = claudeFile('summary-only')
    const result = searchRelatedSessions(boundedFakeFs({
      [path]: JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'synthetic summary needle' },
        cwd: PROJECT,
        timestamp: '2026-07-28T12:00:00Z',
      }),
    }), {
      root: PROJECT,
      query: 'summary needle',
      platform: 'claude',
    })

    expect(result.matches).toEqual([])
  })

  test('does not expose a Codex compaction summary but still admits preserved user history', () => {
    const path = codexFile('codex-summary')
    const source = [
      JSON.stringify({
        timestamp: '2026-07-28T12:00:00Z',
        payload: { id: 'codex-summary', cwd: PROJECT },
      }),
      JSON.stringify({
        type: 'compacted',
        payload: {
          replacement_history: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'preserved original request' }],
            },
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'synthetic summary needle' }],
            },
          ],
        },
      }),
    ].join('\n')

    const summaryOnly = searchRelatedSessions(boundedFakeFs({ [path]: source }), {
      root: PROJECT,
      query: 'summary needle',
      platform: 'codex',
    })
    const preserved = searchRelatedSessions(boundedFakeFs({ [path]: source }), {
      root: PROJECT,
      query: 'original request',
      platform: 'codex',
    })

    expect(summaryOnly.matches).toEqual([])
    expect(preserved.matches).toEqual([
      expect.objectContaining({ sessionId: 'codex-summary', excerpt: expect.stringContaining('original request') }),
    ])
  })

  test('keeps the last real Codex user message when remote compaction ends in an encrypted item', () => {
    const path = codexFile('codex-remote-compaction')
    const source = [
      JSON.stringify({
        timestamp: '2026-07-28T12:00:00Z',
        payload: { id: 'codex-remote-compaction', cwd: PROJECT },
      }),
      JSON.stringify({
        type: 'compacted',
        payload: {
          replacement_history: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'preserved remote request' }],
            },
            {
              type: 'compaction',
              id: 'encrypted-summary',
              encrypted_content: 'opaque',
            },
          ],
        },
      }),
    ].join('\n')

    const result = searchRelatedSessions(boundedFakeFs({ [path]: source }), {
      root: PROJECT,
      query: 'remote request',
      platform: 'codex',
    })

    expect(result.matches).toEqual([
      expect.objectContaining({
        sessionId: 'codex-remote-compaction',
        excerpt: expect.stringContaining('remote request'),
      }),
    ])
  })

  test.each(['compaction', 'branch_summary'] as const)(
    'does not expose a Pi %s as an original user match',
    (type) => {
      const path = piFile(`pi-${type}`)
      const result = searchRelatedSessions(boundedFakeFs({
        [path]: [
          JSON.stringify({
            type: 'session',
            id: `pi-${type}`,
            cwd: PROJECT,
            timestamp: '2026-07-28T12:00:00Z',
          }),
          JSON.stringify({
            type,
            id: `${type}-entry`,
            summary: 'synthetic summary needle',
          }),
        ].join('\n'),
      }, {
        env: { PI_CODING_AGENT_SESSION_DIR: '/home/u/custom-pi-sessions' },
      }), {
        root: PROJECT,
        query: 'summary needle',
        platform: 'pi',
      })

      expect(result.matches).toEqual([])
    },
  )

  test('caps results at eight while preserving the existing relevance ordering', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 10; i += 1) {
      files[codexFile(`result-${i}`)] = codexSession(`result-${i}`, [{
        role: 'user',
        text: `memory search ${'memory '.repeat(i)}`,
      }])
    }
    const result = searchRelatedSessions(boundedFakeFs(files), {
      root: PROJECT,
      query: 'memory search',
      platform: 'codex',
    })

    expect(result.matches).toHaveLength(RELATED_SESSION_SEARCH_BUDGETS.results)
    expect(result.matches[0]?.sessionId).toBe('result-9')
  })
})
