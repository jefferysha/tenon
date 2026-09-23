/**
 * `.pipeline/` mixes shared project configuration (workflows/, tracks.yaml, hooks.json, loops.yaml …)
 * with machine- or conversation-local runtime state.  Like `.tenon/.gitignore` for the per-user
 * `local/` directories, Tenon keeps the local part out of git with its own nested
 * `.pipeline/.gitignore` and never edits the project's root `.gitignore`.  The file is created once
 * and never overwritten, so a project may adjust it.
 *
 * Every writer of a listed path calls ensurePipelineGitignore before writing.  hooks/router.sh
 * writes the router cache without Node and carries a byte-identical copy of this content.
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const WORKFLOW_STATE_DIR = '.pipeline'

/** Router data cache (regenerated), host-session bindings (per conversation), Codex read receipts (per machine). */
export const WORKFLOW_STATE_GITIGNORE = [
  '# Tenon local runtime state; shared configuration in this directory stays tracked.',
  'cache/',
  'terminal-sessions/',
  'codex-skill-receipts.jsonl',
  '',
].join('\n')

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined
}

/** Create `<repoRoot>/.pipeline/.gitignore` if absent.  A `.pipeline` that is not a plain directory is refused. */
export async function ensurePipelineGitignore(repoRoot: string): Promise<void> {
  const dir = join(repoRoot, WORKFLOW_STATE_DIR)
  try {
    await mkdir(dir)
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
  const entry = await lstat(dir)
  if (!entry.isDirectory()) throw new Error(`目录不是普通目录: ${dir}`)
  try {
    await writeFile(join(dir, '.gitignore'), WORKFLOW_STATE_GITIGNORE, { flag: 'wx' })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
}

/** `openspec/` holds the tracked Change documents; only the hook-written liveness sidecar is local. */
const OPENSPEC_DIR = 'openspec'

/**
 * Terminal heartbeat (`openspec/changes/<c>/.pipeline-terminal-activity.json`) and its mktemp siblings.
 * The pattern has no slash, so it applies at every depth below `openspec/`, including archived Changes.
 * It lives in `openspec/.gitignore` rather than `openspec/changes/.gitignore` because Change scanners
 * treat any non-directory entry of `openspec/changes/` as a blocker.  hooks/terminal-activity.sh writes
 * the same bytes before its first heartbeat.
 */
export const OPENSPEC_LOCAL_GITIGNORE = [
  '# Tenon local runtime state; Change documents in this directory stay tracked.',
  '.pipeline-terminal-activity.*',
  '',
].join('\n')

/** Create `<repoRoot>/openspec/.gitignore` if absent.  Never creates `openspec/` and skips a non-plain one. */
export async function ensureOpenspecGitignore(repoRoot: string): Promise<void> {
  const dir = join(repoRoot, OPENSPEC_DIR)
  try {
    if (!(await lstat(dir)).isDirectory()) return
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return
    throw error
  }
  try {
    await writeFile(join(dir, '.gitignore'), OPENSPEC_LOCAL_GITIGNORE, { flag: 'wx' })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
}
