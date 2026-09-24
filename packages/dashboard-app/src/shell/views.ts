/**
 * 顶部条各标签对应的视图 id。id 沿用历史值（URL `?view=` 深链与 localStorage 记忆继续有效），
 * 用户可见的标签文案走 i18n `nav.*`：progress=工作台、workbench=工作流、projects=项目、library=库、
 * skills=技能（全局，不依赖所选项目）。
 * 其余历史视图（overview / afk / machine / hostPlan）已退役，深链落回工作台。
 */
export const VIEWS = ['progress', 'workbench', 'projects', 'library', 'skills'] as const
export type View = (typeof VIEWS)[number]

export type ThemePreference = 'system' | 'light' | 'dark'

export function isView(value: string | null | undefined): value is View {
  return value !== null && value !== undefined && (VIEWS as readonly string[]).includes(value)
}

/**
 * 视图是否消费 /api/snapshot。只有工作台与项目页读快照；工作流、库、技能走各自的接口，
 * 首个快照未到或失败都不挡它们。
 */
const NEEDS_SNAPSHOT: Readonly<Record<View, boolean>> = {
  progress: true,
  workbench: false,
  projects: true,
  library: false,
  skills: false,
}

export function viewNeedsSnapshot(view: View): boolean {
  return NEEDS_SNAPSHOT[view]
}

/** 三栏页（rail / list / detail）：加载时用三栏骨架占位。 */
export function isThreeColumnView(view: View): boolean {
  return view === 'progress' || view === 'projects' || view === 'library'
}

/**
 * 工作台状态筛选的 URL 键与「需要你」取值。顶部条待决策徽标写入 `?status=needs-you`；
 * 工作台挂载时读取这个键作为初始状态筛选；离开工作台时壳层删掉这个键。
 */
export const TASK_STATUS_PARAM = 'status'
export const NEEDS_YOU_STATUS = 'needs-you'
