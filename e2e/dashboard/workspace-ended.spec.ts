import { join } from 'node:path'
import { expect, openView, test } from './support/fixtures'

/** 沙盒项目里 seedSandbox 终止的任务（归档目录名 = 日期前缀 + 任务名）。 */
const ENDED = 'sandbox-ended'
const ENDED_CARD = new RegExp(`^task-card-\\d{4}-\\d{2}-\\d{2}-${ENDED}$`, 'u')
/** 观察模式项目里 seedObserved 做完调研、读完交接文档后终止的任务，与它调研步写出的设计文档。 */
const OBSERVED_ENDED = 'observed-ended'
const ENDED_DESIGN = 'docs/superpowers/specs/2026-10-12-observed-ended-design.md'
/** serve.mjs 把观察模式种子项目建在临时根下的 observed 目录。 */
const observedRoot = (server: { readonly scratch: string }): string => join(server.scratch, 'observed')

test.describe('工作台 · 已结束', () => {
  test('分类 全部 / 需要你 / 进行中 / 已结束；全部里已结束排在进行中之后，卡片带结果标记（已终止）', async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.sandbox })
    await expect(page.getByTestId('task-card-sandbox-change')).toBeVisible()
    for (const id of ['all', 'needs-you', 'running', 'ended']) {
      await expect(page.getByTestId(`task-status-${id}`), id).toBeVisible()
    }
    const cards = page.locator('[data-testid^="task-card-"]')
    const ended = cards.filter({ hasText: ENDED })
    await expect(ended).toHaveCount(1)
    // 全部：进行中的在前，已结束的都排在后面。
    const statuses = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-status')))
    const firstEnded = statuses.indexOf('ended')
    expect(firstEnded, '全部里有已结束的任务').toBeGreaterThan(0)
    expect(statuses.slice(firstEnded).every((status) => status === 'ended'), `已结束的都在最后：${statuses.join(',')}`).toBe(true)

    await page.getByTestId('task-status-ended').click()
    await expect(ended).toHaveCount(1)
    await expect(page.locator('[data-testid^="task-card-"]:not([data-status="ended"])')).toHaveCount(0)
    await expect(ended).toHaveAttribute('data-testid', ENDED_CARD)
    await expect(ended).toHaveAttribute('data-result', 'terminated')
    await expect(ended.locator('[data-testid^="task-summary-"]')).toHaveText('已终止')
    // 卡片一行一项，不换行。
    expect(await ended.locator('[data-testid^="task-meta-"]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  })

  test('打开已结束任务：只读详情，标题是任务名，菜单里没有终止', async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.sandbox })
    await page.getByTestId('task-status-ended').click()
    await page.locator('[data-testid^="task-card-"]').filter({ hasText: ENDED }).click()
    await expect(page.getByTestId('task-detail-title')).toHaveText(ENDED)
    await expect(page.getByTestId('task-detail-meta')).toContainText('default')
    await expect(page.getByTestId('task-detail-error')).toHaveCount(0)
    // 读到详情之前右列是只有标题与 ⋯ 的占位，读到后整列换成详情、⋯ 菜单随之重新挂载：等占位消失再开菜单。
    await expect(page.getByTestId('task-detail-loading')).toHaveCount(0)
    await page.getByTestId('task-detail-menu').click()
    await expect(page.getByRole('menuitem').first()).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /终止/u })).toHaveCount(0)
  })

  test('已结束任务的主体与活跃任务同一套面板（只读）：阶段 · 总览、编排画布、输入 / 输出、记录；没有下一步和测试页签', async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.sandbox })
    await page.getByTestId('task-status-ended').click()
    await page.locator('[data-testid^="task-card-"]').filter({ hasText: ENDED }).click()
    await expect(page.getByTestId('task-detail-title')).toHaveText(ENDED)
    // 编排画布来自归档里冻结的计划（`?archived=1`），不是空白。
    await expect(page.getByTestId('orchestration-stage')).toBeVisible()
    await expect(page.getByTestId('task-orchestration-error')).toHaveCount(0)
    await expect(page.getByTestId('task-view-tab-overview')).toBeVisible()
    await expect(page.getByTestId('stage-io')).toBeVisible()
    await expect(page.getByTestId('task-io-tab-inputs')).toBeVisible()
    await expect(page.getByTestId('task-io-tab-outputs')).toBeVisible()
    await expect(page.getByTestId('task-records')).toBeVisible()
    // 只读：没有下一步、评审台、测试页签。
    await expect(page.getByTestId('task-next')).toHaveCount(0)
    await expect(page.getByTestId('task-io-tab-tests')).toHaveCount(0)
    await page.getByTestId('task-view-tab-overview').click()
    await expect(page.getByTestId('orchestration-overview')).toBeVisible()
  })

  test('已结束任务的输入 / 输出是它当时真实发生的产出：输出 文件 · 变化 · 来源技能，输入 文件 · 来源阶段 · 来源技能 · 已读', async ({ page, server }) => {
    await openView(page, 'workspace', { root: observedRoot(server) })
    await page.getByTestId('task-status-ended').click()
    await page.locator('[data-testid^="task-card-"]').filter({ hasText: OBSERVED_ENDED }).click()
    await expect(page.getByTestId('task-detail-title')).toHaveText(OBSERVED_ENDED)
    await expect(page.getByTestId('task-orchestration-error')).toHaveCount(0)

    // 调研步：写出的设计文档（新增）与改过的 README.md（修改）；没有技能调用可对应，来源技能写「未知」。
    await page.getByTestId('stage-rail-explore').click()
    await expect(page.getByTestId('task-io-tab-outputs')).toContainText('2')
    const outputs = page.getByTestId('stage-outputs')
    await expect(outputs.getByRole('columnheader')).toHaveText(['文件', '变化', '来源技能'])
    const design = outputs.getByTestId(`stage-output-${ENDED_DESIGN}`)
    await expect(design.getByRole('cell')).toHaveText([/^2026-10-12-observed-ended-design\.md/u, '新增', '未知'])
    await expect(outputs.getByTestId('stage-output-README.md').getByRole('cell')).toHaveText([/^README\.md/u, '修改', '未知'])
    await expect(outputs.getByTestId('stage-output-README.md')).toHaveAttribute('data-change', 'modified')

    // 规格步：从上一步交接来的设计文档，已读（终止前读过）。
    await page.getByTestId('stage-rail-spec').click()
    await page.getByTestId('task-io-tab-inputs').click()
    const inputs = page.getByTestId('stage-inputs')
    await expect(inputs.getByRole('columnheader')).toHaveText(['文件', '来源阶段', '来源技能', '已读'])
    await expect(inputs.getByTestId(`stage-input-${ENDED_DESIGN}`).getByRole('cell')).toHaveText([/^2026-10-12-observed-ended-design\.md/u, '调研', '未知', '已读'])

    // 一行一项，不换行：表头与每一格都放得下。
    for (const cell of await inputs.getByRole('cell').all()) {
      expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height < 40)).toBe(true)
    }
    // 只读：详情里没有任何登记 / 读取 / 转换的控件。
    await expect(page.getByTestId('task-next')).toHaveCount(0)
  })

  test('「进行中」不含已结束任务', async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.sandbox })
    await page.getByTestId('task-status-running').click()
    await expect(page.getByTestId('task-card-sandbox-change')).toBeVisible()
    await expect(page.locator('[data-testid^="task-card-"][data-status="ended"]')).toHaveCount(0)
  })
})
