/**
 * 回归锚（v0.1.1 验收）：结论字段与转换管理的状态字段不能被 `tenon set` 自批。
 *
 *   · `pre_verify_review_result=pass` 只能在本步就绪证据（必需测试 / 执行者 / 必需评审者）齐全后写；
 *     置回 pending 永远允许。
 *   · `verify_result` 由 verify-pass / verify-fail 落值；只有出口 guard 点名它为手填结论的步骤
 *     （default 的 pm verify）接受写入，且只接受 guard 要的值、同样要证据。
 *   · `phase_status` / `verified_at` / `updated_at` 与 `phase`、`archived`、`build_sha` 同属转换管理。
 *
 * 零 mock：真临时项目、真 kernel、真测试记录与 agent 台账。
 */
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

let h: Harness

afterEach(async () => {
  if (h) await rm(h.cwd, { recursive: true, force: true })
})

async function init(name: string, track: string): Promise<void> {
  h = await freshHarness()
  expect(await h.run(['init', name, '--track', track, '--preset', 'full']), h.err.join('\n')).toBe(0)
}

async function get(name: string, field: string): Promise<string> {
  expect(await h.run(['get', name, field])).toBe(0)
  return h.out.join('').trim()
}

describe('转换管理的状态字段（D10）', () => {
  test.each([
    ['phase_status', 'done'],
    ['verify_result', 'pass'],
    ['verified_at', '2026-01-01T00:00:00Z'],
    ['updated_at', '2026-01-01T00:00:00Z'],
  ])('open 阶段 set %s 被拒，错误与既有保护字段同一口径', async (field, value) => {
    await init('guarded', 'backend')
    const before = await get('guarded', field)
    expect(await h.run(['set', 'guarded', field, value])).toBe(1)
    expect(h.err.join('\n')).toMatch(new RegExp(`ERROR: 字段 '${field}' 由 tenon transition .*管理，禁止通过 set/set-many/cas 写入`))
    expect(await h.run(['set-many', 'guarded', `${field}=${value}`])).toBe(1)
    expect(await h.run(['cas', 'guarded', field, before, value])).toBe(1)
    expect(await get('guarded', field)).toBe(before)
  })

  test('list 仍显示 open/pending', async () => {
    await init('guarded', 'backend')
    await h.run(['set', 'guarded', 'phase_status', 'done'])
    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join(''))).toMatchObject({
      changes: [{ name: 'guarded', phase: 'open', phase_status: 'pending' }],
    })
  })
})

describe('pre_verify_review_result 绑定本步证据', () => {
  test('backend build：必需测试没过不许置 pass；测试过了才许；pending 永远可写', async () => {
    await init('pv', 'backend')
    await h.seedPhase('pv', 'build')
    expect(await h.run(['set', 'pv', 'pre_verify_review_result', 'pass'])).toBe(1)
    const err = h.err.join('\n')
    expect(err).toContain("字段 'pre_verify_review_result' 是步骤 'build' 的通过结论")
    expect(err).toContain('必需测试 unit 未通过')
    expect(err).toContain('tenon test run pv unit')
    expect(await get('pv', 'pre_verify_review_result')).toBe('pending')
    expect(await h.run(['set-many', 'pv', 'build_mode=direct', 'pre_verify_review_result=pass'])).toBe(1)
    expect(await get('pv', 'build_mode')).toBe('null')

    await h.satisfyStepTests('pv', 'build')
    expect(await h.run(['set', 'pv', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await get('pv', 'pre_verify_review_result')).toBe('pass')
    expect(await h.run(['set', 'pv', 'pre_verify_review_result', 'pending'])).toBe(0)
  })
})

describe('verify_result：只有 pm verify 接受手填，且要证据', () => {
  // default 的 pm verify 没有声明测试或评审者，闸无从核对证据：只收紧到出口要的那个值。
  test('pm verify：只接受出口要的 pass；fail 要走 verify-fail', async () => {
    await init('pmv', 'pm')
    await h.seedPhase('pmv', 'verify')
    expect(await h.run(['set', 'pmv', 'verify_result', 'fail'])).toBe(1)
    expect(h.err.join('\n')).toContain("字段 'verify_result' 在步骤 'verify' 只接受 pass")
    expect(await h.run(['set', 'pmv', 'verify_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await get('pmv', 'verify_result')).toBe('pass')
  })

  test('backend verify：verify_result 由转换落值，不接受手填', async () => {
    await init('bev', 'backend')
    await h.seedPhase('bev', 'verify')
    expect(await h.run(['set', 'bev', 'verify_result', 'pass'])).toBe(1)
    expect(h.err.join('\n')).toContain("字段 'verify_result' 由 tenon transition 管理")
  })
})
