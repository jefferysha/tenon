/**
 * 顶部条各标签对应的视图 id。id 沿用历史值（URL `?view=` 深链与 localStorage 记忆继续有效），
 * 用户可见的标签文案走 i18n `nav.*`：progress=工作台、workbench=工作流、projects=项目、library=库。
 * 其余历史视图（overview / afk / machine / hostPlan）已退役，深链落回工作台。
 */
export const VIEWS = ['progress', 'workbench', 'projects', 'library'] as const
export type View = (typeof VIEWS)[number]

export type ThemePreference = 'system' | 'light' | 'dark'

export function isView(value: string | null | undefined): value is View {
  return value !== null && value !== undefined && (VIEWS as readonly string[]).includes(value)
}
