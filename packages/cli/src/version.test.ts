import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectHelpGaps, collectStaleHelpKeys } from './i18n/help.js'
import type { CliLocale } from './i18n/locale.js'
import { REPO_ROOT } from './integration-harness.js'
import { buildProgram } from './program.js'
import { makeDeps, type TestDeps } from './test-support.js'

function depsWith(pluginVersion: string | undefined, locale?: CliLocale): TestDeps {
  return Object.assign(makeDeps(), { ...(pluginVersion === undefined ? {} : { pluginVersion }), ...(locale === undefined ? {} : { locale }) })
}

describe('tenon --version / -V', () => {
  test.each(['--version', '-V'])('%s 打印插件清单的版本号后以 exit 0 退出（commander 的 version 退出，不是用法错误）', async (flag) => {
    const deps = depsWith('1.2.3')
    await expect(buildProgram(deps).parseAsync([flag], { from: 'user' })).rejects.toMatchObject({ code: 'commander.version', exitCode: 0 })
    expect(deps.outLines).toEqual(['1.2.3'])
    expect(deps.errLines).toEqual([])
  })

  test('读不到版本时如实打印 unknown，不编造数字', async () => {
    const deps = depsWith(undefined)
    await expect(buildProgram(deps).parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.version', exitCode: 0 })
    expect(deps.outLines).toEqual(['unknown'])
  })

  test('帮助里列出 -V, --version：zh 是中文描述，en 是英文描述；英文表没有缺项也没有死键', () => {
    const zh = buildProgram(depsWith('1.2.3', 'zh')).helpInformation()
    expect(zh).toMatch(/-V, --version\s+显示 Tenon 版本号/u)
    const en = buildProgram(depsWith('1.2.3', 'en')).helpInformation()
    expect(en).toMatch(/-V, --version\s+Print the Tenon version/u)
    expect(/[㐀-鿿]/u.test(en.split('\n').filter((line) => line.includes('--version')).join('\n'))).toBe(false)
    const program = buildProgram(depsWith('1.2.3'))
    expect(collectHelpGaps(program)).toEqual([])
    expect(collectStaleHelpKeys(program)).toEqual([])
  })

  test('子命令里的 -V 不被吞：只有根命令认识它', async () => {
    const deps = depsWith('1.2.3')
    const program = buildProgram(deps)
    expect(program.options.some((option) => option.long === '--version' && option.short === '-V')).toBe(true)
    for (const command of program.commands) expect(command.options.some((option) => option.long === '--version'), command.name()).toBe(false)
  })
})

describe('真实构建产物 —— tenon --version 与仓库、插件清单的版本一致', () => {
  const bundle = join(REPO_ROOT, 'packages/cli/dist/tenon.mjs')
  const readVersion = (...path: string[]): string => String((JSON.parse(readFileSync(join(REPO_ROOT, ...path), 'utf8')) as { version?: unknown }).version)

  test('dist/tenon.mjs --version 与 -V 打印同一个版本号，等于根 package.json 与两份插件清单', () => {
    const long = execFileSync('node', [bundle, '--version'], { encoding: 'utf8' }).trim()
    const short = execFileSync('node', [bundle, '-V'], { encoding: 'utf8' }).trim()
    expect(long).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u)
    expect(short).toBe(long)
    expect(long).toBe(readVersion('package.json'))
    expect(long).toBe(readVersion('.claude-plugin', 'plugin.json'))
    expect(long).toBe(readVersion('.codex-plugin', 'plugin.json'))
  })

  test('TENON_LANG=en 的帮助里有英文的 --version 说明', () => {
    const help = execFileSync('node', [bundle, '--help'], { encoding: 'utf8', env: { ...process.env, TENON_LANG: 'en' } })
    expect(help).toMatch(/-V, --version\s+Print the Tenon version/u)
  })
})
