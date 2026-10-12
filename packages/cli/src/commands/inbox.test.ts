import { describe, expect, test } from 'vitest'
import { GATE_TTL_MS, REVIEW_MARKER_PROTOCOL } from '@tenon/kernel'
import { cmdInbox } from './inbox.js'
import { makeDeps, mockState } from '../test-support.js'

describe('inbox —— 等待人工决策的 change 清单（BACKLOG #9a）', () => {
  const reviewMarker = (phase: string, name: string, requestedAt = '2026-07-06T00:00:00Z'): string => [
    REVIEW_MARKER_PROTOCOL,
    `phase=${phase}`,
    `change=${name}`,
    `requested_at=${requestedAt}`,
    '已请求人工复核',
    '',
  ].join('\n')

  test('空收件箱：友好空态一行，exit 0；--json 输出 {"inbox":[]}', async () => {
    const deps = makeDeps()
    const code = await cmdInbox(deps, {})
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toContain('没有在等你的事')

    const deps2 = makeDeps()
    expect(await cmdInbox(deps2, { json: true })).toBe(0)
    expect(JSON.parse(deps2.outLines.join('\n'))).toEqual({ inbox: [] })
  })

  test('新鲜门 marker：解析三行格式（相位/指引/change 名），列为 gate:<kind>', async () => {
    const deps = makeDeps({
      states: { demo: mockState({ phase: 'build', track: 'backend' }) },
      gateMarkers: [{ kind: 'confirm', ageMs: 120_000, raw: 'build\n请确认原型方向\ndemo\n' }],
    })
    expect(await cmdInbox(deps, { json: true })).toBe(0)
    const payload = JSON.parse(deps.outLines.join('\n')) as {
      inbox: Array<Record<string, unknown>>
    }
    expect(payload.inbox).toEqual([
      { name: 'demo', phase: 'build', waiting_on: 'gate:confirm', waiting_s: 120, hint: '请确认原型方向' },
    ])
  })

  test('陈旧 marker（age > 各自 TTL）不进收件箱', async () => {
    const deps = makeDeps({
      gateMarkers: [
        { kind: 'confirm', ageMs: GATE_TTL_MS.confirm + 1, raw: 'open\nx\nc1\n' },
        { kind: 'review', ageMs: GATE_TTL_MS.review + 1, raw: reviewMarker('spec', 'demo') },
        { kind: 'interaction', ageMs: GATE_TTL_MS.interaction + 1, raw: 'build\nx\ni1\n' },
      ],
    })
    await cmdInbox(deps, { json: true })
    expect(JSON.parse(deps.outLines.join('\n'))).toEqual({ inbox: [] })
  })

  test('门 TTL 分级（BACKLOG #13，对齐老内核）：GATE_TTL_MS = confirm 300s / review·interaction 1800s', () => {
    expect(GATE_TTL_MS).toEqual({ confirm: 300_000, review: 1_800_000, interaction: 1_800_000 })
  })

  test('分级新鲜判定：confirm 301s 陈旧，review/interaction 301s 仍新鲜（含 >15min 区间）', async () => {
    const deps = makeDeps({
      gateMarkers: [
        { kind: 'confirm', ageMs: 301_000, raw: 'open\n请确认\nc1\n' },
        { kind: 'review', ageMs: 301_000, raw: reviewMarker('spec', 'r1') },
        { kind: 'interaction', ageMs: 1_000_000, raw: 'build\n交互\ni1\n' }, // 1000s > 老 15min 统一 TTL
      ],
    })
    expect(await cmdInbox(deps, { json: true })).toBe(0)
    const payload = JSON.parse(deps.outLines.join('\n')) as { inbox: Array<{ name: string; waiting_on: string }> }
    expect(payload.inbox.map((i) => i.waiting_on).sort()).toEqual(['gate:interaction', 'gate:review'])
    expect(payload.inbox.map((i) => i.name).sort()).toEqual(['i1', 'r1'])
  })

  test('TTL 边界：age === TTL 仍新鲜（老内核 fresh 判定为 age > ttl 才陈旧）', async () => {
    const deps = makeDeps({
      gateMarkers: [{ kind: 'confirm', ageMs: GATE_TTL_MS.confirm, raw: 'open\n请确认\nc1\n' }],
    })
    await cmdInbox(deps, { json: true })
    const payload = JSON.parse(deps.outLines.join('\n')) as { inbox: Array<{ waiting_s: number }> }
    expect(payload.inbox).toHaveLength(1)
    expect(payload.inbox[0]?.waiting_s).toBe(300)
  })

  test('canonical pending review receipt 列为 review-request；单纯进入 review phase 不入列', async () => {
    const deps = makeDeps({
      states: {
        r1: mockState({
          phase: 'explore',
          phase_status: 'pending',
          review_gate_phase: 'explore',
          review_gate_status: 'pending',
          review_requested_at: '2026-07-05T23:58:00Z', // FIXED_CLOCK 前 2min
        }),
        unrequested: mockState({ phase: 'verify', phase_status: 'pending' }),
      },
    })
    expect(await cmdInbox(deps, { json: true })).toBe(0)
    const payload = JSON.parse(deps.outLines.join('\n')) as {
      inbox: Array<Record<string, unknown>>
    }
    expect(payload.inbox).toHaveLength(1)
    expect(payload.inbox[0]).toMatchObject({ name: 'r1', phase: 'explore', waiting_on: 'review-request', waiting_s: 120 })
  })

  test('同名 change 的 v2 marker 与 canonical pending receipt 不重复列（marker 优先）', async () => {
    const deps = makeDeps({
      states: {
        r1: mockState({
          phase: 'explore', phase_status: 'pending', review_gate_phase: 'explore',
          review_gate_status: 'pending', review_requested_at: '2026-07-05T23:59:00Z',
        }),
      },
      gateMarkers: [{ kind: 'review', ageMs: 60_000, raw: reviewMarker('explore', 'r1') }],
    })
    await cmdInbox(deps, { json: true })
    const payload = JSON.parse(deps.outLines.join('\n')) as { inbox: Array<{ waiting_on: string }> }
    expect(payload.inbox).toHaveLength(1)
    expect(payload.inbox[0]?.waiting_on).toBe('gate:review')
  })

  test('--html：自足单页（doctype/深浅色/条目/生成时间），零外部资源', async () => {
    const deps = makeDeps({
      states: { demo: mockState({ phase: 'build' }) },
      gateMarkers: [{ kind: 'confirm', ageMs: 120_000, raw: 'build\n请确认原型方向\ndemo\n' }],
    })
    expect(await cmdInbox(deps, { html: true })).toBe(0)
    const html = deps.outLines.join('\n')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('prefers-color-scheme')
    expect(html).toContain('demo')
    expect(html).toContain('gate:confirm')
    expect(html).toContain('请确认原型方向')
    expect(html).toContain('2026-07-06T00:00:00Z')
    expect(html).not.toMatch(/src=|href=|@import|fetch\(/)
  })

  test('--html：内容经 HTML 转义（marker 注入不破页面）', async () => {
    const deps = makeDeps({
      gateMarkers: [{ kind: 'confirm', ageMs: 1000, raw: 'spec\n<script>alert(1)</script>\nx\n' }],
    })
    await cmdInbox(deps, { html: true })
    const html = deps.outLines.join('\n')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  test('--html 空收件箱：页面含空态文案', async () => {
    const deps = makeDeps()
    await cmdInbox(deps, { html: true })
    expect(deps.outLines.join('\n')).toContain('没有在等你的事')
  })

  test('archived change 不进收件箱；人读输出含 change 名与等待时长', async () => {
    const deps = makeDeps({
      states: {
        gone: mockState({ phase: 'explore', phase_status: 'pending', archived: 'true' }),
        r1: mockState({
          phase: 'verify', phase_status: 'pending', updated_at: '2026-07-05T23:00:00Z',
          review_gate_phase: 'verify', review_gate_status: 'pending', review_requested_at: '2026-07-05T23:00:00Z',
        }),
      },
    })
    expect(await cmdInbox(deps, {})).toBe(0)
    const text = deps.outLines.join('\n')
    expect(text).toContain('r1')
    expect(text).not.toContain('gone')
    expect(text).toContain('1h')
  })
})
