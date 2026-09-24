import { describe, expect, it } from 'vitest'
import { dashboardSearch, parseDashboardLocation, parseWorkflowLocation, resolveDashboardRoot, workflowSearch } from './dashboardLocation'

describe('dashboard URL 深链路', () => {
  it('旧 view 值兼容：progress → workspace、workbench → workflow，退役视图落回工作台', () => {
    expect(parseDashboardLocation('?view=progress&root=%2Frepo&change=x')).toEqual({ view: 'workspace', root: '/repo', change: 'x' })
    expect(parseDashboardLocation('?view=workbench&wf=flow')).toEqual({ view: 'workflow' })
    expect(parseDashboardLocation('?debug=1&view=overview')).toEqual({ view: 'workspace' })
    expect(parseDashboardLocation('?view=hostPlan&root=%2Frepo')).toEqual({ view: 'workspace', root: '/repo' })
    expect(parseDashboardLocation('?view=afk')).toEqual({ view: 'workspace' })
    expect(parseDashboardLocation('?view=constructor')).toEqual({})
    // 改写回 URL 时只写新值：旧深链打开一次后地址栏即为新名。
    expect(dashboardSearch('?view=progress&root=%2Frepo', { view: 'workspace', root: '/repo', change: null })).toBe('?view=workspace&root=%2Frepo')
    expect(dashboardSearch('?view=workbench&wf=flow', { view: 'workflow', root: '', change: null })).toBe('?view=workflow&wf=flow')
  })

  it('顶部标签视图都可深链，URL 值与导航一一对应', () => {
    expect(parseDashboardLocation('?view=workflow&root=%2Frepo')).toEqual({ view: 'workflow', root: '/repo' })
    expect(parseDashboardLocation('?view=workspace')).toEqual({ view: 'workspace' })
    // 项目页（指令文件）与库页是一级视图，深链带 root 进项目级、空 root 进用户级。
    expect(parseDashboardLocation('?view=projects&root=%2Frepo')).toEqual({ view: 'projects', root: '/repo' })
    expect(parseDashboardLocation('?view=projects')).toEqual({ view: 'projects' })
    expect(parseDashboardLocation('?view=library')).toEqual({ view: 'library' })
    expect(parseDashboardLocation('?view=skills')).toEqual({ view: 'skills' })
    expect(dashboardSearch('?debug=1&root=%2Frepo&change=old', {
      view: 'workflow',
      root: '',
      change: null,
    })).toBe('?debug=1&view=workflow')
  })

  it('只接受已知 view，并逐字保留 root/change', () => {
    expect(parseDashboardLocation('?view=workspace&root=%2Frepo%2Fa&change=fix-login')).toEqual({
      view: 'workspace', root: '/repo/a', change: 'fix-login',
    })
    expect(parseDashboardLocation('?view=retired&root=%2Frepo')).toEqual({ root: '/repo' })
  })

  it('生成可复制链接时保留无关 query，并在离开详情时删除 change', () => {
    expect(dashboardSearch('?debug=1', { view: 'workflow', root: '', change: null })).toBe('?debug=1&view=workflow')
    expect(dashboardSearch('?debug=1&view=workspace&root=%2Frepo&change=old', { view: 'workflow', root: '/repo', change: null })).toBe('?debug=1&view=workflow&root=%2Frepo')
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
    expect(parseWorkflowLocation('?view=workflow&wf=%E5%8F%91%E5%B8%83&track=pm&step=spec')).toEqual({ wf: '发布', track: 'pm', step: 'spec' })
    expect(parseWorkflowLocation('?view=workflow&wf=default')).toEqual({ wf: 'default' })
    expect(parseWorkflowLocation('?view=workspace&step=spec')).toEqual({})
    expect(parseWorkflowLocation('?wf=&track=pm')).toEqual({})
  })

  it('workflowSearch 只写这三个键，null 删除；其它 query 保留', () => {
    expect(workflowSearch('?debug=1&view=workflow', { wf: 'flow', track: 'pm', step: 'spec' })).toBe('?debug=1&view=workflow&wf=flow&track=pm&step=spec')
    expect(workflowSearch('?view=workflow&wf=flow&track=pm&step=spec', { wf: 'flow', track: null, step: null })).toBe('?view=workflow&wf=flow')
  })

  it('离开工作流页时带走 wf / track / step；留在工作流页时原样保留', () => {
    expect(dashboardSearch('?view=workflow&wf=flow&track=pm&step=spec', { view: 'workspace', root: '', change: null })).toBe('?view=workspace')
    expect(dashboardSearch('?view=workflow&wf=flow&step=spec', { view: 'workflow', root: '/repo', change: null })).toBe('?view=workflow&wf=flow&step=spec&root=%2Frepo')
    // 不带 wf 的 step 不是工作流页的，别的页自己管。
    expect(dashboardSearch('?view=workspace&step=spec', { view: 'workspace', root: '', change: null })).toBe('?view=workspace&step=spec')
  })

  it('工作流页的 wf / track / step 与工作台的 status / step 共存：step 带 wf 时归工作流页，否则归工作台', () => {
    // 工作台 → 工作流页：工作台的 status / step 都走，工作流页随后自己写 wf / track / step。
    expect(dashboardSearch('?view=workspace&status=needs-you&step=verify&change=x', { view: 'workflow', root: '', change: null })).toBe('?view=workflow')
    // 在工作流页（带 wf）刷新：step 属于工作流页，保留；没有 status 可删。
    expect(dashboardSearch('?view=workflow&wf=flow&track=pm&step=spec', { view: 'workflow', root: '', change: null })).toBe('?view=workflow&wf=flow&track=pm&step=spec')
    // 工作流页 → 工作台：wf / track / step 全走，工作台的 step 不会被误认成工作流页的阶段。
    expect(dashboardSearch('?view=workflow&wf=flow&step=spec', { view: 'workspace', root: '/repo', change: 'x' })).toBe('?view=workspace&root=%2Frepo&change=x')
    // 留在工作台：status / step 都保留。
    expect(dashboardSearch('?view=workspace&status=done&step=build', { view: 'workspace', root: '', change: 'x' })).toBe('?view=workspace&status=done&step=build&change=x')
    // 去别的页：两边的键都不留。
    expect(dashboardSearch('?view=workspace&status=done&step=build', { view: 'library', root: '', change: null })).toBe('?view=library')
    expect(dashboardSearch('?view=workflow&wf=flow&track=pm&step=spec', { view: 'skills', root: '', change: null })).toBe('?view=skills')
  })
})
