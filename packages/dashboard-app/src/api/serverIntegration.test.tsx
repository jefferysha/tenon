// @vitest-environment node
/**
 * 真 fetch server 集成（GOAL C9 真实证据链）——起真 dashboard server 实例：
 *   真 createStateStore/createFlowEngine/loadManifest（kernel）+ 真临时 fs + 真 node:http + 真 token。
 * 断言：GET /api/snapshot 真形状喂进本前端 selectInbox 选卡正确；POST transition 带 token 真改盘 →
 * 快照真变、change 真进入复核阶段、收件箱据此真出现该卡。非 mock 返回。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboardServer, resolveServerPaths } from '@tenon/server'
import { recordWorkflowPhaseSkill } from '../../../server/src/test-support.js'
import {
  compileEffectiveWorkflowPlan,
  createFlowEngine,
  createStateStore,
  createTransitionRecordStore,
  createWorkflowRunRepository,
  ensureDocumentLedger,
  loadManifest,
  recordDocument,
  recordDocumentReads,
  type StateStore,
} from '@tenon/kernel'
import {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from '../../../kernel/dist/skill-invocation/producer-internal.js'
import { selectInbox } from '../inbox/inbox'

/** Fixtures record the built-in default document table (identical in every default branch). */
function defaultDocumentPolicy() {
  const policy = compileEffectiveWorkflowPlan('default').documentPolicy
  if (policy === undefined) throw new Error('built-in default workflow must be document-governed')
  return policy
}
import { DEFAULT_RULES, rulesKey } from '../model/workflowModel'
import type { Snapshot } from '../types'

const manifestPath = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))
const clock = (): string => '2026-07-07T00:00:00Z'

/**
 * This integration suite exercises the HTTP/dashboard boundary rather than document authoring.
 * Seed the same real, hash-bound evidence that a completed default workflow would have, so its
 * open->explore request reaches the API behavior under test instead of being rejected earlier by
 * the deliberately fail-closed OpenSpec contract.
 */
async function seedGovernedDocumentEvidence(root: string, changeDir: string, name: string): Promise<void> {
  const proposal = `openspec/changes/${name}/proposal.md`
  const design = `openspec/changes/${name}/design.md`
  const tasks = `openspec/changes/${name}/tasks.md`
  const superpowerDesign = `docs/superpowers/specs/${name}-design.md`
  const adr = `docs/adr/${name}.md`
  const delta = `openspec/changes/${name}/specs/capability/spec.md`
  const plan = `docs/superpowers/plans/${name}.md`
  const report = `docs/superpowers/reports/${name}.md`
  const applied = 'openspec/specs/capability/spec.md'
  const writeDocument = async (path: string, content: string): Promise<void> => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  await writeDocument(proposal, '# proposal\n')
  await writeDocument(design, `# design\n\n\`\`\`coverage\ntouches:\nL1_api: filled\nL2_data: filled\nL3_rules: filled\nL4_state: filled\nL5_errors: filled\nL6_security: filled\nL7_perf: filled\nL8_deps: filled\nL10_terms: filled\n\`\`\`\n`)
  await writeDocument(tasks, '- [x] scope\n- [x] implementation\n- [x] verification\n')
  await writeDocument(superpowerDesign, '# Superpower design\n')
  await writeDocument(adr, '# ADR\n')
  await writeDocument(delta, '# Delta spec\n')
  await writeDocument(plan, '# Superpower plan\n')
  await writeDocument(report, '# Verification report\n')
  await writeDocument(applied, '# Applied spec\n')

  const recordedAt = clock()
  await createWorkflowRunRepository({
    store: createStateStore(),
    recordStore: createTransitionRecordStore(),
    clock: () => recordedAt,
  }).establishRun(changeDir)
  await ensureDocumentLedger(changeDir, recordedAt)
  const historyPath = join(changeDir, '.pipeline-history.jsonl')
  let originalHistory: string | undefined
  try {
    originalHistory = await readFile(historyPath, 'utf8')
  } catch {
    // A fresh change has no history until its first transition.
  }
  const store = createStateStore()
  const originalPhase = String((await store.read(changeDir)).fields.phase)
  let receiptSequence = 0
  const record = async (
    phase: string,
    kind: Parameters<typeof recordDocument>[0]['kind'],
    path: string,
    producer: string,
  ): Promise<void> => {
    await store.set(changeDir, 'phase', phase)
    receiptSequence += 1
    await appendFile(historyPath, `${JSON.stringify({
      ts: recordedAt, kind: 'init', raw: `fixture visit ${phase}`,
    })}\n${JSON.stringify({
      ts: recordedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`, 'utf8')
    const confirmed = await recordNativeDocumentSkillConfirmation(changeDir, producer, phase, {
      sessionId: `dashboard-server-integration-${name}`,
      toolUseId: `document-${receiptSequence}`,
      observedAt: recordedAt,
    })
    if (!confirmed) throw new Error(`fixture native confirmation rejected for ${producer}`)
    const ledger = await recordDocument({ repoRoot: root, changeDir, phase, policy: defaultDocumentPolicy(), kind, path, producer, recordedAt })
    const canonicalRecord = [...ledger.records].reverse().find((candidate) =>
      candidate.kind === kind && candidate.path === path && candidate.recordedAt === recordedAt)
    if (canonicalRecord === undefined) throw new Error(`fixture canonical record missing for ${path}`)
    if (await recordCanonicalDocumentSkillInvocation(
      changeDir, kind, recordedAt, { record: canonicalRecord },
    ) === undefined) throw new Error(`fixture canonical invocation missing for ${path}`)
  }
  try {
    await record('open', 'proposal', proposal, 'openspec-propose')
    await record('open', 'openspec-design', design, 'openspec-propose')
    await record('open', 'tasks', tasks, 'openspec-propose')
    await record('explore', 'superpower-design', superpowerDesign, 'brainstorming')
    await record('explore', 'adr', adr, 'brainstorming')
    await record('spec', 'delta-spec', delta, 'openspec-propose')
    await record('spec', 'superpower-plan', plan, 'writing-plans')
    await record('spec', 'plan', plan, 'writing-plans')
    await record('verify', 'verification-report', report, 'verification-before-completion')
    await record('ship', 'applied-spec', applied, 'tenon')
    await store.set(changeDir, 'phase', originalPhase)
    await recordDocumentReads({ repoRoot: root, changeDir, phase: originalPhase, policy: defaultDocumentPolicy(), kind: 'all', readAt: recordedAt })
  } finally {
    if (originalHistory === undefined) await rm(historyPath, { force: true })
    else await writeFile(historyPath, originalHistory, 'utf8')
  }
}

interface Started {
  port: number
  root: string
  token: string
  store: StateStore
  close: () => Promise<void>
}

async function startRealServer(): Promise<Started> {
  const root = await mkdtemp(join(tmpdir(), 'pl-dash-it-'))
  const store = createStateStore()
  const flow = createFlowEngine(loadManifest(manifestPath))
  const changeDir = await store.init({
    repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', preset: 'full', clock,
    creator: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' },
  })
  await seedGovernedDocumentEvidence(root, changeDir, 'demo')
  await recordWorkflowPhaseSkill(root, changeDir)
  // default 的技能矩阵已并入 YAML：backend 轨在 open 还要求 openspec-propose，与 CLI 门禁同口径。
  await recordWorkflowPhaseSkill(root, changeDir, 'openspec-propose')
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home: root, env: {} }),
    version: 'itest',
    token: 'itest-token',
    registry: () => [root],
    store,
    flow,
    clock,
    // The dashboard test process has no TENON_USER; pin the server identity to the task creator.
    resolveUser: () => ({ id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared' }),
  })
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, token: srv.token, store, close: () => srv.close() }
}

const started = await startRealServer()
afterAll(() => started.close())

// Task 8（G19③）：selectInbox 第三参键升级为 rulesKey(root,wf)——真 server 分配的 root 是
// 每次跑测试都不同的 mkdtemp 临时目录，必须等 started 可用之后才能现拼这个 key，因此这条声明
// 从模块顶部挪到这里（原先的裸 'default' 键写法在新契约下会导致 selectInbox 恒查不到 rules）。
const RULES = new Map([[rulesKey(started.root, 'default'), DEFAULT_RULES]])

function url(path: string): string {
  return `http://127.0.0.1:${started.port}${path}`
}

describe('真 server /api/snapshot → 前端 selectInbox', () => {
  // 登记（demo↔生产残余差异清单 #8）：本文件真起 HTTP server + 真 fs 写盘，本机单跑是绿的，
  // 但 codex 高并发沙箱资源紧张时时序比默认 vitest testTimeout(5000ms) 更紧，偶发超时/flaky。
  // 最小侵入放宽：仅给较重的三条 it() 加显式 timeout（第三参，风格同 packages/kernel/src/channel/
  // process.test.ts / packages/cli/src/channel-process.integration.test.ts 的既有写法），不改任何断言强度。
  it('GET 返回真 Snapshot 形状（含 capabilities/projects）', async () => {
    const res = await fetch(url('/api/snapshot'))
    expect(res.status).toBe(200)
    const snap = (await res.json()) as Snapshot
    expect(snap.capabilities.snapshot).toBe(true)
    expect(snap.projects.map((p) => p.root)).toContain(started.root)
    const demo = snap.projects[0]!.changes.find((c) => c.name === 'demo')
    expect(demo?.phase).toBe('open')
    // open 非复核阶段 → 收件箱空
    expect(selectInbox(snap, started.root, RULES)).toEqual([])
  }, 15000)

  it('POST transition 带 token 真改盘 → change 进 explore；T7 准入：缺产出不进收件箱，真补产出字段后才进', async () => {
    const post = await fetch(url('/api/change/demo/transition'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${started.token}` },
      body: JSON.stringify({ root: started.root, event: 'open-complete' }),
    })
    expect(post.status).toBe(200)

    const snap = (await (await fetch(url('/api/snapshot'))).json()) as Snapshot
    const demo = snap.projects[0]!.changes.find((c) => c.name === 'demo')
    expect(demo?.phase).toBe('explore')
    // T7 准入修订（决策 B）：刚进 explore 的卡 design_doc/plan 都未产出 → 「等 agent」，不进收件箱。
    expect(selectInbox(snap, started.root, RULES).map((i) => i.change.name)).not.toContain('demo')

    // agent 真落产出字段（走真 store 改真盘，snapshot 的 path 就是 changeDir）→ 人现在能拍板 → 进收件箱。
    await mkdir(join(started.root, 'docs'), { recursive: true })
    await Promise.all([
      writeFile(join(started.root, 'docs', 'design.md'), '# design\n', 'utf8'),
      writeFile(join(started.root, 'docs', 'plan.md'), '# plan\n', 'utf8'),
    ])
    await started.store.setMany(demo!.path, { design_doc: 'docs/design.md', plan: 'docs/plan.md' })
    const snap2 = (await (await fetch(url('/api/snapshot'))).json()) as Snapshot
    const inbox = selectInbox(snap2, started.root, RULES)
    expect(inbox.map((i) => i.change.name)).toContain('demo')
  }, 20000)

  it('POST 无 token → 401（B5 写端点鉴权，前端必须带同源注入 token）', async () => {
    const res = await fetch(url('/api/change/demo/transition'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: started.root, event: 'explore-complete' }),
    })
    expect(res.status).toBe(401)
  }, 15000)
})
