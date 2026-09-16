import { describe, expect, it } from 'vitest'
import { dashboardSearch, parseDashboardLocation, resolveDashboardRoot } from './dashboardLocation'

describe('dashboard URL 深链路', () => {
  it('退役的 overview / hostPlan 深链不再是视图，只保留 root/change 与外部 query', () => {
    expect(parseDashboardLocation('?debug=1&view=overview')).toEqual({})
    expect(parseDashboardLocation('?debug=1&view=hostPlan&root=%2Frepo')).toEqual({ root: '/repo' })
  })

  it('顶部标签视图都可深链；退役的 afk / machine 不再是视图', () => {
    expect(parseDashboardLocation('?view=workbench&root=%2Frepo')).toEqual({ view: 'workbench', root: '/repo' })
    // 项目页（指令文件）与库页是一级视图，深链带 root 进项目级、空 root 进用户级。
    expect(parseDashboardLocation('?view=projects&root=%2Frepo')).toEqual({ view: 'projects', root: '/repo' })
    expect(parseDashboardLocation('?view=projects')).toEqual({ view: 'projects' })
    expect(parseDashboardLocation('?view=library')).toEqual({ view: 'library' })
    expect(parseDashboardLocation('?view=afk&root=%2Frepo')).toEqual({ root: '/repo' })
    expect(parseDashboardLocation('?view=machine')).toEqual({})
    expect(dashboardSearch('?debug=1&root=%2Frepo&change=old', {
      view: 'workbench',
      root: '',
      change: null,
    })).toBe('?debug=1&view=workbench')
  })

  it('只接受已知 view，并逐字保留 root/change', () => {
    expect(parseDashboardLocation('?view=progress&root=%2Frepo%2Fa&change=fix-login')).toEqual({
      view: 'progress', root: '/repo/a', change: 'fix-login',
    })
    expect(parseDashboardLocation('?view=retired&root=%2Frepo')).toEqual({ root: '/repo' })
  })

  it('生成可复制链接时保留无关 query，并在离开详情时删除 change', () => {
    expect(dashboardSearch('?debug=1', { view: 'workbench', root: '', change: null })).toBe('?debug=1&view=workbench')
    expect(dashboardSearch('?debug=1&view=progress&root=%2Frepo&change=old', { view: 'workbench', root: '/repo', change: null })).toBe('?debug=1&view=workbench&root=%2Frepo')
  })

  it('无显式偏好或偏好失效时保持未选择，不回退注册表首项', () => {
    expect(resolveDashboardRoot(['/repo-a', '/repo-b'], null)).toBe('')
    expect(resolveDashboardRoot(['/repo-a', '/repo-b'], '')).toBe('')
    expect(resolveDashboardRoot(['/repo-a', '/repo-b'], '/missing')).toBe('')
  })

  it('显式 macOS 逻辑路径仍可解析到已登记的规范路径', () => {
    expect(resolveDashboardRoot(['/old', '/private/tmp/repo-a'], '/tmp/repo-a')).toBe('/private/tmp/repo-a')
  })
})
