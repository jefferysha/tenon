/**
 * 已结束任务列表（M7）：`openspec/changes/archive/` 下的全部任务，每个只读一份摘要（名称、工作流、轨道、任务结果、
 * 结束时间、PR 链接、负责人），点开时才由单任务详情读完整内容。
 *
 * 归档目录的内容不再变化，所以摘要按「目录名 + 该目录 mtime」缓存：目录没动就不读文件，列表重建只剩一次
 * `readdir` 加每个目录一次 `lstat`。它因此也不进实时变更检测——快照指纹只带归档目录自己的签名（见
 * snapshotFingerprint.ts），任务移进来时项目重建一次，其余时候沿用缓存。列表按结束时间截断到 MAX_ENDED_TASKS，
 * 同时给出读得出来的总数。
 *
 * 读取是只读、有界、不跟随符号链接的：`openspec/`、`changes/`、`archive/`、每个任务目录和 `.pipeline-run/` 都必须是
 * 真目录，状态文件必须是不超过 MAX_STATE_BYTES 的普通文件。读不出来的目录被跳过，绝不让整个列表（更不让整个快照）失败。
 */
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fieldText, isPlainDirectory, ownerOf, parsePipeline, parseRunRevision, RUN_CURRENT_FILE, RUN_STATE_DIR, TASK_RESULTS,
  type PipelineState, type TaskResult,
} from '@tenon/kernel'
import { changeAreaSegments } from './changeArea.js'
import { mapWithConcurrency } from './concurrentMap.js'
import type { ChangeSnapshot } from './types.js'

export interface EndedTaskSummary {
  /** 任务名：归档目录名去掉日期前缀（同日同名的 `-2` 后缀保留，它们是不同的任务）。 */
  readonly name: string
  readonly workflow: string
  readonly track: string
  /** 旧归档没有任务结果字段，或字段取值不认识：`unknown`（界面按「完结」显示）。 */
  readonly result: TaskResult | 'unknown'
  /** 状态最后一次修订的时间；读不到时取目录名里的日期。 */
  readonly endedAt: string
  readonly prUrl?: string
  readonly owner?: string
  /** 仓库根相对路径，`/` 分隔：单任务详情接口认的就是它的最后一段。 */
  readonly archivedDir: string
}

/** 摘要按 `<目录名>\0<目录 mtime>` 缓存；`null` 记住「这个目录读不出任务」，避免每次重建都去重读。 */
export interface EndedTaskCache {
  readonly entries: Map<string, EndedTaskSummary | null>
}

export function createEndedTaskCache(): EndedTaskCache {
  return { entries: new Map() }
}

/**
 * 一个项目的快照里最多带多少个已结束任务（结束时间最新的优先）：列表随每次项目重建一起推给所有页面，不能无界。
 * 超过时快照同时带归档总数（`ProjectSnapshot.endedTotal`），界面据此说明「只显示最新的 N 个」，不静默丢。
 */
export const MAX_ENDED_TASKS = 1000
/** 一份状态文件的读取上限；真实的 current.json 只有几 KB。 */
const MAX_STATE_BYTES = 1024 * 1024
const MAX_PR_URL_LENGTH = 2048
const READ_CONCURRENCY = 16
const ARCHIVE_SEGMENTS = changeAreaSegments('archive')
const ARCHIVE_DIR = ARCHIVE_SEGMENTS.join('/')
/** 与 kernel 的任务名同一个字符集：归档目录名 = 日期前缀 + 任务名（同日同名再加 `-2`）。 */
const ARCHIVED_TASK_DIR = /^[a-zA-Z0-9_-]+$/u
const LEGACY_STATE_FILE = '.pipeline.yaml'
const DATED_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/u
const WEB_URL = /^https?:\/\/\S+$/u

interface TaskState {
  readonly fields: PipelineState['fields']
  /** 最后一次修订的时间；只有旧版 `.pipeline.yaml` 的归档没有。 */
  readonly revisedAt?: string
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/** 普通文件的文本；不存在返回 undefined，符号链接、非普通文件、超限一律抛出。 */
async function readRegularText(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error(`${path}: 不是普通文件或超过 ${MAX_STATE_BYTES} 字节`)
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0)
    if (bytesRead !== info.size) throw new Error(`${path}: 读取期间文件变了`)
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** 与 `stateStorageSourcePathSync` 同一个选择：有 current.json 就只认它（坏了也不退回 YAML），没有才看旧版 YAML。 */
async function readTaskState(dir: string): Promise<TaskState | null> {
  const runDir = join(dir, RUN_STATE_DIR)
  const runDirInfo = await lstat(runDir).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (runDirInfo !== undefined) {
    if (!runDirInfo.isDirectory()) return null
    const current = await readRegularText(join(runDir, RUN_CURRENT_FILE))
    if (current !== undefined) {
      const revision = parseRunRevision(current, join(runDir, RUN_CURRENT_FILE))
      return { fields: revision.state.fields, revisedAt: revision.mutation.observedAt }
    }
  }
  const legacy = await readRegularText(join(dir, LEGACY_STATE_FILE))
  return legacy === undefined ? null : { fields: parsePipeline(legacy).fields }
}

function parsableTime(value: string | undefined): string | undefined {
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined
}

function summarize(name: string, state: TaskState, fallbackEndedAt: string): EndedTaskSummary {
  const { fields } = state
  const dated = DATED_NAME.exec(name)
  const prUrl = fieldText(fields.pr_url)
  const owner = ownerOf(fields)?.name
  return {
    name: dated?.[2] ?? name,
    workflow: fieldText(fields.workflow) || 'default',
    track: fieldText(fields.track),
    result: TASK_RESULTS.find((known) => known === fields.task_result) ?? 'unknown',
    endedAt: parsableTime(state.revisedAt) ?? (dated?.[1] === undefined ? fallbackEndedAt : `${dated[1]}T00:00:00Z`),
    ...(prUrl.length <= MAX_PR_URL_LENGTH && WEB_URL.test(prUrl) ? { prUrl } : {}),
    ...(owner === undefined || owner === '' ? {} : { owner }),
    archivedDir: `${ARCHIVE_DIR}/${name}`,
  }
}

async function readSummary(dir: string, name: string, mtimeMs: bigint): Promise<EndedTaskSummary | null> {
  try {
    const state = await readTaskState(dir)
    return state === null ? null : summarize(name, state, new Date(Number(mtimeMs)).toISOString())
  } catch {
    // 损坏、超限、符号链接、不认识的状态版本：这个目录不是一个读得出来的任务。
    return null
  }
}

function newestFirst(left: EndedTaskSummary, right: EndedTaskSummary): number {
  const byTime = Date.parse(right.endedAt) - Date.parse(left.endedAt)
  if (byTime !== 0) return byTime
  return left.archivedDir < right.archivedDir ? 1 : left.archivedDir > right.archivedDir ? -1 : 0
}

/** `openspec/`、`changes/`、`archive/` 逐级都必须是真目录，否则不读（符号链接可以把整个 archive 指到仓库外）。 */
async function archiveRootOf(readRoot: string): Promise<string | undefined> {
  let level = readRoot
  for (const segment of ARCHIVE_SEGMENTS) {
    level = join(level, segment)
    if (!(await isPlainDirectory(level))) return undefined
  }
  return level
}

const MOVED_DOCUMENT = /^openspec\/changes\/([^/]+)\/(.+)$/u

/** 任务目录之下只有普通的路径段：拼到归档目录后面也走不出这个目录。 */
function staysBelowTaskDir(rest: string): boolean {
  return !/[\\\0]/u.test(rest) && rest.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * 任务结束时整个 `openspec/changes/<名>/` 移进 `archive/<日期>-<名>/`，而文档台账里登记的还是移动前的路径。
 * 读已结束任务时把这类路径改成现在的位置才读得到、求得出状态；任务目录之外的文档（`docs/…`）、别的任务的目录、
 * 已经在 `archive/` 下的路径，以及任务目录之下带 `..`、空段等走得出归档目录的路径原样返回。同日同名的 `-2`
 * 后缀归档目录照样对得上。
 */
export function archivedDocumentPath(path: string, dir: string): string {
  const moved = MOVED_DOCUMENT.exec(path)
  const dated = DATED_NAME.exec(dir)
  if (moved === null || dated === null) return path
  const [, name, rest] = moved
  const task = dated[2]
  if (name === undefined || rest === undefined || task === undefined || name === 'archive' || !staysBelowTaskDir(rest)) return path
  const sameTask = task === name || (task.startsWith(`${name}-`) && /^\d+$/u.test(task.slice(name.length + 1)))
  return sameTask ? `${ARCHIVE_DIR}/${dir}/${rest}` : path
}

/**
 * 已结束任务详情里登记过路径的两处证据——文档台账的每个路径、agent 运行的报告路径——按 `archivedDocumentPath`
 * 改到归档后的位置，Dashboard 才读得到；状态与其余字段不动。
 */
export function relocateArchivedPaths(change: ChangeSnapshot, dir: string): ChangeSnapshot {
  const { documents, agentRuns } = change
  const moved = (path: string): string => archivedDocumentPath(path, dir)
  return {
    ...change,
    ...(documents === undefined ? {} : { documents: { ...documents, items: documents.items.map((item) => ({ ...item, paths: item.paths.map(moved) })) } }),
    ...(agentRuns === undefined ? {} : {
      agentRuns: agentRuns.map((step) => ({
        ...step,
        agents: step.agents.map((agent) => (agent.reportPath === null ? agent : { ...agent, reportPath: moved(agent.reportPath) })),
      })),
    }),
  }
}

/**
 * 归档目录名 → 盘上的任务目录，已结束任务的每个只读详情接口（快照、编排、记录）共用这一处解析。
 * 名字必须是单段（拒绝空串、`..`、分隔符），`archive/` 逐级与任务目录本身都必须是真目录——符号链接可以把它们
 * 指到归档之外，所以与列表同一条规则：不跟随。不满足返回 undefined；是否带任务状态由调用方读时判断。
 */
export async function resolveArchivedTaskDir(readRoot: string, dir: string): Promise<string | undefined> {
  if (!ARCHIVED_TASK_DIR.test(dir)) return undefined
  const archive = await archiveRootOf(readRoot)
  if (archive === undefined) return undefined
  const task = join(archive, dir)
  return (await isPlainDirectory(task)) ? task : undefined
}

export interface EndedTaskList {
  /** 结束时间最新的至多 MAX_ENDED_TASKS 个，倒序（相同则目录名倒序）。 */
  readonly tasks: readonly EndedTaskSummary[]
  /** 读得出来的归档任务总数；比 `tasks` 大就说明列表被截断了。 */
  readonly total: number
}

/**
 * 归档任务的摘要。归档目录不存在、不可读或不安全时是空列表；单个目录读不出来只是跳过它（不计入 `total`）。
 * 每个目录都要看一眼才能按结束时间排序，所以上限只截断返回的列表，不限制读多少——读过的都在 `cache` 里。
 * `cache` 由调用方按项目持有，每次调用后只保留仍在盘上的目录。
 */
export async function listEndedTasks(readRoot: string, cache: EndedTaskCache): Promise<EndedTaskList> {
  let archive: string | undefined
  let names: string[]
  try {
    archive = await archiveRootOf(readRoot)
    names = archive === undefined
      ? []
      : (await readdir(archive, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => entry.name)
  } catch {
    names = []
  }
  if (archive === undefined || names.length === 0) {
    cache.entries.clear()
    return { tasks: [], total: 0 }
  }
  const root = archive
  const live = new Set<string>()
  const rows = await mapWithConcurrency(names, READ_CONCURRENCY, async (name): Promise<EndedTaskSummary | null> => {
    const dir = join(root, name)
    const info = await lstat(dir, { bigint: true }).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) return null
    const key = `${name}\u0000${info.mtimeNs}`
    live.add(key)
    const known = cache.entries.get(key)
    if (known !== undefined) return known
    const summary = await readSummary(dir, name, info.mtimeMs)
    cache.entries.set(key, summary)
    return summary
  })
  for (const key of cache.entries.keys()) if (!live.has(key)) cache.entries.delete(key)
  const ended = rows.filter((row): row is EndedTaskSummary => row !== null).sort(newestFirst)
  return { tasks: ended.slice(0, MAX_ENDED_TASKS), total: ended.length }
}
