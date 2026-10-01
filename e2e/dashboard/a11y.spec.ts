/**
 * 无障碍：主要页面（工作台与它的测试页签 / 完整性段 / 智能体运行抽屉、工作流总览与阶段 / 测试策略 / 评审者编辑器、
 * 项目、库、技能、新建项目向导）在真实浏览器里跑 axe-core，
 * serious / critical 违规必须为零（moderate / minor 只在报告里列出，不挡）。亮色、暗色各跑一遍——
 * 两套主题的对比度 token 不同，只测一套等于没测另一套。
 */
import AxeBuilder from '@axe-core/playwright'
import type { Page } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'

const BLOCKING = new Set(['serious', 'critical'])

interface Target {
  readonly name: string
  /** 打开页面并等它真正画好（不是只等导航出现）。 */
  readonly open: (page: Page, server: { project: string; sandbox: string }) => Promise<void>
  /** 不扫的区域。只用于有意的禁用态：WCAG 对停用的控件不要求对比度。 */
  readonly exclude?: readonly string[]
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
      // 还没有运行：登记的宿主是「—」，要求的宿主（codex）放在 title 里。
      await expect(page.getByTestId('agent-run-host').locator('[title="codex"]')).toBeVisible()
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
    // 已放进画布的候选行被有意压暗（opacity-45，「+」同时停用）：那是停用态，不参与对比度判定；宿主下拉在右栏，照扫。
    exclude: ['[data-testid^="palette-agent-"][data-placed="true"]'],
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'verify' })
      await page.getByTestId('wb-reviewers-edit').click()
      await expect(page.getByTestId('agent-composer')).toBeVisible()
      await expect(page.locator('[data-testid^="wb-agent-host-"]')).toBeVisible()
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

async function violationsOf(page: Page, exclude: readonly string[] = []): Promise<string[]> {
  // 动画（页面切换淡入、彗星）会让对比度读数落在半透明态：等一帧稳定后再扫。
  await page.waitForTimeout(600)
  const builder = exclude.reduce((axe, selector) => axe.exclude(selector), new AxeBuilder({ page }))
  const results = await builder.analyze()
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
        const violations = await violationsOf(page, target.exclude)
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
