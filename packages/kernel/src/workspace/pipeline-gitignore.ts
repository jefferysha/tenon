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

export const PIPELINE_PROJECT_DIR = '.pipeline'

/** Router data cache (regenerated), host-session bindings (per conversation), Codex read receipts (per machine). */
export const PIPELINE_PROJECT_GITIGNORE = [
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
  const dir = join(repoRoot, PIPELINE_PROJECT_DIR)
  try {
    await mkdir(dir)
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
  const entry = await lstat(dir)
  if (!entry.isDirectory()) throw new Error(`目录不是普通目录: ${dir}`)
  try {
    await writeFile(join(dir, '.gitignore'), PIPELINE_PROJECT_GITIGNORE, { flag: 'wx' })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
}
