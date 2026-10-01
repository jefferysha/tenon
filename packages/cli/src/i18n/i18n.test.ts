import { CommanderError } from 'commander'
import { describe, expect, it } from 'vitest'
import { ownerRequiredMessage, taskArchivedMessage, USER_MISSING_HINT } from '@tenon/kernel'
import { buildProgram } from '../program.js'
import { makeDeps } from '../test-support.js'
import { collectHelpGaps, collectStaleHelpKeys, HELP_EN, helpEntries, translateUsageError } from './help.js'
import { resolveCliLocale, type CliLocale } from './locale.js'
import { formatMessage, MESSAGE_CODES, MESSAGES, placeholdersOf } from './messages.js'

const CJK = /[㐀-鿿＀-￯　-〿]/u

function envOf(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name]
}

describe('resolveCliLocale', () => {
  it('TENON_LANG 优先，认 en / zh 及其 locale 写法，其它值当没设', () => {
    expect(resolveCliLocale(envOf({ TENON_LANG: 'en', LANG: 'zh_CN.UTF-8' }))).toBe('en')
    expect(resolveCliLocale(envOf({ TENON_LANG: 'zh', LANG: 'en_US.UTF-8' }))).toBe('zh')
    expect(resolveCliLocale(envOf({ TENON_LANG: 'EN-us' }))).toBe('en')
    expect(resolveCliLocale(envOf({ TENON_LANG: 'zh_TW' }))).toBe('zh')
    expect(resolveCliLocale(envOf({ TENON_LANG: 'fr', LANG: 'zh_CN.UTF-8' }))).toBe('zh')
  })

  it('没有 TENON_LANG 时按 LC_ALL → LC_MESSAGES → LANG；非中文的明确语言给英文', () => {
    expect(resolveCliLocale(envOf({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }))).toBe('zh')
    expect(resolveCliLocale(envOf({ LC_MESSAGES: 'en_GB.UTF-8', LANG: 'zh_CN.UTF-8' }))).toBe('en')
    expect(resolveCliLocale(envOf({ LANG: 'zh_CN.UTF-8' }))).toBe('zh')
    expect(resolveCliLocale(envOf({ LANG: 'en_US.UTF-8' }))).toBe('en')
    expect(resolveCliLocale(envOf({ LANG: 'ja_JP.UTF-8' }))).toBe('en')
    expect(resolveCliLocale(envOf({ LC_ALL: '', LANG: 'en_US.UTF-8' }))).toBe('en')
  })

  it('没有信号、或钉成 C / POSIX（hook 为了输出稳定会这样做）时保持历史的中文输出', () => {
    expect(resolveCliLocale(envOf({}))).toBe('zh')
    expect(resolveCliLocale(envOf({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }))).toBe('zh')
    expect(resolveCliLocale(envOf({ LANG: 'POSIX' }))).toBe('zh')
    expect(resolveCliLocale(envOf({ LANG: 'C.UTF-8' }))).toBe('zh')
  })
})

describe('消息目录', () => {
  it('每个码都有 zh 与 en，两边的占位符完全一致', () => {
    expect(MESSAGE_CODES.length).toBeGreaterThanOrEqual(60)
    for (const code of MESSAGE_CODES) {
      const entry = MESSAGES[code]
      expect(entry.zh.trim(), `${code} zh`).not.toBe('')
      expect(entry.en.trim(), `${code} en`).not.toBe('')
      expect(placeholdersOf(entry.en), `${code} 占位符`).toEqual(placeholdersOf(entry.zh))
    }
  })

  it('码是点分小写名且不重复；英文文案里没有中文（除了评审确认用语的引用）', () => {
    const seen = new Set<string>()
    for (const code of MESSAGE_CODES) {
      expect(code, code).toMatch(/^[a-z][A-Za-z]*(\.[A-Za-z-]+)+$/u)
      expect(seen.has(code), `${code} 重复`).toBe(false)
      seen.add(code)
      const en = MESSAGES[code].en.replace(/"确认继续"|\\"确认继续\\"/gu, '')
      expect(CJK.test(en), `${code} 的英文里有中文：${en}`).toBe(false)
    }
  })

  it('与 kernel 里仍在用的中文文案逐字一致（迁移不改既有输出）', () => {
    expect(formatMessage('zh', 'user.missing')).toBe(USER_MISSING_HINT)
    expect(formatMessage('zh', 'change.archived', { name: 'demo' })).toBe(taskArchivedMessage('demo'))
    expect(formatMessage('zh', 'owner.required.none', { name: 'demo' })).toBe(ownerRequiredMessage('demo', null))
  })

  it('formatMessage 替换占位符，缺参数的占位符原样保留', () => {
    expect(formatMessage('en', 'change.notFound', { name: 'demo' })).toBe('change not found: demo')
    expect(formatMessage('zh', 'change.notFound', { name: 'demo' })).toBe('change 不存在: demo')
    expect(formatMessage('en', 'change.notFound')).toBe('change not found: {name}')
  })
})

describe('帮助文本', () => {
  const program = buildProgram(makeDeps())

  it('每条命令与选项的描述都有英文，表里没有死键', () => {
    expect(collectHelpGaps(program)).toEqual([])
    expect(collectStaleHelpKeys(program)).toEqual([])
    expect(helpEntries(program).length).toBeGreaterThan(300)
  })

  it('英文表里没有中文', () => {
    for (const [key, text] of Object.entries(HELP_EN)) expect(CJK.test(text), `${key}: ${text}`).toBe(false)
  })

  /** 与用户看到的一致：`--help` 的完整输出，含 addHelpText 的后缀。 */
  function help(locale: CliLocale, path: readonly string[] = []): string {
    const deps = { ...makeDeps(), locale }
    let command = buildProgram(deps)
    for (const name of path) {
      const next = command.commands.find((candidate) => candidate.name() === name)
      if (next === undefined) throw new Error(`no command ${path.join(' ')}`)
      command = next
    }
    command.outputHelp()
    return (deps as unknown as { outLines: string[] }).outLines.join('\n')
  }

  it('en：根帮助与子命令帮助全是英文', () => {
    const root = help('en')
    expect(root).toContain('Usage: tenon')
    expect(root).toContain('Initialize a change')
    expect(root).toContain('Show the Dashboard server log')
    expect(root).toContain('First install: tenon setup --codex')
    expect(CJK.test(root.replace(/确认继续/gu, '')), root).toBe(false)
    const init = help('en', ['init'])
    expect(init).toContain('--track <track>')
    expect(init).toContain('custom workflow name')
    expect(CJK.test(init)).toBe(false)
    const catalogAdd = help('en', ['test', 'catalog', 'add'])
    expect(catalogAdd).toContain('Test-file glob owned by this suite')
    expect(CJK.test(catalogAdd)).toBe(false)
  })

  it('en：带 addHelpText 的命令（loops、triage）后缀也是英文', () => {
    expect(help('en', ['loops'])).toContain('Subcommands:')
    expect(CJK.test(help('en', ['loops']))).toBe(false)
    expect(help('en', ['triage'])).toContain('source: git-commits (HEAD of this repo)')
  })

  it('zh：保持中文描述，commander 自带的英文小标题与 help 描述换成中文', () => {
    const root = help('zh')
    expect(root).toContain('用法: tenon')
    expect(root).toContain('选项:')
    expect(root).toContain('命令:')
    expect(root).toContain('显示帮助')
    expect(root).toContain('初始化 change')
    expect(root).not.toContain('Usage:')
    expect(root).not.toContain('display help for command')
    expect(help('zh', ['init'])).toContain('用法: tenon init [options] <name>')
  })

  it('缺省（不带 locale 的 deps）等同 zh', () => {
    const deps = makeDeps()
    buildProgram(deps).outputHelp()
    expect(deps.outLines.join('\n')).toBe(help('zh'))
  })
})

describe('用法错误', () => {
  async function usageError(locale: CliLocale, argv: string[]): Promise<{ code: string; text: string }> {
    const deps = { ...makeDeps(), locale }
    const errors = (deps as unknown as { errLines: string[] }).errLines
    try {
      await buildProgram(deps).parseAsync(argv, { from: 'user' })
    } catch (error) {
      if (error instanceof CommanderError) return { code: error.code, text: errors.join('\n') }
      throw error
    }
    throw new Error('expected a usage error')
  }

  it('en：commander 的原文', async () => {
    expect((await usageError('en', ['init'])).text).toBe("error: missing required argument 'name'")
    expect((await usageError('en', ['logs', '--bogus'])).text).toContain("error: unknown option '--bogus'")
    expect((await usageError('en', ['nope'])).text).toContain("error: unknown command 'nope'")
    expect((await usageError('en', ['artifact', 'register', 'c', 'f', 'p'])).text)
      .toBe("error: required option '--producer <skill-id>' not specified")
    expect((await usageError('en', ['logs', '--lines'])).text).toBe("error: option '-n, --lines <n>' argument missing")
  })

  it('zh：同样的错误换成中文，码与退出语义不变', async () => {
    const missing = await usageError('zh', ['init'])
    expect(missing.code).toBe('commander.missingArgument')
    expect(missing.text).toBe("错误：缺少必需的参数 'name'")
    expect((await usageError('zh', ['logs', '--bogus'])).text).toContain("错误：未知选项 '--bogus'")
    expect((await usageError('zh', ['nope'])).text).toContain("错误：未知命令 'nope'")
    expect((await usageError('zh', ['artifact', 'register', 'c', 'f', 'p'])).text)
      .toBe("错误：必须指定选项 '--producer <skill-id>'")
    expect((await usageError('zh', ['logs', '--lines'])).text).toBe("错误：选项 '-n, --lines <n>' 缺少参数值")
  })

  it('translateUsageError 保留 Did you mean 提示，认不出的原样返回', () => {
    expect(translateUsageError("error: unknown option '--fllow'\n(Did you mean --follow?)\n"))
      .toBe("错误：未知选项 '--fllow'\n（你是不是想用 --follow？）\n")
    expect(translateUsageError("error: option '--x' argument 'y' is invalid.")).toBe("error: option '--x' argument 'y' is invalid.")
    expect(translateUsageError("error: too many arguments for 'status'. Expected 1 argument but got 2.\n"))
      .toBe("错误：'status' 的参数过多（应为 1 个，实际 2 个）\n")
  })
})
