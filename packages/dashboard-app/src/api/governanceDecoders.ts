import type {
  ChangeHistoryEntry,
  ChangeSessionLaunch,
  CreatedChange,
  WbHookEvent,
  WbHookMeta,
  WbHooksConfig,
  WbRouterPreview,
  WbRouterPreviewCandidate,
  WbTrackDefinition,
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

function decodeTrack(value: unknown): WbTrackDefinition | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || typeof value.builtin !== 'boolean'
    || !isRecord(value.workflow)
    || typeof value.workflow.default !== 'string'
    || (value.workflow.allowed !== '*' && !stringArray(value.workflow.allowed))
    || !isRecord(value.policyProfile)) return null
  const profile = value.policyProfile
  if ((profile.reviewSeed !== 'pending' && profile.reviewSeed !== 'skipped')
    || (profile.autoEnqueueOnSpecComplete !== undefined && typeof profile.autoEnqueueOnSpecComplete !== 'boolean')
    || typeof profile.automationEligible !== 'boolean'
    || !['none', 'pm', 'frontend', 'backend'].includes(String(profile.coverageProfile))
    || !isRecord(profile.routing)
    || typeof profile.routing.enabled !== 'boolean'
    || !isRecord(profile.skills)
    || typeof profile.skills.matrix !== 'boolean'
    || typeof profile.skills.profile !== 'string') return null
  let routing: WbTrackDefinition['policyProfile']['routing']
  if (profile.routing.enabled === false) routing = { enabled: false }
  else {
    if (typeof profile.routing.pattern !== 'string'
      || !optionalString(profile.routing.excludePattern)
      || typeof profile.routing.priority !== 'number') return null
    routing = {
      enabled: true,
      pattern: profile.routing.pattern,
      ...(profile.routing.excludePattern === undefined ? {} : { excludePattern: profile.routing.excludePattern }),
      priority: profile.routing.priority,
    }
  }
  const coverageProfile = profile.coverageProfile
  if (coverageProfile !== 'none' && coverageProfile !== 'pm' && coverageProfile !== 'frontend' && coverageProfile !== 'backend') {
    return null
  }
  return {
    id: value.id,
    label: value.label,
    builtin: value.builtin,
    workflow: { default: value.workflow.default, allowed: value.workflow.allowed },
    policyProfile: {
      reviewSeed: profile.reviewSeed,
      ...(profile.autoEnqueueOnSpecComplete === undefined
        ? {}
        : { autoEnqueueOnSpecComplete: profile.autoEnqueueOnSpecComplete }),
      automationEligible: profile.automationEligible,
      coverageProfile,
      routing,
      skills: { matrix: profile.skills.matrix, profile: profile.skills.profile },
    },
  }
}

function decodeCandidate(value: unknown): WbRouterPreviewCandidate | null {
  if (!isRecord(value)
    || typeof value.order !== 'number'
    || typeof value.priority !== 'number'
    || typeof value.score !== 'number'
    || typeof value.routable !== 'boolean'
    || typeof value.excluded !== 'boolean') return null
  const track = decodeTrack(value.track)
  return track
    ? {
        track,
        order: value.order,
        priority: value.priority,
        score: value.score,
        routable: value.routable,
        excluded: value.excluded,
      }
    : null
}

export function decodeRouterPreview(value: unknown): WbRouterPreview | null {
  if (!isRecord(value)
    || value.ok !== true
    || typeof value.revision !== 'string'
    || (value.source !== 'builtin-only' && value.source !== 'project-file')
    || !Array.isArray(value.candidates)) return null
  const candidates: WbRouterPreviewCandidate[] = []
  for (const candidate of value.candidates) {
    const decoded = decodeCandidate(candidate)
    if (!decoded) return null
    candidates.push(decoded)
  }
  const winner = value.winner === null ? null : decodeCandidate(value.winner)
  if (value.winner !== null && !winner) return null
  const suppressedReason = value.suppressed_reason
  if (suppressedReason !== null
    && suppressedReason !== 'system-notification'
    && suppressedReason !== 'slash-command'
    && suppressedReason !== 'discussion') return null
  return {
    ok: true,
    revision: value.revision,
    source: value.source,
    winner,
    candidates,
    suppressed_reason: suppressedReason,
  }
}

function decodeSession(value: unknown): ChangeSessionLaunch | null {
  if (!isRecord(value)
    || typeof value.requested !== 'boolean'
    || typeof value.active !== 'boolean'
    || !['not_requested', 'unavailable', 'failed', 'degraded', 'active'].includes(String(value.status))
    || (value.exit_code !== null && typeof value.exit_code !== 'number')) return null
  const status = value.status
  if (status !== 'not_requested' && status !== 'unavailable' && status !== 'failed' && status !== 'degraded' && status !== 'active') {
    return null
  }
  return { requested: value.requested, active: value.active, status, exit_code: value.exit_code }
}

export function decodeCreatedChange(value: unknown): CreatedChange | null {
  if (!isRecord(value)
    || value.ok !== true
    || typeof value.name !== 'string'
    || !optionalString(value.path)
    || (value.task_prompt_saved !== undefined && typeof value.task_prompt_saved !== 'boolean')) return null
  const session = value.session === undefined ? undefined : decodeSession(value.session)
  if (value.session !== undefined && !session) return null
  return {
    ok: true,
    name: value.name,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.task_prompt_saved === undefined ? {} : { task_prompt_saved: value.task_prompt_saved }),
    ...(session ? { session } : {}),
  }
}
