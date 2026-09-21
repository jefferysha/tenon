/**
 * Test-only bridge for recording a real `tenon` Skill receipt for the current step visit.
 *
 * Transition fixtures must go through the production PostToolUse tracker rather than appending a
 * synthetic history row.  Keeping this bridge outside the main harness keeps the harness focused
 * on command/dependency assembly while preserving the same hook path for every caller.
 */
import { spawnSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStateStore, ensureUserLocalDir, isTenonUser, resolveTenonUser } from '@tenon/kernel'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Drive the production PostToolUse hook for a Skill of the current step visit. */
export async function recordWorkflowPhaseSkill(
  root: string,
  changeDir: string,
  skill = 'tenon',
): Promise<void> {
  const state = await createStateStore().read(changeDir)
  const phase = String(state.fields.phase)
  const user = resolveTenonUser(root, process.env)
  if (!isTenonUser(user)) throw new Error('recordWorkflowPhaseSkill needs a declared TENON_USER')
  // The hook resolves the same identity from the inherited env and reads this user's pointer.
  const pointer = (await ensureUserLocalDir(root, user.slug)).activeChange
  let previous: string | undefined
  try {
    previous = await readFile(pointer, 'utf8')
  } catch {
    // A fresh harness normally has no active pointer yet.
  }
  await writeFile(pointer, `${basename(changeDir)}\n`, 'utf8')
  try {
    const result = spawnSync('bash', [join(REPO_ROOT, 'hooks', 'skill-tracker.sh')], {
      cwd: root,
      env: {
        ...process.env,
        TENON_PROJECT_ROOT: root,
      },
      input: JSON.stringify({
        cwd: root,
        tool_name: 'Skill',
        tool_input: { skill },
        session_id: `integration-harness-${basename(changeDir)}-${phase}`,
        tool_use_id: `phase-${phase}-${Date.now()}`,
      }),
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`skill-tracker.sh failed for ${skill}: ${result.stderr ?? ''}`)
    }
    const history = await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')
    if (!history.split('\n').some((line) => line.includes(`\"raw\":\"Skill: ${skill}\"`))) {
      throw new Error(`skill-tracker.sh did not record ${skill} for ${basename(changeDir)}`)
    }
  } finally {
    if (previous === undefined) {
      await rm(pointer, { force: true })
    } else {
      await writeFile(pointer, previous, 'utf8')
    }
  }
}
