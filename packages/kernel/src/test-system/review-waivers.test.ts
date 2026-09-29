import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REVIEW_WAIVERS_FILE, clearReviewWaiverSelection, readReviewWaiverSelection, writeReviewWaiverSelection,
} from './review-waivers.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenon-review-waivers-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const SELECTION = {
  phase: 'verify',
  event: 'verify-pass',
  requestedAt: '2026-09-29T10:00:00.000Z',
  waivers: [{ key: 'kind:benchmark', reason: '纯文案改动' }, { key: 'covers:spec:auth/登录成功', reason: '手工验收' }],
}

describe('评审请求冻结的豁免清单', () => {
  it('写入后原样读回；清除后读不到', async () => {
    expect(await readReviewWaiverSelection(dir)).toBeUndefined()
    await writeReviewWaiverSelection(dir, SELECTION)
    expect(await readReviewWaiverSelection(dir)).toEqual({ version: 1, ...SELECTION })
    await clearReviewWaiverSelection(dir)
    expect(await readReviewWaiverSelection(dir)).toBeUndefined()
    await expect(clearReviewWaiverSelection(dir)).resolves.toBeUndefined()
  })

  it('形状不对（多键、缺键、坏键名、非 JSON）一律当作没有清单', async () => {
    const bad = [
      '{"version":1,"phase":"verify","event":"e","requestedAt":"t","waivers":[],"extra":1}',
      '{"version":2,"phase":"verify","event":"e","requestedAt":"t","waivers":[]}',
      '{"version":1,"phase":"verify","event":"e","requestedAt":"t","waivers":[{"key":"benchmark","reason":"x"}]}',
      '{"version":1,"phase":"verify","event":"e","requestedAt":"t","waivers":[{"key":"kind:a","reason":""}]}',
      '{"version":1,"phase":"","event":"e","requestedAt":"t","waivers":[]}',
      'not json',
    ]
    for (const body of bad) {
      await writeFile(join(dir, REVIEW_WAIVERS_FILE), body, 'utf8')
      expect(await readReviewWaiverSelection(dir), body).toBeUndefined()
    }
  })
})
