import type { Page } from 'playwright/test'
import { expect, openView, settled, test } from './support/fixtures'
import { percentile } from './support/stats'

/**
 * 总览画布的渲染耗时，在真实 Chromium 里量（这类预算不放进 jsdom 单测：jsdom 的渲染耗时在并行与慢 CI 上会飘出数倍，不是产品性能）。
 * 真实的任务页（add-login）把冻结计划里的每个阶段换成 30 个条目——7 阶段 × 30 节点，与单测里纯布局的规模夹具同量级——
 * 然后点「总览」页签，量从点击到全部 210 个节点进了 DOM 之后第一帧画完（布局 + React Flow 渲染 + 一次绘制；编排数据已在内存里）。
 * 在「阶段」与「总览」之间来回切多次取中位数；p95 与最大值只报告。纯布局本身的线性与耗时护栏在 OrchestrationFlow.test.tsx。
 */
const STAGES = 7
const PER_STAGE = 30
const NODE_SELECTOR = '[data-testid="orchestration-overview"] [data-testid^="orch-node-"]'
const ORCHESTRATION_URL = /\/api\/change\/add-login\/orchestration\?/
/** 预热一次（首次挂载与 JIT 不算），再量这么多次。 */
const SAMPLES = 7
/** 中位数预算（毫秒）。 */
const BUDGET_MS = 1_500

interface CanvasRenderMark {
  /** 点击总览页签的时刻。 */
  started: number | null
  /** 全部节点进了 DOM 的时刻。 */
  committed: number | null
  /** 其后的第一帧画完的时刻。 */
  painted: number | null
}

/** 在点击之前布好观察：记下点击时刻，再等全部节点进 DOM，最后等一帧画完（两层 rAF = 上一帧已经绘制）。 */
async function arm(page: Page, count: number): Promise<void> {
  await page.evaluate(({ selector, expected }) => {
    const mark: CanvasRenderMark = { started: null, committed: null, painted: null }
    Object.assign(window, { __canvasRender: mark })
    document.addEventListener('click', () => { mark.started = performance.now() }, { capture: true, once: true })
    const observer = new MutationObserver(() => {
      if (mark.started === null || document.querySelectorAll(selector).length < expected) return
      observer.disconnect()
      mark.committed = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => { mark.painted = performance.now() }))
    })
    observer.observe(document, { childList: true, subtree: true })
  }, { selector: NODE_SELECTOR, expected: count })
}

async function read(page: Page): Promise<{ commit: number; paint: number }> {
  await page.waitForFunction(() => {
    const mark: unknown = Reflect.get(window, '__canvasRender')
    return typeof mark === 'object' && mark !== null && Reflect.get(mark, 'painted') !== null
  }, undefined, { timeout: 30_000 })
  const { started, committed, painted } = await page.evaluate((): CanvasRenderMark => Reflect.get(window, '__canvasRender'))
  if (started === null || committed === null || painted === null) throw new Error('渲染计时没有记全')
  return { commit: committed - started, paint: painted - started }
}

test.describe('总览画布渲染耗时', () => {
  test('7 阶段 × 30 节点：点开总览到全部节点上屏的中位数在预算内（真实 Chromium）', async ({ page, browserName, server }, testInfo) => {
    test.skip(browserName !== 'chromium', '渲染预算只在 Chromium 上量；WebKit 在 CI 上更慢，只作功能覆盖')
    test.setTimeout(120_000)
    const expected = STAGES * PER_STAGE
    // 只换条目：阶段 id / 名称 / 门禁、IO 与状态仍是服务端给的真实计划，页面其余部分不知道它被换过。
    await page.route(ORCHESTRATION_URL, async (route) => {
      const response = await route.fetch()
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || !('stages' in body) || !Array.isArray(body.stages)) throw new Error('编排响应不是预期的形状')
      const stages: unknown[] = body.stages
      if (stages.length !== STAGES) throw new Error(`种子任务应有 ${STAGES} 个阶段，实际 ${stages.length}`)
      await route.fulfill({
        response,
        json: {
          ...body,
          stages: stages.map((stage) => {
            if (typeof stage !== 'object' || stage === null || !('id' in stage) || typeof stage.id !== 'string') throw new Error('阶段不是预期的形状')
            const id = stage.id
            return {
              ...stage,
              entries: Array.from({ length: PER_STAGE }, (_unused, index) => ({
                kind: index < 3 ? 'executor' : index < 20 ? 'skill' : index < 24 ? 'test' : 'reviewer',
                id: `${id}-n${index}`,
                label: `${id}-n${index}`,
                wave: Math.floor(index / 3),
                dependsOn: [],
                required: true,
                source: 'declared',
                status: 'waiting',
              })),
            }
          }),
          returns: [],
          flows: [],
        },
      })
    })
    await openView(page, 'workspace', { root: server.project, change: 'add-login' })
    const overviewTab = page.locator('#task-view-tab-overview')
    const stageTab = page.locator('#task-view-tab-stage')
    await expect(stageTab).toHaveAttribute('aria-selected', 'true')

    const paints: number[] = []
    const commits: number[] = []
    for (let run = 0; run <= SAMPLES; run += 1) {
      await settled(page)
      await arm(page, expected)
      await overviewTab.click()
      const { commit, paint } = await read(page)
      await expect(page.getByTestId('orchestration-overview')).toHaveAttribute('data-nodes', String(expected))
      if (run > 0) {
        paints.push(paint)
        commits.push(commit)
      }
      await stageTab.click()
      await expect(page.getByTestId('orchestration-overview')).toHaveCount(0)
    }
    const median = percentile(paints, 0.5)
    const report = `总览渲染（${expected} 节点，${paints.length} 次）：点击到上屏 中位数 ${median.toFixed(0)}ms，p95 ${percentile(paints, 0.95).toFixed(0)}ms，最大 ${Math.max(...paints).toFixed(0)}ms；点击到 DOM 提交 中位数 ${percentile(commits, 0.5).toFixed(0)}ms；预算 ${BUDGET_MS}ms`
    testInfo.annotations.push({ type: 'canvas-render', description: report })
    console.info(report)
    expect(paints).toHaveLength(SAMPLES)
    expect(median).toBeLessThan(BUDGET_MS)
  })
})
