import { describe, expect, it } from 'vitest'
import { dashboardSearch, parseDashboardLocation, parseWorkflowLocation, resolveDashboardRoot, workflowSearch } from './dashboardLocation'

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

  it('工作流页：wf / track / step 可深链；没有 wf 时 track / step 不算工作流页的', () => {
    expect(parseWorkflowLocation('?view=workbench&wf=%E5%8F%91%E5%B8%83&track=pm&step=spec')).toEqual({ wf: '发布', track: 'pm', step: 'spec' })
    expect(parseWorkflowLocation('?view=workbench&wf=default')).toEqual({ wf: 'default' })
    expect(parseWorkflowLocation('?view=progress&step=spec')).toEqual({})
    expect(parseWorkflowLocation('?wf=&track=pm')).toEqual({})
  })

  it('workflowSearch 只写这三个键，null 删除；其它 query 保留', () => {
    expect(workflowSearch('?debug=1&view=workbench', { wf: 'flow', track: 'pm', step: 'spec' })).toBe('?debug=1&view=workbench&wf=flow&track=pm&step=spec')
    expect(workflowSearch('?view=workbench&wf=flow&track=pm&step=spec', { wf: 'flow', track: null, step: null })).toBe('?view=workbench&wf=flow')
  })

  it('离开工作流页时带走 wf / track / step；留在工作流页时原样保留', () => {
    expect(dashboardSearch('?view=workbench&wf=flow&track=pm&step=spec', { view: 'progress', root: '', change: null })).toBe('?view=progress')
    expect(dashboardSearch('?view=workbench&wf=flow&step=spec', { view: 'workbench', root: '/repo', change: null })).toBe('?view=workbench&wf=flow&step=spec&root=%2Frepo')
    // 不带 wf 的 step 不是工作流页的，别的页自己管。
    expect(dashboardSearch('?view=progress&step=spec', { view: 'progress', root: '', change: null })).toBe('?view=progress&step=spec')
  })
})
