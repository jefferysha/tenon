import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeWorkflow } from './serialize.js'
import { UnknownTrackError } from './resolve-track.js'
import { targetDefaultWorkflow } from './test-support.js'
import { compileLoadedWorkflow, listWorkflowTracks, loadCompiledWorkflow, loadTrack, requiredTrackChoices } from './track-lookup.js'

const savedRoots = process.env.TENON_RUNTIME_ROOTS

afterEach(() => {
  vi.unstubAllEnvs()
  if (savedRoots === undefined) delete process.env.TENON_RUNTIME_ROOTS
  else process.env.TENON_RUNTIME_ROOTS = savedRoots
})

/** 隔离全局存储：测试不读写真实的用户目录。 */
async function isolatedProject(): Promise<string> {
  vi.stubEnv('TENON_RUNTIME_HOME', await mkdtemp(join(tmpdir(), 'track-lookup-home-')))
  delete process.env.TENON_RUNTIME_ROOTS
  const root = await mkdtemp(join(tmpdir(), 'track-lookup-root-'))
  await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
  return root
}

async function writeProjectWorkflow(root: string, name: string, source: string): Promise<void> {
  await writeFile(join(root, '.pipeline', 'workflows', `${name}.yaml`), source, 'utf8')
}

const DATA_FLOW_FIXTURE = 'name: escape\nsteps:\n  - id: only\n    label: only\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n'

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('loadTrack', () => {
  it('平铺的模板工作流不用指定轨道：得到唯一的隐式分支', async () => {
    const root = await isolatedProject()
    const loaded = loadTrack(root, 'design-system')
    expect(loaded.branch).toMatchObject({ id: 'design-system', implicit: true, spec: 'openspec' })
    expect(loaded.workflow.name).toBe('design-system')
  })

  it('项目覆盖的 default：按分支解析，轨道的步骤与规范来自该文件', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'default', serializeWorkflow(targetDefaultWorkflow()))
    const lite = loadTrack(root, 'default', 'lite')
    expect(lite.branch).toMatchObject({ id: 'lite', spec: 'none', automation: { eligible: false } })
    expect(lite.branch.steps.map((s) => s.id)).toEqual(['open', 'build', 'verify', 'done', 'escalated'])
    expect(loadTrack(root, 'default', 'backend').branch.route?.fallback).toBe(true)
  })

  it('不存在的轨道抛 UnknownTrackError 并列出该工作流的全部轨道', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'default', serializeWorkflow(targetDefaultWorkflow()))
    const e = caught(() => loadTrack(root, 'default', 'free'))
    expect(e).toBeInstanceOf(UnknownTrackError)
    expect((e as UnknownTrackError).available).toEqual(['lite', 'pm', 'frontend', 'backend'])
  })

  it('有分支却不指定轨道也抛 UnknownTrackError', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'default', serializeWorkflow(targetDefaultWorkflow()))
    expect(caught(() => loadTrack(root, 'default'))).toBeInstanceOf(UnknownTrackError)
  })

  it('平铺工作流不接受别的轨道名', async () => {
    const root = await isolatedProject()
    const e = caught(() => loadTrack(root, 'design-system', 'free'))
    expect(e).toBeInstanceOf(UnknownTrackError)
    expect((e as UnknownTrackError).available).toEqual(['design-system'])
  })

  it('工作流不存在 → 抛错点名工作流，不是 UnknownTrackError', async () => {
    const root = await isolatedProject()
    const e = caught(() => loadTrack(root, 'nope', 'x'))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(UnknownTrackError)
    expect((e as Error).message).toContain("workflow 'nope' 未找到")
  })

  it('工作流名拼进文件路径，非法名字（../、斜杠、点）一律拒，不读工作流目录之外的文件', async () => {
    const root = await isolatedProject()
    await writeFile(join(root, 'escape.yaml'), DATA_FLOW_FIXTURE, 'utf8')
    for (const name of ['../escape', '..', 'a/b', 'a.b', '', ' x']) {
      expect(() => loadTrack(root, name), name).toThrow('非法 workflow 名')
    }
    expect(() => loadCompiledWorkflow(root, '../escape')).toThrow('非法 workflow 名')
    expect(() => requiredTrackChoices(root, '../escape')).toThrow('非法 workflow 名')
  })

  it('工作流文件写坏时原样抛出，不伪装成「没有这条轨道」', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'broken', 'name: broken\nsteps:\n  - id: a\n    label: a\n    gate: bogus\n')
    const e = caught(() => loadTrack(root, 'broken', 'x'))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(UnknownTrackError)
  })

  it('项目里的 .pipeline/tracks.yaml 不被读取：写坏也不影响解析', async () => {
    const root = await isolatedProject()
    await writeFile(join(root, '.pipeline', 'tracks.yaml'), '{{{ 不是合法的 YAML', 'utf8')
    expect(loadTrack(root, 'design-system').branch.id).toBe('design-system')
  })

  it('分支带出自己声明的规范与自动化设置，没声明的分支不可进入 AFK', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'default', serializeWorkflow(targetDefaultWorkflow()))
    expect(loadTrack(root, 'default', 'pm').branch).toMatchObject({ spec: 'openspec', automation: { eligible: true, enqueueAfterSpec: true } })
    expect(loadTrack(root, 'default', 'lite').branch).toMatchObject({ spec: 'none', automation: { eligible: false, enqueueAfterSpec: false } })
    expect(loadTrack(root, 'design-system').branch.automation).toEqual({ eligible: false, enqueueAfterSpec: false })
  })
})

describe('requiredTrackChoices', () => {
  it('平铺工作流不用指定轨道；有分支的列出全部分支 id', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'default', serializeWorkflow(targetDefaultWorkflow()))
    expect(requiredTrackChoices(root, 'design-system')).toBeNull()
    expect(requiredTrackChoices(root, 'default')).toEqual(['lite', 'pm', 'frontend', 'backend'])
  })

  it('工作流不存在 → 抛错点名；写坏 → 原样抛出', async () => {
    const root = await isolatedProject()
    expect(() => requiredTrackChoices(root, 'nope')).toThrow("workflow 'nope' 未找到")
    await writeProjectWorkflow(root, 'broken', 'name: broken\nsteps:\n  - id: a\n    label: a\n    gate: bogus\n')
    expect(() => requiredTrackChoices(root, 'broken')).toThrow()
  })
})

describe('listWorkflowTracks', () => {
  it('列出所有可用工作流的全部轨道：default 在最前，写坏的工作流进 skipped 而不挡住其余', async () => {
    const root = await isolatedProject()
    await writeProjectWorkflow(root, 'default', serializeWorkflow(targetDefaultWorkflow()))
    await writeProjectWorkflow(root, 'broken', 'name: broken\nsteps:\n  - id: a\n    label: a\n    gate: bogus\n')
    await writeProjectWorkflow(root, 'mine', 'name: mine\nsteps:\n  - id: only\n    label: Only\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n')
    const listing = listWorkflowTracks(root)
    const ids = listing.entries.map((e) => `${e.workflow}:${e.branch.id}`)
    expect(ids.slice(0, 4)).toEqual(['default:lite', 'default:pm', 'default:frontend', 'default:backend'])
    expect(ids).toEqual(expect.arrayContaining(['design-system:design-system', 'mine:mine']))
    expect(listing.skipped.map((s) => s.workflow)).toEqual(['broken'])
  })
})

describe('loadCompiledWorkflow', () => {
  it('不存在 → null', async () => {
    const root = await isolatedProject()
    expect(loadCompiledWorkflow(root, 'nope')).toBeNull()
  })

  it('default 走 default 专用编译入口（带 phase policy artifact 也能编译）', async () => {
    const root = await isolatedProject()
    expect(Object.keys(loadCompiledWorkflow(root, 'default')?.tracks ?? {})).toEqual(expect.arrayContaining(['pm', 'frontend', 'backend']))
  })

  it('compileLoadedWorkflow：其余工作流走通用入口', () => {
    expect(compileLoadedWorkflow('demo', { name: 'demo', steps: [] }).name).toBe('demo')
  })
})
