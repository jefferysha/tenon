import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  classifySelfApprovalCandidate,
  createSelfApprovalSignal,
  readReviewGateBinding,
  resolveProductPaths,
  reviewGatePendingFor,
  reviewGateRequestAnchor,
  type PipelineState,
  type ProductPathInput,
  type SelfApprovalSignalKind,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { changeDir, changesRoot, isValidChangeName } from '../paths.js'
import { loadOrCreateObservationKey, observationIdentityDigest } from './selfApprovalIdentity.js'
import { appendObservationUnderLock } from './selfApprovalObservationLog.js'

/** Commands near ARG_MAX still fit; the hook never truncates, so padding cannot hide a match. */
const MAX_PAYLOAD_BYTES = 1024 * 1024
const IDENTITY_MAX_CHARS = 1024
const TOOL_USE_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/u
const PAYLOAD_KEYS = new Set(['candidate', 'tool_name', 'tool_use_id', 'process_or_host_identity'])

interface CandidatePayload {
  readonly candidate: string
  readonly toolUseId: string | undefined
  readonly identity: string
}

async function readPayloadObject(payloadPath: string): Promise<Record<string, unknown>> {
  const handle = await open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_PAYLOAD_BYTES) throw new Error('payload must be a bounded regular file')
    const raw = await readFile(handle, 'utf8')
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('payload changed during verified read')
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      // SyntaxError messages quote a slice of the input, which may be candidate command text.
      throw new Error('payload is not valid JSON')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
    return value as Record<string, unknown>
  } finally {
    await handle.close()
  }
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${key} is invalid`)
  return value
}

/** Closed decoder: the hook payload is a transient input and never reaches the observation file. */
async function readPayload(payloadPath: string): Promise<CandidatePayload> {
  const payload = await readPayloadObject(payloadPath)
  if (Object.keys(payload).some((key) => !PAYLOAD_KEYS.has(key))) throw new Error('payload has unknown fields')
  const candidate = optionalString(payload, 'candidate')
  if (candidate === undefined) throw new Error('candidate is invalid')
  optionalString(payload, 'tool_name')
  const toolUseId = optionalString(payload, 'tool_use_id')
  if (toolUseId !== undefined && !TOOL_USE_ID_RE.test(toolUseId)) throw new Error('tool_use_id is invalid')
  const identity = optionalString(payload, 'process_or_host_identity')
  if (identity === undefined || identity.length > IDENTITY_MAX_CHARS || /[\r\n]/u.test(identity)) {
    throw new Error('process_or_host_identity is invalid')
  }
  return { candidate, toolUseId, identity }
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Stable per decision anchor, signal kind and tool call; the candidate itself is only hashed. */
function observationKey(change: string, anchor: string, kind: SelfApprovalSignalKind, payload: CandidatePayload): string {
  const call = payload.toolUseId === undefined ? `candidate:${sha256(payload.candidate)}` : `tool-use:${payload.toolUseId}`
  return `sha256:${sha256([change, anchor, kind, call].join('\u0000'))}`
}

function pendingPhaseEvent(state: PipelineState): { phase: string; event: string; requestedAt: string } | undefined {
  const phase = scalar(state, 'review_gate_phase')
  const event = scalar(state, 'review_gate_event')
  if (phase === '' || event === '' || !reviewGatePendingFor(state, phase, event)) return undefined
  return { phase, event, requestedAt: scalar(state, 'review_requested_at') }
}

async function recordForChange(
  deps: CliDeps,
  changeName: string,
  kinds: readonly SelfApprovalSignalKind[],
  payload: CandidatePayload,
  identityKey: () => Promise<Buffer>,
): Promise<void> {
  const dir = changeDir(deps.cwd, changeName)
  // Unlocked pre-filter keeps a non-pending Change free of lock artifacts: no receipt, zero writes.
  if (pendingPhaseEvent(await deps.store.read(dir)) === undefined) return
  await deps.store.withLock(dir, async () => {
    const pending = pendingPhaseEvent(await deps.store.read(dir))
    if (pending === undefined) return
    const binding = await readReviewGateBinding(dir)
    if (binding === undefined) throw new Error('review gate binding is missing')
    if (binding.phase !== pending.phase || binding.event !== pending.event || binding.requestedAt !== pending.requestedAt) {
      throw new Error('review gate binding does not match pending receipt')
    }
    const anchor = reviewGateRequestAnchor(binding)
    const processOrHostHash = observationIdentityDigest(await identityKey(), payload.identity)
    const observedAt = deps.clock()
    for (const kind of kinds) {
      const signal = createSelfApprovalSignal({
        change: changeName,
        phase: pending.phase,
        event: pending.event,
        requestAnchor: anchor,
        channel: 'terminal',
        observationKey: observationKey(changeName, anchor, kind, payload),
        processOrHostHash,
        observedAt,
        kind,
      })
      const outcome = await appendObservationUnderLock(dir, signal, observedAt)
      // A duplicate only covers its own key; a capped file stops every remaining kind.
      if (outcome === 'overflow-marked' || outcome === 'overflowed') return
    }
  })
}

/**
 * Internal hook boundary (precise half of self-approval detection).  The hook forwards any broad
 * candidate; this command classifies it against the product-resolved token path and loopback API
 * shape, then re-reads the canonical pending receipt and binding under each Change lock.  The hook
 * marker is never consulted, so AFK mode and stale markers do not suppress a record, and a Change
 * without a pending receipt receives zero writes.
 */
export async function cmdInternalSelfApproval(
  deps: CliDeps,
  payloadPath: string,
  changeName?: string,
  pathInput?: ProductPathInput,
): Promise<number> {
  try {
    if (changeName !== undefined && !isValidChangeName(changeName)) throw new Error('change name is invalid')
    const payload = await readPayload(payloadPath)
    const paths = resolveProductPaths(pathInput)
    const kinds = classifySelfApprovalCandidate(payload.candidate, {
      tokenPath: paths.dashboardTokenPath,
      tokenFileName: basename(paths.dashboardTokenPath),
    })
    if (kinds.length === 0) return 0
    let key: Promise<Buffer> | undefined
    const identityKey = (): Promise<Buffer> => {
      key ??= loadOrCreateObservationKey(paths.decisionObservationKeyPath)
      return key
    }
    const changes = changeName === undefined ? await deps.listChanges(changesRoot(deps.cwd)) : [changeName]
    let failures = 0
    for (const name of changes) {
      try {
        await recordForChange(deps, name, kinds, payload, identityKey)
      } catch (error) {
        failures += 1
        deps.io.err(`internal-self-approval: ${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return failures === 0 ? 0 : 1
  } catch (error) {
    deps.io.err(`internal-self-approval: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
