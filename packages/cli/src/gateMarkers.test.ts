import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { INTERACTION_MARKER_SESSION_PREFIX } from '@tenon/kernel'
import { readGateMarkers } from './gateMarkers.js'

describe('readGateMarkers —— 项目根上的门禁标记（含按会话分文件的交互标记）', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'tenon-gate-markers-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const put = async (name: string, body = 'pipeline-interaction-v2\n', ageS = 0): Promise<void> => {
    const path = join(cwd, name)
    await writeFile(path, body, 'utf8')
    if (ageS > 0) {
      const t = new Date(Date.now() - ageS * 1000)
      await utimes(path, t, t)
    }
  }

  test('没有标记 → 空', async () => {
    expect(await readGateMarkers(cwd)).toEqual([])
  })

  test('单文件的三种标记照旧读出', async () => {
    await put('.pipeline-pending-confirm', 'build\nx\ndemo\n')
    await put('.pipeline-pending-review', 'pipeline-review-v2\n')
    await put('.pipeline-pending-interaction')
    const markers = await readGateMarkers(cwd)
    expect(markers.map((m) => m.kind).sort()).toEqual(['confirm', 'interaction', 'review'])
    expect(markers.find((m) => m.kind === 'confirm')?.raw).toBe('build\nx\ndemo\n')
    expect(markers.find((m) => m.kind === 'interaction')?.file).toBe('.pipeline-pending-interaction')
  })

  test('按会话分文件的交互标记都算 interaction，各带自己的文件名与年龄', async () => {
    await put(`${INTERACTION_MARKER_SESSION_PREFIX}session-a-0001`, 'A\n', 100)
    await put(`${INTERACTION_MARKER_SESSION_PREFIX}session-b-0002`, 'B\n', 1000)
    await put('.pipeline-pending-interaction', 'single\n')
    const markers = await readGateMarkers(cwd)
    expect(markers).toHaveLength(3)
    expect(markers.every((m) => m.kind === 'interaction')).toBe(true)
    const a = markers.find((m) => m.file === `${INTERACTION_MARKER_SESSION_PREFIX}session-a-0001`)
    const b = markers.find((m) => m.file === `${INTERACTION_MARKER_SESSION_PREFIX}session-b-0002`)
    expect(a?.raw).toBe('A\n')
    expect(a?.ageMs).toBeGreaterThanOrEqual(100_000)
    expect(a?.ageMs).toBeLessThan(110_000)
    expect(b?.ageMs).toBeGreaterThanOrEqual(1_000_000)
    expect(markers.find((m) => m.file === '.pipeline-pending-interaction')?.raw).toBe('single\n')
  })

  test('hook 的原子写 / 认领临时文件、非法会话 id、名字相近的别的文件、目录都不是标记', async () => {
    await put(`${INTERACTION_MARKER_SESSION_PREFIX}session-a-0001.tmp.4242`)
    await put(`${INTERACTION_MARKER_SESSION_PREFIX}claim.4242`)
    await put(`${INTERACTION_MARKER_SESSION_PREFIX}has space`)
    await put(`${INTERACTION_MARKER_SESSION_PREFIX}${'a'.repeat(129)}`)
    await put('.pipeline-pending-interaction-notes.md')
    await mkdir(join(cwd, `${INTERACTION_MARKER_SESSION_PREFIX}a-directory`))
    expect(await readGateMarkers(cwd)).toEqual([])
  })

  test('符号链接的分文件不读（不跟随到仓库外）', async () => {
    const outside = join(cwd, 'outside.txt')
    await writeFile(outside, 'secret\n', 'utf8')
    await symlink(outside, join(cwd, `${INTERACTION_MARKER_SESSION_PREFIX}session-link-0003`))
    expect(await readGateMarkers(cwd)).toEqual([])
  })
})
