/**
 * `tenon agent install | uninstall`：把官方 + 自定义 agent 写到用户级宿主目录（临时 HOME，不碰真实 ~/.claude）。
 * 库只读官方层与自定义层——项目层 agent 不安装、项目层同名覆盖不影响安装结果。
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadAgentLibrary, renderHostAgent, type AgentDefinition } from '@tenon/kernel'
import { buildProgram, CliExit } from '../program.js'
import { makeDeps, type TestDeps } from '../test-support.js'
import { agentInstallHint, cmdAgentInstall, cmdAgentUninstall } from './agent-install.js'
import { cmdAgentAdd, cmdAgentCopy, cmdAgentRm } from './agent-library.js'
import { cmdAgentNew, renderAgentFile } from './agent-new.js'
import type { InitWizardEnv } from './init.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const HINT = '执行 tenon agent install --host'

let sandbox: string
let home: string
let configRoot: string
let project: string
let deps: TestDeps

const noWizard: InitWizardEnv = { isInteractive: () => false, makePrompter: () => ({ ask: async () => '', close: () => {} }) }

function definition(name: string, over: Partial<AgentDefinition> = {}): Omit<AgentDefinition, 'roleInferred'> {
  return {
    name, description: `${name} 说明`, role: 'reviewer', version: '1.0.0', skills: [], tools: ['Read', 'Grep'],
    body: `# ${name}\n\n## 方法\n\n1. 读代码\n`, ...over,
  }
}

function putAgent(dir: string, name: string, over: Partial<AgentDefinition> = {}): string {
  mkdirSync(dir, { recursive: true })
  const text = renderAgentFile(definition(name, over))
  writeFileSync(join(dir, `${name}.md`), text)
  return text
}

const customDir = (): string => join(configRoot, 'agents', 'custom')
const projectDir = (): string => join(project, '.tenon', 'agents')
const claudeAgent = (name: string): string => join(home, '.claude', 'agents', `tenon-${name}.md`)

/** 官方层 + 自定义层（不带项目根）里 name 对应的期望宿主文件内容。 */
async function expectedClaude(name: string): Promise<string> {
  const library = await loadAgentLibrary({ payloadRoot: REPO_ROOT, configRoot })
  const entry = library.entries.find((candidate) => candidate.name === name && candidate.definition !== undefined)
  if (entry?.definition === undefined) throw new Error(`库里没有 ${name}`)
  return renderHostAgent('claude', entry.definition)
}

const out = (): string => deps.outLines.join('\n')
const err = (): string => deps.errLines.join('\n')

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenon-agent-install-'))
  home = join(sandbox, 'home')
  configRoot = join(sandbox, 'config')
  project = join(sandbox, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  deps = makeDeps({ cwd: project })
  deps.agentPaths = () => ({ payloadRoot: REPO_ROOT, configRoot, homeDir: home })
  // 与生产装配一致：deps.agentLibrary 带当前项目根。安装不得经它取库。
  deps.agentLibrary = () => loadAgentLibrary({ payloadRoot: REPO_ROOT, configRoot, projectRoot: project })
  deps.knownSkillIds = () => new Set(['security-review', 'test-driven-development'])
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('cmdAgentInstall', () => {
  test('官方与自定义 agent 写到用户级目录，项目层 agent 不安装；逐文件一行并提示开新会话生效', async () => {
    putAgent(customDir(), 'my-reviewer')
    putAgent(projectDir(), 'team-lint')

    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)

    expect(readFileSync(claudeAgent('researcher'), 'utf8')).toBe(await expectedClaude('researcher'))
    expect(readFileSync(claudeAgent('my-reviewer'), 'utf8')).toBe(await expectedClaude('my-reviewer'))
    expect(existsSync(claudeAgent('team-lint'))).toBe(false)
    expect(existsSync(join(project, '.claude'))).toBe(false)
    expect(out()).toContain(claudeAgent('researcher'))
    expect(out()).toContain(claudeAgent('my-reviewer'))
    expect(out()).not.toContain('team-lint')
    expect(out()).toContain('开新会话后生效')
  })

  test('重复安装全是 unchanged，不改写文件', async () => {
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    deps.outLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(out()).toContain('未变化')
    expect(out()).not.toContain('已写入')
  })

  test('定义声明 hosts: [codex] 的 agent 在 --host claude 下不装、在 --host codex 下写 .toml', async () => {
    putAgent(customDir(), 'codex-only', { hosts: ['codex'] })

    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(claudeAgent('codex-only'))).toBe(false)

    expect(await cmdAgentInstall(deps, { host: 'codex' })).toBe(0)
    expect(existsSync(join(home, '.codex', 'agents', 'tenon-codex-only.toml'))).toBe(true)
    expect(existsSync(join(home, '.codex', 'agents', 'tenon-researcher.toml'))).toBe(true)
  })

  test('用户自有同名文件与被改过的文件不覆盖：exit 仍为 0，输出 WARN', async () => {
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true })
    writeFileSync(claudeAgent('researcher'), '我自己的 researcher\n')
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(readFileSync(claudeAgent('researcher'), 'utf8')).toBe('我自己的 researcher\n')
    expect(err()).toContain('WARN')
    expect(err()).toContain(claudeAgent('researcher'))
    // setup / update 经子进程调用时拿不到子进程的 stderr（成功时被丢弃）：stdout 上的汇总行让用户知道有文件没装
    expect(out()).toContain('1 个文件未改动')

    writeFileSync(claudeAgent('builder'), `${readFileSync(claudeAgent('builder'), 'utf8')}\n用户加的一行\n`)
    deps.errLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(readFileSync(claudeAgent('builder'), 'utf8')).toContain('用户加的一行')
    expect(err()).toContain(claudeAgent('builder'))
  })

  test('--host 不是 claude | codex → exit 1，什么都不写', async () => {
    expect(await cmdAgentInstall(deps, { host: 'gemini' })).toBe(1)
    expect(err()).toContain('--host 只能是 claude | codex')
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  test('缺省宿主：终端 = claude；在 Codex 里执行 = codex', async () => {
    expect(await cmdAgentInstall(deps, {})).toBe(0)
    expect(existsSync(claudeAgent('researcher'))).toBe(true)

    deps.hostKind = () => 'codex'
    expect(await cmdAgentInstall(deps, {})).toBe(0)
    expect(existsSync(join(home, '.codex', 'agents', 'tenon-researcher.toml'))).toBe(true)
  })

  test('目标文件是符号链接 → failed，exit 1，链接目标不被改写', async () => {
    const elsewhere = join(sandbox, 'elsewhere.md')
    writeFileSync(elsewhere, '别处的文件\n')
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true })
    symlinkSync(elsewhere, claudeAgent('researcher'))

    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(1)
    expect(readFileSync(elsewhere, 'utf8')).toBe('别处的文件\n')
    expect(err()).toContain(claudeAgent('researcher'))
    // 其余 agent 照常写入
    expect(existsSync(claudeAgent('builder'))).toBe(true)
  })

  test('没装配 agent 库 → exit 1', async () => {
    delete deps.agentPaths
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(1)
    expect(err()).toContain('agent 库未装配')
  })

  test('库里已删除的自定义 agent：文件没改过就清掉', async () => {
    putAgent(customDir(), 'my-reviewer')
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(claudeAgent('my-reviewer'))).toBe(true)

    rmSync(join(customDir(), 'my-reviewer.md'))
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(claudeAgent('my-reviewer'))).toBe(false)
    expect(out()).toContain('已删除')
  })

  test('库里的自定义 agent 解析失败（没有 definition）：不是「库里已删除」，之前装过未改的文件不被删也不改写', async () => {
    putAgent(customDir(), 'my-reviewer')
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    const installed = readFileSync(claudeAgent('my-reviewer'), 'utf8')

    writeFileSync(join(customDir(), 'my-reviewer.md'), '这不是 frontmatter，解析失败\n')
    deps.outLines.length = 0
    deps.errLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(readFileSync(claudeAgent('my-reviewer'), 'utf8')).toBe(installed)
    expect(out()).not.toContain('已删除')
    // 其余 agent 照常安装、未变化
    expect(out()).toContain(`未变化 ${claudeAgent('researcher')}`)
  })

  test('库整体读不出来（没有一个可用条目）：整个跳过回收，已装文件一个不删，WARN 说明', async () => {
    putAgent(customDir(), 'my-reviewer')
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    // 官方副本与自定义层都不可读，插件根也不存在：库只剩空壳，旧逻辑会把清单里记着的文件全当成「库里已删除」。
    rmSync(join(configRoot, 'agents', 'builtin'), { recursive: true, force: true })
    rmSync(customDir(), { recursive: true, force: true })
    deps.agentPaths = () => ({ payloadRoot: join(sandbox, 'missing-payload'), configRoot, homeDir: home })

    deps.outLines.length = 0
    deps.errLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(claudeAgent('researcher'))).toBe(true)
    expect(existsSync(claudeAgent('my-reviewer'))).toBe(true)
    expect(out()).not.toContain('已删除')
    expect(err()).toMatch(/WARN: .*没有.*可用.*跳过.*回收/u)
  })

  test('当前项目 .tenon/agents 有与官方 researcher 同名的覆盖：仍按官方定义安装，之前装过的文件不被删', async () => {
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    const installed = readFileSync(claudeAgent('researcher'), 'utf8')
    putAgent(projectDir(), 'researcher', { description: '项目里的覆盖版' })

    deps.outLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(readFileSync(claudeAgent('researcher'), 'utf8')).toBe(installed)
    expect(installed).toBe(await expectedClaude('researcher'))
    expect(out()).not.toContain('已删除')
    expect(err()).not.toContain('WARN')
  })

  test('自定义 agent 被项目层同名遮住时，用户级安装仍装自定义版本且不删之前装过的文件', async () => {
    putAgent(customDir(), 'my-reviewer', { description: '用户级版本' })
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    const installed = readFileSync(claudeAgent('my-reviewer'), 'utf8')
    expect(installed).toContain('用户级版本')

    putAgent(projectDir(), 'my-reviewer', { description: '项目级版本' })
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(readFileSync(claudeAgent('my-reviewer'), 'utf8')).toBe(installed)
    expect(out()).not.toContain('已删除')
  })

  test('用户级清单损坏：已有文件一律不动，只补写不存在的文件，WARN 说明清单损坏，exit 0', async () => {
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    rmSync(claudeAgent('builder'))
    writeFileSync(join(configRoot, 'agents', 'host-owned.json'), '{ 坏了')
    const before = readFileSync(claudeAgent('researcher'), 'utf8')

    deps.errLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(readFileSync(claudeAgent('researcher'), 'utf8')).toBe(before)
    expect(existsSync(claudeAgent('builder'))).toBe(true)
    expect(err()).toContain('清单损坏')
  })
})

describe('cmdAgentUninstall', () => {
  test('删除 Tenon 写入且未改动的文件，改过的保留并 WARN；清单之外的用户文件不碰', async () => {
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    writeFileSync(claudeAgent('builder'), `${readFileSync(claudeAgent('builder'), 'utf8')}\n改过\n`)
    writeFileSync(join(home, '.claude', 'agents', 'mine.md'), '用户自己的\n')

    deps.outLines.length = 0
    deps.errLines.length = 0
    expect(await cmdAgentUninstall(deps, { host: 'claude' })).toBe(0)

    expect(existsSync(claudeAgent('researcher'))).toBe(false)
    expect(readFileSync(claudeAgent('builder'), 'utf8')).toContain('改过')
    expect(readdirSync(join(home, '.claude', 'agents')).sort()).toEqual(['mine.md', 'tenon-builder.md'])
    expect(out()).toContain(`已删除 ${claudeAgent('researcher')}`)
    expect(err()).toContain('WARN')
    expect(err()).toContain(claudeAgent('builder'))
    expect(err()).toContain('文件被改过，保留')
  })

  test('没装过：说明没有可卸载的文件，exit 0', async () => {
    expect(await cmdAgentUninstall(deps, { host: 'claude' })).toBe(0)
    expect(out()).toContain('没有')
  })

  test('清单损坏：无法确认归属 → exit 1，一个文件都不删', async () => {
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    writeFileSync(join(configRoot, 'agents', 'host-owned.json'), '{ 坏了')

    deps.errLines.length = 0
    expect(await cmdAgentUninstall(deps, { host: 'claude' })).toBe(1)
    expect(existsSync(claudeAgent('researcher'))).toBe(true)
    expect(err()).toContain('host-owned.json')
    expect(err()).toContain('清单损坏')
  })

  test('--host 非法 → exit 1', async () => {
    expect(await cmdAgentUninstall(deps, { host: 'gemini' })).toBe(1)
    expect(err()).toContain('--host 只能是 claude | codex')
  })
})

describe('子代理目录跟随 CLAUDE_CONFIG_DIR / CODEX_HOME（环境只经 agentPaths().hostEnv 注入）', () => {
  let configDir: string
  const inConfig = (name: string): string => join(configDir, 'agents', `tenon-${name}.md`)
  const withHostEnv = (hostEnv: Record<string, string | undefined>): void => {
    deps.agentPaths = () => ({ payloadRoot: REPO_ROOT, configRoot, homeDir: home, hostEnv })
  }

  beforeEach(() => {
    configDir = join(sandbox, 'cc-config')
  })

  test('hostEnv 带 CLAUDE_CONFIG_DIR → 文件写在 C/agents，输出首行给出目标目录，H/.claude 下没有文件', async () => {
    withHostEnv({ CLAUDE_CONFIG_DIR: configDir })

    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)

    expect(readFileSync(inConfig('researcher'), 'utf8')).toBe(await expectedClaude('researcher'))
    expect(deps.outLines[0]).toBe(`目标目录：${join(configDir, 'agents')}`)
    expect(out()).toContain(inConfig('researcher'))
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  test('hostEnv 带 CODEX_HOME → codex 写在 X/agents；CLAUDE_CONFIG_DIR 不影响 codex', async () => {
    const codexHome = join(sandbox, 'codex-home')
    withHostEnv({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir })

    expect(await cmdAgentInstall(deps, { host: 'codex' })).toBe(0)

    expect(existsSync(join(codexHome, 'agents', 'tenon-researcher.toml'))).toBe(true)
    expect(deps.outLines[0]).toBe(`目标目录：${join(codexHome, 'agents')}`)
    expect(existsSync(join(configDir, 'agents'))).toBe(false)
    expect(existsSync(join(home, '.codex'))).toBe(false)
  })

  test('hostEnv 的变量是相对路径或空白 → 不采用，写回 ~/.claude/agents', async () => {
    withHostEnv({ CLAUDE_CONFIG_DIR: 'cc-config' })
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(claudeAgent('researcher'))).toBe(true)
    expect(deps.outLines[0]).toBe(`目标目录：${join(home, '.claude', 'agents')}`)

    withHostEnv({ CLAUDE_CONFIG_DIR: '   ' })
    deps.outLines.length = 0
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(deps.outLines[0]).toBe(`目标目录：${join(home, '.claude', 'agents')}`)
  })

  test('不传 hostEnv → 写在 H/.claude/agents；测试进程的 process.env.CLAUDE_CONFIG_DIR 即使被设成别处也不读（Review Focus 14）', async () => {
    const processEnvDir = join(sandbox, 'process-env-config')
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = processEnvDir
    try {
      expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
      expect(await cmdAgentUninstall(deps, { host: 'claude' })).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
    expect(existsSync(processEnvDir)).toBe(false)
    expect(deps.outLines[0]).toBe(`目标目录：${join(home, '.claude', 'agents')}`)
  })

  test('先后在两个目录安装：在 C 上卸载只删 C/agents 里的文件，H/.claude/agents 里的原样保留', async () => {
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    const researcherBefore = readFileSync(claudeAgent('researcher'), 'utf8')
    withHostEnv({ CLAUDE_CONFIG_DIR: configDir })
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(inConfig('researcher'))).toBe(true)

    deps.outLines.length = 0
    expect(await cmdAgentUninstall(deps, { host: 'claude' })).toBe(0)

    expect(deps.outLines[0]).toBe(`目标目录：${join(configDir, 'agents')}`)
    expect(existsSync(inConfig('researcher'))).toBe(false)
    expect(readFileSync(claudeAgent('researcher'), 'utf8')).toBe(researcherBefore)
    expect(existsSync(claudeAgent('builder'))).toBe(true)

    // 再回到默认目录卸载：它自己那一组还在，照常删掉。
    deps.agentPaths = () => ({ payloadRoot: REPO_ROOT, configRoot, homeDir: home })
    expect(await cmdAgentUninstall(deps, { host: 'claude' })).toBe(0)
    expect(existsSync(claudeAgent('researcher'))).toBe(false)
  })

  test('没装配 agent 库时不打印目标目录', async () => {
    delete deps.agentPaths
    expect(await cmdAgentInstall(deps, { host: 'claude' })).toBe(1)
    expect(out()).not.toContain('目标目录')
  })
})

describe('agentInstallHint', () => {
  test('不带目录 → 原文（库命令的提示不变）', () => {
    expect(agentInstallHint('claude')).toBe('执行 tenon agent install --host claude 后开新会话生效')
    expect(agentInstallHint()).toBe('执行 tenon agent install --host <host> 后开新会话生效')
  })

  test('带目录 → 追加目标目录与「在带同样变量的环境里执行」的说明', () => {
    expect(agentInstallHint('claude', '/opt/cc/agents')).toBe(
      '执行 tenon agent install --host claude 后开新会话生效（目标目录 /opt/cc/agents；'
      + '设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行，例如会话里用 ! 前缀）',
    )
  })
})

describe('program 装配：tenon agent install | uninstall --host', () => {
  async function runProgram(args: string[]): Promise<number> {
    try {
      await buildProgram(deps).parseAsync(args, { from: 'user' })
      return 0
    } catch (e) {
      if (e instanceof CliExit) return e.code
      throw e
    }
  }

  test('install --host codex 写 ~/.codex；uninstall --host codex 删掉；--host gemini → exit 1', async () => {
    expect(await runProgram(['agent', 'install', '--host', 'codex'])).toBe(0)
    expect(existsSync(join(home, '.codex', 'agents', 'tenon-researcher.toml'))).toBe(true)

    expect(await runProgram(['agent', 'uninstall', '--host', 'codex'])).toBe(0)
    expect(existsSync(join(home, '.codex', 'agents', 'tenon-researcher.toml'))).toBe(false)

    expect(await runProgram(['agent', 'install', '--host', 'gemini'])).toBe(1)
  })
})

describe('库命令只提示安装，不写宿主文件', () => {
  const noHostFiles = (): void => {
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(existsSync(join(home, '.codex'))).toBe(false)
    expect(existsSync(join(project, '.claude'))).toBe(false)
    expect(existsSync(join(project, '.codex'))).toBe(false)
  }

  test('agent new 成功 → stderr 提示执行 tenon agent install', async () => {
    expect(await cmdAgentNew(deps, 'my-reviewer', { role: 'reviewer', description: '评审' }, noWizard)).toBe(0)
    expect(err()).toContain(`${HINT} <host> 后开新会话生效`)
    noHostFiles()
  })

  test('agent add 成功 → 提示', async () => {
    const file = join(sandbox, 'imported.md')
    writeFileSync(file, renderAgentFile(definition('imported')))
    expect(await cmdAgentAdd(deps, file, {})).toBe(0)
    expect(err()).toContain(HINT)
    noHostFiles()
  })

  test('agent copy 成功 → 提示', async () => {
    expect(await cmdAgentCopy(deps, 'researcher', 'my-researcher', {})).toBe(0)
    expect(err()).toContain(HINT)
    noHostFiles()
  })

  test('agent rm 成功 → 提示；被拦下（官方只读）时不提示', async () => {
    putAgent(customDir(), 'my-reviewer')
    expect(await cmdAgentRm(deps, 'researcher', {})).toBe(2)
    expect(err()).not.toContain(HINT)

    expect(await cmdAgentRm(deps, 'my-reviewer', {})).toBe(0)
    expect(err()).toContain(HINT)
    noHostFiles()
  })

  test('项目层 agent：提示里说明项目层不装宿主文件', async () => {
    expect(await cmdAgentNew(deps, 'team-lint', { role: 'reviewer', description: '评审', scope: 'project' }, noWizard)).toBe(0)
    expect(err()).toContain(HINT)
    expect(err()).toContain('项目层')
    noHostFiles()
  })
})
