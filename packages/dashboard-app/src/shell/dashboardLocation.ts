import { isView, TASK_STATUS_PARAM, type View } from './views'

export interface DashboardLocation {
  view?: View
  root?: string
  change?: string
}

export interface DashboardLocationState {
  view: View
  root: string
  change: string | null
}

/** URL 是可分享入口，非法/退役 view 不得压过 localStorage 的安全回退。 */
export function parseDashboardLocation(search: string): DashboardLocation {
  const params = new URLSearchParams(search)
  const result: DashboardLocation = {}
  const view = params.get('view')
  const root = params.get('root')
  const change = params.get('change')
  if (isView(view)) result.view = view
  if (root !== null && root !== '') result.root = root
  if (change !== null && change !== '') result.change = change
  return result
}

/** 工作流页（view=workbench）的可分享选择：工作流名 · 轨道 · 阶段。 */
export interface WorkflowLocation {
  wf?: string
  track?: string
  step?: string
}

const WORKFLOW_KEYS = ['wf', 'track', 'step'] as const

/** 只在带 wf 时才认 track / step：step 这个键没有 wf 就不属于工作流页。 */
export function parseWorkflowLocation(search: string): WorkflowLocation {
  const params = new URLSearchParams(search)
  const wf = params.get('wf')
  if (wf === null || wf === '') return {}
  const result: WorkflowLocation = { wf }
  const track = params.get('track')
  const step = params.get('step')
  if (track !== null && track !== '') result.track = track
  if (step !== null && step !== '') result.step = step
  return result
}

/** 写工作流页的三个键（null / 空 = 删除）；其余 query 原样保留。 */
export function workflowSearch(search: string, state: { wf: string | null; track: string | null; step: string | null }): string {
  const params = new URLSearchParams(search)
  for (const key of WORKFLOW_KEYS) {
    const value = state[key]
    if (value === null || value === '') params.delete(key)
    else params.set(key, value)
  }
  const value = params.toString()
  return value === '' ? '' : `?${value}`
}

/**
 * 各视图自有的 URL 键，离开该视图时删掉。`step` 两个视图都用：带 `wf` 时属于工作流页（阶段），
 * 不带 `wf` 时属于工作台（详情所选阶段）；`status` 只属于工作台。
 */
function dropForeignKeys(params: URLSearchParams, view: View): void {
  const stepOwner: View = params.has('wf') ? 'workbench' : 'progress'
  if (view !== stepOwner) params.delete('step')
  if (view !== 'workbench') {
    params.delete('wf')
    params.delete('track')
  }
  if (view !== 'progress') params.delete(TASK_STATUS_PARAM)
}

/** 只接管 dashboard 自有的键；debug 等外部 query 原样保留。离开一个视图时带走它自己的键。 */
export function dashboardSearch(search: string, state: DashboardLocationState): string {
  const params = new URLSearchParams(search)
  dropForeignKeys(params, state.view)
  params.set('view', state.view)
  if (state.root === '') params.delete('root')
  else params.set('root', state.root)
  if (state.change === null || state.change === '') params.delete('change')
  else params.set('change', state.change)
  const value = params.toString()
  return value === '' ? '' : `?${value}`
}

/**
 * 把 URL 中的显式项目选择解析成 snapshot 里真实登记的 root。
 * macOS 会把 `/tmp`、`/var` 通过系统 symlink canonicalize 为 `/private/tmp`、`/private/var`；
 * 深链常来自 shell 的逻辑路径，而 server registry 会记录 realpath。精确值永远优先，仅在精确
 * 值不存在时尝试这两组系统别名，避免把合法的同名字面路径误覆盖。
 */
export function resolveDashboardRoot(roots: readonly string[], preferred: string | null): string {
  if (preferred !== null && preferred !== '' && roots.includes(preferred)) return preferred
  if (preferred !== null && preferred !== '') {
    const aliases: string[] = []
    if (preferred === '/tmp' || preferred.startsWith('/tmp/') || preferred === '/var' || preferred.startsWith('/var/')) {
      aliases.push(`/private${preferred}`)
    } else if (
      preferred === '/private/tmp' || preferred.startsWith('/private/tmp/') ||
      preferred === '/private/var' || preferred.startsWith('/private/var/')
    ) {
      aliases.push(preferred.slice('/private'.length))
    }
    for (const alias of aliases) if (roots.includes(alias)) return alias
  }
  return ''
}
