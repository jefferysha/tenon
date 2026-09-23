/**
 * 回归锚（v0.1.1 验收 D21 / #6）：已完结的 change 在 status / check / list 里口径一致。
 *
 * 真机：`openspec archive` 把目录搬进 archive/ 之后，`tenon check` 按归档前路径报 11 个 FAIL、
 * exit 2；`tenon status <c> --json` 仍把它列在 active_changes、step 为 null。`transition archived`
 * 之后、`openspec archive` 之前，`list --finished` 已显示它而 status 仍把它当活跃。
 *
 * 完结由状态机的 `archived` 转换落值；这里用 kernel store 白盒置位（harness.seedArtifact 走的就是
 * store.set），目录搬移照 `openspec archive` 的布局做——主题是展示口径，不是转换本身。
 */
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'finished'
let h: Harness

beforeEach(async () => {
  h = await freshHarness()
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
  await h.seedPhase(CHANGE, 'archive')
  await h.seedArtifact(CHANGE, 'archived', 'true')
  await h.seedArtifact(CHANGE, 'archived_at', '2026-09-20T00:00:00Z')
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

async function moveToArchive(): Promise<void> {
  const root = join(h.cwd, 'openspec', 'changes')
  await mkdir(join(root, 'archive'), { recursive: true })
  await rename(join(root, CHANGE), join(root, 'archive', `2026-09-20-${CHANGE}`))
}

interface StatusJson {
  readonly active_changes: readonly { readonly name: string }[]
  readonly finished_changes?: readonly { readonly name: string; readonly archived_at: string }[]
  readonly step?: { readonly next: readonly { readonly action: string }[] }
}

async function statusOf(): Promise<StatusJson> {
  expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  return JSON.parse(h.out.join('\n')) as StatusJson
}

async function finishedNames(): Promise<readonly string[]> {
  expect(await h.run(['list', '--finished', '--json'])).toBe(0)
  return (JSON.parse(h.out.join('\n')) as { finished: readonly { name: string }[] }).finished.map((row) => row.name)
}

describe('已完结的 change：status / check / list 同一口径', () => {
  test('transition archived 之后、openspec archive 之前：不在 active_changes，next 是 finish-change', async () => {
    const status = await statusOf()
    expect(status.active_changes).toEqual([])
    expect(status.finished_changes).toEqual([expect.objectContaining({ name: CHANGE, archived_at: '2026-09-20T00:00:00Z' })])
    expect(status.step?.next.map((action) => action.action)).toEqual(['finish-change'])
    expect(await finishedNames()).toEqual([CHANGE])
    expect(await h.run(['status', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toEqual({ active_changes: [] })
    expect(await h.run(['check', CHANGE])).toBe(0)
    expect(h.out.join('\n')).toBe(`change '${CHANGE}' 已完结（已归档），无需检查`)
  })

  test('openspec archive 搬走目录之后：check 不再报 FAIL，status 不再当它活跃', async () => {
    await moveToArchive()
    expect(await h.run(['check', CHANGE])).toBe(0)
    expect(h.out.join('\n')).toBe(`change '${CHANGE}' 已完结（已归档），无需检查`)
    expect(h.out.join('\n')).not.toContain('FAIL')
    const status = await statusOf()
    expect(status.active_changes).toEqual([])
    expect(status.finished_changes?.map((row) => row.name)).toEqual([CHANGE])
    expect(status.step).toBeUndefined()
    expect(await finishedNames()).toEqual([CHANGE])
  })
})
