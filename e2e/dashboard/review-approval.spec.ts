/**
 * 评审批准的「人在场」：在 Dashboard 里批准一个挂起的评审要两次点击，第二次点击才向服务要一次性 nonce 并提交；
 * 一次点击、过期或已用过的 nonce 都批准不了。真实浏览器点真实页面、打真实服务，种子是 seed.mjs 的 seedReview
 * （项目级工作流 `gated`，实现步挂评审门，经 `tenon review request` 挂起）。
 *
 * 服务端的 nonce 规则（过期、单次使用、绑定会话 / 任务 / 评审 / 修订号）由 packages/server 的
 * serverReviewPresence.integration.test.ts 与 serverSession.test.ts 逐条钉住；组件的两次点击由
 * ReviewDecisionPanel.test.tsx 钉住。这里证明它们在真实页面里接在一起：每个结论都用服务端自己的待决策视图核对，不看页面自述。
 * nonce 的 30 秒时效不在这里等：那要睡 30 秒，且服务端有用可推进的时钟的单测；这里用「已被用掉的 nonce」代表失效的 nonce。
 *
 * 批准会真的改写任务，所以每个浏览器项目、每个用例各有自己的任务（reviewChangeName）。
 */
import type { Page } from 'playwright/test'
import { expect, openView, test } from './support/fixtures'
import { reviewChangeName, type ReviewKind, type ServerState } from './support/server-state'

const DECISIONS = /\/api\/change\/[^/]+\/decisions$/
const PRESENCE = /\/api\/change\/[^/]+\/decisions\/presence$/

/** 页面发出的评审决策类写请求，按发出顺序。 */
function trackWrites(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = new URL(request.url()).pathname
    if (PRESENCE.test(path)) seen.push('presence')
    else if (DECISIONS.test(path)) seen.push('decisions')
  })
  return seen
}

/** 服务端自己的待决策视图里，这个任务还挂着几个待批准的评审。 */
async function pendingReviews(page: Page, server: ServerState, change: string): Promise<number> {
  const response = await page.request.get(`/api/change/${encodeURIComponent(change)}/pending-decisions?root=${encodeURIComponent(server.review)}`)
  expect(response.status()).toBe(200)
  const view = await response.json() as { items: Array<{ type: string; status: string }> }
  return view.items.filter((item) => item.type === 'review' && item.status === 'pending').length
}

async function openReview(page: Page, server: ServerState, kind: ReviewKind, browser: string): Promise<string> {
  const change = reviewChangeName(kind, browser)
  await openView(page, 'workspace', { root: server.review, change, step: 'build' })
  await expect(page.getByTestId('review-console')).toBeVisible()
  await expect(page.getByTestId('review-console-approve')).toBeEnabled()
  return change
}

/** 人做的事：点「通过」，再点「确认批准」。返回这次真的发出去的 nonce（页面从服务端换来的那一个）。 */
async function approveLikeAPerson(page: Page): Promise<string> {
  await page.getByTestId('review-console-approve').click()
  await expect(page.getByTestId('review-console-confirm-box')).toBeVisible()
  const issued = page.waitForResponse((response) => PRESENCE.test(new URL(response.url()).pathname))
  const submitted = page.waitForRequest((request) => request.method() === 'POST' && DECISIONS.test(new URL(request.url()).pathname))
  await page.getByTestId('review-console-confirm').click()
  const nonce = ((await (await issued).json()) as { nonce: string }).nonce
  expect(nonce).not.toBe('')
  expect((await submitted).headers()['x-tenon-presence']).toBe(nonce)
  return nonce
}

test.describe('评审批准：人在场', () => {
  test('只点一次「通过」不批准：只弹出确认框，没有任何写请求，取消或回车（焦点在取消上）都退回，评审仍挂着', async ({ page, server }, testInfo) => {
    const writes = trackWrites(page)
    const change = await openReview(page, server, 'single', testInfo.project.name)

    await page.getByTestId('review-console-approve').click()
    await expect(page.getByTestId('review-console-confirm-box')).toBeVisible()
    // 安全的选项先拿焦点；「通过」在确认期间停用，不会被连点。
    await expect(page.getByTestId('review-console-cancel')).toBeFocused()
    await expect(page.getByTestId('review-console-approve')).toBeDisabled()
    expect(writes, '第一次点击只问，不向服务要 nonce').toEqual([])
    expect(await pendingReviews(page, server, change)).toBe(1)

    // 键盘：焦点在取消上，回车是取消，不是批准。
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('review-console-confirm-box')).toHaveCount(0)
    await expect(page.getByTestId('review-console-approve')).toBeEnabled()
    expect(writes).toEqual([])

    // 再问一次、点取消：同样什么都没发生。
    await page.getByTestId('review-console-approve').click()
    await page.getByTestId('review-console-cancel').click()
    await expect(page.getByTestId('review-console-confirm-box')).toHaveCount(0)
    expect(writes).toEqual([])
    expect(await pendingReviews(page, server, change)).toBe(1)

    // 刷新页面也不会带着「已确认」的状态回来：确认只存在于这一次点击里。
    await page.reload()
    await expect(page.getByTestId('review-console')).toBeVisible()
    await expect(page.getByTestId('review-console-confirm-box')).toHaveCount(0)
    expect(await pendingReviews(page, server, change)).toBe(1)
  })

  test('两次点击批准：先要 nonce、再带着它提交，服务端的待决策视图清空，面板消失', async ({ page, server }, testInfo) => {
    const writes = trackWrites(page)
    const change = await openReview(page, server, 'approve', testInfo.project.name)
    expect(await pendingReviews(page, server, change)).toBe(1)

    const decided = page.waitForResponse((response) => DECISIONS.test(new URL(response.url()).pathname))
    await approveLikeAPerson(page)
    const response = await decided
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, code: 'approved', channel: 'dashboard' })

    // 顺序：确认之前没有任何写请求，之后先 presence 再 decisions，且各一次。
    expect(writes).toEqual(['presence', 'decisions'])
    await expect(page.getByTestId('review-console')).toHaveCount(0)
    await expect.poll(() => pendingReviews(page, server, change)).toBe(0)
  })

  test('过期 / 已用过的 nonce 批准不了：换成一个刚被用掉的 nonce，服务端 403 presence-required，评审仍挂着，页面提示重新确认', async ({ page, server }, testInfo) => {
    // 先在另一个任务上走一遍真实的批准，拿到一个已经被消耗掉的 nonce。
    await openReview(page, server, 'spent', testInfo.project.name)
    const spent = await approveLikeAPerson(page)
    await expect(page.getByTestId('review-console')).toHaveCount(0)

    // 在这个任务上，把页面真实申请到的 nonce 在提交时换成已用掉的那个：服务端必须拒绝。
    const change = await openReview(page, server, 'stale', testInfo.project.name)
    await page.route(DECISIONS, async (route) => {
      await route.continue({ headers: { ...route.request().headers(), 'x-tenon-presence': spent } })
    })
    const decided = page.waitForResponse((response) => DECISIONS.test(new URL(response.url()).pathname))
    await page.getByTestId('review-console-approve').click()
    await page.getByTestId('review-console-confirm').click()
    const response = await decided
    expect(response.status()).toBe(403)
    expect(await response.json()).toMatchObject({ ok: false, code: 'presence-required' })

    await expect(page.getByTestId('review-console-submit-error')).toContainText('需要你在页面上亲自确认')
    await expect(page.getByTestId('review-console')).toBeVisible()
    expect(await pendingReviews(page, server, change)).toBe(1)

    // 同一个页面里回到真实的 nonce：重新点击批准并确认就能批准——被拒的不是这个人，是那个失效的 nonce。
    await page.unroute(DECISIONS)
    await approveLikeAPerson(page)
    await expect.poll(() => pendingReviews(page, server, change)).toBe(0)
  })
})
