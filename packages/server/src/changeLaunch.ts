/**
 * Change launch application helpers.
 *
 * The dashboard's route-confirmation flow has two durable effects after a
 * Change is created: persist the user task for the session hooks, then bind
 * that Change as the repository's current session pointer.  The pointer is
 * intentionally verified after the CLI completes because `session activate`
 * has a documented degraded-success exit path when the pointer cannot be
 * written.
 */
import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readActiveChange } from '@tenon/kernel'
import type { PipelineCliRunner } from './operations.js'

export const CHANGE_TASK_FILE = 'REAL_AGENT_TASK.md'
const MAX_TASK_PROMPT_CHARS = 24_000

export type ChangeSessionStatus = 'not_requested' | 'unavailable' | 'failed' | 'degraded' | 'active'

export interface ChangeSessionActivation {
  readonly requested: boolean
  readonly active: boolean
  readonly status: ChangeSessionStatus
  readonly exit_code: number | null
}

type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `undefined` retains the existing API behaviour: no task file is written. */
export function parseChangeTaskPrompt(value: unknown): Validation<string | null> {
  if (value === undefined) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'task_prompt 必须是字符串' }
  const prompt = value.trim()
  if (prompt === '') return { ok: false, error: 'task_prompt 不能为空' }
  if (prompt.length > MAX_TASK_PROMPT_CHARS) {
    return { ok: false, error: `task_prompt 不能超过 ${MAX_TASK_PROMPT_CHARS} 个字符` }
  }
  return { ok: true, value: prompt }
}

/** Existing callers without `task_prompt` do not start or replace a session. */
export function parseChangeSessionActivation(value: unknown, hasTaskPrompt: boolean): Validation<boolean> {
  if (value === undefined) return { ok: true, value: hasTaskPrompt }
  if (typeof value !== 'boolean') return { ok: false, error: 'activate_session 必须是布尔值' }
  return { ok: true, value }
}

/**
 * Publish the task file as a new directory entry.  `initChange` has already
 * claimed the Change directory under the track-registry lock, so rejecting a
 * pre-existing task file prevents this helper from overwriting another write.
 */
export async function writeChangeTaskPrompt(changeDir: string, prompt: string): Promise<void> {
  const dirStat = await lstat(changeDir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error('Change 目录不是可信普通目录，拒绝保存任务提示词')
  }
  const target = join(changeDir, CHANGE_TASK_FILE)
  let targetExists = false
  try {
    await lstat(target)
    targetExists = true
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  if (targetExists) throw new Error('任务提示词已存在，拒绝覆盖')

  const temporary = join(changeDir, `.${CHANGE_TASK_FILE}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${prompt}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') {
        throw new Error(`任务提示词发布失败：${errorMessage(error)}；临时文件清理失败：${errorMessage(cleanupError)}`)
      }
    }
    throw error
  }
}

export function notRequestedSessionActivation(): ChangeSessionActivation {
  return { requested: false, active: false, status: 'not_requested', exit_code: null }
}

/**
 * Invoke the same built CLI used by dashboard operations and then read the
 * pointer it actually published.  A zero process exit is not sufficient:
 * `tenon session activate` deliberately reports degraded pointer writes as
 * success so an interactive terminal session can continue.
 */
export async function activateChangeSession(input: {
  readonly available: boolean
  readonly runner: PipelineCliRunner
  readonly repoRoot: string
  readonly changeName: string
  /** Server-resolved declared user; the CLI child inherits this env and writes the same user's pointer. */
  readonly userSlug: string
}): Promise<ChangeSessionActivation> {
  if (!input.available) {
    return { requested: true, active: false, status: 'unavailable', exit_code: null }
  }

  let result
  try {
    result = await input.runner(input.repoRoot, ['session', 'activate', input.changeName])
  } catch {
    return { requested: true, active: false, status: 'failed', exit_code: null }
  }
  if (result.exitCode !== 0) {
    return { requested: true, active: false, status: 'failed', exit_code: result.exitCode }
  }

  const activeName = await readActiveChange(input.repoRoot, input.userSlug).catch(() => null)
  return activeName === input.changeName
    ? { requested: true, active: true, status: 'active', exit_code: result.exitCode }
    : { requested: true, active: false, status: 'degraded', exit_code: result.exitCode }
}
