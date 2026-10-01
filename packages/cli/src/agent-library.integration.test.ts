/**
 * 真实 e2e —— `tenon agent` 库命令：真 harness + 临时项目 + 临时产品 home（官方 agent 从仓库 payload 同步）。
 * 覆盖 list / show / new / add / validate / copy / rm / export 的成功与拒绝分支。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

interface ListJson {
  readonly agents: readonly {
    readonly name: string
    readonly source: string
    readonly role: string | null
    readonly version: string | null
    readonly shadowed_by: string | null
    readonly error: string | null
  }[]
}

const REVIEW_WF = `name: reviewed
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: sql-review
          required: true
          block_at: medium
    guards: []
    transitions: []
`

describe('真实 e2e —— tenon agent 库命令', () => {
  let h: Harness
  let home: string
  let env: Record<string, string>

  beforeEach(async () => {
    h = await freshHarness()
    home = await mkdtemp(join(tmpdir(), 'tenon-agent-home-'))
    env = { TENON_RUNTIME_HOME: home }
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  const run = (args: string[]): Promise<number> => h.run(args, { env })
  const customPath = (name: string): string => join(home, 'config', 'agents', 'custom', `${name}.md`)

  async function list(args: string[] = []): Promise<ListJson> {
    expect(await run(['agent', 'list', '--json', ...args]), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('')) as ListJson
  }

  test('list：官方 10 个带身份与版本；--role / --source 过滤；非法取值 exit 1', async () => {
    const all = await list()
    expect(all.agents).toHaveLength(10)
    // security 因按风险挂载（attach_on）升到 1.1.0，其余仍是 1.0.0。
    expect(all.agents.every((agent) => agent.source === 'builtin'
      && agent.version === (agent.name === 'security' ? '1.1.0' : '1.0.0'))).toBe(true)
    expect((await list(['--role', 'executor'])).agents.map((agent) => agent.name)).toEqual(['builder', 'researcher'])
    expect((await list(['--source', 'custom'])).agents).toEqual([])
    expect(await run(['agent', 'list', '--role', 'boss'])).toBe(1)
    expect(await run(['agent', 'list', '--source', 'nope'])).toBe(1)
    expect(await run(['agent', 'list'])).toBe(0)
    expect(h.out.join('\n')).toMatch(/^builder\s+执行者\s+官方\s+1\.0\.0/mu)
  })

  test('new：全参数非交互生成自定义评审者，列表立即出现、来源为自定义', async () => {
    expect(await run([
      'agent', 'new', 'sql-review', '--role', 'reviewer', '--description', 'SQL 评审：注入与索引',
      '--skills', 'security-review', '--model', 'sonnet',
    ]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('已创建 sql-review（自定义 · 评审者）')
    const text = await readFile(customPath('sql-review'), 'utf8')
    expect(text).toContain('role: reviewer')
    expect(text).toContain('tools: [Read, Grep, Glob, Bash, Skill]')
    expect(text).toContain('```tenon-result')
    const row = (await list(['--source', 'custom'])).agents[0]
    expect(row).toMatchObject({ name: 'sql-review', source: 'custom', role: 'reviewer', version: '0.1.0' })
    // 骨架里的占位符没补全就不能过 validate（产品评估 P2）；补全后通过。
    expect(await run(['agent', 'validate', 'sql-review'])).toBe(1)
    expect(h.out.join('\n')).toContain('骨架占位符 <第一步>')
    await writeFile(customPath('sql-review'), text
      .replace('<第一步>', '读查询').replace('<第二步>', '对照索引').replace('<这个评审者负责的那一件事>', '查注入与索引')
      .replace('<写报告前必须满足的条件>', '每条发现有位置'), 'utf8')
    expect(await run(['agent', 'validate', 'sql-review']), h.out.join('\n')).toBe(0)
  })

  test('new：非交互缺参数 exit 1 且不落盘；技能不存在 exit 1；与官方同名 exit 1', async () => {
    expect(await run(['agent', 'new', 'x'])).toBe(1)
    expect(h.err.join('\n')).toContain('--role')
    expect(existsSync(customPath('x'))).toBe(false)
    expect(await run(['agent', 'new', 'y', '--role', 'reviewer', '--description', 'd', '--skills', 'no-such-skill'])).toBe(1)
    expect(h.err.join('\n')).toContain("技能 'no-such-skill' 不存在")
    expect(await run(['agent', 'new', 'builder', '--role', 'executor', '--description', 'd'])).toBe(1)
    expect(h.err.join('\n')).toContain('已存在')
  })

  test('new --from 官方 + --scope project：写进项目 .tenon/agents，沿用官方正文', async () => {
    expect(await run(['agent', 'new', 'team-builder', '--from', 'builder', '--scope', 'project']), h.err.join('\n')).toBe(0)
    const text = await readFile(join(h.cwd, '.tenon', 'agents', 'team-builder.md'), 'utf8')
    expect(text).toContain('name: team-builder')
    expect(text).toContain('role: executor')
    expect(text).toContain('TDD')
    expect((await list(['--source', 'project'])).agents.map((agent) => agent.name)).toEqual(['team-builder'])
  })

  test('add：校验通过才登记；--replace 覆盖；坏文件 exit 1', async () => {
    const draft = join(h.cwd, 'draft.md')
    await writeFile(draft, [
      '---', 'name: api-review', 'description: API 评审', 'role: reviewer', 'tools: [Read, Grep]', '---', '', '# api-review', '',
    ].join('\n'))
    expect(await run(['agent', 'add', draft]), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('PASS api-review')
    expect(await run(['agent', 'add', draft])).toBe(1)
    expect(h.err.join('\n')).toContain('已存在')
    expect(await run(['agent', 'add', draft, '--replace'])).toBe(0)

    await writeFile(draft, '---\nname: bad\n---\n\n正文\n')
    expect(await run(['agent', 'add', draft])).toBe(1)
    expect(h.out.join('\n')).toContain('[FAIL] description')
  })

  test('validate：文件缺 role 只 WARN；工具名不合法 FAIL；不存在的名字 exit 1', async () => {
    const draft = join(h.cwd, 'old.md')
    await writeFile(draft, '---\nname: old\ndescription: 旧文件\ntools: [Read]\n---\n\n正文\n')
    expect(await run(['agent', 'validate', draft])).toBe(0)
    expect(h.out.join('\n')).toContain('[WARN] 缺 role，按工具推断为 reviewer')
    await writeFile(draft, '---\nname: old\ndescription: 旧文件\nrole: reviewer\ntools: [Reed]\n---\n\n正文\n')
    expect(await run(['agent', 'validate', draft])).toBe(1)
    expect(h.out.join('\n')).toContain("[FAIL] 工具 'Reed' 不是 Claude Code 的工具名")
    expect(await run(['agent', 'validate', 'nobody'])).toBe(1)
  })

  test('copy：官方 → 自定义可以；目标重名 exit 1；show 打印生效文件', async () => {
    expect(await run(['agent', 'copy', 'security', 'my-security']), h.err.join('\n')).toBe(0)
    expect(await readFile(customPath('my-security'), 'utf8')).toContain('name: my-security')
    expect(await run(['agent', 'copy', 'security', 'my-security'])).toBe(1)
    expect(await run(['agent', 'show', 'my-security'])).toBe(0)
    expect(h.out.join('\n')).toContain('# 自定义')
    expect(await run(['agent', 'show', 'my-security', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join(''))).toMatchObject({ name: 'my-security', source: 'custom', role: 'reviewer' })
  })

  test('项目级与自定义同名：项目级生效，自定义列出为被覆盖', async () => {
    expect(await run(['agent', 'copy', 'security', 'dup'])).toBe(0)
    expect(await run(['agent', 'copy', 'security', 'dup', '--scope', 'project'])).toBe(0)
    const rows = (await list()).agents.filter((agent) => agent.name === 'dup')
    expect(rows.map((row) => `${row.source}:${row.shadowed_by ?? ''}`)).toEqual(['custom:project', 'project:'])
    expect(await run(['agent', 'show', 'dup', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('')).source).toBe('project')
  })

  test('rm：官方只读 exit 2；被工作流引用时拒绝并列出 exit 2；否则删除', async () => {
    expect(await run(['agent', 'rm', 'builder'])).toBe(2)
    expect(h.err.join('\n')).toContain('只读')
    expect(await run(['agent', 'new', 'sql-review', '--role', 'reviewer', '--description', 'd'])).toBe(0)
    await mkdir(join(home, 'config', 'workflows', '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(home, 'config', 'workflows', '.pipeline', 'workflows', 'reviewed.yaml'), REVIEW_WF)
    expect(await run(['agent', 'rm', 'sql-review'])).toBe(2)
    expect(h.err.join('\n')).toContain('reviewed / 实现 · 评审者')
    await rm(join(home, 'config', 'workflows'), { recursive: true, force: true })
    expect(await run(['agent', 'rm', 'sql-review']), h.err.join('\n')).toBe(0)
    expect(existsSync(customPath('sql-review'))).toBe(false)
    expect(await run(['agent', 'rm', 'sql-review'])).toBe(1)
  })

  test('export：两种宿主文件；非法宿主 exit 1', async () => {
    expect(await run(['agent', 'export', 'code-size', '--host', 'claude'])).toBe(0)
    expect(h.out.join('\n')).toContain('name: tenon-code-size')
    expect(h.out.join('\n')).toContain('tools: Read, Grep, Glob')
    expect(await run(['agent', 'export', 'code-size', '--host', 'codex'])).toBe(0)
    expect(h.out.join('\n')).toContain('name = "tenon-code-size"')
    expect(h.out.join('\n')).toContain('sandbox_mode = "read-only"')
    expect(await run(['agent', 'export', 'code-size', '--host', 'gemini'])).toBe(1)
  })
})
