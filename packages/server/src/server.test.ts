/**
 * server.test —— 真 HTTP 端到端（GOAL C9）：真起 http server（listen(0) 随机端口）、
 * node:http 真发请求、断言真实响应与真实落盘副作用。零 mock。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import type { DashboardServer, DashboardServerOptions, ServerPaths } from './types.js'
import {
  initChange, makeProject, makeTempHome, makeTempManifest, makeWorktreeDir, newStore, openSSE, repoManifestPath, reqDelete, reqGet,
  reqPatch, reqPost, testFlow,
  readGovernedDocumentsForCurrentVisit,
  recordWorkflowPhaseSkill,
  seedGovernedDocumentEvidence,
} from './test-support.js'
import type { FlowEngine, StateStore } from '@tenon/kernel'
import {
  builtinTrack, createLoopLedgerStore, effectiveWorkflowPlanBinding, loadEffectiveWorkflowPlan, loadManifest,
  createTransitionRecordStore, createWorkflowRunRepository,
  DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
  machineStateScopeId,
  registerProjectRoot, TRANSITION_EVENTS as KERNEL_EVENTS, eventEdge as kernelEventEdge,
  workflowPlanSnapshot,
} from '@tenon/kernel'
import { TRANSITION_EVENTS, eventEdge } from './transition.js'
import type { LoopActivationValidator } from './loops.js'
import type { PipelineCliRunner } from './operations.js'
import type { RouterPatternScorer } from './routerPreview.js'
import type { CadenceSchedulerOptions } from './cadence.js'

/** 接线级：server 真消费 kernel 单一真相源（BACKLOG #25b / GOAL B2）——transition.ts 已删本地镜像，
 * TRANSITION_EVENTS/eventEdge 只是 kernel 的 re-export（引用同一对象=同一真相源）。 */
describe('接线 —— server 事件表 = kernel 单源（无本地镜像）', () => {
  it('TRANSITION_EVENTS 就是 kernel 的（引用同一对象）', () => {
    expect(TRANSITION_EVENTS).toBe(KERNEL_EVENTS)
  })
  it('eventEdge 就是 kernel eventEdge（同一函数）', () => {
    expect(eventEdge).toBe(kernelEventEdge)
  })
})

// @ts-expect-error 产品状态路径是必填依赖；其他可选字段不能让无 paths 的调用重新通过编译。
const missingPathsOptions: DashboardServerOptions = {}
void missingPathsOptions

const openServers: DashboardServer[] = []
afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close()
})

interface Harness {
  srv: DashboardServer
  port: number
  token: string
  root: string
  store: StateStore
  name: string
  /** openspec/changes/<name> 绝对路径（afk cancel 等按 changeDir 读写 automation_* 字段的测试用）。 */
  changeDir: string
  /** 真实存在的临时目录，代表本 change 的 automation worktree 根（afk cancel 落标记文件测试用）。 */
  worktreeDir: string
  manifestPath?: string
}

async function start(opts?: {
  version?: string
  releaseId?: string
  transactionId?: string
  hostHome?: string
  paths?: ServerPaths
  token?: string
  pollIntervalMs?: number
  execDocker?: import('./dockerImages.js').ExecDockerFn
  manifestPath?: string
  flow?: FlowEngine
  store?: StateStore
  validateLoopActivation?: LoopActivationValidator
  runPipelineCli?: PipelineCliRunner
  scoreRouterPattern?: RouterPatternScorer
  clock?: () => string
  cadence?: false | Omit<CadenceSchedulerOptions, 'roots' | 'clock' | 'runPipelineCli'>
  legacyWithoutRunIdentity?: boolean
  initialWorkflow?: { workflow: string; phase: string }
  seedGovernedEvidence?: boolean
  seedPhaseSkill?: boolean
}): Promise<Harness> {
  const store = opts?.store ?? newStore()
  const root = await makeProject()
  const name = 'my-change'
  const changeDir = await initChange(store, root, name, {
    legacyWithoutRunIdentity: opts?.legacyWithoutRunIdentity,
    initialWorkflow: opts?.initialWorkflow,
  })
  if (opts?.seedGovernedEvidence !== false) {
    await seedGovernedDocumentEvidence(root, changeDir, name)
    if (opts?.seedPhaseSkill === true) await recordWorkflowPhaseSkill(root, changeDir)
  }
  const worktreeDir = await makeWorktreeDir()
  const hostHome = opts?.hostHome ?? await makeTempHome()
  const paths = opts?.paths ?? resolveServerPaths({ home: hostHome, env: {} })
  const srv = createDashboardServer({
    version: opts?.version ?? '9.9.9',
    releaseId: opts?.releaseId,
    transactionId: opts?.transactionId,
    hostHome,
    paths,
    token: opts?.token ?? 'secret-token-abc',
    registry: () => [root],
    store,
    flow: opts?.flow ?? testFlow(),
    clock: opts?.clock ?? (() => '2026-07-07T00:00:00Z'),
    pollIntervalMs: opts?.pollIntervalMs ?? 20,
    manifestPath: opts?.manifestPath,
    execDocker: opts?.execDocker,
    validateLoopActivation: opts?.validateLoopActivation,
    runPipelineCli: opts?.runPipelineCli,
    scoreRouterPattern: opts?.scoreRouterPattern,
    cadence: opts?.cadence,
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return {
    srv, port, token: srv.token, root, store, name,
    changeDir: join(root, 'openspec', 'changes', name),
    worktreeDir,
    manifestPath: opts?.manifestPath,
  }
}

/** 同 start()，但额外真拷贝仓库 manifest.yaml 到临时文件并注入，供 config 端点测试使用。 */
async function startWithConfig(opts?: { version?: string; token?: string }): Promise<Harness & { manifestPath: string }> {
  const manifestPath = await makeTempManifest()
  const h = await start({ ...opts, manifestPath })
  return { ...h, manifestPath }
}

describe('GET /api/health —— 存活探针 + 本 server 版本（B4）', () => {
  it('managed start 回显 transaction identity，普通 start 不伪造 ownership', async () => {
    const managed = await start({ transactionId: 'transaction-health-test' })
    const managedBody = JSON.parse((await reqGet(managed.port, '/api/health')).body) as {
      transactionId?: string
    }
    expect(managedBody.transactionId).toBe('transaction-health-test')

    const ordinary = await start()
    const ordinaryBody = JSON.parse((await reqGet(ordinary.port, '/api/health')).body) as {
      transactionId?: string
    }
    expect(ordinaryBody.transactionId).toBeUndefined()
  })

  it('回显 ok/scope/version/releaseId/stateScopeId 且不泄露 state home', async () => {
    const releaseId = `sha256-${'a'.repeat(64)}`
    const stateHome = '/tmp/private-dashboard-state-home'
    const paths = resolveServerPaths({ home: stateHome, env: {} })
    const h = await start({ version: '3.1.4', releaseId, hostHome: stateHome, paths })
    const r = await reqGet(h.port, '/api/health')
    expect(r.status).toBe(200)
    const body = r.json<{
      ok: boolean
      scope: string
      version: string
      releaseId?: string
      stateScopeId?: string
    }>()
    expect(body.ok).toBe(true)
    expect(body.scope).toBe('global')
    expect(body.version).toBe('3.1.4')
    expect(body.releaseId).toBe(releaseId)
    expect(body.stateScopeId).toBe(machineStateScopeId(paths.stateRoot))
    expect(JSON.stringify(body)).not.toContain(stateHome)
  })
})

describe('GET /api/context-bundle/preview —— ledger-bound 只读预算预览', () => {
  const previewPath = (
    root: string,
    change = 'my-change',
    target = 'explore',
    budgetBytes = '120000',
  ): string =>
    `/api/context-bundle/preview?root=${encodeURIComponent(root)}&change=${encodeURIComponent(change)}`
    + `&target=${encodeURIComponent(target)}&budgetBytes=${encodeURIComponent(budgetBytes)}`

  it.runIf(process.platform === 'linux')('以真 Change/ledger 返回安全 metadata，并把无 required reads 的 open 明确投影为空态', async () => {
    const h = await start()
    const ledgerPath = join(h.changeDir, '.pipeline-documents.json')
    const stateBefore = await h.store.read(h.changeDir)
    const ledgerBefore = await readFile(ledgerPath, 'utf8')

    const success = await reqGet(h.port, previewPath(h.root))
    expect(success.status).toBe(200)
    const body = success.json<{
      ok: true
      preview: {
        schemaVersion: string
        sideEffects: string
        change: string
        from: string
        to: string
        tier: string
        documentCount: number
        aggregateDigest: string
        budget: { maxBytes: number; usedBytes: number; fits: boolean }
        inputs: Array<{
          kind: string
          path: string
          digest: string
          reason: string
          reasonCode: string
          mode: string
          sourceBytes: number
          materializedBytes: number
        }>
      }
    }>()
    expect(body.ok).toBe(true)
    expect(body.preview).toMatchObject({
      schemaVersion: 'context-bundle-preview/v1',
      sideEffects: 'none',
      change: h.name,
      from: 'open',
      to: 'explore',
      tier: 'strong',
      documentCount: 3,
      budget: { maxBytes: 120000, fits: true },
    })
    expect(body.preview.inputs.map((input) => input.kind)).toEqual([
      'proposal', 'openspec-design', 'tasks',
    ])
    expect(body.preview.inputs.every((input) =>
      input.path.startsWith('openspec/changes/my-change/')
      && input.digest.startsWith('sha256:')
      && input.reason.length > 0
      && input.reasonCode === `context-bundle.reason.${input.kind}`
      && input.sourceBytes > 0
      && input.materializedBytes >= 0)).toBe(true)
    expect(body.preview.aggregateDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(body)).not.toContain('"content"')
    expect(JSON.stringify(body)).not.toContain('# proposal')

    const empty = await reqGet(h.port, previewPath(h.root, h.name, 'open'))
    expect(empty.status).toBe(200)
    expect(empty.json()).toMatchObject({
      ok: true,
      preview: {
        schemaVersion: 'context-bundle-preview/v1',
        sideEffects: 'none',
        documentCount: 0,
        inputs: [],
        budget: { maxBytes: 120000, usedBytes: 0, fits: true },
      },
    })

    expect(await h.store.read(h.changeDir)).toEqual(stateBefore)
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore)
  })

  it.runIf(process.platform === 'linux')('API 与 CLI 一样保留合法 UTF-8 BOM，不误报 stale 或少算 source bytes', async () => {
    const h = await start()
    const proposalPath = join(h.changeDir, 'proposal.md')
    const content = `\uFEFF${await readFile(proposalPath, 'utf8')}`
    await writeFile(proposalPath, content, 'utf8')
    const ledgerPath = join(h.changeDir, '.pipeline-documents.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      records: Array<{ kind: string; sha256: string }>
    }
    const proposal = ledger.records.find((record) => record.kind === 'proposal')
    if (!proposal) throw new Error('proposal record missing from fixture')
    proposal.sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    const response = await reqGet(h.port, previewPath(h.root))
    expect(response.status).toBe(200)
    const proposalInput = response.json<{
      preview: { inputs: Array<{ kind: string; sourceBytes: number }> }
    }>().preview.inputs.find((input) => input.kind === 'proposal')
    expect(proposalInput?.sourceBytes).toBe(Buffer.byteLength(content, 'utf8'))
  })

  it('在读取前拒绝非法请求和未注册 root，返回稳定机器码', async () => {
    const h = await start()
    const unknownRoot = await makeProject()
    const invalidPaths = [
      '/api/context-bundle/preview',
      previewPath(h.root, '../escape'),
      previewPath(h.root, h.name, 'not-a-canonical-phase'),
      previewPath(h.root, h.name, 'explore', '0'),
      previewPath(h.root, h.name, 'explore', '1.5'),
      previewPath(h.root, h.name, 'explore', String(Number.MAX_SAFE_INTEGER + 1)),
    ]
    for (const path of invalidPaths) {
      const response = await reqGet(h.port, path)
      expect(response.status, path).toBe(400)
      expect(response.json(), path).toMatchObject({
        ok: false,
        code: 'CONTEXT_BUNDLE_INVALID_REQUEST',
      })
    }

    const unregistered = await reqGet(h.port, previewPath(unknownRoot))
    expect(unregistered.status).toBe(404)
    expect(unregistered.json()).toMatchObject({ ok: false })
  })

  it.runIf(process.platform !== 'linux')('无 fd-relative traversal 时在读取 Change 内容前返回安全 capability error', async () => {
    const h = await start()
    const response = await reqGet(h.port, previewPath(h.root))
    expect(response.status).toBe(501)
    expect(response.json()).toEqual({
      ok: false,
      code: 'CONTEXT_BUNDLE_TRUSTED_READER_UNAVAILABLE',
      error: 'Context Bundle trusted reader is unavailable on this platform',
      repairAction: 'Run the Dashboard on a platform with fd-relative directory traversal.',
    })
    expect(JSON.stringify(response.json())).not.toContain(h.root)
  })

  it.runIf(process.platform === 'linux')('canonical state 损坏返回安全 409 机器码且不继续读取 ledger', async () => {
    const h = await start()
    await writeFile(join(h.changeDir, '.pipeline-run', 'current.json'), Buffer.from([0xff]))
    await unlink(join(h.changeDir, '.pipeline-documents.json'))

    const response = await reqGet(h.port, previewPath(h.root))
    expect(response.status).toBe(409)
    expect(response.json()).toEqual({
      ok: false,
      code: 'CONTEXT_BUNDLE_STATE_CORRUPT',
      error: 'Context Bundle canonical state is corrupt',
      repairAction: 'Restore a valid canonical Change state, then retry.',
      detail: {},
    })
    expect(JSON.stringify(response.json())).not.toContain(h.root)
  })

  it.runIf(process.platform === 'linux')('连续两次 set 后 head record 缺失仍返回 409，且不读取 ledger', async () => {
    const h = await start()
    const repo = createWorkflowRunRepository({
      store: h.store,
      recordStore: createTransitionRecordStore(),
      clock: () => '2026-07-28T00:00:00Z',
      newId: () => 'context-head-after-two-sets',
    })
    await repo.transact(h.changeDir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await h.store.set(h.changeDir, 'scope', 'first-set')
    await h.store.set(h.changeDir, 'assignee', 'second-set')
    await unlink(join(
      h.changeDir,
      '.pipeline-transitions',
      '000001-context-head-after-two-sets.json',
    ))
    await unlink(join(h.changeDir, '.pipeline-documents.json'))

    const response = await reqGet(h.port, previewPath(h.root))
    expect(response.status).toBe(409)
    expect(response.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_STATE_CORRUPT',
    })
  })

  it.runIf(process.platform === 'linux')('把 missing/stale 映射为 409，并给出可执行恢复动作而不返回部分预览', async () => {
    const missingLedger = await start({ seedGovernedEvidence: false })
    await unlink(join(missingLedger.changeDir, '.pipeline-documents.json'))
    const noLedger = await reqGet(missingLedger.port, previewPath(missingLedger.root))
    expect(noLedger.status).toBe(409)
    expect(noLedger.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_LEDGER_MISSING',
    })
    expect(noLedger.json<{ repairAction?: string }>().repairAction).toBeTruthy()

    const missingDocument = await start()
    await unlink(join(missingDocument.changeDir, 'proposal.md'))
    const noDocument = await reqGet(missingDocument.port, previewPath(missingDocument.root))
    expect(noDocument.status).toBe(409)
    expect(noDocument.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_DOCUMENT_MISSING',
    })
    expect(noDocument.json<{ repairAction?: string }>().repairAction).toBeTruthy()
    expect(noDocument.json()).not.toHaveProperty('preview')

    const staleDocument = await start()
    await writeFile(join(staleDocument.changeDir, 'proposal.md'), '# drifted proposal\n', 'utf8')
    const stale = await reqGet(staleDocument.port, previewPath(staleDocument.root))
    expect(stale.status).toBe(409)
    expect(stale.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_DOCUMENT_STALE',
    })
    expect(stale.json<{ repairAction?: string }>().repairAction).toBeTruthy()
    expect(stale.json()).not.toHaveProperty('preview')

    const linkedDocument = await start()
    const linkedProposal = join(linkedDocument.changeDir, 'proposal.md')
    const outsideDir = await makeProject()
    const outsideProposal = join(outsideDir, 'proposal.md')
    await writeFile(outsideProposal, await readFile(linkedProposal, 'utf8'), 'utf8')
    await unlink(linkedProposal)
    await symlink(outsideProposal, linkedProposal, 'file')
    const linked = await reqGet(linkedDocument.port, previewPath(linkedDocument.root))
    expect(linked.status).toBe(409)
    expect(linked.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_DOCUMENT_MISSING',
    })
    expect(JSON.stringify(linked.json())).not.toContain('# proposal')
  })

  it.runIf(process.platform === 'linux')('非法持久化 ledger path 映射为 409 且安全日志不泄露 path/root', async () => {
    const h = await start()
    const ledgerPath = join(h.changeDir, '.pipeline-documents.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      records: Array<{ path: string }>
    }
    const hostilePath = `/Users/private/${'hostile-ledger-value'}`
    if (!ledger.records[0]) throw new Error('ledger fixture has no records')
    ledger.records[0].path = hostilePath
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    await unlink(join(h.changeDir, 'proposal.md'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const response = await reqGet(h.port, previewPath(h.root))

    expect(response.status).toBe(409)
    expect(response.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_LEDGER_MISSING',
    })
    const logged = stderr.mock.calls.map((call) => String(call[0])).join('')
    expect(logged).toContain('CONTEXT_BUNDLE_LEDGER_MISSING cause')
    expect(logged).not.toContain(hostilePath)
    expect(logged).not.toContain(h.root)
    expect(response.json()).not.toHaveProperty('preview')
  })

  it.runIf(process.platform === 'linux')('预算不足返回 422 safe preview，但不返回正文或有效 aggregate digest', async () => {
    const h = await start()
    const response = await reqGet(h.port, previewPath(h.root, h.name, 'explore', '1'))
    expect(response.status).toBe(422)
    const body = response.json<{
      ok: false
      code: string
      repairAction?: string
      preview: {
        aggregateDigest?: string
        documentCount: number
        inputs: Array<Record<string, unknown>>
        budget: { maxBytes: number; usedBytes: number; fits: boolean }
      }
    }>()
    expect(body).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
      preview: {
        documentCount: 3,
        budget: { maxBytes: 1, fits: false },
      },
    })
    expect(body.preview.budget.usedBytes).toBeGreaterThan(1)
    expect(body.preview.aggregateDigest).toBeUndefined()
    expect(body.repairAction).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain('"content"')
    expect(JSON.stringify(body)).not.toContain('# proposal')
  })

  it.runIf(process.platform === 'linux')('低预算也会在读取超大源文档前返回 413，且响应不泄露绝对路径', async () => {
    const h = await start()
    const proposalPath = join(h.changeDir, 'proposal.md')
    const content = 'x'.repeat(
      DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument + 1,
    )
    await writeFile(proposalPath, content, 'utf8')
    const ledgerPath = join(h.changeDir, '.pipeline-documents.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      records: Array<{ kind: string; sha256: string }>
    }
    const proposal = ledger.records.find((record) => record.kind === 'proposal')
    if (!proposal) throw new Error('proposal record missing from fixture')
    proposal.sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    const response = await reqGet(h.port, previewPath(h.root, h.name, 'explore', '1'))
    expect(response.status).toBe(413)
    expect(response.json()).toMatchObject({
      ok: false,
      code: 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
      detail: {
        metric: 'sourceBytesPerDocument',
        limit: DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument,
        actual: content.length,
        path: `openspec/changes/${h.name}/proposal.md`,
      },
    })
    expect(response.json()).not.toHaveProperty('preview')
    expect(JSON.stringify(response.json())).not.toContain(h.root)
  })

  it('注册 root inode 被换位后 fail closed，绝不读取替换目录', async () => {
    const h = await start()
    const parked = `${h.root}.context-bundle-registered-inode`
    const outside = await makeProject()
    await rename(h.root, parked)
    await symlink(outside, h.root, 'dir')

    const response = await reqGet(h.port, previewPath(h.root))
    expect(response.status).toBe(403)
    expect(response.json()).toMatchObject({ ok: false })
  })

  it.runIf(process.platform === 'linux')('Change 目录被换为 symlink 时按 root guard fail closed', async () => {
    const h = await start()
    const parked = `${h.changeDir}.registered-inode`
    const outside = await makeProject()
    await rename(h.changeDir, parked)
    await symlink(outside, h.changeDir, 'dir')

    const response = await reqGet(h.port, previewPath(h.root))
    expect(response.status).toBe(403)
    expect(response.json()).toMatchObject({ ok: false })
  })
})

describe('GET /api/cadence/status —— 生产时钟调度状态', () => {
  it('启用 cadence 后 listen 即启动调度，端点返回真实 loop run 结果', async () => {
    const runPipelineCli = vi.fn<PipelineCliRunner>(async () => ({ exitCode: 0, stdout: '{"selected":1}', stderr: '' }))
    const h = await start({
      runPipelineCli,
      cadence: {
        pollIntervalMs: 60_000,
        loadRegistry: () => ({ data: {
          version: 1,
          loops: [{
            id: 'clock-loop', name: 'Clock Loop', kind: 'orchestrator',
            goal: 'Run a Codex-first workflow from the real dashboard clock', cadence: '1h', risk: 'low',
            runner: 'codex', change_prefix: 'clock-', phases: ['proposal'], human_gates: ['review'],
            design_doc: 'docs/clock.md', status: 'active',
            budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip-run' },
            kill_criteria: ['stop on verification failure'], autonomy_level: 'L1', allowlist: [], denylist: [],
          }],
        }, errors: [] }),
        readLedger: async () => ({ records: [], rejected: [] }),
      },
    })

    await vi.waitFor(() => expect(runPipelineCli).toHaveBeenCalledWith(h.root, ['loops', 'run', 'clock-loop', '--json']))
    const response = await reqGet(h.port, `/api/cadence/status?root=${encodeURIComponent(h.root)}`)
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      enabled: true,
      loops: [{ root: h.root, loop_id: 'clock-loop', runner: 'codex', state: 'succeeded', exit_code: 0 }],
    })
  })
})

describe('POST /api/router/preview —— 公共 Track Router 真决策预览', () => {
  it('按 effective registry 保序返回 score/priority/order，winner 使用 hook 同款平手规则', async () => {
    const score = vi.fn<RouterPatternScorer>(async (pattern) => {
      if (pattern.includes('UI')) return 2
      if (pattern.includes('backend')) return 2
      return 0
    })
    const h = await start({ scoreRouterPattern: score })
    const response = await reqPost(h.port, '/api/router/preview', {
      root: h.root,
      prompt: 'build the UI and backend',
    }, { headers: { Authorization: `Bearer ${h.token}` } })

    expect(response.status).toBe(200)
    const body = response.json<{
      winner: { track: { id: string }; score: number; priority: number; order: number } | null
      candidates: Array<{ track: { id: string }; score: number; routable: boolean; order: number }>
      suppressed_reason: string | null
    }>()
    expect(body.suppressed_reason).toBeNull()
    expect(body.winner).toMatchObject({ track: { id: 'frontend' }, score: 2, priority: 300, order: 3 })
    expect(body.candidates.map((candidate) => candidate.track.id)).toEqual(['chat', 'simple', 'pm', 'frontend', 'backend', 'free'])
    expect(body.candidates[0]).toMatchObject({ score: 0, routable: false, order: 0 })
    expect(score).toHaveBeenCalledTimes(5)
  })

  it('讨论型 prompt 返回 suppression；空 prompt/root 未注册在执行 scorer 前拒绝', async () => {
    const score = vi.fn<RouterPatternScorer>(async () => 1)
    const h = await start({ scoreRouterPattern: score })
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    const suppressed = await reqPost(h.port, '/api/router/preview', {
      root: h.root,
      prompt: '为什么 UI 会失败',
    }, auth)
    expect(suppressed.status).toBe(200)
    expect(suppressed.json<{ winner: unknown; suppressed_reason: string }>()).toMatchObject({
      winner: null,
      suppressed_reason: 'discussion',
    })

    const empty = await reqPost(h.port, '/api/router/preview', { root: h.root, prompt: '' }, auth)
    expect(empty.status).toBe(400)
    const outsider = await makeProject()
    const unknownRoot = await reqPost(h.port, '/api/router/preview', { root: outsider, prompt: 'backend' }, auth)
    expect(unknownRoot.status).toBe(404)
    expect(score).toHaveBeenCalledTimes(4)
  })

  it('draft_track 仅在本次预览追加 custom 候选，生产 scorer 看见未保存 pattern', async () => {
    const score = vi.fn<RouterPatternScorer>(async (pattern) => pattern === 'draft-only' ? 5 : 0)
    const h = await start({ scoreRouterPattern: score })
    const response = await reqPost(h.port, '/api/router/preview', {
      root: h.root,
      prompt: 'representative intent',
      draft_track: {
        id: 'release', label: 'Release', builtin: false,
        workflow: { default: 'default', allowed: '*' },
        policyProfile: {
          reviewSeed: 'pending', automationEligible: true, coverageProfile: 'backend',
          routing: { enabled: true, pattern: 'draft-only', priority: 999 },
          skills: { matrix: true, profile: 'backend' },
        },
      },
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(response.status).toBe(200)
    expect(response.json<{ winner: { track: { id: string } }; candidates: Array<{ track: { id: string } }> }>()).toMatchObject({
      winner: { track: { id: 'release' } },
      candidates: [{ track: { id: 'chat' } }, { track: { id: 'simple' } }, { track: { id: 'pm' } }, { track: { id: 'frontend' } }, { track: { id: 'backend' } }, { track: { id: 'free' } }, { track: { id: 'release' } }],
    })
    expect(score).toHaveBeenCalledWith('draft-only', 'representative intent')
  })
})

describe('H11-H14 Operations HTTP：复用真实 CLI argv/exit code，不复制执行器', () => {
  it('GET starters 返回 kernel 七模板；snapshot 声明 operations 真接线', async () => {
    const h = await start({ runPipelineCli: vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '' })) })
    const starters = await reqGet(h.port, `/api/operations/starters?root=${encodeURIComponent(h.root)}`)
    expect(starters.status).toBe(200)
    const body = starters.json<{ templates: Array<{ id: string; recommendedSkills: string[] }> }>()
    expect(body.templates).toHaveLength(7)
    expect(body.templates.map((item) => item.id)).toContain('ci-sweeper')
    expect(body.templates.find((item) => item.id === 'ci-sweeper')?.recommendedSkills).toContain('ci-triage')
    const snapshot = (await reqGet(h.port, '/api/snapshot')).json<{ capabilities: Record<string, boolean> }>()
    expect(snapshot.capabilities.operations).toBe(true)
  })

  it('starter init 与 artifact register 逐项映射到 built CLI，返回真实 exit/stdout/stderr', async () => {
    const run = vi.fn<PipelineCliRunner>(async (_root, args) => ({
      exitCode: args[0] === 'artifact' ? 1 : 0,
      stdout: args[0] === 'artifact' ? '' : '{"ok":true,"id":"ci-nightly"}',
      stderr: args[0] === 'artifact' ? 'producer denied' : '',
    }))
    const h = await start({ runPipelineCli: run })
    const headers = { Authorization: `Bearer ${h.token}` }
    const init = await reqPost(h.port, '/api/operations/loops/init', {
      root: h.root, id: 'ci-nightly', template: 'ci-sweeper', workflow: 'default',
      skill_bundle: 'backend', runner: 'codex', goal: 'Keep CI green every night',
    }, { headers })
    expect(init.status).toBe(200)
    expect(run).toHaveBeenNthCalledWith(1, h.root, [
      'loops', 'init', '--id', 'ci-nightly', '--template', 'ci-sweeper', '--workflow', 'default',
      '--skill-bundle', 'backend', '--runner', 'codex', '--goal', 'Keep CI green every night', '--yes', '--json',
    ])
    expect(init.json<{ result: unknown }>().result).toEqual({ ok: true, id: 'ci-nightly' })

    const artifact = await reqPost(h.port, '/api/operations/artifact/register', {
      root: h.root, change: h.name, field: 'test_report', path: 'reports/test.json', producer: 'test-runner',
    }, { headers })
    expect(artifact.status).toBe(400)
    expect(run).toHaveBeenNthCalledWith(2, h.root, [
      'artifact', 'register', h.name, 'test_report', 'reports/test.json', '--producer', 'test-runner',
    ])
    expect(artifact.json<{ exit_code: number; stderr: string }>()).toMatchObject({ exit_code: 1, stderr: 'producer denied' })
  })

  it('run/sync/triage 显式安全闸：dry-run 默认；L3/apply 需确认；CLI 非零 exit 原样决定 HTTP', async () => {
    const run = vi.fn<PipelineCliRunner>(async (_root, args) => ({
      exitCode: args[0] === 'triage' ? 3 : 0,
      stdout: JSON.stringify({ command: args.join(' ') }),
      stderr: args[0] === 'triage' ? 'checkpoint conflict' : '',
    }))
    const h = await start({ runPipelineCli: run })
    const headers = { Authorization: `Bearer ${h.token}` }

    const deniedL3 = await reqPost(h.port, '/api/operations/loops/run', {
      root: h.root, selector: 'ci-*', dry_run: false, level: 'L3', commit: true,
    }, { headers })
    expect(deniedL3.status).toBe(400)
    expect(run).not.toHaveBeenCalled()

    const preview = await reqPost(h.port, '/api/operations/loops/run', {
      root: h.root, selector: 'ci-*', dry_run: true, level: 'L2', commit: false,
    }, { headers })
    expect(preview.status).toBe(200)
    expect(run).toHaveBeenNthCalledWith(1, h.root, ['loops', 'run', 'ci-*', '--dry-run', '--level', 'L2', '--json'])

    const deniedApply = await reqPost(h.port, '/api/operations/loops/sync', {
      root: h.root, loop_id: 'ci-loop', mode: 'apply',
    }, { headers })
    expect(deniedApply.status).toBe(400)

    const apply = await reqPost(h.port, '/api/operations/loops/sync', {
      root: h.root, loop_id: 'ci-loop', mode: 'apply', confirm_apply: true,
      expected_registry_sha: 'r1', expected_workflow_sha: 'w1',
    }, { headers })
    expect(apply.status).toBe(200)
    expect(run).toHaveBeenNthCalledWith(2, h.root, [
      'loops', 'sync', 'ci-loop', '--apply', '--expected-registry-sha', 'r1',
      '--expected-workflow-sha', 'w1', '--json',
    ])

    const triage = await reqPost(h.port, '/api/operations/triage', {
      root: h.root, source: 'git-commits', model: 'gpt-5.4', page_size: 5, max_pages: 2,
      max_high_candidates: 3, confirm_apply: true,
    }, { headers })
    expect(triage.status).toBe(409)
    expect(run).toHaveBeenNthCalledWith(3, h.root, [
      'triage', 'git-commits', '--provider', 'codex', '--model', 'gpt-5.4', '--page-size', '5',
      '--max-pages', '2', '--max-high-candidates', '3', '--json',
    ])
    expect(triage.json<{ exit_code: number }>().exit_code).toBe(3)
  })

  it('未知 root 在执行 CLI 前被注册表信任锚拒绝', async () => {
    const run = vi.fn<PipelineCliRunner>(async () => ({ exitCode: 0, stdout: '{}', stderr: '' }))
    const h = await start({ runPipelineCli: run })
    const response = await reqPost(h.port, '/api/operations/loops/run', {
      root: '/tmp/not-registered', selector: '*', dry_run: true, level: 'L1',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(response.status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('G1 projection 运维 HTTP：显式选择 canonical repair / legacy import', () => {
  it('run-detail 同时给 projection health；repair-projection 走真实 StateStore 后回读', async () => {
    const h = await start()
    const before = await reqGet(h.port, `/api/change/${h.name}/run-detail?root=${encodeURIComponent(h.root)}`)
    expect(before.status).toBe(200)
    expect(before.json<{ projection: { status: string } }>().projection.status).toMatch(/current|updated|clean|healthy/)

    const repaired = await reqPost(h.port, `/api/change/${h.name}/projection`, {
      root: h.root, action: 'repair-projection', force_canonical: false,
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(repaired.status).toBe(200)
    expect(repaired.json<{ ok: boolean; projection: { status: string } }>().ok).toBe(true)
  })

  it('import-legacy 没有 confirm_import 时零写拒绝；非法 change/root 同样 fail-closed', async () => {
    const h = await start()
    const denied = await reqPost(h.port, `/api/change/${h.name}/projection`, {
      root: h.root, action: 'import-legacy',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(denied.status).toBe(400)
    expect(denied.body).toContain('confirm_import')

    const badRoot = await reqPost(h.port, `/api/change/${h.name}/projection`, {
      root: '/tmp/not-registered', action: 'repair-projection',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(badRoot.status).toBe(404)
  })
})

describe('GET /api/snapshot —— 聚合注册 Project 的真 .pipeline.yaml', () => {
  it('含真 change（phase=open）+ 计数 + 能力声明', async () => {
    const h = await start()
    const r = await reqGet(h.port, '/api/snapshot')
    expect(r.status).toBe(200)
    const s = r.json<any>()
    expect(s.version).toBe('9.9.9')
    expect(s.project_count).toBe(1)
    expect(s.change_count).toBe(1)
    const proj = s.projects[0]
    expect(proj.root).toBe(h.root)
    expect(proj.changes[0].name).toBe('my-change')
    expect(proj.changes[0].phase).toBe('open')
    expect(proj.changes[0].track).toBe('backend')
    expect(s.capabilities.transition).toBe(true)
    expect(s.capabilities.stream).toBe(true)
  })

  it('聚合多个注册 Project（真两根、各自 change）', async () => {
    const store = newStore()
    const a = await makeProject()
    const b = await makeProject()
    await initChange(store, a, 'alpha')
    await initChange(store, b, 'beta')
    const srv = createDashboardServer({
      paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
      version: '9.9.9', token: 't', registry: () => [a, b], store, flow: testFlow(),
    })
    openServers.push(srv)
    const { port } = await srv.listen(0, '127.0.0.1')
    const s = (await reqGet(port, '/api/snapshot')).json<any>()
    expect(s.project_count).toBe(2)
    expect(s.change_count).toBe(2)
    const names = s.projects.flatMap((p: any) => p.changes.map((c: any) => c.name)).sort()
    expect(names).toEqual(['alpha', 'beta'])
  })
})

describe('GET /api/change/:name/run-detail —— canonical Run + ledger 审计真相源', () => {
  it('返回 revision/TransitionRecord 因果链，并关联 provider usage + structured verification terminal', async () => {
    const h = await start({ seedPhaseSkill: true })
    const advanced = await reqPost(h.port, `/api/change/${h.name}/transition`, {
      root: h.root,
      event: 'open-complete',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(advanced.status).toBe(200)

    const state = await h.store.read(h.changeDir)
    const runId = state.runMetadata?.runId
    expect(runId).toEqual(expect.any(String))

    const ledger = createLoopLedgerStore()
    await ledger.append(h.root, {
      schema_version: 1,
      record_id: 'reservation-record-1',
      recorded_at: '2026-07-07T00:00:00.000Z',
      kind: 'budget-reservation',
      reservation_id: 'reservation-1',
      attempt_id: 'attempt-1',
      iteration_id: 'iteration-attempt-1',
      loop_id: 'loop-1',
      change: h.name,
      budget_day: '2026-07-07',
      reserved_runs: 1,
      reserved_tokens: 2000,
      token_basis: 'risk-default',
      limits_snapshot: {
        max_runs_per_day: 4,
        max_in_flight: 1,
        max_tokens_per_day: 10000,
        on_exceed: 'pause-loop',
      },
      attempt_context: {
        source_run_record_ids: ['run-record-prev-1', 'run-record-prev-2', 'run-record-prev-3'],
        omitted_attempt_ids: ['attempt-old-1'],
        rendered: 'attempt-prev-1: tests failed\nattempt-prev-2: tests failed\nattempt-prev-3: tests failed',
        stagnation: {
          stagnant: true,
          fingerprint: 'b'.repeat(64),
          repeated_attempt_ids: ['attempt-prev-1', 'attempt-prev-2', 'attempt-prev-3'],
        },
      },
      expires_at: '2026-07-07T01:00:00.000Z',
    })
    await ledger.append(h.root, {
      schema_version: 1,
      record_id: 'usage-record-1',
      recorded_at: '2026-07-07T00:00:02.000Z',
      kind: 'usage',
      usage_id: 'usage-1',
      attempt_id: 'attempt-1',
      loop_id: 'loop-1',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      tokens: { input: 1200, output: 300, cached_input: 200, reasoning: 80, total: 1500 },
      source: 'provider-structured',
      observed_at: '2026-07-07T00:00:02.000Z',
    })
    await ledger.closeReservationIfOpen(h.root, 'reservation-1', () => ({
      schema_version: 1,
      record_id: 'run-record-1',
      recorded_at: '2026-07-07T00:00:03.000Z',
      kind: 'run',
      run_record_id: 'run-terminal-1',
      attempt_id: 'attempt-1',
      reservation_id: 'reservation-1',
      iteration_id: 'iteration-attempt-1',
      loop_id: 'loop-1',
      change: h.name,
      workflow_run_id: runId!,
      level: 'L3',
      runner: 'codex',
      admitted_at: '2026-07-07T00:00:00.000Z',
      started_at: '2026-07-07T00:00:01.000Z',
      finished_at: '2026-07-07T00:00:03.000Z',
      result: 'paused',
      reason: 'verify-fail',
      verification: {
        schema_version: 1,
        verification_id: 'verification-1',
        subject: {
          workflow_run_id: runId!,
          attempt_id: 'attempt-1',
          change: h.name,
          revision: { kind: 'named-branch-head', sha: 'a'.repeat(40) },
        },
        binding: { kind: 'runtime-verifier', verifier: 'pipeline-git-integrity', version: '1' },
        verdict: 'failed',
        evidence: [{ kind: 'command-result', command_id: 'git-revision-integrity', exit_code: 1 }],
        issuer: { kind: 'host-verifier', verifier: 'pipeline-git-integrity', version: '1', trusted: true },
        evaluated_at: '2026-07-07T00:00:03.000Z',
      },
      usage_record_ids: ['usage-1'],
      accounting: { reserved_tokens: 2000, charged_tokens: 1500, charge_source: 'provider-structured' },
    }))

    const response = await reqGet(
      h.port,
      `/api/change/${encodeURIComponent(h.name)}/run-detail?root=${encodeURIComponent(h.root)}`,
    )
    expect(response.status).toBe(200)
    const body = response.json<any>()
    expect(body.ok).toBe(true)
    expect(body.source).toBe('canonical')
    expect(body.workflow_run).toMatchObject({
      id: runId,
      workflow_id: 'default',
      current_step: 'explore',
      transition_sequence: 1,
    })
    const revisionNumbers = body.revisions.map((r: any) => r.revision)
    expect(revisionNumbers).toEqual(revisionNumbers.map((_: number, index: number) => index))
    expect(revisionNumbers.length).toBeGreaterThan(1)
    expect(body.transitions).toHaveLength(1)
    expect(body.transitions[0]).toMatchObject({ runId, sequence: 1, event: 'open-complete', from: 'open', to: 'explore' })
    expect(body.ledger.health).toBe('ok')
    expect(body.attempt_contexts).toEqual([{
      record_id: 'reservation-record-1',
      recorded_at: '2026-07-07T00:00:00.000Z',
      reservation_id: 'reservation-1',
      attempt_id: 'attempt-1',
      iteration_id: 'iteration-attempt-1',
      loop_id: 'loop-1',
      source_run_record_ids: ['run-record-prev-1', 'run-record-prev-2', 'run-record-prev-3'],
      omitted_attempt_ids: ['attempt-old-1'],
      rendered: 'attempt-prev-1: tests failed\nattempt-prev-2: tests failed\nattempt-prev-3: tests failed',
      stagnation: {
        stagnant: true,
        fingerprint: 'b'.repeat(64),
        repeated_attempt_ids: ['attempt-prev-1', 'attempt-prev-2', 'attempt-prev-3'],
      },
    }])
    expect(body.ledger.records.map((r: any) => r.kind)).toEqual(['budget-reservation', 'usage', 'run'])
    expect(body.ledger.records[1].tokens).toMatchObject({ total: 1500, reasoning: 80 })
    expect(body.ledger.records[2].verification).toMatchObject({
      verdict: 'failed',
      issuer: { kind: 'host-verifier', trusted: true },
      subject: { workflow_run_id: runId, attempt_id: 'attempt-1', change: h.name },
    })
  })

  it('非法 change 名、未注册 root、change 不存在沿用兄弟 GET 端点的 400/404/400 契约', async () => {
    const h = await start()
    expect((await reqGet(h.port, `/api/change/bad%21/run-detail?root=${encodeURIComponent(h.root)}`)).status).toBe(400)
    expect((await reqGet(h.port, `/api/change/${h.name}/run-detail?root=${encodeURIComponent('/tmp/not-registered')}`)).status).toBe(404)
    expect((await reqGet(h.port, `/api/change/missing/run-detail?root=${encodeURIComponent(h.root)}`)).status).toBe(400)
  })
})

describe('GET 未知路由 → 404', () => {
  it('404 not found', async () => {
    const h = await start()
    const r = await reqGet(h.port, '/api/nope')
    expect(r.status).toBe(404)
  })
})

describe('GET / —— 前端落地页 + 同源 token 注入（B5 交付）', () => {
  it('200 text/html，内嵌本 server 的一次性 token（同源前端读取）', async () => {
    const h = await start({ token: 'inject-me-xyz' })
    const r = await reqGet(h.port, '/')
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toContain('text/html')
    expect(r.body).toContain('inject-me-xyz')
  })
})

describe('GET / + /assets/* —— webRoot 存在时服务真 SPA（BACKLOG #26c）', () => {
  it('GET / 返回 SPA index.html 且注入 token；/assets/* 真供给静态资源', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const web = await mkdtemp(join(tmpdir(), 'spa-'))
    await writeFile(join(web, 'index.html'), '<!doctype html><head><title>SPA</title></head><body><div id=app></div></body>', 'utf8')
    await mkdir(join(web, 'assets'), { recursive: true })
    const jsBundle = 'console.log("real bundle")\n'.repeat(100)
    await writeFile(join(web, 'assets', 'app.js'), jsBundle, 'utf8')
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'c1')
    const srv = createDashboardServer({
      paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
      token: 'spa-token', registry: () => [root], store, flow: testFlow(),
      clock: () => '2026-07-07T00:00:00Z', webRoot: web,
    })
    openServers.push(srv)
    const { port } = await srv.listen(0, '127.0.0.1')
    // GET / → 真 SPA index.html（含 <div id=app>）+ token 注入进 </head> 前
    const idx = await reqGet(port, '/')
    expect(idx.status).toBe(200)
    expect(idx.body).toContain('<div id=app>')
    expect(idx.body).toContain('window.__TENON_DASHBOARD_TOKEN__')
    expect(idx.body).toContain('spa-token')
    // GET /assets/app.js → 真静态供给 + js content-type
    const asset = await reqGet(port, '/assets/app.js')
    expect(asset.status).toBe(200)
    expect(String(asset.headers['content-type'])).toContain('javascript')
    expect(asset.body).toBe(jsBundle)
    const compressed = await reqGet(
      port,
      '/assets/app.js',
      '127.0.0.1',
      { 'Accept-Encoding': 'gzip' },
    )
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers.vary).toBe('Accept-Encoding')
    expect(Number(compressed.headers['content-length'])).toBeLessThan(
      Buffer.byteLength(jsBundle),
    )
    const decoded = await fetch(`http://127.0.0.1:${port}/assets/app.js`, {
      headers: { 'Accept-Encoding': 'gzip' },
    })
    expect(decoded.headers.get('content-encoding')).toBe('gzip')
    expect(await decoded.text()).toBe(jsBundle)
    // 路径穿越防护：/assets/../server.ts 不泄露
    const evil = await reqGet(port, '/assets/../package.json')
    expect(evil.status).not.toBe(200)
  })
})

describe('POST /api/change/<name>/transition —— B5 token 鉴权', () => {
  it('无 token → 401', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' })
    expect(r.status).toBe(401)
  })

  it('错 token → 401', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(r.status).toBe(401)
  })

  it('对 token → 200 且真改盘 .pipeline.yaml（open → explore）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const before = await h.store.read(join(h.root, 'openspec', 'changes', h.name))
    expect(before.fields.phase).toBe('open')

    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; from: string; to: string }>()
    expect(body.ok).toBe(true)
    expect(body.from).toBe('open')
    expect(body.to).toBe('explore')

    // 真副作用：磁盘上的 .pipeline.yaml 已改
    const after = await h.store.read(join(h.root, 'openspec', 'changes', h.name))
    expect(after.fields.phase).toBe('explore')
  })

  it('G1 canonical-only：YAML projection 缺失不把 change 误判为 404，transition 提交后重建 adapter', async () => {
    const h = await start({ seedPhaseSkill: true })
    await unlink(join(h.changeDir, '.pipeline.yaml'))
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, {
      root: h.root, event: 'open-complete',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect((await h.store.read(h.changeDir)).fields.phase).toBe('explore')
    expect(await h.store.inspectProjection(h.changeDir)).toMatchObject({ status: 'current' })
  })

  it('X-Pipeline-Token header 亦被接受（对 token → 200）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { 'X-Pipeline-Token': h.token },
    })
    expect(r.status).toBe(200)
  })

  it('free/matrix=false 仍由 frozen phase Skill 阻断当前 visit（HTTP transition 与 CLI 共用 required projection）', async () => {
    const manifestPath = await makeTempManifest()
    const h = await start({ manifestPath, seedPhaseSkill: false })
    const state = await h.store.read(h.changeDir)
    await h.store.write(h.changeDir, {
      ...state,
      fields: { ...state.fields, track: 'free' },
    })

    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, {
      root: h.root, event: 'open-complete',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(409)
    expect(r.json<{ code?: string; detail?: string[] }>()).toMatchObject({
      code: 'step-skills-incomplete',
      detail: expect.arrayContaining([expect.stringContaining('tenon-open')]),
    })
  })
})

describe('POST /api/change/<name>/transition —— Verify revision rejection contract', () => {
  it('malformed Build revision returns exact 409 blocker and performs zero canonical/history mutation', async () => {
    const h = await start({ pollIntervalMs: 20 })
    await writeFile(join(h.root, 'verification-report.md'), '# report\n', 'utf8')
    const seeded = await h.store.read(h.changeDir)
    const malformed = 'a'.repeat(41)
    await h.store.write(h.changeDir, {
      ...seeded,
      fields: {
        ...seeded.fields,
        phase: 'verify',
        verification_report: 'verification-report.md',
        branch_status: 'handled',
        agent_review_result: 'pass',
        codex_review_result: 'pass',
        build_sha: malformed,
      },
    })
    const before = await h.store.read(h.changeDir)
    const recordsPath = join(h.changeDir, '.pipeline-transitions')
    const beforeRecords = await readdir(recordsPath).catch(() => [] as string[])
    const historyPath = join(h.changeDir, '.pipeline-history.jsonl')
    const beforeHistory = existsSync(historyPath) ? await readFile(historyPath, 'utf8') : undefined

    const rejected = await reqPost(
      h.port,
      `/api/change/${h.name}/transition`,
      { root: h.root, event: 'verify-pass' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(rejected.status).toBe(409)
    const body = rejected.json<{
      ok: boolean
      error: string
      code: string
      reason: string
      remediation: string
      stateHash?: string
      revisionHash?: string
    }>()
    expect(body).toEqual({
      ok: false,
      error: 'Verify build revision is not trustworthy',
      code: 'verify-build-revision-untrusted',
      reason: 'malformed',
      remediation: 'return-to-build-and-capture-current-revision',
      stateHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(body)).not.toContain(malformed)
    expect(JSON.stringify(body)).not.toContain(h.root)

    expect(await h.store.read(h.changeDir)).toEqual(before)
    expect(await readdir(recordsPath).catch(() => [] as string[])).toEqual(beforeRecords)
    const afterHistory = existsSync(historyPath) ? await readFile(historyPath, 'utf8') : undefined
    expect(afterHistory).toBe(beforeHistory)

    const snapshot = (await reqGet(h.port, '/api/snapshot')).json<any>()
    const projectedReadiness = snapshot.projects[0].changes[0].workflowExecution
    expect(projectedReadiness).toEqual({
      readinessByTransition: {
        verify: {
          'verify-pass': {
            ready: false,
            blockers: [{
              kind: 'verify-build-revision-untrusted',
              code: 'verify-build-revision-untrusted',
              reason: 'malformed',
              remediation: 'return-to-build-and-capture-current-revision',
              stateHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            }],
          },
          'verify-fail': { ready: true, blockers: [] },
        },
      },
    })
    expect(JSON.stringify(projectedReadiness)).not.toContain(malformed)
    expect(JSON.stringify(projectedReadiness)).not.toContain(h.root)

    const sse = await openSSE(h.port, '/api/stream')
    const first = await sse.waitFor((event) => event.event === 'snapshot')
    const sseWorkflowExecution = JSON.parse(first.data).projects[0].changes[0].workflowExecution
    expect(sseWorkflowExecution).toEqual(projectedReadiness)
    expect(JSON.stringify(sseWorkflowExecution)).not.toContain(malformed)
    expect(JSON.stringify(sseWorkflowExecution)).not.toContain(h.root)
    sse.close()
  })
})

describe('POST /api/change/<name>/transition —— G1 default 轨收尾（breadcrumb + 显式 review receipt）', () => {
  it('进入 review 相位（explore）→ 真写 changeDir/.breadcrumb，但不在进入时自锁 review marker', async () => {
    const h = await start({ seedPhaseSkill: true })
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; to: string }>()
    expect(body.to).toBe('explore')

    // .breadcrumb：changeDir 下真实存在，精确内容（对齐 CLI cmdTransition 的 default 轨收尾
    // 同款格式，经 kernel applyBreadcrumbTail 单一真相源生成）
    const breadcrumbPath = join(h.changeDir, '.breadcrumb')
    expect(existsSync(breadcrumbPath)).toBe(true)
    expect(await readFile(breadcrumbPath, 'utf8')).toBe(`pipeline:${h.name} phase=explore\n`)

    // review marker 只由 `tenon review request` 在产物准备好后写入 canonical receipt 的 hook
    // projection；进入 review phase 时写它会把该 phase 的实际工作自身锁死。
    const markerPath = join(h.root, '.pipeline-pending-review')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('转换到非 review 相位（build）→ 不写 .pipeline-pending-review，但仍真写 .breadcrumb（两个决策相互独立，非「都跟着 review 走」）', async () => {
    const h = await start({ seedPhaseSkill: true })
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(
      join(h.root, '.pipeline', 'automation.json'),
      `${JSON.stringify({ version: 1, enabled: true, default_opt_in: true })}\n`,
      'utf8',
    )
    // 手动把 change 推到 spec 相位。default 的 PM 轨现在也受 OpenSpec plan 契约治理，
    // 因此填入已由真实 ledger 绑定的 Superpowers plan，聚焦测试 marker 写入条件本身。
    const state = await h.store.read(h.changeDir)
    await h.store.write(h.changeDir, {
      ...state,
      fields: { ...state.fields, phase: 'spec', track: 'pm', plan: `docs/superpowers/plans/${h.name}.md` },
    })
    await readGovernedDocumentsForCurrentVisit(h.root, h.changeDir)
    await recordWorkflowPhaseSkill(h.root, h.changeDir)

    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'spec-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; to: string; auto_enqueue?: string }>()
    expect(body.to).toBe('build')
    expect(body.auto_enqueue).toBe('queued')
    expect((await h.store.read(h.changeDir)).fields.automation).toBe('queued')

    expect(existsSync(join(h.root, '.pipeline-pending-review'))).toBe(false)
    // breadcrumb 是「default 轨转换成功即总写」，不受 review 相位判定影响——若实现误把两者
    // 耦合在同一个条件下，这条断言会抓到（上面那条负例本身抓不到，因为两者当时都会是「不写」）。
    const breadcrumbPath = join(h.changeDir, '.breadcrumb')
    expect(existsSync(breadcrumbPath)).toBe(true)
    expect(await readFile(breadcrumbPath, 'utf8')).toBe(`pipeline:${h.name} phase=build\n`)
  })

})

describe('POST 写端点纵深防线（老仓安全模型 parity）', () => {
  it('非本地 Host header → 403（DNS 重绑定守卫）', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Host: 'evil.example:1234', Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(403)
  })

  it('非 application/json → 400（同源策略防线）', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, null, {
      rawBody: 'root=x&event=open-complete',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('root 不在注册表（不可信项目）→ 404', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: '/tmp/not-registered', event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(404)
  })

  it('event 与当前 phase 不自洽（open 收 verify-pass）→ 409，零改盘', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'verify-pass' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(409)
    const after = await h.store.read(join(h.root, 'openspec', 'changes', h.name))
    expect(after.fields.phase).toBe('open')
  })

  it('未知 event → 400', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'bogus' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })
})

describe('POST /api/change/<name>/transition —— .pipeline-history.jsonl 记账（G20 / v5-T1）', () => {
  it('转换成功 → changeDir/.pipeline-history.jsonl 追加一行，形状对齐 CLI recordHistory（kind=transition + raw=event 不变式）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(200)
    const text = await readFile(join(h.changeDir, '.pipeline-history.jsonl'), 'utf8')
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as { kind?: string })
      .filter((line) => line.kind === 'transition')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({
      ts: '2026-07-07T00:00:00Z',
      kind: 'transition',
      from: 'open',
      to: 'explore',
      raw: 'open-complete', // 老仓 transitions_history.event 对位（同 cli/commands/transition.ts 口径）
      // W1 第二增量收尾：写侧统一走 transitionRecordToHistoryEntry，打上来源标记（唯一构造点，
      // 见 kernel state/history.ts）——不再是手填的裸对象。
      transitionRecordId: expect.any(String),
    })
  })

  it('转换被拒（event 与当前 phase 不匹配 → 409）→ 不写 history（guard 拒绝零记账）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'verify-pass' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(409)
    const historyPath = join(h.changeDir, '.pipeline-history.jsonl')
    const history = existsSync(historyPath) ? await readFile(historyPath, 'utf8') : ''
    const transitions = history.split('\n').filter((line) => line.includes('"kind":"transition"'))
    expect(transitions).toHaveLength(0)
  })

  it('连续两次转换 → 追加两行（append 语义，不覆盖）', async () => {
    const h = await start({ seedPhaseSkill: true })
    // explore-complete 有 design_doc 前置校验（字段非空 + 文件真存在）——先满足再转换。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(h.root, 'design.md'), '# design\n', 'utf8')
    await h.store.set(h.changeDir, 'design_doc', 'design.md')
    for (const event of ['open-complete', 'explore-complete']) {
      const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event }, {
        headers: { Authorization: `Bearer ${h.token}` },
      })
      expect(r.status).toBe(200)
      if (event === 'open-complete') {
        await readGovernedDocumentsForCurrentVisit(h.root, h.changeDir)
        await recordWorkflowPhaseSkill(h.root, h.changeDir)
      }
    }
    const text = await readFile(join(h.changeDir, '.pipeline-history.jsonl'), 'utf8')
    const rows = text.trim().split('\n').map((l) => JSON.parse(l) as { kind?: string; from: string; to: string })
      .filter((row) => row.kind === 'transition')
    expect(rows.map((e) => `${e.from}->${e.to}`)).toEqual(['open->explore', 'explore->spec'])
  })
})

describe('GET /api/change/:name/history —— 阶段时间线读端点（G21 / v5-T1）', () => {
  it('无 .pipeline-history.jsonl → 200 空 entries（不是 404，与「change 不存在」区分）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ entries: unknown[] }>().entries).toEqual([])
  })

  it('有记录 → 按 ts 升序返回（文件里乱序写入也重排）', async () => {
    const h = await start()
    const { writeFile } = await import('node:fs/promises')
    const rows = [
      { ts: '2026-07-07T02:00:00Z', kind: 'transition', from: 'explore', to: 'spec', raw: 'explore-complete' },
      { ts: '2026-07-07T01:00:00Z', kind: 'transition', from: 'open', to: 'explore', raw: 'open-complete' },
    ]
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), rows.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ ts: string; to: string }> }>().entries
    expect(entries.map((e) => e.ts)).toEqual(['2026-07-07T01:00:00Z', '2026-07-07T02:00:00Z'])
    expect(entries.map((e) => e.to)).toEqual(['explore', 'spec'])
  })

  it('损坏行（非 JSON）与空行被跳过，其余照常返回（不 500）', async () => {
    const h = await start()
    const { writeFile } = await import('node:fs/promises')
    const good = { ts: '2026-07-07T01:00:00Z', kind: 'init' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `not-json{{{\n\n${JSON.stringify(good)}\n`, 'utf8')
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ entries: unknown[] }>().entries).toEqual([good])
  })

  it('转换成功后立即可读（写读闭环：POST transition → GET history 回放同一条记录）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(w.status).toBe(200)
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ kind: string; from: string; to: string; raw: string; transitionRecordId?: string }> }>()
      .entries.filter((entry) => entry.kind === 'transition')
    expect(entries).toEqual([
      // 这次转换首次建立 canonical 链（懒生成兜底），history 端点走 canonical 分支返回，条目带
      // transitionRecordId（chain.map(transitionRecordToHistoryEntry) 的标配字段）。
      { ts: '2026-07-07T00:00:00Z', kind: 'transition', from: 'open', to: 'explore', raw: 'open-complete', transitionRecordId: expect.any(String) },
    ])
  })

  it('真读 canonical TransitionRecord 链，不是恰好与 JSONL 一致（W1 第二增量必须修 #2：' +
    '此前 canonical 链只写不读，GET history 事实上仍然只读 JSONL）——转换后手动破坏一行带真实' +
    'transitionRecordId 标记的 JSONL 条目，history 端点仍返回真实（canonical）数据，证明来源' +
    '判定只认标记是否存在、内容本身不是真相源，只有真读 canonical 链才会看到正确的 to', async () => {
    const h = await start({ seedPhaseSkill: true })
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(w.status).toBe(200)
    // 抓真实写入的 transitionRecordId：篡改的必须是「一行真的带标记的 canonical 投影」，不是
    // 恰好没打标记的遗留行——后者在新机制下本就会被当 legacy 原样保留，测不出"真读链、内容
    // 不看 JSONL"这件事。
    const real = JSON.parse((await readFile(join(h.changeDir, '.pipeline-history.jsonl'), 'utf8'))
      .split('\n').find((line) => line.includes('"kind":"transition"')) ?? '{}') as {
      transitionRecordId: string
    }
    // 破坏 JSONL：把 to 改成一个转换从未发生过的假相位，但保留真实 transitionRecordId 标记。
    // 若 history 端点仍读 JSONL 内容，会看到这条假数据；只有真读 canonical 链才会看到正确的 'explore'。
    const { writeFile } = await import('node:fs/promises')
    const tampered = {
      ts: '2026-07-07T00:00:00Z', kind: 'transition', from: 'open', to: 'TAMPERED', raw: 'open-complete',
      transitionRecordId: real.transitionRecordId,
    }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(tampered)}\n`, 'utf8')
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ kind: string; from: string; to: string; raw: string; transitionRecordId?: string }> }>()
      .entries
    expect(entries).toEqual([
      { ts: '2026-07-07T00:00:00Z', kind: 'transition', from: 'open', to: 'explore', raw: 'open-complete', transitionRecordId: real.transitionRecordId },
    ])
  })

  it('老 change 升级场景：canonical 链建立之前就存在、不带 transitionRecordId 的 JSONL transition ' +
    '条目被保留（保留的原因是"没有标记"，不是"时间早"——新机制不比较任何时间戳），链建立之后的' +
    '转换走 canonical（带标记）——合并后既不丢历史也不重复计入', async () => {
    const h = await start({ seedPhaseSkill: true })
    // 模拟一条"canonical 链出现之前"就已经存在的老 transition 记录：关键是它没有
    // transitionRecordId（老 writer 产生的，压根不知道这个字段），不是因为它的 ts 早——ts 只是
    // 顺带写成早于本次真转换，贴近真实老 change 升级场景，但保留与否不依赖这一点（时钟回拨场景
    // 见下方专门的独立用例）。
    const { writeFile } = await import('node:fs/promises')
    const preCanonical = { ts: '2026-07-06T00:00:00Z', kind: 'transition', from: 'archive', to: 'archive', raw: 'archived' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(preCanonical)}\n`, 'utf8')
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    // 真转换：这次会首次建立 canonical 链（runRepo.transact 的懒生成兜底），时间戳是 fixed clock，
    // 晚于上面手写的老记录
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(w.status).toBe(200)
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    const entries = r.json<{ entries: Array<{ ts: string; kind: string; from: string; to: string; raw: string; transitionRecordId?: string }> }>()
      .entries.filter((entry) => entry.kind === 'transition')
    // 老记录（链建立前，无标记）与新记录（canonical 链，带标记）都在，按时间排好序，互不重复
    expect(entries).toEqual([
      { ts: '2026-07-06T00:00:00Z', kind: 'transition', from: 'archive', to: 'archive', raw: 'archived' },
      { ts: '2026-07-07T00:00:00Z', kind: 'transition', from: 'open', to: 'explore', raw: 'open-complete', transitionRecordId: expect.any(String) },
    ])
  })

  it('非法 change 名（.. 路径穿越尝试）→ 400，同 afk log/cancel/retry 兄弟端点的 name 校验', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/change/${encodeURIComponent('..')}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(400)
  })

  it('root 不在注册表（不可信项目）→ 404，同兄弟端点共用的信任锚模式', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent('/tmp/not-registered')}`)
    expect(r.status).toBe(404)
    // 精确匹配信任锚校验的错误文案（而非落到路由表尾部「未知端点」兜底 404）——证明真走了本端点的 root 校验分支。
    expect(r.json<{ error: string }>().error).toBe('root 未在机器级项目注册表中')
  })

  it('change 名合法但该 change 实际不存在（无 .pipeline.yaml）→ 400，同 afk log 端点的 ENOENT 前置约定，不与「还没记录」的 200 混淆', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/change/does-not-exist/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(400)
    expect(r.json<{ error: string }>().error).toBe('找不到该 change（无 canonical/legacy 状态）')
  })
})

/**
 * W1 第二增量收尾：history 合并边界从「canonical 链首条记录 observedAt vs JSONL ts 字符串比较」
 * 改成「transitionRecordId 是否存在」的逐条来源标记（见 transition.ts::readChangeHistory 头部
 * 注释）。这里覆盖 codex 架构评估点名的原方案不可靠场景：同秒冲突 / 时钟回拨 / head 文件缺失
 * 误清空遗留记录 / 晚于链建立才执行的 tenon import，以及未被上面既有测试单独覆盖的边界。
 */
describe('GET /api/change/:name/history —— transitionRecordId 来源判定（不比较任何时间戳）', () => {
  it('canonical 记录与遗留 JSONL 条目时间戳完全相同 → 两者都保留、不重复、不误删（原方案的头号 bug：' +
    '`ts < earliestCanonicalTs` 在同秒时恒为 false，会把这条遗留记录误判成"链建立之后的重复"）', async () => {
    const h = await start()
    const { writeFile } = await import('node:fs/promises')
    // 遗留条目与即将发生的真实转换用完全相同的 ts（同秒冲突）——内容不同（不同的 from/to/raw），
    // 证明它不是同一次转换的重复投影，只是巧合撞了同一秒，理应两条都保留。
    const legacySameTs = { ts: '2026-07-07T00:00:00Z', kind: 'transition', from: 'verify', to: 'ship', raw: 'verify-pass' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(legacySameTs)}\n`, 'utf8')
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // 真实转换的 ts 同样是 fixed clock '2026-07-07T00:00:00Z'
    expect(w.status).toBe(200)
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ ts: string; raw: string; kind?: string; transitionRecordId?: string }> }>().entries
      .filter((entry) => entry.kind === 'transition')
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual(legacySameTs)
    expect(entries.find((e) => e.raw === 'open-complete')).toMatchObject({
      ts: '2026-07-07T00:00:00Z', transitionRecordId: expect.any(String),
    })
  })

  it('时钟回拨场景（遗留 JSONL 条目的 ts 比 canonical 链的 ts 更晚）→ 遗留条目仍正确保留（原方案' +
    '`e.ts < earliestCanonicalTs` 会判它为 false 从而误删——新方案不比较时间戳，只看标记）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const { writeFile } = await import('node:fs/promises')
    const legacyLaterTs = { ts: '2026-07-08T00:00:00Z', kind: 'transition', from: 'verify', to: 'ship', raw: 'verify-pass' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(legacyLaterTs)}\n`, 'utf8')
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // canonical 链首次建立，ts 是 fixed clock '2026-07-07T00:00:00Z'，反而早于上面的遗留记录
    expect(w.status).toBe(200)
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ ts: string; raw: string; kind?: string }> }>().entries
      .filter((entry) => entry.kind === 'transition')
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual(legacyLaterTs)
    // 展示顺序仍按 ts 升序排（canonical 在前，遗留在后）——但"是否保留"与这个顺序无关
    expect(entries.map((e) => e.raw)).toEqual(['open-complete', 'verify-pass'])
  })

  it('G1 canonical cutover：current 的 head TransitionRecord 缺失 → history fail-loud，绝不回退 JSONL 伪装完整', async () => {
    const h = await start({ seedPhaseSkill: true })
    const { writeFile, unlink } = await import('node:fs/promises')
    const legacy = { ts: '2026-07-01T00:00:00Z', kind: 'transition', from: 'spec', to: 'build', raw: 'spec-approved' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(legacy)}\n`, 'utf8')
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(w.status).toBe(200)
    // 删除 head 指向的唯一记录文件，模拟 .pipeline-transitions/ 记录丢失/损坏。
    const recordsDir = join(h.changeDir, '.pipeline-transitions')
    const files = await readdir(recordsDir)
    expect(files).toHaveLength(1) // sanity：确实只有一条记录（sequence=1）
    await unlink(join(recordsDir, files[0]!))
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.json<{ error: string }>().error).toMatch(/TransitionRecord|record.*缺失/i)
  })

  it('G1 canonical 全链：链中途缺祖先记录 → history fail-loud，不返回看似完整的后缀', async () => {
    const h = await start({ seedPhaseSkill: true })
    const { writeFile, unlink } = await import('node:fs/promises')
    const legacy = { ts: '2026-07-01T00:00:00Z', kind: 'transition', from: 'archive', to: 'archive', raw: 'archived-long-ago' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(legacy)}\n`, 'utf8')
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    // explore-complete 的前置（design_doc）
    await writeFile(join(h.root, 'design.md'), '# design\n', 'utf8')
    await h.store.set(h.changeDir, 'design_doc', 'design.md')
    const w1 = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // sequence 1: open -> explore
    expect(w1.status).toBe(200)
    await readGovernedDocumentsForCurrentVisit(h.root, h.changeDir)
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    const w2 = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'explore-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // sequence 2: explore -> spec
    expect(w2.status).toBe(200)
    const recordsDir = join(h.changeDir, '.pipeline-transitions')
    const files = await readdir(recordsDir)
    const seq1File = files.find((f) => f.startsWith('000001-'))
    expect(seq1File).toBeDefined()
    await unlink(join(recordsDir, seq1File!))
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.json<{ error: string }>().error).toMatch(/TransitionRecord|record.*缺失/i)
  })

  it('完全没有 runMetadata 的老 change → 全部 JSONL 原样返回（回归防护：本次改动不应波及这条既有 fallback）', async () => {
    const h = await start({ legacyWithoutRunIdentity: true, seedGovernedEvidence: false })
    const { writeFile } = await import('node:fs/promises')
    const rows = [
      { ts: '2026-07-01T00:00:00Z', kind: 'transition', from: 'open', to: 'explore', raw: 'open-complete' },
      { ts: '2026-07-02T00:00:00Z', kind: 'set', field: 'design_doc', by: 'user' },
    ]
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    // sanity：确认这个 change 真的没有 runMetadata（从未经历过 runRepo.transact）
    const state = await h.store.read(h.changeDir)
    expect(state.runMetadata).toBeUndefined()
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ entries: unknown[] }>().entries).toEqual(rows)
  })

  it('晚于 canonical 链建立之后才写入的、不带 transitionRecordId 的 JSONL transition 条目（模拟迟到的' +
    ' tenon import）→ 必须保留，即使它在文件里的物理位置排在 canonical 投影之后', async () => {
    const h = await start({ seedPhaseSkill: true })
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(w.status).toBe(200)
    const { appendFile } = await import('node:fs/promises')
    // 追加（不是覆盖）在 canonical 投影行之后——模拟老 transitions_history 迟于链建立才被
    // `tenon import` 追加进 JSONL 的场景。
    const lateImport = { ts: '2026-07-07T00:00:00Z', kind: 'transition', from: 'archive', to: 'archive', raw: 'legacy-import-transitions_history' }
    await appendFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(lateImport)}\n`, 'utf8')
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ raw: string; kind?: string; transitionRecordId?: string }> }>().entries
      .filter((entry) => entry.kind === 'transition')
    expect(entries).toHaveLength(2)
    expect(entries.some((e) => e.raw === 'open-complete' && typeof e.transitionRecordId === 'string')).toBe(true)
    expect(entries.some((e) => e.raw === 'legacy-import-transitions_history' && e.transitionRecordId === undefined)).toBe(true)
  })

  it('非 transition kind（set/init/tool/prompt/import）穿插在 JSONL 里 → 永远原样保留，不受 canonical ' +
    '链是否存在影响（回归防护）', async () => {
    const h = await start()
    const { writeFile } = await import('node:fs/promises')
    const nonTransitionRows = [
      { ts: '2026-07-06T00:00:00Z', kind: 'init' },
      { ts: '2026-07-06T01:00:00Z', kind: 'set', field: 'design_doc', by: 'alice' },
      { ts: '2026-07-06T02:00:00Z', kind: 'tool', raw: 'ran-lint' },
      { ts: '2026-07-06T03:00:00Z', kind: 'prompt', raw: 'Q|A' },
      { ts: '2026-07-06T04:00:00Z', kind: 'import', raw: 'legacy-note' },
    ]
    await writeFile(
      join(h.changeDir, '.pipeline-history.jsonl'), nonTransitionRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8',
    )
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // 建立 canonical 链，证明非 transition kind 在链存在时也不受影响
    expect(w.status).toBe(200)
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<Record<string, unknown>> }>().entries
    const relevantEntries = entries.filter((entry) =>
      nonTransitionRows.some((row) => JSON.stringify(row) === JSON.stringify(entry)) || entry.raw === 'open-complete',
    )
    expect(relevantEntries).toHaveLength(6) // 5 条非 transition + 1 条 canonical transition
    for (const row of nonTransitionRows) {
      expect(relevantEntries).toContainEqual(row)
    }
  })

  it('canonical 链内部因系统时钟回拨导致 observedAt 顺序与 sequence 顺序相反 → 合并结果仍按 sequence ' +
    '顺序排列，不因回拨的 ts 颠倒（两指针合并保证 canonical 序列内部两个元素永远不互相比较，这是 ' +
    'codex 架构 review 点名的 P2：sortByTs 对拼接后的整体数组重排会让权威的因果顺序被不可靠的时间戳打乱）', async () => {
    let observedAt = '2026-07-07T00:00:00Z'
    const h = await start({ clock: () => observedAt, seedPhaseSkill: true })
    const { writeFile } = await import('node:fs/promises')
    // explore-complete 的前置（design_doc）
    await writeFile(join(h.root, 'design.md'), '# design\n', 'utf8')
    await h.store.set(h.changeDir, 'design_doc', 'design.md')
    const w1 = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // sequence 1: open -> explore
    expect(w1.status).toBe(200)
    await readGovernedDocumentsForCurrentVisit(h.root, h.changeDir)
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    observedAt = '2020-01-01T00:00:00Z' // 系统时钟在第二次真实 commit 前回拨
    const w2 = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'explore-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // sequence 2: explore -> spec（因果上晚、observedAt 更早）
    expect(w2.status).toBe(200)
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ raw: string; ts: string; kind?: string }> }>().entries
      .filter((entry) => entry.kind === 'transition')
    // sequence 1（open-complete）仍排在 sequence 2（explore-complete）前面——canonical 记录之间
    // 的相对顺序由 sequence 决定，不受回拨 ts 影响，即使 explore-complete 的 ts 显示更早。
    expect(entries.map((e) => e.raw)).toEqual(['open-complete', 'explore-complete'])
    expect(entries.find((e) => e.raw === 'explore-complete')?.ts).toBe('2020-01-01T00:00:00Z')
  })

  it('G1：非 head 的祖先 TransitionRecord 被改写也必须让 history fail-loud', async () => {
    const h = await start({ seedPhaseSkill: true })
    await writeFile(join(h.root, 'design.md'), '# design\n', 'utf8')
    await h.store.set(h.changeDir, 'design_doc', 'design.md')
    for (const event of ['open-complete', 'explore-complete']) {
      const w = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event }, {
        headers: { Authorization: `Bearer ${h.token}` },
      })
      expect(w.status).toBe(200)
      if (event === 'open-complete') {
        await readGovernedDocumentsForCurrentVisit(h.root, h.changeDir)
        await recordWorkflowPhaseSkill(h.root, h.changeDir)
      }
    }
    const recordsDir = join(h.changeDir, '.pipeline-transitions')
    const seq1File = (await readdir(recordsDir)).find((file) => file.startsWith('000001-'))!
    const seq1Path = join(recordsDir, seq1File)
    const seq1 = JSON.parse(await readFile(seq1Path, 'utf8')) as Record<string, unknown>
    seq1.event = 'tampered-ancestor'
    await writeFile(seq1Path, JSON.stringify(seq1), 'utf8')

    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.json<{ error: string }>().error).toMatch(/TransitionRecord.*digest|审计.*绑定/i)
  })

  it('对照：legacy 条目与 canonical 条目混合时，legacy 仍按自身 ts 插入到正确位置（回归防护——证明' +
    '两指针合并没有破坏"混合排序在正常情况下仍然合理"这条既有性质）', async () => {
    const h = await start({ seedPhaseSkill: true })
    const { writeFile, appendFile } = await import('node:fs/promises')
    const legacyEarly = { ts: '2026-07-01T00:00:00Z', kind: 'transition', from: 'archive', to: 'archive', raw: 'legacy-early' }
    const legacyLate = { ts: '2026-07-09T00:00:00Z', kind: 'transition', from: 'archive', to: 'archive', raw: 'legacy-late' }
    await writeFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(legacyEarly)}\n`, 'utf8')
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    // explore-complete 的前置（design_doc）
    await writeFile(join(h.root, 'design.md'), '# design\n', 'utf8')
    await h.store.set(h.changeDir, 'design_doc', 'design.md')
    const w1 = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // sequence 1: open -> explore，ts = fixed clock '2026-07-07T00:00:00Z'
    expect(w1.status).toBe(200)
    await readGovernedDocumentsForCurrentVisit(h.root, h.changeDir)
    await recordWorkflowPhaseSkill(h.root, h.changeDir)
    const w2 = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'explore-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    }) // sequence 2: explore -> spec，ts 同样是 fixed clock '2026-07-07T00:00:00Z'
    expect(w2.status).toBe(200)
    await appendFile(join(h.changeDir, '.pipeline-history.jsonl'), `${JSON.stringify(legacyLate)}\n`, 'utf8')
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const entries = r.json<{ entries: Array<{ raw: string; kind?: string }> }>().entries
      .filter((entry) => entry.kind === 'transition')
    // legacy-early（ts 最早）排最前；两条 canonical 记录（ts 相同、未被篡改）按 sequence 顺序
    // 紧随其后；legacy-late（ts 最晚）排最后——混合排序在正常情况下依然合理。
    expect(entries.map((e) => e.raw)).toEqual(['legacy-early', 'open-complete', 'explore-complete', 'legacy-late'])
  })

  it('readJsonlHistory 非 ENOENT 错误必须原样抛出，不能被误判成"没有历史"（.pipeline-history.jsonl ' +
    '路径被目录占用触发 EISDIR，不是 ENOENT）→ GET 端点 500，不是静默 200 空 entries', async () => {
    const h = await start()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(h.changeDir, '.pipeline-history.jsonl'))
    const r = await reqGet(h.port, `/api/change/${h.name}/history?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.json<{ ok: boolean }>().ok).toBe(false)
  })
})

describe('GET /api/stream —— SSE 真推送（.pipeline.yaml 变化即推）', () => {
  it('首连推初始快照；transition 改盘后推新快照（phase=explore）', async () => {
    const h = await start({ pollIntervalMs: 20, seedPhaseSkill: true })
    const sse = await openSSE(h.port, '/api/stream')
    // 初始快照
    const first = await sse.waitFor((e) => e.event === 'snapshot')
    const s0 = JSON.parse(first.data)
    expect(s0.projects[0].changes[0].phase).toBe('open')

    // 真改盘
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(200)

    // 轮询检测到变化 → 推新快照
    const next = await sse.waitFor((e) => {
      if (e.event !== 'snapshot') return false
      try { return JSON.parse(e.data).projects[0].changes[0].phase === 'explore' } catch { return false }
    }, 4000)
    expect(JSON.parse(next.data).projects[0].changes[0].phase).toBe('explore')
    sse.close()
  })
})

describe('GET /api/config?root= —— G3/T-R5 动态 Track config（本机回环只读不鉴权）', () => {
  it('capabilities.config=false 的实例（未注入 manifestPath）→ 404，snapshot 亦如实标 config:false', async () => {
    const h = await start() // 默认不带 manifestPath（同现有全部既存测试）
    const snap = (await reqGet(h.port, '/api/snapshot')).json<{ capabilities: Record<string, boolean> }>()
    expect(snap.capabilities.config).toBe(false)
    const r = await reqGet(h.port, '/api/config')
    expect(r.status).toBe(404)
  })

  it('绑定注册 root，返回 dashboard 所需的完整 effective registry（含第 6 条自定义轨）', async () => {
    const h = await startWithConfig()
    const snap = (await reqGet(h.port, '/api/snapshot')).json<{ capabilities: Record<string, boolean> }>()
    expect(snap.capabilities.config).toBe(true)
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: qa
    label: Quality
    workflow:
      default: default
      allowed: [default]
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: backend
      routing:
        enabled: true
        pattern: '(qa|test)'
        priority: 250
      skills:
        matrix: true
        profile: frontend
`, 'utf8')

    const r = await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<any>()
    expect(body.ok).toBe(true)
    expect(body.generated_at).toBe('2026-07-07T00:00:00Z')
    expect(body.source).toBe('project-file')
    expect(body.revision).toMatch(/^[0-9a-f]{16}$/)
    expect(body.tracks.map((track: { id: string }) => track.id)).toEqual(['chat', 'simple', 'pm', 'frontend', 'backend', 'free', 'qa'])
    expect(body.tracks.find((track: { id: string }) => track.id === 'qa')).toEqual({
      id: 'qa',
      label: 'Quality',
      builtin: false,
      workflow: { default: 'default', allowed: ['default'] },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'backend',
        routing: { enabled: true, pattern: '(qa|test)', priority: 250 },
        skills: { matrix: true, profile: 'frontend' },
      },
    })
    expect(body.mandatory_skills_writable_profiles).toEqual(['pm', 'frontend', 'backend'])
    expect(body.mandatory_skills['build.backend']).toContain('test-driven-development')
    expect(body.mandatory_skills['open._all']).toContain('openspec-propose')
  })

  it('项目无 tracks.yaml → kernel 合法 builtin-only 六轨，不要求迁移文件', async () => {
    const h = await startWithConfig()
    const r = await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<any>()
    expect(body.source).toBe('builtin-only')
    expect(body.tracks.map((track: { id: string }) => track.id)).toEqual(['chat', 'simple', 'pm', 'frontend', 'backend', 'free'])
  })

  it('缺 root → 400；未注册 root → 404', async () => {
    const h = await startWithConfig()
    expect((await reqGet(h.port, '/api/config')).status).toBe(400)
    expect((await reqGet(h.port, `/api/config?root=${encodeURIComponent('/tmp/not-registered')}`)).status).toBe(404)
  })

  it.each([
    ['空文件', ''],
    ['畸形定义', 'version: 1\ntracks:\n  - id: qa\n'],
  ])('%s registry → 500 且不返回半张/static fallback registry', async (_label, registryText) => {
    const h = await startWithConfig()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'tracks.yaml'), registryText, 'utf8')

    const r = await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    const body = r.json<{ ok: boolean; tracks?: unknown }>()
    expect(body.ok).toBe(false)
    expect(body.tracks).toBeUndefined()
  })

  it('server 启动后 registered root 换成外部 symlink → 403，不读取外部 registry', async () => {
    const { mkdtemp, rename, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await startWithConfig()
    const parked = `${h.root}.config-registered-inode`
    const outside = await mkdtemp(join(tmpdir(), 'config-root-swap-outside-'))
    await mkdir(join(outside, '.pipeline'))
    await writeFile(join(outside, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: stolen
    label: Stolen
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: none
      routing:
        enabled: false
      skills:
        matrix: false
        profile: _all
`, 'utf8')
    await rename(h.root, parked)
    await symlink(outside, h.root, 'dir')

    const r = await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('Stolen')
  })

  it('.pipeline 是外部 symlink → 500，不读取外部 tracks.yaml', async () => {
    const { mkdtemp, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await startWithConfig()
    const outside = await mkdtemp(join(tmpdir(), 'config-pipeline-link-outside-'))
    await writeFile(join(outside, 'tracks.yaml'), `version: 1
tracks:
  - id: stolen
    label: Stolen
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: none
      routing:
        enabled: false
      skills:
        matrix: false
        profile: _all
`, 'utf8')
    await symlink(outside, join(h.root, '.pipeline'), 'dir')

    const r = await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('Stolen')
  })
})

describe('POST /api/verification-evidence/compose —— 受保护的无状态草稿格式化', () => {
  const entry = {
    kind: 'command',
    title: 'Run server tests',
    status: 'passed',
    command: 'npm test -- server.test.ts',
    result: 'passed',
  }

  it('registered root + token 生成 Markdown，canonical state 和 ledger 零变化', async () => {
    const h = await start()
    const statePath = join(h.changeDir, '.pipeline-run', 'current.json')
    const ledgerPath = join(h.changeDir, '.pipeline-documents.json')
    const beforeState = await readFile(statePath, 'utf8')
    const beforeLedger = await readFile(ledgerPath, 'utf8')

    const response = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      { root: h.root, locale: 'en', entries: [entry] },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      entryCount: 1,
      markdown: expect.stringContaining('## Verification evidence draft'),
    })
    expect(await readFile(statePath, 'utf8')).toBe(beforeState)
    expect(await readFile(ledgerPath, 'utf8')).toBe(beforeLedger)
  })

  it('validation error 返回稳定 code/path，空数组不生成假证据', async () => {
    const h = await start()
    const auth = { Authorization: `Bearer ${h.token}` }
    const invalid = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      {
        root: h.root,
        locale: 'en',
        entries: [{ ...entry, status: 'skipped', result: 'forged pass' }],
      },
      { headers: auth },
    )
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({
      ok: false,
      code: 'verification_evidence_invalid',
      details: [
        { code: 'field_forbidden', path: 'entries[0].result' },
        { code: 'field_required', path: 'entries[0].skipReason' },
      ],
    })

    const empty = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      { root: h.root, locale: 'en', entries: [] },
      { headers: auth },
    )
    expect(empty.status).toBe(400)
    expect(empty.json()).toMatchObject({
      ok: false,
      code: 'verification_evidence_invalid',
      details: [{ code: 'entries_empty', path: 'entries' }],
    })
  })

  it('闭集 DTO 拒绝自有 __proto__，非对象错误保持可解码 envelope', async () => {
    const h = await start()
    const auth = { Authorization: `Bearer ${h.token}` }
    const withProto = JSON.parse(JSON.stringify({
      root: h.root,
      locale: 'en',
      entries: [entry],
    }).replace('{', '{"__proto__":null,')) as unknown
    const unknownField = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      withProto,
      { headers: auth },
    )
    expect(unknownField.status).toBe(400)
    expect(unknownField.json()).toMatchObject({
      ok: false,
      code: 'verification_evidence_invalid',
      details: [{ code: 'unknown_field', path: '__proto__' }],
      overflow: false,
    })

    const nonObject = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      null,
      { headers: auth },
    )
    expect(nonObject.status).toBe(400)
    expect(nonObject.json()).toMatchObject({
      ok: false,
      code: 'verification_evidence_invalid',
      details: [{ code: 'object_invalid', path: '' }],
      overflow: false,
    })
  })

  it('复用 token 与 registered-root 安全边界', async () => {
    const h = await start()
    const missingToken = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      { root: h.root, locale: 'en', entries: [entry] },
    )
    expect(missingToken.status).toBe(401)

    const unknownRoot = await reqPost(
      h.port,
      '/api/verification-evidence/compose',
      { root: '/tmp/not-registered-verification-root', locale: 'en', entries: [entry] },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(unknownRoot.status).toBe(404)
  })

  it('缺失、空白或非字符串 root 在 registered-root resolver 前稳定失败关闭', async () => {
    const h = await start()
    const auth = { Authorization: `Bearer ${h.token}` }
    for (const body of [
      { locale: 'en', entries: [entry] },
      { root: ' \t', locale: 'en', entries: [entry] },
      { root: 42, locale: 'en', entries: [entry] },
    ]) {
      const response = await reqPost(
        h.port,
        '/api/verification-evidence/compose',
        body,
        { headers: auth },
      )
      expect(response.status).toBe(400)
      expect(response.json()).toMatchObject({
        ok: false,
        code: 'verification_evidence_invalid',
        details: [{ path: 'root' }],
        overflow: false,
      })
    }
  })
})

describe('GET/POST/PATCH/DELETE /api/tracks —— v3 Studio Track CRUD', () => {
  const policy = {
    reviewSeed: 'pending' as const,
    automationEligible: true,
    coverageProfile: 'backend' as const,
    routing: { enabled: true as const, pattern: '(qa|test)', priority: 250 },
    skills: { matrix: true, profile: 'frontend' },
  }

  it('真 HTTP 创建→修改→删除自定义 Track；每步 revision 推进且真落盘', async () => {
    const h = await startWithConfig()
    const auth = { Authorization: `Bearer ${h.token}` }
    const initial = await reqGet(h.port, `/api/tracks?root=${encodeURIComponent(h.root)}`)
    expect(initial.status).toBe(200)
    const first = initial.json<any>()
    expect(first.tracks.map((track: { id: string }) => track.id)).toEqual(['chat', 'simple', 'pm', 'frontend', 'backend', 'free'])

    const created = await reqPost(h.port, '/api/tracks', {
      root: h.root,
      revision: first.revision,
      track: {
        id: 'qa', label: 'Quality', workflow: { default: 'default', allowed: ['default'] }, policyProfile: policy,
      },
    }, { headers: auth })
    expect(created.status).toBe(200)
    const second = created.json<any>()
    expect(second.revision).not.toBe(first.revision)
    expect(second.tracks.at(-1)).toMatchObject({ id: 'qa', label: 'Quality', builtin: false })
    expect(await readFile(join(h.root, '.pipeline', 'tracks.yaml'), 'utf8')).toContain('id: qa')

    const updated = await reqPatch(h.port, '/api/tracks/qa', {
      root: h.root,
      revision: second.revision,
      patch: { label: 'QA & Release', workflowAllowed: '*' },
    }, { headers: auth })
    expect(updated.status).toBe(200)
    const third = updated.json<any>()
    expect(third.tracks.find((track: { id: string }) => track.id === 'qa')).toMatchObject({
      label: 'QA & Release', workflow: { allowed: '*' },
    })

    const removed = await reqDelete(
      h.port,
      `/api/tracks/qa?root=${encodeURIComponent(h.root)}&revision=${encodeURIComponent(third.revision)}`,
      { headers: auth },
    )
    expect(removed.status).toBe(200)
    const fourth = removed.json<any>()
    expect(fourth.tracks.some((track: { id: string }) => track.id === 'qa')).toBe(false)
    expect(await readFile(join(h.root, '.pipeline', 'tracks.yaml'), 'utf8')).not.toContain('id: qa')
  })

  it('stale revision → 409 且不覆盖新值', async () => {
    const h = await startWithConfig()
    const auth = { Authorization: `Bearer ${h.token}` }
    const first = (await reqGet(h.port, `/api/tracks?root=${encodeURIComponent(h.root)}`)).json<any>()
    const body = {
      root: h.root,
      revision: first.revision,
      track: { id: 'qa', label: 'Quality', workflow: { default: 'default', allowed: '*' }, policyProfile: policy },
    }
    expect((await reqPost(h.port, '/api/tracks', body, { headers: auth })).status).toBe(200)
    const stale = await reqPost(h.port, '/api/tracks', { ...body, track: { ...body.track, id: 'ops' } }, { headers: auth })
    expect(stale.status).toBe(409)
    expect(stale.json<any>()).toMatchObject({ ok: false, code: 'TRACK_REVISION_CONFLICT' })
    const current = (await reqGet(h.port, `/api/tracks?root=${encodeURIComponent(h.root)}`)).json<any>()
    expect(current.tracks.map((track: { id: string }) => track.id)).not.toContain('ops')
  })

  it('活跃 Change 引用自定义 Track → DELETE 409 并列出 change，零删除', async () => {
    const h = await startWithConfig()
    const auth = { Authorization: `Bearer ${h.token}` }
    const first = (await reqGet(h.port, `/api/tracks?root=${encodeURIComponent(h.root)}`)).json<any>()
    const created = await reqPost(h.port, '/api/tracks', {
      root: h.root,
      revision: first.revision,
      track: { id: 'qa', label: 'Quality', workflow: { default: 'default', allowed: '*' }, policyProfile: policy },
    }, { headers: auth })
    const second = created.json<any>()
    const change = await reqPost(h.port, '/api/changes', {
      root: h.root, name: 'qa-change', track: 'qa', workflow: 'default', title: 'QA change',
    }, { headers: auth })
    expect(change.status).toBe(200)

    const removed = await reqDelete(
      h.port,
      `/api/tracks/qa?root=${encodeURIComponent(h.root)}&revision=${encodeURIComponent(second.revision)}`,
      { headers: auth },
    )
    expect(removed.status).toBe(409)
    expect(removed.json<any>()).toMatchObject({ ok: false, code: 'TRACK_REFERENCED', references: ['qa-change'] })
    const current = (await reqGet(h.port, `/api/tracks?root=${encodeURIComponent(h.root)}`)).json<any>()
    expect(current.tracks.map((track: { id: string }) => track.id)).toContain('qa')
  })
})

describe('GET /api/skills/registry —— 全部已注册 skill 明细(T6 升级为 SkillEntry[])', () => {
  it('返回本仓真实 skills 目录 + EXTERNAL-SKILLS.md 合并明细,逐字段符合 SkillEntry 形状', async () => {
    const h = await start()
    const r = await reqGet(h.port, '/api/skills/registry')
    expect(r.status).toBe(200)
    const body = r.json<{ skills: Array<{ name: string; installed: boolean; source: string; tier: string; available: boolean; description?: string; installCmd?: string }> }>()
    const names = body.skills.map((s) => s.name)
    expect(names).toContain('tenon-open') // 本仓真实存在的本地 skill 目录
    expect(names.length).toBeGreaterThan(14) // 必须包含外部登记，不能只有本地 14 个
    for (const e of body.skills) {
      expect(typeof e.name).toBe('string')
      expect(typeof e.installed).toBe('boolean')
      expect(['local-plugin', 'external-marketplace', 'builtin', 'user']).toContain(e.source)
      expect(['mandatory', 'recommended', 'conditional', 'optional']).toContain(e.tier)
      expect(typeof e.available).toBe('boolean')
    }
    expect(body.skills.some((entry) => typeof entry.description === 'string' && entry.description.length > 0)).toBe(true)
    const local = body.skills.find((s) => s.name === 'tenon-open')!
    expect(local.source).toBe('local-plugin')
    // builtin 四件套恒已装(写死短名单,不依赖测试机环境)
    for (const b of ['verify', 'run', 'code-review', 'security-review']) {
      const e = body.skills.find((s) => s.name === b)
      if (e) expect(e.installed).toBe(true)
    }
  })
})

describe('POST /api/config/mandatory-skills —— M3 config 写端点（同 B5 token 鉴权模式）', () => {
  it('无 token → 401（与 transition 端点同一鉴权模式）', async () => {
    const h = await startWithConfig()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'build', track: 'backend', skills: ['x'] })
    expect(r.status).toBe(401)
  })

  it('错 token → 401', async () => {
    const h = await startWithConfig()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'build', track: 'backend', skills: ['x'] }, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(r.status).toBe(401)
  })

  it('对 token → 200 且真改盘 manifest.yaml（build.backend 真变，其余条目不变）', async () => {
    const h = await startWithConfig()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'build', track: 'backend', skills: ['new-a', 'new-b'] }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; phase: string; track: string; skills: string[] }>()
    expect(body).toEqual({ ok: true, phase: 'build', track: 'backend', skills: ['new-a', 'new-b'] })

    // 真副作用：磁盘上的 manifest.yaml 已改，且真过 kernel loadManifest 重解析
    const reparsed = loadManifest(h.manifestPath!)
    expect(reparsed.mandatorySkills.build.backend).toEqual(['new-a', 'new-b'])
    expect(reparsed.mandatorySkills.explore.pm).toEqual(['brainstorming', 'grill-with-docs'])

    // 且 GET /api/config 立刻回显新值（读写一致，非缓存旧值）
    const after = (await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`))
      .json<{ mandatory_skills: Record<string, string[]> }>()
    expect(after.mandatory_skills['build.backend']).toEqual(['new-a', 'new-b'])
  })

  it('X-Pipeline-Token header 亦被接受（对 token → 200，同 transition 端点）', async () => {
    const h = await startWithConfig()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'spec', track: 'pm', skills: ['ok'] }, {
      headers: { 'X-Pipeline-Token': h.token },
    })
    expect(r.status).toBe(200)
  })

  it('非本地 Host header → 403（同 transition 端点共用的 DNS 重绑定守卫）', async () => {
    const h = await startWithConfig()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'build', track: 'backend', skills: ['x'] }, {
      headers: { Host: 'evil.example:1234', Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(403)
  })

  it('非 application/json → 400（同 transition 端点共用的同源策略防线）', async () => {
    const h = await startWithConfig()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', null, {
      rawBody: 'phase=build&track=backend',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('capabilities.config=false（未注入 manifestPath）→ 404，即便带对 token', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'build', track: 'backend', skills: ['x'] }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(404)
  })

  it('archive 相位 → 400，原文件不改动', async () => {
    const h = await startWithConfig()
    const before = await readFile(h.manifestPath!, 'utf8')
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'archive', track: 'backend', skills: ['x'] }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
    expect(await readFile(h.manifestPath!, 'utf8')).toBe(before)
  })

  it('未知 track（如 _all）→ 400，原文件不改动', async () => {
    const h = await startWithConfig()
    const before = await readFile(h.manifestPath!, 'utf8')
    const r = await reqPost(h.port, '/api/config/mandatory-skills', { phase: 'build', track: '_all', skills: ['x'] }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
    expect(await readFile(h.manifestPath!, 'utf8')).toBe(before)
  })

  it('含非法字符的 skill token（注入尝试：逗号 + 方括号 + 伪 key）→ 400，原文件逐字节不改动', async () => {
    const h = await startWithConfig()
    const before = await readFile(h.manifestPath!, 'utf8')
    const r = await reqPost(
      h.port,
      '/api/config/mandatory-skills',
      { phase: 'build', track: 'backend', skills: ['legit', 'evil], injected.key: [pwn'] },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    const body = r.json<{ ok: boolean; error: string }>()
    expect(body.ok).toBe(false)
    expect(await readFile(h.manifestPath!, 'utf8')).toBe(before) // 字节级不变——无注入生效
  })

  it('并发提交两个不同 phase.track（多标签页同时编辑）→ 都真生效、互不覆盖丢失', async () => {
    const h = await startWithConfig()
    const [r1, r2] = await Promise.all([
      reqPost(h.port, '/api/config/mandatory-skills', { phase: 'spec', track: 'frontend', skills: ['tab-1'] }, {
        headers: { Authorization: `Bearer ${h.token}` },
      }),
      reqPost(h.port, '/api/config/mandatory-skills', { phase: 'verify', track: 'backend', skills: ['tab-2'] }, {
        headers: { Authorization: `Bearer ${h.token}` },
      }),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const reparsed = loadManifest(h.manifestPath!)
    expect(reparsed.mandatorySkills.spec.frontend).toEqual(['tab-1'])
    expect(reparsed.mandatorySkills.verify.backend).toEqual(['tab-2'])
  })
})

describe('GET /api/loops/snapshot —— 跨项目聚合 loops.yaml', () => {
  it('capabilities.loops=true；无 loops.yaml 时返回空 rows 而非报错', async () => {
    const h = await start()
    const capRes = await reqGet(h.port, '/api/snapshot')
    expect(capRes.json<any>().capabilities.loops).toBe(true)

    const r = await reqGet(h.port, '/api/loops/snapshot')
    expect(r.status).toBe(200)
    expect(r.json<{ rows: unknown[] }>().rows).toEqual([])
  })
})

// ── loops 升降档写端点 ──
const SEED_LOOP_YAML_READY_FOR_L2 = `version: 1
loops:
  - id: build-loop
    name: build-loop 编排 loop
    kind: orchestrator
    goal: 每小时从队列发现立项跑通四门收编收敛到架构报告的单写者目标架构直至全部成功判据勾满
    cadence: 1h
    risk: medium
    runner: cron-session
    change_prefix: build-loop-
    phases:
      - decide
      - record
    human_gates:
      - P2 战略项只写提案
      - push/合并到远端
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/build-loop.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 1
      on_exceed: skip
      max_tokens_per_day: 100000
    kill_criteria:
      - backlog 连续 2 轮空
      - 同项连败 3 次
    autonomy_level: L1
`

describe('POST /api/loops/scope-preview —— 真实 Loop 路径策略预检', () => {
  it('复用受保护 POST 与生产 glob，返回逐路径解释且不改盘', async () => {
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    const yaml = `${SEED_LOOP_YAML_READY_FOR_L2.trimEnd()}
    allowlist:
      - src/**
      - docs/**
    denylist:
      - src/secrets/**
`
    const registryPath = join(h.root, '.pipeline', 'loops.yaml')
    await writeFile(registryPath, yaml, 'utf8')
    const before = await readFile(registryPath, 'utf8')

    const response = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root,
      loop_id: 'build-loop',
      paths: ['src/app.ts', 'src/secrets/key.txt', 'assets/logo.svg'],
    }, { headers: { Authorization: `Bearer ${h.token}` } })

    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      schema_version: 1,
      loop_id: 'build-loop',
      loop_status: 'active',
      autonomy_level: 'L1',
      enforced_for_unattended_merge: false,
      summary: { total: 3, allowed: 1, blocked: 2 },
      items: [
        { path: 'src/app.ts', verdict: 'allowed', reason: 'allowlist', matched_pattern: 'src/**' },
        { path: 'src/secrets/key.txt', verdict: 'blocked', reason: 'path-denied', matched_pattern: 'src/secrets/**' },
        { path: 'assets/logo.svg', verdict: 'blocked', reason: 'path-outside-allowlist', matched_pattern: null },
      ],
    })
    expect(await readFile(registryPath, 'utf8')).toBe(before)
  })

  it('稳定区分无效请求、未知 root、未知 Loop 与损坏 registry', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }

    const invalid = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['../secret'],
    }, auth)
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_REQUEST_INVALID' })
    const windowsAbsolute = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['C:/Windows/system32'],
    }, auth)
    expect(windowsAbsolute.status).toBe(400)
    expect(windowsAbsolute.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_REQUEST_INVALID' })
    const transportUnsafe = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['src/\"quoted\".ts'],
    }, auth)
    expect(transportUnsafe.status).toBe(400)
    expect(transportUnsafe.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_REQUEST_INVALID' })
    const surrogateExpansionPaths = Array.from({ length: 32 }, (_, index) => {
      const prefix = `src/${index}-`
      return `${prefix}${'\ud800'.repeat(Math.floor((1024 - Buffer.byteLength(prefix)) / 3))}`
    })
    const surrogateExpansion = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: surrogateExpansionPaths,
    }, auth)
    expect(surrogateExpansion.status).toBe(400)
    expect(surrogateExpansion.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_REQUEST_INVALID' })
    const trailingSurrogate = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['src/trailing-\ud800'],
    }, auth)
    expect(trailingSurrogate.status).toBe(400)
    expect(trailingSurrogate.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_REQUEST_INVALID' })

    const unknownRoot = await reqPost(h.port, '/api/loops/scope-preview', {
      root: '/tmp/not-registered', loop_id: 'build-loop', paths: ['src/app.ts'],
    }, auth)
    expect(unknownRoot.status).toBe(404)
    expect(unknownRoot.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_ROOT_NOT_FOUND' })

    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
    const posixColon = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['a:b', 'C:notes.txt'],
    }, auth)
    expect(posixColon.status).toBe(200)
    const maxBudgetPaths = Array.from({ length: 32 }, (_, index) => {
      const prefix = `src/${index}-`
      return `${prefix}${'a'.repeat(1024 - Buffer.byteLength(prefix))}`
    })
    const maxBudget = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: maxBudgetPaths,
    }, auth)
    expect(maxBudget.status).toBe(200)
    expect(maxBudget.json()).toMatchObject({ summary: { total: 32 } })
    const unknownLoop = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'missing-loop', paths: ['src/app.ts'],
    }, auth)
    expect(unknownLoop.status).toBe(404)
    expect(unknownLoop.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_LOOP_NOT_FOUND' })

    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), 'version: 1\nloops: invalid\n', 'utf8')
    const invalidRegistry = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['src/app.ts'],
    }, auth)
    expect(invalidRegistry.status).toBe(409)
    expect(invalidRegistry.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_REGISTRY_INVALID' })
  })

  it('将 registry I/O 故障与无效策略分开，返回稳定的 500 错误码', async () => {
    const h = await start()
    const pipelineDir = join(h.root, '.pipeline')
    const registryPath = join(pipelineDir, 'loops.yaml')
    await mkdir(pipelineDir, { recursive: true })
    await mkdir(registryPath)
    const response = await reqPost(h.port, '/api/loops/scope-preview', {
      root: h.root, loop_id: 'build-loop', paths: ['src/app.ts'],
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(response.status).toBe(500)
    expect(response.json()).toEqual({
      ok: false,
      code: 'LOOP_SCOPE_REGISTRY_READ_FAILED',
      error: 'Loop registry 读取失败',
    })
  })

  it('拒绝 .pipeline 或 loops.yaml symlink，且不读取 root 外策略', async () => {
    const { mkdtemp, rm, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const authFor = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

    const pipelineLinked = await start()
    const outsidePipeline = await mkdtemp(join(tmpdir(), 'loop-scope-pipeline-link-'))
    await writeFile(join(outsidePipeline, 'loops.yaml'), SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
    await symlink(outsidePipeline, join(pipelineLinked.root, '.pipeline'), 'dir')
    const pipelineResponse = await reqPost(pipelineLinked.port, '/api/loops/scope-preview', {
      root: pipelineLinked.root, loop_id: 'build-loop', paths: ['src/app.ts'],
    }, authFor(pipelineLinked.token))
    expect(pipelineResponse.status).toBe(403)
    expect(pipelineResponse.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_ROOT_UNTRUSTED' })

    const fileLinked = await start()
    const outsideFileDir = await mkdtemp(join(tmpdir(), 'loop-scope-file-link-'))
    const outsideFile = join(outsideFileDir, 'loops.yaml')
    await writeFile(outsideFile, SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
    await mkdir(join(fileLinked.root, '.pipeline'))
    await symlink(outsideFile, join(fileLinked.root, '.pipeline', 'loops.yaml'), 'file')
    const fileResponse = await reqPost(fileLinked.port, '/api/loops/scope-preview', {
      root: fileLinked.root, loop_id: 'build-loop', paths: ['src/app.ts'],
    }, authFor(fileLinked.token))
    expect(fileResponse.status).toBe(403)
    expect(fileResponse.json()).toMatchObject({ ok: false, code: 'LOOP_SCOPE_ROOT_UNTRUSTED' })

    await rm(outsidePipeline, { recursive: true, force: true })
    await rm(outsideFileDir, { recursive: true, force: true })
  })

  it('沿用公共 POST 的 token 与 JSON content-type 安全闸', async () => {
    const h = await start()
    const body = { root: h.root, loop_id: 'build-loop', paths: ['src/app.ts'] }
    expect((await reqPost(h.port, '/api/loops/scope-preview', body)).status).toBe(401)
    expect((await reqPost(h.port, '/api/loops/scope-preview', body, {
      headers: {
        Authorization: `Bearer ${h.token}`,
        'Content-Type': 'text/plain',
      },
    })).status).toBe(400)
  })
})

describe('POST /api/loops/level —— 升降档写回', () => {
  it('对 token + root 在注册表里 → 200 且真改盘 loops.yaml', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    // seed 一个已就绪的 loop（readiness 会满足 L1→L2）到 h.root
    // 需要：registry + LOOP.md（防镜像漂移）+ progress.md（运行流水）
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
    await writeFile(join(h.root, 'LOOP.md'), '# LOOP.md\n\n### `build-loop` — build-loop 协议\n\n- goal：见 registry\n', 'utf8')
    await mkdir(join(h.root, '.superpowers', 'loops'), { recursive: true })
    await writeFile(
      join(h.root, '.superpowers', 'loops', 'progress.md'),
      '| ts | loop | action | inflight | note |\n|----|------|--------|----------|------|\n| 2026-07-06T23:30 | build-loop | run | 0 | result=ok change=build-loop-3 |\n',
      'utf8',
    )

    const r = await reqPost(
      h.port,
      '/api/loops/level',
      { root: h.root, id: 'build-loop', target: 'L2' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
    const body = r.json<{ applied: boolean }>()
    expect(body.applied).toBe(true)
    const text = readFile(join(h.root, '.pipeline', 'loops.yaml'), 'utf8')
    expect(await text).toContain('autonomy_level: L2')
  })

  it('root 不在机器级注册表里 → 404，不改盘', async () => {
    const h = await start()
    const r = await reqPost(
      h.port,
      '/api/loops/level',
      { root: '/tmp/not-registered', id: 'x', target: 'L2' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(404)
  })

  it('无 token → 401', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/loops/level', { root: h.root, id: 'build-loop', target: 'L2' })
    expect(r.status).toBe(401)
  })

  it('root 以非规范但等价形式提交（结尾多一个斜杠）→ 仍视为已注册（200），两侧规范化后比较（同 transition 端点模式）', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
    await writeFile(join(h.root, 'LOOP.md'), '# LOOP.md\n\n### `build-loop` — build-loop 协议\n\n- goal：见 registry\n', 'utf8')
    await mkdir(join(h.root, '.superpowers', 'loops'), { recursive: true })
    await writeFile(
      join(h.root, '.superpowers', 'loops', 'progress.md'),
      '| ts | loop | action | inflight | note |\n|----|------|--------|----------|------|\n| 2026-07-06T23:30 | build-loop | run | 0 | result=ok change=build-loop-3 |\n',
      'utf8',
    )

    const r = await reqPost(
      h.port,
      '/api/loops/level',
      { root: `${h.root}/`, id: 'build-loop', target: 'L2' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
    const body = r.json<{ applied: boolean }>()
    expect(body.applied).toBe(true)
  })

  it('root/id/target 为空字符串 → 400（不该落入 404 registry-miss 或 200 内核错误信封）', async () => {
    const h = await start()
    const base = { root: h.root, id: 'build-loop', target: 'L2' }
    const cases = [
      { ...base, root: '' },
      { ...base, id: '' },
      { ...base, target: '' },
    ]
    for (const body of cases) {
      const r = await reqPost(h.port, '/api/loops/level', body, {
        headers: { Authorization: `Bearer ${h.token}` },
      })
      expect(r.status).toBe(400)
    }
  })

  it('graduation 逻辑拒绝（跨级 L1→L3）→ 400 而非 200，body.applied=false（whole-branch review 抓出的真实回归：此前不管 applyLevelChange 是否真的应用了改档，一律 200，前端只看 res.ok 会把一次真实拒绝误当成功）', async () => {
    const { mkdir, writeFile, readFile: rf } = await import('node:fs/promises')
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
    await writeFile(join(h.root, 'LOOP.md'), '# LOOP.md\n\n### `build-loop` — build-loop 协议\n\n- goal：见 registry\n', 'utf8')
    await mkdir(join(h.root, '.superpowers', 'loops'), { recursive: true })
    await writeFile(
      join(h.root, '.superpowers', 'loops', 'progress.md'),
      '| ts | loop | action | inflight | note |\n|----|------|--------|----------|------|\n| 2026-07-06T23:30 | build-loop | run | 0 | result=ok change=build-loop-3 |\n',
      'utf8',
    )

    // L1 直接跳 L3（合法目标档字符串，但 planLevelChange 判定 reject-cross-level，绝不允许一步跨级）
    const r = await reqPost(
      h.port,
      '/api/loops/level',
      { root: h.root, id: 'build-loop', target: 'L3' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    const body = r.json<{ applied: boolean; exitCode: number; errors: string[] }>()
    expect(body.applied).toBe(false)
    expect(body.exitCode).toBe(2)
    expect(body.errors.length).toBeGreaterThan(0)
    // 真没改盘：loops.yaml 仍是原始 L1，不是误应用后的 L3
    const text = await rf(join(h.root, '.pipeline', 'loops.yaml'), 'utf8')
    expect(text).toContain('autonomy_level: L1')
  })
})

describe('POST /api/loops/update —— loops.yaml 字段写回（v5 T3）', () => {
  async function seedLoops(root: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'loops.yaml'), SEED_LOOP_YAML_READY_FOR_L2, 'utf8')
  }

  it('带 token + root 已注册 → 200 且真改盘（cadence + denylist）', async () => {
    const h = await start()
    await seedLoops(h.root)
    const r = await reqPost(
      h.port,
      '/api/loops/update',
      { root: h.root, id: 'build-loop', patch: { cadence: '2h', denylist: ['secrets/**'] } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
    expect(r.json<{ ok: boolean }>().ok).toBe(true)
    const text = await readFile(join(h.root, '.pipeline', 'loops.yaml'), 'utf8')
    expect(text).toContain('cadence: 2h')
    expect(text).toContain('denylist:')
    expect(text).toContain('- secrets/**')
  })

  it('H11：HTTP activation 把完整 candidate registry 路由给 validator，通过后才写 active', async () => {
    const validateLoopActivation = vi.fn<LoopActivationValidator>(async (input) => {
      expect(input.candidate.loops.find((loop) => loop.id === 'build-loop')?.status).toBe('active')
      expect(input.previous.loops.find((loop) => loop.id === 'build-loop')?.status).toBe('paused')
      return { ok: true }
    })
    const h = await start({ validateLoopActivation })
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(
      join(h.root, '.pipeline', 'loops.yaml'),
      SEED_LOOP_YAML_READY_FOR_L2
        .replace('runner: cron-session', 'runner: codex')
        .replace('status: active', 'status: paused')
        + '    template_id: daily-triage\n'
        + '    template_version: 1\n'
        + '    workflow_id: default\n'
        + '    skill_bundle_id: backend\n',
      'utf8',
    )

    const response = await reqPost(
      h.port,
      '/api/loops/update',
      { root: h.root, id: 'build-loop', patch: { status: 'active' } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(response.status).toBe(200)
    expect(validateLoopActivation).toHaveBeenCalledTimes(2)
    expect(await readFile(join(h.root, '.pipeline', 'loops.yaml'), 'utf8')).toContain('status: active')
  })

  it('无 token → 401', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/loops/update', { root: h.root, id: 'build-loop', patch: { cadence: '2h' } })
    expect(r.status).toBe(401)
  })

  it('root 不在机器级注册表 → 404', async () => {
    const h = await start()
    const r = await reqPost(
      h.port,
      '/api/loops/update',
      { root: '/tmp/not-registered', id: 'build-loop', patch: { cadence: '2h' } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(404)
  })

  it('未知 loop id → 400', async () => {
    const h = await start()
    await seedLoops(h.root)
    const r = await reqPost(
      h.port,
      '/api/loops/update',
      { root: h.root, id: 'ghost-loop', patch: { cadence: '2h' } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
  })

  it('schema 校验失败（risk 非枚举值）→ 400，不改盘', async () => {
    const h = await start()
    await seedLoops(h.root)
    const before = await readFile(join(h.root, '.pipeline', 'loops.yaml'), 'utf8')
    const r = await reqPost(
      h.port,
      '/api/loops/update',
      { root: h.root, id: 'build-loop', patch: { risk: 'ultra' } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    expect(await readFile(join(h.root, '.pipeline', 'loops.yaml'), 'utf8')).toBe(before)
  })

  it('patch 含 autonomy_level → 400（升降档只走 /api/loops/level）', async () => {
    const h = await start()
    await seedLoops(h.root)
    const r = await reqPost(
      h.port,
      '/api/loops/update',
      { root: h.root, id: 'build-loop', patch: { autonomy_level: 'L2' } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
  })

  it('root/id 缺失或 patch 非对象/空对象 → 400', async () => {
    const h = await start()
    const cases = [
      { id: 'build-loop', patch: { cadence: '2h' } },
      { root: h.root, patch: { cadence: '2h' } },
      { root: h.root, id: 'build-loop' },
      { root: h.root, id: 'build-loop', patch: 'cadence=2h' },
      { root: h.root, id: 'build-loop', patch: {} },
    ]
    for (const body of cases) {
      const r = await reqPost(h.port, '/api/loops/update', body, { headers: { Authorization: `Bearer ${h.token}` } })
      expect(r.status).toBe(400)
    }
  })
})

describe('POST /api/afk/:name/cancel —— 取消运行中的 automation 任务（afk-workbench Task 4）', () => {
  it('running 状态且 automation_sandbox 非空 → 落 .cancel-requested 标记 + docker kill + 200', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'running')
    await h.store.set(h.changeDir, 'automation_sandbox', 'sandcastle-test-container-not-real')
    await h.store.set(h.changeDir, 'automation_worktree', h.worktreeDir) // 测试 fixture 需真建这个目录
    const r = await reqPost(h.port, `/api/afk/${h.name}/cancel`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(existsSync(join(h.worktreeDir, '.cancel-requested'))).toBe(true)
  })

  it('automation 状态不是 running → 400，且不落标记文件（早退，无副作用）', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'paused')
    const r = await reqPost(h.port, `/api/afk/${h.name}/cancel`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
    expect(existsSync(join(h.worktreeDir, '.cancel-requested'))).toBe(false)
  })

  it('running 但 automation_sandbox 为空（容器名缺失，无法定位要 kill 的容器）→ 400，不落标记文件', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'running')
    await h.store.set(h.changeDir, 'automation_worktree', h.worktreeDir)
    // 故意不设 automation_sandbox
    const r = await reqPost(h.port, `/api/afk/${h.name}/cancel`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
    expect(existsSync(join(h.worktreeDir, '.cancel-requested'))).toBe(false)
  })

  it('change 名合法但该 change 实际不存在（无 .pipeline.yaml）→ 400，而非 500（kernel store.get 会 ENOENT）', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/afk/does-not-exist/cancel', { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('root 不在注册表（不可信项目）→ 404，同 transition 端点共用的信任锚模式', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'running')
    await h.store.set(h.changeDir, 'automation_sandbox', 'sandcastle-test-container-not-real')
    await h.store.set(h.changeDir, 'automation_worktree', h.worktreeDir)
    const r = await reqPost(h.port, `/api/afk/${h.name}/cancel`, { root: '/tmp/not-registered' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(404)
    expect(existsSync(join(h.worktreeDir, '.cancel-requested'))).toBe(false)
  })

  it('automation_worktree 指向不存在的目录（深路径截断/已清理类损坏）→ 400 干净错误，不 500、不泄漏原始全路径（真机 P1）', async () => {
    const h = await start()
    // 模拟真机现场：字段里存的是坏路径（曾被 200 字符截断成 "…/sandcastle-pipeline-af" 一类），磁盘上不存在
    const bogusWorktree = join(h.worktreeDir, 'truncated-away', 'sandcastle-pipeline-af')
    await h.store.set(h.changeDir, 'automation', 'running')
    await h.store.set(h.changeDir, 'automation_sandbox', 'sandcastle-test-container-not-real')
    await h.store.set(h.changeDir, 'automation_worktree', bogusWorktree)
    const r = await reqPost(h.port, `/api/afk/${h.name}/cancel`, { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400) // writeFile ENOENT 裸抛会走顶层兜底 catch 变 500（RED）
    const body = r.json<{ ok: boolean; error?: string }>()
    expect(body.ok).toBe(false)
    expect(body.error).toBeTruthy()
    expect(body.error!).not.toContain(bogusWorktree) // 原始 ENOENT 全路径不得泄漏进响应体
  })

  it('无 token → 401（确认新路由确实接在 handlePost 统一鉴权守卫之后，而非绕过）', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'running')
    await h.store.set(h.changeDir, 'automation_sandbox', 'sandcastle-test-container-not-real')
    await h.store.set(h.changeDir, 'automation_worktree', h.worktreeDir)
    const r = await reqPost(h.port, `/api/afk/${h.name}/cancel`, { root: h.root })
    expect(r.status).toBe(401)
    expect(existsSync(join(h.worktreeDir, '.cancel-requested'))).toBe(false)
  })

  it('非法 change 名（.. 路径穿越尝试）→ 400，同 transition 端点的 change 名校验', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${encodeURIComponent('..')}/cancel`, { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })
})

describe('POST /api/afk/:name/retry —— 重试 failed/conflict/paused 任务（afk-workbench Task 5）', () => {
  it.each(['failed', 'conflict', 'paused'])('automation=%s → CAS 回 queued + 200，automation_attempts 清零', async (from) => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', from)
    await h.store.set(h.changeDir, 'automation_attempts', '3')
    const r = await reqPost(h.port, `/api/afk/${h.name}/retry`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('queued')
    expect(await h.store.get(h.changeDir, 'automation_attempts')).toBe('0')
  })

  it('automation=running → 400（运行中不可重试，应先取消）', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'running')
    const r = await reqPost(h.port, `/api/afk/${h.name}/retry`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
  })

  it('change 名合法但该 change 实际不存在（无 .pipeline.yaml）→ 400，而非 500（同 cancel 端点已修的同类 ENOENT 坑）', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/afk/does-not-exist/retry', { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('root 不在注册表（不可信项目）→ 404，同 transition/cancel 端点共用的信任锚模式，且不改盘', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'failed')
    const r = await reqPost(h.port, `/api/afk/${h.name}/retry`, { root: '/tmp/not-registered' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(404)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('failed')
  })

  it('无 token → 401（确认新路由确实接在 handlePost 统一鉴权守卫之后，而非绕过），且不改盘', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'failed')
    const r = await reqPost(h.port, `/api/afk/${h.name}/retry`, { root: h.root })
    expect(r.status).toBe(401)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('failed')
  })

  it('非法 change 名（.. 路径穿越尝试）→ 400，同 transition/cancel 端点的 change 名校验', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${encodeURIComponent('..')}/retry`, { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })
})

describe('POST /api/afk/:name/dismiss —— 放弃 failed/conflict 任务（v5-T11，决议 #4）', () => {
  it.each(['failed', 'conflict'])('automation=%s → CAS 回 off + 200，现场字段（last_error/worktree/attempts）原样保留', async (from) => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', from)
    await h.store.set(h.changeDir, 'automation_attempts', '3')
    await h.store.set(h.changeDir, 'automation_last_error', 'verify 失败：2 个用例未过')
    await h.store.set(h.changeDir, 'automation_worktree', h.worktreeDir)
    const r = await reqPost(h.port, `/api/afk/${h.name}/dismiss`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('off')
    // 现场保留（决议 #4）：放弃只退出自动化，事后尸检线索一个不清
    expect(await h.store.get(h.changeDir, 'automation_attempts')).toBe('3')
    expect(await h.store.get(h.changeDir, 'automation_last_error')).toBe('verify 失败：2 个用例未过')
    expect(await h.store.get(h.changeDir, 'automation_worktree')).toBe(h.worktreeDir)
  })

  it.each(['running', 'paused', 'queued', 'off'])('automation=%s → 400（仅 failed/conflict 可放弃），且不改盘', async (from) => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', from)
    const r = await reqPost(h.port, `/api/afk/${h.name}/dismiss`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
    expect(await h.store.get(h.changeDir, 'automation')).toBe(from)
  })

  it('change 名合法但该 change 实际不存在（无 .pipeline.yaml）→ 400，而非 500（同 cancel/retry 端点已修的同类 ENOENT 坑）', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/afk/does-not-exist/dismiss', { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('root 不在注册表（不可信项目）→ 404，同 transition/cancel/retry 端点共用的信任锚模式，且不改盘', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'failed')
    const r = await reqPost(h.port, `/api/afk/${h.name}/dismiss`, { root: '/tmp/not-registered' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(404)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('failed')
  })

  it('无 token → 401（确认新路由确实接在 handlePost 统一鉴权守卫之后，而非绕过），且不改盘', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'failed')
    const r = await reqPost(h.port, `/api/afk/${h.name}/dismiss`, { root: h.root })
    expect(r.status).toBe(401)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('failed')
  })

  it('非法 change 名（.. 路径穿越尝试）→ 400，同 transition/cancel/retry 端点的 change 名校验', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${encodeURIComponent('..')}/dismiss`, { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })
})

describe('POST /api/afk/:name/enqueue —— 挂入 AFK 队列（afk-workbench 缺口修复，真机验证发现）', () => {
  it('automation 未设（新 change）→ 200，automation=queued + automation_queued_at 落真时间戳', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('queued')
    expect(await h.store.get(h.changeDir, 'automation_queued_at')).not.toBe('')
  })

  it('automation=off（显式）→ 200，同未设语义一致', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'off')
    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('queued')
  })

  it('已经 queued/running 等非 off 态 → 400，不重复挂队（而非静默幂等成功）', async () => {
    const h = await start()
    await h.store.set(h.changeDir, 'automation', 'running')
    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('running')
  })

  it('PM track → 200：显式 AFK 请求进入同一授权队列', async () => {
    // start() 的本地 harness 不接受 track 覆盖（固定走 initChange 默认 backend）——真设置
    // track 字段本身就是本端点要判定的前置状态，这里直接调 store.set 覆盖，同本文件其它
    // "先摆好状态再断言判定"用例的一致写法（如上面 cancel/retry 系列对 automation 字段的做法）。
    const h = await start()
    await h.store.set(h.changeDir, 'track', 'pm')
    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(await h.store.get(h.changeDir, 'automation')).toBe('queued')
  })

  it('动态 data track 的 automationEligible=false → 400（与 track id 无关）', async () => {
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: data
    label: Data
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: pending
      automation_eligible: false
      coverage_profile: backend
      routing:
        enabled: false
      skills:
        matrix: true
        profile: backend
`, 'utf8')
    await h.store.set(h.changeDir, 'track', 'data')

    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: h.root }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
    expect(await h.store.get(h.changeDir, 'automation')).not.toBe('queued')
  })

  it('change 名合法但该 change 实际不存在（无 .pipeline.yaml）→ 400，同 cancel/retry 端点已修的同类 ENOENT 坑', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/afk/does-not-exist/enqueue', { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('root 不在注册表（不可信项目）→ 404，同 cancel/retry 端点共用的信任锚模式，且不改盘', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: '/tmp/not-registered' }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(404)
    expect(await h.store.get(h.changeDir, 'automation')).not.toBe('queued')
  })

  it('无 token → 401（确认新路由确实接在 handlePost 统一鉴权守卫之后，而非绕过），且不改盘', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${h.name}/enqueue`, { root: h.root })
    expect(r.status).toBe(401)
    expect(await h.store.get(h.changeDir, 'automation')).not.toBe('queued')
  })

  it('非法 change 名（.. 路径穿越尝试）→ 400，同 transition/cancel/retry 端点的 change 名校验', async () => {
    const h = await start()
    const r = await reqPost(h.port, `/api/afk/${encodeURIComponent('..')}/enqueue`, { root: h.root }, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/afk/:name/log —— 单个 change 的原始运行日志文本（afk-workbench Task 6）', () => {
  it('change 目录内有 .sandcastle-run.log → 原样返回内容', async () => {
    const h = await start()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(h.changeDir, '.sandcastle-run.log'), 'line1\nline2\n', 'utf8')
    const r = await reqGet(h.port, `/api/afk/${h.name}/log?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ log: string }>().log).toBe('line1\nline2\n')
  })

  it('没有日志文件 → { log: null }，不是 404', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/afk/${h.name}/log?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ log: string | null }>().log).toBeNull()
  })

  it('root 不在注册表（不可信项目）→ 404，同 cancel/retry 端点共用的信任锚模式', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/afk/${h.name}/log?root=${encodeURIComponent('/tmp/not-registered')}`)
    expect(r.status).toBe(404)
    // 精确匹配信任锚校验的错误文案（而非落到路由表尾部「未知端点」兜底 404）——证明真走了本端点的 root 校验分支。
    expect(r.json<{ error: string }>().error).toBe('root 未在机器级项目注册表中')
  })

  it('非法 change 名（.. 路径穿越尝试）→ 400，同 cancel/retry 端点的 change 名校验', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/afk/${encodeURIComponent('..')}/log?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(400)
  })

  it('change 名合法但该 change 实际不存在（无 .pipeline.yaml）→ 400，同 cancel/retry 端点对同一存在性前置校验的约定，不与「还没日志」的 200 混淆', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/afk/does-not-exist/log?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(400)
    // 精确匹配 ENOENT 前置校验的错误文案（而非落到路由表尾部「未知端点」兜底 404）——证明真走了 changeDir 存在性校验分支。
    expect(r.json<{ error: string }>().error).toBe('找不到该 change（无 canonical/legacy 状态）')
  })
})

describe('GET /api/workflow-definition-status —— frozen/current 只读比较', () => {
  const route = (root: string, change = 'my-change'): string =>
    `/api/workflow-definition-status?root=${encodeURIComponent(root)}&change=${encodeURIComponent(change)}`

  it('从真 canonical Change 返回 default current，且读取不修改状态', async () => {
    const h = await start()
    const before = await h.store.read(h.changeDir)
    const response = await reqGet(h.port, route(h.root))

    expect(response.status).toBe(200)
    const body = response.json<{
      schema: string
      workflow: string
      status: string
      frozen_fingerprint: string
      current_fingerprint: string
    }>()
    expect(body).toEqual({
      schema: 'workflow-definition-status/v1',
      workflow: 'default',
      status: 'current',
      frozen_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      current_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(body.current_fingerprint).toBe(body.frozen_fingerprint)
    expect(await h.store.read(h.changeDir)).toEqual(before)
  })

  it('把旧 Change 诚实投影为 unavailable，并保留输入边界', async () => {
    const legacy = await start({ legacyWithoutRunIdentity: true })
    const unavailable = await reqGet(legacy.port, route(legacy.root))
    expect(unavailable.status).toBe(200)
    expect(unavailable.json()).toMatchObject({
      schema: 'workflow-definition-status/v1',
      workflow: 'default',
      status: 'unavailable',
      frozen_fingerprint: null,
      current_fingerprint: null,
    })

    const invalid = await reqGet(legacy.port, route(legacy.root, '../escape'))
    expect(invalid.status).toBe(400)
    const unregistered = await reqGet(legacy.port, route('/tmp/not-registered'))
    expect(unregistered.status).toBe(404)
  })

  it('缺少显式 root 时拒绝请求，不把 server cwd 当作可信项目', async () => {
    const h = await start()
    const response = await reqGet(
      h.port,
      `/api/workflow-definition-status?change=${encodeURIComponent(h.name)}`,
    )
    expect(response.status).toBe(400)
    expect(response.json()).toEqual({ ok: false, error: '缺少 root' })
  })
})

describe('GET /api/orchestration-graph —— Change 编排图', () => {
  const route = (root: string, change = 'my-change'): string =>
    `/api/orchestration-graph?root=${encodeURIComponent(root)}&change=${encodeURIComponent(change)}`

  it('从真 canonical Change/snapshot 返回稳定只读图并嵌入 definition 诊断', async () => {
    const h = await start()
    const before = await h.store.read(h.changeDir)
    const response = await reqGet(h.port, route(h.root))

    expect(response.status).toBe(200)
    const body = response.json<{
      schema: string
      scope: { root: string; change: string }
      nodes: Array<{ id: string; kind: string; status: string | null }>
      edges: Array<{ id: string; kind: string; source: string; target: string }>
    }>()
    expect(body.schema).toBe('tenon-orchestration-graph/v1')
    expect(body.scope).toEqual({ root: h.root, change: h.name })
    expect(body.nodes.find((node) => node.kind === 'workflow')).toMatchObject({ status: 'current' })
    expect(body.nodes.some((node) => node.kind === 'change')).toBe(true)
    expect(body.nodes.some((node) => node.kind === 'phase')).toBe(true)
    expect(body.edges.some((edge) => edge.kind === 'governs')).toBe(true)
    const ids = new Set(body.nodes.map((node) => node.id))
    expect(body.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true)
    expect(await h.store.read(h.changeDir)).toEqual(before)
  })

  it('拒绝非法 change 与未注册 root', async () => {
    const h = await start()
    expect((await reqGet(h.port, route(h.root, '../escape'))).status).toBe(400)
    expect((await reqGet(h.port, route('/tmp/not-registered'))).status).toBe(404)
    const missingRoot = await reqGet(h.port, '/api/orchestration-graph?change=my-change')
    expect(missingRoot.status).toBe(400)
    expect(missingRoot.json()).toMatchObject({ code: 'ORCHESTRATION_ROOT_REQUIRED' })
  })

  it('只读目标 canonical Change，不重建缺失的 YAML projection', async () => {
    const h = await start()
    await unlink(join(h.changeDir, '.pipeline.yaml'))

    const response = await reqGet(h.port, route(h.root))

    expect(response.status).toBe(200)
    expect(await h.store.inspectProjection(h.changeDir)).toMatchObject({ status: 'missing' })
  })

  it('Change 目录或 canonical 父目录是外部 symlink 时 fail closed', async () => {
    const changeLinked = await start()
    const outsideRoot = await makeProject()
    const outsideDir = await initChange(changeLinked.store, outsideRoot, changeLinked.name)
    await rename(changeLinked.changeDir, `${changeLinked.changeDir}.original`)
    await symlink(outsideDir, changeLinked.changeDir, 'dir')

    const graphLinked = await reqGet(changeLinked.port, route(changeLinked.root))
    const definitionLinked = await reqGet(
      changeLinked.port,
      `/api/workflow-definition-status?root=${encodeURIComponent(changeLinked.root)}&change=${changeLinked.name}`,
    )
    expect(graphLinked.status).toBe(403)
    expect(graphLinked.json()).toMatchObject({ code: 'ORCHESTRATION_CHANGE_FORBIDDEN' })
    expect(definitionLinked.status).toBe(403)
    expect(JSON.stringify(graphLinked.json())).not.toContain(outsideRoot)
    expect(JSON.stringify(definitionLinked.json())).not.toContain(outsideRoot)

    const runLinked = await start()
    const runDir = join(runLinked.changeDir, '.pipeline-run')
    const outsideRunDir = join(await makeProject(), 'outside-run')
    await rename(runDir, outsideRunDir)
    await symlink(outsideRunDir, runDir, 'dir')
    const graphRunLinked = await reqGet(runLinked.port, route(runLinked.root))
    const definitionRunLinked = await reqGet(
      runLinked.port,
      `/api/workflow-definition-status?root=${encodeURIComponent(runLinked.root)}&change=${runLinked.name}`,
    )
    expect(graphRunLinked.status).toBe(403)
    expect(graphRunLinked.json()).toMatchObject({ code: 'ORCHESTRATION_CHANGE_FORBIDDEN' })
    expect(definitionRunLinked.status).toBe(403)
    expect(JSON.stringify(graphRunLinked.json())).not.toContain(outsideRunDir)
    expect(JSON.stringify(definitionRunLinked.json())).not.toContain(outsideRunDir)
  })

  it('可信 canonical state 的非法 UTF-8 是 unreadable 500，不误报 path forbidden', async () => {
    const h = await start()
    await writeFile(join(h.changeDir, '.pipeline-run', 'current.json'), Buffer.from([0xff]))

    const response = await reqGet(h.port, route(h.root))
    expect(response.status).toBe(500)
    expect(response.json()).toMatchObject({ code: 'ORCHESTRATION_CHANGE_UNREADABLE' })
  })

  it('legacy custom workflow leaf 指向 root 外时有界失败且不投影外部定义', async () => {
    const h = await start({
      legacyWithoutRunIdentity: true,
      initialWorkflow: { workflow: 'legacy', phase: 'external' },
      seedGovernedEvidence: false,
    })
    const workflows = join(h.root, '.pipeline', 'workflows')
    const outsideRoot = await makeProject()
    const outsideWorkflow = join(outsideRoot, 'legacy.yaml')
    await mkdir(workflows, { recursive: true })
    await writeFile(outsideWorkflow, [
      'name: legacy',
      'steps:',
      '  - id: external',
      '    label: External secret label',
      '    gate: null',
      '    skills: []',
      '    inputs: []',
      '    outputs: []',
      '    guards: []',
      '    transitions: []',
      '',
    ].join('\n'), 'utf8')
    await symlink(outsideWorkflow, join(workflows, 'legacy.yaml'), 'file')

    const response = await reqGet(h.port, route(h.root))
    expect(response.status).toBe(403)
    expect(response.json()).toMatchObject({ code: 'ORCHESTRATION_DEFINITION_FORBIDDEN' })
    expect(JSON.stringify(response.json())).not.toContain(outsideRoot)
    expect(JSON.stringify(response.json())).not.toContain('External secret label')
  })

  it('frozen custom workflow 的当前 definition 变成外部 symlink 时返回 definition 403', async () => {
    const h = await start()
    const workflows = join(h.root, '.pipeline', 'workflows')
    const currentWorkflow = join(workflows, 'modern.yaml')
    await mkdir(workflows, { recursive: true })
    await writeFile(currentWorkflow, [
      'name: modern',
      'steps:',
      '  - id: external',
      '    label: Frozen safe label',
      '    gate: null',
      '    skills: []',
      '    inputs: []',
      '    outputs: []',
      '    guards: []',
      '    transitions: []',
      '',
    ].join('\n'), 'utf8')
    const plan = loadEffectiveWorkflowPlan(h.root, 'modern')
    await createWorkflowRunRepository({
      store: h.store,
      recordStore: createTransitionRecordStore(),
      clock: () => '2026-07-30T00:00:00Z',
    }).initChange({
      repoRoot: h.root,
      name: 'modern-change',
      track: 'backend',
      reviewSeed: builtinTrack('backend').policyProfile.reviewSeed,
      preset: 'full',
      initialWorkflow: {
        workflow: 'modern',
        phase: 'external',
        ...effectiveWorkflowPlanBinding(plan),
        workflowPlanSnapshot: workflowPlanSnapshot(plan),
      },
    })
    const outsideRoot = await makeProject()
    const outsideWorkflow = join(outsideRoot, 'modern.yaml')
    await writeFile(outsideWorkflow, [
      'name: modern',
      'steps:',
      '  - id: leaked',
      '    label: External secret label',
      '    gate: null',
      '    skills: []',
      '    inputs: []',
      '    outputs: []',
      '    guards: []',
      '    transitions: []',
      '',
    ].join('\n'), 'utf8')
    await unlink(currentWorkflow)
    await symlink(outsideWorkflow, currentWorkflow, 'file')

    const response = await reqGet(h.port, route(h.root, 'modern-change'))
    expect(response.status).toBe(403)
    expect(response.json()).toMatchObject({ code: 'ORCHESTRATION_DEFINITION_FORBIDDEN' })
    expect(JSON.stringify(response.json())).not.toContain(outsideRoot)
    expect(JSON.stringify(response.json())).not.toContain('External secret label')
  })
})

describe('GET /api/workflows —— 列出自定义 workflow（GOAL E8）', () => {
  it('root 未在注册表 → 404', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent('/tmp/not-registered')}`)
    expect(r.status).toBe(404)
  })

  it('进程外动态新增 registry 条目 → 首个 workflow 请求一次性捕获可信 inode 锚', async () => {
    const store = newStore()
    const root = await makeProject()
    const roots: string[] = []
    const srv = createDashboardServer({
      paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
      token: 'dynamic-registry-token',
      registry: () => roots,
      store,
      flow: testFlow(),
    })
    openServers.push(srv)
    const { port } = await srv.listen(0, '127.0.0.1')
    roots.push(root)

    const r = await reqGet(port, `/api/workflows?root=${encodeURIComponent(root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ names: string[] }>().names).toEqual([])
  })

  it('真扫 .pipeline/workflows/*.yaml，排除 default，200 返回 names', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    const wf = 'name: onboarding\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n'
    await writeFile(join(dir, 'onboarding.yaml'), wf, 'utf8')
    await writeFile(join(dir, 'default.yaml'), wf.replace('onboarding', 'default'), 'utf8')
    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ names: string[] }>().names).toEqual(['onboarding'])
  })

  it('无 .pipeline/workflows 目录 → 200 + 空数组（不是错误）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ names: string[] }>().names).toEqual([])
  })

  it('server 启动后 registered root 被改名并在原路径换成外部 symlink → 403，绝不读取外部 workflow', async () => {
    const { mkdir, mkdtemp, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const originalRoot = `${h.root}.registered-inode`
    const outside = await mkdtemp(join(tmpdir(), 'wf-root-swap-outside-'))
    const outsideDir = join(outside, '.pipeline', 'workflows')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'outside.yaml'), 'name: outside\nsteps: []\n', 'utf8')
    await rename(h.root, originalRoot)
    await symlink(outside, h.root, 'dir')

    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('outside')
  })

  it('.pipeline 是外部 symlink → 500，list 不返回外部名称', async () => {
    const { mkdir, mkdtemp, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-list-pipeline-link-'))
    await mkdir(join(outside, 'workflows'))
    await writeFile(join(outside, 'workflows', 'outside.yaml'), 'name: outside\nsteps: []\n', 'utf8')
    await symlink(outside, join(h.root, '.pipeline'), 'dir')

    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('"outside"')
  })

  it('workflows 是外部 symlink → 500，list 不返回外部名称', async () => {
    const { mkdir, mkdtemp, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-list-workflows-link-'))
    await writeFile(join(outside, 'outside.yaml'), 'name: outside\nsteps: []\n', 'utf8')
    await mkdir(join(h.root, '.pipeline'))
    await symlink(outside, join(h.root, '.pipeline', 'workflows'), 'dir')

    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('"outside"')
  })

  it('列表中的 *.yaml 目标是外部 symlink → 500，不广告该名称', async () => {
    const { mkdir, mkdtemp, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-list-target-link-'))
    const outsideFile = join(outside, 'victim.yaml')
    const dir = join(h.root, '.pipeline', 'workflows')
    await writeFile(outsideFile, 'name: victim\nsteps: []\n', 'utf8')
    await mkdir(dir, { recursive: true })
    await symlink(outsideFile, join(dir, 'victim.yaml'), 'file')

    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('"victim"')
  })
})

describe('GET /api/workflows/:name —— 读单个 workflow（GOAL E8）', () => {
  it('真读 + 解析，200 返回 WorkflowDef', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'onboarding.yaml'),
      'name: onboarding\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n',
      'utf8',
    )
    const r = await reqGet(h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<{ name: string; steps: Array<{ id: string }> }>()
    expect(body.name).toBe('onboarding')
    expect(body.steps.map((s) => s.id)).toEqual(['s1'])
  })

  it('插件内建 simple workflow 无需项目文件，并且项目同名文件不能覆盖它', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'simple.yaml'),
      'name: simple\nsteps:\n  - id: shadow\n    label: shadow\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n',
      'utf8',
    )

    const r = await reqGet(h.port, `/api/workflows/simple?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<{ name: string; steps: Array<{ id: string }> }>()
    expect(body.name).toBe('simple')
    expect(body.steps.map((step) => step.id)).toEqual(['change', 'verify', 'done', 'escalated'])
    expect(r.body).not.toContain('shadow')
  })

  it('workflow 不存在 → 404', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows/ghost?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(404)
  })

  it('root 未注册 → 404（信任锚）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows/onboarding?root=${encodeURIComponent('/tmp/not-registered')}`)
    expect(r.status).toBe(404)
  })

  it('server 启动后 registered root 换成外部 symlink → 403，单项 GET 绝不读取外部 YAML', async () => {
    const { mkdir, mkdtemp, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const originalRoot = `${h.root}.registered-read-inode`
    const outside = await mkdtemp(join(tmpdir(), 'wf-read-root-swap-outside-'))
    const outsideDir = join(outside, '.pipeline', 'workflows')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(
      join(outsideDir, 'victim.yaml'),
      'name: victim\nsteps:\n  - id: stolen\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n',
      'utf8',
    )
    await rename(h.root, originalRoot)
    await symlink(outside, h.root, 'dir')

    const r = await reqGet(h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('stolen')
  })

  it('.pipeline 是外部 symlink → 500，read 不读取外部 YAML', async () => {
    const { mkdir, mkdtemp, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-read-pipeline-link-'))
    await mkdir(join(outside, 'workflows'))
    await writeFile(join(outside, 'workflows', 'victim.yaml'), 'name: victim\nsteps: []\n# stolen\n', 'utf8')
    await symlink(outside, join(h.root, '.pipeline'), 'dir')

    const r = await reqGet(h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('stolen')
  })

  it('workflows 是外部 symlink → 500，read 不读取外部 YAML', async () => {
    const { mkdir, mkdtemp, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-read-workflows-link-'))
    await writeFile(join(outside, 'victim.yaml'), 'name: victim\nsteps: []\n# stolen\n', 'utf8')
    await mkdir(join(h.root, '.pipeline'))
    await symlink(outside, join(h.root, '.pipeline', 'workflows'), 'dir')

    const r = await reqGet(h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('stolen')
  })

  it('目标 YAML 是外部 symlink → 500，read 不读取外部 YAML', async () => {
    const { mkdir, mkdtemp, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-read-target-link-'))
    const outsideFile = join(outside, 'victim.yaml')
    const dir = join(h.root, '.pipeline', 'workflows')
    await writeFile(outsideFile, 'name: victim\nsteps: []\n# stolen\n', 'utf8')
    await mkdir(dir, { recursive: true })
    await symlink(outsideFile, join(dir, 'victim.yaml'), 'file')

    const r = await reqGet(h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('stolen')
    expect(await readFile(outsideFile, 'utf8')).toContain('stolen')
  })

  it('非法 workflow 文件 → 500 + 错误详情（安全读后的 validateWorkflow 拒绝原因透传）', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'broken.yaml'),
      'name: broken\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions:\n      - event: go\n        to: does-not-exist\n',
      'utf8',
    )
    const r = await reqGet(h.port, `/api/workflows/broken?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.json<{ error: string }>().error).toContain('does-not-exist')
  })

  it('非法 workflow 文件，且校验错误信息里恰好含"未找到"字样（用户自起的 transition 目标名）→ 仍是 500，不会被误判成 404（round 2 review fix：证明分类不靠错误文本子串匹配）', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'broken2.yaml'),
      'name: broken2\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions:\n      - event: go\n        to: 未找到\n',
      'utf8',
    )
    const r = await reqGet(h.port, `/api/workflows/broken2?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(500)
    expect(r.json<{ error: string }>().error).toContain('未找到')
  })

  it('T-R6：磁盘已有 workflow 引用已删除 dynamic track → 409 degraded，不把孤儿配置伪装成健康 200', async () => {
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'orphan.yaml'), `name: orphan
steps:
  - id: s1
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: full-direct-override
        when:
          track_in: [removed-track]
    transitions: []
`, 'utf8')

    const r = await reqGet(h.port, `/api/workflows/orphan?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(409)
    const body = r.json<{ ok: false; code: string; errors: string[] }>()
    expect(body.code).toBe('WORKFLOW_TRACK_REFERENCES_INVALID')
    expect(body.errors.some((error) => error.includes("未知 track 'removed-track'"))).toBe(true)
  })

  it('非法 workflow 名（.. 路径穿越尝试）→ 400，同 afk 系列端点共用的 name 校验模式，且先于 root 校验被拦（root 未注册也命中这个 400，不是 root 校验的 404）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows/${encodeURIComponent('..')}?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(400)
  })

  it('非法 workflow 名（编码后内含 / 的路径穿越尝试）→ 400，不会被当成合法文件名读取', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows/${encodeURIComponent('../../etc/passwd')}?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(400)
  })
})

describe('POST /api/workflows/:name —— 新建/覆盖自定义 workflow（GOAL E8）', () => {
  const VALID_BODY = {
    name: 'onboarding',
    steps: [
      { id: 'intake', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 'done' }] },
      { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  }

  it('无 token → 401', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/workflows/onboarding', { ...VALID_BODY, root: h.root })
    expect(r.status).toBe(401)
  })

  it('请求体不是 JSON 对象（如空 body）→ 400，同 /api/change/<name>/transition 共用的 body 形状校验（而非落到属性访问抛错的 500）', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/workflows/onboarding', null, {
      rawBody: '',
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(r.status).toBe(400)
  })

  it('root 未注册 → 404', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, '/api/workflows/onboarding', { ...VALID_BODY, root: '/tmp/not-registered' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(404)
  })

  it('中文 workflow 名可经编码 URL 真写盘并原样读回', async () => {
    const h = await start()
    const name = '发布验收流程'
    const route = `/api/workflows/${encodeURIComponent(name)}`
    const write = await reqPost(
      h.port, route, { ...VALID_BODY, name, root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(write.status, JSON.stringify(write.json())).toBe(200)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', `${name}.yaml`))).toBe(true)

    const read = await reqGet(h.port, `${route}?root=${encodeURIComponent(h.root)}`)
    expect(read.status).toBe(200)
    expect(read.json<{ name: string }>().name).toBe(name)
  })

  it('完整 definition POST/GET 原样往返正交 decomposition/interaction policies', async () => {
    const h = await start()
    const policyBody = {
      ...VALID_BODY,
      root: h.root,
      decomposition: {
        version: 'v1', mode: 'auto-safe', target: 'child-pipelines', strategy: 'breadth-first',
        max_items: 8, max_depth: 3,
        auto_when: ['independent-work-items', 'cross-component-boundary'],
        ask_when: ['hard-boundary', 'missing-authorization'],
      },
      interaction: { version: 'v1', mode: 'recommended-defaults' },
    }
    const write = await reqPost(h.port, '/api/workflows/onboarding', policyBody, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(write.status, JSON.stringify(write.json())).toBe(200)

    const read = await reqGet(
      h.port,
      `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
    )
    expect(read.status).toBe(200)
    expect(read.json<Record<string, unknown>>()).toMatchObject({
      decomposition: policyBody.decomposition,
      interaction: policyBody.interaction,
    })
  })

  it('非法 policy POST 失败且不会覆盖当前已发布 definition', async () => {
    const h = await start()
    const valid = await reqPost(
      h.port,
      '/api/workflows/onboarding',
      { ...VALID_BODY, root: h.root, interaction: { version: 'v1', mode: 'interactive' } },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(valid.status).toBe(200)
    const target = join(h.root, '.pipeline', 'workflows', 'onboarding.yaml')
    const before = await readFile(target, 'utf8')

    const invalid = await reqPost(
      h.port,
      '/api/workflows/onboarding',
      {
        ...VALID_BODY,
        root: h.root,
        decomposition: { version: 'v1', mode: 'auto-safe', max_items: 99, surprise: true },
      },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(invalid.status).toBe(400)
    expect(await readFile(target, 'utf8')).toBe(before)
  })

  it('name === default：body 不满足 default 骨架（非七阶段）→ 400 并列出原因，不落盘', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, '/api/workflows/default', { ...VALID_BODY, name: 'default', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    const body = r.json<{ ok: false; errors: string[] }>()
    expect(body.errors.some((error) => error.includes('7 个标准阶段'))).toBe(true)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'default.yaml'))).toBe(false)
  })

  it('name === default：以内建模板为底改技能 → 200 写入项目覆盖文件；GET 回读 source=project；DELETE 恢复内建', async () => {
    const h = await start()
    const builtin = await reqGet(h.port, `/api/workflows/default?root=${encodeURIComponent(h.root)}`)
    expect(builtin.status).toBe(200)
    const { source: builtinSource, effectiveIo: builtinIo, ...template } = builtin.json<Record<string, unknown>>()
    expect(builtinSource).toBe('builtin')
    expect(Object.keys(builtinIo as Record<string, unknown>)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    const steps = template.steps as Array<{ id: string; skills: Array<{ id: string }> }>
    const edited = steps.map((step) => step.id === 'open' ? { ...step, skills: [...step.skills, { id: 'brainstorming' }] } : step)
    const saved = await reqPost(
      h.port, '/api/workflows/default', { ...template, steps: edited, root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(saved.status, saved.body).toBe(200)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'default.yaml'))).toBe(true)

    const loaded = await reqGet(h.port, `/api/workflows/default?root=${encodeURIComponent(h.root)}`)
    expect(loaded.status).toBe(200)
    const override = loaded.json<{ source: string; steps: Array<{ id: string; skills: Array<{ id: string }> }> }>()
    expect(override.source).toBe('project')
    expect(override.steps[0]?.skills.map((skill) => skill.id)).toEqual(['tenon-open', 'openspec-propose', 'brainstorming'])
    const listed = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(h.root)}`)
    expect(listed.json<{ names: string[]; default: { source: string } }>()).toEqual({ names: [], default: { source: 'project' } })

    const removed = await reqDelete(
      h.port, `/api/workflows/default?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(removed.status, removed.body).toBe(200)
    const restored = await reqGet(h.port, `/api/workflows/default?root=${encodeURIComponent(h.root)}`)
    expect(restored.json<{ source: string }>().source).toBe('builtin')
  })

  it('URL workflow name 与 body.name 不一致 → 400，两个名称都不落盘', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, '/api/workflows/onboarding', { ...VALID_BODY, name: 'other', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(400)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'onboarding.yaml'))).toBe(false)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'other.yaml'))).toBe(false)
  })

  it('server 启动后 registered root 换成外部 symlink → 403，POST 绝不在外部创建文件', async () => {
    const { mkdtemp, rename, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const originalRoot = `${h.root}.registered-write-inode`
    const outside = await mkdtemp(join(tmpdir(), 'wf-write-root-swap-outside-'))
    await rename(h.root, originalRoot)
    await symlink(outside, h.root, 'dir')

    const r = await reqPost(
      h.port, '/api/workflows/victim', { ...VALID_BODY, name: 'victim', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(403)
    expect(existsSync(join(outside, '.pipeline', 'workflows', 'victim.yaml'))).toBe(false)
  })

  it('合法 body → 200，真落盘', async () => {
    const { readFile } = await import('node:fs/promises')
    const h = await start()
    const r = await reqPost(
      h.port, '/api/workflows/onboarding', { ...VALID_BODY, root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
    const content = await readFile(join(h.root, '.pipeline', 'workflows', 'onboarding.yaml'), 'utf8')
    expect(content).toContain('name: onboarding')
  })

  it('三步 workflow 的 declarative document contract 经 POST/GET 完整往返，不被扩成七阶段', async () => {
    const h = await start()
    const body = {
      name: 'short-governed',
      root: h.root,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [
          { step: 'implement', kinds: ['proposal'] },
          { step: 'prove', kinds: ['proposal'] },
        ],
      },
      steps: [
        {
          id: 'shape', label: 'Shape', gate: null,
          skills: [{ id: 'writer' }], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'shaped', to: 'implement' }],
        },
        {
          id: 'implement', label: 'Implement', gate: null,
          skills: [{ id: 'builder' }], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'built', to: 'prove' }],
        },
        {
          id: 'prove', label: 'Prove', gate: 'review',
          skills: [{ id: 'verifier' }], inputs: [], outputs: [], guards: [], transitions: [],
        },
      ],
    }
    const saved = await reqPost(h.port, '/api/workflows/short-governed', body, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(saved.status, saved.body).toBe(200)

    const loaded = await reqGet(h.port, `/api/workflows/short-governed?root=${encodeURIComponent(h.root)}`)
    expect(loaded.status).toBe(200)
    const { source, effectiveIo, ...definition } = loaded.json<Record<string, unknown>>()
    expect(definition).toEqual({
      name: body.name,
      documentContract: body.documentContract,
      steps: body.steps,
    })
    expect(source).toBe('project')
    expect(effectiveIo).toBeTypeOf('object')
  })

  it('畸形 workflow 嵌套 DTO → 400 decoder 错误，不落盘且不抛 500', async () => {
    const h = await start()
    const saved = await reqPost(
      h.port,
      '/api/workflows/malformed',
      { name: 'malformed', root: h.root, steps: [{ id: 'shape', skills: 'writer' }] },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(saved.status).toBe(400)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'malformed.yaml'))).toBe(false)
  })

  it('Workflow DTO 任意层级未知键 → 400 且原子拒绝，不创建 workflow 文件', async () => {
    const h = await start()
    const governed = {
      name: 'closed-dto',
      root: h.root,
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['writer'] }],
        reads: [{ step: 'done', kinds: ['proposal'] }],
      },
      steps: [
        {
          id: 'shape', label: 'Shape', gate: null,
          skills: [{ id: 'writer' }], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'done', to: 'done' }],
        },
        { id: 'done', label: 'Done', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const variants = [
      { label: 'workflow', body: { ...governed, extra: true } },
      {
        label: 'step',
        body: { ...governed, steps: [{ ...governed.steps[0], extra: true }, governed.steps[1]] },
      },
      {
        label: 'document_contract',
        body: { ...governed, documentContract: { ...governed.documentContract, extra: true } },
      },
      {
        label: 'slot',
        body: {
          ...governed,
          documentContract: {
            ...governed.documentContract,
            slots: [{ ...governed.documentContract.slots[0], extra: true }],
          },
        },
      },
      {
        label: 'read',
        body: {
          ...governed,
          documentContract: {
            ...governed.documentContract,
            reads: [{ ...governed.documentContract.reads[0], extra: true }],
          },
        },
      },
    ]

    for (const variant of variants) {
      const name = `closed-${variant.label.replace('_', '-')}`
      const response = await reqPost(
        h.port,
        `/api/workflows/${name}`,
        { ...variant.body, name },
        { headers: { Authorization: `Bearer ${h.token}` } },
      )
      expect(response.status, `${variant.label}: ${response.body}`).toBe(400)
      expect(existsSync(join(h.root, '.pipeline', 'workflows', `${name}.yaml`))).toBe(false)
    }
  })

  it('完整 Step IR（多行 prompt + contracts/artifact + step/edge guards + actions）→ 保存后 GET 逐字段读回', async () => {
    const h = await start()
    const body = {
      name: 'full-step-ir', root: h.root,
      steps: [
        {
          id: 'build', label: '构建', gate: null, skills: [], inputs: [],
          outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
          transitions: [{ event: 'build-complete', to: 'verify' }],
        },
        {
          id: 'verify', label: '验证', gate: 'review',
          prompt: 'Run API tests.\nRun browser E2E in Chromium and WebKit.',
          skills: [{ id: 'browser' }],
          inputs: [{ field: 'build_sha', type: 'string' }],
          outputs: [{ field: 'verification_report', type: 'file_path' }],
          artifacts: [{ field: 'verification_report', type: 'file_path', producerPolicy: 'effective-step-skills' }],
          guards: [{ type: 'field-nonempty', field: 'build_sha' }],
          transitions: [{
            event: 'verify-pass', to: 'done',
            guards: [{ type: 'field-equals', field: 'branch_status', value: 'pending' }],
            actions: [{ type: 'mark-verification-passed' }],
          }],
        },
        { id: 'done', label: '完成', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const saved = await reqPost(h.port, '/api/workflows/full-step-ir', body, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
    expect(saved.status, saved.body).toBe(200)
    const loaded = await reqGet(h.port, `/api/workflows/full-step-ir?root=${encodeURIComponent(h.root)}`)
    expect(loaded.status).toBe(200)
    const { source: _source, effectiveIo: _effectiveIo, ...definition } = loaded.json<Record<string, unknown>>()
    expect(definition).toEqual({ name: body.name, steps: body.steps })
  })

  it('T-R6：body predicate 引用未知 dynamic track → 400 + 定位 errors，绝不先保存再运行时坏', async () => {
    const h = await start()
    const body = {
      ...VALID_BODY,
      steps: [
        {
          ...VALID_BODY.steps[0],
          guards: [{ type: 'full-direct-override', when: { kind: 'track-in', values: ['ghost-track'] } }],
        },
        VALID_BODY.steps[1],
      ],
      root: h.root,
    }
    const r = await reqPost(h.port, '/api/workflows/onboarding', body, {
      headers: { Authorization: `Bearer ${h.token}` },
    })

    expect(r.status).toBe(400)
    const result = r.json<{ ok: false; errors: string[] }>()
    expect(result.errors.some((error) => error.includes("未知 track 'ghost-track'"))).toBe(true)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'onboarding.yaml'))).toBe(false)
  })

  it('T-R6：predicate 引用 effective registry 中 custom track → 200，真保存', async () => {
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: data
    label: Data
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: backend
      routing:
        enabled: false
      skills:
        matrix: true
        profile: backend
`, 'utf8')
    const body = {
      ...VALID_BODY,
      steps: [
        {
          ...VALID_BODY.steps[0],
          guards: [{ type: 'full-direct-override', when: { kind: 'track-in', values: ['data'] } }],
        },
        VALID_BODY.steps[1],
      ],
      root: h.root,
    }
    const r = await reqPost(h.port, '/api/workflows/onboarding', body, {
      headers: { Authorization: `Bearer ${h.token}` },
    })

    expect(r.status).toBe(200)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'onboarding.yaml'))).toBe(true)
  })

  it('workflows 目录是指向注册 root 外的 symlink → 500，外部目录绝不创建 workflow 文件', async () => {
    const { mkdir, mkdtemp, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-post-outside-'))
    await mkdir(join(h.root, '.pipeline'))
    await symlink(outside, join(h.root, '.pipeline', 'workflows'), 'dir')

    const r = await reqPost(
      h.port, '/api/workflows/victim', { ...VALID_BODY, name: 'victim', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(existsSync(join(outside, 'victim.yaml'))).toBe(false)
  })

  it('.pipeline 目录是指向注册 root 外的 symlink → 500，外部目录绝不创建 workflow 文件', async () => {
    const { mkdtemp, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-post-pipeline-outside-'))
    await symlink(outside, join(h.root, '.pipeline'), 'dir')

    const r = await reqPost(
      h.port, '/api/workflows/victim', { ...VALID_BODY, name: 'victim', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(existsSync(join(outside, 'workflows', 'victim.yaml'))).toBe(false)
  })

  /**
   * 下面的换位测试使用真临时目录，并在请求前完成攻击者 rename/symlink：覆盖不可信仓库内容，
   * 以及无权在最终 syscall 窗口继续改目录项的不同权限攻击者。Node 未暴露 renameat/unlinkat 的
   * 平台上，不把同 UID 恶意进程在最终复核后的再次换位声称为已绝对消除。
   */
  it('父 workflows 目录换位成外部 symlink → POST 失败，原目录与外部目标都保持原字节', async () => {
    const { mkdir, mkdtemp, readFile, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    const parked = join(h.root, '.pipeline', 'workflows.before-parent-swap')
    const outside = await mkdtemp(join(tmpdir(), 'wf-post-parent-swap-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'victim.yaml'), 'inside original', 'utf8')
    await writeFile(join(outside, 'victim.yaml'), 'outside original', 'utf8')
    await rename(dir, parked)
    await symlink(outside, dir, 'dir')

    const r = await reqPost(
      h.port, '/api/workflows/victim', { ...VALID_BODY, name: 'victim', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(join(parked, 'victim.yaml'), 'utf8')).toBe('inside original')
    expect(await readFile(join(outside, 'victim.yaml'), 'utf8')).toBe('outside original')
  })

  it('workflow 目标换位成外部 symlink → POST 失败，不发布内容且原目标/外部目标不变', async () => {
    const { lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    const target = join(dir, 'victim.yaml')
    const parked = join(dir, 'victim.yaml.before-target-swap')
    const outside = await mkdtemp(join(tmpdir(), 'wf-post-target-swap-'))
    const outsideFile = join(outside, 'victim.yaml')
    await mkdir(dir, { recursive: true })
    await writeFile(target, 'inside original', 'utf8')
    await writeFile(outsideFile, 'outside original', 'utf8')
    await rename(target, parked)
    await symlink(outsideFile, target, 'file')

    const r = await reqPost(
      h.port, '/api/workflows/victim', { ...VALID_BODY, name: 'victim', root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(parked, 'utf8')).toBe('inside original')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside original')
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect((await readdir(dir)).some((entry) => entry.includes('.tmp.'))).toBe(false)
  })

  it('非法 body（validateWorkflow 拒绝）→ 400 + errors 数组，不落盘', async () => {
    const h = await start()
    const invalidBody = {
      name: 'broken',
      steps: [{ id: 's1', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'does-not-exist' }] }],
      root: h.root,
    }
    const r = await reqPost(
      h.port, '/api/workflows/broken', invalidBody,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    expect(r.json<{ errors: string[] }>().errors.some((e) => e.includes('does-not-exist'))).toBe(true)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'broken.yaml'))).toBe(false)
  })

  it('G16 纵深防御：event 名含空格（绕过浏览器直调已鉴权 HTTP）→ 400 + errors，不落盘', async () => {
    const h = await start()
    const bodyWithBadEvent = {
      name: 'sneaky',
      steps: [
        { id: 's1', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'bad event', to: 's2' }] },
        { id: 's2', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
      root: h.root,
    }
    const r = await reqPost(
      h.port, '/api/workflows/sneaky', bodyWithBadEvent,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    expect(r.json<{ errors: string[] }>().errors.some((e) => e.includes("'bad event'"))).toBe(true)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'sneaky.yaml'))).toBe(false)
  })

  it('非法 workflow 名（.. 路径穿越尝试）→ 400，同 GET /api/workflows/:name 共用的 name 防护，且先于落盘发生（.pipeline/workflows 目录都不会被创建）', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, `/api/workflows/${encodeURIComponent('..')}`, { ...VALID_BODY, root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    expect(existsSync(join(h.root, '.pipeline', 'workflows'))).toBe(false)
  })

  it('非法 workflow 名（编码后内含 / 的路径穿越尝试）→ 400，不会被当成合法文件名写入', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, `/api/workflows/${encodeURIComponent('../../etc/passwd')}`, { ...VALID_BODY, root: h.root },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
  })
})

describe('DELETE /api/workflows/:name —— 删除自定义 workflow（GOAL E8）', () => {
  async function installWorkflow(h: Harness, name = 'onboarding'): Promise<string> {
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.yaml`), `name: ${name}
steps:
  - id: start
    label: Start
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    return join(dir, `${name}.yaml`)
  }

  async function installTracks(h: Harness, text: string): Promise<void> {
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'tracks.yaml'), text, 'utf8')
  }

  it('无 token → 401', async () => {
    const h = await start()
    const r = await reqDelete(h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(401)
  })

  it('name === default 且无项目覆盖 → 404（默认模板不是文件，没有可删的覆盖）', async () => {
    const h = await start()
    const r = await reqDelete(
      h.port, `/api/workflows/default?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(404)
  })

  it('真删存在的 workflow → 200，真从磁盘消失', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'onboarding.yaml'), 'name: onboarding\nsteps: []\n', 'utf8')
    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
    expect(existsSync(join(dir, 'onboarding.yaml'))).toBe(false)
  })

  it('T-R7：effective builtin track 的 workflow.default + allowed[] 真引用 → 结构化 409，列全来源且零删除', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await installTracks(h, `version: 1
builtins:
  chat:
    workflow:
      default: onboarding
      allowed: [onboarding, default]
`)

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(409)
    const body = r.json<{ ok: false; code: string; workflow: string; references: Array<{ kind: string; source: string }> }>()
    expect(body).toMatchObject({ ok: false, code: 'WORKFLOW_REFERENCED', workflow: 'onboarding' })
    expect(body.references).toEqual(expect.arrayContaining([
      { kind: 'track-default', source: 'track:chat' },
      { kind: 'track-allowed', source: 'track:chat' },
    ]))
    expect(await readFile(target, 'utf8')).toContain('name: onboarding')
  })

  it('T-R7：custom track 引用目标 workflow → 409（不只扫 builtins）', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await installTracks(h, `version: 1
tracks:
  - id: data
    label: Data
    workflow:
      default: onboarding
      allowed: [onboarding, default]
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: backend
      routing:
        enabled: false
      skills:
        matrix: true
        profile: backend
`)

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    expect(r.json<{ references: Array<{ source: string }> }>().references).toEqual(
      expect.arrayContaining([{ kind: 'track-default', source: 'track:data' }, { kind: 'track-allowed', source: 'track:data' }]),
    )
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7：活跃 change 的 state.workflow 引用 → 409 + change 来源，零删除', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await h.store.set(h.changeDir, 'workflow', 'onboarding')

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    expect(r.json<{ references: Array<{ kind: string; source: string }> }>().references).toContainEqual({
      kind: 'active-change', source: `change:${h.name}`,
    })
    expect(existsSync(target)).toBe(true)
  })

  it('G1：活跃 change 仅保留 canonical current 时，workflow 引用扫描仍 fail-closed 阻止删除', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await h.store.set(h.changeDir, 'workflow', 'onboarding')
    await unlink(join(h.changeDir, '.pipeline.yaml'))

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    expect(r.json<{ references: Array<{ kind: string; source: string }> }>().references).toContainEqual({
      kind: 'active-change', source: `change:${h.name}`,
    })
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7：任一活跃 change state 损坏/非法 UTF-8 → scan-failed 409，不能当成无引用继续删', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    const brokenDir = join(h.root, 'openspec', 'changes', 'broken-state')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, '.pipeline.yaml'), Buffer.from([0xff, 0xfe, 0xfd]))

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    const body = r.json<{ code: string; blockers: Array<{ source: string; detail: string }> }>()
    expect(body.code).toBe('WORKFLOW_REFERENCE_SCAN_FAILED')
    expect(body.blockers.some((blocker) => blocker.source === 'change:broken-state')).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7/Codex r1：unknown key 令后续 workflow 落入 opaqueTail → scan-failed 409，不得解析成 default 后误删', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    const hiddenDir = join(h.root, 'openspec', 'changes', 'hidden-workflow')
    await mkdir(hiddenDir, { recursive: true })
    await writeFile(join(hiddenDir, '.pipeline.yaml'), `track: backend
phase: open
unknown: x
workflow: onboarding
`, 'utf8')

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    const body = r.json<{ code: string; blockers: Array<{ source: string; detail: string }> }>()
    expect(body.code).toBe('WORKFLOW_REFERENCE_SCAN_FAILED')
    expect(body.blockers.some((blocker) => blocker.source === 'change:hidden-workflow')).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7/Codex r1：malformed loops.yaml → scan-failed 409 + loops-registry 来源，零删除', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), 'version: 1\nloops:\n  - id: broken\n', 'utf8')

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    const body = r.json<{ code: string; blockers: Array<{ source: string }> }>()
    expect(body.code).toBe('WORKFLOW_REFERENCE_SCAN_FAILED')
    expect(body.blockers.some((blocker) => blocker.source === 'loops-registry')).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7/Codex r1：changes 下非法普通文件目录项 → scan-failed 409，不能被枚举器过滤', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await writeFile(join(h.root, 'openspec', 'changes', 'not-a-directory'), 'broken', 'utf8')

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    const body = r.json<{ code: string; blockers: Array<{ source: string }> }>()
    expect(body.code).toBe('WORKFLOW_REFERENCE_SCAN_FAILED')
    expect(body.blockers.some((blocker) => blocker.source === 'change:not-a-directory')).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7/Codex r1：活跃 change 目录缺 .pipeline.yaml → scan-failed 409，不能按空 state 跳过', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await mkdir(join(h.root, 'openspec', 'changes', 'missing-state'))

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    const body = r.json<{ code: string; blockers: Array<{ source: string }> }>()
    expect(body.code).toBe('WORKFLOW_REFERENCE_SCAN_FAILED')
    expect(body.blockers.some((blocker) => blocker.source === 'change:missing-state')).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7：loop starter 的持久 workflow_id binding → 409 + loop 来源', async () => {
    const h = await start()
    const target = await installWorkflow(h)
    await writeFile(join(h.root, '.pipeline', 'loops.yaml'), `version: 1
loops:
  - id: loop-be
    name: BE loop
    kind: orchestrator
    goal: Keep delivery moving
    cadence: 1h
    risk: medium
    runner: codex
    change_prefix: loop-be-
    phases: [decide, record]
    human_gates: [manual-review]
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/be.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 1
      on_exceed: skip
    kill_criteria: [manual-stop]
    autonomy_level: L2
    template_id: daily-triage
    template_version: 1
    workflow_id: onboarding
`, 'utf8')

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(409)
    const loopBody = r.json<{ references: Array<{ kind: string; source: string }>; blockers?: unknown }>()
    expect(loopBody.references).toContainEqual({
      kind: 'loop-binding', source: 'loop:loop-be',
    })
    expect(existsSync(target)).toBe(true)
  })

  it('T-R7：POST create 在 workflow 校验后、state 发布前暂停时并发 DELETE → 共同锁令新引用先落，DELETE 随后 409', async () => {
    const base = newStore()
    let releaseInit!: () => void
    let enteredInit!: () => void
    const release = new Promise<void>((resolve) => { releaseInit = resolve })
    const entered = new Promise<void>((resolve) => { enteredInit = resolve })
    const blockingStore: StateStore = {
      read: (dir) => base.read(dir),
      write: (dir, state, intent) => base.write(dir, state, intent),
      writeUnderLock: (dir, state, intent) => base.writeUnderLock(dir, state, intent),
      get: (dir, field) => base.get(dir, field),
      set: (dir, field, value) => base.set(dir, field, value),
      setMany: (dir, values) => base.setMany(dir, values),
      cas: (dir, field, expectValue, next) => base.cas(dir, field, expectValue, next),
      casMany: (dir, field, expectValues, values) => base.casMany(dir, field, expectValues, values),
      inspectProjection: (dir) => base.inspectProjection(dir),
      repairProjection: (dir, opts) => base.repairProjection(dir, opts),
      importLegacyProjection: (dir) => base.importLegacyProjection(dir),
      withLock: (dir, fn) => base.withLock(dir, fn),
      init: async (options) => {
        if (options.name === 'racy-reference') {
          enteredInit()
          await release
        }
        return base.init(options)
      },
    }
    const h = await start({ store: blockingStore })
    const target = await installWorkflow(h)
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    const create = reqPost(h.port, '/api/changes', {
      root: h.root, name: 'racy-reference', track: 'backend', workflow: 'onboarding',
    }, auth)
    await entered
    const remove = reqDelete(h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`, auth)
    await new Promise((resolve) => setTimeout(resolve, 40))
    releaseInit()

    const [created, removed] = await Promise.all([create, remove])
    expect(created.status).toBe(200)
    expect(removed.status).toBe(409)
    expect(removed.json<{ references: Array<{ source: string }> }>().references).toContainEqual({
      kind: 'active-change', source: 'change:racy-reference',
    })
    expect(existsSync(target)).toBe(true)
    expect(await base.get(join(h.root, 'openspec', 'changes', 'racy-reference'), 'workflow')).toBe('onboarding')
  })

  it('T-R7/G6：project coordination lock 预置为外部 symlink → 500，绝不跟随并写外部 owner/删 workflow', async () => {
    const { mkdtemp, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const target = await installWorkflow(h)
    const outside = await mkdtemp(join(tmpdir(), 'wf-reference-lock-outside-'))
    await writeFile(join(outside, 'sentinel'), 'keep', 'utf8')
    await symlink(outside, join(h.root, '.pipeline', '.pipeline.lock'), 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/onboarding?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(500)
    expect(existsSync(target)).toBe(true)
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    expect(existsSync(join(outside, 'owner'))).toBe(false)
  })

  it('server 启动后 registered root 换成外部 symlink → 403，DELETE 绝不删除外部同名文件', async () => {
    const { mkdir, mkdtemp, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const originalRoot = `${h.root}.registered-delete-inode`
    const outside = await mkdtemp(join(tmpdir(), 'wf-delete-root-swap-outside-'))
    const outsideDir = join(outside, '.pipeline', 'workflows')
    const outsideFile = join(outsideDir, 'victim.yaml')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(outsideFile, 'keep outside', 'utf8')
    await rename(h.root, originalRoot)
    await symlink(outside, h.root, 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(403)
    expect(await readFile(outsideFile, 'utf8')).toBe('keep outside')
  })

  it('workflows 目录是指向注册 root 外的 symlink → 500，外部 workflow 文件绝不被删除', async () => {
    const { mkdir, mkdtemp, readFile, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-delete-outside-'))
    const outsideFile = join(outside, 'victim.yaml')
    await writeFile(outsideFile, 'keep me', 'utf8')
    await mkdir(join(h.root, '.pipeline'))
    await symlink(outside, join(h.root, '.pipeline', 'workflows'), 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(outsideFile, 'utf8')).toBe('keep me')
  })

  it('父 workflows 目录换位成外部 symlink → DELETE 失败，原目录与外部同名文件都不删', async () => {
    const { mkdir, mkdtemp, readFile, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    const parked = join(h.root, '.pipeline', 'workflows.before-delete-parent-swap')
    const outside = await mkdtemp(join(tmpdir(), 'wf-delete-parent-swap-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'victim.yaml'), 'inside original', 'utf8')
    await writeFile(join(outside, 'victim.yaml'), 'outside original', 'utf8')
    await rename(dir, parked)
    await symlink(outside, dir, 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(join(parked, 'victim.yaml'), 'utf8')).toBe('inside original')
    expect(await readFile(join(outside, 'victim.yaml'), 'utf8')).toBe('outside original')
  })

  it('workflow 目标换位成外部 symlink → DELETE 失败，原目标与外部目标都不删', async () => {
    const { lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    const target = join(dir, 'victim.yaml')
    const parked = join(dir, 'victim.yaml.before-delete-target-swap')
    const outside = await mkdtemp(join(tmpdir(), 'wf-delete-target-swap-'))
    const outsideFile = join(outside, 'victim.yaml')
    await mkdir(dir, { recursive: true })
    await writeFile(target, 'inside original', 'utf8')
    await writeFile(outsideFile, 'outside original', 'utf8')
    await rename(target, parked)
    await symlink(outsideFile, target, 'file')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(parked, 'utf8')).toBe('inside original')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside original')
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
  })

  it('workflows 是 dangling symlink → 500（必须由 lstat 拒绝，不能按目录不存在误报 404）', async () => {
    const { lstat, mkdir, symlink } = await import('node:fs/promises')
    const h = await start()
    const pipelineDir = join(h.root, '.pipeline')
    const dir = join(pipelineDir, 'workflows')
    await mkdir(pipelineDir)
    await symlink(join(h.root, 'missing-workflows-target'), dir, 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect((await lstat(dir)).isSymbolicLink()).toBe(true)
  })

  it('.pipeline 目录是指向注册 root 外的 symlink → 500，外部 workflow 文件绝不被删除', async () => {
    const { mkdir, mkdtemp, readFile, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-delete-pipeline-outside-'))
    const outsideDir = join(outside, 'workflows')
    const outsideFile = join(outsideDir, 'victim.yaml')
    await mkdir(outsideDir)
    await writeFile(outsideFile, 'keep me', 'utf8')
    await symlink(outside, join(h.root, '.pipeline'), 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(outsideFile, 'utf8')).toBe('keep me')
  })

  it('.pipeline 是 dangling symlink → 500（必须由 lstat 拒绝，不能按目录不存在误报 404）', async () => {
    const { lstat, symlink } = await import('node:fs/promises')
    const h = await start()
    const pipelineDir = join(h.root, '.pipeline')
    await symlink(join(h.root, 'missing-pipeline-target'), pipelineDir, 'dir')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect((await lstat(pipelineDir)).isSymbolicLink()).toBe(true)
  })

  it('删除目标本身是指向注册 root 外文件的 symlink → 500，外部文件和 symlink 都保持不变', async () => {
    const { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await start()
    const outside = await mkdtemp(join(tmpdir(), 'wf-delete-target-outside-'))
    const outsideFile = join(outside, 'victim.yaml')
    const dir = join(h.root, '.pipeline', 'workflows')
    const linkedFile = join(dir, 'victim.yaml')
    await writeFile(outsideFile, 'keep me', 'utf8')
    await mkdir(dir, { recursive: true })
    await symlink(outsideFile, linkedFile, 'file')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect(await readFile(outsideFile, 'utf8')).toBe('keep me')
    expect((await lstat(linkedFile)).isSymbolicLink()).toBe(true)
  })

  it('删除目标是 dangling symlink → 500（必须由 lstat 拒绝，不能按不存在误报 404）', async () => {
    const { lstat, mkdir, symlink } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    const linkedFile = join(dir, 'victim.yaml')
    await mkdir(dir, { recursive: true })
    await symlink(join(h.root, 'missing-outside.yaml'), linkedFile, 'file')

    const r = await reqDelete(
      h.port, `/api/workflows/victim?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )

    expect(r.status).toBe(500)
    expect((await lstat(linkedFile)).isSymbolicLink()).toBe(true)
  })

  it('不存在的 workflow → 404', async () => {
    const h = await start()
    const r = await reqDelete(
      h.port, `/api/workflows/ghost?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(404)
  })

  it('非法 workflow 名（.. 路径穿越尝试）→ 400，同 GET/POST /api/workflows/:name 共用的 name 防护，且先于删除发生', async () => {
    const h = await start()
    const r = await reqDelete(
      h.port, `/api/workflows/${encodeURIComponent('..')}?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
  })

  it('非法 workflow 名（编码后内含 / 的路径穿越尝试）→ 400，不会被当成合法文件名删除', async () => {
    const h = await start()
    const r = await reqDelete(
      h.port, `/api/workflows/${encodeURIComponent('../../etc/passwd')}?root=${encodeURIComponent(h.root)}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
  })
})

// ═══════════ v5 T5（决议#2）：阶段×hook 开关矩阵端点（.pipeline/hooks.json）═══════════

describe('GET /api/hooks —— hook 元数据 + 阶段×hook 开关矩阵（v5 T5 / 决议#2）', () => {
  it('缺 .pipeline/hooks.json → 200 空矩阵（缺省全启用 fail-open）+ 全量 hook 元数据', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; hooks: Array<{ id: string; event: string; configurable: boolean }>; matrix: Record<string, false> }>()
    expect(body.ok).toBe(true)
    expect(body.matrix).toEqual({})
    expect(body.hooks.map((x) => x.id).sort()).toEqual([
      'breadcrumb', 'confirm-clear', 'decision-recorder', 'gate',
      'interactive-skill-gate', 'router', 'session-start', 'skill-tracker',
    ])
    const gate = body.hooks.find((x) => x.id === 'gate')!
    expect(gate.configurable).toBe(false)
    expect(gate.event).toBe('PreToolUse')
  })

  it('root 未注册 → 404（信任锚，同兄弟端点）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent('/tmp/not-registered-root')}`)
    expect(r.status).toBe(404)
  })

  it('稳定 FIFO hooks.json 有界回退默认值，HTTP 仍可响应', async () => {
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    execFileSync('mkfifo', [join(h.root, '.pipeline', 'hooks.json')])
    const r = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(r.json<{ matrix: Record<string, false>; prompt_skip_keyword: string }>()).toMatchObject({
      matrix: {},
      prompt_skip_keyword: 'no-tenon',
    })
  })

  it('手改文件里的强制常开项（gate.*: false）被过滤，不回显给 UI', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    await mkdir(join(h.root, '.pipeline'), { recursive: true })
    await writeFile(
      join(h.root, '.pipeline', 'hooks.json'),
      JSON.stringify({ version: 1, matrix: { 'gate.build': false, 'router.build': false } }, null, 2),
      'utf8',
    )
    const r = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(r.json<{ matrix: Record<string, false> }>().matrix).toEqual({ 'router.build': false })
  })

  it('信任锚单源（isRegisteredRoot）语义钉：注册 root 精确/尾斜杠非规范形式均放行，未注册 404 + 精确文案', async () => {
    // 借最轻量的 root-only 读端点钉 helper 三条语义——19 处调用点共用同一谓词后，
    // 任一语义被改动（如丢掉两侧规范化）本用例即报警。
    const h = await start()
    const exact = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(exact.status).toBe(200)
    const slash = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(`${h.root}/`)}`)
    expect(slash.status).toBe(200)
    const alien = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent('/tmp/never-registered-anywhere')}`)
    expect(alien.status).toBe(404)
    expect(alien.json<{ error: string }>().error).toBe('root 未在机器级项目注册表中')
  })
})

describe('POST /api/hooks —— 阶段×hook 开关写回（v5 T5 / 决议#2）', () => {
  it('无 token → 401（同 B5 写端点纵深）', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/hooks', { root: h.root, hook: 'router', phase: 'build', enabled: false })
    expect(r.status).toBe(401)
  })

  it('disable → 200，真落盘 .pipeline/hooks.json（canonical 一键一行，sh 侧 grep -F 契约）；GET round-trip', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, '/api/hooks',
      { root: h.root, hook: 'router', phase: 'build', enabled: false },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
    expect(r.json<{ ok: boolean }>().ok).toBe(true)
    const text = await readFile(join(h.root, '.pipeline', 'hooks.json'), 'utf8')
    expect(text).toContain('"router.build": false')
    expect(text).toMatch(/^\s*"router\.build": false,?$/m)
    const g = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(g.json<{ matrix: Record<string, false> }>().matrix).toEqual({ 'router.build': false })
  })

  it('enable=true → 键删除（矩阵只存禁用项），GET 回到全默认启用', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    await reqPost(h.port, '/api/hooks', { root: h.root, hook: 'router', phase: 'build', enabled: false }, auth)
    const r = await reqPost(h.port, '/api/hooks', { root: h.root, hook: 'router', phase: 'build', enabled: true }, auth)
    expect(r.status).toBe(200)
    const g = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(g.json<{ matrix: Record<string, false> }>().matrix).toEqual({})
  })

  it('gate / interactive-skill-gate → 400 强制常开（决议#2：写端点拒绝），且不落盘', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    for (const hook of ['gate', 'interactive-skill-gate']) {
      const r = await reqPost(h.port, '/api/hooks', { root: h.root, hook, phase: 'build', enabled: false }, auth)
      expect(r.status).toBe(400)
      expect(r.json<{ error: string }>().error).toContain('强制常开')
    }
    expect(existsSync(join(h.root, '.pipeline', 'hooks.json'))).toBe(false)
  })

  it('未知 hook → 400；阶段名非法字符 → 400；enabled 非布尔 → 400；body 非对象 → 400', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    expect((await reqPost(h.port, '/api/hooks', { root: h.root, hook: 'ghost', phase: 'build', enabled: false }, auth)).status).toBe(400)
    expect((await reqPost(h.port, '/api/hooks', { root: h.root, hook: 'router', phase: 'a.b', enabled: false }, auth)).status).toBe(400)
    expect((await reqPost(h.port, '/api/hooks', { root: h.root, hook: 'router', phase: 'build', enabled: 'no' }, auth)).status).toBe(400)
    expect((await reqPost(h.port, '/api/hooks', undefined, { ...auth, rawBody: '"just a string"' })).status).toBe(400)
  })

  it('root 未注册 → 404（信任锚先于写盘）', async () => {
    const h = await start()
    const r = await reqPost(
      h.port, '/api/hooks',
      { root: '/tmp/not-registered-root', hook: 'router', phase: 'build', enabled: false },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(404)
  })
})

describe('POST /api/hooks/prompt-routing-bypass —— 单轮路由旁路词', () => {
  it('默认值由 GET 暴露，合法值可保存并 round-trip', async () => {
    const h = await start()
    const first = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(first.json<{ prompt_skip_keyword: string }>().prompt_skip_keyword).toBe('no-tenon')
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    const saved = await reqPost(
      h.port,
      '/api/hooks/prompt-routing-bypass',
      { root: h.root, prompt_skip_keyword: 'skip-tenon' },
      auth,
    )
    expect(saved.status).toBe(200)
    expect(saved.json<{ prompt_skip_keyword: string }>().prompt_skip_keyword).toBe('skip-tenon')
    const after = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(after.json<{ prompt_skip_keyword: string }>().prompt_skip_keyword).toBe('skip-tenon')
  })

  it('无 token 401；非法 DTO 400；未注册 root 404，均不污染已有配置', async () => {
    const h = await start()
    expect((await reqPost(h.port, '/api/hooks/prompt-routing-bypass', {
      root: h.root, prompt_skip_keyword: 'skip-tenon',
    })).status).toBe(401)
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    for (const prompt_skip_keyword of ['has space', 'a'.repeat(33), 42]) {
      expect((await reqPost(h.port, '/api/hooks/prompt-routing-bypass', {
        root: h.root, prompt_skip_keyword,
      }, auth)).status).toBe(400)
    }
    expect((await reqPost(h.port, '/api/hooks/prompt-routing-bypass', {
      root: '/tmp/not-registered-root', prompt_skip_keyword: '',
    }, auth)).status).toBe(404)
    const current = await reqGet(h.port, `/api/hooks?root=${encodeURIComponent(h.root)}`)
    expect(current.json<{ prompt_skip_keyword: string }>().prompt_skip_keyword).toBe('no-tenon')
  })

  it('拒绝 .pipeline symlink，Dashboard 保存不得写出 registered root', async () => {
    const { symlink } = await import('node:fs/promises')
    const h = await start()
    const outside = await makeWorktreeDir()
    await symlink(outside, join(h.root, '.pipeline'), 'dir')
    const r = await reqPost(h.port, '/api/hooks/prompt-routing-bypass', {
      root: h.root,
      prompt_skip_keyword: 'skip-tenon',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(500)
    expect(existsSync(join(outside, 'hooks.json'))).toBe(false)
  })
})

// ═══════════ T21：AFK 执行参数端点（.pipeline/automation.json）═══════════

describe('GET /api/automation —— AFK 执行参数（T21）', () => {
  it('缺 .pipeline/automation.json → 200 全默认（fail-open）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/automation?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; settings: Record<string, unknown> }>()
    expect(body.ok).toBe(true)
    expect(body.settings).toEqual({
      enabled: false, max_parallel: 4, max_retries: 1, default_opt_in: false, image: '',
    })
  })

  it('root 未注册 → 404（信任锚，同兄弟端点）', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/automation?root=${encodeURIComponent('/tmp/not-registered-root')}`)
    expect(r.status).toBe(404)
  })
})

describe('POST /api/automation —— AFK 执行参数写回（T21）', () => {
  const SETTINGS = {
    enabled: true, max_parallel: 6, max_retries: 2, default_opt_in: true, image: 'ghcr.io/a/b:v1',
  }

  it('无 token → 401（B5 写端点纵深）', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/automation', { root: h.root, ...SETTINGS })
    expect(r.status).toBe(401)
  })

  it('合法写 → 200，真落盘 .pipeline/automation.json；GET round-trip 一致', async () => {
    const h = await start()
    const r = await reqPost(h.port, '/api/automation', { root: h.root, ...SETTINGS }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(r.json<{ ok: boolean }>().ok).toBe(true)
    const text = await readFile(join(h.root, '.pipeline', 'automation.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ version: 1, ...SETTINGS })
    const g = await reqGet(h.port, `/api/automation?root=${encodeURIComponent(h.root)}`)
    expect(g.json<{ settings: Record<string, unknown> }>().settings).toEqual(SETTINGS)
  })

  it('值域越界（max_parallel=9 / max_retries=-1 / default_opt_in 非布尔 / image 含空格）→ 400 且不落盘', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    const bads = [
      { ...SETTINGS, max_parallel: 9 },
      { ...SETTINGS, max_retries: -1 },
      { ...SETTINGS, default_opt_in: 'yes' },
      { ...SETTINGS, image: 'has space' },
    ]
    for (const bad of bads) {
      const r = await reqPost(h.port, '/api/automation', { root: h.root, ...bad }, auth)
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
    expect(existsSync(join(h.root, '.pipeline', 'automation.json'))).toBe(false)
  })

  it('image 空串 → 200（= 用内置镜像），GET 回读 image 空串', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    const r = await reqPost(h.port, '/api/automation', { root: h.root, ...SETTINGS, image: '' }, auth)
    expect(r.status).toBe(200)
    const g = await reqGet(h.port, `/api/automation?root=${encodeURIComponent(h.root)}`)
    expect(g.json<{ settings: { image: string } }>().settings.image).toBe('')
  })

  it('root 缺失 → 400；root 未注册 → 404（信任锚先于写盘）', async () => {
    const h = await start()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    expect((await reqPost(h.port, '/api/automation', { ...SETTINGS }, auth)).status).toBe(400)
    expect((await reqPost(h.port, '/api/automation', { root: '/tmp/not-registered-root', ...SETTINGS }, auth)).status).toBe(404)
  })
})

describe('未知 HTTP 方法（非 GET/POST/PATCH/PUT/DELETE）仍 405（既有兜底不因新增分支而失效）', () => {
  it('TRACE → 405', async () => {
    const h = await start()
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = (require('node:http') as typeof import('node:http')).request(
        { host: '127.0.0.1', port: h.port, path: '/api/workflows/x', method: 'TRACE' },
        (res) => resolve({ status: res.statusCode ?? 0 }),
      )
      req.on('error', reject)
      req.end()
    })
    expect(r.status).toBe(405)
  })
})

// ═══════════ G18：项目注册端点（spec §3.1，dashboard 闭环第一环）═══════════

/** G18 端点专用 harness：不注入 registry，走 Tenon 平台配置域的真实文件读写。 */
async function startWithHome(opts?: { runPipelineCli?: PipelineCliRunner }): Promise<{
  srv: DashboardServer
  port: number
  token: string
  home: string
  store: StateStore
  registryPath: string
  secretsPath: string
}> {
  const home = await makeTempHome()
  const store = newStore()
  const paths = resolveServerPaths({ home, env: {} })
  const srv = createDashboardServer({
    version: '9.9.9',
    token: 'secret-token-abc',
    hostHome: home,
    paths,
    store,
    flow: testFlow(),
    clock: () => '2026-07-09T00:00:00Z',
    pollIntervalMs: 20,
    runPipelineCli: opts?.runPipelineCli,
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return {
    srv,
    port,
    token: srv.token,
    home,
    store,
    registryPath: paths.registryPath,
    secretsPath: paths.secretsPath,
  }
}

describe('POST /api/projects —— 注册项目进机器级注册表（G18）', () => {
  it('200：真目录注册成功 → 文件落盘规范化路径 + snapshot 立即可见', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    const r = await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(r.json<{ ok: boolean; root: string }>().root).toBe(proj)
    const onDisk = JSON.parse(await readFile(h.registryPath, 'utf8')) as string[]
    expect(onDisk).toContain(proj)
    const snap = await reqGet(h.port, '/api/snapshot')
    expect(snap.json<{ project_count: number }>().project_count).toBe(1)
  })

  it('动态注册在注册请求内建立 root inode 锚，紧接着 workflow POST 可用', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    const registered = await reqPost(h.port, '/api/projects', { root: proj }, auth)
    expect(registered.status).toBe(200)

    const created = await reqPost(h.port, '/api/workflows/dynamic', {
      root: proj,
      name: 'dynamic',
      steps: [{ id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }, auth)
    expect(created.status).toBe(200)
    expect(existsSync(join(proj, '.pipeline', 'workflows', 'dynamic.yaml'))).toBe(true)
  })

  it('CLI 在 server 启动后直接登记的 root 首次 workflow 请求会一次性捕获锚，换位后仍拒绝重绑', async () => {
    const { mkdtemp, rename, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await startWithHome()
    const proj = await makeProject()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }

    // 同 `tenon init` 的真实写路径：CLI 直接更新机器级 registry，不会经 dashboard HTTP 端点。
    expect(await registerProjectRoot(h.registryPath, proj)).toBe(true)
    const listed = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(proj)}`)
    expect(listed.status).toBe(200)
    expect(listed.json<{ names: string[] }>().names).toEqual([])

    const created = await reqPost(h.port, '/api/workflows/dynamic', {
      root: proj,
      name: 'dynamic',
      steps: [{ id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }, auth)
    expect(created.status).toBe(200)

    // 首次捕获后的 inode 是不可替换的；后续 pathname 换位绝不能触发第二次学习。
    const parked = `${proj}.captured-inode`
    const outside = await mkdtemp(join(tmpdir(), 'wf-cli-lazy-anchor-outside-'))
    await rename(proj, parked)
    await symlink(outside, proj, 'dir')
    const swapped = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(proj)}`)
    expect(swapped.status).toBe(403)
    expect(swapped.body).not.toContain('dynamic')
  })

  it('200：写盘走 kernel 原子原语——内容逐字节（JSON 数组+2 空格缩进+尾换行）且同目录无 *.tmp* 残留（观察项④）', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    const r = await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    // 逐字节：与旧 writeFileSync 现状格式完全一致（tmp+rename 原子写不改字节）
    expect(await readFile(h.registryPath, 'utf8')).toBe(`${JSON.stringify([proj], null, 2)}\n`)
    // tmp+rename 原子写：完成后同目录只剩正式文件，无中途 .tmp 残留
    expect(await readdir(dirname(h.registryPath))).toEqual(['projects.json'])
  })

  it('409：重复注册（含尾斜杠等非规范写法，两侧规范化后判重）', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}` } })
    const dup = await reqPost(h.port, '/api/projects', { root: `${proj}/` }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(dup.status).toBe(409)
    const onDisk = JSON.parse(await readFile(h.registryPath, 'utf8')) as string[]
    expect(onDisk).toHaveLength(1)
  })

  it('400：body 非对象 / root 非字符串', async () => {
    const h = await startWithHome()
    const r1 = await reqPost(h.port, '/api/projects', 'just-a-string', { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r1.status).toBe(400)
    const r2 = await reqPost(h.port, '/api/projects', { root: 5 }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r2.status).toBe(400)
  })

  it('404：路径不存在；404：路径是文件非目录', async () => {
    const h = await startWithHome()
    const r1 = await reqPost(h.port, '/api/projects', { root: '/tmp/definitely-not-exist-g18-xyz' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r1.status).toBe(404)
    const proj = await makeProject()
    const filePath = join(proj, 'a-file.txt')
    await (await import('node:fs/promises')).writeFile(filePath, 'x', 'utf8')
    const r2 = await reqPost(h.port, '/api/projects', { root: filePath }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r2.status).toBe(404)
  })

  it('400：root 词法路径本身是 symlink，不写注册表也不建立锚', async () => {
    const { mkdtemp, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const h = await startWithHome()
    const target = await makeProject()
    const holder = await mkdtemp(join(tmpdir(), 'wf-register-link-'))
    const linkedRoot = join(holder, 'project-link')
    await symlink(target, linkedRoot, 'dir')

    const r = await reqPost(
      h.port, '/api/projects', { root: linkedRoot },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
    expect(existsSync(h.registryPath)).toBe(false)
  })

  it('401 无 token / 403 假 Host / 400 非 JSON Content-Type（三层鉴权在新路由同样生效），且不改盘', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    const r1 = await reqPost(h.port, '/api/projects', { root: proj })
    expect(r1.status).toBe(401)
    const r2 = await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}`, Host: 'evil.com' } })
    expect(r2.status).toBe(403)
    const r3 = await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'text/plain' } })
    expect(r3.status).toBe(400)
    expect(existsSync(h.registryPath)).toBe(false)
  })
})

describe('DELETE /api/projects —— 注销项目（G18 对称操作）', () => {
  it('200：注销后文件更新 + snapshot 不再包含', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}` } })
    const r = await reqDelete(h.port, `/api/projects?root=${encodeURIComponent(proj)}`, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    const onDisk = JSON.parse(await readFile(h.registryPath, 'utf8')) as string[]
    expect(onDisk).toHaveLength(0)
    const snap = await reqGet(h.port, '/api/snapshot')
    expect(snap.json<{ project_count: number }>().project_count).toBe(0)
  })

  it('显式注销立即移除 workflow root 锚，后续 workflow 请求按未注册返回 404', async () => {
    const h = await startWithHome()
    const proj = await makeProject()
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    expect((await reqPost(h.port, '/api/projects', { root: proj }, auth)).status).toBe(200)
    expect((await reqDelete(h.port, `/api/projects?root=${encodeURIComponent(proj)}`, auth)).status).toBe(200)

    const r = await reqGet(h.port, `/api/workflows?root=${encodeURIComponent(proj)}`)
    expect(r.status).toBe(404)
  })

  it('200：注销写盘走 kernel 原子原语——剩余条目逐字节且同目录无 *.tmp* 残留（观察项④）', async () => {
    const h = await startWithHome()
    const projA = await makeProject()
    const projB = await makeProject()
    await reqPost(h.port, '/api/projects', { root: projA }, { headers: { Authorization: `Bearer ${h.token}` } })
    await reqPost(h.port, '/api/projects', { root: projB }, { headers: { Authorization: `Bearer ${h.token}` } })
    const r = await reqDelete(h.port, `/api/projects?root=${encodeURIComponent(projA)}`, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    // 逐字节：删掉 A 后剩 B，格式与现状一致
    expect(await readFile(h.registryPath, 'utf8')).toBe(`${JSON.stringify([projB], null, 2)}\n`)
    expect(await readdir(dirname(h.registryPath))).toEqual(['projects.json'])
  })

  it('404 未注册；400 缺 root query；401 无 token', async () => {
    const h = await startWithHome()
    const r1 = await reqDelete(h.port, `/api/projects?root=${encodeURIComponent('/tmp/never-registered')}`, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r1.status).toBe(404)
    const r2 = await reqDelete(h.port, '/api/projects', { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r2.status).toBe(400)
    const r3 = await reqDelete(h.port, '/api/projects?root=%2Ftmp%2Fx')
    expect(r3.status).toBe(401)
  })
})

describe('POST /api/changes —— tenon init 的 HTTP 化（G18）', () => {
  /** 先经真端点注册项目（G18 闭环语义），返回可用的 proj root。 */
  async function withRegisteredProject(h: Awaited<ReturnType<typeof startWithHome>>): Promise<string> {
    const proj = await makeProject()
    const r = await reqPost(h.port, '/api/projects', { root: proj }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    return proj
  }

  it('200 默认：.pipeline.yaml 真落盘（phase=open / track=chat / preset=full）+ snapshot 出现', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const r = await reqPost(h.port, '/api/changes', { root: proj, name: 'demo-a' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; name: string; path: string }>()
    expect(body.name).toBe('demo-a')
    const dir = join(proj, 'openspec', 'changes', 'demo-a')
    expect(existsSync(join(dir, '.pipeline.yaml'))).toBe(true)
    expect(await h.store.get(dir, 'phase')).toBe('open')
    expect(await h.store.get(dir, 'track')).toBe('chat')
    expect(await h.store.get(dir, 'preset')).toBe('full')
    const selection = JSON.parse(await readFile(join(dir, '.pipeline-selection.json'), 'utf8')) as {
      schema_version: string
      pipeline_id: string
      source: string
      workflow_id: string
      track_id: string
    }
    expect(selection).toMatchObject({
      schema_version: 'pipeline-selection/v1',
      pipeline_id: 'default:chat:main',
      source: 'automatic',
      workflow_id: 'default',
      track_id: 'chat',
    })
    const snap = await reqGet(h.port, '/api/snapshot')
    expect(JSON.stringify(snap.json())).toContain('demo-a')
  })

  it('动态路由确认：提示词原子落盘 + 真 CLI 激活当前会话，并以真实指针复核', async () => {
    const calls: Array<{ root: string; args: readonly string[] }> = []
    const h = await startWithHome({
      runPipelineCli: async (root, args) => {
        calls.push({ root, args })
        await writeFile(join(root, '.pipeline-active'), `${args[2] ?? ''}\n`, 'utf8')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const proj = await withRegisteredProject(h)
    const prompt = '为登录页实现响应式前端，并补齐浏览器验收。'
    const r = await reqPost(h.port, '/api/changes', {
      root: proj,
      name: 'route-me',
      track: 'frontend',
      workflow: 'default',
      task_prompt: prompt,
      activate_session: true,
    }, { headers: { Authorization: `Bearer ${h.token}` } })

    expect(r.status).toBe(200)
    expect(calls).toEqual([{ root: proj, args: ['session', 'activate', 'route-me'] }])
    const body = r.json<{
      task_prompt_saved: boolean
      session: { requested: boolean; active: boolean; status: string; exit_code: number | null }
    }>()
    expect(body.task_prompt_saved).toBe(true)
    expect(body.session).toEqual({ requested: true, active: true, status: 'active', exit_code: 0 })
    const changeDir = join(proj, 'openspec', 'changes', 'route-me')
    expect(await readFile(join(changeDir, 'REAL_AGENT_TASK.md'), 'utf8')).toBe(`${prompt}\n`)
    expect(await readFile(join(proj, '.pipeline-active'), 'utf8')).toBe('route-me\n')
    const entries = await readdir(changeDir)
    expect(entries.some((entry) => entry.startsWith('.REAL_AGENT_TASK.md.') && entry.endsWith('.tmp'))).toBe(false)
  })

  it('会话 CLI 的 degraded 成功不会被误报为已激活', async () => {
    const h = await startWithHome({
      runPipelineCli: async () => ({ exitCode: 0, stdout: '', stderr: '[activate] pointer write degraded' }),
    })
    const proj = await withRegisteredProject(h)
    const r = await reqPost(h.port, '/api/changes', {
      root: proj,
      name: 'degraded-session',
      task_prompt: '创建一个需要人工继续的任务。',
      activate_session: true,
    }, { headers: { Authorization: `Bearer ${h.token}` } })

    expect(r.status).toBe(200)
    expect(r.json<{ session: unknown }>().session).toEqual({
      requested: true,
      active: false,
      status: 'degraded',
      exit_code: 0,
    })
  })

  it('G19①：200 后真写 history 记账（kind=init 单行 JSONL，对齐 cli init 的 best-effort 记账）', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const r = await reqPost(h.port, '/api/changes', { root: proj, name: 'hist-a' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(join(proj, 'openspec', 'changes', 'hist-a', '.pipeline-history.jsonl'), 'utf8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ts: string })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.kind).toBe('init')
    expect(typeof lines[0]!.ts).toBe('string')
  })

  it('200 显式 track=frontend', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const r = await reqPost(h.port, '/api/changes', { root: proj, name: 'fe-x', track: 'frontend' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(await h.store.get(join(proj, 'openspec', 'changes', 'fe-x'), 'track')).toBe('frontend')
  })

  it('simple 的 HTTP transition 也不能绕过当前 step 声明的 skill', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const created = await reqPost(
      h.port,
      '/api/changes',
      { root: proj, name: 'simple-http', track: 'simple' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(created.status).toBe(200)
    const route = '/api/change/simple-http/transition'
    const blocked = await reqPost(
      h.port,
      route,
      { root: proj, event: 'change-complete' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(blocked.status).toBe(409)
    expect(blocked.json<{ code?: string }>().code).toBe('step-skills-incomplete')

    const dir = join(proj, 'openspec', 'changes', 'simple-http')
    await appendFile(
      join(dir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ ts: '2026-07-24T00:00:00Z', kind: 'tool', raw: 'Skill: simple-task' })}\n`,
      'utf8',
    )
    const applied = await reqPost(
      h.port,
      route,
      { root: proj, event: 'change-complete' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(applied.status).toBe(200)
    expect(await h.store.get(dir, 'phase')).toBe('verify')
  })

  it('200 自定义 workflow：phase 种到首 step、workflow 字段写入（对齐 cli init --workflow 语义）', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(proj, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(proj, '.pipeline', 'workflows', 'rel.yaml'), `name: rel
steps:
  - id: draft
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: approved
        to: review
  - id: review
    label: y
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    const r = await reqPost(h.port, '/api/changes', { root: proj, name: 'rel-x', workflow: 'rel' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    const dir = join(proj, 'openspec', 'changes', 'rel-x')
    expect(await h.store.get(dir, 'phase')).toBe('draft')
    expect(await h.store.get(dir, 'workflow')).toBe('rel')
  })

  it('400：name 非法 / track 非法 / 重复 name', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const bad1 = await reqPost(h.port, '/api/changes', { root: proj, name: 'bad name' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(bad1.status).toBe(400)
    const bad2 = await reqPost(h.port, '/api/changes', { root: proj, name: 'ok-name', track: 'designer' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(bad2.status).toBe(400)
    const first = await reqPost(h.port, '/api/changes', { root: proj, name: 'dup-x' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(first.status).toBe(200)
    const dup = await reqPost(h.port, '/api/changes', { root: proj, name: 'dup-x' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(dup.status).toBe(400)
    const emptyTask = await reqPost(h.port, '/api/changes', {
      root: proj,
      name: 'empty-task',
      task_prompt: '   ',
    }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(emptyTask.status).toBe(400)
    expect(existsSync(join(proj, 'openspec', 'changes', 'empty-task'))).toBe(false)
  })

  it('404：workflow 不存在；404：root 未注册（信任锚在本端点生效）；401 无 token', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const r1 = await reqPost(h.port, '/api/changes', { root: proj, name: 'x1', workflow: 'ghost' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r1.status).toBe(404)
    const outsider = await makeProject()
    const r2 = await reqPost(h.port, '/api/changes', { root: outsider, name: 'x2' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r2.status).toBe(404)
    const r3 = await reqPost(h.port, '/api/changes', { root: proj, name: 'x3' })
    expect(r3.status).toBe(401)
    expect(existsSync(join(proj, 'openspec', 'changes', 'x3'))).toBe(false)
  })

  it('R2：项目 tracks.yaml 驱动 track 校验——自定义轨放行、workflow.allowed 拦截、未注册轨 400', async () => {
    const h = await startWithHome()
    const proj = await withRegisteredProject(h)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(proj, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(proj, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: data
    label: Data
    workflow:
      default: data-flow
      allowed: [data-flow, default]
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: backend
      routing:
        enabled: true
        pattern: '(数据|ETL)'
        priority: 150
      skills:
        matrix: true
        profile: backend
`, 'utf8')
    await writeFile(join(proj, '.pipeline', 'workflows', 'data-flow.yaml'), `name: data-flow
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
`, 'utf8')
    const auth = { headers: { Authorization: `Bearer ${h.token}` } }
    // 自定义轨 data 缺省绑 data-flow → 首态 draft
    const ok = await reqPost(h.port, '/api/changes', { root: proj, name: 'd1', track: 'data' }, auth)
    expect(ok.status).toBe(200)
    const dir = join(proj, 'openspec', 'changes', 'd1')
    expect(await h.store.get(dir, 'track')).toBe('data')
    expect(await h.store.get(dir, 'phase')).toBe('draft')
    // data 的 allowed 不含 other → 落盘前 400 拦截
    const bad = await reqPost(h.port, '/api/changes', { root: proj, name: 'd2', track: 'data', workflow: 'other' }, auth)
    expect(bad.status).toBe(400)
    expect(existsSync(join(proj, 'openspec', 'changes', 'd2'))).toBe(false)
    // 未注册轨 → 400（registry 驱动，非写死四轨）
    const ghost = await reqPost(h.port, '/api/changes', { root: proj, name: 'd3', track: 'ghost' }, auth)
    expect(ghost.status).toBe(400)
  })
})

describe('POST /api/change/:name/transition —— 自定义 workflow 双轨（G17 端到端补全）', () => {
  async function startWithCustomChange(): Promise<Harness & { relDir: string }> {
    const h = await start()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(h.root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.root, '.pipeline', 'workflows', 'rel.yaml'), `name: rel
steps:
  - id: draft
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: approved
        to: review
  - id: review
    label: y
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: tasks-at-least
        n: 1
    transitions:
      - event: shipped
        to: ship
  - id: ship
    label: z
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    const plan = loadEffectiveWorkflowPlan(h.root, 'rel')
    const relDir = await initChange(h.store, h.root, 'rel-x', {
      initialWorkflow: {
        workflow: 'rel',
        phase: 'draft',
        ...effectiveWorkflowPlanBinding(plan),
      },
    })
    return { ...h, relDir }
  }

  it('200：自定义 event（approved）按 step transitions 推进，phase 真改盘', async () => {
    const h = await startWithCustomChange()
    const r = await reqPost(h.port, '/api/change/rel-x/transition', { root: h.root, event: 'approved' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; from: string; to: string }>()
    expect(body.from).toBe('draft')
    expect(body.to).toBe('review')
    expect(await h.store.get(h.relDir, 'phase')).toBe('review')
  })

  it('409：当前 step 不支持的 event（文案列出可用 event），零写盘', async () => {
    const h = await startWithCustomChange()
    const r = await reqPost(h.port, '/api/change/rel-x/transition', { root: h.root, event: 'shipped' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(409)
    expect(r.json<{ error: string }>().error).toContain('approved')
    expect(await h.store.get(h.relDir, 'phase')).toBe('draft')
  })

  it('409：step guard 未通过（review 的 tasks-at-least n=1，tasks 为空）→ 拒绝且零写盘', async () => {
    const h = await startWithCustomChange()
    await h.store.setMany(h.relDir, { phase: 'review' })
    const r = await reqPost(h.port, '/api/change/rel-x/transition', { root: h.root, event: 'shipped' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(409)
    expect(await h.store.get(h.relDir, 'phase')).toBe('review')
  })

  it('default workflow 的行为零回归：未知 event 仍 400', async () => {
    const h = await startWithCustomChange()
    const r = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'approved' }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(400)
  })
})

// ═══════════ v6 T1：机器级凭证存储端点（POST/GET/DELETE /api/secrets）═══════════
// 掩码 / 0600 / 原子写 / Host 校验（proposal C 节 + docs/superpowers/plans/2026-07-11-
// v6-recommended-implementation.md T1 节）。真落盘用 startWithHome()（真实临时 HOME，
// 同 G18 项目注册端点用同一 harness），不注入 registry——机器级资源本就与 registry 无关。

describe('POST /api/secrets —— 写入单个凭证键（值只进文件，不落 HTTP 响应/日志）', () => {
  it('①401 无 token', async () => {
    const h = await startWithHome()
    const r = await reqPost(h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: 'sk-test-abc123' })
    expect(r.status).toBe(401)
  })

  it('①400 非白名单 key（含刻意排除的 CODEX_HOME/ANTHROPIC_API_KEY）', async () => {
    const h = await startWithHome()
    for (const badKey of ['ANTHROPIC_API_KEY', 'CODEX_HOME', 'RANDOM_KEY']) {
      const r = await reqPost(h.port, '/api/secrets', { key: badKey, value: 'sk-test-abc123' }, { headers: { Authorization: `Bearer ${h.token}` } })
      expect(r.status, `key=${badKey}`).toBe(400)
    }
  })

  it('①400 超长 value（>4KB）', async () => {
    const h = await startWithHome()
    const r = await reqPost(
      h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: 'x'.repeat(4097) }, { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(400)
  })

  it('400 假 Host（三道纵深里的 Host 守卫在本端点同样生效）；400 非 JSON Content-Type', async () => {
    const h = await startWithHome()
    const r1 = await reqPost(
      h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: 'sk-abc' },
      { headers: { Authorization: `Bearer ${h.token}`, Host: 'evil.com' } },
    )
    expect(r1.status).toBe(403)
    const r2 = await reqPost(
      h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: 'sk-abc' },
      { headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'text/plain' } },
    )
    expect(r2.status).toBe(400)
  })

  it('④端点不接受/不要求 root 参数（机器级，无信任锚 404 分支）：带任意 root 也 200', async () => {
    const h = await startWithHome()
    const r = await reqPost(
      h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: 'sk-test-abc123', root: '/tmp/not-a-registered-root' },
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
  })

  it('响应体不含原始 value 子串（只回 masked）', async () => {
    const h = await startWithHome()
    const secretValue = 'sk-ant-oat01-verysecretvalue7f3a'
    const r = await reqPost(h.port, '/api/secrets', { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: secretValue }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
    expect(r.body).not.toContain(secretValue)
    const body = r.json<{ ok: boolean; key: string; set: boolean; masked: string }>()
    expect(body.masked).toBe('sk-…7f3a')
  })
})

describe('GET /api/secrets —— 只回掩码，永不回明文', () => {
  it('③无需 token（不带 Authorization 头仍 200）', async () => {
    const h = await startWithHome()
    const r = await reqGet(h.port, '/api/secrets')
    expect(r.status).toBe(200)
  })

  it('③非法 Host 头（伪造 Host）被拒（403），即便本身不需要 token', async () => {
    const h = await startWithHome()
    const r = await reqGet(h.port, '/api/secrets', '127.0.0.1', { Host: 'evil.com' })
    expect(r.status).toBe(403)
  })

  it('④端点不接受/不要求 root 参数（机器级，无信任锚 404 分支）：带任意/缺失 root 都 200', async () => {
    const h = await startWithHome()
    const withRoot = await reqGet(h.port, `/api/secrets?root=${encodeURIComponent('/tmp/not-a-registered-root')}`)
    expect(withRoot.status).toBe(200)
    const withoutRoot = await reqGet(h.port, '/api/secrets')
    expect(withoutRoot.status).toBe(200)
  })

  it('未设置任何 key → 两键皆 set:false', async () => {
    const h = await startWithHome()
    const r = await reqGet(h.port, '/api/secrets')
    const body = r.json<{ ok: boolean; keys: Record<string, { set: boolean }> }>()
    expect(body.keys.CLAUDE_CODE_OAUTH_TOKEN).toEqual({ set: false })
    expect(body.keys.OPENAI_API_KEY).toEqual({ set: false })
  })
})

describe('②round-trip：POST 写入 → GET 读回 masked 且不含明文 → DELETE 后 GET 显示 set:false', () => {
  it('全链路真落盘验证（含 0600 权限）', async () => {
    const h = await startWithHome()
    const secretValue = 'sk-ant-oat01-verysecretvalue7f3a'

    const post = await reqPost(h.port, '/api/secrets', { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: secretValue }, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(post.status).toBe(200)
    expect(post.body).not.toContain(secretValue)

    const get1 = await reqGet(h.port, '/api/secrets')
    expect(get1.status).toBe(200)
    expect(get1.body).not.toContain(secretValue)
    const body1 = get1.json<{ ok: boolean; keys: Record<string, { set: boolean; masked?: string }> }>()
    expect(body1.keys.CLAUDE_CODE_OAUTH_TOKEN).toEqual({ set: true, masked: 'sk-…7f3a' })
    expect(body1.keys.OPENAI_API_KEY).toEqual({ set: false })

    // 真落盘 0600 + tmp+rename（验收判据同款：stat mode 恰 0o600）
    const secretsFile = h.secretsPath
    const st = await stat(secretsFile)
    expect(st.mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(await readFile(secretsFile, 'utf8')) as { keys: Record<string, string> }
    // 落盘内容本身就该是真值（write-only 是 HTTP 响应/日志的纪律，不是磁盘内容的纪律）
    expect(onDisk.keys.CLAUDE_CODE_OAUTH_TOKEN).toBe(secretValue)

    const del = await reqDelete(h.port, `/api/secrets?key=${encodeURIComponent('CLAUDE_CODE_OAUTH_TOKEN')}`, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(del.status).toBe(200)

    const get2 = await reqGet(h.port, '/api/secrets')
    const body2 = get2.json<{ keys: Record<string, { set: boolean }> }>()
    expect(body2.keys.CLAUDE_CODE_OAUTH_TOKEN).toEqual({ set: false })
  })
})

describe('DELETE /api/secrets?key= —— 删单键（同现有 DELETE 惯例：query string 传参）', () => {
  it('401 无 token；403 假 Host', async () => {
    const h = await startWithHome()
    const r1 = await reqDelete(h.port, `/api/secrets?key=${encodeURIComponent('OPENAI_API_KEY')}`)
    expect(r1.status).toBe(401)
    const r2 = await reqDelete(
      h.port, `/api/secrets?key=${encodeURIComponent('OPENAI_API_KEY')}`,
      { headers: { Authorization: `Bearer ${h.token}`, Host: 'evil.com' } },
    )
    expect(r2.status).toBe(403)
  })

  it('400 非白名单 key（含缺失 key）', async () => {
    const h = await startWithHome()
    const r1 = await reqDelete(h.port, `/api/secrets?key=${encodeURIComponent('CODEX_HOME')}`, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r1.status).toBe(400)
    const r2 = await reqDelete(h.port, '/api/secrets', { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r2.status).toBe(400)
  })

  it('删除本就未设置的 key → 幂等 200（不报错）', async () => {
    const h = await startWithHome()
    const r = await reqDelete(h.port, `/api/secrets?key=${encodeURIComponent('OPENAI_API_KEY')}`, { headers: { Authorization: `Bearer ${h.token}` } })
    expect(r.status).toBe(200)
  })

  it('④端点不接受/不要求 root 参数（机器级，无信任锚 404 分支）', async () => {
    const h = await startWithHome()
    await reqPost(h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: 'sk-test-abc123' }, { headers: { Authorization: `Bearer ${h.token}` } })
    const r = await reqDelete(
      h.port, `/api/secrets?key=${encodeURIComponent('OPENAI_API_KEY')}&root=${encodeURIComponent('/tmp/not-a-registered-root')}`,
      { headers: { Authorization: `Bearer ${h.token}` } },
    )
    expect(r.status).toBe(200)
  })
})

describe('server 进程日志不出现明文 token（真机验收判据的单测替身：响应体全程扫描）', () => {
  it('POST/GET/DELETE 三端点响应体全程不含写入过的原始明文值', async () => {
    const h = await startWithHome()
    const secretValue = 'sk-ant-oat01-neverleak-thisexactstring-999'
    const post = await reqPost(h.port, '/api/secrets', { key: 'OPENAI_API_KEY', value: secretValue }, { headers: { Authorization: `Bearer ${h.token}` } })
    const get = await reqGet(h.port, '/api/secrets')
    const del = await reqDelete(h.port, `/api/secrets?key=${encodeURIComponent('OPENAI_API_KEY')}`, { headers: { Authorization: `Bearer ${h.token}` } })
    for (const r of [post, get, del]) {
      expect(r.body).not.toContain(secretValue)
    }
  })
})

/**
 * v6 T3：GET /api/docker/images —— 单机镜像列表端点。ok 恒 true(docker 不可用是常态不是
 * HTTP 错误,available:false 即前端降级信号);无 root 概念;不要求 token 但吃 isLocalHost。
 */
describe('GET /api/docker/images —— 镜像列表(v6 T3)', () => {
  it('docker 可用 → {ok:true, available:true, images:[...]}(过滤悬空,排序去重);无 root 参数 200', async () => {
    const h = await start({
      execDocker: async () => ({ stdout: 'b:2\nsandcastle:local\n<none>:<none>\nb:2\n', stderr: '', exitCode: 0 }),
    })
    const r = await reqGet(h.port, '/api/docker/images')
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ ok: true, available: true, images: ['b:2', 'sandcastle:local'] })
  })

  it('docker 不可用(非零退出)→ 仍 200,available:false 空列表(ok 恒 true)', async () => {
    const h = await start({
      execDocker: async () => ({ stdout: '', stderr: 'daemon down', exitCode: 1 }),
    })
    const r = await reqGet(h.port, '/api/docker/images')
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ ok: true, available: false, images: [] })
  })

  it('伪造 Host 头 → 403(isLocalHost 守卫,本机信息端点补校验)', async () => {
    const h = await start({
      execDocker: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    })
    const r = await reqGet(h.port, '/api/docker/images', '127.0.0.1', { Host: 'evil.example.com' })
    expect(r.status).toBe(403)
  })
})

/**
 * v6 T4：GET /api/afk/readiness —— 三灯聚合端点。形状契约由 afkReadiness.test.ts 全量钉住,
 * 这里只测 HTTP 面:root 参数纪律、isLocalHost、真值贯通(注入 execDocker + hermetic home)。
 */
describe('GET /api/afk/readiness —— AFK 就绪三灯(v6 T4)', () => {
  it('root 缺失 400;未注册 404', async () => {
    const h = await start({ execDocker: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
    expect((await reqGet(h.port, '/api/afk/readiness')).status).toBe(400)
    expect((await reqGet(h.port, `/api/afk/readiness?root=${encodeURIComponent('/no/such')}`)).status).toBe(404)
  })

  it('docker 可用+镜像在 → 三灯真值贯通;凭证只回 set/source 不回值', async () => {
    const h = await start({
      execDocker: async (args) =>
        args[0] === 'info' || (args[0] === 'image' && args[2] === 'sandcastle:local')
          ? { stdout: 'ok', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'x', exitCode: 1 },
    })
    const r = await reqGet(h.port, `/api/afk/readiness?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    const body = r.json<{ ok: boolean; docker: { available: boolean }; image: { configured: string; present: boolean; build_hint: string }; credentials: Record<string, unknown> }>()
    expect(body.ok).toBe(true)
    expect(body.docker.available).toBe(true)
    expect(body.image).toEqual({ configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' })
    expect(Object.keys(body.credentials).sort()).toEqual(['claude-code', 'codex'])
  })

  it('hostHome 与产品 paths 分离时只从 hostHome 探测默认 Codex 凭证', async () => {
    const hostHome = await makeTempHome()
    const productHome = await makeTempHome()
    await mkdir(join(hostHome, '.codex'), { recursive: true })
    await writeFile(join(hostHome, '.codex', 'auth.json'), '{}\n', 'utf8')
    const paths = resolveServerPaths({ home: productHome, env: {} })
    const h = await start({
      hostHome,
      paths,
      execDocker: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    })

    const response = await reqGet(h.port, `/api/afk/readiness?root=${encodeURIComponent(h.root)}`)
    const body = response.json<{
      credentials: { codex: { CODEX_HOME: { set: boolean; source?: string } } }
    }>()

    expect(response.status).toBe(200)
    expect(body.credentials.codex.CODEX_HOME).toEqual({ set: true, source: 'default-home' })
    expect(existsSync(join(productHome, '.codex', 'auth.json'))).toBe(false)
  })

  it('伪造 Host 头 → 403', async () => {
    const h = await start({ execDocker: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
    const r = await reqGet(h.port, `/api/afk/readiness?root=${encodeURIComponent(h.root)}`, '127.0.0.1', { Host: 'evil.example.com' })
    expect(r.status).toBe(403)
  })
})

/**
 * Bug1：此前只有 secrets/docker/readiness 三个 GET 有 isLocalHost 守卫，其余只读数据端点
 * （snapshot / afk log / change history / workflows / config / loops / traces / hooks / automation
 * / skills）全无 → evil.com DNS 重绑定到 127.0.0.1 后可被受害者浏览器同源读走全部项目路径、
 * 状态、run-log（可能含 token）、yaml。修法：handleGet 顶部统一施加 Host 守卫（仅无敏感内容的
 * 静态 assets / health 探针除外）。这里钉「非本地 Host → 403」在全部此前无守卫的端点上都成立，
 * 且本地 Host 不被误伤；注入 bearer token 的 landing page 也必须受保护。
 */
describe('Bug1：GET 只读数据端点 DNS 重绑定 Host 守卫（统一补齐）', () => {
  const EVIL = { Host: 'evil.example.com' }

  it('此前无守卫的 GET 端点在伪造 Host 下一律 403', async () => {
    const h = await startWithConfig()
    const rootQ = `root=${encodeURIComponent(h.root)}`
    const paths = [
      '/',
      '/index.html',
      '/api/cadence/status',
      '/api/snapshot',
      '/api/afk/snapshot',
      '/api/afk/log',
      `/api/afk/${h.name}/log?${rootQ}`,
      `/api/change/${h.name}/history?${rootQ}`,
      '/api/loops/snapshot',
      '/api/traces/sessions',
      '/api/traces/records?session=x',
      '/api/traces/timeline?session=x',
      '/api/config',
      '/api/skills/registry',
      `/api/hooks?${rootQ}`,
      `/api/automation?${rootQ}`,
      `/api/workflows?${rootQ}`,
      `/api/workflows/whatever?${rootQ}`,
    ]
    for (const p of paths) {
      const r = await reqGet(h.port, p, '127.0.0.1', EVIL)
      expect(r.status, `${p} 应被 Host 守卫拒绝为 403`).toBe(403)
    }
  })

  it('本地 Host 不受误伤：抽样端点仍正常响应；health 明确保持开放（探针语义，不在守卫范围）', async () => {
    const h = await startWithConfig()
    expect((await reqGet(h.port, '/api/snapshot')).status).toBe(200)
    expect((await reqGet(h.port, `/api/config?root=${encodeURIComponent(h.root)}`)).status).toBe(200)
    expect((await reqGet(h.port, '/api/loops/snapshot')).status).toBe(200)
    // health 探针位于守卫之前，任意 Host 仍放行（不改其既有探针语义）
    expect((await reqGet(h.port, '/api/health', '127.0.0.1', EVIL)).status).toBe(200)
  })
})

// ═══════════ 工作流 YAML 导入 / 导出（2026-09 dashboard 重设计）═══════════
function reqPutText(port: number, path: string, text: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const http = require('node:http') as typeof import('node:http')
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'PUT', headers: { 'Content-Type': 'text/yaml', 'Content-Length': String(Buffer.byteLength(text)), ...headers } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.write(text)
    req.end()
  })
}

describe('GET /api/workflows/:name/yaml —— 导出原文', () => {
  it('default 无覆盖 → 内建模板源，text/yaml', async () => {
    const h = await start()
    const r = await reqGet(h.port, `/api/workflows/default/yaml?root=${encodeURIComponent(h.root)}`)
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toContain('text/yaml')
    expect(r.body.startsWith('name: default\n')).toBe(true)
    expect(r.body).toContain('field: pr_url')
  })

  it('自定义 workflow → 项目文件逐字节原文；不存在 → 404；非法名 → 400', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const h = await start()
    const dir = join(h.root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    const source = 'name: onboarding\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n'
    await writeFile(join(dir, 'onboarding.yaml'), source, 'utf8')
    const ok = await reqGet(h.port, `/api/workflows/onboarding/yaml?root=${encodeURIComponent(h.root)}`)
    expect(ok.status).toBe(200)
    expect(ok.body).toBe(source)
    expect((await reqGet(h.port, `/api/workflows/ghost/yaml?root=${encodeURIComponent(h.root)}`)).status).toBe(404)
    expect((await reqGet(h.port, `/api/workflows/..%2Fx/yaml?root=${encodeURIComponent(h.root)}`)).status).toBe(400)
  })
})

describe('PUT /api/workflows/:name/yaml —— 导入原文', () => {
  const SOURCE = 'name: imported\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n'

  it('无 token → 401，不落盘', async () => {
    const h = await start()
    const r = await reqPutText(h.port, `/api/workflows/imported/yaml?root=${encodeURIComponent(h.root)}`, SOURCE)
    expect(r.status).toBe(401)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'imported.yaml'))).toBe(false)
  })

  it('合法 YAML → 200 落盘，GET yaml 回读规范化原文，GET json 带 effectiveIo', async () => {
    const h = await start()
    const r = await reqPutText(h.port, `/api/workflows/imported/yaml?root=${encodeURIComponent(h.root)}`, SOURCE, { Authorization: `Bearer ${h.token}` })
    expect(r.status, r.body).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ ok: true, name: 'imported' })
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'imported.yaml'))).toBe(true)
    const back = await reqGet(h.port, `/api/workflows/imported/yaml?root=${encodeURIComponent(h.root)}`)
    expect(back.body).toContain('name: imported')
    const json = await reqGet(h.port, `/api/workflows/imported?root=${encodeURIComponent(h.root)}`)
    expect(json.json<{ effectiveIo: Record<string, { outputs: unknown[] }> }>().effectiveIo.s1?.outputs).toEqual([])
  })

  it('name 与 URL 不一致 / 解析失败 / 图不合法 → 400 且不落盘', async () => {
    const h = await start()
    const mismatch = await reqPutText(h.port, `/api/workflows/other/yaml?root=${encodeURIComponent(h.root)}`, SOURCE, { Authorization: `Bearer ${h.token}` })
    expect(mismatch.status).toBe(400)
    expect(JSON.parse(mismatch.body).errors.join(' ')).toContain("'imported'")
    const broken = await reqPutText(h.port, `/api/workflows/imported/yaml?root=${encodeURIComponent(h.root)}`, SOURCE.replace('transitions: []', 'transitions:\n      - event: go\n        to: nowhere'), { Authorization: `Bearer ${h.token}` })
    expect(broken.status).toBe(400)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'imported.yaml'))).toBe(false)
    expect(existsSync(join(h.root, '.pipeline', 'workflows', 'other.yaml'))).toBe(false)
  })

  it('超过 256KB → 413；内建 simple → 409', async () => {
    const h = await start()
    const huge = SOURCE + '# ' + 'x'.repeat(256 * 1024)
    const tooBig = await reqPutText(h.port, `/api/workflows/imported/yaml?root=${encodeURIComponent(h.root)}`, huge, { Authorization: `Bearer ${h.token}` })
    expect(tooBig.status).toBe(413)
    const builtin = await reqPutText(h.port, `/api/workflows/simple/yaml?root=${encodeURIComponent(h.root)}`, SOURCE.replace('imported', 'simple'), { Authorization: `Bearer ${h.token}` })
    expect(builtin.status).toBe(409)
  })
})
