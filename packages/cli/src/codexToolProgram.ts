interface ParsedString {
  readonly value: string
  readonly end: number
}

function jsonStringAt(source: string, start: number): ParsedString | undefined {
  if (source[start] !== '"') return undefined
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char !== '"') continue
    try {
      const value = JSON.parse(source.slice(start, index + 1)) as unknown
      return typeof value === 'string' ? { value, end: index + 1 } : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export interface TranscriptExecInvocation {
  readonly command: string
  readonly workdir?: string
}

const COMPLETE_OUTPUT_SAFE_EXEC_ARGUMENTS = new Set([
  'cmd',
  'command',
  'justification',
  'login',
  'max_output_tokens',
  'prefix_rule',
  'sandbox_permissions',
  'tty',
  'workdir',
  'yield_time_ms',
])

export function isCompleteOutputSafeExecArguments(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).every((key) => COMPLETE_OUTPUT_SAFE_EXEC_ARGUMENTS.has(key))
    && (
      !Object.hasOwn(value, 'max_output_tokens')
      || (
        Number.isSafeInteger((value as Record<string, unknown>).max_output_tokens)
        && Number((value as Record<string, unknown>).max_output_tokens) > 0
      )
    )
}

function safePrimitiveEnd(source: string, start: number): number | undefined {
  const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?|true|false|null)\b/
    .exec(source.slice(start))
  return match ? start + match[0].length : undefined
}

function isSafePositiveIntegerLiteral(source: string, start: number, end: number): boolean {
  try {
    const value = JSON.parse(source.slice(start, end)) as unknown
    return Number.isSafeInteger(value) && Number(value) > 0
  } catch {
    return false
  }
}

function invocationFromSafeObjectLiteral(source: string): TranscriptExecInvocation | undefined {
  let cursor = 1
  let command: string | undefined
  let workdir: string | undefined
  while (cursor < source.length - 1) {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    const quotedKey = jsonStringAt(source, cursor)
    let key: string
    if (quotedKey) {
      key = quotedKey.value
      cursor = quotedKey.end
    } else {
      const identifier = /^[$A-Z_a-z][$\w]*/.exec(source.slice(cursor))
      if (!identifier) return undefined
      key = identifier[0]
      cursor += key.length
    }
    if (!COMPLETE_OUTPUT_SAFE_EXEC_ARGUMENTS.has(key)) return undefined
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== ':') return undefined
    cursor += 1
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    const stringValue = jsonStringAt(source, cursor)
    if (key === 'cmd' || key === 'command') {
      if (command !== undefined || !stringValue) return undefined
      command = stringValue.value
    } else if (key === 'workdir') {
      if (workdir !== undefined || !stringValue) return undefined
      workdir = stringValue.value
    }
    const valueEnd = stringValue?.end ?? safePrimitiveEnd(source, cursor)
    if (valueEnd === undefined) return undefined
    if (
      key === 'max_output_tokens'
      && (stringValue !== undefined || !isSafePositiveIntegerLiteral(source, cursor, valueEnd))
    ) return undefined
    cursor = valueEnd
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (cursor >= source.length - 1) break
    if (source[cursor] !== ',') return undefined
    cursor += 1
  }
  return command === undefined
    ? undefined
    : { command, ...(workdir === undefined ? {} : { workdir }) }
}

function invocationFromObjectLiteral(source: string): TranscriptExecInvocation | undefined {
  try {
    const parsed = JSON.parse(source) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (!isCompleteOutputSafeExecArguments(record)) return undefined
    if (record.cmd !== undefined && record.command !== undefined) return undefined
    const command = record.cmd ?? record.command
    if (typeof command !== 'string') return undefined
    if (record.workdir !== undefined && typeof record.workdir !== 'string') return undefined
    return {
      command,
      ...(typeof record.workdir === 'string' ? { workdir: record.workdir } : {}),
    }
  } catch {
    return invocationFromSafeObjectLiteral(source)
  }
}

/**
 * Decode only Codex's canonical completed exec wrappers:
 * `const result = await tools.exec_command({ ... }); text(result);` or the single-expression
 * `text(await tools.exec_command({ ... }));` that Codex also emits.
 * Anchoring the entire program proves the call is awaited and its complete result is forwarded;
 * comments, strings, dead code, extra statements, and self-authored success text fail closed.
 */
export function transcriptExecInvocations(input: string): readonly TranscriptExecInvocation[] {
  const pragma = /^\s*\/\/ @exec:([^\r\n]*)/.exec(input)
  if (pragma?.[1] !== undefined) {
    try {
      const parsed = JSON.parse(pragma[1].trim()) as unknown
      if (!isCompleteOutputSafeExecArguments(parsed)) return []
    } catch {
      return []
    }
  }
  const bound = /^\s*(?:(?:\/\/ @exec:[^\r\n]*\r?\n)\s*)?(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=\s*await\s+tools\.exec_command\s*\(/
    .exec(input)
  const inline = bound === null
    ? /^\s*(?:(?:\/\/ @exec:[^\r\n]*\r?\n)\s*)?text\s*\(\s*await\s+tools\.exec_command\s*\(/.exec(input)
    : null
  const prefix = bound ?? inline
  if (!prefix) return []
  const resultName = bound?.[1]
  if (bound && !resultName) return []
  let objectStart = prefix[0].length
  while (/\s/.test(input[objectStart] ?? '')) objectStart += 1
  if (input[objectStart] !== '{') return []

  let depth = 0
  let inString = false
  let escaped = false
  let objectEnd: number | undefined
  for (let index = objectStart; index < input.length; index += 1) {
    const char = input[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        objectEnd = index + 1
        break
      }
      if (depth < 0) break
    }
  }
  if (objectEnd === undefined) return []

  const invocation = invocationFromObjectLiteral(input.slice(objectStart, objectEnd))
  if (!invocation) return []
  const suffix = resultName === undefined
    ? /^\s*\)\s*\)\s*;?\s*$/
    : new RegExp(
      `^\\s*\\)\\s*;\\s*text\\s*\\(\\s*${resultName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)\\s*;?\\s*$`,
    )
  return suffix.test(input.slice(objectEnd)) ? [invocation] : []
}

/** Compatibility view for consumers that only need executed command values. */
export function transcriptExecCommands(input: string): readonly string[] {
  return transcriptExecInvocations(input).map((invocation) => invocation.command)
}
