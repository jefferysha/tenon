import { describe, expect, it } from 'vitest'
import type { WbStepIoEntry, WbStepIoFile } from '../api/governanceTypes'
import { fileName, gateProgress, isReadableFile, readableFiles, stageInputs, stageOutputs, stageRequired } from './stageIo'

const design: WbStepIoFile = { path: 'docs/specs/2026-10-12-demo-design.md', change: 'added', skill: 'brainstorming' }
const code: WbStepIoFile = { path: 'src/demo.ts', change: 'modified', skill: null }
const removed: WbStepIoFile = { path: 'docs/old.md', change: 'deleted', skill: null }
const handed: WbStepIoFile = { path: design.path, skill: 'brainstorming', fromStep: 'explore', read: false }

const entry: WbStepIoEntry = {
  inputs: [handed],
  outputs: [design, code, removed],
  required: [{ path: 'docs/specs/*.md', produced: true }],
}

describe('stageInputs / stageOutputs', () => {
  it('取这一步的输入与输出，原样不改（来源技能 null 留给界面写「未知」）', () => {
    expect(stageInputs(entry)).toEqual([handed])
    expect(stageOutputs(entry)).toEqual([design, code, removed])
    expect(stageOutputs(entry)[1]?.skill).toBeNull()
  })

  it('没有这一步（聚合视图、旧服务端）→ 空列表，且每次是同一个引用，memo 不抖', () => {
    expect(stageInputs(undefined)).toEqual([])
    expect(stageOutputs(undefined)).toEqual([])
    expect(stageRequired(undefined)).toEqual([])
    expect(stageInputs(undefined)).toBe(stageInputs(undefined))
    expect(stageOutputs(undefined)).toBe(stageOutputs(undefined))
    expect(stageRequired(undefined)).toBe(stageRequired(undefined))
    expect(stageRequired(entry)).toEqual([{ path: 'docs/specs/*.md', produced: true }])
  })
})

describe('readableFiles', () => {
  it('先输出后输入、按路径去重；删除的输出已不在盘上，不进抽屉', () => {
    const files = readableFiles([...stageOutputs(entry), ...stageInputs(entry)])
    expect(files).toEqual([
      { path: design.path, label: '2026-10-12-demo-design.md' },
      { path: 'src/demo.ts', label: 'demo.ts' },
    ])
  })

  it('isReadableFile：删除的文件不可读，其余都可读（含契约模式没有变化类型的）', () => {
    expect(isReadableFile(removed)).toBe(false)
    expect(isReadableFile(design)).toBe(true)
    expect(isReadableFile({ path: 'a.md', skill: 'x' })).toBe(true)
  })
})

describe('fileName', () => {
  it('取最后一段；没有斜杠就是自己', () => {
    expect(fileName('docs/specs/a.md')).toBe('a.md')
    expect(fileName('a.md')).toBe('a.md')
    expect(fileName('docs/specs/')).toBe('specs')
  })
})

describe('gateProgress', () => {
  const required = (...produced: boolean[]) => produced.map((done, index) => ({ path: `docs/${index}.md`, produced: done }))

  it('auto 数必须产出已齐的条数；没有门禁或零条件 → null', () => {
    expect(gateProgress('auto', required(true, false), false)).toEqual({ gate: 'auto', done: 1, total: 2 })
    expect(gateProgress('auto', [], true)).toBeNull()
    expect(gateProgress(null, required(true), true)).toBeNull()
  })

  it('review 在此之上多一条人工确认', () => {
    expect(gateProgress('review', required(true, false), false)).toEqual({ gate: 'review', done: 1, total: 3 })
    expect(gateProgress('review', required(true, false), true)).toEqual({ gate: 'review', done: 2, total: 3 })
    expect(gateProgress('review', [], true)).toEqual({ gate: 'review', done: 1, total: 1 })
    expect(gateProgress('review', [], false)).toEqual({ gate: 'review', done: 0, total: 1 })
  })
})
