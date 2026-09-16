/**
 * Kernel default for the 会话活跃 reason: read the Change's own terminal-activity sidecar without
 * following a symlink and decide only through the hook-owned parser. Adapters that already have a
 * hardened reader (the server snapshot) pass theirs instead.
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TERMINAL_ACTIVITY_FILE, liveTerminalActivity, parseTerminalActivityRecord,
} from './terminal-activity.js'

const MAX_SIDECAR_BYTES = 4096

export async function defaultTerminalActivityLive(
  changeDir: string,
  change: string,
  nowMs: number,
): Promise<boolean> {
  const path = join(changeDir, TERMINAL_ACTIVITY_FILE)
  try {
    const item = await lstat(path)
    if (!item.isFile() || item.size > MAX_SIDECAR_BYTES) return false
    const record = parseTerminalActivityRecord(JSON.parse(await readFile(path, 'utf8')))
    if (record === null || record.change !== change) return false
    return liveTerminalActivity(record, nowMs) !== null
  } catch {
    return false
  }
}
