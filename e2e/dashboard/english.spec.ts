/**
 * 英文界面：内置工作流数据（出厂阶段名、轨道名、测试方向名）显示英文，表格里的内置词不被截断，汇总计数词是正确的名词。
 * 种子项目用的是出厂 default 工作流，所以阶段 / 轨道 / 测试项名都还是出厂中文名。
 */
import type { Locator, Page } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'

test.use({ locale: 'en-US' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('tenon-dashboard-lang', 'en') } catch { /* 无存储时按默认语言 */ } })
})

/** 文字没有被截断：内容宽度不超过格子宽度。 */
async function fits(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
}

async function openTests(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId('task-io-tab-tests').click()
    await expect(page.getByTestId('task-tests')).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 20_000 })
}

test.describe('英文界面 · 内置工作流数据', () => {
  test('工作台：任务卡状态与阶段轨显示英文阶段名', async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
    await expect(page.getByTestId('task-card-add-login')).toContainText('Open · 5 blocked')
    const rail = page.getByTestId('stage-rail')
    for (const [id, label] of [['open', 'Open'], ['explore', 'Explore'], ['spec', 'Spec'], ['build', 'Build'], ['verify', 'Verify'], ['ship', 'Ship'], ['archive', 'Done']] as const) {
      await expect(rail.getByTestId(`stage-rail-${id}`)).toHaveText(label)
    }
    await expect(page.getByTestId('task-card-add-login')).not.toContainText('立项')
  })

  test('工作流：左栏阶段、轨道页签、总览与阶段画布（含出厂测试项）显示英文', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', track: 'backend', step: 'verify' })
    await expect(page.getByTestId('wb-step-open')).toContainText('Open')
    await expect(page.getByTestId('wb-step-verify')).toContainText('Verify')
    for (const [id, label] of [['chat', 'Chat'], ['pm', 'Product'], ['frontend', 'Frontend'], ['backend', 'Backend'], ['free', 'Free']] as const) {
      await expect(page.getByTestId(`wb-track-${id}`)).toHaveText(label)
    }
    // 阶段画布里的出厂测试项（代码规模）。
    await expect(page.getByTestId('orch-node-test-code-size')).toContainText('Code size')
    // 阶段标题（编辑框）与左栏显示同一个名字。
    await expect(page.getByTestId('wb-lane-name-input-verify')).toHaveValue('Verify')
    await expect(page.getByTestId('wb-lane-name-verify')).toHaveText('Verify')

    await openView(page, 'workflow', { wf: 'default', track: 'backend', step: ':overview' })
    await expect(page.getByTestId('orch-stage-open')).toContainText('Open')
    await expect(page.getByTestId('orch-stage-archive')).toContainText('Done')
    await expect(page.getByTestId('orch-node-test-code-size')).toContainText('Code size')
    await expect(page.getByTestId('workflow-overview-pane')).not.toContainText('立项')
  })
})

test.describe('英文界面 · 测试页签', () => {
  test.beforeEach(async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
    await openTests(page)
  })

  test('汇总的计数词：Suites / Cases / Failed / Flaky', async ({ page }) => {
    await expect(page.getByTestId('tests-stat-suite')).toHaveText('3Suites')
    await expect(page.getByTestId('tests-stat-case')).toHaveText('2Cases')
    await expect(page.getByTestId('tests-stat-fail')).toHaveText('1Failed')
    await expect(page.getByTestId('tests-stat-flaky')).toHaveText('0Flaky')
  })

  test('策略表：内置种类名、要求、结果和短标签都完整可见，不被截成 Integr…', async ({ page }) => {
    const matrix = page.getByTestId('tests-matrix')
    await expect(matrix).toBeVisible()
    for (const kind of ['unit', 'integration', 'e2e', 'benchmark', 'code-size']) {
      const row = page.getByTestId(`tests-kind-${kind}`)
      await expect(row).toBeVisible()
      expect(await fits(row.getByTestId(`tests-kind-label-${kind}`).locator('span').last()), `${kind} 种类名`).toBe(true)
      expect(await fits(row.getByTestId(`tests-requirement-${kind}`)), `${kind} 要求`).toBe(true)
    }
    await expect(page.getByTestId('tests-kind-label-integration')).toHaveText('Integration')
    await expect(page.getByTestId('tests-kind-label-e2e')).toHaveText('End-to-end')
    await expect(page.getByTestId('tests-kind-label-benchmark')).toHaveText('Benchmark')
    await expect(page.getByTestId('tests-requirement-benchmark')).toHaveText('If registered')
    expect(await fits(page.getByTestId('tests-blocker-label-integration')), '缺项短标签').toBe(true)
    // 出厂测试项名（代码规模）也是英文。
    await expect(page.getByTestId('tests-suite-step:code-size')).toHaveText('Code size')
  })

  test('完整性与阻塞表：信号名、明细、短标签完整可见；对象先让位', async ({ page }) => {
    const row = page.getByTestId('tests-integrity-row')
    await expect(row.getByTestId('tests-integrity-signal')).toHaveText('Coverage threshold lowered')
    expect(await fits(row.getByTestId('tests-integrity-signal'))).toBe(true)
    const detail = row.getByRole('cell').nth(2)
    await expect(detail).toHaveText('lines 80 → 60')
    expect(await fits(detail)).toBe(true)
    for (const label of await page.getByTestId('tests-blocker-code').all()) expect(await fits(label)).toBe(true)
  })
})
