/**
 * 无障碍：主要页面（工作台与它的测试页签 / 完整性段 / 智能体运行抽屉、工作流总览与阶段 / 测试策略 / 评审者编辑器、
 * 项目、库、技能、新建项目向导，以及服务端渲染的匿名登录页 / 登录链接无效页的中英文）在真实浏览器里跑 axe-core，
 * serious / critical 违规必须为零（moderate / minor 只在报告里列出，不挡）。亮色、暗色各跑一遍——
 * 两套主题的对比度 token 不同，只测一套等于没测另一套。
 */
import AxeBuilder from '@axe-core/playwright'
import type { Page } from 'playwright/test'
import { expect, openView, settled, test } from './support/fixtures'

const BLOCKING = new Set(['serious', 'critical'])

interface Target {
  readonly name: string
  /** 打开页面并等它真正画好（不是只等导航出现）。 */
  readonly open: (page: Page, server: { project: string; sandbox: string }) => Promise<void>
}

const TARGETS: readonly Target[] = [
  {
    name: '工作台',
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      await expect(page.getByTestId('task-detail-title')).toBeVisible()
    },
  },
  {
    name: '工作流 · 总览',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: ':overview' })
      await expect(page.getByTestId('orchestration-overview')).toBeVisible()
      await expect(page.getByTestId('orch-start')).toBeVisible()
    },
  },
  {
    name: '工作流 · 阶段',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'build' })
      await expect(page.getByTestId('workflow-nav')).toBeVisible()
    },
  },
  {
    name: '工作台 · 测试页签',
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      // 快照加载后还会刷新，刷新会把详情的页签重置：点到面板真出现为止（同 workspace-tests.spec）。
      await expect(async () => {
        await page.getByTestId('task-io-tab-tests').click()
        await expect(page.getByTestId('task-tests')).toBeVisible({ timeout: 1_500 })
      }).toPass({ timeout: 20_000 })
    },
  },
  {
    // 种子项目在任务开始后把覆盖率门槛从 80 降到 60：测试页签多出「完整性」段（一条信号，策略缺省 notice）。
    name: '工作台 · 测试页签 · 完整性',
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      await expect(async () => {
        await page.getByTestId('task-io-tab-tests').click()
        await expect(page.getByTestId('tests-integrity')).toBeVisible({ timeout: 1_500 })
      }).toPass({ timeout: 20_000 })
      await expect(page.getByTestId('tests-integrity-row')).toHaveAttribute('data-code', 'coverage-threshold-lowered')
    },
  },
  {
    // 种子的 backend 验证步骤要求 architecture 评审者在 codex 上跑；它还没有运行，抽屉里是「要求的宿主」那一行。
    name: '工作台 · 智能体运行抽屉（宿主）',
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      await expect(async () => {
        await page.getByTestId('orch-open-reviewer-architecture').click()
        await expect(page.getByTestId('agent-run-binding')).toBeVisible({ timeout: 1_500 })
      }).toPass({ timeout: 20_000 })
      // 还没有运行：登记的宿主是「—」，旁边是要求的宿主（codex + 小「要求」标记），再往下是可复制的启动命令。
      await expect(page.getByTestId('agent-run-host-recorded')).toHaveText('—')
      await expect(page.getByTestId('agent-run-host-required')).toHaveText('codex要求')
      await expect(page.getByTestId('agent-run-command-text')).toContainText('tenon agent prompt add-login architecture')
    },
  },
  {
    name: '工作流 · 阶段 · 测试策略（完整性）',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'verify' })
      await expect(page.getByTestId('wb-policy-integrity')).toBeVisible()
    },
  },
  {
    name: '工作流 · 评审者编辑器（执行宿主）',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'verify' })
      await page.getByTestId('wb-reviewers-edit').click()
      await expect(page.getByTestId('agent-composer')).toBeVisible()
      await expect(page.locator('[data-testid^="wb-agent-host-"]')).toBeVisible()
      // 已放进画布的候选行压暗成停用态（点行与「+」原生 disabled）：这些行也在扫描范围内，所以先确认它们真的存在。
      const placed = page.locator('[data-testid^="palette-agent-"][data-placed="true"]')
      await expect(placed.first()).toBeVisible()
      await expect(placed.first().locator('[data-testid^="palette-agent-open-"]')).toBeDisabled()
    },
  },
  {
    name: '工作流 · 技能编辑器（已放进画布的候选行）',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'build' })
      await page.getByTestId('wb-skills-edit').click()
      await expect(page.getByTestId('skill-composer')).toBeVisible()
      await expect(page.getByTestId('skill-flow')).toBeVisible()
      // 内置默认工作流的阶段没有显式技能：用「+」把第一个候选技能放进画布，点「完成」交回阶段（只在页面里，不点保存条所以不写盘），
      // 再重新打开。这样「完成」是停用态（草稿与阶段一致），扫到的是「已有一个技能在画布上」的稳定界面。
      await page.locator('[data-testid^="palette-add-"]').first().click()
      await expect(page.locator('[data-testid^="flow-node-"]').first()).toBeVisible()
      await page.getByTestId('skill-composer-save').click()
      await expect(page.getByTestId('skill-composer')).toBeHidden()
      await page.getByTestId('wb-skills-edit').click()
      await expect(page.getByTestId('skill-composer')).toBeVisible()
      await expect(page.locator('[data-testid^="flow-node-"]').first()).toBeVisible()
      // 已放进画布的候选行压暗成停用态（点行与「+」原生 disabled）：这些行也在扫描范围内，所以先确认它们真的存在。
      const placed = page.locator('[data-testid^="palette-"][data-placed="true"]')
      await expect(placed.first()).toBeVisible()
      await expect(placed.first().locator('[data-testid^="palette-open-"]')).toBeDisabled()
    },
  },
  // 「完成」在草稿有改动时才可点：上面的目标扫的是它停用的样子（停用控件不要求对比度），实心强调色的可点样子要单独扫——暗色下它的前景曾只有 1.96:1。
  {
    name: '工作流 · 评审者编辑器（完成可点）',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'verify' })
      await page.getByTestId('wb-reviewers-edit').click()
      await expect(page.getByTestId('agent-composer')).toBeVisible()
      await page.locator('[data-testid^="palette-agent-add-"]:enabled').first().click()
      await expect(page.getByTestId('agent-composer-save')).toBeEnabled()
    },
  },
  {
    name: '工作流 · 技能编辑器（完成可点）',
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'build' })
      await page.getByTestId('wb-skills-edit').click()
      await expect(page.getByTestId('skill-composer')).toBeVisible()
      await page.locator('[data-testid^="palette-add-"]').first().click()
      await expect(page.getByTestId('skill-composer-save')).toBeEnabled()
    },
  },
  {
    name: '项目',
    open: async (page, server) => {
      await openView(page, 'projects', { root: server.sandbox })
      await expect(page.getByTestId('proj-clients')).toBeVisible()
    },
  },
  {
    name: '项目 · 测试分段',
    open: async (page, server) => {
      await openView(page, 'projects', { root: server.project })
      await page.getByTestId('proj-segment-tab-tests').click()
      await expect(page.getByTestId('proj-tests-table')).toBeVisible()
      await page.getByTestId('proj-suite-open-demo-unit').click()
      await expect(page.getByTestId('proj-suite-detail')).toBeVisible()
    },
  },
  {
    name: '设置浮层',
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      await page.getByTestId('nav-settings').click()
      await expect(page.getByTestId('nav-settings-panel')).toBeVisible()
    },
  },
  {
    name: '库',
    open: async (page) => {
      await openView(page, 'library')
      await expect(page.getByTestId('lib-section-test-templates')).toBeVisible()
    },
  },
  ...(['templates', 'resources', 'test-templates', 'agents'] as const).map((section): Target => ({
    name: `库 · ${section}`,
    open: async (page) => {
      await openView(page, 'library')
      await page.getByTestId(`lib-section-${section}`).click()
      await expect(page.getByTestId(`lib-section-${section}`)).toHaveAttribute('aria-current', 'true')
    },
  })),
  {
    name: '技能',
    open: async (page) => {
      await openView(page, 'skills')
      await expect(page.getByTestId('skills-view')).toBeVisible()
    },
  },
  {
    name: '技能 · 详情',
    open: async (page) => {
      await openView(page, 'skills')
      const first = page.locator('[data-testid^="skills-open-"]').first()
      await expect(first).toBeVisible()
      await first.click()
      await expect(page.getByTestId('skill-detail')).toBeVisible()
    },
  },
  // 匿名页（服务端渲染的登录页）：没有会话、语言按 Accept-Language 选；亮 / 暗由外层的 colorScheme 决定。
  ...([['中文', 'zh-CN,zh;q=0.9', '需要登录'], ['English', 'en-US,en;q=0.9', 'Sign in required']] as const).map(([name, acceptLanguage, heading]): Target => ({
    name: `登录页 · ${name}`,
    open: async (page) => {
      await page.context().clearCookies()
      await page.route('**/', (route) => route.continue({ headers: { ...route.request().headers(), 'accept-language': acceptLanguage } }))
      const response = await page.goto('/')
      expect(response?.status()).toBe(401)
      await expect(page.getByTestId('sign-in-heading')).toHaveText(heading)
      await expect(page.getByTestId('sign-in-command')).toBeVisible()
    },
  })),
  {
    name: '登录链接无效页',
    open: async (page) => {
      await page.context().clearCookies()
      const response = await page.goto('/session/start?code=not-a-real-code')
      expect(response?.status()).toBe(403)
      await expect(page.getByTestId('sign-in-command')).toBeVisible()
    },
  },
  {
    name: '新建项目向导',
    open: async (page, server) => {
      await openView(page, 'projects', { root: server.sandbox })
      await page.getByTestId('proj-new').click()
      await expect(page.getByTestId('np-dialog')).toBeVisible()
      await expect(page.getByTestId('np-step-location')).toHaveAttribute('aria-current', 'step')
    },
  },
]

async function violationsOf(page: Page): Promise<string[]> {
  // 进场动画（抽屉 / 对话框的淡入与滑入、页面切换淡入）还在跑时，文字是半透明的，对比度读数会落在真实 token 之外
  // （慢的 WebKit 上动画要久得多）：等所有有限动画跑完且连续几帧安静，再扫。所有目标都经过这里。
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations
    .filter((violation) => violation.impact !== null && violation.impact !== undefined && BLOCKING.has(violation.impact))
    .map((violation) => {
      const nodes = violation.nodes.slice(0, 6).map((node) => `    ${node.target.join(' ')}  ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`).join('\n')
      return `[${violation.impact}] ${violation.id} ×${violation.nodes.length}: ${violation.help}\n${nodes}`
    })
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    for (const target of TARGETS) {
      test(`${target.name}：没有 serious / critical 违规`, async ({ page, server }) => {
        await target.open(page, server)
        const violations = await violationsOf(page)
        expect(violations, `\n${violations.join('\n')}\n`).toEqual([])
      })
    }
  })
}

test('页面语言属性：html lang 与所选界面语言一致（axe 的 html-has-lang / valid-lang 之外，切换后同步）', async ({ page }) => {
  await openView(page, 'library')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
  await page.evaluate(() => { localStorage.setItem('tenon-dashboard-lang', 'en') })
  await page.reload()
  await expect(page.getByTestId('primary-nav')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.evaluate(() => { localStorage.removeItem('tenon-dashboard-lang') })
})
