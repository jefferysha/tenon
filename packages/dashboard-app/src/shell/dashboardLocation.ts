import { isView, type View } from './views'

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

/** 只接管 dashboard 自有的三个键；debug 等外部 query 原样保留。 */
export function dashboardSearch(search: string, state: DashboardLocationState): string {
  const params = new URLSearchParams(search)
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
