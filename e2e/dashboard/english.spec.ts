/**
 * 英文界面：内置工作流数据（出厂阶段名、轨道名、测试方向名）显示英文，表格里的内置词不被截断，汇总计数词是正确的名词。
 * 种子项目用的是出厂 default 工作流，所以阶段 / 轨道 / 测试项名都还是出厂中文名。
 */
import type { Locator, Page } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'

test.use({ locale: 'en-US' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('tenon-dashboard-lang', 'en') } catch { /* 无存储时按默认语言 */ } })
})

/** 文字没有被截断：内容宽度不超过格子宽度。 */
async function fits(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
}

async function openTests(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId('task-io-tab-tests').click()
    await expect(page.getByTestId('task-tests')).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 20_000 })
}

test.describe('英文界面 · 内置工作流数据', () => {
  test('工作台：任务卡状态与阶段轨显示英文阶段名', async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
    await expect(page.getByTestId('task-card-add-login')).toContainText('Open · 5 blocked')
    const rail = page.getByTestId('stage-rail')
    for (const [id, label] of [['open', 'Open'], ['explore', 'Explore'], ['spec', 'Spec'], ['build', 'Build'], ['verify', 'Verify'], ['ship', 'Ship'], ['archive', 'Done']] as const) {
      await expect(rail.getByTestId(`stage-rail-${id}`)).toHaveText(label)
    }
    await expect(page.getByTestId('task-card-add-login')).not.toContainText('立项')
  })

  test('工作流：左栏阶段、轨道页签、总览与阶段画布（含出厂测试项）显示英文', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', track: 'backend', step: 'verify' })
    await expect(page.getByTestId('wb-step-open')).toContainText('Open')
    await expect(page.getByTestId('wb-step-verify')).toContainText('Verify')
    for (const [id, label] of [['chat', 'Chat'], ['pm', 'Product'], ['frontend', 'Frontend'], ['backend', 'Backend'], ['free', 'Free']] as const) {
      await expect(page.getByTestId(`wb-track-${id}`)).toHaveText(label)
    }
    // 阶段画布里的出厂测试项（代码规模）。
    await expect(page.getByTestId('orch-node-test-code-size')).toContainText('Code size')
    // 阶段标题（编辑框）与左栏显示同一个名字。
    await expect(page.getByTestId('wb-lane-name-input-verify')).toHaveValue('Verify')
    await expect(page.getByTestId('wb-lane-name-verify')).toHaveText('Verify')

    await openView(page, 'workflow', { wf: 'default', track: 'backend', step: ':overview' })
    await expect(page.getByTestId('orch-stage-open')).toContainText('Open')
    await expect(page.getByTestId('orch-stage-archive')).toContainText('Done')
    await expect(page.getByTestId('orch-node-test-code-size')).toContainText('Code size')
    await expect(page.getByTestId('workflow-overview-pane')).not.toContainText('立项')
  })
})

/** 页签条与其中一个页签的几何（视口坐标）、渐隐状态和 CSS 里实际生效的渐隐宽度。 */
interface TabStripState {
  stripLeft: number
  stripRight: number
  tabLeft: number
  tabRight: number
  textFits: boolean
  overflowing: boolean
  fadeStart: boolean
  fadeEnd: boolean
  /** scroll-padding-inline-start：与渐隐同宽，页签滚进来后不会停在渐隐下面。 */
  padding: number
  fadeStartWidth: number
  fadeEndWidth: number
  masked: boolean
}

async function tabStripState(page: Page, track: string): Promise<TabStripState> {
  return page.getByTestId('wb-tracks').evaluate((strip, id) => {
    const tab = strip.querySelector(`[data-testid="wb-track-${id}"]`)
    if (tab === null) throw new Error(`没有页签 ${id}`)
    const stripBox = strip.getBoundingClientRect()
    const tabBox = tab.getBoundingClientRect()
    const style = getComputedStyle(strip)
    const mask = style.maskImage || style.getPropertyValue('-webkit-mask-image')
    return {
      stripLeft: stripBox.left,
      stripRight: stripBox.right,
      tabLeft: tabBox.left,
      tabRight: tabBox.right,
      textFits: tab.scrollWidth <= tab.clientWidth + 1,
      overflowing: strip.scrollWidth > strip.clientWidth + 1,
      fadeStart: strip.hasAttribute('data-fade-start'),
      fadeEnd: strip.hasAttribute('data-fade-end'),
      padding: Number.parseFloat(style.scrollPaddingInlineStart),
      fadeStartWidth: Number.parseFloat(style.getPropertyValue('--fade-start')),
      fadeEndWidth: Number.parseFloat(style.getPropertyValue('--fade-end')),
      masked: mask.includes('linear-gradient'),
    }
  }, track)
}

/** 这个页签完整落在页签条的可见范围里，并且不在渐隐下面（渐隐那一侧要留出 scroll-padding）；条外的「+」不被条挡住。 */
async function expectTabRevealed(page: Page, track: string): Promise<TabStripState> {
  await expect(async () => {
    const state = await tabStripState(page, track)
    const left = state.stripLeft + (state.fadeStart ? state.padding : 0)
    const right = state.stripRight - (state.fadeEnd ? state.padding : 0)
    expect(state.tabLeft, `${track} 的左边缘在可见范围内`).toBeGreaterThanOrEqual(left - 0.5)
    expect(state.tabRight, `${track} 的右边缘在可见范围内`).toBeLessThanOrEqual(right + 0.5)
    expect(state.textFits, `${track} 的名称没有被截断`).toBe(true)
  }).toPass({ timeout: 5_000 })
  const state = await tabStripState(page, track)
  const plus = await page.getByTestId('wb-track-new').boundingBox()
  if (plus === null) throw new Error('新建轨道的 + 不可见')
  expect(state.stripRight, '页签条不压住 +').toBeLessThanOrEqual(plus.x + 0.5)
  return state
}

/**
 * 键盘焦点环：至少 2px、强调色、画在页签框里面（inset），整圈都落在页签条的可见范围内。
 * 页签条是 overflow 容器：外圈的环会被它裁掉，只剩页签左右两道细边；inset 环的外缘就是页签框，页签框在条里，环就整圈可见。
 * 环底边在下划线之上（下划线是页签的 2px 下边框，条本身又裁掉最下面 1px），所以底边按「页签底 - 下边框」算。
 */
async function expectFocusRingInsideStrip(page: Page, track: string): Promise<void> {
  const tab = page.getByTestId(`wb-track-${track}`)
  await expect(tab).toBeFocused()
  const ring = await tab.evaluate((element) => {
    const strip = element.parentElement
    if (strip === null) throw new Error('页签不在页签条里')
    const style = getComputedStyle(element)
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    document.body.append(probe)
    const accent = getComputedStyle(probe).color
    probe.remove()
    // box-shadow 是逗号分隔的多层（偏移 / 外圈 / 内圈 / 环……）：取扩展半径非零的那一层。
    const layers = style.boxShadow.split(/,(?![^(]*\))/u).map((layer) => layer.trim())
    const layer = layers.map((text) => /^(rgba?\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px(\s+inset)?$/u.exec(text)).find((match) => match !== null && Number(match[2]) > 0)
    const tabBox = element.getBoundingClientRect()
    const stripBox = strip.getBoundingClientRect()
    return {
      found: layer !== undefined && layer !== null,
      color: layer?.[1] ?? '',
      spread: Number(layer?.[2] ?? 0),
      inset: layer?.[3] !== undefined,
      accent,
      focusVisible: element.matches(':focus-visible'),
      left: tabBox.left - stripBox.left,
      right: stripBox.right - tabBox.right,
      top: tabBox.top - stripBox.top,
      bottom: stripBox.bottom - (tabBox.bottom - Number.parseFloat(style.borderBottomWidth)),
    }
  })
  expect(ring.focusVisible, `${track} 的焦点是键盘焦点`).toBe(true)
  expect(ring.found, `${track} 画出了焦点环`).toBe(true)
  expect(ring.spread, `${track} 的焦点环至少 2px`).toBeGreaterThanOrEqual(2)
  expect(ring.color, `${track} 的焦点环是强调色`).toBe(ring.accent)
  expect(ring.inset, `${track} 的焦点环画在页签框里面`).toBe(true)
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    expect(ring[side], `${track} 焦点环的${side}边没有被页签条裁掉`).toBeGreaterThanOrEqual(-0.5)
  }
}

test.describe('英文界面 · 轨道页签条', () => {
  test('300px 的左栏放不下五个英文页签：选中的页签完整可见，被藏起来的那一侧渐隐，「+」始终在条外', async ({ page }) => {
    for (const track of ['chat', 'pm', 'frontend', 'backend', 'free']) {
      await openView(page, 'workflow', { wf: 'default', track, step: 'verify' })
      await expect(page.getByTestId(`wb-track-${track}`)).toHaveAttribute('aria-selected', 'true')
      const state = await expectTabRevealed(page, track)
      expect(state.overflowing, '前提：英文五个页签确实放不下').toBe(true)
    }
    // 第一个：左边没有隐藏内容、右边有；最后一个反过来。渐隐真的画出来了：mask 生效，
    // 宽度变量跟着状态走（有 140ms 过渡，所以轮询），没有隐藏内容的那一侧宽度为 0。
    await openView(page, 'workflow', { wf: 'default', track: 'chat', step: 'verify' })
    await expect(async () => {
      const chat = await tabStripState(page, 'chat')
      expect([chat.fadeStart, chat.fadeEnd]).toEqual([false, true])
      expect(chat.masked).toBe(true)
      expect(chat.padding).toBe(24)
      expect([chat.fadeStartWidth, chat.fadeEndWidth]).toEqual([0, 24])
    }).toPass({ timeout: 5_000 })
    await openView(page, 'workflow', { wf: 'default', track: 'free', step: 'verify' })
    await expect(async () => {
      const free = await tabStripState(page, 'free')
      expect([free.fadeStart, free.fadeEnd]).toEqual([true, false])
      expect([free.fadeStartWidth, free.fadeEndWidth]).toEqual([24, 0])
    }).toPass({ timeout: 5_000 })
  })

  // 焦点用 focus() 逐个移过去：macOS 的 WebKit 默认 Tab 不停在按钮上，按键本身是浏览器的事；这里验的是焦点落到哪个页签、哪个页签就被滚进来。
  test('焦点逐个越过页签：每个获得焦点的页签都完整可见；滚动后渐隐的两侧跟着变', async ({ page }) => {
    await openView(page, 'workflow', { wf: 'default', track: 'chat', step: 'verify' })
    // 先有一次键盘操作：之后脚本移动焦点都按键盘焦点算（:focus-visible），焦点环才会画出来。
    await page.keyboard.press('Shift')
    await page.getByTestId('wb-track-chat').focus()
    await expectTabRevealed(page, 'chat')
    await expectFocusRingInsideStrip(page, 'chat')
    for (const track of ['pm', 'frontend', 'backend', 'free']) {
      await page.getByTestId(`wb-track-${track}`).focus()
      await expect(page.getByTestId(`wb-track-${track}`)).toBeFocused()
      await expectTabRevealed(page, track)
      await expectFocusRingInsideStrip(page, track)
    }
    await expect(async () => expect((await tabStripState(page, 'free')).fadeEnd, '焦点到了最后一个：右边没有隐藏内容').toBe(false)).toPass({ timeout: 5_000 })
    for (const track of ['backend', 'frontend', 'pm', 'chat']) {
      await page.getByTestId(`wb-track-${track}`).focus()
      await expect(page.getByTestId(`wb-track-${track}`)).toBeFocused()
      await expectTabRevealed(page, track)
      await expectFocusRingInsideStrip(page, track)
    }
    await expect(async () => expect((await tabStripState(page, 'chat')).fadeStart, '焦点回到第一个：左边没有隐藏内容').toBe(false)).toPass({ timeout: 5_000 })
  })
})

test.describe('英文界面 · 测试页签', () => {
  test.beforeEach(async ({ page, server }) => {
    await openView(page, 'workspace', { root: server.project, change: 'add-login', step: 'verify' })
    await openTests(page)
  })

  test('汇总的计数词：Suites / Cases / Failed / Flaky', async ({ page }) => {
    await expect(page.getByTestId('tests-stat-suite')).toHaveText('3Suites')
    await expect(page.getByTestId('tests-stat-case')).toHaveText('2Cases')
    await expect(page.getByTestId('tests-stat-fail')).toHaveText('1Failed')
    await expect(page.getByTestId('tests-stat-flaky')).toHaveText('0Flaky')
  })

  test('策略表：内置种类名、要求、结果和短标签都完整可见，不被截成 Integr…', async ({ page }) => {
    const matrix = page.getByTestId('tests-matrix')
    await expect(matrix).toBeVisible()
    for (const kind of ['unit', 'integration', 'e2e', 'benchmark', 'code-size']) {
      const row = page.getByTestId(`tests-kind-${kind}`)
      await expect(row).toBeVisible()
      expect(await fits(row.getByTestId(`tests-kind-label-${kind}`).locator('span').last()), `${kind} 种类名`).toBe(true)
      expect(await fits(row.getByTestId(`tests-requirement-${kind}`)), `${kind} 要求`).toBe(true)
    }
    await expect(page.getByTestId('tests-kind-label-integration')).toHaveText('Integration')
    await expect(page.getByTestId('tests-kind-label-e2e')).toHaveText('End-to-end')
    await expect(page.getByTestId('tests-kind-label-benchmark')).toHaveText('Benchmark')
    await expect(page.getByTestId('tests-requirement-benchmark')).toHaveText('If registered')
    expect(await fits(page.getByTestId('tests-blocker-label-integration')), '缺项短标签').toBe(true)
    // 出厂测试项名（代码规模）也是英文。
    await expect(page.getByTestId('tests-suite-step:code-size')).toHaveText('Code size')
  })

  test('完整性与阻塞表：信号名、明细、短标签完整可见；对象先让位', async ({ page }) => {
    const row = page.getByTestId('tests-integrity-row')
    await expect(row.getByTestId('tests-integrity-signal')).toHaveText('Coverage threshold lowered')
    expect(await fits(row.getByTestId('tests-integrity-signal'))).toBe(true)
    const detail = row.getByRole('cell').nth(2)
    await expect(detail).toHaveText('lines 80 → 60')
    expect(await fits(detail)).toBe(true)
    for (const label of await page.getByTestId('tests-blocker-code').all()) expect(await fits(label)).toBe(true)
  })
})
