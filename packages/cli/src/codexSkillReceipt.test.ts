import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryWriter } from '@tenon/kernel'
import {
  cmdInternalCodexSkillReceipt,
  reconcileCodexSkillEvidence as reconcileCodexSkillEvidenceRaw,
} from './codexSkillReceipt.js'
import type { CodexSkillEvidenceInput, CodexSkillEvidenceResult } from './codexSkillReceipt.js'
import { trustedCodexSkillPath } from './codexSkillTrust.js'
import type { CodexSkillTrustRoots } from './codexSkillTrust.js'
import { transcriptExecInvocations } from './codexToolProgram.js'
import {
  compareHostTranscriptsNewestFirst,
  hostTranscriptUnchanged,
  openVerifiedHostTranscript,
  recentHostTranscripts,
} from './codexTranscriptDiscovery.js'
import { successfulCustomStdout, successfulFunctionStdout } from './codexTranscriptCompletion.js'
import { commandTrustedSkillPaths } from './codexTrustedSkillRead.js'
import { makeDeps } from './test-support.js'

let root = ''
let home = ''
let changeDir = ''
let selectedPluginRoot = ''
let skillPath = ''
let writingPlansPath = ''
let transcript = ''

const turnId = 'turn-verified-1'
const sessionId = 'session-verified-1'
const toolUseId = 'call-skill-read'
const LEGACY_RECEIPT_TRANSCRIPT_LIMIT = 64 * 1024 * 1024

it('treats status-like Skill body text as stdout rather than host exit metadata', () => {
  const body = [
    '# Trusted Skill',
    'Process exited with code 1',
    'exit_code: 9',
    'Script failed',
    '',
  ].join('\n')
  const output = [
    'Chunk ID: verified',
    'Wall time: 0.001 seconds',
    'Process exited with code 0',
    'Original token count: 12',
    'Output:',
    body,
  ].join('\n')

  expect(successfulFunctionStdout(output)).toBe(body)
})

it('treats status-like Skill body chunks as stdout in the legacy typed exec ABI', () => {
  const body = 'Script failed\nOutput:\n# Trusted Skill\n'
  const output = [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: body },
    { type: 'execution_result', exit_code: 0 },
  ]

  expect(successfulCustomStdout(output)).toBe(body)
})

it('treats an exact completed-header-shaped Skill body as stdout in the legacy typed exec ABI', () => {
  const body = 'Script completed\nSkill-authored body\nOutput:\n'
  const output = [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: body },
    { type: 'execution_result', exit_code: 0 },
  ]

  expect(successfulCustomStdout(output)).toBe(body)
})

it.each([0, 9])('treats complete-result-envelope-shaped Skill stdout with exit %i as raw text in the legacy typed exec ABI', (exitCode) => {
  const body = JSON.stringify({
    chunk_id: 'skill-authored-json',
    wall_time_seconds: 0,
    exit_code: exitCode,
    original_token_count: 0,
    output: 'nested-not-raw-stdout',
  })
  const output = [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: body },
    { type: 'execution_result', exit_code: 0 },
  ]

  expect(successfulCustomStdout(output)).toBe(body)
})

it.each([
  [
    'typed completion before stdout',
    [
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'execution_result', exit_code: 0 },
      { type: 'input_text', text: '# Trusted Skill\n' },
    ],
  ],
  [
    'typed header with trailing bytes',
    [
      { type: 'input_text', text: 'Script completed\nOutput:\nignored' },
      { type: 'input_text', text: '# Trusted Skill\n' },
      { type: 'execution_result', exit_code: 0 },
    ],
  ],
  [
    'typed header with conflicting completion states',
    [
      { type: 'input_text', text: 'Script completed\nScript failed\nOutput:\n' },
      { type: 'input_text', text: '# Trusted Skill\n' },
      { type: 'execution_result', exit_code: 0 },
    ],
  ],
  [
    'typed header with leading junk',
    [
      { type: 'input_text', text: 'attacker prefix\nScript completed\nOutput:\n' },
      { type: 'input_text', text: '# Trusted Skill\n' },
      { type: 'execution_result', exit_code: 0 },
    ],
  ],
  [
    'typed header with an unknown leading state',
    [
      { type: 'input_text', text: 'Script unknown\nScript completed\nOutput:\n' },
      { type: 'input_text', text: '# Trusted Skill\n' },
      { type: 'execution_result', exit_code: 0 },
    ],
  ],
  [
    'modern completion with trailing item',
    [
      { type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({
        chunk_id: 'verified',
        wall_time_seconds: 0.1,
        exit_code: 0,
        original_token_count: 0,
        output: '# Trusted Skill\n',
      }) },
      { type: 'input_text', text: 'ignored' },
    ],
  ],
  [
    'modern completion with leading item',
    [
      { type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: 'ignored' },
      { type: 'input_text', text: JSON.stringify({
        chunk_id: 'verified',
        wall_time_seconds: 0.1,
        exit_code: 0,
        original_token_count: 0,
        output: '# Trusted Skill\n',
      }) },
    ],
  ],
] as const)('rejects malformed custom exec ABI: %s', (_label, output) => {
  expect(successfulCustomStdout(output)).toBeUndefined()
})

it.each([
  [
    'exit_code',
    '{"chunk_id":"verified","wall_time_seconds":0,"exit_code":9,"exit_code":0,"original_token_count":0,"output":"skill"}',
  ],
  [
    'output',
    '{"chunk_id":"verified","wall_time_seconds":0,"exit_code":0,"original_token_count":0,"output":"ignored","output":"skill"}',
  ],
] as const)('rejects modern completion with duplicate top-level %s', (_key, body) => {
  expect(successfulCustomStdout([
    { type: 'input_text', text: 'Script completed\nOutput:\n' },
    { type: 'input_text', text: body },
  ])).toBeUndefined()
})

async function appendValidTranscriptPadding(path: string): Promise<void> {
  const padding = {
    type: 'event_msg',
    payload: { type: 'test_padding', text: 'x'.repeat(LEGACY_RECEIPT_TRANSCRIPT_LIMIT) },
  }
  await appendFile(path, `${JSON.stringify(padding)}\n`, 'utf8')
}

function customResultOutput(exitCode = 0, output = '# OpenSpec Propose\n'): readonly unknown[] {
  return [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    {
      type: 'input_text',
      text: JSON.stringify({
        chunk_id: 'verified',
        wall_time_seconds: 0.1,
        exit_code: exitCode,
        original_token_count: 0,
        output,
      }),
    },
  ]
}

function reconcileCodexSkillEvidence(
  input: Omit<CodexSkillEvidenceInput, 'selectedPluginRoot'> & { readonly selectedPluginRoot?: string },
): Promise<CodexSkillEvidenceResult> {
  return reconcileCodexSkillEvidenceRaw({ selectedPluginRoot, ...input })
}

function eventLines(
  output?: unknown,
  outputTurn = turnId,
  skillPaths: readonly string[] = [skillPath],
  timestamp = '2026-07-24T00:02:00Z',
  options: {
    readonly transcriptSessionId?: string
    readonly callId?: string
    readonly outputCallId?: string
    readonly command?: string
    readonly execArgs?: Readonly<Record<string, unknown>>
    readonly pragma?: string
    readonly inlineText?: boolean
  } = {},
): string {
  const callId = options.callId ?? toolUseId
  const command = options.command
    ?? skillPaths.map((path) => `cat ${path}`).join(' && ')
  const execArgs = JSON.stringify({ cmd: command, ...options.execArgs })
  const program = options.inlineText
    ? `text(await tools.exec_command(${execArgs}));`
    : `const r = await tools.exec_command(${execArgs}); text(r);`
  const events: unknown[] = [
    {
      type: 'session_meta',
      timestamp,
      payload: {
        cwd: root,
        session_id: options.transcriptSessionId ?? sessionId,
        id: options.transcriptSessionId ?? sessionId,
      },
    },
    {
      type: 'turn_context',
      timestamp,
      payload: { turn_id: turnId },
    },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: callId,
        name: 'exec',
        input: `${options.pragma === undefined ? '' : `${options.pragma}\n`}${program}`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
  ]
  if (output !== undefined) {
    events.push({
      type: 'response_item',
      timestamp,
      payload: {
        type: 'custom_tool_call_output',
        call_id: options.outputCallId ?? callId,
        output,
        internal_chat_message_metadata_passthrough: { turn_id: outputTurn },
      },
    })
  }
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

function insertMalformedTranscriptLine(
  source: string,
  position: 'between-invocation-and-output' | 'after-output',
): string {
  const lines = source.trimEnd().split('\n')
  const insertionIndex = position === 'after-output' ? lines.length : lines.length - 1
  lines.splice(insertionIndex, 0, '{not-json')
  return `${lines.join('\n')}\n`
}

function appendDuplicateCompletion(
  source: string,
  outputType: 'custom_tool_call_output' | 'function_call_output',
): string {
  const lines = source.trimEnd().split('\n')
  const completion = JSON.parse(lines.at(-1) ?? '') as {
    payload: { type: 'custom_tool_call_output' | 'function_call_output' }
  }
  completion.payload.type = outputType
  lines.push(JSON.stringify(completion))
  return `${lines.join('\n')}\n`
}

function insertDuplicateInvocationBeforeCompletion(
  source: string,
  timestamp: string | null | undefined = undefined,
): string {
  const lines = source.trimEnd().split('\n')
  const invocation = lines.at(-2)
  if (invocation === undefined) throw new Error('fixture is missing its invocation')
  if (timestamp === undefined) {
    lines.splice(lines.length - 1, 0, invocation)
  } else {
    const duplicate = JSON.parse(invocation) as Record<string, unknown>
    if (timestamp === null) delete duplicate.timestamp
    else duplicate.timestamp = timestamp
    lines.splice(lines.length - 1, 0, JSON.stringify(duplicate))
  }
  return `${lines.join('\n')}\n`
}

function insertDuplicateInvocationBeforeInvocation(
  source: string,
  timestamp: string | null,
): string {
  const lines = source.trimEnd().split('\n')
  const invocation = lines.at(-2)
  if (invocation === undefined) throw new Error('fixture is missing its invocation')
  const duplicate = JSON.parse(invocation) as Record<string, unknown>
  if (timestamp === null) delete duplicate.timestamp
  else duplicate.timestamp = timestamp
  lines.splice(lines.length - 2, 0, JSON.stringify(duplicate))
  return `${lines.join('\n')}\n`
}

function sessionScopedEventLines(
  sessionCwd: string,
  output: unknown = customResultOutput(),
  skillPaths: readonly string[] = [skillPath],
  transcriptSessionId?: string,
): string {
  const effectiveSessionId = transcriptSessionId ?? sessionId
  return eventLines(output, turnId, skillPaths, '2026-07-24T00:02:00Z', {
    transcriptSessionId: effectiveSessionId,
  }).replace(`"cwd":"${root}"`, `"cwd":"${sessionCwd}"`)
}

/** Mirrors the normal Codex transcript shape: `cmd` is JSON-encoded inside JavaScript source. */
function multilineSessionScopedEventLines(sessionCwd: string): string {
  const command = [
    `cat ${skillPath}`,
    `cat ${writingPlansPath}`,
  ].join('\n')
  const events: unknown[] = [
    {
      type: 'session_meta',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { cwd: sessionCwd, session_id: sessionId, id: sessionId },
    },
    {
      type: 'turn_context',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { turn_id: turnId },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call-multiline-skill-read',
        name: 'exec',
        input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command })}); text(result);`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-multiline-skill-read',
        output: customResultOutput(0, '# OpenSpec Propose\n# Writing Plans\n'),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
  ]
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

/** Current custom exec ABI can serialize a JavaScript object literal with unquoted safe keys. */
function unquotedObjectSessionScopedEventLines(sessionCwd: string): string {
  const command = `cat ${skillPath}\ncat ${writingPlansPath}`
  const events: unknown[] = [
    {
      type: 'session_meta',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { cwd: sessionCwd, session_id: sessionId, id: sessionId },
    },
    {
      type: 'turn_context',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { turn_id: turnId },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call-unquoted-object-skill-read',
        name: 'exec',
        input: `const result = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(sessionCwd)}}); text(result);`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-unquoted-object-skill-read',
        output: customResultOutput(0, '# OpenSpec Propose\n# Writing Plans\n'),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
  ]
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

/** Current Codex Desktop ABI: function_call(exec_command) + function_call_output. */
function functionCallSessionScopedEventLines(
  sessionCwd: string,
  workdir?: string,
  outputType: 'function_call_output' | 'custom_tool_call_output' = 'function_call_output',
  output: unknown = 'Chunk ID: abc123\nWall time: 0.001 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\n# OpenSpec Propose\n',
  execArgs: Readonly<Record<string, unknown>> = {},
): string {
  const command = `cat ${skillPath}`
  const events: unknown[] = [
    {
      type: 'session_meta',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { cwd: sessionCwd, session_id: sessionId, id: sessionId },
    },
    {
      type: 'turn_context',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { turn_id: turnId },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'function_call',
        call_id: 'call-function-skill-read',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: command,
          ...(workdir === undefined ? {} : { workdir }),
          ...execArgs,
        }),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: outputType,
        call_id: 'call-function-skill-read',
        output,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
  ]
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

/** Current Codex custom exec ABI: JavaScript source wraps an explicit exec_command workdir. */
function customCallSessionScopedEventLines(sessionCwd: string, workdir?: string): string {
  const command = `cat ${skillPath}`
  const events: unknown[] = [
    {
      type: 'session_meta',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { cwd: sessionCwd, session_id: sessionId, id: sessionId },
    },
    {
      type: 'turn_context',
      timestamp: '2026-07-24T00:02:00Z',
      payload: { turn_id: turnId },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call-custom-skill-read',
        name: 'exec',
        input: `const r = await tools.exec_command(${JSON.stringify({
          cmd: command,
          ...(workdir === undefined ? {} : { workdir }),
          yield_time_ms: 10000,
        })}); text(r);`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-24T00:02:00Z',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-custom-skill-read',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'input_text', text: '# OpenSpec Propose\n' },
          { type: 'execution_result', exit_code: 0 },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
  ]
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

async function recordPendingReceipt(
  receiptToolUseId = toolUseId,
  receiptRepoRoot = root,
): Promise<void> {
  const deps = {
    ...makeDeps({ cwd: receiptRepoRoot }),
    clock: (): string => '2026-07-24T00:02:00Z',
  }
  expect(await cmdInternalCodexSkillReceipt(
    deps,
    'receipt-proof',
    'openspec-propose',
    skillPath,
    transcript,
    sessionId,
    turnId,
    receiptToolUseId,
    {
      homeDir: () => home,
      codexHomeDir: () => join(home, '.codex'),
      selectedPluginRoot: () => selectedPluginRoot,
    },
  )).toBe(0)
}

async function bindHostSession(bindingSessionId = sessionId): Promise<void> {
  const bindingsDir = join(root, '.pipeline', 'terminal-sessions')
  await mkdir(bindingsDir, { recursive: true })
  await writeFile(join(bindingsDir, `${bindingSessionId}.json`), `${JSON.stringify({
    protocol: 'pipeline-terminal-session-v1',
    session_id: bindingSessionId,
    change: 'receipt-proof',
    bound_at: '2026-07-24T00:01:00Z',
  })}\n`, 'utf8')
}

const historyWriter: HistoryWriter = {
  append: async (dir, entry): Promise<void> => {
    await appendFile(join(dir, '.pipeline-history.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
  },
}

/** Mirror the on-disk identity a host-owned Codex plugin cache always declares. */
async function writeCodexCacheIdentity(cacheRoot: string, version: string): Promise<void> {
  await mkdir(join(cacheRoot, '.codex-plugin'), { recursive: true })
  await mkdir(join(cacheRoot, '.agents', 'plugins'), { recursive: true })
  await writeFile(
    join(cacheRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'tenon', version })}\n`,
    'utf8',
  )
  await writeFile(
    join(cacheRoot, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon' }] })}\n`,
    'utf8',
  )
}

describe('Codex transcript skill receipt', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-skill-receipt-')))
    home = join(root, 'home')
    changeDir = join(root, 'openspec', 'changes', 'receipt-proof')
    selectedPluginRoot = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', '0.2.0')
    skillPath = join(selectedPluginRoot, 'skills', 'openspec-propose', 'SKILL.md')
    writingPlansPath = join(selectedPluginRoot, 'skills', 'writing-plans', 'SKILL.md')
    transcript = join(home, '.codex', 'sessions', '2026', '07', '24', 'receipt.jsonl')
    await Promise.all([
      mkdir(changeDir, { recursive: true }),
      mkdir(dirname(skillPath), { recursive: true }),
      mkdir(dirname(writingPlansPath), { recursive: true }),
      mkdir(dirname(transcript), { recursive: true }),
    ])
    await writeFile(skillPath, '# OpenSpec Propose\n', 'utf8')
    await writeFile(writingPlansPath, '# Writing Plans\n', 'utf8')
    // A real Codex cache root always carries the manifests that declare its own
    // marketplace/plugin/version identity; trust now reconciles them against the cache path.
    await writeCodexCacheIdentity(selectedPluginRoot, '0.2.0')
  })

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  it('accepts only the exact selected Codex cache root', async () => {
    await expect(trustedCodexSkillPath(
      { selectedCacheRoot: selectedPluginRoot },
      'openspec-propose',
      home,
      join(home, '.codex'),
    )).resolves.toBe(skillPath)
  })

  it('decodes literal workdir values without evaluating dynamic tool-program expressions', () => {
    expect(transcriptExecInvocations(
      `const r = await tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo",yield_time_ms:10000}); text(r);`,
    )).toEqual([{ command: "sed -n '1,20p' /trusted/SKILL.md", workdir: '/repo' }])
    expect(transcriptExecInvocations(
      `const r = await tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:targetRoot}); text(r);`,
    )).toEqual([])
    expect(transcriptExecInvocations([
      'const first = await tools.exec_command({cmd:dynamicCommand}); text(first);',
      `const second = await tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo"}); text(second);`,
    ].join('\n'))).toEqual([])
    expect(transcriptExecInvocations(
      `const r = await tools.exec_command(${JSON.stringify({
        cmd: "sed -n '1,20p' /trusted/SKILL.md",
        workdir: '/repo',
        prefix_rule: ['sed', '-n'],
      })}); text(r);`,
    )).toEqual([{ command: "sed -n '1,20p' /trusted/SKILL.md", workdir: '/repo' }])
    expect(transcriptExecInvocations(
      `const r = await tools.exec_command({cmd:"cat /trusted/SKILL.md",max_output_tokens:1}); text(r);`,
    )).toEqual([{ command: 'cat /trusted/SKILL.md' }])
    expect(transcriptExecInvocations(
      `// @exec: {"max_output_tokens":1}\nconst r = await tools.exec_command({cmd:"cat /trusted/SKILL.md"}); text(r);`,
    )).toEqual([{ command: 'cat /trusted/SKILL.md' }])
  })

  it('rejects a relative cat operand even when the verifier cwd resolves it to the trusted Skill', () => {
    const relativeSkillPath = relative(process.cwd(), skillPath)
    expect(relativeSkillPath).not.toMatch(/^\//)
    expect(commandTrustedSkillPaths(`cat ${relativeSkillPath}`, skillPath)).toBeUndefined()
  })

  it('rejects an absolute sibling-shaped path that escapes above the trusted skills root', () => {
    const escapedSkillPath = resolve(skillPath, '..', '..', '..', 'SKILL.md')
    expect(commandTrustedSkillPaths(
      `cat ${skillPath} && cat ${escapedSkillPath}`,
      skillPath,
    )).toBeUndefined()
  })

  it.each([
    `// tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo"})\ntext("Script completed");`,
    `const spoof = 'tools.exec_command({cmd:"sed -n \\'1,20p\\' /trusted/SKILL.md",workdir:"/repo"})'; text("Script completed");`,
    `if (false) { const r = await tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo"}); text(r.output); }`,
    `const r = tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo"}); text(r.output);`,
    `const r = await tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo"}); text("Script completed");`,
    `const r = await tools.exec_command({cmd:"sed -n '1,20p' /trusted/SKILL.md",workdir:"/repo"}); text(r.output);`,
  ])('rejects a non-canonical or spoofable custom exec wrapper', (program) => {
    expect(transcriptExecInvocations(program)).toEqual([])
  })

  it.each(['active-release', 'direct-development'] as const)(
    'accepts an exact %s trust root and reconciles only its completed host call',
    async (kind) => {
      const runtimeDataRoot = join(root, 'runtime-data')
      const runtimeStateRoot = join(root, 'runtime-state')
      const releaseId = `sha256-${'a'.repeat(64)}`
      const pluginRoot = kind === 'active-release'
        ? join(runtimeDataRoot, 'releases', releaseId, 'payload')
        : join(root, 'pipeline-direct-development')
      skillPath = join(pluginRoot, 'skills', 'openspec-propose', 'SKILL.md')
      await mkdir(dirname(skillPath), { recursive: true })
      await writeFile(skillPath, '# trusted root skill\n', 'utf8')
      if (kind === 'active-release') {
        await mkdir(runtimeStateRoot, { recursive: true })
        await writeFile(join(runtimeStateRoot, 'selection.json'), `${JSON.stringify({
          version: 1,
          revision: 1,
          activeRelease: releaseId,
          previousRelease: null,
          updatedAt: '2026-07-24T00:00:00Z',
        })}\n`, 'utf8')
        await writeFile(join(runtimeDataRoot, 'releases', releaseId, 'release.json'), `${JSON.stringify({
          version: 1,
          releaseId,
          payloadDigest: 'a'.repeat(64),
          createdAt: '2026-07-24T00:00:00Z',
          source: { host: 'codex', pluginVersion: '1.0.1' },
        })}\n`, 'utf8')
      }
      if (kind === 'direct-development') {
        for (const required of [
          join(pluginRoot, '.codex-plugin', 'plugin.json'),
          join(pluginRoot, 'hooks', 'codex-skill-receipt.sh'),
          join(pluginRoot, 'packages', 'cli', 'dist', 'tenon.mjs'),
        ]) {
          await mkdir(dirname(required), { recursive: true })
          await writeFile(
            required,
            required.endsWith(join('.codex-plugin', 'plugin.json'))
              ? `${JSON.stringify({ name: 'tenon', version: '0.2.0' })}\n`
              : '{}\n',
            'utf8',
          )
        }
      }
      const trustRoots: CodexSkillTrustRoots = kind === 'active-release'
        ? {
            activeReleaseRoot: pluginRoot,
            executingPluginRoot: pluginRoot,
            runtimeDataRoot,
            runtimeStateRoot,
          }
        : {
            directDevelopmentRoot: pluginRoot,
            executingPluginRoot: pluginRoot,
          }
      await writeFile(
        transcript,
        eventLines(customResultOutput(0, '# trusted root skill\n')),
        'utf8',
      )
      const deps = { ...makeDeps({ cwd: root }), clock: (): string => '2026-07-24T00:02:00Z' }
      expect(await cmdInternalCodexSkillReceipt(
        deps,
        'receipt-proof',
        'openspec-propose',
        skillPath,
        transcript,
        sessionId,
        turnId,
        toolUseId,
        {
          homeDir: () => home,
          codexHomeDir: () => join(home, '.codex'),
          trustRoots: () => trustRoots,
        },
      )).toBe(0)

      const result = await reconcileCodexSkillEvidenceRaw({
        repoRoot: root,
        changeDir,
        producer: 'openspec-propose',
        recordedAt: '2026-07-24T00:03:00Z',
        history: historyWriter,
        homeDir: home,
        codexHomeDir: join(home, '.codex'),
        trustRoots,
      })

      expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    },
  )

  it('rejects a claimed direct-development root that is not the physically executing packaged root', async () => {
    const forgedRoot = join(root, 'forged-direct-root')
    const forgedSkill = join(forgedRoot, 'skills', 'openspec-propose', 'SKILL.md')
    await mkdir(dirname(forgedSkill), { recursive: true })
    await writeFile(forgedSkill, '# forged\n', 'utf8')

    await expect(trustedCodexSkillPath({
      directDevelopmentRoot: forgedRoot,
      executingPluginRoot: selectedPluginRoot,
    }, 'openspec-propose', home, join(home, '.codex'))).resolves.toBeUndefined()
  })

  it('does not turn a PreToolUse receipt into evidence until the host transcript has a matching successful completion', async () => {
    await writeFile(transcript, eventLines(), 'utf8')
    await recordPendingReceipt()

    const pending = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(pending.confirmedSkillIds).toEqual([])
    await expect(readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(transcript, eventLines(customResultOutput()), 'utf8')
    const confirmed = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:01Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(confirmed.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toContain('CodexSkillRead: openspec-propose')
  })

  it.each([
    'between-invocation-and-output',
    'after-output',
  ] as const)('rejects an exact custom receipt when malformed JSON appears %s', async (position) => {
    await writeFile(
      transcript,
      insertMalformedTranscriptLine(eventLines(customResultOutput()), position),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    'between-invocation-and-output',
    'after-output',
  ] as const)('rejects an exact function receipt when malformed JSON appears %s', async (position) => {
    await writeFile(
      transcript,
      insertMalformedTranscriptLine(functionCallSessionScopedEventLines(root), position),
      'utf8',
    )
    await recordPendingReceipt('call-function-skill-read')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    ['custom', 'custom_tool_call_output'],
    ['custom', 'function_call_output'],
    ['function', 'function_call_output'],
    ['function', 'custom_tool_call_output'],
  ] as const)('rejects an exact %s receipt with a duplicate %s completion', async (invocationAbi, duplicateAbi) => {
    const source = invocationAbi === 'custom'
      ? eventLines(customResultOutput())
      : functionCallSessionScopedEventLines(root)
    await writeFile(transcript, appendDuplicateCompletion(source, duplicateAbi), 'utf8')
    await recordPendingReceipt(invocationAbi === 'custom' ? toolUseId : 'call-function-skill-read')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    'custom',
    'function',
  ] as const)('rejects an exact %s receipt with duplicate invocation identity before one completion', async (invocationAbi) => {
    const source = invocationAbi === 'custom'
      ? eventLines(customResultOutput())
      : functionCallSessionScopedEventLines(root)
    await writeFile(transcript, insertDuplicateInvocationBeforeCompletion(source), 'utf8')
    await recordPendingReceipt(invocationAbi === 'custom' ? toolUseId : 'call-function-skill-read')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    ['custom', 'stale', '2026-07-24T00:00:00Z'],
    ['custom', 'missing', null],
    ['custom', 'invalid', 'not-a-timestamp'],
    ['function', 'stale', '2026-07-24T00:00:00Z'],
    ['function', 'missing', null],
    ['function', 'invalid', 'not-a-timestamp'],
  ] as const)(
    'rejects an exact %s receipt when a %s-timestamp duplicate invocation precedes the fresh call',
    async (invocationAbi, _timestampKind, timestamp) => {
      const source = invocationAbi === 'custom'
        ? eventLines(customResultOutput())
        : functionCallSessionScopedEventLines(root)
      await writeFile(
        transcript,
        insertDuplicateInvocationBeforeInvocation(source, timestamp),
        'utf8',
      )
      await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
        JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'build', to: 'spec' }),
        '',
      ].join('\n'), 'utf8')
      await recordPendingReceipt(invocationAbi === 'custom' ? toolUseId : 'call-function-skill-read')

      const result = await reconcileCodexSkillEvidence({
        repoRoot: root,
        changeDir,
        producer: 'openspec-propose',
        recordedAt: '2026-07-24T00:03:00Z',
        history: historyWriter,
        evidenceScope: 'spec',
        homeDir: home,
        codexHomeDir: join(home, '.codex'),
      })

      expect(result.confirmedSkillIds).toEqual([])
    },
  )

  it('accepts safe max_output_tokens on the content-array ABI when text(result) forwards the complete Skill', async () => {
    await writeFile(
      transcript,
      eventLines(
        customResultOutput(),
        turnId,
        [skillPath],
        '2026-07-24T00:02:00Z',
        { execArgs: { max_output_tokens: 20_000 } },
      ),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
  })

  it('accepts a host output-budget pragma only when the forwarded Skill remains complete', async () => {
    await writeFile(
      transcript,
      eventLines(customResultOutput(), turnId, [skillPath], '2026-07-24T00:02:00Z', {
        pragma: '// @exec: {"max_output_tokens":20000}',
      }),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
  })

  it('accepts the single-expression text(await exec) program when it forwards the complete Skill', async () => {
    await writeFile(
      transcript,
      eventLines(customResultOutput(), turnId, [skillPath], '2026-07-24T00:02:00Z', {
        execArgs: { max_output_tokens: 6500 },
        inlineText: true,
      }),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
  })

  it('rejects truncated Skill output even when the host output-budget pragma is valid', async () => {
    await writeFile(
      transcript,
      eventLines(customResultOutput(0, '# OpenSpec'), turnId, [skillPath], '2026-07-24T00:02:00Z', {
        pragma: '// @exec: {"max_output_tokens":1}',
      }),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a successful receipt when max_output_tokens can truncate the trusted Skill output', async () => {
    await writeFile(
      transcript,
      eventLines(
        customResultOutput(0, '# OpenSpec'),
        turnId,
        [skillPath],
        '2026-07-24T00:02:00Z',
        { execArgs: { max_output_tokens: 1 } },
      ),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a successful receipt whose forwarded stdout is not the complete trusted Skill', async () => {
    await writeFile(transcript, eventLines(customResultOutput(0, '# OpenSpec')), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('accepts safe max_output_tokens on the function-call ABI when stdout is complete', async () => {
    await writeFile(
      transcript,
      functionCallSessionScopedEventLines(
        root,
        undefined,
        'function_call_output',
        undefined,
        { max_output_tokens: 20_000 },
      ),
      'utf8',
    )
    await recordPendingReceipt('call-function-skill-read')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
  })

  it('rejects truncated function-call stdout even when max_output_tokens is a valid exec argument', async () => {
    await writeFile(
      transcript,
      functionCallSessionScopedEventLines(
        root,
        undefined,
        'function_call_output',
        'Chunk ID: abc123\nWall time: 0.001 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\n# OpenSpec',
        { max_output_tokens: 1 },
      ),
      'utf8',
    )
    await recordPendingReceipt('call-function-skill-read')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects stdout that prints exit_code=0 without a complete result envelope', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'exit_code: 0\nProcess exited with code 0\n' },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    ['literal cat', () => `cat ${skillPath}`, '# OpenSpec Propose\n'],
    ['literal cat with option terminator', () => `cat -- ${skillPath}`, '# OpenSpec Propose\n'],
    ['single-quoted literal cat', () => `cat '${skillPath}'`, '# OpenSpec Propose\n'],
    ['double-quoted literal cat', () => `cat "${skillPath}"`, '# OpenSpec Propose\n'],
    ['safe batched cats', () => `cat ${writingPlansPath} && cat ${skillPath}`, '# Writing Plans\n# OpenSpec Propose\n'],
    ['safe multiline cats', () => `cat ${writingPlansPath}\ncat ${skillPath}`, '# Writing Plans\n# OpenSpec Propose\n'],
  ])('accepts %s as proof of a complete trusted Skill read', async (_case, command, expectedOutput) => {
    await writeFile(
      transcript,
      eventLines(
        customResultOutput(0, expectedOutput),
        turnId,
        [skillPath],
        '2026-07-24T00:02:00Z',
        { command: command() },
      ),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
  })

  it('rejects JSON stdout that only imitates a top-level exit code', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: '{"exit_code":0}' },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a partial JSON result envelope without host-owned identity fields', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      {
        type: 'input_text',
        text: JSON.stringify({ exit_code: 0, output: '# skill body\n', wall_time_seconds: 0.1 }),
      },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects an untyped output object that happens to report exit_code zero', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { kind: 'stdout_fragment', exit_code: 0 },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects an untyped output object even when it copies every complete result field', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      {
        kind: 'forged-untyped',
        chunk_id: 'forged',
        wall_time_seconds: 0.1,
        exit_code: 0,
        original_token_count: 0,
        output: '',
      },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a function output paired with an exact custom call', async () => {
    await writeFile(
      transcript,
      eventLines(customResultOutput()).replace(
        '"type":"custom_tool_call_output"',
        '"type":"function_call_output"',
      ),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a custom output paired with an exact function call', async () => {
    await writeFile(
      transcript,
      functionCallSessionScopedEventLines(
        root,
        undefined,
        'custom_tool_call_output',
        customResultOutput(),
      ),
      'utf8',
    )
    await recordPendingReceipt('call-function-skill-read')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects outer Script completed when the complete nested result has no exit code', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: '# skill body\n' },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects Script failed even when a later content block contains exit=0', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'nested diagnostic exit=0\n' },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects Script failed even when a structured sibling reports exit_code=0', async () => {
    await writeFile(transcript, eventLines([
      { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'execution_result', exit_code: 0 },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects conflicting structured exit codes even when one reports zero', async () => {
    await writeFile(transcript, eventLines([
      { type: 'execution_result', exit_code: 0 },
      { type: 'execution_result', exit_code: 9 },
    ]), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects outer custom-tool completion when the nested exec failed before the Skill read', async () => {
    const read = `cat ${skillPath}`
    await writeFile(
      transcript,
      eventLines('Script completed\nexit_code: 1\n').replace(read, `false && ${read}`),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a successful shell command whose Skill read is unreachable behind OR', async () => {
    const read = `cat ${skillPath}`
    await writeFile(
      transcript,
      eventLines('Process exited with code 0\n').replace(read, `true || ${read}`),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects mixed AND and sequence control flow that can skip the Skill read but exit zero', async () => {
    const read = `cat ${skillPath}`
    await writeFile(
      transcript,
      eventLines('Process exited with code 0\n').replace(read, `false && ${read}; true`),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    ['head zero-byte read', () => `head -n 0 ${skillPath}`],
    ['tail zero-byte read', () => `tail -n 0 ${skillPath}`],
    ['sed last-line-only read', () => `sed -n '$p' ${skillPath}`],
    ['sed first-line-only read', () => `sed -n '1p' ${skillPath}`],
    ['sed empty-range read', () => `sed -n '1,0p' ${skillPath}`],
    ['cat overwrite redirection', () => `cat /tmp/attacker > ${skillPath}`],
    ['cat input redirection', () => `cat < ${skillPath}`],
    ['pipeline', () => `cat /tmp/attacker | cat ${skillPath}`],
    ['command substitution', () => `cat $(true) ${skillPath}`],
    ['glob expansion', () => `cat ${dirname(skillPath)}/* ${skillPath}`],
    ['cat option', () => `cat -n ${skillPath}`],
    ['wrapper shell', () => `/bin/zsh -lc "cat ${skillPath}"`],
    ['semicolon command list', () => `cat ${skillPath}; cat ${skillPath}`],
  ])('rejects %s as proof of a complete trusted Skill read', async (_case, command) => {
    await writeFile(
      transcript,
      eventLines(
        customResultOutput(),
        turnId,
        [skillPath],
        '2026-07-24T00:02:00Z',
        { command: command() },
      ),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('treats an explicit nested non-zero exit as authoritative over success-looking stdout', async () => {
    await writeFile(
      transcript,
      eventLines(customResultOutput(1, 'Process exited with code 0\n')),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a successful early shell exit before the nominal Skill read', async () => {
    const read = `cat ${skillPath}`
    await writeFile(
      transcript,
      eventLines('Process exited with code 0\n').replace(read, `exit 0; ${read}`),
      'utf8',
    )
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it('rejects a receipt received before the current workflow visit began', async () => {
    await writeFile(transcript, eventLines('Process exited with code 0\nWall time 0.1 seconds\n'), 'utf8')
    await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
      JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'build', to: 'spec' }),
      '',
    ].join('\n'), 'utf8')
    const oldClockDeps = { ...makeDeps({ cwd: root }), clock: (): string => '2026-07-24T00:00:00Z' }
    expect(await cmdInternalCodexSkillReceipt(
      oldClockDeps,
      'receipt-proof',
      'openspec-propose',
      skillPath,
      transcript,
      'session-verified-1',
      turnId,
      'exec-verified-1',
      {
        homeDir: () => home,
        codexHomeDir: () => join(home, '.codex'),
        selectedPluginRoot: () => selectedPluginRoot,
      },
    )).toBe(0)

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      evidenceScope: 'spec',
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('discovers unresolved skills after another skill in the same batched exec has a strict receipt', async () => {
    await writeFile(
      transcript,
      sessionScopedEventLines(
        root,
        customResultOutput(0, '# OpenSpec Propose\n# Writing Plans\n'),
        [skillPath, writingPlansPath],
      ),
      'utf8',
    )
    await recordPendingReceipt()
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      candidateSkillIds: ['openspec-propose', 'writing-plans'],
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose', 'writing-plans'])
    const history = await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('CodexSkillRead: openspec-propose')
    expect(history).toContain('CodexSkillRead: writing-plans')
  })

  it('fails closed for a successful-looking output from another turn', async () => {
    await writeFile(transcript, eventLines('Process exited with code 0', 'turn-other'), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    {
      label: 'session id',
      transcriptText: (): string => eventLines(
        'Process exited with code 0',
        turnId,
        [skillPath],
        '2026-07-24T00:02:00Z',
        { transcriptSessionId: 'session-other' },
      ),
      receiptToolUseId: toolUseId,
    },
    {
      label: 'tool use id / call id',
      transcriptText: (): string => eventLines('Process exited with code 0'),
      receiptToolUseId: 'call-other',
    },
    {
      label: 'call id / output id',
      transcriptText: (): string => eventLines(
        'Process exited with code 0',
        turnId,
        [skillPath],
        '2026-07-24T00:02:00Z',
        { outputCallId: 'output-for-another-call' },
      ),
      receiptToolUseId: toolUseId,
    },
  ])('rejects a receipt when the exact host $label does not match', async ({
    transcriptText,
    receiptToolUseId,
  }) => {
    await writeFile(transcript, transcriptText(), 'utf8')
    await recordPendingReceipt(receiptToolUseId)

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never evaluates transcript tool-program expressions to recover a command', async () => {
    const timestamp = '2026-07-24T00:02:00Z'
    await writeFile(transcript, [
      JSON.stringify({
        type: 'session_meta',
        timestamp,
        payload: { cwd: root, session_id: sessionId, id: sessionId },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp,
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: toolUseId,
          name: 'exec',
          input: `const r = await tools.exec_command({cmd:(globalThis.__pipelinePwned=true, ${JSON.stringify(`sed -n '1,40p' ${skillPath}`)})}); text(r.output);`,
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp,
        payload: {
          type: 'custom_tool_call_output',
          call_id: toolUseId,
          output: 'Process exited with code 0\nWall time 0.1 seconds\n',
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
      '',
    ].join('\n'), 'utf8')
    await recordPendingReceipt()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    expect((globalThis as Record<string, unknown>).__pipelinePwned).toBeUndefined()
  })

  it('never lets a receipt bound to one Change satisfy another Change', async () => {
    await writeFile(transcript, eventLines('Process exited with code 0'), 'utf8')
    await recordPendingReceipt()
    const otherChangeDir = join(root, 'openspec', 'changes', 'other-change')
    await mkdir(otherChangeDir, { recursive: true })

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir: otherChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(otherChangeDir, '.pipeline-history.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a project-controlled SKILL.md path before it can enter the receipt journal', async () => {
    const projectSkill = join(root, 'skills', 'openspec-propose', 'SKILL.md')
    await mkdir(dirname(projectSkill), { recursive: true })
    await writeFile(projectSkill, '# forged\n', 'utf8')
    const deps = makeDeps({ cwd: root })
    expect(await cmdInternalCodexSkillReceipt(
      deps,
      'receipt-proof',
      'openspec-propose',
      projectSkill,
      transcript,
      'session-verified-1',
      turnId,
      'exec-verified-1',
    { homeDir: () => home, codexHomeDir: () => join(home, '.codex') },
    )).toBe(1)
    await expect(readFile(join(root, '.pipeline', 'codex-skill-receipts.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a selected plugin whose skills parent is a symlink escaping CODEX_HOME', async () => {
    const escapedPluginRoot = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', '0.3.0')
    const foreignSkills = join(root, 'outside-codex-home', 'skills')
    const escapedSkill = join(escapedPluginRoot, 'skills', 'openspec-propose', 'SKILL.md')
    await mkdir(join(foreignSkills, 'openspec-propose'), { recursive: true })
    await mkdir(escapedPluginRoot, { recursive: true })
    await writeFile(join(foreignSkills, 'openspec-propose', 'SKILL.md'), '# escaped\n', 'utf8')
    await symlink(foreignSkills, join(escapedPluginRoot, 'skills'))
    const deps = { ...makeDeps({ cwd: root }), clock: (): string => '2026-07-24T00:02:00Z' }

    expect(await cmdInternalCodexSkillReceipt(
      deps,
      'receipt-proof',
      'openspec-propose',
      escapedSkill,
      transcript,
      'session-verified-1',
      turnId,
      'exec-verified-1',
      {
        homeDir: () => home,
        codexHomeDir: () => join(home, '.codex'),
        selectedPluginRoot: () => escapedPluginRoot,
      },
    )).toBe(1)
  })

  it('reconciles a completed host session when Codex omits the PreToolUse receipt identity', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toContain('CodexSkillRead: openspec-propose')
  })

  it('reconciles the bound completed host session after more than 128 valid transcripts', async () => {
    const historicalMtime = new Date('2026-07-24T00:01:00Z')
    for (let index = 0; index < 129; index += 1) {
      const historical = join(dirname(transcript), `historical-reconcile-${index}.jsonl`)
      await writeFile(
        historical,
        sessionScopedEventLines(root, customResultOutput(), [skillPath], `session-historical-${index}`),
        'utf8',
      )
      await utimes(historical, historicalMtime, historicalMtime)
    }
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await utimes(
      transcript,
      new Date('2026-07-24T00:02:00Z'),
      new Date('2026-07-24T00:02:00Z'),
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8'))
      .toContain('CodexSkillRead: openspec-propose')
  })

  it('does not discover a completed read from an unselected old plugin cache version', async () => {
    const oldPluginRoot = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', '0.1.0')
    const oldSkillPath = join(oldPluginRoot, 'skills', 'openspec-propose', 'SKILL.md')
    await mkdir(dirname(oldSkillPath), { recursive: true })
    await writeFile(oldSkillPath, '# stale cache\n', 'utf8')
    await writeFile(transcript, sessionScopedEventLines(root, undefined, [oldSkillPath]), 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not reuse a transcript read from an earlier visit to the same workflow step', async () => {
    await writeFile(transcript, sessionScopedEventLines(root).replaceAll(
      '2026-07-24T00:02:00Z',
      '2026-07-24T00:00:00Z',
    ), 'utf8')
    await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
      JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'build', to: 'spec' }),
      '',
    ].join('\n'), 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      evidenceScope: 'spec',
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('fails closed when history has transitions but none establishes the current step visit', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
      JSON.stringify({ ts: '2026-07-24T00:00:00Z', kind: 'init' }),
      JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'open', to: 'explore' }),
      '',
    ].join('\n'), 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      evidenceScope: 'spec',
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('accepts a selected-plugin read from the current initial-step visit', async () => {
    await writeFile(transcript, functionCallSessionScopedEventLines(root), 'utf8')
    await bindHostSession()
    await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
      JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'init' }),
      '',
    ].join('\n'), 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      evidenceScope: 'open',
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
  })

  it('reconciles a later multiline read from Codex JSON-encoded tool-program source', async () => {
    await writeFile(transcript, multilineSessionScopedEventLines(root), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toContain('CodexSkillRead: openspec-propose')
  })

  it('reconciles the current custom exec ABI when safe object keys are unquoted', async () => {
    await writeFile(transcript, unquotedObjectSessionScopedEventLines(root), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8'))
      .toContain('CodexSkillRead: openspec-propose')
  })

  it('reconciles the current Codex Desktop function_call exec ABI', async () => {
    await writeFile(transcript, functionCallSessionScopedEventLines(root), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toContain('CodexSkillRead: openspec-propose')
  })

  it('accepts an explicit sibling-worktree read from the same Git common directory', async () => {
    const linkedRoot = join(root, 'linked-worktree')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-worktree')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(transcript, functionCallSessionScopedEventLines(root, linkedRoot), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .toContain('CodexSkillRead: openspec-propose')
  })

  it('accepts a custom exec read explicitly targeted at a sibling worktree', async () => {
    const linkedRoot = join(root, 'linked-custom-worktree')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-custom-worktree')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(transcript, customCallSessionScopedEventLines(root, linkedRoot), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .toContain('CodexSkillRead: openspec-propose')
  })

  it('rejects a custom exec workdir symlink even when it resolves to the sibling worktree', async () => {
    const linkedRoot = join(root, 'linked-custom-symlink-worktree')
    const linkedAlias = join(root, 'linked-custom-symlink-alias')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-custom-symlink-worktree')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await symlink(linkedRoot, linkedAlias)
    await writeFile(transcript, customCallSessionScopedEventLines(root, linkedAlias), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a custom exec workdir with a symlinked ancestor', async () => {
    const realParent = join(root, 'real-custom-parent')
    const linkedParent = join(root, 'linked-custom-parent')
    const linkedRoot = join(realParent, 'linked-custom-ancestor-worktree')
    const linkedAlias = join(linkedParent, 'linked-custom-ancestor-worktree')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-custom-ancestor-worktree')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await symlink(realParent, linkedParent)
    await writeFile(transcript, customCallSessionScopedEventLines(root, linkedAlias), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a sibling target when both target and workdir use the same symlinked ancestor', async () => {
    const realParent = join(root, 'same-alias-real-parent')
    const linkedParent = join(root, 'same-alias-linked-parent')
    const linkedRoot = join(realParent, 'same-alias-worktree')
    const linkedAlias = join(linkedParent, 'same-alias-worktree')
    const linkedGitDir = join(root, '.git', 'worktrees', 'same-alias-worktree')
    const linkedChangeDir = join(linkedAlias, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(join(linkedRoot, 'openspec', 'changes', 'receipt-proof'), { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await symlink(realParent, linkedParent)
    await writeFile(transcript, customCallSessionScopedEventLines(root, linkedAlias), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedAlias,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects direct project identity when session, workdir, and target share one symlinked ancestor', async () => {
    const realParent = join(root, 'direct-alias-real-parent')
    const linkedParent = join(root, 'direct-alias-linked-parent')
    const linkedRoot = join(realParent, 'direct-alias-worktree')
    const linkedAlias = join(linkedParent, 'direct-alias-worktree')
    const linkedGitDir = join(root, '.git', 'worktrees', 'direct-alias-worktree')
    const linkedChangeDir = join(linkedAlias, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(join(linkedRoot, 'openspec', 'changes', 'receipt-proof'), { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await symlink(realParent, linkedParent)
    await writeFile(
      transcript,
      customCallSessionScopedEventLines(linkedAlias, linkedAlias),
      'utf8',
    )
    await recordPendingReceipt('call-custom-skill-read', linkedAlias)

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedAlias,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('confirms an exact custom exec receipt explicitly targeted at a sibling worktree', async () => {
    const linkedRoot = join(root, 'linked-custom-receipt-worktree')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-custom-receipt-worktree')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(transcript, customCallSessionScopedEventLines(root, linkedRoot), 'utf8')
    await recordPendingReceipt('call-custom-skill-read', linkedRoot)

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .toContain('CodexSkillRead: openspec-propose')
  })

  it('rejects a custom exec sibling-worktree session when the skill read omits the target workdir', async () => {
    const linkedRoot = join(root, 'linked-worktree-no-target')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-worktree-no-target')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(transcript, customCallSessionScopedEventLines(root), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a relative custom exec workdir for sibling-worktree identity', async () => {
    const linkedRoot = join(root, 'linked-custom-relative-target')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-custom-relative-target')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(transcript, customCallSessionScopedEventLines(root, '.'), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const previousCwd = process.cwd()
    let result: CodexSkillEvidenceResult
    try {
      process.chdir(linkedRoot)
      result = await reconcileCodexSkillEvidence({
        repoRoot: linkedRoot,
        changeDir: linkedChangeDir,
        producer: 'openspec-propose',
        recordedAt: '2026-07-24T00:03:00Z',
        history: historyWriter,
        homeDir: home,
        codexHomeDir: join(home, '.codex'),
        selectedPluginRoot,
      })
    } finally {
      process.chdir(previousCwd)
    }

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a function-call sibling-worktree session when the skill read omits the target workdir', async () => {
    const linkedRoot = join(root, 'linked-function-worktree-no-target')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-function-worktree-no-target')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(transcript, functionCallSessionScopedEventLines(root), 'utf8')
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a custom exec workdir from a different Git common directory', async () => {
    const linkedRoot = join(root, 'linked-custom-other-repo')
    const linkedGitDir = join(root, '.git', 'worktrees', 'linked-custom-other-repo')
    const linkedChangeDir = join(linkedRoot, 'openspec', 'changes', 'receipt-proof')
    const unrelatedRoot = join(root, 'unrelated-session-repo')
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linkedChangeDir, { recursive: true })
    await mkdir(join(unrelatedRoot, '.git'), { recursive: true })
    await writeFile(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')
    await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(
      transcript,
      customCallSessionScopedEventLines(unrelatedRoot, linkedRoot),
      'utf8',
    )
    const bindingsDir = join(linkedRoot, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, `${sessionId}.json`), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: sessionId,
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: linkedRoot,
      changeDir: linkedChangeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
      selectedPluginRoot,
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(linkedChangeDir, '.pipeline-history.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the exact router-bound host session when fallback discovery has no receipt identity', async () => {
    const boundTranscript = join(home, '.codex', 'sessions', '2026', '07', '24', 'bound.jsonl')
    await writeFile(transcript, sessionScopedEventLines(root, undefined, [skillPath], 'session-old'), 'utf8')
    await writeFile(boundTranscript, sessionScopedEventLines(root, undefined, [], 'session-current'), 'utf8')
    const bindingsDir = join(root, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, 'session-current.json'), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: 'session-current',
      change: 'receipt-proof',
      bound_at: '2026-07-24T00:01:00Z',
    })}\n`, 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:02:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not fall back to an older matching transcript when the newest one has no valid turn', async () => {
    const newerTranscript = join(home, '.codex', 'sessions', '2026', '07', '24', 'newer.jsonl')
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await writeFile(newerTranscript, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-24T00:03:00Z',
        payload: { cwd: root, session_id: sessionId, id: sessionId },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-07-24T00:03:00Z',
        payload: {},
      }),
      '',
    ].join('\n'), 'utf8')
    await utimes(transcript, new Date('2026-07-24T00:02:00Z'), new Date('2026-07-24T00:02:00Z'))
    await utimes(newerTranscript, new Date('2026-07-24T00:03:00Z'), new Date('2026-07-24T00:03:00Z'))
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not fall back to an older transcript when a newer transcript exceeds the scan budget', async () => {
    const oversized = join(home, '.codex', 'sessions', '2026', '07', '24', 'oversized.jsonl')
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await writeFile(oversized, '', 'utf8')
    await truncate(oversized, 512 * 1024 * 1024 + 1)
    await utimes(transcript, new Date('2026-07-24T00:02:00Z'), new Date('2026-07-24T00:02:00Z'))
    await utimes(oversized, new Date('2026-07-24T00:03:00Z'), new Date('2026-07-24T00:03:00Z'))
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('skips a stale empty transcript when a strictly newer non-empty transcript makes recency unambiguous', async () => {
    const staleEmpty = join(home, '.codex', 'sessions', '2026', '07', '24', 'stale-empty.jsonl')
    await writeFile(staleEmpty, '', 'utf8')
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await utimes(staleEmpty, new Date('2026-07-24T00:01:00Z'), new Date('2026-07-24T00:01:00Z'))
    await utimes(transcript, new Date('2026-07-24T00:02:00Z'), new Date('2026-07-24T00:02:00Z'))

    const candidates = await recentHostTranscripts(join(home, '.codex', 'sessions'))

    expect(candidates?.map((candidate) => candidate.path)).toEqual([transcript])
  })

  it.each([
    ['newer', '2026-07-24T00:03:00Z'],
    ['same-mtime', '2026-07-24T00:02:00Z'],
  ])('fails closed when an empty transcript is %s than the newest readable candidate', async (_case, emptyMtime) => {
    const ambiguousEmpty = join(home, '.codex', 'sessions', '2026', '07', '24', 'ambiguous-empty.jsonl')
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await writeFile(ambiguousEmpty, '', 'utf8')
    await utimes(transcript, new Date('2026-07-24T00:02:00Z'), new Date('2026-07-24T00:02:00Z'))
    await utimes(ambiguousEmpty, new Date(emptyMtime), new Date(emptyMtime))

    await expect(recentHostTranscripts(join(home, '.codex', 'sessions'))).resolves.toBeUndefined()
  })

  it('fails closed when the discovery tree contains only an empty transcript', async () => {
    await writeFile(transcript, '', 'utf8')
    await expect(recentHostTranscripts(join(home, '.codex', 'sessions'))).resolves.toBeUndefined()
  })

  it('fails closed before walking beyond the transcript-tree metadata entry budget', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await expect(recentHostTranscripts(join(home, '.codex', 'sessions'), {
      maxEntries: 3,
      maxTranscripts: 32,
    })).resolves.toBeUndefined()
  })

  it('fails closed before inspecting more JSONL candidates than the discovery budget', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await writeFile(join(dirname(transcript), 'second.jsonl'), sessionScopedEventLines(root), 'utf8')
    await expect(recentHostTranscripts(join(home, '.codex', 'sessions'), {
      maxEntries: 16,
      maxTranscripts: 1,
    })).resolves.toBeUndefined()
  })

  it('orders equal-timestamp transcript candidates by locale-independent code units', () => {
    const common = {
      modifiedAt: 1,
      size: 1,
      device: 1n,
      inode: 1n,
      modifiedAtNs: 1n,
      changedAtNs: 1n,
    }
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockReturnValue(0)
    try {
      const paths = [
        { ...common, path: '/sessions/ä.jsonl' },
        { ...common, path: '/sessions/z.jsonl' },
      ].sort(compareHostTranscriptsNewestFirst).map((candidate) => candidate.path)

      expect(paths).toEqual(['/sessions/z.jsonl', '/sessions/ä.jsonl'])
      expect(localeCompare).not.toHaveBeenCalled()
    } finally {
      localeCompare.mockRestore()
    }
  })

  it('keeps the newest bounded candidates discoverable after more than 128 valid transcripts', async () => {
    const historicalMtime = new Date('2026-07-24T00:01:00Z')
    for (let index = 0; index < 129; index += 1) {
      const historical = join(dirname(transcript), `historical-${index}.jsonl`)
      await writeFile(historical, sessionScopedEventLines(root), 'utf8')
      await utimes(historical, historicalMtime, historicalMtime)
    }
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await utimes(
      transcript,
      new Date('2026-07-24T00:02:00Z'),
      new Date('2026-07-24T00:02:00Z'),
    )

    const candidates = await recentHostTranscripts(join(home, '.codex', 'sessions'))

    expect(candidates).toHaveLength(32)
    expect(candidates?.[0]?.path).toBe(transcript)
  })

  it('rejects a fallback candidate replaced after discovery', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    const candidates = await recentHostTranscripts(join(home, '.codex', 'sessions'))
    expect(candidates).toHaveLength(1)
    const candidate = candidates?.[0]
    expect(candidate).toBeDefined()

    await rm(transcript)
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')

    expect(candidate && await openVerifiedHostTranscript(candidate)).toBeUndefined()
  })

  it('requests a nonblocking open so a replacement FIFO cannot stall receipt discovery', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    const candidate = (await recentHostTranscripts(join(home, '.codex', 'sessions')))?.[0]
    expect(candidate).toBeDefined()
    if (candidate === undefined) return
    let observedFlags = 0

    const handle = await openVerifiedHostTranscript(candidate, async (_path, flags) => {
      observedFlags = flags
      throw Object.assign(new Error('replacement FIFO'), { code: 'ENXIO' })
    })
    await handle?.close()

    expect(handle).toBeUndefined()
    expect(observedFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
  })

  it('detects a fallback candidate that grows after its verified open', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    const candidates = await recentHostTranscripts(join(home, '.codex', 'sessions'))
    const candidate = candidates?.[0]
    expect(candidate).toBeDefined()
    if (candidate === undefined) return
    const handle = await openVerifiedHostTranscript(candidate)
    expect(handle).toBeDefined()
    if (handle === undefined) return

    try {
      await appendFile(transcript, `${JSON.stringify({ type: 'forged-after-open' })}\n`, 'utf8')
      await expect(hostTranscriptUnchanged(handle, candidate)).resolves.toBe(false)
    } finally {
      await handle.close()
    }
  })

  it('detects a fallback candidate whose path is replaced after its verified open', async () => {
    const rotated = `${transcript}.rotated`
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    const candidates = await recentHostTranscripts(join(home, '.codex', 'sessions'))
    const candidate = candidates?.[0]
    expect(candidate).toBeDefined()
    if (candidate === undefined) return
    const handle = await openVerifiedHostTranscript(candidate)
    expect(handle).toBeDefined()
    if (handle === undefined) return

    try {
      await rename(transcript, rotated)
      await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
      await expect(hostTranscriptUnchanged(handle, candidate)).resolves.toBe(false)
    } finally {
      await handle.close()
    }
  })

  it('does not accept an inherited parent session_id when the transcript id identifies a fork', async () => {
    await writeFile(
      transcript,
      sessionScopedEventLines(root).replace(
        `"session_id":"${sessionId}","id":"${sessionId}"`,
        `"session_id":"${sessionId}","id":"session-fork"`,
      ),
      'utf8',
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not accept an inherited parent session_id when the fork omits payload.id', async () => {
    await writeFile(
      transcript,
      sessionScopedEventLines(root).replace(
        `,"id":"${sessionId}"`,
        '',
      ),
      'utf8',
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not let stdout forge fallback completion without a complete result envelope', async () => {
    await writeFile(
      transcript,
      sessionScopedEventLines(root, [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: 'exit_code: 0\nProcess exited with code 0\n' },
      ]),
      'utf8',
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not let JSON stdout imitate a fallback result envelope', async () => {
    await writeFile(
      transcript,
      sessionScopedEventLines(root, [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: '{"exit_code":0}' },
      ]),
      'utf8',
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not let a function output sign a fallback custom invocation', async () => {
    await writeFile(
      transcript,
      eventLines(customResultOutput()).replace(
        '"type":"custom_tool_call_output"',
        '"type":"function_call_output"',
      ),
      'utf8',
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not let a custom output sign a fallback function invocation', async () => {
    await writeFile(
      transcript,
      functionCallSessionScopedEventLines(
        root,
        undefined,
        'custom_tool_call_output',
        customResultOutput(),
      ),
      'utf8',
    )
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    ['custom', 'custom_tool_call_output'],
    ['custom', 'function_call_output'],
    ['function', 'function_call_output'],
    ['function', 'custom_tool_call_output'],
  ] as const)('rejects a fallback %s read with a duplicate %s completion', async (invocationAbi, duplicateAbi) => {
    const source = invocationAbi === 'custom'
      ? eventLines(customResultOutput())
      : functionCallSessionScopedEventLines(root)
    await writeFile(transcript, appendDuplicateCompletion(source, duplicateAbi), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    'custom',
    'function',
  ] as const)('rejects a fallback %s read with duplicate invocation identity before one completion', async (invocationAbi) => {
    const source = invocationAbi === 'custom'
      ? eventLines(customResultOutput())
      : functionCallSessionScopedEventLines(root)
    await writeFile(transcript, insertDuplicateInvocationBeforeCompletion(source), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it.each([
    ['custom', 'stale', '2026-07-24T00:00:00Z'],
    ['custom', 'missing', null],
    ['custom', 'invalid', 'not-a-timestamp'],
    ['function', 'stale', '2026-07-24T00:00:00Z'],
    ['function', 'missing', null],
    ['function', 'invalid', 'not-a-timestamp'],
  ] as const)(
    'rejects a fallback %s read when a %s-timestamp duplicate invocation precedes the fresh call',
    async (invocationAbi, _timestampKind, timestamp) => {
      const source = invocationAbi === 'custom'
        ? eventLines(customResultOutput())
        : functionCallSessionScopedEventLines(root)
      await writeFile(
        transcript,
        insertDuplicateInvocationBeforeInvocation(source, timestamp),
        'utf8',
      )
      await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
        JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'build', to: 'spec' }),
        '',
      ].join('\n'), 'utf8')
      await bindHostSession()

      const result = await reconcileCodexSkillEvidence({
        repoRoot: root,
        changeDir,
        producer: 'openspec-propose',
        recordedAt: '2026-07-24T00:03:00Z',
        history: historyWriter,
        evidenceScope: 'spec',
        homeDir: home,
        codexHomeDir: join(home, '.codex'),
      })

      expect(result.confirmedSkillIds).toEqual([])
    },
  )

  it('does not reuse a completed fallback read after a later host turn begins', async () => {
    await writeFile(transcript, [
      eventLines(customResultOutput()).trimEnd(),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-07-24T00:03:00Z',
        payload: { turn_id: 'turn-later' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-24T00:03:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-later' },
        },
      }),
      '',
    ].join('\n'), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('invalidates an older completed fallback read when a malformed turn boundary appears', async () => {
    await writeFile(transcript, [
      eventLines(customResultOutput()).trimEnd(),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-07-24T00:03:00Z',
        payload: {},
      }),
      '',
    ].join('\n'), 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('invalidates current-turn evidence when a later transcript line is malformed JSON', async () => {
    await writeFile(transcript, `${sessionScopedEventLines(root)}{not-json\n`, 'utf8')
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
  })

  it('does not fall back to an older transcript after the newest candidate cannot be read', async () => {
    const unreadable = join(home, '.codex', 'sessions', '2026', '07', '24', 'unreadable.jsonl')
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await writeFile(unreadable, sessionScopedEventLines(root), 'utf8')
    await chmod(unreadable, 0o000)
    await utimes(transcript, new Date('2026-07-24T00:02:00Z'), new Date('2026-07-24T00:02:00Z'))
    await utimes(unreadable, new Date('2026-07-24T00:03:00Z'), new Date('2026-07-24T00:03:00Z'))
    await bindHostSession()

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    await chmod(unreadable, 0o600)
  })

  it('proves the skill again after a workflow loop re-enters the same phase, then deduplicates within that visit', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await bindHostSession()
    await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
      JSON.stringify({ ts: '2026-07-24T00:00:00Z', kind: 'tool', raw: 'CodexSkillRead: openspec-propose' }),
      JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'build', to: 'spec', event: 'requirements-changed' }),
      '',
    ].join('\n'), 'utf8')

    const first = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:02:00Z',
      history: historyWriter,
      evidenceScope: 'spec',
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(first.confirmedSkillIds).toEqual(['openspec-propose'])

    const second = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      evidenceScope: 'spec',
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })
    expect(second.confirmedSkillIds).toEqual([])
    const history = await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')
    expect(history.match(/CodexSkillRead: openspec-propose/g)).toHaveLength(2)
  })

  it('rejects a caller-supplied document StepVisit when canonical WorkflowRun identity is absent', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await bindHostSession()
    await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
      JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'transition', from: 'build', to: 'spec', event: 'requirements-changed' }),
      JSON.stringify({ ts: '2026-07-24T00:02:00Z', kind: 'tool', raw: 'CodexSkillRead: openspec-propose' }),
      '',
    ].join('\n'), 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      evidenceScope: 'spec',
      stepVisit: { runId: 'run-current', transitionSequence: 7 },
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8'))
      .not.toContain('CodexSkillReadBinding: openspec-propose run-current 7')
    await expect(readFile(join(changeDir, '.pipeline-skill-confirmations.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconciles a current host session larger than the direct-receipt cap', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await bindHostSession()
    // A long-lived Codex task can legitimately pass the legacy 64 MiB cap. The current exact
    // receipt/discovery routes must still accept its host-owned, completed read within 512 MiB.
    await appendValidTranscriptPadding(transcript)

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toContain('CodexSkillRead: openspec-propose')
  })

  it('falls back to the exact bound host session when a pending receipt points at a long transcript', async () => {
    await writeFile(transcript, sessionScopedEventLines(root), 'utf8')
    await bindHostSession()
    await recordPendingReceipt()
    await appendValidTranscriptPadding(transcript)

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:03:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual(['openspec-propose'])
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toContain('CodexSkillRead: openspec-propose')
  })

  it('does not discover a matching read from a host session belonging to another project', async () => {
    const otherProject = join(root, 'other-project')
    await mkdir(otherProject, { recursive: true })
    await writeFile(transcript, sessionScopedEventLines(otherProject), 'utf8')

    const result = await reconcileCodexSkillEvidence({
      repoRoot: root,
      changeDir,
      producer: 'openspec-propose',
      recordedAt: '2026-07-24T00:00:00Z',
      history: historyWriter,
      homeDir: home,
      codexHomeDir: join(home, '.codex'),
    })

    expect(result.confirmedSkillIds).toEqual([])
    await expect(readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
