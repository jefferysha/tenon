import { expect, openView, test } from './support/fixtures'

test.describe('项目页', () => {
  test('客户端：启用一个再停用，列表与添加菜单随之变化，刷新后保持', async ({ page, server }) => {
    await openView(page, 'projects', { root: server.sandbox })
    const codex = page.getByTestId('proj-client-codex')
    await expect(codex).toBeVisible()
    await expect(page.getByTestId('proj-client-codex-file')).toHaveText('AGENTS.md')
    await expect(page.getByTestId('proj-client-codex-status')).toHaveText('一致')
    await expect(page.getByTestId('proj-client-claude')).toHaveCount(0)

    await page.getByTestId('proj-add-client').click()
    await expect(page.getByTestId('proj-add-claude')).toBeVisible()
    await expect(page.getByTestId('proj-add-codex'), '已启用的客户端不在候选里').toHaveCount(0)
    await page.getByTestId('proj-add-claude').click()

    const claude = page.getByTestId('proj-client-claude')
    await expect(claude).toBeVisible()
    await expect(page.getByTestId('proj-client-claude-file')).toHaveText('CLAUDE.md')
    await expect(page.getByTestId('proj-client-claude-status')).toHaveText('缺失')
    await page.reload()
    await expect(page.getByTestId('proj-client-claude'), '启用写进项目，刷新不丢').toBeVisible()

    await page.getByTestId('proj-client-claude-more').click()
    await page.getByTestId('proj-disable-claude').click()
    await expect(page.getByTestId('proj-client-claude')).toHaveCount(0)
    await expect(codex).toBeVisible()
    await page.getByTestId('proj-add-client').click()
    await expect(page.getByTestId('proj-add-claude'), '停用后又回到候选里').toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('客户端行选中后右列显示它读的文件', async ({ page, server }) => {
    await openView(page, 'projects', { root: server.sandbox })
    await page.getByTestId('proj-client-codex-select').click()
    await expect(page.getByTestId('proj-client-codex')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByRole('textbox').first()).toHaveValue(/Sandbox/)
  })

  test('测试分段：套件表、最近结果、右列套件详情；没有目录的项目给空态', async ({ page, server }) => {
    await openView(page, 'projects', { root: server.project })
    await page.getByTestId('proj-segment-tab-tests').click()
    await expect(page.getByTestId('proj-segment-tab-tests')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('proj-tests-table')).toBeVisible()
    await expect(page.getByTestId('proj-suite-demo-unit')).toBeVisible()
    await expect(page.getByTestId('proj-suite-demo-check')).toBeVisible()
    await expect(page.getByTestId('proj-suite-result-demo-unit')).toHaveText('失败')
    // 种子的计划显式加跑了这个静态检查套件：验证阶段运行它，最近结果是通过。
    await expect(page.getByTestId('proj-suite-result-demo-check')).toHaveText('通过')
    // 每个套件标所属测试类（旧种类名 typecheck 归在静态类）。
    await expect(page.getByTestId('proj-suite-kind-demo-unit')).toHaveAttribute('data-kind', 'unit')
    await expect(page.getByTestId('proj-suite-kind-demo-check')).toHaveAttribute('data-kind', 'static')

    // 档位定义：三档各一行；种子的目录只写了 full，其余两档是内建缺省。
    await expect(page.getByTestId('proj-levels')).toBeVisible()
    await expect(page.getByTestId('proj-level-plan-source')).toHaveText('内建缺省')
    await expect(page.getByTestId('proj-level-changed-source')).toHaveText('内建缺省')
    await expect(page.getByTestId('proj-level-full-source')).toHaveText('目录')
    // 档位定义所在的文件只在标题旁图标的悬停说明里，页面上不写成句子。
    await expect(page.getByTestId('proj-levels')).not.toContainText('catalog.yaml')
    await page.getByTestId('proj-levels-file').focus()
    await expect(page.getByText('.tenon/tests/catalog.yaml').first()).toBeVisible()

    await page.getByTestId('proj-suite-open-demo-unit').click()
    const detail = page.getByTestId('proj-suite-detail')
    await expect(detail).toBeVisible()
    await expect(page.getByTestId('proj-suite-title')).toHaveText('Demo unit')
    await expect(page.getByTestId('proj-suite-command-text')).toContainText('node --test')
    await expect(page.getByTestId('proj-suite-report')).toContainText('test-results/demo-unit.xml')

    await page.getByTestId('proj-segment-tab-clients').click()
    await expect(page.getByTestId('proj-clients')).toBeVisible()

    await openView(page, 'projects', { root: server.sandbox })
    await page.getByTestId('proj-segment-tab-tests').click()
    await expect(page.getByTestId('proj-tests-empty')).toBeVisible()
    await expect(page.getByTestId('proj-tests-table')).toHaveCount(0)
  })
})
