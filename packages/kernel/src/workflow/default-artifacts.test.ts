/**
 * default-artifacts 查询层单测（G2 P4）——生成表 exact-shape + track predicate 过滤语义
 * （explore/spec/verify × 各 track；spec 的 legacy plan artifact 沿用 PM 豁免）
 * + 结构锚：generated table 与 DEFAULT_EVENT_POLICY 是两个独立真相源（改一个不改另一个）。
 */
import { describe, expect, it } from 'vitest'
import { defaultArtifactDeclaredForField, defaultArtifactForField, defaultArtifactsForStep } from './default-artifacts.js'
import { DEFAULT_ARTIFACT_DECLARATIONS } from './default-workflow.generated.js'
import { DEFAULT_EVENT_POLICY } from '../flow/default-event-policy.js'

const TRACKS = ['backend', 'frontend', 'pm', 'free']
const NO_BRANCH = ['simple', 'some-unknown-track']

describe('generated table exact-shape', () => {
  const design = { kind: 'file', field: 'design_doc', type: 'file_path', producerPolicy: 'effective-phase-skills' }
  const plan = { kind: 'file', field: 'plan', type: 'file_path', producerPolicy: 'effective-phase-skills' }
  const report = { kind: 'file', field: 'verification_report', type: 'file_path', producerPolicy: 'effective-phase-skills' }

  it('DEFAULT_ARTIFACT_DECLARATIONS 按分支：chat（驱动流）与 frontend / backend / free 三条 artifact；pm 分支不声明 spec 的 plan；没有通用分支', () => {
    expect(DEFAULT_ARTIFACT_DECLARATIONS).toEqual({
      chat: { explore: [design], spec: [plan], verify: [report] },
      pm: { explore: [design], verify: [report] },
      frontend: { explore: [design], spec: [plan], verify: [report] },
      backend: { explore: [design], spec: [plan], verify: [report] },
      free: { explore: [design], spec: [plan], verify: [report] },
    })
  })

  it('键序稳定 = 分支声明序（chat → pm → frontend → backend → free）；分支内 = step 声明序', () => {
    expect(Object.keys(DEFAULT_ARTIFACT_DECLARATIONS)).toEqual(['chat', 'pm', 'frontend', 'backend', 'free'])
    expect(Object.keys(DEFAULT_ARTIFACT_DECLARATIONS.frontend)).toEqual(['explore', 'spec', 'verify'])
  })

  it('producer policy 全部是 effective-phase-skills（default 的产出者来自 phase 有效技能集）', () => {
    for (const branch of Object.values(DEFAULT_ARTIFACT_DECLARATIONS)) {
      for (const arr of Object.values(branch)) {
        for (const a of arr) expect(a.producerPolicy).toBe('effective-phase-skills')
      }
    }
  })
})

describe('defaultArtifactsForStep —— 按分支选表', () => {
  it('explore：每条分支都声明 design_doc；没有分支的 track 没有 pipeline，也就没有 artifact', () => {
    for (const track of TRACKS) {
      expect(defaultArtifactsForStep('explore', track).map((d) => d.field)).toEqual(['design_doc'])
    }
    for (const track of NO_BRANCH) expect(defaultArtifactsForStep('explore', track)).toEqual([])
  })

  it('spec：仅非 PM track 产出 legacy plan artifact；PM 的 plan 文档仍由 OpenSpec ledger 管理', () => {
    for (const track of TRACKS.filter((track) => track !== 'pm')) {
      expect(defaultArtifactsForStep('spec', track).map((d) => d.field)).toEqual(['plan'])
    }
    expect(defaultArtifactsForStep('spec', 'pm')).toEqual([])
  })

  it('verify：每条分支都声明 verification_report', () => {
    for (const track of TRACKS) {
      expect(defaultArtifactsForStep('verify', track).map((d) => d.field)).toEqual(['verification_report'])
    }
  })

  it('无 artifact 声明的 step（open/build/ship/archive）→ 空数组（含 build：build_sha 是 transition action 冻结值，不是 file artifact）', () => {
    for (const step of ['open', 'build', 'ship', 'archive']) {
      for (const track of TRACKS) expect(defaultArtifactsForStep(step, track)).toEqual([])
    }
  })

  it('未知 step id → 空数组（不抛）', () => {
    expect(defaultArtifactsForStep('nonexistent-step', 'backend')).toEqual([])
  })

  it('返回的声明形状 = 该分支生成表条目（含 kind/type/producerPolicy；分支内不再需要 requiredWhen）', () => {
    expect(defaultArtifactsForStep('spec', 'backend')).toEqual([
      { kind: 'file', field: 'plan', type: 'file_path', producerPolicy: 'effective-phase-skills' },
    ])
  })
})

describe('defaultArtifactForField', () => {
  it('spec/backend/plan 是当前有效 artifact；PM 沿用原流程豁免', () => {
    expect(defaultArtifactForField('spec', 'plan', 'backend')?.field).toBe('plan')
    expect(defaultArtifactForField('spec', 'plan', 'pm')).toBeUndefined()
  })

  it('explore/backend/design_doc → 声明；explore/backend/plan → undefined（该 step 无此 field）', () => {
    expect(defaultArtifactForField('explore', 'design_doc', 'backend')?.field).toBe('design_doc')
    expect(defaultArtifactForField('explore', 'plan', 'backend')).toBeUndefined()
  })

  it('verify/pm/verification_report → 声明（无 requiredWhen，pm 也产出）', () => {
    expect(defaultArtifactForField('verify', 'verification_report', 'pm')?.field).toBe('verification_report')
  })

  it('不出现 build_sha 这类 file artifact（build_sha 是 string output + transition action，不进 declaration 表）', () => {
    for (const track of TRACKS) {
      expect(defaultArtifactForField('build', 'build_sha', track)).toBeUndefined()
    }
  })
})

describe('defaultArtifactDeclaredForField —— 不经 track 过滤的存在性（G2 P5）', () => {
  it('声明了的 field → true（plan 是否当前有效仍须按 track 过滤）', () => {
    expect(defaultArtifactDeclaredForField('explore', 'design_doc')).toBe(true)
    expect(defaultArtifactDeclaredForField('spec', 'plan')).toBe(true) // 声明存在（pm 轨适用性另说）
    expect(defaultArtifactDeclaredForField('verify', 'verification_report')).toBe(true)
  })

  it('未声明的 field / 无 artifact 的 step → false', () => {
    expect(defaultArtifactDeclaredForField('explore', 'plan')).toBe(false)
    expect(defaultArtifactDeclaredForField('build', 'build_sha')).toBe(false)
    expect(defaultArtifactDeclaredForField('open', 'design_doc')).toBe(false)
  })

  it('spec/plan 对 PM 是声明但当前不适用的 artifact', () => {
    expect(defaultArtifactDeclaredForField('spec', 'plan')).toBe(true)
    expect(defaultArtifactForField('spec', 'plan', 'pm')).toBeUndefined()
    expect(defaultArtifactForField('spec', 'plan', 'backend')).toBeDefined()
  })
})

describe('结构锚：artifact declaration 表与 DEFAULT_EVENT_POLICY 是两个独立真相源', () => {
  it('artifact 层与 transition policy 都沿用 PM legacy plan 豁免，但仍是独立真相源', () => {
    expect(defaultArtifactForField('spec', 'plan', 'pm')).toBeUndefined()
    expect(DEFAULT_EVENT_POLICY['spec-complete'].guards).toEqual([
      { type: 'file-exists', path: { kind: 'field', field: 'plan' }, when: { kind: 'track-not-in', values: ['pm'] } },
    ])
  })

  it('default-artifacts 只读生成表，不涉足 transition 政策：DEFAULT_EVENT_POLICY 事件键集不受 artifact 表影响', () => {
    // 锚 DEFAULT_EVENT_POLICY 的事件闭集不变（P3 收官形状）；artifact 表新增/改动不得越界改它。
    expect(Object.keys(DEFAULT_EVENT_POLICY).sort()).toEqual(
      [
        'open-complete', 'explore-complete', 'spec-complete', 'requirements-changed',
        'build-complete', 'verify-pass', 'verify-fail', 'ship-complete', 'archived',
      ].sort(),
    )
  })
})
