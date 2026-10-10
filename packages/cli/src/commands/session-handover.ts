import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isTerminalSessionId, TERMINAL_SESSION_PROTOCOL } from '@tenon/kernel'

/** A session binding is a few dozen bytes; anything bigger is not one and is never touched. */
const MAX_SESSION_BINDING_BYTES = 4096

/**
 * A Change is bound to one conversation at a time: before the new binding is written, every other session's
 * binding to the same Change is deleted and its id returned, so the caller can say where the Change came from.
 * Only well-formed bindings count (ordinary small file, right protocol, `session_id` equal to the file name,
 * same Change); links, oversize, damaged files and other Changes' bindings are left alone.
 */
export async function removeOtherSessionBindings(sessionsDir: string, name: string, sessionId: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return []
  }
  const handedOver: string[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const other = entry.slice(0, -'.json'.length)
    if (other === sessionId || !isTerminalSessionId(other)) continue
    const path = join(sessionsDir, entry)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_BINDING_BYTES) continue
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      if (record.protocol !== TERMINAL_SESSION_PROTOCOL || record.session_id !== other || record.change !== name) continue
      await rm(path, { force: true })
      handedOver.push(other)
    } catch {
      continue
    }
  }
  return handedOver
}
