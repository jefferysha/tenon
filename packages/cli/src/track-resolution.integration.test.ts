/**
 * 轨道只认工作流分支 e2e——真 kernel + 真临时 fs，零 mock。
 *
 * 轨道的单一真相是**工作流 YAML 里的 `tracks.<id>` 分支**；没有任何独立的轨道登记表，项目里的
 * `.pipeline/tracks.yaml` 也不再被读取：
 *  - 声明了 `tracks:` 的工作流（release、default）只接受它自己列出的分支，省略 `--track` 也被拒并列出可选项；
 *  - 没有 `tracks:` 的平铺工作流（data-flow）只有一条与工作流同名的隐式轨道，不用写 `--track`；
 *  - `init`、`set track|workflow`、`afk enqueue` 都按分支判定，不存在的轨道一律 fail-loud、不落盘；
 *  - 分支声明的 `automation` 决定能否进入 AFK（没写 = 不可进入）。
 * 旧 tracks.yaml 的 policy（评审种子、coverage、routing、技能矩阵）随登记表一起移除，对应用例不再存在。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { serializeWorkflow } from '@tenon/kernel'
import { targetDefaultWorkflow } from '@tenon/kernel/workflow/test-support'
import { freshHarness, type Harness } from './integration-harness.js'

/** 平铺自定义工作流 data-flow（首 step=draft）。 */
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

/** 有两条分支的自定义工作流：docs（没写 automation）与 ops（automation.eligible: true）。 */
const RELEASE_YAML = `name: release
tracks:
  docs:
    label: 文档
    steps:
      - id: write
        label: write
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: write-complete
            to: done
      - id: done
        label: done
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
  ops:
    label: 运维
    automation: { eligible: true }
    steps:
      - id: rollout
        label: rollout
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: rollout-complete
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

describe('轨道只认工作流分支（e2e：真 YAML 驱动，不查登记表）', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'data-flow.yaml'), DATA_FLOW_YAML, 'utf8')
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'release.yaml'), RELEASE_YAML, 'utf8')
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('init --workflow release --track docs：分支放行，首态落到该分支的第一步', async () => {
    expect(await h.run(['init', 'rd', '--workflow', 'release', '--track', 'docs', '--preset', 'full'])).toBe(0)
    const yaml = await h.read('rd')
    expect(yaml).toContain('track: docs')
    expect(yaml).toContain('workflow: release')
    expect(yaml).toContain('phase: write')
  })

  test('init --workflow release 不带 --track：有分支必须点名，列出全部可选轨道，不建 change', async () => {
    expect(await h.run(['init', 'rn', '--workflow', 'release', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'rn'))).toBe(false)
    expect(h.err.join('\n')).toContain('--track（docs|ops）')
  })

  test('init --track docs（缺省 default）：default 没有 docs 分支 → 拒，列出 default 的可选轨道，不建 change', async () => {
    expect(await h.run(['init', 'dc2', '--track', 'docs', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'dc2'))).toBe(false)
    const err = h.err.join('\n')
    expect(err).toContain("工作流 'default' 没有轨道 'docs'")
    expect(err).toContain('pm, frontend, backend')
  })

  test('init --track ghost：不存在的轨道 → exit 1，不建 change', async () => {
    expect(await h.run(['init', 'g', '--track', 'ghost', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'g'))).toBe(false)
    expect(h.err.join('\n')).toContain("没有轨道 'ghost'")
  })

  test('init --workflow 不存在的工作流 → exit 1，不建 change', async () => {
    expect(await h.run(['init', 'w', '--workflow', 'other', '--track', 'x', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'w'))).toBe(false)
    expect(h.err.join('\n')).toContain("workflow 'other' 未找到")
  })

  test('init --track backend：default 的分支照常放行（走 open 首态）', async () => {
    expect(await h.run(['init', 'bc', '--track', 'backend', '--preset', 'full'])).toBe(0)
    const yaml = await h.read('bc')
    expect(yaml).toContain('track: backend')
    expect(yaml).toContain('phase: open')
  })

  test('平铺工作流不用写 --track：轨道就是工作流名；写了别的轨道名 → 拒并提示', async () => {
    expect(await h.run(['init', 'flat', '--workflow', 'data-flow', '--preset', 'full'])).toBe(0)
    const yaml = await h.read('flat')
    expect(yaml).toContain('track: data-flow')
    expect(yaml).toContain('phase: draft')

    expect(await h.run(['init', 'flat2', '--workflow', 'data-flow', '--track', 'data-flow', '--preset', 'full'])).toBe(0)
    expect(await h.run(['init', 'flat3', '--workflow', 'data-flow', '--track', 'free', '--preset', 'full'])).toBe(1)
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'flat3'))).toBe(false)
    const err = h.err.join('\n')
    expect(err).toContain("工作流 'data-flow' 没有轨道 'free'（可选：data-flow）")
    expect(err).toContain('不用写 --track')
  })

  test('set track：default 声明了的分支放行（backend），未声明的拒（docs、ghost），拒绝时不改写', async () => {
    expect(await h.run(['init', 's1', '--track', 'pm', '--preset', 'full'])).toBe(0)
    // backend 是 default 的一条分支 → 放行，证明拒绝 docs 的理由是分支而不是「一律不让改」。
    expect(await h.run(['set', 's1', 'track', 'backend'])).toBe(0)
    expect(await h.read('s1')).toContain('track: backend')
    // docs 是 release 的分支，不是 default 的 → 拒，不改写。
    expect(await h.run(['set', 's1', 'track', 'docs'])).toBe(1)
    expect(await h.read('s1')).toContain('track: backend')
    expect(await h.run(['set', 's1', 'track', 'ghost'])).toBe(1)
  })

  test('set-many track=… workflow=…：按最终组合校验，非法组合 exit 1 且不写', async () => {
    expect(await h.run(['init', 's2', '--track', 'pm', '--preset', 'full'])).toBe(0)
    expect(await h.run(['set-many', 's2', 'track=docs', 'workflow=default'])).toBe(1)
    expect(await h.read('s2')).toContain('track: pm')
    expect(await h.run(['set-many', 's2', 'track=docs', 'workflow=other'])).toBe(1)
    expect(await h.read('s2')).toContain('track: pm')
  })

  test('AFK enqueue 读分支的 automation：没写 automation 的分支即使已 queued 也拒绝且零写入', async () => {
    expect(await h.run(['init', 'manual', '--workflow', 'release', '--track', 'docs', '--preset', 'full'])).toBe(0)
    expect(await h.run(['set', 'manual', 'automation', 'queued'])).toBe(0)
    const before = await h.read('manual')

    expect(await h.run(['afk', 'enqueue', 'manual'])).toBe(3)
    expect(h.err.join('\n')).toContain('该轨道不可进入 AFK')
    expect(await h.read('manual')).toBe(before)
  })

  test('AFK enqueue：分支声明 automation.eligible: true → 挂队', async () => {
    expect(await h.run(['init', 'auto', '--workflow', 'release', '--track', 'ops', '--preset', 'full'])).toBe(0)
    expect(await h.run(['afk', 'enqueue', 'auto'])).toBe(0)
    expect(await h.read('auto')).toContain('automation: queued')
  })

  test('在途的旧轨道任务（chat / free）：default 改成没有这些分支之后，status / check / workflow plan 仍按冻结快照判定，不报没有轨道', async () => {
    // 升级前的 default：除了 lite / pm / frontend / backend，还有 chat（对话）与 free（自由）两个七阶段分支
    // （这里用后端分支的步骤当它们的骨架——要验的是快照自足，不是它们当年的技能清单）。
    const target = targetDefaultWorkflow()
    const backend = target.tracks?.backend
    if (backend === undefined) throw new Error('default 没有 backend 分支')
    const { route: _route, automation: _automation, ...skeleton } = backend
    await writeFile(
      join(h.cwd, '.pipeline', 'workflows', 'default.yaml'),
      serializeWorkflow({ ...target, tracks: { chat: { ...skeleton, label: '对话' }, ...target.tracks, free: { ...skeleton, label: '自由' } } }),
      'utf8',
    )
    // 升级前创建的任务：冻结的快照记着 phase-manifest（新建任务一律 step-graph）。
    expect(await h.initLegacyDefault('old-chat', 'chat')).toBe(0)
    expect(await h.initLegacyDefault('old-free', 'free')).toBe(0)
    // 之后项目把 default 改成目标形态（lite / pm / frontend / backend，没有 chat / free）。
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'default.yaml'), serializeWorkflow(targetDefaultWorkflow()), 'utf8')
    for (const change of ['old-chat', 'old-free']) {
      expect(await h.run(['status', change, '--json']), h.err.join('\n')).toBe(0)
      expect(JSON.parse(h.out.at(-1) ?? '{}')).toMatchObject({ step: { id: 'open' } })
      expect(await h.run(['workflow', 'plan', change, '--json']), h.err.join('\n')).toBe(0)
      expect(JSON.parse(h.out.at(-1) ?? '{}')).toMatchObject({ source: 'frozen-snapshot', plan: { executionModel: 'phase-manifest' } })
      await h.run(['check', change])
      expect(h.err.join('\n')).not.toMatch(/没有轨道|未注册的 track/)
    }
    // 旧表给的策略位也没丢：chat 可进 AFK，free 不可。
    expect(await h.run(['set', 'old-chat', 'automation', 'queued'])).toBe(0)
    expect(await h.run(['afk', 'enqueue', 'old-chat'])).toBe(0)
    expect(await h.run(['afk', 'enqueue', 'old-free'])).toBe(3)
  })

  test('旧 tracks.yaml 不被读取：写坏、缺字段都不影响 init / afk，只输出一行迁移提示', async () => {
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), 'version: [broken\n', 'utf8')
    expect(await h.run(['init', 'legacy', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(h.err.filter((line) => line.includes('tracks.yaml 已不再读取'))).toHaveLength(1)

    await writeFile(
      join(h.cwd, '.pipeline', 'tracks.yaml'),
      'version: 1\ntracks:\n  - id: broken\n    label: Broken\n',
      'utf8',
    )
    expect(await h.run(['init', 'legacy2', '--track', 'frontend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['afk', 'enqueue', 'legacy2'])).toBe(0)
  })

  test('没有 tracks.yaml 时不输出迁移提示', async () => {
    expect(await h.run(['init', 'clean', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(h.err.some((line) => line.includes('tracks.yaml'))).toBe(false)
  })
})
