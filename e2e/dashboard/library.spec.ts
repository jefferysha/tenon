import { expect, openView, test } from './support/fixtures'

const TEMPLATES = ['benchmark', 'code-size', 'design-system', 'diff-risk', 'e2e', 'integration', 'playwright', 'regression', 'typecheck', 'unit']

test.describe('库 · 测试模板', () => {
  test.beforeEach(async ({ page }) => {
    await openView(page, 'library')
    await page.getByTestId('lib-section-test-templates').click()
    await expect(page.getByTestId('lib-test-templates')).toBeVisible()
  })

  test('内建的测试模板全部列出，计数与列表一致', async ({ page }) => {
    for (const id of TEMPLATES) await expect(page.getByTestId(`lib-tt-${id}`), id).toBeVisible()
    await expect(page.getByTestId('lib-test-templates').locator('[data-testid^="lib-tt-"]')).toHaveCount(TEMPLATES.length)
    await expect(page.getByTestId('lib-section-test-templates')).toContainText(String(TEMPLATES.length))
  })

  test('只读：右列是结构化字段与一条可复制的 catalog add 命令，没有任何可编辑控件', async ({ page }) => {
    await page.getByTestId('lib-tt-benchmark').click()
    const detail = page.getByTestId('lib-tt-detail')
    await expect(detail).toBeVisible()
    await expect(page.getByTestId('lib-tt-add-text')).toHaveText('tenon test catalog add --from benchmark')
    await expect(page.getByTestId('lib-tt-field-kind')).toContainText('基准')
    await expect(page.getByTestId('lib-tt-field-command')).toContainText('npm run bench')
    await expect(page.getByTestId('lib-tt-fields'), '不再显示 YAML 原文').not.toContainText('schema:')

    await expect(detail.locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0)
    const buttons = detail.getByRole('button')
    await expect(buttons).toHaveCount(1)
    await expect(buttons.first()).toHaveAttribute('data-testid', 'lib-tt-add-copy')
    await expect(page.getByTestId('lib-tpl-new'), '测试模板没有「新建」').toHaveCount(0)
  })

  test('切换模板，命令与字段跟着换', async ({ page }) => {
    await page.getByTestId('lib-tt-unit').click()
    await expect(page.getByTestId('lib-tt-add-text')).toHaveText('tenon test catalog add --from unit')
    await page.getByTestId('lib-tt-playwright').click()
    await expect(page.getByTestId('lib-tt-add-text')).toHaveText('tenon test catalog add --from playwright')
    await expect(page.getByTestId('lib-tt-field-command')).toContainText('playwright')
  })
})
