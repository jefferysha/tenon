import {
  appendSkillInvocationEventUnderLock,
  type SkillInvocationChangeLock,
} from '../skill-invocation/repository.js'
import type { AppendSkillInvocationEventOptions } from '../skill-invocation/repository.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'

/**
 * Record a Dashboard-owned invocation decision while the caller holds the
 * invocation Change lock. The raw ledger append primitive stays private to the
 * kernel repository; server code receives this intent-specific application
 * seam instead.
 */
export async function recordDashboardInvocationDecisionUnderLock(
  changeDir: string,
  lock: SkillInvocationChangeLock,
  decision: Extract<SkillInvocationEventV1, { type: 'decision-recorded' }>,
  options: AppendSkillInvocationEventOptions,
): Promise<{ readonly appended: boolean }> {
  return appendSkillInvocationEventUnderLock(changeDir, lock, decision, options)
}
