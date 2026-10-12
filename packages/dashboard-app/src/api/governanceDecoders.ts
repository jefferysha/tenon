import type {
  ChangeHistoryEntry,
  WbHookEvent,
  WbHookMeta,
  WbHooksConfig,
} from './governanceTypes'
import { isRecord, optionalString, stringArray } from './transport'

function isHookEvent(value: unknown): value is WbHookEvent {
  return value === 'SessionStart'
    || value === 'UserPromptSubmit'
    || value === 'PreToolUse'
    || value === 'PostToolUse'
}

export function isPromptSkipKeyword(value: unknown): value is string {
  return typeof value === 'string'
    && (value === '' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value))
}

export function decodeNames(value: unknown): string[] | null {
  return isRecord(value) && stringArray(value.names) ? value.names : null
}

export function decodeHooksConfig(value: unknown): WbHooksConfig | null {
  if (!isRecord(value) || !Array.isArray(value.hooks) || !isRecord(value.matrix)) return null
  const hooks: WbHookMeta[] = []
  for (const hook of value.hooks) {
    if (!isRecord(hook)
      || typeof hook.id !== 'string'
      || !isHookEvent(hook.event)
      || !optionalString(hook.matcher)
      || !optionalString(hook.script)
      || typeof hook.configurable !== 'boolean') return null
    hooks.push({
      id: hook.id,
      event: hook.event,
      matcher: hook.matcher ?? '',
      script: hook.script ?? '',
      configurable: hook.configurable,
    })
  }
  const matrix: Record<string, false> = {}
  for (const [key, state] of Object.entries(value.matrix)) {
    if (state !== false) return null
    matrix[key] = false
  }
  const promptSkipKeyword = value.prompt_skip_keyword === undefined
    ? 'no-tenon'
    : value.prompt_skip_keyword
  if (!isPromptSkipKeyword(promptSkipKeyword)) return null
  return { hooks, matrix, promptSkipKeyword }
}

function decodeHistoryActor(value: unknown): ChangeHistoryEntry['actor'] | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || value.trust !== 'declared') return null
  return { id: value.id, name: value.name, trust: 'declared' }
}

export function decodeHistory(value: unknown): ChangeHistoryEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null
  const entries: ChangeHistoryEntry[] = []
  for (const entry of value.entries) {
    if (!isRecord(entry)
      || typeof entry.ts !== 'string'
      || typeof entry.kind !== 'string'
      || !optionalString(entry.field)
      || !optionalString(entry.from)
      || !optionalString(entry.to)
      || (entry.actor !== undefined && decodeHistoryActor(entry.actor) === null)
      || !optionalString(entry.raw)) return null
    const actor = entry.actor === undefined ? null : decodeHistoryActor(entry.actor)
    entries.push({
      ts: entry.ts,
      kind: entry.kind,
      ...(entry.field === undefined ? {} : { field: entry.field }),
      ...(entry.from === undefined ? {} : { from: entry.from }),
      ...(entry.to === undefined ? {} : { to: entry.to }),
      ...(actor === null || actor === undefined ? {} : { actor }),
      ...(entry.raw === undefined ? {} : { raw: entry.raw }),
    })
  }
  return entries
}
