import { describe, expect, it } from 'vitest'
import { dashboardSearch, parseDashboardLocation, resolveDashboardRoot } from './dashboardLocation'

describe('dashboard URL 深链路', () => {
  it('退役的 overview / projects / hostPlan 深链不再是视图，只保留 root/change 与外部 query', () => {
    expect(parseDashboardLocation('?debug=1&view=overview')).toEqual({})
    expect(parseDashboardLocation('?debug=1&view=hostPlan&root=%2Frepo')).toEqual({ root: '/repo' })
    expect(parseDashboardLocation('?view=projects')).toEqual({})
  })

  it('四个顶部标签视图都可深链，且 machine 无项目依赖', () => {
    expect(parseDashboardLocation('?view=workbench&root=%2Frepo')).toEqual({ view: 'workbench', root: '/repo' })
    expect(parseDashboardLocation('?view=afk&root=%2Frepo')).toEqual({ view: 'afk', root: '/repo' })
    expect(dashboardSearch('?debug=1&root=%2Frepo&change=old', {
      view: 'machine',
      root: '',
      change: null,
    })).toBe('?debug=1&view=machine')
  })

  it('只接受已知 view，并逐字保留 root/change', () => {
    expect(parseDashboardLocation('?view=progress&root=%2Frepo%2Fa&change=fix-login')).toEqual({
      view: 'progress', root: '/repo/a', change: 'fix-login',
    })
    expect(parseDashboardLocation('?view=retired&root=%2Frepo')).toEqual({ root: '/repo' })
  })

  it('生成可复制链接时保留无关 query，并在离开详情时删除 change', () => {
    expect(dashboardSearch('?debug=1', { view: 'machine', root: '', change: null })).toBe('?debug=1&view=machine')
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
