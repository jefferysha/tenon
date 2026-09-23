/**
 * session 子命令 —— activate（激活当前 change）+ route-context（related_files 按包路由）。
 * 老仓真相源：skills/pipeline/scripts/state-session.sh（语义盘点 + [PLACEHOLDER] 占位见
 * kernel/src/state/session.ts 顶注含老仓行号）。
 *   activate <change>            绑定本 session 活跃指针（degraded 不报错），无 stdout；[OK]/WARN 走 stderr
 *   route-context <change> [--json]  把 related_files 按声明 package path 路由到归属包，分组走 stdout
 * stdout/exit 对齐老仓：数据（route-context header/分组/JSON）走 stdout（老仓 echo/python print）；
 * 状态与错误（activate [OK]/WARN、ERROR）走 stderr（老仓 red/green/yellow 均 >&2，state-lib.sh:5-7）。
 * exit：错误/非法/缺状态 = 1；成功 = 0；activate 指针写失败 = degraded-safe rc=0（绝不 exit 1）。
 *
 * 与老仓的差异（诚实标注，GOAL C 精神——不臆造实现）：
 *   · activate 的持久化端在老仓委托 session_store.py（R20 per-session context-keyed 指针，解析
 *     CC session id / Cursor ticket / single-session fallback）；该 context_key 解析子系统本仓没有。
 *     本仓 activate 的真实副作用是「当前用户的活跃任务指针」`.tenon/users/<slug>/local/active-change`：
 *     指针按声明身份隔离而非 session 粒度——同一用户的并发 session 共享一个指针，不同用户互不覆盖。
 *     Hook 只把它作为「用户明确继续/点名 change」时的恢复候选，绝不自动把它注入新会话。
 *     换粒度的接缝是 SessionFs.bindPointer（注入面已就位，见下方 SessionFs）。可选的
 *     `--host-session <id>` 另写一个严格 session→Change 的非 canonical 会话投影；正常对话
 *     明确要求恢复时，Hook 优先使用它解析当前 Change，dashboard 也用它识别终端活动。它绝不参与
 *     canonical guard 或状态转换。
 *   · 老仓 route-context 的「python3/monorepo.py 不可达」降级分支在 TS 侧不适用（无子进程依赖）；
 *     等价降级 = .pipeline-project.yaml 缺失/解析失败 → 视为单仓（packages=null，全未归属），fail-open。
 *   · 老仓 state-session.sh:238-253 三项 [PLACEHOLDER]（package-validation / Cursor ticket 写端 /
 *     init-context-deprecation）是老仓自己都未实现的空占位——本仓同样没有（见 kernel 顶注）。
 */
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseProjectPackages,
  relatedFilesFromField,
  renderRouteContextText,
  routeBucketsToObject,
  routeContext,
  ensureOpenspecGitignore,
  ensurePipelineGitignore,
  TERMINAL_SESSION_BINDINGS_DIR,
  TERMINAL_SESSION_PROTOCOL,
  validateChangeName,
  isTerminalSessionId,
  readCurrentRunRevision,
  readInteractionProjection,
  interactionStateHashEquals,
  INTERACTION_PROJECTION_WRITE_FAILED,
  actorOf, ensureUserLocalDir, writeActiveChange,
  type PackageDecl, type RecordActor,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir } from '../paths.js'
import { createInteractionCapture } from '../interaction-emitter.js'
import { INTERACTION_AUTHORITY_PROTOCOL } from '../continuousAuthority.js'
import { requireUser } from '../userIdentity.js'

export { INTERACTION_AUTHORITY_PROTOCOL } from '../continuousAuthority.js'

/** 项目根 package 声明文件（老仓 monorepo.py PROJECT_CONFIG_FILE）。 */
export const PROJECT_CONFIG_FILE = '.pipeline-project.yaml'

/** Keep resume timestamps measurable while closing a wall-clock rollback gap. */
export function resumeOccurredAt(candidate: string, latestEffectAt: string): string {
  const candidateMs = Date.parse(candidate)
  const effectMs = Date.parse(latestEffectAt)
  if (!Number.isFinite(candidateMs) || !Number.isFinite(effectMs)) return candidate
  if (candidateMs <= effectMs) return new Date(effectMs + 1).toISOString()
  return candidate
}

/**
 * session fs 注入面（默认真 fs；mock 层注入 fake，见 session.test.ts）。
 *   loadPackages: 读项目根 .pipeline-project.yaml → package 声明（缺失/解析失败 → null 单仓，fail-open）。
 *   bindPointer:  写当前用户的恢复候选（.tenon/users/<slug>/local/active-change），并删除退役的仓库级指针文件。
 */
export interface SessionFs {
  loadPackages: (cwd: string) => Promise<PackageDecl[] | null>
  bindPointer: (cwd: string, slug: string, name: string) => Promise<void>
  /** Optional for legacy injected test/degraded adapters; missing means --continuous is safely unavailable. */
  writeInteractionAuthority?: (cwd: string, slug: string, name: string, sessionId: string, actor: RecordActor) => Promise<void>
  /** Optional host-session identity for exact resume routing and terminal liveness. It never mutates workflow state. */
  bindTerminalSession?: (cwd: string, name: string, sessionId: string) => Promise<void>
}

function authorityTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('目标不是普通文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/** Create only ordinary directories for the hook-facing, non-canonical session projection. */
async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('目录不是普通目录')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await mkdir(path, { recursive: false, mode: 0o700 })
  } catch (error) {
    // Another terminal in the same project may create this projection directory between lstat and
    // mkdir.  Treat only that benign race as success; the lstat below still rejects links/files.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const created = await lstat(path)
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('目录不是普通目录')
}

/**
 * Bind a native host session to the exact Change selected by the pipeline root skill.  This is an
 * non-canonical session identity projection: it prevents a per-user `active-change` pointer
 * from routing or displaying an unrelated conversation as an old Change.
 */
async function writeTerminalSessionBinding(cwd: string, name: string, sessionId: string): Promise<void> {
  if (!isTerminalSessionId(sessionId)) throw new Error('host session id 格式非法')
  const pipelineDir = join(cwd, '.pipeline')
  const sessionsDir = join(cwd, TERMINAL_SESSION_BINDINGS_DIR)
  await ensurePipelineGitignore(cwd)
  // A binding is what lets the host hook write the Change's heartbeat sidecar; keep that file out of git.
  await ensureOpenspecGitignore(cwd)
  await ensurePlainDirectory(pipelineDir)
  await ensurePlainDirectory(sessionsDir)
  const target = join(sessionsDir, `${sessionId}.json`)
  await assertRegularOrMissing(target)
  const timestamp = authorityTimestamp()
  const body = `${JSON.stringify({
    protocol: TERMINAL_SESSION_PROTOCOL,
    session_id: sessionId,
    change: name,
    bound_at: timestamp,
  })}\n`
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await assertRegularOrMissing(target)
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function writeAuthorityProjection(cwd: string, slug: string, name: string, sessionId: string, actor: RecordActor): Promise<void> {
  if (!isTerminalSessionId(sessionId)) throw new Error('host session id 格式非法')
  const target = (await ensureUserLocalDir(cwd, slug)).authority
  const timestamp = authorityTimestamp()
  const body = [
    INTERACTION_AUTHORITY_PROTOCOL,
    `change=${name}`,
    `host_session=${sessionId}`,
    'scope=interactive-skills',
    'review=delegated',
    `issued_at=${timestamp}`,
    '',
  ].join('\n')
  await assertRegularOrMissing(target)
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await assertRegularOrMissing(target)
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
  const history = join(cwd, 'openspec', 'changes', name, '.pipeline-history.jsonl')
  await assertRegularOrMissing(history)
  await appendFile(
    history,
    `${JSON.stringify({ ts: timestamp, kind: 'prompt',
      raw: `interaction-authority:enabled scope=interactive-skills review=delegated host_session=${sessionId}`, actor })}\n`,
    'utf8',
  )
}

const REAL_FS: SessionFs = {
  loadPackages: async (cwd) => {
    let text: string
    try {
      text = await readFile(join(cwd, PROJECT_CONFIG_FILE), 'utf8')
    } catch {
      return null // 缺 .pipeline-project.yaml → 单仓（老仓 _load_config fail-open → {} → get_packages None）
    }
    try {
      return parseProjectPackages(text)
    } catch {
      return null
    }
  },
  bindPointer: async (cwd, slug, name) => {
    await writeActiveChange(cwd, slug, name)
    // One-step migration: the retired repository-wide selection files are removed, never read.
    for (const retired of ['.pipeline-active', '.pipeline-interaction-authority']) {
      if ((await lstat(join(cwd, retired)).catch(() => null))?.isFile() === true) await rm(join(cwd, retired), { force: true })
    }
  },
  writeInteractionAuthority: writeAuthorityProjection,
  bindTerminalSession: writeTerminalSessionBinding,
}

/** change 名校验（老仓 validate_change_name）：非法/空 → stderr ERROR + false。 */
function checkName(deps: CliDeps, name: string | undefined): name is string {
  const v = validateChangeName(name)
  if (v.ok) return true
  deps.io.err(v.error)
  return false
}

/** ensure_state_exists：canonical current 与 legacy YAML 都读不到 → stderr 两行 ERROR + null。 */
async function ensureState(deps: CliDeps, name: string): Promise<string | null> {
  const dir = changeDir(deps.cwd, name)
  try {
    await deps.store.read(dir)
    return dir
  } catch {
    deps.io.err(`ERROR: 状态文件不存在: openspec/changes/${name}/.pipeline-run/current.json（或未迁移 .pipeline.yaml）`)
    deps.io.err(`  先执行: tenon init ${name} --track <track> --preset <preset>`)
    return null
  }
}

/**
 * activate（老仓 cmd_activate state-session.sh:28-45）：validate 名 + ensure 状态存在 → 写恢复候选指针。
 * degraded-safe：指针写失败仅 WARN、rc=0（绝不 exit 1），绝不动 phase/phase_status/assignee。
 */
interface ActivateOptions {
  continuous: boolean
  hostSessionId?: string
}

function parseActivateOptions(flags: string[]): ActivateOptions | null {
  let continuous = false
  let hostSessionId: string | undefined
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === '--continuous') {
      if (continuous) return null
      continuous = true
      continue
    }
    if (flag === '--host-session') {
      const value = flags[index + 1]
      if (hostSessionId !== undefined || value === undefined || !isTerminalSessionId(value)) return null
      hostSessionId = value
      index += 1
      continue
    }
    return null
  }
  return { continuous, ...(hostSessionId === undefined ? {} : { hostSessionId }) }
}

async function cmdActivate(deps: CliDeps, args: string[], fs: SessionFs): Promise<number> {
  const [name, ...flags] = args
  const options = parseActivateOptions(flags)
  if (options === null) {
    deps.io.err('ERROR: session activate 用法: tenon session activate <change> [--continuous] [--host-session <session-id>]')
    return 1
  }
  if (!checkName(deps, name)) return 1
  if ((await ensureState(deps, name)) === null) return 1
  const user = requireUser(deps)
  if (user === null) return 1
  try {
    await fs.bindPointer(deps.cwd, user.slug, name)
  } catch (e) {
    // 老仓语义：session_store degraded（context_key 缺/落盘失败）→ 仅 WARN、回退对话上下文、rc=0。
    deps.io.err(`[activate] 活跃指针写入失败 → degraded（回退对话上下文），未落 session 指针: ${errMsg(e)}`)
    return 0
  }
  if (deps.interaction !== undefined) {
    try {
      const interaction = deps.interaction
      await deps.store.withLock(changeDir(deps.cwd, name), async () => {
        const state = await deps.store.read(changeDir(deps.cwd, name))
        const revision = await readCurrentRunRevision(changeDir(deps.cwd, name))
        const projection = await readInteractionProjection(changeDir(deps.cwd, name))
        if (revision === undefined || projection.kind !== 'valid') return
        const effect = [...projection.events].reverse().find((event) =>
          event.event === 'review.effect-applied' && event.result === 'success')
        if (effect === undefined) return
        const valid = interactionStateHashEquals(revision.stateDigest, effect.stateAfterHash)
        const capture = createInteractionCapture(interaction, deps.clock)
        await capture.recordResume({
          changeDir: changeDir(deps.cwd, name),
          changeName: name,
          state,
          revision,
          effectRevision: revision,
          result: valid ? 'success' : 'rejected',
          journeyId: effect.journeyId,
          originStepVisit: effect.originStepVisit,
          clock: resumeOccurredAt(deps.clock(), effect.occurredAt),
        })
      })
    } catch (error) {
      deps.io.err(`[activate] ${INTERACTION_PROJECTION_WRITE_FAILED} interaction projection 写入失败（Change 绑定仍成功）: ${errMsg(error)}`)
    }
  }
  let terminalSessionBound = false
  if (options.hostSessionId !== undefined) {
    if (fs.bindTerminalSession === undefined) {
      deps.io.err('[activate] 终端会话绑定未写入 → degraded（当前 fs adapter 不支持 --host-session；不影响 Change 绑定或流程状态）')
    } else {
      try {
        await fs.bindTerminalSession(deps.cwd, name, options.hostSessionId)
        terminalSessionBound = true
      } catch (e) {
        deps.io.err(`[activate] 终端会话绑定未写入 → degraded（dashboard 将把该会话显示为等待）：${errMsg(e)}`)
      }
    }
  }
  if (options.continuous) {
    if (options.hostSessionId === undefined) {
      deps.io.err('[activate] 持续交互授权未写入 → degraded（缺少 --host-session，授权不得跨宿主会话复用）')
      return 0
    }
    if (!terminalSessionBound) {
      deps.io.err('[activate] 持续交互授权未写入 → degraded（精确 host session 绑定未获证明）')
      return 0
    }
    if (fs.writeInteractionAuthority === undefined) {
      deps.io.err('[activate] 持续交互授权未写入 → degraded（当前 fs adapter 不支持 --continuous；普通 confirmation/review 门不受影响）')
      return 0
    }
    try {
      await fs.writeInteractionAuthority(deps.cwd, user.slug, name, options.hostSessionId, actorOf(user))
    } catch (e) {
      deps.io.err(`[activate] 持续交互授权未写入 → degraded（仍已绑定 Change，interaction skill 将按常规提问）：${errMsg(e)}`)
      return 0
    }
    deps.io.err(`[OK] activate ${name}（已写当前用户的活跃任务与 Change 绑定的持续交互授权；review 仍须产生证据，并仅可用 --delegated 留下审计回执）`)
    return 0
  }
  const terminalStatus = options.hostSessionId === undefined
    ? ''
    : '；已绑定 host session 供 dashboard 识别短时运行心跳'
  deps.io.err(`[OK] activate ${name}（已写当前用户的活跃任务恢复候选；该指针按用户隔离、非 per-session——仅用户明确继续/点名时会被 Hook 使用；phase/phase_status 未改动${terminalStatus}）`)
  return 0
}

/**
 * route-context（老仓 cmd_route_context state-session.sh:192-236）：读 related_files → 按声明 package
 * path 路由到归属包。单仓（无 packages 声明）全落未归属桶；--json 透传 {package:[paths]}（null 桶键→"null"）。
 */
async function cmdRouteContext(deps: CliDeps, args: string[], fs: SessionFs): Promise<number> {
  const name = args[0]
  const json = args.includes('--json')
  if (!checkName(deps, name)) return 1
  const dir = await ensureState(deps, name)
  if (dir === null) return 1
  let related: string[]
  try {
    const state = await deps.store.read(dir)
    related = relatedFilesFromField(state.fields.related_files)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const packages = await fs.loadPackages(deps.cwd)
  const obj = routeBucketsToObject(routeContext(related, packages))
  if (json) {
    deps.io.out(JSON.stringify(obj))
    return 0
  }
  for (const line of renderRouteContextText(name, obj)) deps.io.out(line)
  return 0
}

/**
 * session 子命令分派（纯函数 + deps 注入，风格同 task.ts/fields.ts）。
 * fs 缺省真 fs（integration 走真路径）；mock 层注入 fake SessionFs 快速回归。
 */
export async function cmdSession(
  deps: CliDeps,
  sub: string,
  args: string[],
  fs: SessionFs = REAL_FS,
): Promise<number> {
  switch (sub) {
    case 'activate':
      return cmdActivate(deps, args, fs)
    case 'route-context':
      return cmdRouteContext(deps, args, fs)
    default:
      deps.io.err(`ERROR: 未知 session 子命令: ${sub}（支持: activate route-context）`)
      return 1
  }
}
