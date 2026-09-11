/**
 * `tenon tracks list/show` e2e —— 真 kernel + 真临时 fs。
 * 覆盖：list builtin-only 顺序与固定列 / list --json schema / show 的 source 标注 / 未知 id exit 1 /
 * bare 子命令 usage exit 1。
 *
 * 写入面（create/update/delete）已随「轨道只认工作流分支」移除，对应用例一并删除：注册表不再能
 * 登记一条工作流未声明的轨道，也就没有 CRUD、引用完整性与跨命令记忆化可测。轨道与工作流的配对
 * 语义改由 `track-registry.integration.test.ts` 覆盖。
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildProgram, CliExit } from './program.js'
import { freshHarness, realDeps, type Harness } from './integration-harness.js'

/** 最小合法自定义 workflow（首 step=draft），供 allowed 白名单引用真实存在。 */
function workflowYaml(id: string): string {
  return `name: ${id}
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
}

async function writeWorkflow(cwd: string, id: string): Promise<void> {
  await mkdir(join(cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(cwd, '.pipeline', 'workflows', `${id}.yaml`), workflowYaml(id), 'utf8')
}

const CREATE_DATA = ['tracks', 'create', 'data', '--label', 'Data', '--workflow-default', 'default', '--workflow-any', '--policy', 'chat']

describe('tenon tracks —— list/show（只读）', () => {
  let h: Harness
  beforeEach(async () => { h = await freshHarness() })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  test('list（无 tracks.yaml）：固定列 + 内建六轨固定序，纯 stdout', async () => {
    expect(await h.run(['tracks', 'list'])).toBe(0)
    expect(h.out[0]).toMatch(/^ID\s+LABEL\s+BUILTIN\s+DEFAULT\s+ALLOWED\s+POLICY/)
    expect(h.out.slice(1).map((l) => l.split(/\s+/)[0])).toEqual(['chat', 'simple', 'pm', 'frontend', 'backend', 'free'])
    expect(h.err).toEqual([])
  })

  test('list --json：array 6 条、schema 完整、纯 stdout', async () => {
    expect(await h.run(['tracks', 'list', '--json'])).toBe(0)
    expect(h.out).toHaveLength(1)
    const arr = JSON.parse(h.out[0]!)
    expect(arr).toHaveLength(6)
    expect(arr.map((t: { id: string }) => t.id)).toEqual(['chat', 'simple', 'pm', 'frontend', 'backend', 'free'])
    for (const t of arr) {
      expect(t).toMatchObject({ builtin: true, source: 'builtin' })
      expect(Object.keys(t)).toEqual(expect.arrayContaining(['id', 'label', 'builtin', 'workflow', 'policyProfile', 'revision']))
    }
  })

  test('show chat：人读 source: builtin；--json source builtin', async () => {
    expect(await h.run(['tracks', 'show', 'chat'])).toBe(0)
    expect(h.out).toContain('source: builtin')
    expect(await h.run(['tracks', 'show', 'chat', '--json'])).toBe(0)
    expect(JSON.parse(h.out[0]!)).toMatchObject({ id: 'chat', source: 'builtin', builtin: true })
  })

  test('show 未知 id → exit 1', async () => {
    expect(await h.run(['tracks', 'show', 'ghost'])).toBe(1)
    expect(h.err.join('\n')).toContain("未注册的 track 'ghost'")
  })

  test('bare tracks（无子命令）→ usage exit 1', async () => {
    expect(await h.run(['tracks'])).toBe(1)
    expect(h.err.join('\n')).toContain('用法：tenon tracks')
  })
})
