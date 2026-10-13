import { join } from 'node:path'
import type { Locator } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'

/**
 * 工作台的输入 / 输出页签显示每一步真实发生的产出（观察模式的任务，种子见 support/seed.mjs 的 seedObserved）：
 * plan-checkout 在调研步写了一份设计文档并改了 README.md，离开调研后停在规格步，交接来的设计文档还没读。
 */
const CHANGE = 'plan-checkout'
const DESIGN = 'docs/superpowers/specs/2026-10-12-plan-checkout-design.md'
/** serve.mjs 把观察模式种子项目建在临时根下的 observed 目录。 */
const observedRoot = (server: { readonly scratch: string }): string => join(server.scratch, 'observed')

/** 一格放得下：内容不被截断、没有换行。 */
async function fitsOneLine(cell: Locator): Promise<boolean> {
  return cell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height < 40)
}

test.describe('工作台 · 真实的输入与输出', () => {
  test('调研步的输出：文件 · 变化 · 来源技能，等分的表；新增与修改各一行，推断不出来源技能写「未知」', async ({ page, server }) => {
    await openView(page, 'workspace', { root: observedRoot(server), change: CHANGE, step: 'explore' })
    await expect(page.getByTestId('task-detail-title')).toHaveText(CHANGE)
    await expect(page.getByTestId('task-orchestration-error')).toHaveCount(0)
    const outputs = page.getByTestId('stage-outputs')
    await expect(outputs).toBeVisible()
    await expect(page.getByTestId('task-io-tab-outputs')).toContainText('2')
    await expect(outputs.getByRole('columnheader')).toHaveText(['文件', '变化', '来源技能'])
    await expect(outputs.getByTestId(`stage-output-${DESIGN}`).getByRole('cell')).toHaveText([/^2026-10-12-plan-checkout-design\.md/u, '新增', '未知'])
    await expect(outputs.getByTestId('stage-output-README.md').getByRole('cell')).toHaveText([/^README\.md/u, '修改', '未知'])
    // 三列等分，一格一行：没有方框芯片 / 药丸，也没有被截断或换行的格子。
    const widths = await outputs.getByTestId('stage-outputs-head').getByRole('columnheader').evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width)))
    expect(Math.max(...widths) - Math.min(...widths), `三列不等分：${widths.join(',')}`).toBeLessThanOrEqual(2)
    for (const cell of await outputs.getByRole('cell').all()) expect(await fitsOneLine(cell)).toBe(true)
    for (const cell of await outputs.getByRole('columnheader').all()) expect(await fitsOneLine(cell)).toBe(true)
    await expect(outputs).not.toContainText('契约')
  })

  test('点输出行打开抽屉读那份文件', async ({ page, server }) => {
    await openView(page, 'workspace', { root: observedRoot(server), change: CHANGE, step: 'explore' })
    await page.getByTestId(`stage-output-${DESIGN}`).click()
    const drawer = page.getByTestId('document-drawer')
    await expect(drawer).toBeVisible()
    await expect(page.getByTestId('document-drawer-title')).toHaveText('2026-10-12-plan-checkout-design.md')
    await expect(page.getByTestId('file-preview-markdown')).toContainText('What the explore step produced.')
  })

  test('规格步的输入：文件 · 来源阶段 · 来源技能 · 已读，来源阶段写名称；本步还没有产出', async ({ page, server }) => {
    await openView(page, 'workspace', { root: observedRoot(server), change: CHANGE, step: 'spec' })
    await page.getByTestId('task-io-tab-inputs').click()
    const inputs = page.getByTestId('stage-inputs')
    // 上一步写出的文档都交接过来（设计文档、改过的 README.md）。
    await expect(page.getByTestId('task-io-tab-inputs')).toContainText('2')
    await expect(inputs.getByRole('columnheader')).toHaveText(['文件', '来源阶段', '来源技能', '已读'])
    const row = inputs.getByTestId(`stage-input-${DESIGN}`)
    await expect(row.getByRole('cell')).toHaveText([/^2026-10-12-plan-checkout-design\.md/u, '调研', '未知', '未读'])
    await expect(row).toHaveAttribute('data-read', 'false')
    await expect(inputs.getByTestId('stage-input-README.md').getByRole('cell')).toHaveText([/^README\.md/u, '调研', '未知', '未读'])
    // 来源阶段与来源技能是纯文字：格子里就是文字本身，没有套子元素（芯片 / 药丸 / 圆点）。
    for (const index of [1, 2]) {
      expect(await row.getByRole('cell').nth(index).evaluate((el) => el.children.length), `第 ${index} 格`).toBe(0)
    }
    for (const cell of await inputs.getByRole('cell').all()) expect(await fitsOneLine(cell)).toBe(true)
    await page.getByTestId('task-io-tab-outputs').click()
    await expect(page.getByTestId('stage-outputs')).toHaveText('本步还没有产出')
  })

  test('下一步：必须产出与未读输入各一行短标签（词 + 对象），不出现 guard:required-output 与长句，完整文案在 title', async ({ page, server }) => {
    await openView(page, 'workspace', { root: observedRoot(server), change: CHANGE, step: 'spec' })
    const next = page.getByTestId('task-next')
    await expect(next).toBeVisible()
    const rows = next.getByTestId('task-next-blocker')
    // 必须产出一行；两份未读输入（README.md、设计文档）合并成一行。
    await expect(rows).toHaveText(['必须产出 docs/superpowers/plans/plan-checkout-plan.md', `未读 README.md · ${DESIGN}`])
    await expect(next).not.toContainText('guard:required-output')
    await expect(next).not.toContainText('tenon document read')
    await expect(rows.nth(1)).toHaveAttribute('title', /tenon document read plan-checkout all/u)
    // 一行一个 40px 行：太长时截断（title 有全文），不换行。
    for (const row of await rows.all()) expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(40)
  })

  test('英文界面：表头、变化与已读用英文词，文件名与阶段名原样', async ({ page, server }) => {
    await page.addInitScript(() => { try { localStorage.setItem('tenon-dashboard-lang', 'en') } catch { /* 无存储时按默认语言 */ } })
    await openView(page, 'workspace', { root: observedRoot(server), change: CHANGE, step: 'explore' })
    const outputs = page.getByTestId('stage-outputs')
    await expect(outputs.getByRole('columnheader')).toHaveText(['File', 'Change', 'Source skill'])
    await expect(outputs.getByTestId(`stage-output-${DESIGN}`).getByRole('cell')).toHaveText([/^2026-10-12-plan-checkout-design\.md/u, 'Added', 'Unknown'])
    await expect(outputs.getByTestId('stage-output-README.md').getByRole('cell').nth(1)).toHaveText('Modified')
    await page.getByTestId('stage-rail-spec').click()
    await page.getByTestId('task-io-tab-inputs').click()
    await expect(page.getByTestId('stage-inputs').getByRole('columnheader')).toHaveText(['File', 'Source stage', 'Source skill', 'Read'])
    await expect(page.getByTestId(`stage-input-${DESIGN}`).getByRole('cell').nth(1)).toHaveText('调研')
    await expect(page.getByTestId(`stage-input-${DESIGN}`).getByRole('cell').nth(3)).toHaveText('Unread')
  })
})
