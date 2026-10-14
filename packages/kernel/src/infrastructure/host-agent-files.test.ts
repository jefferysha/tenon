import { execFileSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { hostAgentPath, renderHostAgent, type HostAgentHost } from '../agents/host-native.js'
import type { AgentDefinition } from '../agents/types.js'
import { computeContentHash, parseOwnedManifest } from '../state/ownership-manifest.js'
import type { AgentLibrary } from './agent-store.js'
import { cleanupLegacyHostAgents, renderCurrentFromLibrary } from './host-agent-files.js'

const definition = (name: string, description = `${name} 说明`): AgentDefinition => ({
  name, description, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], model: 'sonnet', body: '\n正文\n',
})

let sandbox: string
let repo: string

const manifestPath = (base = repo): string => join(base, '.pipeline-owned.json')
const manifest = (base = repo): Record<string, string> => parseOwnedManifest(readFileSync(manifestPath(base), 'utf8'))
const read = (rel: string, base = repo): string => readFileSync(join(base, rel), 'utf8')
const has = (rel: string, base = repo): boolean => existsSync(join(base, rel))
/** 当前库对 `a`、`b`、`c` 的渲染（`renderCurrent` 的测试实现）。 */
const renderCurrent = (host: HostAgentHost, name: string): string | undefined =>
  ['a', 'b', 'c'].includes(name) ? renderHostAgent(host, definition(name)) : undefined

function put(rel: string, text: string, base = repo): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true })
  writeFileSync(join(base, rel), text, 'utf8')
}

/** 旧版本留下的状态：文件内容为渲染结果（可指定别的内容），清单按 `listed` 决定是否记账。 */
function legacy(host: HostAgentHost, name: string, opts: { listed?: boolean; text?: string; base?: string } = {}): string {
  const base = opts.base ?? repo
  const rel = hostAgentPath(host, name)
  const text = opts.text ?? renderHostAgent(host, definition(name))
  put(rel, text, base)
  if (opts.listed !== false) {
    const current = existsSync(manifestPath(base)) ? manifest(base) : {}
    // 记录的是旧版本写入时的内容摘要，与现在盘上的内容（可能已被改过）无关。
    current[rel] = computeContentHash(renderHostAgent(host, definition(name)))
    writeFileSync(manifestPath(base), `${JSON.stringify(current, null, 2)}\n`)
  }
  return rel
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenon-legacy-host-agents-'))
  repo = join(sandbox, 'repo')
  mkdirSync(repo, { recursive: true })
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('cleanupLegacyHostAgents：清单与当前渲染两条删除依据', () => {
  test('清单记着且没改过 → 删除并移除清单项；清单空了删清单，空目录一并移除', async () => {
    const rel = legacy('claude', 'a')
    const result = await cleanupLegacyHostAgents({ repoRoot: repo })
    expect(result).toEqual({ removed: [rel], preserved: [] })
    expect(has(rel)).toBe(false)
    expect(has('.pipeline-owned.json')).toBe(false)
    expect(has('.claude')).toBe(false)
  })

  test('不在清单但内容等于当前渲染 → 删除（清单条目已被 sync --migrate 剪掉的情况）', async () => {
    const rel = legacy('claude', 'b', { listed: false })
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [rel], preserved: [] })
    expect(has(rel)).toBe(false)
  })

  test('清单记着但已被改过 → 保留进 preserved，清单项原样留着', async () => {
    const rel = legacy('claude', 'a', { text: '用户改过\n' })
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(read(rel)).toBe('用户改过\n')
    expect(Object.keys(manifest())).toEqual([rel])
  })

  test('清单记着、已被改过，但内容恰好等于当前渲染 → 删除（两条依据取其一）', async () => {
    const rel = hostAgentPath('claude', 'a')
    put(rel, renderHostAgent('claude', definition('a')))
    writeFileSync(manifestPath(), `${JSON.stringify({ [rel]: computeContentHash('旧版本的内容\n') })}\n`)
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [rel], preserved: [] })
    expect(has(rel)).toBe(false)
  })

  test('不在清单且内容与当前渲染不同 → 保留进 preserved', async () => {
    const rel = legacy('claude', 'a', { listed: false, text: '用户自己写的\n' })
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(read(rel)).toBe('用户自己写的\n')
    expect(has('.pipeline-owned.json')).toBe(false)
  })

  test('当前库里没有这个 agent（renderCurrent 返回 undefined）→ 不在清单的文件保留', async () => {
    const rel = legacy('claude', 'gone', { listed: false })
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(has(rel)).toBe(true)
  })

  test('renderCurrent 缺省（没装配库或读库失败）→ 只按清单删：清单外的文件不扫描、不报告、不动', async () => {
    const listed = legacy('claude', 'a')
    const unlisted = legacy('claude', 'b', { listed: false })
    const result = await cleanupLegacyHostAgents({ repoRoot: repo })
    expect(result).toEqual({ removed: [listed], preserved: [] })
    expect(has(unlisted)).toBe(true)
  })

  test('Codex 的 .toml 同样处理；两个宿主的目录各自删空', async () => {
    const claude = legacy('claude', 'a')
    const codex = legacy('codex', 'a')
    const result = await cleanupLegacyHostAgents({ repoRoot: repo })
    expect(result.removed).toEqual([claude, codex])
    expect(has('.claude')).toBe(false)
    expect(has('.codex')).toBe(false)
    expect(has('.pipeline-owned.json')).toBe(false)
  })

  test('清单里别的条目、用户自己的 agent 文件、仍有内容的目录原样不动', async () => {
    writeFileSync(manifestPath(), '{\n  "AGENTS.md": "abc"\n}\n')
    put('.claude/agents/mine.md', '用户\n')
    const rel = legacy('claude', 'a')
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [rel], preserved: [] })
    expect(manifest()).toEqual({ 'AGENTS.md': 'abc' })
    expect(read('.claude/agents/mine.md')).toBe('用户\n')
  })

  test('清单项还在、文件已经不在 → 只去掉清单项，不算删除也不算保留', async () => {
    const rel = hostAgentPath('claude', 'a')
    writeFileSync(manifestPath(), `${JSON.stringify({ [rel]: 'abc', 'AGENTS.md': 'def' })}\n`)
    const result = await cleanupLegacyHostAgents({ repoRoot: repo })
    expect(result).toEqual({ removed: [], preserved: [] })
    expect(manifest()).toEqual({ 'AGENTS.md': 'def' })
  })

  test('清单损坏（不是合法 JSON）→ 清单一字不改；仍能按当前渲染删内容一致的文件', async () => {
    writeFileSync(manifestPath(), '{不是 JSON')
    const rel = legacy('claude', 'a', { listed: false })
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [rel], preserved: [] })
    expect(readFileSync(manifestPath(), 'utf8')).toBe('{不是 JSON')
  })

  test('没有任何旧文件 → 什么都不做，也不创建锁目录 .tenon', async () => {
    expect(await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })).toEqual({ removed: [], preserved: [] })
    expect(await cleanupLegacyHostAgents({ repoRoot: repo })).toEqual({ removed: [], preserved: [] })
    expect(has('.tenon')).toBe(false)
  })

  test('重复执行：第二次什么都没有', async () => {
    legacy('claude', 'a')
    await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })).toEqual({ removed: [], preserved: [] })
  })
})

describe('renderCurrentFromLibrary：把 agent 库变成清理用的 renderCurrent（CLI 与 Dashboard 共用）', () => {
  const libraryOf = (...definitions: readonly AgentDefinition[]): AgentLibrary => ({
    entries: definitions.map((def) => ({ name: def.name, source: 'custom' as const, digest: 'sha256:x', content: '', definition: def })),
    sync: { id: 'agents', state: 'unchanged' },
  })

  test('库里有该 agent 且适用于该宿主 → 返回它在该宿主的渲染结果', () => {
    const render = renderCurrentFromLibrary(libraryOf(definition('a')))
    expect(render('claude', 'a')).toBe(renderHostAgent('claude', definition('a')))
    expect(render('codex', 'a')).toBe(renderHostAgent('codex', definition('a')))
  })

  test('库里没有该 agent → undefined', () => {
    expect(renderCurrentFromLibrary(libraryOf(definition('a')))('claude', 'gone')).toBeUndefined()
  })

  test('definition.hosts 不含该宿主 → undefined；含则照渲染', () => {
    const render = renderCurrentFromLibrary(libraryOf({ ...definition('a'), hosts: ['claude'] }))
    expect(render('codex', 'a')).toBeUndefined()
    expect(render('claude', 'a')).toBe(renderHostAgent('claude', { ...definition('a'), hosts: ['claude'] }))
  })

  test('条目解析失败（没有 definition）→ undefined', () => {
    const broken: AgentLibrary = {
      entries: [{ name: 'a', source: 'custom', digest: 'sha256:x', content: '坏', error: '解析失败' }],
      sync: { id: 'agents', state: 'unchanged' },
    }
    expect(renderCurrentFromLibrary(broken)('claude', 'a')).toBeUndefined()
  })
})

describe('cleanupLegacyHostAgents：符号链接一律不跟随', () => {
  test('目标文件本身是符号链接 → 保留，链接目标不被删', async () => {
    const outside = join(sandbox, 'outside.md')
    const rel = hostAgentPath('claude', 'a')
    const text = renderHostAgent('claude', definition('a'))
    writeFileSync(outside, text)
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
    symlinkSync(outside, join(repo, rel))
    writeFileSync(manifestPath(), `${JSON.stringify({ [rel]: computeContentHash(text) })}\n`)
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(lstatSync(join(repo, rel)).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe(text)
  })

  test('父目录是符号链接 → 保留，链接指向的目录里的文件不被删', async () => {
    const outside = join(sandbox, 'outside')
    const rel = hostAgentPath('claude', 'a')
    const text = renderHostAgent('claude', definition('a'))
    put('agents/tenon-a.md', text, outside)
    symlinkSync(outside, join(repo, '.claude'))
    writeFileSync(manifestPath(), `${JSON.stringify({ [rel]: computeContentHash(text) })}\n`)
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(read('agents/tenon-a.md', outside)).toBe(text)
  })

  test('目标位置是目录而不是文件 → 保留，不抛错', async () => {
    const rel = hostAgentPath('claude', 'a')
    mkdirSync(join(repo, rel), { recursive: true })
    writeFileSync(manifestPath(), `${JSON.stringify({ [rel]: 'abc' })}\n`)
    const result = await cleanupLegacyHostAgents({ repoRoot: repo, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(has(rel)).toBe(true)
  })
})

describe('cleanupLegacyHostAgents：在 linked worktree 里调用清理的是主检出', () => {
  function repoWithWorktree(): { main: string; linked: string } {
    const main = join(sandbox, 'main')
    const linked = join(sandbox, 'wt')
    mkdirSync(main, { recursive: true })
    git(main, ['init', '-q', '-b', 'main'])
    writeFileSync(join(main, 'README.md'), 'x\n', 'utf8')
    git(main, ['add', '-A'])
    git(main, ['commit', '-q', '-m', 'init'])
    git(main, ['worktree', 'add', '-q', '-b', 'tenon/demo', linked])
    return { main, linked }
  }

  test('repoRoot 是 worktree → 删的是主检出的旧文件与清单项；worktree 自己的同名文件不动', async () => {
    const { main, linked } = repoWithWorktree()
    const rel = legacy('claude', 'a', { base: main })
    put(rel, 'worktree 里的文件\n', linked)
    const result = await cleanupLegacyHostAgents({ repoRoot: linked, renderCurrent })
    expect(result).toEqual({ removed: [rel], preserved: [] })
    expect(has(rel, main)).toBe(false)
    expect(has('.pipeline-owned.json', main)).toBe(false)
    expect(read(rel, linked)).toBe('worktree 里的文件\n')
  })

  test('主检出里被保留的文件也在 worktree 调用的结果里列出', async () => {
    const { main, linked } = repoWithWorktree()
    const rel = legacy('claude', 'a', { base: main, text: '用户改过\n' })
    const result = await cleanupLegacyHostAgents({ repoRoot: linked, renderCurrent })
    expect(result).toEqual({ removed: [], preserved: [rel] })
    expect(read(rel, main)).toBe('用户改过\n')
  })

  test('在主检出里调用 → 仍清理自己', async () => {
    const { main } = repoWithWorktree()
    const rel = legacy('claude', 'a', { base: main })
    expect(await cleanupLegacyHostAgents({ repoRoot: main })).toEqual({ removed: [rel], preserved: [] })
  })

  test('项目根是主检出的子目录（monorepo 里的包）→ 清理的是这个子目录，不是 git 根', async () => {
    const { main } = repoWithWorktree()
    const pkg = join(main, 'packages', 'app')
    mkdirSync(pkg, { recursive: true })
    const rel = legacy('claude', 'a', { base: pkg })
    const rootFile = legacy('claude', 'b', { base: main })
    expect(await cleanupLegacyHostAgents({ repoRoot: pkg })).toEqual({ removed: [rel], preserved: [] })
    expect(has(rel, pkg)).toBe(false)
    expect(has(rootFile, main)).toBe(true)
  })
})
