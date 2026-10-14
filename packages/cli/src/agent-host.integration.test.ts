/**
 * 真实 e2e —— 宿主原生 agent 文件：会话内的命令（init、prompt）不往项目或用户目录写任何宿主文件；
 * prompt 只读判定：用户级文件（`tenon agent install` 写的）与冻结定义一致才下发专属子代理类型，否则退回通用子代理并把
 * 原因记进运行记录；升级前的版本留在项目里的旧文件在 init 与任务完结时清理，卸载只删 Tenon 生成的文件。两种宿主各一遍，
 * 全在临时目录（用户目录根落在每个用例自己的产品 home 之下，不碰真实的 ~/.claude、~/.codex）。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  computeContentHash, effectiveAgent, hostAgentPath, readAgentRuns, renderHostAgent,
  type AgentRunRow, type HostAgentHost,
} from '@tenon/kernel'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { builtinAgentLibrary } from './test-support.js'

const HINT = (host: string): string => `执行 tenon agent install --host ${host} 后开新会话生效`

const WF = `name: hosted
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      executors:
        - agent: builder
      reviewers:
        - agent: code-size
          required: true
          block_at: medium
    guards: []
    transitions:
      - event: build-done
        to: done
  - id: done
    label: 完结
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

interface PromptJson {
  readonly run_id: string
  readonly role: string
  readonly report_path: string
  readonly subagent_type: string | null
  readonly native: boolean
  readonly reason: string | null
  readonly hint: string | null
}

describe('真实 e2e —— 宿主原生 agent 文件', () => {
  let h: Harness
  let runtimeHome: string
  let CLAUDE: Record<string, string>
  let CODEX: Record<string, string>
  let TERMINAL: Record<string, string>
  beforeEach(async () => {
    // 每个用例一个产品 home：用户级安装（<runtimeHome>/home/.claude/agents）互不可见，也不碰真实 $HOME。
    runtimeHome = await mkdtemp(join(tmpdir(), 'tenon-host-agents-'))
    CLAUDE = { TENON_HARNESS_HOST: 'claude-code', TENON_RUNTIME_HOME: runtimeHome }
    CODEX = { TENON_HARNESS_HOST: 'codex', TENON_RUNTIME_HOME: runtimeHome }
    TERMINAL = { TENON_RUNTIME_HOME: runtimeHome }
  })
  afterEach(async () => {
    if (h) await rm(h.cwd, { recursive: true, force: true })
    await rm(runtimeHome, { recursive: true, force: true })
  })

  const exists = (rel: string): boolean => existsSync(join(h.cwd, rel))
  const userHome = (): string => join(runtimeHome, 'home')
  const userFile = (rel: string): string => join(userHome(), rel)
  /** 未设 CLAUDE_CONFIG_DIR / CODEX_HOME 时宿主读的用户级子代理目录（落在用例自己的产品 home 之下）。 */
  const defaultAgentsDir = (host: 'claude' | 'codex'): string => join(userHome(), host === 'claude' ? '.claude' : '.codex', 'agents')
  /** 退回通用子代理时 `agent prompt --json` 给出的安装提示：带上它检查的子代理目录。 */
  const hintFor = (host: 'claude' | 'codex', dir = defaultAgentsDir(host)): string =>
    `${HINT(host)}（目标目录 ${dir}；设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行，例如会话里用 ! 前缀）`
  /** 目录下全部文件的相对路径（含子目录）；目录不存在 = 空。 */
  const filesUnder = async (dir: string): Promise<readonly string[]> =>
    (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
  const installAgents = async (host: 'claude' | 'codex'): Promise<void> => {
    expect(await h.run(['agent', 'install', '--host', host], { env: TERMINAL }), h.err.join('\n')).toBe(0)
  }
  /**
   * 升级前的版本留在项目里的宿主文件：内容默认是当前库的渲染结果（`text` 可改成别的，模拟用户改过），
   * `listed` 决定是否记进所有权清单（清单里记的永远是原渲染结果的摘要）。
   */
  async function legacyFile(host: HostAgentHost, name: string, opts: { text?: string; listed?: boolean } = {}): Promise<string> {
    const definition = effectiveAgent(builtinAgentLibrary(), name)?.definition
    if (definition === undefined) throw new Error(`内建库里没有 ${name}`)
    const rendered = renderHostAgent(host, definition)
    const rel = hostAgentPath(host, name)
    await mkdir(dirname(join(h.cwd, rel)), { recursive: true })
    await writeFile(join(h.cwd, rel), opts.text ?? rendered, 'utf8')
    if (opts.listed !== false) {
      const manifest = join(h.cwd, '.pipeline-owned.json')
      const current = existsSync(manifest) ? JSON.parse(await readFile(manifest, 'utf8')) as Record<string, string> : {}
      await writeFile(manifest, `${JSON.stringify({ ...current, [rel]: computeContentHash(rendered) }, null, 2)}\n`, 'utf8')
    }
    return rel
  }

  async function seed(name = 'demo', env: Record<string, string> = CLAUDE): Promise<void> {
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'hosted.yaml'), WF, 'utf8')
    expect(await h.run(['init', name, '--workflow', 'hosted', '--preset', 'full'], { env }), h.err.join('\n')).toBe(0)
  }

  async function prompt(agent: string, args: string[] = [], env: Record<string, string> = CLAUDE, change = 'demo'): Promise<PromptJson> {
    expect(await h.run(['agent', 'prompt', change, agent, '--json', ...args], { env }), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('')) as PromptJson
  }

  async function finish(started: PromptJson, args: string[] = [], change = 'demo'): Promise<void> {
    const body = started.role === 'executor' ? '{"result":"done","findings":[]}' : '{"findings":[]}'
    await writeFile(join(h.cwd, started.report_path), `# r\n\n\`\`\`tenon-result\n${body}\n\`\`\`\n`, 'utf8')
    expect(await h.run(['agent', 'record', change, started.run_id, ...args]), h.err.join('\n')).toBe(0)
  }

  /** 经读取 API 取运行记录：台账行叠加旁注（subagent.reason 在旁注里，见 kernel state/agent-run-meta.ts）。 */
  const runs = (change = 'demo'): Promise<readonly AgentRunRow[]> => readAgentRuns(join(h.cwd, 'openspec', 'changes', change))

  test('Claude Code 里立项：项目与用户目录里都不生成宿主文件，也不记所有权清单', async () => {
    h = await freshHarness()
    await seed()
    expect(exists('.claude')).toBe(false)
    expect(exists('.codex')).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
    expect(await filesUnder(userHome())).toEqual([])
  })

  test('Codex 里立项同样不生成宿主文件', async () => {
    h = await freshHarness()
    await seed('demo', CODEX)
    expect(exists('.claude')).toBe(false)
    expect(exists('.codex')).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
    expect(await filesUnder(userHome())).toEqual([])
  })

  test('prompt 不写任何宿主文件：未安装 → 通用子代理，JSON 与台账带 reason 与安装提示；装好后新的运行下发专属子代理', async () => {
    h = await freshHarness()
    await seed('demo', TERMINAL)
    expect(exists('.claude')).toBe(false)
    const started = await prompt('builder', ['--host', 'claude'], TERMINAL)
    expect(started).toMatchObject({ subagent_type: 'general-purpose', native: false, reason: 'not-installed', hint: hintFor('claude') })
    // 项目里与用户目录下都没有新文件；用户目录甚至没被创建。
    expect(exists('.claude')).toBe(false)
    expect(await filesUnder(userHome())).toEqual([])
    expect(existsSync(userFile('.claude'))).toBe(false)
    // 续跑同一次运行：沿用台账里记下的子代理与原因（经读取 API 叠加旁注读回）。
    expect(await prompt('builder', ['--host', 'claude'], TERMINAL)).toMatchObject({
      run_id: started.run_id, subagent_type: 'general-purpose', native: false, reason: 'not-installed', hint: hintFor('claude'),
    })
    await finish(started)
    expect(h.out.join('\n')).toContain('subagent=general-purpose')
    expect((await runs()).find((row) => row.agent === 'builder')?.subagent)
      .toEqual({ host: 'claude', type: 'general-purpose', native: false, reason: 'not-installed' })
    // 台账原文保持上一个发行版读得了的形状（行里的 subagent 没有 reason），原因记在旁注里。
    expect(await h.readIn('demo', '.pipeline-agent-runs.jsonl')).not.toContain('reason')
    expect(await h.readIn('demo', '.pipeline-agent-run-meta.jsonl')).toContain('"subagent_reason":"not-installed"')

    await installAgents('claude')
    const installed = await filesUnder(userFile('.claude/agents'))
    expect(installed.map((path) => path.slice(userHome().length + 1))).toContain(join('.claude', 'agents', 'tenon-code-size.md'))
    const reviewer = await prompt('code-size', ['--host', 'claude'], TERMINAL)
    expect(reviewer).toMatchObject({ subagent_type: 'tenon-code-size', native: true, reason: null, hint: null })
    expect(await filesUnder(userFile('.claude/agents'))).toEqual(installed)
    expect(exists('.claude')).toBe(false)
    await finish(reviewer)
    expect((await runs()).find((row) => row.agent === 'code-size')?.subagent)
      .toEqual({ host: 'claude', type: 'tenon-code-size', native: true })
  })

  // 验证步真机验收的缺陷：宿主只读 `$CLAUDE_CONFIG_DIR/agents`，装在 ~/.claude/agents 的文件会话看不到，prompt 却按写死的路径判为已装。
  test('会话的 CLAUDE_CONFIG_DIR 与安装位置不同 → not-installed 且提示给出所检查的目录；在带同样变量的环境里装好后才下发专属子代理', async () => {
    h = await freshHarness()
    await seed()
    // 终端里没有变量：装在默认目录 <home>/.claude/agents。
    await installAgents('claude')
    expect(existsSync(userFile('.claude/agents/tenon-builder.md'))).toBe(true)

    const configDir = join(runtimeHome, 'cc-config')
    const SESSION = { ...CLAUDE, CLAUDE_CONFIG_DIR: configDir }
    const started = await prompt('builder', [], SESSION)
    expect(started).toMatchObject({
      subagent_type: 'general-purpose', native: false, reason: 'not-installed', hint: hintFor('claude', join(configDir, 'agents')),
    })
    expect(existsSync(configDir)).toBe(false)
    await finish(started)

    // 在带同样变量的环境里安装：文件写在 $CLAUDE_CONFIG_DIR/agents，默认目录里的文件不动。
    const defaultBefore = await readFile(userFile('.claude/agents/tenon-builder.md'), 'utf8')
    expect(await h.run(['agent', 'install', '--host', 'claude'], { env: { ...TERMINAL, CLAUDE_CONFIG_DIR: configDir } }), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain(`目标目录：${join(configDir, 'agents')}`)
    expect(existsSync(join(configDir, 'agents', 'tenon-code-size.md'))).toBe(true)
    expect(await readFile(userFile('.claude/agents/tenon-builder.md'), 'utf8')).toBe(defaultBefore)

    expect(await prompt('code-size', [], SESSION)).toMatchObject({ subagent_type: 'tenon-code-size', native: true, reason: null, hint: null })
  })

  test('Codex 会话的 CODEX_HOME：装在该目录下的 agents 才下发专属子代理；默认 ~/.codex/agents 里的不算', async () => {
    h = await freshHarness()
    await seed('demo', CODEX)
    await installAgents('codex')
    expect(existsSync(userFile('.codex/agents/tenon-builder.toml'))).toBe(true)

    const codexHome = join(runtimeHome, 'codex-home')
    const SESSION = { ...CODEX, CODEX_HOME: codexHome }
    const before = await prompt('builder', [], SESSION)
    expect(before).toMatchObject({
      subagent_type: 'default', native: false, reason: 'not-installed', hint: hintFor('codex', join(codexHome, 'agents')),
    })
    await finish(before)

    expect(await h.run(['agent', 'install', '--host', 'codex'], { env: { ...TERMINAL, CODEX_HOME: codexHome } }), h.err.join('\n')).toBe(0)
    expect(existsSync(join(codexHome, 'agents', 'tenon-code-size.toml'))).toBe(true)
    expect(await prompt('code-size', [], SESSION)).toMatchObject({ subagent_type: 'tenon-code-size', native: true, reason: null, hint: null })
  })

  // 补的回归覆盖：definition-mismatch 的判定本来就在 kernel host-subagent-resolve 里，这条从 CLI 真实路径把它钉住。
  test('已装的用户级文件与任务冻结的定义不同（装的是旧版本）→ 通用子代理，reason: definition-mismatch，不改写已装文件', async () => {
    h = await freshHarness()
    await seed()
    await installAgents('claude')
    const definition = effectiveAgent(builtinAgentLibrary(), 'builder')?.definition
    if (definition === undefined) throw new Error('内建库里没有 builder')
    const stale = renderHostAgent('claude', { ...definition, description: '旧版本安装的 builder' })
    await writeFile(userFile('.claude/agents/tenon-builder.md'), stale, 'utf8')

    const started = await prompt('builder')
    expect(started).toMatchObject({ subagent_type: 'general-purpose', native: false, reason: 'definition-mismatch', hint: hintFor('claude') })
    expect(await readFile(userFile('.claude/agents/tenon-builder.md'), 'utf8')).toBe(stale)
    await finish(started)
    expect((await runs()).find((row) => row.agent === 'builder')?.subagent)
      .toEqual({ host: 'claude', type: 'general-purpose', native: false, reason: 'definition-mismatch' })
    // 同一次安装里没被动过的评审者仍是专属子代理。
    expect(await prompt('code-size')).toMatchObject({ subagent_type: 'tenon-code-size', native: true, reason: null, hint: null })
  })

  test('Codex：用户级 ~/.codex/agents/tenon-<name>.toml 装好后才下发专属子代理；退回类型是 default', async () => {
    h = await freshHarness()
    await seed('demo', CODEX)
    const before = await prompt('builder', [], CODEX)
    expect(before).toMatchObject({ subagent_type: 'default', native: false, reason: 'not-installed', hint: hintFor('codex') })
    await finish(before)
    await installAgents('codex')
    const toml = await readFile(userFile('.codex/agents/tenon-code-size.toml'), 'utf8')
    expect(toml).toContain('name = "tenon-code-size"')
    expect(toml).toContain('sandbox_mode = "read-only"')
    expect(toml).not.toContain('model =')
    expect(await prompt('code-size', [], CODEX)).toMatchObject({ subagent_type: 'tenon-code-size', native: true, reason: null, hint: null })
    expect(exists('.codex')).toBe(false)
  })

  test('用户级已装但被项目级内容不同的同名文件遮住 → shadowed；record --subagent 记实际用的，原因只在仍是通用类型时保留', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.claude', 'agents'), { recursive: true })
    await writeFile(join(h.cwd, '.claude', 'agents', 'tenon-builder.md'), '用户自己的\n', 'utf8')
    await seed()
    await installAgents('claude')
    const builder = await prompt('builder')
    expect(builder).toMatchObject({ subagent_type: 'general-purpose', native: false, reason: 'shadowed', hint: hintFor('claude') })
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'tenon-builder.md'), 'utf8')).toBe('用户自己的\n')
    await finish(builder)
    expect((await runs()).find((row) => row.agent === 'builder')?.subagent)
      .toEqual({ host: 'claude', type: 'general-purpose', native: false, reason: 'shadowed' })

    // 专属子代理派发时宿主说找不到，改用通用子代理：prompt 没给原因，登记也不编造。
    const reviewer = await prompt('code-size')
    expect(reviewer).toMatchObject({ subagent_type: 'tenon-code-size', native: true, reason: null, hint: null })
    await finish(reviewer, ['--subagent', 'general-purpose'])
    expect((await runs()).find((row) => row.agent === 'code-size')?.subagent).toEqual({ host: 'claude', type: 'general-purpose', native: false })
  })

  test('record --subagent 改写成专属类型：prompt 给出的原因随之丢掉；改写成别的通用类型：原因保留', async () => {
    h = await freshHarness()
    await seed()
    const first = await prompt('builder')
    expect(first).toMatchObject({ subagent_type: 'general-purpose', reason: 'not-installed' })
    await finish(first, ['--subagent', 'tenon-builder'])
    expect((await runs()).find((row) => row.agent === 'builder')?.subagent).toEqual({ host: 'claude', type: 'tenon-builder', native: true })

    const second = await prompt('code-size')
    expect(second).toMatchObject({ native: false, reason: 'not-installed' })
    await finish(second, ['--subagent', 'my-generic'])
    expect((await runs()).find((row) => row.agent === 'code-size')?.subagent)
      .toEqual({ host: 'claude', type: 'my-generic', native: false, reason: 'not-installed' })
  })

  test('record --subagent none：开始后没有派发的运行如实登记 not-dispatched；原因按旁注存放，台账行形状不变', async () => {
    h = await freshHarness()
    await seed()
    const started = await prompt('builder')
    expect(started).toMatchObject({ subagent_type: 'general-purpose', reason: 'not-installed' })
    // 开始后没有派发子代理：报告自报 failed，登记时写明未派发（而不是留着 prompt 时计划用的通用子代理）。
    await writeFile(join(h.cwd, started.report_path), '# r\n\n```tenon-result\n{"result":"failed","findings":[]}\n```\n', 'utf8')
    expect(await h.run(['agent', 'record', 'demo', started.run_id, '--subagent', 'none']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('subagent=none')
    expect(h.out.join('\n')).not.toContain('(通用)')
    const row = (await runs()).find((item) => item.agent === 'builder')
    expect(row).toMatchObject({ status: 'finished', result: 'failed' })
    expect(row?.subagent).toEqual({ host: 'claude', type: 'none', native: false, reason: 'not-dispatched' })
    expect(await h.readIn('demo', '.pipeline-agent-runs.jsonl')).not.toContain('not-dispatched')
    expect(await h.readIn('demo', '.pipeline-agent-run-meta.jsonl')).toContain('"subagent_reason":"not-dispatched"')
  })

  test('record --subagent none：prompt 时没有宿主（终端）、登记时也没有宿主 → host 记 terminal', async () => {
    h = await freshHarness()
    await seed('demo', TERMINAL)
    const started = await prompt('builder', [], TERMINAL)
    expect(started).toMatchObject({ subagent_type: null })
    await writeFile(join(h.cwd, started.report_path), '# r\n\n```tenon-result\n{"result":"failed","findings":[]}\n```\n', 'utf8')
    expect(await h.run(['agent', 'record', 'demo', started.run_id, '--subagent', 'none'], { env: TERMINAL }), h.err.join('\n')).toBe(0)
    expect((await runs()).find((item) => item.agent === 'builder')?.subagent)
      .toEqual({ host: 'terminal', type: 'none', native: false, reason: 'not-dispatched' })
  })

  test('agent 来自项目层 → project-agent；prompt 不为它写宿主文件', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.tenon', 'agents'), { recursive: true })
    await writeFile(join(h.cwd, '.tenon', 'agents', 'team-lint.md'), [
      '---', 'name: team-lint', 'description: 团队规范检查', 'role: reviewer', 'tools: [Read, Grep]', '---', '', '# team-lint', '',
    ].join('\n'), 'utf8')
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'hosted.yaml'), WF.replace('- agent: code-size', '- agent: team-lint'), 'utf8')
    expect(await h.run(['init', 'demo', '--workflow', 'hosted', '--preset', 'full'], { env: TERMINAL }), h.err.join('\n')).toBe(0)
    await installAgents('claude')
    const builder = await prompt('builder', ['--host', 'claude'], TERMINAL)
    await finish(builder)
    const lint = await prompt('team-lint', ['--host', 'claude'], TERMINAL)
    expect(lint).toMatchObject({ subagent_type: 'general-purpose', native: false, reason: 'project-agent', hint: hintFor('claude') })
    expect(exists('.claude')).toBe(false)
    expect(existsSync(userFile('.claude/agents/tenon-team-lint.md'))).toBe(false)
  })

  test('init 清理升级前留下的项目级文件：清单记着的与内容一致的删除，改过的保留并 WARN，命令照常成功', async () => {
    h = await freshHarness()
    const listed = await legacyFile('claude', 'builder')
    const unlisted = await legacyFile('claude', 'researcher', { listed: false })
    const codex = await legacyFile('codex', 'builder')
    const edited = await legacyFile('claude', 'security', { text: '用户改过\n' })
    await seed('demo', CODEX)
    expect(exists(listed)).toBe(false)
    expect(exists(unlisted)).toBe(false)
    expect(exists(codex)).toBe(false)
    expect(exists(edited)).toBe(true)
    expect(await readFile(join(h.cwd, edited), 'utf8')).toBe('用户改过\n')
    const err = h.err.join('\n')
    expect(err).toContain('已清理旧版本写进项目的宿主 agent 文件')
    expect(err).toMatch(new RegExp(`WARN: .*${edited.replaceAll('.', '\\.')}`, 'u'))
    // 清单只剩改过的那一项；新建的任务没有往项目里加任何宿主文件。
    expect(JSON.parse(await readFile(join(h.cwd, '.pipeline-owned.json'), 'utf8'))).toEqual({ [edited]: expect.any(String) })
    expect(exists('.codex')).toBe(false)
    expect(await filesUnder(userHome())).toEqual([])
  })

  test('完结（transition archived）也清理：不管另一个在途任务是否还引用这些 agent', async () => {
    h = await freshHarness()
    await seed('demo')
    await seed('other')
    const builder = await legacyFile('claude', 'builder')
    const reviewer = await legacyFile('claude', 'code-size')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'build-done'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(exists(builder)).toBe(true)
    expect(await h.run(['transition', 'demo', 'archived'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(h.err.join('\n')).toContain('已清理旧版本写进项目的宿主 agent 文件')
    expect(exists(builder)).toBe(false)
    expect(exists(reviewer)).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
    expect(exists('.claude')).toBe(false)
  })

  test('卸载只删 Tenon 生成且没改过的宿主文件；用户的 agent 与改过的文件保留', async () => {
    h = await freshHarness()
    await seed()
    await legacyFile('claude', 'builder')
    await legacyFile('claude', 'code-size', { text: '改过\n' })
    await writeFile(join(h.cwd, '.claude', 'agents', 'mine.md'), '用户\n', 'utf8')
    expect(await h.run(['uninstall', '--yes']), h.err.join('\n')).toBe(0)
    expect(exists('.claude/agents/tenon-builder.md')).toBe(false)
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'tenon-code-size.md'), 'utf8')).toBe('改过\n')
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'mine.md'), 'utf8')).toBe('用户\n')
  })
})
