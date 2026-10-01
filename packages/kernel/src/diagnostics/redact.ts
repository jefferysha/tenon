/**
 * 诊断文本脱敏：日志落盘前去掉凭证（`redactCredentials`），支持包出门前再去掉个人信息（`redactForSharing`）。
 *
 * 两层分开，是因为留在本机的日志只需要「不含凭证」，而交给别人的包还要抹掉 home 路径、邮箱和用户名。
 * 纯函数、无 I/O、同一输入同一输出；重复脱敏幂等（标记 `[REDACTED:…]` 不会被再次计数）。
 * 宁可多抹也不漏：键名里带 token / secret / password / cookie / session 等字样的值一律抹掉，
 * 诊断价值靠键名和周围的文字保留，不靠值。
 */

export type RedactionKind = 'token' | 'cookie' | 'credential-url' | 'private-key' | 'email' | 'home-path' | 'user-name'

export type RedactionCounts = Readonly<Record<RedactionKind, number>>

export interface RedactionResult {
  readonly text: string
  readonly counts: RedactionCounts
}

export interface SharingRedactionOptions {
  /** 需要折成 `~` 的 home 目录（已知的真实路径，含 realpath 变体）。 */
  readonly homeDirs?: readonly string[]
  /** 需要从文本里抹掉的已知用户名（系统账户名、声明的 TENON_USER_NAME 等）。 */
  readonly userNames?: readonly string[]
}

/** 单行上限：超长行（压缩过的 JSON、base64 块）既拖慢脱敏又没有诊断价值。 */
export const MAX_REDACTED_LINE_CHARS = 16_384

const KINDS: readonly RedactionKind[] = ['token', 'cookie', 'credential-url', 'private-key', 'email', 'home-path', 'user-name']
const MARK = '[REDACTED'
/** 这些值本身不是秘密，抹掉只会让日志读不懂。 */
const HARMLESS_VALUE = /^(?:null|undefined|true|false|none|\[\]|\{\}|<[^>]*>)$/iu

const SECRET_WORD = String.raw`(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|private[_-]?key|credential|cookie|session|authorization|signature|nonce)`
const KEY_VALUE = new RegExp(
  String.raw`\b([A-Za-z0-9_.-]*${SECRET_WORD}[A-Za-z0-9_.-]*)(["']?[ \t]*[:=][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'{}\[\]()][^\s,;&"'}\])]*)`,
  'giu',
)
const CLI_FLAG = new RegExp(
  String.raw`(--[A-Za-z0-9-]*${SECRET_WORD}[A-Za-z0-9-]*)(=|[ \t]+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'-][^\s"']*)`,
  'giu',
)
const QUERY_CODE = /([?&](?:code|login_code|otp|state|presence_nonce)=)([^&\s"'#]+)/giu
const COOKIE_HEADER = /^([ \t]*(?:set-)?cookie[ \t]*:)[^\r\n]*/gimu
const AUTH_HEADER = /^([ \t]*(?:proxy-)?authorization[ \t]*:)[^\r\n]*/gimu
const BEARER = /\b(Bearer|Basic)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/gu
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/gu
const KNOWN_TOKEN = new RegExp([
  String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`,
].join('|'), 'gu')
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/giu
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
const PRIVATE_KEY_TRUNCATED = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/u
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu
const POSIX_HOME = /(?<![A-Za-z0-9_.~-])\/(?:Users|home)\/(?!Shared(?![A-Za-z0-9_]))[^/\s"'`:;,)\]}>\\]+/gu
const WINDOWS_HOME = /(?<![A-Za-z0-9_.~-])[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+[^\\/\s"'`:;,)\]}>]+/gu
/** 这些词作为用户名太通用，整词替换会毁掉日志；它们若真是路径里的账户名，home 规则已经处理。 */
const GENERIC_NAMES = new Set(['root', 'user', 'users', 'admin', 'node', 'home', 'test', 'tmp', 'var'])

function emptyCounts(): Record<RedactionKind, number> {
  return { token: 0, cookie: 0, 'credential-url': 0, 'private-key': 0, email: 0, 'home-path': 0, 'user-name': 0 }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function alreadyMarked(value: string): boolean {
  return value.replace(/^["']/u, '').startsWith(MARK)
}

function unquoted(value: string): string {
  return value.replace(/^["']|["']$/gu, '')
}

function isHarmless(value: string): boolean {
  return HARMLESS_VALUE.test(unquoted(value))
}

function maskValue(value: string, label: string): string {
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
  return `${quote}${MARK}:${label}]${quote}`
}

function stripPrivateKeys(input: string, counts: Record<RedactionKind, number>): string {
  if (!input.includes('PRIVATE KEY-----')) return input
  const mask = (): string => {
    counts['private-key'] += 1
    return `${MARK}:private-key]`
  }
  return input.replace(PRIVATE_KEY, mask).replace(PRIVATE_KEY_TRUNCATED, mask)
}

function redactLineCredentials(input: string, counts: Record<RedactionKind, number>): string {
  let text = input.replace(COOKIE_HEADER, (whole: string, head: string) => {
    if (whole.slice(head.length).trim().startsWith(MARK)) return whole
    counts.cookie += 1
    return `${head} ${MARK}:cookie]`
  })
  text = text.replace(AUTH_HEADER, (whole: string, head: string) => {
    if (whole.slice(head.length).trim().startsWith(MARK)) return whole
    counts.token += 1
    return `${head} ${MARK}:token]`
  })
  text = text.replace(URL_CREDENTIALS, (_whole, scheme: string) => {
    counts['credential-url'] += 1
    return `${scheme}${MARK}:credentials]@`
  })
  text = text.replace(KEY_VALUE, (whole: string, key: string, sep: string, value: string) => {
    if (alreadyMarked(value) || isHarmless(value)) return whole
    const cookie = /cookie|session/iu.test(key)
    counts[cookie ? 'cookie' : 'token'] += 1
    return `${key}${sep}${maskValue(value, cookie ? 'cookie' : 'token')}`
  })
  text = text.replace(CLI_FLAG, (whole: string, flag: string, sep: string, value: string) => {
    if (alreadyMarked(value) || isHarmless(value)) return whole
    counts.token += 1
    return `${flag}${sep}${maskValue(value, 'token')}`
  })
  text = text.replace(QUERY_CODE, (whole: string, head: string, value: string) => {
    if (alreadyMarked(value)) return whole
    counts.token += 1
    return `${head}${MARK}:token]`
  })
  text = text.replace(BEARER, (whole: string, scheme: string, gap: string) => {
    if (whole.includes(MARK)) return whole
    counts.token += 1
    return `${scheme}${gap}${MARK}:token]`
  })
  for (const pattern of [JWT, KNOWN_TOKEN]) {
    text = text.replace(pattern, () => {
      counts.token += 1
      return `${MARK}:token]`
    })
  }
  return text
}

function clampLine(line: string): string {
  return line.length > MAX_REDACTED_LINE_CHARS ? `${line.slice(0, MAX_REDACTED_LINE_CHARS)}…[line truncated]` : line
}

function perLine(input: string, apply: (line: string) => string): string {
  return input.split('\n').map((line) => apply(clampLine(line))).join('\n')
}

/** 去掉凭证：token、cookie、会话码、带密码的 URL、私钥块。留在本机的日志落盘前用它。 */
export function redactCredentials(input: string): RedactionResult {
  const counts = emptyCounts()
  // 私钥块跨行，整体先处理；其余规则逐行（超长行先截断，避免正则在大文本上退化）。
  const text = perLine(stripPrivateKeys(input, counts), (line) => redactLineCredentials(line, counts))
  return { text, counts }
}

function homeVariants(dir: string): string[] {
  const trimmed = dir.replace(/[\\/]+$/u, '')
  if (trimmed.length < 3) return []
  const variants = new Set([trimmed, trimmed.replace(/\\/gu, '/'), trimmed.replace(/\\/gu, '\\\\')])
  return [...variants]
}

/** 交给别人的文本：先去凭证，再抹邮箱、折叠 home 路径（含路径里的账户名）、抹已知用户名。 */
export function redactForSharing(input: string, options: SharingRedactionOptions = {}): RedactionResult {
  const counts = emptyCounts()
  const homes = [...new Set((options.homeDirs ?? []).flatMap(homeVariants))]
    .sort((a, b) => b.length - a.length)
    .map((dir) => new RegExp(`${escapeRegExp(dir)}(?=[\\\\/\\s"'\`:;,)\\]}>]|$)`, 'gu'))
  const names = [...new Set((options.userNames ?? []).map((name) => name.trim()).filter(
    (name) => name.length >= 3 && !GENERIC_NAMES.has(name.toLowerCase()),
  ))].map((name) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'giu'))
  const text = perLine(stripPrivateKeys(input, counts), (rawLine) => {
    let line = redactLineCredentials(rawLine, counts)
    line = line.replace(EMAIL, (whole: string) => {
      if (whole.startsWith('git@')) return whole
      counts.email += 1
      return `${MARK}:email]`
    })
    for (const home of homes) {
      line = line.replace(home, () => {
        counts['home-path'] += 1
        return '~'
      })
    }
    for (const generic of [POSIX_HOME, WINDOWS_HOME]) {
      line = line.replace(generic, () => {
        counts['home-path'] += 1
        return '~'
      })
    }
    for (const name of names) {
      line = line.replace(name, () => {
        counts['user-name'] += 1
        return `${MARK}:user]`
      })
    }
    return line
  })
  return { text, counts }
}

export function totalRedactions(counts: RedactionCounts): number {
  return KINDS.reduce((sum, kind) => sum + counts[kind], 0)
}

export function addRedactionCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  const out = emptyCounts()
  for (const kind of KINDS) out[kind] = a[kind] + b[kind]
  return out
}

export const NO_REDACTIONS: RedactionCounts = Object.freeze(emptyCounts())
