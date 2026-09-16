import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { removeDesignSystem, writeReadyDesignSystem } from '@tenon/kernel/design-system/test-support'
import { freshHarness, rm, type Harness } from './integration-harness.js'

/** backend 分支 + 一条 registry 未登记的 mobile 分支；backend 的 change 阶段用 auto 门（输出 pr_url 齐全即放行）。 */
const BRANCHED_WF = `name: branched
tracks:
  backend:
    label: 后端
    steps:
      - id: change
        label: 改动
        gate: auto
        skills: []
        inputs: []
        outputs:
          - field: pr_url
            type: string
        guards: []
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

/** 同一工作流开启 OpenSpec：只有 mobile 分支声明文档契约（设计阶段要求项目文档 DESIGN.md）。 */
const GOVERNED_BRANCHED_WF = BRANCHED_WF
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

  test('分支文档契约：mobile 要求 DESIGN.md、backend 不要求；handoff --bundle 按分支契约取文档', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'branched.yaml'), GOVERNED_BRANCHED_WF, 'utf8')
    // 首步的 require 槽位现在也是立项前置条件：先放一套就绪的设计体系立项，再删掉它跑运行时证据缺口。
    writeReadyDesignSystem(h.cwd)
    expect(await h.run(['init', 'mob', '--track', 'mobile', '--workflow', 'branched', '--preset', 'full']), h.err.join('\n')).toBe(0)
    removeDesignSystem(h.cwd)
    expect(await h.run(['init', 'web', '--track', 'backend', '--workflow', 'branched', '--preset', 'full']), h.err.join('\n')).toBe(0)
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
