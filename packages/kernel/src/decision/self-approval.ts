/**
 * Model-free security observation emitted while a review receipt is pending.
 *
 * This module owns the wire schema, validation and the pure candidate classifier.  File I/O,
 * hashing, identity keys and Change locking belong to the CLI adapter because the kernel decision
 * domain must not depend on Node APIs.
 *
 * Detection is split in two: the hot hook recalls broad candidates from the decoded command words
 * (and the script file the command runs), and the CLI applies this classifier plus the canonical
 * pending receipt.  A record is therefore only written for a real pending review, and it never
 * contains token text or the raw candidate.
 *
 * This is an audit signal, not the boundary.  The boundary is the server: since v0.3 no credential
 * is stored anywhere a process could read, an anonymous request gets 401, and confirming a review
 * through the Dashboard needs a browser session plus a per-review presence nonce.  The classifier
 * therefore recognises every way to *reach* that control surface (any loopback spelling aimed at the
 * Dashboard port, the launcher, the sign-in endpoints), not only requests to `/api/`.
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
  /** Legacy (pre-0.3) absolute token path: the file no longer exists, but a stale reader is still recorded. */
  readonly tokenPath: string
  /** Basename of `tokenPath`; covers `~`, variables and relative spellings of the same file. */
  readonly tokenFileName: string
  /** Ports the Dashboard control surface may listen on (`TENON_DASHBOARD_PORT`, the pidfile); defaults to 18765. */
  readonly dashboardPorts?: readonly number[]
}

export const DEFAULT_SELF_APPROVAL_DASHBOARD_PORT = 18765

const NAME_RE = /^[A-Za-z0-9_-]+$/u
const KEY_RE = /^sha256:[0-9a-f]{64}$/u
const HASH_RE = /^hmac-sha256:[0-9a-f]{64}$/u
const CHANNELS = new Set<SelfApprovalChannel>(['terminal', 'dashboard', 'automation', 'delegated', 'unknown'])
const KINDS = new Set<SelfApprovalSignalKind>(['token-file-read', 'local-control-api-call'])
/**
 * Every spelling of the loopback host a client accepts: `localhost`, dotted `127.*` (short, hex and
 * octal parts included), `0.0.0.0`, the integer / hex / octal forms of 127.0.0.1, and the IPv6
 * loopbacks including the IPv4-mapped ones.  The look-arounds keep `localhost.example.test`,
 * `evil-localhost` and `1127.0.0.1` out.
 */
const LOOPBACK_HOST = String.raw`(?:localhost\.?|127(?:\.[0-9A-Fa-fxX]+){1,3}|0[xX]7[fF][0-9A-Fa-f.xX]*|0177(?:\.[0-7]+){0,3}`
  + String.raw`|017700000001|2130706433|0\.0\.0\.0|(?:0{0,4}:){2,6}0{0,4}1|::1`
  + String.raw`|::[fF]{4}:(?:127(?:\.[0-9]+){3}|7[fF][0-9A-Fa-f]{2}:[0-9A-Fa-f]{1,4}))`
const HOST_START = String.raw`(?<![A-Za-z0-9.-])`
const HOST_END = String.raw`(?![A-Za-z0-9-]|\.[A-Za-z0-9])`
/** Group 1 = the text after `:` (a port, possibly a shell expansion); undefined when no port is attached. */
const LOOPBACK_AUTHORITY_RE = new RegExp(
  String.raw`${HOST_START}\[?${LOOPBACK_HOST}\]?${HOST_END}(?::([^\s/'"\\]{0,64}))?`, 'giu',
)
/** bash's `/dev/tcp/<host>/<port>` pseudo-device; group 1 = the port text. */
const DEV_TCP_RE = new RegExp(String.raw`/dev/tcp/\[?${LOOPBACK_HOST}\]?/([^\s'"\\]{1,64})`, 'giu')
/** Endpoints and launchers that exist to establish or use a Dashboard session. */
const SESSION_SURFACE_RE = /\/api\/session\/open|\/session\/start|dashboard\.mjs|(?<![A-Za-z0-9_-])tenon-dashboard(?![A-Za-z0-9_-])/u
const TENON_DASHBOARD_RE = /(?<![A-Za-z0-9_-])tenon\s+dashboard(?![A-Za-z0-9_-])([^\n;&|]*)/gu
/** `tenon dashboard --open` asks the server to open the browser and prints no link: the sanctioned path. */
const SANCTIONED_OPEN_RE = /^\s+(?:--open(?:\s+--port\s+[0-9]+)?|--port\s+[0-9]+\s+--open)\s*$/u
const HEALTH_PATH_RE = /^\/api\/health(?:$|[?\s'"#)])/u
const DYNAMIC_PORT_RE = /[${}%`()*]/u
const EXPANDED_PORT_RE = /:\$[{A-Za-z_(]/u
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

function digitsOf(port: string): number | undefined {
  const digits = /^[0-9]+/u.exec(port)?.[0]
  return digits === undefined ? undefined : Number.parseInt(digits, 10)
}

/** A port aimed at the Dashboard: a literal one of its ports, or an expansion (`$PORT`, `${PORT}`) that may be. */
function targetsDashboardPort(port: string | undefined, dashboardPorts: readonly number[], candidate: string): boolean {
  if (port !== undefined && port !== '') {
    const literal = digitsOf(port)
    return literal === undefined ? DYNAMIC_PORT_RE.test(port) : dashboardPorts.includes(literal)
  }
  // `nc localhost 18765`: the port is a separate word.  `H=127.0.0.1; curl http://$H:$P/`: the host is
  // assigned first and the port is an expansion attached to a different word.
  return EXPANDED_PORT_RE.test(candidate)
    || dashboardPorts.some((candidatePort) => new RegExp(`(?<![0-9])${candidatePort}(?![0-9])`, 'u').test(candidate))
}

function reachesLoopbackDashboard(candidate: string, dashboardPorts: readonly number[]): boolean {
  for (const match of candidate.matchAll(LOOPBACK_AUTHORITY_RE)) {
    if (!targetsDashboardPort(match[1], dashboardPorts, candidate)) continue
    // The unauthenticated health probe is public by design; every other path (including `/`) is not.
    const after = candidate.slice(match.index + match[0].length)
    if (HEALTH_PATH_RE.test(after)) continue
    return true
  }
  for (const match of candidate.matchAll(DEV_TCP_RE)) {
    if (targetsDashboardPort(match[1], dashboardPorts, candidate)) return true
  }
  return false
}

function launchesDashboard(candidate: string): boolean {
  if (SESSION_SURFACE_RE.test(candidate)) return true
  for (const match of candidate.matchAll(TENON_DASHBOARD_RE)) {
    if (!SANCTIONED_OPEN_RE.test(match[1] ?? '')) return true
  }
  return false
}

/**
 * Precise classification of one hook candidate.  Any way to reach the Dashboard control surface is a
 * `local-control-api-call`, whatever the path or method: an anonymous `GET /` used to hand out the
 * write token, and path / method parsing is exactly what the previous `/api/` filter got wrong.
 */
export function classifySelfApprovalCandidate(
  candidate: string,
  location: SelfApprovalTokenLocation,
): readonly SelfApprovalSignalKind[] {
  const kinds: SelfApprovalSignalKind[] = []
  if (mentionsTokenFile(candidate, location)) kinds.push('token-file-read')
  const dashboardPorts = location.dashboardPorts ?? [DEFAULT_SELF_APPROVAL_DASHBOARD_PORT]
  if (reachesLoopbackDashboard(candidate, dashboardPorts) || launchesDashboard(candidate)) {
    kinds.push('local-control-api-call')
  }
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
