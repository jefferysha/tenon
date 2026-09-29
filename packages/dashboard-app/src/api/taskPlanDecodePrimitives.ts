/** Bounded, closed-set decoding primitives shared by the TaskPlan read-model decoders. */
import { isRecord } from './transport'
import {
  MAX_TASK_PLAN_DECODE_NODES, MAX_TASK_PLAN_ID_BYTES, MAX_TASK_PLAN_RELATIONS_PER_ITEM,
  MAX_TASK_PLAN_RESOURCE_BYTES, MAX_TASK_PLAN_TEXT_BYTES,
} from './taskPlanTypes'
import type {
  ExpectedOutputKind, ResourceAccess, ResourceKind, TaskPlanValidationIssueCode, TaskValidatorKind,
} from './taskPlanTypes'

export const VALIDATION_ISSUE_CODES: readonly TaskPlanValidationIssueCode[] = [
  'acceptance-ref-duplicate', 'acceptance-ref-unknown', 'acceptance-uncovered',
  'dependency-cycle', 'dependency-duplicate', 'dependency-self', 'dependency-unknown',
  'entity-id-duplicate', 'group-cycle', 'group-parent-unknown', 'group-work-item-unknown',
  'requirement-ref-duplicate', 'requirement-ref-unknown', 'requirement-uncovered',
  'resource-claim-duplicate', 'resource-write-conflict', 'task-plan-contract-invalid',
  'validator-output-unknown', 'work-item-group-mismatch', 'work-item-multiple-groups',
  'work-item-unowned', 'diagnostic-budget-exceeded',
]
export const RESOURCE_KINDS: readonly ResourceKind[] = ['path', 'logical', 'external']
export const RESOURCE_ACCESS: readonly ResourceAccess[] = ['read', 'write']
export const OUTPUT_KINDS: readonly ExpectedOutputKind[] = ['file', 'artifact', 'value']
export const VALIDATOR_KINDS: readonly TaskValidatorKind[] = [
  'file-exists', 'json-schema', 'test-report', 'artifact-digest',
]

export interface DecodeBudget {
  nodes: number
  bytes: number
  readonly maxBytes: number
}

export function budget(maxBytes: number): DecodeBudget {
  return { nodes: 0, bytes: 0, maxBytes }
}

export function consume(budgetState: DecodeBudget, nodes = 1): boolean {
  budgetState.nodes += nodes
  return budgetState.nodes <= MAX_TASK_PLAN_DECODE_NODES
}

export function consumeText(budgetState: DecodeBudget, value: string): boolean {
  const bytes = new TextEncoder().encode(value).byteLength
  budgetState.bytes += bytes
  return budgetState.bytes <= budgetState.maxBytes
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (!isRecord(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(value).every((key) => typeof key === 'string')
  } catch {
    return false
  }
}

export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  try {
    const keys = Reflect.ownKeys(value)
    const allowed = new Set([...required, ...optional])
    return required.every((key) => keys.includes(key))
      && keys.length >= required.length
      && keys.every((key) => {
        if (typeof key !== 'string' || !allowed.has(key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor !== undefined && descriptor.enumerable
          && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      })
  } catch {
    return false
  }
}

export function strictArray(
  value: unknown,
  budgetState: DecodeBudget,
  limit: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null
    if (Object.getPrototypeOf(value) !== Array.prototype
      || !Number.isSafeInteger(value.length) || value.length > limit
      || !consume(budgetState, value.length + 1)) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes('length')) return null
    const entries: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
      entries.push(descriptor.value)
    }
    if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)))) return null
    return entries
  } catch {
    return null
  }
}

export function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}

export function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

export function isFingerprint(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

export function isCanonicalCompletenessState(value: unknown): value is 'complete' | 'incomplete' {
  return value === 'complete' || value === 'incomplete'
}

export function hasInvalidSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (current >= 0xdc00 && current <= 0xdfff) return true
  }
  return false
}

export function safeText(
  value: unknown,
  budgetState: DecodeBudget,
  maxBytes = MAX_TASK_PLAN_TEXT_BYTES,
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes
    || value !== value.trim() || hasInvalidSurrogate(value)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || !consume(budgetState)) return false
  const bytes = new TextEncoder().encode(value).byteLength
  return bytes <= maxBytes && consumeText(budgetState, value)
}

export function safeIdentifier(value: unknown, budgetState: DecodeBudget): value is string {
  return safeText(value, budgetState, MAX_TASK_PLAN_ID_BYTES)
    && value === value.normalize('NFC')
    && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(value)
    && !value.includes('--')
}

export function stringArray(
  value: unknown,
  budgetState: DecodeBudget,
  limit = MAX_TASK_PLAN_RELATIONS_PER_ITEM,
): string[] | null {
  const entries = strictArray(value, budgetState, limit)
  if (entries === null) return null
  const decoded: string[] = []
  for (const entry of entries) {
    if (!safeIdentifier(entry, budgetState)) return null
    decoded.push(entry)
  }
  return decoded
}

export function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export function canonicalResourceKey(kind: ResourceKind, key: string): string | null {
  if (key === '' || key !== key.trim() || key !== key.normalize('NFC')
    || hasInvalidSurrogate(key) || /[\u0000-\u001f\u007f-\u009f]/u.test(key)
    || key.includes('\\') || key.startsWith('/') || key.endsWith('/') || key.includes('//')) return null
  const segments = key.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  if (kind === 'path' && key.includes(':')) return null
  if (kind !== 'path' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(key)) return null
  return `${kind}:${key}`
}

export function resourceKey(value: unknown, budgetState: DecodeBudget): string | null {
  if (!safeText(value, budgetState, MAX_TASK_PLAN_RESOURCE_BYTES)) return null
  const separator = value.indexOf(':')
  if (separator <= 0) return null
  const kind = value.slice(0, separator)
  const key = value.slice(separator + 1)
  if (!isEnum(kind, RESOURCE_KINDS)) return null
  return canonicalResourceKey(kind, key) === value ? value : null
}
