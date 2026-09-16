import { describe, expect, test } from 'vitest'
import type { PipelineState } from '@tenon/kernel'
import { cmdList, cmdStatus } from './status.js'
import { makeDeps, mockState, spy } from '../test-support.js'

const stateA = mockState({
  track: 'backend',
  phase: 'build',
  phase_status: 'in_progress',
  verify_result: 'pending',
  assignee: 'Jeff Sha <jeff@x.io>',
  updated_at: '2026-07-06T00:00:00Z',
})
const stateB = mockState({
  track: 'pm',
  phase: 'explore',
  phase_status: 'pending',
  assignee: 'null',
  updated_at: '2026-07-05T00:00:00Z',
})
const stateArchived = mockState({
  track: 'chat',
  phase: 'archive',
  phase_status: 'done',
  archived: 'true',
  updated_at: '2026-07-01T00:00:00Z',
})

describe('status --json —— schema 稳定（CONTRACT §3）', () => {
  test('全量：active_changes 数组，键序固定，排除 archived，按名排序', async () => {
    const deps = makeDeps({ states: { 'demo-b': stateB, 'demo-a': stateA, 'old-x': stateArchived } })
    const code = await cmdStatus(deps, undefined, { json: true })
    expect(code).toBe(0)
    expect(deps.outLines).toHaveLength(1)
    expect(JSON.parse(deps.outLines[0]!)).toEqual({
      active_changes: [
        {
          name: 'demo-a',
          track: 'backend',
          phase: 'build',
          phase_status: 'in_progress',
          verify_result: 'pending',
          updated_at: '2026-07-06T00:00:00Z',
        },
        {
          name: 'demo-b',
          track: 'pm',
          phase: 'explore',
          phase_status: 'pending',
          verify_result: '',
          updated_at: '2026-07-05T00:00:00Z',
        },
      ],
    })
  })

  test('键序逐字稳定（schema 锚）', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    await cmdStatus(deps, undefined, { json: true })
    expect(deps.outLines[0]).toBe(
      '{"active_changes":[{"name":"demo-a","track":"backend","phase":"build",'
      + '"phase_status":"in_progress","verify_result":"pending","updated_at":"2026-07-06T00:00:00Z"}]}',
    )
  })

  test('指定 name：同 envelope、单元素（含 archived 也返回）', async () => {
    const deps = makeDeps({ states: { 'old-x': stateArchived } })
    const code = await cmdStatus(deps, 'old-x', { json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(deps.outLines[0]!) as { active_changes: Array<{ name: string }> }
    expect(parsed.active_changes).toHaveLength(1)
    expect(parsed.active_changes[0]?.name).toBe('old-x')
  })

  test('空项目：active_changes 为空数组，exit 0', async () => {
    const deps = makeDeps({ changes: [] })
    const code = await cmdStatus(deps, undefined, { json: true })
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['{"active_changes":[]}'])
  })
})

describe('status —— 人读渲染（对齐宽度）', () => {
  test('单 change 摘要：对齐 key-value 块', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    const code = await cmdStatus(deps, 'demo-a', {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      'change   demo-a',
      'track    backend',
      'phase    build (in_progress)',
      'verify   pending',
      'updated  2026-07-06T00:00:00Z',
    ])
  })

  test('全量：紧凑表（列宽对齐、空值显示 -、无尾空格）', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA, 'demo-b': stateB } })
    const code = await cmdStatus(deps, undefined, {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      'NAME    TRACK    PHASE    STATUS       VERIFY   UPDATED',
      'demo-a  backend  build    in_progress  pending  2026-07-06T00:00:00Z',
      'demo-b  pm       explore  pending      -        2026-07-05T00:00:00Z',
    ])
    for (const line of deps.outLines) expect(line).toBe(line.trimEnd())
  })

  test('无活跃 change：提示一行，exit 0', async () => {
    const deps = makeDeps({ changes: [] })
    const code = await cmdStatus(deps, undefined, {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['无活跃 change'])
  })

  test('某 change 读取失败：跳过 + stderr WARN，其余照常，exit 0', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA }, changes: ['demo-a', 'broken'] })
    const code = await cmdStatus(deps, undefined, {})
    expect(code).toBe(0)
    expect(deps.outLines.some((l) => l.startsWith('demo-a'))).toBe(true)
    expect(deps.errLines.join('\n')).toContain('broken')
  })

  test('指定 name 不存在：exit 1', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA } })
    const code = await cmdStatus(deps, 'ghost', {})
    expect(code).toBe(1)
  })
})

describe('list —— 活跃 change 表；--json schema 稳定', () => {
  test('人读：紧凑表 NAME/TRACK/PHASE/STATUS/OWNER（负责人名字，无负责人为 -）', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA, 'demo-b': stateB } })
    const code = await cmdList(deps, {})
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      'NAME    TRACK    PHASE    STATUS       OWNER',
      'demo-a  backend  build    in_progress  Jeff Sha',
      'demo-b  pm       explore  pending      -',
    ])
  })

  test('--json：{"changes":[...]} 键序稳定，排除 archived', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA, 'old-x': stateArchived } })
    const code = await cmdList(deps, { json: true })
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      '{"changes":[{"name":"demo-a","track":"backend","phase":"build",'
      + '"phase_status":"in_progress","owner":{"id":"jeff@x.io","name":"Jeff Sha"}}]}',
    ])
  })

  test('空：人读提示一行 / json 空数组，exit 0', async () => {
    const human = makeDeps({ changes: [] })
    expect(await cmdList(human, {})).toBe(0)
    expect(human.outLines).toEqual(['无活跃 change'])

    const json = makeDeps({ changes: [] })
    expect(await cmdList(json, { json: true })).toBe(0)
    expect(json.outLines).toEqual(['{"changes":[]}'])
  })

  test('listChanges 收到 <cwd>/openspec/changes', async () => {
    const deps = makeDeps({ changes: [] })
    await cmdList(deps, {})
    expect(deps.listChanges.calls[0]?.[0]).toBe('/repo/openspec/changes')
  })

  test('读取失败的 change 跳过 + WARN，exit 0', async () => {
    const deps = makeDeps({ states: { 'demo-a': stateA }, changes: ['demo-a', 'broken'] })
    deps.store.read = spy(async (dir: string): Promise<PipelineState> => {
      if (dir.endsWith('demo-a')) return stateA
      throw new Error('ENOENT')
    })
    const code = await cmdList(deps, {})
    expect(code).toBe(0)
    expect(deps.errLines.join('\n')).toContain('broken')
  })
})
