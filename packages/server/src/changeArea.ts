/**
 * 任务目录所在的区：活跃任务在 `openspec/changes/`，已结束任务在 `openspec/changes/archive/`（只读）。
 * 扫描、单任务读取和已结束任务列表都从这里取路径段，不各自拼。
 */
export type ChangeArea = 'active' | 'archive'

const ACTIVE_SEGMENTS = ['openspec', 'changes'] as const
const ARCHIVE_SEGMENTS = ['openspec', 'changes', 'archive'] as const

/** 某个区相对仓库根的路径段。 */
export function changeAreaSegments(area: ChangeArea): readonly string[] {
  return area === 'archive' ? ARCHIVE_SEGMENTS : ACTIVE_SEGMENTS
}
