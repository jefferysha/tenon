/**
 * 真实 e2e 测试 harness（GOAL C9：无伪测试）——共享给所有 *.integration.test.ts。
 * 零 mock：真 kernel（createStateStore/FlowEngine/loadManifest/HistoryWriter）+ 真临时 fs +
 * 真 buildProgram 解析路径（与 main.ts 同款装配，仅 io 收数组、clock 固定、gitHeadSha 定桩）。
 *
 * 并行开发约定：每个功能各写 <feature>.integration.test.ts，import 本 harness 的 makeHarness，
 * 互不碰 integration.test.ts / program.ts（收编点由主会话统一接线新命令）。
 * 注意：文件名 *-harness.ts 不带 .test.，不会被 vitest 当测试收集（无用例）。
 */
import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_TRACK_DEFINITIONS,
  clearReviewMarkerFor,
  compileEffectiveWorkflowPlan,
  createBuildRevisionToken,
  createEffectiveSkillResolver,
  completedWorkflowSkillsSinceStepEntry,
  createFlowEngine,
  createInteractionEventRecorder,
  createHistoryWriter,
  createStateStore,
  createTaskLifecycleApplication,
  createTransitionRecordStore,
  createWorkflowRunRepository,
  DocumentLedgerError,
  ensureDocumentLedger,
  fingerprintWorkspace,
  loadManifest,
  loadTrackRegistry,
  loadWorkflow,
  mutateTrackRegistry,
  readCurrentRunRevisionSync,
  recordDocument,
  recordDocumentReads,
  resolveProductPaths,
  resolveTenonUser,
  actorOf,
  isTenonUser,
  stateStorageExistsSync,
  withTrackRegistryLock,
  type ExtendedManifestData,
  type BuildRevisionIdentity,
  type FieldName,
  type TrackValidationContext,
} from '@tenon/kernel'
import type { CliDeps, GuardFileContext } from './deps.js'
import { FIXED_CLOCK, readGovernedDocumentsForCurrentVisit, seedGovernedDocumentEvidence } from './integration-harness-documents.js'
export { FIXED_CLOCK, seedGovernedDocumentEvidence } from './integration-harness-documents.js'
import { harnessArtifactSubmission } from './integration-submission-test-support.js'
import { buildProgram, CliExit } from './program.js'
import { readBoundedRegularFileSync } from './guardContext.js'
import {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from './test-support.js'
import { createManifestSkillActionAuthorityResolver } from './skill-action-authority-provider.js'
import { recordWorkflowPhaseSkill } from './integration-phase-skill-test-support.js'
export { recordWorkflowPhaseSkill } from './integration-phase-skill-test-support.js'

/** Track Registry 校验上下文（与 main.ts trackValidationContext 同款，harness 镜像生产装配）。 */
function trackValidationContext(repoRoot: string, manifest: ExtendedManifestData): TrackValidationContext {
  const skillProfiles = new Set<string>()
  for (const t of BUILTIN_TRACK_DEFINITIONS) {
    if (t.policyProfile.skills.profile !== '_all') skillProfiles.add(t.policyProfile.skills.profile)
  }
  for (const table of [manifest.mandatorySkills, manifest.recommendedSkills]) {
    for (const row of Object.values(table)) {
      for (const key of Object.keys(row)) if (key !== '_all') skillProfiles.add(key)
    }
  }
  return {
    workflowExists: (id) => {
      if (id === 'default') return true
      try {
        return loadWorkflow(repoRoot, id) !== null
      } catch {
        return false
      }
    },
    skillProfiles,
  }
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const MANIFEST = join(REPO_ROOT, 'templates', 'manifest.yaml')
export const TEST_GIT_HEAD = 'd'.repeat(40)
export const TEST_BUILD_REVISION_IDENTITY: BuildRevisionIdentity = {
  repository: 'integration-test-repository',
  worktree: 'integration-test-worktree',
}
export const TEST_GIT_BUILD_TOKEN = createBuildRevisionToken(
  'git', TEST_GIT_HEAD, TEST_BUILD_REVISION_IDENTITY,
).value

export interface Harness {
  cwd: string
  out: string[]
  err: string[]
  /** 跑一条 CLI（argv 风格）；返回 exit code，每次清空 out/err；`env` 覆盖本次命令的进程环境（如切换 TENON_USER） */
  run: (args: string[], options?: { readonly env?: Readonly<Record<string, string | undefined>> }) => Promise<number>
  /** 读某 change 的 .pipeline.yaml 原文 */
  read: (name: string) => Promise<string>
  /** 读某 change 目录下任意文件（相对 change 目录）；不存在 → 抛 */
  readIn: (name: string, rel: string) => Promise<string>
  /**
   * 白盒 state 准备：直接经 kernel store 原语写字段（绕过 CLI set 的 P6 artifact cutover——
   * 内部 store.set 不受 cutover 限制，设计 D4）。供 e2e 预置 design_doc/plan/verification_report
   * 等 artifact 字段跑后续 transition guard，语义等价于生产里 agent 经 `artifact register` 产出。
   */
  seedArtifact: (name: string, field: string, value: string) => Promise<void>
  /**
   * White-box phase setup for tests whose subject is unrelated to transition guards. This uses
   * the kernel store directly; production callers must use the protected transition application.
   */
  seedPhase: (name: string, phase: string) => Promise<void>
  /**
   * Seed a complete, hash-bound document ledger for a default change without retaining synthetic
   * Skill history. Transition-centric tests call this explicitly when their subject is unrelated
   * to document production; ledger-specific tests deliberately do not use it.
   */
  seedGovernedDocumentEvidence: (
    name: string,
    overrides?: {
      readonly design?: string
      readonly tasks?: string
      readonly autoSkills?: boolean
    },
  ) => Promise<void>
  /**
   * 像真实用户那样满足某一步的必需测试：项目声明自己的 npm 脚本，然后逐项 `tenon test run`。
   * 不绕过门禁——跑的是工作流声明的那条命令，落的是真记录。
   */
  satisfyStepTests: (name: string, stepId: string) => Promise<void>
}

/** 声明式测试项在真实项目里由项目自己的 npm 脚本兑现；夹具项目声明等价的空脚本。 */
const FIXTURE_PACKAGE_JSON = `${JSON.stringify({
  name: 'tenon-harness-fixture',
  private: true,
  version: '0.0.0',
  scripts: { test: 'exit 0', typecheck: 'exit 0', 'test:integration': 'exit 0', bench: 'exit 0' },
}, null, 2)}\n`

/** 真实 deps：与 main.ts 同款 fs 副作用，只把 io 收进数组、clock 固定、gitHeadSha 定桩。 */
export function realDeps(cwd: string, out: string[], err: string[], env: NodeJS.ProcessEnv = process.env): CliDeps {
  const manifest = loadManifest(MANIFEST)
  const abs = (p: string) => join(cwd, p)
  const guardCtx = (name: string): GuardFileContext => ({
    changeDirRel: `openspec/changes/${name}`,
    stateExists: (changeDirRel) => stateStorageExistsSync(abs(changeDirRel)),
    fileExists: (p) => { try { return statSync(abs(p)).isFile() } catch { return false } },
    fileNonempty: (p) => { try { const s = statSync(abs(p)); return s.isFile() && s.size > 0 } catch { return false } },
    readFile: (p) => { try { return readFileSync(abs(p), 'utf8') } catch { return undefined } },
    readFileBounded: (p, maxBytes) => readBoundedRegularFileSync(abs(p), maxBytes, cwd),
    dirExists: (p) => { try { return statSync(abs(p)).isDirectory() } catch { return false } },
    activeChangeArchived: (dep) => {
      try {
        const current = readCurrentRunRevisionSync(join(cwd, 'openspec', 'changes', dep))
        return current?.state.fields.archived === 'true'
      } catch {
        return false
      }
    },
    changeArchived: (dep) => {
      try {
        return readdirSync(abs('openspec/changes/archive'), { withFileTypes: true })
          .some((e) => e.isDirectory() && e.name.endsWith(`-${dep}`))
      } catch { return false }
    },
    automationRunner: false,
  })
  const store = createStateStore()
  const trackCtx = trackValidationContext(cwd, manifest)
  return {
    // H10 §1/§8任务7：与 main.ts 同款装配——复用 trackCtx.skillProfiles（T 线现有 profile 校验器，
    // 见 deps.ts 头注），harness 镜像生产装配、不另造一套判定。
    isSkillProfileKnown: (id) => trackCtx.skillProfiles.has(id),
    resolveSkillActionAuthority: createManifestSkillActionAuthorityResolver(
      manifest,
      (profile) => trackCtx.skillProfiles.has(profile),
    ),
    store,
    taskLifecycle: createTaskLifecycleApplication({ store, clock: () => FIXED_CLOCK, nowMs: () => Date.now() }),
    artifactSubmission: harnessArtifactSubmission(cwd, store),
    runRepo: createWorkflowRunRepository({ store, recordStore: createTransitionRecordStore(), clock: () => FIXED_CLOCK }),
    loadRegistry: () => loadTrackRegistry(cwd, trackCtx),
    withRegistryLock: (cb) => withTrackRegistryLock(cwd, trackCtx, cb),
    mutateRegistry: (cb) => mutateTrackRegistry(cwd, trackCtx, cb),
    flow: createFlowEngine(manifest),
    interaction: createInteractionEventRecorder(),
    // T-R6：镜像生产装配，每次解析 default artifact 都 fresh-load effective registry。
    resolver: createEffectiveSkillResolver({
      registry: () => loadTrackRegistry(cwd, trackCtx),
      manifest,
    }),
    cwd,
    env: (name) => env[name],
    user: () => resolveTenonUser(cwd, env),
    userConfigPath: () => resolveProductPaths({ env }).userConfigPath,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    clock: () => FIXED_CLOCK,
    listChanges: async (root) => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'archive')
          .filter((e) => stateStorageExistsSync(join(root, e.name)))
          .map((e) => e.name).sort()
      } catch { return [] }
    },
    // 严格候选枚举（Track CRUD 引用扫描专用，codex R3 阻断 D）：镜像 main.ts listChangeDirs——
    // 只保留目录、排除 archive、**不过滤 .pipeline.yaml**（缺文件/半成品目录也进候选，交 store.read 判 unreadable）。
    listChangeDirs: async (root) => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'archive')
          .map((e) => e.name).sort()
      } catch { return [] }
    },
    guardCtx,
    readGateMarkers: async () => {
      const res = []
      for (const kind of ['confirm', 'review', 'interaction'] as const) {
        try {
          const p = join(cwd, `.pipeline-pending-${kind}`)
          const st = await stat(p)
          res.push({ kind, ageMs: Math.max(0, Date.now() - st.mtimeMs), raw: await readFile(p, 'utf8') })
        } catch { /* 缺失 */ }
      }
      return res
    },
    readHistoryRaw: async (dir) => { try { return await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8') } catch { return '' } },
    writeBreadcrumb: (dir, content) => writeFile(join(dir, '.breadcrumb'), content, 'utf8'),
    history: createHistoryWriter({ actor: () => { const user = resolveTenonUser(cwd, env); return isTenonUser(user) ? actorOf(user) : undefined } }),
    gitHeadSha: async () => TEST_GIT_HEAD,
    workspaceFingerprint: () => fingerprintWorkspace(cwd),
    buildRevisionIdentity: async () => TEST_BUILD_REVISION_IDENTITY,
    captureBuildRevision: async (isolation) => createBuildRevisionToken(
      isolation === 'in-place' ? 'workspace' : 'git',
      isolation === 'in-place' ? await fingerprintWorkspace(cwd) : TEST_GIT_HEAD,
      TEST_BUILD_REVISION_IDENTITY,
    ).value,
    writeReviewMarker: (content) => writeFile(join(cwd, '.pipeline-pending-review'), content, 'utf8'),
    clearReviewMarker: (change, event) => clearReviewMarkerFor(cwd, change, event),
    pluginVersion: '0.1.0',
    readInstalledPlugins: async () => undefined,
    doctor: {
      nodeVersion: () => process.version,
      gitAvailable: async () => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } },
      pluginRoot: REPO_ROOT,
      manifestError: () => { try { loadManifest(MANIFEST); return null } catch (e) { return e instanceof Error ? e.message : String(e) } },
      fileExists: (p) => { try { return statSync(p).isFile() } catch { return false } },
      fileExecutable: (p) => { try { return (statSync(p).mode & 0o111) !== 0 } catch { return false } },
      dirExists: (p) => { try { return statSync(p).isDirectory() } catch { return false } },
      env: (name) => process.env[name],
      statuslineConfigured: () => false,
      nativeRuntimeHost: async () => 'claude',
      codexAuthStatus: async () => ({ state: 'authenticated' }),
      runVerifySkills: async () => {
        try {
          const output = execFileSync('bash', [
            join(REPO_ROOT, 'tools', 'verify-skills.sh'), '--node', process.execPath,
          ], { encoding: 'utf8' })
          return { code: 0, output }
        } catch (e) {
          const er = e as { status?: number; stdout?: string; stderr?: string }
          return { code: er.status ?? 1, output: `${er.stdout ?? ''}${er.stderr ?? ''}` }
        }
      },
      // 缺技能检测（批2 A1）：harness 不预置外部技能（确定性——不扫开发者本机安装位，doctor 未做 e2e 断言）；
      // 两表走真 manifest（committed，确定性），与 realDeps「真 kernel」精神一致。
      installedSkillNames: () => new Set<string>(),
      manifestSkills: () => {
        try {
          const m = loadManifest(MANIFEST)
          return { mandatory: m.mandatorySkills, recommended: m.recommendedSkills }
        } catch {
          return null
        }
      },
    },
  }
}

/** 建一个真实临时项目 harness。用毕请 rm(h.cwd)。 */
export function makeHarness(cwd: string): Harness {
  const out: string[] = []
  const err: string[] = []
  const governedFixtures = new Set<string>()
  return {
    cwd, out, err,
    run: async (args, options) => {
      out.length = 0
      err.length = 0
      const deps = realDeps(cwd, out, err, options?.env === undefined ? process.env : { ...process.env, ...options.env })
      // Transition-centric suites opt in explicitly. Refresh only the current canonical visit;
      // dedicated evidence suites never enter governedFixtures and retain fail-closed coverage.
      for (const name of governedFixtures) {
        const changeDir = join(cwd, 'openspec', 'changes', name)
        const state = await deps.store.read(changeDir)
        const phase = String(state.fields.phase)
        const track = String(state.fields.track)
        const historyPath = join(changeDir, '.pipeline-history.jsonl')
        let history = await readFile(historyPath, 'utf8').catch(() => '')
        const completed = completedWorkflowSkillsSinceStepEntry(history, phase)
        // A phase receipt is per canonical visit.  Reuse it for read/set commands in the same
        // visit and invoke the real hook only when this visit has not yet loaded its Workflow
        // phase Skill; this keeps transition fixtures faithful without spawning a shell for every
        // preparatory command.
        if (!completed.has(`tenon-${phase}`)) {
          await recordWorkflowPhaseSkill(cwd, changeDir)
          history = await readFile(historyPath, 'utf8').catch(() => '')
        }
        const lines = deps.resolver.resolveDefaultMandatory(phase, track)
          .filter((slot) => !slot.alternatives.some((skill) => completed.has(skill)))
          .map((slot) => slot.alternatives[0])
          .filter((skill): skill is string => skill !== undefined)
          .map((skill) => `${JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })}\n`)
          .join('')
        if (lines !== '') await appendFile(historyPath, lines, 'utf8')
        try {
          await readGovernedDocumentsForCurrentVisit(cwd, changeDir)
        } catch (error) {
          // A test may intentionally remove or stale a document. Let the command under test expose
          // that real ledger failure instead of failing inside fixture preparation.
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : ''
          if (!(error instanceof DocumentLedgerError) && code !== 'ENOENT') throw error
        }
      }
      try {
        await buildProgram(deps).parseAsync(args, { from: 'user' })
        return 0
      } catch (e) {
        if (e instanceof CliExit) return e.code
        throw e
      }
    },
    read: (name) => readFile(join(cwd, 'openspec', 'changes', name, '.pipeline.yaml'), 'utf8'),
    readIn: (name, rel) => readFile(join(cwd, 'openspec', 'changes', name, rel), 'utf8'),
    seedArtifact: (name, field, value) =>
      createStateStore().set(join(cwd, 'openspec', 'changes', name), field as FieldName, value),
    seedPhase: (name, phase) =>
      createStateStore().set(join(cwd, 'openspec', 'changes', name), 'phase', phase),
    satisfyStepTests: async (name, stepId) => {
      const packageJson = join(cwd, 'package.json')
      if (!existsSync(packageJson)) await writeFile(packageJson, FIXTURE_PACKAGE_JSON, 'utf8')
      const harness = makeHarness(cwd)
      await harness.run(['test', 'status', name, '--step', stepId, '--json'])
      const status = JSON.parse(harness.out.join('\n')) as {
        items: Array<{ id: string; required: boolean; status: string }>
      }
      for (const item of status.items) {
        if (!item.required || item.status === 'passed') continue
        const code = await harness.run(['test', 'run', name, item.id])
        if (code !== 0) {
          throw new Error(`harness satisfyStepTests: tenon test run ${name} ${item.id} exit=${code}\n${harness.err.join('\n')}`)
        }
      }
    },
    seedGovernedDocumentEvidence: async (name, overrides) => {
      await seedGovernedDocumentEvidence(
        cwd,
        join(cwd, 'openspec', 'changes', name),
        name,
        overrides,
      )
      if (overrides?.autoSkills !== false) governedFixtures.add(name)
    },
  }
}

/** 便捷：mkdtemp + makeHarness（调用方负责 rm(h.cwd)）。 */
export async function freshHarness(): Promise<Harness> {
  return makeHarness(await mkdtemp(join(tmpdir(), 'lite-e2e-')))
}

export { rm }
