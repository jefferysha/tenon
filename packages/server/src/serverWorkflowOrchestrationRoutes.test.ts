/**
 * 编排总览端点：真起 server、真建任务。工作流端点按轨道选分支、带 manifest 叠加；任务端点读任务冻结的计划
 * （项目定义之后被改也不影响）并贴上与 `tenon status` 同一份判定的运行状态。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_WORKFLOW_SOURCE, parseWorkflow, serializeWorkflow, type WorkflowDef } from '@tenon/kernel'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import type { DashboardServer } from './types.js'
import { initChange, makeProject, makeTempHome, newStore, recordWorkflowPhaseSkill, reqGet, testFlow } from './test-support.js'
import { withRunStatus, type ChangeOrchestrationResponse, type DefinitionOrchestrationResponse } from './workflowOrchestration.js'

const open: DashboardServer[] = []
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

async function start(): Promise<{ port: number; root: string; changeDir: string }> {
  const store = newStore()
  const root = await makeProject()
  const changeDir = await initChange(store, root, 'orch', { track: 'frontend' })
  const hostHome = await makeTempHome()
  const srv = createTestDashboardServer({
    version: '9.9.9',
    hostHome,
    paths: resolveServerPaths({ home: hostHome, env: {} }),
    token: 'secret-token-abc',
    registry: () => [root],
    store,
    flow: testFlow(),
    clock: () => '2026-07-07T00:00:00Z',
    pollIntervalMs: 20,
  })
  open.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, changeDir }
}

const skillsOf = (body: { stages: readonly { id: string; entries: readonly { kind: string; id: string; wave: number }[] }[] }, stage: string) =>
  body.stages.find((candidate) => candidate.id === stage)?.entries.filter((entry) => entry.kind === 'skill').map((entry) => [entry.id, entry.wave])

function wavedExplore(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const frontend = def.tracks?.frontend
  if (frontend === undefined) throw new Error('frontend branch missing')
  return {
    ...def,
    tracks: {
      ...def.tracks,
      frontend: {
        ...frontend,
        steps: frontend.steps.map((step) => step.id !== 'explore' ? step : {
          ...step,
          skills: [
            { id: 'openspec-explore' },
            { id: 'brainstorming', depends_on: ['openspec-explore'] },
            { id: 'grilling', depends_on: ['openspec-explore'] },
            { id: 'domain-modeling', depends_on: ['brainstorming', 'grilling'] },
          ],
        }),
      },
    },
  }
}

describe('GET /api/workflows/:name/orchestration', () => {
  it('按轨道选分支：前端 explore 串行 4 步（researcher 执行者占第 0 波）；门禁、回流、流向都在', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows/default/orchestration?root=${encodeURIComponent(h.root)}&track=frontend`)
    expect(r.status).toBe(200)
    const body = r.json<DefinitionOrchestrationResponse>()
    expect(body.workflow).toBe('default')
    expect(body.track).toBe('frontend')
    expect(skillsOf(body, 'explore')).toEqual([['openspec-explore', 1], ['brainstorming', 2], ['grilling', 3], ['domain-modeling', 4]])
    expect(body.stages.find((stage) => stage.id === 'verify')?.gate).toBe('review')
    expect(body.returns).toContainEqual({ from: 'verify', to: 'build', event: 'verify-fail' })
    expect(body.flows.some((flow) => flow.id === 'proposal' && flow.from === 'open')).toBe(true)
    expect(typeof body.overlay).toBe('object')
  })

  it('项目覆盖声明了依赖 → 画成波次', async () => {
    const h = await start()
    await mkdir(join(h.root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'workflows', 'default.yaml'), serializeWorkflow(wavedExplore()), 'utf8')
    const r = await reqGet(h.port, `/api/workflows/default/orchestration?root=${encodeURIComponent(h.root)}&track=frontend`)
    expect(r.status).toBe(200)
    expect(skillsOf(r.json<DefinitionOrchestrationResponse>(), 'explore'))
      .toEqual([['openspec-explore', 1], ['brainstorming', 2], ['grilling', 2], ['domain-modeling', 3]])
  })

  it('无轨道参数取第一条分支；错误用稳定 code', async () => {
    const h = await start()
    const chat = await reqGet(h.port, `/api/workflows/default/orchestration?root=${encodeURIComponent(h.root)}`)
    expect(chat.status).toBe(200)
    expect(chat.json<DefinitionOrchestrationResponse>().track).toBeNull()
    const cases: Array<[string, number, string]> = [
      [`/api/workflows/default/orchestration?root=${encodeURIComponent(h.root)}&track=nope`, 404, 'ORCHESTRATION_TRACK_NOT_FOUND'],
      [`/api/workflows/ghost/orchestration?root=${encodeURIComponent(h.root)}`, 404, 'ORCHESTRATION_WORKFLOW_NOT_FOUND'],
      [`/api/workflows/${encodeURIComponent('a b')}/orchestration?root=${encodeURIComponent(h.root)}`, 400, 'ORCHESTRATION_WORKFLOW_INVALID'],
      [`/api/workflows/default/orchestration?root=${encodeURIComponent('/tmp/not-registered')}`, 404, 'ORCHESTRATION_ROOT_NOT_REGISTERED'],
    ]
    for (const [path, status, code] of cases) {
      const r = await reqGet(h.port, path)
      expect([path, r.status, r.json<{ code: string }>().code]).toEqual([path, status, code])
    }
  })
})

/** 技能页「引用」列的读法：不带 root（全局存储）读工作流列表，再逐个读定义与每条轨道的编排。 */
describe('技能页的引用来源：不带 root 读内建工作流', () => {
  const skillIds = (body: DefinitionOrchestrationResponse): string[] =>
    body.stages.flatMap((stage) => stage.entries.filter((entry) => entry.kind === 'skill').map((entry) => entry.id))

  it('列表不含 default 与 simple（调用方要自己加上），但两者的定义和每条轨道的编排都读得到，带出阶段技能', async () => {
    const h = await start()
    const index = await reqGet(h.port, '/api/workflows')
    expect(index.status).toBe(200)
    const listed = index.json<{ names: string[]; default: { source: string } }>()
    expect(listed.names).not.toContain('default')
    expect(listed.names).not.toContain('simple')
    expect(listed.default).toEqual({ source: 'builtin' })

    const definition = await reqGet(h.port, '/api/workflows/default')
    expect(definition.status).toBe(200)
    const tracks = Object.keys(definition.json<{ tracks?: Record<string, unknown> }>().tracks ?? {})
    expect(tracks).toEqual(expect.arrayContaining(['frontend', 'backend']))
    const used = new Set<string>()
    for (const track of tracks) {
      const branch = await reqGet(h.port, `/api/workflows/default/orchestration?root=&track=${encodeURIComponent(track)}`)
      expect([track, branch.status]).toEqual([track, 200])
      for (const id of skillIds(branch.json<DefinitionOrchestrationResponse>())) used.add(id)
    }
    // 内建 default 的前端分支：立项 openspec-propose、调研 brainstorming、规格 writing-plans。
    const frontend = (await reqGet(h.port, '/api/workflows/default/orchestration?root=&track=frontend')).json<DefinitionOrchestrationResponse>()
    expect(skillsOf(frontend, 'open')?.map(([id]) => id)).toContain('openspec-propose')
    expect(skillsOf(frontend, 'explore')?.map(([id]) => id)).toContain('brainstorming')
    expect(skillsOf(frontend, 'spec')?.map(([id]) => id)).toContain('writing-plans')
    expect([...used]).toEqual(expect.arrayContaining(['openspec-propose', 'brainstorming', 'writing-plans', 'test-driven-development']))

    const simple = await reqGet(h.port, '/api/workflows/simple')
    expect(simple.status).toBe(200)
    expect(simple.json<{ tracks?: unknown }>().tracks).toBeUndefined()
    const simpleBranch = await reqGet(h.port, '/api/workflows/simple/orchestration?root=')
    expect(simpleBranch.status).toBe(200)
    expect(skillsOf(simpleBranch.json<DefinitionOrchestrationResponse>(), 'verify')).toEqual([['verification-before-completion', 0]])
  })
})

describe('GET /api/change/:name/orchestration', () => {
  it('读任务冻结的计划：项目定义之后改了，任务的编排不变；当前阶段带运行状态', async () => {
    const h = await start()
    await mkdir(join(h.root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'workflows', 'default.yaml'), serializeWorkflow(wavedExplore()), 'utf8')
    const r = await reqGet(h.port, `/api/change/orch/orchestration?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<ChangeOrchestrationResponse>()
    expect(body).toMatchObject({ change: 'orch', workflow: 'default', track: 'frontend', current: 'open' })
    expect(skillsOf(body, 'explore')).toEqual([['openspec-explore', 1], ['brainstorming', 2], ['grilling', 3], ['domain-modeling', 4]])
    const openStage = body.stages.find((stage) => stage.id === 'open')
    expect(openStage?.entries.map((entry) => [entry.id, entry.status])).toEqual([['openspec-propose', 'waiting']])
    expect(body.stages.find((stage) => stage.id === 'explore')?.entries.every((entry) => entry.status === 'waiting')).toBe(true)
    expect(Object.keys(body.io)).toContain('explore')
    expect(body.io.explore?.inputs.some((slot) => slot.id === 'proposal')).toBe(true)
  })

  it('调用过的技能在调用之后变为运行中（本步文档未登记）或完成', async () => {
    const h = await start()
    await recordWorkflowPhaseSkill(h.root, h.changeDir, 'openspec-propose')
    const r = await reqGet(h.port, `/api/change/orch/orchestration?root=${encodeURIComponent(h.root)}`)
    const status = r.json<ChangeOrchestrationResponse>().stages.find((stage) => stage.id === 'open')?.entries[0]?.status
    expect(['running', 'done']).toContain(status)
  })

  it('错误用稳定 code', async () => {
    const h = await start()
    const cases: Array<[string, number, string]> = [
      [`/api/change/ghost/orchestration?root=${encodeURIComponent(h.root)}`, 404, 'ORCHESTRATION_CHANGE_NOT_FOUND'],
      ['/api/change/orch/orchestration', 400, 'ORCHESTRATION_ROOT_REQUIRED'],
      [`/api/change/${encodeURIComponent('../x')}/orchestration?root=${encodeURIComponent(h.root)}`, 400, 'ORCHESTRATION_CHANGE_INVALID'],
      [`/api/change/orch/orchestration?root=${encodeURIComponent('/tmp/not-registered')}`, 404, 'ORCHESTRATION_ROOT_NOT_REGISTERED'],
    ]
    for (const [path, status, code] of cases) {
      const r = await reqGet(h.port, path)
      expect([path, r.status, r.json<{ code: string }>().code]).toEqual([path, status, code])
    }
  })
})

describe('withRunStatus', () => {
  const orchestration = {
    stages: [
      { id: 'a', label: 'a', gate: null, entries: [{ kind: 'skill' as const, id: 's', label: 's', wave: 0, dependsOn: [], required: true, source: 'declared' as const }] },
      {
        id: 'b', label: 'b', gate: 'review' as const, entries: [
          { kind: 'skill' as const, id: 's2', label: 's2', wave: 0, dependsOn: [], required: true, source: 'declared' as const },
          { kind: 'test' as const, id: 'unit', label: 'unit', wave: 1, dependsOn: [], required: true, source: 'declared' as const },
          { kind: 'reviewer' as const, id: 'critic', label: 'critic', wave: 2, dependsOn: [], required: true, source: 'declared' as const },
        ],
      },
      { id: 'c', label: 'c', gate: null, entries: [{ kind: 'skill' as const, id: 's3', label: 's3', wave: 0, dependsOn: [], required: true, source: 'declared' as const }] },
    ],
    returns: [],
    flows: [],
  }
  const view = (agent: string, state: 'idle' | 'running' | 'done' | 'stale', result: 'pass' | 'fail' | null) => ({
    agent, role: 'reviewer' as const, required: true, dependsOn: [], readsTests: [], state, result,
    findings: 0, blocking: 0, runId: null, reportPath: null, actor: null, finishedAt: null,
  })
  it('更早阶段完成、更晚阶段等待；当前阶段按事实映射四态', () => {
    const stages = withRunStatus(orchestration, {
      phase: 'b',
      archived: false,
      skills: new Map([['s2', 'running' as const]]),
      agents: [{ stepId: 'b', agents: [view('critic', 'done', 'fail')] }],
      tests: [{ stepId: 'b', items: [{ id: 'unit', direction: 'unit', required: true, status: 'passed' }] }],
    })
    expect(stages.map((stage) => stage.entries.map((entry) => entry.status))).toEqual([['done'], ['running', 'done', 'failed'], ['waiting']])
  })
  it('已归档：当前阶段也算完成；评审者运行中 = running，过期 = waiting', () => {
    const stages = withRunStatus(orchestration, {
      phase: 'b',
      archived: true,
      skills: new Map(),
      agents: [{ stepId: 'b', agents: [view('critic', 'stale', 'pass')] }],
      tests: [{ stepId: 'b', items: [{ id: 'unit', direction: 'unit', required: true, status: 'running' }] }],
    })
    expect(stages[1]?.entries.map((entry) => entry.status)).toEqual(['done', 'running', 'waiting'])
  })
  it('旧测试过期 = stale；策略要求运行的种类节点按该步策略判定里同种类套件的最差状态，没有套件 = 等待', () => {
    const policyEntry = (kind: 'unit' | 'typecheck' | 'lint') => ({
      kind: 'test' as const, id: `kind:${kind}`, label: kind, wave: 1, dependsOn: [], required: true, source: 'declared' as const, testKind: kind,
    })
    const withPolicy = {
      ...orchestration,
      stages: orchestration.stages.map((stage) => stage.id === 'b'
        ? { ...stage, entries: [...stage.entries, policyEntry('unit'), policyEntry('typecheck'), policyEntry('lint')] }
        : stage),
    }
    const suite = (id: string, kind: string, state: 'passed' | 'failed' | 'stale' | 'missing' | 'running') =>
      ({ suite: id, origin: 'catalog' as const, kind, reason: 'run' as const, state })
    const report = {
      stepId: 'b', pass: false, chain: 'intact' as const, policy: null, blockers: [], notices: [], trace: [],
      files: { checked: true, unregistered: [], orphans: [] },
      suites: [suite('a', 'unit', 'passed'), suite('b', 'unit', 'stale'), suite('c', 'typecheck', 'failed')],
    }
    const stages = withRunStatus(withPolicy, {
      phase: 'b', archived: false, skills: new Map(), agents: [],
      tests: [{ stepId: 'b', items: [{ id: 'unit', direction: 'unit', required: true, status: 'stale' }] }],
      policies: [report],
    })
    expect(stages[1]?.entries.filter((entry) => entry.kind === 'test').map((entry) => [entry.id, entry.status])).toEqual([
      ['unit', 'stale'], ['kind:unit', 'stale'], ['kind:typecheck', 'failed'], ['kind:lint', 'waiting'],
    ])
    const none = withRunStatus(withPolicy, { phase: 'b', archived: false, skills: new Map(), agents: [], tests: [] })
    expect(none[1]?.entries.filter((entry) => entry.testKind !== undefined).map((entry) => entry.status)).toEqual(['waiting', 'waiting', 'waiting'])
  })
})
