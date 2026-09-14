/**
 * Model-free security observation emitted while a review receipt is pending.
 *
 * This module owns only the wire schema and validation.  File I/O, hashing and Change locking
 * belong to the CLI adapter because the kernel decision domain must not depend on Node APIs.
 */

export const SELF_APPROVAL_SIGNAL_FILE = '.pipeline-decision-security.jsonl' as const
export const SELF_APPROVAL_SIGNAL_TYPE = 'pending-decision-self-approval-suspected' as const
export const SELF_APPROVAL_SCHEMA_VERSION = 'pending-decision-security/v1' as const

export type SelfApprovalSignalKind = 'token-file-read' | 'localhost-control-write'
export type SelfApprovalChannel = 'terminal' | 'dashboard' | 'automation' | 'hook' | 'unknown'

export interface SelfApprovalSignal {
  readonly schema_version: typeof SELF_APPROVAL_SCHEMA_VERSION
  readonly signal_kind: typeof SELF_APPROVAL_SIGNAL_TYPE
  readonly kind: SelfApprovalSignalKind
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly request_anchor: string
  readonly channel: SelfApprovalChannel
  readonly process_or_host_hash: string
  readonly observed_at: string
}

export interface SelfApprovalSignalInput {
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly requestAnchor: string
  readonly channel: SelfApprovalChannel
  readonly processOrHostHash: string
  readonly observedAt: string
  readonly kind: SelfApprovalSignalKind
}

const NAME_RE = /^[A-Za-z0-9_-]+$/u
const HASH_RE = /^sha256:[0-9a-f]{64}$/u
const CHANNELS = new Set<SelfApprovalChannel>(['terminal', 'dashboard', 'automation', 'hook', 'unknown'])
const KINDS = new Set<SelfApprovalSignalKind>(['token-file-read', 'localhost-control-write'])

function bounded(value: string, field: string, max = 512): string {
  if (value === '' || value.length > max || /[\r\n]/u.test(value)) throw new Error(`${field} is invalid`)
  return value
}

/** Build one canonical, redacted signal.  The identity hash must be computed at the adapter edge. */
export function createSelfApprovalSignal(input: SelfApprovalSignalInput): SelfApprovalSignal {
  if (!NAME_RE.test(input.change)) throw new Error('change is invalid')
  if (!KINDS.has(input.kind)) throw new Error('kind is invalid')
  if (!CHANNELS.has(input.channel)) throw new Error('channel is invalid')
  if (!HASH_RE.test(input.processOrHostHash)) throw new Error('process_or_host_hash is invalid')
  return {
    schema_version: SELF_APPROVAL_SCHEMA_VERSION,
    signal_kind: SELF_APPROVAL_SIGNAL_TYPE,
    kind: input.kind,
    change: input.change,
    phase: bounded(input.phase, 'phase'),
    event: bounded(input.event, 'event'),
    request_anchor: bounded(input.requestAnchor, 'request_anchor'),
    channel: input.channel,
    process_or_host_hash: input.processOrHostHash,
    observed_at: bounded(input.observedAt, 'observed_at'),
  }
}
