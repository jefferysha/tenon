import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

/** 通用分支 + 一条 registry 未登记的 mobile 分支；通用分支的 change 阶段用 auto 门（输出 pr_url 齐全即放行）。 */
const BRANCHED_WF = `name: branched
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
tracks:
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

  test('既无登记也无分支的 track → init 拒绝', async () => {
    h = await freshHarness()
    await writeBranched()
    expect(await h.run(['init', 'nope', '--track', 'tablet', '--workflow', 'branched', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toMatch(/tablet/)
  })

  test('backend 走通用分支；auto 门：输出缺失时 transition 被拒，补齐后放行', async () => {
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
