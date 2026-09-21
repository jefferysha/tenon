import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from './loadWorkflow.js'
import { globalWorkflowRoot, workflowsDirUnder } from './global-store.js'
import { projectWorkflowNames } from './branch-track-lookup.js'
import { parseWorkflow } from './parse.js'
import { selectTrackBranch } from './validate.js'

describe('loadWorkflow', () => {
  it('simple 是不可被项目文件覆盖的内建轻量 workflow，含两个终态与 scope-expanded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-simple-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'simple.yaml'), 'name: poisoned\nsteps:\n', 'utf8')
    const wf = loadWorkflow(root, 'simple')
    expect(wf?.name).toBe('simple')
    expect(wf?.steps.map((step) => step.id)).toEqual(['change', 'verify', 'done', 'escalated'])
    expect(wf?.steps[0]?.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'change-complete', to: 'verify' }),
      expect.objectContaining({ event: 'scope-expanded', to: 'escalated' }),
    ]))
    expect(wf?.openspecContract).toBeUndefined()
  })

  it('内建 simple workflow 与发行模板逐字段一致，避免 setup 产物漂移', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = dirname(dirname(dirname(dirname(__dirname))))
    const template = parseWorkflow(await readFile(join(repoRoot, 'templates', 'workflows', 'simple.yaml'), 'utf8'))
    expect(loadWorkflow(repoRoot, 'simple')).toStrictEqual(template)
  })
  it('存在的 workflow 文件 → 解析返回 WorkflowDef', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'custom.yaml'), 'name: custom\nsteps:\n', 'utf8')
    const wf = loadWorkflow(root, 'custom')
    expect(wf?.name).toBe('custom')
  })

  it('不存在的 workflow → null，不抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-empty-'))
    expect(loadWorkflow(root, 'does-not-exist')).toBeNull()
  })

  it('GOAL E5：非法 workflow（skill 依赖成环）→ 保存时校验的第二消费点，loadWorkflow fail-loud 抛错而非静默返回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-invalid-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(
      join(root, '.pipeline', 'workflows', 'cyclic.yaml'),
      `name: cyclic
steps:
  - id: s1
    label: x
    gate: null
    skills:
      - id: a
        depends_on: [b]
      - id: b
        depends_on: [a]
    inputs: []
    outputs: []
    guards: []
    transitions: []
`,
      'utf8',
    )
    expect(() => loadWorkflow(root, 'cyclic')).toThrow(/循环依赖/)
  })

  it('GOAL E5：非法 workflow（transitions.to 指向不存在的 step）→ loadWorkflow 抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-invalid2-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(
      join(root, '.pipeline', 'workflows', 'dangling.yaml'),
      `name: dangling
steps:
  - id: s1
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: does-not-exist
`,
      'utf8',
    )
    expect(() => loadWorkflow(root, 'dangling')).toThrow(/does-not-exist/)
  })

  it('真实 templates/workflows/default.yaml：parseWorkflow 语法层解析成功，7 个步骤，含 tasks-at-least guard', async () => {
    // Find the repo root and read the real default.yaml template file
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = dirname(dirname(dirname(dirname(__dirname))))
    const defaultYamlPath = join(repoRoot, 'templates', 'workflows', 'default.yaml')
    const content = await readFile(defaultYamlPath, 'utf8')

    // 语法层（parseWorkflow）smoke：真文件 → 7 步、step 序、spec 的 tasks-at-least guard。
    // 注意 loadWorkflow（custom 契约）会因 A 契约拒绝它（下一用例）——parse 层不受 A 契约约束。
    // default 只有分支：取 frontend 分支看 7 步骨架。
    const wf = selectTrackBranch(parseWorkflow(content), 'frontend')
    expect(wf.name).toBe('default')
    expect(wf.steps).toHaveLength(7)
    expect(wf.steps.map((s) => s.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    const specStep = wf.steps.find((s) => s.id === 'spec')
    expect(specStep?.guards).toHaveLength(1)
    expect(specStep?.guards[0]).toEqual({ type: 'tasks-at-least', n: 3 })
  })

  it('default 项目覆盖：`.pipeline/workflows/default.yaml` 按 default 契约加载（effective-phase-skills 合法），并可改技能', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = dirname(dirname(dirname(dirname(__dirname))))
    const content = await readFile(join(repoRoot, 'templates', 'workflows', 'default.yaml'), 'utf8')
    // 第一处 openspec-propose 在 chat 分支（十空格缩进）。
    const edited = content.replace('          - id: openspec-propose\n', '          - id: openspec-propose\n          - id: brainstorming\n')

    const tempRoot = await mkdtemp(join(tmpdir(), 'wf-load-real-'))
    await mkdir(join(tempRoot, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(tempRoot, '.pipeline', 'workflows', 'default.yaml'), edited, 'utf8')

    const wf = loadWorkflow(tempRoot, 'default')
    expect(wf?.tracks?.chat?.steps[0]?.skills.map((skill) => skill.id)).toEqual(['openspec-propose', 'brainstorming'])
    expect(wf?.tracks?.backend?.steps[0]?.skills.map((skill) => skill.id)).toEqual(['openspec-propose'])
  })

  it('default 项目覆盖破坏七阶段契约（删掉 archive）→ fail-loud', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = dirname(dirname(dirname(dirname(__dirname))))
    const content = await readFile(join(repoRoot, 'templates', 'workflows', 'default.yaml'), 'utf8')
    const broken = content.slice(0, content.indexOf('  - id: archive'))
      .replace('      - event: ship-complete\n        to: archive\n', '')

    const tempRoot = await mkdtemp(join(tmpdir(), 'wf-load-broken-default-'))
    await mkdir(join(tempRoot, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(tempRoot, '.pipeline', 'workflows', 'default.yaml'), broken, 'utf8')

    expect(() => loadWorkflow(tempRoot, 'default')).toThrow(/openspec_contract|7 个标准阶段|archive/)
  })

  it('custom 槽里的 effective-phase-skills artifact 仍被 custom 契约拒绝', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = dirname(dirname(dirname(dirname(__dirname))))
    const content = await readFile(join(repoRoot, 'templates', 'workflows', 'default.yaml'), 'utf8')
    const tempRoot = await mkdtemp(join(tmpdir(), 'wf-load-custom-slot-'))
    await mkdir(join(tempRoot, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(tempRoot, '.pipeline', 'workflows', 'copy.yaml'), content.replace('name: default', 'name: copy'), 'utf8')

    expect(() => loadWorkflow(tempRoot, 'copy')).toThrow(/effective-phase-skills/)
  })

  it('G2 P2：非法新 guard（scalar guard 挂列表字段 scope）→ 加载入口经 validate→compile 深校验 fail-loud', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-badguard-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(
      join(root, '.pipeline', 'workflows', 'badguard.yaml'),
      `name: badguard
steps:
  - id: s1
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: field-nonempty
        field: scope
    transitions: []
`,
      'utf8',
    )
    expect(() => loadWorkflow(root, 'badguard')).toThrow(/列表字段/)
  })
})

describe('loadWorkflow · 全局存储', () => {
  const savedRoots = process.env.TENON_RUNTIME_ROOTS
  afterEach(() => {
    vi.unstubAllEnvs()
    if (savedRoots === undefined) delete process.env.TENON_RUNTIME_ROOTS
    else process.env.TENON_RUNTIME_ROOTS = savedRoots
  })

  async function isolatedHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'wf-global-home-'))
    vi.stubEnv('TENON_RUNTIME_HOME', home)
    // 空串也会被当作 JSON 解析；隔离测试要的是「没有 ROOTS 契约」。
    delete process.env.TENON_RUNTIME_ROOTS
    return home
  }

  it('项目无文件时读全局文件；两者都有时项目文件优先（遗留兜底）', async () => {
    await isolatedHome()
    const globalDir = workflowsDirUnder(globalWorkflowRoot())
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'shared.yaml'), 'name: shared\nsteps:\n', 'utf8')
    const root = await mkdtemp(join(tmpdir(), 'wf-global-root-'))
    expect(loadWorkflow(root, 'shared')?.name).toBe('shared')
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'shared.yaml'), 'name: shared\nsteps:\n  - id: only\n    label: Only\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n', 'utf8')
    expect(loadWorkflow(root, 'shared')?.steps.map((step) => step.id)).toEqual(['only'])
  })

  it('projectWorkflowNames 合并项目目录与全局目录，模板名恒在且去重', async () => {
    await isolatedHome()
    const globalDir = workflowsDirUnder(globalWorkflowRoot())
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'g1.yaml'), 'name: g1\nsteps:\n', 'utf8')
    await writeFile(join(globalDir, 'default.yaml'), 'name: default\nsteps:\n', 'utf8')
    const root = await mkdtemp(join(tmpdir(), 'wf-global-names-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'p1.yaml'), 'name: p1\nsteps:\n', 'utf8')
    expect(projectWorkflowNames(root).sort()).toEqual(['default', 'design-system', 'g1', 'p1'])
  })

  it('TENON_RUNTIME_HOME 重定向全局存储位置', async () => {
    const home = await isolatedHome()
    expect(globalWorkflowRoot()).toBe(join(home, 'config', 'workflows'))
  })
})
