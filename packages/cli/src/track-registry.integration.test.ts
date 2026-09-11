/**
 * Track Registry × 工作流分支 e2e——真 kernel + 真临时 fs，零 mock。
 *
 * 单一真相是**工作流里的轨道分支**：`.pipeline/tracks.yaml` 只提供 policy（review seed、
 * coverage profile、routing、skill profile），不决定一条轨道能否与某个工作流一起用。
 *  - 未声明 `tracks:` 的工作流（data-flow）对任何已注册轨道开放；
 *  - 声明了 `tracks:` 的工作流（default）只接受它自己列出的分支——注册表里的 `workflow.allowed`
 *    含 default 也不作数，init/set 一律拒绝并指出缺哪条分支；
 *  - 要让自定义轨走 default 的七阶段链路，必须在工作流覆盖文件里声明该分支；声明之后
 *    tracks.yaml 的 policy 照常生效（coverage_profile=backend → 七层矩阵阻断）；
 *  - 未注册 track、损坏 / orphan tracks.yaml 一律 fail-loud，不落盘。
 * 缺 tracks.yaml 的内建 Track 行为另由 init.test / fields.test 覆盖。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'

/** 自定义 track 'data'：缺省绑 data-flow（真存在的自定义 workflow），allowed 仅 data-flow/default。 */
const TRACKS_YAML = `version: 1
tracks:
  - id: data
    label: Data
    workflow:
      default: data-flow
      allowed: [data-flow, default]
    policy_profile:
      review_seed: skipped
      automation_eligible: false
      coverage_profile: backend
      routing:
        enabled: true
        pattern: '(数据|ETL)'
        priority: 150
      skills:
        matrix: true
        profile: backend
`

/**
 * data-flow 自定义 workflow（首 step=draft）——init --track data 缺省应种到 draft。
 * 含一个 `spec` 步骤：coverage 用例要把 change 推到 spec 出口才能触发七层矩阵，而 default 没有
 * data 分支、不能再借用（「轨道只认工作流分支」）。
 */
const DATA_FLOW_YAML = `name: data-flow
steps:
  - id: draft
    label: draft
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: spec
  - id: spec
    label: spec
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: spec-complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('动态 Track Registry 校验面（R2，e2e：真 tracks.yaml 驱动）', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), TRACKS_YAML, 'utf8')
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'data-flow.yaml'), DATA_FLOW_YAML, 'utf8')
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('init --track data（缺省 workflow）：注册轨放行，绑定 data-flow 首态 draft，reviewSeed 与 id 无关', async () => {
    expect(await h.run(['init', 'dc', '--track', 'data', '--preset', 'full'])).toBe(0)
    const yaml = await h.read('dc')
    expect(yaml).toContain('track: data')
    expect(yaml).toContain('workflow: data-flow')
    expect(yaml).toContain('phase: draft')
    expect(yaml).toContain('agent_review_result: skipped')
    expect(yaml).toContain('codex_review_result: skipped')
  })

  test('init --track data --workflow default：default 未声明 data 分支 → 拒，exit 1，不建 change（注册表的 allowed 说了不算）', async () => {
    expect(await h.run(['init', 'dc2', '--track', 'data', '--workflow', 'default', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'dc2'))).toBe(false)
    expect(h.err.join('\n')).toContain("工作流 'default' 没有轨道 'data' 的分支")
  })

  test('init --track data --workflow other：other 不在 allowed → 落盘前拒，exit 1，不建 change', async () => {
    expect(await h.run(['init', 'bad', '--track', 'data', '--workflow', 'other', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'bad'))).toBe(false)
    expect(h.err.join('\n')).toContain("不允许绑定 workflow 'other'")
  })

  test('init --track ghost：未注册 track → exit 1，不建 change', async () => {
    expect(await h.run(['init', 'g', '--track', 'ghost', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'g'))).toBe(false)
    expect(h.err.join('\n')).toContain("未注册的 track 'ghost'")
  })

  test('init --track backend：内建轨与自定义轨并存，内建轨仍放行（走内建 open 首态）', async () => {
    expect(await h.run(['init', 'bc', '--track', 'backend', '--preset', 'full'])).toBe(0)
    const yaml = await h.read('bc')
    expect(yaml).toContain('track: backend')
    expect(yaml).toContain('phase: open')
  })

  test('set track：default 声明了的分支放行（backend），未声明的拒（data，尽管已注册），未注册的也拒（ghost）', async () => {
    expect(await h.run(['init', 's1', '--track', 'chat', '--preset', 'full'])).toBe(0)
    // backend 是 default 的一条分支 → 放行，证明拒绝 data 的理由是分支而不是「一律不让改」。
    expect(await h.run(['set', 's1', 'track', 'backend'])).toBe(0)
    expect(await h.read('s1')).toContain('track: backend')
    // data 在 tracks.yaml 里注册且 allowed 含 default，但 default 没有 data 分支 → 拒，不改写。
    expect(await h.run(['set', 's1', 'track', 'data'])).toBe(1)
    expect(await h.read('s1')).toContain('track: backend')
    expect(await h.run(['set', 's1', 'track', 'ghost'])).toBe(1)
  })

  test('set-many track=data workflow=other：最终组合触犯 data 的 allowed → exit 1，不写', async () => {
    expect(await h.run(['init', 's2', '--track', 'chat', '--preset', 'full'])).toBe(0)
    expect(await h.run(['set-many', 's2', 'track=data', 'workflow=other'])).toBe(1)
    // track 未被改写（组合校验在落盘前拦截）
    expect(await h.read('s2')).toContain('track: chat')
  })

  test('AFK enqueue 真读动态 policy：automationEligible=false 即使已 queued 也拒绝且零写入', async () => {
    expect(await h.run(['init', 'manual', '--track', 'data', '--preset', 'full'])).toBe(0)
    expect(await h.run(['set', 'manual', 'automation', 'queued'])).toBe(0)
    const before = await h.read('manual')

    expect(await h.run(['afk', 'enqueue', 'manual'])).toBe(3)
    expect(await h.read('manual')).toBe(before)
  })

  test('AFK enqueue 遇直改文件造成的 orphan track → fail-loud exit 1，不回退静态判断', async () => {
    expect(await h.run(['init', 'orphan', '--track', 'data', '--preset', 'full'])).toBe(0)
    const before = await h.read('orphan')
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), 'version: 1\n', 'utf8')

    expect(await h.run(['afk', 'enqueue', 'orphan'])).toBe(1)
    expect(h.err.join('\n')).toContain("未注册的 track 'data'")
    expect(await h.read('orphan')).toBe(before)
  })

  test('AFK enqueue 遇损坏 tracks.yaml → fail-loud exit 1，不回退 builtin/旧 PM 判断', async () => {
    expect(await h.run(['init', 'corrupt', '--track', 'data', '--preset', 'full'])).toBe(0)
    const before = await h.read('corrupt')
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), 'version: [broken\n', 'utf8')

    expect(await h.run(['afk', 'enqueue', 'corrupt'])).toBe(1)
    expect(h.err.join('\n')).toContain('tracks.yaml')
    expect(await h.read('corrupt')).toBe(before)
  })

  test('default 项目覆盖里声明 data 分支后 data 才可用，且 check 真读动态 policy：coverageProfile=backend 按 7 层矩阵阻断', async () => {
    const name = 'coverage-data'
    // 方案 B 的正道：要让自定义轨走 default 的七阶段链路，必须在工作流里**声明**这条分支。
    // 由真模板改名一条分支（free → data）得到项目覆盖，七阶段契约不变。
    const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
    const template = await readFile(join(repoRoot, 'templates', 'workflows', 'default.yaml'), 'utf8')
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'default.yaml'), template.replace('\n  free:\n', '\n  data:\n'), 'utf8')

    expect(await h.run(['init', name, '--track', 'data', '--workflow', 'default', '--preset', 'full'])).toBe(0)
    await h.seedArtifact(name, 'phase', 'spec')
    await h.seedArtifact(name, 'design_doc', 'docs/design.md')
    await h.seedArtifact(name, 'plan', 'docs/plan.md')
    await mkdir(join(h.cwd, 'docs'), { recursive: true })
    await writeFile(join(h.cwd, 'docs', 'design.md'), '# design without coverage block\n', 'utf8')
    await writeFile(join(h.cwd, 'docs', 'plan.md'), '# plan\n', 'utf8')
    await writeFile(
      join(h.cwd, 'openspec', 'changes', name, 'tasks.md'),
      '- [ ] task 1\n- [ ] task 2\n- [ ] task 3\n',
      'utf8',
    )

    expect(await h.run(['check', name])).toBe(2)
    expect(h.out.join('\n')).toContain('全栈 Spec 覆盖（7 层阻塞）')
  })

  test('坏 tracks.yaml（缺 policy_profile 必填字段）：track 相关命令 fail-loud，exit 1', async () => {
    await writeFile(
      join(h.cwd, '.pipeline', 'tracks.yaml'),
      'version: 1\ntracks:\n  - id: broken\n    label: Broken\n',
      'utf8',
    )
    expect(await h.run(['init', 'b', '--track', 'chat', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('tracks.yaml')
  })
})
