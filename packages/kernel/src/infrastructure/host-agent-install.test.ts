import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderHostAgent, type HostAgentHost } from '../agents/host-native.js'
import type { AgentDefinition } from '../agents/types.js'
import { computeContentHash } from '../state/ownership-manifest.js'
import { hostAgentsDir, installHostAgents, uninstallHostAgents, userHostAgentPath } from './host-agent-install.js'

const definition = (name: string, description = `${name} 说明`): AgentDefinition => ({
  name, description, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], model: 'sonnet', body: '\n正文\n',
})
const agentsOf = (...names: string[]) => names.map((name) => ({ name, definition: definition(name) }))

let root: string
let homeDir: string
let configRoot: string
/** 默认配置目录下的子代理目录（环境变量缺席时宿主读的位置）。 */
let claudeDir: string
let codexDir: string
const manifestPath = (): string => join(configRoot, 'agents', 'host-owned.json')
const manifest = (): Record<string, Record<string, string>> => JSON.parse(readFileSync(manifestPath(), 'utf8'))
const claudeFile = (name: string): string => join(claudeDir, `tenon-${name}.md`)
const codexFile = (name: string): string => join(codexDir, `tenon-${name}.toml`)
const defaultDir = (host: HostAgentHost): string => (host === 'claude' ? claudeDir : codexDir)
const install = (names: string[], host: HostAgentHost = 'claude', agentsDir = defaultDir(host)) =>
  installHostAgents({ agentsDir, configRoot, host, agents: agentsOf(...names) })
const uninstall = (host: HostAgentHost = 'claude', agentsDir = defaultDir(host)) =>
  uninstallHostAgents({ agentsDir, configRoot, host })
const states = (outcomes: readonly { agent: string; state: string }[]): Record<string, string> =>
  Object.fromEntries(outcomes.map((o) => [o.agent, o.state]))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-host-install-'))
  homeDir = join(root, 'home')
  configRoot = join(root, 'config')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(configRoot, { recursive: true })
  claudeDir = hostAgentsDir('claude', { homeDir, env: {}, platform: process.platform })
  codexDir = hostAgentsDir('codex', { homeDir, env: {}, platform: process.platform })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('hostAgentsDir', () => {
  const dirOf = (host: HostAgentHost, env: Record<string, string | undefined>): string =>
    hostAgentsDir(host, { homeDir, env, platform: process.platform })

  test('环境变量缺席 → home 下的默认配置目录', () => {
    expect(dirOf('claude', {})).toBe(join(homeDir, '.claude', 'agents'))
    expect(dirOf('codex', {})).toBe(join(homeDir, '.codex', 'agents'))
  })

  test('CLAUDE_CONFIG_DIR 是绝对路径 → <它>/agents；CODEX_HOME 同理', () => {
    const claudeConfig = join(root, 'cc-dir')
    const codexConfig = join(root, 'codex-dir')
    expect(dirOf('claude', { CLAUDE_CONFIG_DIR: claudeConfig })).toBe(join(claudeConfig, 'agents'))
    expect(dirOf('codex', { CODEX_HOME: codexConfig })).toBe(join(codexConfig, 'agents'))
  })

  test.each([
    ['相对路径', 'cc-config'],
    ['空串', ''],
    ['纯空白', '   '],
    ['未定义', undefined],
  ])('CLAUDE_CONFIG_DIR 为%s → 不采用，回到 ~/.claude/agents（Review Focus 12）', (_label, value) => {
    expect(dirOf('claude', { CLAUDE_CONFIG_DIR: value })).toBe(join(homeDir, '.claude', 'agents'))
  })

  test('CODEX_HOME 为相对路径或空白 → 回到 ~/.codex/agents', () => {
    expect(dirOf('codex', { CODEX_HOME: 'codex-home' })).toBe(join(homeDir, '.codex', 'agents'))
    expect(dirOf('codex', { CODEX_HOME: '  ' })).toBe(join(homeDir, '.codex', 'agents'))
  })

  test('首尾空白与末尾斜杠去掉后照常采用（Review Focus 12）', () => {
    const claudeConfig = join(root, 'cc-trim')
    expect(dirOf('claude', { CLAUDE_CONFIG_DIR: `  ${claudeConfig}/  ` })).toBe(join(claudeConfig, 'agents'))
  })

  test('CODEX_HOME 只影响 codex，CLAUDE_CONFIG_DIR 只影响 claude', () => {
    const env = { CLAUDE_CONFIG_DIR: join(root, 'cc-only'), CODEX_HOME: join(root, 'codex-only') }
    expect(dirOf('claude', env)).toBe(join(root, 'cc-only', 'agents'))
    expect(dirOf('codex', env)).toBe(join(root, 'codex-only', 'agents'))
    expect(dirOf('claude', { CODEX_HOME: join(root, 'codex-only') })).toBe(join(homeDir, '.claude', 'agents'))
    expect(dirOf('codex', { CLAUDE_CONFIG_DIR: join(root, 'cc-only') })).toBe(join(homeDir, '.codex', 'agents'))
  })
})

describe('userHostAgentPath', () => {
  test('子代理目录 + tenon-<name>.<扩展名>，Claude 是 .md、Codex 是 .toml', () => {
    expect(userHostAgentPath('/c/agents', 'claude', 'a')).toBe('/c/agents/tenon-a.md')
    expect(userHostAgentPath('/x/agents', 'codex', 'a')).toBe('/x/agents/tenon-a.toml')
  })
})

describe('installHostAgents', () => {
  test('写入两个文件、内容等于渲染结果、清单按子代理目录记两条', async () => {
    const outcomes = await install(['a', 'b'])
    expect(outcomes).toEqual([
      { agent: 'a', path: claudeFile('a'), state: 'written' },
      { agent: 'b', path: claudeFile('b'), state: 'written' },
    ])
    expect(readFileSync(claudeFile('a'), 'utf8')).toBe(renderHostAgent('claude', definition('a')))
    expect(readFileSync(claudeFile('b'), 'utf8')).toBe(renderHostAgent('claude', definition('b')))
    expect(manifest()).toEqual({
      [claudeDir]: {
        '.claude/agents/tenon-a.md': computeContentHash(renderHostAgent('claude', definition('a'))),
        '.claude/agents/tenon-b.md': computeContentHash(renderHostAgent('claude', definition('b'))),
      },
    })
  })

  test('目标目录是 CLAUDE_CONFIG_DIR 指向的 C/agents → 文件写在那里，H/.claude 不存在，清单顶层键恰为 C/agents', async () => {
    const configDir = join(root, 'cc-config')
    const agentsDir = hostAgentsDir('claude', { homeDir, env: { CLAUDE_CONFIG_DIR: configDir }, platform: process.platform })
    expect(agentsDir).toBe(join(configDir, 'agents'))
    const outcomes = await install(['a'], 'claude', agentsDir)
    expect(outcomes).toEqual([{ agent: 'a', path: join(configDir, 'agents', 'tenon-a.md'), state: 'written' }])
    expect(readFileSync(join(configDir, 'agents', 'tenon-a.md'), 'utf8')).toBe(renderHostAgent('claude', definition('a')))
    expect(existsSync(join(homeDir, '.claude'))).toBe(false)
    expect(Object.keys(manifest())).toEqual([agentsDir])
  })

  test('再装一次全部 unchanged，文件修改时间不变', async () => {
    await install(['a', 'b'])
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(claudeFile('a'), past, past)
    utimesSync(claudeFile('b'), past, past)
    const again = await install(['a', 'b'])
    expect(states(again)).toEqual({ a: 'unchanged', b: 'unchanged' })
    expect(statSync(claudeFile('a')).mtimeMs).toBe(past.getTime())
    expect(statSync(claudeFile('b')).mtimeMs).toBe(past.getTime())
  })

  test('定义变了、文件没被改过 → 按新内容覆盖', async () => {
    await install(['a'])
    const next = await installHostAgents({
      agentsDir: claudeDir, configRoot, host: 'claude', agents: [{ name: 'a', definition: definition('a', '新说明') }],
    })
    expect(next[0]?.state).toBe('written')
    expect(readFileSync(claudeFile('a'), 'utf8')).toContain('新说明')
  })

  test('目标已有用户自写同名文件 → 内容不变、foreign，且不记所有权', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(claudeFile('a'), '用户自己的\n')
    const outcomes = await install(['a', 'b'])
    expect(states(outcomes)).toEqual({ a: 'foreign', b: 'written' })
    expect(readFileSync(claudeFile('a'), 'utf8')).toBe('用户自己的\n')
    expect(Object.keys(manifest()[claudeDir] ?? {})).toEqual(['.claude/agents/tenon-b.md'])
  })

  test('内容恰好与渲染结果相同的既有文件 → unchanged 并补记所有权', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(claudeFile('a'), renderHostAgent('claude', definition('a')))
    expect(states(await install(['a']))).toEqual({ a: 'unchanged' })
    expect(Object.keys(manifest()[claudeDir] ?? {})).toEqual(['.claude/agents/tenon-a.md'])
  })

  test('清单记着但文件被改过 → 不覆盖、modified', async () => {
    await install(['a'])
    writeFileSync(claudeFile('a'), '改过\n')
    const outcomes = await install(['a'])
    expect(states(outcomes)).toEqual({ a: 'modified' })
    expect(readFileSync(claudeFile('a'), 'utf8')).toBe('改过\n')
  })

  test('清单记着但文件被用户删了 → 重新写入', async () => {
    await install(['a'])
    rmSync(claudeFile('a'))
    expect(states(await install(['a']))).toEqual({ a: 'written' })
    expect(existsSync(claudeFile('a'))).toBe(true)
  })

  test('第二次安装少一个 agent → 少的那个删除并移出清单', async () => {
    await install(['a', 'b'])
    const outcomes = await install(['a'])
    expect(outcomes).toContainEqual({ agent: 'b', path: claudeFile('b'), state: 'removed' })
    expect(existsSync(claudeFile('b'))).toBe(false)
    expect(Object.keys(manifest()[claudeDir] ?? {})).toEqual(['.claude/agents/tenon-a.md'])
  })

  test('少的那个被改过 → 保留、preserved，清单仍记着', async () => {
    await install(['a', 'b'])
    writeFileSync(claudeFile('b'), '改过\n')
    const outcomes = await install(['a'])
    expect(states(outcomes)).toEqual({ a: 'unchanged', b: 'preserved' })
    expect(readFileSync(claudeFile('b'), 'utf8')).toBe('改过\n')
    expect(Object.keys(manifest()[claudeDir] ?? {}).sort())
      .toEqual(['.claude/agents/tenon-a.md', '.claude/agents/tenon-b.md'])
  })

  test('keep 里的名字不回收：库里还在、只是这次装不了（解析失败等）的 agent，已装未改的文件原样保留', async () => {
    await install(['a', 'b'])
    const outcomes = await installHostAgents({ agentsDir: claudeDir, configRoot, host: 'claude', agents: agentsOf('a'), keep: ['b'] })
    expect(states(outcomes)).toEqual({ a: 'unchanged' })
    expect(readFileSync(claudeFile('b'), 'utf8')).toBe(renderHostAgent('claude', definition('b')))
    expect(Object.keys(manifest()[claudeDir] ?? {}).sort())
      .toEqual(['.claude/agents/tenon-a.md', '.claude/agents/tenon-b.md'])
  })

  test('reclaim: false 整个跳过回收：库读不出来时清单里的文件一个不删、清单不变', async () => {
    await install(['a', 'b'])
    const before = readFileSync(manifestPath(), 'utf8')
    const outcomes = await installHostAgents({ agentsDir: claudeDir, configRoot, host: 'claude', agents: [], reclaim: false })
    expect(outcomes).toEqual([])
    expect(existsSync(claudeFile('a'))).toBe(true)
    expect(existsSync(claudeFile('b'))).toBe(true)
    expect(readFileSync(manifestPath(), 'utf8')).toBe(before)
  })

  test('~/.claude 是指向别处的符号链接 → 正常写入链接指向的目录', async () => {
    const dotfiles = join(root, 'dotfiles-claude')
    mkdirSync(dotfiles)
    symlinkSync(dotfiles, join(homeDir, '.claude'))
    expect(states(await install(['a']))).toEqual({ a: 'written' })
    expect(readFileSync(join(dotfiles, 'agents', 'tenon-a.md'), 'utf8')).toBe(renderHostAgent('claude', definition('a')))
    // 链接内的删除同样可行
    expect(states(await uninstall())).toEqual({ a: 'removed' })
    expect(existsSync(join(dotfiles, 'agents', 'tenon-a.md'))).toBe(false)
  })

  test('目标文件本身是符号链接 → failed，链接目标不被改写', async () => {
    const elsewhere = join(root, 'elsewhere.md')
    writeFileSync(elsewhere, '别处的内容\n')
    mkdirSync(claudeDir, { recursive: true })
    symlinkSync(elsewhere, claudeFile('a'))
    const outcomes = await install(['a', 'b'])
    expect(states(outcomes)).toEqual({ a: 'failed', b: 'written' })
    expect(outcomes[0]?.detail).toContain('符号链接')
    expect(readFileSync(elsewhere, 'utf8')).toBe('别处的内容\n')
  })

  test('目标是悬空符号链接 → failed，不在链接指向处创建文件', async () => {
    const missing = join(root, 'not-there.md')
    mkdirSync(claudeDir, { recursive: true })
    symlinkSync(missing, claudeFile('a'))
    expect(states(await install(['a']))).toEqual({ a: 'failed' })
    expect(existsSync(missing)).toBe(false)
  })

  test('目标位置是目录 → 只让这一项 failed，其余照写，不残留临时文件', async () => {
    mkdirSync(claudeFile('a'), { recursive: true })
    expect(states(await install(['a', 'b']))).toEqual({ a: 'failed', b: 'written' })
    expect(readdirSync(claudeDir).sort()).toEqual(['tenon-a.md', 'tenon-b.md'])
  })

  test('agent 名不合法（路径穿越）→ failed，不写任何文件', async () => {
    const outcomes = await installHostAgents({
      agentsDir: claudeDir, configRoot, host: 'claude', agents: [{ name: '../../escape', definition: definition('x') }],
    })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.state).toBe('failed')
    expect(existsSync(join(root, 'escape.md'))).toBe(false)
    expect(existsSync(join(homeDir, '.claude'))).toBe(false)
  })

  test('host: codex → 写 <codex 目录>/tenon-<name>.toml，清单多一组 codex 目录，不动 claude 目录的条目', async () => {
    await install(['a'])
    const outcomes = await install(['a', 'b'], 'codex')
    expect(states(outcomes)).toEqual({ a: 'written', b: 'written' })
    expect(readFileSync(codexFile('a'), 'utf8')).toBe(renderHostAgent('codex', definition('a')))
    expect(readFileSync(codexFile('a'), 'utf8')).toContain('name = "tenon-a"')
    const stored = manifest()
    expect(Object.keys(stored).sort()).toEqual([claudeDir, codexDir].sort())
    expect(Object.keys(stored[codexDir] ?? {}).sort()).toEqual(['.codex/agents/tenon-a.toml', '.codex/agents/tenon-b.toml'])
    // 只装 codex 的第二次不会因为「claude 的 a 不在列表里」去删它
    await install([], 'codex')
    expect(existsSync(claudeFile('a'))).toBe(true)
  })

  test('清单里的越界或非 Tenon 路径条目：不删对应文件，也不从清单里丢掉', async () => {
    const victim = join(root, 'victim.md')
    writeFileSync(victim, 'victim\n')
    mkdirSync(join(configRoot, 'agents'), { recursive: true })
    const bogus = { [claudeDir]: { '../victim.md': computeContentHash('victim\n'), '.claude/agents/other.md': 'x' } }
    writeFileSync(manifestPath(), JSON.stringify(bogus))
    await install(['a'])
    expect(readFileSync(victim, 'utf8')).toBe('victim\n')
    expect(Object.keys(manifest()[claudeDir] ?? {}).sort())
      .toEqual(['.claude/agents/other.md', '.claude/agents/tenon-a.md', '../victim.md'].sort())
  })

  test('并发安装不同宿主：清单两个目录都在（清单读改写受锁保护）', async () => {
    await Promise.all([install(['a'], 'claude'), install(['b'], 'codex')])
    expect(Object.keys(manifest()).sort()).toEqual([claudeDir, codexDir].sort())
  })

  test('安装结束后锁目录里不留残留', async () => {
    await install(['a'])
    expect(readdirSync(join(configRoot, 'agents', '.host-owned.lock'))).toEqual([])
  })
})

describe('不同子代理目录互不影响（Review Focus 13）', () => {
  let otherDir: string
  const otherFile = (name: string): string => join(otherDir, `tenon-${name}.md`)

  beforeEach(() => {
    otherDir = hostAgentsDir('claude', { homeDir, env: { CLAUDE_CONFIG_DIR: join(root, 'cc-config') }, platform: process.platform })
  })

  test('先装默认目录再装另一个目录 → 默认目录的文件与清单分组不变；卸载另一个目录也不碰默认目录', async () => {
    await install(['researcher', 'builder'])
    const builderBefore = readFileSync(claudeFile('builder'), 'utf8')
    const defaultGroupBefore = manifest()[claudeDir]

    // 另一个目录只装 researcher：builder 不在传入列表，却不能因此把默认目录里的 builder 当成「库里已删除」。
    const installed = await install(['researcher'], 'claude', otherDir)
    expect(states(installed)).toEqual({ researcher: 'written' })
    expect(existsSync(claudeFile('builder'))).toBe(true)
    expect(readFileSync(claudeFile('builder'), 'utf8')).toBe(builderBefore)
    expect(existsSync(otherFile('builder'))).toBe(false)
    expect(Object.keys(manifest()).sort()).toEqual([claudeDir, otherDir].sort())

    const removed = await uninstall('claude', otherDir)
    expect(states(removed)).toEqual({ researcher: 'removed' })
    expect(existsSync(otherFile('researcher'))).toBe(false)
    expect(existsSync(claudeFile('researcher'))).toBe(true)
    expect(existsSync(claudeFile('builder'))).toBe(true)
    expect(manifest()[claudeDir]).toEqual(defaultGroupBefore)
  })

  test('另一个目录里同名的 Tenon 文件内容与渲染一致但不在它那一组 → 补记到它自己的分组，不认领默认目录的条目', async () => {
    await install(['researcher'])
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(otherFile('researcher'), renderHostAgent('claude', definition('researcher')))
    expect(states(await install(['researcher'], 'claude', otherDir))).toEqual({ researcher: 'unchanged' })
    const stored = manifest()
    expect(Object.keys(stored[otherDir] ?? {})).toEqual(['.claude/agents/tenon-researcher.md'])
    expect(Object.keys(stored[claudeDir] ?? {})).toEqual(['.claude/agents/tenon-researcher.md'])
  })

  test('清单里只有默认目录的组时，对另一个目录卸载 → 空结果，默认目录文件不动', async () => {
    await install(['a'])
    expect(await uninstall('claude', otherDir)).toEqual([])
    expect(existsSync(claudeFile('a'))).toBe(true)
    expect(Object.keys(manifest())).toEqual([claudeDir])
  })

  test('Claude 与 Codex 的目录相同（两个变量指向同一处）→ 同组共存，只回收本宿主的条目', async () => {
    const shared = join(root, 'shared', 'agents')
    await install(['a'], 'claude', shared)
    await install(['a'], 'codex', shared)
    expect(Object.keys(manifest()[shared] ?? {}).sort())
      .toEqual(['.claude/agents/tenon-a.md', '.codex/agents/tenon-a.toml'])
    expect(states(await uninstall('claude', shared))).toEqual({ a: 'removed' })
    expect(existsSync(join(shared, 'tenon-a.md'))).toBe(false)
    expect(existsSync(join(shared, 'tenon-a.toml'))).toBe(true)
    expect(Object.keys(manifest()[shared] ?? {})).toEqual(['.codex/agents/tenon-a.toml'])
  })
})

describe('开发期按宿主名分组的旧清单', () => {
  const legacy = (name: string) => ({ claude: { [`.claude/agents/tenon-${name}.md`]: computeContentHash(renderHostAgent('claude', definition(name))) } })

  test('旧 claude 组原样保留；文件内容与渲染一致 → unchanged 并在子代理目录组补记所有权', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(claudeFile('researcher'), renderHostAgent('claude', definition('researcher')))
    mkdirSync(join(configRoot, 'agents'), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify(legacy('researcher')))

    expect(states(await install(['researcher']))).toEqual({ researcher: 'unchanged' })

    const stored = manifest()
    expect(stored.claude).toEqual(legacy('researcher').claude)
    expect(Object.keys(stored[claudeDir] ?? {})).toEqual(['.claude/agents/tenon-researcher.md'])
  })

  test('旧 claude 组记着、文件被改成别的内容 → 当用户自有文件不碰（foreign），旧组不被解释', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(claudeFile('researcher'), '用户后来改的\n')
    mkdirSync(join(configRoot, 'agents'), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify(legacy('researcher')))

    expect(states(await install(['researcher']))).toEqual({ researcher: 'foreign' })
    expect(readFileSync(claudeFile('researcher'), 'utf8')).toBe('用户后来改的\n')
    expect(manifest().claude).toEqual(legacy('researcher').claude)
  })

  test('卸载不读旧 claude 组：文件一个不删，旧组原样保留', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(claudeFile('researcher'), renderHostAgent('claude', definition('researcher')))
    mkdirSync(join(configRoot, 'agents'), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify(legacy('researcher')))

    expect(await uninstall()).toEqual([])
    expect(existsSync(claudeFile('researcher'))).toBe(true)
    expect(manifest()).toEqual(legacy('researcher'))
  })
})

describe('清单损坏（Review Focus 3）', () => {
  const corruptions: readonly [string, string][] = [
    ['非法 JSON', '{ not json'],
    ['顶层是数组', '[]'],
    ['分组下不是对象', '{"claude": []}'],
    ['摘要不是字符串', '{"claude": {".claude/agents/tenon-a.md": 1}}'],
  ]

  test.each(corruptions)('%s → 已有文件不改不删，只写不存在的，结果带清单损坏说明，清单原样保留', async (_label, text) => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(claudeFile('a'), '用户的 a\n')
    writeFileSync(claudeFile('stale'), 'tenon 以前写的\n')
    writeFileSync(claudeFile('same'), renderHostAgent('claude', definition('same')))
    mkdirSync(join(configRoot, 'agents'), { recursive: true })
    writeFileSync(manifestPath(), text)

    const outcomes = await install(['a', 'b', 'same'])

    expect(states(outcomes)).toEqual({ a: 'foreign', b: 'written', same: 'unchanged' })
    for (const outcome of outcomes) expect(outcome.detail).toContain('清单损坏')
    expect(readFileSync(claudeFile('a'), 'utf8')).toBe('用户的 a\n')
    expect(readFileSync(claudeFile('stale'), 'utf8')).toBe('tenon 以前写的\n')
    expect(readFileSync(claudeFile('b'), 'utf8')).toBe(renderHostAgent('claude', definition('b')))
    expect(readFileSync(manifestPath(), 'utf8')).toBe(text)
  })

  test('卸载遇到损坏清单 → 什么都不删，返回一条带说明的 failed', async () => {
    await install(['a'])
    writeFileSync(manifestPath(), '{ not json')
    const outcomes = await uninstall()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ state: 'failed', path: manifestPath() })
    expect(outcomes[0]?.detail).toContain('清单损坏')
    expect(existsSync(claudeFile('a'))).toBe(true)
    expect(readFileSync(manifestPath(), 'utf8')).toBe('{ not json')
  })
})

describe('uninstallHostAgents', () => {
  test('未改动的删除（removed）、改过的保留并列为 modified，清单只剩保留项；.claude 不删', async () => {
    await install(['a', 'b', 'c'])
    writeFileSync(claudeFile('b'), '改过\n')
    const outcomes = await uninstall()
    expect(states(outcomes)).toEqual({ a: 'removed', b: 'modified', c: 'removed' })
    expect(outcomes.find((o) => o.agent === 'b')?.detail).toContain('被改过')
    expect(existsSync(claudeFile('a'))).toBe(false)
    expect(existsSync(claudeFile('c'))).toBe(false)
    expect(readFileSync(claudeFile('b'), 'utf8')).toBe('改过\n')
    expect(manifest()).toEqual({ [claudeDir]: { '.claude/agents/tenon-b.md': expect.any(String) } })
  })

  test('全部删完：agents 目录空了顺手移除，.claude 与用户其它文件原样保留，清单文件删除', async () => {
    await install(['a'])
    writeFileSync(join(homeDir, '.claude', 'settings.json'), '{}')
    const outcomes = await uninstall()
    expect(states(outcomes)).toEqual({ a: 'removed' })
    expect(existsSync(claudeDir)).toBe(false)
    expect(existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(true)
    expect(existsSync(manifestPath())).toBe(false)
  })

  test('agents 目录里还有用户自己的文件 → 目录保留', async () => {
    await install(['a'])
    writeFileSync(join(claudeDir, 'mine.md'), '我的\n')
    await uninstall()
    expect(existsSync(join(claudeDir, 'mine.md'))).toBe(true)
  })

  test('只处理指定宿主', async () => {
    await install(['a'], 'claude')
    await install(['a'], 'codex')
    await uninstall('claude')
    expect(existsSync(claudeFile('a'))).toBe(false)
    expect(existsSync(codexFile('a'))).toBe(true)
    expect(Object.keys(manifest())).toEqual([codexDir])
  })

  test('目标是符号链接 → 保留（不删用户的链接）', async () => {
    await install(['a'])
    const real = join(root, 'real.md')
    writeFileSync(real, renderHostAgent('claude', definition('a')))
    rmSync(claudeFile('a'))
    symlinkSync(real, claudeFile('a'))
    const outcomes = await uninstall()
    expect(states(outcomes)).toEqual({ a: 'preserved' })
    expect(existsSync(real)).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe(renderHostAgent('claude', definition('a')))
  })

  test('清单记着但文件已不在 → 悄悄移出清单', async () => {
    await install(['a'])
    rmSync(claudeFile('a'))
    expect(await uninstall()).toEqual([])
    expect(existsSync(manifestPath())).toBe(false)
  })

  test('清单里的越界路径、别的宿主路径条目 → 不碰对应文件', async () => {
    const victim = join(root, 'victim.md')
    writeFileSync(victim, 'victim\n')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(codexFile('x'), 'codex 的\n')
    mkdirSync(join(configRoot, 'agents'), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify({
      [claudeDir]: {
        '../victim.md': computeContentHash('victim\n'),
        '.codex/agents/tenon-x.toml': computeContentHash('codex 的\n'),
      },
    }))
    expect(await uninstall()).toEqual([])
    expect(readFileSync(victim, 'utf8')).toBe('victim\n')
    expect(readFileSync(codexFile('x'), 'utf8')).toBe('codex 的\n')
  })

  test('没有清单 → 空结果，不创建任何目录', async () => {
    expect(await uninstall()).toEqual([])
    expect(readdirSync(configRoot)).toEqual([])
    expect(readdirSync(homeDir)).toEqual([])
  })
})
