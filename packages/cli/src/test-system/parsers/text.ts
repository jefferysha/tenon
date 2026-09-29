/** 解析器共用的文本与路径小工具：去 ANSI、截断、仓库相对路径换算、失败文本拆分。 */
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { CaseFailure } from '@tenon/kernel'
import type { ParseContext } from './types.js'

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const MAX_FIELD = 60_000
const MAX_NAME = 3_000

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '')
}

export function clip(value: string, max = MAX_FIELD): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 用例 / 分组名进记录前的规整：去 ANSI、压空白、非空、限长。 */
export function cleanName(value: string, fallback: string): string {
  const text = stripAnsi(value).replace(/\s+/g, ' ').trim()
  return text === '' ? fallback : clip(text, MAX_NAME)
}

export function toPosix(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/')
}

/**
 * 报告里的文件路径 → 仓库相对、正斜杠路径。绝对路径换算为相对仓库根（在仓库外则原样返回）；
 * 相对路径按 base（默认套件 cwd）解析后再换算。空串原样返回。
 */
export function repoPath(ctx: ParseContext, value: string, base?: string): string {
  if (value === '') return value
  const cleaned = value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
  const absolute = isAbsolute(cleaned) ? cleaned : resolve(base ?? ctx.cwd, cleaned)
  const rel = relative(ctx.repoRoot, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return toPosix(isAbsolute(cleaned) ? cleaned : posix.normalize(toPosix(cleaned)))
  return toPosix(rel)
}

/** 失败文本 → { message: 第一段非空文本, stack: 全文 }；不含 expected / actual（各格式自行补）。 */
export function failureFromText(raw: string, headline?: string): CaseFailure {
  const text = stripAnsi(raw).trim()
  const lines = text.split('\n')
  const firstBlock: string[] = []
  for (const line of lines) {
    if (/^\s+at\s/.test(line)) break
    firstBlock.push(line)
  }
  const message = cleanFailureMessage(headline !== undefined && headline.trim() !== '' ? headline : firstBlock.join('\n'))
  return {
    message,
    ...(text !== '' && text !== message ? { stack: clip(text) } : {}),
  }
}

export function cleanFailureMessage(value: string): string {
  const text = stripAnsi(value).trim()
  return text === '' ? '(无失败信息)' : clip(text, 8_000)
}
