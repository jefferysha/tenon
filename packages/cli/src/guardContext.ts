import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { makeGuardFileContext, stateStorageExistsSync } from '@tenon/kernel'
import type { GuardFileContext } from './deps.js'

export { readBoundedRegularFileSync } from '@tenon/kernel'

export async function listChanges(changesRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(changesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .filter((entry) => stateStorageExistsSync(join(changesRoot, entry.name)))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Track-reference scans must include unreadable/partial directories so the
 * caller can fail closed instead of silently dropping a reference candidate.
 */
export async function listChangeDirs(changesRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(changesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort()
}

/** TENON_AUTOMATION_RUNNER=1 是调度器旁路（build 相位 automation=queued 闸的逃生口）。 */
export function makeGuardCtx(cwd: string): (name: string) => GuardFileContext {
  return makeGuardFileContext(cwd, { automationRunner: process.env.TENON_AUTOMATION_RUNNER === '1' })
}
