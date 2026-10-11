import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { parseWorkflow } from './parse.js'
import { listTracks, resolveTrack, UnknownTrackError } from './resolve-track.js'
import { compiledDefault, compiledDesignSystem } from './test-support.js'

const STEP = `      - id: open
        label: 开始
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []`

function compiled(source: string) {
  return compileWorkflow(parseWorkflow(source))
}

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('resolveTrack', () => {
  it('按 id 解析分支并带出规范与自动化', () => {
    const b = resolveTrack(compiledDefault(), 'pm')
    expect(b.id).toBe('pm')
    expect(b.implicit).toBe(false)
    expect(b.spec).toBe('openspec')
    expect(b.automation).toEqual({ eligible: true, enqueueAfterSpec: true })
  })

  it('分支的步骤与路由原样带出', () => {
    const lite = resolveTrack(compiledDefault(), 'lite')
    expect(lite.spec).toBe('none')
    expect(lite.steps.map((s) => s.id)).toEqual(['open', 'build', 'verify', 'done', 'escalated'])
    expect(lite.route?.priority).toBe(500)
    expect(resolveTrack(compiledDefault(), 'backend').route?.fallback).toBe(true)
    expect(resolveTrack(compiledDefault(), 'pm').route).toMatchObject({ priority: 100, fallback: false })
  })

  it('分支没写 label 时用 id', () => {
    const ir = compiled(`name: demo\ntracks:\n  alpha:\n    steps:\n${STEP}\n`)
    expect(resolveTrack(ir, 'alpha').label).toBe('alpha')
    expect(resolveTrack(compiledDefault(), 'lite').label).toBe('轻量')
  })

  it('分支没写 automation 时不可进 AFK（失败关闭）', () => {
    const ir = compiled(`name: demo\ntracks:\n  alpha:\n    steps:\n${STEP}\n`)
    expect(resolveTrack(ir, 'alpha').automation).toEqual({ eligible: false, enqueueAfterSpec: false })
  })

  it('分支没写 spec 时继承顶层 openspec', () => {
    const inherited = compiled(`name: demo\nopenspec: true\ntracks:\n  alpha:\n    steps:\n${STEP}\n`)
    expect(resolveTrack(inherited, 'alpha').spec).toBe('openspec')
    const plain = compiled(`name: demo\ntracks:\n  alpha:\n    steps:\n${STEP}\n`)
    expect(resolveTrack(plain, 'alpha').spec).toBe('none')
  })

  it('平铺工作流省略轨道得到隐式分支', () => {
    const b = resolveTrack(compiledDesignSystem())
    expect(b.implicit).toBe(true)
    expect(b.id).toBe('design-system')
    expect(b.spec).toBe('openspec')
    expect(b.steps.map((s) => s.id)).toEqual(['direction', 'generate', 'review'])
    expect(b.automation).toEqual({ eligible: false, enqueueAfterSpec: false })
  })

  it('平铺工作流的轨道 id 等于工作流名时同样得到隐式分支', () => {
    expect(resolveTrack(compiledDesignSystem(), 'design-system').implicit).toBe(true)
    expect(resolveTrack(compiledDesignSystem(), '').implicit).toBe(true)
  })

  it('平铺工作流不接受别的轨道 id，可选项只有工作流名', () => {
    const e = caught(() => resolveTrack(compiledDesignSystem(), 'free'))
    expect(e).toBeInstanceOf(UnknownTrackError)
    expect((e as UnknownTrackError).available).toEqual(['design-system'])
    expect((e as UnknownTrackError).message).toContain('free')
  })

  it('不存在的轨道列出可选项', () => {
    expect(() => resolveTrack(compiledDefault(), 'chat')).toThrow(UnknownTrackError)
    const e = caught(() => resolveTrack(compiledDefault(), 'chat'))
    expect((e as UnknownTrackError).available).toEqual(['lite', 'pm', 'frontend', 'backend'])
    expect((e as UnknownTrackError).message).toContain('lite, pm, frontend, backend')
    expect((e as UnknownTrackError).message).toContain('chat')
  })

  it('有分支却省略轨道时抛错并列出全部分支', () => {
    const e = caught(() => resolveTrack(compiledDefault()))
    expect(e).toBeInstanceOf(UnknownTrackError)
    expect((e as UnknownTrackError).available).toEqual(['lite', 'pm', 'frontend', 'backend'])
    expect(caught(() => resolveTrack(compiledDefault(), ''))).toBeInstanceOf(UnknownTrackError)
  })

  it('listTracks 按声明顺序列出全部轨道；平铺工作流只有一条隐式分支', () => {
    expect(listTracks(compiledDefault()).map((b) => [b.id, b.label, b.implicit])).toEqual([
      ['lite', '轻量', false], ['pm', '产品', false], ['frontend', '前端', false], ['backend', '后端', false],
    ])
    expect(listTracks(compiledDesignSystem()).map((b) => [b.id, b.implicit])).toEqual([['design-system', true]])
  })

  it('轨道 id 与原型链同名的键不被当成分支', () => {
    const e = caught(() => resolveTrack(compiledDefault(), 'constructor'))
    expect(e).toBeInstanceOf(UnknownTrackError)
    expect((e as UnknownTrackError).available).toEqual(['lite', 'pm', 'frontend', 'backend'])
  })
})
