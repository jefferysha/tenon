/**
 * server 测试基座 —— 真 fs / 真 HTTP 客户端工具（GOAL C9：绝不 mock，真起真请求）。
 * 非 *.test.ts（会被 tsc 编入 dist），但仅测试引用；生产 index.ts 不导出。
 */
import { spawnSync } from 'node:child_process'
import { request as httpRequest, get as httpGet, type IncomingHttpHeaders } from 'node:http'
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeReadyDesignSystem } from '@tenon/kernel/design-system/test-support'
import {
  createFlowEngine,
  createStateStore,
  createTransitionRecordStore,
  createWorkflowRunRepository,
  compileWorkflow,
  createHistoryWriter,
  documentRecordsInCurrentStepVisit,
  effectiveWorkflowPlanBinding,
  effectiveWorkflowPlanFromIr,
  effectiveWorkflowPlanFromSnapshot,
  ensureDocumentLedger,
  loadManifest,
  parseWorkflow,
  readDocumentLedger,
  recordDocument,
  recordInputReads,
  sha256Hex,
  recordDocumentReads,
  stepOutputsContextFor,
  compileEffectiveWorkflowPlan,
  workflowPlanSnapshot,
  computeContentHash, ensureUserLocalDir, hostAgentPath, isTenonUser, renderHostAgent, resolveTenonUser,
  publishRunRevision, readCurrentRunRevision,
} from '@tenon/kernel'
import type { DocumentGovernancePolicy, EffectiveWorkflowPlan, FieldName, FlowEngine, InitOptions, StateStore } from '@tenon/kernel'
import {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from '../../kernel/dist/skill-invocation/producer-internal.js'
import { performTransition, type TransitionDeps } from './transition.js'
import { withSession } from './test-session.js'

export {
  ANONYMOUS, establishTestSession, exchangeLoginUrl, installSessionFetch, testSessionCookie, withSession,
} from './test-session.js'

/**
 * 任务自己冻结计划里的旧文档契约；新任务（观察模式）没有，返回 undefined。
 * 夹具按它分流：契约模式登记旧账本，观察模式只写文件与读取回执。
 */
async function contractPolicyOf(changeDir: string): Promise<DocumentGovernancePolicy | undefined> {
  const state = await createStateStore().read(changeDir)
  const snapshot = state.runMetadata?.workflowPlanSnapshot
  if (snapshot === undefined) return undefined
  const track = state.fields.track
  const plan = effectiveWorkflowPlanFromSnapshot(snapshot, Array.isArray(track) ? track.join(',') : track)
  return plan.capabilities.documents.mode === 'contract' ? plan.capabilities.documents.policy : undefined
}

/**
 * 升级前创建的自定义工作流任务：冻结快照里带 `document_contract`。新定义不再允许写它（校验报「已删除」），所以直接从旧 YAML
 * 原文编译并冻结（不经 `validateWorkflow`）——测试要的是「旧快照任务照旧走完」，把返回值交给 `initChange` / `store.init`。
 */
export function legacyContractInitialWorkflow(name: string, source: string, phase: string): NonNullable<InitOptions['initialWorkflow']> {
  const plan = effectiveWorkflowPlanFromIr(name, compileWorkflow(parseWorkflow(source)))
  return { workflow: name, phase, ...effectiveWorkflowPlanBinding(plan), workflowPlanSnapshot: workflowPlanSnapshot(plan), documentContract: true }
}

/** 新仓根 templates/manifest.yaml（src 下运行时：src → server → packages → 根）。 */
export function repoManifestPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'manifest.yaml')
}

/**
 * 随包 manifest 已不带「阶段 × 轨道」强制技能矩阵（一步该加载什么只看工作流 YAML）。config 写端点
 * （服务端改机器级 manifest 的接口，随 Dashboard 清理一起删除）仍要在带矩阵的 manifest 上才有可写的小节，
 * 它的测试在随包 manifest 后补上这一节。
 */
const LEGACY_MATRIX_SECTION = `
mandatory_skills:
  open._all: [openspec-propose]
  explore.pm: [brainstorming, grilling, domain-modeling]
  explore.frontend: [openspec-explore, brainstorming, grilling, domain-modeling]
  explore.backend: [openspec-explore, brainstorming, grilling, domain-modeling, codebase-design]
  explore.free: [brainstorming]
  spec.pm: [openspec-propose, brainstorming, writing-plans, grilling, domain-modeling]
  spec.frontend: [openspec-propose, writing-plans]
  spec.backend: [openspec-propose, writing-plans]
  spec.free: [openspec-propose, writing-plans]
  build.pm: [prototype, frontend-design]
  build.frontend: [test-driven-development, frontend-design]
  build.backend: [test-driven-development]
  build.free: [test-driven-development]
  verify.pm: [browser-qa, web-design-guidelines, design-taste-frontend, verification-before-completion]
  verify.frontend: [verification-before-completion, e2e-testing, browser-qa, web-design-guidelines, design-taste-frontend]
  verify.backend: [verification-before-completion]
  verify.free: [verification-before-completion]
  ship.pm: []
  ship.frontend: [finishing-a-development-branch]
  ship.backend: [finishing-a-development-branch]
  ship.free: [finishing-a-development-branch]
  # archive 无强制 skill（归档不 gate skill）——不声明即空表
`

/**
 * config 写端点测试用：把仓库真 templates/manifest.yaml 拷贝到独立临时文件（补上旧矩阵节），返回其路径。
 * 绝不让测试直接写仓库真文件（config.test.ts / server.test.ts 的写端点用例都经此隔离）。
 */
export async function makeTempManifest(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pl-dash-manifest-'))
  const dest = join(dir, 'manifest.yaml')
  await copyFile(repoManifestPath(), dest)
  await appendFile(dest, LEGACY_MATRIX_SECTION, 'utf8')
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
    const required = workflow === 'default'
      ? compileEffectiveWorkflowPlan('default', undefined, { track: String(state.fields.track) }).capabilities.skills.steps.find((step) => step.stepId === phase)?.requiredSkillIds ?? []
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

/**
 * 真建一个临时项目根（含 .git/HEAD 让 base_branch 探测有稳定值）。
 *
 * 同时放一套就绪的设计体系：前端交付步的必需测试 `design-system` 校验项目 DESIGN.md，用它的用例开箱即用。
 */
export async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pl-dash-proj-'))
  writeReadyDesignSystem(root)
  return root
}

/**
 * 升级前的版本写进项目的宿主 agent 文件 `.claude/agents/tenon-<name>.md`，并在 `.pipeline-owned.json` 记一项
 * （记的永远是原渲染结果的摘要）：新版本不再生成这些文件，清理用例用它复原旧状态。
 * `edited` 给出时文件内容换成它（模拟用户改过）。返回仓库相对路径。
 */
export async function writeLegacyHostAgent(root: string, name: string, edited?: string): Promise<string> {
  const rendered = renderHostAgent('claude', {
    name, description: `${name} 说明`, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], body: '\n正文\n',
  })
  const rel = hostAgentPath('claude', name)
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), edited ?? rendered, 'utf8')
  const manifest = join(root, '.pipeline-owned.json')
  const current = await readFile(manifest, 'utf8').then((text) => JSON.parse(text) as Record<string, string>, () => ({}))
  await writeFile(manifest, `${JSON.stringify({ ...current, [rel]: computeContentHash(rendered) }, null, 2)}\n`, 'utf8')
  return rel
}

/**
 * 真建一个临时目录，代表某 change 当前的 automation worktree 根（afk-workbench Task 4：
 * cancelAfkRun 往这个目录真落 .cancel-requested 标记文件，目录必须真实存在于磁盘）。
 */
export async function makeWorktreeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pl-dash-worktree-'))
}

/** 真 init 一个 change；缺省 workflow=default、phase=open，要落到别的工作流给 initialWorkflow。 */
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
    reviewSeed: 'pending' as const,
    preset: opts?.preset ?? 'full',
    creator: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const },
    clock: () => '2026-07-07T00:00:00Z',
    ...(opts?.initialWorkflow !== undefined ? { initialWorkflow: opts.initialWorkflow } : {}),
  }
  if (opts?.legacyWithoutRunIdentity === true) return store.init(init)
  return (await createWorkflowRunRepository({
    store,
    recordStore: createTransitionRecordStore(),
    clock: () => '2026-07-07T00:00:00Z',
  }).initChange(init)).changeDir
}

export interface ArchivedTaskSeed {
  /** Directory name under `openspec/changes/archive/`. */
  readonly dir: string
  /** Time of the task's last state revision, which is when it ended. */
  readonly observedAt: string
  readonly fields?: Partial<Record<FieldName, string | string[]>>
}

/**
 * Real archived tasks: one task is initialised, copied into `openspec/changes/archive/<dir>` per seed, and each
 * copy gets its own last revision (a real `set` through the revision store) at `observedAt`. Returns the directories.
 */
export async function seedArchivedTasks(root: string, seeds: readonly ArchivedTaskSeed[]): Promise<string[]> {
  const store = newStore()
  const template = await initChange(store, root, 'archive-template')
  const archive = join(root, 'openspec', 'changes', 'archive')
  await mkdir(archive, { recursive: true })
  const dirs: string[] = []
  for (const seed of seeds) {
    const dir = join(archive, seed.dir)
    await cp(template, dir, { recursive: true })
    const current = await readCurrentRunRevision(dir)
    if (current === undefined) throw new Error(`seeded task has no canonical state: ${dir}`)
    const state = await store.read(dir)
    await publishRunRevision(dir, current, { ...state, fields: { ...state.fields, ...seed.fields } }, { kind: 'set', observedAt: seed.observedAt })
    dirs.push(dir)
  }
  await rm(template, { recursive: true, force: true })
  return dirs
}

/**
 * Many archived tasks cheaply: each new directory holds only the `.pipeline-run/current.json` of `source` (an archived
 * task from `seedArchivedTasks`), which is all the ended-task list reads. For volume tests, not for detail reads.
 */
export async function copyArchivedTaskState(source: string, root: string, names: readonly string[]): Promise<void> {
  const archive = join(root, 'openspec', 'changes', 'archive')
  for (const name of names) {
    await mkdir(join(archive, name, '.pipeline-run'), { recursive: true })
    await copyFile(join(source, '.pipeline-run', 'current.json'), join(archive, name, '.pipeline-run', 'current.json'))
  }
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

/**
 * Seed documents (and, for a task frozen with the old contract, real ledger/hash/read evidence) for tests whose
 * subject is not document authoring. A task without a contract only gets the files, which the required-output
 * guards find by existence in these non-git fixture projects, plus a read receipt for the current visit.
 */
export async function seedGovernedDocumentEvidence(root: string, changeDir: string, name: string): Promise<void> {
  const policy = await contractPolicyOf(changeDir)
  const docs = {
    proposal: `openspec/changes/${name}/proposal.md`,
    design: `openspec/changes/${name}/design.md`,
    tasks: `openspec/changes/${name}/tasks.md`,
    superpowerDesign: `docs/superpowers/specs/${name}-design.md`,
    adr: `docs/adr/${name}.md`,
    delta: `openspec/changes/${name}/specs/capability/spec.md`,
    plan: `docs/superpowers/plans/${name}.md`,
    report: policy === undefined ? `docs/superpowers/reports/${name}-verify.md` : `docs/superpowers/reports/${name}.md`,
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
  if (policy === undefined) {
    await readGovernedDocumentsForCurrentVisit(root, changeDir)
    return
  }
  const historyPath = join(changeDir, '.pipeline-history.jsonl')
  let originalHistory: string | undefined
  try {
    originalHistory = await readFile(historyPath, 'utf8')
  } catch {
    // A fresh change has no history until its first transition.
  }
  const skillLines = [
    'openspec-propose', 'brainstorming', 'writing-plans', 'verification-before-completion', 'tenon',
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
    const ledger = await recordDocument({ repoRoot: root, changeDir, phase, policy, kind, path, producer, recordedAt })
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
    await record('ship', 'applied-spec', docs.applied, 'tenon', recordedAt)
    await store.set(changeDir, 'phase', originalPhase)
    await readGovernedDocumentsForCurrentVisit(root, changeDir, recordedAt)
  } finally {
    if (originalHistory === undefined) await rm(historyPath, { force: true })
    else await writeFile(historyPath, originalHistory, 'utf8')
  }
}

/**
 * 必需技能的产物要在本次步骤访问里由它登记才算完成（技能与产物绑定）。种好的台账锚在种它的
 * 那次访问上，跨过转换就不算数了；这里替本步契约点名的 producer 把内容没变过的文档在本次访问
 * 重新登记——真 confirmation + 真 recordDocument。被故意改坏的文档保持 stale。
 */
async function recordBoundDocumentsForCurrentVisit(
  root: string,
  changeDir: string,
  policy: DocumentGovernancePolicy,
  at: string,
): Promise<void> {
  const phase = String((await createStateStore().read(changeDir)).fields.phase)
  const ledger = await readDocumentLedger(changeDir)
  if (ledger === undefined) return
  const visit = await documentRecordsInCurrentStepVisit(changeDir)
  const historyPath = join(changeDir, '.pipeline-history.jsonl')
  let sequence = 0
  for (const requirement of policy.outputsByStep[phase] ?? []) {
    const producer = requirement.producerCandidates.find((candidate) => candidate !== 'tenon')
    if (producer === undefined || visit.some((record) => record.kind === requirement.kind)) continue
    for (const existing of ledger.records.filter((record) => record.kind === requirement.kind)) {
      let body: string
      try {
        body = await readFile(join(root, existing.path), 'utf8')
      } catch {
        continue
      }
      if (sha256Hex(body) !== existing.sha256) continue
      sequence += 1
      await appendFile(historyPath, `${JSON.stringify({ ts: at, kind: 'tool', raw: `Skill: ${producer}` })}\n`, 'utf8')
      const confirmed = await recordNativeDocumentSkillConfirmation(changeDir, producer, phase, {
        sessionId: `server-test-support-${basename(changeDir)}`,
        toolUseId: `visit-${phase}-${requirement.kind}-${sequence}-${Date.now()}`,
        observedAt: at,
      })
      if (!confirmed) return
      const next = await recordDocument({
        repoRoot: root, changeDir, phase, policy,
        kind: requirement.kind, path: existing.path, producer, recordedAt: at,
      })
      const canonicalRecord = [...next.records].reverse().find((candidate) =>
        candidate.kind === requirement.kind && candidate.path === existing.path)
      if (canonicalRecord !== undefined) {
        await recordCanonicalDocumentSkillInvocation(changeDir, requirement.kind, at, { record: canonicalRecord })
      }
    }
  }
}

/**
 * Test-only current-visit preparation; callers invoke it after a real transition before the next
 * exit. Old-contract task: re-records the step's producer documents in this visit, then reads the inputs.
 * Task without a contract: writes the read receipts for the visit's handed-over inputs (what
 * `tenon document read <change> all` does, under the task lock).
 */
export async function readGovernedDocumentsForCurrentVisit(
  root: string,
  changeDir: string,
  readAt = '2026-07-07T00:00:00Z',
): Promise<void> {
  const store = createStateStore()
  const policy = await contractPolicyOf(changeDir)
  if (policy === undefined) {
    // A task created without run identity has no visit to read for.
    if ((await store.read(changeDir)).runMetadata === undefined) return
    await store.withLock(changeDir, () => recordInputReads(stepOutputsContextFor(changeDir), 'all', readAt))
    return
  }
  await recordBoundDocumentsForCurrentVisit(root, changeDir, policy, readAt)
  const state = await store.read(changeDir)
  await recordDocumentReads({
    repoRoot: root,
    changeDir,
    phase: String(state.fields.phase),
    policy,
    kind: 'all',
    readAt,
  })
}

/** 项目里已有的文件随初次提交入库：观察基于 git，它们不是后面任务的产出。 */
export function gitInitAndCommit(root: string): void {
  const identity = ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false']
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'initial']]) {
    const result = spawnSync('git', [...identity, ...args], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stdout}${result.stderr}`)
  }
}

/** 写项目根下的相对路径文件，缺的父目录一并建出。 */
export async function putProjectFile(root: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), body, 'utf8')
}

/** 观察模式夹具的平铺工作流：调研（必须产出 docs/specs/*.md，加载 brainstorming）→ 规格（必须产出 docs/plans/{change}-plan.md）→ 完结。 */
export const OBSERVED_FLOW = `name: stepio
steps:
  - id: explore
    label: Explore
    gate: null
    skills:
      - id: brainstorming
    guards:
      - type: required-output
        path: docs/specs/*.md
    transitions:
      - event: explore-complete
        to: spec
  - id: spec
    label: Spec
    gate: null
    skills: []
    guards:
      - type: required-output
        path: docs/plans/{change}-plan.md
    transitions:
      - event: spec-complete
        to: done
  - id: done
    label: Done
    gate: null
    skills: []
    guards: []
    transitions: []
`
export const OBSERVED_CHANGE = 'demo'
/** 项目里早就有的历史设计文档（随初始提交入库，不能满足本任务的必须产出）与本任务调研步写出的设计文档。 */
export const OBSERVED_OLD_DESIGN = 'docs/specs/2026-01-01-legacy-design.md'
export const OBSERVED_DESIGN = `docs/specs/2026-10-12-${OBSERVED_CHANGE}-design.md`
/** 早于任何真实运行时刻：技能加载回执（真 hook 记真时间）必须不早于它挂靠的 init / transition 历史行。 */
const OBSERVED_CLOCK = '2026-07-07T00:00:00Z'

export interface ObservedTask {
  readonly root: string
  readonly changeDir: string
  readonly store: StateStore
  readonly plan: EffectiveWorkflowPlan
}

/**
 * 没有文档契约的新任务（观察模式），停在调研步：自定义平铺工作流 `OBSERVED_FLOW`，项目里先有一份历史设计文档。
 * `git: false` 得到非 git 项目（观察不可用）。技能加载回执要挂在第一次访问的 init 历史行上，生产的 init 会记它。
 */
export async function observedExploreTask(opts: { readonly git?: boolean } = {}): Promise<ObservedTask> {
  const root = await makeProject()
  await putProjectFile(root, '.pipeline/workflows/stepio.yaml', OBSERVED_FLOW)
  await putProjectFile(root, OBSERVED_OLD_DESIGN, '# legacy design\n')
  if (opts.git !== false) gitInitAndCommit(root)
  const store = newStore()
  const changeDir = await initChange(store, root, OBSERVED_CHANGE, { initialWorkflow: { workflow: 'stepio', phase: 'explore', openspecContract: false } })
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({ ts: OBSERVED_CLOCK, kind: 'init', raw: `init ${OBSERVED_CHANGE}` })}\n`, 'utf8')
  return { root, changeDir, store, plan: compileEffectiveWorkflowPlan('stepio', parseWorkflow(OBSERVED_FLOW)) }
}

/** 加载调研技能、写出设计文档，再真走完调研步（`explore-complete`）；返回转换结果的状态码。 */
export async function finishObservedExplore(task: ObservedTask): Promise<number> {
  await recordWorkflowPhaseSkill(task.root, task.changeDir, 'brainstorming')
  await putProjectFile(task.root, OBSERVED_DESIGN, '# Design\n\nobserved, not declared.\n')
  const recordStore = createTransitionRecordStore()
  const deps: TransitionDeps = {
    store: task.store,
    runRepo: createWorkflowRunRepository({ store: task.store, recordStore, clock: () => OBSERVED_CLOCK }),
    recordStore,
    flow: testFlow(),
    clock: () => OBSERVED_CLOCK,
    // 生产的 server 总会写转换历史：它是下一次步骤访问的锚点。
    history: createHistoryWriter(),
  }
  return (await performTransition(deps, task.root, OBSERVED_CHANGE, 'explore-complete')).code
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
    const r = httpGet({ host, port, path, headers: withSession(port, headers) }, (res) => {
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
    ...(withSession(port, opts?.headers) ?? {}),
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
    ...(withSession(port, opts?.headers) ?? {}),
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
    const r = httpRequest({ host, port, path, method: 'DELETE', headers: withSession(port, opts?.headers) }, (res) => {
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
    const r = httpGet({ host, port, path, headers: withSession(port, { Accept: 'text/event-stream' }) }, (res) => {
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
