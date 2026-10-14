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
import { appendFile, mkdtemp, mkdir, readFile, rm as fsRm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync, type PathLike, type RmOptions } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeReadyDesignSystem } from '@tenon/kernel/design-system/test-support'
import {
  clearReviewMarkerFor,
  createBuildRevisionToken,
  expectedBuildRevisionKind,
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
  StepOutputLedgerError,
  ensureDocumentLedger,
  candidateFingerprint,
  loadManifest,
  makeGuardFileContext,
  recordDocument,
  recordDocumentReads,
  resolveRequiredSkillSlots,
  loadResourceCatalog,
  resolveProductPaths,
  resolveTenonUser,
  actorOf,
  isTenonUser,
  listTaskWorktrees,
  stateStorageExistsSync,
  withProjectCoordinationLock,
  type BuildRevisionIdentity,
  type FieldName,
} from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { effectiveWorkflowForState } from './commands/effective-workflow.js'
import {
  initLegacyContractDefaultChange, initLegacyDefaultChange, initLegacyStandardChange, initLegacyWorkflowChange,
  type LegacyDefaultOptions,
} from './integration-harness-legacy.js'
import { readGateMarkers } from './gateMarkers.js'
import { detectPlatform, readProcVersion } from './commands/doctor-platform.js'
import {
  FIXED_CLOCK, harnessOpenspecArchive, readGovernedDocumentsForCurrentVisit, recordBoundDocumentsForCurrentVisit,
  seedAppliedSpec, seedGovernedDocumentEvidence,
} from './integration-harness-documents.js'
export { FIXED_CLOCK, FIXTURE_HISTORY_TAG, seedGovernedDocumentEvidence } from './integration-harness-documents.js'
import { harnessArtifactSubmission } from './integration-submission-test-support.js'
import { buildProgram, CliExit } from './program.js'
import {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from './test-support.js'
import { createManifestSkillActionAuthorityResolver } from './skill-action-authority-provider.js'
import { skillProfileChecker } from './skillProfiles.js'
import { recordWorkflowPhaseSkill } from './integration-phase-skill-test-support.js'
import { gitRemoteNames } from './gitRemotes.js'
import { seedStepTestPolicy } from './integration-test-policy-support.js'
import { agentPromptResult, agentWave, pendingRequiredTestIds } from './integration-harness-json.js'
import { probeGitFinish } from './gitWorkspace.js'
import { execGit } from './commands/init-worktree.js'
import { harnessAgentDeps } from './integration-harness-agents.js'
import { ensureCodeSizeProbeOnPath } from './integration-harness-probe.js'
import { loadTestDirections } from './test-system/directions.js'
import { resolveCliLocale } from './i18n/locale.js'
export { recordWorkflowPhaseSkill } from './integration-phase-skill-test-support.js'

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
   * Leave behind what a real `tenon spec apply <name>` leaves behind, for tests that must walk
   * through Ship while their subject is something else. Ship's spec-migration-applied guard now
   * demands this change's own delta spec to be applied, so a test that never applies it is
   * asserting the blocked path on purpose.
   */
  seedAppliedSpec: (name: string) => Promise<void>
  /**
   * 像真实用户那样满足某一步的必需测试：项目声明自己的 npm 脚本，然后逐项 `tenon test run`。
   * 不绕过门禁——跑的是工作流声明的那条命令，落的是真记录。
   */
  satisfyStepTests: (name: string, stepId: string) => Promise<void>
  /**
   * 像真实宿主那样跑完当前步骤声明的 agent：按 `tenon agent next` 的波次逐个 prompt、写一份
   * 无发现的报告、record。不绕过门禁——落的是真台账行。
   */
  satisfyStepAgents: (name: string) => Promise<void>
  /**
   * 立一个快照记着 phase-manifest 的在途 default 任务（升级前的 default 原文，带文档契约），回归旧引擎规则（Review Focus 第 1 条）；
   * 返回 exit code。`options` 同 `initLegacyContractDefault`。
   */
  initLegacyDefault: (name: string, track: string, preset?: string, options?: LegacyDefaultOptions) => Promise<number>
  /**
   * 立一个升级前创建、冻结着文档契约的 default 任务（step-graph 现行引擎，契约模式）：测契约本身
   * （scaffold / record / 按 kind 读取 / `pending_documents` / `register-field`）的用例用它；返回 exit code。
   * `options.definition` 给了就用它（升级前 default 的定义，如在原文上加一条项目级测试、加几条旧轨道）代替升级前的 default 原文；
   * `options.documentLocale` 固定治理文档语言（缺省中文）。
   */
  initLegacyContractDefault: (name: string, track: string, preset?: string, options?: LegacyDefaultOptions) => Promise<number>
  /**
   * 立一个升级前创建、定义里带已删除的键（`inputs` / `outputs` / `artifacts` / `document_contract`）的自定义 workflow 任务：
   * `source` 是 workflow 的 YAML 文本，不经校验直接冻结进快照（之后命令按快照行事，不读项目里的文件）；
   * 平铺工作流的 `track` 缺省为工作流名（隐式轨道）；返回 exit code。
   */
  initLegacyWorkflow: (
    name: string, source: string,
    options?: { readonly track?: string; readonly preset?: string; readonly documentLocale?: 'zh-CN' | 'en' },
  ) => Promise<number>
  /** 立一个按已退役 standard 工作流创建的在途任务（平铺、step-graph、轨道 standard；模板已删，只剩冻结快照）；返回 exit code。 */
  initLegacyStandard: (name: string, preset?: string) => Promise<number>
}

/** 声明式测试项在真实项目里由项目自己的 npm 脚本兑现；夹具项目声明等价的空脚本。 */
const FIXTURE_PACKAGE_JSON = `${JSON.stringify({
  name: 'tenon-harness-fixture',
  private: true,
  version: '0.0.0',
  scripts: { test: 'exit 0', typecheck: 'exit 0', 'test:integration': 'exit 0', bench: 'exit 0' },
}, null, 2)}\n`

let ticks = 0
function tickingClock(): string {
  ticks += 1
  return new Date(Date.parse(FIXED_CLOCK) + ticks * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 真实 deps：与 main.ts 同款 fs 副作用，只把 io 收进数组、clock 固定、gitHeadSha 定桩。 */
export function realDeps(cwd: string, out: string[], err: string[], env: NodeJS.ProcessEnv = process.env): CliDeps {
  const manifest = loadManifest(MANIFEST)
  // 与 main.ts 同一份文件面实现：归档目录的判定只有一处。
  const guardCtx = makeGuardFileContext(cwd, { automationRunner: false })
  const store = createStateStore()
  const recordStore = createTransitionRecordStore()
  const isSkillProfileKnown = skillProfileChecker(manifest)
  return {
    // H10 §1/§8任务7：与 main.ts 同款装配——复用 skillProfileChecker（见 deps.ts 头注），
    // harness 镜像生产装配、不另造一套判定。
    isSkillProfileKnown,
    resolveSkillActionAuthority: createManifestSkillActionAuthorityResolver(manifest, isSkillProfileKnown),
    store,
    taskLifecycle: createTaskLifecycleApplication({
      store, clock: () => FIXED_CLOCK, nowMs: () => Date.now(), runOpenspecArchive: harnessOpenspecArchive,
    }),
    artifactSubmission: harnessArtifactSubmission(cwd, store),
    runRepo: createWorkflowRunRepository({ store, recordStore, clock: () => FIXED_CLOCK }),
    recordStore,
    withProjectLock: (cb) => withProjectCoordinationLock(cwd, cb),
    flow: createFlowEngine(manifest),
    interaction: createInteractionEventRecorder(),
    // 镜像生产装配：技能只看工作流 YAML，不叠加 manifest 矩阵。
    resolver: createEffectiveSkillResolver(manifest),
    cwd,
    // 测试装配默认视为已信任仓库自带的测试命令（R6 的首次信任另有专测：传 TENON_TEST_TRUST='' 关掉这条默认）。
    env: (name) => (name === 'TENON_TEST_TRUST' && env[name] === undefined ? '1' : env[name]),
    user: () => resolveTenonUser(cwd, env),
    userConfigPath: () => resolveProductPaths({ env }).userConfigPath,
    resourceCatalog: () => loadResourceCatalog({ payloadRoot: REPO_ROOT, configRoot: resolveProductPaths({ env }).configRoot }),
    ...harnessAgentDeps(REPO_ROOT, cwd, env),
    testDirections: () => loadTestDirections([join(REPO_ROOT, 'templates', 'test-directions')]),
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    // 与 main.ts 同款：TENON_LANG / LC_* / LANG 选语言；vitest 启动时把 TENON_LANG 钉成 zh，英文用例经 run(env) 覆盖。
    locale: resolveCliLocale((name) => env[name]),
    productPaths: () => resolveProductPaths({ env }),
    // TENON_TEST_TICKING_CLOCK=1：每次读时钟前进一秒（同一固定起点），测试记录的完成时间才分得出先后。
    clock: env.TENON_TEST_TICKING_CLOCK === '1' ? tickingClock : () => FIXED_CLOCK,
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
    readGateMarkers: () => readGateMarkers(cwd),
    readHistoryRaw: async (dir) => { try { return await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8') } catch { return '' } },
    writeBreadcrumb: (dir, content) => writeFile(join(dir, '.breadcrumb'), content, 'utf8'),
    history: createHistoryWriter({ actor: () => { const user = resolveTenonUser(cwd, env); return isTenonUser(user) ? actorOf(user) : undefined } }),
    gitHeadSha: async () => TEST_GIT_HEAD,
    // 真跑 `git remote`：临时项目不是 git 仓，与真机「本地仓库没有远端」同一口径。
    gitRemotes: () => gitRemoteNames(cwd),
    gitFinishProbe: (change) => probeGitFinish(cwd, change),
    taskWorktrees: () => listTaskWorktrees({ repoRoot: cwd, git: execGit }),
    workspaceFingerprint: () => candidateFingerprint(cwd),
    // 临时项目不是 git 仓：登记检查的 diff 来源定桩为「没有改动」。专测全量登记强制的用例在项目里 git init，
    // 并用 TENON_TEST_REAL_DIFF=1 走真实的 git 提供者。
    ...(env.TENON_TEST_REAL_DIFF === '1' ? {} : {
      changedFiles: async () => [],
      protectedChanges: async () => [],
      integrityDiff: async () => ({ files: [] }),
      // 临时项目不是仓库，读不出改动：按生产口径失败关闭（按风险挂载的评审者一律挂上）。
      diffChanges: async () => { throw new Error('临时项目读不出改动') },
    }),
    buildRevisionIdentity: async () => TEST_BUILD_REVISION_IDENTITY,
    captureBuildRevision: async (isolation) => {
      const kind = expectedBuildRevisionKind(isolation)
      return createBuildRevisionToken(
        kind, kind === 'workspace' ? await candidateFingerprint(cwd) : TEST_GIT_HEAD, TEST_BUILD_REVISION_IDENTITY,
      ).value
    },
    writeReviewMarker: (content) => writeFile(join(cwd, '.pipeline-pending-review'), content, 'utf8'),
    clearReviewMarker: (change, event) => clearReviewMarkerFor(cwd, change, event),
    pluginVersion: '0.1.0',
    readInstalledPlugins: async () => undefined,
    doctor: {
      nodeVersion: () => process.version,
      platform: () => detectPlatform({ platform: process.platform, env: process.env, procVersion: readProcVersion }),
      gitAvailable: async () => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } },
      pluginRoot: REPO_ROOT,
      manifestError: () => { try { loadManifest(MANIFEST); return null } catch (e) { return e instanceof Error ? e.message : String(e) } },
      fileExists: (p) => { try { return statSync(p).isFile() } catch { return false } },
      fileExecutable: (p) => { try { return (statSync(p).mode & 0o111) !== 0 } catch { return false } },
      dirExists: (p) => { try { return statSync(p).isDirectory() } catch { return false } },
      env: (name) => process.env[name],
      statuslineConfigured: () => false,
      nativeRuntimeHost: async () => 'claude',
      hostKind: () => 'terminal',
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
  // 声明的必需测试 `tenon test code-size` 由 PATH 上的通过桩兑现（见 integration-harness-probe.ts）。
  ensureCodeSizeProbeOnPath()
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
      // The same opt-in also satisfies the current step's test_policy with approved waivers.
      for (const name of governedFixtures) {
        const changeDir = join(cwd, 'openspec', 'changes', name)
        const state = await deps.store.read(changeDir)
        const phase = String(state.fields.phase)
        await seedStepTestPolicy(deps, cwd, name, phase, FIXED_CLOCK)
        const historyPath = join(changeDir, '.pipeline-history.jsonl')
        let history = await readFile(historyPath, 'utf8').catch(() => '')
        const completed = completedWorkflowSkillsSinceStepEntry(history, phase)
        // The `tenon` receipt is per canonical visit.  Reuse it for read/set commands in the same
        // visit and invoke the real hook only when this visit has not yet loaded the skill; this
        // keeps transition fixtures faithful without spawning a shell for every preparatory
        // command.
        if (!completed.has('tenon')) {
          await recordWorkflowPhaseSkill(cwd, changeDir)
          history = await readFile(historyPath, 'utf8').catch(() => '')
        }
        // 本步必需技能 = 任务计划里该步声明的技能（工作流 YAML），不是机器级 manifest 矩阵。
        const plan = effectiveWorkflowForState(deps, state)
        const requiredSlots = plan === null ? [] : resolveRequiredSkillSlots(deps.resolver, plan.capabilities.skills, phase)
        const lines = requiredSlots
          .filter((slot) => !slot.alternatives.some((skill) => completed.has(skill)))
          .map((slot) => slot.alternatives[0])
          .filter((skill): skill is string => skill !== undefined)
          .map((skill) => `${JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })}\n`)
          .join('')
        if (lines !== '') await appendFile(historyPath, lines, 'utf8')
        if (plan === null) continue
        try {
          // 契约点名为 producer 的必需技能，产物要在本次访问登记才算完成：替它们在本次访问重登。
          await recordBoundDocumentsForCurrentVisit(
            cwd, changeDir, name, plan,
            requiredSlots.flatMap((slot) => slot.alternatives.slice(0, 1)),
          )
          await readGovernedDocumentsForCurrentVisit(cwd, changeDir, plan)
        } catch (error) {
          // A test may intentionally remove or stale a document (or corrupt the step-output ledger).
          // Let the command under test expose that real ledger failure instead of failing inside
          // fixture preparation.
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : ''
          if (!(error instanceof DocumentLedgerError) && !(error instanceof StepOutputLedgerError) && code !== 'ENOENT') throw error
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
      for (const id of pendingRequiredTestIds(harness.out.join('\n'))) {
        const code = await harness.run(['test', 'run', name, id])
        if (code !== 0) {
          throw new Error(`harness satisfyStepTests: tenon test run ${name} ${id} exit=${code}\n${harness.err.join('\n')}`)
        }
      }
      await seedStepTestPolicy(realDeps(cwd, [], []), cwd, name, stepId, FIXED_CLOCK)
    },
    satisfyStepAgents: async (name) => {
      const harness = makeHarness(cwd)
      for (let round = 0; round < 8; round++) {
        if (await harness.run(['agent', 'next', name, '--json']) !== 0) return
        const wave = agentWave(harness.out.join('\n'))
        if (wave.length === 0) return
        for (const agent of wave) {
          if (await harness.run(['agent', 'prompt', name, agent, '--host', 'claude', '--json']) !== 0) {
            throw new Error(`harness satisfyStepAgents: prompt ${agent} 失败\n${harness.err.join('\n')}`)
          }
          const started = agentPromptResult(harness.out.join(''))
          if (started === null) {
            throw new Error(`harness satisfyStepAgents: prompt ${agent} 输出形状非法\n${harness.out.join('')}`)
          }
          const body = started.role === 'executor' ? '{"result":"done","findings":[]}' : '{"findings":[]}'
          await mkdir(join(cwd, started.report_path, '..'), { recursive: true })
          await writeFile(
            join(cwd, started.report_path),
            `# ${agent}\n\n\u0060\u0060\u0060tenon-result\n${body}\n\u0060\u0060\u0060\n`,
            'utf8',
          )
          if (await harness.run(['agent', 'record', name, started.run_id]) !== 0) {
            throw new Error(`harness satisfyStepAgents: record ${agent} 失败\n${harness.err.join('\n')}`)
          }
        }
      }
    },
    initLegacyDefault: async (name, track, preset = 'full', options) => {
      out.length = 0
      err.length = 0
      return initLegacyDefaultChange(realDeps(cwd, out, err, process.env), cwd, name, track, preset, options)
    },
    initLegacyContractDefault: async (name, track, preset = 'full', options) => {
      out.length = 0
      err.length = 0
      return initLegacyContractDefaultChange(realDeps(cwd, out, err, process.env), cwd, name, track, preset, options)
    },
    initLegacyWorkflow: async (name, source, options = {}) => {
      out.length = 0
      err.length = 0
      return initLegacyWorkflowChange(realDeps(cwd, out, err, process.env), cwd, name, source, { ...options, preset: options.preset ?? 'full' })
    },
    initLegacyStandard: async (name, preset = 'full') => {
      out.length = 0
      err.length = 0
      return initLegacyStandardChange(realDeps(cwd, out, err, process.env), cwd, name, preset)
    },
    seedAppliedSpec: (name) =>
      seedAppliedSpec(cwd, join(cwd, 'openspec', 'changes', name), name),
    seedGovernedDocumentEvidence: async (name, overrides) => {
      const changeDir = join(cwd, 'openspec', 'changes', name)
      const plan = effectiveWorkflowForState(realDeps(cwd, [], []), await createStateStore().read(changeDir))
      if (plan === null) throw new Error(`harness seedGovernedDocumentEvidence: ${name} 的工作流不可用`)
      await seedGovernedDocumentEvidence(cwd, changeDir, name, plan, overrides)
      if (overrides?.autoSkills !== false) governedFixtures.add(name)
    },
  }
}

/**
 * 便捷：mkdtemp + makeHarness（调用方负责 rm(h.cwd)）。
 *
 * 临时仓库自带一套就绪的设计体系：default 的前端分支首步要求项目 DESIGN.md 就绪，没有它任何前端
 * 任务都立不了项。要测这条前置条件的用例自己 removeDesignSystem(h.cwd)。
 */
export async function freshHarness(): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'lite-e2e-'))
  writeReadyDesignSystem(cwd)
  return makeHarness(cwd)
}

const RM_MAX_RETRIES = 10
const RM_RETRY_DELAY_MS = 100

/**
 * 清理临时项目的唯一入口（测试都从这里 import rm）。递归删除默认带重试：用例超时或刚被取消时，
 * 上一步还在收尾的异步写会在 rm 遍历目录的同时往里建文件，裸 rm 会以 ENOTEMPTY 失败并把真正的失败盖住。
 * 调用方显式传的选项优先。
 */
export function rm(path: PathLike, options?: RmOptions): Promise<void> {
  return fsRm(path, { maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS, ...options })
}

