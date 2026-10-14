/**
 * generate-default-workflow.mjs 单测——generator golden（真 default.yaml + design-system.yaml 生成物逐字节等于入库
 * default-workflow.generated.ts）+ 窄扫器结构等价 + malformed 全 fail-loud（name / 重复 step id / 缺 label / 未知分支字段）。
 *
 * 生成物只含两份工作流原文与 default 的步骤元数据；artifact 声明表已删（文档产出由 Tenon 在离开步骤时观察，
 * 必须产出写成 required-output 守卫，不再有生产代码读那张表）。
 *
 * 直接 import 根级 .mjs 的纯函数（脚本自身零副作用 import——main 只在直跑时触发）；测试文件不进
 * kernel tsc -b（tsconfig exclude *.test.ts），故 .mjs 无类型声明不影响 build。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 纯 JS 工具脚本，无 .d.ts；vitest 运行时按 ESM 解析，测试不参与 kernel tsc build。
import { generate, parseDefaultWorkflow, validateDefaultWorkflow } from '../../../../tools/generate-default-workflow.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(dirname(dirname(dirname(__dirname))))
const readReal = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

const REAL_YAML = readReal('templates/workflows/default.yaml')
// 升级前带 artifacts / document_contract 的 default 原文（f474225f）：窄扫器对这些键仍要能跳过而不是报错。
const LEGACY_YAML = readReal('tools/fixtures/legacy-default-workflow.yaml')
const REAL_GENERATED = readReal('packages/kernel/src/workflow/default-workflow.generated.ts')
const REAL_DESIGN_SYSTEM = readReal('templates/workflows/design-system.yaml')

const run = (yaml: string): unknown => validateDefaultWorkflow(parseDefaultWorkflow(yaml))

const wrap = (stepBody: string): string => `name: default\nsteps:\n${stepBody}`

describe('generator golden（真生产 fixture）', () => {
  it('generate(真 default.yaml, 真 design-system.yaml) 逐字节等于入库 default-workflow.generated.ts（freshness 的单测镜像）', () => {
    expect(generate(REAL_YAML, REAL_DESIGN_SYSTEM)).toBe(REAL_GENERATED)
  })

  it('generate 幂等：同输入两跑逐字节一致', () => {
    expect(generate(REAL_YAML, REAL_DESIGN_SYSTEM)).toBe(generate(REAL_YAML, REAL_DESIGN_SYSTEM))
  })

  it('生成物不再带 standard 模板：standard 已并入 default 的 lite 轨道', () => {
    expect(REAL_GENERATED).not.toContain('STANDARD_WORKFLOW_SOURCE')
  })

  it('生成物不再带 artifact 声明表，也不再引用已删除的 default-artifacts 查询层', () => {
    expect(REAL_GENERATED).not.toContain('DEFAULT_ARTIFACT_DECLARATIONS')
    expect(REAL_GENERATED).not.toContain('default-artifacts')
    expect(REAL_GENERATED).not.toContain('import ')
  })

  it('升级前带 artifacts / document_contract 的旧 default 也生成同一份步骤元数据（artifacts 块被跳过，不生成表）', () => {
    const legacy = generate(LEGACY_YAML, REAL_DESIGN_SYSTEM) as string
    expect(legacy).not.toContain('DEFAULT_ARTIFACT_DECLARATIONS')
    expect(legacy).toContain('export const DEFAULT_WORKFLOW_STEPS = [')
  })

  it('DEFAULT_WORKFLOW_STEPS 是 OpenSpec 轨道的七阶段骨架，不是排在最前的 lite 的五步', () => {
    expect(REAL_GENERATED).toContain('export const DEFAULT_WORKFLOW_STEPS = [')
    const block = /export const DEFAULT_WORKFLOW_STEPS = \[([\s\S]*?)\] as const/.exec(REAL_GENERATED)?.[1] ?? ''
    expect([...block.matchAll(/id: "([^"]+)"/g)].map((m) => m[1])).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
  })
})

describe('parseDefaultWorkflow（窄扫器）结构等价', () => {
  it('真 default.yaml → 没有顶层 steps；分支为 lite / pm / frontend / backend，lite 五步、其余七步，没有 chat / free', () => {
    const parsed = parseDefaultWorkflow(REAL_YAML) as { name: string; steps: { id: string }[]; tracks: Record<string, { label?: string; spec?: string; steps: { id: string }[] }> }
    expect(parsed.name).toBe('default')
    expect(parsed.steps).toEqual([])
    expect(Object.keys(parsed.tracks)).toEqual(['lite', 'pm', 'frontend', 'backend'])
    expect(parsed.tracks.chat).toBeUndefined()
    expect(parsed.tracks.free).toBeUndefined()
    expect(parsed.tracks.lite?.label).toBe('轻量')
    expect(parsed.tracks.lite?.spec).toBe('none')
    expect(parsed.tracks.lite?.steps.map((s) => s.id)).toEqual(['open', 'build', 'verify', 'done', 'escalated'])
    expect(parsed.tracks.pm?.label).toBe('产品')
    for (const id of ['pm', 'frontend', 'backend']) {
      expect(parsed.tracks[id]?.steps.map((s) => s.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    }
  })

  it('分支 spec / route / automation 块被跳过，不当作未知字段', () => {
    const yaml = [
      'name: default', 'tracks:', '  lite:', '    label: 轻量', '    spec: none',
      '    route:', '      keywords: [修复, typo]', '      exclude: [迁移]', '      priority: 500',
      '    automation:', '      eligible: false', '      enqueue_after_spec: false',
      '    steps:', '      - id: open', '        label: 立项', '',
    ].join('\n')
    const parsed = parseDefaultWorkflow(yaml) as { tracks: Record<string, { spec?: string; steps: { id: string }[] }> }
    expect(parsed.tracks.lite?.spec).toBe('none')
    expect(parsed.tracks.lite?.steps.map((step) => step.id)).toEqual(['open'])
  })

  it('分支里出现闭集之外的字段行仍然 fail-loud', () => {
    const yaml = ['name: default', 'tracks:', '  lite:', '    label: 轻量', '    colour: red', '    steps:', '      - id: open', '        label: 立项', ''].join('\n')
    expect(() => parseDefaultWorkflow(yaml)).toThrow(/未知字段行/)
  })

  it('每条分支第一步是立项，最后一步标签是完结；分支 document_contract 块被跳过', () => {
    const parsed = parseDefaultWorkflow(REAL_YAML) as { tracks: Record<string, { steps: { id: string; label: string }[] }> }
    for (const branch of Object.values(parsed.tracks)) {
      expect(branch.steps[0]?.id).toBe('open')
    }
    for (const id of ['pm', 'frontend', 'backend']) {
      expect(parsed.tracks[id]?.steps.at(-1)?.label).toBe('完结')
    }
    const yaml = [
      'name: default', 'tracks:', '  web:', '    label: 前端', '    document_contract:', '      version: v1', '      slots:',
      '        - { kind: proposal, owner_step: explore, producers: [a] }', '      reads: []', '    steps:', '      - id: explore', '        label: 调研', '',
    ].join('\n')
    const branched = parseDefaultWorkflow(yaml) as { tracks: Record<string, { steps: { id: string }[] }> }
    expect(branched.tracks.web?.steps.map((step) => step.id)).toEqual(['explore'])
  })

  it('旧 default（带 artifacts 与 document_contract）：步骤 id 与标签照常解析，artifacts 块不影响相邻步骤', () => {
    const parsed = parseDefaultWorkflow(LEGACY_YAML) as { tracks: Record<string, { steps: { id: string; label: string }[] }> }
    expect(parsed.tracks.frontend?.steps.map((step) => step.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(parsed.tracks.frontend?.steps.every((step) => typeof step.label === 'string' && step.label !== '')).toBe(true)
  })
})

describe('malformed → fail-loud', () => {
  it('name ≠ default → 拒绝', () => {
    const yaml = 'name: custom\nsteps:\n  - id: explore\n    label: 调研\n'
    expect(() => run(yaml)).toThrow(/name 必须是 'default'/)
  })

  it('同一分支重复 step id → 拒绝', () => {
    const body = '  - id: explore\n    label: 调研\n  - id: explore\n    label: 调研\n'
    expect(() => run(wrap(body))).toThrow(/step id 'explore' 重复/)
  })

  it('分支之间可以有同名 step id（各分支是各自完整的 pipeline）', () => {
    const yaml = [
      'name: default', 'tracks:',
      '  a:', '    label: A', '    steps:', '      - id: open', '        label: 立项',
      '  b:', '    label: B', '    steps:', '      - id: open', '        label: 立项', '',
    ].join('\n')
    expect(() => run(yaml)).not.toThrow()
  })

  it('缺 steps / tracks → 拒绝', () => {
    expect(() => parseDefaultWorkflow('name: default\n')).toThrow(/缺顶层/)
  })

  it('用于步骤元数据的那条分支缺非空 label → 拒绝', () => {
    const yaml = ['name: default', 'tracks:', '  a:', '    label: A', '    steps:', '      - id: open', ''].join('\n')
    expect(() => generate(yaml, '')).toThrow(/缺非空 label/)
  })
})
