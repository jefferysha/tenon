/**
 * 帮助文本与用法错误的语言层。
 *
 * 声明处（program*.ts）的中文描述是源文本；英文放在 `help-en*.ts` 的表里，键是命令路径（`document record`）
 * 与「命令路径 + 选项」（`init --track`）。`applyCliLocale` 在 `buildProgram` 末尾遍历整棵命令树：
 *   - en：用表里的英文替换描述（`collectHelpGaps` 保证没有漏译，`collectStaleHelpKeys` 保证表里没有死键）；
 *   - zh：把 commander 自带的英文小标题、`-h, --help` 与 `help` 子命令的描述、用法错误换成中文。
 */
import { Help, type Command } from 'commander'
import { HELP_EN_CORE } from './help-en-core.js'
import { HELP_EN_FLOW } from './help-en-flow.js'
import { HELP_EN_TESTS } from './help-en-tests.js'
import { HELP_EN_OPS } from './help-en-ops.js'
import type { CliLocale } from './locale.js'
import { formatMessage } from './messages.js'

export const HELP_EN: Readonly<Record<string, string>> = {
  ...HELP_EN_CORE, ...HELP_EN_FLOW, ...HELP_EN_TESTS, ...HELP_EN_OPS,
}

/** 命令路径：根命令为 ''，子命令用空格连接（`document record`）。 */
export function commandPath(command: Command): string {
  const names: string[] = []
  for (let cur: Command | null = command; cur !== null && cur.parent !== null; cur = cur.parent) names.unshift(cur.name())
  return names.join(' ')
}

export function optionKey(command: Command, flags: string): string {
  const path = commandPath(command)
  const flag = flags.split(/[ ,|]+/u).find((part) => part.startsWith('--')) ?? flags.split(/[ ,|]+/u)[0] ?? flags
  return path === '' ? flag : `${path} ${flag}`
}

function visit(command: Command, fn: (command: Command) => void): void {
  fn(command)
  for (const child of command.commands) visit(child, fn)
}

export interface HelpEntry {
  readonly key: string
  readonly zh: string
  /** `command` 或 `option` —— 缺译报告里区分。 */
  readonly kind: 'command' | 'option'
}

/** 整棵树上每一条可见的命令描述与选项描述（含隐藏命令，内部命令也译）。 */
export function helpEntries(program: Command): readonly HelpEntry[] {
  const entries: HelpEntry[] = []
  visit(program, (command) => {
    const path = commandPath(command)
    entries.push({ key: path === '' ? 'tenon' : path, zh: command.description(), kind: 'command' })
    for (const option of command.options) {
      if (option.hidden) continue
      entries.push({ key: optionKey(command, option.flags), zh: option.description, kind: 'option' })
    }
  })
  return entries
}

export function collectHelpGaps(program: Command): readonly string[] {
  return helpEntries(program)
    .filter((entry) => entry.zh.trim() !== '' && HELP_EN[entry.key] === undefined)
    .map((entry) => entry.key)
}

export function collectStaleHelpKeys(program: Command): readonly string[] {
  const live = new Set(helpEntries(program).map((entry) => entry.key))
  return Object.keys(HELP_EN).filter((key) => !live.has(key))
}

const USAGE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp
  readonly code: 'usage.missingArgument' | 'usage.unknownOption' | 'usage.unknownCommand' | 'usage.missingOption' | 'usage.optionArgMissing' | 'usage.excessArguments'
  readonly params: (match: RegExpExecArray) => Record<string, string>
}> = [
  { pattern: /^error: missing required argument '([^']*)'/u, code: 'usage.missingArgument', params: (m) => ({ name: m[1] ?? '' }) },
  { pattern: /^error: unknown option '([^']*)'/u, code: 'usage.unknownOption', params: (m) => ({ flag: m[1] ?? '' }) },
  { pattern: /^error: unknown command '([^']*)'/u, code: 'usage.unknownCommand', params: (m) => ({ name: m[1] ?? '' }) },
  { pattern: /^error: required option '([^']*)' not specified/u, code: 'usage.missingOption', params: (m) => ({ flags: m[1] ?? '' }) },
  { pattern: /^error: option '([^']*)' argument missing/u, code: 'usage.optionArgMissing', params: (m) => ({ flags: m[1] ?? '' }) },
  {
    pattern: /^error: too many arguments(?: for '([^']*)')?\. Expected (\d+) arguments? but got (\d+)\./u,
    code: 'usage.excessArguments',
    params: (m) => ({ command: m[1] ?? 'tenon', expected: `${m[2] ?? ''} 个`, actual: `${m[3] ?? ''} 个` }),
  },
]

/** 把 commander 的英文用法错误换成中文；认不出的原样返回。en 不经过这里。 */
export function translateUsageError(text: string): string {
  const [head = '', ...rest] = text.replace(/\n$/u, '').split('\n')
  const match = USAGE_PATTERNS.map((entry) => ({ entry, found: entry.pattern.exec(head) })).find((item) => item.found !== null)
  if (match === undefined || match.found === null) return text
  const translated = formatMessage('zh', match.entry.code, match.entry.params(match.found))
  const suggestion = rest.map((line) => {
    const one = /^\(Did you mean ([^?]*)\?\)$/u.exec(line)
    if (one !== null) return formatMessage('zh', 'usage.didYouMean', { suggestion: (one[1] ?? '').replace(/^one of /u, '') })
    return line
  })
  return `${[translated, ...suggestion].join('\n')}\n`
}

function zhHeadings(text: string): string {
  return text
    .replace(/^Usage:/mu, formatMessage('zh', 'help.heading.usage'))
    .replace(/^Arguments:/mu, formatMessage('zh', 'help.heading.arguments'))
    .replace(/^Options:/mu, formatMessage('zh', 'help.heading.options'))
    .replace(/^Commands:/mu, formatMessage('zh', 'help.heading.commands'))
}

/** 在整棵命令树上应用语言：英文替换描述，中文替换 commander 自带的英文界面文字。 */
export function applyCliLocale(program: Command, locale: CliLocale): void {
  visit(program, (command) => {
    const path = commandPath(command)
    if (locale === 'en') {
      const text = HELP_EN[path === '' ? 'tenon' : path]
      if (text !== undefined) command.description(text)
      for (const option of command.options) {
        const optionText = HELP_EN[optionKey(command, option.flags)]
        if (optionText !== undefined) option.description = optionText
      }
      return
    }
    command.helpOption('-h, --help', formatMessage('zh', 'help.option'))
    if (command.commands.length > 0) command.helpCommand('help [command]', formatMessage('zh', 'help.command'))
    command.configureHelp({
      formatHelp: (cmd, helper) => zhHeadings(Help.prototype.formatHelp.call(helper, cmd, helper)),
    })
    const base = command.configureOutput()
    command.configureOutput({
      ...base,
      outputError: (text, write) => write(translateUsageError(text)),
    })
  })
}
