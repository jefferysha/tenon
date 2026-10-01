/**
 * CLI 输出语言：`TENON_LANG=en|zh` 优先，其次按 POSIX 顺序看 `LC_ALL` → `LC_MESSAGES` → `LANG`。
 *
 * 缺省是 zh（历史行为）：没有任何语言信号、或信号是 `C` / `POSIX`（hook 与脚本为了输出稳定会钉 `LC_ALL=C`）时，
 * 输出和以前逐字一致。系统 locale 里明确的非中文语言（en_US、fr_FR、ja_JP …）给英文——产品只有这两种语言。
 * `TENON_LANG` 只认 en / zh（含 en-US、zh_CN 这类写法），其它值当没设。
 */
export type CliLocale = 'zh' | 'en'

export const DEFAULT_CLI_LOCALE: CliLocale = 'zh'

function classifySystem(raw: string): CliLocale | 'neutral' {
  const value = raw.trim().toLowerCase()
  if (value === 'c' || value === 'posix' || value.startsWith('c.')) return 'neutral'
  return value.startsWith('zh') ? 'zh' : 'en'
}

function classifyOverride(raw: string): CliLocale | undefined {
  const value = raw.trim().toLowerCase()
  if (value === 'zh' || value.startsWith('zh-') || value.startsWith('zh_')) return 'zh'
  if (value === 'en' || value.startsWith('en-') || value.startsWith('en_')) return 'en'
  return undefined
}

export function resolveCliLocale(read: (name: string) => string | undefined): CliLocale {
  const override = read('TENON_LANG')
  const forced = override === undefined ? undefined : classifyOverride(override)
  if (forced !== undefined) return forced
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const raw = read(name)
    if (raw === undefined || raw.trim() === '') continue
    const found = classifySystem(raw)
    // 钉死 C locale 的调用方要的是确定性，不是英文：直接落到缺省。
    return found === 'neutral' ? DEFAULT_CLI_LOCALE : found
  }
  return DEFAULT_CLI_LOCALE
}
