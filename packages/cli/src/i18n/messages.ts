/**
 * CLI 消息目录：用户看得到的错误与提示按稳定的消息码登记 zh / en 两份文案，调用处只写码和参数。
 *
 * 约定：
 *  - 码（`change.notFound` 这类点分名）是对外的稳定标识，文案可以改，码不改、不复用；
 *  - 占位符写成 `{name}`，zh 与 en 必须用同一组占位符（目录测试逐条检查）；
 *  - 退出码、JSON 字段名、`ERROR:` / `WARN:` 前缀不翻译，由调用处保留；
 *  - 没有登记进目录的文案保持原样（中文），逐步迁移，覆盖面见 docs/usage/cli-reference。
 */
import { COMMON_MESSAGES } from './messages-common.js'
import { INTEGRITY_MESSAGES } from './messages-integrity.js'
import { STANDARD_MESSAGES } from './messages-standard.js'
import { SUPPORT_MESSAGES } from './messages-support.js'
import { TRANSITION_MESSAGES } from './messages-transition.js'
import { DEFAULT_CLI_LOCALE, type CliLocale } from './locale.js'

export interface MessageEntry {
  readonly zh: string
  readonly en: string
}

export const MESSAGES = {
  ...COMMON_MESSAGES,
  ...TRANSITION_MESSAGES,
  ...SUPPORT_MESSAGES,
  ...STANDARD_MESSAGES,
  ...INTEGRITY_MESSAGES,
} as const satisfies Readonly<Record<string, MessageEntry>>

export type MessageCode = keyof typeof MESSAGES

export type MessageParams = Readonly<Record<string, string | number>>

export const MESSAGE_CODES = Object.keys(MESSAGES) as readonly MessageCode[]

/** `{name}` 占位符；两种语言必须一致。 */
export function placeholdersOf(template: string): readonly string[] {
  return [...new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1] ?? ''))].sort()
}

export function formatMessage(locale: CliLocale, code: MessageCode, params: MessageParams = {}): string {
  const template: string = MESSAGES[code][locale]
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (whole: string, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** 带语言的命令依赖面：只需要 `locale`，缺省沿用历史的中文输出。 */
export interface LocaleCarrier {
  readonly locale?: CliLocale
}

export function localeOf(carrier: LocaleCarrier): CliLocale {
  return carrier.locale ?? DEFAULT_CLI_LOCALE
}

export function msg(carrier: LocaleCarrier, code: MessageCode, params: MessageParams = {}): string {
  return formatMessage(localeOf(carrier), code, params)
}
