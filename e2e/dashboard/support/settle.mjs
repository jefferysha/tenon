/**
 * 等页面落定的唯一实现：Dashboard e2e 的 `settled()`（support/fixtures.ts）与文档截图脚本（tools/docs/capture-screenshots.mjs）
 * 共用这一份，两边的判据不会各改各的。写成不依赖 TypeScript 的 ESM，纯 Node 脚本也能直接导入；类型在 settle.d.mts。
 *
 * 落定 = 没有还在跑的有限 CSS 动画 / 过渡 / Web Animations，没有脚本在改元素的外观，而且这样连续 quietFrames 帧。
 * GSAP 的淡入与位移不经过 `document.getAnimations()`，只能看计算样式：每帧给 body 下每个元素记下
 * 不透明度、可见性、transform、宽、高；任何一项在两帧之间变了，就还没落定（GSAP 的 autoAlpha 淡入、x / y 位置补间、
 * 高度 / 宽度补间都落在这几项里）。
 * 对话框与抽屉的进场（淡入 + 位移）、页面切换淡入、向导步骤框 200ms 的高度过渡都是 CSS 动画或过渡；
 * 慢的浏览器（CI 里的 WebKit）上它们要拖得久得多，所以不能按固定时长等。
 * 连续多帧都安静才返回：动画常在提交之后的下一两帧才开始（ResizeObserver 量完高度才触发过渡），一帧安静不算数。
 * 无限循环的 CSS 动画（旋转图标）永远不会结束，它们的目标元素不计入，暂停的也不计。
 * Signal（画布上流动的彗星与节点到达反馈）也是有意的持续动画，但它是 flowSignal.ts 用 rAF 逐帧写属性与内联样式：
 * 热边的 visibility 在冷热之间来回切、到达光晕的不透明度按指数衰减到 0、光环的 transform 逐帧放大，画布在屏幕上时几乎每一帧都有变化，
 * 在慢的 WebKit 上连续三帧安静几乎凑不齐，settled() 就要等满 15 秒超时。所以带 Signal 标记（data-signal-*，见 SIGNAL_LAYER）的元素及其后代
 * 既不计入外观签名，它们身上的 CSS 过渡也不算「还在跑」；标记之外的元素一律照旧计入。
 * 超时抛出仍在变化的东西，便于看是谁没停。帧不走（后台/隐藏页面被节流）时 requestAnimationFrame 里的超时判断
 * 永远不会跑，所以另有一个同样时长的墙钟 setTimeout 兜底，抛同一种报错，不必等 Playwright 的整条用例超时。
 */

/** 连续这么多帧页面都没有变化，才算落定。 */
export const SETTLE_QUIET_FRAMES = 3
export const SETTLE_TIMEOUT_MS = 15_000

/**
 * Signal 运行时（packages/dashboard-app/src/workflow/flowSignal.ts）逐帧改写的元素，由产品自己挂的标记属性圈出：
 * `g[data-signal-edge]`（边：visibility 冷热切换，内含的 path 写 stroke-dashoffset）、`data-signal-flash` / `-port` / `-icon` / `-ring`
 * （节点的到达反馈层：不透明度、颜色、transform）。判据只认这些标记及其后代，不认类名、标签或位置，
 * 所以画布之外的元素（包括挂在画布旁边的、真在做进场动画的）不受影响。
 */
export const SIGNAL_LAYER = '[data-signal-edge], [data-signal-flash], [data-signal-port], [data-signal-icon], [data-signal-ring]'

/**
 * 在页面里跑的判据。它被序列化后送进浏览器，所以必须自包含：不引用模块里的任何东西，也不用 TypeScript 语法。
 */
function settleInPage({ quietFrames, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const inSignal = (element) => element !== null && element.closest(signal) !== null
    const finiteRunning = () => document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running') return false
      const end = animation.effect?.getComputedTiming().endTime
      if (typeof end !== 'number' || !Number.isFinite(end)) return false
      return !inSignal(animation.effect instanceof KeyframeEffect ? animation.effect.target : null)
    })
    const label = (element) => {
      const testId = element.getAttribute('data-testid')
      return `${element.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}`
    }
    const describeAnimation = (animation) => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
      const name = 'animationName' in animation ? String(animation.animationName) : 'transitionProperty' in animation ? String(animation.transitionProperty) : animation.id
      return `${target === null ? 'unknown' : label(target)} ${name}`
    }
    // 每个元素的外观：不透明度、可见性、transform、宽、高；无限循环动画的目标与 Signal 层不算（它们每帧都变）。
    const snapshot = () => {
      const looping = new Set()
      for (const animation of document.getAnimations()) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
        if (target !== null && animation.effect?.getComputedTiming().endTime === Infinity) looping.add(target)
      }
      const elements = []
      const looks = []
      for (const element of document.body.querySelectorAll('*')) {
        if (looping.has(element) || inSignal(element)) continue
        const style = getComputedStyle(element)
        elements.push(element)
        looks.push(`${style.opacity}|${style.visibility}|${style.transform}|${style.width}|${style.height}`)
      }
      return { elements, looks, signature: looks.join(',') }
    }
    // 两帧之间是谁变了：第一个外观不同的元素；元素个数变了就说是节点增减。
    const whoChanged = (before, after) => {
      if (before === null) return 'the page was not observed yet'
      if (before.elements.length !== after.elements.length) return 'elements were added or removed'
      const index = after.looks.findIndex((look, at) => look !== before.looks[at])
      return index < 0 ? 'nothing' : `${label(after.elements[index])} (${before.looks[index]} -> ${after.looks[index]})`
    }
    const started = performance.now()
    let quiet = 0
    let previous = null
    let finished = false
    // 没有有限动画在跑时，超时报错里说的「还在变的东西」：最近一帧里第一个外观变了的元素。
    let idle = '(script-driven style change)'
    const timeoutError = (animating, detail) =>
      new Error(`page did not settle within ${timeoutMs}ms; still animating: ${animating.map(describeAnimation).join(', ') || detail}`)
    const finish = (error) => {
      if (finished) return
      finished = true
      window.clearTimeout(wallClock)
      if (error === undefined) resolve()
      else reject(error)
    }
    // 墙钟兜底：超时判断写在 requestAnimationFrame 的回调里，帧不走（后台/隐藏的页面被节流，或字体一直没就绪导致
    // 第一帧都没排上）它就永远不会触发，只能等 Playwright 的整条用例超时，那条报错说不出是谁卡住了。
    // 它与帧里的超时判断同一时长，所以帧在走时总是它先到：这时说的是最近一帧里谁在变，只有一帧都没跑过才说帧停了。
    const wallClock = window.setTimeout(() => finish(timeoutError(
      finiteRunning(),
      previous === null ? '(no animation frames ran: requestAnimationFrame stalled, the page may be throttled or hidden)' : idle,
    )), timeoutMs)
    const tick = () => {
      if (finished) return
      const animating = finiteRunning()
      const current = snapshot()
      const unchanged = previous !== null && current.signature === previous.signature
      if (!unchanged) idle = `(script-driven style change: ${whoChanged(previous, current)})`
      quiet = animating.length === 0 && unchanged ? quiet + 1 : 0
      previous = current
      if (quiet >= quietFrames) finish()
      else if (performance.now() - started > timeoutMs) finish(timeoutError(animating, idle))
      else requestAnimationFrame(tick)
    }
    document.fonts.ready.then(() => requestAnimationFrame(tick))
  })
}

/** 等 page 落定；超时抛出仍在变化的东西。 */
export async function settlePage(page, { quietFrames = SETTLE_QUIET_FRAMES, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  await page.evaluate(settleInPage, { quietFrames, timeoutMs, signal: SIGNAL_LAYER })
}

/**
 * 「扫描期间有没有新动画开始」的观察，在页面里跑，所以同样必须自包含。mode 'arm'：装上 animationstart / transitionrun 的捕获监听
 * 并清零计数；mode 'check'：摘掉监听。两者都返回 { started: 装上之后开始的动画数, running: 此刻还在跑的有限动画数 }。
 * 事件在下一帧才派发，所以另看此刻还在跑的有限动画：扫描刚结束时才刚开始的动画靠它发现，扫描中途开始又结束的靠事件发现。
 */
function stillWatchInPage({ mode, signal }) {
  const key = '__tenonStillWatch'
  const types = ['animationstart', 'transitionrun']
  const inSignal = (element) => element instanceof Element && element.closest(signal) !== null
  const running = () => document.getAnimations().filter((animation) => {
    if (animation.playState !== 'running') return false
    const end = animation.effect?.getComputedTiming().endTime
    if (typeof end !== 'number' || !Number.isFinite(end)) return false
    return !inSignal(animation.effect instanceof KeyframeEffect ? animation.effect.target : null)
  }).length
  if (mode === 'arm') {
    // Signal 层的元素在这里不算：它们每帧被改写，若带 CSS 过渡就会不停地产生 transitionrun。
    const state = { started: 0, onStart: (event) => { if (!inSignal(event.target)) state.started += 1 } }
    for (const type of types) document.addEventListener(type, state.onStart, true)
    Object.defineProperty(window, key, { value: state, configurable: true })
    return { started: 0, running: running() }
  }
  const state = window[key]
  if (state === undefined) return { started: 0, running: running() }
  for (const type of types) document.removeEventListener(type, state.onStart, true)
  return { started: state.started, running: running() }
}

/**
 * 在「页面全程没有新动画」的条件下做一件事（典型是 axe 扫描：它要几百毫秒，慢机器上更久）。
 * 每一轮：先等落定，布好观察，跑 run，再看这期间有没有动画开始、有没有有限动画还在跑；有就整轮作废、重来。
 * 落定只能看到「此刻」：晚到的快照把某个计数改了（`.count-roll` 淡入 160ms）、或晚到的内容把别的东西推动，都发生在落定之后、
 * 扫描之中，扫描读到的是半透明的文字。作废重扫不改规则、也不排除任何元素。attempts 轮都被打断就抛错，不拿被污染的结果交差。
 */
export async function whileStill(page, run, { attempts = 8 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await settlePage(page)
    const before = await page.evaluate(stillWatchInPage, { mode: 'arm', signal: SIGNAL_LAYER })
    if (before.running === 0) {
      const result = await run()
      const after = await page.evaluate(stillWatchInPage, { mode: 'check', signal: SIGNAL_LAYER })
      if (after.started === 0 && after.running === 0) return result
    } else {
      await page.evaluate(stillWatchInPage, { mode: 'check', signal: SIGNAL_LAYER })
    }
  }
  throw new Error(`the page kept starting new animations: ${attempts} attempts were interrupted before one finished without animation`)
}
