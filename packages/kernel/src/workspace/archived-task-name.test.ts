import { describe, expect, it } from 'vitest'
import { archiveDirIsTask } from './archived-task-name.js'

describe('archiveDirIsTask：归档目录名 <日期>-<任务名>[-N] 是否属于某个任务', () => {
  it.each([
    ['2026-10-01-api', 'api'],
    ['2026-10-01-api-2', 'api'],
    ['2026-10-01-api-12', 'api'],
    ['2026-10-01-release-2', 'release-2'],
    ['2026-10-01-release-2-3', 'release-2'],
    ['2026-10-01-release-2', 'release'],
    ['2026-10-01-a.c', 'a.c'],
  ])('%s 属于 %s', (dirName, dep) => {
    expect(archiveDirIsTask(dirName, dep)).toBe(true)
  })

  it.each([
    ['2026-10-01-new-api', 'api'],
    ['2026-10-01-legacy_api', 'api'],
    ['2026-10-01-api-gateway-2', 'api'],
    ['2026-10-01-api-v2', 'api'],
    ['2026-10-01-api-', 'api'],
    ['2026-10-01-release', 'release-2'],
    ['2026-10-01-v3-4', 'v3-4-5'],
    ['2026-10-01-v3-4', 'v3-5'],
    ['2026-10-01-abc', 'a.c'],
    ['2026-10-01-abc', '.*'],
    ['2026-10-01-a+', 'a'],
  ])('%s 不属于 %s', (dirName, dep) => {
    expect(archiveDirIsTask(dirName, dep)).toBe(false)
  })

  it.each(['api', 'x-api', '2026-10-1-api', '26-10-01-api', '2026-10-01_api', 'before-2026-10-01-api', ' 2026-10-01-api'])(
    '没有「四位年-两位月-两位日-」前缀的 %j 不是任务归档',
    (dirName) => {
      expect(archiveDirIsTask(dirName, 'api')).toBe(false)
    },
  )

  it('空依赖名与只有日期前缀的目录名都不匹配', () => {
    expect(archiveDirIsTask('2026-10-01-', '')).toBe(false)
    expect(archiveDirIsTask('2026-10-01-api', '')).toBe(false)
    expect(archiveDirIsTask('2026-10-01-', 'api')).toBe(false)
  })
})
