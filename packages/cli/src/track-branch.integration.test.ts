import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { removeDesignSystem } from '@tenon/kernel/design-system/test-support'
import { freshHarness, rm, type Harness } from './integration-harness.js'

/**
 * backend 分支 + 一条 registry 未登记的 mobile 分支；backend 的 change 阶段用 auto 门（离开条件 pr_url 非空即放行——
 * 原来由步骤 `outputs` 推出「输出齐全」，`outputs` 已删除，自动门禁 = 离开条件全部满足，所以直接写 field-nonempty）。
 */
const BRANCHED_WF = `name: branched
tracks:
  backend:
    label: 后端
    steps:
      - id: change
        label: 改动
        gate: auto
        skills: []
        guards:
          - type: field-nonempty
            field: pr_url
        transitions:
          - event: go
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
  mobile:
    label: 移动端
    steps:
      - id: design
        label: 设计
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: design-complete
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

/** 升级前的写法：同一工作流开启 OpenSpec，只有 mobile 分支声明文档契约（设计阶段要求项目文档 DESIGN.md）。新定义不能再写它。 */
const LEGACY_GOVERNED_BRANCHED_WF = BRANCHED_WF
  .replace('name: branched\n', 'name: branched\nopenspec: true\n')
  .replace('    label: 移动端\n', [
    '    label: 移动端',
    '    document_contract:',
    '      version: v1',
    '      slots:',
    '        - { kind: design-md, owner_step: design, role: require }',
    '      reads: []',
    '',
  ].join('\n'))

/** 现在的写法：mobile 的设计步用 required-output 要求本任务里这一步产出 DESIGN.md；backend 分支不要求。 */
const REQUIRED_OUTPUT_BRANCHED_WF = BRANCHED_WF
  .replace('name: branched\n', 'name: branched\nopenspec: true\n')
  .replace(
    '        label: 设计\n        gate: null\n        skills: []\n        inputs: []\n        outputs: []\n        guards: []\n',
    '        label: 设计\n        gate: null\n        skills: []\n        guards:\n          - type: required-output\n            path: DESIGN.md\n',
  )

describe('真实 e2e —— 工作流 track 分支与 auto 门', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  async function writeBranched(): Promise<void> {
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'branched.yaml'), BRANCHED_WF, 'utf8')
  }

  test('registry 未登记的 mobile 只在工作流里有分支 → init 成功，首阶段 = 分支首步', async () => {
    h = await freshHarness()
    await writeBranched()
    expect(await h.run(['init', 'mob', '--track', 'mobile', '--workflow', 'branched', '--preset', 'full']), h.err.join('\n')).toBe(0)
    const yaml = await h.read('mob')
    expect(yaml).toMatch(/^phase: design$/m)
    expect(yaml).toMatch(/^track: mobile$/m)
    expect(yaml).toMatch(/^workflow: branched$/m)
  })

  test('分支必须产出：mobile 的设计步要求本任务产出 DESIGN.md、backend 不要求；document status 与转换按分支各自的要求', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'branched.yaml'), REQUIRED_OUTPUT_BRANCHED_WF, 'utf8')
    // 夹具仓库自带就绪的设计体系（DESIGN.md 早就在项目里，不算本任务的产出）；这里按「项目里没有它」来演示。
    removeDesignSystem(h.cwd)
    expect(await h.run(['init', 'mob', '--track', 'mobile', '--workflow', 'branched', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(await h.run(['init', 'web', '--track', 'backend', '--workflow', 'branched', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(await h.run(['document', 'status', 'web']), h.out.join('\n')).toBe(0)
    expect(await h.run(['document', 'status', 'mob'])).toBe(2)
    expect(h.out.join('\n')).toContain('DESIGN.md')
    expect(await h.run(['transition', 'mob', 'design-complete'])).not.toBe(0)
    expect(h.err.join('\n')).toContain('DESIGN.md')
    expect(await h.read('mob')).toMatch(/^phase: design$/m)

    await writeFile(join(h.cwd, 'DESIGN.md'), '# Design system\n', 'utf8')
    expect(await h.run(['document', 'status', 'mob']), h.out.join('\n')).toBe(0)
    expect(await h.run(['transition', 'mob', 'design-complete']), h.err.join('\n')).toBe(0)
    expect(await h.read('mob')).toMatch(/^phase: done$/m)
  })

  test('升级前创建的任务（冻结着分支文档契约）：mobile 要求 DESIGN.md、backend 不要求；handoff --bundle 按分支契约取文档', async () => {
    h = await freshHarness()
    // 首步的 require 槽位在旧版是立项前置条件；新定义不能再声明契约，所以两个任务都取升级前冻结的快照立项。
    expect(await h.initLegacyWorkflow('mob', LEGACY_GOVERNED_BRANCHED_WF, { track: 'mobile' }), h.err.join('\n')).toBe(0)
    removeDesignSystem(h.cwd)
    expect(await h.initLegacyWorkflow('web', LEGACY_GOVERNED_BRANCHED_WF, { track: 'backend' }), h.err.join('\n')).toBe(0)
    expect(await h.run(['document', 'status', 'web']), h.out.join('\n')).toBe(0)
    expect(await h.run(['document', 'status', 'mob'])).toBe(2)
    expect(h.out.join('\n')).toContain("缺少项目文档 'design-md'（DESIGN.md）")
    expect(await h.run(['transition', 'mob', 'design-complete'])).not.toBe(0)
    expect(await h.read('mob')).toMatch(/^phase: design$/m)

    await writeFile(join(h.cwd, 'DESIGN.md'), '# Design system\n', 'utf8')
    expect(await h.run(['handoff', 'mob', '--bundle', '--target', 'design', '--json']), h.err.join('\n')).toBe(0)
    const bundle = JSON.parse(h.out.at(-1) ?? '{}') as { inputs: Array<{ kind: string; path: string }> }
    expect(bundle.inputs.map((input) => [input.kind, input.path])).toEqual([['design-md', 'DESIGN.md']])
    expect(await h.run(['document', 'status', 'mob']), h.out.join('\n')).toBe(0)
    expect(await h.run(['transition', 'mob', 'design-complete']), h.err.join('\n')).toBe(0)
    expect(await h.read('mob')).toMatch(/^phase: done$/m)
  })

  test('既无登记也无分支的 track → init 拒绝', async () => {
    h = await freshHarness()
    await writeBranched()
    expect(await h.run(['init', 'nope', '--track', 'tablet', '--workflow', 'branched', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toMatch(/tablet/)
  })

  test('backend 走自己的分支；auto 门：输出缺失时 transition 被拒，补齐后放行', async () => {
    h = await freshHarness()
    await writeBranched()
    expect(await h.run(['init', 'web', '--track', 'backend', '--workflow', 'branched', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(await h.read('web')).toMatch(/^phase: change$/m)
    expect(await h.run(['transition', 'web', 'go'])).not.toBe(0)
    expect(`${h.out.join('\n')}\n${h.err.join('\n')}`).toMatch(/pr_url/)
    expect(await h.read('web')).toMatch(/^phase: change$/m)
    expect(await h.run(['set', 'web', 'pr_url', 'https://example.com/pr/1']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'web', 'go']), h.err.join('\n')).toBe(0)
    expect(await h.read('web')).toMatch(/^phase: done$/m)
  })
})
