import {
  formatReviewMarker,
  readReviewGateBinding,
  reviewGateBindingForState,
  reviewGateBindingMatches,
  writeReviewGateBindingUnderLock,
  type PipelineState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

export async function refreshReviewGateBinding(
  changeDir: string,
  state: PipelineState,
  phase: string,
  event: string,
  requestedAt: string,
  options: { readonly tolerateUnreadable?: boolean } = {},
): Promise<void> {
  let existing: Awaited<ReturnType<typeof readReviewGateBinding>>
  try {
    existing = await readReviewGateBinding(changeDir)
  } catch {
    if (options.tolerateUnreadable !== true) throw new Error('review gate binding unreadable')
    existing = undefined
  }
  if (!reviewGateBindingMatches(existing, state, phase, event)) {
    await writeReviewGateBindingUnderLock(
      changeDir,
      reviewGateBindingForState(state, phase, event, requestedAt),
    )
  }
}

/**
 * Treat an unreadable sidecar as absent. Request recovery rebuilds it; acknowledgement then fails
 * closed because an absent binding never matches the receipt.
 */
export async function readReviewGateBindingForRequest(changeDir: string): Promise<Awaited<ReturnType<typeof readReviewGateBinding>>> {
  try {
    return await readReviewGateBinding(changeDir)
  } catch {
    return undefined
  }
}

export async function writeReviewMarker(
  deps: CliDeps,
  phase: string,
  event: string,
  name: string,
  requestedAt: string,
): Promise<boolean> {
  if (!deps.writeReviewMarker) return true
  try {
    await deps.writeReviewMarker(formatReviewMarker({ phase, event, changeName: name, requestedAt }))
    return true
  } catch (error) {
    deps.io.err(`WARN: review marker 写入失败（canonical pending receipt 已提交，可重试 request）: ${errMsg(error)}`)
    return false
  }
}
