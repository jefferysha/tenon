import { readFileSync } from 'node:fs'
import { expect, openView, test } from './support/fixtures'

const CHANGE = 'add-login'
const FAILING = 'login rejects a wrong password'

test.describe('工作台任务 · 测试页签', () => {
  test.beforeEach(async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.project, change: CHANGE, step: 'verify' })
    // 快照在页面加载后还会刷新一两次（项目注册表、其它用例留下的痕迹），刷新会把详情的页签重置：点到面板真出现为止。
    await expect(async () => {
      await page.getByTestId('task-io-tab-tests').click()
      await expect(page.getByTestId('task-tests')).toBeVisible({ timeout: 1_500 })
    }).toPass({ timeout: 20_000 })
  })

  test('汇总一行：套件 · 用例 · 失败 · 不稳定', async ({ page }) => {
    const summary = page.getByTestId('tests-summary')
    await expect(summary).toHaveText('套件 3 · 用例 2 · 失败 1 · 不稳定 0')
    await expect(summary).toHaveAttribute('data-pass', 'false')
    const style = await summary.evaluate((el) => getComputedStyle(el).whiteSpace)
    expect(style).toBe('nowrap')
  })

  test('策略矩阵：单测失败，集成豁免待批准，回归缺种类；缺项带可复制命令', async ({ page }) => {
    await expect(page.getByTestId('tests-matrix')).toBeVisible()
    await expect(page.getByTestId('tests-result-unit')).toHaveText('失败')
    await expect(page.getByTestId('tests-registered-unit')).toContainText('Demo unit')
    await expect(page.getByTestId('tests-fix-unit-text')).toHaveText(`tenon test run ${CHANGE} --suite demo-unit`)

    await expect(page.getByTestId('tests-waiver-integration')).toContainText('待批准')
    await expect(page.getByTestId('tests-blocker-label-integration')).toHaveText('豁免未批准')
    await expect(page.getByTestId('tests-fix-integration-text')).toHaveText(`tenon review request ${CHANGE} --event verify-pass`)

    await expect(page.getByTestId('tests-blocker-label-regression')).toHaveText('缺测试种类')
    await expect(page.getByTestId('tests-registered-regression')).toHaveText('—')
    await expect(page.getByTestId('tests-fix-regression-text')).toContainText(`tenon test waive ${CHANGE} --kind regression`)
    await expect(page.getByTestId('tests-fix-regression-copy')).toBeVisible()
  })

  test('追溯表：任务 = 编号 · 阶段名 · 文字，场景 = 能力 · 场景；一行不折行', async ({ page }) => {
    const titles = page.getByTestId('tests-trace-title')
    await expect(titles.filter({ hasText: /^4\.1 · 实现 · / })).toHaveCount(1)
    await expect(titles.filter({ hasText: /^1\.1 · 立项 · / })).toHaveCount(1)
    await expect(page.getByTestId('tests-trace-spec:auth/Valid password signs in').getByTestId('tests-trace-title')).toHaveText('auth · Valid password signs in')
    await expect(page.getByTestId('tests-trace-state-spec:auth/Valid password signs in')).toHaveText('通过')
    await expect(page.getByTestId('tests-trace-state-spec:auth/Wrong password is rejected')).toHaveText('失败')
    await expect(page.getByTestId('tests-trace-state-task:4.1'), '骨架任务可选，不当缺项').toHaveText('可选')

    for (const title of await titles.all()) {
      const line = await title.evaluate((el) => {
        const style = getComputedStyle(el)
        return { whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow, title: el.getAttribute('title'), text: el.textContent, oneLine: el.scrollHeight <= el.clientHeight + 1 }
      })
      expect(line.whiteSpace).toBe('nowrap')
      expect(line.ellipsis).toBe('ellipsis')
      expect(line.oneLine).toBe(true)
      expect(line.title, '完整文字在 title 里').toBe(line.text)
    }
  })

  test('运行抽屉：失败用例展开看堆栈与产物，截图放大，trace 与报告可下载', async ({ page, baseURL }) => {
    await page.getByTestId('tests-suite-demo-unit').click()
    await expect(page.getByTestId('run-result')).toHaveText('失败')
    await expect(page.getByTestId('run-exit')).toContainText('1')
    await expect(page.getByTestId('run-totals')).toContainText('通过 1')
    await expect(page.getByTestId('run-totals')).toContainText('失败 1')

    const failed = page.getByTestId('run-case')
    await expect(failed).toHaveCount(1)
    await expect(failed).toHaveAttribute('data-status', 'fail')
    await expect(page.getByTestId('run-case-name')).toHaveText(FAILING)
    await expect(page.getByTestId('run-case-location')).toContainText('tests/auth.test.mjs')
    await page.getByTestId('run-case-toggle').click()
    await expect(page.getByTestId('run-case-detail')).toBeVisible()
    await expect(page.getByTestId('run-case-stack')).toContainText('tests/auth.test.mjs')
    await expect(page.getByTestId('run-case-stack')).toContainText('access granted')

    // 截图：缩略图真的加载出像素，点开是放大查看。
    const shot = page.getByTestId('run-screenshot').first()
    await expect(shot).toBeVisible()
    const image = shot.locator('img')
    await expect(image).toHaveJSProperty('complete', true)
    expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320)
    await shot.click()
    await expect(page.getByTestId('run-viewer')).toBeVisible()
    await expect(page.getByTestId('run-viewer-image')).toBeVisible()
    await page.getByTestId('run-viewer-close').click()
    await expect(page.getByTestId('run-viewer')).toBeHidden()

    // trace：给出 show-trace 命令和下载链接；点下载真的拿到文件。
    await expect(page.getByTestId('run-trace-command-0-text')).toContainText('npx playwright show-trace')
    const link = page.getByTestId('run-trace-download-0')
    const href = await link.getAttribute('href')
    expect(href).toContain('/api/tests/artifact')
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
    // 浏览器存下来的必须是产物的原文件名，而不是按 URL 末段猜出的 artifact.zip。
    expect(download.suggestedFilename()).toBe('trace.zip')
    const saved = await download.path()
    expect(readFileSync(saved).subarray(0, 4).toString('hex'), '文件头是 zip 的 PK').toBe('504b0506')

    // 同一个链接直接请求也是 200，且是附件（page.request 带着页面的会话 cookie）。
    const response = await page.request.get(new URL(href ?? '', baseURL).toString())
    expect(response.status()).toBe(200)
    expect(response.headers()['content-disposition']).toBe('attachment; filename="trace.zip"')
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['content-security-policy']).toBe('sandbox')
    expect((await response.body()).length).toBe(22)

    // 报告文件同样可下载。
    const report = page.getByTestId('run-file-download-0')
    const [reportDownload] = await Promise.all([page.waitForEvent('download'), report.click()])
    expect(reportDownload.suggestedFilename(), '文本产物同样带原文件名，不是 artifact.txt').toBe('demo-unit.xml')
    expect(readFileSync(await reportDownload.path(), 'utf8')).toContain(FAILING)
  })

  test('运行抽屉里的历史：本次运行的一行可见，关闭抽屉回到矩阵', async ({ page }) => {
    await page.getByTestId('tests-suite-demo-unit').click()
    await expect(page.getByTestId('run-history')).toBeVisible()
    await expect(page.locator('[data-testid^="run-history-step-"]').first()).toHaveText('验证')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('run-result')).toBeHidden()
    await expect(page.getByTestId('tests-matrix')).toBeVisible()
  })
})
