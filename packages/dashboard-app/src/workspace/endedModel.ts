import { isProjectNavigable } from '../state/projectSelectionModel'
import type { EndedTask, Snapshot, TaskResult } from '../types'

/**
 * 工作台「已结束」里的一行：`openspec/changes/archive/` 下的一个任务，只有列表快照里的摘要。
 * 点开时才由 `GET /api/change/:dir/snapshot?archived=1` 读完整内容（只读）。
 */
export interface EndedRow {
  /** 与活跃行的 key（`<名字>@<root>`）分属两个命名空间：同名任务终止后重建，两行可以同时存在。 */
  key: string
  root: string
  /** 归档目录名（`<日期>-<名字>`）：URL 的 change 与详情接口认的就是它。 */
  dir: string
  task: EndedTask
}

export function endedKey(root: string, dir: string): string {
  return `archive/${dir}@${root}`
}

/** 归档目录名：仓库根相对路径 `openspec/changes/archive/<dir>` 的最后一段。 */
function dirOf(archivedDir: string): string {
  return archivedDir.slice(archivedDir.lastIndexOf('/') + 1)
}

/** 旧归档没有结果字段（`unknown`）按「完结」算。 */
export function resultOf(task: EndedTask): TaskResult {
  return task.result === 'unknown' ? 'finished' : task.result
}

function scopedProjects(snapshot: Snapshot | null, currentRoot: string): Snapshot['projects'] {
  return (snapshot?.projects ?? []).filter((project) => isProjectNavigable(project) && (currentRoot === '' || project.root === currentRoot))
}

/** 已结束的行，结束时间倒序；同一时刻按目录名倒序，顺序稳定。 */
export function endedRowsOf({ snapshot, currentRoot }: { snapshot: Snapshot | null; currentRoot: string }): EndedRow[] {
  const rows = scopedProjects(snapshot, currentRoot).flatMap((project) => (project.ended ?? []).map((task): EndedRow => {
    const dir = dirOf(task.archivedDir)
    return { key: endedKey(project.root, dir), root: project.root, dir, task }
  }))
  return rows.sort((left, right) => Date.parse(right.task.endedAt) - Date.parse(left.task.endedAt) || (left.dir < right.dir ? 1 : left.dir > right.dir ? -1 : 0))
}

/** 列出 `shown` 个、共 `total` 个：快照带 `endedTotal`（列表被截断）时 `total` 才大于 `shown`。 */
export function endedCountOf(snapshot: Snapshot | null, currentRoot: string): { shown: number; total: number } {
  let shown = 0
  let total = 0
  for (const project of scopedProjects(snapshot, currentRoot)) {
    const listed = project.ended?.length ?? 0
    shown += listed
    total += project.endedTotal ?? listed
  }
  return { shown, total }
}
