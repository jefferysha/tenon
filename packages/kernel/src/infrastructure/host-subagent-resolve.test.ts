import { execFileSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderHostAgent, type HostAgentHost } from '../agents/host-native.js'
import type { AgentDefinition, AgentSource } from '../agents/types.js'
import type { FrozenAgent } from '../state/agent-freeze.js'
import { resolveHostSubagent } from './host-subagent-resolve.js'

const definition = (name: string, description = `${name} 说明`): AgentDefinition => ({
  name, description, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], model: 'sonnet', body: '\n正文\n',
})
const frozen = (name: string, source: AgentSource = 'builtin', description?: string): FrozenAgent => ({
  name, source, digest: `sha256:${'0'.repeat(64)}`, definition: definition(name, description),
})

let root: string
let homeDir: string
let projectRoot: string

const rel = (host: HostAgentHost, name: string): string =>
  host === 'claude' ? join('.claude', 'agents', `tenon-${name}.md`) : join('.codex', 'agents', `tenon-${name}.toml`)
const put = (base: string, host: HostAgentHost, name: string, text: string): string => {
  const path = join(base, rel(host, name))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}
/** 与冻结定义逐字一致的宿主文件内容。 */
const expected = (host: HostAgentHost, agent: FrozenAgent): string => renderHostAgent(host, agent.definition)
/** 未设环境变量时宿主读的用户级子代理目录。 */
const defaultAgentsDir = (host: HostAgentHost): string => join(homeDir, host === 'claude' ? '.claude' : '.codex', 'agents')
const resolve = (agent: FrozenAgent, host: HostAgentHost = 'claude', base = projectRoot, agentsDir = defaultAgentsDir(host)) =>
  resolveHostSubagent({ agentsDir, projectRoot: base, host, agent })

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

/** 临时主检出（有一个提交）与一个 linked worktree，返回两者的路径。 */
function repoWithWorktree(): { main: string; linked: string } {
  const main = join(root, 'main')
  const linked = join(root, 'wt')
  mkdirSync(main, { recursive: true })
  git(main, ['init', '-q', '-b', 'main'])
  writeFileSync(join(main, 'README.md'), 'x\n', 'utf8')
  git(main, ['add', '-A'])
  git(main, ['commit', '-q', '-m', 'init'])
  git(main, ['worktree', 'add', '-q', '-b', 'tenon/demo', linked])
  return { main, linked }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-host-resolve-'))
  homeDir = join(root, 'home')
  projectRoot = join(root, 'project')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveHostSubagent', () => {
  test('用户级文件与冻结定义逐字一致 → 专属子代理', async () => {
    const agent = frozen('researcher')
    put(homeDir, 'claude', 'researcher', expected('claude', agent))
    expect(await resolve(agent)).toEqual({ type: 'tenon-researcher', native: true })
  })

  test('Codex：读 ~/.codex/agents/tenon-<name>.toml；退回类型是 default', async () => {
    const agent = frozen('researcher')
    expect(await resolve(agent, 'codex')).toEqual({ type: 'default', native: false, reason: 'not-installed' })
    put(homeDir, 'codex', 'researcher', expected('codex', agent))
    expect(await resolve(agent, 'codex')).toEqual({ type: 'tenon-researcher', native: true })
  })

  test('用户目录不存在（首次安装前）→ not-installed，不抛错、不创建任何目录', async () => {
    const missingHome = join(root, 'no-such-home')
    const out = await resolveHostSubagent({
      agentsDir: join(missingHome, '.claude', 'agents'), projectRoot, host: 'claude', agent: frozen('researcher'),
    })
    expect(out).toEqual({ type: 'general-purpose', native: false, reason: 'not-installed' })
    expect(existsSync(missingHome)).toBe(false)
    expect(await resolve(frozen('researcher'))).toMatchObject({ reason: 'not-installed' })
    expect(readdirSync(homeDir)).toEqual([])
    expect(readdirSync(projectRoot)).toEqual([])
  })

  test('只装在默认目录、判定用的子代理目录是另一个（CLAUDE_CONFIG_DIR 指向的）→ not-installed，两个目录都不被写', async () => {
    const agent = frozen('researcher')
    const installed = put(homeDir, 'claude', 'researcher', expected('claude', agent))
    const configDir = join(root, 'cc-config')
    const out = await resolve(agent, 'claude', projectRoot, join(configDir, 'agents'))
    expect(out).toEqual({ type: 'general-purpose', native: false, reason: 'not-installed' })
    expect(existsSync(configDir)).toBe(false)
    expect(readFileSync(installed, 'utf8')).toBe(expected('claude', agent))
  })

  test('装在 CLAUDE_CONFIG_DIR 指向的目录、判定用同一个目录 → 专属子代理（默认目录没有文件也不影响）', async () => {
    const agent = frozen('researcher')
    const agentsDir = join(root, 'cc-config', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'tenon-researcher.md'), expected('claude', agent), 'utf8')
    expect(existsSync(join(homeDir, '.claude'))).toBe(false)
    expect(await resolve(agent, 'claude', projectRoot, agentsDir)).toEqual({ type: 'tenon-researcher', native: true })
  })

  test('用户目录在、agents 目录不在 / 同名文件不在 → not-installed', async () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    expect(await resolve(frozen('researcher'))).toMatchObject({ native: false, reason: 'not-installed' })
    mkdirSync(join(homeDir, '.claude', 'agents'), { recursive: true })
    put(homeDir, 'claude', 'builder', 'x')
    expect(await resolve(frozen('researcher'))).toMatchObject({ native: false, reason: 'not-installed' })
    expect(readdirSync(join(homeDir, '.claude', 'agents'))).toEqual(['tenon-builder.md'])
  })

  test('已装内容与冻结定义不同（冻结的是旧版本）→ definition-mismatch，已装文件不被改动', async () => {
    const path = put(homeDir, 'claude', 'researcher', expected('claude', frozen('researcher', 'builtin', '新版说明')))
    const before = readFileSync(path, 'utf8')
    expect(await resolve(frozen('researcher', 'builtin', '旧版说明'))).toEqual({
      type: 'general-purpose', native: false, reason: 'definition-mismatch',
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('已装文件不是普通文件（同名目录）→ definition-mismatch，不抛错', async () => {
    mkdirSync(join(homeDir, '.claude', 'agents', 'tenon-researcher.md'), { recursive: true })
    expect(await resolve(frozen('researcher'))).toMatchObject({ native: false, reason: 'definition-mismatch' })
  })

  test('~/.claude 是符号链接（dotfiles 管理器）→ 照常读到安装的文件', async () => {
    const dotfiles = join(root, 'dotfiles-claude')
    const agent = frozen('researcher')
    mkdirSync(join(dotfiles, 'agents'), { recursive: true })
    writeFileSync(join(dotfiles, 'agents', 'tenon-researcher.md'), expected('claude', agent), 'utf8')
    symlinkSync(dotfiles, join(homeDir, '.claude'))
    expect(await resolve(agent)).toEqual({ type: 'tenon-researcher', native: true })
  })

  test('目标文件本身是符号链接：只读比较内容，链接与目标都不被改动', async () => {
    const agent = frozen('researcher')
    const real = join(root, 'real-copy.md')
    writeFileSync(real, expected('claude', agent), 'utf8')
    mkdirSync(join(homeDir, '.claude', 'agents'), { recursive: true })
    const link = join(homeDir, '.claude', 'agents', 'tenon-researcher.md')
    symlinkSync(real, link)
    expect(await resolve(agent)).toEqual({ type: 'tenon-researcher', native: true })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe(expected('claude', agent))
    // 链接指向别的内容 → 不一致，同样不写任何东西。
    writeFileSync(real, '别的内容\n', 'utf8')
    expect(await resolve(agent)).toMatchObject({ native: false, reason: 'definition-mismatch' })
    expect(readFileSync(real, 'utf8')).toBe('别的内容\n')
  })

  test('项目级同名文件内容不同 → shadowed（项目级优先级高于用户级）', async () => {
    const agent = frozen('builder')
    put(homeDir, 'claude', 'builder', expected('claude', agent))
    const shadow = put(projectRoot, 'claude', 'builder', '用户改过的旧文件\n')
    expect(await resolve(agent)).toEqual({ type: 'general-purpose', native: false, reason: 'shadowed' })
    expect(readFileSync(shadow, 'utf8')).toBe('用户改过的旧文件\n')
  })

  test('项目级同名文件内容相同 → 仍是专属子代理', async () => {
    const agent = frozen('builder')
    put(homeDir, 'claude', 'builder', expected('claude', agent))
    put(projectRoot, 'claude', 'builder', expected('claude', agent))
    expect(await resolve(agent)).toEqual({ type: 'tenon-builder', native: true })
  })

  test('项目级同名文件不是普通文件 → shadowed（无法确认一致就不下发专属类型）', async () => {
    const agent = frozen('builder')
    put(homeDir, 'claude', 'builder', expected('claude', agent))
    mkdirSync(join(projectRoot, rel('claude', 'builder')), { recursive: true })
    expect(await resolve(agent)).toMatchObject({ native: false, reason: 'shadowed' })
  })

  test('用户级没装时，项目级一致的文件不算数 → not-installed', async () => {
    const agent = frozen('builder')
    put(projectRoot, 'claude', 'builder', expected('claude', agent))
    expect(await resolve(agent)).toMatchObject({ native: false, reason: 'not-installed' })
  })

  test('Codex 的项目级遮挡看 .codex/agents，不看 .claude/agents', async () => {
    const agent = frozen('builder')
    put(homeDir, 'codex', 'builder', expected('codex', agent))
    put(projectRoot, 'claude', 'builder', '只影响 Claude\n')
    expect(await resolve(agent, 'codex')).toEqual({ type: 'tenon-builder', native: true })
    put(projectRoot, 'codex', 'builder', '改过\n')
    expect(await resolve(agent, 'codex')).toMatchObject({ native: false, reason: 'shadowed' })
  })

  test('agent 来自项目层 → project-agent，不读任何宿主文件（即使用户级有同名一致文件）', async () => {
    const agent = frozen('team-lint', 'project')
    put(homeDir, 'claude', 'team-lint', expected('claude', agent))
    expect(await resolve(agent)).toEqual({ type: 'general-purpose', native: false, reason: 'project-agent' })
    expect(await resolve(agent, 'codex')).toEqual({ type: 'default', native: false, reason: 'project-agent' })
  })

  test('agent 名不合法（含路径片段）→ not-installed，不读 agents 目录之外的文件', async () => {
    writeFileSync(join(root, 'outside.md'), 'x', 'utf8')
    for (const name of ['../../outside', 'a/b', '']) {
      expect(await resolve(frozen(name)), name).toMatchObject({ native: false, reason: 'not-installed' })
    }
  })

  test('项目根不存在 / 不是 git 仓库 → 只看用户级，不抛错', async () => {
    const agent = frozen('researcher')
    put(homeDir, 'claude', 'researcher', expected('claude', agent))
    expect(await resolve(agent, 'claude', join(root, 'gone'))).toEqual({ type: 'tenon-researcher', native: true })
    expect(await resolve(agent, 'claude', projectRoot)).toEqual({ type: 'tenon-researcher', native: true })
  })

  describe('linked worktree', () => {
    test('内容不同的同名旧文件只在主检出里 → shadowed（从主检出启动的会话会加载它）', async () => {
      const { main, linked } = repoWithWorktree()
      const agent = frozen('builder')
      put(homeDir, 'claude', 'builder', expected('claude', agent))
      const old = put(main, 'claude', 'builder', '用户改过而被保留的旧文件\n')
      expect(existsSync(join(linked, rel('claude', 'builder')))).toBe(false)
      expect(await resolve(agent, 'claude', linked)).toEqual({ type: 'general-purpose', native: false, reason: 'shadowed' })
      expect(readFileSync(old, 'utf8')).toBe('用户改过而被保留的旧文件\n')
    })

    test('主检出里的同名文件与冻结定义一致 → 专属子代理；主检出没有文件 → 专属子代理', async () => {
      const { main, linked } = repoWithWorktree()
      const agent = frozen('builder')
      put(homeDir, 'claude', 'builder', expected('claude', agent))
      expect(await resolve(agent, 'claude', linked)).toEqual({ type: 'tenon-builder', native: true })
      put(main, 'claude', 'builder', expected('claude', agent))
      expect(await resolve(agent, 'claude', linked)).toEqual({ type: 'tenon-builder', native: true })
    })

    test('当前根自己的不同文件同样遮挡；在主检出里判定也看自己', async () => {
      const { main, linked } = repoWithWorktree()
      const agent = frozen('builder')
      put(homeDir, 'claude', 'builder', expected('claude', agent))
      put(linked, 'claude', 'builder', '链接 worktree 里的旧文件\n')
      expect(await resolve(agent, 'claude', linked)).toMatchObject({ reason: 'shadowed' })
      rmSync(join(linked, '.claude'), { recursive: true })
      put(main, 'claude', 'builder', '主检出里的旧文件\n')
      expect(await resolve(agent, 'claude', main)).toMatchObject({ reason: 'shadowed' })
    })

    test('用户级没装 → 仍是 not-installed（先于遮挡判定）', async () => {
      const { main, linked } = repoWithWorktree()
      put(main, 'claude', 'builder', '旧文件\n')
      expect(await resolve(frozen('builder'), 'claude', linked)).toMatchObject({ reason: 'not-installed' })
    })
  })
})
