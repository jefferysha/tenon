import { recordNativeDocumentSkillConfirmation } from '../../kernel/dist/skill-invocation/producer-internal.js'
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
    // Skill PostToolUse fires when the host loads the skill, before it has produced anything, so the
    // receipt only seals the invocation. The skill records its documents with `tenon document record`
    // once they exist; recording here would claim `tenon init` scaffolds as output and close the
    // invocation before its questions and answers.
    return 0
  } catch (error) {
    deps.io.err(`internal-native-skill-receipt: ${errMsg(error)}`)
    return 1
  }
}
