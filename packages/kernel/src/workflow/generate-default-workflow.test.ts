/**
 * generate-default-workflow.mjs 单测（G2 P4）——generator golden（真 default.yaml + 真 kernel types.ts
 * 生成物逐字节等于入库 default-workflow.generated.ts）+ 窄扫器结构等价 + malformed 全 fail-loud
 * （name/重复 step id/重复 field/未知 field/非法 policy/非法谓词/type 越界/缺子字段/未知子字段行）。
 *
 * 直接 import 根级 .mjs 的纯函数（脚本自身零副作用 import——main 只在直跑时触发）；测试文件不进
 * kernel tsc -b（tsconfig exclude *.test.ts），故 .mjs 无类型声明不影响 build。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 纯 JS 工具脚本，无 .d.ts；vitest 运行时按 ESM 解析，测试不参与 kernel tsc build。
import { extractFieldOrder, generate, parseDefaultWorkflow, validateAndNormalize } from '../../../../tools/generate-default-workflow.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(dirname(dirname(dirname(__dirname))))
const readReal = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

const REAL_YAML = readReal('templates/workflows/default.yaml')
const REAL_TYPES = readReal('packages/kernel/src/types.ts')
const REAL_GENERATED = readReal('packages/kernel/src/workflow/default-workflow.generated.ts')

/** 可控 fieldOrder（malformed 用例隔离 FIELD_ORDER 变量）。 */
const FIELDS = ['design_doc', 'plan', 'verification_report']

const run = (yaml: string, fields: string[] = FIELDS): unknown =>
  validateAndNormalize(parseDefaultWorkflow(yaml), fields)

const wrap = (stepBody: string): string => `name: default\nsteps:\n${stepBody}`

describe('generator golden（真生产 fixture）', () => {
  it('generate(真 default.yaml, 真 types.ts) 逐字节等于入库 default-workflow.generated.ts（freshness 的单测镜像）', () => {
    expect(generate(REAL_YAML, REAL_TYPES)).toBe(REAL_GENERATED)
  })

  it('generate 幂等：同输入两跑逐字节一致', () => {
    expect(generate(REAL_YAML, REAL_TYPES)).toBe(generate(REAL_YAML, REAL_TYPES))
  })
})

describe('parseDefaultWorkflow（窄扫器）结构等价', () => {
  it('真 default.yaml → 通用分支 7 步，仅 explore/spec/verify 带 artifact，声明序保留；四条 track 分支', () => {
    const parsed = parseDefaultWorkflow(REAL_YAML) as { name: string; steps: { id: string; artifacts: unknown[] }[]; tracks: Record<string, { label?: string; steps: { id: string }[] }> }
    expect(parsed.name).toBe('default')
    expect(parsed.steps.map((s) => s.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    const withArtifacts = parsed.steps.filter((s) => s.artifacts.length > 0).map((s) => s.id)
    expect(withArtifacts).toEqual(['explore', 'spec', 'verify'])
    expect(Object.keys(parsed.tracks)).toEqual(['pm', 'frontend', 'backend', 'free'])
    expect(parsed.tracks.pm?.label).toBe('产品')
    expect(parsed.tracks.pm?.steps.map((s) => s.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
  })

  it('pm 分支的 spec 不声明 plan artifact（PM 的 plan 文档由 OpenSpec ledger 约束）；其余分支声明；通用分支保留谓词', () => {
    const parsed = parseDefaultWorkflow(REAL_YAML) as { steps: { id: string; artifacts: any[] }[]; tracks: Record<string, { steps: { id: string; artifacts: any[] }[] }> }
    expect(parsed.steps.find((s) => s.id === 'spec')!.artifacts[0]).toMatchObject({ requiredWhen: { kind: 'track-not-in', values: ['pm'] } })
    expect(parsed.tracks.pm!.steps.find((s) => s.id === 'spec')!.artifacts).toEqual([])
    expect(parsed.tracks.backend!.steps.find((s) => s.id === 'spec')!.artifacts).toEqual([
      { field: 'plan', type: 'file_path', producerPolicy: 'effective-phase-skills' },
    ])
  })
})

describe('extractFieldOrder', () => {
  it('从 types.ts 文本提取 FIELD_ORDER（含 design_doc/plan/verification_report），跳过 // 注释', () => {
    const fields = extractFieldOrder(REAL_TYPES) as string[]
    expect(fields).toContain('design_doc')
    expect(fields).toContain('plan')
    expect(fields).toContain('verification_report')
    // 注释里的伪 token 不得被当字段（automation_current_phase 是真字段但其上方注释含大量中文，不含 'token'）
    expect(fields).not.toContain('token')
  })

  it('找不到 FIELD_ORDER 块 → fail-loud', () => {
    expect(() => extractFieldOrder('export const OTHER = [] as const')).toThrow(/FIELD_ORDER/)
  })
})

describe('malformed → fail-loud', () => {
  it('name ≠ default → 拒绝', () => {
    const yaml = 'name: custom\nsteps:\n  - id: explore\n    artifacts: []\n'
    expect(() => run(yaml)).toThrow(/name 必须是 'default'/)
  })

  it('重复 step id → 拒绝', () => {
    const body = '  - id: explore\n    artifacts: []\n  - id: explore\n    artifacts: []\n'
    expect(() => run(wrap(body))).toThrow(/step id 'explore' 重复/)
  })

  it('同 step 内重复 artifact field → 拒绝', () => {
    const body =
      '  - id: explore\n    artifacts:\n' +
      '      - field: design_doc\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      '      - field: design_doc\n        type: file_path\n        producer_policy: effective-phase-skills\n'
    expect(() => run(wrap(body))).toThrow(/artifact field 'design_doc' 重复/)
  })

  it('field ∉ FIELD_ORDER → 拒绝', () => {
    const body = '  - id: explore\n    artifacts:\n      - field: bogus_field\n        type: file_path\n        producer_policy: effective-phase-skills\n'
    expect(() => run(wrap(body))).toThrow(/不在 FIELD_ORDER/)
  })

  it('producer_policy 越出闭集 → 拒绝', () => {
    const body = '  - id: explore\n    artifacts:\n      - field: design_doc\n        type: file_path\n        producer_policy: made-up-policy\n'
    expect(() => run(wrap(body))).toThrow(/producer_policy 'made-up-policy' 不在闭集/)
  })

  it('type ≠ file_path → 拒绝（parse 层）', () => {
    const body = '  - id: explore\n    artifacts:\n      - field: design_doc\n        type: string\n        producer_policy: effective-phase-skills\n'
    expect(() => run(wrap(body))).toThrow(/type 只支持 file_path/)
  })

  it('缺 type → 拒绝', () => {
    const body = '  - id: explore\n    artifacts:\n      - field: design_doc\n        producer_policy: effective-phase-skills\n'
    expect(() => run(wrap(body))).toThrow(/缺 type/)
  })

  it('缺 producer_policy → 拒绝', () => {
    const body = '  - id: explore\n    artifacts:\n      - field: design_doc\n        type: file_path\n'
    expect(() => run(wrap(body))).toThrow(/缺 producer_policy/)
  })

  it('artifact 未知子字段行 → 拒绝', () => {
    const body = '  - id: explore\n    artifacts:\n      - field: design_doc\n        type: file_path\n        producer_policy: effective-phase-skills\n        bogus: x\n'
    expect(() => run(wrap(body))).toThrow(/未知字段行/)
  })

  it('required_when 谓词非 track_in/track_not_in → 拒绝（parse 层）', () => {
    const body =
      '  - id: spec\n    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      '        required_when:\n          phase_in: [spec]\n'
    expect(() => run(wrap(body))).toThrow(/谓词只支持 track_in\/track_not_in/)
  })

  it('required_when values 为空 → 拒绝（validate 层）', () => {
    const body =
      '  - id: spec\n    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      '        required_when:\n          track_not_in: []\n'
    expect(() => run(wrap(body))).toThrow(/values 不得为空/)
  })

  it('required_when values 重复 → 拒绝（validate 层）', () => {
    const body =
      '  - id: spec\n    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      '        required_when:\n          track_not_in: [pm, pm]\n'
    expect(() => run(wrap(body))).toThrow(/value 'pm' 重复/)
  })

  // C-1（codex review round1 阻断）：artifacts 块内非 '- field:' 起始的畸形项必须 fail-loud——
  // 修复前 parseArtifactEntries 遇非 '- field:' 直接 break，被外层当"其余 step 字段"静默跳过、产出残缺表。
  it('artifact 首项缺 field（- type: 起始）→ fail-loud，不静默吞', () => {
    const body = '  - id: explore\n    artifacts:\n      - type: file_path\n        producer_policy: effective-phase-skills\n'
    expect(() => run(wrap(body))).toThrow(/非 '- field:' 起始的畸形项/)
  })

  it('artifact 块内畸形列表项（- bogus_key:）→ fail-loud', () => {
    const body =
      '  - id: explore\n    artifacts:\n' +
      '      - field: design_doc\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      '      - bogus_key: x\n'
    expect(() => run(wrap(body))).toThrow(/非 '- field:' 起始的畸形项/)
  })

  // C-2（codex review round1 阻断）：predicate value 须是合法 track id，杜绝引号/换行等破坏 generated
  // TS 字符串的字符——修复前 [pm'] 会生成 values: ['pm''] 非法 TS，推迟到 tsc build 才炸。
  it("required_when value 含单引号（pm'）→ fail-loud，不生成非法 TS", () => {
    const body =
      '  - id: spec\n    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      "        required_when:\n          track_not_in: [pm']\n"
    expect(() => run(wrap(body))).toThrow(/不是合法 track id/)
  })

  it('required_when value 含大写等非 track-id 字符（PM）→ fail-loud', () => {
    const body =
      '  - id: spec\n    artifacts:\n      - field: plan\n        type: file_path\n        producer_policy: effective-phase-skills\n' +
      '        required_when:\n          track_not_in: [PM]\n'
    expect(() => run(wrap(body))).toThrow(/不是合法 track id/)
  })
})
