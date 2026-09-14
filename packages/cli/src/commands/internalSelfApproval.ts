import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSelfApprovalSignal,
  readReviewGateBinding,
  reviewGatePendingFor,
  reviewGateRequestAnchor,
  SELF_APPROVAL_SIGNAL_FILE,
  type SelfApprovalSignalKind,
} from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'

const MAX_PAYLOAD_BYTES = 16 * 1024
const IDENTITY_MAX_BYTES = 1024

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

async function readPayload(payloadPath: string): Promise<Record<string, unknown>> {
  const handle = await open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_PAYLOAD_BYTES) throw new Error('payload must be a bounded regular file')
    const raw = await readFile(handle, 'utf8')
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('payload changed during verified read')
    }
    return object(JSON.parse(raw))
  } finally {
    await handle.close()
  }
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value === '' || value.length > IDENTITY_MAX_BYTES || /[\r\n]/u.test(value)) {
    throw new Error(`${key} is invalid`)
  }
  return value
}

function signalKind(payload: Record<string, unknown>): SelfApprovalSignalKind {
  const value = text(payload, 'kind')
  if (value !== 'token-file-read' && value !== 'localhost-control-write') throw new Error('kind is invalid')
  return value
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

async function appendSignalUnderLock(changeDirPath: string, signal: ReturnType<typeof createSelfApprovalSignal>): Promise<void> {
  const target = join(changeDirPath, SELF_APPROVAL_SIGNAL_FILE)
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('self-approval signal file must be a regular file')
    await handle.write(`${JSON.stringify(signal)}\n`, undefined, 'utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Internal hook boundary. The payload contains only a transient identity input; the persisted
 * record contains its SHA-256 hash. The command re-reads the pending receipt and binding while
 * holding the Change lock, so a late hook cannot forge phase/event/anchor or mutate approval.
 */
export async function cmdInternalSelfApproval(
  deps: CliDeps,
  changeName: string,
  payloadPath: string,
): Promise<number> {
  try {
    if (!isValidChangeName(changeName)) throw new Error('change name is invalid')
    const payload = await readPayload(payloadPath)
    const kind = signalKind(payload)
    const identity = text(payload, 'process_or_host_identity')
    const dir = changeDir(deps.cwd, changeName)
    await deps.store.withLock(dir, async () => {
      const state = await deps.store.read(dir)
      const phase = scalar(state, 'review_gate_phase')
      const event = scalar(state, 'review_gate_event')
      if (phase === '' || event === '' || !reviewGatePendingFor(state, phase, event)) return
      const binding = await readReviewGateBinding(dir)
      if (binding === undefined) throw new Error('review gate binding is missing')
      if (binding.phase !== phase || binding.event !== event || binding.requestedAt !== scalar(state, 'review_requested_at')) {
        throw new Error('review gate binding does not match pending receipt')
      }
      const processOrHostHash = `sha256:${createHash('sha256').update(identity, 'utf8').digest('hex')}`
      const signal = createSelfApprovalSignal({
        change: changeName,
        phase,
        event,
        requestAnchor: reviewGateRequestAnchor(binding),
        channel: 'hook',
        processOrHostHash,
        observedAt: deps.clock(),
        kind,
      })
      await appendSignalUnderLock(dir, signal)
    })
    return 0
  } catch (error) {
    deps.io.err(`internal-self-approval: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
