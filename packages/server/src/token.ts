/**
 * 写 token（B5 起）：启动生成 256-bit 随机值，只存在 server 内存里。
 * 它不再落盘、不再出现在任何匿名可达的响应里：只有带有效会话 cookie 的 `GET /` 会把它注入页面。
 * 所有写端点校验 header（Authorization: Bearer / X-Pipeline-Token）——常量时间比较防时序侧信道。
 * 登录凭证（一次性登录码 + 会话）见 serverSession.ts。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/** 从请求头取 token：优先 Authorization: Bearer <t>，回退 X-Pipeline-Token: <t>；无 → null。 */
export function tokenFromHeaders(headers: IncomingHttpHeaders): string | null {
  const auth = headers['authorization']
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m?.[1]) return m[1].trim()
  }
  const x = headers['x-pipeline-token']
  if (typeof x === 'string' && x.trim() !== '') return x.trim()
  return null
}

/** 常量时间比较（长度不等直接 false，不抛；空串 false）。 */
export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
