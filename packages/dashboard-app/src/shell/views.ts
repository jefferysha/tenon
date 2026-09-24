/**
 * 顶部条各标签对应的视图 id，与 URL `?view=` 一一对应：workspace=工作台、workflow=工作流、projects=项目、
 * library=库、skills=技能（后三者全局，不依赖所选项目）。标签文案走 i18n `nav.*`。
 */
export const VIEWS = ['workspace', 'workflow', 'projects', 'library', 'skills'] as const
export type View = (typeof VIEWS)[number]

export type ThemePreference = 'system' | 'light' | 'dark'

export function isView(value: string | null | undefined): value is View {
  return value !== null && value !== undefined && (VIEWS as readonly string[]).includes(value)
}

/**
 * 旧 `?view=` 取值与旧 localStorage 记忆：progress / workbench 是工作台 / 工作流改名前的 id；
 * overview / afk / machine / hostPlan 是已退役的视图，落回工作台。读到后由壳层改写 URL。
 */
const LEGACY_VIEWS: ReadonlyMap<string, View> = new Map<string, View>([
  ['progress', 'workspace'],
  ['workbench', 'workflow'],
  ['overview', 'workspace'],
  ['afk', 'workspace'],
  ['machine', 'workspace'],
  ['hostPlan', 'workspace'],
])

/** 当前 id 原样返回，旧 id 映射到新 id，其余返回 null。 */
export function normalizeView(value: string | null | undefined): View | null {
  if (isView(value)) return value
  if (value === null || value === undefined) return null
  return LEGACY_VIEWS.get(value) ?? null
}

/**
 * 视图是否消费 /api/snapshot。只有工作台与项目页读快照；工作流、库、技能走各自的接口，
 * 首个快照未到或失败都不挡它们。
 */
const NEEDS_SNAPSHOT: Readonly<Record<View, boolean>> = {
  workspace: true,
  workflow: false,
  projects: true,
  library: false,
  skills: false,
}

export function viewNeedsSnapshot(view: View): boolean {
  return NEEDS_SNAPSHOT[view]
}

/** 三栏页（rail / list / detail）：加载时用三栏骨架占位。 */
export function isThreeColumnView(view: View): boolean {
  return view === 'workspace' || view === 'projects' || view === 'library'
}

/**
 * 工作台状态筛选的 URL 键与「需要你」取值。顶部条待决策徽标写入 `?status=needs-you`；
 * 工作台挂载时读取这个键作为初始状态筛选；离开工作台时壳层删掉这个键。
 */
export const TASK_STATUS_PARAM = 'status'
export const NEEDS_YOU_STATUS = 'needs-you'
