import { expect, openView, test } from './support/fixtures'

test.describe('技能页', () => {
  test('引用列：内建 default 的阶段技能被算进来（工作流列表里没有 default），第一处 + 「+N」，悬停列出全部并带轨道', async ({ page }) => {
    await openView(page, 'skills')
    await expect(page.getByTestId('skills-table')).toBeVisible()
    // 引用由每条轨道的编排汇总，晚于技能表出现。
    const brainstorming = page.getByTestId('skills-used-brainstorming')
    await expect(brainstorming).toContainText('default · 调研', { timeout: 20_000 })
    await expect(page.getByTestId('skills-used-writing-plans')).toContainText('default · 规格')
    await expect(page.getByTestId('skills-used-openspec-propose')).toContainText('default · 立项')
    // 同一阶段在多条轨道里是一处；多处时显示「+N」。
    await expect(page.getByTestId('skills-used-more-brainstorming')).toHaveText(/^\+\d+$/u)
    // 没有被任何工作流用到的技能仍然是「—」。
    await expect(page.getByTestId('skills-used-agent-author')).toHaveText('—')
    // 一行不折行。
    expect(await brainstorming.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap')

    await brainstorming.locator('span').first().hover()
    const list = page.getByTestId('skills-used-list-brainstorming').first()
    await expect(list).toBeVisible()
    await expect(list.locator('li').first()).toContainText('default · 调研 · ')
    expect(await list.locator('li').first().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap')
  })
})
