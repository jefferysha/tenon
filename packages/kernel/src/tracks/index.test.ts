/**
 * tracks 子 barrel 公开面存在性断言——防导出面无声缺失。
 * 根 kernel/src/index.ts 不 re-export 本模块（根 barrel 接线属于清单 T 的 R2 阶段，见 GOAL.md），
 * 故消费面就是本 barrel。
 */
import { describe, expect, test } from 'vitest'
import * as tracks from './index.js'

describe('tracks 子 barrel', () => {
  test('导出全部公开 API（函数/常量/错误类）', () => {
    expect(tracks.TRACK_ID_RE).toBeInstanceOf(RegExp)
    expect([...tracks.BUILTIN_TRACK_IDS]).toEqual(['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free'])
    expect(tracks.BUILTIN_TRACK_DEFINITIONS).toHaveLength(7)
    expect(typeof tracks.BUILTIN_ROUTER_PATTERNS.frontend).toBe('string')
    expect(typeof tracks.isBuiltinTrackId).toBe('function')
    expect(typeof tracks.builtinTrack).toBe('function')
    expect(typeof tracks.parseTrackRegistry).toBe('function')
    expect(typeof tracks.validateTrackRegistry).toBe('function')
    expect(typeof tracks.validateTrackConfigStructure).toBe('function')
    expect(tracks.MAX_CUSTOM_TRACKS).toBe(27)
    expect(tracks.MAX_TRACKS).toBe(34)
    expect(typeof tracks.serializeTrackRegistry).toBe('function')
    expect(typeof tracks.loadTrackRegistry).toBe('function')
    expect(typeof tracks.requireTrack).toBe('function')
    expect(typeof tracks.assertWorkflowAllowed).toBe('function')
    expect(typeof tracks.writeTrackRegistry).toBe('function')
    expect(typeof tracks.registryRevision).toBe('function')
    expect(typeof tracks.trackRegistryPath).toBe('function')
    expect(Object.getPrototypeOf(tracks.TrackConfigParseError)).toBe(Error)
    expect(Object.getPrototypeOf(tracks.RegistryRevisionConflictError)).toBe(Error)
    expect(Object.getPrototypeOf(tracks.RegistryCorruptFileError)).toBe(Error)
  })
})
