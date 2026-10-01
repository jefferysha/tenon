/** Workflow-definition decoders: shared primitives, skills, agents and the decomposition/interaction policies. */
import { DEFAULT_WB_DECOMPOSITION_POLICY, DEFAULT_WB_INTERACTION_POLICY } from './governanceTypes'
import type {
  WbAgentSeverity, WbDecompositionMode, WbDecompositionPolicy, WbDecompositionStrategy,
  WbDecompositionTarget, WbExecutorRef, WbFieldRef, WbInteractionMode, WbInteractionPolicy,
  WbReviewerHost, WbReviewerRef, WbSkillEntry, WbSkillRef, WbStepAgents,
} from './governanceTypes'

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

export function decodeArray<T>(value: unknown, decode: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const entries: T[] = []
  for (const entry of value) {
    const decoded = decode(entry)
    if (decoded === null) return null
    entries.push(decoded)
  }
  return entries
}

export function decodeSkillSource(value: unknown): WbSkillEntry['source'] | null {
  return value === 'local-plugin'
    || value === 'external-marketplace'
    || value === 'builtin'
    || value === 'user'
    ? value
    : null
}

export function decodeSkillTier(value: unknown): WbSkillEntry['tier'] | null {
  return value === 'mandatory'
    || value === 'recommended'
    || value === 'conditional'
    || value === 'optional'
    ? value
    : null
}

export function decodeSkillEntry(value: unknown): WbSkillEntry | null {
  const item = record(value)
  if (!item || typeof item.name !== 'string' || typeof item.installed !== 'boolean') return null
  const source = decodeSkillSource(item.source)
  if (source === null) return null
  if (!optionalString(item.description) || !optionalString(item.installCmd) || !optionalString(item.version)) return null
  if (item.available !== undefined && typeof item.available !== 'boolean') return null
  const tier = item.tier === undefined ? undefined : decodeSkillTier(item.tier)
  if (tier === null) return null
  return {
    name: item.name,
    installed: item.installed,
    source,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(tier === undefined ? {} : { tier }),
    ...(item.available === undefined ? {} : { available: item.available }),
    ...(item.installCmd === undefined ? {} : { installCmd: item.installCmd }),
    ...(item.version === undefined ? {} : { version: item.version }),
  }
}

export function decodeSkillsRegistry(value: unknown): WbSkillEntry[] | null {
  const body = record(value)
  return body ? decodeArray(body.skills, decodeSkillEntry) : null
}

export function decodeField(value: unknown): WbFieldRef | null {
  const item = record(value)
  if (!item || typeof item.field !== 'string') return null
  if (item.type !== 'string' && item.type !== 'file_path' && item.type !== 'boolean') return null
  return { field: item.field, type: item.type }
}

export function decodeSkill(value: unknown): WbSkillRef | null {
  const item = record(value)
  if (!item
    || !allowedKeys(item, ['id', 'depends_on'])
    || typeof item.id !== 'string'
    || (item.depends_on !== undefined && !strings(item.depends_on))) return null
  return {
    id: item.id,
    ...(item.depends_on === undefined ? {} : { depends_on: item.depends_on }),
  }
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export const REVIEWER_HOSTS = ['codex', 'claude', 'any'] as const

export function decodeExecutor(value: unknown): WbExecutorRef | null {
  const item = record(value)
  if (!item
    || !allowedKeys(item, ['agent', 'depends_on'])
    || typeof item.agent !== 'string'
    || (item.depends_on !== undefined && !strings(item.depends_on))) return null
  return { agent: item.agent, ...(item.depends_on === undefined ? {} : { depends_on: item.depends_on }) }
}

export function decodeReviewer(value: unknown): WbReviewerRef | null {
  const item = record(value)
  const blockAt = item === null ? null : item.block_at
  if (!item
    || !allowedKeys(item, ['agent', 'required', 'block_at', 'depends_on', 'reads_tests', 'host'])
    || typeof item.agent !== 'string'
    || typeof item.required !== 'boolean'
    || !isMember<WbAgentSeverity>(blockAt, SEVERITIES)
    || (item.depends_on !== undefined && !strings(item.depends_on))
    || (item.reads_tests !== undefined && !strings(item.reads_tests))
    || (item.host !== undefined && !isMember<WbReviewerHost>(item.host, REVIEWER_HOSTS))) return null
  return {
    agent: item.agent,
    required: item.required,
    block_at: blockAt,
    ...(item.depends_on === undefined ? {} : { depends_on: item.depends_on }),
    ...(item.reads_tests === undefined ? {} : { reads_tests: item.reads_tests }),
    ...(item.host === undefined ? {} : { host: item.host as WbReviewerHost }),
  }
}

export function decodeStepAgents(value: unknown): WbStepAgents | null {
  const item = record(value)
  if (!item || !allowedKeys(item, ['executors', 'reviewers'])) return null
  const executors = item.executors === undefined ? [] : decodeArray(item.executors, decodeExecutor)
  const reviewers = item.reviewers === undefined ? [] : decodeArray(item.reviewers, decodeReviewer)
  if (executors === null || reviewers === null) return null
  return { executors, reviewers }
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index])
}

export function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

export const DECOMPOSITION_MODES = ['off', 'suggest', 'auto-safe', 'require-review'] as const
export const DECOMPOSITION_TARGETS = ['work-items', 'child-pipelines'] as const
export const DECOMPOSITION_STRATEGIES = ['balanced', 'breadth-first', 'depth-first'] as const
export const DECOMPOSITION_AUTO_WHEN = [
  'independent-work-items',
  'cross-component-boundary',
  'context-budget-risk',
] as const
export const DECOMPOSITION_ASK_WHEN = [
  'ambiguous-requirements',
  'hard-boundary',
  'missing-authorization',
  'limit-exceeded',
] as const
export const INTERACTION_MODES = ['interactive', 'recommended-defaults', 'afk'] as const

export function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  if (typeof value !== 'string') return false
  return values.some((candidate) => candidate === value)
}

export function decodeUniqueMembers<T extends string>(value: unknown, values: readonly T[]): T[] | null {
  if (!Array.isArray(value)) return null
  const decoded: T[] = []
  for (const entry of value) {
    if (!isMember(entry, values) || decoded.includes(entry)) return null
    decoded.push(entry)
  }
  return decoded
}

export function decodeDecompositionPolicy(value: unknown): WbDecompositionPolicy | null {
  if (value === undefined) {
    return {
      ...DEFAULT_WB_DECOMPOSITION_POLICY,
      auto_when: [],
      ask_when: [],
    }
  }
  const item = record(value)
  if (!item || !allowedKeys(item, [
    'version', 'mode', 'target', 'strategy', 'max_items', 'max_depth', 'auto_when', 'ask_when',
  ])) return null
  // A present policy object is versioned just like the kernel contract; only the whole absent
  // object is a legacy definition that receives safe defaults.
  const version = item.version
  const mode = item.mode ?? DEFAULT_WB_DECOMPOSITION_POLICY.mode
  const target = item.target ?? DEFAULT_WB_DECOMPOSITION_POLICY.target
  const strategy = item.strategy ?? DEFAULT_WB_DECOMPOSITION_POLICY.strategy
  const maxItems = item.max_items ?? DEFAULT_WB_DECOMPOSITION_POLICY.max_items
  const maxDepth = item.max_depth ?? DEFAULT_WB_DECOMPOSITION_POLICY.max_depth
  const autoWhen = item.auto_when === undefined
    ? []
    : decodeUniqueMembers(item.auto_when, DECOMPOSITION_AUTO_WHEN)
  const askWhen = item.ask_when === undefined
    ? []
    : decodeUniqueMembers(item.ask_when, DECOMPOSITION_ASK_WHEN)
  if (version !== 'v1'
    || !isMember<WbDecompositionMode>(mode, DECOMPOSITION_MODES)
    || !isMember<WbDecompositionTarget>(target, DECOMPOSITION_TARGETS)
    || !isMember<WbDecompositionStrategy>(strategy, DECOMPOSITION_STRATEGIES)
    || typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 32
    || typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4
    || autoWhen === null
    || askWhen === null) return null
  return {
    version: 'v1',
    mode,
    target,
    strategy,
    max_items: maxItems,
    max_depth: maxDepth,
    auto_when: autoWhen,
    ask_when: askWhen,
  }
}

export function decodeInteractionPolicy(value: unknown): WbInteractionPolicy | null {
  if (value === undefined) return { ...DEFAULT_WB_INTERACTION_POLICY }
  const item = record(value)
  if (!item || !allowedKeys(item, ['version', 'mode'])) return null
  const version = item.version
  const mode = item.mode ?? DEFAULT_WB_INTERACTION_POLICY.mode
  return version === 'v1' && isMember<WbInteractionMode>(mode, INTERACTION_MODES)
    ? { version: 'v1', mode }
    : null
}
