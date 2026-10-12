/**
 * 挂起队列扫描 + 拓扑/FIFO 排序（BACKLOG #29b，纯读侧）。
 *
 * 老仓真相源：automation-queue.sh:1-110（aq_scan / aq_ready / _aq_dep_satisfied）。
 *   - 候选过滤：phase == build && automation == queued。
 *   - 就绪判定：depends_on 每个 dep 满足 = dep automation==merged ∪ dep 已归档
 *     （merged∪archived，比 guard 的"仅 archived"放宽——merged 是自动化路径内的逻辑完成信号）。
 *   - 排序：拓扑层级天然涌现（每轮只取依赖全满足的 = 当前最小层）；同层按 automation_queued_at
 *     FIFO（ISO8601 UTC 字典序 == 时间序）。空 queued_at 用高位 '~' 兜底排最后。
 *   - dep 不存在（打错字）→ 视为未满足（保守不放行，防乱序执行）。
 *   - **每轮重扫、不缓存就绪集**（dep 状态被并发沙箱改）；断点恢复天然（重扫即恢复）。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type StateStore, archiveDirIsTask, normalizeDeps } from '@tenon/kernel'

/** 空/null queued_at 的兜底排序键（高位字符，字典序排最后）。 */
const QUEUED_AT_LAST = '~'

export interface ChangeQueueEntry {
  readonly name: string
  readonly phase: string
  readonly automation: string
  readonly archived: string
  readonly automationQueuedAt: string
  readonly dependsOn: string[]
}

/** dep 满足判定面（satisfied = dep automation==merged ∪ dep 已归档）。 */
export interface DepResolver {
  satisfied(dep: string): boolean
}

const depsAllSatisfied = (deps: string[], resolver: DepResolver): boolean => {
  for (const dep of deps) {
    if (dep === '' || dep === 'null') continue
    if (!resolver.satisfied(dep)) return false
  }
  return true
}

/**
 * 纯函数就绪集：候选过滤 + dep 全满足 + FIFO 排序。老仓 aq_scan+aq_ready 的纯逻辑面。
 */
export function readyCandidates(entries: readonly ChangeQueueEntry[], resolver: DepResolver): string[] {
  const ready = entries
    .filter((e) => e.phase === 'build' && e.automation === 'queued' && e.archived !== 'true')
    .filter((e) => depsAllSatisfied(e.dependsOn, resolver))
  const key = (e: ChangeQueueEntry): string => (e.automationQueuedAt === '' || e.automationQueuedAt === 'null' ? QUEUED_AT_LAST : e.automationQueuedAt)
  return ready
    .slice()
    .sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      if (ka < kb) return -1
      if (ka > kb) return 1
      // 同 queued_at → name 字典序稳定（等价老仓 LC_ALL=C sort 的次级键）
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    .map((e) => e.name)
}

const scalar = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '')
const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

/**
 * 真 fs 扫描：枚举 changesDir/*，真读回每个 .pipeline.yaml 的 automation 字段，构造就绪集。
 * dep 满足走 merged∪archived：预取活跃 change 的 automation Map + 归档目录条目（archive/<日期>-<dep>[-N]）。
 * kernel StateStore 只读（read）——automation 零 kernel 修改。
 */
export async function scanReadyFromFs(changesDir: string, store: StateStore): Promise<string[]> {
  let dirents: import('node:fs').Dirent[]
  try {
    dirents = await readdir(changesDir, { withFileTypes: true })
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return []
    throw error
  }
  const activeNames = dirents.filter((d) => d.isDirectory() && d.name !== 'archive').map((d) => d.name)

  const entries: ChangeQueueEntry[] = []
  const automationByName = new Map<string, string>()
  for (const name of activeNames) {
    const changeDir = join(changesDir, name)
    const state = await store.read(changeDir)
    const automation = scalar(state.fields.automation)
    automationByName.set(name, automation)
    entries.push({
      name,
      phase: scalar(state.fields.phase),
      automation,
      archived: scalar(state.fields.archived),
      automationQueuedAt: scalar(state.fields.automation_queued_at),
      dependsOn: normalizeDeps(state.fields.depends_on),
    })
  }

  // 归档条目：openspec/changes/archive/<日期>-<dep>[-N]。
  let archiveEntries: string[] = []
  try {
    const archived = await readdir(join(changesDir, 'archive'), { withFileTypes: true })
    archiveEntries = archived.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }

  const resolver: DepResolver = {
    satisfied(dep) {
      // 活跃 change → 仅 automation==merged 算满足
      const a = automationByName.get(dep)
      if (a !== undefined) return a === 'merged'
      // 已归档（archive/<日期>-<dep>[-N]，与 guard 的依赖判定同一个匹配函数）→ 满足
      return archiveEntries.some((e) => archiveDirIsTask(e, dep))
    },
  }

  return readyCandidates(entries, resolver)
}
