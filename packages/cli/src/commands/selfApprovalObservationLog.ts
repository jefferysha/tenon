import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSelfApprovalOverflowMarker,
  SELF_APPROVAL_OVERFLOW_TYPE,
  SELF_APPROVAL_SIGNAL_FILE,
  SELF_APPROVAL_SIGNAL_MAX_BYTES,
  type SelfApprovalSignal,
} from '@tenon/kernel'

export type ObservationAppendOutcome = 'appended' | 'duplicate' | 'overflow-marked' | 'overflowed'

/** A tail this large always contains the complete last line when that line is an overflow marker. */
const OVERFLOW_TAIL_BYTES = 4096

function lineRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>)
      }
    } catch {
      // A torn or foreign line carries no key; it can neither dedupe nor mark overflow.
    }
  }
  return records
}

/**
 * Append one observation while the caller holds the Change lock.  Dedupe is by `observation_key`
 * over the bounded file; once the file reaches the size cap exactly one overflow marker is appended
 * and every later call is a no-op, so a looping agent cannot grow the Change directory unbounded.
 */
export async function appendObservationUnderLock(
  changeDirPath: string,
  signal: SelfApprovalSignal,
  observedAt: string,
  maxBytes: number = SELF_APPROVAL_SIGNAL_MAX_BYTES,
): Promise<ObservationAppendOutcome> {
  const target = join(changeDirPath, SELF_APPROVAL_SIGNAL_FILE)
  const handle = await open(
    target,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('self-approval signal file must be a regular file')
    const readBytes = stat.size > maxBytes ? Math.min(stat.size, OVERFLOW_TAIL_BYTES) : stat.size
    const buffer = Buffer.alloc(readBytes)
    if (readBytes > 0) await handle.read(buffer, 0, readBytes, stat.size - readBytes)
    const records = lineRecords(buffer.toString('utf8'))
    if (records.some((record) => record.signal_kind === SELF_APPROVAL_OVERFLOW_TYPE)) return 'overflowed'
    const line = `${JSON.stringify(signal)}\n`
    if (stat.size <= maxBytes) {
      if (records.some((record) => record.observation_key === signal.observation_key)) return 'duplicate'
      if (stat.size + Buffer.byteLength(line, 'utf8') <= maxBytes) {
        await handle.write(line, undefined, 'utf8')
        return 'appended'
      }
    }
    await handle.write(`${JSON.stringify(createSelfApprovalOverflowMarker(observedAt))}\n`, undefined, 'utf8')
    return 'overflow-marked'
  } finally {
    await handle.close()
  }
}
