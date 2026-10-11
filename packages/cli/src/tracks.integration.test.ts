/**
 * `tenon tracks list/show` e2e —— 真 kernel + 真临时 fs。
 *
 * 轨道只是工作流 YAML 里的 `tracks.<id>` 分支，没有独立的登记表：列出的是项目可用的全部工作流
 * （项目 → 全局存储 → 插件模板）里的分支，平铺工作流只有一条与工作流同名的隐式轨道。
 * 覆盖：list 的固定列与顺序 / list --json schema / show 的 `<工作流>:<轨道>` 与裸轨道 id /
 * 歧义与未知 id exit 1 / 写坏的工作流跳过并警告 / 旧 tracks.yaml 只提示一行、不读取 / bare 子命令 usage exit 1。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { serializeWorkflow } from '@tenon/kernel'
import { targetDefaultWorkflow } from '@tenon/kernel/workflow/test-support'
import { freshHarness, type Harness } from './integration-harness.js'

const STEP = `  - id: only
    label: Only
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** 平铺的自定义工作流。 */
const flat = (id: string): string => `name: ${id}\nsteps:\n${STEP}`

/** 带一条与 default 同名分支 `pm` 的自定义工作流（制造歧义）。 */
const branched = (id: string): string => `name: ${id}\ntracks:\n  pm:\n    label: 另一个产品\n    steps:\n${STEP.replace(/^/gmu, '    ')}`

describe('tenon tracks —— list/show（只读，来自工作流分支）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'default.yaml'), serializeWorkflow(targetDefaultWorkflow()), 'utf8')
  })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  const writeWorkflow = (id: string, source: string) =>
    writeFile(join(h.cwd, '.pipeline', 'workflows', `${id}.yaml`), source, 'utf8')

  test('list：固定列 WORKFLOW:TRACK LABEL ROUTABLE，default 的轨道在最前，平铺工作流列一条同名轨道，纯 stdout', async () => {
    expect(await h.run(['tracks', 'list'])).toBe(0)
    expect(h.out[0]).toMatch(/^WORKFLOW:TRACK\s+LABEL\s+ROUTABLE$/)
    const ids = h.out.slice(1).map((line) => line.split(/\s+/)[0])
    expect(ids.slice(0, 4)).toEqual(['default:lite', 'default:pm', 'default:frontend', 'default:backend'])
    expect(ids).toContain('design-system:design-system')
    expect(h.err).toEqual([])
    const rows = Object.fromEntries(h.out.slice(1).map((line) => [line.split(/\s+/)[0], line.trim().split(/\s+/).at(-1)]))
    for (const id of ['default:lite', 'default:pm', 'default:frontend', 'default:backend']) expect(rows[id], id).toBe('yes')
    expect(rows['design-system:design-system']).toBe('no')
  })

  test('list --json：每条 {workflow, track, label, spec, routable, automation, steps}，纯 stdout', async () => {
    expect(await h.run(['tracks', 'list', '--json'])).toBe(0)
    expect(h.out).toHaveLength(1)
    const arr = JSON.parse(h.out[0]!) as Array<Record<string, unknown>>
    const byId = new Map(arr.map((t) => [`${String(t.workflow)}:${String(t.track)}`, t]))
    for (const t of arr) {
      expect(Object.keys(t)).toEqual(expect.arrayContaining(['workflow', 'track', 'label', 'implicit', 'spec', 'routable', 'automation', 'steps']))
    }
    expect(byId.get('default:lite')).toMatchObject({ label: '轻量', spec: 'none', routable: true, implicit: false, automation: { eligible: false, enqueueAfterSpec: false } })
    expect(byId.get('default:lite')?.steps).toEqual(['open', 'build', 'verify', 'done', 'escalated'])
    expect(byId.get('default:pm')).toMatchObject({ spec: 'openspec', routable: true, automation: { eligible: true, enqueueAfterSpec: true } })
    expect(byId.get('default:backend')).toMatchObject({ route: { fallback: true } })
    expect(byId.get('design-system:design-system')).toMatchObject({ implicit: true, routable: false })
  })

  test('show <工作流>:<轨道>：人读与 --json', async () => {
    expect(await h.run(['tracks', 'show', 'default:lite'])).toBe(0)
    expect(h.out).toContain('workflow: default')
    expect(h.out).toContain('track: lite')
    expect(h.out).toContain('spec: none')
    expect(h.out).toContain('steps: open -> build -> verify -> done -> escalated')
    expect(await h.run(['tracks', 'show', 'default:pm', '--json'])).toBe(0)
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ workflow: 'default', track: 'pm', spec: 'openspec' })
  })

  test('show 裸轨道 id：只在一个工作流里出现时可省略工作流名', async () => {
    expect(await h.run(['tracks', 'show', 'frontend', '--json'])).toBe(0)
    expect(JSON.parse(h.out[0]!)).toMatchObject({ workflow: 'default', track: 'frontend' })
  })

  test('show 裸轨道 id 出现在多个工作流 → exit 1，列出候选；带上工作流名可消歧', async () => {
    await writeWorkflow('mine', branched('mine'))
    expect(await h.run(['tracks', 'show', 'pm'])).toBe(1)
    expect(h.err.join('\n')).toContain('default:pm, mine:pm')
    expect(await h.run(['tracks', 'show', 'mine:pm', '--json'])).toBe(0)
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ workflow: 'mine', track: 'pm', label: '另一个产品' })
  })

  test('show 未知 id → exit 1', async () => {
    expect(await h.run(['tracks', 'show', 'ghost'])).toBe(1)
    expect(h.err.join('\n')).toContain("没有轨道 'ghost'")
    expect(await h.run(['tracks', 'show', 'default:chat'])).toBe(1)
  })

  test('写坏的工作流跳过并各输出一行警告，其余照常列出', async () => {
    await writeWorkflow('broken', 'name: broken\nsteps:\n  - id: a\n    label: a\n    gate: bogus\n')
    await writeWorkflow('mine', flat('mine'))
    expect(await h.run(['tracks', 'list'])).toBe(0)
    expect(h.err.filter((line) => line.startsWith('WARN:') && line.includes("'broken'"))).toHaveLength(1)
    expect(h.out.map((line) => line.split(/\s+/)[0])).toContain('mine:mine')
  })

  test('项目里的 .pipeline/tracks.yaml 不被读取：写坏也不影响，只输出一行迁移提示', async () => {
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), '{{{ 不是合法的 YAML', 'utf8')
    expect(await h.run(['tracks', 'list'])).toBe(0)
    expect(h.err.filter((line) => line.includes('tracks.yaml 已不再读取'))).toHaveLength(1)
    expect(h.out.map((line) => line.split(/\s+/)[0])).toContain('default:lite')
  })

  test('bare tracks（无子命令）→ usage exit 1', async () => {
    expect(await h.run(['tracks'])).toBe(1)
    expect(h.err.join('\n')).toContain('用法：tenon tracks')
  })
})
