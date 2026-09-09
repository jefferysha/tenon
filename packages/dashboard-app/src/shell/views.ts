/**
 * 顶部条四个标签对应的视图 id。id 沿用历史值（URL `?view=` 深链与 localStorage 记忆继续有效），
 * 用户可见的标签文案走 i18n `nav.*`：progress=工作台、workbench=工作流、afk=自动化、machine=机器。
 * 已退役的 overview / projects / hostPlan 不再是视图：项目选择进了工作台左列，宿主计划进了机器页的 sheet。
 */
export const VIEWS = ['progress', 'workbench', 'afk', 'machine'] as const
export type View = (typeof VIEWS)[number]

export type ThemePreference = 'system' | 'light' | 'dark'

export function isView(value: string | null | undefined): value is View {
  return value !== null && value !== undefined && (VIEWS as readonly string[]).includes(value)
}
