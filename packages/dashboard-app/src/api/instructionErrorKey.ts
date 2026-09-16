import { ApiError } from './transport'

/**
 * 把 server 的错误码翻成词典键后缀（`errors.<key>`）：横线换下划线，未知码一律 unknown。
 * 页面据此显示本地文案，绝不直出 server 原文或 Error.message。
 */
export function instructionErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined
  return code === undefined || code === '' ? 'unknown' : code.replace(/-/g, '_')
}
