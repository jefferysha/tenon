/**
 * 暗色主题 + 系统要求减少动态效果，同时生效：工作台（任务详情的阶段画布与总览画布）、工作流总览、工作流阶段。
 * 每个页面都要满足三件事：
 *   1. 真的是暗色（页面底色是深色，prefers-color-scheme 为 dark），不是「测了个亮色页面」；
 *   2. Signal 画布处在 still 模式：没有任何在跑的无限动画，彗星层的采样在一段时间里只有一种取值；
 *      评审门拦住的任务留一颗停着的彗星（静态高亮），没有被拦住的画布什么都不画；
 *   3. axe 在这套组合下 serious / critical 为零（a11y.spec.ts 分别测过暗色与默认动效，没测过两者叠加）。
 * 默认动效下 Signal 在流动由 workflow.spec.ts 钉住；这里只证明「减少动态效果」把它真的停住了。
 * 评审门拦着的任务只有总览画布：种子的 `gated` 工作流实现步没有技能 / 智能体，任务详情的阶段画布（stage-skills）因此不渲染；
 * 阶段画布在工作流页里测（没有任务状态，也就没有评审门，still 模式下什么都不画）。
 */
import AxeBuilder from '@axe-core/playwright'
import type { Page } from 'playwright/test'
import { expect, openView, settled, test } from './support/fixtures'
import { reviewChangeName, type ServerState } from './support/server-state'

test.use({ colorScheme: 'dark', contextOptions: { reducedMotion: 'reduce' } })

const LAYER = 'path[data-signal-layer]'
const BLOCKING = new Set(['serious', 'critical'])
/** 以帧数而不是毫秒量「一段时间」：帧不走的页面（被节流）本来就没有在动，用帧数等就不会假通过。 */
const FRAMES = 90

interface Target {
  readonly name: string
  /** 画布的 data-testid。 */
  readonly canvas: 'orchestration-stage' | 'orchestration-overview'
  /** 评审门拦着：Signal 在 still 模式下停一颗彗星。 */
  readonly held: boolean
  readonly open: (page: Page, server: ServerState, browser: string) => Promise<void>
}

/** 打开挂着待批准评审的任务（seed.mjs 的 seedReview：实现步的评审门），不会改动它。 */
async function openHeldTask(page: Page, server: ServerState, browser: string): Promise<void> {
  await openView(page, 'workspace', { root: server.review, change: reviewChangeName('single', browser), step: 'build' })
  await expect(page.getByTestId('review-console')).toBeVisible()
  await page.locator('#task-view-tab-overview').click()
}

const TARGETS: readonly Target[] = [
  {
    name: '工作台 · 评审门拦着的任务 · 总览画布',
    canvas: 'orchestration-overview',
    held: true,
    open: async (page, server, browser) => { await openHeldTask(page, server, browser) },
  },
  {
    name: '工作台 · 没被拦住的任务 · 阶段画布',
    canvas: 'orchestration-stage',
    held: false,
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      await expect(page.getByTestId('task-detail-title')).toBeVisible()
      await expect(page.getByTestId('stage-skills')).toBeVisible()
    },
  },
  {
    name: '工作台 · 没被拦住的任务 · 总览画布',
    canvas: 'orchestration-overview',
    held: false,
    open: async (page, server) => {
      await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
      await expect(page.getByTestId('task-detail-title')).toBeVisible()
      await page.locator('#task-view-tab-overview').click()
    },
  },
  {
    name: '工作流 · 总览',
    canvas: 'orchestration-overview',
    held: false,
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: ':overview' })
      await expect(page.getByTestId('orch-start')).toBeVisible()
    },
  },
  {
    name: '工作流 · 阶段',
    canvas: 'orchestration-stage',
    held: false,
    open: async (page) => {
      await openView(page, 'workflow', { wf: 'default', step: 'build' })
      await expect(page.getByTestId('workflow-nav')).toBeVisible()
    },
  },
]

/** 页面当前画着的东西：无限循环且在跑的动画、可见的彗星组与全部彗星层的 dashoffset。 */
async function signalState(page: Page): Promise<{ looping: string[]; visibleGroups: number; offsets: string }> {
  return page.evaluate(({ layer }) => ({
    looping: document.getAnimations()
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().endTime === Infinity)
      .map((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
        const name = 'animationName' in animation ? String(animation.animationName) : animation.id
        return `${target?.tagName.toLowerCase() ?? 'unknown'}[${target?.getAttribute('data-testid') ?? ''}] ${name}`
      }),
    visibleGroups: document.querySelectorAll('g[data-signal-edge][visibility="visible"]').length,
    offsets: JSON.stringify([...document.querySelectorAll(layer)].map((path) => getComputedStyle(path).strokeDashoffset)),
  }), { layer: LAYER })
}

/** 等 FRAMES 帧（真的画了那么多帧）。 */
async function afterFrames(page: Page): Promise<void> {
  await page.evaluate((frames) => new Promise<void>((resolve) => {
    let left = frames
    const tick = (): void => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }), FRAMES)
}

async function expectDark(page: Page): Promise<void> {
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  // 页面真的画成了深色：body 底色的亮度低。
  const luminance = await page.evaluate(() => {
    const [red = 255, green = 255, blue = 255] = (getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/gu) ?? []).map(Number)
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  })
  expect(luminance, `body 底色亮度 ${luminance} 不像暗色`).toBeLessThan(0.25)
}

for (const target of TARGETS) {
  test.describe(`暗色 + 减少动态效果 · ${target.name}`, () => {
    test('Signal 静止：still 模式、没有在跑的无限动画；被拦住的任务留一颗停着的彗星，没被拦住的什么都不画', async ({ page, server }, testInfo) => {
      await target.open(page, server, testInfo.project.name)
      await expectDark(page)
      const canvas = page.getByTestId(target.canvas)
      await canvas.scrollIntoViewIfNeeded()
      await expect(canvas).toHaveAttribute('data-signal', 'still')
      // 运行时晚一拍才建（路径要量完才画）：被拦住的任务等彗星停下来，没被拦住的等到足够久之后仍然什么都没有。
      if (target.held) await expect.poll(async () => (await signalState(page)).visibleGroups, { timeout: 15_000 }).toBeGreaterThan(0)
      await afterFrames(page)

      const first = await signalState(page)
      await afterFrames(page)
      const second = await signalState(page)
      expect(first.looping, `减少动态效果下仍有无限动画在跑：${first.looping.join(', ')}`).toEqual([])
      expect(second.looping).toEqual([])
      // 停着：两次采样之间一帧都没动过（彗星层的 dashoffset 与可见的组都不变）。
      expect(second.offsets).toBe(first.offsets)
      expect(second.visibleGroups).toBe(first.visibleGroups)
      if (target.held) {
        // 静态高亮：评审门前停着一颗彗星——有可见的边组，每条可见边的四层路径都有 dasharray 与 dashoffset。
        expect(first.visibleGroups).toBeGreaterThan(0)
        const layers = await page.locator('g[data-signal-edge][visibility="visible"]').evaluateAll((groups) => groups.map((group) => ({
          count: group.querySelectorAll('path[data-signal-layer]').length,
          dashed: [...group.querySelectorAll('path[data-signal-layer]')].every((path) => path.hasAttribute('stroke-dasharray') && path.hasAttribute('stroke-dashoffset')),
        })))
        expect(layers.every((layer) => layer.count === 4 && layer.dashed), JSON.stringify(layers)).toBe(true)
      } else {
        expect(first.visibleGroups, '没有评审门拦着时，still 模式不画彗星').toBe(0)
      }
      // 画布本身还在、能读：减少动态效果只是停住流动，不是把画布藏起来。
      await expect(canvas).toBeVisible()
    })

    test('axe：暗色 + 减少动态效果下 serious / critical 为零', async ({ page, server }, testInfo) => {
      await target.open(page, server, testInfo.project.name)
      await expectDark(page)
      await settled(page)
      const results = await new AxeBuilder({ page }).analyze()
      const violations = results.violations
        .filter((violation) => violation.impact !== null && violation.impact !== undefined && BLOCKING.has(violation.impact))
        .map((violation) => {
          const nodes = violation.nodes.slice(0, 6).map((node) => `    ${node.target.join(' ')}  ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`).join('\n')
          return `[${violation.impact}] ${violation.id} ×${violation.nodes.length}: ${violation.help}\n${nodes}`
        })
      expect(violations, `\n${violations.join('\n')}\n`).toEqual([])
    })
  })
}
