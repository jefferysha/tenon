import { autoRegisterDocuments } from '@tenon/kernel'
import { recordNativeDocumentSkillConfirmation } from '../../kernel/dist/skill-invocation/producer-internal.js'
import { effectiveWorkflowForState } from './commands/effective-workflow.js'
import { errMsg, type CliDeps } from './deps.js'
import { changeDir, isValidChangeName } from './paths.js'

const SAFE_SKILL_ID = /^[A-Za-z0-9_-]{1,160}$/u

/** Hidden native-host adapter target. Only a real Skill PostToolUse hook calls this command. */
export async function cmdInternalNativeSkillReceipt(
  deps: CliDeps,
  changeName: string,
  skillId: string,
  sessionId: string,
  toolUseId: string,
  observedAt: string,
): Promise<number> {
  if (!isValidChangeName(changeName) || !SAFE_SKILL_ID.test(skillId)) {
    deps.io.err('internal-native-skill-receipt: invalid change or skill identity')
    return 1
  }
  const dir = changeDir(deps.cwd, changeName)
  try {
    const state = await deps.store.read(dir)
    const phase = state.fields.phase
    if (state.runMetadata === undefined || typeof phase !== 'string') {
      throw new Error('canonical WorkflowRun StepVisit identity is missing')
    }
    // The kernel repository acquires the canonical Change lock while appending the started event
    // and rejects any StepVisit drift. Do not take the same non-reentrant lock here: doing so would
    // deadlock the real PostToolUse hook before it can seal its receipt.
    const recorded = await recordNativeDocumentSkillConfirmation(dir, skillId, phase, {
      sessionId, toolUseId, observedAt,
    })
    if (!recorded) throw new Error('native Skill receipt does not match the canonical current StepVisit')
    // 回执落地后技能的完成态证据已齐：按当前阶段契约把它刚写出的规范文档登记进台账。
    // 失败只 WARN（hook 总纲 fail-open），不影响回执本身的成功。
    const policy = effectiveWorkflowForState(deps, state)?.capabilities.documents.policy
    if (policy !== undefined) {
      const outcome = await autoRegisterDocuments({
        repoRoot: deps.cwd,
        changeDir: dir,
        changeName,
        phase,
        policy,
        producer: skillId,
        recordedAt: observedAt,
      })
      const recordedText = outcome.recorded.map((entry) => `${entry.kind}:${entry.path}`).join(',')
      const skippedText = outcome.skipped.filter((entry) => entry.reason !== 'up-to-date').map((entry) => `${entry.kind}:${entry.reason}`).join(',')
      deps.io.err(`[auto-register] recorded=${recordedText || '-'} skipped=${skippedText || '-'}`)
    }
    return 0
  } catch (error) {
    deps.io.err(`internal-native-skill-receipt: ${errMsg(error)}`)
    return 1
  }
}
