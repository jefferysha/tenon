/**
 * 需要人确认的测试配置改动（R1 / R3）：测试目录、共享基线、已知失败清单、项目工作流。
 * 这些文件是「什么算通过」的定义；agent 可以提议改，但改动出现在本任务 diff 里就必须由人在评审门确认，
 * 确认绑定文件内容的摘要（之后再变就要重新确认）。
 *
 * 纯函数只做分类、摘要比对与阻塞生成；读 diff 与读文件的 IO 在这里的 `readProtectedChanges` 与
 * kernel workspace/changed-files.ts。批准写在本机封存文件（seal.ts），不进 git。
 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathChangesSinceChangeStart, type ChangeStartInput, type ChangedFilesSession, type PathChange, type PathChangeStatus } from '../workspace/changed-files.js'
import { testBlocker, type TestBlocker } from './blockers.js'
import { isApproved, type TestSeal } from './seal.js'

export type ProtectedKind = 'catalog' | 'baseline' | 'known-failures' | 'workflow'

/** 测试目录在仓库里的相对路径（受保护文件）；评审批准「不适用」声明时 Tenon 自己会改写它。 */
export const PROTECTED_CATALOG_PATH = '.tenon/tests/catalog.yaml'

/** 传给 git 的 pathspec（目录 / 文件）；精确分类见 protectedKindOf。 */
export const PROTECTED_PATHSPECS: readonly string[] = [
  PROTECTED_CATALOG_PATH,
  '.tenon/tests/baselines',
  '.tenon/tests/known-failures.yaml',
  '.pipeline/workflows',
]

const MAX_PROTECTED_BYTES = 16 * 1024 * 1024
const WORKFLOW_FILE = /^\.pipeline\/workflows\/[^/]+\.ya?ml$/

export function protectedKindOf(path: string): ProtectedKind | undefined {
  if (path === PROTECTED_CATALOG_PATH) return 'catalog'
  if (path === '.tenon/tests/known-failures.yaml') return 'known-failures'
  if (path.startsWith('.tenon/tests/baselines/')) return 'baseline'
  return WORKFLOW_FILE.test(path) ? 'workflow' : undefined
}

export const DELETED_DIGEST = 'deleted'

export interface ProtectedChange {
  readonly path: string
  readonly kind: ProtectedKind
  readonly status: PathChangeStatus
  /** `sha256:<hex>`；文件已不存在记 `deleted`；读不了（超限、非普通文件）记 `unreadable`。 */
  readonly digest: string
}

async function digestOfFile(path: string): Promise<string> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_PROTECTED_BYTES) return 'unreadable'
    return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? DELETED_DIGEST : 'unreadable'
  }
}

/** 文件当前内容的摘要（与 ProtectedChange.digest 同口径）；共享受保护文件写出后封存用。 */
export function protectedFileDigest(repoRoot: string, path: string): Promise<string> {
  return digestOfFile(join(repoRoot, ...path.split('/')))
}

/**
 * `test:protected-approve` 审计行里的 `digests=` 值：逗号分隔的 `<路径>@<批准时内容摘要>`。
 * 批准本身绑定在本机封存里；审计行是提交进仓库的副本，CI 的 `tenon verify --ci` 据此核对「批准之后文件没再变」。
 * 在批准提交之后读当前内容（批准写入与审计行之间文件不会被命令改动）；读不出的路径不列。
 */
export async function protectedApprovalDigests(repoRoot: string, paths: readonly string[]): Promise<string | undefined> {
  const entries: string[] = []
  for (const path of paths) {
    const digest = await protectedFileDigest(repoRoot, path)
    if (digest !== 'unreadable') entries.push(`${path}@${digest}`)
  }
  return entries.length === 0 ? undefined : entries.join(',')
}

export async function readProtectedChanges(repoRoot: string, changes: readonly PathChange[]): Promise<readonly ProtectedChange[]> {
  const out: ProtectedChange[] = []
  for (const change of changes) {
    const kind = protectedKindOf(change.path)
    if (kind === undefined) continue
    const digest = await digestOfFile(join(repoRoot, ...change.path.split('/')))
    // 起点有、现在没有 = 删除；起点没有、现在也没有（新增又删掉）不算改动。
    if (digest === DELETED_DIGEST && change.status === 'added') continue
    out.push({ path: change.path, kind, status: digest === DELETED_DIGEST ? 'deleted' : change.status, digest })
  }
  return out
}

/** 本任务 diff 里的受保护改动（含删除）；读不出 diff 抛 ChangedFilesUnavailableError。 */
export async function protectedChangesSinceChangeStart(repoRoot: string, start: ChangeStartInput): Promise<readonly ProtectedChange[]> {
  return readProtectedChanges(repoRoot, await pathChangesSinceChangeStart(repoRoot, start, PROTECTED_PATHSPECS))
}

/** 同上，但走批量读取会话（一个项目的所有任务共用起点解析与 git 结果；dashboard 快照用它）。 */
export async function protectedChangesInSession(
  repoRoot: string,
  session: Pick<ChangedFilesSession, 'pathChanges'>,
  start: ChangeStartInput,
): Promise<readonly ProtectedChange[]> {
  return readProtectedChanges(repoRoot, await session.pathChanges(start, PROTECTED_PATHSPECS))
}

/** 由 Tenon 命令写出、进封存 `writes` 的共享文件（基线、已知失败清单）。 */
export function isSealedSharedFile(kind: ProtectedKind): boolean {
  return kind === 'baseline' || kind === 'known-failures'
}

export type ProtectedOrigin = 'approved' | 'pending' | 'outside-command'

/**
 * 这一项相对本机封存是什么来源：已批准 / 等人确认（Tenon 命令写出且内容没变，或目录、工作流这类人可编辑的配置）/
 * 台账外改动（封存里有该共享文件的写入记录，但当前内容已不同，即命令之后又被改动）。
 */
export function protectedOrigin(seal: TestSeal, change: string, item: ProtectedChange): ProtectedOrigin {
  if (isApproved(seal, change, item.path, item.digest)) return 'approved'
  if (!isSealedSharedFile(item.kind)) return 'pending'
  const written = seal.writes[item.path]
  if (written === undefined) return 'pending'
  return written.digest === item.digest ? 'pending' : 'outside-command'
}

const KIND_WORD: Readonly<Record<ProtectedKind, string>> = {
  catalog: '测试目录', baseline: '基线', 'known-failures': '已知失败清单', workflow: '项目工作流',
}
const STATUS_WORD: Readonly<Record<PathChangeStatus, string>> = { added: '新增', modified: '修改', deleted: '删除' }

export function protectedChangeLine(item: ProtectedChange): string {
  return `${KIND_WORD[item.kind]} ${item.path}（${STATUS_WORD[item.status]}，${item.digest}）`
}

/**
 * 受保护改动的阻塞：没有匹配摘要的人工批准就挡；不是 Tenon 命令写出的另给 `protected-file-tampered`，
 * 提示里点明「命令之后又被改动」。只在评审门步骤上判定（无门步骤没有人可批准）。
 */
export function protectedFileBlockers(input: {
  readonly change: string
  readonly changes: readonly ProtectedChange[]
  readonly seal: TestSeal
  readonly reviewFix: string
}): readonly TestBlocker[] {
  const out: TestBlocker[] = []
  for (const item of input.changes) {
    const origin = protectedOrigin(input.seal, input.change, item)
    if (origin === 'approved') continue
    if (origin === 'outside-command') {
      out.push(testBlocker('protected-file-tampered', `${protectedChangeLine(item)} 在 Tenon 命令写出之后又被改动（台账外改动）；需要你在评审里明确确认这个内容`, {
        fix: input.reviewFix, subject: item.path,
      }))
    } else {
      out.push(testBlocker('protected-file-unapproved', `${protectedChangeLine(item)} 出现在本任务的改动里，需要你在评审里确认`, {
        fix: input.reviewFix, subject: item.path,
      }))
    }
  }
  return out
}
