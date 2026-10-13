/**
 * 步骤检查点：一次步骤访问开始时的工作区状态，离开时与之比较得到本步产出（设计 §3）。
 * 只用 git 读：HEAD + 相对 HEAD 有改动的文件（含未跟踪、不含被忽略）。`--no-optional-locks` 不刷新索引，
 * 不与用户同时进行的 git 操作抢锁。读不出来一律 unavailable / truncated，由调用方降级，从不抛给转换。
 *
 * 这是 documents/step-outputs.ts 的内部接缝，不从 kernel 公共出口导出；测试用临时 git 仓库，不用替身。
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const MAX_BUFFER = 64 * 1024 * 1024
const HASH_BATCH = 32
export const CHECKPOINT_PATH_LIMIT = 20_000
/** 账本只收这么长以内的路径；超长的路径不观察，免得它把整份账本写不进去。 */
export const OBSERVED_PATH_MAX_LENGTH = 1024
const HIDDEN_ROOTS: ReadonlySet<string> = new Set(['.git', '.tenon', '.claude', '.agents', '.codex', '.superpowers', '.worktrees', '.turbo'])
/** 换行等控制字符会破坏 git 的逐行接口；U+FFFD 说明文件名不是合法 UTF-8，解码后已经找不回原文件。 */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f�]/u
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** 检查点里的 HEAD 会被当作 git 参数，只认完整的提交号（SHA-1 或 SHA-256 仓库）。 */
export function isCommitId(value: string): boolean {
  return COMMIT_ID.test(value)
}

export interface StepCheckpoint {
  /** 访问开始时的 HEAD；仓库还没有提交时为 null。 */
  readonly head: string | null
  /** 相对 HEAD 有改动（含未跟踪、不含被忽略）的观察路径 → 当前内容 sha256，已删除为 null。 */
  readonly files: Readonly<Record<string, string | null>>
}
export type CheckpointCapture =
  | { readonly kind: 'captured'; readonly checkpoint: StepCheckpoint }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'truncated' }
export type FileChangeKind = 'added' | 'modified' | 'deleted'
export interface FileChange { readonly path: string; readonly change: FileChangeKind; readonly sha256: string | null }
export type CheckpointComparison =
  | { readonly kind: 'observed'; readonly changes: readonly FileChange[]; readonly current: StepCheckpoint }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'truncated' }
export interface CheckpointOptions {
  /** @internal 测试缝：替换 git 子进程。 */
  readonly runGit?: (args: readonly string[], cwd: string, input?: string) => Promise<string>
  /** 改动路径上限，默认 CHECKPOINT_PATH_LIMIT。 */
  readonly pathLimit?: number
}

type RunGit = NonNullable<CheckpointOptions['runGit']>

/** 不观察：Tenon 状态、宿主集成目录、依赖、其他任务目录、本任务目录下直接的点文件。 */
export function isObservedPath(path: string, change: string): boolean {
  if (path.length > OBSERVED_PATH_MAX_LENGTH || UNSAFE_PATH_CHARS.test(path)) return false
  const segments = path.split('/')
  if (segments.some((segment) => segment.startsWith('.pipeline') || segment === 'node_modules')) return false
  if (HIDDEN_ROOTS.has(segments[0] ?? '')) return false
  if (path.startsWith('.github/hooks/') || path === 'openspec/.gitignore') return false
  if (segments[0] === 'openspec' && segments[1] === 'changes') {
    if (segments[2] !== change) return false
    if (segments.length === 4 && (segments[3] ?? '').startsWith('.')) return false
  }
  return true
}

/** 无输入走 execFile；有输入（cat-file --batch）走 spawn，按 latin1 读回以保证二进制安全。 */
const defaultRunGit: RunGit = async (args, cwd, input) => {
  if (input === undefined) {
    return (await exec('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' })).stdout
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(chunks).toString('latin1'))
      else reject(new Error(`git ${args[0] ?? ''} exited ${String(code)}`))
    })
    child.stdin.end(input)
  })
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '')
}

function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 文件当前内容摘要：普通文件流式 sha256；符号链接按链接目标字符串（不跟随，也与 git 为链接存的 blob 内容一致，
 * 提交前后摘要不变）；不存在为 null；目录项（子模块）、特殊文件与读不了的文件返回 undefined = 不观察。
 */
export async function workingFileSha(root: string, path: string): Promise<string | null | undefined> {
  const absolute = join(root, path)
  try {
    const entry = await lstat(absolute)
    if (entry.isSymbolicLink()) return sha256Of(await readlink(absolute))
    if (!entry.isFile()) return undefined
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) return undefined
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      return hash.digest('hex')
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ELOOP' ? null : undefined
  }
}

/** 批量取摘要：每批 HASH_BATCH 个并行，几千个文件也不会同时打开同样多的文件句柄。 */
export async function workingFileShas(root: string, paths: readonly string[]): Promise<(string | null | undefined)[]> {
  const shas: (string | null | undefined)[] = []
  for (let index = 0; index < paths.length; index += HASH_BATCH) {
    shas.push(...await Promise.all(paths.slice(index, index + HASH_BATCH).map((path) => workingFileSha(root, path))))
  }
  return shas
}

async function readHead(runGit: RunGit, root: string): Promise<string | null> {
  try {
    const head = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root)).trim()
    return head === '' ? null : head
  } catch (error) {
    if (errorCode(error) === 1) return null // 还没有提交：--verify -q 静默以 1 退出
    throw error
  }
}

async function captureOrThrow(root: string, change: string, runGit: RunGit, limit: number): Promise<CheckpointCapture> {
  const [inside, prefix = ''] = (await runGit(['rev-parse', '--is-inside-work-tree', '--show-prefix'], root)).split('\n')
  if (inside?.trim() !== 'true') return { kind: 'unavailable', reason: '当前目录不是 git 工作区' }
  // status 的路径永远相对仓库根；项目根嵌在子目录里时路径与项目根对不上，宁可不观察。
  if (prefix.trim() !== '') return { kind: 'unavailable', reason: '项目根不是 git 工作区的根目录' }
  const head = await readHead(runGit, root)
  // fsmonitor 是仓库配置里的外部命令（或会拉起后台守护进程）；观察只读，不执行也不启动它。
  const status = await runGit(['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], root)
  // 每条是「XY 路径」；--no-renames 下没有第二个路径字段。
  const paths = [...new Set(nulList(status).filter((entry) => entry.length > 3).map((entry) => entry.slice(3)).filter((path) => isObservedPath(path, change)))].sort()
  if (paths.length > limit) return { kind: 'truncated' }
  const shas = await workingFileShas(root, paths)
  const files: [string, string | null][] = []
  paths.forEach((path, index) => {
    const sha = shas[index]
    if (sha !== undefined) files.push([path, sha])
  })
  return { kind: 'captured', checkpoint: { head, files: Object.fromEntries(files) } }
}

export async function captureCheckpoint(root: string, change: string, options: CheckpointOptions = {}): Promise<CheckpointCapture> {
  try {
    return await captureOrThrow(root, change, options.runGit ?? defaultRunGit, options.pathLimit ?? CHECKPOINT_PATH_LIMIT)
  } catch (error) {
    return errorCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? { kind: 'truncated' }
      : { kind: 'unavailable', reason: describeError(error) }
  }
}

/** 上游引用：别人合并进来的提交要从「本任务的提交」里排除。当前分支自己的远端同名分支不算上游。 */
async function upstreamRefs(runGit: RunGit, root: string): Promise<string[]> {
  const attempt = async (args: readonly string[]): Promise<string | null> => {
    try { return (await runGit(args, root)).trim() } catch { return null }
  }
  const refs: string[] = []
  if (await attempt(['rev-parse', '--verify', '-q', 'refs/remotes/origin/HEAD']) !== null) refs.push('refs/remotes/origin/HEAD')
  const tracked = await attempt(['rev-parse', '--symbolic-full-name', '@{upstream}'])
  if (tracked?.startsWith('refs/') === true) {
    const trackedBranch = tracked.replace(/^refs\/remotes\/[^/]+\//u, '').replace(/^refs\/heads\//u, '')
    if (trackedBranch !== await attempt(['rev-parse', '--abbrev-ref', 'HEAD'])) refs.push(tracked)
  }
  return refs
}

/** HEAD 移动（提交、rebase、merge）带来的候选路径：只含本任务自己的提交。 */
async function movedPaths(runGit: RunGit, root: string, from: string | null, to: string | null): Promise<string[]> {
  if (from === to || to === null) return []
  if (from === null) return nulList(await runGit(['ls-tree', '-r', '--name-only', '-z', to], root))
  const upstream = await upstreamRefs(runGit, root)
  const range = ['log', '--format=', '--name-only', '-z', '--no-renames', `${from}..${to}`, ...(upstream.length > 0 ? ['--not', ...upstream] : []), '--']
  return nulList(await runGit(range, root))
}

/**
 * 某个提交里这些路径的内容摘要：缺失为 null，不是普通 blob（子模块、目录）为 undefined。
 * `git cat-file --batch` 逐条返回 `<oid> blob <size>\n<内容>\n` 或 `<name> missing\n`，按字节偏移顺序切开。
 */
async function blobShas(runGit: RunGit, root: string, rev: string | null, paths: readonly string[]): Promise<Map<string, string | null | undefined>> {
  const result = new Map<string, string | null | undefined>()
  if (rev === null || paths.length === 0) {
    for (const path of paths) result.set(path, null)
    return result
  }
  const output = await runGit(['cat-file', '--batch'], root, paths.map((path) => `${rev}:${path}\n`).join(''))
  let offset = 0
  for (const path of paths) {
    const lineEnd = output.indexOf('\n', offset)
    if (lineEnd < 0) throw new Error('git cat-file 输出不完整')
    const header = /^[0-9a-f]+ (\S+) (\d+)$/u.exec(output.slice(offset, lineEnd))
    offset = lineEnd + 1
    if (header === null) { result.set(path, null); continue } // missing / ambiguous：没有内容可跳过
    const size = Number(header[2])
    if (offset + size > output.length) throw new Error('git cat-file 输出不完整')
    result.set(path, header[1] === 'blob' ? sha256Of(Buffer.from(output.slice(offset, offset + size), 'latin1')) : undefined)
    offset += size + 1
  }
  return result
}

async function compareOrThrow(root: string, change: string, entry: StepCheckpoint, runGit: RunGit, limit: number, options: CheckpointOptions): Promise<CheckpointComparison> {
  if (entry.head !== null && !isCommitId(entry.head)) return { kind: 'unavailable', reason: '检查点里的 HEAD 不是提交号' }
  const now = await captureCheckpoint(root, change, options)
  if (now.kind !== 'captured') return now
  const current = now.checkpoint
  const before = new Map(Object.entries(entry.files))
  const after = new Map(Object.entries(current.files))
  const candidates = new Set([...before.keys(), ...after.keys(), ...await movedPaths(runGit, root, entry.head, current.head)])
  const observed = [...candidates].filter((path) => isObservedPath(path, change)).sort()
  if (observed.length > limit) return { kind: 'truncated' }
  const beforeBlobs = await blobShas(runGit, root, entry.head, observed.filter((path) => !before.has(path)))
  const afterBlobs = await blobShas(runGit, root, current.head, observed.filter((path) => !after.has(path)))
  const changes: FileChange[] = []
  for (const path of observed) {
    const was = before.has(path) ? before.get(path) : beforeBlobs.get(path)
    const is = after.has(path) ? after.get(path) : afterBlobs.get(path)
    if (was === undefined || is === undefined || was === is) continue
    changes.push({ path, change: was === null ? 'added' : is === null ? 'deleted' : 'modified', sha256: is })
  }
  return { kind: 'observed', changes, current }
}

/** 与进入时的检查点比较：新增 / 修改 / 删除，内容没变的不算。读不出来原样降级，不抛错。 */
export async function compareCheckpoint(root: string, change: string, entry: StepCheckpoint, options: CheckpointOptions = {}): Promise<CheckpointComparison> {
  try {
    return await compareOrThrow(root, change, entry, options.runGit ?? defaultRunGit, options.pathLimit ?? CHECKPOINT_PATH_LIMIT, options)
  } catch (error) {
    return errorCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? { kind: 'truncated' }
      : { kind: 'unavailable', reason: describeError(error) }
  }
}
