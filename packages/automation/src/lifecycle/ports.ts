/**
 * 生产 LifecyclePorts 装配（BACKLOG #29c）—— 把真 docker/git/worktree 实现接进 #29 lifecycle 的注入面。
 *
 * #29 的 runChangeInSandbox 是纯编排 + 注入 port；本工厂提供**真实现**（不改 lifecycle 编排核心）：
 *   worktree      → 真 git worktree add/remove（worktree.ts）
 *   createSandbox → 真 docker 容器 + git 双挂载（container.ts + gitMounts.ts）
 *   runWork       → 沙箱内 tenon-afk-run + 三路 race（idle/grace/abort）+ 结构化握手解析（race.ts + runner.ts）
 *                   + 结算（成功/失败）落盘完整 stdout+stderr 到 host 侧
 *                   openspec/changes/<name>/.sandcastle-run.log（afk-workbench Task 2；不是
 *                   automation_last_error 里那 200 字符截断片段——teardown 现场缺口修复见
 *                   `.superpowers/sdd/task-2-report.md` "Fix: log survives teardown"：早期版本
 *                   落在 worktree 内，成功/普通失败两类结算会被 runChangeInSandbox 的 finally 块
 *                   随 worktree 一起删掉，只有 abort/conflict 保留现场才读得到；host 侧目录只随
 *                   change 本身存在，不随某次 run 的 worktree 一起 teardown）
 *   collectCommits→ 真 git rev-list 命名分支（mergeback.ts）
 *   mergeToBase   → 真 git merge DELIVERY + 冲突留现场（mergeback.ts）—— 仅 L3 调
 *   git           → 真 git rev-parse（barrier build_sha 派生）
 *
 * 真部署调用链：packages/cli/src/commands/afk.ts::cmdAfk（`tenon afk run`）→
 * createDockerRunChange（sdk/dockerRunChange.ts，在此装配本工厂）→ automation.runRound。默认
 * L1 report-only（autoMerge=false → 不调 mergeToBase），仅 L3 真 merge-back。
 */
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertLoopRunner, isTenonUser, resolveTenonUser, type TenonUserResolution } from '@tenon/kernel'
import type { PreparedSkillBundle } from '../admission/execution-context.js'
import { BoundedTail, MAX_TAIL_CHARS } from '../runner/boundedTail.js'
import {
  copyAndSealDirectoryInContainer,
  createDockerSandbox,
  SKILL_BUNDLE_VERIFY_FAIL_EXIT_CODE,
  type ContainerMount,
} from '../runner/container.js'
import type { ExecFn, ExecResult } from '../runner/exec.js'
import { resolveGitMounts } from '../runner/gitMounts.js'
import {
  DEFAULT_COMPLETION_SIGNAL,
  DEFAULT_COMPLETION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  invokeWithRace,
} from '../runner/race.js'
import {
  buildAfkRunCommand, filterRunnerEnvironment, parseSandboxReport, type ImageRunExpectation,
} from '../runner/runner.js'
import { buildCanonicalManifest, computePublishDigest, SKILL_SNAPSHOT_COMMIT_MARKER } from '../skills/snapshot-store.js'
import {
  createDefaultVerifierPort,
  type VerificationIssuerIdentity,
  type VerifierPort,
} from '../verifier/verifier.js'
import { SKILL_BUNDLE_CONTAINER_DIR, type LifecyclePorts } from './lifecycle.js'
import { collectCommitsReal, diffNamesReal, mergeBackToBase, realGitFace } from './mergeback.js'
import { realWorktreePort } from './worktree.js'

/**
 * H10 §4/§8任务6：容器消费前 host 侧重新核验 canonical hash 失败（manifest.json 记录的 digest 与
 * admission 冻结值不符 / 具体 skill 内容与冻结 treeSha256 不符 / manifest.json 不可读或非法
 * JSON）。createSandbox 据此 throw——不创建容器、不返回可用句柄，agent 绝不会启动（详见下方
 * verifySkillBundleSnapshot）。
 */
export class SkillBundleSnapshotMismatchError extends Error {
  override readonly name = 'SkillBundleSnapshotMismatchError'
  readonly _tag = 'SkillBundleSnapshotMismatchError'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasClosedKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

/** manifest descriptor 的递归闭集校验；未知字段在任何对象层级都不得被 canonical digest 静默忽略。 */
function isClosedSkillSnapshotManifest(manifest: Record<string, unknown>): boolean {
  if (!hasClosedKeys(manifest, ['schemaVersion', 'digest', 'skills', 'files'], ['provenance'])) return false
  if (manifest.schemaVersion !== 1 || typeof manifest.digest !== 'string') return false

  if (!Array.isArray(manifest.skills) || !manifest.skills.every((skill: unknown) =>
    isRecord(skill)
    && hasClosedKeys(skill, ['skillId', 'treeSha256', 'fileCount'])
    && typeof skill.skillId === 'string'
    && typeof skill.treeSha256 === 'string'
    && Number.isSafeInteger(skill.fileCount)
    && (skill.fileCount as number) >= 0)) return false

  if (!Array.isArray(manifest.files) || !manifest.files.every((file: unknown) =>
    isRecord(file)
    && hasClosedKeys(file, ['relativePath', 'sha256', 'executable'])
    && typeof file.relativePath === 'string'
    && typeof file.sha256 === 'string'
    && typeof file.executable === 'boolean')) return false

  if (manifest.provenance === undefined) return true
  const provenance = manifest.provenance
  if (!isRecord(provenance)
    || !hasClosedKeys(
      provenance,
      ['loop_id', 'policy_epoch', 'skill_bundle_id', 'attempt_id', 'reservation_id', 'workflow', 'step', 'track', 'coordinate_digest', 'resolution_source', 'slots'],
      ['workflow_run_id'],
    )) return false
  for (const key of ['loop_id', 'policy_epoch', 'skill_bundle_id', 'attempt_id', 'reservation_id', 'workflow', 'step', 'track', 'coordinate_digest']) {
    if (typeof provenance[key] !== 'string') return false
  }
  if (provenance.workflow_run_id !== undefined && typeof provenance.workflow_run_id !== 'string') return false
  if (provenance.resolution_source !== 'default' && provenance.resolution_source !== 'custom') return false
  return Array.isArray(provenance.slots) && provenance.slots.every((slot: unknown) =>
    isRecord(slot)
    && hasClosedKeys(slot, ['alternatives', 'concrete_skill_id', 'tree_sha256'])
    && Array.isArray(slot.alternatives)
    && slot.alternatives.every((alternative: unknown) => typeof alternative === 'string')
    && typeof slot.concrete_skill_id === 'string'
    && typeof slot.tree_sha256 === 'string')
}

/** CAS 磁盘树必须与 descriptor 精确相等；空目录也算条目，不能藏在文件清单之外。 */
async function assertNoUndeclaredCasEntries(
  hostCasDir: string,
  descriptorFiles: readonly { readonly relativePath: string }[],
): Promise<void> {
  const expected = new Set<string>(['F:manifest.json', `F:${SKILL_SNAPSHOT_COMMIT_MARKER}`])
  for (const file of descriptorFiles) {
    const diskPath = `skills/${file.relativePath}`
    expected.add(`F:${diskPath}`)
    const segments = diskPath.split('/')
    for (let i = 1; i < segments.length; i++) expected.add(`D:${segments.slice(0, i).join('/')}`)
  }

  const actual = new Set<string>()
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let names
    try {
      names = await readdir(absDir)
    } catch (e) {
      throw new SkillBundleSnapshotMismatchError(`skill bundle CAS 目录不可读（${absDir}）：${(e as Error).message}`)
    }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name
      const abs = join(absDir, name)
      let entry
      try {
        entry = await lstat(abs)
      } catch (e) {
        throw new SkillBundleSnapshotMismatchError(`skill bundle CAS 条目不可读（${abs}）：${(e as Error).message}`)
      }
      if (entry.isDirectory()) {
        actual.add(`D:${rel}`)
        await walk(abs, rel)
      } else if (entry.isFile()) {
        actual.add(`F:${rel}`)
      } else {
        throw new SkillBundleSnapshotMismatchError(`skill bundle CAS 含未声明条目或特殊类型：${rel}`)
      }
    }
  }
  await walk(hostCasDir, '')

  const unexpected = [...actual].filter((entry) => !expected.has(entry)).sort()
  const missing = [...expected].filter((entry) => !actual.has(entry)).sort()
  if (unexpected.length > 0 || missing.length > 0) {
    throw new SkillBundleSnapshotMismatchError(
      `skill bundle CAS 含未声明条目或缺失声明条目（${hostCasDir}；未声明=${JSON.stringify(unexpected)}；缺失=${JSON.stringify(missing)}）`,
    )
  }
}

async function assertCommittedCasSnapshot(hostCasDir: string, digest: string): Promise<void> {
  let rootBefore
  try {
    rootBefore = await lstat(hostCasDir)
  } catch (e) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle CAS 根目录不可读（${hostCasDir}）：${(e as Error).message}`)
  }
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle CAS 根目录不是可信普通目录（${hostCasDir}）`)
  }

  const markerPath = join(hostCasDir, SKILL_SNAPSHOT_COMMIT_MARKER)
  let markerHandle
  try {
    markerHandle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle CAS 缺少可信 commit marker（${markerPath}）：${(e as Error).message}`)
  }
  try {
    const markerStat = await markerHandle.stat()
    if (!markerStat.isFile()) throw new Error('commit marker 不是普通文件')
    const marker = await markerHandle.readFile()
    if (!marker.equals(Buffer.from(`${digest}\n`, 'utf8'))) throw new Error('commit marker 内容与 digest 不一致')
    const rootAfter = await lstat(hostCasDir)
    if (!rootAfter.isDirectory() || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino) {
      throw new Error('CAS 根目录在 commit marker 读取期间发生替换（TOCTOU）')
    }
  } catch (e) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle CAS commit marker 非法（${markerPath}）：${(e as Error).message}`)
  } finally {
    await markerHandle.close()
  }
}

/**
 * H10 r5：createSandbox 把 skill bundle 复制进容器之前，在 host 侧重新核验 canonical hash（TOCTOU：
 * prepareSkillBundle 物化时刻 ≠ 此刻即将 docker cp 给容器消费的时刻）。复用 snapshot-store.ts 已测试
 * 过的同一份 `buildCanonicalManifest`，不发明第二套遍历/哈希算法：
 *   ① 读 `<hostCasDir>/manifest.json` 的 `digest` 字段，与 `bundle.snapshotSha256` 做字符串核对——
 *      定位"挂错快照目录"一类漂移（manifest.json 不可读/非法 JSON/字段不符都在此处失败）。
 *   ② 对 `bundle.slots` 逐条重新遍历 `skills/<concreteSkillId>/` 算 treeSha256，与冻结记录核对——
 *      定位"内容被篡改"一类漂移（manifest.json 自身即便被同步篡改也盖不住这一步：它独立重新读
 *      原始文件字节，不信任 manifest.json 里任何关于 skill 内容的转述）。
 * 任一不符 / 读取失败都在此处 throw（本函数本身不产 SkillBundleFailureReason 闭集字符串——那是
 * H10 任务5 admission 层的判定词表，见 execution-context.ts；本函数只负责诚实地"发现了不一致"）。
 *
 * 本核验发生在 createDockerSandbox 之前，能更早拦截已损坏快照；它与容器入口复核职责不同：
 * host 校验后到 docker cp 完成之间仍有真实 TOCTOU 窗口。ports 随后起无 CAS bind mount 的容器，
 * docker cp 后以 root 封存；真正不可跳过、发生在 agent 启动前的权威复核在容器执行链内部：
 * `tools/sandcastle/tenon-afk-run.sh`（Claude/Codex 两条 agent 分派分支起 agent
 * 前都会先重算聚合 digest 并与 `TENON_SKILL_BUNDLE_SHA256` 比对），不一致时以
 * `container.ts::SKILL_BUNDLE_VERIFY_FAIL_EXIT_CODE` 退出，见下方 `runWork` 对该退出码的识别。
 */
async function verifySkillBundleSnapshot(hostCasDir: string, bundle: PreparedSkillBundle): Promise<void> {
  let manifestRaw: string
  try {
    manifestRaw = await readFile(join(hostCasDir, 'manifest.json'), 'utf8')
  } catch (e) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle 快照 manifest.json 不可读（${hostCasDir}）：${(e as Error).message}`)
  }
  let manifest: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(manifestRaw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('顶层应为 object')
    manifest = parsed as Record<string, unknown>
  } catch (e) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle 快照 manifest.json 不是合法 JSON（${hostCasDir}）：${(e as Error).message}`)
  }
  if (!isClosedSkillSnapshotManifest(manifest)) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle manifest schema/字段闭集非法（${hostCasDir}）`)
  }
  if (manifest.digest !== bundle.snapshotSha256) {
    throw new SkillBundleSnapshotMismatchError(
      `skill bundle 快照 manifest.json 记录的 digest（${String(manifest.digest)}）与 admission 冻结值（${bundle.snapshotSha256}）不一致（${hostCasDir}）`,
    )
  }
  await assertCommittedCasSnapshot(hostCasDir, bundle.snapshotSha256)
  await assertNoUndeclaredCasEntries(
    hostCasDir,
    manifest.files as readonly { readonly relativePath: string }[],
  )
  const unique = [...new Map(bundle.slots.map((s) => [s.concreteSkillId, s])).values()]
  const recomputedManifests: { skillId: string; treeSha256: string; files: readonly { relativePath: string; sha256: string; executable: boolean }[] }[] = []
  for (const slot of unique) {
    let recomputed: { treeSha256: string }
    try {
      recomputed = await buildCanonicalManifest(slot.concreteSkillId, join(hostCasDir, 'skills', slot.concreteSkillId))
    } catch (e) {
      throw new SkillBundleSnapshotMismatchError(`skill '${slot.concreteSkillId}' 内容重新核验失败（${hostCasDir}）：${(e as Error).message}`)
    }
    if (recomputed.treeSha256 !== slot.treeSha256) {
      throw new SkillBundleSnapshotMismatchError(
        `skill '${slot.concreteSkillId}' 内容 hash 与 admission 冻结值不一致（现 ${recomputed.treeSha256} ≠ 记录 ${slot.treeSha256}，${hostCasDir}）——快照可能被篡改`,
      )
    }
    const full = await buildCanonicalManifest(slot.concreteSkillId, join(hostCasDir, 'skills', slot.concreteSkillId))
    recomputedManifests.push(full)
  }
  const files = recomputedManifests.flatMap((m) => m.files.map((f) => ({ relativePath: `${m.skillId}/${f.relativePath}`, sha256: f.sha256, executable: f.executable })))
    // 必须与 snapshot-store::byRelativePath 的 canonical 代码点顺序逐字一致；localeCompare
    // 受 locale/大小写排序影响（例如 SKILL.md 与 scripts/run.sh），会把真实合法快照误判损坏。
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
  const skills = recomputedManifests.map((m) => ({ skillId: m.skillId, treeSha256: m.treeSha256, fileCount: m.files.length }))
    .sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0)
  const provenance = manifest.provenance as Parameters<typeof computePublishDigest>[2]
  const digest = computePublishDigest(files, skills, provenance)
  if (digest !== bundle.snapshotSha256 || JSON.stringify(manifest.files) !== JSON.stringify(files) || JSON.stringify(manifest.skills) !== JSON.stringify(skills)) {
    throw new SkillBundleSnapshotMismatchError(`skill bundle manifest descriptor 与实际内容不一致（${hostCasDir}）`)
  }
}

export interface LifecyclePortsDeps {
  readonly exec: ExecFn
  readonly hostRepoDir: string
  /** 沙箱镜像名；缺省 sandcastle:local（主会话按 repo 派生）。 */
  readonly image?: string
  /** 容器 --user uid:gid；缺省取 host uid/gid（防污染 host worktree，DESIGN §7-item5）。 */
  readonly uid?: number
  readonly gid?: number
  /** --cpus 限额（防单 change 吃满 CPU 饿死其余，DESIGN §3.2）。 */
  readonly cpus?: number
  readonly idleMs?: number
  readonly graceMs?: number
  readonly completionSignals?: readonly string[]
  /**
   * 运行期状态字段写回注入（automation_sandbox/automation_worktree 等）。生产装配见
   * sdk/dockerRunChange.ts：注入了真 kernel StateStore 时，把 name 解析成 join(hostRepoDir,
   * 'openspec', 'changes', name) 再转发给 StateStore.set（同 sdk.ts::storeWriter 同款模式）。
   * 可选端口——省略时走下方 no-op 缺省，写回静默跳过，不 throw、不阻断 run：本包不硬依赖
   * StateStore，无状态写回需求的调用方（如注入 fake exec 的单测）直接不传。
   */
  readonly setStateField?: (name: string, field: string, value: string) => Promise<void>
  /** Host identity forwarded as `TENON_USER` / `TENON_USER_NAME`; defaults to resolveTenonUser(hostRepoDir). */
  readonly hostUser?: () => TenonUserResolution
  /**
   * H7 verifier Phase 2：host 侧核验产生面（可选注入真实核验能力）。缺省
   * createDefaultVerifierPort()——未接线真实核验时诚实回 inconclusive，绝不冒充 trusted pass
   * （见 verifier.ts 顶注）。真部署接线：createDockerRunChange({ verifier }) 透传到此处。
   */
  readonly verifier?: VerifierPort
  /**
   * 自定义 verifier 的 host 侧完整身份锚。与 verifier 一起透传到 LifecyclePorts；缺席时
   * lifecycle 只接受默认 verifier 的固定 identity，绝不从 verifier 返回对象反推信任。
   */
  readonly verifierExpectedIssuerIdentity?: VerificationIssuerIdentity
  /** host 运行中的 bundled CLI 摘要期望；缺席只保留脚本守卫，存在时再启用 CLI+attestation 守卫。 */
  readonly imageExpectation?: ImageRunExpectation
}

export const createLifecyclePorts = (deps: LifecyclePortsDeps): LifecyclePorts => {
  const { exec, hostRepoDir } = deps
  const image = deps.image ?? 'sandcastle:local'
  const uid = deps.uid ?? process.getuid?.()
  const gid = deps.gid ?? process.getgid?.()
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const graceMs = deps.graceMs ?? DEFAULT_COMPLETION_TIMEOUT_MS
  const completionSignals = deps.completionSignals ?? [DEFAULT_COMPLETION_SIGNAL]

  return {
    worktree: realWorktreePort(exec),

    async createSandbox({ env: untrustedEnv, worktreePath, skillBundle, runner: untrustedRunner }) {
      // 公共 port 自身也是 Docker 创建边界：不能假设调用方必经 SDK/lifecycle。先校验 runner，再按
      // 同一纯函数剔除对侧凭证；两步都早于 git mount 探测和任何 docker 调用。
      const runner = assertLoopRunner(untrustedRunner ?? 'codex')
      // In-sandbox `tenon` records attribute to the host user who runs the loop, not the sandbox git identity.
      const hostUser = (deps.hostUser ?? (() => resolveTenonUser(hostRepoDir, process.env)))()
      const env: Record<string, string> = {
        ...filterRunnerEnvironment(runner, untrustedEnv),
        ...(isTenonUser(hostUser) ? { TENON_USER: hostUser.id, TENON_USER_NAME: hostUser.name } : {}),
      }
      // git 双挂载：worktree 的 .git 是 gitdir: 指针 → 需父 .git 目录在同一绝对路径可解析。
      const gitMounts = await resolveGitMounts(join(worktreePath, '.git')).catch(() => [])
      // 沙箱内工具（tenon-afk-run 的 git commit / tenon get）要看得见 worktree 的**工作文件**，
      // 故挂 worktree 目录本身（host==sandbox）；它已含 .git 指针文件，故丢掉 resolveGitMounts 里那条
      // 冗余的 .git 文件挂载，只保留父 .git 目录挂载（gitdir: 绝对路径经它解析）。
      const dotGit = join(worktreePath, '.git')
      const parentGitMounts = gitMounts.filter((m) => m.hostPath !== dotGit)
      // v5 T22 codex 凭证目录：过滤后的 env 仅在 runner=codex 时可能含 CODEX_HOME → 把该 host
      // 目录按同一绝对路径挂进容器——env var 单独进容器只是
      // 悬空路径，挂载才让沙箱内 codex 真读到 auth.json（设置必须真实起效）。docker -v 只收绝对
      // 路径，相对值不挂——容器内 codex 找不到凭证自会报认证错误，经既有 stderr 通道落账（诚实
      // 分流，不在 host 侧预判吞错）。
      const codexHome = env.CODEX_HOME
      const codexHomeMounts =
        codexHome !== undefined && codexHome.startsWith('/')
          ? [{ hostPath: codexHome, sandboxPath: codexHome }]
          : []
      // H10 r5：skillBundle 缺席时维持原容器创建路径；存在时先在 host 侧核验，随后起一个完全没有
      // host CAS bind mount 的容器，再用 docker cp 把字节复制进容器 writable layer 的固定私有目录，
      // 最后以 root 封存。host 在 cp 期间制造的不一致由入口 digest 闸拒绝；cp 完成后的 host 修改则
      // 因为已经没有共享挂载路径而无法影响 agent。
      let hostCasDir: string | undefined
      if (skillBundle) {
        hostCasDir = join(hostRepoDir, skillBundle.casRelativePath)
        await verifySkillBundleSnapshot(hostCasDir, skillBundle)
      }
      const mounts: ContainerMount[] = [
        { hostPath: worktreePath, sandboxPath: worktreePath },
        ...parentGitMounts,
        ...codexHomeMounts,
      ]
      const sandbox = await createDockerSandbox(exec, {
        image, worktreePath, env, gitMounts: mounts, uid, gid, cpus: deps.cpus,
        // Codex-first：0.144.1 workspace-write 在 Docker 内依赖 bwrap namespace；只给 codex
        // 外层容器所需能力，模型发起的工具仍由 workspace-write 限在私有 agent clone。
        codexWorkspaceSandbox: runner === 'codex',
      })
      if (hostCasDir === undefined) return sandbox
      try {
        await copyAndSealDirectoryInContainer(exec, sandbox.containerName, hostCasDir, SKILL_BUNDLE_CONTAINER_DIR)
        return sandbox
      } catch (error) {
        await sandbox.close()
        const detail = error instanceof Error ? error.message : String(error)
        throw new SkillBundleSnapshotMismatchError(
          `skill bundle 复制或 root seal 失败（容器已关闭，agent 未启动）：${detail}`,
        )
      }
    },

    async runWork(sandboxExec, name, signal, runner) {
      // v5 T20：runner 分派在命令构造点完成——'codex' → TENON_RUNNER=codex 前缀，沙箱脚本
      // （tools/sandcastle/tenon-afk-run.sh）据此起 codex exec 无头会话；CLI 缺失时脚本打
      // 清晰错误并非零退出，经下方 exitCode!==0 throw 流进 scheduler 写 automation_last_error。
      const cmd = buildAfkRunCommand(name, runner, deps.imageExpectation)
      // afk-workbench Task 2 teardown 修复：落盘位置是 host 侧 openspec/changes/<name>/，不是
      // worktree 内——那个目录只随 change 本身存在（.pipeline.yaml/.pipeline-history.jsonl 的
      // 落地目录），从不随某次 run 的 worktree 一起被 runChangeInSandbox 的 finally 块 teardown。
      // hostRepoDir 是 createLifecyclePorts 的工厂级闭包依赖，name 每次调用都传，两者拼出的
      // changeDir 和真 kernel StateStore 存 automation_sandbox/automation_worktree 的
      // .pipeline.yaml 是同一个目录（同 sdk.ts::storeWriter / dockerRunChange.ts 的
      // join(hostRepoDir, 'openspec', 'changes', name) 约定，不分叉出第二份路径拼接逻辑）。
      const changeDir = join(hostRepoDir, 'openspec', 'changes', name)
      const logPath = join(changeDir, '.sandcastle-run.log')
      // best-effort（同 setStateField/worktree.remove 既有 .catch(() => {}) 风格）：磁盘异常不
      // 掩盖真正的结算结果/错误。mkdir recursive 幂等——changeDir 正常应已因 change init 存在，
      // 这里只是防御。
      const persistLog = async (content: string): Promise<void> => {
        await mkdir(changeDir, { recursive: true }).catch(() => {})
        await writeFile(logPath, content, 'utf8').catch(() => {})
      }

      // afk-workbench Task 2：结算（成功/失败）落盘完整 stdout+stderr（不是 automation_last_error
      // 里那 200 字符截断片段）。invokeWithRace 有两种质地不同的"结算"：resolve（含 exitCode!==0
      // 的沙箱内命令真失败，此时有完整 res 可读）和 reject（idle-timeout/abort/sandboxExec 自己
      // 抛错——invokeWithRace 直接 reject，压根没有 res）。若只在 resolve 之后才读 res.stdout 落盘，
      // reject 这条路径的日志会整个丢失——BoundedTail 的生命周期得提到 invokeWithRace 外面自己用
      // onLine 攒一份兜底尾部，catch 分支才拿得到东西（64KiB 上限，复用现成 BoundedTail，不新造
      // 一套累积机制）。
      const fallbackTail = new BoundedTail(MAX_TAIL_CHARS, '\n')

      let res: ExecResult
      try {
        // 三路 race：沙箱内 tenon-afk-run 跑 build→verify→ship，idle/grace/abort 收口。
        res = await invokeWithRace(
          (onLine) =>
            sandboxExec(cmd, {
              onLine: (line) => {
                fallbackTail.push(line)
                onLine(line)
              },
            }),
          { idleMs, graceMs, completionSignals, signal },
        )
      } catch (err) {
        // reject 路径唯一能拿到的内容：onLine 逐行攒的尾部（T4 评审修复后 exec.ts 的 onLine
        // 双流都续传，stdout/stderr 行在此按到达序交错——比早先「stderr 拿不到」更全，但仍是
        // 尾部而非全量，不伪造）。
        await persistLog(fallbackTail.toString())
        throw err
      }

      // resolve 路径：res.stdout/res.stderr 已经是权威全量（真 sandboxExec 走 exec.ts 自己的
      // 64KiB BoundedTail），直接落盘，不再从 fallbackTail 拼凑。
      const fullLog = [res.stdout, res.stderr].filter((s) => s.length > 0).join('\n')
      await persistLog(fullLog)

      // H10 r1 复审阻断5（任务C1）：容器内 tenon-afk-run.sh 在起 agent 前重算 skill bundle 聚合
      // digest，与 TENON_SKILL_BUNDLE_SHA256 不一致时以 container.ts::
      // SKILL_BUNDLE_VERIFY_FAIL_EXIT_CODE 退出（此时脚本从未到达任何 agent 分派分支，agent 从未
      // 启动）。必须先于下方通用非零退出分支识别——抛与 host 侧 verifySkillBundleSnapshot 同一个
      // SkillBundleSnapshotMismatchError（同一 `_tag`），令 classify.ts 既有的 tag 分类（H10 任务
      // B1 已接线）自动把这条运行期路径也判成 cause:'skill-bundle-snapshot-corrupt'——
      // kind:'conflict'（绝不重试，也绝不会走到 runChangeInSandbox 后续的 mergeToBase）+
      // scheduler.ts::settlementFor 据此 charge:'none'（agent 从未启动，不按 reserved-estimate
      // 收费）。缺 skill bundle 绑定的 run（TENON_SKILL_BUNDLE_DIR 未注入）在脚本内直接跳过
      // 校验整段，exitCode 不可能等于本保留码，这条分支对它们零影响。
      if (res.exitCode === SKILL_BUNDLE_VERIFY_FAIL_EXIT_CODE) {
        throw new SkillBundleSnapshotMismatchError(
          `容器内 skill bundle 校验失败（agent 从未启动，exit ${SKILL_BUNDLE_VERIFY_FAIL_EXIT_CODE}）：${(res.stderr || res.stdout).slice(0, 300)}`,
        )
      }
      if (res.exitCode !== 0) {
        throw new Error(`tenon afk-run failed (exit ${res.exitCode}): ${res.stderr.slice(0, 200)}`)
      }
      return parseSandboxReport(res.stdout) // 非零/畸形握手真抛错，绝不伪造 pass
    },

    collectCommits: (input) =>
      collectCommitsReal(exec, { hostRepoDir, branch: input.branch, base: input.base }),

    // T4 决议 #12：denylist 结算检查的数据源（同 collectCommits 从 hostRepoDir 读不可变命名 ref）。
    diffNames: (input) =>
      diffNamesReal(exec, { hostRepoDir, branch: input.branch, base: input.base }),

    mergeToBase: (input) =>
      mergeBackToBase(exec, {
        hostRepoDir, worktreePath: input.worktreePath, branch: input.branch, base: input.base,
        expectedBaseSha: input.expectedBaseSha, expectedBranchSha: input.expectedBranchSha,
        onIntent: input.onIntent, onLanded: input.onLanded,
      }),

    git: realGitFace(exec, hostRepoDir),

    setStateField: deps.setStateField ?? (async () => {}),

    verifier: deps.verifier ?? createDefaultVerifierPort(),
    verifierExpectedIssuerIdentity: deps.verifierExpectedIssuerIdentity,
  }
}
