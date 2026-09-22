/**
 * 一次 StepVisit 的宿主证据原语：这次进入当前步骤之后，history 说哪些技能已完成，
 * 以及入口把哪个宿主会话绑到了这个 Change。
 *
 * 从 codexSkillReceipt.ts 拆出来，是因为「读证据」与「把证据落账」是两件事：预览路径
 * （tenon check / status）只需要前者，且必须证明自己一个字节都没写。这里全是只读函数。
 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HISTORY_FILE, TERMINAL_SESSION_BINDINGS_DIR, TERMINAL_SESSION_PROTOCOL } from '@tenon/kernel'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isSafeOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/.test(value)
}

export async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

export interface CurrentVisitEvidence {
  readonly completedSkillIds: ReadonlySet<string>
  readonly startedAt?: string
  readonly valid: boolean
}

function validTimestamp(value: unknown): string | undefined {
  const timestamp = asString(value)
  return timestamp !== undefined && !Number.isNaN(Date.parse(timestamp)) ? timestamp : undefined
}

export function currentVisitEvidence(history: string, evidenceScope?: string): CurrentVisitEvidence {
  const entries: unknown[] = []
  for (const line of history.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as unknown)
    } catch {
      // A malformed old row cannot satisfy evidence or conceal later valid rows.
    }
  }
  let start = 0
  let startedAt: string | undefined
  let valid = evidenceScope === undefined
  if (evidenceScope) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (isRecord(entry) && entry.kind === 'transition' && entry.to === evidenceScope) {
        start = index + 1
        startedAt = validTimestamp(entry.ts)
        valid = startedAt !== undefined
        break
      }
    }
    const hasAnyTransition = entries.some(
      (entry) => isRecord(entry) && entry.kind === 'transition',
    )
    if (!valid && !hasAnyTransition) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (isRecord(entry) && entry.kind === 'init') {
          start = index + 1
          startedAt = validTimestamp(entry.ts)
          valid = startedAt !== undefined
          break
        }
      }
    }
  }
  const ids = new Set<string>()
  for (const entry of entries.slice(start)) {
    if (!isRecord(entry) || entry.kind !== 'tool') continue
    const raw = asString(entry.raw)
    const match = raw ? /^(?:Skill|CodexSkillRead): (.+)$/.exec(raw) : null
    if (match?.[1]) ids.add(match[1])
  }
  return { completedSkillIds: ids, startedAt, valid }
}

export async function readHistory(changeDir: string): Promise<string> {
  try {
    return await readFile(join(changeDir, HISTORY_FILE), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Prefer the exact host conversation bound by the normal-chat router when Codex omitted a
 * PreToolUse receipt identity. The binding only narrows fallback transcript discovery; it can
 * neither create evidence nor mutate workflow state.
 */
export async function latestBoundHostSessionId(repoRoot: string, changeName: string): Promise<string | undefined> {
  const bindingsDir = join(resolve(repoRoot), TERMINAL_SESSION_BINDINGS_DIR)
  let entries: readonly string[]
  try {
    entries = await readdir(bindingsDir)
  } catch {
    return undefined
  }

  let latest: { readonly sessionId: string; readonly boundAt: string } | undefined
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(bindingsDir, entry)
    if (!await regularFile(path)) continue
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (!isRecord(value) || value.protocol !== TERMINAL_SESSION_PROTOCOL || asString(value.change) !== changeName) continue
      const sessionId = asString(value.session_id)
      const boundAt = asString(value.bound_at)
      if (!sessionId || !boundAt || !isSafeOpaqueId(sessionId) || Number.isNaN(Date.parse(boundAt))) continue
      if (latest === undefined || boundAt > latest.boundAt) latest = { sessionId, boundAt }
    } catch {
      // A damaged dashboard projection cannot broaden evidence discovery.
    }
  }
  return latest?.sessionId
}
