/**
 * Model-free security observation emitted while a review receipt is pending.
 *
 * This module owns the wire schema, validation and the pure candidate classifier.  File I/O,
 * hashing, identity keys and Change locking belong to the CLI adapter because the kernel decision
 * domain must not depend on Node APIs.
 *
 * Detection is split in two: the hot hook recalls broad candidates without parsing commands, and
 * the CLI applies this classifier plus the canonical pending receipt.  A record is therefore only
 * written for a real pending review, and it never contains token text or the raw candidate.
 */

export const SELF_APPROVAL_SIGNAL_FILE = '.pipeline-decision-security.jsonl' as const
export const SELF_APPROVAL_SIGNAL_TYPE = 'pending-decision-self-approval-suspected' as const
export const SELF_APPROVAL_OVERFLOW_TYPE = 'pending-decision-security-overflow' as const
export const SELF_APPROVAL_SCHEMA_VERSION = 'pending-decision-security/v1' as const
/** Once the observation file reaches this size a single overflow marker is appended and writes stop. */
export const SELF_APPROVAL_SIGNAL_MAX_BYTES = 1024 * 1024

export type SelfApprovalSignalKind = 'token-file-read' | 'local-control-api-call'
/** Contract channel vocabulary (decision-sync I); a hook is a route into the terminal session. */
export type SelfApprovalChannel = 'terminal' | 'dashboard' | 'automation' | 'delegated' | 'unknown'

export interface SelfApprovalSignal {
  readonly schema_version: typeof SELF_APPROVAL_SCHEMA_VERSION
  readonly signal_kind: typeof SELF_APPROVAL_SIGNAL_TYPE
  readonly kind: SelfApprovalSignalKind
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly request_anchor: string
  readonly channel: SelfApprovalChannel
  readonly observation_key: string
  readonly process_or_host_hash: string
  readonly observed_at: string
}

export interface SelfApprovalOverflowMarker {
  readonly schema_version: typeof SELF_APPROVAL_SCHEMA_VERSION
  readonly signal_kind: typeof SELF_APPROVAL_OVERFLOW_TYPE
  readonly observed_at: string
}

export interface SelfApprovalSignalInput {
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly requestAnchor: string
  readonly channel: SelfApprovalChannel
  readonly observationKey: string
  readonly processOrHostHash: string
  readonly observedAt: string
  readonly kind: SelfApprovalSignalKind
}

export interface SelfApprovalTokenLocation {
  /** Product-resolved absolute token path. */
  readonly tokenPath: string
  /** Basename of `tokenPath`; covers `~`, variables and relative spellings of the same file. */
  readonly tokenFileName: string
}

const NAME_RE = /^[A-Za-z0-9_-]+$/u
const KEY_RE = /^sha256:[0-9a-f]{64}$/u
const HASH_RE = /^hmac-sha256:[0-9a-f]{64}$/u
const CHANNELS = new Set<SelfApprovalChannel>(['terminal', 'dashboard', 'automation', 'delegated', 'unknown'])
const KINDS = new Set<SelfApprovalSignalKind>(['token-file-read', 'local-control-api-call'])
/**
 * Loopback authority directly followed by `/api/`; `localhost.example` or `evil-localhost` never
 * match.  The port is any non-slash, non-space run so `:$PORT` / `:${PORT}` read from the pidfile
 * cannot slip past a numeric-only port.
 */
const LOOPBACK_API_RE = /(?:^|[^A-Za-z0-9.-])(?:localhost|127\.0\.0\.1|\[::1\])(?::[^\s/]{0,64})?\/api\//u
const PATH_NAME_CHAR_RE = /[A-Za-z0-9._-]/u

function bounded(value: string, field: string, max = 512): string {
  if (value === '' || value.length > max || /[\r\n]/u.test(value)) throw new Error(`${field} is invalid`)
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** A token file name counts only as a whole path segment: `dashboard-token.json.bak` does not. */
function mentionsTokenFile(candidate: string, location: SelfApprovalTokenLocation): boolean {
  if (location.tokenPath !== '' && candidate.includes(location.tokenPath)) {
    const after = candidate.charAt(candidate.indexOf(location.tokenPath) + location.tokenPath.length)
    if (after === '' || !PATH_NAME_CHAR_RE.test(after)) return true
  }
  if (location.tokenFileName === '') return false
  const segment = new RegExp(`(?:^|[^A-Za-z0-9._-])${escapeRegExp(location.tokenFileName)}(?![A-Za-z0-9._-])`, 'u')
  return segment.test(candidate)
}

/**
 * Precise classification of one hook candidate.  Every loopback `/api/` call is treated as a
 * control call regardless of method: the local server is the only control surface on loopback,
 * and method parsing is exactly what the hook used to get wrong.
 */
export function classifySelfApprovalCandidate(
  candidate: string,
  location: SelfApprovalTokenLocation,
): readonly SelfApprovalSignalKind[] {
  const kinds: SelfApprovalSignalKind[] = []
  if (mentionsTokenFile(candidate, location)) kinds.push('token-file-read')
  if (LOOPBACK_API_RE.test(candidate)) kinds.push('local-control-api-call')
  return kinds
}

/** Build one canonical, redacted signal.  Key and identity hash must be computed at the adapter edge. */
export function createSelfApprovalSignal(input: SelfApprovalSignalInput): SelfApprovalSignal {
  if (!NAME_RE.test(input.change)) throw new Error('change is invalid')
  if (!KINDS.has(input.kind)) throw new Error('kind is invalid')
  if (!CHANNELS.has(input.channel)) throw new Error('channel is invalid')
  if (!KEY_RE.test(input.observationKey)) throw new Error('observation_key is invalid')
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
    observation_key: input.observationKey,
    process_or_host_hash: input.processOrHostHash,
    observed_at: bounded(input.observedAt, 'observed_at'),
  }
}

export function createSelfApprovalOverflowMarker(observedAt: string): SelfApprovalOverflowMarker {
  return {
    schema_version: SELF_APPROVAL_SCHEMA_VERSION,
    signal_kind: SELF_APPROVAL_OVERFLOW_TYPE,
    observed_at: bounded(observedAt, 'observed_at'),
  }
}
