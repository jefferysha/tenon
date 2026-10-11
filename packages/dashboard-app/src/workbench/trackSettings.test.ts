import { describe, expect, it } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { addTrackBranch } from './workbenchBranches'
import { parseTrackKeywords, setTrackSettingsInDef, trackSettingsOf } from './trackSettings'

function step(id: string): WbStepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }
}

const CONTRACT = { version: 'v1' as const, slots: [{ kind: 'proposal', ownerStep: 'open', producers: [] }], reads: [] }
const ROUTE = { keywords: ['后端'], exclude: ['前端'], priority: 200, fallback: true }

const DEF: WbWorkflowDef = {
  name: 'demo',
  openspec: true,
  steps: [],
  tracks: {
    backend: { label: '后端', documentContract: CONTRACT, route: ROUTE, steps: [step('open')] },
    lite: { label: '轻量', spec: 'none', steps: [step('open')] },
  },
}

describe('parseTrackKeywords', () => {
  it('英文逗号与中文逗号都分隔；去空白、去空项、去重，保持首次出现的顺序', () => {
    expect(parseTrackKeywords('修复, typo，  typo ,文案,')).toEqual({ ok: true, keywords: ['修复', 'typo', '文案'] })
    expect(parseTrackKeywords('')).toEqual({ ok: true, keywords: [] })
    expect(parseTrackKeywords(' , ，')).toEqual({ ok: true, keywords: [] })
  })

  it('路由词里不能有方括号 / 花括号 / 控制字符；单个至多 64 字，至多 64 个（与内核的路由词校验同一口径）', () => {
    expect(parseTrackKeywords('a, [b]')).toEqual({ ok: false })
    expect(parseTrackKeywords('a{b}')).toEqual({ ok: false })
    expect(parseTrackKeywords('a\u0007b')).toEqual({ ok: false })
    expect(parseTrackKeywords('x'.repeat(64))).toEqual({ ok: true, keywords: ['x'.repeat(64)] })
    expect(parseTrackKeywords('x'.repeat(65))).toEqual({ ok: false })
    expect(parseTrackKeywords(Array.from({ length: 64 }, (_, index) => `k${index}`).join(','))).toMatchObject({ ok: true })
    expect(parseTrackKeywords(Array.from({ length: 65 }, (_, index) => `k${index}`).join(','))).toEqual({ ok: false })
  })
})

describe('trackSettingsOf', () => {
  it('规范取分支自己的 spec，没写继承工作流顶层 openspec；关键词取 route.keywords，没有 route 就是空', () => {
    expect(trackSettingsOf(DEF, 'backend')).toEqual({ spec: 'openspec', keywords: ['后端'] })
    expect(trackSettingsOf(DEF, 'lite')).toEqual({ spec: 'none', keywords: [] })
    expect(trackSettingsOf({ ...DEF, openspec: false }, 'backend')).toEqual({ spec: 'none', keywords: ['后端'] })
    expect(trackSettingsOf(DEF, 'ghost')).toEqual({ spec: 'openspec', keywords: [] })
  })
})

describe('setTrackSettingsInDef', () => {
  it('改成「无」：写 spec: none，并去掉这条分支的文档契约（none 的分支不得声明）', () => {
    const next = setTrackSettingsInDef(DEF, 'backend', { spec: 'none', keywords: ['后端'] })
    expect(next.tracks?.backend?.spec).toBe('none')
    expect(next.tracks?.backend).not.toHaveProperty('documentContract')
    expect(next.tracks?.lite).toBe(DEF.tracks?.lite)
  })

  it('规范与继承值相同就不写 spec 键（旧文件不用改）；原来写了的会被去掉', () => {
    const toOpenspec = setTrackSettingsInDef(DEF, 'lite', { spec: 'openspec', keywords: [] })
    expect(toOpenspec.tracks?.lite).not.toHaveProperty('spec')
    const stays = setTrackSettingsInDef(DEF, 'backend', { spec: 'openspec', keywords: ['后端'] })
    expect(stays).toBe(DEF)
  })

  it('顶层没开 OpenSpec 时，「OpenSpec」要显式写出 spec: openspec', () => {
    const off: WbWorkflowDef = { ...DEF, openspec: undefined }
    const next = setTrackSettingsInDef(off, 'lite', { spec: 'openspec', keywords: [] })
    expect(next.tracks?.lite?.spec).toBe('openspec')
  })

  it('关键词写进 route.keywords，route 的其它项（exclude / priority / fallback）原样保留', () => {
    const next = setTrackSettingsInDef(DEF, 'backend', { spec: 'openspec', keywords: ['修复', 'typo'] })
    expect(next.tracks?.backend?.route).toEqual({ ...ROUTE, keywords: ['修复', 'typo'] })
    expect(next.tracks?.backend?.documentContract).toBe(CONTRACT)
  })

  it('没有 route 的分支填了关键词：补一条 route（不排除、不兜底、优先级 100）', () => {
    const next = setTrackSettingsInDef(DEF, 'lite', { spec: 'none', keywords: ['修复', 'typo'] })
    expect(next.tracks?.lite?.route).toEqual({ keywords: ['修复', 'typo'], exclude: [], priority: 100, fallback: false })
    expect(next.tracks?.lite?.spec).toBe('none')
  })

  it('清空关键词：route 里没有别的项就整条去掉；有排除词或兜底就只清关键词', () => {
    const plain: WbWorkflowDef = { ...DEF, tracks: { ...DEF.tracks, lite: { ...DEF.tracks!.lite!, route: { keywords: ['x'], exclude: [], priority: 100, fallback: false } } } }
    expect(setTrackSettingsInDef(plain, 'lite', { spec: 'none', keywords: [] }).tracks?.lite).not.toHaveProperty('route')
    const kept = setTrackSettingsInDef(DEF, 'backend', { spec: 'openspec', keywords: [] })
    expect(kept.tracks?.backend?.route).toEqual({ ...ROUTE, keywords: [] })
  })

  it('没有这条轨道、或设置没变：原样返回同一个对象', () => {
    expect(setTrackSettingsInDef(DEF, 'ghost', { spec: 'none', keywords: ['x'] })).toBe(DEF)
    expect(setTrackSettingsInDef(DEF, 'lite', { spec: 'none', keywords: [] })).toBe(DEF)
  })

  it('新建的轨道带设置：复制来源分支的步骤，再按所选规范与关键词落定', () => {
    const created = setTrackSettingsInDef(addTrackBranch(DEF, 'quick', '快速', 'backend'), 'quick', { spec: 'none', keywords: ['修复'] })
    expect(created.tracks?.quick).toMatchObject({ label: '快速', spec: 'none', route: { keywords: ['修复'] } })
    expect(created.tracks?.quick).not.toHaveProperty('documentContract')
    expect(created.tracks?.quick?.steps.map((entry) => entry.id)).toEqual(['open'])
  })
})
