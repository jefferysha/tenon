/**
 * server 测试基座 —— 真 fs / 真 HTTP 客户端工具（GOAL C9：绝不 mock，真起真请求）。
 * 非 *.test.ts（会被 tsc 编入 dist），但仅测试引用；生产 index.ts 不导出。
 */
import { spawnSync } from 'node:child_process'
import { request as httpRequest, get as httpGet, type IncomingHttpHeaders } from 'node:http'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  builtinTrack,
  createFlowEngine,
  createStateStore,
  createTransitionRecordStore,
  createWorkflowRunRepository,
  ensureDocumentLedger,
  loadManifest,
  recordDocument,
  recordDocumentReads,
  BUILTIN_TRACK_DEFINITIONS, compileEffectiveWorkflowPlan,
  ensureUserLocalDir, isTenonUser, resolveTenonUser,
} from '@tenon/kernel'
import type { FlowEngine, InitOptions, StateStore } from '@tenon/kernel'
import {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from '../../kernel/dist/skill-invocation/producer-internal.js'

/** Fixtures record the built-in default document table (identical in every default branch). */
const DEFAULT_DOCUMENT_POLICY = (() => {
  const policy = compileEffectiveWorkflowPlan('default').documentPolicy
  if (policy === undefined) throw new Error('built-in default workflow must be document-governed')
  return policy
})()

/** 新仓根 templates/manifest.yaml（src 下运行时：src → server → packages → 根）。 */
export function repoManifestPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'manifest.yaml')
}

/**
 * config 写端点测试用：把仓库真 templates/manifest.yaml 拷贝到独立临时文件，返回其路径。
 * 绝不让测试直接写仓库真文件（config.test.ts / server.test.ts 的写端点用例都经此隔离）。
 */
export async function makeTempManifest(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pl-dash-manifest-'))
  const dest = join(dir, 'manifest.yaml')
  await copyFile(repoManifestPath(), dest)
  return dest
}

export function testFlow(): FlowEngine {
  return createFlowEngine(loadManifest(repoManifestPath()))
}

export function newStore(): StateStore {
  return createStateStore()
}

/** Record the current Workflow-owned phase Skill through the production tracker hook. */
/**
 * 记一次（或当前阶段全部必需的）技能调用证据，让 transition 门放行。
 * 不传 skillId 时按 default 有效计划取该阶段 × 该轨道的 requiredSkillIds（技能矩阵已并入 YAML，
 * dashboard 与 CLI 同口径要求它们）；自定义 workflow 仍只记 tenon-<phase>。
 */
export async function recordWorkflowPhaseSkill(root: string, changeDir: string, skillId?: string): Promise<void> {
  const state = await createStateStore().read(changeDir)
  const phase = String(state.fields.phase)
  if (skillId === undefined) {
    const workflow = typeof state.fields.workflow === 'string' && state.fields.workflow !== '' ? state.fields.workflow : 'default'
    const track = BUILTIN_TRACK_DEFINITIONS.find((candidate) => candidate.id === String(state.fields.track))
    const required = workflow === 'default'
      ? compileEffectiveWorkflowPlan('default', undefined, track).capabilities.skills.steps.find((step) => step.stepId === phase)?.requiredSkillIds ?? []
      : []
    const skills = [...new Set([`tenon-${phase}`, ...required])]
    for (const skill of skills) await recordWorkflowPhaseSkill(root, changeDir, skill)
    return
  }
  const skill = skillId
  const user = resolveTenonUser(root, process.env)
  if (!isTenonUser(user)) throw new Error('recordWorkflowPhaseSkill needs a declared TENON_USER')
  // The hook resolves the same identity from the inherited env and reads this user's pointer.
  const pointer = (await ensureUserLocalDir(root, user.slug)).activeChange
  let previous: string | undefined
  try {
    previous = await readFile(pointer, 'utf8')
  } catch {
    // Fresh server fixtures do not normally have a selected Change.
  }
  await writeFile(pointer, `${basename(changeDir)}\n`, 'utf8')
  try {
    const hooksRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks')
    const result = spawnSync('bash', [join(hooksRoot, 'skill-tracker.sh')], {
      cwd: root,
      env: { ...process.env, TENON_PROJECT_ROOT: root },
      input: JSON.stringify({
        cwd: root,
        tool_name: 'Skill',
        tool_input: { skill },
        session_id: `server-test-${basename(changeDir)}-${phase}`,
        tool_use_id: `phase-${phase}-${Date.now()}`,
      }),
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`skill-tracker.sh failed for ${skill}: ${result.stderr ?? ''}`)
    const history = await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')
    if (!history.split('\n').some((line) => line.includes(`\"raw\":\"Skill: ${skill}\"`))) {
      throw new Error(`skill-tracker.sh did not record ${skill} for ${basename(changeDir)}`)
    }
  } finally {
    if (previous === undefined) await rm(pointer, { force: true })
    else await writeFile(pointer, previous, 'utf8')
  }
}

export async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pl-dash-home-'))
}

/** 真建一个临时项目根（含 .git/HEAD 让 base_branch 探测有稳定值）。 */
export async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pl-dash-proj-'))
}

/**
 * 真建一个临时目录，代表某 change 当前的 automation worktree 根（afk-workbench Task 4：
 * cancelAfkRun 往这个目录真落 .cancel-requested 标记文件，目录必须真实存在于磁盘）。
 */
export async function makeWorktreeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pl-dash-worktree-'))
}

/** 真 init 一个 change；simple 轨从内建 workflow 的 change step 开始，其余缺省 phase=open。 */
export async function initChange(
  store: StateStore,
  root: string,
  name: string,
  opts?: {
    track?: 'chat' | 'simple' | 'pm' | 'frontend' | 'backend'
    preset?: string
    legacyWithoutRunIdentity?: boolean
    initialWorkflow?: InitOptions['initialWorkflow']
  },
): Promise<string> {
  const track = opts?.track ?? 'backend'
  const init = {
    repoRoot: root,
    name,
    track,
    reviewSeed: builtinTrack(track).policyProfile.reviewSeed,
    preset: opts?.preset ?? 'full',
    creator: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const },
    clock: () => '2026-07-07T00:00:00Z',
    ...(opts?.initialWorkflow !== undefined
      ? { initialWorkflow: opts.initialWorkflow }
      : track === 'simple'
      ? { initialWorkflow: { workflow: 'simple', phase: 'change', openspecContract: false } }
      : {}),
  }
  if (opts?.legacyWithoutRunIdentity === true) return store.init(init)
  return (await createWorkflowRunRepository({
    store,
    recordStore: createTransitionRecordStore(),
    clock: () => '2026-07-07T00:00:00Z',
  }).initChange(init)).changeDir
}

const GOVERNED_DESIGN = `# governed design

\`\`\`coverage
touches:
L1_api: filled
L2_data: filled
L3_rules: filled
L4_state: filled
L5_errors: filled
L6_security: filled
L7_perf: filled
L8_deps: filled
L10_terms: filled
\`\`\`
`

/** Seed real ledger/hash/read evidence for tests whose subject is not document authoring. */
export async function seedGovernedDocumentEvidence(root: string, changeDir: string, name: string): Promise<void> {
  const docs = {
    proposal: `openspec/changes/${name}/proposal.md`,
    design: `openspec/changes/${name}/design.md`,
    tasks: `openspec/changes/${name}/tasks.md`,
    superpowerDesign: `docs/superpowers/specs/${name}-design.md`,
    adr: `docs/adr/${name}.md`,
    delta: `openspec/changes/${name}/specs/capability/spec.md`,
    plan: `docs/superpowers/plans/${name}.md`,
    report: `docs/superpowers/reports/${name}.md`,
    applied: 'openspec/specs/capability/spec.md',
  }
  const contents: Readonly<Record<keyof typeof docs, string>> = {
    proposal: '# proposal\n', design: GOVERNED_DESIGN, tasks: '- [x] scope\n- [x] implementation\n- [x] verification\n',
    superpowerDesign: '# Superpower design\n', adr: '# ADR\n', delta: '# Delta spec\n', plan: '# Superpower plan\n',
    report: '# Verification report\n', applied: '# Applied spec\n',
  }
  for (const key of Object.keys(docs) as Array<keyof typeof docs>) {
    const target = join(root, docs[key])
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents[key], 'utf8')
  }
  const historyPath = join(changeDir, '.pipeline-history.jsonl')
  let originalHistory: string | undefined
  try {
    originalHistory = await readFile(historyPath, 'utf8')
  } catch {
    // A fresh change has no history until its first transition.
  }
  const skillLines = [
    'openspec-propose', 'brainstorming', 'writing-plans', 'verification-before-completion', 'openspec-apply-change',
  ].map((skill) => JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })).join('\n')
  await writeFile(historyPath, `${originalHistory ?? ''}${skillLines}\n`, 'utf8')
  const store = createStateStore()
  const originalPhase = String((await store.read(changeDir)).fields.phase)
  let receiptSequence = 0
  const record = async (
    phase: string,
    kind: Parameters<typeof recordDocument>[0]['kind'],
    path: string,
    producer: string,
    recordedAt: string,
  ): Promise<void> => {
    await store.set(changeDir, 'phase', phase)
    receiptSequence += 1
    await appendFile(historyPath, `${JSON.stringify({
      ts: recordedAt, kind: 'init', raw: `fixture visit ${phase}`,
    })}\n${JSON.stringify({
      ts: recordedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`, 'utf8')
    const confirmed = await recordNativeDocumentSkillConfirmation(changeDir, producer, phase, {
      sessionId: `server-test-support-${name}`,
      toolUseId: `document-${receiptSequence}`,
      observedAt: recordedAt,
    })
    if (!confirmed) throw new Error(`fixture native confirmation rejected for ${producer}`)
    const ledger = await recordDocument({ repoRoot: root, changeDir, phase, policy: DEFAULT_DOCUMENT_POLICY, kind, path, producer, recordedAt })
    const canonicalRecord = [...ledger.records].reverse().find((candidate) =>
      candidate.kind === kind && candidate.path === path && candidate.recordedAt === recordedAt)
    if (canonicalRecord === undefined) throw new Error(`fixture canonical record missing for ${path}`)
    if (await recordCanonicalDocumentSkillInvocation(
      changeDir, kind, recordedAt, { record: canonicalRecord },
    ) === undefined) throw new Error(`fixture canonical invocation missing for ${path}`)
  }
  try {
    const recordedAt = '2026-07-07T00:00:00Z'
    await createWorkflowRunRepository({
      store: createStateStore(),
      recordStore: createTransitionRecordStore(),
      clock: () => recordedAt,
    }).establishRun(changeDir)
    // StateStore.init is intentionally storage-only. The CLI's `init` command creates this
    // migration-safe sidecar, but server fixtures use StateStore directly, so establish the
    // same real ledger before registering hash-bound documents.
    await ensureDocumentLedger(changeDir, recordedAt)
    await record('open', 'proposal', docs.proposal, 'openspec-propose', recordedAt)
    await record('open', 'openspec-design', docs.design, 'openspec-propose', recordedAt)
    await record('open', 'tasks', docs.tasks, 'openspec-propose', recordedAt)
    await record('explore', 'superpower-design', docs.superpowerDesign, 'brainstorming', recordedAt)
    await record('explore', 'adr', docs.adr, 'brainstorming', recordedAt)
    await record('spec', 'delta-spec', docs.delta, 'openspec-propose', recordedAt)
    await record('spec', 'superpower-plan', docs.plan, 'writing-plans', recordedAt)
    await record('spec', 'plan', docs.plan, 'writing-plans', recordedAt)
    await record('verify', 'verification-report', docs.report, 'verification-before-completion', recordedAt)
    await record('ship', 'applied-spec', docs.applied, 'openspec-apply-change', recordedAt)
    await store.set(changeDir, 'phase', originalPhase)
    await readGovernedDocumentsForCurrentVisit(root, changeDir, recordedAt)
  } finally {
    if (originalHistory === undefined) await rm(historyPath, { force: true })
    else await writeFile(historyPath, originalHistory, 'utf8')
  }
}

/** Test-only current-visit read; callers invoke it after a real transition before the next exit. */
export async function readGovernedDocumentsForCurrentVisit(
  root: string,
  changeDir: string,
  readAt = '2026-07-07T00:00:00Z',
): Promise<void> {
  const state = await createStateStore().read(changeDir)
  await recordDocumentReads({
    repoRoot: root,
    changeDir,
    phase: String(state.fields.phase),
    policy: DEFAULT_DOCUMENT_POLICY,
    kind: 'all',
    readAt,
  })
}

export interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
  json: <T = unknown>() => T
}

function toResult(status: number, headers: IncomingHttpHeaders, body: string): HttpResult {
  return { status, headers, body, json: <T,>() => JSON.parse(body) as T }
}

export function reqGet(
  port: number,
  path: string,
  host = '127.0.0.1',
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const r = httpGet({ host, port, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(toResult(res.statusCode ?? 0, res.headers, body)))
    })
    r.on('error', reject)
  })
}

export function reqPost(
  port: number,
  path: string,
  payload: unknown,
  opts?: { host?: string; headers?: Record<string, string>; rawBody?: string },
): Promise<HttpResult> {
  const host = opts?.host ?? '127.0.0.1'
  const body = opts?.rawBody ?? JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    ...(opts?.headers ?? {}),
  }
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host, port, path, method: 'POST', headers }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve(toResult(res.statusCode ?? 0, res.headers, b)))
    })
    r.on('error', reject)
    r.write(body)
    r.end()
  })
}

export function reqPatch(
  port: number,
  path: string,
  payload: unknown,
  opts?: { host?: string; headers?: Record<string, string>; rawBody?: string },
): Promise<HttpResult> {
  const host = opts?.host ?? '127.0.0.1'
  const body = opts?.rawBody ?? JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    ...(opts?.headers ?? {}),
  }
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host, port, path, method: 'PATCH', headers }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve(toResult(res.statusCode ?? 0, res.headers, b)))
    })
    r.on('error', reject)
    r.write(body)
    r.end()
  })
}

export function reqDelete(
  port: number,
  path: string,
  opts?: { host?: string; headers?: Record<string, string> },
): Promise<HttpResult> {
  const host = opts?.host ?? '127.0.0.1'
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host, port, path, method: 'DELETE', headers: opts?.headers }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve(toResult(res.statusCode ?? 0, res.headers, b)))
    })
    r.on('error', reject)
    r.end()
  })
}

/** 真开一条 SSE 连接，累积事件；waitFor 轮询直到命中或超时。 */
export interface SSEConn {
  events: Array<{ event: string; data: string }>
  waitFor(pred: (e: { event: string; data: string }) => boolean, timeoutMs?: number): Promise<{ event: string; data: string }>
  close(): void
}

export function openSSE(port: number, path: string, host = '127.0.0.1'): Promise<SSEConn> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: string }> = []
    let buf = ''
    const r = httpGet({ host, port, path, headers: { Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          let ev = 'message'
          const dataLines: string[] = []
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            // ':'-prefixed comments (heartbeat) ignored
          }
          if (dataLines.length) events.push({ event: ev, data: dataLines.join('\n') })
        }
      })
      const conn: SSEConn = {
        events,
        close: () => r.destroy(),
        waitFor: (pred, timeoutMs = 3000) =>
          new Promise((res2, rej2) => {
            const start = Date.now()
            const tick = () => {
              const hit = events.find(pred)
              if (hit) return res2(hit)
              if (Date.now() - start > timeoutMs) return rej2(new Error('SSE waitFor 超时'))
              setTimeout(tick, 15)
            }
            tick()
          }),
      }
      resolve(conn)
    })
    r.on('error', reject)
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
