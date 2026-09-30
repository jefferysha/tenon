/**
 * Dashboard 会话权威：一次性登录码、浏览器会话、评审确认的“人在场”nonce。
 *
 * 全部只活在 server 进程内存里：不写盘，不进环境变量，也不出现在任何 HTTP 响应里。所以一个能读遍
 * Tenon state 目录、能连回环端口的同用户进程（假想对手之一，见 docs/usage/security-model.md）
 * 手里没有任何可以换会话的材料。登录码只有两条交付通道：server 自己打开浏览器，或启动者自己的终端。
 * 需要哈希的地方（会话 id、nonce、登录码）一律只存 sha256，进程内存被转储也拿不到可用值。
 */
import { createHash, randomBytes } from 'node:crypto'

export const BOOTSTRAP_CODE_TTL_MS = 120_000
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_SESSIONS = 64
export const MAX_OUTSTANDING_CODES = 16
export const PRESENCE_TTL_MS = 30_000
export const MAX_PRESENCE_PER_SESSION = 8
/** Cookie values and codes are 43-char base64url; anything far longer is refused before hashing. */
const MAX_SECRET_LENGTH = 128

/** 已通过校验的会话。`id` 是会话秘密的 sha256，不是可用凭证。 */
export interface SessionInfo {
  readonly id: string
}

/** nonce 绑定的那一次评审确认：换任何一个字段都不能复用。 */
export interface PresenceBinding {
  readonly root: string
  readonly change: string
  readonly ref: string
  readonly expectedRevision: number
}

export interface SessionAuthority {
  /** 铸一枚一次性登录码；调用方只能把它交给浏览器（server 自开或启动者终端）。 */
  mintCode(): string
  /** 作废一枚还没用过的登录码（交付失败时）。 */
  discardCode(code: string): void
  /** 消费登录码并建立会话；返回要写进 cookie 的会话秘密，码无效/过期/已用返回 null。 */
  exchange(code: string): string | null
  /** 校验 cookie 里的会话秘密；有效则刷新空闲计时。 */
  resolve(secret: string | undefined): SessionInfo | null
  issuePresence(session: SessionInfo, binding: PresenceBinding): string
  /** 单次使用：无论成败，出示过的 nonce 都被销毁。 */
  consumePresence(session: SessionInfo, binding: PresenceBinding, nonce: string | undefined): boolean
  /** 当前存活的会话数（测试与诊断用）。 */
  sessionCount(): number
}

function digest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function bindingKey(binding: PresenceBinding): string {
  return JSON.stringify([binding.root, binding.change, binding.ref, binding.expectedRevision])
}

interface SessionRecord {
  readonly createdAt: number
  lastSeen: number
}

interface PresenceRecord {
  readonly sessionId: string
  readonly binding: string
  readonly expiresAt: number
  readonly issuedAt: number
}

export function createSessionAuthority(options: { now?: () => number } = {}): SessionAuthority {
  const now = options.now ?? Date.now
  const codes = new Map<string, number>()
  const sessions = new Map<string, SessionRecord>()
  const presences = new Map<string, PresenceRecord>()

  function purgeCodes(at: number): void {
    for (const [key, expiresAt] of codes) if (expiresAt <= at) codes.delete(key)
  }

  function alive(record: SessionRecord, at: number): boolean {
    return at - record.lastSeen < SESSION_IDLE_MS && at - record.createdAt < SESSION_ABSOLUTE_MS
  }

  function purgeSessions(at: number): void {
    for (const [key, record] of sessions) if (!alive(record, at)) sessions.delete(key)
  }

  function purgePresences(at: number): void {
    for (const [key, record] of presences) {
      if (record.expiresAt <= at || !sessions.has(record.sessionId)) presences.delete(key)
    }
  }

  return {
    mintCode() {
      const at = now()
      purgeCodes(at)
      while (codes.size >= MAX_OUTSTANDING_CODES) {
        const oldest = codes.keys().next().value
        if (oldest === undefined) break
        codes.delete(oldest)
      }
      const code = randomBytes(32).toString('base64url')
      codes.set(digest(code), at + BOOTSTRAP_CODE_TTL_MS)
      return code
    },

    discardCode(code) {
      codes.delete(digest(code))
    },

    exchange(code) {
      if (code === '' || code.length > MAX_SECRET_LENGTH) return null
      const at = now()
      const key = digest(code)
      const expiresAt = codes.get(key)
      codes.delete(key) // 无论成败都是一次性的
      if (expiresAt === undefined || expiresAt <= at) return null
      purgeSessions(at)
      while (sessions.size >= MAX_SESSIONS) {
        let oldest: string | undefined
        let oldestSeen = Infinity
        for (const [id, record] of sessions) {
          if (record.lastSeen < oldestSeen) { oldest = id; oldestSeen = record.lastSeen }
        }
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      const secret = randomBytes(32).toString('base64url')
      sessions.set(digest(secret), { createdAt: at, lastSeen: at })
      return secret
    },

    resolve(secret) {
      if (secret === undefined || secret === '' || secret.length > MAX_SECRET_LENGTH) return null
      const at = now()
      const id = digest(secret)
      const record = sessions.get(id)
      if (record === undefined) return null
      if (!alive(record, at)) {
        sessions.delete(id)
        return null
      }
      record.lastSeen = at
      return { id }
    },

    issuePresence(session, binding) {
      const at = now()
      purgePresences(at)
      const own = [...presences.entries()].filter(([, record]) => record.sessionId === session.id)
      if (own.length >= MAX_PRESENCE_PER_SESSION) {
        own.sort((a, b) => a[1].issuedAt - b[1].issuedAt)
        for (const [key] of own.slice(0, own.length - MAX_PRESENCE_PER_SESSION + 1)) presences.delete(key)
      }
      const nonce = randomBytes(16).toString('base64url')
      presences.set(digest(nonce), {
        sessionId: session.id,
        binding: bindingKey(binding),
        expiresAt: at + PRESENCE_TTL_MS,
        issuedAt: at,
      })
      return nonce
    },

    consumePresence(session, binding, nonce) {
      if (nonce === undefined || nonce === '' || nonce.length > MAX_SECRET_LENGTH) return false
      const key = digest(nonce)
      const record = presences.get(key)
      presences.delete(key)
      if (record === undefined) return false
      return record.expiresAt > now() && record.sessionId === session.id && record.binding === bindingKey(binding)
    },

    sessionCount() {
      purgeSessions(now())
      return sessions.size
    },
  }
}
