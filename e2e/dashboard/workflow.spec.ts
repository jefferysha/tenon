import type { Page } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'

const STAGES = [['open', '立项'], ['explore', '调研'], ['spec', '规格'], ['build', '实现'], ['verify', '验证'], ['ship', '交付'], ['archive', '完结']] as const
const SAMPLE_MS = 2_400
const SAMPLE_EVERY_MS = 100
const CORE = 'path[data-signal-layer="core"]'

/** 每隔 SAMPLE_EVERY_MS 记一次所有彗星核的 stroke-dashoffset（取计算值，运行时写的是属性）。 */
async function sampleDashOffsets(page: Page): Promise<string[]> {
  return page.evaluate(async ({ total, every, selector }) => {
    const seen: string[] = []
    const started = performance.now()
    while (performance.now() - started < total) {
      seen.push(JSON.stringify([...document.querySelectorAll(selector)].map((path) => getComputedStyle(path).strokeDashoffset)))
      await new Promise((resolve) => setTimeout(resolve, every))
    }
    return seen
  }, { total: SAMPLE_MS, every: SAMPLE_EVERY_MS, selector: CORE })
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

  test('Signal 一直在流：空闲画布上彗星核的 stroke-dashoffset 在 2 秒里持续变化，且只有热边是可见的', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    await expect(page.getByTestId('orchestration-overview')).toHaveAttribute('data-signal', 'ambient')
    // 运行时晚一拍才建：等彗星层有了 dasharray 再开始采样。
    await expect.poll(() => page.locator(`${CORE}[stroke-dasharray]`).count(), { timeout: 15_000 }).toBeGreaterThan(0)
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
    // 只写热边：任一时刻可见的彗星组远少于总数，其余保持 hidden。
    const { visible, total } = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('g[data-signal-edge]')]
      return { visible: groups.filter((group) => group.getAttribute('visibility') === 'visible').length, total: groups.length }
    })
    expect(total).toBeGreaterThan(10)
    expect(visible).toBeLessThan(total)
  })

  test('总览默认缩放 0.85：每个节点都显示名称，起点贴左 24px、内容顶对齐留 24px，并行的一波画括号条；点列头进入该阶段', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    const canvas = page.getByTestId('orchestration-overview')
    const viewport = page.locator('.react-flow__viewport')
    const zoomOf = (): Promise<number> => viewport.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
    await expect.poll(zoomOf).toBeCloseTo(0.85, 2)
    // 名称：中间截断保尾的名字也带着尾部；没有一个节点只剩符号。
    const names = page.locator('[data-testid^="orch-open-"]')
    expect(await names.count()).toBeGreaterThan(10)
    const empty = await names.evaluateAll((buttons) => buttons.filter((button) => (button.textContent ?? '').trim() === '').length)
    expect(empty).toBe(0)
    await expect(page.getByTestId('orch-open-skill-openspec-propose').first()).toContainText('openspec-propose')
    // 左上留白 24px（回流弧的上界算在内）。
    const box = await canvas.boundingBox()
    const start = await page.getByTestId('orch-start').boundingBox()
    expect(Math.abs((start!.x - box!.x) - 24 - 1)).toBeLessThan(3)
    const arcTop = await page.locator('[data-testid^="orch-return-"]').first().evaluate((el) => el.getBoundingClientRect().top)
    expect(Math.abs((arcTop - box!.y) - 24)).toBeLessThan(6)
    // 并行的一波在脊柱侧画括号条；没有扇出 / 汇入轨道。
    expect(await page.getByTestId('orch-bracket').count()).toBeGreaterThan(0)
    expect(await page.getByTestId('orch-junction').count()).toBe(0)
    await page.getByTestId('orch-stage-verify').click()
    await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('verify')
  })

  test('总览节点名称按段缩写：放得下是整名，放不下是「首段…末段」（整段整段地留，不切词），完整名在 title，没有名称溢出', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', track: 'frontend', step: ':overview' })
    await expect(page.getByTestId('orchestration-overview')).toBeVisible()
    await expect(page.getByTestId('orch-open-skill-openspec-propose').first()).toBeVisible()
    // 字体加载完会重新量；等名称稳定下来再读。
    await page.waitForTimeout(800)
    const names = await page.getByTestId('orch-name').evaluateAll((spans) => spans.map((span) => ({
      title: span.getAttribute('title') ?? '', shown: span.textContent ?? '', over: span.scrollWidth > span.clientWidth,
    })))
    expect(names.length).toBeGreaterThan(10)
    const shortened = names.filter((name) => name.shown !== name.title)
    // 常见的长名在 208px 的节点里整段放得下：openspec-propose / web-design-guidelines 不再被缩。
    expect(names.find((name) => name.title === 'openspec-propose')?.shown).toBe('openspec-propose')
    // 最长的 finishing-a-development-branch 一定被缩，且缩出来的是整段：头尾都落在分隔符上。
    expect(shortened.map((name) => name.title)).toContain('finishing-a-development-branch')
    for (const name of names) {
      expect(name.over, `${name.title} 溢出`).toBe(false)
      if (name.shown === name.title) continue
      const [head = '', tail = ''] = name.shown.split('…')
      expect(name.title.startsWith(head) && name.title.endsWith(tail), `${name.shown} 不是 ${name.title} 的首尾`).toBe(true)
      expect(/[-:]/.test(name.title[head.length] ?? ''), `${name.shown} 的头不是整段`).toBe(true)
      expect(/[-:]/.test(name.title[name.title.length - tail.length - 1] ?? ''), `${name.shown} 的尾不是整段`).toBe(true)
    }
  })

  test('系统要求减少动态效果时 Signal 静止：没有彗星层，采样只有一种取值，仍有静态高亮', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    await expect(page.getByTestId('orchestration-overview')).toBeVisible()
    await expect(page.getByTestId('orchestration-overview')).toHaveAttribute('data-signal', 'still')
    await expect(page.getByTestId('orch-start')).toBeVisible()
    await page.waitForTimeout(500)
    expect(await page.locator('path[data-signal-layer]').count()).toBe(0)
    expect(new Set(await sampleDashOffsets(page)).size).toBe(1)
  })

  test('Signal 每帧脚本耗时：总览空闲流动 3 秒，脚本时间 / 帧 < 2ms（CDP Performance.getMetrics）', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP 只在 Chromium 上有')
    await openView(page, 'workflow', { wf: 'default', step: ':overview' })
    await expect.poll(() => page.locator(`${CORE}[stroke-dasharray]`).count(), { timeout: 15_000 }).toBeGreaterThan(0)
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    const metric = async (name: string): Promise<number> => ((await session.send('Performance.getMetrics')).metrics.find((item) => item.name === name)?.value ?? 0)
    await page.waitForTimeout(500)
    const before = { script: await metric('ScriptDuration'), style: await metric('RecalcStyleDuration'), layout: await metric('LayoutDuration'), task: await metric('TaskDuration') }
    const frames = await page.evaluate(() => new Promise<number>((resolve) => {
      let count = 0
      const started = performance.now()
      const tick = (): void => { count += 1; if (performance.now() - started < 3_000) requestAnimationFrame(tick); else resolve(count) }
      requestAnimationFrame(tick)
    }))
    const after = { script: await metric('ScriptDuration'), style: await metric('RecalcStyleDuration'), layout: await metric('LayoutDuration'), task: await metric('TaskDuration') }
    const perFrame = (key: 'script' | 'style' | 'layout' | 'task'): number => ((after[key] - before[key]) * 1000) / frames
    const report = `Signal 性能（3s，${frames} 帧）：脚本 ${perFrame('script').toFixed(3)}ms/帧，样式重算 ${perFrame('style').toFixed(3)}ms/帧，布局 ${perFrame('layout').toFixed(3)}ms/帧，主线程任务合计 ${perFrame('task').toFixed(3)}ms/帧`
    testInfo.annotations.push({ type: 'signal-perf', description: report })
    console.info(report)
    expect(frames).toBeGreaterThan(60)
    expect(perFrame('script')).toBeLessThan(2)
  })

  test('中文轨道页签放得下：页签条不滚动，两侧都没有渐隐', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', track: 'backend', step: 'verify' })
    const strip = page.getByTestId('wb-tracks')
    await expect(strip).toBeVisible()
    await expect(page.getByTestId('wb-track-backend')).toHaveAttribute('aria-selected', 'true')
    expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await expect(strip).not.toHaveAttribute('data-fade-start', /.*/)
    await expect(strip).not.toHaveAttribute('data-fade-end', /.*/)
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
