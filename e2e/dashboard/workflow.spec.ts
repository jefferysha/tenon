import type { Page } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'

const STAGES = [['open', '立项'], ['explore', '调研'], ['spec', '规格'], ['build', '实现'], ['verify', '验证'], ['ship', '交付'], ['archive', '完结']] as const
const SAMPLE_MS = 2_400
const SAMPLE_EVERY_MS = 100

/** 每隔 SAMPLE_EVERY_MS 记一次所有脉冲边的 stroke-dashoffset（取计算值，GSAP 写的是行内样式）。 */
async function sampleDashOffsets(page: Page): Promise<string[]> {
  return page.evaluate(async ({ total, every }) => {
    const seen: string[] = []
    const started = performance.now()
    while (performance.now() - started < total) {
      seen.push(JSON.stringify([...document.querySelectorAll('path[data-pulse-stroke]')].map((path) => getComputedStyle(path).strokeDashoffset)))
      await new Promise((resolve) => setTimeout(resolve, every))
    }
    return seen
  }, { total: SAMPLE_MS, every: SAMPLE_EVERY_MS })
}

test.describe('工作流页', () => {
  test('总览画布：每个阶段一列，列头带序号、名称与门禁图标', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    await expect(page.getByTestId('workflow-overview-pane')).toBeVisible()
    await expect(page.getByTestId('orchestration-overview')).toBeVisible()
    for (const [index, [id, label]] of STAGES.entries()) {
      const column = page.getByTestId(`orch-frame-${id}`)
      await expect(column, `阶段 ${id}`).toHaveCount(1)
      await expect(column).toContainText(`${index + 1}${label}`)
      await expect(page.getByTestId(`orch-stage-${id}`).getByTestId('orch-gate')).toHaveCount(1)
    }
    await expect(page.getByTestId('orch-start')).toBeVisible()
    await expect(page.getByTestId('orch-end')).toBeVisible()
  })

  test('脉冲一直在动：空闲画布上 stroke-dashoffset 在 2 秒里持续变化', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    // 脉冲晚一拍才建：等边上有了 dasharray 再开始采样。
    await expect.poll(() => page.locator('path[data-pulse-stroke][stroke-dasharray]').count(), { timeout: 15_000 }).toBeGreaterThan(0)
    const samples = await sampleDashOffsets(page)
    const distinct = new Set(samples)
    expect(samples.length).toBeGreaterThan(10)
    expect(distinct.size, `dashoffset 采样 ${samples.length} 次只见到 ${distinct.size} 种取值`).toBeGreaterThanOrEqual(4)
    // 至少一条边的偏移量在窗口内前后不同（不是各边各自静止在不同位置）。
    const vectors = samples.map((sample) => JSON.parse(sample) as string[])
    const moved = (vectors[0] ?? []).some((_, edge) => new Set(vectors.map((vector) => vector[edge])).size > 1)
    expect(moved).toBe(true)
    // 再等一个窗口仍在动：循环不是只播一遍。
    const later = new Set(await sampleDashOffsets(page))
    expect(later.size).toBeGreaterThanOrEqual(4)
  })

  test('系统要求减少动态效果时脉冲静止：采样器分得出动与不动', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    await expect(page.getByTestId('orchestration-overview')).toBeVisible()
    await expect.poll(() => page.locator('path[data-pulse-stroke]').count(), { timeout: 15_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(500)
    expect(new Set(await sampleDashOffsets(page)).size).toBe(1)
  })

  test('门禁只有 评审 / 自动 两个选项；切换后未保存，放弃即恢复', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', step: 'build' })
    const gate = page.getByTestId('wb-lane-gate-build')
    await expect(gate).toBeVisible()
    await expect(gate).toHaveAttribute('role', 'radiogroup')
    const radios = gate.getByRole('radio')
    await expect(radios).toHaveCount(2)
    await expect(radios.nth(0)).toContainText('评审')
    await expect(radios.nth(1)).toContainText('自动')
    await expect(gate.getByRole('radio', { checked: true })).toHaveCount(1)

    const auto = page.getByTestId('wb-lane-gate-build-auto')
    const review = page.getByTestId('wb-lane-gate-build-review')
    const initial = (await auto.getAttribute('aria-checked')) === 'true' ? auto : review
    const other = initial === auto ? review : auto
    await other.click()
    await expect(other).toHaveAttribute('aria-checked', 'true')
    await expect(initial).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('wb-dirty')).toBeVisible()
    await expect(page.getByTestId('wb-save')).toBeEnabled()
    await page.getByTestId('wb-discard').click()
    await expect(initial).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('wb-save')).toBeDisabled()
  })

  test('每个阶段的门禁控件都只有评审与自动', async ({ page }) => {
    for (const [id] of STAGES) {
      await openView(page, 'workflow', { wf: 'default', step: id })
      const gate = page.getByTestId(`wb-lane-gate-${id}`)
      await expect(gate, id).toBeVisible()
      await expect(gate.getByRole('radio')).toHaveCount(2)
      await expect(gate.getByTestId(`wb-lane-gate-${id}-review`)).toBeVisible()
      await expect(gate.getByTestId(`wb-lane-gate-${id}-auto`)).toBeVisible()
    }
  })
})
