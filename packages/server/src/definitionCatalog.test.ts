/**
 * 定义目录里的轨道就是各工作流的 `tracks.<id>` 分支：身份是「工作流 + 轨道 id」，没有独立的登记表，
 * 也不读 `.pipeline/tracks.yaml`；每条分支一条流水线，阶段取自分支自己的步骤。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDefinitionCatalog } from './definitionCatalog.js'
import type { PipelineCliRunner } from './operations.js'
import { captureWorkflowRootAnchor, closeWorkflowRootAnchor, type WorkflowRootAnchor } from './workflows.js'

const HOSTS = ['codex', 'claude', 'cursor', 'gemini', 'copilot', 'pi', 'devin', 'zed', 'aider', 'continue', 'cline', 'amp'] as const
const hostCatalog = {
  schema_version: 'host-target-plan/v1',
  targets: HOSTS.map((id) => ({
    id,
    kind: id === 'codex' || id === 'claude' ? 'native' : 'adapter',
    cli_flag: `--${id}`,
    target_scope: id === 'codex' || id === 'claude' ? 'user' : 'project',
    supported_operations: ['setup', 'update'],
    capabilities: id === 'codex' || id === 'claude'
      ? ['native-marketplace', 'managed-runtime', 'bundled-skills', 'automatic-update']
      : ['project-adapter', 'managed-runtime', 'bundled-skills'],
  })),
}

const STEP = (id: string, label: string, next: string | null): string => [
  `      - id: ${id}`,
  `        label: ${label}`,
  '        gate: null',
  '        skills: []',
  '        inputs: []',
  '        outputs: []',
  '        guards: []',
  next === null ? '        transitions: []' : `        transitions:\n          - event: ${id}-complete\n            to: ${next}`,
].join('\n')

const BRANCHED = `name: lab
tracks:
  fast:
    label: 快
    steps:
${STEP('go', '开工', 'ship')}
${STEP('ship', '交付', null)}
  deep:
    steps:
${STEP('plan', '规划', 'build')}
${STEP('build', '实现', 'check')}
${STEP('check', '检查', null)}
`

const FLAT = `name: solo
steps:
${STEP('only', '唯一', null).replace(/^ {6}/gm, '  ')}
`

describe('buildDefinitionCatalog · 轨道来自工作流分支', () => {
  const anchors: WorkflowRootAnchor[] = []
  const roots: string[] = []
  afterEach(async () => {
    while (anchors.length) closeWorkflowRootAnchor(anchors.pop()!)
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
  })

  async function catalogFor(files: Record<string, string> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'tenon-catalog-branches-'))
    roots.push(root)
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text, 'utf8')
    const anchor = captureWorkflowRootAnchor(root)
    anchors.push(anchor)
    const operationRunner = vi.fn<PipelineCliRunner>().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(hostCatalog), stderr: '' })
    return buildDefinitionCatalog({ anchor, hostHome: root, operationRunner, generatedAt: '2026-10-11T00:00:00.000Z' })
  }

  it('default 的四条轨道：id 是分支 id，身份带着工作流，内建', async () => {
    const catalog = await catalogFor()
    const fromDefault = catalog.tracks.filter((track) => track.default_workflow === 'default')
    expect(fromDefault.map((track) => track.id)).toEqual(['lite', 'pm', 'frontend', 'backend'])
    for (const track of fromDefault) {
      expect(track).toMatchObject({ builtin: true, source: 'builtin', allowed_workflows: ['default'] })
      expect(track.revision).not.toBe('')
    }
    expect(fromDefault.find((track) => track.id === 'lite')?.label).toBe('轻量')
  })

  it('每条分支一条流水线，阶段取自该分支自己的步骤（不是工作流顶层的空 steps）', async () => {
    const catalog = await catalogFor()
    const backend = catalog.pipelines.find((pipeline) => pipeline.id === 'default:backend:main')
    const lite = catalog.pipelines.find((pipeline) => pipeline.id === 'default:lite:main')
    expect(backend?.stage_order.length).toBeGreaterThan(lite?.stage_order.length ?? 99)
    expect(lite?.stage_order).toEqual(['open', 'build', 'verify', 'done', 'escalated'])
    expect(backend?.stages.map((stage) => stage.id)).toEqual(backend?.stage_order)
    expect(catalog.pipelines.filter((pipeline) => pipeline.workflow_id === 'default').map((pipeline) => pipeline.track_id))
      .toEqual(['lite', 'pm', 'frontend', 'backend'])
  })

  it('项目里的分支工作流按各自的分支列出，来源是项目', async () => {
    const catalog = await catalogFor({ '.pipeline/workflows/lab.yaml': BRANCHED })
    const lab = catalog.tracks.filter((track) => track.default_workflow === 'lab')
    expect(lab.map((track) => [track.id, track.label, track.source, track.builtin, track.allowed_workflows])).toEqual([
      ['fast', '快', 'project', false, ['lab']],
      ['deep', 'deep', 'project', false, ['lab']],
    ])
    const fast = catalog.pipelines.find((pipeline) => pipeline.id === 'lab:fast:main')
    const deep = catalog.pipelines.find((pipeline) => pipeline.id === 'lab:deep:main')
    expect(fast).toMatchObject({ workflow_id: 'lab', track_id: 'fast', source: 'project', stage_order: ['go', 'ship'] })
    expect(deep?.stage_order).toEqual(['plan', 'build', 'check'])
    expect(deep?.stages.map((stage) => stage.depends_on)).toEqual([[], ['plan'], ['build']])
  })

  it('平铺工作流只有一条隐式轨道，id 就是工作流名', async () => {
    const catalog = await catalogFor({ '.pipeline/workflows/solo.yaml': FLAT })
    const solo = catalog.tracks.filter((track) => track.default_workflow === 'solo')
    expect(solo.map((track) => track.id)).toEqual(['solo'])
    expect(catalog.pipelines.find((pipeline) => pipeline.id === 'solo:solo:main')?.stage_order).toEqual(['only'])
  })

  it('旧的 .pipeline/tracks.yaml 不再读取：写坏了也照常出目录，里面登记的轨道不出现', async () => {
    const catalog = await catalogFor({ '.pipeline/tracks.yaml': 'version: [broken\ntracks:\n  - id: ghost\n' })
    expect(catalog.tracks.map((track) => track.id)).not.toContain('ghost')
    expect(catalog.tracks.every((track) => track.default_workflow === 'default')).toBe(true)
  })

  it('同名轨道出现在不同工作流里是两条不同的轨道，流水线身份不撞', async () => {
    const same = BRANCHED.replace('name: lab', 'name: other').replace('fast:', 'backend:')
    const catalog = await catalogFor({ '.pipeline/workflows/other.yaml': same })
    const backends = catalog.tracks.filter((track) => track.id === 'backend')
    expect(backends.map((track) => track.default_workflow).sort()).toEqual(['default', 'other'])
    const ids = catalog.pipelines.map((pipeline) => pipeline.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
