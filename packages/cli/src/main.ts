#!/usr/bin/env node
/**
 * bin 入口：装配 kernel 实现 + fs 副作用，交给 buildProgram。
 *
 * ⚠️ 集成接缝（T7）：createStateStore / createFlowEngine / loadManifest 由 T2/T3 落地后
 * 从 '@tenon/kernel' re-export——在那之前本文件编译失败是预期的（plan T4 明示）。
 * 若 kernel 侧签名不同（如 loadManifest 需要 manifest.yaml 路径参数），仅调整此处装配，
 * 命令模块与测试不受影响。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommanderError } from 'commander'
import {
  clearReviewMarkerFor, createTaskLifecycleApplication,
  BUILTIN_TRACK_DEFINITIONS, createEffectiveSkillResolver, createFlowEngine, createHistoryWriter, createStateStore,
  createInteractionEventRecorder, createTransitionRecordStore, createWorkflowRunRepository, loadManifest, loadTrackRegistry, loadWorkflow,
  fingerprintWorkspace, loadResourceCatalog, mutateTrackRegistry, readSecrets, registerProjectRoot,
  createBuildRevisionToken, probeBuildRevisionIdentity, createOrchestrationLedger,
  type BoardCommandV2, type BoardSnapshotV2, type WorkflowPipelinePlanV2,
  withTrackRegistryLock, resolveTenonUser, type TenonUserResolution, actorOf, isTenonUser, USER_MISSING_HINT,
} from '@tenon/kernel'
import {
  createDocumentProjectionAdapter,
  createFieldProjectionAdapter,
  createProductionExecutionRuntimeV2,
  artifactNamespaceForChange,
  openArtifactService,
  openArtifactSubmissionService,
} from '@tenon/automation'
import type { ExtendedManifestData, TrackRegistry, TrackValidationContext } from '@tenon/kernel'
import type { CliDeps, GateMarkerInfo } from './deps.js'
import { splitPassthroughArgv } from './argv.js'
import { buildProgram, CliExit } from './program.js'
import { createProductionTriageRuntime } from './commands/triage.js'
import { listChangeDirs, listChanges, makeGuardCtx } from './guardContext.js'
import { createRuntimeScopeResolver } from './runtime/scope.js'
import { createManifestSkillActionAuthorityResolver } from './skill-action-authority-provider.js'
import { makeDoctorProbes } from './commands/doctor-probes.js'

/** ISO8601 UTC 秒级（对齐老内核 date -u +%Y-%m-%dT%H:%M:%SZ 口径） */
function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * `git rev-parse HEAD` 的 stdout（失败也取 stdout——对齐老内核
 * `$(git rev-parse HEAD 2>/dev/null || echo "")`：unborn 仓捕获字面 "HEAD"，T6 实测怪癖）。
 */
function gitHeadSha(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (_err, stdout) => {
      resolve((stdout ?? '').trim())
    })
  })
}

/** 项目根三门 marker（缺失即不在收件箱；新鲜判定归 inbox 命令） */
async function readGateMarkers(cwd: string): Promise<GateMarkerInfo[]> {
  const out: GateMarkerInfo[] = []
  for (const kind of ['confirm', 'review', 'interaction'] as const) {
    try {
      const p = join(cwd, `.pipeline-pending-${kind}`)
      const st = await stat(p)
      out.push({ kind, ageMs: Date.now() - st.mtimeMs, raw: await readFile(p, 'utf8') })
    } catch {
      // 缺失 = 无该门等待
    }
  }
  return out
}

/**
 * 运行期定位插件仓根：编译产物在 packages/cli/dist/main.js，
 * 根 = 其上三级（dist → cli → packages → 根）。loadManifest 不猜仓库根（T3 约定）。
 */
function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function manifestPath(): string {
  return join(pluginRoot(), 'templates', 'manifest.yaml')
}

/**
 * Track Registry 校验上下文（GOAL.md 清单 T · R2）：
 *  - workflowExists 复用 loadWorkflow（'default' 恒存在，其余按 .pipeline/workflows/<id>.yaml 是否可载）；
 *  - skillProfiles = 内建轨 skill profile（pm/frontend/backend，即 manifest 现行 skill 表 track 键）
 *    ∪ manifest 两表已声明的非 '_all' 键。缺 tracks.yaml 时 registry=内建 Track、本上下文不会被查
 *    （validateTrackRegistry 只在 tracks.yaml 存在时跑），此处仍如实构造，让自定义 tracks.yaml 能过校验。
 * skill profile 键空间改名属清单 T 的 R5 阶段（见 GOAL.md）——R2 不改 manifest 结构，只按现行键派生。
 */
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

/**
 * Read the release version from the native host manifests. Codex is preferred because it is the
 * canonical marketplace package; Claude remains a compatibility fallback for an older checkout.
 */
function readPluginVersion(): string {
  for (const rel of [
    ['.codex-plugin', 'plugin.json'],
    ['.claude-plugin', 'plugin.json'],
  ]) {
    try {
      const raw = readFileSync(join(pluginRoot(), ...rel), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed
        ? parsed.version
        : undefined
      if (typeof version === 'string' && version.trim() !== '') return version
    } catch {
      // Try the compatibility manifest before falling back to unknown.
    }
  }
  return 'unknown'
}

async function main(): Promise<void> {
  const runtimeScope = createRuntimeScopeResolver({
    env: () => process.env,
    homeDir: homedir,
  })
  const runtimePaths = () => runtimeScope().paths
  const manifest = loadManifest(manifestPath())
  const { toParse, passthrough } = splitPassthroughArgv(process.argv)
  const store = createStateStore()
  // Track Registry：装配处构造上下文，**每次从盘 fresh-load、不跨命令记忆化**（R3 D4）。只读
  // 命令走 loadRegistry；init/fields 组合校验走 withRegistryLock（registry 锁内 fresh-load）；
  // tracks CRUD 走 mutateRegistry（mutate-under-lock）。坏 tracks.yaml 只 fail-loud 到相关命令。
  const trackCtx = trackValidationContext(process.cwd(), manifest)
  const runRepo = createWorkflowRunRepository({
    store,
    recordStore: createTransitionRecordStore(),
    clock: isoNow,
  })
  let resolvedUser: TenonUserResolution | undefined
  const resolveUser = (): TenonUserResolution => (resolvedUser ??= resolveTenonUser(process.cwd(), process.env))
  const currentActor = () => {
    const user = resolveUser()
    return isTenonUser(user) ? actorOf(user) : undefined
  }
  const deps: CliDeps = {
    orchestrationRuntime: async (changeDir) => createProductionExecutionRuntimeV2({ change_dir: changeDir, ledger: createOrchestrationLedger(), worker_id: `cli:${process.pid}` }),
    orchestrationFreezePipeline: async ({ changeDir, pipeline }: { readonly changeDir: string; readonly pipeline: WorkflowPipelinePlanV2 }): Promise<BoardSnapshotV2> => {
      const ledger = createOrchestrationLedger()
      const snapshot = await ledger.readSnapshot(changeDir)
      if (snapshot === undefined) throw new Error('orchestration ledger 未初始化')
      const commandId = `cli:freeze-pipeline:${pipeline.pipeline_id}:${pipeline.pipeline_version}`
      const command: BoardCommandV2 = {
        schema_version: 'board-command/v2', command_id: commandId, idempotency_key: `idem:${commandId}`,
        expected_revision: snapshot.revision, actor: { kind: 'user', id: 'cli' }, issued_at: isoNow(),
        correlation_id: snapshot.correlation_id, ...(snapshot.event_head_id === undefined ? {} : { causation_id: snapshot.event_head_id }),
        change_id: snapshot.change_id, type: 'freeze-pipeline', pipeline,
      }
      const result = await ledger.append(changeDir, command)
      if (result.kind === 'rejected') throw new Error(`${result.rejection.reason_code}: ${result.rejection.message}`)
      return result.snapshot
    },
    artifactSubmission: async ({ changeDir, phase, policy }) => {
      const namespace = artifactNamespaceForChange(changeDir)
      return openArtifactSubmissionService({
        changeDir,
        namespace,
        repoRoot: process.cwd(),
        ...(phase !== undefined && policy !== undefined
          ? { document: createDocumentProjectionAdapter({ repoRoot: process.cwd(), changeDir, phase, policy }) }
          : {}),
        field: createFieldProjectionAdapter({ store, changeDir, persist: false }),
        runtime: {
          submitArtifactOutput: async (stageAttemptId, input) => {
            const output = await (await openArtifactService({ rootDir: changeDir, scopeId: namespace })).submitArtifactOutput(stageAttemptId, input as never)
            return {
              artifactId: output.artifactId,
              version: output.version,
              contentDigest: output.contentDigest.replace(/^sha256:/u, ''),
              ...(output.subjectRef ? { subjectRef: output.subjectRef } : {}),
            }
          },
        },
      })
    },
    // H10 §1/§8任务7：skill_bundle_id 存在性语义校验器——直接复用上面 trackCtx.skillProfiles
    // （T 线 tracks/validate.ts::profileOk 消费的同一份集合：BUILTIN_TRACK_DEFINITIONS 非 `_all`
    // policy profile ∪ manifest 两表已声明的非 `_all` track 键），零额外 manifest 解析/新正则。
    // afk.ts 的 cmdAfk('run') 装配 createLoopAdmission 时转发本字段；loop-run.ts 的 --dry-run
    // wiring 预览同样消费（见 deps.ts 头注）。
    isSkillProfileKnown: (id) => trackCtx.skillProfiles.has(id),
    resolveSkillActionAuthority: createManifestSkillActionAuthorityResolver(
      manifest,
      (profile) => trackCtx.skillProfiles.has(profile),
    ),
    store,
    interaction: createInteractionEventRecorder(),
    runRepo,
    loadRegistry: () => loadTrackRegistry(process.cwd(), trackCtx),
    withRegistryLock: (cb) => withTrackRegistryLock(process.cwd(), trackCtx, cb),
    mutateRegistry: (cb) => mutateTrackRegistry(process.cwd(), trackCtx, cb),
    flow: createFlowEngine(manifest),
    // T-R6：artifact 按现载 track registry 映射 skill profile；loader 每次 fresh-read，避免同进程
    // tracks CRUD 后复用旧快照。H10 skill bundle 走 resolver 的显式 profile 入口，不受此映射干扰。
    resolver: createEffectiveSkillResolver({
      registry: () => loadTrackRegistry(process.cwd(), trackCtx),
      manifest,
    }),
    cwd: process.cwd(),
    env: (name) => process.env[name],
    user: resolveUser,
    taskLifecycle: createTaskLifecycleApplication({ store, clock: isoNow, nowMs: () => Date.now() }),
    userConfigPath: () => runtimePaths().userConfigPath,
    resourceCatalog: () => loadResourceCatalog({ payloadRoot: pluginRoot(), configRoot: runtimePaths().configRoot }),
    designValidator: {
      // 上游 hue 随插件安装；技能没装时返回空串，命令据此给出安装提示而不是去 spawn 不存在的脚本。
      path: () => {
        const script = join(pluginRoot(), 'skills', 'hue', 'scripts', 'validate.mjs')
        return existsSync(script) ? script : ''
      },
      run: (script, folder, cwd) => new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [script, folder], { cwd, stdio: 'inherit' })
        child.on('error', () => resolve(1))
        child.on('close', (code) => resolve(code ?? 1))
      }),
    },
    io: {
      out: (line: string) => process.stdout.write(`${line}\n`),
      err: (line: string) => process.stderr.write(`${line}\n`),
    },
    clock: isoNow,
    listChanges,
    listChangeDirs,
    guardCtx: makeGuardCtx(process.cwd()),
    doctor: makeDoctorProbes(runtimeScope, pluginRoot()),
    readGateMarkers: () => readGateMarkers(process.cwd()),
    writeBreadcrumb: (dir, content) => writeFile(join(dir, '.breadcrumb'), content, 'utf8'),
    history: createHistoryWriter({ actor: currentActor }),
    // init 成功后 best-effort 登记项目根到 Tenon config root 的 projects.json
    registerProject: async (repoRoot) => {
      await registerProjectRoot(runtimePaths().registryPath, repoRoot)
    },
    // v6 T2：afk run 凭证注入——机器级 secrets 读成 env 形状（kernel readSecrets 自身 fail-open，
    // 缺失/损坏 → 空 keys）；值不落日志。
    readSecretsEnv: async () => readSecrets(runtimePaths().secretsPath).keys,
    readHistoryRaw: async (dir) => {
      try {
        return await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8')
      } catch {
        return ''
      }
    },
    gitHeadSha: () => gitHeadSha(process.cwd()),
    workspaceFingerprint: () => fingerprintWorkspace(process.cwd()),
    captureBuildRevision: async (isolation) => {
      const identity = await probeBuildRevisionIdentity(process.cwd())
      if (!identity) throw new Error('build revision identity unavailable')
      const kind = isolation === 'in-place' ? 'workspace' as const : 'git' as const
      const revision = kind === 'workspace'
        ? await fingerprintWorkspace(process.cwd())
        : await gitHeadSha(process.cwd())
      return createBuildRevisionToken(kind, revision, identity).value
    },
    writeReviewMarker: (content) => writeFile(join(process.cwd(), '.pipeline-pending-review'), content, 'utf8'),
    clearReviewMarker: (change, event) => clearReviewMarkerFor(process.cwd(), change, event),
    pluginVersion: readPluginVersion(),
    readInstalledPlugins: async () => {
      for (const p of [join(pluginRoot(), '..', 'installed_plugins.json'), join(process.env.HOME ?? '', '.claude', 'installed_plugins.json')]) {
        try { return await readFile(p, 'utf8') } catch { /* 试下一个 */ }
      }
      return undefined
    },
    passthroughArgv: passthrough,
  }

  try {
    await buildProgram(deps, {
      triage: createProductionTriageRuntime({
        repoRoot: deps.cwd,
        store,
        runRepository: runRepo,
        clock: isoNow,
        creator: () => {
          const actor = currentActor()
          if (actor === undefined) throw new Error(USER_MISSING_HINT)
          return actor
        },
      }),
    }).parseAsync(toParse)
  } catch (e) {
    if (e instanceof CliExit) {
      process.exitCode = e.code
    } else if (e instanceof CommanderError) {
      // usage error / help 展示；commander 已把消息写去 stderr（configureOutput）
      process.exitCode = e.exitCode
    } else {
      process.stderr.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exitCode = 1
    }
  }
}

void main()
