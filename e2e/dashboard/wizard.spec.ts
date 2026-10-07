import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright/test'
import { expect, openView, settled, test } from './support/fixtures'

/** 点「下一步」前先等对话框落定（步骤框的高度过渡、步骤内容的淡入滑入），不在它还在挪的时候点。 */
async function next(page: Page): Promise<void> {
  await settled(page)
  await page.getByTestId('np-next').click()
}

/** 「创建」最多点这么多次：一次，加上点击被吞掉时的一次补点。 */
const MAX_CREATE_CLICKS = 2

const STEPS = ['location', 'templates', 'resources', 'clients', 'confirm'] as const
const ROWS = ['directory', 'git', 'file:AGENTS.md', 'file:CLAUDE.md', 'clients', 'register'] as const

test.describe('新建项目向导', () => {
  let parent = ''
  test.beforeEach(() => { parent = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-e2e-wizard-'))) })
  test.afterEach(() => { rmSync(parent, { recursive: true, force: true }) })

  test('位置 → 模板 → 资源 → 客户端 → 确认，进度逐行完成，打开项目', async ({ page, server }) => {
    // 系统文件夹选择器在浏览器里没法点：接口打桩成返回临时目录，其余全走真实的 server。
    const chooseBodies: unknown[] = []
    await page.route('**/api/fs/choose-folder', async (route) => {
      chooseBodies.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true, path: parent } })
    })
    await openView(page, 'projects', { root: server.sandbox })
    await page.getByTestId('proj-new').click()
    const dialog = page.getByTestId('np-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('np-steps').getByRole('button')).toHaveText(STEPS.map((_, index) => new RegExp(`${index + 1}`)))
    await expect(page.getByTestId('np-step-location')).toHaveAttribute('aria-current', 'step')

    // 首步高度贴内容（不再固定 384px 留大片空白）；遮罩不做背景模糊；⌶ 钮有可访问名称和 Tooltip。
    const frame = page.getByTestId('np-frame')
    await expect(frame).toHaveAttribute('data-fit', 'hug')
    await expect.poll(async () => (await frame.boundingBox())?.height ?? 999, { timeout: 5_000 }).toBeLessThan(200)
    expect(await dialog.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none')
    const type = page.getByTestId('np-existing-type')
    await expect(type).toHaveAccessibleName('输入路径')
    // 说明是 Radix Tooltip：指针要在钮上停满 400ms 才打开，其间钮一被挪走，待开的说明就取消。
    // 上面的轮询在外框高度「降到 200 以下」的那一刻就通过，而 200ms 的高度过渡此时还没走完，对话框是居中的，
    // 还会再挪；慢的 WebKit 上这一下常常发生在悬停之后——指针落空，说明永远不开（CI 里整整 10 秒的 getByRole('tooltip') 找不到）。
    // 所以：先等落定，再悬停；悬停之后说明没出现就把指针移开重新悬停，直到出现。断言本身不变。
    await settled(page)
    await expect(async () => {
      await page.mouse.move(0, 0)
      await type.hover()
      await expect(page.getByRole('tooltip')).toHaveText('输入路径', { timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    await expect(page.getByRole('tooltip')).toHaveText('输入路径')

    // 位置：新建目录 = 选父目录（走打桩的选择器）+ 文件夹名。
    await page.getByTestId('np-mode-empty').click()
    await page.getByTestId('np-parent-choose').click()
    await expect(page.getByTestId('np-parent-path')).toHaveText(parent)
    expect(chooseBodies).toHaveLength(1)
    await page.getByTestId('np-name').fill('wizard-app')
    const project = join(parent, 'wizard-app')
    await expect(page.getByTestId('np-final-path')).toContainText(project)
    await expect(page.getByTestId('np-next')).toBeEnabled()
    await next(page)

    // 模板：预览默认聚焦第一项，「添加」后进入所选。
    await expect(page.getByTestId('np-step-templates')).toHaveAttribute('aria-current', 'step')
    await settled(page)
    await page.getByTestId('np-block-builtin-common-base').click()
    await page.getByTestId('np-template-toggle').click()
    await expect(page.getByTestId('np-block-builtin-common-base')).toHaveAccessibleName(/已加入/)
    await next(page)

    // 资源可跳过。
    await expect(page.getByTestId('np-step-resources')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('np-resources')).toBeVisible()
    await next(page)

    // 客户端：隔离的 HOME 里没有检测到任何宿主，回退到默认的 Codex 与 Claude。
    await expect(page.getByTestId('np-step-clients')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('np-client-codex')).toBeChecked()
    await expect(page.getByTestId('np-client-claude')).toBeChecked()
    await next(page)

    // 确认：预检列出要做的事，「创建」才落盘。
    await expect(page.getByTestId('np-step-confirm')).toHaveAttribute('aria-current', 'step')
    // 进入确认步才开始预检（服务端的 compose + dry run，两个真实请求），在这之前确认步只有一个转圈。等它回来——计划或错误——再断言内容：
    // 慢机器上它比默认的 10 秒久（CI 的 WebKit 上 compose 这个请求一次整整 10 秒没有回应），所以单独给 30 秒；
    // 回来的若是错误（预检失败），在这里说清楚，而不是让后面的断言报「element(s) not found」。
    const confirmRoot = page.getByTestId('np-confirm-root')
    await expect(confirmRoot.or(page.getByTestId('np-error'))).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('np-error'), '预检返回了错误').toHaveCount(0)
    await expect(confirmRoot).toContainText(project)
    await expect(page.getByTestId('np-plan-AGENTS.md')).toBeVisible()
    await expect(page.getByTestId('np-plan-CLAUDE.md')).toBeVisible()
    await expect(page.getByTestId('np-action-register')).toBeVisible()
    expect(existsSync(project), '确认之前不该写盘').toBe(false)
    // 预检的计划到了之后，步骤框才开始 200ms 的高度过渡（ResizeObserver 量完才触发），按钮跟着挪位：等落定再点。
    // 并且以「进度出现」为准：慢的 WebKit 上这一下点击曾整个落空（没有任何请求发出，仍停在确认步）——
    // 没出现进度就再点；出现了（创建已开始，按钮已不在）就不再点，所以不会重复创建。
    // 再点一次要留下记录：重试掩盖的是点击被吞掉这个真实现象，不记下来就没人知道它还在发生。第三次点击也没用上
    // 就是真的坏了（不是动画没落定），直接失败，而不是在 toPass 里无限补点。
    await settled(page)
    const progress = page.getByTestId('np-progress')
    let createClicks = 0
    let thirdClickNeeded = false
    await expect(async () => {
      if (await progress.isVisible()) return
      if (createClicks >= MAX_CREATE_CLICKS) {
        thirdClickNeeded = true
        return
      }
      await page.getByTestId('np-next').click({ timeout: 2_000 })
      createClicks += 1
      if (createClicks > 1) {
        test.info().annotations.push({
          type: 'wizard-create-reclick',
          description: `${test.info().project.name}: 「创建」第 ${createClicks} 次点击（前面的点击没有让进度出现）`,
        })
      }
      await expect(progress).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    expect(thirdClickNeeded, `「创建」点了 ${createClicks} 次进度仍没出现：不再补第 ${MAX_CREATE_CLICKS + 1} 次点击`).toBe(false)
    await expect(progress).toBeVisible()

    // 进度：每一步都到 done。
    for (const row of ROWS) await expect(page.getByTestId(`np-row-${row}`)).toHaveAttribute('data-state', 'done')
    await expect(page.getByTestId('np-open')).toBeVisible()
    expect(existsSync(join(project, '.git'))).toBe(true)
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8').length).toBeGreaterThan(0)
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(true)

    // 打开项目：对话框关闭，工作台切到新项目。
    await page.getByTestId('np-open').click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('workspace')
    expect(new URL(page.url()).searchParams.get('root')).toBe(project)
    await expect(page.getByTestId('nav-workspace')).toHaveAttribute('aria-current', 'page')
  })

  test('新建目录名已被占用：预检在位置步报错，不能继续', async ({ page, server }) => {
    mkdirSync(join(parent, 'taken'))
    await page.route('**/api/fs/choose-folder', (route) => route.fulfill({ json: { ok: true, path: parent } }))
    await openView(page, 'projects', { root: server.sandbox })
    await page.getByTestId('proj-new').click()
    await page.getByTestId('np-mode-empty').click()
    await page.getByTestId('np-parent-choose').click()
    await page.getByTestId('np-name').fill('taken')
    await expect(page.getByTestId('np-name-check-error')).toBeVisible()
    await expect(page.getByTestId('np-next')).toBeDisabled()
    await page.getByTestId('np-name').fill('free-name')
    await expect(page.getByTestId('np-name-check-error')).toBeHidden()
    await expect(page.getByTestId('np-next')).toBeEnabled()
    // 输入过内容：取消要先确认放弃。
    await page.getByTestId('np-cancel').click()
    await page.getByTestId('np-discard-confirm').click()
    await expect(page.getByTestId('np-dialog')).toBeHidden()
    expect(existsSync(join(parent, 'free-name')), '取消不该创建目录').toBe(false)
  })
})
